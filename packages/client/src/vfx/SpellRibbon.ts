import * as THREE from 'three';
import type { AttributeVisual } from './schools.js';
import type { QualityTier } from '../render/quality.js';

type Point = { x: number; y: number; z: number };
export const RIBBON_LIMIT = 16;
const HISTORY = 14;
const LINGER = 0.22;

interface Trail {
  id: string | null;
  count: number;
  seenAt: number;
  width: number;
  length: number;
  fire: boolean;
  points: Float32Array;
  color: THREE.Color;
}

/** Camera-facing strips sampled from the actual projectile path, with a bounded history. */
export class SpellRibbon {
  readonly mesh: THREE.Mesh;
  private readonly trails: Trail[] = Array.from({ length: RIBBON_LIMIT }, () => ({
    id: null, count: 0, seenAt: 0, width: 0.1, length: 3, fire: false,
    points: new Float32Array(HISTORY * 3), color: new THREE.Color(),
  }));
  private readonly positions = new THREE.BufferAttribute(new Float32Array(RIBBON_LIMIT * HISTORY * 6), 3);
  private readonly colors = new THREE.BufferAttribute(new Float32Array(RIBBON_LIMIT * HISTORY * 6), 3);
  private readonly alpha = new THREE.BufferAttribute(new Float32Array(RIBBON_LIMIT * HISTORY * 2), 1);
  private readonly side = new THREE.BufferAttribute(new Float32Array(RIBBON_LIMIT * HISTORY * 2), 1);
  private readonly indices = new THREE.BufferAttribute(new Uint16Array(RIBBON_LIMIT * (HISTORY - 1) * 6), 1);
  private readonly camera = new THREE.Vector3(0, 8, 15);
  private readonly point = new THREE.Vector3();
  private readonly previous = new THREE.Vector3();
  private readonly next = new THREE.Vector3();
  private readonly tangent = new THREE.Vector3();
  private readonly view = new THREE.Vector3();
  private readonly across = new THREE.Vector3();
  private clock = 0;
  private enabled = true;

  constructor() {
    const geometry = new THREE.BufferGeometry();
    for (const attr of [this.positions, this.colors, this.alpha, this.side, this.indices]) attr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', this.positions);
    geometry.setAttribute('color', this.colors);
    geometry.setAttribute('aRibbonAlpha', this.alpha);
    geometry.setAttribute('aRibbonSide', this.side);
    geometry.setIndex(this.indices);
    geometry.setDrawRange(0, 0);
    const material = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false,
      side: THREE.DoubleSide, toneMapped: false,
    });
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
        attribute float aRibbonAlpha;
        attribute float aRibbonSide;
        varying float vRibbonAlpha;
        varying float vRibbonSide;`).replace('#include <begin_vertex>', `#include <begin_vertex>
        vRibbonAlpha = aRibbonAlpha;
        vRibbonSide = aRibbonSide;`);
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
        varying float vRibbonAlpha;
        varying float vRibbonSide;`).replace('#include <color_fragment>', `#include <color_fragment>
        float ribbonCore = max(0.0, 1.0 - abs(vRibbonSide));
        diffuseColor.a *= vRibbonAlpha * pow(ribbonCore, 0.4);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), pow(ribbonCore, 7.0) * 0.4);`);
    };
    material.customProgramCacheKey = () => 'spell-ribbon-v1';
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = 'spell-ribbons';
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 4;
  }

  beginFrame(dt: number, quality: QualityTier, camera?: Point): void {
    this.clock += dt;
    this.enabled = quality !== 'low';
    if (camera) this.camera.set(camera.x, camera.y, camera.z);
    for (const trail of this.trails) {
      if (!this.enabled) { trail.id = null; trail.count = 0; }
    }
  }

  follow(id: string, at: Point, visual: AttributeVisual): void {
    if (!this.enabled) return;
    let trail = this.trails.find((item) => item.id === id);
    if (!trail) {
      trail = this.trails.find((item) => item.id === null);
      if (!trail) return; // Stable admission prevents overcrowded scenes constantly replacing every history.
      trail.id = id;
      trail.count = 0;
    }
    const p = trail.points;
    if (trail.count === 0 || Math.hypot(at.x - p[0]!, at.y - p[1]!, at.z - p[2]!) > 0.12) {
      p.copyWithin(3, 0, (HISTORY - 1) * 3);
      trail.count = Math.min(HISTORY, trail.count + 1);
    }
    p[0] = at.x; p[1] = at.y; p[2] = at.z;
    trail.seenAt = this.clock;
    trail.color.setHex(visual.primary);
    trail.fire = visual.particle === 'ember';
    trail.width = trail.fire ? 0.24 : visual.particle === 'smoke' ? 0.22 : visual.particle === 'spark' ? 0.055 : 0.20;
    trail.length = visual.particle === 'spark' ? 2.2 : trail.fire ? 4 : 3.4;
  }

  endFrame(): void {
    let vertex = 0;
    let index = 0;
    for (const trail of this.trails) {
      // Expire after projectiles update: a slow frame must retain their previous sample.
      if (this.clock - trail.seenAt > LINGER) { trail.id = null; trail.count = 0; }
      if (trail.id === null || trail.count < 2) continue;
      const start = vertex;
      let distance = 0;
      for (let i = 0; i < trail.count; i++) {
        this.point.fromArray(trail.points, i * 3);
        let last = i === trail.count - 1;
        if (i > 0) {
          const length = this.point.distanceTo(this.previous);
          if (distance + length > trail.length) {
            this.point.lerpVectors(this.previous, this.point, (trail.length - distance) / Math.max(0.0001, length));
            distance = trail.length;
            last = true;
          } else distance += length;
        }
        this.next.fromArray(trail.points, Math.min(i + 1, trail.count - 1) * 3);
        this.tangent.subVectors(i === 0 ? this.point : this.previous, last ? this.point : this.next);
        this.view.subVectors(this.camera, this.point);
        this.across.crossVectors(this.tangent, this.view);
        if (this.across.lengthSq() < 0.00001) this.across.set(1, 0, 0);
        else this.across.normalize();
        const t = Math.min(1, distance / trail.length);
        const pulse = trail.fire ? 1 + Math.sin(this.clock * 23 + distance * 4) * 0.15 : 1;
        const width = trail.width * (1 - t * 0.85) * pulse;
        const closeFade = this.view.lengthSq() < 4 ? 0.45 : 1;
        const opacity = (1 - t) ** 0.8 * Math.max(0, 1 - (this.clock - trail.seenAt) / LINGER) * 0.9 * closeFade;
        for (const side of [-1, 1]) {
          this.positions.setXYZ(vertex, this.point.x + this.across.x * width * side,
            this.point.y + this.across.y * width * side, this.point.z + this.across.z * width * side);
          this.colors.setXYZ(vertex, trail.color.r, trail.color.g, trail.color.b);
          this.alpha.setX(vertex, opacity);
          this.side.setX(vertex, side);
          vertex++;
        }
        if (vertex > start + 2) {
          for (const n of [vertex - 4, vertex - 2, vertex - 3, vertex - 3, vertex - 2, vertex - 1]) this.indices.setX(index++, n);
        }
        this.previous.copy(this.point);
        if (last) break;
      }
    }
    this.mesh.geometry.setDrawRange(0, index);
    this.mesh.visible = index > 0;
    for (const attr of [this.positions, this.colors, this.alpha, this.side, this.indices]) attr.needsUpdate = true;
  }

  get activeCount(): number { return this.trails.filter((trail) => trail.id !== null && trail.count > 1).length; }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    for (const trail of this.trails) { trail.id = null; trail.count = 0; }
  }
}
