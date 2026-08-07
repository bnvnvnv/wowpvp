/**
 * 战斗 HUD。规格书 15.1–15.4，验收 #4 / #6 / #35。
 *
 * M2 只做了「目标与施法条」（15.2）。M8 补齐 15.1 的四区、15.3 战场装备栏
 * 与 15.4 模式专属信息 —— 后三块各自一个文件，本类只负责组合与节流：
 *   左侧队友   → PartyFrame.ts
 *   右上小地图 → Minimap.ts
 *   模式专属   → ModeHud.ts   ★ 竞技场与夺旗是两个不相交的视图类型
 *   装备栏     → LoadoutPanel.ts
 *
 * 15.2 的四条硬要求，缺一条就是验收不过：
 *   - 目标框显示职业、生命、资源、旗手状态
 *   - 敌方施法条显示**技能名称、剩余时间、学派、可打断状态**
 *   - 可打断用正常边框；**不可打断带盾牌标记**；物理射击准备用独立颜色
 *   - 技能图标必须明确提示：超出距离、缺少视线、朝向错误、职业装备不匹配
 */

import * as THREE from 'three';
import {
  CastFailure,
  CastKind,
  RANGE,
  distance2D,
  getClass,
  getSkill,
  type CastState,
} from '@wowpvp/shared';
import { SCHOOL_TEXT } from '../combat/CombatDirector.js';
import type { CombatView, HudSkillSlot, HudUnit } from './CombatView.js';
import { skillIconHtml } from './skillIcon.js';
import { SCHOOL_COLOR } from './schoolColor.js';
import {
  BLOCKER_GLYPH,
  blockerCategory,
  blockerText,
  escHtml as esc,
  pickBlocker,
  skillAriaLabel,
  skillTooltipHtml,
} from './skillTooltip.js';
import { CONTROL_VISUALS } from '../vfx/status.js';
import { Minimap } from './Minimap.js';
import { ModeHud } from './ModeHud.js';
import { Scoreboard } from './Scoreboard.js';
import { PartyFrame, RESOURCE_TEXT, controlKindsOf } from './PartyFrame.js';
import { LoadoutPanel } from './LoadoutPanel.js';
import { FloatingNumbers } from './FloatingNumbers.js';
import {
  DEFAULT_ACCESSIBILITY,
  clampUiScale,
  paletteFor,
  showNamePlate,
  type AccessibilitySettings,
} from '../settings/accessibility.js';

/**
 * 14.2 八属性视觉语言的颜色。
 * ★ 实体已挪到 `schoolColor.ts`（tooltip 也要用，留在这里会形成循环 import），
 *   这里再导出一次，老的 `from './CombatHud.js'` 导入路径不受影响。
 */
export { SCHOOL_COLOR } from './schoolColor.js';

/** HUD 完整重建的间隔。20Hz 与服务器 tick 同频，视觉上察觉不到 */
const HUD_UPDATE_INTERVAL_MS = 50;

/** 受击闪烁的持续时间，秒 */
const FLASH_DURATION = 0.26;

/**
 * 屏幕中部提示的停留时长，毫秒（合同 C2）。
 *
 * ★ **占位值 1600ms**：没有出处。选它的理由是「够读完一句 10 字以内的
 *   中文提示（约 1.2s）再留一点余量」，同时短到不会盖住下一次事件 ——
 *   死亡/打断这类提示经常连着来两条。淡出另计 0.3s，见 index.html。
 */
const CENTER_NOTICE_MS = 1600;

