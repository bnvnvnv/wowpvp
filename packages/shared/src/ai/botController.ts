/**
 * 假人 / 人机的**决策层**。一次「思考」产出的就是真人产出的那两样东西：
 * 一份 `MovementInput` + 可选的一份 `CastIntent`。
 *
 * ★★ **红线：这里只做决策，绝不动 world。**
 *   产出的意图由调用方喂给 `tickWorld` 的 `inputs` / `castRequests`
 *   （服务器 `MatchLoop`、试验场 `CombatDirector`、`balance-report` 三者
 *   用的是同一份契约）。AI 因此与真人**逐字节走同一条路**：
 *   同样的 `validateCast` 校验、同样的资源与冷却消耗、同样的两个施法出口。
 *   docs/14 §M16b 的那条红线（「不允许直接改 world，否则回放与反作弊边界全破」）
 *   在这个模块里是**结构性**成立的 —— 它连 world 的写权限都没有拿到。
 *
 * ★ 这份逻辑原先是 `scripts/balance-report.ts` 里 `duel()` 的一个闭包。
 *   提出来是因为它是全仓库**唯一**经过实证的 AI：168 场确定性对局跑通，
 *   而且是唯一会移动的。提取后 `balance-report` 改为调用它 ——
 *   那 168 场就是这份逻辑的回归网，改坏了 `pnpm balance` 的基线会立刻变。
 *
 * ⚠️ **它不会的事**（写在这里免得下一个人误以为它是「强 AI」）：
 *   不会假读条骗打断、不会绕柱走位、不会选地面落点、不会挡援（chargeToAlly）。
 *   它是「同等操作水平的下限」，用来当靶子和回归基线，不是用来演示反制链的。
 *
 * ★ **队友感知**（B1 余账「保队友」的第一步）：`allies` 是**可选**感知项 ——
 *   不传就退化成「队伍里只有我一个」，1v1 与全部老调用方逐位不变。
 *   目前它只喂治疗（奶血最少的那个队友），选敌的队伍层协同在调用方
 *   （`server/BotDriver.ts` 的集火呼叫）—— 那里才看得见「谁是同一队的人机」。
 */

// ★ 逐模块 import 而不是从 `../index.js` —— index 现在也导出本文件，
//   走 index 会形成循环依赖。
import { getClass, getSkill, getWeapon } from '../data/index.js';
import type { AuraDef, EffectDef, SkillDef } from '../data/schema.js';
import { CastFailure, CastKind, DrCategory } from '../types/enums.js';
import { dirToYaw, distance2D, sub, yawToDir, type Vec3 } from '../math/vec3.js';
import { getCast, isCasting, validateCast, type CastingStore } from '../sim/casting.js';
import { aurasOf, dispelEligible, type AuraStore } from '../sim/aura.js';
import { drFactor, type DrStore } from '../sim/dr.js';
import { CONTROL_DR_CATEGORY, magnitudeOf } from '../sim/effects/combat.js';
import { isFriendly, type CombatEntity } from '../sim/entity.js';
import type { ClassId, EntityId } from '../types/ids.js';
import type { GroundStore } from '../sim/groundArea.js';
import type { MovementInput } from '../sim/movement.js';
import type { ProjectileStore } from '../sim/projectile.js';
import { TRINKET_COOLDOWN_KEY, type CastIntent } from '../sim/tick.js';
import type { World } from '../sim/world.js';

// ── 难度分档 ─────────────────────────────────────────────────────

/**
 * 人机难度。**只影响「会不会/多快反应」，不改任何结算数值** ——
 * 与 8.5 战斗抑制那类真平衡参数分开：难度调的是对手的操作水平，不是伤害。
 */
export type BotDifficulty = 'easy' | 'normal' | 'hard';

/**
 * 各档对「敌人开始读一个可打断技能」的反应时间，秒。
 * ★ 时间来自被打断者的 `CastState.startedAt` —— 决策层因此**无需自己记忆**
 *   谁从什么时候开始读条（它是纯函数，没有跨 tick 的记忆）。读条已经进行了
 *   ≥ 反应时间才出手打断，短读条会「反应不过来」，正是想要的手感差异。
 * · easy = Infinity：永远不打断（新手对手不会留打断）
 * · normal 0.35s：像个会打断但手不快的普通玩家
 * · hard 0.12s：几乎是看到就打断
 */
const REACTION_SECONDS: Record<BotDifficulty, number> = {
  easy: Infinity,
  normal: 0.35,
  hard: 0.12,
};

// ── 站位（AI 的「打多远」）─────────────────────────────────────────

/**
 * 一个技能**一次施放**打出的总伤害（直伤 + 投射物 + DoT 整段 + 落区整段 +
 * 延迟落点）。
 *
 * ★★ 五种伤害形状**都要认**，每漏一种都发生过一次「AI 把爆发键当杂项」：
 *   · `applyAura.periodic` —— 早期旋刃斩（见 hasDamage 的教训注释）
 *   · `spawnGroundArea.onTick` —— **M14 把旋刃斩/凛冬领域的伤害挪进这里**，
 *     老教训悄悄复发：bot 又把 60 秒大爆发当成了没伤害的杂项（P1a 测试抓回）
 *   · `delayedGroundImpact.onImpact` —— 陨星（地面技能 bot 暂不放，但估值
 *     函数不该对形状撒谎 —— P1b 接落点时它就该直接是对的）
 */
const totalDamageOf = (
  sk: SkillDef,
  self: CombatEntity,
  /**
   * 目标身上**已经在跳**的 DoT 光环 id（见 `dotsAlreadyOn`）。不传 =
   * 没有目标上下文（`nominalDps`/`standOff` 就是这样调的）→ 行为与旧版逐位一致。
   */
  tickingOnTarget?: ReadonlySet<string>,
): number => sumDamage(sk.effects, self, tickingOnTarget);

/**
 * `totalDamageOf` 的实际累加体。拆成独立函数**只为了一件事**：
 * `lockedProjectile.onHit` 要能原样递归进去。
 *
 * ★★ **W23 的结构红线。** 法术弹道迁移把伤害从技能顶层挪进了
 *   `lockedProjectile.onHit`（21 个技能）。这个函数如果不跟着下探，
 *   bot 会认为法师/牧师/德鲁伊/圣骑士手里**一个有伤害的技能都没有** ——
 *   `hasDamage` 全假 → 选招池只剩杂项 → 法系 bot 集体哑火，
 *   `pnpm balance` 的基线会整体塌穿。这不是猜测，是 `totalDamageOf`
 *   头部那三条老教训（旋刃斩、暴风雪、陨星）的第四次复发预案。
 * ★ 递归而不是「扁平化一次再算」：`tickingOnTarget` 的 DoT 去重逻辑
 *   必须同样作用在 onHit 里的 DoT 上 —— 暗言术·痛 / 月火 / 毒蛇钉刺
 *   三条零冷却 DoT 迁移后**全在 onHit 里**，正是那条教训的原案发现场。
 */
