/**
 * 网络协议的**类型定义**。docs/08 §3。
 *
 * ★ 本文件只有类型，没有编解码 —— 编解码在 `codec.ts`。
 *   docs/08 §7 要求这两件事分成两个文件，为将来从 JSON 换成二进制留路径：
 *   「切换时**协议语义不变**，只换编码层」。混在一起的话，换编码就得改语义定义。
 *
 * ★★ **本文件最重要的一条约束：客户端发不出「结果」。**
 *
 *   docs/08 §2：「客户端**永远不发送**『我造成了 X 伤害』这类结果，只发送意图
 *   （`CastRequest`、`MoveInput`）。」
 *
 *   这是一条否定式规则 —— 破坏它不会让任何东西报错，只会让某个玩家发现
 *   「改一行前端就能打出任意伤害」。所以做法不是靠自觉：
 *   `ClientMessage` 联合里**只有意图**，而 `protocol.test.ts` 遍历这个联合的
 *   全部成员，断言没有任何成员带 `damage` / `amount` / `health` / `kills` 这类
 *   结果字段名。加一个就会红。
 */

import type {
  ArenaPreset, CastFailure, CastKind, FlagState, GameMode, InterruptSource, School,
} from '../types/enums.js';
import type { ClassId, EntityId, MapId, SkillId, TeamId } from '../types/ids.js';
import type { Vec3 } from '../math/vec3.js';
import type {
  EntitySnapshot, GroundAreaSnapshot, MatchSnapshot, ProjectileSnapshot,
} from './visibility.js';

// ════════════════════════════════════════════════════════════════
//  输入范围约束
// ════════════════════════════════════════════════════════════════

/**
 * 客户端输入的合法区间。**这些不是防御性编程，是反作弊边界。**
 *
 * 消息来自不受信任的浏览器，可以是任意 JSON。两个真实的作弊向量：
 *   · `move.forward = 999` → 若不钳制就是速度外挂
 *   · `dt = 100` → 若不拒绝就是瞬移外挂（一帧走 700 米）
 *
 * `verify:m10` 会各试一次，断言被拒绝或钳制。
 */
export const INPUT_LIMITS = {
  /** 移动轴的绝对值上限。8.1：后退 65%、侧移 100%，都由服务器按轴向算，客户端只给意图 */
  AXIS_ABS_MAX: 1,
  /**
   * 单条输入允许的最大 dt，秒。
   *
   * 取 0.25（= 5 个服务器 tick）：允许客户端在 4 FPS 的极端卡顿下仍不丢输入，
   * 但一次最多推进 1.75 米，远不足以穿过任何一面墙。
   * ★ 上限不能取「一个 tick」—— 那会让低帧率玩家的输入被静默丢弃，
   *   而丢输入的表现是「角色偶尔不动」，比作弊更难查。
   */
  DT_MAX: 0.25,
  /** 单条输入的最小 dt。0 或负值会让移动系统除零 / 倒退 */
  DT_MIN: 0,
  /** 一个 tick 内允许处理的最大输入条数，防「攒一堆输入一次性发」加速 */
  INPUTS_PER_TICK_MAX: 5,
} as const;

// ════════════════════════════════════════════════════════════════
//  客户端 → 服务器：**只有意图**
// ════════════════════════════════════════════════════════════════

/** 每渲染帧发送的移动意图。★ 只有意图，没有结果位置 —— 位置由服务器算 */
export interface InputMessage {
  t: 'Input';
  /** 单调递增。服务器在快照里回 ackSeq 告诉客户端「已确认到第几号」 */
  seq: number;
  /** 本条输入覆盖的时长，秒。会被 INPUT_LIMITS 校验 */
  dt: number;
  /** -1..1，会被钳制 */
  forward: number;
  strafe: number;
  /** ★ **角色**朝向，不是镜头朝向（6.5：镜头方向不能替代角色面向）*/
  characterYaw: number;
  jump: boolean;
}

