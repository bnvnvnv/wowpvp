import * as THREE from 'three';

const ramp = new THREE.DataTexture(new Uint8Array([122, 170, 215, 255]), 4, 1, THREE.RedFormat);
ramp.minFilter = ramp.magFilter = THREE.NearestFilter;
ramp.generateMipmaps = false;
ramp.needsUpdate = true;

export function paintedMaterial(parameters: THREE.MeshToonMaterialParameters = {}): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({ gradientMap: ramp, ...parameters });
}

/** Keep the authored colors, transparency and emissive feedback on a shared toon ramp. */
export function stylizeMaterial(source: THREE.Material): THREE.Material {
  if (!(source as THREE.MeshStandardMaterial).isMeshStandardMaterial) return source;
  const original = source as THREE.MeshStandardMaterial;
  const result = paintedMaterial({
    name: original.name,
    color: original.color,
    map: original.map,
    vertexColors: original.vertexColors,
    emissive: original.emissive,
    emissiveMap: original.emissiveMap,
    emissiveIntensity: original.emissiveIntensity,
    transparent: original.transparent,
    opacity: original.opacity,
    alphaTest: original.alphaTest,
    alphaMap: original.alphaMap,
    side: original.side,
    depthWrite: original.depthWrite,
  });
  return result;
}
