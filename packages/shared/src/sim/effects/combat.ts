/**
 * 伤害、治疗、光环、控制。规格书 8.x，验收 #23。
 *
 * 这里是整个战斗最终「落到数字上」的地方，几条容易做错的规则：
 *   · 完全免疫要挡住伤害，但**竞技场压迫伤害必须绕过它**（8.5 / 验收 #27）
 *   · 吸收护盾先于生命扣减，破裂要单独发事件（14.3）
 *   · 普通伤害**不打断施法**，但会累计到「受伤解除」的阈值上（8.2）
 *   · 控制要过递减，免疫时不推进计数（8.2）
 *   · 治疗与吸收受竞技场战斗抑制影响（8.5）
 */

import { getSkill, getWeapon } from '../../data/index.js';
import type { AuraDef, EffectDef, Magnitude } from '../../data/schema.js';
import { DrCategory, School } from '../../types/enums.js';
import { asSkillId } from '../../types/ids.js';
import {
  applyAura,
  applyDamageToBreakables,
  aurasOf,
  clearByTrinket,
  consumeAbsorb,
  dispel as dispelAuras,
  effectiveModifiersOf,
  impairsMovement,
  removeAuraById,
  type AuraStore,
} from '../aura.js';
import { applyDr, onControlEndedEarly, type DrStore } from '../dr.js';
import { gainResource, spendResource, type CombatEntity } from '../entity.js';
import { ccDurationTakenFor, damageTakenFor, equipmentDamageTakenFor } from '../modifiers.js';
import { isBehind } from '../../math/geometry.js';
import { applyInterrupt } from '../interrupt.js';
import { registerEffect, type CombatEvent, type EffectContext } from './registry.js';
import { nextRandom, type World } from '../world.js';
import { CRIT } from '../../constants/combat.js';

// ── 数值换算 ─────────────────────────────────────────────────────

/** 把 Magnitude 换算成具体数值。武器百分比按施法者当前武器计算 */
export const magnitudeOf = (m: Magnitude, source: CombatEntity): number => {
  let v = m.flat ?? 0;
  if (m.weaponPercent !== undefined) {
    const w = getWeapon(source.weaponId);
    // 首版属性标准化，武器伤害直接用「单击百分比 × 100」作为基准值
    const weaponBase = (w?.swingPercent ?? 1) * 100;
    v += weaponBase * m.weaponPercent;
  }
  if (m.powerCoef !== undefined) v += m.powerCoef * 100;
  return v;
};

/**
 * 8.5 竞技场战斗抑制。由回合系统每 tick 设置，效果层只读它。
 * 放在这里而不是 world 上，是因为它只影响治疗与吸收，不影响伤害。
 */
export interface DampeningState {
  /** 0 ~ 0.9，表示治疗与吸收降低的比例 */
  amount: number;
}
export const NO_DAMPENING: DampeningState = { amount: 0 };

/** 当前抑制。M5 回合系统接管后由它写入 */
let dampening: DampeningState = NO_DAMPENING;
export const setDampening = (d: DampeningState): void => {
  dampening = d;
};
export const getDampening = (): DampeningState => dampening;

// ── 伤害 ─────────────────────────────────────────────────────────

export interface DamageOptions {
  /** 8.5：竞技场压迫伤害必须绕过完全免疫（验收 #27）*/
  bypassImmunity?: boolean;
  /** 背后攻击加成 */
  behindBonus?: number;
  /**
   * 这一发能不能暴击。默认能。
   * false 的两处：周期跳（DoT / 地面 tick，由 ctx.periodic 推出）
   * 与 8.5 竞技场压迫伤害 —— 压迫伤害是**赛制机制**不是攻击，
   * 让它暴击等于让赛制随机。
   */
  canCrit?: boolean;
}

/**
 * 结算一次伤害。返回实际造成的生命扣减。
 *
 * ★ 这个函数**不打断施法**。7.3 / 验收 #14：普通伤害默认不停止也不延长施法。
 *   打断走 interrupt.ts，控制走各自的效果处理器。
 */