export type ClientMessage =
  // ── 房间阶段 ──
  | { t: 'JoinRoom'; roomId: string; name: string }
  | { t: 'SelectTeam'; team: 'red' | 'blue' | 'spectator' }
  | { t: 'SelectClass'; classId: ClassId; appearance?: string }
  | { t: 'SetReady'; ready: boolean }
  /** 11.5 主动退出。★ 立即按淘汰处理，不能通过退出规避死亡统计 */
  | { t: 'LeaveMatch' }
  /** 17.3 重连：带上服务器给的令牌 */
  | { t: 'Reconnect'; token: string }

  // ── 战斗阶段 ──
  | InputMessage
  /** ★ 服务器要校验目标在**该客户端的可见集合**里（验收 #5）*/
  | { t: 'SetTarget'; slot: 'hard' | 'focus'; entityId: EntityId | null }
  | { t: 'TabTarget'; reverse: boolean }
  /** groundPoint 仅地面技能需要；facing 仅方向技能需要 */
  | { t: 'CastRequest'; skillId: SkillId; targetId?: EntityId; groundPoint?: Vec3; facing?: number }
  /** 7.5 假读条：主动取消 */
  | { t: 'CancelCast' }
  /** 8.3 通用解控 */
  | { t: 'UseTrinket' }

  // ── 交互与装备 ──
  | { t: 'InteractStart'; entityId: EntityId }
  | { t: 'InteractCancel' }
  | { t: 'SwapWeapon'; slot: number }
  | { t: 'SwapArmor'; slot: number }
  | { t: 'UseConsumable'; slot: number }

  // ── 观战（11.4：只能跟随己方存活玩家）──
  | { t: 'SpectateFollow'; entityId: EntityId };

export type ClientMessageKind = ClientMessage['t'];

/**
 * 全部客户端消息种类。★ 手工维护，但 `protocol.test.ts` 有一条穷尽性断言
 * 强制它与 `ClientMessage` 联合同步 —— 与 `ALL_EFFECT_KINDS` 同一个手法。
 */
export const ALL_CLIENT_MESSAGE_KINDS: readonly ClientMessageKind[] = [
  'JoinRoom', 'SelectTeam', 'SelectClass', 'SetReady', 'LeaveMatch', 'Reconnect',
  'Input', 'SetTarget', 'TabTarget', 'CastRequest', 'CancelCast', 'UseTrinket',
  'InteractStart', 'InteractCancel', 'SwapWeapon', 'SwapArmor', 'UseConsumable',
  'SpectateFollow',
];

/**
 * ★★ 禁止出现在任何客户端消息里的字段名。
 *
 * docs/08 §2 的「客户端永远不发送结果」落成一份可测的黑名单。
 * `protocol.test.ts` 会扫描本文件的源码，任何客户端消息里出现这些字段就红。
 *
 * 为什么用**字段名黑名单**而不是靠 review：结果字段是会「顺手加」的 ——
 * 「客户端已经算过一遍了，把结果带上来能省一次服务器计算」这个念头很自然，
 * 而它就是作弊入口。黑名单让这个念头在 CI 里撞墙。
 *
 * ⚠️ **`'crit'` 留在这张表里是有意的。** 服务器现在会**下发** crit
 *   （见下面 Damage/Heal 消息），但客户端永远不许**上报**它。
 *   这张表管的是**客户端**消息 —— `protocol.test.ts` 的扫描窗口是
 *   `InputMessage` → `ClientMessageKind`，服务器段落根本不在窗口里，
 *   加服务器字段不会误伤，删这一行才会出事。
 */
export const FORBIDDEN_CLIENT_FIELDS: readonly string[] = [
  'damage', 'amount', 'health', 'maxHealth', 'kills', 'deaths', 'hit', 'crit',
  'absorbed', 'healing', 'score', 'position', 'velocity', 'cooldowns', 'auras',
];

// ════════════════════════════════════════════════════════════════
//  服务器 → 客户端
// ════════════════════════════════════════════════════════════════

export interface RoomPlayerView {
  id: string;
  name: string;
  team: 'red' | 'blue' | 'spectator';
  classId?: ClassId;
  ready: boolean;
  /** 11.5：断线的人**仍然留在名单里**（死亡统计需要他）*/
  connected: boolean;
}

/**
 * 快照消息。
 *
 * ★ `entities` 已经过**按接收者裁剪**（`buildSnapshot(deps, viewer)`）——
 *   未被发现的潜行者根本不在这个数组里，不是带个隐藏标记。见 `visibility.ts`。
 */
export interface SnapshotMessage {
  t: 'Snapshot';
  tick: number;
  /** 服务器时间，秒。客户端用它对齐插值缓冲 */
  time: number;
  /** 已确认到第几号输入（docs/08 §5 第 4 步）*/
  ackSeq: number;
  you: EntityId;
  entities: readonly EntitySnapshot[];
  /** 14.4 投射物主体（不带实体引用，见 visibility.ts 的类型注释）*/
  projectiles: readonly ProjectileSnapshot[];
  /** 14.3 地面区域边界（只含 areas，永不含 traps）*/
  grounds: readonly GroundAreaSnapshot[];
  match: MatchSnapshot;
}

