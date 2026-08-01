/**
 * GameLoop 的顿帧安全边界 —— **本次改造最重要的一条测试**。
 *
 * ★★ 顿帧只许缩放渲染 dt。模拟步数、输入采样一旦被缩放：
 *   · 模拟步 → 客户端预测回放不再确定（docs/08 §5），作弊级 bug
 *   · 输入采样 → 顿帧期间「按了没反应」
 *
 * Node 里没有 rAF —— 手写可控的 rAF/时钟桩，每帧 16ms 手动驱动。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameLoop } from './GameLoop.js';

let now = 0;
let queue: FrameRequestCallback[] = [];

const drive = (loop: GameLoop, frames: number): void => {
  for (let i = 0; i < frames; i++) {
    now += 16;
    const cbs = queue;
    queue = [];
    for (const cb of cbs) cb(now);
  }
  loop.stop();
};

describe('★★ 顿帧只缩放渲染 dt', () => {
  beforeEach(() => {
    now = 0;
    queue = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      queue.push(cb);
      return queue.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => { queue = []; });
    vi.stubGlobal('performance', { now: () => now });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('★★ timeScale=0.06 时模拟步调用次数不变', () => {
    const run = (timeScale?: (d: number) => number): number => {
      now = 0;
      queue = [];
      let steps = 0;
      const loop = new GameLoop(() => { steps++; }, () => {}, undefined, 1 / 20, timeScale);
      loop.start();
      drive(loop, 30); // 480ms → 应跑 9 个 50ms 模拟步
      return steps;
    };
    const normal = run(undefined);
    const stopped = run(() => 0.06);
    expect(normal).toBeGreaterThan(5);
    expect(stopped, '顿帧改变了模拟步数 —— 预测确定性被破坏').toBe(normal);
  });

  it('★★ beforeFrame（输入采样）收到的 dt 未被缩放', () => {
    const dts: number[] = [];
    const loop = new GameLoop(() => {}, () => {}, (dt) => dts.push(dt), 1 / 20, () => 0.06);
    loop.start();
    drive(loop, 5);
    expect(dts.length).toBeGreaterThan(0);
    for (const dt of dts) expect(dt).toBeCloseTo(0.016, 3);
  });

  it('★★ render 的第二参被缩放、第三参 realDt 保持真实', () => {
    const frames: { dt: number; realDt: number }[] = [];
    const loop = new GameLoop(
      () => {},
      (_alpha, dt, realDt) => frames.push({ dt, realDt }),
      undefined,
      1 / 20,
      () => 0.06,
    );
    loop.start();
    drive(loop, 5);
    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) {
      expect(f.realDt).toBeCloseTo(0.016, 3);
      expect(f.dt).toBeCloseTo(0.016 * 0.06, 4);
    }
  });
});
