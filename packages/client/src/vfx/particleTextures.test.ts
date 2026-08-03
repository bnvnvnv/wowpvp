/**
 * 14.2 粒子贴图映射的纯逻辑测试（无需 GL）。
 *
 * 这里守的是一句话：**「素材在手却没用」不能再发生**。
 * 几条约束合起来保证每一张贴图都被某处引用，且八属性各有一张主粒子、无断链。
 *
 * ★★ 数量不写死。三期把 16 张扩到 22 张时发现，原来的
 *   `expect(accent.size).toBe(8)` 钉的是一个**巧合**而不是不变量 ——
 *   点缀贴图恰好也是 8 张，只因为当时「其余 8 张」正好被用光。
 *   真正的不变量是「主粒子恰好一属性一张」「两表互斥」「无孤儿无断链」，
 *   这几条与张数无关，扩包时不该被迫改断言。
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

  it('所有映射的文件名都在已登记的 vfx 里（无断链、无拼写错）', () => {
    const known = new Set<string>(VFX_TEXTURE_FILES);
    for (const file of Object.values(PARTICLE_TEXTURE)) {
      expect(known.has(file)).toBe(true);
    }
    for (const file of Object.values(ACCENT_TEXTURES)) {
      expect(known.has(file)).toBe(true);
    }
  });

  it('★ 登记的贴图全部被引用 —— 素材在手都用上了（无孤儿）', () => {
    const used = new Set<string>([
      ...Object.values(PARTICLE_TEXTURE),
      ...Object.values(ACCENT_TEXTURES),
    ]);
    expect(used.size).toBe(VFX_TEXTURE_FILES.length);
    expect([...used].sort()).toEqual([...VFX_TEXTURE_FILES].sort());
  });

  it('★ 主粒子与点缀互斥：一张贴图不能既当属性主粒子又当点缀', () => {
    const primary = new Set<string>(Object.values(PARTICLE_TEXTURE));
    const accent = new Set<string>(Object.values(ACCENT_TEXTURES));
    // 主粒子恒为 8 张（一属性一张，这是真不变量）
    expect(primary.size).toBe(8);
    // 点缀张数不钉死 —— 扩包时它就该增长，见文件头
    expect(accent.size).toBeGreaterThanOrEqual(8);
    for (const f of accent) expect(primary.has(f)).toBe(false);
  });

  it('★ 登记表本身无重复项（复制粘贴加贴图时最容易犯的错）', () => {
    expect(new Set(VFX_TEXTURE_FILES).size).toBe(VFX_TEXTURE_FILES.length);
  });
});
