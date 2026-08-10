/**
 * 旗帜状态机与旗手限制。规格书 12.1–12.4，验收 #38–#42。
 *
 * ```
 *                 拔取 1.2s               交付 0.8s
 *   基地中 ──────► 拔取中 ──────► 携带中 ──────► 重置中 ──► 基地中
 *      ▲             │ 中断         │ 死亡/掉旗      │ 得分
 *      │             ▼             ▼               │
 *      └──── 归还中 ◄──── 掉落 ◄────┘               │
 *            0.6s          │ 敌方重新拾取           │
 *                          └────► 携带中           │
 * ```
 *
 * ★ 三条最容易做错的规则：
 *
 *   1. **12.1 / 验收 #39：己方旗帜不在基地时不能交旗。**
 *      而且 12.2 说交付「持续 0.8 秒；己方旗帜**必须持续**在基地」——
 *      所以不是开始时检查一次就完事，交付全程都要检查。
 *
 *   2. **12.3 / 验收 #40：使用完全无敌、消失或潜行时「先掉旗，再播放对应技能表现」。**
 *      顺序写反（先隐身再掉旗）会出现一帧「旗帜跟着隐形角色消失」的画面 ——
 *      那正是验收 #40 后半句「旗帜不会随角色隐藏」要防的。
 *
 *   3. **12.3 / 验收 #42：旗手断线、退出、掉出地图或进入非法区域时，
 *      旗帜落在最后合法位置；无法确定时直接回基地。**
 *      所以携带期间必须持续记录「最后一个合法位置」。
 */

import { CTF } from '../../constants/combat.js';
import { distance2D, type Vec3 } from '../../math/vec3.js';
import { FlagState } from '../../types/enums.js';
import { TEAM_BLUE, TEAM_RED, opposingTeam, type EntityId, type TeamId } from '../../types/ids.js';
import type { CombatEntity } from '../entity.js';
import { listEntities, type World } from '../world.js';

export interface Flag {
  /** 旗帜归属方。**敌方**来拔它 */
  team: TeamId;
  state: FlagState;
  /** 基地位置。重置时回到这里 */
  basePosition: Vec3;
  /** 当前位置。携带中时跟随旗手 */
  position: Vec3;
  /** 携带者。仅 Carried */
  carrierId?: EntityId;
  /** 正在拔取/归还/交付的玩家与进度结束时刻 */
  interactorId?: EntityId;
  interactEndsAt?: number;
  /** 掉落时刻，供「掉落多久自动归还」这类扩展使用 */
  droppedAt?: number;
  /**
   * ★ 12.3 / 验收 #42：携带期间持续记录的最后一个合法位置。
   * 旗手掉出地图或进入非法区域时旗帜落在这里。
   */
  lastLegalPosition: Vec3;
}

/**
 * A17：夺旗的胜负出口。**形状照 `arena.ts` 的 `RoundOutcome` 抄** ——
 * 两种模式的终局在服务器眼里应该长得一样（`MatchLoop.checkEnd` 那条
 * 三元链因此只是多认一个字段，不是多一套规则）。
 */
export type CtfOutcome = { winner: TeamId } | { winner: 'draw' } | null;

export interface CtfState {
  flags: Record<string, Flag>;
  score: Record<string, number>;
  /** 12.4：双方同时持旗的起始时刻。null 表示当前没有同时持旗 */
  bothCarryingSince: number | null;
  /** 12.4 战场聚焦层数 */
  focusStacks: number;
  /** 12.4「逐步清除」的计时起点。null 表示当前不在衰减 */
  focusDecayingSince: number | null;
  scoreToWin: number;
  /**
   * A17：常规时长（秒）。**0 表示不限时。**
   *
   * ★ 默认 0 是有意的：试验场的 CtfDemo 与一大票纯规则测试都只想验旗帜
   *   状态机，不该因为多了个字段就突然被判超时。不限时的一局只有「先到
   *   目标分」一个出口 —— 与 A17 之前的行为逐字相同。
   */
  duration: number;
  /** 开赛时刻（`world.time`）。剩余时间按 `duration - (now - startedAt)` 算 */
  startedAt: number;
  /** 12.x 突然死亡加时的进入时刻；null = 还在常规时间内 */
  overtimeSince: number | null;
  /** 胜负出口。null = 还没分出来 */
  outcome: CtfOutcome;
}

