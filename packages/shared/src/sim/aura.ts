/**
 * 光环系统。规格书 8.2 / 8.3 / 8.4 / 14.3，验收 #23。
 *
 * 职责：
 *   · 施加、刷新、叠层、过期
 *   · 周期跳（持续伤害 / 持续治疗）
 *   · 受伤打破（恐惧、变形、定身）
 *   · 吸收护盾的承伤、衰减与**破裂**（14.3 要求四种不同反馈）
 *   · 随时间衰减的修正（冰霜锁链）
 *   · **由光环聚合出 StatusFlags** —— M2 里是手动赋值的，现在有了真正的来源
 */

import type { AuraDef, AuraModifiers, EffectDef } from '../data/schema.js';
import { DispelType, School } from '../types/enums.js';
import type { EntityId } from '../types/ids.js';
import { createStatusFlags, type CombatEntity, type StatusFlags } from './entity.js';
import {
  aggregateModifiers,
  effectiveMoveSpeed,
  equipmentModifiersOf,
  type EffectiveModifiers,
} from './modifiers.js';
import { MOVE } from '../constants/combat.js';
import { clampCarrierSpeedBonus } from './match/flag.js';

export interface AuraInstance {
  def: AuraDef;
  /** 施加者。casterScoped 的光环靠它判断作用对象（审判）*/
  sourceId: EntityId;
  targetId: EntityId;
  appliedAt: number;
  /** 过期时刻。persistent 光环为 Infinity */
  expiresAt: number;
  stacks: number;
  /** 剩余吸收量。仅 absorb 类光环 */
  absorbRemaining: number;
  /** 初始吸收量，用于 14.3 的「强度衰减」反馈 */
  absorbInitial: number;
  /** breakOnDamage 已累计承受的伤害 */
  damageAccumulated: number;
  /** 下一次周期跳的时刻 */
  nextTickAt: number;
  /** 递减后的实际持续时间，供 HUD 显示 */
  actualDuration: number;
}

/** 每个实体一串光环 */
export type AuraStore = Map<EntityId, AuraInstance[]>;

export const createAuraStore = (): AuraStore => new Map();

export const aurasOf = (store: AuraStore, id: EntityId): AuraInstance[] => store.get(id) ?? [];

// ── 施加与移除 ───────────────────────────────────────────────────

export interface ApplyAuraOptions {
  /** 递减后的持续时间。控制类光环由调用方先过 dr.applyDr */
  duration?: number;
  /** 吸收量。absorbPercentMaxHealth 由调用方换算好 */
  absorb?: number;
  stacks?: number;
}

/**
 * 施加光环。同 id 同来源时按 maxStacks 叠层并刷新持续时间。
 *
 * 不同来源的同 id 光环**各存一份** —— 两个战士的致死创伤应该各自计时，
 * 而不是互相刷新。8.4 的「不能无限叠加」由 modifiers 的聚合规则保证，
 * 不是靠这里只留一份。
 */
export const applyAura = (
  store: AuraStore,
  target: CombatEntity,
  def: AuraDef,
  sourceId: EntityId,
  now: number,
  opts: ApplyAuraOptions = {},
): AuraInstance => {
  const list = store.get(target.id) ?? [];
  const duration = opts.duration ?? def.duration;
  const absorb =
    opts.absorb ??
    (def.absorbPercentMaxHealth !== undefined
      ? target.maxHealth * def.absorbPercentMaxHealth
      : (def.absorb ?? 0));

  const existing = list.find((a) => a.def.id === def.id && a.sourceId === sourceId);
  if (existing) {
    const max = def.maxStacks ?? 1;
    existing.stacks = Math.min(max, existing.stacks + (opts.stacks ?? 1));
    existing.appliedAt = now;
    existing.expiresAt = def.persistent ? Infinity : now + duration;
    existing.actualDuration = duration;
    existing.damageAccumulated = 0;
    if (absorb > 0) {
      existing.absorbRemaining = absorb;
      existing.absorbInitial = absorb;
    }
    return existing;
  }

  const inst: AuraInstance = {
    def,
    sourceId,
    targetId: target.id,
    appliedAt: now,
    expiresAt: def.persistent ? Infinity : now + duration,
    stacks: opts.stacks ?? 1,
    absorbRemaining: absorb,
    absorbInitial: absorb,
    damageAccumulated: 0,
    nextTickAt: def.periodic ? now + def.periodic.interval : Infinity,
    actualDuration: duration,
  };
  list.push(inst);
  store.set(target.id, list);
  return inst;
};

