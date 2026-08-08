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
  ArenaPreset, ArsenalChoice, CastFailure, CastKind, FlagState, GameMode,
  InterruptSource, School,
} from '../types/enums.js';
import type { ClassId, EntityId, MapId, SkillId, TeamId } from '../types/ids.js';
import type { Vec3 } from '../math/vec3.js';
import type { ArsenalOption } from '../sim/arsenal.js';
import type {
  AllyEquipmentSnapshot, ArmorySnapshot, DropSnapshot, EnemyEquipmentSnapshot,
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

/**
 * 一次交互的目标。见 `ClientMessage` 里 `InteractStart` 的注释。
 *
 * ★ 三种交互物在**数据上就不同构**：旗帜按距离找（它不是实体，没有 id）、
 *   掉落物与军械箱各有自己的编号空间。用联合而不是一个 number，
 *   「把 dropId 当 armoryId 用」就成了类型错误而不是运行时的谜之失败。
 */
export type InteractTarget =
  /** 12.x 拔旗/交旗。★ 没有 id —— 服务器按 2.2 米交互距离找那面旗 */
  | { kind: 'flag' }
  /** 10.5 拾取地面掉落物 */
  | { kind: 'drop'; dropId: number };

export type ClientMessage =
  // ── 房间阶段 ──
  | { t: 'JoinRoom'; roomId: string; name: string }
  | { t: 'SelectTeam'; team: 'red' | 'blue' | 'spectator' }
  | { t: 'SelectClass'; classId: ClassId; appearance?: string }
  | { t: 'SetReady'; ready: boolean }
  /**
   * 10.1 切换规则预设（经典 / 武装）。**只有房主、只在开赛前。**
   *
   * ★ 加这条消息的理由是可达性而不是功能：默认预设是经典竞技场，
   *   而经典竞技场按验收 #28 不生成任何临时武装 —— 没有这个开关，
   *   第 10 章的全部规则在真实对局里一次都不会发生。
   */
  | { t: 'SetRoomPreset'; preset: ArenaPreset }
  /**
   * W12 切换游戏模式（竞技场 2/3/5 ↔ 夺旗 6/8/12）。**只有房主、只在开赛前。**
   *
   * ★ 与 `SetRoomPreset` 的存在理由完全同构：房间默认 `arena3v3`，
   *   没有这条消息，M7 交付的整个夺旗模式在联网对局里**不可达**。
   *   服务器换模式时连带换地图与人数档（sim 的 `setMode()`，校验在那边）。
   */
  | { t: 'SetRoomMode'; mode: GameMode }
  /** docs/14 §16b 人机补位开关。**只有房主、只在开赛前**，默认关 */
  | { t: 'SetFillWithBots'; enabled: boolean }
  /** P5（P1c）：补位人机难度。同上：只有房主、只在开赛前，默认 normal */
  | { t: 'SetRoomBotDifficulty'; difficulty: 'easy' | 'normal' | 'hard' }
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
  /**
   * 开始一次交互。
   *
   * ★★ **目标是一个可辨识联合，不是一个身兼两职的 id。**
   *   此前这条消息只带 `entityId: EntityId`，而旗帜**不是实体**（没有 EntityId）、
   *   掉落物用的是自己的 `dropId` —— 同一个字段实际在表达三种东西，
   *   `MatchLoop.beginInteract` 的注释把这个坑原样记着（「没有假装它是干净的」）。
   *   接客户端时必须消歧：玩家按同一个键，可能是拔旗、捡装备或开军械箱，
   *   而服务器不该靠「先试旗帜再试掉落」的顺序去猜他想干什么
   *   —— 猜错的表现是「站在旗边捡不起脚下的装备」。
   */
  | { t: 'InteractStart'; target: InteractTarget }
  | { t: 'InteractCancel' }
  | { t: 'SwapWeapon'; slot: number }
  | { t: 'SwapArmor'; slot: number }
  | { t: 'UseConsumable'; slot: number }
  /** 10.4 打开中立军械箱。服务器私信回一条 `ArsenalOffer` */
  | { t: 'OpenArmory'; armoryId: number }
  /** 10.4 从自己打开的军械箱里领走三选一之一 */
  | { t: 'ChooseArsenal'; armoryId: number; choice: ArsenalChoice }

  // ── 观战（11.4：只能跟随己方存活玩家）──
  | { t: 'SpectateFollow'; entityId: EntityId };

export type ClientMessageKind = ClientMessage['t'];

/**
 * 全部客户端消息种类。★ 手工维护，但 `protocol.test.ts` 有一条穷尽性断言
 * 强制它与 `ClientMessage` 联合同步 —— 与 `ALL_EFFECT_KINDS` 同一个手法。
 */
export const ALL_CLIENT_MESSAGE_KINDS: readonly ClientMessageKind[] = [
  'JoinRoom', 'SelectTeam', 'SelectClass', 'SetReady', 'SetRoomPreset',
  'SetRoomMode', 'SetFillWithBots', 'SetRoomBotDifficulty', 'LeaveMatch', 'Reconnect',
  'Input', 'SetTarget', 'TabTarget', 'CastRequest', 'CancelCast', 'UseTrinket',
  'InteractStart', 'InteractCancel', 'SwapWeapon', 'SwapArmor', 'UseConsumable',
  'OpenArmory', 'ChooseArsenal',
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

/**
 * 结算面板的一行。16.1 的通用统计取「玩家看得懂、能据此改进」的那几项。
 *
 * ★ **不是把 `PlayerStats` 整个序列化**。那里面有 `keySkillUses: Map`、
 *   `weaponDamage: Map` 这类不能直接过 JSON 的结构，也有一堆只对配平
 *   有意义的中间量 —— 战后面板要的是「我这局打得怎么样」，
 *   把 40 个字段甩给玩家等于什么都没说（与 15.3 装备对比「只输出差异」同源）。
 */
export interface MatchStatsRow {
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
  /** 偏差 #7 的暴击次数。16a 的结算面板要展示它 */
  crits: number;
  /**
   * 16.3 夺旗贡献三项（W12 —— 结算面板的夺旗列）。
   * ★ 竞技场对局里恒为 0，字段仍然在：面板按模式决定**显不显示**，
   *   协议不按模式变形状（与 `MatchSnapshot.flags` 用可选字段表达模式
   *   不同 —— 统计在赛后下发，全 0 不构成泄露，形状稳定让消费端更简单）。
   */
  flagCaptures: number;
  flagReturns: number;
  /** 击杀敌方旗手的次数 */
  carrierKills: number;
}

/** 16.4 的一项最佳玩家。`winnerId` 为空表示本局无人在该维度有贡献 */
export interface AwardView {
  award: string;
  name: string;
  winnerId?: EntityId;
  winnerName?: string;
  /** 仅综合奖有：评分由哪些维度构成，供面板解释「为什么是他」*/
  parts?: readonly { dimension: string; share: number }[];
}

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
  /** 10.2 地面掉落物（`pickable` 按接收者算，不带实体引用）*/
  drops: readonly DropSnapshot[];
  /** 10.4 军械点与倒计时（不带 openedBy）*/
  armories: readonly ArmorySnapshot[];
  match: MatchSnapshot;
}

export type ServerMessage =
  // ── 房间与对局 ──
  | { t: 'Welcome'; playerId: string; tickRate: number; interpDelay: number }
  | { t: 'RoomState'; players: readonly RoomPlayerView[]; mode: GameMode
      preset: ArenaPreset; mapId: MapId; started: boolean
      /**
       * 房主。3.1 的房间设置只有他能改（当前是 10.1 的规则预设）。
       * ★ 客户端拿它只为**显示**能不能点 —— 权限判定在服务器的 `setPreset()`，
       *   把按钮画成可点也改不了别人的房间。
       */
      hostId: string
      /** P5：人机补位与难度 —— 大厅要画出当前状态（此前 UI 连开关都没有）*/
      fillWithBots: boolean
      botDifficulty: 'easy' | 'normal' | 'hard' }
  | { t: 'MatchStart'; mapId: MapId; you: EntityId; startsAt: number
      /** 17.3 重连令牌。★ 断线后凭它恢复，见 server/room/reconnect.ts */
      reconnectToken: string }
  | SnapshotMessage
  /**
   * P11：装备视图的独立通道 —— 装备**不再每 tick 进快照**（基本静态的
   * 153B/实体被 20Hz 重发曾是快照第二大字节项）。服务器在发快照**之前**
   * 按「该接收者视角下的视图指纹变了」才发这条（含首见），客户端按
   * entityId 缓存并在 hydrate 时合回实体。
   * ★ 裁剪语义原样：items 里只有**该接收者本份快照可见**的实体，敌人是
   *   `EnemyEquipmentSnapshot`（无备用槽位，10.6 / 验收 #36）——
   *   `verify:m10` 第 2 条现在盯的就是这条消息流。
   * ★ 不走 dispatch() 广播 —— 与 Snapshot 同为按接收者构建的私信。
   */
  | { t: 'EntityLoadouts'
      items: readonly { entityId: EntityId
        equipment: AllyEquipmentSnapshot | EnemyEquipmentSnapshot }[] }

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
      /**
       * W17：这一发被完全规避的方式（8.x 闪避/招架/格挡）。amount 恒为 0。
       * ★ 规避是**被攻击者**的信息，对攻击者可见是 8.x 既有语义，无泄露争议。
       */
      avoided?: 'dodge' | 'parry' | 'block'
      /**
       * X3：造成伤害的技能 id（死亡回顾显示真名，此前只有 school）。
       * ★★ **可空且随 sourceId 一起被抹**（S7 口径）：`rogue.rupture` 这类
       *   id 直接说出攻击者职业 —— 来源不可见时它和 sourceId 同样是泄露面，
       *   `redactFor` 抹 sourceId 时连它一起抹。来源可见时才带。
       */
      skillId?: SkillId
      /** 暴击（已知偏差 #7）。★ 服务器→客户端方向，见 FORBIDDEN_CLIENT_FIELDS 注释 */
      crit?: boolean }
  /** `sourceId` 可空，理由同 Damage */
  | { t: 'Heal'; sourceId?: EntityId; targetId: EntityId; amount: number; overheal: number
      /** 治疗暴击，语义同 Damage.crit */
      crit?: boolean }
  /**
   * ★ S7：`sourceId` 可空且**可被抹**。光环 id（`rogue.rupture`）泄露施加者
   *   职业，与 Damage.skillId 同题：施加者对接收者不可见时，`redactFor` 把
   *   `sourceId` 抹掉、`auraId` 掩成中性 token（`HIDDEN_AURA_ID`），
   *   目标身上「有个 debuff」照常显示，但不说是谁的什么。来源可见才带真 id。
   */
  | { t: 'AuraApplied'; targetId: EntityId; sourceId?: EntityId; auraId: string
      duration: number; stacks: number }
  | { t: 'AuraRemoved'; targetId: EntityId; auraId: string
      // ★ 'trinket'：8.3 战斗意志解除（W8）。闭集扩项是**加法**改动，零泄露面
      reason: 'expired' | 'dispelled' | 'broken' | 'cancelled' | 'shieldBroken' | 'trinket' }
  | { t: 'Death'; entityId: EntityId; killerId?: EntityId }
  /**
   * 10.4：军械箱被打开后的三个横向选择。
   *
   * ★★ **这是私信，不是广播。** 原文是「只向**打开者**显示其职业的三个
   *   横向选择」—— 广播出去等于告诉对手「他刚拿到了进攻套」，
   *   而 10.6 明确规定敌人**看不到备用装备**。与 `CastFailed` 同一条理由。
   */
  | { t: 'ArsenalOffer'; armoryId: number; options: readonly ArsenalOption[] }
  /**
   * 10.5「多人同时拾取只允许第一个完成者成功；其他人收到**明确失败反馈**」+
   * 10.2「交互时提示『职业不匹配』」。
   *
   * ★ 成功也发：拾取是一个 0.8 秒的过程，没有结果消息的话客户端只能靠
   *   「掉落物从快照里消失了」去猜，而那在「被别人抢走」时会猜成「我拿到了」。
   */
  | { t: 'PickupResult'; dropId: number; ok: boolean; reason?: string }
  | { t: 'FlagEvent'; flagTeam: TeamId; state: FlagState; carrierId?: EntityId; position?: Vec3 }
  | { t: 'RoundEnd'; winner: TeamId | 'draw'; round: number }
  | { t: 'MatchEnd'; winner: TeamId | 'draw' }
  /**
   * 16.x 战后统计与 16.4 的七项最佳玩家。
   *
   * ★★ **在此之前 `sim/stats.ts` 算好的东西没有任何出口** —— 全仓库
   *   grep 不到 `pickAwards` 的网络层调用方，联网局的 `MatchEnd` 只有
   *   一行「红方获胜」。统计跑了整整一局，然后随房间一起被丢掉。
   *
   * ★ 在**对局结束后**下发，所以不存在泄露问题：这时候没有什么还需要瞒着谁
   *   （潜行者也已经不在场上了）。这是它能带完整名单的唯一依据。
   */
  | { t: 'MatchStats'; rows: readonly MatchStatsRow[]; awards: readonly AwardView[] }

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
  'Welcome', 'RoomState', 'MatchStart', 'Snapshot', 'EntityLoadouts',
  'CastStarted', 'CastResolved', 'CastInterrupted', 'CastFailed', 'Damage', 'Heal',
  'AuraApplied', 'AuraRemoved', 'Death', 'ArsenalOffer', 'PickupResult',
  'FlagEvent', 'RoundEnd', 'MatchEnd', 'MatchStats',
  'Rejected', 'PeerDisconnected', 'PeerReconnected', 'PeerEliminated',
];
