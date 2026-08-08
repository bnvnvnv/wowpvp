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
 *
 * ★ P10 真机审计改了三件事（都在 renderMember / 样式里）：
 *   1) 资源条补上标签与数字 —— 此前敌人的目标框写着「怒气 5 / 100」，
 *      自己队友的资源条却是一根没头没尾的蓝条，两块 HUD 自相矛盾。
 *   2) 第二资源通道（连击点/圣能这类**离散点**）画成圆点，盗贼此前
 *      根本看不到自己有几个连击点。
 *   3) 卡片可点选（合同 C4）+ 12 人分列排版 —— 见下面 P10 布局预算。
 */

import {
  getClass,
  type ClassId,
  type CombatEntity,
  type HydratedEntitySnapshot as EntitySnapshot,
  type Resource,
} from '@wowpvp/shared';

import { CONTROL_VISUALS, type ControlKind } from '../vfx/status.js';

/** 一条资源通道。`key` 只用来上色（与目标框同一套配色），缺省不影响读数 */
export interface PartyResourceView {
  current: number;
  max: number;
  label: string;
  key?: Resource;
}

/** 15.1 左侧要求的六项，全部必填 */
export interface PartyMemberView {
  id: number;
  name: string;
  className: string;
  health: number;
  maxHealth: number;
  /** 主资源当前值/上限。没有资源的职业传 undefined */
  resource?: PartyResourceView;
  /**
   * 第二资源（`resources[1]`）。盗贼的连击点、圣骑士的圣能都在这里；
   * 德鲁伊的能量、死骑的符文能量也走这条路，只是画法不同（见 channelHtml）。
   */
  secondary?: PartyResourceView;
  /** 当前生效的控制。空数组表示无控制 */
  controls: readonly ControlKind[];
  dead: boolean;
  carryingFlag: boolean;
}

/** 15.1：最多 12 名（12v12 每边正好 12 人）*/
export const MAX_PARTY_MEMBERS = 12;

// ── P10 布局预算 ─────────────────────────────────────────────────
//
// 真机实测（1600×900，`?testbed&stress=23`）：12 人的队伍框高 759px，
// 顶边 350 → 底边 1109，而视口只有 900 —— 最后几个人在屏幕外，中间几个
// 压在战斗日志（#combat-log 顶边 612）上。两件事一起做才够：
//   1) 把单人卡片压薄：控制字形并进姓名行（省掉一整行占位）、资源数字
//      叠在条内（不另起一行）；
//   2) 还塞不下就分列 —— 给容器一个**确定高度**，列数交给 flex
//      column-wrap 自己算。这样即使实际行高与下面的预算有出入，
//      浏览器也只会多分一列，**不会**再溢出到日志上。

/**
 * 单人卡片的高度预算，逐项列出来是为了 `PARTY_MEMBER_HEIGHT_PX` 与下面
 * 的 CSS 用的是**同一组数**（CSS 由这些常量拼出来），改一处不会漏另一处。
 */
const CARD = {
  /** 描边，上下各一 */
  border: 1,
  /** 内边距，上下各一 */
  padY: 2,
  /** 姓名 / 职业 / 控制字形 / 旗手死亡标记共用的一行 */
  nameRow: 12,
  /** 生命条 */
  hpBar: 6,
  /** 资源行：条内叠「标签 当前 / 上限」，右侧挂连击点圆点 */
  chanRow: 10,
  /** 行间距 */
  rowGap: 2,
} as const;

/** 一张卡片的最坏高度（有资源、有连击点、有控制字形时也是这个数）*/
export const PARTY_MEMBER_HEIGHT_PX =
  CARD.border * 2 + CARD.padY * 2 + CARD.nameRow + CARD.rowGap + CARD.hpBar + CARD.rowGap + CARD.chanRow;

/** 卡片之间的间距 */
export const PARTY_GAP_PX = 3;

/**
 * 战斗日志给队伍框划下的底线：`#combat-log` 是 `bottom:14`，**满格**
 * （`CombatHud.renderLog` 截 14 行 × 实测行高 21.2）高 309 —— 于是视口
 * 底部这 323px 是不能进的。
 *
 * ⚠️ 必须按**满格**算，不能按当帧的实际高算：开局日志是空的，那时候量到
 *   的可用高度会宽出 300px，等打起来日志涨满，队伍框已经排完不会重排了 ——
 *   于是「刚进场看着好好的，打起来最后几个人被日志压住」。P10 第一版就是
 *   照半满的日志（274）量的，真机复验里有 2 张卡片压线，这行数字是改出来的。
 */
