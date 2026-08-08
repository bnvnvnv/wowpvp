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
import { CONSUMABLES, getConsumable } from '../data/consumables.js';
import { distance2D, type Vec3 } from '../math/vec3.js';
import {
  ALL_CLASSES, getArmor, getClass, getWeapon, isPartyItemId,
  PARTY_CONSUMABLES, PARTY_WEAPONS,
} from '../data/index.js';
import { deriveRngSeed } from './world.js';
import { ArenaPreset, ArsenalChoice, GameMode } from '../types/enums.js';
import type { ArmorId, ClassId, ConsumableId, EntityId, WeaponId } from '../types/ids.js';
import type { CombatEntity } from './entity.js';
import {
  addArmor, addConsumable, addWeapon, canPickupArmor, canPickupWeapon,
  type Loadout, type PickupCheck,
} from './loadout.js';

// ── 地面掉落 ─────────────────────────────────────────────────────

export type DropKind = 'weapon' | 'armor' | 'consumable';

export interface GroundDrop {
  id: number;
  kind: DropKind;
  weaponId?: WeaponId;
  armorId?: ArmorId;
  /** 10.1 临时增益道具。★ 与武器/护甲不同，它不属于任何职业池 */
  consumableId?: ConsumableId;
  /** 10.2：物品的职业归属。不匹配的玩家看得到但拿不走 */
  /**
   * 10.2：物品的职业归属。不匹配的玩家看得到但拿不走。
   *
   * ★ **消耗品没有归属**（10.1 的临时增益人人可用），所以是可选的 ——
   *   给它借一个职业 id 会让它在 `dropViewFor()` 里显示成某个职业的东西，
   *   也会让「按 classId 找我的那件」误命中。
   */
  classId?: ClassId;
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
  /**
   * 打开者已经选完三选一。
   *
   * ★ 与 `openedBy` 分开而不是「选完就清 openedBy」：后者会让箱子回到
   *   「没人开过」的状态，于是第二个人可以再开一次同一个箱子 ——
   *   10.4 的军械点是**争夺**目标，先到者独占这一轮。
   */
  claimed?: boolean;
  /**
   * 已经刷过货的那一轮的 `availableAt`。用来保证「一轮只刷一次」。
   *
   * ★ 存的是**轮次的时刻**而不是布尔值：布尔值在「刷新 → 被开 → 再刷新」
   *   之间要人工复位，漏一次就永远不再刷货；存时刻则是自然幂等的
   *   （`lastCycleAt < availableAt` 就是「新的一轮还没刷」）。
   */
  lastCycleAt?: number;
}

/**
 * 大乱斗（FFA）的派对掉落状态。★ 竞技场与夺旗都是 `undefined`。
 *
 * ★★ 只存三个数字，**不存计划表** —— 整张时刻表是
 *   `partyDropPlan(seed, index)` 的纯函数产物，服务器重启、回放、
 *   配平复现都能算出一模一样的一局。存一份数组反而要考虑序列化与漂移。
 */
export interface PartyDropState {
  /** 掷点种子。约定用 `world.seed`，于是「一个种子决定整局」这条不变量不破 */
  seed: number;
  /** 下一件要刷的序号（0 起）。★ 场满跳过时也会 +1 —— 见 `tickPartyDrops` */
  nextIndex: number;
  /** 掉落散布的半径，米。由地图 bounds 推导 */
  radius: number;
  /** 第一件掉落的时刻（绝对秒）*/
  firstAt: number;
}

