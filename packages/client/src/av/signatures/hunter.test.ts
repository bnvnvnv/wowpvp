/**
 * 猎人签名表的门禁。
 *
 * ★★ 四条硬保证（顺序即重要性）：
 *   1. **全覆盖 + 无孤儿** —— 对着 shared 的 `hunter.skills` 动态断言，
 *      不硬编码数量：加技能忘了配签名 = 红灯，删技能留下的孤儿行也 = 红灯。
 *   2. **音效不断链** —— 每个 castSound / impactSound / impactLayer 都逐键
 *      对 `assets/music/sfx/<基名>.mp3` 校验。手写表最常见的死法是把
 *      `melee_swing_heavy_1` 写成 `melee_swing_heavy`（盘上只有带后缀的变体），
 *      运行时表现为「这个技能悄悄没声音」—— 必须在这里就红。
 *   3. **同职业内两两不同** —— 签名的存在意义就是可辨识；两条完全相同的签名
 *      等于没写。
 *   4. **大招有分量** —— 冷却 ≥ 45s 的技能必须换过专属音效文件或带 form。
 *
 * ⚠️ 素材目录是可选的（纯代码 clone 没有 assets/）—— 断链校验自动跳过，
 *   与 `hud/skillIconMap.test.ts` 的做法一致。
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hunter } from '@wowpvp/shared';
import {
  RATE_CLAMP,
  SCALE_CLAMP,
  SignatureForm,
  TINT_CLAMP,
  type SkillSignature,
} from '../skillSignature.js';
import { signatures } from './hunter.js';

/** 本文件在 packages/client/src/av/signatures/ → 回四级到仓库根 */
const SFX_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../../assets/music/sfx',
);

/** 大招门槛：冷却 ≥ 45 秒（与任务口径一致） */
const ULTIMATE_COOLDOWN = 45;

const skillIds = hunter.skills.map((s) => s.id as string);

/** 一条签名的全部音效键（用于断链校验与「层不能与命中同名」校验） */
const soundKeysOf = (sig: SkillSignature): string[] =>
  [sig.castSound, sig.impactSound, sig.impactLayer].filter(
    (k): k is string => typeof k === 'string',
  );

