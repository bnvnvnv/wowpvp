/**
 * 八属性视觉语言。规格书 14.2。
 *
 * ★★ 14.2 的表有**八**行，而 `School` 枚举只有**七**个成员 ——
 *    多出来的那个是「毒素」。
 *
 *    这不是数据漏了一项。规格书里「毒素」从来不是伤害学派：
 *    7.2 的学派锁定、8.4 的免疫都只谈魔法/物理，
 *    毒素只出现在 8.4 的**驱散类型**（「魔法、诅咒、毒素或移动限制」）
 *    和 14.2 的**视觉语言**里。
 *
 *    所以这里把两件事分开：
 *      · `School`（7 项）—— 伤害学派，决定学派锁定与免疫，属于 shared 规则层
 *      · `VisualAttribute`（8 项）—— 只决定长什么样，属于客户端表现层
 *
 *    ⚠️ 千万**不要**为了凑齐 14.2 而往 `School` 里加 Poison ——
 *    那会让毒刃产生一个「毒素学派锁定」，凭空多出一条规格书没有的规则。
 *    已登记为 docs/10 的 Q12。
 */

import { School, asSkillId, getSkill, type SkillDef } from '@wowpvp/shared';

/** 14.2 的八项视觉属性 */
export const VisualAttribute = {
  Fire: 'fire',
  Frost: 'frost',
  Arcane: 'arcane',
  Shadow: 'shadow',
  Holy: 'holy',
  Nature: 'nature',
  Physical: 'physical',
  /** ★ 不是 School 的成员，见文件头 */
  Poison: 'poison',
} as const;
export type VisualAttribute = (typeof VisualAttribute)[keyof typeof VisualAttribute];

export interface AttributeVisual {
  /** 14.2「颜色」列。主色用于主体，辅色用于高光与描边 */
  primary: number;
  secondary: number;
  /** 14.2「形状与运动」列。原文照抄，供 review 时逐条比对 */
  motion: string;
  /**
   * 装饰粒子的形状键。渲染层按它选几何体；
   * 低画质下装饰粒子会被 quality.ts 过滤掉，但主体颜色不受影响。
   */
  particle: 'ember' | 'snowflake' | 'rune' | 'smoke' | 'beam' | 'leaf' | 'spark' | 'droplet';
  /** 17.2 可访问性：不能只靠颜色区分，每种属性还有一个形状标记 */
  glyph: string;
}

/**
 * 14.2 的表，逐行落成数据。
 *
 * `Record<VisualAttribute, …>` 保证**八项一个都不能少** ——
 * 少一项就是编译错误，不会出现「毒素技能没有视觉」这种要靠玩到才发现的洞。
 */
export const ATTRIBUTE_VISUALS: Record<VisualAttribute, AttributeVisual> = {
  fire: {
    primary: 0xff8a4c,
    secondary: 0xffd54a,
    motion: '火舌、余烬、热浪、焦痕',
    particle: 'ember',
    glyph: '🜂',
  },
  frost: {
    primary: 0x8fd4ff,
    secondary: 0xeaf6ff,
    motion: '冰晶、霜雾、雪花、冻结底座',
    particle: 'snowflake',
    glyph: '❄',
  },
  arcane: {
    primary: 0xc39bff,
    secondary: 0x7b6cff,
    motion: '符文、几何轨迹、空间波纹',
    particle: 'rune',
    glyph: '◆',
  },
  shadow: {
    primary: 0x6b3f8f,
    secondary: 0x8f2b3f,
    motion: '烟雾、扭曲、灵魂丝线',
    particle: 'smoke',
    glyph: '☾',
  },
  holy: {
    primary: 0xffd98a,
    secondary: 0xfff6e0,
    motion: '光柱、圆形符文、护盾',
    particle: 'beam',
    glyph: '✦',
  },
  nature: {
    primary: 0x8fe08a,
    secondary: 0xbdf3e6,
    motion: '叶片、藤蔓、水波、月光',
    particle: 'leaf',
    glyph: '❧',
  },
  physical: {
    primary: 0xd8cbb4,
    secondary: 0xa8926b,
    motion: '刀光、火花、尘土、冲击线',
    particle: 'spark',
    glyph: '⚔',
  },
  poison: {
    primary: 0xb6d442,
    secondary: 0x4f7a1f,
    motion: '液滴、细雾、刀刃附着',
    particle: 'droplet',
    glyph: '☣',
  },
};

