/**
 * 权威 tick：一次模拟推进的**唯一顺序定义**。docs/02 §3。
 *
 * ★★ **这个文件存在的理由是「顺序只能有一处定义」。**
 *
 *   docs/02 §3 明确写了「**顺序不能随意调整**」，但在 M10 之前这个顺序
 *   只**隐式**存在于 `client/src/combat/CombatDirector.update()` 的书写次序里。
 *   服务器如果再写一份，就有了两个实现 —— 而本项目已经四次遇到
 *   「规则写对了、单测全绿、但没人调用它」（M3/M4 的七个、M8 的 #2、M9 的两个）。
 *
 *   两份 tick 顺序会制造这类 bug 里最难查的一种：两边都能跑，
 *   但结算次序差一步，于是同一发技能在客户端预测里命中、在服务器判定里落空。
 *   玩家看到的是「打中了但没伤害」，而两边的代码单独看都是对的。
 *
 * ── 真实的顺序约束图 ────────────────────────────────────────────
 *
 * 下面每一条约束都有出处，**不是设计偏好**。改顺序前请先读这一段：
 *
 * | # | 步骤 | 约束 | 出处 |
 * |---|---|---|---|
 * | 0 | forfeits（弃权判死）| **必须在统计折叠 / matchRules / settleDeaths 之前** —— 三者都要在本 tick 看到弃权产生的死亡；放在最前还让弃权者的技能请求与移动经由 `!alive` 自然失效 | 11.5 / 技术债总账 A1 |
 * | 1b' | itemGrants（道具兑换的即时效果）| 与消耗品同属 applyInputs；**效果结算只有本文件一个出口** —— 商店那边只算账，不改血 | P13 / 技术债总账 A1、A2 |
 * | 1c | trinketRequests（战斗意志）| 与技能/消耗品同属 applyInputs；**刻意不查任何控制状态** —— 8.3「默认允许在昏迷中使用」，解控就是为昏迷造的 | 8.3 / 技术债总账 W8 |
 * | 1 | movement | —— | docs/02 §3 |
 * | 2 | casting | **必须在 movement 之后**：7.3「主动移动停止原地施放的读条」，先算完移动才知道这一 tick 有没有位移 | `casting.ts` 头部 |
 * | 3 | auras | 周期跳产生的效果要在本 tick 结算 | docs/02 §3 |
 * | 4 | projectiles | | |
 * | 5 | groundAreas | | |
 * | 6 | deriveStatusFlags | **必须在全部光环变动之后**，否则本 tick 新加的控制要等下一 tick 才生效 | `aura.ts` / M4 |
 * | 7 | swaps + pickups | **必须在 deriveStatusFlags 之后**：它们读 `flags.stunned` 判断硬控制中断 | `loadout.ts` / `arsenal.ts` |
 * | 8 | stats 折叠 | **必须在 matchRules 之前**：`carrierKills` 读 `flags.carryingFlag`，而 `tickFlags()` 会在死亡后把旗掉下来并清掉那个标志 | `stats.ts` 的 `ingestCombatEvents` 头部 |
 * | 9 | matchRules | **必须在 movement 与死亡之后**：`tickFlags` 要知道这一 tick 有没有位移；`tickArena` 读 `alive` 判胜负，顺序反了胜负慢一个 tick | `flag.ts` / `arena.ts` 头部 |
 * | 10 | settleDeaths | **必须在 swaps/pickups 之后**：那两个函数靠「实体已死」发出 `result:'death'` 事件（17.3 换装瞬间死亡），而 settleDeaths 会清掉进行中的换装 —— 放前面会把事件吃掉 | `death.ts` 头部 |
 * | 10b | tickBoss | **必须在 settleDeaths 之后**：它靠「BOSS 已经走完整条死亡漏斗」才摘尸体、刷战利品；放前面会在 settleDeaths 眼皮底下把实体删掉 | `boss.ts` 头部 |
 * | 11 | pruneInvalidTargets | 目标可能在本 tick 死亡/离场 | `targeting.ts` |
 *
 * ⚠️ **注意 `alive = false` 不是一个独立步骤。**
 *    它发生在第 3–5 步的效果结算里（`dealDamage()` 内部）。
 *    docs/02 §3 把 `deaths` 列成一步，指的是「存活人数与平局判定」——
 *    而那件事实际由 `tickArena()` 做，也就是第 9 步。
 *    这是 docs/02 与实现的一处**表述差异**，已在该文件里注明。
 *
 * ★ 为什么统计折叠（第 8 步）在**这个文件里**而不是留给调用方：
 *   它有一条真实的顺序约束（第 8 行），而这个文件的全部意义就是
 *   「顺序只有一处定义」。留给调用方就等于把这条约束交给两个调用方各自记住。
 */

