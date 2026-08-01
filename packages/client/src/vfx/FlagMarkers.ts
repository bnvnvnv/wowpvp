/**
 * 旗帜的 3D 表现。规格书 12.2 / 12.3 / 14.4，验收 #40 / #49。
 *
 * ★★ 12.2：「旗帜信息对**双方持续可见**。」12.3 / 验收 #40 的后半句：
 *    「旗帜**不会随角色隐藏**。」
 *
 *    所以旗帜是一个**独立的场景对象**，不挂在 `CharacterView` 下面。
 *    挂上去的话，`setFirstPerson()` 或者任何一次「隐身时隐藏角色组」
 *    都会顺手把旗帜一起隐掉 —— 那正是 #40 要防的一帧画面。
 *    这里的旗帜只跟随旗手的**位置**，不继承它的可见性。
 *
 * ★ 14.4：旗手是 ESSENTIAL_ROLES 成员，任何画质下都不能隐藏。
 *   所以本文件不读画质档位；远距离下反而按 `essentialMarkerScale()` 放大（验收 #49）。
 */

import * as THREE from 'three';
import { FlagState, TEAM_RED, type FlagView } from '@wowpvp/shared';
import { ESSENTIAL_ROLES, isEssential } from '../render/quality.js';
import { essentialMarkerScale } from './status.js';

const RED = 0xff7a6f;
const BLUE = 0x6fa8ff;

/** 17.2：旗帜状态不能只靠颜色 —— 每种状态额外改变高度与旋转速度 */
const STATE_MOTION: Record<FlagState, { bob: number; spin: number }> = {
  atBase: { bob: 0.05, spin: 0.4 },
  beingTaken: { bob: 0.25, spin: 3.0 },
  carried: { bob: 0.12, spin: 1.2 },
  dropped: { bob: 0, spin: 0 },
  beingReturned: { bob: 0.25, spin: -3.0 },
  beingCaptured: { bob: 0.3, spin: 4.0 },
  resetting: { bob: 0.4, spin: 6.0 },
};

class FlagMesh {
  readonly group = new THREE.Group();
  private readonly cloth: THREE.Mesh;
  private readonly baseRing: THREE.Mesh;

  constructor(color: number) {
    // 旗杆
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, 2.4, 6),
      new THREE.MeshBasicMaterial({ color: 0xd8cbb4 }),
    );
    pole.position.y = 1.2;
    this.group.add(pole);

    // 旗面。MeshBasic：不受光照 —— 关键信息不能因为站在阴影里就看不清
    this.cloth = new THREE.Mesh(
      new THREE.PlaneGeometry(0.9, 0.6),
      new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }),
    );
    this.cloth.position.set(0.45, 2.0, 0);
    this.group.add(this.cloth);

    // 地面光圈：让旗帜在远处也能被看到（验收 #49）
    this.baseRing = new THREE.Mesh(
      new THREE.RingGeometry(0.5, 0.72, 20),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, side: THREE.DoubleSide }),
    );
    this.baseRing.rotation.x = -Math.PI / 2;
    this.baseRing.position.y = 0.03;
    this.group.add(this.baseRing);
  }

  update(v: FlagView, t: number, scale: number): void {
    const m = STATE_MOTION[v.state];
    this.group.position.set(v.position.x, v.position.y + m.bob * (0.5 + 0.5 * Math.sin(t * 3)), v.position.z);
    this.group.rotation.y = t * m.spin;
    this.group.scale.setScalar(scale);
    // 携带中时旗面更亮，让旗手在人堆里更好找
    (this.cloth.material as THREE.MeshBasicMaterial).opacity =
      v.state === FlagState.Carried ? 1 : 0.9;
    this.baseRing.visible = v.state !== FlagState.Carried;
  }

  dispose(): void {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
  }
}

export class FlagMarkers {
  readonly group = new THREE.Group();
  private readonly meshes = new Map<number, FlagMesh>();
  /** 镜头距离，由场景每帧提供，用于 14.3 的远距放大 */
  cameraDistance = 6;

  constructor() {
    // 自检：旗手必须是关键角色，否则本文件"不读画质"的前提就不成立
    if (!isEssential(ESSENTIAL_ROLES.flagCarrier)) {
      throw new Error('flagCarrier 必须属于 ESSENTIAL_ROLES（14.4）');
    }
  }

  update(views: readonly FlagView[], elapsed: number): void {
    const scale = essentialMarkerScale(this.cameraDistance);
    for (const v of views) {
      const key = v.team as number;
      let mesh = this.meshes.get(key);
      if (!mesh) {
        mesh = new FlagMesh(key === (TEAM_RED as number) ? RED : BLUE);
        this.meshes.set(key, mesh);
        this.group.add(mesh.group);
      }
      // ★ 任何状态下都可见 —— 12.2「对双方持续可见」，
      //   包括旗手潜行时（#40：旗帜不随角色隐藏）
      mesh.group.visible = true;
      mesh.update(v, elapsed, scale);
    }
  }

  dispose(): void {
    for (const m of this.meshes.values()) m.dispose();
    this.meshes.clear();
  }
}
