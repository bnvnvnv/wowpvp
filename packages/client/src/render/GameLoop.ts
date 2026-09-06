/**
 * 固定时间步主循环。
 *
 * 模拟必须按固定步长推进（与服务器的 20Hz tick 对齐），渲染按显示器帧率插值。
 * 变步长模拟会让 `stepMovement` 失去确定性 —— 而确定性是客户端预测回放
 * （docs/08-network-protocol.md §5）的前提，不是可选项。
 */

import { SIM } from '@wowpvp/shared';

export type SimStep = (dt: number) => void;
/**
 * `dt` 是**渲染时钟**（可能被顿帧缩放），`realDt` 是真实时钟。
 * 第三参强制每个消费者显式选择自己在哪个时钟上 —— 见场景 draw 里的分配表：
 * 打击表现（粒子/mixer/浮字/镜头）用 dt，状态机与网络时钟
 * （AnimationController/serverTime/倒计时）用 realDt。
 */
export type RenderFrame = (alpha: number, dt: number, realDt: number) => void;
/**
 * 每个 rAF 帧调用一次，在所有固定步之前。
 * 输入采样必须放在这里 —— 一帧内可能跑 0 到 5 个模拟步，
 * 在 step 里采样会导致「一帧跑两步就吃掉两次跳跃」或「零步时输入丢失」。
 */
export type BeforeFrame = (dt: number) => void;

/** 一帧最多补多少个模拟步。防止切后台回来后一次补几百步卡死 */
const MAX_STEPS_PER_FRAME = 5;

export class GameLoop {
  private accumulator = 0;
  private lastTime = 0;
  private rafId = 0;
  private running = false;
  private renderBudget = 0;
  private renderElapsed = 0;
  private visualElapsed = 0;
  private tick: FrameRequestCallback | undefined;

  /** 最近一秒的帧率与模拟步数，供调试面板显示 */
  fps = 0;
  private frameCount = 0;
  private fpsTimer = 0;

  constructor(
    private readonly step: SimStep,
    private readonly render: RenderFrame,
    private readonly beforeFrame?: BeforeFrame,
    /** 模拟步长。默认与服务器 tick 对齐 */
    private readonly fixedDt: number = SIM.TICK_DT,
    /**
     * 渲染时间缩放钩子（顿帧）。每帧收真实 dt，返回本帧的缩放系数。
     * ★★ 它只影响传给 `render` 的第二参 —— 见下面 render 调用处的注释。
     */
    private readonly timeScale?: (realDt: number) => number,
    private readonly frameRateLimit: () => number = () => 60,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.accumulator = this.renderBudget = this.renderElapsed = this.visualElapsed = 0;
    globalThis.document?.addEventListener('visibilitychange', this.onVisibilityChange);
    const tick = (now: number) => {
      if (!this.running) return;
      const frameDt = Math.min((now - this.lastTime) / 1000, 0.25);
      this.lastTime = now;

      this.beforeFrame?.(frameDt);

      this.accumulator += frameDt;
      let steps = 0;
      while (this.accumulator >= this.fixedDt && steps < MAX_STEPS_PER_FRAME) {
        this.step(this.fixedDt);
        this.accumulator -= this.fixedDt;
        steps++;
      }
      // 补步上限用完还有欠账 → 丢弃，避免螺旋death
      if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0;

      this.fpsTimer += frameDt;
      if (this.fpsTimer >= 0.5) {
        this.fps = this.frameCount / this.fpsTimer;
        this.frameCount = 0;
        this.fpsTimer = 0;
      }

      /**
       * ★★ **只有渲染 dt 被顿帧缩放。**
       *   累加器、固定步 `step()`、输入采样 `beforeFrame()` 一律用真实 dt：
       *     · 缩放模拟步 → 客户端预测回放不再确定（docs/08 §5），作弊级 bug
       *     · 缩放输入采样 → 顿帧期间「按了没反应」
       *   `frameDt` 同时作为第三参传给 render，让消费者显式选时钟。
       */
      this.renderBudget += frameDt;
      this.renderElapsed += frameDt;
      this.visualElapsed += frameDt * (this.timeScale?.(frameDt) ?? 1);
      const interval = 1 / Math.max(1, this.frameRateLimit());
      // Keep input and simulation at their original cadence. Only drawing is capped.
      if (this.renderBudget >= interval - 0.001) {
        this.render(this.accumulator / this.fixedDt, this.visualElapsed, this.renderElapsed);
        this.frameCount++;
        this.renderBudget = Math.max(0, this.renderBudget % interval);
        if (this.renderBudget > interval - 0.001) this.renderBudget = 0;
        this.renderElapsed = this.visualElapsed = 0;
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.tick = tick;
    if (!globalThis.document?.hidden) this.rafId = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    globalThis.document?.removeEventListener('visibilitychange', this.onVisibilityChange);
  }

  private onVisibilityChange = (): void => {
    cancelAnimationFrame(this.rafId);
    if (!this.running || globalThis.document?.hidden || !this.tick) return;
    this.lastTime = performance.now();
    this.accumulator = this.renderBudget = this.renderElapsed = this.visualElapsed = 0;
    this.frameCount = this.fpsTimer = this.fps = 0;
    this.rafId = requestAnimationFrame(this.tick);
  };
}
