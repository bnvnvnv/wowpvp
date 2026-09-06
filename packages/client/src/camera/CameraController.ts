/**
 * 自由镜头控制器。规格书 4.1–4.3，验收 #1 / #2 / #3。
 * 详细设计见 docs/07-client-render-camera.md 第 1 节。
 *
 * ★ 本模块**不向任何判定函数传参**。镜头距离、镜头 yaw、FOV 都不出现在
 *   shared/math/geometry.ts 的任何签名里 —— 这是规格书 4.1
 *   「第一人称只改变观察方式，不改变瞄准、射程、命中体积或攻击优势」
 *   在架构层面的保证，而不是靠自觉。
 */

import * as THREE from 'three';
import { GEOMETRY, type Aabb, type Vec3 } from '@wowpvp/shared';
import { CameraShake } from './CameraShake.js';
import {
  DEFAULT_ACCESSIBILITY,
  type AccessibilitySettings,
} from '../settings/accessibility.js';

export const CAMERA = {
  /** 小于此距离进入第一人称表现 */
  FIRST_PERSON_THRESHOLD: 0.4,
  /**
   * 最远距离。60° FOV 下角色占屏约 9.6%。
   * 4.1 同时要求「占屏 4%–8%」和「不能一次看到整张地图」，两者在 60° FOV 下冲突
   * （8% 需要 21.6 米）。这里优先满足后者，取舍已登记为 docs/10 的 Q7。
   */
  MAX_DISTANCE: 18,
  DEFAULT_DISTANCE: 8.5,
  FOV: 60,
  /** 滚轮每格改变的距离 */
  ZOOM_STEP: 0.9,
  /** 缩放插值系数，1/s。用 1-exp(-k·dt) 而不是 k·dt，低帧率下不会过冲 */
  ZOOM_LERP: 12,
  /** 俯仰角上下限。永远到不了 90°，4.1「最远距离仍围绕角色，不变成垂直俯视」 */
  MIN_PITCH_DEG: -35,
  MAX_PITCH_DEG: 75,
  /** 鼠标灵敏度，弧度/像素 */
  SENSITIVITY: 0.0045,

  /** 镜头碰撞探测球半径，比近裁剪面大，避免墙面露缝 */
  PROBE_RADIUS: 0.25,
  /** ★ 非对称插值：收缩要快，慢一帧就穿墙偷看；恢复要慢，快了贴墙走位会抽搐 */
  PULL_IN_LERP: 40,
  RESTORE_LERP: 6,

  /** 4.3 跳跃时垂直跟随略柔于水平跟随 */
  VERTICAL_LERP: 14,
  /** 落地瞬间提高垂直跟随，否则从高处落下镜头会明显拖在角色上方 */
  VERTICAL_LERP_LANDING: 25,

  /** 4.3 手动拖动结束后，自动跟随恢复前的等待时间 */
  AUTO_FOLLOW_DELAY: 0.8,
  /** 自动跟随转到角色背后的速度，1/s */
  AUTO_FOLLOW_LERP: 2.5,

  NEAR: 0.1,
  FAR: 500,
} as const;

const DEG = Math.PI / 180;

export interface CameraInput {
  /** 本帧滚轮增量（正 = 拉远）*/
  wheel: number;
  /** 左键拖动的像素增量 */
  leftDrag: { dx: number; dy: number } | null;
  /** 右键拖动的像素增量 */
  rightDrag: { dx: number; dy: number } | null;
  /** 一键复位 */
  reset: boolean;
}

export interface CameraTarget {
  /** 角色脚底位置 */
  position: Vec3;
  /** 角色朝向。★ 与 camera.yaw 是两个独立的值 */
  yaw: number;
  /** 角色是否在地面上，用于落地时提高垂直跟随 */
  grounded: boolean;
}

export class CameraController {
  readonly camera: THREE.PerspectiveCamera;

  /** ★ 镜头 yaw。绝不能拿它去做朝向判定（6.5）*/
  yaw = 0;
  pitch = 22 * DEG;
  sensitivity = 1;

  // 显式标 number：CAMERA 是 as const，不标注会被推断成字面量类型 6.5
  private targetDistance: number = CAMERA.DEFAULT_DISTANCE;
  private currentDistance: number = CAMERA.DEFAULT_DISTANCE;
  /** 被墙体压缩后的实际距离 */
  private collidedDistance: number = CAMERA.DEFAULT_DISTANCE;
  /** 平滑跟随的锚点高度，实现 4.3 的垂直柔和跟随 */
  private smoothedY: number | null = null;

  private autoFollowEnabled = true;
  private autoFollowResumeAt = 0;
  private elapsed = 0;

