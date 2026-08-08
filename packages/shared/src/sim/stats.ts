/**
 * 战后统计与贡献评价。规格书 16.1–16.4，验收 #50。
 *
 * ★ **统计是事件流的纯折叠，不往任何战斗系统里插钩子。**
 *
 *   各系统本来就已经吐出自己的事件数组（`CombatEvent[]`、`FlagEvent[]`、
 *   `PickupTickEvent[]`、`SwapTickEvent[]`），本文件只消费它们。
 *   好处不是省事，而是**一个统计口径写错也不可能改变对局结果** ——
 *   统计代码里没有任何一行能改到 world / auras / dr。
 *
 *   代价是每项统计需要的信息都必须先出现在事件里。`CombatEvent` 上的
 *   `preventedByEquipment`、`absorbedBy`、`drCategory`、以及「落空也发」的
 *   `interrupt` 事件，都是为此补的 —— 补事件比插钩子安全得多。
 *
 * ★ 另一半是**连续量**（携旗时间、护送时间、各武器使用时长），它们不来自事件，
 *   由 `sampleTick()` 每 tick 采样。这两半刻意分开：离散量是「发生了什么」，
 *   连续量是「持续处于什么状态」，混在一起会让某些量在低帧率下漏记。
 *
 * ── 16.4 的否定式规则是本文件的重点 ─────────────────────────────
 *
 *   「**不能只按总伤害或击杀数评选最佳玩家。**」
 *
 *   这类规则最容易在某次「顺手把评分简化一下」之后被破掉，而且破掉它不会让
 *   任何东西报错 —— 只会让治疗和旗手永远拿不到最佳玩家。所以这里不靠自觉：
 *   见本文件末尾 `composeScore()` 的注释。
 */

import { RANGE } from '../constants/combat.js';
import { getSkill, isDedicatedInterrupt } from '../data/index.js';
import type { MapDef } from '../data/maps/schema.js';
import { distance2D, type Vec3 } from '../math/vec3.js';
import type { ArmorId, ClassId, EntityId, SkillId, TeamId, WeaponId } from '../types/ids.js';
import type { CombatEntity } from './entity.js';
import type { CombatEvent } from './effects/registry.js';
import type { FlagEvent } from './match/flag.js';
import type { CtfState } from './match/flag.js';
import type { PickupTickEvent } from './arsenal.js';
import type { SwapTickEvent } from './loadout.js';
import type { World } from './world.js';

// ════════════════════════════════════════════════════════════════
//  判断口径
// ════════════════════════════════════════════════════════════════

/**
 * 规格书 16.x 列出了要统计**什么**，但没有给出「多近算护送」「多久内算助攻」
 * 这类判定口径。下面每一条都写明取值理由；能复用 6.1 的距离基准就复用，
 * 不另造数字 —— 另造的数字没人知道该不该改。
 */
export const STATS = {
  /**
   * 死亡前多久之内造成过伤害算助攻。
   * 取 10 秒：比一次完整的控制链（8.2 递减窗口 15 秒）短，比一次读条（≤3 秒）长 ——
   * 既不会把「上一波交火」算进来，也不会漏掉「打掉护盾的人」。
   */
  ASSIST_WINDOW_SECONDS: 10,
  /**
   * 主动取消读条后多久之内、对方的打断落空，算一次「成功假读条」（7.5）。
   * 取 2 秒：被骗的打断必须在对方**还以为你在读条**时按下。
   * 人的反应加技能飞行远在 2 秒以内；再长就会把「碰巧按空」也算成被骗。
   */
  FAKE_CAST_WINDOW_SECONDS: 2,
  /**
   * 护送 / 基地防守 / 通道控制的判定半径，统一取 6.1 的「短距离」12 米 ——
   * 也就是「近距离支援」的射程档。含义明确：你处在能支援到那里的距离上。
   */
  SUPPORT_RADIUS: RANGE.SHORT,
  /**
   * 拾取/争夺补给之后多久内的击杀算「因争夺补给发生的击杀」（16.2）。
   * 取 10 秒，与助攻窗口同源：再长就和普通遭遇战分不开了。
   */
  SUPPLY_KILL_WINDOW_SECONDS: 10,
  /**
   * 「关键技能」的判据（16.1「关键技能使用」）。规格书没有定义它，
   * 这里取**数据驱动**的两条：专用打断，或冷却 ≥ 60 秒的大招。
   * 好处是新增技能不需要手工维护一张关键技能名单。
   */
  KEY_SKILL_COOLDOWN_SECONDS: 60,
} as const;

// ════════════════════════════════════════════════════════════════
//  16.1 通用统计
// ════════════════════════════════════════════════════════════════

export interface GeneralStats {
  kills: number;
  deaths: number;
  assists: number;
  /** 有效伤害：不含被免疫和溢出的部分 */
  damageDone: number;
  /** 有效治疗：不含溢出治疗 */
  healingDone: number;
  damageTaken: number;
  /** 吸收。★ 记给**下盾的人**，不是被打的人 */
  absorbProvided: number;

  interruptsLanded: number;
  /** 打断**尝试**次数（含落空）。16.1 的「打断成功率」需要这个分母 */
  interruptsAttempted: number;
  timesInterrupted: number;

  dispels: number;
  /** 施加的控制总时长，秒。只统计带 8.2 递减类别的效果 */
  controlSecondsApplied: number;
  /** 解除控制次数（驱散掉一个带递减类别的效果）*/
  controlBreaks: number;

