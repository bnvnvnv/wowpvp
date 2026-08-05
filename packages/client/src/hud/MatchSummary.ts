/**
 * 战后结算面板。规格书 16.1–16.4，docs/14 §16a。
 *
 * ★★ **在此之前 `sim/stats.ts` 算好的一切都没有出口。** M9 把七项最佳玩家、
 *   携旗距离、护送时长、打断成功率全实现了并有 35 条验收，
 *   但联网玩家看到的只有一行「红方获胜」—— 统计跑了整局然后被丢掉。
 *
 * ★ 16.4 的否定式规则「**不能只按总伤害或击杀数评选最佳玩家**」由 sim 的
 *   `composeScore()` 保证，本文件**不重新排名**，只展示 `pickAwards()` 的结果。
 *   面板自己排一遍序就等于在表现层重新定义了一次「谁最好」。
 *
 * ★ 默认按伤害降序 —— 那只是**表格顺序**，不是评价。最佳玩家单独一栏，
 *   而且刻意放在表格**上方**：先看谁贡献大，再看谁伤害高。
 */

import { TEAM_RED, type AwardView, type MatchStatsRow } from '@wowpvp/shared';

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** 大数字加千分位 —— 16.1 要「玩家看得懂」，123456 读起来很费劲 */
const num = (v: number): string => v.toLocaleString('zh-CN');

export interface MatchSummaryData {
  rows: readonly MatchStatsRow[];
  awards: readonly AwardView[];
  /** 高亮自己那一行 */
  selfId?: number;
}

/**
 * 渲染成 HTML 字符串（由大厅的结算页插入）。
 *
 * ★ 纯函数、不碰 DOM —— 于是它可以被单测直接断言，
 *   而「最佳玩家有没有被显示出来」这种事就不必靠人眼看截图。
 */
export const renderMatchSummary = (data: MatchSummaryData): string => {
  const awarded = data.awards.filter((a) => a.winnerId !== undefined);

  const awardsHtml = awarded.length === 0
    ? '<div class="ms-empty">本局没有产生最佳玩家（无人在任何维度有贡献）</div>'
    : awarded.map((a) => `
        <div class="ms-award${a.award === 'bestOverall' ? ' ms-award-top' : ''}">
          <div class="ms-award-name">${esc(a.name)}</div>
          <div class="ms-award-who">${esc(a.winnerName ?? '—')}</div>
          ${a.parts && a.parts.length > 0
            ? `<div class="ms-award-why">${esc(explainParts(a.parts))}</div>`
            : ''}
        </div>`).join('');

  const rowsHtml = data.rows.map((r) => `
      <tr class="${r.team === TEAM_RED ? 'ms-red' : 'ms-blue'}${r.entityId === data.selfId ? ' ms-self' : ''}">
        <td class="ms-name">${esc(r.name)}</td>
        <td>${r.kills}</td><td>${r.deaths}</td><td>${r.assists}</td>
        <td>${num(r.damageDone)}</td>
        <td>${num(r.healingDone)}</td>
        <td>${num(r.damageTaken)}</td>
        <td>${num(r.absorbProvided)}</td>
        <td>${r.interruptsLanded}</td>
        <td>${r.crits}</td>
      </tr>`).join('');

  return `
    <div class="ms-awards">${awardsHtml}</div>
    <table class="ms-table">
      <thead><tr>
        <th>玩家</th><th title="击杀">杀</th><th title="死亡">死</th><th title="助攻">助</th>
        <th>伤害</th><th>治疗</th><th>承伤</th><th title="护盾吸收">吸收</th>
        <th title="成功打断">打断</th><th title="暴击次数">暴击</th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>`;
};

/**
 * 综合奖的「为什么是他」。
 *
 * ★ 16.4 第二条要求综合评价**不能被单一维度主导**，`composeScore()` 已经
 *   在算分时钉死了这一点（`MAX_DIMENSION_WEIGHT_SHARE`）。这里把前两个
 *   维度显示出来，是让玩家**看得到**那条规则在起作用 ——
 *   否则「最佳综合玩家」在玩家眼里仍然像是「伤害最高的那个」。
 */
/** ★ 键必须与 sim 的 `SCORE_DIMENSIONS` 一致 —— 有单测钉住这一点 */
const DIMENSION_NAMES: Readonly<Record<string, string>> = {
  combat: '输出',
  healing: '治疗',
  disruption: '控制与打断',
  objective: '目标争夺',
  supply: '补给争夺',
  survival: '生存',
};

const explainParts = (parts: readonly { dimension: string; share: number }[]): string => {
  const top = [...parts].sort((a, b) => b.share - a.share).slice(0, 2)
    .filter((p) => p.share > 0);
  if (top.length === 0) return '';
  return `主要来自：${top.map((p) => DIMENSION_NAMES[p.dimension] ?? p.dimension).join('、')}`;
};
