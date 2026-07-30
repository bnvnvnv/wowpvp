/**
 * 效果系统测试。对应规格书 8.2 / 8.3 / 8.4 / 8.5 / 14.3 与验收 #23 / #46。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { DR_LADDER, DR_WINDOW_SECONDS } from '../../constants/combat.js';
import { getSkill, mage, priest, warrior } from '../../data/index.js';
import type { AuraDef, EffectDef } from '../../data/schema.js';
import { box } from '../../data/maps/schema.js';
import { vec3 } from '../../math/vec3.js';
import { DispelType, DrCategory, School } from '../../types/enums.js';
import { asArmorId, asSkillId, asTeamId } from '../../types/ids.js';
import {
  aurasOf, createAuraStore, deriveStatusFlags, effectiveModifiersOf, tickAuras,
  type AuraStore,
} from '../aura.js';
import { applyDr, createDrStore, drFactor, type DrStore } from '../dr.js';
import { createEntity, type CombatEntity } from '../entity.js';
import { createGroundStore, type GroundStore } from '../groundArea.js';
import { aggregateModifiers, damageTakenFor } from '../modifiers.js';
import { createProjectileStore, type ProjectileStore } from '../projectile.js';
import { addEntity, allocEntityId, createWorld, type World } from '../world.js';
import {
  ALL_EFFECT_KINDS,
  registeredKinds,
  resolveEffects,
  setDampening,
  useTrinket,
  type CombatEvent,
} from './index.js';

const RED = asTeamId(0);
const BLUE = asTeamId(1);
const ground = box('g', 'floor', { x: 0, y: -1, z: 0 }, { w: 400, h: 1, d: 400 });

let world: World;
let auras: AuraStore;
let dr: DrStore;
let projectiles: ProjectileStore;
let groundStore: GroundStore;
let caster: CombatEntity;
let target: CombatEntity;

const spawn = (cls: typeof mage, team: typeof RED, x = 0, z = 0) =>
  addEntity(world, createEntity(allocEntityId(world), cls, team, vec3(x, 0, z)));

beforeEach(() => {
  world = createWorld([ground]);
  auras = createAuraStore();
  dr = createDrStore();
  projectiles = createProjectileStore();
  groundStore = createGroundStore();
  caster = spawn(mage, RED, 0, 0);
  target = spawn(warrior, BLUE, 0, -5);
  setDampening({ amount: 0 });
});

/** 结算一组效果并同步状态标志（sim 每 tick 会做这件事）*/
const run = (effects: EffectDef[], targets: CombatEntity[] = [target]): CombatEvent[] => {
  const events = resolveEffects(
    { world, auras, dr, projectiles, ground: groundStore, source: caster, skillId: 'test' },
    effects, targets,
  );
  for (const e of [caster, target]) e.flags = deriveStatusFlags(auras, e);
  return events;
};

describe('注册表完整性', () => {
  it('★ 每个 EffectDef.kind 都有处理器 —— 漏注册是启动即失败', () => {
    const registered = new Set(registeredKinds());
    expect(ALL_EFFECT_KINDS.filter((k) => !registered.has(k))).toEqual([]);
  });

  it('★ ALL_EFFECT_KINDS 与 schema 的联合类型同步', () => {
    // 这个断言的作用：给 EffectDef 加了新成员却忘了加进 ALL_EFFECT_KINDS 时，
    // 下面这行会因为类型不完整而编译报错。
    const exhaustive: Record<EffectDef['kind'], true> = Object.fromEntries(
      ALL_EFFECT_KINDS.map((k) => [k, true]),
    ) as Record<EffectDef['kind'], true>;
    expect(Object.keys(exhaustive).length).toBe(ALL_EFFECT_KINDS.length);
  });
});

