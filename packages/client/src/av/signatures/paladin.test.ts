/**
 * 圣骑士签名表的看门测试。
 *
 * ★★ 这张表最可能的死法有三种，三种都在这里钉死：
 *   1. **漏配 / 孤儿行** —— shared 加了技能没人配签名，或技能改名后
 *      表里留下一条永远不会被读到的死行。全部对着 shared 数据动态断言，
 *      不硬编码「16 条」这种数字（写死数字的测试在加技能那天只会
 *      多一条要改的行，而不是提醒你去配签名）。
 *   2. **断链** —— 音效键必须是 `assets/music/sfx/` 下去掉 .mp3 的精确基名。
 *      盘上既有 `cast_fire` 这种不带后缀的，也有 `melee_swing_heavy_1`
 *      这种带变体后缀的，凭记忆写必错。逐键 existsSync。
 *   3. **签名撞车** —— 两个技能同声同色 = 这一批的目的没达成。
 *
 * ★ 外加两条分层纪律：大招必须真的换了音效或形态（不然「分量分层」是空话）、
 *   形态不许铺满全职业（form 是重点标记，人人都有等于没有）。
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { paladin } from '@wowpvp/shared';
import {
  RATE_CLAMP,
  SCALE_CLAMP,
  SignatureForm,
  TINT_CLAMP,
  type SkillSignature,
} from '../skillSignature.js';
import { signatures } from './paladin.js';

/** 仓库根的 assets/music/sfx —— 本文件在 packages/client/src/av/signatures/ 下，退五级 */
const SFX_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../../assets/music/sfx',
);

/** 冷却 ≥ 45s 视为「大招 / 王牌」（分层规则，与表头注释同一口径） */
const ULTIMATE_COOLDOWN = 45;

const skillIds = paladin.skills.map((s) => s.id as string);
const ultimates = paladin.skills.filter((s) => s.cooldown >= ULTIMATE_COOLDOWN);

/** 一条签名引用的全部音效键 */
const soundKeysOf = (sig: SkillSignature): string[] =>
  [sig.castSound, sig.impactSound, sig.impactLayer].filter((k): k is string => k !== undefined);

