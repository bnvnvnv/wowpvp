/**
 * 投射物与地面区域。规格书 6.6 / 5.4，验收 #12。
 *
 * 6.6 定义了**三类**，它们的反制方式完全不同，实现上必须分开：
 *
 *   锁定投射物  释放瞬间确认命中资格，飞行只是表现。
 *               目标释放后移动不会使其自然落空；免疫、吸收、反射仍可生效。
 *               例：火球、审判、风暴之锤、普通箭矢
 *
 *   碰撞投射物  沿真实方向飞行并碰撞，可以被躲避、被墙体阻挡、命中第一个目标。
 *               例：穿透箭、直线魔法弹
 *
 *   延迟落点    目标地面区域在延迟后结算。落点边界和倒计时**全程可见**（14.3）——
 *               这是它唯一的反制方式，绝不能隐藏。
 *               例：陨石、箭雨
 */

import { firstProjectileHit, segmentClipT } from '../math/geometry.js';
import { addScaled, distance2D, normalize, sub, vec3, type Vec3 } from '../math/vec3.js';
import type { EffectDef } from '../data/schema.js';
import { TargetFilter } from '../types/enums.js';
import type { EntityId, SkillId } from '../types/ids.js';
import { hitCircleOf, isFriendly, isHostile, isSelectableBy, type CombatEntity } from './entity.js';
import { listEntities, type World } from './world.js';

// ── 锁定投射物 ───────────────────────────────────────────────────

/**
 * 锁定投射物。
 *
 * ★ 关键语义：`targetId` 在**创建时**就已确认命中资格。之后目标怎么跑都会被命中，
 *   飞行过程纯粹是视觉表现。这不是偷懒 —— 6.6 明确规定「目标释放后移动不会使其
 *   自然落空」。想躲开锁定投射物必须用免疫、吸收或反射，不能用走位。
 */
export interface HomingProjectile {
  kind: 'homing';
  id: number;
  skillId: SkillId;
  sourceId: EntityId;
  targetId: EntityId;
  /** 当前视觉位置 */
  position: Vec3;
  speed: number;
  /** 到达并结算的绝对时间。到点即结算，与视觉位置无关 */
  impactAt: number;
  onHit: readonly EffectDef[];
}

// ── 碰撞投射物 ───────────────────────────────────────────────────

/**
 * 碰撞投射物。按真实轨迹推进，命中第一个有效目标或被墙挡下。
 * `pierce` 为 true 时穿透继续飞（穿透箭）。
 */
export interface CollidingProjectile {
  kind: 'colliding';
  id: number;
  skillId: SkillId;
  sourceId: EntityId;
  position: Vec3;
  /** 单位方向向量 */
  direction: Vec3;
  speed: number;
  radius: number;
  /** 最大飞行距离，超过即消失 */
  maxDistance: number;
  /** 已飞行距离 */
  traveled: number;
  pierce: boolean;
  /** 已命中的目标，避免穿透时重复结算同一个 */
  hitTargets: Set<EntityId>;
  onHit: readonly EffectDef[];
}

// ── 延迟落点 ─────────────────────────────────────────────────────

/**
 * 延迟落点（陨石、箭雨）。
 * ★ 14.3：落点边界和倒计时**全程可见**。`createdAt` / `impactAt` 都要发给客户端。
 */
export interface DelayedImpact {
  kind: 'delayedImpact';
  id: number;
  skillId: SkillId;
  sourceId: EntityId;
  center: Vec3;
  radius: number;
  createdAt: number;
  impactAt: number;
  /**
   * ★★ 落地那一刻**重新选目标**时的阵营判据（8.1「友军伤害默认关闭」）。
   *
   *   这是另外两类投射物没有的问题：锁定弹体在释放瞬间就定死了 `targetId`、
   *   碰撞弹体每步都过 `isSelectableBy`，只有延迟落点是「1.5 秒后照着圆圈
   *   现场圈人」—— 施法期 `aiming.ts` 的 `TargetFilter` 到那时早已过去。
   *   X13 把一条**硬控**（陨星落地击晕）放上了这条路之后，
   *   「把陨星丢在自己脚下」会把法师自己和队友一起晕 1.5 秒。
   *
   * ★ 与施法期同源：由 `delayedGroundImpact` 处理器从 `SkillDef.targetFilter`
   *   带过来，不在这里另立一套判据。缺省 `Enemy`。
   */
  targetFilter: TargetFilter;
  onImpact: readonly EffectDef[];
}