export const dealDamage = (
  ctx: EffectContext,
  target: CombatEntity,
  rawAmount: number,
  school: School,
  opts: DamageOptions = {},
): number => {
  if (!target.alive || rawAmount <= 0) return 0;

  /**
   * ★★ 攻击解除**自己的**潜行（9.4 / 潜行光环的说明原文：
   *   「攻击、受到伤害或被近距离发现会解除」）。
   *
   *   在此之前**全仓库没有任何实现移除潜行光环** —— 又一条「写在数据里、
   *   没人实现」：盗贼从潜行中攻击后**仍然隐身**，对手永远无法选中他
   *   （验收 #5 的不可选中是对的，错在潜行永不结束）。配平基线里
   *   盗贼因此把所有不会治疗的职业单方面磨死（对手整场 0 伤害）。
   *
   * ★ `!ctx.periodic`：自己**过去**挂的 DoT 跳伤不破自己的新潜行 ——
   *   否则毒刃 12 秒 DoT 期间遁形永远无效，「遁形」这个技能等于不存在。
   *   受害者侧（下方）不受此限：被任何伤害打到都解除潜行。
   */
  if (!ctx.periodic) breakStealthOf(ctx, ctx.source);

  const flags = target.flags;
  const fullyImmune = flags.immuneAll && !opts.bypassImmunity;
  const schoolImmune =
    (school === School.Physical && flags.immunePhysical) ||
    (school !== School.Physical && flags.immuneMagic);

  if (fullyImmune || (schoolImmune && !opts.bypassImmunity)) {
    ctx.events.push({
      t: 'damage', sourceId: ctx.source.id, targetId: target.id,
      amount: 0, school, absorbed: 0, overkill: 0, immune: true,
      skillId: ctx.skillId, preventedByEquipment: 0,
    });
    return 0;
  }

  // 攻击方的输出修正（casterScoped 的易伤在这里生效）
  const attackerMods = effectiveModifiersOf(ctx.auras, ctx.source, ctx.world.time);
  const targetMods = effectiveModifiersOf(ctx.auras, target, ctx.world.time, ctx.source.id);

  /**
   * ★★ 8.x 闪避 / 招架 / 格挡（M11 实现）。
   *
   *   `AuraModifiers.dodgeFront` / `parry` / `block` 从 M0 就在 schema 里，
   *   护甲与武器数据也在用它们（剑盾「正面格挡 20%」、匕首「招架 +15%」、
   *   盗贼闪避「5 秒内正面闪避提高 50%」）—— 但 `combat.ts` 里
   *   **从来没有任何闪避判定**，这三个字段一直是死数据。
   *
   * ★ 三条都只对**物理**生效。规格书 9.x 闪避那条原话：「法术不受影响」。
   * ★ 闪避与格挡是**正面**的（`dodgeFront` 的字段名就写着），
   *   背刺因此绕过它们 —— 这与 6.5 的背后攻击加成是同一条空间逻辑。
   */
  const avoided = rollAvoidance(ctx, target, school, targetMods);
  if (avoided) {
    ctx.events.push({
      t: 'damage', sourceId: ctx.source.id, targetId: target.id,
      amount: 0, school, absorbed: 0, overkill: 0, immune: false,
      skillId: ctx.skillId, preventedByEquipment: 0, avoided,
    });
    // ★ 招架要记时刻 —— 9.x 反击刺「近期发生过招架」靠它（ConditionDef.recentlyParried）
    if (avoided === 'parry') target.lastParryAt = ctx.world.time;
    ctx.source.lastCombatAt = ctx.world.time;
    target.lastCombatAt = ctx.world.time;
    return 0;
  }

  /**
   * ★ 暴击掷骰的位置是刻意的（docs/03「暴击」小节的结算顺序）：
   *   在规避**之后** —— 被闪掉的一发不掷骰（不消耗攻击者的随机数）；
   *   在吸收**之前** —— 护盾要按暴击后的量消耗，否则「暴击被小盾
   *   完全吃掉」会读成没暴击；
   *   在 `Math.round` **之前** —— 先乘后取整，避免二次舍入。
   */
  /**
   * P7：几率 = 基础 10% + 攻击方修正（匕首/进攻甲/义愤…），夹在 [0, 上限]；
   * 倍率 = 1.5 × 攻击方 critDamage（大剑/长弓的「一击更重」）。
   * 修正为 0/1（绝大多数实体）时与旧行为逐位一致。
   */
  const critChance = Math.min(
    CRIT.MAX_CHANCE, Math.max(0, CRIT.BASE_CHANCE + attackerMods.critChance),
  );
  const crit = (opts.canCrit ?? true) && rollCrit(ctx.source, critChance);

  let amount =
    rawAmount *
    (crit ? CRIT.DAMAGE_MULTIPLIER * attackerMods.critDamage : 1) *
    attackerMods.damageDealt *
    damageTakenFor(targetMods, school);

  // 背刺加成（6.5：攻击者位于目标背后约 120 度）
  if (opts.behindBonus && isBehind(ctx.source.position, target.position, target.yaw)) {
    amount *= 1 + opts.behindBonus;
  }
  amount = Math.max(0, Math.round(amount));

  // 16.2「护甲减少伤害」：装备已经乘进 amount 里了，这里反推它挡掉了多少。
  // 用装备**单独**的系数而不是总减伤，才不会把防御技能的功劳记给护甲。
  const equipFactor = equipmentDamageTakenFor(targetMods, school);
  const preventedByEquipment =
    equipFactor > 0 ? Math.max(0, Math.round(amount / equipFactor - amount)) : 0;

  // 吸收护盾先吃（14.3）
  const { absorbed, remaining, broken, byShieldSource } = consumeAbsorb(
    ctx.auras, target.id, amount, school,
  );
  for (const b of broken) {
    ctx.events.push({ t: 'shieldBroken', targetId: target.id, auraId: b.def.id });
  }

  /**
   * ★★ 战斗状态（脱战判定的唯一来源）。
   *   规格书 9.x：潜行「脱战 4 秒后 1 秒进入」、猎豹形态「脱战可潜行」——
   *   而在 M11 之前**没有任何地方记录它**，`ConditionDef.outOfCombat`
   *   因此是一条永远判不出来的条件。
   *   ★ **攻击者与被攻击者都进战斗** —— 只标记被打的人的话，
   *     打完就潜行的偷袭会完全不受限制。
   */
  ctx.source.lastCombatAt = ctx.world.time;
  target.lastCombatAt = ctx.world.time;

  const before = target.health;
  target.health = Math.max(0, target.health - remaining);
  const dealt = before - target.health;
  const overkill = Math.max(0, remaining - before);

  // ★ 受到伤害解除**目标的**潜行（含被护盾吸收的 —— 挨了一下就是挨了一下）
  if (dealt > 0 || absorbed > 0) breakStealthOf(ctx, target);

  ctx.events.push({
    t: 'damage', sourceId: ctx.source.id, targetId: target.id,
    amount: dealt, school, absorbed, overkill, immune: false,
    skillId: ctx.skillId, preventedByEquipment,
    ...(byShieldSource.length > 0 ? { absorbedBy: byShieldSource } : {}),
    ...(crit ? { crit: true } : {}),
  });

  // 8.2：受到一定伤害可提前解除恐惧/变形/定身
  if (remaining > 0) {
    for (const r of applyDamageToBreakables(ctx.auras, target.id, remaining)) {
      ctx.events.push({ t: 'auraRemoved', targetId: target.id, auraId: r.aura.def.id, reason: 'broken' });
      const cat = drCategoryOfAura(r.aura.def);
      if (cat) onControlEndedEarly(ctx.dr, target.id, cat, ctx.world.time);
    }
  }

  if (target.health <= 0 && target.alive) {
    target.alive = false;
    ctx.events.push({ t: 'death', targetId: target.id, killerId: ctx.source.id });
  }
  return dealt;
};

