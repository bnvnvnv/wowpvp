/**
 * 地面表现的参数计划：**瞬发范围技能的冲击波** + **持续区域的天气**。
 *
 * ★★ 两条用户实测反馈的落点：
 *
 *   ·「霜爆新星就闪了一下」—— 纯定身技能（无伤害）此前只有每个目标身上
 *     12 粒小爆 + 脚下一圈细锁链，地上**什么痕迹都没有**。
 *     而 `FlashPool` 那个叫「冲击波」的东西是**面向镜头的广告牌光斑**，
 *     不是贴地的环 —— 从上往下看它就是一团光，读不出「以我为圆心炸了 5 米」。
 *
 *   ·「暴风雪啥都没有」—— 地面区域只有一圈边界环，内部每 0.12 秒在
 *     113 平方米里随机撒 2~4 粒。更糟的是 `syncGround` **写死了
 *     `gravity: +1.4`（上升）**，而 frost 的 `MOTION.snowflake` 是 -1.2
 *     （雪花飘落）—— 方向正好相反，这张图的雪从来没往下飘过。
 *
 * ★ 纯函数、无 three.js 依赖：参数表在 node 单测里逐条断言。
 */

import { MOTION } from './boltVfx.js';
import { QualityTier, decorativeDensity, isVisible } from '../render/quality.js';
import type { AttributeVisual } from './schools.js';

// ── 瞬发范围技能的地面冲击波 ────────────────────────────────────

export interface WavePlan {
  /** 波扩张到满半径并淡出的时长（秒）。范围越大扩得越久 */
  life: number;
  /** 起手不透明度 */
  ringOpacity: number;
  /** 要不要留一张地面染色盘（装饰层，低画质砍） */
  decal: boolean;
  decalLife: number;
  decalOpacity: number;
}

export const wavePlanFor = (radius: number, quality: QualityTier): WavePlan => ({
  // 5 米的霜爆新星 ≈ 0.36 秒，12 米的大范围 ≈ 0.44 秒 —— 大范围扩太快会读成闪光
  life: 0.3 + Math.min(0.2, radius * 0.012),
  ringOpacity: 0.9,
  decal: isVisible('groundFill', quality),
  decalLife: 1.2,
  decalOpacity: 0.18,
});

/**
 * 扩张缓动：`easeOutCubic`。
 * ★ 一定要「先快后慢」—— 线性扩张读作「一个圈在匀速长大」，
 *   而爆发的物理直觉是冲击最猛的一瞬间在最开始。
 */
export const waveEase = (t: number): number => {
  const c = Math.min(1, Math.max(0, t));
  return 1 - (1 - c) ** 3;
};

// ── 持续地面区域的天气 ──────────────────────────────────────────

/**
 * 区域填充的运动模式。
 *   fall  从高处落下（雪、毒液、火花）
 *   rise  贴地升起（余烬、光柱）
 *   drift 低空弥漫（烟雾、叶片、符文）
 */
export type FillMode = 'fall' | 'rise' | 'drift';

export interface GroundFillPlan {
  mode: FillMode;
  /** 相对区域中心的生成高度（米）*/
  spawnHeight: number;
  /** 每次生成几簇（半径越大越多）。0 = 本档不发 */
  clusters: number;
  /** 每簇粒子数 */
  count: number;
  /**
   * 发射节拍（秒）。
   * ★ 宁可「少发几次、每次多发」也不要高频小簇 —— 一次 emit 就占一个池槽，
   *   高频等于让一个区域把池吃光。
   */
  cadence: number;
  size: number;
  life: number;
  gravity: number;
  drag: number;
  spread: 'sphere' | 'disc';
  /** 地面染色盘的不透明度。0 = 不画 */
  tintOpacity: number;
}

/** 各属性的天气档案。表里的方向与 `MOTION` 同号，由单测钉死 */
const WEATHER: Record<AttributeVisual['particle'], {
  mode: FillMode; spawnHeight: number; gravity: number; drag: number; life: number; size: number;
}> = {
  // 冰：雪从三米多高飘下来 —— 终于兑现 MOTION.snowflake 的 -1.2 语义
  snowflake: { mode: 'fall', spawnHeight: 3.2, gravity: -2.6, drag: 0.35, life: 1.8, size: 0.58 },
  // 火：余烬贴地升腾
  ember: { mode: 'rise', spawnHeight: 0.05, gravity: 2.4, drag: 1.1, life: 1.1, size: 0.56 },
  // 圣：光柱上冲
  beam: { mode: 'rise', spawnHeight: 0.05, gravity: 2.6, drag: 1.0, life: 1.1, size: 0.6 },
  // 暗：烟雾缓升、大而慢
  smoke: { mode: 'drift', spawnHeight: 0.4, gravity: 0.7, drag: 1.8, life: 1.6, size: 0.85 },
  // 毒：液滴下坠
  droplet: { mode: 'fall', spawnHeight: 1.4, gravity: -3.4, drag: 0.6, life: 1.2, size: 0.5 },
  // 自然：叶片打旋（swirl 由 emitBurst 从 MOTION 自动带上）
  leaf: { mode: 'drift', spawnHeight: 0.6, gravity: -0.4, drag: 1.4, life: 1.4, size: 0.58 },
  // 奥术：符文旋绕
  rune: { mode: 'drift', spawnHeight: 0.6, gravity: 0.4, drag: 1.4, life: 1.4, size: 0.56 },
  // 物理：火花迸落
  spark: { mode: 'fall', spawnHeight: 1.0, gravity: -3.2, drag: 1.6, life: 0.9, size: 0.46 },
};

