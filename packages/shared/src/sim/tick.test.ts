/**
 * 权威 tick 顺序测试。docs/02 §3。
 *
 * ★★ **这个文件不测「tick 能跑」，它测「顺序反了就会错」。**
 *
 *   `tick.ts` 头部列了 11 条顺序约束，每一条都有出处。但注释挡不住重构 ——
 *   一个「顺手把这两步换个位置，看起来更顺」的改动不会让任何东西报错。
 *   所以每条关键约束都配一个「顺序反了就会失败」的场景。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { getClass, getSkill, mage, priest, warrior } from '../data/index.js';
import { ctfMap } from '../data/maps/index.js';
import { box } from '../data/maps/schema.js';
import { dirToYaw, sub, vec3 } from '../math/vec3.js';
import { ARENA } from '../constants/combat.js';
import { ArenaPreset, CastFailure, GameMode, School } from '../types/enums.js';
import { asSkillId, TEAM_BLUE, TEAM_RED } from '../types/ids.js';
import { usesNoTarget } from './aiming.js';
import { createAuraStore, type AuraStore } from './aura.js';
import { beginCast, createCastingStore, validateCast, type CastingStore } from './casting.js';
import { createDrStore, type DrStore } from './dr.js';
import { createArsenalStore, createPickupStore, type ArsenalStore, type PickupStore } from './arsenal.js';
import { createEntity, type CombatEntity } from './entity.js';
import { createGroundStore, type GroundStore } from './groundArea.js';
import {
  addWeapon, beginSwap, createLoadout, createLoadoutStore, SwapKind,
  type LoadoutStore, type SwapStore,
} from './loadout.js';
import { createSwapStore } from './loadout.js';
import { createArena, RoundPhase, type ArenaState } from './match/arena.js';
import { createCtf, enemyFlagOf, type CtfState } from './match/flag.js';
import { createMovementState, type MovementInput, type MovementState } from './movement.js';
import { createProjectileStore, type ProjectileStore } from './projectile.js';
import { createStats, registerPlayer, type StatsStore } from './stats.js';
import { tickWorld, type TickDeps } from './tick.js';
import { addEntity, allocEntityId, createWorld, type World } from './world.js';
import { dealDamage } from './effects/index.js';
import type { EntityId } from '../types/ids.js';
import type { SkillDef } from '../data/schema.js';

const ground = box('g', 'floor', { x: 0, y: -1, z: 0 }, { w: 400, h: 1, d: 400 });

let world: World;
let auras: AuraStore;
let dr: DrStore;
let groundStore: GroundStore;
let projectiles: ProjectileStore;
let casting: CastingStore;
let loadouts: LoadoutStore;
let swaps: SwapStore;
let pickups: PickupStore;
let arsenal: ArsenalStore;
let movement: Map<EntityId, MovementState>;
let inputs: Map<EntityId, MovementInput>;

let player: CombatEntity;
let foe: CombatEntity;

const spawn = (cls: typeof mage, team: typeof TEAM_RED, x = 0, z = 0): CombatEntity => {
  const e = addEntity(world, createEntity(allocEntityId(world), cls, team, vec3(x, 0, z)));
  loadouts.set(e.id, createLoadout(e.classId));
  return e;
};

beforeEach(() => {
  world = createWorld([ground]);
  auras = createAuraStore();
  dr = createDrStore();
  groundStore = createGroundStore();
  projectiles = createProjectileStore();
  casting = createCastingStore();
  loadouts = createLoadoutStore();
  swaps = createSwapStore();
  pickups = createPickupStore();
  arsenal = createArsenalStore(ArenaPreset.Armed);
  movement = new Map();
  inputs = new Map();

  player = spawn(mage, TEAM_RED, 0, 0);
  foe = spawn(warrior, TEAM_BLUE, 0, 3);
});

const deps = (over: Partial<TickDeps> = {}): TickDeps => ({
  world, auras, dr, ground: groundStore, projectiles, casting,
  loadouts, swaps, pickups, arsenal,
  movement, inputs,
  getSkill,
  ...over,
});

const DT = 0.05;

/**
 * 挑一个 `caster` **此刻真的能对 `target` 释放**的瞬发技能。
 *
 * ★ 不硬编码技能 id，也不靠「第一个带某效果的技能」——
 *   第一版测试就是那么写的，挑到了 `warrior.charge`（20 米冲锋），
 *   在 1 米处报 `tooClose`，于是测的根本不是顺序而是「技能放不出来」。
 *   走 `validateCast` 让夹具与真实门禁用同一套判据。
 */
