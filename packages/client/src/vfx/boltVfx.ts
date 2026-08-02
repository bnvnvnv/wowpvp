/**
 * 飞行体（表现用弹体 + sim 真投射物）的**形态与拖尾**参数。规格书 14.1「飞行」/ 14.2。
 *
 * ★★ 用户实测原话：「冰球、火球什么的就一个简简单单的球，没有火焰拖尾或者
 *   冰焰拖尾什么的」。核实下来是两件事叠在一起：
 *
 *   1. 弹体节点只有**一个球 + 一张辉光贴片**，没有任何沿速度方向的形态 ——
 *      静止看是球，飞起来还是球，读不出「这是一发飞过去的法术」
 *   2. 拖尾**每帧每弹体各占一个爆发槽**（无计时器），24 发在飞时把 32 格的池
 *      刷空 —— 参数写着 3 粒，实际连这 3 粒都留不住
 *
 *   第 2 条已由「粒子池一分为二」修掉，本文件负责第 1 条 + 把拖尾参数调到
 *   它本该有的密度。
 *
 * ★ 纯函数：无 three.js 依赖，参数表可以在 node 单测里逐条断言。
 */

import type { AttributeVisual } from './schools.js';

/**
 * 各属性的运动倾向（14.2「形状与运动」列的粒子化）。
 *
 * ★★ 这张表此前只活在 `SpellVfx.ts` 里，而地面填充**写死了一个向上的
 *   gravity**，把 frost 的「雪花飘落」硬掰成了上升 —— 本轮修的正是这个。
 *   现在它是导出的唯一来源，拖尾与地面填充都从它派生，
 *   单测断言两者**同号**，方向再也写不反。
 */
export const MOTION: Record<AttributeVisual['particle'], { gravity: number; swirl: number }> = {
  ember: { gravity: 2.2, swirl: 0.2 },      // 火：热浪上升
  beam: { gravity: 2.6, swirl: 0 },         // 神圣：光柱上冲
  smoke: { gravity: 0.7, swirl: 0.4 },      // 暗影：烟雾缓升
  snowflake: { gravity: -1.2, swirl: 0.6 }, // 寒冰：雪花飘落
  rune: { gravity: 0.4, swirl: 2.6 },       // 奥术：符文旋绕
  leaf: { gravity: -0.4, swirl: 2.0 },      // 自然：叶片打旋
  spark: { gravity: -3.2, swirl: 0 },       // 物理：火花迸落
  droplet: { gravity: -4.2, swirl: 0 },     // 毒素：液滴下坠
};

/**
 * 把本地 +Z 轴对准 `dir` 所需的欧拉角（应用顺序 'YXZ'：先 yaw 再 pitch）。
 *
 * ★ 弹体节点里所有拉长的部件（锥体、彗尾条）都沿本地 -Z 摆在后方，
 *   所以整组一转，形态自动跟着速度走 —— 不需要逐部件算朝向。
 */
export const boltOrientation = (dir: { x: number; y: number; z: number }): {
  yaw: number; pitch: number;
} => {
  const horiz = Math.hypot(dir.x, dir.z);
  // ★ 零向量（刚生成、还没动）返回 0 而不是 NaN —— NaN 进 rotation 会让整组消失
  if (horiz < 1e-6 && Math.abs(dir.y) < 1e-6) return { yaw: 0, pitch: 0 };
  return {
    yaw: Math.atan2(dir.x, dir.z),
    pitch: Math.atan2(dir.y, horiz),
  };
};

export interface TrailPlan {
  /** 发射节拍（秒）。★ 计时器驱动，不是每帧 —— 每帧发就是本轮修的那个 bug */
  cadence: number;
  count: number;
  size: number;
  life: number;
  drag: number;
  /**
   * ★★ 恒等于 `MOTION[particle].gravity * 0.6`：
   *   火/圣的余烬往上飘、冰/毒/物理的碎屑往下落。
   *   拖尾的「属性感」有一半来自这个方向 —— 全都往同一边飘就只是一条灰尾巴。
   */
  gravity: number;
  opacity: number;
}

/**
 * 拖尾参数。
 *
 * ★ 密度相对旧实现大幅提高（3 粒 → 7 粒、life 0.30 → 0.42、drag 4 → 1.5）：
 *   drag 4 会在 0.25 秒内把粒子彻底拽停，尾巴还没拉开就没了 ——
 *   旧值是在「每帧都发」的前提下调的，改成计时器之后必须补回来。
 *
 * @param density `decorativeDensity(quality)` —— 低画质为 0
 */
export const trailPlanFor = (
  particle: AttributeVisual['particle'],
  density: number,
): TrailPlan => {
  const d = Math.max(0, density);
  return {
    /**
     * ★★ 0.07 秒是**池预算**算出来的，不是手感：`ceil(life/cadence)` = 6 格，
     *   × 3 个发射器 = 18 格（+蓄力 12 +地面 18 = 48，正好是细流池容量）。
     *   BOLT_SPEED 55 m/s 下 0.07 秒 ≈ 每 3.9 米撒一簇 —— 连贯的那条线由
     *   **彗尾条**（零池占用的 Plane）负责，粒子只是从它上面掉下来的余烬/雪花。
     * ★ density=0.5 时节拍翻倍（并发格子数减半，负载也减半）。
     */
    cadence: d > 0 ? 0.07 / Math.min(1, d) : 0,
    count: d > 0 ? Math.max(3, Math.round(7 * d)) : 0,
    size: 0.44,
    life: 0.42,
    // 拖尾要「拖」得住：阻力小一点，粒子才留在飞过的路径上
    drag: 1.5,
    gravity: MOTION[particle].gravity * 0.6,
    opacity: 0.95,
  };
};
