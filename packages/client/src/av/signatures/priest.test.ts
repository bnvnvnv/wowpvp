/**
 * P3：牧师手写签名表的门禁。
 *
 * ★★ 这个文件挡的是手写表的三种典型死法：
 *   1. **漏键 / 孤儿键** —— 新增技能忘了配签名会静默退回推导层（听感上就是
 *      「又回到七组学派音」的老问题）；改名后留下的孤儿行则永远不会被调用。
 *      两边都对着 shared 的 priest 动态比，**不硬编码技能数量**。
 *   2. **音效断链** —— 引用 `assets/music/sfx/` 里不存在的基名。最常见的是
 *      漏掉 `_1` 变体后缀（盘上是 `mob_demon_aggro_1` 不是 `mob_demon_aggro`）。
 *      逐键 existsSync，与 M12 `skillIconMap.test.ts` 同一套纪律。
 *   3. **分量塌陷** —— 大招和填充键写成一个样。这里钉死「冷却 ≥ 45s 必须换
 *      专属音效文件或带二级形态」和「同职业内两两不同」。
 *
 * ⚠️ 本表尚未被 `signatures/index.ts` 注册进运行时（收口批次统一接线），
 *   所以往返用例自己调 `registerSignatures` —— vitest 按文件隔离模块图，
 *   不会污染别的测试文件的注册表。
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { priest } from '@wowpvp/shared';
import {
  RATE_CLAMP,
  SCALE_CLAMP,
  SignatureForm,
  TINT_CLAMP,
  registerSignatures,
  resolveSignature,
} from '../skillSignature.js';
import { signatures } from './priest.js';

const SFX_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../../assets/music/sfx',
);

/** 冷却 ≥ 45 秒 = 大招档（与表里注释的分层口径一致） */
const ULTIMATE_COOLDOWN = 45;

const skillIds = priest.skills.map((s) => s.id as string);
const entries = Object.entries(signatures);

/** 一条签名里所有指向盘上文件的字段 */
const soundKeysOf = (sig: (typeof signatures)[string]): [string, string][] =>
  (
    [
      ['castSound', sig.castSound],
      ['impactSound', sig.impactSound],
      ['impactLayer', sig.impactLayer],
    ] as [string, string | undefined][]
  ).flatMap(([field, name]) => (name === undefined ? [] : [[field, name] as [string, string]]));

