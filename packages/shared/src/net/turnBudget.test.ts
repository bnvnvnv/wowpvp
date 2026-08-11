/**
 * A5：转身令牌桶的**纯函数**这一层。
 *
 * ★★ 服务器的接线（每 tick 注入一次、人机豁免、facing 与移动 yaw 共用账本）
 *   钉在 `server/MatchLoop.turnRate.test.ts`；这里只钉桶本身的三条性质：
 *     · **逐位透明**：预算内原样返回，一个浮点尾数都不动（联网轨迹不变）；
 *     · **两条线分开**：桶容量管瞬时、注入率管持续；
 *     · **客户端先钳、服务器不会再钳**（`Predictor` 的立身前提，见本文件末尾）。
 */

import { describe, expect, it } from 'vitest';
import { DEG, wrapAngle } from '../math/index.js';
import { SIM, TURN_RATE } from '../constants/combat.js';
import {
  MAX_YAW_STEP_PER_TICK,
  TURN_BURST_RAD,
  TURN_BURST_SERVER_RAD,
  admitYaw,
  clampYaw,
  createTurnBudget,
  refillTurnBudget,
} from './turnBudget.js';

describe('A5 转身令牌桶', () => {
  it('第一条朝向原样采信（没有可比的基准）', () => {
    const b = createTurnBudget();
    expect(admitYaw(b, -2.9)).toBe(-2.9);
    // ★ 立基准不该扣费：他此刻朝哪跟 50ms 前无关
    expect(b.tokens).toBe(TURN_BURST_RAD);
  });

  it('★★ 预算内逐位透明（原样返回 wanted，不是重算 prev + delta）', () => {
    const b = createTurnBudget();
    admitYaw(b, 0);
    // 0.3 rad 用 prev + delta 重算会引入尾数差；这里要求 toBe 而不是 toBeCloseTo
    expect(admitYaw(b, 0.3)).toBe(0.3);
    expect(admitYaw(b, 0.30000000000000004)).toBe(0.30000000000000004);
  });

  it('★★ 桶满时一次 180° 原样过（真人转身看背后）', () => {
    const b = createTurnBudget();
    admitYaw(b, 0);
    expect(admitYaw(b, Math.PI)).toBe(Math.PI);
    expect(b.tokens).toBeCloseTo(TURN_BURST_RAD - Math.PI, 12);
  });

  it('★★ 桶空之后每 tick 只走一份注入量（挡的是持续机械旋转）', () => {
    const b = createTurnBudget();
    admitYaw(b, 0);
    // 一口气花光：180° 的桶正好被 180° 的转身掏空
    admitYaw(b, Math.PI);
    expect(b.tokens).toBeCloseTo(0, 12);

    for (let i = 0; i < 5; i++) {
      const before = b.yaw!;
      refillTurnBudget(b);
      admitYaw(b, wrapAngle(before + Math.PI));
      expect(
        Math.abs(wrapAngle(b.yaw! - before)),
        '持续满速旋转时单 tick 转过了一份以上',
      ).toBeCloseTo(MAX_YAW_STEP_PER_TICK, 12);
    }
  });

  it('注入封顶在桶容量（停发多久都攒不出更多）', () => {
    const b = createTurnBudget();
    admitYaw(b, 0);
    admitYaw(b, Math.PI); // 掏空
    for (let i = 0; i < 100; i++) refillTurnBudget(b);
    expect(b.tokens).toBe(TURN_BURST_RAD);
  });

  it('跨 ±π 边界按最短弧算（172° → -172° 只是 16°，不是 344°）', () => {
    const b = createTurnBudget();
    admitYaw(b, 3.0);
    const before = b.tokens;
    expect(admitYaw(b, -3.0)).toBe(-3.0);
    expect(before - b.tokens, '跨边界被当成绕远路扣费').toBeCloseTo(
      Math.abs(wrapAngle(-3.0 - 3.0)), 12,
    );
  });

  it('clampYaw 只算不扣（CastRequest.facing 那条路靠它连发 20 条也不累加）', () => {
    const b = createTurnBudget();
    admitYaw(b, 0);
    b.tokens = MAX_YAW_STEP_PER_TICK;
    for (let i = 0; i < 20; i++) {
      expect(clampYaw(b.yaw, b.tokens, Math.PI)).toBeCloseTo(MAX_YAW_STEP_PER_TICK, 12);
    }
    expect(b.tokens, 'clampYaw 动了桶').toBe(MAX_YAW_STEP_PER_TICK);
  });

  it('注入率就是 TURN_RATE.MAX_DEG_PER_SEC（改 tick 率时自动跟着走）', () => {
    expect(MAX_YAW_STEP_PER_TICK / SIM.TICK_DT / DEG).toBeCloseTo(TURN_RATE.MAX_DEG_PER_SEC, 9);
  });

  /**
   * ★★ **`Predictor` 的立身前提：客户端钳过之后服务器不会再钳一次。**
   *
   *   服务器一旦对同一条输入给出与客户端不同的 yaw，`stepMovement` 的移动方向
   *   当场分叉 —— 实测 1440°/s 转 0.5 秒差 0.164 m，正落在 `CORRECTION` 的
   *   平滑档，于是快速转身的每一个 tick 都在被往回拽（橡皮筋）。
   *   服务器桶比客户端多 `SLACK_TICKS` 的余量就是为这条性质留的。
   */
  it('★★ 客户端自钳过的 yaw，服务器一律原样采信（哪怕两边的钟差几个 tick）', () => {
    for (const skew of [0, 1, 2, 5]) {
      const client = createTurnBudget(TURN_BURST_RAD);
      const server = createTurnBudget(TURN_BURST_SERVER_RAD);
      // 客户端的钟先跑 skew 个步（低帧一帧补几步 = 服务器还没走到那几个 tick）
      let want = 0;
      for (let i = 0; i < 200; i++) {
        // 3600°/s：远超注入率，逼着两个桶都见底 —— 这才是分叉最容易露头的地方
        want = wrapAngle(want + 3600 * DEG * SIM.TICK_DT);
        refillTurnBudget(client);
        const sent = admitYaw(client, want);
        if (i >= skew) {
          refillTurnBudget(server);
          expect(
            admitYaw(server, sent),
            `钟差 ${skew} 个 tick 时服务器又钳了一次 —— 位置会分叉、全程橡皮筋`,
          ).toBe(sent);
        }
      }
    }
  });
});
