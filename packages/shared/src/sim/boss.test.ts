/**
 * 随机大 BOSS 的规则（`sim/boss.ts`）。
 *
 * ★ 钉的是**规则形状**，不是具体数值：刷新节奏、赏金、伤害都是占位值，
 *   调平衡不该红测试。会红的只有「同时最多一只」「死了才排下一只」
 *   「不进任何名单」这类**不变量**。
 */

import { describe, expect, it } from 'vitest';
import { arena2v2 } from '../data/maps/index.js';
import { ArenaPreset } from '../types/enums.js';
import { TEAM_NEUTRAL, TEAM_RED, asClassId, asEntityId } from '../types/ids.js';
import { getClass, isPlayableClass } from '../data/index.js';
import { createArsenalStore } from './arsenal.js';
import { createAuraStore, aurasOf } from './aura.js';
import { createEntity } from './entity.js';
import type { MovementState } from './movement.js';
import { createStats, ingestCombatEvents, registerPlayer } from './stats.js';
import { addEntity, allocEntityId, createWorld, type World } from './world.js';
import type { EntityId } from '../types/ids.js';
import type { CombatEvent } from './effects/registry.js';
import {
  BOSS, bossSpawnDue, bossSpawnSites, createBossState, isBossEntity,
  nextBossSite, secondsToNextBoss, tickBoss, type BossDeps,
} from './boss.js';

const MAP = arena2v2;

const rig = (preset: ArenaPreset = ArenaPreset.Armed) => {
  const world: World = createWorld(MAP.geometry);
  const movement = new Map<EntityId, MovementState>();
  const deps: BossDeps = {
    world,
    movement,
    auras: createAuraStore(),
    arsenal: createArsenalStore(preset),
  };
  const state = createBossState(MAP, 0);
  return { deps, state, world, movement };
};

/** 放一个真人进世界 —— 战利品按「场上实际存在的职业池」刷，得有人在场 */
const addPlayer = (world: World, classId = 'warrior') => {
  const cls = getClass(asClassId(classId))!;
  const e = addEntity(
    world,
    createEntity(allocEntityId(world), cls, TEAM_RED, { x: 3, y: 0, z: 0 }, { name: '玩家' }),
  );
  return e;
};

describe('BOSS 刷新调度（纯函数）', () => {
  it('开局不立刻刷：要等 FIRST_SPAWN_SECONDS', () => {
    const s = createBossState(MAP, 0);
    expect(bossSpawnDue(s, 0)).toBe(false);
    expect(bossSpawnDue(s, BOSS.FIRST_SPAWN_SECONDS - 0.05)).toBe(false);
    expect(bossSpawnDue(s, BOSS.FIRST_SPAWN_SECONDS)).toBe(true);
  });

  it('★ 同时最多一只：场上有 BOSS 时永远不到刷新条件', () => {
    const s = createBossState(MAP, 0);
    s.activeId = asEntityId(7);
    expect(bossSpawnDue(s, BOSS.FIRST_SPAWN_SECONDS * 10)).toBe(false);
    expect(secondsToNextBoss(s, 0)).toBeUndefined();
  });

  it('刷新点按已刷数量轮转，且左右/前后对称（争夺目标不能偏向一方）', () => {
    const sites = bossSpawnSites(MAP);
    expect(sites.length).toBeGreaterThan(1);
    // 中心点 + 成对的 ±X / ±Z（11.3：双方到达距离必须大体相等）
    const xs = sites.map((p) => p.x).sort((a, b) => a - b);
    const zs = sites.map((p) => p.z).sort((a, b) => a - b);
    expect(xs[0]! + xs[xs.length - 1]!).toBeCloseTo(0, 6);
    expect(zs[0]! + zs[zs.length - 1]!).toBeCloseTo(0, 6);

    const s = createBossState(MAP, 0);
    expect(nextBossSite(s)).toEqual(sites[0]);
    s.spawned = 1;
    expect(nextBossSite(s)).toEqual(sites[1]);
    s.spawned = sites.length; // 用完一圈回到第一个
    expect(nextBossSite(s)).toEqual(sites[0]);
  });

  it('★ 刷新点不是随机数：同一份状态算两次结果逐位相同（回放/配平复现）', () => {
    const a = createBossState(MAP, 0);
    const b = createBossState(MAP, 0);
    a.spawned = 3;
    b.spawned = 3;
    expect(nextBossSite(a)).toEqual(nextBossSite(b));
  });

  it('倒计时对客户端是可读的：没有 BOSS 时给出还剩几秒', () => {
    const s = createBossState(MAP, 10);
    expect(secondsToNextBoss(s, 10)).toBe(BOSS.FIRST_SPAWN_SECONDS);
    expect(secondsToNextBoss(s, 10 + BOSS.FIRST_SPAWN_SECONDS + 5)).toBe(0);
  });
});

