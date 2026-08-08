/**
 * 大乱斗派对武装的**表现层门禁**。
 *
 * ★★ 三条断言各盯一种「运行时静默」：
 *   ① 武器没配模型映射 → 手上空空如也（现在有程序化兜底，但兜底是给
 *      「素材目录整个不存在」留的，不是给「忘了配」留的 —— 与 skillIconMap
 *      的全覆盖同一条纪律）。
 *   ② 映射指向盘上不存在的 glb → `template()` 的 catch 直接吞掉，
 *      只在控制台留一行 warn，玩家看到的还是空手。
 *   ③ `renderScale` 写出界 → 「和玩家一样大」变成「塞满全场」或「看不见」，
 *      而 sim 侧完全无感（它压根不读这个字段）。
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ALL_WEAPONS, PARTY_WEAPONS } from '@wowpvp/shared';

import { WEAPON_MODEL } from './ModelLibrary.js';

const MODEL_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../assets/art/models/weapons',
);

describe('★★ 派对武装的模型与缩放', () => {
  it('★★ 全覆盖：每件武器（含派对武装）都有模型映射', () => {
    const missing = [...ALL_WEAPONS, ...PARTY_WEAPONS]
      .filter((w) => !WEAPON_MODEL[w.id as string])
      .map((w) => `${w.id}（${w.name}）`);
    expect(missing, '新武器必须在 ModelLibrary 的 WEAPON_MODEL 里配模型').toEqual([]);
  });

  it('★ 没有多余映射（防改名后留下孤儿行）', () => {
    const known = new Set([...ALL_WEAPONS, ...PARTY_WEAPONS].map((w) => w.id as string));
    expect(Object.keys(WEAPON_MODEL).filter((id) => !known.has(id))).toEqual([]);
  });

  it('★★ 派对武装的 renderScale 明显大于 1，且在 schema 允许的 [0.5, 4] 内', () => {
    for (const w of PARTY_WEAPONS) {
      expect(w.renderScale, `${w.id} 没写 renderScale —— 夸张武器不夸张`).toBeDefined();
      expect(w.renderScale!, `${w.id}`).toBeGreaterThan(1.2);
      expect(w.renderScale!, `${w.id}`).toBeLessThanOrEqual(4);
    }
    // 至少有一件「和玩家一样大」量级的（2.5 上下）
    expect(Math.max(...PARTY_WEAPONS.map((w) => w.renderScale ?? 1))).toBeGreaterThanOrEqual(2.4);
  });

  // 素材目录是可选的（纯代码 clone 没有它）；有才校验断链
  describe.skipIf(!existsSync(MODEL_ROOT))('★ 磁盘校验', () => {
    it('★ 每个映射的 glb 都存在', () => {
      const broken: string[] = [];
      for (const [id, att] of Object.entries(WEAPON_MODEL)) {
        for (const file of [att.right, att.left]) {
          if (file && !existsSync(join(MODEL_ROOT, `${file}.glb`))) broken.push(`${id} → ${file}.glb`);
        }
      }
      expect(broken, '模型映射断链（文件被改名或删除）').toEqual([]);
    });
  });
});
