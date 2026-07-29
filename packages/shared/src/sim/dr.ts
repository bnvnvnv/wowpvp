/**
 * 控制递减（Diminishing Returns）。规格书 8.2，验收 #23。
 *
 * 五条递减链，梯度各不相同：
 *   昏迷 / 恐惧迷惑变形 / 定身   100% → 50% → 25% → 免疫
 *   沉默                          100% → 50% → 免疫（只有三段）
 *   击退拉拽                      短时间内递减
 *
 * ★ 定身与**普通减速**是两条独立的链，减速完全不参与递减（8.2 明确写了
 *   「与普通减速分开」）。把减速塞进 root 链会让断筋+冰霜锁链互相递减，那是错的。
 *
 * ⚠️ 一处规格书留白的解释：
 *   8.2 只说「15 秒内连续同类控制」，没说这 15 秒从**施加**算起还是从**结束**算起。
 *   本实现按「从控制**结束**时算起」——
 *     · 从施加算起会让一个 8 秒的变形术在结束时窗口只剩 7 秒，
 *       对方等 7 秒就能再来一个满时长变形，递减形同虚设；
 *     · 从结束算起才符合「连续同类控制」的字面意思。
 *   这是 MMO 的通行做法。已登记到 docs/10-acceptance-tracking.md 的待确认问题。
 */

import { DR_LADDER, DR_WINDOW_SECONDS } from '../constants/combat.js';
import type { DrCategory } from '../types/enums.js';
import type { EntityId } from '../types/ids.js';

export interface DrEntry {
  /** 本窗口内已施加过几次同类控制 */
  count: number;
  /** 窗口失效时刻（绝对秒）。超过它 count 归零 */
  expiresAt: number;
}

/** 每个实体一份递减状态。放在旁挂表里，与 CombatEntity 解耦 */
export type DrStore = Map<EntityId, Map<DrCategory, DrEntry>>;

export const createDrStore = (): DrStore => new Map();

const entryOf = (store: DrStore, id: EntityId, cat: DrCategory, now: number): DrEntry => {
  let byCat = store.get(id);
  if (!byCat) {
    byCat = new Map();
    store.set(id, byCat);
  }
  const e = byCat.get(cat);
  if (!e || e.expiresAt <= now) {
    const fresh: DrEntry = { count: 0, expiresAt: 0 };
    byCat.set(cat, fresh);
    return fresh;
  }
  return e;
};

/** 当前该类别的递减系数。0 表示免疫 */
export const drFactor = (
  store: DrStore,
  id: EntityId,
  cat: DrCategory,
  now: number,
): number => {
  const ladder = DR_LADDER[cat];
  if (!ladder) return 1;
  const e = entryOf(store, id, cat, now);
  // 次数超过梯度长度一律免疫
  return ladder[Math.min(e.count, ladder.length - 1)] ?? 0;
};

export const isImmuneTo = (
  store: DrStore,
  id: EntityId,
  cat: DrCategory,
  now: number,
): boolean => drFactor(store, id, cat, now) === 0;

export interface DrResult {
  /** 递减后的实际持续时间。0 表示免疫，控制不应施加 */
  duration: number;
  factor: number;
  /** 这是本窗口内的第几次（从 1 开始），供战后统计与调试 */
  applicationIndex: number;
  immune: boolean;
}

/**
 * 施加一次控制，返回递减后的实际持续时间并推进计数。
 *
 * ★ 免疫时**不推进计数**也**不刷新窗口** —— 否则对着免疫的目标空放控制
 *   就能无限续上递减窗口，变成一种没有代价的压制手段。
 */
export const applyDr = (
  store: DrStore,
  id: EntityId,
  cat: DrCategory,
  baseDuration: number,
  now: number,
): DrResult => {
  const e = entryOf(store, id, cat, now);
  const ladder = DR_LADDER[cat];
  const factor = ladder ? (ladder[Math.min(e.count, ladder.length - 1)] ?? 0) : 1;

  if (factor === 0) {
    return { duration: 0, factor: 0, applicationIndex: e.count + 1, immune: true };
  }

  const duration = baseDuration * factor;
  e.count += 1;
  // 窗口从控制**结束**时算起（见文件头的解释）
  e.expiresAt = now + duration + DR_WINDOW_SECONDS;
  return { duration, factor, applicationIndex: e.count, immune: false };
};

/**
 * 控制被提前解除（受伤打破变形、战斗意志解控）时调用，
 * 把窗口按实际结束时间重算 —— 否则提前 4 秒解除的控制会多占 4 秒递减窗口。
 */
export const onControlEndedEarly = (
  store: DrStore,
  id: EntityId,
  cat: DrCategory,
  now: number,
): void => {
  const byCat = store.get(id);
  const e = byCat?.get(cat);
  if (!e) return;
  e.expiresAt = Math.min(e.expiresAt, now + DR_WINDOW_SECONDS);
};

/** 清空某实体的全部递减状态（回合重置，2.1）*/
export const clearDr = (store: DrStore, id: EntityId): void => {
  store.delete(id);
};

/** 调试/HUD：当前各类别的递减层数。15.2 要求目标框显示「主要控制递减」*/
export const drSnapshot = (
  store: DrStore,
  id: EntityId,
  now: number,
): Partial<Record<DrCategory, { count: number; nextFactor: number }>> => {
  const out: Partial<Record<DrCategory, { count: number; nextFactor: number }>> = {};
  const byCat = store.get(id);
  if (!byCat) return out;
  for (const [cat, e] of byCat) {
    if (e.expiresAt <= now) continue;
    const ladder = DR_LADDER[cat];
    out[cat] = {
      count: e.count,
      nextFactor: ladder ? (ladder[Math.min(e.count, ladder.length - 1)] ?? 0) : 1,
    };
  }
  return out;
};
