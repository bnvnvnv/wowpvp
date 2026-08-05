/**
 * 模式专属 HUD。规格书 15.4。
 *
 * 15.4 是一张两列表格，左列竞技场、右列夺旗战场。其中有一条**否定式**规则：
 *
 *   | 竞技场 | 夺旗战场 |
 *   | **不显示任何旗帜信息** | 小地图永久显示双方旗手和掉落旗帜 |
 *
 * ★ 「竞技场不显示任何旗帜信息」靠自觉是保不住的 —— 夺旗和竞技场共用一个
 *   HUD 组件时，某次「顺手把旗手标记也画上」就破了，而且只有在竞技场里
 *   正好有人身上带着 `carryingFlag` 标志时才会露出来。
 *
 *   这里的做法：两种模式的视图是**两个不相交的类型**，
 *   `ArenaHudView` 里根本没有旗帜字段。想在竞技场显示旗帜信息，
 *   你得先往这个类型上加字段 —— 那是一次显眼的改动。
 *   与 M6 的 `enemyLoadoutView()` 返回类型里没有备用装备字段同源。
 */

import { CTF, FlagState, type FlagView, type TeamId } from '@wowpvp/shared';

/**
 * 竞技场 HUD 数据。15.4 左列：
 * 「双方存活人数、当前回合、回合比分、战斗抑制、决胜阶段」
 *
 * ★ 这个类型**没有**任何旗帜相关字段，而且不许加。
 */
export interface ArenaHudView {
  aliveRed: number;
  aliveBlue: number;
  /** 当前回合序号，从 1 开始 */
  round: number;
  scoreRed: number;
  scoreBlue: number;
  /** 8.5 战斗抑制，0 = 未开始，0.9 = 上限 */
  dampening: number;
  /** 是否已进入决胜阶段 */
  suddenDeath: boolean;
  /** 10.4 武装模式的补给刷新倒计时（秒）。经典模式为 undefined */
  supplyRespawnIn?: number;
}

/**
 * 夺旗 HUD 数据。15.4 右列：
 * 「夺旗比分、比赛时间、双方旗帜状态、旗手姓名、旗手聚焦层数」
 */
export interface CtfHudView {
  scoreRed: number;
  scoreBlue: number;
  scoreToWin: number;
  /**
   * 剩余比赛时间，秒。
   * ★ W12 起可选：联网夺旗的 sim **没有**时限规则（`CTF.DURATION` 零消费，
   *   总账挂账），不传就不画 —— 不显示一个数到零也不会发生任何事的倒计时。
   *   试验场传的是它自己的本地口径（720 秒演示钟）。
   */
  timeRemaining?: number;
  flags: readonly FlagView[];
  /** 12.4 战场聚焦层数 */
  focusStacks: number;
  /** 12.6 距下一波复活的秒数 */
  respawnIn?: number;
  /**
   * 最近一次旗帜交互的提示（含**失败原因**）。
   * ★ 12.1 的交互有六七种拒绝理由（距离太远、己方旗帜不在基地、复活保护中…），
   *   不显示原因的话玩家按 G 没反应时完全不知道为什么 —— 15.2 对技能图标
   *   要求"明确提示不可用原因"，旗帜交互同理。
   */
  message?: string | null;
}

const FLAG_STATE_TEXT: Record<FlagState, string> = {
  atBase: '在基地',
  beingTaken: '被拔取中',
  carried: '被携带',
  dropped: '已掉落',
  beingReturned: '归还中',
  beingCaptured: '交付中',
  resetting: '重置中',
};

/** 17.2：状态不能只靠颜色，每种旗帜状态配一个字形 */
const FLAG_STATE_GLYPH: Record<FlagState, string> = {
  atBase: '⌂',
  beingTaken: '↑',
  carried: '⇉',
  dropped: '↓',
  beingReturned: '↺',
  beingCaptured: '★',
  resetting: '⋯',
};

