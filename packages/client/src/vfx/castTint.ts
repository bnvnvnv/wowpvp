/**
 * 法阵（14.1「预备」阶段脚下那圈光环）的**技能级**外观换算。
 *
 * ★★ 起因是一句实测反馈：「施法的光环可以根据不同技能更换颜色吗？
 *   现在似乎都是一样的。」查下去发现**接线其实是通的** ——
 *   `SpellVfx.visualFor()` 从 P3 起就把签名的 `tintShift` 叠进了法阵色。
 *   于是先量了一把再动手（全 117 技能、按「职业 × 属性」分组，
 *   统计外圈颜色的去重数）：
 *
 *       baseline（现状）  90 / 108 种
 *
 *   也就是说**颜色本来就是逐技能不同的**，只是差得太小看不出来 ——
 *   问题不在「没接」，在「接得太轻」。三处具体的欠账：
 *
 *     1. **推导层只用了一半预算**。没写手写签名的技能走 `derivedOf()`
 *        的 17 档散列，落在 ±0.04 色环；`TINT_CLAMP` 给的预算是 ±0.08。
 *        最小的那几档只差 0.005 色环（1.8°），叠在加法混合的细环上等于没差。
 *     2. **色相预算已经用满，再挤没有了**。14.2 的红线摆在那儿：
 *        ±0.08 是「仍在自己属性色域内」的上限。所以剩下的差异
 *        **只能走非颜色通道** —— 这也正是 17.2 一直更偏好的那条路。
 *        本文件因此多了一根「外圈断齿数」的轴（见 `circleTeethOf`）。
 *     3. **同一个施法者换技能不换法阵**（`SpellVfx` 那条 skillId 差分修的）。
 *
 * ⚠️⚠️ **走过的弯路，留着别再走一遍：**
 *   第一版想得很直接 —— 「把 tintShift 乘 2 再钳回 ±TINT_CLAMP」。
 *   同一把尺子量出来是 **52 / 108**，比不改还差得多。原因很清楚：
 *   手写签名本来就大多落在 0.03–0.07，乘 2 之后**一律撞上钳位**，
 *   十二个圣骑士技能一起塌成 ±0.08 两个值。
 *   「放大差异」的写法反而把差异抹平了 —— 而且如果不是先量一遍，
 *   这事在真机上只会表现为「怎么还是一样」，永远查不到这里。
 *   所以本文件用的是**单调幂曲线**（`circleTintShift`）：
 *   小值抬起来、大值保持、顺序与单射性一位不丢，实测仍是 90 / 108。
 *
 * ★ 本文件干的是**换算**，不新增数据源：签名层（`av/skillSignature.ts`）
 *   一行不动，这里把它导出的 `tintShift` / `scale` 翻译成法阵那几层真正吃得下的量。
 *   与 `castVfx.ts` 同一分法 —— 纯函数、无 three.js 依赖，可在 node 里逐条断言。
 *
 * ⚠️ **红线：14.2「属性 → 颜色」的可读性不许破。**
 *   只动**色相**，一位 S/L 都不碰，理由照抄 `schools.ts` 的 `hueShifted` ★★：
 *   八属性里有两对基色色相几乎重合（神圣 40.5° vs 物理 38.3°、
 *   奥术 264° vs 暗影 273°），把它们分开的是饱和度与明度。
 *   任何「让法阵更好认」的想法只要伸手去调亮度或饱和度，代价就是
 *   神圣技能褪成物理色 —— 拿一条可读性规则去换另一条。
 *
 * DEBT(X25): 断齿数/暖芯冷边/规模衰减这三根新轴的真机肉眼轮仍缺 ——
 *   数不数得清、看不看得出，只有真机能回答。见总账 X25。
 */

import {
  SCALE_CLAMP,
  TINT_CLAMP,
  type ResolvedSignature,
} from '../av/skillSignature.js';
import { hueShifted, type AttributeVisual } from './schools.js';

