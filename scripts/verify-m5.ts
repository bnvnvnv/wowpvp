/**
 * M5 端到端验收脚本。附录A#7 要求的阶段验收用例。
 *
 * 覆盖验收 #22（自由职业选择）、#24（地图尺寸与掩体）、#25（无复活、宠物不计存活）、
 * #26（同窗口双死判平局）、#27（决胜阶段能结束拖延）。
 *
 * ⚠️ 与 M1–M4 不同，这个脚本**不驱动浏览器**。
 *    回合流程是纯逻辑，要验的是「一局 6 分钟的比赛能正确走完」——
 *    在浏览器里实时等 6 分钟毫无意义，而且软件渲染下会引入不必要的不确定性。
 *    这里直接驱动 shared/sim，用**真实的时间步**跑完整局。
 *
 * 用法：pnpm verify:m5   （内部用 tsx 跑，以便直接 import shared 的 TS 源码）
 */

import * as shared from '../packages/shared/src/index.ts';

const {
  ArenaPreset, GameMode, School, TEAM_RED, TEAM_BLUE,
  aliveCount, arena2v2, arena3v3, arena5v5, ARENA_SPECS,
  createArena, createAuraStore, createDrStore, createEntity, createGroundStore,
  createProjectileStore, createRoom, createWorld, dealDamage, dampeningAt,
  addEntity, allocEntityId, asClassId, canStart, compositionHints,
  getClass, joinRoom, listEntities, resetRound, resolveEffects, selectClass,
  selectSlot, setReady, Slot, startMatch, teamWiped, tickArena,
  MOVE, ARENA, distance2D, vec3,
} = shared;

const results = [];
const check = (id, name, pass, detail) => {
  results.push({ id, pass });
  console.log(`  ${pass ? '✓' : '✗'} ${id} ${name}\n      ${detail}`);
};

// ── 搭一局 3v3 ───────────────────────────────────────────────────

const makeMatch = (opts = {}) => {
  const map = opts.map ?? arena3v3;
  const world = createWorld(map.geometry);
  const auras = createAuraStore();
  const dr = createDrStore();
  const ground = createGroundStore();
  const projectiles = createProjectileStore();
  const arena = createArena({
    mode: opts.mode ?? GameMode.Arena3v3,
    roundsToWin: opts.roundsToWin ?? 1,
    ...(opts.duration !== undefined ? { duration: opts.duration } : {}),
  });

  const spawnFor = (team, idx) => {
    const room = (map.prepRooms ?? []).find((r) => r.team === team);
    return room?.spawns[idx]?.position ?? { x: 0, y: 0, z: 0 };
  };

  const add = (classId, team, idx, isPet = false) =>
    addEntity(
      world,
      createEntity(allocEntityId(world), getClass(asClassId(classId)), team, spawnFor(team, idx), {
        name: `${team === TEAM_RED ? '红' : '蓝'}·${classId}${isPet ? '·宠物' : ''}`,
        isPet,
      }),
    );

  return { map, world, auras, dr, ground, projectiles, arena, add };
};

const advance = (m, seconds, step = 0.05, events = {}) => {
  for (let t = 0; t < seconds; t += step) tickArena(m.arena, m, step, events);
};

console.log('\n── 规格书 11.2 / 验收 #24：地图尺寸与掩体 ──');
{
  const rows = [];
  let allOk = true;
  for (const [i, map] of [arena2v2, arena3v3, arena5v5].entries()) {
    const spec = ARENA_SPECS[i];
    const spawn = map.prepRooms[0].spawns[0].position;
    const seconds = distance2D(spawn, vec3(0, 0, 0)) / MOVE.BASE_SPEED;
    const pillars = map.geometry.filter((v) => v.tag === 'pillar').length;
    const ok = Math.abs(seconds - spec.spawnToCenterSeconds) < 1.5 && pillars === spec.pillarCount;
    allOk &&= ok;
    rows.push(`${map.name} 出生点→中央 ${seconds.toFixed(1)}s（规格 ${spec.spawnToCenterSeconds}s）掩体 ${pillars} 个（规格 ${spec.pillarCount}）`);
  }
  check('#24', '★ 三张地图的尺寸与掩体数量符合 11.2', allOk, rows.join('；'));
}

console.log('\n── 规格书 3.2 / 验收 #22：自由职业选择 ──');
{
  const room = createRoom('r', 'host', {
    mode: GameMode.Arena3v3, mapId: arena3v3.id,
    preset: ArenaPreset.Classic, roundsToWin: 1, allowUnbalanced: false,
  });
  // 双方全是法师 —— 最极端的阵容
  for (const [slot, prefix] of [[Slot.Red, 'r'], [Slot.Blue, 'b']]) {
    for (let i = 0; i < 3; i++) {
      const id = `${prefix}${i}`;
      joinRoom(room, id, id);
      selectSlot(room, id, slot);
      selectClass(room, id, asClassId('mage'));
      setReady(room, id, true);
    }
  }
  const startCheck = canStart(room);
  const hints = compositionHints(room);

  check('#22a', '★ 全队同职业、无治疗也能开始（3.2 不强制阵容）',
    startCheck.ok && startMatch(room).ok,
    `canStart=${startCheck.ok}，阻塞原因=${startCheck.reasons.join('/') || '(无)'}`);

  check('#22b', '★ 阵容提示存在但永不阻塞',
    hints.length > 0 && hints.every((h) => h.blocking === false),
    `提示：${hints.map((h) => h.text).join('、')}`);
}

