/**
 * M12：把战斗事件接到音效上。
 *
 * ★★ **这个文件是单向的：读事件 → 播声音。** 它不返回任何东西给战斗系统，
 *   也不持有可变的战斗状态 —— 所以「音效改变了对局」在结构上不可能发生。
 *   与 `stats.ts` 是事件流的纯折叠同一个思路。
 *
 * ★ 8.x 要求命中反馈能区分「伤害 / 治疗 / 格挡 / 闪避 / 免疫 / 驱散」，
 *   `CombatEvent` 的 `avoided` 与 `immune` 字段正好承载这个区分 ——
 *   六种结果六种声音，而不是「打中了就一声闷响」。
 */

import type { CombatEvent, EntityId, School, SkillDef, Vec3 } from '@wowpvp/shared';
import { CastKind, distance2D } from '@wowpvp/shared';
import type { AudioManager } from './AudioManager.js';

export interface CombatAudioDeps {
  /** 听者（玩家）的位置，用于距离衰减 */
  listener: () => Vec3;
  /** 某个实体现在在哪。找不到时返回 undefined → 该事件不做距离衰减 */
  positionOf: (id: EntityId) => Vec3 | undefined;
  /** 玩家自己的实体 id —— 自己的事件不衰减，且用「更贴耳」的音量 */
  selfId: () => EntityId;
}

/** 事件发生地到听者的距离；拿不到位置时返回 undefined（= 不衰减） */
const distanceFor = (deps: CombatAudioDeps, id: EntityId | undefined): number | undefined => {
  if (id === undefined) return undefined;
  const at = deps.positionOf(id);
  return at ? distance2D(at, deps.listener()) : undefined;
};

export const playCombatEvent = (
  audio: AudioManager,
  deps: CombatAudioDeps,
  ev: CombatEvent,
): void => {
  const self = deps.selfId();

  switch (ev.t) {
    /**
     * ★ `damage` 不在这里 —— 打击感改造后，伤害的音效（基础命中 + 暴击/
     *   重击/规避的分层）由 `feedback/HitFeedback.ts` 统一编排，与浮字/
     *   闪白/震动/顿帧同一处定序。两处都播会叠成双响。
     *   本函数保留其余与分档无关的分支。
     */
    case 'heal': {
      if (ev.amount === 0) break;
      const dist = ev.targetId === self ? 0 : distanceFor(deps, ev.targetId);
      audio.play('heal_impact', dist === undefined ? {} : { distance: dist });
      break;
    }

    case 'auraApplied': {
      const dist = ev.targetId === self ? 0 : distanceFor(deps, ev.targetId);
      const opts = dist === undefined ? {} : { distance: dist };
      audio.play(ev.auraKind === 'buff' ? 'buff_apply' : 'debuff_apply', { ...opts, volume: 0.6 });
      break;
    }

    case 'shieldBroken':
      // 14.3：护盾破裂要单独提示，不能和普通受击混在一起
      audio.play('impact_frost', {
        ...(ev.targetId === self ? {} : { distance: distanceFor(deps, ev.targetId) ?? 0 }),
        rate: 1.25,
      });
      break;

    case 'dispelled':
      audio.play('ui_gather_epic', { volume: 0.55, distance: distanceFor(deps, ev.targetId) ?? 0 });
      break;

    case 'death':
      // 自己死了是主观事件（不衰减、音量满），别人死了按距离
      if (ev.targetId === self) audio.playVariant('death', { volume: 1 });
      else audio.playVariant('death', { distance: distanceFor(deps, ev.targetId) ?? 0, volume: 0.7 });
      break;

    case 'interrupt':
      // 7.2：打断成功与落空是两件事 —— 落空也进冷却，玩家必须听得出区别
      audio.play(ev.success ? 'ui_error' : 'ui_click', {
        group: 'ui',
        volume: ev.success ? 0.9 : 0.4,
      });
      break;

    case 'displaced':
      audio.playVariant('jump', { distance: distanceFor(deps, ev.targetId) ?? 0, volume: 0.5 });
      break;

    default:
      // resource / immune / auraRemoved / custom 没有专属音效 —— 刻意留空。
      // ★ 不给「每个事件都得有声音」让步：无差别的音效反而盖住有信息量的那些
      break;
  }
};

/** 施法生命周期的音效（7.4） */
export const playCastActivity = (
  audio: AudioManager,
  deps: CombatAudioDeps,
  kind: 'started' | 'resolved' | 'interrupted' | 'failed',
  casterId: EntityId,
  skill: SkillDef | undefined,
): void => {
  if (!skill) return;
  const isSelf = casterId === deps.selfId();
  const dist = isSelf ? 0 : distanceFor(deps, casterId);
  const opts = dist === undefined ? {} : { distance: dist };

  switch (kind) {
    case 'started':
      // ★ 只有读条/引导有「起手」声。瞬发技能在 resolved 时才响，
      //   否则一个瞬发会响两声（起手 + 命中），听上去像卡了一下
      if (skill.cast.kind !== CastKind.Instant) {
        audio.playCast(skill.school, { ...opts, volume: 0.7 });
      }
      break;
    case 'resolved':
      audio.playCast(skill.school, opts);
      break;
    case 'interrupted':
      audio.play('ui_error', { group: 'ui', volume: isSelf ? 0.9 : 0.5, ...opts });
      break;
    case 'failed':
      // 只有**自己**按了没放出来才需要提示音；别人失败是旁观信息，日志够了
      if (isSelf) audio.play('ui_error', { group: 'ui', volume: 0.5 });
      break;
  }
};
