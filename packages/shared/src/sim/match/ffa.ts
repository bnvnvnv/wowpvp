/**
 * 大乱斗规则（P13，玩家需求：击杀/连杀广播、积分累积、积分兑换）。
 *
 * ★ 与 arena/flag 同级的模式规则模块：状态怎么变全在这里，MatchLoop 只负责
 *   「调用 + 把返回的事实翻成协议消息」—— 积分数值想调只有这一个文件。
 *
 * 积分是**货币**不是胜负：胜负仍是先到 killTarget 杀（MatchLoop.checkEnd）。
 * 兑换（`buyFfaOffer`）的扣账出口只有 `spendPoints` 一个 —— 这里不认识协议。
 */

import { EQUIP } from '../../constants/combat.js';
import { CONSUMABLES } from '../../data/consumables.js';
import { getArmor, getWeapon } from '../../data/index.js';
import type { EffectDef } from '../../data/schema.js';
import { ArsenalChoice } from '../../types/enums.js';
import type { ArmorId, ClassId, ConsumableId, EntityId, WeaponId } from '../../types/ids.js';
import { armoryOptionsFor } from '../arsenal.js';
import type { CombatEntity } from '../entity.js';
import {
  addArmor, addConsumable, addWeapon, canPickupArmor, canPickupWeapon, type Loadout,
} from '../loadout.js';

export interface FfaState {
  /** 先到这么多杀获胜（FFA.KILL_TARGET） */
  killTarget: number;
  /** 积分余额（击杀所得，兑换扣减） */
  points: Map<EntityId, number>;
  /** 当前连杀数。死亡清零 —— 「连续」的定义就是中间没死过 */
  streaks: Map<EntityId, number>;
  /**
   * 买了「连杀保险」的人（商店 offer 之一）。下一次死亡**不清**连杀，
   * 保险随之一次性消耗。
   *
   * ★ 存 Set 而不是在 streaks 里加个标记：保险是一次性道具，
   *   「用掉」的表达是从集合里删掉自己 —— 忘了删就等于永久保险，
   *   而那是账目错误里最难发现的一种（表现只是「他好像一直不掉连杀」）。
   */
  streakInsured: Set<EntityId>;
}

export const createFfa = (killTarget: number): FfaState => ({
  killTarget,
  points: new Map(),
  streaks: new Map(),
  streakInsured: new Set(),
});

/**
 * 积分规则。⚠️ 占位值（P13 首版）：击杀 100 起步，连杀每级 +25 封顶 +150 ——
 * 五连之后每杀 250。兑换定价（商店侧）应以「两杀换一件趁手武器」为锚。
 */
export const FFA_SCORE = {
  KILL: 100,
  STREAK_BONUS_PER_LEVEL: 25,
  STREAK_BONUS_MAX: 150,
} as const;

export interface FfaKillFact {
  /** 击杀者杀后的连杀数（含本次） */
  streak: number;
  /** 本次入账积分（含连杀加成） */
  bounty: number;
  /** 击杀者的积分余额（入账后） */
  killerScore: number;
  /** 击杀者的总击杀数由 stats 记（16.1），这里不重复记账 */
}

/**
 * 结算一次击杀。
 *
 * ★ 无击杀者（决胜压迫/坠落这类环境死）只清受害者连杀，返回 null ——
 *   调用方据此决定发不发广播（没有击杀者的击杀播报不出主语）。
 * ★ 自杀（killer === victim）同样只清连杀不给分 —— 给分就有「刷自己」的口子。
 */
export const settleFfaKill = (
  state: FfaState,
  killerId: EntityId | undefined,
  victimId: EntityId,
): FfaKillFact | null => {
  /**
   * ★ 「连杀保险」在这里兑现，也在这里被消耗（`delete` 的返回值就是判据）——
   *   保险是**死亡时**才有意义的东西，写在死亡清零的那一行上是它唯一的位置。
   *   没买保险的人走的仍是原来那一行，一个字节的行为差异都没有。
   */
  if (!state.streakInsured.delete(victimId)) state.streaks.set(victimId, 0);
  if (killerId === undefined || killerId === victimId) return null;

  const streak = (state.streaks.get(killerId) ?? 0) + 1;
  state.streaks.set(killerId, streak);

  const bonus = Math.min(
    FFA_SCORE.STREAK_BONUS_PER_LEVEL * (streak - 1),
    FFA_SCORE.STREAK_BONUS_MAX,
  );
  const bounty = FFA_SCORE.KILL + bonus;
  const killerScore = (state.points.get(killerId) ?? 0) + bounty;
  state.points.set(killerId, killerScore);

  return { streak, bounty, killerScore };
};

/**
 * 兑换扣分（P13 商店的唯一扣账出口）。余额不足返回 false 且**不动余额** ——
 * 部分扣减会让「差 10 分买到了」和「白扣了没拿到」两种账目错误都写得出来。
 */
