/**
 * 结算面板与死亡回顾的折叠逻辑（docs/14 §16a 的判据「单测（死亡回顾的折叠逻辑）」）。
 *
 * ★ 这两块都刻意做成了**纯函数 / 不查询战斗状态**，就是为了能在这里断言 ——
 *   否则「最佳玩家有没有被显示出来」只能靠人眼看截图，而截图看不出
 *   「综合奖被伤害维度单独主导了」这种问题。
 */

import { describe, expect, it } from 'vitest';
import { SCORE_DIMENSIONS, asClassId, asEntityId, asTeamId } from '@wowpvp/shared';
import type { AwardView, MatchStatsRow } from '@wowpvp/shared';
import { renderMatchSummary } from './MatchSummary.js';
import {
  RECAP_MAX_ROWS, RECAP_SECONDS, pruneRecap, recapRowsFrom, type DamageLog,
} from './KillFeed.js';

const RED = asTeamId(0);
const BLUE = asTeamId(1);

const row = (id: number, name: string, over: Partial<MatchStatsRow> = {}): MatchStatsRow => ({
  entityId: asEntityId(id),
  name,
  team: RED,
  classId: asClassId('warrior'),
  kills: 0, deaths: 0, assists: 0,
  damageDone: 0, healingDone: 0, damageTaken: 0, absorbProvided: 0,
  interruptsLanded: 0, crits: 0,
  ...over,
});

