import * as THREE from 'three';
import { Targeting, type SkillDef } from '@wowpvp/shared';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { AttributeVisual } from './schools.js';
import type { ImpactTier } from '../feedback/impactTier.js';
import type { QualityTier } from '../render/quality.js';

type Point = { x: number; y: number; z: number };
type Triple = readonly [number, number, number];
type Shape = 'shard' | 'orb' | 'arc' | 'ring' | 'beam' | 'cross' | 'leaf';
const SHAPES: readonly Shape[] = ['shard', 'orb', 'arc', 'ring', 'beam', 'cross', 'leaf'];
export const COMBAT_SHAPE_CAPACITY = 256;

interface Piece {
  active: boolean;
  fresh: boolean;
  shape: Shape;
  age: number;
  life: number;
  delay: number;
  gravity: number;
  growth: number;
  opacity: number;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  scale: THREE.Vector3;
  rotation: THREE.Vector3;
  spin: THREE.Vector3;
  color: THREE.Color;
}

interface PieceOptions {
  shape: Shape;
  at: Point;
  color: number;
  scale: Triple;
  life?: number;
  delay?: number;
  velocity?: Triple;
  rotation?: Triple;
  spin?: Triple;
  gravity?: number;
  growth?: number;
  opacity?: number;
}

interface Bank {
  mesh: THREE.InstancedMesh;
  alpha: THREE.InstancedBufferAttribute;
}

function geometryFor(shape: Shape): THREE.BufferGeometry {
  switch (shape) {
    case 'shard': return new THREE.OctahedronGeometry(1);
    case 'orb': return new THREE.IcosahedronGeometry(1, 1);
    case 'arc': return new THREE.RingGeometry(0.74, 1, 22, 1, -0.5, Math.PI * 1.3);
    case 'ring': return new THREE.RingGeometry(0.91, 1, 40);
    case 'beam': return new THREE.CylinderGeometry(1, 1, 1, 6);
    case 'cross': {
      const parts = [new THREE.BoxGeometry(0.20, 0.82, 0.12), new THREE.BoxGeometry(0.70, 0.20, 0.12)];
      const geometry = mergeGeometries(parts)!;
      parts.forEach((part) => part.dispose());
      return geometry;
    }
    case 'leaf': {
      const path = new THREE.Shape();
      path.moveTo(0, -0.5);
      path.quadraticCurveTo(0.48, 0, 0, 0.55);
      path.quadraticCurveTo(-0.32, 0.1, 0, -0.5);
      return new THREE.ShapeGeometry(path, 5);
    }
  }
}

/** Bounded, instanced accents. Authoritative projectiles, boundaries and status markers stay separate. */
export class CombatShapes {
  readonly group = new THREE.Group();
  private readonly banks = new Map<Shape, Bank>();
  private readonly pieces: Piece[] = Array.from({ length: COMBAT_SHAPE_CAPACITY }, () => ({
    active: false, fresh: false, shape: 'orb', age: 0, life: 1, delay: 0,
    gravity: 0, growth: 1, opacity: 1,
    position: new THREE.Vector3(), velocity: new THREE.Vector3(), scale: new THREE.Vector3(),
    rotation: new THREE.Vector3(), spin: new THREE.Vector3(), color: new THREE.Color(),
  }));
  private cursor = 0;
  private clock = 0;
  private inFrame = false;
  private quality: QualityTier = 'medium';
  private camera: Point | undefined;
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly rotation = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly quaternion = new THREE.Quaternion();
  private readonly color = new THREE.Color();

