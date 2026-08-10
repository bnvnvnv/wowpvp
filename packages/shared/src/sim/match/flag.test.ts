/**
 * 夺旗战场测试。规格书 12.1–12.6，验收 #38–#43。
 *
 * 这里验证的是**规则本身**；「规则有没有真的接上线」由
 * `scripts/verify-m7.ts` 端到端跑一整局来验证 ——
 * M3/M4 的经验是这两类 bug 完全不重叠。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { CTF } from '../../constants/combat.js';
import { warrior } from '../../data/index.js';
import { ctfMap } from '../../data/maps/index.js';
import type { Vec3 } from '../../math/vec3.js';
import { FlagState } from '../../types/enums.js';
import { asEntityId, TEAM_BLUE, TEAM_RED, type TeamId } from '../../types/ids.js';
import { createAuraStore, deriveStatusFlags, tickAuras, type AuraStore } from '../aura.js';
import { createEntity, type CombatEntity } from '../entity.js';
import { addEntity, createWorld, type World } from '../world.js';
import {
  beginFlagInteract,
  clampCarrierSpeedBonus,
  createCtf,
  ctfInOvertime,
  ctfTimeRemaining,
  ctfWinner,
  dropFlag,
  dropFlagBeforeSkill,
  enemyFlagOf,
  flagOf,
  flagViews,
  focusModifiers,
  onCarrierLost,
  resetCtf,
  tickFlags,
  updateBattlefieldFocus,
  type CtfDeps,
  type CtfState,
} from './flag.js';
import {
  breakSpawnProtection,
  createRespawn,
  enqueueRespawn,
  isAwaitingRespawn,
  resetRespawn,
  secondsToNextWave,
  setOvertime,
  tickRespawn,
  SPAWN_PROTECTION_AURA,
} from './respawn.js';

// ── 夹具 ─────────────────────────────────────────────────────────

const RED_BASE: Vec3 = { x: 0, y: 0, z: 100 };
const BLUE_BASE: Vec3 = { x: 0, y: 0, z: -100 };

let world: World;
let ctf: CtfState;
let auras: AuraStore;
let nextId = 1;

/**
 * ★ 走真实的 `createEntity()` 工厂，不手搓对象字面量。
 *
 *   原先这里是一个 `as CombatEntity` 的手写实体，它已经和真实类型漂移得很远：
 *   缺 radius / height / maxResources，多出 velocity / grounded，
 *   `resources` 写成了 `{}` 而真实类型是 `Map`（任何一次 getResource 都会出错），
 *   weaponId 是解析不出装备的 `'w'`。`as` 断言把这些全掩盖了，
 *   而当时 shared 的测试文件不在类型检查范围内，所以连断言的破洞也没人发现。
 *
 *   用工厂之后，实体形状变化会**自动**同步到这里。
 */
const spawn = (team: TeamId, position: Vec3, name = `e${nextId}`): CombatEntity => {
  const e = createEntity(asEntityId(nextId++), warrior, team, position, { name });
  // 这些测试只关心「掉了多少血」，用 100 好算
  e.health = 100;
  e.maxHealth = 100;
  return addEntity(world, e);
};

/** 交旗区：己方基地周围 5 米 */
const deps = (isLegalPosition?: (p: Vec3) => boolean): CtfDeps => ({
  world,
  captureZoneContains: (team, p) => {
    const base = team === TEAM_RED ? RED_BASE : BLUE_BASE;
    return Math.hypot(p.x - base.x, p.z - base.z) <= 5;
  },
  ...(isLegalPosition ? { isLegalPosition } : {}),
});

const inZone = (team: TeamId) => (p: Vec3) => deps().captureZoneContains(team, p);

/** 把一面旗直接送进某人手里，省掉每个用例都写一遍拔旗读条 */
const giveFlag = (e: CombatEntity, now = 0): void => {
  const flag = enemyFlagOf(ctf, e.team);
  flag.state = FlagState.Carried;
  flag.carrierId = e.id;
  flag.position = { ...e.position };
  flag.lastLegalPosition = { ...e.position };
  e.flags.carryingFlag = true;
  void now;
};

beforeEach(() => {
  world = createWorld(ctfMap.geometry);
  ctf = createCtf(RED_BASE, BLUE_BASE);
  auras = createAuraStore();
  nextId = 1;
});

// ════════════════════════════════════════════════════════════════
//  验收 #38：拔旗 → 携旗 → 掉旗 → 归还 → 交旗 → 重置 完整流程
// ════════════════════════════════════════════════════════════════

