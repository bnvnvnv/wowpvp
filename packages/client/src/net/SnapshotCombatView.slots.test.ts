/**
 * 联网侧技能栏的可用性判定（`SnapshotCombatView.skillSlots`）。
 *
 * ★★ 这个文件存在的理由是一次真机审计：联网对局里**超出距离的技能格是亮的**。
 *   HUD 与判定都没坏 —— 判定只是从来没算过距离（快照里明明有目标位置，
 *   同一个类里 `distanceTo` 就在上面几行）。于是玩家看着一个可用的图标按下去，
 *   换来一条服务器的 `CastFailed`。
 *
 * ★ 所以这里测的不是「转换对不对」，而是**每一条能判的门禁真的判了**，
 *   以及**判不了的那三条（视线/学派锁定/武器方案）继续保守放行** ——
 *   后者一旦哪天被「顺手也判一下」，技能栏就会开始误报不可用。
 */

import { describe, expect, it } from 'vitest';
import {
  CastFailure,
  GCD,
  Resource,
  TEAM_BLUE,
  TEAM_RED,
  asClassId,
  asEntityId,
  type EntityId,
  type HydratedEntitySnapshot as EntitySnapshot,
  type HydratedSnapshot as Snapshot,
} from '@wowpvp/shared';

import { SnapshotCombatView } from './SnapshotCombatView.js';

const ME = asEntityId(1);
const FOE = asEntityId(2);
const MATE = asEntityId(3);

/** 一个最小实体快照。资源给满 —— 除非某条测试就是要测资源 */
const entity = (
  id: EntityId,
  classId: string,
  team: typeof TEAM_RED,
  z: number,
  over: Partial<EntitySnapshot> = {},
): EntitySnapshot => ({
  id,
  name: `e${id as number}`,
  team,
  classId: asClassId(classId),
  position: { x: 0, y: 0, z },
  yaw: 0,
  teleported: false,
  health: 100,
  maxHealth: 100,
  alive: true,
  resources: { [Resource.Mana]: 999, [Resource.Rage]: 999 },
  maxResources: { [Resource.Mana]: 999, [Resource.Rage]: 999 },
  auras: [],
  carryingFlag: false,
  flags: {
    stunned: false, feared: false, rooted: false, silenced: false, disarmed: false,
    carryingFlag: false, immuneAll: false, immunePhysical: false, immuneMagic: false,
  },
  equipment: { currentWeaponId: undefined, armorArchetype: undefined, swapping: false },
  ...over,
});

const snapshot = (entities: EntitySnapshot[]): Snapshot => ({
  tick: 1, you: ME, entities,
  projectiles: [], grounds: [], drops: [], armories: [],
  match: { dampening: 0, suddenDeath: false },
});

/**
 * 建一个已吃过一份快照的视图。
 * @param foeZ 敌人放在 +Z 多远处（自己在原点）
 */
const viewWith = (opts: {
  foeZ?: number;
  myClass?: string;
  target?: EntityId;
  self?: Partial<EntitySnapshot>;
  yaw?: number;
} = {}): SnapshotCombatView => {
  const v = new SnapshotCombatView();
  const me = entity(ME, opts.myClass ?? 'mage', TEAM_RED, 0, opts.self ?? {});
  const foe = entity(FOE, 'warrior', TEAM_BLUE, opts.foeZ ?? 5);
  const mate = entity(MATE, 'priest', TEAM_RED, 2);
  v.ingest(snapshot([me, foe, mate]), 100);
  if (opts.target !== undefined) v.targetId = opts.target;
  // 6.5：默认面向 +Z 那一侧的敌人（yaw = π 面向 +Z，见 vec3.yawToDir 的约定）
  v.selfYaw = () => opts.yaw ?? Math.PI;
  return v;
};

const slotOf = (v: SnapshotCombatView, skillId: string) => {
  const s = v.skillSlots().find((x) => (x.skill.id as string) === skillId);
  if (!s) throw new Error(`技能栏里没有 ${skillId}`);
  return s;
};

describe('★★ 距离判定（本轮修复的核心）', () => {
  it('射程内的直接目标技能是可用的 —— 不因为新增判定而误报', () => {
    // 霜矢射程 32 米，敌人在 5 米外
    const v = viewWith({ target: FOE });
    expect(slotOf(v, 'mage.frostbolt').blocker).toBe(CastFailure.Ok);
  });

  it('★★ 超出 range.max → OutOfRange（此前这里恒为 Ok，图标亮着按不出去）', () => {
    const v = viewWith({ foeZ: 40, target: FOE });
    const slot = slotOf(v, 'mage.frostbolt');
    expect(slot.blocker).toBe(CastFailure.OutOfRange);
    expect(slot.blockers).toContain(CastFailure.OutOfRange);
  });

  it('★ 近战按**边缘**判距（6.1）—— 走 shared 的 inRange，不在客户端另写一把尺子', () => {
    // 致死打击 3.3 米：碰撞体半径各 0.45，中心距 4 米时边缘距 3.1 米 → 够得着
    expect(slotOf(viewWith({ myClass: 'warrior', foeZ: 4, target: FOE }), 'warrior.mortal_strike')
      .blocker).toBe(CastFailure.Ok);
    // 中心距 4.5 米 → 边缘 3.6 米 → 够不着
    expect(slotOf(viewWith({ myClass: 'warrior', foeZ: 4.5, target: FOE }), 'warrior.mortal_strike')
      .blocker).toBe(CastFailure.OutOfRange);
  });

  it('没有硬目标时直接目标技能报「需要目标」，无目标类技能不受影响', () => {
    const v = viewWith({});
    expect(slotOf(v, 'mage.frostbolt').blocker).toBe(CastFailure.NoTarget);
    // 自身中心（冰霜新星）与自身（寒冰护体）：5.6 明确说它们不需要选目标
    expect(slotOf(v, 'mage.frost_nova').blocker).toBe(CastFailure.Ok);
    expect(slotOf(v, 'mage.ice_barrier').blocker).toBe(CastFailure.Ok);
    // 地面技能的落点要等瞄准时才产生，技能栏上不判（否则长期显示「需要目标」）
    expect(slotOf(v, 'mage.blizzard').blocker).toBe(CastFailure.Ok);
  });

  it('目标阵营不符 → InvalidTarget（对队友按火球不该是「可用」）', () => {
    const v = viewWith({ target: MATE });
    expect(slotOf(v, 'mage.frostbolt').blocker).toBe(CastFailure.InvalidTarget);
  });

  it('★ 6.5 朝向用**注入的本地预测 yaw** —— 背对目标时提示朝向不对', () => {
    // yaw = 0 面向 -Z，而敌人在 +Z：正好背对
    const away = viewWith({ myClass: 'warrior', foeZ: 3, target: FOE, yaw: 0 });
    expect(slotOf(away, 'warrior.mortal_strike').blocker).toBe(CastFailure.WrongFacing);
    // 转过身来就没有这一条了（该技能 6 秒冷却，快照里没记冷却 = 不在冷却）
    const facing = viewWith({ myClass: 'warrior', foeZ: 3, target: FOE, yaw: Math.PI });
    expect(slotOf(facing, 'warrior.mortal_strike').blocker).toBe(CastFailure.Ok);
  });
});