export class CombatHud {
  private readonly root: HTMLElement;
  private readonly targetFrame: HTMLElement;
  private readonly focusFrame: HTMLElement;
  private readonly playerCastBar: HTMLElement;
  private readonly skillBar: HTMLElement;
  /**
   * W7：技能槽 i 的按键标签。默认显示槽号（1–9），场景重绑后设成
   * `prettyKey(bindings[Skill{i+1}])` —— 否则技能栏的 <kbd> 会在玩家把
   * 技能键换成别的之后**继续显示 1–9 撒谎**（总账 W7 点名的那一处）。
   */
  skillKeyLabel: (slotIndex: number) => string = (i) => String(i + 1);
  /**
   * 鼠标点击技能格 → 施放（用户反馈：技能栏点不动，只能按数字键）。
   * ★ 场景注入 —— HUD 不知道怎么施法，它只把「玩家点了第 i 格」报上去，
   *   与姓名板点击选目标同一手法（那条早就在了，技能栏一直缺）。
   */
  onSkillClick: ((slotIndex: number) => void) | undefined;
  /**
   * 合同 C2：地面指示器是否正处于「等待左键确认」状态。
   *
   * ★ HUD 自己**不知道**瞄准状态在谁手里（试验场在 CombatDirector、
   *   联网在 NetworkScene），所以只留一个探针由场景注入。
   * ⚠️ 没接线时恒为 undefined ⇒ 姓名板行为与从前逐字节一致。
   */
  aimActiveProbe: (() => boolean) | undefined;
  /** 合同 C2：瞄准期间点姓名板 = 就地确认落点，**不换目标** */
  onAimConfirm: (() => void) | undefined;
  private readonly logBox: HTMLElement;
  private readonly aimHint: HTMLElement;
  private readonly nameplateLayer: HTMLElement;
  private nameplates = new Map<number, HTMLElement>();
  private lastFullUpdate = 0;
  /**
   * M9 / 17.2：当前可访问性设置。
   *
   * ★ HUD 持有它而不是每次调用都传进来 —— 界面缩放和色板是**全局**属性，
   *   逐调用传参会让「某个面板忘了应用缩放」变成一个很容易犯的错。
   */
  private access: AccessibilitySettings = { ...DEFAULT_ACCESSIBILITY };
  /** M8：15.1 四区的其余三块 + 15.3 装备栏 */
  readonly party: PartyFrame;
  readonly minimap: Minimap;
  readonly modeHud: ModeHud;
  readonly loadout: LoadoutPanel;
  /** 速赢清单：O 键记分板（联网侧第一次能看比分）*/
  readonly scoreboard: Scoreboard;
  /** M12：浮动伤害/治疗数字（14.1）*/
  readonly floaters!: FloatingNumbers;
  private readonly screenFlash!: HTMLElement;
  /** 受击闪烁的剩余秒数 */
  private flashLeft = 0;
  /** 合同 C2：屏幕中部短提示 */
  private readonly centerNotice!: HTMLElement;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  /** 技能 tooltip 的浮层，以及它当前锚在第几格（-1 = 没显示）*/
  private readonly skillTip!: HTMLElement;
  private tipIndex = -1;
  /** ⚠️ 连下标一起记：换武器方案会让同一格换成另一个技能（附录A#4）*/
  private tipSkillId = '';
  /**
   * 最近一次鼠标位置（视口坐标，-1 = 还没动过鼠标）。
   *
   * ★★ tooltip 的锚点靠它 + `elementFromPoint` **现场命中测试**得出，
   *   而不是靠 `:hover` 或 mouseover/mouseout 记账。理由是技能栏每 50ms
   *   整块重建 innerHTML，这让另外两条路都不可靠（两次真机复验各抓到一条）：
   *     · `querySelector('.slot:hover')` 在刚换完 DOM 的那一帧**恒为 null**
   *       —— 浏览器要到下一次输入/帧更新才重算命中 ⇒ tooltip 永远不出现。
   *     · 鼠标底下那个格子被删掉之后再移开，`mouseout/mouseleave` 是从
   *       **已经脱离文档的节点**上发出来的，冒泡不到技能栏 ⇒ tooltip 收不回去。
   *   `elementFromPoint` 每次都问当前这一棵真实的 DOM，没有任何跨帧状态。
   */
  private pointerX = -1;
  private pointerY = -1;
  /** 最近一次渲染用的技能槽，tooltip 要按下标反查技能 */
  private lastSlots: readonly HudSkillSlot[] = [];

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.id = 'combat-hud';
    this.root.innerHTML = `
      <div id="screen-flash"></div>
      <div id="nameplates"></div>
      <div id="target-frame" class="unit-frame"></div>
      <div id="focus-frame" class="unit-frame"></div>
      <div id="aim-hint"></div>
      <div id="player-cast"></div>
      <div id="skill-bar"></div>
      <div id="skill-tip" hidden></div>
      <div id="center-notice"></div>
      <div id="combat-log"></div>
    `;
    container.appendChild(this.root);

    /**
     * HUD 区域内屏蔽浏览器右键菜单。
     * ⚠️ 画布上的那条早就在 `InputManager`（右键拖拽=转镜头）里，但它挂在
     *   canvas 上 —— 而技能栏、姓名板、装备栏都浮在 canvas **之上**，
     *   在它们上面右键会弹出系统菜单并同时吃掉一次转镜头。
     */
    this.root.addEventListener('contextmenu', (ev) => ev.preventDefault());

