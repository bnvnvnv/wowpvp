/**
 * 牧师 —— 设计文档 9.7
 * 定位：主治疗、护盾、驱散、恐惧与外部减伤。生命 900，资源法力。
 *
 * 结构完全对齐 warrior.ts（本仓库的职业数据范本）：一个技能一个对象、
 * 附录A#3 九项全填、counters 写人话。
 *
 * 牧师是典型的「读条治疗者」：核心治疗（快速治疗）和核心输出（惩击）都是
 * 原地读条，因此 7.1 / 7.3 的全部中断来源都是它的天然反制；同时 8.5 的
 * 竞技场战斗抑制会持续削弱它的治疗与吸收上限。
 */

import { RANGE } from '../../constants/combat.js';
import {
  CastKind,
  DispelType,
  Resource,
  School,
  TargetFilter,
  Targeting,
} from '../../types/enums.js';
import { asArmorId, asClassId, asSkillId, asWeaponId } from '../../types/ids.js';
import { makeArmorSet } from '../armors.js';
import type { ClassDef, SkillDef, WeaponDef } from '../schema.js';

const CLASS_ID = asClassId('priest');

// ── 技能 ─────────────────────────────────────────────────────────

const skills: SkillDef[] = [
  {
    id: asSkillId('priest.smite'),
    name: '惩击',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: RANGE.RANGED },
    shape: { kind: 'single' },
    // 9.7：1.2 秒神圣读条，原地施放
    cast: { kind: CastKind.Cast, time: 1.2, movable: false, interruptible: true },
    school: School.Holy,
    cooldown: 0,
    triggersGcd: true,
    requiresLos: true,
    cost: { resource: Resource.Mana, amount: 30 },
    counters:
      '读条可被专用打断并锁神圣学派 3 秒，也可被移动、控制、强制位移和失去视线终止（7.1 / 7.3）；学派锁定期间快速治疗和群体驱散会一起被封，是牧师最大的软肋。',
    effects: [{ kind: 'damage', school: School.Holy, amount: { flat: 140 } }],
    description: '造成基础神圣伤害。1.2 秒读条，原地施放。',
    vfx: 'priest_smite',
  },
  {
    id: asSkillId('priest.flash_heal'),
    name: '快速治疗',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Ally,
    range: { min: 0, max: RANGE.RANGED },
    shape: { kind: 'single' },
    // 9.7：1.1 秒神圣读条，原地施放
    cast: { kind: CastKind.Cast, time: 1.1, movable: false, interruptible: true },
    school: School.Holy,
    cooldown: 4,
    triggersGcd: true,
    requiresLos: true,
    cost: { resource: Resource.Mana, amount: 90 },
    counters:
      '读条可被专用打断并锁神圣学派 3 秒，也可被移动、控制、强制位移和失去视线终止（7.1 / 7.3）；受降低治疗的减益（如致死创伤）压制；受竞技场战斗抑制影响（8.5），比赛越久单次治疗量越低。',
    effects: [{ kind: 'heal', amount: { flat: 320 } }],
    description: '为友方恢复大量生命。1.1 秒读条，原地施放，可被打断。',
    vfx: 'priest_flash_heal',
  },
  {
    id: asSkillId('priest.renew'),
    name: '恢复',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Ally,
    range: { min: 0, max: RANGE.RANGED },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Holy,
    cooldown: 8,
    triggersGcd: true,
    requiresLos: true,
    cost: { resource: Resource.Mana, amount: 60 },
    counters:
      '瞬发不怕打断，但总量分 3 跳给出，对爆发秒杀几乎无效；增益属魔法，可被敌方驱散魔法或群体驱散直接偷掉；受竞技场战斗抑制影响（8.5）。',
    effects: [
      {
        kind: 'applyAura',
        aura: {
          id: 'priest.renew',
          name: '恢复',
          kind: 'buff',
          duration: 6,
          dispelType: DispelType.Magic,
          clearableByTrinket: false,
          periodic: {
            interval: 2,
            effects: [{ kind: 'heal', amount: { flat: 90 } }],
          },
          description: '每 2 秒恢复一次生命，持续 6 秒。',
          vfx: 'priest_renew',
        },
      },
    ],
    description: '使友方在 6 秒内持续恢复生命。',
    vfx: 'priest_renew',
  },
  {
    id: asSkillId('priest.power_word_shield'),
    name: '真言术：盾',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Ally,
    range: { min: 0, max: RANGE.RANGED },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Holy,
    cooldown: 12,
    triggersGcd: true,
    requiresLos: true,
    cost: { resource: Resource.Mana, amount: 80 },
    counters:
      '瞬发不怕打断，但 12 秒冷却决定它一次只能保一个人；护盾是魔法增益，可被驱散魔法/群体驱散直接剥离；吸收量受竞技场战斗抑制影响（8.5，抑制同时作用于治疗与吸收）；破盾后不阻止后续伤害。',
    effects: [
      {
        kind: 'applyAura',
        aura: {
          id: 'priest.power_word_shield',
          name: '真言术：盾',
          kind: 'buff',
          duration: 6,
          dispelType: DispelType.Magic,
          clearableByTrinket: false,
          // 归零时触发 14.3 的「破裂」表现
          absorb: 260,
          description: '吸收一定伤害，持续 6 秒。',
          vfx: 'priest_power_word_shield',
        },
      },
    ],
    description: '为友方套上持续 6 秒的吸收护盾。',
    vfx: 'priest_power_word_shield',
  },
  {
    id: asSkillId('priest.dispel_magic'),
    name: '驱散魔法',
    classId: CLASS_ID,
    // 9.7：一个技能两种用法 —— 友方去负面、敌方偷增益，所以 targetFilter 是 Any。
    // 下面写了两条 dispel 效果（from: 'ally' / from: 'enemy'），
    // sim 层按所选目标的阵营只执行其中一条，另一条直接跳过。
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Any,
    range: { min: 0, max: RANGE.RANGED },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Holy,
    cooldown: 12,
    triggersGcd: true,
    requiresLos: true,
    cost: { resource: Resource.Mana, amount: 40 },
    counters:
      '一次只移除 1 个效果，可被「驱散诱饵」（先叠无关魔法减益/增益）骗掉；只认魔法类，诅咒、毒素、疾病、物理减益（如致死创伤）和降治疗都驱不掉（8.4）；12 秒冷却打不过高频施加的减益；沉默或神圣学派锁定期间不可用。',
    effects: [
      // 友方目标：移除 1 个可驱散的魔法负面
      { kind: 'dispel', types: [DispelType.Magic], count: 1, from: 'ally' },
      // 敌方目标：偷掉 1 个可驱散的魔法增益
      { kind: 'dispel', types: [DispelType.Magic], count: 1, from: 'enemy' },
    ],
    description: '移除友方一个可驱散魔法负面，或敌方一个可驱散增益。',
    vfx: 'priest_dispel_magic',
  },
  {
    id: asSkillId('priest.psychic_scream'),
    name: '心灵尖啸',
    classId: CLASS_ID,
    targeting: Targeting.SelfCenter,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: 6 },
    shape: { kind: 'circle', radius: 6 },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Shadow,
    cooldown: 30,
    triggersGcd: true,
    counters:
      '受恐惧/迷惑/变形递减（100%→50%→25%→免疫，8.2）；受到较高伤害会提前解除，队友的 AOE 经常自己拆掉它；可被「战斗意志」直接解除（8.3）；自身中心范围不会穿过完整墙体（6.4），贴墙或拉开 6 米即可躲开。',
    effects: [{ kind: 'fear', duration: 2.5, breakDamage: 220 }],
    description: '恐惧周围 6 米内的敌人 2.5 秒，受到较高伤害可解除。',
    vfx: 'priest_psychic_scream',
  },
  {
    id: asSkillId('priest.silence'),
    name: '沉默',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: RANGE.RANGED },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Shadow,
    cooldown: 30,
    // 7.2 免 GCD 的优待只给「专用打断」；沉默是「等价沉默」且带 3 秒硬压制，
    // 因此仍然触发公共冷却。
    triggersGcd: true,
    requiresLos: true,
    cost: { resource: Resource.Mana, amount: 30 },
    counters:
      '只限制魔法，**不阻止物理射击、普通攻击和纯武器技能**（8.2 / 7.3 / 验收 #17），对战士、盗贼、猎人的物理输出几乎无效；沉默递减只有三段（100%→50%→免疫，8.2）；不能被「战斗意志」解除（8.3），但可被友方驱散魔法/群体驱散移除；对不可打断技能仍会施加沉默但不会中止该次施法。',
    effects: [
      // 打断部分本身不再额外锁学派：随后的 3 秒沉默比学派锁定更强（封住全部魔法）
      { kind: 'interrupt', schoolLockSeconds: 0 },
      // sim 侧的 silence 处理器负责挂上 flags.silenced 的减益，
      // 并套用 DrCategory.Silence 的三段递减（100%→50%→免疫，8.2）与
      // clearableByTrinket: false（8.3 战斗意志不解除沉默）。
      { kind: 'silence', duration: 3 },
    ],
    description: '停止目标当前的魔法施法并沉默 3 秒；不阻止物理射击和纯武器技能。',
    vfx: 'priest_silence',
  },
  {
    id: asSkillId('priest.leap_of_faith'),
    name: '信仰飞跃',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Ally,
    range: { min: 0, max: RANGE.MEDIUM },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Holy,
    cooldown: 30,
    triggersGcd: true,
    requiresLos: true,
    cost: { resource: Resource.Mana, amount: 40 },
    counters:
      '不能穿墙或拉入复活区，落点非法时整个技能失败并只走冷却（6.4 / 12.6 / 13.5）；作用于友方，救人的同时也会把队友从他自己选的站位上扯走；受击退/拉拽递减影响（8.2）；被拉的队友如果正在读条会被强制位移打断（7.3）。',
    effects: [
      // schema 的 EffectDef 没有「前置条件 / 判定失败则中止后续效果」的表达能力，
      // 这里用 custom 占位：落点合法性（墙体、可行走面、复活区）由 sim 侧裁定，
      // 不合法时必须中止后面的 pullTarget。
      {
        kind: 'custom',
        handler: 'priest.leapOfFaithLandingGuard',
        params: { forbidSpawnZone: true, requireLos: true, requireWalkable: true },
      },
      { kind: 'pullTarget', toDistance: 2 },
    ],
    description: '把友方拉到自己附近的合法位置；不能穿墙或拉入复活区。',
    vfx: 'priest_leap_of_faith',
  },
  {
    id: asSkillId('priest.pain_suppression'),
    name: '痛苦压制',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Ally,
    range: { min: 0, max: RANGE.RANGED },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Holy,
    cooldown: 60,
    triggersGcd: true,
    requiresLos: true,
    cost: { resource: Resource.Mana, amount: 50 },
    counters:
      '60 秒冷却，一场只能救几次，逼对手用假开手骗出来；减伤不是免疫，控制链和爆发叠加照样能打死人；属魔法增益，可被敌方驱散魔法/群体驱散剥离；同类团队减伤不叠加，取较强者（8.4）。',
    effects: [
      {
        kind: 'applyAura',
        aura: {
          id: 'priest.pain_suppression',
          name: '痛苦压制',
          kind: 'buff',
          duration: 5,
          dispelType: DispelType.Magic,
          clearableByTrinket: false,
          modifiers: { damageTaken: 0.6 },
          description: '受到的伤害降低 40%，持续 5 秒。',
          vfx: 'priest_pain_suppression',
        },
      },
    ],
    description: '使友方在 5 秒内受到的伤害降低 40%。',
    vfx: 'priest_pain_suppression',
  },
  {
    id: asSkillId('priest.mass_dispel'),
    name: '群体驱散',
    classId: CLASS_ID,
    targeting: Targeting.Ground,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: RANGE.RANGED },
    // 9.7：半径 7 米、最多影响 5 个单位。
    // schema 的 ShapeDef.circle 没有 maxTargets 字段（只有 chain 有），
    // 因此**上限 5** 由 sim 层在结算圆形范围时按距离最近优先截断，此处以注释约定。
    shape: { kind: 'circle', radius: 7 },
    cast: { kind: CastKind.Cast, time: 1.5, movable: false, interruptible: true },
    school: School.Holy,
    cooldown: 45,
    triggersGcd: true,
    requiresLos: true,
    cost: { resource: Resource.Mana, amount: 120 },
    counters:
      '1.5 秒读条可被专用打断并锁神圣学派 3 秒，也可被移动、控制、强制位移和失去视线终止（7.1 / 7.3）；可解除部分完全免疫（圣盾术、寒冰屏障），但对方可以等读条起手后再交免疫；地面指示器不能放在墙后（6.4）；范围内最多影响 5 个单位，人多时不保证驱到关键目标；45 秒冷却。',
    effects: [
      {
        kind: 'dispel',
        types: [DispelType.Magic],
        count: 1,
        from: 'enemy',
        // 10.x / 8.4：这是全局唯一能拆掉完全免疫的手段
        canRemoveImmunity: true,
      },
    ],
    description: '对地面范围内最多 5 个单位各移除一个强力魔法效果，可解除部分完全免疫。',
    vfx: 'priest_mass_dispel',
  },
  // 武器方案授予的技能
  {
    id: asSkillId('priest.mind_spike'),
    name: '进攻型精神冲击',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    // 魔杖+圣物方案的基础射程 28 米
    range: { min: 0, max: 28 },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Shadow,
    cooldown: 6,
    triggersGcd: true,
    requiresLos: true,
    cost: { resource: Resource.Mana, amount: 45 },
    counters:
      '仅魔杖+圣物方案可用，换回法杖即失效；瞬发但走暗影学派，被暗影学派锁定或沉默期间不可用；选这套方案的代价是治疗与护盾 -10%，输出换生存。',
    effects: [{ kind: 'damage', school: School.Shadow, amount: { flat: 175 } }],
    description: '瞬发暗影冲击，造成中等暗影伤害。仅魔杖+圣物方案可用。',
    vfx: 'priest_mind_spike',
  },
];

