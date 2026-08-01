/**
 * 装备栏、换装与军械箱测试。
 * 对应规格书 10.1–10.10 与验收 #28 / #29 / #30 / #33 / #34 / #36 / #37。
 *
 * ★ 全文最重要的一组是「验收 #34 五项禁止利用」——
 *   它们都是「不做某事」的规则，破坏了不会有任何东西报错，
 *   只会让某个玩家发现「切一下武器就能重置冷却」然后再也不用别的打法。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { EQUIP, RANGE } from '../constants/combat.js';
import { mage, warrior } from '../data/index.js';
import { DispelType, ArenaPreset, ArsenalChoice, GameMode, Resource, School } from '../types/enums.js';
import { asArmorId, asTeamId, asWeaponId, type EntityId } from '../types/ids.js';
import { vec3 } from '../math/vec3.js';
import { box } from '../data/maps/schema.js';
import { createAuraStore, applyAura, aurasOf } from './aura.js';
import { createEntity, type CombatEntity } from './entity.js';
import {
  SwapKind,
  addWeapon,
  availableWeapons,
  beginSwap,
  createLoadout,
  createLoadoutStore,
  createSwapStore,
  canPickupWeapon,
  enemyLoadoutView,
  onDamageDuringSwap,
  onDeath,
  ownLoadoutView,
  resetLoadouts,
  tickSwaps,
  type Loadout,
  type SwapStore,
} from './loadout.js';
import {
  armoryLayoutFor,
  armoryOptionsFor,
  beginPickup,
  createArsenalStore,
  createPickupStore,
  dropViewFor,
  setupArmories,
  spawnDropsFromRoster,
  telegraphedArmories,
  tickPickups,
  type ArsenalStore,
  type PickupStore,
} from './arsenal.js';
import { addEntity, allocEntityId, createWorld, type World } from './world.js';

const RED = asTeamId(0);
const ground = box('g', 'floor', { x: 0, y: -1, z: 0 }, { w: 200, h: 1, d: 200 });

let world: World;
let w: CombatEntity;
let wLoadout: Loadout;
let swaps: SwapStore;

const spawn = (cls: typeof warrior, x = 0, z = 0) =>
  addEntity(world, createEntity(allocEntityId(world), cls, RED, vec3(x, 0, z)));

beforeEach(() => {
  world = createWorld([ground]);
  w = spawn(warrior);
  wLoadout = createLoadout(w.classId);
  swaps = createSwapStore();
});

const GREATSWORD = asWeaponId('warrior.greatsword');
const DUAL_SWORDS = asWeaponId('warrior.dual_swords');
const MAGE_STAFF = asWeaponId('mage.staff');

describe('10.6 / 验收 #30 战场装备栏', () => {
  it('★ 始终保留 1 套不可删除的职业默认武器和默认护甲', () => {
    expect(wLoadout.defaultWeaponId).toBe(warrior.defaultWeaponId);
    expect(wLoadout.defaultArmorId).toBe(warrior.defaultArmorId);
    // 默认装备永远在可切换列表里
    expect(availableWeapons(wLoadout)).toContain(warrior.defaultWeaponId);
  });

  it('★ 最多携带 2 套临时武器', () => {
    expect(canPickupWeapon(w, wLoadout, GREATSWORD).ok).toBe(true);
    addWeapon(wLoadout, GREATSWORD);
    expect(canPickupWeapon(w, wLoadout, DUAL_SWORDS).ok).toBe(true);
    addWeapon(wLoadout, DUAL_SWORDS);

    // 第三件放不下
    const third = canPickupWeapon(w, wLoadout, asWeaponId('warrior.sword_shield'));
    expect(third.ok).toBe(false);
    expect(EQUIP.MAX_SPARE_WEAPONS).toBe(2);
  });

  it('已经拥有的武器不会重复拾取', () => {
    addWeapon(wLoadout, GREATSWORD);
    const r = canPickupWeapon(w, wLoadout, GREATSWORD);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe('alreadyOwned');
  });
});

describe('10.2 / 验收 #29 职业锁定', () => {
  it('★ 跨职业武器不能拾取，且提示「职业不匹配」', () => {
    const r = canPickupWeapon(w, wLoadout, MAGE_STAFF);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe('classMismatch');
    expect(r.ok === false && r.hint).toContain('职业不匹配');
    expect(r.ok === false && r.hint).toContain('法师');
  });

  it('★ 10.2：宠物不能拾取', () => {
    const pet = addEntity(
      world,
      createEntity(allocEntityId(world), warrior, RED, vec3(0, 0, 0), { isPet: true }),
    );
    const r = canPickupWeapon(pet, wLoadout, GREATSWORD);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe('isPet');
  });
});

describe('10.7 / 验收 #33 换装有时间、动作与中断窗口', () => {
  beforeEach(() => addWeapon(wLoadout, GREATSWORD));

  it('切换武器需要 0.8 秒', () => {
    const r = beginSwap(w, wLoadout, swaps, SwapKind.Weapon, GREATSWORD, 0);
    expect(r.ok).toBe(true);
    expect(r.ok && r.state.endsAt).toBeCloseTo(EQUIP.SWAP_WEAPON_SECONDS);
    expect(EQUIP.SWAP_WEAPON_SECONDS).toBe(0.8);
  });

  it('切换护甲需要 2 秒且必须原地', () => {
    const armor = asArmorId('warrior.offense');
    wLoadout.spareArmors.push(armor);
    const r = beginSwap(w, wLoadout, swaps, SwapKind.Armor, armor, 0);
    expect(r.ok && r.state.requiresStationary).toBe(true);
    expect(EQUIP.SWAP_ARMOR_SECONDS).toBe(2);
  });

  it('★ 护甲换装移动会中断，武器换装不会', () => {
    const armor = asArmorId('warrior.offense');
    wLoadout.spareArmors.push(armor);

    beginSwap(w, wLoadout, swaps, SwapKind.Armor, armor, 0);
    w.position = vec3(0, 0, 2);
    let ev = tickSwaps(world.entities, swaps, 0.5);
    expect(ev[0]!.result).toBe('moved');

    // 武器换装可以缓慢移动
    beginSwap(w, wLoadout, swaps, SwapKind.Weapon, GREATSWORD, 0);
    w.position = vec3(0, 0, 3);
    ev = tickSwaps(world.entities, swaps, 0.5);
    expect(ev).toHaveLength(0); // 没被中断
  });

  it('★ 护甲换装受到伤害会中断，武器换装不会（10.7）', () => {
    const armor = asArmorId('warrior.offense');
    wLoadout.spareArmors.push(armor);

    beginSwap(w, wLoadout, swaps, SwapKind.Armor, armor, 0);
    expect(onDamageDuringSwap(swaps, w.id)).toBe('damage');
    expect(swaps.has(w.id)).toBe(false);

    beginSwap(w, wLoadout, swaps, SwapKind.Weapon, GREATSWORD, 0);
    expect(onDamageDuringSwap(swaps, w.id)).toBeNull();
    expect(swaps.has(w.id)).toBe(true); // 武器换装不受伤害影响
  });

  it('硬控制中断换装（7.3）', () => {
    beginSwap(w, wLoadout, swaps, SwapKind.Weapon, GREATSWORD, 0);
    w.flags.stunned = true;
    expect(tickSwaps(world.entities, swaps, 0.1)[0]!.result).toBe('stunned');
  });

  it('死亡中断换装', () => {
    beginSwap(w, wLoadout, swaps, SwapKind.Weapon, GREATSWORD, 0);
    w.alive = false;
    expect(tickSwaps(world.entities, swaps, 0.1)[0]!.result).toBe('death');
  });

  it('完成后武器真的换了', () => {
    beginSwap(w, wLoadout, swaps, SwapKind.Weapon, GREATSWORD, 0);
    const ev = tickSwaps(world.entities, swaps, EQUIP.SWAP_WEAPON_SECONDS + 0.01);
    expect(ev[0]!.result).toBe('completed');
    expect(w.weaponId).toBe(GREATSWORD);
  });

  it('不能同时进行两次换装', () => {
    beginSwap(w, wLoadout, swaps, SwapKind.Weapon, GREATSWORD, 0);
    expect(beginSwap(w, wLoadout, swaps, SwapKind.Weapon, DUAL_SWORDS, 0).ok).toBe(false);
  });

  it('没有的武器换不了', () => {
    expect(beginSwap(w, wLoadout, swaps, SwapKind.Weapon, DUAL_SWORDS, 0).ok).toBe(false);
  });
});

describe('★★ 10.7 / 验收 #34 换装的五项禁止利用', () => {
  /** 造一个「正在打架中途换装」的完整状态，逐项对比换装前后 */
  const setupMidCombat = (now: number) => {
    addWeapon(wLoadout, GREATSWORD);
    const auras = createAuraStore();

    w.nextSwingAt = now + 1.2;          // 普通攻击还有 1.2 秒
    w.swingRecoveryUntil = now + 0.4;   // 后摇还剩 0.4 秒
    w.cooldowns.set(warrior.skills[0]!.id, now + 9);
    w.gcdUntil = now + 0.7;
    w.schoolLocks.set(School.Fire, now + 3);
    w.resources.set(Resource.Rage, 25);

    // 身上挂一个负面
    applyAura(auras, w, {
      id: 'test.debuff', name: '减速', kind: 'debuff', duration: 6,
      dispelType: DispelType.Movement, modifiers: { moveSpeed: 0.6 }, description: '',
    }, w.id, now);

    return { auras, snapshot: {
      nextSwingAt: w.nextSwingAt,
      swingRecoveryUntil: w.swingRecoveryUntil,
      cooldowns: new Map(w.cooldowns),
      gcdUntil: w.gcdUntil,
      schoolLocks: new Map(w.schoolLocks),
      rage: w.resources.get(Resource.Rage),
      auraCount: aurasOf(auras, w.id).length,
    } };
  };

  it('★ 换装不刷新普通攻击计时', () => {
    const { snapshot } = setupMidCombat(0);
    beginSwap(w, wLoadout, swaps, SwapKind.Weapon, GREATSWORD, 0);
    tickSwaps(world.entities, swaps, EQUIP.SWAP_WEAPON_SECONDS + 0.01);

    expect(w.weaponId).toBe(GREATSWORD);      // 换成功了
    expect(w.nextSwingAt).toBe(snapshot.nextSwingAt); // 但攻击计时没动
  });

  it('★ 换装不取消攻击后摇', () => {
    const { snapshot } = setupMidCombat(0);
    beginSwap(w, wLoadout, swaps, SwapKind.Weapon, GREATSWORD, 0);
    tickSwaps(world.entities, swaps, EQUIP.SWAP_WEAPON_SECONDS + 0.01);
    expect(w.swingRecoveryUntil).toBe(snapshot.swingRecoveryUntil);
  });

  it('★ 换装不重置技能冷却、公共冷却与学派锁定', () => {
    const { snapshot } = setupMidCombat(0);
    beginSwap(w, wLoadout, swaps, SwapKind.Weapon, GREATSWORD, 0);
    tickSwaps(world.entities, swaps, EQUIP.SWAP_WEAPON_SECONDS + 0.01);

    expect([...w.cooldowns.entries()]).toEqual([...snapshot.cooldowns.entries()]);
    expect(w.gcdUntil).toBe(snapshot.gcdUntil);
    expect([...w.schoolLocks.entries()]).toEqual([...snapshot.schoolLocks.entries()]);
  });

  it('★ 换装不恢复资源', () => {
    const { snapshot } = setupMidCombat(0);
    beginSwap(w, wLoadout, swaps, SwapKind.Weapon, GREATSWORD, 0);
    tickSwaps(world.entities, swaps, EQUIP.SWAP_WEAPON_SECONDS + 0.01);
    expect(w.resources.get(Resource.Rage)).toBe(snapshot.rage);
  });

  it('★ 换装不清除负面状态（护甲换装也不能瞬间获得满额护盾）', () => {
    const { auras, snapshot } = setupMidCombat(0);
    const armor = asArmorId('warrior.offense');
    wLoadout.spareArmors.push(armor);

    beginSwap(w, wLoadout, swaps, SwapKind.Armor, armor, 0);
    tickSwaps(world.entities, swaps, EQUIP.SWAP_ARMOR_SECONDS + 0.01);

    expect(w.armorId).toBe(armor);
    expect(aurasOf(auras, w.id)).toHaveLength(snapshot.auraCount); // 负面还在
  });

  it('★ 五项一起验：换装前后除了装备 id，一切照旧', () => {
    const { auras, snapshot } = setupMidCombat(0);
    beginSwap(w, wLoadout, swaps, SwapKind.Weapon, GREATSWORD, 0);
    tickSwaps(world.entities, swaps, EQUIP.SWAP_WEAPON_SECONDS + 0.01);

    expect({
      nextSwingAt: w.nextSwingAt,
      swingRecoveryUntil: w.swingRecoveryUntil,
      cooldowns: [...w.cooldowns.entries()],
      gcdUntil: w.gcdUntil,
      schoolLocks: [...w.schoolLocks.entries()],
      rage: w.resources.get(Resource.Rage),
      auraCount: aurasOf(auras, w.id).length,
    }).toEqual({
      nextSwingAt: snapshot.nextSwingAt,
      swingRecoveryUntil: snapshot.swingRecoveryUntil,
      cooldowns: [...snapshot.cooldowns.entries()],
      gcdUntil: snapshot.gcdUntil,
      schoolLocks: [...snapshot.schoolLocks.entries()],
      rage: snapshot.rage,
      auraCount: snapshot.auraCount,
    });
  });
});

