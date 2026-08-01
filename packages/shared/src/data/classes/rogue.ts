/**
 * 盗贼 —— 设计文档 9.4
 * 定位：潜行侦察、单点控制、爆发与干扰。生命 950，资源能量 + 连击点。
 *
 * 结构完全对齐 packages/shared/src/data/classes/warrior.ts（数据文件范本）：
 * 一个技能一个对象、附录A#3 九项全填、counters 写人话。
 *
 * 盗贼是夺旗规则（第12章）限制最多的职业：潜行与暗影步在持旗时禁用，
 * 消失属于「先掉旗再播表现」（8.4 / 12.3 / 验收 #40），下面逐条落到字段上。
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
import type { AuraDef, ClassDef, SkillDef, WeaponDef } from '../schema.js';

const CLASS_ID = asClassId('rogue');

/** 9.4 脚踢与毒刃的表列距离是 3 米，介于 RANGE.MELEE(2.8) 与 MELEE_EXTENDED(3.4) 之间，直接写死 */
const REACH_KICK = 3;

/**
 * 潜行光环。潜行没有自然到期时间，而是被伤害、攻击、拔旗或照明弹揭露而终止，
 * schema 的 duration 是必填项，这里给一个远超单局时长的值表示「持续到被打破」。
 */
const stealthAura = (): AuraDef => ({
  id: 'rogue.stealth',
  name: '隐匿',
  kind: 'buff',
  duration: 600,
  dispelType: DispelType.None,
  clearableByTrinket: false,
  // 5.2 / 验收 #5：未被发现的潜行目标不能被点击、Tab 或小地图选中，也不显示姓名板
  flags: { stealthed: true },
  modifiers: { moveSpeed: 0.85 },
  description: '隐藏姓名板与选中，移动速度降低 15%。攻击、受到伤害或被近距离发现会解除。',
  vfx: 'rogue_stealth',
});

// ── 技能 ─────────────────────────────────────────────────────────

