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
  ember: { gravity: 2.2, swirl: 0.5 },      // 火：热浪上升
  beam: { gravity: 2.6, swirl: 0 },         // 神圣：光柱上冲（直上，不旋）
  smoke: { gravity: 0.7, swirl: 0.9 },      // 暗影：烟雾缓升打卷
  snowflake: { gravity: -1.2, swirl: 1.2 }, // 寒冰：雪花打旋飘落
  rune: { gravity: 0.4, swirl: 3.4 },       // 奥术：符文旋绕
  leaf: { gravity: -0.4, swirl: 2.8 },      // 自然：叶片打旋
  spark: { gravity: -3.2, swirl: 0 },       // 物理：火花直迸（不旋才有「崩」感）
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

// ── 弹体形态（通用档 + 技能级覆盖）──────────────────────────────

/**
 * 通用弹体各部件的基准尺寸（米）。
 * ★ 单独抽出来是为了让**形态表与建节点的代码读同一份数字** ——
 *   否则「冰矛比通用弹体细多少」只能靠人肉换算 0.24 × 0.42，测不了。
 */
export const BOLT_BASE = {
  coreRadius: 0.24,
  coneLength: 0.95,
  coneRadius: 0.2,
  headScale: 1.35,
  headZ: 0.12,
  glowScale: 1.25,
  tailWidth: 0.62,
  tailLength: 3.2,
} as const;

/**
 * 一发弹体的形态参数。
 *
 * ★★ 用户实测原话（X10 追加轮，2026-08-10）：「霜矢应该类似一个会飞的
 *   短冰矛」。核实下来通用弹体就是**一颗球**：核是 12 段球、头是恒面向镜头的
 *   圆 Sprite、辉光又是一圈圆光斑 —— 三层圆叠在一起，沿速度拉长的只有一个
 *   半透明尾锥，飞起来还是球。属性只换了颜色和贴图纹样，换不了轮廓。
 *
 * ★ 所以差异化做在**轮廓**上：核可以拉成梭形、前面可以长出尖、
 *   亮核可以挪到尖上、绕轴可以挂偏心的冰晶（偏心才看得出自旋）。
 *   与 `groundVfx` 的 `SKILL_WEATHER` 同一个套路 —— 按 skillId 覆盖，
 *   不动属性通用档（火球/暗影箭/秘法箭仍是球，它们本来就该是球）。
 */
export interface BoltForm {
  /**
   * 实心核的几何：
   *   ball    低模球 —— 通用弹体，「一颗飞过去的球」
   *   spindle 八面双锥 —— 低面数、有棱；沿飞行轴拉长就是冰矛的梭形
   */
  core: 'ball' | 'spindle';
  /** 核的三轴缩放（本地 +Z = 飞行方向）。z ≫ x/y 即「拉长成矛」*/
  coreScale: { x: number; y: number; z: number };
  /** 前向尖端锥的长度 / 底半径（米）。长度 0 = 不画 —— 通用弹体没有尖 */
  tipLength: number;
  tipRadius: number;
  /** 尖端锥的棱数。4 = 四棱冰锥（自旋时轮廓在变，看得出它在转）*/
  tipFacets: number;
  /** 后方尾锥的长度 / 底半径倍率（相对 `BOLT_BASE`）*/
  coneLength: number;
  coneRadius: number;
  /** 属性头 Sprite 的尺寸倍率与前后位置（米）。挪到尖上就是「尖端亮核」*/
  headScale: number;
  headZ: number;
  /** 辉光 Sprite 的尺寸倍率 */
  glowScale: number;
  /** 彗尾条的宽 / 长倍率 */
  tailWidth: number;
  tailLength: number;
  /**
   * 绕飞行轴等分排布的冰晶数（0 = 不画）。
   * ★★ 它们**偏离轴心**，这是自旋唯一看得见的载体：核与尖端都绕 Z 轴对称，
   *   材质又是 `MeshBasicMaterial`（无光照、纯色），转与不转一模一样。
   */
  crystals: number;
  /** 冰晶的轴心距与长度（米）*/
  crystalRadius: number;
  crystalLength: number;
  /** 绕飞行轴的额外自旋（弧度/秒），叠在属性固有的 `MOTION.swirl` 之上 */
  spin: number;
}