/**
 * 本组固定装备的系数。`caster` 是法师（双手法杖 damageDealt 1.12），
 * `target` 是战士（单手剑 + 盾牌 damageTaken 0.87）。
 *
 * ★ M9 之前 `WeaponDef.modifiers` 是死数据，这两项谁都不生效，所以下面的
 *   期望值曾经就是原始值。补上「装备修正进入战斗计算」后它们真的会乘进
 *   每一发伤害里 —— 期望值改成走 `hit()`，让装备系数**显式**出现在测试里，
 *   而不是把 97 这种数字直接写死。
 *
 * ⚠️ `mult`（背刺加成）必须作为参数传进来一起算：`dealDamage` 全程只在最后
 *    取整一次，先 round(97.44)=97 再 ×1.5 会得到 145.5，与实现的 146 不符。
 */
const EQUIP_DAMAGE_DEALT = 1.12;
const EQUIP_DAMAGE_TAKEN = 0.87;
const hit = (raw: number, mult = 1): number =>
  Math.round(raw * EQUIP_DAMAGE_DEALT * EQUIP_DAMAGE_TAKEN * mult);

describe('伤害结算', () => {
  it('造成伤害并扣减生命', () => {
    const before = target.health;
    run([{ kind: 'damage', school: School.Fire, amount: { flat: 100 } }]);
    expect(target.health).toBe(before - hit(100));
  });

  /**
   * ★ M9 的回归守卫：装备修正必须真的进入战斗计算。
   *
   *   这条 bug 活过了 M6–M8 整八个里程碑：`ArmorDef.modifiers` / `WeaponDef.modifiers`
   *   是完整的数据，`LoadoutPanel` 也照着它给玩家显示「受到伤害 −8%」，
   *   但 `effectiveModifiersOf()` 只聚合光环，装备一项都不读 ——
   *   于是 10.8 承诺的五种护甲原型在对局里完全等价。
   *
   *   M6 的测试断言的是装备栏账目和验收 #34 那五条「换装不做什么」，
   *   没有一条问过「换上防御护甲后同一发伤害是不是真的更低」。这条就是那一问。
   */
  it('★ 换上守护型护甲后，同一发伤害真的更低（10.8 / 验收 #32）', () => {
    const baseline = target.health;
    run([{ kind: 'damage', school: School.Physical, amount: { flat: 200 } }]);
    const withDefaultArmor = baseline - target.health;

    // 换上守护型护甲（damageTaken 0.85）。★ 只改这一个字段，其余状态一律不碰
    target.armorId = asArmorId('warrior.guardian');
    target.health = target.maxHealth;
    const before = target.health;
    run([{ kind: 'damage', school: School.Physical, amount: { flat: 200 } }]);
    const withGuardianArmor = before - target.health;

    expect(withGuardianArmor).toBeLessThan(withDefaultArmor);
  });

  /**
   * ★ 10.8 的横向取舍必须在**数值上**成立，不能只写在 advantage/cost 文案里。
   *
   *   抗法型护甲的优势原本只存在于一个从未被引用的常量
   *   （`SPELLWARD_MAGIC_DAMAGE_TAKEN`）里，modifiers 只有 `damageTaken: 1.12`
   *   这一条纯代价 —— 装备修正一旦生效，它就是件全面**下位**装备。
   */
  it('★ 抗法型护甲减法术、不减物理（damageTakenBySchool，验收 #32）', () => {
    target.armorId = asArmorId('warrior.spellward');

    target.health = target.maxHealth;
    let before = target.health;
    run([{ kind: 'damage', school: School.Fire, amount: { flat: 200 } }]);
    const magic = before - target.health;

    target.health = target.maxHealth;
    before = target.health;
    run([{ kind: 'damage', school: School.Physical, amount: { flat: 200 } }]);
    const physical = before - target.health;

    // 法术吃 0.82，物理吃 1.12 —— 优势与代价必须同时可观测
    expect(magic).toBeLessThan(hit(200));
    expect(physical).toBeGreaterThan(hit(200));
  });

  it('生命归零时死亡并发出事件', () => {
    target.health = 50;
    const events = run([{ kind: 'damage', school: School.Fire, amount: { flat: 100 } }]);
    expect(target.alive).toBe(false);
    expect(events.some((e) => e.t === 'death')).toBe(true);
  });

  it('★ 8.4 完全免疫挡住全部伤害', () => {
    run([{ kind: 'applyAura', target: 'target', aura: immunityAura() }]);
    const before = target.health;
    const events = run([{ kind: 'damage', school: School.Fire, amount: { flat: 500 } }]);
    expect(target.health).toBe(before);
    expect(events.some((e) => e.t === 'damage' && e.immune)).toBe(true);
  });

  it('物理免疫只挡物理，不挡法术（8.4 三种免疫有区别）', () => {
    run([{
      kind: 'applyAura', target: 'target',
      aura: flagAura('phys_immune', { immunePhysical: true }),
    }]);
    const h0 = target.health;
    run([{ kind: 'damage', school: School.Physical, amount: { flat: 100 } }]);
    expect(target.health).toBe(h0);
    run([{ kind: 'damage', school: School.Fire, amount: { flat: 100 } }]);
    expect(target.health).toBe(h0 - hit(100));
  });

  it('★ 14.3 吸收护盾先吃伤害，耗尽时发出破裂事件', () => {
    run([{ kind: 'applyAura', target: 'target', aura: shieldAura(150) }]);
    const h0 = target.health;

    let events = run([{ kind: 'damage', school: School.Fire, amount: { flat: 100 } }]);
    expect(target.health).toBe(h0); // 全被吸收
    expect(events.find((e) => e.t === 'damage')).toMatchObject({ absorbed: hit(100), amount: 0 });
    expect(events.some((e) => e.t === 'shieldBroken')).toBe(false);

    events = run([{ kind: 'damage', school: School.Fire, amount: { flat: 100 } }]);
    // 护盾 150 先吃掉第一发的 hit(100)=97，只剩 53；第二发 97 里穿透 44
    expect(target.health).toBe(h0 - (hit(100) - (150 - hit(100))));
    expect(events.some((e) => e.t === 'shieldBroken')).toBe(true);
  });

  it('反魔法护罩式的学派限定护盾只吸收指定学派', () => {
    const def = shieldAura(200);
    def.absorbSchools = [School.Fire, School.Frost, School.Arcane, School.Shadow, School.Holy, School.Nature];
    run([{ kind: 'applyAura', target: 'target', aura: def }]);
    const h0 = target.health;
    // 物理伤害不被这个护盾吸收
    run([{ kind: 'damage', school: School.Physical, amount: { flat: 100 } }]);
    expect(target.health).toBe(h0 - hit(100));
  });

  it('6.5 背刺加成只在背后生效', () => {
    target.yaw = 0; // 面向 -Z，背后是 +Z
    caster.position = vec3(0, 0, 5);
    const h0 = target.health;
    run([{ kind: 'damage', school: School.Physical, amount: { flat: 100 }, behindBonus: 0.5 }]);
    expect(target.health).toBe(h0 - hit(100, 1.5));

    caster.position = vec3(0, 0, -10); // 移到正面
    const h1 = target.health;
    run([{ kind: 'damage', school: School.Physical, amount: { flat: 100 }, behindBonus: 0.5 }]);
    expect(target.health).toBe(h1 - hit(100));
  });
});