describe('★★ 猎人技能签名表', () => {
  it('★★ 全覆盖：每个猎人技能都有一条签名', () => {
    const missing = hunter.skills
      .filter((s) => !signatures[s.id as string])
      .map((s) => `${s.id}（${s.name}）`);
    expect(missing, '新技能必须在 signatures/hunter.ts 里配签名').toEqual([]);
  });

  it('★ 没有多余键（防技能改名/删除后留下孤儿行）', () => {
    const known = new Set(skillIds);
    const orphans = Object.keys(signatures).filter((id) => !known.has(id));
    expect(orphans, '签名表里有不属于猎人的技能 id').toEqual([]);
  });

  it('★ 每条签名至少写了 castRate / impactRate / tintShift 之一', () => {
    const empty = Object.entries(signatures)
      .filter(
        ([, sig]) =>
          sig.castRate === undefined &&
          sig.impactRate === undefined &&
          sig.tintShift === undefined,
      )
      .map(([id]) => id);
    expect(empty, '签名没有任何音高/色相个性，等于没写').toEqual([]);
  });

  it('★★ 同职业内任意两条签名不完全相同', () => {
    // 字段顺序无关：按 key 排序后序列化，避免「同内容不同书写顺序」被误判为不同
    const canon = (sig: SkillSignature): string =>
      JSON.stringify(
        Object.fromEntries(Object.entries(sig).sort(([a], [b]) => a.localeCompare(b))),
      );
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const [id, sig] of Object.entries(signatures)) {
      const key = canon(sig);
      const prev = seen.get(key);
      if (prev) collisions.push(`${prev} 与 ${id} 签名完全相同`);
      else seen.set(key, id);
    }
    expect(collisions, '同职业内出现完全相同的签名').toEqual([]);
  });

  it('★★ 大招（冷却 ≥ 45s）都换了专属音效文件或带 form', () => {
    const ults = hunter.skills.filter((s) => s.cooldown >= ULTIMATE_COOLDOWN);
    // 动态断言：猎人此刻确实有大招，否则这条测试是空跑
    expect(ults.length, '猎人应当至少有一个冷却 ≥ 45s 的技能').toBeGreaterThan(0);

    const weak = ults
      .filter((s) => {
        const sig = signatures[s.id as string];
        if (!sig) return true;
        const hasOwnSound =
          sig.castSound !== undefined || sig.impactSound !== undefined;
        const hasForm = sig.form !== undefined && sig.form !== SignatureForm.None;
        return !hasOwnSound && !hasForm;
      })
      .map((s) => `${s.id}（${s.name}，${s.cooldown}s）`);
    expect(weak, '大招必须一听就知道是它：换音效文件或给二级形态').toEqual([]);
  });

  it('⚠️ impactLayer 不与同条 impactSound 同名（40ms 同名去重会吃掉叠层）', () => {
    const bad = Object.entries(signatures)
      .filter(([, sig]) => sig.impactLayer !== undefined && sig.impactLayer === sig.impactSound)
      .map(([id, sig]) => `${id} → ${sig.impactLayer}`);
    expect(bad, '叠加层与基础层重名，播放时会被静默吃掉').toEqual([]);
  });

  it('★ form 不超过职业技能数的一半（form 是重点标记，人人都有等于没有）', () => {
    const withForm = Object.values(signatures).filter(
      (sig) => sig.form !== undefined && sig.form !== SignatureForm.None,
    ).length;
    expect(withForm).toBeLessThanOrEqual(Math.floor(skillIds.length / 2));
  });

  it('★ 数值都在地基钳位范围内（写出界虽然会被夹回，但那是意图丢失）', () => {
    const out: string[] = [];
    for (const [id, sig] of Object.entries(signatures)) {
      for (const [field, v] of [
        ['castRate', sig.castRate],
        ['impactRate', sig.impactRate],
      ] as const) {
        if (v !== undefined && (v < RATE_CLAMP.min || v > RATE_CLAMP.max)) {
          out.push(`${id}.${field}=${v}`);
        }
      }
      if (sig.tintShift !== undefined && Math.abs(sig.tintShift) > TINT_CLAMP) {
        out.push(`${id}.tintShift=${sig.tintShift}`);
      }
      if (
        sig.scale !== undefined &&
        (sig.scale < SCALE_CLAMP.min || sig.scale > SCALE_CLAMP.max)
      ) {
        out.push(`${id}.scale=${sig.scale}`);
      }
    }
    expect(out, '数值越界（会被 resolveSignature 夹回，写的人以为生效了）').toEqual([]);
  });

  // 素材目录是可选的（纯代码 clone 没有它）；有才校验断链
  describe.skipIf(!existsSync(SFX_ROOT))('★★ 音效磁盘校验', () => {
    it('★★ 每个音效键都存在于 assets/music/sfx', () => {
      const broken: string[] = [];
      for (const [id, sig] of Object.entries(signatures)) {
        for (const key of soundKeysOf(sig)) {
          if (!existsSync(join(SFX_ROOT, `${key}.mp3`))) broken.push(`${id} → ${key}.mp3`);
        }
      }
      expect(broken, '引用了盘上不存在的音效（注意 _1 变体后缀）').toEqual([]);
    });

    it('自检：断链校验确实能抓到不存在的键', () => {
      // 防止上一条因为路径写错而空跑成「永远绿」
      expect(existsSync(join(SFX_ROOT, 'melee_bow_1.mp3'))).toBe(true);
      expect(existsSync(join(SFX_ROOT, 'melee_swing_heavy.mp3'))).toBe(false);
    });
  });
});
