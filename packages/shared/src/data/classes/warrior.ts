/**
 * 战士 —— 设计文档 9.1
 * 定位：近战压制、冲锋开团、旗手护卫。生命 1150，资源怒气。
 *
 * 本文件是**所有职业数据文件的范本**。新增职业请复制这个结构，
 * 保持「一个技能一个对象、附录A#3 九项全填、counters 写人话」的写法。
 */

import { RANGE, SPELL_PROJECTILE } from '../../constants/combat.js';
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

const CLASS_ID = asClassId('warrior');

// ── 技能 ─────────────────────────────────────────────────────────

const skills: SkillDef[] = [
  {
    id: asSkillId('warrior.charge'),
    name: '突进',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 8, max: 20 },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Physical,
    cooldown: 14,
    triggersGcd: true,
    requiresLos: true,
    counters: '需要 8 米以上距离才能起手；墙体、高差或非法落点会让冲锋提前终止（13.5）；昏迷仅 0.75 秒，被解控或抗控护甲可大幅削弱。',
    effects: [
      { kind: 'chargeTo', minRange: 8, maxRange: 20, stopDistance: RANGE.MELEE },
      { kind: 'stun', duration: 0.75 },
      { kind: 'gainResource', resource: Resource.Rage, amount: 15 },
    ],
    description: '沿合法路线冲向目标并昏迷 0.75 秒。',
  },
  {
    id: asSkillId('warrior.mortal_strike'),
    name: '重创斩',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: 3.3 },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Physical,
    cooldown: 6,
    triggersGcd: true,
    requiresFacing: true,
    requiresLos: true,
    cost: { resource: Resource.Rage, amount: 20 },
    counters: '要求贴身并面向目标；缴械后无法使用；降低治疗的减益属于魔法以外的物理效果，不可被驱散魔法移除。',
    effects: [
      // M14b：1.6→1.5 —— 断筋减速生效后战士贴脸时间大增（基线 61.9%），主输出件回调
      { kind: 'damage', school: School.Physical, amount: { weaponPercent: 1.5 } },
      {
        kind: 'applyAura',
        aura: {
          id: 'warrior.mortal_wounds',
          name: '致死创伤',
          kind: 'debuff',
          duration: 5,
          dispelType: DispelType.None,
          clearableByTrinket: false,
          modifiers: { healingTaken: 0.75 },
          description: '受到的治疗降低 25%。',
        },
      },
    ],
    description: '造成 150% 武器伤害，并使目标受到的治疗降低 25%，持续 5 秒。',
  },
  {
    id: asSkillId('warrior.hamstring'),
    name: '断腿斩',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: 3 },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Physical,
    cooldown: 8,
    triggersGcd: true,
    requiresFacing: true,
    requiresLos: true,
    cost: { resource: Resource.Rage, amount: 10 },
    counters: '普通减速不能被「战斗意志」解除（8.3），但自由祝福、消失、逃脱、死亡脚步可以摆脱；受减速叠加规则限制，不与其他减速叠乘。',
    effects: [
      {
        kind: 'applyAura',
        aura: {
          id: 'warrior.hamstring',
          name: '断腿斩',
          kind: 'debuff',
          duration: 6,
          dispelType: DispelType.Movement,
          clearableByTrinket: false,
          modifiers: { moveSpeed: 0.6 },
          description: '移动速度降低 40%。',
        },
      },
    ],
    description: '使目标移动速度降低 40%，持续 6 秒。',
  },
  {
    id: asSkillId('warrior.storm_bolt'),
    name: '掷锤',
    classId: CLASS_ID,
    // 6.6 锁定投射物：释放瞬间确认命中资格，飞行只是表现，目标之后移动不会自然落空
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: 20 },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Physical,
    cooldown: 25,
    triggersGcd: true,
    requiresLos: true,
    cost: { resource: Resource.Rage, amount: 15 },
    counters: '受昏迷递减；免疫、吸收、反射仍然生效（6.6）；释放瞬间失去视线或超距会直接失败。',
    /**
     * W25：锤要飞到才晕（6.6）。20 米 / 55 m·s⁻¹ ≈ 0.36 秒。
     *
     * ★ 速度取法术档的 55 而不是箭矢的 75：**掷出去的钝器不该比箭快**。
     *   风暴之锤本来就是 `projectile.ts` 文件头举的锁定投射物范例 ——
     *   W25 之前那句范例是**空头支票**（举着它，代码里却是瞬间落账）。
     * ★★ 昏迷进 `onHit` 之后递减链一个字不动：`applyControl` 在弹体抵达时
     *   由同一条 `resolve()` 调用，DR 类别、`clearableByTrinket`、
     *   从 skillId 反查学派全部照走。变的只是**递减计数从哪一刻开始**
     *   —— 现在是命中那一刻，比按下键晚 0.36 秒。
     */
    effects: [
      {
        kind: 'lockedProjectile',
        speed: SPELL_PROJECTILE.SPEED,
        onHit: [
          { kind: 'damage', school: School.Physical, amount: { weaponPercent: 0.4 } },
          { kind: 'stun', duration: 2 },
        ],
      },
    ],
    description: '投出战锤造成少量伤害并昏迷 2 秒。释放后目标移动不会自然躲开。',
  },
  {
    id: asSkillId('warrior.pummel'),
    name: '猛击',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: 3 },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Physical,
    cooldown: 15,
    // 7.2 专用打断不触发公共冷却，便于在进攻技能之间穿插
    triggersGcd: false,
    requiresFacing: true,
    requiresLos: true,
    counters: '目标未在施法、或施法带盾牌标记（不可打断）时仍会进入冷却（7.2）；缴械状态下无法使用；假读条可以骗掉。',
    effects: [{ kind: 'interrupt', schoolLockSeconds: 3 }],
    description: '打断法术、引导或射击准备，并封锁该系魔法技能 3 秒。',
  },
  {
    id: asSkillId('warrior.intervene'),
    name: '挡援',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Ally,
    // 5.6：治疗/驱散/保护支持鼠标指向施法（W19）
    allowMouseover: true,
    range: { min: 0, max: 20 },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Physical,
    cooldown: 20,
    triggersGcd: true,
    requiresLos: true,
    counters: '只替下一次直接攻击承伤，持续伤害与范围技能不受影响；冲向友方的路径同样受墙体限制。',
    effects: [
      { kind: 'chargeToAlly', stopDistance: 2 },
      { kind: 'interveneGuard', duration: 3 },
    ],
    description: '冲向友方，并在 3 秒内替其承受下一次直接攻击。',
  },
  {
    id: asSkillId('warrior.defensive_stance'),
    name: '防御架势',
    classId: CLASS_ID,
    targeting: Targeting.Self,
    targetFilter: TargetFilter.Self,
    range: { min: 0, max: 0 },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Physical,
    cooldown: 30,
    triggersGcd: true,
    counters: '自身伤害同时降低 15%，是明确的攻防取舍；不是免疫，控制链仍然有效。',
    effects: [
      {
        kind: 'applyAura',
        target: 'self',
        aura: {
          id: 'warrior.defensive_stance',
          name: '防御架势',
          kind: 'buff',
          duration: 5,
          dispelType: DispelType.None,
          modifiers: { damageTaken: 0.7, damageDealt: 0.85 },
          description: '受到伤害降低 30%，自身伤害降低 15%。',
        },
      },
    ],
    description: '5 秒内受到伤害降低 30%，自身伤害降低 15%。',
  },
  {
    id: asSkillId('warrior.bladestorm'),
    name: '旋刃斩',
    classId: CLASS_ID,
    targeting: Targeting.SelfCenter,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: 5 },
    shape: { kind: 'circle', radius: 5 },
    /**
     * M14：由引导改为**瞬发落区**（凛冬领域同款）。此前是 Channel，
     * 而引导在本实现里只在**结束时**结算一次 —— 4.4 秒后才开始转的
     * 旋风；改瞬发后起手即生效，反制方式照实改写在 counters 里。
     */
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Physical,
    cooldown: 60,
    triggersGcd: true,
    cost: { resource: Resource.Rage, amount: 30 },
    counters: '区域固定在起手位置，走出 5 米即可完全躲开（6.4）；战士自身的免疫减速定身不代表免疫控制，昏迷他并不能收掉已经转起来的区域。',
    /**
     * ★★ M14 重构：伤害从**自体光环的 periodic** 挪进 **spawnGroundArea**
     *   （凛冬领域同款）。光环周期效果的结算目标是**光环持有者** ——
     *   那是 DoT（月火挂在敌人身上）的正确语义，但旋刃的光环挂在自己
     *   身上，于是 8 跳 × 45 点全打在战士自己头上：**这是个自残键**，
     *   写下以来没有任何测试或验收调用过它（「规则写了没人调」第 N 次）。
     *   配平 bot 学会把 DoT 当输出的那一轮把它按在了牌面上：战士胜率
     *   应声掉到 4.8%、场均反而变快 —— 快在自杀。
     * ⚠️ 代价（登记 docs/10 偏差 #10）：区域固定在起手位置，不随移动 ——
     *   schema 尚无「跟随实体的区域」，凛冬领域同此限制。
     */
    effects: [
      {
        kind: 'spawnGroundArea',
        areaId: 'warrior.bladestorm',
        radius: 5,
        duration: 4,
        tickInterval: 0.5,
        onTick: [{ kind: 'damage', school: School.Physical, amount: { weaponPercent: 0.45 } }],
      },
      {
        kind: 'applyAura',
        target: 'self',
        aura: {
          id: 'warrior.bladestorm',
          name: '旋刃斩',
          kind: 'buff',
          duration: 4,
          dispelType: DispelType.None,
          flags: { immuneSlowAndRoot: true },
          description: '持续旋转攻击周围敌人，免疫减速和定身。',
        },
      },
    ],
    description: '在原地掀起持续 4 秒的旋刃风暴，期间免疫减速和定身。区域不随移动。',
  },
  // 武器方案授予的技能
  {
    id: asSkillId('warrior.shield_slam'),
    name: '盾撞',
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
    cost: { resource: Resource.Rage, amount: 15 },
    counters: '仅剑盾方案可用；缴械后禁用。',
    effects: [{ kind: 'damage', school: School.Physical, amount: { weaponPercent: 1.1 } }],
    description: '用盾牌猛击目标，造成 110% 武器伤害。仅剑盾方案可用。',
  },
  {
    id: asSkillId('warrior.cleave'),
    name: '横扫斩',
    classId: CLASS_ID,
    targeting: Targeting.Cone,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: RANGE.MELEE_EXTENDED },
    shape: { kind: 'cone', angleDeg: 90, range: RANGE.MELEE_EXTENDED },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Physical,
    cooldown: 6,
    triggersGcd: true,
    requiresLos: true,
    cost: { resource: Resource.Rage, amount: 20 },
    counters: '仅双手巨剑方案可用；背后的目标不受影响（5.4 锥形技能）。',
    effects: [{ kind: 'damage', school: School.Physical, amount: { weaponPercent: 0.95 } }],
    description: '横扫身前扇形范围内的敌人。仅双手巨剑方案可用。',
  },
  {
    id: asSkillId('warrior.combo_storm'),
    name: '连击风暴',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: RANGE.MELEE },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Physical,
    cooldown: 10,
    triggersGcd: true,
    requiresFacing: true,
    requiresLos: true,
    cost: { resource: Resource.Rage, amount: 25 },
    counters: '仅双持方案可用；多段伤害容易被减伤和护盾吃掉。',
    effects: [{ kind: 'damage', school: School.Physical, amount: { weaponPercent: 0.5 } }],
    description: '快速连续挥击目标。仅双持单手剑方案可用。',
  },

  /**
   * ★ P3b 扩充：战士补「怒气填充 / 反手抗爆 / 群体恐惧」。
   *
   *   审计里战士的问题不是伤害不够，而是**开场没怒气时无事可做**、
   *   且缺一个能中断对方集火节奏的键。补的三条全部瞬发；
   *   英勇打击刻意做成**低伤害的怒气消耗口**而不是新的爆发点。
   */
  {
    id: asSkillId('warrior.heroic_strike'),
    name: '英勇打击',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: RANGE.MELEE },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Physical,
    cooldown: 0,
    triggersGcd: true,
    requiresFacing: true,
    requiresLos: true,
    cost: { resource: Resource.Rage, amount: 15 },
    counters:
      '**没有冷却但每次要 15 怒**：它是怒气溢出时的倾泻口，不是输出核心 —— 拿它当主手会让致死打击和风暴之锤按不出来；伤害低于所有带冷却的技能，被减伤吃掉后几乎无感；缴械期间不可用，且要贴脸面向。',
    effects: [{ kind: 'damage', school: School.Physical, amount: { weaponPercent: 0.85 } }],
    description: '一次沉重的挥砍，造成 85% 武器伤害。无冷却，用来倾泻溢出的怒气。',
  },
  {
    id: asSkillId('warrior.spell_reflection'),
    name: '法术反射',
    classId: CLASS_ID,
    targeting: Targeting.Self,
    targetFilter: TargetFilter.Self,
    range: { min: 0, max: 0 },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Physical,
    cooldown: 25,
    triggersGcd: true,
    cost: { resource: Resource.Rage, amount: 15 },
    counters:
      '**只减法术伤害，对物理毫无作用** —— 对手是近战时等于白按；只有 5 秒，对方看到就停手等它过期；25 秒冷却意味着一局里最多押中两三次爆发。',
    effects: [
      {
        kind: 'applyAura',
        target: 'self',
        aura: {
          id: 'warrior.spell_reflection',
          name: '法术反射',
          description: '受到的伤害降低 40%。',
          kind: 'buff',
          duration: 5,
          dispelType: DispelType.Magic,
          modifiers: { damageTaken: 0.6 },
        },
      },
    ],
    description: '举盾格挡法术，5 秒内受到伤害降低 40%。押对方读条的窗口。',
  },
  {
    id: asSkillId('warrior.intimidating_shout'),
    name: '破胆怒吼',
    classId: CLASS_ID,
    targeting: Targeting.SelfCenter,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: 8 },
    shape: { kind: 'circle', radius: 8, maxTargets: 5 },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Physical,
    cooldown: 90,
    triggersGcd: true,
    cost: { resource: Resource.Rage, amount: 20 },
    counters:
      '走「恐惧」递减链（8.2），与心灵尖啸、恐惧共用一条 —— 队伍里有牧师时第二次就只剩一半；**受到任意伤害立即解除**，自己的持续伤害会把它拆掉；把对手打散也意味着自己够不到人；90 秒冷却。',
    effects: [{ kind: 'fear', duration: 4, breakDamage: 1 }],
    description: '怒吼震慑周围最多 5 名敌人，恐惧 4 秒，受到伤害立即解除。用来打断对方的集火。',
  },

  /**
   * ★★ P11 保命轮：战士补**盾墙** —— 对齐 WoW 口径的那一格此前是**空的**。
   *
   *   审计判据是「按下后能扛住 3 秒集火」。战士此前手上最硬的两个键是
   *   防御架势（30% / 5 秒 / CD 30，且自伤 -15%）与法术反射（40% / 5 秒 /
   *   CD 25）—— 两个都是**节奏键**：30 秒一次的东西不可能给到「一局一次
   *   的救命」那种量级，真被三人集火时 30% 减伤只是把 2 秒变成 2.9 秒。
   *   玩家反馈「一旦被集火很容易就挂了」在战士身上就是这个窟窿：
   *   1150 血的板甲近战，**没有任何一个能扛住开手的按钮**。
   *
   * ★ 量级依据（WoW 盾墙：40% / 8 秒 / CD 180，天赋可到 120）：
   *   本仓库的时间尺度比正式服快一个数量级（场均 12~23 秒），180 秒在
   *   竞技场单回合上限（90 秒）之外等于「整局没有这个技能」——
   *   按疾跑那次拍板的同一条口径（CD 对齐回合长度而不是照抄秒数）取 **120**：
   *   竞技场一回合最多一次，夺旗全场约六次。
   *   减伤取 **50%** 而不是 40%：正式服的战士还有嗜血/破釜沉舟/二次风等
   *   一整条自愈线兜底，本仓库的战士一条都没有，减伤是他**唯一**的生存轴。
   *
   * ★ 刻意**不收怒气**：保命键被资源卡住就是它最常见的死法 —— 开场被秒
   *   的时候战士怒气恰好是 0（怒气靠挨打与输出积累），收 20 怒等于这个键
   *   在最需要它的那一秒按不出来。同理由见盗贼疾跑的「刻意不收能量」。
   *
   * ★ 与防御架势的分工：架势是 30 秒一转的**常规减伤**（带 -15% 自伤的
   *   攻防取舍），盾墙是 120 秒一次的**一局一次**。两者 damageTaken 相乘，
   *   叠起来 0.7 × 0.5 = 0.35（65% 减伤 5 秒）—— 这是刻意允许的：
   *   代价是两个键的冷却一起交掉，且期间战士的输出被架势砍 15%。
   */
  {
    id: asSkillId('warrior.shield_wall'),
    name: '盾墙',
    classId: CLASS_ID,
    targeting: Targeting.Self,
    targetFilter: TargetFilter.Self,
    range: { min: 0, max: 0 },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Physical,
    cooldown: 120,
    triggersGcd: true,
    // 8.3：被昏迷按在地上却开不了减伤，是「保命键不保命」的典型 —— 与硬化树皮同款豁免
    usableWhileStunned: true,
    counters:
      '**只减伤，不解控也不免疫** —— 昏迷、恐惧、变形、沉默照常命中，控制链把你按住 5 秒同样能打死你；只有 8 秒，对手看到举盾就停手拉开、等它过期再开手是标准解法；**120 秒冷却比竞技场单回合上限（90 秒）还长**，一回合只有一次，交掉之后本回合再无第二个硬减伤；不可驱散是双刃 —— 敌人剥不掉，但你也不能靠它洗掉身上已有的减益；减伤对持续伤害同样只是打折，DoT 叠满时它救不回来。',
    effects: [
      {
        kind: 'applyAura',
        target: 'self',
        aura: {
          id: 'warrior.shield_wall',
          name: '盾墙',
          kind: 'buff',
          duration: 8,
          // 举盾是体术不是魔法，敌人驱不掉（与盗贼疾跑、割裂同一条理由）
          dispelType: DispelType.None,
          clearableByTrinket: false,
          modifiers: { damageTaken: 0.5 },
          description: '受到的伤害降低 50%。',
        },
      },
    ],
    description: '举盾硬扛，8 秒内受到的伤害降低 50%。可在昏迷中使用，一回合只有一次。',
  },
];