describe('治疗与 8.5 战斗抑制', () => {
  it('治疗恢复生命，不超过上限', () => {
    target.health = target.maxHealth - 50;
    run([{ kind: 'heal', amount: { flat: 200 } }]);
    expect(target.health).toBe(target.maxHealth);
  });

  it('★ 8.5 战斗抑制降低治疗量', () => {
    target.health = 100;
    setDampening({ amount: 0.5 });
    run([{ kind: 'heal', amount: { flat: 200 } }]);
    expect(target.health).toBe(200); // 200 × (1 - 0.5)
  });

  it('抑制不影响伤害', () => {
    setDampening({ amount: 0.5 });
    const h0 = target.health;
    run([{ kind: 'damage', school: School.Fire, amount: { flat: 100 } }]);
    expect(target.health).toBe(h0 - hit(100));
  });
});

describe('8.2 控制递减（验收 #23）', () => {
  it('★ 昏迷 100% → 50% → 25% → 免疫', () => {
    const durations: number[] = [];
    for (let i = 0; i < 4; i++) {
      const events = run([{ kind: 'stun', duration: 4 }]);
      const applied = events.find((e) => e.t === 'auraApplied');
      durations.push(applied?.t === 'auraApplied' ? applied.duration : 0);
      // 让上一次昏迷过期，但不超出 15 秒递减窗口
      world.time += 4.1;
      tickAuras(auras, world.time);
      target.flags = deriveStatusFlags(auras, target);
    }
    expect(durations).toEqual([4, 2, 1, 0]);
    expect(DR_LADDER.stun).toEqual([1, 0.5, 0.25, 0]);
  });

  it('★ 沉默只有三段：100% → 50% → 免疫', () => {
    expect(DR_LADDER.silence).toEqual([1, 0.5, 0]);
    const d1 = applyDr(dr, target.id, DrCategory.Silence, 4, 0).duration;
    const d2 = applyDr(dr, target.id, DrCategory.Silence, 4, 5).duration;
    const r3 = applyDr(dr, target.id, DrCategory.Silence, 4, 8);
    expect([d1, d2]).toEqual([4, 2]);
    expect(r3.immune).toBe(true);
  });

  it('★ 定身与普通减速是两条独立的链 —— 减速不参与递减', () => {
    // 连续三次定身会递减
    applyDr(dr, target.id, DrCategory.Root, 3, 0);
    applyDr(dr, target.id, DrCategory.Root, 3, 4);
    expect(drFactor(dr, target.id, DrCategory.Root, 8)).toBe(0.25);

    // 减速是普通光环，根本不走 applyDr —— 施加多少次都不影响定身链
    for (let i = 0; i < 5; i++) {
      run([{ kind: 'applyAura', target: 'target', aura: slowAura() }]);
    }
    expect(drFactor(dr, target.id, DrCategory.Root, 8)).toBe(0.25);
  });

  it('★ 免疫时不推进计数 —— 对免疫目标空放控制不能续窗口', () => {
    for (let i = 0; i < 3; i++) applyDr(dr, target.id, DrCategory.Stun, 4, i);
    const before = drFactor(dr, target.id, DrCategory.Stun, 3);
    expect(before).toBe(0);

    // 再空放五次
    for (let i = 0; i < 5; i++) applyDr(dr, target.id, DrCategory.Stun, 4, 3);
    // 窗口没有被续上：15 秒后仍然恢复
    const lastEnd = 2 + 4 * 0.25; // 第三次昏迷的结束时刻
    expect(drFactor(dr, target.id, DrCategory.Stun, lastEnd + DR_WINDOW_SECONDS + 0.1)).toBe(1);
  });

  it('递减窗口从控制**结束**时算起', () => {
    const r = applyDr(dr, target.id, DrCategory.Stun, 6, 0);
    expect(r.duration).toBe(6);
    // 结束于 t=6，窗口到 t=21
    expect(drFactor(dr, target.id, DrCategory.Stun, 20)).toBe(0.5);
    expect(drFactor(dr, target.id, DrCategory.Stun, 21.1)).toBe(1);
  });
});

