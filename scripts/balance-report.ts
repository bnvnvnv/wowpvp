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
  createSwapStore, createSwingStore, beginSwing, createWorld, distance2D, dirToYaw, getSkill, sub, tickWorld,
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

// ── 一场对决 ─────────────────────────────────────────────────────

interface DuelResult {
  winner: 'a' | 'b' | 'draw';
  seconds: number;
  damage: Record<'a' | 'b', number>;
  healing: Record<'a' | 'b', number>;
  casts: Record<'a' | 'b', number>;
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
   * 极简 AI：面向对手、不到射程就往前走、能放就放一个能放的技能。
   * ⚠️ 它**不会**假读条、不会留打断、不会绕柱 —— 见文件头的 ⚠️。
   */
  const think = (
    self: CombatEntity, foe: CombatEntity,
  ): { move: { forward: number; strafe: number; jump: boolean; yaw: number }; cast?: CastIntent } => {
    const yaw = dirToYaw(sub(foe.position, self.position));
    const d = distance2D(self.position, foe.position);

    const skills = ALL_CLASSES.find((c) => c.id === self.classId)!.skills;
    const usable: SkillDef[] = [];
    for (const sk of skills) {
      if (sk.targeting === 'ground') continue; // AI 不选落点
      const ok = validateCast({ world, caster: self, skill: sk, target: foe, phase: 'start' });
      if (ok === CastFailure.Ok) usable.push(sk);
    }

    /**
     * ★★ **走位判据看的是「能不能打到他」，不是「有没有技能能放」。**
     *
     *   ⚠️ 第一版写的是 `usable.length === 0 && d > 2` —— 于是任何**自身增益**
     *      （防御姿态、树皮术…）只要可用，近战就**站在原地不动**，
     *      永远走不进近战距离。跑出来的结果是战士/死骑 0% 胜率、场均 37–76 秒，
     *      而那测的是 AI 的愚蠢，不是职业强弱。
     *      **一份错的基线比没有基线更糟** —— 它会把人引去调错的数字。
     *
     *   改成：看自己**伤害技能**里射程最远的那个，够不着就贴近。
     */
    const reach = Math.max(
      0,
      ...skills
        .filter((sk) => sk.effects.some((e) => e.kind === 'damage'))
        .map((sk) => sk.range.max),
    );
    const move = { forward: d > reach * 0.9 ? 1 : 0, strafe: 0, jump: false, yaw };

    // 有伤害技能可用时优先输出，否则退而求其次放别的（增益/控制）
    const damaging = usable.filter((sk) => sk.effects.some((e) => e.kind === 'damage'));
    const pool = damaging.length > 0 ? damaging : usable;
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
      if (r.cast) { requests.set(self.id, r.cast); casts[sideOf(self.id)]++; }
    }

    // 4.x：右键目标即开始普通攻击。★ beginSwing 幂等，不会刷新节奏
    beginSwing(swings, a.id, world.time, 2);
    beginSwing(swings, b.id, world.time, 2);
    const result = tickWorld(deps(inputs, requests), SIM.TICK_DT);
    for (const ev of result.events) {
      if (ev.t === 'damage') damage[sideOf(ev.sourceId)] += ev.amount;
      if (ev.t === 'heal') healing[sideOf(ev.sourceId)] += ev.amount;
    }
  }

  return {
    winner: !b.alive && a.alive ? 'a' : !a.alive && b.alive ? 'b' : 'draw',
    seconds: world.time,
    damage, healing, casts,
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

for (const clsA of ALL_CLASSES) {
  for (const clsB of ALL_CLASSES) {
    if (clsA.id === clsB.id) continue;
    for (let r = 0; r < ROUNDS; r++) {
      const res = duel(clsA, clsB, rng);
      duels++;
      if (res.winner === 'draw') draws++;

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
  console.log(
    '\n⚠️ 这份数据是**回归基线**，不是平衡性结论 —— AI 不会假读条、不会留打断、\n' +
    '   不会绕柱，而 8.x 的反制链恰恰是这个游戏的核心。改一个数值后看谁动了多少，\n' +
    '   而不是照着胜率直接拉平。',
  );
}