const sumDamage = (
  effects: readonly EffectDef[],
  self: CombatEntity,
  tickingOnTarget?: ReadonlySet<string>,
): number => {
  let sum = 0;
  for (const e of effects) {
    if (e.kind === 'lockedProjectile') sum += sumDamage(e.onHit, self, tickingOnTarget);
    if (e.kind === 'damage') sum += magnitudeOf(e.amount, self);
    if (e.kind === 'spawnProjectile') {
      for (const h of e.onHit) if (h.kind === 'damage') sum += magnitudeOf(h.amount, self);
    }
    if (e.kind === 'applyAura' && e.aura.periodic) {
      /**
       * ★★ DoT 已经挂在目标身上就**不再计它的周期伤害** —— 重挂只是把
       *   剩余时间刷回满，一秒也没多打出来，白扔一个公共冷却。
       *
       *   为什么现在才修：老版这里的取舍注释写着「AI 会在 DoT 未掉时覆盖
       *   重挂 —— 普通玩家同款低效，不值得建模」。那句话成立有个**没写出来
       *   的前提：当时所有 DoT 都带冷却**（月火 6s、凋零缠绕 15s），
       *   重挂被冷却天然限流，最多浪费一两个 GCD。
       *
       *   P3b 给牧师/死骑/猎人/盗贼各补了一个**零冷却** DoT，前提当场失效：
       *   零冷却 + 按「整段总量」计权 ⇒ 暗言术·痛（6 跳 ×45 = 270）永远是
       *   牧师手里最大的那个数 ⇒ bot 每个 GCD 都在重挂它，一发别的都不放。
       *   基线里牧师因此从 69.0% 掉到 **0.0%**（21 场一场没赢）。
       *   —— 不是数据配错，是这条估值在零冷却 DoT 上彻底失真。
       *
       *   只扣周期部分：疫病打击那种「武器伤害 + 挂病」的技能，武器伤害
       *   照算，所以 DoT 还在时它依然是个能按的攻击键，只是不再虚高。
       */
      const already = e.target !== 'self' && tickingOnTarget?.has(e.aura.id);
      if (!already) {
        const ticks = Math.floor(e.aura.duration / e.aura.periodic.interval);
        for (const h of e.aura.periodic.effects) {
          if (h.kind === 'damage') sum += magnitudeOf(h.amount, self) * ticks;
        }
      }
    }
    if (e.kind === 'spawnGroundArea' && e.onTick && e.tickInterval) {
      const ticks = Math.floor(e.duration / e.tickInterval);
      for (const h of e.onTick) {
        if (h.kind === 'damage') sum += magnitudeOf(h.amount, self) * ticks;
      }
    }
    if (e.kind === 'delayedGroundImpact') {
      for (const h of e.onImpact) if (h.kind === 'damage') sum += magnitudeOf(h.amount, self);
    }
    /**
     * ⚠️ 终结技（spendComboPoints/spendResource 的 damage base）**刻意不计**。
     *   P1a 试过两版计入（按实际点数线性 / 加 3 点下限）：盗贼基线从 21.4%
     *   直落 0%，且两版**逐位同结果** —— 说明归零机制不是「低点急花」，
     *   真实因果未定位。按「不 ship 无法解释的回归」纪律回滚，
     *   连击点终结循环归 P1b 带诊断重做（总账 B1 的余账）。
     *   代价如实记：盗贼仍不会剜刺，连击点在基线里仍是装饰。
     */
  }
  return sum;
};

/** 一个伤害技能的**名义**持续 DPS：只用于站位估算，不进任何结算 */
export const nominalDps = (sk: SkillDef, self: CombatEntity): number =>
  // 节奏 = 冷却 / 读条 / 公共冷却的最大者。资源节流不进估算 —— 这是站位
  // 用的粗粒度权重，不是伤害模型
  totalDamageOf(sk, self) / Math.max(sk.cooldown, sk.cast.time, 1.5);

export const isHealSkill = (sk: SkillDef): boolean =>
  sk.effects.some((e) =>
    e.kind === 'heal' || e.kind === 'healPercentMaxHealth' || e.kind === 'healFromRecentDamage');

/**
 * 技能是否**产出伤害** —— 直伤、投射物命中、或光环周期伤（DoT）。
 * ⚠️ 少了第三类时，战士的剑刃风暴（伤害全在光环 periodic 里，4 秒 8 跳）
 *   被 AI 当成杂项增益，几乎从不进输出循环 —— 他最大的爆发键躺着不用。
 */
/**
 * 技能是否**产出伤害** —— 五种伤害形状之一（清单见 totalDamageOf）。
 * ⚠️ 每漏一种形状，都有某个职业的核心键被 AI 当成杂项增益躺着不用。
 * ★ 纯**形状**判断不算数值 —— 算数值要 self（weaponPercent 依赖武器），
 *   而这个判断在 standOff 的过滤器里也要用，保持无状态。
 */
export const hasDamage = (sk: SkillDef): boolean => anyDamageShape(sk.effects);

/**
 * `hasDamage` 的形状判定体。★ W23 起有第六种形状：`lockedProjectile.onHit`
 *   （见 `sumDamage` 的结构红线注释 —— 漏了它法系 bot 直接哑火）。
 */
const anyDamageShape = (effects: readonly EffectDef[]): boolean =>
  effects.some((e) =>
    e.kind === 'damage' ||
    (e.kind === 'spawnProjectile' && e.onHit.some((h) => h.kind === 'damage')) ||
    (e.kind === 'lockedProjectile' && anyDamageShape(e.onHit)) ||
    (e.kind === 'applyAura' &&
      (e.aura.periodic?.effects.some((h) => h.kind === 'damage') ?? false)) ||
    (e.kind === 'spawnGroundArea' &&
      (e.onTick?.some((h) => h.kind === 'damage') ?? false)) ||
    (e.kind === 'delayedGroundImpact' && e.onImpact.some((h) => h.kind === 'damage')));

/** 是否是一个专用打断技能（效果里带 interrupt）*/
export const isInterruptSkill = (sk: SkillDef): boolean =>
  sk.effects.some((e) => e.kind === 'interrupt');

// ── P4：四类此前从未被 bot 使用的技能的分类器 ──────────────────────
//
// ★★ 背景：P4 之前选招是 `pool = damaging.length > 0 ? damaging : offensive`
//   —— 只要有伤害技能可用（几乎永远成立），控制/保命/驱散/位移就**永远**
//   进不了候选集。量化过：53/116 = 46% 的技能一次都不会被按。
//   下面每个分类器都对应决策链里一个新步骤，谁也不进旧的伤害 argmax。

/** 这个光环挂在自己身上算不算「保命增益」（减伤/吸收/免疫/闪避招架）*/
const isDefensiveAura = (def: AuraDef): boolean =>
  def.kind === 'buff' &&
  (def.flags?.immuneAll === true ||
    def.flags?.immunePhysical === true ||
    def.flags?.immuneMagic === true ||
    (def.absorb ?? 0) > 0 ||
    (def.absorbPercentMaxHealth ?? 0) > 0 ||
    (def.modifiers?.damageTaken ?? 1) < 1 ||
    (def.modifiers?.dodgeFront ?? 0) > 0 ||
    (def.modifiers?.parry ?? 0) > 0);

/**
 * 保命键：给**自己**挂一个防御性光环的技能（冰封庇护、神圣壁障、防御架势、
 * 法术反射、硬化树皮、疾闪、符文守护…）。
 * ★ 排除治疗（有自己的半血步骤）；排除挂在敌人身上的减益
 *   （`target: 'target'` 且目标是敌人的那类不进来 —— 用 targetFilter 判）。
 * ⚠️ **排除带 `cannotAttack` 的交易型保命（龟甲护体）**：它是「减伤 35% 换
 *   4 秒零输出」的对赌键，赢面在于骗掉对手的爆发窗口 —— 那需要读对手的
 *   爆发，bot 读不了。分步归因实测：让 bot 无脑低血就缩壳，猎人 23.8→7.1%
 *   （缩着挨打，出壳血更少）。与 blinkForward 同一原则：用不对不如不用。
 */
export const isSelfDefenseSkill = (sk: SkillDef): boolean =>
  !isHealSkill(sk) &&
  // 巨熊形态的 damageTaken 0.85 搭着形态切换 —— 与 isSpeedBurstSkill 排除
  // 迅猫形态同理：变身后施法套件被 notInForm 封死，保命分类器不开这个侧门
  !sk.effects.some((e) => e.kind === 'shapeshift') &&
  sk.effects.some(
    (e) =>
      e.kind === 'applyAura' &&
      isDefensiveAura(e.aura) &&
      e.aura.flags?.cannotAttack !== true &&
      (e.target === 'self' || sk.targetFilter !== 'enemy'),
  );

/**
 * 控制技能所属的递减类别。**只认顶层控制效果**（stun/fear/incapacitate/
 * root/silence）—— 与结算侧 `applyControl` 走的是同一批 kind，映射
 * `CONTROL_DR_CATEGORY` 也来自那边的 `CONTROL_SPECS`，不另抄一份事实。
 * 带 interrupt 的技能（断招踢/斥令）**不算控制** —— 踢要留给打断步骤，
 * 被当成普通控制丢出去，真读条来了就没踢可用了。
 */
export const ccCategoryOf = (sk: SkillDef): DrCategory | undefined => {
  if (isInterruptSkill(sk)) return undefined;
  return ccCategoryIn(sk.effects);
};

/**
 * ★ W23：控制效果同样会被挪进 `lockedProjectile.onHit`（制裁之锤、扼喉、
 *   化形术、纠缠根须都在其中）。不下探的话 bot 的「控制」步骤会认为
 *   四个职业手里一个控制键都没有 —— 与 `hasDamage` 同族的静默失效。
 */
const ccCategoryIn = (effects: readonly EffectDef[]): DrCategory | undefined => {
  for (const e of effects) {
    const cat = (CONTROL_DR_CATEGORY as Partial<Record<string, DrCategory>>)[e.kind];
    if (cat !== undefined) return cat;
    if (e.kind === 'lockedProjectile') {
      const inner = ccCategoryIn(e.onHit);
      if (inner !== undefined) return inner;
    }
  }
  return undefined;
};


