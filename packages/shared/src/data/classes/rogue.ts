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
      // M14b：曾按「61.9% 磨血全胜」回调到 0.65，随后查明那是潜行永不解除的 bug
      //   （见 combat.ts 的 breakStealthOf）—— bug 修掉后盗贼跌到 11.9%，数值退回 M14 原值
      // M14b：0.7→0.9 —— M14 的 1.15→0.7 是按着潜行 bug 的虚高压的；bug 修掉后盗贼
      //   变成 DPS 全场最低（28）的普通近战，主输出件抬回大半
      { kind: 'damage', school: School.Physical, amount: { weaponPercent: 0.9 }, behindBonus: 0.5 },
      { kind: 'gainResource', resource: Resource.ComboPoints, amount: 1 },
    ],
    description: '造成 90% 武器伤害并获得 1 个连击点。从背后攻击时伤害提高 50%。',
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
        // M14b：曾误判「69% 是磨血过强」回调到 0.36 —— 真根因是潜行永不解除的 bug，
        //   修掉后退回 M14 原值
        // M14b：0.42→0.48 —— 与背袭同理由，终结技随主输出件同抬（潜行 bug 修复批）
        base: { kind: 'damage', school: School.Physical, amount: { weaponPercent: 0.48 } },
      },
    ],
    description: '消耗全部连击点造成终结伤害，每点 48% 武器伤害（5 点约 240%）。',
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
    description: '打断法术、引导或射击准备。被打断的是魔法时封锁该系技能 3 秒；打断物理射击只取消本次动作。不触发公共冷却。',
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
        },
      },
    ],
    description: '涂毒一击，使目标移动速度降低 50%、受到的治疗降低 20%，持续 4 秒。',
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
      '只对正面近战物理攻击生效，法术、持续伤害和地面范围完全不受影响（9.4 明文），法系队伍可以直接无视；绕到盗贼背后攻击不吃闪避加成（6.5）；不是免疫，昏迷、恐惧、定身和沉默照常命中；**只是 35% 的几率**，运气不好照样连着挨三刀；只有 6 秒。',
    effects: [
      {
        kind: 'applyAura',
        target: 'self',
        aura: {
          id: 'rogue.evasion',
          name: '疾闪',
          kind: 'buff',
          // P11 保命轮：5→6 秒
          duration: 6,
          dispelType: DispelType.None,
          clearableByTrinket: false,
          /**
           * M14：0.5→0.35 —— 五成正面闪避在 bot 无法绕后的基线里近乎半免伤窗口
           *
           * ★ P11 保命轮：**闪避率维持 0.35，只延长 1 秒**。
           *   本轮一度把它抬回 0.5（理由是「M14 那次是按 bot 的残疾定价，
           *   真人会绕后」），随后自己撤回：M14 的 0.35 是一条**实测结论**，
           *   而「真人会绕后」是一条**推论**。推论推翻不了实测 ——
           *   分步归因也印证了：0.35→0.5 单独值 +7.1pp 胜率，
           *   而这 7.1pp 全部来自「bot 不绕后」这一个 bug 面。
           *   盗贼这一轮真正缺的那个「扛住 3 秒集火」的键由**暗影斗篷**补齐
           *   （见下），不需要再从闪避这里挖第二次 —— 宁精勿滥。
           */
          modifiers: { dodgeFront: 0.35 },
          description: '正面闪避几率提高 35%。法术不受影响。',
        },
      },
    ],
    description: '6 秒内正面闪避几率提高 35%。法术不受影响。',
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
      /**
       * ★ 解除全部减速与定身 —— `impairs: 'movement'` 按「光环做了什么」选，
       *   正是「不硬编码别的职业光环 id」的那个表达。此前这里是
       *   `{ kind: 'custom', handler: 'rogue.clearSlowAndRoot' }`（只记事件、
       *   无实际效果）：定身是 `applyControl` 统一标 magic 的匿名光环，
       *   老的按类别驱散点不到它，语义筛选进 schema 后 custom 逃生舱可以退役。
       */
      { kind: 'dispel', impairs: 'movement', count: 'all', from: 'ally' },
      { kind: 'enterStealth', graceSeconds: 3 },
      { kind: 'applyAura', target: 'self', aura: stealthAura() },
    ],
    description: '立即解除所有减速和定身并进入潜行，3 秒内不因近距离自动暴露。使用时立即掉旗。',
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
  },

  /**
   * ★ P3b 扩充：盗贼补「先手控制 / 持续伤害 / 脱身控制」三条。
   *
   *   ⚠️ 刻意**不加**新的减伤或位移：9.x 的弱点「正面承伤低、被发现后
   *   容错有限」是这个职业的定义性代价，补进去就等于抹掉他的短板。
   *   补的三条全部瞄准审计里的缺口 —— 全瞬发、全在爆发窗口内可用。
   */
  {
    id: asSkillId('rogue.cheap_shot'),
    name: '偷袭',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: RANGE.DAGGER },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Physical,
    cooldown: 20,
    triggersGcd: true,
    requiresFacing: true,
    requiresLos: true,
    /**
     * ★ 用 `outOfCombat` 表达「潜行先手窗口」，而**不是**新增一个
     *   `stealthed` 条件 —— `ConditionDef` 里没有它，新增一个 kind
     *   就必须同步改 `validateCast()` 的判定分支，而漏改的后果是
     *   **条件恒真**（静默失效，本仓库反复踩过的坑：规则写对了没人调）。
     *   脱战 4 秒本就是进潜行的前提（与 `rogue.stealth` 同一条件），
     *   语义等价且立刻生效。
     */
    requires: [{ kind: 'outOfCombat', seconds: 4 }],
    cost: { resource: Resource.Energy, amount: 40 },
    counters:
      '**要求脱战 4 秒**（与潜行同一前提）：团战里基本按不出来，它是开场与脱战后的先手键；受昏迷递减链（100%→50%→25%→免疫，8.2），接在肾击后面会大幅缩短；「战斗意志」可直接解除（8.3）；2.4 米，被减速或击退就够不到。',
    effects: [
      { kind: 'stun', duration: 2 },
      { kind: 'gainResource', resource: Resource.ComboPoints, amount: 2 },
    ],
    description: '偷袭目标，昏迷 2 秒并获得 2 个连击点。要求脱战 4 秒 —— 开场与脱战后的先手键。',
  },
  /**
   * ⚠️ **`pnpm balance` 里盗贼因为这个技能从 21.4% 掉到 0.0%，但数值不动。**
   *
   *   P3b 精确定位过：把这里的 25 能量改成 0，盗贼**分毫不差**地回到 21.4%，
   *   极差从 90.5pp 回到 73.8pp —— 代价就是这 25 点能量，不是伤害配错。
   *
   *   为什么不因此调低它：基线里的盗贼是个**残废盗贼**。bot 不会用连击点
   *   终结技（`botController.ts` 的 `totalDamageOf` 里写着为什么：两版计入
   *   都让盗贼直落 0% 且原因未定位，按纪律回滚，连击点至今是装饰）。
   *   一个只会背刺的盗贼本来就在能量线上紧绷，再分走 25 点当然崩 ——
   *   真人拿这 25 点换 6 跳流血是划算的，他后面还有终结技可接。
   *
   *   照胜率把它调到 0 就是 `balance-report` 结尾那句警告里说的
   *   「照着胜率直接拉平」：修的是 bot 的残疾，赔进去的是技能的设计。
   *   正账记在 B1 余账（让 bot 会用连击点），不是记在这里。
   */
  {
    id: asSkillId('rogue.rupture'),
    name: '割裂',
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
    cost: { resource: Resource.Energy, amount: 25 },
    counters:
      '流血是**物理**减益，驱散魔法移除不掉 —— 代价是它也吃不到任何魔法增伤；6 跳给完 12 秒，对爆发秒杀毫无贡献，目标被治疗起来就白打；缴械期间不可用；要贴身 2.4 米且面向目标。',
    effects: [
      {
        kind: 'applyAura',
        aura: {
          id: 'rogue.rupture.bleed',
          name: '割裂',
          description: '持续流血，每 2 秒受到物理伤害。',
          kind: 'debuff',
          duration: 12,
          // 流血不属于魔法/诅咒/中毒/疾病任何一类 —— 谁也驱不掉，这是它的全部价值
          dispelType: DispelType.None,
          periodic: {
            interval: 2,
            effects: [{ kind: 'damage', school: School.Physical, amount: { flat: 42 } }],
          },
        },
      },
    ],
    description: '撕裂目标，12 秒内每 2 秒造成物理流血伤害。物理减益，驱散不掉。',
  },
  {
    id: asSkillId('rogue.blind'),
    name: '致盲',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: 10 },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Physical,
    cooldown: 45,
    triggersGcd: true,
    requiresLos: true,
    cost: { resource: Resource.Energy, amount: 30 },
    counters:
      '走「迷惑」递减链（8.2），与变形术、寒霜陷阱**共用一条链** —— 队伍里控制重复时会被砍到不足 1 秒；**受到任意伤害立即解除**，队友的持续伤害经常自己把它拆掉；「战斗意志」可解（8.3）；45 秒冷却是盗贼最贵的一个键。',
    effects: [{ kind: 'incapacitate', duration: 4, breakDamage: 1 }],
    description: '致盲目标 4 秒，期间无法行动，受到任何伤害立即解除。用来脱身或掐断对手的爆发。',
  },

  /**
   * ★ P9 扩充：盗贼补「速度爆发」—— 他是全花名册**唯一没有速度爆发的近战**。
   *
   *   审计口径（`moveSpeed > 1` 的主动键，全职业只有两条）：
   *     · 猎人 猎豹守护 —— 1.3 / 6 秒 / CD 30
   *     · 德鲁伊 疾奔怒吼 —— 1.25 / 5 秒 / CD 60（团队，且旗手被 12.3 截到 +10%）
   *   盗贼一条都没有。他的机动全是**位移**（影袭步瞬移、遁形脱身），两条都
   *   `forbiddenWhileCarryingFlag` / `dropsFlagOnUse`，而且都解决不了
   *   「对手一直在跑、我一直追不上」这件事 —— P8 的 hard「苟住」归因里
   *   盗贼因为追不死会跑的对手掉到 0%，窟窿就在这。
   *
   *   ⚠️ 与 P3b 扩充同一条纪律：**不补减伤、不补解控**。9.x 的
   *   「正面承伤低、被发现后容错有限」是这个职业的定义性代价，补进去就是抹短板。
   *   疾跑只给速度，不解除也不免疫任何移动限制 —— 解控那一格仍然只属于
   *   遁形（90 秒，且持旗时先掉旗）。
   */
  {
    id: asSkillId('rogue.sprint'),
    name: '疾跑',
    classId: CLASS_ID,
    targeting: Targeting.Self,
    targetFilter: TargetFilter.Self,
    range: { min: 0, max: 0 },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Physical,
    /**
     * ★ 120 秒 —— 用户拍板对齐 WoW 疾跑口径（正式服：+70%/8s/CD 120s），
     *   三个数字第一次有真实出处而不是拍脑袋。落在本仓的时间尺度上有个
     *   恰好的平衡性质：**竞技场单回合上限 90 秒 < 120 秒 ⇒ 一回合最多
     *   用一次** ——「不可能一直用」直接由回合长度保证；夺旗（12~15 分钟）
     *   全场约六次。
     */
    cooldown: 120,
    triggersGcd: true,
    /**
     * ★ 刻意**不收资源**：体能爆发不该吃能量。能量要留给「追上之后」的那一轮
     *   输出 —— 收 25~40 点等于让盗贼拿一发背袭换一次追击，追上了也打不动，
     *   这个键就白加了。P3b 的割裂已经演过一次同样的账（那 25 点能量把 bot
     *   盗贼从 21.4% 打到 0.0%，见上面割裂的注释）。
     */
    counters:
      '**只加速度、不解控**：不解除也不免疫减速与定身 —— 那一格是遁形与 8.3 解控清单的分工，被断腿斩（moveSpeed 0.6）咬住时开疾跑也只有 1.7×0.6≈1.02，与常速持平等于被完全抵消；不可驱散是双刃，敌人剥不掉，自己也洗不掉身上已有的移动限制；加速取最强、不叠加（8.4），与机动型护甲（+12%）或德鲁伊疾奔怒吼（+25%）并存时只吃 1.7 这一条，没有额外收益；持旗时受旗手移动加成上限（12.3，最多 +10%）截断，抢旗局里几乎白按；120 秒冷却比竞技场单回合上限（90 秒）还长 —— 一回合只有一次，交掉之后本回合再无第二段加速，对手只要拖过这 8 秒就重新拉开。',
    effects: [
      {
        kind: 'applyAura',
        target: 'self',
        aura: {
          id: 'rogue.sprint',
          name: '疾跑',
          kind: 'buff',
          duration: 8,
          // 体能冲刺不是魔法，敌人驱不掉（与割裂的流血同一条理由）；
          // 代价面如实写在 counters 里：它同样洗不掉自己身上已有的减速
          dispelType: DispelType.None,
          clearableByTrinket: false,
          /**
           * ★ 1.7 / 8 秒 —— 与 CD 120 同一次拍板：对齐 WoW 疾跑
           *  （正式服 +70%/8s/120s），玩家的肌肉记忆直接可迁移。
           *   高于猎豹守护的 1.3 是取舍的另一半：CD 是它的四倍，
           *   换「更少的次数、更高的上限」。
           *   旗手的实际加成由 sim 层按 12.3 的总上限截断，不在光环数据里重复表达。
           */
          modifiers: { moveSpeed: 1.7 },
          description: '移动速度提高 70%，持续 8 秒。',
        },
      },
    ],
    description: '8 秒内移动速度提高 70%。追击与撤离两用，一回合只有一次。',
  },

  /**
   * ★★ P11 保命轮：盗贼补**暗影斗篷**。
   *
   *   ⚠️ 这一条推翻了 P3b/P9 两轮写下的纪律（「盗贼刻意不补减伤 ——
   *   9.x 的『正面承伤低』是他的定义性代价」）。推翻的授权来自玩家拍板
   *   「各角色保命技能都比较缺乏」，而审计口径给出了推翻的**边界**：
   *   要补的是「扛住 3 秒集火」的那一格，不是把短板填平。
   *
   * ★ 于是选**斗篷**而不是通用减伤，理由正是那条旧纪律：
   *   斗篷只免疫**魔法伤害**，物理一分不减 —— 战士、猎人、另一个盗贼
   *   照样在 3 秒里把他打穿。「正面承伤低」原封不动地保留着，
   *   补上的只是他对**法系爆发**（法师陨星、牧师心灵爆破、德鲁伊星涌）
   *   毫无办法这件事：950 血的皮甲，一轮法系集火比谁都短。
   *   对齐 WoW 斗篷（正式服：免疫魔法伤害与有害法术 / 5 秒 / CD 120）——
   *   **冷却直接照抄 120，持续按房规压到 4 秒**（理由见下面 duration 处的
   *   长注释与实测数据）。另有一处如实缩水：本仓库的 `immuneMagic` 只管
   *   伤害免疫，不含「免疫新的有害法术」，所以变形/恐惧照穿 —— 写在 counters 里。
   *
   * ★ **学派写物理**（斗篷是抖开的披风，不是施法）：于是沉默期间照样能按。
   *   这是它与遁形的分工 —— 遁形解移动限制、进潜行、但**掉旗**且 90 秒；
   *   斗篷不掉旗、不解控，只在法系爆发那 5 秒里当一堵墙。
   *
   * ★ 顺带清掉身上的魔法减益（`impairs` 不填、按类别驱散 Magic）：
   *   对齐正式服「使用时移除所有有害魔法效果」的那一半，
   *   也让它在被 DoT 咬住时真的有意义 —— 否则 5 秒免疫过后暗言术·痛
   *   还挂在身上，等于只挡了直伤。
   */
  {
    id: asSkillId('rogue.cloak_of_shadows'),
    name: '暗影斗篷',
    classId: CLASS_ID,
    targeting: Targeting.Self,
    targetFilter: TargetFilter.Self,
    range: { min: 0, max: 0 },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    // 抖开披风是体术不是施法 —— 沉默期间可用，也不会被学派锁定连坐
    school: School.Physical,
    cooldown: 120,
    triggersGcd: true,
    // 8.3：被控住却开不了免疫等于没有这个键
    usableWhileStunned: true,
    // 刻意不收能量：能量要留给「活下来之后」的那一轮输出（同疾跑的理由）
    counters:
      '**只免疫魔法伤害，物理一分不减** —— 战士、猎人和另一个盗贼贴上来时它完全是白按，9.4 的「正面承伤低」原样保留；不免疫**控制**：昏迷、恐惧、变形、沉默、定身照常命中，法师一发变形就把这 4 秒废掉；只清施放瞬间身上的魔法减益，之后新挂上的 DoT 照旧生效；**120 秒冷却比竞技场单回合上限（90 秒）还长**，一回合只有一次；不掉旗是它相对遁形的唯一优势，代价是它既不解移动限制也不进潜行。',
    effects: [
      // 对齐正式服「使用时移除所有有害魔法效果」：按驱散类别清自己身上的魔法减益
      { kind: 'dispel', types: [DispelType.Magic], count: 'all', from: 'ally' },
      {
        kind: 'applyAura',
        target: 'self',
        aura: {
          id: 'rogue.cloak_of_shadows',
          name: '暗影斗篷',
          kind: 'buff',
          /**
           * ★ 4 秒，**不是**正式服的 5 秒 —— 对齐**本仓库的免疫档**
           *   （冰封庇护 4、神圣壁障 4、守护庇佑 4，三个免疫键全是 4 秒），
           *   而不是照抄正式服的秒数。理由与上面 CD 取 120 的理由是同一条、
           *   只是方向相反：本仓库场均 12~24 秒，正式服一局好几分钟 ——
           *   短回合让**冷却**变相延长（所以 CD 从 180 压到 120），
           *   同样也让**持续**变相加长（5 秒 ≈ 整局的三分之一）。
           *   两头都要按同一个时间基准换算，只压冷却不压持续是双标。
           * ⚠️ **分步归因实测**（`npx tsx scripts/balance-report.ts`，种子 1，168 场；
           *   注意粒度：每职业 21 场 ⇒ 一场 ≈ 4.76pp，5pp 以内的差读不出来）：
           *     · 基线（无斗篷、疾闪 0.35/5s）　　　　　盗贼 　7.1%
           *     · 斗篷 5s ＋ 疾闪 0.5/6s　　　　　　　　盗贼 50.0%
           *     · 斗篷 5s ＋ 疾闪 0.35/6s　　　　　　　 盗贼 42.9%
           *     · 斗篷 4s ＋ 疾闪 0.35/6s（**本条**）　 盗贼 42.9%
           *   两条结论：疾闪那一档单独值 +7.1pp（已按上面的理由撤回）；
           *   **斗篷本身值 +35.8pp**，且 5→4 秒在这个粒度下读不出差别 ——
           *   也就是说 4 秒并没有把这个键削弱到无关紧要，只是把它拉回房规。
           *
           * ⚠️⚠️ +35.8pp 超出本轮 ±15pp 的回调线，**如实登记而不是抹平**：
           *   基线里的 7.1% 是一个**有据可查的 bot 残疾**，不是盗贼的真实强度 ——
           *   见本文件割裂技能上方那段注释（bot 至今不会用连击点终结技，
           *   `botController.ts` 的 `totalDamageOf` 写着为什么）。
           *   把一个残废盗贼从 7.1% 抬到 42.9%（同时全局极差 88.1→71.4pp）
           *   是这一轮想要的方向，不是需要压回去的暴涨。
           *   真要继续往下削就得削到 4 秒以下 —— 那会同时低于本仓库的免疫档
           *   （4 秒）和正式服口径（5 秒），两头都不占理。
           */
          duration: 4,
          // 披风不是魔法增益，敌方驱散魔法剥不掉（与疾跑、割裂同一条理由）
          dispelType: DispelType.None,
          clearableByTrinket: false,
          flags: { immuneMagic: true },
          description: '免疫魔法伤害。物理伤害不受影响。',
        },
      },
    ],
    description: '抖开暗影披风，立即清除身上的魔法减益，并在 4 秒内免疫魔法伤害。物理伤害照常生效。',
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
    // M14b：0.25→0.4 —— 当年的 100% 胜率其实是「潜行永不解除」bug 的产物（对手全程打不到他），
    //   0.25 是按着 bug 校准的过度矫正；bug 修掉后盗贼 DPS 全场最低（28~30），白字抬回一部分
    swingPercent: 0.45,
    reach: RANGE.DAGGER,
    // P7 暴击轴：+10% 暴击是刺客的本命 —— 快刀单发轻，暴击找补「一击的重量」
    modifiers: { resourceGain: 1.15, critChance: 0.1 },
    advantage: '背后爆发最高，能量循环快，暴击 +10%',
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
    // M14b：0.32→0.56 —— 随匕首档同抬（见上），保持「单击更高、攻速更慢」的相对关系
    swingPercent: 0.56,
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
    // M14b：6→10 —— 潜行 bug 修复后全场竞速加快（场均 9~25s），6/s 下背袭（40 耗）
    //   靠回复 6.7 秒一刀，盗贼在短局里能量饥荒（DPS 28 全场最低）。对齐德鲁伊能量档
    { resource: Resource.Energy, max: 100, start: 100, regenPerSecond: 10 },
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