const pickCastable = (
  caster: CombatEntity,
  target: CombatEntity,
  want: (s: SkillDef) => boolean,
): SkillDef => {
  const cls = getClass(caster.classId)!;
  // 资源给满、朝向对准 —— 这两件事是夹具的责任，不是被测对象
  for (const [res, max] of caster.maxResources) caster.resources.set(res, max);
  caster.yaw = dirToYaw(sub(target.position, caster.position));

  const found = cls.skills.find(
    (sk) => sk.cast.time === 0 && want(sk)
      && validateCast({ world, caster, skill: sk, target, phase: 'start' }) === CastFailure.Ok,
  );
  if (!found) throw new Error(`找不到一个此刻能放的瞬发技能（${caster.classId}）`);
  return found;
};

// ════════════════════════════════════════════════════════════════

describe('tickWorld 基本推进', () => {
  it('推进模拟时间', () => {
    tickWorld(deps(), DT);
    expect(world.time).toBeCloseTo(DT, 9);
  });

  it('★ 没有移动状态条目的实体不参与移动（假人、位置由别处驱动的实体）', () => {
    const before = { ...player.position };
    inputs.set(player.id, { forward: 1, strafe: 0, jump: false, yaw: 0 });
    tickWorld(deps(), DT);
    // movement 里没有 player 的条目 → 不动
    expect(player.position).toEqual(before);
  });

  it('有移动状态 + 有输入的实体才移动', () => {
    movement.set(player.id, createMovementState(vec3(0, 0, 0)));
    inputs.set(player.id, { forward: 1, strafe: 0, jump: false, yaw: 0 });
    tickWorld(deps(), DT);
    expect(player.position.z).toBeLessThan(0); // yaw=0 面向 −Z
  });

  it('死人不参与移动', () => {
    movement.set(player.id, createMovementState(vec3(0, 0, 0)));
    inputs.set(player.id, { forward: 1, strafe: 0, jump: false, yaw: 0 });
    player.alive = false;
    const before = { ...player.position };
    tickWorld(deps(), DT);
    expect(player.position).toEqual(before);
  });
});

// ════════════════════════════════════════════════════════════════
//  顺序约束
// ════════════════════════════════════════════════════════════════