describe('10.6 / 验收 #36 敌人看不到备用装备', () => {
  it('★ 敌方视图里根本没有备用装备字段', () => {
    addWeapon(wLoadout, GREATSWORD);
    addWeapon(wLoadout, DUAL_SWORDS);

    const view = enemyLoadoutView(w, swaps);
    expect(Object.keys(view)).toEqual(['currentWeapon', 'armorArchetype', 'swapping']);
    expect(JSON.stringify(view)).not.toContain('greatsword');
    expect(JSON.stringify(view)).not.toContain('dual_swords');
  });

  it('敌人能看到当前武器、护甲类型和换装动作', () => {
    addWeapon(wLoadout, GREATSWORD);
    beginSwap(w, wLoadout, swaps, SwapKind.Weapon, GREATSWORD, 0);

    const view = enemyLoadoutView(w, swaps);
    expect(view.currentWeapon?.id).toBe(warrior.defaultWeaponId);
    expect(view.armorArchetype).toBeDefined();
    expect(view.swapping).toBe(true);
  });

  it('自己的视图能看到全部备用装备（10.6）', () => {
    addWeapon(wLoadout, GREATSWORD);
    const view = ownLoadoutView(w, wLoadout, swaps, 0);
    expect(view.spareWeapons.map((x) => x?.id)).toContain(GREATSWORD);
  });
});

