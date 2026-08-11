/**
 * 从一个房间名单装配出一局比赛的**全部**模拟状态。docs/02 §3 / docs/06。
 *
 * ★★ **这个文件的服务对象是「生产调用方」，不是测试。**
 *
 *   在 M10 之前，「怎么把房间名单变成一个能跑的世界」只存在于两个 verify
 *   脚本里（verify-m5 的 3v3、verify-m7 的夺旗），各写各的。服务器如果再
 *   写第三份，客户端的 NetworkScene 将来再写第四份 —— 而它们漂移的表现
 *   极其难查：**客户端预测和服务器判定从第一帧起就跑在两个不同的世界里**，
 *   两边的代码单独看都对，只是出生点差了半米、或者一边建了 respawn 一边没建。
 *
 *   所以服务器（A3 的 MatchLoop）与 A5 的 NetworkScene **必须**共用本文件。
 *
 * ★ 与 verify-m5 / verify-m7 里那两段内联装配的分工：
 *   那两个是**测试夹具**，显式构造正是它们的价值 —— 把装配藏进一个函数，
 *   它们就从「在测规则」变成了「在测装配器」。所以刻意保持不动。
 *   ⚠️ 代价是「装配」目前仍有三处写法，本文件只保证**生产路径**唯一。
 *      如果将来这两个脚本因为装配漂移而误报，那时再统一，不要现在为了
 *      「看起来只有一处」去动 34 项已经通过的验收。
 *
 * ★ 本文件**不推进**任何东西 —— 推进是 `tick.ts` 的事。这里只负责
 *   「把状态摆好」，摆完之后 `tickDepsOf()` 把它转成 `tickWorld` 的入参。
 */

import { CTF, FFA } from '../../constants/combat.js';
import { getClass, getSkill, isPlayableClass } from '../../data/index.js';
import type { ClassDef } from '../../data/schema.js';
import { GameMode } from '../../types/enums.js';
import type { MapDef, SpawnPoint } from '../../data/maps/schema.js';
import type { Vec3 } from '../../math/vec3.js';
import {
  TEAM_BLUE, TEAM_NEUTRAL, TEAM_RED,
  type ClassId, type EntityId, type TeamId,
} from '../../types/ids.js';
import { clearAuras, createAuraStore, type AuraStore } from '../aura.js';
import { createBossState, type BossState } from '../boss.js';
import {
  createArsenalStore, createPickupStore, setupArmories, setupPartyDrops,
  type ArsenalStore, type PickupStore,
} from '../arsenal.js';
import {
  createCastQueueStore, createCastingStore, type CastQueueStore, type CastingStore,
} from '../casting.js';
import { createDrStore, type DrStore } from '../dr.js';
import { createEntity, type CombatEntity } from '../entity.js';
import { createGroundStore, type GroundStore } from '../groundArea.js';
import {
  createLoadout, createLoadoutStore, createSwapStore, type LoadoutStore, type SwapStore,
} from '../loadout.js';
import {
  createMovementState, type MovementInput, type MovementState,
} from '../movement.js';
import { createProjectileStore, type ProjectileStore } from '../projectile.js';
import { createSwingStore, type SwingStore } from '../autoAttack.js';
import { createStats, registerPlayer, type StatsStore } from '../stats.js';
import type { CastIntent, TickDeps } from '../tick.js';
import { addEntity, allocEntityId, createWorld, listEntities, type World } from '../world.js';
import { createArena, teamSizeOf, teamWiped, type ArenaState } from './arena.js';
import { createFfa, type FfaState } from './ffa.js';
import { createCtf, type CtfDeps, type CtfState } from './flag.js';
import { createRespawn, type RespawnState } from './respawn.js';
import { Slot, type Room, type RoomPlayer } from './room.js';

// ════════════════════════════════════════════════════════════════
//  类型
// ════════════════════════════════════════════════════════════════