  constructor() {
    this.group.name = 'combat-shapes';
    for (const shape of SHAPES) {
      const geometry = geometryFor(shape);
      const alpha = new THREE.InstancedBufferAttribute(new Float32Array(COMBAT_SHAPE_CAPACITY), 1);
      alpha.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute('instanceOpacity', alpha);
      const material = new THREE.MeshBasicMaterial({
        transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
      });
      material.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
          attribute float instanceOpacity;
          varying float vShapeOpacity;
          varying float vShapeLight;`).replace('#include <begin_vertex>', `#include <begin_vertex>
          vShapeOpacity = instanceOpacity;
          vec3 shapeNormal = normalize(mat3(instanceMatrix) * normal);
          vShapeLight = 0.78 + 0.22 * abs(dot(shapeNormal, vec3(0.44, 0.82, 0.36)));`);
        shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
          varying float vShapeOpacity;
          varying float vShapeLight;`).replace('#include <color_fragment>', `#include <color_fragment>
          diffuseColor.a *= vShapeOpacity;
          diffuseColor.rgb *= vShapeLight;`);
      };
      material.customProgramCacheKey = () => 'combat-shapes-v1';
      const mesh = new THREE.InstancedMesh(geometry, material, COMBAT_SHAPE_CAPACITY);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 5;
      this.group.add(mesh);
      this.banks.set(shape, { mesh, alpha });
    }
  }

  private spawn(o: PieceOptions): void {
    if (this.camera && (o.at.x - this.camera.x) ** 2 + (o.at.z - this.camera.z) ** 2 > 65 ** 2) return;
    const p = this.pieces[this.cursor++ % COMBAT_SHAPE_CAPACITY]!;
    p.active = true;
    p.fresh = !this.inFrame;
    p.shape = o.shape;
    p.age = 0;
    p.life = o.life ?? 0.38;
    p.delay = o.delay ?? 0;
    p.position.set(o.at.x, o.at.y, o.at.z);
    p.velocity.set(...(o.velocity ?? [0, 0, 0]));
    p.rotation.set(...(o.rotation ?? [0, 0, 0]));
    p.spin.set(...(o.spin ?? [0, 0, 0]));
    p.scale.set(...o.scale);
    p.color.setHex(o.color);
    p.gravity = o.gravity ?? 0;
    p.growth = o.growth ?? 1;
    p.opacity = o.opacity ?? 0.85;
  }

  beginFrame(dt: number, quality: QualityTier, camera?: Point): void {
    this.inFrame = true;
    this.clock += dt;
    this.quality = quality;
    this.camera = camera;
    for (const bank of this.banks.values()) bank.mesh.count = 0;
    for (const p of this.pieces) {
      if (!p.active) continue;
      if (p.fresh) p.fresh = false;
      else p.age += dt;
      if (p.age >= p.delay + p.life) p.active = false;
    }
  }

  private write(shape: Shape, at: Point, size: Triple, angles: Triple, color: THREE.Color, opacity: number): void {
    const bank = this.banks.get(shape)!;
    const index = bank.mesh.count;
    if (index >= COMBAT_SHAPE_CAPACITY) return;
    this.position.set(at.x, at.y, at.z);
    this.scale.set(...size);
    this.rotation.set(...angles);
    this.quaternion.setFromEuler(this.rotation);
    this.matrix.compose(this.position, this.quaternion, this.scale);
    bank.mesh.setMatrixAt(index, this.matrix);
    bank.mesh.setColorAt(index, color);
    const close = this.camera && (at.x - this.camera.x) ** 2 + (at.y - this.camera.y) ** 2 + (at.z - this.camera.z) ** 2 < 4;
    bank.alpha.setX(index, opacity * (close ? 0.45 : 1));
    bank.mesh.count++;
  }

  endFrame(): void {
    for (const p of this.pieces) {
      if (!p.active || p.age < p.delay) continue;
      const age = p.age - p.delay;
      const t = Math.min(1, age / p.life);
      const growth = p.growth === 0 ? 1 : (0.25 + 0.75 * (1 - Math.exp(-t * 18))) * (1 + t * (p.growth - 1));
      this.position.set(p.position.x + p.velocity.x * age,
        p.position.y + p.velocity.y * age + p.gravity * age * age * 0.5,
        p.position.z + p.velocity.z * age);
      this.write(p.shape, this.position,
        [p.scale.x * growth, p.scale.y * growth, p.scale.z * growth],
        [p.rotation.x + p.spin.x * age, p.rotation.y + p.spin.y * age, p.rotation.z + p.spin.z * age],
        p.color, p.opacity * Math.min(1, (t + 0.08) * 9) * (1 - t) ** 0.7);
    }
    for (const bank of this.banks.values()) {
      bank.mesh.visible = bank.mesh.count > 0;
      bank.mesh.instanceMatrix.needsUpdate = true;
      if (bank.mesh.instanceColor) bank.mesh.instanceColor.needsUpdate = true;
      bank.alpha.needsUpdate = true;
    }
    this.inFrame = false;
  }

  charge(hand: Point, av: AttributeVisual, progress: number, yaw: number): void {
    if (this.quality === 'low') return;
    const radius = 0.23 + progress * 0.23;
    const center = { x: hand.x + Math.cos(yaw) * 0.42, y: hand.y + 0.22, z: hand.z - Math.sin(yaw) * 0.42 };
    this.color.setHex(av.primary);
    this.write(av.particle === 'snowflake' ? 'shard' : 'orb', center, [radius * 0.65, radius, radius * 0.65],
      [0, this.clock * 3, this.clock], this.color, 0.72);
    for (let i = 0; i < 3; i++) {
      const a = this.clock * 4 + i * Math.PI * 2 / 3;
      const point = { x: center.x + Math.cos(a) * (radius + 0.17), y: center.y + Math.sin(a) * (radius + 0.17), z: center.z };
      this.write('shard', point, [0.07, 0.14, 0.07], [0, a, a], this.color, 0.75);
    }
  }

  release(skill: SkillDef, caster: { position: Point; height: number; yaw: number }, av: AttributeVisual): void {
    const at = { x: caster.position.x - Math.sin(caster.yaw) * 0.8,
      y: caster.position.y + caster.height * 0.58, z: caster.position.z - Math.cos(caster.yaw) * 0.8 };
    const melee = skill.targeting === Targeting.Direct && skill.range.max > 0 && skill.range.max < 8;
    if (melee) {
      this.swing(at, caster.yaw, av, skill.classId === 'rogue' ? 0.85 : 1.2);
    } else {
      this.spawn({ shape: 'ring', at, color: av.primary, scale: [0.38, 0.38, 0.38],
        rotation: [0, caster.yaw, 0], life: 0.24, growth: 2.4 });
    }
    if (skill.targeting === Targeting.SelfCenter && skill.shape.kind === 'circle') {
      const count = this.quality === 'low' ? 5 : 10;
      for (let i = 0; i < count; i++) {
        const a = i / count * Math.PI * 2;
        const r = skill.shape.radius * 0.64;
        const pos = { x: caster.position.x + Math.cos(a) * r, y: caster.position.y + 0.35, z: caster.position.z + Math.sin(a) * r };
        this.spawn({ shape: av.particle === 'snowflake' ? 'shard' : 'orb', at: pos, color: av.primary,
          scale: av.particle === 'snowflake' ? [0.20, 1.05, 0.20] : [0.24, 0.32, 0.24],
          delay: 0.035, life: 0.46, velocity: [Math.cos(a) * 1.5, 0.35, Math.sin(a) * 1.5],
          rotation: [Math.sin(a) * 0.4, 0, -Math.cos(a) * 0.4] });
      }
    }
  }

  swing(at: Point, yaw: number, av: AttributeVisual, size = 1): void {
    this.spawn({ shape: 'arc', at, color: av.primary, scale: [1.35 * size, 1.35 * size, 1],
      rotation: [-1.05, yaw, -0.8], spin: [0.7, 0, 6], life: 0.24, growth: 0, opacity: 0.8 });
    this.spawn({ shape: 'arc', at, color: 0xfff5d6, scale: [1.07 * size, 1.07 * size, 1],
      rotation: [-1.05, yaw, -0.8], spin: [0.7, 0, 6], life: 0.15, growth: 0, opacity: 0.8 });
  }

  impact(at: Point, av: AttributeVisual, tier: ImpactTier = 'normal', from?: Point): void {
    const strength = tier === 'light' ? 0.55 : tier === 'normal' ? 0.9 : tier === 'heavy' ? 1.2 : 1.5;
    const count = Math.ceil((this.quality === 'high' ? 9 : this.quality === 'medium' ? 6 : 3) * strength);
    const icy = av.particle === 'snowflake';
    const fire = av.particle === 'ember';
    const holy = av.particle === 'beam';
    const nature = av.particle === 'leaf';
    if (av.particle === 'spark' && from && Math.hypot(at.x - from.x, at.z - from.z) <= 6) {
      const yaw = Math.atan2(at.x - from.x, at.z - from.z);
      this.swing(at, yaw, av, 0.7 * strength);
    }
    this.spawn({ shape: fire ? 'orb' : 'ring', at, color: av.primary,
      scale: [0.48 * strength, 0.48 * strength, 0.48 * strength], life: 0.26, growth: 1.9 });
    if (tier !== 'light') this.spawn({ shape: 'orb', at, color: 0xfff9e5,
      scale: [0.16 * strength, 0.16 * strength, 0.16 * strength], life: 0.12, growth: 1.5 });
    for (let i = 0; i < count; i++) {
      const a = i / count * Math.PI * 2 + this.cursor * 0.17;
      const speed = (2 + (i % 3) * 0.65) * strength;
      this.spawn({ shape: nature ? 'leaf' : fire || av.particle === 'droplet' ? 'orb' : holy ? 'beam' : 'shard', at,
        color: i % 3 === 0 ? av.secondary : av.primary,
        scale: icy ? [0.14 * strength, 0.44 * strength, 0.12 * strength]
          : holy ? [0.055, 0.7 * strength, 0.055] : [0.18 * strength, 0.24 * strength, 0.14 * strength],
        velocity: [Math.cos(a) * speed, (i % 3 - 0.3) * strength, Math.sin(a) * speed],
        rotation: [a, a * 0.5, a], spin: [icy ? 2 : 0, 3, 4],
        life: fire ? 0.46 : 0.38, gravity: fire ? 1.8 : -3, growth: fire ? 0.6 : 1 });
    }
  }

  heal(at: Point, color = 0x72ed94): void {
    for (let i = 0; i < 3; i++) {
      const a = i * Math.PI * 2 / 3 + this.clock;
      this.spawn({ shape: 'cross', at: { x: at.x + Math.cos(a) * 0.4, y: at.y - 0.3, z: at.z + Math.sin(a) * 0.4 },
        color, scale: [0.32, 0.32, 0.32], delay: i * 0.07, life: 0.55,
        velocity: [0, 1.4, 0], rotation: [0, a, 0], spin: [0, 1.5, 0] });
    }
  }

  connect(from: Point, to: Point, av: AttributeVisual): void {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const length = Math.hypot(dx, dy, dz);
    if (length < 0.2) return;
    this.position.set(dx / length, dy / length, dz / length);
    this.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), this.position);
    this.rotation.setFromQuaternion(this.quaternion, 'YXZ');
    const at = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, z: (from.z + to.z) / 2 };
    const rotation: Triple = [this.rotation.x, this.rotation.y, this.rotation.z];
    const width = av.particle === 'spark' ? 0.025 : 0.055;
    this.spawn({ shape: 'beam', at, color: av.primary, scale: [width, length, width],
      rotation, life: 0.15, growth: 0, opacity: 0.65 });
    this.spawn({ shape: 'beam', at, color: av.secondary, scale: [width * 0.35, length, width * 0.35],
      rotation, life: 0.10, growth: 0, opacity: 0.85 });
  }

  trail(at: Point, av: AttributeVisual, direction: Point): void {
    if (this.quality === 'low') return;
    this.spawn({ shape: av.particle === 'snowflake' ? 'shard' : 'orb', at, color: av.primary,
      scale: [0.10, 0.18, 0.10], velocity: [-direction.x * 0.35, 0.15, -direction.z * 0.35],
      life: 0.23, growth: 0.2, opacity: 0.60 });
  }

  flight(at: Point, av: AttributeVisual, orientation: { x: number; y: number; z: number }): void {
    if (this.quality === 'low' || av.particle === 'spark') return;
    const angles: Triple = [orientation.x, orientation.y, orientation.z];
    this.color.setHex(av.primary);
    const frost = av.particle === 'snowflake';
    const fire = av.particle === 'ember';
    if (frost || av.particle === 'beam') {
      this.write('shard', at, [0.24, 0.24, frost ? 0.7 : 0.8], angles, this.color, 0.7);
    } else {
      this.write('orb', at, [0.34, 0.34, 0.34], angles, this.color, fire ? 0.85 : 0.55);
    }
    if (av.particle === 'rune' || av.particle === 'smoke') {
      this.write('ring', at, [0.47, 0.47, 0.47], [this.clock * 4, this.clock * 2, 0], this.color, 0.8);
      this.write('ring', at, [0.35, 0.35, 0.35], [-this.clock * 3, 0, this.clock * 4], this.color, 0.65);
      return;
    }
    const forwardX = Math.sin(orientation.y);
    const forwardZ = Math.cos(orientation.y);
    for (let i = 0; i < 3; i++) {
      const angle = this.clock * (fire ? 15 : 9) + i * Math.PI * 2 / 3;
      const offset = 0.30;
      const point = {
        x: at.x + Math.cos(angle) * Math.cos(orientation.y) * offset - forwardX * i * 0.18,
        y: at.y + Math.sin(angle) * offset,
        z: at.z - Math.cos(angle) * Math.sin(orientation.y) * offset - forwardZ * i * 0.18,
      };
      this.write(frost || av.particle === 'beam' ? 'shard' : fire || av.particle === 'droplet' ? 'orb' : 'leaf', point,
        frost ? [0.12, 0.32, 0.12] : [0.17, 0.23, 0.17],
        [orientation.x, orientation.y, angle], this.color, 0.75);
    }
  }

  get activeCount(): number { return this.pieces.filter((p) => p.active).length; }
  get renderedCount(): number { return [...this.banks.values()].reduce((sum, bank) => sum + bank.mesh.count, 0); }

  dispose(): void {
    for (const piece of this.pieces) piece.active = false;
    for (const { mesh } of this.banks.values()) {
      mesh.dispose();
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.group.clear();
  }
}
