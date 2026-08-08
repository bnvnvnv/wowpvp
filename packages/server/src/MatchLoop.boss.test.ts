/**
 * 随机大 BOSS 的**可达性**测试：一局真的对局、真的 `MatchLoop.advance()`，
 * 从开局推到 BOSS 出场、被打死、战利品落地、赏金入账。
 *
 * ★★ **为什么这个文件必须存在：**
 *   本仓库栽过五次「规则写对了、单测全绿、但真实对局里一次都不会发生」
 *   （M3/M4 的七个技能、M6 的整个军械箱、M7 的 `ctfWinner`、M9 的战斗意志、
 *   M14 的普攻）。`sim/boss.test.ts` 测的是规则，**它测不出没人接线**。
 *   这里走的是服务器的那条真路径：`createMatch` → `advance()` → 广播。
 *
 * ★ 本文件里的 BOSS 是**不出手的**：测试夹具没接 `onBossSpawned` 去建人机
 *   席位（那是 `RoomServer` 的活），所以它站着挨打。这是有意的 ——
 *   白盒测试要的是一个不会自己乱跑的靶子，而「它会不会打人」由
 *   `BotDriver` 那一侧的既有回归网负责。
 */

import { describe, expect, it } from 'vitest';
import {
  ArenaPreset, BOSS, GameMode, Slot,
  arena2v2, asClassId, createMatch, createRoom, dirToYaw, joinRoom, sub, teleportTo,
  type EntityId, type Match, type ServerMessage,
} from '@wowpvp/shared';

import { MatchLoop } from './MatchLoop.js';
import { createReconnectRegistry } from './room/reconnect.js';
import type { Session } from './room/Session.js';

const fakeSession = (playerId: string, out: ServerMessage[]): Session =>
  ({
    playerId,
    isBot: false,
    ackSeq: 0,
    following: undefined,
    takeInputs: () => [],
    send: (m: ServerMessage) => out.push(m),
    sendRaw: () => { /* 不看消息 */ },
    reject: () => { /* 不看消息 */ },
  } as unknown as Session);

interface Rig {
  match: Match;
  loop: MatchLoop;
  out: ServerMessage[];
  spawnedSeats: EntityId[];
  despawnedSeats: EntityId[];
}

const rig = (opts: { boss: boolean; preset?: ArenaPreset }): Rig => {
  const room = createRoom('r', 'human', {
    mode: GameMode.Arena2v2,
    mapId: arena2v2.id,
    preset: opts.preset ?? ArenaPreset.Armed,
    roundsToWin: 1,
    allowUnbalanced: true,
    fillWithBots: false,
    bossEnabled: opts.boss,
  });
  for (const [id, slot] of [['human', Slot.Red], ['foe', Slot.Blue]] as const) {
    const p = joinRoom(room, id, id);
    p.slot = slot;
    p.classId = asClassId('warrior');
    p.ready = true;
  }
  const match = createMatch(room, arena2v2);
  const out: ServerMessage[] = [];
  const sessions = [fakeSession('human', out), fakeSession('foe', [])];
  const spawnedSeats: EntityId[] = [];
  const despawnedSeats: EntityId[] = [];
  const loop = new MatchLoop(match, {
    sessions: () => sessions,
    reconnects: createReconnectRegistry(),
    onEliminate: () => { /* 本文件不关心 */ },
    onEnd: () => { /* 本文件不关心 */ },
    onBossSpawned: (id) => spawnedSeats.push(id),
    onBossDespawned: (id) => despawnedSeats.push(id),
  });
  return { match, loop, out, spawnedSeats, despawnedSeats };
};

const entityOf = (m: Match, playerId: string) =>
  m.world.entities.get(m.entityOf.get(playerId)!)!;

/** 推进到某个条件成立（或超过 tick 上限）。★ 用模拟时间，不等墙上时间 */
const advanceUntil = (r: Rig, done: () => boolean, maxTicks: number): number => {
  for (let i = 1; i <= maxTicks; i++) {
    r.loop.advance();
    if (done()) return i;
  }
  return -1;
};

