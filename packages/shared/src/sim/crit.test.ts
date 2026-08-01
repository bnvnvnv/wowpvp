/**
 * 暴击机制（docs/10 已知偏差 #7 —— 规格书没有这条机制，是玩法新增）。
 *
 * ★★ 两条结构性约束是本文件的重点，数值只是顺带：
 *   · 暴击掷**攻击者**的随机流（闪避掷被攻击者的），两边互不扰动 ——
 *     否则回放与 balance-report 不可复现
 *   · 免疫/被规避的一发**不消耗**随机数 —— 否则对面开不开圣盾术
 *     会改变我后续所有暴击的序列
 *
 * ★ 「暴击不打断施法」（验收 #14）没有单独的测试：`dealDamage` 根本
 *   不接触 castingStore（打断只走 interrupt.ts），暴击只是乘了个系数,
 *   结构上不可能引入打断 —— 为它写测试测的会是一句空话。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { getSkill, mage, warrior } from '../data/index.js';
import { School } from '../types/enums.js';
import { TEAM_BLUE, TEAM_RED } from '../types/ids.js';
import { vec3 } from '../math/vec3.js';
import { CRIT } from '../constants/combat.js';
import { createAuraStore, applyAura, type AuraStore } from './aura.js';
import { createDrStore, type DrStore } from './dr.js';
import { createGroundStore, type GroundStore } from './groundArea.js';
import { createProjectileStore, type ProjectileStore } from './projectile.js';
import { createCastingStore, type CastingStore } from './casting.js';
import { createLoadout, createLoadoutStore, createSwapStore, type LoadoutStore, type SwapStore } from './loadout.js';
import { createArsenalStore, createPickupStore, type ArsenalStore, type PickupStore } from './arsenal.js';
import { createEntity, type CombatEntity } from './entity.js';
import { addEntity, allocEntityId, createWorld, nextRandom, type World } from './world.js';
import { dealDamage, dealHeal, resolveEffects, type CombatEvent } from './effects/index.js';
import { tickWorld, type TickDeps } from './tick.js';
import { ArenaPreset } from '../types/enums.js';
import type { AuraDef } from '../data/schema.js';
import type { EntityId } from '../types/ids.js';
import type { MovementInput, MovementState } from './movement.js';

let world: World; let auras: AuraStore;
let atk: CombatEntity; let def: CombatEntity;
let events: CombatEvent[];

const ctx = () => ({
  world, auras, dr: createDrStore(), projectiles: createProjectileStore(),
  groundAreas: [], traps: [], source: atk, skillId: 'test',
  events, resolve: () => {},
}) as never;

const setup = (seed = 1) => {
  world = createWorld([], seed);
  auras = createAuraStore();
  events = [];
  atk = addEntity(world, createEntity(allocEntityId(world), warrior, TEAM_RED, vec3(0, 0, 0)));
  def = addEntity(world, createEntity(allocEntityId(world), mage, TEAM_BLUE, vec3(0, 0, 2)));
  def.health = def.maxHealth;
};

beforeEach(() => setup());

/** 找一个「下一次掷骰满足条件」的种子 —— 把概率钉死，不靠运气 */
const seedWhere = (pred: (roll: number) => boolean): number => {
  for (let s = 1; s < 100_000; s++) {
    if (pred(nextRandom({ rng: s }))) return s;
  }
  throw new Error('10 万个种子里找不到满足条件的 —— 条件写错了');
};
const critSeed = (): number => seedWhere((r) => r < CRIT.BASE_CHANCE);
const noCritSeed = (): number => seedWhere((r) => r >= CRIT.BASE_CHANCE);

const lastDamage = () =>
  [...events].reverse().find((e): e is Extract<CombatEvent, { t: 'damage' }> => e.t === 'damage');
const lastHeal = () =>
  [...events].reverse().find((e): e is Extract<CombatEvent, { t: 'heal' }> => e.t === 'heal');