/**
 * 一局比赛的全部状态。
 *
 * ★ 字段多是**如实反映** —— 这确实就是一局比赛需要持有的东西。
 *   与 `TickDeps` 几乎同构，差别只在 `inputs` / `castRequests`：
 *   那两个是**每 tick 现攒**的，属于循环，不属于比赛状态。
 */
export interface Match {
  map: MapDef;

  world: World;
  auras: AuraStore;
  dr: DrStore;
  ground: GroundStore;
  projectiles: ProjectileStore;
  casting: CastingStore;
  /**
   * 施法排队窗（P10 / 合同 C5）。★ 每局一份，与 `casting` 同生命周期。
   * ⚠️ 只有带 `queue: true` 的请求会往里写，人机的请求永远不带 —— 所以这份
   *   store 在满人机房里恒为空，配平基线不受影响。
   */
  castQueue: CastQueueStore;

  loadouts: LoadoutStore;
  swaps: SwapStore;
  pickups: PickupStore;
  arsenal: ArsenalStore;

  movement: Map<EntityId, MovementState>;
  stats: StatsStore;
  /**
   * 7.6 普通攻击的挥击计时（M14 接线）。
   * ★ 在此之前 `TickDeps.swings` 是可选项且真实对局从不传 —— 普攻只在
   *   测试与 balance-report 里存在（老教训第五次应验）。谁开火由
   *   MatchLoop 按「敌方硬目标存活」同步，试验场没有这份 store，不受影响。
   */
  swings: SwingStore;

  /** 夺旗模式才有。★ 竞技场是 undefined —— 与 15.4 两种 HUD 视图不相交同源 */
  ctf?: { state: CtfState; deps: CtfDeps; map: MapDef };
  /** 夺旗与大乱斗才有：12.6 的复活波次（大乱斗复用同一套波次+复活保护） */
  respawn?: RespawnState;
  /** 竞技场模式才有：2.1 的回合与平局窗口 */
  arena?: ArenaState;
  /**
   * P12/P13 大乱斗才有。胜负 = 先到 killTarget 杀（MatchLoop.checkEnd 读
   * stats）；积分/连杀记账在 sim/match/ffa.ts —— 数值只有那一个文件。
   */
  ffa?: FfaState;
  /**
   * 房主开了「随机大 BOSS」才有（`RoomConfig.bossEnabled`，默认关；
   * 大乱斗一键房默认开 —— 见 createMatch 的 ffa 收尾）。
   * ★ 与 ctf/arena 一样是**可选**字段：没开这条玩法时它整个不存在，
   *   `tickDepsOf` 因此也不会把它接给 tick —— 见 `TickDeps.boss` 的注释。
   */
  boss?: BossState;

  /** 房间玩家 id → 实体 id。断线重连要靠它找回自己的角色 */
  entityOf: Map<string, EntityId>;
  /** 反向表。快照广播要按实体反查是哪条连接 */
  playerOf: Map<EntityId, string>;
}

// ════════════════════════════════════════════════════════════════
//  出生点
// ════════════════════════════════════════════════════════════════

const TEAM_OF_SLOT: Partial<Record<Slot, TeamId>> = {
  [Slot.Red]: TEAM_RED,
  [Slot.Blue]: TEAM_BLUE,
};

/**
 * 某队的出生点序列。
 *
 * ★ 竞技场取准备室（11.1），夺旗取墓地（12.5）—— 这是**地图数据**决定的，
 *   不是模式决定的：`ctfMap` 根本没有 `prepRooms`，`arenaMap` 也没有
 *   `graveyards`。所以这里按「哪个有就用哪个」取，而不是先判模式再取，
 *   否则加一张两者都有的地图时这段逻辑会悄悄选错。
 */