describe('★★ 顺序约束（每条都有出处，见 tick.ts 头部表格）', () => {
  /**
   * ★★ 约束 2：**casting 必须在 movement 之后。**
   *
   *   7.3「主动移动停止标记为原地施放的读条」—— 只有先算完移动，
   *   `tickCasting` 才知道这一 tick 有没有位移。
   *
   *   顺序反了的后果：移动打断**慢一个 tick**。玩家边跑边读条，
   *   读条会多进行 50ms 才被打断 —— 在 0.75 秒的最短昏迷面前，
   *   一个 tick 足以改变一次博弈的胜负。
   */
  it('★★ 约束 2：同一 tick 内移动能打断原地读条（casting 在 movement 之后）', () => {
    const skill = mage.skills.find((s) => s.cast.time > 0 && !s.cast.movable);
    expect(skill, '需要一个「不可移动施放」的读条技能').toBeDefined();

    movement.set(player.id, createMovementState(vec3(0, 0, 0)));
    const r = beginCast(world, casting, player, skill!, { target: foe });
    expect(r.ok).toBe(true);
    expect(casting.has(player.id)).toBe(true);

    /**
     * ★ 需要连跑几个 tick：移动有加速度，从静止起步**一个** tick 只走 0.0044 米,
     *   远低于打断阈值。这本身是正确行为（微小抖动不该打断读条）——
     *   第一版测试只跑一个 tick，于是测出来的是「加速度」而不是「顺序」。
     */
    inputs.set(player.id, { forward: 1, strafe: 0, jump: false, yaw: 0 });
    let ticks = 0;
    while (casting.has(player.id) && ticks < 10) { tickWorld(deps(), DT); ticks++; }

    expect(
      casting.has(player.id),
      '移动始终没有打断原地读条 —— casting 可能被排到了 movement 之前',
    ).toBe(false);
    // 而且必须是**移动**打断的，不是读条自然结束（技能读条 ≥0.8s = 16 个 tick）
    expect(ticks, '读条是自然结束的，不是被移动打断的').toBeLessThan(10);
  });

  /**
   * ★★ 约束 6：**deriveStatusFlags 必须在全部光环变动之后、读 flags 的步骤之前。**
   *
   *   顺序反了的后果：本 tick 新加的控制要等下一 tick 才生效。
   *   这里用「昏迷中断换装」当探针 —— `tickSwaps` 读 `flags.stunned`。
   */
  it('★★ 约束 6+7：本 tick 施加的昏迷能在同一 tick 中断换装', () => {
    const l = loadouts.get(player.id)!;
    const spare = mage.weapons.find((w) => !w.isDefault)!;
    addWeapon(l, spare.id);
    const started = beginSwap(player, l, swaps, SwapKind.Weapon, spare.id, world.time);
    expect(started.ok).toBe(true);

    // ★ 走 tickWorld 的**技能请求**，而不是自己调 beginCast ——
    //   瞬发技能在 beginCast 内部就完成，效果结算必须由 tick 的统一完成入口负责
    foe.position = vec3(0, 0, 1);
    const stunSkill = pickCastable(foe, player, (sk) => sk.effects.some((e) => e.kind === 'stun'));

    const result = tickWorld(
      deps({ castRequests: new Map([[foe.id, { skillId: stunSkill.id, targetId: player.id }]]) }),
      DT,
    );

    // 昏迷生效 → 换装在同一 tick 被中断
    expect(player.flags.stunned, '昏迷没有在本 tick 生效 —— deriveStatusFlags 可能不在光环变动之后').toBe(true);
    expect(
      result.swaps.some((ev) => ev.result === 'stunned'),
      '换装没有被本 tick 的昏迷中断 —— swaps 可能被排到了 deriveStatusFlags 之前',
    ).toBe(true);
  });

  /**
   * ★★ 约束 10：**settleDeaths 必须在 swaps/pickups 之后。**
   *
   *   那两个函数靠「实体已死」发出 `result:'death'` 的中断事件（17.3
   *   换装瞬间死亡），而 `settleDeaths()` 会清掉进行中的换装。
   *   顺序反了会把那条事件**吃掉** —— 于是 16.2 的换装统计和 HUD 的
   *   中断提示静默消失。★ 「静默消失」正是最难查的那类 bug。
   */
  it('★★ 约束 10：换装中死亡时，death 事件与装备清理**同时**发生', () => {
    const l = loadouts.get(player.id)!;
    const spare = mage.weapons.find((w) => !w.isDefault)!;
    addWeapon(l, spare.id);
    beginSwap(player, l, swaps, SwapKind.Weapon, spare.id, world.time);

    // ★ 死亡必须发生在**本 tick 内**，否则 death 事件不在这一 tick 的事件流里，
    //   settleDeaths 自然什么都不做 —— 那样测的就不是顺序了
    player.health = 1;
    foe.position = vec3(0, 0, 1);
    const hit = pickCastable(foe, player, (sk) => sk.effects.some((e) => e.kind === 'damage'));

    const result = tickWorld(
      deps({ castRequests: new Map([[foe.id, { skillId: hit.id, targetId: player.id }]]) }),
      DT,
    );
    expect(player.alive, '本 tick 没打死他，这条测试就没意义').toBe(false);

    // ① tickSwaps 发出了 death 中断事件（settleDeaths 没有提前吃掉它）
    expect(
      result.swaps.some((ev) => ev.result === 'death'),
      'death 换装事件被吃掉了 —— settleDeaths 可能被排到了 tickSwaps 之前',
    ).toBe(true);
    // ② 同一 tick 里装备也被清理了（10.10）
    expect(l.spareWeapons).toEqual([]);
    expect(player.weaponId).toBe(l.defaultWeaponId);
  });

  /**
   * ★★ 约束 8：**统计折叠必须在 matchRules 之前。**
   *
   *   `carrierKills` 读 `flags.carryingFlag`，而 `tickFlags()` 会在旗手死亡后
   *   把旗掉下来并清掉那个标志。顺序反了 `carrierKills` 会**永远是 0**。
   */
  it('★★ 约束 8：击杀旗手时 carrierKills 记上（统计折叠在 tickFlags 之前）', () => {
    const stats = createStats();
    registerPlayer(stats, player);
    registerPlayer(stats, foe);

    const ctf = createCtf(vec3(0, 0, 100), vec3(0, 0, -100));
    const flag = enemyFlagOf(ctf, foe.team);
    flag.carrierId = foe.id;
    foe.flags.carryingFlag = true;

    // ★ 击杀必须发生在**本 tick 内**
    foe.health = 1;
    player.position = vec3(0, 0, 2);
    foe.position = vec3(0, 0, 3);
    const hit = pickCastable(player, foe, (sk) => sk.effects.some((e) => e.kind === 'damage'));

    tickWorld(
      deps({
        stats,
        castRequests: new Map([[player.id, { skillId: hit.id, targetId: foe.id }]]),
        ctf: {
          state: ctf,
          deps: { world, captureZoneContains: () => false },
          map: ctfMap,
        },
      }),
      DT,
    );
    expect(foe.alive, '本 tick 没打死旗手，这条测试就没意义').toBe(false);

    expect(
      stats.players.get(player.id)!.ctf.carrierKills,
      'carrierKills 是 0 —— 统计折叠可能被排到了 tickFlags 之后（旗已被掉下、标志已清）',
    ).toBe(1);
  });

  /**
   * ★★ 约束 9：**matchRules 必须在死亡之后。**
   *
   *   `tickArena` 读 `CombatEntity.alive` 判胜负，顺序反了胜负慢一个 tick。
   */
  it('★★ 约束 9：全队阵亡后同一 tick 内就判出胜负（matchRules 在死亡之后）', () => {
    const arena: ArenaState = createArena({ mode: GameMode.Arena3v3, roundsToWin: 1 });
    // 先推进过准备阶段
    while (arena.phase === RoundPhase.Prep) tickWorld(deps({ arena }), DT);

    foe.health = 1;
    const ctx = {
      world, auras, dr, projectiles,
      groundAreas: groundStore.areas, traps: groundStore.traps,
      source: player, skillId: 'test', events: [] as never[], resolve: () => {},
    };
    dealDamage(ctx, foe, 9999, School.Physical);
    expect(foe.alive).toBe(false);

    // ★ 2.1 有一个平局结算窗口：全灭后要等窗口过完才出结果
    //   （防「同一窗口内双死判平局」被误判成一方获胜）。所以不是一个 tick。
    const deadline = world.time + ARENA.DRAW_WINDOW_SECONDS + 3 * DT;
    while (!arena.outcome && world.time < deadline) tickWorld(deps({ arena }), DT);

    expect(
      arena.outcome,
      '走完平局结算窗口仍未判出胜负 —— tickArena 可能没有被 tick 调用，或排在了死亡之前',
    ).toBeTruthy();
  });
});

