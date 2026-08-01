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

import { getClass, getSkill } from '../../data/index.js';
import type { MapDef, SpawnPoint } from '../../data/maps/schema.js';
import type { Vec3 } from '../../math/vec3.js';
import { TEAM_BLUE, TEAM_RED, type EntityId, type TeamId } from '../../types/ids.js';
import { createAuraStore, type AuraStore } from '../aura.js';
import {
  createArsenalStore, createPickupStore, type ArsenalStore, type PickupStore,
} from '../arsenal.js';
import { createCastingStore, type CastingStore } from '../casting.js';
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
import { addEntity, allocEntityId, createWorld, type World } from '../world.js';
import { createArena, type ArenaState } from './arena.js';
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
  /** 夺旗模式才有：12.6 的复活波次 */
  respawn?: RespawnState;
  /** 竞技场模式才有：2.1 的回合与平局窗口 */
  arena?: ArenaState;

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
export const createMatch = (room: Room, map: MapDef): Match => {
  const world = createWorld(map.geometry);
  const auras = createAuraStore();
  const loadouts = createLoadoutStore();
  const movement = new Map<EntityId, MovementState>();
  const stats = createStats();
  const entityOf = new Map<string, EntityId>();
  const playerOf = new Map<EntityId, string>();

  /** 每队各自的出生点游标 —— 同队的人依次占位，不叠在同一个点上 */
  const nextSpawnIndex = new Map<TeamId, number>();

  const spawnPlayer = (p: RoomPlayer, team: TeamId): void => {
    const cls = getClass(p.classId!);
    // 走到这里还没有职业，说明调用方跳过了 canStart()。宁可少一个人也不要崩掉整局
    if (!cls) return;

    const points = spawnPointsFor(map, team);
    const idx = nextSpawnIndex.get(team) ?? 0;
    nextSpawnIndex.set(team, idx + 1);
    // ★ 出生点用完就从头轮转（12v12 的地图给了 12 个，够用；但不要因为
    //   名单多一个人就崩）
    const point = points[idx % Math.max(1, points.length)];
    const position: Vec3 = point?.position ?? { x: 0, y: 0, z: 0 };

    const e = addEntity(
      world,
      createEntity(allocEntityId(world), cls, team, position, {
        name: p.name,
        yaw: point?.yaw ?? 0,
      }),
    );
    loadouts.set(e.id, createLoadout(e.classId));
    /**
     * ★★ **每个玩家都必须有移动状态条目。**
     *   `tick.ts` 明确写着「没有条目的实体不参与移动」—— 那条规则是给
     *   假人和「位置由别处驱动」的实体用的。服务器这边如果漏了这一步，
     *   表现是**所有人都动不了**，而且不会有任何报错。
     */
    movement.set(e.id, createMovementState(position, point?.yaw ?? 0));
    registerPlayer(stats, e);

    entityOf.set(p.id, e.id);
    playerOf.set(e.id, p.id);
  };

  for (const p of room.players) {
    const team = TEAM_OF_SLOT[p.slot];
    if (team === undefined) continue; // 观战者不进世界
    spawnPlayer(p, team);
  }

  const match: Match = {
    map,
    world,
    auras,
    dr: createDrStore(),
    ground: createGroundStore(),
    projectiles: createProjectileStore(),
    casting: createCastingStore(),
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

  if (map.family === 'ctf') {
    const flagOf = (team: TeamId): Vec3 =>
      map.flags!.find((f) => f.team === team)!.position;

    match.ctf = {
      // ★ `roundsToWin` 在夺旗里读作「夺几次旗获胜」（12.1：房主可调 1~5）。
      //   RoomConfig 只有这一个「目标分」字段，两种模式共用它 ——
      //   不为夺旗单开一个字段，否则房间 UI 要判模式才知道该改哪一个。
      state: createCtf(flagOf(TEAM_RED), flagOf(TEAM_BLUE), room.config.roundsToWin),
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
});

/** 某个房间玩家在这局里的实体。断线重连、快照裁剪都要它 */
export const entityOfPlayer = (m: Match, playerId: string): CombatEntity | undefined => {
  const id = m.entityOf.get(playerId);
  return id === undefined ? undefined : m.world.entities.get(id);
};