export interface ArsenalStore {
  drops: GroundDrop[];
  armories: Armory[];
  nextId: number;
  /** 10.1：经典竞技场不生成任何临时武装（验收 #28）*/
  enabled: boolean;
  /** 大乱斗派对掉落。★ 由 `setupPartyDrops()` 装上，其余模式恒为 undefined */
  party?: PartyDropState;
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
      /**
       * 12.x：夺旗模式首版关闭临时装备。
       * ★ 大乱斗（FFA）也走这里 —— 它**没有军械点**。理由不是「还没做」，
       *   而是 10.4 的军械点是一个**争夺目标**：固定位置、固定倒计时、
       *   先到者独占一轮，这套结构服务的是两队对称对抗。混战里
       *   「一个固定点每 60 秒发一件」等于「全场围着一个点打」——
       *   派对模式要的是**遍地都有东西捡**，所以它走另一条通道：
       *   `partyDropPlan()` 的随机点位刷新。
       */
      return [];
  }
};

// ── 大乱斗（FFA）派对掉落调度 ────────────────────────────────────

/**
 * 派对掉落的全部可调参数。★ 占位值，实测后再调（与数据层同一条纪律）。
 */
export const PARTY_DROP = {
  /** 开局多久后掉第一件 */
  FIRST_AT: 20,
  /** 间隔区间，秒。每一轮在 [MIN, MAX] 里掷一次 —— 玩家背不出下一件在哪一秒 */
  MIN_INTERVAL: 30,
  MAX_INTERVAL: 45,
  /**
   * 场上**同时**存在的派对掉落上限。
   * ★ 满了就跳过这一轮而不是排队补刷：不清的话一局 15 分钟能堆出三十件，
   *   地面变成自助餐，「抢到大锤」就不再是一件事了。
   */
  MAX_ALIVE: 6,
  /**
   * 掷出**夸张武装**的概率，其余全是消耗品。
   * ★ 0.25 = 平均四件里有一件是武器。武器是「全场焦点」，出现频率必须低于
   *   道具，否则场上同时四把大锤，谁都不是焦点。
   */
  WEAPON_CHANCE: 0.25,
  /** 掉落点距场地中心的最小半径 —— 别老是刷在正中央那团人脚下 */
  MIN_RADIUS: 5,
} as const;

/** 一件计划中的派对掉落。★ 纯函数产物，同一个 (seed, index) 恒等 */
export interface PartyDropPlan {
  index: number;
  /** 计划刷新的绝对时刻 */
  at: number;
  kind: 'weapon' | 'consumable';
  itemId: string;
  position: Vec3;
}

/**
 * 把 `deriveRngSeed` 的 32 位哈希折成 [0,1)。
 *
 * ★ 复用世界的那个哈希而不是另写一个：它已经是纯函数、已经有测试，
 *   而「再写一个随机数生成器」是本仓库最不需要的东西。
 * ★ `salt` 让同一轮里的四次掷点（间隔/类型/选货/角度）互不相关。
 */
const roll01 = (seed: number, index: number, salt: number): number =>
  deriveRngSeed(seed ^ (salt * 0x9e37), index + 1) / 4294967296;

/**
 * 第 `index` 件派对掉落的完整计划。**纯函数**。
 *
 * ★★ `at` 要把前面每一轮的间隔累加起来，所以这里是个 O(index) 的循环 ——
 *   一局 20 分钟大约 30 轮，代价可以忽略；换来的是「时刻表不需要被存下来」
 *   （见 `PartyDropState` 的注释）。
 */
export const partyDropPlan = (
  seed: number,
  index: number,
  radius: number,
  firstAt: number = PARTY_DROP.FIRST_AT,
): PartyDropPlan => {
  const span = PARTY_DROP.MAX_INTERVAL - PARTY_DROP.MIN_INTERVAL;
  let at = firstAt;
  for (let i = 0; i < index; i++) {
    at += PARTY_DROP.MIN_INTERVAL + roll01(seed, i, 1) * span;
  }

  const isWeapon = roll01(seed, index, 2) < PARTY_DROP.WEAPON_CHANCE;
  const pool: readonly { id: unknown }[] = isWeapon ? PARTY_WEAPONS : PARTY_CONSUMABLES;
  const pick = Math.min(pool.length - 1, Math.floor(roll01(seed, index, 3) * pool.length));

  // 均匀撒在圆环里：sqrt 让面积均匀，否则会全挤在圆心附近
  const angle = roll01(seed, index, 4) * Math.PI * 2;
  const r = PARTY_DROP.MIN_RADIUS
    + Math.sqrt(roll01(seed, index, 5)) * Math.max(0, radius - PARTY_DROP.MIN_RADIUS);

  return {
    index,
    at,
    kind: isWeapon ? 'weapon' : 'consumable',
    itemId: String(pool[pick]?.id ?? ''),
    position: { x: Math.cos(angle) * r, y: 0, z: Math.sin(angle) * r },
  };
};

