/**
 * W26：`AuraModifiers` 五个「只聚合、没有消费方」的字段接线
 * （PROGRESS 技术债 §9，2026-08-08 大乱斗派对道具批发现，本轮清账）。
 *
 * ★★ **这里每一条断言钉的都是「它现在真的会发生」，不是「重构前后一致」。**
 *   接线之前 `sim/modifiers.ts` 把这五个字段乘进了 `EffectiveModifiers`，
 *   然后**没有任何下游读它们** —— 熊形态的「生命上限 +20%」、守护甲的
 *   「攻速降低」、权杖的「读条 -15%」、机动甲的「击退抵抗降低」全部只写在
 *   `advantage` / `description` 里。这类缺陷不报错、不变红，只有文案变成谎话，
 *   是本仓库点过名最难查的一类。
 *
 * 五条接线各自的落点：
 *   · `castSpeed`      → `casting.castTimeOf`（读条段，**不含**引导时长）
 *   · `attackSpeed`    → `autoAttack.swingIntervalOf`（挥击间隔，> 1 = 更慢）
 *   · `knockbackTaken` → `effects/displacement` 的 `knockback` 处理器
 *   · `maxHealth`      → `entity.applyMaxHealthMultiplier`（tickWorld 第 7 步）
 *   · `absorbDone`     → `aura.applyAura` 的 `absorbScale`（护盾发放量）
 */

import { describe, expect, it } from 'vitest';
import { druid, getSkill, getWeapon, mage, paladin, priest, warrior } from '../data/index.js';
import type { AuraDef, EffectDef, SkillDef } from '../data/schema.js';
import { box } from '../data/maps/schema.js';
import { dirToYaw, sub, vec3, type Vec3 } from '../math/vec3.js';
import { ArenaPreset, CastKind, DispelType } from '../types/enums.js';
import { asArmorId, asTeamId, asWeaponId, type EntityId } from '../types/ids.js';
import { applyAura, createAuraStore, effectiveModifiersOf, type AuraStore } from './aura.js';
import { swingIntervalOf, beginSwing, createSwingStore, tickSwings } from './autoAttack.js';
import { castTimeOf, createCastingStore, getCast } from './casting.js';
import { createDrStore } from './dr.js';
import { createArsenalStore, createPickupStore } from './arsenal.js';
import { applyMaxHealthMultiplier, createEntity, type CombatEntity } from './entity.js';
import { createGroundStore } from './groundArea.js';
import { createLoadout, createLoadoutStore, createSwapStore } from './loadout.js';
import type { MovementInput, MovementState } from './movement.js';
import { createProjectileStore } from './projectile.js';
import { resolveEffects } from './effects/index.js';
import { tickWorld, type TickDeps } from './tick.js';
import { addEntity, allocEntityId, createWorld, type World } from './world.js';

const RED = asTeamId(0);
const BLUE = asTeamId(1);
const FLOOR = box('g', 'floor', { x: 0, y: -1, z: 0 }, { w: 400, h: 1, d: 400 });
const DT = 0.05;

const skillOf = (cls: { skills: readonly SkillDef[] }, id: string): SkillDef =>
  cls.skills.find((s) => (s.id as string) === id)!;

const BEAR_FORM = skillOf(druid, 'druid.bear_form');
const FROSTBOLT = skillOf(mage, 'mage.frostbolt');
const BLIZZARD = skillOf(mage, 'mage.blizzard');

// ── 通用夹具 ─────────────────────────────────────────────────────

interface Rig {
  world: World;
  auras: AuraStore;
  deps: (castRequests?: TickDeps['castRequests']) => TickDeps;
  spawn: (cls: typeof mage, team: typeof RED, at: Vec3) => CombatEntity;
}

const makeRig = (): Rig => {
  const world = createWorld([FLOOR]);
  const auras = createAuraStore();
  const dr = createDrStore();
  const ground = createGroundStore();
  const projectiles = createProjectileStore();
  const casting = createCastingStore();
  const loadouts = createLoadoutStore();
  const movement = new Map<EntityId, MovementState>();
  const inputs = new Map<EntityId, MovementInput>();
  const arsenal = createArsenalStore(ArenaPreset.Classic);
  const swaps = createSwapStore();
  const pickups = createPickupStore();

  const spawn = (cls: typeof mage, team: typeof RED, at: Vec3): CombatEntity => {
    const e = addEntity(world, createEntity(allocEntityId(world), cls, team, { ...at }));
    loadouts.set(e.id, createLoadout(e.classId));
    for (const [r, max] of e.maxResources) e.resources.set(r, max);
    return e;
  };

  const deps: Rig['deps'] = (castRequests) => ({
    world, auras, dr, ground, projectiles, casting,
    loadouts, swaps, pickups, arsenal, movement, inputs, getSkill,
    ...(castRequests ? { castRequests } : {}),
  });

  return { world, auras, deps, spawn };
};