console.log('\n── 规格书 2.1 / 验收 #25：无复活、宠物不计入存活 ──');
{
  const m = makeMatch();
  m.add('warrior', TEAM_RED, 0);
  m.add('hunter', TEAM_BLUE, 0);
  const pet = m.add('hunter', TEAM_BLUE, 1, true);

  const before = aliveCount(m.world, TEAM_BLUE);
  // 蓝方玩家死亡，宠物还活着
  for (const e of listEntities(m.world)) if (e.team === TEAM_BLUE && !e.isPet) e.alive = false;

  check('#25a', '★ 宠物不计入存活人数（2.1）',
    before === 1 && aliveCount(m.world, TEAM_BLUE) === 0 && teamWiped(m.world, TEAM_BLUE) && pet.alive,
    `蓝方存活 ${before} → ${aliveCount(m.world, TEAM_BLUE)}，宠物仍存活=${pet.alive}，判定全灭=${teamWiped(m.world, TEAM_BLUE)}`);

  // 11.4：死亡后不能复活 —— 推进一整个回合，死者不会自己站起来
  advance(m, ARENA.PREP_SECONDS + 30);
  const stillDead = listEntities(m.world).filter((e) => e.team === TEAM_BLUE && !e.isPet).every((e) => !e.alive);
  check('#25b', '★ 11.4：当前回合死亡后不会复活', stillDead,
    `30 秒后蓝方玩家仍全部死亡=${stillDead}`);
}

console.log('\n── 规格书 2.1 / 验收 #26：同一结算窗口内双死判平局 ──');
{
  // 情形一：窗口内双方都全灭 → 平局
  const a = makeMatch();
  const redA = a.add('warrior', TEAM_RED, 0);
  const blueA = a.add('mage', TEAM_BLUE, 0);
  advance(a, ARENA.PREP_SECONDS + 0.2);
  blueA.alive = false;
  tickArena(a.arena, a, 0.05);
  redA.alive = false; // 同一窗口内
  tickArena(a.arena, a, 0.05);

  // 情形二：窗口过完才死 → 判负，不是平局
  const b = makeMatch();
  const redB = b.add('warrior', TEAM_RED, 0);
  const blueB = b.add('mage', TEAM_BLUE, 0);
  advance(b, ARENA.PREP_SECONDS + 0.2);
  blueB.alive = false;
  advance(b, ARENA.DRAW_WINDOW_SECONDS + 0.3);
  const outcomeB = JSON.stringify(b.arena.outcome);
  redB.alive = false;
  tickArena(b.arena, b, 0.05);

  check('#26', '★ 同窗口双死判平局；窗口过完才死则判负',
    a.arena.outcome?.winner === 'draw' && b.arena.outcome?.winner === TEAM_RED,
    `窗口内双死 → ${JSON.stringify(a.arena.outcome)}；窗口后才死 → ${outcomeB}（之后不再改变：${JSON.stringify(b.arena.outcome)}）`);
}

console.log('\n── 规格书 8.5 / 验收 #27：决胜阶段能结束拖延 ──');
{
  // 构造一个「多治疗拖延」的场景：常规时长很短，双方都不死
  const duration = 20;
  const m = makeMatch({ duration });
  const red = m.add('priest', TEAM_RED, 0);
  const blue = m.add('priest', TEAM_BLUE, 0);
  advance(m, ARENA.PREP_SECONDS + 0.2);

  // 记录抑制曲线与压迫伤害
  let pressureTotal = 0;
  const ctx = {
    world: m.world, auras: m.auras, dr: m.dr, projectiles: m.projectiles,
    groundAreas: m.ground.areas, traps: m.ground.traps,
    source: red, skillId: 'arena.pressure', events: [], resolve: () => {},
  };

  const samples = [];
  for (let t = 0; t < duration + 60; t += 0.5) {
    tickArena(m.arena, m, 0.5, {
      onPressureDamage: (amount) => {
        pressureTotal += amount;
        for (const e of listEntities(m.world)) {
          if (e.alive) dealDamage(ctx, e, amount, School.Physical, { bypassImmunity: true });
        }
      },
    });
    if (Math.abs(t - 10) < 0.3 || Math.abs(t - duration) < 0.3) {
      samples.push(`t=${t.toFixed(0)}s 抑制 ${(m.arena.dampening.amount * 100).toFixed(0)}%`);
    }
    if (m.arena.outcome) break;
  }

  check('#27a', '★ 决胜阶段的压迫伤害能打死拖延的双方',
    pressureTotal > 0 && (!red.alive || !blue.alive),
    `累计压迫伤害 ${pressureTotal.toFixed(0)}；红方存活=${red.alive} 蓝方存活=${blue.alive}；${samples.join('，')}`);

  check('#27b', '★ 决胜阶段抑制加速，治疗越来越无力',
    dampeningAt(GameMode.Arena3v3, 400, 360).amount >
      dampeningAt(GameMode.Arena3v3, 370, 360).amount,
    `常规末 ${(dampeningAt(GameMode.Arena3v3, 360, 360).amount * 100).toFixed(0)}% → ` +
    `决胜 +40s ${(dampeningAt(GameMode.Arena3v3, 400, 360).amount * 100).toFixed(0)}%`);
}