export const createCtf = (
  redBase: Vec3,
  blueBase: Vec3,
  // ★ 必须显式写 `: number`。`CTF` 是 `as const`，所以 `CTF.DEFAULT_SCORE_TO_WIN`
  //   的类型是**字面量 3** —— 只写默认值会让 TS 把整个参数推断成 `3`，
  //   于是 `createCtf(a, b, 5)` 是类型错误，12.1 的「房主可调 1~5」根本传不进来，
  //   下面那行 clamp 在有类型的调用方看来是不可达代码。
  //   （这个 bug 一直没被发现，是因为 shared 的测试文件当时不在类型检查范围内。）
  scoreToWin: number = CTF.DEFAULT_SCORE_TO_WIN,
  /**
   * A17 时限。★ 收进一个选项对象而不是继续加位置参数：这两项都是
   * 「大多数调用方不关心」的，摆成第 4、第 5 个位置参数会逼着每个只想
   * 改时长的人先把 scoreToWin 抄一遍。
   */
  opts: { duration?: number; startedAt?: number } = {},
): CtfState => ({
  flags: {
    [TEAM_RED as number]: makeFlag(TEAM_RED, redBase),
    [TEAM_BLUE as number]: makeFlag(TEAM_BLUE, blueBase),
  },
  score: { [TEAM_RED as number]: 0, [TEAM_BLUE as number]: 0 },
  bothCarryingSince: null,
  focusStacks: 0,
  focusDecayingSince: null,
  scoreToWin: Math.min(CTF.MAX_SCORE_TO_WIN, Math.max(CTF.MIN_SCORE_TO_WIN, scoreToWin)),
  duration: Math.max(0, opts.duration ?? 0),
  startedAt: opts.startedAt ?? 0,
  overtimeSince: null,
  outcome: null,
});

const makeFlag = (team: TeamId, base: Vec3): Flag => ({
  team,
  state: FlagState.AtBase,
  basePosition: { ...base },
  position: { ...base },
  lastLegalPosition: { ...base },
});

export const flagOf = (ctf: CtfState, team: TeamId): Flag => ctf.flags[String(team as number)]!;
/** 某支队伍正在抢的那面旗（即对方的旗）*/
export const enemyFlagOf = (ctf: CtfState, team: TeamId): Flag => flagOf(ctf, opposingTeam(team));

// ── 12.3 旗手限制 ────────────────────────────────────────────────

/**
 * ★ 12.3 / 验收 #40：「使用完全无敌、消失或潜行时**先掉旗，再播放对应技能表现**。」
 *
 * 这个函数必须在技能效果结算**之前**调用。顺序写反会出现一帧
 * 「旗帜跟着隐形角色一起消失」的画面 —— 那正是 #40 后半句要防的事。
 *
 * `SkillDef.dropsFlagOnUse` 在 M0 写职业数据时就已经标好了
 * （圣盾术、寒冰屏障、消失、保护祝福），这里只负责执行。
 */
export const dropFlagBeforeSkill = (
  ctf: CtfState,
  entity: CombatEntity,
  now: number,
): Flag | null => {
  if (!entity.flags.carryingFlag) return null;
  const flag = carriedFlagOf(ctf, entity.id);
  if (!flag) return null;
  dropFlag(flag, entity, now, 'skill');
  return flag;
};

/** 找出某个实体正携带的旗帜 */
export const carriedFlagOf = (ctf: CtfState, id: EntityId): Flag | undefined =>
  Object.values(ctf.flags).find((f) => f.state === FlagState.Carried && f.carrierId === id);

/**
 * 12.3：旗手移动加成存在总上限。
 * 群奔咆哮给旗手的加速最多 10%（9.8 明确写了这条）。
 */
export const clampCarrierSpeedBonus = (bonus: number, carrying: boolean): number =>
  carrying ? Math.min(bonus, CTF.FLAG_CARRIER_MAX_SPEED_BONUS) : bonus;

