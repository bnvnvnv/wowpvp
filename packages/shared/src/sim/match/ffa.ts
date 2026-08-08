/**
 * 大乱斗规则（P13，玩家需求：击杀/连杀广播、积分累积、积分兑换）。
 *
 * ★ 与 arena/flag 同级的模式规则模块：状态怎么变全在这里，MatchLoop 只负责
 *   「调用 + 把返回的事实翻成协议消息」—— 积分数值想调只有这一个文件。
 *
 * 积分是**货币**不是胜负：胜负仍是先到 killTarget 杀（MatchLoop.checkEnd）。
 * 兑换（spendPoints）由商店消息的处理方调用 —— 这里不认识协议。
 */

import type { EntityId } from '../../types/ids.js';

export interface FfaState {
  /** 先到这么多杀获胜（FFA.KILL_TARGET） */
  killTarget: number;
  /** 积分余额（击杀所得，兑换扣减） */
  points: Map<EntityId, number>;
  /** 当前连杀数。死亡清零 —— 「连续」的定义就是中间没死过 */
  streaks: Map<EntityId, number>;
}

export const createFfa = (killTarget: number): FfaState => ({
  killTarget,
  points: new Map(),
  streaks: new Map(),
});

/**
 * 积分规则。⚠️ 占位值（P13 首版）：击杀 100 起步，连杀每级 +25 封顶 +150 ——
 * 五连之后每杀 250。兑换定价（商店侧）应以「两杀换一件趁手武器」为锚。
 */
export const FFA_SCORE = {
  KILL: 100,
  STREAK_BONUS_PER_LEVEL: 25,
  STREAK_BONUS_MAX: 150,
} as const;

export interface FfaKillFact {
  /** 击杀者杀后的连杀数（含本次） */
  streak: number;
  /** 本次入账积分（含连杀加成） */
  bounty: number;
  /** 击杀者的积分余额（入账后） */
  killerScore: number;
  /** 击杀者的总击杀数由 stats 记（16.1），这里不重复记账 */
}

/**
 * 结算一次击杀。
 *
 * ★ 无击杀者（决胜压迫/坠落这类环境死）只清受害者连杀，返回 null ——
 *   调用方据此决定发不发广播（没有击杀者的击杀播报不出主语）。
 * ★ 自杀（killer === victim）同样只清连杀不给分 —— 给分就有「刷自己」的口子。
 */
export const settleFfaKill = (
  state: FfaState,
  killerId: EntityId | undefined,
  victimId: EntityId,
): FfaKillFact | null => {
  state.streaks.set(victimId, 0);
  if (killerId === undefined || killerId === victimId) return null;

  const streak = (state.streaks.get(killerId) ?? 0) + 1;
  state.streaks.set(killerId, streak);

  const bonus = Math.min(
    FFA_SCORE.STREAK_BONUS_PER_LEVEL * (streak - 1),
    FFA_SCORE.STREAK_BONUS_MAX,
  );
  const bounty = FFA_SCORE.KILL + bonus;
  const killerScore = (state.points.get(killerId) ?? 0) + bounty;
  state.points.set(killerId, killerScore);

  return { streak, bounty, killerScore };
};

/**
 * 兑换扣分（P13 商店的唯一扣账出口）。余额不足返回 false 且**不动余额** ——
 * 部分扣减会让「差 10 分买到了」和「白扣了没拿到」两种账目错误都写得出来。
 */
export const spendPoints = (state: FfaState, id: EntityId, cost: number): boolean => {
  const balance = state.points.get(id) ?? 0;
  if (cost < 0 || balance < cost) return false;
  state.points.set(id, balance - cost);
  return true;
};
