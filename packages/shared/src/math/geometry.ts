/**
 * 命中判定几何。这是「所见即所中」的唯一真相来源 —— 客户端画的指示器和
 * 服务器的判定必须调用同一批函数（验收 #8：真实范围边界与实际判定一致）。
 *
 * 相关设计条款：
 *   6.2 近战距离以碰撞体边缘计算，不以模型宽度/武器尖端计算
 *   6.3 六种范围形状
 *   6.4 视线以胸口到胸口判断
 *   6.5 正面 180°、背后 120°
 *  13.2 所有人形职业使用一致的战斗碰撞体
 */

import { GEOMETRY } from '../constants/combat.js';
import {
  DEG,
  angleDelta,
  clamp,
  cross,
  distance,
  distance2D,
  dirToYaw,
  dot,
  lengthSq,
  normalize2D,
  sub,
  vec3,
  yawToDir,
  type Vec3,
} from './vec3.js';

/** 参与判定的最小单位描述。sim 层的实体和客户端的预览都能塞进这个形状 */
export interface HitCircle {
  /** 脚底位置 */
  position: Vec3;
  /** 战斗碰撞体半径，默认统一值 */
  radius?: number;
  /** 碰撞体高度，默认统一值 */
  height?: number;
}

export const radiusOf = (c: HitCircle): number => c.radius ?? GEOMETRY.HITBOX_RADIUS;
export const heightOf = (c: HitCircle): number => c.height ?? GEOMETRY.HITBOX_HEIGHT;

/** 胸口点：视线与远程距离判定都用它（6.2 / 6.4）*/
export const chestOf = (c: HitCircle): Vec3 =>
  vec3(c.position.x, c.position.y + GEOMETRY.CHEST_HEIGHT, c.position.z);

/**
 * 6.2 近战距离：双方统一战斗碰撞体「边缘之间」的水平距离。
 * 返回值可能为负（碰撞体重叠），调用方按 <= max 判断即可。
 */
export const edgeDistance = (a: HitCircle, b: HitCircle): number =>
  distance2D(a.position, b.position) - radiusOf(a) - radiusOf(b);

/** 近战是否在武器距离内。额外检查高度差，避免隔着悬崖互砍 */
export const inMeleeRange = (a: HitCircle, b: HitCircle, weaponReach: number): boolean => {
  if (Math.abs(a.position.y - b.position.y) > GEOMETRY.VERTICAL_TOLERANCE) return false;
  return edgeDistance(a, b) <= weaponReach;
};

/**
 * 6.2 远程距离：施法者胸口到目标胸口的空间距离，同样扣掉目标碰撞体半径，
 * 这样贴着 30 米边缘的大体型目标不会因为「中心点差 0.1 米」而落空。
 */
export const rangedDistance = (a: HitCircle, b: HitCircle): number =>
  Math.max(0, distance(chestOf(a), chestOf(b)) - radiusOf(b));

export const inRangedRange = (a: HitCircle, b: HitCircle, maxRange: number): boolean =>
  rangedDistance(a, b) <= maxRange;

/** 统一入口：近战距离（<= 4 米）走边缘判定，其余走胸口判定 */
export const inRange = (a: HitCircle, b: HitCircle, maxRange: number, minRange = 0): boolean => {
  const d = maxRange <= 4 ? edgeDistance(a, b) : rangedDistance(a, b);
  if (maxRange <= 4 && Math.abs(a.position.y - b.position.y) > GEOMETRY.VERTICAL_TOLERANCE) {
    return false;
  }
  return d <= maxRange && d >= minRange;
};

// ── 6.5 朝向 ─────────────────────────────────────────────────────

/**
 * 目标是否位于 actor 前方 arcDeg 度的扇形内（默认 180°）。
 * 注意：只旋转镜头不改变角色朝向，所以这里传的必须是**角色 yaw**，不是镜头 yaw。
 */
export const isFacing = (
  actorPos: Vec3,
  actorYaw: number,
  targetPos: Vec3,
  arcDeg = 180,
): boolean => {
  const toTarget = normalize2D(sub(targetPos, actorPos));
  if (lengthSq(toTarget) < 1e-12) return true; // 完全重叠时不卡朝向
  const targetYaw = dirToYaw(toTarget);
  return angleDelta(actorYaw, targetYaw) <= (arcDeg / 2) * DEG;
};