// ── 12.1 / 12.2 交互 ─────────────────────────────────────────────

/** 与旗帜交互的距离（米）。也是「移动打断」的判定半径 */
export const INTERACT_RANGE = 2.2;

export type FlagAction = 'pickup' | 'return' | 'capture';

export type FlagInteractResult =
  | { ok: true; action: FlagAction; endsAt: number }
  | { ok: false; reason: string };

/**
 * 开始一次旗帜交互。按目标旗帜的状态和交互者的阵营自动判断是拔旗、归还还是交旗。
 */
export const beginFlagInteract = (
  ctf: CtfState,
  entity: CombatEntity,
  flag: Flag,
  now: number,
  captureZoneContains?: (p: Vec3) => boolean,
): FlagInteractResult => {
  if (!entity.alive) return { ok: false, reason: '已死亡' };
  if (entity.flags.stunned) return { ok: false, reason: '无法行动' };
  // 12.6：复活保护不能用于直接完成拔旗或交旗
  if (entity.flags.spawnProtection) {
    return { ok: false, reason: '复活保护期间不能进行旗帜交互（12.6）' };
  }
  if (entity.isPet) return { ok: false, reason: '宠物不能与旗帜交互' };

  const isOwnFlag = (flag.team as number) === (entity.team as number);

  // ── 交旗：自己正携带敌方旗，站在己方交旗区 ──
  const carried = carriedFlagOf(ctf, entity.id);
  if (carried && captureZoneContains?.(entity.position)) {
    const own = flagOf(ctf, entity.team);
    // ★ 验收 #39：己方旗帜不在基地时无法交旗
    if (own.state !== FlagState.AtBase) {
      return { ok: false, reason: '己方旗帜不在基地，无法交旗（12.1）' };
    }
    carried.state = FlagState.BeingCaptured;
    carried.interactorId = entity.id;
    carried.interactEndsAt = now + CTF.CAPTURE_SECONDS;
    // 交付期间旗帜不再跟随（状态已离开 Carried），把交付起点显式记下来 ——
    // tick 里用它判断「交旗途中走开了」，不要依赖上一 tick 的残留值
    carried.position = { ...entity.position };
    carried.lastLegalPosition = { ...entity.position };
    return { ok: true, action: 'capture', endsAt: carried.interactEndsAt };
  }

  if (distance2D(entity.position, flag.position) > INTERACT_RANGE) {
    return { ok: false, reason: '距离太远' };
  }

  // ── 拔旗：敌方旗帜在基地 ──
  if (!isOwnFlag && flag.state === FlagState.AtBase) {
    // 12.2：只有一名玩家可成功
    if (flag.interactorId !== undefined) return { ok: false, reason: '已有其他玩家在拔旗' };
    flag.state = FlagState.BeingTaken;
    flag.interactorId = entity.id;
    flag.interactEndsAt = now + CTF.PICKUP_SECONDS;
    return { ok: true, action: 'pickup', endsAt: flag.interactEndsAt };
  }

  // ── 掉落的旗：己方归还，敌方直接重新拾取 ──
  if (flag.state === FlagState.Dropped) {
    if (isOwnFlag) {
      flag.state = FlagState.BeingReturned;
      flag.interactorId = entity.id;
      flag.interactEndsAt = now + CTF.RETURN_SECONDS;
      return { ok: true, action: 'return', endsAt: flag.interactEndsAt };
    }
    // 12.2「抢旗队伍可重新拾取」—— 无需读条，直接接手
    pickUp(flag, entity);
    return { ok: true, action: 'pickup', endsAt: now };
  }

  return { ok: false, reason: '当前无法与该旗帜交互' };
};

/** 取消交互，旗帜回到交互前的状态 */
export const cancelFlagInteract = (flag: Flag): void => {
  if (flag.state === FlagState.BeingTaken) flag.state = FlagState.AtBase;
  else if (flag.state === FlagState.BeingReturned) flag.state = FlagState.Dropped;
  else if (flag.state === FlagState.BeingCaptured) flag.state = FlagState.Carried;
  delete flag.interactorId;
  delete flag.interactEndsAt;
};