// ── 武器方案（附录A#4：职业、攻击间隔、距离、优势、代价、改变的技能）──
// 数值严格照抄 9.7「牧师武器方案」表格。

const weapons: WeaponDef[] = [
  {
    id: asWeaponId('priest.two_hand_staff'),
    name: '双手法杖',
    classId: CLASS_ID,
    isDefault: true,
    handedness: 'staff',
    swingInterval: 2,
    swingPercent: 0.5,
    reach: RANGE.RANGED,
    isRanged: true,
    // 文档写的是「群体治疗 +12%」；AuraModifiers 只有全局 healingDone，没有单体/群体之分，
    // 且 9.7 的牧师技能表目前没有群体治疗技能，这里先记为全局治疗加成，
    // 等 sim 支持按技能标签细分后再收窄（见文件末尾的 schema 缺口说明）。
    modifiers: { healingDone: 1.12, castSpeed: 1.08 },
    advantage: '群体治疗 +12%',
    cost: '读条时间 +8%，自保一般',
    removesSkills: [asSkillId('priest.mind_spike')],
    model: 'priest_two_hand_staff',
  },
  {
    id: asWeaponId('priest.scepter_codex'),
    name: '权杖 + 圣典',
    classId: CLASS_ID,
    isDefault: false,
    handedness: 'oneHand',
    swingInterval: 1.5,
    swingPercent: 0.45,
    reach: RANGE.MEDIUM,
    isRanged: true,
    // 文档写的是「单体治疗读条 -15%」；schema 只有全局 castSpeed，
    // skillModifiers 也只支持 damageMultiplier / cooldownMultiplier，无法按技能改读条时间，
    // 所以先按全局记。「范围治疗 -10%」同样缺少 AoE 治疗修正字段，只保留在 cost 文案里。
    modifiers: { castSpeed: 0.85 },
    advantage: '单体治疗读条 -15%，驱散效率高',
    cost: '范围治疗 -10%',
    removesSkills: [asSkillId('priest.mind_spike')],
    // 「快速治疗与驱散强化」：驱散效率用冷却缩减表达
    skillModifiers: {
      'priest.dispel_magic': { cooldownMultiplier: 0.75 },
      'priest.mass_dispel': { cooldownMultiplier: 0.85 },
    },
    model: 'priest_scepter_codex',
  },
  {
    id: asWeaponId('priest.wand_relic'),
    name: '魔杖 + 圣物',
    classId: CLASS_ID,
    isDefault: false,
    handedness: 'ranged',
    swingInterval: 1.2,
    swingPercent: 0.6,
    reach: 28,
    isRanged: true,
    // 「攻击和控制 +12%」：攻击用 damageDealt；控制时长加成没有对应字段
    //（AuraModifiers 只有承受方向的 ccDurationTaken），暂时只体现在 advantage 文案。
    // 「治疗与护盾 -10%」：治疗用 healingDone；吸收量没有对应的 absorb 修正字段（schema 缺口）。
    modifiers: { damageDealt: 1.12, healingDone: 0.9 },
    advantage: '攻击和控制 +12%',
    cost: '治疗与护盾 -10%',
    grantsSkills: [asSkillId('priest.mind_spike')],
    model: 'priest_wand_relic',
  },
];

export const priest: ClassDef = {
  id: CLASS_ID,
  name: '牧师',
  role: '主治疗、护盾、驱散、恐惧与外部减伤',
  baseHealth: 900,
  resources: [{ resource: Resource.Mana, max: 1000, start: 1000, regenPerSecond: 14 }],
  strengths: '单体保护、驱散、团队减伤、拉回队友',
  weaknesses: '被打断后治疗窗口明显、机动一般、持续被贴身时脆弱',
  defaultWeaponId: asWeaponId('priest.two_hand_staff'),
  defaultArmorId: asArmorId('priest.default'),
  skills,
  weapons,
  armors: makeArmorSet(CLASS_ID, { defaultName: '布甲' }),
  // 默认武器双手法杖发射圣光弹；魔杖+圣物方案改为暗影弹，
  // 但 ClassDef.autoAttack 是职业级固定字段，无法按武器切换学派（schema 缺口）。
  autoAttack: { ranged: true, school: School.Holy },
};
