/**
 * 盗贼手写签名表（P3 技能签名批）。
 *
 * ★ 分量分层（与 `skillSignature.ts` 文件头的两层结构对应）：
 *   · **大招/身份技** —— 隐匿、遁形、致盲、疾跑：换专属音效文件 + 明显音高 +
 *     二级形态 + 规模，目标是「不看图标、只听声音就知道谁按了什么」。
 *   · **核心循环键** —— 背袭、剜刺、昏击、影袭步、毒刃、双刃乱舞、反刺、
 *     偷袭、割裂、烟雾弹、疾闪：中等个性（音高 ±10~20%、叠层、必要时形态）。
 *   · **工具键** —— 断招踢：轻签名，别喧宾夺主（打断是节奏点不是爆发点）。
 *
 * ★ 选音的总原则：**盗贼是"没有法术"的职业**。16 个技能里 14 个是 Physical，
 *   全靠 `melee_swing_*` / `impact_*` 的刀锋与肉声撑起来；只有影袭步与烟雾弹
 *   是 Shadow，暗影音在这张表里因此**稀缺**，稀缺本身就是身份标记。
 *
 * ⚠️ 音效键是 `assets/music/sfx/` 里**去掉 .mp3 的精确基名**（有的带 _1 变体
 *   后缀、有的不带，如 `cast_shadow` vs `impact_bone_2`）—— rogue.test.ts 逐键
 *   对磁盘校验，写错就红。
 *
 * ⚠️ 本表只描述**表现层**：不碰 shared/sim 的任何行为，balance 基线逐位不变。
 *
 * 形态预算：16 个技能里 7 个带 form（< 一半）—— form 是重点标记，人人有等于没有。
 */

import { type SkillSignature, SignatureForm } from '../skillSignature.js';