describe('★ 验收 #38 完整流程（12.1 / 12.2）', () => {
  it('拔旗要读条 1.2 秒，读条完成才真正携带', () => {
    const red = spawn(TEAM_RED, BLUE_BASE);
    const blue = flagOf(ctf, TEAM_BLUE);

    const r = beginFlagInteract(ctf, red, blue, 0, inZone(TEAM_RED));
    expect(r).toEqual({ ok: true, action: 'pickup', endsAt: CTF.PICKUP_SECONDS });
    expect(blue.state).toBe(FlagState.BeingTaken);

    // 读条未完成时还不算携带
    tickFlags(ctf, deps(), CTF.PICKUP_SECONDS - 0.1);
    expect(blue.state).toBe(FlagState.BeingTaken);
    expect(red.flags.carryingFlag).toBe(false);

    const events = tickFlags(ctf, deps(), CTF.PICKUP_SECONDS);
    expect(events).toContainEqual({ type: 'taken', flagTeam: TEAM_BLUE, entityId: red.id });
    expect(blue.state).toBe(FlagState.Carried);
    expect(red.flags.carryingFlag).toBe(true);
  });

  it('携带中旗帜跟随旗手移动', () => {
    const red = spawn(TEAM_RED, BLUE_BASE);
    giveFlag(red);
    red.position = { x: 10, y: 0, z: -50 };
    tickFlags(ctf, deps(), 1);
    expect(flagOf(ctf, TEAM_BLUE).position).toEqual({ x: 10, y: 0, z: -50 });
  });

  it('旗手死亡时旗帜掉在原地', () => {
    const red = spawn(TEAM_RED, { x: 5, y: 0, z: -20 });
    giveFlag(red);
    red.alive = false;

    const events = tickFlags(ctf, deps(), 1);
    const blue = flagOf(ctf, TEAM_BLUE);
    expect(events).toContainEqual({ type: 'dropped', flagTeam: TEAM_BLUE, reason: 'death' });
    expect(blue.state).toBe(FlagState.Dropped);
    expect(blue.position).toEqual({ x: 5, y: 0, z: -20 });
    expect(red.flags.carryingFlag).toBe(false);
  });

  it('己方归还掉落的旗要读条 0.6 秒，完成后回到基地', () => {
    const red = spawn(TEAM_RED, { x: 5, y: 0, z: -20 });
    giveFlag(red);
    red.alive = false;
    tickFlags(ctf, deps(), 1);

    const blue = spawn(TEAM_BLUE, { x: 5, y: 0, z: -20 });
    const flag = flagOf(ctf, TEAM_BLUE);
    const r = beginFlagInteract(ctf, blue, flag, 1, inZone(TEAM_BLUE));
    expect(r).toMatchObject({ ok: true, action: 'return' });

    const events = tickFlags(ctf, deps(), 1 + CTF.RETURN_SECONDS);
    expect(events).toContainEqual({ type: 'returned', flagTeam: TEAM_BLUE, entityId: blue.id });
    expect(flag.state).toBe(FlagState.AtBase);
    expect(flag.position).toEqual(BLUE_BASE);
  });

  it('★ 12.2 抢旗方可以直接重新拾取掉落的旗，无需读条', () => {
    const red1 = spawn(TEAM_RED, { x: 5, y: 0, z: -20 });
    giveFlag(red1);
    red1.alive = false;
    tickFlags(ctf, deps(), 1);

    const red2 = spawn(TEAM_RED, { x: 5, y: 0, z: -20 });
    const flag = flagOf(ctf, TEAM_BLUE);
    const r = beginFlagInteract(ctf, red2, flag, 1, inZone(TEAM_RED));
    expect(r).toMatchObject({ ok: true, action: 'pickup' });
    // 立刻生效，不用等 tick
    expect(flag.state).toBe(FlagState.Carried);
    expect(red2.flags.carryingFlag).toBe(true);
  });

  it('交旗读条 0.8 秒完成后得分，旗帜重置回基地', () => {
    const red = spawn(TEAM_RED, RED_BASE);
    giveFlag(red);

    const flag = flagOf(ctf, TEAM_BLUE);
    const r = beginFlagInteract(ctf, red, flag, 0, inZone(TEAM_RED));
    expect(r).toMatchObject({ ok: true, action: 'capture' });

    const events = tickFlags(ctf, deps(), CTF.CAPTURE_SECONDS);
    expect(events).toContainEqual({ type: 'captured', flagTeam: TEAM_BLUE, entityId: red.id });
    expect(flag.state).toBe(FlagState.AtBase);
    expect(flag.position).toEqual(BLUE_BASE);
    expect(ctf.score[String(TEAM_RED as number)]).toBe(1);
    expect(red.flags.carryingFlag).toBe(false);
  });

  it('12.2 拔旗途中移动会中断，旗帜回到基地状态', () => {
    const red = spawn(TEAM_RED, BLUE_BASE);
    const flag = flagOf(ctf, TEAM_BLUE);
    beginFlagInteract(ctf, red, flag, 0, inZone(TEAM_RED));

    red.position = { x: 0, y: 0, z: -90 }; // 走开 10 米
    const events = tickFlags(ctf, deps(), 0.5);
    expect(events).toContainEqual({
      type: 'interruptedInteract', flagTeam: TEAM_BLUE, reason: 'moved',
    });
    expect(flag.state).toBe(FlagState.AtBase);
  });

  it('12.2 硬控制会中断拔旗', () => {
    const red = spawn(TEAM_RED, BLUE_BASE);
    const flag = flagOf(ctf, TEAM_BLUE);
    beginFlagInteract(ctf, red, flag, 0, inZone(TEAM_RED));
    red.flags.stunned = true;

    const events = tickFlags(ctf, deps(), 0.5);
    expect(events).toContainEqual({
      type: 'interruptedInteract', flagTeam: TEAM_BLUE, reason: 'stunned',
    });
    expect(flag.state).toBe(FlagState.AtBase);
  });

  it('12.2 同一时刻只有一名玩家能拔旗', () => {
    const a = spawn(TEAM_RED, BLUE_BASE);
    const b = spawn(TEAM_RED, BLUE_BASE);
    const flag = flagOf(ctf, TEAM_BLUE);
    expect(beginFlagInteract(ctf, a, flag, 0, inZone(TEAM_RED))).toMatchObject({ ok: true });
    expect(beginFlagInteract(ctf, b, flag, 0, inZone(TEAM_RED))).toMatchObject({ ok: false });
  });

  it('达到目标分数时判定胜者', () => {
    expect(ctfWinner(ctf)).toBeNull();
    ctf.score[String(TEAM_RED as number)] = ctf.scoreToWin;
    expect(ctfWinner(ctf)).toBe(TEAM_RED);
  });

  it('房主可调的目标分数被夹到 1~5（12.1）', () => {
    expect(createCtf(RED_BASE, BLUE_BASE, 99).scoreToWin).toBe(CTF.MAX_SCORE_TO_WIN);
    expect(createCtf(RED_BASE, BLUE_BASE, 0).scoreToWin).toBe(CTF.MIN_SCORE_TO_WIN);
  });
});

