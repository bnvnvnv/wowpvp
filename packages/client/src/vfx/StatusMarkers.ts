/**
 * 控制状态与护盾的实际渲染。规格书 14.3，验收 #48 / #49。
 *
 * `status.ts` 定义**该长什么样**，本文件负责**画出来**。
 * 拆成两个文件的原因：前者是纯数据，可以被测试逐条断言
 * （沉默与恐惧至少两个通道不同、护盾四态运动方式互不相同…），
 * 后者依赖 three.js 和真实场景，只能靠肉眼验收。
 *
 * ★ 这里的每个可视元素都用 `ESSENTIAL_ROLES` 里的角色标注，
 *   并且**没有任何一处读 quality** —— 关键信息不该有被画质影响的通道。
 *   装饰粒子（余烬、雪花…）走另一条路，见 quality.ts。
 */

import * as THREE from 'three';
import { GEOMETRY } from '@wowpvp/shared';
import { QualityTier } from '../render/quality.js';
import {
  CONTROL_VISUALS,
  SHIELD_VISUALS,
  ShieldState,
  closeUpOpacity,
  controlMarkerScale,
  essentialMarkerScale,
  shieldStateFor,
  type ControlKind,
} from './status.js';

const H = GEOMETRY.HITBOX_HEIGHT;
const R = GEOMETRY.HITBOX_RADIUS;

/** 按 CONTROL_VISUALS 的 shape 键造几何体 */
const makeControlGeometry = (shape: string): THREE.BufferGeometry => {
  switch (shape) {
    case 'chains':
      // 定身：脚下一圈锁链环
      return new THREE.TorusGeometry(R * 1.3, 0.05, 6, 20);
    case 'stars':
      // 昏迷：头顶几颗星，用一个八面体代表
      return new THREE.OctahedronGeometry(0.14, 0);
    case 'crossedBar':
      // 沉默/缴械：一道横杠
      return new THREE.BoxGeometry(0.5, 0.08, 0.08);
    case 'wave':
      // 恐惧：环绕身体的波纹
      return new THREE.TorusGeometry(R * 1.6, 0.04, 5, 16, Math.PI * 1.4);
    case 'ring':
    default:
      return new THREE.TorusGeometry(R * 1.2, 0.05, 6, 18);
  }
};

/** 挂点对应的高度 */
const anchorY = (anchor: string): number => {
  if (anchor === 'feet') return 0.06;
  if (anchor === 'overhead') return H + 0.35;
  return H * 0.55; // body
};

/**
 * 一个角色身上的全部状态标记。
 * 每帧由 `update()` 驱动，内部按需显隐，不重建对象。
 */
export class StatusMarkers {
  readonly group = new THREE.Group();

  private readonly control = new Map<ControlKind, THREE.Mesh>();
  private readonly shield: THREE.Mesh;
  private readonly shieldMat: THREE.MeshBasicMaterial;
  /** 承伤/破裂这类一次性反馈的剩余秒数 */
  private burstRemaining = 0;
  private burstState: ShieldState | null = null;

