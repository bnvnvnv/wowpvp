/**
 * 战场装备栏与换装。规格书 10.6 / 10.7 / 10.10，验收 #30 / #33 / #34 / #37。
 *
 * ★ **验收 #34 是全项目最容易被利用的一条**：
 *     「换装不能刷新普通攻击、取消后摇、重置技能、恢复资源或清除负面。」
 *
 *   五件事都是「不做某事」—— 破坏它们不会让任何东西报错，只会让某个玩家
 *   发现「切一下武器就能重置冷却」然后再也不用别的打法。
 *
 *   本文件的做法：`completeSwap()` 里**只有两行**赋值（weaponId / armorId），
 *   其余状态一律不碰。`loadout.test.ts` 逐项断言这五样东西在换装前后完全相等。
 *   想加一行「顺手回点资源」就会被测试拦下。
 */

import { EQUIP } from '../constants/combat.js';
import { getArmor, getClass, getWeapon } from '../data/index.js';
import type { ArmorDef, WeaponDef } from '../data/schema.js';
import type { ArmorId, ClassId, ConsumableId, EntityId, WeaponId } from '../types/ids.js';
import { skillsAvailableWith, type CombatEntity } from './entity.js';

// ── 装备栏 ───────────────────────────────────────────────────────

export interface Loadout {
  /** 10.6：始终保留 1 套不可删除的职业默认武器 */
  readonly defaultWeaponId: WeaponId;
  readonly defaultArmorId: ArmorId;
  /** 最多 2 套临时武器 */
  spareWeapons: WeaponId[];
  /** 最多 2 套临时护甲 */
  spareArmors: ArmorId[];
  /** 最多 2 个主动增益道具 */
  consumables: ConsumableId[];
}

export const createLoadout = (classId: ClassId): Loadout => {
  const cls = getClass(classId);
  if (!cls) throw new Error(`未知职业：${classId}`);
  return {
    defaultWeaponId: cls.defaultWeaponId,
    defaultArmorId: cls.defaultArmorId,
    spareWeapons: [],
    spareArmors: [],
    consumables: [],
  };
};

export type LoadoutStore = Map<EntityId, Loadout>;
export const createLoadoutStore = (): LoadoutStore => new Map();

/** 当前可切换的全部武器（默认 + 备用）。默认武器永远在列表里（10.6）*/
export const availableWeapons = (l: Loadout): WeaponId[] => [l.defaultWeaponId, ...l.spareWeapons];
export const availableArmors = (l: Loadout): ArmorId[] => [l.defaultArmorId, ...l.spareArmors];

// ── 10.2 职业锁定 ────────────────────────────────────────────────

export type PickupRejection =
  | 'classMismatch'
  | 'slotsFull'
  | 'alreadyOwned'
  | 'isPet'
  | 'unknownItem';

export type PickupCheck = { ok: true } | { ok: false; reason: PickupRejection; hint: string };

/**
 * 10.2：武器和护甲带职业归属，只能由对应职业拾取。
 *
 * ★ 不匹配时只是**拒绝**，调用方不得移除地面物品 —— 10.2 明确写了
 *   「不符合职业的玩家能看到掉落物和所属职业，但交互时提示『职业不匹配』，
 *     **物品不会消失**」（验收 #29）。
 */
export const canPickupWeapon = (
  entity: CombatEntity,
  loadout: Loadout,
  weaponId: WeaponId,
): PickupCheck => {
  // 10.2：宠物、召唤物和幻象不能拾取、占用或阻挡道具
  if (entity.isPet) return { ok: false, reason: 'isPet', hint: '宠物不能拾取物品' };

  const w = getWeapon(weaponId);
  if (!w) return { ok: false, reason: 'unknownItem', hint: '未知物品' };

  if ((w.classId as string) !== (entity.classId as string)) {
    const owner = getClass(w.classId);
    return {
      ok: false,
      reason: 'classMismatch',
      hint: `职业不匹配（属于${owner?.name ?? w.classId}）`,
    };
  }
  if (availableWeapons(loadout).includes(weaponId)) {
    return { ok: false, reason: 'alreadyOwned', hint: '已经拥有这件武器' };
  }
  if (loadout.spareWeapons.length >= EQUIP.MAX_SPARE_WEAPONS) {
    return { ok: false, reason: 'slotsFull', hint: '武器栏已满，需要选择替换对象' };
  }
  return { ok: true };
};

