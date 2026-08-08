/**
 * 随机刷新的中立大 BOSS。玩家需求原话：
 * 「地图里随机刷新一些大 BOSS，打死之后掉落装备；BOSS 很强不容易打死，
 *   且很容易几下秒杀玩家。」
 *
 * ★★ **本文件是这条玩法的全部规则；`MatchLoop` 只负责接线与广播。**
 *   与 `match/arena.ts` / `match/flag.ts` 同级 —— 想调刷新节奏、赏金、
 *   掉落件数，只有这一个文件要改。
 *
 * ── 三条设计约束，每条都有对应的实现选择 ───────────────────────
 *
 *   1. **BOSS 是一个普通实体，不是一套新系统。**
 *      它是 `TEAM_NEUTRAL` 的 `CombatEntity`，于是移动积分、施法的两个出口、
 *      光环、普攻、可见性裁剪、快照下发、死亡漏斗、统计事件流全部**自动**
 *      对它成立 —— 本文件一行都没有重写它们。`isFriendly()` 对任何玩家都
 *      为假，所以「人人可打、人人被打」不需要一条特判：中立队伍天然如此。
 *
 *   2. **BOSS 不进任何名单。**
 *      不进 `room.players`（`canStart` 因此不认识它）、不进 `stats.players`
 *      （战后面板不会多出一行「熔岩魔王」，它的击杀数也进不了「先到 N 杀」
 *      的胜负判定）、不进 `ALL_CLASSES`（选人界面选不到）。
 *      它**只**存在于 world 里。
 *
 *   3. **它的行为由人机驱动，走与真人相同的输入通道。**
 *      服务器给它开一个 `BotSocket` 席位（见 `server/BotDriver.ts` 的文件头
 *      与 `RoomServer.attachBossSeat`）—— 也就是说 BOSS 的每一次移动与施法
 *      都是一条经过 codec 校验的协议消息。本文件因此**不产生任何行为**，
 *      只管「什么时候出现、什么时候狂暴、死了之后发生什么」。
 */

import { GEOMETRY } from '../constants/combat.js';
import { boss as bossClass, BOSS_ENRAGE_AURA } from '../data/classes/boss.js';
import type { MapDef } from '../data/maps/schema.js';
import type { Vec3 } from '../math/vec3.js';
import { TEAM_NEUTRAL, type ClassId, type EntityId } from '../types/ids.js';
import { applyAura, clearAuras, type AuraStore } from './aura.js';
import {
  spawnDropsFromRoster, spreadOnRing,
  type ArsenalStore, type GroundDrop,
} from './arsenal.js';
import { createEntity, type CombatEntity } from './entity.js';
import type { CombatEvent } from './effects/registry.js';
import { createMovementState, type MovementState } from './movement.js';
import { addEntity, allocEntityId, listEntities, type World } from './world.js';

// ════════════════════════════════════════════════════════════════
//  数值
// ════════════════════════════════════════════════════════════════

/**
 * ⚠️ **全部是占位值，未经配平实测。** 每一条都写了取值理由 ——
 * 上一次没写，结果 19 处伤害数字的由来在代码里完全找不到（PROGRESS 技术债 §2）。
 */
export const BOSS = {
  /**
   * 开局到第一只出现的秒数。取 60：足够让一场遭遇战打完一轮、双方各自
   * 分散开，BOSS 出现才是「战局里插进来的第三方」而不是开局撞脸。
   */
  FIRST_SPAWN_SECONDS: 60,
  /**
   * 被击杀到下一只出现的秒数。取 105（需求给的 90–120 的中值）：
   * 比一轮完整的团战 + 复活跑图略长，于是「BOSS 快出了」是一个值得**提前
   * 布置**的时间点，而不是一个随时可能打断当前战斗的骚扰。
   */
  RESPAWN_SECONDS: 105,
  /**
   * 最后一击的赏金。取 500 —— 大乱斗一次普通击杀是 100 分档，
   * 也就是「一只 BOSS ≈ 五个人头」：值得全场为它转火，但抢不到也不至于
   * 一次翻盘。★ 记的是**最后一击**：与击杀记分同一口径，不另发明助攻分。
   */
  KILL_BOUNTY: 500,
  /** 狂暴血线。30%：肉眼可读（血条最后三分之一），也给收尾留出容错 */
  ENRAGE_HEALTH_PCT: 0.3,
  /**
   * 战利品摊开的半径，米。必须明显大于 `RANGE.INTERACT`(2.2) 的一半、
   * 又小到一次能全捡完 —— 2.6 米让几件东西各自可选而不互相盖住。
   */
  DROP_RING_RADIUS: 2.6,
  /** 刷新点到地图中心的距离占**半个场地**的比例。0.45 = 中央与外圈之间 */
  SITE_RADIUS_RATIO: 0.45,
} as const;

