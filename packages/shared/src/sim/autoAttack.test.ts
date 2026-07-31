/**
 * 普通攻击（7.6 / 8.1）。
 *
 * ★★ 这一节的规则**从来没有实现过** —— `swingInterval` 在 sim 里零引用。
 *   所以这里每条测试都在钉「它现在真的会发生」，而不是「重构前后一致」。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { getSkill, warrior, mage } from '../data/index.js';
import { COMBAT_SWING } from '../constants/combat.js';
import { Resource } from '../types/enums.js';
import { TEAM_BLUE, TEAM_RED, type EntityId } from '../types/ids.js';
import { box } from '../data/maps/schema.js';
import { dirToYaw, sub, vec3 } from '../math/vec3.js';
import { createAuraStore, type AuraStore } from './aura.js';
import { beginSwing, createSwingStore, stopSwing, tickSwings, type SwingStore } from './autoAttack.js';
import { createEntity, type CombatEntity } from './entity.js';
import { addEntity, allocEntityId, createWorld, type World } from './world.js';
import { getWeapon } from '../data/index.js';

const FLOOR = box('g', 'floor', { x: 0, y: -1, z: 0 }, { w: 200, h: 1, d: 200 });

let world: World; let auras: AuraStore; let swings: SwingStore;
let atk: CombatEntity; let foe: CombatEntity;

beforeEach(() => {
  world = createWorld([FLOOR]);
  auras = createAuraStore();
  swings = createSwingStore();
  atk = addEntity(world, createEntity(allocEntityId(world), warrior, TEAM_RED, vec3(0, 0, 0)));
  foe = addEntity(world, createEntity(allocEntityId(world), mage, TEAM_BLUE, vec3(0, 0, 2)));
  atk.targets.hard = foe.id;
  atk.yaw = dirToYaw(sub(foe.position, atk.position));
});

const interval = () => getWeapon(atk.weaponId)!.swingInterval;
const deps = () => ({ world, auras, swings });

describe('★★ 登记才挥击（试验场因此不受影响）', () => {
  it('★★ 没有登记条目的实体**不会**自动攻击', () => {
    expect(tickSwings(deps(), 100)).toEqual([]);
  });

  it('登记之后按武器间隔挥击', () => {
    beginSwing(swings, atk.id, 0, interval());
    expect(tickSwings(deps(), 0), '还没到时间就挥了').toEqual([]);
    const out = tickSwings(deps(), interval());
    expect(out).toHaveLength(1);
    expect(out[0]!.miss, `落空了：${out[0]!.miss}`).toBeUndefined();
  });

  it('★ 反复 beginSwing 不重置计时（连点右键不该刷新节奏）', () => {
    beginSwing(swings, atk.id, 0, interval());
    beginSwing(swings, atk.id, interval() * 0.9, interval());
    expect(tickSwings(deps(), interval()), '计时被刷新了').toHaveLength(1);
  });

  it('stopSwing 之后不再挥击', () => {
    beginSwing(swings, atk.id, 0, interval());
    stopSwing(swings, atk.id);
    expect(tickSwings(deps(), 999)).toEqual([]);
  });
});

describe('★★ 7.6：落空但计时照常推进', () => {
  it('★★ 超距落空，且**下一次仍按间隔到来**', () => {
    beginSwing(swings, atk.id, 0, interval());
    foe.position = vec3(0, 0, 40); // 走远

    const miss = tickSwings(deps(), interval());
    expect(miss[0]!.miss, '超距没有落空').toBe('outOfRange');

    // ★ 关键：落空不该让下一次立刻到来
    expect(tickSwings(deps(), interval() + 0.01), '落空后计时没有推进').toEqual([]);
    expect(tickSwings(deps(), interval() * 2)).toHaveLength(1);
  });

  it('背对目标落空（7.6 近战要求前方）', () => {
    beginSwing(swings, atk.id, 0, interval());
    atk.yaw = dirToYaw(sub(atk.position, foe.position)); // 背对
    expect(tickSwings(deps(), interval())[0]!.miss).toBe('wrongFacing');
  });

  it('目标死亡后落空', () => {
    beginSwing(swings, atk.id, 0, interval());
    foe.alive = false;
    expect(tickSwings(deps(), interval())[0]!.miss).toBe('targetInvalid');
  });
});

describe('★★ 8.1：只能被控制、缴械、失去目标/距离/视线阻止', () => {
  it('★★ 缴械挡住普通攻击', () => {
    beginSwing(swings, atk.id, 0, interval());
    atk.flags.disarmed = true;
    expect(tickSwings(deps(), interval())[0]!.miss).toBe('disarmed');
  });

  /**
   * ★★ **沉默不挡普通攻击**（验收 #17：沉默只挡魔法，缴械只挡武器）。
   *   这条是否定式的 —— 写错了不会报错，只会让战士被沉默后站着不动。
   */
  it('★★ 沉默**不**挡普通攻击（验收 #17）', () => {
    beginSwing(swings, atk.id, 0, interval());
    atk.flags.silenced = true;
    const out = tickSwings(deps(), interval());
    expect(out[0]!.miss, '沉默把普通攻击挡住了 —— 那是缴械的职责').toBeUndefined();
  });

  it('昏迷挡住普通攻击（7.3）', () => {
    beginSwing(swings, atk.id, 0, interval());
    atk.flags.stunned = true;
    expect(tickSwings(deps(), interval())[0]!.miss).toBe('controlled');
  });

  it('没有目标时落空', () => {
    beginSwing(swings, atk.id, 0, interval());
    delete atk.targets.hard;
    expect(tickSwings(deps(), interval())[0]!.miss).toBe('noTarget');
  });
});

