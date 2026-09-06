import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelLibrary } from './ModelLibrary.js';

afterEach(() => { ModelLibrary.reset(); vi.restoreAllMocks(); });

describe('character weapon sockets', () => {
  it('finds both hands after the real glTF parser sanitizes the authored node names', async () => {
    const gltf = await new GLTFLoader().parseAsync(JSON.stringify({
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'body', children: [1, 2] }, { name: 'handslot.r' }, { name: 'handslot.l' }],
    }), '');
    gltf.scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshStandardMaterial()));
    vi.spyOn(KTX2Loader.prototype, 'detectSupport').mockReturnThis();
    vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockResolvedValue(gltf);
    const library = ModelLibrary.init({} as THREE.WebGLRenderer);
    const model = await library.characterFor('warrior');
    expect(model?.handR).toBeDefined();
    expect(model?.handL).toBeDefined();
    expect(model?.handR).not.toBe(model?.handL);
    const sword = new THREE.Group();
    const shield = new THREE.Group();
    model!.handR!.add(sword);
    model!.handL!.add(shield);
    expect(model!.root.getObjectById(sword.id)).toBe(sword);
    expect(model!.root.getObjectById(shield.id)).toBe(shield);
  });
});