    this.nameplateLayer = this.root.querySelector('#nameplates')!;
    this.screenFlash = this.root.querySelector('#screen-flash')!;
    // M12：浮动数字挂在 HUD 根下 —— 于是它自动继承 17.2 的界面缩放
    // 与 `.no-damage-numbers` 开关，不需要在两处各写一遍
    this.floaters = new FloatingNumbers(this.root);
    this.applyAccessibility(this.access);
    this.targetFrame = this.root.querySelector('#target-frame')!;
    this.focusFrame = this.root.querySelector('#focus-frame')!;
    this.playerCastBar = this.root.querySelector('#player-cast')!;
    this.skillBar = this.root.querySelector('#skill-bar')!;
    /**
     * 技能格点击 → 施放。**事件委托**挂在容器上：格子每 20Hz 全量重建
     * （`renderSkillBar` 重写 innerHTML），逐格绑事件会在每次重建后失效。
     * ★ `stopPropagation`：别让这一次点击穿透到画布，被当成瞄准确认。
     */
    this.skillBar.addEventListener('mousedown', (ev) => {
      /**
       * ⚠️ **只认左键。** 之前没判 button，实测中键/右键按在技能格上
       *   都会施法 —— 而右键在这个游戏里是「按住转镜头」，玩家把光标停在
       *   技能栏上转视角就会莫名其妙放出一个技能。
       */
      if (ev.button !== 0) return;
      const index = this.slotIndexOf(ev.target as HTMLElement);
      if (index >= 0) this.onSkillClick?.(index);
      ev.stopPropagation();
      /**
       * ★ `preventDefault` 本该顺带压住「点击把焦点抢到技能格上」。
       */
      ev.preventDefault();
      /**
       * ⚠️⚠️ **但实测它压不住**（真机复验抓到：点完一格后
       *   `document.activeElement` 就是那个 `.slot`）。焦点赖在格子上有
       *   两个后果，都很难联想到「因为点了一下技能」：
       *     · tooltip 收不回去 —— 鼠标早移开了，焦点还锚在那儿
       *     · **Space 不再跳跃** —— 被下面的键盘激活处理器吃掉了
       *   所以点完显式退焦：鼠标操作不该产生键盘焦点。用 `setTimeout(0)`
       *   而不是微任务 —— 聚焦是本次事件的**默认动作**，在整个派发结束后
       *   才发生，微任务可能跑在它前面，那就白退了。
       */
      setTimeout(() => {
        const a = document.activeElement as HTMLElement | null;
        if (a && this.skillBar.contains(a)) a.blur();
      }, 0);
    });
    /**
     * 键盘激活。格子对外声明了 `role="button"`，那就必须真的能按 ——
     * ★ Enter 与 Space 都收（ARIA 对 button 的要求），并且 `stopPropagation`
     *   把这次按键**吃掉**：window 上的 InputManager 也监听 Space（跳跃），
     *   不吃掉就会「放一个技能顺便跳一下」。
     */
    this.skillBar.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ' && ev.code !== 'Space') return;
      const index = this.slotIndexOf(ev.target as HTMLElement);
      if (index < 0) return;
      this.onSkillClick?.(index);
      ev.stopPropagation();
      ev.preventDefault();
    });
    /**
     * 鼠标位置只**记坐标**，命中测试留到 20Hz 的 `syncSkillTip` 里做 ——
     * 拖镜头时 mousemove 能到 100Hz+，每一次都做一遍 `elementFromPoint`
     * （会强制样式与布局刷新）是白花钱。20Hz ⇒ 最多 50ms 延迟，感觉不出来。
     * ★ 挂在**容器**上而不是 window：HUD 随容器一起消失，不留全局监听。
     */
    container.addEventListener('mousemove', (ev) => {
      this.pointerX = ev.clientX;
      this.pointerY = ev.clientY;
    }, { passive: true });
    this.skillTip = this.root.querySelector('#skill-tip')!;
    this.centerNotice = this.root.querySelector('#center-notice')!;
    this.logBox = this.root.querySelector('#combat-log')!;
    this.aimHint = this.root.querySelector('#aim-hint')!;

    // M8：15.1 左侧 / 右上，15.3 装备栏，15.4 模式专属
    this.party = new PartyFrame(this.root);
    this.minimap = new Minimap(this.root);
    this.modeHud = new ModeHud(this.root);
    this.loadout = new LoadoutPanel(this.root);
    this.scoreboard = new Scoreboard(this.root);
  }

  /**
   * 17.2：应用一份可访问性设置。
   *
   * ★ 界面缩放与色板都走 **CSS 自定义属性**，而不是逐个元素改 style。
   *   理由：15.1 的四区 + 装备栏一共五块面板，逐个应用一定会漏 ——
   *   而漏掉的那块在缩放到 2.0 时会明显对不齐，却只有放大了玩的人才发现。
   *   挂在根节点上，新加的面板自动继承。
   *
   * ★ 这里只写**颜色与尺寸**。虚线、叉号、字形那些非颜色通道不受任何设置影响
   *   （17.2 第二句），`AccessibilitySettings` 上根本没有它们的开关。
   */
  applyAccessibility(s: AccessibilitySettings): void {
    this.access = s;
    // M12：关掉伤害数字时连 DOM 都不建（见 FloatingNumbers 文件头）
    this.floaters.setEnabled(s.damageNumbers);
    const p = paletteFor(s.colorblind);
    const style = this.root.style;

    style.setProperty('--ui-scale', String(clampUiScale(s.uiScale)));
    style.setProperty('--c-hostile', p.hostile);
    style.setProperty('--c-friendly', p.friendly);
    style.setProperty('--c-neutral', p.neutral);
    style.setProperty('--c-danger', p.danger);
    style.setProperty('--c-own-flag', p.ownFlag);
    style.setProperty('--c-enemy-flag', p.enemyFlag);

    // 17.2 第三句的四项各自独立生效，用 class 而不是合成一个「特效强度」
    this.root.classList.toggle('no-damage-numbers', !s.damageNumbers);
    this.root.classList.toggle('no-screen-flash', !s.screenFlash);
  }

  /** 当前设置。供设置面板与验收脚本读取 */
  get accessibility(): AccessibilitySettings {
    return this.access;
  }

  /**
   * M12：技能被按下时的一次脉冲。
   *
   * ★ **本地即时播放，不等任何确认** —— 联网下服务器要 100ms 才回执，
   *   而「按了有没有反应」必须在按下的那一帧回答。这只是输入回执，
   *   技能到底放没放出来仍由施法条与日志（15.2）负责。
   */
  pulseSlot(index: number): void {
    const el = this.skillBar.children[index] as HTMLElement | undefined;
    if (!el) return;
    el.classList.remove('pressed');
    void el.offsetWidth; // 强制重排，让同一格连按两次也能重放动画
    el.classList.add('pressed');
  }

  /** 事件目标 → 技能格下标。命中不了返回 -1 */
  private slotIndexOf(target: HTMLElement | null): number {
    const slot = target?.closest<HTMLElement>('.slot');
    if (!slot?.parentElement || slot.parentElement !== this.skillBar) return -1;
    return [...this.skillBar.children].indexOf(slot);
  }

  /**
   * 合同 C2：屏幕中部一条短提示，约 1.6 秒后淡出。
   *
   * ★★ 为什么不复用战斗日志：日志在**左下角**，而玩家的视线在准星上。
   *   「你被打断了」「超出距离」这种要求立刻改变操作的信息，放在
   *   眼睛不看的地方等于没说 —— 真机审计里「失败了但不知道为什么」
   *   的根因就是它们只走了日志那一条通道。
   * ⚠️ 这里**只管显示**，什么值得提示由调用方（合同 C3 的四个回调）决定 ——
   *   HUD 一旦自己判断「这条重要」就会开始和战斗逻辑抢真相。
   */
  showCenterNotice(text: string): void {
    const el = this.centerNotice;
    el.textContent = text;
    el.classList.remove('show');
    void el.offsetWidth; // 强制重排：同一条提示连发两次也要重放淡入
    el.classList.add('show');
    if (this.noticeTimer !== undefined) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => el.classList.remove('show'), CENTER_NOTICE_MS);
  }

  /**
   * 14.1：自己受击时屏幕边缘一闪。
   *
   * ★ 17.2 的 `screenFlash` 开关这里**不判断** —— CSS 的
   *   `.no-screen-flash #screen-flash { display: none }` 已经关死了。
   *   在两处都判会出现「改了一处忘了另一处」，而 17.2 要的是
   *   四项各自独立、可靠地生效。
   */
  flashScreen(): void {
    this.flashLeft = FLASH_DURATION;
  }

  // 15.1 队友投影已随 W1 收进 PartyFrame.ts（partyViewOf / partyViewFromSnapshot）——
  // 投影与视图同文件，两个场景共用同一份实现。

  /**
   * 5.5：瞄准状态的文字提示。
   *
   * 地面指示器已经用「虚线 + 叉号 + 变暗」表达了非法（17.2：不只靠颜色），
   * 这里再补一条文字 —— 三重冗余是有意的：颜色、形状、文字，任一条通道
   * 受限的玩家都能拿到同样的信息。
   */
  setAimHint(text: string | null, illegal: boolean): void {
    if (!text) {
      this.aimHint.style.display = 'none';
      this.aimHint.textContent = '';
      this.aimHint.dataset.illegal = 'false';
      return;
    }
    this.aimHint.style.display = '';
    this.aimHint.textContent = text;
    this.aimHint.classList.toggle('illegal', illegal);
    this.aimHint.dataset.illegal = String(illegal);
  }

  /**
   * 更新 HUD。
   *
   * ⚠️ **节流到 ~20Hz**。目标框、技能栏、日志、姓名板都是重建 innerHTML，
   * 每帧做一次会让浏览器反复解析 HTML —— 实测把帧率从 25 拖到 12。
   * 姓名板的**位置**仍然每帧更新（不重建 DOM），否则会跟不上镜头。
   */
  update(dir: CombatView, camera: THREE.Camera, canvas: HTMLCanvasElement, dt = 0): void {
    const now = performance.now();
    const full = now - this.lastFullUpdate >= HUD_UPDATE_INTERVAL_MS;
    if (full) this.lastFullUpdate = now;

    // ★ M12：浮动数字与屏幕闪烁**每帧**推进，不受 20Hz 节流影响 ——
    //   它们是 14.1 的命中反馈，节流会让数字一跳一跳地往上蹦
    this.floaters.update(dt, camera, canvas);
    if (this.flashLeft > 0) {
      this.flashLeft = Math.max(0, this.flashLeft - dt);
      this.screenFlash.style.opacity = String((this.flashLeft / FLASH_DURATION) * 0.9);
    }

    // 姓名板位置每帧跟随镜头，内容按节流刷新
    this.renderNameplates(dir, camera, canvas, full);
    if (!full) return;

    this.renderUnitFrame(this.targetFrame, dir.target, dir, '目标');
    this.renderUnitFrame(this.focusFrame, dir.focus, dir, '焦点');
    this.renderPlayerCast(dir);
    this.renderSkillBar(dir.skillSlots());
    this.renderLog(dir);
  }

  // ── 15.2 目标框 ─────────────────────────────────────────────

  private renderUnitFrame(
    el: HTMLElement,
    unit: HudUnit | undefined,
    dir: CombatView,
    label: string,
  ): void {
    if (!unit) {
      el.style.display = 'none';
      // ⚠️ 只藏不清会留下**幽灵数据**：任何读 innerText 判断状态的代码
      //   （验收脚本、以后的自动化）会读到上一个目标的血量。
      //   `renderPlayerCast` 早就这么做了，两处对齐。
      el.innerHTML = '';
      return;
    }
    el.style.display = '';
    const hpPct = Math.max(0, (unit.health / unit.maxHealth) * 100);
    const dist = dir.distanceTo(unit);
    const cast = dir.castOf(unit);
    const cls = getClass(unit.classId);
    const weapon = cls?.weapons.find((w) => w.id === unit.weaponId);

    /**
     * ★★ 敌我区分（规格 777，与姓名板同一条）。
     *
     *   在此之前目标框**不分敌我**：选队友和选敌人长得一模一样，血条恒绿。
     *   而 15.2 的目标框是治疗与集火共用的同一个控件 —— 分不清就会
     *   「对着队友读了两秒火球」。
     * ★ 复用姓名板那套 `paletteFor(colorblind)` 语义色 + ▲/◆ 字形，
     *   两个控件同色同形，玩家只需要学一次（17.2 不能只靠颜色）。
     */
    const friendly = unit.team === dir.player.team;
    el.classList.toggle('uf-friendly', friendly);
    el.classList.toggle('uf-hostile', !friendly);
    const teamColor = friendly
      ? paletteFor(this.access.colorblind).friendly
      : paletteFor(this.access.colorblind).hostile;

    // 15.2：目标框显示职业、生命、资源、当前武器、旗手状态
    const primary = cls?.resources[0]?.resource;
    const resourceHtml =
      primary === undefined
        ? ''
        : (() => {
            const cur = unit.resources.get(primary) ?? 0;
            const max = unit.maxResources.get(primary) ?? 1;
            return `<div class="bar mana ${primary}"><i style="width:${(cur / max) * 100}%"></i>
                      <span>${RESOURCE_TEXT[primary] ?? primary} ${Math.round(cur)} / ${max}</span></div>`;
          })();

    el.innerHTML = `
      <div class="uf-label">${label} · <span class="uf-team">${friendly ? '友方' : '敌方'}</span></div>
      <div class="uf-name" style="color:${teamColor}">
        ${esc(unit.name)}
        <span class="uf-class">${esc(cls?.name ?? '')}</span>
        ${unit.flags.carryingFlag ? '<span class="flag">🚩旗手</span>' : ''}
      </div>
      <div class="bar hp"><i style="width:${hpPct}%;background:${teamColor}"></i><span>${unit.health} / ${unit.maxHealth}</span></div>
      ${resourceHtml}
      <div class="uf-meta">
        <span>${dist.toFixed(1)} m</span>
        <span class="weapon" title="10.6：敌人可见当前武器，但看不到备用装备">${esc(weapon?.name ?? '')}</span>
        ${controlBadges(unit)}
      </div>
      ${cast ? this.castBarHtml(cast, dir) : ''}
    `;
  }

  /**
   * 15.2 施法条：技能名称、剩余时间、学派、可打断状态。
   * ★ 不可打断带**盾牌标记**（7.5：避免玩家浪费打断后误以为系统失效）
   * ★ 物理射击准备用**独立颜色**，因为它的反制方式与法术不同（缴械有效、沉默无效）
   */
  private castBarHtml(cast: CastState, dir: CombatView): string {
    /**
     * ★★ **敌方施法条必须查全局技能表。**
     *
     *   原来这里查的是 `dir.skills` —— 那是**玩家自己那 9 格**。
     *   于是牧师读闪现治疗时，法师玩家看到的是 `priest.flash_heal`
     *   这样一个内部 id（真机审计实测），而 7.5 的打断博弈全靠这一行：
     *   要不要把唯一的打断交出去，取决于对面读的是治疗还是伤害。
     *   显示内部 id 等于把这条博弈的信息通道关掉。
     * ★ 玩家栏留作兜底：将来若出现「不在全局表里的临时技能」，
     *   至少还有一次机会查到名字；两条都miss才退回 id。
     */
    const skill = getSkill(cast.skillId)
      ?? dir.skills.find((s) => s.id === cast.skillId)
      ?? { name: String(cast.skillId), school: cast.school };
    const total = Math.max(0.01, cast.endsAt - cast.startedAt);
    const remaining = Math.max(0, cast.endsAt - dir.now);
    const elapsed = total - remaining;
    const pct = Math.min(100, (elapsed / total) * 100);

    const isPhysicalShot = cast.kind === CastKind.AimedShot;
    const cls = isPhysicalShot ? 'shot' : cast.interruptible ? 'castable' : 'shielded';
    const color = SCHOOL_COLOR[cast.school] ?? '#cccccc';

    /**
     * ★★ 用**负 delay** 把 CSS 动画拨到当前进度（详见 index.html 的注释）。
     *   `width` 仍然写着 —— 动画没生效时（reduce-motion、旧浏览器）
     *   它就是回落值，进度信息不会消失。
     */
    const anim = `animation-duration:${total.toFixed(2)}s;animation-delay:-${elapsed.toFixed(2)}s`;

    return `
      <div class="bar cast ${cls}" style="--school:${color}">
        <i class="anim" style="width:${pct}%;${anim}"></i>
        <span>
          ${cast.interruptible ? '' : '<b class="shield" title="不可打断">🛡</b>'}
          ${esc(skill.name)}
          <em>${SCHOOL_TEXT[cast.school]}${isPhysicalShot ? '·射击准备' : ''}</em>
          ${remaining.toFixed(1)}s
        </span>
      </div>
    `;
  }

  private renderPlayerCast(dir: CombatView): void {
    const cast = dir.playerCast;
    if (!cast) {
      this.playerCastBar.style.display = 'none';
      // 一并清空内容：留着旧的 HTML 会让任何「读 innerText 判断是否在施法」的
      // 代码（包括验收脚本）得到错误结论
      this.playerCastBar.innerHTML = '';
      return;
    }
    this.playerCastBar.style.display = '';
    this.playerCastBar.innerHTML = this.castBarHtml(cast, dir);
  }

  // ── 15.2 技能栏 ─────────────────────────────────────────────

  private renderSkillBar(slots: readonly HudSkillSlot[]): void {
    this.lastSlots = slots;
    /**
     * ⚠️ 重建 innerHTML 会把焦点打飞：被删掉的元素上的焦点直接回到 body。
     *   格子对外声明了 `role="button"` + `tabindex`，如果每 50ms 自己毁一次
     *   焦点，这个声明就是假的。原本焦点就在某一格上时把它还回去 ——
     * ★ 只在焦点**本来就在技能栏里**时才还，绝不主动抢焦点。
     */
    const active = document.activeElement as HTMLElement | null;
    const refocus = active && this.skillBar.contains(active) ? this.slotIndexOf(active) : -1;
    this.skillBar.innerHTML = slots
      .map((s, i) => {
        /**
         * 合同 C1：`blockers[]` 有值时按「位置→视线→朝向→资源→冷却→状态」
         * 挑首个显示（`pickBlocker`）。⚠️ 生产方没填时退回单个 `blocker`，
         * 与改造前逐字节一致 —— 可选字段的意义就在这里。
         */
        const blocker = s.blockers && s.blockers.length > 0
          ? pickBlocker(s.blockers)
          : s.blocker;
        const usable = blocker === CastFailure.Ok && s.cooldownRemaining <= 0;
        // 冷却读数优先：自身冷却时「还剩几秒」比「冷却中」三个字有用
        const onOwnCd = s.cooldownRemaining > 0;
        const category = onOwnCd
          ? 'cooldown'
          : blocker === CastFailure.Ok ? undefined : blockerCategory(blocker);
        const reason = onOwnCd
          ? `${s.cooldownRemaining.toFixed(1)}s`
          : blocker === CastFailure.Ok
            ? ''
            // GCD 是**所有格子共享**的一条冷却，把秒数带上才知道该等还是该换招
            : blockerText(
                blocker,
                blocker === CastFailure.OnGlobalCooldown ? s.gcdRemaining : undefined,
              );
        const color = SCHOOL_COLOR[s.skill.school] ?? '#ccc';
        /**
         * M12 冷却扫层。★ 它是**第二**通道 —— 下面 `.sk-block` 里的
         *   秒数读数照常渲染。15.2 要求技能图标明确提示不可用原因，
         *   一个扇形不能替代「还有 3.2 秒」这句话。
         */
        const cdTotal = s.skill.cooldown > 0 ? s.skill.cooldown : 0;
        const sweep =
          s.cooldownRemaining > 0 && cdTotal > 0
            ? `<div class="sk-cd" style="--cd-deg:${((s.cooldownRemaining / cdTotal) * 360).toFixed(1)}deg"></div>`
            : '';
        /**
         * 合同 C1 的 GCD 扫层。
         *
         * ★★ GCD 期间 7 个格子只显示静态的「公共冷却」四个字，**没有任何
         *   动的东西** —— 玩家读不出「还有多久」，只知道现在按不了。
         *   这里复用同一个 conic-gradient，但**颜色更浅**：它和自身冷却
         *   必须一眼能分（一个 1.5 秒后全好，一个只有这格要等 30 秒）。
         * ⚠️ 数据没填（生产方未跟上）就什么都不画，保持老样子 ——
         *   宁可少一层，不能画一个停在 0 度的假扫层。
         */
        const gcdSweep =
          s.gcdRemaining !== undefined && s.gcdRemaining > 0
            && s.gcdTotal !== undefined && s.gcdTotal > 0
            ? `<div class="sk-gcd" style="--gcd-deg:${((s.gcdRemaining / s.gcdTotal) * 360).toFixed(1)}deg"></div>`
            : '';
        const glyph = category ? BLOCKER_GLYPH[category] : '';
        /**
         * 无障碍：格子对外是一个按钮。`role` + `tabindex` + `aria-label` 三件套，
         * 键盘激活见构造函数里的 keydown（Enter/Space 都真的能放技能）。
         * ⚠️ 游戏里 Tab 被 5.3 的切目标占用且 `InputManager` 会 preventDefault，
         *   所以实际到达这里的焦点来自辅助技术或程序调用，不是 Tab 键。
         */
        const aria = skillAriaLabel(s.skill, this.skillKeyLabel(i), reason);
        return `
          <div class="slot ${usable ? 'usable' : 'blocked'}" style="--school:${color}"
               role="button" tabindex="0" aria-label="${esc(aria)}">
            <kbd>${esc(this.skillKeyLabel(i))}</kbd>
            <div class="sk-head">${skillIconHtml(s.skill, 26)}${sweep}${gcdSweep}<div class="sk-name">${esc(s.skill.name)}</div></div>
            <div class="sk-meta">
              ${s.skill.cast.kind === CastKind.Instant ? '瞬发' : `${s.skill.cast.time}s`}
              · ${s.skill.range.max === 0 ? '自身' : `${s.skill.range.max}m`}
              ${s.skill.triggersGcd ? '' : ' · <span class="sk-nogcd">脱GCD</span>'}
            </div>
            ${reason ? `<div class="sk-block" data-blk="${category ?? ''}">${glyph} ${esc(reason)}</div>` : ''}
          </div>`;
      })
      .join('');
    if (refocus >= 0) {
      (this.skillBar.children[refocus] as HTMLElement | undefined)?.focus({ preventScroll: true });
    }
    this.syncSkillTip();
  }

  /**
   * 技能 tooltip 的显隐与定位。
   *
   * ⚠️⚠️ **锚点每次现场重算，不跨帧记账。** 技能栏每 50ms 整块重建，
   *   握着的元素句柄立刻就是野的、`:hover` 与 mouseout 也都不可靠
   *   （两条都在真机复验里翻过车，详见 `pointerX` 的注释）。
   *   这里只用两个**当下就能问清楚**的事实：鼠标在哪（命中测试）、
   *   焦点在哪（`document.activeElement`）。
   * ★ 鼠标优先于焦点：手上正在指的那一格才是玩家在问的那一格。
   */
  private syncSkillTip(): void {
    const children = [...this.skillBar.children];
    const under = this.pointerX >= 0
      ? this.slotIndexOf(document.elementFromPoint(this.pointerX, this.pointerY) as HTMLElement)
      : -1;
    const active = document.activeElement as HTMLElement | null;
    const focused = active && this.skillBar.contains(active) ? this.slotIndexOf(active) : -1;
    const index = under >= 0 ? under : focused;
    const anchor = index >= 0 ? (children[index] as HTMLElement | undefined) : undefined;
    const slot = index >= 0 ? this.lastSlots[index] : undefined;
    if (!anchor || !slot) {
      if (this.tipIndex !== -1) {
        this.tipIndex = -1;
        this.tipSkillId = '';
        this.skillTip.hidden = true;
      }
      return;
    }
    const skillId = String(slot.skill.id);
    // 同一格同一技能：内容与位置都不用重算（每 50ms 重排一次浮层会闪）
    if (index === this.tipIndex && skillId === this.tipSkillId) return;
    this.tipIndex = index;
    this.tipSkillId = skillId;
    this.skillTip.innerHTML = skillTooltipHtml(slot.skill);
    this.skillTip.hidden = false;

    /**
     * 定位：格子**上方**居中，视口内钳位。
     * ⚠️ `#combat-hud > *` 上有 `zoom: var(--ui-scale)`，而
     *   `getBoundingClientRect()` 返回的是**已缩放**的视口坐标 ——
     *   直接把它写回 `style.left` 会在 uiScale≠1 时偏移一倍缩放。
     *   所以先在视口坐标里算好，再除以缩放换回本地坐标。
     */
    const z = clampUiScale(this.access.uiScale) || 1;
    const a = anchor.getBoundingClientRect();
    const t = this.skillTip.getBoundingClientRect();
    const margin = 8;
    let x = a.left + a.width / 2 - t.width / 2;
    x = Math.max(margin, Math.min(x, window.innerWidth - t.width - margin));
    let y = a.top - t.height - margin;
    if (y < margin) y = a.bottom + margin; // 上面放不下就翻到下面
    this.skillTip.style.left = `${x / z}px`;
    this.skillTip.style.top = `${y / z}px`;
  }

  private renderLog(dir: CombatView): void {
    this.logBox.innerHTML = dir.log
      .slice(0, 14)
      .map((l) => `<div class="log ${l.kind}"><span>${l.time.toFixed(1)}</span>${esc(l.text)}</div>`)
      .join('');
  }

  // ── 姓名板 ──────────────────────────────────────────────────

  /**
   * 5.2：姓名板可点击选中。
   * ⚠️ 未被发现的潜行目标**不出现在这里** —— `visibleEntities()` 已经过滤，
   * 而真正的保证在服务器的快照裁剪（docs/08 §4.1），这里只是第二道。
   */
  private renderNameplates(
    dir: CombatView,
    camera: THREE.Camera,
    canvas: HTMLCanvasElement,
    /** 是否重建内容。false 时只更新屏幕位置 */
    full: boolean,
  ): void {
    const seen = new Set<number>();
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const v = new THREE.Vector3();

    /**
     * ★★ **超出最大选中距离的姓名板一律不画。**
     *
     *   真机审计实测：306 米外的敌人姓名板照样是**原尺寸**、照样能点，
     *   点了服务器不认（5.3/6.1：Tab 与点击都只到 45 米），于是玩家
     *   得到一个「选上了但打不到」的假目标。姓名板没有做任何透视缩小，
     *   所以远近在屏幕上根本看不出来。
     * ★ 口径与 `RANGE.MAX_SELECT` 对齐 —— 与合同 C6 的服务器侧校验
     *   是同一个常量，客户端不自己定一套。
     * ⚠️ 剔除放在**密度排序之前**：够不着的人不该占用 17.2 的密度名额。
     */
    const entities = dir.visibleUnits()
      .filter((e) => distance2D(e.position, dir.player.position) <= RANGE.MAX_SELECT);
    // 17.2 姓名板密度需要「按距离排第几」——远处的姓名板才是造成拥挤的那些
    const nameplateRank = new Map<number, number>();
    [...entities]
      .sort((a, b) =>
        distance2D(a.position, dir.player.position) - distance2D(b.position, dir.player.position))
      .forEach((e, i) => nameplateRank.set(e.id as number, i));

    for (const e of entities) {
      const key = e.id as number;
      seen.add(key);

      v.set(e.position.x, e.position.y + e.height + 0.35, e.position.z);
      v.project(camera);
      const behind = v.z > 1;
      const x = (v.x * 0.5 + 0.5) * w;
      const y = (-v.y * 0.5 + 0.5) * h;

      /**
       * 17.2 姓名板密度。★ 当前目标**永不**被密度裁掉 ——
       * 15.2 要求姓名板给出目标状态，一起藏掉就不是「降低密度」而是
       * 「失去目标信息」（判据在 settings/accessibility.ts 里，不在这里重写）。
       */
      if (!showNamePlate(
        {
          isCurrentTarget: dir.target?.id === e.id,
          distanceRank: nameplateRank.get(key) ?? 0,
          total: nameplateRank.size,
        },
        this.access,
      )) {
        const existing = this.nameplates.get(key);
        if (existing) existing.style.display = 'none';
        continue;
      }

      let el = this.nameplates.get(key);
      if (!el) {
        el = document.createElement('div');
        el.className = 'nameplate';
        el.addEventListener('mousedown', (ev) => {
          ev.stopPropagation();
          /**
           * 合同 C2：地面技能瞄准中点姓名板 = **就地确认落点**，不换目标。
           *
           * ★★ 这条来自真机审计里最难受的一次交互：举着暴风雪的指示器
           *   想砸在对面那堆人身上，一点下去 —— 姓名板把这次点击吃了，
           *   变成「换了个目标」，指示器还举着。玩家会以为技能坏了。
           * ⚠️ 探针没接线（undefined）时行为与从前完全一致。
           */
          if (this.aimActiveProbe?.()) {
            this.onAimConfirm?.();
            return;
          }
          dir.selectById(key);
        });
        this.nameplateLayer.appendChild(el);
        this.nameplates.set(key, el);
      }

      if (behind || x < -80 || x > w + 80 || y < -40 || y > h + 40) {
        el.style.display = 'none';
        continue;
      }
      el.style.display = '';
      el.style.transform = `translate(-50%,-100%) translate(${x}px,${y}px)`;
      el.classList.toggle('selected', dir.target?.id === e.id);
      el.classList.toggle('focused', dir.focus?.id === e.id);

      if (!full) continue;

      /**
       * ★★ 阵营区分（规格书 777：「阵营通过**姓名板**、脚下标记、轮廓和 UI
       *   区分，不把整个人物简单染红或染蓝」）。
       *
       *   在此之前姓名板**所有人一个样**（白字 + 红血条）—— 这条规格从未被
       *   实现，而 12v12 里分不清敌我等于没法玩（用户实测反馈）。
       * ★ 颜色走 `paletteFor()` 的语义色，与目标环/小地图**同一份色板** ——
       *   色盲模式切换时一起变，玩家不必学两套颜色（17.2）。
       * ★ 同时挂 class：**颜色之外还有一个通道**（17.2「不能只靠颜色区分」），
       *   友方名字带 `▲` 前缀由 CSS 的 ::before 给出。
       */
      const friendly = e.team === dir.player.team;
      el.classList.toggle('np-friendly', friendly);
      el.classList.toggle('np-hostile', !friendly);
      const p = paletteFor(this.access.colorblind);
      const teamColor = friendly ? p.friendly : p.hostile;

      const hpPct = Math.max(0, (e.health / e.maxHealth) * 100);
      const cast = dir.castOf(e);
      el.innerHTML = `
        <div class="np-name" style="color:${teamColor}">${esc(e.name)}</div>
        <div class="np-hp"><i style="width:${hpPct}%;background:${teamColor}"></i></div>
        ${cast ? `<div class="np-cast ${cast.interruptible ? '' : 'shielded'}"
             style="--school:${SCHOOL_COLOR[cast.school] ?? '#ccc'}">
             <i style="width:${castPct(cast, dir.now)}%"></i>
           </div>` : ''}
      `;
    }

    if (!full) return;
    // 清掉已经不存在的姓名板
    for (const [key, el] of this.nameplates) {
      if (!seen.has(key)) {
        el.remove();
        this.nameplates.delete(key);
      }
    }
  }
}

