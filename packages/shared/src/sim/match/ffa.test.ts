/**
 * 大乱斗记分规则（P13）。数值只有 ffa.ts 一个来源，这里钉行为不钉具体分值 ——
 * 分值调平衡不该红测试，**规则形状**（连杀递增、死亡清零、余额不透支）才是不变量。
 */

import { describe, expect, it } from 'vitest';
import { asClassId, asEntityId } from '../../types/ids.js';
import { EQUIP } from '../../constants/combat.js';
import { getClass } from '../../data/index.js';
import { TEAM_RED } from '../../types/ids.js';
import { createEntity } from '../entity.js';
import { createLoadout } from '../loadout.js';
import {
  FFA_SCORE, FFA_SHOP_PRICE, FfaOfferId,
  buyFfaOffer, createFfa, ffaShopFor, settleFfaKill, spendPoints,
} from './ffa.js';

const A = asEntityId(1);
const B = asEntityId(2);
const C = asEntityId(3);

const WARRIOR = asClassId('warrior');

/** 一个能进商店的战士 + 他的默认装备栏 */
const buyer = (id = A) => {
  const cls = getClass(WARRIOR)!;
  const entity = createEntity(id, cls, TEAM_RED, { x: 0, y: 0, z: 0 });
  return { entity, loadout: createLoadout(WARRIOR) };
};

describe('P13 大乱斗记分', () => {
  it('击杀入账；连杀逐级加成且有封顶', () => {
    const s = createFfa(100);
    const first = settleFfaKill(s, A, B)!;
    expect(first.streak).toBe(1);
    expect(first.bounty).toBe(FFA_SCORE.KILL);

    const second = settleFfaKill(s, A, C)!;
    expect(second.streak).toBe(2);
    expect(second.bounty).toBe(FFA_SCORE.KILL + FFA_SCORE.STREAK_BONUS_PER_LEVEL);

    // 推到封顶之后不再上涨
    for (let i = 0; i < 20; i++) settleFfaKill(s, A, B);
    const capped = settleFfaKill(s, A, C)!;
    expect(capped.bounty).toBe(FFA_SCORE.KILL + FFA_SCORE.STREAK_BONUS_MAX);
  });

  it('★ 死亡清零连杀 —— 「连续」的定义就是中间没死过', () => {
    const s = createFfa(100);
    settleFfaKill(s, A, B);
    settleFfaKill(s, A, C);
    expect(s.streaks.get(A)).toBe(2);
    // A 被 B 反杀 → A 连杀归零，B 起 1 连
    const revenge = settleFfaKill(s, B, A)!;
    expect(revenge.streak).toBe(1);
    expect(s.streaks.get(A)).toBe(0);
  });

  it('★ 环境死/自杀不给分（没有可播的主语；自杀给分就有刷分口子）', () => {
    const s = createFfa(100);
    expect(settleFfaKill(s, undefined, B)).toBeNull();
    expect(settleFfaKill(s, A, A)).toBeNull();
    expect(s.points.get(A) ?? 0).toBe(0);
  });

  it('★ 兑换不透支：余额不足整笔拒绝且不动账', () => {
    const s = createFfa(100);
    settleFfaKill(s, A, B);
    const balance = s.points.get(A)!;
    expect(spendPoints(s, A, balance + 1)).toBe(false);
    expect(s.points.get(A)).toBe(balance);
    expect(spendPoints(s, A, balance)).toBe(true);
    expect(s.points.get(A)).toBe(0);
    // 负数消费是账目攻击，不是折扣
    expect(spendPoints(s, A, -50)).toBe(false);
  });
});

/**
 * 积分商店（玩家原话：「积分兑换装备和其他东西」）。
 * ★ 同样钉**规则形状**不钉具体价格 —— 定价要能调，不该红测试。
 */
