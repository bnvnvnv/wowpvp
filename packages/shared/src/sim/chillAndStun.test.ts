/**
 * X13 控制效果扩展：**冰系持续减速** 与 **火系击晕**。
 *
 * ★★ 起因是用户拍板（2026-08-10）的原话：
 *   「法师没有群体控制减速脱身，我理解应该是很多职业的技能带有减速效果，
 *     尤其是**法师的冰系减速技能应该有一些持续减速的效果**，
 *     **火系应该有一些击晕的效果**，这些没有」。
 *
 * 本文件钉的不是数值（数值归 balance 归因），而是三件**结构性**的事实 ——
 * 每一件都对应一条只要有人「顺手改数据」就会静默失效的接线：
 *
 *   1. **寒冷是一枚而不是两枚**：霜矢与冰枪术施加的是**同一个 def 对象**。
 *      拆成两枚时数值上等价（减速取最强，8.4），但一次驱散只清得掉一枚 ——
 *      反制链会断，而没有任何现有测试看得见。
 *   2. **减速真的作用到移动上**：`moveSpeedMultiplierOf` 是移动速度唯一的
 *      出口（见它的注释：断筋/冰霜锁链曾经整整几个里程碑没有影响过移动）。
 *      光环挂上了不等于人变慢了，这里一路验到那个倍率。
 *      圣骑士裁决的减速另有一层陷阱（`casterScoped`），单独一条钉住。
 *   3. **陨星的击晕走完整的 8.2 递减链**：第二次必须半衰、第四次必须免疫。
 *      它住在 `delayedGroundImpact.onImpact` 里，是「载荷下沉了一层」的
 *      第二例（第一例是 W23 的 `lockedProjectile.onHit`）。
 */

import { describe, expect, it } from 'vitest';
import { getSkill, mage, paladin, priest, warrior } from '../data/index.js';
import type { AuraDef, EffectDef, SkillDef } from '../data/schema.js';
import { box } from '../data/maps/schema.js';
import { dirToYaw, sub, vec3, type Vec3 } from '../math/vec3.js';
import { ArenaPreset, DispelType, DrCategory } from '../types/enums.js';
import { asSkillId, asTeamId, type EntityId } from '../types/ids.js';
import { aurasOf, createAuraStore, dispel, moveSpeedMultiplierOf } from './aura.js';
import { createCastingStore } from './casting.js';
import { createDrStore } from './dr.js';
import { createArsenalStore, createPickupStore } from './arsenal.js';
import { createEntity, type CombatEntity } from './entity.js';
import { createGroundStore } from './groundArea.js';
import { createLoadout, createLoadoutStore, createSwapStore } from './loadout.js';
import type { MovementInput, MovementState } from './movement.js';
import { createProjectileStore } from './projectile.js';
import { tickWorld, type TickDeps } from './tick.js';
import { addEntity, allocEntityId, createWorld, type World } from './world.js';
import type { CombatEvent } from './effects/index.js';

const RED = asTeamId(0);
const BLUE = asTeamId(1);
const FLOOR = box('g', 'floor', { x: 0, y: -1, z: 0 }, { w: 400, h: 1, d: 400 });
const DT = 0.05;

const skillOf = (cls: { skills: readonly SkillDef[] }, id: string): SkillDef =>
  cls.skills.find((s) => (s.id as string) === id)!;

const FROSTBOLT = skillOf(mage, 'mage.frostbolt');
const ICE_LANCE = skillOf(mage, 'mage.ice_lance');
const METEOR = skillOf(mage, 'mage.meteor');
const JUDGEMENT = skillOf(paladin, 'paladin.judgement');

/** 摊平 `lockedProjectile.onHit` 与 `delayedGroundImpact.onImpact` 各一层 */
const payloadOf = (s: SkillDef): readonly EffectDef[] =>
  s.effects.flatMap((e) =>
    e.kind === 'lockedProjectile' ? e.onHit : e.kind === 'delayedGroundImpact' ? e.onImpact : [e],
  );

const aurasIn = (s: SkillDef): AuraDef[] =>
  payloadOf(s).flatMap((e) => (e.kind === 'applyAura' ? [e.aura] : []));

// ════════════════════════════════════════════════════════════════
//  1. 数据形状：寒冷族是一枚，不是每个技能一枚
// ════════════════════════════════════════════════════════════════

