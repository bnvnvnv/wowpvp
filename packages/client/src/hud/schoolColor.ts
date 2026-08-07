/**
 * 14.2 八属性视觉语言在 HUD 里的颜色。
 *
 * ★ 从 `CombatHud.ts` 拆出来只有一个理由：tooltip 模块（`skillTooltip.ts`）
 *   也要用它，而 `CombatHud` 反过来要用 tooltip —— 留在原处就是一个
 *   循环 import。一张常量表不值得为它引一个循环。
 *   `CombatHud.ts` 仍然把它再导出一次，老的导入路径不受影响。
 *
 * ⚠️ 这是 **HUD 的 CSS 颜色**，与 `vfx/schools.ts` 的 3D 材质色（number）
 *   不是同一份数据也不该合并：那边有八项（多一个「毒素」视觉属性），
 *   这边只有 `School` 的七项，合并会把「毒素不是学派」这条结论搅浑。
 */

import type { School } from '@wowpvp/shared';

export const SCHOOL_COLOR: Record<School, string> = {
  physical: '#d8cbb4',
  holy: '#ffe9a8',
  fire: '#ff8a4c',
  frost: '#8fd4ff',
  arcane: '#c39bff',
  shadow: '#a172c9',
  nature: '#8fe08a',
  // 上面七项已覆盖 School 全部成员
} as Record<School, string>;
