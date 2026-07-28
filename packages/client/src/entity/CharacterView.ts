/**
 * 角色的可视化表现。
 *
 * M1 用程序化几何体（胶囊 + 盒子），**不引入任何外部素材**
 * （见 docs/09-asset-license.md §5：核心手感验证完成前引入美术资产是浪费）。
 *
 * 13.2「所有人形职业使用大体一致的战斗碰撞体，不能因模型胖瘦获得命中优势」——
 * 这里的视觉尺寸直接取自 GEOMETRY 常量，所以视觉与判定天然一致。
 */

import * as THREE from 'three';
import { GEOMETRY } from '@wowpvp/shared';
import { AnimState } from './AnimationController.js';

/** 各动作状态的调试配色。M8 引入真实动画后这层会被替换 */
const STATE_COLOR: Record<AnimState, number> = {
  [AnimState.Idle]: 0x7fa8d0,
  [AnimState.Walk]: 0x7fd0a8,
  [AnimState.Run]: 0x4fe08a,
  [AnimState.Backward]: 0xd0a87f,
  [AnimState.StrafeLeft]: 0xd0d07f,
  [AnimState.StrafeRight]: 0xd0d07f,
  [AnimState.Jump]: 0xe0e0ff,
  [AnimState.Fall]: 0xa0a0ff,
  [AnimState.Land]: 0xffd070,
  [AnimState.Stunned]: 0xff8040,
  [AnimState.Death]: 0x606060,
};

export class CharacterView {
  readonly group = new THREE.Group();
  /** 4.1 第一人称要隐藏的部分：头部与躯干 */
  private readonly hideInFirstPerson: THREE.Object3D[] = [];
  private readonly bodyMat: THREE.MeshLambertMaterial;
  private readonly hitboxHelper: THREE.LineSegments;
  /** 朝向指示器，让「角色朝向 ≠ 镜头朝向」肉眼可辨（验收 #2）*/
  private readonly facingArrow: THREE.Mesh;

  constructor() {
    const r = GEOMETRY.HITBOX_RADIUS;
    const h = GEOMETRY.HITBOX_HEIGHT;

    this.bodyMat = new THREE.MeshLambertMaterial({ color: STATE_COLOR[AnimState.Idle] });

    // 躯干：胶囊，高度扣掉两端半球
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(r, h - r * 2 - 0.35, 6, 12), this.bodyMat);
    torso.position.y = (h - 0.35) / 2;
    torso.castShadow = true;
    this.group.add(torso);
    this.hideInFirstPerson.push(torso);

    // 头
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 12, 10),
      new THREE.MeshLambertMaterial({ color: 0xe8d0b0 }),
    );
    head.position.y = h - 0.2;
    head.castShadow = true;
    this.group.add(head);
    this.hideInFirstPerson.push(head);

    // 朝向箭头：贴地的一个楔形，指向角色正面（-Z）
    this.facingArrow = new THREE.Mesh(
      new THREE.ConeGeometry(0.18, 0.5, 4),
      new THREE.MeshBasicMaterial({ color: 0xffcc44 }),
    );
    this.facingArrow.rotation.x = -Math.PI / 2;
    this.facingArrow.position.set(0, 0.05, -r - 0.3);
    this.group.add(this.facingArrow);

    // 战斗碰撞体线框（F1 切换）。13.2：所有职业一致
    this.hitboxHelper = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.CylinderGeometry(r, r, h, 16, 1, true)),
      new THREE.LineBasicMaterial({ color: 0xff4488 }),
    );
    this.hitboxHelper.position.y = h / 2;
    this.hitboxHelper.visible = false;
    this.group.add(this.hitboxHelper);
  }

  setTransform(position: { x: number; y: number; z: number }, yaw: number): void {
    this.group.position.set(position.x, position.y, position.z);
    this.group.rotation.y = yaw;
  }

  setAnimState(state: AnimState): void {
    this.bodyMat.color.setHex(STATE_COLOR[state]);
  }

  /** 4.1 第一人称隐藏遮挡视线的头部和身体 */
  setFirstPerson(on: boolean): void {
    for (const o of this.hideInFirstPerson) o.visible = !on;
    // 朝向箭头保留 —— 它是地面指示器性质的信息，4.1 要求第一人称保留地面范围
  }

  setHitboxVisible(v: boolean): void {
    this.hitboxHelper.visible = v;
  }
}
