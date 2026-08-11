/**
 * W26：生命上限**不再是「一局不变」**之后，P11 的静态块通道必须跟上。
 *
 * ★★ **这条测试守的是一个不会报错的窗口。**
 *   P11 波3 把 `maxHealth` 从每 tick 的实体段搬进了 `EntityMeta` 的
 *   「首见即发」静态块，理由写着「一局内不变」。W26 给德鲁伊熊形态接上
 *   `maxHealth: 1.2` 之后那句话不再成立：服务器算的是 1260，客户端手里
 *   还是开局那份 1050 —— 而快照里的 `health` 是**对的**，于是熊满血在
 *   血条上画成 120%，没有任何一层会报错、没有任何既有断言会红。
 *
 * ★ 补发走的是与装备完全同一套「指纹变了才发」的路，不是把字段塞回每 tick
 *   的实体段（P11 实测 306KB/s/客户端，变身是稀有事件，不值得那个价钱）。
 */

import { describe, expect, it } from 'vitest';
import {
  ArenaPreset, GameMode, Slot,
  arena2v2, asClassId, asSkillId, createMatch, createRoom, joinRoom,
  type Match, type ServerMessage,
} from '@wowpvp/shared';

import { MatchLoop } from './MatchLoop.js';
import { createReconnectRegistry } from './room/reconnect.js';
import type { Session } from './room/Session.js';

const fakeSession = (playerId: string, out: ServerMessage[]): Session =>
  ({
    playerId,
    isBot: false,
    ackSeq: 0,
    following: undefined,
    takeInputs: () => [],
    send: (m: ServerMessage) => out.push(m),
    sendRaw: (raw: string) => out.push(JSON.parse(raw) as ServerMessage),
    reject: () => { /* 不看消息 */ },
  } as unknown as Session);

const rig = () => {
  const room = createRoom('r', 'human', {
    mode: GameMode.Arena2v2,
    mapId: arena2v2.id,
    preset: ArenaPreset.Classic,
    roundsToWin: 1,
    allowUnbalanced: true,
    fillWithBots: false,
    bossEnabled: false,
  });
  for (const [id, slot] of [['human', Slot.Red], ['foe', Slot.Blue]] as const) {
    const p = joinRoom(room, id, id);
    p.slot = slot;
    // 德鲁伊：全仓唯一带 maxHealth 修正的职业（熊形态 1.2）
    p.classId = asClassId('druid');
    p.ready = true;
  }
  const match = createMatch(room, arena2v2);
  const out: ServerMessage[] = [];
  const sessions = [fakeSession('human', out), fakeSession('foe', [])];
  const loop = new MatchLoop(match, {
    sessions: () => sessions,
    reconnects: createReconnectRegistry(),
    onEliminate: () => { /* 不关心 */ },
    onEnd: () => { /* 不关心 */ },
  });
  return { match, loop, out };
};

const entityOf = (m: Match, playerId: string) =>
  m.world.entities.get(m.entityOf.get(playerId)!)!;

/** 该会话收到的、关于这个实体的全部静态块（按到达顺序）*/
const staticsFor = (out: readonly ServerMessage[], id: number) =>
  out
    .filter((m) => m.t === 'EntityMeta')
    .flatMap((m) => m.items.filter((it) => (it.entityId as number) === id && it.statics))
    .map((it) => it.statics!);

describe('W26：生命上限变化后静态块补发', () => {
  it('★★ 变熊之后补发一份新的 statics，maxHealth 跟到 1260', () => {
    const r = rig();
    for (let i = 0; i < 4; i++) r.loop.advance();
    const me = entityOf(r.match, 'human');
    const id = me.id as number;

    const first = staticsFor(r.out, id);
    expect(first.length, '首见静态块没发').toBeGreaterThan(0);
    expect(first[first.length - 1]!.maxHealth).toBe(1050);

    // 真的放一次巨熊形态（瞬发、无消耗），走服务器那条真路径
    r.loop.requestCast('human', { skillId: asSkillId('druid.bear_form') });
    for (let i = 0; i < 6; i++) r.loop.advance();

    expect(me.maxHealth, 'sim 侧上限没涨 —— 这条测的就不是快照了').toBeCloseTo(1260, 6);
    const after = staticsFor(r.out, id);
    expect(after.length, '上限变了却没补发静态块').toBeGreaterThan(first.length);
    expect(after[after.length - 1]!.maxHealth).toBeCloseTo(1260, 6);
  });

  it('★★ 不变身就不补发：静态块仍然是「首见一次」的稀有消息', () => {
    const r = rig();
    for (let i = 0; i < 60; i++) r.loop.advance();
    const id = entityOf(r.match, 'human').id as number;
    /**
     * ★ 断言的是**条数**而不是「一条都没多」：装备指纹变化也会带 statics
     *   以外的字段，这里只盯住 statics 本身。60 个 tick（3 秒）里没有任何
     *   人变身，所以每个实体应当只有首见那一份。
     */
    expect(staticsFor(r.out, id)).toHaveLength(1);
  });
});
