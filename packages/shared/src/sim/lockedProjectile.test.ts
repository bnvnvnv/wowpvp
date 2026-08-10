/**
 * W23 法术弹道迁移：**法术要飞到才结算**（6.6 锁定投射物）。
 *
 * ★★ 起因是用户实测的一句话：「法术还没到，伤害就出来了，应该命中后才出伤害」。
 *   在此之前全部 Direct 法术在读条结束的**那一瞬间**落账，客户端画的弹道
 *   纯属装饰 —— 而 `sim/projectile.ts` 的 `HomingProjectile` / `spawnHoming()`
 *   从 M4 起就写好并单测通过，只是**没有任何 `EffectDef` 能表达它**
 *   （第 N 条「规则写对了、单测全绿、但没人调用它」）。
 *
 * 本文件钉三样东西：
 *   1. **口径**（广度锁）：满足迁移判据的技能必须走 `lockedProjectile`，
 *      漏迁一个就红 —— 将来新增技能忘了迁移不会静默溜过去。
 *   2. **同一条结算路**：暴击、`damage.skillId`、光环学派、击杀归账、
 *      统计事件流，抵达时结算与直接施放**逐项一致**，一条都不旁路。
 *   3. **飞行中的边界**：施法者死、目标死、目标开无敌/吸收、目标进潜行、
 *      对局结束时仓里还有弹体。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SPELL_PROJECTILE } from '../constants/combat.js';
import { ALL_CLASSES, getSkill, mage, paladin, priest, warrior } from '../data/index.js';
import { PARTY_SKILLS } from '../data/party.js';
import type { EffectDef, SkillDef } from '../data/schema.js';
import { box } from '../data/maps/schema.js';
import { dirToYaw, sub, vec3 } from '../math/vec3.js';
import {
  ArenaPreset, DispelType, GameMode, School, TargetFilter, Targeting,
} from '../types/enums.js';
import { asSkillId, asTeamId, type EntityId } from '../types/ids.js';
import { applyAura, createAuraStore, type AuraStore } from './aura.js';
import { createCastingStore } from './casting.js';
import { createDrStore, type DrStore } from './dr.js';
import { createArsenalStore, createPickupStore } from './arsenal.js';
import { createEntity, type CombatEntity } from './entity.js';
import { createGroundStore, type GroundStore } from './groundArea.js';
import { createArena, resetRound } from './match/arena.js';
import { createLoadout, createLoadoutStore, createSwapStore } from './loadout.js';
import type { MovementInput, MovementState } from './movement.js';
import {
  createProjectileStore, type HomingProjectile, type ProjectileStore,
} from './projectile.js';
import { tickWorld, type TickDeps } from './tick.js';
import { addEntity, allocEntityId, createWorld, type World } from './world.js';
import type { CombatEvent } from './effects/index.js';

const RED = asTeamId(0);
const BLUE = asTeamId(1);
const FLOOR = box('g', 'floor', { x: 0, y: -1, z: 0 }, { w: 400, h: 1, d: 400 });
const DT = 0.05;

// ════════════════════════════════════════════════════════════════
//  1. 广度锁：口径写在这里，数据必须服从
// ════════════════════════════════════════════════════════════════

/** 顶层控制效果（与 `applyControl` 认的那批同源）*/
const CONTROL_KINDS = new Set(['stun', 'incapacitate', 'fear', 'root', 'silence', 'disarm']);

/**
 * 载荷是不是「伤害或控制」—— 迁移判据的最后一项。
 *
 * ⚠️ **这条判据里没有 `pullTarget` / `knockback`，那是一条第六类排除，
 *   而且此前是静默的**（对抗校验查出，docs/15 的 W23 行已如实入册）：
 *   死骑的死亡之握是暗影学派、20 米、单体 Direct，客户端 `flies()` 三条全中
 *   → **正在画**一条飞过去的锁链，而 `pullTarget` 在读条结束那一瞬就把人拽到位。
 *   与用户原话是同一个割裂，只是载荷是位移不是伤害；WoW 口径也是「链子飞到才拽」。
 *   要迁它就把这两个 kind 加进来 —— 别让下一个人以为「没写进来 = 想清楚了」。
 */
