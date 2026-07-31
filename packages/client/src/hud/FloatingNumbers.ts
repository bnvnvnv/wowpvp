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
}

const LIFETIME = 1.15;
/** 上浮高度（米）。★ 用世界坐标而不是像素 —— 远处的数字该飘得更少 */
const RISE = 1.4;

export type FloaterKind = 'damage' | 'heal' | 'crit' | 'miss' | 'immune' | 'absorb';

const CLASS_OF: Record<FloaterKind, string> = {
  damage: 'fn-damage',
  heal: 'fn-heal',
  crit: 'fn-crit',
  miss: 'fn-miss',
  immune: 'fn-immune',
  absorb: 'fn-absorb',
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
   */
  push(text: string, kind: FloaterKind, at: { x: number; y: number; z: number }): void {
    if (!this.enabled) return;
    if (this.active.length >= FloatingNumbers.MAX) {
      // 满了就顶掉最老的一条 —— 丢新的会让「刚打出的暴击」看不见，正好反了
      this.active.shift()?.el.remove();
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
      f.el.style.transform = `translate(-50%,-50%) translate(${x}px,${y}px)`;
      // 后 40% 淡出；前段保持不透明，否则最该看清的瞬间反而最淡
      f.el.style.opacity = String(t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4);
    }
  }

  clear(): void {
    for (const f of this.active) f.el.remove();
    this.active.length = 0;
  }
}