/** 攻击者是否处于目标背后 arcDeg 度区域（背刺，默认 120°）*/
export const isBehind = (
  attackerPos: Vec3,
  targetPos: Vec3,
  targetYaw: number,
  arcDeg = 120,
): boolean => {
  const toAttacker = normalize2D(sub(attackerPos, targetPos));
  if (lengthSq(toAttacker) < 1e-12) return false;
  const backYaw = dirToYaw(toAttacker);
  const targetBackYaw = targetYaw + Math.PI;
  return angleDelta(targetBackYaw, backYaw) <= (arcDeg / 2) * DEG;
};

// ── 6.3 范围形状命中 ─────────────────────────────────────────────

/** 圆形：中心点 + 半径。目标碰撞体擦到边界即算命中 */
export const hitCircle = (center: Vec3, radius: number, target: HitCircle): boolean =>
  distance2D(center, target.position) <= radius + radiusOf(target);

/**
 * 环形：内半径 + 外半径。
 * 内边界用「完全在内圈里才算安全」，即碰撞体只要有一部分落在环带上就命中。
 */
export const hitRing = (
  center: Vec3,
  innerRadius: number,
  outerRadius: number,
  target: HitCircle,
): boolean => {
  const d = distance2D(center, target.position);
  const r = radiusOf(target);
  return d <= outerRadius + r && d >= innerRadius - r;
};

/**
 * 锥形：角色前方 angleDeg 度、range 米的扇形。
 * 角度判定按碰撞体切线补偿：贴脸的大目标不会因为中心点差半度而漏掉。
 */
export const hitCone = (
  origin: Vec3,
  yaw: number,
  angleDeg: number,
  range: number,
  target: HitCircle,
): boolean => {
  const r = radiusOf(target);
  const toTarget = sub(target.position, origin);
  const d = Math.hypot(toTarget.x, toTarget.z);
  if (d > range + r) return false;
  if (d <= r) return true; // 贴身：一定在扇形内

  const half = (angleDeg / 2) * DEG;
  const targetYaw = dirToYaw(normalize2D(toTarget));
  const angular = angleDelta(yaw, targetYaw);
  // asin(r/d) 是碰撞体在该距离上张开的半角
  return angular <= half + Math.asin(clamp(r / d, -1, 1));
};

/** 点到线段的最短水平距离，兼作直线技能与投射物碰撞的基础 */
export const distanceToSegment2D = (p: Vec3, a: Vec3, b: Vec3): number => {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const denom = abx * abx + abz * abz;
  if (denom < 1e-12) return Math.hypot(p.x - a.x, p.z - a.z);
  const t = clamp(((p.x - a.x) * abx + (p.z - a.z) * abz) / denom, 0, 1);
  return Math.hypot(p.x - (a.x + abx * t), p.z - (a.z + abz * t));
};

/** 直线：长度 + 宽度的胶囊体（穿透箭、冲击波）*/
export const hitLine = (
  origin: Vec3,
  yaw: number,
  length: number,
  width: number,
  target: HitCircle,
): boolean => {
  const dir = yawToDir(yaw);
  const end = vec3(origin.x + dir.x * length, origin.y, origin.z + dir.z * length);
  return distanceToSegment2D(target.position, origin, end) <= width / 2 + radiusOf(target);
};

