import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { instanceStaticMeshes, mergeStaticMeshes } from './staticBatch.js';

describe('static scenery batches', () => {
  it('merges solid map surfaces without changing their world bounds', () => {
    const material = new THREE.MeshLambertMaterial();
    const a = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), material);
    const b = new THREE.Mesh(new THREE.BoxGeometry(4, 2, 2), material);
    b.position.x = 10;
    const combined = mergeStaticMeshes([a, b]);
    expect(combined.children).toHaveLength(1);
    const bounds = new THREE.Box3().setFromObject(combined);
    expect(bounds.min.toArray()).toEqual([-1, -1, -1]);
    expect(bounds.max.toArray()).toEqual([12, 1, 1]);
  });
  it('preserves nested transforms and shares a draw for repeated meshes', () => {
    const geometry = new THREE.BoxGeometry(1, 2, 1);
    const material = new THREE.MeshLambertMaterial();
    const root = new THREE.Group();
    root.position.set(2, 0, 3);
    root.scale.setScalar(2);
    const a = new THREE.Mesh(geometry, material);
    const b = new THREE.Mesh(geometry, material);
    b.position.x = 3;
    root.add(a, b);
    const group = instanceStaticMeshes([a, b]);
    const batch = group.children[0] as THREE.InstancedMesh;
    expect(group.children).toHaveLength(1);
    expect(batch.count).toBe(2);
    const matrix = new THREE.Matrix4();
    batch.getMatrixAt(1, matrix);
    expect(matrix.elements).toEqual(b.matrixWorld.elements);
    expect(batch.boundingBox).not.toBeNull();
    expect(batch.boundingSphere).not.toBeNull();
  });

  it('separates distant objects so one visible object does not draw the whole map', () => {
    const geometry = new THREE.BoxGeometry();
    const material = new THREE.MeshLambertMaterial();
    const a = new THREE.Mesh(geometry, material);
    const b = new THREE.Mesh(geometry, material);
    b.position.x = 50;
    expect(instanceStaticMeshes([a, b]).children).toHaveLength(2);
  });
});
