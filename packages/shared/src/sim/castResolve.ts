/**
 * 「一个技能完成时打谁」。规格书 5.4 / 5.6 / 7.4 步骤 6。
 *
 * ★ 这段逻辑在 M10 之前住在 `client/src/combat/CombatDirector.ts` 里 ——
 *   但它是**纯规则**，一行渲染代码都没有。留在客户端的后果是服务器要抄一遍，
 *   而抄的那一遍会和这一遍漂移（本项目已四次遇到同类问题）。
 *
 * ★★ **7.4 步骤 6 有一条极容易写错的规则，注释留在这里因为它已经错过一次：**
 *
 *   完成时必须用 **`CastState.targetId`**（施法开始时锁定的那个），
 *   **不能**回头去读 `caster.targets.hard`。
 *   M4 阶段就是从 `targets.hard` 重新取，导致没有硬目标的假人
 *   把技能打到了**自己**身上（回退到 `[caster]`）。
 *   「施法开始时锁定的是谁，完成时就结算给谁」——这也正是 7.4 的语义。
 */

import type { SkillDef } from '../data/schema.js';
import type { Vec3 } from '../math/vec3.js';
import {
  collectShapeTargets, needsGroundPlacement, scaleShape, shapeOrigin, usesNoTarget,
} from './aiming.js';
import type { CastState } from './casting.js';
import type { CombatEntity } from './entity.js';
import { getEntity, type World } from './world.js';

export interface CastTargets {
  targets: CombatEntity[];
  /** 地面技能的落点，透传给效果结算 */
  groundPoint?: Vec3;
  /**
   * 目标已离场。7.4 步骤 6：**不产生效果**。
   * ★ 单列成一个字段而不是「返回空数组」，是为了让调用方能区分
   *   「打了但没人在范围里」（合法，0 个目标）与「锁定的目标没了」（不结算）。
   */
  targetLost: boolean;
}

/**
 * 解算一次技能完成时的目标集合。
 *
 * 三条分流（5.4 六类瞄准最终归到这三种）：
 *   · 地面技能   → 以落点为原点收形状内的目标
 *   · 自身中心 / 纯自身 → 以施法者为原点（`shapeOrigin`）
 *   · 直接目标   → 用 CastState 锁定的那一个（见文件头的 ★★）
 */
export const resolveCastTargets = (
  world: World,
  caster: CombatEntity,
  skill: SkillDef,
  state: CastState | null,
  /**
   * W27 `SkillModifier.radiusMultiplier`：这把武器把这个技能的范围放大/缩小多少。
   *
   * ★ 由调用方算好一个数传进来（生产路径是 `tick.ts` 的 `weaponSkills`）——
   *   本文件是**纯规则**，查武器表要 `getWeapon()`，那会把 data 注册表拖进来。
   * ★ 不传或为 1 时 `scaleShape` 原样返回同一个形状对象：逐位不变、零分配。
   * ⚠️ **直接目标技能不受影响** —— 它根本不看形状（见文件头的 ★★ 与
   *   `party.test.ts` 里那条「形状会被忽略、退化成单体」）。
   */
  radiusScale = 1,
): CastTargets => {
  const groundPoint = state?.groundPoint;
  const shape = scaleShape(skill.shape, radiusScale);

  if (needsGroundPlacement(skill)) {
    const targets = groundPoint
      ? collectShapeTargets(world, caster, {
          origin: groundPoint, yaw: caster.yaw, shape, filter: skill.targetFilter,
        })
      : [];
    return { targets, targetLost: false, ...(groundPoint ? { groundPoint } : {}) };
  }

  if (usesNoTarget(skill)) {
    return {
      targets: collectShapeTargets(world, caster, {
        origin: shapeOrigin(caster, skill), yaw: caster.yaw,
        shape, filter: skill.targetFilter,
      }),
      targetLost: false,
    };
  }

  // ★★ 用锁定的目标，不是当前的硬目标。见文件头
  const locked = getEntity(world, state?.targetId);
  if (!locked) return { targets: [], targetLost: true };
  return { targets: [locked], targetLost: false };
};
