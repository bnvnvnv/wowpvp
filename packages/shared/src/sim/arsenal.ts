/**
 * 军械箱、补给刷新与拾取。规格书 10.1–10.5 / 10.9，验收 #28 / #29。
 *
 * 两条最容易做错的规则：
 *
 *   1. **10.2 / 验收 #29：职业不匹配时提示，但物品不会消失。**
 *      `attemptPickup()` 失败时**不删除地面物品** —— 拒绝路径和成功路径
 *      在代码里是完全分开的两段，失败那段根本没有删除语句。
 *
 *   2. **10.5：普通伤害不直接中断拾取。**
 *      与 7.3 的「普通伤害不打断施法」同源。`tickPickups()` 的中断条件里
 *      刻意没有伤害 —— 和 `interrupt.onDamageTaken()` 一样，
 *      这是一条「什么都不做」的规则，写成显式注释以免将来被误加。
 */

import { EQUIP, RANGE } from '../constants/combat.js';
import { distance2D, type Vec3 } from '../math/vec3.js';
import { ALL_CLASSES, getArmor, getClass, getWeapon } from '../data/index.js';
import { ArenaPreset, ArsenalChoice, GameMode } from '../types/enums.js';
import type { ArmorId, ClassId, EntityId, WeaponId } from '../types/ids.js';
import type { CombatEntity } from './entity.js';
import {
  addArmor, addWeapon, canPickupArmor, canPickupWeapon,
  type Loadout, type PickupCheck,
} from './loadout.js';

// ── 地面掉落 ─────────────────────────────────────────────────────

export type DropKind = 'weapon' | 'armor' | 'consumable';

export interface GroundDrop {
  id: number;
  kind: DropKind;
  weaponId?: WeaponId;
  armorId?: ArmorId;
  /** 10.2：物品的职业归属。不匹配的玩家看得到但拿不走 */
  classId: ClassId;
  position: Vec3;
  spawnedAt: number;
}

/** 10.4 中立军械箱：打开后只向打开者显示其职业的三个横向选择 */
export interface Armory {
  id: number;
  position: Vec3;
  /** 首次刷新与后续间隔（10.4：固定、可预测）*/
  firstSpawnAt: number;
  respawnInterval: number;
  /** 下一次可用的时刻。10.4 要求提前 5 秒预告 */
  availableAt: number;
  role: 'primary' | 'side' | 'tactical';
  /** 已被谁打开（打开后进入冷却）*/
  openedBy?: EntityId;
}

export interface ArsenalStore {
  drops: GroundDrop[];
  armories: Armory[];
  nextId: number;
  /** 10.1：经典竞技场不生成任何临时武装（验收 #28）*/
  enabled: boolean;
}

export const createArsenalStore = (preset: ArenaPreset): ArsenalStore => ({
  drops: [],
  armories: [],
  nextId: 1,
  // ★ 验收 #28：经典竞技场不生成临时武装，武装竞技场才生成
  enabled: preset === ArenaPreset.Armed,
});

/**
 * 10.4：各模式的军械点数量。
 *   2v2 同一时间最多一个主要军械点
 *   3v3 一个中央军械点 + 轮换侧点
 *   5v5 中央与两侧多个战术点
 */
export const armoryLayoutFor = (mode: GameMode): { role: Armory['role']; offset: Vec3 }[] => {
  switch (mode) {
    case GameMode.Arena2v2:
      return [{ role: 'primary', offset: { x: 0, y: 0, z: 0 } }];
    case GameMode.Arena3v3:
      return [
        { role: 'primary', offset: { x: 0, y: 0, z: 0 } },
        { role: 'side', offset: { x: -14, y: 0, z: 0 } },
        { role: 'side', offset: { x: 14, y: 0, z: 0 } },
      ];
    case GameMode.Arena5v5:
      return [
        { role: 'primary', offset: { x: 0, y: 0, z: 0 } },
        { role: 'side', offset: { x: -18, y: 0, z: 0 } },
        { role: 'side', offset: { x: 18, y: 0, z: 0 } },
        { role: 'tactical', offset: { x: 0, y: 0, z: -18 } },
        { role: 'tactical', offset: { x: 0, y: 0, z: 18 } },
      ];
    default:
      // 12.x：夺旗模式首版关闭临时装备
      return [];
  }
};

