/**
 * X30：**中招的那一层** —— debuff 学派色壳层的纯数据侧。规格 14.2 / 14.3 / 17.2。
 *
 * 用户拍板（2026-08-11）原话：「中了 debuff 身上要能看见效果 ——
 * 冰系减速身上有一层冰蓝色、火系击晕身上有一层火焰，其他法术一样。」
 *
 * ★★ 此前身上**唯一**能读出「我中了什么」的通道是 14.3 的控制标记
 *   （脚下冰棱 / 头顶星星 / 横杠 / 波纹）—— 也就是说**减速和 DoT 在角色身上
 *   没有任何表现**：被寒冰箭咬住和满血站着，模型看上去逐像素相同。
 *   八属性视觉语言（14.2）此前只活在**法术**上（飞行体、爆发、地面），
 *   受击方那一侧只有 P3 的一记 0.12 秒闪白。壳层补的是这一条。
 *
 * ★ 本文件是**纯数据 + 纯判据**（选哪一枚、什么颜色、怎么动），
 *   `StatusMarkers.setDebuffShell` 负责画出来 —— 与 `status.ts` /
 *   `StatusMarkers.ts` 的分法逐字相同：判据能被逐条断言，观感只能靠肉眼。
 *
 * ── 优先级口径（同时中好几枚时壳只有一个颜色，必须有唯一裁决）───────────
 *
 *   **类别**：控制 > 减速 > DoT > 其他 debuff > 掩码
 *     · 控制排第一：它是这一刻**唯一能改变你操作**的东西
 *     · 掩码（S7）垫底：任何看得懂的 debuff 都比「不知来历」更该被显示
 *     · buff **完全不进这个池子** —— 用户说的是「中招」，给增益上壳会让
 *       「身上有颜色」这条读法当场失效（吃了药也一层光 = 等于没有信息）
 *
 *   **同类别内**：取 `expiresAt` **最大**的那一枚（persistent = Infinity）。
 *     ⚠️ 这不是「最新施加的一枚」—— 协议里**没有** appliedAt（P11 只发
 *       expiresAt，理由见 `AuraSnapshot`），拿到期时刻当施加时刻用会漂：
 *       一记 3 秒昏迷比一条 8 秒流血晚施加，到期却更早。
 *     ★ 选「还要持续最久的那枚」在表现上也更对：壳是**持续**表现，
 *       玩家关心的是「我现在被什么裹着」，而剩得最久的那枚决定了
 *       这层壳接下来一直是什么颜色 —— 换成最新一枚会让壳在两个颜色间反复跳。
 *     ★ 并列时取**先出现的**（快照顺序稳定 ⇒ 同一份快照选出同一枚）。
 *
 * ── S7 红线 ──────────────────────────────────────────────────────
 *
 * ★★ `HIDDEN_AURA_ID` **只能中性灰、只能中性运动**。服务器掩掉施加者不可见的
 *   光环时连学派一起藏（`visibility.ts` 的「学派也是线索」），壳层要是从
 *   旁边把学派漏回去，等于给潜行者报点 —— 而且是最难发现的那种泄漏：
 *   画面上只是「颜色好像对得上」，没有任何断言会红。
 *   所以 `shellAttributeOf` 对掩码**先返回 undefined 再谈别的**，
 *   哪怕调用方（未来某天）真的塞了一个 school 进来也不看。
 */

import { HIDDEN_AURA_ID, type AuraDef, type School } from '@wowpvp/shared';

import { auraDefById, auraRegistryIds } from '../data/auraRegistry.js';
import {
  ATTRIBUTE_VISUALS,
  VisualAttribute,
  visualAttributeForAuraId,
  visualAttributeForSchool,
} from './schools.js';

/** 控制光环在 sim 里被统一改写成的 id 前缀（`sim/effects/combat.ts`）*/
export const CONTROL_AURA_PREFIX = 'control.';

// ── 类别 ─────────────────────────────────────────────────────────

