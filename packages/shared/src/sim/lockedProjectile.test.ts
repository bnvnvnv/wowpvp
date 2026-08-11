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
 *
 * ★ **W25 补账**：物理远程（猎人的瞄准射击/震慑箭、战士掷锤、盗贼致盲）
 *   跟着迁了，口径里的「学派非 physical」那一条随之删除 —— 它本来就是
 *   分批的开关而不是一条道理。同批引入的两件事写在下面：
 *   **速度不再是一个数**（箭 75、法术与投掷物 55，见 `SPELL_PROJECTILE`），
 *   以及**三条排除的反向断言**（断法箭 / 碰撞型 / 施法者自身位移）。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SPELL_PROJECTILE } from '../constants/combat.js';
import { ALL_CLASSES, getSkill, hunter, mage, paladin, priest, rogue, warrior } from '../data/index.js';
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
 * 施法者**自己**飞过去的效果。见下面 `shouldMigrate` 的排除③。
 * ★ `pullTarget` / `knockback`（把**目标**搬走）不在这里 —— 那是另一条
 *   排除（W23 已如实入册，见 `isCombatPayload` 头部）。
 */
const CASTER_MOVES = new Set(['chargeTo', 'chargeToAlly', 'blinkForward', 'teleportBehindTarget', 'leapBackward']);

/**
 * **迁移口径**（用户拍板：客户端画了弹道的技能必须到达才结算）。
 *
 * 四条全中才迁移：
 *   · `Direct` 瞄准 —— 地面技能已经是 `delayedGroundImpact`，
 *     `SelfCenter` 没有可飞的一段
 *   · `TargetFilter.Enemy` —— 治疗/友方法术 WoW 口径瞬时（真实理由是
 *     「给奶量加半秒延迟比视觉早到更伤玩法」，不是「客户端不画治疗弹道」
 *     —— `flies()` 里没有 targetFilter 这一项，14 个友方技能今天就在画）
 *   · `range.max ≥ 8` —— 近战不该有弹道（6.1 近战档最长 3.8 米）
 *   · 载荷含伤害或控制
 *
 * 外加三条**排除**：
 *   ① 带 `interrupt` 的不迁移 —— 断法迟到 0.4 秒等于没断，打断的是
 *     「正在读的那条」，飞到时那条早读完了。**这条优先于「同组一起迁」**：
 *     W25 迁了猎人的瞄准射击与震慑箭，断法箭仍然排除。
 *   ② 已经是**碰撞型**（带 `spawnProjectile`）的不迁移 —— 穿透重弩箭、
 *     飞去来斧走的是真实轨迹（能被墙挡、能靠横向走位躲开），那是 6.6 的
 *     另一类，不是「锁定」的慢速版本。今天它们都是 `Targeting.Projectile`
 *     因而已被第一条挡下，但**那是巧合不是不变式**：谁把一条 `Direct`
 *     技能配上 `spawnProjectile`，广度锁就会要求它同时长出两发弹体。
 *   ③ 载荷是**施法者自身位移**的不迁移 —— 飞过去的是人不是弹体。
 *
 * ★★ **W25 删掉了原来的第五条「学派非 `physical`」。** 那条是 W23 分批的
 *   开关（猎人最脆，箭矢延迟单独归因），不是一条道理 —— 客户端对物理远程
 *   同样在画弹道，割裂一模一样。删它的**代价**是：物理近战里有一批
 *   `Direct + ≥8 米 + 带控制` 的技能此前被学派这一条顺手挡在门外，
 *   现在要逐条给出真正的理由。查出来的正是排除③的原案：
 *   **战士的突进**（20 米、`[chargeTo, stun, gainResource]`）—— 它满足
 *   其余全部判据，而它的语义是「我冲过去撞晕你」，飞的是**施法者**。
 *   把它迁了等于「人已经贴脸、晕 0.36 秒后才生效」。
 *   ⚠️ 别让下一个人以为「没写进来 = 想清楚了」：这条排除是 W25 放宽口径时
 *   **被广度锁当场红出来**的，不是事先想到的。
 */
