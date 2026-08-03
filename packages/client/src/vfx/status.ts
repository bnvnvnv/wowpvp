/**
 * 控制状态与护盾的视觉区分。规格书 14.3，验收 #48 / #49。
 *
 * 14.3 里三条与本文件直接相关：
 *   ·「定身附着**脚部**，昏迷显示**头顶**标记，沉默与恐惧使用**不同视觉**，避免混淆。」
 *   ·「护盾需要**激活、承伤、强度衰减和破裂**四种不同反馈。」
 *   ·「第一人称降低近身火焰、烟雾和护盾透明度，**不能遮满屏幕**。」（验收 #49）
 *
 * ★「沉默与恐惧使用不同视觉」是一条**否定式**要求（不能混淆），
 *   靠「我觉得这俩看起来不一样」是保证不了的。这里的做法是：
 *   每种控制在**四个通道**上取值（挂点 / 形状 / 字形 / 运动），
 *   `status.test.ts` 断言任意两种控制在**除颜色外**至少两个通道上不同。
 *   为什么排除颜色 —— 17.2 可访问性要求不能只靠颜色区分，
 *   如果允许「颜色不同」算数，色盲玩家眼里它们就是同一个东西。
 */

import { QualityTier } from '../render/quality.js';

/** 挂点。14.3 明确规定了定身在脚、昏迷在头顶 */
export type Anchor = 'feet' | 'overhead' | 'body';

export interface ControlVisual {
  /** 玩家看到的名字，用于 HUD 提示与无障碍朗读 */
  label: string;
  anchor: Anchor;
  /** 几何形状键，渲染层据此选网格 */
  shape: 'ring' | 'chains' | 'stars' | 'crossedBar' | 'wave' | 'iceShards';
  /** 17.2：不能只靠颜色 —— 每种控制还有一个字形标记 */
  glyph: string;
  /** 运动方式，避免两种控制静止时长得像 */
  motion: 'pulse' | 'spin' | 'orbit' | 'shake' | 'drift';
  color: number;
}

/**
 * 四种控制的视觉。
 *
 * ⚠️ 改这张表前先看文件头：任意两种在「挂点/形状/字形/运动」四通道里
 *    至少要有两个不同，否则 `status.test.ts` 会红。
 */
export const CONTROL_VISUALS = {
  /**
   * 定身：附着**脚部**（14.3 原文）。
   *
   * ★ 形状从 `chains`（一个管径 5 厘米的细锁链环，正常镜头距离下几乎看不见）
   *   换成 `iceShards`（脚下炸起的一圈棱柱 + 底座）。用户实测原话是
   *   「地上有冰块冻住角色的脚，也没有」—— 其实是有的，只是太细看不见，
   *   而且通用锁链读不出「被什么定住」。
   * ★ 颜色是**兜底**：正常路径由施加它的技能的学派染色（冰系冰蓝、自然系翠绿），
   *   见 `StatusMarkers.update()` 的 tint 参数。
   */
  rooted: {
    label: '定身',
    anchor: 'feet',
    shape: 'iceShards',
    glyph: '❄',
    motion: 'pulse',
    color: 0x6a8caf,
  },
  /** 昏迷：**头顶**标记（14.3 原文）*/
  stunned: {
    label: '昏迷',
    anchor: 'overhead',
    shape: 'stars',
    glyph: '✷',
    motion: 'orbit',
    color: 0xffd76a,
  },
  /** 沉默：头顶，但形状/字形/运动都与恐惧不同 */
  silenced: {
    label: '沉默',
    anchor: 'overhead',
    shape: 'crossedBar',
    glyph: '⊘',
    motion: 'pulse',
    color: 0xb28ad6,
  },
  /** 恐惧：作用于整个身体，飘动 —— 与沉默三个通道都不同 */
  feared: {
    label: '恐惧',
    anchor: 'body',
    shape: 'wave',
    glyph: '〰',
    motion: 'drift',
    color: 0x8f5fbf,
  },
  /** 缴械：挂在武器上 */
  disarmed: {
    label: '缴械',
    anchor: 'body',
    shape: 'crossedBar',
    glyph: '⚔',
    motion: 'shake',
    color: 0xc98a5a,
  },
} as const satisfies Record<string, ControlVisual>;

export type ControlKind = keyof typeof CONTROL_VISUALS;

/** 除颜色外的可辨识通道。测试用它做两两比对 */
export const distinguishingChannels = (v: ControlVisual): string[] => [
  v.anchor,
  v.shape,
  v.glyph,
  v.motion,
];

// ── 护盾四态（14.3）────────────────────────────────────────────

/**
 * 护盾的四种反馈。规格书原文：「激活、承伤、强度衰减和破裂」。
 *
 * ★「强度衰减」和「承伤」是两件事，很容易并成一件：
 *   · 承伤 = 这一瞬间挡下了一次伤害 → 一次**闪光**，是事件
 *   · 强度衰减 = 剩余吸收量在变少 → **持续**的厚度/亮度变化，是状态
 *   只做前者，玩家不知道盾还剩多少；只做后者，挡下伤害时没有反馈。
 */
export const ShieldState = {
  Active: 'active',
  Absorbing: 'absorbing',
  Decaying: 'decaying',
  Broken: 'broken',
} as const;
export type ShieldState = (typeof ShieldState)[keyof typeof ShieldState];