export const ShellCategory = {
  /** 昏迷/定身/恐惧/沉默/缴械 —— 这一刻改变你操作的那一枚 */
  Control: 'control',
  /** 移动速度被压低（寒冰箭的冰缓、断腿斩、冰霜锁链…）*/
  Slow: 'slow',
  /** 持续伤害 */
  Dot: 'dot',
  /** 其他减益（易伤、降治疗、降命中…）*/
  Other: 'other',
  /** S7 掩码：知道中了东西，但不知道是什么 —— 只能中性灰 */
  Masked: 'masked',
} as const;
export type ShellCategory = (typeof ShellCategory)[keyof typeof ShellCategory];

/** 数字越大越优先。★ 见文件头的优先级口径 */
export const SHELL_CATEGORY_RANK: Record<ShellCategory, number> = {
  control: 4,
  slow: 3,
  dot: 2,
  other: 1,
  masked: 0,
};

// ── 光环定义索引（X26 的注册表，壳层是它的第一个消费方）────────────

/**
 * `auraId → AuraDef` 的查询入口。
 *
 * ★★ **实现已经搬去 `data/auraRegistry.ts`**（X26）。此前这张索引长在本文件里、
 *   只服务壳层；用户 2026-08-11 拍板「体验上没区别就尽量减轻服务端负担」
 *   之后，同一张表还要供 HUD 光环行（kind + 玩家可见名）、图标与学派色用 ——
 *   三个消费面共用一份判据，比各自建一张迟早会漂的表强。
 *   这两行是**转出口**，壳层这边一个字都不必改。
 *
 * ★★ **为什么壳层必须有它**：联网快照里除了 `control.*` 之外，一枚光环
 *   连「是增益还是减益」都没有。而壳层的第一条规则就是「buff 不上壳」——
 *   没有这张表，联网侧要么给所有光环上壳（喝了药也一层光），要么只剩
 *   控制类有壳（用户点名的**冰系减速**当场没有表现）。两条都不能接受。
 *
 * ★★ **判据只有一处**：本地模拟侧手里明明有 `AuraDef`，仍然走同一张表 ——
 *   两条路各写一遍「这算不算减速」迟早会漂，而玩家只会发现
 *   「单机是冰蓝的、联机是灰的」（`strongestShield` 同款理由）。
 */
export { auraDefById };

/**
 * 索引里的全部光环 id（诊断 / 门禁用）。
 * ★ 存在的理由是**回归护栏**：`debuffShell.test.ts` 拿它逐枚断言
 *   「每一枚减益都解析得出学派色」，而覆盖率本身由
 *   `data/auraRegistry.test.ts` 与数据源码逐字对照 ——
 *   哪天深走漏了一条枝，掉的是这个集合，而画面上只是
 *   「某个 debuff 忽然没有壳了」，不会有任何别的东西报错。
 */
export { auraRegistryIds as indexedAuraIds };

// ── 分类 ─────────────────────────────────────────────────────────

/** 带这些标志的光环就是控制 —— 与 `AuraFlags` 的控制族一一对应 */
const CONTROL_FLAGS = ['stunned', 'rooted', 'feared', 'silenced', 'disarmed'] as const;

const isControlAura = (def: AuraDef): boolean =>
  def.drCategory !== undefined || CONTROL_FLAGS.some((f) => def.flags?.[f] === true);

/**
 * 减速。★ 两条来源都要看：直接的 `moveSpeed` 乘算，以及
 * **随时间衰减**的减速（冰霜锁链的 `decay: { field: 'moveSpeed', from: 0.4 }`）——
 * 后者的 `modifiers.moveSpeed` 是初值，漏掉 decay 那条会让「冰霜锁链算不算减速」
 * 取决于数据怎么写，而不是取决于它是什么。
 */
const isSlowAura = (def: AuraDef): boolean =>
  (def.modifiers?.moveSpeed !== undefined && def.modifiers.moveSpeed < 1) ||
  (def.decay?.field === 'moveSpeed' && def.decay.from < 1);

/** 持续伤害：周期效果里有 `damage`。★ HoT（周期治疗）不算，它是 buff 侧的事 */
const isDotAura = (def: AuraDef): boolean =>
  def.periodic?.effects.some((e) => e.kind === 'damage') === true;