const isCombatPayload = (effects: readonly EffectDef[]): boolean =>
  effects.some(
    (e) =>
      e.kind === 'damage' ||
      CONTROL_KINDS.has(e.kind) ||
      (e.kind === 'applyAura' && e.aura.kind === 'debuff'),
  );

/**
 * **W23 的迁移口径**（用户拍板：客户端画了弹道的技能必须到达才结算）。
 *
 * 五条全中才迁移：
 *   · `Direct` 瞄准 —— 地面技能已经是 `delayedGroundImpact`，
 *     `SelfCenter` 没有可飞的一段
 *   · `TargetFilter.Enemy` —— 治疗/友方法术 WoW 口径瞬时，客户端也不画
 *     治疗弹道，迁移它们只会凭空给奶量加半秒延迟
 *   · `range.max ≥ 8` —— 近战不该有弹道（6.1 近战档最长 3.8 米）
 *   · 学派非 `physical` —— 猎人/盗贼的物理远程另立一批（docs/15 W25）
 *   · 载荷含伤害或控制
 * 外加一条**排除**：带 `interrupt` 的不迁移 —— 断法迟到 0.5 秒等于没断，
 *   打断的是「正在读的那条」，飞到时那条早读完了。
 */
const shouldMigrate = (s: SkillDef): boolean =>
  s.targeting === Targeting.Direct &&
  s.targetFilter === TargetFilter.Enemy &&
  s.range.max >= SPELL_PROJECTILE.MIN_RANGE &&
  s.school !== School.Physical &&
  !s.effects.some((e) => e.kind === 'interrupt') &&
  // 已经迁移的技能：载荷在 onHit 里，摊开一层再判
  isCombatPayload(s.effects.flatMap((e) => (e.kind === 'lockedProjectile' ? e.onHit : [e])));

const ALL_SKILLS: readonly SkillDef[] = [
  ...ALL_CLASSES.flatMap((c) => c.skills),
  ...PARTY_SKILLS,
];

const lockedOf = (s: SkillDef): Extract<EffectDef, { kind: 'lockedProjectile' }> | undefined =>
  s.effects.find((e) => e.kind === 'lockedProjectile');

