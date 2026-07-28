/**
 * 瞄准解算。规格书 5.4 / 5.5 / 6.3，验收 #7 / #8。
 *
 * ★ 这个模块存在的唯一理由：**客户端预览和服务器判定必须用同一份代码**。
 *
 * 验收 #8 要求「地面技能非法位置不能确认，真实范围边界与实际判定一致」。
 * 保证它的方式不是「小心地写两遍」，而是让客户端画指示器时调用
 * `resolveGroundPlacement()` 拿到边界与合法性，服务器结算时调用
 * `collectShapeTargets()` 用**同一组**参数选目标 —— 两者共享 geometry.ts 的判定函数。
 */

import {
  hitCircle,
  hitCone,
  hitLine,
  hitRing,
  isGroundPositionLegal,
  nextChainTarget,
  type Aabb,
} from '../math/geometry.js';
import { addScaled, distance2D, normalize2D, sub, vec3, yawToDir, type Vec3 } from '../math/vec3.js';
import type { ShapeDef, SkillDef } from '../data/schema.js';
import { CastFailure, TargetFilter, Targeting } from '../types/enums.js';
import { hitCircleOf, isFriendly, isHostile, isSelectableBy, type CombatEntity } from './entity.js';
import { listEntities, type World } from './world.js';

// ── 5.5 地面指示器 ───────────────────────────────────────────────

/**
 * 地面技能的落点解算结果。客户端拿它画预览，服务器拿它做判定。
 *
 * 5.5 要求预览必须显示：真实外边界、中心点、最大施放距离、
 * 是否被墙体阻挡、是否超出地图。下面每个字段各对应其中一项。
 */
export interface GroundPlacement {
  /** 钳制到最大距离之后的实际落点 —— 这才是会被释放的位置 */
  center: Vec3;
  /** 玩家鼠标指向的原始位置，用于画「你想放这里」的虚影 */
  requested: Vec3;
  /** 技能最大施放距离，客户端画那个大圆 */
  maxRange: number;
  /** 效果半径（或环形外径），客户端画真实边界 */
  radius: number;
  /** 环形技能的内径。5.4 / 14.3：环形必须**同时**显示内外边界 */
  innerRadius?: number;
  /** 是否因为超出最大距离而被钳制 */
  clamped: boolean;
  /** 合法性。非法时 `失败原因` 会说明是超距还是被墙挡 */
  legal: boolean;
  reason: CastFailure;
}

/**
 * 5.5 / 6.4：解算地面技能落点。
 *
 * 非法的两种情况：
 *   - 超出最大施放距离 → 钳制到边缘，仍然合法（这是惯例，玩家不会因为多推了
 *     两厘米就放不出来）
 *   - 落点对施法者不可见（被封闭墙体阻挡）→ **不合法，不能确认**
 */
export const resolveGroundPlacement = (
  caster: CombatEntity,
  requested: Vec3,
  skill: SkillDef,
  obstacles: readonly Aabb[],
  mapBounds?: Aabb,
): GroundPlacement => {
  const radius = shapeRadius(skill.shape);
  const innerRadius = skill.shape.kind === 'ring' ? skill.shape.innerRadius : undefined;

  const d = distance2D(caster.position, requested);
  const clamped = d > skill.range.max;
  const dir = normalize2D(sub(requested, caster.position));
  const center = clamped
    ? addScaled(vec3(caster.position.x, requested.y, caster.position.z), dir, skill.range.max)
    : { ...requested };

  const base: Omit<GroundPlacement, 'legal' | 'reason'> = {
    center,
    requested: { ...requested },
    maxRange: skill.range.max,
    radius,
    innerRadius,
    clamped,
  };

  // 5.5：超出地图边界不能确认
  if (mapBounds && !insideBounds(center, mapBounds)) {
    return { ...base, legal: false, reason: CastFailure.InvalidGroundPosition };
  }

  // 6.4：地面范围不能穿过封闭墙体放置；指示器必须停留在施法者实际可见的地面
  if (!isGroundPositionLegal(hitCircleOf(caster), center, obstacles)) {
    return { ...base, legal: false, reason: CastFailure.NoLineOfSight };
  }

  return { ...base, legal: true, reason: CastFailure.Ok };
};

const insideBounds = (p: Vec3, b: Aabb): boolean =>
  p.x >= b.min.x && p.x <= b.max.x && p.z >= b.min.z && p.z <= b.max.z;

/** 取形状的外径。客户端画边界、服务器选目标都用它，保证是同一个数 */
export const shapeRadius = (shape: ShapeDef): number => {
  switch (shape.kind) {
    case 'circle': return shape.radius;
    case 'ring': return shape.outerRadius;
    case 'cone': return shape.range;
    case 'line': return shape.length;
    case 'chain': return shape.jumpRange;
    case 'single': return 0;
  }
};

// ── 6.3 形状选目标 ───────────────────────────────────────────────

