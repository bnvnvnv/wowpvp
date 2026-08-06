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
import { nearestFoe, pickFoe } from './BotDriver.js';

const setup = () => {
  const world = createWorld();
  const bot = addEntity(world, createEntity(allocEntityId(world), mage, TEAM_RED, vec3(0, 0, 0)));
  // nearestFoe 只读 m.world 与 m.ctf —— 竞技场局 ctf 为 undefined
  const m = { world } as Match;
  return { world, bot, m };
};

/** 造一个 z 米外、血量为 pct 的蓝方战士 */
const foeAt = (world: ReturnType<typeof createWorld>, z: number, pct: number) => {
  const e = addEntity(world, createEntity(allocEntityId(world), warrior, TEAM_BLUE, vec3(0, 0, z)));
  e.health = e.maxHealth * pct;
  return e;
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

/**
 * B1：hard 档集火。
 *
 * ★★ 这里验的是「涌现」而不是「调度」：全队 hard 人机跑同一个确定性评分，
 *   于是各自独立评出同一个残血目标。所以测试只需要验**一个** bot 的评分
 *   结果 —— 队伍层面的集火是它的推论，不需要额外的协同机制。
 */
describe('B1：hard 档按血量集火', () => {
  it('★★ 近处满血 vs 远处残血 → hard 选残血的（评分：30 + 30*2 = 90 < 100 + 5*2 = 110）', () => {
    const { world, bot, m } = setup();
    foeAt(world, 5, 1.0);          // 5 米，满血
    const hurt = foeAt(world, 30, 0.3); // 30 米，30% 血

    expect(pickFoe(m, bot, 'hard')?.id).toBe(hurt.id);
  });

  it('★ 残血但够不着 → 不选（距离项有权重，够不着的残血是幻觉）', () => {
    const { world, bot, m } = setup();
    const near = foeAt(world, 2, 1.0);  // 2 米满血：100 + 4 = 104
    foeAt(world, 60, 0.05);             // 60 米 5% 血：5 + 120 = 125

    expect(pickFoe(m, bot, 'hard')?.id).toBe(near.id);
  });

  it('normal 档在同样场景仍选最近的（既有行为不回退）', () => {
    const { world, bot, m } = setup();
    const near = foeAt(world, 5, 1.0);
    foeAt(world, 30, 0.3);

    expect(pickFoe(m, bot, 'normal')?.id).toBe(near.id);
    expect(pickFoe(m, bot, 'easy')?.id).toBe(near.id);
    // 与 nearestFoe 逐字一致 —— easy/normal 就是它
    expect(pickFoe(m, bot, 'normal')?.id).toBe(nearestFoe(m, bot)?.id);
  });

  it('★★ hard 也不选未被发现的潜行者（A4 红线的回归钉：残血也不行）', () => {
    const { world, bot, m } = setup();
    const sneak = addEntity(world, createEntity(allocEntityId(world), rogue, TEAM_BLUE, vec3(0, 0, 3)));
    sneak.health = sneak.maxHealth * 0.05; // 3 米、5% 血 —— 分数上是压倒性的首选
    sneak.flags.stealthed = true;
    const far = foeAt(world, 30, 1.0);

    expect(pickFoe(m, bot, 'hard')?.id).toBe(far.id);
  });

  it('★ hard 全场只剩潜行者 → 无目标（与 nearestFoe 同一处境，不是瞎子）', () => {
    const { world, bot, m } = setup();
    const sneak = addEntity(world, createEntity(allocEntityId(world), rogue, TEAM_BLUE, vec3(0, 0, 5)));
    sneak.flags.stealthed = true;

    expect(pickFoe(m, bot, 'hard')).toBeUndefined();
  });

  it('宠物与队友照旧排除（hard 路径单独验一遍：候选集是抄不得的）', () => {
    const { world, bot, m } = setup();
    const ally = addEntity(world, createEntity(allocEntityId(world), warrior, TEAM_RED, vec3(0, 0, 1)));
    ally.health = ally.maxHealth * 0.05; // 残血队友：抄漏 isFriendly 就会选中它
    const pet = addEntity(world, createEntity(allocEntityId(world), warrior, TEAM_BLUE, vec3(0, 0, 2)));
    pet.isPet = true;
    pet.health = pet.maxHealth * 0.05;
    const real = foeAt(world, 20, 1.0);

    expect(pickFoe(m, bot, 'hard')?.id).toBe(real.id);
  });

  it('★ 当前目标死了 → 正常脱粘换新目标（死人不在候选集里）', () => {
    const { world, bot, m } = setup();
    const dead = foeAt(world, 3, 0.4);
    dead.alive = false;
    const alive = foeAt(world, 20, 1.0);

    expect(pickFoe(m, bot, 'hard', dead.id)?.id).toBe(alive.id);
  });
});

/**
 * 粘性（迟滞）。★ 换目标不是免费的 —— 要重新贴身、丢掉已铺的 DoT。
 *   两个敌人放同距离，让分差**只**来自血量，阈值就能被逐分验证。
 */
describe('B1：hard 换目标的迟滞阈值（占位值 20）', () => {
  it('★ 新目标只好 5 分（40% → 35% 血）→ 不换（低于阈值，防反复横跳）', () => {
    const { world, bot, m } = setup();
    const current = foeAt(world, 10, 0.4);  // 40 + 20 = 60
    foeAt(world, 10, 0.35);                 // 35 + 20 = 55，只好 5 分

    expect(pickFoe(m, bot, 'hard', current.id)?.id).toBe(current.id);
  });

  it('★ 新目标好 35 分（40% → 5% 血）→ 换（值得转火）', () => {
    const { world, bot, m } = setup();
    const current = foeAt(world, 10, 0.4);   // 60
    const dying = foeAt(world, 10, 0.05);    // 25，好 35 分 > 20

    expect(pickFoe(m, bot, 'hard', current.id)?.id).toBe(dying.id);
  });

  it('⚠️ 阈值边界：恰好好 20 分 → 不换（判据是 >= current - 20，含等号）', () => {
    const { world, bot, m } = setup();
    const current = foeAt(world, 10, 0.4);   // 60
    foeAt(world, 10, 0.2);                   // 40，恰好好 20 分

    expect(pickFoe(m, bot, 'hard', current.id)?.id).toBe(current.id);
  });

  it('没有当前目标（刚进场 / 上一个目标已死）→ 直接取最优，不受迟滞影响', () => {
    const { world, bot, m } = setup();
    foeAt(world, 10, 0.4);
    const best = foeAt(world, 10, 0.35);

    expect(pickFoe(m, bot, 'hard', undefined)?.id).toBe(best.id);
  });

  it('★ 迟滞只在 hard 生效：normal 传了 currentTargetId 也照旧只看距离', () => {
    const { world, bot, m } = setup();
    const far = foeAt(world, 30, 0.4);
    const near = foeAt(world, 5, 1.0);

    expect(pickFoe(m, bot, 'normal', far.id)?.id).toBe(near.id);
  });
});