  /** 技能命中率的分子分母 */
  skillsAttempted: number;
  skillsLanded: number;
  /** 关键技能使用次数，按技能分别计 */
  keySkillUses: Map<SkillId, number>;
  /** 7.5 成功假读条：骗掉了对方一次打断 */
  fakeCastsBaited: number;
  /**
   * 本局打出的暴击次数（伤害与治疗都算）。
   *
   * ★ 16.x 没有要求这一项 —— 它跟着**已知偏差 #7**（暴击是规格书之外的
   *   玩法新增）一起进来。当时刻意没加统计，理由是「16.x 无暴击统计要求」；
   *   现在补，是因为 16a 的结算面板要展示它，而**一个玩家看得见的机制
   *   却在战后统计里查无此项**本身就是缺口。
   * ★ 口径：按**掷出暴击的那一方**记（与 `damageDone` 同一侧），
   *   周期跳（DoT/HoT/地面 tick）与 8.5 压迫伤害本来就不暴击，自然不计。
   */
  crits: number;
}

const createGeneralStats = (): GeneralStats => ({
  kills: 0,
  deaths: 0,
  assists: 0,
  damageDone: 0,
  healingDone: 0,
  damageTaken: 0,
  absorbProvided: 0,
  interruptsLanded: 0,
  interruptsAttempted: 0,
  timesInterrupted: 0,
  dispels: 0,
  controlSecondsApplied: 0,
  controlBreaks: 0,
  skillsAttempted: 0,
  skillsLanded: 0,
  keySkillUses: new Map(),
  fakeCastsBaited: 0,
  crits: 0,
});

// ════════════════════════════════════════════════════════════════
//  16.2 武装竞技场统计
// ════════════════════════════════════════════════════════════════

export interface ArenaStats {
  weaponPickups: number;
  armorPickups: number;
  buffPickups: number;
  /** 军械箱争夺：参与了同一个掉落物的拾取（不论是否抢到）*/
  arsenalContests: number;
  arsenalContestsWon: number;
  /** 打断敌方拾取：敌方的拾取因为我的控制/伤害而中断 */
  enemyPickupsInterrupted: number;
  swaps: number;
  /** 各武器使用时长，秒 */
  weaponTime: Map<WeaponId, number>;
  /** 各武器造成的伤害 */
  weaponDamage: Map<WeaponId, number>;
  /** 各护甲使用时长，秒 */
  armorTime: Map<ArmorId, number>;
  /** 护甲（含武器）减少的伤害总量 */
  damageReducedByEquipment: number;
  /**
   * 增益期间击杀。
   *
   * ✅ **已知偏差 #2 已关闭**（M11-6 补 sim 使用路径 + M16 补可达性）。
   *   它曾经**结构上恒为 0** 而不是「统计出来是 0」：消耗品能被拾取，
   *   但 sim 里没有任何地方**使用**它们产生增益，「增益期间」这个状态
   *   从不存在。后来 sim 通了，可达性又卡了一轮 —— 服务器不刷货、
   *   快照不带掉落物、客户端不发消息、房间默认经典竞技场。
   *   现在整条链有断言钉着：`verify:m16` #11 → #11b → #13。
   */
  killsDuringBuff: number;
  /** 因争夺补给发生的击杀：击杀发生在拾取/争夺之后的窗口内 */
  killsFromSupplyContest: number;
}

const createArenaStats = (): ArenaStats => ({
  weaponPickups: 0,
  armorPickups: 0,
  buffPickups: 0,
  arsenalContests: 0,
  arsenalContestsWon: 0,
  enemyPickupsInterrupted: 0,
  swaps: 0,
  weaponTime: new Map(),
  weaponDamage: new Map(),
  armorTime: new Map(),
  damageReducedByEquipment: 0,
  killsDuringBuff: 0,
  killsFromSupplyContest: 0,
});

// ════════════════════════════════════════════════════════════════
//  16.3 夺旗贡献
// ════════════════════════════════════════════════════════════════

export interface CtfStats {
  /** 携旗次数（拔到敌方旗帜）*/
  carries: number;
  carrySeconds: number;
  /** 携旗距离，米。★ 逐 tick 累加实际位移，不是起点到终点的直线 */
  carryDistance: number;
  captures: number;
  returns: number;
  /** 击杀敌方旗手 */
  carrierKills: number;

  /** 护送旗手：处在己方旗手支援距离内的时长，秒。★ 旗手本人不计 */
  escortSeconds: number;
  healingToCarrier: number;
  /** 为旗手减伤：己方旗手身上由我提供的护盾吸收掉的伤害 */
  damageReducedForCarrier: number;
  /** 基地防守：在己方旗帜附近、且有敌人也在附近的时长，秒 */
  baseDefenseSeconds: number;
  /** 关键通道控制：处在地图声明的主路线上、且有敌人也在附近的时长，秒 */
  corridorControlSeconds: number;
}

const createCtfStats = (): CtfStats => ({
  carries: 0,
  carrySeconds: 0,
  carryDistance: 0,
  captures: 0,
  returns: 0,
  carrierKills: 0,
  escortSeconds: 0,
  healingToCarrier: 0,
  damageReducedForCarrier: 0,
  baseDefenseSeconds: 0,
  corridorControlSeconds: 0,
});

// ════════════════════════════════════════════════════════════════
//  容器
// ════════════════════════════════════════════════════════════════

export interface PlayerStats {
  entityId: EntityId;
  name: string;
  team: TeamId;
  classId: ClassId;
  general: GeneralStats;
  arena: ArenaStats;
  ctf: CtfStats;
}

