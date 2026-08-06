/**
 * M12：91 个技能 → 真实图标（`assets/art/ui/skills/**`，来源见 docs/09 §4）。
 *
 * ★★ **为什么是一张手写表，而不是「按 id 猜文件名」：**
 *
 *   42 个技能的 id 与上游图标文件名恰好一致（两边都源自同一类命名传统），
 *   但剩下 49 个需要**逐个的语义判断**（断腿斩用哪张、缚魂拽长什么样）——
 *   猜名算法对它们只会静默落空。把 91 条全部写死成数据，配一条
 *   「每个技能都有一行」的测试，加技能时漏配图标就是**红灯**而不是空窗。
 *
 * ★ 命名不巧合的 49 条按「语义最近」手工挑选（◆ 标注），
 *   并保证**同职业内两两不同**（与程序化图标 `accentOf` 同一条纪律，
 *   `skillIconMap.test.ts` 守着）。跨职业允许复用 —— 技能栏一次只显示一个职业。
 *
 * ★ 这张表**只是外观**。学派、瞄准方式、施放方式的信息通道
 *   仍由技能栏槽位（`--school` 边框、名称、元数据行）承担，
 *   素材缺失时整体回落到程序化 SVG（`skillIcon.ts`），信息不减一分。
 */

/** 相对 `/art/ui/skills/` 的路径（无扩展名，运行时补 `.webp`） */
export const SKILL_ICON_FILES: Readonly<Record<string, string>> = {
  // ── 战士 ──────────────────────────────────────────────────────
  'warrior.charge': 'warrior/charge',
  'warrior.mortal_strike': 'warrior/mortal_strike',
  'warrior.hamstring': 'warrior/hamstring',
  'warrior.storm_bolt': 'warrior/storm_bolt',
  'warrior.pummel': 'warrior/pummel',
  'warrior.intervene': 'warrior/raised_guard', // ◆ 盾面挡下飞溅 —— 替队友格挡
  'warrior.defensive_stance': 'warrior/defensive_stance',
  'warrior.bladestorm': 'warrior/bladestorm',
  'warrior.shield_slam': 'warrior/shield_slam',
  'warrior.cleave': 'warrior/cleave',
  'warrior.combo_storm': 'warrior/whirlwind', // ◆ 武器授予技：连续旋斩
  // P3b 扩充：怒气倾泻口、抗法爆窗口、打断集火的群体恐惧
  'warrior.heroic_strike': 'warrior/heroic_strike',
  'warrior.spell_reflection': 'warrior/iron_resolve', // ◆ 硬守化解 —— 承伤锐减
  'warrior.intimidating_shout': 'warrior/intimidating_shout',

  // ── 圣骑士 ────────────────────────────────────────────────────
  'paladin.crusader_strike': 'paladin/seal_of_righteousness', // ◆ 圣印蓄力的武器击
  'paladin.judgement': 'paladin/judgement',
  'paladin.holy_light': 'paladin/holy_light',
  'paladin.word_of_glory': 'paladin/flash_of_light', // ◆ 瞬发圣光治疗
  'paladin.hammer_of_justice': 'paladin/hammer_of_justice',
  'paladin.rebuke': 'warrior/taunt', // ◆ 训斥的呵止
  'paladin.blessing_of_freedom': 'paladin/blessing_of_might', // ◆ 唯一的祝福手图标
  'paladin.blessing_of_protection': 'paladin/devotion_aura', // ◆ 金色守护罩
  'paladin.divine_shield': 'paladin/divine_protection', // ◆ 经典的无敌泡
  'paladin.avenging_wrath': 'paladin/righteous_fury', // ◆ 圣怒展翼
  'paladin.shield_of_the_righteous': 'warrior/shield_slam', // ◆ 盾面撞击（跨职业复用）
  'paladin.templar_strike': 'warrior/heroic_strike', // ◆ 双手武器高举下劈
  'paladin.holy_bolt': 'paladin/exorcism', // ◆ 圣光轰击
  // P3b 扩充：控场地面区域、一局一次的救场、押爆发的团队减伤
  'paladin.consecration': 'paladin/consecration',
  'paladin.lay_on_hands': 'paladin/lay_on_hands',
  // ◆ 光环同族 —— `paladin/devotion_aura` 已被 blessing_of_protection 占用（同职业不得重复）
  'paladin.devotion_aura': 'paladin/retribution_aura',

  // ── 死亡骑士（上游无此职业目录，按主题从邻近职业取）──────────
  'deathknight.obliterate': 'warrior/execute', // ◆ 处决式重斩
  'deathknight.death_strike': 'warlock/drain_life', // ◆ 伤害并回血 —— 汲取
  'deathknight.death_grip': 'priest/mind_flay', // ◆ 暗影丝线牵拽
  'deathknight.chains_of_ice': 'shaman/frost_shock', // ◆ 寒霜缠缚
  'deathknight.strangulate': 'rogue/garrote', // ◆ 扼喉（绞索）
  'deathknight.mind_freeze': 'mage/brain_freeze', // ◆ 「冻结的头脑」—— 冻念
  'deathknight.anti_magic_shell': 'warlock/demon_skin', // ◆ 暗色硬壳
  'deathknight.deaths_advance': 'rogue/sprint', // ◆ 疾行
  'deathknight.winter_domain': 'mage/rings_of_frost', // ◆ 以自身为心的霜环
  'deathknight.frost_strike_fast': 'mage/ice_lance', // ◆ 快速冰刺
  'deathknight.rune_ward': 'mage/rune_of_power', // ◆ 符文护体
  // P3b 扩充：疫病持续伤害、治疗压制、群体减速
  'deathknight.plague_strike': 'warlock/corruption', // ◆ 暗影腐蚀持续侵蚀
  'deathknight.necrotic_strike': 'warlock/curse_of_agony', // ◆ 缠身不散的痛苦
  'deathknight.howling_blast': 'mage/glacial_front', // ◆ 扑面推开的冰霜锋面

  // ── 盗贼 ──────────────────────────────────────────────────────
  'rogue.stealth': 'rogue/stealth',
  'rogue.backstab': 'rogue/backstab',
  'rogue.eviscerate': 'rogue/eviscerate',
  'rogue.kidney_shot': 'rogue/kidney_shot',
  'rogue.shadowstep': 'rogue/ambush', // ◆ 自暗处现身出刀
  'rogue.kick': 'rogue/gouge', // ◆ 快速的贴脸打击
  'rogue.poisoned_blade': 'rogue/deadly_poison', // ◆ 淬毒之刃
  'rogue.smoke_bomb': 'rogue/blind', // ◆ 掷出的致盲粉 —— 视觉同为烟尘
  'rogue.evasion': 'rogue/evasion',
  'rogue.vanish': 'rogue/vanish',
  'rogue.blade_flurry': 'rogue/slice_and_dice', // ◆ 连环挥舞
  'rogue.riposte': 'rogue/sinister_strike', // ◆ 招架后的还刺
  // P3b 扩充：脱战先手控制、物理流血、受伤即解的脱身控制
  'rogue.cheap_shot': 'rogue/cheap_shot',
  'rogue.rupture': 'rogue/rupture',
  // ◆ 制服目标使其无法行动 —— 与致盲同为「受伤即解」的失能，
  //   `rogue/blind` 已被 smoke_bomb 占用（同职业不得重复）
  'rogue.blind': 'rogue/sap',

  // ── 猎人 ──────────────────────────────────────────────────────
  // hunter.auto_shot 已于 M14 删除 —— 自动射击回归 7.6 挥击系统，不再是按钮技能
  'hunter.aimed_shot': 'hunter/aimed_shot',
  'hunter.arcane_shot': 'hunter/arcane_shot',
  'hunter.concussive_shot': 'hunter/concussive_shot',
  'hunter.freezing_trap': 'mage/frozen_orb', // ◆ 置于地面的冰球
  'hunter.flare': 'druid/faerie_fire', // ◆ 揭露潜行的光标记 —— 语义同源
  'hunter.disengage': 'hunter/aspect_of_the_monkey', // ◆ 灵巧的闪避身法
  'hunter.counter_shot': 'hunter/serpent_sting', // ◆ 一支打向咽喉的箭
  'hunter.exhilaration': 'warrior/second_wind', // ◆ 回气自愈
  'hunter.aspect_of_the_turtle': 'warrior/iron_resolve', // ◆ 硬守化解
  'hunter.piercing_bolt': 'hunter/mongoose_bite', // ◆ 握持重矢 —— 武器授予技
  // P3b 扩充：补上「被贴脸时无键可按」的空白 + 持续伤害 + 逃跑
  'hunter.wing_clip': 'hunter/wing_clip',
  'hunter.raptor_strike': 'hunter/raptor_strike',
  // ◆ 淬毒之矢 —— `hunter/serpent_sting` 已被 counter_shot 占用（同职业不得重复）
  'hunter.serpent_sting': 'rogue/instant_poison',
  'hunter.aspect_of_the_cheetah': 'hunter/aspect_of_the_cheetah',

  // ── 法师 ──────────────────────────────────────────────────────
  'mage.frostbolt': 'mage/frostbolt',
  'mage.fire_blast': 'mage/fire_blast',
  'mage.polymorph': 'mage/polymorph',
  'mage.frost_nova': 'mage/frost_nova',
  'mage.blink': 'mage/blink',
  'mage.counterspell': 'mage/counterspell',
  'mage.ice_barrier': 'mage/ice_barrier',
  'mage.ice_block': 'mage/ice_block',
  'mage.blizzard': 'mage/blizzard',
  'mage.meteor': 'mage/meteor',
  'mage.elemental_slash': 'mage/arcane_surge', // ◆ 近身的奥能爆发 —— 武器授予技
  // P3b 扩充：瞬发填充与群体减速（技能审计的头号缺口）
  'mage.ice_lance': 'mage/ice_lance',
  'mage.cone_of_cold': 'mage/flurry', // ◆ 扑面而来的碎冰 —— 锥形寒气
  'mage.scorch': 'mage/scorch',
  'mage.arcane_explosion': 'mage/arcane_explosion',

  // ── 牧师 ──────────────────────────────────────────────────────
  'priest.smite': 'priest/smite',
  'priest.flash_heal': 'priest/flash_heal',
  'priest.renew': 'priest/renew',
  'priest.power_word_shield': 'priest/power_word_shield',
  'priest.dispel_magic': 'priest/power_word_fortitude', // ◆ 圣言涤净
  'priest.psychic_scream': 'warlock/fear', // ◆ 惊惧奔逃
  'priest.silence': 'warlock/curse_of_agony', // ◆ 暗影封口
  'priest.leap_of_faith': 'priest/heal', // ◆ 伸向队友的手
  'priest.pain_suppression': 'mage/warded', // ◆ 结晶护盾 —— 承伤锐减
  'priest.mass_dispel': 'mage/collective_reversal', // ◆ 群体性的逆转法阵
  'priest.mind_spike': 'priest/mind_blast', // ◆ 精神轰击
  // P3b 扩充：暗影持续伤害、瞬发爆发、群体治疗
  'priest.shadow_word_pain': 'priest/shadow_word_pain',
  // ◆ 一发暗影爆冲 —— `priest/mind_blast` 已被 mind_spike 占用（同职业不得重复）
  'priest.mind_blast': 'warlock/shadow_bolt',
  'priest.circle_of_healing': 'priest/lesser_heal', // ◆ 铺开的柔和治疗光

  // ── 德鲁伊 ────────────────────────────────────────────────────
  'druid.moonfire': 'druid/moonfire',
  'druid.healing_touch': 'druid/healing_touch',
  'druid.rejuvenation': 'druid/rejuvenation',
  'druid.entangling_roots': 'druid/entangling_roots',
  'druid.cyclone': 'druid/insect_swarm', // ◆ 绿色的环绕气旋
  'druid.skull_bash': 'druid/bash', // ◆ 重击打断
  'druid.barkskin': 'druid/barkskin',
  'druid.bear_form': 'druid/bear_form',
  'druid.cat_form': 'druid/cat_form',
  'druid.wild_charge': 'druid/bear_charge', // ◆ 野性冲锋
  'druid.stampeding_roar': 'druid/demoralizing_roar', // ◆ 震场怒吼
  // P3b 扩充：人形态下终于有了能一直按的填充键 + 控住后的重击 + 减伤
  'druid.wrath': 'druid/wrath',
  // ◆ 上游没有 starsurge 图标，沿用 starfire 的星辰爆发图 —— 同为「牵引星力」，
  //   且原先占用它的星火术已被本技能取代，不构成同职业重复
  'druid.starsurge': 'druid/starfire',
  'druid.thorns': 'druid/thorns',
};

/** 技能图标 URL；没有映射时返回 undefined（回落程序化 SVG） */
export const skillIconUrl = (skillId: string): string | undefined => {
  const file = SKILL_ICON_FILES[skillId];
  return file === undefined ? undefined : `/art/ui/skills/${file}.webp`;
};
