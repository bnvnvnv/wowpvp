/**
 * 夺旗地图「双桥要塞」。规格书 12.5 + 19.1，验收 #38–#43。
 *
 * 19.1：**一张夺旗地图服务 6v6 / 8v8 / 12v12**，靠 `scaling` 调节
 * 开放的路线与复活点数量，而不是做三张图。
 *
 * ★ 对称性由**构造**保证，不靠手抄坐标。
 *   只写红方（+Z）一半，蓝方（−Z）由绕 Y 轴旋转 180°（(x,z) → (−x,−z)）生成。
 *   手写两边迟早会写歪一米，而 11.3 的公平约束一米都不能歪。
 *
 * ★ 12.5 的路线时间是**算出来的**，不是嘴上说说：
 *   「从己方基地到敌方旗帜房，在无战斗情况下约 35 至 45 秒」——
 *   `routeSeconds()` 按 8.1 的 7 米/秒折算每条路线的实际折线长度，
 *   `maps.test.ts` 逐条断言落在 35~45 秒内，且中央路线**严格最短**。
 *
 * ★ 12.5「不能从复活区直接攻击旗帜房」也是机器可校验的：
 *   旗帜房后墙（z=±142）挡在复活区（z=±150 以外）和旗帜（z=±126）之间，
 *   测试用 `hasLineOfSight()` 断言这条视线被挡。
 *
 * 布局（俯视，红方在 +Z）：
 * ```
 *        ┌──── 复活区 ────┐            z=+168…+150
 *        │  ▲   ▲   ▲    │
 *        └──┬─────────┬──┘
 *     ┏━━━━━┷━━━━━━━━━┷━━━━━┓          旗帜房后墙 z=+142
 *     ┃         ⚑           ┃          红旗  z=+126
 *     ┗━━━┓  ┏━━━━━┓  ┏━━━━━┛          前墙两个门 z=+110
 *  ◇      ┃  ┃     ┃  ┃      ◇
 *  ◇ 侧翼 ┃  ┃ 中央 ┃  ┃ 侧翼 ◇         x=±52 掩体多
 *  ◇      ┃  ╲地道╱   ┃      ◇         地道口 z=±90…±72
 *         ┃   ▁▁▁▁    ┃                地道 y=−6，宽 8 米
 * ```
 */

import { MOVE } from '../../constants/combat.js';
import { hasLineOfSight, type Aabb, type Vec3 } from '../../math/index.js';
import { GameMode } from '../../types/enums.js';
import { asMapId, TEAM_BLUE, TEAM_RED, type TeamId } from '../../types/ids.js';
import {
  box,
  type CaptureZone,
  type FlagSite,
  type ForbiddenVolume,
  type Graveyard,
  type MapDecorDef,
  type MapDef,
  type MapVolume,
  type RouteHint,
  type SpawnPoint,
} from './schema.js';

// ── 关键尺寸（米）。改这里，两侧同时变 ──────────────────────────
const HALF_LEN = 180;
const HALF_WID = 72;
/** 旗帜所在的 Z。12.5 的 35~45 秒主要由它决定 */
const FLAG_Z = 126;
const ROOM_FRONT_Z = 110;
const ROOM_BACK_Z = 142;
const ROOM_HALF_W = 16;
const ROOM_H = 6;
const GRAVE_FRONT_Z = 150;
const GRAVE_BACK_Z = 168;
const GRAVE_HALF_W = 20;
/** 侧翼路线的横向位置 */
const FLANK_X = 52;
/** 地道：宽 8 米、深 6 米，12.5「狭窄，适合控制和近战」*/
const TUNNEL_HALF_W = 4;
const TUNNEL_Y = -6;
const TUNNEL_Z = 72;
/**
 * ★ 下行阶梯**不在中线上**，而是偏到 x ∈ [18, 26]（蓝方镜像到 [−26, −18]）。
 *   把楼梯井开在 x=0 会在中央路线正中间留一个 8 米宽的洞 ——
 *   顺着中央跑的人会直接掉进去，而 12.5 要求中央是「开阔路线」。
 *   井口和主地道之间用一段横向甬道相连。
 */
const TRENCH_X0 = 18;
const TRENCH_X1 = 26;
/** 井口中心，路线用 */
const TRENCH_MID = (TRENCH_X0 + TRENCH_X1) / 2;
/** 横向甬道：连接楼梯井底部与主地道 */
const CORRIDOR_Z0 = 64;
const STAIR_Z = 90;
const STAIR_STEPS = 12;
const WALL_H = 12;

