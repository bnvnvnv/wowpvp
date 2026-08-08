/**
 * 大乱斗积分商店的 HUD（P13，玩家原话：「积分兑换装备和其他东西」）。
 *
 * ★★ **余额只有一个来源：服务器的 `FfaShop` 消息。**
 *   本类里没有任何一处 `this.balance -= cost` —— 本地先减一份的话，
 *   被拒绝的那次购买（积分不足、槽位已满、已经买过保险）会让面板与真账
 *   长期错开，而玩家只会觉得「我的分数算错了」。乐观更新在这里得不偿失：
 *   服务器扣完账**当 tick**就会重发一条 `FfaShop`，延迟本来就只有一帧。
 *
 * ★ **大乱斗才显示**，判据是「收到过 `FfaShop` 没有」而不是「地图是不是
 *   ffa 图」：服务器只在大乱斗里发这条消息，让可见性跟着消息走，
 *   客户端就不需要复述一遍「哪些模式有商店」这条规则（复述了就会漂移）。
 *
 * ★ 折叠态仍然显示余额 —— 积分是这个模式的核心反馈，不该藏在面板里。
 *   展开才占地方，也才吃数字键（免得平时抢了 1–9 的技能键）。
 */

import type { FfaOffer } from '@wowpvp/shared';

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/**
 * 17.2「不能只依赖颜色」：每类商品带一个**汉字**标记。
 * ★ 不用 emoji —— 各平台字形差异大，且色盲模式下彩色 emoji 反而是噪声。
 */
const KIND_MARK: Record<FfaOffer['kind'], string> = {
  weapon: '［武］',
  armor: '［甲］',
  consumable: '［药］',
  heal: '［血］',
  insurance: '［保］',
};

/** 数字键能买到第几件。★ 与 `Action.Skill1..9` 共用键位，只在展开时生效 */
export const SHOP_HOTKEY_SLOTS = 9;

export class FfaShopHud {
  private readonly panel: HTMLElement;

  /** 收到过货架 = 这局有商店（见文件头的 ★）*/
  private available = false;
  private expanded = false;
  private balance = 0;
  private offers: readonly FfaOffer[] = [];

  /** 玩家点了某件商品。由场景接上发 `FfaBuy` */
  onBuy: ((offerId: string) => void) | undefined;

  constructor(container: HTMLElement) {
    this.panel = document.createElement('div');
    this.panel.id = 'ffa-shop';
    this.panel.style.display = 'none';
    container.appendChild(this.panel);

    /**
     * ★ 事件委托挂在面板上而不是每次重绘后重绑按钮 ——
     *   与 `ArsenalHud` 同一个理由：重绑会在「快速点两下」时丢掉一次点击。
     */
    this.panel.addEventListener('click', (ev) => {
      const el = (ev.target as HTMLElement).closest('[data-offer]');
      if (el) {
        this.onBuy?.(el.getAttribute('data-offer') ?? '');
        return;
      }
      // 标题行整行可点：折叠/展开
      if ((ev.target as HTMLElement).closest('[data-shop-toggle]')) this.toggle();
    });
  }

  // ── 服务器状态 ────────────────────────────────────────────────

  /** 收到一条 `FfaShop`。★ 这是余额与货架的**唯一**入口 */
  update(balance: number, offers: readonly FfaOffer[]): void {
    this.available = true;
    this.balance = balance;
    this.offers = offers;
    this.render();
  }

  // ── 开关 ──────────────────────────────────────────────────────

  get open(): boolean {
    return this.available && this.expanded;
  }

  toggle(): void {
    if (!this.available) return;
    this.expanded = !this.expanded;
    this.render();
  }

  close(): void {
    if (!this.expanded) return;
    this.expanded = false;
    this.render();
  }

  /**
   * 数字键买第 `slot`（从 0 起）件。
   *
   * ★ 返回**有没有吃掉这一下按键**：调用方据此决定要不要把这次数字键
   *   继续当技能用。返回 void 的话，展开商店时按 1 会**同时**买东西和放技能。
   * ★ 买不起也返回 true（吃掉按键）：那一下的意图明确是「买」，
   *   服务器会回一条 Rejected 说清理由 —— 悄悄改成放技能才是意外。
   */
  buySlot(slot: number): boolean {
    if (!this.open) return false;
    const offer = this.offers[slot];
    if (!offer) return false;
    this.onBuy?.(offer.offerId);
    return true;
  }

  // ── 绘制 ──────────────────────────────────────────────────────

  private render(): void {
    if (!this.available) {
      this.panel.style.display = 'none';
      return;
    }
    this.panel.style.display = '';

    const head =
      `<div class="fs-head" data-shop-toggle>` +
      `<span class="fs-balance">积分 ${this.balance}</span>` +
      `<span class="fs-key">${this.expanded ? '按 N 收起' : '按 N 开商店'}</span>` +
      `</div>`;

    if (!this.expanded) {
      this.panel.innerHTML = head;
      return;
    }

    const rows = this.offers.map((o, i) => {
      const afford = this.balance >= o.cost;
      const key = i < SHOP_HOTKEY_SLOTS ? `${i + 1}` : '·';
      return (
        `<button class="fs-row${afford ? '' : ' fs-poor'}" data-offer="${esc(o.offerId)}">` +
        `<span class="fs-hotkey">${key}</span>` +
        `<span class="fs-name">${KIND_MARK[o.kind]} ${esc(o.name)}</span>` +
        `<span class="fs-cost">${o.cost}</span>` +
        `</button>`
      );
    }).join('');

    this.panel.innerHTML =
      head +
      `<div class="fs-list">${rows}</div>` +
      `<div class="fs-foot">击杀与连杀赚分；买到的装备随阵亡失效</div>`;
  }

  hide(): void {
    this.panel.style.display = 'none';
  }
}