// ════════════════════════════════════════════════════════════════
//  状态
// ════════════════════════════════════════════════════════════════

export interface BossState {
  /**
   * 下一只出现的时刻（绝对秒）。★ 存**时刻**而不是「还剩几秒」：
   * 与军械点的 `availableAt` 同一条理由 —— 倒计时要靠每 tick 递减维护，
   * 漏一次就永远不刷；时刻是自然幂等的，而且客户端拿它就能画倒计时。
   */
  nextSpawnAt: number;
  /** 场上那一只。★ 同时最多一只（需求原话），`undefined` = 现在没有 */
  activeId?: EntityId;
  /** 已经刷过几只。同时是刷新点游标 —— 见 `nextBossSite` */
  spawned: number;
  slain: number;
  /** 当前这只是否已经狂暴（换一只重置）*/
  enraged: boolean;
  /**
   * 击杀赏金账本：实体 → 累计赏金。
   *
   * ★★ **本文件自己记账，不去 import 任何模式的记分模块。**
   *   大乱斗的积分、竞技场的回合分、夺旗的旗分是三套东西，而 BOSS 三种模式
   *   里都能开。让它认识其中一种，另外两种就要么少记账、要么在这里长出
   *   `if (模式)` 分支。现在的形状是「BOSS 只说**谁拿了多少赏金**」，
   *   哪个模式要把它折进自己的记分板，由那个模式的接线处决定。
   *
   * ⚠️ **当前唯一的消费者是击杀播报**（`BossEvent.bounty` → 战斗日志的
   *   「赏金 500」）。竞技场与夺旗都没有「个人积分」这个概念，所以这份账
   *   现在只被看见、还没有被花掉 —— 如实记在这里，不假装它已经接进了
   *   哪个记分板。真正把它折成积分的那个模式（大乱斗）落地时，
   *   接线点就是这一张表。
   */
  bounties: Map<EntityId, number>;
  /** 刷新点。开局从地图算一次（见 `bossSpawnSites`）*/
  sites: readonly Vec3[];
}

/**
 * 刷新点：地图中央 + 两对对称的外围点，**去掉压在建筑里的**。
 *
 * ★★ **公平性靠「成对增删」保证。** 与军械点的布置同一条理由（10.4 / 11.3
 *   「双方到达距离必须大体相等」）：BOSS 是争夺目标，刷在离一方更近的位置
 *   等于送分。所以下面过滤的单位是**一对**（±X 或 ±Z）而不是单个点 ——
 *   一端被柱子占住就整对丢掉。只丢那一端的话，剩下的那个点会**偏向一方**，
 *   而这种不公平极难发现：它只在某张图的某个刷新点上出现。
 *
 * ★ 坐标从 `map.bounds` 算，不写死 —— 换地图就该跟着变（与 `ctfDepsOf`
 *   从地图数据导出夺旗判据同源）。
 *
 * ⚠️ **这个过滤不是防御性编程，是修一个实测到的 bug**：竞技场的地图中央
 *   立着一段 3 米高的矮墙（`center_wall`），第一版把 BOSS 直接刷在了墙里 ——
 *   它卡在墙中，玩家站在旁边**打不到它**（视线被自己脚下的墙挡住），
 *   而表现是「BOSS 出来了但打不动」，没有任何报错。
 */
