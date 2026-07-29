/**
 * M7 端到端验收脚本。附录A#7 要求的阶段验收用例。
 *
 * 覆盖验收 #38（完整流程）、#39（己方旗帜不在基地不能交旗）、
 * #40（无敌/潜行先掉旗）、#41（同时持旗与战场聚焦）、
 * #42（断线落在最后合法位置）、#43（波次复活与防堵门）。
 *
 * ★ 这个脚本和 flag.test.ts 的分工：
 *   单元测试用的是「把旗直接塞进手里」的夹具，验的是**规则**；
 *   这里跑的是**一整局真实比赛** —— 真地图几何、真移动碰撞、真光环、
 *   20Hz 定步长，角色靠 stepMovement 一步步跑过去。
 *   M3/M4 的教训是「规则对了但没接上线」的 bug 单元测试一个都抓不到。
 *
 * 用法：pnpm verify:m7
 */

import * as shared from '../packages/shared/src/index.ts';

const {
  CTF, SIM, TEAM_RED, TEAM_BLUE, FlagState, GameMode,
  ctfMap, activeForbidden, routeSeconds,
  createCtf, createWorld, createEntity, createAuraStore, createRespawn,
  addEntity, allocEntityId, vec3, warrior,
  beginFlagInteract, tickFlags, flagOf, enemyFlagOf, dropFlagBeforeSkill,
  onCarrierLost, ctfWinner, flagViews, clampCarrierSpeedBonus,
  enqueueRespawn, tickRespawn, breakSpawnProtection,
  createMovementState, stepMovement, deriveStatusFlags, tickAuras,
  distance2D, dirToYaw,
} = shared;

const results: { id: string; pass: boolean }[] = [];
const check = (id: string, name: string, pass: boolean, detail: string) => {
  results.push({ id, pass });
  console.log(`  ${pass ? '✓' : '✗'} ${id} ${name}\n      ${detail}`);
};

// ── 一局真实的夺旗比赛 ───────────────────────────────────────────

const world = createWorld(ctfMap.geometry);
const ctf = createCtf(
  ctfMap.flags!.find((f) => f.team === TEAM_RED)!.position,
  ctfMap.flags!.find((f) => f.team === TEAM_BLUE)!.position,
  3,
);
const auras = createAuraStore();
const respawn = createRespawn(
  Object.fromEntries(ctfMap.graveyards!.map((g) => [g.team as number, g.exits])),
  0,
);

const zoneOf = (team: number) => ctfMap.captureZones!.find((c) => (c.team as number) === team)!;
const inCaptureZone = (team: number, p: { x: number; y: number; z: number }) => {
  const v = zoneOf(team).volume;
  return p.x >= v.min.x && p.x <= v.max.x && p.z >= v.min.z && p.z <= v.max.z;
};
const deps = {
  world,
  captureZoneContains: (team: number, p: { x: number; y: number; z: number }) =>
    inCaptureZone(team, p),
  isLegalPosition: (p: { x: number; y: number; z: number }) =>
    p.x > ctfMap.bounds.min.x && p.x < ctfMap.bounds.max.x &&
    p.z > ctfMap.bounds.min.z && p.z < ctfMap.bounds.max.z && p.y > -20,
};

const spawnAt = (team: typeof TEAM_RED, pos: { x: number; y: number; z: number }, name: string) => {
  const e = addEntity(world, createEntity(allocEntityId(world), warrior, team, vec3(pos.x, pos.y, pos.z), { name }));
  return e;
};

/** 每个角色一份移动状态。跑图用真实的 stepMovement，不瞬移 */
const moveStates = new Map<number, ReturnType<typeof createMovementState>>();
const moveStateOf = (e: ReturnType<typeof spawnAt>) => {
  let s = moveStates.get(e.id as number);
  if (!s) {
    s = createMovementState(vec3(e.position.x, e.position.y, e.position.z));
    moveStates.set(e.id as number, s);
  }
  return s;
};

let now = 0;
const DT = SIM.TICK_DT;

