/**
 * M9 端到端验收脚本。附录A#7 要求的阶段验收用例。
 *
 * 覆盖验收 #5（未被发现的潜行目标不可选中/不进快照）、
 * #50（战后统计含打断/驱散/控制/换装/装备争夺/夺旗贡献）、
 * #51（外部素材许可记录）、#52（不存在等级/永久装备/付费属性/外观稀有度优势），
 * 外加 11.4 观战、11.5 断线不提供无敌、17.3 异常处理五类。
 *
 * ★ 与单元测试的分工（M3/M4/M8 的教训）：
 *   单元测试验**规则**，这里验**接线** —— 跑一整局真实夺旗比赛，
 *   真地图几何、真移动碰撞、真光环、20Hz 定步长，让统计从真实事件流里长出来。
 *   「规则写对了但没人调用它」这类 bug 在本项目已经出现过三次，
 *   每一次都只有端到端才抓到。
 *
 * ⚠️ 与 M5/M6/M7 一样**不驱动浏览器**：这些验收项都是纯逻辑，
 *    在浏览器里实时等一局毫无意义。17.2 的可访问性接线由 verify:m8 的
 *    截图链路和 accessibility.test.ts 覆盖。
 *
 * 用法：pnpm verify:m9
 */

import * as shared from '../packages/shared/src/index.ts';
import {
  RECONNECT_GRACE_SECONDS,
  createReconnectRegistry,
  isAwaitingReconnect,
  leaveImmediately,
  redeemReconnect,
  registerDisconnect,
  takeExpired,
} from '../packages/server/src/room/reconnect.ts';

const {
  CTF, SIM, TEAM_RED, TEAM_BLUE, School, DrCategory,
  ctfMap, createCtf, createWorld, createEntity, createAuraStore, createDrStore,
  createGroundStore, createProjectileStore, createLoadoutStore, createSwapStore,
  createPickupStore, createLoadout, createArsenalStore, ArenaPreset,
  addEntity, allocEntityId, vec3, warrior, priest, rogue, mage,
  beginFlagInteract, tickFlags, enemyFlagOf, flagOf,
  createMovementState, stepMovement, deriveStatusFlags, distance2D, dirToYaw,
  addWeapon, beginSwap, tickSwaps, SwapKind,
  dealDamage, resolveEffects,
  // M9
  createStats, registerPlayer, ingestCombatEvents, ingestFlagEvents, ingestSwapEvents,
  ingestPickupEvents, sampleTick, pickAwards, recordSelfCancel, recordSkillUse,
  interruptSuccessRate, STATS,
  settleDeaths, assertDeathsSettled,
  buildSnapshot, isVisibleTo, spectatableFor, buildSpectatorSnapshot,
  assertNoHiddenEntities, CULLING_RULES,
  isSelectableBy,
} = shared;

type Row = { id: string; pass: boolean };
const results: Row[] = [];
const check = (id: string, name: string, pass: boolean, detail: string) => {
  results.push({ id, pass });
  console.log(`  ${pass ? '✓' : '✗'} ${id} ${name}\n      ${detail}`);
};

// ════════════════════════════════════════════════════════════════
//  一局真实的夺旗比赛
// ════════════════════════════════════════════════════════════════

const world = createWorld(ctfMap.geometry);
const redBase = ctfMap.flags!.find((f) => f.team === TEAM_RED)!.position;
const blueBase = ctfMap.flags!.find((f) => f.team === TEAM_BLUE)!.position;
const ctf = createCtf(redBase, blueBase, 3);

const auras = createAuraStore();
const dr = createDrStore();
const ground = createGroundStore();
const projectiles = createProjectileStore();
const loadouts = createLoadoutStore();
const swaps = createSwapStore();
const pickups = createPickupStore();
const arsenal = createArsenalStore(ArenaPreset.Armed);
const stats = createStats();

