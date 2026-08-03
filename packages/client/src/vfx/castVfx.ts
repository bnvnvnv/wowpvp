/**
 * 施法「预备」阶段的表现参数。规格书 14.1 第一条。
 *
 * 14.1 原文：**预备：手部、武器、符文或身体积蓄能量。**
 *
 * ★★ 这一条此前只兑现了一帧：`SpellVfx.onCast('started')` 喷 6 粒粒子（活 0.5 秒）
 *   就结束了。而变形术读 1.5 秒、冰霜风暴读 0.8 秒再引导 4 秒 ——
 *   剩下的时间施法者手上什么都没有，玩家实测反馈「施法者不够酷炫」。
 *   `phases.ts` 明明写着「预备阶段持续 `skill.cast.time` 秒」，
 *   只是**没有任何代码按这个时长持续画东西**。
 *
 * ★ 本文件是纯函数：进来一份时刻与进度，出去一份参数，无副作用无 three.js 依赖。
 *   与 `status.ts`（纯数据）/ `StatusMarkers.ts`（渲染）是同一种分法 ——
 *   参数表可以在 node 单测里逐条断言，而渲染只能靠肉眼。
 */

/**
 * 蓄力处在哪一段。
 *
 * ★★ 两段是**两条独立的时间轴**，不是一条连续的进度：
 *   引导技能（冰霜风暴）先读 0.8 秒条，再引导 4 秒。读条段是「攒」，
 *   引导段是「一直在放」—— 如果把引导段接着读条的进度往上涨，
 *   4.8 秒的技能会在第 0.8 秒就显示 100% 蓄满，之后 4 秒无变化。
 */
export type WindupPhase = 'bar' | 'channel';

export interface WindupPlan {
  phase: WindupPhase;
  /** 本段自己的进度 0..1 */
  progress: number;
  /** 聚能簇的发射节拍（秒）。0 = 本档不发粒子 */
  cadence: number;
  /** 每簇粒子数。0 = 本档不发粒子（低画质 density=0 时） */
  count: number;
  /**
   * 聚能环半径（米）：粒子从这个距离朝手上收拢。
   * ★ 越接近完成收得越紧 —— 「攒」这件事靠**向内**的运动表达，
   *   而不是靠越来越亮（亮度在阳光下的地图上读不出来）。
   */
  gatherRadius: number;
  size: number;
  life: number;
  /** 法阵缩放（0→1 弹出，之后维持） */
  circleScale: number;
  /** 法阵角速度 rad/s。★ 引导段更快 —— 「正在倾泻」比「正在积蓄」更急 */
  circleSpin: number;
  circleOpacity: number;
}

/** 法阵弹出的时间（秒）—— 起手那一下要有「啪」地展开的感觉 */
const POP_IN = 0.18;

/** ★ NaN 兜到 0：`Math.min(1, Math.max(0, NaN))` 是 NaN，会一路传染成粒子数 NaN */
const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/**
 * 当前这一帧的蓄力表现参数。
 *
 * @param now         当前时钟（试验场 = world.time，联网 = serverTime）
 * @param startedAt   读条开始
 * @param endsAt      读条结束（引导技能的引导段从这里开始）
 * @param channelEndsAt 引导结束。仅引导技能有
 * @param density     `decorativeDensity(quality)` —— 低画质为 0
 */
export const windupPlanFor = (i: {
  now: number;
  startedAt: number;
  endsAt: number;
  channelEndsAt?: number;
  density: number;
}): WindupPlan => {
  const inChannel = i.channelEndsAt !== undefined && i.now >= i.endsAt;
  const phase: WindupPhase = inChannel ? 'channel' : 'bar';

  const from = inChannel ? i.endsAt : i.startedAt;
  const to = inChannel ? i.channelEndsAt! : i.endsAt;
  const span = Math.max(0.01, to - from);
  const progress = clamp01((i.now - from) / span);

  const elapsed = Math.max(0, i.now - i.startedAt);
  const density = Math.max(0, i.density);

  /**
   * ★ 节拍随进度加密（0.20s → 0.13s）：读条快完成时粒子越来越急，
   *   这是「就要放出来了」唯一不靠 HUD 就能读到的信号 —— 也是 7.5 假读条
   *   博弈里对手判断「该不该交打断」的表现层线索。
   * ★★ 下限 0.13 不是手感调参，是**池预算**：`ceil(life / cadence)` 就是
   *   一个施法者占用的并发格子数，0.36/0.13 = 3 格 —— 四个发射器共 12 格，
   *   与拖尾 12 + 地面 12 合起来 36/40。再快就会挤掉别人（vfxPlans.test 钉死）。
   * ★ 中画质 density=0.5 时节拍翻倍（负载减半），低画质 count=0 不发。
   */
  const baseCadence = inChannel ? 0.16 : 0.2 - 0.07 * progress;
  const cadence = density > 0 ? baseCadence / Math.min(1, density) : 0;
  const count = density > 0 ? Math.max(2, Math.round((inChannel ? 4 : 3 + 3 * progress) * density)) : 0;

  return {
    phase,
    progress,
    cadence,
    count,
    // 1.6 米收到 0.25 米。引导段不再收拢（已经在放了），保持一个稳定的小环
    gatherRadius: inChannel ? 0.55 : 1.6 - 1.35 * progress,
    size: 0.34 + 0.16 * progress,
    // ★ 与 cadence 下限一起构成「3 格」的池预算，见上方 ★★
    life: 0.36,
    circleScale: Math.min(1, elapsed / POP_IN),
    circleSpin: inChannel ? 1.9 : 0.75 + 0.8 * progress,
    // 引导段亮一点：地上那圈是「这里正在下雪」的持续告示
    circleOpacity: (inChannel ? 0.85 : 0.55 + 0.25 * progress) * Math.min(1, elapsed / POP_IN),
  };
};