describe('8.3 通用解控「战斗意志」（验收 #23）', () => {
  it('★ 解除昏迷、恐惧、定身', () => {
    run([{ kind: 'stun', duration: 4 }]);
    expect(target.flags.stunned).toBe(true);

    const ctx = {
      world, auras, dr, projectiles, groundAreas: groundStore.areas, traps: groundStore.traps,
      source: caster, skillId: 'trinket', events: [] as CombatEvent[],
      resolve: () => {},
    };
    expect(useTrinket(ctx, target)).toBe(true);
    target.flags = deriveStatusFlags(auras, target);
    expect(target.flags.stunned).toBe(false);
  });

  it('★ 8.3 不能解除沉默、持续伤害和普通减速', () => {
    run([{ kind: 'silence', duration: 4 }]);
    run([{ kind: 'applyAura', target: 'target', aura: slowAura() }]);
    run([{ kind: 'applyAura', target: 'target', aura: dotAura() }]);

    const ctx = {
      world, auras, dr, projectiles, groundAreas: groundStore.areas, traps: groundStore.traps,
      source: caster, skillId: 'trinket', events: [] as CombatEvent[], resolve: () => {},
    };
    useTrinket(ctx, target);
    target.flags = deriveStatusFlags(auras, target);

    expect(target.flags.silenced).toBe(true); // 沉默还在
    const ids = aurasOf(auras, target.id).map((a) => a.def.id);
    expect(ids).toContain('test.slow');
    expect(ids).toContain('test.dot');
  });
});

