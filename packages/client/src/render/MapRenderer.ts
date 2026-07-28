/**
 * 地图渲染。
 *
 * ★ 网格**完全由 `MapDef.geometry` 生成**，不允许美术单独提供场景模型再「大致对齐」碰撞盒。
 *   见 docs/06-modes-and-maps.md §8.2 —— 那样做会立刻违反验收 #8（范围边界与判定一致）
 *   和 #11（墙柱门正确挡视线）。所见即所中，只有一份几何。
 */

import * as THREE from 'three';
import type { MapDef, MapVolume } from '@wowpvp/shared';

/** 按语义标签选材。颜色只影响观感，判定看 Aabb 上的 flag */
const MATERIALS: Record<MapVolume['tag'], { color: number; opacity?: number }> = {
  floor: { color: 0x3a4048 },
  wall: { color: 0x555d68 },
  pillar: { color: 0x6a7280 },
  roof: { color: 0x4a5058 },
  ramp: { color: 0x455060 },
  rail: { color: 0x8a7a5a },
  arch: { color: 0x7a6a9a, opacity: 0.25 },
  water: { color: 0x2a6a9a, opacity: 0.45 },
  gate: { color: 0x9a6a3a },
};

export class MapRenderer {
  readonly group = new THREE.Group();
  private debugGroup = new THREE.Group();

  constructor(map: MapDef) {
    this.group.name = `map:${map.id}`;
    this.debugGroup.visible = false;
    this.group.add(this.debugGroup);

    for (const v of map.geometry) {
      const w = v.max.x - v.min.x;
      const h = v.max.y - v.min.y;
      const d = v.max.z - v.min.z;
      const spec = MATERIALS[v.tag] ?? { color: 0x666666 };

      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(w, h, d),
        new THREE.MeshLambertMaterial({
          color: spec.color,
          transparent: spec.opacity !== undefined,
          opacity: spec.opacity ?? 1,
        }),
      );
      mesh.position.set(
        (v.min.x + v.max.x) / 2,
        (v.min.y + v.max.y) / 2,
        (v.min.z + v.max.z) / 2,
      );
      mesh.name = v.id;
      mesh.castShadow = v.tag !== 'floor';
      mesh.receiveShadow = true;
      this.group.add(mesh);

      // 调试线框：标出「挡移动但不挡视线」的物件（6.4 低矮栏杆）
      if (v.blocksSight === false && v.blocksMovement !== false) {
        const edges = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)),
          new THREE.LineBasicMaterial({ color: 0x00ff88 }),
        );
        edges.position.copy(mesh.position);
        this.debugGroup.add(edges);
      }
    }
  }

  setDebugVisible(v: boolean): void {
    this.debugGroup.visible = v;
  }
}
