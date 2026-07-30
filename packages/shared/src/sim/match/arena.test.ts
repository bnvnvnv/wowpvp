/**
 * 竞技场回合与战斗抑制测试。
 * 对应规格书 2.1 / 8.5 / 11.1 / 11.4 与验收 #25 / #26 / #27 / #37。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ARENA, DAMPENING } from '../../constants/combat.js';
import { hunter, mage, priest, warrior } from '../../data/index.js';
import { box } from '../../data/maps/schema.js';
import { vec3 } from '../../math/vec3.js';
import { DispelType, GameMode, Resource, School } from '../../types/enums.js';
import { TEAM_BLUE, TEAM_RED } from '../../types/ids.js';
import { aurasOf, createAuraStore, type AuraStore } from '../aura.js';
import { applyDr, createDrStore, drFactor, type DrStore } from '../dr.js';
import { createEntity, type CombatEntity } from '../entity.js';
import { createGroundStore, type GroundStore } from '../groundArea.js';
import { createProjectileStore } from '../projectile.js';
import { dealDamage, resolveEffects, type CombatEvent } from '../effects/index.js';
import { addEntity, allocEntityId, createWorld, type World } from '../world.js';
import {
  RoundPhase,
  SUDDEN_DEATH_HARD_CAP,
  aliveCount,
  createArena,
  matchWinner,
  resetRound,
  startNextRound,
  teamSizeOf,
  teamWiped,
  tickArena,
  type ArenaDeps,
  type ArenaState,
} from './arena.js';
import { SUDDEN_DEATH, approximatePosition, dampeningAt } from './dampening.js';
import { DrCategory } from '../../types/enums.js';

const ground = box('g', 'floor', { x: 0, y: -1, z: 0 }, { w: 400, h: 1, d: 400 });

let world: World;
let auras: AuraStore;
let dr: DrStore;
let groundStore: GroundStore;
let deps: ArenaDeps;
let arena: ArenaState;

const spawn = (cls: typeof mage, team: typeof TEAM_RED, opts: { isPet?: boolean } = {}) =>
  addEntity(
    world,
    createEntity(allocEntityId(world), cls, team, vec3(0, 0, 0), { isPet: opts.isPet }),
  );

beforeEach(() => {
  world = createWorld([ground]);
  auras = createAuraStore();
  dr = createDrStore();
  groundStore = createGroundStore();
  deps = { world, auras, dr, ground: groundStore };
  arena = createArena({ mode: GameMode.Arena3v3, roundsToWin: 1 });
});

/** 推进 seconds 秒 */
const advance = (seconds: number, step = 0.1, events = {}) => {
  const target = arena.phaseElapsed + seconds;
  let guard = 0;
  while (arena.phaseElapsed < target && guard++ < 100000) {
    tickArena(arena, deps, step, events);
  }
};

/** 直接跳到战斗阶段 */
const enterCombat = () => {
  advance(ARENA.PREP_SECONDS + 0.2);
  expect(arena.phase).toBe(RoundPhase.Combat);
};

describe('11.1 回合流程', () => {
  it('从准备阶段开始', () => {
    expect(arena.phase).toBe(RoundPhase.Prep);
  });

  it('准备时间结束后开门进入战斗（11.1：15–20 秒）', () => {
    expect(ARENA.PREP_SECONDS).toBeGreaterThanOrEqual(15);
    expect(ARENA.PREP_SECONDS).toBeLessThanOrEqual(20);
    advance(ARENA.PREP_SECONDS - 1);
    expect(arena.phase).toBe(RoundPhase.Prep);
    advance(2);
    expect(arena.phase).toBe(RoundPhase.Combat);
  });

  it('阶段变化会发出事件', () => {
    const seen: string[] = [];
    advance(ARENA.PREP_SECONDS + 0.2, 0.1, { onPhaseChange: (_f: string, t: string) => seen.push(t) });
    expect(seen).toContain(RoundPhase.Combat);
  });
});

describe('2.1 / 验收 #25 存活统计', () => {
  it('★ 宠物不计入存活人数', () => {
    spawn(hunter, TEAM_RED);
    const pet = spawn(hunter, TEAM_RED, { isPet: true });

    expect(aliveCount(world, TEAM_RED)).toBe(1);
    // 玩家死了、宠物还活着 → 该队算全灭
    world.entities.get(pet.id)!.alive = true;
    for (const e of world.entities.values()) if (!e.isPet) e.alive = false;
    expect(teamWiped(world, TEAM_RED)).toBe(true);
  });

  it('★ 11.4：只有最终死亡才减少存活人数，「不能行动但活着」不算', () => {
    const m = spawn(mage, TEAM_RED);
    // 寒冰屏障：完全免疫 + 无法行动，但 alive 仍为 true
    m.flags.immuneAll = true;
    m.flags.stunned = true;
    expect(aliveCount(world, TEAM_RED)).toBe(1);
    expect(teamWiped(world, TEAM_RED)).toBe(false);
  });
});

