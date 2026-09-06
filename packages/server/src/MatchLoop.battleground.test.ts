import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArenaPreset, GameMode, Slot, TEAM_RED, asClassId, asSkillId, battleShopFor, createMatch, createRoom,
  ctfMap, hasLineOfSight, joinRoom, mapsForMode, parseClientMessage, teamSizeOf, teleportTo,
  type ClientMessage, type Match, type ServerMessage } from '@wowpvp/shared';
import { MatchLoop } from './MatchLoop.js';
import { BotDriver } from './BotDriver.js';
import { createReconnectRegistry } from './room/reconnect.js';
import type { Session } from './room/Session.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

const rig = (mode: GameMode = GameMode.Ctf6v6, playerClass = 'mage') => {
  const map = mode.startsWith('ctf') ? ctfMap : mapsForMode(mode)[0]!;
  const room = createRoom('battle-test', 'red0', {
    mode, mapId: map.id, preset: ArenaPreset.Classic, roundsToWin: 1, allowUnbalanced: true, fillWithBots: false,
  });
  const count = mode.startsWith('ctf') ? 2 : teamSizeOf(mode);
  const outputs = new Map<string, ServerMessage[]>();
  const inputs = new Map<string, Extract<ClientMessage, { t: 'Input' }>[]>();
  const sessions: Session[] = [];
  for (const slot of [Slot.Red, Slot.Blue]) for (let i = 0; i < count; i++) {
    const id = `${slot}${i}`;
    const player = joinRoom(room, id, id);
    player.slot = slot;
    player.classId = asClassId(id === 'red0' ? playerClass : 'mage');
    player.ready = true;
    const messages: ServerMessage[] = [];
    const queue: Extract<ClientMessage, { t: 'Input' }>[] = [];
    outputs.set(id, messages); inputs.set(id, queue);
    sessions.push({ playerId: id, isBot: false, ackSeq: 0, takeInputs: () => queue.splice(0),
      send: (message: ServerMessage) => messages.push(message),
      sendRaw: (raw: string) => messages.push(JSON.parse(raw) as ServerMessage),
      reject: (what: string, reason: string) => messages.push({ t: 'Rejected', what, reason }),
    } as unknown as Session);
  }
  const match = createMatch(room, map);
  const onEnd = vi.fn();
  let driver: BotDriver | undefined;
  cleanups.push(() => driver?.dispose());
  const loop = new MatchLoop(match, { sessions: () => sessions, reconnects: createReconnectRegistry(),
    onEliminate: () => {}, onEnd, onPreTick: () => driver?.tick() });
  const enableBot = (id: string): void => {
    driver ??= new BotDriver(() => match, (playerId, raw) => {
      const parsed = parseClientMessage(raw);
      if (!parsed.ok) throw new Error('Invalid bot message');
      const message = parsed.msg;
      if (message.t === 'Input') inputs.get(playerId)!.push(message);
      else if (message.t === 'CastRequest') loop.requestCast(playerId, message);
      else if (message.t === 'UseConsumable') loop.requestConsumable(playerId, message.slot);
      else if (message.t === 'SetTarget' || message.t === 'InteractStart' || message.t === 'BattleBuy') loop.enqueue(playerId, message);
    });
    driver.add({ playerId: id, reason: 'fill', difficulty: 'easy' });
  };
  return { match, loop, onEnd, outputs, enableBot };
};

const unit = (match: Match, id: string) => match.world.entities.get(match.entityOf.get(id)!)!;
const place = (match: Match, id: string, x: number, z: number): void => {
  const e = unit(match, id);
  e.position = { x, y: 0, z };
  match.movement.set(e.id, teleportTo(match.movement.get(e.id)!, e.position, match.world.obstacles));
};
const steps = (r: ReturnType<typeof rig>, n: number): void => { for (let i = 0; i < n; i++) r.loop.advance(); };