const drCategoryOfAura = (def: AuraDef): DrCategory | undefined => def.drCategory;

/**
 * 解除一个实体身上的全部潜行光环（按 `flags.stealthed` 识别，不硬编码光环 id）。
 * 立即同步实体标志 —— `deriveStatusFlags` 在 tick 第 6 步才跑，
 * 不同步的话同一 tick 内后续的选中/命中判定还会把他当隐身。
 */
const breakStealthOf = (ctx: EffectContext, entity: CombatEntity): void => {
  if (!entity.flags.stealthed) return;
  for (const a of [...aurasOf(ctx.auras, entity.id)]) {
    if (a.def.flags?.stealthed !== true) continue;
    for (const r of removeAuraById(ctx.auras, entity.id, a.def.id, 'broken')) {
      ctx.events.push({
        t: 'auraRemoved', targetId: entity.id, auraId: r.aura.def.id, reason: 'broken',
      });
    }
  }
  entity.flags.stealthed = false;
};

/** 一次伤害被完全规避的方式。8.x / 815 行：命中反馈要能区分它们 */
export type Avoidance = 'dodge' | 'parry' | 'block';

/**
 * 掷一次规避判定。命中则返回 undefined。
 *
 * ★ 判定顺序 闪避 → 招架 → 格挡 是**固定**的，不是偏好：
 *   顺序决定了几率如何叠加（先掷的吃掉后面的空间），换顺序会改变实际数值。
 *   固定下来才能配平。
 *
 * ⚠️ 用 `nextRandom(target)` 而不是 `Math.random()`：
 *   随机流挂在**被攻击者**身上 —— 闪避/招架/格挡都是**他**的能力，
 *   掷骰归他管。这样攻击方新增任何随机判定都不会扰动他的序列。
 */