export interface ShieldVisual {
  label: string;
  /** 壳体不透明度 */
  opacity: number;
  /** 这一态是持续状态还是一次性事件 */
  kind: 'sustained' | 'burst';
  /** 一次性事件的持续秒数 */
  durationSeconds: number;
  motion: 'steady' | 'flash' | 'thin' | 'shatter';
}

export const SHIELD_VISUALS: Record<ShieldState, ShieldVisual> = {
  active: { label: '护盾激活', opacity: 0.45, kind: 'sustained', durationSeconds: 0, motion: 'steady' },
  absorbing: { label: '护盾承伤', opacity: 0.8, kind: 'burst', durationSeconds: 0.15, motion: 'flash' },
  decaying: { label: '护盾衰减', opacity: 0.2, kind: 'sustained', durationSeconds: 0, motion: 'thin' },
  broken: { label: '护盾破裂', opacity: 0.9, kind: 'burst', durationSeconds: 0.4, motion: 'shatter' },
};

/**
 * 按剩余吸收量比例选择护盾的**持续**态。
 * 承伤与破裂是事件，由伤害结算触发，不走这个函数。
 */
export const shieldStateFor = (remaining: number, initial: number): ShieldState => {
  if (remaining <= 0) return ShieldState.Broken;
  return remaining / Math.max(initial, 1e-6) < 0.3 ? ShieldState.Decaying : ShieldState.Active;
};

/** 一串光环里最强的吸收盾所需的最小形状 */
export interface ShieldAuraLike {
  auraId: string;
  absorbRemaining?: number;
  absorbInitial?: number;
}

/**
 * 一串光环里**最强**的吸收盾。
 *
 * ★★ 判据只有这一处实现：试验场（`CombatDirector.shieldOf` 从 sim 光环表读）
 *   与联网（`updateMarkersFor` 从快照 `AuraSnapshot` 读）共用它 ——
 *   两条路各写一遍「哪个盾算数」迟早会漂，而玩家只会发现
 *   「同一局里单机和联机的护盾表现不一样」。
 *
 * ★ 多个盾**不求和**：14.3 的四态是按「这一个盾还剩几成」定义的，
 *   把两个盾加起来会让「快破了」在错误的时刻亮起。取最强的那个，
 *   与 sim 的吸收消耗顺序无关（表现层不该猜规则层先扣哪个）。
 */
export const strongestShield = <T extends ShieldAuraLike>(
  auras: readonly T[],
): { auraId: string; remaining: number; initial: number } | undefined => {
  let best: { auraId: string; remaining: number; initial: number } | undefined;
  for (const a of auras) {
    const remaining = a.absorbRemaining ?? 0;
    if (remaining <= 0) continue;
    if (best && best.remaining >= remaining) continue;
    best = { auraId: a.auraId, remaining, initial: Math.max(remaining, a.absorbInitial ?? remaining) };
  }
  return best;
};

// ── 14.3 第五条：第一人称不能遮满屏幕（验收 #49）───────────────

/** 14.3 点名的三类「近身会糊脸」的特效 */
export const CLOSE_UP_EFFECTS = ['fire', 'smoke', 'shield'] as const;
export type CloseUpEffect = (typeof CLOSE_UP_EFFECTS)[number];

/** 第一人称阈值，与 CameraController 的 FIRST_PERSON_THRESHOLD 同源 */
const FIRST_PERSON_DISTANCE = 0.4;
/** 第一人称下的不透明度上限 —— 三类近身特效都压到这个值以下 */
const FIRST_PERSON_OPACITY_CAP = 0.25;

/**
 * ★ 验收 #49 前半句：第一人称下技能特效不会遮满屏幕。
 *
 * 返回该特效在当前镜头距离下允许的最大不透明度。
 * 注意这里压的是**不透明度**而不是把特效关掉 ——
 * 关掉会违反 14.4（护盾属于关键信息，不能隐藏），
 * 而降透明度既看得见又不糊脸。
 */
export const closeUpOpacity = (
  effect: CloseUpEffect,
  baseOpacity: number,
  cameraDistance: number,
): number => {
  void effect;
  if (cameraDistance >= FIRST_PERSON_DISTANCE) return baseOpacity;
  return Math.min(baseOpacity, FIRST_PERSON_OPACITY_CAP);
};

/**
 * ★ 验收 #49 后半句：最远镜头下旗手和范围仍清晰。
 *
 * 14.3 最后一条点名了四样在最远镜头必须保留的东西：
 * 旗手、姓名板、投射物主体、地面边界。
 * 它们全都在 quality.ts 的 ESSENTIAL_ROLES 里，所以这里只需要
 * 让它们在远处**变大**而不是等比缩小 —— 等比缩小到 18 米就看不清了。
 */
export const FAR_CAMERA_DISTANCE = 18;

/**
 * 远距离下关键标记的放大系数。
 * 近处 1 倍，18 米处 1.8 倍，线性插值。
 */
export const essentialMarkerScale = (cameraDistance: number): number => {
  const t = Math.min(1, Math.max(0, cameraDistance / FAR_CAMERA_DISTANCE));
  return 1 + t * 0.8;
};

/**
 * 低画质下控制状态标记要**更明显**而不是更弱 ——
 * 低画质通常意味着屏幕小、分辨率低，粒子又被砍掉了，
 * 此时关键信息如果还按原尺寸画，实际可读性反而比高画质差。
 */
export const controlMarkerScale = (quality: QualityTier): number =>
  quality === QualityTier.Low ? 1.3 : 1;