/**
 * 打断/失败时的散场爆发。
 *
 * ★ `gravity` 恒为负是**语义**不是手感调参：释放是向外向上炸开，
 *   「泄了」必须向下垮掉 —— 两者在运动通道上一眼可分，
 *   而 7.5 的假读条博弈里「他是放出来了还是被我打断了」是要在半秒内读出来的。
 */
export const fizzlePlanFor = (progress: number): {
  count: number; speed: number; size: number; life: number; gravity: number;
} => ({
  // 攒得越满，泄得越明显
  count: Math.round(6 + 10 * clamp01(progress)),
  speed: 1.1 + 0.8 * clamp01(progress),
  size: 0.4,
  life: 0.5,
  gravity: -3.2,
});

// ════════════════════════════════════════════════════════════════
//  按属性个性化的蓄力**形态**（用户实测反馈：施法过程八属性长得一模一样）
// ════════════════════════════════════════════════════════════════

/**
 * 一种属性的蓄力风格。
 *
 * ★★ 与 `WindupPlan` 是**两条正交的轴**：plan 管「进行到哪一步」
 *   （进度/节拍/预算 —— 对所有属性相同，池预算的 3 格数学不因属性而变），
 *   style 管「长什么样」（纹章/粒子从哪来/往哪走 —— 按属性分化）。
 *   刻意**不**让 style 触碰 cadence / life / count：那三个是池预算的输入，
 *   分属性改它们会让「某属性的施法者挤爆细流池」这种按属性偶发的 bug 出现。
 *
 * ★ 法阵外圈对**所有**属性保留 —— 它是 14.4 的关键元素
 *   （「这个人在施法」，7.5 假读条博弈的线索，任何画质都画，
 *   `verify:m12` #14e/#48d 钉着）。个性化动的是纹章与粒子，不动告示牌。
 */
export interface WindupStyle {
  /**
   * 法阵中央纹章：'own' = 该属性自己的主粒子贴图（雪花/火球/光斑/旋叶…），
   * 'rune' = 传统符文（奥术保留原味），'none' = 只留外圈
   * （物理系 —— 拉弓抡刀的人脚下不该有奥术法阵，收束感靠细环与手部火花）。
   */
  motif: 'own' | 'rune' | 'none';
  /** 纹章相对基准（1.55 米平面）的缩放 */
  motifScale: number;
  /** 外圈转速倍率。冰霜慢而稳、火焰急、物理几乎不转（那是「站稳」不是「咏唱」）*/
  spinScale: number;
  /** 聚能粒子从哪里生 */
  origin: 'hand-ring' | 'ground' | 'above';
  /** 竖直趋势（emitBurst 的 gravity）：正 = 上升（火苗/毒泡），负 = 下落（圣光/雪）*/
  lift: number;
  /** 粒子阻力。烟雾大阻力慢慢糊住，落叶小阻力飘 */
  drag: number;
  /** 生成半径倍率（相对 plan.gatherRadius）*/
  radiusScale: number;
}

/**
 * 八属性的蓄力风格表。每一行都对照 `schools.ts` 里 14.2「形状与运动」的原文措辞 ——
 * 释放/命中阶段已经按那一列分化了，预备阶段此前却是八属性同一个模子。
 */
export const WINDUP_STYLES: Record<
  'ember' | 'snowflake' | 'rune' | 'smoke' | 'beam' | 'leaf' | 'spark' | 'droplet',
  WindupStyle