  /** 镜头震动（docs/07 §1.7）。震动幅度全部经 shakeAmplitude() 归一 */
  private readonly shake = new CameraShake();
  private access: AccessibilitySettings = DEFAULT_ACCESSIBILITY;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(CAMERA.FOV, aspect, CAMERA.NEAR, CAMERA.FAR);
  }

  /** 17.2「减弱镜头震动」的设置入口。用 setter 而不是 update 的新参数 —— 不动 20 条既有测试的调用签名 */
  setAccessibility(s: AccessibilitySettings): void {
    this.access = s;
  }

  /** 打击事件加创伤（HitFeedback 是唯一调用方）*/
  addTrauma(t: number): void {
    this.shake.add(t);
  }

  /** 诊断只读：当前创伤值 */
  get trauma(): number {
    return this.shake.traumaLevel;
  }

  /** 是否处于第一人称（供渲染层隐藏头部与躯干，4.1）*/
  get isFirstPerson(): boolean {
    return this.currentDistance < CAMERA.FIRST_PERSON_THRESHOLD;
  }

  /** 目标缩放距离（玩家用滚轮设定的值）*/
  get distance(): number {
    return this.currentDistance;
  }

  /**
   * 镜头到锚点的**实际**距离 —— 被墙体压缩后的值。
   * 与 `distance` 的差就是碰撞拉近的量。
   */
  distanceToAnchor(): number {
    return this.collidedDistance;
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /**
   * 处理输入。返回角色 yaw 的增量 ——
   * 只有右键拖动会产生非零值（4.2：右键镜头与角色朝向联动）。
   */
  applyInput(input: CameraInput): number {
    let characterYawDelta = 0;

    if (input.reset) {
      this.autoFollowEnabled = true;
      this.autoFollowResumeAt = 0;
    }

    // 4.1 连续缩放，不是离散档位
    if (input.wheel !== 0) {
      this.targetDistance = clamp(
        this.targetDistance + Math.sign(input.wheel) * CAMERA.ZOOM_STEP,
        0,
        CAMERA.MAX_DISTANCE,
      );
    }

    // 4.2 按住左键拖动：**只环绕观察角色**，不改变角色面向
    if (input.leftDrag) {
      this.yaw -= input.leftDrag.dx * CAMERA.SENSITIVITY * this.sensitivity;
      this.pitch = clampPitch(this.pitch + input.leftDrag.dy * CAMERA.SENSITIVITY * this.sensitivity);
      this.suspendAutoFollow();
    }

    // 4.2 按住右键拖动：镜头与角色朝向联动
    if (input.rightDrag) {
      const dYaw = -input.rightDrag.dx * CAMERA.SENSITIVITY * this.sensitivity;
      this.yaw += dYaw;
      characterYawDelta = dYaw; // ★ 只有这条路径会转动角色
      this.pitch = clampPitch(this.pitch + input.rightDrag.dy * CAMERA.SENSITIVITY * this.sensitivity);
      this.suspendAutoFollow();
    }

    return characterYawDelta;
  }

  /** 4.3 手动拖动期间必须停止自动跟随，否则会与玩家输入争抢造成摆动 */
  private suspendAutoFollow(): void {
    this.autoFollowEnabled = false;
    this.autoFollowResumeAt = this.elapsed + CAMERA.AUTO_FOLLOW_DELAY;
  }

  /** 一键复位：镜头回到角色正后方（4.2）*/
  resetBehind(characterYaw: number): void {
    this.yaw = characterYaw;
    this.pitch = 22 * DEG;
    this.autoFollowEnabled = true;
  }

  update(dt: number, target: CameraTarget, obstacles: readonly Aabb[], moving: boolean): void {
    this.elapsed += dt;

    if (!this.autoFollowEnabled && this.elapsed >= this.autoFollowResumeAt) {
      this.autoFollowEnabled = true;
    }

    // 自动跟随：角色移动时镜头缓慢转到背后。拖动期间与拖动后 0.8 秒内不生效
    if (this.autoFollowEnabled && moving) {
      const delta = wrapAngle(target.yaw - this.yaw);
      this.yaw += delta * expLerp(CAMERA.AUTO_FOLLOW_LERP, dt);
    }

    // 4.3 垂直跟随略柔和于水平跟随，形成重量感但不明显滞后
    const anchorY = target.position.y + GEOMETRY.CHEST_HEIGHT;
    if (this.smoothedY === null) {
      this.smoothedY = anchorY;
    } else {
      const k = target.grounded ? CAMERA.VERTICAL_LERP_LANDING : CAMERA.VERTICAL_LERP;
      this.smoothedY += (anchorY - this.smoothedY) * expLerp(k, dt);
    }
    const anchor = new THREE.Vector3(target.position.x, this.smoothedY, target.position.z);

    // 缩放插值
    this.currentDistance +=
      (this.targetDistance - this.currentDistance) * expLerp(CAMERA.ZOOM_LERP, dt);

    // 4.3 镜头碰撞：不得穿过墙壁、屋顶、地面、柱子
    const desired = this.orbitPosition(anchor, this.currentDistance);
    const allowed = this.probe(anchor, desired, obstacles);

    // ★ 非对称插值
    const k = allowed < this.collidedDistance ? CAMERA.PULL_IN_LERP : CAMERA.RESTORE_LERP;
    this.collidedDistance += (allowed - this.collidedDistance) * expLerp(k, dt);
    this.collidedDistance = Math.min(this.collidedDistance, this.currentDistance);

    /**
     * ★★ 震动的位移通道**只会把镜头往锚点方向拉，永远不会推远。**
     *
     *   `collidedDistance` 已经是 probe() 算出的**不穿墙的最大距离**，
     *   而 `pullIn ≥ 0`，所以震动后的位置必定落在那条安全线段**内部**。
     *   这不是「加了一次检查」，是**减法本身**保证的 —— 想让震动穿墙，
     *   得先把这里的减号改成加号，那是一次会被 review 拦下的改动。
     *   （docs/07 §1.4：镜头穿墙 = 免费的信息优势。）
     *
     * ⚠️ 震动用的 dt 是渲染时钟 —— 顿帧时震动跟着世界一起「冻住再爆开」，
     *   这是想要的效果：顿帧与震动是同一记打击的两半。
     */
    this.shake.update(dt);
    const sh = this.shake.active
      ? this.shake.sample(this.access)
      : undefined;
    const shakenDistance = sh
      ? Math.max(0.15, this.collidedDistance - sh.pullIn)
      : this.collidedDistance;

    const finalPos = this.orbitPosition(anchor, shakenDistance);
    this.camera.position.copy(finalPos);

    if (this.isFirstPerson) {
      // 第一人称：从角色眼睛向前看，而不是看向自己
      const dir = this.forwardVector();
      this.camera.lookAt(anchor.clone().add(dir.multiplyScalar(10)));
    } else {
      this.camera.lookAt(anchor);
    }

    // 震动的角度通道：lookAt **之后**叠加 —— 位置一个字节都没动，
    // 相机不可能因此进入几何体（结构性防穿墙的另一半）
    if (sh && (sh.yaw !== 0 || sh.pitch !== 0 || sh.roll !== 0)) {
      this.camera.rotateY(sh.yaw);
      this.camera.rotateX(sh.pitch);
      this.camera.rotateZ(sh.roll);
    }
  }

  /** 镜头前方单位向量，供第一人称与射线拾取使用 */
  forwardVector(): THREE.Vector3 {
    const cp = Math.cos(this.pitch);
    return new THREE.Vector3(
      -Math.sin(this.yaw) * cp,
      -Math.sin(this.pitch),
      -Math.cos(this.yaw) * cp,
    ).normalize();
  }

  private orbitPosition(anchor: THREE.Vector3, distance: number): THREE.Vector3 {
    const back = this.forwardVector().multiplyScalar(-distance);
    return anchor.clone().add(back);
  }

  /**
   * 4.3 镜头碰撞探测。返回不穿墙的最大可用距离。
   *
   * 用固定步进的球体采样而不是精确扫掠：地图是 AABB 组合，
   * 0.15 米步长在 18 米距离上是 120 次 AABB 测试，代价可以忽略，
   * 而精度足够（比 PROBE_RADIUS 小）。
   */
  private probe(anchor: THREE.Vector3, desired: THREE.Vector3, obstacles: readonly Aabb[]): number {
    const dir = desired.clone().sub(anchor);
    const maxDist = dir.length();
    if (maxDist < 1e-4) return 0;
    dir.divideScalar(maxDist);

    const step = 0.15;
    for (let d = step; d <= maxDist; d += step) {
      const p = anchor.clone().addScaledVector(dir, d);
      for (const b of obstacles) {
        if (b.blocksSight === false && b.blocksMovement === false) continue;
        if (sphereHitsAabb(p, CAMERA.PROBE_RADIUS, b)) {
          return Math.max(0, d - step - 0.1);
        }
      }
    }
    return maxDist;
  }
}

// ── 辅助 ─────────────────────────────────────────────────────────

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

const clampPitch = (p: number): number =>
  clamp(p, CAMERA.MIN_PITCH_DEG * DEG, CAMERA.MAX_PITCH_DEG * DEG);

/** 帧率无关的指数插值系数 */
const expLerp = (k: number, dt: number): number => 1 - Math.exp(-k * dt);

const wrapAngle = (a: number): number => {
  let r = a % (Math.PI * 2);
  if (r > Math.PI) r -= Math.PI * 2;
  if (r <= -Math.PI) r += Math.PI * 2;
  return r;
};

const sphereHitsAabb = (p: THREE.Vector3, radius: number, b: Aabb): boolean => {
  const cx = clamp(p.x, b.min.x, b.max.x);
  const cy = clamp(p.y, b.min.y, b.max.y);
  const cz = clamp(p.z, b.min.z, b.max.z);
  const dx = p.x - cx;
  const dy = p.y - cy;
  const dz = p.z - cz;
  return dx * dx + dy * dy + dz * dz < radius * radius;
};
