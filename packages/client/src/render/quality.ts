/**
 * 画质档位与低画质公平。规格书 14.4，验收 #48。
 *
 * 14.4 原文只有两句，但它们是**一条否定式规则**：
 *   「可以减少余烬、雪花、环境叶片、武器装饰光点和非关键光照。」
 *   「**不能隐藏**角色、目标、旗手、投射物主体、地面真实边界、
 *     控制状态、完全免疫和复活保护。」
 *
 * ★ 验收 #48 的全部实现是 `hiddenAtQuality()` 的**签名**，不是它的函数体。
 *
 *   它只接受 `DecorativeRole`。想在低画质隐藏一个关键元素，你必须先把它
 *   从 `ESSENTIAL_ROLES` 挪到 `DECORATIVE_ROLES` —— 那是一次显眼的、
 *   会在 review 里被拦下的改动，而不是在某个 draw 函数里随手加一行
 *   `if (quality === 'low') return;`。后者正是验收 #48 要防的事，
 *   而且它一旦混进去，只有把画质调到最低玩一局的人才会发现。
 *
 * 这与 M6 的做法同源：`completeSwap()` 短到无处藏私，
 * `enemyLoadoutView()` 的返回类型里根本没有备用装备字段。
 * 否定式规则要靠「让错的写法写不出来」来保证，不能靠自觉。
 */

/** 17.1 三档画质 */
export const QualityTier = {
  Low: 'low',
  Medium: 'medium',
  High: 'high',
} as const;
export type QualityTier = (typeof QualityTier)[keyof typeof QualityTier];

export const QUALITY_ORDER: readonly QualityTier[] = [
  QualityTier.Low,
  QualityTier.Medium,
  QualityTier.High,
];

/**
 * ★ 14.4 第二条逐字对应：低画质**不能隐藏**的八项。
 *
 * 这张表的每一项都能在规格书 14.4 里找到原词。
 * 加项可以（比如以后加「引导光束」），**删项必须回去改规格书**。
 */
export const ESSENTIAL_ROLES = {
  /** 角色 */
  character: 'character',
  /** 目标（当前目标的高亮与选中圈）*/
  target: 'target',
  /** 旗手 */
  flagCarrier: 'flagCarrier',
  /** 投射物主体（拖尾属于装饰，主体不是）*/
  projectileBody: 'projectileBody',
  /** 地面真实边界（14.3：装饰粒子可以淡出，边界不能消失）*/
  groundBoundary: 'groundBoundary',
  /** 控制状态（定身/昏迷/沉默/恐惧，14.3 要求彼此可区分）*/
  controlStatus: 'controlStatus',
  /** 完全免疫 */
  fullImmunity: 'fullImmunity',
  /** 复活保护 */
  spawnProtection: 'spawnProtection',
} as const;
export type EssentialRole = (typeof ESSENTIAL_ROLES)[keyof typeof ESSENTIAL_ROLES];

/**
 * 14.4 第一条逐字对应：低画质**可以减少**的五项。
 * 只有这里的角色才允许被画质档位隐藏。
 */
export const DECORATIVE_ROLES = {
  /** 余烬 */
  ember: 'ember',
  /** 雪花 */
  snowflake: 'snowflake',
  /** 环境叶片 */
  foliage: 'foliage',
  /** 武器装饰光点 */
  weaponGlint: 'weaponGlint',
  /** 非关键光照 */
  ambientLight: 'ambientLight',
  /** 投射物拖尾 —— 主体是关键的，尾巴不是 */
  projectileTrail: 'projectileTrail',
  /** 地面区域内部的装饰粒子 —— 14.3 明确说这个可以淡出 */
  groundFill: 'groundFill',
  /** 命中时的火花与碎屑 */
  impactDebris: 'impactDebris',
} as const;
export type DecorativeRole = (typeof DECORATIVE_ROLES)[keyof typeof DECORATIVE_ROLES];

export type VisualRole = EssentialRole | DecorativeRole;

/**
 * 每个装饰角色**从哪一档开始显示**。
 * 低画质下 `medium`/`high` 的都不画。
 */
