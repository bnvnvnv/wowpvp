import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export function mergeStaticMeshes(meshes: readonly THREE.Mesh[]): THREE.Group {
  const result = new THREE.Group();
  const buckets = new Map<string, THREE.Mesh[]>();
  for (const mesh of meshes) {
    if (Array.isArray(mesh.material) || mesh.material.transparent) {
      result.add(mesh);
      continue;
    }
    mesh.updateWorldMatrix(true, false);
    const key = `${mesh.material.uuid}:${mesh.castShadow}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(mesh);
    buckets.set(key, bucket);
  }
  for (const bucket of buckets.values()) {
    const pieces = bucket.map((mesh) => mesh.geometry.clone().applyMatrix4(mesh.matrixWorld));
    const geometry = mergeGeometries(pieces)!;
    pieces.forEach((piece) => piece.dispose());
    const first = bucket[0]!;
    const mesh = new THREE.Mesh(geometry, first.material);
    mesh.castShadow = first.castShadow;
    mesh.receiveShadow = first.receiveShadow;
    mesh.matrixAutoUpdate = false;
    result.add(mesh);
  }
  return result;
}

/** Spatial batches keep repeated scenery cheap without losing view-frustum culling. */
export function instanceStaticMeshes(meshes: readonly THREE.Mesh[]): THREE.Group {
  const result = new THREE.Group();
  const buckets = new Map<string, THREE.Mesh[]>();
  for (const mesh of meshes) {
    mesh.updateWorldMatrix(true, false);
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const p = new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld);
    const key = `${mesh.geometry.uuid}:${materials.map((m) => m.uuid).join(',')}:${mesh.castShadow}:${Math.floor(p.x / 24)}:${Math.floor(p.z / 24)}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(mesh);
    buckets.set(key, bucket);
  }
  for (const bucket of buckets.values()) {
    const first = bucket[0]!;
    const batch = new THREE.InstancedMesh(first.geometry, first.material, bucket.length);
    batch.name = first.name;
    batch.castShadow = first.castShadow;
    batch.receiveShadow = first.receiveShadow;
    bucket.forEach((mesh, i) => batch.setMatrixAt(i, mesh.matrixWorld));
    batch.computeBoundingBox();
    batch.computeBoundingSphere();
    batch.matrixAutoUpdate = false;
    result.add(batch);
  }
  return result;
}
