/**
 * 打断结算。规格书 7.2 / 7.3，验收 #15 / #16。
 *
 * 7.2 的四条规则，每一条都容易实现错：
 *   1. 命中正在进行的读条/引导/瞄准射击 → 立即停止
 *   2. 被打断的是**魔法** → 同学派锁定 3 秒（法师反制 4 秒）
 *   3. 被打断的是**物理射击准备** → 只取消本次射击，**不产生学派锁定**（验收 #16）
 *   4. 打断未命中 / 目标未在施法 / 技能本身不可打断 → **打断技能仍进入冷却**
 */

import { CastKind, InterruptSource, School, isMagicSchool } from '../types/enums.js';
import type { EffectDef, SkillDef } from '../data/schema.js';
import type { CombatEntity } from './entity.js';
import type { CastEvents, CastingStore } from './casting.js';
import type { World } from './world.js';

export interface InterruptOutcome {
  /** 是否真的打断了什么 */
  interrupted: boolean;
  /** 产生的学派锁定。物理射击被打断时为 undefined（验收 #16）*/
  schoolLock?: { school: School; until: number };
  /** 未打断成功的原因，用于 HUD 反馈与战后统计 */
  reason?: 'notCasting' | 'notInterruptible' | 'targetMissing';
}

/** 从技能数据里取出打断效果声明的学派锁定时长 */
export const interruptLockSeconds = (skill: SkillDef): number | undefined => {
  const eff = skill.effects.find((e: EffectDef) => e.kind === 'interrupt');
  return eff?.kind === 'interrupt' ? eff.schoolLockSeconds : undefined;
};

/**
 * 对 `target` 施加一次专用打断。
 *
 * ⚠️ 调用方**必须**在拿到结果后无条件让打断技能进冷却 ——
 * 7.2 明确规定落空也进冷却。这个函数只负责结算打断本身，不碰冷却，
 * 就是为了让「无条件进冷却」这件事留在调用点上、无法被 if 分支绕过。
 */
export const applyInterrupt = (
  world: World,
  store: CastingStore,
  target: CombatEntity | undefined,
  lockSeconds: number,
  events?: CastEvents,
): InterruptOutcome => {
  if (!target) return { interrupted: false, reason: 'targetMissing' };

  const state = store.get(target.id);
  // 7.2：目标未在施法时，打断落空
  if (!state) return { interrupted: false, reason: 'notCasting' };

  // 7.1：不可打断技能带盾牌标记，专用打断对它无效
  if (!state.interruptible) return { interrupted: false, reason: 'notInterruptible' };

  store.delete(target.id);

  // ★ 验收 #16：物理射击准备被打断，只取消本次射击，不产生魔法学派锁定。
  // 判据用 CastState.school 而不是 CastKind —— 学派锁定锁的是学派，
  // 一个物理学派的读条技能同样不该产生锁定。
  let schoolLock: { school: School; until: number } | undefined;
  if (isMagicSchool(state.school)) {
    const until = world.time + lockSeconds;
    // 取较晚者：已有更长的锁定不应该被一次新打断缩短
    const existing = target.schoolLocks.get(state.school) ?? 0;
    target.schoolLocks.set(state.school, Math.max(existing, until));
    schoolLock = { school: state.school, until };
  }

  events?.onInterrupted?.(target, state, InterruptSource.Kick, schoolLock);
  return { interrupted: true, schoolLock };
};

/**
 * 8.2 沉默：停止并禁止魔法技能。
 * ★ 验收 #17：**不阻止**物理射击、普通攻击和纯武器技能。
 *
 * 与专用打断的区别：沉默不产生学派锁定，而是在持续时间内禁止**所有**魔法学派。
 */
export const applySilence = (
  world: World,
  store: CastingStore,
  target: CombatEntity,
  events?: CastEvents,
): boolean => {
  const state = store.get(target.id);
  if (!state) return false;
  // 只停止魔法施法。物理的瞄准射击不受沉默影响（7.1 表格最后一列）
  if (!isMagicSchool(state.school)) return false;

  store.delete(target.id);
  events?.onInterrupted?.(target, state, InterruptSource.Silence);
  return true;
};

/**
 * 8.2 缴械：停止并禁止武器攻击、瞄准射击和武器技能。
 * ★ 验收 #17：**不阻止**纯魔法施法。
 */
export const applyDisarm = (
  world: World,
  store: CastingStore,
  target: CombatEntity,
  events?: CastEvents,
): boolean => {
  const state = store.get(target.id);
  if (!state) return false;
  const isWeaponAction = state.school === School.Physical || state.kind === CastKind.AimedShot;
  if (!isWeaponAction) return false;

  store.delete(target.id);
  events?.onInterrupted?.(target, state, InterruptSource.Disarm);
  return true;
};

/**
 * 7.3 / 验收 #14：**普通伤害默认不停止也不延长施法。**
 *
 * 这个函数刻意存在且刻意什么都不做 —— 它把「伤害不打断施法」这条规则
 * 变成代码里一个可以被搜索到、被测试引用的事实，而不是一个「碰巧没写」的空白。
 * 只有技能明确带「打断」或控制效果时才中止（那走 applyInterrupt / 控制效果路径）。
 */
export const onDamageTaken = (): void => {
  // 有意为空。见上方注释与规格书 7.3 表格「普通伤害」一行。
};