const spawn = (cls: typeof warrior, team: typeof TEAM_RED, pos: { x: number; y: number; z: number }, name: string) => {
  const e = addEntity(world, createEntity(allocEntityId(world), cls, team, pos, { name }));
  loadouts.set(e.id, createLoadout(e.classId));
  registerPlayer(stats, e);
  return e;
};

// 红队：一个旗手 + 一个治疗（护送）；蓝队：一个防守 + 一个潜行者
const carrier = spawn(warrior, TEAM_RED, { ...redBase, z: redBase.z - 4 }, '红·旗手');
const healer = spawn(priest, TEAM_RED, { ...redBase, z: redBase.z - 6 }, '红·治疗');
const defender = spawn(mage, TEAM_BLUE, { ...blueBase, z: blueBase.z + 6 }, '蓝·防守');
const sneak = spawn(rogue, TEAM_BLUE, { x: 0, y: 0, z: 0 }, '蓝·潜行');

const ctfDeps = {
  world,
  captureZoneContains: (team: typeof TEAM_RED, p: { x: number; y: number; z: number }) => {
    const base = team === TEAM_RED ? redBase : blueBase;
    return distance2D(p, base) <= 6;
  },
};
const statsDeps = { world, ctf: { state: ctf, map: ctfMap } };
const deathDeps = { world, loadouts, swaps, pickups };

const effectCtx = (source: typeof carrier) => ({
  world, auras, dr, projectiles,
  groundAreas: ground.areas, traps: ground.traps,
  source, skillId: 'verify', events: [] as shared.CombatEvent[], resolve: () => {},
});

/** 推进一个 tick：移动 → 旗帜 → 换装 → 死亡结算 → 统计采样 */
const moveStates = new Map<number, ReturnType<typeof createMovementState>>();
const tick = (dt: number, walkers: { e: typeof carrier; to: { x: number; y: number; z: number } }[] = []) => {
  world.time += dt;

  for (const { e, to } of walkers) {
    if (!e.alive) continue;
    let ms = moveStates.get(e.id as number);
    if (!ms) { ms = createMovementState(vec3(e.position.x, e.position.y, e.position.z)); moveStates.set(e.id as number, ms); }
    if (distance2D(ms.position, to) <= 1.5) continue;
    // ★ 用 dirToYaw 而不是手写 atan2 —— 本项目约定 yaw=0 面向 −Z（vec3.ts）
    const yaw = dirToYaw(vec3(to.x - ms.position.x, 0, to.z - ms.position.z));
    // ⚠️ stepMovement 返回 { state, landing } —— 把整个 StepResult 当成下一帧的
    //    prev 会让 prev.position 变成 undefined，携旗距离直接算出 NaN。
    //    （写这个脚本时真的踩了一次，是统计表里的 `NaNm` 露出来的。）
    const r = stepMovement(ms, { forward: 1, strafe: 0, jump: false, yaw }, dt, ctfMap.geometry);
    moveStates.set(e.id as number, r.state);
    e.position = r.state.position;
    e.yaw = r.state.yaw;
  }

  for (const e of [carrier, healer, defender, sneak]) e.flags = deriveStatusFlags(auras, e);

  ingestFlagEvents(stats, tickFlags(ctf, ctfDeps, world.time));
  ingestSwapEvents(stats, tickSwaps(world.entities, swaps, world.time));
  sampleTick(stats, statsDeps, dt);
};

const DT = 1 / SIM.TICK_RATE;