describe('★★ 暴击的随机流纪律', () => {
  it('★★ 同一个种子跑两遍，暴击序列完全一致', () => {
    const run = () => {
      setup(42);
      const seq: boolean[] = [];
      for (let i = 0; i < 40; i++) {
        def.health = def.maxHealth;
        dealDamage(ctx(), def, 50, School.Fire);
        seq.push(lastDamage()?.crit === true);
        events.length = 0;
      }
      return seq;
    };
    expect(run()).toEqual(run());
  });

  it('★★ 被攻击者掷骰不扰动攻击者的暴击流（avoidance.test 那条的镜像）', () => {
    const before = atk.rng;
    for (let i = 0; i < 50; i++) nextRandom(def);
    expect(atk.rng, '被攻击者的掷骰改变了攻击者的随机流').toBe(before);
  });

  it('★★ 被规避的一发不消耗攻击者的随机数', () => {
    applyAura(auras, def, {
      id: 'test.dodge', name: '必闪', kind: 'buff', duration: 99,
      dispelType: 'magic', modifiers: { dodgeFront: 1 },
    } as AuraDef, def.id, 0);
    const before = atk.rng;
    dealDamage(ctx(), def, 200, School.Physical);
    expect(lastDamage()?.avoided).toBe('dodge');
    expect(atk.rng, '被闪掉的一发仍然消耗了暴击掷骰').toBe(before);
  });

  it('★★ 被免疫的一发不消耗攻击者的随机数', () => {
    def.flags.immuneAll = true;
    const before = atk.rng;
    dealDamage(ctx(), def, 200, School.Fire);
    expect(lastDamage()?.immune).toBe(true);
    expect(atk.rng).toBe(before);
  });

  it('★ canCrit:false（压迫伤害）不掷骰也不放大', () => {
    atk.rng = noCritSeed();
    const baseline = dealDamage(ctx(), def, 100, School.Fire);
    def.health = def.maxHealth;
    atk.rng = critSeed(); // 就算这个种子必定暴击
    const before = atk.rng;
    const dealt = dealDamage(ctx(), def, 100, School.Fire, { canCrit: false });
    expect(dealt, '压迫伤害被暴击放大了').toBe(baseline);
    expect(lastDamage()?.crit).toBeUndefined();
    expect(atk.rng, 'canCrit:false 仍然消耗了随机数').toBe(before);
  });
});

describe('★★ 暴击数值', () => {
  it('★ 暴击 = round(基础 × 1.5 × 修正)，事件带 crit:true', () => {
    atk.rng = noCritSeed();
    const normal = dealDamage(ctx(), def, 100, School.Fire);
    def.health = def.maxHealth;
    atk.rng = critSeed();
    const crit = dealDamage(ctx(), def, 100, School.Fire);
    expect(crit).toBe(Math.round(normal * CRIT.DAMAGE_MULTIPLIER));
    expect(lastDamage()?.crit).toBe(true);
  });

  it('★ 普通命中的事件**没有** crit 字段（不是 false，是没有 —— 广播不付空字段）', () => {
    atk.rng = noCritSeed();
    dealDamage(ctx(), def, 100, School.Fire);
    const ev = lastDamage()!;
    expect('crit' in ev).toBe(false);
  });

  it('★ 2000 次固定种子采样，暴击率落在 [0.06, 0.15]', () => {
    let crits = 0;
    for (let i = 0; i < 2000; i++) {
      def.health = def.maxHealth;
      dealDamage(ctx(), def, 10, School.Fire);
      if (lastDamage()?.crit) crits++;
      events.length = 0;
    }
    const rate = crits / 2000;
    expect(rate).toBeGreaterThan(0.06);
    expect(rate).toBeLessThan(0.15);
  });

  it('★ 暴击穿吸收：护盾按 1.5 倍后的量消耗（否则「暴击被小盾吃掉」读成没暴击）', () => {
    // 先量一发无暴击的吸收量做基线（战士→法师的火焰承伤修正不是 1，别硬编码）
    applyAura(auras, def, {
      id: 'test.shield', name: '盾', kind: 'buff', duration: 99,
      dispelType: 'magic', absorb: 10_000,
    } as AuraDef, def.id, 0);
    atk.rng = noCritSeed();
    dealDamage(ctx(), def, 100, School.Fire);
    const baseline = lastDamage()!.absorbed;
    expect(baseline).toBeGreaterThan(0);

    atk.rng = critSeed();
    dealDamage(ctx(), def, 100, School.Fire);
    const ev = lastDamage()!;
    expect(ev.absorbed).toBe(Math.round(baseline * CRIT.DAMAGE_MULTIPLIER));
    expect(ev.crit, '整发都被吸收时 crit 标记也必须在 —— 表现层要演出来').toBe(true);
  });

  it('★ 治疗能暴击：1.5 倍 + 事件 crit:true', () => {
    def.health = def.maxHealth - 500;
    atk.rng = critSeed();
    const healed = dealHeal(ctx(), def, 100);
    expect(healed).toBe(Math.round(100 * CRIT.HEAL_MULTIPLIER));
    expect(lastHeal()?.crit).toBe(true);
  });
});

