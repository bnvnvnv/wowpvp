/**
 * 德鲁伊 —— 设计文档 9.8
 * 定位：形态切换、持续治疗、定身控制、高机动旗手。生命 1050。
 * 资源：法力；形态下使用能量（猎豹）或怒气（熊）。
 *
 * 结构、注释与命名风格对齐 packages/shared/src/data/classes/warrior.ts（数据文件范本）。
 *
 * 本职业的两个核心特殊规则（12.3 夺旗）：
 *  1. 熊形态**可以携带旗帜**，是全游戏最主要的旗手形态；
 *  2. 猎豹形态的潜行**在携旗时不可用**（旗手不能潜行、完全隐身、坐骑、飞行、长距离传送）；
 *  3. 群奔咆哮给旗手自己的加速受 12.3「旗手移动加成总上限」限制（CTF.FLAG_CARRIER_MAX_SPEED_BONUS = 10%）。
 */

import { CTF, RANGE } from '../../constants/combat.js';
import {
  CastKind,
  DispelType,
  DrCategory,
  Resource,
  School,
  TargetFilter,
  Targeting,
} from '../../types/enums.js';
import { asArmorId, asClassId, asSkillId, asWeaponId } from '../../types/ids.js';
import { makeArmorSet } from '../armors.js';
import type { ClassDef, SkillDef, WeaponDef } from '../schema.js';

const CLASS_ID = asClassId('druid');

/**
 * 形态光环没有自然到期时间：它持续到主动切换形态、变回人形或死亡为止。
 * AuraDef.duration 是必填的数字，schema 目前没有「无限持续」的表示方式，
 * 这里用一个远超单局时长的值代替，由 sim 层的形态切换逻辑负责移除。
 */
const FORM_AURA_DURATION = 3600;

// ── 技能 ─────────────────────────────────────────────────────────

