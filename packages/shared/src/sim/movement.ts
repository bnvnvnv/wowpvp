/**
 * 移动物理。规格书 13.5，验收 #44 / #45 / #46。
 *
 * ⚠️ 这份代码**客户端和服务器共用**：服务器用它做权威模拟，客户端用它做预测与回放
 * （见 docs/08-network-protocol.md §5）。因此它必须是确定性的纯函数 ——
 * 不读时钟、不用随机数、不碰 DOM。同样的输入序列必须得到逐位相同的结果。
 *
 * 角色用**竖直圆柱体**近似（XZ 圆 + Y 区间），不是胶囊。
 * 理由：地图几何全是 AABB，圆柱-AABB 的判定是闭式解且完全确定，
 * 而胶囊的圆角在这里不产生任何玩法差异，只增加数值误差来源。
 */

import { GEOMETRY, MOVE } from '../constants/combat.js';
import { obstaclesInRect, type Aabb } from '../math/geometry.js';
import { clamp, vec3, yawToDir, type Vec3 } from '../math/vec3.js';

// ── 调参 ─────────────────────────────────────────────────────────

export const MOVEMENT = {
  GRAVITY: 22,
  /** 起跳初速。22 的重力下跳起约 1.18 米 —— 够上台阶，不够爬 3 米高台 */
  JUMP_SPEED: 7.2,
  /**
   * 13.5「跳跃允许有限空中修正」的修正强度，相对基础速度。
   * 0.25 意味着空中转向明显比地面迟钝，但不至于完全失控。
   */
  AIR_CONTROL: 0.25,
  /** 地面加速度。够快到没有「冰面感」，又不至于瞬间达到满速 */
  GROUND_ACCEL: 60,
  GROUND_FRICTION: 14,
  /** 浮点容差，避免误差把角色留在墙面内侧或在地面上抖动 */
  SKIN: 1e-3,
  /** 向下探地距离，用于楼梯与下坡贴地 */
  GROUND_SNAP: GEOMETRY.STEP_HEIGHT,
  /** 玩家之间的软推开强度（13.5：不形成完全实体堵门）*/
  SEPARATION_STRENGTH: 8,
  /** 位移超过这个值视为传送，动画层不得识别为高速跑步（13.4 / 验收 #47）*/
  TELEPORT_THRESHOLD: 3,
  /** 坠落伤害起算高度 */
  FALL_DAMAGE_HEIGHT: 8,
} as const;

/** 位移技能落点向下探地的最大距离 */
const TELEPORT_GROUND_SEARCH = 50;

// ── 状态与输入 ───────────────────────────────────────────────────

export interface MovementInput {
  /** 前后，-1..1。后退会自动应用 BACKWARD_FACTOR */
  forward: number;
  /** 左右侧移，-1..1 */
  strafe: number;
  jump: boolean;
  /** 角色朝向（**不是镜头朝向**，见 6.5）*/
  yaw: number;
}

/**
 * 控制效果对移动的锁定档位（8.x 控制语义的移动侧）：
 *   · 'move' —— 定身：不能位移、不能起跳，但可以转身（entity.ts：「定身：
 *     无法移动，但可以施法和攻击」—— 攻击要求朝向，禁转身等于附赠缴械）。
 *   · 'full' —— 昏迷/恐惧（7.3 都置 stunned，「无法行动」）：连转身一起锁。
 *
 * ★ 只锁**意图**不锁物理：重力、摩擦、软推开照常积分 —— 定身在空中照样
 *   落地，被人挤照样让位（A2 的教训：控制不是免除物理的理由）。
 * ★ 它与 `speedMultiplier` 同族，是积分的**输入**不是 `MovementState` 的
 *   一部分 —— 三条积分路径（tickWorld / Predictor / TestbedScene）必须同源，
 *   联网侧随 `selfMovement` 下发（visibility.ts）。
 * ★ 此前 `flags.rooted` 在移动积分链上是**零消费方**：定身的光环只置标志，
 *   减速链（moveSpeedMultiplierOf）不认它 —— 「定身的战士照样追人」
 *   （2026-08-09 X10 真机轮实测发现）。
 */