// ════════════════════════════════════════════════════════════════
//  验收 #39：己方旗帜不在基地时无法交旗
// ════════════════════════════════════════════════════════════════

describe('★ 验收 #39 己方旗帜不在基地时无法交旗（12.1 / 12.4）', () => {
  it('开始交旗时就会被拒绝', () => {
    const red = spawn(TEAM_RED, RED_BASE);
    giveFlag(red);
    // 红旗被蓝方带走了
    const own = flagOf(ctf, TEAM_RED);
    own.state = FlagState.Carried;

    const r = beginFlagInteract(ctf, red, flagOf(ctf, TEAM_BLUE), 0, inZone(TEAM_RED));
    expect(r.ok).toBe(false);
    expect(ctf.score[String(TEAM_RED as number)] ?? 0).toBe(0);
  });

  it('★★ 交旗**途中**己方旗帜被拔走，交付立即中断 —— 不是只在开始时检查一次', () => {
    const red = spawn(TEAM_RED, RED_BASE);
    giveFlag(red);
    const enemyFlag = flagOf(ctf, TEAM_BLUE);

    // 开始时己方旗帜还在基地，允许交旗
    expect(beginFlagInteract(ctf, red, enemyFlag, 0, inZone(TEAM_RED))).toMatchObject({ ok: true });
    expect(enemyFlag.state).toBe(FlagState.BeingCaptured);

    // 0.4 秒时（读条一半）己方旗帜被敌人拔走
    flagOf(ctf, TEAM_RED).state = FlagState.Carried;
    const events = tickFlags(ctf, deps(), 0.4);
    expect(events).toContainEqual({
      type: 'interruptedInteract', flagTeam: TEAM_BLUE, reason: 'ownFlagNotAtBase',
    });

    // 读条时间到了也不该得分：状态已经退回携带中
    expect(enemyFlag.state).toBe(FlagState.Carried);
    tickFlags(ctf, deps(), CTF.CAPTURE_SECONDS + 1);
    expect(ctf.score[String(TEAM_RED as number)] ?? 0).toBe(0);
  });

  it('交旗途中离开交旗区也会中断', () => {
    // 交旗区半径 5 米，交互半径 2.2 米 —— 想只触发「出区」而不触发「走开」，
    // 必须从区域**边缘**开始交旗
    const red = spawn(TEAM_RED, { x: 0, y: 0, z: 95.5 });
    giveFlag(red);
    const enemyFlag = flagOf(ctf, TEAM_BLUE);
    beginFlagInteract(ctf, red, enemyFlag, 0, inZone(TEAM_RED));

    // 距起点 2.0 米（没超交互半径），但离基地 6.5 米（出了交旗区）
    red.position = { x: 0, y: 0, z: 93.5 };
    const events = tickFlags(ctf, deps(), 0.4);
    expect(events).toContainEqual({
      type: 'interruptedInteract', flagTeam: TEAM_BLUE, reason: 'leftCaptureZone',
    });
  });
});

