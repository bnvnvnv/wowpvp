/**
 * 战斗 HUD。规格书 15.1 / 15.2，验收 #4 / #6。
 *
 * M2 只做「目标与施法条」这一块（15.2）。完整 HUD（队伍框、小地图、
 * 装备栏、模式专属信息）是 M8。
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
  Resource,
  School,
  getClass,
  type CastState,
  type CombatEntity,
} from '@wowpvp/shared';
import { FAIL_TEXT, SCHOOL_TEXT, type CombatDirector, type SkillSlotView } from '../combat/CombatDirector.js';

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

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.id = 'combat-hud';
    this.root.innerHTML = `
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
    this.targetFrame = this.root.querySelector('#target-frame')!;
    this.focusFrame = this.root.querySelector('#focus-frame')!;
    this.playerCastBar = this.root.querySelector('#player-cast')!;
    this.skillBar = this.root.querySelector('#skill-bar')!;
    this.logBox = this.root.querySelector('#combat-log')!;
    this.aimHint = this.root.querySelector('#aim-hint')!;
  }

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
  update(dir: CombatDirector, camera: THREE.Camera, canvas: HTMLCanvasElement): void {
    const now = performance.now();
    const full = now - this.lastFullUpdate >= HUD_UPDATE_INTERVAL_MS;
    if (full) this.lastFullUpdate = now;

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
    unit: CombatEntity | undefined,
    dir: CombatDirector,
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
        ${unit.flags.silenced ? '<span class="dbf">沉默</span>' : ''}
        ${unit.flags.disarmed ? '<span class="dbf">缴械</span>' : ''}
        ${unit.flags.stunned ? '<span class="dbf">昏迷</span>' : ''}
      </div>
      ${cast ? this.castBarHtml(cast, dir) : ''}
    `;
  }

  /**
   * 15.2 施法条：技能名称、剩余时间、学派、可打断状态。
   * ★ 不可打断带**盾牌标记**（7.5：避免玩家浪费打断后误以为系统失效）
   * ★ 物理射击准备用**独立颜色**，因为它的反制方式与法术不同（缴械有效、沉默无效）
   */
  private castBarHtml(cast: CastState, dir: CombatDirector): string {
    const skill = dir.skills.find((s) => s.id === cast.skillId)
      ?? { name: String(cast.skillId), school: cast.school };
    const total = Math.max(0.01, cast.endsAt - cast.startedAt);
    const remaining = Math.max(0, cast.endsAt - dir.world.time);
    const pct = Math.min(100, ((total - remaining) / total) * 100);

    const isPhysicalShot = cast.kind === CastKind.AimedShot;
    const cls = isPhysicalShot ? 'shot' : cast.interruptible ? 'castable' : 'shielded';
    const color = SCHOOL_COLOR[cast.school] ?? '#cccccc';

    return `
      <div class="bar cast ${cls}" style="--school:${color}">
        <i style="width:${pct}%"></i>
        <span>
          ${cast.interruptible ? '' : '<b class="shield" title="不可打断">🛡</b>'}
          ${esc(skill.name)}
          <em>${SCHOOL_TEXT[cast.school]}${isPhysicalShot ? '·射击准备' : ''}</em>
          ${remaining.toFixed(1)}s
        </span>
      </div>
    `;
  }

  private renderPlayerCast(dir: CombatDirector): void {
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

  private renderSkillBar(slots: SkillSlotView[]): void {
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
        return `
          <div class="slot ${usable ? 'usable' : 'blocked'}" style="--school:${color}">
            <kbd>${i + 1}</kbd>
            <div class="sk-name">${esc(s.skill.name)}</div>
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

  private renderLog(dir: CombatDirector): void {
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
    dir: CombatDirector,
    camera: THREE.Camera,
    canvas: HTMLCanvasElement,
    /** 是否重建内容。false 时只更新屏幕位置 */
    full: boolean,
  ): void {
    const seen = new Set<number>();
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const v = new THREE.Vector3();

    for (const e of dir.visibleEntities()) {
      const key = e.id as number;
      seen.add(key);

      v.set(e.position.x, e.position.y + e.height + 0.35, e.position.z);
      v.project(camera);
      const behind = v.z > 1;
      const x = (v.x * 0.5 + 0.5) * w;
      const y = (-v.y * 0.5 + 0.5) * h;

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
             <i style="width:${castPct(cast, dir.world.time)}%"></i>
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

/** 9. 各职业资源的中文名 */
const RESOURCE_TEXT: Partial<Record<Resource, string>> = {
  rage: '怒气',
  mana: '法力',
  holyPower: '圣能',
  runes: '符文',
  runicPower: '符文能量',
  energy: '能量',
  comboPoints: '连击点',
  focus: '集中值',
};

const castPct = (cast: CastState, now: number): number => {
  const total = Math.max(0.01, cast.endsAt - cast.startedAt);
  return Math.min(100, ((total - Math.max(0, cast.endsAt - now)) / total) * 100);
};

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