/** 一枚**已知定义**的光环属于哪一类。返回 undefined = 不上壳（增益）*/
const categoryOfDef = (def: AuraDef): ShellCategory | undefined => {
  if (def.kind === 'buff') return undefined;
  if (isControlAura(def)) return ShellCategory.Control;
  if (isSlowAura(def)) return ShellCategory.Slow;
  if (isDotAura(def)) return ShellCategory.Dot;
  return ShellCategory.Other;
};

// ── 输入形状 ─────────────────────────────────────────────────────

/**
 * 壳层要读的那几个光环字段。
 *
 * ★★ id 收**两个名字**是有意的：联网快照的字段叫 `auraId`（`AuraSnapshot`），
 *   HUD 投影叫 `id`（`HudAura`）。两个都收，于是 `NetworkScene` 能把
 *   `snap.auras` **原样**喂进来 —— 12v12 每帧 24 个实体，省掉的是
 *   24 次 `.map()` 和它产生的一整批短命对象。
 * ★ `kind` 只是**兜底**，主判据永远是 `auraDefById`（见那里的 ★★）。
 *   ⚠️ X26 之后联网侧的 `toHudAura` 也填得出 kind 了（同一张注册表），
 *     但那**不能**让这里改成信 kind：`toHudAura` 的 kind 本身就是从
 *     注册表推的，绕一圈回来只会多一次转换、少一层信息（buff/debuff 两档
 *     分不出减速与 DoT）。兜底留给**表外**的 id —— 那才是它唯一的用武之地。
 */
export type ShellAuraLike =
  | { id: string; expiresAt?: number; school?: School; kind?: 'buff' | 'debuff' | 'unknown' }
  | { auraId: string; expiresAt?: number; school?: School; kind?: 'buff' | 'debuff' | 'unknown' };

const idOf = (a: ShellAuraLike): string => ('id' in a ? a.id : a.auraId);

/**
 * 一枚光环该不该上壳、属于哪一类。undefined = 不上壳。
 *
 * ★ 三条出路，按可信度排：
 *   ① 掩码 / `control.*` —— **结构事实**（id 是 sim 自己拼的），最可信
 *   ② 索引里查得到定义 —— 数据事实
 *   ③ 都查不到但调用方说这是 debuff —— 兜底，只归到「其他」
 *   ④ 什么都不知道 → **不画**。编一个壳比不画更糟（`visualForAuraId` 同款态度）
 */
export const shellCategoryOf = (a: ShellAuraLike): ShellCategory | undefined => {
  const id = idOf(a);
  if (id === HIDDEN_AURA_ID) return ShellCategory.Masked;
  if (id.startsWith(CONTROL_AURA_PREFIX)) return ShellCategory.Control;
  const def = auraDefById(id);
  if (def) return categoryOfDef(def);
  return a.kind === 'debuff' ? ShellCategory.Other : undefined;
};

/**
 * 一枚光环的学派视觉属性。undefined = 中性灰。
 *
 * ★★ 掩码**第一行就返回 undefined** —— 见文件头的 S7 红线。
 * ★ 三级台阶，按精确度排。前两级都在 `visualAttributeForAuraId` 里
 *   （X26 起它自己就是「注册表优先、启发式兜底」的那条判据，
 *   壳层不再另写一遍 —— 判据只有一处）：
 *   ① 注册表里的**施加技能** —— 最准，而且认得毒（毒刃学派是物理，
 *     玩家该看到黄绿而不是钢铁色）
 *   ② 光环 id 的前两段反查技能 —— 表外的光环（sim 现造的）还有这一条
 *   ③ 调用方给的学派 —— `control.*` **只有**这一条路：它的 id 查不回技能，
 *     学派是快照单独带的那个字段
 */
export const shellAttributeOf = (
  a: ShellAuraLike,
  category: ShellCategory,
): VisualAttribute | undefined => {
  if (category === ShellCategory.Masked) return undefined;
  return (
    visualAttributeForAuraId(idOf(a)) ??
    (a.school !== undefined ? visualAttributeForSchool(a.school) : undefined)
  );
};

// ── 运动档案（17.2：不能只靠颜色）───────────────────────────────