describe('16.1 结算面板', () => {
  it('★ 每个玩家都有一行，数字如实显示', () => {
    const html = renderMatchSummary({
      rows: [
        row(1, '红甲', { damageDone: 12345, kills: 3, crits: 7 }),
        row(2, '蓝乙', { team: BLUE, healingDone: 8000, deaths: 2 }),
      ],
      awards: [],
    });
    expect(html).toContain('红甲');
    expect(html).toContain('蓝乙');
    // 千分位：16.1 要「玩家看得懂」
    expect(html).toContain('12,345');
    expect(html).toContain('>7<');   // 暴击次数（偏差 #7 的统计）
  });

  it('★ 自己那一行被高亮（12v12 里找自己是刚需）', () => {
    const html = renderMatchSummary({
      rows: [row(1, '红甲'), row(2, '蓝乙', { team: BLUE })],
      selfId: 2,
      awards: [],
    });
    // 只有一行带 ms-self
    expect(html.match(/ms-self/g) ?? []).toHaveLength(1);
    expect(html).toMatch(/ms-self[^>]*>\s*<td class="ms-name">蓝乙/);
  });

  it('★ 红蓝两队用不同的类名区分（不只靠一个颜色字）', () => {
    const html = renderMatchSummary({
      rows: [row(1, '红甲'), row(2, '蓝乙', { team: BLUE })],
      awards: [],
    });
    expect(html).toContain('ms-red');
    expect(html).toContain('ms-blue');
  });

  it('★ 无人有贡献时如实说「没有产生最佳玩家」，不硬塞一个 0 分获奖者', () => {
    const html = renderMatchSummary({
      rows: [row(1, '红甲')],
      // pickAwards 对无贡献的维度返回不带 winner 的条目
      awards: [{ award: 'bestHealer', name: '最佳治疗者' }],
    });
    expect(html).toContain('没有产生最佳玩家');
    expect(html).not.toContain('最佳治疗者');
  });

  it('★★ 综合奖显示「主要来自哪两个维度」—— 让 16.4 第二条看得见', () => {
    const awards: AwardView[] = [{
      award: 'bestOverall',
      name: '最佳综合玩家',
      winnerId: asEntityId(1),
      winnerName: '红甲',
      parts: [
        { dimension: 'combat', share: 0.1 },
        { dimension: 'objective', share: 0.3 },
        { dimension: 'healing', share: 0.25 },
      ],
    }];
    const html = renderMatchSummary({ rows: [row(1, '红甲')], awards });
    expect(html).toContain('最佳综合玩家');
    // 取 share 最高的两个：目标争夺 + 治疗（不是排在最前面的 combat）
    expect(html).toContain('目标争夺');
    expect(html).toContain('治疗');
    expect(html).not.toContain('主要来自：输出');
  });

  it('★★ 维度名表覆盖 sim 的全部 SCORE_DIMENSIONS', () => {
    /**
     * ★ 这条防的是「sim 加了一个维度，面板显示成一串英文 key」——
     *   那不会报错，只会让玩家看到 `disruption`。
     */
    const html = renderMatchSummary({
      rows: [row(1, '红甲')],
      awards: [{
        award: 'bestOverall', name: '最佳综合玩家',
        winnerId: asEntityId(1), winnerName: '红甲',
        parts: SCORE_DIMENSIONS.map((d) => ({ dimension: d, share: 1 })),
      }],
    });
    for (const d of SCORE_DIMENSIONS) {
      expect(html, `维度 ${d} 没有中文名，会以英文 key 显示给玩家`).not.toContain(`：${d}`);
    }
  });

  it('★ 玩家名里的尖括号被转义（名字来自玩家输入）', () => {
    const html = renderMatchSummary({ rows: [row(1, '<img src=x>')], awards: [] });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

/**
 * ★ 断言的是**纯函数**而不是 `KillFeed` 类：折叠逻辑刻意与 DOM 分开
 *   （本仓库没有 jsdom，而且「按时间倒序」这类判断本来就不该需要一个浏览器
 *   才能验）。类那一侧只是喂数据 + 画 innerHTML。
 */
describe('16a 死亡回顾的折叠', () => {
  const nameOf = (id: number): string => `玩家${id}`;
  const log = (at: number, over: Partial<DamageLog> = {}): DamageLog => ({
    at, sourceId: 1, amount: 100, crit: false, skillName: '火焰', ...over,
  });

  it('★ 只保留最近 RECAP_SECONDS 秒的伤害', () => {
    const logs = [log(0), log(RECAP_SECONDS + 1, { sourceId: 2, amount: 200 })];
    pruneRecap(logs, RECAP_SECONDS + 1);

    const rows = recapRowsFrom(logs, RECAP_SECONDS + 1, nameOf);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe(200);
  });

  it('★★ 按时间倒序 —— 补刀的那一发在最上面', () => {
    const rows = recapRowsFrom(
      [log(1), log(2, { sourceId: 2, amount: 300, crit: true })], 2.5, nameOf,
    );
    expect(rows[0]!.sourceName).toBe('玩家2');
    expect(rows[0]!.crit).toBe(true);
    expect(rows[0]!.secondsBefore).toBeCloseTo(0.5, 5);
  });

  it('★ 最多列 RECAP_MAX_ROWS 条（12v12 里 5 秒能吃到几十跳）', () => {
    const logs = Array.from({ length: RECAP_MAX_ROWS + 5 }, (_, i) => log(i * 0.1));
    expect(recapRowsFrom(logs, 1, nameOf)).toHaveLength(RECAP_MAX_ROWS);
  });

  it('★★ 来源不可见（sourceId 为空）时如实写「未知来源」，不编一个凶手', () => {
    // 验收 #5：被未被发现的潜行者打了一下，协议会抹掉 sourceId
    const rows = recapRowsFrom([log(0, { sourceId: undefined })], 0.2, nameOf);
    expect(rows[0]!.sourceName).toBe('未知来源');
  });

  it('★ 名字查不到时也是「未知来源」，不显示一个裸 id', () => {
    const rows = recapRowsFrom([log(0, { sourceId: 99 })], 0.2, () => undefined);
    expect(rows[0]!.sourceName).toBe('未知来源');
  });

  it('★ 窗口外的记录被整段丢掉（不是留着靠 slice 挡住）', () => {
    const logs = [log(0), log(0.1), log(0.2)];
    pruneRecap(logs, RECAP_SECONDS + 10);
    expect(logs, '过期记录没被回收 —— 一局下来这个数组会无限增长').toHaveLength(0);
  });
});
