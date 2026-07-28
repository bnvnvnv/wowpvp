/**
 * 固定时间步主循环。
 *
 * 模拟必须按固定步长推进（与服务器的 20Hz tick 对齐），渲染按显示器帧率插值。
 * 变步长模拟会让 `stepMovement` 失去确定性 —— 而确定性是客户端预测回放
 * （docs/08-network-protocol.md §5）的前提，不是可选项。
 */

import { SIM } from '@wowpvp/shared';

export type SimStep = (dt: number) => void;
export type RenderFrame = (alpha: number, dt: number) => void;
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
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
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

      this.frameCount++;
      this.fpsTimer += frameDt;
      if (this.fpsTimer >= 0.5) {
        this.fps = this.frameCount / this.fpsTimer;
        this.frameCount = 0;
        this.fpsTimer = 0;
      }

      this.render(this.accumulator / this.fixedDt, frameDt);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }
}