/**
 * 打开大乱斗的派对掉落。由 `match/setup.ts` 的 FFA 分支调用。
 *
 * ★ 它**顺手把 `enabled` 打开**：`createArsenalStore()` 只认竞技场预设
 *   （经典 = 关、武装 = 开），而大乱斗的临时武装是模式自带的玩法，
 *   不该要求房主再去勾一个「武装」开关。
 */
export const setupPartyDrops = (
  store: ArsenalStore,
  opts: { seed: number; radius: number; firstAt?: number },
): void => {
  store.enabled = true;
  store.party = {
    seed: opts.seed >>> 0,
    nextIndex: 0,
    radius: Math.max(PARTY_DROP.MIN_RADIUS + 1, opts.radius),
    firstAt: opts.firstAt ?? PARTY_DROP.FIRST_AT,
  };
};

/** 场上现存的派对掉落（用于 `MAX_ALIVE` 与 HUD 提示）*/
export const partyDropsOnGround = (store: ArsenalStore): GroundDrop[] =>
  store.drops.filter((d) =>
    isPartyItemId(String(d.weaponId ?? d.consumableId ?? '')),
  );

/**
 * 推进派对掉落一个 tick。由 `tickWorld` 第 8b 步调用。
 *
 * ★ 「场满」时**跳过这一轮**（`nextIndex` 照样 +1），而不是把它推迟：
 *   推迟会让时刻表整体漂移，于是「距离下一件还有多久」这个 HUD 提示
 *   在场满时会一直显示 0；跳过则语义清晰 —— 那一轮的货没人要，作废。
 * ★ while 循环而不是 if：服务器卡顿或测试大步跳时间时，一次要补上好几轮。
 *   上限 `MAX_ALIVE` 天然把循环次数关死，不会跑飞。
 */
export const tickPartyDrops = (store: ArsenalStore, now: number): GroundDrop[] => {
  const party = store.party;
  if (!store.enabled || !party) return [];

  const spawned: GroundDrop[] = [];
  let alive = partyDropsOnGround(store).length;

  for (;;) {
    const plan = partyDropPlan(party.seed, party.nextIndex, party.radius, party.firstAt);
    if (plan.at > now) break;
    party.nextIndex++;

    if (alive >= PARTY_DROP.MAX_ALIVE) continue;
    if (plan.itemId === '') continue;

    const drop: GroundDrop = {
      id: store.nextId++,
      kind: plan.kind,
      ...(plan.kind === 'weapon'
        ? { weaponId: plan.itemId as GroundDrop['weaponId'] }
        : { consumableId: plan.itemId as GroundDrop['consumableId'] }),
      /**
       * ★ **刻意不写 `classId`** —— 派对武装不属于任何职业池，
       *   借一个职业 id 会让 `dropViewFor()` 把它显示成某个职业的东西
       *   （与消耗品无归属同一条理由，见 `GroundDrop.classId` 的注释）。
       */
      position: { ...plan.position },
      spawnedAt: now,
    };
    store.drops.push(drop);
    spawned.push(drop);
    alive++;
  }
  return spawned;
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

  /**
   * 10.1：临时增益道具**不属于任何职业池**，所以在按职业生成之外单独刷一件。
   *
   * ★ 10.4 那条「只从当前房间实际存在的职业池生成」是为了「避免刷出无人可用
   *   的装备」—— 消耗品人人可用，所以它不受那条约束，也**不该**被写进职业循环里。
   *
   * ⚠️ 在此之前 `DropKind` 里的 `'consumable'` 是个**从没被产生过**的枚举值：
   *    使用路径通了，场上却捡不到任何消耗品。
   */
  const consumable = CONSUMABLES[store.nextId % CONSUMABLES.length];
  if (consumable) {
    const drop: GroundDrop = {
      id: store.nextId++,
      kind: 'consumable',
      consumableId: consumable.id,
      position: { ...position },
      spawnedAt: now,
    };
    store.drops.push(drop);
    spawned.push(drop);
  }

  return spawned;
};

