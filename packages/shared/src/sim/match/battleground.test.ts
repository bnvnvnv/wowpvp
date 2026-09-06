import { describe, expect, it } from 'vitest';
import { warrior, priest } from '../../data/index.js';
import { ctfMap } from '../../data/maps/ctf.js';
import { ArenaPreset, School } from '../../types/enums.js';
import { asEntityId, TEAM_BLUE, TEAM_RED } from '../../types/ids.js';
import { createEntity } from '../entity.js';
import { addEntity, createWorld } from '../world.js';
import { createLoadout } from '../loadout.js';
import { createArsenalStore, setupPartyDrops, tickPartyDrops } from '../arsenal.js';
import type { CombatEvent } from '../effects/registry.js';
import { BATTLE_XP, atBattleShop, battleShopFor, battlegroundSupplySites, buyBattleOffer, createBattleground, settleBattleExperience } from './battleground.js';

const rig = () => {
  const world = createWorld();
  const spawn = (id: number, team = TEAM_RED, cls = warrior) => addEntity(world,
    createEntity(asEntityId(id), cls, team, { x: 0, y: 0, z: team === TEAM_RED ? 156 : -156 }));
  const killer = spawn(1);
  const ally = spawn(2);
  const healer = spawn(3, TEAM_RED, priest);
  const enemy = spawn(4, TEAM_BLUE);
  return { world, killer, ally, healer, enemy, state: createBattleground() };
};
const damage = (sourceId: ReturnType<typeof asEntityId>, targetId: ReturnType<typeof asEntityId>): CombatEvent => ({
  t: 'damage', sourceId, targetId, amount: 50, absorbed: 0, overkill: 0, immune: false,
  school: School.Physical, skillId: 'autoAttack', preventedByEquipment: 0,
});

describe('battleground experience', () => {
  it('rewards a kill, recent damage assists, and healing support once each', () => {
    const r = rig();
    const events: CombatEvent[] = [
      { t: 'heal', sourceId: r.healer.id, targetId: r.ally.id, amount: 80, overheal: 0 },
      damage(r.ally.id, r.enemy.id), damage(r.killer.id, r.enemy.id),
      { t: 'death', targetId: r.enemy.id, killerId: r.killer.id },
    ];
    const rewards = settleBattleExperience(r.state, r.world, events, [], undefined);
    expect(rewards).toHaveLength(3);
    expect(r.state.experience.get(r.killer.id)).toBe(BATTLE_XP.KILL);
    expect(r.state.experience.get(r.ally.id)).toBe(BATTLE_XP.ASSIST);
    expect(r.state.experience.get(r.healer.id)).toBe(BATTLE_XP.ASSIST);
    expect(r.state.experience.has(r.enemy.id)).toBe(false);
  });

  it('does not award old assists, self kills, or friendly kills', () => {
    const r = rig();
    settleBattleExperience(r.state, r.world, [damage(r.ally.id, r.enemy.id)], [], undefined);
    r.world.time = BATTLE_XP.ASSIST_SECONDS + 1;
    settleBattleExperience(r.state, r.world, [{ t: 'death', targetId: r.enemy.id, killerId: r.killer.id },
      { t: 'death', targetId: r.ally.id, killerId: r.killer.id },
      { t: 'death', targetId: r.killer.id, killerId: r.killer.id }], [], undefined);
    expect(r.state.experience.get(r.killer.id)).toBe(BATTLE_XP.KILL);
    expect(r.state.experience.has(r.ally.id)).toBe(false);
    expect(r.state.damageCredits.size).toBe(0);
  });

  it('shares capture and boss rewards with teammates, including a dead healer', () => {
    const r = rig();
    r.healer.alive = false;
    settleBattleExperience(r.state, r.world, [], [{ type: 'captured', entityId: r.killer.id, flagTeam: TEAM_BLUE }], {
      slain: { bossId: asEntityId(90), killerId: r.killer.id, bounty: 500, killerTotal: 500,
        position: { x: 0, y: 0, z: 0 }, drops: [] },
    });
    expect(r.state.experience.get(r.healer.id)).toBe(BATTLE_XP.CAPTURE_TEAM + BATTLE_XP.BOSS_TEAM);
    expect(r.state.experience.get(r.killer.id)).toBe(BATTLE_XP.CAPTURE_TEAM + BATTLE_XP.CAPTURE_BONUS + BATTLE_XP.BOSS_TEAM);
    expect(r.state.experience.has(r.enemy.id)).toBe(false);
  });

  it('spends earned experience atomically while retaining the lifetime total for this match', () => {
    const r = rig();
    const loadout = createLoadout(r.killer.classId);
    settleBattleExperience(r.state, r.world, [], [{ type: 'returned', entityId: r.killer.id, flagTeam: TEAM_RED }], undefined);
    const offer = battleShopFor(r.killer.classId).find(o => o.kind === 'consumable')!;
    expect(buyBattleOffer(r.state, r.killer, loadout, ctfMap, offer.offerId, 0).ok).toBe(true);
    expect(loadout.consumables).toHaveLength(1);
    expect(r.state.earned.get(r.killer.id)).toBe(BATTLE_XP.RETURN);
    expect(r.state.experience.get(r.killer.id)).toBe(BATTLE_XP.RETURN - offer.cost);
    expect(buyBattleOffer(r.state, r.killer, loadout, ctfMap, offer.offerId, 0).ok).toBe(false);
    expect(loadout.consumables).toHaveLength(1);
    expect(createBattleground().experience.size).toBe(0);
  });

  it('rejects purchases outside the base, on death, or with insufficient experience without charging', () => {
    const r = rig();
    const loadout = createLoadout(r.killer.classId);
    const offer = battleShopFor(r.killer.classId)[0]!;
    r.state.experience.set(r.killer.id, 500);
    r.killer.position.z = 0;
    expect(atBattleShop(ctfMap, r.killer)).toBe(false);
    expect(buyBattleOffer(r.state, r.killer, loadout, ctfMap, offer.offerId, 0).ok).toBe(false);
    r.killer.position.z = 156;
    r.killer.alive = false;
    expect(buyBattleOffer(r.state, r.killer, loadout, ctfMap, offer.offerId, 1).ok).toBe(false);
    expect(r.state.experience.get(r.killer.id)).toBe(500);
    r.killer.alive = true;
    r.state.experience.set(r.killer.id, 0);
    expect(buyBattleOffer(r.state, r.killer, loadout, ctfMap, offer.offerId, 2).ok).toBe(false);
    expect(r.state.experience.get(r.killer.id)).toBe(0);
  });

  it('random supplies stay on symmetric legal sites and retain the bounded drop budget', () => {
    const sites = battlegroundSupplySites(ctfMap);
    expect(sites.length).toBeGreaterThan(8);
    for (const point of sites) expect(sites.some(p => Math.hypot(p.x + point.x, p.z + point.z) < 0.001)).toBe(true);
    const store = createArsenalStore(ArenaPreset.Classic);
    setupPartyDrops(store, { seed: 42, radius: 60, sites });
    tickPartyDrops(store, 1000);
    expect(store.drops.length).toBeGreaterThan(0);
    expect(store.drops.length).toBeLessThanOrEqual(6);
    for (const drop of store.drops) expect(sites).toContainEqual(drop.position);
  });
});