export type MovementLock = 'none' | 'move' | 'full';

/** 从状态标志派生移动锁。feared 在 deriveStatusFlags 里已并入 stunned */
export const movementLockOf = (
  flags: { stunned: boolean; rooted: boolean },
): MovementLock => (flags.stunned ? 'full' : flags.rooted ? 'move' : 'none');

export interface MovementState {
  position: Vec3;
  velocity: Vec3;
  yaw: number;
  grounded: boolean;
  /**
   * 起跳瞬间的水平速度模长。
   * 验收 #45「不能增速」靠它做上限钳制 —— 只限制加速度是不够的，
   * 玩家可以在空中反复画圈累积速度（经典 bunny-hop）。
   */
  airSpeedCap: number;
  /** 开始下落时的高度，落地时算落差 */
  fallStartY: number;
  /** 本 tick 的实际水平位移距离，供动画状态机使用 */
  lastHorizontalDistance: number;
  /** 本 tick 是否发生了传送级别的位置跳变 */
  teleported: boolean;
}

export const createMovementState = (position: Vec3, yaw = 0): MovementState => ({
  position: vec3(position.x, position.y, position.z),
  velocity: vec3(0, 0, 0),
  yaw,
  grounded: false,
  airSpeedCap: MOVE.BASE_SPEED,
  fallStartY: position.y,
  lastHorizontalDistance: 0,
  teleported: false,
});

/** 落地事件，供客户端播放反馈、服务器结算坠落伤害 */
export interface LandingEvent {
  fallHeight: number;
  /** 13.5：深水可终止坠落伤害 */
  intoWater: boolean;
}

// ── 碰撞基元 ─────────────────────────────────────────────────────

/** 只参与移动阻挡的体积 */
const blocksMove = (b: Aabb): boolean => b.blocksMovement !== false;

/**
 * 竖直圆柱体与 AABB 是否相交。
 * XZ 用「圆心到矩形最近点」的距离，Y 用区间重叠。
 */
export const cylinderOverlapsAabb = (
  footPosition: Vec3,
  radius: number,
  height: number,
  box: Aabb,
): boolean => {
  if (footPosition.y >= box.max.y || footPosition.y + height <= box.min.y) return false;
  const cx = clamp(footPosition.x, box.min.x, box.max.x);
  const cz = clamp(footPosition.z, box.min.z, box.max.z);
  const dx = footPosition.x - cx;
  const dz = footPosition.z - cz;
  return dx * dx + dz * dz < radius * radius;
};

/**
 * 点查询的候选集 scratch（见 `obstaclesInRect` 的 ★）。三个查询各一份 ——
 * `tryStepUp` 里 `collides` 与 `findGroundY` 会连用，共享一份会互相覆盖。
 */
const COLLIDE_SCRATCH: Aabb[] = [];
const GROUND_SCRATCH: Aabb[] = [];
const WATER_SCRATCH: Aabb[] = [];

const collides = (
  p: Vec3,
  radius: number,
  height: number,
  obstacles: readonly Aabb[],
): boolean => {
  // 候选集 = 圆柱 XZ 包围矩形触到的格子（超集，谓词是布尔 OR —— 幂等）
  const candidates = obstaclesInRect(
    obstacles, p.x - radius, p.z - radius, p.x + radius, p.z + radius, COLLIDE_SCRATCH,
  );
  for (const b of candidates) {
    if (!blocksMove(b)) continue;
    if (cylinderOverlapsAabb(p, radius, height, b)) return true;
  }
  return false;
};

/**
 * 在竖直区间 [p.y - maxDrop, p.y] 内找最高的可站立面。
 *
 * ⚠️ 这是一个**扫掠**查询，不是点查询。调用方必须把 p.y 设成本 tick 的**起始**高度、
 * maxDrop 覆盖到本 tick 的**结束**高度，否则高速下落时会在一帧内穿过整个地面 ——
 * 60fps 下自由落体第二秒就有 0.16 米/帧的位移，点查询必漏。
 */
