/**
 * 一次命中的「份量」分档 —— 打击感的唯一判据。
 *
 * ★★ **两个场景共用同一份判据。** 试验场与联网场景各写一套阈值的话，
 *   下一次调数值时两边必然漂开 —— 而玩家读到的「这一下很重」
 *   在单机与联网里必须是同一个意思。
 *
 * ★ 纯函数、零依赖 —— HitFeedback 算好档位后传给 SpellVfx / HitStop /
 *   CameraShake，它们不各自重算。
 */

export type ImpactTier = 'light' | 'normal' | 'heavy' | 'crit' | 'critHeavy' | 'kill';

export const IMPACT = {
  /**
   * 「重击」阈值：一击打掉目标最大生命的这个比例。
   * ★ 用**比例**不用绝对值 —— 同一发火球打法师（900）与打死骑（1200）
   *   掉血感受本就不同，玩家读到的「重」就是「他掉了一大块」。
   * 取 0.18：八职业 baseHealth 900–1200 → 162–216 点。技能数值分布
   * （DoT 跳 35、常规法术 120–150、大招 420、武器 1.6 倍挥击约 240）下，
   * 「大招/暴力挥击」算重、常规法术不算 —— 目标是重击占比 15–25%。
   */
  HEAVY_FRACTION: 0.18,
  /** 拿不到 maxHealth 时的绝对值兜底（≈0.18 × 1050 中位生命）*/
  HEAVY_ABSOLUTE: 190,
  /** 低于此值算轻击：不顿帧、不震动，只有数字与粒子（DoT 跳都落在这里）*/
  LIGHT_ABSOLUTE: 40,
} as const;

export const impactTierOf = (o: {
  amount: number;
  crit: boolean;
  /** 击杀信号（协议 Damage.overkill > 0，或本地 sim 事件的 overkill）*/
  overkill?: number;
  maxHealth?: number;
}): ImpactTier => {
  // 击杀压过一切 —— 致命一击就是最重的一击
  if ((o.overkill ?? 0) > 0) return 'kill';
  const heavy =
    o.maxHealth !== undefined
      ? o.amount >= o.maxHealth * IMPACT.HEAVY_FRACTION
      : o.amount >= IMPACT.HEAVY_ABSOLUTE;
  // 暴击优先于数值档：多小的暴击都至少是 crit —— 它是掷骰结果，玩家要读到
  if (o.crit) return heavy ? 'critHeavy' : 'crit';
  if (heavy) return 'heavy';
  return o.amount < IMPACT.LIGHT_ABSOLUTE ? 'light' : 'normal';
};
