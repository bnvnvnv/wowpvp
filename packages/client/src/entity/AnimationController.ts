/**
 * 动作状态机。规格书 13.3 / 13.4，验收 #47。
 *
 * 刻意**不依赖 three.js** —— 状态机是纯逻辑，可以单测。
 * 真正的动画片段播放由渲染层根据 `state` 决定（M8 引入动画资源前，
 * 渲染层用颜色和缩放表现状态，这足以验收 #47）。
 */

export const AnimState = {
  Idle: 'idle',
  Walk: 'walk',
  Run: 'run',
  StrafeLeft: 'strafeLeft',
  StrafeRight: 'strafeRight',
  Backward: 'backward',
  Jump: 'jump',
  Fall: 'fall',
  Land: 'land',
  Stunned: 'stunned',
  Death: 'death',
} as const;
export type AnimState = (typeof AnimState)[keyof typeof AnimState];

export const ANIM = {
  /**
   * ★ 双阈值迟滞。13.4「移动状态具有速度平滑和进入/退出迟滞，
   * 不能因单帧位置抖动反复切换待机和奔跑」。
   * 单阈值会在速度恰好卡在阈值附近时每帧闪烁。
   */
  ENTER_WALK: 0.35,
  EXIT_WALK: 0.15,
  ENTER_RUN: 4.0,
  EXIT_RUN: 3.0,

  /** 速度平滑系数，1/s。状态判定用平滑后的速度而非原始值 */
  SPEED_SMOOTH: 8,

  /** 落地动作持续时间 */
  LAND_DURATION: 0.18,
  /** 超过这个下落高度才播放明显的落地动作（13.5「小落差平滑，大落差有反馈」）*/
  LAND_FEEDBACK_HEIGHT: 3,

  /** 移动动画的参考速度。timeScale = 实际速度 / 它，保证腿部节奏与速度一致 */
  REFERENCE_SPEED: 7,
} as const;

export interface AnimSample {
  /** 本帧的水平位移距离（米）*/
  horizontalDistance: number;
  dt: number;
  grounded: boolean;
  /** 竖直速度，用于区分 Jump 与 Fall */
  verticalVelocity: number;
  /** 本帧是否发生了传送级位置跳变 */
  teleported: boolean;
  /** 输入方向，用于区分前进/后退/侧移 */
  forward: number;
  strafe: number;
  /** 落地事件（若本帧落地）*/
  landedFrom?: number;
  stunned?: boolean;
  dead?: boolean;
}

export class AnimationController {
  state: AnimState = AnimState.Idle;
  /** 平滑后的速度，米/秒 */
  smoothedSpeed = 0;
  /** 动画播放倍速，13.4「腿部动作节奏与实际速度一致」 */
  timeScale = 1;

  private landTimer = 0;

  update(s: AnimSample): AnimState {
    // ── 速度平滑 ──────────────────────────────────────────────
    // ★ 13.4「传送、位置纠正和大位移不能被识别为高速跑步」：
    //   传送帧直接跳过速度更新，否则一次 20 米的闪现会算出 1200 m/s。
    if (!s.teleported && s.dt > 0) {
      const raw = s.horizontalDistance / s.dt;
      const k = 1 - Math.exp(-ANIM.SPEED_SMOOTH * s.dt);
      this.smoothedSpeed += (raw - this.smoothedSpeed) * k;
    }

    if (this.landTimer > 0) this.landTimer -= s.dt;

    // ── 覆盖状态（优先级从高到低）────────────────────────────
    if (s.dead) return this.set(AnimState.Death);
    if (s.stunned) return this.set(AnimState.Stunned);

    // ── 空中 ──────────────────────────────────────────────────
    if (!s.grounded) {
      return this.set(s.verticalVelocity > 0 ? AnimState.Jump : AnimState.Fall);
    }

    // ── 落地 ──────────────────────────────────────────────────
    if (s.landedFrom !== undefined && s.landedFrom >= ANIM.LAND_FEEDBACK_HEIGHT) {
      this.landTimer = ANIM.LAND_DURATION;
    }
    if (this.landTimer > 0) return this.set(AnimState.Land);

    // ── 地面移动：双阈值迟滞 ─────────────────────────────────
    const v = this.smoothedSpeed;
    const wasMoving =
      this.state === AnimState.Walk ||
      this.state === AnimState.Run ||
      this.state === AnimState.Backward ||
      this.state === AnimState.StrafeLeft ||
      this.state === AnimState.StrafeRight;
    const wasRunning = this.state === AnimState.Run;

    const moving = wasMoving ? v > ANIM.EXIT_WALK : v > ANIM.ENTER_WALK;
    if (!moving) {
      this.timeScale = 1;
      return this.set(AnimState.Idle);
    }

    this.timeScale = Math.max(0.25, v / ANIM.REFERENCE_SPEED);

    // 方向优先级：后退 > 纯侧移 > 前进
    if (s.forward < -0.1) return this.set(AnimState.Backward);
    if (Math.abs(s.forward) < 0.1 && Math.abs(s.strafe) > 0.1) {
      return this.set(s.strafe > 0 ? AnimState.StrafeRight : AnimState.StrafeLeft);
    }

    const running = wasRunning ? v > ANIM.EXIT_RUN : v > ANIM.ENTER_RUN;
    return this.set(running ? AnimState.Run : AnimState.Walk);
  }

  private set(next: AnimState): AnimState {
    this.state = next;
    return next;
  }
}