const advance = (rig: Rig, n: number, castRequests?: TickDeps['castRequests']): void => {
  for (let i = 0; i < n; i++) tickWorld(rig.deps(i === 0 ? castRequests : undefined), DT);
};

/** 造一枚只带某一个修正的测试光环。★ 不改任何真实数据 */
const modAura = (id: string, modifiers: AuraDef['modifiers']): AuraDef => ({
  id, name: id, kind: 'buff', duration: 600,
  dispelType: DispelType.None, clearableByTrinket: false,
  modifiers, description: id,
});

// ════════════════════════════════════════════════════════════════
//  1. castSpeed → 读条时长
// ════════════════════════════════════════════════════════════════

describe('★★ castSpeed 接进读条（W26 之前 6 处数据源一处都没生效）', () => {
  it('★★ 生效：法杖 castSpeed 1.1 让霜矢读条真的变长 10%', () => {
    const rig = makeRig();
    const caster = rig.spawn(mage, RED, vec3(0, 0, 0));
    const foe = rig.spawn(warrior, BLUE, vec3(0, 0, 12));
    caster.yaw = dirToYaw(sub(foe.position, caster.position));
    // 法杖是法师的**默认**武器 —— 这条不是「换上某件装备之后」，是常态
    expect(caster.weaponId as string).toBe('mage.staff');

    advance(rig, 1, new Map([[caster.id, { skillId: FROSTBOLT.id, targetId: foe.id }]]));
    const st = getCast(rig.deps().casting, caster.id)!;
    expect(st, '读条没起来').toBeDefined();
    expect(st.endsAt - st.startedAt).toBeCloseTo(FROSTBOLT.cast.time * 1.1, 6);
  });

  it('★★ 反向也成立：魔杖法球 0.88 让同一发霜矢读条变短 12%', () => {
    const rig = makeRig();
    const caster = rig.spawn(mage, RED, vec3(0, 0, 0));
    const foe = rig.spawn(warrior, BLUE, vec3(0, 0, 12));
    caster.yaw = dirToYaw(sub(foe.position, caster.position));
    caster.weaponId = asWeaponId('mage.wand_orb');

    advance(rig, 1, new Map([[caster.id, { skillId: FROSTBOLT.id, targetId: foe.id }]]));
    const st = getCast(rig.deps().casting, caster.id)!;
    expect(st.endsAt - st.startedAt).toBeCloseTo(FROSTBOLT.cast.time * 0.88, 6);
  });

  it('★ 光环与装备一起相乘（守护甲 1.08 × 法杖 1.1）', () => {
    const rig = makeRig();
    const caster = rig.spawn(mage, RED, vec3(0, 0, 0));
    const foe = rig.spawn(warrior, BLUE, vec3(0, 0, 12));
    caster.yaw = dirToYaw(sub(foe.position, caster.position));
    caster.armorId = asArmorId('mage.guardian');

    advance(rig, 1, new Map([[caster.id, { skillId: FROSTBOLT.id, targetId: foe.id }]]));
    const st = getCast(rig.deps().casting, caster.id)!;
    expect(st.endsAt - st.startedAt).toBeCloseTo(FROSTBOLT.cast.time * 1.1 * 1.08, 6);
  });

  /**
   * ★★ 边界：**瞬发不受影响**。`0 × 1.1` 仍是 0 —— 但这条不是同义反复：
   *   把倍率写成加法（`time + (scale - 1)`）或写成「至少 0.1 秒」的兜底，
   *   都会让全部瞬发技能突然长出一根读条，而单测里没人会去看瞬发的 endsAt。
   */
  it('★★ 边界：瞬发技能不会因为倍率长出一根读条', () => {
    const caster = createEntity(allocEntityId(createWorld([FLOOR])), mage, RED, vec3(0, 0, 0));
    expect(BEAR_FORM.cast.kind).toBe(CastKind.Instant);
    expect(castTimeOf(BEAR_FORM, caster, () => 1.5)).toBe(0);
    expect(castTimeOf(BEAR_FORM, caster, () => 0.5)).toBe(0);
  });

  /**
   * ★★ 边界：**引导时长不缩**。暴风雪的引导 4 秒对应它自己
   *   `spawnGroundArea.duration` 的 4 秒，两个数字必须相等
   *   （`tickWorld` 的打断分支靠这一点掐掉已生成的地面区域）。
   *   只缩 `channelEndsAt` 会得到「引导条走完了、雪还在下」。
   */
  it('★★ 边界：只缩前摇，引导段（channelEndsAt − endsAt）逐位不变', () => {
    const rig = makeRig();
    const caster = rig.spawn(mage, RED, vec3(0, 0, 0));
    rig.spawn(warrior, BLUE, vec3(0, 0, 12));
    expect(BLIZZARD.cast.kind).toBe(CastKind.Channel);

    advance(rig, 1, new Map([[caster.id, {
      skillId: BLIZZARD.id, groundPoint: vec3(0, 0, 12),
    }]]));
    const st = getCast(rig.deps().casting, caster.id)!;
    expect(st.endsAt - st.startedAt, '前摇没吃 castSpeed').toBeCloseTo(
      BLIZZARD.cast.time * 1.1, 6,
    );
    expect(st.channelEndsAt! - st.endsAt, '引导段被缩了 —— 雪会比引导条多下一截').toBeCloseTo(
      BLIZZARD.cast.channelDuration!, 6,
    );
  });

  /**
   * ★★ 排队窗（P10 / 合同 C5）走的是**同一个**倍率闭包。
   *   `tickCastQueue` 内部另有一次 `beginCast()`，漏传就会出现
   *   「直接放吃护甲代价、排队放不吃」这种没有任何断言看得见的分歧。
   */
  it('★★ 排队窗放出来的那一发同样吃倍率（三个施法入口共用一个闭包）', () => {
    const rig = makeRig();
    const caster = rig.spawn(mage, RED, vec3(0, 0, 0));
    const foe = rig.spawn(warrior, BLUE, vec3(0, 0, 12));
    caster.yaw = dirToYaw(sub(foe.position, caster.position));
    // 手工把它按进排队窗：GCD 未走完 + queue: true
    const queue = new Map();
    const depsWithQueue = (castRequests?: TickDeps['castRequests']): TickDeps => ({
      ...rig.deps(castRequests), castQueue: queue,
    });
    caster.gcdUntil = 10;
    tickWorld(
      depsWithQueue(new Map([[caster.id, {
        skillId: FROSTBOLT.id, targetId: foe.id, queue: true,
      }]])),
      DT,
    );
    expect(queue.size, '没进排队窗，这条测试就没在测排队路径').toBe(1);
    caster.gcdUntil = 0;
    tickWorld(depsWithQueue(), DT);

    const st = getCast(rig.deps().casting, caster.id)!;
    expect(st, '排队的那一发没放出来').toBeDefined();
    expect(st.endsAt - st.startedAt).toBeCloseTo(FROSTBOLT.cast.time * 1.1, 6);
  });
});

