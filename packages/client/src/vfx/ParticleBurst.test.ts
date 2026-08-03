/**
 * 粒子池的**容量语义**。
 *
 * ★★ 这个文件测的是一条 bug 的结构性修复：拖尾此前每帧每弹体各占一个爆发槽
 *   （无计时器），24 发在飞时 60fps 下每秒申请 1440 次 emit ——
 *   32 格的池被自己刷空，命中爆发跟着一起没了。玩家看到的是「拖尾很稀」，
 *   而参数里写的一点都不稀。
 *
 *   修法是把持续型细流搬进**独立的池**，并让每格容量可配（细流稀而多、
 *   事件密而少）。这里钉住的就是「容量真的被隔离了」。
 *
 * ⚠️ three.js 的 BufferGeometry / Points 在 node 下可以构造（不需要 WebGL 上下文），
 *   所以这条测试不需要浏览器 —— 与 `vfx.test.ts` 只测纯数据是两回事。
 */

import { describe, expect, it } from 'vitest';
import { BurstPool, popAlpha, popSize } from './ParticleBurst.js';

const opts = (count: number) => ({
  origin: { x: 0, y: 0, z: 0 },
  count,
  primary: 0xff0000,
  secondary: 0x00ff00,
  texture: null,
  life: 0.5,
});

describe('BurstPool 容量', () => {
  it('emit 的 count 超过每格容量时被钳下来，不越界写缓冲', () => {
    const pool = new BurstPool(2, 12);
    // 40 > 12：钳到 12。越界的话 Float32Array 写入会静默丢弃或抛，
    // 两种都不该发生 —— 这里只要求它活着回来且被计为一发
    expect(() => pool.emit(opts(40))).not.toThrow();
    expect(pool.activeCount).toBe(1);
    pool.dispose();
  });

  it('count 小于 1 时兜到 1，不产生空爆发', () => {
    const pool = new BurstPool(2, 12);
    pool.emit(opts(0));
    expect(pool.activeCount).toBe(1);
    pool.dispose();
  });

  it('并发格子用满后回收最旧的一格，emit 永不被丢弃', () => {
    const pool = new BurstPool(2, 8);
    pool.emit(opts(4));
    pool.update(0.01);
    pool.emit(opts(4));
    pool.update(0.01);
    pool.emit(opts(4)); // 第三发：回收最旧的
    expect(pool.activeCount).toBe(2);
    pool.dispose();
  });

  it('寿命走完后格子释放回池', () => {
    const pool = new BurstPool(2, 8);
    pool.emit(opts(4));
    expect(pool.activeCount).toBe(1);
    // life 有 0.7~1.3 的随机抖动，跑够 2 秒必然全部走完
    pool.update(2);
    expect(pool.activeCount).toBe(0);
    pool.dispose();
  });

  it('★ 两个池互不影响 —— 细流打满不会占用事件池的格子', () => {
    const events = new BurstPool(2, 48);
    const streams = new BurstPool(4, 24);
    for (let i = 0; i < 10; i++) {
      streams.emit(opts(6));
      streams.update(0.016);
    }
    expect(streams.activeCount).toBe(4); // 打满
    expect(events.activeCount).toBe(0);  // 一格都没被吃掉
    events.emit(opts(20));
    expect(events.activeCount).toBe(1);
    events.dispose();
    streams.dispose();
  });
});

describe('popSize / popAlpha —— Q 版的「弹」在哪条通道上', () => {
  const SAMPLES = Array.from({ length: 201 }, (_, i) => i / 200);

  it('两条曲线都从 0 起、到 0 止（粒子不会突然出现或残留）', () => {
    expect(popSize(0)).toBeCloseTo(0, 6);
    expect(popSize(1)).toBeCloseTo(0, 6);
    expect(popAlpha(0)).toBeCloseTo(0, 6);
    expect(popAlpha(1)).toBeCloseTo(0, 6);
  });

  it('★★ 尺寸曲线**冲过 1**（这一下过冲就是 Q 版的识别特征）', () => {
    const peak = Math.max(...SAMPLES.map(popSize));
    expect(peak).toBeGreaterThan(1);
    // 上限：冲太狠会糊屏，且撞粒子着色器 320 像素的 clamp
    expect(peak).toBeLessThan(1.35);
  });

  it('★★ 不透明度曲线**恒不超过 1** —— 过冲接到 alpha 上会被截成平顶', () => {
    for (const t of SAMPLES) {
      expect(popAlpha(t)).toBeLessThanOrEqual(1);
      expect(popAlpha(t)).toBeGreaterThanOrEqual(0);
    }
  });

  it('★ 过冲出现在前半段 —— 读作「猛地炸开再松下来」而不是「结束前又胀一下」', () => {
    let peakAt = 0;
    let peak = -Infinity;
    for (const t of SAMPLES) {
      const v = popSize(t);
      if (v > peak) { peak = v; peakAt = t; }
    }
    expect(peakAt).toBeLessThan(0.5);
  });

  it('尺寸曲线全程非负（负数会让粒子翻面）', () => {
    for (const t of SAMPLES) expect(popSize(t)).toBeGreaterThanOrEqual(0);
  });

  /**
   * ★★ 这条是拿一次**白写**换来的：第一版把过冲写成「在 sin 上叠一项」，
   *   而 sin(πt) 要到 t=0.5 才够到 1、过冲项却必须在前段衰减掉 ——
   *   两个窗口不重叠，实测峰值只有 1.0095，肉眼完全看不出来。
   *   单测当时是绿的（峰值确实 >1），所以**只钉「峰值 >1」是不够的**，
   *   必须同时钉「起手足够快」，否则这条曲线可以悄悄退化回 sin。
   */
  it('★★ 起手必须极快：t=0.05 时已胀到六成以上（远快于 sin）', () => {
    expect(popSize(0.05)).toBeGreaterThan(0.6);
    expect(popSize(0.05)).toBeGreaterThan(Math.sin(0.05 * Math.PI) * 3);
  });

  it('★ 峰值明显早于中点 —— 是「攻」不是「胀」', () => {
    expect(popSize(0.22)).toBeGreaterThan(popSize(0.5));
  });

  it('定义域外被钳住，不产生 NaN', () => {
    for (const t of [-1, -0.001, 1.001, 2, 1e9]) {
      expect(Number.isFinite(popSize(t))).toBe(true);
      expect(Number.isFinite(popAlpha(t))).toBe(true);
    }
  });
});
