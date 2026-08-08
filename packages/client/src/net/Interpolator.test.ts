/**
 * 远端玩家插值。docs/08 §5 末段 / 规格书 13.4。
 *
 * ★★ 这个文件的核心是**一条否定式规则**：
 *   「传送、位置纠正和大位移**不能**被识别为高速跑步。」
 *   破坏它不会报错 —— 只会让远端角色滑行并播出冲刺动画。
 *   所以「瞬移不插值」的每一条路径都单独钉一次。
 */

import { describe, expect, it } from 'vitest';
import {
  SIM, asClassId, asTeamId, distance, vec3,
  type EntityId, type HydratedEntitySnapshot as EntitySnapshot, type Vec3,
} from '@wowpvp/shared';

import { Interpolator, lerpAngle } from './Interpolator.js';

const ent = (
  id: number,
  position: Vec3,
  over: Partial<EntitySnapshot> = {},
): EntitySnapshot => ({
  id: id as EntityId,
  name: `e${id}`,
  team: asTeamId(0),
  classId: asClassId('mage'),
  position,
  yaw: 0,
  teleported: false,
  health: 100,
  maxHealth: 100,
  alive: true,
  resources: {},
  maxResources: {},
  auras: [],
  carryingFlag: false,
  flags: {
    stunned: false, feared: false, rooted: false, silenced: false, disarmed: false,
    carryingFlag: false, immuneAll: false, immunePhysical: false, immuneMagic: false,
  },
  equipment: { currentWeaponId: undefined, armorArchetype: undefined, swapping: false },
  ...over,
});

/** 两帧间隔一个 tick */
const DT = SIM.TICK_DT;

describe('插值', () => {
  it('★ 在两帧之间按时间插值（渲染的是 now - INTERP_DELAY 时刻）', () => {
    const i = new Interpolator();
    i.push(1.0, [ent(1, vec3(0, 0, 0))]);
    i.push(1.0 + DT, [ent(1, vec3(1, 0, 0))]);

    // 目标时刻取两帧正中间
    const mid = 1.0 + DT / 2;
    const out = i.sample(mid + SIM.INTERP_DELAY);

    expect(out).toHaveLength(1);
    expect(out[0]!.position.x).toBeCloseTo(0.5, 6);
    expect(out[0]!.teleported).toBe(false);
  });

  it('★ 排除自己 —— 自己走预测，不走插值', () => {
    const i = new Interpolator();
    i.push(1.0, [ent(1, vec3(0, 0, 0)), ent(2, vec3(5, 0, 0))]);
    i.push(1.0 + DT, [ent(1, vec3(1, 0, 0)), ent(2, vec3(6, 0, 0))]);

    const out = i.sample(1.0 + DT / 2 + SIM.INTERP_DELAY, 1 as EntityId);
    expect(out.map((e) => e.snapshot.id)).toEqual([2]);
  });

  /** ★ 乱序到达的旧快照会让插值来回跳，直接丢 */
  it('★ 丢弃乱序到达的旧快照', () => {
    const i = new Interpolator();
    i.push(1.0, [ent(1, vec3(0, 0, 0))]);
    i.push(1.0 + DT, [ent(1, vec3(1, 0, 0))]);
    i.push(1.0, [ent(1, vec3(99, 0, 0))]); // 迟到的旧帧

    const out = i.sample(1.0 + DT / 2 + SIM.INTERP_DELAY);
    expect(out[0]!.position.x).toBeCloseTo(0.5, 6);
  });
});

