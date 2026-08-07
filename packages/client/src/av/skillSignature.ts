/**
 * P3 技能签名（音效 + 特效）的**类型与解析器地基**。
 *
 * ★★ 为什么放客户端而不是 shared 的 `vfx` 字段：
 *   签名引用的是**盘上音效文件名**与**客户端特效形态** —— 全是表现层资产的
 *   坐标。塞进 shared 数据会让规则层背上「资产存不存在」的校验责任，而
 *   `skillIconMap.ts`（图标 → 磁盘路径，含断链测试）已经证明过正确的分层：
 *   **shared 说这个技能是什么，client 说它长什么样、什么声音。**
 *   schema.ts 里那个从 P4b 就零读取的 `vfx?: string` 死字段随本批删除。
 *
 * ★ 两层结构（缺一不可）：
 *   1. **推导默认值** —— 每个技能按 id 的确定性散列拿到一组微小的
 *      音高/色相偏移。⚠️ 第一版散列空间只有 13×13×7=1183 组合，
 *      117 个技能实测撞出 3 对完全相同（FW-A 的全局唯一性测试首跑抓到，
 *      生日问题的必然不是运气）—— 现已加宽到 41×41×17≈2.9 万组合，
 *      期望撞车 < 0.3 对。**唯一性不靠概率靠门禁**：
 *      `signatures/integrity.test.ts` 对全部技能做两两比对，撞了就红。
 *   2. **手写签名表**（`signatures/<职业>.ts`）—— 大招/核心键的专属
 *      表达：换音效文件、明显的音高、二级形态。手写项覆盖推导值。
 *
 * ⚠️ 所有音效键必须是 `assets/music/sfx/` 里真实存在的基名 ——
 *   `signatures/integrity.test.ts` 逐键对磁盘验证，引用不存在的文件
 *   测试就红。这是 M12「素材零断链」纪律在音频上的延伸。
 */

import type { School, SkillDef } from '@wowpvp/shared';

/** 二级形态：叠在八属性基座之上的**技能级**粒子编排（由 SpellVfx 实现） */
export const SignatureForm = {
  /** 不加二级形态（默认）—— 只有音高/色相/规模签名 */
  None: 'none',
  /** 水平扩散环 —— 新星/震荡类（冰霜新星、雷霆一击） */
  Ring: 'ring',
  /** 上升螺旋 —— 增益/蓄力类（嗜血、复仇者之怒） */
  Spiral: 'spiral',
  /** 锐利碎片放射 —— 物理暴发/斩杀类（致死打击、刺骨） */
  Shards: 'shards',
  /** 自上而下的落雨 —— 持续区域类（暴风雪、陨星前摇） */
  Rain: 'rain',
  /** 垂直光柱 —— 神圣审判/惩击类 */
  Pillar: 'pillar',
  /** 环绕轨道粒子 —— 护盾/光环类（冰盾、复仇圣盾） */
  Orbit: 'orbit',
} as const;
export type SignatureForm = (typeof SignatureForm)[keyof typeof SignatureForm];

/**
 * 一条手写签名。每个字段都可省 —— 省掉的落回推导默认值。
 * ⚠️ 数值范围会在 `resolveSignature` 里钳位（写出界不是崩溃而是被夹回，
 *   钳位范围的理由见下方常量注释）。
 */
export interface SkillSignature {
  /** 施法/释放音（盘上基名，如 'cast_lightning_bolt'、'ui_sheep'） */
  castSound?: string;
  /** 施法音变速。1 = 原速；偏离越多个性越强，钳位见 RATE_CLAMP */
  castRate?: number;
  /** 命中音（盘上基名） */
  impactSound?: string;
  impactRate?: number;
  /**
   * 命中时**叠加**的第二层音（必须与 impactSound 不同名 ——
   * AudioManager.play 的 40ms 同名去重会吃掉同名层，见那边 :70 注释）
   */
  impactLayer?: string;
  /** 色相偏移（-1..1 的色环比例）。钳位 ±TINT_CLAMP，保证属性仍可辨 */
  tintShift?: number;
  /** 粒子规模乘数。钳位 SCALE_CLAMP —— 上限护住粒子池（X9 饱和度前科） */
  scale?: number;
  /** 二级形态 */
  form?: SignatureForm;
}