export const canPickupArmor = (
  entity: CombatEntity,
  loadout: Loadout,
  armorId: ArmorId,
): PickupCheck => {
  if (entity.isPet) return { ok: false, reason: 'isPet', hint: '宠物不能拾取物品' };

  const a = getArmor(armorId);
  if (!a) return { ok: false, reason: 'unknownItem', hint: '未知物品' };

  if ((a.classId as string) !== (entity.classId as string)) {
    const owner = getClass(a.classId);
    return {
      ok: false,
      reason: 'classMismatch',
      hint: `职业不匹配（属于${owner?.name ?? a.classId}）`,
    };
  }
  if (availableArmors(loadout).includes(armorId)) {
    return { ok: false, reason: 'alreadyOwned', hint: '已经拥有这套护甲' };
  }
  if (loadout.spareArmors.length >= EQUIP.MAX_SPARE_ARMORS) {
    return { ok: false, reason: 'slotsFull', hint: '护甲栏已满，需要选择替换对象' };
  }
  return { ok: true };
};

export const addWeapon = (loadout: Loadout, weaponId: WeaponId): void => {
  loadout.spareWeapons.push(weaponId);
};
export const addArmor = (loadout: Loadout, armorId: ArmorId): void => {
  loadout.spareArmors.push(armorId);
};

/**
 * 10.1 / 10.6：拾起一个消耗品。上限 `EQUIP.MAX_CONSUMABLES`（2 个）。
 *
 * ★ 满了就**拿不走**，而不是顶掉旧的 —— 与武器/护甲满槽时「弹出对比让玩家选」
 *   是同一个立场：不替玩家做丢弃决定。消耗品没有对比界面，所以直接拒绝。
 */
export const addConsumable = (loadout: Loadout, id: ConsumableId): boolean => {
  if (loadout.consumables.length >= EQUIP.MAX_CONSUMABLES) return false;
  loadout.consumables.push(id);
  return true;
};

/**
 * 取出一个待使用的消耗品（按槽位）。**只负责取出，不结算效果。**
 *
 * ★★ 效果结算必须走 `tickWorld` 那**唯一的出口**（A2 的教训）——
 *   所以这里只把 id 弹出来交给调用方，由 tick 在自己的结算步里处理。
 *   在这里直接 `resolveEffects()` 会开出第二个结算入口。
 *
 * @returns 弹出的消耗品 id；槽位为空或角色无法行动时返回 undefined
 */
export const takeConsumable = (
  entity: CombatEntity,
  loadout: Loadout,
  slot: number,
): ConsumableId | undefined => {
  if (!entity.alive) return undefined;
  // 7.3 硬控制禁止一切主动动作 —— 与换装同一条规则
  if (entity.flags.stunned) return undefined;
  const id = loadout.consumables[slot];
  if (id === undefined) return undefined;
  loadout.consumables.splice(slot, 1);
  return id;
};

/**
 * 10.5：「装备栏已满时先弹出对比，玩家选择替换对象或取消；
 *        **取消后地面装备仍在**。」
 *
 * 替换的是**备用槽**，默认装备永远不能被替换掉（10.6）。
 */
export const replaceWeapon = (
  loadout: Loadout,
  slotIndex: number,
  weaponId: WeaponId,
): boolean => {
  if (slotIndex < 0 || slotIndex >= loadout.spareWeapons.length) return false;
  loadout.spareWeapons[slotIndex] = weaponId;
  return true;
};

export const replaceArmor = (loadout: Loadout, slotIndex: number, armorId: ArmorId): boolean => {
  if (slotIndex < 0 || slotIndex >= loadout.spareArmors.length) return false;
  loadout.spareArmors[slotIndex] = armorId;
  return true;
};

// ── 10.7 换装 ────────────────────────────────────────────────────

export const SwapKind = {
  Weapon: 'weapon',
  Armor: 'armor',
} as const;
export type SwapKind = (typeof SwapKind)[keyof typeof SwapKind];

export interface SwapState {
  kind: SwapKind;
  weaponId?: WeaponId;
  armorId?: ArmorId;
  startedAt: number;
  endsAt: number;
  /** 开始时的位置，用于判断「必须原地」的护甲换装 */
  startPosition: { x: number; y: number; z: number };
  /** 10.7 切换武器可缓慢移动；切换护甲必须原地 */
  requiresStationary: boolean;
  /** 10.7 切换护甲受到伤害会中断；切换武器不会 */
  interruptedByDamage: boolean;
}

export type SwapStore = Map<EntityId, SwapState>;
export const createSwapStore = (): SwapStore => new Map();

export type SwapStart =
  | { ok: true; state: SwapState }
  | { ok: false; reason: string };

/**
 * 10.7 开始换装。
 *
 * ★ 这里**只创建换装状态**，不碰实体的任何其他字段。
 *   真正的装备变更在 `completeSwap()` 里，也只改两个字段。
 */