/** 链式跳转：从 from 出发，在 jumpRange 内找最近的未命中目标 */
export const nextChainTarget = <T extends HitCircle>(
  from: Vec3,
  candidates: readonly T[],
  jumpRange: number,
  alreadyHit: ReadonlySet<T>,
): T | undefined => {
  let best: T | undefined;
  let bestD = Infinity;
  for (const c of candidates) {
    if (alreadyHit.has(c)) continue;
    const d = distance2D(from, c.position);
    if (d <= jumpRange && d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
};

// ── 6.4 视线与障碍物 ─────────────────────────────────────────────

/**
 * 轴对齐包围盒。首版地图用 AABB 组合描述墙体/柱子/屋顶，足够且极快。
 *
 * 这四个 flag 全部是**判定属性**。渲染用的语义标签在 `data/maps/schema.ts`
 * 的 `MapVolume.tag` 上，判定层一律不读它 —— 靠字符串标签做判定会让
 * 「改个渲染分类顺手改了碰撞行为」这种事悄悄发生。
 */
export interface Aabb {
  min: Vec3;
  max: Vec3;
  /** 6.4：低矮栏杆只挡脚部，不应造成「无视线」。标记为 false 的物体不参与视线判定 */
  blocksSight?: boolean;
  /** 是否阻挡移动 */
  blocksMovement?: boolean;
  /** 顶面是否可站立。false 表示装饰体，角色和位移技能都不能落在上面 */
  standable?: boolean;
  /** 13.5：深水可终止坠落伤害 */
  endsFallDamage?: boolean;
}

// ── 障碍物空间索引（性能优化，判定语义零改动）──────────────────
//
// ★★ 容量探针（docs/15 P11 问答）定位的第一 CPU 热点不是 O(n²) 的实体
//   两两分离（那只占 sim 的 6%），而是 **O(实体 × 障碍) 的线性扫描**：
//   ctf_twin_bridges 有 128 个 AABB，12v12 一个 tick 里移动解算 + 视线
//   判定要对它们扫上千遍 —— 76% 的 tickWorld、83% 的 bot 决策耗在这里。
//
// ★ 均匀网格按 XZ 分格。一个盒子插进它跨越的**每一个**格子，查询按
//   范围取覆盖到的格子并**不去重** —— 这是刻意的：所有消费方的谓词都
//   与访问顺序无关且对重复访问幂等（collides/isInWater 是布尔 OR、
//   hasLineOfSight 是布尔 AND、findGroundY 取 max、segmentClipT 取 min），
//   所以「超集 + 可能重复」与「全集恰好一遍」逐位同解。往消费方加
//   新谓词前先确认这条性质还成立。
//
// ★ 小地图不建索引（竞技场只有 ~10 个盒子，线性更快也更简单）——
//   `obstaclesInRect` 直接返回原数组，既有路径一寸不动。

/** 格边长（米）。8m ≈ 两个碰撞体直径的 5 倍，144×360 的夺旗图 ~810 格 */
const INDEX_CELL_SIZE = 8;
/** 盒子数低于这个值不值得建索引（哈希/边界开销超过省下的比较） */
const INDEX_MIN_OBSTACLES = 16;

interface ObstacleIndex {
  minX: number;
  minZ: number;
  cols: number;
  rows: number;
  /** cols × rows，行优先。undefined = 空格子（稀疏，省内存） */
  cells: (Aabb[] | undefined)[];
}

/** 索引按数组**身份**缓存 —— `world.obstacles` 建世界时设一次后不再换引用 */
const INDEX_CACHE = new WeakMap<readonly Aabb[], ObstacleIndex | null>();

const buildObstacleIndex = (obstacles: readonly Aabb[]): ObstacleIndex => {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const b of obstacles) {
    if (b.min.x < minX) minX = b.min.x;
    if (b.min.z < minZ) minZ = b.min.z;
    if (b.max.x > maxX) maxX = b.max.x;
    if (b.max.z > maxZ) maxZ = b.max.z;
  }
  const cols = Math.max(1, Math.ceil((maxX - minX) / INDEX_CELL_SIZE));
  const rows = Math.max(1, Math.ceil((maxZ - minZ) / INDEX_CELL_SIZE));
  const cells: (Aabb[] | undefined)[] = new Array(cols * rows);
  for (const b of obstacles) {
    const c0 = clampCell(Math.floor((b.min.x - minX) / INDEX_CELL_SIZE), cols);
    const c1 = clampCell(Math.floor((b.max.x - minX) / INDEX_CELL_SIZE), cols);
    const r0 = clampCell(Math.floor((b.min.z - minZ) / INDEX_CELL_SIZE), rows);
    const r1 = clampCell(Math.floor((b.max.z - minZ) / INDEX_CELL_SIZE), rows);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        (cells[r * cols + c] ??= []).push(b);
      }
    }
  }
  return { minX, minZ, cols, rows, cells };
};

const clampCell = (i: number, n: number): number => (i < 0 ? 0 : i >= n ? n - 1 : i);

