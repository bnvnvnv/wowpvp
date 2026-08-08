/**
 * 军械箱与地面掉落物的 3D 表现。规格书 10.2 / 10.4 / 10.5，验收 #28 / #29。
 *
 * ★★ **在此之前联网客户端看不到任何一件临时武装。**
 *   规则层从 M6 起就完整（军械点布置、职业归属、三选一、0.8 秒拾取、
 *   先到者得），单测也全绿 —— 但快照里没有这些数据，客户端也没有渲染，
 *   于是「抢装备」这条玩法在真实对局里等于不存在。
 *   这是本仓库「规则写对了、没有人调用它」家族的又一员。
 *
 * ★ 本文件**不读画质档位**，与 `FlagMarkers` 同一个理由：
 *   10.4 明确要求刷新前 5 秒给出「小地图图标、地面光柱、文字和音效」，
 *   那是**信息**不是装饰。14.4 允许减少的五项里没有它，
 *   所以这里根本不去调 `hiddenAtQuality()` —— 不调用就藏不掉。
 *
 * ★ 17.2「不能只依赖颜色」：三类掉落用**形状**区分（武器=八面体、
 *   护甲=方块、增益=球），可否拾取用**亮度 + 地面光圈的有无**区分。
 *   色盲模式下三种形状仍然一眼可分。
 */

import * as THREE from 'three';
import { RANGE, type ArmorySnapshot, type HydratedDropSnapshot as DropSnapshot, type Vec3 } from '@wowpvp/shared';

/** 10.4：刷新前 5 秒进入预告窗口。★ 与 sim 的 `EQUIP.SPAWN_TELEGRAPH_SECONDS` 同值 */
const TELEGRAPH_SECONDS = 5;

const COLOR_BY_KIND: Record<DropSnapshot['kind'], number> = {
  weapon: 0xffd27a,
  armor: 0x8fb8ff,
  consumable: 0x8fe3a8,
};

/** 17.2：形状是第二条通道 —— 只改颜色的话色盲玩家分不出武器和护甲 */
const geometryFor = (kind: DropSnapshot['kind']): THREE.BufferGeometry => {
  switch (kind) {
    case 'weapon': return new THREE.OctahedronGeometry(0.26);
    case 'armor': return new THREE.BoxGeometry(0.36, 0.36, 0.36);
    case 'consumable': return new THREE.SphereGeometry(0.22, 12, 8);
  }
};

class DropMesh {
  readonly group = new THREE.Group();
  private readonly body: THREE.Mesh;
  private readonly ring: THREE.Mesh;

  constructor(readonly kind: DropSnapshot['kind']) {
    const color = COLOR_BY_KIND[kind];
    // MeshBasic：不受光照 —— 站在阴影里也要看得清（与 FlagMarkers 同一条）
    this.body = new THREE.Mesh(
      geometryFor(kind),
      new THREE.MeshBasicMaterial({ color, transparent: true }),
    );
    this.body.position.y = 0.45;
    this.group.add(this.body);

    // 地面光圈只在**可拾取**时出现：10.2「看得到但拿不走」的第二条通道
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.34, 0.46, 18),
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.55, side: THREE.DoubleSide,
      }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.04;
    this.group.add(this.ring);
  }

  update(d: DropSnapshot, elapsed: number): void {
    this.group.position.set(d.position.x, d.position.y, d.position.z);
    this.body.position.y = 0.45 + 0.06 * Math.sin(elapsed * 2.2);
    this.body.rotation.y = elapsed * 0.9;
    /**
     * 10.2：不匹配职业的玩家**看得到**掉落物 —— 所以不可拾取时是**变暗**，
     * 不是隐藏。隐藏会让他不知道那里有东西可抢，而 10.4 的争夺需要双方
     * 都知道场上有什么。
     */
    (this.body.material as THREE.MeshBasicMaterial).opacity = d.pickable ? 1 : 0.42;
    this.ring.visible = d.pickable;
  }

  dispose(): void { disposeTree(this.group); }
}

class ArmoryMesh {
  readonly group = new THREE.Group();
  private readonly crate: THREE.Mesh;
  private readonly beam: THREE.Mesh;
  private readonly ring: THREE.Mesh;

  constructor() {
    this.crate = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 0.7, 0.9),
      new THREE.MeshBasicMaterial({ color: 0xc9a86a, transparent: true }),
    );
    this.crate.position.y = 0.35;
    this.group.add(this.crate);

    /**
     * 10.4「刷新前 5 秒显示……**地面光柱**」。
     * ★ 加法混合而不是半透明：光柱要在任何背景上都读得出来。
     */
    this.beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 0.75, 6, 12, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xffe6a8, transparent: true, opacity: 0.3,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    this.beam.position.y = 3;
    this.group.add(this.beam);

    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.8, 1.05, 24),
      new THREE.MeshBasicMaterial({
        color: 0xffe6a8, transparent: true, opacity: 0.5, side: THREE.DoubleSide,
      }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.03;
    this.group.add(this.ring);
  }

  update(a: ArmorySnapshot, serverTime: number, elapsed: number): void {
    this.group.position.set(a.position.x, a.position.y, a.position.z);

    const remaining = a.availableAt - serverTime;
    const ready = remaining <= 0;
    const telegraphing = !ready && remaining <= TELEGRAPH_SECONDS;

    /**
     * 箱子在冷却期间**仍然画**（半透明），因为 10.4 的补给点是「固定、可预测」的：
     * 玩家要能提前站位。完全隐藏会让「等下一轮」这个决策失去锚点。
     */
    this.group.visible = true;
    const crateMat = this.crate.material as THREE.MeshBasicMaterial;
    crateMat.opacity = ready ? (a.opened ? 0.35 : 1) : 0.25;
    this.crate.rotation.y = ready && !a.opened ? elapsed * 0.5 : 0;

    // 预告期：光柱由弱到强脉动；到点后光柱收起，改由箱子本体表示可用
    this.beam.visible = telegraphing;
    if (telegraphing) {
      const t = 1 - remaining / TELEGRAPH_SECONDS;      // 0 → 1
      const pulse = 0.5 + 0.5 * Math.sin(elapsed * 8);
      (this.beam.material as THREE.MeshBasicMaterial).opacity = 0.15 + 0.45 * t * pulse;
    }

    this.ring.visible = ready && !a.opened;
  }

  dispose(): void { disposeTree(this.group); }
}