import type { Aabb } from '../math/geometry.js';
import type { EffectDef, SkillDef } from '../data/schema.js';
import type { MapDef } from '../data/maps/schema.js';
import { asSkillId, type ClassId, type EntityId, type SkillId } from '../types/ids.js';
import { PVP_TRINKET } from '../constants/combat.js';
import type { Vec3 } from '../math/vec3.js';
import { gainResource, type CombatEntity } from './entity.js';
import {
  deriveStatusFlags, moveSpeedMultiplierOf, tickAuras, type AuraStore,
} from './aura.js';
import {
  beginCast, beginCastOrQueue, tickCasting, tickCastQueue,
  type CastEvents, type CastQueueStore, type CastState, type CastingStore,
} from './casting.js';
import { resolveCastTargets } from './castResolve.js';
import type { DrStore } from './dr.js';
import { tickBoss, type BossState, type BossTickResult } from './boss.js';
import { settleDeaths, type DeathSettlement } from './death.js';
import { resolveEffects, useTrinket, type CombatEvent } from './effects/index.js';
import { expireGroundAreasFor, tickGround, type GroundStore } from './groundArea.js';
import { CastKind } from '../types/enums.js';
import {
  tickArsenal, tickPartyDrops, tickPickups,
  type ArsenalStore, type GroundDrop, type PickupStore, type PickupTickEvent,
} from './arsenal.js';
import { takeConsumable, tickSwaps, type LoadoutStore, type SwapStore, type SwapTickEvent } from './loadout.js';
import { tickArena, type ArenaEvents, type ArenaState } from './match/arena.js';
import { ctfInOvertime, tickFlags, type CtfDeps, type CtfState, type FlagEvent } from './match/flag.js';
import {
  enqueueRespawn, setOvertime, tickRespawn, type RespawnEvent, type RespawnState,
} from './match/respawn.js';
import {
  movementLockOf, separationVelocity, stepMovement, teleportTo,
  type MovementInput, type MovementState,
} from './movement.js';
import { pruneInvalidTargets } from './targeting.js';
import { tickSwings, type SwingResult, type SwingStore } from './autoAttack.js';
import { tickProjectiles, type ProjectileStore } from './projectile.js';
import {
  ingestCombatEvents, ingestFlagEvents, ingestPickupEvents, ingestSwapEvents,
  recordItemBuff, sampleTick, type StatsStore,
} from './stats.js';
import { getConsumable } from '../data/consumables.js';
import type { ConsumableDef } from '../data/schema.js';
import type { ConsumableId } from '../types/ids.js';
import { getEntity, listEntities, type World } from './world.js';

// ════════════════════════════════════════════════════════════════
//  依赖
// ════════════════════════════════════════════════════════════════

/**
 * 8.3 战斗意志的冷却记账键（技术债总账 W8）。
 * ★ 走 `cooldowns` 而不是新开字段：它随 self 快照的 cooldowns 一起下发，
 *   客户端的冷却预检与显示零协议改动；敌方看不到（cooldowns 是 self-only）。
 */
export const TRINKET_COOLDOWN_KEY = asSkillId('trinket');

/** 一次技能请求的意图。★ 只有意图，没有结果 —— 与网络协议同源 */
export interface CastIntent {
  skillId: SkillId;
  targetId?: EntityId;
  groundPoint?: Vec3;
  /** 方向技能的朝向。不传则用施法者当前 yaw */
  facing?: number;
  /**
   * 施法排队窗（P10 / 合同 C5）。**缺省 `undefined` = 老行为**：
   * 撞上 GCD 或正在读条就直接丢掉这次按键。
   *
   * ⚠️★ **这是平衡红线的那个显式开关。** 人机（`BotDriver`）发出的
   *   `CastRequest` 协议消息里根本没有这个字段，`MatchLoop` 也只给真人会话
   *   补 `queue: true` —— 于是 normal 档人机永远走不进排队窗，配平基线逐位不变。
   *   往这里加「默认开启」之类的便利改动 = 直接踩线。
   */
  queue?: boolean;
}

/**
 * 一个 tick 会碰到的全部状态容器。
 *
 * ★ 参数多是**如实反映**，不是设计缺陷：这确实就是一次模拟推进touch 到的东西。
 *   把它们藏进一个 God object 只会让「谁改了什么」更难看清。
 */
export interface TickDeps {
  world: World;
  auras: AuraStore;
  dr: DrStore;
  ground: GroundStore;
  projectiles: ProjectileStore;
  casting: CastingStore;

  /**
   * 普通攻击的挥击计时（7.6）。
   * ★ **没有条目的实体不自动攻击** —— 与 `movement` 同一个设计，
   *   试验场因此不受影响（M1–M9 的 141 项验收跑在那里）。
   */
  swings?: SwingStore;
  loadouts: LoadoutStore;
  swaps: SwapStore;
  pickups: PickupStore;
  arsenal: ArsenalStore;