describe('★★ 13.4：瞬移不插值', () => {
  it('★★ 服务器标记 teleported → 直接跳到新位置', () => {
    const i = new Interpolator();
    i.push(1.0, [ent(1, vec3(0, 0, 0))]);
    // 闪现 20 米，服务器标记了
    i.push(1.0 + DT, [ent(1, vec3(0, 0, -20), { teleported: true })]);

    const out = i.sample(1.0 + DT / 2 + SIM.INTERP_DELAY);
    expect(
      distance(out[0]!.position, vec3(0, 0, -20)),
      '瞬移被插值了 —— 角色会滑行并被判成冲刺（13.4）',
    ).toBeLessThan(1e-9);
    expect(out[0]!.teleported, '必须把 teleported 传给表现层').toBe(true);
  });

  it('★★ 位移超阈值但服务器没标记 → 仍然瞬移（丢包后一次性对账）', () => {
    const i = new Interpolator();
    i.push(1.0, [ent(1, vec3(0, 0, 0))]);
    i.push(1.0 + DT, [ent(1, vec3(0, 0, -30))]); // teleported 是 false

    const out = i.sample(1.0 + DT / 2 + SIM.INTERP_DELAY);
    expect(distance(out[0]!.position, vec3(0, 0, -30))).toBeLessThan(1e-9);
    expect(out[0]!.teleported).toBe(true);
  });

  it('★ 上一帧不存在（刚进视野 / 刚从潜行现身）→ 直接放置，不从原点插过来', () => {
    const i = new Interpolator();
    i.push(1.0, []);
    i.push(1.0 + DT, [ent(7, vec3(12, 0, -8))]);

    const out = i.sample(1.0 + DT / 2 + SIM.INTERP_DELAY);
    expect(
      distance(out[0]!.position, vec3(12, 0, -8)),
      '从 (0,0,0) 插过来会让他「跑」出一条长线',
    ).toBeLessThan(1e-9);
    expect(out[0]!.teleported).toBe(true);
  });

  /**
   * ★ 正常跑步**不能**被误判成瞬移 —— 否则远端角色会一格一格跳，
   *   插值就白做了。这条和上面三条是一对：既要抓住瞬移，又不能错杀跑步。
   */
  it('★ 一个 tick 内的正常跑步位移不触发瞬移', () => {
    const i = new Interpolator();
    // BASE_SPEED=7 m/s，一个 tick 走 0.35 米
    i.push(1.0, [ent(1, vec3(0, 0, 0))]);
    i.push(1.0 + DT, [ent(1, vec3(0, 0, -0.35))]);

    const out = i.sample(1.0 + DT / 2 + SIM.INTERP_DELAY);
    expect(out[0]!.teleported, '正常跑步被当成瞬移了，插值会失效').toBe(false);
  });
});

describe('缓冲不足时', () => {
  /**
   * ★ 不外推。外推要猜别人的输入，猜错会让角色冲出去再被拉回来 ——
   *   而那个「拉回来」正是 13.4 要防的大位移。宁可短暂静止。
   */
  it('★ 只有一帧时显示该帧，不外推', () => {
    const i = new Interpolator();
    i.push(1.0, [ent(1, vec3(3, 0, 0))]);

    const out = i.sample(5.0); // 远远超过缓冲
    expect(out[0]!.position.x).toBe(3);
  });

  it('★ reset 后清空（重连要丢弃全部本地状态）', () => {
    const i = new Interpolator();
    i.push(1.0, [ent(1, vec3(3, 0, 0))]);
    i.reset();
    expect(i.sample(1.0 + SIM.INTERP_DELAY)).toEqual([]);
  });
});

describe('lerpAngle', () => {
  /** ★ 跨 ±π 必须走最短弧，否则角色会原地转一整圈 */
  it('★ 跨 ±π 边界走最短弧', () => {
    const a = Math.PI - 0.1;
    const b = -Math.PI + 0.1;
    const mid = lerpAngle(a, b, 0.5);
    // 最短弧是 0.2 弧度，中点应当落在 ±π 附近，而不是 0 附近
    expect(Math.abs(Math.abs(mid) - Math.PI)).toBeLessThan(0.05);
  });

  it('普通区间正常插值', () => {
    expect(lerpAngle(0, 1, 0.5)).toBeCloseTo(0.5, 9);
  });
});