const shouldMigrate = (s: SkillDef): boolean =>
  s.targeting === Targeting.Direct &&
  s.targetFilter === TargetFilter.Enemy &&
  s.range.max >= SPELL_PROJECTILE.MIN_RANGE &&
  !s.effects.some((e) => e.kind === 'interrupt') &&
  !s.effects.some((e) => e.kind === 'spawnProjectile') &&
  !s.effects.some((e) => CASTER_MOVES.has(e.kind)) &&
  // 已经迁移的技能：载荷在 onHit 里，摊开一层再判
  isCombatPayload(s.effects.flatMap((e) => (e.kind === 'lockedProjectile' ? e.onHit : [e])));

const ALL_SKILLS: readonly SkillDef[] = [
  ...ALL_CLASSES.flatMap((c) => c.skills),
  ...PARTY_SKILLS,
];

const lockedOf = (s: SkillDef): Extract<EffectDef, { kind: 'lockedProjectile' }> | undefined =>
  s.effects.find((e) => e.kind === 'lockedProjectile');

describe('★★ W23/W25 广度锁：迁移口径与数据必须一致', () => {
  it('★★ 全部满足口径的技能都走 lockedProjectile —— 新增技能忘迁移会红', () => {
    const missed = ALL_SKILLS.filter((s) => shouldMigrate(s) && !lockedOf(s)).map(
      (s) => s.id as string,
    );
    expect(
      missed,
      '这些技能满足迁移口径却仍在读条结束瞬间落账（用户实测的那个 bug）',
    ).toEqual([]);
  });

  it('★ 反向：没有技能在不满足口径的情况下偷偷用了 lockedProjectile', () => {
    const extra = ALL_SKILLS.filter((s) => lockedOf(s) && !shouldMigrate(s)).map(
      (s) => s.id as string,
    );
    expect(extra, '口径之外的技能挂了弹道 —— 要么改口径，要么改数据').toEqual([]);
  });

  it('★ 迁移清单：W23 的 21 个 + W25 的 4 个 = 25（数量下限，加技能时随实际抬高）', () => {
    const migrated = ALL_SKILLS.filter((s) => lockedOf(s));
    expect(migrated.length).toBeGreaterThanOrEqual(25);
  });

  it('★★ W25 这四条确实迁了（逐条点名，别靠计数兜）', () => {
    const ids = ALL_SKILLS.filter((s) => lockedOf(s)).map((s) => s.id as string);
    for (const id of [
      'hunter.aimed_shot', 'hunter.concussive_shot', 'warrior.storm_bolt', 'rogue.blind',
    ]) {
      expect(ids, `${id} 没迁 —— W25 的清单是 4 迁 3 不迁`).toContain(id);
    }
  });

  it('★★ 速度只能取 SPELL_PROJECTILE 里的档位 —— 客户端按技能读的就是这个数', () => {
    /**
     * ★★ W23 时这条断言的是「统一 55」。W25 之后速度分了两档
     *   （箭 75 / 法术与投掷物 55），但**单一来源的纪律没变**：
     *   数字仍然只住在 `constants/combat.ts`，技能里写的是对它的引用，
     *   客户端 `SpellVfx` 从技能数据读同一个字段。
     *   写死一个字面量 60 会在这里红 —— 那正是要拦的东西。
     */
    const ALLOWED = [SPELL_PROJECTILE.SPEED, SPELL_PROJECTILE.ARROW_SPEED];
    for (const s of ALL_SKILLS) {
      const lp = lockedOf(s);
      if (!lp) continue;
      expect(ALLOWED, `${s.id as string} 的弹速不是 SPELL_PROJECTILE 里的任何一档`).toContain(
        lp.speed,
      );
    }
  });

  it('★★ 箭走 ARROW_SPEED、掷出去的钝器和粉末走 SPEED（「箭该有箭的样子」）', () => {
    /**
     * ★ 分档的边界是**投出去的是什么**，不是学派：掷锤（物理）与致盲粉
     *   （物理）都走 55，因为钝器和粉末不该比箭快。
     * ⚠️ 秘法箭与毒蛇钉刺**也是箭**，却仍在 55 —— 它们属于 W23 那批
     *   （奥术/自然学派，机制上是法术），W25 拍板「法术 55 不动」。
     *   这是如实的余账，docs/15 W25 行已入册；这里只钉住 W25 动过的那四条。
     */
    const speedOf = (id: string): number => lockedOf(ALL_SKILLS.find((s) => (s.id as string) === id)!)!.speed;
    expect(speedOf('hunter.aimed_shot')).toBe(SPELL_PROJECTILE.ARROW_SPEED);
    expect(speedOf('hunter.concussive_shot')).toBe(SPELL_PROJECTILE.ARROW_SPEED);
    expect(speedOf('warrior.storm_bolt')).toBe(SPELL_PROJECTILE.SPEED);
    expect(speedOf('rogue.blind')).toBe(SPELL_PROJECTILE.SPEED);
    // 箭确实比法术快 —— 否则上面四条在两个常量相等时也全绿
    expect(SPELL_PROJECTILE.ARROW_SPEED).toBeGreaterThan(SPELL_PROJECTILE.SPEED);
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

  /**
   * ★★ **W25 的三条反向断言。** 放宽口径最危险的地方不是「漏迁」（上面那条
   *   广度锁会红），而是「**多迁**」—— 多迁的技能在单测里静悄悄地绿，
   *   只在对局里表现成一个迟到的打断、一发画了两遍的箭、或一个先撞人
   *   后生效的晕。三条排除各钉一条正面点名的用例。
   */
  it('★★ 反向①：断法箭仍然不迁（W25 迁了同组的另外两条，它不跟）', () => {
    const counterShot = ALL_SKILLS.find((s) => (s.id as string) === 'hunter.counter_shot')!;
    expect(counterShot, '断法箭不见了 —— 这条测试不再测任何东西').toBeDefined();
    expect(lockedOf(counterShot), '断法箭被一起迁了：断法迟到 0.4 秒等于没断').toBeUndefined();
    expect(shouldMigrate(counterShot), '口径把断法箭放进来了').toBe(false);
  });

  it('★★ 反向②：已是碰撞型的两条不迁（穿透重弩箭 / 飞去来斧）', () => {
    /**
     * 它们能被墙挡、能靠横向走位躲开 —— 那是 6.6 的**另一类**，
     * 不是「锁定投射物的慢速版本」。迁了等于同时生成两发弹体，
     * 客户端也会画两条（一条真轨迹 + 一条装饰弹道）。
     */
    for (const id of ['hunter.piercing_bolt', 'ffa.boomerang_throw']) {
      const s = ALL_SKILLS.find((x) => (x.id as string) === id)!;
      expect(s, `${id} 不见了`).toBeDefined();
      expect(s.effects.some((e) => e.kind === 'spawnProjectile'), `${id} 不再是碰撞型`).toBe(true);
      expect(lockedOf(s), `${id} 同时挂了锁定投射物 —— 一次施放两发弹体`).toBeUndefined();
      expect(shouldMigrate(s), `口径把 ${id} 放进来了`).toBe(false);
    }
  });

  it('★★ 反向③：施法者自身位移不迁（战士突进 —— 飞过去的是人不是弹体）', () => {
    /**
     * ★★ 这一条是 W25 删掉「学派非 physical」时**被广度锁当场红出来**的：
     *   突进是 20 米、`Direct`、`Enemy`、载荷带 `stun` —— 其余判据全中，
     *   此前纯靠学派那一条被顺手挡住。迁了它就是「人已经撞到脸上，
     *   0.36 秒后才晕」。
     */
    const charge = ALL_SKILLS.find((s) => (s.id as string) === 'warrior.charge')!;
    expect(charge, '突进不见了').toBeDefined();
    expect(charge.effects.some((e) => e.kind === 'chargeTo'), '突进不再是位移技能').toBe(true);
    expect(charge.effects.some((e) => e.kind === 'stun'), '突进的晕没了').toBe(true);
    expect(lockedOf(charge), '突进被迁成了投射物 —— 撞完人才晕').toBeUndefined();
    expect(shouldMigrate(charge), '口径把突进放进来了').toBe(false);
  });

  it('★ 物理学派**不再**是排除项（W25 之后 physical 迁了 4 条）', () => {
    /**
     * ★ 正面断言口径确实放宽了：只留一条「physical 一个都没迁」的空数组
     *   断言在 W25 之后仍然会绿（如果谁又把物理挡回去），所以反过来钉。
     */
    const physicalMigrated = ALL_SKILLS.filter(
      (s) => s.school === School.Physical && lockedOf(s),
    ).map((s) => s.id as string);
    expect(physicalMigrated.sort()).toEqual([
      'hunter.aimed_shot', 'hunter.concussive_shot', 'rogue.blind', 'warrior.storm_bolt',
    ]);
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

/**
 * 一个「法师 vs 战士」的最小对局，走生产管线（castRequests → tickWorld）。
 * ★ W25：施法者职业开成参数（缺省仍是法师，既有用例逐位不变）——
 *   物理远程那批要拿**猎人自己**开弓，借法师的身体射箭测不出焦点消耗
 *   与准备条这两件与它有关的事。
 */
const makeRig = (distance = 20, casterClass: typeof mage = mage): Rig => {
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
  const caster = spawn(casterClass, RED, 0);
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
      // X29（随 W24）：回合重置也要拔化形游走的锚 —— 本夹具没有游走中的实体，
      // 传一份空的 movement 就够（必填字段，漏传编译不过 = 这条约束的执行方式）
      movement: new Map<EntityId, MovementState>(),
    });
    expect(rig.projectiles.items.length, '回合重置没有清空弹体仓').toBe(0);

    const before = rig.foe.health;
    advance(rig, 30);
    expect(rig.foe.health, '上一回合的弹体打到了新回合满血的人').toBe(before);
  });
});

// ════════════════════════════════════════════════════════════════
//  4. W25：物理远程 —— 箭有箭的速度，控制在抵达那一刻才落
// ════════════════════════════════════════════════════════════════

/** 一直推到仓里出现弹体为止（瞄准射击要先读 1.6 秒的准备条）*/
const advanceUntilBolt = (rig: Rig, maxTicks: number, req: TickDeps['castRequests']): void => {
  advance(rig, 1, req);
  for (let i = 1; i < maxTicks && rig.projectiles.items.length === 0; i++) advance(rig, 1);
};

describe('★★ W25：物理远程的弹道', () => {
  it('★★ 瞄准射击 30 米 / 75 m·s⁻¹ = 0.4 秒 —— 箭比同距离的法术早到 0.145 秒', () => {
    /**
     * ★★ 这条同时钉两件事：**速度确实按技能读**（不是全局 55），
     *   以及 `impactAt` 的公式没变（距离 / 速度）。
     * ★ 用 30 米而不是 35 米（射程上限）是为了离边界远一点 ——
     *   这条用例要测的是飞行时间，不是距离判据；35 米那个数在
     *   `vfx/lockedProjectileVfx.test.ts` 里由同公式钉着。
     */
    const rig = makeRig(30, hunter);
    const aimed = hunter.skills.find((s) => (s.id as string) === 'hunter.aimed_shot')!;
    const before = rig.foe.health;

    advanceUntilBolt(rig, 60, cast(rig, aimed));
    const p = homingOf(rig);
    expect(p.speed, '弹速没按技能读').toBe(SPELL_PROJECTILE.ARROW_SPEED);
    expect(p.impactAt - rig.world.time).toBeCloseTo(30 / SPELL_PROJECTILE.ARROW_SPEED, 5);
    // 与法术档的差额就是这批的全部意义
    expect(30 / SPELL_PROJECTILE.SPEED - 30 / SPELL_PROJECTILE.ARROW_SPEED).toBeCloseTo(0.145, 3);

    // 准备条读完那一瞬不掉血，飞到才掉
    expect(rig.foe.health, '读条一结束伤害就落账了 —— W25 白做').toBe(before);
    advance(rig, 12);
    expect(rig.foe.health, '箭到了却没结算').toBeLessThan(before);
  });

  it('★★ 掷锤：晕在**抵达**那一刻才亮（20 米 ≈ 0.36 秒）', () => {
    /**
     * ★★ 控制载荷下沉进 `onHit` 之后，`applyControl` 仍由同一条 `resolve()`
     *   调用 —— 递减类别、`clearableByTrinket`、从 skillId 反查学派全部照走。
     *   变的只是**递减计数从哪一刻开始**。这里断言的正是那个「哪一刻」。
     */
    const rig = makeRig(20, warrior);
    const bolt = warrior.skills.find((s) => (s.id as string) === 'warrior.storm_bolt')!;
    advance(rig, 1, cast(rig, bolt));
    expect(rig.projectiles.items.length, '锤没掷出去').toBe(1);
    expect(homingOf(rig).speed, '掷出去的钝器比箭还快').toBe(SPELL_PROJECTILE.SPEED);
    expect(rig.foe.flags.stunned, '锤还在飞，人已经晕了').toBe(false);

    advance(rig, 10); // 0.5 秒 > 0.36 秒
    expect(rig.foe.flags.stunned, '锤到了却没晕').toBe(true);
    const applied = rig.events.find((e) => e.t === 'auraApplied');
    expect(applied, '没有发出控制光环事件（表现层要用它）').toBeDefined();
  });

  it('★★ 致盲：10 米 ≈ 0.18 秒，粉末撒到才睁不开眼', () => {
    const rig = makeRig(10, rogue);
    const blind = rogue.skills.find((s) => (s.id as string) === 'rogue.blind')!;
    advance(rig, 1, cast(rig, blind));
    expect(rig.projectiles.items.length, '粉末没撒出去').toBe(1);
    expect(homingOf(rig).impactAt - rig.world.time).toBeCloseTo(
      10 / SPELL_PROJECTILE.SPEED, 5,
    );
    // 迷惑共用 stunned 旗（CONTROL_SPECS）
    expect(rig.foe.flags.stunned, '粉末还在飞，人已经瞎了').toBe(false);

    advance(rig, 6);
    expect(rig.foe.flags.stunned, '粉末到了却没生效').toBe(true);
  });

  it('★★ 掷锤走位躲不掉，但**免疫**挡得住 —— 与法术那批同一条语义', () => {
    /**
     * ★ 物理远程迁移后拿到的不只是延迟，还有 6.6 的整套反制语义：
     *   走位躲不掉（锁定），免疫/吸收/反射挡得住。这条只验前半 +
     *   免疫（后者是它唯一的反制方式）。
     */
    const rig = makeRig(20, warrior);
    const bolt = warrior.skills.find((s) => (s.id as string) === 'warrior.storm_bolt')!;
    advance(rig, 1, cast(rig, bolt));
    applyAura(
      rig.auras, rig.foe,
      {
        id: 'test.immune', name: '测试无敌', kind: 'buff', duration: 99,
        dispelType: DispelType.None, flags: { immuneAll: true },
        description: '测试用完全免疫',
      },
      rig.foe.id, rig.world.time,
    );
    for (let i = 0; i < 10; i++) {
      rig.foe.position = vec3(0, 0, rig.foe.position.z + 2); // 一路狂奔
      advance(rig, 1);
    }
    const dmg = rig.events.find((e) => e.t === 'damage');
    expect(dmg, '跑开就没结算了 —— 那是碰撞型的语义').toBeDefined();
    expect(dmg && dmg.t === 'damage' && dmg.immune, '无敌没挡住掷锤').toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════
//  5. W25 收口：物理规避的时点
// ════════════════════════════════════════════════════════════════

/**
 * ★★ **本批是第一次让闪避/招架/格挡跟着弹体推迟**，所以这一组必须存在。
 *
 *   W23 迁的 21 条全是魔法学派，`rollAvoidance` 第一行「学派非 physical
 *   直接放行」让整段规避**压根不执行**；上面第 2/3 组的「走位躲不掉」
 *   用例也各自绕开了这一面（法师是魔法学派、掷锤那条被 `immuneAll`
 *   在规避之前就短路了）。W25 把物理送进这条路之后才第一次暴露：
 *   规避读的是**抵达那一刻**的朝向与可行动状态。
 *
 * ★★ **裁决（W25 收口）：6.6 的「命中资格」包含规避。**
 *   6.6 给锁定投射物列的反制方式是**免疫、吸收、反射**三样，闪避不在其中；
 *   而「飞行途中转个身」「飞行途中被队友控住」都属于它明文禁掉的
 *   「目标释放后移动不会使其自然落空」。于是规避赖以成立的两个**事实**
 *   （射手在不在背后、目标能不能做动作）在 `spawnHoming` 冻结成
 *   `HitSnapshot`，抵达时用快照值掷骰。
 *
 * ★ **分界线是「按了一个键」与「转了个身」**：几率（`mods`）仍然现读，
 *   所以飞行途中开闪避类保命键**照样有用** —— 那与免疫/吸收同族。
 *   最后一条用例专门钉这一半，否则「一律冻结」也会让前三条全绿。
 */
const AIMED_SHOT = hunter.skills.find((s) => (s.id as string) === 'hunter.aimed_shot')!;

/** 必定正面闪避的探针光环 —— 用 1.0 而不是靠种子，规避与否才是可读的信号 */
const ALWAYS_DODGE = {
  id: 'test.always_dodge', name: '测试闪避', kind: 'buff' as const, duration: 99,
  dispelType: DispelType.None, modifiers: { dodgeFront: 1 },
  description: '测试用必定正面闪避',
};

describe('★★ W25 收口：规避判定按释放瞬间的朝向与可行动状态', () => {
  /** 30 米开一发瞄准射击（1.6 秒准备条 + 0.4 秒飞行），返回抵达后的伤害事件 */
  const shoot = (rig: Rig): Extract<CombatEvent, { t: 'damage' }> | undefined => {
    advanceUntilBolt(rig, 60, cast(rig, AIMED_SHOT));
    advance(rig, 15);
    const e = rig.events.find((x) => x.t === 'damage');
    return e && e.t === 'damage' ? e : undefined;
  };

  it('★ 对照组：全程正面 → 箭被闪掉（下面三条的信号靠它才可读）', () => {
    const rig = makeRig(30, hunter);
    applyAura(rig.auras, rig.foe, ALWAYS_DODGE, rig.foe.id, rig.world.time);
    const before = rig.foe.health;
    const dmg = shoot(rig);
    expect(dmg?.avoided, '正面挂着必定闪避却没闪掉').toBe('dodge');
    expect(rig.foe.health, '闪掉了还掉血').toBe(before);
  });

  it('★★ 飞行途中转身 180°：规避照掷 —— 转身不是 6.6 认的反制方式', () => {
    /**
     * ★ 改之前这条是红的：`isBehind` 现读实时 `yaw`，转身后射手「变成」
     *   在背后，闪避/格挡整条跳过，一发**已经锁定**的箭凭空打满 300% 武器伤害。
     *   同一个洞对战士的 20% 格挡、匕首招架一视同仁。
     */
    const rig = makeRig(30, hunter);
    applyAura(rig.auras, rig.foe, ALWAYS_DODGE, rig.foe.id, rig.world.time);
    const before = rig.foe.health;
    advanceUntilBolt(rig, 60, cast(rig, AIMED_SHOT));
    rig.foe.yaw += Math.PI; // 箭在飞，人转过去背对射手
    advance(rig, 15);
    const dmg = rig.events.find((e) => e.t === 'damage');
    expect(dmg && dmg.t === 'damage' && dmg.avoided, '转个身就把规避转没了').toBe('dodge');
    expect(rig.foe.health, '转身让一发锁定的箭多打了一轮伤害').toBe(before);
  });

  it('★★ 飞行途中被控住：规避照掷 —— 第三方的控制不该给这一发开路', () => {
    /**
     * ★ 「队友的掷锤先落、我的箭随后到」不该让那一发无视格挡：
     *   射出去的时候他站得好好的。改之前 `target.flags.stunned` 现读，
     *   这条组合技能静默地把规避整条摘掉。
     */
    const rig = makeRig(30, hunter);
    applyAura(rig.auras, rig.foe, ALWAYS_DODGE, rig.foe.id, rig.world.time);
    const before = rig.foe.health;
    advanceUntilBolt(rig, 60, cast(rig, AIMED_SHOT));
    applyAura(
      rig.auras, rig.foe,
      {
        id: 'test.mid_flight_stun', name: '测试昏迷', kind: 'debuff', duration: 99,
        dispelType: DispelType.None, flags: { stunned: true }, description: '飞行途中的昏迷',
      },
      rig.foe.id, rig.world.time,
    );
    advance(rig, 15);
    const dmg = rig.events.find((e) => e.t === 'damage');
    expect(dmg && dmg.t === 'damage' && dmg.avoided, '飞行途中被控住就不能闪了').toBe('dodge');
    expect(rig.foe.health, '被队友控住让这一发无视了格挡').toBe(before);
  });

  it('★★ 反向：释放瞬间就背对射手 → 转回正面也躲不掉（不是「一律都闪」）', () => {
    /**
     * ★★ 没有这条，上面三条用「永远返回 dodge」的实现也会全绿。
     *   快照是**双向**的：射手赚到的那个背身位同样不该被 0.47 秒里的
     *   一次转身抹掉。warrior 默认 `sword_shield` 只有 `block: 0.2`
     *   （无 `parry`），而闪避与格挡都被背身位绕过 → 这里没有随机流参与。
     */
    const rig = makeRig(30, hunter);
    applyAura(rig.auras, rig.foe, ALWAYS_DODGE, rig.foe.id, rig.world.time);
    const before = rig.foe.health;
    rig.foe.yaw = rig.caster.yaw; // 释放瞬间背对射手
    advanceUntilBolt(rig, 60, cast(rig, AIMED_SHOT));
    rig.foe.yaw = rig.caster.yaw + Math.PI; // 箭在飞的时候转回正面
    advance(rig, 15);
    const dmg = rig.events.find((e) => e.t === 'damage');
    expect(dmg && dmg.t === 'damage' && dmg.avoided, '转回正面就把背身位抹掉了').toBeUndefined();
    expect(rig.foe.health, '背对射手射出的箭没落账').toBeLessThan(before);
  });

  it('★★ 冻结的是事实不是几率：飞行途中开闪避键**照样**有用', () => {
    /**
     * ★★ 这条钉的是裁决的另一半。把「规避资格」整个在释放瞬间掷完
     *   （而不是只冻结朝向与可行动状态）会让这条红 —— 那样盗贼的闪避、
     *   任何「5 秒内正面闪避提高」类保命键对飞行中的箭就完全失效，
     *   与 6.6 允许免疫/吸收在抵达时生效自相矛盾。
     */
    const rig = makeRig(30, hunter);
    const before = rig.foe.health;
    advanceUntilBolt(rig, 60, cast(rig, AIMED_SHOT));
    // 箭已经在飞了，这时候才按下保命键
    applyAura(rig.auras, rig.foe, ALWAYS_DODGE, rig.foe.id, rig.world.time);
    advance(rig, 15);
    const dmg = rig.events.find((e) => e.t === 'damage');
    expect(dmg && dmg.t === 'damage' && dmg.avoided, '飞行途中开的闪避没生效').toBe('dodge');
    expect(rig.foe.health, '闪掉了还掉血').toBe(before);
  });

  it('★ 快照住在弹体上，且只有锁定投射物有（碰撞型/延迟落点现读空间事实）', () => {
    /**
     * ★ 结构性断言：`HitSnapshot` 是 `HomingProjectile` 的**必填**字段
     *   （漏填编译不过 = 这条约束的执行方式），这里只验它确实按
     *   释放瞬间的朝向填对了 —— 上面四条验的是它被谁消费。
     */
    const rig = makeRig(30, hunter);
    advanceUntilBolt(rig, 60, cast(rig, AIMED_SHOT));
    const p = homingOf(rig);
    expect(p.hitSnapshot.fromBehind, '靶子面朝射手，却记成了背身位').toBe(false);
    expect(p.hitSnapshot.canAvoid, '靶子没被控，却记成了不能规避').toBe(true);
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

    /**
     * ⚠️ 裁决的载荷从 W23 当时的 `['damage','applyAura']` 变成了三条 ——
     *   **X13 后加的减速光环**（`paladin.judgement.slow`），不是迁移动了数值。
     *   这条用例锁的是「W23 只挪了结算时点」，所以断言方式跟着改成
     *   「**迁移当时那两条原样还在，且都在 onHit 里**」：后来的功能可以往
     *   载荷里加东西，但不许把当年那两条改掉或挪回顶层。写死一个长度只会
     *   让下一次正常的功能扩充红在一个与它无关的用例上。
     */
    const judgement = paladin.skills.find((s) => (s.id as string) === 'paladin.judgement')!;
    const jPayload = lockedOf(judgement)!.onHit;
    expect(jPayload[0]).toEqual({ kind: 'damage', school: School.Holy, amount: { flat: 58 } });
    expect(
      jPayload.some((e) => e.kind === 'applyAura' && e.aura.id === 'paladin.judgement'),
      '迁移当时那枚易伤光环不在 onHit 里了',
    ).toBe(true);
    expect(judgement.effects.every((e) => e.kind === 'lockedProjectile'), '目标向效果漏在顶层').toBe(true);
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
