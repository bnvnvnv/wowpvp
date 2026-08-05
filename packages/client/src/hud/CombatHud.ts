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
  School,
  distance2D,
  getClass,
  type CastState,
} from '@wowpvp/shared';
import { FAIL_TEXT, SCHOOL_TEXT } from '../combat/CombatDirector.js';
import type { CombatView, HudSkillSlot, HudUnit } from './CombatView.js';
import { skillIconHtml } from './skillIcon.js';
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

/** 14.2 八属性视觉语言的颜色。HUD 与特效共用同一张表 */
export const SCHOOL_COLOR: Record<School, string> = {
  physical: '#d8cbb4',
  holy: '#ffe9a8',
  fire: '#ff8a4c',
  frost: '#8fd4ff',
  arcane: '#c39bff',
  shadow: '#a172c9',
  nature: '#8fe08a',
  // 上面七项已覆盖 School 全部成员
} as Record<School, string>;

/** HUD 完整重建的间隔。20Hz 与服务器 tick 同频，视觉上察觉不到 */
const HUD_UPDATE_INTERVAL_MS = 50;

/** 受击闪烁的持续时间，秒 */
const FLASH_DURATION = 0.26;

export class CombatHud {
  private readonly root: HTMLElement;
  private readonly targetFrame: HTMLElement;
  private readonly focusFrame: HTMLElement;
  private readonly playerCastBar: HTMLElement;
  private readonly skillBar: HTMLElement;
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
      <div id="combat-log"></div>
    `;
    container.appendChild(this.root);

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
      return;
    }
    el.style.display = '';
    const hpPct = Math.max(0, (unit.health / unit.maxHealth) * 100);
    const dist = dir.distanceTo(unit);
    const cast = dir.castOf(unit);
    const cls = getClass(unit.classId);
    const weapon = cls?.weapons.find((w) => w.id === unit.weaponId);

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
      <div class="uf-label">${label}</div>
      <div class="uf-name">
        ${esc(unit.name)}
        <span class="uf-class">${esc(cls?.name ?? '')}</span>
        ${unit.flags.carryingFlag ? '<span class="flag">🚩旗手</span>' : ''}
      </div>
      <div class="bar hp"><i style="width:${hpPct}%"></i><span>${unit.health} / ${unit.maxHealth}</span></div>
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
    const skill = dir.skills.find((s) => s.id === cast.skillId)
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
    this.skillBar.innerHTML = slots
      .map((s, i) => {
        const usable = s.blocker === CastFailure.Ok && s.cooldownRemaining <= 0;
        const reason =
          s.cooldownRemaining > 0
            ? `${s.cooldownRemaining.toFixed(1)}s`
            : s.blocker === CastFailure.Ok
              ? ''
              : FAIL_TEXT[s.blocker];
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
        return `
          <div class="slot ${usable ? 'usable' : 'blocked'}" style="--school:${color}">
            <kbd>${i + 1}</kbd>
            <div class="sk-head">${skillIconHtml(s.skill, 26)}${sweep}<div class="sk-name">${esc(s.skill.name)}</div></div>
            <div class="sk-meta">
              ${s.skill.cast.kind === CastKind.Instant ? '瞬发' : `${s.skill.cast.time}s`}
              · ${s.skill.range.max === 0 ? '自身' : `${s.skill.range.max}m`}
              ${s.skill.triggersGcd ? '' : ' · <span title="脱离公共冷却">脱GCD</span>'}
            </div>
            ${reason ? `<div class="sk-block">${reason}</div>` : ''}
          </div>`;
      })
      .join('');
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

    // 17.2 姓名板密度需要「按距离排第几」——远处的姓名板才是造成拥挤的那些
    const entities = dir.visibleUnits();
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

      const hpPct = Math.max(0, (e.health / e.maxHealth) * 100);
      const cast = dir.castOf(e);
      el.innerHTML = `
        <div class="np-name">${esc(e.name)}</div>
        <div class="np-hp"><i style="width:${hpPct}%"></i></div>
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

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

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