/**
 * 按模式布置军械点。
 *
 * ★ 10.4 / 11.3：「双方到达距离必须大体相等」——
 *   所有军械点都沿 ±Z 对称（offset.z 要么为 0，要么成对出现），
 *   而出生点也是 ±Z 对称的，所以距离天然相等。`arsenal.test.ts` 会断言这一点。
 */
export const setupArmories = (
  store: ArsenalStore,
  mode: GameMode,
  now: number,
  firstSpawnAt = 20,
  respawnInterval = 60,
): void => {
  if (!store.enabled) return;
  for (const { role, offset } of armoryLayoutFor(mode)) {
    store.armories.push({
      id: store.nextId++,
      position: { ...offset },
      firstSpawnAt,
      respawnInterval,
      availableAt: now + firstSpawnAt,
      role,
    });
  }
};

/** 10.4：刷新前 5 秒要给出小地图图标、地面光柱、文字和音效 */
export const telegraphedArmories = (store: ArsenalStore, now: number): Armory[] =>
  store.armories.filter(
    (a) =>
      a.availableAt > now && a.availableAt - now <= EQUIP.SPAWN_TELEGRAPH_SECONDS,
  );

export const availableArmories = (store: ArsenalStore, now: number): Armory[] =>
  store.armories.filter((a) => a.availableAt <= now);

// ── 10.4 军械箱的三选一 ──────────────────────────────────────────

export interface ArsenalOption {
  choice: ArsenalChoice;
  weaponId?: WeaponId;
  armorId?: ArmorId;
  advantage: string;
  cost: string;
}

/**
 * 10.4：「中立军械箱被打开后，只向打开者显示**其职业**的三个横向选择：
 *        进攻、机动、防御。」
 *
 * 三个选项都来自打开者自己的职业池，所以不存在「开出用不了的东西」。
 */
export const armoryOptionsFor = (classId: ClassId): ArsenalOption[] => {
  const cls = getClass(classId);
  if (!cls) return [];

  const armorOf = (suffix: string) =>
    cls.armors.find((a) => (a.id as string).endsWith(`.${suffix}`));

  const offense = armorOf('offense');
  const mobility = armorOf('mobility');
  const guardian = armorOf('guardian');

  // 进攻选项优先给「非默认武器里单击最高的那把」，让三选一确实是横向取舍
  const spares = cls.weapons.filter((w) => !w.isDefault);
  const heaviest = [...spares].sort((a, b) => b.swingPercent - a.swingPercent)[0];

  return [
    {
      choice: ArsenalChoice.Offense,
      ...(heaviest ? { weaponId: heaviest.id } : {}),
      ...(offense ? { armorId: offense.id } : {}),
      advantage: heaviest?.advantage ?? offense?.advantage ?? '攻击效率提高',
      cost: heaviest?.cost ?? offense?.cost ?? '防御下降',
    },
    {
      choice: ArsenalChoice.Mobility,
      ...(mobility ? { armorId: mobility.id } : {}),
      advantage: mobility?.advantage ?? '移动与追击提高',
      cost: mobility?.cost ?? '基础防御与击退抵抗降低',
    },
    {
      choice: ArsenalChoice.Defense,
      ...(guardian ? { armorId: guardian.id } : {}),
      advantage: guardian?.advantage ?? '物理防御与爆发承受提高',
      cost: guardian?.cost ?? '移动、攻速与施法速度降低',
    },
  ];
};

/**
 * 10.4：「实体掉落只从**当前房间实际存在的职业池**中生成，
 *        避免刷出无人可用装备。」
 */
