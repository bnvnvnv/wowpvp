/**
 * 渲染顿帧（docs/10 偏差 #8）。
 * GameLoop.test.ts 验「不碰模拟步」那半边；这里验 HitStop 自身的时间学。
 */

import { describe, expect, it } from 'vitest';
import { HIT_STOP, HitStop } from './HitStop.js';

describe('顿帧时间学', () => {
  it('★ 空闲时 scale 恒为 1', () => {
    const h = new HitStop();
    expect(h.scale(0.016)).toBe(1);
    expect(h.scale(0.016)).toBe(1);
  });

  it('★ 触发后进入 SCALE，冻结期结束 + RECOVER 后回到 1', () => {
    const h = new HitStop();
    h.trigger(HIT_STOP.DURATION.crit);
    expect(h.scale(0.001)).toBe(HIT_STOP.SCALE);
    // 消耗完冻结期
    let guard = 0;
    while (h.frozen && guard++ < 100) h.scale(0.016);
    // 回升段：介于 SCALE 与 1 之间
    const recovering = h.scale(0.016);
    expect(recovering).toBeGreaterThan(HIT_STOP.SCALE);
    // 回升结束
    for (let i = 0; i < 10; i++) h.scale(0.016);
    expect(h.scale(0.016)).toBe(1);
  });

  it('★ trigger 取 max 不累加 —— 团战里连打不会把画面冻死', () => {
    const h = new HitStop();
    h.trigger(0.05);
    h.trigger(0.05); // MIN_GAP 内被忽略，也绝不叠加成 0.1
    let frames = 0;
    while (h.scale(0.01) !== 1 && frames++ < 100) { /* 消耗 */ }
    // 0.05 冻结 + 0.06 回升 ≈ 0.11s = 约 11 帧（若叠加成 0.1 冻结会 >16 帧）
    expect(frames).toBeLessThan(14);
  });

  it('★ MIN_GAP 内的第二次触发被忽略（AOE 打 5 个人只顿一次）', () => {
    const h = new HitStop();
    h.trigger(0.03);
    // 消耗完这次顿帧（0.03 + RECOVER < 0.1 < MIN_GAP）
    for (let i = 0; i < 10; i++) h.scale(0.01);
    expect(h.scale(0.01)).toBe(1);
    h.trigger(0.09); // 距上次触发 0.11s < MIN_GAP 0.15 → 忽略
    expect(h.scale(0.001)).toBe(1);
  });

  it('★ MIN_GAP 之后可以再次触发', () => {
    const h = new HitStop();
    h.trigger(0.03);
    for (let i = 0; i < 30; i++) h.scale(0.01); // 0.3s > MIN_GAP
    h.trigger(0.05);
    expect(h.scale(0.001)).toBe(HIT_STOP.SCALE);
  });

  it('★ enabled=false 时恒返回 1 且清空状态', () => {
    const h = new HitStop();
    h.trigger(0.09);
    h.enabled = false;
    expect(h.scale(0.001)).toBe(1);
    h.enabled = true;
    // 关掉时已清空 —— 重新打开不会把旧的冻结「续上」
    expect(h.scale(0.001)).toBe(1);
  });
});