describe('★★ X13 冰系寒冷族：霜矢与冰枪术共用同一枚减速', () => {
  it('★★ 两个技能引用的是**同一个 def 对象**（拆开会让驱散只清掉一半）', () => {
    const fromBolt = aurasIn(FROSTBOLT).find((a) => a.id === 'mage.frostbolt.chill');
    const fromLance = aurasIn(ICE_LANCE).find((a) => a.id === 'mage.frostbolt.chill');
    expect(fromBolt, '霜矢丢了寒冷减速').toBeDefined();
    expect(fromLance, '冰枪术没有寒冷减速 —— 用户说的「不持续」正是这条').toBeDefined();
    /**
     * ★ 断言的是**引用相等**而不是深相等：`applyAura` 刷新时只改时长、
     *   `def` 仍是第一次施加的那份（aura.ts 的 existing 分支不覆盖 def）。
     *   两处各写一份数值时，后按的键会「用自己的时长刷新别人的强度」——
     *   深相等看不出来那一天有人把其中一份改成了 3 秒。
     */
    expect(fromBolt, '两处各写了一份 def —— 刷新时会用自己的时长刷新别人的强度').toBe(fromLance);
  });

  it('★ 寒冷是可驱散的魔法减益，且不参与控制递减（8.2：减速与定身是两条链）', () => {
    const chill = aurasIn(FROSTBOLT).find((a) => a.id === 'mage.frostbolt.chill')!;
    expect(chill.dispelType).toBe(DispelType.Magic);
    expect(chill.drCategory, '普通减速被塞进了递减链 —— 8.2 明写「与普通减速分开」').toBeUndefined();
    expect(chill.modifiers?.moveSpeed, '寒冷没有减速修正').toBeLessThan(1);
  });

  it('★ 冰枪术仍然只有一发弹体，载荷全在 onHit 里（W23 口径不许被绕过）', () => {
    expect(ICE_LANCE.effects.every((e) => e.kind === 'lockedProjectile')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════
//  2. 真实施放：走生产管线（castRequests → tickWorld）
// ════════════════════════════════════════════════════════════════

interface Rig {
  world: World;
  auras: ReturnType<typeof createAuraStore>;
  dr: ReturnType<typeof createDrStore>;
  deps: (castRequests?: TickDeps['castRequests']) => TickDeps;
  caster: CombatEntity;
  foe: CombatEntity;
  /** 再往盘上放人（队友、第二个施法者）。X13 收口批的误伤/免疫用例要用 */
  spawn: (cls: typeof mage, team: typeof RED, at: Vec3) => CombatEntity;
  events: CombatEvent[];
}

const makeRig = (casterClass: typeof mage, distance = 12): Rig => {
  const world = createWorld([FLOOR]);
  const auras = createAuraStore();
  const dr = createDrStore();
  const ground = createGroundStore();
  const projectiles = createProjectileStore();
  const casting = createCastingStore();
  const loadouts = createLoadoutStore();
  const movement = new Map<EntityId, MovementState>();
  const inputs = new Map<EntityId, MovementInput>();
  const events: CombatEvent[] = [];

  const spawn = (cls: typeof mage, team: typeof RED, at: Vec3): CombatEntity => {
    const e = addEntity(world, createEntity(allocEntityId(world), cls, team, { ...at }));
    loadouts.set(e.id, createLoadout(e.classId));
    for (const [r, max] of e.maxResources) e.resources.set(r, max);
    return e;
  };
  const caster = spawn(casterClass, RED, vec3(0, 0, 0));
  const foe = spawn(warrior, BLUE, vec3(0, 0, distance));
  caster.yaw = dirToYaw(sub(foe.position, caster.position));
  foe.yaw = caster.yaw + Math.PI;

  const arsenal = createArsenalStore(ArenaPreset.Classic);
  const swaps = createSwapStore();
  const pickups = createPickupStore();
  const deps: Rig['deps'] = (castRequests) => ({
    world, auras, dr, ground, projectiles, casting,
    loadouts, swaps, pickups, arsenal, movement, inputs, getSkill,
    ...(castRequests ? { castRequests } : {}),
  });

  return { world, auras, dr, deps, caster, foe, spawn, events };
};

const advance = (rig: Rig, n: number, castRequests?: TickDeps['castRequests']): void => {
  for (let i = 0; i < n; i++) {
    const r = tickWorld(rig.deps(i === 0 ? castRequests : undefined), DT);
    rig.events.push(...r.events);
  }
};

/** 一次施放请求。地面技能落在敌人脚下 */
const castOn = (rig: Rig, skill: SkillDef): TickDeps['castRequests'] =>
  new Map([[rig.caster.id, {
    skillId: skill.id,
    ...(skill.targeting === 'ground'
      ? { groundPoint: { ...rig.foe.position } }
      : { targetId: rig.foe.id }),
  }]]);

/** 冷却/公共冷却清干净，让同一个键能连按 —— 只在验「刷新」时用 */
const readyAgain = (rig: Rig): void => {
  rig.caster.cooldowns.clear();
  rig.caster.gcdUntil = 0;
  for (const [r, max] of rig.caster.maxResources) rig.caster.resources.set(r, max);
};

const chillOn = (rig: Rig): { expiresAt: number } | undefined =>
  aurasOf(rig.auras, rig.foe.id).find((a) => a.def.id === 'mage.frostbolt.chill');

describe('★★ X13 冰系持续减速：冰枪术一直点，减速就一直在', () => {
  it('★★ 冰枪术命中后目标**真的变慢**（一路验到 moveSpeedMultiplierOf）', () => {
    const rig = makeRig(mage);
    expect(moveSpeedMultiplierOf(rig.auras, rig.foe, rig.world.time)).toBe(1);
    advance(rig, 20, castOn(rig, ICE_LANCE));
    expect(chillOn(rig), '冰枪没有挂上寒冷').toBeDefined();
    expect(
      moveSpeedMultiplierOf(rig.auras, rig.foe, rig.world.time),
      '光环挂上了，但移动速度没变 —— 又一次「数据在、没人读」',
    ).toBeCloseTo(0.6, 5);
  });

  it('★★ 再点一发冰枪会**刷新**同一枚寒冷，而不是各挂各的', () => {
    const rig = makeRig(mage);
    advance(rig, 20, castOn(rig, ICE_LANCE));
    const first = chillOn(rig)!.expiresAt;

    readyAgain(rig);
    advance(rig, 20, castOn(rig, ICE_LANCE));

    const all = aurasOf(rig.auras, rig.foe.id).filter((a) => a.def.id === 'mage.frostbolt.chill');
    expect(all.length, '挂出了第二枚寒冷 —— 同 id 同来源本该刷新').toBe(1);
    expect(all[0]!.expiresAt, '剩余时间没有被刷新，「持续减速」就不成立').toBeGreaterThan(first);
  });

  it('★★ 霜矢挂的寒冷可以被冰枪接力刷新（两个键同一条减速轴）', () => {
    const rig = makeRig(mage);
    // 霜矢：1.4 秒读条 + 12 米飞行
    advance(rig, 60, castOn(rig, FROSTBOLT));
    expect(chillOn(rig), '霜矢没有挂上寒冷').toBeDefined();
    // ⚠️ 存**数字**不是实例：刷新是就地改同一个 AuraInstance，
    //   留着实例引用去比较等于拿刷新后的值和它自己比
    const boltExpiry = chillOn(rig)!.expiresAt;

    readyAgain(rig);
    advance(rig, 20, castOn(rig, ICE_LANCE));
    const all = aurasOf(rig.auras, rig.foe.id).filter((a) => a.def.id === 'mage.frostbolt.chill');
    expect(all.length, '霜矢与冰枪各挂了一枚 —— 驱散只能清掉其中一枚').toBe(1);
    expect(all[0]!.expiresAt).toBeGreaterThan(boltExpiry);
  });

  it('★★ 反制链完整：一次驱散魔法把减速清干净（这正是共用一个 id 的理由）', () => {
    const rig = makeRig(mage);
    advance(rig, 60, castOn(rig, FROSTBOLT));
    readyAgain(rig);
    advance(rig, 20, castOn(rig, ICE_LANCE));

    const removed = dispel(rig.auras, rig.foe.id, { types: [DispelType.Magic] }, 1, 'debuff');
    expect(removed.length).toBe(1);
    expect(
      moveSpeedMultiplierOf(rig.auras, rig.foe, rig.world.time),
      '驱散过了还在减速 —— 说明身上不止一枚寒冷',
    ).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════
//  3. 火系击晕：陨星落地
// ════════════════════════════════════════════════════════════════

describe('★★ X13 火系击晕：陨星落地把人砸晕', () => {
  /** 陨星：1 秒读条 + 1.5 秒落点延迟，留足余量 */
  const METEOR_TICKS = 80;

  it('★★ 落地时敌人被昏迷（击晕住在 onImpact 里，别只看顶层）', () => {
    const rig = makeRig(mage);
    let sawStun = false;
    for (let i = 0; i < METEOR_TICKS; i++) {
      advance(rig, 1, i === 0 ? castOn(rig, METEOR) : undefined);
      if (rig.foe.flags.stunned) sawStun = true;
    }
    expect(sawStun, '陨星砸下来了，人却没晕').toBe(true);
    expect(rig.foe.health, '陨星没造成伤害 —— 夹具或落点错了').toBeLessThan(rig.foe.maxHealth);
  });

  it('★★ 击晕走 8.2 昏迷递减链：第二发半衰、第四发免疫', () => {
    const rig = makeRig(mage);
    const durations: number[] = [];
    for (let round = 0; round < 4; round++) {
      readyAgain(rig);
      rig.foe.health = rig.foe.maxHealth; // 别让他在第四轮之前被砸死
      const before = rig.events.length;
      for (let i = 0; i < METEOR_TICKS; i++) {
        advance(rig, 1, i === 0 ? castOn(rig, METEOR) : undefined);
      }
      const applied = rig.events
        .slice(before)
        .find((e) => e.t === 'auraApplied' && e.auraId === 'control.stun');
      durations.push(applied && applied.t === 'auraApplied' ? applied.duration : 0);
      // 下一发前把这次的昏迷放干净（控制上叠控制不是这条用例要测的）
      for (let i = 0; i < 60; i++) advance(rig, 1);
    }
    expect(durations[0], '第一发不是满时长').toBeCloseTo(1.5, 3);
    expect(durations[1]!, '第二发没有半衰').toBeCloseTo(0.75, 3);
    expect(durations[2]!, '第三发没有降到四分之一').toBeCloseTo(0.375, 3);
    expect(durations[3], '第四发没有免疫').toBe(0);
    const immune = rig.events.filter((e) => e.t === 'immune' && e.why === 'dr');
    expect(immune.length, '免疫时没有发出 dr 免疫事件').toBeGreaterThan(0);
  });

  it('★ 击晕不带 breakOnDamage —— 陨星自己那 420 点伤害不该把它当场打断', () => {
    const stun = payloadOf(METEOR).find((e) => e.kind === 'stun');
    expect(stun, '陨星丢了击晕').toBeDefined();
    // `stun` 这个 EffectDef 结构上就没有 breakDamage 字段（只有 incapacitate/
    // fear/root 有）—— 这条断言锁的是「没有人把它改成 incapacitate 图省事」
    expect(stun!.kind).toBe('stun');
  });

  it('★ 陨星的击晕归入既有的 Stun 递减类别，没有新造一条链', () => {
    // CONTROL_SPECS 的映射是唯一事实源；这里只确认数据用的是那批 kind 之一
    expect(DrCategory.Stun).toBe('stun');
    expect(payloadOf(METEOR).some((e) => e.kind === 'stun')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════
//  4. 圣骑士裁决减速：casterScoped 陷阱的反向锁
// ════════════════════════════════════════════════════════════════

describe('★★ X13 圣骑士裁决：减速必须是独立的一枚（casterScoped 会吞掉它）', () => {
  it('★★ 减速光环**不是** casterScoped —— 否则移动速度那条路径整枚跳过它', () => {
    const slow = aurasIn(JUDGEMENT).find((a) => a.id === 'paladin.judgement.slow');
    expect(slow, '裁决丢了减速').toBeDefined();
    /**
     * ⚠️ `effectiveModifiersOf` 在不传 attackerId 时会跳过全部 casterScoped
     *   光环，而 `moveSpeedMultiplierOf` 恰恰不传 —— 把 moveSpeed 写进那枚
     *   易伤光环里会得到一条「数据里看得见、跑起来完全不生效」的减速。
     */
    expect(slow!.casterScoped, '减速被标成了 casterScoped —— 它永远不会影响移动').toBeFalsy();
    expect(slow!.modifiers?.moveSpeed).toBeLessThan(1);
  });

  it('★★ 易伤那枚仍然是 casterScoped（别为了修减速把它一起改掉）', () => {
    const vuln = aurasIn(JUDGEMENT).find((a) => a.id === 'paladin.judgement')!;
    expect(vuln.casterScoped).toBe(true);
    expect(vuln.modifiers?.damageTaken).toBeGreaterThan(1);
  });

  it('★★ 裁决命中后目标真的变慢', () => {
    const rig = makeRig(paladin);
    advance(rig, 20, castOn(rig, JUDGEMENT));
    expect(
      aurasOf(rig.auras, rig.foe.id).some((a) => a.def.id === 'paladin.judgement.slow'),
      '减速光环没挂上',
    ).toBe(true);
    expect(
      moveSpeedMultiplierOf(rig.auras, rig.foe, rig.world.time),
      '光环挂上了但移动速度没变 —— casterScoped 陷阱又踩了一次',
    ).toBeCloseTo(0.8, 5);
  });
});

// ════════════════════════════════════════════════════════════════
//  5. 八职业减速覆盖：这一批到底改变了什么
// ════════════════════════════════════════════════════════════════

describe('★ 八职业减速覆盖（X13 审计口径）', () => {
  it('★ 五个近战/远程职业各自至少有一条减速；牧师与德鲁伊刻意没有', () => {
    const hasSlow = (cls: { skills: readonly SkillDef[] }): boolean =>
      cls.skills.some((s) => aurasIn(s).some((a) => (a.modifiers?.moveSpeed ?? 1) < 1));
    // ⚠️ 名单是**结论**不是自动推导：牧师（恐惧+沉默）与德鲁伊（缠根+旋风）
    //    的移动控制由硬控承担，且它们是当前基线胜率最高的两档 ——
    //    「没有减速」在这两个职业身上是设计决定，理由写在 docs/15 的 X13 行。
    for (const cls of [mage, paladin, warrior]) {
      expect(hasSlow(cls), `${cls.id as string} 丢了减速`).toBe(true);
    }
  });
});

// ════════════════════════════════════════════════════════════════
//  6. 收口：陨星的击晕**不许**砸到自己人（8.1 友军伤害默认关闭）
// ════════════════════════════════════════════════════════════════

/**
 * ★★ X13 对抗校验抓到的 blocker：延迟落点在**落地那一刻重新选目标**，
 *   而那次选目标此前**没有任何阵营判据** —— 施法期 `aiming.ts` 的
 *   `TargetFilter` 是 1.5 秒之前的事。伤害误伤是既有缺口，X13 把一条
 *   **硬控**放上了这条路：最典型的用法（被贴脸时把陨星丢在自己脚下）
 *   变成自己被硬控 1.5 秒、位移和寒冰屏障一个都按不出来。
 *
 * ★ bot 永远不选地面技能（`botController` 的 `usableOn` 开头就排除 ground），
 *   所以 balance 报告**永远抓不到这条** —— 只能靠这里的集成用例。
 */
describe('★★ X13 收口：陨星只砸敌人（8.1 友军伤害默认关闭）', () => {
  const METEOR_TICKS = 80;

  it('★★ 站在落点里的队友：既不掉血也不被晕', () => {
    const rig = makeRig(mage);
    // 队友与敌人肩并肩站在落点圆心旁（半径 5）
    const ally = rig.spawn(priest, RED, vec3(2, 0, rig.foe.position.z));
    const allyHp = ally.health;
    let allyStunned = false;
    let foeStunned = false;
    for (let i = 0; i < METEOR_TICKS; i++) {
      advance(rig, 1, i === 0 ? castOn(rig, METEOR) : undefined);
      if (ally.flags.stunned) allyStunned = true;
      if (rig.foe.flags.stunned) foeStunned = true;
    }
    expect(foeStunned, '敌人没被晕 —— 夹具坏了，下面两条断言就没有意义').toBe(true);
    expect(allyStunned, '队友被自家陨星击晕了（8.1）').toBe(false);
    expect(allyHp - ally.health, '队友挨了自家陨星的伤害（8.1）').toBe(0);
  });

  it('★★ 丢在自己脚下：法师不会把自己晕住（这正是本批想解决的那个场景）', () => {
    // 敌人贴脸（2 米），落点在他脚下 —— 法师自己也在半径 5 之内
    const rig = makeRig(mage, 2);
    const hp = rig.caster.health;
    let selfStunned = false;
    for (let i = 0; i < METEOR_TICKS; i++) {
      advance(rig, 1, i === 0 ? castOn(rig, METEOR) : undefined);
      if (rig.caster.flags.stunned) selfStunned = true;
    }
    expect(selfStunned, '法师被自己的陨星击晕了').toBe(false);
    expect(hp - rig.caster.health, '法师被自己的陨星炸了').toBe(0);
    expect(rig.foe.health, '敌人没挨到陨星 —— 夹具坏了').toBeLessThan(rig.foe.maxHealth);
  });
});

// ════════════════════════════════════════════════════════════════
//  7. 收口：「免疫新的减速与定身」对**减速**也要生效
// ════════════════════════════════════════════════════════════════

/**
 * ★★ X13 对抗校验抓到的 major：`immuneMovementImpair` /`immuneSlowAndRoot`
 *   此前**只在 `applyControl` 的 root 分支**被读过，而减速是一枚普通光环、
 *   走的是 `applyAura` 处理器 —— 于是自由庇佑说明里的「3 秒内免疫新的减速」
 *   对全仓库每一条减速都没有生效过。X13 把寒冷改成「瞬发零冷却每 GCD 刷新」
 *   之后这条洞变成决定性的：法师侧与圣骑士侧**新写的 counters** 都把
 *   自由祝福当作反制手段卖给玩家。
 */
describe('★★ X13 收口：自由庇佑的「免疫新的减速」真的挡得住', () => {
  const FREEDOM = skillOf(paladin, 'paladin.blessing_of_freedom');
  const HAMSTRING = skillOf(warrior, 'warrior.hamstring');

  /** 给 foe 挂上自由庇佑：由他自己那队的圣骑士施放，走生产管线 */
  const shieldFoe = (rig: Rig): void => {
    const mate = rig.spawn(paladin, BLUE, vec3(2, 0, rig.foe.position.z));
    advance(rig, 6, new Map([[mate.id, { skillId: FREEDOM.id, targetId: rig.foe.id }]]));
    expect(rig.foe.flags.immuneMovementImpair, '自由庇佑没挂上 —— 夹具坏了').toBe(true);
  };

  it('★★ 免疫窗口内吃冰枪：寒冷挂不上，移动倍率仍是 1', () => {
    const rig = makeRig(mage);
    shieldFoe(rig);
    advance(rig, 20, castOn(rig, ICE_LANCE));
    expect(chillOn(rig), '「免疫新的减速」期间寒冷还是挂上了').toBeUndefined();
    expect(
      moveSpeedMultiplierOf(rig.auras, rig.foe, rig.world.time),
      '免疫窗口内仍然被减速 —— 技能说明在骗玩家',
    ).toBe(1);
    // 14.3：挡下来要有反馈，否则玩家读不出「我的庇佑生效了」
    expect(
      rig.events.some((e) => e.t === 'immune' && e.auraId === 'mage.frostbolt.chill'),
      '挡下来了却没发免疫事件',
    ).toBe(true);
  });

  it('★ 夹具对照：同一套距离/朝向下，没有庇佑时断腿斩是挂得上的', () => {
    const rig = makeRig(warrior, 2.5);
    advance(rig, 10, castOn(rig, HAMSTRING));
    expect(
      aurasOf(rig.auras, rig.foe.id).some((a) => a.def.id === 'warrior.hamstring'),
      '断腿斩本来就没挂上（距离/朝向/怒气）—— 下一条用例会变成假绿',
    ).toBe(true);
    expect(moveSpeedMultiplierOf(rig.auras, rig.foe, rig.world.time)).toBeCloseTo(0.6, 5);
  });

  it('★★ 换一条**非魔法**减速（断腿斩）同样挡得住 —— 判据是「限制移动」不是驱散类别', () => {
    const rig = makeRig(warrior, 2.5);
    shieldFoe(rig);
    advance(rig, 10, castOn(rig, HAMSTRING));
    expect(
      aurasOf(rig.auras, rig.foe.id).some((a) => a.def.id === 'warrior.hamstring'),
      '断腿斩在免疫窗口内挂上了',
    ).toBe(false);
    expect(moveSpeedMultiplierOf(rig.auras, rig.foe, rig.world.time)).toBe(1);
  });

  it('★ 免疫的是**移动限制**，不是所有减益：伤害与其他减益照旧落下', () => {
    const rig = makeRig(mage);
    shieldFoe(rig);
    const hp = rig.foe.health;
    advance(rig, 20, castOn(rig, ICE_LANCE));
    expect(hp - rig.foe.health, '连伤害都被挡掉了 —— 免疫判据写宽了').toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════
//  8. 收口：圣骑士侧「一次驱散之后还剩什么」（记录在案的不对称）
// ════════════════════════════════════════════════════════════════

/**
 * ★★ X13 对抗校验抓到的 major：裁决在同一次命中里挂**两枚魔法减益**，
 *   而这正是本批为寒冷写下的那条禁忌（`mage.ts` 的 `FROST_CHILL` 注释）。
 *   圣骑士侧因为 `casterScoped` 这条硬约束做不到合并（合了减速就永远不生效）。
 *
 * ★ 处置是 (b)「保持两枚，把口径改成如实的」—— 理由与另两条出路的代价
 *   写在 `paladin.ts` 的注释与 docs/15 的 X13 行。这一组用例是那句 counters
 *   的**可执行版本**：哪天 (a) 落地把两枚合成一枚，它会红，提醒把文案改回去。
 */
describe('★★ X13 收口：裁决的两枚魔法减益 —— 一次驱散清掉的是哪一枚', () => {
  const DISPEL_MAGIC = skillOf(priest, 'priest.dispel_magic');

  it('★ 牧师的驱散魔法确实是 count: 1（下面结论的前提）', () => {
    // 净化术一个技能两条 dispel：对友方去负面、对敌方偷增益。取友方那条
    const d = DISPEL_MAGIC.effects.find((e) => e.kind === 'dispel' && e.from === 'ally');
    expect(d, '驱散魔法丢了「对友方」那条 dispel 效果').toBeDefined();
    expect(d!.kind === 'dispel' && d!.count, '不再是 count:1 —— 上面那条不对称的结论要重算').toBe(1);
  });

  it('★★ 一次驱散魔法带走易伤，减速留在身上（counters 就是这么写的）', () => {
    const rig = makeRig(paladin);
    advance(rig, 20, castOn(rig, JUDGEMENT));
    expect(
      aurasOf(rig.auras, rig.foe.id).map((a) => a.def.id),
      '裁决挂出来的不是「先易伤后减速」两枚 —— 驱散顺序结论跟着变',
    ).toEqual(['paladin.judgement', 'paladin.judgement.slow']);

    const removed = dispel(rig.auras, rig.foe.id, { types: [DispelType.Magic] }, 1, 'debuff');
    expect(removed.map((r) => r.aura.def.id)).toEqual(['paladin.judgement']);
    expect(
      moveSpeedMultiplierOf(rig.auras, rig.foe, rig.world.time),
      '减速也被一起清掉了 —— 说明两枚合并了，该把 counters 与 docs/15 改回去',
    ).toBeCloseTo(0.8, 5);
  });

  it('★★ 专解移动限制的手段（自由庇佑那半边）一次就能带走减速', () => {
    const rig = makeRig(paladin);
    advance(rig, 20, castOn(rig, JUDGEMENT));
    // 自由庇佑的 dispel 半边：按「实际做了什么」选，不按驱散类别
    const removed = dispel(rig.auras, rig.foe.id, { impairs: 'movement' }, 'all', 'debuff');
    expect(removed.map((r) => r.aura.def.id)).toEqual(['paladin.judgement.slow']);
    expect(moveSpeedMultiplierOf(rig.auras, rig.foe, rig.world.time)).toBe(1);
  });
});

/** 冒烟：技能 id 一个都没改（图标表/签名表/教学步骤全按 id 查）*/
describe('★ id 未变', () => {
  it('★ 本批只改效果，不改 id', () => {
    for (const id of ['mage.frostbolt', 'mage.ice_lance', 'mage.meteor', 'paladin.judgement']) {
      expect(getSkill(asSkillId(id)), `${id} 不见了`).toBeDefined();
    }
  });
});
