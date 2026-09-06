import { EQUIP } from '../../constants/combat.js';
import { CONSUMABLES } from '../../data/consumables.js';
import { getArmor, getWeapon } from '../../data/index.js';
import type { MapDef } from '../../data/maps/schema.js';
import type { Vec3 } from '../../math/vec3.js';
import { ArsenalChoice } from '../../types/enums.js';
import { TEAM_BLUE, TEAM_RED, type ArmorId, type ClassId, type ConsumableId, type EntityId, type WeaponId } from '../../types/ids.js';
import { armoryOptionsFor } from '../arsenal.js';
import type { BossTickResult } from '../boss.js';
import type { CombatEvent } from '../effects/registry.js';
import type { CombatEntity } from '../entity.js';
import { addArmor, addConsumable, addWeapon, canPickupArmor, canPickupWeapon, type Loadout } from '../loadout.js';
import type { World } from '../world.js';
import type { FlagEvent } from './flag.js';

export const BATTLE_XP = {
  KILL: 90, ASSIST: 45, RETURN: 60, CAPTURE_TEAM: 120, CAPTURE_BONUS: 60,
  BOSS_TEAM: 180, ASSIST_SECONDS: 12, PURCHASE_INTERVAL: 0.5,
} as const;

export type BattleRewardReason = 'kill' | 'assist' | 'flagReturn' | 'flagCapture' | 'boss';
export interface BattleReward { entityId: EntityId; amount: number; reason: BattleRewardReason }
export interface BattlegroundState {
  experience: Map<EntityId, number>;
  earned: Map<EntityId, number>;
  damageCredits: Map<EntityId, Map<EntityId, number>>;
  healingCredits: Map<EntityId, Map<EntityId, number>>;
  purchaseAfter: Map<EntityId, number>;
}

export const createBattleground = (): BattlegroundState => ({
  experience: new Map(), earned: new Map(), damageCredits: new Map(),
  healingCredits: new Map(), purchaseAfter: new Map(),
});

const participant = (e: CombatEntity | undefined): e is CombatEntity =>
  !!e && !e.isPet && (e.team === TEAM_RED || e.team === TEAM_BLUE);

