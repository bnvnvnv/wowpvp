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

import {
  getClass,
  type ClassId,
  type CombatEntity,
  type EntitySnapshot,
  type Resource,
} from '@wowpvp/shared';

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

/** 各职业资源的中文名。目标框与队伍框共用（原在 CombatHud，随 W1 挪来源头） */
export const RESOURCE_TEXT: Partial<Record<Resource, string>> = {
  rage: '怒气',
  mana: '法力',
  holyPower: '圣能',
  runes: '符文',
  runicPower: '符文能量',
  energy: '能量',
  comboPoints: '连击点',
  focus: '集中值',
};

/**
 * 从状态标志派生控制字形列表。7.3 把恐惧也置 stunned，但 14.3 要求两者
 * 视觉不同：**恐惧优先** —— 这条优先级是目标框与队伍框共同的语义，
 * 只在这里实现一次（W1 顺带把两处副本收拢）。
 */
export const controlKindsOf = (flags: {
  readonly feared: boolean;
  readonly stunned: boolean;
  readonly rooted: boolean;
  readonly silenced: boolean;
  readonly disarmed: boolean;
}): ControlKind[] => {
  const kinds: ControlKind[] = [];
  if (flags.feared) kinds.push('feared');
  else if (flags.stunned) kinds.push('stunned');
  if (flags.rooted) kinds.push('rooted');
  if (flags.silenced) kinds.push('silenced');
  if (flags.disarmed) kinds.push('disarmed');
  return kinds;
};

/** 两侧共用的队友来源最小集 —— `CombatEntity` 与 `EntitySnapshot` 都天然满足 */
interface PartyMemberSource {
  id: number;
  name: string;
  classId: ClassId;
  health: number;
  maxHealth: number;
  alive: boolean;
  flags: {
    readonly feared: boolean;
    readonly stunned: boolean;
    readonly rooted: boolean;
    readonly silenced: boolean;
    readonly disarmed: boolean;
    readonly carryingFlag: boolean;
  };
}

/**
 * 15.1 六项的**唯一**投影实现（技术债总账 W1）。试验场（CombatEntity）与
 * 联网（EntitySnapshot）都经它产出 `PartyMemberView` —— 资源容器不同
 * （Map / Record），由调用方给读法；其余语义只有这一份。
 * 照快照另写一遍就会重演「护盾判据分叉」那类 bug（G4 的重复清单里已经
 * 躺着一条「控制标记逻辑写了两遍」）。
 */
const partyMemberView = (
  e: PartyMemberSource,
  resourceOf: (r: string) => number | undefined,
  maxResourceOf: (r: string) => number | undefined,
): PartyMemberView => {
  const cls = getClass(e.classId);
  const primary = cls?.resources[0]?.resource;
  return {
    id: e.id,
    name: e.name,
    className: cls?.name ?? '',
    health: e.health,
    maxHealth: e.maxHealth,
    ...(primary === undefined
      ? {}
      : {
          resource: {
            current: resourceOf(primary as string) ?? 0,
            max: maxResourceOf(primary as string) ?? 1,
            label: RESOURCE_TEXT[primary] ?? String(primary),
          },
        }),
    controls: controlKindsOf(e.flags),
    dead: !e.alive,
    carryingFlag: e.flags.carryingFlag,
  };
};

/** 试验场入口：从本地 sim 实体投影（15.1 六项在 `PartyMemberView` 里全必填） */
export const partyViewOf = (members: readonly CombatEntity[]): PartyMemberView[] =>
  members.map((e) =>
    partyMemberView(e, (r) => e.resources.get(r as never), (r) => e.maxResources.get(r as never)));

/** 联网入口：同一份投影，只换资源容器的读法（快照是 Record 不是 Map）*/
export const partyViewFromSnapshot = (members: readonly EntitySnapshot[]): PartyMemberView[] =>
  members.map((e) => partyMemberView(e, (r) => e.resources[r], (r) => e.maxResources[r]));

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