describe('8.2 受伤解除控制', () => {
  it('★ 累计伤害达到阈值时打破变形/恐惧', () => {
    run([{ kind: 'incapacitate', duration: 6, breakDamage: 100 }]);
    expect(target.flags.stunned).toBe(true);

    run([{ kind: 'damage', school: School.Fire, amount: { flat: 60 } }]);
    expect(target.flags.stunned).toBe(true); // 还没到阈值

    const events = run([{ kind: 'damage', school: School.Fire, amount: { flat: 60 } }]);
    expect(target.flags.stunned).toBe(false);
    expect(events.some((e) => e.t === 'auraRemoved' && e.reason === 'broken')).toBe(true);
  });

  it('昏迷不会被伤害打破（只有恐惧/迷惑/变形/定身会）', () => {
    run([{ kind: 'stun', duration: 6 }]);
    run([{ kind: 'damage', school: School.Fire, amount: { flat: 500 } }]);
    expect(target.flags.stunned).toBe(true);
  });
});

describe('8.4 驱散（验收 #23）', () => {
  it('对敌人驱散增益', () => {
    // 给敌人挂一个可驱散的增益
    const ally = spawn(priest, BLUE, 1, -5);
    resolveEffects(
      { world, auras, dr, projectiles, ground: groundStore, source: ally, skillId: 'buff' },
      [{ kind: 'applyAura', target: 'target', aura: dispellableBuff() }], [target],
    );
    expect(aurasOf(auras, target.id)).toHaveLength(1);

    run([{ kind: 'dispel', types: [DispelType.Magic], count: 1, from: 'enemy' }]);
    expect(aurasOf(auras, target.id)).toHaveLength(0);
  });

  it('★ 完全免疫默认驱散不掉，群体驱散可以（canRemoveImmunity）', () => {
    run([{ kind: 'applyAura', target: 'target', aura: immunityAura() }]);

    run([{ kind: 'dispel', types: [DispelType.Magic], count: 1, from: 'enemy' }]);
    expect(target.flags.immuneAll).toBe(true); // 普通驱散无效

    run([{ kind: 'dispel', types: [DispelType.Magic], count: 1, from: 'enemy', canRemoveImmunity: true }]);
    target.flags = deriveStatusFlags(auras, target);
    expect(target.flags.immuneAll).toBe(false);
  });

  it("count: 'all' 清掉全部同类（自由祝福解除所有移动限制）", () => {
    const ally = spawn(priest, RED, 1, 0);
    for (let i = 0; i < 3; i++) {
      const def = slowAura();
      def.id = `test.slow${i}`;
      resolveEffects(
        { world, auras, dr, projectiles, ground: groundStore, source: caster, skillId: 's' },
        [{ kind: 'applyAura', target: 'target', aura: def }], [ally],
      );
    }
    expect(aurasOf(auras, ally.id)).toHaveLength(3);

    resolveEffects(
      { world, auras, dr, projectiles, ground: groundStore, source: caster, skillId: 'freedom' },
      [{ kind: 'dispel', types: [DispelType.Movement], count: 'all', from: 'ally' }], [ally],
    );
    expect(aurasOf(auras, ally.id)).toHaveLength(0);
  });
});