export type ServerMessage =
  // ── 房间与对局 ──
  | { t: 'Welcome'; playerId: string; tickRate: number; interpDelay: number }
  | { t: 'RoomState'; players: readonly RoomPlayerView[]; mode: GameMode
      preset: ArenaPreset; mapId: MapId; started: boolean }
  | { t: 'MatchStart'; mapId: MapId; you: EntityId; startsAt: number
      /** 17.3 重连令牌。★ 断线后凭它恢复，见 server/room/reconnect.ts */
      reconnectToken: string }
  | SnapshotMessage

  // ── 事件流：驱动表现与统计，**不参与状态重建**（docs/08 §3.3）──
  | { t: 'CastStarted'; casterId: EntityId; skillId: SkillId; duration: number
      interruptible: boolean; school: School; castKind: CastKind }
  /**
   * 施法完成（14.1「释放」+ 14.2 弹体的驱动信号）。
   * ★ `casterId` 可空、`targetIds` 按接收者裁剪 —— 与 `Damage.sourceId` 同理：
   *   看不见施法者就没有释放 pop 和弹体起点（不泄露位置），
   *   但**可见目标**身上的到位表现照常（14.1）。
   */
  | { t: 'CastResolved'; casterId?: EntityId; skillId: SkillId
      targetIds: readonly EntityId[] }
  | { t: 'CastInterrupted'; casterId: EntityId; source: InterruptSource
      schoolLock?: { school: School; until: number } }
  | { t: 'CastFailed'; skillId: SkillId; reason: CastFailure }
  /**
   * ★★ `sourceId` 可空：**被看不见的人打了一下，仍然要收到伤害数字**。
   *
   *   14.1 要求有命中反馈，而 docs/08 §4 要求未被发现的潜行者「对该客户端
   *   根本不存在」。两条同时成立的唯一写法就是**发伤害但抹掉来源** ——
   *   整条不发会让玩家莫名掉血（违反 14.1），带上来源则泄露了实体存在
   *   （违反验收 #5，而且 verify:m10 第 1 条验的是「不出现在传输字节里」）。
   */
  | { t: 'Damage'; sourceId?: EntityId; targetId: EntityId; amount: number; school: School
      absorbed: number; immune: boolean
      /**
       * 超出目标剩余生命的部分。>0 即表示**这一发就是致命一击** ——
       * 表现层据此把击杀反馈挂在伤害那一帧，而不是等下一条 Death 消息。
       * ★ 不泄露任何东西：紧随其后必然有一条公开的 Death。
       */
      overkill: number
      /** 暴击（已知偏差 #7）。★ 服务器→客户端方向，见 FORBIDDEN_CLIENT_FIELDS 注释 */
      crit?: boolean }
  /** `sourceId` 可空，理由同 Damage */
  | { t: 'Heal'; sourceId?: EntityId; targetId: EntityId; amount: number; overheal: number
      /** 治疗暴击，语义同 Damage.crit */
      crit?: boolean }
  | { t: 'AuraApplied'; targetId: EntityId; auraId: string; duration: number; stacks: number }
  | { t: 'AuraRemoved'; targetId: EntityId; auraId: string
      reason: 'expired' | 'dispelled' | 'broken' | 'cancelled' | 'shieldBroken' }
  | { t: 'Death'; entityId: EntityId; killerId?: EntityId }
  | { t: 'FlagEvent'; flagTeam: TeamId; state: FlagState; carrierId?: EntityId; position?: Vec3 }
  | { t: 'RoundEnd'; winner: TeamId | 'draw'; round: number }
  | { t: 'MatchEnd'; winner: TeamId | 'draw' }

  // ── 反馈与错误 ──
  /**
   * 一条客户端消息被拒绝。
   *
   * ★ **拒绝不等于掉线。** 畸形包、越权请求、不合法目标都只回这条 ——
   *   一个坏包不该拖垮整个房间（`verify:m10` 会发一条不存在的消息类型验这一点）。
   */
  | { t: 'Rejected'; what: string; reason: string }
  /** 11.5 断线宽限期倒计时，供 HUD 显示「队友掉线中（还剩 42 秒）」 */
  | { t: 'PeerDisconnected'; playerId: string; graceRemaining: number }
  | { t: 'PeerReconnected'; playerId: string }
  /** 超时按淘汰处理（11.5）*/
  | { t: 'PeerEliminated'; playerId: string; reason: 'timeout' | 'left' };

export type ServerMessageKind = ServerMessage['t'];

export const ALL_SERVER_MESSAGE_KINDS: readonly ServerMessageKind[] = [
  'Welcome', 'RoomState', 'MatchStart', 'Snapshot',
  'CastStarted', 'CastResolved', 'CastInterrupted', 'CastFailed', 'Damage', 'Heal',
  'AuraApplied', 'AuraRemoved', 'Death', 'FlagEvent', 'RoundEnd', 'MatchEnd',
  'Rejected', 'PeerDisconnected', 'PeerReconnected', 'PeerEliminated',
];
