/**
 * 战士手工签名表（P3 技能签名批）。
 *
 * ★★ 分量分层是这张表的骨架 —— 三档，一档比一档响：
 *   1. **王牌**（冷却 ≥ 45s 的旋刃斩/破胆怒吼，外加职业身份技突进）：
 *      换专属音效文件 + 明显音高 + 二级形态 + 规模上探（1.5–1.8）。
 *      目标是「不看技能栏，光听就知道对面按了什么」。
 *   2. **核心循环**（重创斩、掷锤、盾撞、横扫斩、连击风暴、防御架势、法术反射）：
 *      中等个性 —— 音高 ±10–20%，必要时叠一层 impactLayer 点出材质。
 *   3. **填充/工具**（英勇打击、断腿斩、猛击、挡援）：只调音高/色相，
 *      个别键**下调** scale —— 战士的填充键按得最勤，让它们安静是保护大招的分量。
 *
 * ⚠️ 战士全部技能都是 School.Physical。八属性基座只能给它一种底色，
 *   所以「谁是谁」几乎全靠本表的音效文件与形态扛 —— 这也是战士比法系
 *   更需要手写签名的原因（法系至少还有学派色可辨）。
 *
 * ⚠️ 音效键全部是 `assets/music/sfx/` 里的**真实基名**（含 _N 后缀的要带上）。
 *   warrior.test.ts 逐键对磁盘验证，改名即红灯。
 *
 * ★ 形态（form）只给 5 / 14 条 —— 地基注释说得清楚，form 是重点标记，
 *   人人都有等于没有。上榜的都是「对手必须一眼看见」的键：
 *   两个大招、突进的撞击、以及两个防御 CD（看见了才谈得上「等它过期」）。
 */

import { SignatureForm, type SkillSignature } from '../skillSignature.js';

