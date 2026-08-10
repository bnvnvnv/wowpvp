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
 * 技能级天气覆盖（X10 追加轮用户拍板：「暴风雪应该是一堆很大很大的大雪球
 * 往下砸，不是那种小雪花」）。
 *
 * ★ 按 skillId 而不是属性覆盖 —— frost 的通用雪花档还服务着凛冬领域等
 *   别的冰霜区域，暴风雪要的「大块头砸落」是**这一个技能**的性格。
 * ★ countScale 把每簇粒子数打下来：雪球要读作「一颗一颗砸」，靠的是
 *   **个头大、数量少、下落快**；数量不减的话 20 颗大球挤在一起还是一团云。
 * ★ 池预算不升反降：life 1.15 / cadence 0.6 → ceil = 2 簇位（雪花档是 3），
 *   `vfxPlans.test` 的预算断言照跑。
 */
const SKILL_WEATHER: Record<string, {
  spawnHeight: number; gravity: number; drag: number; life: number; size: number;
  countScale: number;
}> = {
  // 6 米高出生、-9 重力近自由落体、1.35 尺寸（雪花的 2.3 倍）、数量减半再减
  'mage.blizzard': { spawnHeight: 6, gravity: -9, drag: 0.15, life: 1.15, size: 1.35, countScale: 0.45 },
};

/**
 * 地面区域的填充计划。
 *
 * @param radius 区域半径（米）—— 越大撒得越多，否则大区域看着比小区域还空
 * @param density `decorativeDensity(quality)`
 * @param skillId 传了且命中 `SKILL_WEATHER` 时套技能级覆盖（暴风雪的大雪球）
 */
