/**
 * X17：目标框 / 自身框的光环行。
 *
 * ★★ **这一行补的是目标制 PVP 最大的一处信息盲区。**
 *
 *   在此之前，「我挂在他身上的持续伤害还剩几秒」「他有没有吸收盾」
 *   「我身上的减速掉没掉」——三件每一秒都要做判断的事，全都只走
 *   **战斗日志**一条通道（左下角、会滚走、只说事件不说状态）。
 *   P10 把日志里的内部 id 换成了显示名，但日志终究是**流水**不是**面板**：
 *   它回答「刚才发生了什么」，回答不了「现在是什么状态」。
 *
 * ★ 数据两边都是现成的，缺的一直是这一层投影：
 *     · 试验场 —— `sim/aura.ts` 的 `aurasOf(store, id)`
 *     · 联网   —— 快照里的 `AuraSnapshot`（全公开，零裁剪面）
 *   所以本文件的**投影判据**（kind/名字/秒数/层数/护盾条）一律只吃调用方
 *   给的 `HudAura`，一处都不去查全局状态。⚠️ 唯一的例外是 `auraIconUrl`
 *   查两张**静态数据表**（图标表与 X26 光环注册表）—— 那是「这个 id 长什么样」，
 *   不是「这一刻发生了什么」，与调用方给的那份数据不会分叉。
 *
 * ── 三条纪律 ──────────────────────────────────────────────────
 *
 * ★★ **S7 的 `HIDDEN_AURA_ID` 必须中性显示。** 服务器会把「会泄露施加者
 *   职业」的光环 id 掩成 `'hidden'` 这个中性 token。这里对它
 *   **不查学派、不查图标、不猜名字** —— 只画一个灰底问号格子。
 *   任何「顺手按 id 前缀猜个颜色」的写法都会把服务器刚刚掩掉的东西漏回去。
 *
 * ★★ **17.2 不能只靠颜色。** 增益 / 减益的区分走**三条**通道：
 *   边框色（`--c-friendly` / `--c-hostile`）+ 角标字形（＋ / －）+ class。
 *   截图压掉颜色、或玩家是红绿色弱时，字形照样能分。
 *
 * ★ **上限截断 + 溢出计数**：满屏光环等于没有光环。超过 `AURA_ROW_MAX`
 *   的部分收成一个 `+N` 格子 —— 不是悄悄丢掉，玩家知道还有几枚没显示。
 */

import { HIDDEN_AURA_ID } from '@wowpvp/shared';
import { auraSkillById } from '../data/auraRegistry.js';
import type { HudAura, HudAuraKind } from './CombatView.js';
import { SCHOOL_COLOR } from './schoolColor.js';
import { escHtml as esc } from './skillTooltip.js';
import { remoteIconsReady } from './skillIcon.js';
import { skillIconUrl } from './skillIconMap.js';

/**
 * 一行最多显示几枚。
 *
 * ★ 8 的由来：目标框宽 260px，16px 图标 + 3px 间距 ⇒ 8 枚占 152px，
 *   与同框的 `uf-meta`（距离/武器/控制旗标）并排还有余量。
 *   没有规格出处，是一个**排得下**的数 —— 改宽了就该一起改。
 */
export const AURA_ROW_MAX = 8;

/**
 * 17.2 的第二通道：增益 / 减益各有一个字形。
 *
 * ⚠️ 三个字符与仓库里另外三张字形表**两两不撞**（选之前逐张比对过）：
 *   `BLOCKER_GLYPH`（✕ ◈ ⏱ ⊘）、`CONTROL_VISUALS`（❄ ✷ ⊘ 〰 ⚔）、
 *   姓名板阵营前缀（▲ ◆）。撞了就等于让玩家在两个控件上看到同一个符号
 *   却是两个意思。
 */
export const AURA_KIND_GLYPH: Record<HudAuraKind, string> = {
  buff: '＋',
  debuff: '－',
  unknown: '·',
};

/** 查不到学派时的中性色。★ 编一个颜色比不画更糟（与护盾色同一条纪律）*/
export const AURA_NEUTRAL_COLOR = '#9aa3b6';

/** 一枚光环格子渲染所需的全部信息。★ 纯数据，没有 DOM —— 于是可测 */
export interface AuraChip {
  id: string;
  kind: HudAuraKind;
  glyph: string;
  /**
   * 剩余秒数。**持续型（潜行、德鲁伊形态、`persistent` 光环）为 undefined** ——
   * 那种光环没有倒计时可言，画一个不动的数字就是在骗人。
   */
  remaining: number | undefined;
  stacks: number;
  color: string;
  iconUrl: string | undefined;
  /** 吸收盾剩余比例 0..1（14.3 的「强度衰减」）。非护盾为 undefined */
  absorbPct: number | undefined;
  /** 悬停/无障碍文本 */
  label: string;
}