// ── 武器方案（附录A#4：职业、攻击间隔、距离、优势、代价、改变的技能）──

const weapons: WeaponDef[] = [
  {
    id: asWeaponId('warrior.sword_shield'),
    name: '单手剑 + 盾牌',
    classId: CLASS_ID,
    isDefault: true,
    handedness: 'oneHand',
    swingInterval: 1.7,
    // M14：0.85→0.9 —— 怒气经济修复（gainResource 归施法者）后战士以白字养技能，盾剑档白字 53/s
    swingPercent: 0.9,
    reach: RANGE.MELEE,
    modifiers: { block: 0.2, damageTaken: 0.87 },
    advantage: '正面格挡 20%，防御 +15%',
    cost: '爆发低',
    grantsSkills: [asSkillId('warrior.shield_slam')],
    removesSkills: [asSkillId('warrior.cleave'), asSkillId('warrior.combo_storm')],
    model: 'sword_shield',
  },
  {
    id: asWeaponId('warrior.greatsword'),
    name: '双手巨剑',
    classId: CLASS_ID,
    isDefault: false,
    handedness: 'twoHand',
    swingInterval: 2.4,
    swingPercent: 1.55,
    reach: RANGE.MELEE_EXTENDED,
    // P7 暴击轴：慢刀「一击的重量」再放大 —— 暴击倍率 ×1.15（1.5→1.725）
    modifiers: { damageTaken: 1.1, critDamage: 1.15 },
    advantage: '单击和横扫伤害最高，暴击更重（倍率 ×1.15）',
    cost: '防御 -10%，攻速慢',
    grantsSkills: [asSkillId('warrior.cleave')],
    removesSkills: [asSkillId('warrior.shield_slam'), asSkillId('warrior.combo_storm')],
    model: 'greatsword',
  },
  {
    id: asWeaponId('warrior.dual_swords'),
    name: '双持单手剑',
    classId: CLASS_ID,
    isDefault: false,
    handedness: 'dualWield',
    swingInterval: 0.75,
    // M14：0.58→0.42 —— 平方 bug 修复曾让双持白字膨胀到 77/s，压回「白字最高（56/s）但防御-8%」的取舍位
    swingPercent: 0.42,
    reach: RANGE.MELEE,
    modifiers: { damageTaken: 1.08, resourceGain: 1.2 },
    advantage: '攻速快，怒气获取 +20%',
    cost: '单击低，防御 -8%',
    grantsSkills: [asSkillId('warrior.combo_storm')],
    removesSkills: [asSkillId('warrior.shield_slam'), asSkillId('warrior.cleave')],
    skillModifiers: { 'warrior.mortal_strike': { damageMultiplier: 0.85 } },
    model: 'dual_swords',
  },
];

export const warrior: ClassDef = {
  id: CLASS_ID,
  name: '战士',
  role: '近战压制、冲锋开团、旗手护卫',
  baseHealth: 1150,
  resources: [{ resource: Resource.Rage, max: 100, start: 0, regenPerSecond: 0 }],
  strengths: '追击、致伤、保护、正面承伤',
  weaknesses: '远程消耗、被风筝、缺少远程持续输出',
  defaultWeaponId: asWeaponId('warrior.sword_shield'),
  defaultArmorId: asArmorId('warrior.default'),
  skills,
  weapons,
  armors: makeArmorSet(CLASS_ID, { defaultName: '板甲' }),
  autoAttack: { ranged: false, school: School.Physical },
};
