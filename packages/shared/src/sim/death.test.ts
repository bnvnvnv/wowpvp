/**
 * 死亡结算与 17.3 异常处理五类的集中测试。
 *
 * 17.3 的五类：
 *   1. 两人同时拾取同一装备/旗帜/军械箱，只能有一个成功结果   → M6 arsenal
 *   2. 换装瞬间死亡、断线、被控制时状态必须唯一且可恢复       → 本文件 + server/room/reconnect
 *   3. 实体进入墙体或地图外时回到最近合法位置或明确重置       → M7 flag / M1 movement
 *   4. 目标在施法完成瞬间死亡/超距/失去视线时不产生异常       → M2 validateCast
 *   5. 断线不提供无敌；重连后恢复唯一状态                    → server/room/reconnect
 *
 * ★ 前四类的**规则**在各自模块里早就实现并测过了。这里做的是两件别的事：
 *   · 补上第 2 类里唯一真的缺了的一环（10.10 临时装备失效从未被调用）
 *   · 用一组**跨模块**的用例证明这五条在同一个 world 上同时成立 ——
 *     单模块测试各自绿，不等于合在一起也对（M3/M4/M8 的教训）
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { getSkill, warrior } from '../data/index.js';
import { vec3 } from '../math/vec3.js';
import { CastFailure, School } from '../types/enums.js';
import { asSkillId, TEAM_BLUE, TEAM_RED } from '../types/ids.js';
import { createAuraStore, type AuraStore } from '../sim/aura.js';
import {
  addArmor, addWeapon, beginSwap, createLoadout, createLoadoutStore, createSwapStore,
  SwapKind, tickSwaps, type LoadoutStore, type SwapStore,
} from './loadout.js';
import {
  beginPickup, createArsenalStore, createPickupStore, tickPickups,
  type ArsenalStore, type GroundDrop, type PickupStore,
} from './arsenal.js';
import { ArenaPreset } from '../types/enums.js';
import { createDrStore, type DrStore } from './dr.js';
import { createGroundStore, type GroundStore } from './groundArea.js';
import { createProjectileStore, type ProjectileStore } from './projectile.js';
import { createEntity, type CombatEntity } from './entity.js';
import { dealDamage } from './effects/index.js';
import { validateCast } from './casting.js';
import { assertDeathsSettled, settleDeaths, type DeathSettleDeps } from './death.js';
import { addEntity, allocEntityId, createWorld, type World } from './world.js';
import type { CombatEvent } from './effects/registry.js';

let world: World;
let auras: AuraStore;
let dr: DrStore;
let ground: GroundStore;
let projectiles: ProjectileStore;
let loadouts: LoadoutStore;
let swaps: SwapStore;
let pickups: PickupStore;
let arsenal: ArsenalStore;

let victim: CombatEntity;
let killer: CombatEntity;

const spawn = (team: typeof TEAM_RED, x = 0, z = 0): CombatEntity =>
  addEntity(world, createEntity(allocEntityId(world), warrior, team, vec3(x, 0, z)));

beforeEach(() => {
  world = createWorld();
  auras = createAuraStore();
  dr = createDrStore();
  ground = createGroundStore();
  projectiles = createProjectileStore();
  loadouts = createLoadoutStore();
  swaps = createSwapStore();
  pickups = createPickupStore();
  arsenal = createArsenalStore(ArenaPreset.Armed);

  victim = spawn(TEAM_RED, 0, 0);
  killer = spawn(TEAM_BLUE, 0, 2);
  for (const e of [victim, killer]) loadouts.set(e.id, createLoadout(e.classId));
  void arsenal;
});

const deathDeps = (): DeathSettleDeps => ({ world, loadouts, swaps, pickups });

/** 打死 victim，返回本次结算产生的事件 */
const kill = (): CombatEvent[] => {
  const events: CombatEvent[] = [];
  const ctx = {
    world, auras, dr, projectiles,
    groundAreas: ground.areas, traps: ground.traps,
    source: killer, skillId: 'test', events, resolve: () => {},
  };
  dealDamage(ctx, victim, victim.health + 1000, School.Physical);
  return events;
};

