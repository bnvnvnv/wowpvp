import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const out = resolve('scripts/.diag/blender-navigation-20260905/references');
await mkdir(out, { recursive: true });
for (const name of ['adv_sword_1handed', 'shield_round']) {
  const document = await io.read(resolve(`assets/art/models/weapons/${name}.glb`));
  // Geometry-only references preserve attachment coordinates; shipped compressed assets stay untouched.
  for (const texture of document.getRoot().listTextures()) texture.dispose();
  for (const extension of document.getRoot().listExtensionsUsed()) {
    if (['KHR_texture_basisu', 'EXT_meshopt_compression'].includes(extension.extensionName)) extension.dispose();
  }
  await io.write(resolve(out, `${name}.glb`), document);
  console.log(`Prepared ${name}`);
}