describe('P13 积分商店', () => {
  const give = (s: ReturnType<typeof createFfa>, id: ReturnType<typeof asEntityId>, n: number) =>
    s.points.set(id, n);

  it('货架有 3–5 件，全部有名字与正价', () => {
    const shelf = ffaShopFor(WARRIOR);
    expect(shelf.length).toBeGreaterThanOrEqual(3);
    expect(shelf.length).toBeLessThanOrEqual(5);
    for (const o of shelf) {
      expect(o.name.length).toBeGreaterThan(0);
      expect(o.cost).toBeGreaterThan(0);
    }
    // ★ 定价锚点：一件武器 = 两次击杀（FFA_SCORE.KILL × 2）
    expect(FFA_SHOP_PRICE.WEAPON).toBe(FFA_SCORE.KILL * 2);
  });

  it('★ 下发的货架不含物品 id（客户端只需要「叫什么、多少钱、哪一类」）', () => {
    for (const o of ffaShopFor(WARRIOR)) {
      expect(Object.keys(o).sort()).toEqual(['cost', 'kind', 'name', 'offerId']);
    }
  });

  it('买武器：进备用武器栏，余额按价扣', () => {
    const s = createFfa(100);
    const { entity, loadout } = buyer();
    give(s, A, 500);

    const r = buyFfaOffer(s, entity, loadout, FfaOfferId.Weapon);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // ★ 给东西只走 loadout 既有出口 —— 这里断言的就是那条出口的结果
    expect(loadout.spareWeapons).toHaveLength(1);
    expect(s.points.get(A)).toBe(500 - FFA_SHOP_PRICE.WEAPON);
    expect(r.balance).toBe(500 - FFA_SHOP_PRICE.WEAPON);
  });

  /**
   * ★★ 本组最重要的一条：**买不成一分不扣**。
   *   「扣了却什么都没拿到」比「没买成」难查一个量级 —— 后者玩家当场就说，
   *   前者他只会觉得分数莫名少了。
   */
  it('★★ 积分不足：整笔拒绝，余额与装备栏都不动', () => {
    const s = createFfa(100);
    const { entity, loadout } = buyer();
    give(s, A, FFA_SHOP_PRICE.WEAPON - 1);

    const r = buyFfaOffer(s, entity, loadout, FfaOfferId.Weapon);
    expect(r.ok).toBe(false);
    expect(s.points.get(A)).toBe(FFA_SHOP_PRICE.WEAPON - 1);
    expect(loadout.spareWeapons).toHaveLength(0);
  });

  it('★ 不存在的商品被拒，且不扣分', () => {
    const s = createFfa(100);
    const { entity, loadout } = buyer();
    give(s, A, 9999);
    expect(buyFfaOffer(s, entity, loadout, 'ffa.free_win').ok).toBe(false);
    expect(s.points.get(A)).toBe(9999);
  });

  /** ★ 先验后扣：买了也放不下的东西，不该先把钱收了 */
  it('★ 道具栏已满时拒绝补给，且一分不扣', () => {
    const s = createFfa(100);
    const { entity, loadout } = buyer();
    give(s, A, 9999);
    for (let i = 0; i < EQUIP.MAX_CONSUMABLES; i++) {
      const r = buyFfaOffer(s, entity, loadout, FfaOfferId.Consumable);
      expect(r.ok, `第 ${i + 1} 次补给`).toBe(true);
    }
    const before = s.points.get(A)!;
    expect(buyFfaOffer(s, entity, loadout, FfaOfferId.Consumable).ok).toBe(false);
    expect(s.points.get(A)).toBe(before);
    expect(loadout.consumables).toHaveLength(EQUIP.MAX_CONSUMABLES);
  });

  /**
   * ★★ 满血**不在商店里结算** —— 它只把效果清单交出去，由 tickWorld 结算。
   *   直接 `health = maxHealth` 不产生 heal 事件，治疗数字与统计会一起漏账。
   */
  it('★★ 立即满血只返回效果清单，不自己改血量', () => {
    const s = createFfa(100);
    const { entity, loadout } = buyer();
    give(s, A, 9999);
    entity.health = 1;

    const r = buyFfaOffer(s, entity, loadout, FfaOfferId.Heal);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.effects).toBeDefined();
    // 商店碰都没碰血量 —— 结算是 tickWorld 的事
    expect(entity.health).toBe(1);
  });

  it('满血时买满血被拒（不静默收钱）', () => {
    const s = createFfa(100);
    const { entity, loadout } = buyer();
    give(s, A, 9999);
    expect(buyFfaOffer(s, entity, loadout, FfaOfferId.Heal).ok).toBe(false);
    expect(s.points.get(A)).toBe(9999);
  });

  it('★ 连杀保险：下一次死亡不清连杀，且只保一次', () => {
    const s = createFfa(100);
    const { entity, loadout } = buyer();
    give(s, A, 9999);

    settleFfaKill(s, A, B);
    settleFfaKill(s, A, C);
    expect(s.streaks.get(A)).toBe(2);

    expect(buyFfaOffer(s, entity, loadout, FfaOfferId.Insurance).ok).toBe(true);
    // 第一次死：保险生效，连杀留着
    settleFfaKill(s, B, A);
    expect(s.streaks.get(A)).toBe(2);
    // 第二次死：保险已经用掉，照常清零
    settleFfaKill(s, B, A);
    expect(s.streaks.get(A)).toBe(0);
  });

  it('阵亡时不能购物', () => {
    const s = createFfa(100);
    const { entity, loadout } = buyer();
    give(s, A, 9999);
    entity.alive = false;
    expect(buyFfaOffer(s, entity, loadout, FfaOfferId.Weapon).ok).toBe(false);
    expect(s.points.get(A)).toBe(9999);
  });
});