describe('★★ 圣骑士技能签名表', () => {
  it('★★ 全覆盖：每个圣骑士技能都有一条签名', () => {
    const missing = paladin.skills
      .filter((s) => !signatures[s.id as string])
      .map((s) => `${s.id}（${s.name}）`);
    expect(missing, '新技能必须在 signatures/paladin.ts 里配签名').toEqual([]);
  });

  it('★ 没有多余键（防技能改名后留下读不到的孤儿行）', () => {
    const known = new Set(skillIds);
    const orphans = Object.keys(signatures).filter((id) => !known.has(id));
    expect(orphans, '签名表里有不属于圣骑士的技能 id').toEqual([]);
  });

  it('★ 每条至少写了 castRate / impactRate / tintShift 之一（否则等于没签名）', () => {
    const empty = Object.entries(signatures)
      .filter(
        ([, s]) =>
          s.castRate === undefined && s.impactRate === undefined && s.tintShift === undefined,
      )
      .map(([id]) => id);
    expect(empty, '这些签名只换了资产没给音高/色相，个性不足').toEqual([]);
  });

  it('★★ 同职业内两两不完全相同（撞车 = 本批的目的没达成）', () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const [id, sig] of Object.entries(signatures)) {
      // 字段顺序无关的规范化指纹
      const key = JSON.stringify(
        Object.fromEntries(Object.entries(sig).sort(([a], [b]) => a.localeCompare(b))),
      );
      const prev = seen.get(key);
      if (prev) collisions.push(`${prev} 与 ${id} 签名完全相同`);
      else seen.set(key, id);
    }
    expect(collisions).toEqual([]);
  });

  it('⚠️ impactLayer 不得与 impactSound 同名（AudioManager 40ms 同名去重会吃掉叠层）', () => {
    const swallowed = Object.entries(signatures)
      .filter(([, s]) => s.impactLayer !== undefined && s.impactLayer === s.impactSound)
      .map(([id]) => id);
    expect(swallowed).toEqual([]);
  });

  it('★ 所有数值都在钳位区间内（写出界不会崩，只会被悄悄夹回 = 意图丢失）', () => {
    const outOfRange: string[] = [];
    for (const [id, s] of Object.entries(signatures)) {
      for (const [field, v] of [
        ['castRate', s.castRate],
        ['impactRate', s.impactRate],
      ] as const) {
        if (v !== undefined && (v < RATE_CLAMP.min || v > RATE_CLAMP.max))
          outOfRange.push(`${id}.${field}=${v}`);
      }
      if (s.tintShift !== undefined && Math.abs(s.tintShift) > TINT_CLAMP)
        outOfRange.push(`${id}.tintShift=${s.tintShift}`);
      if (s.scale !== undefined && (s.scale < SCALE_CLAMP.min || s.scale > SCALE_CLAMP.max))
        outOfRange.push(`${id}.scale=${s.scale}`);
    }
    expect(outOfRange).toEqual([]);
  });

  describe('★★ 分量分层', () => {
    it('大招（冷却 ≥ 45s）都换了专属音效文件或带二级形态', () => {
      const flat = ultimates
        .filter((s) => {
          const sig = signatures[s.id as string];
          if (!sig) return true;
          const swappedSound = sig.castSound !== undefined || sig.impactSound !== undefined;
          const hasForm = sig.form !== undefined && sig.form !== SignatureForm.None;
          return !swappedSound && !hasForm;
        })
        .map((s) => `${s.id}（${s.name}，${s.cooldown}s）`);
      expect(flat, '大招必须一听/一眼就知道是它').toEqual([]);
    });

    it('大招同时具备形态与放大的规模（本表自定的更严口径，改动前请先改注释）', () => {
      const weak = ultimates
        .filter((s) => {
          const sig = signatures[s.id as string]!;
          const hasForm = sig.form !== undefined && sig.form !== SignatureForm.None;
          return !hasForm || (sig.scale ?? 1) < 1.4;
        })
        .map((s) => `${s.id}（scale=${signatures[s.id as string]?.scale ?? 1}）`);
      expect(weak).toEqual([]);
    });

    it('★ 形态不超过职业技能数的一半（form 是重点标记，人人都有等于没有）', () => {
      const withForm = Object.entries(signatures).filter(
        ([, s]) => s.form !== undefined && s.form !== SignatureForm.None,
      );
      expect(
        withForm.length,
        `${withForm.length} 个形态 / ${skillIds.length} 个技能：形态用得太滥`,
      ).toBeLessThanOrEqual(Math.floor(skillIds.length / 2));
    });
  });

  /**
   * 素材目录是可选的（纯代码 clone 没有 assets/），与 skillIconMap.test.ts 同一惯例。
   * 本机有素材时这一组就是「音频零断链」的硬门禁。
   */
  describe.skipIf(!existsSync(SFX_ROOT))('★★ 磁盘校验', () => {
    it('★★ 每个 castSound / impactSound / impactLayer 都是盘上真实文件', () => {
      const broken: string[] = [];
      for (const [id, sig] of Object.entries(signatures)) {
        for (const key of soundKeysOf(sig)) {
          if (!existsSync(join(SFX_ROOT, `${key}.mp3`))) broken.push(`${id} → ${key}.mp3`);
        }
      }
      expect(broken, '音效键必须是去掉 .mp3 的精确基名（注意 _1 变体后缀）').toEqual([]);
    });

    it('自检：不存在的基名确实会被上面那条抓出来', () => {
      expect(existsSync(join(SFX_ROOT, 'impact_bone.mp3'))).toBe(false); // 盘上只有 impact_bone_1..4
      expect(existsSync(join(SFX_ROOT, 'impact_bone_1.mp3'))).toBe(true);
    });
  });
});