// ════════════════════════════════════════════════════════════════
//  2. attackSpeed → 挥击间隔
// ════════════════════════════════════════════════════════════════

describe('★★ attackSpeed 接进挥击间隔（方向：> 1 = 更慢）', () => {
  const rigFor = (armor?: string) => {
    const world = createWorld([FLOOR]);
    const auras = createAuraStore();
    const swings = createSwingStore();
    const atk = addEntity(world, createEntity(allocEntityId(world), warrior, RED, vec3(0, 0, 0)));
    const foe = addEntity(world, createEntity(allocEntityId(world), mage, BLUE, vec3(0, 0, 2)));
    atk.targets.hard = foe.id;
    atk.yaw = dirToYaw(sub(foe.position, atk.position));
    if (armor) atk.armorId = asArmorId(armor);
    return { world, auras, swings, atk, foe, deps: { world, auras, swings } };
  };

  it('★★ 生效：守护型护甲 1.08 = 每刀多花 8% 时间（文案「攻速降低」兑现）', () => {
    const base = rigFor();
    const guard = rigFor('warrior.guardian');
    const b = swingIntervalOf(base.auras, base.atk, 0);
    const g = swingIntervalOf(guard.auras, guard.atk, 0);
    expect(g).toBeCloseTo(b * 1.08, 6);
    expect(g, '接反了：守护甲变成了攻速加快').toBeGreaterThan(b);
  });

  // 小于 1 的那一档（BOSS 狂暴 0.8 = 攻速 +25%）。数值与 BOSS 数据同步，
  // 但**不 import** `BOSS_ENRAGE_AURA` —— 这里验的是引擎方向，不是那条数据；
  // 文案与数值的对账在 `data/data.test.ts`，两处各管一件事。
  it('★★ 反向：小于 1 的光环让人挥得更快（BOSS 狂暴那一档）', () => {
    const r = rigFor();
    const before = swingIntervalOf(r.auras, r.atk, 0);
    applyAura(r.auras, r.atk, modAura('test.enrage', { attackSpeed: 0.8 }), r.atk.id, 0);
    expect(swingIntervalOf(r.auras, r.atk, 0)).toBeCloseTo(before * 0.8, 6);
  });

  it('★★ 真的推进到下一刀：慢 8% 的人在基准间隔那一刻还挥不出来', () => {
    const r = rigFor('warrior.guardian');
    const raw = swingIntervalOf(createAuraStore(), r.atk, 0); // 空光环仓 = 只有护甲
    const scaled = swingIntervalOf(r.auras, r.atk, 0);
    beginSwing(r.swings, r.atk.id, 0, scaled);

    expect(tickSwings(r.deps, raw / 1.08), '按未缩放的间隔就挥出来了').toEqual([]);
    const out = tickSwings(r.deps, scaled);
    expect(out).toHaveLength(1);
    expect(out[0]!.miss).toBeUndefined();
  });

  it('★ 下一刀的时刻按**挥出这一刀的时刻**取值（间隔是绝对时刻，不追溯重算）', () => {
    const r = rigFor();
    const base = swingIntervalOf(r.auras, r.atk, 0);
    beginSwing(r.swings, r.atk.id, 0, base);
    tickSwings(r.deps, base);
    // 挥完之后才挂减速光环 —— 已经排好的这一刀不受影响
    applyAura(r.auras, r.atk, modAura('test.slowatk', { attackSpeed: 2 }), r.atk.id, base);
    expect(r.swings.get(r.atk.id)!.nextSwingAt).toBeCloseTo(base * 2, 6);
  });

  it('★ 边界：无任何修正时逐位等于武器原值（接线不能顺手改基线）', () => {
    const r = rigFor();
    expect(swingIntervalOf(r.auras, r.atk, 0)).toBe(
      getWeapon(r.atk.weaponId)!.swingInterval,
    );
  });
});