describe('★★ 牧师签名表', () => {
  it('★★ 全覆盖：每个牧师技能都有一条签名', () => {
    const missing = priest.skills
      .filter((s) => !signatures[s.id as string])
      .map((s) => `${s.id as string}（${s.name}）`);
    expect(missing, '新技能必须在 signatures/priest.ts 里配签名').toEqual([]);
  });

  it('★ 没有多余键（防改名后留下永不生效的孤儿行）', () => {
    const known = new Set(skillIds);
    const orphans = Object.keys(signatures).filter((id) => !known.has(id));
    expect(orphans, '签名表里有不属于牧师的技能 id').toEqual([]);
  });

  it('★ 每条签名至少写了 castRate / impactRate / tintShift 之一', () => {
    const empty = entries
      .filter(([, sig]) => sig.castRate === undefined && sig.impactRate === undefined && sig.tintShift === undefined)
      .map(([id]) => id);
    expect(empty, '这些签名没有任何可辨识的音高/色相偏移').toEqual([]);
  });

  it('★★ 同职业内两两不同（技能栏一次只显示一个职业）', () => {
    const collisions: string[] = [];
    const seen = new Map<string, string>();
    for (const [id, sig] of entries) {
      // 字段顺序不参与比较：按 key 排序后序列化
      const fingerprint = JSON.stringify(
        Object.fromEntries(Object.entries(sig).sort(([a], [b]) => a.localeCompare(b))),
      );
      const prev = seen.get(fingerprint);
      if (prev) collisions.push(`${prev} 与 ${id} 签名完全相同`);
      else seen.set(fingerprint, id);
    }
    expect(collisions, '同职业内出现完全相同的签名').toEqual([]);
  });

  it('★★ 大招（冷却 ≥ 45s）都换了专属音效文件或带二级形态', () => {
    const weak = priest.skills
      .filter((s) => s.cooldown >= ULTIMATE_COOLDOWN)
      .filter((s) => {
        const sig = signatures[s.id as string];
        if (!sig) return true;
        const hasOwnSound = Boolean(sig.castSound ?? sig.impactSound);
        const hasForm = sig.form !== undefined && sig.form !== SignatureForm.None;
        return !hasOwnSound && !hasForm;
      })
      .map((s) => `${s.id as string}（${s.name}，${s.cooldown}s）`);
    expect(weak, '大招必须一听就知道是它').toEqual([]);
  });

  it('★ 二级形态不超过职业技能数的一半（form 是重点标记，人人都有等于没有）', () => {
    const formed = entries.filter(
      ([, sig]) => sig.form !== undefined && sig.form !== SignatureForm.None,
    );
    expect(formed.length).toBeLessThanOrEqual(Math.floor(skillIds.length / 2));
  });

  it('⚠️ impactLayer 不与 impactSound 同名（AudioManager 的 40ms 同名去重会吃掉叠层）', () => {
    const swallowed = entries
      .filter(([, sig]) => sig.impactLayer !== undefined && sig.impactLayer === sig.impactSound)
      .map(([id]) => id);
    expect(swallowed, '叠层与命中音同名，实际只会响一层').toEqual([]);
  });

  it('★ 所有数值都在钳位区间内（写出界不会崩，只会被悄悄夹回 —— 那更难查）', () => {
    const outOfRange: string[] = [];
    for (const [id, sig] of entries) {
      for (const [field, v] of [
        ['castRate', sig.castRate],
        ['impactRate', sig.impactRate],
      ] as const) {
        if (v !== undefined && (v < RATE_CLAMP.min || v > RATE_CLAMP.max))
          outOfRange.push(`${id}.${field}=${v}`);
      }
      if (sig.tintShift !== undefined && Math.abs(sig.tintShift) > TINT_CLAMP)
        outOfRange.push(`${id}.tintShift=${sig.tintShift}`);
      if (sig.scale !== undefined && (sig.scale < SCALE_CLAMP.min || sig.scale > SCALE_CLAMP.max))
        outOfRange.push(`${id}.scale=${sig.scale}`);
    }
    expect(outOfRange, '这些值会被 resolveSignature 夹回，写的不是实际生效的').toEqual([]);
  });

  it('注册后 resolveSignature 原样取回手写值（表的形状对得上运行时）', () => {
    registerSignatures(signatures);
    const r = resolveSignature('priest.mass_dispel');
    expect(r.castSound).toBe('spell_nova');
    expect(r.impactSound).toBe('ui_craft_disenchant');
    expect(r.impactLayer).toBe('impact_holy');
    expect(r.form).toBe(SignatureForm.Ring);
    expect(r.scale).toBeCloseTo(1.6, 5);
  });

  // 素材目录是可选的（纯代码 clone 没有它）；有才校验断链
  describe.skipIf(!existsSync(SFX_ROOT))('★★ 音效磁盘校验', () => {
    it('★★ 每个 castSound / impactSound / impactLayer 都在 assets/music/sfx 里', () => {
      const broken: string[] = [];
      for (const [id, sig] of entries) {
        for (const [field, name] of soundKeysOf(sig)) {
          if (!existsSync(join(SFX_ROOT, `${name}.mp3`)))
            broken.push(`${id}.${field} → ${name}.mp3`);
        }
      }
      expect(broken, '音效断链：基名写错（多半是漏了 _N 变体后缀）或文件被删').toEqual([]);
    });

    it('自检：这条校验真的能抓出不存在的文件', () => {
      expect(existsSync(join(SFX_ROOT, 'mob_demon_aggro.mp3'))).toBe(false);
      expect(existsSync(join(SFX_ROOT, 'mob_demon_aggro_1.mp3'))).toBe(true);
    });
  });
});
