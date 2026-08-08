/**
 * 地图数据契约。设计见 docs/06-modes-and-maps.md 第 8 节。
 *
 * 核心约束：**`MapDef.geometry` 是碰撞与视线的唯一真相，客户端渲染网格由它生成。**
 * 不允许美术单独提供一份场景 glTF 再由程序「大致对齐」碰撞盒 ——
 * 那会立刻违反验收 #8（真实范围边界与实际判定一致）与 #11（墙柱门正确挡视线）。
 * 装饰性模型可以额外挂载，但必须 standable:false 且不参与任何判定数组。
 */

import type { Aabb, Vec3 } from '../../math/index.js';
import type { GameMode } from '../../types/enums.js';
import type { MapId, TeamId } from '../../types/ids.js';

/**
 * 地图体积 = 判定用的 Aabb + 渲染用的语义标签。
 * `tag` 只影响渲染选材与调试可视化，**判定一律看 Aabb 上的四个 flag**
 * （blocksSight / blocksMovement / standable / endsFallDamage）。
 */
export interface MapVolume extends Aabb {
  id: string;
  tag:
    | 'wall'
    | 'pillar'
    | 'roof'
    | 'floor'
    | 'ramp'
    /** 低矮栏杆：请显式写 blocksSight:false（6.4）*/
    | 'rail'
    /** 拱门：blocksMovement:false + blocksSight:false，6.4 允许效果传播 */
    | 'arch'
    /** 13.5 深水可终止坠落伤害 */
    | 'water'
    /** 11.1 大门，状态可变 */
    | 'gate';
  /** 碰撞投射物是否被阻挡（6.6）。不填则跟随 blocksMovement */
  blocksProjectile?: boolean;
}

export interface SpawnPoint {
  id: string;
  team: TeamId;
  position: Vec3;
  /** 出生朝向，弧度。竞技场统一朝向中央 */
  yaw: number;
}

export interface PrepRoom {
  id: string;
  team: TeamId;
  /** 11.1 准备区体积 */
  volume: Aabb;
  spawns: readonly SpawnPoint[];
  gateId: string;
  /** 11.3：开门后该体积翻转为对所有人禁入，玩家不能重新进入准备区躲避 */
  reentry: 'blocked';
}

export interface Gate {
  id: string;
  volume: Aabb;
  /** 开门时刻（秒，相对回合开始）。竞技场为 0，即准备阶段结束瞬间 */
  opensAt: number;
  /** 开门动画时长，期间仍阻挡移动 */
  openDuration: number;
}

export interface ForbiddenVolume {
  id: string;
  volume: Aabb;
  /** 'all' = 边界与观众席；{forTeam} = 复活区，只禁敌方 */
  scope: 'all' | { forTeam: TeamId };
  onEnter: 'pushBack' | 'teleportToSpawn';
}

/** 10.4 武装竞技场补给点 */
export interface SupplyPoint {
  id: string;
  kind: 'armory' | 'drop';
  position: Vec3;
  firstSpawnAt: number;
  respawnInterval: number;
  /** 10.4：2v2 只允许一个 primary；3v3 一个 primary + 轮换 side；5v5 中央 + 两侧 + 战术点 */
  role: 'primary' | 'side' | 'tactical';
}

export interface FlagSite {
  id: string;
  /** 旗帜归属方（敌方来拔）*/
  team: TeamId;
  position: Vec3;
  /** 12.5 要求旗帜房至少两个入口 */
  entrances: readonly Vec3[];
}

export interface CaptureZone {
  id: string;
  team: TeamId;
  volume: Aabb;
}

export interface Graveyard {
  id: string;
  team: TeamId;
  volume: Aabb;
  spawns: readonly SpawnPoint[];
  /** 12.5 至少两个出口，防堵门（验收 #43）*/
  exits: readonly Vec3[];
}

export interface RouteHint {
  id: string;
  kind: 'center' | 'flank' | 'underground';
  waypoints: readonly Vec3[];
  /** 12.5 每条主路线至少两个出口 */
  exits: readonly Vec3[];
}