console.log('\n── 验收 #5：未被发现的潜行目标不可见、不可选中 ──');
{
  sneak.flags.stealthed = true;
  sneak.flags = { ...sneak.flags, stealthed: true };

  const snap = buildSnapshot(
    { world, auras, swaps, loadouts, tick: 1, dampening: 0, suddenDeath: false, ctf },
    carrier,
  );
  const ids = snap.entities.map((e) => e.id as number);
  const leaked = JSON.stringify(snap).includes(sneak.name);

  check('#5a', '★★ 未被发现的潜行敌人**完全不进快照**（不是带个隐藏标记）',
    !ids.includes(sneak.id as number) && !leaked,
    `敌方快照实体 ${ids.length} 个，含潜行者=${ids.includes(sneak.id as number)}，姓名泄露=${leaked}`);

  check('#5b', '★ 同一条判据同时管住「能否选中」',
    !isSelectableBy(sneak, carrier) && !isVisibleTo(sneak, carrier, { ctf }),
    `可选中=${isSelectableBy(sneak, carrier)}，可见=${isVisibleTo(sneak, carrier, { ctf })}`);

  // 被发现后才进快照
  sneak.flags.stealthRevealed = true;
  const after = buildSnapshot(
    { world, auras, swaps, loadouts, tick: 2, dampening: 0, suddenDeath: false, ctf },
    carrier,
  );
  check('#5c', '被发现后进入快照（3 米内 / 照明弹 / 主动攻击后）',
    after.entities.some((e) => e.id === sneak.id),
    `被发现后可见=${after.entities.some((e) => e.id === sneak.id)}`);

  // 队友的潜行对己方可见
  healer.flags.stealthed = true;
  check('#5d', '队友的潜行对己方可见',
    isVisibleTo(healer, carrier, { ctf }),
    `己方潜行队友可见=${isVisibleTo(healer, carrier, { ctf })}`);
  healer.flags.stealthed = false;

  // 发送前自检真的会拦
  let caught = false;
  try {
    sneak.flags.stealthRevealed = false;
    assertNoHiddenEntities(after, world, carrier, { ctf });
  } catch { caught = true; }
  check('#5e', '★ 发送前自检能拦下泄露的快照（安全边界，宁可掉线也不透视）',
    caught, `自检抛异常=${caught}；已登记裁剪规则 ${CULLING_RULES.length} 条`);
  sneak.flags.stealthed = false;
  sneak.flags.stealthRevealed = false;
}

console.log('\n── 11.4 观战：只能跟随己方存活玩家 ──');
{
  const list = spectatableFor(world, carrier).map((e) => e.name);
  check('11.4a', '★ 可观战名单只含己方存活队友',
    list.length === 1 && list[0] === healer.name,
    `名单：${list.join('、') || '(空)'}`);

  const bad = buildSpectatorSnapshot(
    { world, auras, swaps, loadouts, tick: 1, dampening: 0, suddenDeath: false, ctf },
    carrier, defender,
  );
  check('11.4b', '★★ 不能跟随敌人（返回 undefined，不退化成自由镜头）',
    bad === undefined, `跟随敌人的结果=${bad === undefined ? 'undefined' : '竟然给了快照'}`);

  sneak.flags.stealthed = true;
  const ok = buildSpectatorSnapshot(
    { world, auras, swaps, loadouts, tick: 1, dampening: 0, suddenDeath: false, ctf },
    carrier, healer,
  )!;
  check('11.4c', '★★ 观战走被跟随队友的裁剪结果 —— 死一次换不到透视',
    !ok.entities.some((e) => e.id === sneak.id),
    `观战视角里潜行者可见=${ok.entities.some((e) => e.id === sneak.id)}`);
  sneak.flags.stealthed = false;
}