export interface StatsStore {
  players: Map<EntityId, PlayerStats>;

  // ── 以下是折叠过程的中间状态，不是统计结果 ──────────────────
  /** 助攻判定：受害者 → 攻击者 → 最后一次造成伤害的时刻 */
  recentDamage: Map<EntityId, Map<EntityId, number>>;
  /** 7.5 假读条判定：主动取消读条的时刻 */
  selfCancelAt: Map<EntityId, number>;
  /** 16.2 补给击杀判定：最近一次拾取/争夺的时刻 */
  lastSupplyAt: Map<EntityId, number>;
  /** 增益道具生效截止时刻（消耗品接上使用路径后才会有值）*/
  itemBuffUntil: Map<EntityId, number>;
  /** 携旗距离判定：旗手上一次采样时的位置 */
  lastCarrierPos: Map<EntityId, Vec3>;
  /** 同一个掉落物的参与者，用于「军械箱争夺」计数 */
  dropParticipants: Map<number, Set<EntityId>>;
}

export const createStats = (): StatsStore => ({
  players: new Map(),
  recentDamage: new Map(),
  selfCancelAt: new Map(),
  lastSupplyAt: new Map(),
  itemBuffUntil: new Map(),
  lastCarrierPos: new Map(),
  dropParticipants: new Map(),
});

/**
 * 登记一名玩家。★ 未登记的实体产生的事件会被**静默忽略** ——
 * 这是有意的：宠物、图腾、召唤物不该出现在战后统计里（2.1 同源）。
 */
export const registerPlayer = (store: StatsStore, e: CombatEntity): PlayerStats => {
  const existing = store.players.get(e.id);
  if (existing) return existing;
  const s: PlayerStats = {
    entityId: e.id,
    name: e.name,
    team: e.team,
    classId: e.classId,
    general: createGeneralStats(),
    arena: createArenaStats(),
    ctf: createCtfStats(),
  };
  store.players.set(e.id, s);
  return s;
};

/** 只对已登记的玩家生效。返回 undefined 表示「不统计这个实体」 */
const of = (store: StatsStore, id: EntityId | undefined): PlayerStats | undefined =>
  id === undefined ? undefined : store.players.get(id);

const bump = (m: Map<string, number>, key: string, delta: number): void => {
  m.set(key, (m.get(key) ?? 0) + delta);
};

// ════════════════════════════════════════════════════════════════
//  离散量：折叠事件流
// ════════════════════════════════════════════════════════════════

/**
 * 折叠一批战斗事件。
 *
 * ⚠️ 必须在**死亡结算之后、`tickFlags()` 之前**调用。
 *   「被击杀的是不是旗手」要读 `entity.flags.carryingFlag`，
 *   而 `tickFlags()` 会在死亡后把旗帜掉下来并清掉那个标志 ——
 *   顺序反了，`carrierKills` 会永远是 0。
 */
