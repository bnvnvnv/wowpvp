/**
 * 施法生命周期。规格书 7.1 / 7.4 / 7.6，验收 #13 / #14 / #17 / #18 / #19 / #20。
 *
 * ★ 全文最重要的两条不变量：
 *
 *   1. **开始和完成调用同一个 `validate()`**（验收 #19）。
 *      两处各写一份检查，迟早会出现「开始能放、完成莫名失败」的分歧。
 *
 *   2. **失败或取消不消耗资源与技能冷却，但已经过的公共冷却不返还**（7.4 第 6 条）。
 *      这是假读条博弈的成本，不能退 —— 退了就没有骗打断的代价了。
 */

import { GCD } from '../constants/combat.js';
import { hasLineOfSight, inRange, isFacing } from '../math/geometry.js';
import type { Vec3 } from '../math/vec3.js';
import type { SkillDef } from '../data/schema.js';
import {
  CastFailure,
  CastKind,
  InterruptSource,
  School,
  TargetFilter,
  Targeting,
  isMagicSchool,
} from '../types/enums.js';
import type { EntityId, SkillId } from '../types/ids.js';
import {
  getResource,
  hitCircleOf,
  isOnCooldown,
  isOnGcd,
  isSchoolLocked,
  isSelectableBy,
  spendResource,
  type CombatEntity,
} from './entity.js';
import { getEntity, type World } from './world.js';

// ── 施法状态 ─────────────────────────────────────────────────────

export interface CastState {
  skillId: SkillId;
  kind: CastKind;
  /** 开始时间（绝对秒）*/
  startedAt: number;
  /** 读条/准备结束时间 */
  endsAt: number;
  /** 引导结束时间。仅 channel */
  channelEndsAt?: number;
  /** 下一跳时间。仅 channel */
  nextTickAt?: number;
  targetId?: EntityId;
  groundPoint?: Vec3;
  /** 释放时锁定的角色朝向，方向技能用 */
  facing: number;
  /** 开始时的位置，用于判断「主动移动」*/
  startPosition: Vec3;
  school: School;
  interruptible: boolean;
  /** 7.1：是否要求原地施放 */
  requiresStationary: boolean;
}

/** casting 模块给实体附加的状态。放在旁挂表里，避免污染 CombatEntity 的核心字段 */
export type CastingStore = Map<EntityId, CastState>;

export const createCastingStore = (): CastingStore => new Map();

export const getCast = (store: CastingStore, id: EntityId): CastState | undefined => store.get(id);
export const isCasting = (store: CastingStore, id: EntityId): boolean => store.has(id);

// ── 校验 ─────────────────────────────────────────────────────────

export interface CastContext {
  world: World;
  caster: CombatEntity;
  skill: SkillDef;
  target?: CombatEntity;
  groundPoint?: Vec3;
  /** 校验阶段：开始时不检查目标是否仍存活，完成时要检查 */
  phase: 'start' | 'complete';
}

/**
 * ★ 验收 #19：施法开始和完成时都会检查目标、距离、视线和朝向。
 *
 * 两个阶段的差异只有两处，都在下面显式标出：
 *   - 冷却/GCD/资源只在 start 检查（completion 时资源尚未扣除，重复检查会误判）
 *   - 目标存活只在 complete 检查（start 时目标必然活着，因为刚选中）
 */