const spawnPointsFor = (map: MapDef, team: TeamId): readonly SpawnPoint[] => {
  const prep = (map.prepRooms ?? [])
    .filter((r) => r.team === team)
    .flatMap((r) => r.spawns);
  if (prep.length > 0) return prep;
  return (map.graveyards ?? [])
    .filter((g) => g.team === team)
    .flatMap((g) => g.spawns);
};

// ════════════════════════════════════════════════════════════════
//  装配
// ════════════════════════════════════════════════════════════════

/**
 * 按房间名单建出一局比赛。
 *
 * ⚠️ **只装配，不校验能不能开局** —— 那是 `canStart()` 的职责（3.2 / 验收 #22）。
 *    调用方应当先过 `startMatch(room)`，再调这里。分开是有意的：
 *    「能不能开」是**房间规则**，「怎么摆」是**模拟装配**，
 *    混在一起会让「加一条阵容限制」有两个下手的地方。
 */
/**
 * 一局比赛里**与花名册有关**的那几张表。`Match` 结构上就满足它 ——
 * 所以开局装配（`createMatch`）与中途加入（`admitToMatch`）共用同一个
 * `spawnCombatant`，而不是各写一遍「建实体 + 建装备栏 + 建移动状态 + 登记统计」。
 *
 * ★★ 各写一遍的代价很具体：漏 `movement.set` 的那个人**动不了且不报错**
 *   （见下面的 ★★），漏 `registerPlayer` 的那个人整场没有统计行。
 *   本仓库栽过的「装配漂移」（本文件头 ★★）就是这一族。
 */
interface RosterDeps {
  world: World;
  loadouts: LoadoutStore;
  movement: Map<EntityId, MovementState>;
  stats: StatsStore;
  entityOf: Map<string, EntityId>;
  playerOf: Map<EntityId, string>;
}

/**
 * 把一个人放进世界：实体 + 装备栏 + 移动状态 + 统计行 + 双向映射。
 * ★ 五件事一次做完，缺一件都是静默故障 —— 见 `RosterDeps` 的 ★★。
 */
const spawnCombatant = (
  d: RosterDeps,
  playerId: string,
  name: string,
  cls: ClassDef,
  team: TeamId,
  point: SpawnPoint | undefined,
): CombatEntity => {
  const position: Vec3 = point?.position ?? { x: 0, y: 0, z: 0 };
  const e = addEntity(
    d.world,
    createEntity(allocEntityId(d.world), cls, team, position, {
      name,
      yaw: point?.yaw ?? 0,
    }),
  );
  d.loadouts.set(e.id, createLoadout(e.classId));
  /**
   * ★★ **每个玩家都必须有移动状态条目。**
   *   `tick.ts` 明确写着「没有条目的实体不参与移动」—— 那条规则是给
   *   假人和「位置由别处驱动」的实体用的。服务器这边如果漏了这一步，
   *   表现是**所有人都动不了**，而且不会有任何报错。
   */
  d.movement.set(e.id, createMovementState(position, point?.yaw ?? 0));
  registerPlayer(d.stats, e);

  d.entityOf.set(playerId, e.id);
  d.playerOf.set(e.id, playerId);
  return e;
};

