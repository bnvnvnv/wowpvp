/**
 * 战斗实体。
 *
 * M2 只实现目标系统与施法打断需要的字段。光环、控制递减、驱散是 M4 ——
 * 那时 `StatusFlags` 会由光环系统聚合产生，而不是像现在这样直接赋值。
 * 现在把它单列成一个结构，就是为了 M4 换实现时不用改 casting/targeting 的调用点。
 */

import { GEOMETRY } from '../constants/combat.js';
import type { Vec3 } from '../math/vec3.js';
import type { ClassDef } from '../data/schema.js';
import { Resource, School } from '../types/enums.js';
import type { ArmorId, ClassId, EntityId, SkillId, TeamId, WeaponId } from '../types/ids.js';

/**
 * 状态标志。
 *
 * ★ M4 起由 `aura.deriveStatusFlags()` 从光环聚合产生，每 tick 写回。
 *   当初把它单列成一个结构而不是散落在 CombatEntity 上，就是为了这一刻 ——
 *   换实现时 casting / targeting / movement 的调用点一行都不用改。
 *
 * 每一项都对应规格书 7.3 中断来源表或 8.x 的一条规则。
 */
export interface StatusFlags {
  /** 无法行动。7.3：停止法术、引导、射击准备和换装。昏迷/恐惧/变形都置位 */
  stunned: boolean;
  /** 恐惧：无法主动控制移动方向，被系统驱赶 */
  feared: boolean;
  /** 定身：无法移动，但可以施法和攻击 */
  rooted: boolean;
  /** 8.2：禁止魔法技能。**不阻止**物理射击、普通攻击和纯武器技能（验收 #17）*/
  silenced: boolean;
  /** 8.2：禁止武器攻击、瞄准射击和武器技能。**不阻止**纯魔法施法（验收 #17）*/
  disarmed: boolean;
  /** 5.3 / 验收 #5：潜行且未被发现时不能被点击、Tab、姓名板或小地图选中 */
  stealthed: boolean;
  /** 潜行是否已被敌方发现 */
  stealthRevealed: boolean;
  /** 旋风：无法被选中、攻击或治疗 */
  untargetable: boolean;

  // ── 8.4 免疫。完全无敌/物理免疫/法术免疫必须有明显视觉区别 ──
  /** 完全免疫（圣盾术、寒冰屏障）。夺旗中会先掉旗 */
  immuneAll: boolean;
  /** 物理免疫（保护祝福）*/
  immunePhysical: boolean;
  immuneMagic: boolean;
  /** 免疫新的减速与定身（自由祝福）*/
  immuneMovementImpair: boolean;
  /** 免疫新的魔法控制（反魔法护罩）*/
  immuneMagicControl: boolean;
  /** 不能攻击或射击（灵龟守护）*/
  cannotAttack: boolean;
  /** 免疫减速和定身效果本身（剑刃风暴）*/
  immuneSlowAndRoot: boolean;
  /** 偏转正面投射物 */
  deflectFrontProjectiles: boolean;
  /** 12.6 复活保护：主动攻击/治疗/使用技能会提前结束 */
  spawnProtection: boolean;

  /** 12.x 是否携带旗帜。★ 由夺旗系统维护，不来自光环 */
  carryingFlag: boolean;
}

export const createStatusFlags = (): StatusFlags => ({
  stunned: false,
  feared: false,
  rooted: false,
  silenced: false,
  disarmed: false,
  stealthed: false,
  stealthRevealed: false,
  untargetable: false,
  immuneAll: false,
  immunePhysical: false,
  immuneMagic: false,
  immuneMovementImpair: false,
  immuneMagicControl: false,
  cannotAttack: false,
  immuneSlowAndRoot: false,
  deflectFrontProjectiles: false,
  spawnProtection: false,
  carryingFlag: false,
});

/** 5.1 目标层级。软提示目标与「目标的目标」是派生的，不存状态 */
export interface TargetSlots {
  /** 硬目标：持续保留，直到切换、目标离场或玩家主动清除 */
  hard?: EntityId;
  /** 焦点目标：独立于硬目标 */
  focus?: EntityId;
  /** 鼠标指向：仅当前帧有效 */
  mouseover?: EntityId;
}

export interface CombatEntity {
  id: EntityId;
  name: string;
  team: TeamId;
  classId: ClassId;

  position: Vec3;
  /** 角色朝向。★ 不是镜头朝向（6.5）*/
  yaw: number;
  radius: number;
  height: number;

  health: number;
  maxHealth: number;
  alive: boolean;
  /** 资源池当前值 */
  resources: Map<Resource, number>;
  maxResources: Map<Resource, number>;

