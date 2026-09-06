import * as THREE from 'three';
import { ArtGeometry } from './ArtGeometry.js';
import { paintedMaterial } from './toonMaterial.js';

const GOLD = 0xcdb56b;
const HALF_PI = Math.PI / 2;

export function courtyardGarden(): THREE.Group {
  const ground = new ArtGeometry();
  const plants = new ArtGeometry();
  const distant = new ArtGeometry();
  const gates = new ArtGeometry();
  const plane = (w: number, d: number, color: number, x: number, y: number, z: number): void => {
    ground.add(new THREE.PlaneGeometry(w, d), color, [x, y, z], [-HALF_PI, 0, 0]);
  };
  for (let ix = 0; ix < 28; ix++) for (let iz = 0; iz < 26; iz++) {
    const x = -27 + ix * 2;
    const z = -25 + iz * 2;
    if (Math.abs(x) < 15 && Math.abs(z) < 20) continue;
    const palette = [0x64b86e, 0x68bb70, 0x6cbc75, 0x67b970];
    plane(2, 2, palette[(ix * 7 + iz * 3) % palette.length]!, x, 0.008, z);
  }
  for (const side of [-1, 1]) {
    plane(0.22, 40.25, 0xd7d1b5, side * 15.1, 0.012, 0);
    plane(30.45, 0.22, 0xd7d1b5, 0, 0.012, side * 20.1);
    plane(0.06, 40.3, 0x718880, side * 15.25, 0.013, 0);
    // Colored inlays establish the two ends without looking like spell telegraphs.
    plane(5.5, 3.0, side > 0 ? 0xb77570 : 0x6b9aab, 0, 0.014, side * 17);
    for (const x of [-2.85, 2.85]) plane(0.12, 3.2, GOLD, x, 0.015, side * 17);
    for (const edge of [-1.6, 1.6]) plane(5.82, 0.12, GOLD, 0, 0.015, side * 17 + edge);
  }

  ground.add(new THREE.CircleGeometry(2.0, 8), 0x567c83, [0, 0.356, 0], [-HALF_PI, Math.PI / 8, 0]);
  ground.add(new THREE.RingGeometry(1.85, 2.0, 8), GOLD, [0, 0.357, 0], [-HALF_PI, Math.PI / 8, 0]);
  const crest = new THREE.Shape();
  crest.moveTo(-0.9, -0.45);
  crest.lineTo(-1.03, 0.7);
  crest.lineTo(-0.45, 0.32);
  crest.lineTo(0, 1.05);
  crest.lineTo(0.45, 0.32);
  crest.lineTo(1.03, 0.7);
  crest.lineTo(0.9, -0.45);
  crest.closePath();
  ground.add(new THREE.ShapeGeometry(crest), 0xe4c777, [0, 0.36, 0], [-HALF_PI, 0, 0]);
  plane(1.82, 0.12, GOLD, 0, 0.36, 0.7);

  for (const side of [-1, 1]) {
    const z = side * 25.34;
    const yaw = side > 0 ? Math.PI : 0;
    const door = new THREE.Shape();
    door.moveTo(-1.3, 0);
    door.lineTo(1.3, 0);
    door.lineTo(1.3, 1.6);
    door.absarc(0, 1.6, 1.3, 0, Math.PI, false);
    door.closePath();
    gates.add(new THREE.ShapeGeometry(door, 16), 0x746859, [0, 0.025, z], [0, yaw, 0]);
    gates.add(new THREE.TorusGeometry(1.46, 0.14, 5, 20, Math.PI), 0xd9d9c9, [0, 1.62, z], [0, yaw, 0]);
    for (const x of [-1.46, 1.46]) gates.box([0.28, 1.65, 0.04], 0xb7c2c0, [x, 0.825, z]);
    for (const x of [-1, -0.5, 0, 0.5, 1]) {
      const h = 1.6 + Math.sqrt(1.3 * 1.3 - x * x);
      gates.box([0.022, h, 0.018], 0x4a5351, [x, h / 2 + 0.025, z - side * 0.024]);
    }
    for (const y of [0.55, 1.45]) gates.box([2.45, 0.095, 0.035], 0xbda65d, [0, y, z - side * 0.04]);
    gates.add(new THREE.TorusGeometry(0.11, 0.025, 5, 12), 0xe5c474, [0, 1.03, z - side * 0.065], [0, yaw, 0]);
  }

  let seed = 127;
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const blade = new THREE.Shape();
  blade.moveTo(-0.06, 0);
  blade.lineTo(0.025, 0.31);
  blade.lineTo(0.06, 0);
  blade.closePath();
  for (let i = 0; i < 420; i++) {
    const x = (random() > 0.5 ? 1 : -1) * (17 + random() * 10);
    const z = -24 + random() * 48;
    const yaw = random() * Math.PI * 2;
    const size = 0.8 + random() * 1.1;
    plants.add(new THREE.ShapeGeometry(blade), i % 2 ? 0x4c963d : 0x95ca5b,
      [x, 0.01, z], [0, yaw, 0], [size, size, size]);
    if (i % 4 === 0) {
      const flowerColor = [0xf7ca64, 0xf5e8bb, 0xe98faa][i % 3]!;
      for (let petal = 0; petal < 5; petal++) {
        const a = petal / 5 * Math.PI * 2;
        plants.add(new THREE.CircleGeometry(0.08, 5), flowerColor,
          [x + Math.cos(a) * 0.07, size * 0.27, z + Math.sin(a) * 0.07], [-HALF_PI, 0, 0]);
      }
      plants.add(new THREE.CircleGeometry(0.04, 6), 0xb18b35, [x, size * 0.27 + 0.003, z], [-HALF_PI, 0, 0]);
    }
  }

  // Tall scenery stays outside the arena walls, so its trunks cannot become false cover.
  for (const side of [-1, 1]) for (const z of [-32, -16, 3, 22, 36]) {
    const x = side * (32 + random() * 4);
    const height = 5 + random() * 1.7;
    distant.add(new THREE.CylinderGeometry(0.32, 0.62, height, 6), 0x827052, [x, height / 2 - 1, z]);
    for (let i = 0; i < 4; i++) {
      const angle = i * 2.1;
      distant.add(new THREE.IcosahedronGeometry(1.6 + random() * 0.6, 1), [0x419c68, 0x60b975, 0x78c379, 0x4faa76][i]!,
        [x + Math.cos(angle) * 1.1, height + (i % 2) * 1.2, z + Math.sin(angle) * 1.1],
        [0, random() * 3, 0], [1.1, 1, 0.95]);
    }
  }
  for (const side of [-1, 1]) for (let i = 0; i < 3; i++) {
    distant.add(new THREE.ConeGeometry(20 + i * 3, 26 + i * 3, 5), [0x8daeba, 0x789faa, 0x84aaae][i]!,
      [side * (62 + i * 17), 3, -65 - i * 17], [0, i * 0.9, 0], [1.3, 1, 0.8]);
  }

  const group = new THREE.Group();
  group.name = 'courtyard-garden';
  const groundMesh = ground.mesh('garden-inlays');
  const foliage = plants.mesh('flower-meadows', paintedMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  const skyline = distant.mesh('courtyard-skyline');
  skyline.receiveShadow = false;
  const doors = gates.mesh('ceremonial-gates');
  doors.receiveShadow = false;
  group.add(groundMesh, foliage, skyline, doors);
  return group;
}