const COMBAT_LOG_RESERVE_PX = 323;

/** 队伍框与日志之间留的呼吸缝。★ 占位值 6px：肉眼能看出两块是分开的即可 */
const PARTY_BREATH_PX = 6;

/**
 * 分列时的列宽。★ 占位值 152px：比单列的 176 窄一档，
 * 「死亡骑士」这种 4 字职业名 + 三个字的名字仍能不省略号地排下。
 */
const PARTY_WRAP_COLUMN_PX = 152;

/**
 * 列数上限。⚠️ 这个夹子是给**极端情况**兜底的：17.2 的界面缩放开到 2.0
 * 时，12 张卡片在 900p 下怎么排都放不下（日志自己也翻倍了）。与其让
 * flex 分出十几列横着铺满屏幕，不如认下「这一档必然会压到日志」，
 * 至少把宽度收在三列之内。★ 占位值 3。
 */
const PARTY_MAX_COLUMNS = 3;

/**
 * 离散点资源的圆点上限。★ 占位值 8：现有最大的离散池是死骑符文（6），
 * 连击点与圣能都是 5，留一档余量。超过这个数的池（能量/法力 100+）
 * 画成圆点既挤不进窄列、也读不出具体数，退回「条 + 数字」。
 */
export const PARTY_MAX_DOTS = 8;

export interface PartyLayoutInput {
  /** 卡片张数 */
  readonly count: number;
  /** 队伍框顶边在**屏幕**坐标里的位置（`getBoundingClientRect().top`）*/
  readonly frameTop: number;
  /** 视口高（`window.innerHeight`）*/
  readonly viewportHeight: number;
  /**
   * 17.2 的界面缩放。⚠️ `#combat-hud > *` 上套了 `zoom: var(--ui-scale)`，
   * 元素自己写的 CSS 像素会被再乘一遍才落到屏幕上 —— 所以屏幕上的可用
   * 高度必须除以它，才是能写进 `style.height` 的数。
   */
  readonly scale: number;
}

export interface PartyLayout {
  /** 一列能排下几张 */
  readonly rowsPerColumn: number;
  /** 是否要分列 */
  readonly wrap: boolean;
  /** 分列时给容器的确定高度（元素自身的 CSS 像素）*/
  readonly height: number;
}

/**
 * 排版决策的**纯函数**核心。抽出来是因为它是这次修复真正会回归的地方：
 * 「12 人在 900p 下不压日志」是一条算术命题，靠肉眼看截图守不住。
 */
export const partyLayout = ({
  count,
  frameTop,
  viewportHeight,
  scale,
}: PartyLayoutInput): PartyLayout => {
  const s = scale > 0 ? scale : 1;
  const unit = PARTY_MEMBER_HEIGHT_PX + PARTY_GAP_PX;
  // 屏幕上「队伍框顶边 → 日志顶边」这一段，换算回元素自身的 CSS 像素
  const avail = Math.max(
    PARTY_MEMBER_HEIGHT_PX,
    (viewportHeight - frameTop) / s - COMBAT_LOG_RESERVE_PX - PARTY_BREATH_PX,
  );
  const rowsFit = Math.max(1, Math.floor((avail + PARTY_GAP_PX) / unit));
  const wrap = count > rowsFit;
  const cols = Math.min(PARTY_MAX_COLUMNS, Math.max(1, Math.ceil(count / rowsFit)));
  // ★ 分列时按列数**再摊平**一次：7 人不该排成 6 + 1，排成 4 + 3 好看得多
  const rows = wrap ? Math.ceil(count / cols) : Math.max(1, count);
  return {
    rowsPerColumn: rows,
    wrap,
    height: rows * PARTY_MEMBER_HEIGHT_PX + Math.max(0, rows - 1) * PARTY_GAP_PX,
  };
};

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/**
 * 组件自带样式。
 *
 * ⚠️ `index.html` 不归本包管（P10 的分工），所以队伍框自己注入。选择器一律
 * 带 `#party-frame` 前缀：id + class 的特异性高过 index.html 里的老规则，
 * 于是**不依赖插入顺序**就能盖住它们，也漏不到别的面板上去。
 */