describe('10.10 死亡与回合重置（验收 #37）', () => {
  it('★ 死亡后临时装备失效，不掉给敌人；默认装备保留', () => {
    addWeapon(wLoadout, GREATSWORD);
    w.weaponId = GREATSWORD;

    onDeath(w, wLoadout, swaps);

    expect(wLoadout.spareWeapons).toHaveLength(0);
    expect(w.weaponId).toBe(wLoadout.defaultWeaponId); // 回到默认武器
  });

  it('★ 回合结束清除全部临时武器、护甲、道具', () => {
    const loadouts = createLoadoutStore();
    loadouts.set(w.id, wLoadout);
    addWeapon(wLoadout, GREATSWORD);
    wLoadout.spareArmors.push(asArmorId('warrior.offense'));
    w.weaponId = GREATSWORD;
    beginSwap(w, wLoadout, swaps, SwapKind.Weapon, warrior.defaultWeaponId, 0);

    resetLoadouts([w], loadouts, swaps);

    expect(wLoadout.spareWeapons).toHaveLength(0);
    expect(wLoadout.spareArmors).toHaveLength(0);
    expect(w.weaponId).toBe(wLoadout.defaultWeaponId);
    expect(swaps.size).toBe(0);
  });
});

// ── 军械箱与拾取 ─────────────────────────────────────────────────