/**
 * 色相扩张曲线的指数。`f(t) = C · sign(t) · (|t|/C)^p`，C = TINT_CLAMP。
 *
 * ★★ 幂曲线而不是乘常数，理由见文件头 ⚠️⚠️。这条曲线的三个性质缺一不可：
 *     · **不越界** —— |t| ≤ C 时 |f(t)| ≤ C，钳位是数学保证不是补丁
 *     · **单射且保序** —— 两个不同的签名值不会被压成同一个法阵色
 *       （乘常数 + 钳位恰恰在这一条上崩掉）
 *     · **小值抬得多** —— 0.005 → 0.0157（3.1 倍）、0.02 → 0.0348（1.7 倍）、
 *       0.07 → 0.0738（1.05 倍）。欠的是推导层的账，就只补推导层。
 * ★ 0.6 是在 0.45 / 0.6 / 1.0 三档里量出来的：0.45 与 0.6 的去重数相同（90/108），
 *   取较保守的 0.6 —— 曲线越弯，大值越被压向上限，离红线越近。
 */
export const CIRCLE_TINT_CURVE = 0.6;

/**
 * 签名规模（`sig.scale` 0.6–1.8）进法阵尺寸时的**衰减**。
 *
 * ★★ 不能像释放爆发那样直接相乘。释放爆发是空中一团粒子，
 *   `ws × sig.scale` 最坏 2.7 倍只是更炸；而法阵是**贴地的圆**，
 *   半径已经是 `2.2 × ws`（大招 ws=1.5 → 3.3 米），再乘 1.8
 *   就是 5.9 米 —— 一个人脚下摊开直径 12 米的光圈，
 *   12v12 里几个法师一起读条整块地面就被糊掉了。
 * ★ 0.25 之后区间是 0.9–1.2：大招的法阵**看得出更大**（+20%），
 *   而最坏尺寸 2.2 × 1.5 × 1.2 = 3.96 米半径，只比现状多两成。
 * ★ 纹章吃 0.5（区间 0.8–1.4）—— 中央那个符号长在法阵**里面**，
 *   放大它不占地面，「大招的印记更大」这句话主要由它说。
 */
export const CIRCLE_SCALE_GAIN = 0.25;
export const MOTIF_SCALE_GAIN = 0.5;

/**
 * 外圈断齿数的取值区间（含两端）。
 *
 * ★★ 这是**非颜色**的技能身份通道 —— 色相预算见底之后唯一还剩的地方，
 *   而 17.2 本来就要求「不能只依赖颜色」。玩家读到的是
 *   「这个法阵有五个齿、那个有八个」，一眼可数、与属性色正交、
 *   色盲模式下照样成立。
 * ★ 下限 4 而不是 0：齿是长在外圈**上**的，太少会读作「环破了」而不是
 *   「这个法阵的花纹」。上限 10 是齿距的下限 —— 再多，
 *   `2.2 米` 半径上相邻齿会糊成一圈毛边，等于回到没有齿。
 * ★ 齿只**外扩**不切断外圈：外圈那道连续的圆是 14.4 的关键元素
 *   （「这个人在施法」，`verify:m12` #14e/#48d 钉着），
 *   任何把它切成虚线的方案都会削弱那条告示，不许做。
 */
export const CIRCLE_TEETH = { min: 4, max: 10 } as const;

/** 一次施法的法阵外观。颜色是最终值，缩放是**乘数**（调用方乘在既有尺寸上）*/
export interface CastCircleStyle {
  /** 外圈最终颜色 */
  ringColor: number;
  /** 中央纹章最终颜色 */
  motifColor: number;
  /** 外圈相对**属性基色**的最终色相偏移（供测试与 review 核预算）*/
  ringShift: number;
  /** 纹章相对属性基色的最终色相偏移 */
  motifShift: number;
  /** 法阵整体尺寸乘数 */
  circleScale: number;
  /** 纹章相对法阵的尺寸乘数 */
  motifScale: number;
  /** 外圈断齿数（非颜色身份通道）*/
  teeth: number;
}

const clamp = (v: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, v));

/**
 * ★ 非有限值兜到 fallback：签名是手写表，`tintShift: undefined as any`
 *   这类事故进来会一路变成 `hueShifted(c, NaN)` → 颜色算成 NaN → 黑法阵。
 *   `skillWeight.ts` 的 `norm` 与 `castVfx.ts` 的 `clamp01` 都栽过同一个跟头。
 */
const finite = (v: number, fallback: number): number =>
  Number.isFinite(v) ? v : fallback;

