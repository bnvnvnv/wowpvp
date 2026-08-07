/**
 * 德鲁伊签名表的门禁。
 *
 * ★★ 这张表是**手写**的，手写表的三种死法这里全钉住：
 *   1. 加了技能忘了配签名 / 改了 id 留下孤儿行 —— 对着 shared 数据动态比对，
 *      不硬编码数量（写死 14 的那一刻，第 15 个技能就永远不会红）。
 *   2. 音效键拼错或素材被改名 —— 逐键对 `assets/music/sfx` 磁盘校验。
 *      带变体后缀的（mob_beast_attack_3）和不带的（spell_nova）混在一起，
 *      光靠眼睛看必然出错，只能让机器查。
 *   3. 两条签名写成一模一样 —— 那等于这一批白做（P3 的出发点就是
 *      「117 个技能共用 7 组学派音」）。
 *
 * ★ 外加两条**分层纪律**（这批的手感目标，不是可选项）：
 *   · 大招（冷却 ≥ 45s）必须换专属音效文件或带二级形态；
 *   · form 是重点标记 —— 覆盖不许超过本职业技能数的一半，人人有等于没有。
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { druid } from '@wowpvp/shared';
import {
  RATE_CLAMP,
  SCALE_CLAMP,
  SignatureForm,
  TINT_CLAMP,
  type SkillSignature,
} from '../skillSignature.js';
import { signatures } from './druid.js';

/** packages/client/src/av/signatures → 仓库根，再进素材目录 */
const SFX_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../../assets/music/sfx',
);

const SKILL_IDS = druid.skills.map((s) => s.id as string);
const NAME_OF = new Map(druid.skills.map((s) => [s.id as string, s.name]));

/** 一条签名引用到的全部音效基名（缺省字段跳过） */
const soundKeysOf = (sig: SkillSignature): string[] =>
  [sig.castSound, sig.impactSound, sig.impactLayer].filter(
    (k): k is string => typeof k === 'string',
  );

const ALL_SOUND_REFS: [string, string][] = Object.entries(signatures).flatMap(
  ([id, sig]) => soundKeysOf(sig).map((k) => [id, k] as [string, string]),
);