export const createMatch = (room: Room, map: MapDef): Match => {
  const world = createWorld(map.geometry);
  const auras = createAuraStore();
  const loadouts = createLoadoutStore();
  const movement = new Map<EntityId, MovementState>();
  const stats = createStats();
  const entityOf = new Map<string, EntityId>();
  const playerOf = new Map<EntityId, string>();
  const roster: RosterDeps = { world, loadouts, movement, stats, entityOf, playerOf };

  /** 每队各自的出生点游标 —— 同队的人依次占位，不叠在同一个点上 */
  const nextSpawnIndex = new Map<TeamId, number>();

  const spawnPlayer = (p: RoomPlayer, team: TeamId, ffaPoint?: SpawnPoint): void => {
    const cls = getClass(p.classId!);
    // 走到这里还没有职业，说明调用方跳过了 canStart()。宁可少一个人也不要崩掉整局
    if (!cls) return;

    // P12 大乱斗：出生点由调用方从中立池轮转好传进来（按队查会查空）
    let point = ffaPoint;
    if (!point) {
      const points = spawnPointsFor(map, team);
      const idx = nextSpawnIndex.get(team) ?? 0;
      nextSpawnIndex.set(team, idx + 1);
      // ★ 出生点用完就从头轮转（12v12 的地图给了 12 个，够用；但不要因为
      //   名单多一个人就崩）
      point = points[idx % Math.max(1, points.length)];
    }
    spawnCombatant(roster, p.id, p.name, cls, team, point);
  };

  if (map.family === 'ffa') {
    /**
     * ★★ P12 大乱斗：**每名玩家一个独立 TeamId** —— 这一行就是「所有玩家
     *   都是敌人」的全部实现。isFriendly 是纯队伍比较，独立队号让它对任意
     *   两人恒 false，于是敌对判定/潜行裁剪/光环掩码/AI 选目标全部原样生效，
     *   不需要任何「如果是大乱斗则…」的分支。
     * ★ 队号从 0 起连续分配（TEAM_NEUTRAL=-1 不冲突）；出生点从中立墓地
     *   （ffa 图的唯一 graveyard）轮转 —— 用 TEAM_NEUTRAL 做共享游标，
     *   spawnPlayer 原有的按队游标在这里会退化成人人第 0 号点。
     */
    const pool = (map.graveyards ?? []).flatMap((g) => g.spawns);
    let nextTeam = 0;
    for (const p of room.players) {
      if (TEAM_OF_SLOT[p.slot] === undefined) continue; // 观战者不进世界
      const team = nextTeam++ as TeamId;
      const idx = nextSpawnIndex.get(TEAM_NEUTRAL) ?? 0;
      nextSpawnIndex.set(TEAM_NEUTRAL, idx + 1);
      spawnPlayer(p, team, pool[idx % Math.max(1, pool.length)]);
    }
  } else {
    for (const p of room.players) {
      const team = TEAM_OF_SLOT[p.slot];
      if (team === undefined) continue; // 观战者不进世界
      spawnPlayer(p, team);
    }
  }

  const match: Match = {
    map,
    world,
    auras,
    dr: createDrStore(),
    ground: createGroundStore(),
    projectiles: createProjectileStore(),
    casting: createCastingStore(),
    castQueue: createCastQueueStore(),
    loadouts,
    swaps: createSwapStore(),
    pickups: createPickupStore(),
    arsenal: createArsenalStore(room.config.preset),
    movement,
    stats,
    swings: createSwingStore(),
    entityOf,
    playerOf,
  };

  if (map.family === 'ffa') {
    /**
     * P12 大乱斗收尾装配：
     * · 先到 killTarget 杀获胜（FFA.KILL_TARGET；胜负判定在 MatchLoop.checkEnd）
     * · 复活波次**零改动复用** —— createRespawn 按队号查出口，把每名玩家的
     *   独立队号都映射到同一份中立出口表即可；死亡入队（tick.ts 死亡漏斗）、
     *   波次复活、复活保护（免伤 + 不可用于交互）全部白拿
     * · 不建 arena（没有回合/抑制/平局窗口）也不布军械（armoryLayoutFor
     *   对未知模式返回空 —— 大乱斗首版与夺旗同口径关闭临时装备）
     */
    match.ffa = createFfa(FFA.KILL_TARGET);
    const exits = (map.graveyards ?? []).flatMap((g) => g.exits);
    const exitsByTeam: Record<number, readonly Vec3[]> = {};
    for (const team of new Set([...playerOf.keys()].map((id) => world.entities.get(id)!.team))) {
      exitsByTeam[team as number] = exits;
    }
    match.respawn = createRespawn(exitsByTeam, 0, false, FFA.RESPAWN_SECONDS);
  } else if (map.family === 'ctf') {
    const flagOf = (team: TeamId): Vec3 =>
      map.flags!.find((f) => f.team === team)!.position;

    match.ctf = {
      // ★ `roundsToWin` 在夺旗里读作「夺几次旗获胜」（12.1：房主可调 1~5）。
      //   RoomConfig 只有这一个「目标分」字段，两种模式共用它 ——
      //   不为夺旗单开一个字段，否则房间 UI 要判模式才知道该改哪一个。
      /**
       * ★★ A17：`CTF.DURATION` 在这里第一次有了消费方。此前它是一条零调用
       *   的常量，联网夺旗因此没有自然终点（见 `flag.ts` 的 `resolveCtfOutcome`）。
       *   查不到的模式（将来加图/加尺寸）落 0 = 不限时 —— 宁可退回旧行为，
       *   也不给一张没配过时长的图编一个数字出来。
       */
      state: createCtf(flagOf(TEAM_RED), flagOf(TEAM_BLUE), room.config.roundsToWin, {
        duration: CTF.DURATION[room.config.mode] ?? 0,
        startedAt: world.time,
      }),
      deps: ctfDepsOf(world, map),
      map,
    };
    match.respawn = createRespawn(
      Object.fromEntries((map.graveyards ?? []).map((g) => [g.team as number, g.exits])),
      0,
    );
  } else {
    match.arena = createArena({
      mode: room.config.mode,
      roundsToWin: room.config.roundsToWin,
    });
    /**
     * 10.4 军械点布置。
     *
     * ★★ **在此之前这一行不存在** —— `createArsenalStore()` 建了个空店铺，
     *   `setupArmories()` 全仓库只有测试调过，于是武装竞技场里
     *   **一个军械箱都不会出现**，整个 M6 在真实对局里是空的。
     *   （`setupArmories` 自己会检查 `store.enabled`，所以经典竞技场
     *   照旧一个都不生成 —— 验收 #28 不受影响。）
     * ★ 夺旗不调：12.x 首版关闭临时装备，而 `armoryLayoutFor` 对夺旗模式
     *   返回空数组 —— 两道保险。
     */
    setupArmories(match.arsenal, room.config.mode, world.time);
  }

  /**
   * 大乱斗（FFA）的**派对掉落**：每 30~45 秒在随机位置刷一件夸张武装或
   * 新奇道具，场上同时最多 6 件（规则与占位参数见 `arsenal.ts` 的
   * `PARTY_DROP`，内容见 `data/party.ts`）。
   *
   * ★★ 挂在 `map.family` 上而不是 `room.config.mode` 上，与
   *   `spawnPointsFor()` 同一条理由：**这是地图数据决定的**。
   *   判模式的话，将来加第二张大乱斗图（或者同一张图跑不同人数）
   *   都要回来改这一行；判 family 则加图即生效。
   * ★ 与军械点并列而不是二选一 —— `setupArmories()` 对未知模式返回空列表，
   *   所以大乱斗只会有派对掉落，不会凭空多出军械箱。
   * ★ 掉落半径取地图**内切半径的八成**，留出贴墙的一圈不刷货：
   *   贴着墙刷出来的东西会有一半卡在墙里够不着。
   */
  if (map.family === 'ffa') {
    const halfX = (map.bounds.max.x - map.bounds.min.x) / 2;
    const halfZ = (map.bounds.max.z - map.bounds.min.z) / 2;
    setupPartyDrops(match.arsenal, {
      // ★ 用世界种子：整局仍由一个种子完全决定（world.ts §rng 的不变量）
      seed: world.seed,
      radius: Math.min(halfX, halfZ) * 0.8,
    });
  }

  /**
   * 随机大 BOSS（玩家需求）。**房主开了才有**，见 `RoomConfig.bossEnabled`；
   * 大乱斗地图**默认有**（P13：BOSS 是大乱斗玩法的一部分，与派对掉落同一档）。
   *
   * ★ 与模式无关：BOSS 是 `TEAM_NEUTRAL`，`aliveCount()`/`teamWiped()` 都按
   *   队伍数人，所以它既不会让竞技场的「一方全灭」判不出来，也不参与
   *   夺旗的比分。哪种模式想要它，房主开一下就是了。
   * ⚠️ 掉落跟着 10.1 的预设走（经典预设 = 有 BOSS、没战利品），
   *   理由与提示写在 `setBossEnabled` 那里。
   */
  if (room.config.bossEnabled === true || map.family === 'ffa') {
    match.boss = createBossState(map, world.time);
  }

  return match;
};

