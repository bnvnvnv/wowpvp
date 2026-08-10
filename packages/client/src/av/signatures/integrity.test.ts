/**
 * P3 技能签名的**门禁**。
 *
 * ★★ 三条断言对应签名系统的三种死法，每一种都是「运行时静默」的：
 *   ① 引用了盘上不存在的 mp3 → `AudioManager.buffer` 的 catch 直接吞掉，
 *      技能永远无声，而没有任何一行日志（那个 catch 是为「素材可选」留的，
 *      不是为「打错字」留的）。
 *   ② 键打错成不存在的技能 id → 那一行永远解析不到，手写签名等于没写。
 *   ③ 两个技能的完整签名撞车 → 玩家听到「这两个法术是同一个」，
 *      而单测、类型、lint 全都不会有任何反应。
 *
 * ★ 断言**跑在全部 117 个技能上**，不跑在注册表大小上：
 *   现在注册表里只有 `common` 的两条，八张职业表并行开发中还没进 index。
 *   即便如此第三条也已经在干活 —— 它验的是**推导层**的兜底承诺
 *   （skillSignature.ts :13「117 个技能从此没有任何两个完全同声同色」）。
 *   收口把八表接进 `index.ts` 之后，同一个文件自动变成跨职业撞车的守门员，
 *   一行都不用改。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ALL_SKILLS, PARTY_SKILLS, type SkillDef } from '@wowpvp/shared';

import { CAST_SOUND, IMPACT_SOUND } from '../../audio/AudioManager.js';
import { registeredSignatureEntries, resolveSignature } from '../skillSignature.js';
import { COMMON_SIGNATURE_IDS } from './common.js';
// ★ 副作用导入：这一行就是「把手写表灌进注册表」。没有它整个文件在验空气
import './index.js';

/**
 * ★ 会**发出声音**的全部技能。
 *
 *   `ALL_SKILLS` 只有八个职业的（大乱斗派对武装授予的 `ffa.*` 刻意不在里面，
 *   见 shared/data/index.ts 的注释）—— 但它们同样会被玩家按出来、同样会
 *   走 `resolveSignature`，所以本文件的四条断言必须一起管着它们。
 *   不管的表现：派对技能可以引用一个不存在的 mp3 而测试全绿，
 *   而那正是本文件开头列的第①种死法。
 */
const AUDIBLE_SKILLS: readonly SkillDef[] = [...ALL_SKILLS, ...PARTY_SKILLS];

/** packages/client/src/av/signatures → 仓库根，五级 */
const SFX_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../../assets/music/sfx',
);

/** 一条签名里所有**指向磁盘**的字段（rate/tint/scale/form 不是文件） */
const soundKeysOf = (sig: { castSound?: string; impactSound?: string; impactLayer?: string }):
  readonly [string, string][] =>
  ([
    ['castSound', sig.castSound],
    ['impactSound', sig.impactSound],
    ['impactLayer', sig.impactLayer],
  ] as [string, string | undefined][])
    .flatMap(([k, v]) => (v === undefined ? [] : [[k, v] as [string, string]]));