const skills: SkillDef[] = [
  {
    id: asSkillId('rogue.stealth'),
    name: '隐匿',
    classId: CLASS_ID,
    targeting: Targeting.Self,
    targetFilter: TargetFilter.Self,
    range: { min: 0, max: 0 },
    shape: { kind: 'single' },
    // 9.4：脱战 4 秒后需要 1 秒进入。进入过程是物理准备动作，不产生学派锁定
    cast: { kind: CastKind.Cast, time: 1, movable: true, interruptible: false },
    school: School.Physical,
    cooldown: 0,
    triggersGcd: true,
    // 12.3：旗手不能潜行、完全隐身、使用坐骑或跨地图传送
    forbiddenWhileCarryingFlag: true,
    counters:
      '必须脱离战斗 4 秒才能起手，进入还要 1 秒，团战中基本不可用；3 米内可能被敌人直接发现，猎人照明弹（revealsStealth 地面区域）会直接揭露整片区域；任何伤害或主动攻击都会解除；持旗时完全不可进入（12.3 / 验收 #40）；竞技场决胜阶段潜行受限，位置会被大致暴露（8.5）。',
    /**
     * ★ M11：原本是一条 `custom`（`rogue.requireOutOfCombat`）。
     *   ⚠️ 而那个 handler **从来没有注册过** —— 潜行因此**没有任何脱战限制**，
     *      团战中随时可以起手，与 9.x「脱战 4 秒后才能起手」完全相反。
     *   `SkillDef.requires` 在 M11 之前也是死 schema（零读取方），
     *   现在 `validateCast()` 真的读它了，所以这条能迁过来。
     */
    requires: [{ kind: 'outOfCombat', seconds: 4 }],
    effects: [
      { kind: 'enterStealth' },
      { kind: 'applyAura', target: 'self', aura: stealthAura() },
    ],
    description: '脱战 4 秒后可用，1 秒进入潜行。未被发现时隐藏姓名板与选中，移动速度降低 15%。持旗时不可进入。',
    vfx: 'rogue_stealth',
  },
  {
    id: asSkillId('rogue.backstab'),
    name: '背袭',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: RANGE.DAGGER },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Physical,
    cooldown: 0,
    triggersGcd: true,
    requiresFacing: true,
    requiresLos: true,
    cost: { resource: Resource.Energy, amount: 40 },
    counters:
      '距离只有 2.4 米，是全游戏最短的近战触及，被减速或击退就打不到；+50% 加成要求站在目标背后约 120 度扇形内（6.5），目标只要转身面向就吃不到，且只旋转镜头不改变朝向这条规则对双方同样成立；缴械后无法使用；双剑方案的背后加成明显降低。',
    effects: [
      // M14：1.15→0.7 —— 背刺无冷却，是能量的主要出口；配合背后 +50% 保留偷袭奖励
      { kind: 'damage', school: School.Physical, amount: { weaponPercent: 0.7 }, behindBonus: 0.5 },
      { kind: 'gainResource', resource: Resource.ComboPoints, amount: 1 },
    ],
    description: '造成 70% 武器伤害并获得 1 个连击点。从背后攻击时伤害提高 50%。',
    vfx: 'rogue_backstab',
  },
  {
    id: asSkillId('rogue.eviscerate'),
    name: '剜刺',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: RANGE.DAGGER },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Physical,
    cooldown: 6,
    triggersGcd: true,
    requiresFacing: true,
    requiresLos: true,
    requiresComboPoints: true,
    cost: { resource: Resource.Energy, amount: 35 },
    counters:
      '必须先用背刺等技能攒满连击点，攒点期间会被对手看见明确的爆发窗口；伤害是一次性直伤，减伤光环、吸收护盾和竞技场战斗抑制（8.5）都能吃掉大半；缴械后无法使用；连击点在目标死亡或切换目标后清空，被打断转火节奏等于浪费整轮。',
    effects: [
      {
        kind: 'spendComboPoints',
        perPointMultiplier: 1,
        // M14：0.5→0.42 —— 终结技随连击点修复（此前连击点长在敌人身上、终结技永远空转）而实际生效，随之回调
        base: { kind: 'damage', school: School.Physical, amount: { weaponPercent: 0.42 } },
      },
    ],
    description: '消耗全部连击点造成终结伤害，每点 42% 武器伤害（5 点约 210%）。',
    vfx: 'rogue_eviscerate',
  },
  {
    id: asSkillId('rogue.kidney_shot'),
    name: '昏击',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: RANGE.DAGGER },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Physical,
    cooldown: 25,
    triggersGcd: true,
    requiresFacing: true,
    requiresLos: true,
    requiresComboPoints: true,
    cost: { resource: Resource.Energy, amount: 25 },
    counters:
      '走昏迷递减链（8.2：100% → 50% → 25% → 免疫，15 秒窗口），接在冲锋或风暴之锤后面会被大幅削短；「战斗意志」可直接解除（8.3，90 秒冷却）；抗控型护甲把控制时长压到 75%（10.8）；低连击点时只有不到 1 秒，几乎无法接控制链；缴械后无法使用。',
    effects: [
      // schema 的 spendComboPoints 只有「基础值 × 每点系数 × 点数」这种线性映射，
      // 无法表达文档「1 点 1 秒 ~ 5 点 3 秒」这种仿射区间，这里对齐 5 点上限 3 秒
      {
        kind: 'spendComboPoints',
        perPointMultiplier: 0.6,
        base: { kind: 'stun', duration: 1 },
      },
      { kind: 'damage', school: School.Physical, amount: { weaponPercent: 0.4 } },
    ],
    description: '消耗全部连击点昏迷目标，每点 0.6 秒（5 点 3 秒），并造成少量伤害。受昏迷递减影响。',
    vfx: 'rogue_kidney_shot',
  },
  {
    id: asSkillId('rogue.shadowstep'),
    name: '影袭步',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: 18 },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Shadow,
    cooldown: 20,
    triggersGcd: true,
    requiresLos: true,
    // 12.3：旗手的跨大段地图传送被禁用；短距冲锋闪现可保留但暗影步属于绕后传送
    forbiddenWhileCarryingFlag: true,
    counters:
      '需要视线，柱子和封闭门直接封掉起手（6.4）；目标背后是墙、禁区或非法落点时会失败或被推到最近合法位置（13.5 / 验收 #46）；不能穿墙，绕柱子拉扯依然有效；落点固定在背后 1.5 米，对手可以预判转身把盗贼甩到正面；持旗时完全不可使用（12.3）；20 秒冷却，交掉之后一段时间内没有近身手段。',
    effects: [{ kind: 'teleportBehindTarget', offset: 1.5 }],
    description: '瞬移到目标背后 1.5 米的合法位置。不能穿越墙体或禁区，持旗时不可使用。',
    vfx: 'rogue_shadowstep',
  },
  {
    id: asSkillId('rogue.kick'),
    name: '断招踢',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: REACH_KICK },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Physical,
    cooldown: 15,
    // 7.2 专用打断不触发公共冷却，便于在进攻技能之间穿插
    triggersGcd: false,
    requiresFacing: true,
    requiresLos: true,
    counters:
      '目标未在施法、或施法带盾牌标记（不可打断）时仍然进入 15 秒冷却（7.2）；假读条可以骗掉（7.5）；缴械状态下无法使用；不能打断已经完成的普通自动攻击（7.6）；也可取消物理射击准备，但物理射击不产生学派锁定，猎人下一秒就能重新抬手（7.2 / 验收 #16）。',
    effects: [{ kind: 'interrupt', schoolLockSeconds: 3 }],
    description: '打断法术、引导或射击准备。被打断的是魔法时锁定该学派 3 秒；打断物理射击只取消本次动作。不触发公共冷却。',
    vfx: 'rogue_kick',
  },
  {
    id: asSkillId('rogue.poisoned_blade'),
    name: '毒刃',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: REACH_KICK },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Physical,
    cooldown: 10,
    triggersGcd: true,
    requiresFacing: true,
    requiresLos: true,
    cost: { resource: Resource.Energy, amount: 25 },
    counters:
      '毒素类减益，德鲁伊/圣骑士的解毒和自由祝福都能移除（8.4）；普通减速不能被「战斗意志」解除（8.3），但消失、逃脱、死亡脚步同样可以摆脱；减速不与其他减速叠乘，取较强者；降低治疗只有 20%，与战士致死创伤同类效果不叠加；缴械后无法使用。',
    effects: [
      // M14：0.55→0.45 —— 毒刃与 DoT 是长局副输出，马拉松局（场均 60s）里权重高
      { kind: 'damage', school: School.Physical, amount: { weaponPercent: 0.45 } },
      {
        kind: 'applyAura',
        aura: {
          id: 'rogue.poisoned_blade',
          name: '毒刃',
          kind: 'debuff',
          duration: 4,
          dispelType: DispelType.Poison,
          clearableByTrinket: false,
          modifiers: { moveSpeed: 0.5, healingTaken: 0.8 },
          description: '移动速度降低 50%，受到的治疗降低 20%。',
          vfx: 'rogue_poison',
        },
      },
    ],
    description: '涂毒一击，使目标移动速度降低 50%、受到的治疗降低 20%，持续 4 秒。',
    vfx: 'rogue_poisoned_blade',
  },
  {
    id: asSkillId('rogue.smoke_bomb'),
    name: '烟雾弹',
    classId: CLASS_ID,
    targeting: Targeting.Ground,
    targetFilter: TargetFilter.Any,
    range: { min: 0, max: 15 },
    shape: { kind: 'circle', radius: 5 },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Shadow,
    cooldown: 30,
    triggersGcd: true,
    requiresLos: true,
    counters:
      '只屏蔽「从区域外直接选中」，敌人走进烟雾、或用地面范围与自身中心范围技能照样能打（9.4 明文）；已经在身上的持续伤害与光环不受影响；区域是固定圆形且全程可见（验收 #8 / #48），对手可以直接绕开或把旗手拖出去；地面指示器不能放在墙后或非法位置（6.4）；持续只有 5 秒，交换冷却 30 秒。',
    effects: [
      {
        kind: 'spawnGroundArea',
        areaId: 'rogue.smoke_bomb',
        radius: 5,
        duration: 5,
        // 区域本身不造成任何周期性效果，只提供选中屏蔽，tick 仅用于维护区域内单位列表
        tickInterval: 1,
        onTick: [],
        blocksTargetingFromOutside: true,
      },
    ],
    description: '在地面制造持续 5 秒的烟雾。区域外的单位不能直接选中区域内目标；进入区域或使用范围技能仍可攻击。',
    vfx: 'rogue_smoke_bomb',
  },
  {
    id: asSkillId('rogue.evasion'),
    name: '疾闪',
    classId: CLASS_ID,
    targeting: Targeting.Self,
    targetFilter: TargetFilter.Self,
    range: { min: 0, max: 0 },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Physical,
    cooldown: 35,
    triggersGcd: true,
    counters:
      '只对正面近战物理攻击生效，法术、持续伤害和地面范围完全不受影响（9.4 明文），法系队伍可以直接无视；绕到盗贼背后攻击不吃闪避加成（6.5）；不是免疫，昏迷、恐惧、定身和沉默照常命中；只有 5 秒。',
    effects: [
      {
        kind: 'applyAura',
        target: 'self',
        aura: {
          id: 'rogue.evasion',
          name: '疾闪',
          kind: 'buff',
          duration: 5,
          dispelType: DispelType.None,
          clearableByTrinket: false,
          // M14：0.5→0.35 —— 五成正面闪避在 bot 无法绕后的基线里近乎半免伤窗口
          modifiers: { dodgeFront: 0.35 },
          description: '正面闪避几率提高 50%。法术不受影响。',
          vfx: 'rogue_evasion',
        },
      },
    ],
    description: '5 秒内正面闪避几率提高 50%。法术不受影响。',
    vfx: 'rogue_evasion',
  },
  {
    id: asSkillId('rogue.vanish'),
    name: '遁形',
    classId: CLASS_ID,
    targeting: Targeting.Self,
    targetFilter: TargetFilter.Self,
    range: { min: 0, max: 0 },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Physical,
    cooldown: 90,
    triggersGcd: true,
    // 8.4 / 12.3 / 验收 #40：使用完全无敌、消失或潜行时先掉旗，再播放技能表现
    dropsFlagOnUse: true,
    counters:
      '持旗时会先掉旗再生效，等于把旗白送出去（8.4 / 12.3 / 验收 #40）；3 秒宽限期一过，3 米内依然可能被发现，照明弹类揭露区域可以直接把人拽出来；只解除减速和定身，昏迷、恐惧、沉默和降低治疗照旧（对照 8.3 解控清单）；已经飞在路上的锁定投射物仍会结算（6.6）；90 秒冷却，交掉后整局基本不会再有第二次；竞技场决胜阶段潜行受限（8.5）。',
    effects: [
      // 解除全部减速与定身：定身在 schema 里是 { kind: 'root' } 而非具名光环，
      // removeAura/dispel 都点不到，且不应在职业数据里硬编码别的职业光环 id，故走自定义处理器
      { kind: 'custom', handler: 'rogue.clearSlowAndRoot' },
      { kind: 'enterStealth', graceSeconds: 3 },
      { kind: 'applyAura', target: 'self', aura: stealthAura() },
    ],
    description: '立即解除所有减速和定身并进入潜行，3 秒内不因近距离自动暴露。使用时立即掉旗。',
    vfx: 'rogue_vanish',
  },
  // 武器方案授予的技能
  {
    id: asSkillId('rogue.blade_flurry'),
    name: '双刃乱舞',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: RANGE.MELEE },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Physical,
    cooldown: 8,
    triggersGcd: true,
    requiresFacing: true,
    requiresLos: true,
    cost: { resource: Resource.Energy, amount: 40 },
    counters:
      '仅双剑方案可用；纯正面伤害，没有背后加成，对手不需要为它转身；多段小伤害容易被减伤光环和吸收护盾整段吃掉；缴械后禁用。',
    effects: [
      { kind: 'damage', school: School.Physical, amount: { weaponPercent: 0.55 } },
      { kind: 'damage', school: School.Physical, amount: { weaponPercent: 0.55 } },
      { kind: 'gainResource', resource: Resource.ComboPoints, amount: 1 },
    ],
    description: '双剑快速连斩两下，共 110% 武器伤害并获得 1 个连击点。仅双剑方案可用。',
    vfx: 'rogue_blade_flurry',
  },
  {
    id: asSkillId('rogue.riposte'),
    name: '反刺',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: 2.5 },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Physical,
    cooldown: 6,
    triggersGcd: true,
    requiresFacing: true,
    requiresLos: true,
    cost: { resource: Resource.Energy, amount: 20 },
    counters:
      '仅匕首 + 格挡短刃方案可用；必须先成功招架一次才能按出来，对手改用法术输出就完全触发不了（招架只对正面物理生效）；缴械后禁用；该方案整体爆发降低 15%，反击刺补不回刺骨的伤害缺口。',
    /**
     * ★ M11：原本是一条 `custom`（`rogue.requireRecentParry`），**从未注册** ——
     *   反击刺此前**没有任何招架前置**，随时能按，与 9.x「成功招架后可用」相反。
     *
     *   迁移的前提有两件，M11 都补齐了：
     *     · `validateCast()` 真的读 `SkillDef.requires`（此前是零读取方的死 schema）
     *     · **招架判定本身存在** —— 8.x 的闪避/招架/格挡此前从未实现，
     *       `lastParryAt` 因此没有任何来源
     */
    requires: [{ kind: 'recentlyParried', withinSeconds: 5 }],
    effects: [
      { kind: 'damage', school: School.Physical, amount: { weaponPercent: 1.0 } },
      { kind: 'gainResource', resource: Resource.ComboPoints, amount: 1 },
    ],
    description: '成功招架后可用，反手刺出造成 100% 武器伤害并获得 1 个连击点。仅匕首 + 格挡短刃方案可用。',
    vfx: 'rogue_riposte',
  },
];

