/**
 * 大乱斗「派对道具」内容包 —— 夸张武装与新奇消耗品。
 *
 * ★★ **这些东西不属于任何职业池，只从大乱斗（FFA）的地面掉落获得。**
 *   八职业的 `weapons` / `armors` 一件都没有动 —— 10.2 的职业归属、
 *   10.6 的「恰好一件默认武器」、验收 #31 的武器取舍全部照旧成立。
 *   本文件是**并排的第二个注册表**，与 `consumables.ts` 的分层理由一致：
 *   「场地上捡到的通用道具，不是职业方案的一部分」。
 *
 * ★ id 一律以 `ffa.` 开头。这个前缀是**规则判据**，不只是命名习惯：
 *   · `sim/loadout.ts` 据此对派对武装**放开职业匹配**（人人可捡）
 *   · `sim/arsenal.ts` 的派对掉落调度只从这两张表里选货
 *   · `validateData()` 据此把它们与职业池分开体检
 *   判据集中在 `isPartyItemId()` 一处，别处不许再写一遍 `startsWith('ffa.')`。
 *
 * ★★ **数值全部是占位值**（与 `consumables.ts` 头注、各职业的 `flat:` 同一状态，
 *   见 PROGRESS.md 技术债 §2）。配平口径写在每件东西旁边，因为这批东西的
 *   设计目标不是「平衡」而是**「很厉害但不无解」**：
 *     · 高伤害一律配**长挥击间隔**或**明显前摇**（读条 / 落点倒计时 / 直线弹道）
 *     · 每件武装都带一条**真实代价**（移速、承伤、读条速度），不存在纯上位
 *     · 拿到的人成为全场焦点 —— 焦点意味着**所有人都来打他**，而不是他自动赢
 *
 * ★ 文案用「系」不用「学派」（P10 补丁的口径），面向玩家的字段
 *   （name / advantage / cost / counters / description）都按这条写。
 *
 * ★★ **只用引擎真的会执行的修正字段。**
 *   落地时逐个核过 `sim/modifiers.ts` 的下游：`maxHealth`、`knockbackTaken`、
 *   `castSpeed`、`attackSpeed`、`absorbDone` 这几个**只被聚合、没有任何消费方** ——
 *   写上去不会报错，只会让 `advantage` / `description` 变成一句谎话。
 *   本文件当时的选择是**绕开它们**，并由 `sim/party.test.ts` 的
 *   「不使用死修正字段」断言钉住这条纪律。
 *
 *   ✅ **W26（2026-08-11）：五个字段全部接线，这条限制已经解除。**
 *   下面几处标着「本来想写 X，但那个字段是死的」的降级注释因此都过期了 ——
 *   它们保留在原地是为了记住那次取舍，**但数值刻意没有跟着改回去**：
 *   现在的 `moveSpeed 0.88 + damageTaken 1.18`（巨杖）与
 *   `absorb + ccDurationTaken`（变大药水）是**已经调过一轮**的数字，
 *   换回 `castSpeed` / `maxHealth` 是一次配平改动，该单独一批、单独归因。
 */

import { RANGE } from '../constants/combat.js';
import {
  CastKind,
  DispelType,
  School,
  TargetFilter,
  Targeting,
} from '../types/enums.js';
import { asClassId, asConsumableId, asSkillId, asWeaponId } from '../types/ids.js';
import type { ConsumableDef, SkillDef, WeaponDef } from './schema.js';

/**
 * 派对道具的 id 前缀。
 *
 * ★ 同时也是它们的**伪职业 id**：`WeaponDef.classId` 是必填的，而这些武装
 *   不归任何职业。借一个真职业的 id 会让它在装备栏、掉落视图和
 *   「按 classId 找我的那件」里冒充成那个职业的东西 —— 那正是 10.2 要区分的。
 *   `getClass('ffa')` 查不到任何东西，所有显示路径都会回落到「人人可捡」。
 */
