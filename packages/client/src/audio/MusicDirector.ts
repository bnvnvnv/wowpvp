/**
 * W13（技术债总账）：BGM 随战斗状态切换 —— 速赢清单第 2 项。
 *
 * ★ 此前 19 首曲子只播 `combat_1` 一首、从开局响到结束：氛围曲全部闲置，
 *   「战斗开始了」这个最该有音乐语言的时刻没有任何变化。
 *
 * ★ 战斗判定的口径**分端**，各用各的最好来源：
 *   · 试验场读 sim 权威的 `CombatEntity.lastCombatAt`（M11 双向打标：
 *     打人与被打都算进战斗）—— 本地模拟就在手边，不用第二套判定
 *   · 联网读**收到的 Damage/Heal 消息**：`lastCombatAt` 是 sim 内部状态、
 *     不进快照，为一首 BGM 加协议字段不值得。本地口径偏保守
 *     （看得见的战斗才算），与「联网音效按可见事件播」同一条边界
 *
 * ★ 切换本身有滞后（脱战 8 秒才回氛围曲）+ AudioManager 的交叉淡化 ——
 *   贴脸拉扯时不会在两首曲子之间抽搐。
 */

import { audio } from './AudioManager.js';

/** 最后一次战斗事件后多少秒回氛围曲。比 8.2 的递减窗口短、比一次读条长 */
export const OUT_OF_COMBAT_SECONDS = 8;

/**
 * 每张图一首氛围曲。键是 `MapDef.id`，值是 `assets/music/music/` 下的文件名
 * （与昼夜 preset 同一类「地图 → 表现」映射，W15 同批的姊妹表）。
 */
export const MAP_AMBIENT_TRACK: Record<string, string> = {
  testbed: 'vale',
  tutorial: 'garden',
  arena_2v2: 'peaks',
  arena_3v3: 'peaks',
  arena_5v5: 'frost',
  ctf_twin_bridges: 'gale',
};

/** 没配的图回落到城镇曲 —— 不是静音：氛围缺席比选曲保守更伤 */
export const ambientTrackFor = (mapId: string | undefined): string =>
  (mapId !== undefined ? MAP_AMBIENT_TRACK[mapId] : undefined) ?? 'town_eastbrook';

export class MusicDirector {
  private lastCombatAt = -Infinity;
  private mode: 'ambient' | 'combat' | undefined;

  constructor(
    private readonly ambientTrack: string,
    private readonly combatTrack: string = 'combat_1',
  ) {}

  /** 登记一次战斗活动（取较大值 —— 时间不回退）*/
  noteCombat(at: number): void {
    if (at > this.lastCombatAt) this.lastCombatAt = at;
  }

  /** 当前应播哪首。纯函数出口，单测钉的就是它 */
  trackFor(now: number): string {
    return now - this.lastCombatAt < OUT_OF_COMBAT_SECONDS ? this.combatTrack : this.ambientTrack;
  }

  /** 每帧调。`playMusic` 自带同名忽略 + 交叉淡化，这里只管选曲 */
  update(now: number): void {
    const want = now - this.lastCombatAt < OUT_OF_COMBAT_SECONDS ? 'combat' : 'ambient';
    if (want === this.mode) return;
    this.mode = want;
    audio.playMusic(this.trackFor(now));
  }
}