export const beginSwap = (
  entity: CombatEntity,
  loadout: Loadout,
  swaps: SwapStore,
  kind: SwapKind,
  itemId: WeaponId | ArmorId,
  now: number,
): SwapStart => {
  if (!entity.alive) return { ok: false, reason: '已死亡' };
  // 7.3：硬控制停止换装
  if (entity.flags.stunned) return { ok: false, reason: '无法行动' };
  if (swaps.has(entity.id)) return { ok: false, reason: '正在换装' };

  if (kind === SwapKind.Weapon) {
    const id = itemId as WeaponId;
    if (!availableWeapons(loadout).includes(id)) return { ok: false, reason: '没有这件武器' };
    if (entity.weaponId === id) return { ok: false, reason: '已经装备着它' };
  } else {
    const id = itemId as ArmorId;
    if (!availableArmors(loadout).includes(id)) return { ok: false, reason: '没有这套护甲' };
    if (entity.armorId === id) return { ok: false, reason: '已经装备着它' };
  }

  const state: SwapState = {
    kind,
    ...(kind === SwapKind.Weapon ? { weaponId: itemId as WeaponId } : { armorId: itemId as ArmorId }),
    startedAt: now,
    endsAt: now + (kind === SwapKind.Weapon ? EQUIP.SWAP_WEAPON_SECONDS : EQUIP.SWAP_ARMOR_SECONDS),
    startPosition: { ...entity.position },
    requiresStationary: kind === SwapKind.Armor,
    interruptedByDamage: kind === SwapKind.Armor,
  };
  swaps.set(entity.id, state);
  return { ok: true, state };
};

export type SwapInterruptReason = 'stunned' | 'moved' | 'damage' | 'forcedMove' | 'death' | 'cancelled';

export const cancelSwap = (swaps: SwapStore, id: EntityId): boolean => swaps.delete(id);

/**
 * ★★ 完成换装。**验收 #34 的全部实现就是这个函数的短小**。
 *
 * 它只做一件事：把 `weaponId` 或 `armorId` 换掉。
 *
 * 明确**不做**的五件事（10.7 的「禁止利用」列）：
 *   · 不碰 `nextSwingAt` —— 不刷新普通攻击
 *   · 不碰 `swingRecoveryUntil` —— 不取消攻击后摇
 *   · 不碰 `cooldowns` / `gcdUntil` / `schoolLocks` —— 不重置技能
 *   · 不碰 `resources` —— 不恢复资源
 *   · 不碰光环 —— 不清除负面、不瞬间获得满额护盾
 *
 * 如果将来有人想在这里加一行「顺手回一点资源」，`loadout.test.ts`
 * 的五条断言会立刻变红。
 */
export const completeSwap = (entity: CombatEntity, state: SwapState): void => {
  if (state.kind === SwapKind.Weapon && state.weaponId) {
    entity.weaponId = state.weaponId;
    refreshAvailableSkills(entity);
  } else if (state.kind === SwapKind.Armor && state.armorId) {
    entity.armorId = state.armorId;
  }
};

/**
 * M14：换装/复位后重算武器方案的技能集合（附录A#4，规则在
 * `skillsAvailableWith`）。武器写点一共三处 —— 换装完成、死亡收缴、
 * 回合复位 —— 都必须跟着调这里，漏一处的表现是「换回默认武器后
 * 方案专属技能还亮着」。
 */
const refreshAvailableSkills = (entity: CombatEntity): void => {
  const cls = getClass(entity.classId);
  if (cls) entity.availableSkills = skillsAvailableWith(cls, entity.weaponId);
};

export interface SwapTickEvent {
  entityId: EntityId;
  state: SwapState;
  result: 'completed' | SwapInterruptReason;
}

/**
 * 推进所有换装一个 tick。
 *
 * ⚠️ 与 casting 同理，必须在 **movement 之后**调用 ——
 * 10.7 规定护甲换装「必须原地」，只有先算完移动才知道这一 tick 有没有位移。
 */
export const tickSwaps = (
  entities: ReadonlyMap<EntityId, CombatEntity>,
  swaps: SwapStore,
  now: number,
  moveEpsilon = 0.05,
): SwapTickEvent[] => {
  const events: SwapTickEvent[] = [];

  for (const [id, state] of [...swaps.entries()]) {
    const e = entities.get(id);
    if (!e) {
      swaps.delete(id);
      continue;
    }

    const fail = (result: SwapInterruptReason) => {
      swaps.delete(id);
      events.push({ entityId: id, state, result });
    };

    if (!e.alive) { fail('death'); continue; }
    if (e.flags.stunned) { fail('stunned'); continue; }

    if (state.requiresStationary) {
      const moved = Math.hypot(
        e.position.x - state.startPosition.x,
        e.position.z - state.startPosition.z,
      );
      if (moved > moveEpsilon) { fail('moved'); continue; }
    }

    if (now >= state.endsAt) {
      swaps.delete(id);
      completeSwap(e, state);
      events.push({ entityId: id, state, result: 'completed' });
    }
  }
  return events;
};