const rollAvoidance = (
  ctx: EffectContext,
  target: CombatEntity,
  school: School,
  mods: { dodgeFront: number; parry: number; block: number },
): Avoidance | undefined => {
  // 9.x 闪避原话：「法术不受影响」。招架与格挡同理，都是物理动作
  if (school !== School.Physical) return undefined;
  // 无法行动时谈不上闪避/招架（7.3）
  if (target.flags.stunned || target.flags.feared || !target.alive) return undefined;

  // ★ 正面才闪避/格挡：背后攻击绕过它们（6.5 的空间逻辑）
  const fromBehind = isBehind(ctx.source.position, target.position, target.yaw);

  if (!fromBehind && mods.dodgeFront > 0 && nextRandom(target) < mods.dodgeFront) return 'dodge';
  if (mods.parry > 0 && nextRandom(target) < mods.parry) return 'parry';
  if (!fromBehind && mods.block > 0 && nextRandom(target) < mods.block) return 'block';
  return undefined;
};

/**
 * 掷一次暴击（docs/10 已知偏差 #7 —— 规格书没有这条机制）。
 *
 * ⚠️ 用 `nextRandom(attacker)` —— 与闪避正好相反：
 *   闪避是**被攻击者**的能力，暴击是**攻击者**的能力，各掷各的流。
 *   这样两边新增随机判定都不会互相扰动，回放与 balance-report 才可复现。
 *
 * ★ **只在这一发确实要落到数字上时才掷**：免疫和被规避的那一发
 *   **不消耗**攻击者的随机数。否则「对面开了圣盾术」会改变我后续
 *   全部暴击的序列，同一份录像换个防御技能就重放不出来了。
 *
 * ★ 周期跳（DoT/HoT/地面 tick）不暴击：
 *   一个 12 秒 DoT 要掷 6 次骰子，方差会被周期数摊平成噪音 ——
 *   玩家既读不到「这一跳暴了」的瞬间，配平还要为它建模。
 *   暴击的全部价值在「一击的重量」，只给一击式的结算。
 */
export const rollCrit = (
  attacker: { rng: number },
  chance: number = CRIT.BASE_CHANCE,
): boolean => chance > 0 && nextRandom(attacker) < chance;

// ── 治疗 ─────────────────────────────────────────────────────────

export const dealHeal = (
  ctx: EffectContext,
  target: CombatEntity,
  rawAmount: number,
  opts: { canCrit?: boolean } = {},
): number => {
  if (!target.alive || rawAmount <= 0) return 0;

  const casterMods = effectiveModifiersOf(ctx.auras, ctx.source, ctx.world.time);
  const targetMods = effectiveModifiersOf(ctx.auras, target, ctx.world.time);

  // 暴击乘在 dampening 之前：暴击是施法者的能力，抑制是赛制的削减
  //（顺序不影响数值，但语义要清楚）。HoT 周期跳不暴击，同 rollCrit 注释。
  // P7：几率与倍率修正与伤害同轴（义愤期间治疗也爱暴）
  const critChance = Math.min(
    CRIT.MAX_CHANCE, Math.max(0, CRIT.BASE_CHANCE + casterMods.critChance),
  );
  const crit = (opts.canCrit ?? true) && rollCrit(ctx.source, critChance);

  // 8.5：治疗受竞技场战斗抑制影响
  const amount = Math.max(
    0,
    Math.round(
      rawAmount * (crit ? CRIT.HEAL_MULTIPLIER * casterMods.critDamage : 1) *
        casterMods.healingDone * targetMods.healingTaken * (1 - dampening.amount),
    ),
  );

  const before = target.health;
  target.health = Math.min(target.maxHealth, target.health + amount);
  const healed = target.health - before;

  ctx.events.push({
    t: 'heal', sourceId: ctx.source.id, targetId: target.id,
    amount: healed, overheal: amount - healed,
    ...(crit ? { crit: true } : {}),
  });
  return healed;
};

// ── 控制 ─────────────────────────────────────────────────────────