export const findGroundY = (
  p: Vec3,
  radius: number,
  obstacles: readonly Aabb[],
  maxDrop: number,
): number | undefined => {
  let best: number | undefined;
  const lo = p.y - maxDrop;
  // 谓词取 max（严格大于，等值保留先到者但数值相同）—— 与访问顺序无关
  const candidates = obstaclesInRect(
    obstacles, p.x - radius, p.z - radius, p.x + radius, p.z + radius, GROUND_SCRATCH,
  );
  for (const b of candidates) {
    if (!blocksMove(b)) continue;
    if (b.standable === false) continue;
    // 顶面必须落在 [lo, p.y + SKIN] 区间内
    if (b.max.y > p.y + MOVEMENT.SKIN || b.max.y < lo) continue;
    // XZ 上要真的踩在它上面
    const cx = clamp(p.x, b.min.x, b.max.x);
    const cz = clamp(p.z, b.min.z, b.max.z);
    const dx = p.x - cx;
    const dz = p.z - cz;
    if (dx * dx + dz * dz >= radius * radius) continue;
    if (best === undefined || b.max.y > best) best = b.max.y;
  }
  return best;
};

// ── 水平移动：逐轴解算 + 自动跨越低障碍 ──────────────────────────

/**
 * 13.5「斜向碰撞时沿墙滑动，墙角不高频抖动」。
 *
 * 用**逐轴解算**而不是「碰撞法线投影」：地图几何全是轴对齐 AABB，
 * 逐轴解算在这种场景下给出的滑动是精确的，且天然不会在墙角来回抖 ——
 * 法线投影法在两面墙夹角处会因为每帧选中不同的法线而产生高频抖动。
 */
const moveAndSlide = (
  from: Vec3,
  delta: Vec3,
  radius: number,
  height: number,
  obstacles: readonly Aabb[],
): Vec3 => {
  const tryMove = (p: Vec3, dx: number, dz: number): Vec3 | undefined => {
    const next = vec3(p.x + dx, p.y, p.z + dz);
    return collides(next, radius, height, obstacles) ? undefined : next;
  };

  let pos = vec3(from.x, from.y, from.z);

  // 先试完整位移
  const full = tryMove(pos, delta.x, delta.z);
  if (full) return full;

  // 被挡住 → 逐轴各试一次。对轴对齐 AABB 而言这一轮就是精确解，
  // 不需要迭代：X 通过则贴着 Z 向的墙滑动，Z 通过则贴着 X 向的墙滑动，
  // 墙角处两轴都不通过，角色停住 —— 不会产生法线投影法那种每帧换法线的抖动。
  const alongX = tryMove(pos, delta.x, 0);
  if (alongX) pos = alongX;
  const alongZ = tryMove(pos, 0, delta.z);
  if (alongZ) pos = alongZ;

  return pos;
};

/**
 * 13.5「小台阶、路缘和低石块可自动跨越，不因微小装饰停止」。
 *
 * 被挡住时抬高 STEP_HEIGHT 重试；成功后必须能落回地面，否则说明抬上去是悬空的，
 * 那不是台阶而是墙，要撤销。
 */
const tryStepUp = (
  from: Vec3,
  delta: Vec3,
  radius: number,
  height: number,
  obstacles: readonly Aabb[],
): Vec3 | undefined => {
  const raised = vec3(from.x, from.y + GEOMETRY.STEP_HEIGHT, from.z);
  if (collides(raised, radius, height, obstacles)) return undefined;

  const advanced = vec3(raised.x + delta.x, raised.y, raised.z + delta.z);
  if (collides(advanced, radius, height, obstacles)) return undefined;

  const groundY = findGroundY(advanced, radius, obstacles, GEOMETRY.STEP_HEIGHT * 2);
  if (groundY === undefined) return undefined;
  // 只接受「向上迈」，向下的交给正常的贴地逻辑
  if (groundY < from.y - MOVEMENT.SKIN) return undefined;

  return vec3(advanced.x, groundY, advanced.z);
};

// ── 主循环 ───────────────────────────────────────────────────────

