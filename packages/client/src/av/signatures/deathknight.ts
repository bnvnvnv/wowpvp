/**
 * 死亡骑士的手工技能签名表（P3 技能签名批）。
 *
 * ★ 这一层解决的问题：死骑 14 个技能此前只有 3 组学派音（物理 / 冰霜 / 暗影）——
 *   碎骨斩和汲血斩听起来一模一样，缚魂拽和扼喉也一模一样。签名表按
 *   「分量」给每个技能一个可辨识的音画身份：
 *     · 大招 / 身份技 —— 换专属音效文件 + 明显音高 + 二级形态 + 规模；
 *     · 核心循环键 —— 中等个性（音高 10–20% + 叠层，必要时形态）；
 *     · 填充 / 工具键 —— 轻签名（微音高 / 微色相），不许喧宾夺主。
 *
 * ★ 死骑的听觉母题（选音的统一直觉，后人加技能请沿用）：
 *     骨（impact_bone_*）+ 亡灵（mob_undead_*）+ 沉重的钝器（melee_swing_heavy_*）
 *     + 拖慢的播放速率。死骑的声音**普遍比别的职业慢** —— 板甲、双手符文剑、
 *     不会喘气的躯壳，这三样加起来就是「重而迟滞」。冰霜支线（凛冬 / 寒缚）
 *     反过来往上抬速率，靠速率把两条支线分开，玩家闭眼也能听出按的是哪一路。
 *
 * ⚠️ 所有音效键必须是 `assets/music/sfx/` 里真实存在的**去掉 .mp3 的基名**——
 *   注意变体后缀不统一（`impact_bone_1` 有编号、`mob_undead_aggro` 没有），
 *   同目录的 `deathknight.test.ts` 逐键对磁盘校验，写错就红。
 *
 * ⚠️ 本表**只描述表现层**：不碰 shared 数据、不碰 sim 行为，
 *   normal bot 平衡基线与本文件无关。
 *
 * ★ 形态（form）用了 6 / 14 —— 刻意压在半数以下。form 是「重点标记」，
 *   人人都有就等于没有；没上 form 的技能靠音效与色相区分。
 */

import { SignatureForm, type SkillSignature } from '../skillSignature.js';