/** 七个伤害学派各自对应的视觉属性。这一半是恒等映射 */
const SCHOOL_TO_VISUAL: Record<School, VisualAttribute> = {
  physical: VisualAttribute.Physical,
  holy: VisualAttribute.Holy,
  fire: VisualAttribute.Fire,
  frost: VisualAttribute.Frost,
  arcane: VisualAttribute.Arcane,
  shadow: VisualAttribute.Shadow,
  nature: VisualAttribute.Nature,
};

/**
 * 一个技能该用哪套视觉。
 *
 * 规则：**先看是不是毒**，再退回学派。
 * 毒刃的学派是 physical（它是一次匕首攻击，被物理免疫挡），
 * 但玩家该看到的是黄绿色的刀刃附着而不是钢铁色的刀光 —— 14.2 的表这么写的。
 */
export const visualAttributeOf = (skill: SkillDef): VisualAttribute =>
  isPoisonSkill(skill) ? VisualAttribute.Poison : SCHOOL_TO_VISUAL[skill.school];

/**
 * 是否是「毒」类技能：施加的光环里有任何一个按毒素驱散。
 *
 * 用驱散类型判定而不是给技能加个 `isPoison` 标记 —— 因为
 * 「能被解毒术移除」正是玩家理解的「这是毒」，两者天然同源，
 * 不会出现「看起来是毒但解毒解不掉」的割裂。
 */
export const isPoisonSkill = (skill: SkillDef): boolean =>
  skill.effects.some(
    (e) => e.kind === 'applyAura' && e.aura.dispelType === 'poison',
  );

export const visualOf = (skill: SkillDef): AttributeVisual =>
  ATTRIBUTE_VISUALS[visualAttributeOf(skill)];

/**
 * 光环 id 的属性视觉。
 *
 * 约定：光环 id 是 `<class>.<skill>` 或 `<class>.<skill>.<名>`，取前两段查回技能。
 * ★ 护盾光环的 id **就是技能 id**（`mage.ice_barrier` / `priest.power_word_shield`），
 *   所以冰盾是冰蓝、护心屏障是圣金 —— 此前护盾壳写死一个金色，
 *   八职业的盾长得一模一样。
 * ★ 查不回技能的（`control.*` 这类系统光环）返回 undefined，由调用方决定
 *   退到什么 —— 编一个颜色比不画更糟。
 */
export const visualForAuraId = (auraId: string): AttributeVisual | undefined => {
  const skill = getSkill(asSkillId(auraId.split('.').slice(0, 2).join('.')));
  return skill ? visualOf(skill) : undefined;
};

/**
 * 只按**伤害学派**取视觉属性（不含毒素判定）。
 *
 * ★ 用途：命中类战斗事件（`CombatEvent` 的 `damage`）只带 `school`，**不带 skillId** ——
 *   多目标瞬发伤害在 sim 里是「一次结算多个目标」，事件里没有技能引用可查。
 *   所以命中爆发的属性色只能退到学派。
 *
 * ★ 保真度取舍：**毒刃**的学派是 physical，用本函数会得到钢铁色而非黄绿。
 *   但飞行体与释放/落地爆发走的是 `visualOf(skill)`（有 skillId，毒感知），
 *   而毒类技能基本都是近战/投射物，命中爆发由那条路径覆盖 —— 真正落到本函数
 *   的是「奥术冲击波」这类无 skillId 的瞬发学派伤害，用学派色恰好正确。
 */
/** 某学派的 `AttributeVisual`（命中爆发用）*/
export const visualForSchool = (school: School): AttributeVisual =>
  ATTRIBUTE_VISUALS[SCHOOL_TO_VISUAL[school]];

// ── P3 技能签名：色相偏移 ──────────────────────────────────────

