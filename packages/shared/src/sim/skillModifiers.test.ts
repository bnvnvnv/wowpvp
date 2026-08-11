/**
 * W27：`WeaponDef.skillModifiers` 整族 8 个字段接线（docs/15 W27 行）。
 *
 * ★★ **这批债的形状与 W26 一模一样、规模更大**：`SkillModifier` 的
 *   damageMultiplier / healingMultiplier / cooldownMultiplier / castTimeMultiplier /
 *   radiusMultiplier / durationMultiplier / rangeMultiplier / behindBonusDelta
 *   八个字段全部写进了 schema，25 条数据源逐条写进了 `data/classes/`，
 *   `docs/05-equipment-system.md` 又把它们当装备规格逐行公示给玩家 ——
 *   而全仓**唯一**读到 `skillModifiers` 的地方只有 `data/index.ts` 的键名校验。
 *   换武器之后技能强度一个数都没变，`advantage` 文案整章是空头承诺。
 *
 * 八条接线的落点（唯一查表入口是 `modifiers.skillModifierOf`）：
 *   · `castTimeMultiplier` → `casting.castTimeOf`（与 W26 的 castSpeed 同一行）
 *   · `cooldownMultiplier` → `casting.enterCooldown`（finishCast **与**引导结算两处）
 *   · `damageMultiplier`   → `effects/combat.dealDamage`（attackerMods.damageDealt 同址）
 *   · `healingMultiplier`  → `effects/combat.dealHeal`
 *   · `behindBonusDelta`   → `effects/combat.dealDamage` 的背刺加成
 *   · `durationMultiplier` → `effects/combat` 的 applyAura 处理器（递减**之前**）
 *   · `radiusMultiplier`   → `castResolve.resolveCastTargets`（`aiming.scaleShape`）
 *   · `rangeMultiplier`    → `casting.validateCast` 的距离检查
 *     （与武器级 `WeaponDef.rangeMultiplier` 合成，见 `skillRangeMultiplierOf`）
 *
 * ★ 每个字段两条断言：**生效**一条、**无修正时逐位不变**一条。
 *   后者不是同义反复 —— 把「不填 = 1」写错成「不填 = 0」会让全部技能瞬间
 *   零冷却/零距离/零伤害，而那种错误在「生效」那条断言里一点都看不出来。
 *
 * ★★ **八个字段里只有两个有数据源**（damageMultiplier 18 条、cooldownMultiplier
 *   7 条），其余六个零数据源。所以「生效」那一半用 `withWeaponMod()`
 *   在测试内**临时**往真实武器上挂一条改写、跑完立刻还原 —— 走的是完整的
 *   生产路径（`tickWorld` → `skillModifierOf` → 消费点），既不改数据也不靠桩。
 */

import { describe, expect, it } from 'vitest';
import {
  ALL_CLASSES, druid, getClass, getSkill, getWeapon, hunter, mage, priest, rogue,
  SKILL_BY_ID, warrior,
} from '../data/index.js';
import type { EffectDef, SkillDef, SkillModifier, WeaponDef } from '../data/schema.js';
import { box } from '../data/maps/schema.js';
import { dirToYaw, sub, vec3, type Vec3 } from '../math/vec3.js';
import {
  ArenaPreset, CastFailure, CastKind, DispelType, School, TargetFilter, Targeting,
} from '../types/enums.js';
import { asSkillId, asTeamId, asWeaponId, type EntityId } from '../types/ids.js';
import { createAuraStore, type AuraStore } from './aura.js';
import { scaleShape } from './aiming.js';
import { createArsenalStore, createPickupStore } from './arsenal.js';
import {
  beginCast, castTimeOf, createCastingStore, tickCasting, validateCast,
  type SkillModifierAccess,
} from './casting.js';
import { createDrStore } from './dr.js';
import { createEntity, skillsAvailableWith, type CombatEntity } from './entity.js';
import { createGroundStore } from './groundArea.js';
import { createLoadout, createLoadoutStore, createSwapStore } from './loadout.js';
import { skillModifierOf, skillRangeMultiplierOf } from './modifiers.js';
import type { MovementInput, MovementState } from './movement.js';
import { createProjectileStore } from './projectile.js';
import { resolveEffects } from './effects/index.js';
import { tickWorld, type TickDeps } from './tick.js';
import { addEntity, allocEntityId, createWorld, type World } from './world.js';

const RED = asTeamId(0);
const BLUE = asTeamId(1);
const FLOOR = box('g', 'floor', { x: 0, y: -1, z: 0 }, { w: 400, h: 1, d: 400 });
const DT = 0.05;
/** 全仓最长的近战触及（`RANGE.MELEE_POLEARM`）。武器级距离乘算的「远程」判据 */
const MELEE_CEILING = 3.8;

type ClassDefLike = typeof mage;

const skillById = (id: string): SkillDef => getSkill(asSkillId(id))!;

/**
 * 在这一段测试期间，往某把**真实**武器上临时挂一条技能改写，跑完还原。
 *
 * ★★ 六个零数据源的字段（healingMultiplier / castTimeMultiplier /
 *   radiusMultiplier / durationMultiplier / rangeMultiplier / behindBonusDelta）
 *   只能这么测「生效」：`effects/combat.ts` 与 `tick.ts` 直接查注册表，
 *   没有注入口 —— 而给它们各开一个注入口，只为让单测好写，是拿生产代码
 *   迁就测试。这里换掉的是整张表的**引用**，`finally` 原样放回去，
 *   同文件后续用例看到的仍是原始数据。
 */
const withWeaponMod = <T>(
  weaponId: string, skillId: string, mod: SkillModifier, fn: () => T,
): T => {
  const w = getWeapon(asWeaponId(weaponId)) as
    (WeaponDef & { skillModifiers?: Record<string, SkillModifier> }) | undefined;
  if (!w) throw new Error(`测试夹具引用了不存在的武器：${weaponId}`);
  const prev = w.skillModifiers;
  w.skillModifiers = { ...(prev ?? {}), [skillId]: mod };
  try {
    return fn();
  } finally {
    w.skillModifiers = prev;
  }
};

// ── 通用夹具 ─────────────────────────────────────────────────────

interface Rig {
  world: World;
  auras: AuraStore;
  deps: (castRequests?: TickDeps['castRequests']) => TickDeps;
  spawn: (cls: ClassDefLike, team: typeof RED, at: Vec3, weaponId?: string) => CombatEntity;
}

/**
 * 换武器。★ 必须连 `availableSkills` 一起重算 —— `validateCast` 的
 * `WeaponMismatch` 门禁读的是那个集合，只改 `weaponId` 会让方案专属技能
 * 放不出来（M14 的老坑，`loadout` 的换装路径做的是同一件事）。
 */
