/**
 * P4：每帧给场上实体算一次「离镜头多远、在不在视野里」，供骨骼动画分级用。
 *
 * ★ 判据本身（几米算远、跳不跳）在 `entity/animLod.ts` 里，那边是纯数学、
 *   有单测。这里只负责**取样**：三个矩阵乘法 + 每实体一次包围球相交测试，
 *   一帧的总成本远小于它省下的一次 `mixer.update`。
 *
 * ★★ 视锥剔除的是**骨骼计算**，不是绘制 —— three 自己在 `render` 里
 *   已经做过一次绘制侧的剔除。省下的是我们每帧主动调的那次 `mixer.update`：
 *   一个背对镜头站在你身后的人，他的手臂在哪儿没有任何观众。
 */

import * as THREE from 'three';
import { animStrideFor } from '../entity/animLod.js';

/**
 * 判定用包围球的半径与抬高。
 *
 * ⚠️ 刻意**偏大**：人形碰撞体高 2 米，大 BOSS 的视觉高是它的 2.2 倍（4.4 米）。
 *   球心抬到 1.2 米、半径 3.2 米，最高的模型也整个装得下。
 *   宁可多算几个人的骨骼，也不要让边缘的人在镜头一转时定格 —— 判错的
 *   代价是不对称的（多算 = 一点 CPU，漏算 = 一眼看得见的僵尸）。
 */
const SPHERE_LIFT = 1.2;
const SPHERE_RADIUS = 3.2;

export class EntityLod {
  private readonly frustum = new THREE.Frustum();
  private readonly viewProjection = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere(new THREE.Vector3(), SPHERE_RADIUS);
  private readonly cameraPos = new THREE.Vector3();
  private ready = false;

  /**
   * 上一帧的分级直方图（每帧 `beginFrame` 时清零）。
   *
   * ★★ 存在的理由很具体：分级失效是一种**完全没有症状**的缺陷 ——
   *   `strideFor()` 只要恒返回 1，画面一个像素都不会变，性能悄悄退回原样，
   *   而没有任何测试会红。这四个计数是它唯一的可观测出口（试验场经
   *   `artStatus.animLod` 报出去，剖析脚本每轮都读一次）。
   */
  readonly stats = { full: 0, half: 0, third: 0, offscreen: 0 };

  /**
   * 每帧一次，**在实体循环之前**调。
   *
   * ★★ 里面那句 `camera.updateMatrixWorld()` 不能省：`matrixWorldInverse`
   *   平时是在 `renderer.render()` 里才刷新的，而我们的实体循环跑在 render
   *   **之前** —— 不刷的话拿到的是上一帧的视锥，镜头快速转动时边缘的人会
   *   晚一帧才开始动。（`THREE.Camera` 重写了 `updateMatrixWorld`，
   *   它顺带就把逆矩阵算好了。）
   */
  beginFrame(camera: THREE.Camera): void {
    camera.updateMatrixWorld();
    this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.viewProjection);
    camera.getWorldPosition(this.cameraPos);
    this.ready = true;
    this.stats.full = 0;
    this.stats.half = 0;
    this.stats.third = 0;
    this.stats.offscreen = 0;
  }

  /**
   * 这个实体这一帧的骨骼推进分频。1 = 每帧，`Infinity` = 视锥外不推进。
   * ★ 没调过 `beginFrame` 就一律返回 1（全速）—— 分级出错时的默认方向
   *   永远是「多算」，见 SPHERE_RADIUS 的注释。
   */
  strideFor(position: { x: number; y: number; z: number }): number {
    if (!this.ready) return 1;
    this.sphere.center.set(position.x, position.y + SPHERE_LIFT, position.z);
    const onScreen = this.frustum.intersectsSphere(this.sphere);
    const stride = animStrideFor(this.cameraPos.distanceTo(this.sphere.center), onScreen);
    if (!onScreen) this.stats.offscreen++;
    else if (stride === 1) this.stats.full++;
    else if (stride === 2) this.stats.half++;
    else this.stats.third++;
    return stride;
  }
}