/**
 * 10.7：切换护甲「受到伤害」会中断；切换武器不会。
 * 由伤害结算路径调用。
 */
export const onDamageDuringSwap = (swaps: SwapStore, id: EntityId): SwapInterruptReason | null => {
  const state = swaps.get(id);
  if (!state || !state.interruptedByDamage) return null;
  swaps.delete(id);
  return 'damage';
};

/** 7.3 强制位移中断换装 */
export const onForcedMoveDuringSwap = (swaps: SwapStore, id: EntityId): boolean => {
  if (!swaps.has(id)) return false;
  swaps.delete(id);
  return true;
};

// ── 10.6 / 10.10 视图与重置 ──────────────────────────────────────

export interface LoadoutView {
  currentWeapon: WeaponDef | undefined;
  currentArmor: ArmorDef | undefined;
  spareWeapons: (WeaponDef | undefined)[];
  spareArmors: (ArmorDef | undefined)[];
  /**
   * ★ **可切换的全部**装备（默认 + 备用），供 15.3 的装备栏列表使用。
   *
   * 为什么不能让 UI 自己拼 `[currentWeapon, ...spareWeapons]`：
   * 换到备用武器之后，`spareWeapons` 里**仍然**含着那件武器
   * （`availableWeapons()` 的语义是"手上加包里"，不随装备变化增删），
   * 于是列表会把当前武器显示两遍，同时默认武器凭空消失 ——
   * 而 10.6 明确要求默认装备永远在列表里。
   * 这个字段直接来自 `availableWeapons()`，两个问题一起消失。
   */
  allWeapons: (WeaponDef | undefined)[];
  allArmors: (ArmorDef | undefined)[];
  swapProgress: { kind: SwapKind; remaining: number } | null;
}

/** 自己的完整装备栏视图（10.6：显示当前、备用、优势、代价、改变的技能）*/
export const ownLoadoutView = (
  entity: CombatEntity,
  loadout: Loadout,
  swaps: SwapStore,
  now: number,
): LoadoutView => {
  const s = swaps.get(entity.id);
  return {
    currentWeapon: getWeapon(entity.weaponId),
    currentArmor: getArmor(entity.armorId),
    spareWeapons: loadout.spareWeapons.map(getWeapon),
    spareArmors: loadout.spareArmors.map(getArmor),
    allWeapons: availableWeapons(loadout).map(getWeapon),
    allArmors: availableArmors(loadout).map(getArmor),
    swapProgress: s ? { kind: s.kind, remaining: Math.max(0, s.endsAt - now) } : null,
  };
};

/**
 * ★ 10.6 / 验收 #36：「敌人可以看到角色当前手持武器、护甲类型图标和换装动作，
 *   但**不能查看其备用装备**。」
 *
 * 这个函数是那条规则在数据层的实现 —— 返回值里根本没有备用装备字段，
 * 网络层照着它序列化就不可能泄露。见 docs/08 §4.2。
 */
export interface EnemyLoadoutView {
  currentWeapon: WeaponDef | undefined;
  /** 只暴露护甲**原型**，不暴露具体是哪一套 */
  armorArchetype: ArmorDef['archetype'] | undefined;
  /** 换装动作可见，但看不出在换什么 */
  swapping: boolean;
}

export const enemyLoadoutView = (
  entity: CombatEntity,
  swaps: SwapStore,
): EnemyLoadoutView => ({
  currentWeapon: getWeapon(entity.weaponId),
  armorArchetype: getArmor(entity.armorId)?.archetype,
  swapping: swaps.has(entity.id),
});

/**
 * 10.10：「玩家死亡后临时装备随该玩家失效，不掉给敌人」——
 * 避免滚雪球。默认装备永不掉落。
 */
export const onDeath = (entity: CombatEntity, loadout: Loadout, swaps: SwapStore): void => {
  loadout.spareWeapons = [];
  loadout.spareArmors = [];
  loadout.consumables = [];
  entity.weaponId = loadout.defaultWeaponId;
  entity.armorId = loadout.defaultArmorId;
  refreshAvailableSkills(entity);
  swaps.delete(entity.id);
};

/**
 * 2.1 / 10.10 / 验收 #37：「回合结束后全部临时武器、护甲、道具和增益清除，
 * 下一回合恢复默认装备。」
 */
export const resetLoadouts = (
  entities: Iterable<CombatEntity>,
  loadouts: LoadoutStore,
  swaps: SwapStore,
): void => {
  for (const e of entities) {
    const l = loadouts.get(e.id);
    if (!l) continue;
    l.spareWeapons = [];
    l.spareArmors = [];
    l.consumables = [];
    e.weaponId = l.defaultWeaponId;
    e.armorId = l.defaultArmorId;
    refreshAvailableSkills(e);
  }
  swaps.clear();
};
