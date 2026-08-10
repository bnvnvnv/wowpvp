/**
 * 德鲁伊手写签名表（P3 技能签名批）。
 *
 * ★ 分量分层是这张表的主线 —— 三档，玩家应该**闭着眼睛**也能听出层级：
 *   A 大招/身份技（疾奔怒吼 60s、巨熊形态、迅猫形态）：换专属音效文件 +
 *     明显音高 + 二级形态 + 规模 1.25~1.8。这三个键必须「一听就知道是它」。
 *   B 核心循环（月辉灼击/愤怒/愈合/回春/气旋囚笼/缠根/星涌术）：中等个性 ——
 *     音高 ±10~30%、按需换命中音或叠一层，规模最多 1.35。
 *   C 工具/填充（撞击/硬化树皮/野性突进/荆棘术）：轻签名，foley 级别的
 *     小动静，绝不抢大招的镜头。
 *
 * ★ 音色母题（同一族用同一批文件、靠变速区分，玩家才能建立「这是德鲁伊」的直觉）：
 *   · 兽形 → mob_beast_* + move_land_*（变形落地的四足重音）
 *   · 治疗 → cast_chain_heal + heal_impact（愈合压低=厚，回春拔高=轻）
 *   · 月/星 → impact_arcane（月火拔高成银针，星涌压低成星弹）
 *   · 木/土 → ui_gather_wood_*、mob_burrower_*（树皮与地下根须）
 *
 * ⚠️ 本表只被 `signatures/index.ts` 统一注册，本文件不 import index，
 *   也不 import 除地基以外的任何 client 模块 —— 依赖单向（见 skillSignature.ts :137）。
 *
 * ⚠️ 所有音效键都是 `assets/music/sfx/` 下**去掉 .mp3 的精确基名**
 *   （带变体后缀的必须带上，如 `mob_beast_attack_3`；不带的不许乱加，
 *   如 `spell_nova`、`ui_sheep`、`heal_impact`）。druid.test.ts 逐键对磁盘验。
 *
 * ⚠️ 纯表现层：本文件不参与任何伤害/时序计算，改这里不会动 sim 平衡基线。
 *
 * ★★ X23 语义校准轮（2026-08-10）——本表的结论与两处如实记录：
 *   · 改了一条：气旋囚笼的 `ui_sheep` 起手（X23 点名的「德鲁伊风笼」）。
 *   · **兽形三条一条没改**：巨熊形态 / 迅猫形态 / 疾奔怒吼借的 mob_beast_*
 *     是本批**唯一一组借得对的小怪音** —— 德鲁伊变的就是野兽，玩家听到兽吼
 *     不会误以为旁边刷了怪，因为吼的确实是他自己。别的职业借小怪音这轮
 *     基本都换掉了，这三条留着不是漏网。
 *   · X23 第三类风险「foley 音量基准（move_land 可能被战斗混音压没）」
 *     **实测证伪，无需改动**：用 ffmpeg volumedetect 逐条量过，
 *     move_land_1~4 的峰值是 -7.2 / -6.3 / -6.2 / -5.7 dB，
 *     而 impact_fire / cast_frost 都是 -7.2 dB —— 整个素材库是**按峰值归一**的，
 *     foley 不但没被压低，落地音还是全场最靠前的一档。
 *     （mean 值看着低是因为脚步是 0.3~0.6 秒的瞬态、静音段拉低了均值，
 *     这个差异不进混音。）签名层也确实没有音量轴 —— 唯一的增益旋钮是
 *     `AudioManager.IMPACT_LAYER_VOLUME`，不在本文件范围内，真机若仍嫌薄，
 *     那一个常量就是入口。
 */

import { SignatureForm, type SkillSignature } from '../skillSignature.js';

