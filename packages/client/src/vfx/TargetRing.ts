/**
 * M12：当前目标 / 焦点的脚下指示环。规格书 5.2、14.4、17.2。
 *
 * ★★ **这是 `ESSENTIAL_ROLES.target`，任何画质下都必须画。**
 *   所以本文件**不 import `quality.ts`** —— 没有 quality 参数可传，
 *   就没有人能在这里加一行 `if (low) return`。与 M8 `hiddenAtQuality()`
 *   只收 `DecorativeRole` 是同一把锁的两面。
 *
 * ★ 17.2「不能只依赖颜色」：敌对/友方除了颜色不同，**环的形状也不同**
 *   （敌对是带缺口的锐角三角刻度，友方是连续实环）。色盲模式下
 *   两者仍然一眼可分，而颜色本身也跟随 `paletteFor()` 的语义色。
 */

import * as THREE from 'three';

export type RingKind = 'hostile' | 'friendly' | 'focus';

/** 环的几何：内外半径都按碰撞半径给，保证「圈住的正是判定范围」 */
const RING_INNER = 0.52;
const RING_OUTER = 0.62;

export class TargetRing {
  readonly group = new THREE.Group();
  private readonly ring: THREE.Mesh;
  private readonly ticks: THREE.Mesh;
  private readonly mat: THREE.MeshBasicMaterial;
  private readonly tickMat: THREE.MeshBasicMaterial;
  private kind: RingKind = 'hostile';

  constructor() {
    this.mat = new THREE.MeshBasicMaterial({
      color: 0xff5555,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(RING_INNER, RING_OUTER, 48),
      this.mat,
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.04; // 抬离地面，避免 z-fighting
    this.ring.renderOrder = 2;
    this.group.add(this.ring);

    /**
     * 敌对专用的四个角刻度。★ 17.2 的第二通道：
     * 不靠颜色也能分辨「这是敌人」——四个尖角像准星，友方环没有。
     */
    this.tickMat = new THREE.MeshBasicMaterial({
      color: 0xff5555,
      transparent: true,
      opacity: 0.95,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const tickGeo = new THREE.RingGeometry(RING_OUTER, RING_OUTER + 0.14, 4, 1, 0, Math.PI / 7);
    this.ticks = new THREE.Mesh(tickGeo, this.tickMat);
    this.ticks.rotation.x = -Math.PI / 2;
    this.ticks.position.y = 0.04;
    this.ticks.renderOrder = 2;
    this.group.add(this.ticks);

    this.group.visible = false;
  }

  /** `at` 为脚底世界坐标；`undefined` 表示没有目标 */
  update(
    at: { x: number; y: number; z: number } | undefined,
    kind: RingKind,
    elapsed: number,
    /** 语义色，来自 `paletteFor()` —— 色盲模式下这里会变 */
    color: string,
  ): void {
    if (!at) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    this.group.position.set(at.x, at.y, at.z);

    if (kind !== this.kind) {
      this.kind = kind;
      // 友方是连续实环，敌对/焦点带刻度（17.2 形状通道）
      this.ticks.visible = kind !== 'friendly';
    }
    this.mat.color.set(color);
    this.tickMat.color.set(color);

    // 缓慢自转 + 呼吸。★ 只是让它在静止画面里可辨，不承载任何信息
    this.ticks.rotation.z = elapsed * (this.kind === 'focus' ? -0.7 : 0.5);
    const pulse = 0.82 + 0.18 * Math.sin(elapsed * 3.2);
    this.mat.opacity = pulse;
    // 焦点环细一点、暗一点 —— 它与硬目标同时存在时不该抢视觉
    this.group.scale.setScalar(this.kind === 'focus' ? 1.22 : 1);
  }
}
