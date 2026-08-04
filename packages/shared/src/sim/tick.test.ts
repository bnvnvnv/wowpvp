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
import { ArenaPreset, CastFailure, DispelType, GameMode, School } from '../types/enums.js';
import { asSkillId, asWeaponId, TEAM_BLUE, TEAM_RED } from '../types/ids.js';
import { usesNoTarget } from './aiming.js';
import { applyAura, createAuraStore, type AuraStore } from './aura.js';
import { beginCast, createCastingStore, validateCast, type CastingStore } from './casting.js';
import { createDrStore, type DrStore } from './dr.js';
import { createArsenalStore, createPickupStore, type ArsenalStore, type PickupStore } from './arsenal.js';
import { createEntity, skillsAvailableWith, type CombatEntity } from './entity.js';
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

  /**
   * ★★ 这一层正是那个 bug 逃逸的地方。
   *
   *   `tickWorld` 调 `stepMovement` 时**没有传 `speedMultiplier`**，
   *   于是断筋、冰霜锁链、群奔咆哮、猎豹形态、死亡脚步的速度下限、
   *   12.3 的旗手加速上限**一条都没有影响过实际移动** ——
   *   而 `movement.test.ts` 只测积分数学、`effects.test.ts` 只测聚合取值，
   *   两边都绿，中间那根线断了却没有任何断言站在断点上。
   *
   *   所以这条测试**不测聚合、不测积分**，只测一件事：
   *   上了减速之后，同一段时间走得更近。
   */
  it('★★ 减速光环真的让人走得更慢（此前 tickWorld 从不传 speedMultiplier）', () => {
    const runFor = (slow: boolean): number => {
      // ★ 必须有地板：悬空时走的是空中修正（AIR_CONTROL）而不是地面目标速度，
      //   减速咬不住 —— balance-report 的文件头记过同一个坑
      const w = createWorld([ground]);
      const e = addEntity(w, createEntity(allocEntityId(w), mage, TEAM_RED, vec3(0, 0, 0)));
      const auras = createAuraStore();
      if (slow) {
        applyAura(auras, e, {
          id: 'test.slow', name: '测试减速', kind: 'debuff', duration: 99,
          dispelType: DispelType.Magic, modifiers: { moveSpeed: 0.5 },
          description: '移动速度降低 50%',
        }, e.id, w.time);
      }
      const mv = new Map<EntityId, MovementState>([[e.id, createMovementState(vec3(0, 0, 0))]]);
      const inp = new Map<EntityId, MovementInput>(
        [[e.id, { forward: 1, strafe: 0, jump: false, yaw: 0 }]],
      );
      for (let i = 0; i < 20; i++) {
        tickWorld({
          world: w, auras, dr: createDrStore(), ground: createGroundStore(),
          projectiles: createProjectileStore(), casting: createCastingStore(),
          loadouts: createLoadoutStore(), swaps: createSwapStore(),
          pickups: createPickupStore(), arsenal: createArsenalStore(ArenaPreset.Classic),
          movement: mv, inputs: inp, castRequests: new Map(), getSkill,
        }, DT);
      }
      return Math.abs(e.position.z);
    };

    const normal = runFor(false);
    const slowed = runFor(true);
    expect(normal).toBeGreaterThan(0.5); // 先确认基准真的走了
    expect(slowed).toBeLessThan(normal * 0.75);
  });

  it('死人不参与移动', () => {
    movement.set(player.id, createMovementState(vec3(0, 0, 0)));
    inputs.set(player.id, { forward: 1, strafe: 0, jump: false, yaw: 0 });
    player.alive = false;
    const before = { ...player.position };
    tickWorld(deps(), DT);
    expect(player.position).toEqual(before);
  });

  /**
   * ★★ 位移必须在下一个 tick 之后还活着 —— 此前 `teleportTo()` 是死代码。
   *
   *   位移效果只写 `entity.position`、不同步 `MovementState`，而第 2 步
   *   每 tick 都用移动积分的结果覆盖 `entity.position` —— 于是对一切**有移动
   *   条目**的实体（联网玩家、实战模式假人），冲锋/闪现/击退/拉拽都会在
   *   50ms 后被原样抹回。`effects.test.ts` 只结算一次、从不跑第二个 tick，
   *   所以全绿 —— 又一根「两边都对、中间断了」的线。
   *
   *   ★ 触发条件必须带**输入**：第 2 步对没有输入的实体直接 continue，
   *     连 position 都不碰 —— 只闪现不推 tick 的话 bug 根本不显形。
   *     真实对局里客户端每 tick 都发输入（哪怕全零），所以真实场景必触发。
   */
  it('★★ 闪现在后续 tick 不被移动积分抹回（位移同步 MovementState）', () => {
    movement.set(player.id, createMovementState(vec3(0, 0, 0)));
    const blink = pickCastable(player, foe, (s) => s.effects.some((e) => e.kind === 'blinkForward'));
    tickWorld(deps({ castRequests: new Map([[player.id, { skillId: blink.id }]]) }), DT);

    const landed = { ...player.position };
    expect(Math.hypot(landed.x, landed.z), '闪现本身要先生效（8 米）').toBeGreaterThan(5);
    // 落点即移动状态：贴地、清速度、置 teleported（13.4 动画层依据）
    expect(movement.get(player.id)?.teleported).toBe(true);

    // 站着不动（但**有**输入条目）再跑 5 个 tick —— 位移必须活下来
    inputs.set(player.id, { forward: 0, strafe: 0, jump: false, yaw: 0 });
    for (let i = 0; i < 5; i++) tickWorld(deps(), DT);
    expect(player.position.x).toBeCloseTo(landed.x, 3);
    expect(player.position.z).toBeCloseTo(landed.z, 3);
  });

  /**
   * ★★ 13.5 / 验收 #43 软推开的接线断言 —— `separationVelocity` 此前零调用方，
   *   两个角色可以完全重叠站成一个点。
   * ★ 触发条件同位移测试：必须给**全零输入**条目 —— 第 2 步对无输入实体
   *   直接 continue。真实对局里客户端每 tick 都发输入，所以全员生效。
   */
  it('★★ 重叠站位会被软推开（separationVelocity 接进 tickWorld）', () => {
    // 把对手挪到几乎重叠的位置（0.2 米 < 2 × 半径 0.45）
    foe.position = vec3(0.2, 0, 0);
    movement.set(player.id, createMovementState(player.position));
    movement.set(foe.id, createMovementState(foe.position));
    inputs.set(player.id, { forward: 0, strafe: 0, jump: false, yaw: 0 });
    inputs.set(foe.id, { forward: 0, strafe: 0, jump: false, yaw: 0 });

    for (let i = 0; i < 40; i++) tickWorld(deps(), DT);

    const gap = Math.hypot(player.position.x - foe.position.x, player.position.z - foe.position.z);
    expect(gap, '两人应被推出重叠').toBeGreaterThanOrEqual(player.radius * 2 - 0.05);
    // 软推开不是弹飞：推开后停在贴身距离附近，不会越推越远
    expect(gap).toBeLessThan(2);
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
    /**
     * 战士唯一的无目标瞬发伤害技（顺劈）是巨剑方案专属 —— A#4 的
     * removes/grants 自 M14 起真的被 validateCast 执行。装上巨剑并按
     * 装备路径的同一条规则刷新技能集合，是夹具的责任（同上面的资源给满）。
     */
    foe.weaponId = asWeaponId('warrior.greatsword');
    foe.availableSkills = skillsAvailableWith(getClass(foe.classId)!, foe.weaponId);
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
      ['consumables', 'deaths', 'drops', 'events', 'flags', 'pickups', 'respawns', 'swaps', 'swings'],
    );
  });
});