export const signatures: Record<string, SkillSignature> = {
  // ── 核心循环：物理主输出 ────────────────────────────────────────
  /**
   * 碎骨斩 —— 双手符文剑的主输出键（cd 6，135% 武伤）。
   * 名字里就写着「碎骨」：重挥 → 骨裂 → 剑刃金属余音的三段式。
   * 上 shards（物理暴发）是因为它是死骑唯一的纯物理爆发件，
   * 需要和同为近战的汲血斩在**视觉上**一眼分开（那条走治疗回馈）。
   */
  'deathknight.obliterate': {
    castSound: 'melee_swing_heavy_2',
    castRate: 0.86, // 双手符文剑 2.3s 攻速，挥击拖慢才有重量
    impactSound: 'impact_bone_3',
    impactRate: 0.9,
    impactLayer: 'impact_metal_2', // 剑刃啃在板甲上的金属层
    tintShift: -0.05,
    scale: 1.2,
    form: SignatureForm.Shards,
  },

  /**
   * 汲血斩 —— 打人回血（cd 8）。听感必须让玩家确认「血回上了」，
   * 所以命中层直接叠 heal_impact：血肉的闷响之后跟一记治疗回馈音，
   * 这是它和碎骨斩唯一需要区分的信息。
   */
  'deathknight.death_strike': {
    castSound: 'melee_swing_blade_5',
    castRate: 0.92,
    impactSound: 'impact_flesh_2',
    impactRate: 0.85,
    impactLayer: 'heal_impact', // ★ 吸血的回馈音，比任何画面提示都快
    tintShift: 0.04,
    scale: 1.05,
  },

  // ── 职业身份技 ──────────────────────────────────────────────────
  /**
   * 缚魂拽 —— 死骑的**身份技**（WoW 玩家的肌肉记忆里，死骑 = 这一下）。
   * 为什么是这个声音：起手用 mob_undead_aggro 压到 0.75x，
   *   把亡灵的嚎叫拖成一句「抓过来」的低吼（原速太像小怪，压慢才是术法）；
   *   命中是 impact_bone_1（骨手扣住脖子）叠 move_land_2（人被摔到脚下的落地闷响）——
   *   拉拽的信息量全在「落地」那一下，没有它玩家不知道拽成功了没有。
   * 为什么是 ring：目标砸到我脚前时地面荡开的那圈震荡波。
   * scale 1.45：仅次于凛冬领域，身份技必须比核心键明显大一圈。
   */
  'deathknight.death_grip': {
    castSound: 'mob_undead_aggro',
    castRate: 0.75,
    impactSound: 'impact_bone_1',
    impactRate: 1.15,
    impactLayer: 'move_land_2',
    tintShift: -0.07,
    scale: 1.45,
    form: SignatureForm.Ring,
  },

  // ── 控制 / 压制 ─────────────────────────────────────────────────
  /**
   * 寒缚链 —— 甩出去的是**链子**，不是法术弹。
   * 所以起手借 impact_metal_4 提速到 1.32x 当「哗啦」的链声（金属短促、
   * 提速后完全脱离原本的「打在板甲上」语义），命中才回到冰霜的封冻闷响。
   * 一快一慢的对比是它和凛冬号叫（同为冰霜减速）的分界线。
   */
  'deathknight.chains_of_ice': {
    castSound: 'impact_metal_4',
    castRate: 1.32,
    impactSound: 'impact_frost',
    impactRate: 0.82,
    impactLayer: 'debuff_apply',
    tintShift: 0.05,
    scale: 1.0,
  },

  /**
   * 扼喉 —— 隔空掐住咽喉的 2 秒昏迷（cd 30）。
   * mob_demon_aggro_2 压到 0.82x 是那声「暗影尖啸」；命中走暗影闷响并压到
   * 0.78x（本表最低的命中速率）—— 窒息的听感就是**声音被掐断、坠下去**。
   */
  'deathknight.strangulate': {
    castSound: 'mob_demon_aggro_2',
    castRate: 0.82,
    impactSound: 'impact_shadow',
    impactRate: 0.78,
    impactLayer: 'debuff_apply',
    tintShift: -0.06,
    scale: 1.15,
  },

  /**
   * 冻念 —— 专用打断（不触发 GCD，cd 15）。
   * 打断键的唯一诉求是**快**：玩家要在 0.2 秒内确认「断到了」。
   * 所以用最短的冰击 impact_frost 提速到 1.35x，规模压到 0.8 ——
   * 打断本来就该是一记轻脆的响指，喧宾夺主反而盖住被打断者的读条音。
   */
  'deathknight.mind_freeze': {
    castSound: 'impact_frost',
    castRate: 1.35,
    impactRate: 1.3,
    tintShift: 0.03,
    scale: 0.8,
  },

  // ── 防御 / 位移 ─────────────────────────────────────────────────
  /**
   * 抗咒护罩 —— 4 秒魔法吸收罩（cd 30）。
   * cast_shadow 压到 0.8x 是罩子「升起来」的低沉起势；命中位放 buff_apply
   * 明确「上身了」，再叠 impact_arcane 表示**魔法撞在罩子上被吃掉**——
   * 这层是它和符文守护（纯物理减伤）的关键区分。
   * orbit：护盾环绕，地基注释里就是给这类技能留的。
   */
  'deathknight.anti_magic_shell': {
    castSound: 'cast_shadow',
    castRate: 0.8,
    impactSound: 'buff_apply',
    impactRate: 0.88,
    impactLayer: 'impact_arcane',
    tintShift: -0.04,
    scale: 1.25,
    form: SignatureForm.Orbit,
  },

  /**
   * 疾行步 —— 6 秒速度保底 + 抗击退（cd 40）。
   * 死骑全表唯一**往上抬**的自身增益：castRate 1.28、impactRate 1.3，
   * 提速本身就是「我变快了」最直接的隐喻。叠 temporal_clock 作为加速母题
   * （时间 / 急速类统一用它，跨职业一致）。spiral = 上升螺旋的增益形态。
   */
  'deathknight.deaths_advance': {
    castSound: 'buff_apply',
    castRate: 1.28,
    impactSound: 'impact_shadow',
    impactRate: 1.3,
    impactLayer: 'temporal_clock',
    tintShift: 0.05,
    scale: 0.95,
    form: SignatureForm.Spiral,
  },

  // ── 大招（冷却 ≥ 45s）────────────────────────────────────────────
  /**
   * 凛冬领域 —— 死骑唯一的大招（cd 60，6 秒半径 6 米的持续领域）。
   * 为什么是这个声音：起手不是「一发法术」而是**一场天气**，所以借
   *   mob_elemental_aggro_3（元素的低吼）压到 0.72x —— 本表最慢的起手，
   *   慢到听起来像大地在呻吟，60 秒冷却的分量必须在按下去的第一帧就到位。
   *   命中叠 spell_nova 是领域铺开时那一圈推开的震荡，之后才是 impact_frost
   *   的持续封冻。
   * 为什么是 rain：地基注释里 rain = 持续区域，这是本职业唯一的地面领域技，
   *   形态语义和 spawnGroundArea 一一对应。
   * scale 1.7：全表最大（上限 1.8），大招就该在画面上压过其他一切。
   */
  'deathknight.winter_domain': {
    castSound: 'mob_elemental_aggro_3',
    castRate: 0.72,
    impactSound: 'impact_frost',
    impactRate: 0.75,
    impactLayer: 'spell_nova',
    tintShift: 0.06,
    scale: 1.7,
    form: SignatureForm.Rain,
  },

  // ── 武器方案专属 ────────────────────────────────────────────────
  /**
   * 快速冰霜打击 —— 双持方案的填充键（cd 4，全表最短冷却）。
   * 轻签名：轻挥 + 冰击一起提速到 1.3x 上下，规模压到 0.85。
   * 它一局要按几十次，个性一强就变噪音 —— 「快而薄」就是它全部的身份。
   */
  'deathknight.frost_strike_fast': {
    castSound: 'melee_swing_light_3',
    castRate: 1.3,
    impactSound: 'impact_frost',
    impactRate: 1.25,
    tintShift: 0.02,
    scale: 0.85,
  },

  /**
   * 符文守护 —— 骨盾方案的减伤（cd 25）。
   * combat_block_1 = 盾牌立起来的那一下，命中用 impact_bone_4 点明「骨」盾，
   * 再叠 buff_apply 收尾（上盾统一叠这一层，跨职业一致）。
   * 没上 form：它是方案限定的工具键，视觉上让位给抗咒护罩的 orbit，
   * 两个护盾同时上环反而分不清哪个还在。
   */
  'deathknight.rune_ward': {
    castSound: 'combat_block_1',
    castRate: 0.9,
    impactSound: 'impact_bone_4',
    impactRate: 0.88,
    impactLayer: 'buff_apply',
    tintShift: -0.03,
    scale: 1.0,
  },

  // ── P3b 压制三件套 ──────────────────────────────────────────────
  /**
   * 暗影疫病 —— 无冷却的 DoT 铺设键。
   * 命中叠 mob_undead_idle_2（亡灵的病态低鸣）是它的记号：疫病不是一记爆发，
   * 是**扎进去之后一直在响的东西**，用一条持续型的低鸣当尾巴最贴。
   * 起手保持轻挥、只微微提速 —— 它零冷却，按得最勤，签名必须最淡。
   */
  'deathknight.plague_strike': {
    castSound: 'melee_swing_blade_2',
    castRate: 1.06,
    impactSound: 'impact_flesh_3',
    impactRate: 0.86,
    impactLayer: 'mob_undead_idle_2',
    tintShift: -0.05,
    scale: 0.95,
  },

  /**
   * 凋零缠绕 —— 反治疗切奶量（cd 15）。伤害极低，价值全在减益上，
   * 所以命中不给「打得重」的血肉音，而给 impact_bone_2 压到 0.8x 的
   * **骨质腐坏**质感，再叠亡灵抓挠（伤口在烂）。色相是全表最偏的 -0.07：
   * 它和暗影疫病都是暗影减益，靠色相拉开才不至于看成同一个。
   */
  'deathknight.necrotic_strike': {
    castSound: 'melee_swing_blade_7',
    castRate: 0.9,
    impactSound: 'impact_bone_2',
    impactRate: 0.8,
    impactLayer: 'mob_undead_attack_3',
    tintShift: -0.07,
    scale: 1.1,
  },

  /**
   * 凛冬号叫 —— 以自身为中心的冰霜群体减速（cd 8）。
   * 名字里是「号叫」，那就真的给一声嚎：mob_beast_wolf_aggro_1 压到 0.8x，
   * 狼嚎拖慢之后听起来正是刮过来的刺骨寒风。命中给 spell_nova（新星 / 震荡）
   * 并配 ring —— 它是死骑唯一的自我中心 AoE，环形扩散同时告诉玩家
   * 「10 米圈到这里为止」，圈外的人为什么没吃到一目了然。
   */
  'deathknight.howling_blast': {
    castSound: 'mob_beast_wolf_aggro_1',
    castRate: 0.8,
    impactSound: 'spell_nova',
    impactRate: 0.85,
    impactLayer: 'impact_frost',
    tintShift: 0.06,
    scale: 1.25,
    form: SignatureForm.Ring,
  },
};