describe('2.1 / 验收 #26 胜负与平局判定', () => {
  it('一方全灭后另一方获胜', () => {
    spawn(warrior, TEAM_RED);
    const blue = spawn(mage, TEAM_BLUE);
    enterCombat();

    blue.alive = false;
    advance(ARENA.DRAW_WINDOW_SECONDS + 0.3);
    expect(arena.phase).toBe(RoundPhase.Resolved);
    expect(arena.outcome).toEqual({ winner: TEAM_RED });
  });

  it('★ 双方最后一人在同一结算窗口内死亡 → 平局', () => {
    const red = spawn(warrior, TEAM_RED);
    const blue = spawn(mage, TEAM_BLUE);
    enterCombat();

    blue.alive = false;
    tickArena(arena, deps, 0.1); // 记下窗口起点，但还没判负
    expect(arena.phase).toBe(RoundPhase.Combat);

    red.alive = false; // 窗口内红方也全灭
    tickArena(arena, deps, 0.1);
    expect(arena.outcome).toEqual({ winner: 'draw' });
  });

  it('★ 窗口过完之后另一方才死 → 不是平局，先全灭的一方判负', () => {
    const red = spawn(warrior, TEAM_RED);
    const blue = spawn(mage, TEAM_BLUE);
    enterCombat();

    blue.alive = false;
    advance(ARENA.DRAW_WINDOW_SECONDS + 0.3);
    expect(arena.outcome).toEqual({ winner: TEAM_RED });

    // 之后红方也死也不改变已判定的结果
    red.alive = false;
    tickArena(arena, deps, 0.1);
    expect(arena.outcome).toEqual({ winner: TEAM_RED });
  });

  it('中途有人复活（不该发生，但要健壮）时取消待判', () => {
    const red = spawn(warrior, TEAM_RED);
    const blue = spawn(mage, TEAM_BLUE);
    enterCombat();

    blue.alive = false;
    tickArena(arena, deps, 0.1);
    expect(arena.wipePendingSince).not.toBeNull();

    blue.alive = true;
    tickArena(arena, deps, 0.1);
    expect(arena.wipePendingSince).toBeNull();
    expect(arena.phase).toBe(RoundPhase.Combat);
    expect(red).toBeDefined();
  });

  it('多回合赛：赢够回合数才结束比赛', () => {
    arena = createArena({ mode: GameMode.Arena3v3, roundsToWin: 2 });
    spawn(warrior, TEAM_RED);
    const blue = spawn(mage, TEAM_BLUE);

    let matchEnded: number | null = null;
    const events = { onMatchEnd: (w: number) => { matchEnded = w; } };

    enterCombat();
    blue.alive = false;
    advance(ARENA.DRAW_WINDOW_SECONDS + 0.3, 0.1, events);
    expect(arena.score[String(TEAM_RED)]).toBe(1);
    expect(matchEnded).toBeNull();
    expect(matchWinner(arena)).toBeNull();

    startNextRound(arena, deps);
    expect(arena.round).toBe(2);
    enterCombat();
    blue.alive = false;
    advance(ARENA.DRAW_WINDOW_SECONDS + 0.3, 0.1, events);
    expect(matchEnded).toBe(TEAM_RED);
    expect(matchWinner(arena)).toBe(TEAM_RED);
  });
});

describe('8.5 战斗抑制曲线', () => {
  it('各模式的起始时间：2v2 60s / 3v3 90s / 5v5 120s', () => {
    expect(DAMPENING.START_SECONDS[GameMode.Arena2v2]).toBe(60);
    expect(DAMPENING.START_SECONDS[GameMode.Arena3v3]).toBe(90);
    expect(DAMPENING.START_SECONDS[GameMode.Arena5v5]).toBe(120);
  });

  it('★ 起始前不抑制，起始时 10%，之后每 30 秒 +5%', () => {
    const d = 300; // 常规时长，避开决胜阶段
    expect(dampeningAt(GameMode.Arena2v2, 59, d).amount).toBe(0);
    expect(dampeningAt(GameMode.Arena2v2, 60, d).amount).toBeCloseTo(0.1);
    expect(dampeningAt(GameMode.Arena2v2, 89, d).amount).toBeCloseTo(0.1);
    expect(dampeningAt(GameMode.Arena2v2, 90, d).amount).toBeCloseTo(0.15);
    expect(dampeningAt(GameMode.Arena2v2, 120, d).amount).toBeCloseTo(0.2);
  });

  it('抑制有上限，不会把治疗压到 0', () => {
    const v = dampeningAt(GameMode.Arena2v2, 10000, 300).amount;
    expect(v).toBeLessThanOrEqual(DAMPENING.MAX);
  });

  it('夺旗模式没有战斗抑制（8.5 只规定竞技场）', () => {
    expect(dampeningAt(GameMode.Ctf6v6, 600, 720).amount).toBe(0);
  });

  it('起始前给出倒计时，供 HUD 显示（15.4）', () => {
    expect(dampeningAt(GameMode.Arena3v3, 30, 360).startsIn).toBe(60);
    expect(dampeningAt(GameMode.Arena3v3, 120, 360).startsIn).toBe(0);
  });
});

