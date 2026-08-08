/**
 * 大乱斗派对武装的手工签名（P3 技能签名批的同一套口径）。
 *
 * ★★ 这四条**必须**手写，理由与八张职业表不同：
 *   派对武装是「全场焦点」——「谁捡到了大锤」这件事得让另外七个人**听出来**。
 *   推导层给的是 ±6% 的微音高，那是「个性」，不是「警报」。所以四条全部
 *   按王牌档处理：换专属音效文件 + 明显变速 + 二级形态 + 规模上探。
 *
 * ★ 分量刻意压过任何职业技能（`scale` 全部取在钳位上限附近）：
 *   在这个模式里它们**就是**最重的东西，视觉预算该给它们。
 *   ⚠️ 只在大乱斗里出现，不会挤占竞技场/夺旗的粒子预算。
 *
 * ⚠️ 音效键全部是 `assets/music/sfx/` 里的真实基名（`party.test.ts`
 *   逐键对磁盘验证）。盘上没有「大锤」「烤鸡」这类专门素材，
 *   下面每一条都注明了「借的是什么、为什么借得通」。
 */

import { SignatureForm, type SkillSignature } from '../skillSignature.js';

export const signatures: Record<string, SkillSignature> = {
  /**
   * ★★ 山崩一击 —— 全场最重的一下。
   *   起手用**降速到 0.72 的食人魔重击**（`mob_ogre_attack_1`）：盘上唯一
   *   带「巨物抡起来」体量的音，再降速就是「这玩意儿有多大」。
   *   落点用降速的金属撞击，叠一层落地闷响交代 1.2 秒昏迷 + 击飞的刹停。
   * ★ Ring 而不是 Shards：这是以自己为圆心砸出去的一圈冲击波（半径 8 米），
   *   而 Shards 是单体向前的迸射（战士突进占着那个语义）。
   */
  'ffa.mountain_smash': {
    castSound: 'mob_ogre_attack_1',
    castRate: 0.72,
    impactSound: 'impact_metal_4',
    impactRate: 0.7,
    impactLayer: 'move_land_1',
    tintShift: -0.06,
    scale: 1.8,
    form: SignatureForm.Ring,
  },

  /**
   * ★★ 星火倾泻 —— 天上掉下来的那一片。
   *   起手是加速的奥术吟唱（1.18：读条 1.6 秒，音要比读条先「支棱起来」），
   *   落点用奥术命中降速到 0.75 = 一整片而不是一发。
   * ★ Rain 是地基里唯一「自上而下」的形态，落点倒计时期间正好靠它
   *   把「这块地要挨砸了」画出来（6.6 要求落点全程可见）。
   */
  'ffa.starfall': {
    castSound: 'cast_arcane',
    castRate: 1.18,
    impactSound: 'impact_arcane',
    impactRate: 0.75,
    impactLayer: 'spell_nova',
    tintShift: 0.09,
    scale: 1.7,
    form: SignatureForm.Rain,
  },

  /**
   * 香喷喷弹射鸡腿 —— 派对感全靠这一条。
   * ★ 起手借 `player_eat_food` 加速到 1.4（钳位上限）：一声「咔嚓」的啃食，
   *   在一屋子刀剑金属声里辨识度是断层第一，而且它**在语义上真的是食物**。
   * ★ 命中借皮革（`impact_leather_1`）而不是血肉：油腻的、软的、弹一下就走。
   *   叠一层 debuff_apply 点出「油腻」减速挂上了。
   * ★ Shards：弹射的每一跳都是一次向外的迸溅。
   */
  'ffa.drumstick_volley': {
    castSound: 'player_eat_food',
    castRate: 1.4,
    impactSound: 'impact_leather_1',
    impactRate: 1.25,
    impactLayer: 'debuff_apply',
    tintShift: 0.13,
    scale: 1.35,
    form: SignatureForm.Shards,
  },

  /**
   * 飞去来斧 —— 出手轻、回来重。
   * ★ 起手用加速的重物破风（1.3）：脱手的那一下要脆；
   *   命中用降速的骨响（0.78）+ 一层重落地，交代「一整排人被拽过来砸在你脚下」。
   * ★ Spiral：地基里唯一「向上/回旋」的形态 —— 回旋镖的轨迹本身就是它，
   *   而且全场只有这一条用它做**攻击**（另外两处是增益类），不会认错。
   */
  'ffa.boomerang_throw': {
    castSound: 'melee_swing_heavy_2',
    castRate: 1.3,
    impactSound: 'impact_bone_3',
    impactRate: 0.78,
    impactLayer: 'move_land_4',
    tintShift: -0.11,
    scale: 1.45,
    form: SignatureForm.Spiral,
  },
};
