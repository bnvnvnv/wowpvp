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
  /**
   * 引导的结算是否已在**引导开始**时发生（见 tickCasting 引导分支的 ★）。
   * 打断路径靠它区分「读条期被打断（无事发生）」与「引导期被打断
   * （要掐掉已经生成的地面区域）」。仅 channel
   */
  channelResolved?: boolean;
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

  /**
   * 附录A#4：removes = **禁用**、grants = 方案专属 —— 武器方案没给的技能
   * 连起手都不行。集合由装备路径维护在实体上（`skillsAvailableWith`），
   * 这里只读 —— 本文件保持零数据注册表依赖。
   * ⚠️ M14 之前无人执行这条：短弓猎人照放重弩专属的穿透弩箭，
   *   配平 bot 第一个撞上（客户端装备面板只是不「显示」，服务器照收）。
   */
  if (!caster.availableSkills.has(skill.id)) return CastFailure.WeaponMismatch;

  // 7.2 学派锁定
  if (isMagicSchool(skill.school) && isSchoolLocked(caster, skill.school, now)) {
    return CastFailure.SchoolLocked;
  }

  // 12.3 旗手限制
  if (skill.forbiddenWhileCarryingFlag && caster.flags.carryingFlag) {
    return CastFailure.CarryingFlag;
  }

  /**
   * ★★ `SkillDef.requires`（schema v1.1 的 `ConditionDef`）。
   *
   *   ⚠️ **这个字段在 M11 之前是死 schema —— 全仓零个读取方。**
   *   它被 v1.1 加进来是为了收敛「前置条件」类的 `custom` handler，
   *   但 `validateCast()` 从来没有读过它。后果比「功能缺失」更糟：
   *   把 `requires` 写进数据会得到**静默被忽略的配置**，
   *   而作者以为自己表达了一条规则。
   */
  for (const cond of skill.requires ?? []) {
    const fail = checkCondition(ctx, cond, now);
    if (fail !== CastFailure.Ok) return fail;
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
  // 两者都为真，但后者更可操作。
  // ★ M11：这个问题的解法是下面的 `describeCastBlockers()` —— 它返回**全部**
  //   当前阻碍项供 HUD 叠加显示，而**不改**这里的门禁顺序。
  //   门禁顺序改了会影响 CastFailure 的语义与统计归因，而顺序本身是 7.4 规定的。

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
 * 判定一条前置条件。★ 不认识的 kind 一律**放行** ——
 * 拦下来会让「schema 加了新 kind 但 sim 还没跟上」表现为技能突然不能放，
 * 而放行只是少一道限制，且 `data.test.ts` 会在别处发现它。
 */
const checkCondition = (
  ctx: CastContext, cond: NonNullable<SkillDef['requires']>[number], now: number,
): CastFailure => {
  const { caster } = ctx;
  switch (cond.kind) {
    case 'outOfCombat':
      return now - caster.lastCombatAt >= cond.seconds ? CastFailure.Ok : CastFailure.InCombat;
    case 'minResource':
      return getResource(caster, cond.resource) >= cond.amount
        ? CastFailure.Ok : CastFailure.NotEnoughResource;
    case 'notCarryingFlag':
      return caster.flags.carryingFlag ? CastFailure.CarryingFlag : CastFailure.Ok;
    case 'recentlyParried':
      // 9.x 反击刺：近期发生过招架。★ 数据源是 M11 才有的 `lastParryAt`
      return now - caster.lastParryAt <= cond.withinSeconds
        ? CastFailure.Ok : CastFailure.NoRecentParry;
    case 'targetCasting':
      // ★ 仅提示用（7.2 规定打断落空也进冷却），所以这里**不拦**
      return CastFailure.Ok;
    default:
      /**
       * `inForm` / `notInForm` 目前在 sim 里**没有数据源**（形态状态还不存在）。
       * 放行而不是拦下 —— 见函数头。⚠️ 已登记在 PROGRESS 技术债。
       */
      return CastFailure.Ok;
  }
};

/**
 * 列出**当前全部**阻碍项，而不是第一个。技术债 #3 / 规格书 15.2。
 *
 * ★★ **它与 `validateCast()` 是两件事，不要合并：**
 *
 *   · `validateCast()` 是**门禁** —— 返回单一 `CastFailure`，顺序由 7.4 步骤 1
 *     规定（资源在距离之前）。它的返回值还是统计归因的依据，改顺序会连带改统计。
 *   · 本函数是**提示** —— 给 HUD 用，要回答「我现在到底缺什么」。
 *
 *   一个怒气为 0 的战士站在 30 米外，门禁说「资源不足」（正确且符合 7.4），
 *   但玩家更需要知道的是「你还太远」。两个答案都对，服务的问题不同 ——
 *   所以解法是**并排加一个函数**，而不是改门禁顺序。
 *
 * ★ 返回顺序按「玩家最该先解决的」排：位置 → 视线 → 朝向 → 资源 → 冷却 → 状态。
 *   ⚠️ 这个顺序**只影响显示**，不影响任何判定。
 *
 * @returns 全部成立的阻碍项。可释放时为空数组
 */
export const describeCastBlockers = (ctx: CastContext): CastFailure[] => {
  const { caster, skill, target, world } = ctx;
  const now = world.time;
  const out: CastFailure[] = [];

  // 死亡是压倒性的，其余都不必再提
  if (!caster.alive) return [CastFailure.Dead];

  // ── 位置类（玩家最该先解决的）────────────────────────────
  const needsTarget =
    skill.targeting === Targeting.Direct || skill.targeting === Targeting.Ground;
  if (skill.targeting === Targeting.Ground) {
    if (!ctx.groundPoint) out.push(CastFailure.NoTarget);
    else {
      const d = Math.hypot(
        ctx.groundPoint.x - caster.position.x,
        ctx.groundPoint.z - caster.position.z,
      );
      if (d > skill.range.max) out.push(CastFailure.OutOfRange);
    }
  } else if (needsTarget) {
    if (!target) out.push(CastFailure.NoTarget);
    else {
      const hostile = target.team !== caster.team;
      const wrongSide =
        (skill.targetFilter === TargetFilter.Enemy && !hostile) ||
        (skill.targetFilter === TargetFilter.Ally && hostile);
      if (!isSelectableBy(target, caster) || wrongSide) out.push(CastFailure.InvalidTarget);
      else {
        if (!inRange(hitCircleOf(caster), hitCircleOf(target), skill.range.max, skill.range.min)) {
          const withinMin =
            skill.range.min > 0 &&
            inRange(hitCircleOf(caster), hitCircleOf(target), skill.range.min, 0);
          out.push(withinMin ? CastFailure.TooClose : CastFailure.OutOfRange);
        }
        if (
          skill.requiresLos &&
          !hasLineOfSight(hitCircleOf(caster), hitCircleOf(target), world.obstacles)
        ) {
          out.push(CastFailure.NoLineOfSight);
        }
        if (skill.requiresFacing && !isFacing(caster.position, caster.yaw, target.position)) {
          out.push(CastFailure.WrongFacing);
        }
      }
    }
  }

  // ── 资源与冷却 ───────────────────────────────────────────
  if (skill.cost && getResource(caster, skill.cost.resource) < skill.cost.amount) {
    out.push(CastFailure.NotEnoughResource);
  }
  if (isOnCooldown(caster, skill.id, now)) out.push(CastFailure.OnCooldown);
  if (skill.triggersGcd && isOnGcd(caster, now)) out.push(CastFailure.OnGlobalCooldown);

  // ── 状态类 ───────────────────────────────────────────────
  if (caster.flags.stunned && !skill.usableWhileStunned) out.push(CastFailure.Controlled);
  if (caster.flags.silenced && isMagicSchool(skill.school)) out.push(CastFailure.Silenced);
  if (caster.flags.disarmed && isWeaponSkill(skill)) out.push(CastFailure.Disarmed);
  if (isMagicSchool(skill.school) && isSchoolLocked(caster, skill.school, now)) {
    out.push(CastFailure.SchoolLocked);
  }
  if (skill.forbiddenWhileCarryingFlag && caster.flags.carryingFlag) {
    out.push(CastFailure.CarryingFlag);
  }

  return out;
};

/**
 * 7.3：缴械禁止「武器攻击、瞄准射击和武器技能」。
 * 判据：物理学派的技能都算武器技能。纯魔法（神圣/火焰/寒冰/奥术/暗影/自然）不受影响。
 */
export const isWeaponSkill = (skill: SkillDef): boolean =>
  skill.school === School.Physical || skill.cast.kind === CastKind.AimedShot;

// ── 生命周期 ─────────────────────────────────────────────────────

/**
 * 施法者**此刻**的读条时间乘算（`EffectiveModifiers.castSpeed`）。
 *
 * ★★ **由调用方注入，不在本文件里算。** 聚合要读武器与护甲
 *   （`modifiers.equipmentModifiersOf`），而 casting.ts 的纪律是**零数据
 *   注册表依赖**（见 `validateCast` 里 `availableSkills` 那段的理由）。
 *   注入一个纯数字函数就不会把 data 拖进来。
 *
 * ★ 缺省不传 = 倍率 1 = 与 W26 之前逐位相同的行为。生产路径只有
 *   `tickWorld` 一处，它一定传（三个入口共用同一个闭包）；
 *   试验场/验收脚本走的也是 `tickWorld`。
 */
export type CastTimeScaleFn = (caster: CombatEntity) => number;

/**
 * 一次读条实际要花的秒数。
 *
 * ★★ **只缩放读条段，不碰引导时长**（`channelDuration`）。理由不是省事：
 *   引导时长是**效果本身**的时长 —— 暴风雪的引导 4 秒对应
 *   `spawnGroundArea.duration` 的 4 秒，两个数字必须相等，
 *   `tickWorld` 的打断分支正是靠这一点掐掉已经生成的地面区域。
 *   只把 `channelEndsAt` 缩 15% 会得到「引导条走完了、雪还在下 0.6 秒」，
 *   而缩地面区域是在改技能的**效果强度**，那属于配平不属于接线。
 *   schema 对这个字段的原文也只说「**读条**时间乘算」。
 *
 * ★ **瞄准射击（`AimedShot`）一并吃**：它的 `cast.time` 就是「准备」那一段，
 *   7.6 与读条走的是同一条推进路径（`tickCasting` 的 `endsAt`）。守护型护甲
 *   的「施法速度降低」因此也压猎人的瞄准 —— 与它压读条是同一件事，
 *   把射击豁免掉反而要在这里凭空立一条规格书没有的例外。
 * ★ **GCD 不吃**：schema 对这个字段的原文限定在「读条时间」，而 `GCD.BASE`
 *   是 7.4 步骤 2 的固定值。与 WoW「急速同时压 GCD」的差异是**有意**的 ——
 *   动 GCD 等于动全部瞬发技能的节奏，那是配平不是接线。
 *
 * ★★ **取值时刻：读条开始的那一瞬，之后锁死。**
 *   · WoW 口径：施法时间在起手时确定，中途获得/失去急速不改变当前这一条；
 *   · 结构理由：`endsAt` 是写在 `CastState` 上的**绝对时刻**，HUD 与特效层
 *     按 `(now - startedAt) / (endsAt - startedAt)` 线性插值（`CombatHud`
 *     的施法条、`castVfx` 的相位）—— 每 tick 重算会让掉一个 buff 表现为
 *     读条条当场跳一下，玩家只会读作卡顿；
 *   · 联网侧同源：服务器 `CastStarted` 发的是 `endsAt - startedAt`，
 *     客户端读条条自动跟随，**零协议改动**。
 */
export const castTimeOf = (
  skill: SkillDef, caster: CombatEntity, scale?: CastTimeScaleFn,
): number => skill.cast.time * (scale?.(caster) ?? 1);

export type CastResult =
  | { ok: true; state: CastState | null }
  /**
   * `queued` 只由 `beginCastOrQueue()` 置位（P10 / 合同 C5）——
   * 表示这次按键被存进了排队窗，失败提示**已被有意吞掉**，稍后会重试。
   * 老调用方读不到这个字段也不受影响（可选）。
   */
  | { ok: false; reason: CastFailure; queued?: boolean };

/**
 * 施法事件回调。
 *
 * ⚠️ **有两个事件出口，别只接一个：**
 *   · 瞬发技能在 `beginCast` 内部就完成了，走的是**传给 beginCast** 的 events
 *   · 读条/引导/瞄准射击由 `tickCasting` 推进完成，走的是**传给 tickCasting** 的 events
 *
 * 想在「任何技能完成时」做一件事（例如结算效果），必须把**同一个**回调
 * 同时传给两处。只接 beginCast 的话，所有读条技能都不会结算效果 ——
 * 而且技能看起来是「完成」的，极难发现。
 */
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
  /**
   * ★★ X21：**排队窗过期**（0.4 秒到了还没轮到它，这次按键就此作废）。
   *
   *   刻意不是 `onFailed(..., OnGlobalCooldown)`：那条理由在按下的**那一刻**
   *   是真的，但 0.4 秒后原样弹出来会让玩家以为「现在还在公共冷却」——
   *   迟到的失败提示比沉默更误导，这正是 X21 拍板前卡住的点。分成独立的
   *   一路，表现层才能说出「刚才那一下没赶上」这句**当下为真**的话，
   *   也才能自己决定要不要说（弱提示/只闪一下图标/什么都不做）。
   *
   * ★ `waited` 是从按下到作废的实际秒数（≈ `CAST_QUEUE_WINDOW`），
   *   给表现层判断「差一点点」还是「早就凉了」用。
   */
  onQueueExpired?: (
    caster: CombatEntity,
    skill: SkillDef,
    info: { queued: QueuedCast; waited: number },
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
  opts: {
    target?: CombatEntity; groundPoint?: Vec3; events?: CastEvents;
    /** W26：读条时间乘算。不传 = 1，与接线前逐位相同 —— 见 `castTimeOf` */
    castTimeScale?: CastTimeScaleFn;
  } = {},
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
    // ★ W26：读条时长在这里、而且**只在这里**吃 castSpeed（见 castTimeOf）
    endsAt: world.time + castTimeOf(skill, caster, opts.castTimeScale),
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
    // ★ 此前这里还给 nextTickAt 赋值 —— 全仓零消费方（引导的逐跳由技能
    //   自己的 spawnGroundArea.tickInterval 承担），死字段已删（X10 追加轮）
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

    /**
     * 引导（7.1）：结算发生在**引导开始**（读条结束那一刻），不是引导结束 ——
     * 暴风雪要在引导期间下雪，「读条读完了才下」是 X10 追加轮用户实测
     * 戳穿的错时序。
     *
     * ★★ 此前结算挂在 channelEndsAt、且不走 finishCast：效果整整迟到
     *   channelDuration 秒不说，资源与冷却**从来没扣过**（spendResource /
     *   cooldowns.set 只存在于 finishCast，而引导路径不经过它）——
     *   引导技能一直是免费、无冷却的。「写了没人调」家族又一员。
     * ★ 与 finishCast 同一条纪律（验收 #20）：开始引导前再次校验，
     *   失败不扣资源、不进冷却；成功才消耗并结算。
     */
    if (state.kind === CastKind.Channel && state.channelEndsAt !== undefined) {
      if (!state.channelResolved && world.time >= state.endsAt) {
        const reason = validateCast({
          world, caster, skill,
          target: getEntity(world, state.targetId),
          groundPoint: state.groundPoint,
          phase: 'complete',
        });
        if (reason !== CastFailure.Ok) {
          store.delete(id);
          opts.events?.onFailed?.(caster, skill, reason);
          continue;
        }
        if (skill.cost) spendResource(caster, skill.cost.resource, skill.cost.amount);
        if (skill.cooldown > 0) caster.cooldowns.set(skill.id, world.time + skill.cooldown);
        state.channelResolved = true;
        opts.events?.onCompleted?.(caster, skill, state);
      }
      // 引导走完：清场即可 —— 结算早已发生，这里绝不能再 onCompleted 一次
      // （那是双份暴风雪）。打断/移动/控制路径在上面，自带 onInterrupted。
      if (world.time >= state.channelEndsAt) store.delete(id);
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

// ── 施法排队窗（P10 / 合同 C5）─────────────────────────────────────

/**
 * ★★ **排队窗时长，秒。占位值 0.4。**
 *
 *   取值理由：参照 WoW 的按键队列窗（~400ms）。它必须同时满足两件相反的事 ——
 *   够长到能吸收人手在 GCD 结束前的提前量（实测手感上多数人早按 100~300ms），
 *   又短到不会把「我改主意了」变成「0.8 秒后突然放了一个我早就不想放的技能」。
 *   ⚠️ 没有本项目自己的实测数据支撑这个数，是照抄手感基准；调之前先做一次
 *   真机对比（早按 0.2s / 0.35s / 0.5s 三档），不要凭感觉动。
 */
export const CAST_QUEUE_WINDOW = 0.4;

/**
 * 排队窗里存着的那一次按键。
 *
 * ⚠️ **刻意不存 `facing`。** 方向技能在按下那一刻会把 `caster.yaw` 设成当时的
 *    镜头朝向（见 `tick.ts` 第 1 步）；等 0.4 秒后真正放出来时再把那个**旧**朝向
 *    重放一遍，角色会被扭回按键那一刻的方向 —— 玩家会看到自己原地一甩。
 *    消费时用**当前** yaw 才是他此刻的意图。
 */
export interface QueuedCast {
  skillId: SkillId;
  targetId?: EntityId;
  groundPoint?: Vec3;
  /** 按下的绝对时刻（`world.time`），用于判断 0.4 秒过期 */
  pressedAt: number;
}

/**
 * 每个实体**至多一格**的排队位。
 * ★ 单槽是有意的：后按的覆盖先按的 —— 玩家连点三个键时想放的是最后那个，
 *   排成队列会在 GCD 结束后连放三个，那不是「跟手」是「失控」。
 */
export type CastQueueStore = Map<EntityId, QueuedCast>;

export const createCastQueueStore = (): CastQueueStore => new Map();

/**
 * 这个失败原因值不值得排队。
 *
 * ★ **只有这两个**：它们的共同点是「再等一小会儿就会自己好」。
 *   距离不够、资源不足、被沉默都不在其列 —— 那些是玩家要**做点什么**才能
 *   解决的问题，替他重试只会把一次明确的失败拖成 0.4 秒后的同一次失败。
 */
export const isQueueableFailure = (reason: CastFailure): boolean =>
  reason === CastFailure.OnGlobalCooldown || reason === CastFailure.AlreadyCasting;

/** `events` 去掉 onFailed 的那一份。排队期间失败提示要吞掉，其余事件照发 */
const withoutFailureReport = (
  events: CastEvents | undefined,
): { quiet: CastEvents; report: CastEvents['onFailed'] } => {
  // ★ 用 rest 而不是逐个字段拷 —— 将来给 CastEvents 加新回调时不会被静默丢掉
  const { onFailed, ...quiet } = events ?? {};
  return { quiet, report: onFailed };
};

/**
 * ★★ **带排队窗的 `beginCast()`（合同 C5）。**
 *
 *   真机审计坐实的问题：GCD 是 1.0 秒，而人手不可能恰好在它归零那一帧按下。
 *   早按 100 毫秒 = 这次按键**被直接丢掉**，GCD 结束也不会补放 —— 玩家的
 *   感受是「我明明按了」。这是 WoW 顺手感里最核心的一环，也是本作此前
 *   与它差得最远的一环。
 *
 * ⚠️ **平衡红线：只有显式 `queue` 的请求走这条路。**
 *   `tick.ts` 第 1 步对不带 `queue` 的请求调的仍然是原样的 `beginCast()`，
 *   一个字节的差异都没有。红线的三道保险：
 *     · 协议 `CastRequest` **没有** `queue` 字段 —— 客户端伪造不出来；
 *     · 服务器只给 `Session.isBot !== true` 的会话补 `queue: true`
 *       （⚠️ `BotDriver` 发的是**真的** `CastRequest`，走的正是同一条
 *       `MatchLoop.requestCast`，所以那道 isBot 判断是红线本身，不是优化）；
 *     · `scripts/balance-report.ts` 直接调 `tickWorld`，连排队 store 都不建。
 *
 * @returns 与 `beginCast` 同构；被存进排队窗时额外带 `queued: true`
 */
export const beginCastOrQueue = (
  world: World,
  store: CastingStore,
  queue: CastQueueStore,
  caster: CombatEntity,
  skill: SkillDef,
  opts: {
    target?: CombatEntity; groundPoint?: Vec3; events?: CastEvents;
    castTimeScale?: CastTimeScaleFn;
  } = {},
): CastResult => {
  const { quiet, report } = withoutFailureReport(opts.events);
  const r = beginCast(world, store, caster, skill, { ...opts, events: quiet });
  if (r.ok) return r;

  if (isQueueableFailure(r.reason)) {
    queue.set(caster.id, {
      skillId: skill.id,
      ...(opts.target ? { targetId: opts.target.id } : {}),
      ...(opts.groundPoint ? { groundPoint: { ...opts.groundPoint } } : {}),
      pressedAt: world.time,
    });
    // ★ 这次失败**不上报**：马上就要替他重试了，弹一句「公共冷却中」等于
    //   把排队窗要消灭的那条噪音又原样放回 HUD 上
    return { ok: false, reason: r.reason, queued: true };
  }

  report?.(caster, skill, r.reason);
  return r;
};

export interface CastQueueTickOptions {
  getSkill: (id: SkillId) => SkillDef | undefined;
  events?: CastEvents;
  /**
   * W26：读条时间乘算。★ 这里必须是**函数**而不是一个数 —— 排队窗是逐实体
   * 遍历的，一个数就变成「谁排队都按同一个人的护甲算读条」。
   */
  castTimeScale?: CastTimeScaleFn;
}

/**
 * 消费排队窗。
 *
 * ★ **必须在 `tickCasting()` 之后调**：本 tick 刚读完的那一条读条要能被排队的
 *   下一发**当场**接上。放在它之前的话，「读条结束 → 排队技能起手」中间会空
 *   一整个 tick（50ms），排队窗省下来的提前量又被这里还回去了。
 *
 * ★ 重试走的是**完整的** `beginCast()`（内含完整 `validateCast`）——
 *   排队不是「先斩后奏」：这 0.4 秒里目标可能跑远了、自己可能被沉默了，
 *   那些照样要拦。合同 C5 的「重新走完整 validateCast」就是这个意思。
 */
export const tickCastQueue = (
  world: World,
  store: CastingStore,
  queue: CastQueueStore,
  opts: CastQueueTickOptions,
): void => {
  const { quiet, report } = withoutFailureReport(opts.events);

  for (const [id, q] of [...queue.entries()]) {
    const caster = world.entities.get(id);
    const skill = opts.getSkill(q.skillId);
    if (!caster || !caster.alive || !skill) {
      queue.delete(id);
      continue;
    }

    /**
     * 过期。
     *
     * ★★ X21（拍板 2026-08-10）：**不再静默丢弃，但也不走 `onFailed`。**
     *
     *   原来这里什么都不发，理由写着「0.4 秒之后才弹『公共冷却中』只会让
     *   人以为是刚才那一下出的问题」—— 那句话对的是**理由**，不是**沉默**：
     *   按键彻底消失同样让人怀疑是不是没按上。所以走一路独立的
     *   `onQueueExpired`：说的是「刚才那一下没赶上」这件当下为真的事，
     *   要不要显示、显示成什么由表现层自己拿主意。
     *   合同 C5 的「二次失败走 onFailed」原样不动（见下面）。
     */
    const waited = world.time - q.pressedAt;
    if (waited > CAST_QUEUE_WINDOW) {
      queue.delete(id);
      opts.events?.onQueueExpired?.(caster, skill, { queued: q, waited });
      continue;
    }

    const r = beginCast(world, store, caster, skill, {
      ...(q.targetId !== undefined ? { target: getEntity(world, q.targetId) } : {}),
      ...(q.groundPoint ? { groundPoint: q.groundPoint } : {}),
      ...(opts.castTimeScale ? { castTimeScale: opts.castTimeScale } : {}),
      events: quiet,
    });
    if (r.ok) {
      queue.delete(id);
      continue;
    }
    // GCD/读条还没结束 —— 这不算「二次失败」，是还没轮到它。窗口没过期就继续等
    if (isQueueableFailure(r.reason)) continue;

    // 合同 C5：二次失败按普通失败上报（这时玩家确实需要知道为什么没放出来）
    queue.delete(id);
    report?.(caster, skill, r.reason);
  }
};

