/**
 * 渲染顿帧（hit-stop）—— 打击瞬间的短暂时间缩放。打击感改造引入。
 *
 * ★★ 规格书没有这个效果（docs/10 已知偏差 #8）。它的安全边界只有一条：
 *   **只作用于渲染 dt**（GameLoop 的 timeScale 钩子），模拟步、输入采样、
 *   插值时钟一律走真实 dt —— 缩放模拟步会破坏客户端预测的确定性
 *   （docs/08 §5），那是作弊级 bug 而不是手感问题。
 *
 * ★ 顿帧不隐藏任何信息通道，所以它有独立开关（accessibility.hitStop）
 *   而不受 17.2 第二句的反模式限制 —— 关掉之后玩家能看到的信息一字不少。
 */

export const HIT_STOP = {
  /**
   * 各档的冻结时长（秒）。★ 上限 0.09 —— 再长玩家读到的不是「重」而是「卡」，
   * 而且顿帧期间输入仍在跑（见 GameLoop），过长会让人以为掉线。
   * light/normal 为 0：普通命中不顿 —— 顿帧的全部价值在「这一下不一样」。
   */
  DURATION: {
    light: 0,
    normal: 0,
    heavy: 0.055,
    crit: 0.075,
    critHeavy: 0.09,
    kill: 0.09,
  },
  /** 冻结期间的渲染时间缩放。0 完全静止读作掉帧，0.06 保留一丝蠕动 */
  SCALE: 0.06,
  /** 解冻回升时间，避免 0.06 → 1 的二次「顿」 */
  RECOVER: 0.06,
  /** ★ 两次顿帧的最小间隔。AOE 打中 5 个人不该连冻 5 次 */
  MIN_GAP: 0.15,
} as const;

export class HitStop {
  enabled = true;

  /** 剩余冻结秒数 */
  private left = 0;
  /** 解冻回升的剩余秒数 */
  private recovering = 0;
  /** 距上一次触发经过的真实秒数（MIN_GAP 用）*/
  private sinceLast = Infinity;

  /**
   * 触发一次顿帧。★ 取 max **不累加** —— 团战里累加会把画面冻死。
   * MIN_GAP 内的重复触发直接忽略（已经在顿的那一下就是反馈）。
   */
  trigger(seconds: number): void {
    if (!this.enabled || seconds <= 0) return;
    if (this.sinceLast < HIT_STOP.MIN_GAP) return;
    this.sinceLast = 0;
    this.left = Math.max(this.left, seconds);
  }

  /**
   * 返回本帧的渲染时间缩放（1 = 正常）。
   * ⚠️ 参数必须是**真实** dt —— 用缩放后的 dt 推进自己会让冻结永不结束。
   */
  scale(realDt: number): number {
    this.sinceLast += realDt;
    if (!this.enabled) {
      this.left = 0;
      this.recovering = 0;
      return 1;
    }
    if (this.left > 0) {
      this.left -= realDt;
      if (this.left <= 0) this.recovering = HIT_STOP.RECOVER;
      return HIT_STOP.SCALE;
    }
    if (this.recovering > 0) {
      this.recovering -= realDt;
      const k = 1 - Math.max(0, this.recovering) / HIT_STOP.RECOVER;
      return HIT_STOP.SCALE + (1 - HIT_STOP.SCALE) * k;
    }
    return 1;
  }

  /** 诊断用：当前是否处于冻结（不含回升段）*/
  get frozen(): boolean {
    return this.left > 0;
  }
}