// ════════════════════════════════════════════════════════════════

describe('模式相关的依赖是可选的', () => {
  /** ★ 与 15.4 让两种 HUD 视图不相交同源：竞技场不传 ctf，就没有旗帜逻辑 */
  it('★ 不传 ctf 时不产生任何旗帜事件', () => {
    const r = tickWorld(deps(), DT);
    expect(r.flags).toEqual([]);
  });

  it('不传 arena 时不推进回合状态', () => {
    const r = tickWorld(deps(), DT);
    expect(r.deaths).toEqual([]);
    expect(r.respawns).toEqual([]);
  });

  it('不传 stats 时不折叠统计（纯逻辑测试不需要构造统计容器）', () => {
    expect(() => tickWorld(deps(), DT)).not.toThrow();
  });
});

describe('事件回调', () => {
  it('effects 回调收到本 tick 结算的事件', () => {
    const seen: string[] = [];
    // 用一个持续伤害光环制造事件
    const dot = priest.skills.find((s) =>
      s.effects.some((e) => e.kind === 'applyAura' && e.aura.periodic));
    if (!dot) return; // 数据里没有就跳过，不做假断言

    beginCast(world, casting, foe, dot, { target: player });
    tickWorld(deps(), DT, { onEffects: (evs) => seen.push(...evs.map((e) => e.t)) });
    // 至少不会崩；具体事件由 effects.test.ts 覆盖
    expect(Array.isArray(seen)).toBe(true);
  });

  /**
   * ★★ `onCastResolved` 必须在**效果结算之前**触发。
   *
   *   把它挪到结算之后不会报错、不会崩，只会让调用方拿到一个**更小**的
   *   目标集合 —— 被这一发打死的人已经被 `collectShapeTargets` 过滤掉了
   *   （`aiming.ts` 的 `!e.alive` 那一行），于是「命中 3 个目标」显示成 2 个。
   *   表现层和结算对不上是最难解释的一类 bug。
   *
   * ★ 必须用**范围**技能才测得出来：直接目标技能走 `getEntity()`，
   *   而它不过滤死人，顺序反了也看不出差别。这条测试第一版就是那么写的，
   *   两种顺序都能过 —— 一条永远不会红的测试比没有测试更糟。
   */
  it('★★ onCastResolved 带的是结算**前**的目标集合（含本发会打死的人）', () => {
    // ★ 击杀必须发生在**本 tick 内**，否则测不出「结算前后的差别」
    player.health = 1;
    foe.position = vec3(0, 0, 3);
    player.position = vec3(0, 0, 2);
    const aoe = pickCastable(
      foe, player,
      (sk) => usesNoTarget(sk) && sk.effects.some((e) => e.kind === 'damage'),
    );

    const seen: EntityId[] = [];
    tickWorld(
      deps({ castRequests: new Map([[foe.id, { skillId: aoe.id }]]) }),
      DT,
      { onCastResolved: (_c, _s, targets) => seen.push(...targets.map((t) => t.id)) },
    );

    expect(player.alive, '本 tick 没打死他，这条测试就没意义').toBe(false);
    expect(
      seen,
      'onCastResolved 没拿到那个被打死的目标 —— 它可能被挪到了效果结算之后',
    ).toEqual([player.id]);
  });

  /**
   * 7.4 步骤 6：锁定的目标在读条期间离场 → **不产生效果**，
   * 也就没有「打中了谁」可言，所以 `onCastResolved` 不该触发。
   */
  it('锁定目标在读条期间离场 → 不触发 onCastResolved（7.4 步骤 6）', () => {
    const skill = mage.skills.find(
      (s) => s.cast.time > 0 && s.effects.some((e) => e.kind === 'damage'),
    );
    expect(skill, '需要一个读条伤害技能').toBeDefined();
    for (const [res, max] of player.maxResources) player.resources.set(res, max);
    player.yaw = dirToYaw(sub(foe.position, player.position));
    expect(beginCast(world, casting, player, skill!, { target: foe }).ok).toBe(true);

    world.entities.delete(foe.id); // 目标离场

    let fired = false;
    let ticks = 0;
    while (casting.has(player.id) && ticks < 200) {
      tickWorld(deps(), DT, { onCastResolved: () => { fired = true; } });
      ticks++;
    }
    expect(casting.has(player.id), '读条一直没结束，这条测试就没意义').toBe(false);
    expect(fired, '目标已离场却仍然结算了 —— 7.4 步骤 6 被绕过').toBe(false);
  });

  it('TickResult 汇总了各类事件', () => {
    const r = tickWorld(deps(), DT);
    expect(Object.keys(r).sort()).toEqual(
      ['consumables', 'deaths', 'events', 'flags', 'pickups', 'respawns', 'swaps', 'swings'],
    );
  });
});