export const spendPoints = (state: FfaState, id: EntityId, cost: number): boolean => {
  const balance = state.points.get(id) ?? 0;
  if (cost < 0 || balance < cost) return false;
  state.points.set(id, balance - cost);
  return true;
};

// ════════════════════════════════════════════════════════════════
//  积分商店（P13，玩家原话：「积分兑换装备和其他东西」）
// ════════════════════════════════════════════════════════════════

/**
 * 一个商品能给出什么。★ 闭集 —— 加一类商品要在 `grant()` 的 switch 里表态，
 * 忘了表态是编译错误而不是「买了没反应」。
 */
export type FfaOfferKind = 'weapon' | 'armor' | 'consumable' | 'heal' | 'insurance';

/**
 * 商品的**对外形状**（进 `FfaShop` 协议消息）。
 *
 * ★ 刻意不含物品 id：客户端只需要「叫什么、多少钱、是哪一类」就能画面板，
 *   而兑现是服务器照 `offerId` 自己查表的事（客户端只发意图）。
 */
export interface FfaOffer {
  offerId: string;
  name: string;
  cost: number;
  kind: FfaOfferKind;
}

/** 内部条目：对外形状 + 兑现所需的东西 */
interface FfaOfferEntry extends FfaOffer {
  weaponId?: WeaponId;
  armorId?: ArmorId;
  consumableId?: ConsumableId;
  /** 即时效果（「立即满血」）。★ 由调用方排进 tickWorld 结算，见下面 ★★ */
  effects?: readonly EffectDef[];
}

/**
 * 定价。⚠️ 与 `FFA_SCORE` 同为占位值，锚点只有一条：
 * **两杀 ≈ 一件趁手武器**（`FFA_SCORE.KILL` × 2 = 200）。其余按「它比一把
 * 武器值多少」横向排：护甲 0.75 把、满血 0.6 把、补给 0.4 把、
 * 连杀保险 1.25 把（它保的是一条已经滚起来的雪球，最贵）。
 */
export const FFA_SHOP_PRICE = {
  WEAPON: 200,
  ARMOR: 150,
  CONSUMABLE: 80,
  HEAL: 120,
  INSURANCE: 250,
} as const;

/** 商品 id。★ 常量而不是字面量：服务器查表与测试断言用同一个来源 */
export const FfaOfferId = {
  Weapon: 'ffa.weapon',
  Armor: 'ffa.armor',
  Consumable: 'ffa.consumable',
  Heal: 'ffa.heal',
  Insurance: 'ffa.insurance',
} as const;

/**
 * 「立即满血」的效果。
 *
 * ★★ **它是一份效果清单，不是一次 `health = maxHealth` 赋值。**
 *   效果结算只有 `tickWorld` 一个出口（技术债总账 A1/A2）——
 *   直改字段不产生 `heal` 事件，于是治疗数字不广播、16.1 的治疗统计漏账，
 *   而这两样都不会报错。所以这里只**描述**要结算什么，
 *   由 `MatchLoop` 排进下一 tick 的 `itemGrants`。
 */
const FULL_HEAL_EFFECTS: readonly EffectDef[] = [
  { kind: 'healPercentMaxHealth', percent: 1 },
];

/** 商店卖的那件消耗品。★ 固定一件而不是随机 —— 商店要能被记住 */
const SHOP_CONSUMABLE = CONSUMABLES[0];

/**
 * 这个职业的货架。
 *
 * ★ 武器/护甲**复用 `armoryOptionsFor()`** —— 军械箱三选一挑的就是
 *   「这个职业最趁手的那把」与「守护套」，商店没有理由另立一张表：
 *   两张表会漂移，而漂移的表现是「箱子里开出来的和商店卖的不是一个东西」。
 * ★ 查不到东西的类别**整条不上架**，不上架一件叫「未知物品」的空货 ——
 *   买到空气是账目错误里最伤人的一种。
 */
const shelfFor = (classId: ClassId): FfaOfferEntry[] => {
  const options = armoryOptionsFor(classId);
  const weaponId = options.find((o) => o.choice === ArsenalChoice.Offense)?.weaponId;
  const armorId = options.find((o) => o.choice === ArsenalChoice.Defense)?.armorId;

  const shelf: FfaOfferEntry[] = [];
  const weapon = weaponId === undefined ? undefined : getWeapon(weaponId);
  if (weaponId !== undefined && weapon) {
    shelf.push({
      offerId: FfaOfferId.Weapon, kind: 'weapon',
      name: `强力武器 · ${weapon.name}`, cost: FFA_SHOP_PRICE.WEAPON, weaponId,
    });
  }
  const armor = armorId === undefined ? undefined : getArmor(armorId);
  if (armorId !== undefined && armor) {
    shelf.push({
      offerId: FfaOfferId.Armor, kind: 'armor',
      name: `护甲 · ${armor.name}`, cost: FFA_SHOP_PRICE.ARMOR, armorId,
    });
  }
  if (SHOP_CONSUMABLE) {
    shelf.push({
      offerId: FfaOfferId.Consumable, kind: 'consumable',
      name: `补给 · ${SHOP_CONSUMABLE.name}`, cost: FFA_SHOP_PRICE.CONSUMABLE,
      consumableId: SHOP_CONSUMABLE.id,
    });
  }
  shelf.push({
    offerId: FfaOfferId.Heal, kind: 'heal',
    name: '立即满血', cost: FFA_SHOP_PRICE.HEAL, effects: FULL_HEAL_EFFECTS,
  });
  shelf.push({
    offerId: FfaOfferId.Insurance, kind: 'insurance',
    name: '连杀保险（下次死亡不断连杀）', cost: FFA_SHOP_PRICE.INSURANCE,
  });
  return shelf;
};