// ════════════════════════════════════════════════════════════════
//  验收 #40：潜行 / 消失 / 完全无敌先掉旗，旗帜不随角色隐藏
// ════════════════════════════════════════════════════════════════

describe('★ 验收 #40 无敌与潜行先掉旗（12.3）', () => {
  it('★ dropFlagBeforeSkill 在技能生效前掉旗，返回被掉落的旗', () => {
    const red = spawn(TEAM_RED, { x: 3, y: 0, z: -30 });
    giveFlag(red);

    const dropped = dropFlagBeforeSkill(ctf, red, 5);
    expect(dropped).not.toBeNull();
    expect(dropped!.state).toBe(FlagState.Dropped);
    expect(dropped!.position).toEqual({ x: 3, y: 0, z: -30 });
    expect(red.flags.carryingFlag).toBe(false);
  });

  it('没带旗时调用是安全的空操作', () => {
    const red = spawn(TEAM_RED, BLUE_BASE);
    expect(dropFlagBeforeSkill(ctf, red, 0)).toBeNull();
  });

  it('★★ 旗帜不会随角色隐藏：旗手潜行后旗帜仍在原地且对双方可见', () => {
    const red = spawn(TEAM_RED, { x: 3, y: 0, z: -30 }, '潜行者');
    giveFlag(red);

    // 顺序就是规格书写的：先掉旗，再播放技能表现
    dropFlagBeforeSkill(ctf, red, 5);
    red.flags.stealthed = true;

    const views = flagViews(ctf, world);
    const blueFlagView = views.find((v) => v.team === TEAM_BLUE)!;
    expect(blueFlagView.state).toBe(FlagState.Dropped);
    expect(blueFlagView.position).toEqual({ x: 3, y: 0, z: -30 });
    // 掉落的旗没有旗手 —— 不会因为旗手隐身而跟着消失
    expect(blueFlagView.carrierName).toBeUndefined();
  });

  it('★ 12.3 旗手移动加成上限 10%', () => {
    // 群奔咆哮之类给 30%，旗手身上最多只吃到 10%
    expect(clampCarrierSpeedBonus(0.3, true)).toBeCloseTo(CTF.FLAG_CARRIER_MAX_SPEED_BONUS);
    // 加成本来就低于上限时不受影响
    expect(clampCarrierSpeedBonus(0.05, true)).toBeCloseTo(0.05);
    // 不带旗的人不受限制
    expect(clampCarrierSpeedBonus(0.3, false)).toBeCloseTo(0.3);
  });
});

// ════════════════════════════════════════════════════════════════
//  验收 #41：双方同时持旗 + 战场聚焦
// ════════════════════════════════════════════════════════════════