// ── 武器方案（附录A#4：职业、攻击间隔、距离、优势、代价、改变的技能）──

const weapons: WeaponDef[] = [
  {
    id: asWeaponId('rogue.dual_daggers'),
    name: '双匕首',
    classId: CLASS_ID,
    isDefault: true,
    handedness: 'dualWield',
    swingInterval: 0.7,
    // M14：0.6→0.25 —— 站桩白字曾是 bot 基线的主宰源（盗贼一度 100% 胜率），重心移到技能与控制
    swingPercent: 0.25,
    reach: RANGE.DAGGER,
    modifiers: { resourceGain: 1.15 },
    advantage: '背后爆发最高，能量循环快',
    cost: '距离最短，正面弱',
    // 9.4「强化背刺和毒刃」
    skillModifiers: {
      'rogue.backstab': { damageMultiplier: 1.15 },
      'rogue.poisoned_blade': { damageMultiplier: 1.15 },
    },
    removesSkills: [asSkillId('rogue.blade_flurry'), asSkillId('rogue.riposte')],
    model: 'dual_daggers',
  },
  {
    id: asWeaponId('rogue.dual_swords'),
    name: '双剑',
    classId: CLASS_ID,
    isDefault: false,
    handedness: 'dualWield',
    swingInterval: 0.9,
    // M14：0.75→0.32 —— 与匕首档协调（单击仍高于匕首、攻速更慢），保持 #31 取舍
    swingPercent: 0.32,
    reach: RANGE.MELEE,
    advantage: '正面持续伤害稳定',
    cost: '背后加成降低，攻速慢',
    grantsSkills: [asSkillId('rogue.blade_flurry')],
    // schema 没有「修改某技能的 behindBonus」这一档修正，
    // 用背刺整体伤害系数下调来表达 9.4 的「背后加成降低」
    skillModifiers: { 'rogue.backstab': { damageMultiplier: 0.85 } },
    removesSkills: [asSkillId('rogue.riposte')],
    model: 'dual_swords',
  },
  {
    id: asWeaponId('rogue.dagger_buckler'),
    name: '匕首 + 格挡短刃',
    classId: CLASS_ID,
    isDefault: false,
    handedness: 'oneHand',
    swingInterval: 0.85,
    // M14：0.65→0.29 —— 同上，居中档
    swingPercent: 0.29,
    // 9.4 表列 2.5 米，介于匕首 2.4 与标准近战 2.8 之间，不复用 RANGE 常量
    reach: 2.5,
    modifiers: { parry: 0.15 },
    advantage: '招架 +15%，反击稳定',
    cost: '爆发 -15%',
    grantsSkills: [asSkillId('rogue.riposte')],
    // 9.4「获得反击刺，肾击伤害降低」；爆发 -15% 落在刺骨与背刺上
    skillModifiers: {
      'rogue.kidney_shot': { damageMultiplier: 0.7 },
      'rogue.eviscerate': { damageMultiplier: 0.85 },
      'rogue.backstab': { damageMultiplier: 0.85 },
    },
    removesSkills: [asSkillId('rogue.blade_flurry')],
    model: 'dagger_buckler',
  },
];

export const rogue: ClassDef = {
  id: CLASS_ID,
  name: '盗贼',
  role: '潜行侦察、单点控制、爆发与干扰',
  baseHealth: 950,
  resources: [
    // M14：10→6 —— 能量回复兑现（此前 regen 是死数据）后按 40 耗背刺 ≈ 6.7s 一发定节奏
    { resource: Resource.Energy, max: 100, start: 100, regenPerSecond: 6 },
    // 连击点靠背刺、剑刃连击、反击刺产出，不自然回复
    { resource: Resource.ComboPoints, max: 5, start: 0, regenPerSecond: 0 },
  ],
  strengths: '先手、控制链、转火、打断',
  weaknesses: '正面承伤低、范围压力弱、被发现后容错有限',
  defaultWeaponId: asWeaponId('rogue.dual_daggers'),
  defaultArmorId: asArmorId('rogue.default'),
  skills,
  weapons,
  armors: makeArmorSet(CLASS_ID, { defaultName: '皮甲' }),
  autoAttack: { ranged: false, school: School.Physical },
};