/** 各控制效果对应的递减类别与光环模板 */
const CONTROL_SPECS = {
  stun: { category: DrCategory.Stun, name: '昏迷', flags: { stunned: true }, clearable: true },
  incapacitate: { category: DrCategory.Incapacitate, name: '迷惑', flags: { stunned: true }, clearable: true },
  fear: { category: DrCategory.Incapacitate, name: '恐惧', flags: { feared: true }, clearable: true },
  root: { category: DrCategory.Root, name: '定身', flags: { rooted: true }, clearable: true },
  silence: { category: DrCategory.Silence, name: '沉默', flags: { silenced: true }, clearable: false },
  disarm: { category: undefined, name: '缴械', flags: { disarmed: true }, clearable: false },
} as const;

type ControlKind = keyof typeof CONTROL_SPECS;

/**
 * 控制效果 kind → 递减类别。**从 `CONTROL_SPECS` 派生**，不是第二份表。
 *
 * ★ 给 AI 用的：bot 出控制前要查目标该类别的递减层数（半衰以下不浪费），
 *   它需要知道「fear 走 Incapacitate 链」这类事实 —— 这类事实只能有一个
 *   出处。缴械（disarm）不参与递减，映射里没有它，AI 侧按 undefined 处理。
 */
export const CONTROL_DR_CATEGORY: Readonly<
  Partial<Record<ControlKind, DrCategory>>
> = Object.fromEntries(
  Object.entries(CONTROL_SPECS)
    .filter(([, spec]) => spec.category !== undefined)
    .map(([kind, spec]) => [kind, spec.category]),
);

/**
 * 施加一个控制效果。统一走递减（8.2）与免疫检查（8.4）。
 *
 * ★ 8.3：战斗意志能解除昏迷、恐惧、迷惑、变形、定身，
 *   **不能**解除沉默 —— 所以 silence 与 disarm 的 clearable 是 false。
 */
export const applyControl = (
  ctx: EffectContext,
  target: CombatEntity,
  kind: ControlKind,
  baseDuration: number,
  breakDamage?: number,
): void => {
  const spec = CONTROL_SPECS[kind];

  // 8.4 免疫检查
  if (target.flags.immuneAll) {
    ctx.events.push({ t: 'immune', targetId: target.id, why: 'flag' });
    return;
  }
  /**
   * 8.4「免疫新的减速与定身」的**定身那一半**（减速那一半在 applyAura 处理器）。
   *
   * ★ 只对 `root` 生效**不是遗漏**：`CONTROL_SPECS` 里限制移动的只有定身，
   *   昏迷/恐惧/迷惑/沉默不属于「移动限制」—— 自由庇佑挡不住裁决之锤，
   *   这与 8.3 的分工（战斗意志才是通用解控）一致。两个旗标语义相同
   *   （剑刃风暴 vs 自由庇佑各写了一个），合成一条判断，别再各写各的。
   */
  if (kind === 'root' && (target.flags.immuneSlowAndRoot || target.flags.immuneMovementImpair)) {
    ctx.events.push({ t: 'immune', targetId: target.id, why: 'flag' });
    return;
  }

  // 抗控型护甲：控制持续时间降低（10.8）
  const targetMods = effectiveModifiersOf(ctx.auras, target, ctx.world.time);
  const casterMods = effectiveModifiersOf(ctx.auras, ctx.source, ctx.world.time);
  /**
   * ★★ 控制的学派来自**技能**，不是效果本身 —— 控制类 `EffectDef` 里没有
   *   school 字段（`schema.ts`）。所以从 `ctx.skillId` 反查 `SkillDef.school`。
   *
   * ★ 查不到就是 undefined（光环周期跳、投射物二段效果等），
   *   `ccDurationTakenFor` 会回落到全局系数 —— 与加这个字段之前的行为一致。
   */
  const school = getSkill(asSkillId(ctx.skillId))?.school;
  let duration =
    baseDuration * ccDurationTakenFor(targetMods, school) * casterMods.ccDurationDealt;

  // 8.2 控制递减
  let drFactor = 1;
  if (spec.category) {
    const r = applyDr(ctx.dr, target.id, spec.category, duration, ctx.world.time);
    if (r.immune) {
      ctx.events.push({ t: 'immune', targetId: target.id, why: 'dr' });
      return;
    }
    duration = r.duration;
    drFactor = r.factor;
  }

  const def: AuraDef = {
    id: `control.${kind}`,
    name: spec.name,
    kind: 'debuff',
    duration,
    dispelType: kind === 'silence' || kind === 'disarm' ? 'none' : 'magic',
    drCategory: spec.category,
    clearableByTrinket: spec.clearable,
    flags: { ...spec.flags },
    ...(breakDamage !== undefined ? { breakOnDamage: { threshold: breakDamage } } : {}),
    // ★ 纯表现：让「是什么冻住了你」能被读出来（见 AuraDef.school）。
    //   规则层不读它 —— 上面的 ccDurationTakenFor 用的是同一个局部变量。
    ...(school !== undefined ? { school } : {}),
    description: `${spec.name} ${duration.toFixed(1)} 秒`,
  };

  applyAura(ctx.auras, target, def, ctx.source.id, ctx.world.time, { duration });
  ctx.events.push({
    t: 'auraApplied', sourceId: ctx.source.id, targetId: target.id,
    auraId: def.id, duration, drFactor,
    auraKind: def.kind, drCategory: def.drCategory,
  });
};

