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

import type { CombatEvent, EntityId, SkillDef, Vec3 } from '@wowpvp/shared';
import { CastKind, distance2D } from '@wowpvp/shared';
import type { AudioManager } from './AudioManager.js';
import { resolveSignature } from '../av/skillSignature.js';

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
      /**
       * 7.2：打断成功与落空是两件事 —— 落空也进冷却，玩家必须听得出区别。
       *
       * ★★ 此前**成功**播的是 `ui_error`、落空播 `ui_click`，于是同一声
       *   `ui_error` 同时代表三件语义相反的事：「我打断成功了」（好）、
       *   「我被打断了」（坏）、「我按了没放出来」（坏）。耳朵学不会这种编码 ——
       *   玩家只能回头去看日志，而反制链恰恰是没空看日志的那几秒。
       *
       *   现在三件事三种声音（都在 AudioManager 已注册的变体组里，素材确实存在）：
       *   · 打断**成功** → `metal`（金属撞击）：一记硬碰硬的「截住了」。
       *   · 打断**落空** → `swing`（挥空的破空声）：字面意义上的打了个空。
       *   · 被打断 / 施法失败 → 仍是 `ui_error`（见 playCastActivity）。
       *
       * ⚠️ `metal` 也是格挡的叠加层、`swing` 也是普攻挥砍音 —— AudioManager 的
       *   40ms 同名去重会让「打断落在一次格挡/挥砍的同 40ms 内」少响一声。
       *   接受它：这两个事件本来就同源于「兵器相交」，而备选是继续共用错的那一声。
       */
      if (ev.success) audio.playVariant('metal', { volume: 0.9 });
      else audio.playVariant('swing', { volume: 0.45 });
      break;

    case 'displaced':
      audio.playVariant('jump', { distance: distanceFor(deps, ev.targetId) ?? 0, volume: 0.5 });
      break;

    case 'auraRemoved':
      /**
       * P3：**只有饰品解控**发声，其余 auraRemoved 保持刻意留空（见 default）。
       * ★ 为什么值得开这个口子：P5 起「什么时候交饰品」是每回合最重的决策
       *   之一，而它此前完全无声 —— 按了有没有生效只能盯图标。声音走
       *   common.ts 的 'trinket' 签名（buff_apply 变速），改音色只动那张表。
       */
      if (ev.reason === 'trinket') {
        const sig = resolveSignature('trinket');
        if (sig.castSound) {
          audio.play(sig.castSound, {
            rate: sig.castRate,
            distance: distanceFor(deps, ev.targetId) ?? 0,
            volume: 0.9,
          });
        }
      }
      break;

    default:
      // resource / immune / custom 没有专属音效 —— 刻意留空。
      // ★ 不给「每个事件都得有声音」让步：无差别的音效反而盖住有信息量的那些
      break;
  }
};

/**
 * 「自己按了没放出来」的提示音节流，毫秒。
 *
 * ★ 占位值 300ms：AudioManager 自己的 40ms 同名去重是为「AOE 一帧命中 5 个人」
 *   设的，挡不住人手连按 —— 资源不足时按 8 次就是 8 声 `ui_error`（间隔远大于
 *   40ms），听上去像系统坏了。300ms 取自「人连按的舒适上限约 3–5 次/秒」，
 *   比它略长一点即可让一串连按只响一声，又不至于吞掉两次**分开的**误操作。
 * ⚠️ 刻意**不动** AudioManager 的 40ms 全局去重：那是所有音效共用的参数，
 *   为一个 UI 提示音改它会顺带闷掉多目标命中的层次。
 */
const SELF_FAIL_THROTTLE_MS = 300;
/**
 * ★ 模块级可变状态，本文件唯一的一处。放这里而不是塞进 deps，是因为它是
 *   **纯表现的节流**，不该出现在任何调用方的接口里（本文件对玩法只读，
 *   见文件头）。用 `Date.now()` 而不是 world.time：节流的是**人手的节奏**，
 *   与模拟时间无关（暂停、慢放时人照样在连按）。
 */
let lastSelfFailSoundAt = -Infinity;

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
        audio.playCastFor(skill, { ...opts, volume: 0.7 });
      }
      break;
    case 'resolved':
      /**
       * ★ P3：`playCast(school)` → `playCastFor(skill)`。
       *   试验场这条路径**本来就握着完整的 `SkillDef`**（`onCastActivity` 的
       *   第三个参数），此前却只把 `school` 一个字段递下去 —— 于是同一个学派的
       *   十几个技能共用一声。这里不需要给任何上游加参数：id 一直在手里。
       * ⚠️ `interrupted` / `failed` 两支刻意仍走 `play('ui_error')`：
       *   它们说的是「这次施法没成」，不是「这是什么技能」，给它们签名
       *   等于让失败提示随技能变声，玩家反而学不会这一声。
       */
      audio.playCastFor(skill, opts);
      break;
    case 'interrupted':
      audio.play('ui_error', { group: 'ui', volume: isSelf ? 0.9 : 0.5, ...opts });
      break;
    case 'failed': {
      // 只有**自己**按了没放出来才需要提示音；别人失败是旁观信息，日志够了
      if (!isSelf) break;
      const now = Date.now();
      if (now - lastSelfFailSoundAt < SELF_FAIL_THROTTLE_MS) break;
      lastSelfFailSoundAt = now;
      audio.play('ui_error', { group: 'ui', volume: 0.5 });
      break;
    }
  }
};
