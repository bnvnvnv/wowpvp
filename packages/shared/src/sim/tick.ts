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
import type { SkillDef } from '../data/schema.js';
import type { MapDef } from '../data/maps/schema.js';
import type { EntityId, SkillId } from '../types/ids.js';
import type { Vec3 } from '../math/vec3.js';
import type { CombatEntity } from './entity.js';
import { deriveStatusFlags, tickAuras, type AuraStore } from './aura.js';
import { beginCast, tickCasting, type CastEvents, type CastState, type CastingStore } from './casting.js';
import { resolveCastTargets } from './castResolve.js';
import type { DrStore } from './dr.js';
import { settleDeaths, type DeathSettlement } from './death.js';
import { resolveEffects, type CombatEvent } from './effects/index.js';
import { tickGround, type GroundStore } from './groundArea.js';
import { tickPickups, type ArsenalStore, type PickupStore, type PickupTickEvent } from './arsenal.js';
import { takeConsumable, tickSwaps, type LoadoutStore, type SwapStore, type SwapTickEvent } from './loadout.js';
import { tickArena, type ArenaEvents, type ArenaState } from './match/arena.js';
import { tickFlags, type CtfDeps, type CtfState, type FlagEvent } from './match/flag.js';
import { tickRespawn, type RespawnEvent, type RespawnState } from './match/respawn.js';
import {
  stepMovement, type MovementInput, type MovementState,
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

/** 一次技能请求的意图。★ 只有意图，没有结果 —— 与网络协议同源 */
export interface CastIntent {
  skillId: SkillId;
  targetId?: EntityId;
  groundPoint?: Vec3;
  /** 方向技能的朝向。不传则用施法者当前 yaw */
  facing?: number;
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
   * 本 tick 每个实体要使用的消耗品槽位（10.1）。
   *
   * ★★ 和技能请求同理：**消耗品的效果也必须由 tick 结算**。
   *   调用方自己调 `resolveEffects()` 就开出了第二个结算出口 ——
   *   而 A2 的教训正是「第二个出口会静默地少做一半事」。
   */
  consumableRequests?: ReadonlyMap<EntityId, number>;
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
}

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
    swings: [],
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
        source, skillId,
        ...(groundPoint ? { groundPoint } : {}),
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
  };

  // ── 1. applyInputs：技能请求（docs/02 §3 第 1 步）──────────
  for (const [id, intent] of deps.castRequests ?? []) {
    const caster = getEntity(deps.world, id);
    if (!caster || !caster.alive) continue;
    const skill = deps.getSkill(intent.skillId);
    if (!skill) continue;
    if (intent.facing !== undefined) caster.yaw = intent.facing;
    beginCast(deps.world, deps.casting, caster, skill, {
      ...(intent.targetId !== undefined
        ? { target: getEntity(deps.world, intent.targetId) }
        : {}),
      ...(intent.groundPoint ? { groundPoint: intent.groundPoint } : {}),
      events: castEvents,
    });
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

  // ── 2. movement ─────────────────────────────────────────────
  // ★ 只推进 deps.movement 里有条目的实体。没有条目 = 位置由别处驱动
  for (const [id, state] of deps.movement) {
    const e = getEntity(deps.world, id);
    if (!e || !e.alive) continue;
    const input = deps.inputs.get(id);
    if (!input) continue;
    const r = stepMovement(state, input, dt, obstacles, { radius: e.radius, height: e.height });
    deps.movement.set(id, r.state);
    e.position = r.state.position;
    e.yaw = r.state.yaw;
  }

  // ── 3. casting 推进（必须在 movement 之后 —— 7.3）──────────
  tickCasting(deps.world, deps.casting, { getSkill: deps.getSkill, events: castEvents });

  // ── 4. auras ────────────────────────────────────────────────
  for (const t of tickAuras(deps.auras, deps.world.time).ticks) {
    resolve(t.sourceId, t.aura.def.id, t.effects, [t.targetId]);
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
  for (const g of tickGround(deps.world, deps.ground)) {
    resolve(g.sourceId, g.skillId, g.effects, g.targets.map((t) => t.id));
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

  // ── 7. deriveStatusFlags ────────────────────────────────────
  // ★ 必须在全部光环变动之后，否则本 tick 新加的控制要等下一 tick 才生效。
  //   也必须在第 7 步之前 —— swaps/pickups 读 flags.stunned
  for (const e of listEntities(deps.world)) {
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
  }
  if (deps.respawn) {
    for (const ev of tickRespawn(deps.respawn, deps.world, deps.auras, deps.world.time)) {
      result.respawns.push(ev);
      sinks.onRespawn?.(ev);
    }
  }
  if (deps.arena) {
    tickArena(
      deps.arena,
      { world: deps.world, auras: deps.auras, dr: deps.dr, ground: deps.ground },
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
