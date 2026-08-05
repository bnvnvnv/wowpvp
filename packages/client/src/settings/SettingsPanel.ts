/**
 * 设置面板。规格书 17.1 / 17.2（技术债总账 W9）。
 *
 * ★★ 在此之前**没有任何设置界面**：音量四通道的 `setVolumes()` 从落地起
 *   零调用方（玩家只能 M 键全静音）、画质 F2 盲切且反馈只在 console、
 *   九项无障碍设置里六项（震动/顿帧/伤害数字/屏幕闪烁/武器粒子/姓名板
 *   密度）**没有任何触发路径** —— 只有默认值和手改 localStorage。
 *   数据层与持久化当时就全部就绪，本文件只是把它们接到玩家手上。
 *
 * ★ 本组件**不持有任何设置状态**：音量直接进 `audio`（它自己持久化），
 *   无障碍与画质经调用方注入的钩子进各场景的**唯一入口**
 *   （`setAccessibility()` / `QualityController.set()`）—— 面板自己存一份
 *   就会出现「面板显示的和生效的不一致」，护盾判据分叉的老病。
 *
 * ★ 键位表**只读**（展示 `getBindings()`，rebind 的 UI 是 W7 的账）——
 *   先让玩家看得到现在的键位，别再让技能栏的 <kbd> 独自撒谎。
 */

import { audio } from '../audio/AudioManager.js';
import type { AudioVolumes } from './audioSettings.js';
import {
  ColorblindMode,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  type AccessibilitySettings,
} from './accessibility.js';
import type { QualityTier } from '../render/quality.js';
import { Action, DEFAULT_BINDINGS } from '../input/InputManager.js';

export interface SettingsPanelHooks {
  /** 场景的无障碍唯一入口（应用 + 持久化）。大厅传「存盘 + 应用缩放」的自家实现 */
  getAccessibility: () => AccessibilitySettings;
  setAccessibility: (next: AccessibilitySettings) => void;
  /** 画质（只有场景有；大厅不传则不显示该组）*/
  getQuality?: () => QualityTier;
  setQuality?: (tier: QualityTier) => void;
  /** 键位表。不传用默认表（大厅没有 InputManager）*/
  bindings?: () => Readonly<Record<Action, string>>;
}

const COLORBLIND_TEXT: Record<ColorblindMode, string> = {
  off: '关闭',
  protanopia: '红色弱',
  deuteranopia: '绿色弱',
  tritanopia: '蓝黄色弱',
};

const TIER_TEXT: Record<QualityTier, string> = { low: '低', medium: '中', high: '高' };

const VOLUME_TEXT: Record<keyof AudioVolumes, string> = {
  master: '总音量', sfx: '音效', music: '音乐', ui: '界面',
};

/**
 * 键位表的条目与中文名。★ 手写的**精选**清单而不是遍历 Action 枚举 ——
 * 移动四键并成一行、内部动作（实战模式）不进玩家表；
 * 完整性由 settingsPanel.test.ts 反向钉住（表里的每一项都必须是真 Action）。
 */
export const ACTION_LABELS: readonly { action: Action; label: string }[] = [
  { action: Action.Jump, label: '跳跃' },
  { action: Action.TargetNext, label: '循环选择目标' },
  { action: Action.SetFocus, label: '设置焦点目标' },
  { action: Action.CancelCast, label: '取消施法（假读条）' },
  { action: Action.Trinket, label: '通用解控' },
  { action: Action.SelfCast, label: '自我施法（按住）' },
  { action: Action.FlagInteract, label: '交互（旗帜/拾取/开箱）' },
  { action: Action.CycleWeapon, label: '切换备用武器' },
  { action: Action.UseConsumable1, label: '使用道具 1' },
  { action: Action.UseConsumable2, label: '使用道具 2' },
  { action: Action.ToggleScoreboard, label: '记分板（按住）' },
  { action: Action.SpectateNext, label: '死亡观战/切换目标' },
  { action: Action.ToggleMute, label: '静音' },
  { action: Action.CycleQuality, label: '画质档位' },
  { action: Action.OpenSettings, label: '设置面板' },
];