const pickUp = (flag: Flag, entity: CombatEntity): void => {
  flag.state = FlagState.Carried;
  flag.carrierId = entity.id;
  flag.position = { ...entity.position };
  flag.lastLegalPosition = { ...entity.position };
  delete flag.interactorId;
  delete flag.interactEndsAt;
  delete flag.droppedAt;
  entity.flags.carryingFlag = true;
};

export type DropReason = 'death' | 'skill' | 'disconnect' | 'illegalArea';

/**
 * 12.2 掉落。旗手死亡、主动掉旗、使用无敌/潜行技能、断线或进入非法区域时调用。
 *
 * ★ 12.3 / 验收 #42 的分档就在下面这三行：
 *   · 死亡 / 主动掉旗 —— 旗手此刻站的地方就是合法的，掉在脚下。
 *   · 断线 / 退出 / 掉出地图 / 非法区域 —— 此刻的位置**不可信**，
 *     退回携带期间持续记录的 `lastLegalPosition`。
 *   · 「无法确定时直接回基地」—— 不需要额外分支：`lastLegalPosition`
 *     在 `makeFlag()` 里就初始化成基地了，拿不到任何合法位置时它自然是基地。
 */
export const dropFlag = (
  flag: Flag,
  carrier: CombatEntity | undefined,
  now: number,
  reason: DropReason = 'skill',
): void => {
  if (flag.state !== FlagState.Carried) return;

  const trustCurrentPosition = (reason === 'death' || reason === 'skill') && carrier !== undefined;
  const dropAt = trustCurrentPosition ? carrier!.position : flag.lastLegalPosition;

  flag.position = { ...dropAt };
  flag.lastLegalPosition = { ...dropAt };
  flag.state = FlagState.Dropped;
  flag.droppedAt = now;
  delete flag.carrierId;
  if (carrier) carrier.flags.carryingFlag = false;
};

export const resetFlag = (flag: Flag): void => {
  flag.state = FlagState.AtBase;
  flag.position = { ...flag.basePosition };
  flag.lastLegalPosition = { ...flag.basePosition };
  delete flag.carrierId;
  delete flag.interactorId;
  delete flag.interactEndsAt;
  delete flag.droppedAt;
};

// ── 每 tick ──────────────────────────────────────────────────────

export interface FlagEvent {
  type: 'taken' | 'returned' | 'captured' | 'dropped' | 'interruptedInteract';
  flagTeam: TeamId;
  entityId?: EntityId;
  reason?: string;
}

export interface CtfDeps {
  world: World;
  /** 某点是否在指定队伍的交旗区内 */
  captureZoneContains: (team: TeamId, p: Vec3) => boolean;
  /** 某点是否是合法可站立位置（12.3：进入非法区域时旗帜落在最后合法位置）*/
  isLegalPosition?: (p: Vec3) => boolean;
}

/**
 * 推进旗帜状态一个 tick。
 *
 * ⚠️ 必须在 movement 与死亡结算**之后**调用 ——
 * 12.2 规定拔取/归还会被「移动或硬控制」中断，交付要求「己方旗帜持续在基地」。
 */
