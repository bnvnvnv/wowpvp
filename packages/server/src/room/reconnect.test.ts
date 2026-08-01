/**
 * 断线重连测试。规格书 11.5 / 17.3，docs/08 §6。
 *
 * ★ 最重要的一条是 `★★ 宽限期内角色照样掉血` ——
 *   「断线不提供无敌」是一条**否定式**规则，它成立的表现是「什么都没发生」，
 *   而「什么都没发生」不会让任何测试变红。所以必须显式地打他一下。
 */

import { describe, expect, it } from 'vitest';
import {
  createEntity,
  createWorld,
  addEntity,
  allocEntityId,
  createAuraStore,
  createDrStore,
  createGroundStore,
  createProjectileStore,
  dealDamage,
  deriveStatusFlags,
  markDisconnected,
  markReconnected,
  createRoom,
  joinRoom,
  selectSlot,
  selectClass,
  setReady,
  startMatch,
  leaveMatch,
  Slot,
  GameMode,
  ArenaPreset,
  School,
  TEAM_RED,
  asClassId,
  arena3v3,
  getClass,
  vec3,
  type CombatEvent,
} from '@wowpvp/shared';
import {
  RECONNECT_GRACE_SECONDS,
  createReconnectRegistry,
  graceRemaining,
  isAwaitingReconnect,
  leaveImmediately,
  redeemReconnect,
  registerDisconnect,
  takeExpired,
} from './reconnect.js';

/** 确定性令牌，避免测试依赖 randomUUID */
const seqTokens = () => {
  let n = 0;
  return () => `token-${++n}`;
};

describe('docs/08 §6 断线登记与重连', () => {
  it('断线产生一个带过期时刻的令牌', () => {
    const r = createReconnectRegistry();
    const rec = registerDisconnect(r, 'p1', 100, { tokenFactory: seqTokens() });
    expect(rec.token).toBe('token-1');
    expect(rec.expiresAt).toBe(100 + RECONNECT_GRACE_SECONDS);
    expect(isAwaitingReconnect(r, 'p1')).toBe(true);
  });

  it('限时内凭令牌重连成功，并要求下发完整快照', () => {
    const r = createReconnectRegistry();
    const rec = registerDisconnect(r, 'p1', 0, { tokenFactory: seqTokens() });
    const res = redeemReconnect(r, rec.token, RECONNECT_GRACE_SECONDS - 1);
    expect(res).toEqual({ ok: true, playerId: 'p1', fullSnapshotRequired: true });
  });

  it('重连成功后令牌立即作废，不能重复使用', () => {
    const r = createReconnectRegistry();
    const rec = registerDisconnect(r, 'p1', 0, { tokenFactory: seqTokens() });
    redeemReconnect(r, rec.token, 1);
    expect(redeemReconnect(r, rec.token, 2)).toEqual({ ok: false, reason: 'unknownToken' });
    expect(isAwaitingReconnect(r, 'p1')).toBe(false);
  });

  it('未知令牌被拒绝', () => {
    const r = createReconnectRegistry();
    expect(redeemReconnect(r, '不存在', 0)).toEqual({ ok: false, reason: 'unknownToken' });
  });

  it('超时后令牌失效', () => {
    const r = createReconnectRegistry();
    const rec = registerDisconnect(r, 'p1', 0, { tokenFactory: seqTokens() });
    expect(redeemReconnect(r, rec.token, RECONNECT_GRACE_SECONDS + 1))
      .toEqual({ ok: false, reason: 'expired' });
  });

  /** ★ 同一个人又断一次时旧令牌必须作废 —— 否则他会攒下多个可用令牌 */
  it('★ 再次断线会作废上一个令牌', () => {
    const r = createReconnectRegistry();
    const tokens = seqTokens();
    const first = registerDisconnect(r, 'p1', 0, { tokenFactory: tokens });
    const second = registerDisconnect(r, 'p1', 10, { tokenFactory: tokens });

    expect(redeemReconnect(r, first.token, 11)).toEqual({ ok: false, reason: 'unknownToken' });
    expect(redeemReconnect(r, second.token, 11)).toMatchObject({ ok: true });
  });

  it('剩余宽限时间可查，供 HUD 显示「队友掉线中」', () => {
    const r = createReconnectRegistry();
    registerDisconnect(r, 'p1', 100, { tokenFactory: seqTokens() });
    expect(graceRemaining(r, 'p1', 130)).toBe(RECONNECT_GRACE_SECONDS - 30);
    expect(graceRemaining(r, '没这人', 130)).toBeUndefined();
  });
});

