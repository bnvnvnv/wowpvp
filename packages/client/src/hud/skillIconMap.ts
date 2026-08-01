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
};

/** 技能图标 URL；没有映射时返回 undefined（回落程序化 SVG） */
export const skillIconUrl = (skillId: string): string | undefined => {
  const file = SKILL_ICON_FILES[skillId];
  return file === undefined ? undefined : `/art/ui/skills/${file}.webp`;
};
