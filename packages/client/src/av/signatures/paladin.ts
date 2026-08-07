/**
 * 圣骑士手写签名表（P3 技能签名批）。
 *
 * ★ 这张表回答的是「按下这个键，玩家听到/看到什么」——
 *   规则由 `shared/data/classes/paladin.ts` 说了算，这里一个字都不改它。
 *
 * ★ 分量分层（三档，档与档之间要能听出落差）：
 *   1. **大招 / 王牌**（冷却 ≥ 45s：守护庇佑 45、义愤 60、神圣壁障 90、
 *      虔诚光环 90、圣疗术 300）—— 换专属音效文件 + 明显音高 + 二级形态 +
 *      规模到 1.5~1.8。目标是「不看屏幕也知道对面开了什么」。
 *   2. **核心循环键**（圣印打击 / 裁决 / 圣愈术 / 荣光敕令 / 义盾撞 /
 *      圣殿重击 / 奉献 / 裁决之锤）—— 音高 ±10~20%、必要时叠一层 impactLayer，
 *      只有奉献（地面区域）和裁决之锤（关键控制，可读性优先）配了形态。
 *   3. **填充 / 工具键**（圣光弹 / 斥令 / 自由庇佑）—— 轻签名，不许喧宾夺主。
 *
 * ★ 圣骑士的音色主轴：**金属 + 圣光**。
 *   物理键走 `impact_metal_*`（板甲/战锤/盾），神圣键走 `wand_holy_*` /
 *   `impact_holy`，两者交叉叠层（如圣印打击的金属命中 + 圣光叠层）正是
 *   「圣印」「圣殿」这些技能名想表达的东西。治疗键单独走
 *   `cast_chain_heal` / `heal_impact` 家族。
 *
 * ⚠️ 每个音效键都是 `assets/music/sfx/` 下**去掉 .mp3 的精确基名**
 *   （有的带 _1 变体后缀、有的不带），已逐键对过磁盘；`paladin.test.ts`
 *   会再验一遍，写错文件名测试就红。
 *
 * ⚠️ 形态（form）用了 7 个 / 共 16 个技能，卡在「不超过一半」的纪律内 ——
 *   form 是重点标记，人人都有就等于没有。
 *
 * 注册由 `signatures/index.ts` 统一收口，本文件只导出表。
 */

import type { SkillSignature } from '../skillSignature.js';
import { SignatureForm } from '../skillSignature.js';

