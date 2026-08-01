/**
 * 队伍框。规格书 15.1 左侧区。
 *
 * 15.1 原文：「左侧：最多 12 名队友的生命、职业、资源、控制、死亡和旗手状态。」
 *
 * ★ 六项**一项都不能少**，所以 `PartyMemberView` 把它们全列成必填字段 ——
 *   漏一项是编译错误，不是「上线后发现看不到谁被控了」。
 *   12 人上限也写在类型旁边：12v12 每边 12 人，正好塞满。
 *
 * ★ 17.2：控制状态不能只靠颜色。这里用 `vfx/status.ts` 的同一张字形表 ——
 *   队伍框里的沉默字形和 3D 场景里飘在头上的沉默字形是**同一个字符**，
 *   玩家不需要学两套符号。
 */

import { CONTROL_VISUALS, type ControlKind } from '../vfx/status.js';

/** 15.1 左侧要求的六项，全部必填 */
export interface PartyMemberView {
  id: number;
  name: string;
  className: string;
  health: number;
  maxHealth: number;
  /** 主资源当前值/上限。没有资源的职业传 undefined */
  resource?: { current: number; max: number; label: string };
  /** 当前生效的控制。空数组表示无控制 */
  controls: readonly ControlKind[];
  dead: boolean;
  carryingFlag: boolean;
}

/** 15.1：最多 12 名（12v12 每边正好 12 人）*/
export const MAX_PARTY_MEMBERS = 12;

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export class PartyFrame {
  private readonly el: HTMLElement;

  constructor(container: HTMLElement) {
    this.el = document.createElement('div');
    this.el.id = 'party-frame';
    container.appendChild(this.el);
  }

  /**
   * 渲染队伍框。超过 12 人时截断 —— 15.1 明确写了「最多 12 名」，
   * 静默画到第 13 个会把 HUD 顶出屏幕。
   */
  render(members: readonly PartyMemberView[]): void {
    const shown = members.slice(0, MAX_PARTY_MEMBERS);
    if (shown.length === 0) {
      this.el.style.display = 'none';
      return;
    }
    this.el.style.display = '';
    this.el.innerHTML = shown.map(renderMember).join('');
  }

  hide(): void {
    this.el.style.display = 'none';
  }
}

const renderMember = (m: PartyMemberView): string => {
  const hpPct = m.dead ? 0 : Math.max(0, (m.health / m.maxHealth) * 100);
  const res =
    m.resource === undefined
      ? ''
      : `<div class="pf-bar res"><i style="width:${(m.resource.current / Math.max(1, m.resource.max)) * 100}%"></i></div>`;

  // 17.2：控制用字形而不是只用颜色，且与 3D 场景共用同一张表
  const controls = m.controls
    .map((k) => {
      const v = CONTROL_VISUALS[k];
      return `<span class="pf-ctrl" title="${v.label}">${v.glyph}</span>`;
    })
    .join('');

  return `<div class="pf-member${m.dead ? ' dead' : ''}" data-id="${m.id}">
    <div class="pf-top">
      <span class="pf-name">${esc(m.name)}</span>
      <span class="pf-class">${esc(m.className)}</span>
      ${m.carryingFlag ? '<span class="pf-flag" title="旗手">⚑</span>' : ''}
      ${m.dead ? '<span class="pf-dead" title="已死亡">✖</span>' : ''}
    </div>
    <div class="pf-bar hp"><i style="width:${hpPct}%"></i></div>
    ${res}
    <div class="pf-ctrls">${controls}</div>
  </div>`;
};
