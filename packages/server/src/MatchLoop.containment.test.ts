/**
 * S5：**tick 异常的爆炸半径 = 单房间。**
 *
 * ★★ 在此之前 `pump()` 的 `setInterval` 回调没有 try/catch，而 tick 里
 *   `assertNoHiddenEntities` **设计上就会抛**（宁可断连也不透视）——
 *   于是一个房间的一个 bug = **整个进程崩，带走所有房间的所有比赛**。
 *   这一批把它收容到单房间：出错的房间判平局收场（服务器故障不该有人
 *   白赢白输），其余房间继续。
 *
 * ★ 用 monkeypatch 让 `advance()` 抛，而不是真的构造一个会触发
 *   `assertNoHiddenEntities` 的作弊局 —— 被测的是**收容**（pump 的 try/catch），
 *   不是哪一行会抛。异常来自哪里对收容行为没有影响，构造真作弊局只会
 *   把「测收容」变成「测怎么触发那一行」。
 */

import { describe, expect, it, vi } from 'vitest';

import { MatchLoop } from './MatchLoop.js';
import { createReconnectRegistry } from './room/reconnect.js';
import { onLog } from './log.js';

/** pump 在 advance 之前不读 match，塞个占位就够 —— 见文件头 */
const fakeMatch = { world: { time: 0 } } as never;

const makeLoop = (onEnd: (w: unknown) => void) =>
  new MatchLoop(fakeMatch, {
    sessions: () => [],
    reconnects: createReconnectRegistry(),
    roomId: 'r-boom',
    onEliminate: () => {},
    onEnd: onEnd as never,
    onPreTick: () => {},
  });

/** 让 accumulator 攒够至少一个 tick，逼 pump 进入 while 循环 */
const armPump = (loop: MatchLoop): void => {
  (loop as unknown as { lastRealMs: number }).lastRealMs = Date.now() - 100;
};
const pump = (loop: MatchLoop): void => {
  (loop as unknown as { pump: () => void }).pump();
};

describe('S5 tick 异常收容（爆炸半径 = 单房间）', () => {
  it('★★ advance 抛异常 → 房间判平局收场，不向上冒（不炸进程）', () => {
    const onEnd = vi.fn();
    const loop = makeLoop(onEnd);
    (loop as unknown as { advance: () => void }).advance = () => { throw new Error('boom'); };

    armPump(loop);
    // pump 本身不该抛 —— 抛了就意味着异常会一路冒到 setInterval 回调 = 进程崩
    expect(() => pump(loop)).not.toThrow();
    expect(onEnd).toHaveBeenCalledWith('draw');
  });

  it('★★ 出错后循环停手 —— 不会每个 tick 反复抛、反复收场', () => {
    const onEnd = vi.fn();
    const loop = makeLoop(onEnd);
    let calls = 0;
    (loop as unknown as { advance: () => void }).advance = () => { calls++; throw new Error('boom'); };

    armPump(loop); pump(loop);
    armPump(loop); pump(loop); // 再泵一次

    expect(calls, 'ended 之后不该再进 advance').toBe(1);
    expect(onEnd, 'onEnd 只该收场一次').toHaveBeenCalledTimes(1);
  });

  it('★ 异常写进结构化日志（判据：过载/故障可见），含房间 id 与 tick', () => {
    const events: { event: string; fields: Record<string, unknown> }[] = [];
    onLog((_l, event, fields) => events.push({ event, fields }));
    try {
      const loop = makeLoop(() => {});
      (loop as unknown as { advance: () => void }).advance = () => { throw new Error('boom-xyz'); };
      armPump(loop); pump(loop);

      const err = events.find((e) => e.event === 'tick_error');
      expect(err, '未记录 tick_error').toBeDefined();
      expect(err!.fields['roomId']).toBe('r-boom');
      expect(String(err!.fields['error'])).toContain('boom-xyz');
    } finally {
      onLog(undefined);
    }
  });

  it('★ 收场函数(onEnd)自己也抛时不二次冒泡（记 tick_error_onend_failed）', () => {
    const events: string[] = [];
    onLog((_l, event) => events.push(event));
    try {
      const loop = makeLoop(() => { throw new Error('onEnd 也炸了'); });
      (loop as unknown as { advance: () => void }).advance = () => { throw new Error('boom'); };
      armPump(loop);
      expect(() => pump(loop)).not.toThrow();
      expect(events).toContain('tick_error_onend_failed');
    } finally {
      onLog(undefined);
    }
  });
});