const disposeTree = (root: THREE.Object3D): void => {
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  });
};

/** 玩家脚下最近的一个可交互物。`undefined` = 交互键此刻没有对象 */
export type Interactable =
  | { kind: 'drop'; drop: DropSnapshot; distance: number }
  | { kind: 'armory'; armory: ArmorySnapshot; distance: number };

export class ArsenalView {
  readonly group = new THREE.Group();
  private readonly drops = new Map<number, DropMesh>();
  private readonly armories = new Map<number, ArmoryMesh>();

  private lastDrops: readonly DropSnapshot[] = [];
  private lastArmories: readonly ArmorySnapshot[] = [];
  private lastServerTime = 0;

  update(
    drops: readonly DropSnapshot[],
    armories: readonly ArmorySnapshot[],
    serverTime: number,
    elapsed: number,
  ): void {
    this.lastDrops = drops;
    this.lastArmories = armories;
    this.lastServerTime = serverTime;

    // 掉落物：被捡走就从快照里消失，所以按 id 差集回收
    const liveDrops = new Set<number>();
    for (const d of drops) {
      liveDrops.add(d.id);
      let mesh = this.drops.get(d.id);
      /**
       * ★ 形状由 kind 决定，而同一个 id 的 kind 不会变 —— 所以只在新增时建。
       *   （id 是 `ArsenalStore.nextId` 单调递增的，不会被复用。）
       */
      if (!mesh) {
        mesh = new DropMesh(d.kind);
        this.drops.set(d.id, mesh);
        this.group.add(mesh.group);
      }
      mesh.update(d, elapsed);
    }
    for (const [id, mesh] of [...this.drops]) {
      if (liveDrops.has(id)) continue;
      this.group.remove(mesh.group);
      mesh.dispose();
      this.drops.delete(id);
    }

    // 军械点数量在一局里不变，但仍按 id 建表 —— 换地图/换模式时自然跟着变
    for (const a of armories) {
      let mesh = this.armories.get(a.id);
      if (!mesh) {
        mesh = new ArmoryMesh();
        this.armories.set(a.id, mesh);
        this.group.add(mesh.group);
      }
      mesh.update(a, serverTime, elapsed);
    }
  }

  /**
   * 10.5：玩家脚下 2.2 米内最近的可交互物。
   *
   * ★★ **消歧发生在客户端，结论发进协议。**
   *   玩家按的是同一个交互键，可能想拔旗、捡装备或开军械箱。
   *   服务器此前靠「先试旗帜、失败了再当掉落」猜 —— 在旗边捡东西会猜错。
   *   客户端有完整的世界视图，由它决定「你指的是哪一个」，
   *   再把结论以可辨识联合发出去（`InteractTarget`）。
   *   ★ 服务器仍然会重新校验距离与合法性 —— 客户端只是表达意图。
   *
   * ★ 可拾取的优先于不可拾取的：站在一堆别人职业的装备中间时，
   *   交互键应该指向那件你真的拿得走的东西，而不是最近的那件。
   */
  nearestInteractable(position: Vec3): Interactable | undefined {
    let best: Interactable | undefined;
    const better = (candidate: Interactable): boolean => {
      if (!best) return true;
      // 可拾取优先；同为可拾取（或同为不可）时取更近的
      const bestPickable = best.kind === 'drop' ? best.drop.pickable : true;
      const candPickable = candidate.kind === 'drop' ? candidate.drop.pickable : true;
      if (candPickable !== bestPickable) return candPickable;
      return candidate.distance < best.distance;
    };

    for (const d of this.lastDrops) {
      const distance = Math.hypot(d.position.x - position.x, d.position.z - position.z);
      if (distance > RANGE.INTERACT) continue;
      const candidate: Interactable = { kind: 'drop', drop: d, distance };
      if (better(candidate)) best = candidate;
    }
    for (const a of this.lastArmories) {
      // 没到点或已被开过的箱子不参与 —— 交互键不该指向一个必定失败的对象
      if (a.availableAt > this.lastServerTime || a.opened) continue;
      const distance = Math.hypot(a.position.x - position.x, a.position.z - position.z);
      if (distance > RANGE.INTERACT) continue;
      const candidate: Interactable = { kind: 'armory', armory: a, distance };
      if (better(candidate)) best = candidate;
    }
    return best;
  }

  /** 10.4：进入预告窗口（还剩 ≤5 秒）的军械点，供小地图与提示文字使用 */
  telegraphing(serverTime: number): readonly ArmorySnapshot[] {
    return this.lastArmories.filter((a) => {
      const remaining = a.availableAt - serverTime;
      return remaining > 0 && remaining <= TELEGRAPH_SECONDS;
    });
  }

  dispose(): void {
    for (const m of this.drops.values()) m.dispose();
    for (const m of this.armories.values()) m.dispose();
    this.drops.clear();
    this.armories.clear();
  }
}
