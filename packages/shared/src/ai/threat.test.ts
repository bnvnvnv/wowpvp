/**
 * 仇恨表（X10 用户拍板「谁的仇恨值高就打谁」）。
 * 表是纯折叠 + 纯函数选敌 —— 全部无 world 依赖，直接喂事件流测。
 */

import { describe, expect, it } from 'vitest';
import type { EntityId } from '../types/ids.js';
import type { CombatEvent } from '../sim/effects/registry.js';
import {
  THREAT, createThreatStore, decayThreat, pickByThreat, recordThreat, threatOf,
  threatScoreBonus,
} from './threat.js';

const id = (n: number): EntityId => n as EntityId;

const dmg = (source: number, target: number, amount: number, absorbed = 0): CombatEvent => ({
  t: 'damage', sourceId: id(source), targetId: id(target), amount, school: 0 as never,
  absorbed, overkill: 0, immune: false, skillId: 's', preventedByEquipment: 0,
});
const heal = (source: number, target: number, amount: number): CombatEvent => ({
  t: 'heal', sourceId: id(source), targetId: id(target), amount, overheal: 0,
});

describe('记账', () => {
  it('★ 打我 = 记仇；被吸收的量照记（盾挡住了不等于没打我）', () => {
    const store = createThreatStore();
    recordThreat(store, [dmg(2, 1, 100), dmg(2, 1, 50, 30)]);
    expect(threatOf(store, id(1), id(2))).toBe(180);
  });

  it('自伤（坠落）不记仇', () => {
    const store = createThreatStore();
    recordThreat(store, [dmg(1, 1, 100)]);
    expect(threatOf(store, id(1), id(1))).toBe(0);
  });

  it('★ 奶「我正恨着的人」= 恨奶的人（HEAL_FACTOR 折算）；奶别人不记', () => {
    const store = createThreatStore();
    recordThreat(store, [dmg(2, 1, 100)]); // 1 恨 2
    recordThreat(store, [heal(3, 2, 80)]); // 3 奶了 2 → 1 恨上 3
    expect(threatOf(store, id(1), id(3))).toBe(80 * THREAT.HEAL_FACTOR);
    recordThreat(store, [heal(4, 9, 500)]); // 奶一个没人恨的 → 无事发生
    expect(threatOf(store, id(1), id(4))).toBe(0);
  });

  it('★ 死亡翻篇（双向）：死者的账清空，别人对死者的恨也勾销', () => {
    const store = createThreatStore();
    recordThreat(store, [dmg(2, 1, 100), dmg(1, 2, 60)]);
    recordThreat(store, [{ t: 'death', targetId: id(2) }]);
    expect(threatOf(store, id(2), id(1)), '死者自己的账没清').toBe(0);
    expect(threatOf(store, id(1), id(2)), '别人对死者的恨没清').toBe(0);
  });
});

describe('半衰', () => {
  it('HALF_LIFE 秒后恰好减半；低于 FLOOR 清掉', () => {
    const store = createThreatStore();
    recordThreat(store, [dmg(2, 1, 100)]);
    decayThreat(store, THREAT.HALF_LIFE);
    expect(threatOf(store, id(1), id(2))).toBeCloseTo(50, 5);
    // 衰到地板下 → 条目删除、空表回收
    decayThreat(store, THREAT.HALF_LIFE * 10);
    expect(threatOf(store, id(1), id(2))).toBe(0);
    expect(store.size).toBe(0);
  });
});

describe('选敌（pickByThreat）', () => {
  const anyCandidate = () => true;

  it('★ 谁的仇恨值高就打谁', () => {
    const store = createThreatStore();
    recordThreat(store, [dmg(2, 1, 100), dmg(3, 1, 300)]);
    expect(pickByThreat(store, id(1), undefined, anyCandidate)).toBe(id(3));
  });

  it('★ 候选过滤是调用方的（A4 红线的挂点）：最恨的不合法就选次恨的', () => {
    const store = createThreatStore();
    recordThreat(store, [dmg(2, 1, 100), dmg(3, 1, 300)]);
    expect(pickByThreat(store, id(1), undefined, (x) => x !== id(3))).toBe(id(2));
  });

  it('★ 迟滞：新仇没超过当前目标的 SWITCH_RATIO 倍不转火', () => {
    const store = createThreatStore();
    recordThreat(store, [dmg(2, 1, 100), dmg(3, 1, 110)]); // 110 < 100×1.3
    expect(pickByThreat(store, id(1), id(2), anyCandidate)).toBe(id(2));
    recordThreat(store, [dmg(3, 1, 100)]); // 210 > 130 → 换
    expect(pickByThreat(store, id(1), id(2), anyCandidate)).toBe(id(3));
  });

  it('当前目标不再合法（死/隐身）时不粘：直接换最恨的合法者', () => {
    const store = createThreatStore();
    recordThreat(store, [dmg(2, 1, 500), dmg(3, 1, 100)]);
    expect(pickByThreat(store, id(1), id(2), (x) => x !== id(2))).toBe(id(3));
  });

  it('表空 → undefined（调用方走兜底路径）', () => {
    expect(pickByThreat(createThreatStore(), id(1), undefined, anyCandidate)).toBeUndefined();
  });
});

describe('hard 评分折算', () => {
  it('有界：PER_SCORE 换算 + SCORE_CAP 封顶', () => {
    const store = createThreatStore();
    recordThreat(store, [dmg(2, 1, 200)]);
    expect(threatScoreBonus(store, id(1), id(2))).toBe(200 / THREAT.PER_SCORE);
    recordThreat(store, [dmg(2, 1, 100000)]);
    expect(threatScoreBonus(store, id(1), id(2))).toBe(THREAT.SCORE_CAP);
  });
});
