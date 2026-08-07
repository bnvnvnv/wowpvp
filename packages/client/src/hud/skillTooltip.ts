/**
 * 技能悬浮说明（tooltip）与「不可用原因」的分级。
 *
 * ★★ **这是 `SkillDef.description` / `SkillDef.counters` 第一次有消费方。**
 *   schema.ts 的注释从一开始就写着「附录A#3：反制方式，必须写清楚，
 *   **也直接用于 HUD tooltip**」—— 91 个技能都老老实实填了，客户端却
 *   从来没读过。真机审计的原话是「不知道技能是干什么的」：技能栏只有
 *   名字 + 瞬发/射程两行，玩家想知道「这招怎么反制」只能去翻源码。
 *
 * ★ 纯函数、只吃 `SkillDef`、返回 HTML 字符串 —— 与 MatchSummary 同一手法。
 *   这样它能被单测断言（本仓库测试跑在 node 里，没有 DOM），
 *   否则「tooltip 里到底有没有 counters」只能靠人眼看截图。
 *
 * ⚠️ 不用原生 `title=""`：原生提示有 ~1 秒延迟、样式不可控、
 *   在 pointer-lock 的 3D 画面上位置也不受控。自绘浮层是唯一能同时满足
 *   「即时出现 + 学派配色 + 视口内钳位」的做法。
 */

import {
  CastFailure,
  CastKind,
  type SkillDef,
} from '@wowpvp/shared';
import { FAIL_TEXT, SCHOOL_TEXT } from '../combat/CombatDirector.js';
import { SCHOOL_COLOR } from './schoolColor.js';
import { RESOURCE_TEXT } from './PartyFrame.js';

/** HTML 转义。★ 单一实现，HUD 各处共用 —— 两份转义表迟早会分叉 */
export const escHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * 施法方式的人话。
 *
 * ★ 三种 kind 的**反制方式完全不同**（7.2/7.6：读条吃打断与沉默、
 *   射击准备吃缴械但不吃沉默、瞬发只吃硬控），所以这一行不能只写
 *   「1.5s」了事 —— 数字告诉你要等多久，词告诉你对手能怎么办你。
 */
export const castMethodText = (skill: SkillDef): string => {
  const c = skill.cast;
  const suffix = c.kind === CastKind.Instant ? '' : c.interruptible ? '' : ' · 不可打断';
  switch (c.kind) {
    case CastKind.Instant:
      return '瞬发';
    case CastKind.Cast:
      return `读条 ${c.time} 秒${c.movable ? ' · 可移动施放' : ''}${suffix}`;
    case CastKind.Channel:
      return `引导 ${c.channelDuration ?? c.time} 秒${c.ticks ? `（${c.ticks} 跳）` : ''}${suffix}`;
    case CastKind.AimedShot:
      return `射击准备 ${c.time} 秒${suffix}`;
    default:
      return `${c.time} 秒`;
  }
};

/** 射程。★ `rangeFromWeapon` 必须说出来 —— 换把长弓射程就变了，写死的数字会撒谎 */
export const rangeText = (skill: SkillDef): string => {
  const { min, max } = skill.range;
  if (max === 0) return '自身';
  const base = min > 0 ? `${min}–${max} 米` : `${max} 米`;
  return skill.rangeFromWeapon ? `${base}（随当前武器触及变化）` : base;
};

export const costText = (skill: SkillDef): string => {
  const parts: string[] = [];
  if (skill.cost) {
    parts.push(`${RESOURCE_TEXT[skill.cost.resource] ?? String(skill.cost.resource)} ${skill.cost.amount}`);
  }
  if (skill.requiresComboPoints) parts.push('消耗全部连击点');
  return parts.length > 0 ? parts.join(' · ') : '无消耗';
};

/**
 * 冷却。
 *
 * ★ 「脱GCD」这个黑话**只在技能栏那个巴掌大的格子里**存在（放不下别的），
 *   tooltip 有地方就必须写全「不占公共冷却」—— 新玩家不知道 GCD 是什么，
 *   而「按了这个不耽误下一招」恰恰是 7.2 专用打断能玩起来的前提。
 */
export const cooldownText = (skill: SkillDef): string => {
  const cd = skill.cooldown > 0 ? `${skill.cooldown} 秒` : '无';
  return skill.triggersGcd ? cd : `${cd} · 不占公共冷却`;
};

