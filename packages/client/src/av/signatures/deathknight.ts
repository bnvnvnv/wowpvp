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
 * ★★ X23 语义校准轮（2026-08-10，用户拍板「冰系应该是有结冰的声音」）：
 *   本表是全批**借小怪吼叫最多**的一张，五条被改：缚魂拽 / 扼喉 / 冻念 /
 *   凛冬领域 / 凛冬号叫。改法只有一条原则 —— **技能是什么学派，就用那个学派的素材**，
 *   借小怪音的三个代价按严重性排：① 场上真有小怪，玩家分不出是谁在响（误报）；
 *   ② 同一个 mob 文件被两三个职业借走，跨职业撞脸；③ 原长压速后拖尾。
 *   冰霜四条（冻念 / 凛冬领域 / 凛冬号叫 + 原有的寒缚链 / 冰封坚韧）现在统一由
 *   `cast_frost` / `impact_frost` / `proj_frost` / `foot_snow_*` 四种素材构成，
 *   其中 `foot_snow_*`（踏雪脆响）是本轮才启用的 —— 盘上唯一的「碎冰」质感，
 *   P3 那一批 117 条签名一次都没用过它。
 * ⚠️ 仍是**没有人耳听过**的判断，只是这次的判断有实测支撑（时长用 ffprobe 逐条量过）。
 *   真机终验仍挂在 X23。
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
   * 为什么是这个声音：起手是 proj_shadow 压到 0.8x —— 一条暗影触手**射出去**，
   *   这正是缚魂拽在做的事（Shadow 学派，指向单体，把人拽回来）；
   *   命中是 impact_bone_1（骨手扣住脖子）叠 move_land_2（人被摔到脚下的落地闷响）——
   *   拉拽的信息量全在「落地」那一下，没有它玩家不知道拽成功了没有。
   * 为什么是 ring：目标砸到我脚前时地面荡开的那圈震荡波。
   * scale 1.45：仅次于凛冬领域，身份技必须比核心键明显大一圈。
   *
   * ★ X23 语义校准（2026-08-10）：原起手是 `mob_undead_aggro` 压到 0.75x。
   *   两个问题，一个实测一个语义。实测：那条素材原长 1.23 秒，压到 0.75 是
   *   **1.64 秒**，是全批 mob_* 借用里最长的一条尾巴（X23 点名的三条之首）。
   *   语义：场上真的有小怪在叫，玩家的耳朵分不出「对面死骑起手了」和
   *   「旁边刷了个亡灵」—— 借小怪音的代价不是难听，是**误报**。
   *   换成同为 Shadow 的 proj_shadow（1.04 秒，压到 0.8 是 1.31 秒）两头都解决。
   */
  'deathknight.death_grip': {
    castSound: 'proj_shadow',
    castRate: 0.8,
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
   * wand_shadow_3 压到 0.85x 是那记**收拢的暗影短音**（0.68 秒的素材，压后 0.80 秒，
   * 短到像一只手突然合上）；命中走暗影闷响并压到 0.78x（本表最低的命中速率）——
   * 窒息的听感就是**声音被掐断、坠下去**，起手越短这个「掐」字越立得住。
   *
   * ★ X23 语义校准（2026-08-10）：原起手是 `mob_demon_aggro_2`（恶魔嘶吼）。
   *   扼喉是**无声地掐住别人**，配一声自己发出的怪物尖啸方向就反了 ——
   *   而且它与破胆怒吼、惊惧尖啸同取 mob_demon_aggro_* 家族，三个不同职业的
   *   控制键开口是同一种嗓子。换成暗影法杖音后学派不变、语义归位、家族也散开。
   */
  'deathknight.strangulate': {
    castSound: 'wand_shadow_3',
    castRate: 0.85,
    impactSound: 'impact_shadow',
    impactRate: 0.78,
    impactLayer: 'debuff_apply',
    tintShift: -0.06,
    scale: 1.15,
  },

  /**
   * 冻念 —— 专用打断（不触发 GCD，cd 15）。
   * 打断键的唯一诉求是**快**：玩家要在 0.2 秒内确认「断到了」。
   * 起手用 foot_snow_1 提速到 1.35x —— 0.31 秒的踏雪脆响压成 **0.23 秒**，
   * 是全批最短的一记「咔」，字面意义上的结冰碎裂声；命中回落学派的
   * impact_frost。规模压到 0.8：打断本来就该是一记轻脆的响指，
   * 喧宾夺主反而盖住被打断者的读条音。
   *
   * ★★ X23 校准抓到的**静默 bug**（2026-08-10，不是听感问题是真没响）：
   *   原起手写的是 `impact_frost`，而本条没写 impactSound，命中回落的
   *   学派音**也是** `impact_frost`。冻念是瞬发，施法与命中同帧发出 ——
   *   `AudioManager.play` 的 40ms 同名去重（那边 :217）把第二声整个吃掉，
   *   于是这个技能从 P3 起就只响过一声，而且没有任何测试会红
   *   （既有的三条同名门禁只管 impactLayer↔impactSound，不管 cast↔impact）。
   *   本轮在 `integrity.test.ts` 补了第 ⑥ 条断言把这一类堵死。
   */
  'deathknight.mind_freeze': {
    castSound: 'foot_snow_1',
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
   * 为什么是这个声音：起手不是「一发法术」而是**一场天气**，所以用
   *   proj_frost（冰霜投射物的呼啸，1.65 秒）压到 0.72x —— 拉成 2.29 秒的
   *   低频寒流，本表最慢的起手，慢到听起来像风雪正在压过来，
   *   60 秒冷却的分量必须在按下去的第一帧就到位。
   *   命中叠 spell_nova 是领域铺开时那一圈推开的震荡，之后才是 impact_frost
   *   的持续封冻。
   *
   * ★ X23 语义校准（2026-08-10）：原起手是 `mob_elemental_aggro_3`（元素低吼）。
   *   用户口径「冰系应该是有结冰的声音」—— 一个冰霜领域开场先来一声怪物吼，
   *   听感上先建立的是「有东西活过来了」而不是「这块地要冻上了」。
   *   proj_frost 压慢之后既是寒流也是冰，学派与语义对齐。
   *   （实测顺带澄清 X23 的拖尾担心：原方案 0.705÷0.72 = 0.98 秒，
   *   本来就没拖 —— 这条要改是因为**语义**，不是因为长度。）
   * 为什么是 rain：地基注释里 rain = 持续区域，这是本职业唯一的地面领域技，
   *   形态语义和 spawnGroundArea 一一对应。
   * scale 1.7：全表最大（上限 1.8），大招就该在画面上压过其他一切。
   */
  'deathknight.winter_domain': {
    castSound: 'proj_frost',
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
   * 三层全是冰：起手 impact_frost 压到 0.78x 是一记厚重的冰爆（1.44 秒），
   * 命中给 spell_nova（新星 / 震荡）并配 ring —— 它是死骑唯一的自我中心 AoE，
   * 环形扩散同时告诉玩家「10 米圈到这里为止」，圈外的人为什么没吃到一目了然；
   * 叠层换成 foot_snow_5，是冰碴子扫过地面的那记碎响，把「号叫」落回**冰**上。
   *
   * ★ X23 语义校准（2026-08-10）：原起手是 `mob_beast_wolf_aggro_1`（狼嚎）。
   *   「号叫」两个字确实诱人，但玩家按的是冰霜技能，听到的是一头狼 ——
   *   而德鲁伊的疾奔怒吼用的是**同一个文件**（0.75x，本条 0.8x），
   *   两个职业的键在耳朵里几乎是同一声。用户口径「冰系应该是有结冰的声音」
   *   在这条上最直白：换掉狼，换成冰爆 + 碎冰。
   * ⚠️ 叠层原本也是 impact_frost，与新起手同名会被 40ms 去重吃掉 ——
   *   换 foot_snow_5 同时解决语义与同名两件事。
   */
  'deathknight.howling_blast': {
    castSound: 'impact_frost',
    castRate: 0.78,
    impactSound: 'spell_nova',
    impactRate: 0.85,
    impactLayer: 'foot_snow_5',
    tintShift: 0.06,
    scale: 1.25,
    form: SignatureForm.Ring,
  },

  /**
   * ★★ 冰封坚韧 —— P11 保命轮新增，120 秒大招（死骑冷却最长的键）。
   *
   *   必须与抗咒护罩听得出区别：护罩是**暗影**的黑壳（30 秒一转的节奏键），
   *   坚韧是**冰霜**的硬壳（一回合一次）。于是这里全线走冰系音源并压到
   *   0.72 —— 慢、厚、沉，与护罩那种"啪"地一罩形成对照。
   * ★ Orbit 形态 + scale 1.5：与法师冰盾同一族的护体语汇，
   *   规模明显高过护罩（1.15），"这是他攒了两分钟的键"看得见。
   */
  'deathknight.icebound_fortitude': {
    castSound: 'cast_frost',
    castRate: 0.72,
    impactSound: 'impact_frost',
    impactRate: 0.7,
    impactLayer: 'buff_apply',
    tintShift: -0.04,
    scale: 1.5,
    form: SignatureForm.Orbit,
  },
};
