/**
 * 方向技能预览（锥形 / 直线）。规格书 5.4 / 6.3。
 *
 * ★ 5.4 明确规定：「角色面向决定方向，**镜头方向不能替代角色面向**」。
 *   所以本文件只接受 `characterYaw`，签名里根本没有镜头 yaw 这个参数 ——
 *   想传错都传不进来。
 *
 * ★ 6.3 表现要求：锥形要「显示角度和距离」，直线要「长度 + 宽度」。
 *   下面按形状参数直接生成几何体，与判定用的是同一组数字。
 */

import * as THREE from 'three';
import type { ShapeDef } from '@wowpvp/shared';

const COLOR = 0xffcc66;

export class DirectionIndicator {
  readonly group = new THREE.Group();
  private mesh?: THREE.Mesh;
  private outline?: THREE.LineSegments;
  private currentKey = '';

  constructor() {
    this.group.visible = false;
    this.group.renderOrder = 10;
  }

  hide(): void {
    this.group.visible = false;
  }

  /**
   * @param characterYaw ★ 必须是角色朝向，不是镜头朝向（5.4 / 6.5）
   */
  show(
    shape: ShapeDef,
    origin: { x: number; y: number; z: number },
    characterYaw: number,
  ): void {
    if (shape.kind !== 'cone' && shape.kind !== 'line') {
      this.hide();
      return;
    }

    // 形状参数变化时才重建几何体，避免每帧分配
    const key =
      shape.kind === 'cone'
        ? `cone:${shape.angleDeg}:${shape.range}`
        : `line:${shape.length}:${shape.width}`;
    if (key !== this.currentKey) {
      this.rebuild(shape);
      this.currentKey = key;
    }

    this.group.visible = true;
    this.group.position.set(origin.x, origin.y + 0.04, origin.z);
    // yaw=0 面向 -Z，three 的 rotation.y 正方向与之一致
    this.group.rotation.y = characterYaw;
  }

  private rebuild(shape: Extract<ShapeDef, { kind: 'cone' | 'line' }>): void {
    this.mesh?.geometry.dispose();
    this.outline?.geometry.dispose();
    if (this.mesh) this.group.remove(this.mesh);
    if (this.outline) this.group.remove(this.outline);

    const { fill, edge } =
      shape.kind === 'cone'
        ? coneGeometry(shape.angleDeg, shape.range)
        : lineGeometry(shape.length, shape.width);

    this.mesh = new THREE.Mesh(
      fill,
      new THREE.MeshBasicMaterial({
        color: COLOR, transparent: true, opacity: 0.14,
        depthTest: false, side: THREE.DoubleSide,
      }),
    );
    this.outline = new THREE.LineSegments(
      edge,
      new THREE.LineBasicMaterial({ color: COLOR, depthTest: false }),
    );
    this.group.add(this.mesh, this.outline);
  }
}

/** 扇形：从 -Z 方向张开 angleDeg 度、半径 range */
const coneGeometry = (angleDeg: number, range: number) => {
  const half = (angleDeg / 2) * (Math.PI / 180);
  const segments = 24;
  const verts: number[] = [];
  const edge: number[] = [];

  // 扇形面（三角扇），yaw=0 时正前方是 -Z
  const at = (a: number) => ({ x: -Math.sin(a) * range, z: -Math.cos(a) * range });
  for (let i = 0; i < segments; i++) {
    const a0 = -half + (i / segments) * half * 2;
    const a1 = -half + ((i + 1) / segments) * half * 2;
    const p0 = at(a0);
    const p1 = at(a1);
    verts.push(0, 0, 0, p0.x, 0, p0.z, p1.x, 0, p1.z);
    edge.push(p0.x, 0, p0.z, p1.x, 0, p1.z);
  }
  // 两条侧边，让「角度」肉眼可读（6.3）
  const left = at(-half);
  const right = at(half);
  edge.push(0, 0, 0, left.x, 0, left.z, 0, 0, 0, right.x, 0, right.z);

  const fill = new THREE.BufferGeometry();
  fill.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  const e = new THREE.BufferGeometry();
  e.setAttribute('position', new THREE.Float32BufferAttribute(edge, 3));
  return { fill, edge: e };
};

/** 矩形：长 length、宽 width，从原点沿 -Z 延伸 */
const lineGeometry = (length: number, width: number) => {
  const w = width / 2;
  const verts = [
    -w, 0, 0, w, 0, 0, w, 0, -length,
    -w, 0, 0, w, 0, -length, -w, 0, -length,
  ];
  const edge = [
    -w, 0, 0, w, 0, 0,
    w, 0, 0, w, 0, -length,
    w, 0, -length, -w, 0, -length,
    -w, 0, -length, -w, 0, 0,
  ];
  const fill = new THREE.BufferGeometry();
  fill.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  const e = new THREE.BufferGeometry();
  e.setAttribute('position', new THREE.Float32BufferAttribute(edge, 3));
  return { fill, edge: e };
};