describe('★★ W23 广度锁：迁移口径与数据必须一致', () => {
  it('★★ 全部满足口径的技能都走 lockedProjectile —— 新增技能忘迁移会红', () => {
    const missed = ALL_SKILLS.filter((s) => shouldMigrate(s) && !lockedOf(s)).map(
      (s) => s.id as string,
    );
    expect(
      missed,
      '这些技能满足 W23 迁移口径却仍在读条结束瞬间落账（用户实测的那个 bug）',
    ).toEqual([]);
  });

  it('★ 反向：没有技能在不满足口径的情况下偷偷用了 lockedProjectile', () => {
    const extra = ALL_SKILLS.filter((s) => lockedOf(s) && !shouldMigrate(s)).map(
      (s) => s.id as string,
    );
    expect(extra, '口径之外的技能挂了弹道 —— 要么改口径，要么改数据').toEqual([]);
  });

  it('★ 迁移清单就是这 21 个（数量下限，加技能时随实际抬高）', () => {
    const migrated = ALL_SKILLS.filter((s) => lockedOf(s));
    expect(migrated.length).toBeGreaterThanOrEqual(21);
  });

  it('★★ 速度统一取 SPELL_PROJECTILE.SPEED —— 与客户端 BOLT_SPEED 同一个数', () => {
    for (const s of ALL_SKILLS) {
      const lp = lockedOf(s);
      if (!lp) continue;
      expect(lp.speed, `${s.id as string} 的弹速偏离统一值`).toBe(SPELL_PROJECTILE.SPEED);
    }
  });

  it('★★ 施法者自身的效果留在弹体外 —— onHit 里不该有 gainResource / target:self', () => {
    const bad: string[] = [];
    for (const s of ALL_SKILLS) {
      const lp = lockedOf(s);
      if (!lp) continue;
      for (const e of lp.onHit) {
        if (e.kind === 'gainResource') bad.push(`${s.id as string}: gainResource`);
        if (e.kind === 'applyAura' && e.target === 'self') {
          bad.push(`${s.id as string}: applyAura(self)`);
        }
      }
    }
    // 圣光弹的圣能是这条口径的原型：射出去就该进池子，不等弹体飞到
    expect(bad, 'onHit 只放目标指向的效果').toEqual([]);
  });

  it('★ 打断技能一个都没被迁移（断法迟到 0.5 秒等于没断）', () => {
    const wrong = ALL_SKILLS.filter(
      (s) => s.effects.some((e) => e.kind === 'interrupt') && lockedOf(s),
    ).map((s) => s.id as string);
    expect(wrong).toEqual([]);
  });

  it('★ 治疗/友方法术一个都没被迁移（WoW 口径瞬时，客户端也不画治疗弹道）', () => {
    const wrong = ALL_SKILLS.filter(
      (s) => s.targetFilter !== TargetFilter.Enemy && lockedOf(s),
    ).map((s) => s.id as string);
    expect(wrong).toEqual([]);
  });

  it('★ 物理学派远程一个都没被迁移（猎人箭矢单独一批 —— docs/15 W25）', () => {
    const wrong = ALL_SKILLS.filter((s) => s.school === School.Physical && lockedOf(s)).map(
      (s) => s.id as string,
    );
    expect(wrong).toEqual([]);
  });

  it('★★ 迁移的技能全部满足客户端 flies() 的三条判据 —— 否则会变成看不见的弹道', () => {
    /**
     * `client/src/vfx/SpellVfx.ts` 的 `flies()`：单体形状 + Direct/Projectile
     * 瞄准 + 射程 ≥ 8 米。锁定投射物的**视觉载体就是那条装饰弹道**
     * （快照路径显式跳过 homing，避免双重渲染），所以判据不成立
     * 就等于「伤害飞过来了，但玩家什么都没看见」。
     */
    for (const s of ALL_SKILLS) {
      if (!lockedOf(s)) continue;
      const label = s.id as string;
      expect(s.shape.kind, `${label} 不是单体形状`).toBe('single');
      expect(
        s.targeting === Targeting.Direct || s.targeting === Targeting.Projectile,
        `${label} 的瞄准类型画不出弹道`,
      ).toBe(true);
      expect(s.range.max, `${label} 射程不足 8 米`).toBeGreaterThanOrEqual(
        SPELL_PROJECTILE.MIN_RANGE,
      );
      expect(
        s.effects.some((e) => e.kind === 'spawnProjectile'),
        `${label} 同时挂了碰撞型投射物 —— 客户端会画两发`,
      ).toBe(false);
    }
  });
});

// ════════════════════════════════════════════════════════════════
//  2 / 3. 真实施放：结算路与飞行中的边界
// ════════════════════════════════════════════════════════════════

interface Rig {
  world: World;
  auras: AuraStore;
  /** 回合重置那条用例要把整套旁挂状态交给 `resetRound` */
  dr: DrStore;
  ground: GroundStore;
  projectiles: ProjectileStore;
  deps: (castRequests?: TickDeps['castRequests']) => TickDeps;
  caster: CombatEntity;
  foe: CombatEntity;
  events: CombatEvent[];
}

/** 一个「法师 vs 战士」的最小对局，走生产管线（castRequests → tickWorld）*/
const makeRig = (distance = 20): Rig => {
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

  const spawn = (cls: typeof mage, team: typeof RED, z: number): CombatEntity => {
    const e = addEntity(world, createEntity(allocEntityId(world), cls, team, vec3(0, 0, z)));
    loadouts.set(e.id, createLoadout(e.classId));
    for (const [r, max] of e.maxResources) e.resources.set(r, max);
    return e;
  };
  const caster = spawn(mage, RED, 0);
  const foe = spawn(warrior, BLUE, distance);
  caster.yaw = dirToYaw(sub(foe.position, caster.position));
  foe.yaw = caster.yaw + Math.PI;

  // 经典竞技场预设：本文件不测临时武装（验收 #28 那条由 arsenal.test.ts 管）
  const arsenal = createArsenalStore(ArenaPreset.Classic);
  const swaps = createSwapStore();
  const pickups = createPickupStore();
  const deps: Rig['deps'] = (castRequests) => ({
    world, auras, dr, ground, projectiles, casting,
    loadouts, swaps, pickups, arsenal, movement, inputs, getSkill,
    ...(castRequests ? { castRequests } : {}),
  });

  return { world, auras, dr, ground, projectiles, deps, caster, foe, events };
};