/** 19.1：一张夺旗地图服务 6v6 / 8v8 / 12v12 */
export interface MapScaling {
  openGates: readonly string[];
  extraForbidden: readonly string[];
  spawnsPerTeam: number;
  /** 人越多出口越多，防堵门（验收 #43）*/
  graveyardExits: number;
}

/** 11.3 公平约束的机器可校验结果 */
export interface FairnessAudit {
  /** 双方出生点到地图中央的距离差，米 */
  spawnToCenterDelta: number;
  /** 每个补给点：双方最近出生点到它的距离差，米 */
  spawnToSupplyDelta: Readonly<Record<string, number>>;
  /** 只有位移职业能到达的可站立面 id 列表。**必须为空**（11.3）*/
  mobilityOnlyPlatforms: readonly string[];
  /** 允许误差，米 */
  tolerance: number;
}

/**
 * 纯装饰摆设（M12 表现层）。
 *
 * ★★ **sim 从不读这个数组** —— 碰撞与视线的唯一真相仍是 `geometry`
 *   （docs/06 §8.2「所见即所中」）。所以这里只允许放**明显不挡路的小件**：
 *   灌木、提灯、木箱、半埋的雕像头……体量大到「看起来能挡住人」的东西
 *   必须同时登记一条 `MapVolume`，让碰撞跟着视觉长，否则玩家会试图
 *   躲在一棵穿模的树后面。
 *
 * ★ 客户端在 `?art=off` 时完全不加载它 —— M1–M10 的验收路径照旧是纯几何。
 * ★ `yaw`/`scale` 必须是**确定性**的字面量（不能 Math.random）：
 *   装饰是数据，同一张图在每个客户端上必须长得一样。
 */
export interface MapDecorDef {
  /** 相对 `assets/art/models/` 的路径（不含 .glb），如 'foliage/bush' */
  model: string;
  position: Vec3;
  /** 朝向（弧度），默认 0 */
  yaw?: number;
  /** 整体缩放，默认 1 */
  scale?: number;
}

export interface MapDef {
  id: MapId;
  name: string;
  family: 'arena' | 'ctf' | 'ffa' | 'testbed';
  modes: readonly GameMode[];

  /** 地图外边界。越界触发 17.3 重置 */
  bounds: Aabb;
  /** ★ 碰撞与视线的唯一真相 */
  geometry: readonly MapVolume[];
  forbidden: readonly ForbiddenVolume[];
  /** 纯装饰摆设（可选，表现层专用，见 MapDecorDef）*/
  decor?: readonly MapDecorDef[];
  /**
   * 环境预设名（W15，速赢清单「每张图配一个昼夜」）。
   * ★ 与 `decor` 同属**纯表现**字段：sim 不读，客户端拿它选 HDR 环境
   *   （键对应 client `ENV_PRESETS`，不认识的值回落 day —— 数据不害渲染）。
   *   放 MapDef 而不是客户端表：地图长什么样是地图数据的一部分。
   */
  envPreset?: string;

  prepRooms?: readonly PrepRoom[];
  gates: readonly Gate[];
  supplyPoints?: readonly SupplyPoint[];

  flags?: readonly FlagSite[];
  captureZones?: readonly CaptureZone[];
  graveyards?: readonly Graveyard[];
  routes?: readonly RouteHint[];
  scaling?: Partial<Record<GameMode, MapScaling>>;

  fairness: FairnessAudit;
}

// ── 构造辅助 ─────────────────────────────────────────────────────

/**
 * 用「中心点 + 尺寸」定义一个体积，比手写 min/max 好读也不易写反。
 * y 是**底面**高度而不是中心高度 —— 摆墙时想的是「从地面起 4 米高」而不是「中心在 2 米」。
 */
export const box = (
  id: string,
  tag: MapVolume['tag'],
  center: { x: number; y: number; z: number },
  size: { w: number; h: number; d: number },
  opts: Partial<Omit<MapVolume, 'id' | 'tag' | 'min' | 'max'>> = {},
): MapVolume => ({
  id,
  tag,
  min: { x: center.x - size.w / 2, y: center.y, z: center.z - size.d / 2 },
  max: { x: center.x + size.w / 2, y: center.y + size.h, z: center.z + size.d / 2 },
  standable: true,
  ...opts,
});
