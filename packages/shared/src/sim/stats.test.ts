/**
 * 战后统计测试。对应规格书 16.1–16.4 与验收 #50。
 *
 * ★ 重点不是「计数器加对了」，而是 16.4 那条否定式规则：
 *   「不能只按总伤害或击杀数评选最佳玩家。」
 *   本文件末尾有三条测试专门守它 —— 两条守结构（composeScore 会抛异常），
 *   一条守行为（伤害最高的人拿不到最佳综合玩家）。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { getClass, mage, priest, warrior } from '../data/index.js';
import { ctfMap } from '../data/maps/ctf.js';
import { vec3 } from '../math/vec3.js';
import { DrCategory, School } from '../types/enums.js';
import { asClassId, asEntityId, asSkillId, TEAM_BLUE, TEAM_RED } from '../types/ids.js';
import { createEntity, type CombatEntity } from './entity.js';
import { createCtf, type CtfState } from './match/flag.js';
import type { CombatEvent } from './effects/registry.js';
import {
  AWARDS,
  MAX_DIMENSION_WEIGHT_SHARE,
  MIN_OVERALL_DIMENSIONS,
  SCORE_DIMENSIONS,
  STATS,
  composeScore,
  createStats,
  ingestCombatEvents,
  ingestFlagEvents,
  ingestPickupEvents,
  ingestSwapEvents,
  interruptSuccessRate,
  isKeySkill,
  pickAwards,
  recordSelfCancel,
  recordSkillUse,
  registerPlayer,
  sampleTick,
  skillHitRate,
  type PlayerStats,
  type StatsStore,
} from './stats.js';
import { addEntity, allocEntityId, createWorld, type World } from './world.js';

let world: World;
let store: StatsStore;
let att: CombatEntity;
let def: CombatEntity;
let healer: CombatEntity;

const spawn = (cls: typeof mage, team: typeof TEAM_RED, x = 0, z = 0): CombatEntity =>
  addEntity(world, createEntity(allocEntityId(world), cls, team, vec3(x, 0, z)));

beforeEach(() => {
  world = createWorld();
  store = createStats();
  att = spawn(mage, TEAM_RED, 0, 0);
  def = spawn(warrior, TEAM_BLUE, 0, 5);
  healer = spawn(priest, TEAM_RED, 1, 0);
  for (const e of [att, def, healer]) registerPlayer(store, e);
});

const statsOf = (e: CombatEntity): PlayerStats => {
  const s = store.players.get(e.id);
  if (!s) throw new Error('未登记');
  return s;
};

const damageEvent = (
  src: CombatEntity,
  dst: CombatEntity,
  amount: number,
  extra: Partial<Extract<CombatEvent, { t: 'damage' }>> = {},
): CombatEvent => ({
  t: 'damage', sourceId: src.id, targetId: dst.id, amount, school: School.Fire,
  absorbed: 0, overkill: 0, immune: false, preventedByEquipment: 0, ...extra,
});

// ════════════════════════════════════════════════════════════════

describe('16.1 通用统计', () => {
  it('伤害同时记进施加者的输出与承受者的承伤', () => {
    ingestCombatEvents(store, world, [damageEvent(att, def, 300)], 1);
    expect(statsOf(att).general.damageDone).toBe(300);
    expect(statsOf(def).general.damageTaken).toBe(300);
  });

  it('被免疫的伤害不计入任何一方', () => {
    ingestCombatEvents(store, world, [damageEvent(att, def, 0, { immune: true })], 1);
    expect(statsOf(att).general.damageDone).toBe(0);
    expect(statsOf(def).general.damageTaken).toBe(0);
  });

  /**
   * ★ 吸收记给**下盾的人**。
   *   记给被打的人会让「吸收」变成承伤的同义词，而 16.1 把它和「有效治疗」
   *   并列 —— 它是治疗者的贡献项。
   */
  it('★ 吸收记给下盾的人，不是被打的人', () => {
    ingestCombatEvents(store, world, [
      damageEvent(att, def, 100, { absorbed: 80, absorbedBy: [{ sourceId: healer.id, amount: 80 }] }),
    ], 1);
    expect(statsOf(healer).general.absorbProvided).toBe(80);
    expect(statsOf(def).general.absorbProvided).toBe(0);
  });

  /** ★ 护甲减伤记给**被打的人** —— 挡掉伤害的是他自己的装备 */
  it('★ 装备减伤记给被打的人（16.2 护甲减少伤害）', () => {
    ingestCombatEvents(store, world, [
      damageEvent(att, def, 100, { preventedByEquipment: 15 }),
    ], 1);
    expect(statsOf(def).arena.damageReducedByEquipment).toBe(15);
    expect(statsOf(att).arena.damageReducedByEquipment).toBe(0);
  });

  it('治疗记入有效治疗', () => {
    ingestCombatEvents(store, world, [
      { t: 'heal', sourceId: healer.id, targetId: att.id, amount: 250, overheal: 40 },
    ], 1);
    expect(statsOf(healer).general.healingDone).toBe(250);
  });

  /**
   * ★ 「控制时间」只认带 8.2 递减类别的效果。
   *   普通减速和持续伤害也是 debuff，混进来会让这一项失去意义 ——
   *   一个满身持续伤害的术士会显示出比控制型职业更长的「控制时间」。
   */
  it('★ 控制时间只统计带递减类别的效果，普通 debuff 不算', () => {
    ingestCombatEvents(store, world, [
      { t: 'auraApplied', sourceId: att.id, targetId: def.id, auraId: 'control.stun',
        duration: 4, auraKind: 'debuff', drCategory: DrCategory.Stun },
      { t: 'auraApplied', sourceId: att.id, targetId: def.id, auraId: 'slow',
        duration: 10, auraKind: 'debuff' },
    ], 1);
    expect(statsOf(att).general.controlSecondsApplied).toBe(4);
  });

  it('驱散计数；驱散掉的是控制时额外记一次解除控制', () => {
    ingestCombatEvents(store, world, [
      { t: 'dispelled', sourceId: healer.id, targetId: att.id, auraId: 'x', auraKind: 'debuff' },
      { t: 'dispelled', sourceId: healer.id, targetId: att.id, auraId: 'control.root',
        auraKind: 'debuff', drCategory: DrCategory.Root },
    ], 1);
    expect(statsOf(healer).general.dispels).toBe(2);
    expect(statsOf(healer).general.controlBreaks).toBe(1);
  });

  describe('打断', () => {
    /**
     * ★ 落空**也要**计入尝试次数。
     *   16.1 同时要求「打断次数」和「打断成功率」—— 只记成功的话成功率
     *   恒为 100%，那个字段就没有意义了。
     */
    it('★ 打断落空也计入尝试次数，成功率才有分母', () => {
      ingestCombatEvents(store, world, [
        { t: 'interrupt', sourceId: att.id, targetId: def.id, success: true, school: School.Fire },
        { t: 'interrupt', sourceId: att.id, targetId: def.id, success: false, reason: 'notCasting' },
      ], 1);
      const s = statsOf(att);
      expect(s.general.interruptsAttempted).toBe(2);
      expect(s.general.interruptsLanded).toBe(1);
      expect(interruptSuccessRate(s)).toBeCloseTo(0.5, 5);
      expect(statsOf(def).general.timesInterrupted).toBe(1);
    });

    it('没打断过时成功率是 undefined，不是 0', () => {
      expect(interruptSuccessRate(statsOf(att))).toBeUndefined();
      expect(skillHitRate(statsOf(att))).toBeUndefined();
    });

    /**
     * ★★ 7.5 的假读条闭环 —— 这是 M2 就在验的那条博弈，现在能记账了。
     *   起手读条 → 主动 Esc 取消 → 对方的拳击落空（reason: notCasting）
     *   → 记 def 一次「成功假读条」。
     */
    it('★★ 主动取消读条后骗掉对方一次打断 → 记一次成功假读条（7.5）', () => {
      recordSelfCancel(store, def.id, 10);
      ingestCombatEvents(store, world, [
        { t: 'interrupt', sourceId: att.id, targetId: def.id, success: false, reason: 'notCasting' },
      ], 10.4);
      expect(statsOf(def).general.fakeCastsBaited).toBe(1);
    });

    it('打断落空但目标没有刚取消读条 → 不算假读条（只是按空了）', () => {
      ingestCombatEvents(store, world, [
        { t: 'interrupt', sourceId: att.id, targetId: def.id, success: false, reason: 'notCasting' },
      ], 10);
      expect(statsOf(def).general.fakeCastsBaited).toBe(0);
    });

    it('取消读条太久之前 → 超出窗口不算被骗', () => {
      recordSelfCancel(store, def.id, 0);
      ingestCombatEvents(store, world, [
        { t: 'interrupt', sourceId: att.id, targetId: def.id, success: false, reason: 'notCasting' },
      ], STATS.FAKE_CAST_WINDOW_SECONDS + 0.5);
      expect(statsOf(def).general.fakeCastsBaited).toBe(0);
    });

    /** 一次取消只能骗到一次，否则两个敌人同时按空会记两笔 */
    it('★ 一次取消只记一次假读条，多个敌人同时按空不重复计', () => {
      recordSelfCancel(store, def.id, 10);
      ingestCombatEvents(store, world, [
        { t: 'interrupt', sourceId: att.id, targetId: def.id, success: false, reason: 'notCasting' },
        { t: 'interrupt', sourceId: healer.id, targetId: def.id, success: false, reason: 'notCasting' },
      ], 10.2);
      expect(statsOf(def).general.fakeCastsBaited).toBe(1);
    });
  });

  describe('击杀与助攻', () => {
    it('击杀与死亡各记一笔', () => {
      ingestCombatEvents(store, world, [
        { t: 'death', targetId: def.id, killerId: att.id },
      ], 1);
      expect(statsOf(att).general.kills).toBe(1);
      expect(statsOf(def).general.deaths).toBe(1);
    });

    it('窗口内造成过伤害的其他人记助攻，击杀者本人不记助攻', () => {
      ingestCombatEvents(store, world, [
        damageEvent(att, def, 100),
        damageEvent(healer, def, 50),
      ], 1);
      ingestCombatEvents(store, world, [{ t: 'death', targetId: def.id, killerId: att.id }], 2);
      expect(statsOf(healer).general.assists).toBe(1);
      expect(statsOf(att).general.assists).toBe(0);
    });

    it('★ 超出助攻窗口的伤害不算助攻（上一波交火不该被算进来）', () => {
      ingestCombatEvents(store, world, [damageEvent(healer, def, 50)], 0);
      ingestCombatEvents(store, world, [
        { t: 'death', targetId: def.id, killerId: att.id },
      ], STATS.ASSIST_WINDOW_SECONDS + 1);
      expect(statsOf(healer).general.assists).toBe(0);
    });
  });

  describe('技能命中率与关键技能', () => {
    it('命中率按「产生了效果」算，不是按「按下去了」算', () => {
      const skill = asSkillId('mage.frostbolt');
      recordSkillUse(store, att.id, skill, true);
      recordSkillUse(store, att.id, skill, false);
      expect(skillHitRate(statsOf(att))).toBeCloseTo(0.5, 5);
    });

    /** ★ 关键技能判据是数据驱动的，不维护手工名单 —— 名单一定会和数据脱节 */
    it('★ 专用打断算关键技能', () => {
      const kick = mage.skills.find((s) => s.effects.some((e) => e.kind === 'interrupt'));
      expect(kick).toBeDefined();
      expect(isKeySkill(kick!.id)).toBe(true);
    });

    it('★ 长冷却大招算关键技能，短冷却常规技能不算', () => {
      const long = mage.skills.find((s) => s.cooldown >= STATS.KEY_SKILL_COOLDOWN_SECONDS);
      const short = mage.skills.find(
        (s) => s.cooldown < STATS.KEY_SKILL_COOLDOWN_SECONDS
          && !s.effects.some((e) => e.kind === 'interrupt'),
      );
      expect(long && isKeySkill(long.id)).toBe(true);
      expect(short && isKeySkill(short.id)).toBe(false);
    });

    it('关键技能使用按技能分别计数', () => {
      const long = mage.skills.find((s) => s.cooldown >= STATS.KEY_SKILL_COOLDOWN_SECONDS)!;
      recordSkillUse(store, att.id, long.id, true);
      recordSkillUse(store, att.id, long.id, true);
      expect(statsOf(att).general.keySkillUses.get(long.id)).toBe(2);
    });
  });

  /** ★ 2.1 同源：宠物、图腾、召唤物不该出现在战后统计里 */
  it('★ 未登记的实体（宠物/召唤物）产生的事件被静默忽略', () => {
    const pet = addEntity(
      world,
      createEntity(allocEntityId(world), mage, TEAM_RED, vec3(2, 0, 0), { isPet: true }),
    );
    ingestCombatEvents(store, world, [damageEvent(pet, def, 500)], 1);
    expect(store.players.has(pet.id)).toBe(false);
    expect(statsOf(def).general.damageTaken).toBe(500); // 承伤方仍照实记
  });
});

