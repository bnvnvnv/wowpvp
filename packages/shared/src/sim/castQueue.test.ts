/**
 * 施法排队窗（P10 / 合同 C5）。
 *
 * ★★ **这个文件有两个互相制衡的任务：**
 *
 *   1. 证明**带** `queue` 的请求真的会在 GCD/读条结束的那一 tick 被补放
 *      —— 「GCD 1.0 秒内按早了直接被丢、结束也不补放」是真机审计坐实的，
 *      也是本作与 WoW 顺手感差得最远的一环。
 *   2. 证明**不带** `queue` 的请求（人机的每一条、`balance-report` 的每一条）
 *      行为与改动前**逐帧一致** —— 这是本批次的平衡红线，
 *      「★ 红线」那个 describe 就是为它写的，改排队逻辑时它必须一直绿。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { getSkill, mage, warrior } from '../data/index.js';
import { box } from '../data/maps/schema.js';
import { vec3 } from '../math/vec3.js';
import { ArenaPreset, CastFailure } from '../types/enums.js';
import { asSkillId, TEAM_BLUE, TEAM_RED, type EntityId } from '../types/ids.js';
import { createAuraStore } from './aura.js';
import { createArsenalStore, createPickupStore } from './arsenal.js';
import {
  CAST_QUEUE_WINDOW, createCastQueueStore, createCastingStore, isQueueableFailure,
  type CastQueueStore, type CastingStore,
} from './casting.js';
import { createDrStore } from './dr.js';
import { createEntity, type CombatEntity } from './entity.js';
import { createGroundStore } from './groundArea.js';
import { createLoadout, createLoadoutStore, createSwapStore } from './loadout.js';
import { createProjectileStore } from './projectile.js';
import { tickWorld, type CastIntent, type TickDeps } from './tick.js';
import { addEntity, allocEntityId, createWorld, type World } from './world.js';

const ground = box('g', 'floor', { x: 0, y: -1, z: 0 }, { w: 400, h: 1, d: 400 });
const DT = 0.05;

const ICE_LANCE = asSkillId('mage.ice_lance'); // 瞬发、无冷却、走 GCD —— 排队窗的标准被试
const FROSTBOLT = asSkillId('mage.frostbolt'); // 1.4 秒读条 —— 测 AlreadyCasting 那一支

interface CastLog { time: number; skillId: string }
interface FailLog extends CastLog { reason: CastFailure }
/** X21：排队窗过期通知（与 onFailed 分开的一路，见 CastEvents.onQueueExpired） */
interface ExpiredLog extends CastLog { waited: number }

interface Rig {
  world: World;
  casting: CastingStore;
  castQueue: CastQueueStore;
  player: CombatEntity;
  foe: CombatEntity;
  completed: CastLog[];
  failed: FailLog[];
  expired: ExpiredLog[];
  /** 把一次按键排进**下一个** tick 的请求集（与 MatchLoop/CombatDirector 同语义） */
  press: (skillId: typeof ICE_LANCE, queue?: boolean) => void;
  step: (ticks?: number) => void;
}

/**
 * 一套完整的 tickWorld 夹具。
 * @param withQueueStore false = 调用方**没传** `castQueue`（试验场未接线 /
 *   `balance-report` 的形态）—— 此时 `queue: true` 应当静默退化成老行为。
 */