  weaponId: WeaponId;
  armorId: ArmorId;
  /**
   * 下一次普通攻击的时刻（绝对秒）。7.6：普通攻击按武器攻击间隔自动进行。
   *
   * ★ 10.7 / 验收 #34：**换装不能刷新它**。写成实体上的绝对时刻而不是
   *   「距离下次攻击还剩多久」，就是为了让「换装顺手重置计时」这种事
   *   必须显式赋值才能发生 —— 而那一行会很显眼。
   */
  nextSwingAt: number;
  /**
   * 攻击后摇结束的时刻。10.7：换装**不能取消攻击后摇**。
   * 后摇期间发起换装是允许的，但换装不会让后摇提前结束。
   */
  swingRecoveryUntil: number;
  targets: TargetSlots;
  flags: StatusFlags;

  /** 技能冷却结束的绝对时间（秒）*/
  cooldowns: Map<SkillId, number>;
  /** 公共冷却结束的绝对时间 */
  gcdUntil: number;
  /** 7.2 学派锁定：该学派解锁的绝对时间 */
  schoolLocks: Map<School, number>;

  /** 是否是宠物/召唤物。5.3：Tab 默认不选中；2.1：不计入存活人数 */
  isPet: boolean;
}

export const createEntity = (
  id: EntityId,
  cls: ClassDef,
  team: TeamId,
  position: Vec3,
  opts: { name?: string; yaw?: number; isPet?: boolean } = {},
): CombatEntity => {
  const resources = new Map<Resource, number>();
  const maxResources = new Map<Resource, number>();
  for (const r of cls.resources) {
    resources.set(r.resource, r.start);
    maxResources.set(r.resource, r.max);
  }
  return {
    id,
    name: opts.name ?? cls.name,
    team,
    classId: cls.id,
    position: { ...position },
    yaw: opts.yaw ?? 0,
    // 13.2 / 验收 #10：所有人形职业共用同一套碰撞体，视觉大小不参与判定
    radius: GEOMETRY.HITBOX_RADIUS,
    height: GEOMETRY.HITBOX_HEIGHT,
    health: cls.baseHealth,
    maxHealth: cls.baseHealth,
    alive: true,
    resources,
    maxResources,
    weaponId: cls.defaultWeaponId,
    armorId: cls.defaultArmorId,
    nextSwingAt: 0,
    swingRecoveryUntil: 0,
    targets: {},
    flags: createStatusFlags(),
    cooldowns: new Map(),
    gcdUntil: 0,
    schoolLocks: new Map(),
    isPet: opts.isPet ?? false,
  };
};

// ── 查询辅助 ─────────────────────────────────────────────────────

export const isHostile = (a: CombatEntity, b: CombatEntity): boolean => a.team !== b.team;
export const isFriendly = (a: CombatEntity, b: CombatEntity): boolean => a.team === b.team;

/**
 * 5.3 / 验收 #5：能否被 `viewer` 选中。
 *
 * ⚠️ 服务器还必须在快照层把不可见的潜行者**整个裁掉**
 * （docs/08 §4.1）—— 只在这里过滤是不够的，改客户端就能绕过。
 * 这个函数负责的是「同一份可见集合内的合法性」。
 */
export const isSelectableBy = (target: CombatEntity, viewer: CombatEntity): boolean => {
  if (!target.alive) return false;
  if (target.flags.untargetable) return false;
  if (target.flags.stealthed && !target.flags.stealthRevealed && isHostile(viewer, target)) {
    return false;
  }
  return true;
};

export const getResource = (e: CombatEntity, r: Resource): number => e.resources.get(r) ?? 0;

export const spendResource = (e: CombatEntity, r: Resource, amount: number): void => {
  e.resources.set(r, Math.max(0, getResource(e, r) - amount));
};

export const gainResource = (e: CombatEntity, r: Resource, amount: number): void => {
  const max = e.maxResources.get(r) ?? Infinity;
  e.resources.set(r, Math.min(max, getResource(e, r) + amount));
};

/** 7.2：该学派当前是否被锁定 */
export const isSchoolLocked = (e: CombatEntity, school: School, now: number): boolean =>
  (e.schoolLocks.get(school) ?? 0) > now;

export const isOnCooldown = (e: CombatEntity, skillId: SkillId, now: number): boolean =>
  (e.cooldowns.get(skillId) ?? 0) > now;

export const isOnGcd = (e: CombatEntity, now: number): boolean => e.gcdUntil > now;

/** 供 geometry 使用的 HitCircle 视图 */
export const hitCircleOf = (e: CombatEntity) => ({
  position: e.position,
  radius: e.radius,
  height: e.height,
});
