/**
 * 配平数据采集：跑 N 场 1v1 对决，输出可复现的对局数据。
 *
 * ★★ **这个脚本不调数字，它只产生「调数字的依据」。**
 *
 *   路线图对 M11 数值配平的判据是「配平有**可复现的对局数据**支撑，
 *   不是凭感觉调数字」（docs/13）。这份脚本就是那个「可复现」的来源 ——
 *   调成什么样是设计判断，不在这里做。
 *
 * ★ 可复现的前提：**`packages/shared` 里没有一处 `Math.random()`**。
 *   模拟在给定输入下完全确定，所以只要 AI 的选择是种子驱动的，
 *   同一个种子就必然得到同一份报告。`--seed` 默认 1。
 *
 * ⚠️ **这份数据能说明什么、不能说明什么：**
 *   · 能说明：同等操作水平下，谁在**纯对拼**里占优、平均击杀耗时的量级
 *   · **不能**说明：真实对局的强弱 —— 这里没有走位、没有视线利用、
 *     没有队友配合、没有打断博弈（AI 不会假读条也不会留打断）。
 *     8.x 的反制链是这个游戏的核心，而它**恰恰是 AI 最不会用的部分**。
 *   所以：把它当**回归基线**（改一个数值后谁动了多少），
 *   而不是当「平衡性结论」。
 *
 * 用法：
 *   npx tsx scripts/balance-report.ts [--seed 1] [--rounds 3] [--json]
 */

import {
  ALL_CLASSES, CastFailure, GameMode, SIM, TEAM_BLUE, TEAM_RED,
  addEntity, allocEntityId, createArena, createArsenalStore, createAuraStore,
  createCastingStore, createDrStore, createEntity, createGroundStore, createLoadout,
  createLoadoutStore, createMovementState, createProjectileStore, createPickupStore,
  createSwapStore, createSwingStore, beginSwing, createWorld, distance2D, dirToYaw,
  getSkill, getWeapon, isCasting, magnitudeOf, sub, tickWorld,
  validateCast, vec3, ArenaPreset,
  type CastIntent, type ClassDef, type CombatEntity, type EntityId,
  type MovementState, type SkillDef, type TickDeps, type World,
} from '../packages/shared/src/index.ts';
import { box } from '../packages/shared/src/data/maps/schema.ts';

// ── 参数 ─────────────────────────────────────────────────────────

const arg = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
};
const SEED = arg('seed', 1);
const ROUNDS = arg('rounds', 3);
const AS_JSON = process.argv.includes('--json');
/** 打印对阵矩阵（行视角的胜场/总场）。配平时定位「谁在收割谁」用 */
const AS_MATRIX = process.argv.includes('--matrix');
/** 只跑一对并输出每场明细（`--pair rogue,warrior`）。定位「他怎么赢的」用 */
const PAIR = ((): [string, string] | undefined => {
  const i = process.argv.indexOf('--pair');
  const raw = i >= 0 ? process.argv[i + 1] : undefined;
  if (!raw) return undefined;
  const [a, b] = raw.split(',');
  return a && b ? [a, b] : undefined;
})();

/**
 * 种子化 PRNG（mulberry32）。
 * ★ 用它而不是 `Math.random()`，否则这份报告不可复现，
 *   也就不满足「可复现的对局数据」这条判据。
 */