export interface StepResult {
  state: MovementState;
  landing?: LandingEvent;
}

/**
 * 推进一个 tick。**纯函数**：不修改传入的 state，返回新的。
 */
export const stepMovement = (
  prev: MovementState,
  input: MovementInput,
  dt: number,
  obstacles: readonly Aabb[],
  opts: {
    radius?: number; height?: number; speedMultiplier?: number;
    /** 控制效果的移动锁（定身/昏迷）。见 `MovementLock` 的注释 */
    lock?: MovementLock;
    /**
     * 13.5 / 验收 #43：来自其他角色的**软推开**分离速度（`separationVelocity()`）。
     * ★ 只参与本步的位移积分，**不写进 `velocity`** —— 推开是外力位移不是动量，
     *   混进速度会让「被推了一下」在松手后继续滑行。
     * ★ 走步骤 5 的 `moveAndSlide`，所以推不进墙、推不出合法区 —— 与玩家
     *   自己的移动受同一套碰撞约束，不需要单独的钳制路径。
     */
    separation?: Vec3;
  } = {},
): StepResult => {
  const radius = opts.radius ?? GEOMETRY.HITBOX_RADIUS;
  const height = opts.height ?? GEOMETRY.HITBOX_HEIGHT;
  const speedMul = opts.speedMultiplier ?? 1;
  const sep = opts.separation ?? { x: 0, y: 0, z: 0 };
  const lock = opts.lock ?? 'none';
  // 锁移动 = 意图归零（重力/摩擦/软推开在下面照常走）；'full' 连转身一起锁
  const wishForward = lock === 'none' ? input.forward : 0;
  const wishStrafe = lock === 'none' ? input.strafe : 0;

  const s: MovementState = {
    ...prev,
    position: vec3(prev.position.x, prev.position.y, prev.position.z),
    velocity: vec3(prev.velocity.x, prev.velocity.y, prev.velocity.z),
    yaw: lock === 'full' ? prev.yaw : input.yaw,
    teleported: false,
  };

  // ── 1. 期望的水平速度 ──────────────────────────────────────
  // 8.1：后退约为前进的 65%，侧移与前进相同
  const fwdScale = wishForward >= 0 ? 1 : MOVE.BACKWARD_FACTOR;
  const forward = yawToDir(s.yaw);
  const right = vec3(-forward.z, 0, forward.x);

  let wishX = forward.x * wishForward * fwdScale + right.x * wishStrafe * MOVE.STRAFE_FACTOR;
  let wishZ = forward.z * wishForward * fwdScale + right.z * wishStrafe * MOVE.STRAFE_FACTOR;
  const wishLen = Math.hypot(wishX, wishZ);
  if (wishLen > 1) {
    // 斜向输入不应该比直线快
    wishX /= wishLen;
    wishZ /= wishLen;
  }

  const maxSpeed = MOVE.BASE_SPEED * speedMul;
  const targetVx = wishX * maxSpeed;
  const targetVz = wishZ * maxSpeed;

  // ── 2. 加速 ───────────────────────────────────────────────
  if (s.grounded) {
    const accel = MOVEMENT.GROUND_ACCEL * dt;
    s.velocity.x += clamp(targetVx - s.velocity.x, -accel, accel);
    s.velocity.z += clamp(targetVz - s.velocity.z, -accel, accel);
    if (wishLen < 1e-6) {
      const f = Math.max(0, 1 - MOVEMENT.GROUND_FRICTION * dt);
      s.velocity.x *= f;
      s.velocity.z *= f;
    }
  } else {
    // 13.5「允许有限空中修正，但不能增加总速度或瞬间反向」
    const airAccel = MOVE.BASE_SPEED * MOVEMENT.AIR_CONTROL * dt;
    s.velocity.x += clamp(targetVx - s.velocity.x, -airAccel, airAccel);
    s.velocity.z += clamp(targetVz - s.velocity.z, -airAccel, airAccel);

    // ★ 验收 #45：钳制水平速度模长不超过起跳时的值。
    // 只限加速度挡不住「空中画圈累积速度」，必须钳模长。
    const speed = Math.hypot(s.velocity.x, s.velocity.z);
    if (speed > s.airSpeedCap && speed > 1e-6) {
      const k = s.airSpeedCap / speed;
      s.velocity.x *= k;
      s.velocity.z *= k;
    }
  }

  // ── 3. 跳跃 ───────────────────────────────────────────────
  // 4.2「普通跳跃，无连续二段跳」：只有 grounded 时才能起跳；
  // 定身/昏迷下起跳也是位移（8.x「无法移动」），一并锁
  if (input.jump && s.grounded && lock === 'none') {
    s.velocity.y = MOVEMENT.JUMP_SPEED;
    s.grounded = false;
    s.fallStartY = s.position.y;
    // 起跳瞬间锁定空中速度上限
    s.airSpeedCap = Math.max(Math.hypot(s.velocity.x, s.velocity.z), MOVE.BASE_SPEED * 0.5);
  }

  // ── 4. 重力 ───────────────────────────────────────────────
  if (!s.grounded) {
    s.velocity.y -= MOVEMENT.GRAVITY * dt;
    if (s.velocity.y < 0 && s.position.y > s.fallStartY) s.fallStartY = s.position.y;
  }

  // ── 5. 水平位移：滑墙 + 跨越低障碍 ────────────────────────
  const startX = s.position.x;
  const startZ = s.position.z;
  // ★ 分离速度只进位移不进 velocity（见 opts.separation 注释）
  const delta = vec3((s.velocity.x + sep.x) * dt, 0, (s.velocity.z + sep.z) * dt);

  if (delta.x !== 0 || delta.z !== 0) {
    const slid = moveAndSlide(s.position, delta, radius, height, obstacles);
    const slidDistSq =
      (slid.x - s.position.x) ** 2 + (slid.z - s.position.z) ** 2;
    const wantedDistSq = delta.x ** 2 + delta.z ** 2;

    // 滑动后前进得太少 → 可能是被低障碍挡住了，试着迈上去
    if (s.grounded && slidDistSq < wantedDistSq * 0.5) {
      const stepped = tryStepUp(s.position, delta, radius, height, obstacles);
      s.position = stepped ?? slid;
    } else {
      s.position = slid;
    }
  }

  // 撞墙后把对应方向的速度清零，避免贴着墙持续累积速度
  if (Math.abs(s.position.x - startX) < Math.abs(delta.x) - MOVEMENT.SKIN) s.velocity.x = 0;
  if (Math.abs(s.position.z - startZ) < Math.abs(delta.z) - MOVEMENT.SKIN) s.velocity.z = 0;

  // ── 6. 竖直位移与落地 ─────────────────────────────────────
  let landing: LandingEvent | undefined;
  const wasGrounded = s.grounded;
  // 步骤 5 的跨越低障碍可能已经抬高了 y，所以这里重新取起点
  const yBeforeGravity = s.position.y;
  s.position.y += s.velocity.y * dt;

  // 头顶撞到东西
  if (s.velocity.y > 0 && collides(s.position, radius, height, obstacles)) {
    s.position.y = yBeforeGravity;
    s.velocity.y = 0;
  }

  if (s.velocity.y <= 0) {
    // ★ 扫掠查询：从本 tick 起始高度往下探到结束高度。
    // 只查结束高度的点是不够的 —— 高速下落时一帧就能穿过整个地面。
    const fallen = Math.max(0, yBeforeGravity - s.position.y);
    // 13.5「脚部贴地，不因每级台阶进入跳跃」：在地面上时额外向下吸附一个台阶高度
    const snap = wasGrounded ? MOVEMENT.GROUND_SNAP : 0;
    const groundY = findGroundY(
      vec3(s.position.x, yBeforeGravity, s.position.z),
      radius,
      obstacles,
      fallen + snap + MOVEMENT.SKIN,
    );

    // 落到地面上（穿过了地面），或者 —— 13.5「脚部贴地，不因每级台阶进入跳跃」——
    // 本来就在地上、脚下有个一个台阶以内的下沿，直接吸附下去而不是转入下落。
    // 少了这个分支，走下楼梯会变成一路弹跳。
    const landedOn = groundY !== undefined && s.position.y <= groundY + MOVEMENT.SKIN;
    const snappedDown =
      groundY !== undefined &&
      wasGrounded &&
      s.position.y - groundY <= MOVEMENT.GROUND_SNAP + MOVEMENT.SKIN;

    if (groundY !== undefined && (landedOn || snappedDown)) {
      if (!wasGrounded) {
        landing = {
          fallHeight: Math.max(0, s.fallStartY - groundY),
          intoWater: isInWater(vec3(s.position.x, groundY, s.position.z), obstacles),
        };
      }
      s.position.y = groundY;
      s.velocity.y = 0;
      s.grounded = true;
      s.fallStartY = groundY;
      s.airSpeedCap = MOVE.BASE_SPEED;
    } else {
      s.grounded = false;
    }
  } else {
    s.grounded = false;
  }

  // ── 7. 供动画层使用的派生量 ───────────────────────────────
  const dx = s.position.x - startX;
  const dz = s.position.z - startZ;
  s.lastHorizontalDistance = Math.hypot(dx, dz);
  s.teleported = s.lastHorizontalDistance > MOVEMENT.TELEPORT_THRESHOLD;

  return { state: s, landing };
};

