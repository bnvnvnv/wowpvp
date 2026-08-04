/**
 * 房间、队伍与职业选择。规格书 3.1 / 3.2 / 11.5，验收 #22。
 *
 * ★ 3.2 是一条**否定式**规则，最容易被「顺手加个限制」破坏：
 *     「不限制同职业数量；全队选择相同职业也允许开始。」
 *     「不强制治疗、坦克、近战、远程或辅助比例。」
 *     「系统可以显示『缺少治疗』『近战较多』等非强制提示，但**不得阻止准备**。」
 *
 *   所以本模块把「提示」和「阻止」彻底分开：`compositionHints()` 只返回文字，
 *   `canStart()` 根本不看它。想加阵容限制就必须改 canStart，而那会被测试拦下。
 */

import { ArenaPreset, GameMode } from '../../types/enums.js';
import { TEAM_BLUE, TEAM_RED, type ClassId, type MapId, type TeamId } from '../../types/ids.js';
import { getClass } from '../../data/index.js';
import { teamSizeOf } from './arena.js';

export const Slot = {
  Red: 'red',
  Blue: 'blue',
  /** 3.1 观战席 */
  Spectator: 'spectator',
} as const;
export type Slot = (typeof Slot)[keyof typeof Slot];

export interface RoomPlayer {
  id: string;
  name: string;
  slot: Slot;
  classId?: ClassId;
  ready: boolean;
  /** 11.5 断线状态。断线角色停留原地并可被攻击，不获得无敌 */
  connected: boolean;
}

export interface RoomConfig {
  mode: GameMode;
  mapId: MapId;
  /** 10.1 规则预设 */
  preset: ArenaPreset;
  roundsToWin: number;
  /** 3.2 自定义房间可开启人数不平衡，但**必须明确标记为非标准规则** */
  allowUnbalanced: boolean;
  /**
   * 人数不足时用人机补满（docs/14 §16b）。
   *
   * ★★ **默认关**，而且这不是保守起见 —— 打开它会改变**开局时世界里有几个
   *   实体**，而 M1–M15 的两百多项验收全部建立在「场上就这么几个人」
   *   这个初始条件上（`verify:m10` 数实体、`verify:m13` 断言名单、
   *   `verify:m16` 按职业找掉落物…）。默认开等于用「更好玩」换掉整张回归网。
   *   ★ 与试验场「实战模式默认关」是同一条教训，PROGRESS 里记着为什么。
   */
  fillWithBots: boolean;
}

export interface Room {
  id: string;
  config: RoomConfig;
  players: RoomPlayer[];
  hostId: string;
  started: boolean;
}

export const createRoom = (id: string, hostId: string, config: RoomConfig): Room => ({
  id,
  config,
  players: [],
  hostId,
  started: false,
});

const teamOf = (slot: Slot): TeamId | null =>
  slot === Slot.Red ? TEAM_RED : slot === Slot.Blue ? TEAM_BLUE : null;

export const playersOn = (room: Room, slot: Slot): RoomPlayer[] =>
  room.players.filter((p) => p.slot === slot);

// ── 3.1 房间流程 ─────────────────────────────────────────────────

export const joinRoom = (room: Room, id: string, name: string): RoomPlayer => {
  const existing = room.players.find((p) => p.id === id);
  if (existing) {
    existing.connected = true;
    return existing;
  }
  const p: RoomPlayer = { id, name, slot: Slot.Spectator, ready: false, connected: true };
  room.players.push(p);
  return p;
};

export type SelectResult = { ok: true } | { ok: false; reason: string };

export const selectSlot = (room: Room, playerId: string, slot: Slot): SelectResult => {
  // 3.1 第 7 步：比赛开始后职业锁定
  if (room.started) return { ok: false, reason: '比赛已开始，不能更换阵营' };
  const p = room.players.find((x) => x.id === playerId);
  if (!p) return { ok: false, reason: '玩家不在房间中' };

  if (slot !== Slot.Spectator) {
    const size = teamSizeOf(room.config.mode);
    if (playersOn(room, slot).filter((x) => x.id !== playerId).length >= size) {
      return { ok: false, reason: `该队已满（${size} 人）` };
    }
  }
  p.slot = slot;
  p.ready = false; // 换阵营后要重新准备
  return { ok: true };
};

/**
 * 3.2：**不限制同职业数量**。这个函数刻意没有任何职业相关的检查 ——
 * 唯一的失败原因是「这个职业不存在」。
 */
export const selectClass = (room: Room, playerId: string, classId: ClassId): SelectResult => {
  if (room.started) return { ok: false, reason: '比赛已开始，职业已锁定' };
  const p = room.players.find((x) => x.id === playerId);
  if (!p) return { ok: false, reason: '玩家不在房间中' };
  if (!getClass(classId)) return { ok: false, reason: `未知职业：${classId}` };

  p.classId = classId;
  return { ok: true };
};