export const signatures: Record<string, SkillSignature> = {
  /**
   * ★★ 突进 —— 职业身份技，按王牌档处理。
   *   为什么是这个声音：起手用**加速到 1.35 的重物破风**（甲胄裹着人往前撞的风声），
   *   落点用**降速到 0.8 的金属撞击**（板甲对板甲，低频才有体重），
   *   再叠一层落地闷响把 0.75 秒昏迷的「刹停」交代清楚。
   *   为什么是 Shards：撞停瞬间向前迸射的尘土与甲片 —— 单体、一次性的物理暴发，
   *   与破胆怒吼那种以自己为圆心的扩散环刻意区分开。
   */
  'warrior.charge': {
    castSound: 'melee_swing_heavy_6',
    castRate: 1.35,
    impactSound: 'impact_metal_2',
    impactRate: 0.8,
    impactLayer: 'move_land_3',
    tintShift: -0.05,
    scale: 1.5,
    form: SignatureForm.Shards,
  },

  /**
   * 重创斩 —— 核心循环的主输出键。
   * ★ 刻意**不给 form**：6 秒冷却意味着它是全场按得第二勤的键，
   *   给它二级形态等于让重点标记变成背景噪音（地基注释举它当 Shards 的例子，
   *   但那条注释是在讲形态语义，不是在讲该给谁）。个性走音频：
   *   刀刃挥砍降速到 0.86 = 一刀的重量，命中叠 debuff_apply 点出致死创伤挂上了。
   */
  'warrior.mortal_strike': {
    castSound: 'melee_swing_blade_3',
    castRate: 0.86,
    impactSound: 'impact_flesh_2',
    impactRate: 0.82,
    impactLayer: 'debuff_apply',
    tintShift: 0.045,
    scale: 1.2,
  },

  /**
   * 断腿斩 —— 工具键（减速），轻签名。
   * ★ 只动音高与色相，不换文件：它和重创斩共用「挥砍」的肌肉记忆，
   *   区别应该是「更快、更浅的一下」，而不是另一把武器。
   */
  'warrior.hamstring': {
    castRate: 0.92,
    impactRate: 1.15,
    tintShift: -0.035,
  },

  /**
   * 掷锤 —— 核心档偏上（25 秒冷却、20 米、2 秒昏迷）。
   * ★ 抡起战锤脱手（重物破风降到 0.9）→ 锤头砸中的低沉金属（0.78）
   *   → 叠一层骨响交代 2 秒昏迷。骨层是 AudioManager 既有的「重击低频层」语义，
   *   与金属基础层不同名，不会被 40ms 同名去重吃掉。
   */
  'warrior.storm_bolt': {
    castSound: 'melee_swing_heavy_2',
    castRate: 0.9,
    impactSound: 'impact_metal_4',
    impactRate: 0.78,
    impactLayer: 'impact_bone_2',
    tintShift: 0.05,
    scale: 1.3,
  },

  /**
   * 猛击 —— 打断键。
   * ★ 用**空手击打**而不是刀刃：猛击是拳砸，和所有挥砍键一耳朵分开；
   *   加速到 1.25 让它短促。⚠️ scale 压到 0.85 是故意的 —— 打断不触发公共冷却、
   *   会在进攻技能之间穿插，粒子必须让位，否则每次穿插都在遮挡战场。
   */
  'warrior.pummel': {
    castSound: 'melee_unarmed_3',
    castRate: 1.25,
    impactRate: 1.2,
    tintShift: 0.02,
    scale: 0.85,
  },

  /**
   * 挡援 —— 战士唯一指向友方的键。
   * ★ 色相 +0.06（钳位内的最大暖偏）是本表最重要的一处色彩决定：
   *   全职业物理底色下，「这一下不是打人」只能靠色相说。
   *   声音走「冲到友方身边刹住」（落地音）+ buff_apply 叠层（护卫挂上）。
   */
  'warrior.intervene': {
    castSound: 'move_land_2',
    castRate: 1.1,
    impactRate: 0.95,
    impactLayer: 'buff_apply',
    tintShift: 0.06,
  },

  /**
   * 防御架势 —— 30 秒防御 CD。
   * ★ buff_apply 降到 0.8（沉下重心）+ 金属闷响（盾与甲落位）。
   *   Spiral：地基注释里螺旋是增益/蓄力语义，架势正是「站住、蓄住」。
   *   色相 -0.06 往冷调偏，和所有进攻键分家。
   */
  'warrior.defensive_stance': {
    castSound: 'buff_apply',
    castRate: 0.8,
    impactSound: 'impact_metal_1',
    impactRate: 0.75,
    tintShift: -0.06,
    scale: 1.15,
    form: SignatureForm.Spiral,
  },

  /**
   * ★★ 旋刃斩 —— 60 秒大招。
   *   为什么是这个声音：重刃破风加速到 1.3 起旋；命中层做成
   *   「割裂（impact_flesh_4，1.3 倍）+ 刀刃破风（melee_swing_blade_5）」两层，
   *   0.5 秒一跳连着响就是持续旋转的听感 —— 单层怎么调都只是「又砍了一下」。
   *   为什么是 Rain 而不是 Shards：M14 之后它是**固定在起手位置的 4 秒落区**
   *   （counters 明说走出 5 米即可躲开）。Shards 是一次性暴发，会骗人说「已经结束了」；
   *   Rain 说的是「这块地持续 4 秒有东西，别站进来」—— 形态要说的是机制，不是刀。
   *   scale 1.8 吃满钳位上限（地基说这是粒子池实测能扛住的天花板）。
   */
  'warrior.bladestorm': {
    castSound: 'melee_swing_heavy_7',
    castRate: 1.3,
    impactSound: 'impact_flesh_4',
    impactRate: 1.3,
    impactLayer: 'melee_swing_blade_5',
    tintShift: 0.07,
    scale: 1.8,
    form: SignatureForm.Rain,
  },

  /**
   * 盾撞 —— 剑盾方案的核心键。
   * ★ 命中叠 combat_block_2（格挡音当叠层）：盾面拍上去的那声「铛」
   *   本来就是格挡的音色，一听就知道手里是盾 —— 三套武器方案各授一个专属键，
   *   这三条的音色分家（盾=金属/巨剑=长破风/双持=快速轻刃）就是方案的听觉身份。
   */
  'warrior.shield_slam': {
    castSound: 'melee_swing_heavy_3',
    castRate: 1.05,
    impactSound: 'impact_metal_3',
    impactRate: 0.95,
    impactLayer: 'combat_block_2',
    tintShift: -0.02,
    scale: 1.15,
  },

  /** 横扫斩 —— 巨剑方案核心。★ 刀刃破风降到 0.8：长兵器的慢挥，扇形前摇要"拖得住"。 */
  'warrior.cleave': {
    castSound: 'melee_swing_blade_5',
    castRate: 0.8,
    impactSound: 'impact_flesh_3',
    impactRate: 0.88,
    tintShift: 0.03,
    scale: 1.25,
  },

  /**
   * 连击风暴 —— 双持方案核心。
   * ★ 轻刃加速到 1.3 + 第二把刀作叠层：双持的身份是「两下」，
   *   叠层与基础层不同名（swing_light_4 / swing_light_6），躲开 40ms 同名去重。
   *   scale 0.95 略收 —— 多段小伤害不该比盾撞看起来更重。
   */
  'warrior.combo_storm': {
    castSound: 'melee_swing_light_4',
    castRate: 1.3,
    impactSound: 'impact_leather_3',
    impactRate: 1.3,
    impactLayer: 'melee_swing_light_6',
    tintShift: 0.06,
    scale: 0.95,
  },

  /**
   * 英勇打击 —— 无冷却的怒气倾泻口，本表最轻的一条。
   * ⚠️ 刻意只有音高/色相微调、且 scale 压到 0.9：它是全场按得最勤的键，
   *   任何一点"个性"乘上按键频次都会变成噪音。数据侧它就是低伤害填充，
   *   表现侧也该是填充 —— 表里表外说同一句话。
   */
  'warrior.heroic_strike': {
    castRate: 1.08,
    impactRate: 1.05,
    tintShift: 0.015,
    scale: 0.9,
  },

  /**
   * 法术反射 —— 25 秒防御 CD，押对方读条的窗口。
   * ★ 举盾（combat_block_1 降到 0.85）+ 一声**奥术**命中（0.8）：
   *   战士全套都是物理音，这一声魔法音色是全表唯一的例外，
   *   为的就是说清「这个键只对法术有用」（counters：对物理毫无作用）。
   *   Orbit：护盾环绕。⚠️ 这条 buff 必须让对手看得见 —— 它的博弈就建立在
   *   「对方看到就停手等它过期」上，藏起来反而破坏设计。
   */
  'warrior.spell_reflection': {
    castSound: 'combat_block_1',
    castRate: 0.85,
    impactSound: 'impact_arcane',
    impactRate: 0.8,
    impactLayer: 'buff_apply',
    tintShift: 0.07,
    scale: 1.1,
    form: SignatureForm.Orbit,
  },

  /**
   * ★★ 破胆怒吼 —— 90 秒大招，全职业冷却最长的一个键。
   *   为什么是这个声音：恶魔咆哮降速到 0.78 —— 降速让嗓音下沉、体型变大，
   *   「破胆」要的就是这个；命中用降速的 cast_shadow 铺一层暗影气浪
   *   （恐惧的通用听觉符号），再叠 spell_nova 交代 8 米范围的冲击波。
   *   为什么是 Ring：以自己为圆心、半径 8 米、最多 5 人 —— 教科书式的新星，
   *   环的外沿就是"谁被吼到了"的判定可视化。
   *   色相 -0.08 吃满钳位：全表唯一一个往暗侧拉满的键，配得上 90 秒。
   */
  'warrior.intimidating_shout': {
    castSound: 'mob_demon_aggro_1',
    castRate: 0.78,
    impactSound: 'cast_shadow',
    impactRate: 0.75,
    impactLayer: 'spell_nova',
    tintShift: -0.08,
    scale: 1.7,
    form: SignatureForm.Ring,
  },

  /**
   * ★★ 盾墙 —— P11 保命轮新增，120 秒大招（战士冷却最长的键）。
   *
   *   与防御架势（30 秒一转的节奏键）必须一耳朵分开：架势用的是
   *   buff_apply 起手 + 轻金属落点，这里改成**格挡音本身**做起手
   *   （combat_block_2 压到 0.7 —— 全表最慢，盾牌"砸"进地面的重量），
   *   命中层再叠 buff_apply 给减伤窗口一个明确的起始回执。
   * ★ Orbit + scale 1.5：护体类的统一语汇（法师冰盾、圣骑复仇圣盾同款），
   *   规模压过架势的 1.15 —— 对手看一眼就知道该拉开等它过期，
   *   而不是继续把爆发倒进一面 50% 减伤的墙里（14.2 高可读性）。
   */
  'warrior.shield_wall': {
    castSound: 'combat_block_2',
    castRate: 0.7,
    impactSound: 'impact_metal_3',
    impactRate: 0.72,
    impactLayer: 'buff_apply',
    tintShift: -0.05,
    scale: 1.5,
    form: SignatureForm.Orbit,
  },
};