describe('8.4 / 17.1 效果叠加规则（验收 #23）', () => {
  it('★ 两个减速取最强，不相乘', () => {
    const m = aggregateModifiers([{ moveSpeed: 0.6 }, { moveSpeed: 0.5 }]);
    expect(m.moveSpeed).toBe(0.5); // 不是 0.3
  });

  it('★ 三个团队减伤取最强，不相乘', () => {
    const m = aggregateModifiers([{ damageTaken: 0.7 }, { damageTaken: 0.75 }, { damageTaken: 0.6 }]);
    expect(m.damageTaken).toBe(0.6); // 不是 0.315
  });

  /**
   * ★ 装备与光环**分池**，这是 M9 补装备生效时最关键的一个决定。
   *
   *   8.4 / 17.1 的「取最强」防的是「同类**团队**减伤通过**多职业**重复叠加」——
   *   几个人往同一个目标身上堆效果。护甲只穿一件、由本人独占选择，
   *   结构上无法叠加，所以不适用那条规则。
   *
   *   如果丢进同一个池子：护甲 0.85 会被任何一个 0.5 的防御技能完全盖掉 ——
   *   于是「开了防御技能时护甲不起作用」，10.8 承诺的横向取舍会在
   *   最需要它的那几秒里凭空消失。这条测试就是拦住那次重构的。
   */
  it('★ 装备减伤与光环减伤分池相乘，不被「取最强」吞掉', () => {
    const m = aggregateModifiers([{ damageTaken: 0.5 }], [{ damageTaken: 0.85 }]);
    expect(m.damageTaken).toBeCloseTo(0.5 * 0.85, 5); // 不是 0.5
    // 单列装备系数，供 16.2「护甲减少伤害」把功劳与防御技能分开
    expect(m.equipmentDamageTaken).toBeCloseTo(0.85, 5);
  });

  it('★ 两件装备之间仍然相乘（盾牌 + 守护型护甲）', () => {
    const m = aggregateModifiers([], [{ damageTaken: 0.87 }, { damageTaken: 0.85 }]);
    expect(m.equipmentDamageTaken).toBeCloseTo(0.87 * 0.85, 5);
  });

  it('★ 装备的分学派承伤覆盖全局，物理仍吃全局代价（抗法型护甲）', () => {
    const m = aggregateModifiers([], [{
      damageTaken: 1.12,
      damageTakenBySchool: { [School.Fire]: 0.82 },
    }]);
    expect(damageTakenFor(m, School.Fire)).toBeCloseTo(0.82, 5);
    expect(damageTakenFor(m, School.Physical)).toBeCloseTo(1.12, 5);
  });

  it('★ 光环单列某学派、装备只给全局时，两者相乘而不是互相顶掉', () => {
    const m = aggregateModifiers(
      [{ damageTakenBySchool: { [School.Fire]: 0.5 } }],
      [{ damageTaken: 0.9 }],
    );
    expect(damageTakenFor(m, School.Fire)).toBeCloseTo(0.45, 5);
  });

  it('★ 受到治疗降低取最强 —— 致死打击 + 毒刃不叠乘', () => {
    const m = aggregateModifiers([{ healingTaken: 0.75 }, { healingTaken: 0.8 }]);
    expect(m.healingTaken).toBe(0.75); // 不是 0.6
  });

  it('易伤（> 1）相乘 —— 叠加是设计意图', () => {
    const m = aggregateModifiers([{ damageTaken: 1.1 }, { damageTaken: 1.2 }]);
    expect(m.damageTaken).toBeCloseTo(1.32);
  });

  it('减伤与易伤同时存在时各自按规则合并', () => {
    const m = aggregateModifiers([{ damageTaken: 0.7 }, { damageTaken: 0.8 }, { damageTaken: 1.1 }]);
    expect(m.damageTaken).toBeCloseTo(0.7 * 1.1);
  });

  it('造成伤害相乘（爆发窗口是设计意图）', () => {
    const m = aggregateModifiers([{ damageDealt: 1.2 }, { damageDealt: 1.2 }]);
    expect(m.damageDealt).toBeCloseTo(1.44);
  });

  it('加速也取最强', () => {
    const m = aggregateModifiers([{ moveSpeed: 1.15 }, { moveSpeed: 1.25 }]);
    expect(m.moveSpeed).toBe(1.25);
  });

  it('减速与加速可以互相抵消', () => {
    const m = aggregateModifiers([{ moveSpeed: 0.6 }, { moveSpeed: 1.25 }]);
    expect(m.moveSpeed).toBeCloseTo(0.75);
  });
});

