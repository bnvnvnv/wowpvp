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
import { FFA } from '../../constants/combat.js';
import { TEAM_BLUE, TEAM_RED, type ClassId, type MapId, type TeamId } from '../../types/ids.js';
import { getClass, isPlayableClass } from '../../data/index.js';
import { MAP_BY_ID, mapsForMode } from '../../data/maps/index.js';
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
  /**
   * P5（P1c）：补位人机的难度档。只影响 `fillBotSeats` 建出来的席位；
   * 掉线接管固定 normal（见 `setBotDifficulty` 的注释）。
   * ★ 可选字段 —— 老房间对象/老测试夹具没有它时按 'normal' 读。
   */
  botDifficulty?: 'easy' | 'normal' | 'hard';
  /**
   * 地图里随机刷新中立大 BOSS（玩家需求）。规则见 `sim/boss.ts`。
   *
   * ★★ **默认关**，理由与 `fillWithBots` 逐字相同：它会改变**开局之后
   *   世界里有几个实体**，而 M1–M16 的两百多项验收全部建立在
   *   「场上就这么几个人」这个前提上（`verify:m10` 数实体、`verify:m16`
   *   按职业找掉落物…）。默认开等于用「更好玩」换掉整张回归网。
   * ★ 可选字段 —— 老房间对象/老测试夹具没有它时按 false 读。
   */
  bossEnabled?: boolean;
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
  /**
   * ★★ 判据是 `isPlayableClass` 而不是 `getClass` —— 注册表里现在还有
   *   **玩家选不到**的特殊职业（大 BOSS，见 `data/index.ts` 的 SPECIAL_CLASSES）。
   *   用「查得到就放行」的话，一条手写的 `SelectClass{classId:'boss'}` 就能
   *   让人顶着 15000 生命开局 —— 协议是不受信任输入，客户端点不出来不算门。
   */
  if (!isPlayableClass(classId)) return { ok: false, reason: `未知职业：${classId}` };

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
 * W12：切换游戏模式（竞技场 2/3/5 ↔ 夺旗 6/8/12）。房主专属，开赛前。
 *
 * ★★ **没有这条路径的话，整个第 12 章在联网对局里是不可达的** ——
 *   房间默认 `arena3v3`，而夺旗的全部规则（M7 交付、验收 #38–#43 全绿）
 *   只有试验场那条单机路径能触发。与 `setPreset` 的存在理由完全同构：
 *   「规则全对、单测全绿、真实对局里一次都不会发生」。
 *
 * ★ **换模式连带换地图与人数档**：`mapId` 换成该模式的首张可用地图
 *   （地图注册表按模式声明，`mapsForMode` 是唯一权威 —— 这里不写
 *   `'ctf_twin_bridges'` 这种字面量，DEFAULT_CONFIG 那个「拿模式名当
 *   地图 id」的坑注释里有尸体）。
 * ★★ **P5 选图之后多一句：当前这张图若仍适配新档位就留着，不适配才回落。**
 *   四张主题图各覆盖一段人数档区间（密林祭坛吃 3v3–5v5），房主挑好了图
 *   再拖一格人数滑杆就被打回试炼环的话，「选图」这件事在 UI 上等于没做完
 *   —— 而回落本身不能省：6v6 用一张只支持到 5v5 的图会让开局直接失败
 *   （`beginMatch` 先查地图，出生点不够就是一局打不起来的房间）。
 *   ★ 判据走 `mapsForMode(mode)` 这唯一权威，**按 id 比**不按下标取
 *     （m5 #24：地图/规格查找一律按 id）。
 * ★ **缩小人数档时若有队伍超编，拒绝而不是悄悄踢人**：把谁挪去观战席
 *   是房主该亲手做的决定，静默降席的表现是「我明明选了红方怎么在观战」。
 * ★ **换模式后全员取消准备**：已按下的「准备」是对上一个模式的同意，
 *   6v6 夺旗和 2v2 竞技场不是同一场比赛（与 `resetForRematch` 的
 *   「重新同意」同一条理由）。
 */