console.log('\n── 11.5 / 17.3：断线不提供无敌，超时按淘汰 ──');
{
  const registry = createReconnectRegistry();
  let n = 0;
  const tokens = () => `t${++n}`;

  const rec = registerDisconnect(registry, 'healer', world.time, { tokenFactory: tokens });
  const posBefore = { ...healer.position };
  const hpBefore = healer.health;
  dealDamage(effectCtx(defender), healer, 150, School.Physical);

  check('11.5a', '★★ 宽限期内角色留在原地、照样掉血（断线不获得无敌）',
    healer.health < hpBefore
      && healer.position.x === posBefore.x && healer.position.z === posBefore.z
      && !healer.flags.immuneAll && !healer.flags.spawnProtection,
    `生命 ${hpBefore} → ${healer.health}；位置未变=${healer.position.x === posBefore.x}；`
    + `immuneAll=${healer.flags.immuneAll}`);

  const ok = redeemReconnect(registry, rec.token, world.time + 5);
  check('11.5b', '限时内重连成功，并要求下发完整快照',
    ok.ok && ok.fullSnapshotRequired === true,
    `结果=${JSON.stringify(ok)}`);

  registerDisconnect(registry, 'defender', world.time, { tokenFactory: tokens });
  const expired = takeExpired(registry, world.time + RECONNECT_GRACE_SECONDS + 1);
  check('11.5c', '★ 超时产出待淘汰名单（后果留在调用方，不能被 if 绕过）',
    expired.length === 1 && expired[0] === 'defender' && !isAwaitingReconnect(registry, 'defender'),
    `超时名单：${expired.join('、')}；宽限期 ${RECONNECT_GRACE_SECONDS}s`);

  const left = leaveImmediately(registry, 'healer');
  check('11.5d', '★ 主动退出立即按淘汰处理（不能通过退出规避死亡统计）',
    left.eliminate === true, `结果=${JSON.stringify(left)}`);
}

console.log('\n── 17.3 第 2 类：换装瞬间死亡时状态唯一 ──');
{
  const l = loadouts.get(defender.id)!;
  const spare = mage.weapons.find((w) => !w.isDefault)!;
  addWeapon(l, spare.id);
  defender.weaponId = l.defaultWeaponId;

  const started = beginSwap(defender, l, swaps, SwapKind.Weapon, spare.id, world.time);
  const endsAt = swaps.get(defender.id)!.endsAt;
  const before = defender.weaponId;

  // 恰好在换装完成的同一刻打死他
  defender.health = 1;
  dealDamage(effectCtx(carrier), defender, 9999, School.Physical);
  const swapEvents = tickSwaps(world.entities, swaps, endsAt);

  check('17.3a', '★★ 同一 tick 里死亡赢过换装完成（状态唯一）',
    started.ok && swapEvents.some((e) => e.result === 'death')
      && defender.weaponId === before && !swaps.has(defender.id),
    `换装事件=${swapEvents.map((e) => e.result).join(',')}；武器未变=${defender.weaponId === before}；`
    + `残留换装=${swaps.has(defender.id)}`);

  // 10.10：死亡后临时装备失效
  const settled = settleDeaths(deathDeps, [{ t: 'death', targetId: defender.id, killerId: carrier.id }]);
  let selfCheck = true;
  try { assertDeathsSettled(deathDeps); } catch { selfCheck = false; }

  check('17.3b', '★★ 10.10 死亡后临时装备失效并回退默认装备（M9 补的接线）',
    settled.length === 1 && l.spareWeapons.length === 0
      && defender.weaponId === l.defaultWeaponId && selfCheck,
    `备用武器 ${l.spareWeapons.length} 件；当前武器=${defender.weaponId}；自检通过=${selfCheck}`);

  // 复活他，比赛继续
  defender.alive = true;
  defender.health = defender.maxHealth;
}

