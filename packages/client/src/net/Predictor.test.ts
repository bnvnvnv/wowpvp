/**
 * 预测与纠正。docs/08 §5 / 规格书 13.4。
 *
 * ★ 这个文件测的是「服务器说了话之后，客户端画在哪」。
 *   三档纠正各有一条：忽略、平滑、瞬移 —— 而**瞬移那一档是 13.4 的硬要求**，
 *   写错了不会报错，只会让远端角色滑行并播出冲刺动画。
 */

import { describe, expect, it } from 'vitest';
import {
  MOVE, SIM, createMovementState, distance, vec3,
  type Aabb, type MovementInput,
} from '@wowpvp/shared';

import { CORRECTION, Predictor } from './Predictor.js';

/** 一块地板，免得角色一直下落 */
const floor: Aabb = {
  min: { x: -500, y: -1, z: -500 },
  max: { x: 500, y: 0, z: 500 },
};

const forward: MovementInput = { forward: 1, strafe: 0, jump: false, yaw: 0 };
const idle: MovementInput = { forward: 0, strafe: 0, jump: false, yaw: 0 };

const makePredictor = () =>
  new Predictor(createMovementState(vec3(0, 0, 0)), { obstacles: [floor] });

describe('render interpolation', () => {
  it('smooths fixed simulation steps without modifying prediction', () => {
    const p = makePredictor();
    const start = { ...p.position };
    p.sample(forward);
    const end = { ...p.position };
    expect(p.renderPosition(0, 0)).toEqual(start);
    expect(p.renderPosition(0, 0.5).z).toBeCloseTo((start.z + end.z) / 2, 9);
    expect(p.renderPosition(0, 1)).toEqual(end);
    expect(p.position).toEqual(end);
    expect(p.pendingCount).toBe(1);
  });

  it('does not interpolate through a teleport or reconnect', () => {
    const p = makePredictor();
    p.sample(forward);
    const arrival = vec3(10, 0, -20);
    p.reconcile({ position: arrival, yaw: 0 }, 1, true);
    expect(p.renderPosition(0, 0)).toEqual(arrival);
    p.reset(createMovementState(vec3(2, 0, 3)));
    expect(p.renderPosition(0, 0.5)).toEqual(p.position);
  });
});

describe('第 1–3 步：采样即预测', () => {
  it('★ 采一条指令就立刻本地推进（不等服务器）', () => {
    const p = makePredictor();
    const before = { ...p.position };
    const msg = p.sample(forward);

    expect(msg.t).toBe('Input');
    expect(msg.seq).toBe(1);
    expect(p.position).not.toEqual(before);
    expect(p.pendingCount, '发出去的指令要留着等确认').toBe(1);
  });

  it('★ 上报的 dt 就是实际积分用的固定步长（抓包能对上账）', () => {
    const p = makePredictor();
    expect(p.sample(forward).dt).toBeCloseTo(SIM.TICK_DT, 9);
  });
});

describe('第 4–6 步：对账与重放', () => {
  it('★ 已确认的指令被丢弃，未确认的被重放', () => {
    const p = makePredictor();
    p.sample(forward);
    p.sample(forward);
    p.sample(forward);
    expect(p.pendingCount).toBe(3);

    // 服务器确认到第 1 条
    p.reconcile({ position: vec3(0, 0, -0.1), yaw: 0 }, 1);
    expect(p.pendingCount, '第 2、3 条还没被确认，应当留着').toBe(2);
  });

  /**
   * ★★ 这是整个预测能成立的那条性质：**服务器与客户端跑同一份 movement、
   *   同一个步长，那么在同样的输入下重放必须落回同一个位置。**
   *
   *   构造：客户端先本地跑 N 步；然后拿「服务器从同样起点跑第 1 步的结果」
   *   来对账并重放剩下的 N-1 步 —— 结果必须与本地预测一致。
   *   不一致就说明步长或代码路径分叉了，而那正是 A3 收尾要消除的东西。
   */
  it('★★ 权威值与预测同源时，重放后位置不变（预测的正确性判据）', () => {
    const p = makePredictor();
    p.sample(forward);
    const afterFirst = { ...p.position };
    /**
     * ★★ 权威状态必须带上**速度等积分输入**，不只是位置。
     *   只传位置的话这条测试会红（实测差 0.24 米）—— 因为重放会从
     *   「正确的位置 + 三步之后的速度」出发。`selfMovement` 就是为它存在的。
     */
    const stateAfterFirst = {
      velocity: { ...p.state.velocity },
      grounded: p.state.grounded,
      airSpeedCap: p.state.airSpeedCap,
      fallStartY: p.state.fallStartY,
      speedMultiplier: 1,
    };
    p.sample(forward);
    p.sample(forward);
    const predicted = { ...p.position };

    // 服务器确认第 1 条，给出的正是客户端第 1 步之后的权威状态
    p.reconcile({ position: afterFirst, yaw: 0, movement: stateAfterFirst }, 1);

    expect(
      distance(p.position, predicted),
      '重放结果偏离了预测 —— 步长或代码路径可能分叉了',
    ).toBeLessThan(1e-9);
  });
});