export type RemoveReason = 'expired' | 'dispelled' | 'broken' | 'cancelled' | 'shieldBroken';

export interface AuraRemoval {
  aura: AuraInstance;
  reason: RemoveReason;
}

export const removeAuraById = (
  store: AuraStore,
  id: EntityId,
  auraId: string,
  reason: RemoveReason = 'cancelled',
): AuraRemoval[] => {
  const list = store.get(id);
  if (!list) return [];
  const removed: AuraRemoval[] = [];
  const kept = list.filter((a) => {
    if (a.def.id === auraId) {
      removed.push({ aura: a, reason });
      return false;
    }
    return true;
  });
  store.set(id, kept);
  return removed;
};

/** 8.3 通用解控「战斗意志」：只移除标了 clearableByTrinket 的光环 */
export const clearByTrinket = (store: AuraStore, id: EntityId): AuraRemoval[] => {
  const list = store.get(id);
  if (!list) return [];
  const removed: AuraRemoval[] = [];
  const kept = list.filter((a) => {
    // 默认 false —— 新增光环时忘了标注不会意外变成可解除
    if (a.def.clearableByTrinket === true) {
      removed.push({ aura: a, reason: 'dispelled' });
      return false;
    }
    return true;
  });
  store.set(id, kept);
  return removed;
};

/**
 * 驱散的选择口径（schema `dispel` 效果的镜像，见 `EffectDef` 注释）：
 *   · `types` —— 按驱散**类别**（8.4 经典口径）
 *   · `impairs` —— 按光环**实际做了什么**：'slow' = 带减速修正，
 *     'movement' = 减速 ∪ 定身。「解除减速和定身」类技能按类别永远选不全 ——
 *     减速的 dispelType 天生分散在 movement/magic/poison 三种里。
 */
export interface DispelSelector {
  types?: readonly DispelType[];
  impairs?: 'slow' | 'movement';
}

/** 这个光环会减速吗？衰减型减速（冰霜锁链）的 moveSpeed 写的就是初始值，同样命中 */
export const isSlowAura = (def: AuraInstance['def']): boolean =>
  (def.modifiers?.moveSpeed ?? 1) < 1;

/**
 * 这个光环**限制移动**吗？＝ 减速 ∪ 定身。
 *
 * ★★ 只有这一份判据：驱散的 `impairs: 'movement'`（自由庇佑「解除减速和定身」）
 *   与 8.4「3 秒内免疫**新的**减速和定身」（`immuneMovementImpair` /
 *   `immuneSlowAndRoot`，见 `effects/combat.ts` 的 applyAura 处理器）
 *   问的是同一个问题。分成两份迟早漂移，而漂移的形态就是
 *   「解得掉但挡不住」—— X13 的对抗校验抓到的正是这条：免疫旗标当时
 *   只在 `applyControl` 的 root 分支被读过，减速走的是光环那条路，
 *   于是「免疫新的减速」对全仓库每一条减速都没生效过。
 */
export const impairsMovement = (def: AuraInstance['def']): boolean =>
  isSlowAura(def) || def.flags?.rooted === true;

/**
 * 驱散**资格**判定（只读）：这个目标身上有哪些光环会被该口径的驱散移除。
 *
 * ★ 从 `dispel()` 里抽出来，是为了让 AI 能先问「按下去能清掉东西吗」再决定
 *   按不按（没有可清目标就不按 —— 净化术/自由庇佑此前是 bot 的死键）。
 *   资格规则**只有这一份**：`dispel()` 也调它 —— 分开写两套迟早漂移，
 *   「面板显示的和生效的不一致」是这仓库点过名的老病。
 */
export const dispelEligible = (
  store: AuraStore,
  id: EntityId,
  selector: DispelSelector,
  kind: 'buff' | 'debuff',
  canRemoveImmunity = false,
): AuraInstance[] =>
  (store.get(id) ?? []).filter((a) => {
    if (a.def.kind !== kind) return false;
    // ★ 「不可驱散」对两种口径都成立 —— 语义筛选不是绕过 None 的后门
    if (a.def.dispelType === DispelType.None) return false;
    if (selector.types && !selector.types.includes(a.def.dispelType)) return false;
    if (selector.impairs) {
      const impairing =
        selector.impairs === 'movement' ? impairsMovement(a.def) : isSlowAura(a.def);
      if (!impairing) return false;
    }
    if (a.def.flags?.immuneAll && !canRemoveImmunity) return false;
    return true;
  });

