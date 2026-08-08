/**
 * 死亡骑士 —— 设计文档 9.3
 * 定位：拉拽、减速、反法术与持续压制。生命 1200，资源符文 + 符文能量。
 *
 * 结构完全对齐 packages/shared/src/data/classes/warrior.ts（范本）：
 * 一个技能一个对象、附录A#3 九项全填、counters 写人话。
 *
 * 数值来源：docs/source/design-spec-raw.txt 9.3 的技能表与武器方案表。
 * 文档没有给出的次要数值（伤害系数、资源消耗、光环细节）在下面逐条注释标注。
 */

import { RANGE } from '../../constants/combat.js';
import {
  CastKind,
  DispelType,
  Resource,
  School,
  TargetFilter,
  Targeting,
  isMagicSchool,
} from '../../types/enums.js';
import { asArmorId, asClassId, asSkillId, asWeaponId } from '../../types/ids.js';
import { makeArmorSet } from '../armors.js';
import type { ClassDef, SkillDef, WeaponDef } from '../schema.js';

const CLASS_ID = asClassId('deathknight');

/** 反魔法护罩「只吸收魔法伤害」的学派集合。★ 从 School 派生，加新学派不会漏 */
const MAGIC_SCHOOLS_DK: School[] = Object.values(School).filter(isMagicSchool);

/** 9.3 默认武器「双手符文剑」的触及距离，文档写 3.3 米，介于标准近战与延伸近战之间 */
const RUNEBLADE_REACH = 3.3;

// ── 技能 ─────────────────────────────────────────────────────────