export const signatures: Record<string, SkillSignature> = {
  // ── A 档：大招与职业身份技 ──────────────────────────────────────

  /**
   * ★ 疾奔怒吼（60s，本职业唯一 cd ≥ 45 的大招）。
   *   为什么是这个声音/形态：它是**全队级别的一次性资源**，交出去的那一秒
   *   队友必须知道「加速来了」。狼群嚎叫压到 0.75 倍 —— 拔高会变成宠物叫，
   *   压低才是一头巨兽压着嗓子下的起跑令；命中用 spell_nova 慢放，把咆哮
   *   实体化成以自己为中心炸开的冲击环（form=ring 正是「新星/震荡」语义），
   *   再叠一层 buff_apply 表示半径 10 米内每个人身上真的落了增益。
   *   规模顶到 1.8（钳位上限）—— 全表最大，本职业没有第二个键该这么响。
   */
  'druid.stampeding_roar': {
    castSound: 'mob_beast_wolf_aggro_1',
    castRate: 0.75,
    impactSound: 'spell_nova',
    impactRate: 0.8,
    impactLayer: 'buff_apply',
    tintShift: 0.07,
    scale: 1.8,
    form: SignatureForm.Ring,
  },

  /**
   * ★ 巨熊形态（职业身份技：全游戏最主要的旗手姿态，9.8 + 12.3）。
   *   为什么是这个声音/形态：形态切换没有冷却，可它是德鲁伊**是谁**的宣告，
   *   所以按 A 档处理。兽吼压到 0.7（钳位下限）= 体积感，谁都能听出这是
   *   「大只的那个」；命中用 move_land_1 慢放 —— 变身完成的判定点是**四足
   *   砸地**而不是一段法术音，再叠 impact_bone_3 表示骨架被重塑。
   *   form=spiral（增益蓄力的上升螺旋）是两个形态键共用的视觉语言，
   *   熊靠 scale 1.7 与褐色偏移（-0.07）跟猎豹拉开。
   */
  'druid.bear_form': {
    castSound: 'mob_beast_aggro_1',
    castRate: 0.7,
    impactSound: 'move_land_1',
    impactRate: 0.7,
    impactLayer: 'impact_bone_3',
    tintShift: -0.07,
    scale: 1.7,
    form: SignatureForm.Spiral,
  },

  /**
   * ★ 迅猫形态（职业身份技：跑无旗路线的机动姿态）。
   *   为什么是这个声音/形态：与熊**刻意用同一族素材、相反的变速** ——
   *   同样是 mob_beast_* + move_land_*，猫全部拔高到 1.3 倍，落地音轻而碎。
   *   一个键听起来「沉下去」、一个「弹起来」，这就是两个形态在手感上的
   *   全部区别，不需要第三种音色去解释。form 同为 spiral（形态切换的共同
   *   语汇），但规模只有 1.25 —— 猎豹的卖点是轻，不是分量。
   */
  'druid.cat_form': {
    castSound: 'mob_beast_attack_3',
    castRate: 1.3,
    impactSound: 'move_land_2',
    impactRate: 1.35,
    impactLayer: 'buff_apply',
    tintShift: 0.06,
    scale: 1.25,
    form: SignatureForm.Spiral,
  },

  // ── B 档：核心循环键 ───────────────────────────────────────────

  /**
   * 月辉灼击：德鲁伊唯一的直伤瞬发，6 秒一按的主循环起手。
   * 施法音留给自然学派（它确实是自然系），但命中换成 impact_arcane 拔高到
   * 1.12 —— 「月辉」在肌肉记忆里是银色的一针，不是绿色的一团。色相 +0.06
   * 往青银偏，仍在 ±0.08 钳位内，八属性一眼可辨的承诺不受影响。
   */
  'druid.moonfire': {
    castRate: 1.18,
    impactSound: 'impact_arcane',
    impactRate: 1.12,
    tintShift: 0.06,
    scale: 1.05,
  },

  /**
   * 愤怒：人形态下唯一无冷却的填充键，一局要按几十次。
   * 用 cast_lightning_bolt 压到 0.9 —— 「自然爆发」的直觉素材就是它，
   * 压低是为了从「闪电」挪到「沉重的自然之力轰击」。规模刻意不给
   * （留在默认 1.0）：按得最勤的键放大就是视觉噪音。
   */
  'druid.wrath': {
    castSound: 'cast_lightning_bolt',
    castRate: 0.9,
    impactSound: 'impact_nature',
    impactRate: 0.92,
    tintShift: -0.03,
  },

  /**
   * 愈合：1.3 秒读条的主动大治疗，治疗族的「厚」的那一端。
   * cast_chain_heal + heal_impact 双双压到 0.9，配 scale 1.2 ——
   * 与回春共用同一对文件，靠变速分工（见回春）。
   */
  'druid.healing_touch': {
    castSound: 'cast_chain_heal',
    castRate: 0.9,
    impactSound: 'heal_impact',
    impactRate: 0.9,
    tintShift: 0.04,
    scale: 1.2,
  },

  /**
   * 回春：纯持续治疗，治疗族的「轻」的那一端 —— 与愈合同素材、拔高到 1.3。
   * form=rain（持续区域的落雨）是本表唯一一处把「持续」画出来的地方：
   * 回春前置爆发为零，落雨正好表达「伤害不在这一刻回来」。
   * 叠 buff_apply 层 = 它是个可被驱散的魔法增益（8.4），一听就该想到这点。
   */
  'druid.rejuvenation': {
    castSound: 'cast_chain_heal',
    castRate: 1.3,
    impactSound: 'heal_impact',
    impactRate: 1.28,
    impactLayer: 'buff_apply',
    tintShift: 0.07,
    scale: 0.95,
    form: SignatureForm.Rain,
  },

  /**
   * 气旋囚笼：德鲁伊的失能控制（DR 与变形同属 incapacitate 链，8.2）。
   * 施法音用 `proj_nature` 压到 1.05 —— 自然投射物的呼啸拉出一道**卷起来的
   * 气流**（1.59 → 1.52 秒），这是盘上最接近「风」的一次性素材；
   * 命中用风元素的呼啸，form=orbit：旋风字面意义上就是绕着目标转，
   * 且目标此刻不可被攻击也不可被治疗。
   *
   * ★ X23 语义校准（2026-08-10，X23 点名的四条 ui_* 出戏之一）：
   *   原来借的是 `ui_sheep` 压到 0.85，注释自称「压低之后听起来是风笼合拢
   *   而不是羊叫」。0.85 只是把羊音降了两个半音 —— 降速能改音高，改不了
   *   那是一只羊；把德鲁伊的招牌控制键做成羊叫，代价远大于它买来的 DR 提示。
   *   新口径见猎人寒霜陷阱那条：羊叫只留给法师变形术。
   * ⚠️ `proj_nature` 是「自然投射物」不是真的风声 —— 盘上没有短促的风素材
   *   （amb_wind_* 三条各 12.1 秒，是环境循环，实测确认当不了技能音）。
   *   这仍是就地取材，只是取的材至少在同一个学派里。
   */
  'druid.cyclone': {
    castSound: 'proj_nature',
    castRate: 1.05,
    impactSound: 'mob_elemental_attack_1',
    impactRate: 1.2,
    impactLayer: 'debuff_apply',
    tintShift: 0.02,
    scale: 1.3,
    form: SignatureForm.Orbit,
  },

  /**
   * 缠根：3 秒定身，读条 1.3 秒。
   * 钻地生物的攻击音压到 0.8 = 根须从地下窜出的闷响（这条是全表最「土」的
   * 音色，色相也往褐色压 -0.06）；叠 debuff_apply 提示它是可驱散的减益。
   */
  'druid.entangling_roots': {
    castSound: 'mob_burrower_attack_2',
    castRate: 0.8,
    impactSound: 'impact_nature',
    impactRate: 0.8,
    impactLayer: 'debuff_apply',
    tintShift: -0.06,
    scale: 1.15,
  },

  /**
   * 星涌术：唯一的奥术键，自然系被打断封锁 3 秒时唯一还能按的伤害技能。
   * 法杖奥术音压到 0.78 —— 与月辉灼击共用 impact_arcane 但走**相反方向**
   * （月火 1.12 拔高成银针，星涌 0.8 压低成一发有重量的星弹）：
   * 两个「月亮系」的键必须一耳区分，否则学派解锁的那一刻玩家按错。
   */
  'druid.starsurge': {
    castSound: 'wand_arcane_3',
    castRate: 0.78,
    impactSound: 'impact_arcane',
    impactRate: 0.8,
    tintShift: 0.05,
    scale: 1.25,
  },

  // ── C 档：工具与填充键（轻签名，不许抢镜） ──────────────────────

  /**
   * 撞击：短冲锋 + 打断，不触发公共冷却。
   * 重武器挥击 + 骨响，叠一层兽吼 —— 这是一次**头槌**，不是法术；
   * 但规模只给 1.05：它的价值在时机而不在观感。
   */
  'druid.skull_bash': {
    castSound: 'melee_swing_heavy_4',
    castRate: 0.88,
    impactSound: 'impact_bone_1',
    impactRate: 0.9,
    impactLayer: 'mob_beast_attack_2',
    tintShift: -0.04,
    scale: 1.05,
  },

  /**
   * 硬化树皮：4 秒 25% 减伤，可在昏迷中使用。
   * 不换施法音（留学派音，省得跟大招抢），只把命中换成木料咯吱声并叠
   * buff_apply —— 「上盾」的听觉惯例。form=orbit 是护盾环绕的规范用法。
   */
  'druid.barkskin': {
    castRate: 0.82,
    impactSound: 'ui_gather_wood_3',
    impactRate: 0.75,
    impactLayer: 'buff_apply',
    tintShift: -0.07,
    scale: 1.1,
    form: SignatureForm.Orbit,
  },

  /**
   * 野性突进：一个键三种形态行为，本质是位移。
   * 用 move_jump / move_land 这对 foley —— 位移就该听起来像脚下的动作，
   * 而不是又一发法术。规模留默认，色相几乎不动。
   */
  'druid.wild_charge': {
    castSound: 'move_jump_3',
    castRate: 1.15,
    impactSound: 'move_land_3',
    impactRate: 1.1,
    tintShift: -0.02,
  },

  /**
   * 荆棘术：8% 减伤的省蓝手段，20 秒常驻。
   * 全表最轻的一条 —— 不换任何音效文件，只有微音高、微色相和一层
   * buff_apply。它一局要挂好几次，任何多余的动静都是噪音。
   */
  'druid.thorns': {
    castRate: 1.08,
    impactRate: 1.05,
    impactLayer: 'buff_apply',
    tintShift: -0.05,
  },
};
