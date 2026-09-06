import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { paintedMaterial } from './toonMaterial.js';

type Triple = readonly [number, number, number];

/** Static colored details share a draw call, including trees and tiny masonry pieces. */
export class ArtGeometry {
  private readonly parts: THREE.BufferGeometry[] = [];

  add(geometry: THREE.BufferGeometry, tint: number, position: Triple,
    rotation: Triple = [0, 0, 0], scale: Triple = [1, 1, 1]): THREE.BufferGeometry {
    geometry.scale(...scale);
    geometry.rotateX(rotation[0]);
    geometry.rotateY(rotation[1]);
    geometry.rotateZ(rotation[2]);
    geometry.translate(...position);
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    if (flat !== geometry) geometry.dispose();
    const color = new THREE.Color(tint);
    const colors = new Float32Array(flat.getAttribute('position').count * 3);
    for (let i = 0; i < colors.length; i += 3) color.toArray(colors, i);
    flat.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.parts.push(flat);
    return flat;
  }

  box(size: Triple, tint: number, position: Triple, yaw = 0): THREE.BufferGeometry {
    return this.add(new THREE.BoxGeometry(...size), tint, position, [0, yaw, 0]);
  }

  mesh(name: string, material: THREE.Material = paintedMaterial({ vertexColors: true })): THREE.Mesh {
    const geometry = this.parts.length ? mergeGeometries(this.parts)! : new THREE.BufferGeometry();
    this.parts.forEach((part) => part.dispose());
    this.parts.length = 0;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    return mesh;
  }
}
