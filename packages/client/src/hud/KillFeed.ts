/**
 * 击杀播报与死亡回顾。docs/14 §16a。
 *
 * 两件事共用一个文件，因为它们吃的是**同一条消息流**（`Damage` + `Death`），
 * 只是折叠方式不同：
 *   · **播报** 是离散事件 → 横幅队列
 *   · **回顾** 是时间窗口 → 死亡瞬间回看最近 N 秒吃到的伤害
 *
 * ★★ **死亡回顾是 PVP 玩家改进自己的核心工具**：「我是怎么死的」这个问题，
 *   在没有回顾的情况下只能靠记忆回答，而人在被控住的 3 秒里记不住任何东西。
 *
 * ★ 与统计同源的做法：**纯折叠，不查询任何战斗状态**。本文件只消费传进来的
 *   消息，不持有 world、不读快照 —— 所以它算错了也不可能影响对局。
 */

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** 死亡回顾往回看多少秒。★ 与 stats 的助攻窗口（10 秒）不同：
 *  回顾要的是「杀死我的那一波」，10 秒会把上一次交火也算进来。 */
export const RECAP_SECONDS = 5;
/** 回顾最多列几条 —— 12v12 里 5 秒能吃到几十跳，列全等于没列 */
export const RECAP_MAX_ROWS = 6;

/** 一条播报 */
interface FeedItem {
  html: string;
  until: number;
}

/** 死亡回顾里的一行 */
export interface RecapRow {
  sourceName: string;
  skillName: string;
  amount: number;
  crit: boolean;
  /** 距死亡还有几秒 */
  secondsBefore: number;
}

export interface DamageLog {
  at: number;
  sourceId: number | undefined;
  amount: number;
  crit: boolean;
  skillName: string;
}

/**
 * 丢掉窗口外的记录。
 * ★ 从头切而不是 filter：消息按时间到达，前缀一定是最旧的。
 */
export const pruneRecap = (logs: DamageLog[], now: number): void => {
  const cutoff = now - RECAP_SECONDS;
  let drop = 0;
  while (drop < logs.length && logs[drop]!.at < cutoff) drop++;
  if (drop > 0) logs.splice(0, drop);
};

/**
 * 折叠出回顾的行。
 *
 * ★★ **纯函数，与 DOM 无关** —— 于是「按时间倒序」「最多几条」
 *   「来源不可见时写什么」这些判断可以被单测直接钉住，
 *   而不必靠人眼看截图。与 `sim/stats.ts` 是纯折叠同一条思路。
 *
 * 按时间**倒序**：最后一击在最上面 —— 玩家最想知道的是「谁补的刀」。
 */
export const recapRowsFrom = (
  logs: readonly DamageLog[],
  now: number,
  nameOf: (id: number) => string | undefined,
): RecapRow[] =>
  [...logs]
    .sort((a, b) => b.at - a.at)
    .slice(0, RECAP_MAX_ROWS)
    .map((d) => ({
      /**
       * ★ 来源可空是**协议的事实**（验收 #5：被未被发现的潜行者打了一下，
       *   `Damage.sourceId` 会被抹掉）。如实写「未知来源」，不编一个凶手 ——
       *   编出来的名字会让玩家去报复一个没打过他的人。
       */
      sourceName: d.sourceId === undefined ? '未知来源' : (nameOf(d.sourceId) ?? '未知来源'),
      skillName: d.skillName,
      amount: Math.round(d.amount),
      crit: d.crit,
      secondsBefore: Math.max(0, now - d.at),
    }));

export class KillFeed {
  private readonly feedEl: HTMLElement;
  private readonly recapEl: HTMLElement;

  private items: FeedItem[] = [];
  /** 自己最近吃到的伤害。★ 只留 `RECAP_SECONDS` 内的，不做无限增长 */
  private incoming: DamageLog[] = [];
  private recapUntil = 0;

  /** 连杀计数：同一个人连续击杀且中途没死过 */
  private streaks = new Map<number, number>();

  /** 播放一次连杀音效（升调由调用方按 streak 决定）。由场景接上 */
  onStreak: ((killerName: string, streak: number) => void) | undefined;