/**
 * 0xRRGGBB → 色环位置（0..1）。灰度色（S=0）返回 0。
 * ★ 导出是为了让测试能直接钉「偏移量恰好等于 tintShift」——
 *   不导出的话只能拿 RGB 反推，断言会变成一句约等于。
 */
export const hueOf = (color: number): number => {
  const r = ((color >> 16) & 0xff) / 255;
  const g = ((color >> 8) & 0xff) / 255;
  const b = (color & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  const h =
    max === r ? ((g - b) / d + (g < b ? 6 : 0))
      : max === g ? (b - r) / d + 2
        : (r - g) / d + 4;
  return h / 6;
};

/** 色环上两点的最短距离（0..0.5）。0.98 与 0.02 相差 0.04 而不是 0.96 */
export const hueDistance = (a: number, b: number): number => {
  const d = Math.abs(((a % 1) + 1) % 1 - ((b % 1) + 1) % 1);
  return Math.min(d, 1 - d);
};

/**
 * 沿色环旋转一个颜色，**只动色相，饱和度与明度逐位不变**。
 *
 * ★★ 「只动 H」不是实现偷懒，是 14.2「八属性一眼可辨」的守门规则：
 *   八属性里有两对基色的**色相几乎相同**（神圣 40.5° vs 物理 38.3°、
 *   奥术 264° vs 暗影 273°），把它们分开的从来不是色相而是
 *   **饱和度与明度**（物理是低饱和的沙色、神圣是高明度的暖金）。
 *   所以签名偏移一旦碰 S/L，代价不是「颜色变了一点」，而是
 *   **神圣技能可能褪成物理色** —— 那是打穿 14.2 的硬承诺。
 *   色相则是各属性内部富余的通道：转 ±28.8°（TINT_CLAMP ±0.08 色环）
 *   仍在自己那一族的色域里，够 117 个技能各自不同。
 *
 * ⚠️ 本函数**不做钳位** —— `resolveSignature` 已经把 tintShift 夹进
 *   ±TINT_CLAMP 了，这里再夹一次会让「地基钳位失效」这种 bug 藏起来。
 *   调用方必须传已解析的签名值。
 */
export const hueShifted = (color: number, shift: number): number => {
  if (shift === 0) return color;
  const r = ((color >> 16) & 0xff) / 255;
  const g = ((color >> 8) & 0xff) / 255;
  const b = (color & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return color; // 灰度色没有色相可转
  const l = (max + min) / 2;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = (((hueOf(color) + shift) % 1) + 1) % 1;

  // HSL → RGB（标准公式，逐通道）
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const chan = (t: number): number => {
    const x = ((t % 1) + 1) % 1;
    const v =
      x < 1 / 6 ? p + (q - p) * 6 * x
        : x < 1 / 2 ? q
          : x < 2 / 3 ? p + (q - p) * (2 / 3 - x) * 6
            : p;
    return Math.min(255, Math.max(0, Math.round(v * 255)));
  };
  return (chan(h + 1 / 3) << 16) | (chan(h) << 8) | chan(h - 1 / 3);
};

/**
 * 把一套属性视觉整体做色相偏移 —— P3 技能签名的**颜色身份**。
 *
 * ★ 主色与辅色转**同一个角度**：两者的色相差是这套属性的内部结构
 *   （火的橙核 + 黄边），分别转会把结构拧坏。
 * ★ `particle` / `glyph` / `motion` 一位不动 —— 17.2 的「不能只靠颜色」
 *   靠的就是这三条非颜色通道，签名不许动它们。
 */
export const tintedVisual = (av: AttributeVisual, shift: number): AttributeVisual =>
  shift === 0
    ? av
    : { ...av, primary: hueShifted(av.primary, shift), secondary: hueShifted(av.secondary, shift) };

/** 转成 CSS 颜色串，供 HUD 使用。HUD 与 3D 特效共用同一张表 */
export const cssColor = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;

/** HUD 用的学派配色（15.2 施法条要显示学派）*/
export const schoolCss = (school: School): string =>
  cssColor(ATTRIBUTE_VISUALS[SCHOOL_TO_VISUAL[school]].primary);
