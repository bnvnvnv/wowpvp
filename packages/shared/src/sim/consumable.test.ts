/**
 * 技术债 #6：消耗品使用路径（10.1）。
 *
 * ★★ 这条技术债此前被记作「没有使用路径」，M11 核查发现**缺口更大**：
 *   `ConsumableDef` 这个类型根本不存在 —— 没有名字、没有效果、没有持续时间。
 *   `DropKind` 里的 `'consumable'`、`Loadout.consumables`、
 *   `stats.recordItemBuff()` 都只是**留好的空位**，从没有人往里填过东西。
 *
 *   后果是已知偏差 #2：16.2 的「增益期间击杀」**结构上恒为 0** ——
 *   不是统计写错了，是「增益期间」这个状态从来不存在。
 *
 *   所以这里测的是「这条链现在真的通了」，而不是某个函数的边界。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { CONSUMABLES, getConsumable } from '../data/consumables.js';
import { getSkill, mage, warrior } from '../data/index.js';
import { EQUIP } from '../constants/combat.js';
import { TEAM_BLUE, TEAM_RED } from '../types/ids.js';
import { vec3 } from '../math/vec3.js';
import { createAuraStore, aurasOf, type AuraStore } from './aura.js';
import { createArsenalStore, createPickupStore } from './arsenal.js';
import { createCastingStore } from './casting.js';
import { createDrStore } from './dr.js';
import { createEntity, type CombatEntity } from './entity.js';
import { createGroundStore } from './groundArea.js';
import {
  addConsumable, createLoadout, createLoadoutStore, createSwapStore, takeConsumable,
} from './loadout.js';
import { createProjectileStore } from './projectile.js';
import { createStats, registerPlayer, type StatsStore } from './stats.js';
import { tickWorld, type TickDeps } from './tick.js';
import { addEntity, allocEntityId, createWorld, type World } from './world.js';
import { ArenaPreset } from '../types/enums.js';

let world: World;
let auras: AuraStore;
let stats: StatsStore;
let loadouts: ReturnType<typeof createLoadoutStore>;
let player: CombatEntity;

const deps = (over: Partial<TickDeps> = {}): TickDeps => ({
  world, auras,
  dr: createDrStore(),
  ground: createGroundStore(),
  projectiles: createProjectileStore(),
  casting: createCastingStore(),
  loadouts,
  swaps: createSwapStore(),
  pickups: createPickupStore(),
  arsenal: createArsenalStore(ArenaPreset.Armed),
  movement: new Map(),
  inputs: new Map(),
  getSkill,
  stats,
  ...over,
});

beforeEach(() => {
  world = createWorld([]);
  auras = createAuraStore();
  stats = createStats();
  loadouts = createLoadoutStore();
  player = addEntity(world, createEntity(allocEntityId(world), mage, TEAM_RED, vec3(0, 0, 0)));
  addEntity(world, createEntity(allocEntityId(world), warrior, TEAM_BLUE, vec3(0, 0, 3)));
  loadouts.set(player.id, createLoadout(player.classId));
  registerPlayer(stats, player);
});

describe('目录', () => {
  it('★ 至少有一个消耗品，且每个都能按 id 查到', () => {
    expect(CONSUMABLES.length).toBeGreaterThan(0);
    for (const c of CONSUMABLES) {
      expect(getConsumable(c.id as string), `查不到 ${c.id}`).toBeDefined();
      expect(c.buffSeconds, `${c.id} 的增益窗口必须为正`).toBeGreaterThan(0);
      expect(c.effects.length, `${c.id} 没有任何效果`).toBeGreaterThan(0);
    }
  });
});

describe('携带上限（10.6）', () => {
  it('★ 满槽后拿不走，而不是顶掉旧的', () => {
    const l = loadouts.get(player.id)!;
    for (let i = 0; i < EQUIP.MAX_CONSUMABLES; i++) {
      expect(addConsumable(l, CONSUMABLES[0]!.id)).toBe(true);
    }
    expect(
      addConsumable(l, CONSUMABLES[0]!.id),
      '满槽还能塞进去 —— 那等于替玩家做了丢弃决定',
    ).toBe(false);
    expect(l.consumables).toHaveLength(EQUIP.MAX_CONSUMABLES);
  });
});

describe('取用门禁', () => {
  it('★ 硬控制期间取不出来（7.3）', () => {
    const l = loadouts.get(player.id)!;
    addConsumable(l, CONSUMABLES[0]!.id);
    player.flags.stunned = true;
    expect(takeConsumable(player, l, 0)).toBeUndefined();
    expect(l.consumables, '被拒绝时不该消耗掉槽位').toHaveLength(1);
  });

  it('★ 空槽位返回 undefined', () => {
    const l = loadouts.get(player.id)!;
    expect(takeConsumable(player, l, 0)).toBeUndefined();
  });
});

describe('★★ 使用：效果由 tickWorld 结算', () => {
  /**
   * ★★ 这是整条链的关键断言：消耗品的效果**由 tick 结算**，
   *   而不是调用方自己调 `resolveEffects()`。后者会开出第二个结算出口 ——
   *   A2 的教训正是「第二个出口会静默地少做一半事」。
   */
  it('★★ 通过 consumableRequests 使用后，光环真的挂上了', () => {
    const l = loadouts.get(player.id)!;
    const def = CONSUMABLES[0]!;
    addConsumable(l, def.id);

    const before = aurasOf(auras, player.id).length;
    const r = tickWorld(
      deps({ consumableRequests: new Map([[player.id, 0]]) }),
      0.05,
    );

    expect(r.consumables, '结果里没有记录这次使用').toHaveLength(1);
    expect(r.consumables[0]!.consumableId).toBe(def.id);
    expect(l.consumables, '用掉的槽位没有被清空').toHaveLength(0);
    expect(
      aurasOf(auras, player.id).length,
      '效果没有结算 —— 光环没有挂上',
    ).toBeGreaterThan(before);
  });

  /**
   * ★★ 已知偏差 #2 就是这一条：`killsDuringBuff` 此前**结构上恒为 0**，
   *   因为「增益期间」这个状态从不存在。现在它有真实来源了。
   */
  it('★★ 使用后登记了增益窗口（关闭已知偏差 #2 的前提）', () => {
    const l = loadouts.get(player.id)!;
    const def = CONSUMABLES[0]!;
    addConsumable(l, def.id);

    expect(stats.itemBuffUntil.get(player.id), '用之前不该有窗口').toBeUndefined();

    tickWorld(deps({ consumableRequests: new Map([[player.id, 0]]) }), 0.05);

    const until = stats.itemBuffUntil.get(player.id);
    expect(until, '增益窗口没有被登记 —— killsDuringBuff 仍然会恒为 0').toBeDefined();
    expect(until!).toBeCloseTo(world.time + def.buffSeconds, 6);
  });

  it('★ 空槽位请求不产生任何事情（不崩、不发事件）', () => {
    const r = tickWorld(deps({ consumableRequests: new Map([[player.id, 5]]) }), 0.05);
    expect(r.consumables).toEqual([]);
  });

  it('★ 死人用不了', () => {
    const l = loadouts.get(player.id)!;
    addConsumable(l, CONSUMABLES[0]!.id);
    player.alive = false;

    const r = tickWorld(deps({ consumableRequests: new Map([[player.id, 0]]) }), 0.05);
    expect(r.consumables).toEqual([]);
    expect(l.consumables, '死了还是把道具用掉了').toHaveLength(1);
  });

  it('★ 使用后进入冷却', () => {
    const l = loadouts.get(player.id)!;
    const def = CONSUMABLES.find((c) => c.cooldown > 0)!;
    addConsumable(l, def.id);

    tickWorld(deps({ consumableRequests: new Map([[player.id, 0]]) }), 0.05);
    expect(player.cooldowns.get(def.id as never)).toBeCloseTo(world.time + def.cooldown, 6);
  });
});

describe('★ 不传 stats 也不该崩（纯规则测试不构造统计容器）', () => {
  it('★ stats 缺席时使用消耗品仍然生效', () => {
    const l = loadouts.get(player.id)!;
    addConsumable(l, CONSUMABLES[0]!.id);
    const d = deps({ consumableRequests: new Map([[player.id, 0]]) });
    delete (d as { stats?: StatsStore }).stats;

    expect(() => tickWorld(d, 0.05)).not.toThrow();
    expect(aurasOf(auras, player.id).length).toBeGreaterThan(0);
  });
});