describe('★ 门禁顺序与全量阻碍项（合同 C1 的 blockers）', () => {
  it('★ blocker 单值按 7.4 门禁顺序 —— 与试验场的 validateForHud 逐条同序', () => {
    // 冷却中 + 超距同时成立：7.4 把冷却排在距离之前，两个场景给同一句话
    const v = viewWith({
      foeZ: 40, target: FOE,
      self: { cooldowns: { 'mage.frostbolt': 105 } },
    });
    expect(slotOf(v, 'mage.frostbolt').blocker).toBe(CastFailure.OnCooldown);
  });

  it('★ blockers 全量按显示顺序 —— 位置排在冷却之前（「我最该先解决什么」）', () => {
    const v = viewWith({
      foeZ: 40, target: FOE,
      self: { cooldowns: { 'mage.frostbolt': 105 } },
    });
    const blockers = slotOf(v, 'mage.frostbolt').blockers ?? [];
    expect(blockers).toEqual([CastFailure.OutOfRange, CastFailure.OnCooldown]);
  });

  it('可释放时 blockers 字段整个不出现（空数组等于说了句废话）', () => {
    const slot = slotOf(viewWith({ target: FOE }), 'mage.frostbolt');
    expect('blockers' in slot).toBe(false);
  });

  it('资源不足照旧判（回归：本轮没有把老判据判丢）', () => {
    const v = viewWith({
      target: FOE,
      self: { resources: { [Resource.Mana]: 0 }, maxResources: { [Resource.Mana]: 999 } },
    });
    expect(slotOf(v, 'mage.frostbolt').blocker).toBe(CastFailure.NotEnoughResource);
  });

  it('★ 判不了的三条继续保守放行：视线被墙挡住也照样显示可用', () => {
    // 客户端手里没有 world.obstacles 的战斗口径，也没有 schoolLocks / availableSkills。
    // 这条测试固定的是**态度**：宁可多一次被服务器拒绝，也不误报不可用。
    const slot = slotOf(viewWith({ target: FOE }), 'mage.frostbolt');
    expect(slot.blockers).toBeUndefined();
    expect(slot.blocker).toBe(CastFailure.Ok);
  });
});

describe('★ GCD（合同 C1 的 gcdRemaining/gcdTotal）', () => {
  it('快照带 gcdUntil 时填 gcdRemaining，并按 7.4 顺序报公共冷却', () => {
    const v = viewWith({ target: FOE, self: { gcdUntil: 100.6 } });
    const slot = slotOf(v, 'mage.frostbolt');
    expect(slot.gcdRemaining).toBeCloseTo(0.6, 6);
    expect(slot.gcdTotal).toBe(Math.max(GCD.MIN, GCD.BASE));
    expect(slot.blocker).toBe(CastFailure.OnGlobalCooldown);
  });

  it('★ 脱离 GCD 的技能不填这两个字段 —— 否则 HUD 会画一圈它其实不受的限制', () => {
    // 法术反制（mage.counterspell）triggersGcd: false
    const v = viewWith({ target: FOE, self: { gcdUntil: 100.6 } });
    const slot = slotOf(v, 'mage.counterspell');
    expect(slot.gcdRemaining).toBeUndefined();
    expect(slot.blocker).not.toBe(CastFailure.OnGlobalCooldown);
  });

  it('没有 gcdUntil 字段 = 不在 GCD 中（老服务器/快照缺字段时不误报）', () => {
    const slot = slotOf(viewWith({ target: FOE }), 'mage.frostbolt');
    expect(slot.gcdRemaining).toBeUndefined();
    expect(slot.blocker).toBe(CastFailure.Ok);
  });
});

describe('★ 5.1 焦点回读', () => {
  it('focusId 指向的单位从快照里查得出来（HUD 的焦点框读它）', () => {
    const v = viewWith({});
    v.focusId = FOE;
    expect(v.focus?.id).toBe(FOE);
  });

  it('焦点不在快照里（离场/遁形）时 focus 为 undefined —— 不留一个幽灵框', () => {
    const v = viewWith({});
    v.focusId = asEntityId(99);
    expect(v.focus).toBeUndefined();
  });
});