console.log('\n── 规格书 8.5 / 验收 #27：完全免疫挡不住压迫伤害 ──');
{
  const m = makeMatch();
  const mage = m.add('mage', TEAM_RED, 0);
  const src = m.add('warrior', TEAM_BLUE, 0);

  // 挂上完全免疫
  resolveEffects(
    { world: m.world, auras: m.auras, dr: m.dr, projectiles: m.projectiles, ground: m.ground, source: src, skillId: 'x' },
    [{ kind: 'applyAura', target: 'target', aura: {
      id: 'test.immunity', name: '完全免疫', kind: 'buff', duration: 100,
      dispelType: 'none', flags: { immuneAll: true }, description: '',
    } }],
    [mage],
  );
  mage.flags.immuneAll = true;

  const ctx = {
    world: m.world, auras: m.auras, dr: m.dr, projectiles: m.projectiles,
    groundAreas: m.ground.areas, traps: m.ground.traps,
    source: src, skillId: 'x', events: [], resolve: () => {},
  };

  const h0 = mage.health;
  dealDamage(ctx, mage, 200, School.Fire, {});                       // 普通伤害
  const afterNormal = mage.health;
  dealDamage(ctx, mage, 200, School.Physical, { bypassImmunity: true }); // 压迫伤害
  const afterPressure = mage.health;

  check('#27c', '★ 普通伤害被完全免疫挡下，压迫伤害穿透（8.5）',
    afterNormal === h0 && afterPressure === h0 - 200,
    `${h0} →（普通伤害）${afterNormal} →（压迫伤害）${afterPressure}`);
}

console.log('\n── 规格书 2.1 / 验收 #37：回合重置 ──');
{
  const m = makeMatch({ roundsToWin: 2 });
  const red = m.add('warrior', TEAM_RED, 0);
  const blue = m.add('mage', TEAM_BLUE, 0);
  advance(m, ARENA.PREP_SECONDS + 0.2);

  red.health = 10;
  red.cooldowns.set('x', 999);
  blue.alive = false;
  advance(m, ARENA.DRAW_WINDOW_SECONDS + 0.3);

  const wonRound = m.arena.score[String(TEAM_RED)] === 1;
  resetRound(m.arena, m);

  check('#37', '★ 回合结束后生命、冷却、状态全部重置（2.1）',
    wonRound && red.health === red.maxHealth && red.cooldowns.size === 0 && blue.alive,
    `红方生命 10 → ${red.health}/${red.maxHealth}，冷却数 ${red.cooldowns.size}，蓝方复活=${blue.alive}`);
}

console.log('\n── 一局完整比赛能走完 ──');
{
  const m = makeMatch({ duration: 30 });
  for (const [i, c] of ['warrior', 'mage', 'priest'].entries()) m.add(c, TEAM_RED, i);
  for (const [i, c] of ['rogue', 'hunter', 'paladin'].entries()) m.add(c, TEAM_BLUE, i);

  const phases = [];
  const ctx = {
    world: m.world, auras: m.auras, dr: m.dr, projectiles: m.projectiles,
    groundAreas: m.ground.areas, traps: m.ground.traps,
    source: listEntities(m.world)[0], skillId: 'arena.pressure', events: [], resolve: () => {},
  };

  for (let t = 0; t < 400 && !m.arena.outcome; t += 0.05) {
    tickArena(m.arena, m, 0.05, {
      onPhaseChange: (_f, to) => phases.push(to),
      onPressureDamage: (amount) => {
        for (const e of listEntities(m.world)) {
          if (e.alive && !e.isPet) dealDamage(ctx, e, amount, School.Physical, { bypassImmunity: true });
        }
      },
    });
  }

  check('M5', '★ 一局 3v3 从准备到分出结果能完整走完',
    m.arena.outcome !== null && phases.includes('combat') && phases.includes('resolved'),
    `阶段序列 ${phases.join(' → ')}；结果 ${JSON.stringify(m.arena.outcome)}；` +
    `存活 红 ${aliveCount(m.world, TEAM_RED)} / 蓝 ${aliveCount(m.world, TEAM_BLUE)}`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${'─'.repeat(60)}`);
console.log(`M5 验收：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('失败项：' + failed.map((f) => f.id).join(', '));
  process.exit(1);
}
