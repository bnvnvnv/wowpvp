/**
 * 技能表现六阶段。规格书 14.1。
 *
 * 14.1 原文：
 *   预备：手部、武器、符文或身体积蓄能量。
 *   释放：明确闪光、动作和声音。
 *   飞行：投射物主体、方向和轨迹。
 *   命中：伤害、治疗、格挡、闪避、免疫或驱散反馈。
 *   持续：地面区域、护盾、光环和控制附着。
 *   结束：淡出、破碎、熄灭或消散。
 *
 * ★ 六个阶段里只有**两个是每个技能都有**的（释放、结束），
 *   其余四个取决于技能本身：瞬发没有预备，非投射物没有飞行，
 *   不施加光环的没有持续。所以这里不做「六个阶段的空壳数组」，
 *   而是由 `phasesFor(skill)` 从 `SkillDef` **推导** ——
 *   推导出来的阶段表和技能数据永远一致，不需要有人手工维护 91 份配置。
 *
 * 这也意味着新增技能时**不用写任何特效配置**：
 * 数据里已经有 targeting / cast / effects，六阶段是它们的函数。
 */

import { CastKind, Targeting, type SkillDef } from '@wowpvp/shared';
import { visualAttributeOf, type VisualAttribute } from './schools.js';
import { DECORATIVE_ROLES, ESSENTIAL_ROLES, type VisualRole } from '../render/quality.js';

export const VfxPhase = {
  /** 预备：读条/引导期间的蓄力 */
  Windup: 'windup',
  /** 释放：出手瞬间 */
  Release: 'release',
  /** 飞行：投射物在空中 */
  Travel: 'travel',
  /** 命中：结算反馈 */
  Impact: 'impact',
  /** 持续：地面区域、护盾、光环、控制附着 */
  Sustain: 'sustain',
  /** 结束：淡出/破碎/熄灭/消散 */
  End: 'end',
} as const;
export type VfxPhase = (typeof VfxPhase)[keyof typeof VfxPhase];

export interface PhaseSpec {
  phase: VfxPhase;
  /**
   * 这个阶段画的东西属于哪个视觉角色。
   * ★ 决定了它在低画质下能不能被砍 —— 见 render/quality.ts。
   */
  role: VisualRole;
  /** 阶段时长（秒）。0 表示跟随技能自身的时长，由渲染层决定 */
  seconds: number;
  /** 给渲染层的说明，同时也是给读代码的人的说明 */
  note: string;
}

/**
 * 从技能数据推导它的表现阶段。
 *
 * 判定依据全部来自 `SkillDef` 已有字段，没有新增配置：
 *   预备 ← cast.kind 不是 Instant
 *   飞行 ← targeting 是 Projectile / SkillShot
 *   持续 ← effects 里有 applyAura 或 groundArea
 */