/**
 * 夺旗的两个几何判据。
 *
 * ★ 从**地图数据**导出，不写死坐标 —— 12.3 的「进入非法区域时旗帜落在
 *   最后合法位置」要跟着地图边界走，换一张地图就该自动跟着变。
 */
const ctfDepsOf = (world: World, map: MapDef): CtfDeps => ({
  world,
  captureZoneContains: (team, p) => {
    const zone = map.captureZones?.find((c) => c.team === team);
    if (!zone) return false;
    const v = zone.volume;
    return p.x >= v.min.x && p.x <= v.max.x && p.z >= v.min.z && p.z <= v.max.z;
  },
  isLegalPosition: (p) =>
    p.x > map.bounds.min.x && p.x < map.bounds.max.x &&
    p.z > map.bounds.min.z && p.z < map.bounds.max.z &&
    p.y > map.bounds.min.y,
});

// ════════════════════════════════════════════════════════════════
//  转成 tick 入参
// ════════════════════════════════════════════════════════════════

/**
 * 把一局比赛 + 本 tick 的意图转成 `tickWorld` 的入参。
 *
 * ★ 存在的意义是「字段别接漏」：`TickDeps` 有 14 个必填字段，
 *   服务器和 NetworkScene 各自手写一遍的话，漏掉 `arsenal` 或 `respawn`
 *   不会报错 —— 只会让军械箱或复活波次**静默地不工作**。
 */
