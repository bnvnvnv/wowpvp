/**
 * 死亡骑士签名表的门禁。
 *
 * ★★ 四条硬保证（对应 deathknight.ts 文件头的三层分量）：
 *   1. **全覆盖 + 无孤儿** —— 对着 shared 的职业数据动态比对，
 *      不硬编码技能数量：加技能忘配签名要红，删技能留下孤儿行也要红。
 *   2. **零断链** —— 每个 castSound / impactSound / impactLayer 逐键对
 *      `assets/music/sfx/` 校验。手写音效表最常见的死法就是把
 *      `impact_bone` 写成没有编号的样子（盘上只有 `impact_bone_1..4`），
 *      运行时静默不响、没人发现。这里直接 fs 抓。
 *   3. **同职业内两两不同** —— 签名的全部意义就是「可辨识」，
 *      两条一模一样等于这批白做。
 *   4. **大招有分量** —— 冷却 ≥ 45s 的技能必须换过专属音效文件或带二级形态，
 *      不许只靠微调音高冒充大招。
 *
 * ★ 另外钉死几条「写的时候容易犯」的错：越界被静默钳位、
 *   impactLayer 与 impactSound 同名（被 AudioManager 的 40ms 去重吃掉）、
 *   form 泛滥（人人都有等于没有）。
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { deathknight } from '@wowpvp/shared';
import {
  RATE_CLAMP,
  SCALE_CLAMP,
  SignatureForm,
  TINT_CLAMP,
  type SkillSignature,
} from '../skillSignature.js';
import { signatures } from './deathknight.js';

/** signatures/ → av → src → client → packages → 仓库根 */
const SFX_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../../assets/music/sfx',
);

const SKILLS = deathknight.skills;
const entries = Object.entries(signatures);

/** 一条签名引用到的全部盘上音效键 */
const soundKeysOf = (sig: SkillSignature): string[] =>
  [sig.castSound, sig.impactSound, sig.impactLayer].filter((s): s is string => s !== undefined);

describe('★★ 死亡骑士技能签名表', () => {
  it('★★ 全覆盖：本职业每个技能都有一条签名', () => {
    const missing = SKILLS.filter((s) => !signatures[s.id as string]).map(
      (s) => `${s.id}（${s.name}）`,
    );
    expect(missing, '新技能必须在 signatures/deathknight.ts 里配签名').toEqual([]);
  });

  it('★★ 没有多余键（防改名 / 删技能后留下孤儿行）', () => {
    const known = new Set(SKILLS.map((s) => s.id as string));
    const orphans = Object.keys(signatures).filter((id) => !known.has(id));
    expect(orphans, '签名表里有本职业不存在的技能 id').toEqual([]);
  });

  it('★ 每条签名至少写了 castRate / impactRate / tintShift 之一', () => {
    const empty = entries
      .filter(([, s]) => s.castRate === undefined && s.impactRate === undefined && s.tintShift === undefined)
      .map(([id]) => id);
    expect(empty, '空签名等于没写 —— 至少给一个音高或色相偏移').toEqual([]);
  });

  it('★★ 同职业内任意两条签名不完全相同', () => {
    // 键序无关的规范化：字段名排序后序列化
    const fingerprint = (s: SkillSignature): string =>
      JSON.stringify(
        Object.fromEntries(Object.entries(s).sort(([a], [b]) => a.localeCompare(b))),
      );
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const [id, sig] of entries) {
      const fp = fingerprint(sig);
      const prev = seen.get(fp);
      if (prev) collisions.push(`${prev} 与 ${id} 签名完全相同`);
      else seen.set(fp, id);
    }
    expect(collisions, '两条一样的签名 = 玩家听不出区别').toEqual([]);
  });

  it('★★ 大招（冷却 ≥ 45s）换过专属音效文件或带二级形态', () => {
    const ultimates = SKILLS.filter((s) => s.cooldown >= 45);
    // 前提自检：本职业确实有大招，否则这条断言是空转
    expect(ultimates.length, '死骑应当有冷却 ≥ 45s 的大招').toBeGreaterThan(0);

    const weak = ultimates
      .filter((s) => {
        const sig = signatures[s.id as string];
        if (!sig) return true;
        const hasOwnSound = sig.castSound !== undefined || sig.impactSound !== undefined;
        const hasForm = sig.form !== undefined && sig.form !== SignatureForm.None;
        return !hasOwnSound && !hasForm;
      })
      .map((s) => `${s.id}（${s.name}，cd ${s.cooldown}s）`);
    expect(weak, '大招只微调音高冒充不了大招：换音效文件或上 form').toEqual([]);
  });

  it('★ impactLayer 不与 impactSound 同名（会被 40ms 同名去重吃掉）', () => {
    const dup = entries
      .filter(([, s]) => s.impactLayer !== undefined && s.impactLayer === s.impactSound)
      .map(([id]) => id);
    expect(dup, '叠层与命中音同名 = 第二层根本不会响').toEqual([]);
  });

  it('★ 数值都在钳位范围内（写出界不会崩，只会被静默夹回 —— 那更糟）', () => {
    const outOfRange: string[] = [];
    for (const [id, s] of entries) {
      for (const [field, v] of [['castRate', s.castRate], ['impactRate', s.impactRate]] as const) {
        if (v !== undefined && (v < RATE_CLAMP.min || v > RATE_CLAMP.max))
          outOfRange.push(`${id}.${field} = ${v}`);
      }
      if (s.tintShift !== undefined && Math.abs(s.tintShift) > TINT_CLAMP)
        outOfRange.push(`${id}.tintShift = ${s.tintShift}`);
      if (s.scale !== undefined && (s.scale < SCALE_CLAMP.min || s.scale > SCALE_CLAMP.max))
        outOfRange.push(`${id}.scale = ${s.scale}`);
    }
    expect(outOfRange, '越界值会被 resolveSignature 夹回，写的人却以为生效了').toEqual([]);
  });

  it('★ form 不超过职业技能数的一半（重点标记，人人都有等于没有）', () => {
    const withForm = entries.filter(
      ([, s]) => s.form !== undefined && s.form !== SignatureForm.None,
    );
    expect(withForm.length).toBeLessThanOrEqual(Math.floor(SKILLS.length / 2));
  });

  // 素材目录是可选的（纯代码 clone 没有它）；有才校验断链，与 skillIconMap.test 同一条纪律
  describe.skipIf(!existsSync(SFX_ROOT))('★★ 磁盘校验', () => {
    it('★★ 每个音效键都是 assets/music/sfx 里真实存在的基名', () => {
      const broken: string[] = [];
      for (const [id, sig] of entries) {
        for (const key of soundKeysOf(sig)) {
          if (!existsSync(join(SFX_ROOT, `${key}.mp3`))) broken.push(`${id} → ${key}.mp3`);
        }
      }
      expect(broken, '断链：文件不存在（注意变体后缀，如 impact_bone_1 而非 impact_bone）').toEqual([]);
    });

    it('自检：校验本身有效（一个明知不存在的键必须被抓出来）', () => {
      expect(existsSync(join(SFX_ROOT, 'impact_bone.mp3'))).toBe(false);
      expect(existsSync(join(SFX_ROOT, 'impact_bone_1.mp3'))).toBe(true);
    });
  });
});