export const signatures: Record<string, SkillSignature> = {
  // ── 大招 / 身份技 ────────────────────────────────────────────────

  /**
   * 隐匿 —— 盗贼的**职业身份技**（CD 0 但它定义了这个职业）。
   * ★ 为什么是收刀声起手：进潜行的第一个动作是**收起武器**，
   *   `ui_weapon_sheathe` 降速 0.9 后是一记克制的金属摩擦 —— 比任何法术音都
   *   更"盗贼"。尾巴接降到钳位下限的 `cast_shadow`（0.7 = 全表最慢），
   *   暗影像布一样裹上来，再用 `buff_apply` 收在光环落定上。
   * ★ 形态 orbit：暗影**环绕身体**而不是炸开 —— 潜行是内收的，
   *   ring/shards 那种向外的形态会把"我藏起来了"演成"我出现了"。
   */
  'rogue.stealth': {
    castSound: 'ui_weapon_sheathe',
    castRate: 0.9,
    impactSound: 'cast_shadow',
    impactRate: 0.7,
    impactLayer: 'buff_apply',
    tintShift: -0.06, // 占位值：往冷/紫偏，理由是潜行读作"更暗的物理"，但不许跨出属性色域（±0.08 钳位）
    scale: 1.15,
    form: SignatureForm.Orbit,
  },

  /**
   * 遁形 —— CD 90，整局基本只有一次的逃生大招。
   * ★ 为什么是降速的 `spell_nova`：新星音**原速**是尖锐的向外冲击，降到 0.76
   *   之后高频被削掉，剩下的正是烟雾在脚下炸开的那记闷"噗" —— 用新星音而不是
   *   暗影音，是因为遁形的动作是**一次性爆开**，不是慢慢淡出。
   * ★ 尾音 `ui_weapon_sheathe` 与隐匿**刻意共用**：遁形的终点就是潜行，
   *   两条签名共享这一记收刀声，玩家听到就知道"他又不见了"。
   * ★ 形态 ring + scale 1.6：烟雾水平炸开，是全表最大的一次视觉事件。
   */
  'rogue.vanish': {
    castSound: 'spell_nova',
    castRate: 0.76,
    impactSound: 'impact_shadow',
    impactRate: 0.72,
    impactLayer: 'ui_weapon_sheathe',
    tintShift: -0.07,
    scale: 1.6,
    form: SignatureForm.Ring,
  },

  /**
   * 致盲 —— CD 45，盗贼最贵的一个键。
   * ★ 为什么借羊系的 `ui_sheep`：shared 数据里写死了「与变形术、寒霜陷阱
   *   **共用一条迷惑递减链**」（8.2）。同一条 DR 链的技能在听感上做成同族，
   *   玩家学会的是**规则**而不是单个技能 —— 这是这张表最想要的那种记忆。
   *   降到 0.8 让羊音失去滑稽感，变成失神的踉跄。
   * ★ 起手 `ui_craft_alchemy`：致盲粉是炼金物品，起手就该是撒粉/拔塞的声音，
   *   不是刀声（致盲是全表**唯一不出刀**的进攻键）。
   * ★ 形态 ring：粉末以目标为心水平炸开一圈。
   */
  'rogue.blind': {
    castSound: 'ui_craft_alchemy',
    castRate: 1.15,
    impactSound: 'ui_sheep',
    impactRate: 0.8,
    impactLayer: 'debuff_apply',
    tintShift: 0.06, // 占位值：往暖/黄偏 —— 致盲粉的沙土色
    scale: 1.4,
    form: SignatureForm.Ring,
  },

  /**
   * 疾跑 —— CD 120，比竞技场单回合上限（90 秒）还长，一回合只有一次。
   * ★ 为什么是 `temporal_clock` 加速：疾跑是**时间尺度**上的爆发（+70% 速度），
   *   时钟音提到 1.35 之后节拍变密，耳朵直接读成"变快了"—— 这比任何脚步音
   *   都更快传达"我现在追得上你"。
   * ★ 命中层落在 `foot_dirt_5` 顶速（1.4，钳位上限）：蹬地起跑的那一脚，
   *   把抽象的加速拽回身体。
   * ★ 形态 spiral：地基注释里 spiral = 增益蓄力，疾跑是纯自我增益，对号入座。
   */
  'rogue.sprint': {
    castSound: 'temporal_clock',
    castRate: 1.35,
    impactSound: 'foot_dirt_5',
    impactRate: 1.4,
    impactLayer: 'buff_apply',
    tintShift: 0.05,
    scale: 1.25,
    form: SignatureForm.Spiral,
  },

  // ── 核心循环键 ──────────────────────────────────────────────────

  // 背袭：无冷却的主输出件，一局要听几十次 —— 快、轻、干脆，
  // 刻意**不给 form**：出现频率最高的键带形态就是满屏噪音。
  'rogue.backstab': {
    castSound: 'melee_swing_light_3',
    castRate: 1.18,
    impactSound: 'impact_flesh_2',
    impactRate: 1.12,
    impactLayer: 'impact_leather_1', // 匕首穿透皮甲的第二层，给"背后那一下"一点厚度
    tintShift: -0.02,
  },

  // 剜刺：连击点终结技 —— 比背袭慢半拍、重一档（0.9 的肉声 + 暴击层），
  // form shards（物理暴发/斩杀类，见地基注释）标出"这一下是结算"。
  'rogue.eviscerate': {
    castSound: 'melee_swing_blade_5',
    castRate: 1.08,
    impactSound: 'impact_flesh_4',
    impactRate: 0.9,
    impactLayer: 'combat_crit_2',
    tintShift: 0.04,
    scale: 1.35,
    form: SignatureForm.Shards,
  },

  // 昏击：钝击控制 —— 挥重武器起手、闷响落点（0.78 是全表最低的肉声），
  // 叠 impact_bone_2 给出"打在腰子上"的骨感。控制键不给 form：
  // 它的反馈应该是屏幕上的昏迷图标，不是粒子。
  'rogue.kidney_shot': {
    castSound: 'melee_swing_heavy_3',
    castRate: 1.2,
    impactSound: 'impact_flesh_1',
    impactRate: 0.78,
    impactLayer: 'impact_bone_2',
    tintShift: -0.05,
    scale: 1.2,
  },

  // 影袭步：Shadow 学派，瞬移绕后 —— 暗影音提到接近钳位上限（1.38）,
  // 快到听起来像"抽走"而不是"施法"；命中层用一记脚步落地，
  // 把瞬移的终点钉在地面上（不然传送听起来没有重量）。
  'rogue.shadowstep': {
    castSound: 'cast_shadow',
    castRate: 1.38,
    impactSound: 'impact_shadow',
    impactRate: 1.3,
    impactLayer: 'foot_dirt_3',
    tintShift: 0.06,
    scale: 0.9,
  },

  // 毒刃：毒素减益 —— 命中换成 `impact_nature` 并压到 0.85，
  // 自然音降速后是黏稠的一声，正是毒的质感；色相 +0.07 往绿推到钳位边缘，
  // 让它在一堆物理白光里是唯一发绿的一击。
  'rogue.poisoned_blade': {
    castSound: 'melee_swing_light_5',
    castRate: 1.05,
    impactSound: 'impact_nature',
    impactRate: 0.85,
    impactLayer: 'debuff_apply',
    tintShift: 0.07,
  },

  // 烟雾弹：Shadow 学派的地面区域（5 秒）。
  // 起手用 `ui_craft_engineering` —— 烟雾弹是**投掷装置**，机括声比法术音诚实；
  // form rain（地基注释：rain = 持续区域类），scale 1.5 撑起 5 米半径。
  'rogue.smoke_bomb': {
    castSound: 'ui_craft_engineering',
    castRate: 1.1,
    impactSound: 'impact_shadow',
    impactRate: 0.75,
    impactLayer: 'debuff_apply',
    tintShift: -0.04,
    scale: 1.5,
    form: SignatureForm.Rain,
  },

  // 疾闪：盗贼唯一的防御键（正面闪避 +35%）。
  // 起手直接用 `combat_dodge_2` —— 把"接下来我会一直闪"提前播出来，
  // 是整张表里最直白的一次因果表达；form orbit 与地基注释的"护盾/光环环绕"对齐。
  'rogue.evasion': {
    castSound: 'combat_dodge_2',
    castRate: 1.12,
    impactSound: 'buff_apply',
    impactRate: 1.2,
    tintShift: -0.03,
    scale: 1.1,
    form: SignatureForm.Orbit,
  },

  // 双刃乱舞：双剑方案专属，一次挥两下 —— 刀音提到 1.3 让两段挤在一起听成"乱舞"，
  // 命中主音换成金属（双剑对撞感），肉声退到第二层。
  'rogue.blade_flurry': {
    castSound: 'melee_swing_blade_2',
    castRate: 1.3,
    impactSound: 'impact_metal_2',
    impactRate: 1.2,
    impactLayer: 'impact_flesh_3',
    tintShift: 0.03,
    scale: 1.05,
  },

  // 反刺：**必须先成功招架**才能按（shared 的 requires: recentlyParried）。
  // 起手就用招架音 `combat_parry_3` —— 把前置条件写进声音里，
  // 玩家听到招架"叮"的一声就知道这个键此刻亮了。
  'rogue.riposte': {
    castSound: 'combat_parry_3',
    castRate: 1.15,
    impactSound: 'impact_flesh_3',
    impactRate: 1.05,
    impactLayer: 'impact_metal_1',
    tintShift: -0.04,
  },

  // 偷袭：脱战 4 秒才能按的**先手键**（潜行开场）。
  // 起手刀音压到 0.95 —— 比背袭慢，因为它是"从暗处慢慢摸上来"的那一刀；
  // 落点走皮甲 + 骨响，闷棍打晕的组合。
  'rogue.cheap_shot': {
    castSound: 'melee_swing_light_1',
    castRate: 0.95,
    impactSound: 'impact_leather_4',
    impactRate: 0.9,
    impactLayer: 'impact_bone_1',
    tintShift: -0.05,
    scale: 1.15,
  },

  // 割裂：12 秒流血 DoT —— 刀音降到 0.88 拉长成"撕开"而不是"划过"，
  // 落点也压慢；debuff_apply 叠层是这条 DoT 挂上去的回执。
  'rogue.rupture': {
    castSound: 'melee_swing_blade_7',
    castRate: 0.88,
    impactSound: 'impact_leather_2',
    impactRate: 0.8,
    impactLayer: 'debuff_apply',
    tintShift: 0.05, // 占位值：往暖/红偏 —— 流血
  },

  // ── 工具键（轻签名） ─────────────────────────────────────────────

  // 断招踢：打断键，不触发 GCD，一局按很多次且**常常打空**（目标没在施法也进 CD）。
  // 拳脚音 + 皮甲响，音高小幅上抬，不给 scale/form —— 它的作用是节奏点，
  // 喧宾夺主会让"打断成功"这件真正重要的事被淹掉。
  'rogue.kick': {
    castSound: 'melee_unarmed_4',
    castRate: 1.25,
    impactSound: 'impact_leather_3',
    impactRate: 1.15,
    tintShift: -0.01,
  },
};