export const setMode = (room: Room, playerId: string, mode: GameMode): SelectResult => {
  if (room.started) return { ok: false, reason: '比赛已开始，不能更换模式' };
  if (room.hostId !== playerId) return { ok: false, reason: '只有房主能更改模式' };

  const options = mapsForMode(mode);
  const fallback = options[0];
  if (!fallback) return { ok: false, reason: `模式 ${mode} 没有可用地图` };

  const size = teamSizeOf(mode);
  for (const slot of [Slot.Red, Slot.Blue] as const) {
    const n = playersOn(room, slot).length;
    if (n > size) {
      return {
        ok: false,
        reason: `${slot === Slot.Red ? '红方' : '蓝方'}已有 ${n} 人，超过该模式每队上限 ${size} 人 —— 先把多余的玩家移到观战席`,
      };
    }
  }

  const keepsCurrent = options.some((m) => m.id === room.config.mapId);
  room.config.mode = mode;
  room.config.mapId = keepsCurrent ? room.config.mapId : fallback.id;
  for (const p of room.players) p.ready = false;
  return { ok: true };
};

/**
 * P5：在**当前模式适配的地图**之间换一张。房主专属，开赛前 —— 与 `setMode` 同款守卫。
 *
 * ★★ **这条路径的存在理由是可达性**（与 `setPreset` / `setMode` / `setBossEnabled`
 *   逐字同源）：P5 交付的四张主题图在 `ALL_MAPS` 里排在试炼环之后，而
 *   `setMode` 取的是 `mapsForMode(mode)[0]` —— 没有这条消息，四张图数据全对、
 *   机检全绿、**玩家一张都进不去**。本仓库栽过五次的那个坑，这是第六次的防线。
 *
 * ★ 三道判定的顺序有语义：
 *     1. **存在** —— 查不到就说「地图不存在」（不受信任输入可以是任意字符串）
 *     2. **适配当前模式** —— 判据是 `mapsForMode(room.config.mode)` 这唯一权威，
 *        **按 id 比对**而不是按下标取（★ m5 #24）
 *     3. 通过才写 `room.config.mapId`
 *   ⚠️ **不合法一律诚实拒绝，绝不「顺手换成一张能用的」** —— 静默改的表现是
 *      「我明明选了熔岩裂谷，开局却在试炼环」，而玩家只会以为是随机的。
 *      降档时该回落的那一次在 `setMode` 里做，那里改的是**模式**，玩家知道自己动了什么。
 * ★ 不取消准备（与 `setMode` 不同）：换图不改变「打什么、几个人」，
 *   已经准备的人不必重新同意一次 —— 房主换张地形而已。
 */
