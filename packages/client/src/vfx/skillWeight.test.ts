/**
 * 技能表现分量。
 *
 * ★★ 这里钉的是**性质**不是名单。「陨星必须是最重的」这种断言看着直观，
 *   但它会在下一次数值配平改一个 cooldown 时变红 —— 那是会让人删掉的测试。
 *   所以钉：值域、单调、分布、跨职业覆盖，以及「不许按技能 id 特判」。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALL_SKILLS, asSkillId, getSkill, type SkillDef } from '@wowpvp/shared';
import { areaExtentOf, vfxScaleOf, weightOf } from './skillWeight.js';

/** 拿一个真实技能当模板改字段 —— 比手搓一个 SkillDef 更不容易漂 */
const base = getSkill(asSkillId('mage.frostbolt'))!;
const withField = (over: Partial<SkillDef>): SkillDef => ({ ...base, ...over });

describe('weightOf —— 值域与纯粹性', () => {
  it('全部 90 个技能都落在 [0,1]，无 NaN', () => {
    for (const s of ALL_SKILLS) {
      const w = weightOf(s);
      expect(Number.isFinite(w), s.name).toBe(true);
      expect(w, s.name).toBeGreaterThanOrEqual(0);
      expect(w, s.name).toBeLessThanOrEqual(1);
    }
  });

  it('纯函数：同一个技能连算两次结果相同', () => {
    for (const s of ALL_SKILLS) expect(weightOf(s)).toBe(weightOf(s));
  });

  it('脏数据不产生 NaN（冷却是 NaN 时兜底）', () => {
    expect(Number.isFinite(weightOf(withField({ cooldown: NaN })))).toBe(true);
  });
});

describe('weightOf —— 逐项单调（「大招自动更重」的形式化）', () => {
  it('只抬高冷却，分量不减', () => {
    const low = weightOf(withField({ cooldown: 5 }));
    const mid = weightOf(withField({ cooldown: 30 }));
    const high = weightOf(withField({ cooldown: 90 }));
    expect(mid).toBeGreaterThanOrEqual(low);
    expect(high).toBeGreaterThanOrEqual(mid);
    expect(high).toBeGreaterThan(low);
  });

  it('只抬高资源消耗，分量不减', () => {
    const a = weightOf(withField({ cost: { ...base.cost!, amount: 10 } }));
    const b = weightOf(withField({ cost: { ...base.cost!, amount: 150 } }));
    expect(b).toBeGreaterThan(a);
  });

  it('只扩大范围，分量不减', () => {
    const a = weightOf(withField({ shape: { kind: 'circle', radius: 1 } }));
    const b = weightOf(withField({ shape: { kind: 'circle', radius: 9 } }));
    expect(b).toBeGreaterThan(a);
  });

  it('★ 冷却必须比施法时长更有话语权 —— 90 秒瞬发重于 1.5 秒读条的短冷却技能', () => {
    const instantUltimate = weightOf(withField({ cooldown: 90, cast: { ...base.cast, time: 0 } }));
    const slowFiller = weightOf(withField({ cooldown: 6, cast: { ...base.cast, time: 1.5 } }));
    expect(instantUltimate).toBeGreaterThan(slowFiller);
  });
});

describe('weightOf —— 分布（防止「全都是大招」或「全都不是」）', () => {
  const weights = ALL_SKILLS.map(weightOf);

  it('★★ 重技能是少数：分量 ≥0.5 的在 6~24 个之间', () => {
    const heavy = weights.filter((w) => w >= 0.5).length;
    expect(heavy).toBeGreaterThanOrEqual(6);
    expect(heavy).toBeLessThanOrEqual(24);
  });

  it('★ 轻技能必须存在 —— 没有对比就没有夸张', () => {
    expect(weights.filter((w) => w < 0.2).length).toBeGreaterThan(0);
  });

  it('最重与最轻之间要拉得开（否则分级等于没有）', () => {
    expect(Math.max(...weights) - Math.min(...weights)).toBeGreaterThan(0.5);
  });

  it('★ 大招不是某个职业的特权：至少 5 个职业各有一个 ≥0.45 的技能', () => {
    const classes = new Set(
      ALL_SKILLS.filter((s) => weightOf(s) >= 0.45).map((s) => s.classId as string),
    );
    expect(classes.size).toBeGreaterThanOrEqual(5);
  });
});

describe('areaExtentOf —— 六种形状都有值', () => {
  it('每种 shape.kind 都返回正数（单体也有，见实现注释）', () => {
    expect(areaExtentOf({ kind: 'single' })).toBeGreaterThan(0);
    expect(areaExtentOf({ kind: 'circle', radius: 6 })).toBe(6);
    expect(areaExtentOf({ kind: 'ring', innerRadius: 2, outerRadius: 8 })).toBe(8);
    expect(areaExtentOf({ kind: 'cone', angleDeg: 60, range: 10 })).toBe(10);
    expect(areaExtentOf({ kind: 'line', length: 20, width: 3 })).toBe(10);
    expect(areaExtentOf({ kind: 'chain', jumpRange: 8, maxTargets: 3 })).toBe(8);
  });

  it('全部 90 个技能的形状都量得出正数', () => {
    for (const s of ALL_SKILLS) expect(areaExtentOf(s.shape), s.name).toBeGreaterThan(0);
  });
});

describe('vfxScaleOf —— 表现倍率', () => {
  it('★ 下限不低于 0.85：小技能是「收着」，不是比改造前还弱', () => {
    for (const s of ALL_SKILLS) {
      expect(vfxScaleOf(s), s.name).toBeGreaterThanOrEqual(0.85);
      expect(vfxScaleOf(s), s.name).toBeLessThanOrEqual(1.5);
    }
  });

  it('倍率随分量单调', () => {
    expect(vfxScaleOf(withField({ cooldown: 90 })))
      .toBeGreaterThan(vfxScaleOf(withField({ cooldown: 0 })));
  });
});

describe('★★ 实现必须是「推导」而不是「手配」', () => {
  it('源码里不出现任何具体技能 id —— 出现了就说明开始按名单特判了', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./skillWeight.ts', import.meta.url)), 'utf8',
    );
    // 技能 id 形如 mage.frostbolt / priest.power_word_shield
    const hits = [...src.matchAll(/'[a-z]+\.[a-z_0-9]+'/g)].map((m) => m[0]);
    expect(hits, `不该出现的技能 id：${hits.join(', ')}`).toEqual([]);
  });
});