export type Projectile = HomingProjectile | CollidingProjectile | DelayedImpact;

// ── 容器 ─────────────────────────────────────────────────────────

export interface ProjectileStore {
  items: Projectile[];
  nextId: number;
}

export const createProjectileStore = (): ProjectileStore => ({ items: [], nextId: 1 });

export interface SpawnHomingOpts {
  skillId: SkillId;
  source: CombatEntity;
  target: CombatEntity;
  speed: number;
  onHit: readonly EffectDef[];
}

export const spawnHoming = (
  world: World,
  store: ProjectileStore,
  o: SpawnHomingOpts,
): HomingProjectile => {
  const dist = distance2D(o.source.position, o.target.position);
  const p: HomingProjectile = {
    kind: 'homing',
    id: store.nextId++,
    skillId: o.skillId,
    sourceId: o.source.id,
    targetId: o.target.id,
    position: vec3(o.source.position.x, o.source.position.y + 1.2, o.source.position.z),
    speed: o.speed,
    // 命中时间由释放瞬间的距离决定，目标之后跑多远都不改变它
    impactAt: world.time + Math.max(0.05, dist / o.speed),
    onHit: o.onHit,
  };
  store.items.push(p);
  return p;
};

export interface SpawnCollidingOpts {
  skillId: SkillId;
  source: CombatEntity;
  /** 发射方向（会被归一化）。通常来自角色 yaw，不是镜头 yaw */
  direction: Vec3;
  speed: number;
  radius: number;
  maxDistance: number;
  pierce: boolean;
  onHit: readonly EffectDef[];
}

export const spawnColliding = (
  _world: World,
  store: ProjectileStore,
  o: SpawnCollidingOpts,
): CollidingProjectile => {
  const p: CollidingProjectile = {
    kind: 'colliding',
    id: store.nextId++,
    skillId: o.skillId,
    sourceId: o.source.id,
    position: vec3(o.source.position.x, o.source.position.y + 1.2, o.source.position.z),
    direction: normalize(vec3(o.direction.x, 0, o.direction.z)),
    speed: o.speed,
    radius: o.radius,
    maxDistance: o.maxDistance,
    traveled: 0,
    pierce: o.pierce,
    hitTargets: new Set(),
    onHit: o.onHit,
  };
  store.items.push(p);
  return p;
};

export const spawnDelayedImpact = (
  world: World,
  store: ProjectileStore,
  o: {
    skillId: SkillId;
    source: CombatEntity;
    center: Vec3;
    radius: number;
    delay: number;
    /** 不填按 `Enemy`（8.1 友军伤害默认关闭）。治疗型落点将来传 `Ally` */
    targetFilter?: TargetFilter;
    onImpact: readonly EffectDef[];
  },
): DelayedImpact => {
  const p: DelayedImpact = {
    kind: 'delayedImpact',
    id: store.nextId++,
    skillId: o.skillId,
    sourceId: o.source.id,
    center: { ...o.center },
    radius: o.radius,
    createdAt: world.time,
    impactAt: world.time + o.delay,
    targetFilter: o.targetFilter ?? TargetFilter.Enemy,
    onImpact: o.onImpact,
  };
  store.items.push(p);
  return p;
};

// ── 结算 ─────────────────────────────────────────────────────────

export interface ProjectileHitEvent {
  projectile: Projectile;
  /** 单体命中的目标；延迟落点为范围内全部目标 */
  targets: CombatEntity[];
  effects: readonly EffectDef[];
}

/**
 * 阵营判据。**与施法期同一套语义**（`aiming.ts` 的 `collectShapeTargets`）——
 * 分支逐条对齐，是为了让「落地时圈到的人」永远是「施法时会圈到的人」的子集。
 *
 * ★ 这里刻意**不做** `isSelectableBy`（潜行 / 不可选中）：地面区域 tick
 *   （`groundArea.ts` 的区域分支）同样只看阵营，范围伤害照到潜行者身上是
 *   本仓库既有的口径。两处保持一致，不在这里单独发明第三种。
 */
const matchesFilter = (
  filter: TargetFilter,
  shooter: CombatEntity,
  e: CombatEntity,
): boolean => {
  switch (filter) {
    case TargetFilter.Enemy: return isHostile(shooter, e);
    case TargetFilter.Ally: return isFriendly(shooter, e);
    case TargetFilter.Self: return e.id === shooter.id;
    case TargetFilter.Any: return true;
    default: return false;
  }
};