export const validateCast = (ctx: CastContext): CastFailure => {
  const { caster, skill, target, phase, world } = ctx;
  const now = world.time;

  if (!caster.alive) return CastFailure.Dead;

  // 7.3 硬控制：停止并禁止一切主动动作。树皮术这类技能显式豁免
  if (caster.flags.stunned && !skill.usableWhileStunned) return CastFailure.Controlled;

  // ★ 验收 #17：沉默只挡魔法，缴械只挡武器 —— 两者不能互相越界
  if (caster.flags.silenced && isMagicSchool(skill.school)) return CastFailure.Silenced;
  if (caster.flags.disarmed && isWeaponSkill(skill)) return CastFailure.Disarmed;

  // 7.2 学派锁定
  if (isMagicSchool(skill.school) && isSchoolLocked(caster, skill.school, now)) {
    return CastFailure.SchoolLocked;
  }

  // 12.3 旗手限制
  if (skill.forbiddenWhileCarryingFlag && caster.flags.carryingFlag) {
    return CastFailure.CarryingFlag;
  }

  if (phase === 'start') {
    if (isOnCooldown(caster, skill.id, now)) return CastFailure.OnCooldown;
    if (skill.triggersGcd && isOnGcd(caster, now)) return CastFailure.OnGlobalCooldown;
    if (skill.cost && getResource(caster, skill.cost.resource) < skill.cost.amount) {
      return CastFailure.NotEnoughResource;
    }
  }

  // ⚠️ 检查顺序说明：7.4 步骤 1 把「资源」列在「距离/视线/朝向」之前，这里照办。
  // 后果是一个怒气为 0 的战士站在 30 米外，收到的提示是「资源不足」而不是「超出距离」。
  // 两者都为真，但后者更可操作。M8 做 HUD 时若要满足 15.2 的提示质量，
  // 建议另加一个 describeCastBlockers() 返回**全部**当前阻碍项供图标叠加显示，
  // 而不是改这里的门禁顺序 —— 门禁顺序改了会影响 CastFailure 的语义与统计归因。

  // ── 地面技能：落点合法性（6.4 / 验收 #8）──────────────────────
  if (skill.targeting === Targeting.Ground) {
    if (!ctx.groundPoint) return CastFailure.NoTarget;
    const d = Math.hypot(
      ctx.groundPoint.x - caster.position.x,
      ctx.groundPoint.z - caster.position.z,
    );
    if (d > skill.range.max) return CastFailure.OutOfRange;
    // 落点合法性交给 geometry.isGroundPositionLegal，客户端指示器调的是同一个函数
    return CastFailure.Ok;
  }

  // ── 无目标类技能 ─────────────────────────────────────────────
  if (
    skill.targeting === Targeting.Self ||
    skill.targeting === Targeting.SelfCenter ||
    skill.targeting === Targeting.Line ||
    skill.targeting === Targeting.Cone ||
    skill.targeting === Targeting.Projectile
  ) {
    return CastFailure.Ok;
  }

  // ── 直接目标技能 ─────────────────────────────────────────────
  if (!target) return CastFailure.NoTarget;

  // ★ 只在完成时检查存活：7.4 第 4 步「完成瞬间再次检查目标存活」
  if (phase === 'complete' && !target.alive) return CastFailure.InvalidTarget;
  if (!isSelectableBy(target, caster)) return CastFailure.InvalidTarget;

  const hostile = target.team !== caster.team;
  if (skill.targetFilter === TargetFilter.Enemy && !hostile) return CastFailure.InvalidTarget;
  if (skill.targetFilter === TargetFilter.Ally && hostile) return CastFailure.InvalidTarget;

  // 6.1/6.2 距离。近战走碰撞体边缘，远程走胸口到胸口 —— inRange 内部按 maxRange 区分
  if (!inRange(hitCircleOf(caster), hitCircleOf(target), skill.range.max, skill.range.min)) {
    // 15.2 要求 HUD 给出明确原因，所以要区分「太远」和「太近」。
    // 冲锋这类有最小距离的技能贴脸时是 TooClose，不是 OutOfRange。
    const withinMinRange =
      skill.range.min > 0 &&
      inRange(hitCircleOf(caster), hitCircleOf(target), skill.range.min, 0);
    return withinMinRange ? CastFailure.TooClose : CastFailure.OutOfRange;
  }

  if (skill.requiresLos && !hasLineOfSight(hitCircleOf(caster), hitCircleOf(target), world.obstacles)) {
    return CastFailure.NoLineOfSight;
  }

  // ★ 6.5：传的是角色 yaw。只旋转镜头不改变朝向，因此不能靠看向目标绕过
  if (skill.requiresFacing && !isFacing(caster.position, caster.yaw, target.position)) {
    return CastFailure.WrongFacing;
  }

  return CastFailure.Ok;
};

/**
 * 7.3：缴械禁止「武器攻击、瞄准射击和武器技能」。
 * 判据：物理学派的技能都算武器技能。纯魔法（神圣/火焰/寒冰/奥术/暗影/自然）不受影响。
 */
export const isWeaponSkill = (skill: SkillDef): boolean =>
  skill.school === School.Physical || skill.cast.kind === CastKind.AimedShot;