const equip = (e: CombatEntity, weaponId: string): void => {
  const cls = getClass(e.classId)!;
  e.weaponId = asWeaponId(weaponId);
  e.availableSkills = skillsAvailableWith(cls, e.weaponId, getWeapon(e.weaponId));
};

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

  const spawn: Rig['spawn'] = (cls, team, at, weaponId) => {
    const e = addEntity(world, createEntity(allocEntityId(world), cls, team, { ...at }));
    loadouts.set(e.id, createLoadout(e.classId));
    for (const [r, max] of e.maxResources) e.resources.set(r, max);
    if (weaponId) equip(e, weaponId);
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

/** 一张手写的改写表，喂给 `casting.ts` 的注入口 —— 不碰任何真实数据 */
const fakeAccess = (table: Record<string, SkillModifier>): SkillModifierAccess => ({
  modifierOf: (_c, skill) => table[skill.id as string],
  rangeScaleOf: (_c, skill) => table[skill.id as string]?.rangeMultiplier ?? 1,
});

/**
 * 打一发固定伤害，返回实际扣血；打完把血还原。
 *
 * ★★ 对照组的设计：**同一把武器、同一个目标、只换 `ctx.skillId`。**
 *   换武器做对照会把武器自己的 `modifiers`（法杖的 damageDealt 1.12…）
 *   一起换掉，比出来的比值就不再是 `damageMultiplier` 了。
 *   换成一个不存在的技能 id 则**只**关掉 `skillModifiers` 这一层。
 * ★ `periodic: true`：关掉暴击掷骰，比值才是纯乘算而不是「这一发暴了没」。
 * ★★ **学派取奥术而不是物理**：闪避/招架/格挡「法术不受影响」（9.x），
 *   物理会掷 `nextRandom(target)`，于是同一段测试里对照组挨了实伤、实验组
 *   被格挡掉 —— 比值变成 0 或 Infinity，而且是**间歇性**的。
 *   本文件测的是乘算，不是规避，所以把那条随机源整个避开。
 */
const NO_SKILL = '__w27.control.no_such_skill__';

/**
 * 把目标变成一个打不死的沙包：血量拉到 1e9。
 * ★ 不这么做的话 `flat: 100000` 一发就把人打死，第二发因为 `!target.alive`
 *   直接返回 0 —— 对照组与实验组一个是满伤一个是零伤，比值全是 Infinity。
 *   同时也避免「伤害被剩余血量截断」污染比值。
 */
const DUMMY_HP = 1e9;
const asDummy = (e: CombatEntity): CombatEntity => {
  e.maxHealth = DUMMY_HP;
  e.health = DUMMY_HP;
  e.alive = true;
  return e;
};

const hitFor = (
  attacker: CombatEntity, target: CombatEntity, world: World, skillId: string,
  opts: { behindBonus?: number; fromBehindSnapshot?: boolean } = {},
): number => {
  asDummy(target);
  const before = target.health;
  resolveEffects(
    {
      world, auras: createAuraStore(), dr: createDrStore(),
      projectiles: createProjectileStore(), ground: createGroundStore(),
      source: attacker, skillId, periodic: true,
      ...(opts.fromBehindSnapshot !== undefined
        ? { hitSnapshot: { fromBehind: opts.fromBehindSnapshot, canAvoid: true } }
        : {}),
    },
    [{
      kind: 'damage', school: School.Arcane, amount: { flat: 100_000 },
      ...(opts.behindBonus !== undefined ? { behindBonus: opts.behindBonus } : {}),
    }],
    [target],
  );
  const dealt = before - target.health;
  target.health = before;
  return dealt;
};

const healFor = (
  healer: CombatEntity, target: CombatEntity, world: World, skillId: string,
): number => {
  asDummy(target);
  target.health = 1;
  resolveEffects(
    {
      world, auras: createAuraStore(), dr: createDrStore(),
      projectiles: createProjectileStore(), ground: createGroundStore(),
      source: healer, skillId, periodic: true,
    },
    [{ kind: 'heal', amount: { flat: 100_000 } }],
    [target],
  );
  return target.health - 1;
};

// ════════════════════════════════════════════════════════════════
//  0. 唯一入口
// ════════════════════════════════════════════════════════════════

describe('★★ skillModifierOf：八处消费点共用的唯一查表入口', () => {
  it('查得到当前武器的改写', () => {
    expect(skillModifierOf({ weaponId: asWeaponId('hunter.long_bow') }, 'hunter.aimed_shot'))
      .toEqual({ damageMultiplier: 1.15 });
  });

  it('★ 换一把没有这条改写的武器 → undefined（而不是 1 或空对象）', () => {
    expect(skillModifierOf({ weaponId: asWeaponId('hunter.short_bow') }, 'hunter.aimed_shot'))
      .toBeUndefined();
    expect(skillModifierOf({ weaponId: asWeaponId('hunter.long_bow') }, 'hunter.arcane_shot'))
      .toBeUndefined();
  });

  it('★ 武器 id 不存在（派对武装 / 测试实体）不炸，返回 undefined', () => {
    expect(skillModifierOf({ weaponId: asWeaponId('nope.nothing') }, 'hunter.aimed_shot'))
      .toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════
//  1. castTimeMultiplier → castTimeOf
// ════════════════════════════════════════════════════════════════

describe('★★ castTimeMultiplier 接进读条（W26 的 castSpeed 同一行）', () => {
  const FROSTBOLT = skillById('mage.frostbolt');
  const lone = (): CombatEntity =>
    createEntity(allocEntityId(createWorld([FLOOR])), mage, RED, vec3(0, 0, 0));

  it('★★ 生效：公式 = cast.time × castSpeed × castTimeMultiplier', () => {
    const access = fakeAccess({ 'mage.frostbolt': { castTimeMultiplier: 0.5 } });
    expect(castTimeOf(FROSTBOLT, lone(), () => 1.2, access))
      .toBeCloseTo(FROSTBOLT.cast.time * 1.2 * 0.5, 9);
  });

  it('★★ 无修正逐位不变：不传 / 表里没这个技能，都等于只有 castSpeed', () => {
    const other = fakeAccess({ 'mage.fireball': { castTimeMultiplier: 0.1 } });
    expect(castTimeOf(FROSTBOLT, lone(), () => 1.1)).toBe(FROSTBOLT.cast.time * 1.1);
    expect(castTimeOf(FROSTBOLT, lone(), () => 1.1, other)).toBe(FROSTBOLT.cast.time * 1.1);
    expect(castTimeOf(FROSTBOLT, lone(), undefined, other)).toBe(FROSTBOLT.cast.time);
  });

  it('★★ 边界：瞬发不会因为倍率长出一根读条（0 × 任何数还是 0）', () => {
    const barkskin = skillById('druid.barkskin');
    expect(barkskin.cast.kind).toBe(CastKind.Instant);
    expect(castTimeOf(barkskin, lone(), () => 1.5, fakeAccess({
      'druid.barkskin': { castTimeMultiplier: 3 },
    }))).toBe(0);
  });

  it('★★ 端到端：真的落在 CastState.endsAt 上（tickWorld → 真实武器表）', () => {
    withWeaponMod('mage.staff', 'mage.frostbolt', { castTimeMultiplier: 0.5 }, () => {
      const rig = makeRig();
      const caster = rig.spawn(mage, RED, vec3(0, 0, 0));
      const foe = rig.spawn(warrior, BLUE, vec3(0, 0, 10));
      caster.yaw = dirToYaw(sub(foe.position, caster.position));
      expect(caster.weaponId as string, '法杖不再是法师默认武器了？').toBe('mage.staff');

      advance(rig, 1, new Map([[caster.id, { skillId: FROSTBOLT.id, targetId: foe.id }]]));
      const st = rig.deps().casting.get(caster.id)!;
      expect(st, '读条没起来').toBeDefined();
      // 法杖自带 castSpeed 1.1（W26 接的那一条）× 本条 0.5
      expect(st.endsAt - st.startedAt).toBeCloseTo(FROSTBOLT.cast.time * 1.1 * 0.5, 6);
    });
  });

  it('★★ 排队窗放出来的那一发走同一个注入对象（三个施法入口不许分家）', () => {
    withWeaponMod('mage.staff', 'mage.frostbolt', { castTimeMultiplier: 0.5 }, () => {
      const rig = makeRig();
      const caster = rig.spawn(mage, RED, vec3(0, 0, 0));
      const foe = rig.spawn(warrior, BLUE, vec3(0, 0, 10));
      caster.yaw = dirToYaw(sub(foe.position, caster.position));
      const queue = new Map();
      const withQueue = (cr?: TickDeps['castRequests']): TickDeps =>
        ({ ...rig.deps(cr), castQueue: queue });

      caster.gcdUntil = 10;
      tickWorld(withQueue(new Map([[caster.id, {
        skillId: FROSTBOLT.id, targetId: foe.id, queue: true,
      }]])), DT);
      expect(queue.size, '没进排队窗，这条测试没在测排队路径').toBe(1);
      caster.gcdUntil = 0;
      tickWorld(withQueue(), DT);

      const st = rig.deps().casting.get(caster.id)!;
      expect(st, '排队那一发没放出来').toBeDefined();
      expect(st.endsAt - st.startedAt).toBeCloseTo(FROSTBOLT.cast.time * 1.1 * 0.5, 6);
    });
  });
});

// ════════════════════════════════════════════════════════════════
//  2. cooldownMultiplier → 冷却写入（**两处**）
// ════════════════════════════════════════════════════════════════

describe('★★ cooldownMultiplier 接进冷却', () => {
  const ARCANE_SHOT = skillById('hunter.arcane_shot');

  const shootAndReadCooldown = (weaponId: string): number => {
    const rig = makeRig();
    const h = rig.spawn(hunter, RED, vec3(0, 0, 0), weaponId);
    const foe = rig.spawn(warrior, BLUE, vec3(0, 0, 10));
    h.yaw = dirToYaw(sub(foe.position, h.position));
    advance(rig, 1, new Map([[h.id, { skillId: ARCANE_SHOT.id, targetId: foe.id }]]));
    const until = h.cooldowns.get(ARCANE_SHOT.id);
    expect(until, `${weaponId} 的奥术射击根本没放出来`).toBeDefined();
    // 瞬发技能在第一个 tick 的第 1 步完成，那一刻 world.time 已经是 DT
    return until! - DT;
  };

  it('★★ 生效（端到端 tickWorld）：短弓的奥术射击冷却 ×0.75', () => {
    expect(shootAndReadCooldown('hunter.short_bow'))
      .toBeCloseTo(ARCANE_SHOT.cooldown * 0.75, 6);
  });

  it('★★ 无修正逐位不变：长弓没有这条改写 → 冷却是原始值', () => {
    expect(shootAndReadCooldown('hunter.long_bow')).toBeCloseTo(ARCANE_SHOT.cooldown, 6);
  });

  /**
   * ★★ **第二处冷却写点：引导技能。**
   *   X10 追加轮之前引导路径根本不写冷却（`cooldowns.set` 只在 `finishCast`），
   *   整批引导技能免费无冷却。W27 又往同一行加了一个乘数 —— 只接 `finishCast`
   *   那一处的话，表现是「暴风雪不吃武器的冷却缩减」，而没有任何断言看得见。
   */
  const channelCooldown = (weapon?: SkillModifierAccess): { until: number; at: number } => {
    const BLIZZARD = skillById('mage.blizzard');
    const world = createWorld([FLOOR]);
    const store = createCastingStore();
    const caster = addEntity(world, createEntity(allocEntityId(world), mage, RED, vec3(0, 0, 0)));
    addEntity(world, createEntity(allocEntityId(world), warrior, BLUE, vec3(0, 0, 10)));
    for (const [r, max] of caster.maxResources) caster.resources.set(r, max);

    beginCast(world, store, caster, BLIZZARD, {
      groundPoint: vec3(0, 0, 10), ...(weapon ? { weapon } : {}),
    });
    expect(caster.cooldowns.has(BLIZZARD.id), '起手就进冷却？7.4 步骤 5 是完成才进')
      .toBe(false);

    world.time = BLIZZARD.cast.time + 0.01;
    tickCasting(world, store, { getSkill, ...(weapon ? { weapon } : {}) });
    const until = caster.cooldowns.get(BLIZZARD.id);
    expect(until, '引导开始那一刻没写冷却（X10 的老坑复发）').toBeDefined();
    return { until: until!, at: world.time };
  };

  it('★★ 引导路径同样吃（暴风雪在「引导开始」那一刻结算冷却）', () => {
    const BLIZZARD = skillById('mage.blizzard');
    expect(BLIZZARD.cast.kind, '暴风雪不是引导了？这条测试要换技能').toBe(CastKind.Channel);
    const r = channelCooldown(fakeAccess({ 'mage.blizzard': { cooldownMultiplier: 0.5 } }));
    expect(r.until - r.at).toBeCloseTo(BLIZZARD.cooldown * 0.5, 9);
  });

  it('★★ 引导路径无修正时逐位不变', () => {
    const BLIZZARD = skillById('mage.blizzard');
    const r = channelCooldown();
    expect(r.until - r.at).toBeCloseTo(BLIZZARD.cooldown, 9);
  });

  it('★ GCD 不吃这个乘算（7.4 步骤 2 是固定值，动它等于动全部瞬发的节奏）', () => {
    const rig = makeRig();
    const h = rig.spawn(hunter, RED, vec3(0, 0, 0), 'hunter.short_bow');
    const foe = rig.spawn(warrior, BLUE, vec3(0, 0, 10));
    h.yaw = dirToYaw(sub(foe.position, h.position));
    advance(rig, 1, new Map([[h.id, { skillId: ARCANE_SHOT.id, targetId: foe.id }]]));
    expect(h.gcdUntil - DT).toBeCloseTo(1, 6);
  });
});

// ════════════════════════════════════════════════════════════════
//  3. damageMultiplier / healingMultiplier → 结算
// ════════════════════════════════════════════════════════════════

describe('★★ damageMultiplier 接进伤害结算', () => {
  it('★★ 生效：长弓的瞄准射击 ×1.15（同一把武器，只换 skillId 做对照）', () => {
    const rig = makeRig();
    const h = rig.spawn(hunter, RED, vec3(0, 0, 0), 'hunter.long_bow');
    const foe = rig.spawn(warrior, BLUE, vec3(0, 0, 3));
    const base = hitFor(h, foe, rig.world, NO_SKILL);
    expect(hitFor(h, foe, rig.world, 'hunter.aimed_shot') / base).toBeCloseTo(1.15, 4);
  });

  it('★★ 无修正逐位不变：短弓放同一发瞄准射击，与对照组**逐位**相同', () => {
    const rig = makeRig();
    const h = rig.spawn(hunter, RED, vec3(0, 0, 0), 'hunter.short_bow');
    const foe = rig.spawn(warrior, BLUE, vec3(0, 0, 3));
    expect(hitFor(h, foe, rig.world, 'hunter.aimed_shot'))
      .toBe(hitFor(h, foe, rig.world, NO_SKILL));
  });

  it('★ 削弱方向同样成立：战士双持的致死打击 ×0.85', () => {
    const rig = makeRig();
    const w = rig.spawn(warrior, RED, vec3(0, 0, 0), 'warrior.dual_swords');
    const foe = rig.spawn(mage, BLUE, vec3(0, 0, 3));
    const base = hitFor(w, foe, rig.world, NO_SKILL);
    expect(hitFor(w, foe, rig.world, 'warrior.mortal_strike') / base).toBeCloseTo(0.85, 4);
  });

  /**
   * ★★ W23/W25 家族的老坑：技能载荷藏在 `lockedProjectile.onHit` /
   *   `delayedGroundImpact.onImpact` 里。伤害乘算按 `ctx.skillId` 查表，
   *   所以「箭飞到目标身上那一刻 skillId 还在不在」是这条接线的前提。
   */
  it('★★ 锁定投射物飞到之后 skillId 还在（乘算不会在半路掉队）', () => {
    const rig = makeRig();
    const h = rig.spawn(hunter, RED, vec3(0, 0, 0), 'hunter.long_bow');
    const foe = rig.spawn(warrior, BLUE, vec3(0, 0, 10));
    const projectiles = createProjectileStore();
    resolveEffects(
      {
        world: rig.world, auras: createAuraStore(), dr: createDrStore(),
        projectiles, ground: createGroundStore(),
        source: h, skillId: 'hunter.aimed_shot',
      },
      [{ kind: 'lockedProjectile', speed: 40, onHit: [
        { kind: 'damage', school: School.Physical, amount: { flat: 100 } },
      ] }],
      [foe],
    );
    expect(projectiles.items.length, '锁定投射物没建出来').toBe(1);
    expect(String(projectiles.items[0]!.skillId)).toBe('hunter.aimed_shot');
  });
});

describe('★★ healingMultiplier 接进治疗结算', () => {
  it('★★ 生效：临时给权杖挂一条「快速治疗 +20%」，治疗量真的多 20%', () => {
    withWeaponMod('priest.scepter_codex', 'priest.flash_heal', { healingMultiplier: 1.2 }, () => {
      const rig = makeRig();
      const p = rig.spawn(priest, RED, vec3(0, 0, 0), 'priest.scepter_codex');
      const mate = rig.spawn(warrior, RED, vec3(0, 0, 3));
      const base = healFor(p, mate, rig.world, NO_SKILL);
      expect(base).toBeGreaterThan(0);
      expect(healFor(p, mate, rig.world, 'priest.flash_heal') / base).toBeCloseTo(1.2, 4);
    });
  });

  it('★★ 无修正逐位不变：没挂改写时同一发治疗与对照组逐位相同', () => {
    const rig = makeRig();
    const p = rig.spawn(priest, RED, vec3(0, 0, 0), 'priest.scepter_codex');
    const mate = rig.spawn(warrior, RED, vec3(0, 0, 3));
    expect(healFor(p, mate, rig.world, 'priest.flash_heal'))
      .toBe(healFor(p, mate, rig.world, NO_SKILL));
  });

  /**
   * ★★ 两个字段不许互相顶班。这条同时是**自然法杖那条数据写错字段**的证据：
   *   `druid.healing_touch: { damageMultiplier: 1.1 }` 挂在一个纯治疗技能上，
   *   接线之后依旧空转（如实登记见 docs/15 W27 行与 `classes/druid.ts`）。
   */
  it('★★ damageMultiplier 不会顺手加强治疗（自然法杖的愈合 +10% 今天空转）', () => {
    const rig = makeRig();
    const d = rig.spawn(druid, RED, vec3(0, 0, 0));
    const mate = rig.spawn(warrior, RED, vec3(0, 0, 3));
    expect(skillModifierOf(d, 'druid.healing_touch')).toEqual({ damageMultiplier: 1.1 });
    expect(healFor(d, mate, rig.world, 'druid.healing_touch'))
      .toBe(healFor(d, mate, rig.world, NO_SKILL));
  });
});

// ════════════════════════════════════════════════════════════════
//  4. behindBonusDelta → 背刺加成
// ════════════════════════════════════════════════════════════════

describe('★★ behindBonusDelta 接进背刺加成（与 W25 的快照正交）', () => {
  /** 攻击者站在目标正后方 */
  const behindRig = () => {
    const rig = makeRig();
    const r = rig.spawn(rogue, RED, vec3(0, 0, 6), 'rogue.dual_swords');
    const foe = rig.spawn(warrior, BLUE, vec3(0, 0, 3));
    foe.yaw = dirToYaw(sub(vec3(0, 0, 0), foe.position));
    return { rig, r, foe };
  };

  it('★★ 生效：delta 改的是**数值**（0.5 + (−0.2) = 0.3 倍加成）', () => {
    withWeaponMod('rogue.dual_swords', 'rogue.backstab', { behindBonusDelta: -0.2 }, () => {
      const { rig, r, foe } = behindRig();
      const flat = hitFor(r, foe, rig.world, NO_SKILL);
      const withDelta = hitFor(r, foe, rig.world, 'rogue.backstab', { behindBonus: 0.5 });
      expect(withDelta / flat).toBeCloseTo(1.3, 4);
    });
  });

  it('★★ 无修正逐位不变：没有 delta 时背刺加成原样 1 + 0.5', () => {
    const { rig, r, foe } = behindRig();
    const flat = hitFor(r, foe, rig.world, NO_SKILL);
    expect(hitFor(r, foe, rig.world, NO_SKILL, { behindBonus: 0.5 }) / flat)
      .toBeCloseTo(1.5, 4);
  });

  it('★★ 边界：没有 behindBonus 的技能不会被 delta 凭空长出背后加成', () => {
    withWeaponMod('rogue.dual_swords', 'rogue.backstab', { behindBonusDelta: 0.5 }, () => {
      const { rig, r, foe } = behindRig();
      const control = hitFor(r, foe, rig.world, NO_SKILL);
      // 这一发**不带** behindBonus —— 结果必须与对照组逐位相同
      expect(hitFor(r, foe, rig.world, 'rogue.backstab')).toBe(control);
    });
  });

  it('★★ 边界：delta 削过头时夹到 0，不会倒挂成「背后打反而更轻」', () => {
    withWeaponMod('rogue.dual_swords', 'rogue.backstab', { behindBonusDelta: -5 }, () => {
      const { rig, r, foe } = behindRig();
      const flat = hitFor(r, foe, rig.world, NO_SKILL);
      expect(hitFor(r, foe, rig.world, 'rogue.backstab', { behindBonus: 0.5 })).toBe(flat);
    });
  });

  it('★★ 与 W25 正交：快照冻结「是否背身」，delta 只改数值', () => {
    withWeaponMod('rogue.dual_swords', 'rogue.backstab', { behindBonusDelta: -0.2 }, () => {
      const { rig, r, foe } = behindRig();
      const flat = hitFor(r, foe, rig.world, NO_SKILL);
      // 人**站在背后**，但快照说「释放那一刻不是背身」→ 加成整段不生效，
      // delta 是多少都无关（它管的是数值，快照管的是 if）
      expect(hitFor(r, foe, rig.world, 'rogue.backstab', {
        behindBonus: 0.5, fromBehindSnapshot: false,
      })).toBe(flat);
      // 反过来：快照说「是背身」→ 加成生效，且吃到 delta
      expect(hitFor(r, foe, rig.world, 'rogue.backstab', {
        behindBonus: 0.5, fromBehindSnapshot: true,
      }) / flat).toBeCloseTo(1.3, 4);
    });
  });
});

// ════════════════════════════════════════════════════════════════
//  5. durationMultiplier → applyAura 时长
// ════════════════════════════════════════════════════════════════

describe('★★ durationMultiplier 接进光环时长', () => {
  const applyOne = (
    source: CombatEntity, target: CombatEntity, world: World, skillId: string,
  ): number | undefined => {
    const effects: EffectDef[] = [{
      kind: 'applyAura',
      aura: {
        id: 'w27.test.buff', name: 'w27', kind: 'debuff', duration: 10,
        dispelType: DispelType.Magic, clearableByTrinket: false,
        modifiers: { moveSpeed: 0.5 }, description: 'w27',
      },
    }];
    const events = resolveEffects(
      {
        world, auras: createAuraStore(), dr: createDrStore(),
        projectiles: createProjectileStore(), ground: createGroundStore(),
        source, skillId,
      },
      effects, [target],
    );
    const applied = events.find((e) => e.t === 'auraApplied');
    return applied && 'duration' in applied ? applied.duration : undefined;
  };

  it('★★ 生效：临时给法刃挂「冰霜新星定身 ×1.5」，光环时长真的变长', () => {
    withWeaponMod('mage.spellblade_focus', 'mage.frost_nova', { durationMultiplier: 1.5 }, () => {
      const rig = makeRig();
      const m = rig.spawn(mage, RED, vec3(0, 0, 0), 'mage.spellblade_focus');
      const foe = rig.spawn(warrior, BLUE, vec3(0, 0, 3));
      expect(applyOne(m, foe, rig.world, 'mage.frost_nova')).toBeCloseTo(15, 9);
    });
  });

  it('★★ 无修正逐位不变：没挂改写 → 原始时长', () => {
    const rig = makeRig();
    const m = rig.spawn(mage, RED, vec3(0, 0, 0), 'mage.spellblade_focus');
    const foe = rig.spawn(warrior, BLUE, vec3(0, 0, 3));
    expect(applyOne(m, foe, rig.world, 'mage.frost_nova')).toBeCloseTo(10, 9);
    expect(applyOne(m, foe, rig.world, NO_SKILL)).toBeCloseTo(10, 9);
  });
});

// ════════════════════════════════════════════════════════════════
//  6. radiusMultiplier → 形状
// ════════════════════════════════════════════════════════════════

/**
 * 全仓**嵌套载荷自己身上那个半径**的清单（W27 收口）。
 *
 * ★★ 递归下探（铁律⑦）：`spawnGroundArea` / `delayedGroundImpact` /
 *   `spawnTrap` 都可能藏在 `lockedProjectile.onHit`、`onImpact`、`onTick`、
 *   `onTrigger`、`spendComboPoints.base` 里 —— 只扫第一层会漏掉一半。
 * ★ 从数据现算而不是手写清单：新加一个自动进来，接不上就当场红。
 */
interface RadiusSite { skillId: string; effect: EffectDef; declared: number }

const nestedRadiusSites = (): RadiusSite[] => {
  const out: RadiusSite[] = [];
  const walk = (skillId: string, effects: readonly EffectDef[]): void => {
    for (const e of effects) {
      if (e.kind === 'spawnGroundArea') out.push({ skillId, effect: e, declared: e.radius });
      if (e.kind === 'delayedGroundImpact') out.push({ skillId, effect: e, declared: e.radius });
      if (e.kind === 'spawnTrap') out.push({ skillId, effect: e, declared: e.triggerRadius });
      const nested: (readonly EffectDef[] | undefined)[] = [
        (e as { onHit?: EffectDef[] }).onHit,
        (e as { onImpact?: EffectDef[] }).onImpact,
        (e as { onTick?: EffectDef[] }).onTick,
        (e as { onTrigger?: EffectDef[] }).onTrigger,
        (e as { effects?: EffectDef[] }).effects,
        (e as { base?: EffectDef }).base ? [(e as { base: EffectDef }).base] : undefined,
      ];
      for (const n of nested) if (n) walk(skillId, n);
    }
  };
  for (const skill of SKILL_BY_ID.values()) walk(skill.id as string, skill.effects);
  return out;
};

describe('★★ radiusMultiplier 接进形状（scaleShape）', () => {
  it('★★ 生效：外沿按倍率缩放', () => {
    expect(scaleShape({ kind: 'circle', radius: 8 }, 1.5)).toEqual({ kind: 'circle', radius: 12 });
    expect(scaleShape({ kind: 'cone', angleDeg: 60, range: 10 }, 0.5))
      .toEqual({ kind: 'cone', angleDeg: 60, range: 5 });
    expect(scaleShape({ kind: 'line', length: 20, width: 4 }, 2))
      .toEqual({ kind: 'line', length: 40, width: 4 });
    expect(scaleShape({ kind: 'chain', jumpRange: 8, maxTargets: 3 }, 0.5))
      .toEqual({ kind: 'chain', jumpRange: 4, maxTargets: 3 });
  });

  it('★★ 环的内外径一起缩（只缩外径会把环压成一个选不中人的空环）', () => {
    expect(scaleShape({ kind: 'ring', innerRadius: 4, outerRadius: 10 }, 0.5))
      .toEqual({ kind: 'ring', innerRadius: 2, outerRadius: 5 });
  });

  it('★★ 无修正逐位不变：倍率 1 原样返回**同一个对象**（零分配）', () => {
    const shape = { kind: 'circle', radius: 8 } as const;
    expect(scaleShape(shape, 1)).toBe(shape);
    const single = { kind: 'single' } as const;
    expect(scaleShape(single, 2)).toBe(single);
  });

  it('★ 角度与宽度不动：schema 的原文是「半径或距离」，不是把形状整个吹大', () => {
    expect(scaleShape({ kind: 'cone', angleDeg: 60, range: 10, maxTargets: 5 }, 2))
      .toEqual({ kind: 'cone', angleDeg: 60, range: 20, maxTargets: 5 });
  });

  // ── W27 收口：嵌套载荷自己身上那个半径（铁律⑦第 9 处）─────────────

  /**
   * ★★ **形状缩放只覆盖了一半，而那一半恰好不是玩家看见的那个圈。**
   *
   *   W27 接线时把 `radiusMultiplier` 落在了 `skill.shape` 上
   *   （`resolveCastTargets` → `scaleShape`），可**真正决定这三种 AoE 大小的
   *   半径写在嵌套 effect 自己身上**：暴风雪是 `spawnGroundArea.radius: 6`、
   *   陨星是 `delayedGroundImpact.radius: 5`、冰冻陷阱是
   *   `spawnTrap.triggerRadius` —— 而这三个处理器**根本不读 `targets`**。
   *   于是「把形状吹大」只是把一批没人用的目标算了一遍：接线当天给法杖挂
   *   `mage.blizzard: radiusMultiplier=2`，区域半径**仍然是 6**。
   *
   *   ⚠️ **上面那条端到端用例照不出这个**：它挑的是群体咆哮
   *   （`SelfCenter` + 直接吃 `shape` 的圆），正好是能过的那一类 ——
   *   与 W23/W25 前八次同族翻车逐字同形（八字段全绿，一整族静默失效）。
   *   所以下面这两条**点名用暴风雪与陨星**。
   */
  it('★★ 端到端：暴风雪的区域半径真的跟着放大（不是把形状吹大就完事）', () => {
    const BLIZZARD = skillById('mage.blizzard');
    const declared = BLIZZARD.effects.find((e) => e.kind === 'spawnGroundArea');
    expect(declared, '暴风雪不再是 spawnGroundArea 了？这条测试要跟着改').toBeDefined();
    const base = (declared as { radius: number }).radius;

    const run = (mod?: SkillModifier): number => {
      const body = (): number => {
        const rig = makeRig();
        const m = rig.spawn(mage, RED, vec3(0, 0, 0), 'mage.staff');
        const foe = rig.spawn(warrior, BLUE, vec3(0, 0, 10));
        m.yaw = dirToYaw(sub(foe.position, m.position));
        let req: TickDeps['castRequests'] | undefined =
          new Map([[m.id, { skillId: BLIZZARD.id, groundPoint: vec3(0, 0, 10) }]]);
        for (let i = 0; i < Math.ceil(BLIZZARD.cast.time / DT) + 4; i++) {
          tickWorld(rig.deps(req), DT);
          req = undefined;
          if (rig.deps().ground.areas.length > 0) break;
        }
        const areas = rig.deps().ground.areas;
        expect(areas.length, '暴风雪的区域没建出来').toBe(1);
        return areas[0]!.radius;
      };
      return mod ? withWeaponMod('mage.staff', 'mage.blizzard', mod, body) : body();
    };

    expect(run(), '无改写逐位不变').toBe(base);
    expect(run({ radiusMultiplier: 2 })).toBe(base * 2);
  });

  it('★★ 端到端：陨星的落点半径真的跟着放大', () => {
    const METEOR = skillById('mage.meteor');
    const declared = METEOR.effects.find((e) => e.kind === 'delayedGroundImpact');
    expect(declared, '陨星不再是 delayedGroundImpact 了？这条测试要跟着改').toBeDefined();
    const base = (declared as { radius: number }).radius;

    const run = (mod?: SkillModifier): number => {
      const body = (): number => {
        const rig = makeRig();
        const m = rig.spawn(mage, RED, vec3(0, 0, 0), 'mage.staff');
        const foe = rig.spawn(warrior, BLUE, vec3(0, 0, 10));
        m.yaw = dirToYaw(sub(foe.position, m.position));
        let req: TickDeps['castRequests'] | undefined =
          new Map([[m.id, { skillId: METEOR.id, groundPoint: vec3(0, 0, 10) }]]);
        for (let i = 0; i < Math.ceil(METEOR.cast.time / DT) + 4; i++) {
          tickWorld(rig.deps(req), DT);
          req = undefined;
          if (rig.deps().projectiles.items.length > 0) break;
        }
        const items = rig.deps().projectiles.items;
        expect(items.length, '陨星的落点体没建出来').toBe(1);
        return (items[0] as unknown as { radius: number }).radius;
      };
      return mod ? withWeaponMod('mage.staff', 'mage.meteor', mod, body) : body();
    };

    expect(run(), '无改写逐位不变').toBe(base);
    expect(run({ radiusMultiplier: 2 })).toBe(base * 2);
  });

  /**
   * ★★ **全仓 10 个嵌套半径逐个亮灯**（dk / hunter×2 / mage×2 / paladin /
   *   rogue / warrior / party×2）。上面两条只钉了法师那两个 ——
   *   这一条把整族一次性钉死：将来谁新写一个 `spawnGroundArea`，
   *   它会**自动**进入这张清单，接不上就当场红。
   *
   * ★ 直接 `resolveEffects` 那一枚嵌套 effect，不走施法：有的藏在
   *   `lockedProjectile.onHit` 里（铁律⑦），走施法路径要为每个技能各造一套
   *   前置条件，而这条断言要的只是「处理器有没有乘」。
   */
  it('★★ 9 个嵌套半径逐个跟着缩放（新加一个自动进清单）', () => {
    const SITES = nestedRadiusSites();
    /**
     * ★ 9 而不是 10：第 10 个（大乱斗的跳跳地雷 `ffa.bouncy_mine`）挂在
     *   **消耗品**上，不在 `SKILL_BY_ID` 里。消耗品不是技能，武器改写表按
     *   技能 id 查表结构上就命不中它 —— 这不是漏，是那一侧没有可改写的东西。
     */
    expect(SITES.length, '嵌套半径的数量变了 —— 数据加了就把这个数跟上').toBe(9);

    const rig = makeRig();
    const src = rig.spawn(mage, RED, vec3(0, 0, 0), 'mage.staff');
    const foe = rig.spawn(warrior, BLUE, vec3(0, 0, 6));

    for (const site of SITES) {
      const spawnOnce = (): number => {
        const ground = createGroundStore();
        const projectiles = createProjectileStore();
        resolveEffects(
          {
            world: rig.world, auras: createAuraStore(), dr: createDrStore(),
            projectiles, ground, source: src, skillId: site.skillId,
            groundPoint: vec3(0, 0, 6),
          },
          [site.effect], [foe],
        );
        if (site.effect.kind === 'spawnGroundArea') return ground.areas[0]!.radius;
        if (site.effect.kind === 'spawnTrap') return ground.traps[0]!.triggerRadius;
        return (projectiles.items[0] as unknown as { radius: number }).radius;
      };

      const key = `${site.skillId}|${site.effect.kind}`;
      // ① 无改写逐位不变
      expect(spawnOnce(), `${key} 无改写时半径变了`).toBe(site.declared);
      // ② 挂上乘算就跟着走
      withWeaponMod('mage.staff', site.skillId, { radiusMultiplier: 2 }, () => {
        expect(spawnOnce(), `${key} 的半径够不到 —— 铁律⑦又翻一次`)
          .toBe(site.declared * 2);
      });
    }
  });

  /**
   * ★★ 端到端：真的落在「打谁」上。范围外的那个人在缩放后才被打到 ——
   *   `resolveCastTargets` 只被 `tick.ts` 调用，漏接的话上面那些纯函数
   *   断言全绿而游戏里一点变化都没有（本仓库点过名的那类缺陷）。
   */
  it('★★ 端到端：放大之后原本站在范围外的人真的挨打了', () => {
    const ROAR = skillById('druid.stampeding_roar');
    expect(ROAR.targeting).toBe(Targeting.SelfCenter);
    const reach = ROAR.shape.kind === 'circle' ? ROAR.shape.radius : 0;
    expect(reach, '群体咆哮不再是圆形了？这条测试要换技能').toBeGreaterThan(0);

    const run = (mod?: SkillModifier): boolean => {
      const body = (): boolean => {
        const rig = makeRig();
        const d = rig.spawn(druid, RED, vec3(0, 0, 0), 'druid.mace_totem');
        const mate = rig.spawn(warrior, RED, vec3(0, 0, reach * 1.4));
        advance(rig, 2, new Map([[d.id, { skillId: ROAR.id }]]));
        // 群体咆哮给队友上加速光环 —— 有没有被圈到，看他身上有没有光环
        return rig.auras.get(mate.id) !== undefined && rig.auras.get(mate.id)!.length > 0;
      };
      return mod
        ? withWeaponMod('druid.mace_totem', 'druid.stampeding_roar', mod, body)
        : body();
    };

    expect(run(), '基线就圈到了，这条测试没在测放大').toBe(false);
    expect(run({ radiusMultiplier: 2 })).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════
//  7. rangeMultiplier → 距离检查
// ════════════════════════════════════════════════════════════════

describe('★★ rangeMultiplier 接进 validateCast 的距离检查', () => {
  const FROSTBOLT = skillById('mage.frostbolt');

  const canCast = (gap: number, weapon?: SkillModifierAccess): boolean => {
    const world = createWorld([FLOOR]);
    const caster = addEntity(world, createEntity(allocEntityId(world), mage, RED, vec3(0, 0, 0)));
    const foe = addEntity(world, createEntity(allocEntityId(world), warrior, BLUE, vec3(0, 0, gap)));
    caster.yaw = dirToYaw(sub(foe.position, caster.position));
    for (const [r, max] of caster.maxResources) caster.resources.set(r, max);
    return validateCast({
      world, caster, skill: FROSTBOLT, target: foe, phase: 'start',
      ...(weapon ? { weapon } : {}),
    }) === CastFailure.Ok;
  };

  it('★★ 生效：×0.5 之后原来够得着的距离变成够不着', () => {
    const gap = FROSTBOLT.range.max * 0.8;
    expect(canCast(gap), '基线就够不着，这条测试没在测缩放').toBe(true);
    expect(canCast(gap, fakeAccess({ 'mage.frostbolt': { rangeMultiplier: 0.5 } }))).toBe(false);
  });

  it('★★ 生效（放大方向）：×1.5 之后原来够不着的距离变成够得着', () => {
    const gap = FROSTBOLT.range.max * 1.2;
    expect(canCast(gap)).toBe(false);
    expect(canCast(gap, fakeAccess({ 'mage.frostbolt': { rangeMultiplier: 1.5 } }))).toBe(true);
  });

  it('★★ 无修正逐位不变：不传 / 表里没这个技能 → 与接线前同样的判定', () => {
    const gap = FROSTBOLT.range.max * 0.8;
    expect(canCast(gap)).toBe(true);
    expect(canCast(gap, fakeAccess({ 'mage.fireball': { rangeMultiplier: 0.1 } }))).toBe(true);
  });

  it('★★ 端到端：真实武器表也走同一条（tickWorld 注入的就是它）', () => {
    withWeaponMod('mage.staff', 'mage.frostbolt', { rangeMultiplier: 0.5 }, () => {
      const rig = makeRig();
      const caster = rig.spawn(mage, RED, vec3(0, 0, 0));
      const foe = rig.spawn(warrior, BLUE, vec3(0, 0, FROSTBOLT.range.max * 0.8));
      caster.yaw = dirToYaw(sub(foe.position, caster.position));
      advance(rig, 1, new Map([[caster.id, { skillId: FROSTBOLT.id, targetId: foe.id }]]));
      expect(rig.deps().casting.get(caster.id), '距离缩了一半还放得出来').toBeUndefined();
    });
  });

  it('★★ 武器级 WeaponDef.rangeMultiplier 只作用于**远程**技能', () => {
    const spellblade = { weaponId: asWeaponId('mage.spellblade_focus') };
    const w = getWeapon(spellblade.weaponId) as WeaponDef & { rangeMultiplier?: number };
    expect(w.rangeMultiplier, '有人给它填数了 —— 那要跑 balance 归因').toBeUndefined();

    const slash = skillById('mage.elemental_slash');
    expect(slash.range.max, '元素之刃不再是近战了？这条测试要换技能')
      .toBeLessThanOrEqual(MELEE_CEILING);
    try {
      w.rangeMultiplier = 0.8;
      expect(skillRangeMultiplierOf(spellblade, FROSTBOLT), '远程技能该跟').toBeCloseTo(0.8, 9);
      expect(skillRangeMultiplierOf(spellblade, slash), '近战技能不该跟').toBe(1);
    } finally {
      delete w.rangeMultiplier;
    }
  });

  it('★★ 技能级与武器级相乘（两层是两件事，不是二选一）', () => {
    const spellblade = { weaponId: asWeaponId('mage.spellblade_focus') };
    const w = getWeapon(spellblade.weaponId) as WeaponDef & { rangeMultiplier?: number };
    try {
      w.rangeMultiplier = 0.8;
      withWeaponMod('mage.spellblade_focus', 'mage.frostbolt', { rangeMultiplier: 0.5 }, () => {
        expect(skillRangeMultiplierOf(spellblade, FROSTBOLT)).toBeCloseTo(0.4, 9);
      });
    } finally {
      delete w.rangeMultiplier;
    }
  });

  it('★ 最小距离**不**跟着缩（冲锋的「太近不能用」是机制门槛，不是距离）', () => {
    const charge = skillById('warrior.charge');
    expect(charge.range.min).toBeGreaterThan(0);
    const world = createWorld([FLOOR]);
    const w = addEntity(world, createEntity(allocEntityId(world), warrior, RED, vec3(0, 0, 0)));
    const foe = addEntity(world, createEntity(allocEntityId(world), mage, BLUE, vec3(0, 0, 2)));
    w.yaw = dirToYaw(sub(foe.position, w.position));
    for (const [r, max] of w.maxResources) w.resources.set(r, max);
    expect(validateCast({
      world, caster: w, skill: charge, target: foe, phase: 'start',
      weapon: fakeAccess({ 'warrior.charge': { rangeMultiplier: 3 } }),
    })).toBe(CastFailure.TooClose);
  });
});

// ════════════════════════════════════════════════════════════════
//  8. 「25 条数据源逐个亮灯」集成断言
// ════════════════════════════════════════════════════════════════

/**
 * 递归下探效果树，收集全部 `kind`。
 *
 * ★★ **W23/W25 的教训（同族已翻车 8 次）**：技能载荷会藏在
 *   `lockedProjectile.onHit` / `delayedGroundImpact.onImpact` /
 *   `spawnGroundArea.onTick` / `spawnTrap.onTrigger` / `spawnProjectile.onHit` /
 *   `onNthHit.effects` / 光环的 `periodic.effects` 里，`spendComboPoints` /
 *   `spendResource` 更是把载荷放在**单个** `base` 上（不是数组，写这条断言时
 *   就漏过一次 —— 刺骨的伤害整个藏在那里）。只扫第一层会把冰枪、陨星、
 *   暴风雪、终结技全部判成「没有伤害效果」。
 */
const walkEffects = (effects: readonly EffectDef[], out = new Set<string>()): Set<string> => {
  for (const e of effects) {
    out.add(e.kind);
    const nested: (readonly EffectDef[] | undefined)[] = [
      (e as { onHit?: EffectDef[] }).onHit,
      (e as { onImpact?: EffectDef[] }).onImpact,
      (e as { onTick?: EffectDef[] }).onTick,
      (e as { onTrigger?: EffectDef[] }).onTrigger,
      (e as { effects?: EffectDef[] }).effects,
      (e as { aura?: { periodic?: { effects?: EffectDef[] } } }).aura?.periodic?.effects,
      // ★ 单个（不是数组）：连击点/资源终结技的载荷
      (e as { base?: EffectDef }).base ? [(e as { base: EffectDef }).base] : undefined,
    ];
    for (const n of nested) if (n) walkEffects(n, out);
  }
  return out;
};

interface Entry { weapon: WeaponDef; skillId: string; mod: SkillModifier }

const ALL_ENTRIES: Entry[] = ALL_CLASSES.flatMap((cls) =>
  cls.weapons.flatMap((weapon) =>
    Object.entries(weapon.skillModifiers ?? {}).map(([skillId, mod]) => ({ weapon, skillId, mod })),
  ),
);

/**
 * ⚠️ **四条如实登记的空转项**（W27 接线之后**仍然**不生效，原因在数据不在接线）。
 *   共同点：`damageMultiplier` 挂在一个**效果树里根本没有伤害**的技能上，
 *   乘算乘在一个不存在的数上 —— 接线接不出伤害来。
 *
 *   · `druid.healing_touch`（愈合）—— 纯治疗（heal + HoT），
 *     作者想写的显然是 `healingMultiplier`。
 *   · `druid.bear_form` / `druid.cat_form` —— 形态切换只有 shapeshift + applyAura。
 *     「动物形态伤害 +15%」要的是形态光环上的 `damageDealt`，
 *     不是武器对**技能**的改写，`skillModifiers` 结构上表达不出来。
 *   · `mage.frost_nova`（冰霜新星）—— 只有 `root`，一滴伤害都没有。
 *     法刃的「瞬发技能 +15%」用逐个技能列举来表达，列到它头上时没人检查过
 *     它到底打不打伤害。
 *
 * 换字段/改机制都是要单独跑 balance 归因的**配平**改动，接线批不做。
 * 清单写死在这里，将来谁修好了这条断言会**主动变红**提醒把它划掉。
 */
const KNOWN_INERT = new Set([
  'druid.nature_staff|druid.healing_touch',
  'druid.polearm|druid.bear_form',
  'druid.polearm|druid.cat_form',
  'mage.spellblade_focus|mage.frost_nova',
]);

describe('★★ 25 条数据源逐个亮灯（docs/05 整章规格第一次真的生效）', () => {
  it('★ 数据源规模没变（少了说明有人删数据，多了说明这批断言要跟上）', () => {
    expect(ALL_ENTRIES.length).toBe(25);
    expect(ALL_ENTRIES.filter((e) => e.mod.damageMultiplier !== undefined).length).toBe(18);
    expect(ALL_ENTRIES.filter((e) => e.mod.cooldownMultiplier !== undefined).length).toBe(7);
    // 其余六个字段今天零数据源 —— 有人填了就该来这里加断言
    for (const key of [
      'healingMultiplier', 'castTimeMultiplier', 'radiusMultiplier',
      'durationMultiplier', 'rangeMultiplier', 'behindBonusDelta',
    ] as const) {
      expect(ALL_ENTRIES.filter((e) => e[
        'mod'
      ][key] !== undefined).length, `${key} 有新数据源了`).toBe(0);
    }
  });

  it('★★ 每一条都能被唯一入口查到（换上那把武器就等于拿到这张表）', () => {
    for (const { weapon, skillId, mod } of ALL_ENTRIES) {
      expect(skillModifierOf({ weaponId: weapon.id }, skillId), `${weapon.id}|${skillId}`)
        .toEqual(mod);
    }
  });

  it('★★ 18 条 damageMultiplier 逐个落在一发真实伤害上', () => {
    const rig = makeRig();
    const foe = rig.spawn(warrior, BLUE, vec3(0, 0, 3));
    for (const { weapon, skillId, mod } of ALL_ENTRIES) {
      if (mod.damageMultiplier === undefined) continue;
      const key = `${weapon.id}|${skillId}`;

      // ① 这个技能的效果树里到底有没有伤害（递归下探，见 walkEffects 的 ★★）
      const hasDamage = walkEffects(skillById(skillId).effects).has('damage');
      if (KNOWN_INERT.has(key)) {
        expect(hasDamage, `${key} 已经能打出伤害了 —— 请把它从 KNOWN_INERT 划掉`).toBe(false);
        continue;
      }
      expect(hasDamage, `${key} 的技能里没有任何伤害效果，乘算无处落地`).toBe(true);

      // ② 结算处真的乘了它
      const attacker = rig.spawn(
        getClass(weapon.classId) as ClassDefLike, RED, vec3(0, 0, 0), weapon.id as string,
      );
      const base = hitFor(attacker, foe, rig.world, NO_SKILL);
      expect(hitFor(attacker, foe, rig.world, skillId) / base, key)
        .toBeCloseTo(mod.damageMultiplier, 3);
    }
  });

  it('★★ 7 条 cooldownMultiplier 逐个缩短了那个技能的真实冷却', () => {
    for (const { weapon, skillId, mod } of ALL_ENTRIES) {
      if (mod.cooldownMultiplier === undefined) continue;
      const key = `${weapon.id}|${skillId}`;
      const skill = skillById(skillId);
      expect(skill.cooldown, `${key} 的技能没有冷却，乘算无处落地`).toBeGreaterThan(0);

      const rig = makeRig();
      const caster = rig.spawn(
        getClass(weapon.classId) as ClassDefLike, RED, vec3(0, 0, 0), weapon.id as string,
      );
      const foe = rig.spawn(warrior, BLUE, vec3(0, 0, 4));
      const mate = rig.spawn(warrior, RED, vec3(0, 0, -4));
      caster.yaw = dirToYaw(sub(foe.position, caster.position));

      const target =
        skill.targetFilter === TargetFilter.Ally ? mate
          : skill.targetFilter === TargetFilter.Self ? caster : foe;
      const request = {
        skillId: skill.id,
        ...(skill.targeting === Targeting.Ground
          ? { groundPoint: vec3(0, 0, 4) }
          : { targetId: target.id }),
      };

      // 逐 tick 推进，记下冷却**写入的那一刻**（读条技能要等好几个 tick）
      let firstRequest: TickDeps['castRequests'] | undefined = new Map([[caster.id, request]]);
      let setAt: number | undefined;
      for (let i = 0; i < Math.ceil(skill.cast.time / DT) + 4; i++) {
        tickWorld(rig.deps(firstRequest), DT);
        firstRequest = undefined;
        if (caster.cooldowns.has(skill.id)) {
          setAt = rig.world.time;
          break;
        }
      }
      expect(setAt, `${key} 没放出来（检查资源 / 距离 / 朝向夹具）`).toBeDefined();
      expect(caster.cooldowns.get(skill.id)! - setAt!, key)
        .toBeCloseTo(skill.cooldown * mod.cooldownMultiplier, 6);
    }
  });
});