/** 推进一 tick：移动 → 光环 → 旗帜。顺序就是 docs/02 里写的 tick 顺序 */
const tick = (targets: Map<number, { x: number; y: number; z: number } | undefined>) => {
  now += DT;
  for (const e of world.entities.values()) {
    if (!e.alive) continue;
    const goal = targets.get(e.id as number);
    const st = moveStateOf(e);
    if (goal) {
      // ★ 用 dirToYaw 而不是手写 atan2 —— 本项目约定 yaw=0 面向 −Z
      //   （vec3.ts:74），手写 atan2(dx, dz) 会让角色朝反方向跑
      const yaw = dirToYaw(vec3(goal.x - st.position.x, 0, goal.z - st.position.z));
      // 12.3：旗手加速上限 10%
      const bonus = clampCarrierSpeedBonus(0.3, e.flags.carryingFlag);
      const r = stepMovement(st, { forward: 1, strafe: 0, jump: false, yaw }, DT, ctfMap.geometry, {
        speedMultiplier: 1 + bonus,
      });
      moveStates.set(e.id as number, r.state);
      e.position = r.state.position;
      e.yaw = r.state.yaw;
    }
  }
  tickAuras(auras, now);
  for (const e of world.entities.values()) {
    const carrying = e.flags.carryingFlag;
    e.flags = deriveStatusFlags(auras, e);
    e.flags.carryingFlag = carrying;
  }
  return tickFlags(ctf, deps, now);
};

/**
 * 沿一串路点跑，最多跑 maxSeconds。返回实际用时。
 *
 * ⚠️ 本项目**没有寻路** —— 直线冲向终点会撞在自家旗帜房后墙上
 *   （复活区就在旗帜房正后方）。所以这里显式给出路点。
 *   这不削弱验证强度：碰撞、滑墙、门洞宽度、旗帜跟随全都还是真实的，
 *   只是把「找路」这件本来就不属于 M7 的事排除在外。
 */
const runPath = (
  e: ReturnType<typeof spawnAt>,
  path: readonly { x: number; y: number; z: number }[],
  maxSeconds: number,
  tolerance = 2,
  onTick?: (events: ReturnType<typeof tickFlags>) => void,
): number => {
  const start = now;
  const targets = new Map<number, { x: number; y: number; z: number } | undefined>();
  let i = 0;
  let stuckFor = 0;
  let lastPos = { ...e.position };
  while (now - start < maxSeconds && i < path.length) {
    targets.set(e.id as number, path[i]);
    const ev = tick(targets);
    onTick?.(ev);
    // 走到当前路点就换下一个；最后一个用调用方给的容差
    const tol = i === path.length - 1 ? tolerance : 2.5;
    if (distance2D(e.position, path[i]!) <= tol) i += 1;
    // 卡住检测：连续 2 秒几乎没动就放弃，避免白跑满 maxSeconds
    stuckFor = distance2D(e.position, lastPos) < 0.02 ? stuckFor + DT : 0;
    lastPos = { ...e.position };
    if (stuckFor > 2) break;
  }
  return now - start;
};

console.log('\n── 规格书 12.5：地图路线时间与结构（支撑 #38）──');
{
  const seconds = ctfMap.routes!.map((r) => `${r.kind}=${routeSeconds(r).toFixed(1)}s`);
  const allInRange = ctfMap.routes!.every((r) => {
    const s = routeSeconds(r);
    return s >= 35 && s <= 45;
  });
  const centerShortest = ctfMap.routes!
    .filter((r) => r.kind !== 'center')
    .every((r) => routeSeconds(r) > routeSeconds(ctfMap.routes!.find((x) => x.kind === 'center')!));
  check('12.5a', '★ 三类路线均在 35~45 秒内，且中央最短',
    allInRange && centerShortest,
    seconds.join(' / '));

  check('12.5b', '6v6 关闭地道，8v8 / 12v12 开放（19.1 一图三用）',
    activeForbidden(ctfMap, GameMode.Ctf6v6).some((f) => f.id === 'forbid_underground') &&
    !activeForbidden(ctfMap, GameMode.Ctf8v8).some((f) => f.id === 'forbid_underground'),
    `6v6 禁入体积 ${activeForbidden(ctfMap, GameMode.Ctf6v6).length} 个 / ` +
    `8v8 ${activeForbidden(ctfMap, GameMode.Ctf8v8).length} 个`);
}