/**
 * 逃脱位移：向后跃出（后撤跃）。
 * ⚠️ **刻意不含 `blinkForward`（瞬闪）**：bot 的 yaw 永远面向对手，向前闪
 *   等于闪进近战怀里。真人的逃脱闪现是「转身-闪-回头」三步，当前单 tick
 *   决策模型表达不了 —— 与其闪错方向不如不闪，如实记 B1 余账。
 */
export const isEscapeSkill = (sk: SkillDef): boolean =>
  sk.effects.some((e) => e.kind === 'leapBackward');

/**
 * 近战拉近：冲锋 / 背刺传送。`chargeToAlly`（挡援）不算 ——
 * 单目标感知里没有队友模型，冲向队友无从谈起。
 */
export const isGapCloserSkill = (sk: SkillDef): boolean =>
  sk.effects.some((e) => e.kind === 'chargeTo' || e.kind === 'teleportBehindTarget');

/**
 * 给自己加速的爆发键（猎豹守护、疾奔怒吼）：追人/拉开都用它。
 * ⚠️ **排除带 `shapeshift` 的技能（迅猫形态）**：它的 15% 加速搭着一整次
 *   形态切换 —— 分步归因抓到：被贴脸的德鲁伊「开加速」变成了猫，随后
 *   愤怒/星涌/治疗全部 `notInForm` 验不过，整套施法职业套件自我封印，
 *   德鲁伊 59.5→14.3%。形态轮换是 B3 明确不做的事，加速分类器不能
 *   从侧门把它放进来。
 */
export const isSpeedBurstSkill = (sk: SkillDef): boolean =>
  !sk.effects.some((e) => e.kind === 'shapeshift') &&
  sk.effects.some(
    (e) =>
      e.kind === 'applyAura' &&
      e.target !== 'target' &&
      (e.aura.modifiers?.moveSpeed ?? 1) > 1,
  );

/**
 * P4 战术阈值。⚠️ **全部是占位值** —— 没有一条来自规格书，都是「先取一个
 * 说得通的数、由 `pnpm balance` 逐步归因来检验」（数字旁边写由来，
 * PROGRESS 技术债 §2 的教训）。它们只影响 bot 出招时机，不进任何结算。
 */
const TACTICS = {
  /** 血量低于最大值的这个比例 → 开保命键（比半血治疗更晚：保命键 CD 长）*/
  SURVIVAL_HEALTH: 0.35,
  /**
   * 血量低于最大值的这个比例 → 值得为他花一个公共冷却去治疗。
   * ★ 这个 0.5 不是新数：它是原先写死在治疗步骤里的那个「半血」，B1 只是把它
   *   提成常量，好让**自己与队友共用同一条线** —— 两条线会立刻带出
   *   「先奶谁」的第二个可调参数，而没有任何数据支撑第二个数。
   * ⚠️ 与 SURVIVAL_HEALTH(0.35) 的高低关系是刻意的：治疗先于保命键触发
   *   （治疗冷却短、可重复），保命键留到更危险的时候。
   */
  HEAL_HEALTH: 0.5,
  /**
   * B2：血量低于最大值的这个比例 → hard 档考虑「转身跑」。**占位值**。
   * 取 0.3 的理由：必须**严格低于** SURVIVAL_HEALTH(0.35) —— 逃跑是
   * 「保命键都交完了」之后的最后一步，先于它触发就会抢掉本该开的保命键，
   * 变成「有盾不开、光顾着跑」。两条线之间的 0.05 是给保命步骤的出手余量。
   */
  RETREAT_HEALTH: 0.3,
  /** 对手血量低于此比例 → 控制值得用来锁杀 */
  CC_KILL_WINDOW: 0.35,
  /** 自己血量低于此比例 → 控制值得用来解围 */
  CC_SELF_DANGER: 0.5,
  /** 对手贴到这个距离内算「贴脸」（远程的 peel/逃脱窗口）*/
  PEEL_RANGE: 5,
  /** standOff 至少这么远才算「远程打法」（法师 32 / 猎人 25；近战全在 4 以下）*/
  RANGED_REACH_MIN: 12,
  /** 递减系数低于 1/2 不出控制 —— 半衰以下的控制不值一个公共冷却 */
  DR_MIN_FACTOR: 0.5,
  /**
   * 安全风筝退到**这个绝对距离**就停，不是退满 standOff。
   * ⚠️ 第一版是 `reach * 0.8`（法师 25.6m / 德鲁伊 24m）—— 分步归因抓到：
   *   从 5m 退到 24m 要在 65% 速度下走约 5 秒，整个控制窗口全花在走路上，
   *   读条填充（德鲁伊愤怒 1.4s）全程被 castableNow 封着 —— 德鲁伊
   *   59.5→28.6%、法师 42.9→21.4%，跌的全是「用走路换输出」这一刀。
   *   12m = 出了近战触及 + 一个身位余量，够放一发读条再决定下一步。
   */
  KITE_TO: 12,
  /** 近战与对手拉开超过这个距离才动用冲锋（太近了冲锋有 minRange 也放不出）*/
  GAP_CLOSE_MIN_D: 8,
  /**
   * P5：hard 档「留踢」的门槛 —— 读条短于这个秒数的**伤害**技能不值得交打断
   * （治疗不论长短都踢）。1.2s 取在填充核弹档（1.0–1.4）中间：短灼烧骗不走
   * hard 的踢，而霜矢/圣光击这类主力读条仍然会被踢。
   */
  KICK_WORTH_CAST_SECONDS: 1.2,
} as const;

/**
 * 这一发**直接**打出的伤害（不摊冷却）。用于「用当前可用技能里最狠的一发」——
 * 大冷却技能一旦可用，它的单发伤害远高于填充技能，于是自然被优先打出；
 * 在冷却里时它根本不在可用集合，填充技能顶上。这就是 cooldown-aware 出招：
 * **可用性已经把冷却过滤掉了，剩下按单发威力挑最大即可。**
 *
 * ★ 与 `nominalDps`（除以冷却，给站位用）刻意不同：那个会把 60 秒大招的
 *   权重除没，用它挑技能会让 AI 永远不放大招。
 * ⚠️ 已知取舍：DoT/落区按整段总量计权 —— AI 会在 DoT 未掉时覆盖重挂，
 *   普通玩家同款低效，不值得为此建模 DoT 追踪。
 */
export const burstDamageOf = (
  sk: SkillDef,
  self: CombatEntity,
  tickingOnTarget?: ReadonlySet<string>,
): number => totalDamageOf(sk, self, tickingOnTarget);

/**
 * 目标身上「**下个公共冷却之后还在跳**」的 DoT 光环 id 集合。
 *
 * ★ 判据用「剩余 > 1 个 GCD」而不是「存在即跳过」：快掉的 DoT 就该续，
 *   否则 bot 会眼睁睁看它掉完再重挂，白丢一段 uptime。
 *   反过来，如果我按下这一发时它还能跳过我的下一个决策点，那么现在按它
 *   **一定**是纯亏 —— 这就是要剪掉的那个行为。
 * ★ 不传 auras（老调用方）→ 空集 → 逐位退化成旧行为。
 */
const dotsAlreadyOn = (
  auras: AuraStore | undefined,
  targetId: EntityId,
  now: number,
): ReadonlySet<string> => {
  if (!auras) return EMPTY_AURA_SET;
  const out = new Set<string>();
  for (const a of aurasOf(auras, targetId)) {
    if (a.def.periodic && a.expiresAt - now > GCD_SECONDS) out.add(a.def.id);
  }
  return out;
};

/** 公共冷却，秒。只用于上面那条「续不续 DoT」的判据，不进任何结算 */
const GCD_SECONDS = 1.5;
const EMPTY_AURA_SET: ReadonlySet<string> = new Set<string>();

/**
 * ★★ 站位：**保有至少六成火力的前提下站得越远越好。**
 *
 * 前两版的教训都在 `decideBotAction` 里注释着；第三版「够着此刻可用的最远
 * 伤害技能」修好了战士，却把猎人钉在 35 米 —— 瞄准射击（35m）可用时他站在
 * 弓（28m）射程之外，白字全程落空，DPS 反而掉到白字理论值以下。
 *
 * 通用规则：把「武器触及 + 各伤害技能射程」当候选站位，给每个站位算
 * 「站在这里还打得出的名义 DPS」（白字 + 技能），**取火力 ≥ 最大值 60% 的
 * 最远者**。八职业各得其所：法师留在 32 米（放弃近战斩的 12%，保距离），
 * 猎人站 25 米（弓/秘法箭/瞄准全部在射程内），圣骑士/战士走进近战
 * （远程件只有全火力的两三成，过不了线）。
 * ⚠️ 60% 是站位偏好的阈值，不是平衡参数 —— 它只决定 AI 站哪，不改任何结算。
 */
