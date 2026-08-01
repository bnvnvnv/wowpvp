/**
 * 圣骑士 —— 设计文档 9.2
 * 定位：近战支援、治疗、祝福与保护。生命 1100，资源法力 + 圣能。
 *
 * 结构完全对齐 warrior.ts（范本）：一个技能一个对象、附录A#3 九项全填、
 * counters 写清楚「对手具体怎么破」，不写套话。
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

const CLASS_ID = asClassId('paladin');

// ── 技能 ─────────────────────────────────────────────────────────

const skills: SkillDef[] = [
  {
    id: asSkillId('paladin.crusader_strike'),
    name: '圣印打击',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: 3 },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Physical,
    cooldown: 4.5,
    triggersGcd: true,
    requiresFacing: true,
    requiresLos: true,
    cost: { resource: Resource.Mana, amount: 25 },
    counters: '纯武器技能：缴械后完全禁用（7.3），但沉默和神圣学派锁定拦不住它；要求贴身 3 米并把目标保持在前方 180 度（6.5），被风筝或被定身拉开就断了圣能来源，荣耀圣令随之哑火。',
    effects: [
      // M14：1.1→0.8 —— 圣能修复（此前长在敌人身上，荣耀圣言从未施放过）后主动治疗增多，输出侧回调
      { kind: 'damage', school: School.Physical, amount: { weaponPercent: 0.8 } },
      { kind: 'gainResource', resource: Resource.HolyPower, amount: 1 },
    ],
    description: '造成 80% 武器伤害并获得 1 点圣能。',
    vfx: 'paladin_crusader_strike',
  },
  {
    id: asSkillId('paladin.judgement'),
    name: '裁决',
    classId: CLASS_ID,
    // 6.6 锁定投射物：释放瞬间确认命中资格，飞行只是表现，目标之后移动不会自然落空
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: RANGE.MEDIUM },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Holy,
    cooldown: 10,
    triggersGcd: true,
    requiresLos: true,
    cost: { resource: Resource.Mana, amount: 40 },
    counters: '神圣学派：被责难以外的专用打断锁住神圣学派、或自己处于沉默期间都用不出来（7.2 / 7.3）；易伤是魔法减益，敌方驱散一次就抹掉 4 秒增伤窗口（8.4）；释放瞬间失去视线或超出 25 米直接失败（7.4），柱子绕视野是最省事的应对。',
    effects: [
      // M14：110→70 —— 审判附带 +10% 易伤（casterScoped），本体压低
      { kind: 'damage', school: School.Holy, amount: { flat: 70 } },
      {
        kind: 'applyAura',
        aura: {
          id: 'paladin.judgement',
          name: '裁决',
          kind: 'debuff',
          duration: 4,
          dispelType: DispelType.Magic,
          clearableByTrinket: false,
          /**
           * M11：原本是一条 `custom`（`paladin.judgementVulnerability`），
           * 而这个光环当时**连 modifiers 都没有** —— 易伤完全没有生效过。
           * schema v1.1 的 `casterScoped` 已实现（`aura.ts` 在结算时比对伤害来源），
           * 所以「只对该圣骑士生效的 +10% 承伤」现在是纯数据。
           */
          modifiers: { damageTaken: 1.1 },
          casterScoped: true,
          description: '受到该圣骑士造成的伤害提高 10%。',
          vfx: 'paladin_judgement',
        },
      },
    ],
    description: '投出神圣审判造成伤害，并使目标 4 秒内额外承受 10% 来自你的伤害。',
    vfx: 'paladin_judgement',
  },
  {
    id: asSkillId('paladin.holy_light'),
    name: '圣愈术',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Ally,
    range: { min: 0, max: RANGE.RANGED },
    shape: { kind: 'single' },
    // 7.1 读条法术：原地施放，带可打断标记（施法条不显示盾牌标记）
    cast: { kind: CastKind.Cast, time: 1.5, movable: false, interruptible: true },
    school: School.Holy,
    cooldown: 6,
    triggersGcd: true,
    requiresLos: true,
    cost: { resource: Resource.Mana, amount: 220 },
    counters: '1.5 秒读条是圣骑士最大的破绽：专用打断命中会锁神圣学派 3 秒（7.2），沉默、昏迷、恐惧、击退拉拽以及自己主动移动都会直接中止（7.3）；完成瞬间目标死亡、超出 30 米或失去视线同样失败（7.4）；治疗量还会被致死创伤类降治疗减益和竞技场战斗抑制（8.5）压低。',
    // M14：340→200 —— 1.5s 读条大治疗：占位值下圣骑不可击杀，六轮迭代逐步压到位
    effects: [{ kind: 'heal', amount: { flat: 200 } }],
    description: '为友方恢复大量生命。1.5 秒读条，必须原地，可被打断。',
    vfx: 'paladin_holy_light',
  },
  {
    id: asSkillId('paladin.word_of_glory'),
    name: '荣光敕令',
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
    // 消耗 3 点圣能。圣能只能靠十字军打击（或权杖方案的圣光弹）积攒
    cost: { resource: Resource.HolyPower, amount: 3 },
    counters: '瞬发不可打断，但受制于资源链：必须先贴身打出 3 次十字军打击，把圣骑士风筝开、缴械或控在近战距离外就等于封了这个技能；治疗量同样吃降低治疗减益与战斗抑制（8.5）；沉默期间作为魔法技能不可使用（7.3）。',
    // M14：260→155 —— 圣能修复后荣耀圣言真的会被施放了，数值按「瞬发不可打断」折价
    effects: [{ kind: 'heal', amount: { flat: 155 } }],
    description: '消耗 3 点圣能，立刻为友方恢复中等生命。',
    vfx: 'paladin_word_of_glory',
  },
  {
    id: asSkillId('paladin.hammer_of_justice'),
    name: '裁决之锤',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: 10 },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Holy,
    cooldown: 30,
    triggersGcd: true,
    requiresLos: true,
    cost: { resource: Resource.Mana, amount: 40 },
    counters: '受昏迷递减 100%→50%→25%→免疫（8.2），一轮控制链后基本无效；「战斗意志」可直接解除（8.3）；圣盾术、保护祝福以外的法术免疫和抗控型护甲（控制时间 -25%）都能削弱；魔法技能，沉默或神圣学派锁定期间无法使用（7.3），10 米距离也要求先贴上去。',
    effects: [{ kind: 'stun', duration: 2.5 }],
    description: '昏迷目标 2.5 秒，受昏迷递减影响。',
    vfx: 'paladin_hammer_of_justice',
  },
  {
    id: asSkillId('paladin.rebuke'),
    name: '斥令',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: 3 },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    // 物理学派打断：自己被沉默时仍然可用（7.3），也不会被神圣学派锁定连坐
    school: School.Physical,
    cooldown: 15,
    // 7.2 专用打断不触发公共冷却，便于在进攻技能之间穿插
    triggersGcd: false,
    requiresFacing: true,
    requiresLos: true,
    counters: '目标未在施法、或施法条带盾牌标记（不可打断）时依然进入 15 秒冷却（7.2）；假读条可以骗掉（7.5）；缴械期间不可用（7.3）；只有 3 米，把施法位置拉到近战距离外就打不到；打断物理射击准备条时不产生学派锁定（7.2）。',
    effects: [{ kind: 'interrupt', schoolLockSeconds: 3 }],
    description: '打断法术、引导或射击准备，并锁定该魔法学派 3 秒。脱离公共冷却。',
    vfx: 'paladin_rebuke',
  },
  {
    id: asSkillId('paladin.blessing_of_freedom'),
    name: '自由庇佑',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Ally,
    range: { min: 0, max: RANGE.RANGED },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Holy,
    cooldown: 20,
    triggersGcd: true,
    requiresLos: true,
    cost: { resource: Resource.Mana, amount: 60 },
    counters: '只处理移动限制：昏迷、恐惧、变形、沉默一概不解（对照 8.3 战斗意志的解除清单）；免疫窗口只有 3 秒，等它过期再上减速定身即可；本体是魔法增益，敌方驱散魔法可以直接摘掉（8.4）；对已经被击退/拉拽的位移无效。',
    effects: [
      // 8.4 驱散只移除技能说明允许的类别：这里只清移动限制（减速 / 定身）。
      // schema 的 dispel.count 没有「全部」的表达，先用一个足够大的数表示全清。
      { kind: 'dispel', types: [DispelType.Movement], count: 99, from: 'ally' },
      {
        kind: 'applyAura',
        target: 'target',
        aura: {
          id: 'paladin.blessing_of_freedom',
          name: '自由庇佑',
          kind: 'buff',
          duration: 3,
          dispelType: DispelType.Magic,
          flags: { immuneMovementImpair: true },
          description: '免疫新的减速与定身。',
          vfx: 'paladin_blessing_of_freedom',
        },
      },
    ],
    description: '解除友方身上的减速和定身，并在 3 秒内免疫新的减速和定身。',
    vfx: 'paladin_blessing_of_freedom',
  },
  {
    id: asSkillId('paladin.blessing_of_protection'),
    name: '守护庇佑',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Ally,
    range: { min: 0, max: RANGE.RANGED },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Holy,
    cooldown: 45,
    triggersGcd: true,
    requiresLos: true,
    cost: { resource: Resource.Mana, amount: 80 },
    // 8.4 / 12.3：旗手获得物理免疫时立即掉旗。schema 只有「使用者掉旗」这一个标记，
    // 所以这里既标 dropsFlagOnUse（自我保护时的情形），也用 custom 处理受益者掉旗。
    dropsFlagOnUse: true,
    counters: '只挡物理：法术伤害、持续魔法伤害和所有法术控制照常命中，法系队友对它几乎无感；受益者自己被「缴械」（不能进行物理攻击），近战 DPS 吃到等于被废 4 秒；魔法增益，可被驱散魔法直接移除（8.4）；旗手一拿到就掉旗（12.3），无法用来护送；45 秒冷却，用掉后进攻方有明显的追击窗口。',
    effects: [
      {
        kind: 'applyAura',
        target: 'target',
        aura: {
          id: 'paladin.blessing_of_protection',
          name: '守护庇佑',
          kind: 'buff',
          duration: 4,
          dispelType: DispelType.Magic,
          clearableByTrinket: false,
          flags: { immunePhysical: true, disarmed: true },
          description: '免疫物理伤害，但自身无法进行物理攻击。',
          vfx: 'paladin_blessing_of_protection',
        },
      },
      /**
       * M11：原本是 `custom`（`paladin.dropFlagOnTarget`）。schema v1.1 的
       * `{ kind: 'dropFlag'; target }` 已经存在且 handler 已注册
       * （`effects/displacement.ts`），所以这里是直接替换。
       *
       * ★ 与 `SkillDef.dropsFlagOnUse` 的分工：那个作用于**施法者**，
       *   这个作用于**受益者** —— 保护祝福是给别人加免疫，掉旗的是那个别人。
       *   12.3 要求「获得完全免疫时掉旗」，两边都要覆盖才完整。
       */
      { kind: 'dropFlag', target: 'target' },
    ],
    description: '使友方 4 秒内免疫物理伤害，期间无法进行物理攻击。旗手获得时立即掉旗。',
    vfx: 'paladin_blessing_of_protection',
  },
  {
    id: asSkillId('paladin.divine_shield'),
    name: '神圣壁障',
    classId: CLASS_ID,
    targeting: Targeting.Self,
    targetFilter: TargetFilter.Self,
    range: { min: 0, max: 0 },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Holy,
    cooldown: 90,
    triggersGcd: true,
    // 8.4 进入完全无敌立即掉旗
    dropsFlagOnUse: true,
    cost: { resource: Resource.Mana, amount: 100 },
    counters: '使用瞬间掉旗（8.4 / 12.3），不能用来强推夺旗；期间输出与治疗腰斩 50%，等于主动让出 4 秒节奏，对手拉开距离等它结束即可；属于魔法增益，允许解除免疫的群体驱散可以直接打掉（10.x）；90 秒冷却，交掉之后是圣骑士最脆弱的窗口；不缩短已经落在队友身上的控制。',
    effects: [
      {
        kind: 'applyAura',
        target: 'self',
        aura: {
          id: 'paladin.divine_shield',
          name: '神圣壁障',
          kind: 'buff',
          duration: 4,
          // 可被「群体驱散」摘掉（dispel.canRemoveImmunity），因此不是 None
          dispelType: DispelType.Magic,
          clearableByTrinket: false,
          flags: { immuneAll: true },
          modifiers: { damageDealt: 0.5, healingDone: 0.5 },
          description: '完全免疫，但造成的伤害与治疗降低 50%。',
          vfx: 'paladin_divine_shield',
        },
      },
    ],
    description: '4 秒内完全免疫，期间输出和治疗降低 50%。使用时立即掉旗，可被群体驱散。',
    vfx: 'paladin_divine_shield',
  },
  {
    id: asSkillId('paladin.avenging_wrath'),
    name: '义愤',
    classId: CLASS_ID,
    targeting: Targeting.Self,
    targetFilter: TargetFilter.Self,
    range: { min: 0, max: 0 },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Holy,
    cooldown: 60,
    triggersGcd: true,
    cost: { resource: Resource.Mana, amount: 60 },
    counters: '金色光柱是高可读性信号（14.2），对手一眼就能判断该拉开距离、开减伤还是直接上控制链；不提供任何防御，开启后被昏迷/沉默/驱离就是纯亏 10 秒；魔法增益，可被驱散魔法移除（8.4）；治疗加成同样受竞技场战斗抑制压制（8.5）。',
    effects: [
      {
        kind: 'applyAura',
        target: 'self',
        aura: {
          id: 'paladin.avenging_wrath',
          name: '义愤',
          kind: 'buff',
          duration: 10,
          dispelType: DispelType.Magic,
          modifiers: { damageDealt: 1.2, healingDone: 1.2 },
          description: '造成的伤害与治疗提高 20%。',
          vfx: 'paladin_avenging_wrath',
        },
      },
    ],
    description: '10 秒内伤害和治疗提高 20%，拥有高可读性的金色视觉。',
    vfx: 'paladin_avenging_wrath',
  },
  // 武器方案授予的技能
  {
    id: asSkillId('paladin.shield_of_the_righteous'),
    name: '义盾撞',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: RANGE.MELEE },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Physical,
    cooldown: 9,
    triggersGcd: true,
    requiresFacing: true,
    requiresLos: true,
    cost: { resource: Resource.Mana, amount: 30 },
    counters: '仅剑盾方案可用（10.2 武器决定技能表），换成双手战锤或权杖后按钮直接消失；缴械后禁用（7.3）；要求贴身并面向目标（6.5）；减伤只有 4 秒且不是免疫，控制链照常生效。',
    effects: [
      { kind: 'damage', school: School.Physical, amount: { weaponPercent: 1.0 } },
      {
        kind: 'applyAura',
        target: 'self',
        aura: {
          id: 'paladin.shield_of_the_righteous',
          name: '正义庇护',
          kind: 'buff',
          duration: 4,
          dispelType: DispelType.None,
          modifiers: { damageTaken: 0.9 },
          description: '受到的伤害降低 10%。',
          vfx: 'paladin_shield_of_the_righteous',
        },
      },
    ],
    description: '用盾牌猛击目标造成 100% 武器伤害，并在 4 秒内使自身受到的伤害降低 10%。仅剑盾方案可用。',
  },
  {
    id: asSkillId('paladin.templar_strike'),
    name: '圣殿重击',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: RANGE.MELEE_EXTENDED },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Physical,
    cooldown: 9,
    triggersGcd: true,
    requiresFacing: true,
    requiresLos: true,
    cost: { resource: Resource.Mana, amount: 30 },
    counters: '仅双手战锤方案可用，取代盾击，且该方案自身防御 -10%、没有格挡；缴械后禁用武器部分（7.3）；附带的神圣爆发属于魔法伤害，会被法术减伤和抗法型护甲吃掉；仍然要求贴身 3.4 米与正面朝向（6.5）。',
    effects: [
      { kind: 'damage', school: School.Physical, amount: { weaponPercent: 1.45 } },
      { kind: 'damage', school: School.Holy, amount: { flat: 45 } },
      { kind: 'gainResource', resource: Resource.HolyPower, amount: 1 },
    ],
    description: '双手战锤重击，造成 145% 武器伤害与额外神圣伤害，并获得 1 点圣能。仅双手战锤方案可用。',
  },
  {
    id: asSkillId('paladin.holy_bolt'),
    name: '圣光弹',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: RANGE.MEDIUM },
    shape: { kind: 'single' },
    // 权杖方案用 1 秒读条换取 25 米距离，因此多了一个可被打断的窗口
    cast: { kind: CastKind.Cast, time: 1.0, movable: false, interruptible: true },
    school: School.Holy,
    cooldown: 4.5,
    triggersGcd: true,
    requiresLos: true,
    cost: { resource: Resource.Mana, amount: 45 },
    counters: '仅权杖+圣典方案可用，取代十字军打击；1 秒读条且必须原地，专用打断会连带锁死神圣学派 3 秒，把圣光术一起封掉（7.2）；沉默、硬控、击退和自己移动都会中止（7.3）；该方案物理防御 -12%，被近战贴脸时非常脆。',
    effects: [
      { kind: 'damage', school: School.Holy, amount: { flat: 100 } },
      { kind: 'gainResource', resource: Resource.HolyPower, amount: 1 },
    ],
    description: '射出一枚圣光弹造成神圣伤害并获得 1 点圣能。仅权杖+圣典方案可用。',
    vfx: 'paladin_holy_bolt',
  },
];

