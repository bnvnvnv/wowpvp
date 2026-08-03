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
import type { DrCategory, School } from '../../types/enums.js';
import type { EntityId } from '../../types/ids.js';
import type { CombatEntity } from '../entity.js';
import type { World } from '../world.js';
import type { Vec3 } from '../../math/vec3.js';
import type { AuraStore } from '../aura.js';
import type { CastingStore } from '../casting.js';
import type { DrStore } from '../dr.js';
import type { GroundArea, Trap } from '../groundArea.js';
import type { MovementState } from '../movement.js';
import type { ProjectileStore } from '../projectile.js';

/**
 * 一次效果结算产生的可观测结果，供网络层广播、HUD 播特效、战后统计记账。
 *
 * ★ 16.x 的战后统计是这个事件流的**纯折叠**（见 sim/stats.ts）——
 *   统计不往任何战斗系统里插钩子，所以一个统计口径写错也不可能改变对局结果。
 *   代价是每项统计需要的信息都必须出现在事件里，下面几个字段就是为此存在的。
 */
export type CombatEvent =
  | { t: 'damage'; sourceId: EntityId; targetId: EntityId; amount: number; school: School
      absorbed: number; overkill: number; immune: boolean
      /**
       * 16.2「护甲减少伤害」：本次伤害里被**装备**（武器 + 护甲）挡掉的量。
       * 与防御技能挡掉的量分开记 —— 否则圣盾术的功劳会记到板甲头上。
       */
      preventedByEquipment: number
      /**
       * 8.x：这一发被完全规避的方式。815 行要求命中反馈能区分
       * 「伤害 / 治疗 / **格挡** / **闪避** / 免疫 / 驱散」。
       */
      avoided?: 'dodge' | 'parry' | 'block'
      /** 吸收该伤害的护盾分别来自谁。16.1 的「吸收」要记给下盾的人，不是被打的人 */
      absorbedBy?: readonly { sourceId: EntityId; amount: number }[]
      /**
       * 这一发是不是暴击。★ 只在 true 时才带这个字段 ——
       * 事件对象会被 JSON 序列化广播，恒带一个 false 是白付带宽。
       * 规格书没有暴击机制，见 docs/10 已知偏差 #7。
       */
      crit?: boolean }
  | { t: 'heal'; sourceId: EntityId; targetId: EntityId; amount: number; overheal: number
      /** 治疗暴击。语义同 damage.crit：只在 true 时携带 */
      crit?: boolean }
  | { t: 'auraApplied'; sourceId: EntityId; targetId: EntityId; auraId: string; duration: number
      /** 8.2 递减系数，0.5 表示这次只有一半时长。HUD 要显示（15.2）*/
      drFactor?: number
      auraKind: 'buff' | 'debuff'
      /** 8.2 递减链。有值即表示这是一次**控制**，16.1 的「控制时间」只认它 */
      drCategory?: DrCategory }
  | { t: 'auraRemoved'; targetId: EntityId; auraId: string; reason: string }
  | { t: 'immune'; targetId: EntityId; auraId?: string; why: 'dr' | 'flag' }
  | { t: 'shieldBroken'; targetId: EntityId; auraId: string }
  | { t: 'dispelled'; sourceId: EntityId; targetId: EntityId; auraId: string
      auraKind: 'buff' | 'debuff'
      /** 有值表示驱散掉的是一个控制 → 16.1 的「解除控制」*/
      drCategory?: DrCategory }
  | { t: 'resource'; targetId: EntityId; resource: string; delta: number }
  | { t: 'displaced'; targetId: EntityId; to: { x: number; y: number; z: number }; kind: string }
  | { t: 'death'; targetId: EntityId; killerId?: EntityId }
  /**
   * 一次专用打断的**尝试**。7.2 规定落空也进冷却，所以失败同样要发事件 ——
   * 16.1 的「打断成功率」需要分母，只发成功的话算不出来。
   */
  | { t: 'interrupt'; sourceId: EntityId; targetId?: EntityId; success: boolean
      /** 产生的学派锁定。物理射击被打断时没有（验收 #16）*/
      school?: School; lockedUntil?: number
      reason?: 'notCasting' | 'notInterruptible' | 'targetMissing' }
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
  /**
   * 移动状态表（`tickWorld` 第 2 步在推进的那一张）。位移效果需要它。
   *
   * ★★ 不同步移动状态的位移是**死代码**：`tickWorld` 每 tick 都用
   *   `MovementState` 的积分结果覆盖 `entity.position`，只写后者的话
   *   下一 tick（50ms 后）就被抹回原地 —— 冲锋/闪现/击退/拉拽全部如此，
   *   而且**所有断言都是绿的**，因为效果测试从不跑第二个 tick。
   *
   * 可选是因为纯效果测试不需要构造移动系统；没有条目的实体
   * （位置由别处驱动，如试验场玩家）也仍然只写 `entity.position`，
   * 由驱动方消费 `displaced` 事件自行同步。
   */
  movement?: Map<EntityId, MovementState>;
  /** 地面区域与陷阱容器 */
  groundAreas: GroundArea[];
  traps: Trap[];
  /** 施法者 */
  source: CombatEntity;
  /** 地面技能的落点。★ 已由 resolveGroundPlacement 钳制并校验过合法性 */
  groundPoint?: Vec3;
  /** 触发这次结算的技能 id，用于日志与统计 */
  skillId: string;
  /**
   * 这次结算是不是**周期跳**（DoT / HoT / 地面区域 tick）。
   * ★ 只有暴击在读它。放在 ctx 而不是 EffectDef 上，是因为同一个
   *   `{kind:'damage'}` 既会被技能直接结算、也会被光环周期结算 ——
   *   区别在**谁调的**，不在效果本身。
   */
  periodic?: boolean;
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