/** 通用档：**逐字段等于改动前的写法**，所以没被覆盖的技能一像素都不变 */
export const GENERIC_BOLT_FORM: BoltForm = {
  core: 'ball',
  coreScale: { x: 1, y: 1, z: 1 },
  tipLength: 0,
  tipRadius: 0,
  tipFacets: 12,
  coneLength: 1,
  coneRadius: 1,
  headScale: 1,
  headZ: BOLT_BASE.headZ,
  glowScale: 1,
  tailWidth: 1,
  tailLength: 1,
  crystals: 0,
  crystalRadius: 0,
  crystalLength: 0,
  spin: 0,
};

/**
 * 技能级形态覆盖。
 *
 * ★ 霜矢 = 短冰矛：核拉成 1 米出头的梭形（横截面只剩四成）、前面长出一根
 *   四棱冰锥、亮核挪到尖上、绕轴三根冰晶随自旋甩、彗尾条收窄拉长成冰晶尾迹。
 *   头/辉光两个圆 Sprite 大幅压小 —— 它们正是「怎么看都是个球」的元凶。
 */
const SKILL_BOLT_FORM: Record<string, Partial<BoltForm>> = {
  'mage.frostbolt': {
    core: 'spindle',
    coreScale: { x: 0.42, y: 0.42, z: 2.1 },
    tipLength: 0.72,
    tipRadius: 0.13,
    tipFacets: 4,
    coneLength: 0.7,
    coneRadius: 0.45,
    headScale: 0.36,
    headZ: 0.85,
    glowScale: 0.34,
    tailWidth: 0.42,
    tailLength: 1.25,
    crystals: 3,
    crystalRadius: 0.17,
    crystalLength: 0.7,
    spin: 6,
  },
};

/**
 * 这一发弹体的形态。未登记的技能（含不传 id）返回**通用档本体**。
 * ★ 返回同一个对象引用而不是拷贝：形态在弹体创建时读一次就固化进节点，
 *   没有人会去改它，拷贝纯属白做。
 */
export const boltFormFor = (skillId?: string): BoltForm => {
  const ov = skillId !== undefined ? SKILL_BOLT_FORM[skillId] : undefined;
  return ov ? { ...GENERIC_BOLT_FORM, ...ov } : GENERIC_BOLT_FORM;
};

/**
 * 长径比 = 沿飞行轴的总长 ÷ 横截面直径。
 * ★ 球恒为 1；「一眼看出这是矛不是球」的判据就钉在这个数上。
 */
export const boltAspect = (form: BoltForm): number => {
  const width = BOLT_BASE.coreRadius * 2 * form.coreScale.x;
  const length = BOLT_BASE.coreRadius * 2 * form.coreScale.z + form.tipLength;
  return length / width;
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
    /**
     * ★ 三期加密：7 → 11。**只能动 count，不能动 cadence/life** ——
     *   后两者是上面那条 `ceil(life/cadence) ≤ 6` 预算不等式的两端，
     *   已经顶死（0.42/0.07 = 6）。count 只受细流池单格 32 粒约束，
     *   11 还有三倍余量，所以这是加密度**唯一**不撞预算的旋钮。
     */
    count: d > 0 ? Math.max(4, Math.round(11 * d)) : 0,
    size: 0.54,
    life: 0.42,
    // 拖尾要「拖」得住：阻力小一点，粒子才留在飞过的路径上
    drag: 1.5,
    gravity: MOTION[particle].gravity * 0.6,
    opacity: 0.95,
  };
};
