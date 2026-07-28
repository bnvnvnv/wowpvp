/**
 * 动作状态机测试。对应规格书 13.4 与验收 #47。
 */

import { describe, expect, it } from 'vitest';
import { ANIM, AnimState, AnimationController, type AnimSample } from './AnimationController.js';

const DT = 1 / 60;

const sample = (over: Partial<AnimSample> = {}): AnimSample => ({
  horizontalDistance: 0,
  dt: DT,
  grounded: true,
  verticalVelocity: 0,
  teleported: false,
  forward: 0,
  strafe: 0,
  ...over,
});

/** 以给定速度跑 n 帧 */
const runAt = (c: AnimationController, speed: number, frames: number, over: Partial<AnimSample> = {}) => {
  for (let i = 0; i < frames; i++) {
    c.update(sample({ horizontalDistance: speed * DT, forward: speed > 0 ? 1 : 0, ...over }));
  }
};

describe('13.4 / 验收 #47 — 状态不因单帧抖动反复切换', () => {
  it('★ 速度在 Run 阈值上抖动时不会每帧闪烁', () => {
    const c = new AnimationController();
    runAt(c, 7, 60); // 稳定在 Run
    expect(c.state).toBe(AnimState.Run);

    // 让原始速度在 ENTER_RUN(4.0) 附近来回跳
    let switches = 0;
    let prev = c.state;
    for (let i = 0; i < 120; i++) {
      const speed = i % 2 === 0 ? 4.2 : 3.8;
      c.update(sample({ horizontalDistance: speed * DT, forward: 1 }));
      if (c.state !== prev) switches++;
      prev = c.state;
    }
    // 迟滞 + 平滑之后，最多允许一次真实的状态转移
    expect(switches).toBeLessThanOrEqual(1);
  });

  it('没有迟滞的话会闪烁 —— 对照：原始速度确实在阈值两侧', () => {
    // 这条只是确认上面那个测试的输入是有意义的
    expect(4.2).toBeGreaterThan(ANIM.ENTER_RUN);
    expect(3.8).toBeLessThan(ANIM.ENTER_RUN);
  });

  it('待机 ↔ 行走之间也有迟滞', () => {
    const c = new AnimationController();
    runAt(c, 1, 60);
    expect(c.state).toBe(AnimState.Walk);

    let switches = 0;
    let prev = c.state;
    for (let i = 0; i < 120; i++) {
      const speed = i % 2 === 0 ? 0.4 : 0.3;
      c.update(sample({ horizontalDistance: speed * DT, forward: 1 }));
      if (c.state !== prev) switches++;
      prev = c.state;
    }
    expect(switches).toBeLessThanOrEqual(1);
  });

  it('★ 传送不会被识别为高速跑步', () => {
    const c = new AnimationController();
    c.update(sample()); // 静止
    expect(c.state).toBe(AnimState.Idle);

    // 一帧内位移 20 米（闪现/冲锋），若不特判会算成 1200 m/s
    c.update(sample({ horizontalDistance: 20, teleported: true }));
    expect(c.state).toBe(AnimState.Idle);
    expect(c.smoothedSpeed).toBeLessThan(0.1);
  });
});

describe('13.4 — 腿部节奏与实际速度一致', () => {
  it('全速时 timeScale 约为 1', () => {
    const c = new AnimationController();
    runAt(c, ANIM.REFERENCE_SPEED, 120);
    expect(c.timeScale).toBeCloseTo(1, 1);
  });

  it('半速时 timeScale 约为 0.5，不会高速摆腿滑行', () => {
    const c = new AnimationController();
    runAt(c, ANIM.REFERENCE_SPEED / 2, 120);
    expect(c.timeScale).toBeCloseTo(0.5, 1);
  });
});

describe('13.3 — 状态覆盖', () => {
  it('静止是 Idle', () => {
    const c = new AnimationController();
    for (let i = 0; i < 30; i++) c.update(sample());
    expect(c.state).toBe(AnimState.Idle);
  });

  it('上升是 Jump，下落是 Fall', () => {
    const c = new AnimationController();
    expect(c.update(sample({ grounded: false, verticalVelocity: 5 }))).toBe(AnimState.Jump);
    expect(c.update(sample({ grounded: false, verticalVelocity: -5 }))).toBe(AnimState.Fall);
  });

  it('后退与侧移有独立状态', () => {
    const c = new AnimationController();
    runAt(c, 4, 60, { forward: -1 });
    expect(c.state).toBe(AnimState.Backward);

    const c2 = new AnimationController();
    for (let i = 0; i < 60; i++) {
      c2.update(sample({ horizontalDistance: 4 * DT, forward: 0, strafe: 1 }));
    }
    expect(c2.state).toBe(AnimState.StrafeRight);
  });

  it('大落差播放落地动作，小落差不播', () => {
    const c = new AnimationController();
    c.update(sample({ landedFrom: 10 }));
    expect(c.state).toBe(AnimState.Land);

    const c2 = new AnimationController();
    c2.update(sample({ landedFrom: 0.5 }));
    expect(c2.state).toBe(AnimState.Idle);
  });

  it('控制与死亡覆盖一切移动状态', () => {
    const c = new AnimationController();
    runAt(c, 7, 60);
    expect(c.update(sample({ horizontalDistance: 7 * DT, stunned: true }))).toBe(AnimState.Stunned);
    expect(c.update(sample({ horizontalDistance: 7 * DT, dead: true }))).toBe(AnimState.Death);
  });
});