export const phasesFor = (skill: SkillDef): PhaseSpec[] => {
  const out: PhaseSpec[] = [];

  // ── 预备（14.1：手部、武器、符文或身体积蓄能量）──
  if (skill.cast.kind !== CastKind.Instant) {
    out.push({
      phase: VfxPhase.Windup,
      role: ESSENTIAL_ROLES.character,
      seconds: skill.cast.time,
      note: '读条/引导期间的蓄力。挂在施法者身上，属于角色的一部分，低画质不能砍',
    });
  }

  // ── 释放（每个技能都有）──
  out.push({
    phase: VfxPhase.Release,
    role: ESSENTIAL_ROLES.character,
    seconds: 0.2,
    note: '出手瞬间的闪光与动作',
  });

  // ── 飞行 ──
  if (isProjectile(skill)) {
    out.push({
      phase: VfxPhase.Travel,
      // ★ 主体是关键的：14.4 明确说「不能隐藏投射物主体」
      role: ESSENTIAL_ROLES.projectileBody,
      seconds: 0,
      note: '投射物主体 + 方向。主体是关键信息，拖尾（projectileTrail）才是装饰',
    });
    out.push({
      phase: VfxPhase.Travel,
      role: DECORATIVE_ROLES.projectileTrail,
      seconds: 0,
      note: '轨迹拖尾。低画质下砍掉，不影响玩家判断来向',
    });
  }

  // ── 命中 ──
  out.push({
    phase: VfxPhase.Impact,
    role: ESSENTIAL_ROLES.character,
    seconds: 0.25,
    note: '伤害/治疗/格挡/闪避/免疫/驱散反馈。免疫属于关键信息（14.4）',
  });
  out.push({
    phase: VfxPhase.Impact,
    role: DECORATIVE_ROLES.impactDebris,
    seconds: 0.4,
    note: '火花与碎屑',
  });

  // ── 持续 ──
  // ★ 14.3：「延迟技能显示落点和倒计时」。落点和倒计时都是关键信息 ——
  //   看不到倒计时就等于看不到该什么时候躲开
  if (hasDelayedImpact(skill)) {
    out.push({
      phase: VfxPhase.Sustain,
      role: ESSENTIAL_ROLES.groundBoundary,
      seconds: 0,
      note: '延迟落点 + 倒计时。落点边界与剩余秒数在任何画质下都必须可见（14.3）',
    });
  }
  if (hasGroundArea(skill)) {
    out.push({
      phase: VfxPhase.Sustain,
      // ★ 14.3：边界在整个有效期内持续显示，装饰粒子可以淡出但边界不能消失
      role: ESSENTIAL_ROLES.groundBoundary,
      seconds: 0,
      note: '地面区域的真实边界。全程可见，任何画质都不砍',
    });
    out.push({
      phase: VfxPhase.Sustain,
      role: DECORATIVE_ROLES.groundFill,
      seconds: 0,
      note: '区域内部的装饰粒子。14.3 明确允许淡出',
    });
  }
  if (appliesAura(skill)) {
    out.push({
      phase: VfxPhase.Sustain,
      role: ESSENTIAL_ROLES.controlStatus,
      seconds: 0,
      note: '光环与控制附着。控制状态是关键信息（14.4）',
    });
  }

  // ── 结束（每个技能都有）──
  out.push({
    phase: VfxPhase.End,
    role: ESSENTIAL_ROLES.character,
    seconds: 0.3,
    note: '淡出/破碎/熄灭/消散',
  });

  return out;
};

/**
 * 是否有「飞行」阶段。
 *
 * 判据是**效果里有没有投射物**，而不是 `targeting === Projectile`。
 * 两者不等价：猎人的瞄准射击瞄准类型是 Direct，但它确实有一支箭飞过去。
 * 玩家看到的是箭，所以按效果判定才对。
 *
 * ★ W23：`lockedProjectile`（6.6 锁定投射物）同样是一次真实的飞行 ——
 *   而且它比碰撞型更需要这个阶段：结算就发生在抵达那一刻。
 */
const isProjectile = (s: SkillDef): boolean =>
  s.effects.some((e) => e.kind === 'spawnProjectile' || e.kind === 'lockedProjectile') ||
  s.targeting === Targeting.Projectile;

const hasGroundArea = (s: SkillDef): boolean =>
  s.effects.some((e) => e.kind === 'spawnGroundArea');

/** 14.3：「延迟技能显示落点和倒计时」*/
const hasDelayedImpact = (s: SkillDef): boolean =>
  s.effects.some((e) => e.kind === 'delayedGroundImpact');

/**
 * ★ W23：光环载荷会住在 `lockedProjectile.onHit` 里（霜矢的减速、月火的
 *   DoT、气旋囚笼…）。不下探的话这些技能的「控制状态附着」阶段会整个消失，
 *   而 14.4 把控制状态列为关键信息 —— 与 skillIcon 的 `flattenEffects` 同族。
 */
const appliesAura = (s: SkillDef): boolean => appliesAuraIn(s.effects);

const appliesAuraIn = (effects: readonly SkillDef['effects'][number][]): boolean =>
  effects.some(
    (e) =>
      e.kind === 'applyAura' ||
      (e.kind === 'lockedProjectile' && appliesAuraIn(e.onHit)),
  );

/** 某个技能的完整表现描述，供调试面板与文档生成使用 */
export interface SkillVfxPlan {
  skillId: string;
  attribute: VisualAttribute;
  phases: PhaseSpec[];
}

export const vfxPlanFor = (skill: SkillDef): SkillVfxPlan => ({
  skillId: skill.id as string,
  attribute: visualAttributeOf(skill),
  phases: phasesFor(skill),
});