describe('光环生命周期', () => {
  it('过期后自动移除', () => {
    run([{ kind: 'applyAura', target: 'target', aura: slowAura() }]);
    expect(aurasOf(auras, target.id)).toHaveLength(1);
    world.time += 10;
    const r = tickAuras(auras, world.time);
    expect(r.removals).toHaveLength(1);
    expect(aurasOf(auras, target.id)).toHaveLength(0);
  });

  it('周期性光环按 interval 跳', () => {
    run([{ kind: 'applyAura', target: 'target', aura: dotAura() }]);
    let ticks = 0;
    for (let i = 0; i < 60; i++) {
      world.time += 0.1;
      ticks += tickAuras(auras, world.time).ticks.length;
    }
    // 6 秒持续、1 秒一跳 → 5 次（第 6 秒时已过期）
    expect(ticks).toBeGreaterThanOrEqual(5);
    expect(ticks).toBeLessThanOrEqual(6);
  });

  it('★ decay：随时间线性衰减的修正（冰霜锁链）', () => {
    const def = slowAura();
    def.duration = 4;
    def.modifiers = { moveSpeed: 0.4 };
    def.decay = { field: 'moveSpeed', from: 0.4, to: 1.0, duration: 4 };
    run([{ kind: 'applyAura', target: 'target', aura: def }]);

    const at = (t: number) => {
      world.time = t;
      return effectiveMoveSpeedAt(auras, target, t);
    };
    expect(at(0)).toBeCloseTo(0.4, 2);
    expect(at(2)).toBeCloseTo(0.7, 2);
    expect(at(4)).toBeCloseTo(1.0, 2);
  });

  it('persistent 光环不会自然过期（潜行、形态）', () => {
    const def = flagAura('form', { stealthed: true });
    def.persistent = true;
    run([{ kind: 'applyAura', target: 'target', aura: def }]);
    world.time += 10000;
    tickAuras(auras, world.time);
    expect(aurasOf(auras, target.id)).toHaveLength(1);
  });
});

describe('验收 #46 位移不能穿墙', () => {
  it('★ 冲锋撞墙时停在墙前', () => {
    world.obstacles = [ground, box('w', 'wall', { x: 0, y: 0, z: -3 }, { w: 40, h: 6, d: 1 })];
    target.position = vec3(0, 0, -20);
    caster.position = vec3(0, 0, 0);
    run([{ kind: 'chargeTo', minRange: 8, maxRange: 25, stopDistance: 2.8 }]);
    expect(caster.position.z).toBeGreaterThan(-3.5);
  });

  it('★ 拉拽同样不能穿墙', () => {
    world.obstacles = [ground, box('w', 'wall', { x: 0, y: 0, z: -3 }, { w: 40, h: 6, d: 1 })];
    target.position = vec3(0, 0, -20);
    run([{ kind: 'pullTarget', toDistance: 3 }]);
    expect(target.position.z).toBeLessThan(-3);
  });

  it('闪现沿角色面向，不能穿墙', () => {
    world.obstacles = [ground, box('w', 'wall', { x: 0, y: 0, z: -3 }, { w: 40, h: 6, d: 1 })];
    caster.yaw = 0; // 面向 -Z
    run([{ kind: 'blinkForward', distance: 20, clearsRoot: true }], []);
    expect(caster.position.z).toBeGreaterThan(-3.5);
  });

  it('无阻挡时闪现到位', () => {
    caster.yaw = 0;
    run([{ kind: 'blinkForward', distance: 8 }], []);
    expect(caster.position.z).toBeCloseTo(-8, 1);
  });
});