export const groundFillPlanFor = (
  particle: AttributeVisual['particle'],
  radius: number,
  density: number,
  skillId?: string,
): GroundFillPlan => {
  const ov = skillId !== undefined ? SKILL_WEATHER[skillId] : undefined;
  const w = ov ? { ...WEATHER[particle], ...ov } : WEATHER[particle];
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
    count: Math.max(3, Math.min(
      MAX_FILL_PARTICLES,
      Math.round((8 + radius * 2.2) * d * (ov?.countScale ?? 1)),
    )),
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

// ── 延迟落点：坠落体与落地冲击（技能级覆盖）────────────────────

/**
 * 一颗砸下来的坠落体。
 *
 * ★★ 用户实测原话（X10 追加轮，2026-08-10）：「陨星应该是很大的视觉差别的」。
 *   核实下来延迟落点在表现层**只有一圈边界环 + 一个倒计时数字** ——
 *   `syncProjectiles` 的 delayedImpact 分支到 `continue` 为止就这两样，
 *   天上什么都没有。玩家看到的是「地上出现一个圈，然后大家掉血」，
 *   跟任何一发地面技能长得一样，1.6 倍的设计分量在画面上是零。
 *
 * ★ 坠落体**不发粒子拖尾**：细流池 48 格是三类细流的预算和（蓄力 12 +
 *   拖尾 18 + 地面 18），已经顶死，再插一路会把别人的尾巴挤没。
 *   「拖着火」交给零池占用的彗尾条 —— 与弹体那条尾巴同一个手法。
 */
export interface FallPlan {
  /** 出生高度（米，相对落点地面）*/
  height: number;
  /** 坠落体主体半径（米）。通用弹体的核是 0.24 —— 这里要大一个数量级的分量 */
  bodyRadius: number;
  /** 彗尾条的宽 / 长（米）。零池占用，坠落体的火尾全靠它 */
  tailWidth: number;
  tailLength: number;
  /** 翻滚角速度（弧度/秒）。★ 岩块要**翻滚**，绕单轴自转读作「陀螺」*/
  tumble: number;
}

/**
 * 落地冲击的一段编排。★ 与 `SpellVfx.FormStep` 同构，多一个 `delay`：
 *   **错峰**才有「先炸开、再掀尘、后腾烟」的层次，同帧齐发只是一团更大的球。
 */
export interface ImpactStep {
  /** 相对落地时刻的延迟（秒）*/
  delay: number;
  /** 生成高度（米，相对落点地面）*/
  dy: number;
  count: number;
  speed: number;
  size: number;
  life: number;
  gravity: number;
  drag: number;
  spread: 'sphere' | 'disc';
  originRadius: number;
  /**
   * 用哪张点缀贴图。省略 = 用属性主粒子（火球）。
   * ★ 只允许这三张：都是已登记素材，零新增资产。
   */
  accent?: 'debris' | 'cloud' | 'scorch';
}

export interface ImpactPlan {
  steps: readonly ImpactStep[];
  /** 灼烧残留（地面染色盘）的寿命与不透明度 */
  burnLife: number;
  burnOpacity: number;
  /** 落地白闪（面向镜头的广告牌环）的尺寸与展开倍数 */
  flashSize: number;
  flashGrow: number;
}

/**
 * 一次落地冲击最多占用的**事件池格数**。
 * ★ 与 `MAX_FORM_SLOTS_PER_FRAME` 同一个 3：事件池 40 格里一发 8 目标 AOE
 *   的主爆发 + 碎屑已占 16 格，落地编排是装饰层，不该拿走同一量级的份额。
 *   而且这 3 格是**错峰**的，同一帧里最多落一格。
 */
export const MAX_IMPACT_STEPS = 3;

const SKILL_FALL: Record<string, FallPlan> = {
  // 26 米高、1.15 米半径的岩块 —— 通用弹体核（0.24）的近五倍，隔着半张地图就看得见
  'mage.meteor': { height: 26, bodyRadius: 1.15, tailWidth: 2.1, tailLength: 8.5, tumble: 1.7 },
};

const SKILL_IMPACT: Record<string, ImpactPlan> = {
  'mage.meteor': {
    steps: [
      // 0.00 主爆：贴地炸开的火球，又大又快
      { delay: 0, dy: 0.35, count: 30, speed: 9.5, size: 1.5, life: 0.7,
        gravity: 3, drag: 1.4, spread: 'sphere', originRadius: 0.8 },
      // 0.07 掀尘：贴地横着冲出去的碎石（disc + 高初速 + 负重力 = 往外扫再落回）
      { delay: 0.07, dy: 0.15, count: 22, speed: 12, size: 1.15, life: 0.85,
        gravity: -1.5, drag: 2.2, spread: 'disc', originRadius: 1.2, accent: 'debris' },
      // 0.20 腾烟：大、慢、久 —— 前两步散完它还在，这是「刚才砸过」的余韵
      { delay: 0.2, dy: 0.9, count: 18, speed: 2.2, size: 2.4, life: 1.5,
        gravity: 1.6, drag: 1.9, spread: 'sphere', originRadius: 1.8, accent: 'cloud' },
    ],
    // 灼烧残留：通用冲击波的染色盘只活 1.2 秒，陨星要留一片焦土
    burnLife: 3.2,
    burnOpacity: 0.3,
    flashSize: 2.6,
    flashGrow: 5.2,
  },
};

/** 这个技能的延迟落点要不要画坠落体。未登记 = 照旧只有边界环 + 倒计时 */
export const fallPlanFor = (skillId: string): FallPlan | undefined => SKILL_FALL[skillId];

/**
 * 落地冲击编排。
 *
 * @param density `decorativeDensity(quality)` —— 低画质档粒子步整段跳过
 *   （与 `formPlanFor` 同一口径：low 已经把拖尾/地面填充/命中碎屑全砍光，
 *   唯独留下落地编排会让它成为 low 档下唯一还在吃事件池的装饰源）。
 *   ★ 冲击波环与灼烧盘**不在**这条门禁里：环画的是这次 AOE 的真实半径
 *   （14.3「边界即判定」），盘由 `spawnWave` 自己的 groundFill 门禁管。
 */
export const impactPlanFor = (skillId: string, density: number): ImpactPlan | undefined => {
  const plan = SKILL_IMPACT[skillId];
  if (!plan) return undefined;
  const d = Math.max(0, density);
  if (d <= 0) return { ...plan, steps: [] };
  return {
    ...plan,
    // ★ 只乘 count：size/life/生成半径是这一层的识别特征，跟着密度缩会变成另一种爆炸
    steps: plan.steps.slice(0, MAX_IMPACT_STEPS).map((s) => ({
      ...s,
      count: Math.max(1, Math.round(s.count * d)),
    })),
  };
};

/**
 * 坠落体在剩余 `remaining` 秒时离地多高。
 *
 * ★★ 自由落体而不是匀速：`h = H·(1-(1-r)²)`，落地那一刻的速度是平均速度的
 *   两倍。匀速下落读作「电梯」，而陨星的全部分量都在最后那 0.3 秒。
 * ★ `duration` 由**首次看见这颗落点时的剩余时间**推出来（见 `RingEntry.fall`），
 *   不写死 1.5 —— sim 那边改了 delay 这边不会错位，中途入场也从半空接着落。
 */
export const fallHeightAt = (remaining: number, duration: number, height: number): number => {
  if (duration <= 0) return 0;
  const r = Math.min(1, Math.max(0, remaining / duration));
  return height * (1 - (1 - r) ** 2);
};

/** 同时冒填充粒子的地面区域上限（按到相机的距离取最近的几片）*/
export const MAX_FILL_AREAS = 3;

/** 重新导出，免得调用方为了一个 density 再 import 一次 quality */
export { decorativeDensity };