export const PARTY_NAMESPACE = 'ffa';
const PARTY_PREFIX = `${PARTY_NAMESPACE}.`;

/** 大乱斗派对道具的伪职业 id。**不是**一个可选职业，`ALL_CLASSES` 里没有它 */
export const PARTY_CLASS_ID = asClassId(PARTY_NAMESPACE);

/**
 * 是不是一件派对道具（武器 / 消耗品 / 它们授予的技能通用）。
 *
 * ★ 全仓库唯一的前缀判据。`loadout.ts` 的「人人可捡」、`arsenal.ts` 的
 *   掉落调度、`validateData()` 的分组体检都调它 —— 三处各写一遍
 *   `startsWith` 的话，将来改前缀会漏掉其中一处，而漏掉的那处**不会报错**，
 *   只会让某一类道具悄悄捡不起来。
 */
export const isPartyItemId = (id: string): boolean => id.startsWith(PARTY_PREFIX);

// ════════════════════════════════════════════════════════════════
//  夸张武装授予的技能
// ════════════════════════════════════════════════════════════════

/**
 * ★ 这些技能**只在手持对应武装时可用**（附录A#4 的 grants 通道，
 *   与「双手巨剑才有顺劈」是同一个机制）。武器一换就消失，死亡收缴装备
 *   时也跟着消失 —— 不需要为它们单开一套生命周期。
 *
 * ★ `classId` 填伪职业 `ffa`。规则层不读技能的 classId（`validateCast` 只看
 *   `availableSkills`），它在这里的作用是 HUD 分组与图标目录名。
 */