describe('BOSS 出场', () => {
  it('到点刷出一只中立实体，并登记移动状态', () => {
    const { deps, state, world, movement } = rig();
    const r = tickBoss(state, deps, [], BOSS.FIRST_SPAWN_SECONDS);
    expect(r.spawned).toBeDefined();

    const e = world.entities.get(r.spawned!.entityId)!;
    expect(e.team).toBe(TEAM_NEUTRAL);
    expect(isBossEntity(e)).toBe(true);
    expect(e.maxHealth).toBeGreaterThan(5000);
    /**
     * ★★ 没有移动状态条目的实体**不参与移动**（tick.ts 的规则）——
     *   漏登记的表现是「BOSS 站在原地永远不动」，而且不会有任何报错。
     */
    expect(movement.has(e.id)).toBe(true);
    expect(state.activeId).toBe(e.id);
  });

  it('★ 同一 tick 不会刷第二只，也不会在下一 tick 再刷', () => {
    const { deps, state } = rig();
    tickBoss(state, deps, [], BOSS.FIRST_SPAWN_SECONDS);
    const again = tickBoss(state, deps, [], BOSS.FIRST_SPAWN_SECONDS + 100);
    expect(again.spawned).toBeUndefined();
    expect(state.spawned).toBe(1);
  });

  it('★★ BOSS 不进战后统计名单 —— 它的死亡不能变成谁的击杀数', () => {
    const { deps, state, world } = rig();
    const player = addPlayer(world);
    const stats = createStats();
    registerPlayer(stats, player);

    const spawned = tickBoss(state, deps, [], BOSS.FIRST_SPAWN_SECONDS).spawned!;
    expect(stats.players.has(spawned.entityId)).toBe(false);

    // 玩家打死 BOSS：统计折叠之后击杀数仍然是 0（BOSS 不是「一个人头」）
    const death: CombatEvent = {
      t: 'death', targetId: spawned.entityId, killerId: player.id,
    };
    ingestCombatEvents(stats, world, [death], 10);
    expect(stats.players.get(player.id)!.general.kills).toBe(0);
    expect(stats.players.get(player.id)!.general.assists).toBe(0);
  });
});

describe('BOSS 狂暴', () => {
  it('血量压到 30% 以下自动狂暴，且只触发一次', () => {
    const { deps, state, world } = rig();
    const id = tickBoss(state, deps, [], BOSS.FIRST_SPAWN_SECONDS).spawned!.entityId;
    const e = world.entities.get(id)!;

    e.health = e.maxHealth * 0.5;
    expect(tickBoss(state, deps, [], 61).enraged).toBeUndefined();

    e.health = e.maxHealth * BOSS.ENRAGE_HEALTH_PCT - 1;
    const enraged = tickBoss(state, deps, [], 62);
    expect(enraged.enraged).toBe(id);
    expect(aurasOf(deps.auras, id).some((a) => a.def.id === 'boss.enrage')).toBe(true);

    expect(tickBoss(state, deps, [], 63).enraged).toBeUndefined();
  });

  it('★ 换一只重新开始：新 BOSS 不继承上一只的狂暴', () => {
    const { deps, state, world } = rig();
    addPlayer(world);
    const first = tickBoss(state, deps, [], 60).spawned!.entityId;
    const e = world.entities.get(first)!;
    e.health = 1;
    tickBoss(state, deps, [], 61); // 狂暴
    e.alive = false;
    tickBoss(state, deps, [{ t: 'death', targetId: first }], 62); // 被击杀

    const second = tickBoss(state, deps, [], 62 + BOSS.RESPAWN_SECONDS).spawned!;
    expect(state.enraged).toBe(false);
    expect(aurasOf(deps.auras, second.entityId)).toEqual([]);
  });
});