/** Fold authoritative events after flag and boss settlement. Balances survive respawn, not a new match. */
export const settleBattleExperience = (
  state: BattlegroundState, world: World, events: readonly CombatEvent[],
  flags: readonly FlagEvent[], boss: BossTickResult | undefined,
): BattleReward[] => {
  const now = world.time;
  const rewards: BattleReward[] = [];
  const grant = (id: EntityId, amount: number, reason: BattleRewardReason): void => {
    if (!participant(world.entities.get(id))) return;
    state.experience.set(id, (state.experience.get(id) ?? 0) + amount);
    state.earned.set(id, (state.earned.get(id) ?? 0) + amount);
    rewards.push({ entityId: id, amount, reason });
  };
  const teamGrant = (actor: CombatEntity, amount: number, reason: BattleRewardReason): void => {
    for (const e of world.entities.values()) if (e.team === actor.team) grant(e.id, amount, reason);
  };
  const record = (store: Map<EntityId, Map<EntityId, number>>, target: EntityId, source: EntityId): void => {
    let credits = store.get(target);
    if (!credits) { credits = new Map(); store.set(target, credits); }
    credits.set(source, now);
  };
  for (const ev of events) {
    if (ev.t === 'damage' || ev.t === 'heal') {
      if (ev.amount <= 0) continue;
      const source = world.entities.get(ev.sourceId);
      const target = world.entities.get(ev.targetId);
      if (!participant(source) || !participant(target)) continue;
      if (ev.t === 'damage' && source.team !== target.team) record(state.damageCredits, target.id, source.id);
      if (ev.t === 'heal' && source.team === target.team && source.id !== target.id) record(state.healingCredits, target.id, source.id);
    } else if (ev.t === 'death') {
      const victim = world.entities.get(ev.targetId);
      const killer = ev.killerId === undefined ? undefined : world.entities.get(ev.killerId);
      const credits = state.damageCredits.get(ev.targetId);
      state.damageCredits.delete(ev.targetId);
      if (!participant(victim) || !participant(killer) || killer.team === victim.team) continue;
      grant(killer.id, BATTLE_XP.KILL, 'kill');
      const contributors = new Set<EntityId>([killer.id]);
      for (const [id, time] of credits ?? []) {
        const source = world.entities.get(id);
        if (now - time <= BATTLE_XP.ASSIST_SECONDS && participant(source) && source.team === killer.team) contributors.add(id);
      }
      const assists = new Set(contributors);
      for (const id of contributors) for (const [healer, time] of state.healingCredits.get(id) ?? []) {
        const source = world.entities.get(healer);
        if (now - time <= BATTLE_XP.ASSIST_SECONDS && participant(source) && source.team === killer.team) assists.add(healer);
      }
      assists.delete(killer.id);
      for (const id of assists) grant(id, BATTLE_XP.ASSIST, 'assist');
    }
  }
  for (const ev of flags) {
    const actor = ev.entityId === undefined ? undefined : world.entities.get(ev.entityId);
    if (!participant(actor)) continue;
    if (ev.type === 'returned') grant(actor.id, BATTLE_XP.RETURN, 'flagReturn');
    if (ev.type === 'captured') {
      teamGrant(actor, BATTLE_XP.CAPTURE_TEAM, 'flagCapture');
      grant(actor.id, BATTLE_XP.CAPTURE_BONUS, 'flagCapture');
    }
  }
  const slayer = boss?.slain?.killerId;
  const actor = slayer === undefined ? undefined : world.entities.get(slayer);
  if (participant(actor)) teamGrant(actor, BATTLE_XP.BOSS_TEAM, 'boss');
  for (const store of [state.damageCredits, state.healingCredits]) for (const [target, credits] of store) {
    for (const [source, time] of credits) if (now - time > BATTLE_XP.ASSIST_SECONDS) credits.delete(source);
    if (!credits.size) store.delete(target);
  }
  return rewards;
};

export interface BattleOffer {
  offerId: string;
  name: string;
  cost: number;
  kind: 'weapon' | 'armor' | 'consumable';
  description: string;
}

interface BattleStock extends BattleOffer {
  weaponId?: WeaponId;
  armorId?: ArmorId;
  consumableId?: ConsumableId;
}

const battleStockFor = (classId: ClassId): BattleStock[] => {
  const options = armoryOptionsFor(classId);
  const weaponId = options.find(o => o.choice === ArsenalChoice.Offense)?.weaponId;
  const armorId = options.find(o => o.choice === ArsenalChoice.Defense)?.armorId;
  const stock: BattleStock[] = [];
  const weapon = weaponId ? getWeapon(weaponId) : undefined;
  const armor = armorId ? getArmor(armorId) : undefined;
  if (weapon && weaponId) stock.push({ offerId: 'battle.weapon', name: weapon.name, cost: 240,
    kind: 'weapon', weaponId, description: '备用武器' });
  if (armor && armorId) stock.push({ offerId: 'battle.armor', name: armor.name, cost: 180,
    kind: 'armor', armorId, description: '备用护甲' });
  for (const item of CONSUMABLES) stock.push({
    offerId: `battle.${item.id}`, name: item.name, cost: 60, kind: 'consumable',
    consumableId: item.id, description: item.description,
  });
  return stock;
};

export const battleShopFor = (classId: ClassId): BattleOffer[] =>
  battleStockFor(classId).map(({ offerId, name, cost, kind, description }) => ({ offerId, name, cost, kind, description }));

