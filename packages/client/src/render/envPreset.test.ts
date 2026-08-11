/**
 * W15：每张图的 `envPreset` 必须指向**真实存在**的环境预设。
 * ★ `MapDef.envPreset` 是自由字符串（shared 不认识客户端的预设表），
 *   拼错的下场是 `presetOf` 静默回落 day —— 图配了昼夜却永远白天，
 *   没有任何报错。这条测试把「拼错」变成红灯。
 */

import { describe, expect, it } from 'vitest';

import { ALL_MAPS } from '@wowpvp/shared';

import { ENV_PRESETS, GROUND_TEXTURES, groundOf, presetOf } from './Environment.js';

describe('W15 envPreset 有效性', () => {
  it('★ 每张图的 envPreset 都是 ENV_PRESETS 的真实键（防拼错回落）', () => {
    for (const m of ALL_MAPS) {
      expect(
        m.envPreset !== undefined && m.envPreset in ENV_PRESETS,
        `${m.id as string} 的 envPreset「${String(m.envPreset)}」不在 ENV_PRESETS 里`,
      ).toBe(true);
      // presetOf 不该走回落分支
      expect(presetOf(m.envPreset)).toBe(m.envPreset);
    }
  });

  it('不认识的值回落 day（数据不害渲染）', () => {
    expect(presetOf('no_such_preset')).toBe('day');
    expect(presetOf(undefined)).toBe('day');
  });
});

/**
 * P5：`MapDef.groundTexture` 与 `envPreset` 同款自由字符串，同款静默回落。
 * ★ 区别是**默认值不同**：没配的图回落 `stone` —— 那正是本字段出现之前
 *   两个场景里硬写的那一行，所以老图逐帧不变。
 */
describe('P5 groundTexture 有效性', () => {
  it('★ 配了 groundTexture 的图，值都是 GROUND_TEXTURES 的真实键', () => {
    for (const m of ALL_MAPS) {
      if (m.groundTexture === undefined) continue;
      expect(
        m.groundTexture in GROUND_TEXTURES,
        `${m.id as string} 的 groundTexture「${m.groundTexture}」不在 GROUND_TEXTURES 里`,
      ).toBe(true);
      expect(groundOf(m.groundTexture)).toBe(m.groundTexture);
    }
  });

  it('没配 / 不认识的值回落 stone（= 本字段出现之前的行为）', () => {
    expect(groundOf(undefined)).toBe('stone');
    expect(groundOf('no_such_ground')).toBe('stone');
  });
});
