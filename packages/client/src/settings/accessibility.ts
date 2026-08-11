/**
 * 可访问性设置。规格书 17.2。
 *
 * 17.2 有三句，性质各不相同：
 *
 *   1.「全部按键可重绑；支持色盲模式、界面缩放、减弱镜头震动和降低特效。」
 *      → 一批**设置项**。本文件负责。
 *   2.「危险区域不能只依赖颜色；配合边框、形状、动画和声音。」
 *      → 一条**否定式规则**。M3 的 GroundIndicator（虚线 + 叉号 + 变暗）
 *        与 M8 的 vfx/status.ts（字形表）已经做到了。★ 本文件的责任是
 *        **不提供任何能把它关掉的开关** —— 见下面 `AccessibilitySettings` 的注释。
 *   3.「伤害数字、屏幕闪烁、武器粒子和姓名板密度可**单独**调整。」
 *      → 四个**互相独立**的开关，不能塞进一个「特效强度」滑条里。
 *
 * ★ 键位重绑不在这里 —— 它从 M1 起就在 `input/InputManager.ts`
 *   的 `DEFAULT_BINDINGS` + `rebind()` 里，本来就是数据驱动的。
 *   把它复制一份到设置对象里只会产生两个真相来源。
 */

import {
  QUALITY_ORDER,
  isVisible,
  type DecorativeRole,
  type QualityTier,
  type VisualRole,
} from '../render/quality.js';

// ════════════════════════════════════════════════════════════════
//  色盲模式
// ════════════════════════════════════════════════════════════════

/**
 * 色盲模式。三种最常见的类型 + 关闭。
 *
 * ★ 这里刻意**不叫**「高对比模式」之类的笼统名字：
 *   不同类型需要的是不同的色相重映射，一个「更鲜艳」的开关解决不了问题。
 */
export const ColorblindMode = {
  Off: 'off',
  /** 红色弱（最常见，约占男性 1%）*/
  Protanopia: 'protanopia',
  /** 绿色弱（约占男性 1%）*/
  Deuteranopia: 'deuteranopia',
  /** 蓝黄色弱（罕见）*/
  Tritanopia: 'tritanopia',
} as const;
export type ColorblindMode = (typeof ColorblindMode)[keyof typeof ColorblindMode];

/**
 * 敌我与状态的语义色。
 *
 * ★ 只重映射**色相**，不改变亮度关系 —— 因为亮度是第二条通道：
 *   14.2 的八属性视觉语言里，属性靠色相区分，敌我靠亮度与形状区分。
 *   把两者都改掉会让色盲模式修好一个问题、制造另一个。
 */
export interface SemanticPalette {
  hostile: string;
  friendly: string;
  neutral: string;
  /** 危险区域/非法落点 */
  danger: string;
  /** 己方旗帜 */
  ownFlag: string;
  enemyFlag: string;
}

const BASE_PALETTE: SemanticPalette = {
  hostile: '#e5484d',
  friendly: '#30a46c',
  neutral: '#f5d90a',
  danger: '#e5484d',
  ownFlag: '#e5484d',
  enemyFlag: '#3e63dd',
};

/**
 * 各色盲模式下的替代色。
 *
 * 取值原则：红/绿这一对最容易混，所以红→橙、绿→蓝青 ——
 * 换成**蓝黄轴**上的两端，因为红绿色盲的蓝黄辨别是正常的。
 * 蓝黄色弱（Tritanopia）反过来，改用红绿轴。
 */
const PALETTES: Record<ColorblindMode, SemanticPalette> = {
  [ColorblindMode.Off]: BASE_PALETTE,
  [ColorblindMode.Protanopia]: {
    hostile: '#ee8a2e', friendly: '#2aa7c4', neutral: '#f5d90a',
    danger: '#ee8a2e', ownFlag: '#ee8a2e', enemyFlag: '#1f4bd8',
  },
  [ColorblindMode.Deuteranopia]: {
    hostile: '#f0770a', friendly: '#0f9bd7', neutral: '#f5d90a',
    danger: '#f0770a', ownFlag: '#f0770a', enemyFlag: '#2b4acb',
  },
  [ColorblindMode.Tritanopia]: {
    hostile: '#e5484d', friendly: '#3fa34d', neutral: '#c05cd6',
    danger: '#e5484d', ownFlag: '#e5484d', enemyFlag: '#3fa34d',
  },
};

