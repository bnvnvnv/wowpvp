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
 *   不会假读条骗打断、不会留打断、不会绕柱走位、不会换目标、不会选地面落点。
 *   它是「同等操作水平的下限」，用来当靶子和回归基线，不是用来演示反制链的。
 */

// ★ 逐模块 import 而不是从 `../index.js` —— index 现在也导出本文件，
//   走 index 会形成循环依赖。
import { ALL_CLASSES, getWeapon } from '../data/index.js';
import type { SkillDef } from '../data/schema.js';
import { CastFailure } from '../types/enums.js';
import { dirToYaw, distance2D, sub } from '../math/vec3.js';
import { getCast, isCasting, validateCast, type CastingStore } from '../sim/casting.js';
import { magnitudeOf } from '../sim/effects/combat.js';
import type { CombatEntity } from '../sim/entity.js';
import type { MovementInput } from '../sim/movement.js';
import type { CastIntent } from '../sim/tick.js';
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
const totalDamageOf = (sk: SkillDef, self: CombatEntity): number => {
  let sum = 0;
  for (const e of sk.effects) {
    if (e.kind === 'damage') sum += magnitudeOf(e.amount, self);
    if (e.kind === 'spawnProjectile') {
      for (const h of e.onHit) if (h.kind === 'damage') sum += magnitudeOf(h.amount, self);
    }
    if (e.kind === 'applyAura' && e.aura.periodic) {
      const ticks = Math.floor(e.aura.duration / e.aura.periodic.interval);
      for (const h of e.aura.periodic.effects) {
        if (h.kind === 'damage') sum += magnitudeOf(h.amount, self) * ticks;
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
export const hasDamage = (sk: SkillDef): boolean =>
  sk.effects.some((e) =>
    e.kind === 'damage' ||
    (e.kind === 'spawnProjectile' && e.onHit.some((h) => h.kind === 'damage')) ||
    (e.kind === 'applyAura' &&
      (e.aura.periodic?.effects.some((h) => h.kind === 'damage') ?? false)) ||
    (e.kind === 'spawnGroundArea' &&
      (e.onTick?.some((h) => h.kind === 'damage') ?? false)) ||
    (e.kind === 'delayedGroundImpact' && e.onImpact.some((h) => h.kind === 'damage')));

/** 是否是一个专用打断技能（效果里带 interrupt）*/
export const isInterruptSkill = (sk: SkillDef): boolean =>
  sk.effects.some((e) => e.kind === 'interrupt');

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
export const burstDamageOf = (sk: SkillDef, self: CombatEntity): number =>
  totalDamageOf(sk, self);

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
export const standOff = (self: CombatEntity, skills: readonly SkillDef[]): number => {
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

// ── 决策 ─────────────────────────────────────────────────────────

/** 一次决策需要看到的全部东西。★ 只读 —— 这个模块拿不到任何写入口 */
export interface BotPerception {
  world: World;
  casting: CastingStore;
  self: CombatEntity;
  /**
   * 当前对手。
   * ⚠️ 本版只支持**单目标**：选敌 / 换目标 / 保队友都还没有，
   *   3v3 与 12v12 要用必须先补这一块（docs/14 §M16b）。
   */
  foe: CombatEntity;
  /**
   * 0..1 随机源。★ **必须由调用方注入**：sim 的确定性（回放、
   * `pnpm balance` 的种子复现）依赖这里不出现 `Math.random()`。
   */
  rng: () => number;
  /** 难度档。不传 = `normal`（balance-report 与老调用方走这个默认）*/
  difficulty?: BotDifficulty;
}

/** 一次决策的产出 —— 与真人的两条通道同构 */
export interface BotAction {
  move: MovementInput;
  cast?: CastIntent;
}

/**
 * AI：面向对手、按站位保持距离、**看到读条就打断**、半血保命、
 * 用当前可用技能里最狠的一发输出。难度档决定「会不会/多快打断」。
 *
 * ★ 仍然不会的事（P1b 之后再补）：风筝后撤、躲地面 AOE、换目标、选落点。
 *   它现在是「会打断、会挑技能的普通对手」，不再是「随机按键的木桩」。
 */
export const decideBotAction = (p: BotPerception): BotAction => {
  const { world, casting, self, foe, rng } = p;
  const difficulty = p.difficulty ?? 'normal';
  const yaw = dirToYaw(sub(foe.position, self.position));
  const d = distance2D(self.position, foe.position);

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

  const skills = ALL_CLASSES.find((c) => c.id === self.classId)?.skills ?? [];
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
  /** 站位移动：够不着就往前走（风筝后撤是 P1b 的账）*/
  const advance: MovementInput = { forward: d > reach * 0.9 ? 1 : 0, strafe: 0, jump: false, yaw };

  /**
   * ★★ **看到敌人读一个可打断的法术 → 打断它。** 这是「会玩」和「木桩」之间
   *   最大的一步：反制链的核心就是打断，而此前打断技能只是随机池里的一个。
   *
   * 条件：敌人在读**可打断**技能、读条已进行 ≥ 本档反应时间、离读完还有余量、
   * 我手上有一个此刻能放的打断技能（在射程/朝向/冷却内）。easy 档反应时间
   * 为 Infinity → 这段永不触发（新手对手不会留打断）。
   * ★ 不消耗 rng —— 纯确定性判断，回放/种子复现不受影响。
   */
  if (difficulty !== 'easy') {
    const foeCast = getCast(casting, foe.id);
    if (foeCast?.interruptible) {
      const elapsed = world.time - foeCast.startedAt;
      const remaining = (foeCast.channelEndsAt ?? foeCast.endsAt) - world.time;
      if (elapsed >= REACTION_SECONDS[difficulty] && remaining > 0.1) {
        const kick = offensive.find(isInterruptSkill);
        if (kick) return { move: advance, cast: { skillId: kick.id, targetId: foe.id } };
      }
    }
  }

  // 半血以下且有治疗可用 → 先保命。这是「同等操作水平」的底线共识，
  // 不属于反制链博弈。治疗仍随机挑 —— 三个奶技能差异不大，权重不值得建模
  if (self.health < self.maxHealth * 0.5) {
    const heals = skills.filter((sk) => isHealSkill(sk) && usableOn(sk, self));
    if (heals.length > 0) {
      const pick = heals[Math.floor(rng() * heals.length)]!;
      return { move: advance, cast: { skillId: pick.id, targetId: self.id } };
    }
  }

  // 有伤害技能可用时优先输出，否则退而求其次放别的（增益/控制）
  const damaging = offensive.filter(hasDamage);
  const pool = damaging.length > 0 ? damaging : offensive;
  if (pool.length === 0) return { move: advance };

  /**
   * ★★ 出招选择按难度分家：
   *   · easy —— 均匀随机（保留旧木桩行为：90 秒大招和填充技能同概率，
   *     该放大招的时机放小技能，正是新手对手的样子）
   *   · normal/hard —— **用当前可用技能里单发最狠的**（burstDamageOf）。
   *     冷却感知不需要显式建模：大招在冷却里就不在 `offensive`（validateCast
   *     已滤掉），一转好它的单发威力自然登顶被选中 —— 填充技能只在大招
   *     不可用时顶上。
   *   ⚠️ 已知取舍：DoT 按整段总量计权，AI 会在 DoT 未掉时覆盖重挂（月火
   *     CD 一转好就再挂）—— 普通玩家同款低效，不值得为此建模 DoT 追踪。
   */
  const pick = difficulty === 'easy'
    ? pool[Math.floor(rng() * pool.length)]!
    : pool.reduce((best, sk) => (burstDamageOf(sk, self) > burstDamageOf(best, self) ? sk : best));
  return { move: advance, cast: { skillId: pick.id, targetId: foe.id } };
};
