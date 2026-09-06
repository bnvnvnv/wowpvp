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
 * ★ W7：键位表**可重绑**了 —— 点一行进入捕获态、按下新键即改（`rebind` 钩子
 *   落到 InputManager + 持久化）。冲突按 `rebindWithSwap` 规则处理。
 *   不传 `rebind` 钩子（大厅没有 InputManager）时退回**只读**展示。
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
import type { SkillDef } from '@wowpvp/shared';
import { Action, DEFAULT_BINDINGS } from '../input/InputManager.js';
import type { RebindOutcome } from './keybindings.js';
import { skillIconHtml } from '../hud/skillIcon.js';
import { FRAME_RATES, type GraphicsPreferences } from '../render/graphics.js';

export interface SettingsPanelHooks {
  /** 场景的无障碍唯一入口（应用 + 持久化）。大厅传「存盘 + 应用缩放」的自家实现 */
  getAccessibility: () => AccessibilitySettings;
  setAccessibility: (next: AccessibilitySettings) => void;
  /** 画质（只有场景有；大厅不传则不显示该组）*/
  getQuality?: () => QualityTier;
  setQuality?: (tier: QualityTier) => void;
  getGraphics?: () => GraphicsPreferences;
  setGraphics?: (next: GraphicsPreferences) => void;
  /** 键位表。不传用默认表（大厅没有 InputManager）*/
  bindings?: () => Readonly<Record<Action, string>>;
  /**
   * W7：把某动作重绑到某键。**给了它，键位表就可点击重绑**；不给则只读。
   * 回结构化结果，提示文案由面板用自己的 `ACTION_LABELS` 拼（标签在这边）。
   */
  rebind?: (action: Action, code: string) => RebindOutcome;
  /** W7：恢复默认键位 */
  resetBindings?: () => void;
  /**
   * P3c 技能栏自定义。不传则不显示该区块（未选职业的大厅）。
   * 交互与键位重绑同语法：点一格进入「挑选态」，再点技能池里的技能完成
   * 指派；交换语义在数据层（`assignSlot`），面板不持技能栏状态。
   */
  skillBar?: {
    /** 当前 9 格 */
    current: () => readonly SkillDef[];
    /** 本职业全部技能池 */
    pool: () => readonly SkillDef[];
    /** 把 skillId 指派到 slot 格（含交换）。调用方负责持久化与生效 */
    assign: (slot: number, skillId: string) => void;
    /** 恢复默认技能栏 */
    reset: () => void;
  };
  /**
   * X10 追加轮（用户：「进入教学或房间后怎么回去/退出」）：面板底部的
   * 离场按钮。语义由调用方定 —— 联网场景是「离开对局（按弃权淘汰结算，
   * 11.5）」，练习场是「返回主菜单」。不传则不显示（验收载体的默认路径
   * 不带它，DOM 逐字节不变）。
   */
  leaveMatch?: { label: string; hint?: string; run: () => void };
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
 *
 * ★ W7：这张表同时是「哪些动作可重绑」的唯一来源（`rebindableActions`）——
 *   不在表里的动作（移动四键、系统内部动作）不给改，也不被交换意外顶走。
 */
export const ACTION_LABELS: readonly { action: Action; label: string }[] = [
  // ★ 技能九格：17.2「全键位」明确要它们可重绑（左手党、非 QWERTY）。
  //   技能栏 <kbd> 读实时绑定 —— 换了这里，图标上的键号跟着变（W7 的可见证据）。
  { action: Action.Skill1, label: '技能 1' },
  { action: Action.Skill2, label: '技能 2' },
  { action: Action.Skill3, label: '技能 3' },
  { action: Action.Skill4, label: '技能 4' },
  { action: Action.Skill5, label: '技能 5' },
  { action: Action.Skill6, label: '技能 6' },
  { action: Action.Skill7, label: '技能 7' },
  { action: Action.Skill8, label: '技能 8' },
  { action: Action.Skill9, label: '技能 9' },
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

/**
 * W7：可重绑动作集（= `ACTION_LABELS` 里的动作）。移动四键与系统内部动作
 * **不在**这里 —— `rebindWithSwap` 用它区分「可交换」与「拒绝改」。
 */
const REBINDABLE = new Set<Action>(ACTION_LABELS.map((x) => x.action));
export const rebindableActions = (): ReadonlySet<Action> => REBINDABLE;

/** 动作的中文标签（交换提示用）。不在精选表里的回落到 id */
const labelFor = (action: Action): string =>
  ACTION_LABELS.find((x) => x.action === action)?.label ?? action;

export class SettingsPanel {
  private readonly el: HTMLElement;
  /** W7：正在捕获新键的动作（点了某行键位后）。null = 不在捕获态 */
  private capturing: Action | null = null;
  /** W7：捕获态或冲突的一句话提示，渲染在键位表顶部 */
  private keyHint = '';
  /** P3c：正在挑选技能的格子（点了技能栏某格后）。null = 不在挑选态 */
  private pickingSlot: number | null = null;

  constructor(
    container: HTMLElement,
    private readonly hooks: SettingsPanelHooks,
  ) {
    this.el = document.createElement('div');
    this.el.id = 'settings-panel';
    // W7：可聚焦 —— 捕获新键要靠面板自己收到 keydown（点一个普通 div 不会
    //   移动焦点，tabindex=-1 让点击落进面板、后续按键才到得了这里的监听器）
    this.el.tabIndex = -1;
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
          /**
           * ★ W7 捕获态优先：正在等一个新键时，除 Esc（取消）外**任何键**
           *   都是要绑的那个键 —— 包括 F10 本身（有人就想把设置键换掉）。
           *   所以捕获分支必须排在「Esc / 设置键关闭面板」之前。
           */
          if (this.capturing !== null) {
            ke.preventDefault();
            if (ke.code === 'Escape') this.cancelCapture();
            else this.applyCapture(ke.code);
            e.stopPropagation();
            return;
          }
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
      const el = (e.target as HTMLElement).closest<HTMLElement>(
        '[data-close],[data-rebind],[data-reset-keys],[data-bar-slot],[data-pool-skill],[data-reset-bar],[data-leave-match]');
      if (el?.dataset['close'] !== undefined) this.close();
      else if (el?.dataset['leaveMatch'] !== undefined && this.hooks.leaveMatch) {
        this.hooks.leaveMatch.run();
      }
      else if (el?.dataset['rebind'] !== undefined && this.hooks.rebind) {
        // 点一行键位 → 进入捕获态，等下一个按键。focus() 让后续 keydown 落到本面板
        this.capturing = el.dataset['rebind'] as Action;
        this.keyHint = '按下要绑定的键（Esc 取消）';
        this.rerender();
        this.el.focus();
      } else if (el?.dataset['resetKeys'] !== undefined && this.hooks.resetBindings) {
        this.hooks.resetBindings();
        this.cancelCapture();
        this.keyHint = '已恢复默认键位';
        this.rerender();
      } else if (el?.dataset['barSlot'] !== undefined && this.hooks.skillBar) {
        // P3c：点技能栏某格 → 挑选态（再点一次同格 = 取消）
        const slot = Number(el.dataset['barSlot']);
        this.pickingSlot = this.pickingSlot === slot ? null : slot;
        this.rerender();
      } else if (el?.dataset['poolSkill'] !== undefined && this.hooks.skillBar) {
        // P3c：挑选态下点技能池 → 指派（交换语义在数据层）
        if (this.pickingSlot !== null) {
          this.hooks.skillBar.assign(this.pickingSlot, el.dataset['poolSkill']!);
          this.pickingSlot = null;
          this.rerender();
        }
      } else if (el?.dataset['resetBar'] !== undefined && this.hooks.skillBar) {
        this.hooks.skillBar.reset();
        this.pickingSlot = null;
        this.rerender();
      }
      e.stopPropagation();
    });
  }