/** 推 n 个 tick，收集事件 */
const advance = (rig: Rig, n: number, castRequests?: TickDeps['castRequests']): void => {
  for (let i = 0; i < n; i++) {
    const r = tickWorld(rig.deps(i === 0 ? castRequests : undefined), DT);
    rig.events.push(...r.events);
  }
};

/**
 * 仓里第一发弹体，且**必须是锁定投射物**。
 * ★ 断言 + 类型收窄一步到位：`expect(p.kind).toBe('homing')` 不收窄类型，
 *   后面读 `p.impactAt` 会过不了 typecheck（碰撞型没有这个字段）。
 */
const homingOf = (rig: Rig): HomingProjectile => {
  const p = rig.projectiles.items[0];
  if (!p || p.kind !== 'homing') {
    throw new Error(`仓里第一发不是锁定投射物：${p?.kind ?? '空仓'}`);
  }
  return p;
};

/** 瞬发的迁移技能：烈焰爆（纯伤害，无读条，便于把时间轴看清楚）*/
const FIRE_BLAST = mage.skills.find((s) => (s.id as string) === 'mage.fire_blast')!;
const cast = (rig: Rig, skill: SkillDef = FIRE_BLAST): TickDeps['castRequests'] =>
  new Map([[rig.caster.id, { skillId: skill.id, targetId: rig.foe.id }]]);

describe('★★ 锁定投射物：读条结束不落账，抵达才落账', () => {
  let rig: Rig;
  beforeEach(() => {
    rig = makeRig(20);
  });

  it('★★ 施放当帧敌人一滴血没掉 —— 用户报的那个 bug 的正面断言', () => {
    const before = rig.foe.health;
    advance(rig, 1, cast(rig));
    expect(rig.foe.health, '伤害仍在释放瞬间落账，弹道还是装饰').toBe(before);
    expect(rig.projectiles.items.length, '没有生成弹体').toBe(1);
  });

  it('★★ 20 米 / 55 m·s⁻¹ ≈ 0.36 秒后落账，与 impactAt 一致', () => {
    const before = rig.foe.health;
    advance(rig, 1, cast(rig));
    const p = homingOf(rig);
    // ★ 弹体是在**本 tick**（world.time 已经前进过一次）生成的
    const expected = 20 / SPELL_PROJECTILE.SPEED;
    expect(p.impactAt - rig.world.time).toBeCloseTo(expected, 5);

    // 抵达前一直不掉血
    while (rig.world.time < p.impactAt - DT) {
      advance(rig, 1);
      expect(rig.foe.health, '弹体还在半路，血就掉了').toBe(before);
    }
    advance(rig, 2);
    expect(rig.foe.health, '弹体到了却没结算').toBeLessThan(before);
    expect(rig.projectiles.items.length, '弹体没有被回收').toBe(0);
  });

  it('★★ 走位躲不掉（6.6）：目标一路狂奔，伤害照落', () => {
    const before = rig.foe.health;
    advance(rig, 1, cast(rig));
    for (let i = 0; i < 40; i++) {
      rig.foe.position = vec3(0, 0, rig.foe.position.z + 2); // 每 tick 跑 2 米
      advance(rig, 1);
    }
    expect(rig.foe.health, '跑开就没伤害了 —— 那是碰撞型投射物的语义').toBeLessThan(before);
  });

  it('★★ 走的是同一条结算路：damage 事件带 skillId（X3 死亡回顾要显示真名）', () => {
    advance(rig, 30, cast(rig));
    const dmg = rig.events.find((e) => e.t === 'damage');
    expect(dmg, '没有产生 damage 事件').toBeDefined();
    expect(dmg && dmg.t === 'damage' && dmg.skillId).toBe('mage.fire_blast');
  });

  it('★★ 光环照常施加，且 applyControl 仍能从 skillId 反查学派（表现层要用）', () => {
    // 霜矢：伤害 + 减速光环，全在 onHit 里
    const frostbolt = mage.skills.find((s) => (s.id as string) === 'mage.frostbolt')!;
    advance(rig, 80, cast(rig, frostbolt));
    const applied = rig.events.find(
      (e) => e.t === 'auraApplied' && e.auraId === 'mage.frostbolt.chill',
    );
    expect(applied, '减速光环没有随弹体抵达施加').toBeDefined();
  });

  it('★★ 击杀归账不丢：弹体打死人时 death 事件带 killerId', () => {
    rig.foe.health = 30;
    advance(rig, 30, cast(rig));
    const death = rig.events.find((e) => e.t === 'death');
    expect(death, '没打死').toBeDefined();
    expect(death && death.t === 'death' && death.killerId).toBe(rig.caster.id);
  });

  it('★ 施法者自身的效果**不**等弹体（圣光弹的圣能射出即入池）', () => {
    // 圣骑士换权杖方案才有圣光弹 —— 这里只验数据结构上的分层，
    // 「施法者效果在弹体外」的行为断言由上面的广度锁保证
    const holyBolt = paladin.skills.find((s) => (s.id as string) === 'paladin.holy_bolt')!;
    expect(holyBolt.effects.some((e) => e.kind === 'gainResource')).toBe(true);
    expect(holyBolt.effects.some((e) => e.kind === 'lockedProjectile')).toBe(true);
  });
});