/**
 * 壳的**动法**。八属性各一份 —— 这是壳层的**非颜色**辨识通道。
 *
 * ★★ 17.2 要求不能只靠颜色区分，而壳层的信息几乎全在颜色上（那正是它的
 *   本分：一眼看出中的是什么系）。所以运动必须补上：把画面转成灰度之后，
 *   **火仍然在往上窜、霜仍然在往下沉**，两者读得开。
 * ★ 三个通道各有分工：
 *   · `rate`  —— 脉动多急。火最急（6.2）、毒最缓（1.2）
 *   · `amp`   —— 脉动多深。烟雾/火焰深，霜几乎不呼吸
 *   · `drift` —— 竖向漂移方向。**正 = 上窜（火/圣/奥），负 = 下沉（霜/毒/影）**，
 *     取自 14.2 的「形状与运动」列（火舌/余烬 vs 冰晶/霜雾 vs 液滴）
 * ★ 八项 `rate` 两两不同，`debuffAura.test.ts` 钉着 —— 相同就等于少了一条通道。
 */
export interface ShellMotion {
  /** 脉动角速度，rad/s */
  rate: number;
  /** 不透明度脉动的相对幅度（0.3 = 在基准上下浮动 30%）*/
  amp: number;
  /** 竖向漂移幅度，米。正 = 上窜，负 = 下沉 */
  drift: number;
}

export const SHELL_MOTIONS: Record<VisualAttribute, ShellMotion> = {
  // 火舌、余烬、热浪 —— 最急、最深、往上窜
  fire: { rate: 6.2, amp: 0.34, drift: 0.055 },
  // 冰晶、霜雾 —— 几乎不动，缓缓下沉
  frost: { rate: 1.6, amp: 0.12, drift: -0.03 },
  // 符文、几何轨迹 —— 规律的脉动，微微上浮
  arcane: { rate: 3.4, amp: 0.24, drift: 0.02 },
  // 烟雾、扭曲 —— 慢而深的翻涌，往下淌
  shadow: { rate: 2.2, amp: 0.3, drift: -0.02 },
  // 光柱、圆形符文 —— 稳定的呼吸，往上
  holy: { rate: 2.8, amp: 0.18, drift: 0.035 },
  // 叶片、水波 —— 缓慢起伏
  nature: { rate: 2.0, amp: 0.16, drift: 0.012 },
  // 刀光、冲击线 —— 干脆的短抖，不飘
  physical: { rate: 4.6, amp: 0.14, drift: 0 },
  // 液滴、细雾 —— 最缓，最明显地往下坠
  poison: { rate: 1.2, amp: 0.22, drift: -0.045 },
};

/**
 * 中性壳（S7 掩码）的运动。
 * ★★ 它**必须与八套学派运动都不同** —— 否则「颜色藏住了、动法漏出去了」，
 *   S7 那条红线就从另一扇门被打穿。`debuffAura.test.ts` 钉着这一条。
 */
export const NEUTRAL_SHELL_MOTION: ShellMotion = { rate: 2.4, amp: 0.1, drift: 0 };

/** 中性壳的主色/边缘色。★ 灰是「不知道」，不是任何一个学派 */
export const NEUTRAL_SHELL_COLOR = 0x9aa3ad;
export const NEUTRAL_SHELL_EDGE = 0xd4d9de;

export const shellMotionOf = (attribute?: VisualAttribute): ShellMotion =>
  attribute === undefined ? NEUTRAL_SHELL_MOTION : SHELL_MOTIONS[attribute];

// ── 分层表（与既有的三层壳错开）──────────────────────────────────