/**
 * 推进所有投射物一个 tick，返回本 tick 产生的命中事件。
 *
 * 效果的实际结算不在这里 —— 那是 M4 的效果系统。这里只负责
 * 「谁被打中了」，保持职责单一，也让这个模块可以脱离效果系统单测。
 */
export const tickProjectiles = (
  world: World,
  store: ProjectileStore,
  dt: number,
): ProjectileHitEvent[] => {
  const events: ProjectileHitEvent[] = [];
  const survivors: Projectile[] = [];
  /**
   * ★ P1（技术债总账）：本函数只收集命中事件、不结算效果也不生成实体，
   *   实体集在函数期间稳定 —— 列表提到顶层，弹体 × 子步的嵌套循环
   *   不再各自 spread。`.alive`/`.position` 仍逐次现读，行为逐位不变。
   */
  const entities = listEntities(world);

  for (const p of store.items) {
    switch (p.kind) {
      case 'homing': {
        // 视觉位置向目标推进；命中与否只看时间
        const target = world.entities.get(p.targetId);
        if (target) {
          const to = sub(
            vec3(target.position.x, target.position.y + 1.2, target.position.z),
            p.position,
          );
          const step = Math.min(p.speed * dt, Math.hypot(to.x, to.y, to.z));
          p.position = addScaled(p.position, normalize(to), step);
        }
        if (world.time >= p.impactAt) {
          // ★ 6.6：目标移动不会使其自然落空。这里不做任何距离/视线复查。
          // 免疫、吸收、反射由 M4 的效果系统在结算时处理。
          if (target && target.alive) {
            events.push({ projectile: p, targets: [target], effects: p.onHit });
          }
        } else {
          survivors.push(p);
        }
        break;
      }

      case 'colliding': {
        const step = p.speed * dt;
        const from = p.position;
        const to = addScaled(from, p.direction, step);

        // 先看墙：墙体会把这一段轨迹截断（6.6「可以被墙体阻挡」）
        const clip = segmentClipT(from, to, world.obstacles);
        const hitWall = clip < 1;
        const clipped = hitWall ? addScaled(from, p.direction, step * clip) : to;

        const shooter = world.entities.get(p.sourceId);
        const candidates = entities.filter(
          (e) =>
            e.id !== p.sourceId &&
            e.alive &&
            !p.hitTargets.has(e.id) &&
            (shooter ? isSelectableBy(e, shooter) : true),
        );
        const hit = firstProjectileHit(from, clipped, p.radius, candidates.map(hitCircleWithId));

        let alive = true;
        if (hit) {
          const target = candidates.find((e) => e.id === hit.target.entityId)!;
          p.hitTargets.add(target.id);
          events.push({ projectile: p, targets: [target], effects: p.onHit });
          // 非穿透投射物命中即消失；穿透箭继续飞
          if (!p.pierce) alive = false;
        }

        p.position = clipped;
        p.traveled += step * (hitWall ? clip : 1);
        if (hitWall || p.traveled >= p.maxDistance) alive = false;

        if (alive) survivors.push(p);
        break;
      }

      case 'delayedImpact': {
        if (world.time >= p.impactAt) {
          /**
           * ★★ 8.1「友军伤害默认关闭」：落地是**第二次选目标**，阵营判据
           *   必须在这里再过一遍 —— 施法期 aiming.ts 的那次已经是 1.5 秒前
           *   的事了（见 `DelayedImpact.targetFilter` 的注释）。
           *   施法者查不到（已离场）时按旧行为放行：弹体已经在飞，
           *   这时候整发吞掉比多打几个人更难解释。
           */
          const shooter = world.entities.get(p.sourceId);
          const targets = entities.filter(
            (e) =>
              e.alive &&
              distance2D(e.position, p.center) <= p.radius + e.radius &&
              (shooter ? matchesFilter(p.targetFilter, shooter, e) : true),
          );
          events.push({ projectile: p, targets, effects: p.onImpact });
        } else {
          survivors.push(p);
        }
        break;
      }
    }
  }

  store.items = survivors;
  return events;
};

/** 给 geometry 的 HitCircle 带上实体 id，命中后好反查 */
interface WithId {
  position: Vec3;
  radius: number;
  height: number;
  entityId: EntityId;
}
const hitCircleWithId = (e: CombatEntity): WithId => ({
  ...hitCircleOf(e),
  entityId: e.id,
});