const mmss = (s: number): string => {
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export class ModeHud {
  private readonly el: HTMLElement;

  constructor(container: HTMLElement) {
    this.el = document.createElement('div');
    this.el.id = 'mode-hud';
    this.el.style.display = 'none';
    container.appendChild(this.el);
  }

  hide(): void {
    this.el.style.display = 'none';
  }

  /**
   * 渲染竞技场 HUD。
   *
   * ★ 注意这个方法只接受 `ArenaHudView` —— 它拿不到任何旗帜数据，
   *   所以「竞技场不显示任何旗帜信息」不是靠这里记得别画，而是**没得画**。
   */
  renderArena(v: ArenaHudView): void {
    this.el.style.display = '';
    this.el.dataset.mode = 'arena';
    const damp = Math.round(v.dampening * 100);
    this.el.innerHTML = `
      <div class="mh-row mh-score">
        <span class="team red">${v.aliveRed}</span>
        <span class="mh-vs">存活</span>
        <span class="team blue">${v.aliveBlue}</span>
      </div>
      <div class="mh-row">第 ${v.round} 回合　比分 ${v.scoreRed} : ${v.scoreBlue}</div>
      <div class="mh-row ${v.suddenDeath ? 'urgent' : ''}">
        战斗抑制 ${damp}%${v.suddenDeath ? '　⚡ 决胜阶段' : ''}
      </div>
      ${v.supplyRespawnIn === undefined ? '' : `<div class="mh-row">补给刷新 ${mmss(v.supplyRespawnIn)}</div>`}
    `;
  }

  /** 渲染夺旗 HUD（15.4 右列） */
  renderCtf(v: CtfHudView): void {
    this.el.style.display = '';
    this.el.dataset.mode = 'ctf';
    const flagRows = v.flags
      .map((f) => {
        const side = (f.team as number) === 0 ? 'red' : 'blue';
        const carrier = f.carrierName ? `　旗手 ${esc(f.carrierName)}` : '';
        return `<div class="mh-flag ${side}">
          <span class="mh-glyph">${FLAG_STATE_GLYPH[f.state]}</span>
          ${side === 'red' ? '红旗' : '蓝旗'} ${FLAG_STATE_TEXT[f.state]}${carrier}
        </div>`;
      })
      .join('');

    // 12.4：聚焦层数要显示出来，否则玩家不知道自己为什么越来越脆
    const focus =
      v.focusStacks > 0
        ? `<div class="mh-row urgent">战场聚焦 ${v.focusStacks} 层
             （受到伤害 +${Math.round(v.focusStacks * CTF.FOCUS_DAMAGE_TAKEN_PER_STACK * 100)}%、
              受到治疗 −${Math.round(v.focusStacks * CTF.FOCUS_HEALING_TAKEN_PER_STACK * 100)}%）</div>`
        : '';

    this.el.innerHTML = `
      <div class="mh-row mh-score">
        <span class="team red">${v.scoreRed}</span>
        <span class="mh-vs">/ ${v.scoreToWin}</span>
        <span class="team blue">${v.scoreBlue}</span>
      </div>
      ${v.timeRemaining === undefined ? '' : `<div class="mh-row">剩余 ${mmss(v.timeRemaining)}</div>`}
      ${flagRows}
      ${focus}
      ${v.respawnIn === undefined ? '' : `<div class="mh-row">复活波次 ${Math.ceil(v.respawnIn)}s</div>`}
      ${v.message ? `<div class="mh-row mh-msg">${esc(v.message)}</div>` : ''}
    `;
  }
}

/** 15.4：小地图上要显示的东西。夺旗与竞技场用不同的集合 */
export interface MinimapBlip {
  x: number;
  z: number;
  kind: 'self' | 'ally' | 'enemy' | 'objective' | 'flagCarrier' | 'droppedFlag' | 'supply';
  team?: TeamId;
  label?: string;
}

/**
 * ★ 15.4：竞技场的小地图**不含**任何 flagCarrier / droppedFlag。
 *
 * 用类型收窄表达：这个函数的返回类型排除了两种旗帜相关的 blip，
 * 所以竞技场小地图不可能画出旗帜信息。
 */
export type ArenaBlip = MinimapBlip & { kind: 'self' | 'ally' | 'enemy' | 'supply' };

export const isFlagBlip = (b: MinimapBlip): boolean =>
  b.kind === 'flagCarrier' || b.kind === 'droppedFlag';
