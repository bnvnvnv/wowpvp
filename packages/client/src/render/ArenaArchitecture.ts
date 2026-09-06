import * as THREE from 'three';
import type { MapDef } from '@wowpvp/shared';
import { ArtGeometry } from './ArtGeometry.js';
import { paintedMaterial } from './toonMaterial.js';

const STONE = { light: 0xdeddd1, edge: 0xabb7b8, base: 0x819599, joint: 0x819195, gold: 0xdfb85e };

function crownShape(): THREE.Shape {
  const shape = new THREE.Shape();
  shape.moveTo(-0.34, 0);
  shape.lineTo(-0.41, 0.39);
  shape.lineTo(-0.18, 0.26);
  shape.lineTo(0, 0.58);
  shape.lineTo(0.18, 0.26);
  shape.lineTo(0.41, 0.39);
  shape.lineTo(0.34, 0);
  shape.closePath();
  return shape;
}

/** Facade details follow collision volumes; silhouette-changing masonry is map geometry. */
export function arenaArchitecture(map: MapDef): THREE.Group {
  const masonry = new ArtGeometry();
  const cloth = new ArtGeometry();
  let bannerCount = 0;
  const banner = (x: number, top: number, z: number, yaw: number, color: number): void => {
    const shape = new THREE.Shape();
    shape.moveTo(-0.64, 0);
    shape.lineTo(0.64, 0);
    shape.quadraticCurveTo(0.68, -1.15, 0.57, -2.05);
    shape.lineTo(0, -2.38);
    shape.lineTo(-0.57, -2.05);
    shape.quadraticCurveTo(-0.70, -1.1, -0.64, 0);
    const fabric = new THREE.ShapeGeometry(shape, 6);
    const positions = fabric.getAttribute('position');
    for (let i = 0; i < positions.count; i++) {
      positions.setZ(i, Math.sin(positions.getX(i) * 5 + positions.getY(i) * 2) * Math.max(0, -positions.getY(i)) * 0.014);
    }
    fabric.computeVertexNormals();
    const flutter = (geometry: THREE.BufferGeometry): void => {
      const p = geometry.getAttribute('position');
      const weights = new Float32Array(p.count);
      for (let i = 0; i < p.count; i++) weights[i] = Math.max(0, top - p.getY(i)) * 0.025;
      geometry.setAttribute('aFlutter', new THREE.BufferAttribute(weights, 1));
    };
    flutter(cloth.add(fabric, color, [x, top, z], [0, yaw, 0]));
    const dx = Math.sin(yaw) * 0.065;
    const dz = Math.cos(yaw) * 0.065;
    flutter(cloth.add(new THREE.ShapeGeometry(crownShape()), 0xffda6e, [x + dx, top - 1.30, z + dz], [0, yaw, 0]));
    flutter(cloth.add(new THREE.PlaneGeometry(0.70, 0.07), 0xf3be4f, [x + dx, top - 1.40, z + dz], [0, yaw, 0]));
    masonry.box([1.55, 0.10, 0.14], STONE.gold, [x, top + 0.04, z], yaw);
    bannerCount++;
  };

  for (const v of map.geometry) {
    const w = v.max.x - v.min.x;
    const h = v.max.y - v.min.y;
    const d = v.max.z - v.min.z;
    const x = (v.min.x + v.max.x) / 2;
    const z = (v.min.z + v.max.z) / 2;
    const top = v.max.y;
    if ((v.tag === 'wall' || v.tag === 'pillar') && h >= 2) {
      masonry.box([w + 0.028, 0.30, d + 0.028], STONE.light, [x, top - 0.15, z]);
      masonry.box([w + 0.032, 0.11, d + 0.032], STONE.gold, [x, top - 0.39, z]);
      masonry.box([w + 0.025, 0.40, d + 0.025], STONE.base, [x, v.min.y + 0.20, z]);
      masonry.box([w + 0.026, 0.08, d + 0.026], STONE.edge, [x, v.min.y + 0.48, z]);

      const alongX = w >= d;
      const length = Math.max(w, d);
      const accent = z >= 0 ? 0xe34562 : 0x218acb;
      for (let y = v.min.y + 1.05, row = 0; y < top - 0.5; y += 1.05, row++) {
        masonry.box([w + 0.008, 0.023, d + 0.008], STONE.joint, [x, y, z]);
        for (let along = -length / 2 + 1 + row % 2; along < length / 2 - 0.1; along += 2.1) {
          for (const side of [-1, 1]) {
            masonry.box(alongX ? [0.023, 0.94, 0.012] : [0.012, 0.94, 0.023], STONE.joint,
              [x + (alongX ? along : side * (w / 2 + 0.003)), y - 0.50,
                z + (alongX ? side * (d / 2 + 0.003) : along)]);
          }
        }
      }
      if (v.tag === 'pillar') {
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
          masonry.box([0.26, h - 0.6, 0.26], STONE.edge,
            [x + sx * (w / 2 - 0.12), v.min.y + h / 2, z + sz * (d / 2 - 0.12)]);
        }
      }
      const count = Math.max(1, Math.floor(length / 8));
      for (let i = 0; i < count; i++) {
        const along = (i + 0.5) * length / count - length / 2;
        if (map.id === 'practice_courtyard' && alongX && Math.abs(z) > 25 && Math.abs(along) < 2) continue;
        for (const side of [-1, 1]) {
          banner(x + (alongX ? along : side * (w / 2 + 0.14)), top - 0.68,
            z + (alongX ? side * (d / 2 + 0.14) : along),
            alongX ? (side > 0 ? 0 : Math.PI) : side * Math.PI / 2, accent);
        }
      }
    }

    if (map.id !== 'practice_courtyard' && v.tag === 'floor' && w >= 30 && d >= 30 && top <= 0.1) {
      const isSnow = map.groundTexture === 'snow';
      const isRock = map.groundTexture === 'rock';
      for (let ix = 0; ix < Math.ceil(w / 4); ix++) for (let iz = 0; iz < Math.ceil(d / 4); iz++) {
        const px = v.min.x + ix * 4;
        const pz = v.min.z + iz * 4;
        if (px > v.min.x + 7 && px < v.max.x - 11 && pz > v.min.z + 7 && pz < v.max.z - 11) continue;
        const tw = Math.min(4, v.max.x - px);
        const td = Math.min(4, v.max.z - pz);
        const tint = isSnow ? 0xd4e9e8 : isRock ? 0x7a847b : (ix + iz) % 2 ? 0x7bb655 : 0x80ba58;
        masonry.add(new THREE.PlaneGeometry(tw, td), tint, [px + tw / 2, top + 0.012, pz + td / 2], [-Math.PI / 2, 0, 0]);
      }
    }
  }

  const group = new THREE.Group();
  group.name = 'arena-architecture';
  const stonework = masonry.mesh('masonry-details');
  stonework.receiveShadow = false;
  group.add(stonework);
  if (bannerCount) {
    const breeze = { value: 0 };
    const material = paintedMaterial({ vertexColors: true, side: THREE.DoubleSide });
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uBreeze = breeze;
      shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
        uniform float uBreeze;
        attribute float aFlutter;`).replace('#include <begin_vertex>', `#include <begin_vertex>
        transformed += normal * aFlutter * sin(uBreeze * 2.2 + position.y * 2.8 + position.x * 0.5);`);
    };
    material.customProgramCacheKey = () => 'courtyard-cloth-v1';
    const flags = cloth.mesh('woven-banners', material);
    flags.onBeforeRender = () => { breeze.value = performance.now() / 1000; };
    flags.receiveShadow = false;
    group.add(flags);
  }
  return group;
}