export const ingestCombatEvents = (
  store: StatsStore,
  world: World,
  events: readonly CombatEvent[],
  now: number,
): void => {
  for (const ev of events) {
    switch (ev.t) {
      case 'damage': {
        if (ev.immune) break;
        const src = of(store, ev.sourceId);
        const dst = of(store, ev.targetId);
        if (src) {
          src.general.damageDone += ev.amount;
          // 偏差 #7 的暴击计数，按掷出暴击的一方记（见 GeneralStats.crits）
          if (ev.crit) src.general.crits += 1;
          // 16.2「各武器使用时长与伤害」的伤害一半
          const w = world.entities.get(ev.sourceId)?.weaponId;
          if (w !== undefined) bump(src.arena.weaponDamage as Map<string, number>, w, ev.amount);
        }
        if (dst) {
          dst.general.damageTaken += ev.amount;
          // ★ 记给**被打的人**：挡掉伤害的是他自己的装备
          dst.arena.damageReducedByEquipment += ev.preventedByEquipment;
        }
        // 吸收记给下盾的人，并在对方是己方旗手时额外记一笔「为旗手减伤」
        for (const a of ev.absorbedBy ?? []) {
          const shielder = of(store, a.sourceId);
          if (!shielder) continue;
          shielder.general.absorbProvided += a.amount;
          if (world.entities.get(ev.targetId)?.flags.carryingFlag) {
            shielder.ctf.damageReducedForCarrier += a.amount;
          }
        }
        // 助攻判定的原料
        if (src) {
          const byVictim = store.recentDamage.get(ev.targetId) ?? new Map<EntityId, number>();
          byVictim.set(ev.sourceId, now);
          store.recentDamage.set(ev.targetId, byVictim);
        }
        break;
      }

      case 'heal': {
        const src = of(store, ev.sourceId);
        if (!src) break;
        src.general.healingDone += ev.amount;
        if (ev.crit) src.general.crits += 1;
        // 16.3「为旗手治疗」。★ 只算**己方**旗手 —— 治敌方旗手不是贡献
        const target = world.entities.get(ev.targetId);
        if (target?.flags.carryingFlag && target.team === src.team) {
          src.ctf.healingToCarrier += ev.amount;
        }
        break;
      }

      case 'auraApplied': {
        // 16.1「控制时间」只认带 8.2 递减类别的效果 ——
        // 普通减速、持续伤害不是控制，混进来会让这一项失去意义
        if (!ev.drCategory) break;
        const src = of(store, ev.sourceId);
        if (src) src.general.controlSecondsApplied += ev.duration;
        break;
      }

      case 'dispelled': {
        const src = of(store, ev.sourceId);
        if (!src) break;
        src.general.dispels += 1;
        if (ev.drCategory) src.general.controlBreaks += 1;
        break;
      }

      case 'interrupt': {
        const src = of(store, ev.sourceId);
        if (src) {
          src.general.interruptsAttempted += 1;
          if (ev.success) src.general.interruptsLanded += 1;
        }
        if (ev.success) {
          const dst = of(store, ev.targetId);
          if (dst) dst.general.timesInterrupted += 1;
        } else if (ev.reason === 'notCasting' && ev.targetId !== undefined) {
          // ★ 7.5 成功假读条：对方按了打断，而我刚刚主动取消了读条 ——
          //   这一次落空是被我骗出来的。记给**被打断方**（骗人的那个）。
          const cancelledAt = store.selfCancelAt.get(ev.targetId);
          const baited =
            cancelledAt !== undefined && now - cancelledAt <= STATS.FAKE_CAST_WINDOW_SECONDS;
          if (baited) {
            const faker = of(store, ev.targetId);
            if (faker) faker.general.fakeCastsBaited += 1;
            // 一次取消只能骗到一次，否则一个取消会被多个敌人重复记账
            store.selfCancelAt.delete(ev.targetId);
          }
        }
        break;
      }

      case 'death': {
        const victim = of(store, ev.targetId);
        if (victim) victim.general.deaths += 1;

        const killer = of(store, ev.killerId);
        /**
         * ★★ **只有杀死一名已登记玩家才算一次击杀。**
         *
         *   `victim === undefined` 意味着死的是一个不在统计里的实体 ——
         *   宠物、图腾、召唤物（2.1 明说它们不计人数），以及大 BOSS。
         *   此前这里不看受害者是谁，于是打死一只宠物也 +1 击杀；
         *   BOSS 进来之后这条会变成实打实的漏洞：**打死 BOSS 会给最后
         *   一击者记一个人头**，而大乱斗的胜负判据正是「先到 N 杀」——
         *   一只 BOSS 白送一个胜点。BOSS 的奖励走它自己的赏金账
         *   （`sim/boss.ts` 的 `bounties`），不该混进击杀数。
         *
         * ★ 助攻同理：下面那段助攻循环也只在受害者已登记时才有意义 ——
         *   它读的 `recentDamage` 无论如何都要清掉（见循环后），
         *   所以清理留在外面，只把**记账**收进这个条件里。
         */
        if (killer && victim) {
          killer.general.kills += 1;
          // 16.2 因争夺补给发生的击杀
          const supplyAt = store.lastSupplyAt.get(killer.entityId);
          if (supplyAt !== undefined && now - supplyAt <= STATS.SUPPLY_KILL_WINDOW_SECONDS) {
            killer.arena.killsFromSupplyContest += 1;
          }
          if ((store.itemBuffUntil.get(killer.entityId) ?? 0) > now) {
            killer.arena.killsDuringBuff += 1;
          }
          // 16.3 击杀敌方旗手。★ 读的是**尚未掉旗**的状态，见函数头的顺序要求
          if (world.entities.get(ev.targetId)?.flags.carryingFlag) {
            killer.ctf.carrierKills += 1;
          }
        }

        // 助攻：窗口内造成过伤害、且不是击杀者本人。★ 与击杀同一条门槛
        //（受害者必须是已登记玩家）—— 否则打了 BOSS 一下的人满场都是助攻
        if (victim) {
          for (const [attacker, at] of store.recentDamage.get(ev.targetId) ?? []) {
            if (attacker === ev.killerId) continue;
            if (now - at > STATS.ASSIST_WINDOW_SECONDS) continue;
            const a = of(store, attacker);
            if (a) a.general.assists += 1;
          }
        }
        // ★ 清理**无条件**：BOSS/宠物的伤害记录同样该随它的死亡出账，
        //   留着只会在实体 id 被复用时把上一具尸体的攻击者算成助攻
        store.recentDamage.delete(ev.targetId);
        break;
      }

      default:
        // 其余事件（resource / displaced / immune / shieldBroken / auraRemoved / custom）
        // 与 16.x 的统计项无关。★ 刻意留空而不是省掉 default —— 将来加事件时
        // 这里是「要不要记账」的显式检查点。
        break;
    }
  }
};

/** 7.5：玩家主动取消了读条。假读条统计的另一半在 `interrupt` 事件里 */
export const recordSelfCancel = (store: StatsStore, id: EntityId, now: number): void => {
  if (!store.players.has(id)) return;
  store.selfCancelAt.set(id, now);
};

/**
 * 一次技能释放的尝试与结果，供 16.1 的「技能命中率」与「关键技能使用」。
 *
 * `landed` 的含义是「产生了至少一个效果」而不是「按下去了」——
 * 后者会让所有瞬发技能的命中率恒为 100%。
 */
export const recordSkillUse = (
  store: StatsStore,
  id: EntityId,
  skillId: SkillId,
  landed: boolean,
): void => {
  const s = of(store, id);
  if (!s) return;
  s.general.skillsAttempted += 1;
  if (landed) s.general.skillsLanded += 1;
  if (isKeySkill(skillId)) {
    bump(s.general.keySkillUses as Map<string, number>, skillId, 1);
  }
};

/**
 * 「关键技能」的判据，数据驱动（见 `STATS.KEY_SKILL_COOLDOWN_SECONDS`）：
 * 专用打断，或长冷却大招。不维护手工名单 —— 名单一定会和数据脱节。
 */