/**
 * 每簇粒子数的上限 = 细流池的**单格容量**。
 * ★ 一片 12 米宽的区域要读作「这里在下雪」，靠的是**一次 emit 铺满整片**
 *   （`originRadius`），所以密度全压在这一个数上 —— 加簇数是线性吃池槽的。
 */
const MAX_FILL_PARTICLES = 32;

/**
 * 地面区域的填充计划。
 *
 * @param radius 区域半径（米）—— 越大撒得越多，否则大区域看着比小区域还空
 * @param density `decorativeDensity(quality)`
 */
export const groundFillPlanFor = (
  particle: AttributeVisual['particle'],
  radius: number,
  density: number,
): GroundFillPlan => {
  const w = WEATHER[particle];
  const d = Math.max(0, density);
  if (d <= 0) {
    return {
      ...w, clusters: 0, count: 0, cadence: 0, spread: 'disc', tintOpacity: 0,
    };
  }
  return {
    mode: w.mode,
    spawnHeight: w.spawnHeight,
    /**
     * ★★ 密度靠**每簇粒子数**而不是簇数：一次 emit 就占一个池槽，
     *   而一个槽最多能装 `MAX_FILL_PARTICLES` 粒。所以「大区域更密」
     *   要往 count 上加，不能往 clusters 上加 —— 后者是线性吃槽位。
     *   6 米的暴风雪：2 簇 × 21 粒 = 42 粒/次，稳态约 126 粒在飘。
     */
    clusters: radius >= 3 ? 2 : 1,
    count: Math.max(3, Math.min(MAX_FILL_PARTICLES, Math.round((8 + radius * 2.2) * d))),
    /**
     * ★ 0.6 秒是**池预算**：`ceil(life/cadence) × clusters` 就是一片区域的
     *   并发槽数，最长的雪（life 1.8）= 3 × 2 = 6 格，
     *   `MAX_FILL_AREAS` 3 片 → 18 格（+蓄力 12 +拖尾 18 = 48）。
     */
    cadence: 0.6 / Math.min(1, d),
    size: w.size,
    life: w.life,
    gravity: w.gravity,
    drag: w.drag,
    // 落下的从高处一个球里生成，升起/弥漫的贴地铺开
    spread: w.mode === 'fall' ? 'sphere' : 'disc',
    /**
     * 风暴盘的不透明度。
     * ★ 0.12 → 0.32：0.12 是「纯色圆盘」时代的值，那时它只是给区域一点底色，
     *   太亮会把明亮地面糊成一块。现在它贴了图并在缓慢自转，
     *   承担的是「这一片有天气」的**主要**表达（粒子那条路已经顶死池预算），
     *   0.12 根本看不出来 —— 这正是「暴风雪啥都没有」的一半原因。
     * ★ 仍然远低于边界环的 0.85：判定边界必须比装饰更清楚（14.3）。
     */
    tintOpacity: 0.32,
  };
};

/**
 * 按 `Burst.update` 的**同一套离散积分**估算 life 内的竖直位移（米，向上为正）。
 *
 * ★★ 这个函数存在的唯一理由：让「雪从 3.2 米高生成，但一辈子只落了 0.4 米」
 *   这类参数错**在单测里就红**，而不是靠肉眼看截图看出来。
 *   积分必须与 `ParticleBurst.Burst.update` 一致：
 *     v += gravity·dt;  v *= max(0, 1 - drag·dt);  p += v·dt
 */
export const verticalTravel = (
  gravity: number, drag: number, life: number, v0 = 0, dt = 1 / 60,
): number => {
  let v = v0;
  let p = 0;
  for (let t = 0; t < life; t += dt) {
    v += gravity * dt;
    v *= Math.max(0, 1 - drag * dt);
    p += v * dt;
  }
  return p;
};

/** 同时冒填充粒子的地面区域上限（按到相机的距离取最近的几片）*/
export const MAX_FILL_AREAS = 3;

/** 重新导出，免得调用方为了一个 density 再 import 一次 quality */
export { decorativeDensity };