/** 13.5：深水可终止坠落伤害。靠 Aabb.endsFallDamage 而不是渲染标签判断 */
export const isInWater = (p: Vec3, obstacles: readonly Aabb[]): boolean =>
  obstaclesInRect(obstacles, p.x, p.z, p.x, p.z, WATER_SCRATCH).some(
    (b) =>
      b.endsFallDamage === true &&
      p.x >= b.min.x && p.x <= b.max.x &&
      p.z >= b.min.z && p.z <= b.max.z &&
      p.y <= b.max.y + 0.5,
  );

/**
 * 13.5「玩家、宠物和召唤物不形成完全实体堵门」。
 *
 * 刻意做成**软推开**而不是硬碰撞：重叠时互相施加分离速度，但允许穿过。
 * 硬碰撞会让夺旗战场的基地出口能被人肉堵死，直接违反验收 #43。
 */
export const separationVelocity = (
  self: Vec3,
  others: readonly Vec3[],
  radius: number,
): Vec3 => {
  let vx = 0;
  let vz = 0;
  const minDist = radius * 2;
  for (const o of others) {
    const dx = self.x - o.x;
    const dz = self.z - o.z;
    const d = Math.hypot(dx, dz);
    if (d >= minDist || d < 1e-6) continue;
    const push = (minDist - d) / minDist;
    vx += (dx / d) * push * MOVEMENT.SEPARATION_STRENGTH;
    vz += (dz / d) * push * MOVEMENT.SEPARATION_STRENGTH;
  }
  return vec3(vx, 0, vz);
};

/**
 * 13.5 / 验收 #46：把角色**传送**到一个位置（冲锋、闪现、后跃、拉拽的落点）。
 * 传送标记会置位，动画层据此避免播放高速跑步（13.4 / 验收 #47）。
 */
export const teleportTo = (
  prev: MovementState,
  target: Vec3,
  obstacles: readonly Aabb[],
  // 显式 `: number` —— GEOMETRY 是 `as const`，只写默认值会把参数推断成字面量 0.45
  radius: number = GEOMETRY.HITBOX_RADIUS,
): MovementState => {
  // 落点合法性已由 geometry.clampDisplacement 保证，这里只负责贴地。
  // 探测范围要足够大：闪现到平台边缘时目标点可能悬在半空。
  const groundY = findGroundY(target, radius, obstacles, TELEPORT_GROUND_SEARCH) ?? target.y;
  return {
    ...prev,
    position: vec3(target.x, groundY, target.z),
    velocity: vec3(0, 0, 0),
    grounded: true,
    fallStartY: groundY,
    airSpeedCap: MOVE.BASE_SPEED,
    lastHorizontalDistance: 0,
    teleported: true,
  };
};