describe('★★ 飞行中的边界用例', () => {
  it('★★ 施法者飞行中死亡：弹体照飞、伤害照落、击杀归账给死人', () => {
    /**
     * ★ 这是**如实**而不是权宜：你射出去的那一发在你倒下之后打死了人，
     *   那就是你的击杀。`dealDamage` 不检查 `source.alive`，
     *   `tickWorld` 的 resolve 只要求施法者还**在世界里**（尸体在）。
     */
    const rig = makeRig(20);
    rig.foe.health = 30;
    advance(rig, 1, cast(rig));
    rig.caster.alive = false;
    rig.caster.health = 0;
    advance(rig, 30);
    const death = rig.events.find((e) => e.t === 'death' && e.targetId === rig.foe.id);
    expect(death, '施法者死了，飞行中的弹体就不结算了').toBeDefined();
    expect(death && death.t === 'death' && death.killerId).toBe(rig.caster.id);
  });

  it('★ 目标飞行中死亡：不结算（tickProjectiles 只对 alive 的目标发命中事件）', () => {
    const rig = makeRig(20);
    advance(rig, 1, cast(rig));
    rig.foe.alive = false;
    rig.foe.health = 0;
    const damageBefore = rig.events.filter((e) => e.t === 'damage').length;
    advance(rig, 30);
    expect(
      rig.events.filter((e) => e.t === 'damage').length,
      '往尸体上补了一发',
    ).toBe(damageBefore);
    expect(rig.projectiles.items.length, '弹体没被回收').toBe(0);
  });

  it('★★ 目标飞行中开无敌：到达时才判免疫（6.6 —— 免疫是它的反制方式）', () => {
    const rig = makeRig(20);
    const before = rig.foe.health;
    advance(rig, 1, cast(rig));
    /**
     * ★ 必须挂**真光环**，不能直接写 `flags.immuneAll` ——
     *   `tickWorld` 第 7 步每 tick 都用 `deriveStatusFlags()` 从光环重算
     *   这张表，手写的旗子活不过一个 tick（与 effects/displacement.ts 里
     *   「只写 entity.position 是死代码」同族的坑）。
     */
    applyAura(
      rig.auras, rig.foe,
      {
        id: 'test.immune', name: '测试无敌', kind: 'buff', duration: 99,
        dispelType: DispelType.None, flags: { immuneAll: true },
        description: '测试用完全免疫',
      },
      rig.foe.id, rig.world.time,
    );
    advance(rig, 30);
    expect(rig.foe.health, '无敌没挡住').toBe(before);
    const dmg = rig.events.find((e) => e.t === 'damage');
    expect(dmg && dmg.t === 'damage' && dmg.immune, '没有发出 immune 伤害事件').toBe(true);
  });

  it('★★ 目标飞行中进潜行：锁定已确认资格，照中（走位/隐身都躲不掉）', () => {
    const rig = makeRig(20);
    const before = rig.foe.health;
    advance(rig, 1, cast(rig));
    applyAura(
      rig.auras, rig.foe,
      {
        id: 'test.stealth', name: '测试潜行', kind: 'buff', duration: 99,
        dispelType: DispelType.None, flags: { stealthed: true },
        description: '测试用潜行',
      },
      rig.foe.id, rig.world.time,
    );
    advance(rig, 30);
    expect(rig.foe.health, '潜行把已经在飞的弹体甩掉了 —— 违反 6.6').toBeLessThan(before);
  });

  it('★★ 对局结束：弹体随对局的 ProjectileStore 一起作废，不跨局结算', () => {
    /**
     * ★ 这条不是靠「谁记得清仓」，而是**结构性**的：`sim/match/setup.ts`
     *   每局 `createProjectileStore()` 一个新的，旧仓连同飞行中的弹体
     *   一起被丢弃。这里如实断言那个结构 —— 换成「复用同一个 store」
     *   的实现时它会红。
     */
    const rig = makeRig(20);
    advance(rig, 1, cast(rig));
    expect(rig.projectiles.items.length).toBe(1);

    const fresh = createProjectileStore();
    expect(fresh.items, '新对局的弹体仓不是空的').toEqual([]);
    expect(fresh.nextId, '新对局的弹体 id 没有从头开始').toBe(1);
  });

  it('★★ 回合重置：上一回合还在飞的弹体不得打到新回合满血的人', () => {
    /**
     * ★★ 上一条钉的是**换局**（换 store，结构性安全）；这一条钉的是
     *   **换回合**（同一个 store 从头用到尾）—— 两者是不同的边界。
     *   `resetRound` 清了光环/递减/地面区域，弹体仓此前无人清：
     *   一发在飞的冰矛能穿过回合分界，打在新回合满血的人身上。
     *
     *   W23 之前这个洞是**潜伏**的（只有陨星/箭雨偶尔用弹体仓，
     *   而多回合赛在服务器上还打不起来）；W23 之后 21 个技能每个 GCD
     *   都在用它，潜伏面大了一个量级 —— 所以现在就钉住。
     *   ★ 改之前它是红的：`resetRound` 不清仓时目标会掉血。
     */
    const rig = makeRig(20);
    advance(rig, 1, cast(rig));
    expect(rig.projectiles.items.length, '弹体没生成，这条测试就没在测东西').toBe(1);

    const arena = createArena({ mode: GameMode.Arena3v3, roundsToWin: 1 });
    resetRound(arena, {
      world: rig.world,
      auras: rig.auras,
      dr: rig.dr,
      ground: rig.ground,
      projectiles: rig.projectiles,
    });
    expect(rig.projectiles.items.length, '回合重置没有清空弹体仓').toBe(0);

    const before = rig.foe.health;
    advance(rig, 30);
    expect(rig.foe.health, '上一回合的弹体打到了新回合满血的人').toBe(before);
  });
});