export const isKeySkill = (skillId: SkillId): boolean => {
  const skill = getSkill(skillId);
  if (!skill) return false;
  return isDedicatedInterrupt(skill) || skill.cooldown >= STATS.KEY_SKILL_COOLDOWN_SECONDS;
};

/** 消耗品增益的生效窗口。消耗品接上使用路径后由那里调用（见 ArenaStats.killsDuringBuff）*/
export const recordItemBuff = (store: StatsStore, id: EntityId, until: number): void => {
  if (!store.players.has(id)) return;
  store.itemBuffUntil.set(id, until);
};

/** 折叠拾取事件（16.2 装备争夺）*/
export const ingestPickupEvents = (
  store: StatsStore,
  world: World,
  events: readonly PickupTickEvent[],
  dropKindOf: (dropId: number) => 'weapon' | 'armor' | 'consumable' | undefined,
  now: number,
): void => {
  for (const ev of events) {
    const s = of(store, ev.entityId);
    if (!s) continue;

    // 争夺：同一个掉落物只要有第二个人参与过，就记双方各一次争夺
    const participants = store.dropParticipants.get(ev.dropId) ?? new Set<EntityId>();
    const isNew = !participants.has(ev.entityId);
    participants.add(ev.entityId);
    store.dropParticipants.set(ev.dropId, participants);
    if (isNew && participants.size === 2) {
      // 第二个人到场时，把在场的每个人都记上一次争夺（含先到的那个）
      for (const p of participants) {
        const ps = of(store, p);
        if (ps) ps.arena.arsenalContests += 1;
      }
    } else if (isNew && participants.size > 2) {
      s.arena.arsenalContests += 1;
    }

    if (ev.result === 'completed') {
      s.arena.arsenalContestsWon += 1;
      store.lastSupplyAt.set(ev.entityId, now);
      switch (dropKindOf(ev.dropId)) {
        case 'weapon': s.arena.weaponPickups += 1; break;
        case 'armor': s.arena.armorPickups += 1; break;
        case 'consumable': s.arena.buffPickups += 1; break;
        default: break;
      }
      continue;
    }

    // 10.5 的中断来源里，只有硬控制/强制位移是**敌方造成**的 ——
    // 'moved' 与 'cancelled' 是自己放弃，'taken' 是别人先完成（已计入对方的 won）
    if (ev.result === 'stunned' || ev.result === 'forcedMove') {
      // 归因给谁？拾取事件里没有「是谁控住我的」。用最近伤害来源近似 ——
      // ★ 这是**近似**而不是精确归因，写在这里以免以后被误当成精确值。
      const recent = store.recentDamage.get(ev.entityId);
      let latest: EntityId | undefined;
      let latestAt = -Infinity;
      for (const [attacker, at] of recent ?? []) {
        if (at > latestAt) { latestAt = at; latest = attacker; }
      }
      const enemy = of(store, latest);
      const me = world.entities.get(ev.entityId);
      if (enemy && me && enemy.team !== me.team) enemy.arena.enemyPickupsInterrupted += 1;
    }
  }
};

/** 折叠换装事件（16.2 换装次数）*/
export const ingestSwapEvents = (
  store: StatsStore,
  events: readonly SwapTickEvent[],
): void => {
  for (const ev of events) {
    if (ev.result !== 'completed') continue;
    const s = of(store, ev.entityId);
    if (s) s.arena.swaps += 1;
  }
};

/** 折叠旗帜事件（16.3）*/
export const ingestFlagEvents = (
  store: StatsStore,
  events: readonly FlagEvent[],
): void => {
  for (const ev of events) {
    const s = of(store, ev.entityId);
    if (!s) continue;
    switch (ev.type) {
      case 'taken': s.ctf.carries += 1; break;
      case 'captured': s.ctf.captures += 1; break;
      case 'returned': s.ctf.returns += 1; break;
      default: break; // dropped / interruptedInteract 不是贡献项
    }
  }
};

// ════════════════════════════════════════════════════════════════
//  连续量：每 tick 采样
// ════════════════════════════════════════════════════════════════

export interface StatsSampleDeps {
  world: World;
  /**
   * 夺旗对局才传。★ 竞技场传 undefined —— 与 15.4 让两种模式的 HUD 视图
   * 成为不相交类型同源：竞技场的统计里不该出现旗帜字段的采样逻辑。
   */
  ctf?: { state: CtfState; map: MapDef };
}

/**
 * 采样一个 tick 的连续量。
 *
 * ⚠️ 必须在**移动之后**调用 —— 携旗距离和护送距离都读当前位置。
 */
export const sampleTick = (store: StatsStore, deps: StatsSampleDeps, dt: number): void => {
  if (dt <= 0) return;

  for (const [id, s] of store.players) {
    const e = deps.world.entities.get(id);
    if (!e || !e.alive) continue;

    // 16.2 各武器 / 护甲使用时长
    bump(s.arena.weaponTime as Map<string, number>, e.weaponId, dt);
    bump(s.arena.armorTime as Map<string, number>, e.armorId, dt);
  }

  if (!deps.ctf) return;
  sampleCtfTick(store, deps.world, deps.ctf.state, deps.ctf.map, dt);
};