console.log('\n── 验收 #38：真实跑图完成 拔旗→携旗→交旗→重置 全流程 ──');
const redFlagPos = ctfMap.flags!.find((f) => f.team === TEAM_RED)!.position;
const blueFlagPos = ctfMap.flags!.find((f) => f.team === TEAM_BLUE)!.position;
const redGrave = ctfMap.graveyards!.find((g) => g.team === TEAM_RED)!;

const attacker = spawnAt(TEAM_RED, redGrave.exits[0]!, '红·突击');

/**
 * 复活区出口 → 绕开自家旗帜房 → 中央路线 → 敌方旗帜房门洞 → 敌旗。
 * 门洞坐标直接取自地图声明的 `flags[].entrances`，
 * 所以这条路线一旦因为改地图而走不通，跑不动本身就是失败信号。
 */
const blueEntrance = ctfMap.flags!.find((f) => f.team === TEAM_BLUE)!.entrances[0]!;
const ATTACK_PATH = [
  vec3(-25, 0, 146), // 复活区在旗帜房正后方，先横向绕出去
  vec3(-25, 0, 104),
  vec3(0, 0, 60),
  vec3(0, 0, 0),
  vec3(0, 0, -60),
  vec3(blueEntrance.x, 0, -104),
  vec3(blueEntrance.x, 0, -115), // 穿过敌方旗帜房门洞
  blueFlagPos,
];
/** 返程：原路折回自家旗帜房交旗 */
const RETURN_PATH = [
  vec3(blueEntrance.x, 0, -115),
  vec3(blueEntrance.x, 0, -104),
  vec3(0, 0, -60),
  vec3(0, 0, 0),
  vec3(0, 0, 60),
  vec3(0, 0, 104),
  vec3(6.5, 0, 115), // 穿过自家旗帜房门洞
  redFlagPos,
];

{
  const timeline: string[] = [];

  // ① 从己方复活区出口一路跑到敌方旗帜（走真实几何，会撞墙会滑墙）
  const travel = runPath(attacker, ATTACK_PATH, 120, 2.0);
  timeline.push(`跑图 ${travel.toFixed(1)}s`);
  const arrived = distance2D(attacker.position, blueFlagPos) <= 2.2;

  // ② 拔旗读条 1.2 秒
  const blueFlag = flagOf(ctf, TEAM_BLUE);
  const begin = beginFlagInteract(ctf, attacker, blueFlag, now, (p) => inCaptureZone(TEAM_RED as number, p));
  timeline.push(`起手拔旗＝${begin.ok}`);
  const until = now + CTF.PICKUP_SECONDS + DT;
  const still = new Map<number, undefined>();
  while (now < until) tick(still);
  timeline.push(`旗帜状态＝${blueFlag.state}`);

  check('#38a', '★ 真实跑图后能在敌方旗帜房完成拔旗',
    arrived && begin.ok && blueFlag.state === FlagState.Carried && attacker.flags.carryingFlag,
    `${timeline.join('，')}；到达距离 ${distance2D(attacker.position, blueFlagPos).toFixed(2)}m`);

  // ③ 携旗返回：旗帜必须一路跟随
  let followed = true;
  const back = runPath(attacker, RETURN_PATH, 120, 1.5, () => {
    if (blueFlag.state === FlagState.Carried) {
      followed &&= distance2D(blueFlag.position, attacker.position) < 0.01;
    }
  });
  check('#38b', '★ 携旗返回全程旗帜跟随旗手',
    followed && blueFlag.state === FlagState.Carried,
    `返程 ${back.toFixed(1)}s，旗帜状态＝${blueFlag.state}，全程跟随＝${followed}`);

  // ④ 交旗
  const cap = beginFlagInteract(ctf, attacker, blueFlag, now, (p) => inCaptureZone(TEAM_RED as number, p));
  const capUntil = now + CTF.CAPTURE_SECONDS + DT;
  let captured = false;
  while (now < capUntil) {
    for (const ev of tick(still)) if (ev.type === 'captured') captured = true;
  }
  check('#38c', '★ 在己方交旗区完成交旗并得分，旗帜重置回基地',
    cap.ok && captured && ctf.score[String(TEAM_RED as number)] === 1 &&
    blueFlag.state === FlagState.AtBase &&
    distance2D(blueFlag.position, blueFlagPos) < 0.01 &&
    !attacker.flags.carryingFlag,
    `起手交旗＝${cap.ok}，得分＝${ctf.score[String(TEAM_RED as number)]}，` +
    `旗帜＝${blueFlag.state} @ z=${blueFlag.position.z.toFixed(0)}`);
}