// ════════════════════════════════════════════════════════════════

describe('16.2 武装竞技场统计', () => {
  const kinds = new Map<number, 'weapon' | 'armor' | 'consumable'>([
    [1, 'weapon'], [2, 'armor'], [3, 'consumable'],
  ]);
  const kindOf = (id: number) => kinds.get(id);

  it('拾取按类别分别计数，并记一次争夺胜出', () => {
    ingestPickupEvents(store, world, [
      { entityId: att.id, dropId: 1, result: 'completed' },
      { entityId: att.id, dropId: 2, result: 'completed' },
      { entityId: att.id, dropId: 3, result: 'completed' },
    ], kindOf, 5);
    const s = statsOf(att);
    expect(s.arena.weaponPickups).toBe(1);
    expect(s.arena.armorPickups).toBe(1);
    expect(s.arena.buffPickups).toBe(1);
    expect(s.arena.arsenalContestsWon).toBe(3);
  });

  it('★ 两个人碰同一个掉落物时，双方各记一次争夺（含先到的那个）', () => {
    ingestPickupEvents(store, world, [{ entityId: att.id, dropId: 1, result: 'cancelled' }], kindOf, 1);
    expect(statsOf(att).arena.arsenalContests).toBe(0); // 只有自己，不算争夺
    ingestPickupEvents(store, world, [{ entityId: def.id, dropId: 1, result: 'cancelled' }], kindOf, 2);
    expect(statsOf(att).arena.arsenalContests).toBe(1);
    expect(statsOf(def).arena.arsenalContests).toBe(1);
  });

  it('敌方的拾取被硬控打断时记给敌人（归因用最近伤害来源近似）', () => {
    ingestCombatEvents(store, world, [damageEvent(att, def, 10)], 1);
    ingestPickupEvents(store, world, [{ entityId: def.id, dropId: 1, result: 'stunned' }], kindOf, 2);
    expect(statsOf(att).arena.enemyPickupsInterrupted).toBe(1);
  });

  it('自己走开导致的拾取中断不记给任何人', () => {
    ingestCombatEvents(store, world, [damageEvent(att, def, 10)], 1);
    ingestPickupEvents(store, world, [{ entityId: def.id, dropId: 1, result: 'moved' }], kindOf, 2);
    expect(statsOf(att).arena.enemyPickupsInterrupted).toBe(0);
  });

  it('只统计完成的换装，被打断的不算', () => {
    const state = { weaponId: warrior.defaultWeaponId, armorId: warrior.defaultArmorId } as never;
    ingestSwapEvents(store, [
      { entityId: def.id, state, result: 'completed' },
      { entityId: def.id, state, result: 'moved' },
    ]);
    expect(statsOf(def).arena.swaps).toBe(1);
  });

  it('★ 拾取后短时间内的击杀算「因争夺补给发生的击杀」', () => {
    ingestPickupEvents(store, world, [{ entityId: att.id, dropId: 1, result: 'completed' }], kindOf, 10);
    ingestCombatEvents(store, world, [{ t: 'death', targetId: def.id, killerId: att.id }], 12);
    expect(statsOf(att).arena.killsFromSupplyContest).toBe(1);
  });

  it('拾取很久之后的击杀不算补给击杀', () => {
    ingestPickupEvents(store, world, [{ entityId: att.id, dropId: 1, result: 'completed' }], kindOf, 0);
    ingestCombatEvents(store, world, [
      { t: 'death', targetId: def.id, killerId: att.id },
    ], STATS.SUPPLY_KILL_WINDOW_SECONDS + 1);
    expect(statsOf(att).arena.killsFromSupplyContest).toBe(0);
  });

  it('各武器/护甲使用时长按 tick 累加', () => {
    sampleTick(store, { world }, 0.5);
    sampleTick(store, { world }, 0.5);
    expect(statsOf(att).arena.weaponTime.get(mage.defaultWeaponId)).toBeCloseTo(1, 5);
    expect(statsOf(att).arena.armorTime.get(mage.defaultArmorId)).toBeCloseTo(1, 5);
  });

  it('武器伤害按开火时手上的那把武器归集', () => {
    ingestCombatEvents(store, world, [damageEvent(att, def, 200)], 1);
    expect(statsOf(att).arena.weaponDamage.get(mage.defaultWeaponId)).toBe(200);
  });
});

