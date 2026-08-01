/**
 * 效果系统入口。
 *
 * import 这个文件会自动完成全部处理器注册 —— 各处理器模块的副作用即注册。
 * 不要在别处零散 import 单个处理器模块，那会让「注册了哪些」变得不可知。
 */

import type { EffectDef } from '../../data/schema.js';
import type { CombatEntity } from '../entity.js';
import type { AuraStore } from '../aura.js';
import type { DrStore } from '../dr.js';
import type { GroundStore } from '../groundArea.js';
import type { ProjectileStore } from '../projectile.js';
import type { CastingStore } from '../casting.js';
import type { World } from '../world.js';
import type { Vec3 } from '../../math/vec3.js';

import './combat.js';
import './displacement.js';

import {
  assertAllEffectsRegistered,
  dispatchEffect,
  type CombatEvent,
  type EffectContext,
} from './registry.js';

export * from './registry.js';
export {
  dealDamage, dealHeal, applyControl, magnitudeOf, useTrinket, rollCrit,
  setDampening, getDampening, type DampeningState,
} from './combat.js';

// 启动即校验，而不是运行到那个技能才发现漏注册
assertAllEffectsRegistered();

export interface ResolveOptions {
  world: World;
  auras: AuraStore;
  dr: DrStore;
  projectiles: ProjectileStore;
  ground: GroundStore;
  source: CombatEntity;
  skillId: string;
  groundPoint?: Vec3;
  /** 打断效果需要。不传则打断效果静默跳过 */
  castingStore?: CastingStore;
  /** 周期跳结算（DoT/HoT/地面 tick）。见 EffectContext.periodic */
  periodic?: boolean;
}

/**
 * 结算一组效果，返回产生的事件。
 *
 * 递归由 `ctx.resolve` 提供 —— 延迟落点、陷阱触发、投射物命中、
 * 连击点放大都会走它，共用同一个事件数组，所以调用方拿到的是完整时序。
 */
export const resolveEffects = (
  opts: ResolveOptions,
  effects: readonly EffectDef[],
  targets: readonly CombatEntity[],
): CombatEvent[] => {
  const events: CombatEvent[] = [];

  const ctx: EffectContext = {
    world: opts.world,
    auras: opts.auras,
    dr: opts.dr,
    projectiles: opts.projectiles,
    castingStore: opts.castingStore,
    groundAreas: opts.ground.areas,
    traps: opts.ground.traps,
    source: opts.source,
    groundPoint: opts.groundPoint,
    skillId: opts.skillId,
    periodic: opts.periodic,
    events,
    resolve: (sub, subTargets) => {
      for (const e of sub) dispatchEffect(ctx, e, subTargets);
    },
  };

  for (const e of effects) dispatchEffect(ctx, e, targets);
  return events;
};
