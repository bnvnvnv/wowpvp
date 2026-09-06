import type { BattleOffer, FfaOffer } from '@wowpvp/shared';
import { ChevronDown, ChevronUp, FlaskConical, HeartPulse, Shield, ShieldCheck, ShoppingBag, Sword } from 'lucide';
import { iconSvg } from './icons.js';

const esc = (s: string): string => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const ICONS = { weapon: Sword, armor: Shield, consumable: FlaskConical, heal: HeartPulse, insurance: ShieldCheck };
export const SHOP_HOTKEY_SLOTS = 9;

/** Both economies use server balances and the same purchase controls. */
export class FfaShopHud {
  private readonly panel: HTMLElement;
  private available = false;
  private expanded = false;
  private balance = 0;
  private earned = 0;
  private battle = false;
  private blockReason = '';
  private pending = '';
  private offers: readonly (FfaOffer | BattleOffer)[] = [];
  onBuy: ((offerId: string) => void) | undefined;

  constructor(container: HTMLElement) {
    this.panel = document.createElement('div');
    this.panel.id = 'ffa-shop';
    this.panel.style.display = 'none';
    container.appendChild(this.panel);
    this.panel.addEventListener('click', ev => {
      const target = ev.target as Element;
      const row = target.closest<HTMLButtonElement>('[data-offer]');
      if (row && !row.disabled) this.buy(row.dataset['offer'] ?? '');
      else if (target.closest('[data-shop-toggle]')) this.toggle();
    });
  }

  update(balance: number, offers: readonly (FfaOffer | BattleOffer)[], earned?: number): void {
    this.available = true;
    this.balance = balance;
    this.earned = earned ?? 0;
    this.battle = earned !== undefined;
    this.offers = offers;
    this.pending = '';
    this.render();
  }

  get isBattleground(): boolean { return this.battle; }
  get open(): boolean { return this.available && this.expanded; }

  setBlocked(reason: string): void {
    if (reason === this.blockReason) return;
    this.blockReason = reason;
    this.render();
  }

  acknowledge(): void { this.pending = ''; this.render(); }

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

  buySlot(slot: number): boolean {
    if (!this.open) return false;
    const offer = this.offers[slot];
    if (offer) this.buy(offer.offerId);
    return slot >= 0 && slot < SHOP_HOTKEY_SLOTS;
  }

  private buy(id: string): void {
    const offer = this.offers.find(item => item.offerId === id);
    if (!offer || this.pending || this.blockReason || offer.cost > this.balance) return;
    this.pending = id;
    this.render();
    this.onBuy?.(id);
  }

  private render(): void {
    if (!this.available) { this.panel.style.display = 'none'; return; }
    this.panel.style.display = '';
    const currency = this.battle ? '经验' : '积分';
    const head = `<button class="fs-head" data-shop-toggle aria-expanded="${this.expanded}" title="${this.expanded ? '收起商店' : '打开商店'}">
      ${iconSvg(ShoppingBag)}<span>军需商店</span><b class="fs-balance">${this.balance} ${currency}</b>
      ${iconSvg(this.expanded ? ChevronUp : ChevronDown, 16)}</button>`;
    if (!this.expanded) { this.panel.innerHTML = head; return; }
    const rows = this.offers.map(o => {
      const disabled = !!this.pending || !!this.blockReason || this.balance < o.cost;
      const description = 'description' in o ? o.description : '';
      return `<button class="fs-row" data-offer="${esc(o.offerId)}" ${disabled ? 'disabled' : ''}
        title="${esc(this.blockReason || (this.balance < o.cost ? currency + '不足' : o.name))}">
        ${iconSvg(ICONS[o.kind], 22)}<span class="fs-name">${esc(o.name)}${description ? '<small>' + esc(description) + '</small>' : ''}</span>
        <b class="fs-cost">${this.pending === o.offerId ? '处理中' : o.cost}</b></button>`;
    }).join('');
    this.panel.innerHTML = `${head}<div class="fs-list">${rows}</div><div class="fs-foot">
      ${this.battle ? '本局获得 ' + this.earned + ' 经验' : '积分兑换'}
      <span>${esc(this.blockReason || '可购买')}</span></div>`;
  }

  hide(): void { this.panel.style.display = 'none'; }
}