/**
 * 8.4 驱散：只移除技能说明允许的类别。
 * `canRemoveImmunity` 对应群体驱散「可解除部分完全免疫」。
 */
export const dispel = (
  store: AuraStore,
  id: EntityId,
  selector: DispelSelector,
  count: number | 'all',
  kind: 'buff' | 'debuff',
  canRemoveImmunity = false,
): AuraRemoval[] => {
  const list = store.get(id);
  if (!list) return [];

  const eligible = dispelEligible(store, id, selector, kind, canRemoveImmunity);

  const limit = count === 'all' ? eligible.length : count;
  const victims = eligible.slice(0, limit);
  const victimSet = new Set(victims);
  store.set(id, list.filter((a) => !victimSet.has(a)));
  return victims.map((aura) => ({ aura, reason: 'dispelled' as const }));
};

// ── 每 tick ──────────────────────────────────────────────────────

export interface AuraTickEvent {
  targetId: EntityId;
  sourceId: EntityId;
  aura: AuraInstance;
  effects: readonly EffectDef[];
}

export interface AuraTickResult {
  /** 本 tick 触发的周期效果，由效果系统结算 */
  ticks: AuraTickEvent[];
  /** 本 tick 被移除的光环 */
  removals: AuraRemoval[];
}

/**
 * 推进所有光环一个 tick。
 * 只产出「该结算什么」，实际结算交给效果系统 —— 避免循环依赖，也方便单测。
 */
export const tickAuras = (store: AuraStore, now: number): AuraTickResult => {
  const ticks: AuraTickEvent[] = [];
  const removals: AuraRemoval[] = [];

  for (const [id, list] of store) {
    const kept: AuraInstance[] = [];
    for (const a of list) {
      if (now >= a.expiresAt) {
        removals.push({ aura: a, reason: 'expired' });
        continue;
      }
      // 周期跳。用 while 而不是 if，避免低帧率下漏跳
      if (a.def.periodic && now >= a.nextTickAt) {
        while (now >= a.nextTickAt && a.nextTickAt < a.expiresAt) {
          ticks.push({
            targetId: id,
            sourceId: a.sourceId,
            aura: a,
            effects: a.def.periodic.effects,
          });
          a.nextTickAt += a.def.periodic.interval;
        }
      }
      kept.push(a);
    }
    store.set(id, kept);
  }
  return { ticks, removals };
};

// ── 承伤交互 ─────────────────────────────────────────────────────

export interface AbsorbResult {
  /** 被护盾吃掉的伤害 */
  absorbed: number;
  /** 穿透护盾的剩余伤害 */
  remaining: number;
  /** 本次承伤中破裂的护盾（14.3 的第四种反馈）*/
  broken: AuraInstance[];
  /**
   * 各护盾**施加者**分别吃掉了多少。16.1 的「吸收」是治疗者的贡献项，
   * 要记给下盾的人；只有总量的话没法归属。同一个人的多个护盾已合并。
   */
  byShieldSource: { sourceId: EntityId; amount: number }[];
}

/**
 * 14.3：护盾需要**激活 / 承伤 / 强度衰减 / 破裂**四种不同反馈。
 * 这个函数负责后三种的数据面：扣减、剩余量、破裂事件。
 *
 * `school` 用于 `absorbSchools` 过滤 —— 反魔法护罩只吸收魔法伤害。
 */