describe('★★ 第 7 步：三档纠正（13.4）', () => {
  it('偏差极小 → 直接采用，不产生平滑残余', () => {
    const p = makePredictor();
    p.sample(forward);
    const pos = { ...p.position };

    // 权威值只差 1 毫米
    p.reconcile({ position: vec3(pos.x + 0.001, pos.y, pos.z), yaw: 0 }, 1);
    const rendered = p.renderPosition(1 / 60);
    expect(distance(rendered, p.position), '不该有平滑残余').toBeLessThan(1e-9);
  });

  it('中等偏差 → 平滑：渲染位置先偏向老位置，再逐帧收敛', () => {
    const p = makePredictor();
    p.sample(forward);
    const before = { ...p.position };

    // 权威值偏了 0.5 米（在 IGNORE_BELOW 和 SNAP_ABOVE 之间）
    p.reconcile({ position: vec3(before.x + 0.5, before.y, before.z), yaw: 0 }, 1);

    // ★ 纠正刚发生时，画的还在老位置附近 —— 这就是「不瞬移」
    const first = p.renderPosition(0);
    expect(distance(first, before)).toBeLessThan(0.01);
    expect(distance(first, p.position)).toBeGreaterThan(0.4);

    // 跑完平滑时长之后应当收敛到权威位置
    let out = first;
    for (let i = 0; i < 20; i++) out = p.renderPosition(CORRECTION.SMOOTH_SECONDS / 4);
    expect(distance(out, p.position), '平滑没有收敛').toBeLessThan(0.01);
  });

  /**
   * ★★ **13.4 的硬要求。**
   *   服务器说这一 tick 是瞬移（闪现/击退/复活/位置纠正）时**不能平滑** ——
   *   平滑一次 20 米的闪现会让角色以几十米每秒滑过去，
   *   而 AnimationController 是按位移速度判跑/冲刺的，于是它会播冲刺。
   */
  it('★★ 服务器标记 teleported → 立刻瞬移，不留平滑残余', () => {
    const p = makePredictor();
    p.sample(forward);

    // 闪现到 20 米外，服务器标记为瞬移
    const blinked = vec3(0, 0, -20);
    p.reconcile({ position: blinked, yaw: 0 }, 1, true);

    const rendered = p.renderPosition(0);
    expect(
      distance(rendered, blinked),
      '瞬移被平滑了 —— 远端会看到角色滑行并播出冲刺动画（13.4）',
    ).toBeLessThan(1e-9);
  });

  it('★★ 偏差超过阈值 → 即便服务器没标记也瞬移（丢包后一次性对账）', () => {
    const p = makePredictor();
    p.sample(forward);
    const far = vec3(0, 0, -(CORRECTION.SNAP_ABOVE + 5));

    p.reconcile({ position: far, yaw: 0 }, 1); // 注意：没有传 teleported

    expect(distance(p.renderPosition(0), far)).toBeLessThan(1e-9);
  });

  /** ★ 三档的边界必须是**有序**的，否则「平滑档」可能是空的 */
  it('★ 阈值有序：IGNORE_BELOW < SNAP_ABOVE', () => {
    expect(CORRECTION.IGNORE_BELOW).toBeLessThan(CORRECTION.SNAP_ABOVE);
    // 平滑档至少要覆盖「一个 tick 的正常位移」这个量级，否则正常抖动会被当瞬移
    expect(CORRECTION.SNAP_ABOVE).toBeGreaterThan(MOVE.BASE_SPEED * SIM.TICK_DT);
  });
});

describe('重连', () => {
  it('★ reset 丢弃全部本地状态，但**不清零 seq**', () => {
    const p = makePredictor();
    p.sample(forward);
    p.sample(forward);

    p.reset(createMovementState(vec3(5, 0, 5)));
    expect(p.pendingCount).toBe(0);
    expect(p.position).toEqual(vec3(5, 0, 5));

    /**
     * ★ seq 继续递增。清零的话服务器的 ackSeq 还停在旧的高位上，
     *   新指令会被它当成「早就确认过的」而丢掉 —— 表现是重连后角色不动。
     */
    expect(p.sample(idle).seq).toBeGreaterThan(2);
  });
});