const partySkills: SkillDef[] = [
  {
    id: asSkillId('ffa.mountain_smash'),
    name: '山崩一击',
    classId: PARTY_CLASS_ID,
    // 自身中心：抡圆了砸在自己脚下，不需要选目标 —— 混战里选目标本身就是负担
    targeting: Targeting.SelfCenter,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: 8 },
    // 占位值：半径 8 米、最多 6 人 —— 大乱斗一团人的典型直径
    shape: { kind: 'circle', radius: 8, maxTargets: 6 },
    /**
     * ★★ **1.2 秒前摇是这件武器的全部平衡点。**
     *   抡起大锤的这段时间里，全场都看得见他要砸哪儿：走开、打断、控住，
     *   三条路任选一条。把它改成瞬发就变成「捡到即三杀」。
     */
    cast: { kind: CastKind.Cast, time: 1.2, movable: false, interruptible: true },
    school: School.Physical,
    cooldown: 14,
    triggersGcd: true,
    counters: '1.2 秒抡锤前摇全场可见，走出 8 米、打断或任何硬控制都能让它落空；抡锤期间不能移动；巨锤本身挥击间隔 3.4 秒，砸空之后有很长一段几乎没有输出。',
    effects: [
      // 占位值：520 ≈ 半管血（八职业 900~1200）。一发不致死，两发才行 —— 中间隔着 14 秒冷却
      { kind: 'damage', school: School.Physical, amount: { flat: 520 } },
      // 占位值：击退 11 米 + 昏迷 1.2 秒。击退比伤害更像「派对手感」，也天然拉开身位
      { kind: 'knockback', distance: 11 },
      { kind: 'stun', duration: 1.2 },
    ],
    description: '抡起巨锤砸向地面，对周围 8 米内最多 6 名敌人造成巨额物理伤害，并将他们击飞、昏迷 1.2 秒。',
  },
  {
    id: asSkillId('ffa.starfall'),
    name: '星火倾泻',
    classId: PARTY_CLASS_ID,
    targeting: Targeting.Ground,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: 35 },
    // 占位值：半径 11 米 —— 比山崩一击更大，但换来 1.2 秒的落点倒计时
    shape: { kind: 'circle', radius: 11, maxTargets: 8 },
    cast: { kind: CastKind.Cast, time: 1.6, movable: false, interruptible: true },
    school: School.Arcane,
    cooldown: 18,
    triggersGcd: true,
    requiresLos: true,
    counters: '读条 1.6 秒可被打断并锁住奥术系；落点与倒计时全程可见（6.6），倒数期间走出圆圈即可完全躲开；持巨杖的人移动速度 -12%、受到的伤害 +18%，贴上去打就是了。',
    effects: [
      {
        kind: 'delayedGroundImpact',
        // 占位值：1.2 秒倒计时 —— 够走出 11 米（基础速度 7 米/秒）但不够悠闲
        delay: 1.2,
        radius: 11,
        onImpact: [
          // 占位值：430 ≈ 法师陨石（420）量级，换来的是更大的圈和更长的冷却
          { kind: 'damage', school: School.Arcane, amount: { flat: 430 } },
          {
            kind: 'applyAura',
            aura: {
              id: 'ffa.stardust',
              name: '星尘',
              kind: 'debuff',
              duration: 4,
              dispelType: DispelType.Magic,
              school: School.Arcane,
              clearableByTrinket: false,
              modifiers: { moveSpeed: 0.7 },
              description: '移动速度降低 30%。',
            },
          },
        ],
      },
    ],
    description: '在指定地面召来一片星火。1.2 秒后落下，对范围内敌人造成巨额奥术伤害并减速 30%。',
  },
  {
    id: asSkillId('ffa.drumstick_volley'),
    name: '香喷喷弹射鸡腿',
    classId: PARTY_CLASS_ID,
    /**
     * ★★ **必须是自身中心，不能是直接目标。**
     *   `castResolve.resolveCastTargets()` 对 `Targeting.Direct` 只返回
     *   **锁定的那一个目标**，形状根本不参与 —— 写成 Direct + chain 的话
     *   连锁形状会被完全忽略，鸡腿只砸中一个人，而且**不报任何错**。
     *   连锁只在 `usesNoTarget()` 那条分支里生效（自身中心 / 方向技能）。
     * ★ 于是它的射程读作「你得先靠近人堆」——`jumpRange` 既是首跳距离
     *   也是跳与跳之间的距离，`range.max` 与它对齐，客户端画的圈就是真的圈
     *   （`shapeRadius('chain')` 返回的正是 jumpRange）。
     */
    targeting: Targeting.SelfCenter,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: 12 },
    // ★ 连锁形状：鸡腿在人堆里弹来弹去。12 米跳跃距离 = 站散就断链
    shape: { kind: 'chain', jumpRange: 12, maxTargets: 5, falloff: 0.75 },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Physical,
    cooldown: 10,
    triggersGcd: true,
    counters: '首跳与每一跳都要求「下一个人在 12 米内」，散开站位直接断链；它把持弓的人逼进人堆 —— 而那把弓的代价正是受到的伤害 +15%；单发伤害很低，价值全在人堆里；缴械后无法使用（武器技能）；油腻减速属于移动限制，自由庇佑、逃脱、消失都能摆脱。',
    effects: [
      // 占位值：单跳 150，弹满 5 人 ≈ 750 总伤 —— 但要求五个人挤在一起
      { kind: 'damage', school: School.Physical, amount: { flat: 150 } },
      {
        kind: 'applyAura',
        aura: {
          id: 'ffa.greasy',
          name: '油腻',
          kind: 'debuff',
          duration: 4,
          dispelType: DispelType.Movement,
          clearableByTrinket: false,
          // 占位值：-25%。功能上是「让人堆继续挤在一起」，好让下一发接得上
          modifiers: { moveSpeed: 0.75 },
          description: '一身油光，移动速度降低 25%。',
        },
      },
    ],
    description: '把一只烤鸡腿甩进人堆，在 12 米内的敌人之间连续弹射最多 5 次，每次造成物理伤害并让对方一身油腻、减速 25%。',
  },
  {
    id: asSkillId('ffa.boomerang_throw'),
    name: '飞去来斧',
    classId: PARTY_CLASS_ID,
    // 碰撞型投射物：沿角色面向真实飞行，横向让开两步就能躲（6.6）
    targeting: Targeting.Projectile,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: 24 },
    // ★ 形状与飞行距离对齐（猎人穿透弩箭的先例）：客户端画的预览线就是真轨迹
    shape: { kind: 'line', length: 24, width: 2.2 },
    cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    school: School.Physical,
    cooldown: 16,
    triggersGcd: true,
    counters: '沿角色面向直线飞行，横向走两步即可让开；把人勾回来的同时也把**一群人**勾到自己脸上，接不住就是自杀；持斧时受到的治疗降低 10%。',
    effects: [
      {
        kind: 'spawnProjectile',
        speed: 26,
        radius: 1.1,
        // ★ 穿透：一路上的人全被勾回来。这就是「回旋」的派对读法
        pierce: true,
        onHit: [
          // 占位值：210 —— 单发不高，价值在把四个人拽成一堆给队友（或大锤）收
          { kind: 'damage', school: School.Physical, amount: { flat: 210 } },
          { kind: 'pullTarget', toDistance: 3 },
        ],
      },
    ],
    description: '掷出会回旋的巨斧，穿透路径上的所有敌人，造成物理伤害并把他们统统拽到你面前。',
  },
];

