/**
 * 猎人 —— 设计文档 9.5
 * 定位：远程输出、陷阱、反潜行与风筝。生命 1000，资源集中值。
 *
 * 结构完全对齐范本 packages/shared/src/data/classes/warrior.ts。
 *
 * 本职业是 CastKind.AimedShot（物理准备条，7.1 / 7.6）的核心承载者：
 * 「瞄准射击」和重弩的「穿透重弩箭」都带可见准备条，可被专用打断、缴械、
 * 硬控制、强制位移和主动移动终止，但**沉默对它们无效**（8.2 / 验收 #17）；
 * 被打断时只取消本次射击，不产生魔法学派锁定（7.2 / 验收 #16）。
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

const CLASS_ID = asClassId('hunter');

/** 短弓默认射程。自动射击的实际距离由当前武器 reach 决定（短弓 28 / 长弓 35 / 重弩 32）*/
const SHORT_BOW_RANGE = 28;
/** 重弩射程 */
const CROSSBOW_RANGE = 32;

// ── 技能 ─────────────────────────────────────────────────────────

/**
 * ★★ M14：「自动射击」**不再是一个按钮技能**。
 *
 *   规格书 9.5 那一行写的是「移动中自动进行｜武器间隔」—— 它是 7.6 普通
 *   攻击在猎人身上的样子，由 `sim/autoAttack.ts` 的挥击系统承载（远程武器
 *   走射击规则），与其他七个职业的普攻同一条路径、同一个节奏来源。
 *
 *   在 M14 之前它被实现成一个**可施放的技能**：0 冷却、0 消耗、不触发
 *   公共冷却、每按一次结算 100% 武器伤害 —— 也就是一个 20 次/秒的连点宏
 *   能打出 1500 DPS 的按钮（配平基线抓到：猎人 95.2% 胜率、场均 2.7 秒，
 *   全部来自 bot 每 tick 按一次这个键）。按钮删除，机制归挥击系统。
 */