  constructor(container: HTMLElement) {
    this.feedEl = document.createElement('div');
    this.feedEl.id = 'kill-feed';
    container.appendChild(this.feedEl);

    this.recapEl = document.createElement('div');
    this.recapEl.id = 'death-recap';
    this.recapEl.style.display = 'none';
    container.appendChild(this.recapEl);
  }

  /**
   * 记一笔打到**自己**身上的伤害。
   *
   * ★ 只记自己的：回顾是「我怎么死的」，全场的伤害流没有用，
   *   而且在 12v12 里会让这个数组变成一个内存黑洞。
   */
  noteIncoming(now: number, log: Omit<DamageLog, 'at'>): void {
    this.incoming.push({ at: now, ...log });
    this.prune(now);
  }

  private prune(now: number): void {
    pruneRecap(this.incoming, now);
  }

  /**
   * 一次击杀。`killerName` 为空表示环境击杀（掉出地图、DoT 结算时来源已不可见）。
   *
   * ★ 来源可空是**协议的事实**，不是防御性编程：`Damage.sourceId` 可空正是
   *   为了「被看不见的人打了一下仍然要有反馈」（验收 #5 + 14.1）。
   *   播报这里如实写「阵亡」而不是编一个凶手。
   */
  pushKill(now: number, killerId: number | undefined, killerName: string | undefined,
           victimId: number, victimName: string): void {
    // 被杀的人连杀中断
    this.streaks.delete(victimId);

    let streak = 0;
    if (killerId !== undefined) {
      streak = (this.streaks.get(killerId) ?? 0) + 1;
      this.streaks.set(killerId, streak);
    }

    const text = killerName
      ? `${esc(killerName)} <i>击杀了</i> ${esc(victimName)}`
      : `${esc(victimName)} <i>阵亡</i>`;
    const streakTag = streak >= 2 ? ` <b class="kf-streak">${streak} 连杀</b>` : '';

    this.items.push({ html: `<div class="kf-item">${text}${streakTag}</div>`, until: now + 6 });
    // 只留最近 5 条 —— 12v12 团灭时刷屏会盖住画面
    if (this.items.length > 5) this.items.splice(0, this.items.length - 5);

    if (streak >= 2 && killerName) this.onStreak?.(killerName, streak);
  }

  /** 自己死了：把最近 5 秒的伤害摊开给玩家看 */
  showRecap(now: number): void {
    this.prune(now);
    const rows = this.recapRows(now);
    this.recapUntil = now + 8;
    this.recapEl.style.display = '';
    this.recapEl.innerHTML = `
      <div class="dr-title">你是怎么死的（最后 ${RECAP_SECONDS} 秒）</div>
      ${rows.length === 0
        ? '<div class="dr-empty">最后 5 秒没有吃到伤害</div>'
        : rows.map((r) => `
            <div class="dr-row${r.crit ? ' dr-crit' : ''}">
              <span class="dr-t">-${r.secondsBefore.toFixed(1)}s</span>
              <span class="dr-src">${esc(r.sourceName)}</span>
              <span class="dr-skill">${esc(r.skillName)}</span>
              <span class="dr-amt">${r.amount}${r.crit ? '!' : ''}</span>
            </div>`).join('')}`;
  }

  /** 委托给纯函数 —— 判断逻辑在那里，本类只负责喂数据与画 DOM */
  recapRows(now: number): RecapRow[] {
    return recapRowsFrom(this.incoming, now, (id) => this.nameOf?.(id));
  }

  /** id → 名字。由场景注入（它有快照）*/
  nameOf: ((id: number) => string | undefined) | undefined;

  /** 复活/新回合时清掉回顾与本人的伤害记录 */
  clearRecap(): void {
    this.recapEl.style.display = 'none';
    this.incoming.length = 0;
    this.recapUntil = 0;
  }

  render(now: number): void {
    this.items = this.items.filter((i) => i.until > now);
    this.feedEl.innerHTML = this.items.map((i) => i.html).join('');
    if (this.recapUntil > 0 && now > this.recapUntil) {
      this.recapEl.style.display = 'none';
      this.recapUntil = 0;
    }
  }

  hide(): void {
    this.feedEl.innerHTML = '';
    this.recapEl.style.display = 'none';
  }
}