export const PARTY_FRAME_CSS = `
#party-frame { gap: ${PARTY_GAP_PX}px; }
/* 分列：给确定高度，列数交给 flex 自己算（实际行高与预算有出入时只会多一列，不会溢出）*/
#party-frame.pf-wrap { flex-wrap: wrap; width: max-content; align-content: flex-start; }
#party-frame.pf-wrap .pf-member { width: ${PARTY_WRAP_COLUMN_PX}px; }

#party-frame .pf-member {
  padding: ${CARD.padY}px 5px;
  border-width: ${CARD.border}px;
  border-radius: 5px;
  /* C4：整块 HUD 是 pointer-events:none 的，卡片得自己把点击要回来 */
  pointer-events: auto;
  cursor: pointer;
}
/* 悬停反馈：可点选这件事得**看得出来**，否则等于没做 */
#party-frame .pf-member:hover { border-color: #6f7a90; background: rgba(38,44,56,.92); }
#party-frame .pf-top {
  display: flex; align-items: center; gap: 3px;
  line-height: ${CARD.nameRow}px; font-size: 11px; overflow: hidden;
}
#party-frame .pf-name { flex: 0 1 auto; min-width: 0; overflow: hidden;
                        text-overflow: ellipsis; white-space: nowrap; }
/* ⚠️ 职业名可收缩、控制字形不可 —— 名字太长时先省略职业，也不能把「他被沉默了」挤出行外 */
#party-frame .pf-class { flex: 0 1 auto; min-width: 0; overflow: hidden;
                         color: #7d8698; font-size: 10px; white-space: nowrap; }
/* 控制字形与旗手/死亡标记推到行尾，空着时不占高度（此前是一整行 14px 的占位）*/
#party-frame .pf-marks { flex: none; margin-left: auto; display: flex; gap: 2px; }
#party-frame .pf-ctrl { font-size: 11px; color: #d0a8ff; }
#party-frame .pf-flag { color: #ffd76a; }
#party-frame .pf-dead { color: #e08a8a; }

#party-frame .pf-bar {
  position: relative; display: block; height: ${CARD.hpBar}px;
  margin-top: ${CARD.rowGap}px; border-radius: 3px; overflow: hidden; background: #22262f;
}
#party-frame .pf-bar i { position: absolute; inset: 0 auto 0 0; display: block;
                         height: 100%; background: #5a8fd0; }
#party-frame .pf-bar.hp i { background: #4fbf70; }

/* 资源行：主资源条 + 右侧的第二通道，同一行 —— 多一行就是多 12px × 12 人 */
#party-frame .pf-chans {
  display: flex; align-items: center; gap: 4px; margin-top: ${CARD.rowGap}px;
}
#party-frame .pf-chans .pf-bar { flex: 1 1 auto; min-width: 0; margin-top: 0;
                                 height: ${CARD.chanRow}px; }
#party-frame .pf-bar u {
  position: relative; display: block; text-decoration: none;
  line-height: ${CARD.chanRow}px; font-size: 9px; text-align: center;
  color: #e6e8ee; text-shadow: 0 1px 2px rgba(0,0,0,.9);
  white-space: nowrap; overflow: hidden;
}
/* 与目标框同一套资源配色（index.html 的 .bar.mana.<res>），玩家不用重学 */
#party-frame .pf-bar.res-mana i { background: #4a72c8; }
#party-frame .pf-bar.res-rage i { background: #c44a4a; }
#party-frame .pf-bar.res-energy i { background: #d4c04a; }
#party-frame .pf-bar.res-focus i { background: #c98a4a; }
#party-frame .pf-bar.res-runes i { background: #6ab4d4; }
#party-frame .pf-bar.res-runicPower i { background: #7a86c8; }

/* 第二通道之离散点：连击点/圣能/（将来）符文都走这里 */
#party-frame .pf-pts { flex: none; display: flex; align-items: center; gap: 2px;
                       line-height: ${CARD.chanRow}px; }
#party-frame .pf-pts em { font-style: normal; font-size: 9px; color: #8b93a7; margin-right: 1px; }
/* 窄列里放不下标签，退到 title —— 圆点本身仍在，数目不变 */
#party-frame.pf-wrap .pf-pts em { display: none; }
#party-frame .pf-pts b {
  display: block; width: 6px; height: 6px; border-radius: 50%;
  /* 17.2：亮/灭的主通道是**形状**（实心 vs 空心环），颜色只是第二通道 */
  box-sizing: border-box; border: 1px solid #6c7386; background: transparent;
}
#party-frame .pf-pts b.on { border-color: #ffb86a; background: #ffb86a; }

#party-frame .pf-member.dead { opacity: .45; }
`;

