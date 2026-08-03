/**
 * 军械交互的 HUD。规格书 10.2 / 10.4 / 10.5 / 15.3。
 *
 * 三块内容，各对应一条原文：
 *   · **交互提示**  10.5「角色进入 2.2 米交互距离后按交互键」+
 *                   10.2「不符合职业的玩家……交互时提示『职业不匹配』」
 *   · **拾取进度**  10.5「持续 0.8 秒完成拾取」，中断要有明确反馈
 *   · **三选一面板** 10.4「军械箱被打开后，只向打开者显示其职业的三个横向选择」
 *
 * ★ DOM 而不是 3D：与既有 HUD 同一套技术栈和 UI 缩放（17.2 的界面缩放
 *   对它自动生效）。
 *
 * ★★ **进度条的时间基准是服务器时间。** 拾取是服务器判定的（`tickPickups`），
 *   客户端用本地时钟画进度会在 RTT 抖动时出现「条走满了却还没拿到」。
 *   这里只在收到 `PickupResult` 时结束，条本身按服务器时间推进。
 */

import { ArsenalChoice, EQUIP, type ArsenalOption } from '@wowpvp/shared';

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

const CHOICE_LABEL: Record<ArsenalChoice, string> = {
  [ArsenalChoice.Offense]: '进攻',
  [ArsenalChoice.Mobility]: '机动',
  [ArsenalChoice.Defense]: '防御',
};

/** 军械箱被打开后挂着的三选一 */
export interface PendingOffer {
  armoryId: number;
  options: readonly ArsenalOption[];
}

export interface InteractPrompt {
  /** 主行：「按 G 拾取 巨剑」/「按 G 打开军械箱」 */
  text: string;
  /** 副行：10.2 的「职业不匹配（法师）」之类。可拾取时为空 */
  hint?: string;
  /** 不可交互时整条变暗，但**仍然显示** —— 10.2「看得到但拿不走」 */
  enabled: boolean;
}

export class ArsenalHud {
  private readonly prompt: HTMLElement;
  private readonly progress: HTMLElement;
  private readonly panel: HTMLElement;

  private offer: PendingOffer | undefined;
  private pickupStartedAt: number | undefined;
  private toastText = '';
  private toastUntil = 0;

  /** 玩家点了三选一中的某一个。由场景接上发协议消息 */
  onChoose: ((armoryId: number, choice: ArsenalChoice) => void) | undefined;

  constructor(container: HTMLElement) {
    this.prompt = document.createElement('div');
    this.prompt.id = 'arsenal-prompt';
    this.prompt.style.display = 'none';
    container.appendChild(this.prompt);

    this.progress = document.createElement('div');
    this.progress.id = 'arsenal-progress';
    this.progress.style.display = 'none';
    container.appendChild(this.progress);

    this.panel = document.createElement('div');
    this.panel.id = 'arsenal-panel';
    this.panel.style.display = 'none';
    container.appendChild(this.panel);

    /**
     * ★ 事件委托挂在面板上，而不是每次 render 后重新绑三个按钮 ——
     *   重绑会在「快速点两下」时丢掉一次点击（innerHTML 重建期间）。
     */
    this.panel.addEventListener('click', (ev) => {
      const el = (ev.target as HTMLElement).closest('[data-choice]');
      if (!el || !this.offer) return;
      const choice = el.getAttribute('data-choice') as ArsenalChoice;
      this.onChoose?.(this.offer.armoryId, choice);
      // ★ 乐观关闭：服务器拒绝时会回 Rejected，那时再 toast
      this.offer = undefined;
      this.panel.style.display = 'none';
    });
  }

  // ── 三选一（10.4）────────────────────────────────────────────

  showOffer(offer: PendingOffer): void {
    this.offer = offer;
    this.panel.style.display = '';
    this.panel.innerHTML = `
      <div class="ap-title">军械箱 —— 选择一个</div>
      <div class="ap-row">
        ${offer.options.map((o) => this.optionHtml(o)).join('')}
      </div>
      <div class="ap-foot">三个都是横向取舍：各有优势，也各有代价</div>`;
  }

  private optionHtml(o: ArsenalOption): string {
    return `
      <button class="ap-opt" data-choice="${esc(o.choice)}">
        <div class="ap-opt-name">${esc(CHOICE_LABEL[o.choice])}</div>
        <div class="ap-opt-adv">优势：${esc(o.advantage)}</div>
        <div class="ap-opt-cost">代价：${esc(o.cost)}</div>
      </button>`;
  }

  get offerOpen(): boolean {
    return this.offer !== undefined;
  }

  closeOffer(): void {
    this.offer = undefined;
    this.panel.style.display = 'none';
  }

  // ── 拾取进度（10.5）──────────────────────────────────────────

  beginPickup(serverTime: number): void {
    this.pickupStartedAt = serverTime;
  }

  /** 10.5：完成或中断都要有明确反馈 */
  endPickup(ok: boolean, reason: string | undefined, serverTime: number): void {
    this.pickupStartedAt = undefined;
    this.toastText = ok ? '拾取完成' : (reason ?? '拾取失败');
    this.toastUntil = serverTime + 2.5;
  }

  /** 服务器拒绝了一次交互/开箱，原样转达（10.2 的「职业不匹配」走这条） */
  toast(text: string, serverTime: number): void {
    this.toastText = text;
    this.toastUntil = serverTime + 2.5;
  }

  // ── 每帧 ──────────────────────────────────────────────────────

  render(prompt: InteractPrompt | undefined, serverTime: number): void {
    // 交互提示。★ 拾取进行中时不显示 —— 那时该看的是进度条
    if (prompt && this.pickupStartedAt === undefined) {
      this.prompt.style.display = '';
      this.prompt.className = prompt.enabled ? '' : 'ap-disabled';
      this.prompt.innerHTML = `
        <div class="ap-line">${esc(prompt.text)}</div>
        ${prompt.hint ? `<div class="ap-hint">${esc(prompt.hint)}</div>` : ''}`;
    } else {
      this.prompt.style.display = 'none';
    }

    if (this.pickupStartedAt !== undefined) {
      const elapsed = serverTime - this.pickupStartedAt;
      const pct = Math.max(0, Math.min(100, (elapsed / EQUIP.PICKUP_SECONDS) * 100));
      this.progress.style.display = '';
      this.progress.innerHTML = `
        <div class="ap-prog-label">拾取中…（移动会中断）</div>
        <div class="ap-bar"><i style="width:${pct.toFixed(0)}%"></i></div>`;
    } else if (serverTime < this.toastUntil) {
      this.progress.style.display = '';
      this.progress.innerHTML = `<div class="ap-toast">${esc(this.toastText)}</div>`;
    } else {
      this.progress.style.display = 'none';
    }
  }

  hide(): void {
    this.prompt.style.display = 'none';
    this.progress.style.display = 'none';
    this.panel.style.display = 'none';
  }
}