export const tickDepsOf = (
  m: Match,
  inputs: ReadonlyMap<EntityId, MovementInput>,
  castRequests?: ReadonlyMap<EntityId, CastIntent>,
): TickDeps => ({
  world: m.world,
  auras: m.auras,
  dr: m.dr,
  ground: m.ground,
  projectiles: m.projectiles,
  casting: m.casting,
  castQueue: m.castQueue,
  loadouts: m.loadouts,
  swaps: m.swaps,
  pickups: m.pickups,
  arsenal: m.arsenal,
  movement: m.movement,
  swings: m.swings,
  inputs,
  ...(castRequests ? { castRequests } : {}),
  getSkill,
  stats: m.stats,
  ...(m.ctf ? { ctf: m.ctf } : {}),
  ...(m.arena ? { arena: m.arena } : {}),
  ...(m.respawn ? { respawn: m.respawn } : {}),
  ...(m.boss ? { boss: m.boss } : {}),
});

/** 某个房间玩家在这局里的实体。断线重连、快照裁剪都要它 */
export const entityOfPlayer = (m: Match, playerId: string): CombatEntity | undefined => {
  const id = m.entityOf.get(playerId);
  return id === undefined ? undefined : m.world.entities.get(id);
};

// ════════════════════════════════════════════════════════════════
//  W24 中途加入
// ════════════════════════════════════════════════════════════════

export type AdmitResult =
  | { ok: true; entityId: EntityId; team: TeamId }
  | { ok: false; reason: string };