  /**
   * 每个实体的移动状态。
   * ★ **没有条目的实体不参与移动** —— 假人、图腾、以及「位置由别处驱动」的
   *   实体（试验场里玩家的移动在 `TestbedScene` 算）都靠这一点自然跳过。
   */
  movement: Map<EntityId, MovementState>;
  /** 本 tick 每个实体的移动意图。没有条目 = 站着不动 */
  inputs: ReadonlyMap<EntityId, MovementInput>;
  /**
   * 本 tick 每个实体的技能请求（docs/02 §3 第 1 步「applyInputs」含技能请求）。
   *
   * ★★ **技能请求必须由 tick 处理，不能留给调用方自己调 `beginCast()`。**
   *
   *   `casting.ts` 头部写着：施法有**两个**完成出口 —— 瞬发技能在
   *   `beginCast` 内部就完成了，读条技能由 `tickCasting` 推进完成。
   *   想在「任何技能完成时」结算效果，必须把**同一个**回调传给两处。
   *
   *   M4 阶段就是只接了一个：读条技能全都不产生效果，而技能看起来是「完成」的。
   *   留给调用方的话，服务器和客户端各要记住这件事一次 —— 而忘记它不会报错。
   *   放进 tick 之后，「只接一个出口」在结构上写不出来。
   */
  castRequests?: ReadonlyMap<EntityId, CastIntent>;
  /**
   * 施法排队窗的存放处（P10 / 合同 C5）。
   *
   * ⚠️ **不传 = 排队窗整体不存在**：带 `queue: true` 的请求会退化成老行为
   *   （撞 GCD 直接失败并正常上报）。这是有意的默认 —— 排队位必须跨 tick 存活，
   *   而「跨 tick 的状态」在本仓库一律由调用方持有（与 `casting` / `movement`
   *   同规矩），tick 自己造一个就等于每 tick 丢一次。
   * ★ 服务器由 `tickDepsOf()` 自动接上（`Match.castQueue`）；试验场要自己建一个
   *   `createCastQueueStore()` 传进来，否则 `queue: true` 是**静默无效**的。
   */
  castQueue?: CastQueueStore;
  /**
   * 本 tick 每个实体要使用的消耗品槽位（10.1）。
   *
   * ★★ 和技能请求同理：**消耗品的效果也必须由 tick 结算**。
   *   调用方自己调 `resolveEffects()` 就开出了第二个结算出口 ——
   *   而 A2 的教训正是「第二个出口会静默地少做一半事」。
   */
  consumableRequests?: ReadonlyMap<EntityId, number>;
  /**
   * 本 tick 要使用「战斗意志」的实体（8.3 通用解控，技术债总账 W8）。
   * ★ `useTrinket()` 从 M9 写好就零调用方 —— R 键、协议消息、服务器的
   *   诚实拒绝分支都在等这一步。结算只有 tick 一个出口（与技能/消耗品
   *   同规矩）。冷却记在 `cooldowns` 的 `TRINKET_COOLDOWN_KEY` 上 ——
   *   它随 self 快照的 cooldowns 下发，客户端因此能显示/预检冷却。
   */
  trinketRequests?: ReadonlySet<EntityId>;
  /**
   * 本 tick 由**道具兑换**产生的即时效果（P13 大乱斗积分商店的「立即满血」）。
   * 键是受益人，值是要在他身上结算的效果清单。
   *
   * ★★ 与消耗品同一条理由：**效果结算只有 tick 一个出口**。
   *   调用方直接写 `e.health = e.maxHealth` 是能跑的，但那样不产生 `heal`
   *   事件 —— 治疗数字不广播、16.1 的治疗统计漏账，两样都不会报错
   *   （技术债总账 A1/A2 同族）。所以商店那边只算「买没买成」，
   *   效果排到这里来结算。
   * ★ 通道是**通用**的（一份效果清单），不是「满血」专用分支：
   *   将来商店加「立即解控」「护盾」只需要换清单，tick 这一步不用再改。
   */
  itemGrants?: ReadonlyMap<EntityId, readonly EffectDef[]>;
  /**
   * 本 tick 要弃权判死的实体（11.5「主动退出立即按淘汰处理，**不能通过
   * 退出规避死亡统计**」；超时淘汰同路）。
   *
   * ★★ 弃权必须由 tick 结算，不能由调用方直改 `alive/health` ——
   *   直改字段不产生 `death` 事件，于是三件事**静默不发生**：
   *   统计不记这次死亡、`settleDeaths` 不清临时装备（10.10）、
   *   服务器不广播 `Death`。与 `castRequests` 的教训同族：
   *   第二个出口会静默地少做一半事。（技术债总账 A1，2026-08-04 清偿）
   */
  forfeits?: ReadonlySet<EntityId>;
  /** 地图碰撞几何。默认取 `world.obstacles` */
  obstacles?: readonly Aabb[];

  /** 技能查表。由调用方注入，避免 sim 反向依赖 data 的具体注册表 */
  getSkill: (id: SkillId) => SkillDef | undefined;

  // ── 模式相关，按需传 ──────────────────────────────────────
  /**
   * 夺旗对局才传。★ 竞技场传 undefined —— 与 15.4 两种 HUD 视图不相交同源。
   * `map` 是统计的连续量采样需要的（16.3 的「关键通道控制」读 `MapDef.routes`）。
   */
  ctf?: { state: CtfState; deps: CtfDeps; map: MapDef };
  arena?: ArenaState;
  respawn?: RespawnState;
  /**
   * 随机大 BOSS（房间设置 `bossEnabled` 打开时才有）。规则全在 `sim/boss.ts`。
   *
   * ★ **不传 = 这条玩法整个不存在**（连遍历都没有）—— 与 `swings` / `castQueue`
   *   同一条规矩：默认关的玩法必须默认**结构上**不发生，这样 M1–M16 的
   *   两百多项验收（全都建立在「场上就这么几个人」上）一寸不受影响。
   */
  boss?: BossState;

  /**
   * 传了就折叠战后统计。
   * ★ 折叠发生在 tick **内部**的第 8 步，因为它有顺序约束（见文件头表格）。
   */
  stats?: StatsStore;
}

/** 事件回调。全部可选 —— 服务器要广播、客户端要播特效、测试一个都不需要 */
export interface TickEventSinks {
  cast?: CastEvents;
  /**
   * 技能效果结算**之前**触发。
   * ★ 12.3 / 验收 #40：带旗使用无敌/潜行技能要**先掉旗**再播放技能表现。
   *   M8 抓到的第 2 个 bug 就是客户端从来没调过这条链。
   */
  onBeforeSkillEffects?: (caster: CombatEntity, skill: SkillDef) => void;
  /**
   * 一次施法解算出目标之后、效果结算**之前**触发。
   *
   * ★★ **解算结果是传进来的，调用方不要自己再算一遍。**
   *
   *   `cast.onCompleted` 在效果结算**之后**才触发，那时再调
   *   `resolveCastTargets()` 会得到**不同**的答案 —— 目标可能已经被这一发
   *   技能打死并被 `collectShapeTargets` 过滤掉了，于是「命中 3 个目标」
   *   会显示成 2 个。日志与实际结算对不上是最难解释的一类 bug。
   *
   *   `targetLost`（7.4 步骤 6，锁定目标已离场）时**不触发** ——
   *   那一发不产生效果，也就没有「打中了谁」可言。
   */
  onCastResolved?: (
    caster: CombatEntity,
    skill: SkillDef,
    targets: readonly CombatEntity[],
    groundPoint?: Vec3,
  ) => void;
  arena?: ArenaEvents;
  /** 一个技能/光环/投射物的效果结算完毕 */
  onEffects?: (events: readonly CombatEvent[]) => void;
  onSwap?: (ev: SwapTickEvent) => void;
  onPickup?: (ev: PickupTickEvent) => void;
  onFlag?: (ev: FlagEvent) => void;
  onRespawn?: (ev: RespawnEvent) => void;
  onDeathSettled?: (ev: DeathSettlement) => void;
  /** 一个消耗品被使用（10.1）。客户端据此播表现，服务器据此广播 */
  onConsumable?: (entityId: EntityId, def: ConsumableDef) => void;
  /** 一次普通攻击（7.6）。落空的也会来，`miss` 说明原因 */
  onSwing?: (sw: SwingResult) => void;
}