export const bossSpawnSites = (map: MapDef): Vec3[] => {
  const { min, max } = map.bounds;
  const cx = (min.x + max.x) / 2;
  const cz = (min.z + max.z) / 2;
  /**
   * ★ 地面高度取**地图数据里的出生点**，不是 `bounds.min.y` ——
   *   后者是「掉出地图」的判定下界（竞技场 -5、夺旗 -20），拿它当地面
   *   会让 BOSS 刷在地板下面，然后靠重力**往上**弹（弹不上来）。
   */
  const y = groundYOf(map);
  const r = Math.min(max.x - min.x, max.z - min.z) / 2 * BOSS.SITE_RADIUS_RATIO;

  const center = { x: cx, y, z: cz };
  const pairs: [Vec3, Vec3][] = [
    [{ x: cx + r, y, z: cz }, { x: cx - r, y, z: cz }],
    [{ x: cx, y, z: cz + r }, { x: cx, y, z: cz - r }],
  ];

  const sites: Vec3[] = [];
  if (!isOccupied(center, map)) sites.push(center);
  for (const [a, b] of pairs) {
    if (!isOccupied(a, map) && !isOccupied(b, map)) sites.push(a, b);
  }
  /**
   * ⚠️ 一个都不剩时退回中央：**宁可刷在墙边，也不要「BOSS 永远不出现」**。
   *   空数组会让 `nextBossSite` 退化成原点，而那正是最可能被占住的地方；
   *   更糟的是这种失败完全静默。地图密到连一个点都空不出来时，
   *   该改的是地图或这里的半径系数，而不是让玩法悄悄消失。
   */
  return sites.length > 0 ? sites : [center];
};

/** 这个落脚点是否被地图建筑占着（脚下这一格有挡路的体积）*/
const isOccupied = (p: Vec3, map: MapDef): boolean => {
  const pad = GEOMETRY.HITBOX_RADIUS;
  return map.geometry.some((v) => {
    // 地板不算「占着」—— 它的顶面正是站的地方
    if (v.blocksMovement === false) return false;
    if (v.max.y <= p.y + 0.2) return false;
    if (v.min.y >= p.y + GEOMETRY.HITBOX_HEIGHT) return false;
    return (
      p.x >= v.min.x - pad && p.x <= v.max.x + pad &&
      p.z >= v.min.z - pad && p.z <= v.max.z + pad
    );
  });
};

const groundYOf = (map: MapDef): number => {
  const spawn =
    (map.prepRooms ?? []).flatMap((r) => r.spawns)[0] ??
    (map.graveyards ?? []).flatMap((g) => g.spawns)[0];
  return spawn?.position.y ?? 0;
};

export const createBossState = (map: MapDef, now = 0): BossState => ({
  nextSpawnAt: now + BOSS.FIRST_SPAWN_SECONDS,
  spawned: 0,
  slain: 0,
  enraged: false,
  bounties: new Map(),
  sites: bossSpawnSites(map),
});

// ════════════════════════════════════════════════════════════════
//  调度（纯函数）
// ════════════════════════════════════════════════════════════════

/**
 * 这一刻该不该刷一只。**纯函数** —— 刷新节奏因此可以脱离 world 单测。
 * ★ 两个条件缺一不可：场上没有（同时最多一只）、到时刻了。
 */
export const bossSpawnDue = (s: BossState, now: number): boolean =>
  s.activeId === undefined && now >= s.nextSpawnAt;

/**
 * 下一只刷在哪。**纯函数**，按 `spawned` 轮转。
 *
 * ★★ 「随机刷新」的**随机**落在刷新点的轮转上，而不是 `Math.random()`：
 *   整个 `packages/shared` 的确定性是客户端重放、`pnpm balance` 可复现、
 *   将来回放三样东西的地基（见 `world.ts` 的 seed 注释）。玩家要的是
 *   「不知道下一只在哪」，而按点轮转 + 105 秒间隔已经足够做到这一点 ——
 *   没必要为此赔掉确定性。
 */
export const nextBossSite = (s: BossState): Vec3 => {
  const site = s.sites[s.spawned % Math.max(1, s.sites.length)];
  return site ? { ...site } : { x: 0, y: 0, z: 0 };
};

/**
 * 距离下一只还有几秒（场上已经有一只时为 undefined）。**纯函数**。
 *
 * ⚠️ **已知缺口：它目前只有测试在调。** 「BOSS 还有 30 秒出」是玩家应该
 *   看得到的战术信息（与军械点的 5 秒预告同类，10.4），但快照里还没有
 *   BOSS 字段 —— 补它要动 `MatchSnapshot` 与裁剪层。如实记在这里，
 *   不假装这条已经通到 HUD 了。玩家现在只在**出场那一刻**收到播报。
 */
export const secondsToNextBoss = (s: BossState, now: number): number | undefined =>
  s.activeId !== undefined ? undefined : Math.max(0, s.nextSpawnAt - now);

// ════════════════════════════════════════════════════════════════
//  推进
// ════════════════════════════════════════════════════════════════

export interface BossDeps {
  world: World;
  /** ★ 必须登记，否则 BOSS 站着不动（`tick.ts`：没有条目的实体不参与移动）*/
  movement: Map<EntityId, MovementState>;
  auras: AuraStore;
  /** 战利品刷在这里。⚠️ 经典预设下它 `enabled=false`，掉落为空（验收 #28）*/
  arsenal: ArsenalStore;
}