describe('BOSS 被击杀', () => {
  /** 打死场上那只，返回结算事实 */
  const slay = (
    r: ReturnType<typeof rig>, killerId: EntityId | undefined, now: number,
  ) => {
    const e = r.world.entities.get(r.state.activeId!)!;
    e.alive = false;
    e.health = 0;
    const death: CombatEvent = {
      t: 'death', targetId: e.id, ...(killerId !== undefined ? { killerId } : {}),
    };
    return tickBoss(r.state, r.deps, [death], now).slain!;
  };

  it('掉落装备、发赏金、把尸体收走、排下一只', () => {
    const r = rig();
    const player = addPlayer(r.world);
    tickBoss(r.state, r.deps, [], 60);
    const bossId = r.state.activeId!;

    const slain = slay(r, player.id, 61);

    expect(slain.bossId).toBe(bossId);
    expect(slain.killerId).toBe(player.id);
    expect(slain.bounty).toBe(BOSS.KILL_BOUNTY);
    expect(r.state.bounties.get(player.id)).toBe(BOSS.KILL_BOUNTY);
    // 战利品确实落在地上，而且摊开了（不是叠成一堆）
    expect(slain.drops.length).toBeGreaterThan(0);
    expect(r.deps.arsenal.drops.length).toBe(slain.drops.length);
    const distinct = new Set(slain.drops.map((d) => `${d.position.x},${d.position.z}`));
    expect(distinct.size).toBe(slain.drops.length);
    // 尸体不留（见 settleBossDeath 的注释）
    expect(r.world.entities.has(bossId)).toBe(false);
    expect(r.movement.has(bossId)).toBe(false);
    // 下一只排在 RESPAWN_SECONDS 之后
    expect(r.state.activeId).toBeUndefined();
    expect(r.state.nextSpawnAt).toBe(61 + BOSS.RESPAWN_SECONDS);
    expect(r.state.slain).toBe(1);
  });

  it('★ 战利品只来自**场上实际存在**的职业池，且绝不掉 BOSS 自己的武器', () => {
    const r = rig();
    addPlayer(r.world, 'mage');
    tickBoss(r.state, r.deps, [], 60);
    const slain = slay(r, undefined, 61);

    const owners = new Set(slain.drops.map((d) => d.classId).filter((c) => c !== undefined));
    expect([...owners]).toEqual([asClassId('mage')]);
    expect(slain.drops.some((d) => (d.weaponId as string | undefined)?.startsWith('boss.')))
      .toBe(false);
    // 10.1：另外那件是人人可用的消耗品（没有职业归属）
    expect(slain.drops.some((d) => d.kind === 'consumable' && d.classId === undefined)).toBe(true);
  });

  it('★ 没有最后一击者时如实不发赏金（不编一个凶手出来）', () => {
    const r = rig();
    addPlayer(r.world);
    tickBoss(r.state, r.deps, [], 60);
    const slain = slay(r, undefined, 61);
    expect(slain.killerId).toBeUndefined();
    expect(slain.bounty).toBe(0);
    expect(r.state.bounties.size).toBe(0);
  });

  it('★ 验收 #28：经典竞技场预设下有 BOSS、但一件临时武装都不掉', () => {
    const r = rig(ArenaPreset.Classic);
    addPlayer(r.world);
    tickBoss(r.state, r.deps, [], 60);
    const slain = slay(r, undefined, 61);
    expect(slain.drops).toEqual([]);
    expect(r.deps.arsenal.drops).toEqual([]);
    // 赏金照给（它不属于第 10 章）
    expect(slain.bossId).toBeDefined();
  });

  it('赏金是累计的：连杀两只的人拿两份', () => {
    const r = rig();
    const player = addPlayer(r.world);
    tickBoss(r.state, r.deps, [], 60);
    slay(r, player.id, 61);
    tickBoss(r.state, r.deps, [], 61 + BOSS.RESPAWN_SECONDS);
    const second = slay(r, player.id, 62 + BOSS.RESPAWN_SECONDS);
    expect(second.killerTotal).toBe(BOSS.KILL_BOUNTY * 2);
    expect(r.state.bounties.get(player.id)).toBe(BOSS.KILL_BOUNTY * 2);
  });

  it('⚠️ 防御性再同步：实体被别处删掉也不会让 BOSS 永远不再刷', () => {
    const r = rig();
    tickBoss(r.state, r.deps, [], 60);
    r.world.entities.delete(r.state.activeId!);

    tickBoss(r.state, r.deps, [], 61);
    expect(r.state.activeId).toBeUndefined();
    expect(r.state.nextSpawnAt).toBe(61 + BOSS.RESPAWN_SECONDS);
    expect(tickBoss(r.state, r.deps, [], 61 + BOSS.RESPAWN_SECONDS).spawned).toBeDefined();
  });
});

