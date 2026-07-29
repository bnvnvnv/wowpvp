/**
 * 数值修正聚合。规格书 8.4 / 17.1，验收 #23 / #32。
 *
 * 8.4：「同类团队减伤、加速和治疗增益不能无限叠加；同类型效果取较强者或按衰减规则叠加。」
 * 17.1：「同类控制、团队减伤、加速和治疗增益不能通过多职业重复无限叠加。」
 *
 * ★ 这个文件是「不能叠加到离谱」这条规则的唯一实现处。
 *   每个字段的聚合方式都是一个**设计决策**，下面逐条写明理由 ——
 *   随手改成相乘会让 5v5 里三个减伤叠出 90% 免伤。
 */

import type { AuraModifiers } from '../data/schema.js';
import { School } from '../types/enums.js';

/** 聚合后的最终修正。字段含义与 AuraModifiers 一致，但保证已经过叠加规则处理 */
export interface EffectiveModifiers {
  moveSpeed: number;
  moveSpeedFloor: number;
  damageTaken: number;
  damageTakenBySchool: Partial<Record<School, number>>;
  damageDealt: number;
  healingTaken: number;
  healingDone: number;
  attackSpeed: number;
  castSpeed: number;
  healCastSpeed: number;
  knockbackTaken: number;
  ccDurationTaken: number;
  ccDurationDealt: number;
  dodgeFront: number;
  parry: number;
  block: number;
  resourceGain: number;
  maxHealth: number;
  absorbDone: number;
}

export const neutralModifiers = (): EffectiveModifiers => ({
  moveSpeed: 1,
  moveSpeedFloor: 0,
  damageTaken: 1,
  damageTakenBySchool: {},
  damageDealt: 1,
  healingTaken: 1,
  healingDone: 1,
  attackSpeed: 1,
  castSpeed: 1,
  healCastSpeed: 1,
  knockbackTaken: 1,
  ccDurationTaken: 1,
  ccDurationDealt: 1,
  dodgeFront: 0,
  parry: 0,
  block: 0,
  resourceGain: 1,
  maxHealth: 1,
  absorbDone: 1,
});

/**
 * 聚合一组修正。
 *
 * | 字段 | 叠加方式 | 理由 |
 * |---|---|---|
 * | 减速 `moveSpeed < 1` | **取最强** | 8.4。断筋 40% + 冰霜锁链 60% 若相乘 = 减速 76%，等于锁死 |
 * | 加速 `moveSpeed > 1` | **取最强** | 8.4。群奔 + 猎豹形态若相乘会让旗手速度失控 |
 * | 受到伤害 `damageTaken` | **减伤取最强、增伤相乘** | 17.1 只禁止**减伤**叠加；易伤叠加是设计意图（审判） |
 * | 受到治疗 `healingTaken` | **降低取最强** | 致死打击 + 毒刃若相乘 = 受到治疗 -40%，超出设计 |
 * | 造成伤害 `damageDealt` | **相乘** | 爆发窗口本来就是设计意图（复仇之怒） |
 * | 攻速/施法速度 | 相乘 | 没有「多职业叠加」问题，都是自己身上的效果 |
 * | 闪避/招架/格挡 | 加算 | 本来就是概率，加算最直观 |
 * | 最大生命 | 相乘 | 只有形态切换会改它，不存在叠加 |
 */
export const aggregateModifiers = (
  sources: readonly (AuraModifiers | undefined)[],
): EffectiveModifiers => {
  const out = neutralModifiers();

  // 分组收集，最后统一按各自规则合并
  let strongestSlow = 1; // < 1，取最小
  let strongestHaste = 1; // > 1，取最大
  let strongestDamageReduction = 1; // < 1，取最小
  let damageAmplification = 1; // > 1，相乘
  let strongestHealingReduction = 1; // < 1，取最小
  let healingAmplification = 1; // > 1，相乘

  for (const m of sources) {
    if (!m) continue;

    if (m.moveSpeed !== undefined) {
      if (m.moveSpeed < 1) strongestSlow = Math.min(strongestSlow, m.moveSpeed);
      else if (m.moveSpeed > 1) strongestHaste = Math.max(strongestHaste, m.moveSpeed);
    }
    if (m.moveSpeedFloor !== undefined) {
      out.moveSpeedFloor = Math.max(out.moveSpeedFloor, m.moveSpeedFloor);
    }

    if (m.damageTaken !== undefined) {
      if (m.damageTaken < 1) strongestDamageReduction = Math.min(strongestDamageReduction, m.damageTaken);
      else if (m.damageTaken > 1) damageAmplification *= m.damageTaken;
    }
    if (m.damageTakenBySchool) {
      for (const [school, v] of Object.entries(m.damageTakenBySchool)) {
        if (v === undefined) continue;
        const s = school as School;
        const cur = out.damageTakenBySchool[s] ?? 1;
        // 与全局同理：减伤取最强，增伤相乘
        out.damageTakenBySchool[s] = v < 1 ? Math.min(cur, v) : cur * v;
      }
    }

    if (m.healingTaken !== undefined) {
      if (m.healingTaken < 1) strongestHealingReduction = Math.min(strongestHealingReduction, m.healingTaken);
      else if (m.healingTaken > 1) healingAmplification *= m.healingTaken;
    }

    if (m.damageDealt !== undefined) out.damageDealt *= m.damageDealt;
    if (m.healingDone !== undefined) out.healingDone *= m.healingDone;
    if (m.attackSpeed !== undefined) out.attackSpeed *= m.attackSpeed;
    if (m.castSpeed !== undefined) out.castSpeed *= m.castSpeed;
    if (m.healCastSpeed !== undefined) out.healCastSpeed *= m.healCastSpeed;
    if (m.knockbackTaken !== undefined) out.knockbackTaken *= m.knockbackTaken;
    if (m.ccDurationTaken !== undefined) out.ccDurationTaken *= m.ccDurationTaken;
    if (m.ccDurationDealt !== undefined) out.ccDurationDealt *= m.ccDurationDealt;
    if (m.resourceGain !== undefined) out.resourceGain *= m.resourceGain;
    if (m.maxHealth !== undefined) out.maxHealth *= m.maxHealth;
    if (m.absorbDone !== undefined) out.absorbDone *= m.absorbDone;

    if (m.dodgeFront !== undefined) out.dodgeFront += m.dodgeFront;
    if (m.parry !== undefined) out.parry += m.parry;
    if (m.block !== undefined) out.block += m.block;
  }

  out.moveSpeed = strongestSlow * strongestHaste;
  out.damageTaken = strongestDamageReduction * damageAmplification;
  out.healingTaken = strongestHealingReduction * healingAmplification;
  return out;
};

/** 某学派的实际承伤系数。未单列的学派回落到全局 damageTaken */
export const damageTakenFor = (m: EffectiveModifiers, school: School): number =>
  m.damageTakenBySchool[school] ?? m.damageTaken;

/**
 * 最终移动速度倍率。
 * 8.3：普通减速不能被战斗意志解除；这里只负责数值，解控在别处。
 * `moveSpeedFloor` 是死亡脚步那类「速度不低于基础值 X%」的个人下限。
 */
export const effectiveMoveSpeed = (m: EffectiveModifiers, globalFloor: number): number =>
  Math.max(m.moveSpeed, m.moveSpeedFloor, globalFloor);