export const paletteFor = (mode: ColorblindMode): SemanticPalette => PALETTES[mode];

// ════════════════════════════════════════════════════════════════
//  设置项
// ════════════════════════════════════════════════════════════════

/** 界面缩放的允许区间。低于 0.8 的字号在 1080p 上已经不可读 */
export const UI_SCALE_MIN = 0.8;
export const UI_SCALE_MAX = 2.0;

/**
 * 全部可访问性设置。
 *
 * ★★ **注意这里没有什么字段：**
 *
 *   没有 `showDangerOutline`、没有 `showIllegalGlyph`、没有 `useShapeChannel` ——
 *   任何能把「形状 / 边框 / 字形」这些**非颜色通道**关掉的开关都不存在。
 *
 *   17.2 第二句是一条否定式规则：「危险区域不能只依赖颜色。」
 *   如果这里有一个 `showIllegalGlyph: boolean`，那么把它设成 false 之后，
 *   非法落点就只剩颜色一条通道 —— 规则被一个**设置项**破坏了，
 *   而且是玩家自己在设置界面里关掉的，谁都不会当成 bug 报上来。
 *
 *   所以那些通道在 M3 的 `GroundIndicator` 和 M8 的 `vfx/status.ts` 里是
 *   **无条件**绘制的，本文件不给它们任何开关。想加一个，得先在这个接口上
 *   添字段 —— 那是一次显眼的、会被 review 拦下的改动。
 *
 *   与 M8 的 `hiddenAtQuality(role: DecorativeRole)` 是同一个思路。
 */
export interface AccessibilitySettings {
  colorblind: ColorblindMode;
  /** 界面缩放。会被 `clampUiScale()` 夹到 [0.8, 2.0] */
  uiScale: number;
  /** 减弱镜头震动。0 = 完全关闭，1 = 原始强度 */
  cameraShake: number;

  // ── 17.2 第三句：以下四项必须**互相独立** ────────────────────
  /** 伤害数字 */
  damageNumbers: boolean;
  /** 屏幕闪烁（受击、暴击、低血量）*/
  screenFlash: boolean;
  /** 武器粒子 */
  weaponParticles: boolean;
  /** 姓名板密度。0 = 只显示当前目标，1 = 全部显示 */
  namePlateDensity: number;

  /**
   * 降低特效。★ 复用 M8 的画质档位，**不另开一条路** ——
   *   另开一条就等于给了第二个能隐藏关键信息的入口，而验收 #48 的全部保证
   *   都建立在「只有 `hiddenAtQuality(role: DecorativeRole)` 一个出口」上。
   */
  effectQuality: QualityTier;

  /**
   * 渲染顿帧（打击瞬间的短暂时间缩放，见 render/HitStop.ts。已知偏差 #8）。
   *
   * ★ **加这个开关不违反 17.2 第二句。** 那条禁止的是能把「形状/边框/字形」
   *   这类**非颜色信息通道**关掉的开关（见 UNSWITCHABLE_CHANNELS）。
   *   顿帧不隐藏、不淡化、不延迟任何一个元素 —— 它只是让**全部**渲染
   *   在几十毫秒内慢下来，关掉它之后玩家能看到的信息一字不少。
   * ★ 单独一项而不是搭 `cameraShake` 的车：对前庭敏感的人要关震动，
   *   对输入延迟敏感的人要关顿帧，两类人不是同一批。
   * ⚠️ **不进 INDEPENDENT_TOGGLES** —— 那张表是 17.2 第三句点名的四项，
   *   长度被 accessibility.test.ts 钉在 4。
   */
  hitStop: boolean;

