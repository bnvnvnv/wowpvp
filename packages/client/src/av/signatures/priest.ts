/**
 * P3 手写签名表 —— **牧师**（shared 数据 9.7，14 个技能）。
 *
 * ★ 分层原则（地基文件头「两层结构」的下半层）：
 *   - **大招/身份技**（冷却 ≥ 45s，外加惊惧尖啸这个牧师的 PvP 名片）：
 *     换专属音效文件 + 明显音高 + 二级形态 + 规模 —— 目标是「一听就知道是它」。
 *   - **核心循环键**：音高 ±10~25%、必要时叠层或形态，有个性但不抢戏。
 *   - **填充/工具键**：只微调音高与色相，靠推导层之上的一点点偏移站住身份。
 *
 * ★ 牧师的音色骨架是「两套嗓子」：神圣一侧全部走 cast_holy / cast_chain_heal /
 *   heal_impact / impact_holy，暗影一侧全部走 cast_shadow / impact_shadow。
 *   同一个文件在不同技能上靠**变速**拉开距离（例如 cast_chain_heal 在
 *   迅愈术是 1.22、治愈之环 0.88、镇痛庇佑 0.70 —— 首尾差了近一个八度，
 *   耳朵先分出「急救 / 群疗 / 罩人」，再去看画面）。这是刻意的：
 *   一个职业该有可辨认的**音色家族**，不是十四个互不相干的音效。
 *
 * ⚠️ 所有 castSound / impactSound / impactLayer 都是 `assets/music/sfx/` 的
 *   真实基名（**不含 .mp3**，带 _N 的变体后缀必须原样写全，如
 *   `mob_demon_aggro_1`）。priest.test.ts 逐键对磁盘校验，写错就红。
 *
 * ⚠️ 本表此刻还没被 `signatures/index.ts` 注册进运行时 —— 收口批次统一接线，
 *   这不是缺陷。
 *
 * ★★ X23 语义校准轮（2026-08-10）：**本表一条没改**，如实记下复核结论，
 *   免得后人以为漏审：
 *   · 神圣八条、暗影五条全部落在自己学派的素材上（cast_holy / cast_chain_heal /
 *     heal_impact / impact_holy ｜ cast_shadow / impact_shadow / wand_shadow_2），
 *     没有一条为了「唯一性」跑到学派外面借音 —— 这正是别的表这轮要改的病根。
 *   · 群体净化的 `ui_craft_disenchant` 是全表唯一一次动用 ui_* 素材，
 *     而「分解 = 把附在身上的魔法剥下来」在语义上就是群体驱散本身，
 *     属于**借得对**的那一类（对照组：盗贼那两条 ui_craft_* 借的是工作台，
 *     与技能动作无关，这轮换掉了）。
 *   · 惊惧尖啸的 `mob_demon_aggro_1` 保留：牧师的精神尖啸本就该是「不属于人」
 *     的嗓子。⚠️ 此前它与**战士破胆怒吼**同文件同倍速（0.78），两个职业的
 *     恐惧键开口一模一样；这轮改的是战士那条（战士是人，该用人形吼叫），
 *     本条因此自动脱离撞脸，数值一个字没动。
 * ⚠️ 仍未经人耳，真机终验挂在 X23。
 */

import { SignatureForm, type SkillSignature } from '../skillSignature.js';