/** 解析完成的签名：所有字段必填（默认值已合并、越界已钳位） */
export interface ResolvedSignature {
  castSound: string | undefined; // undefined = 沿用学派施法音
  castRate: number;
  impactSound: string | undefined; // undefined = 沿用学派命中音
  impactRate: number;
  impactLayer: string | undefined;
  tintShift: number;
  scale: number;
  form: SignatureForm;
}

/**
 * ★ 钳位常量的出处：
 * - RATE：0.7–1.4 —— 超过这个区间人耳听出来的是「播放器坏了」而不是
 *   「另一个技能」（0.5x 的 cast_fire 像倒带）。占位值，真机听感后可调。
 * - TINT：±0.08 色环 —— 再大就跨进相邻属性的色域（火→自然只差 ~0.15），
 *   八属性一眼可辨是 14.2 的硬承诺，签名不许打穿它。
 * - SCALE：0.6–1.8 —— 上限是粒子池预算（事件池 40×48，X9），
 *   1.8 倍的大招爆发实测不顶穿池子；下限保证小技能仍可见。
 */
export const RATE_CLAMP = { min: 0.7, max: 1.4 } as const;
export const TINT_CLAMP = 0.08;
export const SCALE_CLAMP = { min: 0.6, max: 1.8 } as const;

const clamp = (v: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, v));

/**
 * 确定性散列（FNV-1a 32 位）。
 * ★ 不用 Math.random：同一个技能在任何机器任何一局都必须是同一个声音 ——
 *   签名是**身份**，不是随机装饰（变体轮换是 AudioManager.playVariant
 *   的职责，两者别混）。
 */
const hash32 = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

/**
 * 推导默认签名：微音高（±6%）+ 微色相（±0.03）。
 * ★ 幅度刻意小于手写签名的常用幅度 —— 推导层的任务是「不撞车」，
 *   「有个性」是手写层的任务。两层观感有落差，玩家才能感到大招的分量。
 */
const derivedOf = (skillId: string): ResolvedSignature => {
  const h = hash32(skillId);
  return {
    castSound: undefined,
    // 0.90–1.10，步进 0.5% —— 41 档。此前 13 档 ×1% 的空间不够
    // （见文件头 ⚠️），三个维度取**不重叠的位段**避免相关性
    castRate: 1 + (((h % 41) - 20) / 200),
    impactSound: undefined,
    impactRate: 1 + ((((h >>> 7) % 41) - 20) / 200),
    impactLayer: undefined,
    tintShift: (((h >>> 14) % 17) - 8) / 200, // -0.04–+0.04，17 档
    scale: 1,
    form: SignatureForm.None,
  };
};

/**
 * 手写签名注册表。`signatures/index.ts` 在模块加载时灌入
 * （八个职业文件 + common），这里只持有引用 —— 保持依赖单向：
 * signatures/* → 本文件，本文件不 import 任何职业表。
 */
const registry = new Map<string, SkillSignature>();

export const registerSignatures = (table: Record<string, SkillSignature>): void => {
  for (const [id, sig] of Object.entries(table)) registry.set(id, sig);
};

/** 测试用：注册表快照（integrity.test 逐键对磁盘验证） */
export const registeredSignatureEntries = (): [string, SkillSignature][] =>
  [...registry.entries()];

/** 解析：手写覆盖推导，越界钳位。任何 skillId 都有结果（推导层兜底） */
export const resolveSignature = (skillId: string): ResolvedSignature => {
  const base = derivedOf(skillId);
  const hand = registry.get(skillId);
  if (!hand) return base;
  return {
    castSound: hand.castSound ?? base.castSound,
    castRate: clamp(hand.castRate ?? base.castRate, RATE_CLAMP.min, RATE_CLAMP.max),
    impactSound: hand.impactSound ?? base.impactSound,
    impactRate: clamp(hand.impactRate ?? base.impactRate, RATE_CLAMP.min, RATE_CLAMP.max),
    impactLayer: hand.impactLayer,
    tintShift: clamp(hand.tintShift ?? base.tintShift, -TINT_CLAMP, TINT_CLAMP),
    scale: clamp(hand.scale ?? base.scale, SCALE_CLAMP.min, SCALE_CLAMP.max),
    form: hand.form ?? base.form,
  };
};

/**
 * 便捷入口：从 SkillDef 解析（调用方大多手里是 def）。
 * school 一并带回 —— 音频/特效的兜底都要它。
 */
export const signatureOf = (
  skill: Pick<SkillDef, 'id' | 'school'>,
): ResolvedSignature & { school: School } => ({
  ...resolveSignature(skill.id as string),
  school: skill.school,
});
