/**
 * 大乱斗派对道具专属的效果。目前只有一个：`borrowClassKit`（变身药水）。
 *
 * ★★ 加一个 kind 的判据是 11-contributing §4「现有 kind 确实表达不了」。
 *   「把技能栏整个换成另一个职业的」在既有 34 个 kind 里一个都表达不了 ——
 *   `shapeshift` 只发一个表现事件（见 displacement.ts），`applyAura` 改的是
 *   数值修正，都不碰 `availableSkills` 这条通道。
 *
 * ★ 这是**唯一**一个 import 数据注册表的效果处理器。理由：它要按职业 id
 *   取一整套技能与资源池，而那正是注册表的职责。别的处理器一律只吃
 *   `EffectDef` 里带来的数据 —— 想再开一个「读注册表」的处理器之前，
 *   先想想能不能把要的东西写进 EffectDef。
 */

import { ALL_CLASSES, getClass, getWeapon } from '../../data/index.js';
import type { Resource } from '../../types/enums.js';
import { asClassId, type ClassId } from '../../types/ids.js';
import { skillsAvailableWith } from '../entity.js';
import { nextRandom } from '../world.js';
import { registerEffect } from './registry.js';

/**
 * 从候选职业里掷一个。
 *
 * ★ 走**实体自己的**随机流（`nextRandom`），与暴击/闪避同一条纪律：
 *   一次新的掷骰不扰动别人的序列，整局仍由一个种子完全决定（world.ts §rng）。
 */
const rollClass = (
  entity: { rng: number },
  candidates: readonly ClassId[],
): ClassId | undefined => {
  if (candidates.length === 0) return undefined;
  const i = Math.min(candidates.length - 1, Math.floor(nextRandom(entity) * candidates.length));
  return candidates[i];
};

registerEffect('borrowClassKit', (ctx, e) => {
  const pool: ClassId[] = (e.classIds ?? ALL_CLASSES.map((c) => c.id)).filter(
    (id): id is ClassId => getClass(id) !== undefined,
  );
  const picked = rollClass(ctx.source, pool);
  const cls = picked === undefined ? undefined : getClass(picked);
  if (!cls) return;

  ctx.source.borrowedClassId = cls.id;
  /**
   * ★ 沿用当前手里的武器算可用技能 —— 借来的职业没有「你手上这把」的方案，
   *   于是 `skillsAvailableWith` 会给出「该职业除方案专属外的全部技能」，
   *   外加当前武器（可能是派对武装）自己授予的那个。这正是想要的：
   *   捡着山崩巨锤喝下药水的人，既有山崩一击，也有借来那一套。
   */
  ctx.source.availableSkills = skillsAvailableWith(
    cls, ctx.source.weaponId, getWeapon(ctx.source.weaponId),
  );

  /**
   * ★★ **资源池必须一起借。**
   *   战士借到法师的技能而身上只有怒气条，`canCast()` 会在
   *   `NotEnoughResource` 上把每一个技能都挡掉 —— 表现是「喝完药水
   *   技能栏换了，但一个都按不出来」，且没有任何报错。
   *
   * ★ 借来的池子直接给**满**，不给 `start`：这是一个派对道具，
   *   不是一次转职，让人先站着回 30 秒法力不叫好玩。
   * ★ 原来的资源**保留不删** —— 借来的身份还回去时（死亡/回合复位）
   *   不需要另写一段复原逻辑，本来的怒气条一直都在。
   */
  const regen = new Map<Resource, number>(ctx.source.resourceRegen);
  for (const r of cls.resources) {
    ctx.source.maxResources.set(r.resource, r.max);
    ctx.source.resources.set(r.resource, r.max);
    if (r.regenPerSecond > 0) regen.set(r.resource, r.regenPerSecond);
  }
  ctx.source.resourceRegen = regen;

  // 表现层据此播变身特效并把技能栏换掉（客户端读 handler 前缀）
  ctx.events.push({
    t: 'custom',
    handler: `borrowClassKit:${cls.id as string}`,
    sourceId: ctx.source.id,
  });
});

/** 供测试与客户端解析事件用：`borrowClassKit:<classId>` */
export const parseBorrowedClass = (handler: string): ClassId | undefined => {
  const [key, id] = handler.split(':');
  if (key !== 'borrowClassKit' || id === undefined) return undefined;
  return getClass(asClassId(id))?.id;
};
