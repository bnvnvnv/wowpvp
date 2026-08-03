/**
 * 战士 —— 设计文档 9.1
 * 定位：近战压制、冲锋开团、旗手护卫。生命 1150，资源怒气。
 *
 * 本文件是**所有职业数据文件的范本**。新增职业请复制这个结构，
 * 保持「一个技能一个对象、附录A#3 九项全填、counters 写人话」的写法。
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
    vfx: 'warrior_charge',
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
          vfx: 'mortal_wounds',
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
          vfx: 'hamstring',
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
    effects: [
      { kind: 'damage', school: School.Physical, amount: { weaponPercent: 0.4 } },
      { kind: 'stun', duration: 2 },
    ],
    description: '投出战锤造成少量伤害并昏迷 2 秒。释放后目标移动不会自然躲开。',
    vfx: 'warrior_storm_bolt',
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
    description: '打断法术、引导或射击准备，并锁定该魔法学派 3 秒。',
    vfx: 'warrior_pummel',
  },
  {
    id: asSkillId('warrior.intervene'),
    name: '挡援',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Ally,
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
    vfx: 'warrior_intervene',
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
          vfx: 'warrior_defensive_stance',
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
          vfx: 'warrior_bladestorm',
        },
      },
    ],
    description: '在原地掀起持续 4 秒的旋刃风暴，期间免疫减速和定身。区域不随移动。',
    vfx: 'warrior_bladestorm',
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
    modifiers: { damageTaken: 1.1 },
    advantage: '单击和横扫伤害最高',
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