const skills: SkillDef[] = [
  {
    id: asSkillId('deathknight.obliterate'),
    name: '碎骨斩',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: RUNEBLADE_REACH },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Physical,
    cooldown: 6,
    triggersGcd: true,
    requiresFacing: true,
    requiresLos: true,
    // 文档明确「消耗 2 枚符文」
    cost: { resource: Resource.Runes, amount: 2 },
    counters:
      '要求贴身并面向目标（6.5）；缴械后无法使用（7.3）；纯物理伤害会被减伤、护盾和物理免疫吃掉；一次吃掉 2 枚符文，符文回复约 3 秒一枚，被风筝时很难续上。',
    effects: [
      // M14：1.5→1.35 —— 死骑基线 66-74% 偏高，主要输出件回调一档
      { kind: 'damage', school: School.Physical, amount: { weaponPercent: 1.35 } },
      // 文档未给出符文能量产出，按 9.3「符文 + 符文能量」的资源循环补：重击产能，冰霜技能耗能
      { kind: 'gainResource', resource: Resource.RunicPower, amount: 15 },
    ],
    description: '造成 135% 武器伤害，消耗 2 枚符文并获得 15 点符文能量。',
  },
  {
    id: asSkillId('deathknight.death_strike'),
    name: '汲血斩',
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
    // 文档未标注消耗，按符文体系补 1 枚
    cost: { resource: Resource.Runes, amount: 1 },
    counters:
      '必须打到目标才有治疗，被缴械、失去目标或超距就完全落空；治疗量取决于「近期承受伤害」，被风筝或没挨打时几乎不回血；治疗有上限，且受 8.5 战斗抑制和降低治疗减益（如致死创伤）压制。',
    effects: [
      { kind: 'damage', school: School.Physical, amount: { weaponPercent: 1.0 } },
      // 文档只写「根据近期承受伤害恢复生命，治疗有上限」，具体窗口与系数为本实现取值
      {
        kind: 'healFromRecentDamage',
        percentOfDamageTaken: 0.25,
        window: 5,
        maxPercentOfMaxHealth: 0.1,
      },
      { kind: 'gainResource', resource: Resource.RunicPower, amount: 10 },
    ],
    description:
      '造成 100% 武器伤害，并根据 5 秒内承受伤害的 25% 恢复生命，最多恢复最大生命的 10%。',
  },
  {
    id: asSkillId('deathknight.death_grip'),
    name: '缚魂拽',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: 20 },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Shadow,
    cooldown: 25,
    triggersGcd: true,
    requiresLos: true,
    counters:
      '不能穿墙、跨越巨大高差或把目标拉入非法区域，路径不合法时拉拽直接失败（6.4 / 13.5）；需要视线，柱子与门后即可躲开；属于魔法技能，沉默或暗影学派锁定期间不可用（7.2 / 7.3）；拉拽计入 8.2 击退/拉拽递减，短时间内连续使用效果衰减；完全免疫、法术免疫可以无视。',
    effects: [
      // 拉到约 3 米处；落点合法性由 sim 层按 13.5 判定，不合法则整个效果不生效
      { kind: 'pullTarget', toDistance: 3 },
    ],
    description: '把目标拉到自己身前约 3 米处。无法穿墙或跨越巨大高差。',
  },
  {
    id: asSkillId('deathknight.chains_of_ice'),
    name: '寒缚链',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: RANGE.RANGED },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Frost,
    cooldown: 12,
    triggersGcd: true,
    requiresLos: true,
    // 文档未标注消耗，作为符文能量的主要消耗口
    cost: { resource: Resource.RunicPower, amount: 30 },
    counters:
      '普通减速不能被「战斗意志」解除（8.3），但属于移动限制，可被自由祝福、驱散移动限制类效果或免疫新减速的状态摆脱；减速随时间衰减，拖过 4 秒就基本失效；受减速叠加规则限制，不与其他减速叠乘；魔法技能，沉默与冰霜学派锁定期间不可用。',
    effects: [
      {
        kind: 'applyAura',
        aura: {
          id: 'deathknight.chains_of_ice',
          name: '寒缚链',
          kind: 'debuff',
          duration: 4,
          dispelType: DispelType.Movement,
          clearableByTrinket: false,
          // 初始值（减速 60% → moveSpeed 0.4）。衰减由下面的 decay 表达
          modifiers: { moveSpeed: 0.4 },
          /**
           * M11：原本是一条 `custom` handler（`decayAuraModifier`）。
           * ★ 但那个 handler **从来没有被注册过** —— 它落在 `displacement.ts`
           *   的 custom 兜底分支里，只发一条事件、不产生任何效果。
           *   也就是说「减速逐渐恢复」这条规则写在数据里、写在描述里，
           *   但**四个阶段以来一次都没有生效过**：减速全程是恒定的 60%。
           *   schema v1.1 的 `AuraDef.decay` 已经能表达它，sim 也实现了
           *   （`aura.ts` 的 `withDecay()`），所以这里改成纯数据。
           */
          decay: { field: 'moveSpeed', from: 0.4, to: 1.0, duration: 4 },
          description: '移动速度降低 60%，并在 4 秒内逐渐恢复。',
        },
      },
    ],
    description: '使目标移动速度降低 60%，减速在 4 秒内逐渐衰减至消失。',
  },
  {
    id: asSkillId('deathknight.strangulate'),
    name: '扼喉',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: 20 },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Shadow,
    cooldown: 30,
    triggersGcd: true,
    requiresLos: true,
    counters:
      '受昏迷递减，15 秒内连续昏迷 100%→50%→25%→免疫（8.2）；可被「战斗意志」解除（8.3）；抗控型护甲缩短持续时间；需要视线，墙后无法起手；魔法技能，沉默或暗影学派锁定期间不可用；完全免疫与法术免疫直接无效。',
    effects: [{ kind: 'stun', duration: 2 }],
    description: '扼住目标咽喉，使其昏迷 2 秒。',
  },
  {
    id: asSkillId('deathknight.mind_freeze'),
    name: '冻念',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: 15 },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Frost,
    cooldown: 15,
    // 7.2 专用打断不触发公共冷却，便于在进攻技能之间穿插
    triggersGcd: false,
    requiresLos: true,
    counters:
      '目标未在施法、或施法带盾牌标记（不可打断）时仍会进入冷却（7.2）；假读条可以骗掉（7.5）；打断物理射击准备条只取消本次射击，不产生学派锁定；本身是冰霜魔法，被沉默或冰霜学派锁定时无法使用（7.3）；需要视线且射程只有 15 米。',
    effects: [{ kind: 'interrupt', schoolLockSeconds: 3 }],
    description: '打断法术、引导或射击准备，并封锁该系魔法技能 3 秒。不触发公共冷却。',
  },
  {
    id: asSkillId('deathknight.anti_magic_shell'),
    name: '抗咒护罩',
    classId: CLASS_ID,
    targeting: Targeting.Self,
    targetFilter: TargetFilter.Self,
    range: { min: 0, max: 0 },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Shadow,
    cooldown: 30,
    triggersGcd: true,
    counters:
      '只吸收魔法伤害，对物理输出完全无效；只免疫**新的**魔法控制，护罩之前已经生效的控制不会被解除（8.4）；吸收量有限，集火可以在 4 秒内打破护盾；持续只有 4 秒，等它过去是最简单的应对。',
    effects: [
      {
        kind: 'applyAura',
        target: 'self',
        aura: {
          id: 'deathknight.anti_magic_shell',
          name: '抗咒护罩',
          kind: 'buff',
          duration: 4,
          dispelType: DispelType.None,
          flags: { immuneMagicControl: true },
          /**
           * 文档要求「吸收相当于 25% 最大生命的**魔法**伤害」。
           *
           * ★ M11：这里原本写死 `absorb: 300`（按 1200 基础生命算），并注明
           *   两个 schema 缺口。**两个缺口早已被 v1.1 填上且 sim 已实现**
           *   （`aura.ts` 换算 absorbPercentMaxHealth、按 absorbSchools 过滤），
           *   只是数据一直没跟上 —— 于是护罩既不随最大生命变化，
           *   也会**照单全收物理伤害**，而技能描述写的是「魔法伤害」。
           */
          absorbPercentMaxHealth: 0.25,
          absorbSchools: MAGIC_SCHOOLS_DK,
          description: '吸收 300 点（25% 最大生命）魔法伤害，并免疫新的魔法控制。',
        },
      },
    ],
    description: '4 秒内吸收相当于 25% 最大生命的魔法伤害，并免疫新的魔法控制。',
  },
  {
    id: asSkillId('deathknight.deaths_advance'),
    name: '疾行步',
    classId: CLASS_ID,
    targeting: Targeting.Self,
    targetFilter: TargetFilter.Self,
    range: { min: 0, max: 0 },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Shadow,
    cooldown: 40,
    triggersGcd: true,
    counters:
      '只保底移动速度，不解除也不免疫定身与昏迷，被定身或控制住依然动不了（8.3 通用解控才管定身）；不提供任何减伤；击退距离只降低 50%，强度足够的击退仍能把人打飞并中断读条（7.3）；40 秒冷却，逼出来之后有很长空窗。',
    effects: [
      {
        kind: 'applyAura',
        target: 'self',
        aura: {
          id: 'deathknight.deaths_advance',
          name: '疾行步',
          kind: 'buff',
          duration: 6,
          dispelType: DispelType.None,
          /**
           * M11：`moveSpeedFloor` 原本是一条 `custom`（`applyMoveSpeedFloor`）——
           * 同样从未注册，于是「速度不低于基础的 80%」一直没生效：
           * 死亡脚步期间照样能被减速到全局下限 20%。
           * schema v1.1 的 `moveSpeedFloor` 已实现（`modifiers.ts` 按 Math.max 聚合）。
           */
          modifiers: { knockbackTaken: 0.5, moveSpeedFloor: 0.8 },
          description: '移动速度不低于基础速度的 80%，受到的击退距离降低 50%。',
        },
      },
    ],
    description: '6 秒内移动速度不低于基础速度的 80%，受到的击退距离降低 50%。',
  },
  {
    id: asSkillId('deathknight.winter_domain'),
    name: '凛冬领域',
    classId: CLASS_ID,
    targeting: Targeting.SelfCenter,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: 6 },
    shape: { kind: 'circle', radius: 6 },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Frost,
    cooldown: 60,
    triggersGcd: true,
    // 文档未标注消耗，作为符文能量的爆发出口
    cost: { resource: Resource.RunicPower, amount: 40 },
    counters:
      '区域固定在释放位置，跑出 6 米即可完全躲开，也不会穿过封闭房间的完整墙体（6.4）；昏迷需要累计 4 次命中，中途离开就不会触发；触发的昏迷计入 8.2 昏迷递减，可被「战斗意志」解除；减速属于移动限制，可被自由祝福等免疫或驱散；魔法伤害会被反魔法护罩、法术免疫和吸收护盾抵消。',
    effects: [
      {
        kind: 'spawnGroundArea',
        areaId: 'deathknight.winter_domain',
        radius: 6,
        duration: 6,
        tickInterval: 1,
        onTick: [
          // 文档只写「持续造成寒冰伤害与减速」，具体数值为本实现取值
          { kind: 'damage', school: School.Frost, amount: { flat: 45 } },
          {
            kind: 'applyAura',
            target: 'allInShape',
            aura: {
              id: 'deathknight.winter_domain_chill',
              name: '凛冬彻骨',
              kind: 'debuff',
              duration: 2,
              dispelType: DispelType.Movement,
              clearableByTrinket: false,
              modifiers: { moveSpeed: 0.7 },
              description: '移动速度降低 30%。',
            },
          },
          // 每名目标各自累计，第 4 次命中时昏迷 1.5 秒
          { kind: 'onNthHit', count: 4, effects: [{ kind: 'stun', duration: 1.5 }] },
        ],
      },
    ],
    description:
      '以自身为中心展开半径 6 米的凛冬领域，持续 6 秒，每秒造成寒冰伤害并减速；同一目标被命中 4 次后昏迷 1.5 秒。',
  },
  // 武器方案授予的技能
  {
    id: asSkillId('deathknight.frost_strike_fast'),
    name: '快速冰霜打击',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: RANGE.MELEE },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Frost,
    cooldown: 4,
    triggersGcd: true,
    requiresFacing: true,
    requiresLos: true,
    // 文档只写「获得快速冰霜打击」，冷却与数值为本实现取值
    cost: { resource: Resource.RunicPower, amount: 20 },
    counters:
      '仅双持符文刃方案可用；要求贴身并面向目标；虽是武器技能但结算冰霜魔法伤害，会被反魔法护罩、法术免疫和吸收吃掉，同时缴械和冰霜学派锁定都能封住它（7.3）。',
    // M14：0.9→0.8 —— 同轮回调（符文能量出口）
    effects: [{ kind: 'damage', school: School.Frost, amount: { weaponPercent: 0.8 } }],
    description: '一次迅捷的符文刃斩击，造成 80% 武器伤害的冰霜伤害。仅双持符文刃方案可用。',
  },
  {
    id: asSkillId('deathknight.rune_ward'),
    name: '符文守护',
    classId: CLASS_ID,
    targeting: Targeting.Self,
    targetFilter: TargetFilter.Self,
    range: { min: 0, max: 0 },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Shadow,
    cooldown: 25,
    triggersGcd: true,
    // 文档只写「获得符文守护」，冷却与数值为本实现取值
    counters:
      '仅符文剑 + 骨盾方案可用，而该方案本身输出偏低；只是减伤和小额吸收，不是免疫，控制链与持续伤害照常生效；持续 6 秒，等过期即可。',
    effects: [
      {
        kind: 'applyAura',
        target: 'self',
        aura: {
          id: 'deathknight.rune_ward',
          name: '符文守护',
          kind: 'buff',
          duration: 6,
          dispelType: DispelType.None,
          modifiers: { damageTaken: 0.8 },
          absorb: 120,
          description: '受到伤害降低 20%，并吸收 120 点伤害。',
        },
      },
    ],
    description: '骨盾上的符文亮起，6 秒内受到伤害降低 20% 并吸收 120 点伤害。仅骨盾方案可用。',
  },

  /**
   * ★ P3b 扩充：死骑补「持续伤害 / 反治疗 / 群体减速」。
   *
   *   审计里死骑几乎全是单体瞬发点伤，缺**压制手段**。
   *   补的三条都不提高爆发上限：疫病是慢性伤害，
   *   凋零缠绕是治疗压制，冰霜之环是控场 —— 分别对应
   *   9.x「持续压制、反治疗、限制走位」的定位。
   */
  {
    id: asSkillId('deathknight.plague_strike'),
    name: '暗影疫病',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: RANGE.MELEE },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Shadow,
    cooldown: 0,
    triggersGcd: true,
    requiresFacing: true,
    requiresLos: true,
    cost: { resource: Resource.RunicPower, amount: 20 },
    counters:
      '疾病类减益，**牧师、圣骑士、德鲁伊都能驱掉**，对手带治疗时它是最先被清的一个；15 秒里分 5 跳给出，对爆发秒杀零贡献；要贴脸且面向，缴械期间不可用。',
    effects: [
      { kind: 'damage', school: School.Shadow, amount: { weaponPercent: 0.5 } },
      {
        kind: 'applyAura',
        aura: {
          id: 'deathknight.plague_strike.disease',
          name: '暗影疫病',
          description: '被疫病侵蚀，每 3 秒受到暗影伤害。',
          kind: 'debuff',
          duration: 15,
          dispelType: DispelType.Disease,
          periodic: {
            interval: 3,
            effects: [{ kind: 'damage', school: School.Shadow, amount: { flat: 38 } }],
          },
        },
      },
    ],
    description: '以疫病侵蚀目标，立即造成伤害并在 15 秒内持续掉血。可被驱散疾病解除。',
  },
  {
    id: asSkillId('deathknight.necrotic_strike'),
    name: '凋零缠绕',
    classId: CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: RANGE.MELEE },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Shadow,
    cooldown: 15,
    triggersGcd: true,
    requiresFacing: true,
    requiresLos: true,
    cost: { resource: Resource.RunicPower, amount: 30 },
    counters:
      '**本身伤害很低** —— 它的价值全在那个「受到治疗降低 50%」的减益上，对手没有治疗时几乎是空按一下；魔法减益，驱散魔法可解；8 秒窗口要队友同时跟上输出才兑现，单打独斗时收益有限。',
    effects: [
      { kind: 'damage', school: School.Shadow, amount: { weaponPercent: 0.6 } },
      {
        kind: 'applyAura',
        aura: {
          id: 'deathknight.necrotic_strike.wound',
          name: '凋零缠绕',
          description: '受到的治疗降低 50%。',
          kind: 'debuff',
          duration: 8,
          dispelType: DispelType.Magic,
          modifiers: { healingTaken: 0.5 },
        },
      },
    ],
    description: '腐蚀目标的伤口，8 秒内其受到的治疗降低 50%。开团前先手切掉对方奶量。',
  },
  {
    id: asSkillId('deathknight.howling_blast'),
    name: '凛冬号叫',
    classId: CLASS_ID,
    targeting: Targeting.SelfCenter,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: 10 },
    shape: { kind: 'circle', radius: 10, maxTargets: 5 },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Frost,
    cooldown: 8,
    triggersGcd: true,
    cost: { resource: Resource.RunicPower, amount: 25 },
    counters:
      '以自身为中心 10 米，**远程职业站在圈外完全不受影响** —— 想覆盖到他们就得先贴上去；单体伤害低于寒冰打击，只在多人重叠时划算；减速不叠乘（与寒冰锁链取最强的一个），自由祝福、消失、逃脱等驱散移动限制的手段都能摆脱。',
    effects: [
      { kind: 'damage', school: School.Frost, amount: { flat: 105 } },
      {
        kind: 'applyAura',
        target: 'allInShape',
        aura: {
          id: 'deathknight.howling_blast.chill',
          name: '凛冬',
          description: '移动速度降低 40%。',
          kind: 'debuff',
          duration: 5,
          // 与本职业的寒冰锁链同类：死骑的减速统一归 Movement，
          // 让「驱散移动限制」这一手对死骑始终有效（法师的霜系减速走 Magic，
          // 两边各自内部一致，玩家的心智模型才不会错乱）
          dispelType: DispelType.Movement,
          modifiers: { moveSpeed: 0.6 },
        },
      },
    ],
    description: '掀起一阵刺骨寒风，对 10 米内最多 5 名敌人造成冰霜伤害并减速 40%，持续 5 秒。',
  },

  /**
   * ★★ P11 保命轮：死骑补**冰封坚韧** —— 抗咒护罩只挡魔法，物理侧是全空的。
   *
   *   审计口径「按下后能扛住 3 秒集火」在死骑身上此前只有半张牌：
   *     · 抗咒护罩 —— 25% 最大生命的吸收，但 `absorbSchools` 只收魔法学派，
   *       对面是战士/盗贼/猎人时**一点都不吸**；
   *     · 符文守护 —— 20% 减伤 + 120 吸收，然而它是**骨盾方案专属**，
   *       默认的双手符文剑与双持符文刃两档一个都摸不到；
   *   于是默认武器的死骑面对物理集火时，手上一个减伤键都没有。
   *   1200 血是全场最高，但「血多」不等于「有应对」—— 集火三秒照样躺。
   *
   * ★ 量级依据（WoW 冰封之韧：30% 减伤 + 免疫昏迷 / 8 秒 / CD 180）：
   *   CD 按疾跑那次的口径落到 **120**（竞技场一回合最多一次）。
   *   减伤取 **50%** 而不是正式服的 30%：那 30% 的另一半价值在「免疫昏迷」，
   *   而本仓库的 `AuraFlags` 没有「免疫昏迷」这一档 —— 有的是 immuneAll
   *   （完全免疫，量级过头）、immuneMagicControl（护罩已占）、
   *   immuneMovementImpair（只管减速定身）。**不新加 flag**：本仓库反复
   *   吃过「schema 加了字段、结算侧没人读、规则静默失效」的亏（寒缚链的
   *   decay、疾行步的 moveSpeedFloor、盗贼潜行的脱战限制，三次）。
   *   把控制免疫那半张牌折算进减伤数值，是**能立刻兑现**的表达。
   *   代价如实写进 counters：它真的不免疫昏迷。
   *
   * ★ 持续 5 秒（短于战士盾墙的 8 秒）：死骑有 1200 血（全场最高）+ 汲血斩
   *   自愈 + 抗咒护罩，生存底盘本就厚；再给 8 秒会把 9.x 的「攻击节奏偏重、
   *   依赖近身」变成没有代价的强项。
   */
  {
    id: asSkillId('deathknight.icebound_fortitude'),
    name: '冰封坚韧',
    classId: CLASS_ID,
    targeting: Targeting.Self,
    targetFilter: TargetFilter.Self,
    range: { min: 0, max: 0 },
    shape: { kind: 'single' },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Frost,
    cooldown: 120,
    triggersGcd: true,
    // 8.3：被控住却开不了减伤等于没有这个键
    usableWhileStunned: true,
    // 保命键刻意不收符文能量：符文能量靠重击产出，开场被秒时它恰好是 0
    counters:
      '**不免疫控制** —— 与正式服不同，这里的冰封坚韧不免疫昏迷：扼喉链、裁决之锤、昏击照常把死骑按住，减伤只是让他死得慢一点；只有 5 秒（比战士盾墙短 3 秒），对手拉开等它过期即可；**120 秒冷却比竞技场单回合上限（90 秒）还长**，一回合只有一次；冰霜魔法技能，**沉默或冰霜学派锁定期间用不出来**（7.3）—— 法师一发断法锁冰霜 4 秒就能把它连同寒缚链、凛冬号叫一起封死，这是它与抗咒护罩（暗影系）分属两系的意义，也是它自己的破绽；不可驱散，但也洗不掉身上已有的减益。',
    effects: [
      {
        kind: 'applyAura',
        target: 'self',
        aura: {
          id: 'deathknight.icebound_fortitude',
          name: '冰封坚韧',
          kind: 'buff',
          duration: 5,
          dispelType: DispelType.None,
          clearableByTrinket: false,
          modifiers: { damageTaken: 0.5 },
          description: '受到的伤害降低 50%。',
        },
      },
    ],
    description: '以寒冰包裹自身，5 秒内受到的伤害降低 50%。可在昏迷中使用，一回合只有一次。',
  },
];