  constructor() {
    for (const [kind, v] of Object.entries(CONTROL_VISUALS) as [ControlKind, typeof CONTROL_VISUALS[ControlKind]][]) {
      const mesh = new THREE.Mesh(
        makeControlGeometry(v.shape),
        // MeshBasic：不受光照影响 —— 关键信息不能因为站在阴影里就看不清
        new THREE.MeshBasicMaterial({ color: v.color, transparent: true, opacity: 0.95 }),
      );
      mesh.position.y = anchorY(v.anchor);
      if (v.anchor === 'feet') mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      mesh.renderOrder = 10;
      this.group.add(mesh);
      this.control.set(kind, mesh);
    }

    this.shieldMat = new THREE.MeshBasicMaterial({
      color: 0xffd98a,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.shield = new THREE.Mesh(new THREE.SphereGeometry(R * 1.9, 16, 12), this.shieldMat);
    this.shield.position.y = H * 0.5;
    this.shield.visible = false;
    this.group.add(this.shield);
  }

  /**
   * 更新一帧。
   *
   * @param active     当前生效的控制种类
   * @param quality    画质档位。★ 只用于**放大**低画质下的标记，绝不用于隐藏
   * @param cameraDistance 镜头距离，用于 14.3 的远近调整
   */
  update(
    active: ReadonlySet<ControlKind>,
    quality: QualityTier,
    cameraDistance: number,
    dt: number,
    elapsed: number,
  ): void {
    // 14.3 最后一条 + 低画质补偿：关键标记在远处和低画质下都要更大
    const scale = essentialMarkerScale(cameraDistance) * controlMarkerScale(quality);

    for (const [kind, mesh] of this.control) {
      const on = active.has(kind);
      mesh.visible = on;
      if (!on) continue;
      mesh.scale.setScalar(scale);
      applyMotion(mesh, CONTROL_VISUALS[kind].motion, elapsed, anchorY(CONTROL_VISUALS[kind].anchor));
    }

    if (this.burstRemaining > 0) this.burstRemaining -= dt;
    if (this.burstRemaining <= 0) this.burstState = null;
  }

  /**
   * 护盾的持续态。传 undefined 表示没有护盾。
   *
   * ★ 14.3 要求四种反馈，其中「承伤」和「破裂」是事件，
   *   由 `flashAbsorb()` / `flashBroken()` 触发，不走这里。
   */
  setShield(remaining: number | undefined, initial: number, cameraDistance: number): void {
    if (remaining === undefined || (remaining <= 0 && this.burstState !== ShieldState.Broken)) {
      this.shield.visible = false;
      return;
    }
    const state = this.burstState ?? shieldStateFor(remaining, initial);
    const v = SHIELD_VISUALS[state];
    this.shield.visible = true;
    // ★ 验收 #49：第一人称下把护盾压到 0.25 以下，但**不关掉**
    this.shieldMat.opacity = closeUpOpacity('shield', v.opacity, cameraDistance);
    // 衰减态把壳收薄一点，让「快破了」在余光里也能看出来
    this.shield.scale.setScalar(state === ShieldState.Decaying ? 0.88 : 1);
  }

  /** 14.3：护盾**承伤**——一次闪光。与「衰减」是两回事 */
  flashAbsorb(): void {
    this.burstState = ShieldState.Absorbing;
    this.burstRemaining = SHIELD_VISUALS.absorbing.durationSeconds;
  }

  /** 14.3：护盾**破裂**——比承伤更强更长的反馈 */
  flashBroken(): void {
    this.burstState = ShieldState.Broken;
    this.burstRemaining = SHIELD_VISUALS.broken.durationSeconds;
  }

  dispose(): void {
    for (const m of this.control.values()) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.shield.geometry.dispose();
    this.shieldMat.dispose();
  }
}

/** 各控制状态的运动方式。静止时两种控制容易看混，运动是重要的区分通道 */
const applyMotion = (
  mesh: THREE.Mesh,
  motion: string,
  t: number,
  baseY: number,
): void => {
  switch (motion) {
    case 'orbit':
      mesh.position.x = Math.cos(t * 3) * 0.22;
      mesh.position.z = Math.sin(t * 3) * 0.22;
      mesh.position.y = baseY;
      break;
    case 'spin':
      mesh.rotation.y = t * 2;
      break;
    case 'pulse':
      mesh.scale.multiplyScalar(1 + Math.sin(t * 5) * 0.08);
      break;
    case 'shake':
      mesh.position.x = Math.sin(t * 22) * 0.03;
      break;
    case 'drift':
      mesh.position.y = baseY + Math.sin(t * 1.6) * 0.12;
      mesh.rotation.y = t * 0.8;
      break;
    default:
      break;
  }
};