/**
 * standOff 记忆化（P11 CPU 优化）。
 *
 * ★ 依赖闭包已核实：技能表由 classId 决定；数值链
 *   `nominalDps → totalDamageOf(sk, self)`（无 tickingOnTarget 上下文）→
 *   `magnitudeOf` 只读 `source.weaponId`。所以答案是 (classId, weaponId)
 *   的纯函数 —— 同职业同武器的任意两个实体逐位同解。
 * ⚠️ 往 standOff 的估值链里加**任何**读实体其他字段的项（血量、光环、
 *   属性）之前，必须先删掉这层缓存，否则站位会静默冻结在旧答案上。
 */
const STANDOFF_CACHE = new Map<string, number>();

/**
 * 职业技能表缓存（P11 CPU 优化）。此前 `decideBotAction` 每 bot 每 tick 做一次
 * 线性查找 —— 12v12 满人机 = 480 次/秒/房。注册表数据进程内不变，缓存永不失效。
 *
 * ★ 底层走 `getClass()`（**注册表**）而不是 `ALL_CLASSES`（**可选职业清单**）：
 *   八个可选职业两者逐位相同，差别只在特殊职业 —— 大 BOSS 的 ClassDef 刻意
 *   不进 `ALL_CLASSES`（`data/index.ts` 的 SPECIAL_CLASSES），用清单找会
 *   **静默**得到空技能表：BOSS 会走位、会抡白字，但一个技能都不放且无报错。
 */
const CLASS_SKILLS_CACHE = new Map<ClassId, readonly SkillDef[]>();

const skillsOfClass = (classId: ClassId): readonly SkillDef[] => {
  let skills = CLASS_SKILLS_CACHE.get(classId);
  if (skills === undefined) {
    skills = getClass(classId)?.skills ?? [];
    CLASS_SKILLS_CACHE.set(classId, skills);
  }
  return skills;
};

export const standOff = (self: CombatEntity, skills: readonly SkillDef[]): number => {
  const cacheKey = `${self.classId}|${self.weaponId}`;
  const cached = STANDOFF_CACHE.get(cacheKey);
  if (cached !== undefined) return cached;
  const result = standOffUncached(self, skills);
  STANDOFF_CACHE.set(cacheKey, result);
  return result;
};

const standOffUncached = (self: CombatEntity, skills: readonly SkillDef[]): number => {
  const w = getWeapon(self.weaponId);
  const whiteDps = w ? (w.swingPercent * 100) / w.swingInterval : 0;
  const damaging = skills.filter(
    (sk) => sk.targeting !== 'ground' && !isHealSkill(sk) && hasDamage(sk),
  );

  const candidates = new Set<number>([w?.reach ?? 2]);
  for (const sk of damaging) candidates.add(sk.range.max);

  const scoreAt = (c: number): number =>
    (w && w.reach >= c ? whiteDps : 0) +
    damaging.reduce((sum, sk) => sum + (sk.range.max >= c ? nominalDps(sk, self) : 0), 0);

  const max = Math.max(...[...candidates].map(scoreAt));
  let best = w?.reach ?? 2;
  for (const c of candidates) {
    if (scoreAt(c) >= max * 0.6 && c > best) best = c;
  }
  return best;
};

// ── 走位（P1b：风筝与躲圈）─────────────────────────────────────────

/**
 * 世界方向 → 角色本地的 `forward/strafe` 输入。
 *
 * ★★ 这是 P1b 唯一容易搞反的地方，所以抽成纯函数单测：`movement.ts` 的约定是
 *   `forward = yawToDir(yaw)`、`right = (-forward.z, 0, forward.x)`，
 *   一次投影即可。⚠️ 后退有 65% 速度惩罚（`BACKWARD_FACTOR`）——**不在这里
 *   补偿**：那是移动系统的规则，AI 与真人吃同一份。
 *
 * @param dir 想去的世界方向（无需归一化，零向量返回原地不动）
 */
export const toLocalMove = (
  dir: { x: number; z: number },
  yaw: number,
): { forward: number; strafe: number } => {
  const len = Math.hypot(dir.x, dir.z);
  if (len < 1e-6) return { forward: 0, strafe: 0 };
  const nx = dir.x / len;
  const nz = dir.z / len;
  const f = yawToDir(yaw);
  // right = (-f.z, 0, f.x)，与 movement.ts 逐字一致
  return {
    forward: nx * f.x + nz * f.z,
    strafe: nx * -f.z + nz * f.x,
  };
};

/** 一片要躲开的危险区域：圆心 + 半径 */
interface Danger {
  center: Vec3;
  radius: number;
}

/**
 * 此刻踩在脚下、**敌方放的、会造成伤害的**地面危险。
 *
 * ★ 三个限定词都不能少：
 *   · 敌方 —— 队友的区域（乃至自己的旋刃斩）不该被躲开
 *   · 会造成伤害 —— 烟雾弹/照明弹没伤害，躲它等于被一片烟雾赶跑
 *   · 踩在脚下 —— 圈外的区域绕开是路径规划（P1b 不做），只处理「已经站进去了」
 */
const dangersUnderfoot = (p: BotPerception): Danger[] => {
  const { self } = p;
  const out: Danger[] = [];

  for (const a of p.ground?.areas ?? []) {
    const src = p.world.entities.get(a.sourceId);
    if (src && isFriendly(src, self)) continue;
    if (!a.onTick.some((e) => e.kind === 'damage')) continue;
    if (distance2D(self.position, a.center) <= a.radius) {
      out.push({ center: a.center, radius: a.radius });
    }
  }

  // 延迟落点（陨星）：还没砸下来、我站在圈里 → 走出去。14.3 的倒计时
  // 对玩家可见，AI 用同一份数据做同一个判断
  for (const pr of p.projectiles?.items ?? []) {
    if (pr.kind !== 'delayedImpact') continue;
    if (pr.impactAt <= p.world.time) continue;
    const src = p.world.entities.get(pr.sourceId);
    if (src && isFriendly(src, self)) continue;
    if (distance2D(self.position, pr.center) <= pr.radius) {
      out.push({ center: pr.center, radius: pr.radius });
    }
  }
  return out;
};

/**
 * 逃离一片危险的世界方向：从圆心指向自己（最短出圈路径）。
 * ★ 恰好站在圆心时（dist≈0）没有「最短方向」—— 用朝向的**反方向**兜底，
 *   也就是「往后退」，而不是除零成 NaN。
 */
const escapeDir = (
  self: { position: Vec3 },
  d: Danger,
  yaw: number,
): { x: number; z: number } => {
  const dx = self.position.x - d.center.x;
  const dz = self.position.z - d.center.z;
  if (Math.hypot(dx, dz) < 0.05) {
    const f = yawToDir(yaw);
    return { x: -f.x, z: -f.z };
  }
  return { x: dx, z: dz };
};

// ── 治疗协作（B1：奶队友，不只是奶自己）──────────────────────────

/**
 * ★★ **该奶谁**：血量百分比最低的那个（含自己），按「越残越靠前」排好。
 *
 *   提成纯函数是因为它是这次改动里唯一有**顺序语义**的东西 ——
 *   排序稳不稳、平手怎么办、自己算不算队友，全在这里一次说清，
 *   决策链那边只负责「按这个顺序试，谁先验得过就奶谁」。
 *
 * 四条规则：
 *   · **自己永远在候选里** —— 队伍感知不传（1v1、试验场、balance-report）时
 *     这里就只剩自己，行为与 B1 之前逐位一致
 *   · 死人 / 宠物不奶 —— 死人奶不活（validateCast 也会判掉），宠物不是配合
 *   · 血量 ≥ HEAL_HEALTH 的人**不进列表** —— 满血队友不值一个公共冷却，
 *     而且列表为空时决策链一个 `rng()` 都不消耗（回放/种子复现的前提）
 *   · 平手按实体 id 排 —— ⚠️ **必须有一个确定性的二级键**：两个队友血量
 *     恰好相等时若靠数组顺序决定，同一份 world 在不同调用方（遍历顺序不同）
 *     下会奶不同的人，回放当场分叉
 *
 * ⚠️ 这里**不**判「奶得到吗」（射程/视线/沉默/蓝量）—— 那是 `validateCast`
 *   的活，抄一份镜像迟早漂移。决策链拿着这个顺序逐个去验，验不过就试下一个。
 *
 * @param allies 队友（可含自己，重复会去重）。不传 = 队伍里只有我
 */
