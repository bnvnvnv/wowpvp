/**
 * 战士手工签名表的门禁。
 *
 * ★★ 四条硬保证（对应 warrior.ts 文件头的分层承诺）：
 *   1. **全覆盖 + 无孤儿** —— 对着 shared 的战士数据**动态**比对，
 *      不硬编码技能数量：加技能不写签名 = 红灯，删技能留下孤儿行 = 红灯。
 *   2. **每个音效键都在盘上** —— 逐键 fs 校验。手写表最常见的死法就是
 *      改名/搬目录之后悄悄断链（skillIconMap.test.ts 同款纪律，见那边 :60）。
 *      ⚠️ 尤其盯 `_N` 后缀：盘上是 impact_metal_1..4，写 `impact_metal` 必红。
 *   3. **同职业内两两不同** —— 本批的目的就是让 117 个技能不再共用七组学派音，
 *      同职业内撞车等于这批白做。
 *   4. **大招有分量** —— 冷却 ≥ 45s 的键必须换过专属音效文件或带二级形态。
 *
 * ★ 外加三条"分层不许塌"的结构断言（钳位、form 预算、填充键不许抢戏）。
 */

import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALL_CLASSES } from '@wowpvp/shared';
import type { SkillDef } from '@wowpvp/shared';
import {
  RATE_CLAMP,
  SCALE_CLAMP,
  SignatureForm,
  TINT_CLAMP,
  type SkillSignature,
} from '../skillSignature.js';
import { signatures } from './warrior.js';

/** 从本文件到仓库根：signatures → av → src → client → packages → 根 */
const SFX_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../../assets/music/sfx',
);

/** 大招门槛（秒）。与任务书一致：冷却 ≥ 45 秒的键必须"一听就知道是它" */
const ULTIMATE_COOLDOWN = 45;

const warriorSkills: readonly SkillDef[] =
  ALL_CLASSES.find((c) => (c.id as string) === 'warrior')?.skills ?? [];

const entries = Object.entries(signatures);

/**
 * 一条签名引用到的全部音效基名，带字段名（未填的字段不算）。
 * ★ 带字段名是为了断链时能直接说"哪个技能的哪个字段"，而不是只报一个孤零零的基名。
 */
const soundKeysOf = (sig: SkillSignature): [field: string, key: string][] => {
  // ⚠️ 不写 `as const`：类型谓词的收窄类型必须可赋值给参数类型，
  //   而 `[string, string]` 赋不进 `readonly ['castSound', ...]` 那种字面量元组。
  const fields: [string, string | undefined][] = [
    ['castSound', sig.castSound],
    ['impactSound', sig.impactSound],
    ['impactLayer', sig.impactLayer],
  ];
  return fields.filter((pair): pair is [string, string] => typeof pair[1] === 'string');
};

describe('★★ 战士签名表', () => {
  it('前置：shared 里确实读到了战士技能（读不到的话后面全是空断言）', () => {
    expect(warriorSkills.length).toBeGreaterThan(0);
  });

  it('★★ 全覆盖：每个战士技能都有一条签名', () => {
    const missing = warriorSkills
      .filter((s) => !signatures[s.id as string])
      .map((s) => `${s.id as string}（${s.name}）`);
    expect(missing, '新技能必须在 warrior.ts 里写签名').toEqual([]);
  });

  it('★ 没有多余键（防改名/删技能后留下孤儿行）', () => {
    const known = new Set(warriorSkills.map((s) => s.id as string));
    const orphans = Object.keys(signatures).filter((id) => !known.has(id));
    expect(orphans, '签名表里有不存在的战士技能 id').toEqual([]);
  });

  it('★ 键全部属于战士（别的职业的技能不许写进本表）', () => {
    const foreign = Object.keys(signatures).filter((id) => !id.startsWith('warrior.'));
    expect(foreign).toEqual([]);
  });

  it('★★ 每条签名至少写了 castRate / impactRate / tintShift 之一', () => {
    const empty = entries
      .filter(([, s]) => s.castRate === undefined && s.impactRate === undefined && s.tintShift === undefined)
      .map(([id]) => id);
    expect(empty, '空签名等于没写 —— 落回推导层就失去手写的意义').toEqual([]);
  });

  it('★★ 同职业内两两不同（撞车 = 这批白做）', () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const [id, sig] of entries) {
      // 字段顺序无关：按 key 排序后序列化
      const fingerprint = JSON.stringify(
        Object.fromEntries(Object.entries(sig).sort(([a], [b]) => a.localeCompare(b))),
      );
      const prev = seen.get(fingerprint);
      if (prev) collisions.push(`${prev} 与 ${id} 签名完全相同`);
      else seen.set(fingerprint, id);
    }
    expect(collisions).toEqual([]);
  });
});