describe('★ 验收 #41 同时持旗与战场聚焦（12.4）', () => {
  const bothCarry = () => {
    const red = spawn(TEAM_RED, { x: 0, y: 0, z: -50 });
    const blue = spawn(TEAM_BLUE, { x: 0, y: 0, z: 50 });
    giveFlag(red);
    giveFlag(blue);
    return { red, blue };
  };

  it('双方可以同时持旗，比赛继续', () => {
    bothCarry();
    expect(flagOf(ctf, TEAM_RED).state).toBe(FlagState.Carried);
    expect(flagOf(ctf, TEAM_BLUE).state).toBe(FlagState.Carried);
    expect(ctfWinner(ctf)).toBeNull();
  });

  it('60 秒宽限期内不叠层', () => {
    bothCarry();
    updateBattlefieldFocus(ctf, 0);
    updateBattlefieldFocus(ctf, CTF.FOCUS_GRACE_SECONDS - 1);
    expect(ctf.focusStacks).toBe(0);
  });

  it('★ 超过 60 秒开始叠层，之后每 30 秒一层，最多 5 层', () => {
    bothCarry();
    updateBattlefieldFocus(ctf, 0);

    updateBattlefieldFocus(ctf, 60);
    expect(ctf.focusStacks).toBe(1);
    updateBattlefieldFocus(ctf, 90);
    expect(ctf.focusStacks).toBe(2);
    updateBattlefieldFocus(ctf, 180);
    expect(ctf.focusStacks).toBe(5);
    // 上限
    updateBattlefieldFocus(ctf, 600);
    expect(ctf.focusStacks).toBe(CTF.FOCUS_MAX_STACKS);
  });

  it('每层受到伤害 +8%、受到治疗 −5%', () => {
    expect(focusModifiers(0)).toEqual({ damageTaken: 1, healingTaken: 1 });
    const m = focusModifiers(5);
    expect(m.damageTaken).toBeCloseTo(1.4);
    expect(m.healingTaken).toBeCloseTo(0.75);
  });

  it('★★「逐步清除」按时间走，不是每 tick 掉一层', () => {
    bothCarry();
    updateBattlefieldFocus(ctf, 0);
    updateBattlefieldFocus(ctf, 180);
    expect(ctf.focusStacks).toBe(5);

    // 蓝旗回基地 → 停止叠加，开始衰减
    flagOf(ctf, TEAM_BLUE).state = FlagState.AtBase;
    const decayStart = 180;
    updateBattlefieldFocus(ctf, decayStart); // 这一 tick 记下衰减起点

    // 20Hz 连跑 1 秒（20 次）。按 tick 掉层的实现会在这里掉到 0
    for (let i = 1; i <= 20; i += 1) updateBattlefieldFocus(ctf, decayStart + i * 0.05);
    expect(ctf.focusStacks).toBe(5);

    updateBattlefieldFocus(ctf, decayStart + CTF.FOCUS_STACK_INTERVAL);
    expect(ctf.focusStacks).toBe(4);
    updateBattlefieldFocus(ctf, decayStart + CTF.FOCUS_STACK_INTERVAL * 2);
    expect(ctf.focusStacks).toBe(3);
  });
});

// ════════════════════════════════════════════════════════════════
//  验收 #42：断线 / 退出 / 非法区域 → 最后合法位置
// ════════════════════════════════════════════════════════════════

describe('★ 验收 #42 旗帜落在最后合法位置（12.3）', () => {
  it('★ 断线时旗帜落在最后合法位置，而不是断线瞬间的位置', () => {
    const red = spawn(TEAM_RED, { x: 0, y: 0, z: -40 });
    giveFlag(red);
    tickFlags(ctf, deps(), 1); // 记录 (0,-40) 为最后合法位置

    // 断线后实体位置可能已经是脏数据
    red.position = { x: 9999, y: -9999, z: 9999 };
    const ev = onCarrierLost(ctf, world, red.id, 2);

    const flag = flagOf(ctf, TEAM_BLUE);
    expect(ev).toMatchObject({ type: 'dropped', reason: 'disconnect' });
    expect(flag.state).toBe(FlagState.Dropped);
    expect(flag.position).toEqual({ x: 0, y: 0, z: -40 });
    expect(red.flags.carryingFlag).toBe(false);
  });

  it('★ 进入非法区域时旗帜落在进入前的最后合法位置', () => {
    const red = spawn(TEAM_RED, { x: 0, y: 0, z: -40 });
    giveFlag(red);

    // (0,-40) 合法，z < -60 是非法区域（比如掉出地图）
    const legal = (p: Vec3) => p.z > -60;
    tickFlags(ctf, deps(legal), 1);

    red.position = { x: 0, y: -50, z: -80 };
    const events = tickFlags(ctf, deps(legal), 2);

    const flag = flagOf(ctf, TEAM_BLUE);
    expect(events).toContainEqual({
      type: 'dropped', flagTeam: TEAM_BLUE, reason: 'illegalArea',
    });
    expect(flag.position).toEqual({ x: 0, y: 0, z: -40 });
  });

  it('旗手实体直接从世界里消失时也不会丢旗', () => {
    const red = spawn(TEAM_RED, { x: 7, y: 0, z: -10 });
    giveFlag(red);
    tickFlags(ctf, deps(), 1);

    world.entities.delete(red.id);
    const events = tickFlags(ctf, deps(), 2);
    expect(events).toContainEqual({
      type: 'dropped', flagTeam: TEAM_BLUE, reason: 'disconnect',
    });
    expect(flagOf(ctf, TEAM_BLUE).position).toEqual({ x: 7, y: 0, z: -10 });
  });

  it('没带旗的人断线不产生事件', () => {
    const red = spawn(TEAM_RED, BLUE_BASE);
    expect(onCarrierLost(ctf, world, red.id, 1)).toBeNull();
  });

  it('掉落后的旗不会被再次 dropFlag 移动', () => {
    const red = spawn(TEAM_RED, { x: 1, y: 0, z: -10 });
    giveFlag(red);
    dropFlag(flagOf(ctf, TEAM_BLUE), red, 1);
    const at = { ...flagOf(ctf, TEAM_BLUE).position };
    red.position = { x: 50, y: 0, z: 50 };
    dropFlag(flagOf(ctf, TEAM_BLUE), red, 2);
    expect(flagOf(ctf, TEAM_BLUE).position).toEqual(at);
  });
});