export const tickFlags = (
  ctf: CtfState,
  deps: CtfDeps,
  now: number,
  moveEpsilon = 0.05,
): FlagEvent[] => {
  const events: FlagEvent[] = [];

  for (const flag of Object.values(ctf.flags)) {
    // ── 携带中：跟随旗手，持续记录最后合法位置 ──
    if (flag.state === FlagState.Carried) {
      const carrier = flag.carrierId ? deps.world.entities.get(flag.carrierId) : undefined;
      if (!carrier || !carrier.alive) {
        // 实体没了 → 当断线处理（回到最后合法位置），死了 → 掉在尸体脚下
        dropFlag(flag, carrier, now, carrier ? 'death' : 'disconnect');
        events.push({
          type: 'dropped',
          flagTeam: flag.team,
          reason: carrier ? 'death' : 'disconnect',
        });
        continue;
      }
      flag.position = { ...carrier.position };
      // ★ 12.3 / 验收 #42：只有在合法位置才更新「最后合法位置」
      if (!deps.isLegalPosition || deps.isLegalPosition(carrier.position)) {
        flag.lastLegalPosition = { ...carrier.position };
      } else {
        dropFlag(flag, carrier, now, 'illegalArea');
        events.push({ type: 'dropped', flagTeam: flag.team, reason: 'illegalArea' });
      }
      continue;
    }

    // ── 交互中 ──
    if (flag.interactorId === undefined || flag.interactEndsAt === undefined) continue;
    const actor = deps.world.entities.get(flag.interactorId);

    const interrupt = (reason: string) => {
      cancelFlagInteract(flag);
      events.push({ type: 'interruptedInteract', flagTeam: flag.team, reason });
    };

    if (!actor || !actor.alive) { interrupt('death'); continue; }
    // 12.2：移动或硬控制中断
    if (actor.flags.stunned) { interrupt('stunned'); continue; }

    // 拔旗/归还锚在地上的旗，交旗锚在开始交付时站的点（beginFlagInteract 里写入）
    if (distance2D(actor.position, flag.position) > INTERACT_RANGE + moveEpsilon) {
      interrupt('moved');
      continue;
    }

    // ★ 12.2：交付「持续 0.8 秒；己方旗帜**必须持续**在基地」——
    //   全程检查，不是开始时检查一次（验收 #39）
    if (flag.state === FlagState.BeingCaptured) {
      const own = flagOf(ctf, actor.team);
      if (own.state !== FlagState.AtBase) {
        interrupt('ownFlagNotAtBase');
        continue;
      }
      if (!deps.captureZoneContains(actor.team, actor.position)) {
        interrupt('leftCaptureZone');
        continue;
      }
    }

    if (now < flag.interactEndsAt) continue;

    switch (flag.state) {
      case FlagState.BeingTaken:
        pickUp(flag, actor);
        events.push({ type: 'taken', flagTeam: flag.team, entityId: actor.id });
        break;
      case FlagState.BeingReturned:
        resetFlag(flag);
        events.push({ type: 'returned', flagTeam: flag.team, entityId: actor.id });
        break;
      case FlagState.BeingCaptured: {
        resetFlag(flag);
        actor.flags.carryingFlag = false;
        const key = String(actor.team as number);
        ctf.score[key] = (ctf.score[key] ?? 0) + 1;
        events.push({ type: 'captured', flagTeam: flag.team, entityId: actor.id });
        break;
      }
      default:
        break;
    }
  }

  updateBattlefieldFocus(ctf, now);
  // ★ A17：胜负判定放在旗帜状态机**之后** —— 本 tick 完成的那次交旗要先
  //   记进比分，否则「加时里先得分者胜」会晚一个 tick 才认账。
  resolveCtfOutcome(ctf, now);
  return events;
};

// ── A17 时限与加时 ───────────────────────────────────────────────

/**
 * 规格 6.x：「时间到比分高者胜；同分进入突然死亡加时，先得分者胜。」
 *
 * ★★ **在此之前这一整条规则没有任何一层在跑。** `CTF.DURATION`（12/15 分钟）
 *   与 `setOvertime()`（加时波次 16 秒）都是零消费方，于是双方都不碰旗的
 *   联网夺旗**没有自然终点** —— 拖延战术可以把一局拖到天荒地老，15.4 的
 *   「比赛时间」那一栏也只能空着（不画到零也不会发生任何事的倒计时，
 *   比不画更糟，附录A#7）。这个函数就是那个终点。
 *
 * ★ 判定顺序是有讲究的：**先到目标分**（12.1）优先于任何时钟判据 ——
 *   常规时间最后一秒完成第三次夺旗，赢的是他，不是「时间到比分高者」
 *   （这两者在那一刻恰好同解，但加时里不同：加时中拿到目标分与
 *   「先得分」也是同一支队伍，写成两条分支只会多一处能写错的地方）。
 */
