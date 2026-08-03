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
import { isCasting, validateCast, type CastingStore } from '../sim/casting.js';
import { magnitudeOf } from '../sim/effects/combat.js';
import type { CombatEntity } from '../sim/entity.js';
import type { MovementInput } from '../sim/movement.js';
import type { CastIntent } from '../sim/tick.js';
import type { World } from '../sim/world.js';

// ── 站位（AI 的「打多远」）─────────────────────────────────────────

/** 一个伤害技能的**名义**持续 DPS：只用于站位估算，不进任何结算 */
export const nominalDps = (sk: SkillDef, self: CombatEntity): number => {
  let perCast = 0;
  for (const e of sk.effects) {
    if (e.kind === 'damage') perCast += magnitudeOf(e.amount, self);
    if (e.kind === 'spawnProjectile') {
      for (const h of e.onHit) if (h.kind === 'damage') perCast += magnitudeOf(h.amount, self);
    }
    // 光环周期伤按整段跳完计（站位粗估用，够了）
    if (e.kind === 'applyAura' && e.aura.periodic) {
      const ticks = Math.floor(e.aura.duration / e.aura.periodic.interval);
      for (const h of e.aura.periodic.effects) {
        if (h.kind === 'damage') perCast += magnitudeOf(h.amount, self) * ticks;
      }
    }
  }
  // 节奏 = 冷却 / 读条 / 公共冷却的最大者。资源节流不进估算 —— 这是站位
  // 用的粗粒度权重，不是伤害模型
  return perCast / Math.max(sk.cooldown, sk.cast.time, 1.5);
};

export const isHealSkill = (sk: SkillDef): boolean =>
  sk.effects.some((e) =>
    e.kind === 'heal' || e.kind === 'healPercentMaxHealth' || e.kind === 'healFromRecentDamage');

/**
 * 技能是否**产出伤害** —— 直伤、投射物命中、或光环周期伤（DoT）。
 * ⚠️ 少了第三类时，战士的剑刃风暴（伤害全在光环 periodic 里，4 秒 8 跳）
 *   被 AI 当成杂项增益，几乎从不进输出循环 —— 他最大的爆发键躺着不用。
 */
export const hasDamage = (sk: SkillDef): boolean =>
  sk.effects.some((e) =>
    e.kind === 'damage' ||
    (e.kind === 'spawnProjectile' && e.onHit.some((h) => h.kind === 'damage')) ||
    (e.kind === 'applyAura' &&
      (e.aura.periodic?.effects.some((h) => h.kind === 'damage') ?? false)));

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
}

/** 一次决策的产出 —— 与真人的两条通道同构 */
export interface BotAction {
  move: MovementInput;
  cast?: CastIntent;
}

/**
 * 极简 AI：面向对手、打不到就往前走、半血以下先保命、能输出就输出。
 */
export const decideBotAction = (p: BotPerception): BotAction => {
  const { world, casting, self, foe, rng } = p;
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
  const move: MovementInput = { forward: d > reach * 0.9 ? 1 : 0, strafe: 0, jump: false, yaw };

  // 半血以下且有治疗可用 → 先保命。这是「同等操作水平」的底线共识，
  // 不属于反制链博弈（那些 AI 依然不会，见文件头）
  if (self.health < self.maxHealth * 0.5) {
    const heals = skills.filter((sk) => isHealSkill(sk) && usableOn(sk, self));
    if (heals.length > 0) {
      const pick = heals[Math.floor(rng() * heals.length)]!;
      return { move, cast: { skillId: pick.id, targetId: self.id } };
    }
  }

  // 有伤害技能可用时优先输出，否则退而求其次放别的（增益/控制）
  const damaging = offensive.filter(hasDamage);
  const pool = damaging.length > 0 ? damaging : offensive;
  if (pool.length === 0) return { move };
  const pick = pool[Math.floor(rng() * pool.length)]!;
  return { move, cast: { skillId: pick.id, targetId: foe.id } };
};
