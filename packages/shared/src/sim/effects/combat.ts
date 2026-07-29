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

import { getWeapon } from '../../data/index.js';
import type { AuraDef, EffectDef, Magnitude } from '../../data/schema.js';
import { DrCategory, School } from '../../types/enums.js';
import {
  applyAura,
  applyDamageToBreakables,
  clearByTrinket,
  consumeAbsorb,
  dispel as dispelAuras,
  effectiveModifiersOf,
  removeAuraById,
} from '../aura.js';
import { applyDr, onControlEndedEarly } from '../dr.js';
import { gainResource, spendResource, type CombatEntity } from '../entity.js';
import { damageTakenFor } from '../modifiers.js';
import { isBehind } from '../../math/geometry.js';
import { applyInterrupt } from '../interrupt.js';
import { registerEffect, type EffectContext } from './registry.js';

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

  const flags = target.flags;
  const fullyImmune = flags.immuneAll && !opts.bypassImmunity;
  const schoolImmune =
    (school === School.Physical && flags.immunePhysical) ||
    (school !== School.Physical && flags.immuneMagic);

  if (fullyImmune || (schoolImmune && !opts.bypassImmunity)) {
    ctx.events.push({
      t: 'damage', sourceId: ctx.source.id, targetId: target.id,
      amount: 0, school, absorbed: 0, overkill: 0, immune: true,
    });
    return 0;
  }

  // 攻击方的输出修正（casterScoped 的易伤在这里生效）
  const attackerMods = effectiveModifiersOf(ctx.auras, ctx.source.id, ctx.world.time);
  const targetMods = effectiveModifiersOf(ctx.auras, target.id, ctx.world.time, ctx.source.id);

  let amount = rawAmount * attackerMods.damageDealt * damageTakenFor(targetMods, school);

  // 背刺加成（6.5：攻击者位于目标背后约 120 度）
  if (opts.behindBonus && isBehind(ctx.source.position, target.position, target.yaw)) {
    amount *= 1 + opts.behindBonus;
  }
  amount = Math.max(0, Math.round(amount));

  // 吸收护盾先吃（14.3）
  const { absorbed, remaining, broken } = consumeAbsorb(ctx.auras, target.id, amount, school);
  for (const b of broken) {
    ctx.events.push({ t: 'shieldBroken', targetId: target.id, auraId: b.def.id });
  }

  const before = target.health;
  target.health = Math.max(0, target.health - remaining);
  const dealt = before - target.health;
  const overkill = Math.max(0, remaining - before);

  ctx.events.push({
    t: 'damage', sourceId: ctx.source.id, targetId: target.id,
    amount: dealt, school, absorbed, overkill, immune: false,
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

// ── 治疗 ─────────────────────────────────────────────────────────

export const dealHeal = (
  ctx: EffectContext,
  target: CombatEntity,
  rawAmount: number,
): number => {
  if (!target.alive || rawAmount <= 0) return 0;

  const casterMods = effectiveModifiersOf(ctx.auras, ctx.source.id, ctx.world.time);
  const targetMods = effectiveModifiersOf(ctx.auras, target.id, ctx.world.time);

  // 8.5：治疗受竞技场战斗抑制影响
  const amount = Math.max(
    0,
    Math.round(rawAmount * casterMods.healingDone * targetMods.healingTaken * (1 - dampening.amount)),
  );

  const before = target.health;
  target.health = Math.min(target.maxHealth, target.health + amount);
  const healed = target.health - before;

  ctx.events.push({
    t: 'heal', sourceId: ctx.source.id, targetId: target.id,
    amount: healed, overheal: amount - healed,
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
  if ((kind === 'root') && target.flags.immuneSlowAndRoot) {
    ctx.events.push({ t: 'immune', targetId: target.id, why: 'flag' });
    return;
  }
  if (kind === 'root' && target.flags.immuneMovementImpair) {
    ctx.events.push({ t: 'immune', targetId: target.id, why: 'flag' });
    return;
  }

  // 抗控型护甲：控制持续时间降低（10.8）
  const targetMods = effectiveModifiersOf(ctx.auras, target.id, ctx.world.time);
  const casterMods = effectiveModifiersOf(ctx.auras, ctx.source.id, ctx.world.time);
  let duration = baseDuration * targetMods.ccDurationTaken * casterMods.ccDurationDealt;

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
    description: `${spec.name} ${duration.toFixed(1)} 秒`,
  };

  applyAura(ctx.auras, target, def, ctx.source.id, ctx.world.time, { duration });
  ctx.events.push({
    t: 'auraApplied', sourceId: ctx.source.id, targetId: target.id,
    auraId: def.id, duration, drFactor,
  });
};

// ── 处理器注册 ───────────────────────────────────────────────────

registerEffect('damage', (ctx, e, targets) => {
  const raw = magnitudeOf(e.amount, ctx.source);
  for (const t of targets) {
    dealDamage(ctx, t, raw, e.school, { behindBonus: e.behindBonus });
  }
});

registerEffect('heal', (ctx, e, targets) => {
  const raw = magnitudeOf(e.amount, ctx.source);
  for (const t of targets) dealHeal(ctx, t, raw);
});

registerEffect('healPercentMaxHealth', (ctx, e, targets) => {
  for (const t of targets) dealHeal(ctx, t, t.maxHealth * e.percent);
});

registerEffect('healFromRecentDamage', (ctx, e, targets) => {
  for (const t of targets) {
    // 近期承受伤害由 world 记录（M4 暂用最大生命的固定比例近似），
    // 上限由技能定义保证（死亡打击「治疗有上限」）
    const cap = t.maxHealth * e.maxPercentOfMaxHealth;
    const recent = Math.min(cap, (t.maxHealth - t.health) * e.percentOfDamageTaken);
    dealHeal(ctx, t, Math.min(cap, recent));
  }
});

registerEffect('applyAura', (ctx, e, targets) => {
  const list = e.target === 'self' ? [ctx.source] : targets;
  for (const t of list) {
    // 8.4：完全免疫挡住新的负面光环
    if (e.aura.kind === 'debuff' && t.flags.immuneAll) {
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
    if (out.interrupted) {
      ctx.events.push({
        t: 'custom', handler: out.schoolLock ? `interrupt:${out.schoolLock.school}` : 'interrupt:physical',
        sourceId: ctx.source.id, targetId: t.id,
      });
    }
  }
});

registerEffect('dispel', (ctx, e, targets) => {
  for (const t of targets) {
    const hostile = t.team !== ctx.source.team;
    // 对敌人驱散增益，对友方驱散减益 —— 由目标阵营决定，不是由 from 字段决定，
    // 因为一个 targetFilter: Any 的技能会同时挂两条 dispel 效果（牧师·驱散魔法）
    if ((e.from === 'enemy') !== hostile) continue;
    const removed = dispelAuras(
      ctx.auras, t.id, e.types, e.count,
      hostile ? 'buff' : 'debuff',
      e.canRemoveImmunity,
    );
    for (const r of removed) {
      ctx.events.push({ t: 'dispelled', sourceId: ctx.source.id, targetId: t.id, auraId: r.aura.def.id });
      const cat = r.aura.def.drCategory;
      if (cat) onControlEndedEarly(ctx.dr, t.id, cat, ctx.world.time);
    }
  }
});

registerEffect('gainResource', (ctx, e, targets) => {
  const list = targets.length > 0 ? targets : [ctx.source];
  for (const t of list) {
    gainResource(t, e.resource, e.amount);
    ctx.events.push({ t: 'resource', targetId: t.id, resource: e.resource, delta: e.amount });
  }
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

/** 8.3 通用解控「战斗意志」。不是 EffectDef，由输入层直接调用 */
export const useTrinket = (ctx: EffectContext, target: CombatEntity): boolean => {
  const removed = clearByTrinket(ctx.auras, target.id);
  for (const r of removed) {
    ctx.events.push({ t: 'auraRemoved', targetId: target.id, auraId: r.aura.def.id, reason: 'trinket' });
    const cat = r.aura.def.drCategory;
    if (cat) onControlEndedEarly(ctx.dr, target.id, cat, ctx.world.time);
  }
  return removed.length > 0;
};