describe('BOSS 会出手（决策层认得它的技能）', () => {
  /**
   * ★★ **这条测试挡的是一个静默失败。**
   *   `decideBotAction()` 原先按 `ALL_CLASSES.find(...)` 取技能表，而 BOSS
   *   刻意不在那张清单里 —— 于是它会走位、会抡白字，但**一个技能都不放**，
   *   没有任何报错。改成走注册表（`getClass`）之后，这里钉住它。
   */
  it('★★ 贴脸的玩家会吃到 BOSS 的技能，而不是只挨白字', async () => {
    const { decideBotAction } = await import('../ai/botController.js');
    const { createCastingStore } = await import('./casting.js');
    const { deps, state, world } = rig();
    const player = addPlayer(world);
    const bossId = tickBoss(state, deps, [], BOSS.FIRST_SPAWN_SECONDS).spawned!.entityId;
    const bossEntity = world.entities.get(bossId)!;
    // 贴到脸上（技能距离 6 米以内）
    player.position = { x: bossEntity.position.x + 3, y: bossEntity.position.y, z: bossEntity.position.z };

    const action = decideBotAction({
      world,
      casting: createCastingStore(),
      self: bossEntity,
      foe: player,
      rng: () => 0.5,
      difficulty: 'hard',
    });
    expect(action.cast, 'BOSS 决策层拿不到技能表 = 它只会站着抡白字').toBeDefined();
    expect((action.cast!.skillId as string).startsWith('boss.')).toBe(true);
  });
});

describe('BOSS 的职业定义不进任何玩家清单', () => {
  it('★★ 玩家选不到它（协议是不受信任输入，`getClass` 查得到不等于能选）', () => {
    expect(getClass(asClassId('boss'))).toBeDefined();
    expect(isPlayableClass(asClassId('boss'))).toBe(false);
    expect(isPlayableClass(asClassId('warrior'))).toBe(true);
  });

  it('★ 它的技能查得到（sim 要结算），但不在 ALL_SKILLS 里（图标/签名按那张表穷尽）', async () => {
    const { ALL_SKILLS, getSkill, ALL_CLASSES } = await import('../data/index.js');
    expect(getSkill(getClass(asClassId('boss'))!.skills[0]!.id)).toBeDefined();
    expect(ALL_SKILLS.some((s) => (s.id as string).startsWith('boss.'))).toBe(false);
    expect(ALL_CLASSES.some((c) => (c.id as string) === 'boss')).toBe(false);
  });
});