describe('10.1 / 验收 #28 规则预设', () => {
  it('★ 经典竞技场不生成任何临时武装', () => {
    const store = createArsenalStore(ArenaPreset.Classic);
    expect(store.enabled).toBe(false);
    setupArmories(store, GameMode.Arena3v3, 0);
    expect(store.armories).toHaveLength(0);
    expect(spawnDropsFromRoster(store, [warrior.id], vec3(0, 0, 0), 0)).toHaveLength(0);
  });

  it('★ 武装竞技场生成军械点', () => {
    const store = createArsenalStore(ArenaPreset.Armed);
    expect(store.enabled).toBe(true);
    setupArmories(store, GameMode.Arena3v3, 0);
    expect(store.armories.length).toBeGreaterThan(0);
  });
});

describe('10.4 刷新与争夺', () => {
  it('各模式的军械点数量符合 10.4', () => {
    // 2v2 同一时间最多一个主要军械点
    expect(armoryLayoutFor(GameMode.Arena2v2)).toHaveLength(1);
    expect(armoryLayoutFor(GameMode.Arena2v2)[0]!.role).toBe('primary');

    // 3v3 一个中央 + 轮换侧点
    const l3 = armoryLayoutFor(GameMode.Arena3v3);
    expect(l3.filter((x) => x.role === 'primary')).toHaveLength(1);
    expect(l3.filter((x) => x.role === 'side').length).toBeGreaterThan(0);

    // 5v5 中央与两侧多个战术点
    expect(armoryLayoutFor(GameMode.Arena5v5).length).toBeGreaterThan(l3.length);

    // 12.x 夺旗首版关闭
    expect(armoryLayoutFor(GameMode.Ctf6v6)).toHaveLength(0);
  });

  it('★ 10.4 / 11.3：军械点沿 ±Z 对称，双方到达距离相等', () => {
    for (const mode of [GameMode.Arena2v2, GameMode.Arena3v3, GameMode.Arena5v5]) {
      for (const { offset } of armoryLayoutFor(mode)) {
        const mirrored = armoryLayoutFor(mode).some(
          (o) => Math.abs(o.offset.z + offset.z) < 1e-6 && Math.abs(o.offset.x - offset.x) < 1e-6,
        );
        expect(mirrored, `${mode} 的军械点 z=${offset.z} 没有对称点`).toBe(true);
      }
    }
  });

  it('★ 刷新前 5 秒进入预告窗口', () => {
    const store = createArsenalStore(ArenaPreset.Armed);
    setupArmories(store, GameMode.Arena2v2, 0, 20);
    expect(telegraphedArmories(store, 10)).toHaveLength(0);  // 还早
    expect(telegraphedArmories(store, 16)).toHaveLength(1);  // 进入预告
    expect(telegraphedArmories(store, 21)).toHaveLength(0);  // 已经刷出
    expect(EQUIP.SPAWN_TELEGRAPH_SECONDS).toBe(5);
  });

  it('★ 军械箱只显示打开者职业的三个横向选择', () => {
    const opts = armoryOptionsFor(warrior.id);
    expect(opts.map((o) => o.choice)).toEqual([
      ArsenalChoice.Offense, ArsenalChoice.Mobility, ArsenalChoice.Defense,
    ]);
    // 每个选项都有明确的优势与代价（17.1 横向取舍）
    for (const o of opts) {
      expect(o.advantage.length).toBeGreaterThan(0);
      expect(o.cost.length).toBeGreaterThan(0);
    }
    // 给出的装备都属于该职业
    for (const o of opts) {
      if (o.weaponId) expect((o.weaponId as string).startsWith('warrior.')).toBe(true);
      if (o.armorId) expect((o.armorId as string).startsWith('warrior.')).toBe(true);
    }
  });

  it('★ 实体掉落只从房间实际存在的职业池生成', () => {
    const store = createArsenalStore(ArenaPreset.Armed);
    const drops = spawnDropsFromRoster(store, [warrior.id, mage.id], vec3(0, 0, 0), 0);
    /**
     * ★ 10.4 那条规则是「**不要刷出无人可用的装备**」，判据是「有归属的掉落
     *   必须属于在场职业」。消耗品**没有归属**（10.1 人人可用），所以它不在
     *   这条规则的射程里 —— 把它算进来会让规则读成「地上只能有职业装备」，
     *   那不是 10.4 说的意思。
     */
    const owned = drops.filter((d) => d.classId !== undefined);
    const classes = new Set(owned.map((d) => d.classId as string));
    expect(classes).toEqual(new Set(['warrior', 'mage']));
    // 没有第三个职业的东西
    expect(owned.every((d) => ['warrior', 'mage'].includes(d.classId as string))).toBe(true);
    // ★ 而消耗品确实刷出来了 —— 否则上面的 filter 会让这条测试平凡通过
    expect(
      drops.some((d) => d.kind === 'consumable'),
      '军械箱没有刷出消耗品 —— 使用路径通了但场上捡不到',
    ).toBe(true);
  });
});