/** tooltip 的完整 HTML。调用方负责定位与显隐 */
export const skillTooltipHtml = (skill: SkillDef): string => {
  const color = SCHOOL_COLOR[skill.school] ?? '#ccc';
  const row = (k: string, v: string): string =>
    `<div class="tip-row"><span>${k}</span><b>${escHtml(v)}</b></div>`;
  return `
    <div class="tip-head" style="--school:${color}">
      <b class="tip-name">${escHtml(skill.name)}</b>
      <em class="tip-school">${escHtml(SCHOOL_TEXT[skill.school] ?? String(skill.school))}</em>
    </div>
    <div class="tip-rows">
      ${row('消耗', costText(skill))}
      ${row('施法', castMethodText(skill))}
      ${row('射程', rangeText(skill))}
      ${row('冷却', cooldownText(skill))}
    </div>
    <div class="tip-desc">${escHtml(skill.description)}</div>
    <div class="tip-counter"><span>反制</span>${escHtml(skill.counters)}</div>
  `;
};

/** 屏幕阅读器用的一行。★ 与 tooltip 同源，不另写一套说法 */
export const skillAriaLabel = (skill: SkillDef, keyLabel: string, reason: string): string =>
  `${skill.name}，快捷键 ${keyLabel}，${castMethodText(skill)}，射程 ${rangeText(skill)}`
  + (reason ? `，当前不可用：${reason}` : '');

// ════════════════════════════════════════════════════════════════
//  不可用原因的分级（合同 C1 的 blockers[]）
// ════════════════════════════════════════════════════════════════

/**
 * 阻碍类别。**决定样式**，而样式必须有颜色之外的第二通道（17.2）。
 *
 * ★ 四类而不是逐个 CastFailure 配色：玩家要做的决策只有四种 ——
 *   走位 / 等资源 / 等冷却 / 先解控。把 20 种失败码摊成 20 种颜色
 *   等于没有分类。
 */
export type BlockerCategory = 'position' | 'resource' | 'cooldown' | 'state';

/**
 * 显示优先级：位置 → 视线 → 朝向 → 资源 → 冷却 → 状态。
 *
 * ★ 顺序不是随手排的，它是**玩家该先解决哪个**的顺序：站位问题解决之前，
 *   告诉他「资源不足」没有用（走过去的这两秒资源可能就回来了）。
 * ⚠️ 数字越小越先显示。没列到的失败码一律落到 `STATE_RANK`（状态类）。
 */
const BLOCKER_RANK: Partial<Record<CastFailure, number>> = {
  [CastFailure.OutOfRange]: 10,
  [CastFailure.TooClose]: 11,
  [CastFailure.InvalidGroundPosition]: 12,
  [CastFailure.NoLineOfSight]: 20,
  [CastFailure.WrongFacing]: 30,
  [CastFailure.NotEnoughResource]: 40,
  [CastFailure.OnCooldown]: 50,
  [CastFailure.OnGlobalCooldown]: 51,
};
const STATE_RANK = 90;

const POSITION_FAILS = new Set<CastFailure>([
  CastFailure.OutOfRange,
  CastFailure.TooClose,
  CastFailure.InvalidGroundPosition,
  CastFailure.NoLineOfSight,
  CastFailure.WrongFacing,
]);

export const blockerCategory = (f: CastFailure): BlockerCategory => {
  if (POSITION_FAILS.has(f)) return 'position';
  if (f === CastFailure.NotEnoughResource) return 'resource';
  if (f === CastFailure.OnCooldown || f === CastFailure.OnGlobalCooldown) return 'cooldown';
  return 'state';
};

/**
 * 字形通道。17.2：颜色之外必须还有一条通道 ——
 * 边框样式由 CSS 按 `data-blk` 给，这里给字形。
 */
export const BLOCKER_GLYPH: Record<BlockerCategory, string> = {
  position: '✕',
  resource: '◈',
  cooldown: '⏱',
  state: '⊘',
};

/**
 * 从一串阻碍里挑出**该显示的那一个**。
 *
 * ⚠️ 空数组返回 `Ok` —— 生产方（CombatDirector / 快照视图）没填这个字段时
 *   调用方走的是老的单个 `blocker`，不会误判成「可用」。
 */
export const pickBlocker = (blockers: readonly CastFailure[]): CastFailure => {
  let best: CastFailure = CastFailure.Ok;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const b of blockers) {
    if (b === CastFailure.Ok) continue;
    const r = BLOCKER_RANK[b] ?? STATE_RANK;
    if (r < bestRank) {
      bestRank = r;
      best = b;
    }
  }
  return best;
};

/** 阻碍的一行文字。冷却类会把秒数带上，因为「还剩多久」比「冷却中」有用 */
export const blockerText = (f: CastFailure, secondsLeft?: number): string => {
  const base = FAIL_TEXT[f] ?? String(f);
  return secondsLeft !== undefined && secondsLeft > 0
    ? `${base} ${secondsLeft.toFixed(1)}s`
    : base;
};