// ── 生命周期 ─────────────────────────────────────────────────────

export type CastResult =
  | { ok: true; state: CastState | null }
  | { ok: false; reason: CastFailure };

export interface CastEvents {
  onStarted?: (caster: CombatEntity, state: CastState) => void;
  onCompleted?: (caster: CombatEntity, skill: SkillDef, state: CastState) => void;
  onFailed?: (caster: CombatEntity, skill: SkillDef, reason: CastFailure) => void;
  onInterrupted?: (
    caster: CombatEntity,
    state: CastState,
    source: InterruptSource,
    schoolLock?: { school: School; until: number },
  ) => void;
}

/**
 * 7.4 步骤 1–2：按下技能 → 开始动作。
 *
 * 瞬发技能直接走完整个流程并返回 `state: null`；
 * 读条/引导/瞄准射击则进入 store，由 `tickCasting` 推进。
 */
export const beginCast = (
  world: World,
  store: CastingStore,
  caster: CombatEntity,
  skill: SkillDef,
  opts: { target?: CombatEntity; groundPoint?: Vec3; events?: CastEvents } = {},
): CastResult => {
  // 已在施法时按新技能：7.5 允许主动取消，但不允许叠加两个读条
  if (store.has(caster.id)) return { ok: false, reason: CastFailure.AlreadyCasting };

  const reason = validateCast({
    world,
    caster,
    skill,
    target: opts.target,
    groundPoint: opts.groundPoint,
    phase: 'start',
  });
  if (reason !== CastFailure.Ok) {
    opts.events?.onFailed?.(caster, skill, reason);
    return { ok: false, reason };
  }

  // 7.4 步骤 2：启动公共冷却。★ 注意这发生在**动作开始时**，不是完成时 ——
  // 所以取消读条也不会退还它（7.4 第 6 条）
  if (skill.triggersGcd) {
    caster.gcdUntil = world.time + Math.max(GCD.MIN, GCD.BASE);
  }

  if (skill.cast.kind === CastKind.Instant) {
    return finishCast(world, store, caster, skill, null, opts);
  }

  const state: CastState = {
    skillId: skill.id,
    kind: skill.cast.kind,
    startedAt: world.time,
    endsAt: world.time + skill.cast.time,
    targetId: opts.target?.id,
    groundPoint: opts.groundPoint ? { ...opts.groundPoint } : undefined,
    facing: caster.yaw,
    startPosition: { ...caster.position },
    school: skill.school,
    interruptible: skill.cast.interruptible,
    // 7.3：「主动移动」停止标记为原地施放的读条和射击
    requiresStationary: !skill.cast.movable,
  };
  if (skill.cast.kind === CastKind.Channel) {
    const dur = skill.cast.channelDuration ?? 0;
    state.channelEndsAt = state.endsAt + dur;
    const ticks = skill.cast.ticks ?? 1;
    state.nextTickAt = state.endsAt + dur / ticks;
  }

  store.set(caster.id, state);
  opts.events?.onStarted?.(caster, state);
  return { ok: true, state };
};

/**
 * 7.4 步骤 4–5：完成瞬间**再次**校验，通过才消耗资源与冷却。
 */
const finishCast = (
  world: World,
  store: CastingStore,
  caster: CombatEntity,
  skill: SkillDef,
  state: CastState | null,
  opts: { target?: CombatEntity; groundPoint?: Vec3; events?: CastEvents },
): CastResult => {
  const target = opts.target ?? getEntity(world, state?.targetId);
  const groundPoint = opts.groundPoint ?? state?.groundPoint;

  const reason = validateCast({
    world,
    caster,
    skill,
    target,
    groundPoint,
    phase: 'complete',
  });

  store.delete(caster.id);

  if (reason !== CastFailure.Ok) {
    // ★ 验收 #20：失败不产生重复伤害、资源扣除或冷却异常。
    // 这里**什么都不做** —— 不扣资源、不进冷却。已经走掉的 GCD 不返还。
    opts.events?.onFailed?.(caster, skill, reason);
    return { ok: false, reason };
  }

  // 7.4 步骤 5：成功释放才消耗资源、进入冷却
  if (skill.cost) spendResource(caster, skill.cost.resource, skill.cost.amount);
  if (skill.cooldown > 0) caster.cooldowns.set(skill.id, world.time + skill.cooldown);

  opts.events?.onCompleted?.(caster, skill, state ?? {
    skillId: skill.id,
    kind: CastKind.Instant,
    startedAt: world.time,
    endsAt: world.time,
    targetId: target?.id,
    groundPoint,
    facing: caster.yaw,
    startPosition: { ...caster.position },
    school: skill.school,
    interruptible: false,
    requiresStationary: false,
  });
  return { ok: true, state: null };
};