// ── 旋转对称 ─────────────────────────────────────────────────────

/** 绕 Y 轴 180°：(x, z) → (−x, −z) */
const rotPoint = (p: Vec3): Vec3 => ({ x: -p.x, y: p.y, z: -p.z });

/** 体积的旋转：x/z 取负后 min 与 max 互换（否则会写出 min > max 的坏盒子）*/
const rotVolume = (v: MapVolume): MapVolume => ({
  ...v,
  id: v.id.replace('red', 'blue'),
  min: { x: -v.max.x, y: v.min.y, z: -v.max.z },
  max: { x: -v.min.x, y: v.max.y, z: -v.min.z },
});

const rotAabb = (v: Aabb): Aabb => ({
  ...v,
  min: { x: -v.max.x, y: v.min.y, z: -v.max.z },
  max: { x: -v.min.x, y: v.max.y, z: -v.min.z },
});

/** 用「x/z 的区间」建盒子，比中心+尺寸更适合描述贴边的墙 */
const span = (
  id: string,
  tag: MapVolume['tag'],
  x: readonly [number, number],
  z: readonly [number, number],
  y: readonly [number, number],
  opts: Partial<Omit<MapVolume, 'id' | 'tag' | 'min' | 'max'>> = {},
): MapVolume =>
  box(
    id,
    tag,
    { x: (x[0] + x[1]) / 2, y: y[0], z: (z[0] + z[1]) / 2 },
    { w: x[1] - x[0], h: y[1] - y[0], d: z[1] - z[0] },
    opts,
  );

// ── 地面 ─────────────────────────────────────────────────────────

/**
 * 地面被地道口切开。中段那块同时是地道的**顶**——
 * 地道不是独立的洞，而是「地面盖在上面」，所以这块必须完整。
 */
const groundSlabs = (): MapVolume[] => {
  const floorOpts = { blocksSight: false };
  const red: MapVolume[] = [
    span('floor_red_far', 'floor', [-HALF_WID, HALF_WID], [STAIR_Z, HALF_LEN], [-1, 0], floorOpts),
    // 楼梯井那一段：只在 x ∈ [18, 26] 留空，中线仍是完整地面
    span('floor_red_trench_w', 'floor', [-HALF_WID, TRENCH_X0], [TUNNEL_Z, STAIR_Z], [-1, 0], floorOpts),
    span('floor_red_trench_e', 'floor', [TRENCH_X1, HALF_WID], [TUNNEL_Z, STAIR_Z], [-1, 0], floorOpts),
  ];
  return [
    // 中段整块 —— 它同时是地道与横向甬道的**顶**，不能开洞
    span('floor_center', 'floor', [-HALF_WID, HALF_WID], [-TUNNEL_Z, TUNNEL_Z], [-1, 0], floorOpts),
    ...red,
    ...red.map(rotVolume),
  ];
};

const outerWalls = (): MapVolume[] => [
  span('wall_north', 'wall', [-HALF_WID, HALF_WID], [HALF_LEN - 1, HALF_LEN], [0, WALL_H]),
  span('wall_south', 'wall', [-HALF_WID, HALF_WID], [-HALF_LEN, -HALF_LEN + 1], [0, WALL_H]),
  span('wall_west', 'wall', [-HALF_WID, -HALF_WID + 1], [-HALF_LEN, HALF_LEN], [0, WALL_H]),
  span('wall_east', 'wall', [HALF_WID - 1, HALF_WID], [-HALF_LEN, HALF_LEN], [0, WALL_H]),
];

// ── 地道（12.5 的「地下路线」）─────────────────────────────────