export const consumeAbsorb = (
  store: AuraStore,
  id: EntityId,
  damage: number,
  school: School,
): AbsorbResult => {
  const list = store.get(id);
  if (!list || damage <= 0) {
    return { absorbed: 0, remaining: damage, broken: [], byShieldSource: [] };
  }

  let remaining = damage;
  let absorbed = 0;
  const broken: AuraInstance[] = [];
  const perSource = new Map<EntityId, number>();

  for (const a of list) {
    if (remaining <= 0) break;
    if (a.absorbRemaining <= 0) continue;
    // 学派过滤：不填表示吸收全部
    if (a.def.absorbSchools && !a.def.absorbSchools.includes(school)) continue;

    const eaten = Math.min(a.absorbRemaining, remaining);
    a.absorbRemaining -= eaten;
    remaining -= eaten;
    absorbed += eaten;
    perSource.set(a.sourceId, (perSource.get(a.sourceId) ?? 0) + eaten);
    if (a.absorbRemaining <= 0) broken.push(a);
  }

  if (broken.length > 0) {
    const brokenSet = new Set(broken);
    store.set(id, list.filter((a) => !brokenSet.has(a)));
  }
  return {
    absorbed,
    remaining,
    broken,
    byShieldSource: [...perSource].map(([sourceId, amount]) => ({ sourceId, amount })),
  };
};

/**
 * 8.2：恐惧/迷惑/变形/定身「受到一定伤害可提前解除」。
 * 在伤害结算之后调用，返回被打破的光环。
 */
export const applyDamageToBreakables = (
  store: AuraStore,
  id: EntityId,
  damage: number,
): AuraRemoval[] => {
  const list = store.get(id);
  if (!list || damage <= 0) return [];

  const broken: AuraInstance[] = [];
  for (const a of list) {
    const rule = a.def.breakOnDamage;
    if (a.def.breakOnAnyDamage) {
      broken.push(a);
      continue;
    }
    if (!rule) continue;
    a.damageAccumulated += damage;
    if (a.damageAccumulated >= rule.threshold) broken.push(a);
  }

  if (broken.length > 0) {
    const brokenSet = new Set(broken);
    store.set(id, list.filter((a) => !brokenSet.has(a)));
  }
  return broken.map((aura) => ({ aura, reason: 'broken' as const }));
};

// ── 聚合 ─────────────────────────────────────────────────────────

/**
 * 把一个实体的**光环 + 当前装备**聚合成最终修正值。
 *
 * `attackerId` 用于 `casterScoped`：审判的易伤只对**该圣骑士**生效，
 * 计算别人的伤害时必须忽略它。不传则跳过所有 casterScoped 光环。
 *
 * ★ 第二个参数是**实体**而不是 `EntityId`，这是有意的。
 *
 *   M6 落地装备栏时，`WeaponDef.modifiers` / `ArmorDef.modifiers` 是死数据 ——
 *   本函数当时只聚合光环，而它是战斗数学取修正的唯一入口，于是 10.8 承诺的
 *   五种护甲原型在对局里完全等价，`LoadoutPanel` 却照旧把「受到伤害 −8%」
 *   当作换装的优势显示给玩家看。八个里程碑全绿都没抓到，因为 M6 的测试
 *   断言的是装备栏账目和验收 #34 那五条「换装不做什么」，没有一条问过
 *   「换上防御护甲后同一发伤害是不是真的更低」。
 *
 *   改成收实体之后，**拿不到实体就算不出修正** —— 想再造出一份漏掉装备的
 *   修正，必须显式绕开这个函数去调 `aggregateModifiers`，那是一次显眼的改动。
 */
export const effectiveModifiersOf = (
  store: AuraStore,
  entity: CombatEntity,
  now: number,
  attackerId?: EntityId,
): EffectiveModifiers => {
  const list = aurasOf(store, entity.id);
  const mods: (AuraModifiers | undefined)[] = [];

  for (const a of list) {
    if (a.def.casterScoped && a.sourceId !== attackerId) continue;
    mods.push(withDecay(a, now));
    // 叠层：第 2 层起再叠加一份修正
    for (let i = 1; i < a.stacks; i++) mods.push(withDecay(a, now));
  }
  return aggregateModifiers(mods, equipmentModifiersOf(entity.weaponId, entity.armorId));
};