const skills: SkillDef[] = [
  {
    id: asSkillId('druid.moonfire'),
    name: '月辉灼击',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: RANGE.RANGED },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Nature,
    cooldown: 6,
    triggersGcd: true,
    requiresLos: true,
    // 文档未给出具体资源消耗，这里按法力池（1000，每秒回 13）给出基线值
    // M14：45→40 —— 治疗（120 耗）与输出共享法力，回复 13/s 下让两者能并行
    cost: { resource: Resource.Mana, amount: 40 },
    counters: '瞬发但伤害偏低，靠持续伤害积累；持续伤害属于魔法减益，可被驱散魔法直接移除（8.4），也不能被「战斗意志」解除（8.3）；沉默期间无法施放；只能在人形下使用，进入形态后失去这条消耗手段。',
    effects: [
      // M14：90→175 —— 月火是德鲁伊唯一直伤：占位值下他打不死任何人（基线 4.8% 胜率）
      // M14b：175→205 —— 减速与位移生效后近战贴脸时间变长，唯一直伤再抬一档（基线 19.0%）
      { kind: 'damage', school: School.Nature, amount: { flat: 205, powerCoef: 0.35 } },
      {
        kind: 'applyAura',
        aura: {
          id: 'druid.moonfire.dot',
          name: '月火',
          kind: 'debuff',
          duration: 12,
          dispelType: DispelType.Magic,
          clearableByTrinket: false,
          periodic: {
            interval: 3,
            // M14：25→55 —— DoT 与直伤同轮加码，长局职业吃满 12 秒跳
            effects: [{ kind: 'damage', school: School.Nature, amount: { flat: 55, powerCoef: 0.1 } }],
          },
          description: '每 3 秒受到一次自然伤害，持续 12 秒。',
          vfx: 'druid_moonfire_dot',
        },
      },
    ],
    description: '造成初始自然伤害，并附加 12 秒持续伤害。',
    vfx: 'druid_moonfire',
  },
  {
    id: asSkillId('druid.healing_touch'),
    name: '愈合',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Ally,
    range: { min: 0, max: RANGE.RANGED },
    shape: { kind: 'single' },
    // 7.3 「原地施放」：主动移动会终止读条
    cast: { kind: CastKind.Cast, time: 1.3, movable: false, interruptible: true },
    school: School.Nature,
    cooldown: 5,
    triggersGcd: true,
    requiresLos: true,
    cost: { resource: Resource.Mana, amount: 120 },
    counters: '1.3 秒读条且必须原地：专用打断会锁自然学派 3 秒（7.2），昏迷、恐惧、击退和主动移动都能打断；被「致死打击」一类降治疗减益压制时收益明显下降；形态下不可施放，切回人形本身要吃 1 秒公共冷却。',
    effects: [
      // M14：220→270 —— 主动治疗职业的生存底盘，与月火同轮定值
      { kind: 'heal', amount: { flat: 270, powerCoef: 0.6 } },
      {
        kind: 'applyAura',
        aura: {
          id: 'druid.healing_touch.hot',
          name: '愈合余波',
          kind: 'buff',
          duration: 4,
          dispelType: DispelType.Magic,
          periodic: {
            interval: 2,
            effects: [{ kind: 'heal', amount: { flat: 35, powerCoef: 0.1 } }],
          },
          description: '4 秒内每 2 秒恢复少量生命。',
          vfx: 'druid_healing_touch_hot',
        },
      },
    ],
    description: '立即治疗友方目标，并附加 4 秒短时持续治疗。',
    vfx: 'druid_healing_touch',
  },
  {
    id: asSkillId('druid.rejuvenation'),
    name: '回春',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Ally,
    range: { min: 0, max: RANGE.RANGED },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Nature,
    cooldown: 8,
    triggersGcd: true,
    requiresLos: true,
    cost: { resource: Resource.Mana, amount: 90 },
    counters: '整段治疗都靠持续跳数，前置爆发为零，对付瞬间集火几乎无效；作为魔法增益可被敌方驱散魔法直接摘掉（8.4）；沉默期间无法施放，形态下不可用。',
    effects: [
      {
        kind: 'applyAura',
        aura: {
          id: 'druid.rejuvenation',
          name: '回春',
          kind: 'buff',
          duration: 6,
          dispelType: DispelType.Magic,
          periodic: {
            interval: 1.5,
            effects: [{ kind: 'heal', amount: { flat: 55, powerCoef: 0.15 } }],
          },
          description: '6 秒内每 1.5 秒恢复生命。',
          vfx: 'druid_rejuvenation',
        },
      },
    ],
    description: '为友方目标附加 6 秒持续治疗。',
    vfx: 'druid_rejuvenation',
  },
  {
    id: asSkillId('druid.entangling_roots'),
    name: '缠根',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: RANGE.RANGED },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Cast, time: 1.3, movable: false, interruptible: true },
    school: School.Nature,
    cooldown: 15,
    triggersGcd: true,
    requiresLos: true,
    cost: { resource: Resource.Mana, amount: 80 },
    counters: '1.3 秒原地读条，打断、沉默、昏迷和自身被迫移动都能取消；定身受 root 递减链影响（8.2，100%→50%→25%→免疫）；受到较高伤害会提前解除，所以不要在集火目标身上开；「战斗意志」、自由祝福、闪现、消失、逃脱都能直接摆脱；被定身者仍可正常施法与攻击。',
    effects: [
      // 8.2 定身受伤解除：阈值取基础生命的约 30%
      { kind: 'root', duration: 3, breakDamage: 300 },
    ],
    description: '将目标定身 3 秒，受到较高伤害后提前解除。',
    vfx: 'druid_entangling_roots',
  },
  {
    id: asSkillId('druid.cyclone'),
    name: '气旋囚笼',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: RANGE.MEDIUM },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Cast, time: 1.5, movable: false, interruptible: true },
    school: School.Nature,
    cooldown: 25,
    triggersGcd: true,
    requiresLos: true,
    cost: { resource: Resource.Mana, amount: 100 },
    counters: '最长的一条读条（1.5 秒原地），是德鲁伊最容易被打断的技能；受迷惑递减链影响（8.2 incapacitate，100%→50%→25%→免疫）；目标同时无法被攻击也无法被治疗，误用会救下对手；可被驱散魔法移除，也可被「战斗意志」解除（8.3）。',
    effects: [
      {
        kind: 'applyAura',
        aura: {
          id: 'druid.cyclone',
          name: '气旋囚笼',
          kind: 'debuff',
          duration: 2.5,
          dispelType: DispelType.Magic,
          drCategory: DrCategory.Incapacitate,
          clearableByTrinket: true,
          // untargetable：不能被选中、攻击或治疗；stunned：无法行动
          flags: { untargetable: true, stunned: true },
          description: '被卷入旋风，2.5 秒内无法行动，也无法被攻击或治疗。',
          vfx: 'druid_cyclone',
        },
      },
    ],
    description: '将目标卷入旋风 2.5 秒，期间目标无法行动，也无法被攻击或治疗。受控制递减影响。',
    vfx: 'druid_cyclone',
  },
  {
    id: asSkillId('druid.skull_bash'),
    name: '撞击',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: 13 },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Physical,
    cooldown: 15,
    // 7.2 专用打断不触发公共冷却，可以在读条与形态切换之间穿插
    triggersGcd: false,
    requiresLos: true,
    counters: '本质是一次短冲锋 + 打断：墙体、高差或非法落点会让冲锋提前终止（13.5），冲不到就打不断；目标未在施法、或施法带盾牌标记（不可打断）时仍然进冷却（7.2）；假读条可以骗掉；缴械状态下不可用。',
    effects: [
      // 先位移到目标身边，再结算打断——顺序不能颠倒
      { kind: 'chargeTo', minRange: 0, maxRange: 13, stopDistance: RANGE.MELEE },
      { kind: 'interrupt', schoolLockSeconds: 3 },
    ],
    description: '短距离冲向目标并打断其施法，锁定该魔法学派 3 秒。不触发公共冷却。',
    vfx: 'druid_skull_bash',
  },
  {
    id: asSkillId('druid.barkskin'),
    name: '硬化树皮',
    classId: CLASS_ID,
    targeting: Targeting.Self,
    targetFilter: TargetFilter.Self,
    range: { min: 0, max: 0 },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Nature,
    cooldown: 30,
    triggersGcd: true,
    // 文档 9.8：「瞬发，可在昏迷中使用」
    usableWhileStunned: true,
    counters: '只是 25% 减伤，不是免疫，控制链和爆发依然打得穿；只有 4 秒，可以拖到它结束再开手；作为自身增益可被敌方驱散魔法移除（8.4）。',
    effects: [
      {
        kind: 'applyAura',
        target: 'self',
        aura: {
          id: 'druid.barkskin',
          name: '硬化树皮',
          kind: 'buff',
          duration: 4,
          dispelType: DispelType.Magic,
          modifiers: { damageTaken: 0.75 },
          description: '受到的伤害降低 25%。',
          vfx: 'druid_barkskin',
        },
      },
    ],
    description: '4 秒内受到的伤害降低 25%。可在昏迷中使用。',
    vfx: 'druid_barkskin',
  },
  {
    id: asSkillId('druid.bear_form'),
    name: '巨熊形态',
    classId: CLASS_ID,
    targeting: Targeting.Self,
    targetFilter: TargetFilter.Self,
    range: { min: 0, max: 0 },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Nature,
    // 文档 9.8 冷却栏写的是「1 秒公共冷却」——形态切换本身没有独立冷却，
    // 唯一的节流就是公共冷却，因此 cooldown = 0 且 triggersGcd = true。
    cooldown: 0,
    triggersGcd: true,
    counters: '进入熊形态后自身伤害降低 20%，是明确的攻防取舍；期间无法施放治疗与读条法术，想救人必须先变回人形再吃一次公共冷却；不是免疫，控制链照常生效；缴械会封掉熊形态的武器攻击。**可携带旗帜**——12.3 只禁止旗手潜行、完全隐身、坐骑、飞行与长距离传送，熊形态不在其列，因此这是最标准的旗手姿态，对手必须靠硬控和爆发而不是靠形态限制来阻止。',
    effects: [
      { kind: 'shapeshift', form: 'bear' },
      {
        kind: 'applyAura',
        target: 'self',
        aura: {
          id: 'druid.bear_form',
          name: '巨熊形态',
          kind: 'buff',
          duration: FORM_AURA_DURATION,
          dispelType: DispelType.None,
          clearableByTrinket: false,
          modifiers: { maxHealth: 1.2, damageTaken: 0.85, damageDealt: 0.8 },
          description: '最大生命提高 20%，受到的伤害降低 15%，造成的伤害降低 20%。可携带旗帜。',
          vfx: 'druid_bear_form',
        },
      },
    ],
    description: '变为熊形态：最大生命提高 20%、承受伤害降低，自身伤害降低 20%。使用怒气，可携带旗帜。',
    vfx: 'druid_bear_form',
  },
  {
    id: asSkillId('druid.cat_form'),
    name: '迅猫形态',
    classId: CLASS_ID,
    targeting: Targeting.Self,
    targetFilter: TargetFilter.Self,
    range: { min: 0, max: 0 },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Nature,
    // 同熊形态：没有独立冷却，只受 1 秒公共冷却节流
    cooldown: 0,
    triggersGcd: true,
    counters: '15% 移动加成没有任何减伤，猎豹形态下极其脆；期间不能治疗与读条；潜行只能在**脱离战斗**后进入，进战即被打断；**携旗时不能潜行**（12.3：旗手不能潜行、完全隐身、坐骑、飞行或长距离传送；若强行使用潜行类效果会先掉旗再播放表现），所以猎豹只能用来跑无旗的路，接旗前必须换形态；照明弹一类的揭露效果和范围伤害都能拆掉潜行。',
    effects: [
      { kind: 'shapeshift', form: 'cat' },
      {
        kind: 'applyAura',
        target: 'self',
        aura: {
          id: 'druid.cat_form',
          name: '迅猫形态',
          kind: 'buff',
          duration: FORM_AURA_DURATION,
          dispelType: DispelType.None,
          clearableByTrinket: false,
          modifiers: { moveSpeed: 1.15 },
          description: '移动速度提高 15%，脱离战斗后可进入潜行。携带旗帜时不能潜行。',
          vfx: 'druid_cat_form',
        },
      },
      /**
       * ★ M11：原本是一条 `custom`（`druid.prowl`），**从未注册**。
       *
       *   ⚠️ 但它**不能**像盗贼潜行那样迁到 `requires` —— 语义不同：
       *      `requires` 是**施法瞬间**的门禁（「现在能不能变形」），
       *      而 9.8 要的是「变形**期间**脱战即可潜行」的**持续**能力。
       *      写成 `requires: [{outOfCombat}]` 会变成「战斗中不能变猎豹」，
       *      那是另一条规则，而且是错的。
       *
       *   所以这里**只删掉那个从未生效的 custom**，把「脱战可潜行」
       *   如实降级为**尚未实现**（已登记在 PROGRESS 技术债）——
       *   保留一个假装在工作的 handler 比缺失更糟。
       *   12.3「携旗不能潜行」那一半由 `forbiddenWhileCarryingFlag` 覆盖。
       */
    ],
    description: '变为猎豹形态：移动速度提高 15%，脱离战斗后可潜行。使用能量。携带旗帜时不能潜行。',
    vfx: 'druid_cat_form',
  },
  {
    id: asSkillId('druid.wild_charge'),
    name: '野性突进',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    // 形态决定目标阵营：熊/猎豹指向敌人，人形指向友方
    targetFilter: TargetFilter.Any,
    range: { min: 0, max: 10 },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Physical,
    cooldown: 20,
    triggersGcd: true,
    requiresLos: true,
    counters: '必须落在合法位置：墙体、高差、非法区域会让位移提前终止或直接失败（13.5）；定身状态下不可用（位移不解定身）；20 秒冷却意味着交出去之后有很长的追杀窗口；旗手使用时距离照 12.3 降低，且不能穿墙或进入非法区域。',
    effects: [
      /**
       * 一个按键三种行为，schema 没有「按形态分支」的效果 kind，
       * 因此交给自定义处理器按当前形态分派：
       *  - bear     → 冲向敌方目标（等价 chargeTo）
       *  - cat      → 跃向目标（等价一次带弧线的位移）
       *  - humanoid → 向友方移动（等价 chargeToAlly）
       * 三个分支都必须复用同一套合法落点校验（13.5）。
       */
      {
        kind: 'custom',
        handler: 'druid.wild_charge',
        params: {
          bear: 'chargeToEnemy',
          cat: 'leapToTarget',
          humanoid: 'chargeToAlly',
          maxRange: 10,
          stopDistance: RANGE.MELEE,
        },
      },
    ],
    description: '按当前形态位移 10 米：熊形态冲向敌人，猎豹形态跃向目标，人形向友方移动。必须落在合法位置。',
    vfx: 'druid_wild_charge',
  },
  {
    id: asSkillId('druid.stampeding_roar'),
    name: '疾奔怒吼',
    classId: CLASS_ID,
    targeting: Targeting.SelfCenter,
    targetFilter: TargetFilter.Ally,
    range: { min: 0, max: 10 },
    shape: { kind: 'circle', radius: 10 },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Nature,
    cooldown: 60,
    triggersGcd: true,
    counters: `60 秒冷却，是全队级别的一次性资源，交早了就再没有第二次；只加速不解控，减速和定身依然压得住队伍；作为魔法增益可被驱散魔法逐个摘掉（8.4）；**如果自己正在持旗，本次加速对自己最多只有 10%**——12.3 规定旗手移动加成存在总上限（CTF.FLAG_CARRIER_MAX_SPEED_BONUS = +${CTF.FLAG_CARRIER_MAX_SPEED_BONUS * 100}%），25% 会被截断，护送者跑得比旗手快是设计意图。`,
    effects: [
      {
        kind: 'applyAura',
        target: 'allInShape',
        aura: {
          id: 'druid.stampeding_roar',
          name: '群奔',
          kind: 'buff',
          duration: 5,
          dispelType: DispelType.Magic,
          /**
           * 名义值 +25%。旗手自身的实际加成由 sim 层按
           * CTF.FLAG_CARRIER_MAX_SPEED_BONUS（12.3，总上限 +10%）截断，
           * 这条上限对所有移动加成统一生效，不在光环数据里重复表达。
           */
          modifiers: { moveSpeed: 1.25 },
          description: '移动速度提高 25%，持续 5 秒。持旗者受旗手移动加成上限限制，最多提高 10%。',
          vfx: 'druid_stampeding_roar',
        },
      },
    ],
    description: '半径 10 米内的友方移动速度提高 25%，持续 5 秒。持旗者自身最多获得 10%（12.3 旗手移动加成上限）。',
    vfx: 'druid_stampeding_roar',
  },
];