/**
 * 10.1：在经典竞技场与武装竞技场之间切换。
 *
 * ★★ **没有这条路径的话，整个第 10 章在真实对局里是不可达的。**
 *   房间默认 `ArenaPreset.Classic`，而验收 #28 要求经典竞技场
 *   **不生成任何临时武装** —— 于是军械箱、掉落、换装、消耗品全部
 *   规则正确、单测全绿、玩家永远看不到。这与 PROGRESS 记的 B4
 *   （护盾做完了却没有任何路径能触发）是同一种缺陷。
 *
 * ★ 只有房主能改，且只在开赛前 —— 与 `selectSlot` 的「开赛后锁定」同一条线。
 */
export const setPreset = (
  room: Room,
  playerId: string,
  preset: ArenaPreset,
): SelectResult => {
  if (room.started) return { ok: false, reason: '比赛已开始，不能更换规则预设' };
  if (room.hostId !== playerId) return { ok: false, reason: '只有房主能更改规则预设' };
  room.config.preset = preset;
  return { ok: true };
};

/**
 * docs/14 §16b：开关「人数不足用人机补满」。房主专属，开赛前。
 * ★ 与 `setPreset` 同一条线：只有房主、只在开赛前，校验写在 sim 里。
 */
export const setFillWithBots = (
  room: Room,
  playerId: string,
  enabled: boolean,
): SelectResult => {
  if (room.started) return { ok: false, reason: '比赛已开始，不能更改人机补位' };
  if (room.hostId !== playerId) return { ok: false, reason: '只有房主能更改人机补位' };
  room.config.fillWithBots = enabled;
  return { ok: true };
};

/**
 * 人机要补几个：每队缺多少补多少（3.1 的队伍容量由模式决定）。
 *
 * ★ 返回**名单**而不是直接建人机 —— 与 `takeExpired()` 只产出待淘汰名单
 *   同一个手法：这个模块拿不到 World，也就编不出「顺手给人机一点优势」
 *   那类代码。真正的接管发生在服务器。
 */
export const botSeatsNeeded = (room: Room): { slot: Slot; count: number }[] => {
  if (!room.config.fillWithBots) return [];
  const size = teamSizeOf(room.config.mode);
  return ([Slot.Red, Slot.Blue] as const)
    .map((slot) => ({ slot, count: Math.max(0, size - playersOn(room, slot).length) }))
    .filter((x) => x.count > 0);
};

export const setReady = (room: Room, playerId: string, ready: boolean): SelectResult => {
  const p = room.players.find((x) => x.id === playerId);
  if (!p) return { ok: false, reason: '玩家不在房间中' };
  /**
   * ★ A8（技术债总账）：它此前是唯一没有 `started` 守卫的房间变更函数 ——
   *   靠「观战席不需要准备」间接兜住（比赛期间还留在 Room 阶段的只有观战席）。
   *   兜得住不等于该裸奔：与 selectSlot/selectClass 的锁同规矩，显式挡。
   */
  if (room.started) return { ok: false, reason: '对局进行中不能更改准备状态' };
  if (p.slot === Slot.Spectator) return { ok: false, reason: '观战席不需要准备' };
  if (ready && !p.classId) return { ok: false, reason: '请先选择职业' };
  p.ready = ready;
  return { ok: true };
};

// ── 3.2 阵容提示（只提示，不阻止）────────────────────────────────

export interface CompositionHint {
  team: TeamId;
  /** 提示文本 */
  text: string;
  /** ★ 恒为 false —— 3.2：不得阻止准备 */
  blocking: false;
}

/**
 * 3.2：「系统可以显示『缺少治疗』『近战较多』等非强制提示，但不得阻止准备。」
 *
 * ★ `blocking` 恒为 false 且类型就写死成 `false` ——
 *   想让某条提示变成阻塞条件，得先改这个类型，改了会被 room.test.ts 拦下。
 */