const sampleCtfTick = (
  store: StatsStore,
  world: World,
  ctf: CtfState,
  map: MapDef,
  dt: number,
): void => {
  const living = [...world.entities.values()].filter((e) => e.alive && !e.isPet);
  const carriers = living.filter((e) => e.flags.carryingFlag);

  // ── 携旗时间与距离 ──────────────────────────────────────────
  for (const c of carriers) {
    const s = of(store, c.id);
    if (!s) continue;
    s.ctf.carrySeconds += dt;
    const prev = store.lastCarrierPos.get(c.id);
    // ★ 逐 tick 累加实际位移。用「拔旗点到交旗点」的直线会把绕路走的
    //   30 米算成 10 米 —— 而绕路正是躲追杀的正确打法
    if (prev) s.ctf.carryDistance += distance2D(prev, c.position);
    store.lastCarrierPos.set(c.id, { ...c.position });
  }
  // 不再携旗的人清掉锚点，否则下次拔旗会补上中间那段没携旗的路程
  for (const id of [...store.lastCarrierPos.keys()]) {
    if (!carriers.some((c) => c.id === id)) store.lastCarrierPos.delete(id);
  }

  for (const e of living) {
    const s = of(store, e.id);
    if (!s) continue;

    // ── 护送旗手：在己方旗手支援距离内。★ 旗手本人不算护送自己 ──
    const escorting = carriers.some(
      (c) => c.id !== e.id && c.team === e.team
        && distance2D(c.position, e.position) <= STATS.SUPPORT_RADIUS,
    );
    if (escorting) s.ctf.escortSeconds += dt;

    // ── 基地防守：在己方旗帜附近，且有敌人也在附近 ──
    // ★ 「有敌人在附近」这个条件不能省：否则整局蹲在基地不动的人
    //   会拿到最高的防守分，而 16.4 要选的是**最佳防守者**
    const ownFlag = ctf.flags[String(e.team)];
    if (ownFlag) {
      const nearOwnFlag = distance2D(ownFlag.position, e.position) <= STATS.SUPPORT_RADIUS;
      const enemyNearOwnFlag = living.some(
        (o) => o.team !== e.team
          && distance2D(ownFlag.position, o.position) <= STATS.SUPPORT_RADIUS,
      );
      if (nearOwnFlag && enemyNearOwnFlag) s.ctf.baseDefenseSeconds += dt;
    }

    // ── 关键通道控制：处在地图声明的主路线上，且有敌人也在附近 ──
    // ★ 路线来自 MapDef.routes，不在这里硬编码坐标 ——
    //   12.5 的三条主路线是地图的属性，换图就该跟着换
    const onRoute = (map.routes ?? []).some((r) =>
      r.waypoints.some((w) => distance2D(w, e.position) <= STATS.SUPPORT_RADIUS),
    );
    if (onRoute) {
      const contested = living.some(
        (o) => o.team !== e.team
          && distance2D(o.position, e.position) <= STATS.SUPPORT_RADIUS,
      );
      if (contested) s.ctf.corridorControlSeconds += dt;
    }
  }
};

// ════════════════════════════════════════════════════════════════
//  派生指标
// ════════════════════════════════════════════════════════════════

/** 打断成功率。没有尝试过时返回 undefined 而不是 0 —— 「没打断过」不等于「成功率 0%」*/
export const interruptSuccessRate = (s: PlayerStats): number | undefined =>
  s.general.interruptsAttempted === 0
    ? undefined
    : s.general.interruptsLanded / s.general.interruptsAttempted;

/** 技能命中率。同上，没释放过时返回 undefined */
export const skillHitRate = (s: PlayerStats): number | undefined =>
  s.general.skillsAttempted === 0
    ? undefined
    : s.general.skillsLanded / s.general.skillsAttempted;

// ════════════════════════════════════════════════════════════════
//  16.4 最佳玩家
// ════════════════════════════════════════════════════════════════

/**
 * 评分维度。★ 伤害与击杀合并成**一个** `combat` 维度，这是有意的 ——
 * 16.4 禁止的正是「只按总伤害**或**击杀数」评选，把它们拆成两个维度
 * 就能用「两个维度」绕过下面的维度数下限。
 */
export const SCORE_DIMENSIONS = [
  'combat',
  'healing',
  'disruption',
  'objective',
  'supply',
  'survival',
] as const;
export type ScoreDimension = (typeof SCORE_DIMENSIONS)[number];

export interface ScorePart {
  dimension: ScoreDimension;
  /** 归一化后的表现，0~1（本局该维度最高者为 1）*/
  normalized: number;
  weight: number;
}

declare const COMPOSED: unique symbol;

/**
 * 一个合成评分。**唯一构造入口是 `composeScore()`。**
 *
 * 品牌字段 `[COMPOSED]` 只在类型层面存在（`declare const`，没有运行时值），
 * 所以手写 `{ value, parts }` 冒充一个 CompositeScore 是**类型错误**。
 */
export interface CompositeScore {
  readonly value: number;
  readonly parts: readonly ScorePart[];
  readonly [COMPOSED]: true;
}

/** 综合评分至少要由这么多个维度构成 */
export const MIN_OVERALL_DIMENSIONS = 4;
/** 任一维度的权重占比上限 */
export const MAX_DIMENSION_WEIGHT_SHARE = 0.35;