export const signatures: Record<string, SkillSignature> = {
  // ── 核心循环 ───────────────────────────────────────────────────

  /**
   * 圣印打击（物理，4.5s，圣能唯一来源之一）。
   * 全职业按得最勤的键：剑刃快挥 + 偏亮的金属命中，叠一记极短的圣光单音
   * ——「物理伤害但带圣印」在数据上没有体现（纯 Physical），音画上必须有，
   * 否则它和战士的普通挥砍无法区分。
   */
  'paladin.crusader_strike': {
    castSound: 'melee_swing_blade_3',
    castRate: 1.12,
    impactSound: 'impact_metal_1',
    impactRate: 1.15,
    impactLayer: 'wand_holy_1',
    tintShift: 0.03,
  },

  /**
   * 裁决（神圣，10s，锁定投射物 + 4 秒易伤）。
   * 甩出去的一记短促圣光（wand_holy_2 提速），落点用金属钝响当主音、
   * 圣光当叠层 —— 命中反馈要「砸得实」，因为它开的是增伤窗口，
   * 对手也需要听见这一下来判断该不该驱散。
   */
  'paladin.judgement': {
    castSound: 'wand_holy_2',
    castRate: 1.18,
    impactSound: 'impact_metal_3',
    impactRate: 0.86,
    impactLayer: 'impact_holy',
    tintShift: 0.05,
    scale: 1.15,
  },

  /**
   * 圣愈术（1.5s 读条大治疗，6s）。
   * 治疗家族的**基准音**：cast_chain_heal / heal_impact 原速微提。
   * 圣疗术（大招）是这一对音的降速放大版 —— 同一个家族、两个分量档，
   * 玩家听到「慢下来的圣愈术」就知道对面把一局一次的救场键交了。
   */
  'paladin.holy_light': {
    castSound: 'cast_chain_heal',
    castRate: 1.1,
    impactSound: 'heal_impact',
    impactRate: 1.12,
    tintShift: 0.02,
  },

  /**
   * 荣光敕令（瞬发，消耗 3 圣能，12s）。
   * 与圣愈术必须一耳分开：读条治疗是「拖出来的」，圣能治疗是「兑出来的」——
   * 所以走 wand_holy_1 的短促起手 + 明显提速的 heal_impact，
   * 再叠一层 impact_holy 表示圣能被消耗掉的那一下实体感。
   */
  'paladin.word_of_glory': {
    castSound: 'wand_holy_1',
    castRate: 1.15,
    impactSound: 'heal_impact',
    impactRate: 1.25,
    impactLayer: 'impact_holy',
    tintShift: 0.06,
    scale: 1.1,
  },

  /**
   * 裁决之锤（神圣昏迷 2.5s，30s）。
   * 冷却没到大招线，但**控制的可读性是对手的权利**（14.2）：抡锤的重挥 +
   * 沉下去的金属定音 + 一层震荡（spell_nova），配 ring 形态把「锤砸地」
   * 的冲击波画出来。被控的人应该在看到之前先听到。
   */
  'paladin.hammer_of_justice': {
    castSound: 'melee_swing_heavy_2',
    castRate: 1.1,
    impactSound: 'impact_metal_4',
    impactRate: 0.82,
    impactLayer: 'spell_nova',
    tintShift: 0.04,
    scale: 1.35,
    form: SignatureForm.Ring,
  },

  /**
   * 义盾撞（物理，9s，仅剑盾方案）。
   * 盾面推出（combat_block_1 提速）→ 金属命中 → 叠 buff_apply，
   * 因为它同时给自己上 4 秒减伤：一个键两件事，音效上也该是两层。
   * 色相往冷偏一点，和圣殿重击的暖金拉开。
   */
  'paladin.shield_of_the_righteous': {
    castSound: 'combat_block_1',
    castRate: 1.15,
    impactSound: 'impact_metal_2',
    impactRate: 1.1,
    impactLayer: 'buff_apply',
    tintShift: -0.03,
    scale: 1.2,
  },

  /**
   * 圣殿重击（物理 145% + 45 神圣，9s，仅双手战锤方案）。
   * 双手武器的慢挥（melee_swing_heavy_5 降速）+ 砸进躯体的钝响，
   * 神圣爆发做叠层 —— 数据里那 45 点 Holy 伤害在这里被听见。
   */
  'paladin.templar_strike': {
    castSound: 'melee_swing_heavy_5',
    castRate: 0.92,
    impactSound: 'impact_flesh_4',
    impactRate: 0.88,
    impactLayer: 'impact_holy',
    tintShift: -0.05,
    scale: 1.3,
  },

  /**
   * 奉献（8 秒地面区域，12s）。
   * 起手用 **impact 素材当 cast**：圣光是「砸进地面」的，不是从手里放出去的。
   * 每跳走轻飘的 proj_holy，配 rain 形态（持续区域的语义位）。
   */
  'paladin.consecration': {
    castSound: 'impact_holy',
    castRate: 0.78,
    impactSound: 'proj_holy',
    impactRate: 0.9,
    tintShift: 0.03,
    scale: 1.25,
    form: SignatureForm.Rain,
  },

  // ── 工具 / 填充键（轻签名） ────────────────────────────────────

  /**
   * 斥令（物理打断，15s，脱 GCD）。
   * 工具键：不换重音效，只要「快」—— 极短的轻挥 + 招架式的金属脆响，
   * 表达的是把法术**架开**而不是打伤对方。
   */
  'paladin.rebuke': {
    castSound: 'melee_swing_light_2',
    castRate: 1.3,
    impactSound: 'combat_parry_2',
    impactRate: 1.2,
    tintShift: -0.04,
    scale: 0.9,
  },

  /**
   * 自由庇佑（解除减速定身 + 3 秒免疫，20s）。
   * 轻签名：buff_apply 提速上扬 = 「挣脱」。给友方的增益不该盖过战斗音。
   */
  'paladin.blessing_of_freedom': {
    castSound: 'buff_apply',
    castRate: 1.28,
    impactRate: 1.2,
    tintShift: 0.07,
    scale: 1.05,
  },

  /**
   * 圣光弹（权杖方案的填充键，4.5s）。
   * 最轻的一档：只换法杖音（wand_holy_3 提速）+ 微调，
   * 因为它在权杖方案里几乎是白字，响一次没关系、响一百次不能烦。
   */
  'paladin.holy_bolt': {
    castSound: 'wand_holy_3',
    castRate: 1.22,
    impactRate: 1.12,
    tintShift: 0.02,
    scale: 0.95,
  },

  // ── 大招 / 王牌（冷却 ≥ 45s） ─────────────────────────────────

  /**
   * 守护庇佑（45s）——「金属罩子扣下来」。
   * 为什么是这个声音/形态：它是给**别人**套的物理免疫，不是自己的泡泡，
   * 所以起手是降到 0.78 的圣光低音（罩子落下的那一声），命中是压慢的
   * 金属定音（板甲成型），再叠 buff_apply 明示这是个增益；
   * orbit 形态把罩子画成绕着受益者转的环 —— 队友一眼看出「他现在打不动，
   * 也挨不动」。规模 1.5 而不是 1.8：它是三个 45s+ 防御里最轻的一个。
   */
  'paladin.blessing_of_protection': {
    castSound: 'wand_holy_3',
    castRate: 0.78,
    impactSound: 'impact_metal_2',
    impactRate: 0.8,
    impactLayer: 'buff_apply',
    tintShift: 0.04,
    scale: 1.5,
    form: SignatureForm.Orbit,
  },

  /**
   * 神圣壁障（90s）—— 职业身份技，「无敌泡泡」。
   * 为什么是这个声音/形态：spell_nova 压到 0.72 就是一圈从内向外撑开的
   * 罩壁（nova 的本体就是「瞬间铺开」，慢放后正是泡泡成型）；命中用
   * **格挡音** combat_block_3 —— 完全免疫在听感上就是「把所有东西一次挡下」，
   * 这比任何圣光音都准确。叠 buff_apply 标记增益身份。
   * orbit + 规模上限 1.8：这是全场最该被看见的四秒，对手必须立刻决定
   * 是拉开距离还是等它过期。
   */
  'paladin.divine_shield': {
    castSound: 'spell_nova',
    castRate: 0.72,
    impactSound: 'combat_block_3',
    impactRate: 0.75,
    impactLayer: 'buff_apply',
    tintShift: 0.05,
    scale: 1.8,
    form: SignatureForm.Orbit,
  },

  /**
   * 义愤（60s）—— 职业身份技，「翅膀」。
   * 为什么是这个声音/形态：需要一段**上扬的金色华彩**来宣告爆发窗口开启，
   * 盘上唯一具备这个纹理的是 ui_gather_legendary（传说品质拾取），
   * 降到 0.8 后长度和庄严度都对得上，采集与竞技场不同场景不会混淆 ——
   * ⚠️ 占位值：这是「用现有素材凑出对的纹理」，理想状态是一条专属的
   * 展翅音；换素材时保持「上扬 + 金色 + 约一秒」这三个特征即可。
   * 命中用提速的 spell_nova（羽翼张开推开空气），spiral 形态取地基注释
   * 里点名的「增益/蓄力」语义，规模 1.8 对应它 10 秒 +20% 的分量。
   */
  'paladin.avenging_wrath': {
    castSound: 'ui_gather_legendary',
    castRate: 0.8,
    impactSound: 'spell_nova',
    impactRate: 0.85,
    tintShift: 0.06,
    scale: 1.8,
    form: SignatureForm.Spiral,
  },

  /**
   * 圣疗术（300s）—— 一局只可能用一次的救场键。
   * 为什么是这个声音/形态：**刻意与圣愈术同族**（cast_chain_heal /
   * heal_impact），但两条都压到 0.7 —— 同一个治疗音降八度、拉长，
   * 玩家不需要学新音色就能听出「这是圣愈术的终极形态」，
   * 而不是又一个陌生的叮当声。叠一层 wand_holy_1 做高频亮点，
   * 免得慢音听起来发闷。pillar 形态是神圣天降的语义位：救场就该是
   * 一道从天上砸下来的光柱，规模拉满 1.8 —— 五分钟冷却值这个排场。
   */
  'paladin.lay_on_hands': {
    castSound: 'cast_chain_heal',
    castRate: 0.7,
    impactSound: 'heal_impact',
    impactRate: 0.7,
    impactLayer: 'wand_holy_1',
    tintShift: 0.04,
    scale: 1.8,
    form: SignatureForm.Pillar,
  },

  /**
   * 虔诚光环（90s，30 米团队减伤 6 秒）。
   * 为什么是这个声音/形态：它是**号令**不是护盾 —— 起手用降到 0.7 的
   * wand_holy_2，听感接近一记低沉的钟，比任何"嗖"的一声更像召集；
   * 落点用压慢的 buff_apply（一整队同时上增益），叠 impact_holy 补实体感。
   * form 用 ring 而不是 orbit：orbit 是贴在一个人身上的环绕，
   * 而虔诚光环是**一瞬间铺满 30 米**的水平扩散，ring 才是它。
   * 色相往冷白金偏（-0.05），与义愤的暖金（+0.06）拉开 ——
   * 圣骑士两个 60s+ 的金色大招不能长得一样。
   */
  'paladin.devotion_aura': {
    castSound: 'wand_holy_2',
    castRate: 0.7,
    impactSound: 'buff_apply',
    impactRate: 0.75,
    impactLayer: 'impact_holy',
    tintShift: -0.05,
    scale: 1.7,
    form: SignatureForm.Ring,
  },
};
