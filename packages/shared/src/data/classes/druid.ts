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

import { CTF, RANGE, SPELL_PROJECTILE } from '../../constants/combat.js';
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
    // W23：月火要飞到才结算（6.6 锁定投射物）—— 直伤与 DoT 都是目标指向效果
    effects: [
      {
        kind: 'lockedProjectile',
        speed: SPELL_PROJECTILE.SPEED,
        onHit: [
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
            },
          },
        ],
      },
    ],
    description: '造成初始自然伤害，并附加 12 秒持续伤害。',
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
    counters: '1.3 秒读条且必须原地：专用打断会封锁自然系技能 3 秒（7.2），昏迷、恐惧、击退和主动移动都能打断；被「致死打击」一类降治疗减益压制时收益明显下降；形态下不可施放，切回人形本身要吃 1 秒公共冷却。',
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
        },
      },
    ],
    description: '立即治疗友方目标，并附加 4 秒短时持续治疗。',
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
        },
      },
    ],
    description: '为友方目标附加 6 秒持续治疗。',
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
    // W23：根须要长过去才缠上（6.6）
    effects: [
      {
        kind: 'lockedProjectile',
        speed: SPELL_PROJECTILE.SPEED,
        // 8.2 定身受伤解除：阈值取基础生命的约 30%
        onHit: [{ kind: 'root', duration: 3, breakDamage: 300 }],
      },
    ],
    description: '将目标定身 3 秒，受到较高伤害后提前解除。',
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
    // W23：旋风要卷过去才罩住（6.6）
    effects: [
      {
        kind: 'lockedProjectile',
        speed: SPELL_PROJECTILE.SPEED,
        onHit: [
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
            },
          },
        ],
      },
    ],
    description: '将目标卷入旋风 2.5 秒，期间目标无法行动，也无法被攻击或治疗。受控制递减影响。',
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
    description: '短距离冲向目标并打断其施法，封锁该系魔法技能 3 秒。不触发公共冷却。',
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
    /**
     * ★ P11 保命轮：CD 30 → 60，对齐 WoW 树皮术（正式服：CD 60）。
     *   这是「减伤翻倍」那半笔账的另一半代价 —— 从 30 秒一转的节奏键
     *   变成一分钟一次的真保命键。⚠️ 在配平基线（场均 12~23 秒）里
     *   这个代价**看不出来**：一局本来也只按得到一次。它兑现在夺旗
     *   （12~15 分钟）和真人的长回合里，那正是玩家反馈的场景。
     */
    cooldown: 60,
    triggersGcd: true,
    // 文档 9.8：「瞬发，可在昏迷中使用」
    usableWhileStunned: true,
    counters: '**只是 50% 减伤，不是免疫** —— 控制链照常生效，被昏迷按住 6 秒同样会死；只有 6 秒，可以拖到它结束再开手；作为自身增益**可被敌方驱散魔法移除**（8.4），这是它相对战士盾墙、死骑冰封坚韧（都不可驱散）最明显的短板 —— 对面带牧师/法师时，这个键随时可能被一发净化直接抹掉；CD 60 秒，交掉后有整整一分钟空窗。',
    /**
     * ★ P11 保命轮：25% 减伤 / 4 秒 → **50% / 6 秒**，CD 30 → 60。
     *
     *   审计判据是「按下后能扛住 3 秒集火」。25% / 4 秒达不到：
     *   1050 血的皮甲，四分之一减伤只是把 3 秒变成 4 秒 —— 玩家说的
     *   「按了也没用」在德鲁伊身上是最字面的一条。
     *   德鲁伊此前的保命全靠**治疗**（愈合/回春），而治疗是持续量，
     *   对**瞬间集火**结构性无解：回春 6 秒才给完，人 3 秒就没了。
     *
     * ★ 量级依据（WoW：树皮术 20%/12 秒/CD 60 + 生存本能 50%/6 秒/CD 180）：
     *   本仓库把两个键**合并成一个** —— 不新增技能而是加强既有键，
     *   是这一轮「优先加强既有弱保命技」的纪律。数值取生存本能那一档
     *   （50% / 6 秒），冷却取树皮术那一档（60 秒）：比正式服的任何单
     *   一个键都强，但德鲁伊在正式服**两个都有**，合并后总量是下降的。
     *
     * ★ 保留 `dispelType: Magic`（可被驱散）—— 这是刻意不动的那一格：
     *   德鲁伊的保命键必须留一个「被驱散就废」的破绽，否则他就成了
     *   既有治疗、又有硬减伤、还免疫驱散的全能生存职业。
     */
    effects: [
      {
        kind: 'applyAura',
        target: 'self',
        aura: {
          id: 'druid.barkskin',
          name: '硬化树皮',
          kind: 'buff',
          duration: 6,
          dispelType: DispelType.Magic,
          modifiers: { damageTaken: 0.5 },
          description: '受到的伤害降低 50%。',
        },
      },
    ],
    description: '6 秒内受到的伤害降低 50%。可在昏迷中使用，可被驱散魔法剥掉。',
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
        },
      },
    ],
    description: '变为熊形态：最大生命提高 20%、承受伤害降低，自身伤害降低 20%。使用怒气，可携带旗帜。',
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
        },
      },
    ],
    description: '半径 10 米内的友方移动速度提高 25%，持续 5 秒。持旗者自身最多获得 10%（12.3 旗手移动加成上限）。',
  },

  /**
   * ★ P3b 扩充：德鲁伊补「无冷却填充 / 瞬发奥术 / 减伤增益」。
   *
   *   审计里德鲁伊的窟窿是**人形态下几乎只有月火术能按**，
   *   一进战斗就只能切形态。愤怒是那个可以一直按的填充键。
   *
   *   ⚠️ 星涌术刻意用**奥术**而不是自然学派：打断会连带锁死一个学派
   *   3 秒（7.2），德鲁伊其余伤害法术全是自然系，被自然锁住时它是唯一
   *   还能按的伤害键 —— 这是德鲁伊对抗打断的唯一结构性手段，不能让
   *   它们同属一系。（它必须瞬发，理由见技能内注释。）
   */
  {
    id: asSkillId('druid.wrath'),
    name: '愤怒',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: RANGE.RANGED },
    shape: { kind: 'single' },
    /**
     * 读条 1.4s 而不是 9.x 的 1.5s —— 对齐本仓库既有的「填充核弹」档位：
     * 法师霜矢 1.4、牧师圣光击 1.2、圣骑圣光弹 1.0，全部落在 1.0~1.4；
     * 1.5s 那一档在本花名册里只给治疗和变形这类**功能性**长咒。
     * 差 0.1 秒看着像凑数，但 `skill-audit` 正好卡在 1.5s：留在 1.5
     * 会让德鲁伊成为唯一一个填充键被判「难放出」的施法职业 —— 那不是
     * 职业特色，是漏调的数值。
     */
    cast: { kind: CastKind.Cast, time: 1.4, movable: false, interruptible: true },
    school: School.Nature,
    cooldown: 0,
    triggersGcd: true,
    requiresLos: true,
    requires: [{ kind: 'notInForm', forms: ['bear', 'cat'] }],
    cost: { resource: Resource.Mana, amount: 30 },
    counters:
      '**1.4 秒读条且必须原地**：被打断会连带封锁自然系 3 秒，纠缠根须和治疗之触一起封掉（7.2）；沉默、硬控、击退和自己移动都会中止（7.3）；熊/猎豹形态下不可用，切形态就等于放弃它。',
    // W23：飞到才结算（6.6）
    effects: [
      {
        kind: 'lockedProjectile',
        speed: SPELL_PROJECTILE.SPEED,
        onHit: [{ kind: 'damage', school: School.Nature, amount: { flat: 100 } }],
      },
    ],
    description: '召唤自然之力打击目标，造成自然伤害。无冷却，人形态下的主力填充。',
  },
  {
    id: asSkillId('druid.starsurge'),
    name: '星涌术',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: RANGE.RANGED },
    shape: { kind: 'single' },
    /**
     * ★ 这一格原本是 2.5 秒读条的「星火术」，推翻重做成瞬发的星涌术。
     *
     *   原因有二，而且第二条才是真正的理由：
     *   1. 2.5s 是全花名册最长的读条，竞技场里对着清醒的对手放不出来 ——
     *      三个新技能里搭进去一个死键，等于只补了两个。
     *   2. 奥术学派的意义**恰恰要求它瞬发**：打断会连带锁死一个学派 3 秒
     *      （7.2），德鲁伊除此之外全是自然系（月火/愤怒/根须/治疗之触/回春），
     *      被自然锁住时这是唯一还能按的伤害键。可如果它自己是 2.5s 读条，
     *      「锁不住我」就只是纸面上的 —— 刚被打断、正在被贴脸的那三秒，
     *      谁也站不住 2.5 秒。瞬发才让这个结构性解法真的成立。
     */
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Arcane,
    cooldown: 10,
    triggersGcd: true,
    requiresLos: true,
    requires: [{ kind: 'notInForm', forms: ['bear', 'cat'] }],
    cost: { resource: Resource.Mana, amount: 45 },
    counters:
      '**10 秒冷却**，是月火术（6 秒）之外的第二个瞬发键而不是主力输出，单发伤害低于月火术首击；耗蓝 45 偏高，长局里连按会见底；熊/猎豹形态下不可用，切形态就等于放弃它。',
    // W23：飞到才结算（6.6）
    effects: [
      {
        kind: 'lockedProjectile',
        speed: SPELL_PROJECTILE.SPEED,
        onHit: [{ kind: 'damage', school: School.Arcane, amount: { flat: 175 } }],
      },
    ],
    description: '牵引星辰之力瞬间轰击目标，造成奥术伤害。自然系被打断封锁时，这是唯一还能按出去的伤害技能。',
  },
  {
    id: asSkillId('druid.thorns'),
    name: '荆棘术',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Ally,
    range: { min: 0, max: RANGE.MEDIUM },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Nature,
    cooldown: 25,
    triggersGcd: true,
    requiresLos: true,
    cost: { resource: Resource.Mana, amount: 40 },
    counters:
      '**减伤只有 8%**，撑不过一轮爆发，它是消耗战里的省蓝手段而不是保命键；魔法增益，驱散魔法一下就剥掉；25 秒冷却下几乎可以常驻，因此对手往往优先驱散别的东西。',
    /**
     * ⚠️ 9.x 的荆棘术是「被击中时反伤攻击者」，但**规则引擎没有反伤机制**
     *   （`AuraDef` 只有 modifiers / periodic / absorb，没有 onDamaged 回调）。
     *
     *   两条路：为它新加一套反伤管线，或者换一个引擎已支持的表达。
     *   这里选后者 —— 做成小幅减伤增益，**并且技能描述与光环描述都
     *   照实写「承伤降低」**。绝不能让数据描述写着反伤、实际什么都不做：
     *   那就是本仓库反复吃过的亏（规格写了，没人实现，UI 却照着念）。
     *   真要反伤，等引擎补 onDamaged 钩子时再回来改这一条。
     */
    effects: [
      {
        kind: 'applyAura',
        aura: {
          id: 'druid.thorns.buff',
          name: '荆棘',
          description: '树皮护体，受到的伤害降低 8%。',
          kind: 'buff',
          duration: 20,
          dispelType: DispelType.Magic,
          modifiers: { damageTaken: 0.92 },
        },
      },
    ],
    description: '为目标覆上尖刺护甲，20 秒内受到的伤害降低 8%。可被驱散魔法剥掉。',
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