/**
 * 下发给某个职业的货架（`FfaShop` 消息用）。
 * ★ 与军械箱的三选一同理由：只给**这个人**看得懂的东西 ——
 *   卖给战士一把法杖既没用，也让面板变成一张全职业目录。
 */
export const ffaShopFor = (classId: ClassId): FfaOffer[] =>
  shelfFor(classId).map(({ offerId, name, cost, kind }) => ({ offerId, name, cost, kind }));

export type FfaBuyResult =
  | {
      ok: true;
      offer: FfaOffer;
      /** 扣账后的余额。调用方据此重发 `FfaShop` */
      balance: number;
      /** 需要由 `tickWorld` 结算的即时效果（只有「立即满血」有）*/
      effects?: readonly EffectDef[];
    }
  | { ok: false; reason: string };

/**
 * 兑换一件商品。
 *
 * ★★ **先验后扣，验不过一分不扣。** 与 `chooseFromArmory()` 同一条纪律：
 *   「扣了这一轮却什么都没拿到」比「没买成」难查一个量级 ——
 *   后者玩家当场就会说，前者他只会觉得分数莫名少了。
 *
 * ★ 给东西只走 `addWeapon` / `addArmor` / `addConsumable`（loadout 的既有出口），
 *   扣分只走 `spendPoints` —— 本函数里没有第二处改余额或改装备栏的语句。
 * ★ 满血**不在这里结算**，只把效果清单交出去（见 `FULL_HEAL_EFFECTS` 的 ★★）。
 */
export const buyFfaOffer = (
  state: FfaState,
  entity: CombatEntity,
  loadout: Loadout,
  offerId: string,
): FfaBuyResult => {
  const entry = shelfFor(entity.classId).find((o) => o.offerId === offerId);
  if (!entry) return { ok: false, reason: '没有这件商品' };
  // 10.2：宠物、召唤物不参与物品经济
  if (entity.isPet) return { ok: false, reason: '宠物不能购物' };
  if (!entity.alive) return { ok: false, reason: '阵亡时不能购买' };

  // ── 先验（每一类各自的「买了也用不上」）──────────────────
  switch (entry.kind) {
    case 'weapon': {
      const check = canPickupWeapon(entity, loadout, entry.weaponId!);
      if (!check.ok) return { ok: false, reason: check.hint };
      break;
    }
    case 'armor': {
      const check = canPickupArmor(entity, loadout, entry.armorId!);
      if (!check.ok) return { ok: false, reason: check.hint };
      break;
    }
    case 'consumable':
      if (loadout.consumables.length >= EQUIP.MAX_CONSUMABLES) {
        return { ok: false, reason: `增益道具已满（最多 ${EQUIP.MAX_CONSUMABLES} 个）` };
      }
      break;
    case 'heal':
      // ★ 满血还买满血 = 白扣分。诚实拒绝，不静默收钱
      if (entity.health >= entity.maxHealth) return { ok: false, reason: '生命值已满' };
      break;
    case 'insurance':
      if (state.streakInsured.has(entity.id)) return { ok: false, reason: '已经买过保险了' };
      break;
  }

  // ── 扣账（唯一出口）────────────────────────────────────────
  if (!spendPoints(state, entity.id, entry.cost)) {
    return { ok: false, reason: `积分不足（需要 ${entry.cost}）` };
  }

  // ── 兑现 ──────────────────────────────────────────────────
  switch (entry.kind) {
    case 'weapon': addWeapon(loadout, entry.weaponId!); break;
    case 'armor': addArmor(loadout, entry.armorId!); break;
    case 'consumable': addConsumable(loadout, entry.consumableId!); break;
    case 'insurance': state.streakInsured.add(entity.id); break;
    // 满血由调用方排进 tickWorld —— 这里只把清单带出去
    case 'heal': break;
  }

  const { offerId: id, name, cost, kind } = entry;
  return {
    ok: true,
    offer: { offerId: id, name, cost, kind },
    balance: state.points.get(entity.id) ?? 0,
    ...(entry.effects ? { effects: entry.effects } : {}),
  };
};
