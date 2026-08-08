/**
 * A4（技术债总账）：人机选目标不透视。
 *
 * ★ `nearestFoe` 此前遍历全部实体不过可见性 —— 人机能感知未被发现的
 *   潜行者的精确坐标（「故意断线换 AI 代打」附带信息优势）。
 *   现在与快照裁剪用**同一个** `isVisibleTo`：人机看得见的 = 真人看得见的。
 */

import { describe, expect, it } from 'vitest';
import {
  ArenaPreset, GameMode, Slot,
  addEntity, allocEntityId, arena2v2, asClassId, createEntity, createMatch, createRoom,
  createWorld, isHealSkill, getSkill, joinRoom,
  mage, rogue, warrior, vec3, TEAM_BLUE, TEAM_RED,
  type ClassId, type EntityId, type MapId, type Match,
} from '@wowpvp/shared';
import { BotDriver, callFocusTarget, nearestFoe, pickFoe } from './BotDriver.js';

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

/**
 * B1：集火呼叫（用户反馈「BOT 都是单独行动，团队 PK 没有配合逻辑」）。
 *
 * ★★ P8 那版集火写着「集火是**涌现**的」—— 只对了一半：同一个评分函数确实
 *   人人都跑，**但每个人是按自己的位置评的**（`foeScore` 的距离项以 self 为
 *   原点），于是场地两头的两个队友常常评出两个不同的人。本组钉的就是补上的
 *   那一半：**按队算一次**呼叫，个体拿它当偏置。
 *
 * ⚠️ 全组最要紧的两条：呼叫**不扩大任何人的候选集**（A4 不透视），
 *   以及呼叫**推得动但拽不走**（SWITCH_HYSTERESIS 的粘性语义原样保留）。
 */
describe('B1 集火呼叫：按队商定一个目标', () => {
  /** 在 bot 同队（红队）造一个 z 米外的队友人机 */
  const botAt = (world: ReturnType<typeof createWorld>, z: number) =>
    addEntity(world, createEntity(allocEntityId(world), mage, TEAM_RED, vec3(0, 0, z)));

  it('★★ 呼叫是**全队**视角的最优，不是某一个人视角的最优', () => {
    const { world, bot, m } = setup();
    const nearFull = foeAt(world, 5, 1.0);   // 对 bot：100 + 10 = 110
    const farHurt = foeAt(world, 55, 0.4);   // 对 bot：40 + 110 = 150
    const flanker = botAt(world, 50);        // 对 flanker：farHurt = 40 + 10 = 50

    // 单看 bot 自己，他会打近处那个满血的
    expect(pickFoe(m, bot, 'hard')?.id).toBe(nearFull.id);
    // 全队一起看，残血那个只离侧翼队友 5 米 —— 该集火的是他
    expect(callFocusTarget(m, [bot, flanker])?.id).toBe(farHurt.id);
  });

  it('★★ 呼叫里不会出现未被发现的潜行者（A4 红线抬到队伍层同样成立）', () => {
    const { world, bot, m } = setup();
    const sneak = addEntity(
      world, createEntity(allocEntityId(world), rogue, TEAM_BLUE, vec3(0, 0, 3)),
    );
    sneak.health = sneak.maxHealth * 0.05; // 分数上是压倒性的首选
    sneak.flags.stealthed = true;
    const visible = foeAt(world, 30, 1.0);

    expect(callFocusTarget(m, [bot, botAt(world, 4)])?.id).toBe(visible.id);
  });

  it('★★ 粘性：新目标没好出 20 分 → 继续喊上一个（不然整队每 tick 一起横跳）', () => {
    const { world, bot, m } = setup();
    const called = foeAt(world, 10, 0.4);  // 40 + 20 = 60
    foeAt(world, 10, 0.2);                 // 40，恰好好 20 分 —— 判据含等号，不换

    expect(callFocusTarget(m, [bot], called.id)?.id).toBe(called.id);
  });

  it('★ 好得够多就改喊（粘性不是焊死）', () => {
    const { world, bot, m } = setup();
    const called = foeAt(world, 10, 0.4);   // 60
    const dying = foeAt(world, 10, 0.05);   // 25，好 35 分 > 20

    expect(callFocusTarget(m, [bot], called.id)?.id).toBe(dying.id);
  });

  it('★★ 上一次的呼叫死了 → 当场失效（记忆每 tick 都要重新过候选集）', () => {
    const { world, bot, m } = setup();
    const dead = foeAt(world, 3, 0.1);
    dead.alive = false;
    const alive = foeAt(world, 30, 1.0);

    expect(callFocusTarget(m, [bot], dead.id)?.id).toBe(alive.id);
  });

  it('★ 没有参与协作的人机 / 人机全躺下 → 没有呼叫（不抛错，也不乱喊）', () => {
    const { world, m } = setup();
    foeAt(world, 10, 1.0);
    expect(callFocusTarget(m, [])).toBeUndefined();

    const dead = setup();
    dead.bot.alive = false;
    foeAt(dead.world, 10, 1.0);
    expect(callFocusTarget(dead.m, [dead.bot])).toBeUndefined();
  });
});