export interface AuraRow {
  chips: AuraChip[];
  /** 被截断掉的枚数。0 = 全显示完了 */
  overflow: number;
}

/**
 * 排序权重：减益在前。
 *
 * ★ 为什么减益优先而不是按施加时间：目标框上「他身上我的 DoT 还剩几秒」
 *   与自身框上「我中了什么、还有多久掉」都是**要立刻做决定**的信息；
 *   增益（自己的爆发窗、对面的盾）次一等。截断发生时该被截掉的是后者。
 * ★ `unknown`（S7 掩码）排最后 —— 它连是好是坏都不知道，占不了前排。
 */
const KIND_RANK: Record<HudAuraKind, number> = { debuff: 0, buff: 1, unknown: 2 };

/**
 * 光环 id → 图标 URL。
 *
 * ★ 光环 id 多是 `<职业>.<技能>.<后缀>`（`mage.frostbolt.chill`、
 *   `priest.shadow_word_pain.dot`），而 `SKILL_ICON_FILES` 的键是**技能 id**。
 *   三级台阶，**按精确度**排：
 *     ① **原样查** —— 光环 id 与技能同名（`warrior.hamstring`、`mage.ice_barrier`）。
 *        这一条排第一而不是排在注册表后面是有讲究的：`rogue.stealth` 同时被
 *        潜行与消失施加，注册表按先来先得记的可能是**消失**，而玩家看的是
 *        身上那枚「潜行」—— 名字对得上的那张图永远最准。
 *     ② **X26 注册表**（`data/auraRegistry.ts`）—— 精确查「是哪个技能施加的」。
 *        补的是旧启发式落空的那一批：`warrior.mortal_wounds` → 致死打击、
 *        `deathknight.winter_domain_chill` → 寒冬领域、`ffa.greasy` → 鸡腿雨、
 *        `ffa.stardust` → 陨星。此前它们四个在光环行上是**光秃秃的色块**。
 *     ③ **去掉最后一段再查** —— 旧启发式，**不许删**：运行时拼出来的 id
 *        （sim 现造的光环）在注册表里没有，只有这一条路。
 *   ⚠️ 只退这两层，不做更花哨的猜名：猜错了会给玩家一张**语义错误**的图，
 *     比没有图更糟。
 * ⚠️ `control.<kind>` 三条全落空，回落色块。
 * ★★ `HIDDEN_AURA_ID` 第一行挡掉 —— 掩码光环连注册表都不许查（S7）。
 */
export const auraIconUrl = (auraId: string): string | undefined => {
  if (auraId === HIDDEN_AURA_ID) return undefined;
  const direct = skillIconUrl(auraId);
  if (direct) return direct;
  const applier = auraSkillById(auraId);
  const byRegistry = applier ? skillIconUrl(applier.id as string) : undefined;
  if (byRegistry) return byRegistry;
  const cut = auraId.lastIndexOf('.');
  return cut > 0 ? skillIconUrl(auraId.slice(0, cut)) : undefined;
};

/** 剩余秒数的排版。★ 10 秒以内给一位小数（DoT 收尾那两秒值钱），以上取整 */
export const auraTimeText = (remaining: number): string => {
  if (remaining >= 60) return `${Math.ceil(remaining / 60)}m`;
  if (remaining >= 10) return String(Math.round(remaining));
  return remaining.toFixed(1);
};

/**
 * 把 `HudUnit.auras` 投影成一行格子。
 *
 * @param now 当前模拟时间（`CombatView.now`）。★ 剩余秒数在这里算，
 *   而不是让生产方每 tick 塞一个 `remaining` 进来 —— 与 P11 给
 *   `AuraSnapshot.expiresAt` 的理由完全一致：发**事实**，剩余量由消费方算。
 *   一份快照在插值期间被读很多次，`remaining` 会越读越旧，`expiresAt` 不会。
 */
