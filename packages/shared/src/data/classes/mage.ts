/**
 * 法师 —— 设计文档 9.6
 * 定位：远程控制、元素爆发、区域封锁。生命 900，资源法力。
 *
 * 结构完全对齐 warrior.ts（本仓库职业数据范本）：一个技能一个对象、
 * 附录A#3 九项全填、counters 写人话。
 *
 * 法师是全场唯一拥有 4 秒学派锁定的职业（7.2），也是唯一同时拥有
 * 「完全免疫 + 主动位移 + 地面封锁」的远程职业，所以生命和贴身抗压最低。
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

const CLASS_ID = asClassId('mage');

// ── 技能 ─────────────────────────────────────────────────────────

const skills: SkillDef[] = [
  {
    id: asSkillId('mage.frostbolt'),
    name: '霜矢',
    classId: CLASS_ID,
    // 6.6 锁定投射物：释放瞬间确认命中资格，飞行只是表现
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: RANGE.RANGED_LONG },
    shape: { kind: 'single' },
    // 9.6：1.4 秒冰霜读条，原地。法师的主消耗技能，没有冷却
    cast: { kind: CastKind.Cast, time: 1.4, movable: false, interruptible: true },
    school: School.Frost,
    cooldown: 0,
    triggersGcd: true,
    requiresLos: true,
    cost: { resource: Resource.Mana, amount: 30 },
    counters:
      '原地读条：任何主动移动都会自行终止（7.3）；可被专用打断并锁定冰霜学派 3 秒、被沉默、硬控制或击退终止；减速属于魔法效果，可被驱散魔法或自由祝福解除，且不与其他减速叠乘。',
    effects: [
      // M14：120→205 —— 白字压回「低伤害」后主读条承担输出，读条可打断即其反制面
      { kind: 'damage', school: School.Frost, amount: { flat: 205 } },
      {
        kind: 'applyAura',
        aura: {
          id: 'mage.frostbolt.chill',
          name: '霜矢',
          kind: 'debuff',
          duration: 3,
          dispelType: DispelType.Magic,
          clearableByTrinket: false,
          modifiers: { moveSpeed: 0.7 },
          description: '移动速度降低 30%。',
          vfx: 'mage_chill',
        },
      },
    ],
    description: '造成冰霜伤害，并使目标移动速度降低 30%，持续 3 秒。',
    vfx: 'mage_frostbolt',
  },
  {
    id: asSkillId('mage.fire_blast'),
    name: '烈焰爆',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: RANGE.MEDIUM },
    shape: { kind: 'single' },
    // 9.6：瞬发，可移动使用 —— 被贴身或被打断锁学派后唯一还能输出的手段
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Fire,
    cooldown: 8,
    triggersGcd: true,
    requiresLos: true,
    cost: { resource: Resource.Mana, amount: 40 },
    counters:
      '瞬发不能被专用打断，但沉默、火焰学派锁定和硬控制仍会封住它；距离只有 25 米，是法师技能里最容易被拉开的；8 秒冷却，被计时后可以预判躲视线。',
    // M14：150→225 —— 瞬发爆发件，8s 冷却
    effects: [{ kind: 'damage', school: School.Fire, amount: { flat: 225 } }],
    description: '瞬发造成中等火焰伤害，可在移动中使用。',
    vfx: 'mage_fire_blast',
  },
  {
    id: asSkillId('mage.polymorph'),
    name: '化形术',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: RANGE.RANGED },
    shape: { kind: 'single' },
    // 9.6：1.5 秒奥术读条，原地
    cast: { kind: CastKind.Cast, time: 1.5, movable: false, interruptible: true },
    school: School.Arcane,
    cooldown: 15,
    triggersGcd: true,
    requiresLos: true,
    cost: { resource: Resource.Mana, amount: 35 },
    counters:
      '读条期间可被打断（锁奥术 3 秒）、沉默或控制掐掉；命中后受到伤害即提前解除，队友一次误伤就白给（8.2）；走「迷惑」递减链 100%→50%→25%→免疫；可被「战斗意志」解除，也可被驱散魔法移除。',
    effects: [
      // 8.2 迷惑/变形：受伤提前解除 + 走 incapacitate 递减链，由 sim 层统一按 DrCategory.Incapacitate 结算
      { kind: 'incapacitate', duration: 4, breakDamage: 100 },
    ],
    description: '将目标变为无害生物 4 秒，期间无法行动，受到伤害会提前解除。',
    vfx: 'mage_polymorph',
  },
  {
    id: asSkillId('mage.frost_nova'),
    name: '霜爆新星',
    classId: CLASS_ID,
    // 5.4 自身中心技能：不需要选择目标；6.4 不会穿过封闭墙体
    targeting: Targeting.SelfCenter,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: 5 },
    shape: { kind: 'circle', radius: 5 },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Frost,
    cooldown: 18,
    triggersGcd: true,
    cost: { resource: Resource.Mana, amount: 40 },
    counters:
      '只覆盖身边 5 米，站远就完全无效；定身受到较高伤害后提前解除，队友的范围技能会帮对手挣脱；走「定身」递减链，与普通减速分开计算（8.2）；可被「战斗意志」、自由祝福或任何位移技能摆脱。',
    // 8.2 定身：走 DrCategory.Root 递减链，与普通减速分开计算
    effects: [{ kind: 'root', duration: 2, breakDamage: 200 }],
    description: '冻结身边 5 米内的敌人，定身 2 秒，受到较高伤害后解除。',
    vfx: 'mage_frost_nova',
  },
  {
    id: asSkillId('mage.blink'),
    name: '瞬闪',
    classId: CLASS_ID,
    // 5.4 方向类技能：沿角色面向释放，不依赖硬目标
    targeting: Targeting.Line,
    targetFilter: TargetFilter.Self,
    range: { min: 0, max: 8 },
    shape: { kind: 'line', length: 8, width: 1 },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Arcane,
    cooldown: 15,
    triggersGcd: true,
    cost: { resource: Resource.Mana, amount: 30 },
    counters:
      '不能穿墙或越过非法高差（13.5 / 验收 #46），贴墙释放会被压缩到很短的一段；只解除定身，普通减速依然保留（8.3）；昏迷、变形、恐惧期间无法使用；只走面向方向，转身不及时就闪进对方怀里。',
    effects: [{ kind: 'blinkForward', distance: 8, clearsRoot: true }],
    description: '沿面向瞬间移动 8 米，并解除定身效果。',
    vfx: 'mage_blink',
  },
  {
    id: asSkillId('mage.counterspell'),
    name: '断法',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: RANGE.RANGED },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Arcane,
    cooldown: 20,
    // 7.2 专用打断不触发公共冷却，便于在进攻技能之间穿插
    triggersGcd: false,
    requiresLos: true,
    cost: { resource: Resource.Mana, amount: 20 },
    counters:
      '目标未在施法、或施法带盾牌标记（不可打断）时仍然进入 20 秒冷却（7.2）；可取消物理射击准备但不锁武器，被打断的猎人下一秒就能重新开弓；假读条可以骗掉；自身被沉默或奥术学派锁定时用不出来。',
    effects: [
      // 7.2：法师是唯一 4 秒学派锁定的职业，见 constants/combat.ts 的 INTERRUPT.SCHOOL_LOCK_COUNTERSPELL
      { kind: 'interrupt', schoolLockSeconds: 4 },
    ],
    description: '打断法术、引导或射击准备。打断魔法时额外锁定该学派 4 秒；打断物理射击只取消本次动作。',
    vfx: 'mage_counterspell',
  },
  {
    id: asSkillId('mage.ice_barrier'),
    name: '霜甲护盾',
    classId: CLASS_ID,
    targeting: Targeting.Self,
    targetFilter: TargetFilter.Self,
    range: { min: 0, max: 0 },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Frost,
    cooldown: 25,
    triggersGcd: true,
    cost: { resource: Resource.Mana, amount: 60 },
    counters:
      '只吸收固定数值，爆发一轮就打穿（破裂表现见 14.3）；不阻止任何控制，被昏迷或变形照样定住；受竞技场战斗抑制影响，后期吸收量明显下降（8.5）。',
    effects: [
      {
        kind: 'applyAura',
        target: 'self',
        aura: {
          id: 'mage.ice_barrier',
          name: '霜甲护盾',
          kind: 'buff',
          duration: 8,
          // 9.6 未标注该护盾可被驱散，按不可驱散处理，避免凭空给对手一个解法
          dispelType: DispelType.None,
          // M14：220→400 —— 吸收盾是法系对近战冲脸唯一的结构性抗性（bot 不会风筝，真人只会更强）
          absorb: 400,
          description: '吸收 220 点伤害，持续 8 秒。',
          vfx: 'mage_ice_barrier',
        },
      },
    ],
    description: '获得持续 8 秒的吸收护盾。',
    vfx: 'mage_ice_barrier',
  },
  {
    id: asSkillId('mage.ice_block'),
    name: '冰封庇护',
    classId: CLASS_ID,
    targeting: Targeting.Self,
    targetFilter: TargetFilter.Self,
    range: { min: 0, max: 0 },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Frost,
    cooldown: 90,
    triggersGcd: true,
    // 8.4：夺旗战场中进入完全无敌会立即掉旗
    dropsFlagOnUse: true,
    counters:
      '4 秒内完全免疫但自己也完全不能行动，等于主动交出 4 秒输出与救人窗口；属于魔法增益，可被群体驱散提前打掉（8.4 / dispel 的 canRemoveImmunity）；持旗时使用会立刻掉旗；90 秒冷却，交掉之后是法师最脆弱的窗口。',
    effects: [
      {
        kind: 'applyAura',
        target: 'self',
        aura: {
          id: 'mage.ice_block',
          name: '冰封庇护',
          kind: 'buff',
          duration: 4,
          // 10.x 群体驱散可解除的完全免疫
          dispelType: DispelType.Magic,
          clearableByTrinket: false,
          // 完全免疫 + 无法行动：immuneAll 挡下全部伤害与控制，stunned 同时封住自己的一切动作
          flags: { immuneAll: true, stunned: true },
          description: '完全免疫一切伤害与效果，但无法移动、攻击或施法。',
          vfx: 'mage_ice_block',
        },
      },
    ],
    description: '将自己冻结在寒冰中 4 秒，完全免疫但无法行动。使用时立即掉旗，可被群体驱散解除。',
    vfx: 'mage_ice_block',
  },
  {
    id: asSkillId('mage.blizzard'),
    name: '冰霜风暴',
    classId: CLASS_ID,
    // 5.4 地面目标技能：鼠标放置圆形指示器；6.4 指示器不能穿过封闭墙体放置
    targeting: Targeting.Ground,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: RANGE.RANGED },
    shape: { kind: 'circle', radius: 6 },
    // 9.6：0.8 秒读条 + 4 秒引导，原地
    cast: {
      kind: CastKind.Channel,
      time: 0.8,
      channelDuration: 4,
      ticks: 8,
      movable: false,
      interruptible: true,
    },
    school: School.Frost,
    cooldown: 45,
    triggersGcd: true,
    requiresLos: true,
    cost: { resource: Resource.Mana, amount: 90 },
    counters:
      '移动、打断或控制会停止剩余引导（7.1 / 7.3），法师必须站定 4.8 秒；区域固定在地面，走出去就完全不吃伤害；减速属于魔法效果，可被驱散或自由祝福清掉；落点全程可见，是最容易预读的封路技能。',
    effects: [
      {
        kind: 'spawnGroundArea',
        areaId: 'mage.blizzard_area',
        radius: 6,
        duration: 4,
        tickInterval: 0.5,
        onTick: [
          { kind: 'damage', school: School.Frost, amount: { flat: 35 } },
          {
            kind: 'applyAura',
            aura: {
              id: 'mage.blizzard.chill',
              name: '冰霜风暴',
              kind: 'debuff',
              // 每跳刷新，离开区域后 1 秒内自然消失
              duration: 1,
              dispelType: DispelType.Magic,
              clearableByTrinket: false,
              modifiers: { moveSpeed: 0.7 },
              description: '移动速度降低 30%。',
              vfx: 'mage_chill',
            },
          },
        ],
      },
    ],
    description: '在指定地面召唤持续 4 秒的暴风雪，每 0.5 秒造成冰霜伤害并减速 30%。',
    vfx: 'mage_blizzard',
  },
  {
    id: asSkillId('mage.meteor'),
    name: '陨星',
    classId: CLASS_ID,
    targeting: Targeting.Ground,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: RANGE.RANGED },
    shape: { kind: 'circle', radius: 5 },
    // 9.6：1 秒火焰读条，原地
    cast: { kind: CastKind.Cast, time: 1, movable: false, interruptible: true },
    school: School.Fire,
    cooldown: 60,
    triggersGcd: true,
    requiresLos: true,
    cost: { resource: Resource.Mana, amount: 120 },
    counters:
      '落点和倒计时全程显示，可以走出去躲开（14.3）；1 秒读条期间可被打断并锁火焰 4 秒（自己被反制同理）；从读条到落地共 2.5 秒，位移、免疫或寒冰屏障都能规避；一旦读条被打断，冷却照进但无伤害。',
    effects: [
      // 6.6 延迟落点：落点边界与倒计时全程可见
      {
        kind: 'delayedGroundImpact',
        delay: 1.5,
        radius: 5,
        onImpact: [{ kind: 'damage', school: School.Fire, amount: { flat: 420 } }],
      },
    ],
    description: '在指定地面召唤陨石，1.5 秒后落地造成高额范围火焰伤害。落点与倒计时全程可见。',
    vfx: 'mage_meteor',
  },
  // 武器方案授予的技能
  {
    id: asSkillId('mage.elemental_slash'),
    name: '近身元素斩',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: RANGE.MELEE },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Arcane,
    cooldown: 6,
    triggersGcd: true,
    requiresFacing: true,
    requiresLos: true,
    cost: { resource: Resource.Mana, amount: 25 },
    counters:
      '仅「法刃 + 元素焦点」方案可用；要求贴身并面向目标，被风筝就完全打不到；属于魔法技能，沉默和奥术学派锁定都能封住（8.2）。',
    effects: [{ kind: 'damage', school: School.Arcane, amount: { weaponPercent: 1.1 } }],
    description: '以附着元素能量的法刃劈砍目标，造成 110% 武器伤害。仅法刃方案可用。',
    vfx: 'mage_elemental_slash',
  },
];

// ── 武器方案（附录A#4：职业、攻击间隔、距离、优势、代价、改变的技能）──
//
// ⚠ schema 缺口：WeaponDef 没有「远程技能最大距离乘算」字段，skillModifiers 也只有
//   damageMultiplier / cooldownMultiplier，无法表达半径或持续时间的变化。
//   因此「法刃 + 元素焦点」的远程距离 -20%、双手法杖的「范围能力强」目前只能写在
//   advantage / cost 文案里。建议后续给 WeaponDef 增加 rangeMultiplier，
//   给 skillModifiers 增加 radiusMultiplier / durationMultiplier 后再数据化。

const weapons: WeaponDef[] = [
  {
    id: asWeaponId('mage.staff'),
    name: '双手法杖',
    classId: CLASS_ID,
    isDefault: true,
    handedness: 'staff',
    // 9.6：120% 法术弹，2 秒，32 米
    swingInterval: 2,
    // M14：1.2→0.5 —— 规格 376 行写明法杖是「低伤害法术弹」；1.2 时白字 60/s 反超冰枪，法系变白字职业
    swingPercent: 0.5,
    reach: RANGE.RANGED_LONG,
    isRanged: true,
    modifiers: { damageDealt: 1.12, castSpeed: 1.1, damageTaken: 1.08 },
    advantage: '法术伤害 +12%，范围能力强',
    cost: '读条时间 +10%，物理防御低',
    removesSkills: [asSkillId('mage.elemental_slash')],
    // 「强化暴风雪/陨石」：schema 只支持伤害/冷却乘算，半径与持续时间加强暂无字段
    skillModifiers: {
      'mage.blizzard': { damageMultiplier: 1.15 },
      'mage.meteor': { damageMultiplier: 1.15 },
    },
    model: 'mage_staff',
  },
  {
    id: asWeaponId('mage.wand_orb'),
    name: '魔杖 + 法球',
    classId: CLASS_ID,
    isDefault: false,
    handedness: 'ranged',
    // 9.6：70% 法术弹，1.2 秒，28 米
    swingInterval: 1.2,
    // M14：0.7→0.45 —— 与法杖档协调（攻速快单发低）
    swingPercent: 0.45,
    reach: 28,
    isRanged: true,
    modifiers: { castSpeed: 0.88, damageDealt: 0.92, resourceGain: 1.15 },
    advantage: '读条时间 -12%，资源循环快',
    cost: '伤害 -8%，范围较小',
    removesSkills: [asSkillId('mage.elemental_slash')],
    // 「火焰冲击更频繁」
    skillModifiers: {
      'mage.fire_blast': { cooldownMultiplier: 0.7 },
    },
    model: 'mage_wand_orb',
  },
  {
    id: asWeaponId('mage.spellblade_focus'),
    name: '法刃 + 元素焦点',
    classId: CLASS_ID,
    isDefault: false,
    // 9.6：85% 近战，1.5 秒，2.8 米 —— 法师唯一的近战武器方案，普通攻击走近战规则（7.6）
    handedness: 'oneHand',
    swingInterval: 1.5,
    swingPercent: 0.85,
    reach: RANGE.MELEE,
    isRanged: false,
    modifiers: { damageTaken: 0.9 },
    advantage: '瞬发技能 +15%，自保提高',
    cost: '远程技能最大距离 -20%',
    grantsSkills: [asSkillId('mage.elemental_slash')],
    // 「瞬发技能 +15%」：AuraModifiers 没有「仅瞬发」维度，只能逐个瞬发技能列举，
    // 避免用 damageDealt 把读条技能一起加强（17.1：不能同时提高伤害/攻速/防御/移动/控制）
    skillModifiers: {
      'mage.fire_blast': { damageMultiplier: 1.15 },
      'mage.frost_nova': { damageMultiplier: 1.15 },
      'mage.elemental_slash': { damageMultiplier: 1.15 },
    },
    model: 'mage_spellblade_focus',
  },
];

export const mage: ClassDef = {
  id: CLASS_ID,
  name: '法师',
  role: '远程控制、元素爆发、区域封锁',
  baseHealth: 900,
  resources: [{ resource: Resource.Mana, max: 1000, start: 1000, regenPerSecond: 15 }],
  strengths: '控制、爆发、位移、地面区域',
  weaknesses: '生命低、读条容易被打断、被贴身压力大',
  defaultWeaponId: asWeaponId('mage.staff'),
  defaultArmorId: asArmorId('mage.default'),
  skills,
  weapons,
  armors: makeArmorSet(CLASS_ID, { defaultName: '布甲' }),
  // 默认双手法杖：约 2 秒一次低伤害法术弹（9.6）
  autoAttack: { ranged: true, school: School.Arcane },
};