export interface BossSpawnFact {
  entityId: EntityId;
  position: Vec3;
  /** 第几只（从 1 开始）。播报用 */
  ordinal: number;
}

export interface BossKillFact {
  bossId: EntityId;
  /** 最后一击者。环境死/自杀式结算时缺席 —— 如实，不编一个出来 */
  killerId?: EntityId;
  /** 本次赏金（无最后一击者时为 0）*/
  bounty: number;
  /** 击杀者的赏金累计（入账后）*/
  killerTotal: number;
  position: Vec3;
  drops: readonly GroundDrop[];
}

export interface BossTickResult {
  spawned?: BossSpawnFact;
  slain?: BossKillFact;
  /** 本 tick 进入狂暴的那一只 */
  enraged?: EntityId;
}

/**
 * 推进 BOSS 一个 tick。由 `tickWorld` 在**死亡结算之后**调用（见 tick.ts 的
 * 顺序表）—— 三件事的顺序在本函数内部也是固定的：
 *
 *   1. 先结算死亡（这一 tick 死的那只要立刻掉东西、立刻排下一只）
 *   2. 再判狂暴（刚死的不该在同一 tick 里狂暴）
 *   3. 最后判刷新（`nextSpawnAt` 已经被第 1 步推到 105 秒后，不会当场再刷一只）
 *
 * `deaths` 传本 tick 的**全部**战斗事件；本函数自己挑出 BOSS 的那条。
 */
export const tickBoss = (
  state: BossState,
  deps: BossDeps,
  events: readonly CombatEvent[],
  now: number,
): BossTickResult => {
  const result: BossTickResult = {};

  const active =
    state.activeId === undefined ? undefined : deps.world.entities.get(state.activeId);

  /**
   * ⚠️ 防御性再同步：`activeId` 指向的实体不在世界里了（理论上只可能是
   *   别处误删）。什么都不做的话 BOSS 永远不会再刷 —— 而这种「永远不再
   *   发生」的静默故障正是最难查的一类。这里如实复位并按被击杀排下一只。
   */
  if (state.activeId !== undefined && !active) {
    state.activeId = undefined;
    state.enraged = false;
    state.nextSpawnAt = now + BOSS.RESPAWN_SECONDS;
  }

  // ── 1. 死亡结算 ────────────────────────────────────────────
  if (active && !active.alive) {
    result.slain = settleBossDeath(state, deps, active, events, now);
  } else if (active) {
    // ── 2. 狂暴（30% 血线，确定性触发；见 BOSS_ENRAGE_AURA 的注释）──
    if (!state.enraged && active.health <= active.maxHealth * BOSS.ENRAGE_HEALTH_PCT) {
      state.enraged = true;
      applyAura(deps.auras, active, BOSS_ENRAGE_AURA, active.id, now);
      result.enraged = active.id;
    }
  }

  // ── 3. 刷新 ────────────────────────────────────────────────
  if (bossSpawnDue(state, now)) {
    const position = nextBossSite(state);
    const e = spawnBoss(deps, position);
    state.activeId = e.id;
    state.spawned += 1;
    state.enraged = false;
    result.spawned = { entityId: e.id, position: { ...e.position }, ordinal: state.spawned };
  }

  return result;
};

/**
 * 把一只 BOSS 放进世界。
 *
 * ★ **刻意不调 `registerPlayer(stats, e)`** —— 未登记的实体产生的事件会被
 *   统计**静默忽略**（`stats.ts` 的设计），于是「战后面板多出一行熔岩魔王」
 *   与「BOSS 的击杀数参与先到 N 杀判胜」两件事在结构上写不出来。
 *   这是 2.1 对宠物/图腾/召唤物的同一条处理。
 * ★ **不给 Loadout** —— 它不换装、不拾取，`spawnDropsFromRoster` 也只认
 *   `ALL_CLASSES`（BOSS 不在里面），所以它的锤子永远不会掉给玩家。
 */
export const spawnBoss = (deps: BossDeps, position: Vec3): CombatEntity => {
  const e = addEntity(
    deps.world,
    createEntity(allocEntityId(deps.world), bossClass, TEAM_NEUTRAL, position, {
      name: bossClass.name,
    }),
  );
  deps.movement.set(e.id, createMovementState(position, e.yaw));
  return e;
};

