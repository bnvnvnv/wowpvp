/**
 * 技能的**表现分量**（0..1）—— 大招该有大招的样子，小技能该收着。
 *
 * ★★ 为什么需要它：用户实测反馈「Q 版就该做得夸张一些」。但**全都夸张 =
 *   全都不夸张**：如果霜矢和陨石炸出一样大的场面，玩家既读不出「这一发很重」，
 *   屏幕也会在 12v12 里糊成一片。夸张的前提是**对比** ——
 *   所以先要有一把尺子，量出「这个技能有多大分量」。
 *
 * ★★ **从 `SkillDef` 推导，不逐技能手配。** 这是 `phases.ts` 定下的规矩
 *   （「六阶段从 SkillDef 推导，不需要手工配置」）：91 个技能的表现参数
 *   如果要手工维护，第一次加技能就会漏，而漏了没有任何测试发现得了。
 *   单测里有一条专门钉死「不许按技能 id 特判」。
 *
 * ★ 纯函数、无 three.js 依赖 —— 与 `castVfx` / `boltVfx` / `groundVfx` 同一分法，
 *   可以在 node 里逐条断言。
 *
 * ⚠️ 它**只影响表现**。sim 一行不读它 —— 分量大不等于伤害高，
 *   两者的相关性来自数据本身（贵的技能通常也更强），而不是这里的换算。
 */

import { CastKind, Targeting, type SkillDef } from '@wowpvp/shared';

/**
 * 把 x 归一化到 0..1，超出两端就钳住。
 * ★ 非有限值兜到 0：`Math.max(0, NaN)` 仍是 NaN，一路传染成整个分量 NaN，
 *   最后变成 `scale(NaN)` 的隐形粒子。蓄力那一轮已经栽过一次同样的跟头。
 */
const norm = (x: number, max: number): number =>
  Number.isFinite(x) ? Math.min(1, Math.max(0, x / max)) : 0;

/**
 * 各信号的权重。合计为 1，所以 `weightOf` 天然落在 0..1，不需要再钳。
 *
 * ★ 取这四个信号是因为它们**共同**描述了「玩家为这一发付出了多少」：
 *   等了多久（冷却）、站着读了多久（施法）、覆盖多大范围（形状）、
 *   花了多少资源（消耗）。
 *
 * ★★ **冷却必须占主导（0.5）。** 这不是拍脑袋，是把 90 个技能 dump 出来
 *   校准过的：玩家心里的「大招」名单几乎等同于 `cooldown >= 60` 的那 11 个
 *   （神圣壁障 90s、遁形 90s、冰封庇护 90s、凛冬领域 60s、陨星 60s…），
 *   而**其中 10 个是瞬发**。
 *   第一版把 cast 给到 0.30，结果 90 秒冷却的神圣壁障排到第 11 位、
 *   还不如 20 秒的照明弹，而 0.8s 读条 + 4s 引导的冰霜风暴一路冲到 0.99 ——
 *   「引导很久」被误当成了「这一发很重」。
 */
const W = { cooldown: 0.5, cast: 0.18, area: 0.17, cost: 0.15 } as const;

/**
 * 归一化基准：达到这个值就算「满」。取自 90 个技能的实际分布：
 * cooldown 的 p90 恰好是 60（p50 只有 15），所以 60 是「大招线」而不是 30。
 */
const FULL = { cooldown: 60, cast: 4, area: 8, cost: 120 } as const;

/**
 * 形状的「场面大小」，米。
 * ★ 单体不是 0 而是一个小正数：单体技能也有命中表现，
 *   给 0 会让所有单体技能的 area 分量完全相同，丢掉弹体/近战之间的差别。
 */
export const areaExtentOf = (shape: SkillDef['shape']): number => {
  switch (shape.kind) {
    case 'circle': return shape.radius;
    case 'ring': return shape.outerRadius;
    case 'cone': return shape.range;
    case 'line': return shape.length * 0.5;
    case 'chain': return shape.jumpRange;
    case 'single': return 0.5;
    default: return 0.5;
  }
};

/**
 * 这个技能的表现分量，0（最轻）..1（最重）。
 *
 * 直觉校准：陨石 / 暴风雪 → 接近 1；霜矢 / 火焰冲击 → 接近 0。
 */
export const weightOf = (skill: SkillDef): number => {
  // 施法时长：读条 + 引导。瞬发为 0 —— 瞬发本来就该「短平快」
  const castSeconds =
    skill.cast.kind === CastKind.Instant
      ? 0
      : skill.cast.time + (skill.cast.channelDuration ?? 0);

  const w =
    W.cooldown * norm(skill.cooldown, FULL.cooldown) +
    W.cast * norm(castSeconds, FULL.cast) +
    W.area * norm(areaExtentOf(skill.shape), FULL.area) +
    W.cost * norm(skill.cost?.amount ?? 0, FULL.cost);

  /**
   * ★ 地面指定的技能额外加一点：`Targeting.Ground` 意味着玩家**手动选了落点**，
   *   那一下天然带仪式感（陨石、暴风雪都在这一档）。
   *   加完仍要钳 —— 否则会冲出 1。
   */
  const ceremonial = skill.targeting === Targeting.Ground ? 0.08 : 0;
  return Math.min(1, w + ceremonial);
};

/**
 * 把分量换算成**表现倍率**。
 *
 * ★ 下限 0.85 而不是更低：小技能要「收着」，但不能比改造前还弱 ——
 *   那是退步不是克制。上限 1.5 是屏幕能承受的实际边界
 *   （再大就会在第一人称糊脸，撞验收 #49）。
 */
export const vfxScaleOf = (skill: SkillDef): number => 0.85 + 0.65 * weightOf(skill);