// ── 处理器注册 ───────────────────────────────────────────────────

registerEffect('damage', (ctx, e, targets) => {
  const raw = magnitudeOf(e.amount, ctx.source);
  for (const t of targets) {
    // 周期跳（ctx.periodic 由 tick.ts 的光环/地面 tick 标记）不暴击
    dealDamage(ctx, t, raw, e.school, { behindBonus: e.behindBonus, canCrit: !ctx.periodic });
  }
});

registerEffect('heal', (ctx, e, targets) => {
  const raw = magnitudeOf(e.amount, ctx.source);
  for (const t of targets) dealHeal(ctx, t, raw, { canCrit: !ctx.periodic });
});

registerEffect('healPercentMaxHealth', (ctx, e, targets) => {
  for (const t of targets) dealHeal(ctx, t, t.maxHealth * e.percent, { canCrit: !ctx.periodic });
});

registerEffect('healFromRecentDamage', (ctx, e) => {
  /**
   * ★★ 治疗对象是**施法者**，不是 targets —— 汲血斩「根据（自己）近期承受
   *   的伤害恢复生命」。
   *
   * ⚠️ P4b 全量冒烟抓到的真 bug：此前这里 `for (const t of targets)`，
   *   而汲血斩的 targets 是**被打的敌人** —— 效果变成了「按敌人的已损血量
   *   给敌人回血」。对满血敌人回 0，所以自 M4 落地以来没人肉眼看出来；
   *   对残血敌人则是死骑一刀反向奶对面。全仓库此前对这个效果零测试覆盖，
   *   正是「规则写对了没人调」的又一例（这次是「调了但对象错了」）。
   */
  const t = ctx.source;
  // 近期承受伤害由 world 记录（M4 暂用最大生命的固定比例近似），
  // 上限由技能定义保证（死亡打击「治疗有上限」）
  const cap = t.maxHealth * e.maxPercentOfMaxHealth;
  const recent = Math.min(cap, (t.maxHealth - t.health) * e.percentOfDamageTaken);
  dealHeal(ctx, t, Math.min(cap, recent), { canCrit: !ctx.periodic });
});

registerEffect('applyAura', (ctx, e, targets) => {
  const list = e.target === 'self' ? [ctx.source] : targets;
  for (const t of list) {
    // 8.4：完全免疫挡住新的负面光环
    if (e.aura.kind === 'debuff' && t.flags.immuneAll) {
      ctx.events.push({ t: 'immune', targetId: t.id, auraId: e.aura.id, why: 'flag' });
      continue;
    }
    /**
     * ★★ 8.4「免疫新的减速与定身」（自由庇佑 / 剑刃风暴）的**减速那一半**。
     *
     *   两个旗标此前只在 `applyControl` 的 `root` 分支被读过，而**减速根本
     *   不走 applyControl** —— 它是一枚带 `modifiers.moveSpeed` 的普通光环，
     *   走的就是这个处理器。于是「3 秒内免疫新的减速」对全仓库每一条减速
     *   （寒冷、断腿斩、毒刃、寒缚链……）一次都没有生效过：数据在、说明在、
     *   跑起来是空的 —— 与寒缚链 decay、疾行步 moveSpeedFloor 同族的静默失效。
     *   X13 把寒冷改成「瞬发零冷却每 GCD 刷新」之后这条洞变成决定性的：
     *   技能说明把自由祝福当作反制手段卖给玩家，实际按下去什么都没挡住。
     *
     * ★ 判据复用 `aura.ts` 的 `impairsMovement`（减速 ∪ 定身），与自由庇佑
     *   自己那半边 `dispel(impairs:'movement')` **同一条谓词** ——
     *   「解得掉的」与「挡得住的」必须是同一个集合。
     * ★ 只挡减益：形态类自我减速（buff）与「解除后再上」的自己人光环不受影响。
     */
    if (
      e.aura.kind === 'debuff' &&
      (t.flags.immuneMovementImpair || t.flags.immuneSlowAndRoot) &&
      impairsMovement(e.aura)
    ) {
      ctx.events.push({ t: 'immune', targetId: t.id, auraId: e.aura.id, why: 'flag' });
      continue;
    }
    // 8.2：带递减类别的光环要过递减
    let duration = e.aura.duration;
    let drFactor = 1;
    if (e.aura.drCategory) {
      const r = applyDr(ctx.dr, t.id, e.aura.drCategory, duration, ctx.world.time);
      if (r.immune) {
        ctx.events.push({ t: 'immune', targetId: t.id, auraId: e.aura.id, why: 'dr' });
        continue;
      }
      duration = r.duration;
      drFactor = r.factor;
    }
    applyAura(ctx.auras, t, e.aura, ctx.source.id, ctx.world.time, { duration });
    ctx.events.push({
      t: 'auraApplied', sourceId: ctx.source.id, targetId: t.id,
      auraId: e.aura.id, duration, drFactor,
      auraKind: e.aura.kind, drCategory: e.aura.drCategory,
    });
  }
});