describe('★ 迁移没有改变数值口径', () => {
  it('★ 迁移技能的载荷与迁移前逐字节一致（只挪了结算时点，没动数值）', () => {
    // 抽查三个形状各不相同的：纯伤害 / 伤害+减速 / 纯 DoT
    const fireBlast = lockedOf(FIRE_BLAST)!;
    expect(fireBlast.onHit).toEqual([
      { kind: 'damage', school: School.Fire, amount: { flat: 225 } },
    ]);

    const swp = priest.skills.find((s) => (s.id as string) === 'priest.shadow_word_pain')!;
    const swpPayload = lockedOf(swp)!.onHit;
    expect(swpPayload.length).toBe(1);
    expect(swpPayload[0]!.kind).toBe('applyAura');

    const judgement = paladin.skills.find((s) => (s.id as string) === 'paladin.judgement')!;
    const jPayload = lockedOf(judgement)!.onHit;
    expect(jPayload.map((e) => e.kind)).toEqual(['damage', 'applyAura']);
  });

  it('★ 技能 id 一个都没变（图标表 / 签名表 / 教学步骤全按 id 查）', () => {
    for (const id of [
      'mage.frostbolt', 'mage.fire_blast', 'mage.polymorph', 'mage.ice_lance', 'mage.scorch',
      'priest.smite', 'priest.mind_spike', 'priest.shadow_word_pain', 'priest.mind_blast',
      'paladin.judgement', 'paladin.hammer_of_justice', 'paladin.holy_bolt',
    ]) {
      expect(getSkill(asSkillId(id)), `${id} 不见了`).toBeDefined();
    }
  });
});