export const healTargets = (
  self: CombatEntity,
  allies?: readonly CombatEntity[],
  threshold: number = TACTICS.HEAL_HEALTH,
): CombatEntity[] => {
  const out: CombatEntity[] = [];
  const seen = new Set<EntityId>();
  for (const e of [self, ...(allies ?? [])]) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    if (!e.alive || e.isPet || e.maxHealth <= 0) continue;
    if (e.health >= e.maxHealth * threshold) continue;
    out.push(e);
  }
  return out.sort((a, b) => {
    const pa = a.health / a.maxHealth;
    const pb = b.health / b.maxHealth;
    return pa !== pb ? pa - pb : a.id - b.id;
  });
};

// ── 决策 ─────────────────────────────────────────────────────────

/** 一次决策需要看到的全部东西。★ 只读 —— 这个模块拿不到任何写入口 */
export interface BotPerception {
  world: World;
  casting: CastingStore;
  self: CombatEntity;
  /**
   * 当前对手。
   * ⚠️ 本版**打击面**仍是单目标：选敌与换目标由调用方决定（服务器走
   *   `BotDriver.pickFoe` + 队伍集火呼叫），决策层拿到的就是那一个人。
   *   「挡援 / 给队友驱散 / 给队友上盾」仍然没有（docs/14 §M16b、B1 余账）。
   */
  foe: CombatEntity;
  /**
   * B1：**队友名册**（含自己也行，会去重）。目前只喂治疗步骤 ——
   * 「奶血最少的那个人」是团队配合里最便宜也最显眼的一环。
   *
   * ★ 不传 → 退化成「队伍里只有我一个」，只奶自己：1v1、试验场假人、
   *   `balance-report` 的 168 场全部逐位不变（与 `difficulty?`/`auras?` 同一手法）。
   * ★ 只读，与其余感知项同一条红线：决策层拿不到任何写入口。
   * ⚠️ 名册**不做可见性裁剪** —— `isVisibleTo` 对队友恒为真（docs/08 §4.1
   *   「队友的潜行对己方可见」），所以队友这一侧不存在 A4 那类透视问题；
   *   真正的「够不够得着」由 `validateCast` 的射程/视线判，不在这里抄一份。
   */
  allies?: readonly CombatEntity[];
  /**
   * 0..1 随机源。★ **必须由调用方注入**：sim 的确定性（回放、
   * `pnpm balance` 的种子复现）依赖这里不出现 `Math.random()`。
   */
  rng: () => number;
  /** 难度档。不传 = `normal`（balance-report 与老调用方走这个默认）*/
  difficulty?: BotDifficulty;
  /**
   * P1b 走位感知。**都可选** —— 不传就退化成「不躲圈」，老调用方零改动
   *（与 `difficulty?` 同一手法）。
   * ★ 只读：决策层拿不到任何写入口，红线不变。
   */
  ground?: GroundStore;
  projectiles?: ProjectileStore;
  /**
   * 光环仓，用来看**对手身上已经在跳的 DoT**（`dotsAlreadyOn`）、
   * 自己身上有没有已生效的保命增益（不叠盾）、双方身上可驱散的东西。
   * 不传 → bot 退化成「看不见 DoT、不开保命、不驱散」。
   * ★ 只读，与 ground/projectiles 同一条红线：决策层拿不到写入口。
   */
  auras?: AuraStore;
  /**
   * P4：控制递减仓（只读）。bot 出控制前查目标该类别的递减层数 ——
   * 半衰以下不出手，免疫绝不空放。不传 → 不做递减判断（当全额算）。
   */
  dr?: DrStore;
}

/** 一次决策的产出 —— 与真人的三条通道同构（移动 / 施法 / 战斗意志）*/
export interface BotAction {
  move: MovementInput;
  cast?: CastIntent;
  /**
   * P5：这一 tick 要交战斗意志（8.3 通用解控）。调用方喂给
   * `tickWorld.trinketRequests`（balance）/ `{t:'UseTrinket'}`（服务器）/
   * `pendingTrinkets`（试验场）—— 与 cast 一样只是意图，判定在 tick。
   */
  trinket?: boolean;
}

/**
 * AI：面向对手、按站位保持距离、**看到读条就打断**、血线告急开保命键、
 * 会用控制（带递减/免疫判断）、会驱散、被贴脸会拉开、够不着会冲锋、
 * 半血治疗、用当前可用技能里最狠的一发输出。难度档决定会不会用这些技巧
 * （easy 全部不用，保持木桩手感）；**hard 还会在弹尽粮绝时转身拉扯** ——
 * 治疗与保命键全在冷却、对手是近战且血比自己厚时，转身满速跑（见 `retreating`）。
 *
 * ★ B1「保队友」已开第一刀：**治疗会奶血最少的队友**（见治疗步骤）。
 * ★ 仍然不会的事（B1 余账，逐条有原因）：给队友驱散/上盾/挡援（治疗之外的
 *   队友向技能一律没接）、选地面落点、德鲁伊形态轮换、盗贼潜行开场、
 *   瞬闪逃脱（yaw 模型）、连击点终结技（两次实测打回未定位）、绕柱寻路。
 */