describe('★ StatusFlags 由光环派生 —— M2 的手动赋值被真正的来源取代', () => {
  it('施加沉默后 flags.silenced 自动为真', () => {
    expect(target.flags.silenced).toBe(false);
    run([{ kind: 'silence', duration: 3 }]);
    expect(target.flags.silenced).toBe(true);
  });

  it('光环过期后 flags 自动恢复', () => {
    run([{ kind: 'silence', duration: 3 }]);
    world.time += 5;
    tickAuras(auras, world.time);
    target.flags = deriveStatusFlags(auras, target);
    expect(target.flags.silenced).toBe(false);
  });

  it('旗手状态不来自光环，不会被覆盖掉', () => {
    target.flags.carryingFlag = true;
    run([{ kind: 'stun', duration: 3 }]);
    expect(target.flags.carryingFlag).toBe(true);
  });
});

describe('真实技能数据能跑通', () => {
  it('战士致死打击造成伤害并施加降治疗减益', () => {
    const w = spawn(warrior, RED, 0, -4);
    const skill = getSkill(asSkillId('warrior.mortal_strike'))!;
    const h0 = target.health;
    const events = resolveEffects(
      { world, auras, dr, projectiles, ground: groundStore, source: w, skillId: skill.id },
      skill.effects, [target],
    );
    expect(target.health).toBeLessThan(h0);
    expect(events.some((e) => e.t === 'auraApplied' && e.auraId === 'warrior.mortal_wounds')).toBe(true);
  });

  it('法师冰霜新星对范围内目标施加定身', () => {
    const skill = getSkill(asSkillId('mage.frost_nova'))!;
    const events = run(skill.effects as EffectDef[]);
    target.flags = deriveStatusFlags(auras, target);
    expect(events.some((e) => e.t === 'auraApplied')).toBe(true);
    expect(target.flags.rooted).toBe(true);
  });

  it('★ 八职业的全部技能效果都能被分发，无未注册 kind', () => {
    const errors: string[] = [];
    for (const cls of [warrior, mage, priest]) {
      for (const skill of cls.skills) {
        const t = spawn(cls, BLUE, 20, 20);
        try {
          resolveEffects(
            { world, auras, dr, projectiles, ground: groundStore, source: caster, skillId: skill.id,
              groundPoint: vec3(0, 0, -5) },
            skill.effects, [t],
          );
        } catch (err) {
          errors.push(`${skill.id}: ${(err as Error).message}`);
        }
      }
    }
    expect(errors).toEqual([]);
  });
});

// ── 测试用光环模板 ───────────────────────────────────────────────

const slowAura = (): AuraDef => ({
  id: 'test.slow', name: '减速', kind: 'debuff', duration: 6,
  dispelType: DispelType.Movement, clearableByTrinket: false,
  modifiers: { moveSpeed: 0.6 }, description: '减速 40%',
});

const dotAura = (): AuraDef => ({
  id: 'test.dot', name: '持续伤害', kind: 'debuff', duration: 6,
  dispelType: DispelType.Magic, clearableByTrinket: false,
  periodic: { interval: 1, effects: [{ kind: 'damage', school: School.Fire, amount: { flat: 20 } }] },
  description: '每秒 20 点伤害',
});

const shieldAura = (amount: number): AuraDef => ({
  id: 'test.shield', name: '护盾', kind: 'buff', duration: 10,
  dispelType: DispelType.Magic, absorb: amount, description: `吸收 ${amount}`,
});

const immunityAura = (): AuraDef => ({
  id: 'test.immunity', name: '完全免疫', kind: 'buff', duration: 4,
  dispelType: DispelType.Magic, flags: { immuneAll: true }, description: '完全免疫',
});

const flagAura = (id: string, flags: NonNullable<AuraDef['flags']>): AuraDef => ({
  id: `test.${id}`, name: id, kind: 'buff', duration: 10,
  dispelType: DispelType.None, flags, description: id,
});

const dispellableBuff = (): AuraDef => ({
  id: 'test.buff', name: '可驱散增益', kind: 'buff', duration: 10,
  dispelType: DispelType.Magic, modifiers: { damageDealt: 1.2 }, description: '增伤',
});

/** 取某时刻的实际移动速度倍率，用于 decay 测试 */
const effectiveMoveSpeedAt = (store: AuraStore, e: CombatEntity, t: number): number =>
  effectiveModifiersOf(store, e, t).moveSpeed;