const makeRig = (withQueueStore = true): Rig => {
  const world = createWorld([ground]);
  const casting = createCastingStore();
  const castQueue = createCastQueueStore();
  const loadouts = createLoadoutStore();
  const requests = new Map<EntityId, CastIntent>();
  const completed: CastLog[] = [];
  const failed: FailLog[] = [];
  const expired: ExpiredLog[] = [];

  const spawn = (cls: typeof mage, team: typeof TEAM_RED, z: number): CombatEntity => {
    const e = addEntity(world, createEntity(allocEntityId(world), cls, team, vec3(0, 0, z)));
    loadouts.set(e.id, createLoadout(e.classId));
    // 资源给满 —— 否则一切都会先撞到 NotEnoughResource，测的就不是排队窗了
    for (const [r, max] of e.maxResources) e.resources.set(r, max);
    return e;
  };
  const player = spawn(mage, TEAM_RED, 0);
  const foe = spawn(warrior, TEAM_BLUE, -10);

  // ★ 每个 rig 各一份，但在同一个 rig 内必须始终是**同一个对象**
  //   （光环、递减、冷却都存在里面）—— 所以建好再复用，不在 deps() 里现建
  const auras = createAuraStore();
  const dr = createDrStore();
  const groundStore = createGroundStore();
  const projectiles = createProjectileStore();
  const swaps = createSwapStore();
  const pickups = createPickupStore();
  const arsenal = createArsenalStore(ArenaPreset.Classic);
  const movement = new Map();
  const inputs = new Map();

  const deps = (): TickDeps => ({
    world, auras, dr, ground: groundStore, projectiles, casting,
    loadouts, swaps, pickups, arsenal,
    movement, inputs,
    castRequests: requests,
    ...(withQueueStore ? { castQueue } : {}),
    getSkill,
  });

  return {
    world, casting, castQueue, player, foe, completed, failed, expired,
    press: (skillId, queue) => {
      requests.set(player.id, {
        skillId,
        targetId: foe.id,
        ...(queue === true ? { queue: true } : {}),
      });
    },
    step: (ticks = 1) => {
      for (let i = 0; i < ticks; i++) {
        tickWorld(deps(), DT, {
          cast: {
            onCompleted: (_c, skill) =>
              completed.push({ time: world.time, skillId: skill.id as string }),
            onFailed: (_c, skill, reason) =>
              failed.push({ time: world.time, skillId: skill.id as string, reason }),
            onQueueExpired: (_c, skill, info) =>
              expired.push({ time: world.time, skillId: skill.id as string, waited: info.waited }),
          },
        });
        requests.clear();
      }
    },
  };
};

let rig: Rig;

beforeEach(() => {
  rig = makeRig();
});

/** 打一发 ice_lance 起 GCD（gcdUntil = 0.05 + 1.0 = 1.05） */
const openGcd = (r: Rig): void => {
  r.press(ICE_LANCE);
  r.step();
  expect(r.completed).toHaveLength(1);
};

// ════════════════════════════════════════════════════════════════