export const auraRowModel = (
  auras: readonly HudAura[] | undefined,
  now: number,
  max = AURA_ROW_MAX,
): AuraRow => {
  if (!auras || auras.length === 0) return { chips: [], overflow: 0 };

  const all: AuraChip[] = auras.map((a) => {
    const hidden = a.id === HIDDEN_AURA_ID;
    const remaining =
      a.expiresAt === undefined || !Number.isFinite(a.expiresAt)
        ? undefined
        : Math.max(0, a.expiresAt - now);
    const kind: HudAuraKind = hidden ? 'unknown' : a.kind;
    // ★ 掩码光环不查学派 —— 服务器刚把来源抹掉，这里不能从旁边漏回去
    const color = hidden
      ? AURA_NEUTRAL_COLOR
      : (a.school !== undefined ? SCHOOL_COLOR[a.school] : undefined) ?? AURA_NEUTRAL_COLOR;
    const absorbPct =
      a.absorbInitial !== undefined && a.absorbInitial > 0 && a.absorbRemaining !== undefined
        ? Math.max(0, Math.min(1, a.absorbRemaining / a.absorbInitial))
        : undefined;
    const stacks = Math.max(1, Math.round(a.stacks ?? 1));
    return {
      id: a.id,
      kind,
      glyph: AURA_KIND_GLYPH[kind],
      remaining,
      stacks,
      color,
      /**
       * ⚠️ 素材没探测通过时**一律回落色块**，与 `skillIconHtml` 同一条：
       *   逐 `<img>` 挂 onerror 意味着无素材环境下每秒几十个注定 404 的请求
       *   （光环行每 50ms 重建一次）。启动探测翻成 true 之后自然换真图标。
       */
      iconUrl: remoteIconsReady() ? auraIconUrl(a.id) : undefined,
      absorbPct,
      label: auraChipLabel(a, kind, remaining, stacks),
    };
  });

  all.sort((x, y) => {
    const k = KIND_RANK[x.kind] - KIND_RANK[y.kind];
    if (k !== 0) return k;
    // 快到期的排前面：将要掉的那一枚才是需要现在做决定的
    const rx = x.remaining ?? Number.POSITIVE_INFINITY;
    const ry = y.remaining ?? Number.POSITIVE_INFINITY;
    if (rx !== ry) return rx - ry;
    return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
  });

  return { chips: all.slice(0, max), overflow: Math.max(0, all.length - max) };
};

/**
 * 悬停文本。★ 名字仍然是**可选**的，即使 X26 之后联网侧多半填得出来：
 * `control.*` 与 sim 现造的光环在注册表里没有条目，那时退回 id ——
 * 而不是编一个中文名。生产方填不出就别填，这里照实显示 id。
 */
const auraChipLabel = (
  a: HudAura,
  kind: HudAuraKind,
  remaining: number | undefined,
  stacks: number,
): string => {
  const who = kind === 'buff' ? '增益' : kind === 'debuff' ? '减益' : '未知效果';
  const name = a.id === HIDDEN_AURA_ID ? '（来源不明）' : a.name ?? a.id;
  const time = remaining === undefined ? '持续' : `${auraTimeText(remaining)}s`;
  const stk = stacks > 1 ? ` ×${stacks}` : '';
  return `${who} · ${name}${stk} · ${time}`;
};

/**
 * 渲染成 HTML。
 *
 * ⚠️ **空行返回空串**，调用方因此原样不带任何节点 —— `HudUnit.auras`
 *   是可选字段，生产方还没接线时目标框的 HTML 与改造前**逐字节一致**。
 *   这条与合同 C1 的 `gcdRemaining` 是同一手法：可选字段让「没填」是
 *   一个合法状态，而不是一个空控件。
 */
export const auraRowHtml = (row: AuraRow): string => {
  if (row.chips.length === 0) return '';
  const chips = row.chips.map(auraChipHtml).join('');
  const more =
    row.overflow > 0
      ? `<span class="aura more" title="还有 ${row.overflow} 枚没显示">+${row.overflow}</span>`
      : '';
  return `<div class="aura-row" role="list">${chips}${more}</div>`;
};

const auraChipHtml = (c: AuraChip): string => {
  const icon = c.iconUrl
    ? `<img class="aura-ico" src="${c.iconUrl}" width="16" height="16" alt="" draggable="false" loading="lazy"/>`
    : '<span class="aura-ico"></span>';
  const time = c.remaining === undefined ? '' : `<span class="aura-left">${auraTimeText(c.remaining)}</span>`;
  const stk = c.stacks > 1 ? `<i class="aura-stk">${c.stacks}</i>` : '';
  // 14.3 护盾的「强度衰减」：格子底部一道随剩余量退下去的条
  const abs =
    c.absorbPct === undefined
      ? ''
      : `<i class="aura-abs" style="height:${(c.absorbPct * 100).toFixed(0)}%"></i>`;
  return `<span class="aura ${c.kind}" role="listitem" data-aura="${esc(c.id)}"
      style="--aura:${c.color}" title="${esc(c.label)}" aria-label="${esc(c.label)}"
      >${icon}${abs}<b class="aura-sign">${c.glyph}</b>${time}${stk}</span>`;
};
