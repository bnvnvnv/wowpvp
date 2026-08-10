/**
 * 猎人手工签名表（P3 技能签名批）。
 *
 * ★★ 这张表要解决的问题：猎人 14 个技能此前全部落在「物理/自然/奥术/冰霜/火焰」
 *   五组学派音上 —— 瞄准射击和断筋是同一个声音，龟甲护体和振作是同一个声音。
 *   本表给每个技能一条可辨识的音画身份，分量按「大招 > 核心循环 > 填充」分层。
 *
 * ★ 选音原则：以 WoW 玩家的肌肉记忆为标尺，不为凑数而选。
 *   - 弓类技能统一走 `melee_bow_*`，靠**变速**区分轻重：
 *     瞄准射击 0.72（拉满弓的低沉吱嘎） < 秘法箭 1.18 < 断法箭 1.35（最快的一声脆响）。
 *     同一件乐器换八度，比换五个不相干的音效更像「同一个猎人在射箭」。
 *   - 陷阱的「迷惑」在本仓库与变形/羊同属 incapacitate 族 → `ui_sheep`。
 *   - 两个「守护」（龟甲/猎豹）是猎人的身份对，都给二级形态，成对可读。
 *
 * ⚠️ 所有数值（castRate / impactRate / tintShift / scale）都是**占位值** ——
 *   没有任何外部出处，是照着「大招要压得住场、填充键不许喧宾夺主」的相对关系
 *   拧出来的一组比例。真机听感调过之后请连同这段注释一起改。
 *
 * ⚠️ 音效键必须是 `assets/music/sfx/` 下**去掉 .mp3 的精确基名**（部分带 `_1`
 *   变体后缀，部分不带）。`hunter.test.ts` 逐键对磁盘校验，写错即红灯。
 *
 * ⚠️ `impactLayer` 必须与同条的 `impactSound` 不同名 —— AudioManager.play 的
 *   40ms 同名去重会把重名的叠加层整个吃掉（见 AudioManager.ts 的分层注释）。
 *
 * ★ 二级形态（form）只给了 6 / 14 条：两个大招 + 两处语义强制（陷阱的触发圈、
 *   照明弹的持续区域）+ 身份技瞄准射击。form 是**重点标记**，人人都有等于没有。
 *
 * 本文件只导出数据，注册由 `signatures/index.ts` 统一收口。
 */

import { SignatureForm, type SkillSignature } from '../skillSignature.js';