const resolveCtfOutcome = (ctf: CtfState, now: number): void => {
  if (ctf.outcome !== null) return;      // 判过就冻住，不会被后续 tick 改写

  // ① 12.1 先到目标分者胜 —— 与时限无关，任何时刻都成立
  const byScore = ctfWinner(ctf);
  if (byScore !== null) {
    ctf.outcome = { winner: byScore };
    return;
  }
  // 不限时的一局到此为止：只有目标分这一个出口（A17 之前的行为）
  if (ctf.duration <= 0) return;

  // ② 加时（突然死亡）：进来时是平分，所以任何一次夺旗都让某方严格领先
  if (ctf.overtimeSince !== null) {
    const lead = leadingTeam(ctf);
    if (lead !== null) {
      ctf.outcome = { winner: lead };
    } else if (now - ctf.overtimeSince >= CTF.OVERTIME_HARD_CAP) {
      /**
       * ★ 硬上限兜底，理由与 `arena.ts` 的 `SUDDEN_DEATH_HARD_CAP` 逐字相同：
       *   突然死亡靠「有人得分」结束，而「双方都龟着不碰旗」恰恰是 A17 要
       *   消灭的那种局面 —— 不设上限等于把没有终点的问题原样搬进加时。
       */
      ctf.outcome = { winner: 'draw' };
    }
    return;
  }

  // ③ 常规时间到：比分高者胜；同分进加时
  if (now - ctf.startedAt < ctf.duration) return;
  const lead = leadingTeam(ctf);
  if (lead !== null) ctf.outcome = { winner: lead };
  else ctf.overtimeSince = now;
};

/** 比分严格领先的一方；平分返回 null */
const leadingTeam = (ctf: CtfState): TeamId | null => {
  const red = ctf.score[String(TEAM_RED as number)] ?? 0;
  const blue = ctf.score[String(TEAM_BLUE as number)] ?? 0;
  if (red === blue) return null;
  return red > blue ? TEAM_RED : TEAM_BLUE;
};

/** A17：是否已进入突然死亡加时。复活波次（12.6 的 16 秒）按它切换 */
export const ctfInOvertime = (ctf: CtfState): boolean => ctf.overtimeSince !== null;

/**
 * A17：**比赛剩余时间**（秒）。不限时的一局返回 `undefined` ——
 * 快照因此不会凭空多出一个永远不动的倒计时（附录A#7 的占位禁令）。
 *
 * ★ 加时里返回的是「距硬上限还剩多久」：那个零是真的会发生事情的零
 *   （判平局），所以它可以画出来。
 */
export const ctfTimeRemaining = (ctf: CtfState, now: number): number | undefined => {
  if (ctf.duration <= 0) return undefined;
  if (ctf.overtimeSince !== null) {
    return Math.max(0, CTF.OVERTIME_HARD_CAP - (now - ctf.overtimeSince));
  }
  return Math.max(0, ctf.duration - (now - ctf.startedAt));
};

// ── 12.4 战场聚焦 ────────────────────────────────────────────────

/**
 * 12.4：「同时持旗超过 60 秒后，双方旗手获得战场聚焦：
 *        每 30 秒受到伤害提高 8%、受到治疗降低 5%，最多 5 层。
 *        任意一面旗帜返回基地后停止继续叠加并**逐步清除**。」
 *
 * ★ 「逐步清除」必须按**时间**算，不能按 tick 算。
 *   写成「每 tick 掉一层」在 20Hz 下 5 层 0.25 秒就没了 —— 那是「立即清除」，
 *   不是「逐步清除」。这里取与叠加同速：每 30 秒掉一层（见 docs/10 的 Q10）。
 */