/**
 * 实体**当前的移动速度倍率**。喂给 `stepMovement(..., { speedMultiplier })`。
 *
 * ★★ **这个函数存在的唯一理由是「只能有一处」。**
 *   移动速度要在三条路径上算出**逐位相同**的结果：
 *     · 服务器权威（`tickWorld` 第 2 步）
 *     · 客户端预测（`Predictor` 的 sample 与 reconcile 重放）
 *     · 单机试验场（`TestbedScene.simulate`）
 *   任何一处自己拼一遍聚合逻辑，偏差都会退化成**持续橡皮筋** ——
 *   而那是最难查的一类 bug：画面在抖，但没有任何断言会红。
 *
 * ★★ 它修的是一个**从未生效过**的机制：`tickWorld` 此前调 `stepMovement`
 *   **不传 `speedMultiplier`**，而 `effectiveMoveSpeed()` 全仓库只有定义那一行
 *   （连测试都是绕过它直接读 `.moveSpeed`）。于是断筋、冰霜锁链、群奔咆哮、
 *   猎豹形态、死亡脚步的速度下限、以及 12.3 的旗手加速上限，
 *   **一条都没有影响过实际移动**。数据在、聚合在、单测也绿 —— 就是没人调用。
 *
 * ★ 12.3 的旗手上限一并接上（`clampCarrierSpeedBonus` 同样是死代码）：
 *   加成部分才受 10% 封顶，减速部分不受影响 —— 否则「带旗被减速」会被
 *   这条上限意外地救回来。
 */
export const moveSpeedMultiplierOf = (
  store: AuraStore,
  entity: CombatEntity,
  now: number,
): number => {
  const raw = effectiveMoveSpeed(effectiveModifiersOf(store, entity, now), MOVE.MIN_SPEED_FACTOR);
  if (raw <= 1) return raw; // 减速：旗手上限不适用
  return 1 + clampCarrierSpeedBonus(raw - 1, entity.flags.carryingFlag);
};

/**
 * schema v1.1 的 `AuraDef.decay`：随时间线性衰减的修正（冰霜锁链
 * 「初始减速 60%，在 4 秒内逐渐衰减」）。
 */
const withDecay = (a: AuraInstance, now: number): AuraModifiers | undefined => {
  const base = a.def.modifiers;
  const d = a.def.decay;
  if (!base || !d) return base;

  const span = d.duration ?? a.actualDuration;
  if (span <= 0) return { ...base, [d.field]: d.to };
  const t = Math.min(1, Math.max(0, (now - a.appliedAt) / span));
  return { ...base, [d.field]: d.from + (d.to - d.from) * t };
};

/**
 * ★ 由光环聚合出状态标志。
 *
 * M2 里 `entity.flags` 是手动赋值的占位实现，现在它有了真正的来源。
 * sim 每 tick 调用一次，写回 `entity.flags` —— 调用方（casting / targeting /
 * movement）的代码一行都不用改，这正是当初把 StatusFlags 单列成结构的原因。
 */
export const deriveStatusFlags = (
  store: AuraStore,
  entity: CombatEntity,
): StatusFlags => {
  const flags = createStatusFlags();
  // 旗手状态由夺旗系统维护，不来自光环
  flags.carryingFlag = entity.flags.carryingFlag;
  flags.stealthRevealed = entity.flags.stealthRevealed;

  for (const a of aurasOf(store, entity.id)) {
    const f = a.def.flags;
    if (!f) continue;
    // 7.3：昏迷、恐惧、变形都表现为「无法行动」
    if (f.stunned || f.feared) flags.stunned = true;
    if (f.feared) flags.feared = true;
    if (f.rooted) flags.rooted = true;
    if (f.silenced) flags.silenced = true;
    if (f.disarmed) flags.disarmed = true;
    if (f.stealthed) flags.stealthed = true;
    if (f.untargetable) flags.untargetable = true;
    if (f.immuneAll) flags.immuneAll = true;
    if (f.immunePhysical) flags.immunePhysical = true;
    if (f.immuneMagic) flags.immuneMagic = true;
    if (f.immuneMovementImpair) flags.immuneMovementImpair = true;
    if (f.immuneMagicControl) flags.immuneMagicControl = true;
    if (f.cannotAttack) flags.cannotAttack = true;
    if (f.immuneSlowAndRoot) flags.immuneSlowAndRoot = true;
    if (f.deflectFrontProjectiles) flags.deflectFrontProjectiles = true;
    if (f.spawnProtection) flags.spawnProtection = true;
  }
  return flags;
};

/** 8.4：是否处于完全免疫。竞技场决胜阶段的压迫伤害要绕过它（8.5 / 验收 #27）*/
export const hasFullImmunity = (store: AuraStore, id: EntityId): boolean =>
  aurasOf(store, id).some((a) => a.def.flags?.immuneAll === true);

/** 清空实体的全部光环（回合重置，2.1 / 验收 #37）*/
export const clearAuras = (store: AuraStore, id: EntityId): void => {
  store.delete(id);
};