// ── 10.4 军械箱的开箱与领取 ──────────────────────────────────────

/**
 * 掉落物围绕军械点摆开的半径，米。
 *
 * ★ 必须明显小于 `RANGE.INTERACT`（2.2 米），否则站在箱子上够不到自己脚边的货。
 */
export const ARMORY_DROP_RING_RADIUS = 1.4;

export type ArmoryOpenResult =
  | { ok: true; armoryId: number; options: readonly ArsenalOption[] }
  | { ok: false; reason: string };

/**
 * 10.4：打开一个中立军械箱。
 *
 * ★★ **它只产出「给这个人看的三个选项」，不产出装备。**
 *   领取是 `chooseFromArmory()` 的事 —— 拆成两步是因为 10.4 的原文是
 *   「被打开后，**只向打开者显示**其职业的三个横向选择」：显示与领取之间
 *   隔着一次玩家决策，合成一步就没有「横向取舍」这个玩法了。
 *
 * ★ 打开即独占这一轮：`openedBy` 一旦有值，第二个人开同一个箱子会被拒 ——
 *   10.4 的军械点是**争夺**目标，先到者得。
 *
 * ★ 打开的同时就把 `availableAt` 推到下一轮（10.4「固定、可预测的倒计时」），
 *   所以「开了但没选」不会把箱子永久占住：下一轮由 `tickArsenal()` 复位。
 */
export const openArmory = (
  entity: CombatEntity,
  store: ArsenalStore,
  armoryId: number,
  now: number,
): ArmoryOpenResult => {
  // 验收 #28：经典竞技场不生成任何临时武装 —— 连开箱路径都不该存在
  if (!store.enabled) return { ok: false, reason: '本模式没有临时武装' };

  const armory = store.armories.find((a) => a.id === armoryId);
  if (!armory) return { ok: false, reason: '军械箱不存在' };

  if (!entity.alive) return { ok: false, reason: '已死亡' };
  if (entity.flags.stunned) return { ok: false, reason: '无法行动' };
  // 10.2：宠物、召唤物和幻象不能拾取、占用或阻挡道具
  if (entity.isPet) return { ok: false, reason: '宠物不能使用军械箱' };

  if (armory.availableAt > now) return { ok: false, reason: '军械箱尚未刷新' };
  if (armory.openedBy !== undefined) return { ok: false, reason: '已经被打开了' };

  // 10.5 的 2.2 米交互距离，与地面拾取同一个常量
  if (distance2D(entity.position, armory.position) > RANGE.INTERACT) {
    return { ok: false, reason: '距离太远' };
  }

  armory.openedBy = entity.id;
  armory.availableAt = now + armory.respawnInterval;

  return { ok: true, armoryId: armory.id, options: armoryOptionsFor(entity.classId) };
};

export type ArmoryClaimResult =
  | { ok: true; option: ArsenalOption }
  | { ok: false; reason: string };