describe('★★ 德鲁伊技能签名表', () => {
  // ── ① 覆盖率 ────────────────────────────────────────────────
  it('★★ 100% 覆盖：每个德鲁伊技能都有一条签名', () => {
    const missing = SKILL_IDS.filter((id) => !signatures[id]).map(
      (id) => `${id}（${NAME_OF.get(id)}）`,
    );
    expect(missing, '新技能必须在 signatures/druid.ts 里补签名').toEqual([]);
  });

  it('★ 没有多余键（防技能改名后留下孤儿行）', () => {
    const known = new Set(SKILL_IDS);
    const orphans = Object.keys(signatures).filter((id) => !known.has(id));
    expect(orphans, '签名表里有 shared 数据中不存在的技能 id').toEqual([]);
  });

  it('★ 全是德鲁伊的技能（不许越界写别职业）', () => {
    const foreign = Object.keys(signatures).filter((id) => !id.startsWith('druid.'));
    expect(foreign).toEqual([]);
  });

  it('每条签名至少写了 castRate / impactRate / tintShift 之一', () => {
    const empty = Object.entries(signatures)
      .filter(
        ([, s]) =>
          s.castRate === undefined && s.impactRate === undefined && s.tintShift === undefined,
      )
      .map(([id]) => id);
    expect(empty, '只换文件不给音高/色相 = 半条签名').toEqual([]);
  });

  // ── ② 磁盘校验 ──────────────────────────────────────────────
  // 素材目录是可选的（纯代码 clone 没有它）；有才校验断链，同 skillIconMap.test.ts
  describe.skipIf(!existsSync(SFX_ROOT))('★★ 音效键对磁盘校验', () => {
    it('★★ 每个 castSound / impactSound / impactLayer 都真的存在', () => {
      const broken = ALL_SOUND_REFS.filter(
        ([, key]) => !existsSync(join(SFX_ROOT, `${key}.mp3`)),
      ).map(([id, key]) => `${id} → ${key}.mp3`);
      expect(broken, '引用了 assets/music/sfx 里不存在的文件（变体后缀最常出错）').toEqual(
        [],
      );
    });

    it('引用的是基名而不是路径或带扩展名', () => {
      const malformed = ALL_SOUND_REFS.filter(
        ([, key]) => key.includes('/') || key.includes('\\') || key.endsWith('.mp3'),
      ).map(([id, key]) => `${id} → ${key}`);
      expect(malformed, '音效键必须是去掉 .mp3 的裸基名').toEqual([]);
    });
  });

  it('⚠️ impactLayer 不与 impactSound 同名（AudioManager 40ms 同名去重会吃掉叠层）', () => {
    const swallowed = Object.entries(signatures)
      .filter(([, s]) => s.impactLayer !== undefined && s.impactLayer === s.impactSound)
      .map(([id]) => id);
    expect(swallowed).toEqual([]);
  });

  // ── ③ 两两不同 ──────────────────────────────────────────────
  it('★★ 同职业内任意两条签名不完全相同', () => {
    const fingerprint = (s: SkillSignature): string =>
      JSON.stringify([
        s.castSound ?? null,
        s.castRate ?? null,
        s.impactSound ?? null,
        s.impactRate ?? null,
        s.impactLayer ?? null,
        s.tintShift ?? null,
        s.scale ?? null,
        s.form ?? null,
      ]);
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const [id, sig] of Object.entries(signatures)) {
      const fp = fingerprint(sig);
      const prev = seen.get(fp);
      if (prev) collisions.push(`${prev} 与 ${id} 签名完全相同`);
      else seen.set(fp, id);
    }
    expect(collisions, '完全相同的两条签名 = 这两个技能没有身份').toEqual([]);
  });

  // ── ④ 分量分层 ──────────────────────────────────────────────
  const ultimates = druid.skills.filter((s) => s.cooldown >= 45);

  it('本职业确实存在大招（冷却 ≥ 45s），否则第 ④ 条断言是空转', () => {
    expect(ultimates.length).toBeGreaterThan(0);
  });

  it('★★ 大招（冷却 ≥ 45s）都换了专属音效文件或带 form', () => {
    const weak = ultimates
      .filter((s) => {
        const sig = signatures[s.id as string];
        if (!sig) return true;
        const hasOwnSound = sig.castSound !== undefined || sig.impactSound !== undefined;
        const hasForm = sig.form !== undefined && sig.form !== SignatureForm.None;
        return !hasOwnSound && !hasForm;
      })
      .map((s) => `${s.id}（${s.name}，${s.cooldown}s）`);
    expect(weak, '大招必须一听就知道是它').toEqual([]);
  });

  it('★ form 是重点标记：覆盖不超过本职业技能数的一半', () => {
    const withForm = Object.entries(signatures).filter(
      ([, s]) => s.form !== undefined && s.form !== SignatureForm.None,
    );
    expect(withForm.length).toBeLessThanOrEqual(Math.floor(SKILL_IDS.length / 2));
    // 至少给了一个，否则「二级形态」这一层等于没做
    expect(withForm.length).toBeGreaterThan(0);
  });

  // ── 钳位：写出界会被 resolveSignature 静默夹回，只能在表这一侧拦 ──
  it('⚠️ 所有数值都在钳位范围内（避免写出界后被静默改成另一个值）', () => {
    const out: string[] = [];
    for (const [id, s] of Object.entries(signatures)) {
      for (const [field, v] of [
        ['castRate', s.castRate],
        ['impactRate', s.impactRate],
      ] as const) {
        if (v !== undefined && (v < RATE_CLAMP.min || v > RATE_CLAMP.max)) {
          out.push(`${id}.${field}=${v} 越出 ${RATE_CLAMP.min}~${RATE_CLAMP.max}`);
        }
      }
      if (s.tintShift !== undefined && Math.abs(s.tintShift) > TINT_CLAMP) {
        out.push(`${id}.tintShift=${s.tintShift} 越出 ±${TINT_CLAMP}`);
      }
      if (s.scale !== undefined && (s.scale < SCALE_CLAMP.min || s.scale > SCALE_CLAMP.max)) {
        out.push(`${id}.scale=${s.scale} 越出 ${SCALE_CLAMP.min}~${SCALE_CLAMP.max}`);
      }
    }
    expect(out).toEqual([]);
  });
});