const obstacleIndexFor = (obstacles: readonly Aabb[]): ObstacleIndex | undefined => {
  if (obstacles.length < INDEX_MIN_OBSTACLES) return undefined;
  let idx = INDEX_CACHE.get(obstacles);
  if (idx === undefined) {
    idx = buildObstacleIndex(obstacles);
    INDEX_CACHE.set(obstacles, idx);
  }
  return idx ?? undefined;
};

/**
 * XZ 矩形 [minX,maxX]×[minZ,maxZ] 可能触到的障碍物候选集。
 *
 * ★ 返回值是**超集且可能含重复**（见文件内索引一节的 ★★），消费方谓词
 *   必须幂等。无索引时返回原数组本身。
 * ★ `out` 由调用方持有并复用（模块级 scratch），避免热路径上每查询一次
 *   分配一个数组。**返回值的生命周期只到该调用方的下一次查询** ——
 *   不要跨查询持有。
 */
export const obstaclesInRect = (
  obstacles: readonly Aabb[],
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  out: Aabb[],
): readonly Aabb[] => {
  const idx = obstacleIndexFor(obstacles);
  if (!idx) return obstacles;
  out.length = 0;
  const c0 = clampCell(Math.floor((minX - idx.minX) / INDEX_CELL_SIZE), idx.cols);
  const c1 = clampCell(Math.floor((maxX - idx.minX) / INDEX_CELL_SIZE), idx.cols);
  const r0 = clampCell(Math.floor((minZ - idx.minZ) / INDEX_CELL_SIZE), idx.rows);
  const r1 = clampCell(Math.floor((maxZ - idx.minZ) / INDEX_CELL_SIZE), idx.rows);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const cell = idx.cells[r * idx.cols + c];
      if (cell) for (const b of cell) out.push(b);
    }
  }
  return out;
};

/** hasLineOfSight / isGroundPositionLegal 的 scratch（见 obstaclesInRect 的 ★） */
const LOS_SCRATCH: Aabb[] = [];
/** segmentClipT 的 scratch。与 LOS 分开：clampDisplacement 内部两者可能连用 */
const CLIP_SCRATCH: Aabb[] = [];

/**
 * 线段 vs AABB（slab 方法）。返回是否相交。
 */
export const segmentIntersectsAabb = (a: Vec3, b: Vec3, box: Aabb): boolean => {
  let tmin = 0;
  let tmax = 1;
  const d = sub(b, a);

  for (const axis of ['x', 'y', 'z'] as const) {
    const da = d[axis];
    const origin = a[axis];
    const lo = box.min[axis];
    const hi = box.max[axis];

    if (Math.abs(da) < 1e-9) {
      if (origin < lo || origin > hi) return false;
      continue;
    }
    let t1 = (lo - origin) / da;
    let t2 = (hi - origin) / da;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }
  return true;
};

/**
 * 6.4 视线：施法者胸口 → 目标胸口，被任意 blocksSight 的 AABB 挡住即无视线。
 * 低矮栏杆请把 blocksSight 设为 false。
 */
export const hasLineOfSight = (
  from: HitCircle,
  to: HitCircle,
  obstacles: readonly Aabb[],
): boolean => {
  const a = chestOf(from);
  const b = chestOf(to);
  // 候选集按线段的 XZ 包围盒取（超集，谓词是布尔 AND —— 幂等，见索引一节）
  const candidates = obstaclesInRect(
    obstacles,
    Math.min(a.x, b.x), Math.min(a.z, b.z),
    Math.max(a.x, b.x), Math.max(a.z, b.z),
    LOS_SCRATCH,
  );
  for (const box of candidates) {
    if (box.blocksSight === false) continue;
    if (segmentIntersectsAabb(a, b, box)) return false;
  }
  return true;
};

/**
 * 6.4 地面范围不能穿过封闭墙体放置：指示器中心必须对施法者可见。
 * 判定用施法者胸口 → 落点上方 0.5 米（避免贴地被地形自身挡住）。
 */
export const isGroundPositionLegal = (
  caster: HitCircle,
  groundPoint: Vec3,
  obstacles: readonly Aabb[],
): boolean => {
  const a = chestOf(caster);
  const b = vec3(groundPoint.x, groundPoint.y + 0.5, groundPoint.z);
  const candidates = obstaclesInRect(
    obstacles,
    Math.min(a.x, b.x), Math.min(a.z, b.z),
    Math.max(a.x, b.x), Math.max(a.z, b.z),
    LOS_SCRATCH,
  );
  for (const box of candidates) {
    if (box.blocksSight === false) continue;
    if (segmentIntersectsAabb(a, b, box)) return false;
  }
  return true;
};