describe('★★ 周期跳不暴击', () => {
  it('★★ resolveEffects 带 periodic 时，damage/heal 都不掷骰不放大', () => {
    atk.rng = critSeed();
    const before = atk.rng;
    def.health = def.maxHealth - 500;
    const evs = resolveEffects(
      {
        world, auras, dr: createDrStore(), projectiles: createProjectileStore(),
        ground: createGroundStore(), source: atk, skillId: 'test', periodic: true,
      },
      [
        { kind: 'damage', school: School.Fire, amount: { flat: 100 } },
        { kind: 'heal', amount: { flat: 100 } },
      ],
      [def],
    );
    const dmg = evs.find((e) => e.t === 'damage');
    const heal = evs.find((e) => e.t === 'heal');
    expect(dmg && 'crit' in dmg).toBe(false);
    expect(heal && 'crit' in heal).toBe(false);
    expect(atk.rng, '周期跳仍然消耗了暴击掷骰').toBe(before);
  });

  /**
   * ★★ 走**完整** tickWorld → tickAuras → resolve 链路，而不是直接调处理器 ——
   *   本项目四次踩过「规则写对了但没人调它」：periodic 标记要是没接进 tick.ts,
   *   上面那条测试照样绿。
   */
  it('★★ DoT 光环的周期跳经 tickWorld 全链路永不暴击、不消耗攻击者随机数', () => {
    const w = createWorld([], 7);
    const au = createAuraStore();
    const dr: DrStore = createDrStore();
    const ground: GroundStore = createGroundStore();
    const projectiles: ProjectileStore = createProjectileStore();
    const casting: CastingStore = createCastingStore();
    const loadouts: LoadoutStore = createLoadoutStore();
    const swaps: SwapStore = createSwapStore();
    const pickups: PickupStore = createPickupStore();
    const arsenal: ArsenalStore = createArsenalStore(ArenaPreset.Armed);
    const movement = new Map<EntityId, MovementState>();
    const inputs = new Map<EntityId, MovementInput>();

    const source = addEntity(w, createEntity(allocEntityId(w), warrior, TEAM_RED, vec3(0, 0, 0)));
    const victim = addEntity(w, createEntity(allocEntityId(w), mage, TEAM_BLUE, vec3(0, 0, 3)));
    loadouts.set(source.id, createLoadout(source.classId));
    loadouts.set(victim.id, createLoadout(victim.classId));

    applyAura(au, victim, {
      id: 'test.dot', name: '灼烧', kind: 'debuff', duration: 99, dispelType: 'magic',
      periodic: { interval: 0.05, effects: [{ kind: 'damage', school: School.Fire, amount: { flat: 5 } }] },
    } as AuraDef, source.id, w.time);

    const deps: TickDeps = {
      world: w, auras: au, dr, ground, projectiles, casting,
      loadouts, swaps, pickups, arsenal, movement, inputs, getSkill,
    };

    const rngBefore = source.rng;
    const all: CombatEvent[] = [];
    // 100 跳 × 10% 几率：若周期跳能暴击，全程零暴击的概率约 2.7e-5 —— 但这里
    // 断言的是**确定性**事实：rollCrit 压根没被调用（随机数一个都没消耗）
    for (let i = 0; i < 100; i++) {
      victim.health = victim.maxHealth;
      all.push(...tickWorld(deps, 0.05).events);
    }
    const dots = all.filter((e): e is Extract<CombatEvent, { t: 'damage' }> => e.t === 'damage' && e.amount > 0);
    expect(dots.length).toBeGreaterThan(50);
    expect(dots.some((e) => e.crit), 'DoT 周期跳暴击了').toBe(false);
    expect(source.rng, 'DoT 周期跳消耗了攻击者的暴击掷骰').toBe(rngBefore);
  });

  it('★ HoT 周期跳同样不暴击（dealHeal canCrit:false 路径）', () => {
    def.health = def.maxHealth - 500;
    atk.rng = critSeed();
    const before = atk.rng;
    const healed = dealHeal(ctx(), def, 100, { canCrit: false });
    expect(healed).toBe(100);
    expect(lastHeal()?.crit).toBeUndefined();
    expect(atk.rng).toBe(before);
  });
});