const tunnel = (): MapVolume[] => {
  const floorOpts = { blocksSight: false };
  const out: MapVolume[] = [
    span('tunnel_floor', 'floor', [-TUNNEL_HALF_W, TUNNEL_HALF_W], [-TUNNEL_Z, TUNNEL_Z], [TUNNEL_Y - 1, TUNNEL_Y], floorOpts),
  ];

  /**
   * 只写红方一半，蓝方全靠 rotVolume。
   * 主地道的东墙在 z ∈ [64, 72] 留口通向红方甬道；
   * 旋转后正好变成西墙在 z ∈ [−72, −64] 留口通向蓝方甬道 ——
   * 一份定义同时给出两面墙和两个正确的开口。
   */
  const red: MapVolume[] = [
    span('tunnel_wall_red_e', 'wall', [TUNNEL_HALF_W, TUNNEL_HALF_W + 1], [-TUNNEL_Z, CORRIDOR_Z0], [TUNNEL_Y, 0]),
    // 横向甬道：从主地道通到楼梯井底
    span('corridor_red_floor', 'floor', [TUNNEL_HALF_W, TRENCH_X1], [CORRIDOR_Z0, TUNNEL_Z], [TUNNEL_Y - 1, TUNNEL_Y], floorOpts),
    span('corridor_red_wall_s', 'wall', [TUNNEL_HALF_W, TRENCH_X1 + 1], [CORRIDOR_Z0 - 1, CORRIDOR_Z0], [TUNNEL_Y, 0]),
    // 北墙只封到楼梯井西边 —— x ∈ [18, 26] 是井口
    span('corridor_red_wall_n', 'wall', [TUNNEL_HALF_W, TRENCH_X0], [TUNNEL_Z, TUNNEL_Z + 1], [TUNNEL_Y, 0]),
    span('corridor_red_wall_e', 'wall', [TRENCH_X1, TRENCH_X1 + 1], [CORRIDOR_Z0 - 1, TUNNEL_Z], [TUNNEL_Y, 0]),
    // 楼梯井两侧挡墙
    span('trench_red_wall_w', 'wall', [TRENCH_X0 - 1, TRENCH_X0], [TUNNEL_Z, STAIR_Z], [TUNNEL_Y, 0]),
    span('trench_red_wall_e', 'wall', [TRENCH_X1, TRENCH_X1 + 1], [TUNNEL_Z, STAIR_Z], [TUNNEL_Y, 0]),
  ];

  // 下行阶梯：z 从 90 走到 72，y 从 0 降到 −6
  const depth = (STAIR_Z - TUNNEL_Z) / STAIR_STEPS; // 每级 1.5 米
  const rise = -TUNNEL_Y / STAIR_STEPS; // 每级 0.5 米
  for (let i = 0; i < STAIR_STEPS; i += 1) {
    const zHi = STAIR_Z - depth * i;
    red.push(
      span(
        `stair_red_${i}`,
        'ramp',
        [TRENCH_X0, TRENCH_X1],
        [zHi - depth, zHi],
        [TUNNEL_Y - 1, -rise * (i + 1)],
        floorOpts,
      ),
    );
  }

  out.push(...red, ...red.map(rotVolume));
  return out;
};

// ── 基地与旗帜房（只写红方，蓝方由 rotVolume 生成）────────────

/**
 * 12.5：「基地旗帜房至少两个入口」。
 * 前墙拆成三段，留出两个 7 米宽的门；后墙实心 —— 它同时负责挡住
 * 「从复活区直接攻击旗帜房」的视线。
 */