export const PARTY_SKILLS: readonly SkillDef[] = partySkills;

// ════════════════════════════════════════════════════════════════
//  夸张武装（10.1 临时武装，只在大乱斗掉落）
// ════════════════════════════════════════════════════════════════

/**
 * ★ 四件都**不是**任何职业的默认武器（`isDefault: false`），也不在任何
 *   `ClassDef.weapons` 里 —— 10.6 的「每个职业恰好一件默认武器」不受影响。
 * ★ `renderScale` 是「和玩家一样大」的落点：2.6 倍的锤子高度约等于角色身高，
 *   但**碰撞体与触及距离一个字节都没变**（验收 #10，见 schema 那段注释）。
 */
const partyWeapons: WeaponDef[] = [
  {
    id: asWeaponId('ffa.colossus_hammer'),
    name: '山崩巨锤',
    classId: PARTY_CLASS_ID,
    isDefault: false,
    handedness: 'twoHand',
    // 占位值：3.4 秒一挥 —— 全场最慢。慢到「抡空一次就够对手打完一套」
    swingInterval: 3.4,
    // 占位值：3.2 倍武器伤害。单击最高，但每 3.4 秒才有一次
    swingPercent: 3.2,
    reach: RANGE.MELEE_EXTENDED,
    modifiers: {
      // 代价：扛着一座山跑不快，也躲不开
      moveSpeed: 0.85,
      damageTaken: 1.12,
    },
    advantage: '单击伤害全场最高，附带范围击飞与昏迷的「山崩一击」',
    cost: '挥击间隔 3.4 秒（全场最慢），移动速度 -15%，受到的伤害 +12%',
    grantsSkills: [asSkillId('ffa.mountain_smash')],
    model: 'colossus_hammer',
    // 视觉：锤头与角色等高。★ 只影响外观（验收 #10）
    renderScale: 2.6,
  },
  {
    id: asWeaponId('ffa.colossus_staff'),
    name: '天罚巨杖',
    classId: PARTY_CLASS_ID,
    isDefault: false,
    handedness: 'staff',
    swingInterval: 3.0,
    swingPercent: 1.9,
    reach: 32,
    isRanged: true,
    // 武器覆盖职业：拿着它的战士也在放远程奥术白字（与法刃/权杖同一条规则）
    autoAttack: { ranged: true, school: School.Arcane },
    modifiers: {
      /**
       * 代价：扛着一根比人还高的杖，走不快也躲不掉。
       * ⚠️ 这里**本来想写** `castSpeed: 1.2`（「读条 +20%」才是巨杖最贴切的
       *   代价），但那个字段当时在 sim 里没有消费方 ——
       *   写上去等于在 cost 文案里承诺一件不会发生的事。改用两个真生效的。
       * ✅ W26 已把 `castSpeed` 接进读条；换回去是配平改动，另立一批（见文件头）。
       */
      moveSpeed: 0.88,
      damageTaken: 1.18,
    },
    advantage: '32 米远程奥术白字，附带全场最大范围的「星火倾泻」',
    cost: '移动速度 -12%，受到的伤害 +18%，被贴脸时几乎没有还手之力',
    grantsSkills: [asSkillId('ffa.starfall')],
    model: 'colossus_staff',
    renderScale: 2.4,
  },
  {
    id: asWeaponId('ffa.drumstick_bow'),
    name: '弹射鸡腿弓',
    classId: PARTY_CLASS_ID,
    isDefault: false,
    handedness: 'ranged',
    swingInterval: 1.5,
    swingPercent: 0.7,
    reach: 30,
    isRanged: true,
    // 7.6：可以边走边射 —— 这把弓的身份是「灵活」，不是「高伤」
    canMoveWhileShooting: true,
    autoAttack: { ranged: true, school: School.Physical },
    modifiers: {
      moveSpeed: 1.08,
      // 代价：一身油、没有护甲
      damageTaken: 1.15,
    },
    advantage: '移动射击，移动速度 +8%，附带在人堆里连弹 5 次的鸡腿',
    cost: '单发伤害很低，受到的伤害 +15%',
    grantsSkills: [asSkillId('ffa.drumstick_volley')],
    model: 'drumstick_bow',
    renderScale: 1.6,
  },
  {
    id: asWeaponId('ffa.boomerang_axe'),
    name: '回旋巨斧',
    classId: PARTY_CLASS_ID,
    isDefault: false,
    handedness: 'oneHand',
    swingInterval: 1.9,
    swingPercent: 1.25,
    reach: RANGE.MELEE,
    modifiers: {
      // 占位值：暴击 +8% —— 与进攻型护甲的 +5% 同一预算量级
      critChance: 0.08,
      // 代价：拿着它没人给你治
      healingTaken: 0.9,
    },
    advantage: '暴击几率 +8%，附带把一整排敌人拽到面前的「飞去来斧」',
    cost: '受到的治疗降低 10%，拽回来的人也可能反过来把你打死',
    grantsSkills: [asSkillId('ffa.boomerang_throw')],
    model: 'boomerang_axe',
    renderScale: 1.9,
  },
];

