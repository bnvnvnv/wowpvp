import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PRACTICE_STAGE } from '../scenes/stages.js';
import { arenaArchitecture } from './ArenaArchitecture.js';
import { courtyardGarden } from './CourtyardGarden.js';
import { MapRenderer } from './MapRenderer.js';

describe('royal courtyard artwork', () => {
  it('keeps generated artwork within a small draw and triangle budget', () => {
    const group = new THREE.Group();
    group.add(arenaArchitecture(PRACTICE_STAGE.map), courtyardGarden());
    let meshes = 0;
    let triangles = 0;
    group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      meshes++;
      const positions = mesh.geometry.getAttribute('position');
      expect(positions.count).toBeGreaterThan(0);
      expect(positions.array.every(Number.isFinite)).toBe(true);
      triangles += (mesh.geometry.index?.count ?? positions.count) / 3;
    });
    expect(meshes).toBeLessThanOrEqual(6);
    expect(triangles).toBeLessThan(30000);
  });

  it('keeps the central medallion flat on its platform', () => {
    const inlays = courtyardGarden().getObjectByName('garden-inlays') as THREE.Mesh;
    const positions = inlays.geometry.getAttribute('position');
    let medallionVertices = 0;
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i);
      const z = positions.getZ(i);
      if (Math.abs(x) <= 2.01 && Math.abs(z) <= 2.01) {
        expect(positions.getY(i)).toBeGreaterThanOrEqual(0.35);
        expect(positions.getY(i)).toBeLessThanOrEqual(0.365);
        medallionVertices++;
      }
    }
    expect(medallionVertices).toBeGreaterThan(20);
  });

  it('gives visible battlements real collision geometry', () => {
    const crowns = PRACTICE_STAGE.map.geometry.filter((v) => v.id.startsWith('merlon_') || v.id.startsWith('tower_crown_'));
    expect(crowns.length).toBeGreaterThan(16);
    for (const block of crowns) {
      expect(block.blocksMovement).not.toBe(false);
      expect(block.blocksSight).not.toBe(false);
      expect(block.min.y).toBeGreaterThan(3);
    }
  });

  it('reduces foliage on low quality while retaining the arena architecture', () => {
    const map = new MapRenderer(PRACTICE_STAGE.map);
    map.applyQuality('low');
    expect(map.group.getObjectByName('flower-meadows')?.visible).toBe(false);
    expect(map.group.getObjectByName('courtyard-skyline')?.visible).toBe(false);
    expect(map.group.getObjectByName('arena-architecture')?.visible).toBe(true);
    map.applyQuality('medium');
    expect(map.group.getObjectByName('flower-meadows')?.visible).toBe(true);
  });
});
