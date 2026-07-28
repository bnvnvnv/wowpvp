/**
 * 数据完整性测试。
 *
 * 这些断言是规格书附录A 和 19.2 验收清单在代码里的对应物 ——
 * 它们失败就意味着某条设计约束被破坏了，而不只是「测试挂了」。
 */

import { describe, expect, it } from 'vitest';
import {
  ALL_CLASSES,
  ALL_SKILLS,
  ALL_WEAPONS,
  hasInterruptOrSilence,
  isDedicatedInterrupt,
  validateData,
} from './index.js';

describe('数据完整性', () => {
  it('validateData 无任何问题', () => {
    const issues = validateData();
    // 失败时把具体问题打印出来，而不是只说 "expected 3 to be 0"
    expect(issues.map((i) => `${i.where}: ${i.problem}`)).toEqual([]);
  });
});

describe('规格书 1.1 — 八个首发职业', () => {
  it('恰好八个职业', () => {
    expect(ALL_CLASSES).toHaveLength(8);
  });

  it('职业名称与规格书一致', () => {
    expect(ALL_CLASSES.map((c) => c.name)).toEqual([
      '战士', '圣骑士', '死亡骑士', '盗贼', '猎人', '法师', '牧师', '德鲁伊',
    ]);
  });

  it('基础生命与规格书 9. 总表一致', () => {
    const expected: Record<string, number> = {
      warrior: 1150, paladin: 1100, deathknight: 1200, rogue: 950,
      hunter: 1000, mage: 900, priest: 900, druid: 1050,
    };
    for (const c of ALL_CLASSES) {
      expect(c.baseHealth, `${c.name} 的基础生命`).toBe(expected[c.id as string]);
    }
  });

  it('每个职业都有定位、优势和弱点（9.x）', () => {
    for (const c of ALL_CLASSES) {
      expect(c.role.length, `${c.name} role`).toBeGreaterThan(0);
      expect(c.strengths.length, `${c.name} strengths`).toBeGreaterThan(0);
      expect(c.weaknesses.length, `${c.name} weaknesses`).toBeGreaterThan(0);
    }
  });
});

describe('验收 #21 — 每个职业都有专用打断或等价沉默', () => {
  for (const c of ALL_CLASSES) {
    it(`${c.name}`, () => {
      const interrupts = c.skills.filter((s) =>
        s.effects.some((e) => e.kind === 'interrupt' || e.kind === 'silence'),
      );
      expect(interrupts.length, `${c.name} 没有打断/沉默技能`).toBeGreaterThan(0);
    });
  }
});

describe('规格书 7.2 — 专用打断不触发公共冷却', () => {
  it('所有专用打断的 triggersGcd 均为 false', () => {
    const bad = ALL_SKILLS.filter((s) => isDedicatedInterrupt(s) && s.triggersGcd);
    expect(bad.map((s) => s.id)).toEqual([]);
  });

  it('七个职业有专用打断，牧师用等价沉默（9.7 表格未标「脱离公共冷却」）', () => {
    const withDedicated = ALL_CLASSES.filter((c) => c.skills.some(isDedicatedInterrupt));
    expect(withDedicated.map((c) => c.name).sort()).toEqual(
      ['战士', '圣骑士', '死亡骑士', '盗贼', '猎人', '法师', '德鲁伊'].sort(),
    );
    // 牧师走等价沉默路线，仍满足验收 #21
    const priest = ALL_CLASSES.find((c) => c.name === '牧师')!;
    expect(priest.skills.some(isDedicatedInterrupt)).toBe(false);
    expect(hasInterruptOrSilence(priest)).toBe(true);
  });

  it('法师反制的学派锁定是 4 秒，其余专用打断是 3 秒（7.2）', () => {
    for (const s of ALL_SKILLS.filter(isDedicatedInterrupt)) {
      const eff = s.effects.find((e) => e.kind === 'interrupt');
      if (eff?.kind !== 'interrupt') continue;
      const expected = (s.classId as string) === 'mage' ? 4 : 3;
      expect(eff.schoolLockSeconds, `${s.id} 的学派锁定`).toBe(expected);
    }
  });
});