// ── 武器方案（附录A#4：职业、攻击间隔、距离、优势、代价、改变的技能）──
// 数值严格照抄 9.3「死亡骑士武器方案」表格。

const weapons: WeaponDef[] = [
  {
    id: asWeaponId('deathknight.runeblade_2h'),
    name: '双手符文剑',
    classId: CLASS_ID,
    isDefault: true,
    handedness: 'twoHand',
    swingInterval: 2.3,
    swingPercent: 1.4,
    reach: RUNEBLADE_REACH,
    advantage: '重击和爆发高',
    cost: '攻速慢',
    removesSkills: [asSkillId('deathknight.frost_strike_fast'), asSkillId('deathknight.rune_ward')],
    skillModifiers: { 'deathknight.obliterate': { damageMultiplier: 1.15 } },
    model: 'runeblade_2h',
  },
  {
    id: asWeaponId('deathknight.dual_runeblades'),
    name: '双持符文刃',
    classId: CLASS_ID,
    isDefault: false,
    handedness: 'dualWield',
    swingInterval: 0.8,
    // M14：0.55→0.48 —— 与双手档协调（白字 60/s ≈ 双手 61/s，优势让给「获得快速冰霜打击」）
    swingPercent: 0.48,
    reach: RANGE.MELEE,
    modifiers: { resourceGain: 1.2, damageTaken: 1.05 },
    advantage: '符文能量获取 +20%，持续压制',
    cost: '单击低，防御 -5%',
    grantsSkills: [asSkillId('deathknight.frost_strike_fast')],
    removesSkills: [asSkillId('deathknight.rune_ward')],
    model: 'dual_runeblades',
  },
  {
    id: asWeaponId('deathknight.runeblade_boneshield'),
    name: '符文剑 + 骨盾',
    classId: CLASS_ID,
    isDefault: false,
    handedness: 'oneHand',
    swingInterval: 1.8,
    swingPercent: 0.85,
    reach: RANGE.MELEE,
    /**
     * ★ M11：原注释说「等 schema 增加按学派拆分的 damageTaken 后再拆开」——
     *   `damageTakenBySchool` 早已进 v1.1 且 `modifiers.ts` 已实现，数据没跟上。
     *   现在把「法术抗性提高」真的拆出来：物理减伤 0.9，魔法额外再减到 0.85。
     */
    modifiers: {
      damageTaken: 0.9,
      damageTakenBySchool: MAGIC_SCHOOLS_DK.reduce<Partial<Record<School, number>>>(
        (acc, s) => ((acc[s] = 0.85), acc), {},
      ),
      block: 0.15, moveSpeed: 0.95, damageDealt: 0.9,
    },
    advantage: '防御 +15%，法术抗性提高',
    cost: '移动 -5%，输出低',
    grantsSkills: [asSkillId('deathknight.rune_ward')],
    removesSkills: [asSkillId('deathknight.frost_strike_fast')],
    // 「重击降低」：湮灭伤害下调
    skillModifiers: { 'deathknight.obliterate': { damageMultiplier: 0.85 } },
    model: 'runeblade_boneshield',
  },
];

export const deathknight: ClassDef = {
  id: CLASS_ID,
  name: '死亡骑士',
  role: '拉拽、减速、反法术与持续压制',
  baseHealth: 1200,
  resources: [
    // 符文：开局满 6 枚，约 3 秒回复 1 枚
    { resource: Resource.Runes, max: 6, start: 6, regenPerSecond: 0.33 },
    // 符文能量：不自然回复，靠消耗符文的重击产出
    { resource: Resource.RunicPower, max: 100, start: 0, regenPerSecond: 0 },
  ],
  strengths: '抗控制、拉回目标、对法系压制',
  weaknesses: '基础机动一般、攻击节奏偏重、依赖近身',
  defaultWeaponId: asWeaponId('deathknight.runeblade_2h'),
  defaultArmorId: asArmorId('deathknight.default'),
  skills,
  weapons,
  armors: makeArmorSet(CLASS_ID, { defaultName: '符文板甲' }),
  autoAttack: { ranged: false, school: School.Physical },
};