describe('8.5 / 验收 #27 决胜阶段', () => {
  it('常规时间结束后进入决胜阶段', () => {
    const d = 360;
    expect(dampeningAt(GameMode.Arena3v3, 359, d).suddenDeath).toBe(false);
    expect(dampeningAt(GameMode.Arena3v3, 360, d).suddenDeath).toBe(true);
  });

  it('★ 决胜阶段抑制加速', () => {
    const d = 360;
    const before = dampeningAt(GameMode.Arena3v3, 360, d).amount;
    const after30 = dampeningAt(GameMode.Arena3v3, 390, d).amount;
    // 常规阶段 30 秒涨 5%，决胜阶段应当明显更快
    expect(after30 - before).toBeGreaterThan(DAMPENING.STEP_AMOUNT * 1.5);
  });

  it('★ 决胜阶段逐步加入压迫伤害', () => {
    const d = 360;
    expect(dampeningAt(GameMode.Arena3v3, 359, d).pressureDamagePerSecond).toBe(0);
    const p0 = dampeningAt(GameMode.Arena3v3, 360, d).pressureDamagePerSecond;
    const p30 = dampeningAt(GameMode.Arena3v3, 390, d).pressureDamagePerSecond;
    expect(p0).toBeGreaterThan(0);
    expect(p30).toBeGreaterThan(p0); // 「逐步加入」
    expect(dampeningAt(GameMode.Arena3v3, 9999, d).pressureDamagePerSecond)
      .toBeLessThanOrEqual(SUDDEN_DEATH.PRESSURE_MAX);
  });

  it('压迫伤害通过事件交给调用方结算（必须 bypassImmunity）', () => {
    arena = createArena({ mode: GameMode.Arena3v3, roundsToWin: 1, duration: 5 });
    spawn(warrior, TEAM_RED);
    spawn(mage, TEAM_BLUE);
    enterCombat();

    let total = 0;
    advance(10, 0.1, { onPressureDamage: (a: number) => { total += a; } });
    expect(total).toBeGreaterThan(0);
  });

  it('★ 压迫伤害真的能穿透完全免疫（验收 #27）', () => {
    const target = spawn(mage, TEAM_BLUE);
    const source = spawn(warrior, TEAM_RED);
    // 给目标挂完全免疫
    resolveEffects(
      {
        world, auras, dr, projectiles: createProjectileStore(), ground: groundStore,
        source, skillId: 'test',
      },
      [{
        kind: 'applyAura', target: 'target',
        aura: {
          id: 'test.immunity', name: '完全免疫', kind: 'buff', duration: 10,
          dispelType: DispelType.None, flags: { immuneAll: true }, description: '',
        },
      }],
      [target],
    );
    target.flags.immuneAll = true;

    const before = target.health;
    // 普通伤害被完全免疫挡住
    resolveEffects(
      { world, auras, dr, projectiles: createProjectileStore(), ground: groundStore, source, skillId: 'x' },
      [{ kind: 'damage', school: School.Fire, amount: { flat: 200 } }], [target],
    );
    expect(target.health).toBe(before);

    // ★ 压迫伤害带 bypassImmunity 就能打进去 —— 8.5 明确要求它「不可完全免疫」，
    //   否则圣盾术/寒冰屏障能把决胜阶段无限拖下去
    const ctx = {
      world, auras, dr, projectiles: createProjectileStore(),
      groundAreas: groundStore.areas, traps: groundStore.traps,
      source, skillId: 'arena.pressure', events: [] as CombatEvent[],
      resolve: () => {},
    };
    dealDamage(ctx, target, 200, School.Physical, { bypassImmunity: true });
    // 目标是法师，双手法杖的代价是 damageTaken 1.08 → 200 × 1.08 = 216。
    // ★ bypassImmunity 绕开的是**免疫**，不是全部承伤修正 ——
    //   8.5 只要求压迫伤害「不可完全免疫」，没说它无视装备。
    expect(target.health).toBe(before - Math.round(200 * 1.08));
  });

  it('决胜阶段有硬上限兜底，不会无限拖下去', () => {
    arena = createArena({ mode: GameMode.Arena3v3, roundsToWin: 1, duration: 5 });
    spawn(warrior, TEAM_RED);
    spawn(mage, TEAM_BLUE);
    enterCombat();
    advance(5 + SUDDEN_DEATH_HARD_CAP + 1);
    expect(arena.phase).toBe(RoundPhase.Resolved);
    expect(arena.outcome).toEqual({ winner: 'draw' });
  });

  it('8.5 决胜阶段只暴露「大致位置」，不是精确坐标', () => {
    expect(approximatePosition({ x: 12.3, z: -7.8 })).toEqual({ x: 10, z: -10 });
  });
});