// ════════════════════════════════════════════════════════════════
//  3. knockbackTaken → 击退距离
// ════════════════════════════════════════════════════════════════

describe('★★ knockbackTaken 接进击退距离（10.8 的横向取舍兑现）', () => {
  const knockOnce = (armor?: string): number => {
    const world = createWorld([FLOOR]);
    const auras = createAuraStore();
    const dr = createDrStore();
    const projectiles = createProjectileStore();
    const ground = createGroundStore();
    const source = addEntity(world, createEntity(allocEntityId(world), warrior, RED, vec3(0, 0, 0)));
    const target = addEntity(world, createEntity(allocEntityId(world), warrior, BLUE, vec3(0, 0, 5)));
    if (armor) target.armorId = asArmorId(armor);
    const effects: EffectDef[] = [{ kind: 'knockback', distance: 6 }];
    resolveEffects(
      { world, auras, dr, projectiles, ground, source, skillId: 'test' },
      effects, [target],
    );
    return target.position.z - 5;
  };

  it('★★ 基准：默认护甲被推 6 米（接线不能顺手改基线）', () => {
    expect(knockOnce()).toBeCloseTo(6, 6);
  });

  it('★★ 机动型护甲 1.25 = 被推得更远（12% 移速换来的代价）', () => {
    expect(knockOnce('warrior.mobility')).toBeCloseTo(6 * 1.25, 6);
  });

  it('★★ 抗控型护甲 0.6 = 被推得更近（advantage 里那句「击退距离降低」）', () => {
    expect(knockOnce('warrior.tenacity')).toBeCloseTo(6 * 0.6, 6);
  });

  it('★★ 读的是**被推的人**的抵抗，不是施法者的', () => {
    const world = createWorld([FLOOR]);
    const auras = createAuraStore();
    const dr = createDrStore();
    const projectiles = createProjectileStore();
    const ground = createGroundStore();
    const source = addEntity(world, createEntity(allocEntityId(world), warrior, RED, vec3(0, 0, 0)));
    const target = addEntity(world, createEntity(allocEntityId(world), warrior, BLUE, vec3(0, 0, 5)));
    // 抵抗挂在**施法者**身上：如果读错了人，距离会被缩到 3.6
    source.armorId = asArmorId('warrior.tenacity');
    resolveEffects(
      { world, auras, dr, projectiles, ground, source, skillId: 'test' },
      [{ kind: 'knockback', distance: 6 }], [target],
    );
    expect(target.position.z - 5).toBeCloseTo(6, 6);
  });

  it('★★ 边界：拉拽（pullTarget）不吃这个字段 —— 落点由施法者位置决定', () => {
    const world = createWorld([FLOOR]);
    const auras = createAuraStore();
    const dr = createDrStore();
    const projectiles = createProjectileStore();
    const ground = createGroundStore();
    const source = addEntity(world, createEntity(allocEntityId(world), warrior, RED, vec3(0, 0, 0)));
    const target = addEntity(world, createEntity(allocEntityId(world), warrior, BLUE, vec3(0, 0, 20)));
    target.armorId = asArmorId('warrior.tenacity');
    resolveEffects(
      { world, auras, dr, projectiles, ground, source, skillId: 'test' },
      [{ kind: 'pullTarget', toDistance: 3 }], [target],
    );
    expect(target.position.z, '拉拽被击退抵抗缩了 —— 人会被拽到半路上悬着').toBeCloseTo(3, 6);
  });
});

