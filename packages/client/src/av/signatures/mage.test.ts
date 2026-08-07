/**
 * 法师签名表的门禁。
 *
 * ★★ 这张表最容易的死法有三种，三条断言各钉一种：
 *   1. **加了技能忘了配签名** —— 覆盖率对着 shared 数据动态算，不硬编码数量，
 *      所以 P3b 那种「后来补的填充键」不会静默退回推导默认值。
 *   2. **音效键写错一个字符** —— 素材里有的带 _1 变体后缀（melee_swing_blade_3）、
 *      有的不带（cast_fire），凭记忆写必错。逐键对磁盘验。
 *   3. **两条签名撞车** —— 撞车就等于这两个技能在场上同声同色，
 *      整批工作对这两个键白做。
 *
 * ★ 第四条是分量分层的门禁：大招必须真的换了音效文件或上了形态。
 *   「给大招也写了签名」和「大招听起来像大招」是两件事，只有后者算数。
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALL_CLASSES, School, type SkillDef } from '@wowpvp/shared';
import {
  RATE_CLAMP,
  SCALE_CLAMP,
  SignatureForm,
  TINT_CLAMP,
  type SkillSignature,
} from '../skillSignature.js';
import { signatures } from './mage.js';

/** signatures/ → av → src → client → packages → 仓库根 */
const SFX_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../../assets/music/sfx',
);

const mageSkills: readonly SkillDef[] =
  ALL_CLASSES.find((c) => (c.id as string) === 'mage')?.skills ?? [];

/**
 * ⚠️ AudioManager 的 CAST_SOUND / IMPACT_SOUND 是模块私有常量，这里按学派抄一份。
 *   只用于判断「这条签名有没有真的换掉学派默认音」——
 *   抄错的后果只是门禁变松/变严，不影响运行时；AudioManager 改了默认音记得同步。
 */
const SCHOOL_DEFAULT_CAST: Partial<Record<School, string>> = {
  [School.Arcane]: 'cast_arcane',
  [School.Fire]: 'cast_fire',
  [School.Frost]: 'cast_frost',
};
const SCHOOL_DEFAULT_IMPACT: Partial<Record<School, string>> = {
  [School.Arcane]: 'impact_arcane',
  [School.Fire]: 'impact_fire',
  [School.Frost]: 'impact_frost',
};

/** 大招判定：冷却 ≥ 45 秒（与任务口径一致，身份技另有手工分量，不进门禁） */
const ULTIMATE_CD = 45;

const soundKeysOf = (sig: SkillSignature): string[] =>
  [sig.castSound, sig.impactSound, sig.impactLayer].filter(
    (s): s is string => s !== undefined,
  );

/** 稳定序列化：键排序后比对，字段书写顺序不同不算「不同签名」 */
const stableKey = (sig: SkillSignature): string =>
  JSON.stringify(
    Object.fromEntries(Object.entries(sig).sort(([a], [b]) => a.localeCompare(b))),
  );

