/**
 * 大乱斗记分规则（P13）。数值只有 ffa.ts 一个来源，这里钉行为不钉具体分值 ——
 * 分值调平衡不该红测试，**规则形状**（连杀递增、死亡清零、余额不透支）才是不变量。
 */

import { describe, expect, it } from 'vitest';
import { asEntityId } from '../../types/ids.js';
import { FFA_SCORE, createFfa, settleFfaKill, spendPoints } from './ffa.js';

const A = asEntityId(1);
const B = asEntityId(2);
const C = asEntityId(3);

describe('P13 大乱斗记分', () => {
  it('击杀入账；连杀逐级加成且有封顶', () => {
    const s = createFfa(100);
    const first = settleFfaKill(s, A, B)!;
    expect(first.streak).toBe(1);
    expect(first.bounty).toBe(FFA_SCORE.KILL);

    const second = settleFfaKill(s, A, C)!;
    expect(second.streak).toBe(2);
    expect(second.bounty).toBe(FFA_SCORE.KILL + FFA_SCORE.STREAK_BONUS_PER_LEVEL);

    // 推到封顶之后不再上涨
    for (let i = 0; i < 20; i++) settleFfaKill(s, A, B);
    const capped = settleFfaKill(s, A, C)!;
    expect(capped.bounty).toBe(FFA_SCORE.KILL + FFA_SCORE.STREAK_BONUS_MAX);
  });

  it('★ 死亡清零连杀 —— 「连续」的定义就是中间没死过', () => {
    const s = createFfa(100);
    settleFfaKill(s, A, B);
    settleFfaKill(s, A, C);
    expect(s.streaks.get(A)).toBe(2);
    // A 被 B 反杀 → A 连杀归零，B 起 1 连
    const revenge = settleFfaKill(s, B, A)!;
    expect(revenge.streak).toBe(1);
    expect(s.streaks.get(A)).toBe(0);
  });

  it('★ 环境死/自杀不给分（没有可播的主语；自杀给分就有刷分口子）', () => {
    const s = createFfa(100);
    expect(settleFfaKill(s, undefined, B)).toBeNull();
    expect(settleFfaKill(s, A, A)).toBeNull();
    expect(s.points.get(A) ?? 0).toBe(0);
  });

  it('★ 兑换不透支：余额不足整笔拒绝且不动账', () => {
    const s = createFfa(100);
    settleFfaKill(s, A, B);
    const balance = s.points.get(A)!;
    expect(spendPoints(s, A, balance + 1)).toBe(false);
    expect(s.points.get(A)).toBe(balance);
    expect(spendPoints(s, A, balance)).toBe(true);
    expect(s.points.get(A)).toBe(0);
    // 负数消费是账目攻击，不是折扣
    expect(spendPoints(s, A, -50)).toBe(false);
  });
});