describe('大 BOSS 在真实对局里可达', () => {
  it('★★ 开局约 60 秒后出场，并广播给玩家', () => {
    const r = rig({ boss: true });
    const ticks = advanceUntil(r, () => r.match.boss?.activeId !== undefined, 1500);

    expect(ticks).toBeGreaterThan(0);
    // 20Hz：60 秒 ≈ 1200 tick（允许一个 tick 的边界误差）
    expect(ticks).toBeGreaterThanOrEqual(BOSS.FIRST_SPAWN_SECONDS * 20);
    expect(ticks).toBeLessThanOrEqual(BOSS.FIRST_SPAWN_SECONDS * 20 + 1);

    const announce = r.out.filter((m) => m.t === 'BossEvent');
    expect(announce).toHaveLength(1);
    expect(announce[0]).toMatchObject({ kind: 'spawned' });

    // ★ 席位钩子被调用了 —— 服务器据此给 BOSS 接人机驱动
    expect(r.spawnedSeats).toEqual([r.match.boss!.activeId]);
  });

  it('★ BOSS 是普通实体，自然进快照（不需要为它加任何新通道）', () => {
    const r = rig({ boss: true });
    advanceUntil(r, () => r.match.boss?.activeId !== undefined, 1500);

    const snapshots = r.out.filter((m) => m.t === 'Snapshot');
    const last = snapshots[snapshots.length - 1]!;
    const bossId = r.match.boss!.activeId!;
    const view = last.entities.find((e) => e.id === bossId);
    expect(view).toBeDefined();
    expect(view!.maxHealth).toBeGreaterThan(5000);
  });

  it('★★ 打死它：掉落落地 + 赏金入账 + **不算一个人头**（不影响先到 N 杀判胜）', () => {
    const r = rig({ boss: true });
    advanceUntil(r, () => r.match.boss?.activeId !== undefined, 1500);
    const bossId = r.match.boss!.activeId!;
    const boss = r.match.world.entities.get(bossId)!;
    const me = entityOf(r.match, 'human');

    /**
     * 贴到 BOSS 身边并锁定它 —— 之后由 7.6 的普攻把它打死。
     * ★ 位置要连**移动状态**一起改：位置由 `MovementState` 驱动，
     *   只改实体坐标的话下一 tick 就被拽回去（W12 抓到过的真 bug）。
     */
    const spot = { x: boss.position.x + 2, y: boss.position.y, z: boss.position.z };
    r.match.movement.set(me.id, teleportTo(r.match.movement.get(me.id)!, spot, []));
    me.position = { ...spot };
    me.yaw = dirToYaw(sub(boss.position, spot));
    r.match.movement.get(me.id)!.yaw = me.yaw;
    // 白盒：把它打到一发白字就能收掉，免得测试里真的磨 15000 点血
    boss.health = 30;

    /**
     * ★ 记下击杀前地上已有的东西：武装竞技场的军械点自己也在刷货
     *  （开局 20 秒第一轮），不区分的话「BOSS 掉了什么」会把军械箱的货
     *   也算进来 —— 那样这条断言即使 BOSS 一件都没掉也照样绿。
     */
    const before = new Set(r.match.arsenal.drops.map((d) => d.id));

    r.loop.enqueue('human', { t: 'SetTarget', slot: 'hard', entityId: bossId });
    const killed = advanceUntil(r, () => r.match.boss?.activeId === undefined, 200);
    expect(killed).toBeGreaterThan(0);

    // ── 播报：最后一击者是我 ──
    const slain = r.out.filter((m) => m.t === 'BossEvent' && m.kind === 'slain');
    expect(slain).toHaveLength(1);
    expect(slain[0]).toMatchObject({ killerId: me.id, bounty: BOSS.KILL_BOUNTY });

    // ── 赏金入账（记在 sim 的账本上，模式怎么用它由模式决定）──
    expect(r.match.boss!.bounties.get(me.id)).toBe(BOSS.KILL_BOUNTY);

    // ── 战利品就在尸体位置附近，而且**是新掉的** ──
    const loot = r.match.arsenal.drops.filter((d) => !before.has(d.id));
    expect(loot.length).toBeGreaterThan(0);
    for (const d of loot) {
      const dist = Math.hypot(d.position.x - boss.position.x, d.position.z - boss.position.z);
      expect(dist).toBeLessThanOrEqual(BOSS.DROP_RING_RADIUS + 0.001);
    }
    // 场上都是战士 → 掉的是战士能用的备用武器 + 一件人人可用的增益道具
    expect(loot.some((d) => d.kind === 'weapon')).toBe(true);
    expect(loot.some((d) => d.kind === 'consumable')).toBe(true);

    /**
     * ★★ **BOSS 不是一个人头。** 大乱斗的胜负是「先到 N 杀」，而它读的正是
     *   `stats.players` 的击杀数 —— 一只 BOSS 白送一个胜点是这条玩法最容易
     *   出的事故。这里钉死：打死它，击杀数纹丝不动。
     */
    expect(r.match.stats.players.get(me.id)!.general.kills).toBe(0);
    expect(r.match.stats.players.has(bossId)).toBe(false);

    // ── 席位收掉、实体离场、下一只已排期 ──
    expect(r.despawnedSeats).toEqual([bossId]);
    expect(r.match.world.entities.has(bossId)).toBe(false);
    expect(r.match.boss!.nextSpawnAt).toBeGreaterThan(r.match.world.time);
  });

  it('★★ 默认关：房间没开这个开关时，一局里永远不会出现 BOSS', () => {
    const r = rig({ boss: false });
    expect(r.match.boss).toBeUndefined();
    for (let i = 0; i < BOSS.FIRST_SPAWN_SECONDS * 20 + 40; i++) r.loop.advance();

    expect(r.out.some((m) => m.t === 'BossEvent')).toBe(false);
    expect(r.spawnedSeats).toEqual([]);
    // 世界里仍然只有两个人 —— 整张回归网建立在这个前提上
    expect(r.match.world.entities.size).toBe(2);
  });
});