describe('11.5 超时按淘汰处理', () => {
  it('takeExpired 只取出已超时的人，并把他们移出登记表', () => {
    const r = createReconnectRegistry();
    const tokens = seqTokens();
    registerDisconnect(r, 'p1', 0, { tokenFactory: tokens });
    registerDisconnect(r, 'p2', 50, { tokenFactory: tokens });

    const at = RECONNECT_GRACE_SECONDS + 10; // p1 超时，p2 还没
    expect(takeExpired(r, at)).toEqual(['p1']);
    expect(isAwaitingReconnect(r, 'p1')).toBe(false);
    expect(isAwaitingReconnect(r, 'p2')).toBe(true);
    // 已取出的人不会被取第二次
    expect(takeExpired(r, at)).toEqual([]);
  });

  /**
   * ★ 11.5：「主动退出立即按淘汰处理，不能通过退出规避死亡统计。」
   *   所以退出返回的是「立即淘汰」这个明确结论，而不是一条会过期的记录。
   */
  it('★ 主动退出立即淘汰，不进宽限期', () => {
    const r = createReconnectRegistry();
    registerDisconnect(r, 'p1', 0, { tokenFactory: seqTokens() });
    expect(leaveImmediately(r, 'p1')).toEqual({ eliminate: true, playerId: 'p1' });
    expect(isAwaitingReconnect(r, 'p1')).toBe(false);
  });

  /** ★ 11.5：退出**不**把玩家从房间里删掉 —— 删掉就没法记他的死亡了 */
  it('★ 比赛中退出只标记断线，玩家仍留在房间里（死亡统计需要他）', () => {
    const room = createRoom('r', 'p1', {
      mode: GameMode.Arena3v3, mapId: arena3v3.id,
      preset: ArenaPreset.Classic, roundsToWin: 1, allowUnbalanced: true,
    });
    for (const [id, slot] of [['p1', Slot.Red], ['p2', Slot.Blue]] as const) {
      joinRoom(room, id, id);
      selectSlot(room, id, slot);
      selectClass(room, id, asClassId('warrior'));
      setReady(room, id, true);
    }
    startMatch(room);

    leaveMatch(room, 'p1');
    expect(room.players.map((p) => p.id)).toContain('p1');
    expect(room.players.find((p) => p.id === 'p1')!.connected).toBe(false);
  });
});

describe('★★ 11.5 断线不提供无敌', () => {
  /**
   * ★★ 这是本文件最重要的一条。
   *
   *   「断线不获得无敌」是否定式规则 —— 它成立的表现是「什么都没发生」，
   *   而「什么都没发生」不会让任何测试变红。所以必须真的打他一下。
   */
  it('★★ 宽限期内角色留在原地、照样掉血', () => {
    const world = createWorld();
    const auras = createAuraStore();
    const dr = createDrStore();
    const ground = createGroundStore();

    const cls = getClass(asClassId('warrior'))!;
    const victim = addEntity(world, createEntity(allocEntityId(world), cls, TEAM_RED, vec3(0, 0, 0)));
    const attacker = addEntity(world, createEntity(allocEntityId(world), cls, TEAM_RED, vec3(0, 0, 2)));

    const registry = createReconnectRegistry();
    registerDisconnect(registry, 'victim', 0, { tokenFactory: seqTokens() });

    const positionBefore = { ...victim.position };
    const healthBefore = victim.health;

    victim.flags = deriveStatusFlags(auras, victim);
    const ctx = {
      world, auras, dr, projectiles: createProjectileStore(),
      groundAreas: ground.areas, traps: ground.traps,
      source: attacker, skillId: 'test', events: [] as CombatEvent[],
      resolve: () => {},
    };
    dealDamage(ctx, victim, 200, School.Physical);

    // 掉血了 —— 没有无敌
    expect(victim.health).toBeLessThan(healthBefore);
    // 留在原地 —— 没有被移出世界
    expect(victim.position).toEqual(positionBefore);
    expect(world.entities.has(victim.id)).toBe(true);
    // 也没有凭空多出任何免疫标志
    expect(victim.flags.immuneAll).toBe(false);
    expect(victim.flags.immunePhysical).toBe(false);
    expect(victim.flags.spawnProtection).toBe(false);
  });

  /**
   * ★ 这条守的是**结构**而不是行为：本模块的依赖里没有任何能碰到实体的东西。
   *   「断线时顺手给个免伤光环」必须先给它加一个现在没有的依赖。
   */
  it('★ reconnect 模块一个 import 都没有 —— 拿不到实体，所以给不出无敌', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('./reconnect.ts', import.meta.url), 'utf8');

    // ★ 只看 import 语句，不看注释 —— 注释里当然会提到 World
    const imports = src
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line));

    expect(imports).toEqual([]);
  });
});

describe('房间连接状态与重连登记表配合', () => {
  it('重连后房间层的 connected 恢复为 true', () => {
    const room = createRoom('r', 'p1', {
      mode: GameMode.Arena3v3, mapId: arena3v3.id,
      preset: ArenaPreset.Classic, roundsToWin: 1, allowUnbalanced: true,
    });
    joinRoom(room, 'p1', 'p1');
    selectSlot(room, 'p1', Slot.Red);
    selectClass(room, 'p1', asClassId('warrior'));

    const registry = createReconnectRegistry();
    markDisconnected(room, 'p1');
    const rec = registerDisconnect(registry, 'p1', 0, { tokenFactory: seqTokens() });
    expect(room.players[0]!.connected).toBe(false);

    const res = redeemReconnect(registry, rec.token, 10);
    expect(res.ok).toBe(true);
    expect(markReconnected(room, 'p1')).toBe(true);
    expect(room.players[0]!.connected).toBe(true);
  });
});