/** The base shop uses the same map volumes on the client and server. */
export const atBattleShop = (map: MapDef, entity: Pick<CombatEntity, 'position' | 'team'>): boolean =>
  (map.graveyards ?? []).some(({ team, volume: { min, max } }) => team === entity.team
    && entity.position.x >= min.x && entity.position.x <= max.x
    && entity.position.y >= min.y - 0.1 && entity.position.y <= max.y
    && entity.position.z >= min.z && entity.position.z <= max.z);

export const buyBattleOffer = (
  state: BattlegroundState, entity: CombatEntity, loadout: Loadout, map: MapDef, offerId: string, now: number,
): { ok: true; offer: BattleOffer; balance: number } | { ok: false; reason: string } => {
  if (!participant(entity) || !entity.alive) return { ok: false, reason: '阵亡时不能购买' };
  if (!atBattleShop(map, entity)) return { ok: false, reason: '返回己方基地后可购买' };
  if (entity.flags.carryingFlag) return { ok: false, reason: '携旗期间不能购买' };
  if ((state.purchaseAfter.get(entity.id) ?? 0) > now) return { ok: false, reason: '购买处理中' };
  const stock = battleStockFor(entity.classId).find(o => o.offerId === offerId);
  if (!stock) return { ok: false, reason: '没有这件商品' };
  if (stock.weaponId) {
    const check = canPickupWeapon(entity, loadout, stock.weaponId);
    if (!check.ok) return { ok: false, reason: check.hint };
  }
  if (stock.armorId) {
    const check = canPickupArmor(entity, loadout, stock.armorId);
    if (!check.ok) return { ok: false, reason: check.hint };
  }
  if (stock.consumableId && loadout.consumables.length >= EQUIP.MAX_CONSUMABLES) return { ok: false, reason: '道具栏已满' };
  const balance = state.experience.get(entity.id) ?? 0;
  if (balance < stock.cost) return { ok: false, reason: `经验不足（需要 ${stock.cost}）` };
  if (stock.weaponId) addWeapon(loadout, stock.weaponId);
  if (stock.armorId) addArmor(loadout, stock.armorId);
  if (stock.consumableId) addConsumable(loadout, stock.consumableId);
  state.experience.set(entity.id, balance - stock.cost);
  state.purchaseAfter.set(entity.id, now + BATTLE_XP.PURCHASE_INTERVAL);
  const { offerId: id, name, cost, kind, description } = stock;
  return { ok: true, offer: { offerId: id, name, cost, kind, description }, balance: balance - stock.cost };
};

/** Symmetric supply sites on walkable ground, outside bases and solid volumes. */
export const battlegroundSupplySites = (map: MapDef): Vec3[] => {
  const sites: Vec3[] = [];
  const cx = (map.bounds.min.x + map.bounds.max.x) / 2;
  const cz = (map.bounds.min.z + map.bounds.max.z) / 2;
  const halfX = (map.bounds.max.x - map.bounds.min.x) / 2;
  const halfZ = (map.bounds.max.z - map.bounds.min.z) / 2;
  const legal = (p: Vec3): boolean => {
    const supported = map.geometry.some(v => v.blocksMovement !== false && v.standable !== false
      && Math.abs(v.max.y - p.y) < 0.1 && p.x >= v.min.x + 1 && p.x <= v.max.x - 1
      && p.z >= v.min.z + 1 && p.z <= v.max.z - 1);
    const blocked = map.geometry.some(v => v.blocksMovement !== false && v.max.y > p.y + 0.1
      && v.min.y < p.y + 2 && p.x >= v.min.x - 1 && p.x <= v.max.x + 1
      && p.z >= v.min.z - 1 && p.z <= v.max.z + 1);
    return supported && !blocked;
  };
  for (const x of [-0.65, -0.35, 0, 0.35, 0.65]) for (const z of [0.15, 0.35, 0.55]) {
    const a = { x: cx + halfX * x, y: 0, z: cz + halfZ * z };
    const b = { x: cx - halfX * x, y: 0, z: cz - halfZ * z };
    if (legal(a) && legal(b)) sites.push(a, b);
  }
  return sites;
};