const redBaseVolumes = (): MapVolume[] => [
  span('room_red_back', 'wall', [-ROOM_HALF_W, ROOM_HALF_W], [ROOM_BACK_Z - 1, ROOM_BACK_Z], [0, ROOM_H]),
  span('room_red_side_w', 'wall', [-ROOM_HALF_W, -ROOM_HALF_W + 1], [ROOM_FRONT_Z, ROOM_BACK_Z], [0, ROOM_H]),
  span('room_red_side_e', 'wall', [ROOM_HALF_W - 1, ROOM_HALF_W], [ROOM_FRONT_Z, ROOM_BACK_Z], [0, ROOM_H]),
  // 前墙三段 → 两个门：x ∈ [−10,−3] 与 [3,10]
  span('room_red_front_w', 'wall', [-ROOM_HALF_W, -10], [ROOM_FRONT_Z, ROOM_FRONT_Z + 1], [0, ROOM_H]),
  span('room_red_front_m', 'wall', [-3, 3], [ROOM_FRONT_Z, ROOM_FRONT_Z + 1], [0, ROOM_H]),
  span('room_red_front_e', 'wall', [10, ROOM_HALF_W], [ROOM_FRONT_Z, ROOM_FRONT_Z + 1], [0, ROOM_H]),
  // 顶盖：挡住从空中直接打旗。standable:false —— 11.3 不允许只有位移职业能上的高台
  span('room_red_roof', 'roof', [-ROOM_HALF_W, ROOM_HALF_W], [ROOM_FRONT_Z, ROOM_BACK_Z], [ROOM_H, ROOM_H + 1], { standable: false }),

  // 复活区外墙，同样留两个前门 + 两个侧门（12.5 复活区至少两个出口）
  span('grave_red_back', 'wall', [-GRAVE_HALF_W, GRAVE_HALF_W], [GRAVE_BACK_Z - 1, GRAVE_BACK_Z], [0, ROOM_H]),
  span('grave_red_front_w', 'wall', [-GRAVE_HALF_W, -14], [GRAVE_FRONT_Z, GRAVE_FRONT_Z + 1], [0, ROOM_H]),
  span('grave_red_front_m', 'wall', [-6, 6], [GRAVE_FRONT_Z, GRAVE_FRONT_Z + 1], [0, ROOM_H]),
  span('grave_red_front_e', 'wall', [14, GRAVE_HALF_W], [GRAVE_FRONT_Z, GRAVE_FRONT_Z + 1], [0, ROOM_H]),
  span('grave_red_side_w_a', 'wall', [-GRAVE_HALF_W, -GRAVE_HALF_W + 1], [GRAVE_FRONT_Z, 155], [0, ROOM_H]),
  span('grave_red_side_w_b', 'wall', [-GRAVE_HALF_W, -GRAVE_HALF_W + 1], [161, GRAVE_BACK_Z], [0, ROOM_H]),
  span('grave_red_side_e_a', 'wall', [GRAVE_HALF_W - 1, GRAVE_HALF_W], [GRAVE_FRONT_Z, 155], [0, ROOM_H]),
  span('grave_red_side_e_b', 'wall', [GRAVE_HALF_W - 1, GRAVE_HALF_W], [161, GRAVE_BACK_Z], [0, ROOM_H]),
];

// ── 侧翼掩体（12.5：侧翼路线掩体多，适合潜行和绕后）───────────

const flankCover = (): MapVolume[] => {
  const out: MapVolume[] = [];
  const rows = [10, 34, 58, 82, 106];
  rows.forEach((z, i) => {
    for (const sx of [-1, 1] as const) {
      const x = sx * (FLANK_X + (i % 2 === 0 ? -6 : 6));
      const p = box(`cover_red_${i}_${sx > 0 ? 'e' : 'w'}`, 'pillar', { x, y: 0, z }, { w: 3, h: 5, d: 3 });
      out.push(p, rotVolume(p));
      // 半高矮墙：6.4 意义上仍然挡视线（高于胸口 1.35 米），但可以跳过去
      const r = box(`cover_red_low_${i}_${sx > 0 ? 'e' : 'w'}`, 'wall', { x: x + sx * 9, y: 0, z: z + 8 }, { w: 10, h: 2, d: 1 });
      out.push(r, rotVolume(r));
    }
  });
  // 中央只放两根柱子 —— 12.5「中央开阔路线最短，适合大团战」
  for (const z of [26, 78]) {
    for (const sx of [-1, 1] as const) {
      const p = box(`center_pillar_red_${z}_${sx > 0 ? 'e' : 'w'}`, 'pillar', { x: sx * 14, y: 0, z }, { w: 2.5, h: 5, d: 2.5 });
      out.push(p, rotVolume(p));
    }
  }
  return out;
};

// ── 组装 ─────────────────────────────────────────────────────────

const geometry: readonly MapVolume[] = [
  ...groundSlabs(),
  ...outerWalls(),
  ...tunnel(),
  ...redBaseVolumes(),
  ...redBaseVolumes().map(rotVolume),
  ...flankCover(),
];

const redFlagSite: FlagSite = {
  id: 'flag_red',
  team: TEAM_RED,
  position: { x: 0, y: 0, z: FLAG_Z },
  // 12.5：旗帜房至少两个入口
  entrances: [
    { x: -6.5, y: 0, z: ROOM_FRONT_Z },
    { x: 6.5, y: 0, z: ROOM_FRONT_Z },
  ],
};

const redRoomVolume: Aabb = {
  min: { x: -ROOM_HALF_W + 1, y: 0, z: ROOM_FRONT_Z + 1 },
  max: { x: ROOM_HALF_W - 1, y: ROOM_H, z: ROOM_BACK_Z - 1 },
};

const redGraveVolume: Aabb = {
  min: { x: -GRAVE_HALF_W + 1, y: 0, z: GRAVE_FRONT_Z + 1 },
  max: { x: GRAVE_HALF_W - 1, y: ROOM_H, z: GRAVE_BACK_Z - 1 },
};