console.log('\n── 验收 #39：己方旗帜不在基地时无法交旗 ──');
{
  const blueFlag = flagOf(ctf, TEAM_BLUE);
  const redFlag = flagOf(ctf, TEAM_RED);

  // 红方再抢一次蓝旗，同时蓝方抢走红旗
  blueFlag.state = FlagState.Carried;
  blueFlag.carrierId = attacker.id;
  blueFlag.position = { ...attacker.position };
  blueFlag.lastLegalPosition = { ...attacker.position };
  attacker.flags.carryingFlag = true;

  const thief = spawnAt(TEAM_BLUE, redFlagPos, '蓝·偷旗');
  redFlag.state = FlagState.Carried;
  redFlag.carrierId = thief.id;
  thief.flags.carryingFlag = true;

  const scoreBefore = ctf.score[String(TEAM_RED as number)]!;
  const r = beginFlagInteract(ctf, attacker, blueFlag, now, (p) => inCaptureZone(TEAM_RED as number, p));
  // 再跑 2 秒确认真的没有得分
  const still = new Map<number, undefined>();
  const endAt = now + 2;
  while (now < endAt) tick(still);

  check('#39a', '★ 己方旗帜被带走时起手交旗直接被拒',
    !r.ok && ctf.score[String(TEAM_RED as number)] === scoreBefore,
    `拒绝理由＝${r.ok ? '(未拒绝)' : (r as { reason: string }).reason}，比分仍为 ${scoreBefore}`);

  // 交旗**途中**己方旗帜被拔走 —— 必须中断，不是只在开始时检查一次
  redFlag.state = FlagState.AtBase;
  thief.flags.carryingFlag = false;
  const r2 = beginFlagInteract(ctf, attacker, blueFlag, now, (p) => inCaptureZone(TEAM_RED as number, p));
  redFlag.state = FlagState.Carried; // 读条进行中被拔走
  let interrupted = false;
  const endAt2 = now + CTF.CAPTURE_SECONDS + 0.5;
  while (now < endAt2) {
    for (const ev of tick(still)) {
      if (ev.type === 'interruptedInteract' && ev.reason === 'ownFlagNotAtBase') interrupted = true;
    }
  }
  check('#39b', '★★ 交旗**途中**己方旗帜被拔走会立即中断（全程检查，不是只查一次）',
    r2.ok && interrupted && ctf.score[String(TEAM_RED as number)] === scoreBefore,
    `起手＝${r2.ok}，中断＝${interrupted}，比分仍为 ${ctf.score[String(TEAM_RED as number)]}`);

  // 收拾现场
  redFlag.state = FlagState.AtBase;
  redFlag.carrierId = undefined;
  thief.flags.carryingFlag = false;
}

