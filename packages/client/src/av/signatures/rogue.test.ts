/**
 * 盗贼签名表的四条门禁（对应 rogue.ts 文件头的四句承诺）：
 *
 *   ① **全覆盖 + 无孤儿** —— 对着 shared 的 `rogue.skills` 动态断言。
 *      技能数写死在测试里，就等于给"以后加了技能没配签名"发了免死金牌：
 *      新技能会静默退回推导默认值（微音高微色相），听起来"能用"，
 *      于是没人发现它其实从来没被设计过。
 *   ② **音效键真的在盘上** —— 逐键 `existsSync`。手写表最常见的死法是
 *      改名/搬目录之后悄悄断链，运行时表现是"这个技能没声音"，
 *      而没声音看起来和"这个技能就是安静的"完全一样。
 *   ③ **同职业内两两不同** —— 与 `skillIconMap.test.ts` 的图标纪律同源：
 *      签名是**身份**，两个技能同声同色等于这一批白做。
 *   ④ **大招够分量** —— CD ≥ 45 秒的键必须换专属音效文件或带二级形态。
 *
 * ⚠️ 本表此刻**还没有被 `signatures/index.ts` 注册进运行时** —— 这是预期的，
 *   收口批统一接线。本文件因此只校验表本身，不校验 `resolveSignature` 的输出。
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { rogue } from '@wowpvp/shared';
import {
  RATE_CLAMP,
  SCALE_CLAMP,
  SignatureForm,
  TINT_CLAMP,
  type SkillSignature,
} from '../skillSignature.js';
import { signatures } from './rogue.js';

/** 本文件在 packages/client/src/av/signatures/ —— 往上五层是仓库根 */
const SFX_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../../assets/music/sfx',
);

const skillIds = rogue.skills.map((s) => s.id as string);
const entries = Object.entries(signatures);

/** 一条签名引用到的全部盘上音效键（cast / impact / layer） */
const soundKeysOf = (sig: SkillSignature): string[] =>
  [sig.castSound, sig.impactSound, sig.impactLayer].filter(
    (k): k is string => typeof k === 'string',
  );

describe('★★ 盗贼签名表', () => {
  it('★★ 全覆盖：每个盗贼技能都有一条签名', () => {
    const missing = rogue.skills
      .filter((s) => !signatures[s.id as string])
      .map((s) => `${s.id}（${s.name}）`);
    expect(missing, '新技能必须在 signatures/rogue.ts 里配签名').toEqual([]);
  });

  it('★ 无孤儿：表里没有不存在的技能 id（防改名后留下死行）', () => {
    const known = new Set(skillIds);
    expect(
      Object.keys(signatures).filter((id) => !known.has(id)),
      '签名表里有 shared 数据中不存在的技能 id',
    ).toEqual([]);
  });

  it('★ 每条签名至少写了 castRate / impactRate / tintShift 之一（不许是空壳）', () => {
    const empty = entries
      .filter(
        ([, sig]) =>
          sig.castRate === undefined &&
          sig.impactRate === undefined &&
          sig.tintShift === undefined,
      )
      .map(([id]) => id);
    expect(empty, '空签名等于没写 —— 会静默退回推导默认值').toEqual([]);
  });

  it('★★ 音效键逐个存在于 assets/music/sfx（断链即红）', () => {
    expect(existsSync(SFX_ROOT), `音效目录不存在：${SFX_ROOT}`).toBe(true);

    const broken: string[] = [];
    for (const [id, sig] of entries) {
      for (const key of soundKeysOf(sig)) {
        if (!existsSync(join(SFX_ROOT, `${key}.mp3`))) broken.push(`${id} → ${key}.mp3`);
      }
    }
    expect(broken, '引用了盘上不存在的音效文件（注意 _1 变体后缀）').toEqual([]);
  });

  it('★ impactLayer 与 impactSound 不同名（同名层会被 AudioManager 的 40ms 去重吃掉）', () => {
    const collided = entries
      .filter(([, sig]) => sig.impactLayer !== undefined && sig.impactLayer === sig.impactSound)
      .map(([id]) => id);
    expect(collided, '叠层与主命中音同名 = 那一层根本不会响').toEqual([]);
  });

  it('★★ 同职业内任意两条签名不完全相同', () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const [id, sig] of entries) {
      // 键序无关的规范化指纹
      const fingerprint = JSON.stringify(
        Object.fromEntries(Object.entries(sig).sort(([a], [b]) => a.localeCompare(b))),
      );
      const prev = seen.get(fingerprint);
      if (prev) dupes.push(`${prev} 与 ${id} 签名完全相同`);
      else seen.set(fingerprint, id);
    }
    expect(dupes, '同声同色 = 这一批白做').toEqual([]);
  });

  it('★★ 大招（冷却 ≥ 45 秒）都换了专属音效文件或带二级形态', () => {
    const ultimates = rogue.skills.filter((s) => s.cooldown >= 45);
    // 动态取，不硬编码：以后有技能冷却调过 45 秒线，这条门禁自动罩上去
    expect(ultimates.length, '盗贼应当有冷却 ≥ 45 秒的键').toBeGreaterThan(0);

    const weak = ultimates
      .filter((s) => {
        const sig = signatures[s.id as string]!;
        const hasOwnSound = sig.castSound !== undefined || sig.impactSound !== undefined;
        const hasForm = sig.form !== undefined && sig.form !== SignatureForm.None;
        return !hasOwnSound && !hasForm;
      })
      .map((s) => `${s.id}（CD ${s.cooldown}s）`);
    expect(weak, '大招必须一听就知道是它：换音效文件或上二级形态').toEqual([]);
  });

  it('★ 形态是重点标记：带 form 的技能不超过本职业技能数的一半', () => {
    const withForm = entries.filter(
      ([, sig]) => sig.form !== undefined && sig.form !== SignatureForm.None,
    );
    expect(withForm.length, 'form 人人都有等于没有').toBeLessThanOrEqual(
      Math.floor(skillIds.length / 2),
    );
  });

  it('★ 所有数值都在钳位区间内（写出界会被静默夹回，意图就丢了）', () => {
    const outOfRange: string[] = [];
    for (const [id, sig] of entries) {
      const check = (name: string, v: number | undefined, min: number, max: number): void => {
        if (v !== undefined && (v < min || v > max)) {
          outOfRange.push(`${id}.${name} = ${v}（允许 ${min}~${max}）`);
        }
      };
      check('castRate', sig.castRate, RATE_CLAMP.min, RATE_CLAMP.max);
      check('impactRate', sig.impactRate, RATE_CLAMP.min, RATE_CLAMP.max);
      check('tintShift', sig.tintShift, -TINT_CLAMP, TINT_CLAMP);
      check('scale', sig.scale, SCALE_CLAMP.min, SCALE_CLAMP.max);
    }
    expect(outOfRange, '越界值会被 resolveSignature 夹回 —— 写的和听到的不一致').toEqual([]);
  });
});