export const signatures: Record<string, SkillSignature> = {
  // ── 身份技 ────────────────────────────────────────────────────
  /**
   * ★ 瞄准射击：猎人的职业身份技（CastKind.AimedShot 就是照它命名的）。
   *   1.6 秒站桩换 300% 武器伤害，一听就得知道「他在拉满弓」——
   *   `melee_bow_1` 压到 0.72 倍速，弓弦的吱嘎被拉长成低频；命中用
   *   `impact_bone_2`（重箭穿透骨头的闷响，不是普通箭的皮肉声），
   *   再叠一层 `combat_crit_1` 当狙击的那声脆裂。
   *   form 用 shards：地基注释里 shards = 物理暴发，正是这一箭的形状。
   */
  'hunter.aimed_shot': {
    castSound: 'melee_bow_1',
    castRate: 0.72,
    impactSound: 'impact_bone_2',
    impactRate: 0.8,
    impactLayer: 'combat_crit_1',
    tintShift: -0.05,
    scale: 1.6,
    form: SignatureForm.Shards,
  },

  // ── 核心循环 ──────────────────────────────────────────────────
  /**
   * 秘法箭：焦点主出口，按得最频繁 —— 中等个性即可，形态留白。
   * 弓声提速到 1.18（轻快的抬手就射），命中层加一记 `wand_arcane_1`
   * 的奥术叮声，让它在一串物理箭里听得出「这发是带魔法的」。
   */
  'hunter.arcane_shot': {
    castSound: 'melee_bow_3',
    castRate: 1.18,
    impactSound: 'impact_arcane',
    impactRate: 1.15,
    impactLayer: 'wand_arcane_1',
    tintShift: 0.04,
  },

  /**
   * 断法箭：专用打断，不触发公共冷却 —— 它的声音必须**穿透**正在进行的施法音，
   * 所以走全表最快的弓声 1.35 + 金属脆响，叠一层格挡/招架的 `combat_parry_2`：
   * 「法术被磕飞了」这件事用招架声表达最直觉。
   */
  'hunter.counter_shot': {
    castSound: 'melee_bow_2',
    castRate: 1.35,
    impactSound: 'impact_metal_1',
    impactRate: 1.3,
    impactLayer: 'combat_parry_2',
    tintShift: -0.06,
  },

  /**
   * 穿透重弩箭：重弩方案专属，1 秒装填。
   * ★ 装填音刻意不用弓 —— 重弩上弦是**机括**动作，跟拉弓不是一回事。
   *   `lockpick_advanced_1` 降到 0.8 是 0.42 秒的棘轮咬合声，正是绞盘一格一格
   *   收紧弓弦的那个动静。命中沿用骨感闷响并叠钢制弩头的 `impact_metal_2`，
   *   与瞄准射击的「骨 + 脆裂」区分开。
   *
   * ★ X23 语义校准（2026-08-10，X23 点名的四条 ui_* 出戏之一）：
   *   原来写的是 `ui_weapon_unsheathe` 并在注释里称它为「金属绞盘的棘轮声」——
   *   但那个文件是**拔刀出鞘**（0.24 秒的刀刃刮擦鞘口），重弩上没有鞘也没有刀。
   *   注释把它说成绞盘，不等于它是绞盘：这是 P3 那批「按文件名语义推」最典型的
   *   一次自我说服。换成锁具机构音之后至少门类对了 —— 机械咬合对机械咬合。
   * ★ 这轮才发现的第二个理由（比出戏更硬）：`ui_weapon_unsheathe` 在
   *   `scenes/TestbedScene.ts:493` 已经是**切换武器方案成功**的 UI 提示音。
   *   同一个文件在一个地方意思是「换武器了」、在另一个地方意思是「重弩上弦」——
   *   这不是难听，是**歧义**：玩家听到它，第一反应会是自己刚切了方案。
   * ⚠️ 仍未经人耳：`lockpick_*` 是否偏 UI 提示音（而非实体机构音）只有听了才知道。
   *   若真机听下来偏 UI，退路是 `melee_bow_4` 压到 0.75（弓弦吱嘎，但会与
   *   震慑箭同素材）—— 这条退路写在这里，省得下一轮重新推一遍。
   */
  'hunter.piercing_bolt': {
    castSound: 'lockpick_advanced_1',
    castRate: 0.8,
    impactSound: 'impact_bone_4',
    impactRate: 0.85,
    impactLayer: 'impact_metal_2',
    tintShift: -0.04,
    scale: 1.2,
  },

  /**
   * 寒霜陷阱：迷惑 3 秒。布置走 `cast_frost` 压到 0.88（寒气在地上铺开），
   * 触发音换成 `foot_snow_4` 压到 0.8 —— 0.39 秒的碎冰咬合，就是冰口合拢
   * 咬住脚踝的那一下；再叠 `impact_frost` 把封冻的低频补上。
   * form 用 ring 对应 1.5 米触发圈：布置完成时地上应该有一圈可见的边界，
   * 对手才能绕。
   *
   * ★ X23 语义校准（2026-08-10）：触发音原本是 `ui_sheep` 压到 0.8，
   *   理由是「与变形术同属 incapacitate 递减链，同族技能做成同族听感」。
   *   这个理由本身站得住，但它服务的是**规则教学**，代价是玩家踩进一个
   *   寒霜陷阱时听到一声羊叫 —— 用户口径「声音要贴合技能」在这里优先。
   *   本轮定的新口径：**羊叫只留给真的有羊的地方**（法师变形术），
   *   其余 incapacitate 同族键各自回到自己的材质（本条回冰、盗贼致盲回沙土）。
   *   DR 链的教学交给 HUD 的递减图标，那本来就是它的活。
   */
  'hunter.freezing_trap': {
    castSound: 'cast_frost',
    castRate: 0.88,
    impactSound: 'foot_snow_4',
    impactRate: 0.8,
    impactLayer: 'impact_frost',
    tintShift: 0.05,
    scale: 1.15,
    form: SignatureForm.Ring,
  },

  /**
   * 照明弹：8 秒持续揭露区域，不造成伤害 —— 声音要「亮」不要「重」，
   * 所以火焰命中提速到 1.3 变成一声轻爆而非轰响。
   * form 用 rain（持续区域类）：飘落的照明弹光正是这个形状。
   */
  'hunter.flare': {
    castSound: 'proj_fire',
    castRate: 1.2,
    impactSound: 'impact_fire',
    impactRate: 1.3,
    tintShift: 0.06,
    scale: 1.2,
    form: SignatureForm.Rain,
  },

  /**
   * 猛禽一击：贴脸还手键。挥击 + 皮肉命中之上叠一声 `mob_beast_attack_2`，
   * 「猛禽」这两个字全靠这层野兽嘶鸣兑现，否则它和任何近战平砍没区别。
   */
  'hunter.raptor_strike': {
    castSound: 'melee_swing_heavy_3',
    castRate: 1.1,
    impactSound: 'impact_flesh_4',
    impactRate: 0.95,
    impactLayer: 'mob_beast_attack_2',
    tintShift: 0.02,
  },

  // ── 大招（冷却 ≥ 45s）─────────────────────────────────────────
  /**
   * ★ 振作（60s，回 25% 最大生命）：猎人唯一的自我治疗，按下去就是「我要活」。
   *   施法走 `cast_chain_heal` 的绿色自然治疗底噪，命中用 `heal_impact` 并叠
   *   `buff_apply` —— 治疗落地 + 状态附着两层叠出「回满了」的实感。
   *   form 用 spiral（增益/蓄力）：向上升的螺旋是全表唯一的「往上走」，
   *   和猎人其余一律向外/向前的箭形彻底分开。scale 1.5 让队友隔着场也能看见。
   */
  'hunter.exhilaration': {
    castSound: 'cast_chain_heal',
    castRate: 0.95,
    impactSound: 'heal_impact',
    impactRate: 1.1,
    impactLayer: 'buff_apply',
    tintShift: 0.04,
    scale: 1.5,
    form: SignatureForm.Spiral,
  },

  /**
   * ★ 龟甲护体（60s，减伤 35% + 偏转正面投射物）：对手必须**一眼看出**这 4 秒
   *   打它没用，否则这个技能只会制造挫败感。
   *   `buff_apply` 压到 0.72 是厚重的甲壳合拢，命中用 `impact_metal_4` 压到 0.7
   *   （最低钳位）—— 不是薄铁皮的当啷，是石质龟壳的闷撞；再叠 `combat_block_1`
   *   把「格挡」的语义钉死。form 用 orbit：环绕轨道粒子直接画出偏转正面投射物
   *   的那层壳，与振作的上升螺旋在视觉上不可能混。
   */
  'hunter.aspect_of_the_turtle': {
    castSound: 'buff_apply',
    castRate: 0.72,
    impactSound: 'impact_metal_4',
    impactRate: 0.7,
    impactLayer: 'combat_block_1',
    tintShift: -0.05,
    scale: 1.45,
    form: SignatureForm.Orbit,
  },

  // ── 工具 / 填充 ───────────────────────────────────────────────
  /**
   * 猎豹守护：与龟甲护体是「守护」身份对，所以同样给 form（spiral 的加速上旋），
   * 但 scale 只给 1.05 —— 它是 30 秒的位移工具，不该抢大招的场。
   * 施法用 `mob_beast_aggro_1` 提速到 1.25：猫科低吼提上去就是猎豹。
   */
  'hunter.aspect_of_the_cheetah': {
    castSound: 'mob_beast_aggro_1',
    castRate: 1.25,
    impactSound: 'buff_apply',
    impactRate: 1.3,
    tintShift: 0.07,
    scale: 1.05,
    form: SignatureForm.Spiral,
  },

  /**
   * 震慑箭：减速工具键。命中用 `impact_metal_3` 压到 0.85 —— 钝器式的闷撞，
   * 表达「震慑」而不是「刺穿」。轻签名，无形态。
   */
  'hunter.concussive_shot': {
    castSound: 'melee_bow_4',
    castRate: 0.9,
    impactSound: 'impact_metal_3',
    impactRate: 0.85,
    tintShift: -0.03,
  },

  /**
   * 毒蛇钉刺：15 秒持续伤害，无冷却 —— 反复重铸，必须最不吵。
   * 命中叠一声 `mob_reptile_attack_1` 的爬行动物嘶声点题「毒蛇」，
   * 音量之外的分量一概不给。
   */
  'hunter.serpent_sting': {
    castSound: 'melee_bow_5',
    castRate: 1.12,
    impactSound: 'impact_nature',
    impactRate: 1.2,
    impactLayer: 'mob_reptile_attack_1',
    tintShift: 0.05,
  },

  /**
   * 后撤跃：位移键，声音就是「跳 + 落地」这件事本身，不加任何魔法色彩。
   * 跳跃压到 0.9 让它比普通跳跃沉一点（是被逼出来的一跃，不是蹦跶）。
   */
  'hunter.disengage': {
    castSound: 'move_jump_3',
    castRate: 0.9,
    impactSound: 'move_land_2',
    impactRate: 1.1,
    tintShift: -0.02,
  },

  /**
   * 断筋：0 冷却的贴脸填充键，全表分量最轻 ——
   * 轻挥 + 皮肉声都提速，短促到不打断射击的节奏感。色相几乎不动。
   */
  'hunter.wing_clip': {
    castSound: 'melee_swing_light_3',
    castRate: 1.2,
    impactSound: 'impact_flesh_2',
    impactRate: 1.15,
    tintShift: -0.01,
  },
};
