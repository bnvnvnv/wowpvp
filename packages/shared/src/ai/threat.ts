/**
 * bot 仇恨表（threat）。X10 真机轮用户拍板：「谁的仇恨值高就打谁」。
 *
 * ★★ **它是 AI 层的局部记忆，不是 world 的影子状态。** 与 `BotDriver.lastCalls`
 *   同一条纪律：world 里压根没有「仇恨」这个字段，没有可分叉的第二份事实；
 *   表里的 id 每次使用都要重新过调用方的候选判定（`isFoeCandidate` ——
 *   A4 红线：仇恨**不能**扩大候选集，隐身的仇人对我等于不存在）。
 *
 * ★ 数据源是 tick 的事件流（`CombatEvent[]`）—— 与战后统计同源（sim/stats.ts
 *   的纯折叠原则）：仇恨不往任何战斗系统里插钩子，记错账也不可能改变结算。
 *
 * 规则三条：
 *   · 打我 = 记仇（伤害量 + 被护盾吸掉的量 —— 盾挡住了不等于没打我）
 *   · 奶「我正恨着的人」= 恨奶的人（治疗量 × HEAL_FACTOR，PVP 里切奶妈的依据）
 *   · 随时间半衰（HALF_LIFE）—— 仇恨是短期记忆，不是世仇；死亡翻篇（双向清账）
 *
 * ★ 选敌时带迟滞（SWITCH_RATIO）：转火不是免费的（重新贴身、丢掉铺好的
 *   DoT），两个输出相近的敌人不该让 bot 每 tick 横跳 —— 与 `pickFoe` 的
 *   SWITCH_HYSTERESIS 同一个道理，只是量纲换成了仇恨倍数。
 */

import type { EntityId } from '../types/ids.js';
import type { CombatEvent } from '../sim/effects/registry.js';

export const THREAT = {
  /** 仇恨半衰期（秒）：8 秒不再挨打，旧账减半。⚠️ 占位值，未经配平实测 */
  HALF_LIFE: 8,
  /** 治疗记仇系数：奶了我正恨的人，按治疗量的这个比例恨奶妈。⚠️ 占位值 */
  HEAL_FACTOR: 0.5,
  /** 低于此值的旧账直接清掉 —— 微量仇恨没有行为意义，表也不能无限膨胀 */
  FLOOR: 1,
  /** 换目标迟滞：新仇要超过当前目标仇恨的这个倍数才转火（防横跳）。⚠️ 占位值 */
  SWITCH_RATIO: 1.3,
  /**
   * hard 评分里仇恨的换算：`foeScore` 的 1 分 ≈ 1% 血，仇恨每 PER_SCORE 点
   * 伤害折 1 分，封顶 SCORE_CAP —— 「打了我 600 血的人」自带 30 分（≈30% 血）
   * 的集火优先度，压得过粘性(20)、压不过一个真正残血的目标。⚠️ 占位值
   */
  PER_SCORE: 20,
  SCORE_CAP: 30,
} as const;

/** victimId → (attackerId → 仇恨值) */
export type ThreatStore = Map<number, Map<number, number>>;

export const createThreatStore = (): ThreatStore => new Map();

const tableOf = (store: ThreatStore, id: EntityId): Map<number, number> => {
  let t = store.get(id as number);
  if (!t) { t = new Map(); store.set(id as number, t); }
  return t;
};

/** 表里仇恨最高的 id（不做候选过滤 —— 资格判定是调用方的事） */
const topEntry = (table: ReadonlyMap<number, number>): number | undefined => {
  let bestId: number | undefined;
  let bestV = 0;
  for (const [id, v] of table) {
    if (v > bestV) { bestV = v; bestId = id; }
  }
  return bestId;
};

/** 消费一个 tick 的事件流，更新仇恨账。事件顺序确定 ⇒ 表内容确定 */
export const recordThreat = (store: ThreatStore, events: readonly CombatEvent[]): void => {
  for (const ev of events) {
    if (ev.t === 'damage') {
      // 自伤（坠落）不记仇；被吸收的量照记 —— 盾挡住了不等于没打我
      if (ev.sourceId === ev.targetId) continue;
      const t = tableOf(store, ev.targetId);
      t.set(ev.sourceId as number, (t.get(ev.sourceId as number) ?? 0) + ev.amount + ev.absorbed);
    } else if (ev.t === 'heal') {
      if (ev.sourceId === ev.targetId) continue; // 自奶不替别人拉仇恨
      // 谁正恨着被奶的人（表顶），谁就顺带恨上奶的人
      for (const table of store.values()) {
        if (topEntry(table) === (ev.targetId as number)) {
          table.set(
            ev.sourceId as number,
            (table.get(ev.sourceId as number) ?? 0) + ev.amount * THREAT.HEAL_FACTOR,
          );
        }
      }
    } else if (ev.t === 'death') {
      // 死亡翻篇（双向）：死者的账清空，别人对死者的恨也一笔勾销 ——
      // 大仇已报；复活回来从零记起，不背上一条命的账
      store.delete(ev.targetId as number);
      for (const table of store.values()) table.delete(ev.targetId as number);
    }
  }
};

/** 每 tick 调一次：指数半衰 + 清地板。纯乘法，与调用频率解耦（按 dt 算） */
export const decayThreat = (store: ThreatStore, dt: number): void => {
  const k = Math.pow(0.5, dt / THREAT.HALF_LIFE);
  for (const [victimId, table] of store) {
    for (const [id, v] of table) {
      const nv = v * k;
      if (nv < THREAT.FLOOR) table.delete(id);
      else table.set(id, nv);
    }
    if (table.size === 0) store.delete(victimId);
  }
};

/** self 对 target 的当前仇恨值（hard 评分项用）。没记过 = 0 */
export const threatOf = (store: ThreatStore, selfId: EntityId, targetId: EntityId): number =>
  store.get(selfId as number)?.get(targetId as number) ?? 0;

/** hard 评分里的仇恨折分（见 THREAT.PER_SCORE 的注释）。确定性、有界 */
export const threatScoreBonus = (store: ThreatStore, selfId: EntityId, targetId: EntityId): number =>
  Math.min(THREAT.SCORE_CAP, threatOf(store, selfId, targetId) / THREAT.PER_SCORE);

/**
 * 仇恨选敌（normal 档的主路径）：候选中最恨者，带 SWITCH_RATIO 迟滞。
 *
 * @param isCandidate 调用方的候选判定（**必须**含可见性 —— A4 红线在调用方）
 * @returns 选中的 id；表空/无合法候选时 undefined（调用方走兜底路径）
 */
export const pickByThreat = (
  store: ThreatStore,
  selfId: EntityId,
  currentTargetId: EntityId | undefined,
  isCandidate: (id: EntityId) => boolean,
): EntityId | undefined => {
  const table = store.get(selfId as number);
  if (!table || table.size === 0) return undefined;

  let bestId: number | undefined;
  let bestV = 0;
  for (const [id, v] of table) {
    if (!isCandidate(id as EntityId)) continue;
    if (v > bestV) { bestV = v; bestId = id; }
  }
  if (bestId === undefined) return undefined;

  // 粘性：当前目标也在账上且还是合法候选时，新仇要超出 SWITCH_RATIO 倍才换
  if (currentTargetId !== undefined && bestId !== (currentTargetId as number)) {
    const cur = table.get(currentTargetId as number) ?? 0;
    if (cur > 0 && bestV < cur * THREAT.SWITCH_RATIO && isCandidate(currentTargetId)) {
      return currentTargetId;
    }
  }
  return bestId as EntityId;
};