/** 复活点沿 X 排开，最多 12 个（12v12）。模式按 spawnsPerTeam 取前 N 个 */
const graveSpawns = (team: TeamId, sign: 1 | -1): SpawnPoint[] =>
  Array.from({ length: 12 }, (_, i) => ({
    id: `spawn_${team as number}_${i}`,
    team,
    position: {
      x: sign * ((i % 6) - 2.5) * 5,
      y: 0,
      z: sign * (i < 6 ? 156 : 163),
    },
    /**
     * 红方在 +Z，面向 −Z（yaw 0）；蓝方相反。
     * ★ W12 修正：此前写成 `sign === 1 ? Math.PI : 0` —— 与注释意图相反
     *   （vec3.ts 约定 yaw 0 → −Z，竞技场的 prepRooms 就是这么写的），
     *   两队出生都背对战场。单机试验场从不用墓地出生点，联网夺旗第一次
     *   有真人从这里睁眼才暴露。
     */
    yaw: sign === 1 ? 0 : Math.PI,
  }));

/**
 * 12.5 / 验收 #43：复活区出口。顺序 = 优先级，模式按 `graveyardExits` 取前 N 个。
 * 前两个是正门，后两个是侧门 —— 人多时多开侧门，避免正门被堵死。
 */
const graveExits = (sign: 1 | -1): Vec3[] =>
  [
    { x: -10, y: 0, z: 148 },
    { x: 10, y: 0, z: 148 },
    { x: -22, y: 0, z: 158 },
    { x: 22, y: 0, z: 158 },
  ].map((p) => (sign === 1 ? p : rotPoint(p)));

const flags: readonly FlagSite[] = [
  redFlagSite,
  {
    id: 'flag_blue',
    team: TEAM_BLUE,
    position: rotPoint(redFlagSite.position),
    entrances: redFlagSite.entrances.map(rotPoint),
  },
];

/** 12.1：交旗区就是己方旗帜房 —— 这样「己方旗帜必须在基地」才是一句自然的话 */
const captureZones: readonly CaptureZone[] = [
  { id: 'capture_red', team: TEAM_RED, volume: redRoomVolume },
  { id: 'capture_blue', team: TEAM_BLUE, volume: rotAabb(redRoomVolume) },
];

const graveyards: readonly Graveyard[] = [
  {
    id: 'grave_red',
    team: TEAM_RED,
    volume: redGraveVolume,
    spawns: graveSpawns(TEAM_RED, 1),
    exits: graveExits(1),
  },
  {
    id: 'grave_blue',
    team: TEAM_BLUE,
    volume: rotAabb(redGraveVolume),
    spawns: graveSpawns(TEAM_BLUE, -1),
    exits: graveExits(-1),
  },
];

/** 路线的折线。起点是己方旗帜，终点是敌方旗帜 —— 正好是 12.5 要求量的那一段 */
const routes: readonly RouteHint[] = [
  {
    id: 'route_center',
    kind: 'center',
    waypoints: [
      { x: 0, y: 0, z: FLAG_Z },
      { x: 0, y: 0, z: 100 },
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: -100 },
      { x: 0, y: 0, z: -FLAG_Z },
    ],
    exits: [
      { x: 0, y: 0, z: ROOM_FRONT_Z },
      { x: 0, y: 0, z: -ROOM_FRONT_Z },
      { x: -20, y: 0, z: 0 },
      { x: 20, y: 0, z: 0 },
    ],
  },
  ...([-1, 1] as const).map<RouteHint>((sx) => ({
    id: sx > 0 ? 'route_flank_east' : 'route_flank_west',
    kind: 'flank',
    waypoints: [
      { x: 0, y: 0, z: FLAG_Z },
      { x: sx * 30, y: 0, z: 100 },
      { x: sx * FLANK_X, y: 0, z: 50 },
      { x: sx * FLANK_X, y: 0, z: -50 },
      { x: sx * 30, y: 0, z: -100 },
      { x: 0, y: 0, z: -FLAG_Z },
    ],
    exits: [
      { x: sx * 30, y: 0, z: 100 },
      { x: sx * 30, y: 0, z: -100 },
      { x: sx * 20, y: 0, z: 0 },
    ],
  })),
  {
    id: 'route_underground',
    kind: 'underground',
    // 井口偏在 x=±22，中线留给中央路线
    waypoints: [
      { x: 0, y: 0, z: FLAG_Z },
      { x: TRENCH_MID, y: 0, z: STAIR_Z },
      { x: TRENCH_MID, y: TUNNEL_Y, z: TUNNEL_Z },
      { x: 0, y: TUNNEL_Y, z: CORRIDOR_Z0 },
      { x: 0, y: TUNNEL_Y, z: -CORRIDOR_Z0 },
      { x: -TRENCH_MID, y: TUNNEL_Y, z: -TUNNEL_Z },
      { x: -TRENCH_MID, y: 0, z: -STAIR_Z },
      { x: 0, y: 0, z: -FLAG_Z },
    ],
    exits: [
      { x: TRENCH_MID, y: 0, z: STAIR_Z },
      { x: -TRENCH_MID, y: 0, z: -STAIR_Z },
    ],
  },
];