describe('合同 C5 —— 排队窗的基本行为', () => {
  it('★ GCD 内提前按 → GCD 结束的那一 tick 自动补放', () => {
    openGcd(rig);
    const gcdEnd = rig.player.gcdUntil;

    rig.step(17); // 推到 t≈0.90，仍在 GCD 里
    rig.press(ICE_LANCE, true);
    rig.step();
    expect(rig.completed).toHaveLength(1); // 还没放出来，排着
    expect(rig.castQueue.size).toBe(1);

    rig.step(10); // 越过 GCD
    expect(rig.completed).toHaveLength(2);
    const fired = rig.completed[1]!;
    expect(fired.skillId).toBe(ICE_LANCE as string);
    // ★ 「那一 tick」而不是「几 tick 之后」—— 排队窗省下的提前量不许在这里还回去
    expect(fired.time).toBeGreaterThanOrEqual(gcdEnd);
    expect(fired.time).toBeLessThan(gcdEnd + DT * 1.5);
    expect(rig.castQueue.size).toBe(0);
  });

  it('★ 排队期间不上报失败 —— 否则 HUD 上那句「公共冷却中」原样回来了', () => {
    openGcd(rig);
    rig.step(17);
    rig.press(ICE_LANCE, true);
    rig.step();
    expect(rig.failed).toEqual([]);
  });

  it('★ 超过 0.4 秒的窗口 → 不补放，也不迟到地弹一句失败', () => {
    openGcd(rig);
    rig.step(7); // t≈0.40，距 GCD 结束还有 0.65 秒，远超窗口
    rig.press(ICE_LANCE, true);
    rig.step(30); // 一路越过 GCD

    expect(rig.completed).toHaveLength(1); // 只有最初那一发
    expect(rig.failed).toEqual([]);
    expect(rig.castQueue.size).toBe(0);
  });

  it('窗口时长是 0.4 秒（占位值，改动前先读注释里的理由）', () => {
    expect(CAST_QUEUE_WINDOW).toBe(0.4);
  });

  /**
   * ★★ X21（拍板 2026-08-10）：过期不再**完全**静默 —— 走一路独立的
   *   `onQueueExpired`，而不是迟到 0.4 秒的 `onFailed(onGlobalCooldown)`。
   *   上一条测试（「不迟到地弹一句失败」）钉的是 `failed` 仍然为空，
   *   两条合起来才是完整语义：**换通道，不是加噪音**。
   */
  it('★★ X21：窗口过期 → 发一条 onQueueExpired（不是 onFailed）', () => {
    openGcd(rig);
    rig.step(7);
    rig.press(ICE_LANCE, true);
    rig.step(30);

    expect(rig.expired, '排队窗过期一声不吭 —— X21 的通知没接上').toHaveLength(1);
    expect(rig.expired[0]!.skillId).toBe(ICE_LANCE as string);
    // 刚过窗口就发，不是等到天荒地老（waited 略大于窗口，一个 tick 的粒度）
    expect(rig.expired[0]!.waited).toBeGreaterThan(CAST_QUEUE_WINDOW);
    expect(rig.expired[0]!.waited).toBeLessThan(CAST_QUEUE_WINDOW + DT * 2);
    // ★ 换通道不是加噪音：那条会误导人的失败提示仍然不发
    expect(rig.failed, '过期又把迟到的失败提示补上了').toEqual([]);
  });

  it('★★ X21：排队被成功消费 → 一条过期通知都不发', () => {
    openGcd(rig);
    rig.step(17);              // t≈0.90，还在 GCD 里，离窗口过期很远
    rig.press(ICE_LANCE, true);
    rig.step(10);              // 越过 GCD，排队的那一发被放出来

    expect(rig.completed).toHaveLength(2);
    expect(rig.expired, '技能明明放出来了却报了「没赶上」').toEqual([]);
  });

  it('★★ X21：二次失败走 onFailed，不重复报一条过期（两路不叠加）', () => {
    openGcd(rig);
    rig.step(17);
    rig.press(ICE_LANCE, true);
    rig.step();
    rig.foe.position = vec3(0, 0, -200);   // 这 0.4 秒里目标跑出射程
    rig.step(10);

    expect(rig.failed.map((f) => f.reason)).toEqual([CastFailure.OutOfRange]);
    expect(rig.expired, '同一次按键既报失败又报过期').toEqual([]);
  });

  it('★ 单槽：后按的覆盖先按的，GCD 结束只放最后那一个', () => {
    openGcd(rig);
    rig.step(17);
    rig.press(ICE_LANCE, true);
    rig.step();
    rig.press(FROSTBOLT, true); // 改主意
    rig.step();
    expect(rig.castQueue.size).toBe(1);

    rig.step(12);
    // 霜矢是读条技能：排队消费后进入施法状态，而不是立刻完成
    expect(rig.casting.has(rig.player.id)).toBe(true);
    expect(rig.completed).toHaveLength(1);
    rig.step(30); // 读完
    expect(rig.completed.map((c) => c.skillId)).toEqual([
      ICE_LANCE as string, FROSTBOLT as string,
    ]);
  });

  it('★ 读条中提前按（AlreadyCasting）→ 读条结束的同一 tick 接上', () => {
    rig.press(FROSTBOLT);
    rig.step();
    expect(rig.casting.has(rig.player.id)).toBe(true);

    rig.step(25); // t≈1.30，读条还剩 0.15 秒
    rig.press(ICE_LANCE, true);
    rig.step();
    expect(rig.castQueue.size).toBe(1);

    rig.step(6);
    expect(rig.completed.map((c) => c.skillId)).toEqual([
      FROSTBOLT as string, ICE_LANCE as string,
    ]);
    // ★ 两发在**同一 tick** 完成 —— 读条结束与排队起手之间不隔一个 tick
    expect(rig.completed[1]!.time).toBe(rig.completed[0]!.time);
  });

  it('★ 二次失败按普通失败上报（目标在这 0.4 秒里跑出了射程）', () => {
    openGcd(rig);
    rig.step(17);
    rig.press(ICE_LANCE, true);
    rig.step();
    expect(rig.failed).toEqual([]);

    rig.foe.position = vec3(0, 0, -200); // 跑到 200 米外
    rig.step(10);

    expect(rig.completed).toHaveLength(1);
    expect(rig.failed).toHaveLength(1);
    expect(rig.failed[0]!.reason).toBe(CastFailure.OutOfRange);
    expect(rig.castQueue.size).toBe(0);
  });

  it('重试走的是完整 validateCast —— 排队期间被沉默就放不出来', () => {
    openGcd(rig);
    rig.step(17);
    rig.press(ICE_LANCE, true);
    rig.step();

    rig.player.flags.silenced = true; // 冰枪术是冰霜魔法
    rig.step(10);

    expect(rig.completed).toHaveLength(1);
    expect(rig.failed.map((f) => f.reason)).toEqual([CastFailure.Silenced]);
  });

  it('施法者死亡 → 排队位清空，不会在复活后突然冒出来', () => {
    openGcd(rig);
    rig.step(17);
    rig.press(ICE_LANCE, true);
    rig.step();
    expect(rig.castQueue.size).toBe(1);

    rig.player.alive = false;
    rig.step();
    expect(rig.castQueue.size).toBe(0);
    expect(rig.completed).toHaveLength(1);
  });

  it('只有 OnGlobalCooldown / AlreadyCasting 值得排队', () => {
    expect(isQueueableFailure(CastFailure.OnGlobalCooldown)).toBe(true);
    expect(isQueueableFailure(CastFailure.AlreadyCasting)).toBe(true);
    // 这些是「玩家要做点什么」才能解决的，替他重试只会把失败拖晚 0.4 秒
    expect(isQueueableFailure(CastFailure.OutOfRange)).toBe(false);
    expect(isQueueableFailure(CastFailure.NotEnoughResource)).toBe(false);
    expect(isQueueableFailure(CastFailure.OnCooldown)).toBe(false);
    expect(isQueueableFailure(CastFailure.Silenced)).toBe(false);
  });
});