export interface ShapeQuery {
  /** 形状原点。自身中心技能是施法者位置，地面技能是落点 */
  origin: Vec3;
  /** 方向技能的朝向（弧度）。★ 必须是**角色** yaw，不是镜头 yaw（6.5）*/
  yaw: number;
  shape: ShapeDef;
  filter: TargetFilter;
}

/**
 * 按形状选出受影响的目标。
 *
 * ★ 这是「所见即所中」的服务器侧一半：客户端用 `resolveGroundPlacement` 的
 *   center/radius 画边界，这里用**同一组数**调用 geometry 的判定函数。
 *   两边的圆是同一个圆。
 */
export const collectShapeTargets = (
  world: World,
  caster: CombatEntity,
  q: ShapeQuery,
): CombatEntity[] => {
  const eligible = listEntities(world).filter((e) => {
    if (!e.alive || !isSelectableBy(e, caster)) return false;
    switch (q.filter) {
      case TargetFilter.Enemy: return isHostile(caster, e);
      case TargetFilter.Ally: return isFriendly(caster, e);
      case TargetFilter.Self: return e.id === caster.id;
      case TargetFilter.Any: return true;
      default: return false;
    }
  });

  const s = q.shape;
  let hits: CombatEntity[];
  switch (s.kind) {
    case 'single':
      hits = eligible.slice(0, 1);
      break;
    case 'circle':
      hits = eligible.filter((e) => hitCircle(q.origin, s.radius, hitCircleOf(e)));
      break;
    case 'ring':
      hits = eligible.filter((e) => hitRing(q.origin, s.innerRadius, s.outerRadius, hitCircleOf(e)));
      break;
    case 'cone':
      hits = eligible.filter((e) => hitCone(q.origin, q.yaw, s.angleDeg, s.range, hitCircleOf(e)));
      break;
    case 'line':
      hits = eligible.filter((e) => hitLine(q.origin, q.yaw, s.length, s.width, hitCircleOf(e)));
      break;
    case 'chain': {
      // 6.3 链式：首目标 + 逐跳寻找最近的未命中目标
      hits = [];
      const remaining = new Map(eligible.map((e) => [hitCircleOf(e), e] as const));
      const consumed = new Set<ReturnType<typeof hitCircleOf>>();
      let from = q.origin;
      for (let i = 0; i < s.maxTargets; i++) {
        const next = nextChainTarget(from, [...remaining.keys()], s.jumpRange, consumed);
        if (!next) break;
        const entity = remaining.get(next)!;
        hits.push(entity);
        consumed.add(next);
        from = entity.position;
      }
      break;
    }
  }

  // 6.3 / schema v1.1：圆、锥、直线、环可以有 maxTargets 上限（群体驱散最多 5 个）。
  // 链式的 maxTargets 已经在上面的循环里生效，这里不会重复截断。
  const cap = s.kind === 'chain' ? undefined : 'maxTargets' in s ? s.maxTargets : undefined;
  if (cap !== undefined && hits.length > cap) {
    // 超出上限时取最近的几个 —— 规格书未规定选取规则，就近是最可预测的
    hits = [...hits]
      .sort((a, b) => distance2D(q.origin, a.position) - distance2D(q.origin, b.position))
      .slice(0, cap);
  }
  return hits;
};

// ── 5.4 六类瞄准的分类判定 ───────────────────────────────────────

/** 该技能是否需要玩家先放置地面指示器 */
export const needsGroundPlacement = (skill: SkillDef): boolean =>
  skill.targeting === Targeting.Ground;

/** 该技能是否依赖角色面向而非目标（方向技能）*/
export const isDirectional = (skill: SkillDef): boolean =>
  skill.targeting === Targeting.Line ||
  skill.targeting === Targeting.Cone ||
  skill.targeting === Targeting.Projectile;

/** 该技能是否需要一个硬目标 */
export const needsHardTarget = (skill: SkillDef): boolean =>
  skill.targeting === Targeting.Direct;

/**
 * 该技能是否**完全不需要目标**。
 *
 * 5.6：自身技能和自身中心技能可直接使用。方向技能也不依赖硬目标（5.4）。
 * 少了这个判断，冰霜新星这类自身中心技能会掉进「直接目标」分支并报「需要目标」——
 * 而规格书明确说它们不需要选择目标。
 */
export const usesNoTarget = (skill: SkillDef): boolean =>
  skill.targeting === Targeting.Self ||
  skill.targeting === Targeting.SelfCenter ||
  isDirectional(skill);

/**
 * 5.4 六类瞄准的形状原点。
 * 自身中心以施法者为圆心，地面技能以落点为圆心，方向技能从施法者出发。
 */
export const shapeOrigin = (
  caster: CombatEntity,
  skill: SkillDef,
  groundPoint?: Vec3,
): Vec3 => {
  if (skill.targeting === Targeting.Ground && groundPoint) return { ...groundPoint };
  return { ...caster.position };
};

/** 方向技能的朝向向量，供客户端画预览 */
export const directionOf = (caster: CombatEntity): Vec3 => yawToDir(caster.yaw);