  /**
   * X15 指针锁定：右键拖转身时把光标交给页面（`requestPointerLock`），
   * 于是转身量不再被窗口宽度封顶（真机量化：1366px 窗里拖满 1200px 只转出 149°）。
   *
   * ★ **为什么这一项住在「可访问性」这份设置里**（它显然更像「控制」）：
   *   一是它确实有无障碍面：锁定会**夺走系统光标**，用眼控/头控/轨迹球等
   *   辅助指点设备的人必须能一键关掉，这与「减弱镜头震动」是同一类需求；
   *   二是这份对象已经是设置面板 → 场景唯一入口 → localStorage 的**既有通道**
   *   （两场景 + 大厅都接好了），为一个布尔值另开一条存档键会造出第二套
   *   「面板显示的和生效的不一致」的风险。与 `hitStop` 同一个先例。
   *
   * ★ 它**不是**能隐藏信息的开关（17.2 第二句管的是那种）：关掉之后画面上
   *   一个像素都不变，只是光标继续受屏幕边界约束 —— 也就是 X15 之前的行为。
   *
   * ⚠️ 默认 **true**。验收脚本靠合成鼠标事件驱动镜头，它们在 `goto` 之前
   *   播种 `pointerLock:false`（见 scripts/verify-m1.mjs 的 seedSettings），
   *   让合成事件继续走旧拖动路径 —— 断言一个字没改。
   */
  pointerLock: boolean;
}

export const DEFAULT_ACCESSIBILITY: AccessibilitySettings = {
  colorblind: ColorblindMode.Off,
  uiScale: 1,
  cameraShake: 1,
  damageNumbers: true,
  screenFlash: true,
  weaponParticles: true,
  namePlateDensity: 1,
  effectQuality: 'high',
  hitStop: true,
  pointerLock: true,
};

export const clampUiScale = (v: number): number =>
  Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, v));

export const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** 规范化一份（可能来自 localStorage 的）设置，任何越界值都被夹回合法区间 */
export const normalizeAccessibility = (
  raw: Partial<AccessibilitySettings>,
): AccessibilitySettings => ({
  colorblind: isColorblindMode(raw.colorblind) ? raw.colorblind : ColorblindMode.Off,
  uiScale: clampUiScale(raw.uiScale ?? 1),
  cameraShake: clamp01(raw.cameraShake ?? 1),
  damageNumbers: raw.damageNumbers ?? true,
  screenFlash: raw.screenFlash ?? true,
  weaponParticles: raw.weaponParticles ?? true,
  namePlateDensity: clamp01(raw.namePlateDensity ?? 1),
  effectQuality: isQualityTier(raw.effectQuality) ? raw.effectQuality : 'high',
  hitStop: raw.hitStop ?? true,
  pointerLock: raw.pointerLock ?? true,
});

const isColorblindMode = (v: unknown): v is ColorblindMode =>
  typeof v === 'string' && (Object.values(ColorblindMode) as string[]).includes(v);

const isQualityTier = (v: unknown): v is QualityTier =>
  typeof v === 'string' && (QUALITY_ORDER as readonly string[]).includes(v);

// ════════════════════════════════════════════════════════════════
//  应用
// ════════════════════════════════════════════════════════════════

/**
 * 镜头震动的最终强度。
 *
 * ★ 17.2 只要求「**减弱**镜头震动」，所以 0 是允许的（完全关闭）——
 *   与「降低特效」不同，震动本身不携带任何战斗信息，关掉它不影响公平。
 *
 * ★ 接线对象是 `camera/CameraShake.ts`（打击感改造引入，偏差 #3 已关闭）：
 *   `sample()` 的 yaw/pitch/roll/pullIn 四个通道**各自**过这个函数 ——
 *   它是唯一入口，震动一旦分散在多处实现，「减弱震动」就会只减弱其中一部分。
 *   `CameraShake.test.ts` 断言 cameraShake=0 时四通道全部归零。
 */
export const shakeAmplitude = (base: number, s: AccessibilitySettings): number =>
  base * clamp01(s.cameraShake);

/**
 * 某个姓名板要不要画。
 *
 * ★ 密度设为 0 时**仍然**显示当前目标 —— 15.2 要求目标框和姓名板给出
 *   目标的状态信息，把它一起藏掉就不是「降低密度」而是「失去目标信息」了。
 *   所以 `isCurrentTarget` 短路在最前面。
 */