/**
 * 12.5：「敌人不能进入安全区域」。
 * 复活区对**敌方**禁入；地道在 6v6 下整体关闭（见 scaling）。
 */
const forbidden: readonly ForbiddenVolume[] = [
  {
    id: 'forbid_grave_red',
    volume: redGraveVolume,
    scope: { forTeam: TEAM_BLUE },
    onEnter: 'pushBack',
  },
  {
    id: 'forbid_grave_blue',
    volume: rotAabb(redGraveVolume),
    scope: { forTeam: TEAM_RED },
    onEnter: 'pushBack',
  },
  // ↓ 条件生效：只有在 scaling.extraForbidden 里点名的模式才启用
  {
    id: 'forbid_underground',
    volume: {
      min: { x: -TUNNEL_HALF_W, y: TUNNEL_Y - 1, z: -STAIR_Z },
      max: { x: TUNNEL_HALF_W, y: 0, z: STAIR_Z },
    },
    scope: 'all',
    onEnter: 'pushBack',
  },
];

/**
 * 纯装饰摆设（X1，速赢清单「夺旗图铺装饰」—— 第四轮明说的「下一铲」）。
 * ★ sim 不读（docs/06 §8.2「所见即所中」红线原样）；位置全部是地图常量的
 *   确定性函数，红方摆好、蓝方按中心对称旋转 —— 同一张图每个客户端一个样。
 * ★ 全部避开承重路线：中路 |x|<8 不放、侧翼 x=±52 两侧留 4 米、
 *   地道口（x 18..26，z 64..90）不放、旗帜房与墓地内部不放；
 *   大件全部贴外墙/端墙（墙本来就挡人，视觉与判定天然一致）。
 */
const makeCtfDecor = (): MapDecorDef[] => {
  const red: MapDecorDef[] = [];
  red.push({ model: 'props/market_stand_1', position: { x: 20, y: 0, z: 165 }, yaw: -Math.PI / 2 });

  // 西/东外墙树线（x=±69.5 贴墙，z 每 32 米一棵，红方半场 z 20..164）
  const PINES = ['foliage/pine_2', 'foliage/pine_4', 'foliage/oak_1', 'foliage/twisted_1'];
  for (let i = 0; i < 5; i++) {
    const z = 20 + i * 32;
    red.push({ model: PINES[i % PINES.length]!, position: { x: -69.5, y: 0, z }, yaw: i * 1.3 });
    red.push({ model: PINES[(i + 2) % PINES.length]!, position: { x: 69.5, y: 0, z: z + 14 }, yaw: i * 2.1 });
  }
  // 端墙两棵橡树（让开墓地 |x|<20）
  red.push({ model: 'foliage/oak_3', position: { x: -44, y: 0, z: 176 }, yaw: 0.8 });
  red.push({ model: 'foliage/oak_5', position: { x: 44, y: 0, z: 176 }, yaw: 3.9 });

  // 旗帜房正面两角的火盆 —— 旗房的地标（12.2 旗帜信息本就该显眼）
  red.push({ model: 'props/infernal_brazier', position: { x: -18.5, y: 0, z: 108 }, yaw: 0.4 });
  red.push({ model: 'props/infernal_brazier', position: { x: 18.5, y: 0, z: 108 }, yaw: -0.4 });

  // 侧翼路线外缘的补给残迹（x=±58，离 x=±52 的侧翼路线 6 米）
  red.push({ model: 'props/barrel', position: { x: -58, y: 0, z: 48 }, yaw: 1.1 });
  red.push({ model: 'props/crate_wooden', position: { x: 58, y: 0, z: 52 }, yaw: 2.6 });

  // 中场观赏点：中路两侧 10 米外各一颗半埋雕像头（|x|=10 > 中路让空 8）
  red.push({ model: 'props/statue_head', position: { x: 10.5, y: 0, z: 34 }, yaw: -0.9 });

  // 灌木散点（全部在开阔地边缘，不进任何路线走廊）
  red.push({ model: 'foliage/bush', position: { x: -36, y: 0, z: 24 }, yaw: 0.3 });
  red.push({ model: 'foliage/bush_flowers', position: { x: 34, y: 0, z: 100 }, yaw: 1.7 });
  red.push({ model: 'foliage/fern', position: { x: -40, y: 0, z: 100 }, yaw: 2.2 });

  // 蓝方半场 = 红方按中心对称旋转（rotPoint 同款），朝向加 π 保持相对关系
  const blue = red.map((d) => ({
    ...d,
    position: rotPoint(d.position),
    yaw: (d.yaw ?? 0) + Math.PI,
  }));
  return [...red, ...blue];
};