// ── 武器方案（附录A#4：职业、攻击间隔、距离、优势、代价、改变的技能）──

const weapons: WeaponDef[] = [
  {
    id: asWeaponId('druid.nature_staff'),
    name: '自然法杖',
    classId: CLASS_ID,
    isDefault: true,
    handedness: 'staff',
    swingInterval: 1.8,
    // M14：0.55→0.6 —— 自然法杖白字 33/s，法系三家里最低（德鲁伊重治疗与机动）
    swingPercent: 0.6,
    reach: 28,
    // 9.8 默认装备：28 米，约 1.8 秒一次自然法术弹 → 普通攻击走射击规则（7.6）
    isRanged: true,
    // 「控制 +10%」（控制持续时间加成）在 AuraModifiers 里没有对应字段，
    // 只能落在 advantage 文本上；「动物形态伤害 -10%」同样没有按形态区分的伤害字段。
    modifiers: { healingDone: 1.1 },
    advantage: '治疗和控制 +10%',
    cost: '动物形态伤害 -10%',
    // 文档 9.8 的「技能变化」列写的是**强化已有技能**，没有授予新技能
    skillModifiers: {
      'druid.healing_touch': { damageMultiplier: 1.1 },
      'druid.entangling_roots': { cooldownMultiplier: 0.9 },
    },
    model: 'nature_staff',
  },
  {
    id: asWeaponId('druid.polearm'),
    name: '长柄战刃',
    classId: CLASS_ID,
    isDefault: false,
    handedness: 'twoHand',
    swingInterval: 2.1,
    swingPercent: 1.2,
    // 文档表格明确写 3.6 米，比 RANGE.MELEE_POLEARM（3.8）短，此处以文档为准
    reach: 3.6,
    modifiers: { healingDone: 0.88 },
    advantage: '动物形态伤害 +15%，近战范围较长',
    cost: '治疗 -12%，攻速慢',
    skillModifiers: {
      'druid.bear_form': { damageMultiplier: 1.15 },
      'druid.cat_form': { damageMultiplier: 1.15 },
    },
    model: 'druid_polearm',
  },
  {
    id: asWeaponId('druid.mace_totem'),
    name: '单手锤 + 自然图腾',
    classId: CLASS_ID,
    isDefault: false,
    handedness: 'oneHand',
    swingInterval: 1.6,
    swingPercent: 0.85,
    reach: RANGE.MELEE,
    advantage: '控制与团队辅助更强',
    cost: '没有高爆发，防御一般',
    skillModifiers: {
      'druid.stampeding_roar': { cooldownMultiplier: 0.9 },
      'druid.barkskin': { cooldownMultiplier: 0.9 },
    },
    model: 'druid_mace_totem',
  },
];

export const druid: ClassDef = {
  id: CLASS_ID,
  name: '德鲁伊',
  role: '形态切换、持续治疗、定身控制、高机动旗手',
  baseHealth: 1050,
  // 9.8：法力；形态下使用能量（猎豹）或怒气（熊）
  resources: [
    { resource: Resource.Mana, max: 1000, start: 1000, regenPerSecond: 13 },
    { resource: Resource.Energy, max: 100, start: 100, regenPerSecond: 10 },
    { resource: Resource.Rage, max: 100, start: 0, regenPerSecond: 0 },
  ],
  strengths: '机动、持续恢复、形态适应、旗手生存',
  weaknesses: '爆发依赖形态和站位、核心控制有读条、频繁切换需要判断',
  defaultWeaponId: asWeaponId('druid.nature_staff'),
  defaultArmorId: asArmorId('druid.default'),
  skills,
  weapons,
  armors: makeArmorSet(CLASS_ID, { defaultName: '皮甲' }),
  // 默认武器是自然法杖：28 米自然法术弹，走射击规则
  autoAttack: { ranged: true, school: School.Nature },
};