/**
 * 10.4：从自己打开的军械箱里领走三选一中的一个。
 *
 * ★ **只有打开者能领**（`openedBy === entity.id`）—— 否则「先到者得」形同虚设。
 * ★ 槽位满时**拒绝并给出理由**，不静默丢弃：10.5 要求「装备栏已满时先弹出对比，
 *   玩家选择替换对象或取消」。首版只做到「明确告诉他满了」，
 *   「选择替换对象」的对比 UI 未做（见 PROGRESS 的已知不足）。
 * ★ 刻意**不再校验距离**：箱子已经被他打开、这一轮已经归他，
 *   走开两步再决定不该被判失败 —— 10.4 只把「打开」写成了争夺动作。
 */
export const chooseFromArmory = (
  entity: CombatEntity,
  loadout: Loadout,
  store: ArsenalStore,
  armoryId: number,
  choice: ArsenalChoice,
): ArmoryClaimResult => {
  const armory = store.armories.find((a) => a.id === armoryId);
  if (!armory) return { ok: false, reason: '军械箱不存在' };
  if (armory.openedBy !== entity.id) return { ok: false, reason: '这不是你打开的军械箱' };
  if (armory.claimed) return { ok: false, reason: '这一轮已经领过了' };
  if (!entity.alive) return { ok: false, reason: '已死亡' };

  const option = armoryOptionsFor(entity.classId).find((o) => o.choice === choice);
  if (!option) return { ok: false, reason: '选项不存在' };

  // 10.6 槽位上限：先验后改，避免「扣了这一轮却什么都没拿到」
  if (option.weaponId !== undefined) {
    const check = canPickupWeapon(entity, loadout, option.weaponId);
    if (!check.ok) return { ok: false, reason: check.hint };
  }
  if (option.armorId !== undefined) {
    const check = canPickupArmor(entity, loadout, option.armorId);
    if (!check.ok) return { ok: false, reason: check.hint };
  }

  armory.claimed = true;
  if (option.weaponId !== undefined) addWeapon(loadout, option.weaponId);
  if (option.armorId !== undefined) addArmor(loadout, option.armorId);

  return { ok: true, option };
};

/**
 * 让一个军械点开始新的一轮：复位开箱状态 + 刷出这一轮的实体掉落。
 *
 * ★ 掉落沿一个确定性的圆环摆开，不叠在同一个点上 ——
 *   `spawnDropsFromRoster()` 把所有掉落都放在同一个坐标（它只收一个 position），
 *   直接用会让 7 件东西重合成一件，玩家没法选择捡哪个。
 *   角度按**下标**算而不是随机：回放与配平复现要求确定性。
 */
export const spawnArmoryCycle = (
  store: ArsenalStore,
  rosterClassIds: readonly ClassId[],
  armory: Armory,
  now: number,
): GroundDrop[] => {
  const spawned = spawnDropsFromRoster(store, rosterClassIds, armory.position, now);
  const count = Math.max(1, spawned.length);
  spawned.forEach((drop, i) => {
    const angle = (i / count) * Math.PI * 2;
    drop.position = {
      x: armory.position.x + Math.cos(angle) * ARMORY_DROP_RING_RADIUS,
      y: armory.position.y,
      z: armory.position.z + Math.sin(angle) * ARMORY_DROP_RING_RADIUS,
    };
  });
  return spawned;
};

/**
 * 推进军械点。**每一轮只刷一次货。**
 *
 * ★★ 在此之前，`setupArmories()` / `spawnDropsFromRoster()` 在真实对局里
 *   **一次都没有被调用过** —— 军械箱的规则、三选一、拾取全都写好了并有单测，
 *   但服务器从不建军械点、也从不刷货，于是整个 M6 在联网局里是空的。
 *   这是本仓库「规则写对了、没有人调用它」家族的又一员。
 *
 * ★ 新一轮会**清掉这个点上一轮没被捡走的货**（按 `ARMORY_DROP_RING_RADIUS`
 *   的邻域判定）。依据是 10.4 的「固定、可预测的**补给点**」——
 *   补给点刷新读作「这一轮的补给替换上一轮的」，而不是层层堆积：
 *   5v5 有 5 个点、60 秒一轮，不清的话一局下来地上会有两百多件东西。
 *   ⚠️ 规格书没有明说这一条，登记为 docs/10 待确认问题 Q15。
 */