const settleBossDeath = (
  state: BossState,
  deps: BossDeps,
  bossEntity: CombatEntity,
  events: readonly CombatEvent[],
  now: number,
): BossKillFact => {
  const position = { ...bossEntity.position };

  /**
   * 最后一击者取本 tick 的 `death` 事件 —— 与统计、击杀播报**同一个来源**。
   * ★ 事件里没有（弃权判死、以及理论上的环境死）就如实缺席：编一个凶手出来
   *   会让赏金发给一个没打过它的人（与 M16a「如实，不编」同则）。
   */
  const death = events.find(
    (ev): ev is Extract<CombatEvent, { t: 'death' }> =>
      ev.t === 'death' && ev.targetId === bossEntity.id,
  );
  const killerId = death?.killerId;

  let bounty = 0;
  let killerTotal = 0;
  if (killerId !== undefined && killerId !== bossEntity.id) {
    bounty = BOSS.KILL_BOUNTY;
    killerTotal = (state.bounties.get(killerId) ?? 0) + bounty;
    state.bounties.set(killerId, killerTotal);
  }

  /**
   * 战利品。**复用军械箱那套** `spawnDropsFromRoster()`：
   *
   * ★ 于是 10.4 的「只从当前房间实际存在的职业池生成，避免刷出无人可用装备」
   *   对 BOSS 掉落自动成立 —— 每个在场职业各一件自己能用的备用武器，
   *   外加一件**人人可用**的增益道具（10.1 的消耗品没有职业归属）。
   *   件数 = 场上职业数 + 1，2v2/3v3 正好是需求说的「2–3 件」。
   * ⚠️ **武器/护甲仍受 10.2 的职业归属约束**：别人职业的那件看得见、拿不走。
   *   「任何人可捡」只对那件消耗品字面成立 —— 如实写在这里，
   *   不假装 BOSS 掉落打破了 10.2（打破它要改的是拾取规则，不是掉落点）。
   * ⚠️ 经典竞技场预设下 `store.enabled=false`，这里返回空数组（验收 #28）。
   */
  const drops = spawnDropsFromRoster(deps.arsenal, rosterClassesOf(deps.world), position, now);
  spreadOnRing(drops, position, BOSS.DROP_RING_RADIUS);

  /**
   * 尸体**立即离场**。
   *
   * ★ 玩家的尸体要留在世界里（复活、观战、死亡回顾都读它），BOSS 没有这些 ——
   *   留一具中立尸体反而要给 Tab 选中、姓名板、复活波次各加一条例外
   *   （夺旗的 `enqueueRespawn` 会真的想把它复活）。战利品就摆在原地，
   *   「这里刚死过一只」的证据不缺。
   * ★ 光环一起清 —— 狂暴是持续到死的 `persistent` 光环，不清就随实体 id
   *   留在仓里；下一只如果拿到同一个 id 就会**开局自带狂暴**。
   */
  deps.world.entities.delete(bossEntity.id);
  deps.movement.delete(bossEntity.id);
  clearAuras(deps.auras, bossEntity.id);

  state.activeId = undefined;
  state.enraged = false;
  state.slain += 1;
  state.nextSpawnAt = now + BOSS.RESPAWN_SECONDS;

  return {
    bossId: bossEntity.id,
    ...(killerId !== undefined ? { killerId } : {}),
    bounty,
    killerTotal,
    position,
    drops,
  };
};

/**
 * 场上实际存在的**玩家**职业池。
 *
 * ★ 与 `tick.ts` 的 `rosterClassesOf` 同一条规则（从世界推导，不从房间名单），
 *   多一条：把 BOSS 自己的职业排除掉。留着其实也无害
 *   （`spawnDropsFromRoster` 只认 `ALL_CLASSES`，查不到就跳过），
 *   但「BOSS 掉自己的锤子」这件事应该由**显式的一行**排除，
 *   而不是靠另一个文件的实现细节碰巧兜住。
 */
const rosterClassesOf = (world: World): ClassId[] => {
  const seen = new Set<ClassId>();
  for (const e of listEntities(world)) {
    if (e.isPet) continue;
    if ((e.classId as string) === (bossClass.id as string)) continue;
    seen.add(e.classId);
  }
  return [...seen];
};

/** 某个实体是不是 BOSS。★ 判据只有一个（classId），别处不要自己比字符串 */
export const isBossEntity = (e: CombatEntity): boolean =>
  (e.classId as string) === (bossClass.id as string);