describe('playable match flows', () => {
  it('an arena melee bot navigates around cover and actually damages its target', () => {
    const r = rig(GameMode.Arena3v3, 'warrior');
    r.match.arena!.phase = 'combat';
    place(r.match, 'red0', 0, 6);
    place(r.match, 'blue0', 0, -6);
    const bot = unit(r.match, 'red0');
    const foe = unit(r.match, 'blue0');
    expect(hasLineOfSight(bot, foe, r.match.world.obstacles)).toBe(false);
    r.enableBot('red0');
    let detour = 0;
    for (let i = 0; i < 600 && foe.health === foe.maxHealth; i++) {
      r.loop.advance();
      detour = Math.max(detour, Math.abs(bot.position.x));
    }
    expect(detour).toBeGreaterThan(2);
    expect(foe.health).toBeLessThan(foe.maxHealth);
  });

  it('navigation does not interrupt a stationary self-heal just because the enemy is behind cover', () => {
    const r = rig(GameMode.Arena3v3, 'priest');
    r.match.arena!.phase = 'combat';
    place(r.match, 'red0', 0, 6);
    place(r.match, 'blue0', 0, -6);
    const bot = unit(r.match, 'red0');
    bot.health = 150;
    r.enableBot('red0');
    steps(r, 100);
    expect(bot.health).toBeGreaterThan(150);
    expect(r.outputs.get('red0')!.some(m => m.t === 'Heal' && m.targetId === bot.id)).toBe(true);
  });

  it.each([GameMode.Arena1v1, GameMode.Arena2v2, GameMode.Arena3v3, GameMode.Arena4v4, GameMode.Arena5v5])(
    '%s eliminates players for the round and ends when the team is wiped', mode => {
      const r = rig(mode);
      r.match.arena!.phase = 'combat';
      place(r.match, 'red0', 0, 15);
      place(r.match, 'blue0', 0, 5);
      unit(r.match, 'blue0').health = 1;
      r.loop.requestCast('red0', { skillId: asSkillId('mage.fire_blast'), targetId: unit(r.match, 'blue0').id });
      steps(r, 300);
      expect(r.match.respawn).toBeUndefined();
      expect(unit(r.match, 'blue0').alive).toBe(false);
      if (teamSizeOf(mode) > 1) {
        expect(r.onEnd).not.toHaveBeenCalled();
        for (let i = 1; i < teamSizeOf(mode); i++) {
          unit(r.match, `blue${i}`).alive = false;
          unit(r.match, `blue${i}`).health = 0;
        }
        steps(r, 15);
      }
      expect(r.onEnd).toHaveBeenCalledWith(TEAM_RED);
    },
  );

  it('connects kills, private experience, purchases, and a respawn wave', () => {
    const r = rig();
    place(r.match, 'red0', 0, 0);
    place(r.match, 'blue0', 0, -12);
    unit(r.match, 'blue0').health = 1;
    r.loop.requestCast('red0', { skillId: asSkillId('mage.fire_blast'), targetId: unit(r.match, 'blue0').id });
    steps(r, 20);
    const id = unit(r.match, 'red0').id;
    expect(r.match.battleground!.experience.get(id)).toBeGreaterThan(0);
    expect(r.outputs.get('red0')).toEqual(expect.arrayContaining([expect.objectContaining({ t: 'BattleReward', reason: 'kill' })]));
    expect(r.outputs.get('red1')!.some(m => m.t === 'BattleReward')).toBe(false);
    place(r.match, 'red0', 0, 156);
    const offer = battleShopFor(unit(r.match, 'red0').classId).find(o => o.kind === 'consumable')!;
    const before = r.match.battleground!.experience.get(id)!;
    r.loop.enqueue('red0', { t: 'BattleBuy', offerId: offer.offerId });
    r.loop.advance();
    expect(r.match.loadouts.get(id)!.consumables).toHaveLength(1);
    expect(r.match.battleground!.experience.get(id)).toBe(before - offer.cost);
    steps(r, 260);
    expect(unit(r.match, 'blue0').alive).toBe(true);
    const messages = r.outputs.get('red0')!;
    const shops = messages.filter(m => m.t === 'BattleShop');
    expect(shops.at(-1)?.balance).toBe(before - offer.cost);
    r.loop.sendShopTo('red0');
    expect(messages.at(-1)).toMatchObject({ t: 'BattleShop', balance: before - offer.cost });
  });

  it('enables a boss with actual loot and supplies in the default capture-the-flag match', () => {
    const r = rig();
    expect(r.match.boss).toBeDefined();
    expect(r.match.arsenal.enabled).toBe(true);
    r.match.boss!.nextSpawnAt = 0;
    steps(r, 2);
    const boss = r.match.world.entities.get(r.match.boss!.activeId!)!;
    place(r.match, 'red0', boss.position.x, boss.position.z + 12);
    boss.health = 1;
    r.loop.requestCast('red0', { skillId: asSkillId('mage.fire_blast'), targetId: boss.id });
    steps(r, 20);
    expect(r.match.boss!.slain).toBe(1);
    expect(r.match.arsenal.drops.length).toBeGreaterThan(0);
    expect(r.outputs.get('red1')).toEqual(expect.arrayContaining([expect.objectContaining({ t: 'BattleReward', reason: 'boss' })]));
  });

  it('a bot can leave its base, take the enemy flag and bring it home through real commands', () => {
    const r = rig();
    r.enableBot('red0');
    for (let i = 0; i < 2500 && !r.onEnd.mock.calls.length; i++) r.loop.advance();
    expect(r.match.ctf!.state.score[String(TEAM_RED)]).toBe(1);
    expect(r.onEnd).toHaveBeenCalledWith(TEAM_RED);
  });
});
