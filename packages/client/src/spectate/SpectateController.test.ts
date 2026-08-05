/**
 * 观战测试。规格书 11.4，docs/08 §4.3。
 *
 * ★ 重点是那条否定式规则：「不能自由镜头穿墙找潜行目标。」
 *   它成立的表现是「做不到某件事」，所以测试要去**尝试**做那件事。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  TEAM_BLUE, TEAM_RED, addEntity, allocEntityId, createEntity, createWorld,
  mage, priest, vec3, warrior, type CombatEntity, type World,
} from '@wowpvp/shared';
import { SpectateController, nextSpectateTarget } from './SpectateController.js';

let world: World;
let me: CombatEntity;
let mateA: CombatEntity;
let mateB: CombatEntity;
let foe: CombatEntity;
let ctl: SpectateController;

const spawn = (cls: typeof mage, team: typeof TEAM_RED, x = 0): CombatEntity =>
  addEntity(world, createEntity(allocEntityId(world), cls, team, vec3(x, 0, 0)));

beforeEach(() => {
  world = createWorld();
  me = spawn(mage, TEAM_RED, 0);
  mateA = spawn(priest, TEAM_RED, 5);
  mateB = spawn(warrior, TEAM_RED, 10);
  foe = spawn(warrior, TEAM_BLUE, 20);
  ctl = new SpectateController();
});

describe('11.4 只能跟随己方存活玩家', () => {
  it('可观战名单只含己方存活队友，不含自己与敌人', () => {
    const ids = ctl.available(world, me).map((e) => e.id as number);
    expect(ids).toEqual([mateA.id as number, mateB.id as number]);
  });

  it('循环切换按名单顺序推进并回卷', () => {
    expect(ctl.cycle(world, me)?.id).toBe(mateA.id);
    expect(ctl.cycle(world, me)?.id).toBe(mateB.id);
    expect(ctl.cycle(world, me)?.id).toBe(mateA.id);
  });

  it('死掉的队友不在名单里', () => {
    mateA.alive = false;
    expect(ctl.available(world, me).map((e) => e.id as number)).toEqual([mateB.id as number]);
  });

  it('宠物不能被观战', () => {
    const pet = addEntity(
      world,
      createEntity(allocEntityId(world), priest, TEAM_RED, vec3(3, 0, 0), { isPet: true }),
    );
    expect(ctl.available(world, me).map((e) => e.id as number)).not.toContain(pet.id as number);
  });
});

describe('★★ 11.4 不能自由镜头', () => {
  /**
   * ★★ 这条守的是**结构**：本类的状态里没有任何「自由镜头坐标」。
   *
   *   如果有一个 `freeCameraPosition` 或 `mode: 'follow' | 'free'`，
   *   那么把它设上之后观战就变成了透视 —— 而且是**免费**的透视，
   *   只要死一次就能拿到，于是「先送一个」会变成一种战术。
   */
  it('★★ 控制器的状态里没有任何自选坐标 / 自由镜头开关', () => {
    ctl.cycle(world, me);
    const state = Object.keys(ctl as unknown as Record<string, unknown>);
    for (const forbidden of ['freeCameraPosition', 'position', 'mode', 'detached', 'free']) {
      expect(state, `不该有 ${forbidden}`).not.toContain(forbidden);
    }
    // 唯一的状态就是「在跟谁」
    expect(state).toEqual(['followingId']);
  });

  it('★ 镜头位置只能由被跟随者推导，签名里没有自选坐标的余地', () => {
    mateA.position = vec3(7, 1, -3);
    expect(ctl.cameraTargetOf(mateA)).toEqual({ x: 7, y: 1, z: -3 });
  });

  /**
   * ★★ 被跟随的队友死了 → 自动切到下一个存活队友，而**不是**停在原地。
   *   停在原地就等于把镜头留在他倒下的位置继续看，又是一次自由镜头。
   */
  it('★★ 被跟随者死亡时自动切到下一个存活队友，不停在原地', () => {
    ctl.cycle(world, me);
    expect(ctl.following).toBe(mateA.id as number);

    mateA.alive = false;
    const resolved = ctl.resolve(world, me);
    expect(resolved?.id).toBe(mateB.id);
    expect(ctl.following).toBe(mateB.id as number);
  });

  /**
   * ★★ 全队阵亡时**退出**观战，而不是保持在最后一个位置。
   *   后者等于在全队死光后把镜头留在敌方半场 —— 正是自由镜头的效果。
   */
  it('★★ 全队阵亡时退出观战，不保留最后的镜头位置', () => {
    ctl.cycle(world, me);
    mateA.alive = false;
    mateB.alive = false;

    expect(ctl.resolve(world, me)).toBeUndefined();
    expect(ctl.active).toBe(false);
    expect(ctl.following).toBeNull();
  });

  it('★ 无法跟随敌人 —— 敌人根本不在名单里，cycle 也不会选到他', () => {
    for (let i = 0; i < 10; i++) {
      const t = ctl.cycle(world, me);
      expect(t?.id).not.toBe(foe.id);
    }
  });

  it('没有可跟随的队友时 cycle 返回 undefined 并保持未观战', () => {
    mateA.alive = false;
    mateB.alive = false;
    expect(ctl.cycle(world, me)).toBeUndefined();
    expect(ctl.active).toBe(false);
  });

  it('未进入观战时 resolve 返回 undefined', () => {
    expect(ctl.resolve(world, me)).toBeUndefined();
  });

  it('stop() 退出观战', () => {
    ctl.cycle(world, me);
    ctl.stop();
    expect(ctl.active).toBe(false);
  });
});

/**
 * W5（技术债总账）：联网侧的纯轮换函数。语义必须与 `SpectateController.cycle()`
 * 一字不差 —— 它是同一条 11.4 规则在快照数据上的形态（合法性权威在服务器）。
 */
describe('W5 nextSpectateTarget（联网快照轮换）', () => {
  const snap = (id: number, team: typeof TEAM_RED, alive = true) =>
    ({ id, team, alive });

  it('同队、存活、非自己；从当前目标的下一位环回', () => {
    const list = [snap(1, TEAM_RED), snap(2, TEAM_RED), snap(3, TEAM_RED), snap(9, TEAM_BLUE)];
    expect(nextSpectateTarget(list, 1, TEAM_RED, null)?.id).toBe(2);
    expect(nextSpectateTarget(list, 1, TEAM_RED, 2)?.id).toBe(3);
    expect(nextSpectateTarget(list, 1, TEAM_RED, 3)?.id).toBe(2); // 回卷
  });

  it('敌人与死者永远不是候选；无候选返回 undefined（= 显示死亡界面，不是留在原地看）', () => {
    const list = [snap(1, TEAM_RED), snap(2, TEAM_RED, false), snap(9, TEAM_BLUE)];
    expect(nextSpectateTarget(list, 1, TEAM_RED, null)).toBeUndefined();
  });

  it('当前目标已死时从头轮起（与 resolve 的自动换人同语义）', () => {
    const list = [snap(1, TEAM_RED), snap(2, TEAM_RED, false), snap(3, TEAM_RED)];
    expect(nextSpectateTarget(list, 1, TEAM_RED, 2)?.id).toBe(3);
  });
});
