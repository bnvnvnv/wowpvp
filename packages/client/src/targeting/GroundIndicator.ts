/**
 * 地面技能指示器。规格书 5.5 / 14.3，验收 #8。
 *
 * ★ 边界由 shared 的 `resolveGroundPlacement` 给出，本文件**不做任何几何计算**。
 *   客户端一旦自己算一遍边界，「所见即所中」就断了 —— 那正是验收 #8 要防的事。
 *
 * 5.5 的五项显示要求，各由一个可视元素承担：
 *   真实外边界   → outerRing（实心描边圆）
 *   中心点       → centerDot
 *   最大施放距离 → rangeRing（施法者脚下的大圆）
 *   被墙阻挡     → 非法样式（见下）
 *   超出地图     → 非法样式
 *
 * ★ 17.2 可访问性：非法位置**不能只依赖颜色**。
 *   这里同时改变三样东西：降低亮度 + 虚线边界 + 中心叉号。
 *   色盲玩家靠虚线和叉号一样能判断。
 */

import * as THREE from 'three';
import { type GroundPlacement } from '@wowpvp/shared';

const LEGAL_COLOR = 0x6fd0ff;
const ILLEGAL_COLOR = 0x8a8f9b;
const RANGE_COLOR = 0x4a5568;

/** 用短线段拼出的虚线圆，非法时启用 */
const makeCircleLine = (segments: number, dashed: boolean): THREE.BufferGeometry => {
  const pts: number[] = [];
  const step = (Math.PI * 2) / segments;
  for (let i = 0; i < segments; i++) {
    // 虚线：每两段画一段
    if (dashed && i % 2 === 1) continue;
    const a0 = i * step;
    const a1 = (i + 1) * step;
    pts.push(Math.cos(a0), 0, Math.sin(a0), Math.cos(a1), 0, Math.sin(a1));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return g;
};

export class GroundIndicator {
  readonly group = new THREE.Group();

  /** 真实效果边界（实线）*/
  private readonly outerSolid: THREE.LineSegments;
  /** 真实效果边界（虚线，非法时用）*/
  private readonly outerDashed: THREE.LineSegments;
  /** 14.3：环形技能必须**同时**显示内圈 */
  private readonly innerSolid: THREE.LineSegments;
  /** 半透明填充，让边界内外一眼可分 */
  private readonly fill: THREE.Mesh;
  /** 最大施放距离（施法者脚下）*/
  private readonly rangeRing: THREE.LineSegments;
  private readonly centerDot: THREE.Mesh;
  /** 非法标记：叉号。不依赖颜色的第二重提示 */
  private readonly cross: THREE.LineSegments;

  constructor() {
    this.group.visible = false;
    this.group.renderOrder = 10;

    const solidGeo = makeCircleLine(72, false);
    const dashedGeo = makeCircleLine(48, true);

    this.outerSolid = new THREE.LineSegments(
      solidGeo,
      new THREE.LineBasicMaterial({ color: LEGAL_COLOR, depthTest: false }),
    );
    this.outerDashed = new THREE.LineSegments(
      dashedGeo,
      new THREE.LineBasicMaterial({ color: ILLEGAL_COLOR, depthTest: false }),
    );
    this.innerSolid = new THREE.LineSegments(
      solidGeo.clone(),
      new THREE.LineBasicMaterial({ color: LEGAL_COLOR, depthTest: false }),
    );

    this.fill = new THREE.Mesh(
      new THREE.CircleGeometry(1, 48),
      new THREE.MeshBasicMaterial({
        color: LEGAL_COLOR, transparent: true, opacity: 0.12,
        depthTest: false, side: THREE.DoubleSide,
      }),
    );
    this.fill.rotation.x = -Math.PI / 2;

    this.rangeRing = new THREE.LineSegments(
      makeCircleLine(96, true),
      new THREE.LineBasicMaterial({ color: RANGE_COLOR, depthTest: false, transparent: true, opacity: 0.7 }),
    );

    this.centerDot = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 8, 6),
      new THREE.MeshBasicMaterial({ color: LEGAL_COLOR, depthTest: false }),
    );

    const crossPts = [-0.6, 0, -0.6, 0.6, 0, 0.6, -0.6, 0, 0.6, 0.6, 0, -0.6];
    const crossGeo = new THREE.BufferGeometry();
    crossGeo.setAttribute('position', new THREE.Float32BufferAttribute(crossPts, 3));
    this.cross = new THREE.LineSegments(
      crossGeo,
      new THREE.LineBasicMaterial({ color: ILLEGAL_COLOR, depthTest: false }),
    );

    this.group.add(
      this.fill, this.outerSolid, this.outerDashed, this.innerSolid,
      this.rangeRing, this.centerDot, this.cross,
    );
  }

  hide(): void {
    this.group.visible = false;
  }

  /**
   * 按 shared 给出的解算结果更新可视化。
   * `casterPosition` 只用来画「最大施放距离」那个大圆。
   */
  show(placement: GroundPlacement, casterPosition: { x: number; y: number; z: number }): void {
    this.group.visible = true;
    const legal = placement.legal;
    const y = 0.03; // 略微抬起，避免与地面 z-fighting

    // ── 真实外边界。合法用实线，非法用虚线（17.2：不只靠颜色）──
    this.outerSolid.visible = legal;
    this.outerDashed.visible = !legal;
    for (const o of [this.outerSolid, this.outerDashed]) {
      o.position.set(placement.center.x, placement.center.y + y, placement.center.z);
      o.scale.setScalar(placement.radius);
    }

    // ── 14.3：环形必须同时显示内圈 ──
    if (placement.innerRadius !== undefined && placement.innerRadius > 0) {
      this.innerSolid.visible = true;
      this.innerSolid.position.copy(this.outerSolid.position);
      this.innerSolid.scale.setScalar(placement.innerRadius);
      (this.innerSolid.material as THREE.LineBasicMaterial).color.setHex(
        legal ? LEGAL_COLOR : ILLEGAL_COLOR,
      );
      // 环形的安全区在中心，填充只画环带不好做，直接不填充避免误导
      this.fill.visible = false;
    } else {
      this.innerSolid.visible = false;
      this.fill.visible = true;
      this.fill.position.set(placement.center.x, placement.center.y + y * 0.5, placement.center.z);
      this.fill.scale.setScalar(placement.radius);
      const m = this.fill.material as THREE.MeshBasicMaterial;
      m.color.setHex(legal ? LEGAL_COLOR : ILLEGAL_COLOR);
      // 非法时降低亮度 —— 17.2 的第三重提示
      m.opacity = legal ? 0.12 : 0.05;
    }

    // ── 最大施放距离 ──
    this.rangeRing.position.set(casterPosition.x, casterPosition.y + y * 0.3, casterPosition.z);
    this.rangeRing.scale.setScalar(placement.maxRange);

    // ── 中心点 ──
    this.centerDot.visible = legal;
    this.centerDot.position.set(placement.center.x, placement.center.y + 0.15, placement.center.z);

    // ── 非法叉号 ──
    this.cross.visible = !legal;
    this.cross.position.set(placement.center.x, placement.center.y + 0.15, placement.center.z);
    this.cross.scale.setScalar(Math.max(1, placement.radius * 0.35));
  }
}

