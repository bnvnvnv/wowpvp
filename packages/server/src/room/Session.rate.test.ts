/**
 * S1 入站限流的单元测试（令牌桶 + 持续滥用断开）。
 *
 * ★ 用**假 socket**而不是真连接：令牌桶的判定是纯逻辑（时间 + 计数），
 *   真 socket 只会引入端口与异步的噪音。真连接那一侧的验证在
 *   hardening.test.ts（灌注 → 断开 → 他连不受影响）。
 *
 * ⚠️ 令牌桶按 `Date.now()` 回填 —— 测试不能靠 sleep 等真实时间（慢且脆）。
 *    这里让**容量**决定突发额度、把回填设 0，于是「发满容量 → 第 N+1 条被丢」
 *    是确定性的，不依赖时钟推进。回填的时间行为另有一条针对性断言。
 */

import { describe, expect, it, vi } from 'vitest';
import { encodeClientMessage, type ClientMessage } from '@wowpvp/shared';

import { Session, SessionPhase, type RateLimitConfig, type SessionSocket } from './Session.js';
import { onLog } from '../log.js';

/** 只记录行为、不真的发网的假 socket */
const fakeSocket = () => {
  const sent: string[] = [];
  let terminated = false;
  let closed = false;
  const socket: SessionSocket & { sent: string[]; terminated: boolean } = {
    send: (d) => { sent.push(d); },
    close: () => { closed = true; },
    terminate: () => { terminated = true; },
    get closed() { return closed; },
    get sent() { return sent; },
    get terminated() { return terminated; },
  };
  return socket;
};

const input = (seq: number): string =>
  encodeClientMessage({
    t: 'Input', seq, dt: 0.05, forward: 0, strafe: 0, characterYaw: 0, jump: false,
  } as ClientMessage);

describe('S1 令牌桶限流', () => {
  it('★ 容量内的消息全部通过', () => {
    const socket = fakeSocket();
    let delivered = 0;
    const rate: RateLimitConfig = { capacity: 10, refillPerSec: 0, disconnectAfterDropped: 100 };
    const s = new Session(socket, 'p1', () => { delivered++; }, rate);

    // Input 不进 onMessage（它排进 inputQueue），改用一条会分发的消息数通过量：
    // 这里直接数「没被限流丢弃」—— 用 droppedByRate 反推
    for (let i = 0; i < 10; i++) s.handleRaw(input(i));
    expect(s.droppedByRate).toBe(0);
    void delivered;
  });

  it('★★ 超过容量的消息被丢弃（回填为 0 时确定性）', () => {
    const socket = fakeSocket();
    const rate: RateLimitConfig = { capacity: 10, refillPerSec: 0, disconnectAfterDropped: 100 };
    const s = new Session(socket, 'p1', () => {}, rate);

    for (let i = 0; i < 25; i++) s.handleRaw(input(i));
    // 10 通过、15 丢弃
    expect(s.droppedByRate).toBe(15);
  });

  it('★★ 被限流丢弃的消息不回 Rejected（回复比丢弃贵，会把入站洪水放大成出站洪水）', () => {
    const socket = fakeSocket();
    const rate: RateLimitConfig = { capacity: 2, refillPerSec: 0, disconnectAfterDropped: 100 };
    const s = new Session(socket, 'p1', () => {}, rate);
    // Input 是 MATCH_ONLY —— 置 Match 阶段，通过限流的那 2 条会被静默排进
    // inputQueue（不发 Rejected）；被限流丢弃的更不该发。于是「一条 Rejected
    // 都没有」精确地只归因于限流行为，不掺进阶段鉴权的噪音
    s.phase = SessionPhase.Match;

    for (let i = 0; i < 20; i++) s.handleRaw(input(i));
    expect(s.droppedByRate).toBeGreaterThan(0);
    expect(socket.sent.filter((raw) => raw.includes('Rejected'))).toHaveLength(0);
  });

  it('★★ 持续滥用累计到阈值 → terminate（不是优雅 close）', () => {
    const socket = fakeSocket();
    const rate: RateLimitConfig = { capacity: 1, refillPerSec: 0, disconnectAfterDropped: 5 };
    const s = new Session(socket, 'p1', () => {}, rate);

    // 容量 1：第 1 条过，之后每条都丢；丢到第 5 条时断开
    for (let i = 0; i < 6; i++) s.handleRaw(input(i));
    expect(s.droppedByRate).toBe(5);
    expect(socket.terminated).toBe(true);
  });

  it('★ 断开事件写进结构化日志（判据：持续滥用可见）', () => {
    const events: string[] = [];
    onLog((_level, event) => events.push(event));
    try {
      const socket = fakeSocket();
      const rate: RateLimitConfig = { capacity: 1, refillPerSec: 0, disconnectAfterDropped: 3 };
      const s = new Session(socket, 'flooder', () => {}, rate);
      for (let i = 0; i < 4; i++) s.handleRaw(input(i));
      expect(events).toContain('rate_limited');
      expect(events).toContain('rate_flood_disconnect');
    } finally {
      onLog(undefined);
    }
  });

  it('★★ 回填随时间恢复额度（令牌桶不是一次性配额）', () => {
    const socket = fakeSocket();
    const rate: RateLimitConfig = { capacity: 5, refillPerSec: 100, disconnectAfterDropped: 999 };

    // 冻结时钟：构造在 T=1000
    const spy = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const s = new Session(socket, 'p1', () => {}, rate);
      for (let i = 0; i < 5; i++) s.handleRaw(input(i)); // 花光 5 个
      s.handleRaw(input(5));
      expect(s.droppedByRate).toBe(1); // 第 6 条：额度已空

      // 时间推进 100ms：回填 100/s × 0.1s = 10 个（封顶到容量 5）
      spy.mockReturnValue(1100);
      for (let i = 0; i < 5; i++) s.handleRaw(input(10 + i));
      expect(s.droppedByRate, '回填后应有新额度，丢弃数不该再涨').toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('★ 人机会话（isBot）完全跳过限流 —— 服务器自造的流量不该被自己限', () => {
    const base = fakeSocket();
    const botSocket: SessionSocket = { ...base, isBot: true, get closed() { return false; } };
    const rate: RateLimitConfig = { capacity: 1, refillPerSec: 0, disconnectAfterDropped: 2 };
    const s = new Session(botSocket, 'bot1', () => {}, rate);

    for (let i = 0; i < 50; i++) s.handleRaw(input(i));
    expect(s.droppedByRate).toBe(0);
  });

  it('★ 不传 rate 的会话不限流（既有单测/纯逻辑路径不变）', () => {
    const socket = fakeSocket();
    const s = new Session(socket, 'p1', () => {}); // 无 rate
    for (let i = 0; i < 1000; i++) s.handleRaw(input(i));
    expect(s.droppedByRate).toBe(0);
  });
});