> = {
  // 奥术：几何图形与符文 —— 现行样式就是它的正解，作为基准保留
  rune: { motif: 'rune', motifScale: 1, spinScale: 1, origin: 'hand-ring', lift: 0.6, drag: 3.4, radiusScale: 1 },
  // 火焰：跳动的火舌 —— 火苗从脚下法阵**升腾**，转得急
  ember: { motif: 'own', motifScale: 0.8, spinScale: 1.3, origin: 'ground', lift: 1.7, drag: 2.2, radiusScale: 1 },
  // 冰霜：六角冰晶 —— 法阵中央一朵大雪花，慢而稳地转，雪粒微微下沉
  snowflake: { motif: 'own', motifScale: 1.05, spinScale: 0.55, origin: 'hand-ring', lift: -0.35, drag: 2.8, radiusScale: 1.1 },
  // 暗影：扭曲的烟雾 —— 烟从脚下涌起、大阻力糊在身周
  smoke: { motif: 'own', motifScale: 0.9, spinScale: 0.8, origin: 'ground', lift: 0.9, drag: 4.5, radiusScale: 1.15 },
  // 神圣：垂直光柱 —— 光从**头顶落下**（唯一一个自上而下的，方向即语义）
  beam: { motif: 'own', motifScale: 0.85, spinScale: 0.75, origin: 'above', lift: -1.5, drag: 2.6, radiusScale: 0.6 },
  // 自然：藤蔓与叶片 —— 叶子绕身飘（半径最大、阻力最小），旋叶纹章
  leaf: { motif: 'own', motifScale: 0.95, spinScale: 0.9, origin: 'hand-ring', lift: 0.4, drag: 1.8, radiusScale: 1.35 },
  // 物理：直线冲击 —— 无纹章、外圈几乎不转（站稳蓄势），火花收在武器手周围
  spark: { motif: 'none', motifScale: 0, spinScale: 0.25, origin: 'hand-ring', lift: 0.2, drag: 3.8, radiusScale: 0.55 },
  // 毒素：滴落的液体 —— 毒泡从脚下咕嘟上冒
  droplet: { motif: 'own', motifScale: 0.85, spinScale: 0.65, origin: 'ground', lift: 1.1, drag: 3.0, radiusScale: 0.9 },
};

/**
 * ★ 物理系再按**职业**细分（用户点名：战士/盗贼/猎人的物理技能也要有区分）。
 *
 *   物理是唯一被三个职业共用主视觉的属性 —— 战士 11 技全物理、盗贼 12 中 9 物理、
 *   猎人主力也是物理，颜色通道又不能动（14.2 属性→颜色是可读性规则，
 *   改了就破坏「看颜色识属性」），所以只能在**形态/运动**通道上拆。
 *
 *   ★ 战士没有读条技能（全瞬发），蓄力阶段天然轮不到他 —— 他的个性
 *     在释放刀光层（SLASH_ACCENTS 四张轮换）。这张表实际服务的是
 *     猎人（瞄准射击 1.6s）与盗贼（潜入 1s），战士行保留是给
 *     未来可能出现的读条/引导技能定基调，不是死数据。
 */
export const PHYSICAL_WINDUP_STYLES: Record<'warrior' | 'rogue' | 'hunter', WindupStyle> = {
  // 战士：战意踏地 —— 尘土从脚下震起，环几乎不转（是「蹲桩发力」不是「咏唱」）
  warrior: { motif: 'none', motifScale: 0, spinScale: 0.2, origin: 'ground', lift: 0.8, drag: 2.0, radiusScale: 1.0 },
  // 盗贼：压低身形 —— 微尘贴地打旋，环**反向**慢转（负 spinScale：与法系一眼可分）
  rogue: { motif: 'none', motifScale: 0, spinScale: -0.4, origin: 'ground', lift: 0.3, drag: 2.6, radiusScale: 0.6 },
  // 猎人：凝神聚焦 —— 火花收得极紧（半径最小），环近乎静止，读作「屏息瞄准」
  hunter: { motif: 'none', motifScale: 0, spinScale: 0.15, origin: 'hand-ring', lift: 0.15, drag: 4.2, radiusScale: 0.45 },
};

/**
 * 取一次蓄力的风格。物理系传 `skillId`（形如 `hunter.aimed_shot`）时
 * 按职业前缀细分；查不到（未知职业/未传）回落到 spark 基础行。
 */
export const windupStyleOf = (
  particle: keyof typeof WINDUP_STYLES,
  skillId?: string,
): WindupStyle => {
  if (particle === 'spark' && skillId) {
    const cls = skillId.split('.')[0] as keyof typeof PHYSICAL_WINDUP_STYLES;
    const sub = PHYSICAL_WINDUP_STYLES[cls];
    if (sub) return sub;
  }
  return WINDUP_STYLES[particle];
};
