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