const skills: SkillDef[] = [
  {
    id: asSkillId('hunter.aimed_shot'),
    name: '瞄准射击',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: RANGE.LONG },
    shape: { kind: 'single' },
    // 7.1 瞄准射击/装填：物理准备条，必须原地，可被专用打断
    cast: { kind: CastKind.AimedShot, time: 1.6, movable: false, interruptible: true },
    school: School.Physical,
    cooldown: 8,
    triggersGcd: true,
    requiresFacing: true,
    requiresLos: true,
    cost: { resource: Resource.Focus, amount: 35 },
    counters:
      '1.6 秒物理准备条全程可见：可被专用打断、缴械、硬控制、移动和强制位移终止（7.1 / 7.3）；**沉默无效**，沉默只禁止魔法技能（7.3 / 验收 #17）；被打断只取消本次射击，不产生魔法学派锁定，猎人可以立刻改用其他技能（7.2 / 验收 #16）；完成瞬间会重新检查距离与视线，拉开 35 米或断视线即失败。',
    // M14：2.6→3.0 —— 1.6s 站桩准备 + 可被打断的风险溢价
    effects: [{ kind: 'damage', school: School.Physical, amount: { weaponPercent: 3 } }],
    description: '经过 1.6 秒瞄准后射出一发重箭，造成 300% 武器伤害。准备期间不能移动。',
    vfx: 'hunter_aimed_shot',
  },
  {
    id: asSkillId('hunter.arcane_shot'),
    name: '秘法箭',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: RANGE.RANGED },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Arcane,
    cooldown: 4,
    triggersGcd: true,
    requiresFacing: true,
    requiresLos: true,
    cost: { resource: Resource.Focus, amount: 25 },
    counters:
      '瞬发，不能被专用打断；但属于奥术学派，沉默、奥术学派锁定和法术免疫都能挡住（7.3 / 8.2）；仍受视线、距离和公共冷却限制。',
    // M14：1.1→1.3 —— 焦点主要出口，机动填充
    effects: [{ kind: 'damage', school: School.Arcane, amount: { weaponPercent: 1.3 } }],
    description: '射出一发附魔箭，造成 130% 武器伤害的奥术伤害。可移动使用。',
    vfx: 'hunter_arcane_shot',
  },
  {
    id: asSkillId('hunter.concussive_shot'),
    name: '震慑箭',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: RANGE.RANGED },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Physical,
    cooldown: 10,
    triggersGcd: true,
    requiresFacing: true,
    requiresLos: true,
    cost: { resource: Resource.Focus, amount: 15 },
    counters:
      '普通减速不能被「战斗意志」解除（8.3），但自由祝福、消失、逃脱、死亡脚步和驱散移动限制都能摆脱；减速不叠乘，只取最强的一个；不参与控制递减，所以也不会因为递减而变短。',
    effects: [
      {
        kind: 'applyAura',
        aura: {
          id: 'hunter.concussive_shot',
          name: '震慑箭',
          kind: 'debuff',
          duration: 5,
          dispelType: DispelType.Movement,
          clearableByTrinket: false,
          modifiers: { moveSpeed: 0.6 },
          description: '移动速度降低 40%。',
          vfx: 'hunter_concussive_shot',
        },
      },
    ],
    description: '使目标移动速度降低 40%，持续 5 秒。',
    vfx: 'hunter_concussive_shot',
  },
  {
    id: asSkillId('hunter.freezing_trap'),
    name: '寒霜陷阱',
    classId: CLASS_ID,
    targeting: Targeting.Ground,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: 20 },
    shape: { kind: 'circle', radius: 1.5 },
    // 0.4 秒投掷动作。带盾牌标记（7.5）：不可被专用打断，但硬控制与死亡仍会终止
    cast: { kind: CastKind.Cast, time: 0.4, movable: false, interruptible: false },
    school: School.Frost,
    cooldown: 20,
    triggersGcd: true,
    requiresLos: true,
    cost: { resource: Resource.Focus, amount: 20 },
    counters:
      '落点与 0.8 秒布置进度全程可见，可以绕开或提前引爆；布置完成前踩上去不会触发；迷惑受「迷惑」递减链影响（8.2），受到任意一次有效伤害立即解除，队友的持续伤害和范围技能是最常见的破坏方式；免疫、抗控护甲与「战斗意志」都能化解；地面非法位置（斜坡、悬空）会直接释放失败（6.4）。',
    effects: [
      {
        kind: 'spawnTrap',
        armTime: 0.8,
        triggerRadius: 1.5,
        duration: 60,
        onTrigger: [
          // breakDamage 1 = 任何一次有效伤害都会解除（9.5：受到伤害后解除）
          { kind: 'incapacitate', duration: 3, breakDamage: 1 },
        ],
      },
    ],
    description: '在指定地面布置陷阱，0.8 秒后生效。首个进入 1.5 米范围的敌人被迷惑 3 秒，受到伤害后解除。',
    vfx: 'hunter_freezing_trap',
  },
  {
    id: asSkillId('hunter.flare'),
    name: '照明弹',
    classId: CLASS_ID,
    targeting: Targeting.Ground,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: RANGE.RANGED },
    shape: { kind: 'circle', radius: 6 },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Fire,
    cooldown: 20,
    triggersGcd: true,
    requiresLos: true,
    cost: { resource: Resource.Focus, amount: 10 },
    counters:
      '区域和持续时间全程可见，潜行单位绕开 6 米范围即可；不造成伤害也不阻止移动，被揭露者可以直接穿过去；20 秒冷却使猎人无法长期覆盖多个通道。',
    effects: [
      {
        kind: 'spawnGroundArea',
        areaId: 'hunter.flare',
        radius: 6,
        duration: 8,
        tickInterval: 1,
        onTick: [],
        revealsStealth: true,
      },
    ],
    description: '在指定地面点燃照明弹，8 秒内持续揭露半径 6 米内的潜行与隐身单位。',
    vfx: 'hunter_flare',
  },
  {
    id: asSkillId('hunter.disengage'),
    name: '后撤跃',
    classId: CLASS_ID,
    targeting: Targeting.Self,
    targetFilter: TargetFilter.Self,
    range: { min: 0, max: 0 },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Physical,
    cooldown: 15,
    triggersGcd: true,
    counters:
      '开始后方向固定，不能中途转向，对手可以预判落点接控制；只解除普通减速，**不解除定身与昏迷**，被定身时无法起跳；墙体、高差和非法落点会让跃出提前终止（13.5）。',
    effects: [{ kind: 'leapBackward', distance: 6, clearsSlow: true }],
    description: '向角色背后跃出 6 米，并解除普通减速。开始后方向固定。',
    vfx: 'hunter_disengage',
  },
  {
    id: asSkillId('hunter.counter_shot'),
    name: '断法箭',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: RANGE.RANGED },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Physical,
    cooldown: 18,
    // 7.2 专用打断不触发公共冷却，便于在射击之间穿插
    triggersGcd: false,
    requiresFacing: true,
    requiresLos: true,
    counters:
      '打断法术或引导时锁定该魔法学派 3 秒；打断物理射击准备条（瞄准射击、装填）时只取消本次动作，**不锁武器、不产生学派锁定**（7.2 / 验收 #16）；目标未在施法、或施法带盾牌标记（不可打断）时仍然进入冷却；假读条可以骗掉（7.5）；本身是物理技能，不受沉默限制但会被缴械禁用。',
    effects: [{ kind: 'interrupt', schoolLockSeconds: 3 }],
    description: '射出一箭打断法术、引导或射击准备。打断魔法时锁定该学派 3 秒。',
    vfx: 'hunter_counter_shot',
  },
  {
    id: asSkillId('hunter.exhilaration'),
    name: '振作',
    classId: CLASS_ID,
    targeting: Targeting.Self,
    targetFilter: TargetFilter.Self,
    range: { min: 0, max: 0 },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Nature,
    cooldown: 60,
    triggersGcd: true,
    counters:
      '受竞技场战斗抑制影响（8.5），后期实际回复量会随抑制层数持续下降；属于自然学派的治疗，被自然学派锁定或降低治疗的减益（致死打击等）大幅削弱；瞬发但仍会被昏迷、变形和沉默期间的施法限制卡住，60 秒冷却让它无法应对连续爆发。',
    effects: [{ kind: 'healPercentMaxHealth', percent: 0.25 }],
    description: '立即恢复 25% 最大生命。受竞技场战斗抑制影响。',
    vfx: 'hunter_exhilaration',
  },
  {
    id: asSkillId('hunter.aspect_of_the_turtle'),
    name: '龟甲护体',
    classId: CLASS_ID,
    targeting: Targeting.Self,
    targetFilter: TargetFilter.Self,
    range: { min: 0, max: 0 },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Nature,
    cooldown: 60,
    triggersGcd: true,
    counters:
      '期间完全不能攻击或射击，是纯粹的攻防取舍，对手可以直接脱战或去打猎人的队友；只偏转**正面**投射物，绕到背后或侧面的射击照常命中；不是免疫，持续伤害、范围技能和全部控制链依然生效；4 秒结束后猎人需要重新起手瞄准射击。',
    effects: [
      {
        kind: 'applyAura',
        target: 'self',
        aura: {
          id: 'hunter.aspect_of_the_turtle',
          name: '龟甲护体',
          kind: 'buff',
          duration: 4,
          dispelType: DispelType.None,
          modifiers: { damageTaken: 0.65 },
          flags: { cannotAttack: true, deflectFrontProjectiles: true },
          description: '受到伤害降低 35%，偏转正面投射物，期间不能攻击或射击。',
          vfx: 'hunter_aspect_of_the_turtle',
        },
      },
    ],
    description: '4 秒内受到伤害降低 35% 并偏转正面投射物，期间不能攻击或射击。',
    vfx: 'hunter_aspect_of_the_turtle',
  },
  // 武器方案授予的技能
  {
    id: asSkillId('hunter.piercing_bolt'),
    name: '穿透重弩箭',
    classId: CLASS_ID,
    // 6.6 碰撞型投射物：按真实轨迹飞行，可被地形和身位阻挡，穿透沿途全部敌人
    targeting: Targeting.Projectile,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: CROSSBOW_RANGE },
    shape: { kind: 'line', length: CROSSBOW_RANGE, width: 1.2 },
    // 7.1 装填条与瞄准射击同类：物理准备条，原地，可被专用打断，沉默无效
    cast: { kind: CastKind.AimedShot, time: 1, movable: false, interruptible: true },
    school: School.Physical,
    cooldown: 12,
    triggersGcd: true,
    requiresFacing: true,
    requiresLos: true,
    cost: { resource: Resource.Focus, amount: 30 },
    counters:
      '仅重弩方案可用；1 秒装填条可被专用打断、缴械、硬控制、移动和强制位移终止，**沉默无效**，被打断只取消本次射击、不产生魔法学派锁定（7.2 / 7.6 / 验收 #16、#17）；投射物按真实轨迹飞行，可以被墙体、柱子和队友身位挡下，也可以靠横向走位躲开（6.6）。',
    effects: [
      {
        kind: 'spawnProjectile',
        speed: 45,
        radius: 0.6,
        pierce: true,
        onHit: [{ kind: 'damage', school: School.Physical, amount: { weaponPercent: 1.3 } }],
      },
    ],
    description: '装填 1 秒后射出一发穿透弩箭，贯穿路径上的所有敌人，各造成 130% 武器伤害。仅重弩方案可用。',
    vfx: 'hunter_piercing_bolt',
  },
];

