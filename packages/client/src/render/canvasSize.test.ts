/**
 * P4：画布尺寸缓存。
 *
 * ★★ 这条优化的价值全在「**没读**布局属性」上 —— 而「没做某件事」是测试
 *   最容易漏掉的一类断言。这里用一个会数自己被读了几次的假元素来钉它：
 *   读的次数不对，性能就悄悄退回去了，画面上一个像素都不会变。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { canvasSize, invalidateCanvasSizes } from './canvasSize.js';

/** 会记账的假画布。`WeakMap` 不挑对象类型，普通对象就够 */
const fakeCanvas = (w = 1280, h = 720): { el: HTMLElement; reads: () => number; resize: (w: number, h: number) => void } => {
  let reads = 0;
  let cw = w;
  let ch = h;
  const el = {
    get clientWidth(): number { reads++; return cw; },
    get clientHeight(): number { reads++; return ch; },
  } as unknown as HTMLElement;
  return { el, reads: () => reads, resize: (nw, nh) => { cw = nw; ch = nh; } };
};

describe('canvasSize', () => {
  beforeEach(() => { invalidateCanvasSizes(); });

  it('★★ 一帧里读一百次，只碰一次布局', () => {
    const c = fakeCanvas();
    for (let i = 0; i < 100; i++) canvasSize(c.el);
    // 一次调用读 clientWidth + clientHeight 各一次
    expect(c.reads()).toBe(2);
  });

  it('返回的尺寸是对的', () => {
    const c = fakeCanvas(1600, 900);
    expect(canvasSize(c.el)).toMatchObject({ w: 1600, h: 900 });
  });

  it('★ 失效之后重新读一次 —— 缓存不能把改过的尺寸吃掉', () => {
    const c = fakeCanvas(1280, 720);
    expect(canvasSize(c.el).w).toBe(1280);
    c.resize(800, 600);
    // 还没失效：仍然是旧值（这正是「缓存」的定义，也是它唯一的风险）
    expect(canvasSize(c.el).w).toBe(1280);
    invalidateCanvasSizes();
    expect(canvasSize(c.el)).toMatchObject({ w: 800, h: 600 });
    expect(c.reads()).toBe(4);
  });

  it('★ 两张画布各缓存各的（大厅是每局新建一张）', () => {
    const a = fakeCanvas(100, 50);
    const b = fakeCanvas(200, 100);
    expect(canvasSize(a.el).w).toBe(100);
    expect(canvasSize(b.el).w).toBe(200);
    expect(canvasSize(a.el).w).toBe(100);
    expect(a.reads()).toBe(2);
    expect(b.reads()).toBe(2);
  });
});