export const decideBotAction = (p: BotPerception): BotAction => {
  const { world, casting, self, foe, rng } = p;
  const difficulty = p.difficulty ?? 'normal';
  const yaw = dirToYaw(sub(foe.position, self.position));
  const d = distance2D(self.position, foe.position);

  /**
   * ★★ P5 战斗意志（8.3 通用解控）—— bot 此前对这整个系统零使用。
   *
   * 必须站在决策链**最顶**：被硬控时 validateCast 拒绝一切施法，后面每一步
   * 都天然短路 —— 昏迷中唯一能按的键就是它，这也正是 8.3 造它的理由
   * （「默认允许在昏迷中使用」，tick 第 1c 步刻意不查控制状态）。
   *
   * 不无脑交：只在**这口控真的要命**时用 ——
   *   · 自己血线不稳（对面正拿这口昏迷打爆发）
   *   · 或对手进击杀窗口（控住的每一秒都在给他喘息）
   * 满血互控的开场肾击就让它昏着 —— 真人也不会把 90 秒的解控交在那。
   * ★ easy 不用（新手不认识饰品栏，与不打断同源）。
   */
  if (
    difficulty !== 'easy' &&
    (self.flags.stunned || self.flags.feared) &&
    (self.cooldowns.get(TRINKET_COOLDOWN_KEY) ?? 0) <= world.time &&
    (self.health < self.maxHealth * TACTICS.CC_SELF_DANGER ||
      foe.health < foe.maxHealth * TACTICS.CC_KILL_WINDOW)
  ) {
    /**
     * ★ 阈值实测（P5 归因）：半血（CC_SELF_DANGER 0.5）83.3pp，
     *   收紧到 0.35 反而 85.7pp —— 阈值不是杠杆，取半血。
     *   盗贼 28.6→7.1 与牧师 →90.5 是**解控 meta 的结构性再分配**
     *  （控内爆发被克制、治疗职业更难杀 —— 与真实 PVP 同向），
     *   不是实现 bug；照胜率去禁用饰品 = balance-report 警告的那件事。
     */
    return { move: { forward: 0, strafe: 0, jump: false, yaw }, trinket: true };
  }

  /**
   * ★★ **读条期间不出手。**
   *   ⚠️ 早期版本没有这条 —— 于是瞄准射击起手后的 32 个 tick 里，
   *      AI 继续对唯一还「可用」的免公共冷却技能（断法箭）发起新施法，
   *      每一次都把读条中的瞄准射击顶掉重来：**读条技能永远完不成**。
   *      诊断脚本抓到的样子是：断法箭被选中 43 次却一次都没进冷却、
   *      猎人 DPS 恰好等于白字理论值 —— 法师冰枪/牧师惩击/圣光术同病。
   *      读条中站着不动、等它完成，是任何操作水平的底线，与反制链无关。
   */
  if (isCasting(casting, self.id)) {
    return { move: { forward: 0, strafe: 0, jump: false, yaw } };
  }

  const skills = skillsOfClass(self.classId);
  /**
   * ★ 治疗要按**自己**为目标验，进攻要按**对手**为目标验。
   *   ⚠️ 早期版本全部技能都拿 foe 去 validateCast —— 于是 TargetFilter.Ally
   *      的治疗永远验不过、永远不在可用集合里：三个治疗职业 HPS 恒为 0，
   *      「治疗职业」在基线里根本不存在，胜率垫底测的是 AI 不会奶自己。
   */
  const usableOn = (sk: SkillDef, target: CombatEntity): boolean =>
    sk.targeting !== 'ground' && // AI 不选落点
    /**
     * ★★ 自身中心 AOE 只在对手**真的在圈里**时才算可用。
     *   validateCast 对 selfCenter 不查目标距离（它没有目标），于是旋刃斩/
     *   凛冬领域在对手 30 米外也「可用」—— 旧随机选招只偶尔把 60 秒大招
     *   拍在空地上，argmax 选招（威力最大）会**每次都拍空**：P1a 首轮基线
     *   里战士/死骑胜率腰斩，跌的全是这一刀。
     */
    (sk.targeting !== 'selfCenter' || d <= sk.range.max) &&
    validateCast({ world, caster: self, skill: sk, target, phase: 'start' }) === CastFailure.Ok;

  const offensive = skills.filter((sk) => !isHealSkill(sk) && usableOn(sk, foe));

  /**
   * ★★ 走位历史（每一版都是一次「错基线引人调错数字」的教训）：
   *   第一版 `usable.length === 0 && d > 2` —— 自身增益可用时近战原地罚站，
   *   战士/死骑 0%。第二版「全部伤害技能的最大射程」—— 战士被 25 秒冷却的
   *   掷锤（20m）钉在 18 米外，而掷锤要的怒气只能靠 2.8 米的挥击攒：
   *   死锁，0% 胜率测的是死锁不是职业。第三版「此刻可用的最远伤害技能」——
   *   修好战士，却把猎人钉在瞄准射击的 35 米上：弓是 28 米，白字全程落空。
   *   现行：standOff() 的六成火力规则，见其注释。
   */
  const reach = standOff(self, skills);

  /**
   * ★★ P1b 走位：**躲圈 > 进场**。
   *
   *   · **躲圈** —— 脚下有敌方伤害区域/待落的陨星就往外走。站在火里不动是
   *     最致命的低级错误，也是新手最容易看出「这 AI 是木头」的一幕。
   *   · **进场** —— 够不着就往前走（P1a 既有行为）。
   *
   * ★ 难度门：easy 不躲圈（保持木桩手感，与它不打断同源）。
   *
   * ⚠️⚠️ **「远程被贴脸就后退」（风筝）实现过，实测后回滚 —— 规则不支持它。**
   *   P1b 首版加了 `d < reach*0.5 → forward:-1`，基线从 52.4pp 恶化到
   *   **85.7pp**：法师 21.4→14.3、牧师 69.0→28.6。分离验证（只关风筝、
   *   保留躲圈）当场回到 52.4pp，元凶确凿。
   *
   *   根因是**两条规则的乘积**，不是实现 bug：
   *     · 后退只有 65% 速度（`BACKWARD_FACTOR`）→ 追不掉 100% 速度的近战
   *     · 移动打断读条（7.3）→ 风筝全程读不完任何条
   *   于是纯后退 = 自我封印主要输出/治疗（法师霜矢、牧师全部治疗都是读条），
   *   却又拉不开距离。**真人的风筝是「先控住（新星/减速）再退再读条」的
   *   组合技，不是无脑后退** —— 那需要「控制命中后才进入后撤窗口」的条件
   *   逻辑，是独立一笔工作（总账 B1 余账）。在它做出来之前，不后退才是
   *   这套规则下的正确打法。
   */
  const dodgeDir = difficulty === 'easy' ? undefined : (() => {
    const dangers = dangersUnderfoot(p);
    if (dangers.length === 0) return undefined;
    // 多片重叠时躲**最近的圆心**那片（离出圈最近，先脱离它）
    const worst = dangers.reduce((a, b) =>
      distance2D(self.position, a.center) <= distance2D(self.position, b.center) ? a : b);
    return escapeDir(self, worst, yaw);
  })();

  /**
   * ★★ P4「先控再退」—— 上面那段回滚史的**条件版**答案。
   *
   *   纯后退死在两条规则的乘积上（65% 速度追不掉 + 移动断读条）。
   *   但两条里的第一条有一个成立不了的前提：**对手得追得动**。对手被定身/
   *   昏迷/恐惧时，65% 的后退速度追的是一个速度为 0 的人 —— 稳赚。
   *   这正是真人「新星 → 拉开 → 再输出」组合技的后半段。
   *
   *   四道门，少一道都会退化成被打回的那版纯风筝：
   *   · 对手**当前被硬控**（追不上来）—— 不是「我觉得危险」
   *   · 对手拿的是**近战武器** —— 距离只对必须贴脸的人才是硬通货；
   *     对着远程后退换不来安全，只换来自己读条全废（分步归因的教训之二）
   *   · 自己是远程打法（standOff ≥ RANGED_REACH_MIN；近战退了打不到人）
   *   · 距离还没拉到 KITE_TO（12m 绝对值，不是退满 standOff —— 见其注释）
   *
   *   第二条规则（移动断读条）由 `kiting` 旗子处理：后撤窗口内只放瞬发
   *   （见下面各出招步骤的 castableNow）—— 上次惨案的另一半根因。
   *   ★ easy 不风筝，与不打断/不躲圈同源。
   */
  const kiting =
    !dodgeDir &&
    difficulty !== 'easy' &&
    reach >= TACTICS.RANGED_REACH_MIN &&
    !(getWeapon(foe.weaponId)?.isRanged ?? false) &&
    (foe.flags.stunned || foe.flags.rooted || foe.flags.feared) &&
    d < TACTICS.KITE_TO;

  /**
   * ★★ B2「苟住/逃跑」—— **弹尽粮绝时转身满速跑**，hard 专属。
   *
   *   ⚠️ 与上面回滚掉的那版纯风筝**不是同一件事**，差别必须写清楚，
   *   免得下一个人看见「又后退了」就照 85.7pp 那笔账把它删掉：
   *     · 被打回的那版是 `forward: -1` 的**倒走**，吃 65% 速度惩罚
   *       （`BACKWARD_FACTOR`）→ 追不掉 100% 速度的近战；
   *       这版把 yaw 转成背向对手、`forward: 1`，是**满速**跑 ——
   *       速度乘积那一半根因在这里根本不成立。
   *     · 那版是**无条件**的（远程被贴脸就退，normal 也退）；
   *       这版 hard 专属 + 七道门全中才触发，是「已经要死了」的残局动作，
   *       不是常规输出循环里的走位。
   *   （移动断读条那一半根因仍然存在 —— 由 castableNow 处理，见下。）
   *
   *   七道门（缺一不可，每条都对应一次「这时候跑就是送」；列的顺序 = 代码里
   *   短路求值的顺序，最便宜、最常否掉的判断排在前面）：
   *   · `!dodgeDir` —— 站在火里跑路仍然是站在火里，躲圈优先级更高
   *   · **hard 专属** —— 算清「治疗没了、保命没了、他血比我厚」这笔账是
   *     判断力，不是手速；普通人不会算，难度分档调的正是判断力（同 P5 留踢）
   *   · 自己血低于 RETREAT_HEALTH（残局才谈跑，见该常量注释）
   *   · **没有任何可用治疗** —— `usableOn` 走 validateCast，冷却中/没蓝/
   *     被沉默会**一并**判掉：用户要的「结合魔法值与技能冷却」就落在这里，
   *     不需要决策层自己抄一份资源与冷却的镜像。
   *     ⚠️ 这里验的是**奶自己**，B1 的队友治疗刻意不算进来：能奶队友救不了
   *     我的命，把它算成「手里还有牌」只会让残血的我站着不跑也不奶自己
   *   · **没有任何可用保命键** —— 同上。手里还有一张牌就不该跑（而且保命
   *     步骤排在前面，真有牌根本走不到这里）
   *   · 对手拿**近战武器** —— 与 kiting 同一道门：对远程转身跑等于送后背，
   *     距离换不来安全，只换来自己彻底不输出
   *   · **对手血比我厚** —— 互殁竞速时逃跑等于弃权：他也快死了就该拼掉他，
   *     跑掉的每一秒都是把已经打出的伤害白送回去
   */
  const retreating =
    !dodgeDir &&
    difficulty === 'hard' &&
    self.health < self.maxHealth * TACTICS.RETREAT_HEALTH &&
    !skills.some((sk) => isHealSkill(sk) && usableOn(sk, self)) &&
    !skills.some((sk) => isSelfDefenseSkill(sk) && usableOn(sk, self)) &&
    !(getWeapon(foe.weaponId)?.isRanged ?? false) &&
    foe.health > self.health;

  const advance: MovementInput = dodgeDir
    ? { ...toLocalMove(dodgeDir, yaw), jump: false, yaw }
    : retreating
      // ★ 转身：yaw 取「对手 → 自己」方向，配 forward:1 = 满速跑离。
      //   刻意**不**沿用面向对手的 yaw + forward:-1（那就是被打回的倒走）。
      ? { forward: 1, strafe: 0, jump: false, yaw: dirToYaw(sub(self.position, foe.position)) }
      : kiting
        ? { forward: -1, strafe: 0, jump: false, yaw }
        : { forward: d > reach * 0.9 ? 1 : 0, strafe: 0, jump: false, yaw };

  /**
   * 后撤/逃跑窗口内只放瞬发 —— 移动会打断读条（7.3），别自己断自己。
   * ★ 这是 85.7pp 惨案的**另一半**根因：边跑边读 = 读条永远完不成。
   *   B2 的转身跑虽然解决了速度那一半，这一半照样成立，所以同样加这道闸。
   */
  const castableNow = (sk: SkillDef): boolean =>
    !(kiting || retreating) || sk.cast.kind === CastKind.Instant;

  /**
   * ★★ P4 保命：血线告急 → 开保命键（冰封庇护/神圣壁障/龟甲护体/防御架势/
   *   疾闪…）。此前这 33 个增益全是死键 —— bot 血见底了还在硬吃。
   *
   * 两道门：
   *   · 血量 < SURVIVAL_HEALTH（比半血治疗更晚触发 —— 保命键冷却长，
   *     半血就交会在真正要命时空窗）
   *   · **身上没有已生效的保命增益** —— 盾上叠盾是纯浪费，而且 argmax
   *     不会停：不加这道门它会把全部保命键在同一秒连着倒出来
   * ★ easy 不开保命 —— 新手对手挨打站桩，与不打断同源。
   */
  if (
    difficulty !== 'easy' &&
    self.health < self.maxHealth * TACTICS.SURVIVAL_HEALTH &&
    !(p.auras && aurasOf(p.auras, self.id).some((a) => isDefensiveAura(a.def)))
  ) {
    const guard = skills.find(
      (sk) => isSelfDefenseSkill(sk) && castableNow(sk) && usableOn(sk, self),
    );
    if (guard) return { move: advance, cast: { skillId: guard.id, targetId: self.id } };
    /**
     * 交易型保命（龟甲护体：减伤 + 偏转投射物，但期间不能攻击）只在
     * **对面正在读条**时开 —— 这正是它设计上的赢面：壳里吃掉那发大的，
     * 自己损失的输出时间与对面读条重叠，交易划算。无条件低血就缩壳
     * 已被分步归因打回（猎人 23.8→7.1%，缩着挨白字打）。
     */
    if (getCast(casting, foe.id)) {
      const shell = skills.find(
        (sk) =>
          !isHealSkill(sk) &&
          castableNow(sk) &&
          sk.effects.some(
            (e) =>
              e.kind === 'applyAura' &&
              isDefensiveAura(e.aura) &&
              e.aura.flags?.cannotAttack === true,
          ) &&
          usableOn(sk, self),
      );
      if (shell) return { move: advance, cast: { skillId: shell.id, targetId: self.id } };
    }
  }

  /**
   * ★★ **看到敌人读一个可打断的法术 → 打断它。** 这是「会玩」和「木桩」之间
   *   最大的一步：反制链的核心就是打断，而此前打断技能只是随机池里的一个。
   *
   * 条件：敌人在读**可打断**技能、读条已进行 ≥ 本档反应时间、离读完还有余量、
   * 我手上有一个此刻能放的打断技能（在射程/朝向/冷却内）。easy 档反应时间
   * 为 Infinity → 这段永不触发（新手对手不会留打断）。
   * ★ 不消耗 rng —— 纯确定性判断，回放/种子复现不受影响。
   */
  let foeCastingUnkicked = false;
  if (difficulty !== 'easy') {
    const foeCast = getCast(casting, foe.id);
    if (foeCast?.interruptible) {
      const elapsed = world.time - foeCast.startedAt;
      const remaining = (foeCast.channelEndsAt ?? foeCast.endsAt) - world.time;
      if (elapsed >= REACTION_SECONDS[difficulty] && remaining > 0.1) {
        /**
         * ★ P5 hard「留踢」：真人高手不把打断交给随便一条读条 —— 治疗
         *   不论长短都踢（放走一发治疗 = 前面打的白打），但**短读条的
         *   伤害技能不值一个打断冷却**（吃下 100 伤害换手里始终留着踢，
         *   下一发治疗/大招才是它的战场）。normal 保持「看条就踢」——
         *   两档的差别从「反应快慢」扩展到「判断好坏」，这正是难度该有的样子。
         * ★ 判据用**实际读条时长**（endsAt-startedAt，含施法速度修正），
         *   不是数据表里的名义值 —— bot 看到的和真人看到的是同一根条。
         */
        const beingCast = getSkill(foeCast.skillId);
        const worthKicking =
          difficulty !== 'hard' ||
          beingCast === undefined ||
          isHealSkill(beingCast) ||
          foeCast.endsAt - foeCast.startedAt >= TACTICS.KICK_WORTH_CAST_SECONDS;
        if (worthKicking) {
          const kick = offensive.find(isInterruptSkill);
          if (kick) return { move: advance, cast: { skillId: kick.id, targetId: foe.id } };
          // 没踢可用但对面在读 —— 下面的控制步骤拿它当替补打断的触发条件
          foeCastingUnkicked = true;
        }
      }
    }
  }

  /**
   * ★★ P4 控制：破胆怒吼/致盲/霜爆新星/缠根…（10 个纯控制键）此前从未被按。
   *
   * 时机（其一即可，全部与「我为什么现在要控他」对得上）：
   *   · 替补打断 —— 对面在读条而我没踢（控制打断读条的效果一样）
   *   · peel —— 对手贴脸而我是远程（控住才能拉开，见上面 kiting 的组合技）
   *   · 锁杀 —— 对手血量进击杀窗口（控住让他放不了保命/治疗）
   *   · 自保 —— 我自己血线不稳（控住换喘息）
   *
   * 三道门（少一道就会看起来「蠢」）：
   *   · 递减 ≥ DR_MIN_FACTOR —— 半衰以下的控制不值一个公共冷却；
   *     免疫（factor 0）绝不空放（8.2 的免疫窗口对空放不推进计数，
   *     但 GCD 与资源是真的丢了）
   *   · 对手未被硬控 —— 控上叠控 = 浪费自己的 DR 预算
   *   · 对手没开完全免疫（8.4 圣盾/冰箱期间一切控制落空）
   *
   * ★ 沉默不会从这里出手 —— 不是遗漏：全花名册唯一的 silence 效果长在
   *   牧师「沉默」里，而它**同时带 interrupt**，被 `ccCategoryOf` 划给了
   *   打断步骤（踢要留着踢读条）。若将来加入纯沉默技能，这里需要补一道
   *   「对手用蓝才出手」的门（对战士沉默是字面意义的空气）—— 现在不写，
   *   写了也是一条永不执行的死分支（本仓库的老病：规则写对了没人调）。
   */
  if (
    difficulty !== 'easy' &&
    !foe.flags.stunned &&
    !foe.flags.feared &&
    !foe.flags.immuneAll
  ) {
    /**
     * ★★ W23 后试过「替补打断要算飞行时间」——**实现后回滚**（P1b 风筝同款结局）。
     *   假设：变形术 25m 要飞 0.45s，`remaining` 不够时 CC 落地条已读完，
     *   「白丢 GCD 白吃 DR」→ 应拦。实测（种子 1）：法师 16.7→9.5pp、
     *   极差 78.6→83.3，死骑（原嫌疑对象）分毫未动 —— 假设错在
     *   **迟到的控制不是白丢**：晚半秒落地的变形照样吃满持续时间，拦掉它
     *   bot 只会改放伤害填充，净减控制覆盖率。死骑的 W23 下行另有根因
     *   （待诊断，见总账 W23 行）。`botController.test.ts` 的
     *   「W23b 迟到的控制仍会出手」反向测试钉着这条结论 —— 想再拦，先去
     *   让那条测试有更好的理由变红。
     */
    const wantCc =
      foeCastingUnkicked ||
      (d <= TACTICS.PEEL_RANGE && reach >= TACTICS.RANGED_REACH_MIN) ||
      foe.health < foe.maxHealth * TACTICS.CC_KILL_WINDOW ||
      self.health < self.maxHealth * TACTICS.CC_SELF_DANGER;
    if (wantCc) {
      const cc = offensive.find((sk) => {
        const cat = ccCategoryOf(sk);
        if (cat === undefined || !castableNow(sk)) return false;
        if (cat === DrCategory.Root && foe.flags.rooted) return false; // 定身叠定身同样是浪费
        const factor = p.dr ? drFactor(p.dr, foe.id, cat, world.time) : 1;
        return factor >= TACTICS.DR_MIN_FACTOR;
      });
      if (cc) return { move: advance, cast: { skillId: cc.id, targetId: foe.id } };
    }
  }

  /**
   * ★★ P4 驱散：净化术/自由庇佑/群体净化（4 个驱散键）此前从未被按。
   *
   * 规则自成闭环：**按下去能清掉东西才按**（`dispelEligible` —— 与结算侧
   * `dispel()` 共用同一份资格判定，不另抄一套会漂移的镜像）。
   *   · 队向（from:'ally'）→ 清自己身上的减益
   *   · 敌向（from:'enemy'）→ 偷对手身上的增益
   * 没有可清目标就绝不按 —— 这一条保证它几乎不可能打崩基线。
   */
  if (difficulty !== 'easy' && p.auras) {
    for (const sk of skills) {
      if (!castableNow(sk)) continue;
      for (const e of sk.effects) {
        if (e.kind !== 'dispel') continue;
        const selector = { types: e.types, impairs: e.impairs };
        if (e.from === 'ally') {
          if (
            dispelEligible(p.auras, self.id, selector, 'debuff', e.canRemoveImmunity).length >
              0 &&
            usableOn(sk, self)
          ) {
            return { move: advance, cast: { skillId: sk.id, targetId: self.id } };
          }
        } else if (
          dispelEligible(p.auras, foe.id, selector, 'buff', e.canRemoveImmunity).length > 0 &&
          usableOn(sk, foe)
        ) {
          return { move: advance, cast: { skillId: sk.id, targetId: foe.id } };
        }
      }
    }
  }

  /**
   * ★★ **半血治疗 —— B1 起会奶队友，不再只奶自己。**
   *
   *   用户反馈原话：「BOT 都是单独行动，团队 PK 没有配合逻辑」。三个治疗职业
   *   守着一手队伍治疗只往自己身上按，是这句话里最大的一个单点缺失。
   *
   * ⚠️⚠️ **改这段之前先读 `usableOn` 上面那条 P3 教训**：早期版本拿 `foe` 去
   *   验治疗，于是 `TargetFilter.Ally` 的技能永远验不过 —— 三个治疗职业
   *   HPS 恒为 0，基线里「治疗职业」根本不存在。所以这里给队友治疗走的是
   *   **同一个 `usableOn`、以队友为目标**：Ally 过滤、射程、视线、蓝量、
   *   冷却、沉默全部由 `validateCast` 一次判掉，**不开第二条施法通道**。
   *
   *   ★ 顺序 = `healTargets` 排好的「越残越靠前」，逐个试到第一个验得过的：
   *     残血队友站在 40 米外（超出 30 米治疗射程）时不会白等，会退回来奶自己。
   *   ★ 治疗技能本身仍随机挑 —— 三个奶技能差异不大，权重不值得建模。
   *     ⚠️ `rng()` 只在**真的要出手**时消耗（列表空 / 一个都验不过就不动它）：
   *     这是老行为的逐位前提，动了它 `pnpm balance` 的 168 场会整体漂移。
   *   ★ P4：后撤窗口内只挑瞬发治疗（castableNow）—— 读条治疗留到拉开之后。
   *   ★ easy 不奶队友（`allies` 直接不看，只剩自己）—— 与它不打断/不躲圈/
   *     不参与集火呼叫同一条难度门：easy 卖的是木桩手感，配合是判断力。
   */
  for (const ally of healTargets(self, difficulty === 'easy' ? undefined : p.allies)) {
    const heals = skills.filter((sk) => isHealSkill(sk) && castableNow(sk) && usableOn(sk, ally));
    if (heals.length === 0) continue;
    const pick = heals[Math.floor(rng() * heals.length)]!;
    return { move: advance, cast: { skillId: pick.id, targetId: ally.id } };
  }

  /**
   * ★★ P4 位移：6 个位移键此前从未被按。分两种打法，方向相反：
   *   · **远程被贴脸** → 后撤跃（瞬间拉开 6 米）；没有就开加速爆发。
   *     与上面的 kiting 是同一套「拉开」棋路的两枚子。
   *   · **近战够不着** → 突进/背刺传送贴上去；都在冷却里就开加速追。
   *     方向与 advance 一致，只是把「跑 12 米」换成「一瞬到位」——
   *     多出来的全是输出时间，这也是四类位移里风险最低的一条。
   * ★ 后撤跃/加速目标是自己，冲锋目标是对手 —— usableOn 分别验。
   */
  if (difficulty !== 'easy') {
    /**
     * ★ P9 补全：**逃跑的人自己也要开加速**。retreating（hard 苟住）的
     *   转身满速跑与追击者同速 —— 对面一个冲锋就贴回来了。开着疾跑跑路
     *   才真的拉得开；这也是疾跑「追击与撤离两用」里撤离那一半的兑现。
     *   放在 peel/chase 之前：正在逃命时别的位移棋都不成立。
     */
    if (retreating) {
      const burst = skills.find(
        (sk) => isSpeedBurstSkill(sk) && castableNow(sk) && usableOn(sk, self),
      );
      if (burst) return { move: advance, cast: { skillId: burst.id, targetId: self.id } };
    }
    if (d <= TACTICS.PEEL_RANGE && reach >= TACTICS.RANGED_REACH_MIN) {
      const out =
        skills.find((sk) => isEscapeSkill(sk) && castableNow(sk) && usableOn(sk, self)) ??
        skills.find((sk) => isSpeedBurstSkill(sk) && castableNow(sk) && usableOn(sk, self));
      if (out) return { move: advance, cast: { skillId: out.id, targetId: self.id } };
    }
    if (d > TACTICS.GAP_CLOSE_MIN_D && reach < TACTICS.RANGED_REACH_MIN) {
      /**
       * ★★ 两级，次序不能反：**瞬间到位永远优于跑过去。**
       *   冲锋/背刺传送是一个 tick 内贴上去，之后每一秒都在输出；加速只是
       *   把追击那几秒从 100% 变成 160%，路还是要跑的（何况对手也在跑）。
       *   gap closer 可用时开加速 = 白扔一个长冷却换一段本可以省掉的路。
       * ⚠️ 背景：此前这里**只有** gap closer 一支 —— 冲锋/影袭步一进冷却，
       *   近战手里的加速键就是**死键**，对着会跑的人干瞪眼。P8 hard 的
       *   「苟住」（B2 转身满速跑）恰恰把这一幕变成常态：追不上就等于
       *   对面白嫖一整段回血/拉扯时间。加速正是这条残局的解，bot 得会按。
       * ★ 目标是自己（加速是自身增益），与上面远程那支同理 —— usableOn 验 self；
       *   也因此它不在 `offensive`（那份是按对手验的）里找，得回 `skills` 全集。
       */
      const closer = offensive.find((sk) => isGapCloserSkill(sk) && castableNow(sk));
      if (closer) return { move: advance, cast: { skillId: closer.id, targetId: foe.id } };
      const dash = skills.find(
        (sk) => isSpeedBurstSkill(sk) && castableNow(sk) && usableOn(sk, self),
      );
      if (dash) return { move: advance, cast: { skillId: dash.id, targetId: self.id } };
    }
  }

  // 有伤害技能可用时优先输出，否则退而求其次放别的（增益/控制）
  // ★ P4：后撤窗口内只放瞬发（castableNow）—— 移动断读条，别自己断自己
  const damaging = offensive.filter((sk) => hasDamage(sk) && castableNow(sk));
  const pool = damaging.length > 0 ? damaging : offensive.filter(castableNow);
  if (pool.length === 0) return { move: advance };

  /**
   * ★★ 出招选择按难度分家：
   *   · easy —— 均匀随机（保留旧木桩行为：90 秒大招和填充技能同概率，
   *     该放大招的时机放小技能，正是新手对手的样子）
   *   · normal/hard —— **用当前可用技能里单发最狠的**（burstDamageOf）。
   *     冷却感知不需要显式建模：大招在冷却里就不在 `offensive`（validateCast
   *     已滤掉），一转好它的单发威力自然登顶被选中 —— 填充技能只在大招
   *     不可用时顶上。
   *   ★ 已在对手身上跳着的 DoT **不重复计权**（`dotsAlreadyOn`）——
   *     否则零冷却 DoT 会永远登顶，bot 一个 GCD 都不放别的。
   *     该行为的完整来龙去脉见 `totalDamageOf` 里的注释。
   */
  const ticking = dotsAlreadyOn(p.auras, foe.id, world.time);
  const pick = difficulty === 'easy'
    ? pool[Math.floor(rng() * pool.length)]!
    : pool.reduce((best, sk) =>
        burstDamageOf(sk, self, ticking) > burstDamageOf(best, self, ticking) ? sk : best);
  return { move: advance, cast: { skillId: pick.id, targetId: foe.id } };
};
