/**
 * 效果注册表。docs/02-architecture.md §4。
 *
 * ★ 加一种全新机制 = **加**一个 `EffectDef` 成员 + **加**一个处理器。
 *   已有代码一行都不用改。
 *
 * ★ `EffectDef` 是可辨识联合，`assertAllEffectsRegistered()` 会在启动时
 *   检查每个 kind 都有处理器 —— 漏注册是**启动即失败**，不是运行到那个技能
 *   才静默无事发生。后者是最难查的一类 bug。
 */

import type { EffectDef } from '../../data/schema.js';
import type { School } from '../../types/enums.js';
import type { EntityId } from '../../types/ids.js';
import type { CombatEntity } from '../entity.js';
import type { World } from '../world.js';
import type { Vec3 } from '../../math/vec3.js';
import type { AuraStore } from '../aura.js';
import type { CastingStore } from '../casting.js';
import type { DrStore } from '../dr.js';
import type { GroundArea, Trap } from '../groundArea.js';
import type { ProjectileStore } from '../projectile.js';

/** 一次效果结算产生的可观测结果，供网络层广播、HUD 播特效、战后统计记账 */
export type CombatEvent =
  | { t: 'damage'; sourceId: EntityId; targetId: EntityId; amount: number; school: School
      absorbed: number; overkill: number; immune: boolean }
  | { t: 'heal'; sourceId: EntityId; targetId: EntityId; amount: number; overheal: number }
  | { t: 'auraApplied'; sourceId: EntityId; targetId: EntityId; auraId: string; duration: number
      /** 8.2 递减系数，0.5 表示这次只有一半时长。HUD 要显示（15.2）*/
      drFactor?: number }
  | { t: 'auraRemoved'; targetId: EntityId; auraId: string; reason: string }
  | { t: 'immune'; targetId: EntityId; auraId?: string; why: 'dr' | 'flag' }
  | { t: 'shieldBroken'; targetId: EntityId; auraId: string }
  | { t: 'dispelled'; sourceId: EntityId; targetId: EntityId; auraId: string }
  | { t: 'resource'; targetId: EntityId; resource: string; delta: number }
  | { t: 'displaced'; targetId: EntityId; to: { x: number; y: number; z: number }; kind: string }
  | { t: 'death'; targetId: EntityId; killerId?: EntityId }
  | { t: 'custom'; handler: string; sourceId: EntityId; targetId?: EntityId };

/** 效果结算上下文。所有处理器共用 */
export interface EffectContext {
  world: World;
  auras: AuraStore;
  dr: DrStore;
  projectiles: ProjectileStore;
  /**
   * 施法状态表。打断效果需要它。
   * 可选是因为纯效果测试（伤害、光环）不需要构造整个施法系统。
   */
  castingStore?: CastingStore;
  /** 地面区域与陷阱容器 */
  groundAreas: GroundArea[];
  traps: Trap[];
  /** 施法者 */
  source: CombatEntity;
  /** 地面技能的落点。★ 已由 resolveGroundPlacement 钳制并校验过合法性 */
  groundPoint?: Vec3;
  /** 触发这次结算的技能 id，用于日志与统计 */
  skillId: string;
  /** 本次结算产生的事件，处理器往里 push */
  events: CombatEvent[];
  /**
   * 递归入口：延迟落点、陷阱、投射物命中都需要再结算一组子效果。
   * 处理器通过它调用，而不是 import 主分发函数 —— 避免循环依赖。
   */
  resolve: (effects: readonly EffectDef[], targets: readonly CombatEntity[]) => void;
}

export type EffectHandler<K extends EffectDef['kind']> = (
  ctx: EffectContext,
  effect: Extract<EffectDef, { kind: K }>,
  targets: readonly CombatEntity[],
) => void;

/**
 * 存储时擦除具体 kind。
 *
 * 这里的 cast 是**局部不健全、全局安全**的：`registerEffect` 的签名保证
 * 写入时 handler 与 kind 匹配，`dispatchEffect` 只用 `effect.kind` 取出对应的那个，
 * 所以取出来的 handler 收到的永远是它声明的那个变体。
 * 类型系统表达不了这条「按 key 关联」的约束，因此显式擦除比到处 any 更可控。
 */
type AnyEffectHandler = (
  ctx: EffectContext,
  effect: EffectDef,
  targets: readonly CombatEntity[],
) => void;

const handlers = new Map<EffectDef['kind'], AnyEffectHandler>();

export const registerEffect = <K extends EffectDef['kind']>(
  kind: K,
  handler: EffectHandler<K>,
): void => {
  handlers.set(kind, handler as unknown as AnyEffectHandler);
};

export const getEffectHandler = (
  kind: EffectDef['kind'],
): AnyEffectHandler | undefined => handlers.get(kind);

/** 已注册的 kind，供自检与文档生成 */
export const registeredKinds = (): EffectDef['kind'][] => [...handlers.keys()];

/**
 * 分发一个效果。
 *
 * 未注册的 kind **抛异常**而不是静默跳过 ——
 * 一个技能悄悄不产生效果比崩溃难查得多。
 */
export const dispatchEffect = (
  ctx: EffectContext,
  effect: EffectDef,
  targets: readonly CombatEntity[],
): void => {
  const h = handlers.get(effect.kind);
  if (!h) {
    throw new Error(
      `效果 kind "${effect.kind}" 没有注册处理器。` +
        `请在 sim/effects/ 下注册它，见 docs/11-contributing.md §4。`,
    );
  }
  h(ctx, effect, targets);
};

/**
 * 启动自检：每个 EffectDef.kind 都要有处理器。
 *
 * `ALL_EFFECT_KINDS` 手工维护，但 `schema.ts` 的联合类型变化时
 * `effects.test.ts` 里的类型断言会强制这里同步更新 —— 见那个文件的注释。
 */
export const ALL_EFFECT_KINDS: readonly EffectDef['kind'][] = [
  'damage',
  'heal',
  'healFromRecentDamage',
  'healPercentMaxHealth',
  'applyAura',
  'removeAura',
  'stun',
  'incapacitate',
  'fear',
  'root',
  'silence',
  'disarm',
  'interrupt',
  'dispel',
  'chargeTo',
  'chargeToAlly',
  'pullTarget',
  'blinkForward',
  'leapBackward',
  'teleportBehindTarget',
  'knockback',
  'spawnGroundArea',
  'delayedGroundImpact',
  'spawnTrap',
  'spawnProjectile',
  'gainResource',
  'spendComboPoints',
  'spendResource',
  'dropFlag',
  'shapeshift',
  'enterStealth',
  'interveneGuard',
  'onNthHit',
  'custom',
];

export const assertAllEffectsRegistered = (): void => {
  const missing = ALL_EFFECT_KINDS.filter((k) => !handlers.has(k));
  if (missing.length > 0) {
    throw new Error(`以下效果 kind 缺少处理器：${missing.join(', ')}`);
  }
};

/** 仅供测试重置 */
export const _clearHandlers = (): void => handlers.clear();
