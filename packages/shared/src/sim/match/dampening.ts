/**
 * 竞技场战斗抑制与决胜阶段。规格书 8.5，验收 #27。
 *
 * 8.5 原文：
 *   「2v2 在 60 秒后、3v3 在 90 秒后、5v5 在 120 秒后开始降低所有治疗与吸收。
 *     初始降低 10%，之后每 30 秒额外降低 5%。
 *     常规时间结束后进入决胜阶段：所有玩家大致位置可见、潜行受限、抑制加速，
 *     并逐步加入不可完全免疫的竞技场压迫伤害。」
 *
 * ★ 抑制**只影响治疗与吸收**，不影响伤害。把它做成全局乘算会顺手削弱伤害，
 *   那会改变整个战斗节奏 —— `effects/combat.ts` 里只有 dealHeal 读它。
 */

import { DAMPENING } from '../../constants/combat.js';
import type { GameMode } from '../../types/enums.js';

export interface DampeningSnapshot {
  /** 0 ~ MAX，治疗与吸收降低的比例 */
  amount: number;
  /** 是否已进入决胜阶段 */
  suddenDeath: boolean;
  /** 决胜阶段的压迫伤害，每秒。★ 必须绕过完全免疫（验收 #27）*/
  pressureDamagePerSecond: number;
  /** 距离抑制开始还有多久（秒）。已开始则为 0 */
  startsIn: number;
}

/** 决胜阶段的参数。规格书只说「抑制加速」和「逐步加入压迫伤害」，具体数值由实现定 */
export const SUDDEN_DEATH = {
  /** 决胜阶段抑制的加速倍率 */
  DAMPENING_RATE_MULTIPLIER: 3,
  /** 压迫伤害的起始值，每秒 */
  PRESSURE_BASE: 20,
  /** 压迫伤害每秒的增长量 —— 「逐步加入」 */
  PRESSURE_RAMP_PER_SECOND: 4,
  /** 压迫伤害上限，避免出现一秒抹掉满血的极端值 */
  PRESSURE_MAX: 400,
} as const;

/**
 * 计算某个时刻的抑制状态。
 *
 * @param mode      模式，决定抑制起始时间
 * @param elapsed   回合已进行的秒数
 * @param regularDuration 常规时长（秒）。超过它进入决胜阶段
 */
export const dampeningAt = (
  mode: GameMode,
  elapsed: number,
  regularDuration: number,
): DampeningSnapshot => {
  const startAt = DAMPENING.START_SECONDS[mode];
  // 夺旗模式没有战斗抑制（8.5 只规定了竞技场）
  if (startAt === undefined) {
    return { amount: 0, suddenDeath: false, pressureDamagePerSecond: 0, startsIn: Infinity };
  }

  // ★ 决胜阶段由**常规时长**决定，与抑制起始时间无关。
  //   两者不能耦合：自定义房间可以把回合设得比抑制起始时间还短，
  //   那时仍然要进决胜阶段，否则回合永远打不完。
  const suddenDeath = elapsed >= regularDuration;

  const pressure = suddenDeath
    ? Math.min(
        SUDDEN_DEATH.PRESSURE_MAX,
        SUDDEN_DEATH.PRESSURE_BASE +
          (elapsed - regularDuration) * SUDDEN_DEATH.PRESSURE_RAMP_PER_SECOND,
      )
    : 0;

  if (elapsed < startAt) {
    return {
      amount: 0,
      suddenDeath,
      pressureDamagePerSecond: pressure,
      startsIn: startAt - elapsed,
    };
  }

  // 常规阶段：初始 10%，之后每 30 秒 +5%
  const regularEnd = Math.min(elapsed, regularDuration);
  const regularSteps = Math.max(0, Math.floor((regularEnd - startAt) / DAMPENING.STEP_INTERVAL));
  let amount = DAMPENING.INITIAL + regularSteps * DAMPENING.STEP_AMOUNT;

  // 决胜阶段：抑制加速（8.5「抑制加速」）
  if (suddenDeath) {
    const sdElapsed = elapsed - regularDuration;
    const sdSteps = sdElapsed / DAMPENING.STEP_INTERVAL;
    amount += sdSteps * DAMPENING.STEP_AMOUNT * SUDDEN_DEATH.DAMPENING_RATE_MULTIPLIER;
  }

  amount = Math.min(DAMPENING.MAX, amount);
  return { amount, suddenDeath, pressureDamagePerSecond: pressure, startsIn: 0 };
};

/**
 * 8.5 决胜阶段：「所有玩家大致位置可见、潜行受限」。
 *
 * 「大致位置」而不是精确位置 —— 目的是打破多潜行阵容的拖延，
 * 而不是把潜行职业变成透明人。网络层按这个精度做视野裁剪。
 */
export const SUDDEN_DEATH_POSITION_PRECISION = 5; // 米

/** 把精确位置量化成「大致位置」，供决胜阶段的小地图显示 */
export const approximatePosition = (p: { x: number; z: number }) => ({
  x: Math.round(p.x / SUDDEN_DEATH_POSITION_PRECISION) * SUDDEN_DEATH_POSITION_PRECISION,
  z: Math.round(p.z / SUDDEN_DEATH_POSITION_PRECISION) * SUDDEN_DEATH_POSITION_PRECISION,
});