// ════════════════════════════════════════════════════════════════
//  4. maxHealth → 生命上限写回 + 变身血量守恒
// ════════════════════════════════════════════════════════════════

describe('★★ maxHealth 写回：幂等 + 血量百分比守恒（§9 点名最麻烦的一条）', () => {
  const bear = (): CombatEntity => {
    const world = createWorld([FLOOR]);
    return addEntity(world, createEntity(allocEntityId(world), druid, RED, vec3(0, 0, 0)));
  };

  it('★★ 生效：上限真的涨到 1.2 倍（德鲁伊 1050 → 1260）', () => {
    const e = bear();
    expect(e.baseMaxHealth).toBe(1050);
    applyMaxHealthMultiplier(e, 1.2);
    expect(e.maxHealth).toBe(1260);
  });

  /**
   * ★★ **幂等**是这条接线的命门：写成 `maxHealth *= 1.2` 的话，
   *   20Hz 下 3 秒就能把熊撑到 1500 倍血，而且不会有任何断言变红。
   */
  it('★★ 幂等：连算 200 次（10 秒的 tick 量）结果不动', () => {
    const e = bear();
    for (let i = 0; i < 200; i++) applyMaxHealthMultiplier(e, 1.2);
    expect(e.maxHealth).toBe(1260);
    expect(e.health).toBe(1050 * 1.2);
  });

  it('★★ 满血变身仍是满血（不是 1050/1260 那格空条）', () => {
    const e = bear();
    applyMaxHealthMultiplier(e, 1.2);
    expect(e.health).toBe(e.maxHealth);
  });

  it('★★ 80% 血变熊还是 80%（§9 的「变身瞬间掉血」正是这条）', () => {
    const e = bear();
    e.health = e.maxHealth * 0.8;
    applyMaxHealthMultiplier(e, 1.2);
    expect(e.health / e.maxHealth).toBeCloseTo(0.8, 10);
    expect(e.health).toBeCloseTo(1008, 6);
  });

  it('★★ 变回来不溢出、也不凭空掉血（比例原路返回）', () => {
    const e = bear();
    e.health = e.maxHealth * 0.8;
    applyMaxHealthMultiplier(e, 1.2);
    applyMaxHealthMultiplier(e, 1);
    expect(e.maxHealth).toBe(1050);
    expect(e.health, '当前血高过上限 —— 血条会画到 100% 以上').toBeLessThanOrEqual(e.maxHealth);
    expect(e.health).toBeCloseTo(840, 6);
  });

  it('★★ 边界：满血变回来**恰好**卡在上限，不多一滴', () => {
    const e = bear();
    applyMaxHealthMultiplier(e, 1.2);
    applyMaxHealthMultiplier(e, 1);
    expect(e.health).toBe(e.maxHealth);
  });

  it('★★ 边界：残血（1 点）变身不会被比例抹成 0', () => {
    const e = bear();
    e.health = 1;
    applyMaxHealthMultiplier(e, 1.2);
    expect(e.health).toBeGreaterThan(0);
    expect(e.health).toBeCloseTo(1.2, 6);
  });

  it('★★ 边界：死人（health 0）不会因为变身被拉起来', () => {
    const e = bear();
    e.health = 0;
    e.alive = false;
    applyMaxHealthMultiplier(e, 1.2);
    expect(e.health).toBe(0);
  });

  it('★ 边界：上限没变时一个字节都不写（避免每 tick 的浮点往返）', () => {
    const e = bear();
    e.health = 777.7777;
    applyMaxHealthMultiplier(e, 1);
    expect(e.health).toBe(777.7777);
  });

  /**
   * ★★ 全链路：真的放一次巨熊形态，看上限在**同一个 tick** 里就涨上去。
   *   写回放在光环推进之前的话要等下一 tick（50ms），那 50ms 里挨的一刀
   *   玩家会读作「变熊没加血还被偷了一下」。
   */
  it('★★ 全链路：castRequests → tickWorld 一个 tick 内上限就到位', () => {
    const rig = makeRig();
    const d = rig.spawn(druid, RED, vec3(0, 0, 0));
    d.health = d.maxHealth * 0.8;
    advance(rig, 1, new Map([[d.id, { skillId: BEAR_FORM.id }]]));
    expect(d.maxHealth).toBeCloseTo(1260, 6);
    expect(d.health / d.maxHealth, '变身瞬间掉了血').toBeCloseTo(0.8, 10);
  });

  it('★★ 全链路：熊形态光环过期后上限自己回落（写回是幂等重算，不需要谁记得撤）', () => {
    const rig = makeRig();
    const d = rig.spawn(druid, RED, vec3(0, 0, 0));
    advance(rig, 1, new Map([[d.id, { skillId: BEAR_FORM.id }]]));
    expect(d.maxHealth).toBeCloseTo(1260, 6);

    // 直接把光环仓清掉 = 模拟过期/驱散/回合重置
    rig.auras.set(d.id, []);
    advance(rig, 1);
    expect(d.maxHealth).toBe(1050);
    expect(d.health).toBeLessThanOrEqual(d.maxHealth);
  });

  /**
   * ★★ 竞技场回合重置（`arena.resetRound`）是「先 `health = maxHealth`、
   *   再 `clearAuras`」的顺序 —— 那一瞬当前血等于**熊的**上限 1260。
   *   下一 tick 的写回把上限拉回 1050，比例守恒（100%）把血跟着拉回 1050。
   *   顺序反过来写（先降上限再补血）会得到「新回合开局 83% 血」，
   *   而验收 #37 说的是「每回合开始时恢复生命」。
   */
  it('★★ 回合重置的写法（先满血再清光环）之后仍是满血、上限回落', () => {
    const rig = makeRig();
    const d = rig.spawn(druid, RED, vec3(0, 0, 0));
    advance(rig, 1, new Map([[d.id, { skillId: BEAR_FORM.id }]]));
    d.health = d.maxHealth * 0.5;
    advance(rig, 1);

    // resetRound 的那两行
    d.health = d.maxHealth;
    rig.auras.set(d.id, []);
    advance(rig, 1);

    expect(d.maxHealth).toBe(1050);
    expect(d.health).toBe(1050);
  });

  it('★★ 全链路：连跑 40 个 tick 不累乘（幂等在生产管线上也成立）', () => {
    const rig = makeRig();
    const d = rig.spawn(druid, RED, vec3(0, 0, 0));
    advance(rig, 1, new Map([[d.id, { skillId: BEAR_FORM.id }]]));
    advance(rig, 40);
    expect(d.maxHealth).toBeCloseTo(1260, 6);
  });
});