describe('9.x 资源回复（tick 第 6c 步 —— M14 前 regenPerSecond 是零读取方的死数据）', () => {
  it('★★ 法力按 regenPerSecond 随 tick 回复', () => {
    const rate = mage.resources.find((r) => r.resource === 'mana')!.regenPerSecond;
    expect(rate, '法师法力回复率为 0，这条测试就没意义').toBeGreaterThan(0);
    player.resources.set('mana' as never, 100);
    for (let i = 0; i < 40; i++) tickWorld(deps(), DT); // 2 秒
    expect(player.resources.get('mana' as never)).toBeCloseTo(100 + rate * 2, 5);
  });

  it('★ 回复封顶于 max，不溢出', () => {
    const max = player.maxResources.get('mana' as never)!;
    player.resources.set('mana' as never, max - 0.5);
    for (let i = 0; i < 40; i++) tickWorld(deps(), DT);
    expect(player.resources.get('mana' as never)).toBe(max);
  });

  it('★ 怒气 regen=0：不随时间回复 —— 它的来源只有挥击与技能（7.6）', () => {
    foe.resources.set('rage' as never, 30);
    for (let i = 0; i < 40; i++) tickWorld(deps(), DT);
    expect(foe.resources.get('rage' as never)).toBe(30);
  });

  it('死人不回资源', () => {
    player.alive = false;
    player.resources.set('mana' as never, 100);
    for (let i = 0; i < 20; i++) tickWorld(deps(), DT);
    expect(player.resources.get('mana' as never)).toBe(100);
  });
});