console.log('\n── 验收 #40：完全无敌 / 潜行先掉旗，旗帜不随角色隐藏 ──');
{
  const blueFlag = flagOf(ctf, TEAM_BLUE);
  const here = { ...attacker.position };

  // 顺序必须是「先掉旗，再播放技能表现」
  const dropped = dropFlagBeforeSkill(ctf, attacker, now);
  attacker.flags.stealthed = true; // 技能表现在掉旗**之后**

  const view = flagViews(ctf, world).find((v) => v.team === TEAM_BLUE)!;
  check('#40a', '★ 使用潜行/无敌时先掉旗',
    dropped !== null && blueFlag.state === FlagState.Dropped && !attacker.flags.carryingFlag,
    `旗帜状态＝${blueFlag.state}，携带标志＝${attacker.flags.carryingFlag}`);

  check('#40b', '★★ 旗帜留在掉落点，不随隐身角色消失（对双方仍可见）',
    view.state === FlagState.Dropped &&
    distance2D(view.position, here) < 0.01 &&
    view.carrierName === undefined,
    `旗手潜行＝${attacker.flags.stealthed}；旗帜视图 state=${view.state} ` +
    `pos=(${view.position.x.toFixed(1)}, ${view.position.z.toFixed(1)}) carrier=${view.carrierName ?? '无'}`);

  check('#40c', '★ 12.3 旗手移动加成上限 10%',
    Math.abs(clampCarrierSpeedBonus(0.3, true) - CTF.FLAG_CARRIER_MAX_SPEED_BONUS) < 1e-9 &&
    Math.abs(clampCarrierSpeedBonus(0.3, false) - 0.3) < 1e-9,
    `带旗 30% 加成→${(clampCarrierSpeedBonus(0.3, true) * 100).toFixed(0)}%，` +
    `不带旗→${(clampCarrierSpeedBonus(0.3, false) * 100).toFixed(0)}%`);

  attacker.flags.stealthed = false;
}

console.log('\n── 验收 #41：双方同时持旗，靠战场聚焦打破僵局 ──');
{
  const blueFlag = flagOf(ctf, TEAM_BLUE);
  const redFlag = flagOf(ctf, TEAM_RED);
  const thief = [...world.entities.values()].find((e) => e.name === '蓝·偷旗')!;

  for (const [flag, carrier] of [[blueFlag, attacker], [redFlag, thief]] as const) {
    flag.state = FlagState.Carried;
    flag.carrierId = carrier.id;
    flag.position = { ...carrier.position };
    flag.lastLegalPosition = { ...carrier.position };
    carrier.flags.carryingFlag = true;
  }
  ctf.bothCarryingSince = null;
  ctf.focusStacks = 0;

  const still = new Map<number, undefined>();
  tick(still);
  const t0 = ctf.bothCarryingSince!;
  const stacksAt = (dt: number) => {
    // 直接推进时间，不必真的跑 60 秒的 tick。
    // +1e-6 是因为 now 是 0.05 一路累加出来的，t0 带浮点尾数，
    // 「正好踩在层数边界上」在浮点下可能差半个 ulp（真实比赛里最多晚一 tick 生效）
    shared.updateBattlefieldFocus(ctf, t0 + dt + 1e-6);
    return ctf.focusStacks;
  };

  const before = stacksAt(CTF.FOCUS_GRACE_SECONDS - 1);
  const s1 = stacksAt(CTF.FOCUS_GRACE_SECONDS);
  const s3 = stacksAt(CTF.FOCUS_GRACE_SECONDS + CTF.FOCUS_STACK_INTERVAL * 2);
  const s5 = stacksAt(CTF.FOCUS_GRACE_SECONDS + CTF.FOCUS_STACK_INTERVAL * 10);

  check('#41a', '★ 同时持旗时比赛继续，60 秒宽限期内不叠层',
    blueFlag.state === FlagState.Carried && redFlag.state === FlagState.Carried &&
    ctfWinner(ctf) === null && before === 0,
    `双方持旗＝${blueFlag.state}/${redFlag.state}，${CTF.FOCUS_GRACE_SECONDS - 1}s 时层数＝${before}`);

  check('#41b', '★ 超过 60 秒开始叠层，每 30 秒一层，上限 5 层',
    s1 === 1 && s3 === 3 && s5 === CTF.FOCUS_MAX_STACKS,
    `60s→${s1} 层，120s→${s3} 层，360s→${s5} 层（上限 ${CTF.FOCUS_MAX_STACKS}）`);

  const m = shared.focusModifiers(ctf.focusStacks);
  check('#41c', '每层受到伤害 +8%、受到治疗 −5% —— 僵局会被打破',
    Math.abs(m.damageTaken - 1.4) < 1e-9 && Math.abs(m.healingTaken - 0.75) < 1e-9,
    `5 层时受到伤害 ×${m.damageTaken.toFixed(2)}，受到治疗 ×${m.healingTaken.toFixed(2)}`);

  // 一面旗回基地后逐步清除，且**不是**每 tick 掉一层
  redFlag.state = FlagState.AtBase;
  redFlag.carrierId = undefined;
  thief.flags.carryingFlag = false;
  const decayStart = t0 + 400;
  shared.updateBattlefieldFocus(ctf, decayStart);
  for (let i = 1; i <= 20; i += 1) shared.updateBattlefieldFocus(ctf, decayStart + i * DT);
  const afterOneSecond = ctf.focusStacks;
  shared.updateBattlefieldFocus(ctf, decayStart + CTF.FOCUS_STACK_INTERVAL);
  const afterOneInterval = ctf.focusStacks;

  check('#41d', '★★ 一面旗回基地后「逐步清除」按时间走，不是每 tick 掉一层',
    afterOneSecond === CTF.FOCUS_MAX_STACKS && afterOneInterval === CTF.FOCUS_MAX_STACKS - 1,
    `20Hz 跑满 1 秒后仍是 ${afterOneSecond} 层；` +
    `${CTF.FOCUS_STACK_INTERVAL}s 后降到 ${afterOneInterval} 层`);
}

