/**
 * 法师的手工签名表（P3 技能签名批）。
 *
 * ★★ 分量分层是这张表的骨架 —— 玩家的耳朵靠**落差**认技能，不靠每个键
 *   都很响：
 *   · **大招/身份技**（冰封庇护 90s、陨星 60s、冰霜风暴 45s、化形术）：
 *     换专属音效文件 + 明显音高 + 二级形态 + 规模，一听就知道是它。
 *   · **核心循环键**（霜矢、烈焰爆、霜爆新星、断法、霜甲护盾、冰锥术）：
 *     音高 ±10~20%，必要时叠一层命中音或上形态，个性有但不抢戏。
 *   · **填充/工具键**（冰枪术、灼烧、奥术冲击、瞬闪、近身元素斩）：
 *     只做音高/色相微调 —— 这几个键一局要按几十次，喧宾夺主就是噪音。
 *
 * ★ 只写「与学派默认不同」的音效键。学派默认见 AudioManager 的
 *   CAST_SOUND / IMPACT_SOUND（frost=cast_frost/impact_frost、
 *   fire=cast_fire/impact_fire、arcane=cast_arcane/impact_arcane）——
 *   把默认值再抄一遍进表里只会让「这条到底改没改音」看不出来。
 *
 * ⚠️ 每个音效键都是 `assets/music/sfx/` 里的**精确基名**（部分素材带 _1/_2
 *   变体后缀，部分不带），已对着磁盘核过；`mage.test.ts` 逐键复验。
 *
 * ⚠️ 表现层专用：本文件只描述声音与粒子，不参与任何伤害/冷却/AI 计算。
 */

import { SignatureForm, type SkillSignature } from '../skillSignature.js';