export const spawnDropsFromRoster = (
  store: ArsenalStore,
  rosterClassIds: readonly ClassId[],
  position: Vec3,
  now: number,
): GroundDrop[] => {
  if (!store.enabled) return [];
  const pool = [...new Set(rosterClassIds.map((c) => c as string))];
  const spawned: GroundDrop[] = [];

  for (const classId of pool) {
    const cls = ALL_CLASSES.find((c) => (c.id as string) === classId);
    if (!cls) continue;
    const spare = cls.weapons.find((w) => !w.isDefault);
    if (!spare) continue;
    const drop: GroundDrop = {
      id: store.nextId++,
      kind: 'weapon',
      weaponId: spare.id,
      classId: cls.id,
      position: { ...position },
      spawnedAt: now,
    };
    store.drops.push(drop);
    spawned.push(drop);
  }
  return spawned;
};

// ── 10.5 拾取 ────────────────────────────────────────────────────

export interface PickupState {
  dropId: number;
  startedAt: number;
  endsAt: number;
  startPosition: Vec3;
}

export type PickupStore = Map<EntityId, PickupState>;
export const createPickupStore = (): PickupStore => new Map();

export type PickupStart =
  | { ok: true; state: PickupState }
  | { ok: false; reason: string; itemRemains: true };

/**
 * 10.5 开始拾取。
 *
 * ★ 验收 #29：所有失败路径都返回 `itemRemains: true` ——
 *   这个字段存在的意义是提醒调用方**不要删除地面物品**。
 *   10.2 明确规定「错误交互不会使物品消失」。
 */
export const beginPickup = (
  entity: CombatEntity,
  loadout: Loadout,
  store: ArsenalStore,
  pickups: PickupStore,
  dropId: number,
  now: number,
): PickupStart => {
  const drop = store.drops.find((d) => d.id === dropId);
  if (!drop) return { ok: false, reason: '物品不存在', itemRemains: true };

  if (!entity.alive) return { ok: false, reason: '已死亡', itemRemains: true };
  if (entity.flags.stunned) return { ok: false, reason: '无法行动', itemRemains: true };

  // 10.5：角色进入 2.2 米交互距离
  if (distance2D(entity.position, drop.position) > RANGE.INTERACT) {
    return { ok: false, reason: '距离太远', itemRemains: true };
  }

  const check = checkPickup(entity, loadout, drop);
  if (!check.ok) return { ok: false, reason: check.hint, itemRemains: true };

  const state: PickupState = {
    dropId,
    startedAt: now,
    endsAt: now + EQUIP.PICKUP_SECONDS,
    startPosition: { ...entity.position },
  };
  pickups.set(entity.id, state);
  return { ok: true, state };
};

const checkPickup = (
  entity: CombatEntity,
  loadout: Loadout,
  drop: GroundDrop,
): PickupCheck => {
  if (drop.kind === 'weapon' && drop.weaponId) {
    return canPickupWeapon(entity, loadout, drop.weaponId);
  }
  if (drop.kind === 'armor' && drop.armorId) {
    return canPickupArmor(entity, loadout, drop.armorId);
  }
  return { ok: true };
};

export type PickupInterruptReason = 'moved' | 'stunned' | 'forcedMove' | 'death' | 'cancelled' | 'taken';

export interface PickupTickEvent {
  entityId: EntityId;
  dropId: number;
  result: 'completed' | PickupInterruptReason;
}

/**
 * 推进所有拾取一个 tick。
 *
 * ★ 10.5 的中断条件是「移动、硬控制、强制位移、死亡」——
 *   **普通伤害不在其中**。这与 7.3「普通伤害不打断施法」同源。
 *   下面刻意没有伤害相关的分支；这是一条「什么都不做」的规则，
 *   写在这里以免将来有人「顺手补上」。
 *
 * ★ 10.2：「同一职业有多名玩家时，谁先完成拾取谁获得」——
 *   由 `store.drops` 的移除来保证：第一个完成的把物品拿走，
 *   其余人在同一 tick 内会收到 `taken`。
 */