// ── 武器方案（附录A#4：职业、攻击间隔、距离、优势、代价、改变的技能）──

const weapons: WeaponDef[] = [
  {
    id: asWeaponId('hunter.short_bow'),
    name: '短弓',
    classId: CLASS_ID,
    isDefault: true,
    handedness: 'ranged',
    swingInterval: 1.35,
    // M14：0.75→0.95 —— 删掉可连点的「自动射击」按钮后，弓白字承担远程持续压力（70/s）
    swingPercent: 0.95,
    reach: SHORT_BOW_RANGE,
    isRanged: true,
    advantage: '射速快，可全速移动射击',
    cost: '单发低，射程短',
    // 9.5：奥术射击冷却略短（4 秒 → 3 秒）
    skillModifiers: { 'hunter.arcane_shot': { cooldownMultiplier: 0.75 } },
    removesSkills: [asSkillId('hunter.piercing_bolt')],
    model: 'short_bow',
  },
  {
    id: asWeaponId('hunter.long_bow'),
    name: '长弓',
    classId: CLASS_ID,
    isDefault: false,
    handedness: 'ranged',
    swingInterval: 2.2,
    // M14：1.4→1.6 —— 优势写着「单发最高」，白字却低于短弓；抬到 73/s 兑现文案
    swingPercent: 1.6,
    reach: RANGE.LONG,
    isRanged: true,
    advantage: '射程和单发最高',
    cost: '攻速慢；重型射击需站定',
    // 9.5：瞄准射击伤害 +15%
    skillModifiers: { 'hunter.aimed_shot': { damageMultiplier: 1.15 } },
    removesSkills: [asSkillId('hunter.piercing_bolt')],
    model: 'long_bow',
  },
  {
    id: asWeaponId('hunter.heavy_crossbow'),
    name: '重弩',
    classId: CLASS_ID,
    isDefault: false,
    handedness: 'ranged',
    swingInterval: 2.6,
    swingPercent: 1.65,
    reach: CROSSBOW_RANGE,
    isRanged: true,
    advantage: '穿甲和冲击高',
    // 注：WeaponDef 目前没有「每发前装填时间」字段，普通射击的 1 秒装填由
    // sim 的自动攻击处理器读取本方案时套用；带准备条的形态见 hunter.piercing_bolt
    cost: '每发前有 1 秒装填；移动会中断',
    grantsSkills: [asSkillId('hunter.piercing_bolt')],
    model: 'heavy_crossbow',
  },
];

export const hunter: ClassDef = {
  id: CLASS_ID,
  name: '猎人',
  role: '远程输出、陷阱、反潜行与风筝',
  baseHealth: 1000,
  // M14：8→12 —— 回复兑现后按秘法箭 25 耗 3s 冷却（短弓）+ 瞄准 35 耗 8s 冷却的组合定值
  resources: [{ resource: Resource.Focus, max: 100, start: 100, regenPerSecond: 12 }],
  strengths: '远程持续压力、侦察、减速、地面陷阱',
  weaknesses: '被近战贴身、重型射击需要准备、宠物可被牵制',
  defaultWeaponId: asWeaponId('hunter.short_bow'),
  defaultArmorId: asArmorId('hunter.default'),
  skills,
  weapons,
  armors: makeArmorSet(CLASS_ID, { defaultName: '锁甲' }),
  autoAttack: { ranged: true, school: School.Physical },
};