/** 'KeyW'→'W'、'Digit1'→'1'、'AltLeft'→'Alt'：给玩家看的键名 */
export const prettyKey = (code: string): string =>
  code
    .replace(/^Key/, '')
    .replace(/^Digit/, '')
    .replace(/(Left|Right)$/, '')
    .replace(/^ShiftTab$/, 'Shift+Tab');

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export class SettingsPanel {
  private readonly el: HTMLElement;

  constructor(
    container: HTMLElement,
    private readonly hooks: SettingsPanelHooks,
  ) {
    this.el = document.createElement('div');
    this.el.id = 'settings-panel';
    Object.assign(this.el.style, {
      position: 'absolute', right: '12px', top: '48px', width: '292px',
      maxHeight: '78vh', overflowY: 'auto',
      background: 'rgba(14,16,22,.94)', border: '1px solid #3a4150',
      borderRadius: '10px', padding: '12px 14px',
      color: '#dfe6f0', font: '400 13px system-ui, sans-serif',
      display: 'none', zIndex: '50', pointerEvents: 'auto', lineHeight: '1.7',
    } as Partial<CSSStyleDeclaration>);
    container.appendChild(this.el);

    /**
     * ★ 键盘事件不出面板：InputManager 挂在 window（冒泡末端），
     *   这里 stopPropagation 之后，聚焦滑条按空格不会让角色起跳。
     * ★ 但「设置键」与 Esc 由面板**自己**响应关闭 —— 首跑抓到的坑：
     *   点过控件后焦点在面板里，第二次按 F10 被这层隔离拦住、
     *   永远到不了 window 上的 InputManager，面板就关不掉了。
     */
    for (const t of ['keydown', 'keyup'] as const) {
      this.el.addEventListener(t, (e) => {
        const ke = e as KeyboardEvent;
        if (t === 'keydown') {
          const settingsKey = (this.hooks.bindings?.() ?? DEFAULT_BINDINGS)[Action.OpenSettings];
          if (ke.code === 'Escape' || ke.code === settingsKey) {
            ke.preventDefault();
            this.close();
          }
        }
        e.stopPropagation();
      });
    }

    // 控件全走事件委托：面板每次打开整体重建，逐控件绑事件会漏
    this.el.addEventListener('input', (e) => this.onControl(e));
    this.el.addEventListener('change', (e) => this.onControl(e));
    this.el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).dataset['close'] !== undefined) this.close();
      e.stopPropagation();
    });
  }

  get visible(): boolean {
    return this.el.style.display !== 'none';
  }

  toggle(): void {
    if (this.visible) this.close();
    else this.open();
  }

  /** 打开时整体重建 —— 面板不持有状态，每次都从数据层现读 */
  open(): void {
    this.el.innerHTML = this.html();
    this.el.style.display = '';
  }

  close(): void {
    this.el.style.display = 'none';
  }

  // ── 渲染 ─────────────────────────────────────────────────────

  private html(): string {
    const a = this.hooks.getAccessibility();
    const vols = audio.volumeSettings;
    const row = (label: string, control: string): string =>
      `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
         <span style="opacity:.85">${label}</span>${control}</div>`;
    const slider = (attr: string, v: number, min: number, max: number, step: number): string =>
      `<input type="range" ${attr} min="${min}" max="${max}" step="${step}" value="${v}"
              style="width:130px">`;
    const toggle = (attr: string, on: boolean): string =>
      `<input type="checkbox" ${attr} ${on ? 'checked' : ''}>`;
    const head = (t: string): string =>
      `<div style="margin:10px 0 4px;font-weight:600;color:#9fb4d8;border-bottom:1px solid #2a3140">${t}</div>`;

    const volumeRows = (Object.keys(VOLUME_TEXT) as (keyof AudioVolumes)[])
      .map((k) => row(VOLUME_TEXT[k], slider(`data-vol="${k}"`, vols[k], 0, 1, 0.05)))
      .join('');

    const quality = this.hooks.getQuality && this.hooks.setQuality
      ? head('画质（F2）') + row('档位', `<select data-quality>
          ${(['low', 'medium', 'high'] as QualityTier[])
            .map((t) => `<option value="${t}" ${this.hooks.getQuality!() === t ? 'selected' : ''}>${TIER_TEXT[t]}</option>`)
            .join('')}</select>`)
      : '';

    const bindings = (this.hooks.bindings?.() ?? DEFAULT_BINDINGS);
    const keyRows = ACTION_LABELS
      .map(({ action, label }) =>
        `<div style="display:flex;justify-content:space-between">
           <span style="opacity:.8">${esc(label)}</span>
           <kbd style="background:#232a38;border-radius:4px;padding:0 6px">${esc(prettyKey(bindings[action]))}</kbd>
         </div>`)
      .join('');

    return `
      <div style="display:flex;justify-content:space-between;align-items:center">
        <b style="font-size:15px">设置</b>
        <button data-close style="background:none;border:none;color:#9fb4d8;cursor:pointer;font-size:16px">✕</button>
      </div>
      ${head('音量')}
      ${volumeRows}
      ${row('静音（M）', toggle('data-mute', audio.isMuted))}
      ${quality}
      ${head('无障碍（17.2）')}
      ${row('色盲滤镜（F3）', `<select data-acc-select="colorblind">
        ${Object.values(ColorblindMode)
          .map((m) => `<option value="${m}" ${a.colorblind === m ? 'selected' : ''}>${COLORBLIND_TEXT[m]}</option>`)
          .join('')}</select>`)}
      ${row('界面缩放（F4）', slider('data-acc="uiScale"', a.uiScale, UI_SCALE_MIN, UI_SCALE_MAX, 0.05))}
      ${row('镜头震动强度', slider('data-acc="cameraShake"', a.cameraShake, 0, 1, 0.05))}
      ${row('姓名板密度', slider('data-acc="namePlateDensity"', a.namePlateDensity, 0, 1, 0.05))}
      ${row('特效密度', `<select data-acc-select="effectQuality">
        ${(['low', 'medium', 'high'] as QualityTier[])
          .map((t) => `<option value="${t}" ${a.effectQuality === t ? 'selected' : ''}>${TIER_TEXT[t]}</option>`)
          .join('')}</select>`)}
      ${row('伤害数字', toggle('data-acc-toggle="damageNumbers"', a.damageNumbers))}
      ${row('屏幕闪烁', toggle('data-acc-toggle="screenFlash"', a.screenFlash))}
      ${row('武器粒子', toggle('data-acc-toggle="weaponParticles"', a.weaponParticles))}
      ${row('打击顿帧', toggle('data-acc-toggle="hitStop"', a.hitStop))}
      ${head('键位（只读）')}
      ${keyRows}
    `;
  }

  // ── 控件路由 ─────────────────────────────────────────────────

  private onControl(e: Event): void {
    e.stopPropagation();
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    const d = t.dataset;

    if (d['vol'] !== undefined) {
      audio.setVolumes({ [d['vol']]: Number(t.value) });
      return;
    }
    if (d['mute'] !== undefined) {
      // toggleMute 是唯一入口（M 键同款）—— 状态可能与面板期望不同步，先对齐
      if (audio.isMuted !== (t as HTMLInputElement).checked) audio.toggleMute();
      return;
    }
    if (d['quality'] !== undefined) {
      this.hooks.setQuality?.(t.value as QualityTier);
      return;
    }

    const a = this.hooks.getAccessibility();
    if (d['acc'] !== undefined) {
      this.hooks.setAccessibility({ ...a, [d['acc']]: Number(t.value) });
    } else if (d['accSelect'] !== undefined) {
      this.hooks.setAccessibility({ ...a, [d['accSelect']]: t.value });
    } else if (d['accToggle'] !== undefined) {
      this.hooks.setAccessibility({ ...a, [d['accToggle']]: (t as HTMLInputElement).checked });
    }
  }
}
