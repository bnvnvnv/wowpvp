/**
 * P10 平衡红线：**排队窗与 45 米选中强制只对真人生效。**
 *
 * ★★ **为什么必须有这个文件：**
 *
 *   任务书原本写着「先 grep 确认 bot 不走 setHardTarget（BotDriver 是直接
 *   赋值 targets.hard）」—— 这个前提是**错的**。`BotDriver` 发的是**真的**
 *   `SetTarget` / `CastRequest` 协议消息（那是 docs/14 §16b 的红线：人机走与
 *   真人完全相同的输入通道），于是它与真人一样落到 `MatchLoop.applyCommands`
 *   和 `MatchLoop.requestCast`。无脑给这两处开新行为 = normal 档人机当场变强。
 *
 *   所以两处都按 `Session.isBot` 分流，而分流这件事**没有任何类型能保证**，
 *   只能靠这里钉住。
 */

import { describe, expect, it } from 'vitest';
import {
  ArenaPreset, GameMode, Slot,
  arena2v2, asClassId, asSkillId, createMatch, createRoom, joinRoom,
  type Match, type MapId, type Room, type ServerMessage,
} from '@wowpvp/shared';

import { MatchLoop } from './MatchLoop.js';
import { createReconnectRegistry } from './room/reconnect.js';
import type { Session } from './room/Session.js';

const ICE_LANCE = asSkillId('mage.ice_lance');

/** 只造 MatchLoop 会读的那几个字段 —— 其余与本文件无关 */
const fakeSession = (playerId: string, isBot: boolean, out: ServerMessage[]): Session =>
  ({
    playerId,
    isBot,
    takeInputs: () => [],
    send: (m: ServerMessage) => out.push(m),
    sendRaw: () => { /* 不看消息 */ },
    reject: () => { /* 不看消息 */ },
  } as unknown as Session);

interface Rig { match: Match; loop: MatchLoop; room: Room; toHuman: ServerMessage[] }

/** 一局 2v2：human 是真人，botty 是人机席位 */
const rig = (): Rig => {
  const room = createRoom('r', 'human', {
    mode: GameMode.Arena2v2,
    mapId: arena2v2.id as MapId,
    preset: ArenaPreset.Classic,
    roundsToWin: 1,
    allowUnbalanced: true,
    fillWithBots: false,
  });
  for (const [id, slot] of [['human', Slot.Red], ['botty', Slot.Blue]] as const) {
    const p = joinRoom(room, id, id);
    p.slot = slot;
    p.classId = asClassId('mage');
    p.ready = true;
  }
  const match = createMatch(room, arena2v2);
  const toHuman: ServerMessage[] = [];
  const sessions = [fakeSession('human', false, toHuman), fakeSession('botty', true, [])];
  const loop = new MatchLoop(match, {
    sessions: () => sessions,
    reconnects: createReconnectRegistry(),
    onEliminate: () => { /* 本文件不关心 */ },
    onEnd: () => { /* 本文件不关心 */ },
  });
  return { match, loop, room, toHuman };
};

const entityOf = (m: Match, playerId: string) =>
  m.world.entities.get(m.entityOf.get(playerId)!)!;

describe('合同 C5 —— 排队窗只给真人开', () => {
  it('★ 真人在 GCD 内的第二次按键进排队窗', () => {
    const { match, loop } = rig();
    const me = entityOf(match, 'human');
    const foe = entityOf(match, 'botty');
    for (const [r, max] of me.maxResources) me.resources.set(r, max);
    me.position = { ...foe.position, x: foe.position.x + 5 };

    loop.requestCast('human', { skillId: ICE_LANCE, targetId: foe.id });
    loop.advance();
    expect(me.gcdUntil).toBeGreaterThan(match.world.time);

    loop.requestCast('human', { skillId: ICE_LANCE, targetId: foe.id });
    loop.advance();
    expect(match.castQueue.has(me.id)).toBe(true);
  });

  it('★★ 人机在 GCD 内的第二次按键**不**进排队窗（红线）', () => {
    const { match, loop } = rig();
    const bot = entityOf(match, 'botty');
    const foe = entityOf(match, 'human');
    for (const [r, max] of bot.maxResources) bot.resources.set(r, max);
    bot.position = { ...foe.position, x: foe.position.x + 5 };

    loop.requestCast('botty', { skillId: ICE_LANCE, targetId: foe.id });
    loop.advance();
    expect(bot.gcdUntil).toBeGreaterThan(match.world.time);

    loop.requestCast('botty', { skillId: ICE_LANCE, targetId: foe.id });
    loop.advance();
    expect(match.castQueue.size).toBe(0);
  });
});

describe('合同 C6 —— 45 米选中强制只对真人开', () => {
  it('★ 真人选 45 米外的目标被拒', () => {
    const { match, loop } = rig();
    const me = entityOf(match, 'human');
    const foe = entityOf(match, 'botty');
    foe.position = { x: me.position.x, y: me.position.y, z: me.position.z - 200 };

    loop.enqueue('human', { t: 'SetTarget', slot: 'hard', entityId: foe.id });
    loop.advance();
    expect(me.targets.hard).toBeUndefined();
  });

  /**
   * ⚠️ **如实钉住一个已知缺口**：这条拒绝目前**不回话**。
   *   理由与修法写在 `MatchLoop.applyCommands` 的 SetTarget 分支上
   *   （补 `Rejected` 会让 `room/RoomServer.test.ts` 那条「选中可见的敌人
   *   不会被拒绝」变红 —— 那条测试本身已经不成立了）。
   * ★ 写成断言而不是留一句注释：将来谁补上了回话，这条会红，
   *   于是他必然会去读上面那段说明，而不是「顺手补了但没人告诉他还要改测试」。
   */
  it('⚠️ 已知缺口：超距拒绝目前是静默的（补回话时请连同 RoomServer.test 一起改）', () => {
    const { match, loop, toHuman } = rig();
    const me = entityOf(match, 'human');
    const foe = entityOf(match, 'botty');
    foe.position = { x: me.position.x, y: me.position.y, z: me.position.z - 200 };

    loop.enqueue('human', { t: 'SetTarget', slot: 'hard', entityId: foe.id });
    loop.advance();
    expect(toHuman.filter((m) => m.t === 'Rejected')).toEqual([]);
  });

  it('★★ 人机选 45 米外的目标照旧成功（红线：人机也走 SetTarget 协议消息）', () => {
    const { match, loop } = rig();
    const bot = entityOf(match, 'botty');
    const foe = entityOf(match, 'human');
    foe.position = { x: bot.position.x, y: bot.position.y, z: bot.position.z - 200 };

    loop.enqueue('botty', { t: 'SetTarget', slot: 'hard', entityId: foe.id });
    loop.advance();
    expect(bot.targets.hard).toBe(foe.id);
  });

  it('真人选 45 米内的目标正常成功', () => {
    const { match, loop } = rig();
    const me = entityOf(match, 'human');
    const foe = entityOf(match, 'botty');
    foe.position = { x: me.position.x, y: me.position.y, z: me.position.z - 20 };

    loop.enqueue('human', { t: 'SetTarget', slot: 'hard', entityId: foe.id });
    loop.advance();
    expect(me.targets.hard).toBe(foe.id);
  });
});