describe('★★ 法师技能签名表', () => {
  it('前置：shared 里读得到法师技能（读不到则后面所有断言都是空转）', () => {
    expect(mageSkills.length).toBeGreaterThan(0);
  });

  it('★★ 覆盖率 100%：每个法师技能都有一条签名', () => {
    const missing = mageSkills
      .filter((s) => !signatures[s.id as string])
      .map((s) => `${s.id as string}（${s.name}）`);
    expect(missing, '新技能必须在 signatures/mage.ts 里配签名').toEqual([]);
  });

  it('★ 没有多余键（防技能改名后留下孤儿行）', () => {
    const known = new Set(mageSkills.map((s) => s.id as string));
    const orphans = Object.keys(signatures).filter((id) => !known.has(id));
    expect(orphans, '签名表里有不存在的法师技能 id').toEqual([]);
  });

  it('★ 每条至少写了 castRate / impactRate / tintShift 之一（空壳签名 = 没签名）', () => {
    const empty = Object.entries(signatures)
      .filter(
        ([, sig]) =>
          sig.castRate === undefined &&
          sig.impactRate === undefined &&
          sig.tintShift === undefined,
      )
      .map(([id]) => id);
    expect(empty).toEqual([]);
  });

  it('★★ 同职业内两两不同（撞车 = 这两个技能在场上同声同色）', () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const [id, sig] of Object.entries(signatures)) {
      const key = stableKey(sig);
      const prev = seen.get(key);
      if (prev) collisions.push(`${prev} 与 ${id} 签名完全相同`);
      else seen.set(key, id);
    }
    expect(collisions).toEqual([]);
  });

  it('★ 数值都在地基钳位范围内（写出界不会崩，但会被静默夹掉 —— 那等于签名没生效）', () => {
    const outOfRange: string[] = [];
    for (const [id, sig] of Object.entries(signatures)) {
      for (const [field, v] of [
        ['castRate', sig.castRate],
        ['impactRate', sig.impactRate],
      ] as const) {
        if (v !== undefined && (v < RATE_CLAMP.min || v > RATE_CLAMP.max)) {
          outOfRange.push(`${id}.${field}=${v}`);
        }
      }
      if (sig.tintShift !== undefined && Math.abs(sig.tintShift) > TINT_CLAMP) {
        outOfRange.push(`${id}.tintShift=${sig.tintShift}`);
      }
      if (
        sig.scale !== undefined &&
        (sig.scale < SCALE_CLAMP.min || sig.scale > SCALE_CLAMP.max)
      ) {
        outOfRange.push(`${id}.scale=${sig.scale}`);
      }
    }
    expect(outOfRange).toEqual([]);
  });

  it('★ 叠层与命中音不同名（AudioManager 的 40ms 同名去重会吃掉同名层）', () => {
    const bad: string[] = [];
    for (const skill of mageSkills) {
      const sig = signatures[skill.id as string];
      if (!sig?.impactLayer) continue;
      const impact = sig.impactSound ?? SCHOOL_DEFAULT_IMPACT[skill.school];
      if (sig.impactLayer === impact) {
        bad.push(`${skill.id as string} 的叠层与命中音同为 ${sig.impactLayer}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('★ 二级形态不超过职业技能数的一半（人人都有等于没有）', () => {
    const withForm = Object.values(signatures).filter(
      (s) => s.form !== undefined && s.form !== SignatureForm.None,
    ).length;
    expect(withForm).toBeLessThanOrEqual(Math.floor(mageSkills.length / 2));
  });

  it('★★ 大招（冷却 ≥ 45 秒）都换了专属音效文件或带二级形态', () => {
    const ults = mageSkills.filter((s) => s.cooldown >= ULTIMATE_CD);
    expect(ults.length, '法师应当有冷却 ≥ 45 秒的技能').toBeGreaterThan(0);

    const weak = ults
      .filter((s) => {
        const sig = signatures[s.id as string];
        if (!sig) return true;
        const swappedCast =
          sig.castSound !== undefined && sig.castSound !== SCHOOL_DEFAULT_CAST[s.school];
        const swappedImpact =
          sig.impactSound !== undefined &&
          sig.impactSound !== SCHOOL_DEFAULT_IMPACT[s.school];
        const hasForm = sig.form !== undefined && sig.form !== SignatureForm.None;
        return !(swappedCast || swappedImpact || hasForm);
      })
      .map((s) => `${s.id as string}（${s.name}，${s.cooldown}s）`);
    expect(weak, '大招必须听/看得出来是大招').toEqual([]);
  });

  // 素材目录是可选的（纯代码 clone 没有它）；有才校验断链，与 skillIconMap.test 同纪律
  describe.skipIf(!existsSync(SFX_ROOT))('★★ 音效键磁盘校验', () => {
    it('★★ 每个 castSound / impactSound / impactLayer 都在 assets/music/sfx 里', () => {
      const broken: string[] = [];
      for (const [id, sig] of Object.entries(signatures)) {
        for (const key of soundKeysOf(sig)) {
          if (!existsSync(join(SFX_ROOT, `${key}.mp3`))) broken.push(`${id} → ${key}.mp3`);
        }
      }
      expect(broken, '引用了不存在的音效文件（变体后缀最常写错）').toEqual([]);
    });

    it('自检：门禁本身有效（故意写错的基名必须被抓出来）', () => {
      expect(existsSync(join(SFX_ROOT, 'cast_fire.mp3'))).toBe(true);
      expect(existsSync(join(SFX_ROOT, 'cast_fire_1.mp3'))).toBe(false);
    });
  });
});