export const signatures: Record<string, SkillSignature> = {
  // ── 神圣：输出与治疗 ───────────────────────────────────────────

  /** 圣光击 —— 0 冷却主输出，核心循环键：亮一档的圣光，但不许压过治疗 */
  'priest.smite': {
    castSound: 'cast_holy',
    castRate: 1.14,
    impactSound: 'impact_holy',
    impactRate: 1.1,
    tintShift: 0.03,
    scale: 1.05,
  },

  /** 迅愈术 —— 1.1 秒急救读条，核心键：治疗音提速到 1.22，听感就是「快」 */
  'priest.flash_heal': {
    castSound: 'cast_chain_heal',
    castRate: 1.22,
    impactSound: 'heal_impact',
    impactRate: 1.18,
    tintShift: -0.02,
  },

  /**
   * 续愈 —— 6 秒 HoT。放慢的治疗音 + 上升螺旋，让「持续回血」和
   * 「一口大奶」在没看血条时也能分开；buff_apply 叠层点出它是个可被偷的增益。
   */
  'priest.renew': {
    castSound: 'cast_holy',
    castRate: 0.86,
    impactSound: 'heal_impact',
    impactRate: 0.8,
    impactLayer: 'buff_apply',
    tintShift: -0.035,
    scale: 0.9,
    form: SignatureForm.Spiral,
  },

  /**
   * 护心屏障 —— 牧师最常按的保护键。清脆高音（1.26/1.32）= 盾「啪」一下成型，
   * buff_apply 叠层是仓库既定的上盾语汇；Orbit 环绕是护盾的教科书形态。
   */
  'priest.power_word_shield': {
    castSound: 'cast_holy',
    castRate: 1.26,
    impactSound: 'impact_holy',
    impactRate: 1.32,
    impactLayer: 'buff_apply',
    tintShift: 0.05,
    scale: 1.15,
    form: SignatureForm.Orbit,
  },

  /**
   * 净化术 —— 12 秒工具键，**故意只给轻签名**：不换文件、不给形态，
   * 只把学派音拨快一档。专属的「拆魔法」音色留给它的大哥群体净化，
   * 否则一场里按几十次的驱散会把大招的分量吃掉。
   */
  'priest.dispel_magic': {
    castRate: 1.32,
    impactRate: 1.34,
    tintShift: 0.07,
  },

  /**
   * 牵引之手 —— 把队友拽到脚边。命中音换成 `move_land_2`（落地闷响）：
   * 这一下响的不是法术，是**队友砸在你身边**，位移类技能的因果比法术色更重要。
   * 施法音不换文件、压到 0.94，与护心屏障（1.26）在同一条学派音上拉开。
   */
  'priest.leap_of_faith': {
    castRate: 0.94,
    impactSound: 'move_land_2',
    impactRate: 0.9,
    tintShift: 0.045,
  },

  /**
   * 治愈之环 —— 12 秒瞬发群疗，核心键。治疗音压慢到 0.88 = 铺开而不是点射，
   * impact_holy 叠层给圆环边缘一记亮边；Ring 对应它 12 米自身中心的圆。
   */
  'priest.circle_of_healing': {
    castSound: 'cast_chain_heal',
    castRate: 0.88,
    impactSound: 'heal_impact',
    impactRate: 0.92,
    impactLayer: 'impact_holy',
    tintShift: 0.025,
    scale: 1.25,
    form: SignatureForm.Ring,
  },

  // ── 神圣：大招 ────────────────────────────────────────────────

  /**
   * ★ 大招（60s）镇痛庇佑 —— 为什么是这个声音/形态：
   *   施法音把治疗音拉到钳位下限 0.70，与迅愈术的 1.22 差了近一个八度 ——
   *   同一副嗓子从「急救」变成「罩下来」，拖长的低音本身就是「别慌」的语义。
   *   命中音换成 `combat_block_2`：这是全仓库既有的「伤害被挡下」音，
   *   而镇痛庇佑做的就是减伤 40% —— 玩家听到的不是治疗，是**挡下**。
   *   Orbit 与护心屏障同族（都是套在人身上的保护），靠规模 1.5 与深沉音色分层：
   *   小盾是「啪」，庇佑是「罩」。
   */
  'priest.pain_suppression': {
    castSound: 'cast_chain_heal',
    castRate: 0.7,
    impactSound: 'combat_block_2',
    impactRate: 0.76,
    impactLayer: 'impact_holy',
    tintShift: 0.075,
    scale: 1.5,
    form: SignatureForm.Orbit,
  },

  /**
   * ★ 大招（45s）群体净化 —— 为什么是这个声音/形态：
   *   施法音 `spell_nova` 压到 0.82：它是地面 7 米的圆，起手就该是一记
   *   低沉铺开的波，而不是单体点射。命中音 `ui_craft_disenchant`（分解/剥离）
   *   是本表唯一一次动用它 —— 全局只有群体净化能拆掉完全免疫（10.x / 8.4），
   *   「把附在身上的魔法撕下来」这件事，磁盘上就这一个音说得清楚。
   *   Ring + 规模 1.6 对齐地面圆；impact_holy 叠层保住它仍是神圣学派。
   */
  'priest.mass_dispel': {
    castSound: 'spell_nova',
    castRate: 0.82,
    impactSound: 'ui_craft_disenchant',
    impactRate: 1.2,
    impactLayer: 'impact_holy',
    tintShift: 0.055,
    scale: 1.6,
    form: SignatureForm.Ring,
  },

  // ── 暗影 ─────────────────────────────────────────────────────

  /**
   * ★ 身份技（30s）惊惧尖啸 —— 为什么是这个声音/形态：
   *   冷却没到 45 秒，但它是牧师在 PvP 里最被记住的一个键，按 大招 规格给。
   *   施法音 `mob_demon_aggro_1` 压到 0.78 —— 恶魔仇恨嘶吼放慢后是一记
   *   低频的精神尖啸，比任何法术音更接近「这一下是往脑子里喊的」。
   *   命中音是 `cast_shadow` 拉到 0.72（暗影往外卷开），叠层
   *   `mob_humanoid_hurt_2` 是**被恐惧者的惊呼** —— 声音的主角在这一层
   *   从施法者换成受害者，这正是恐惧和其他 AOE 的区别。
   *   Ring + 规模 1.7（全表最大）对齐它 6 米自身中心的扩散。
   */
  'priest.psychic_scream': {
    castSound: 'mob_demon_aggro_1',
    castRate: 0.78,
    impactSound: 'cast_shadow',
    impactRate: 0.72,
    impactLayer: 'mob_humanoid_hurt_2',
    tintShift: -0.075,
    scale: 1.7,
    form: SignatureForm.Ring,
  },

  /**
   * 沉默 —— 核心控制键。暗影音提到 1.38（接近钳位上限）：高、短、掐断，
   * 与心灵爆破的 0.80 是同一副嗓子的两端。debuff_apply 叠层点出「挂上了减益」。
   * 不给形态：它是**掐掉对面的表现**，画面主角该在目标那边，不在自己身上。
   */
  'priest.silence': {
    castSound: 'cast_shadow',
    castRate: 1.38,
    impactSound: 'impact_shadow',
    impactRate: 1.36,
    impactLayer: 'debuff_apply',
    tintShift: -0.055,
  },

  /**
   * 精神穿刺 —— 魔杖 + 圣物方案专属，所以施法音就用魔杖音 `wand_shadow_2`：
   * 换了武器方案才有的技能，听起来就该像那把武器在响。
   */
  'priest.mind_spike': {
    castSound: 'wand_shadow_2',
    castRate: 1.18,
    impactSound: 'impact_shadow',
    impactRate: 1.1,
    tintShift: -0.03,
  },

  /**
   * 暗言术·痛 —— 0 冷却 DoT 填充键，只做音高与色相微调。
   * 一场里按最多的那个键不该有存在感，它的身份来自 12 秒的减益图标，不是音效。
   */
  'priest.shadow_word_pain': {
    castRate: 0.88,
    impactRate: 0.86,
    tintShift: -0.065,
  },

  /**
   * 心灵爆破 —— 7 秒节奏键。暗影音压到 0.80 给一记闷重的冲击，
   * `impact_arcane` 叠层加一层「精神/奥术」的脆响 —— 打的是脑子不是身体。
   */
  'priest.mind_blast': {
    castSound: 'cast_shadow',
    castRate: 0.8,
    impactSound: 'impact_shadow',
    impactRate: 0.78,
    impactLayer: 'impact_arcane',
    tintShift: -0.05,
    scale: 1.15,
  },
};
