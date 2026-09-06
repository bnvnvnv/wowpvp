import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { paintedMaterial, stylizeMaterial } from './toonMaterial.js';

describe('painted model materials', () => {
  it('preserves authored textures, color and transparency', () => {
    const texture = new THREE.Texture();
    const source = new THREE.MeshStandardMaterial({
      color: 0x8dc3ee, map: texture, vertexColors: true, transparent: true,
      opacity: 0.65, alphaTest: 0.25, side: THREE.DoubleSide,
      emissive: 0x332211, emissiveIntensity: 0.4,
    });
    const result = stylizeMaterial(source) as THREE.MeshToonMaterial;
    expect(result.isMeshToonMaterial).toBe(true);
    expect(result.map).toBe(texture);
    expect(result.color.equals(source.color)).toBe(true);
    expect(result.emissive.equals(source.emissive)).toBe(true);
    expect(result.emissiveIntensity).toBe(0.4);
    expect(result.vertexColors).toBe(true);
    expect(result.opacity).toBe(0.65);
    expect(result.alphaTest).toBe(0.25);
    expect(result.side).toBe(THREE.DoubleSide);
  });

  it('shares the lighting ramp while keeping hit flashes independent', () => {
    const template = paintedMaterial();
    const first = template.clone();
    const second = template.clone();
    first.emissive.setHex(0xff8844);
    expect(second.emissive.getHex()).toBe(0);
    expect(first.gradientMap).toBe(second.gradientMap);
  });

  it('leaves unlit materials unchanged', () => {
    const source = new THREE.MeshBasicMaterial({ color: 0xeeeeff });
    expect(stylizeMaterial(source)).toBe(source);
  });
});