const castPct = (cast: CastState, now: number): number => {
  const total = Math.max(0.01, cast.endsAt - cast.startedAt);
  return Math.min(100, ((total - Math.max(0, cast.endsAt - now)) / total) * 100);
};

// ★ 转义实现已收拢到 skillTooltip.ts 的 `escHtml`（本文件按 `esc` 别名导入）——
//   HUD 里曾经有两份一模一样的转义表，两份迟早会分叉。

/**
 * 15.2：「当前目标框显示……主要控制递减」。
 *
 * ★ 原来这里只列了沉默/缴械/昏迷三项，**漏了定身和恐惧** ——
 *   而 14.3 恰恰要求这几种控制彼此可区分。漏项的后果是玩家在目标框里
 *   看不出对手被定住了，只能靠 3D 场景里的脚部锁链判断。
 *
 * ★ 复用 `CONTROL_VISUALS` 的字形表 —— 目标框、队伍框和 3D 场景
 *   用的是**同一个字符**，玩家不需要学三套符号（17.2）。
 */
const controlBadges = (unit: HudUnit): string =>
  // ★ 优先级（恐惧盖昏迷）的唯一实现在 PartyFrame.controlKindsOf —— W1 收拢
  controlKindsOf(unit.flags)
    .map((k) => {
      const v = CONTROL_VISUALS[k];
      return `<span class="dbf" data-control="${k}">${v.glyph} ${v.label}</span>`;
    })
    .join('');