describe('★★ P3 签名注册表的完整性', () => {
  // 素材目录是可选的（纯代码 clone 没有它）—— 与 skillIconMap.test 同一条纪律
  describe.skipIf(!existsSync(SFX_ROOT))('① 每个音效键都真的在盘上', () => {
    it('★★ 手写签名引用的每个 mp3 都存在', () => {
      const broken: string[] = [];
      for (const [id, sig] of registeredSignatureEntries()) {
        for (const [field, name] of soundKeysOf(sig)) {
          if (!existsSync(join(SFX_ROOT, `${name}.mp3`))) broken.push(`${id}.${field} → ${name}.mp3`);
        }
      }
      expect(
        broken,
        '签名引用了不存在的音效文件（⚠️ 有的文件带 _1 变体后缀，有的不带，'
        + '写键之前请对着 assets/music/sfx 逐字核对）',
      ).toEqual([]);
    });

    it('★ 学派回落表本身也不许断链（没写签名的技能全靠它发声）', () => {
      const broken = [...Object.entries(CAST_SOUND), ...Object.entries(IMPACT_SOUND)]
        .filter(([, name]) => !existsSync(join(SFX_ROOT, `${name}.mp3`)))
        .map(([school, name]) => `${school} → ${name}.mp3`);
      expect(broken).toEqual([]);
    });
  });

  describe('② 每个键都指向一个真实存在的东西', () => {
    it('★★ 键要么是真技能 id，要么是 common 里的约定键', () => {
      const known = new Set<string>([
        ...AUDIBLE_SKILLS.map((s) => s.id as string),
        ...COMMON_SIGNATURE_IDS,
      ]);
      const orphans = registeredSignatureEntries()
        .map(([id]) => id)
        .filter((id) => !known.has(id));
      expect(
        orphans,
        '注册表里有既不是技能 id、也不在 COMMON_SIGNATURE_IDS 里的键'
        + '（打错字的签名不会报错，只会永远解析不到）',
      ).toEqual([]);
    });

    it('★ common 的约定键刻意不是任何职业技能（避免与八张表静默互相覆盖）', () => {
      const skillIds = new Set(AUDIBLE_SKILLS.map((s) => s.id as string));
      expect(COMMON_SIGNATURE_IDS.filter((id) => skillIds.has(id))).toEqual([]);
    });
  });

  /**
   * ⚠️ 40ms 同名去重的坑：`AudioManager.play` 会吃掉 40ms 内的同名第二声，
   *   所以叠加层与基础层**必须不同名**，否则那一层看上去播了、其实没响。
   *   `playImpactFor` 里有一道运行时短路，这里是静态的那一道。
   */
  it('③ 叠加层不许与基础命中层同名（否则被 40ms 去重整个吃掉）', () => {
    const bad = registeredSignatureEntries()
      .filter(([, s]) => s.impactLayer !== undefined && s.impactLayer === s.impactSound)
      .map(([id, s]) => `${id}: impactLayer 与 impactSound 同为 ${s.impactLayer}`);
    expect(bad).toEqual([]);
  });
});

/**
 * 一个技能**实际会响、会显示**的完整元组。
 *
 * ★★ 关键在于把学派回落算进来：签名没写 `castSound` 时解析结果是 `undefined`，
 *   但玩家听到的是 `CAST_SOUND[school]`。直接拿 `ResolvedSignature` 比对的话，
 *   「一个火系和一个冰系都没写 castSound」会被误判成撞车 —— 那不是缺陷，
 *   它们本来就该听起来不一样。撞车的定义是**耳朵和眼睛分不出来**。
 */
const effectiveTupleOf = (skill: SkillDef): string => {
  const sig = resolveSignature(skill.id as string);
  return [
    sig.castSound ?? CAST_SOUND[skill.school],
    sig.castRate,
    sig.impactSound ?? IMPACT_SOUND[skill.school],
    sig.impactRate,
    sig.impactLayer ?? '(无层)',
    sig.tintShift,
    sig.scale,
    sig.form,
  ].join(' | ');
};

const pairKey = (a: string, b: string): string => [a, b].sort().join(' ↔ ');

/**
 * ★ 历史注脚（收口时按设计清空）：本测试首跑抓到过推导层 3 对撞车
 *   （13×13×7=1183 组合的散列空间对 117 个技能按生日问题期望撞 ~0.8 对）。
 *   收口双管齐下：地基把散列空间加宽到 41×41×17≈2.9 万组合，且八张手写表
 *   100% 覆盖后推导层只剩兜底职责 —— 已知撞车清单随之清空、断言收紧为
 *   「零撞车、无例外」。以后任何一次撞车都直接红，没有豁免通道。
 */
