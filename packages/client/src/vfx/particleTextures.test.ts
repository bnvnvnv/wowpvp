/**
 * 14.2 粒子贴图映射的纯逻辑测试（无需 GL）。
 *
 * 这里守的是一句话：**「素材在手却没用」不能再发生**。
 * 三条约束合起来保证 16 张贴图每一张都被某处引用，且八属性各有一张主粒子、无断链。
 */

import { describe, expect, it } from 'vitest';
import { ATTRIBUTE_VISUALS } from './schools.js';
import {
  ACCENT_TEXTURES,
  PARTICLE_TEXTURE,
  VFX_TEXTURE_FILES,
} from './particleTextures.js';

describe('14.2 粒子贴图映射', () => {
  it('八属性的每个 particle 形状键都有一张主贴图', () => {
    const particleKeys = new Set(
      Object.values(ATTRIBUTE_VISUALS).map((v) => v.particle),
    );
    expect(particleKeys.size).toBe(8);
    for (const key of particleKeys) {
      expect(PARTICLE_TEXTURE[key]).toBeDefined();
    }
    // 反向也钉死：映射表不多不少正好这 8 个键
    expect(new Set(Object.keys(PARTICLE_TEXTURE))).toEqual(particleKeys);
  });

  it('所有映射的文件名都在 16 张已知 vfx 里（无断链、无拼写错）', () => {
    const known = new Set<string>(VFX_TEXTURE_FILES);
    for (const file of Object.values(PARTICLE_TEXTURE)) {
      expect(known.has(file)).toBe(true);
    }
    for (const file of Object.values(ACCENT_TEXTURES)) {
      expect(known.has(file)).toBe(true);
    }
  });

  it('★ 16 张贴图全部被引用 —— 素材在手都用上了', () => {
    const used = new Set<string>([
      ...Object.values(PARTICLE_TEXTURE),
      ...Object.values(ACCENT_TEXTURES),
    ]);
    expect(used.size).toBe(VFX_TEXTURE_FILES.length);
    expect([...used].sort()).toEqual([...VFX_TEXTURE_FILES].sort());
  });

  it('主粒子与点缀不重复用同一张（8 + 8 = 16 张互斥）', () => {
    const primary = new Set<string>(Object.values(PARTICLE_TEXTURE));
    const accent = new Set<string>(Object.values(ACCENT_TEXTURES));
    expect(primary.size).toBe(8);
    expect(accent.size).toBe(8);
    for (const f of accent) expect(primary.has(f)).toBe(false);
  });
});