export const signatures: Record<string, SkillSignature> = {
  // ── 核心循环键 ────────────────────────────────────────────────
  /**
   * 霜矢 —— 1.4 秒读条的主力输出。压低 12% 让它比所有瞬发冰霜键都「沉」，
   * 玩家不用看条也能听出「这是那发要站桩的」。命中叠一层肉响：
   * 冰壳碎 + 实打的闷响，主力技才配得上两层命中。
   */
  'mage.frostbolt': {
    castRate: 0.88,
    impactRate: 0.92,
    impactLayer: 'impact_flesh_2',
    tintShift: -0.03,
  },
  /** 烈焰爆 —— 8 秒瞬发爆发件。提速 28% 的急促感 = 「按下就出去了」 */
  'mage.fire_blast': {
    castRate: 1.28,
    impactRate: 1.18,
    tintShift: 0.05,
    scale: 1.1,
  },
  /**
   * 霜爆新星 —— 法师的保命控制键，也是「新星」这个词在本作里的原型。
   * ★ 为什么是这个声音/形态：spell_nova 是素材库里唯一的新星专用音，
   *   WoW 玩家对「新星 = 一圈扩散」的肌肉记忆直接对上 Ring 形态；
   *   命中降到 0.8 是冰壳合拢的低频，2 秒定身的分量得听得出来。
   */
  'mage.frost_nova': {
    castSound: 'spell_nova',
    castRate: 0.95,
    impactRate: 0.8,
    tintShift: -0.05,
    scale: 1.3,
    form: SignatureForm.Ring,
  },
  /**
   * 断法 —— 4 秒学派锁定（全职业唯一）。
   * 用金属命中层慢放 0.82 当「铁闸落下」：断法真正的分量不在伤害（它没伤害），
   * 而在对面那 4 秒不能用这一系 —— 一记闷响的铁门比任何法术音都贴。
   */
  'mage.counterspell': {
    castRate: 1.18,
    impactSound: 'impact_metal_2',
    impactRate: 0.82,
    tintShift: -0.04,
  },
  /**
   * 霜甲护盾 —— 上盾走通用 buff_apply，再叠一层冰裂：
   * 「盾起来了」的通用提示 + 「这是冰盾」的材质，两层各管一件事。
   * Orbit 形态是地基给护盾/光环留的位置（见 skillSignature.ts 的形态注释）。
   */
  'mage.ice_barrier': {
    castRate: 1.05,
    impactSound: 'buff_apply',
    impactRate: 0.9,
    impactLayer: 'impact_frost',
    tintShift: -0.04,
    scale: 1.15,
    form: SignatureForm.Orbit,
  },
  /** 冰锥术 —— 面前 90 度喷寒气：投射物音慢放 0.85 = 一股喷出去的寒流 */
  'mage.cone_of_cold': {
    castSound: 'proj_frost',
    castRate: 0.85,
    impactRate: 1.12,
    tintShift: -0.06,
    scale: 1.2,
  },

  // ── 大招 / 身份技 ─────────────────────────────────────────────
  /**
   * ★★ 化形术 —— 冷却只有 15 秒，但它是**法师的身份技**：一局里最贵的那次
   * 按键是它，不是任何一发伤害。
   * 为什么是这个声音/形态：ui_sheep 就是「羊」本身，没有第二个候选 ——
   * WoW 玩家听到羊叫的瞬间就知道场上少了一个人；再叠一层通用 debuff_apply，
   * 让「中控了」这件事在羊叫之外还有一记硬提示（队友误伤解控的判断靠它）。
   * Spiral 形态取的是「卷绕」的形（目标被卷进漩涡再变出来）——
   * ⚠️ 地基把 spiral 归给「增益/蓄力」，这里借的是它的形不是它的语义，
   *   后人若要给形态做语义分流，这条是第一个该重看的。
   */
  'mage.polymorph': {
    castRate: 1.12,
    impactSound: 'ui_sheep',
    impactRate: 0.95,
    impactLayer: 'debuff_apply',
    tintShift: 0.06,
    scale: 1.25,
    form: SignatureForm.Spiral,
  },
  /**
   * ★★ 冰封庇护（90 秒，法师最贵的一个键）。
   * 为什么是这个声音/形态：冰封 4 秒的本质不是「变硬」，是把自己从这场
   * 战斗里**摘出去** —— temporal_clock 慢到 0.72 的钟摆停摆感比任何冰裂声
   * 都贴这层语义（时间停在这儿了）；冰裂（impact_frost 0.7，钳位下限）留给
   * 冰壳合拢那一下，再叠 buff_apply 说明「这是个增益，能被群驱」。
   * Orbit + 1.8 规模 = 整个人被环绕包住，与霜甲护盾同形态但大一圈 ——
   * 同一族防御技用同一个形，靠体量分主次。
   */
  'mage.ice_block': {
    castSound: 'temporal_clock',
    castRate: 0.72,
    impactSound: 'impact_frost',
    impactRate: 0.7,
    impactLayer: 'buff_apply',
    tintShift: -0.07,
    scale: 1.8,
    form: SignatureForm.Orbit,
  },
  /**
   * ★★ 冰霜风暴（45 秒，0.8 读条 + 4 秒引导的封路技）。
   * 为什么是这个声音/形态：起手用元素咆哮慢放 0.78 当「风雪呼啸」的低频铺底，
   * 每 0.5 秒一跳的命中反过来提速到 1.3 —— 细碎高频的冰粒密集落下，
   * 低起手 + 高跳数这个对比就是暴风雪的听感。Rain 形态是地基点名给暴风雪的。
   * ⚠️ 没用更贴题的 amb_snow / amb_wind_peaks：那两个是 189KB 的环境**循环**，
   *   没有起音瞬态，当技能音会糊成一团底噪（占位判断，真机听感后可复议）。
   * ⚠️ 也刻意不给叠层：一次引导要响 8 跳，多一层就是噪音。
   */
  'mage.blizzard': {
    castSound: 'mob_elemental_aggro_2',
    castRate: 0.78,
    impactSound: 'impact_frost',
    impactRate: 1.3,
    tintShift: -0.06,
    scale: 1.55,
    form: SignatureForm.Rain,
  },
  /**
   * ★★ 陨星（60 秒，法师最高的一次单体爆发）。
   * 为什么是这个声音/形态：起手不用学派通用的 cast_fire，改用火焰投射物音
   * 慢放 0.72 —— 玩家听到的是「一颗很大的东西正在坠下来」，而不是「又一次
   * 火系读条」；落地把 impact_fire 压到钳位下限 0.7 做最厚的火爆，再叠一记
   * combat_crit_3 的裂响表示「砸实了」。Rain 形态是地基点名给陨星前摇的
   * （落点与倒计时全程可见，是 14.3 的硬承诺），1.8 规模是全职业最大的一档。
   */
  'mage.meteor': {
    castSound: 'proj_fire',
    castRate: 0.72,
    impactSound: 'impact_fire',
    impactRate: 0.7,
    impactLayer: 'combat_crit_3',
    tintShift: 0.07,
    scale: 1.8,
    form: SignatureForm.Rain,
  },

  // ── 填充 / 工具键（轻签名，别抢戏）──────────────────────────────
  /** 冰枪术 —— 无冷却填充，一局按几十次：提速 + 缩小成一记很薄的「叮」 */
  'mage.ice_lance': {
    castRate: 1.32,
    impactRate: 1.3,
    tintShift: 0.02,
    scale: 0.85,
  },
  /** 灼烧 —— 3 秒冷却的火系填充：比冰枪略钝一点，两个填充键才分得开 */
  'mage.scorch': {
    castRate: 1.22,
    impactRate: 1.24,
    tintShift: 0.03,
    scale: 0.9,
  },
  /** 奥术冲击 —— 自身中心清场：命中压低 + 规模放大，是「一圈推开」的体感；不上 Ring 形态，把新星的招牌留给霜爆新星 */
  'mage.arcane_explosion': {
    castRate: 1.08,
    impactRate: 0.9,
    tintShift: 0.07,
    scale: 1.25,
  },
  /**
   * 瞬闪 —— 没有命中，整个技能就是那一下起手音。
   * 奥术投射物音顶到钳位上限 1.4 = 一闪而过；规模压到 0.8，位移不该有体量。
   */
  'mage.blink': {
    castSound: 'proj_arcane',
    castRate: 1.4,
    tintShift: 0.07,
    scale: 0.8,
  },
  /**
   * 近身元素斩 —— 只有「法刃 + 元素焦点」方案才有的近战键。
   * 换刀刃挥击音是这条的全部意义：它必须先听起来像**近战**，
   * 再听起来像法师（奥术命中 + 肉响叠层）。
   */
  'mage.elemental_slash': {
    castSound: 'melee_swing_blade_3',
    castRate: 1.12,
    impactRate: 1.06,
    impactLayer: 'impact_flesh_1',
    tintShift: 0.04,
  },
};