export const PARTY_WEAPONS: readonly WeaponDef[] = partyWeapons;

// ════════════════════════════════════════════════════════════════
//  新奇消耗品
// ════════════════════════════════════════════════════════════════

/**
 * ★ 每一个都复用**已有**的效果 kind，只有变身药水例外 ——
 *   它引入了 `borrowClassKit`（理由与降级说明见 schema 那段注释）。
 *   加 kind 的判据是 11-contributing §4：「确实无法用现有 kind 表达」，
 *   而「把技能栏换成另一个职业的」在现有 34 个 kind 里一个都表达不了。
 *
 * ★ `cooldown` 全部为 0，与竞技场那三瓶（45~60 秒）刻意不同。
 *   竞技场的冷却是为了「一局只能开一次窗口」；大乱斗里道具是**消耗掉的**
 *   （用完槽位就空了），最多带 2 个、满地都在刷 —— 再压一层冷却只会让
 *   捡到的东西按不出来。节流已经由「携带上限 2 + 掉落频率」承担了。
 */
const partyConsumables: ConsumableDef[] = [
  {
    id: asConsumableId('ffa.identity_brew'),
    name: '乱斗变身药水',
    // 占位值：60 秒只是 16.2「增益期间击杀」的记账窗口 ——
    // 借来的技能栏本身**持续到死亡或回合结束**，不按秒过期（见 borrowClassKit）
    buffSeconds: 60,
    cooldown: 0,
    effects: [
      { kind: 'borrowClassKit' },
      {
        kind: 'applyAura',
        target: 'self',
        aura: {
          id: 'ffa.identity_brew',
          name: '身份错乱',
          kind: 'buff',
          duration: 60,
          dispelType: DispelType.None,
          clearableByTrinket: false,
          // 占位值：换了一套没练过的技能，先给一点点适应期的容错
          modifiers: { damageTaken: 0.95 },
          description: '你正顶着别人的本事打架，受到的伤害降低 5%。',
        },
      },
    ],
    description: '咕咚一口，技能栏整个换成随机某个职业的（连资源条一起借来）。持续到你倒下为止 —— 也可能换回自己那套，那就自认倒霉。',
  },
  {
    id: asConsumableId('ffa.giant_growth'),
    name: '巨人化药水',
    buffSeconds: 20,
    cooldown: 0,
    effects: [
      {
        kind: 'applyAura',
        target: 'self',
        aura: {
          id: 'ffa.giant_growth',
          name: '巨人化',
          kind: 'buff',
          duration: 20,
          dispelType: DispelType.Magic,
          clearableByTrinket: false,
          /**
           * 占位值。★ 这一组就是「体型变大」的规则读法：打更痛、更能扛、
           *   控不住 —— 代价是**更好打中**（damageTaken +25%）和跑得更慢。
           *   变大在派对游戏里从来不是纯收益。
           *
           * ⚠️ 「被击面变大」在本引擎里**表达不了**：碰撞体是 `GEOMETRY`
           *   常量，验收 #10 明令模型大小不改变碰撞体。用承受伤害 +25%
           *   近似 —— 如实记在这里，而不是偷偷去改碰撞体。
           * ⚠️ 「更能扛」本来该写 `maxHealth: 1.35`，但那个字段当时在 sim 里
           *   没有消费方。改用 `absorb` —— 一层实打实的护盾，
           *   而且它有「破裂」表现（14.3），比一条看不见的血条上限更好读。
           * ⚠️ 「推不动」同理不写 `knockbackTaken` —— 那个字段当时也是死的。
           *   抗控只保留真生效的 `ccDurationTaken`。
           * ✅ W26 已把两个字段都接上；这里的数值**有意维持原样**（护盾的
           *   破裂反馈这条理由今天仍然成立），换回去属配平，见文件头。
           */
          modifiers: {
            damageDealt: 1.3,
            damageTaken: 1.25,
            moveSpeed: 0.92,
            ccDurationTaken: 0.65,
          },
          // 占位值：350 ≈ 三分之一管血的护盾，破了就露出「更好打中」那一面
          absorb: 350,
          description: '体型暴涨：造成伤害 +30%，控制时长 -35%，外加一层 350 点护盾；但目标更大，受到的伤害 +25%，移动速度 -8%。',
        },
      },
    ],
    description: '20 秒内变成一个巨人：更能打、更抗控、更扛揍，也更好打中。',
  },
  {
    id: asConsumableId('ffa.vanishing_cloak'),
    name: '隐身斗篷',
    buffSeconds: 8,
    cooldown: 0,
    effects: [
      // ★ 复用潜行通道（5.3 / 验收 #5）：照明弹、地面区域的 revealsStealth 照旧克它
      { kind: 'enterStealth', graceSeconds: 1 },
      {
        kind: 'applyAura',
        target: 'self',
        aura: {
          id: 'ffa.vanishing_cloak',
          name: '隐身斗篷',
          kind: 'buff',
          duration: 8,
          dispelType: DispelType.Magic,
          clearableByTrinket: false,
          // 占位值：+20% 移速，让「溜走」真的溜得掉
          modifiers: { moveSpeed: 1.2 },
          description: '隐去身形，移动速度提高 20%。',
        },
      },
    ],
    description: '披上斗篷隐去身形 8 秒，期间移动速度提高 20%。被发现或揭露潜行的手段照样能抓到你。',
  },
  {
    id: asConsumableId('ffa.blink_scroll'),
    name: '闪跃卷轴',
    buffSeconds: 6,
    cooldown: 0,
    effects: [
      /**
       * ★ 「全场传送」按 25 米落地。**不是**真的随机传送到全场任意一点 ——
       *   位移一律走 `clampDisplacement`（验收 #46：不能穿墙或到达非法位置），
       *   随机落点会有一半的概率把人塞进墙里然后被推回来，那不好玩也不合规。
       *   沿面向 25 米 ≈ 竞技场半径的一半，手感上就是「唰地一下到对面」。
       */
      { kind: 'blinkForward', distance: 25, clearsRoot: true },
      {
        kind: 'applyAura',
        target: 'self',
        aura: {
          id: 'ffa.blink_scroll',
          name: '余韵',
          kind: 'buff',
          duration: 6,
          dispelType: DispelType.Magic,
          clearableByTrinket: false,
          modifiers: { moveSpeed: 1.15 },
          description: '传送余韵未散，移动速度提高 15%。',
        },
      },
    ],
    description: '沿面向瞬移 25 米并挣脱定身，落地后 6 秒内移动速度提高 15%。撞墙会停在墙前。',
  },
  {
    id: asConsumableId('ffa.bouncy_mine'),
    name: '跳跳地雷',
    buffSeconds: 5,
    cooldown: 0,
    effects: [
      {
        kind: 'spawnTrap',
        // 占位值：1 秒布设 —— 不能贴脸即炸，追你的人有反应窗口
        armTime: 1,
        triggerRadius: 3.5,
        duration: 45,
        // ★ 只炸第一个踩到的人（与冰冻陷阱同一条口径），不是一颗雷清场
        singleTrigger: true,
        onTrigger: [
          // 占位值：260 伤害 + 14 米击飞。派对感在「飞出去」，不在伤害
          { kind: 'damage', school: School.Fire, amount: { flat: 260 } },
          { kind: 'knockback', distance: 14 },
          { kind: 'stun', duration: 1 },
        ],
      },
    ],
    description: '在脚下埋一颗雷，1 秒后布设完成。第一个踩上来的倒霉蛋会被炸飞 14 米并昏迷 1 秒，最多留 45 秒。',
  },
  {
    id: asConsumableId('ffa.roast_chicken'),
    name: '整只烤鸡',
    buffSeconds: 12,
    cooldown: 0,
    effects: [
      // 占位值：即时 300 + 12 秒共 240 的回复 ≈ 半管血，但后半段要活着才吃得到
      { kind: 'heal', amount: { flat: 300 } },
      {
        kind: 'applyAura',
        target: 'self',
        aura: {
          id: 'ffa.roast_chicken',
          name: '心满意足',
          kind: 'buff',
          duration: 12,
          dispelType: DispelType.Magic,
          clearableByTrinket: false,
          periodic: { interval: 2, effects: [{ kind: 'heal', amount: { flat: 40 } }] },
          modifiers: { resourceGain: 1.2 },
          description: '每 2 秒恢复生命，资源获取提高 20%。',
        },
      },
    ],
    description: '当场啃完一整只烤鸡：立刻回复大量生命，随后 12 秒持续回血并让资源获取提高 20%。',
  },
];

export const PARTY_CONSUMABLES: readonly ConsumableDef[] = partyConsumables;

// ── 索引 ─────────────────────────────────────────────────────────

const WEAPON_BY_ID = new Map(PARTY_WEAPONS.map((w) => [w.id as string, w]));
const SKILL_BY_ID = new Map(PARTY_SKILLS.map((s) => [s.id as string, s]));
const CONSUMABLE_BY_ID = new Map(PARTY_CONSUMABLES.map((c) => [c.id as string, c]));

export const getPartyWeapon = (id: string): WeaponDef | undefined => WEAPON_BY_ID.get(id);
export const getPartySkill = (id: string): SkillDef | undefined => SKILL_BY_ID.get(id);
export const getPartyConsumable = (id: string): ConsumableDef | undefined =>
  CONSUMABLE_BY_ID.get(id);