describe('★★ ④ 全局唯一性：任意两个技能都不许完全同声同色', () => {
  it('★ 判据跑在全部技能上，不依赖注册表里写了几条', () => {
    expect(AUDIBLE_SKILLS.length).toBeGreaterThanOrEqual(117);
  });

  it('★★ 零撞车、无例外（跨职业的守门员）', () => {
    const firstSeen = new Map<string, string>();
    const collisions: string[] = [];
    for (const skill of AUDIBLE_SKILLS) {
      const tuple = effectiveTupleOf(skill);
      const prev = firstSeen.get(tuple);
      if (prev === undefined) firstSeen.set(tuple, skill.id as string);
      else collisions.push(pairKey(prev, skill.id as string));
    }
    expect(
      collisions,
      '两个技能的完整签名元组一模一样：玩家听到/看到的是同一个法术。'
      + '给其中一个写手写签名（换音效、或明显的 castRate/form）即可',
    ).toEqual([]);
  });
});

/**
 * ★★ ⑥ 瞬发技能的施法音与命中音不许同名（X23 语义校准轮补，2026-08-10）。
 *
 * ★ 为什么原有的 ③ 挡不住：③ 比的是 `impactLayer ↔ impactSound`，
 *   而这里出事的是 `castSound ↔ impactSound` —— 同一个 40ms 去重窗口
 *   （`AudioManager.play` :217），另一对字段，谁都没看着。
 *
 * ★ 为什么只管瞬发：读条/引导技能的施法音在**开始读条**时响、命中音在
 *   读条结束后才响，中间隔着 0.8~1.6 秒，同名毫无问题（法师霜矢就是这样：
 *   cast_frost 起手、impact_frost 落点，两个名字不同纯属巧合，
 *   就算同名也不会互相吃）。`cast.time === 0` 的技能才是两声同帧发出。
 *
 * ★ 抓到过的真事：`deathknight.mind_freeze`（冻念，瞬发打断）从 P3 起
 *   castSound 与回落的命中音都是 `impact_frost` —— 命中那一声被静默吃掉，
 *   一个打断键实际上只响了一半，而全部既有断言、类型、lint 都是绿的。
 */
describe('★★ ⑥ 瞬发技能的施法音 ≠ 命中音（40ms 同名去重会吃掉第二声）', () => {
  it('★ 前置：确实存在瞬发技能，否则本组是空转', () => {
    expect(AUDIBLE_SKILLS.filter((s) => s.cast.time === 0).length).toBeGreaterThan(0);
  });

  it('★★ 瞬发技能实际会响的那两个文件名不许相同', () => {
    const bad = AUDIBLE_SKILLS.filter((s) => s.cast.time === 0)
      .map((s) => {
        const sig = resolveSignature(s.id as string);
        return {
          id: s.id as string,
          cast: sig.castSound ?? CAST_SOUND[s.school],
          impact: sig.impactSound ?? IMPACT_SOUND[s.school],
        };
      })
      .filter((r) => r.cast === r.impact)
      .map((r) => `${r.id}: 施法与命中同为 ${r.cast}`);
    expect(
      bad,
      '瞬发技能的施法音与命中音同帧发出，同名的第二声会被 40ms 去重整个吃掉'
      + '（表现是「这个技能声音很单薄」，而不是任何一处报错）',
    ).toEqual([]);
  });
});

describe('★★ ⑤ 注册真的发生：main.ts 必须 import 签名注册口', () => {
  it('★★ 入口源码锁 —— 漏掉 import 不报错，只会全部静默退回推导层', () => {
    // 注册是副作用：没有任何类型系统或运行时错误能抓住「忘了 import」。
    // 与 P10 锁 pointer-events 那行 CSS 同一手法：对源码文本断言。
    const mainSrc = readFileSync(
      resolve(fileURLToPath(new URL('.', import.meta.url)), '../../main.ts'),
      'utf8',
    );
    expect(
      mainSrc.includes("import './av/signatures/index.js';"),
      'main.ts 不再 import 签名注册口 —— 全部手写签名在浏览器里失效',
    ).toBe(true);
  });
});