console.log('\n── 验收 #42：断线 / 非法区域 → 旗帜落在最后合法位置 ──');
{
  const blueFlag = flagOf(ctf, TEAM_BLUE);
  const still = new Map<number, undefined>();
  tick(still);
  const lastLegal = { ...blueFlag.position };

  // 断线：实体位置已经是脏数据
  attacker.position = vec3(99999, -99999, 99999);
  const ev = onCarrierLost(ctf, world, attacker.id, now);

  check('#42a', '★ 断线时旗帜落在最后合法位置，而不是断线瞬间的坐标',
    ev !== null && blueFlag.state === FlagState.Dropped &&
    distance2D(blueFlag.position, lastLegal) < 0.01 &&
    !attacker.flags.carryingFlag,
    `最后合法位置 (${lastLegal.x.toFixed(1)}, ${lastLegal.z.toFixed(1)})，` +
    `旗帜落点 (${blueFlag.position.x.toFixed(1)}, ${blueFlag.position.z.toFixed(1)})`);

  // 进入非法区域（掉出地图）
  attacker.position = vec3(0, 0, -40);
  moveStates.set(attacker.id as number, createMovementState(vec3(0, 0, -40)));
  blueFlag.state = FlagState.Carried;
  blueFlag.carrierId = attacker.id;
  blueFlag.position = { ...attacker.position };
  blueFlag.lastLegalPosition = { ...attacker.position };
  attacker.flags.carryingFlag = true;
  tick(still);
  const legalBefore = { ...blueFlag.lastLegalPosition };

  attacker.position = vec3(0, -500, -40); // 掉出地图
  let illegalDrop = false;
  for (const e of tick(still)) if (e.type === 'dropped' && e.reason === 'illegalArea') illegalDrop = true;

  check('#42b', '★ 掉出地图 / 进入非法区域时旗帜回到最后合法位置',
    illegalDrop && distance2D(blueFlag.position, legalBefore) < 0.01,
    `掉落原因＝illegalArea＝${illegalDrop}，落点 y=${blueFlag.position.y.toFixed(1)}（不是 −500）`);
}