const DECORATIVE_MIN_TIER: Record<DecorativeRole, QualityTier> = {
  ember: 'medium',
  snowflake: 'medium',
  foliage: 'medium',
  weaponGlint: 'high',
  ambientLight: 'medium',
  projectileTrail: 'medium',
  groundFill: 'medium',
  impactDebris: 'medium',
};

const tierRank = (q: QualityTier): number => QUALITY_ORDER.indexOf(q);

/**
 * ★ 这个函数只接受装饰角色 —— 这就是验收 #48。
 *
 * 关键元素根本没有机会被传进来，所以「低画质隐藏了控制状态」
 * 这种 bug 在本项目里是**类型错误**，不是运行时才发现的缺陷。
 */
export const hiddenAtQuality = (role: DecorativeRole, quality: QualityTier): boolean =>
  tierRank(quality) < tierRank(DECORATIVE_MIN_TIER[role]);

/**
 * 渲染层的统一入口：某个视觉角色在当前画质下画不画。
 *
 * 关键角色恒为 true —— 注意这里**没有**任何 quality 分支，
 * 不是「低画质时也返回 true」，而是压根不看 quality。
 */
export const isVisible = (role: VisualRole, quality: QualityTier): boolean => {
  if (isEssential(role)) return true;
  return !hiddenAtQuality(role, quality);
};

export const isEssential = (role: VisualRole): role is EssentialRole =>
  (Object.values(ESSENTIAL_ROLES) as string[]).includes(role);

export const isDecorative = (role: VisualRole): role is DecorativeRole =>
  (Object.values(DECORATIVE_ROLES) as string[]).includes(role);

/**
 * 装饰元素的密度系数。低画质不是「全有或全无」——
 * 14.4 说的是「减少」，所以中画质降一半而不是直接消失。
 */
export const decorativeDensity = (quality: QualityTier): number =>
  quality === QualityTier.High ? 1 : quality === QualityTier.Medium ? 0.5 : 0;

/**
 * 模块加载时自检：两张表不能有交集。
 *
 * 交集意味着同一个角色既「可以减」又「不能隐藏」——
 * 那时 `isVisible()` 的结果取决于 `isEssential()` 先跑，
 * 一条规格书规则的成立与否变成了函数调用顺序的副产品。
 * 与 M4 的 `assertAllEffectsRegistered()` 同一个思路：宁可启动失败。
 */
const assertRolesDisjoint = (): void => {
  const essential = new Set<string>(Object.values(ESSENTIAL_ROLES));
  const overlap = Object.values(DECORATIVE_ROLES).filter((r) => essential.has(r));
  if (overlap.length > 0) {
    throw new Error(
      `画质角色表冲突：${overlap.join(', ')} 同时出现在关键与装饰列表里。` +
        `规格书 14.4 把这两类分得很清楚，一个角色只能属于其中一类。`,
    );
  }
};
assertRolesDisjoint();

// ── 档位的其余表现参数（都只影响装饰，不影响判定）───────────────

export interface QualitySettings {
  tier: QualityTier;
  /** 阴影贴图尺寸，0 = 关闭阴影 */
  shadowMapSize: number;
  /** 装饰粒子密度系数 */
  particleDensity: number;
  /** 渲染分辨率倍率 */
  pixelRatioCap: number;
}

/**
 * ⚠️ 这里**没有** `antialias` 字段 —— 它曾经在，且 low 档写着 false，
 *   但抗锯齿是 WebGLRenderer 的**构造参数**、运行时改不了，两个场景都
 *   硬编码 `antialias: true`，`QualityController` 也从不读它 —— 一个从未
 *   生效的设置，还配着一条断言它的绿灯测试（「测试通过 ≠ 功能存在」）。
 *   按 A12 删除，不留假绿；真要按档位切 MSAA 得随 P9（自动降档）重建
 *   renderer，届时再加回来并**真的消费**它。
 */
export const QUALITY_SETTINGS: Record<QualityTier, QualitySettings> = {
  low: { tier: 'low', shadowMapSize: 0, particleDensity: 0, pixelRatioCap: 1 },
  medium: { tier: 'medium', shadowMapSize: 1024, particleDensity: 0.5, pixelRatioCap: 1.5 },
  high: { tier: 'high', shadowMapSize: 2048, particleDensity: 1, pixelRatioCap: 2 },
};