/**
 * 7.5 主动取消（假读条）。
 * ★ 验收 #18：取消**不消耗**技能资源和冷却，也不产生额外惩罚。
 */
export const cancelCast = (
  world: World,
  store: CastingStore,
  caster: CombatEntity,
  events?: CastEvents,
): boolean => {
  const state = store.get(caster.id);
  if (!state) return false;
  store.delete(caster.id);
  events?.onInterrupted?.(caster, state, InterruptSource.SelfCancel);
  return true;
};

export interface TickOptions {
  /** 本 tick 之后的技能查询函数 */
  getSkill: (id: SkillId) => SkillDef | undefined;
  events?: CastEvents;
  /** 移动判定阈值，米。超过它才算「主动移动」 */
  moveEpsilon?: number;
}

/**
 * 7.4 步骤 3：推进所有正在进行的施法，检查中断条件。
 *
 * ★ 必须在 movement 之后调用 —— 7.3 规定「主动移动停止原地施放的读条」，
 *   只有先算完移动才知道这一 tick 有没有位移（见 docs/02 §3 的 tick 顺序）。
 */
export const tickCasting = (world: World, store: CastingStore, opts: TickOptions): void => {
  const eps = opts.moveEpsilon ?? 0.05;

  for (const [id, state] of [...store.entries()]) {
    const caster = world.entities.get(id);
    const skill = opts.getSkill(state.skillId);
    if (!caster || !skill) {
      store.delete(id);
      continue;
    }

    // 7.3 死亡：立即终止全部动作
    if (!caster.alive) {
      store.delete(id);
      opts.events?.onInterrupted?.(caster, state, InterruptSource.Death);
      continue;
    }

    // 7.3 硬控制
    if (caster.flags.stunned) {
      store.delete(id);
      opts.events?.onInterrupted?.(caster, state, InterruptSource.HardControl);
      continue;
    }

    // 7.3 沉默停止魔法；缴械停止武器技能与瞄准射击
    if (caster.flags.silenced && isMagicSchool(state.school)) {
      store.delete(id);
      opts.events?.onInterrupted?.(caster, state, InterruptSource.Silence);
      continue;
    }
    if (caster.flags.disarmed && isWeaponSkill(skill)) {
      store.delete(id);
      opts.events?.onInterrupted?.(caster, state, InterruptSource.Disarm);
      continue;
    }

    // 7.3 主动移动：只停止标记为「原地施放」的
    if (state.requiresStationary) {
      const moved = Math.hypot(
        caster.position.x - state.startPosition.x,
        caster.position.z - state.startPosition.z,
      );
      if (moved > eps) {
        store.delete(id);
        opts.events?.onInterrupted?.(caster, state, InterruptSource.Movement);
        continue;
      }
    }

    // 引导：到时间就跳一次
    if (state.kind === CastKind.Channel && state.channelEndsAt !== undefined) {
      if (world.time >= state.channelEndsAt) {
        store.delete(id);
        opts.events?.onCompleted?.(caster, skill, state);
        continue;
      }
      continue;
    }

    // 读条 / 瞄准射击完成
    if (world.time >= state.endsAt) {
      finishCast(world, store, caster, skill, state, { events: opts.events });
    }
  }
};

/**
 * 7.3 强制位移（击退、拉拽、冲飞）通常停止读条和射击。
 * 由位移效果在把目标推开之后调用。
 */
export const interruptByForcedMove = (
  store: CastingStore,
  caster: CombatEntity,
  events?: CastEvents,
): boolean => {
  const state = store.get(caster.id);
  if (!state) return false;
  store.delete(caster.id);
  events?.onInterrupted?.(caster, state, InterruptSource.ForcedMove);
  return true;
};