// ════════════════════════════════════════════════════════════════
//  验收 #43：复活波次、复活保护、基地出口不堵门
// ════════════════════════════════════════════════════════════════

describe('★ 验收 #43 波次复活与复活保护（12.6）', () => {
  const EXITS = {
    [TEAM_RED as number]: [
      { x: -10, y: 0, z: 148 },
      { x: 10, y: 0, z: 148 },
    ],
    [TEAM_BLUE as number]: [
      { x: 10, y: 0, z: -148 },
      { x: -10, y: 0, z: -148 },
    ],
  };

  it('默认 12 秒一波，加时赛 16 秒', () => {
    const s = createRespawn(EXITS, 0);
    expect(secondsToNextWave(s, 0)).toBe(CTF.RESPAWN_WAVE_SECONDS);
    setOvertime(s, true, 0);
    expect(secondsToNextWave(s, 0)).toBe(CTF.RESPAWN_WAVE_SECONDS_OVERTIME);
  });

  it('★ 是波次复活而不是各自倒计时 —— 同一波的人一起出来', () => {
    const s = createRespawn(EXITS, 0);
    const a = spawn(TEAM_RED, RED_BASE);
    const b = spawn(TEAM_RED, RED_BASE);
    a.alive = false;
    b.alive = false;

    enqueueRespawn(s, a.id, 0); // 第 0 秒死
    enqueueRespawn(s, b.id, 11); // 第 11 秒死，只等 1 秒

    expect(tickRespawn(s, world, auras, 11.9)).toHaveLength(0);
    const events = tickRespawn(s, world, auras, 12);
    expect(events.map((e) => e.entityId).sort()).toEqual([a.id, b.id].sort());
    expect(a.alive && b.alive).toBe(true);
    expect(a.health).toBe(a.maxHealth);
  });

  it('★ 出口轮流分配，整波人不会叠在同一个点（验收 #43 防堵门）', () => {
    const s = createRespawn(EXITS, 0);
    const team = Array.from({ length: 4 }, () => spawn(TEAM_RED, RED_BASE));
    for (const e of team) {
      e.alive = false;
      enqueueRespawn(s, e.id, 0);
    }
    const events = tickRespawn(s, world, auras, 12);
    const used = new Set(events.map((e) => `${e.position.x},${e.position.z}`));
    expect(used.size).toBe(2); // 两个出口都用上了
  });

  it('★★ 复活保护是真光环 —— deriveStatusFlags 重建后依然在', () => {
    const s = createRespawn(EXITS, 0);
    const e = spawn(TEAM_RED, RED_BASE);
    e.alive = false;
    enqueueRespawn(s, e.id, 0);
    tickRespawn(s, world, auras, 12);

    // 手写 entity.flags 的实现会在这一行之后失效
    e.flags = deriveStatusFlags(auras, e);
    expect(e.flags.spawnProtection).toBe(true);
    // 保护要真的免伤，不只是一个标记
    expect(e.flags.immuneAll).toBe(true);
  });

  it('3 秒后保护自动到期', () => {
    const s = createRespawn(EXITS, 0);
    const e = spawn(TEAM_RED, RED_BASE);
    e.alive = false;
    enqueueRespawn(s, e.id, 0);
    tickRespawn(s, world, auras, 12);

    tickAuras(auras, 12 + CTF.SPAWN_PROTECTION_SECONDS - 0.1);
    expect(deriveStatusFlags(auras, e).spawnProtection).toBe(true);

    tickAuras(auras, 12 + CTF.SPAWN_PROTECTION_SECONDS + 0.01);
    expect(deriveStatusFlags(auras, e).spawnProtection).toBe(false);
  });

  it('主动使用技能会提前结束保护', () => {
    const s = createRespawn(EXITS, 0);
    const e = spawn(TEAM_RED, RED_BASE);
    e.alive = false;
    enqueueRespawn(s, e.id, 0);
    tickRespawn(s, world, auras, 12);
    e.flags = deriveStatusFlags(auras, e);

    expect(breakSpawnProtection(auras, e)).toBe(true);
    expect(e.flags.spawnProtection).toBe(false);
    expect(e.flags.immuneAll).toBe(false);
    expect(deriveStatusFlags(auras, e).spawnProtection).toBe(false);
    // 幂等
    expect(breakSpawnProtection(auras, e)).toBe(false);
  });

  it('★★ 12.6 复活保护不能用于直接完成拔旗或交旗', () => {
    const e = spawn(TEAM_RED, BLUE_BASE);
    e.flags.spawnProtection = true;

    const r = beginFlagInteract(ctf, e, flagOf(ctf, TEAM_BLUE), 0, inZone(TEAM_RED));
    expect(r.ok).toBe(false);
    expect(flagOf(ctf, TEAM_BLUE).state).toBe(FlagState.AtBase);

    // 交旗同样被拒
    giveFlag(e);
    e.position = { ...RED_BASE };
    expect(beginFlagInteract(ctf, e, flagOf(ctf, TEAM_BLUE), 0, inZone(TEAM_RED)).ok).toBe(false);
  });

  it('同一个人不会在一波里复活两次', () => {
    const s = createRespawn(EXITS, 0);
    const e = spawn(TEAM_RED, RED_BASE);
    e.alive = false;
    expect(enqueueRespawn(s, e.id, 0)).toBe(true);
    expect(enqueueRespawn(s, e.id, 1)).toBe(false);
    expect(tickRespawn(s, world, auras, 12)).toHaveLength(1);
  });

  it('等待复活期间可以查询状态，复活后清空', () => {
    const s = createRespawn(EXITS, 0);
    const e = spawn(TEAM_RED, RED_BASE);
    e.alive = false;
    enqueueRespawn(s, e.id, 0);
    expect(isAwaitingRespawn(s, e.id)).toBe(true);
    tickRespawn(s, world, auras, 12);
    expect(isAwaitingRespawn(s, e.id)).toBe(false);
  });

  it('复活保护光环不可驱散（dispelType: none）', () => {
    expect(SPAWN_PROTECTION_AURA.dispelType).toBe('none');
    expect(SPAWN_PROTECTION_AURA.clearableByTrinket).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════
//  重置
// ════════════════════════════════════════════════════════════════

describe('比赛重置', () => {
  it('resetCtf 清空旗帜、比分、聚焦与携带标志', () => {
    const red = spawn(TEAM_RED, { x: 1, y: 0, z: -10 });
    giveFlag(red);
    ctf.score[String(TEAM_RED as number)] = 2;
    ctf.focusStacks = 3;

    resetCtf(ctf, world);
    expect(flagOf(ctf, TEAM_BLUE).state).toBe(FlagState.AtBase);
    expect(flagOf(ctf, TEAM_BLUE).position).toEqual(BLUE_BASE);
    expect(red.flags.carryingFlag).toBe(false);
    expect(ctf.score[String(TEAM_RED as number)]).toBe(0);
    expect(ctf.focusStacks).toBe(0);
  });

  it('resetRespawn 清空队列与保护标志', () => {
    const s = createRespawn({ [TEAM_RED as number]: [RED_BASE] }, 0);
    const e = spawn(TEAM_RED, RED_BASE);
    e.flags.spawnProtection = true;
    enqueueRespawn(s, e.id, 0);

    resetRespawn(s, world, 100);
    expect(isAwaitingRespawn(s, e.id)).toBe(false);
    expect(e.flags.spawnProtection).toBe(false);
    expect(secondsToNextWave(s, 100)).toBe(CTF.RESPAWN_WAVE_SECONDS);
  });
});

// ════════════════════════════════════════════════════════════════
//  A17：时限与突然死亡加时（规格 6.x）
// ════════════════════════════════════════════════════════════════

describe('★★ A17 夺旗时限与加时（时间到比分高者胜／同分突然死亡）', () => {
  const DURATION = 60;
  /** 限时局的夹具：60 秒常规时长，开赛时刻 0 */
  const timed = (): CtfState =>
    createCtf(RED_BASE, BLUE_BASE, 3, { duration: DURATION, startedAt: 0 });

  const setScore = (s: CtfState, red: number, blue: number): void => {
    s.score[String(TEAM_RED as number)] = red;
    s.score[String(TEAM_BLUE as number)] = blue;
  };

  it('★ 常规时间内不判胜负，剩余时间照实往下走', () => {
    ctf = timed();
    setScore(ctf, 1, 0);
    tickFlags(ctf, deps(), 30);
    expect(ctf.outcome).toBeNull();
    expect(ctfTimeRemaining(ctf, 30)).toBe(30);
    expect(ctfInOvertime(ctf)).toBe(false);
  });

  it('★★ 时间到，比分高者获胜（不进加时）', () => {
    ctf = timed();
    setScore(ctf, 2, 1);
    tickFlags(ctf, deps(), DURATION);
    expect(ctf.outcome).toEqual({ winner: TEAM_RED });
    expect(ctfInOvertime(ctf), '有人领先还进加时了').toBe(false);
    expect(ctfTimeRemaining(ctf, DURATION)).toBe(0);
  });

  it('★★ 时间到平分 → 进突然死亡加时，比赛不结束', () => {
    ctf = timed();
    setScore(ctf, 1, 1);
    tickFlags(ctf, deps(), DURATION);
    expect(ctf.outcome, '平分就把比赛判掉了 —— 加时没生效').toBeNull();
    expect(ctfInOvertime(ctf)).toBe(true);
    // 加时的倒计时换成「距硬上限」，那个零是真的会发生事情的零（判平局）
    expect(ctfTimeRemaining(ctf, DURATION)).toBe(CTF.OVERTIME_HARD_CAP);
  });

  it('★★ 加时内先得分者胜（一次夺旗即终局，不必到目标分）', () => {
    ctf = timed();
    setScore(ctf, 1, 1);
    tickFlags(ctf, deps(), DURATION);          // 进加时
    expect(ctf.outcome).toBeNull();

    // 蓝方在加时里完成一次交旗 —— 走真实状态机，不是直接改比分
    const blue = spawn(TEAM_BLUE, BLUE_BASE);
    giveFlag(blue);
    const carried = flagOf(ctf, TEAM_RED);
    expect(beginFlagInteract(ctf, blue, carried, DURATION + 1, inZone(TEAM_BLUE)))
      .toMatchObject({ ok: true, action: 'capture' });
    tickFlags(ctf, deps(), DURATION + 1 + CTF.CAPTURE_SECONDS);

    expect(ctf.score[String(TEAM_BLUE as number)]).toBe(2);
    expect(ctf.outcome, '加时里得了分却没有当场终局').toEqual({ winner: TEAM_BLUE });
  });

  it('★ 加时也不能无限拖：硬上限到点判平局', () => {
    ctf = timed();
    setScore(ctf, 1, 1);
    tickFlags(ctf, deps(), DURATION);
    tickFlags(ctf, deps(), DURATION + CTF.OVERTIME_HARD_CAP);
    expect(ctf.outcome).toEqual({ winner: 'draw' });
  });

  it('★ 12.1 先到目标分优先于时钟：常规时间内拿满就赢', () => {
    ctf = timed();
    setScore(ctf, ctf.scoreToWin, 1);
    tickFlags(ctf, deps(), 5);
    expect(ctf.outcome).toEqual({ winner: TEAM_RED });
  });

  it('★★ 不限时的一局（duration=0）行为一字不变：只有目标分一个出口', () => {
    // 试验场 CtfDemo 与一大票纯规则测试走的就是这条路
    setScore(ctf, 1, 0);
    tickFlags(ctf, deps(), 100_000);
    expect(ctf.outcome, '不限时的局被时钟判掉了').toBeNull();
    expect(ctfTimeRemaining(ctf, 100_000), '不限时却给出了倒计时').toBeUndefined();
  });

  it('★ 判过的胜负会冻住，不被后续 tick 改写', () => {
    ctf = timed();
    setScore(ctf, 2, 1);
    tickFlags(ctf, deps(), DURATION);
    setScore(ctf, 2, 9);                      // 事后有人往比分里塞了个数
    tickFlags(ctf, deps(), DURATION + 10);
    expect(ctf.outcome).toEqual({ winner: TEAM_RED });
  });

  it('★ resetCtf 把时钟与胜负一起归零（否则「再来一局」带着上局的终局开赛）', () => {
    ctf = timed();
    setScore(ctf, 2, 1);
    tickFlags(ctf, deps(), DURATION);
    expect(ctf.outcome).not.toBeNull();

    resetCtf(ctf, world, 500);
    expect(ctf.outcome).toBeNull();
    expect(ctf.overtimeSince).toBeNull();
    expect(ctfTimeRemaining(ctf, 500)).toBe(DURATION);
  });

  it('★★ 加时把复活波次切到 16 秒（12.6）—— setOvertime 的语义在这里钉住', () => {
    const s = createRespawn({ [TEAM_RED as number]: [RED_BASE] }, 0);
    expect(s.waveInterval).toBe(CTF.RESPAWN_WAVE_SECONDS);
    ctf = timed();
    setScore(ctf, 1, 1);
    tickFlags(ctf, deps(), DURATION);
    setOvertime(s, ctfInOvertime(ctf), DURATION);
    expect(s.waveInterval).toBe(CTF.RESPAWN_WAVE_SECONDS_OVERTIME);
    // 幂等：进加时之后每 tick 再调都不该重排波次（会白送复活）
    const at = s.nextWaveAt;
    setOvertime(s, ctfInOvertime(ctf), DURATION + 5);
    expect(s.nextWaveAt).toBe(at);
  });
});

