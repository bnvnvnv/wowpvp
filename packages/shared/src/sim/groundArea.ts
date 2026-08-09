/**
 * 持续地面区域与陷阱。规格书 5.4 / 6.4 / 14.3。
 *
 * 两类实体在规则上完全不同：
 *   地面区域（暴风雪、烟雾弹、照明弹、凛冬领域）
 *     —— 持续存在，周期结算，部分带功能性效果（阻挡选中、揭露潜行）
 *   陷阱（冰冻陷阱）
 *     —— 布置需要时间，首个进入的敌人触发，触发后消失
 *
 * ★ 14.3：地面危险区域的**真实边界**在整个有效期内持续显示，
 *   装饰粒子可以淡出，**边界不能消失**。所以 center/radius/expiresAt
 *   必须完整发给客户端 —— 它们不是内部实现细节。
 */

import { distance2D } from '../math/vec3.js';
import type { Vec3 } from '../math/vec3.js';
import type { EffectDef } from '../data/schema.js';
import type { EntityId } from '../types/ids.js';
import type { CombatEntity } from './entity.js';
import { isSelectableBy } from './entity.js';
import { listEntities, type World } from './world.js';

export interface GroundArea {
  id: number;
  /** 视觉键，客户端按它选表现 */
  areaId: string;
  skillId: string;
  sourceId: EntityId;
  center: Vec3;
  radius: number;
  createdAt: number;
  expiresAt: number;
  tickInterval: number;
  nextTickAt: number;
  onTick: readonly EffectDef[];
  /** 5.4 烟雾弹：区域外单位不能直接选中区域内目标 */
  blocksTargetingFromOutside: boolean;
  /** 9.5 照明弹：揭露潜行和隐身单位 */
  revealsStealth: boolean;
  /** 累计命中次数，供 onNthHit 使用（凛冬领域）*/
  hitCounts?: Map<EntityId, number>;
}

export interface Trap {
  id: number;
  skillId: string;
  sourceId: EntityId;
  center: Vec3;
  triggerRadius: number;
  /** 布置完成时刻。之前踩上去不触发（9.5：0.8 秒后布置完成）*/
  armedAt: number;
  expiresAt: number;
  onTrigger: readonly EffectDef[];
  singleTrigger: boolean;
}

export interface GroundStore {
  areas: GroundArea[];
  traps: Trap[];
}

export const createGroundStore = (): GroundStore => ({ areas: [], traps: [] });

/**
 * 掐掉某施法者某技能的全部存活区域 —— 7.1「打断/移动/控制停止**剩余引导**」
 * 的兑现（暴风雪引导被打断时雪要停，X10 追加轮）。
 * ★ 按 (sourceId, skillId) 定位：引导技能有冷却，同一施法者不存在两片
 *   并行的同名区域；已过期的不碰（幂等）。
 */
export const expireGroundAreasFor = (
  store: GroundStore,
  sourceId: EntityId,
  skillId: string,
  now: number,
): void => {
  for (const a of store.areas) {
    if (a.sourceId === sourceId && a.skillId === skillId && a.expiresAt > now) {
      a.expiresAt = now;
    }
  }
};

export interface GroundTickEvent {
  kind: 'areaTick' | 'trapTrigger';
  sourceId: EntityId;
  skillId: string;
  targets: CombatEntity[];
  effects: readonly EffectDef[];
}

/**
 * 推进地面区域与陷阱一个 tick，返回需要结算的效果。
 * 与 aura.tickAuras 同理：只产出「该结算什么」，不自己结算。
 */
export const tickGround = (world: World, store: GroundStore): GroundTickEvent[] => {
  const out: GroundTickEvent[] = [];
  const now = world.time;
  /**
   * ★ P1（技术债总账）：本函数只**收集**该结算的效果、不结算也不生成实体，
   *   实体集在函数期间稳定 —— 列表提到顶层，区域 × 补跳 × 陷阱的三层循环
   *   不再各自 spread。`.alive`/`.position` 仍逐次现读，行为逐位不变。
   */
  const entities = listEntities(world);

  // ── 地面区域 ──
  store.areas = store.areas.filter((a) => {
    if (now >= a.expiresAt) return false;

    // 9.5 照明弹：揭露范围内的潜行单位
    if (a.revealsStealth) {
      for (const e of entities) {
        if (e.flags.stealthed && distance2D(e.position, a.center) <= a.radius) {
          e.flags.stealthRevealed = true;
        }
      }
    }

    if (a.tickInterval > 0 && now >= a.nextTickAt && a.onTick.length > 0) {
      while (now >= a.nextTickAt && a.nextTickAt < a.expiresAt) {
        const source = world.entities.get(a.sourceId);
        const targets = entities.filter(
          (e) =>
            e.alive &&
            e.id !== a.sourceId &&
            (source ? e.team !== source.team : true) &&
            distance2D(e.position, a.center) <= a.radius + e.radius,
        );
        if (targets.length > 0) {
          out.push({ kind: 'areaTick', sourceId: a.sourceId, skillId: a.skillId, targets, effects: a.onTick });
        }
        a.nextTickAt += a.tickInterval;
      }
    }
    return true;
  });

  // ── 陷阱 ──
  store.traps = store.traps.filter((t) => {
    if (now >= t.expiresAt) return false;
    if (now < t.armedAt) return true; // 还没布置完成

    const source = world.entities.get(t.sourceId);
    const stepped = entities.find(
      (e) =>
        e.alive &&
        e.id !== t.sourceId &&
        (source ? e.team !== source.team : true) &&
        (source ? isSelectableBy(e, source) : true) &&
        distance2D(e.position, t.center) <= t.triggerRadius + e.radius,
    );
    if (!stepped) return true;

    out.push({
      kind: 'trapTrigger', sourceId: t.sourceId, skillId: t.skillId,
      targets: [stepped], effects: t.onTrigger,
    });
    // 9.5「首个敌人」：触发即消失
    return !t.singleTrigger;
  });

  return out;
};

/**
 * 5.4 烟雾弹：`viewer` 能否选中 `target`。
 * 区域外的单位不能直接选中区域内的目标；**进入区域或使用范围技能仍可攻击**。
 */
export const isTargetingBlockedBySmoke = (
  store: GroundStore,
  viewer: CombatEntity,
  target: CombatEntity,
): boolean =>
  store.areas.some(
    (a) =>
      a.blocksTargetingFromOutside &&
      distance2D(target.position, a.center) <= a.radius &&
      distance2D(viewer.position, a.center) > a.radius,
  );

/** 回合重置时清空（2.1 / 验收 #37）*/
export const clearGround = (store: GroundStore): void => {
  store.areas = [];
  store.traps = [];
};