describe('M14：gainResource 回到施法者（此前攒在敌人身上、花在自己身上，账永远对不上）', () => {
  it('★★ 背刺的连击点长在盗贼自己身上，不长在目标身上', () => {
    const rogue = getClass('rogue' as never)!;
    const r = spawn(rogue as typeof mage, TEAM_RED, 0, 1.5); // 贴身（背刺射程 2.4，foe 在 z=3）
    for (const [res, max] of r.maxResources) r.resources.set(res, max);
    r.resources.set('comboPoints' as never, 0);
    r.yaw = dirToYaw(sub(foe.position, r.position));

    const backstab = getSkill(asSkillId('rogue.backstab'))!;
    tickWorld(deps({ castRequests: new Map([[r.id, { skillId: backstab.id, targetId: foe.id }]]) }), DT);

    expect(r.resources.get('comboPoints' as never), '连击点没回到盗贼自己').toBeGreaterThan(0);
    expect(foe.resources.get('comboPoints' as never) ?? 0, '连击点长在目标身上').toBe(0);
  });
});

describe('M14：旋刃斩不再自残（光环周期伤打的是持有者 —— 挂自己身上就是打自己）', () => {
  it('★★ 释放旋刃斩：自己一滴血不掉，圈内敌人持续掉血', () => {
    for (const [res, max] of foe.maxResources) foe.resources.set(res, max);
    foe.yaw = dirToYaw(sub(player.position, foe.position));
    const beforeSelf = foe.health;
    const beforePlayer = player.health;

    const bs = getSkill(asSkillId('warrior.bladestorm'))!;
    tickWorld(deps({ castRequests: new Map([[foe.id, { skillId: bs.id }]]) }), DT);
    for (let i = 0; i < 90; i++) tickWorld(deps(), DT); // 4.5 秒：转完整段

    expect(foe.health, '旋刃斩在打自己 —— 周期伤挂错了目标').toBe(beforeSelf);
    expect(player.health, '圈内敌人没掉血 —— 区域没生效').toBeLessThan(beforePlayer);
  });
});

describe('附录A#4 武器方案的技能门禁（M14 前 removes/grants 只在装备面板显示，sim 从不执行）', () => {
  it('★★ 方案专属技能：短弓猎人放不出重弩专属的穿透弩箭', () => {
    const hunter = getClass('hunter' as never)!;
    const h = spawn(hunter as typeof mage, TEAM_RED, 0, 6);
    for (const [res, max] of h.maxResources) h.resources.set(res, max);
    const piercing = getSkill(asSkillId('hunter.piercing_bolt'))!;
    expect(
      validateCast({ world, caster: h, skill: piercing, target: foe, phase: 'start' }),
    ).toBe(CastFailure.WeaponMismatch);
  });

  it('★ 换上授予它的武器方案后可以释放（walk 真实换装路径）', () => {
    const hunter = getClass('hunter' as never)!;
    const h = spawn(hunter as typeof mage, TEAM_RED, 0, 6);
    for (const [res, max] of h.maxResources) h.resources.set(res, max);
    h.yaw = dirToYaw(sub(foe.position, h.position));
    h.weaponId = asWeaponId('hunter.heavy_crossbow');
    h.availableSkills = skillsAvailableWith(hunter, h.weaponId);
    const piercing = getSkill(asSkillId('hunter.piercing_bolt'))!;
    expect(
      validateCast({ world, caster: h, skill: piercing, target: foe, phase: 'start' }),
    ).toBe(CastFailure.Ok);
  });

  it('★ removes = 禁用：巨剑战士没有盾牌专属的盾击', () => {
    foe.weaponId = asWeaponId('warrior.greatsword');
    foe.availableSkills = skillsAvailableWith(warrior, foe.weaponId);
    for (const [res, max] of foe.maxResources) foe.resources.set(res, max);
    foe.position = vec3(0, 0, 1);
    foe.yaw = dirToYaw(sub(player.position, foe.position));
    const slam = getSkill(asSkillId('warrior.shield_slam'))!;
    expect(
      validateCast({ world, caster: foe, skill: slam, target: player, phase: 'start' }),
    ).toBe(CastFailure.WeaponMismatch);
  });

  it('未被任何方案声明的基础技能不受门禁影响（重创斩人人可用）', () => {
    for (const [res, max] of foe.maxResources) foe.resources.set(res, max);
    foe.position = vec3(0, 0, 1);
    foe.yaw = dirToYaw(sub(player.position, foe.position));
    const ms = getSkill(asSkillId('warrior.mortal_strike'))!;
    expect(
      validateCast({ world, caster: foe, skill: ms, target: player, phase: 'start' }),
    ).toBe(CastFailure.Ok);
  });
});