/**
 * ★★ 16.4 第二条：「**不能只按总伤害或击杀数评选最佳玩家。**」
 *
 * 这是一条否定式规则 —— 破坏它不会让任何东西报错，只会让治疗和旗手永远
 * 拿不到最佳玩家，而且要打完一局并翻到统计页才看得出来。所以不靠自觉：
 *
 *   1. `bestOverall` 的评分**必须**是 `CompositeScore`，而这个类型
 *      唯一的构造入口就是本函数；
 *   2. 本函数在维度少于 `MIN_OVERALL_DIMENSIONS` 时**抛异常**；
 *   3. 且任一维度的权重占比超过 `MAX_DIMENSION_WEIGHT_SHARE` 时**抛异常** ——
 *      光有「维度数 ≥ 4」还不够：给 combat 权重 0.97、其余三项各 0.01
 *      在形式上是四个维度，实质仍是「只按伤害评选」。
 *
 * 想把综合奖改成只看伤害，必须动这两个常量或本函数的校验 ——
 * 那是一次显眼的、`stats.test.ts` 会直接拦下的改动。
 * 与 M8 的 `hiddenAtQuality(role: DecorativeRole, ...)`、
 * M6 的 `enemyLoadoutView()` 返回类型里没有备用装备字段，是同一个思路。
 */
export const composeScore = (parts: readonly ScorePart[]): CompositeScore => {
  const dims = new Set(parts.map((p) => p.dimension));
  if (dims.size < MIN_OVERALL_DIMENSIONS) {
    throw new Error(
      `综合评分至少需要 ${MIN_OVERALL_DIMENSIONS} 个不同维度，实际 ${dims.size} 个。` +
        `16.4：不能只按总伤害或击杀数评选最佳玩家。`,
    );
  }
  const total = parts.reduce((a, p) => a + p.weight, 0);
  if (total <= 0) throw new Error('综合评分的权重之和必须为正');
  for (const p of parts) {
    if (p.weight / total > MAX_DIMENSION_WEIGHT_SHARE + 1e-9) {
      throw new Error(
        `维度 ${p.dimension} 的权重占比 ${(p.weight / total).toFixed(2)} ` +
          `超过上限 ${MAX_DIMENSION_WEIGHT_SHARE}。16.4：不能只按单一指标评选最佳玩家。`,
      );
    }
  }
  const value = parts.reduce((a, p) => a + p.normalized * p.weight, 0) / total;
  return { value, parts } as CompositeScore;
};

/** 综合奖的维度权重。总和不必为 1 —— `composeScore` 按占比归一 */
export const OVERALL_WEIGHTS: Readonly<Record<ScoreDimension, number>> = {
  combat: 0.22,
  healing: 0.18,
  disruption: 0.18,
  objective: 0.22,
  supply: 0.1,
  survival: 0.1,
};

/** 某玩家在各维度上的原始表现值（未归一化）*/
export const dimensionValuesOf = (s: PlayerStats): Record<ScoreDimension, number> => ({
  // ★ 伤害与击杀在同一个维度里，见 SCORE_DIMENSIONS 的注释
  combat: s.general.damageDone + s.general.kills * 500 + s.general.assists * 150,
  healing: s.general.healingDone + s.general.absorbProvided,
  disruption:
    s.general.interruptsLanded * 300 +
    s.general.dispels * 200 +
    s.general.controlBreaks * 200 +
    s.general.controlSecondsApplied * 50 +
    s.general.fakeCastsBaited * 150,
  objective:
    s.ctf.captures * 3000 +
    s.ctf.returns * 1200 +
    s.ctf.carrierKills * 800 +
    s.ctf.carrySeconds * 20 +
    s.ctf.escortSeconds * 15 +
    s.ctf.baseDefenseSeconds * 15 +
    s.ctf.corridorControlSeconds * 8,
  supply:
    (s.arena.weaponPickups + s.arena.armorPickups + s.arena.buffPickups) * 300 +
    s.arena.arsenalContestsWon * 200 +
    s.arena.enemyPickupsInterrupted * 300,
  // 承受伤害本身不是功劳，「扛住的伤害」才是 —— 用装备减伤与被吸收量近似
  survival: s.arena.damageReducedByEquipment + s.general.damageTaken * 0.2,
});

export const AWARDS = [
  'bestFlagCarrier',
  'bestEscort',
  'bestDefender',
  'bestHealer',
  'bestInterrupter',
  'bestSupplyFighter',
  'bestOverall',
] as const;
export type AwardId = (typeof AWARDS)[number];

export const AWARD_NAMES: Readonly<Record<AwardId, string>> = {
  bestFlagCarrier: '最佳旗手',
  bestEscort: '最佳护送者',
  bestDefender: '最佳防守者',
  bestHealer: '最佳治疗者',
  bestInterrupter: '最佳打断者',
  bestSupplyFighter: '最佳装备争夺者',
  bestOverall: '最佳综合玩家',
};

/**
 * 六个**专项**奖各按自己那一项打分 —— 「最佳打断者」当然就是按打断评。
 * 只有综合奖受 16.4 第二条约束，走 `composeScore()`。
 */
const SPECIALIST_SCORERS: Readonly<Record<Exclude<AwardId, 'bestOverall'>, (s: PlayerStats) => number>> = {
  bestFlagCarrier: (s) =>
    s.ctf.captures * 3000 + s.ctf.carrySeconds * 20 + s.ctf.carryDistance * 5,
  bestEscort: (s) =>
    s.ctf.escortSeconds * 20 + s.ctf.healingToCarrier + s.ctf.damageReducedForCarrier,
  bestDefender: (s) =>
    s.ctf.returns * 1200 + s.ctf.carrierKills * 800 + s.ctf.baseDefenseSeconds * 20,
  bestHealer: (s) => s.general.healingDone + s.general.absorbProvided,
  bestInterrupter: (s) =>
    s.general.interruptsLanded * 300 + s.general.controlSecondsApplied * 50 + s.general.dispels * 200,
  bestSupplyFighter: (s) =>
    s.arena.arsenalContestsWon * 200 + s.arena.enemyPickupsInterrupted * 300 +
    (s.arena.weaponPickups + s.arena.armorPickups + s.arena.buffPickups) * 300,
};