/**
 * 屏幕坐标 → 地面平面交点。
 *
 * 玩家把鼠标抬到地平线以上时射线不与地面相交。此时**不能返回 undefined 就算了**——
 * 那会让技能变成「按了没反应」。回退到「沿水平方向推到 fallbackRange 米处」，
 * 随后 `resolveGroundPlacement` 会把它钳制到技能的最大距离，行为与真实游戏一致。
 *
 * @param fallbackOrigin 回退时的起点，通常是角色位置
 */
export const screenToGround = (
  camera: THREE.Camera,
  ndc: THREE.Vector2,
  fallbackOrigin?: { x: number; y: number; z: number },
  groundY = 0,
  fallbackRange = 200,
): THREE.Vector3 | undefined => {
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, camera);
  const dir = ray.ray.direction;

  const t = Math.abs(dir.y) < 1e-6 ? -1 : (groundY - ray.ray.origin.y) / dir.y;
  if (t >= 0) return ray.ray.origin.clone().addScaledVector(dir, t);

  // 射线朝上：把它投影到水平面，从角色出发推一个远点，交给上层钳制
  if (!fallbackOrigin) return undefined;
  const flat = new THREE.Vector3(dir.x, 0, dir.z);
  if (flat.lengthSq() < 1e-9) return undefined;
  flat.normalize();
  return new THREE.Vector3(fallbackOrigin.x, groundY, fallbackOrigin.z).addScaledVector(
    flat,
    fallbackRange,
  );
};
