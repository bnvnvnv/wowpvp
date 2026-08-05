/**
 * A4（技术债总账）：人机选目标不透视。
 *
 * ★ `nearestFoe` 此前遍历全部实体不过可见性 —— 人机能感知未被发现的
 *   潜行者的精确坐标（「故意断线换 AI 代打」附带信息优势）。
 *   现在与快照裁剪用**同一个** `isVisibleTo`：人机看得见的 = 真人看得见的。
 */

import { describe, expect, it } from 'vitest';
import {
  addEntity, allocEntityId, createEntity, createWorld,
  mage, rogue, warrior, vec3, TEAM_BLUE, TEAM_RED,
  type Match,
} from '@wowpvp/shared';
import { nearestFoe } from './BotDriver.js';

const setup = () => {
  const world = createWorld();
  const bot = addEntity(world, createEntity(allocEntityId(world), mage, TEAM_RED, vec3(0, 0, 0)));
  // nearestFoe 只读 m.world 与 m.ctf —— 竞技场局 ctf 为 undefined
  const m = { world } as Match;
  return { world, bot, m };
};

describe('A4：人机选目标过可见性', () => {
  it('★★ 未被发现的潜行者不进人机的目标候选（更近也不行）', () => {
    const { world, bot, m } = setup();
    const sneak = addEntity(world, createEntity(allocEntityId(world), rogue, TEAM_BLUE, vec3(0, 0, 5)));
    const far = addEntity(world, createEntity(allocEntityId(world), warrior, TEAM_BLUE, vec3(0, 0, 30)));
    sneak.flags.stealthed = true;

    // 潜行者在 5 米（更近），但人机必须选 30 米外那个可见的
    expect(nearestFoe(m, bot)?.id).toBe(far.id);
  });

  it('★ 全场只剩潜行者 → 无目标（原地待机，与真人处境一致，不是瞎子）', () => {
    const { world, bot, m } = setup();
    const sneak = addEntity(world, createEntity(allocEntityId(world), rogue, TEAM_BLUE, vec3(0, 0, 5)));
    sneak.flags.stealthed = true;

    expect(nearestFoe(m, bot)).toBeUndefined();
  });

  it('★ 潜行者被发现（stealthRevealed）的瞬间照常进入候选', () => {
    const { world, bot, m } = setup();
    const sneak = addEntity(world, createEntity(allocEntityId(world), rogue, TEAM_BLUE, vec3(0, 0, 5)));
    sneak.flags.stealthed = true;
    sneak.flags.stealthRevealed = true;

    expect(nearestFoe(m, bot)?.id).toBe(sneak.id);
  });

  it('可见敌人正常按最近挑选（宠物与队友照旧排除）', () => {
    const { world, bot, m } = setup();
    addEntity(world, createEntity(allocEntityId(world), warrior, TEAM_RED, vec3(0, 0, 2))); // 队友
    const near = addEntity(world, createEntity(allocEntityId(world), warrior, TEAM_BLUE, vec3(0, 0, 8)));
    addEntity(world, createEntity(allocEntityId(world), warrior, TEAM_BLUE, vec3(0, 0, 20)));

    expect(nearestFoe(m, bot)?.id).toBe(near.id);
  });
});