export const setMap = (room: Room, playerId: string, mapId: MapId): SelectResult => {
  if (room.started) return { ok: false, reason: '比赛已开始，不能更换地图' };
  if (room.hostId !== playerId) return { ok: false, reason: '只有房主能更改地图' };

  const map = MAP_BY_ID.get(mapId as string);
  if (!map) return { ok: false, reason: `地图不存在：${mapId}` };
  if (!mapsForMode(room.config.mode).some((m) => m.id === map.id)) {
    return { ok: false, reason: `${map.name} 不适配当前模式（${room.config.mode}）` };
  }

  room.config.mapId = map.id;
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
 * P5（P1c 落地）：人机难度。房主专属，开赛前 —— 与 `setFillWithBots` 同款守卫。
 * ★ 只作用于**补位**的人机；掉线接管固定 normal（拍板过的语义：接管是替真人
 *   打，不该因为房间开了 easy 就替真人演一个木桩）。
 */
export const setBotDifficulty = (
  room: Room,
  playerId: string,
  difficulty: 'easy' | 'normal' | 'hard',
): SelectResult => {
  if (room.started) return { ok: false, reason: '比赛已开始，不能更改人机难度' };
  if (room.hostId !== playerId) return { ok: false, reason: '只有房主能更改人机难度' };
  room.config.botDifficulty = difficulty;
  return { ok: true };
};

/**
 * 开关「随机刷新大 BOSS」。房主专属，开赛前 —— 与 `setFillWithBots` 同款守卫。
 *
 * ★★ **这个开关的存在理由是可达性，不是功能**（与 `setPreset` 的文件注释同源）：
 *   没有它，`sim/boss.ts` 的全部规则就是又一批「写对了、单测全绿、真实对局里
 *   一次都不会发生」的代码 —— 本仓库已经栽过五次的那个坑。
 *
 * ⚠️ **掉落跟着 10.1 的规则预设走**：BOSS 的战利品复用军械箱那套
 *   `spawnDropsFromRoster()`，而经典竞技场按验收 #28 不生成任何临时武装。
 *   所以经典预设下开 BOSS = 有 BOSS、有积分、**没有装备掉落**。
 *   这里**不**强制预设（不替房主做决定），但客户端的开关旁写明了这一条。
 */
export const setBossEnabled = (
  room: Room,
  playerId: string,
  enabled: boolean,
): SelectResult => {
  if (room.started) return { ok: false, reason: '比赛已开始，不能更改 BOSS 设置' };
  if (room.hostId !== playerId) return { ok: false, reason: '只有房主能更改 BOSS 设置' };
  room.config.bossEnabled = enabled;
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
  /**
   * P12 大乱斗：补到 FFA.FILL_TARGET 名参战者，不是补到 100 人上限 ——
   * 100 个 bot 的房间是自己 DoS 自己（一房 ≈ 100 实体全速模拟），
   * 20 人混战已经是「随时有架打」的密度。真人多于目标值就不补。
   */
  if (room.config.mode === GameMode.Ffa) {
    const combatants = playersOn(room, Slot.Red).length + playersOn(room, Slot.Blue).length;
    const count = Math.max(0, FFA.FILL_TARGET - combatants);
    return count > 0 ? [{ slot: Slot.Red, count }] : [];
  }
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

  /**
   * ★ P5：开了人机补位后，人数类检查交给补位去满足 ——
   *   `fillBotSeats` 会把每队补到满编，「双方至少一人」「人数相等」
   *   在开局那一刻必然成立。此前 canStart 不认识补位，于是**单人房间
   *   永远开不了局**（红 1 蓝 0 被两条人数规则拦死），docs/14 §16b 的
   *   补位实际只能救「两边都有人但不满编」的场子 —— 单人练习这个
   *   最常见的用途反而不可达。
   *   仍要求至少一名玩家在队伍里：全观战 + 纯人机的空局没有触发
   *   「全员准备」的主体，也没有观众以外的任何人在玩。
   */
  const fill = room.config.fillWithBots === true;
  /**
   * P12 大乱斗：没有「双方」—— 全员互为敌人（独立阵营在 createMatch 分配）。
   * 判据只剩人数：不补位要 ≥2（一个人的大乱斗没有对手），补位 ≥1。
   * 人数相等那条对 FFA 无意义，一并跳过。
   */
  if (room.config.mode === GameMode.Ffa) {
    const combatants = red.length + blue.length;
    if (combatants < (fill ? 1 : 2)) {
      reasons.push(fill ? '至少需要一名玩家参战' : '大乱斗至少需要两名玩家（或开人机补位）');
    }
  } else if (!fill) {
    if (red.length === 0 || blue.length === 0) reasons.push('双方都需要至少一名玩家');
  } else if (red.length + blue.length === 0) {
    reasons.push('至少需要一名玩家加入队伍');
  }

  for (const p of [...red, ...blue]) {
    if (!p.classId) reasons.push(`${p.name} 尚未选择职业`);
    else if (!p.ready) reasons.push(`${p.name} 尚未准备`);
  }

  // 3.2：标准竞技场要求双方人数相等（补位开着时由补位保证，见上）。
  // P12 大乱斗没有「双方」，人数相等无从谈起 —— 整条跳过
  const isFfa = room.config.mode === GameMode.Ffa;
  const balanced = isFfa || red.length === blue.length;
  if (!balanced && !room.config.allowUnbalanced && !fill) {
    reasons.push(`双方人数不等（${red.length} vs ${blue.length}），标准规则要求人数相等`);
  }

  return { ok: reasons.length === 0, reasons, nonStandard: !balanced && !fill };
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