const STYLE_ID = 'party-frame-style';

/** 幂等注入：两个场景各建一次 CombatHud 也只会有一份样式 */
const ensureStyle = (): void => {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = PARTY_FRAME_CSS;
  document.head.appendChild(style);
};

/**
 * 事件委托里「`data-id` → 实体 id」这一步。
 * ⚠️ 抽成独立函数是为了能测 —— client 包没装 jsdom，真 DOM 测不了，
 * 而这一步（点在卡片之间的空隙上、`data-id` 不是数字）正是「点一下把目标
 * 切成 NaN」这类静默故障的来源：错误不会报，只会选不中人。
 */
export const memberIdOf = (raw: string | null | undefined): number | undefined => {
  if (raw === undefined || raw === null || raw.trim() === '') return undefined;
  const id = Number(raw);
  return Number.isFinite(id) ? id : undefined;
};

export class PartyFrame {
  private readonly el: HTMLElement;

  /**
   * 合同 C4：点队友框 → 选中他。
   * ⚠️ 在此之前**没有任何**用鼠标点框选人的路径 —— 治疗只能靠 Tab 循环
   * 或者去 3D 场景里找那个人的姓名板，这在 12v12 里基本等于选不中。
   */
  onSelectMember?: (entityId: number) => void;

  /** 排版只在人数/视口变化时重算 —— 见 render 里的注释 */
  private layoutKey = '';

  constructor(container: HTMLElement) {
    ensureStyle();
    this.el = document.createElement('div');
    this.el.id = 'party-frame';
    container.appendChild(this.el);

    /**
     * 事件委托挂在容器上：卡片每帧全量重建（render 重写 innerHTML），
     * 逐张绑事件会在下一帧就全部失效。
     * ★ `stopPropagation` + `preventDefault`：别让这一次点击穿透到画布，
     *   被当成瞄准确认或者相机拖拽 —— 与技能格、姓名板同一条规矩。
     */
    this.el.addEventListener('mousedown', (ev) => {
      const card = (ev.target as HTMLElement | null)?.closest<HTMLElement>('.pf-member');
      const id = memberIdOf(card?.dataset['id']);
      if (id === undefined) return;
      ev.stopPropagation();
      ev.preventDefault();
      this.onSelectMember?.(id);
    });
  }

  /**
   * 渲染队伍框。超过 12 人时截断 —— 15.1 明确写了「最多 12 名」，
   * 静默画到第 13 个会把 HUD 顶出屏幕。
   */
  render(members: readonly PartyMemberView[]): void {
    const shown = members.slice(0, MAX_PARTY_MEMBERS);
    if (shown.length === 0) {
      this.el.style.display = 'none';
      this.layoutKey = '';
      return;
    }
    this.el.style.display = '';
    this.el.innerHTML = shown.map(memberHtml).join('');
    this.applyLayout(shown.length);
  }

  /**
   * ⚠️ 量尺（`getBoundingClientRect` / `getComputedStyle`）会强制同步重排，
   * 而 render 是每帧调用的 —— 12 人压测时每帧白白重排一次不值。
   * 所以只在**人数或视口高变了**的时候重算；两者都没变时排版结论必然相同。
   * ⚠️ 代价：界面缩放（17.2）改完要等人数或窗口变化才会重排。缩放是设置
   * 面板里的低频操作，用一次错帧换掉每帧一次强制重排，这笔账划算。
   */
  private applyLayout(count: number): void {
    const viewportHeight = window.innerHeight;
    const key = `${count}|${viewportHeight}`;
    if (key === this.layoutKey) return;
    this.layoutKey = key;

    const scale = Number(getComputedStyle(this.el).zoom) || 1;
    const { wrap, height } = partyLayout({
      count,
      frameTop: this.el.getBoundingClientRect().top,
      viewportHeight,
      scale,
    });
    this.el.classList.toggle('pf-wrap', wrap);
    this.el.style.height = wrap ? `${height}px` : '';
  }