const rngFrom = (seed: number) => {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const MAX_SECONDS = 90;
const START_DISTANCE = 12;

// ── 站位（AI 的「打多远」）─────────────────────────────────────────

/** 一个伤害技能的**名义**持续 DPS：只用于站位估算，不进任何结算 */
const nominalDps = (sk: SkillDef, self: CombatEntity): number => {
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

const isHealSkill = (sk: SkillDef): boolean =>
  sk.effects.some((e) =>
    e.kind === 'heal' || e.kind === 'healPercentMaxHealth' || e.kind === 'healFromRecentDamage');

/**
 * 技能是否**产出伤害** —— 直伤、投射物命中、或光环周期伤（DoT）。
 * ⚠️ 少了第三类时，战士的剑刃风暴（伤害全在光环 periodic 里，4 秒 8 跳）
 *   被 AI 当成杂项增益，几乎从不进输出循环 —— 他最大的爆发键躺着不用。
 */
const hasDamage = (sk: SkillDef): boolean =>
  sk.effects.some((e) =>
    e.kind === 'damage' ||
    (e.kind === 'spawnProjectile' && e.onHit.some((h) => h.kind === 'damage')) ||
    (e.kind === 'applyAura' &&
      (e.aura.periodic?.effects.some((h) => h.kind === 'damage') ?? false)));

/**
 * ★★ 站位：**保有至少六成火力的前提下站得越远越好。**
 *
 * 前两版的教训都在 think() 里注释着；第三版「够着此刻可用的最远伤害技能」
 * 修好了战士，却把猎人钉在 35 米 —— 瞄准射击（35m）可用时他站在弓（28m）
 * 射程之外，白字全程落空，DPS 反而掉到白字理论值以下。
 *
 * 通用规则：把「武器触及 + 各伤害技能射程」当候选站位，给每个站位算
 * 「站在这里还打得出的名义 DPS」（白字 + 技能），**取火力 ≥ 最大值 60% 的
 * 最远者**。八职业各得其所：法师留在 32 米（放弃近战斩的 12%，保距离），
 * 猎人站 25 米（弓/秘法箭/瞄准全部在射程内），圣骑士/战士走进近战
 * （远程件只有全火力的两三成，过不了线）。
 * ⚠️ 60% 是站位偏好的阈值，不是平衡参数 —— 它只决定 AI 站哪，不改任何结算。
 */
const standOff = (self: CombatEntity, skills: readonly SkillDef[]): number => {
  const w = getWeapon(self.weaponId);
  const whiteDps = w ? (w.swingPercent * 100) / w.swingInterval : 0;
  const damaging = skills.filter((sk) => sk.targeting !== 'ground' && !isHealSkill(sk) && hasDamage(sk));

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

// ── 一场对决 ─────────────────────────────────────────────────────

interface DuelResult {
  winner: 'a' | 'b' | 'draw';
  seconds: number;
  damage: Record<'a' | 'b', number>;
  healing: Record<'a' | 'b', number>;
  casts: Record<'a' | 'b', number>;
  /** `--pair` 明细：双方每个技能被选择的次数 */
  picks: Record<'a' | 'b', Map<string, number>>;
}

/**
 * 一块地板。
 *
 * ⚠️ **不能用 `createWorld([])`。** 没有地面时两个角色会一直自由下落，
 *    而 `stepMovement` 在空中有速度上限（`airSpeedCap`）—— 于是**近战永远
 *    贴不上去**。第一版就是这么写的，跑出来战士/死骑 0% 胜率、
 *    伤害只有远程的十分之一，看着像「近战太弱」，实际是**他们在坠落**。
 */
const FLOOR = box('floor', 'floor', { x: 0, y: -1, z: 0 }, { w: 400, h: 1, d: 400 });

const duel = (clsA: ClassDef, clsB: ClassDef, rng: () => number): DuelResult => {
  const world: World = createWorld([FLOOR]);
  const auras = createAuraStore();
  const loadouts = createLoadoutStore();
  const movement = new Map<EntityId, MovementState>();

  const spawn = (cls: ClassDef, team: typeof TEAM_RED, z: number): CombatEntity => {
    const e = addEntity(world, createEntity(allocEntityId(world), cls, team, vec3(0, 0, z)));
    loadouts.set(e.id, createLoadout(e.classId));
    movement.set(e.id, createMovementState(e.position));
    for (const [r, max] of e.maxResources) e.resources.set(r, max);
    return e;
  };

  const a = spawn(clsA, TEAM_RED, 0);
  const b = spawn(clsB, TEAM_BLUE, -START_DISTANCE);
  a.targets.hard = b.id; b.targets.hard = a.id;

  const damage = { a: 0, b: 0 };
  const healing = { a: 0, b: 0 };
  const casts = { a: 0, b: 0 };
  const picks = { a: new Map<string, number>(), b: new Map<string, number>() };
  const sideOf = (id: EntityId): 'a' | 'b' => (id === a.id ? 'a' : 'b');

  /**
   * ★★ **全部容器必须建一次、跨 tick 复用。**
   *
   *   ⚠️ 第一版把 `dr` / `ground` / `projectiles` 建在 `deps()` **里面**，
   *      而 `deps()` 每 tick 调一次 —— 于是：
   *      · **投射物每 tick 被清空**，寒冰箭、瞄准射击之类永远飞不到目标
   *      · 地面区域（暴风雪、陷阱）每 tick 重置，一跳都不会响
   *      · 递减（8.2）永远不累计，控制可以无限连
   *      跑出来的数字看着像「职业强弱」，实际是「谁的技能不依赖投射物」。
   *      **一份错的基线比没有基线更糟。**
   */
  const dr = createDrStore();
  const ground = createGroundStore();
  const projectiles = createProjectileStore();
  const casting = createCastingStore();
  const swaps = createSwapStore();
  const pickups = createPickupStore();
  const arsenal = createArsenalStore(ArenaPreset.Classic);
  const arena = createArena({ mode: GameMode.Arena3v3, roundsToWin: 1 });
  // ★ M11 实现了 7.6 普通攻击 —— 登记两边，否则战士仍然没有怒气来源
  const swings = createSwingStore();

  const deps = (
    inputs: Map<EntityId, { forward: number; strafe: number; jump: boolean; yaw: number }>,
    castRequests: Map<EntityId, CastIntent>,
  ): TickDeps => ({
    world, auras, dr, ground, projectiles, casting, loadouts, swings,
    swaps, pickups, arsenal,
    movement, inputs, castRequests, getSkill,
    arena,
  });

  /**
   * 极简 AI：面向对手、打不到就往前走、半血以下先保命、能输出就输出。
   * ⚠️ 它**不会**假读条、不会留打断、不会绕柱 —— 见文件头的 ⚠️。
   */
  const think = (
    self: CombatEntity, foe: CombatEntity,
  ): { move: { forward: number; strafe: number; jump: boolean; yaw: number }; cast?: CastIntent } => {
    const yaw = dirToYaw(sub(foe.position, self.position));
    const d = distance2D(self.position, foe.position);

    /**
     * ★★ **读条期间不出手。**
     *   ⚠️ 第三版之前没有这条 —— 于是瞄准射击起手后的 32 个 tick 里，
     *      AI 继续对唯一还「可用」的免公共冷却技能（断法箭）发起新施法，
     *      每一次都把读条中的瞄准射击顶掉重来：**读条技能永远完不成**。
     *      诊断脚本抓到的样子是：断法箭被选中 43 次却一次都没进冷却、
     *      猎人 DPS 恰好等于白字理论值 —— 法师冰枪/牧师惩击/圣光术同病。
     *      读条中站着不动、等它完成，是任何操作水平的底线，与反制链无关。
     */
    if (isCasting(casting, self.id)) {
      return { move: { forward: 0, strafe: 0, jump: false, yaw } };
    }

    const skills = ALL_CLASSES.find((c) => c.id === self.classId)!.skills;
    /**
     * ★ 治疗要按**自己**为目标验，进攻要按**对手**为目标验。
     *   ⚠️ 第二版之前全部技能都拿 foe 去 validateCast —— 于是 TargetFilter.Ally
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
    const move = { forward: d > reach * 0.9 ? 1 : 0, strafe: 0, jump: false, yaw };

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

  const maxTicks = Math.ceil(MAX_SECONDS / SIM.TICK_DT);
  for (let t = 0; t < maxTicks; t++) {
    if (!a.alive || !b.alive) break;

    const inputs = new Map<EntityId, { forward: number; strafe: number; jump: boolean; yaw: number }>();
    const requests = new Map<EntityId, CastIntent>();
    for (const [self, foe] of [[a, b], [b, a]] as const) {
      const r = think(self, foe);
      inputs.set(self.id, r.move);
      if (r.cast) {
        requests.set(self.id, r.cast);
        casts[sideOf(self.id)]++;
        const m = picks[sideOf(self.id)];
        m.set(r.cast.skillId as string, (m.get(r.cast.skillId as string) ?? 0) + 1);
      }
    }

    // 4.x：有敌方硬目标即开火（与 MatchLoop.syncSwings 同一判据）。
    // ★ beginSwing 幂等，不会刷新节奏；首击间隔与真实对局一致取武器值
    beginSwing(swings, a.id, world.time, getWeapon(a.weaponId)?.swingInterval ?? 2);
    beginSwing(swings, b.id, world.time, getWeapon(b.weaponId)?.swingInterval ?? 2);
    const result = tickWorld(deps(inputs, requests), SIM.TICK_DT);
    for (const ev of result.events) {
      if (ev.t === 'damage') damage[sideOf(ev.sourceId)] += ev.amount;
      if (ev.t === 'heal') healing[sideOf(ev.sourceId)] += ev.amount;
    }
  }

  return {
    winner: !b.alive && a.alive ? 'a' : !a.alive && b.alive ? 'b' : 'draw',
    seconds: world.time,
    damage, healing, casts, picks,
  };
};

// ── 跑全部配对 ───────────────────────────────────────────────────

interface ClassStat {
  wins: number; losses: number; draws: number;
  damage: number; healing: number; seconds: number; matches: number;
}

const stats = new Map<string, ClassStat>();
const of = (id: string): ClassStat => {
  let s = stats.get(id);
  if (!s) { s = { wins: 0, losses: 0, draws: 0, damage: 0, healing: 0, seconds: 0, matches: 0 }; stats.set(id, s); }
  return s;
};

const rng = rngFrom(SEED);
let duels = 0;
let draws = 0;
/** `${a}|${b}` → a 视角的胜场数（a、b 各打 ROUNDS 场的两个方向分开记）*/
const pairWins = new Map<string, number>();

for (const clsA of ALL_CLASSES) {
  for (const clsB of ALL_CLASSES) {
    if (clsA.id === clsB.id) continue;
    if (PAIR && !(PAIR.includes(clsA.id as string) && PAIR.includes(clsB.id as string))) continue;
    for (let r = 0; r < ROUNDS; r++) {
      const res = duel(clsA, clsB, rng);
      duels++;
      if (PAIR) {
        const fmt = (m: Map<string, number>) =>
          [...m.entries()].map(([k, v]) => `${k.split('.')[1]}×${v}`).join(' ');
        console.log(
          `${clsA.id} vs ${clsB.id} 第${r + 1}场：胜者=${res.winner} ` +
          `${res.seconds.toFixed(1)}s 伤害A=${res.damage.a.toFixed(0)} B=${res.damage.b.toFixed(0)} ` +
          `治疗A=${res.healing.a.toFixed(0)} B=${res.healing.b.toFixed(0)}\n` +
          `  A 选技: ${fmt(res.picks.a)}\n  B 选技: ${fmt(res.picks.b)}`,
        );
      }
      if (res.winner === 'draw') draws++;
      if (res.winner === 'a') {
        pairWins.set(`${clsA.id}|${clsB.id}`, (pairWins.get(`${clsA.id}|${clsB.id}`) ?? 0) + 1);
      } else if (res.winner === 'b') {
        pairWins.set(`${clsB.id}|${clsA.id}`, (pairWins.get(`${clsB.id}|${clsA.id}`) ?? 0) + 1);
      }

      const sa = of(clsA.id as string);
      const sb = of(clsB.id as string);
      sa.matches++; sb.matches++;
      sa.seconds += res.seconds; sb.seconds += res.seconds;
      sa.damage += res.damage.a; sb.damage += res.damage.b;
      sa.healing += res.healing.a; sb.healing += res.healing.b;
      if (res.winner === 'a') { sa.wins++; sb.losses++; }
      else if (res.winner === 'b') { sb.wins++; sa.losses++; }
      else { sa.draws++; sb.draws++; }
    }
  }
}

// ── 输出 ─────────────────────────────────────────────────────────

const rows = [...stats.entries()]
  .map(([id, s]) => ({
    id,
    winRate: s.matches ? s.wins / s.matches : 0,
    dps: s.seconds ? s.damage / s.seconds : 0,
    hps: s.seconds ? s.healing / s.seconds : 0,
    avgSeconds: s.matches ? s.seconds / s.matches : 0,
    ...s,
  }))
  .sort((x, y) => y.winRate - x.winRate);

if (AS_JSON) {
  console.log(JSON.stringify({ seed: SEED, rounds: ROUNDS, duels, draws, rows }, null, 2));
} else {
  console.log(`\n配平数据　种子=${SEED}　每对 ${ROUNDS} 场　共 ${duels} 场（平局 ${draws}）`);
  console.log('★ 同一种子必然得到同一份报告 —— shared 里没有 Math.random\n');
  console.log('职业'.padEnd(14) + '胜率'.padEnd(8) + '场均秒'.padEnd(9) + 'DPS'.padEnd(9) + 'HPS');
  console.log('─'.repeat(52));
  for (const r of rows) {
    console.log(
      r.id.padEnd(14) +
      `${(r.winRate * 100).toFixed(1)}%`.padEnd(8) +
      r.avgSeconds.toFixed(1).padEnd(9) +
      r.dps.toFixed(0).padEnd(9) +
      r.hps.toFixed(0),
    );
  }
  const spread = rows.length ? rows[0]!.winRate - rows[rows.length - 1]!.winRate : 0;
  console.log('─'.repeat(52));
  console.log(`胜率极差：${(spread * 100).toFixed(1)} 个百分点`);

  if (AS_MATRIX) {
    // 行=攻方视角：该行职业对每个列职业赢了几场（双向共 2×ROUNDS 场）
    const ids = rows.map((r) => r.id);
    console.log('\n对阵矩阵（行 vs 列：胜场/双向总场）');
    console.log(''.padEnd(13) + ids.map((c) => c.slice(0, 6).padEnd(7)).join(''));
    for (const a of ids) {
      const cells = ids.map((b) => {
        if (a === b) return '—'.padEnd(7);
        const w = pairWins.get(`${a}|${b}`) ?? 0;
        return `${w}/${ROUNDS * 2}`.padEnd(7);
      });
      console.log(a.slice(0, 12).padEnd(13) + cells.join(''));
    }
  }
  console.log(
    '\n⚠️ 这份数据是**回归基线**，不是平衡性结论 —— AI 不会假读条、不会留打断、\n' +
    '   不会绕柱，而 8.x 的反制链恰恰是这个游戏的核心。改一个数值后看谁动了多少，\n' +
    '   而不是照着胜率直接拉平。',
  );
}