describe('附录A#3 — 每个技能九项标注齐全', () => {
  it('目标类型/距离/形状/施放时间/可移动/可打断/学派/冷却/反制方式', () => {
    for (const s of ALL_SKILLS) {
      const tag = `${s.id}`;
      expect(s.targeting, `${tag} targeting`).toBeTruthy();
      expect(s.range, `${tag} range`).toBeDefined();
      expect(s.shape, `${tag} shape`).toBeTruthy();
      expect(typeof s.cast.time, `${tag} cast.time`).toBe('number');
      expect(typeof s.cast.movable, `${tag} cast.movable`).toBe('boolean');
      expect(typeof s.cast.interruptible, `${tag} cast.interruptible`).toBe('boolean');
      expect(s.school, `${tag} school`).toBeTruthy();
      expect(typeof s.cooldown, `${tag} cooldown`).toBe('number');
      expect(s.counters.length, `${tag} counters`).toBeGreaterThan(9);
    }
  });
});

describe('附录A#4 — 每件武器六项标注齐全', () => {
  it('职业/攻击间隔/距离/优势/代价/改变的技能', () => {
    for (const w of ALL_WEAPONS) {
      const tag = `${w.id}`;
      expect(w.classId, `${tag} classId`).toBeTruthy();
      expect(w.swingInterval, `${tag} swingInterval`).toBeGreaterThan(0);
      expect(w.reach, `${tag} reach`).toBeGreaterThan(0);
      expect(w.advantage.length, `${tag} advantage`).toBeGreaterThan(0);
      expect(w.cost.length, `${tag} cost`).toBeGreaterThan(0);
    }
  });

  it('每个职业恰好三套武器方案（规格书 9.x 武器方案表）', () => {
    for (const c of ALL_CLASSES) {
      expect(c.weapons.length, `${c.name} 的武器方案数`).toBe(3);
    }
  });
});

describe('验收 #31 — 武器取舍成立', () => {
  it('双手武器高单击低攻速，双持低单击高攻速', () => {
    for (const c of ALL_CLASSES) {
      const twoHand = c.weapons.filter((w) => w.handedness === 'twoHand');
      const dual = c.weapons.filter((w) => w.handedness === 'dualWield');
      for (const th of twoHand) {
        for (const d of dual) {
          expect(th.swingPercent, `${c.name}: ${th.id} 单击应高于 ${d.id}`)
            .toBeGreaterThan(d.swingPercent);
          expect(th.swingInterval, `${c.name}: ${th.id} 攻速应慢于 ${d.id}`)
            .toBeGreaterThan(d.swingInterval);
        }
      }
    }
  });
});

describe('验收 #32 / 17.1 — 没有全面上位装备', () => {
  it('每套非默认护甲都有明确代价', () => {
    for (const c of ALL_CLASSES) {
      for (const a of c.armors.filter((x) => !x.isDefault)) {
        expect(a.cost.length, `${a.id} 缺少代价`).toBeGreaterThan(0);
      }
    }
  });

  it('没有任何护甲同时提高防御、移动和输出', () => {
    for (const a of ALL_CLASSES.flatMap((c) => c.armors)) {
      const m = a.modifiers;
      const betterDefense = (m.damageTaken ?? 1) < 1;
      const betterMobility = (m.moveSpeed ?? 1) > 1;
      const betterOffense = (m.damageDealt ?? 1) > 1;
      expect(
        [betterDefense, betterMobility, betterOffense].filter(Boolean).length,
        `${a.id} 同时提高了防御/移动/输出中的三项`,
      ).toBeLessThan(3);
    }
  });
});

describe('规格书 6.1 — 距离基准', () => {
  it('没有技能超过 45 米最大选中距离', () => {
    const bad = ALL_SKILLS.filter((s) => s.range.max > 45);
    expect(bad.map((s) => `${s.id}:${s.range.max}`)).toEqual([]);
  });
});
