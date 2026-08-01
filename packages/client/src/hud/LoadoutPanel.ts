/**
 * 战场装备栏。规格书 15.3，验收 #35。
 *
 * 15.3 原文三条：
 *   ·「武器、护甲和道具分区显示；当前装备高亮，备用装备显示**主要优缺点**。」
 *   ·「换装时显示进度条；受到控制或伤害中断时**明确提示原因**。」
 *   ·「拾取界面直接**比较新旧装备**，不只显示复杂数值。」
 *
 * ★ 第三条是这三条里最容易做砸的：把 `WeaponDef` 的十几个字段列成一张表
 *   在技术上"显示了信息"，但玩家在 0.8 秒的换装窗口里读不完 ——
 *   那等于没显示。所以这里的做法是**只输出差异**，而且是带方向的差异
 *   （↑ 更高 / ↓ 更低），并且把「优势」和「代价」分成两行，
 *   因为 10.6 要求的是"优势与代价"这对概念，不是一堆数字。
 *
 * ★ 本文件只吃 `LoadoutView`（自己的视图）。它**没有**能力渲染敌人的备用装备 ——
 *   `EnemyLoadoutView` 类型里根本没有那个字段（M6 已在数据层钉死，验收 #36）。
 */

import { SwapKind, type ArmorDef, type LoadoutView, type WeaponDef } from '@wowpvp/shared';

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** 10.7 换装被中断的原因，要"明确提示"（15.3 第二条）*/
export const SWAP_INTERRUPT_TEXT: Record<string, string> = {
  damage: '受到伤害，换护甲被打断',
  control: '被控制，换装中断',
  movement: '移动了，换护甲需要原地',
  forcedMove: '被强制位移，换装中断',
  cancelled: '主动取消换装',
};

/**
 * 一件装备的「优势 / 代价」两行摘要。
 *
 * ★ 数据里 `WeaponDef` / `ArmorDef` 已经有 `advantage` 与 `cost` 两个必填字段
 *   （附录A#4 的六项标注之一），所以这里不需要自己编 —— 直接展示，
 *   保证 UI 说的和数据说的是同一件事。
 */
interface Summary {
  advantage: string;
  cost: string;
}

const weaponSummary = (w: WeaponDef): Summary => ({
  advantage: w.advantage,
  cost: w.cost,
});

const armorSummary = (a: ArmorDef): Summary => ({
  advantage: a.advantage,
  cost: a.cost,
});

/**
 * ★ 15.3 第三条：拾取时**直接比较新旧**，不只显示复杂数值。
 *
 * 只输出真正不同的项，并标出方向。三项以上截断 ——
 * 换装窗口只有 0.8 秒，列十项等于没列。
 */
export const compareWeapons = (
  current: WeaponDef | undefined,
  candidate: WeaponDef,
): string[] => {
  if (!current) return [`新武器：${candidate.name}`];
  const out: string[] = [];
  const cmp = (label: string, a: number, b: number, unit = '') => {
    if (Math.abs(a - b) < 1e-6) return;
    const up = b > a;
    out.push(`${up ? '↑' : '↓'} ${label} ${a}${unit} → ${b}${unit}`);
  };
  cmp('攻击距离', current.reach, candidate.reach, 'm');
  cmp('攻击间隔', current.swingInterval, candidate.swingInterval, 's');
  // swingPercent 是武器伤害百分比（1.6 = 160%），换成百分数更好读
  cmp('单次伤害', Math.round(current.swingPercent * 100), Math.round(candidate.swingPercent * 100), '%');
  if (current.handedness !== candidate.handedness) {
    out.push(`⇄ 类型 ${HANDEDNESS_TEXT[current.handedness]} → ${HANDEDNESS_TEXT[candidate.handedness]}`);
  }
  return out.slice(0, 4);
};

const HANDEDNESS_TEXT: Record<WeaponDef['handedness'], string> = {
  oneHand: '单手',
  twoHand: '双手',
  dualWield: '双持',
  ranged: '远程',
  staff: '法杖',
};

export const compareArmors = (
  current: ArmorDef | undefined,
  candidate: ArmorDef,
): string[] => {
  if (!current) return [`新护甲：${candidate.name}`];
  const out: string[] = [];
  if (current.archetype !== candidate.archetype) {
    out.push(`⇄ 原型 ${current.archetype} → ${candidate.archetype}`);
  }
  // 护甲没有单一「防御值」字段 —— 10.8 是横向方案，差异散在 modifiers 里。
  // 只列真正变了的那几项，比堆一张全字段表好读得多（15.3 第三条）
  const pct = (v: number | undefined): number | undefined =>
    v === undefined ? undefined : Math.round(v * 100);
  const cmpMod = (label: string, a?: number, b?: number, lowerIsBetter = false) => {
    const av = pct(a) ?? 100;
    const bv = pct(b) ?? 100;
    if (av === bv) return;
    const better = lowerIsBetter ? bv < av : bv > av;
    out.push(`${better ? '↑' : '↓'} ${label} ${av}% → ${bv}%`);
  };
  cmpMod('受到伤害', current.modifiers.damageTaken, candidate.modifiers.damageTaken, true);
  cmpMod('移动速度', current.modifiers.moveSpeed, candidate.modifiers.moveSpeed);
  cmpMod('控制时长', current.modifiers.ccDurationTaken, candidate.modifiers.ccDurationTaken, true);
  return out.slice(0, 4);
};