  /** W7：捕获到新键 —— 交给调用方（走 rebindWithSwap），拼一句提示 */
  private applyCapture(code: string): void {
    const action = this.capturing;
    this.capturing = null;
    if (action === null || !this.hooks.rebind) return;
    const r = this.hooks.rebind(action, code);
    this.keyHint = !r.ok
      // conflict 一定是不可重绑的动作（移动/系统键）—— 不逐一点名，让玩家换个键即可
      ? '该键已被移动或系统按键占用，请换一个键'
      : r.swappedWith !== undefined
        ? `已与「${labelFor(r.swappedWith)}」互换按键`
        : '';
    this.rerender();
  }

  private cancelCapture(): void {
    this.capturing = null;
    this.keyHint = '';
    this.rerender();
  }

  /** 捕获/冲突提示变化时只重画，不改开合状态 */
  private rerender(): void {
    if (this.visible) this.el.innerHTML = this.html();
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
    // 上次关面板时若停在捕获态/挑选态，重开要清干净
    this.capturing = null;
    this.keyHint = '';
    this.pickingSlot = null;
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
    const graphics = this.hooks.getGraphics?.();
    const graphicsRows = graphics
      ? row('帧率上限', `<select data-frame-rate aria-label="帧率上限">${FRAME_RATES.map((rate) =>
        `<option value="${rate}" ${graphics.frameRate === rate ? 'selected' : ''}>${rate} FPS</option>`).join('')}</select>`)
        + row('动态分辨率', toggle('data-adaptive-resolution aria-label="动态分辨率"', graphics.adaptiveResolution))
      : '';

    const bindings = (this.hooks.bindings?.() ?? DEFAULT_BINDINGS);
    // W7：给了 rebind 钩子才可点；否则退回只读展示（大厅路径）
    const editable = this.hooks.rebind !== undefined;
    const keyRows = ACTION_LABELS
      .map(({ action, label }) => {
        const capturing = this.capturing === action;
        const kbd = `<kbd style="background:${capturing ? '#3a2a12' : '#232a38'};border-radius:4px;padding:0 6px">${capturing ? '按键…' : esc(prettyKey(bindings[action]))}</kbd>`;
        const rowStyle = `display:flex;justify-content:space-between${editable ? ';cursor:pointer' : ''}`;
        return `<div style="${rowStyle}"${editable ? ` data-rebind="${action}"` : ''}>
           <span style="opacity:.8">${esc(label)}</span>${kbd}
         </div>`;
      })
      .join('');
    const keyHead = editable ? '键位（点一行改键）' : '键位（只读）';
    const keyHintHtml = this.keyHint
      ? `<div style="opacity:.7;font-size:12px;margin:2px 0">${esc(this.keyHint)}</div>`
      : '';
    const resetBtn = editable && this.hooks.resetBindings
      ? `<button data-reset-keys style="margin-top:6px;background:#232a38;border:1px solid #3a4150;color:#cdd6e4;border-radius:6px;padding:3px 8px;cursor:pointer;font-size:12px">恢复默认键位</button>`
      : '';

    /**
     * P3c 技能栏自定义。上排 = 当前 9 格（点选进入挑选态），
     * 下面 = 本职业全部技能池（挑选态下点击完成指派）。
     * ★ 已在栏上的池内技能加高亮点 —— 玩家一眼看出哪些还没用。
     */
    let skillBarSection = '';
    // 空栏/空池不渲染 —— 联网场景在第一份快照到达前不知道自己的职业
    if (this.hooks.skillBar &&
        this.hooks.skillBar.current().length > 0 &&
        this.hooks.skillBar.pool().length > 0) {
      const bar = this.hooks.skillBar.current();
      const pool = this.hooks.skillBar.pool();
      const onBar = new Set(bar.map((s) => s.id as string));
      const cell = (s: SkillDef, attr: string, extra: string): string =>
        `<div ${attr} title="${esc(s.name)}" style="cursor:pointer;border-radius:6px;padding:2px;
             display:flex;flex-direction:column;align-items:center;width:44px;${extra}">
           ${skillIconHtml(s, 24)}
           <span style="font-size:10px;opacity:.75;max-width:44px;overflow:hidden;white-space:nowrap">${esc(s.name)}</span>
         </div>`;
      const slotCells = bar
        .map((s, i) => cell(s, `data-bar-slot="${i}"`,
          this.pickingSlot === i
            ? 'outline:2px solid #d8b45a;background:#3a2a12'
            : 'background:#232a38'))
        .join('');
      const poolCells = pool
        .map((s) => cell(s, `data-pool-skill="${esc(s.id as string)}"`,
          onBar.has(s.id as string) ? 'opacity:.45' : 'background:#1b2230'))
        .join('');
      const hint = this.pickingSlot !== null
        ? `<div style="opacity:.7;font-size:12px;margin:2px 0">点下方技能放入第 ${this.pickingSlot + 1} 格（再点该格取消）</div>`
        : `<div style="opacity:.55;font-size:12px;margin:2px 0">点一格再点池中技能即可替换；数字键 1–9 的位置就是这里的顺序</div>`;
      skillBarSection = `
        ${head('技能栏（键 1–9）')}
        ${hint}
        <div style="display:flex;flex-wrap:wrap;gap:4px">${slotCells}</div>
        <div style="margin:6px 0 2px;opacity:.7;font-size:12px">技能池（本职业全部）</div>
        <div style="display:flex;flex-wrap:wrap;gap:4px">${poolCells}</div>
        <button data-reset-bar style="margin-top:6px;background:#232a38;border:1px solid #3a4150;color:#cdd6e4;border-radius:6px;padding:3px 8px;cursor:pointer;font-size:12px">恢复默认技能栏</button>`;
    }

    return `
      <div style="display:flex;justify-content:space-between;align-items:center">
        <b style="font-size:15px">设置</b>
        <button data-close style="background:none;border:none;color:#9fb4d8;cursor:pointer;font-size:16px">✕</button>
      </div>
      ${head('音量')}
      ${volumeRows}
      ${row('静音（M）', toggle('data-mute', audio.isMuted))}
      ${quality}
      ${graphicsRows}
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
      ${row('其他玩家的战斗数字', toggle('data-acc-toggle="otherCombatNumbers"', a.otherCombatNumbers))}
      ${row('屏幕闪烁', toggle('data-acc-toggle="screenFlash"', a.screenFlash))}
      ${row('武器粒子', toggle('data-acc-toggle="weaponParticles"', a.weaponParticles))}
      ${row('打击顿帧', toggle('data-acc-toggle="hitStop"', a.hitStop))}
      ${head('控制')}
      ${graphics ? row('鼠标灵敏度', slider('data-mouse-sensitivity aria-label="鼠标灵敏度"', graphics.mouseSensitivity, 0.25, 2.5, 0.05)) : ''}
      ${row('指针锁定', toggle('data-acc-toggle="pointerLock"', a.pointerLock))}
      <div style="opacity:.55;font-size:12px;margin:0 0 2px">开启后右键转身不再被屏幕边缘卡住（光标交给游戏，Esc 可随时取回）</div>
      ${skillBarSection}
      ${head(keyHead)}
      ${keyHintHtml}
      ${keyRows}
      ${resetBtn}
      ${this.hooks.leaveMatch ? `
        ${head('离开')}
        ${this.hooks.leaveMatch.hint ? `<div style="opacity:.6;font-size:12px;margin:2px 0">${esc(this.hooks.leaveMatch.hint)}</div>` : ''}
        <button data-leave-match style="margin-top:4px;background:#3a1c1c;border:1px solid #6a3a3a;color:#f0c9c9;border-radius:6px;padding:5px 10px;cursor:pointer;font-size:13px;width:100%">${esc(this.hooks.leaveMatch.label)}</button>` : ''}
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
    const graphics = this.hooks.getGraphics?.();
    if (graphics && d['mouseSensitivity'] !== undefined) {
      this.hooks.setGraphics?.({ ...graphics, mouseSensitivity: Number(t.value) });
      return;
    }
    if (graphics && d['frameRate'] !== undefined) {
      this.hooks.setGraphics?.({ ...graphics, frameRate: Number(t.value) });
      return;
    }
    if (graphics && d['adaptiveResolution'] !== undefined) {
      this.hooks.setGraphics?.({ ...graphics, adaptiveResolution: (t as HTMLInputElement).checked });
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
