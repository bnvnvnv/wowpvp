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

import { getArmor, getWeapon } from '../data/index.js';
import type { AuraModifiers } from '../data/schema.js';
import { School } from '../types/enums.js';
import type { ArmorId, WeaponId } from '../types/ids.js';

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
  /** 按学派拆分的控制时长承受乘算。未单列的学派回落到 ccDurationTaken */
  ccDurationTakenBySchool: Partial<Record<School, number>>;
  ccDurationDealt: number;
  dodgeFront: number;
  parry: number;
  block: number;
  resourceGain: number;
  maxHealth: number;
  absorbDone: number;

  /**
   * **只来自装备**的承伤系数。0.92 表示当前武器 + 护甲合计减伤 8%。
   *
   * 单列它不是为了参与结算（它已经乘进 `damageTaken` 里了），而是为了
   * 16.2 的「护甲减少伤害」统计项能算出「这一发伤害里有多少是被装备挡掉的」——
   * 否则只能拿总减伤反推，会把防御技能的功劳记到护甲头上。
   */
  equipmentDamageTaken: number;
  /** 按学派区分的装备承伤系数。抗法护甲只减法术，不能连物理一起记账 */
  equipmentDamageTakenBySchool: Partial<Record<School, number>>;
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
  ccDurationTakenBySchool: {},
  ccDurationDealt: 1,
  dodgeFront: 0,
  parry: 0,
  block: 0,
  resourceGain: 1,
  maxHealth: 1,
  absorbDone: 1,
  equipmentDamageTaken: 1,
  equipmentDamageTakenBySchool: {},
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
 *
 * ★ **装备走 `equipment` 参数，与光环分池。**
 *
 *   上表的「取最强」是为了执行 8.4 / 17.1 的「同类**团队**减伤、加速和治疗增益
 *   不能通过**多职业**重复无限叠加」—— 它防的是几个人往同一个目标身上堆效果。
 *
 *   护甲和武器各只有一件、由本人独占选择，**结构上无法叠加**，所以不适用那条规则。
 *   把它们丢进同一个池子会产生一个很隐蔽的后果：任何一个减伤光环（比如 0.5）
 *   都会把板甲的 0.92 完全盖掉 —— 于是「开了防御技能时护甲不起作用」。
 *   10.8 承诺的横向取舍会在最需要它的那几秒里消失。
 *
 *   因此装备池独立相乘，再与光环池的结果相乘。
 */
export const aggregateModifiers = (
  sources: readonly (AuraModifiers | undefined)[],
  equipment: readonly (AuraModifiers | undefined)[] = [],
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

    applyMultiplicative(out, m);
  }

  // ── 装备池：各字段一律相乘，不参与上面的「取最强」──────────────
  let equipMoveSpeed = 1;
  let equipHealingTaken = 1;
  for (const m of equipment) {
    if (!m) continue;

    if (m.moveSpeed !== undefined) equipMoveSpeed *= m.moveSpeed;
    if (m.damageTaken !== undefined) out.equipmentDamageTaken *= m.damageTaken;
    if (m.healingTaken !== undefined) equipHealingTaken *= m.healingTaken;
    if (m.damageTakenBySchool) {
      for (const [school, v] of Object.entries(m.damageTakenBySchool)) {
        if (v === undefined) continue;
        const s = school as School;
        out.equipmentDamageTakenBySchool[s] = (out.equipmentDamageTakenBySchool[s] ?? 1) * v;
      }
    }

    applyMultiplicative(out, m);
  }

  out.moveSpeed = strongestSlow * strongestHaste * equipMoveSpeed;
  out.damageTaken = strongestDamageReduction * damageAmplification * out.equipmentDamageTaken;
  out.healingTaken = strongestHealingReduction * healingAmplification * equipHealingTaken;

  // 装备的分学派承伤要乘进对应学派的最终系数。
  // ★ 未被光环单列的学派也必须落地，否则抗法护甲对「没人给我上过法术易伤」的
  //   那些学派就白穿了 —— 所以这里以装备的 key 为准补齐，而不是只改已有 key。
  for (const [school, v] of Object.entries(out.equipmentDamageTakenBySchool)) {
    if (v === undefined) continue;
    const s = school as School;
    // 光环若没单列该学派，基准是光环的全局承伤系数
    const auraPart = out.damageTakenBySchool[s] ?? strongestDamageReduction * damageAmplification;
    out.damageTakenBySchool[s] = auraPart * v;
  }
  // 光环单列、装备没列的学派，仍要吃装备的全局减伤
  for (const [school, v] of Object.entries(out.damageTakenBySchool)) {
    if (v === undefined) continue;
    const s = school as School;
    if (out.equipmentDamageTakenBySchool[s] !== undefined) continue;
    out.damageTakenBySchool[s] = v * out.equipmentDamageTaken;
  }

  return out;
};