console.log('\n── 验收 #43：波次复活、复活保护、基地出口不堵门 ──');
{
  const dead = [
    spawnAt(TEAM_RED, redGrave.exits[0]!, '红·阵亡1'),
    spawnAt(TEAM_RED, redGrave.exits[0]!, '红·阵亡2'),
    spawnAt(TEAM_RED, redGrave.exits[0]!, '红·阵亡3'),
    spawnAt(TEAM_RED, redGrave.exits[0]!, '红·阵亡4'),
  ];
  for (const [i, e] of dead.entries()) {
    e.alive = false;
    e.health = 0;
    enqueueRespawn(respawn, e.id, now + i); // 死亡时间各不相同
  }

  // 复活状态是在 t=0 建的，现在已经跑到 t≈190s —— 按当前时刻重排波次
  respawn.nextWaveAt = now + respawn.waveInterval;
  const waveAt = respawn.nextWaveAt;
  let events: ReturnType<typeof tickRespawn> = [];
  const still = new Map<number, undefined>();
  while (now < waveAt + DT) {
    tick(still);
    const r = tickRespawn(respawn, world, auras, now);
    if (r.length) events = r;
  }

  check('#43a', '★ 波次复活：不同时刻阵亡的人在同一波一起复活',
    events.length === dead.length && dead.every((e) => e.alive && e.health === e.maxHealth),
    `${dead.length} 人分别在 t=${now.toFixed(0)}s 前陆续阵亡，同一波复活 ${events.length} 人`);

  const spots = new Set(events.map((e) => `${e.position.x.toFixed(1)},${e.position.z.toFixed(1)}`));
  check('#43b', '★ 复活点轮流分配到不同出口 —— 基地出口不会被自己人堵死',
    spots.size >= Math.min(dead.length, redGrave.exits.length),
    `${events.length} 人分散到 ${spots.size} 个出口（地图提供 ${redGrave.exits.length} 个）`);

  const revived = dead[0]!;
  revived.flags = deriveStatusFlags(auras, revived);
  check('#43c', '★★ 复活保护是真光环：deriveStatusFlags 重建后仍在，且真的免伤',
    revived.flags.spawnProtection && revived.flags.immuneAll,
    `spawnProtection=${revived.flags.spawnProtection}，immuneAll=${revived.flags.immuneAll}` +
    `（光环 ${shared.aurasOf(auras, revived.id).map((a) => a.def.name).join('/')}）`);

  // ★ 12.6：复活保护不能用于直接完成拔旗或交旗
  const redFlag = flagOf(ctf, TEAM_RED);
  redFlag.state = FlagState.AtBase;
  const enemy = spawnAt(TEAM_BLUE, redFlagPos, '蓝·顶保护拔旗');
  enemy.flags.spawnProtection = true;
  const blocked = beginFlagInteract(ctf, enemy, redFlag, now, (p) => inCaptureZone(TEAM_BLUE as number, p));
  check('#43d', '★★ 12.6 复活保护不能用于直接完成拔旗或交旗',
    !blocked.ok && redFlag.state === FlagState.AtBase,
    `顶着保护拔旗＝${blocked.ok ? '成功（错误！）' : '被拒：' + (blocked as { reason: string }).reason}`);

  // 主动使用技能提前结束保护
  const brokeOk = breakSpawnProtection(auras, revived);
  revived.flags = deriveStatusFlags(auras, revived);
  check('#43e', '主动攻击 / 治疗 / 使用技能会提前结束复活保护',
    brokeOk && !revived.flags.spawnProtection && !revived.flags.immuneAll,
    `提前结束＝${brokeOk}，剩余保护＝${revived.flags.spawnProtection}`);

  // 保护自然到期
  const until = now + CTF.SPAWN_PROTECTION_SECONDS + DT;
  while (now < until) {
    tick(still);
    tickRespawn(respawn, world, auras, now);
  }
  const other = dead[1]!;
  check('#43f', `复活保护 ${CTF.SPAWN_PROTECTION_SECONDS} 秒后自动到期`,
    !deriveStatusFlags(auras, other).spawnProtection,
    `t=${now.toFixed(1)}s 时 ${other.name} 的保护＝${deriveStatusFlags(auras, other).spawnProtection}`);
}

console.log('\n── 12.1：达到目标分数结束比赛 ──');
{
  ctf.score[String(TEAM_RED as number)] = ctf.scoreToWin;
  check('12.1', `率先完成 ${ctf.scoreToWin} 次夺旗判胜`,
    ctfWinner(ctf) === TEAM_RED,
    `比分 ${ctf.score[String(TEAM_RED as number)]}:${ctf.score[String(TEAM_BLUE as number)] ?? 0}，` +
    `胜者＝${ctfWinner(ctf) === TEAM_RED ? '红方' : '(无)'}`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${'─'.repeat(60)}`);
console.log(`M7 验收：${results.length - failed.length}/${results.length} 通过（模拟时长 ${now.toFixed(1)}s）`);
if (failed.length) {
  console.log('失败项：' + failed.map((f) => f.id).join(', '));
  process.exit(1);
}