/**
 * W24：**给一局进行中的比赛加一个新实体**（用户拍板 2026-08-10 的中途加入）。
 *
 * ★★ **与顶替人机席位是两条不同的路**，别混：
 *   · 队伍**还有空位**（组队模式没开人机补位、或有人退出）→ 走这里，新建实体，
 *     职业**当场生效**（他是一个全新的角色，没有「免费满血」可言）；
 *   · 队伍**满了但有人机在打** → 走顶替（服务器的 `JoinOngoing`），
 *     沿用被顶替者的身体，选的职业等下一次复活/回合重置才换
 *     （当场换 = 一次免费满血 + 冷却清空，见 docs/08 §8.7）。
 *
 * ★ 开局装配与这里共用 `spawnCombatant` —— 「装配漂移」是本文件头点名的
 *   那一族 bug（漏一张表不报错，只是那个人动不了 / 没有统计行）。
 *
 * ⚠️ **每队人数上限不在这里判**：档位（`teamSizeOf(mode)`）在 `RoomConfig` 里，
 *    而 `Match` 刻意不持有房间配置。判在调用方（服务器 `JoinOngoing`，
 *    「红满只能蓝」那条有测试盯着）。这里只判**它自己看得见**的两件事：
 *    职业合法性，以及「不能给一个已经全灭的队伍续命」。
 */
export const admitToMatch = (
  m: Match,
  opts: { playerId: string; name: string; classId: ClassId; slot: Slot },
): AdmitResult => {
  if (m.entityOf.has(opts.playerId)) return { ok: false, reason: '你已经在这局比赛里了' };
  /**
   * ★ 判据是 `isPlayableClass` 而不是 `getClass` —— 与 `selectClass` 逐字同源：
   *   注册表里有玩家选不到的特殊职业（大 BOSS），放行就等于让一条手写消息
   *   顶着 15000 生命中途入场。
   */
  if (!isPlayableClass(opts.classId)) return { ok: false, reason: `未知职业：${opts.classId}` };
  const cls = getClass(opts.classId);
  if (!cls) return { ok: false, reason: `未知职业：${opts.classId}` };

  /**
   * P12 大乱斗：**每人一个独立队号**（createMatch 里那一行的原样延续）。
   * 新队号取「当前最大 + 1」，中立（-1，BOSS）不参与。
   */
  if (m.map.family === 'ffa') {
    const combatants = [...m.playerOf.keys()]
      .map((id) => m.world.entities.get(id))
      .filter((e): e is CombatEntity => e !== undefined && e.team !== TEAM_NEUTRAL);
    if (combatants.length >= teamSizeOf(GameMode.Ffa)) {
      return { ok: false, reason: '这局大乱斗已经满员了' };
    }
    const team = (combatants.reduce((max, e) => Math.max(max, e.team as number), -1) + 1) as TeamId;

    const pool = (m.map.graveyards ?? []).flatMap((g) => g.spawns);
    const point = pool[combatants.length % Math.max(1, pool.length)];
    const e = spawnCombatant(m, opts.playerId, opts.name, cls, team, point);
    /**
     * ★★ **新队号必须登记复活出口**，否则他一死就在原点 (0,0,0) 复活 ——
     *   `createRespawn` 建表时只认识开局那批队号，`nextExitFor` 查不到就
     *   返回零向量，而零向量在任何一张图上都不会报错，只是很奇怪。
     */
    if (m.respawn) {
      m.respawn.exits.set(team as number, (m.map.graveyards ?? []).flatMap((g) => g.exits));
    }
    return { ok: true, entityId: e.id, team };
  }

  const team = TEAM_OF_SLOT[opts.slot];
  if (team === undefined) return { ok: false, reason: '观战席不是战斗席位' };
  /**
   * ⚠️ **不给已全灭的队伍续命。** 竞技场靠「一方全灭」判负（2.1 / 验收 #26），
   *   而 `teamWiped` 是每 tick 现算的 —— 往一个刚被清台的队伍里塞一个满血的人，
   *   会让已经进入结算窗口的回合活过来。那不是「中途加入」，那是免费续命。
   */
  if (teamWiped(m.world, team)) {
    return { ok: false, reason: '该队本回合已全灭，不能中途加入' };
  }

  const points = spawnPointsFor(m.map, team);
  // 出生点按**该队现有人数**轮转 —— 与开局那条游标同一个意思，确定性
  const idx = listEntities(m.world).filter((e) => e.team === team && !e.isPet).length;
  const e = spawnCombatant(m, opts.playerId, opts.name, cls, team, points[idx % Math.max(1, points.length)]);
  return { ok: true, entityId: e.id, team };
};