/**
 * 两个池子共用的字段：本来就是相乘或加算，不存在「取最强」问题。
 * 抽出来是为了让装备池不必抄一遍 —— 抄一遍迟早会漏掉新加的字段。
 */
const applyMultiplicative = (out: EffectiveModifiers, m: AuraModifiers): void => {
  if (m.moveSpeedFloor !== undefined) {
    out.moveSpeedFloor = Math.max(out.moveSpeedFloor, m.moveSpeedFloor);
  }
  if (m.damageDealt !== undefined) out.damageDealt *= m.damageDealt;
  if (m.healingDone !== undefined) out.healingDone *= m.healingDone;
  if (m.attackSpeed !== undefined) out.attackSpeed *= m.attackSpeed;
  if (m.castSpeed !== undefined) out.castSpeed *= m.castSpeed;
  if (m.healCastSpeed !== undefined) out.healCastSpeed *= m.healCastSpeed;
  if (m.knockbackTaken !== undefined) out.knockbackTaken *= m.knockbackTaken;
  if (m.ccDurationTaken !== undefined) out.ccDurationTaken *= m.ccDurationTaken;
    if (m.ccDurationTakenBySchool) {
      for (const [school, v] of Object.entries(m.ccDurationTakenBySchool)) {
        if (v === undefined) continue;
        const s2 = school as School;
        // ★ 与 damageTakenBySchool 同一套聚合语义：削减取最强，延长相乘
        const cur = out.ccDurationTakenBySchool[s2] ?? 1;
        out.ccDurationTakenBySchool[s2] = v < 1 ? Math.min(cur, v) : cur * v;
      }
    }
  if (m.ccDurationDealt !== undefined) out.ccDurationDealt *= m.ccDurationDealt;
  if (m.resourceGain !== undefined) out.resourceGain *= m.resourceGain;
  if (m.maxHealth !== undefined) out.maxHealth *= m.maxHealth;
  if (m.absorbDone !== undefined) out.absorbDone *= m.absorbDone;

  if (m.dodgeFront !== undefined) out.dodgeFront += m.dodgeFront;
  if (m.parry !== undefined) out.parry += m.parry;
  if (m.block !== undefined) out.block += m.block;
};

/**
 * 当前装备贡献的修正。10.6：默认武器/护甲也算装备 —— 它们同样有 modifiers。
 *
 * ★ 返回数组而不是合并结果，是为了让它只能被喂给 `aggregateModifiers` 的
 *   `equipment` 参数，而不会被误当成一份「已经聚合好的修正」直接用。
 */
export const equipmentModifiersOf = (
  weaponId: WeaponId,
  armorId: ArmorId,
): readonly (AuraModifiers | undefined)[] => [
  getWeapon(weaponId)?.modifiers,
  getArmor(armorId)?.modifiers,
];

/** 某学派的实际承伤系数。未单列的学派回落到全局 damageTaken */
export const damageTakenFor = (m: EffectiveModifiers, school: School): number =>
  m.damageTakenBySchool[school] ?? m.damageTaken;

/**
 * 某学派的实际控制时长系数（10.8）。未单列的学派回落到全局 `ccDurationTaken`。
 *
 * ★ 学派未知（例如光环周期跳施加的控制）时调用方传 undefined，
 *   于是回落到全局值 —— 与旧行为完全一致，不会因为「查不到学派」而漏掉减免。
 */
export const ccDurationTakenFor = (
  m: EffectiveModifiers,
  school: School | undefined,
): number =>
  (school !== undefined ? m.ccDurationTakenBySchool[school] : undefined) ?? m.ccDurationTaken;

/**
 * 某学派**只来自装备**的承伤系数。供 16.2「护甲减少伤害」记账。
 *
 * 有了它就能把一发伤害拆成「装备挡掉的」和「防御技能挡掉的」两部分：
 * 已结算的伤害 d 对应的无装备伤害是 d / f，装备挡掉了 d × (1/f − 1)。
 */
export const equipmentDamageTakenFor = (m: EffectiveModifiers, school: School): number =>
  m.equipmentDamageTakenBySchool[school] ?? m.equipmentDamageTaken;

/**
 * 最终移动速度倍率。
 * 8.3：普通减速不能被战斗意志解除；这里只负责数值，解控在别处。
 * `moveSpeedFloor` 是死亡脚步那类「速度不低于基础值 X%」的个人下限。
 */
export const effectiveMoveSpeed = (m: EffectiveModifiers, globalFloor: number): number =>
  Math.max(m.moveSpeed, m.moveSpeedFloor, globalFloor);