export interface TickResult {
  /** 本 tick 产生的**全部**战斗事件，按发生顺序 */
  events: CombatEvent[];
  swaps: SwapTickEvent[];
  pickups: PickupTickEvent[];
  flags: FlagEvent[];
  respawns: RespawnEvent[];
  deaths: DeathSettlement[];
  /** 本 tick 的普通攻击（7.6）。落空的也在，miss 字段说明原因 */
  swings: SwingResult[];
  /** 本 tick 被使用的消耗品（10.1）*/
  consumables: { entityId: EntityId; consumableId: ConsumableId }[];
  /** 本 tick 军械点刷出的实体掉落（10.4）。空数组 = 这一 tick 没有补给刷新 */
  drops: GroundDrop[];
  /**
   * 本 tick 的 BOSS 事实（出场 / 狂暴 / 被击杀）。
   * ★ 没开这条玩法、或这一 tick 什么都没发生时为 undefined —— 调用方据此
   *   决定发不发播报。**规则不认识协议**，广播是 MatchLoop 的事。
   */
  boss?: BossTickResult;
}

/**
 * `itemGrants` 结算时挂的来源 id（`resolve` 的 skillId 位）。
 *
 * ★ 不借用某个技能 id：那会让「商店买的满血」在死亡回顾与统计里
 *   显示成一个玩家根本没按过的技能。这是个**道具**来源，如实起个名字。
 */
export const ITEM_GRANT_SOURCE_ID = 'item.grant';

// ════════════════════════════════════════════════════════════════
//  推进
// ════════════════════════════════════════════════════════════════

/**
 * 推进世界一个 tick。
 *
 * ⚠️ **调用方不要自己再调下面任何一个 `tick*()`** —— 那等于绕过本文件的顺序保证。
 *    需要新的一步就加在这里，并在文件头的表格里写明它的约束与出处。
 *
 * `dt` 是本 tick 的时长。★ 服务器用固定的 `SIM.TICK_DT`；
 * 客户端本地模拟也应当用固定步长（`GameLoop` 已经保证了这一点）。
 */