describe('2.1 / 验收 #37 回合重置', () => {
  it('★ 恢复生命、资源、冷却、清除全部旁挂状态', () => {
    const e = spawn(mage, TEAM_RED);
    e.health = 10;
    e.alive = false;
    e.cooldowns.set('x' as never, 999);
    e.gcdUntil = 999;
    e.schoolLocks.set(School.Fire, 999);
    e.resources.set(Resource.Mana, 0);

    // 挂上光环、递减、地面区域
    resolveEffects(
      {
        world, auras, dr, projectiles: createProjectileStore(), ground: groundStore,
        source: e, skillId: 'test',
      },
      [{ kind: 'applyAura', target: 'target', aura: {
        id: 'test.buff', name: 'x', kind: 'buff', duration: 100,
        dispelType: DispelType.Magic, description: '',
      } }],
      [e],
    );
    applyDr(dr, e.id, DrCategory.Stun, 4, 0);
    groundStore.areas.push({
      id: 1, areaId: 'x', skillId: 'x', sourceId: e.id, center: vec3(0, 0, 0),
      radius: 5, createdAt: 0, expiresAt: 1000, tickInterval: 0, nextTickAt: Infinity,
      onTick: [], blocksTargetingFromOutside: false, revealsStealth: false,
    });

    resetRound(arena, deps);

    expect(e.alive).toBe(true);
    expect(e.health).toBe(e.maxHealth);
    expect(e.cooldowns.size).toBe(0);
    expect(e.gcdUntil).toBe(0);
    expect(e.schoolLocks.size).toBe(0);
    expect(e.resources.get(Resource.Mana)).toBe(e.maxResources.get(Resource.Mana));
    expect(aurasOf(auras, e.id)).toHaveLength(0);
    expect(drFactor(dr, e.id, DrCategory.Stun, 1)).toBe(1);
    expect(groundStore.areas).toHaveLength(0);
    expect(arena.phase).toBe(RoundPhase.Prep);
  });

  it('★ 怒气/连击点回合开始为 0，法力/能量为满（9.x）', () => {
    const w = spawn(warrior, TEAM_RED);
    const m = spawn(mage, TEAM_RED);
    w.resources.set(Resource.Rage, 80);
    m.resources.set(Resource.Mana, 5);

    resetRound(arena, deps);

    expect(w.resources.get(Resource.Rage)).toBe(0);
    expect(m.resources.get(Resource.Mana)).toBe(m.maxResources.get(Resource.Mana));
  });

  it('目标槽位也要清 —— 否则上回合的硬目标会渗进新回合', () => {
    const a = spawn(mage, TEAM_RED);
    const b = spawn(priest, TEAM_BLUE);
    a.targets.hard = b.id;
    resetRound(arena, deps);
    expect(a.targets.hard).toBeUndefined();
  });
});

describe('3.2 / 验收 #22 自由职业选择', () => {
  it('全队同职业也允许', () => {
    for (let i = 0; i < 3; i++) spawn(mage, TEAM_RED);
    for (let i = 0; i < 3; i++) spawn(mage, TEAM_BLUE);
    expect(aliveCount(world, TEAM_RED)).toBe(3);
    expect(aliveCount(world, TEAM_BLUE)).toBe(3);
  });

  it('各模式每队人数与规格书一致', () => {
    expect(teamSizeOf(GameMode.Arena2v2)).toBe(2);
    expect(teamSizeOf(GameMode.Arena3v3)).toBe(3);
    expect(teamSizeOf(GameMode.Arena5v5)).toBe(5);
    expect(teamSizeOf(GameMode.Ctf12v12)).toBe(12);
  });
});