/**
 * 壳层在**半径 / 混合 / 不透明度 / 运动**四个维度上与既有表现的错位表。
 *
 * ⚠️ 改这里的数之前先看这张表 —— 四层都贴在同一个角色身上，
 *    任意两层撞在一起的后果不是「难看」，而是**两条信息读成一条**。
 *
 * | 通道 | 几何 | 混合 | 不透明度 | 运动 |
 * |---|---|---|---|---|
 * | P3 受击闪白 | 模型自身 emissive | — | 0.12–0.2 秒的瞬时 | 无 |
 * | **X30 debuff 壳（本文件）** | 胶囊 ×1.05 / ×1.11 | Normal 正面 / Additive 背面 | 0.20 / 0.26（随学派脉动） | **按学派脉动 + 竖向漂移** |
 * | X14 阵营 rim | 胶囊 ×1.16 | Additive 背面 | 0.13 | **完全静止** |
 * | 14.3 护盾壳 | **球** R×1.85 / ×2.02 | Normal 正面 / Additive 背面 | 0.22 / 0.43 | 内外反向自转 |
 *
 * ★ 半径三档不重叠（1.11 < 1.16 ≪ 球壳），**形状**也不同（护盾是球、
 *   另两层是胶囊）—— 护盾壳明显离身体更远、更亮，永远压在最外面。
 * ★ debuff 壳比阵营 rim **亮一档**且**在动**：阵营是一直在场的背景信息、
 *   中招是这一刻的前景信息，前景压过背景是对的。而「动 vs 不动」本身
 *   就是第三条辨识通道（`FactionRing` 与 `TargetRing` 用的是同一招）。
 */
export const SHELL_LAYERS = {
  /** 内层：贴着身体的一层色膜。**正面**普通混合 —— 这就是「身上有一层冰蓝色」 */
  fill: { radiusScale: 1.05, heightScale: 1.004, opacity: 0.2 },
  /** 外缘：只画背面 + 加法混合 = 廉价边缘光（与护盾外壳、X14 rim 同一招）*/
  rim: { radiusScale: 1.11, heightScale: 1.012, opacity: 0.26 },
} as const;

/** 壳的淡入/淡出秒数。★ 中招那一下要快，解除稍缓（收壳不该「啪」地一下）*/
export const SHELL_FADE_IN = 0.16;
export const SHELL_FADE_OUT = 0.28;

// ── 裁决 ─────────────────────────────────────────────────────────

/** 这一帧壳该长什么样。undefined = 不上壳 */
export interface ShellPick {
  /** 选中的那一枚（诊断/自检用；掩码时就是 `HIDDEN_AURA_ID`）*/
  auraId: string;
  category: ShellCategory;
  /** 学派视觉属性。undefined = 中性灰（S7 掩码 / 查不回学派）*/
  attribute?: VisualAttribute;
  /** 内层主色 */
  color: number;
  /** 外缘色（学派辅色 —— 与 `ParticleBurst` 的双色同源）*/
  edge: number;
  motion: ShellMotion;
}

/**
 * 一串光环 → 这一帧的壳。口径见文件头。
 *
 * @param auras 该实体身上**全部**光环（增益也照传，本函数负责筛掉）
 */
export const debuffShellOf = (auras: readonly ShellAuraLike[]): ShellPick | undefined => {
  let best: ShellAuraLike | undefined;
  let bestCategory: ShellCategory | undefined;
  let bestRank = -1;
  let bestUntil = -Infinity;

  for (const a of auras) {
    const category = shellCategoryOf(a);
    if (category === undefined) continue;
    const rank = SHELL_CATEGORY_RANK[category];
    // ★ persistent（不发 expiresAt）= 一直在 = Infinity，与 P11 的口径一致
    const until = a.expiresAt ?? Infinity;
    if (rank < bestRank) continue;
    // 并列时取先出现的 —— `<=` 而不是 `<`（同一份快照必须选出同一枚）
    if (rank === bestRank && until <= bestUntil) continue;
    best = a;
    bestCategory = category;
    bestRank = rank;
    bestUntil = until;
  }

  if (best === undefined || bestCategory === undefined) return undefined;
  const attribute = shellAttributeOf(best, bestCategory);
  const visual = attribute === undefined ? undefined : ATTRIBUTE_VISUALS[attribute];
  return {
    auraId: idOf(best),
    category: bestCategory,
    ...(attribute !== undefined ? { attribute } : {}),
    color: visual?.primary ?? NEUTRAL_SHELL_COLOR,
    edge: visual?.secondary ?? NEUTRAL_SHELL_EDGE,
    motion: shellMotionOf(attribute),
  };
};