export const updateBattlefieldFocus = (ctf: CtfState, now: number): void => {
  const bothCarried = Object.values(ctf.flags).every((f) => f.state === FlagState.Carried);

  if (!bothCarried) {
    ctf.bothCarryingSince = null;
    if (ctf.focusStacks > 0) {
      // 从「不再同时持旗」的那一刻开始按 30 秒一层往下掉
      if (ctf.focusDecayingSince === null) ctf.focusDecayingSince = now;
      const lost = Math.floor((now - ctf.focusDecayingSince) / CTF.FOCUS_STACK_INTERVAL);
      if (lost > 0) {
        ctf.focusStacks = Math.max(0, ctf.focusStacks - lost);
        // 推进整数个间隔而不是设成 now —— 设成 now 会把「tick 没有正好落在
        // 间隔边界上」的那点零头一次次累积成可见的漂移
        ctf.focusDecayingSince += lost * CTF.FOCUS_STACK_INTERVAL;
      }
    } else {
      ctf.focusDecayingSince = null;
    }
    return;
  }

  ctf.focusDecayingSince = null;
  if (ctf.bothCarryingSince === null) {
    ctf.bothCarryingSince = now;
    return;
  }

  const elapsed = now - ctf.bothCarryingSince;
  if (elapsed < CTF.FOCUS_GRACE_SECONDS) return;

  const stacks = Math.min(
    CTF.FOCUS_MAX_STACKS,
    1 + Math.floor((elapsed - CTF.FOCUS_GRACE_SECONDS) / CTF.FOCUS_STACK_INTERVAL),
  );
  ctf.focusStacks = Math.max(ctf.focusStacks, stacks);
};

/** 战场聚焦对旗手的数值影响。由效果层在结算伤害/治疗时读取 */
export const focusModifiers = (stacks: number) => ({
  damageTaken: 1 + stacks * CTF.FOCUS_DAMAGE_TAKEN_PER_STACK,
  healingTaken: 1 - stacks * CTF.FOCUS_HEALING_TAKEN_PER_STACK,
});

/** 当前正在携带旗帜的所有实体 */
export const flagCarriers = (ctf: CtfState, world: World): CombatEntity[] =>
  Object.values(ctf.flags)
    .filter((f) => f.state === FlagState.Carried && f.carrierId !== undefined)
    .map((f) => world.entities.get(f.carrierId!))
    .filter((e): e is CombatEntity => e !== undefined);

// ── 12.3 断线与退出 ──────────────────────────────────────────────

/**
 * 12.3：「旗手断线、退出、掉出地图或进入非法区域时，
 *        旗帜落在最后合法位置；无法确定时直接回基地。」（验收 #42）
 */
export const onCarrierLost = (
  ctf: CtfState,
  world: World,
  entityId: EntityId,
  now: number,
): FlagEvent | null => {
  const flag = carriedFlagOf(ctf, entityId);
  if (!flag) return null;
  // 传 carrier 是为了清掉它的 carryingFlag 标志；断线时实体可能已经不在世界里了
  dropFlag(flag, world.entities.get(entityId), now, 'disconnect');
  return { type: 'dropped', flagTeam: flag.team, entityId, reason: 'disconnect' };
};

// ── 胜负 ─────────────────────────────────────────────────────────

export const ctfWinner = (ctf: CtfState): TeamId | null => {
  for (const [team, score] of Object.entries(ctf.score)) {
    if (score >= ctf.scoreToWin) return Number(team) as TeamId;
  }
  return null;
};

/** 12.2 旗帜信息对**双方**持续可见（旗手位置不受潜行影响）*/
export interface FlagView {
  team: TeamId;
  state: FlagState;
  position: Vec3;
  carrierName?: string;
}

export const flagViews = (ctf: CtfState, world: World): FlagView[] =>
  Object.values(ctf.flags).map((f) => ({
    team: f.team,
    state: f.state,
    position: f.position,
    ...(f.carrierId ? { carrierName: world.entities.get(f.carrierId)?.name } : {}),
  }));

/** 回合/比赛重置 */
export const resetCtf = (ctf: CtfState, world: World, now = 0): void => {
  for (const f of Object.values(ctf.flags)) resetFlag(f);
  for (const e of listEntities(world)) e.flags.carryingFlag = false;
  ctf.bothCarryingSince = null;
  ctf.focusStacks = 0;
  ctf.focusDecayingSince = null;
  for (const key of Object.keys(ctf.score)) ctf.score[key] = 0;
  // ★ A17：时钟与胜负也要归零，否则「再来一局」会带着上一局的终局开赛
  ctf.startedAt = now;
  ctf.overtimeSince = null;
  ctf.outcome = null;
};