describe('10.5 拾取', () => {
  let store: ArsenalStore;
  let pickups: PickupStore;
  let loadouts: Map<EntityId, Loadout>;

  beforeEach(() => {
    store = createArsenalStore(ArenaPreset.Armed);
    pickups = createPickupStore();
    loadouts = new Map([[w.id, wLoadout]]);
    spawnDropsFromRoster(store, [warrior.id], vec3(0, 0, 0), 0);
  });

  it('需要进入 2.2 米交互距离', () => {
    w.position = vec3(0, 0, -10);
    const far = beginPickup(w, wLoadout, store, pickups, store.drops[0]!.id, 0);
    expect(far.ok).toBe(false);
    expect(RANGE.INTERACT).toBe(2.2);

    w.position = vec3(0, 0, -1);
    expect(beginPickup(w, wLoadout, store, pickups, store.drops[0]!.id, 0).ok).toBe(true);
  });

  it('持续 0.8 秒完成', () => {
    beginPickup(w, wLoadout, store, pickups, store.drops[0]!.id, 0);
    expect(tickPickups(world.entities, loadouts, store, pickups, 0.5)).toHaveLength(0);
    const ev = tickPickups(world.entities, loadouts, store, pickups, EQUIP.PICKUP_SECONDS + 0.01);
    expect(ev[0]!.result).toBe('completed');
    expect(wLoadout.spareWeapons).toHaveLength(1);
    expect(EQUIP.PICKUP_SECONDS).toBe(0.8);
  });

  it('★ 移动、硬控制、死亡会中断拾取', () => {
    for (const [name, mutate] of [
      ['moved', () => { w.position = vec3(0, 0, 2); }],
      ['stunned', () => { w.flags.stunned = true; }],
      ['death', () => { w.alive = false; }],
    ] as const) {
      w.position = vec3(0, 0, 0);
      w.flags.stunned = false;
      w.alive = true;
      pickups.clear();

      beginPickup(w, wLoadout, store, pickups, store.drops[0]!.id, 0);
      mutate();
      const ev = tickPickups(world.entities, loadouts, store, pickups, 0.2);
      expect(ev[0]!.result, `${name} 应当中断拾取`).toBe(name);
    }
  });

  it('★ 10.5：普通伤害**不**中断拾取', () => {
    beginPickup(w, wLoadout, store, pickups, store.drops[0]!.id, 0);
    // 反复扣血
    for (let t = 0; t < 0.7; t += 0.1) {
      w.health -= 50;
      expect(tickPickups(world.entities, loadouts, store, pickups, t)).toHaveLength(0);
    }
    const ev = tickPickups(world.entities, loadouts, store, pickups, EQUIP.PICKUP_SECONDS + 0.01);
    expect(ev[0]!.result).toBe('completed');
  });

  it('★ 验收 #29：职业不匹配时拾取失败，且**物品不消失**', () => {
    const m = spawn(mage);
    const mLoadout = createLoadout(m.classId);
    loadouts.set(m.id, mLoadout);

    const before = store.drops.length;
    const r = beginPickup(m, mLoadout, store, pickups, store.drops[0]!.id, 0);

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain('职业不匹配');
    expect(r.ok === false && r.itemRemains).toBe(true);
    expect(store.drops).toHaveLength(before); // ★ 物品还在地上
  });

  it('★ 10.2：多人同时拾取只有第一个完成者成功', () => {
    const w2 = spawn(warrior);
    const l2 = createLoadout(w2.classId);
    loadouts.set(w2.id, l2);

    const dropId = store.drops[0]!.id;
    beginPickup(w, wLoadout, store, pickups, dropId, 0);
    beginPickup(w2, l2, store, pickups, dropId, 0.1); // 稍晚起手

    const ev = tickPickups(world.entities, loadouts, store, pickups, EQUIP.PICKUP_SECONDS + 0.2);
    const completed = ev.filter((e) => e.result === 'completed');
    const taken = ev.filter((e) => e.result === 'taken');

    expect(completed).toHaveLength(1);
    expect(completed[0]!.entityId).toBe(w.id); // 先起手的先完成
    expect(taken).toHaveLength(1);             // 另一个收到明确失败反馈
    /**
     * ★ 断言的是「**这一件**被拿走了」，不是「地上空了」。
     *   ⚠️ 原本写的是 `toHaveLength(0)` —— M11 给军械箱加了消耗品掉落之后
     *      这条红了，而红得对：地上本来就还会有别的东西。
     *      按意图收紧，而不是把数字从 0 改成 1（那样下次再加一种掉落又会红）。
     */
    expect(
      store.drops.some((d) => d.id === dropId),
      '被拾取的那件物品还留在地上',
    ).toBe(false);
  });

  it('★ 10.2：不匹配的玩家仍然看得到掉落物和它的所属职业', () => {
    const m = spawn(mage);
    const mLoadout = createLoadout(m.classId);
    const view = dropViewFor(store.drops[0]!, m, mLoadout);

    expect(view.ownerClassName).toBe('战士');   // 看得到归属
    expect(view.itemName.length).toBeGreaterThan(0);
    expect(view.pickableByViewer).toBe(false);  // 但拿不走
  });
});
