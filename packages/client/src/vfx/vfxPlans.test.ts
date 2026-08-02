/**
 * 特效**参数计划**的纯函数断言（14.1 / 14.2 / 14.3）。
 *
 * ★ 与 `vfx.test.ts` 的分工：那边钉规格书条款（八属性表、护盾四态、
 *   画质角色归属），这边钉**参数本身**——「雪到底往下落吗」「引导段的
 *   时间轴是不是按引导算的」这类靠看截图会漏、靠读代码会自我说服的东西。
 */

import { describe, expect, it } from 'vitest';
import { fizzlePlanFor, windupPlanFor } from './castVfx.js';

/** 冰霜风暴：0.8 秒读条 + 4 秒引导，从 t=0 起手 */
const blizzard = (now: number, density = 1) =>
  windupPlanFor({ now, startedAt: 0, endsAt: 0.8, channelEndsAt: 4.8, density });

/** 霜矢：1.4 秒纯读条 */
const frostbolt = (now: number, density = 1) =>
  windupPlanFor({ now, startedAt: 0, endsAt: 1.4, density });

describe('windupPlanFor —— 读条段', () => {
  it('progress 随时间单调涨到 1', () => {
    expect(frostbolt(0).progress).toBeCloseTo(0, 6);
    expect(frostbolt(0.7).progress).toBeCloseTo(0.5, 6);
    expect(frostbolt(1.4).progress).toBeCloseTo(1, 6);
  });

  it('★ 聚能环半径单调收紧 —— 「攒」靠向内的运动表达，不靠越来越亮', () => {
    const early = frostbolt(0.1).gatherRadius;
    const mid = frostbolt(0.7).gatherRadius;
    const late = frostbolt(1.3).gatherRadius;
    expect(early).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(late);
    expect(late).toBeGreaterThan(0);
  });

  it('★ 节拍随进度加密 —— 「就要放出来了」的表现层线索（7.5 假读条博弈用它）', () => {
    expect(frostbolt(1.3).cadence).toBeLessThan(frostbolt(0.1).cadence);
  });

  it('法阵在 POP_IN 内弹出，之后保持满缩放', () => {
    expect(frostbolt(0).circleScale).toBeCloseTo(0, 6);
    expect(frostbolt(0.09).circleScale).toBeGreaterThan(0);
    expect(frostbolt(0.09).circleScale).toBeLessThan(1);
    expect(frostbolt(0.5).circleScale).toBe(1);
  });
});

describe('windupPlanFor —— 引导段', () => {
  it('★★ 引导段按引导自己的时间轴重算，不是接着读条继续涨', () => {
    // t=0.8 是引导刚开始：进度必须回到 0，而不是读条结束时的 1
    const start = blizzard(0.81);
    expect(start.phase).toBe('channel');
    expect(start.progress).toBeLessThan(0.05);

    // 引导过半
    expect(blizzard(2.8).progress).toBeCloseTo(0.5, 1);
    // 引导结束
    expect(blizzard(4.8).progress).toBeCloseTo(1, 6);
  });

  it('读条段仍归 bar，边界处切到 channel', () => {
    expect(blizzard(0.5).phase).toBe('bar');
    expect(blizzard(0.8).phase).toBe('channel');
  });

  it('★ 引导期间法阵转得更快、更亮 ——「正在倾泻」比「正在积蓄」更急', () => {
    const bar = blizzard(0.5);
    const channel = blizzard(2.5);
    expect(channel.circleSpin).toBeGreaterThan(bar.circleSpin);
    expect(channel.circleOpacity).toBeGreaterThan(bar.circleOpacity);
  });

  it('没有 channelEndsAt 的技能永远不会进 channel 段', () => {
    // 读条早就结束了（超时那一帧），仍然是 bar —— 引导相位不能凭空出现
    expect(frostbolt(9).phase).toBe('bar');
    expect(frostbolt(9).progress).toBe(1);
  });
});

describe('windupPlanFor —— 画质', () => {
  it('★ 低画质（density=0）不发聚能粒子，但法阵照画（验收 #48）', () => {
    const low = frostbolt(0.7, 0);
    expect(low.count).toBe(0);
    expect(low.cadence).toBe(0);
    // 法阵是关键信息「这个人在施法」—— 一点都不能少
    expect(low.circleScale).toBe(1);
    expect(low.circleOpacity).toBeGreaterThan(0);
  });

  it('中画质（density=0.5）节拍翻倍、每簇减半 —— 负载减半', () => {
    const high = frostbolt(0.7, 1);
    const medium = frostbolt(0.7, 0.5);
    expect(medium.cadence).toBeCloseTo(high.cadence * 2, 6);
    expect(medium.count).toBeLessThan(high.count);
    expect(medium.count).toBeGreaterThan(0);
  });

  it('★ 单个施法者的并发槽占用不超过 3 格（细流池预算的基础）', () => {
    for (const t of [0.05, 0.4, 0.8, 1.2, 1.39]) {
      const p = frostbolt(t);
      expect(Math.ceil(p.life / p.cadence)).toBeLessThanOrEqual(3);
    }
  });
});

describe('fizzlePlanFor', () => {
  it('★★ gravity 恒为负 —— 释放向上炸开，「泄了」必须向下垮掉', () => {
    for (const p of [0, 0.5, 1]) {
      expect(fizzlePlanFor(p).gravity).toBeLessThan(0);
    }
  });

  it('攒得越满泄得越明显', () => {
    expect(fizzlePlanFor(1).count).toBeGreaterThan(fizzlePlanFor(0).count);
    expect(fizzlePlanFor(1).speed).toBeGreaterThan(fizzlePlanFor(0).speed);
  });

  it('progress 越界不产生负数或 NaN', () => {
    for (const p of [-1, 2, Number.NaN]) {
      const plan = fizzlePlanFor(p);
      expect(Number.isFinite(plan.count)).toBe(true);
      expect(plan.count).toBeGreaterThan(0);
    }
  });
});