// ── 武器方案（附录A#4：职业、攻击间隔、距离、优势、代价、改变的技能）──

const weapons: WeaponDef[] = [
  {
    id: asWeaponId('paladin.sword_shield'),
    name: '单手剑 + 盾牌',
    classId: CLASS_ID,
    isDefault: true,
    handedness: 'oneHand',
    swingInterval: 1.8,
    // M14：0.9→0.72 —— 圣骑曾以 85.7% 胜率霸榜；治疗+圣盾的生存性由白字侧买单
    swingPercent: 0.72,
    reach: RANGE.MELEE,
    modifiers: { block: 0.15, damageTaken: 0.88 },
    advantage: '防御 +12%，可格挡',
    cost: '持续伤害较低',
    grantsSkills: [asSkillId('paladin.shield_of_the_righteous')],
    removesSkills: [asSkillId('paladin.templar_strike'), asSkillId('paladin.holy_bolt')],
    model: 'sword_shield',
  },
  {
    id: asWeaponId('paladin.two_hand_hammer'),
    name: '双手战锤',
    classId: CLASS_ID,
    isDefault: false,
    handedness: 'twoHand',
    swingInterval: 2.5,
    swingPercent: 1.5,
    reach: RANGE.MELEE_EXTENDED,
    modifiers: { damageTaken: 1.1 },
    advantage: '神圣爆发和范围压力高',
    cost: '防御 -10%，无格挡',
    grantsSkills: [asSkillId('paladin.templar_strike')],
    removesSkills: [asSkillId('paladin.shield_of_the_righteous'), asSkillId('paladin.holy_bolt')],
    model: 'two_hand_hammer',
  },
  {
    id: asWeaponId('paladin.scepter_codex'),
    name: '权杖 + 圣典',
    classId: CLASS_ID,
    isDefault: false,
    handedness: 'ranged',
    swingInterval: 1.6,
    // M14：0.65→0.5 —— 权杖档随剑盾档同比例回调
    swingPercent: 0.5,
    reach: RANGE.MEDIUM,
    // 7.6：普通攻击走远程圣光弹规则
    isRanged: true,
    /**
     * 文档写的是「**物理**防御 -12%」。
     * ★ M11：原注释说「按全局近似，要精确表达需要按 school 拆分的承伤修正」——
     *   `damageTakenBySchool` 早已进 v1.1 并实现，数据没跟上。现在精确表达：
     *   只有物理承伤 +12%，魔法承伤不变。近似写法此前让这把武器**连魔法也多挨 12%**，
     *   比文档描述的更弱。
     */
    modifiers: {
      damageTaken: 1,
      damageTakenBySchool: { [School.Physical]: 1.12 },
      healingDone: 1.1,
      castSpeed: 0.85,
    },
    advantage: '治疗 +10%，读条时间 -15%',
    cost: '物理防御 -12%，近战输出低',
    grantsSkills: [asSkillId('paladin.holy_bolt')],
    removesSkills: [
      asSkillId('paladin.crusader_strike'),
      asSkillId('paladin.shield_of_the_righteous'),
      asSkillId('paladin.templar_strike'),
    ],
    model: 'scepter_codex',
  },
];

export const paladin: ClassDef = {
  id: CLASS_ID,
  name: '圣骑士',
  role: '近战支援、治疗、祝福与保护',
  baseHealth: 1100,
  resources: [
    // M14：12→8 —— 法力回复兑现后圣骑马拉松续航过强，压回复而不是继续压单次治疗量
    { resource: Resource.Mana, max: 1000, start: 1000, regenPerSecond: 8 },
    // 圣能只能靠十字军打击 / 圣光弹积攒，不自然回复
    { resource: Resource.HolyPower, max: 5, start: 0, regenPerSecond: 0 },
  ],
  strengths: '保护队友、解除移动限制、短时免疫',
  weaknesses: '机动一般、关键防御冷却长、被驱散后窗口明显',
  defaultWeaponId: asWeaponId('paladin.sword_shield'),
  defaultArmorId: asArmorId('paladin.default'),
  skills,
  weapons,
  armors: makeArmorSet(CLASS_ID, { defaultName: '板甲' }),
  // 默认剑盾为近战物理；换成权杖+圣典后由 WeaponDef.isRanged 覆盖为远程圣光
  autoAttack: { ranged: false, school: School.Physical },
};