describe('B1 集火呼叫：个体怎么用它（难度分档）', () => {
  it('★★ hard：呼叫给 25 分减免，把「稍差一点」的目标抬成首选', () => {
    const { world, bot, m } = setup();
    const mine = foeAt(world, 10, 0.5);    // 50 + 20 = 70
    const called = foeAt(world, 10, 0.6);  // 60 + 20 = 80 → 减免后 55

    expect(pickFoe(m, bot, 'hard')?.id).toBe(mine.id);                        // 没呼叫时
    expect(pickFoe(m, bot, 'hard', undefined, called.id)?.id).toBe(called.id); // 跟呼叫
  });

  it('★★ hard：呼叫的目标我看不见 → 当没喊过（A4：呼叫不扩大候选集）', () => {
    const { world, bot, m } = setup();
    const sneak = addEntity(
      world, createEntity(allocEntityId(world), rogue, TEAM_BLUE, vec3(0, 0, 3)),
    );
    sneak.flags.stealthed = true;
    const visible = foeAt(world, 30, 1.0);

    // 队友（站在他旁边的那个）看得见并喊了他 —— 对我依然是隐身的
    expect(pickFoe(m, bot, 'hard', undefined, sneak.id)?.id).toBe(visible.id);
  });

  it('★★ hard：呼叫**推得动**平手，但**拽不走**已经在打的残血目标', () => {
    const { world, bot, m } = setup();
    const dying = foeAt(world, 10, 0.2);   // 20 + 20 = 40
    const called = foeAt(world, 10, 0.6);  // 80 → 减免后 55，仍然差得多

    // 已经在打快死的那个 → 呼叫拽不走（粘性语义原样）
    expect(pickFoe(m, bot, 'hard', dying.id, called.id)?.id).toBe(dying.id);

    // 换成分数相当的当前目标 → 呼叫推得动（25 > 迟滞 20，这正是取 25 的理由）
    const tie = setup();
    const current = foeAt(tie.world, 10, 0.5);    // 70
    const tieCalled = foeAt(tie.world, 10, 0.5);  // 70 → 减免后 45
    expect(pickFoe(tie.m, tie.bot, 'hard', current.id, tieCalled.id)?.id).toBe(tieCalled.id);
  });

  it('★★ normal：跟呼叫转火（此前它眼里只有「最近的那个」）', () => {
    const { world, bot, m } = setup();
    const near = foeAt(world, 5, 1.0);
    const called = foeAt(world, 30, 0.3);

    expect(pickFoe(m, bot, 'normal')?.id).toBe(near.id);
    expect(pickFoe(m, bot, 'normal', undefined, called.id)?.id).toBe(called.id);
  });

  it('★ normal：呼叫的目标我看不见 → 回到最近敌人（A4 在 normal 路径上再验一遍）', () => {
    const { world, bot, m } = setup();
    const sneak = addEntity(
      world, createEntity(allocEntityId(world), rogue, TEAM_BLUE, vec3(0, 0, 3)),
    );
    sneak.flags.stealthed = true;
    const near = foeAt(world, 8, 1.0);

    expect(pickFoe(m, bot, 'normal', undefined, sneak.id)?.id).toBe(near.id);
  });

  it('★★ easy 不参与协作：喊破天也照旧打最近的（木桩手感是它的卖点）', () => {
    const { world, bot, m } = setup();
    const near = foeAt(world, 5, 1.0);
    const called = foeAt(world, 30, 0.05);

    expect(pickFoe(m, bot, 'easy', undefined, called.id)?.id).toBe(near.id);
  });

  it('★★ 没有呼叫时三档全部逐位走老路径（既有回归网一寸不动）', () => {
    const { world, bot, m } = setup();
    const near = foeAt(world, 5, 1.0);
    const hurt = foeAt(world, 30, 0.3);

    expect(pickFoe(m, bot, 'easy', undefined, undefined)?.id).toBe(near.id);
    expect(pickFoe(m, bot, 'normal', undefined, undefined)?.id).toBe(nearestFoe(m, bot)?.id);
    expect(pickFoe(m, bot, 'hard', undefined, undefined)?.id).toBe(hurt.id);
  });
});

