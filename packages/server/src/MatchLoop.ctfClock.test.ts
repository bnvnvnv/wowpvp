/**
 * A17 的**接线**验收：夺旗时限/加时真的从 sim 走到了 `MatchEnd` 与快照。
 *
 * ★★ **为什么必须有这个文件：**
 *
 *   `flag.test.ts` 钉的是规则本身（时间到比分高者胜、同分进加时、加时先
 *   得分者胜）。而本仓库栽过四次的坑恰恰不是规则写错，是**规则写对了
 *   没有人调用** —— A17 之前 `CTF.DURATION` 与 `setOvertime()` 就是两条
 *   零消费方的死代码，一躺就是从 M7 到今天。所以这里从服务器这一端问
 *   三个问题：`onEnd` 会不会被叫、快照里有没有「剩余时间」、加时的旗子
 *   有没有插上。
 *
 * ★ 手法与 `verify-m10` 一致：**白盒地布置**（把 60 秒时长改成 1 秒，
 *   否则要推 14400 个 tick），**黑盒地断言**（只看 onEnd 的回调与
 *   客户端收到的原始帧）。
 */

import { describe, expect, it } from 'vitest';
import {
  ArenaPreset, GameMode, Slot,
  asClassId, createMatch, createRoom, ctfMap, joinRoom,
  TEAM_BLUE, TEAM_RED,
  type MapId, type Match, type TeamId,
} from '@wowpvp/shared';

import { MatchLoop } from './MatchLoop.js';
import { createReconnectRegistry } from './room/reconnect.js';
import type { Session } from './room/Session.js';

/** 只造 MatchLoop 会读的那几个字段。★ `ackSeq` 不能省：快照帧模板会拼它 */
const fakeSession = (playerId: string, raw: string[]): Session =>
  ({
    playerId,
    isBot: false,
    ackSeq: 0,
    takeInputs: () => [],
    send: () => { /* 私信不在本文件范围 */ },
    sendRaw: (s: string) => raw.push(s),
    reject: () => { /* 不看拒绝 */ },
  } as unknown as Session);

interface Rig {
  match: Match;
  loop: MatchLoop;
  raw: string[];
  ended: (TeamId | 'draw')[];
}

const rig = (): Rig => {
  const room = createRoom('ctf', 'red1', {
    mode: GameMode.Ctf6v6,
    mapId: ctfMap.id as MapId,
    preset: ArenaPreset.Classic,
    roundsToWin: 3,
    allowUnbalanced: true,
    fillWithBots: false,
  });
  for (const [id, slot] of [['red1', Slot.Red], ['blue1', Slot.Blue]] as const) {
    const p = joinRoom(room, id, id);
    p.slot = slot;
    p.classId = asClassId('warrior');
    p.ready = true;
  }
  const match = createMatch(room, ctfMap);
  const raw: string[] = [];
  const ended: (TeamId | 'draw')[] = [];
  const loop = new MatchLoop(match, {
    sessions: () => [fakeSession('red1', raw), fakeSession('blue1', [])],
    reconnects: createReconnectRegistry(),
    onEliminate: () => { /* 本文件不关心 */ },
    onEnd: (w) => ended.push(w),
  });
  return { match, loop, raw, ended };
};

/** 最近一帧快照里的 match 段（快照是模板拼接的合法 JSON） */
const lastMatchSection = (raw: readonly string[]): Record<string, unknown> | undefined => {
  const snaps = raw.filter((s) => s.startsWith('{"t":"Snapshot"'));
  const last = snaps[snaps.length - 1];
  if (last === undefined) return undefined;
  return (JSON.parse(last) as { match: Record<string, unknown> }).match;
};

describe('A17 接线：夺旗时限从 sim 走到 MatchEnd 与快照', () => {
  it('★★ CTF.DURATION 真的进了对局（此前它是零消费方的常量）', () => {
    const { match } = rig();
    expect(match.ctf!.state.duration, '夺旗对局没有时长 —— A17 的接线断了')
      .toBe(720); // CTF.DURATION.ctf6v6
  });

  it('★★ 常规时间到、比分高者胜 → onEnd 被调用（联网夺旗有了自然终点）', () => {
    const r = rig();
    const ctf = r.match.ctf!.state;
    ctf.duration = 1;                                  // 白盒缩短，免推 14400 个 tick
    ctf.score[String(TEAM_RED as number)] = 1;

    for (let i = 0; i < 30 && r.ended.length === 0; i++) r.loop.advance();

    expect(r.ended, '时间到了但比赛没结束 —— MatchLoop 没消费 ctf.outcome')
      .toEqual([TEAM_RED]);
  });

  it('★★ 时间到平分 → 不结束、进加时，快照带上 overtime 旗子', () => {
    const r = rig();
    const ctf = r.match.ctf!.state;
    ctf.duration = 1;
    ctf.score[String(TEAM_RED as number)] = 1;
    ctf.score[String(TEAM_BLUE as number)] = 1;

    for (let i = 0; i < 30; i++) r.loop.advance();

    expect(r.ended, '平分被判掉了 —— 加时没生效').toEqual([]);
    expect(ctf.overtimeSince).not.toBeNull();
    const m = lastMatchSection(r.raw);
    expect(m?.overtime, '快照没告诉客户端已经进加时了').toBe(true);
    // ★ 12.6：加时波次 16 秒 —— setOvertime 的接线也在这一条里
    expect(r.match.respawn!.waveInterval).toBe(16);
  });

  it('★★ 快照带「比赛剩余时间」（15.4 右列那一栏此前只能空着）', () => {
    const r = rig();
    r.loop.advance();
    r.loop.advance();
    const m = lastMatchSection(r.raw);
    expect(typeof m?.timeRemaining, '快照里没有 timeRemaining').toBe('number');
    expect(m!.timeRemaining as number).toBeGreaterThan(700);
    expect(m!.timeRemaining as number).toBeLessThanOrEqual(720);
    // 还没到点，加时旗子不该出现（可选字段，缺席即 false）
    expect(m?.overtime).toBeUndefined();
  });
});
