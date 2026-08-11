/**
 * X29：**「画面上是不是小鸡」的客户端唯一入口**（8.2 迷惑 / 规格 14.3）。
 *
 * ★★ **为什么要有这个文件。** 换小动物模型这件事此前有**两份判据**：
 *   · 试验场手里有 `AuraDef`，按「递减类别 Incapacitate + `flags.stunned`」判；
 *   · 联网侧手里只有快照的 `auraId`，于是拿它跟**一个字面常量**
 *     （`'control.incapacitate'`）比。
 *   两者对**用 `applyControl` 施加的**化形术、寒霜陷阱是一致的，对**自带
 *   光环 id** 的气旋囚笼（`druid.cyclone`，同样是 Incapacitate + stunned）
 *   当场分家：试验场是小鸡，联网局是**人形角色边走边晃头**
 *   —— sim 那边按递减类别判「该游走」，所以他还在走；
 *   `CharacterView.applyStunWobble` 的摇头否决又只否决小鸡，所以他还在晃。
 *   一个「无法行动、不能被打也不能被治」的人在场上边散步边晃头。
 *
 * ★ 现在两个场景都问这里，判据本体在 sim（`isMorphedFormAura`）——
 *   规则与表现同源，这正是 `wander.ts` 头注承诺过、但联网侧没兑现的那条。
 *
 * ★ **两条反查路径，一条判据**：
 *   · `control.<kind>` 是 sim 施加控制时改写出来的合成 id，技能数据里没有 ——
 *     由 shared 的 `CONTROL_AURA_FORMS` 反查（它从 `CONTROL_SPECS` 派生）。
 *   · 其余光环（气旋囚笼这种自带 id 的）走客户端那张 `auraDefById` 索引。
 *   查不到 = 不是化形（S7 掩码光环也走这条：掩掉的东西不该反推出模型变化）。
 */

import { CONTROL_AURA_FORMS, isMorphedFormAura, type AuraDef } from '@wowpvp/shared';

import { auraDefById } from '../vfx/debuffAura.js';

/** 快照/HUD 侧能给出的最小形状 —— 只要 id */
export interface MorphAuraLike {
  auraId: string;
}

/** `auraId` → 判形态需要的那两个字段。查不到返回 undefined */
export const morphFormOfAuraId = (
  auraId: string,
): Pick<AuraDef, 'drCategory' | 'flags'> | undefined =>
  CONTROL_AURA_FORMS.get(auraId) ?? auraDefById(auraId);

/**
 * 这一份**快照光环表**里有把人变成小动物的那一枚吗？
 * ★ 联网场景（自己 + 远端）的入口。本地 sim 侧手里有 `AuraDef`，
 *   直接调 `isMorphedFormAura(def)` —— 同一条判据，少一次反查。
 */
export const isMorphedByAuraIds = (auras: readonly MorphAuraLike[]): boolean =>
  auras.some((a) => {
    const form = morphFormOfAuraId(a.auraId);
    return form !== undefined && isMorphedFormAura(form);
  });