export class LoadoutPanel {
  private readonly el: HTMLElement;
  /** 最近一次中断原因，显示几秒后淡出 */
  private interruptText: string | null = null;
  private interruptUntil = 0;

  constructor(container: HTMLElement) {
    this.el = document.createElement('div');
    this.el.id = 'loadout-panel';
    this.el.style.display = 'none';
    container.appendChild(this.el);
  }

  /** 10.7 换装被中断时调用，15.3 要求"明确提示原因" */
  showInterrupt(reason: string, now: number): void {
    this.interruptText = SWAP_INTERRUPT_TEXT[reason] ?? `换装中断：${reason}`;
    this.interruptUntil = now + 3;
  }

  hide(): void {
    this.el.style.display = 'none';
  }

  /**
   * 渲染装备栏。
   *
   * @param pickupCandidate 站在地面装备旁时传入，用于 15.3 第三条的新旧比较
   */
  render(
    view: LoadoutView,
    now: number,
    pickupCandidate?: { weapon?: WeaponDef; armor?: ArmorDef },
  ): void {
    this.el.style.display = '';

    // 15.3 第二条：换装进度条
    const swap = view.swapProgress;
    const swapHtml = swap
      ? `<div class="lp-swap">
           <div class="lp-swap-label">${swap.kind === SwapKind.Weapon ? '切换武器' : '切换护甲'}
             ${swap.remaining.toFixed(1)}s</div>
           <div class="lp-bar"><i style="width:${Math.max(0, 100 - (swap.remaining / swapSeconds(swap.kind)) * 100)}%"></i></div>
           ${swap.kind === SwapKind.Armor ? '<div class="lp-warn">换护甲必须原地，受伤会中断</div>' : ''}
         </div>`
      : '';

    const interrupt =
      this.interruptText && now < this.interruptUntil
        ? `<div class="lp-interrupt">${esc(this.interruptText)}</div>`
        : '';

    // 15.3 第三条：拾取时的新旧对比
    const compare = pickupCandidate
      ? renderCompare(view, pickupCandidate)
      : '';

    // ★ 用 `allWeapons` / `allArmors` 而不是 `[current, ...spares]` ——
    //   换到备用武器后 spares 里仍含着它，拼起来会把当前武器列两遍，
    //   同时默认武器凭空消失（而 10.6 要求默认装备永远在列表里）。
    this.el.innerHTML = `
      <div class="lp-title">战场装备栏</div>
      ${renderSection('武器', view.allWeapons, view.currentWeapon?.id, (w) => weaponSummary(w))}
      ${renderSection('护甲', view.allArmors, view.currentArmor?.id, (a) => armorSummary(a))}
      ${swapHtml}
      ${interrupt}
      ${compare}
    `;
  }
}

const swapSeconds = (kind: SwapKind): number => (kind === SwapKind.Weapon ? 0.8 : 2);

/**
 * 15.3 第一条：分区显示、当前高亮、备用显示主要优缺点。
 */
const renderSection = <T extends { id: unknown; name: string }>(
  label: string,
  all: readonly (T | undefined)[],
  currentId: unknown,
  summarize: (t: T) => Summary,
): string => {
  const item = (t: T | undefined): string => {
    if (!t) return '<div class="lp-item empty">空槽</div>';
    const isCurrent = t.id === currentId;
    const s = summarize(t);
    return `<div class="lp-item${isCurrent ? ' current' : ''}">
      <div class="lp-item-name">${esc(t.name)}${isCurrent ? ' <span class="lp-tag">当前</span>' : ''}</div>
      <div class="lp-adv">优势　${esc(s.advantage)}</div>
      <div class="lp-cost">代价　${esc(s.cost)}</div>
    </div>`;
  };

  return `<div class="lp-section">
    <div class="lp-section-label">${label}</div>
    ${all.length === 0 ? '<div class="lp-item empty">空槽</div>' : all.map(item).join('')}
  </div>`;
};

const renderCompare = (
  view: LoadoutView,
  cand: { weapon?: WeaponDef; armor?: ArmorDef },
): string => {
  const lines: string[] = [];
  if (cand.weapon) lines.push(...compareWeapons(view.currentWeapon, cand.weapon));
  if (cand.armor) lines.push(...compareArmors(view.currentArmor, cand.armor));
  if (lines.length === 0) return '';
  return `<div class="lp-compare">
    <div class="lp-compare-label">与当前装备相比</div>
    ${lines.map((l) => `<div class="lp-diff">${esc(l)}</div>`).join('')}
  </div>`;
};