export const tickPickups = (
  entities: ReadonlyMap<EntityId, CombatEntity>,
  loadouts: ReadonlyMap<EntityId, Loadout>,
  store: ArsenalStore,
  pickups: PickupStore,
  now: number,
  moveEpsilon = 0.05,
): PickupTickEvent[] => {
  const events: PickupTickEvent[] = [];

  // 按结束时刻排序，保证「先完成者获得」是确定性的而不是看 Map 迭代顺序
  const pending = [...pickups.entries()].sort((a, b) => a[1].endsAt - b[1].endsAt);

  for (const [id, state] of pending) {
    const e = entities.get(id);
    if (!e) { pickups.delete(id); continue; }

    const fail = (result: PickupInterruptReason) => {
      pickups.delete(id);
      events.push({ entityId: id, dropId: state.dropId, result });
    };

    if (!e.alive) { fail('death'); continue; }
    if (e.flags.stunned) { fail('stunned'); continue; }

    // 10.5：移动会中断
    const moved = Math.hypot(
      e.position.x - state.startPosition.x,
      e.position.z - state.startPosition.z,
    );
    if (moved > moveEpsilon) { fail('moved'); continue; }

    if (now < state.endsAt) continue;

    const dropIndex = store.drops.findIndex((d) => d.id === state.dropId);
    if (dropIndex === -1) {
      // 10.5：多人同时拾取只允许第一个完成者成功；其他人收到明确失败反馈
      fail('taken');
      continue;
    }

    const drop = store.drops[dropIndex]!;
    const loadout = loadouts.get(id);
    if (!loadout) { fail('cancelled'); continue; }

    const check = checkPickup(e, loadout, drop);
    if (!check.ok) { fail('cancelled'); continue; }

    // 成功：只有这一条路径会把物品从地上移除
    store.drops.splice(dropIndex, 1);
    if (drop.kind === 'weapon' && drop.weaponId) addWeapon(loadout, drop.weaponId);
    if (drop.kind === 'armor' && drop.armorId) addArmor(loadout, drop.armorId);

    pickups.delete(id);
    events.push({ entityId: id, dropId: drop.id, result: 'completed' });
  }
  return events;
};

/** 7.3 强制位移中断拾取 */
export const onForcedMoveDuringPickup = (pickups: PickupStore, id: EntityId): boolean =>
  pickups.delete(id);

/**
 * 10.2：不匹配职业的玩家**看得到**掉落物和它的所属职业。
 * 这个函数就是「看得到」的数据面 —— 它对所有人返回同样的内容。
 */
export interface DropView {
  id: number;
  kind: DropKind;
  /** 归属职业的显示名，让玩家知道「这不是我的」*/
  ownerClassName: string;
  itemName: string;
  position: Vec3;
  /** 对**这个**观察者是否可拾取 */
  pickableByViewer: boolean;
}

export const dropViewFor = (
  drop: GroundDrop,
  viewer: CombatEntity,
  viewerLoadout: Loadout,
): DropView => {
  const cls = getClass(drop.classId);
  const item = drop.weaponId ? getWeapon(drop.weaponId) : drop.armorId ? getArmor(drop.armorId) : undefined;
  return {
    id: drop.id,
    kind: drop.kind,
    ownerClassName: cls?.name ?? String(drop.classId),
    itemName: item?.name ?? '未知物品',
    position: drop.position,
    pickableByViewer: checkPickup(viewer, viewerLoadout, drop).ok,
  };
};

/** 2.1 / 10.10 / 验收 #37：回合结束清空全部临时武装 */
export const clearArsenal = (store: ArsenalStore, pickups: PickupStore): void => {
  store.drops = [];
  for (const a of store.armories) delete a.openedBy;
  pickups.clear();
};