// ════════════════════════════════════════════════════════════════

describe('16.3 夺旗贡献', () => {
  let ctf: CtfState;

  beforeEach(() => {
    ctf = createCtf(vec3(0, 0, 100), vec3(0, 0, -100));
  });

  const ctfDeps = () => ({ world, ctf: { state: ctf, map: ctfMap } });

  it('拔旗/交旗/归还各自计数，掉旗不是贡献项', () => {
    ingestFlagEvents(store, [
      { type: 'taken', flagTeam: TEAM_BLUE, entityId: att.id },
      { type: 'captured', flagTeam: TEAM_BLUE, entityId: att.id },
      { type: 'returned', flagTeam: TEAM_RED, entityId: att.id },
      { type: 'dropped', flagTeam: TEAM_BLUE, entityId: att.id, reason: 'death' },
    ]);
    const s = statsOf(att).ctf;
    expect([s.carries, s.captures, s.returns]).toEqual([1, 1, 1]);
  });

  it('携旗时间按 tick 累加', () => {
    att.flags.carryingFlag = true;
    sampleTick(store, ctfDeps(), 0.5);
    sampleTick(store, ctfDeps(), 0.5);
    expect(statsOf(att).ctf.carrySeconds).toBeCloseTo(1, 5);
  });

  /**
   * ★ 携旗距离逐 tick 累加实际位移。
   *   用「拔旗点到交旗点」的直线会把绕路走的 30 米算成 10 米 ——
   *   而绕路躲追杀正是旗手的正确打法，不该被统计惩罚。
   */
  it('★ 携旗距离累加实际路径，不是起点到终点的直线', () => {
    att.flags.carryingFlag = true;
    att.position = vec3(0, 0, 0);
    sampleTick(store, ctfDeps(), 0.1);      // 建立锚点
    att.position = vec3(10, 0, 0);
    sampleTick(store, ctfDeps(), 0.1);      // 往东 10
    att.position = vec3(0, 0, 0);
    sampleTick(store, ctfDeps(), 0.1);      // 绕回原点
    expect(statsOf(att).ctf.carryDistance).toBeCloseTo(20, 5); // 不是 0
  });

  it('★ 掉旗后再拔旗，中间那段没携旗的路程不算进携旗距离', () => {
    att.flags.carryingFlag = true;
    att.position = vec3(0, 0, 0);
    sampleTick(store, ctfDeps(), 0.1);

    att.flags.carryingFlag = false;         // 掉旗
    att.position = vec3(50, 0, 0);          // 跑了很远
    sampleTick(store, ctfDeps(), 0.1);

    att.flags.carryingFlag = true;          // 再拔到旗
    sampleTick(store, ctfDeps(), 0.1);
    att.position = vec3(53, 0, 0);
    sampleTick(store, ctfDeps(), 0.1);

    expect(statsOf(att).ctf.carryDistance).toBeCloseTo(3, 5);
  });

  it('治疗己方旗手额外记「为旗手治疗」', () => {
    att.flags.carryingFlag = true;
    ingestCombatEvents(store, world, [
      { t: 'heal', sourceId: healer.id, targetId: att.id, amount: 300, overheal: 0 },
    ], 1);
    expect(statsOf(healer).ctf.healingToCarrier).toBe(300);
  });

  it('★ 治疗敌方旗手不算贡献', () => {
    def.flags.carryingFlag = true;          // def 是蓝队
    ingestCombatEvents(store, world, [
      { t: 'heal', sourceId: healer.id, targetId: def.id, amount: 300, overheal: 0 },
    ], 1);
    expect(statsOf(healer).ctf.healingToCarrier).toBe(0);
  });

  it('给旗手的护盾吸收掉的伤害记「为旗手减伤」', () => {
    def.flags.carryingFlag = true;
    ingestCombatEvents(store, world, [
      damageEvent(att, def, 50, { absorbed: 60, absorbedBy: [{ sourceId: healer.id, amount: 60 }] }),
    ], 1);
    expect(statsOf(healer).ctf.damageReducedForCarrier).toBe(60);
  });

  it('击杀敌方旗手记 carrierKills', () => {
    def.flags.carryingFlag = true;
    ingestCombatEvents(store, world, [{ t: 'death', targetId: def.id, killerId: att.id }], 1);
    expect(statsOf(att).ctf.carrierKills).toBe(1);
  });

  it('击杀非旗手不记 carrierKills', () => {
    ingestCombatEvents(store, world, [{ t: 'death', targetId: def.id, killerId: att.id }], 1);
    expect(statsOf(att).ctf.carrierKills).toBe(0);
  });

  describe('护送', () => {
    it('在己方旗手支援距离内累加护送时间', () => {
      att.flags.carryingFlag = true;
      att.position = vec3(0, 0, 0);
      healer.position = vec3(STATS.SUPPORT_RADIUS - 1, 0, 0);
      sampleTick(store, ctfDeps(), 1);
      expect(statsOf(healer).ctf.escortSeconds).toBeCloseTo(1, 5);
    });

    it('离得太远不算护送', () => {
      att.flags.carryingFlag = true;
      att.position = vec3(0, 0, 0);
      healer.position = vec3(STATS.SUPPORT_RADIUS + 5, 0, 0);
      sampleTick(store, ctfDeps(), 1);
      expect(statsOf(healer).ctf.escortSeconds).toBe(0);
    });

    /** ★ 旗手不能护送自己 —— 否则最佳护送者永远是旗手本人 */
    it('★ 旗手本人不累加护送时间', () => {
      att.flags.carryingFlag = true;
      sampleTick(store, ctfDeps(), 1);
      expect(statsOf(att).ctf.escortSeconds).toBe(0);
    });

    it('★ 护送只算己方旗手，跟着敌方旗手跑不算护送', () => {
      def.flags.carryingFlag = true;          // 蓝队旗手
      def.position = vec3(0, 0, 0);
      healer.position = vec3(1, 0, 0);        // 红队治疗贴着他
      sampleTick(store, ctfDeps(), 1);
      expect(statsOf(healer).ctf.escortSeconds).toBe(0);
    });
  });

  describe('基地防守', () => {
    /**
     * ★ 「有敌人也在附近」这个条件不能省。
     *   否则整局蹲在基地不动的人会拿到最高防守分，
     *   而 16.4 要选的是**最佳防守者**，不是最佳挂机者。
     */
    it('★ 己方旗帜附近有敌人时才累加防守时间', () => {
      const ownFlag = ctf.flags[String(TEAM_RED)]!;
      att.position = { ...ownFlag.position };   // 红队站在自家旗边
      def.position = vec3(500, 0, 500);         // 敌人在天边
      sampleTick(store, ctfDeps(), 1);
      expect(statsOf(att).ctf.baseDefenseSeconds).toBe(0);

      def.position = { ...ownFlag.position };   // 敌人杀进来了
      sampleTick(store, ctfDeps(), 1);
      expect(statsOf(att).ctf.baseDefenseSeconds).toBeCloseTo(1, 5);
    });
  });

  describe('关键通道控制', () => {
    /** ★ 路线来自 MapDef.routes，不在统计里硬编码坐标 —— 换图就该跟着换 */
    it('★ 站在地图声明的主路线上且有敌人接近时累加', () => {
      const wp = ctfMap.routes![0]!.waypoints[2]!;
      att.position = { ...wp };
      def.position = { ...wp };
      sampleTick(store, ctfDeps(), 1);
      expect(statsOf(att).ctf.corridorControlSeconds).toBeCloseTo(1, 5);
    });

    it('路线上没有敌人时不算控制通道', () => {
      const wp = ctfMap.routes![0]!.waypoints[2]!;
      att.position = { ...wp };
      def.position = vec3(500, 0, 500);
      sampleTick(store, ctfDeps(), 1);
      expect(statsOf(att).ctf.corridorControlSeconds).toBe(0);
    });
  });

  it('死人不采样连续量', () => {
    att.flags.carryingFlag = true;
    att.alive = false;
    sampleTick(store, ctfDeps(), 1);
    expect(statsOf(att).ctf.carrySeconds).toBe(0);
  });

  /** ★ 与 15.4 让两种模式 HUD 视图不相交同源：竞技场不传 ctf，就没有旗帜采样 */
  it('★ 竞技场（不传 ctf）不产生任何夺旗采样', () => {
    att.flags.carryingFlag = true;
    sampleTick(store, { world }, 1);
    expect(statsOf(att).ctf.carrySeconds).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════
//  16.4 最佳玩家
// ════════════════════════════════════════════════════════════════

describe('16.4 最佳玩家（验收 #50）', () => {
  const blank = (id: number, name: string): PlayerStats => {
    const e = createEntity(asEntityId(id), getClass(asClassId('mage'))!, TEAM_RED, vec3(0, 0, 0), { name });
    const s = createStats();
    return registerPlayer(s, e);
  };

  it('七个奖项全部产出（16.4 第一条）', () => {
    const results = pickAwards([blank(1, 'a'), blank(2, 'b')]);
    expect(results.map((r) => r.award)).toEqual([...AWARDS]);
    expect(results).toHaveLength(7);
  });

  it('★ 没人在某维度有贡献时不硬塞一个 0 分获奖者', () => {
    const results = pickAwards([blank(1, 'a')]);
    const carrier = results.find((r) => r.award === 'bestFlagCarrier')!;
    expect(carrier.winner).toBeUndefined();
    expect(carrier.score).toBe(0);
  });

  it('专项奖按自己那一项评：最佳打断者就是打断最多的人', () => {
    const a = blank(1, '打断哥');
    const b = blank(2, '伤害哥');
    a.general.interruptsLanded = 10;
    b.general.damageDone = 999999;
    const winner = pickAwards([a, b]).find((r) => r.award === 'bestInterrupter')!.winner;
    expect(winner?.name).toBe('打断哥');
  });

  // ── 以下三条守 16.4 第二条 ──────────────────────────────────

  /**
   * ★★ **这是验收 #50 / 16.4 第二条的行为测试。**
   *
   *   构造一个「只会打伤害」的玩家和一个「全面贡献」的玩家：
   *   伤害哥的伤害是旗手哥的 20 倍，但除此之外一无所有；
   *   旗手哥交了旗、护送、防守、治疗、打断都有。
   *
   *   16.4：「不能只按总伤害或击杀数评选最佳玩家。」
   *   所以最佳综合玩家**必须**是旗手哥。
   */
  it('★★ 伤害碾压但只会打伤害的人拿不到最佳综合玩家（16.4 第二条）', () => {
    const dps = blank(1, '伤害哥');
    dps.general.damageDone = 2_000_000;
    dps.general.kills = 20;

    const allRound = blank(2, '全面哥');
    allRound.general.damageDone = 100_000;
    allRound.general.healingDone = 80_000;
    allRound.general.interruptsLanded = 8;
    allRound.general.dispels = 6;
    allRound.ctf.captures = 3;
    allRound.ctf.returns = 4;
    allRound.ctf.escortSeconds = 120;
    allRound.ctf.baseDefenseSeconds = 90;
    allRound.arena.arsenalContestsWon = 5;
    allRound.arena.damageReducedByEquipment = 40_000;

    const overall = pickAwards([dps, allRound]).find((r) => r.award === 'bestOverall')!;
    expect(overall.winner?.name).toBe('全面哥');
  });

  /**
   * ★ 结构性保证之一：综合评分**必须**由足够多的维度构成。
   *   `CompositeScore` 的唯一构造入口是 `composeScore()`，它在维度不足时抛异常 ——
   *   所以「把综合奖改成只看伤害」写不出来，只能先改这个函数。
   */
  it('★ composeScore 在维度不足时抛异常', () => {
    expect(() => composeScore([
      { dimension: 'combat', normalized: 1, weight: 1 },
    ])).toThrow(/至少需要/);

    expect(() => composeScore(
      SCORE_DIMENSIONS.slice(0, MIN_OVERALL_DIMENSIONS - 1).map((d) => ({
        dimension: d, normalized: 1, weight: 1,
      })),
    )).toThrow(/至少需要/);
  });

  /**
   * ★ 结构性保证之二：光有「维度数够」还不够。
   *   给 combat 权重 0.97、其余三项各 0.01，在形式上是四个维度，
   *   实质仍然是「只按伤害评选」—— 所以还要卡单一维度的权重占比。
   */
  it('★ composeScore 在单一维度权重占比过高时抛异常', () => {
    const parts = SCORE_DIMENSIONS.slice(0, MIN_OVERALL_DIMENSIONS).map((d, i) => ({
      dimension: d, normalized: 1, weight: i === 0 ? 100 : 1,
    }));
    expect(() => composeScore(parts)).toThrow(/权重占比/);
  });

  it('★ 实际使用的权重表本身就满足这两条约束', () => {
    // pickAwards 内部会调 composeScore；只要它不抛，OVERALL_WEIGHTS 就是合法的
    expect(() => pickAwards([blank(1, 'a')])).not.toThrow();
  });

  it('综合奖会带上各维度的构成，供战后界面解释「为什么是他」', () => {
    const a = blank(1, 'a');
    a.general.damageDone = 1000;
    const overall = pickAwards([a]).find((r) => r.award === 'bestOverall')!;
    expect(overall.parts?.map((p) => p.dimension)).toEqual([...SCORE_DIMENSIONS]);
    const total = overall.parts!.reduce((s, p) => s + p.weight, 0);
    for (const p of overall.parts!) {
      expect(p.weight / total).toBeLessThanOrEqual(MAX_DIMENSION_WEIGHT_SHARE + 1e-9);
    }
  });

  /**
   * ★ 伤害与击杀在**同一个** combat 维度里，这是有意的。
   *   拆成两个维度就能用「两个维度」凑够维度数下限，
   *   而 16.4 禁止的正是「只按总伤害**或**击杀数」。
   */
  it('★ 伤害与击杀属于同一个维度，不能靠拆分绕过维度数下限', () => {
    expect(SCORE_DIMENSIONS).toContain('combat');
    expect(SCORE_DIMENSIONS as readonly string[]).not.toContain('kills');
    expect(SCORE_DIMENSIONS as readonly string[]).not.toContain('damage');
  });
});