/**
 * W24：把一个**已有实体**换成另一个职业（顶替人机席位的人「下一次复活/回合
 * 重置起换成自己选的职业」那一步）。
 *
 * ★★ **只能在他刚活过来的那一刻调用。** 活着的时候换 = 满血 + 满资源 +
 *   冷却清空 + 光环全清，那是一个可以反复触发的免费复活（docs/08 §8.7 的
 *   拍板理由）。调用时机的守卫在调用方（服务器只在「死 → 活」的跳变上调它），
 *   本函数只负责换得**干净**。
 *
 * ★ 职业相关的字段一个都不能漏 —— 所以这里先用 `createEntity` 造一个同职业的
 *   全新实体当**参照物**，再逐项抄过来。漏抄一项会被 `respec` 的等价性用例
 *   抓住（它把结果与一个新建实体逐字段比对）。
 *
 * ★ **不动的四样**：id / 位置朝向 / 队伍 / 名字（他还是他，只是换了个职业），
 *   外加 `rng`（按实体分流的随机流，见 `CombatEntity.rng`）——
 *   重置它等于让同一个实体的闪避序列在换职业时跳一下。
 * ★ 统计行**保留累计值**：这个席位在被顶替之前由人机打出的伤害仍记在这一行上
 *   （统计是按**实体**记的，而实体没换）。只把 `classId`/`name` 更新成新的，
 *   否则战后面板会用旧职业解释他整场的表现。这条如实记在 docs/15 W24 行。
 */
export const respecCombatant = (m: Match, e: CombatEntity, cls: ClassDef): void => {
  const fresh = createEntity(e.id, cls, e.team, e.position, { name: e.name, yaw: e.yaw });

  e.classId = fresh.classId;
  e.health = fresh.health;
  e.maxHealth = fresh.maxHealth;
  e.baseMaxHealth = fresh.baseMaxHealth;
  e.resources = fresh.resources;
  e.maxResources = fresh.maxResources;
  e.resourceRegen = fresh.resourceRegen;
  e.weaponId = fresh.weaponId;
  e.armorId = fresh.armorId;
  e.availableSkills = fresh.availableSkills;
  e.cooldowns = fresh.cooldowns;
  e.gcdUntil = fresh.gcdUntil;
  e.schoolLocks = fresh.schoolLocks;
  e.nextSwingAt = fresh.nextSwingAt;
  e.swingRecoveryUntil = fresh.swingRecoveryUntil;
  e.targets = fresh.targets;
  // 大乱斗借来的身份跟着旧职业一起还回去（与 `onDeath` 同一条收口）
  delete e.borrowedClassId;

  // 装备栏整个换成新职业的默认套 —— 上一个职业的备用武器对他毫无意义
  m.loadouts.set(e.id, createLoadout(cls.id));
  m.swaps.delete(e.id);
  /**
   * ★ 光环清干净：换职业前挂着的战斗怒吼/形态光环属于上一个职业，
   *   留着会让一个法师顶着熊形态的生命上限跑（`applyMaxHealthMultiplier`
   *   每 tick 从光环重算 —— 它不认识「这人已经不是德鲁伊了」）。
   */
  clearAuras(m.auras, e.id);

  const row = m.stats.players.get(e.id);
  if (row) {
    row.classId = cls.id;
    row.name = e.name;
  }
};