  hide(): void {
    this.el.style.display = 'none';
    this.layoutKey = '';
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
  const channel = (r: Resource | undefined): PartyResourceView | undefined =>
    r === undefined
      ? undefined
      : {
          current: resourceOf(r as string) ?? 0,
          max: maxResourceOf(r as string) ?? 1,
          label: RESOURCE_TEXT[r] ?? String(r),
          key: r,
        };
  const primary = channel(cls?.resources[0]?.resource);
  // 盗贼的连击点、圣骑士的圣能都长在 resources[1] —— 此前 UI 完全不画它
  const secondary = channel(cls?.resources[1]?.resource);
  return {
    id: e.id,
    name: e.name,
    className: cls?.name ?? '',
    health: e.health,
    maxHealth: e.maxHealth,
    ...(primary === undefined ? {} : { resource: primary }),
    ...(secondary === undefined ? {} : { secondary }),
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

/** 圆点画法适用于哪些池 —— 通用判据，不写死「连击点」（符文将来直接复用）*/
export const isPointResource = (c: PartyResourceView): boolean =>
  Number.isFinite(c.max) && c.max >= 1 && c.max <= PARTY_MAX_DOTS;

/**
 * 一条资源通道的 HTML。
 *
 * ★ 主通道恒定画成「条 + 标签 + 当前 / 上限」，与 15.2 目标框逐字同格式 ——
 *   P10 审计里最刺眼的一条就是「敌人的资源写着怒气 5 / 100，自己人的是根
 *   没头没尾的蓝条」。
 * ★ 第二通道按池的大小自己挑画法：小池（连击点 5、圣能 5、符文 6）画圆点，
 *   大池（德鲁伊能量 100、死骑符文能量 100）退回同样的条 —— 100 颗圆点
 *   既排不下也数不清。
 */
export const channelHtml = (c: PartyResourceView, secondary = false): string => {
  const label = esc(c.label);
  const cur = Math.round(c.current);
  const max = Math.round(c.max);
  if (secondary && isPointResource(c)) {
    const lit = Math.max(0, Math.min(max, cur));
    const dots = Array.from({ length: max }, (_, i) => `<b class="${i < lit ? 'on' : ''}"></b>`).join('');
    return `<span class="pf-pts" title="${label} ${lit} / ${max}"><em>${label}</em>${dots}</span>`;
  }
  const pct = Math.max(0, Math.min(100, (c.current / Math.max(1, c.max)) * 100));
  const cls = c.key === undefined ? 'res' : `res res-${c.key}`;
  return `<span class="pf-bar ${cls}" title="${label} ${cur} / ${max}"
    ><i style="width:${pct}%"></i><u>${label} ${cur} / ${max}</u></span>`;
};

/** 单人卡片的 HTML。导出是为了让 `partyFrame.test.ts` 能在无 DOM 环境下钉住它 */
export const memberHtml = (m: PartyMemberView): string => {
  const hpPct = m.dead ? 0 : Math.max(0, Math.min(100, (m.health / m.maxHealth) * 100));

  // 17.2：控制用字形而不是只用颜色，且与 3D 场景共用同一张表
  const controls = m.controls
    .map((k) => {
      const v = CONTROL_VISUALS[k];
      return `<span class="pf-ctrl" title="${esc(v.label)}">${v.glyph}</span>`;
    })
    .join('');

  const chans =
    m.resource === undefined && m.secondary === undefined
      ? ''
      : `<div class="pf-chans">${m.resource ? channelHtml(m.resource) : ''}${
          m.secondary ? channelHtml(m.secondary, true) : ''
        }</div>`;

  return `<div class="pf-member${m.dead ? ' dead' : ''}" data-id="${m.id}" title="${esc(m.name)} · ${esc(m.className)}">
    <div class="pf-top">
      <span class="pf-name">${esc(m.name)}</span>
      <span class="pf-class">${esc(m.className)}</span>
      <span class="pf-marks">${controls}${
        m.carryingFlag ? '<span class="pf-flag" title="旗手">⚑</span>' : ''
      }${m.dead ? '<span class="pf-dead" title="已死亡">✖</span>' : ''}</span>
    </div>
    <div class="pf-bar hp" title="生命 ${Math.round(m.health)} / ${Math.round(m.maxHealth)}"><i style="width:${hpPct}%"></i></div>
    ${chans}
  </div>`;
};