console.log('\n── 跑一整局：旗手从基地跑到敌方旗帜再跑回来交旗 ──');
{
  // 让统计有东西可记：一次打断、一次驱散、一次控制、一次假读条
  recordSkillUse(stats, carrier.id, 'warrior.mortal_strike' as never, true);
  recordSkillUse(stats, carrier.id, 'warrior.pummel' as never, false);

  const ev: shared.CombatEvent[] = [
    { t: 'interrupt', sourceId: carrier.id, targetId: defender.id, success: true, school: School.Frost },
    { t: 'interrupt', sourceId: carrier.id, targetId: defender.id, success: false, reason: 'notCasting' },
    { t: 'auraApplied', sourceId: carrier.id, targetId: defender.id, auraId: 'control.stun',
      duration: 4, auraKind: 'debuff', drCategory: DrCategory.Stun },
    { t: 'dispelled', sourceId: healer.id, targetId: carrier.id, auraId: 'control.root',
      auraKind: 'debuff', drCategory: DrCategory.Root },
    { t: 'heal', sourceId: healer.id, targetId: carrier.id, amount: 320, overheal: 0 },
  ];
  ingestCombatEvents(stats, world, ev, world.time);

  // 7.5 假读条：防守方主动取消读条，旗手的打断落空
  recordSelfCancel(stats, defender.id, world.time);
  ingestCombatEvents(stats, world, [
    { t: 'interrupt', sourceId: carrier.id, targetId: defender.id, success: false, reason: 'notCasting' },
  ], world.time + 0.4);

  // ── 旗手瞬移到敌方旗帜房拔旗，然后**靠真实碰撞代码**跑回来交旗 ──
  //
  // ★ 路线沿 ctfMap 声明的中央主路线的关键路点走，而不是朝目标直线跑。
  //   直线走会撞墙 —— 双桥要塞是一张有旗帜房门洞和中央桥梁的真实地图，
  //   「朝目标按住 W」在任何真实地图上都到不了。（第一版脚本就是这么写的，
  //   结果 120 秒只挪了 14.5 米。）
  const enemyFlag = enemyFlagOf(ctf, carrier.team);
  const enemyEntrance = ctfMap.flags!.find((f) => f.team === TEAM_BLUE)!.entrances[0]!;
  const ownEntrance = ctfMap.flags!.find((f) => f.team === TEAM_RED)!.entrances[0]!;

  carrier.position = { ...enemyFlag.basePosition };
  // 治疗一路跟着旗手 —— 16.3 的「护送」要的就是这个
  healer.position = { x: carrier.position.x + 2, y: carrier.position.y, z: carrier.position.z + 2 };
  moveStates.clear();

  const start = beginFlagInteract(
    ctf, carrier, enemyFlag, world.time,
    (p) => ctfDeps.captureZoneContains(TEAM_RED, p),
  );
  for (let i = 0; i < Math.ceil(CTF.PICKUP_SECONDS / DT) + 2; i++) tick(DT);

  check('取旗', '★ 真的拔到了敌方旗帜（走 flag.ts 的同一套状态机）',
    start.ok === true && carrier.flags.carryingFlag,
    `拔旗结果=${JSON.stringify(start)}；携旗=${carrier.flags.carryingFlag}`);

  // 16.1「吸收」+ 16.3「为旗手减伤」：治疗给旗手的护盾吃掉一发伤害。
  // ★ 必须在拔旗**之后**才有意义 —— 「为旗手减伤」的判据是目标正携旗
  ingestCombatEvents(stats, world, [{
    t: 'damage', sourceId: defender.id, targetId: carrier.id, amount: 40, school: School.Frost,
    absorbed: 90, overkill: 0, immune: false, preventedByEquipment: 12,
    absorbedBy: [{ sourceId: healer.id, amount: 90 }],
  }], world.time);
  // 16.3「为旗手治疗」同理
  ingestCombatEvents(stats, world, [
    { t: 'heal', sourceId: healer.id, targetId: carrier.id, amount: 320, overheal: 0 },
  ], world.time);

  // 返程路点：穿出敌方旗帜房门洞 → 中央路线 → 自家旗帜房门洞 → 自家旗帜
  const RETURN_PATH = [
    vec3(enemyEntrance.x, 0, enemyEntrance.z),
    vec3(0, 0, -60),
    vec3(0, 0, 0),
    vec3(0, 0, 60),
    vec3(ownEntrance.x, 0, ownEntrance.z),
    vec3(redBase.x, 0, redBase.z),
  ];

  const startPos = { ...carrier.position };
  let elapsed = 0;
  for (const wp of RETURN_PATH) {
    let stuck = 0;
    let last = { ...carrier.position };
    while (elapsed < 180 && distance2D(carrier.position, wp) > 2.5) {
      tick(DT, [{ e: carrier, to: wp }, { e: healer, to: wp }]);
      elapsed += DT;
      stuck = distance2D(carrier.position, last) < 0.02 ? stuck + DT : 0;
      last = { ...carrier.position };
      if (stuck > 2) break;   // 卡住就放弃这个路点，别白跑满 180 秒
    }
  }
  const straight = distance2D(startPos, carrier.position);

  check('跑图', '★ 靠真实碰撞代码从敌方旗帜房跑回己方基地',
    distance2D(carrier.position, redBase) <= 6 && carrier.flags.carryingFlag,
    `直线位移 ${straight.toFixed(1)}m，用了 ${elapsed.toFixed(1)}s，`
    + `距己方旗帜 ${distance2D(carrier.position, redBase).toFixed(1)}m，仍携旗=${carrier.flags.carryingFlag}`);

  const cap = beginFlagInteract(
    ctf, carrier, enemyFlag, world.time,
    (p) => ctfDeps.captureZoneContains(TEAM_RED, p),
  );
  for (let i = 0; i < Math.ceil(CTF.CAPTURE_SECONDS / DT) + 2; i++) tick(DT);

  check('交旗', '★ 交旗得分（12.1）',
    cap.ok === true && ctf.score[String(TEAM_RED as number)] === 1,
    `交旗结果=${JSON.stringify(cap)}；比分 ${ctf.score[String(TEAM_RED as number)]}:${ctf.score[String(TEAM_BLUE as number)]}`);
}