export interface AwardResult {
  award: AwardId;
  name: string;
  /** 无人在该维度有任何贡献时为 undefined —— 不硬塞一个 0 分的获奖者 */
  winner?: PlayerStats;
  score: number;
  /** 仅综合奖有：评分由哪些维度构成，供战后界面解释「为什么是他」*/
  parts?: readonly ScorePart[];
}

/**
 * 评选七个奖项（16.4）。
 *
 * 归一化按**本局**各维度的最高值来做 —— 绝对数值在 6v6 和 12v12 之间不可比，
 * 而奖项只在一局之内评选。
 */
export const pickAwards = (roster: readonly PlayerStats[]): AwardResult[] => {
  const out: AwardResult[] = [];

  for (const award of AWARDS) {
    if (award === 'bestOverall') continue;
    const score = SPECIALIST_SCORERS[award];
    let best: PlayerStats | undefined;
    let bestScore = 0;
    for (const s of roster) {
      const v = score(s);
      if (v > bestScore) { bestScore = v; best = s; }
    }
    out.push({
      award, name: AWARD_NAMES[award], score: bestScore,
      ...(best ? { winner: best } : {}),
    });
  }

  // ── 综合奖 ────────────────────────────────────────────────────
  const values = new Map<EntityId, Record<ScoreDimension, number>>();
  for (const s of roster) values.set(s.entityId, dimensionValuesOf(s));

  const maxOf = (d: ScoreDimension): number =>
    Math.max(0, ...[...values.values()].map((v) => v[d]));
  const maxima = Object.fromEntries(
    SCORE_DIMENSIONS.map((d) => [d, maxOf(d)]),
  ) as Record<ScoreDimension, number>;

  let bestOverall: PlayerStats | undefined;
  let bestComposite: CompositeScore | undefined;
  for (const s of roster) {
    const v = values.get(s.entityId);
    if (!v) continue;
    const parts: ScorePart[] = SCORE_DIMENSIONS.map((d) => ({
      dimension: d,
      // 该维度全场都是 0 时归一化为 0，而不是 0/0
      normalized: maxima[d] > 0 ? v[d] / maxima[d] : 0,
      weight: OVERALL_WEIGHTS[d],
    }));
    const composite = composeScore(parts);
    if (!bestComposite || composite.value > bestComposite.value) {
      bestComposite = composite;
      bestOverall = s;
    }
  }

  out.push({
    award: 'bestOverall',
    name: AWARD_NAMES.bestOverall,
    score: bestComposite?.value ?? 0,
    ...(bestOverall ? { winner: bestOverall } : {}),
    ...(bestComposite ? { parts: bestComposite.parts } : {}),
  });

  return out;
};

// ════════════════════════════════════════════════════════════════
//  16.x 战后面板的投影
// ════════════════════════════════════════════════════════════════

/**
 * 一行结算数据。字段与协议的 `MatchStatsRow` 一一对应。
 *
 * ★★ **投影写在 sim 里，不写在服务器里。** 理由与 `enemyLoadoutView()`
 *   同源：让「战后面板显示什么」只有一处定义。服务器自己挑字段的话，
 *   将来加一项统计就要在两个地方各加一次，而漏掉的那次不会报错 ——
 *   只会让新统计**在面板上静默缺席**。
 *
 * ★ 刻意**不含** `keySkillUses` / `weaponDamage` 这类 Map：
 *   它们过不了 JSON，而且是给配平看的中间量不是给玩家看的结果。
 */
export interface StatsRow {
  entityId: EntityId;
  name: string;
  team: TeamId;
  classId: ClassId;
  kills: number;
  deaths: number;
  assists: number;
  damageDone: number;
  healingDone: number;
  damageTaken: number;
  absorbProvided: number;
  interruptsLanded: number;
  crits: number;
  /** 16.3 夺旗贡献三项（W12 结算面板夺旗列）。竞技场对局恒 0，形状不变 */
  flagCaptures: number;
  flagReturns: number;
  carrierKills: number;
}

/**
 * 把一局的统计折成结算面板要的行。
 *
 * ★ 数字**取整**：16.1 要的是「玩家看得懂」，伤害显示成 1234.567 只是噪音。
 *   取整发生在投影层而不是累加层 —— 累加层保持浮点，否则每一跳都会丢精度。
 * ★ 排序按伤害降序**只是默认顺序**，面板可以自己再排。
 */
export const statsRows = (store: StatsStore): StatsRow[] =>
  [...store.players.values()]
    .map((s) => ({
      entityId: s.entityId,
      name: s.name,
      team: s.team,
      classId: s.classId,
      kills: s.general.kills,
      deaths: s.general.deaths,
      assists: s.general.assists,
      damageDone: Math.round(s.general.damageDone),
      healingDone: Math.round(s.general.healingDone),
      damageTaken: Math.round(s.general.damageTaken),
      absorbProvided: Math.round(s.general.absorbProvided),
      interruptsLanded: s.general.interruptsLanded,
      crits: s.general.crits,
      flagCaptures: s.ctf.captures,
      flagReturns: s.ctf.returns,
      carrierKills: s.ctf.carrierKills,
    }))
    .sort((a, b) => b.damageDone - a.damageDone);