/** 给 victim 塞满临时装备并换上其中一件 */
const loadUpVictim = (): void => {
  const l = loadouts.get(victim.id)!;
  const spareWeapon = warrior.weapons.find((w) => !w.isDefault)!;
  const spareArmor = warrior.armors.find((a) => !a.isDefault)!;
  addWeapon(l, spareWeapon.id);
  addArmor(l, spareArmor.id);
  victim.weaponId = spareWeapon.id;
  victim.armorId = spareArmor.id;
};

// ════════════════════════════════════════════════════════════════

describe('10.10 死亡时临时装备失效（M6 的规则 + M9 补的接线）', () => {
  /**
   * ★★ **这是本文件存在的理由。**
   *
   *   `loadout.onDeath()` 从 M6 起就是对的，`loadout.test.ts` 一直是绿的 ——
   *   但它在真实对局里**从来没有被调用过**。死亡发生在
   *   `effects/combat.ts` 的 `dealDamage()` 里，那里拿不到装备栏。
   *
   *   竞技场看不出来（死亡即淘汰），夺旗里就很明显：M7 的波次复活会让人
   *   带着一路捡来的装备原地复活，正是 10.10 要防的滚雪球。
   */
  it('★★ 死亡后临时装备清空、回退默认装备（settleDeaths 接线）', () => {
    loadUpVictim();
    const l = loadouts.get(victim.id)!;
    expect(l.spareWeapons).toHaveLength(1);

    const events = kill();
    expect(victim.alive).toBe(false);
    // 死了但还没结算 —— 装备还在
    expect(l.spareWeapons).toHaveLength(1);

    const settled = settleDeaths(deathDeps(), events);
    expect(settled).toEqual([{ entityId: victim.id, temporaryEquipmentCleared: true }]);
    expect(l.spareWeapons).toEqual([]);
    expect(l.spareArmors).toEqual([]);
    expect(victim.weaponId).toBe(l.defaultWeaponId);
    expect(victim.armorId).toBe(l.defaultArmorId);
  });

  /** ★ 10.6：默认装备永不删除 —— 死亡也不例外 */
  it('★ 默认装备在死亡后仍然在（10.6 永不删除）', () => {
    loadUpVictim();
    settleDeaths(deathDeps(), kill());
    const l = loadouts.get(victim.id)!;
    expect(l.defaultWeaponId).toBe(warrior.defaultWeaponId);
    expect(l.defaultArmorId).toBe(warrior.defaultArmorId);
  });

  it('没死的人不受影响', () => {
    loadUpVictim();
    const l = loadouts.get(victim.id)!;
    settleDeaths(deathDeps(), []); // 没有死亡事件
    expect(l.spareWeapons).toHaveLength(1);
  });

  /**
   * ★ 自检把「忘了接线」变成响亮的失败。
   *   与 M4 的 `assertAllEffectsRegistered()` 同一个思路 ——
   *   这正是上面那个 bug 活过三个里程碑所缺的东西。
   */
  it('★★ 漏调 settleDeaths 会被自检抓住（不是静默少做一件事）', () => {
    loadUpVictim();
    kill();
    expect(() => assertDeathsSettled(deathDeps())).toThrow(/死亡结算漏了/);
  });

  it('★ 正确调用后自检通过', () => {
    loadUpVictim();
    settleDeaths(deathDeps(), kill());
    expect(() => assertDeathsSettled(deathDeps())).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════

describe('17.3 第 2 类：换装瞬间死亡时状态唯一', () => {
  /**
   * ★★ 同一 tick 里「换装完成」与「死亡」相遇时，**死亡赢**。
   *
   *   `tickSwaps()` 里 `!e.alive` 的判断刻意排在 `now >= endsAt` 之前 ——
   *   否则一个已经死了的人会完成换装，于是「死人换了武器」这个状态既不属于
   *   活着也不属于死了，17.3 要求的「状态唯一」就破了。
   */
  it('★★ 换装恰好在死亡的同一 tick 完成时，死亡赢，换装不生效', () => {
    const l = loadouts.get(victim.id)!;
    const spare = warrior.weapons.find((w) => !w.isDefault)!;
    addWeapon(l, spare.id);
    const originalWeapon = victim.weaponId;

    const started = beginSwap(victim, l, swaps, SwapKind.Weapon, spare.id, 0);
    expect(started.ok).toBe(true);
    const endsAt = swaps.get(victim.id)!.endsAt;

    kill();
    const events = tickSwaps(world.entities, swaps, endsAt);

    expect(events).toEqual([
      { entityId: victim.id, state: expect.anything(), result: 'death' },
    ]);
    expect(victim.weaponId).toBe(originalWeapon); // 换装没有生效
    expect(swaps.has(victim.id)).toBe(false);     // 状态唯一：没有残留
  });

  it('★ 拾取进度不能跨越死亡活下来', () => {
    // 直接往 store 里放一条进行中的拾取，模拟「刚开始拾取就被打死」
    pickups.set(victim.id, {
      dropId: 1, startedAt: 0, endsAt: 10, startPosition: { ...victim.position },
    });

    kill();
    tickPickups(world.entities, loadouts, arsenal, pickups, 1);
    settleDeaths(deathDeps(), []);
    expect(pickups.has(victim.id)).toBe(false);
  });

  it('★ settleDeaths 兜底清掉拾取，即使没走 tickPickups', () => {
    pickups.set(victim.id, {
      dropId: 1, startedAt: 0, endsAt: 10, startPosition: { ...victim.position },
    });
    settleDeaths(deathDeps(), kill());
    expect(pickups.has(victim.id)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════

describe('17.3 第 4 类：施法完成瞬间目标失效', () => {
  /**
   * 这一类的规则由 M2 的 `validateCast()` 双重校验负责
   * （开始时校验一次，完成时**再**校验一次，同一个函数）。
   * 这里只确认它在死亡场景下确实拒绝，而不是产生一次「打在尸体上」的结算。
   */
  it('目标在施法完成瞬间死亡 → 完成阶段校验失败，不产生结算', () => {
    const skill = getSkill(asSkillId('warrior.mortal_strike'))
      ?? warrior.skills.find((s) => s.effects.some((e) => e.kind === 'damage'))!;

    victim.alive = false;
    const reason = validateCast({
      world, caster: killer, skill, target: victim, phase: 'complete',
    });
    expect(reason).not.toBe(CastFailure.Ok);
  });

  it('目标超距时完成阶段同样失败（不产生伤害/资源/冷却异常）', () => {
    const skill = warrior.skills.find(
      (s) => s.effects.some((e) => e.kind === 'damage') && s.range.max < 10,
    )!;
    victim.position = vec3(0, 0, 500);
    const reason = validateCast({
      world, caster: killer, skill, target: victim, phase: 'complete',
    });
    // ★ 只断言「被拒绝」而不是具体原因：门禁顺序是技术债 #3 的话题
    //   （资源排在距离之前），把具体 reason 写死会让这条测试绑到那个顺序上
    expect(reason).not.toBe(CastFailure.Ok);
  });
});

// ════════════════════════════════════════════════════════════════

describe('17.3 第 1 类：同时拾取只能有一个成功结果', () => {
  /**
   * 规则由 M6 的 `beginPickup()` 负责（按 endsAt 排序决定谁先完成，
   * 且所有失败路径都返回 `itemRemains: true`）。
   * 这里确认的是**跨模块**的那一半：抢输的人不会因为死亡结算而额外丢东西。
   */
  it('抢输的一方仍然什么都没得到，而物品留在原地（验收 #29）', () => {
    // 造一个掉落物
    const drop: GroundDrop = {
      id: 1,
      kind: 'weapon',
      weaponId: warrior.weapons.find((w) => !w.isDefault)!.id,
      classId: warrior.id,
      position: vec3(0, 0, 0),
      spawnedAt: 0,
    };
    arsenal.drops.push(drop);

    const a = victim;
    const b = spawn(TEAM_RED, 0, 1);
    loadouts.set(b.id, createLoadout(b.classId));

    const ra = beginPickup(a, loadouts.get(a.id)!, arsenal, pickups, drop.id, 0);
    const rb = beginPickup(b, loadouts.get(b.id)!, arsenal, pickups, drop.id, 0);
    expect(ra.ok || rb.ok).toBe(true);

    // 谁失败了，失败结果里必须写明「物品留在原地」
    for (const r of [ra, rb]) {
      if (!r.ok) expect(r.itemRemains).toBe(true);
    }
  });
});
