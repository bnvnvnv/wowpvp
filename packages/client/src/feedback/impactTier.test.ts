/**
 * 打击分档 —— 两个场景共用的唯一判据。
 */

import { describe, expect, it } from 'vitest';
import { IMPACT, impactTierOf } from './impactTier.js';

describe('impactTierOf', () => {
  it('★ 比例判据：一击 ≥ maxHealth×0.18 是重击，差一点不是', () => {
    expect(impactTierOf({ amount: 180, crit: false, maxHealth: 1000 })).toBe('heavy');
    expect(impactTierOf({ amount: 179, crit: false, maxHealth: 1000 })).toBe('normal');
  });

  it('★ 拿不到 maxHealth 时走绝对值兜底', () => {
    expect(impactTierOf({ amount: IMPACT.HEAVY_ABSOLUTE, crit: false })).toBe('heavy');
    expect(impactTierOf({ amount: IMPACT.HEAVY_ABSOLUTE - 1, crit: false })).toBe('normal');
  });

  it('★★ 暴击优先于数值：多小的暴击都至少是 crit（掷骰结果玩家要读到）', () => {
    expect(impactTierOf({ amount: 5, crit: true, maxHealth: 1200 })).toBe('crit');
  });

  it('★ 暴击 + 超阈值 = critHeavy', () => {
    expect(impactTierOf({ amount: 400, crit: true, maxHealth: 1000 })).toBe('critHeavy');
  });

  it('★ overkill > 0 压过一切档位（含暴击）—— 致命一击就是最重的一击', () => {
    expect(impactTierOf({ amount: 30, crit: true, overkill: 1, maxHealth: 1000 })).toBe('kill');
    expect(impactTierOf({ amount: 30, crit: false, overkill: 12 })).toBe('kill');
  });

  it('★ DoT 跳（<40）是轻击 —— 不震动不顿帧', () => {
    expect(impactTierOf({ amount: 35, crit: false, maxHealth: 1000 })).toBe('light');
  });
});