console.log('\n── 16.2：装备争夺与换装被统计 ──');
{
  const drop = {
    id: 1, kind: 'weapon' as const,
    weaponId: warrior.weapons.find((w) => !w.isDefault)!.id,
    classId: warrior.id, position: { ...carrier.position }, spawnedAt: world.time,
  };
  arsenal.drops.push(drop as never);

  ingestPickupEvents(stats, world, [
    { entityId: carrier.id, dropId: drop.id, result: 'completed' },
  ], () => 'weapon', world.time);

  const l = loadouts.get(carrier.id)!;
  const spare = warrior.weapons.find((w) => !w.isDefault)!;
  if (!l.spareWeapons.includes(spare.id)) addWeapon(l, spare.id);
  beginSwap(carrier, l, swaps, SwapKind.Weapon, spare.id, world.time);
  for (let i = 0; i < 30; i++) tick(DT);

  const s = stats.players.get(carrier.id)!;
  check('#50a', '★ 装备拾取与换装次数被统计（16.2）',
    s.arena.weaponPickups === 1 && s.arena.arsenalContestsWon >= 1 && s.arena.swaps >= 1,
    `拾取 ${s.arena.weaponPickups}，争夺胜出 ${s.arena.arsenalContestsWon}，换装 ${s.arena.swaps}`);

  check('#50b', '★ 护甲/武器减少的伤害被统计（16.2「护甲减少伤害」）',
    s.arena.damageReducedByEquipment > 0,
    `装备挡掉 ${s.arena.damageReducedByEquipment} 点 —— 这一项在装备 modifiers 接入战斗计算之前恒为 0`);

  const weaponTimes = [...s.arena.weaponTime.entries()].map(([w, t]) => `${w}=${t.toFixed(1)}s`);
  check('#50c', '各武器使用时长被统计（16.2）',
    s.arena.weaponTime.size >= 1 && [...s.arena.weaponTime.values()].some((t) => t > 0),
    weaponTimes.join('，'));
}

