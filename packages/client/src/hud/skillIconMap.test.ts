/**
 * M12：技能图标映射表。
 *
 * ★★ 三条保证，对应 skillIconMap.ts 文件头的三句话：
 *   1. **全覆盖** —— 90 个技能每个都有一行。加技能不配图标 = 红灯，
 *      而不是运行时静默回落 SVG（回落是给「素材目录整个不存在」留的，
 *      不是给「忘了配」留的）。
 *   2. **同职业内两两不同** —— 与程序化图标 `accentOf` 同一条纪律。
 *   3. **文件真的存在** —— 手写表最常见的死法是改名/搬目录之后悄悄断链。
 *      直接对着磁盘校验；素材目录不存在的环境（纯代码 clone）自动跳过。
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALL_CLASSES, ALL_SKILLS, PARTY_SKILLS } from '@wowpvp/shared';
import { SKILL_ICON_FILES, skillIconUrl } from './skillIconMap.js';

/**
 * ★ 全覆盖的口径是「**技能栏上会出现的每一个技能**」，不是「ALL_SKILLS」——
 *   大乱斗的派对武装会往技能栏塞 `ffa.*`（它们刻意不在 `ALL_SKILLS` 里，
 *   见 shared/data/index.ts 的注释）。漏配它们的表现与漏配职业技能完全一样：
 *   HUD 上一个程序化 SVG，玩家看不出手里的大锤给了什么。
 */
const EQUIPPABLE_SKILLS = [...ALL_SKILLS, ...PARTY_SKILLS];

const ICON_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../assets/art/ui/skills',
);

describe('★★ 技能图标映射表', () => {
  it('★★ 全覆盖：每个技能都有映射（含大乱斗派对武装授予的）', () => {
    const missing = EQUIPPABLE_SKILLS.filter((s) => !SKILL_ICON_FILES[s.id as string]);
    expect(
      missing.map((s) => `${s.id}（${s.name}）`),
      '新技能必须在 skillIconMap.ts 里配图标',
    ).toEqual([]);
  });

  it('★ 没有多余映射（防改名后留下孤儿行）', () => {
    const known = new Set(EQUIPPABLE_SKILLS.map((s) => s.id as string));
    const orphans = Object.keys(SKILL_ICON_FILES).filter((id) => !known.has(id));
    expect(orphans, '映射表里有不存在的技能 id').toEqual([]);
  });

  it('★★ 同职业内两两不同（技能栏一次只显示一个职业）', () => {
    const collisions: string[] = [];
    // ★ 派对武装自成一组：它们只在同一根技能栏上与彼此并列出现
    const groups: { id: string; skills: readonly { id: unknown; name: string }[] }[] = [
      ...ALL_CLASSES.map((c) => ({ id: c.id as string, skills: c.skills })),
      { id: 'ffa', skills: PARTY_SKILLS },
    ];
    for (const grp of groups) {
      const seen = new Map<string, string>();
      for (const sk of grp.skills) {
        const file = SKILL_ICON_FILES[sk.id as string]!;
        const prev = seen.get(file);
        if (prev) collisions.push(`${grp.id}: ${prev} 与 ${sk.name} 共用 ${file}`);
        else seen.set(file, sk.name);
      }
    }
    expect(collisions, '同职业内出现共用图标').toEqual([]);
  });

  it('URL 形态：/art/ui/skills/<class>/<name>.webp', () => {
    expect(skillIconUrl('mage.frostbolt')).toBe('/art/ui/skills/mage/frostbolt.webp');
    expect(skillIconUrl('no.such_skill')).toBeUndefined();
  });

  // 素材目录是可选的（纯代码 clone 没有它）；有才校验断链
  describe.skipIf(!existsSync(ICON_ROOT))('★ 磁盘校验', () => {
    it('★ 每个映射的文件都存在', () => {
      const broken = Object.entries(SKILL_ICON_FILES)
        .filter(([, file]) => !existsSync(join(ICON_ROOT, `${file}.webp`)))
        .map(([id, file]) => `${id} → ${file}.webp`);
      expect(broken, '映射断链（文件被改名或删除）').toEqual([]);
    });
  });
});