/**
 * 法阵该用的色相偏移：把签名值沿单调幂曲线撑向预算上限，**绝不越界**。
 *
 * 导出是为了让测试能直接钉「保序 + 不越界」两条 ——
 * 藏在 `castCircleStyleOf` 里只能从最终颜色反推，断言会软成约等于。
 */
export const circleTintShift = (tintShift: number): number => {
  const t = clamp(finite(tintShift, 0), -TINT_CLAMP, TINT_CLAMP);
  if (t === 0) return 0;
  return Math.sign(t) * TINT_CLAMP * Math.pow(Math.abs(t) / TINT_CLAMP, CIRCLE_TINT_CURVE);
};

/**
 * 确定性散列（FNV-1a 32 位）。
 *
 * ★ 与 `skillSignature.ts` 里那个同款、也同样**不用 `Math.random`** ——
 *   一个技能的法阵在任何机器任何一局都必须长同一个样，它是身份不是装饰。
 * ★ 为什么在这里再写一遍而不是从签名层导出：齿数是**表现层自己的轴**，
 *   签名层没有它、也不该为它加字段（那边的契约是音高/色相/规模/形态四项，
 *   `integrity.test.ts` 按那四项做全局唯一性门禁）。多一份六行的散列，
 *   换的是「改法阵不必回头动 av/」。
 */
const hash32 = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

/** 这个技能的外圈断齿数。任何字符串都有结果（查不回技能的兜底路径也要能画）*/
export const circleTeethOf = (skillId: string | undefined): number => {
  const span = CIRCLE_TEETH.max - CIRCLE_TEETH.min + 1;
  // ★ 取高位段：低位被 FNV 的末次乘法主导，与 tintShift 用的位段错开，
  //   免得「齿多的技能色相也总是偏暖」这种肉眼看得见的相关性
  return CIRCLE_TEETH.min + ((hash32(skillId ?? '') >>> 11) % span);
};

/**
 * 算一次法阵外观。
 *
 * @param tinted **已经**叠过 `sig.tintShift` 的属性视觉（`SpellVfx.visualFor` 的产物）
 * @param sig    该技能的解析签名
 * @param skillId 技能 id（只用来定齿数）。查不回技能时可省
 *
 * ★★ 为什么参数收的是「已上色」的视觉而不是属性基色：
 *   `SpellVfx` 有一条硬规矩 —— 手里有 `SkillDef` 的地方一律走 `visualFor()`，
 *   `visualOf()` 不再被直接调用（读条是这个色、放出来是另一个色，
 *   玩家会读成 bug）。为了不在法阵这里开例外，本函数补的是**差额**：
 *   `ringShift - sig.tintShift`。`hueShifted` 只旋色相且保 S/L，
 *   两次偏移在色环上直接相加，最终等价于「从基色一次转到 ringShift」
 *   （`castTint.test.ts` 钉着这条等价，容差是 8 位量化的 0.006 色环）。
 *
 * ★ 纹章与外圈**反向**转。单层各自 ±0.08 已经封顶，但两层反向之后，
 *   「暖芯冷边」与「冷芯暖边」是两张一眼可分的脸，
 *   而每一层仍然待在自己属性的色域里。零成本、不碰红线。
 *   偏移为 0 的技能两层都不转 —— 与改造前逐位相同，是干净的基线。
 */
export const castCircleStyleOf = (
  tinted: AttributeVisual,
  sig: Pick<ResolvedSignature, 'tintShift' | 'scale'>,
  skillId?: string,
): CastCircleStyle => {
  const base = clamp(finite(sig.tintShift, 0), -TINT_CLAMP, TINT_CLAMP);
  const ringShift = circleTintShift(base);
  const motifShift = -ringShift;
  const scale = clamp(finite(sig.scale, 1), SCALE_CLAMP.min, SCALE_CLAMP.max);
  return {
    ringShift,
    motifShift,
    ringColor: hueShifted(tinted.primary, ringShift - base),
    motifColor: hueShifted(tinted.secondary, motifShift - base),
    circleScale: 1 + (scale - 1) * CIRCLE_SCALE_GAIN,
    motifScale: 1 + (scale - 1) * MOTIF_SCALE_GAIN,
    teeth: circleTeethOf(skillId),
  };
};
