/**
 * M12：浮动伤害/治疗数字。规格书 14.1（命中反馈）、17.2（可关闭）。
 *
 * ★★ **17.2 的开关必须是真的关掉，而不是「透明度调成 0」。**
 *   `.damage-number` 已经由 `#combat-hud.no-damage-numbers` 的 CSS 规则
 *   `display: none` 掉了（M9 就写好了，一直没有消费者）。这里做的是
 *   **不创建元素** —— 关掉之后连 DOM 都不产生，否则 12v12 的团战里
 *   会有几百个隐藏节点在跟着镜头做投影计算。
 *
 * ★★ **8.x 的六种结果各有各的读法**，不是「都显示一个数字」：
 *   伤害是数字、治疗是带 + 的绿数字，而闪避/招架/格挡/免疫是**文字**——
 *   它们没有数值可言，显示「0」会让玩家以为打中了但被减到 0。
 *
 * ★ DOM 而不是 canvas/sprite：数字要跟随可访问性的界面缩放（17.2），
 *   而那是通过 CSS 自定义属性实现的；画在 canvas 上就得重新实现一遍缩放。
 *
 * ★ 弹跳（打击感改造）：scale 写进每帧重写的 transform 字符串里 ——
 *   CSS keyframes 动 transform 会被 update() 的整串覆盖，加内层 <span>
 *   让 CSS 动又会把 12v12 的 40 个节点翻倍。曲线放在 JS 里还与上浮曲线
 *   相邻，调参在同一处。
 */

import * as THREE from 'three';

/** 一条正在飘的数字 */
interface Floater {
  el: HTMLElement;
  /** 世界坐标起点 */
  origin: THREE.Vector3;
  /** 已存活秒数 */
  age: number;
  /** 水平漂移方向，避免同一目标的多个数字重叠成一坨 */
  drift: number;
  /** 弹出的峰值缩放（POP_PEAK 或 push 显式传入的重击值）*/
  peak: number;
  kind: FloaterKind;
}

const LIFETIME = 1.15;
/** 上浮高度（米）。★ 用世界坐标而不是像素 —— 远处的数字该飘得更少 */
const RISE = 1.4;

export type FloaterKind = 'damage' | 'heal' | 'crit' | 'critTaken' | 'miss' | 'immune' | 'absorb';

const CLASS_OF: Record<FloaterKind, string> = {
  damage: 'fn-damage',
  heal: 'fn-heal',
  crit: 'fn-crit',
  // X10 追加轮拍板：自己挨的暴击红色（打别人的橙黄）—— 弹道同款、只换色
  critTaken: 'fn-crit-taken',
  miss: 'fn-miss',
  immune: 'fn-immune',
  absorb: 'fn-absorb',
};

/** 两种暴击共用同一套「爆炸弹道」（见 CRIT_POP） */
export const isCritKind = (k: FloaterKind): boolean => k === 'crit' || k === 'critTaken';

// ── 弹出曲线：先胀后消（Q 版基调，偏差 #6 的「先胀后消的 Q 弹粒子」同款）──
/** 冲上峰值用时 */
export const POP_IN = 0.09;
/** 从峰值回落到 1.0 用时 */
export const POP_SETTLE = 0.16;

/**
 * 各类型的峰值缩放。
 *
 * ★★ 17.2 / 规格书 915 行：暴击**不能只靠颜色**区分 —— 这里的尺寸与运动
 *   才是主通道，`.fn-crit` 的橙色与高亮闪是第三条（色盲模式下颜色被重映射，
 *   闪光仍成立）。暴击 26px × 2.3 峰值 ≈ 60px 一闪而出、回落仍有
 *   26px × 1.25 ≈ 33px；普通 15px × 1.25 ≈ 19px 回落 15px —— 全程差一倍。
 */
export const POP_PEAK: Record<FloaterKind, number> = {
  damage: 1.25,
  crit: 5,
  critTaken: 5,
  heal: 1.15,
  absorb: 1.1,
  miss: 1.05,
  immune: 1.05,
};

/**
 * 暴击的「爆炸弹道」（X10 追加轮用户两轮拍板：「一闪而出的大字」→
 * 「字从小变大，效果像个爆炸，字的大小跟人差不多大」）：
 *   · 从 0.35 起步在 0.09 秒内**炸**到 5.0 倍峰值（26px × 5 ≈ 130px ——
 *     屏幕上与角色身高同量级），从小变大的过程就是爆炸感的来源
 *   · `settleTo 1.5` —— 回落后**仍保持大字**（≈39px）：峰值只有一瞬，
 *     混战里肉眼读到的是回落尺寸
 *   · 颜色分敌我（橙黄=打别人 / 红=自己挨的），CSS crit-flash 高亮闪是
 *     第三通道（色盲模式下也成立）
 */