// ════════════════════════════════════════════════════════════════
//  5. absorbDone → 护盾发放量（零数据源 = 零行为变化）
// ════════════════════════════════════════════════════════════════

describe('★★ absorbDone 接进护盾发放量（本仓唯一零数据源的那一个）', () => {
  const shieldRig = () => {
    const world = createWorld([FLOOR]);
    const auras = createAuraStore();
    const dr = createDrStore();
    const projectiles = createProjectileStore();
    const ground = createGroundStore();
    const caster = addEntity(world, createEntity(allocEntityId(world), priest, RED, vec3(0, 0, 0)));
    const ally = addEntity(world, createEntity(allocEntityId(world), warrior, RED, vec3(0, 0, 3)));
    const cast = (effects: EffectDef[]): void => {
      resolveEffects(
        { world, auras, dr, projectiles, ground, source: caster, skillId: 'test' },
        effects, [ally],
      );
    };
    return { world, auras, caster, ally, cast };
  };

  const SHIELD = skillOf(priest, 'priest.power_word_shield');
  const shieldEffect = SHIELD.effects.find((e) => e.kind === 'applyAura')!;

  it('★★ 零数据源 = 零行为变化：真言术盾仍是数据里那个数', () => {
    const r = shieldRig();
    r.cast([shieldEffect]);
    const inst = r.auras.get(r.ally.id)!.find((a) => a.def.id === 'priest.power_word_shield')!;
    expect(inst.absorbInitial).toBe(330);
    expect(inst.absorbRemaining).toBe(330);
  });

  it('★★ 有人喂就生效：施加者带 absorbDone 1.3 → 盾大 30%', () => {
    const r = shieldRig();
    applyAura(r.auras, r.caster, modAura('test.absorb', { absorbDone: 1.3 }), r.caster.id, 0);
    r.cast([shieldEffect]);
    const inst = r.auras.get(r.ally.id)!.find((a) => a.def.id === 'priest.power_word_shield')!;
    expect(inst.absorbInitial).toBeCloseTo(330 * 1.3, 6);
  });

  it('★★ 读的是**施加者**的聚合值，不是被罩那个人的', () => {
    const r = shieldRig();
    applyAura(r.auras, r.ally, modAura('test.absorb', { absorbDone: 1.3 }), r.ally.id, 0);
    r.cast([shieldEffect]);
    const inst = r.auras.get(r.ally.id)!.find((a) => a.def.id === 'priest.power_word_shield')!;
    expect(inst.absorbInitial, '读成了被罩者的修正').toBe(330);
  });

  /**
   * ★★ `absorbPercentMaxHealth` 那条路也要吃 —— 它与固定值走的是
   *   `applyAura` 里同一个表达式，分岔写两处迟早只改一半。
   *   顺带钉住 W26 的一条交叉影响：**盾按施加瞬间的 maxHealth 换算**，
   *   所以先变熊再上盾，盾会跟着大 20%（骨盾 25% 上限的合理语义）。
   */
  it('★★ 百分比盾同吃；且它按施加瞬间的 maxHealth 换算（与熊形态交叉）', () => {
    const r = shieldRig();
    const pctShield: EffectDef = {
      kind: 'applyAura',
      aura: { ...modAura('test.pctshield', {}), absorbPercentMaxHealth: 0.25 },
    };
    r.cast([pctShield]);
    const before = r.auras.get(r.ally.id)!.find((a) => a.def.id === 'test.pctshield')!.absorbInitial;
    expect(before).toBeCloseTo(r.ally.maxHealth * 0.25, 6);

    applyMaxHealthMultiplier(r.ally, 1.2);
    applyAura(r.auras, r.caster, modAura('test.absorb', { absorbDone: 1.5 }), r.caster.id, 0);
    r.cast([pctShield]);
    const after = r.auras.get(r.ally.id)!.find((a) => a.def.id === 'test.pctshield')!.absorbInitial;
    expect(after).toBeCloseTo(r.ally.maxHealth * 0.25 * 1.5, 6);
  });

  it('★ 不是护盾的光环不受影响（也不该为它白算一次聚合）', () => {
    const r = shieldRig();
    applyAura(r.auras, r.caster, modAura('test.absorb', { absorbDone: 1.3 }), r.caster.id, 0);
    r.cast([{ kind: 'applyAura', aura: modAura('test.plain', { damageDealt: 1.1 }) }]);
    const inst = r.auras.get(r.ally.id)!.find((a) => a.def.id === 'test.plain')!;
    expect(inst.absorbInitial).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════
//  6. 集成：现有数据源逐个亮灯
// ════════════════════════════════════════════════════════════════

/**
 * ★★ 上面每一节测的都是「机制通了」，这一节测的是「**今天数据里写着的**
 *   那几处真的会生效」。两者不能互相替代：机制通了但某件护甲的 key 拼错
 *   （`attackspeed`）照样是一句谎话，而机制测试全绿。
 */
describe('★★ 集成：§9 表格里列的每一处现有数据源逐个亮灯', () => {
  const world = createWorld([FLOOR]);
  const spawn = (cls: typeof mage): CombatEntity =>
    addEntity(world, createEntity(allocEntityId(world), cls, RED, vec3(0, 0, 0)));
  const empty = createAuraStore();

  it('castSpeed 六处：法师法杖/魔杖法球、牧师法杖/权杖圣典、圣骑权杖圣典、守护甲', () => {
    const cases: [typeof mage, string, string, number][] = [
      [mage, 'mage.staff', 'mage.default', 1.1],
      [mage, 'mage.wand_orb', 'mage.default', 0.88],
      [priest, 'priest.two_hand_staff', 'priest.default', 1.08],
      [priest, 'priest.scepter_codex', 'priest.default', 0.85],
      [paladin, 'paladin.scepter_codex', 'paladin.default', 0.85],
      [warrior, 'warrior.sword_shield', 'warrior.guardian', 1.08],
    ];
    for (const [cls, weapon, armor, expected] of cases) {
      const e = spawn(cls);
      e.weaponId = asWeaponId(weapon);
      e.armorId = asArmorId(armor);
      expect(effectiveModifiersOf(empty, e, 0).castSpeed, `${weapon}/${armor}`)
        .toBeCloseTo(expected, 6);
    }
  });

  it('attackSpeed：守护型护甲 1.08 —— 每个职业各一套，全部亮', () => {
    for (const cls of [warrior, mage, priest, paladin, druid]) {
      // 只比**相对**值：各职业默认武器的间隔不同，钉绝对值等于把武器基线
      // 也钉进这条断言里，将来调一次武器数值就会误伤它
      const plain = swingIntervalOf(empty, spawn(cls), 0);
      const e = spawn(cls);
      e.armorId = asArmorId(`${cls.id as string}.guardian`);
      expect(swingIntervalOf(empty, e, 0) / plain, `${cls.id as string}.guardian`)
        .toBeCloseTo(1.08, 6);
    }
  });

  it('knockbackTaken：机动甲 1.25 / 抗控甲 0.6 —— 两个方向都亮', () => {
    const mob = spawn(warrior);
    mob.armorId = asArmorId('warrior.mobility');
    const ten = spawn(warrior);
    ten.armorId = asArmorId('warrior.tenacity');
    expect(effectiveModifiersOf(empty, mob, 0).knockbackTaken).toBeCloseTo(1.25, 6);
    expect(effectiveModifiersOf(empty, ten, 0).knockbackTaken).toBeCloseTo(0.6, 6);
  });

  it('maxHealth：熊形态 1.2 —— 数据里那一枚光环真的能推出 1260', () => {
    const auras = createAuraStore();
    const d = spawn(druid);
    const bearAura = BEAR_FORM.effects
      .flatMap((e) => (e.kind === 'applyAura' ? [e.aura] : []))
      .find((a) => a.id === 'druid.bear_form')!;
    expect(bearAura.modifiers?.maxHealth, '数据里的熊形态丢了 maxHealth').toBe(1.2);
    applyAura(auras, d, bearAura, d.id, 0);
    applyMaxHealthMultiplier(d, effectiveModifiersOf(auras, d, 0).maxHealth);
    expect(d.maxHealth).toBeCloseTo(1050 * 1.2, 6);
  });

  it('★ absorbDone：如实记账 —— 全仓**零**数据源（所以行为逐位不变）', () => {
    const sources: string[] = [];
    for (const cls of [warrior, mage, priest, paladin, druid]) {
      for (const w of cls.weapons) {
        if (w.modifiers?.absorbDone !== undefined) sources.push(w.id as string);
      }
      for (const a of cls.armors) {
        if (a.modifiers?.absorbDone !== undefined) sources.push(a.id as string);
      }
    }
    expect(sources, '有人往数据里写 absorbDone 了 —— 那这条注释该更新了').toEqual([]);
  });
});
