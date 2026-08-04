/**
 * 对局中记分板（docs/14 速赢清单：「Tab 记分板 —— 快照数据现成」）。
 *
 * ★ 键位是 **O** 不是 Tab：Tab 从 M2 起就是 5.3 的循环选目标，占着不能动。
 *
 * ★★ 联网对局此前**没有任何比分显示** —— `Snapshot.match.score` 一直在发，
 *   但 `ModeHud` 只有试验场在喂（`renderCtf` 全仓库唯一调用点在 TestbedScene）。
 *   这块面板是联网侧第一次能看到比分。
 *
 * ★ 名单来源是快照里的可见实体 —— 潜行中的敌人**天然不在列表里**
 *   （验收 #5 的裁剪发生在快照层），所以这里不需要、也不可能开出
 *   「记分板偷看隐身者」的口子：数据根本没发过来。
 *
 * 与 ModeHud 同一套写法：纯 DOM、场景每帧喂数据、样式在 index.html。
 */

import { TEAM_BLUE, TEAM_RED, getClass, type ClassId, type TeamId } from '@wowpvp/shared';

export interface ScoreboardRow {
  name: string;
  classId: ClassId;
  team: TeamId;
  alive: boolean;
  /** 0..1。死亡时显示为 0 */
  healthPct: number;
  /** 自己那行高亮 */
  isSelf: boolean;
}

export interface ScoreboardData {
  /** 面板标题（「夺旗战场」/「竞技场」）*/
  modeLabel: string;
  scoreRed: number;
  scoreBlue: number;
  rows: readonly ScoreboardRow[];
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export class Scoreboard {
  private readonly el: HTMLDivElement;
  private shown = false;

  constructor(container: HTMLElement) {
    this.el = document.createElement('div');
    this.el.id = 'scoreboard';
    this.el.style.display = 'none';
    container.appendChild(this.el);
  }

  get visible(): boolean {
    return this.shown;
  }

  toggle(): boolean {
    this.shown = !this.shown;
    if (!this.shown) this.el.style.display = 'none';
    return this.shown;
  }

  hide(): void {
    this.shown = false;
    this.el.style.display = 'none';
  }

  /** 每帧调用。不可见时零开销（不碰 DOM）*/
  render(d: ScoreboardData): void {
    if (!this.shown) return;
    this.el.style.display = '';

    const column = (team: TeamId): string => {
      const rows = d.rows.filter((r) => r.team === team);
      if (rows.length === 0) return '<div class="sb-empty">—</div>';
      return rows
        .map((r) => {
          const cls = getClass(r.classId)?.name ?? (r.classId as string);
          const hp = r.alive ? `${Math.round(r.healthPct * 100)}%` : '阵亡';
          return `<div class="sb-row ${r.alive ? '' : 'dead'} ${r.isSelf ? 'self' : ''}">
            <span class="sb-name">${esc(r.name)}</span>
            <span class="sb-class">${esc(cls)}</span>
            <span class="sb-hp">${hp}</span>
          </div>`;
        })
        .join('');
    };

    this.el.innerHTML = `
      <div class="sb-title">${esc(d.modeLabel)}</div>
      <div class="sb-score">
        <span class="team red">${d.scoreRed}</span>
        <span class="sb-vs">:</span>
        <span class="team blue">${d.scoreBlue}</span>
      </div>
      <div class="sb-columns">
        <div class="sb-col red">${column(TEAM_RED)}</div>
        <div class="sb-col blue">${column(TEAM_BLUE)}</div>
      </div>
      <div class="sb-hint">O 关闭</div>
    `;
  }
}