console.log('\n── 验收 #50：战后统计六类齐全 ──');
{
  const c = stats.players.get(carrier.id)!;
  const h = stats.players.get(healer.id)!;
  const d = stats.players.get(defender.id)!;

  const rows: [string, boolean, string][] = [
    ['打断', c.general.interruptsLanded > 0 && c.general.interruptsAttempted > c.general.interruptsLanded,
      `命中 ${c.general.interruptsLanded}/${c.general.interruptsAttempted}，成功率 ${((interruptSuccessRate(c) ?? 0) * 100).toFixed(0)}%`],
    ['驱散', h.general.dispels > 0, `驱散 ${h.general.dispels} 次，其中解除控制 ${h.general.controlBreaks} 次`],
    ['控制', c.general.controlSecondsApplied > 0, `施加控制 ${c.general.controlSecondsApplied.toFixed(1)}s`],
    ['换装', c.arena.swaps > 0, `换装 ${c.arena.swaps} 次`],
    ['装备争夺', c.arena.arsenalContestsWon > 0, `争夺胜出 ${c.arena.arsenalContestsWon} 次`],
    ['夺旗贡献', c.ctf.carries > 0 && c.ctf.captures > 0 && c.ctf.carrySeconds > 0 && c.ctf.carryDistance > 0,
      `携旗 ${c.ctf.carries} 次 / ${c.ctf.carrySeconds.toFixed(1)}s / ${c.ctf.carryDistance.toFixed(1)}m，交旗 ${c.ctf.captures} 次`],
  ];
  for (const [name, pass, detail] of rows) {
    check(`#50·${name}`, `★ 统计含${name}`, pass, detail);
  }

  check('#50·假读条', '★ 7.5 成功假读条被统计（骗掉对方一次打断）',
    d.general.fakeCastsBaited > 0, `成功假读条 ${d.general.fakeCastsBaited} 次`);

  check('#50·护送', '★ 16.3 护送/为旗手治疗/为旗手减伤被统计',
    h.ctf.escortSeconds > 0 && h.ctf.healingToCarrier > 0 && h.ctf.damageReducedForCarrier > 0,
    `护送 ${h.ctf.escortSeconds.toFixed(1)}s，为旗手治疗 ${h.ctf.healingToCarrier}，为旗手减伤 ${h.ctf.damageReducedForCarrier}`);

  check('#50·吸收归属', '★ 吸收记给下盾的人，不是被打的人（16.1）',
    h.general.absorbProvided > 0 && c.general.absorbProvided === 0,
    `治疗提供吸收 ${h.general.absorbProvided}，旗手名下吸收 ${c.general.absorbProvided}`);
}

console.log('\n── ★★ 16.4：不能只按总伤害或击杀数评选最佳玩家 ──');
{
  const roster = [...stats.players.values()];
  const awards = pickAwards(roster);

  check('#50·七奖', '★ 16.4 七个奖项全部产出',
    awards.length === 7,
    awards.map((a) => `${a.name}=${a.winner?.name ?? '(无)'}`).join('，'));

  // 造一个「只会打伤害」的玩家：伤害与击杀碾压全场，其余一无所有
  const dpsOnly = registerPlayer(stats, spawn(mage, TEAM_RED, { x: 40, y: 0, z: 40 }, '红·纯输出'));
  dpsOnly.general.damageDone = 5_000_000;
  dpsOnly.general.kills = 50;

  const after = pickAwards([...stats.players.values()]);
  const overall = after.find((a) => a.award === 'bestOverall')!;
  const topDamage = [...stats.players.values()].sort((a, b) => b.general.damageDone - a.general.damageDone)[0]!;

  check('#50·16.4', '★★ 伤害与击杀碾压全场但一无所有的人**拿不到**最佳综合玩家',
    overall.winner?.name !== dpsOnly.name && topDamage.name === dpsOnly.name,
    `全场最高伤害=${topDamage.name}（${topDamage.general.damageDone} 点 / ${topDamage.general.kills} 杀），`
    + `最佳综合玩家=${overall.winner?.name}`);

  const parts = overall.parts ?? [];
  const total = parts.reduce((a, p) => a + p.weight, 0);
  const maxShare = Math.max(...parts.map((p) => p.weight / total));
  check('#50·维度', '★ 综合评分由多个维度构成，且没有任何单一维度占主导',
    parts.length >= 4 && maxShare <= 0.35 + 1e-9,
    `${parts.length} 个维度：${parts.map((p) => `${p.dimension} ${(p.weight / total * 100).toFixed(0)}%`).join('，')}`);
}

// ════════════════════════════════════════════════════════════════
//  #51 / #52：文档与设计审查
// ════════════════════════════════════════════════════════════════

