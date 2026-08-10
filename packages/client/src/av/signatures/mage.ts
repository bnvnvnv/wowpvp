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
 *
 * ★★ X23 语义校准轮（2026-08-10，用户拍板「冰系应该是有结冰的声音，
 *   法系应该是有火焰燃烧的声音」）—— 本表逐条过完的结论：
 *   · **火系三条（烈焰爆 / 灼烧 / 陨星）本来就对**：它们要么回落学派的
 *     cast_fire / impact_fire，要么走 proj_fire + impact_fire（陨星），
 *     素材本身就是燃烧与爆燃，一条没改。如实记下来，免得后人以为漏了。
 *   · **冰系四条被改**：霜矢（叠层由肉响换碎冰）、霜爆新星（补碎冰层）、
 *     冰封庇护（钟摆换冰霜咏唱）、冰霜风暴（元素咆哮换冰霜咏唱）。
 *     共同的病根是同一个：P3 选音时优先满足「唯一性」，于是往学派之外去借，
 *     借来的东西好听但不是冰。冰系现在统一由 cast_frost / impact_frost /
 *     proj_frost / foot_snow_*（本轮才启用的碎冰质感）四种素材构成。
 *   · 奥术四条（变形术 / 瞬闪 / 断法 / 奥术冲击 / 近身元素斩）复核无误：
 *     变形术的 ui_sheep 是**真的有一只羊**，属于语义正确而非凑数，保留。
 * ⚠️ 仍是没有人耳听过的判断，只是这轮的判断有实测（ffprobe 逐条量的时长）
 *   垫底。真机终验仍挂在 X23。
 */

import { SignatureForm, type SkillSignature } from '../skillSignature.js';

export const signatures: Record<string, SkillSignature> = {
  // ── 核心循环键 ────────────────────────────────────────────────
  /**
   * 霜矢 —— 1.4 秒读条的主力输出。压低 12% 让它比所有瞬发冰霜键都「沉」，
   * 玩家不用看条也能听出「这是那发要站桩的」。命中叠一层碎冰：
   * 冰壳炸开（impact_frost）+ 冰碴落地（foot_snow_2），主力技才配得上两层命中。
   *
   * ★ X23 语义校准（2026-08-10）：叠层原是 `impact_flesh_2`（肉响）。
   *   用户口径「冰系应该是有结冰的声音」—— 霜矢打在人身上，玩家该听见的是
   *   **冰**在那个人身上结起来 / 碎开，而不是一记闷肉。`foot_snow_*`（踏雪）
   *   是盘上唯一的碎冰质感，0.31 秒的干脆瞬态，正好当第二层。
   */
  'mage.frostbolt': {
    castRate: 0.88,
    impactRate: 0.92,
    impactLayer: 'foot_snow_2',
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
   *
   * ★ X23 语义校准（2026-08-10）：补了一层 `foot_snow_3`。
   *   霜爆新星是本作**唯一把人冻在原地**的键，而原方案里「冻住」这件事
   *   全靠 impact_frost 一层低频承担 —— 低频说的是「合拢」，说不出「结冰」。
   *   踏雪的碎响叠在合拢音之上，脚被冻在地上的那一下才有材质。
   */
  'mage.frost_nova': {
    castSound: 'spell_nova',
    castRate: 0.95,
    impactRate: 0.8,
    impactLayer: 'foot_snow_3',
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
   * 为什么是这个声音/形态：起手回到学派的 cast_frost 并压到钳位下限 0.70 ——
   * 2.30 秒的冰霜咏唱拉成 **3.29 秒**，几乎正好盖满冰封的 4 秒，
   * 玩家听到的是「冰一层一层糊上来」而这层冰什么时候化也在同一条音里；
   * 冰裂（impact_frost 0.7，同为钳位下限）留给冰壳合拢那一下，
   * 再叠 buff_apply 说明「这是个增益，能被群驱」。
   * Orbit + 1.8 规模 = 整个人被环绕包住，与霜甲护盾同形态但大一圈 ——
   * 同一族防御技用同一个形，靠体量分主次。
   *
   * ★ X23 语义校准（2026-08-10）：原起手是 `temporal_clock`（钟摆）。
   *   「把自己从战斗里摘出去 = 时间停了」是个漂亮的解释，但玩家按的键叫
   *   **冰封**庇护，用户口径也点名了冰系要有结冰声 —— 一记钟摆声要求玩家先
   *   接受一层隐喻才能读懂，而冰裂不需要。
   * ★ 顺带收回了一个母题：temporal_clock 在别处是**急速/时间类**的专用记号
   *   （死骑疾行步、盗贼疾跑各一次），冰封庇护占着它会让那个记号失效。
   *   现在这三条互不打架。
   * ⚠️ castSound 刻意**不写**：回落学派音就是 cast_frost，写出来只会让
   *   「这条到底改没改音」看不出来（见文件头第二条 ★）。
   */
  'mage.ice_block': {
    castRate: 0.7,
    impactSound: 'impact_frost',
    impactRate: 0.7,
    impactLayer: 'buff_apply',
    tintShift: -0.07,
    scale: 1.8,
    form: SignatureForm.Orbit,
  },
  /**
   * ★★ 冰霜风暴（45 秒，0.8 读条 + 4 秒引导的封路技）。
   * 为什么是这个声音/形态：起手用学派的 cast_frost 慢放 0.78 当「风雪呼啸」的
   * 低频铺底（2.30 → **2.95 秒**，正好铺在 0.8 读条 + 4 秒引导这段 4.8 秒里，
   * 不抢也不断），每 0.5 秒一跳的命中反过来提速到 1.3 —— 细碎高频的冰粒密集落下，
   * 低起手 + 高跳数这个对比就是暴风雪的听感。Rain 形态是地基点名给暴风雪的。
   *
   * ★ X23 语义校准（2026-08-10）：原起手是 `mob_elemental_aggro_2`（元素咆哮）。
   *   一场暴风雪的开场不该是一头怪物在吼 —— 这是 X23 点名的 mob_* 借用里
   *   最说不通的一条（其余几条至少还有「号叫 / 亡灵」的字面借口）。
   *   慢放的冰霜咏唱本身就是风声，不需要借。
   * ⚠️ 仍然没用更贴题的 amb_snow / amb_wind_peaks：这轮用 ffprobe 量过，
   *   那两条各 **12.1 秒**且是环境**循环**，没有起音瞬态 —— 当技能音会糊成
   *   一团底噪，而且远长于整个引导。这条否决现在有数据，不再是占位判断。
   * ⚠️ 也刻意不给叠层：一次引导要响 8 跳，多一层就是噪音。
   * ⚠️ castSound 刻意不写：回落学派音即 cast_frost（见文件头第二条 ★）。
   */
  'mage.blizzard': {
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