export const showNamePlate = (
  opts: { isCurrentTarget: boolean; distanceRank: number; total: number },
  s: AccessibilitySettings,
): boolean => {
  if (opts.isCurrentTarget) return true;
  if (s.namePlateDensity >= 1) return true;
  if (s.namePlateDensity <= 0) return false;
  // 按距离排名保留最近的一部分 —— 远处的姓名板才是造成拥挤的那些
  return opts.distanceRank < Math.ceil(opts.total * s.namePlateDensity);
};

/**
 * 某个视觉角色在当前设置下画不画。
 *
 * ★ 直接转发给 M8 的 `isVisible(role, quality)`，**不在这里另加判断**。
 *   「降低特效」若能绕过那个函数，验收 #48 的全部保证就失效了 ——
 *   那个保证的成立条件是「关键元素只有一个能被隐藏的出口，而它不接受
 *   `EssentialRole`」。所以这里只是把设置里的档位喂进去。
 */
export const visibleWithSettings = (role: VisualRole, s: AccessibilitySettings): boolean =>
  isVisible(role, s.effectQuality);

/**
 * 武器粒子的开关。
 *
 * ★ 单独一项而不是靠 `effectQuality` 顺带关掉 —— 17.2 第三句要求
 *   「武器粒子可**单独**调整」。塞进画质档位就等于「想关粒子必须整体降画质」，
 *   那是把两件事绑在一起，17.2 明确不允许。
 */
export const showWeaponParticles = (s: AccessibilitySettings): boolean =>
  s.weaponParticles && visibleWithSettings('weaponGlint' satisfies DecorativeRole, s);

/** UI 根元素的缩放变换值，供 `style.transform` 用 */
export const uiScaleTransform = (s: AccessibilitySettings): string =>
  `scale(${clampUiScale(s.uiScale)})`;

// ════════════════════════════════════════════════════════════════
//  持久化
// ════════════════════════════════════════════════════════════════

export const ACCESSIBILITY_STORAGE_KEY = 'wowpvp.accessibility.v1';

/**
 * 从 localStorage 读设置。任何损坏或越界的值都回落到默认值 ——
 * 一份坏掉的设置不该让游戏打不开。
 */
export const loadAccessibility = (
  storage: Pick<Storage, 'getItem'> | undefined,
): AccessibilitySettings => {
  const raw = storage?.getItem(ACCESSIBILITY_STORAGE_KEY);
  if (!raw) return { ...DEFAULT_ACCESSIBILITY };
  try {
    return normalizeAccessibility(JSON.parse(raw) as Partial<AccessibilitySettings>);
  } catch {
    return { ...DEFAULT_ACCESSIBILITY };
  }
};

export const saveAccessibility = (
  storage: Pick<Storage, 'setItem'> | undefined,
  s: AccessibilitySettings,
): void => {
  storage?.setItem(ACCESSIBILITY_STORAGE_KEY, JSON.stringify(s));
};

// ════════════════════════════════════════════════════════════════
//  自检
// ════════════════════════════════════════════════════════════════

/**
 * 17.2 第三句要求四项**可单独调整**。
 *
 * 这个清单存在的意义是让「把它们合并成一个特效强度滑条」这种简化
 * 必须显式地从这里删掉一项 —— 而 `accessibility.test.ts` 会拦下。
 */
export const INDEPENDENT_TOGGLES = [
  'damageNumbers',
  'screenFlash',
  'weaponParticles',
  'namePlateDensity',
] as const satisfies readonly (keyof AccessibilitySettings)[];

/**
 * 17.2 第二句的非颜色通道清单 —— 这些通道**没有开关**。
 *
 * 清单本身不参与任何逻辑，它是给测试和 review 用的：
 * `accessibility.test.ts` 断言 `AccessibilitySettings` 上不存在
 * 任何以它们命名的字段。
 */
export const UNSWITCHABLE_CHANNELS = [
  'dangerOutline',   // 危险区域的虚线边界（M3 GroundIndicator）
  'illegalGlyph',    // 非法落点的叉号
  'controlGlyph',    // 控制状态的字形（M8 vfx/status.ts）
  'flagStateGlyph',  // 旗帜状态的字形（M8 ModeHud / Minimap）
] as const;