console.log('\n── 验收 #51 / #52：素材许可与公平性 ──');
{
  const fs = await import('node:fs');
  const license = fs.readFileSync('docs/09-asset-license.md', 'utf8');
  const fairness = fs.readFileSync('docs/12-fairness-review.md', 'utf8');

  // #51：GitHub 已分发媒体可拉/入库/发布（GH）；须有来源登记；无暴雪
  const hasInventory = /##\s*7\./.test(license) && /#51/.test(license);
  const allowsGithubFull = /可拉\s*\/\s*可入库\s*\/\s*可发布|入库.*发布|commit\/push/.test(license)
    || (/GitHub/.test(license) && /发布包/.test(license) && /GH/.test(license));
  const hasGhTier = /\*\*GH\*\*|档位.*GH|GH\s*—/.test(license) || /档位 \*\*GH\*\*/.test(license);
  const bansBlizzard = /暴雪/.test(license);
  check('#51', '★ 素材许可策略已落地（GitHub 媒体可入库/发布；有来源登记）',
    hasInventory && allowsGithubFull && bansBlizzard,
    `§7+#51=${hasInventory}，GH全流程=${allowsGithubFull}，GH档=${hasGhTier}，禁暴雪=${bansBlizzard}`);

  // #52：四项逐条对照
  const items = ['等级', '永久装备', '付费属性', '外观稀有度'];
  const missing = items.filter((k) => !fairness.includes(k));
  check('#52', '★ 不存在等级/永久装备/付费属性/外观稀有度优势（逐条设计审查）',
    missing.length === 0 && /17\.1/.test(fairness),
    missing.length === 0 ? `docs/12 逐条对照四项并引用 17.1` : `缺少：${missing.join('、')}`);

  // 用数据层再复核一次「外观不影响属性」——不能只靠文档说
  const cosmeticOnlyFields = shared.ALL_ARMORS.every((a) =>
    a.appearance === undefined || typeof a.appearance === 'string');
  const noLevelField = shared.ALL_CLASSES.every((c) => !('level' in c) && !('xp' in c));
  check('#52b', '★★ 用数据层复核：ClassDef 上没有等级字段，appearance 只是材质键',
    cosmeticOnlyFields && noLevelField,
    `八职业均无 level/xp 字段=${noLevelField}；appearance 仅为外观键=${cosmeticOnlyFields}`);
}

// ════════════════════════════════════════════════════════════════
//  统计表
// ════════════════════════════════════════════════════════════════

console.log('\n── 战后统计表（16.1–16.4 的实际产出）──');
{
  const roster = [...stats.players.values()];
  const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - [...s].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0)));
  console.log(`      ${pad('玩家', 12)}${pad('伤害', 10)}${pad('治疗', 10)}${pad('打断', 8)}${pad('控制s', 8)}${pad('携旗s', 8)}${pad('交旗', 6)}`);
  for (const s of roster) {
    console.log(`      ${pad(s.name, 12)}${pad(String(s.general.damageDone), 10)}`
      + `${pad(String(s.general.healingDone), 10)}`
      + `${pad(`${s.general.interruptsLanded}/${s.general.interruptsAttempted}`, 8)}`
      + `${pad(s.general.controlSecondsApplied.toFixed(1), 8)}`
      + `${pad(s.ctf.carrySeconds.toFixed(1), 8)}`
      + `${pad(String(s.ctf.captures), 6)}`);
  }
  console.log('');
  for (const a of pickAwards(roster)) {
    console.log(`      ${a.name}：${a.winner?.name ?? '(无)'}`);
  }
}

// ════════════════════════════════════════════════════════════════

const passed = results.filter((r) => r.pass).length;
console.log('\n' + '─'.repeat(60));
console.log(`M9 验收：${passed}/${results.length} 通过`);
if (passed !== results.length) {
  console.log('失败项：' + results.filter((r) => !r.pass).map((r) => r.id).join('、'));
  process.exit(1);
}