export const CRIT_POP = { settleTo: 1.5 } as const;

/** 弹出缩放：0.35 起步冲到 peak（POP_IN），easeOutCubic 落回 settleTo（默认 1.0）*/
export const popScale = (
  age: number,
  peak: number,
  opts: { instant?: boolean; settleTo?: number } = {},
): number => {
  const settle = opts.settleTo ?? 1;
  if (age <= 0) return opts.instant ? peak : 0.35;
  if (age < POP_IN) return opts.instant ? peak : 0.35 + (peak - 0.35) * (age / POP_IN);
  const k = Math.min(1, (age - POP_IN) / POP_SETTLE);
  return peak + (settle - peak) * (1 - (1 - k) ** 3);
};

export class FloatingNumbers {
  private readonly layer: HTMLElement;
  private readonly active: Floater[] = [];
  private enabled = true;
  /** 同一时刻最多多少个 —— 12v12 的 AOE 会瞬间产生几十个 */
  private static readonly MAX = 40;
  private driftCursor = 0;

  constructor(container: HTMLElement) {
    this.layer = document.createElement('div');
    this.layer.id = 'floating-numbers';
    container.appendChild(this.layer);
  }

  /** 17.2：跟随 `AccessibilitySettings.damageNumbers` */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.clear();
  }

  /**
   * 添加一条。`at` 是世界坐标（一般取目标头顶）。
   * ★ 关闭时**直接返回**，不建 DOM（见文件头）。
   * `opts.peakScale` 给重击（非暴击）用：放大数字但不抢暴击的橙色。
   */
  push(
    text: string,
    kind: FloaterKind,
    at: { x: number; y: number; z: number },
    opts: { peakScale?: number } = {},
  ): void {
    if (!this.enabled) return;
    if (this.active.length >= FloatingNumbers.MAX) {
      /**
       * 满了优先顶掉最老的**非暴击**条目，全是暴击才顶最老的 ——
       * 文件顶那句「丢新的会让刚打出的暴击看不见」现在有真暴击了，
       * 反过来也一样：一片 DoT 跳字不该把 0.5 秒前的暴击挤掉。
       */
      const i = this.active.findIndex((f) => !isCritKind(f.kind));
      const evicted = i >= 0 ? this.active.splice(i, 1)[0] : this.active.shift();
      evicted?.el.remove();
    }
    const el = document.createElement('div');
    el.className = `damage-number ${CLASS_OF[kind]}`;
    el.textContent = text;
    this.layer.appendChild(el);
    // 左右交替漂移：同一目标连续挨打时数字排成两列而不是叠在一起
    this.driftCursor = (this.driftCursor + 1) % 6;
    this.active.push({
      el,
      origin: new THREE.Vector3(at.x, at.y, at.z),
      age: 0,
      drift: (this.driftCursor - 2.5) * 11,
      peak: opts.peakScale ?? POP_PEAK[kind],
      kind,
    });
  }

  /** 每帧：推进生命周期并把世界坐标投影到屏幕 */
  update(dt: number, camera: THREE.Camera, canvas: HTMLCanvasElement): void {
    if (this.active.length === 0) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const v = new THREE.Vector3();

    for (let i = this.active.length - 1; i >= 0; i--) {
      const f = this.active[i]!;
      f.age += dt;
      if (f.age >= LIFETIME) {
        f.el.remove();
        this.active.splice(i, 1);
        continue;
      }
      const t = f.age / LIFETIME;
      // 先快后慢的上浮，像被抛上去一样 —— 匀速上浮读起来很机械
      v.copy(f.origin);
      v.y += RISE * Math.sqrt(t);
      v.project(camera);

      if (v.z > 1) { f.el.style.display = 'none'; continue; } // 镜头背后
      f.el.style.display = '';
      const x = (v.x * 0.5 + 0.5) * w + f.drift * t;
      const y = (-v.y * 0.5 + 0.5) * h;
      const s = popScale(f.age, f.peak, isCritKind(f.kind) ? CRIT_POP : {});
      f.el.style.transform =
        `translate(-50%,-50%) translate(${x}px,${y}px) scale(${s.toFixed(3)})`;
      // 后 40% 淡出；前段保持不透明，否则最该看清的瞬间反而最淡
      f.el.style.opacity = String(t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4);
    }
  }

  clear(): void {
    for (const f of this.active) f.el.remove();
    this.active.length = 0;
  }
}