export const ctfMap: MapDef = {
  id: asMapId('ctf_twin_bridges'),
  name: '双桥要塞',
  family: 'ctf',
  modes: [GameMode.Ctf6v6, GameMode.Ctf8v8, GameMode.Ctf12v12],
  bounds: {
    min: { x: -HALF_WID, y: -20, z: -HALF_LEN },
    max: { x: HALF_WID, y: 60, z: HALF_LEN },
  },
  geometry,
  decor: makeCtfDecor(),
  // W15：清晨 —— 与竞技场的正午区分开，夺旗的长图在低角度光下层次更好读
  envPreset: 'dawn',
  forbidden,
  gates: [],
  flags,
  captureZones,
  graveyards,
  routes,
  /**
   * 19.1：同一张图服务三种人数。
   * 人少时关掉地道 —— 三条路线摊薄 6 个人会让地图空得像没人打；
   * 人多时多开复活出口，避免正门被堵（验收 #43）。
   */
  scaling: {
    [GameMode.Ctf6v6]: {
      openGates: [],
      extraForbidden: ['forbid_underground'],
      spawnsPerTeam: 6,
      graveyardExits: 2,
    },
    [GameMode.Ctf8v8]: {
      openGates: [],
      extraForbidden: [],
      spawnsPerTeam: 8,
      graveyardExits: 3,
    },
    [GameMode.Ctf12v12]: {
      openGates: [],
      extraForbidden: [],
      spawnsPerTeam: 12,
      graveyardExits: 4,
    },
  },
  fairness: {
    // 旋转对称，距离差恒为 0
    spawnToCenterDelta: 0,
    spawnToSupplyDelta: {},
    // 柱子高 5 米、房顶 standable:false，没有只有位移职业能到的落脚点
    mobilityOnlyPlatforms: [],
    tolerance: 1.0,
  },
};

// ── 12.5 的可校验量 ──────────────────────────────────────────────

/** 折线的三维长度（米）。地道那段的 6 米落差也算进去 */
export const routeLength = (route: RouteHint): number => {
  let total = 0;
  for (let i = 1; i < route.waypoints.length; i += 1) {
    const a = route.waypoints[i - 1]!;
    const b = route.waypoints[i]!;
    total += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }
  return total;
};

/** 12.5：「从己方基地到敌方旗帜房，在无战斗情况下约 35 至 45 秒」*/
export const routeSeconds = (route: RouteHint): number =>
  routeLength(route) / MOVE.BASE_SPEED;

/**
 * 12.5：「不能从复活区直接攻击旗帜房」。
 * 从己方复活点到己方旗帜应当**没有**视线 —— 否则守方能站在敌人进不来的
 * 安全区里点名旗帜房，攻方永远拔不下来。
 */
export const graveyardSeesFlag = (map: MapDef, team: TeamId): boolean => {
  const grave = map.graveyards?.find((g) => g.team === team);
  const flag = map.flags?.find((f) => f.team === team);
  if (!grave || !flag) return false;
  // hasLineOfSight 内部已经抬到胸口高度，这里传脚底位置就行
  return grave.spawns.some((s) =>
    hasLineOfSight({ position: s.position }, { position: flag.position }, map.geometry),
  );
};

export const CTF_MAP_METRICS = {
  routeSeconds: Object.fromEntries(routes.map((r) => [r.id, routeSeconds(r)])),
} as const;