registerEffect('removeAura', (ctx, e, targets) => {
  for (const t of targets) {
    for (const id of e.auraIds) {
      for (const r of removeAuraById(ctx.auras, t.id, id, 'cancelled')) {
        ctx.events.push({ t: 'auraRemoved', targetId: t.id, auraId: r.aura.def.id, reason: 'cancelled' });
      }
    }
  }
});

registerEffect('stun', (ctx, e, targets) => {
  for (const t of targets) applyControl(ctx, t, 'stun', e.duration);
});
registerEffect('incapacitate', (ctx, e, targets) => {
  for (const t of targets) applyControl(ctx, t, 'incapacitate', e.duration, e.breakDamage);
});
registerEffect('fear', (ctx, e, targets) => {
  for (const t of targets) applyControl(ctx, t, 'fear', e.duration, e.breakDamage);
});
registerEffect('root', (ctx, e, targets) => {
  for (const t of targets) applyControl(ctx, t, 'root', e.duration, e.breakDamage);
});
registerEffect('silence', (ctx, e, targets) => {
  for (const t of targets) applyControl(ctx, t, 'silence', e.duration);
});
registerEffect('disarm', (ctx, e, targets) => {
  for (const t of targets) applyControl(ctx, t, 'disarm', e.duration);
});

/**
 * 7.2 专用打断。
 *
 * ★ 复用 M2 的 `applyInterrupt`，**不在这里另写一份结算** ——
 *   学派锁定、物理射击不锁学派、不可打断技能这三条规则只有一个实现处。
 *
 * ⚠️ 冷却仍由**调用方**负责：7.2 规定落空也进冷却，而效果层看不到「技能落空」
 *   这个概念（它只在效果被结算时才被调用）。casting 的成功路径无条件写冷却，
 *   所以这条规则在那里已经成立。
 */
registerEffect('interrupt', (ctx, e, targets) => {
  const store = ctx.castingStore;
  if (!store) return;
  for (const t of targets) {
    const out = applyInterrupt(ctx.world, store, t, e.schoolLockSeconds);
    // ★ 落空也发事件。16.1 要统计「打断成功率」，只发成功的话没有分母 ——
    //   而「打断落空」正是 7.5 假读条博弈的结果，是这条统计最该反映的东西。
    ctx.events.push({
      t: 'interrupt', sourceId: ctx.source.id, targetId: t.id,
      success: out.interrupted,
      ...(out.schoolLock
        ? { school: out.schoolLock.school, lockedUntil: out.schoolLock.until }
        : {}),
      ...(out.reason ? { reason: out.reason } : {}),
    });
  }
});

registerEffect('dispel', (ctx, e, targets) => {
  for (const t of targets) {
    const hostile = t.team !== ctx.source.team;
    // 对敌人驱散增益，对友方驱散减益 —— 由目标阵营决定，不是由 from 字段决定，
    // 因为一个 targetFilter: Any 的技能会同时挂两条 dispel 效果（牧师·驱散魔法）
    if ((e.from === 'enemy') !== hostile) continue;
    const removed = dispelAuras(
      ctx.auras, t.id, { types: e.types, impairs: e.impairs }, e.count,
      hostile ? 'buff' : 'debuff',
      e.canRemoveImmunity,
    );
    for (const r of removed) {
      const cat = r.aura.def.drCategory;
      ctx.events.push({
        t: 'dispelled', sourceId: ctx.source.id, targetId: t.id, auraId: r.aura.def.id,
        auraKind: r.aura.def.kind, drCategory: cat,
      });
      if (cat) onControlEndedEarly(ctx.dr, t.id, cat, ctx.world.time);
    }
  }
});