export const tickWorld = (
  deps: TickDeps,
  dt: number,
  sinks: TickEventSinks = {},
): TickResult => {
  const result: TickResult = {
    events: [], swaps: [], pickups: [], flags: [], respawns: [], deaths: [], consumables: [],
    swings: [], drops: [],
  };
  const obstacles = deps.obstacles ?? deps.world.obstacles;

  deps.world.time += dt;

  /** 结算一组效果并把事件并入本 tick 的事件流 */
  const resolve = (
    sourceId: EntityId,
    skillId: string,
    effects: Parameters<typeof resolveEffects>[1],
    targetIds: readonly EntityId[],
    groundPoint?: Vec3,
    opts?: { periodic?: boolean },
  ): void => {
    const source = getEntity(deps.world, sourceId);
    if (!source) return;
    const targets = targetIds
      .map((id) => getEntity(deps.world, id))
      .filter((e): e is NonNullable<typeof e> => e !== undefined);

    const events = resolveEffects(
      {
        world: deps.world, auras: deps.auras, dr: deps.dr,
        projectiles: deps.projectiles, ground: deps.ground,
        castingStore: deps.casting,
        // ★ 位移效果要写它才能不被下一 tick 的移动积分抹回（见 effects/displacement.ts）
        movement: deps.movement,
        source, skillId,
        ...(groundPoint ? { groundPoint } : {}),
        ...(opts?.periodic ? { periodic: true } : {}),
      },
      effects, targets,
    );
    result.events.push(...events);
    sinks.onEffects?.(events);
  };

  /**
   * ★★ **统一的施法完成入口。**
   *   同时传给 `beginCast`（瞬发走这条）与 `tickCasting`（读条走这条）——
   *   见 `TickDeps.castRequests` 的注释，只接一个出口是 M4 踩过的坑。
   */
  const onCastCompleted = (caster: CombatEntity, skill: SkillDef, state: CastState | null): void => {
    // ★ 必须在效果结算**之前** —— 先掉旗，再播放技能表现（12.3 / 验收 #40）
    if (skill.dropsFlagOnUse) sinks.onBeforeSkillEffects?.(caster, skill);

    const r = resolveCastTargets(deps.world, caster, skill, state);
    // 7.4 步骤 6：锁定的目标已离场 → 不产生效果
    if (r.targetLost) return;
    // ★ 必须在 resolve 之前 —— 见 onCastResolved 的注释：结算之后目标集合就变了
    sinks.onCastResolved?.(caster, skill, r.targets, r.groundPoint);
    resolve(caster.id, skill.id, skill.effects, r.targets.map((t) => t.id), r.groundPoint);
  };

  const castEvents: CastEvents = {
    ...sinks.cast,
    onCompleted: (c, s, st) => {
      onCastCompleted(c, s, st);
      sinks.cast?.onCompleted?.(c, s, st);
    },
    /**
     * 7.1「打断/移动/控制停止**剩余引导**」的兑现：引导已经开始结算的
     * （暴风雪已在下雪），把它生成的地面区域当场掐掉 —— 不掐的话打断了
     * 引导雪照下 4 秒，「打断反制封路技能」整条博弈是空谈。
     * 读条期被打断（channelResolved 未置位）无区域可掐，原样透传。
     */
    onInterrupted: (c, st, source) => {
      if (st.kind === CastKind.Channel && st.channelResolved) {
        expireGroundAreasFor(deps.ground, c.id, String(st.skillId), deps.world.time);
      }
      sinks.cast?.onInterrupted?.(c, st, source);
    },
  };

  // ── 0. 弃权判死（11.5：主动退出立即按淘汰处理）──────────────
  /**
   * ★★ 走与 `dealDamage()` 完全相同的死亡表达：`alive = false` + `death` 事件。
   *   于是统计折叠（第 9 步）、胜负判定（第 10 步）、settleDeaths（第 11 步）、
   *   调用方的 Death 广播（onEffects）全部自动跟上 —— 不需要谁记得。
   * ★ killerId 如实缺席：弃权没有凶手，编一个会多记一次击杀、
   *   让击杀播报冤枉一个没打过他的人（与 M16a 的「如实，不编」同则）。
   */
  // ★ 记名单：第 11 步的复活入队要跳过弃权者（淘汰不该被波次复活）
  const forfeited = new Set<EntityId>(deps.forfeits ?? []);
  for (const id of forfeited) {
    const e = getEntity(deps.world, id);
    if (!e || !e.alive) continue;
    e.alive = false;
    e.health = 0;
    const ev: CombatEvent = { t: 'death', targetId: id };
    result.events.push(ev);
    sinks.onEffects?.([ev]);
  }

  // ── 1. applyInputs：技能请求（docs/02 §3 第 1 步）──────────
  for (const [id, intent] of deps.castRequests ?? []) {
    const caster = getEntity(deps.world, id);
    if (!caster || !caster.alive) continue;
    const skill = deps.getSkill(intent.skillId);
    if (!skill) continue;
    if (intent.facing !== undefined) caster.yaw = intent.facing;
    const opts = {
      ...(intent.targetId !== undefined
        ? { target: getEntity(deps.world, intent.targetId) }
        : {}),
      ...(intent.groundPoint ? { groundPoint: intent.groundPoint } : {}),
      events: castEvents,
    };
    /**
     * ★ 分叉只有这一处，而且是**显式开关**驱动的：没带 `queue` 的请求
     *   （人机的每一条、balance-report 的每一条）走的仍然是**同一个**
     *   `beginCast()` 调用，一个字节的行为差异都没有。见 `CastIntent.queue`。
     */
    if (intent.queue === true && deps.castQueue) {
      beginCastOrQueue(deps.world, deps.casting, deps.castQueue, caster, skill, opts);
    } else {
      beginCast(deps.world, deps.casting, caster, skill, opts);
    }
  }

  // ── 1b. 消耗品使用（10.1）。与技能请求同属「applyInputs」───
  for (const [id, slot] of deps.consumableRequests ?? []) {
    const user = getEntity(deps.world, id);
    const loadout = deps.loadouts.get(id);
    if (!user || !loadout) continue;
    const consumableId = takeConsumable(user, loadout, slot);
    if (consumableId === undefined) continue;
    const def = getConsumable(consumableId as string);
    if (!def) continue;

    resolve(id, def.id as string, def.effects, [id]);
    /**
     * ★ 16.2「增益期间击杀」的窗口就在这里登记。
     *   `recordItemBuff()` 从 M9 起就留着这个入口，但在此之前
     *   **没有任何调用方** —— 于是 `killsDuringBuff` 结构上恒为 0
     *   （已登记为已知偏差 #2）。接上之后它才有真实来源。
     */
    if (deps.stats) recordItemBuff(deps.stats, id, deps.world.time + def.buffSeconds);
    if (def.cooldown > 0) user.cooldowns.set(def.id as never, deps.world.time + def.cooldown);
    result.consumables.push({ entityId: id, consumableId });
    sinks.onConsumable?.(id, def);
  }

  /**
   * ── 1b'. 道具兑换的即时效果（P13 大乱斗商店）。同属「applyInputs」──
   *
   * ★ 与 1b 隔一步而不是并进去：消耗品要先从装备栏里**取出来**
   *   （`takeConsumable` 有它自己的死亡/硬控判定），而兑换在买的那一刻
   *   就已经付过账了 —— 两者的前置条件不同，合成一段会让其中一套失效。
   * ★ 死人不结算：买完到 tick 之间被打死属正常时序，效果作废（钱不退，
   *   与消耗品「用了一半被打死」同口径）。
   */
  for (const [id, effects] of deps.itemGrants ?? []) {
    const e = getEntity(deps.world, id);
    if (!e || !e.alive) continue;
    resolve(id, ITEM_GRANT_SOURCE_ID, effects, [id]);
  }

  // ── 1c. 通用解控「战斗意志」（8.3，技术债总账 W8）────────────
  /**
   * ★ **刻意不查任何控制状态** —— 8.3「默认允许在昏迷中使用」，
   *   解控就是为昏迷造的；这正是它与技能请求（被昏迷/沉默挡）的本质区别。
   * ★ **按下即进冷却，无论解没解掉**：只有命中才进冷却的话，R 连点宏
   *   等于「自动解掉第一个可解控制」，「什么时候交解控」这层博弈就没了 ——
   *   与 7.5 假读条骗打断同属本作要保的决策深度。误按的代价由客户端的
   *   冷却预检挡第一层（它读 self 快照的 cooldowns，见 TRINKET_COOLDOWN_KEY）。
   */
  for (const id of deps.trinketRequests ?? []) {
    const e = getEntity(deps.world, id);
    if (!e || !e.alive) continue;
    if (deps.world.time < (e.cooldowns.get(TRINKET_COOLDOWN_KEY) ?? 0)) continue;
    e.cooldowns.set(TRINKET_COOLDOWN_KEY, deps.world.time + PVP_TRINKET.COOLDOWN);
    const evs: CombatEvent[] = [];
    useTrinket({ world: deps.world, auras: deps.auras, dr: deps.dr }, e, evs);
    if (evs.length > 0) {
      result.events.push(...evs);
      sinks.onEffects?.(evs);
    }
  }

  // ── 2. movement ─────────────────────────────────────────────
  // ★ 只推进 deps.movement 里有条目的实体。没有条目 = 位置由别处驱动
  /**
   * ★ P1（技术债总账）：实体列表是本循环的**不变量**（movement 不增删实体），
   *   提出来 —— 此前每个移动实体各 spread 一次全体，24 人 = 48 数组/tick。
   *   `o.position` 仍逐次现读（前一个实体这一步挪过的位置要被后一个看到），
   *   行为逐位不变。⚠️ 不跨步骤共享这个数组：第 3–5 步的效果可能**生成**
   *   新实体，那几步的 listEntities 必须现取。
   */
  const movementEntities = listEntities(deps.world);
  /**
   * ★ P11：软推开的 `others` 数组同样是每实体一个的短命分配（24 人 =
   *   24 数组/tick × 20Hz × 房间数）。提出来复用，每个实体开始时清空 ——
   *   `separationVelocity` 当场读完返回一个 Vec3，不持有数组引用，复用安全。
   */
  const separationOthers: Vec3[] = [];
  for (const [id, state] of deps.movement) {
    const e = getEntity(deps.world, id);
    if (!e || !e.alive) continue;
    /**
     * ★★ 没有输入条目 ≠ 免除物理。此前这里是 `continue` —— 整个积分跳过，
     *   不吃重力、不被软推开，而正确性寄托在「联网客户端每 tick 都发输入
     *   （哪怕全零）」的自觉上：停发 Input 的客户端可以悬停在空中、
     *   单向卡位（别人推不动他，他还占着地方）。不受信任的输入不该被
     *   这样假设。（技术债总账 A2，2026-08-04 清偿）
     *
     *   现在缺输入按**全零输入**积分：不走、不跳、朝向保持当前值 ——
     *   重力、速度衰减、软推开照常。「没登记 movement 条目的实体不参与
     *   移动」这条边界**不变**（假人与场景驱动的实体仍然靠它跳过）。
     */
    const input = deps.inputs.get(id)
      ?? { forward: 0, strafe: 0, jump: false, yaw: state.yaw };
    /**
     * ★★ `speedMultiplier` 此前**没有传** —— 于是断筋、冰霜锁链、群奔咆哮、
     *   猎豹形态、死亡脚步的速度下限、12.3 的旗手加速上限，
     *   **一条都没有影响过实际移动**。数据在、聚合在、单测也绿，就是没人调用。
     * ★ 这里读的是**上一 tick 末**的光环状态（movement 是第 2 步、光环推进在第 4 步）。
     *   与 `deriveStatusFlags` 在第 7 步同理：本 tick 新挂的减速下一 tick 才生效，
     *   差一个 50ms 的 tick，可接受且确定性。
     */
    /**
     * ★★ 13.5 / 验收 #43 的软推开（`separationVelocity` 此前**零调用方**，
     *   又一条「写好了没接线」：角色可以完全重叠站成一个点）。
     *   对**所有**其他存活实体算 —— 包括没有移动条目的（站桩假人也占地方）。
     * ★ A2 之后不再要求输入条目：有 movement 条目就积分（缺输入按全零），
     *   「停发输入换免推开」的豁免窗口不存在了。
     */
    separationOthers.length = 0;
    for (const o of movementEntities) {
      if (o.id !== id && o.alive) separationOthers.push(o.position);
    }
    const r = stepMovement(state, input, dt, obstacles, {
      radius: e.radius,
      height: e.height,
      speedMultiplier: moveSpeedMultiplierOf(deps.auras, e, deps.world.time),
      /**
       * ★ 定身/昏迷的移动锁。与 speedMultiplier 同理读的是**上一 tick 末**
       *   的 flags（deriveStatusFlags 在第 7 步），差一个 tick，确定性。
       */
      lock: movementLockOf(e.flags),
      separation: separationVelocity(state.position, separationOthers, e.radius),
    });
    deps.movement.set(id, r.state);
    e.position = r.state.position;
    e.yaw = r.state.yaw;
  }

  // ── 3. casting 推进（必须在 movement 之后 —— 7.3）──────────
  tickCasting(deps.world, deps.casting, { getSkill: deps.getSkill, events: castEvents });

  // ── 3b. 施法排队窗消费（P10 / 合同 C5）──────────────────────
  /**
   * ★ **必须紧跟在第 3 步之后**：本 tick 刚读完的那一条读条要能被排队的下一发
   *   当场接上，中间不隔一个 tick（隔了就等于把排队窗省下的提前量还回去）。
   * ★ 位置带来的一处**如实**差异：排队放出的瞬发技能，效果结算发生在
   *   移动之后（这里），而第 1 步直接放的发生在移动之前。差一个 tick 内的
   *   次序，只影响 opt-in 的排队路径 —— 不带 `queue` 的一切照旧。
   * ⚠️ `deps.castQueue` 不存在时这一步整个不发生（连遍历都没有），
   *   所以人机局与 balance-report 的 tick 结构与改动前完全一致。
   */
  if (deps.castQueue) {
    tickCastQueue(deps.world, deps.casting, deps.castQueue, {
      getSkill: deps.getSkill, events: castEvents,
    });
  }

  // ── 4. auras ────────────────────────────────────────────────
  // ★ periodic：DoT/HoT 的周期跳不暴击（见 combat.ts rollCrit 的注释）
  for (const t of tickAuras(deps.auras, deps.world.time).ticks) {
    resolve(t.sourceId, t.aura.def.id, t.effects, [t.targetId], undefined, { periodic: true });
  }

  // ── 5. projectiles ──────────────────────────────────────────
  for (const hit of tickProjectiles(deps.world, deps.projectiles, dt)) {
    resolve(
      hit.projectile.sourceId,
      String(hit.projectile.skillId),
      hit.effects,
      hit.targets.map((t) => t.id),
    );
  }

  // ── 6. groundAreas ──────────────────────────────────────────
  // ★ periodic：站在区域里的逐 tick 结算同样不暴击
  for (const g of tickGround(deps.world, deps.ground)) {
    resolve(g.sourceId, g.skillId, g.effects, g.targets.map((t) => t.id), undefined, { periodic: true });
  }

  // ── 6b. 普通攻击（7.6）────────────────────────────────────
  /**
   * ★ 排在效果结算这一组的**最后**、`deriveStatusFlags` 之前：
   *   它要读的是本 tick 已经生效的控制（缴械/昏迷挡普攻，8.1），
   *   而那些标志是上一 tick 末尾派生的 —— 与 casting 读 flags 同一时序。
   */
  if (deps.swings) {
    for (const sw of tickSwings(
      { world: deps.world, auras: deps.auras, swings: deps.swings },
      deps.world.time,
    )) {
      result.swings.push(sw);
      if (sw.effects && sw.targetId !== undefined) {
        resolve(sw.attackerId, 'autoAttack', sw.effects, [sw.targetId]);
      }
      sinks.onSwing?.(sw);
    }
  }

  // ── 6c. 资源回复（9.x 资源表的 regenPerSecond）──────────────
  /**
   * ⚠️ M14 之前这一步**不存在**：`regenPerSecond` 写在每个职业的资源表里、
   *   数据体检也校验它 ≥ 0，但全 sim 零读取方 —— 第六个死 schema。
   *   实际后果：所有职业都在用「开局资源池 + 白字」打完整场，
   *   焦点猎人放完三个技能就永久哑火（配平诊断：焦点全场钉死在 10）。
   * ★ 只回存活者；封顶由 `gainResource` 负责；怒气 regen=0 天然不受影响
   *   （怒气来源是挥击与技能，见 6b 与 COMBAT_SWING）。
   */
  // ★ P11：本步与第 7 步之间没有实体增删，共享一次 listEntities（分配减半）。
  //   第 3–5 步会生成实体的警告（movementEntities 的 ⚠️）不适用于这两步之间
  const settledEntities = listEntities(deps.world);
  for (const e of settledEntities) {
    if (!e.alive) continue;
    for (const [r, rate] of e.resourceRegen) gainResource(e, r, rate * dt);
  }

  // ── 7. deriveStatusFlags ────────────────────────────────────
  // ★ 必须在全部光环变动之后，否则本 tick 新加的控制要等下一 tick 才生效。
  //   也必须在第 7 步之前 —— swaps/pickups 读 flags.stunned
  for (const e of settledEntities) {
    e.flags = deriveStatusFlags(deps.auras, e);
  }

  // ── 8. swaps + pickups（读 flags；发 result:'death' 事件）───
  for (const ev of tickSwaps(deps.world.entities, deps.swaps, deps.world.time)) {
    result.swaps.push(ev);
    sinks.onSwap?.(ev);
  }
  for (const ev of tickPickups(
    deps.world.entities, deps.loadouts, deps.arsenal, deps.pickups, deps.world.time,
  )) {
    result.pickups.push(ev);
    sinks.onPickup?.(ev);
  }

  // ── 8b. 军械点刷新（10.4）────────────────────────────────────
  /**
   * ★★ 在此之前**没有这一步**：`setupArmories()` 与 `spawnDropsFromRoster()`
   *   在真实对局里一次都没被调用过，于是整个 M6 的「抢装备」只活在单测里
   *   （PROGRESS 记的是「客户端接线未做」，实际连服务器都没在刷货）。
   *
   * ★ 放在拾取**之后**：本 tick 的拾取先按当前地面状态结算完，补给点再刷新。
   *   反过来的话，正在被拾取的那件东西可能在同一 tick 里被新一轮清掉 ——
   *   玩家会看到进度条走满却什么都没拿到。
   *   （即便如此仍有一个边角：跨 tick 的拾取撞上刷新会收到 `'taken'`。
   *   语义略偏「被别人抢走了」，但 10.5 要求的「明确失败反馈」是满足的。）
   *
   * ★ 职业池从**世界**推导，不从房间名单 —— 10.4 要的是「当前房间实际存在
   *   的职业池」，而世界里的实体就是那份事实（观战者不在世界里，天然不算）。
   */
  if (deps.arsenal.enabled) {
    const roster = rosterClassesOf(deps.world);
    const spawned = tickArsenal(deps.arsenal, roster, deps.world.time);
    if (spawned.length > 0) result.drops.push(...spawned);
    /**
     * ★ 大乱斗的派对掉落（`arsenal.party` 有值时才有）。与军械点**并列**
     *   而不是二选一：军械点是「两队对称争夺的补给点」，派对掉落是
     *   「满地随机刷的玩具」，两套规则互不干扰（见 `armoryLayoutFor` 的
     *   default 分支注释）。当前只有 FFA 地图会装上它。
     */
    const party = tickPartyDrops(deps.arsenal, deps.world.time);
    if (party.length > 0) result.drops.push(...party);
  }

  // ── 9. 统计折叠（必须在 matchRules 之前 —— 见文件头）─────
  if (deps.stats) {
    ingestCombatEvents(deps.stats, deps.world, result.events, deps.world.time);
    ingestSwapEvents(deps.stats, result.swaps);
    ingestPickupEvents(
      deps.stats, deps.world, result.pickups,
      (dropId) => deps.arsenal.drops.find((d) => d.id === dropId)?.kind,
      deps.world.time,
    );
  }

  // ── 10. matchRules（必须在 movement 与死亡之后）─────────────
  if (deps.ctf) {
    for (const ev of tickFlags(deps.ctf.state, deps.ctf.deps, deps.world.time)) {
      result.flags.push(ev);
      sinks.onFlag?.(ev);
    }
    if (deps.stats) ingestFlagEvents(deps.stats, result.flags);
    /**
     * ★★ A17：**`setOvertime()` 的第一个消费方。** 12.6 规定加时把复活波次
     *   从 12 秒放到 16 秒，这条规则从 M7 起就写好了、一直没有人调用。
     *
     * ★ 位置在 `tickRespawn` **之前**：`setOvertime` 会把正在倒计时的那一波
     *   按新间隔重排（它自己的注释：不让切换瞬间白送一次复活），放到后面
     *   等于本 tick 先按旧间隔发一波车再改时刻表。
     * ★ 每 tick 无脑调是安全的 —— 间隔没变时 `setOvertime` 直接早退，
     *   所以它只在「进/出加时」的那一 tick 真正动状态。
     */
    if (deps.respawn) setOvertime(deps.respawn, ctfInOvertime(deps.ctf.state), deps.world.time);
  }
  if (deps.respawn) {
    for (const ev of tickRespawn(deps.respawn, deps.world, deps.auras, deps.world.time)) {
      /**
       * ★★ 复活必须**同时写 movement 状态**（W12 接线时抓到的真 bug）。
       *   `tickRespawn` 只写 `e.position`，而联网局里位置由第 2 步的移动积分
       *   从 `MovementState` 驱动 —— 不写的话下一 tick 就把人**拽回死点**。
       *   与位移效果同一条老坑（见上面 `resolve()` 的 movement 注释），
       *   同一个修法：`teleportTo`，顺带置 13.4 的 teleported 标记，
       *   客户端插值/预测按瞬移处理而不是滑一条 80 米的直线。
       */
      const ms = deps.movement.get(ev.entityId);
      if (ms) deps.movement.set(ev.entityId, teleportTo(ms, ev.position, obstacles));
      result.respawns.push(ev);
      sinks.onRespawn?.(ev);
    }
  }
  if (deps.arena) {
    tickArena(
      deps.arena,
      {
        world: deps.world, auras: deps.auras, dr: deps.dr, ground: deps.ground,
        // 回合重置要清弹体仓 —— 见 arena.ts 的 resetRound
        projectiles: deps.projectiles,
      },
      dt,
      sinks.arena ?? {},
    );
  }

  // ── 11. settleDeaths（必须在 swaps/pickups 之后 —— 17.3）───
  for (const ev of settleDeaths(
    { world: deps.world, loadouts: deps.loadouts, swaps: deps.swaps, pickups: deps.pickups },
    result.events,
  )) {
    result.deaths.push(ev);
    sinks.onDeathSettled?.(ev);
    /**
     * ★★ 12.6 复活波次的**入队**（W12 接线时抓到的真 bug）：
     *   `enqueueRespawn` 自 M7 起在生产路径**零调用** —— `tickRespawn`
     *   每 12 秒醒来一次，pending 永远是空的，联网夺旗里死了就永远躺着
     *   （M7 的验收是测试夹具手工入队的，规则对、没人接线，老教训又一次）。
     *   排除两类：宠物（12.6 是**玩家**的波次复活；宠物随主人技能重召）、
     *   本 tick 弃权的（11.5 淘汰 = 退出比赛，波次不该把他复活成无主僵尸）。
     *   入队在 tickRespawn（第 10 步）**之后**：本 tick 死的赶下一波，
     *   不在死亡瞬间搭上正在发车的这一波。
     */
    if (deps.respawn) {
      const dead = getEntity(deps.world, ev.entityId);
      /**
       * ★ BOSS 排除在波次复活之外：12.6 是**玩家**的复活波次，把一只中立
       *   BOSS 送进红/蓝任一方的墓地出口是没有意义的（它根本没有队伍墓地）。
       *   它的「复活」是 `sim/boss.ts` 的 105 秒重刷，两套机制不该串线。
       */
      const isBoss = deps.boss?.activeId === ev.entityId;
      if (dead && !dead.isPet && !isBoss && !forfeited.has(ev.entityId)) {
        enqueueRespawn(deps.respawn, ev.entityId, deps.world.time);
      }
    }
  }

  // ── 10b. BOSS（必须在 settleDeaths 之后 —— 见文件头表格）───
  /**
   * ★ 传本 tick 的**全部**事件：`tickBoss` 要从里面挑出 BOSS 的那条 `death`
   *   来认最后一击者 —— 与统计、击杀播报读同一个来源，不另立一份真相。
   */
  if (deps.boss) {
    const bossResult = tickBoss(
      deps.boss,
      {
        world: deps.world, movement: deps.movement,
        auras: deps.auras, arsenal: deps.arsenal,
      },
      result.events,
      deps.world.time,
    );
    if (bossResult.spawned || bossResult.slain || bossResult.enraged !== undefined) {
      result.boss = bossResult;
    }
    if (bossResult.slain) result.drops.push(...bossResult.slain.drops);
  }

  // ── 12. 统计的连续量采样 + 清理失效目标 ─────────────────────
  if (deps.stats) {
    sampleTick(
      deps.stats,
      deps.ctf ? { world: deps.world, ctf: { state: deps.ctf.state, map: deps.ctf.map } } : { world: deps.world },
      dt,
    );
  }
  for (const e of listEntities(deps.world)) {
    if (!e.isPet) pruneInvalidTargets(deps.world, e);
  }

  return result;
};

/**
 * 10.4「当前房间实际存在的职业池」。
 *
 * ★ 从**世界**推导而不是从房间名单：观战者不在世界里（`setup.ts` 的
 *   `spawnPlayer` 直接跳过他们），所以「刷出一件观战者职业的装备」
 *   在这里写不出来。
 * ★ **包含已死亡的玩家**：竞技场里死人会在下一回合回来，按他的职业刷货是对的；
 *   排除他等于「队友一死，你就再也捡不到自己的装备」。
 * ★ 宠物不算 —— 10.2：宠物不能拾取、占用或阻挡道具。
 */
const rosterClassesOf = (world: World): ClassId[] => {
  const seen = new Set<ClassId>();
  for (const e of listEntities(world)) {
    if (e.isPet) continue;
    seen.add(e.classId);
  }
  return [...seen];
};