export const compositionHints = (room: Room): CompositionHint[] => {
  const hints: CompositionHint[] = [];

  for (const slot of [Slot.Red, Slot.Blue] as const) {
    const team = teamOf(slot)!;
    const classes = playersOn(room, slot)
      .map((p) => (p.classId ? getClass(p.classId) : undefined))
      .filter((c): c is NonNullable<typeof c> => c !== undefined);
    if (classes.length === 0) continue;

    const healers = classes.filter((c) =>
      ['priest', 'paladin', 'druid'].includes(c.id as string),
    ).length;
    const melee = classes.filter((c) =>
      ['warrior', 'paladin', 'deathknight', 'rogue'].includes(c.id as string),
    ).length;

    if (healers === 0) hints.push({ team, text: '缺少治疗', blocking: false });
    if (melee > classes.length * 0.7 && classes.length >= 3) {
      hints.push({ team, text: '近战较多', blocking: false });
    }
    const unique = new Set(classes.map((c) => c.id as string));
    if (unique.size === 1 && classes.length > 1) {
      hints.push({ team, text: `全队同为${classes[0]!.name}`, blocking: false });
    }
  }
  return hints;
};

// ── 开始条件 ─────────────────────────────────────────────────────

export interface StartCheck {
  ok: boolean;
  reasons: string[];
  /** 3.2：人数不平衡时必须**明确标记为非标准规则** */
  nonStandard: boolean;
}

/**
 * 能否开始比赛。
 *
 * ★ 这里**只检查客观条件**：每人都选了职业、都点了准备、人数符合规则。
 *   绝不检查阵容 —— 3.2 明确禁止（验收 #22）。
 */
export const canStart = (room: Room): StartCheck => {
  const reasons: string[] = [];
  const red = playersOn(room, Slot.Red);
  const blue = playersOn(room, Slot.Blue);

  if (red.length === 0 || blue.length === 0) reasons.push('双方都需要至少一名玩家');

  for (const p of [...red, ...blue]) {
    if (!p.classId) reasons.push(`${p.name} 尚未选择职业`);
    else if (!p.ready) reasons.push(`${p.name} 尚未准备`);
  }

  // 3.2：标准竞技场要求双方人数相等
  const balanced = red.length === blue.length;
  if (!balanced && !room.config.allowUnbalanced) {
    reasons.push(`双方人数不等（${red.length} vs ${blue.length}），标准规则要求人数相等`);
  }

  return { ok: reasons.length === 0, reasons, nonStandard: !balanced };
};

export const startMatch = (room: Room): SelectResult => {
  const check = canStart(room);
  if (!check.ok) return { ok: false, reason: check.reasons[0]! };
  room.started = true;
  return { ok: true };
};

/**
 * 对局结束后把房间放回「可再开一局」的状态（M13 大厅，docs/14 §M13）。
 *
 * ★ 在此之前 `started` 一经置 true 就永不复位 —— 3.1 的「比赛开始后职业锁定」
 *   因此在赛后仍然生效，房间等于一次性的。复位是它的唯一出口，
 *   规则放在这里而不是服务器里，与本文件头的理由相同：
 *   服务器只做传输，房间状态怎么变必须有测试盯着。
 *
 * 三条语义，每条都有对应测试：
 *   · 解锁 —— started=false，选阵营/选职业重新可用（3.1 的锁只锁比赛期间）
 *   · 全员取消准备 —— 再开一局必须是全体**重新**同意，不能沿用上一局的 ready
 *   · 剔除已断线者 —— 掉线超时/主动退出的人不会回到这条连接上，
 *     留着只会永远堵住 canStart（一个永不准备的名额）。他们想回来
 *     走的是全新的 JoinRoom，不是这份名单
 *
 * ★ 阵营与职业**保留** —— 「再来一局」的常见语义就是原班人马原阵容，
 *   想换的人在房间页里换（此刻已解锁）。
 */
export const resetForRematch = (room: Room): void => {
  room.started = false;
  room.players = room.players.filter((p) => p.connected);
  for (const p of room.players) p.ready = false;
};

// ── 11.5 断线与退出 ──────────────────────────────────────────────

/**
 * 11.5：「战斗中断线的角色停留原地并可被攻击，**不获得无敌**。」
 *
 * 房间层只记录连接状态；角色继续留在模拟里由 MatchLoop 负责 ——
 * 这正是「断线不提供无敌」的实现方式：**什么都不做**。
 */
export const markDisconnected = (room: Room, playerId: string): void => {
  const p = room.players.find((x) => x.id === playerId);
  if (p) p.connected = false;
};

export const markReconnected = (room: Room, playerId: string): boolean => {
  const p = room.players.find((x) => x.id === playerId);
  if (!p) return false;
  p.connected = true;
  return true;
};

/**
 * 11.5：「主动退出立即按淘汰处理，不能通过退出规避死亡统计。」
 *
 * 所以退出**不**把玩家从 players 里删掉 —— 删掉就没法记他的死亡了。
 * 只标记为断线，由比赛层按淘汰结算。
 */
export const leaveMatch = (room: Room, playerId: string): void => {
  if (room.started) {
    markDisconnected(room, playerId);
    return;
  }
  room.players = room.players.filter((p) => p.id !== playerId);
};