registerEffect('gainResource', (ctx, e) => {
  /**
   * ★★ M14：资源永远回到**施法者**身上，无视技能的目标集合。
   *
   *   此前这里跟着 targets 结算 —— 于是冲锋的 +15 怒气、背刺的连击点、
   *   挥击的怒气、十字军打击的圣能，全部落在**敌人**头上：战士全场怒气
   *   趋零（基线 0% 胜率的第二真根因）、盗贼的终结技永远找到 0 连击点
   *   而静默空转、圣骑士的荣耀圣言从来没有施放过（圣能恒 0）。
   *   与 `resolveResourceSpender` 花的是 `ctx.source` 的池子对读 ——
   *   攒在敌人身上、花在自己身上，这对不上的账没有任何测试对过。
   *
   *   数据里全部 9 处 gainResource 的意图无一例外是「自己获得」；
   *   「给目标充能」的设计如果将来出现，那时再加显式的 target 字段。
   */
  gainResource(ctx.source, e.resource, e.amount);
  ctx.events.push({ t: 'resource', targetId: ctx.source.id, resource: e.resource, delta: e.amount });
});

registerEffect('spendComboPoints', (ctx, e, targets) => {
  resolveResourceSpender(ctx, targets, 'comboPoints', e.perPointMultiplier, e.base, e.byPoints);
});

registerEffect('spendResource', (ctx, e, targets) => {
  resolveResourceSpender(ctx, targets, e.resource, e.perPointMultiplier, e.base, e.byPoints, e.max);
});

/**
 * 消耗点数型资源放大效果。
 *
 * `byPoints` 优先于线性 —— schema v1.1 加它就是因为肾击的
 * 「1 点 1 秒 ~ 5 点 3 秒」是仿射而非线性（见 docs/10 的 Q4）。
 */
const resolveResourceSpender = (
  ctx: EffectContext,
  targets: readonly CombatEntity[],
  resource: string,
  perPoint: number,
  base: EffectDef,
  byPoints?: number[],
  max?: number,
): void => {
  const res = resource as Parameters<typeof spendResource>[1];
  const available = ctx.source.resources.get(res) ?? 0;
  const points = Math.min(available, max ?? available);
  if (points <= 0) return;

  const scale = byPoints ? (byPoints[points - 1] ?? points * perPoint) : points * perPoint;
  spendResource(ctx.source, res, points);
  ctx.events.push({ t: 'resource', targetId: ctx.source.id, resource, delta: -points });

  ctx.resolve([scaleEffect(base, scale)], targets);
};

/** 按倍数放大一个效果的数值。只放大伤害/治疗/控制时长这三类可放大的量 */
const scaleEffect = (e: EffectDef, scale: number): EffectDef => {
  switch (e.kind) {
    case 'damage':
      return { ...e, amount: scaleMagnitude(e.amount, scale) };
    case 'heal':
      return { ...e, amount: scaleMagnitude(e.amount, scale) };
    case 'stun':
    case 'incapacitate':
    case 'fear':
    case 'root':
    case 'silence':
    case 'disarm':
      return { ...e, duration: e.duration * scale };
    default:
      return e;
  }
};

const scaleMagnitude = (m: Magnitude, scale: number): Magnitude => ({
  ...(m.flat !== undefined ? { flat: m.flat * scale } : {}),
  ...(m.weaponPercent !== undefined ? { weaponPercent: m.weaponPercent * scale } : {}),
  ...(m.powerCoef !== undefined ? { powerCoef: m.powerCoef * scale } : {}),
});

/**
 * 8.3 通用解控「战斗意志」。不是 EffectDef，由 tick 第 1c 步调用（W8）。
 * ★ 签名只要它真读的三样 —— 它从 M9 写好到 W8 接线一直零调用方，
 *   原先要整个 EffectContext 反而挡住了唯一的调用点。
 */
export const useTrinket = (
  deps: { world: World; auras: AuraStore; dr: DrStore },
  target: CombatEntity,
  events: CombatEvent[],
): boolean => {
  const removed = clearByTrinket(deps.auras, target.id);
  for (const r of removed) {
    events.push({ t: 'auraRemoved', targetId: target.id, auraId: r.aura.def.id, reason: 'trinket' });
    const cat = r.aura.def.drCategory;
    if (cat) onControlEndedEarly(deps.dr, target.id, cat, deps.world.time);
  }
  return removed.length > 0;
};