describe('★★ 音效键对磁盘校验', () => {
  it('前置：素材目录存在（assets/music/sfx 是入库素材，不是可选目录）', () => {
    expect(existsSync(SFX_ROOT), `找不到 ${SFX_ROOT}`).toBe(true);
  });

  it('★★ 每个 castSound / impactSound / impactLayer 都在盘上（逐键 fs 验）', () => {
    const onDisk = new Set(
      readdirSync(SFX_ROOT)
        .filter((f) => f.endsWith('.mp3'))
        .map((f) => f.slice(0, -'.mp3'.length)),
    );
    const broken: string[] = [];
    for (const [id, sig] of entries) {
      for (const [field, key] of soundKeysOf(sig)) {
        if (!onDisk.has(key)) broken.push(`${id}.${field} → ${key}.mp3 不存在`);
      }
    }
    expect(broken, '断链（多半是漏了 _N 后缀，或素材改名）').toEqual([]);
  });

  it('★ impactLayer 与 impactSound 不同名（40ms 同名去重会吃掉同名层）', () => {
    const bad = entries
      .filter(([, s]) => s.impactLayer !== undefined && s.impactLayer === s.impactSound)
      .map(([id]) => id);
    expect(bad).toEqual([]);
  });

  it('★ 没写 impactSound 时，impactLayer 也不许撞物理学派的兜底命中音', () => {
    // AudioManager.ts:51 —— physical 的兜底命中音是 impact_flesh_1
    const PHYSICAL_FALLBACK_IMPACT = 'impact_flesh_1';
    const bad = entries
      .filter(([, s]) => s.impactSound === undefined && s.impactLayer === PHYSICAL_FALLBACK_IMPACT)
      .map(([id]) => id);
    expect(bad).toEqual([]);
  });
});

describe('★★ 分量分层不许塌', () => {
  const ultimates = warriorSkills.filter((s) => s.cooldown >= ULTIMATE_COOLDOWN);

  it('前置：战士确实有大招（阈值改动后这条会提醒重看本组断言）', () => {
    expect(ultimates.length).toBeGreaterThan(0);
  });

  it('★★ 大招都换了专属音效文件或带二级形态', () => {
    const weak = ultimates
      .filter((s) => {
        const sig = signatures[s.id as string];
        if (!sig) return false; // 覆盖率由上一组断言负责，这里不重复报
        const hasOwnSound = sig.castSound !== undefined || sig.impactSound !== undefined;
        const hasForm = sig.form !== undefined && sig.form !== SignatureForm.None;
        return !hasOwnSound && !hasForm;
      })
      .map((s) => `${s.id as string}（${s.name}，${s.cooldown}s）`);
    expect(weak, '大招没有专属音画 = 玩家听不出这是他攒了一分半的键').toEqual([]);
  });

  it('★ 大招的规模明显高于默认（分量要看得见）', () => {
    const small = ultimates
      .filter((s) => (signatures[s.id as string]?.scale ?? 1) < 1.4)
      .map((s) => `${s.id as string}（scale ${signatures[s.id as string]?.scale ?? 1}）`);
    expect(small).toEqual([]);
  });

  it('★ form 不超过本职业技能数的一半（重点标记人人都有等于没有）', () => {
    const withForm = entries.filter(
      ([, s]) => s.form !== undefined && s.form !== SignatureForm.None,
    );
    expect(withForm.length).toBeLessThanOrEqual(Math.floor(warriorSkills.length / 2));
  });

  it('★ 无冷却的填充键不许带 form（按得最勤的键不许抢大招的戏）', () => {
    const noisy = warriorSkills
      .filter((s) => s.cooldown === 0)
      .filter((s) => {
        const f = signatures[s.id as string]?.form;
        return f !== undefined && f !== SignatureForm.None;
      })
      .map((s) => `${s.id as string}（${s.name}）`);
    expect(noisy).toEqual([]);
  });
});

describe('★ 数值都在钳位区间内（写出界不会崩，只会被悄悄夹回）', () => {
  it('castRate / impactRate 在 RATE_CLAMP 内', () => {
    const out: string[] = [];
    for (const [id, s] of entries) {
      for (const [field, v] of [
        ['castRate', s.castRate],
        ['impactRate', s.impactRate],
      ] as const) {
        if (v !== undefined && (v < RATE_CLAMP.min || v > RATE_CLAMP.max)) {
          out.push(`${id}.${field} = ${v}`);
        }
      }
    }
    expect(out, '写出界的值会被 resolveSignature 夹回 —— 表里写的就不是真听到的').toEqual([]);
  });

  it('tintShift 在 ±TINT_CLAMP 内', () => {
    const out = entries
      .filter(([, s]) => s.tintShift !== undefined && Math.abs(s.tintShift) > TINT_CLAMP)
      .map(([id, s]) => `${id} = ${s.tintShift ?? 0}`);
    expect(out).toEqual([]);
  });

  it('scale 在 SCALE_CLAMP 内', () => {
    const out = entries
      .filter(
        ([, s]) => s.scale !== undefined && (s.scale < SCALE_CLAMP.min || s.scale > SCALE_CLAMP.max),
      )
      .map(([id, s]) => `${id} = ${s.scale ?? 1}`);
    expect(out).toEqual([]);
  });
});