/**
 * 6.4 自身中心范围不会穿过封闭房间的完整墙体。
 * 与地面技能同理：对每个候选目标做一次视线检查。
 */
export const filterByLineOfSight = <T extends HitCircle>(
  source: HitCircle,
  targets: readonly T[],
  obstacles: readonly Aabb[],
): T[] => targets.filter((t) => hasLineOfSight(source, t, obstacles));

// ── 6.6 碰撞型投射物 ─────────────────────────────────────────────

export interface ProjectileHit<T> {
  target: T;
  /** 沿飞行方向的参数 t ∈ [0,1] */
  t: number;
}

/**
 * 碰撞投射物在本 tick 的位移段上命中的第一个目标。
 * 墙体阻挡请先用 segmentIntersectsAabb 把线段截断再调用。
 */
export const firstProjectileHit = <T extends HitCircle>(
  from: Vec3,
  to: Vec3,
  projectileRadius: number,
  candidates: readonly T[],
): ProjectileHit<T> | undefined => {
  let best: ProjectileHit<T> | undefined;
  const seg = sub(to, from);
  const segLenSq = seg.x * seg.x + seg.z * seg.z;

  for (const c of candidates) {
    const r = radiusOf(c) + projectileRadius;
    // 高度粗筛：投射物与碰撞体在竖直方向要有重叠
    if (to.y < c.position.y - 0.5 || to.y > c.position.y + heightOf(c) + 0.5) continue;
    if (distanceToSegment2D(c.position, from, to) > r) continue;

    const toC = sub(c.position, from);
    const t = segLenSq < 1e-12 ? 0 : clamp((toC.x * seg.x + toC.z * seg.z) / segLenSq, 0, 1);
    if (!best || t < best.t) best = { target: c, t };
  }
  return best;
};

/** 线段被墙体截断后的最近命中点参数 t，没有命中返回 1 */
export const segmentClipT = (a: Vec3, b: Vec3, obstacles: readonly Aabb[]): number => {
  let best = 1;
  // 谓词取 min（与访问顺序无关、可重复访问），候选集见索引一节
  const candidates = obstaclesInRect(
    obstacles,
    Math.min(a.x, b.x), Math.min(a.z, b.z),
    Math.max(a.x, b.x), Math.max(a.z, b.z),
    CLIP_SCRATCH,
  );
  for (const box of candidates) {
    if (box.blocksMovement === false) continue;
    if (!segmentIntersectsAabb(a, b, box)) continue;
    // 二分求最早相交参数，10 次足够到厘米级
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 10; i++) {
      const mid = (lo + hi) / 2;
      const p = vec3(a.x + (b.x - a.x) * mid, a.y + (b.y - a.y) * mid, a.z + (b.z - a.z) * mid);
      if (segmentIntersectsAabb(a, p, box)) hi = mid;
      else lo = mid;
    }
    best = Math.min(best, hi);
  }
  return best;
};

// ── 13.5 位移技能合法落点 ────────────────────────────────────────

/**
 * 13.5 / 验收 #46：冲锋、闪现、后跃、拉拽都必须停在合法可站立位置。
 * 从起点向目标点推进，遇到墙体就停在墙前，返回最终合法点。
 */
export const clampDisplacement = (
  from: Vec3,
  to: Vec3,
  actorRadius: number,
  obstacles: readonly Aabb[],
): Vec3 => {
  const a = vec3(from.x, from.y + GEOMETRY.CHEST_HEIGHT * 0.5, from.z);
  const b = vec3(to.x, to.y + GEOMETRY.CHEST_HEIGHT * 0.5, to.z);
  const t = segmentClipT(a, b, obstacles);
  if (t >= 1) return vec3(to.x, to.y, to.z);
  // 退回一个身位，保证角色不会卡进墙里
  const total = distance2D(from, to);
  const safeT = total < 1e-6 ? 0 : Math.max(0, t - actorRadius / total);
  return vec3(
    from.x + (to.x - from.x) * safeT,
    from.y + (to.y - from.y) * safeT,
    from.z + (to.z - from.z) * safeT,
  );
};

export { cross, dot };