describe('★ 红线 —— 不带 queue 的请求必须与改动前逐帧一致', () => {
  it('★ 不带 queue：GCD 内按早了照旧被丢弃，且**立刻**上报失败', () => {
    openGcd(rig);
    rig.step(17);
    rig.press(ICE_LANCE); // 没有 queue —— 人机走的就是这条
    rig.step();

    expect(rig.failed).toHaveLength(1);
    expect(rig.failed[0]!.reason).toBe(CastFailure.OnGlobalCooldown);
    expect(rig.castQueue.size).toBe(0);

    rig.step(30); // GCD 早就过了
    expect(rig.completed).toHaveLength(1); // ★ 不补放
  });

  it('★ queue:true 但调用方没传 castQueue → 静默退化成老行为', () => {
    const noStore = makeRig(false);
    openGcd(noStore);
    noStore.step(17);
    noStore.press(ICE_LANCE, true);
    noStore.step(30);

    expect(noStore.completed).toHaveLength(1);
    expect(noStore.failed.map((f) => f.reason)).toEqual([CastFailure.OnGlobalCooldown]);
  });

  it('★★ 同一场景：接了排队 store 与没接的两个世界，逐条事件完全相同', () => {
    /**
     * 这是红线最直接的表述 —— 排队窗接上之后，**没带 queue 的那条路径**
     * 连一个事件、一点血量、一点资源都不许变。人机、balance-report 走的
     * 都是这条路径。
     */
    const play = (r: Rig) => {
      r.press(ICE_LANCE); r.step();
      r.step(17);
      r.press(ICE_LANCE); r.step();   // GCD 内，被丢
      r.step(10);
      r.press(ICE_LANCE); r.step();   // GCD 后，正常放
      r.step(20);
      return {
        completed: r.completed,
        failed: r.failed,
        time: r.world.time,
        gcdUntil: r.player.gcdUntil,
        mana: [...r.player.resources.entries()],
        foeHealth: r.foe.health,
      };
    };

    const withStore = makeRig(true);
    const without = makeRig(false);
    expect(play(withStore)).toEqual(play(without));
    // 排队 store 一次都没被写过
    expect(withStore.castQueue.size).toBe(0);
  });
});