describe('★★ 挥击产生怒气 —— 战士唯一的资源来源', () => {
  /**
   * ★★ 战士的怒气池是 `start: 0, regenPerSecond: 0`，全职业只有冲锋 +15。
   *   **没有普通攻击就没有怒气** —— 这正是配平脚本跑出战士 0% 胜率的原因。
   */
  it('★★ 命中时带 gainResource(Rage)', () => {
    beginSwing(swings, atk.id, 0, interval());
    const out = tickSwings(deps(), interval());
    const gain = out[0]!.effects?.find((e) => e.kind === 'gainResource');
    expect(gain, '战士挥击没有产生怒气 —— 他将没有任何资源来源').toBeDefined();
    expect(gain?.kind === 'gainResource' && gain.amount).toBe(COMBAT_SWING.RAGE_PER_SWING);
  });

  it('★ 没有怒气池的职业不产怒气（法师）', () => {
    const m = addEntity(world, createEntity(allocEntityId(world), mage, TEAM_RED, vec3(5, 0, 0)));
    m.targets.hard = foe.id;
    m.yaw = dirToYaw(sub(foe.position, m.position));
    foe.position = vec3(5, 0, 2);
    beginSwing(swings, m.id, 0, getWeapon(m.weaponId)!.swingInterval);

    const out = tickSwings(deps(), getWeapon(m.weaponId)!.swingInterval)
      .filter((s) => s.attackerId === m.id);
    expect(out[0]?.effects?.some((e) => e.kind === 'gainResource')).toBeFalsy();
    expect(m.maxResources.has(Resource.Rage)).toBe(false);
  });

  it('★ 伤害用的是武器的 swingPercent（验收 #31 的数据终于参与结算）', () => {
    beginSwing(swings, atk.id, 0, interval());
    const out = tickSwings(deps(), interval());
    const dmg = out[0]!.effects?.find((e) => e.kind === 'damage');
    expect(dmg?.kind === 'damage' && dmg.amount.weaponPercent)
      .toBe(getWeapon(atk.weaponId)!.swingPercent);
  });
});

void getSkill;