/**
 * B1 接线：`tick()` 真的把呼叫与队友名册喂下去了。
 *
 * ★★ 上面两组都是**纯函数**级的：它们证明规则算得对，但证明不了规则被接上了。
 *   本组走真的 `Match` + 真的 `BotDriver`，断言落在**它发出的协议消息**上 ——
 *   与红线口径一致：人机的全部行为都必须在那几条 JSON 里看得见。
 *   （批出来的坑：`allies`/呼叫都是可选参数，忘了传就静默退化成 B1 之前，
 *   两组纯函数测试**一条都不会红**。）
 */
describe('B1 接线：驱动器把协同真的发了出去', () => {
  interface Rig {
    match: Match;
    driver: BotDriver;
    /** playerId → 这一 tick 发出的全部协议消息（已解析）*/
    sent: Map<string, Record<string, unknown>[]>;
    entity: (playerId: string) => ReturnType<typeof createEntity>;
  }

  /** 一局 2v2，四个席位全是人机（红队两个进驱动器，蓝队只当靶子）*/
  const rig = (classes: Record<string, string>): Rig => {
    const room = createRoom('r', 'redA', {
      mode: GameMode.Arena2v2,
      mapId: arena2v2.id as MapId,
      preset: ArenaPreset.Classic,
      roundsToWin: 1,
      allowUnbalanced: true,
      fillWithBots: false,
    });
    for (const [id, slot] of [
      ['redA', Slot.Red], ['redB', Slot.Red], ['blueX', Slot.Blue], ['blueY', Slot.Blue],
    ] as const) {
      const p = joinRoom(room, id, id);
      p.slot = slot;
      p.classId = asClassId(classes[id] ?? 'mage') as ClassId;
      p.ready = true;
    }
    const match = createMatch(room, arena2v2);
    const sent = new Map<string, Record<string, unknown>[]>();
    const driver = new BotDriver(() => match, (playerId, raw) => {
      const list = sent.get(playerId) ?? [];
      list.push(JSON.parse(raw) as Record<string, unknown>);
      sent.set(playerId, list);
    });
    return {
      match, driver, sent,
      entity: (playerId) => match.world.entities.get(match.entityOf.get(playerId)!)!,
    };
  };

  const castOf = (r: Rig, playerId: string): Record<string, unknown> | undefined =>
    r.sent.get(playerId)?.find((msg) => msg['t'] === 'CastRequest');
  const targetOf = (r: Rig, playerId: string): unknown =>
    r.sent.get(playerId)?.find((msg) => msg['t'] === 'SetTarget')?.['entityId'];

  it('★★ 牧师人机把奶按在受伤的队友身上（真的发出了 CastRequest）', () => {
    const r = rig({ redA: 'priest', redB: 'warrior' });
    r.driver.add({ playerId: 'redA', reason: 'fill', difficulty: 'normal' });
    const healer = r.entity('redA');
    const hurt = r.entity('redB');
    hurt.health = hurt.maxHealth * 0.2;
    // ★ 站到队友身边（出生点本来就同室，这一行只是把射程/视线的变数去掉）
    healer.position = { ...hurt.position, x: hurt.position.x + 3 };

    r.driver.tick();

    const cast = castOf(r, 'redA');
    const skill = getSkill(cast?.['skillId'] as never);
    expect(skill !== undefined && isHealSkill(skill), `实际发的是 ${cast?.['skillId']}`)
      .toBe(true);
    expect(cast?.['targetId']).toBe(hurt.id);
  });

  /**
   * ⚠️ 回归钉：这一条守的是「翻译层不许改写决策层挑好的目标」。
   *   原实现硬写 `targetId: foe.id`，于是**队向单体技能**（治疗、护盾、
   *   净化）全部被当成对敌施放 → `validateCast` 静默判掉 → 联网人机的
   *   HPS 恒为 0。自身增益走 `usesNoTarget` 分支，所以症状只在队向技能上出现。
   */
  it('★★ 自我治疗也发给自己（此前发给了敌人，被 validateCast 静默判掉）', () => {
    const r = rig({ redA: 'priest', redB: 'warrior' });
    r.driver.add({ playerId: 'redA', reason: 'fill', difficulty: 'normal' });
    const healer = r.entity('redA');
    healer.health = healer.maxHealth * 0.4; // 半血以下、保命线以上 → 走治疗步骤

    r.driver.tick();

    const cast = castOf(r, 'redA');
    const skill = getSkill(cast?.['skillId'] as never);
    expect(skill !== undefined && isHealSkill(skill), `实际发的是 ${cast?.['skillId']}`)
      .toBe(true);
    expect(cast?.['targetId']).toBe(healer.id);
  });

  it('★★ 同队两个 hard 人机在**本会各打各的**的局面下被呼叫拉到同一个目标', () => {
    const r = rig({});
    for (const id of ['redA', 'redB']) {
      r.driver.add({ playerId: id, reason: 'fill', difficulty: 'hard' });
    }
    /**
     * 白盒摆位，让「各打各的」成为可验证的前提而不是运气：
     *   redA(0) / redB(30)　blueX(12, 满血) / blueY(18, 90% 血)
     *   redA 视角：X=100+24=124、Y=90+36=126 → 打 X
     *   redB 视角：X=100+36=136、Y=90+24=114 → 打 Y
     * 呼叫取全队最优 = Y(114)，减免 25 后 redA 眼里 Y=101 < X=124 → 一起打 Y。
     */
    const at = (playerId: string, z: number, pct = 1): EntityId => {
      const e = r.entity(playerId);
      e.position = { x: 0, y: 0, z };
      e.health = e.maxHealth * pct;
      return e.id;
    };
    at('redA', 0); at('redB', 30);
    const x = at('blueX', 12, 1.0);
    const y = at('blueY', 18, 0.9);

    // 前提：没有协同时两人确实分头打（这一条红了说明夹具失效，不是功能坏了）
    expect(pickFoe(r.match, r.entity('redA'), 'hard')?.id).toBe(x);
    expect(pickFoe(r.match, r.entity('redB'), 'hard')?.id).toBe(y);

    r.driver.tick();

    expect(targetOf(r, 'redA')).toBe(y);
    expect(targetOf(r, 'redB')).toBe(y);
  });

  it('★★ 同一局面 easy 不参与协作 —— 各打各的（木桩手感是它的卖点）', () => {
    const r = rig({});
    for (const id of ['redA', 'redB']) {
      r.driver.add({ playerId: id, reason: 'fill', difficulty: 'easy' });
    }
    const at = (playerId: string, z: number, pct = 1): EntityId => {
      const e = r.entity(playerId);
      e.position = { x: 0, y: 0, z };
      e.health = e.maxHealth * pct;
      return e.id;
    };
    at('redA', 0); at('redB', 30);
    const x = at('blueX', 12, 1.0);
    const y = at('blueY', 18, 0.9);

    r.driver.tick();

    // easy 走「最近敌人」：redA 离 X 近（12 vs 18）、redB 离 Y 近（12 vs 18）
    expect(targetOf(r, 'redA')).toBe(x);
    expect(targetOf(r, 'redB')).toBe(y);
  });
});