export const tickArsenal = (
  store: ArsenalStore,
  rosterClassIds: readonly ClassId[],
  now: number,
): GroundDrop[] => {
  if (!store.enabled) return [];

  const spawned: GroundDrop[] = [];
  for (const armory of store.armories) {
    if (armory.availableAt > now) continue;
    // 这一轮已经刷过了（`lastCycleAt` 存的是轮次时刻，见类型注释）
    if (armory.lastCycleAt !== undefined && armory.lastCycleAt >= armory.availableAt) continue;

    armory.lastCycleAt = armory.availableAt;
    delete armory.openedBy;
    delete armory.claimed;

    // 上一轮的残货先清掉（见函数注释）。★ 只清这个点周围的，别的点不受影响
    const clearRadius = ARMORY_DROP_RING_RADIUS * 1.5;
    store.drops = store.drops.filter(
      (d) => distance2D(d.position, armory.position) > clearRadius,
    );

    spawned.push(...spawnArmoryCycle(store, rosterClassIds, armory, now));
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
  /**
   * 10.1 / 10.6：消耗品**人人可用**，只受携带上限限制。
   * ★ 刻意不做职业匹配 —— 10.2 的职业归属规则是给武器/护甲的。
   */
  if (drop.kind === 'consumable') {
    return loadout.consumables.length >= EQUIP.MAX_CONSUMABLES
      ? { ok: false, reason: 'slotsFull' as const, hint: '增益道具已满（最多 2 个）' }
      : { ok: true };
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
    if (drop.kind === 'consumable' && drop.consumableId) {
      addConsumable(loadout, drop.consumableId);
    }

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
  const cls = drop.classId === undefined ? undefined : getClass(drop.classId);
  /**
   * ★ 消耗品此前恒显示「未知物品」—— 这一行只查了武器和护甲，而
   *   `GroundDrop.consumableId` 从 M11 起就有了。大乱斗满地都是消耗品，
   *   不补上的话玩家看到的是一地「未知物品」。
   */
  const item = drop.weaponId
    ? getWeapon(drop.weaponId)
    : drop.armorId
      ? getArmor(drop.armorId)
      : drop.consumableId
        ? getConsumable(drop.consumableId as string)
        : undefined;
  /**
   * ★ 派对武装带着伪职业 id `ffa`（`getClass` 查不到它），所以要显式说
   *   「人人可捡」而不是把 `ffa` 这个内部 id 打到玩家脸上。
   */
  const partyItem = isPartyItemId(String(drop.weaponId ?? drop.consumableId ?? ''));
  return {
    id: drop.id,
    kind: drop.kind,
    // ★ 无归属（消耗品）时显示「通用」，而不是把 undefined 打出去
    ownerClassName: partyItem
      ? '人人可捡'
      : cls?.name ?? (drop.classId === undefined ? '通用' : String(drop.classId)),
    itemName: item?.name ?? '未知物品',
    position: drop.position,
    pickableByViewer: checkPickup(viewer, viewerLoadout, drop).ok,
  };
};

/** 2.1 / 10.10 / 验收 #37：回合结束清空全部临时武装 */
export const clearArsenal = (store: ArsenalStore, pickups: PickupStore): void => {
  store.drops = [];
  for (const a of store.armories) {
    delete a.openedBy;
    // ★ `claimed` 必须一起清 —— 只清 openedBy 会让「上一回合领过」永久留下，
    //   而 10.10 要的是「下一回合恢复默认装备」，军械点也该回到未被领取的状态
    delete a.claimed;
  }
  pickups.clear();
};
