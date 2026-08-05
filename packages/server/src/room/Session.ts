/**
 * 一条 WebSocket 连接的生命周期。docs/08 §2 / §6。
 *
 * ★★ **这一层的职责边界：它是「不受信任输入」与「模拟」之间的那道门。**
 *
 *   门内（sim）可以假设一切都是合法的；门外（浏览器）可以发任意 JSON。
 *   所以本文件只做三件事，一件都不能少：
 *
 *     1. 解析 —— `parseClientMessage()`，形状与**范围**都验（codec.ts 的 ★★）
 *     2. 阶段鉴权 —— 战斗中发 `SelectClass` 该被拒绝（codec.ts 明说这是调用方的活）
 *     3. 排队 —— 输入进队列，由 tick **按自己的节奏**消费，不是收到就算
 *
 *   ★ 第 3 条是权威性的实现方式：客户端发得再快也不会让模拟跑得更快。
 *     docs/08 §1「客户端输入每渲染帧发送，服务器按 tick 消费」。
 *
 * ★★ **拒绝不等于掉线。**（protocol.ts 的原话）
 *   畸形包、越权请求、不合法目标都只回一条 `Rejected` ——
 *   一个坏包不该拖垮整个房间。`verify:m10` 的第 6 条会真的发一条不存在的
 *   消息类型，断言服务器回 `Rejected` 而连接**仍然活着**。
 *   所以本文件里**没有任何一处**因为消息内容而 `close()`。
 */

import {
  encodeServerMessage,
  parseClientMessage,
  takeInputsForTick,
  type ClientMessage,
  type EntityId,
  type InputMessage,
  type ServerMessage,
} from '@wowpvp/shared';

import { log } from '../log.js';

/**
 * 入站消息限流（技术债总账 S1）。
 * ★ 参数由 RoomServer 注入（最终来自 `LIMITS`/ServerOptions）——
 *   Session 不 import 默认值，测试压小阈值时走的仍是同一条判定路径。
 */
export interface RateLimitConfig {
  /** 桶容量（突发额度，条） */
  capacity: number;
  /** 每秒回填（条/秒）。必须显著高于合法客户端稳态流量（见 LIMITS 注释） */
  refillPerSec: number;
  /** 累计丢弃达到这么多条后断开连接 */
  disconnectAfterDropped: number;
}

/** 连接当前处于哪个阶段。决定哪些消息合法 */
export const SessionPhase = {
  /** 刚连上，还没进房间 */
  Lobby: 'lobby',
  /** 在房间里，比赛没开始 */
  Room: 'room',
  /** 比赛进行中 */
  Match: 'match',
} as const;
export type SessionPhase = (typeof SessionPhase)[keyof typeof SessionPhase];

/**
 * 只在**房间阶段**合法的消息 —— 比赛开始后再发就是越权。
 *
 * ★ 用白名单而不是「在 Match 阶段 if 掉几个」：加一条新的房间消息时，
 *   忘了登记的后果是「它在战斗中也能发」，而那是个安全问题。
 *   忘了加进白名单只会让它在房间里发不出去 —— 一个会被立刻发现的 bug。
 */
const ROOM_ONLY: ReadonlySet<ClientMessage['t']> = new Set([
  'SelectTeam', 'SelectClass', 'SetReady',
  // ★ W12：换模式只在房间阶段有意义（sim 的 started 守卫是第二道防线，
  //   但纵深防御不该只剩一层 —— A8 的教训，新消息登记时就把门装上）
  'SetRoomMode',
]);

/**
 * 只在**战斗阶段**合法的消息。
 * ⚠️ M16 加 `OpenArmory`/`ChooseArsenal` 时漏登记了两条 —— 当时靠下游
 *   `enqueue()` 的「比赛未进行」兜住，但那正是本白名单存在的理由：
 *   纵深防御不该只剩一层（技术债总账 A8）。
 */
const MATCH_ONLY: ReadonlySet<ClientMessage['t']> = new Set([
  'Input', 'SetTarget', 'TabTarget', 'CastRequest', 'CancelCast', 'UseTrinket',
  'InteractStart', 'InteractCancel', 'SwapWeapon', 'SwapArmor', 'UseConsumable',
  'OpenArmory', 'ChooseArsenal',
  'SpectateFollow',
]);

/** 本层需要的 socket 能力。★ 只要这几样 —— 便于测试注入假 socket */
export interface SessionSocket {
  send: (data: string) => void;
  close: () => void;
  /**
   * 立即掐断（不走关闭握手）。滥用断开用它 —— `close()` 的优雅关闭
   * 要等对端配合，而 flooder 不配合。没有提供时退回 `close()`。
   */
  terminate?: () => void;
  readonly closed: boolean;
  /** 人机的假 socket 标 true（BotSocket）。广播路径据此跳过白做的活（P2）*/
  readonly isBot?: boolean;
}

export class Session {
  /** 玩家 id。连接建立时就分配，重连时会被换成原来那个 */
  playerId: string;
  phase: SessionPhase = SessionPhase.Lobby;
  /** 所在房间。未加入时为 undefined */
  roomId?: string;
  /**
   * 11.4 死亡观战正在跟随谁。合法性由 RoomServer 用 `spectatableFor()` 校验过。
   * ★ 只在**自己已死**时生效 —— 活着的人跟随别人就是透视。
   */
  following?: EntityId;

  /**
   * 本 tick 还没消费的移动输入。
   *
   * ★★ **协议契约：客户端每个服务器 tick 发送恰好一条 `Input`（固定指令帧）。**
   *
   *   `tickWorld` 每个实体每 tick 只积分**一次**，步长固定为 `SIM.TICK_DT`。
   *   如果客户端按渲染帧发（60fps → 一个 tick 三条），服务器又只能积一次，
   *   两端就会有**亚 tick 级**的轨迹偏差 —— 而 docs/08 §5 第 6 步的
   *   预测重放正是靠「两端跑同一份 movement」才成立的。
   *
   *   三种解法里选了**固定指令帧**，理由是服务器开销最小且收敛是精确的：
   *
   *   | 方案 | 服务器开销 | 收敛 |
   *   |---|---|---|
   *   | tick 内多次子步积分 | 每人每 tick 最多 5 次 stepMovement | 精确，但要改 sim |
   *   | 合成一条等效输入 | 1 次 | **不精确** —— 加速度下「一大步」≠「三小步」|
   *   | **固定指令帧（选用）** | **1 次** | **精确** —— 两端同一步长、同一份代码 |
   *
   *   客户端在渲染帧上采样输入，累加成 50ms 的指令帧发出，并用**同样的
   *   `TICK_DT`** 做预测积分；渲染平滑由插值负责，不由积分步长负责。
   *   代价是输入被量化到 50ms —— 对目标制战斗可接受，docs/08 §1 本来就写了
   *   「目标制战斗不需要 60Hz」。这条契约由 A5 的 `Predictor` 履约。
   *
   * ★ 仍然用**队列**而不是单个字段，是为了 `ackSeq`：客户端偶尔跑快发了两条时，
   *   ack 必须推进到其中最大的那个，否则它会以为丢包并反复重放已被采纳的输入。
   *   上限与「丢最旧的」策略由 `takeInputsForTick()` 管（见 codec.ts）。
   */
  private inputQueue: InputMessage[] = [];

  /**
   * 已确认到第几号输入。快照里回给客户端做预测纠正（docs/08 §5 第 3 步）。
   * ★ 单调不减：乱序到达的旧包不该把它推回去。
   */
  ackSeq = 0;

  /** S1 令牌桶状态。`rate` 未注入（纯单测）或人机会话时整个跳过 */
  private tokens = 0;
  private lastRefillMs = 0;
  /** 被限流丢弃的消息数（日志与断开判据用） */
  droppedByRate = 0;

  constructor(
    readonly socket: SessionSocket,
    playerId: string,
    /** 收到一条**已鉴权**的消息。协议分发由 RoomServer 负责，本层只管门禁 */
    private readonly onMessage: (session: Session, msg: ClientMessage) => void,
    /** S1 入站限流参数。不传 = 不限（既有单测与人机会话） */
    private readonly rate?: RateLimitConfig,
  ) {
    this.playerId = playerId;
    this.tokens = rate?.capacity ?? 0;
    this.lastRefillMs = Date.now();
  }

  send(msg: ServerMessage): void {
    if (this.socket.closed) return;
    this.socket.send(encodeServerMessage(msg));
  }

  /** 这条会话是不是人机（BotSocket）。快照/统计广播据此跳过或共享编码 */
  get isBot(): boolean {
    return this.socket.isBot === true;
  }

  /**
   * 发一条**已编码**的消息。广播路径用 —— 同一条消息对 N 个接收者
   * 只 `JSON.stringify` 一次（技术债总账 P5），单发路径仍走 `send()`。
   */
  sendRaw(data: string): void {
    if (this.socket.closed) return;
    this.socket.send(data);
  }

  /** 拒绝一条消息。★ 不掉线 —— 见文件头 */
  reject(what: string, reason: string): void {
    this.send({ t: 'Rejected', what, reason });
  }

  /**
   * 收到一帧原始数据。**这是唯一的入口**。
   *
   * ⚠️ 任何路径都不得抛异常 —— 一条畸形包不该让 `ws` 的 message 处理器炸掉，
   *    那会连带整条连接。所以解析用返回值报错，鉴权失败也只是 `reject()`。
   */
  handleRaw(raw: string): void {
    /**
     * S1 限流：**在解析之前**。被限的消息连 JSON.parse 都不配拿到 ——
     * 限流防的正是「每条都要花服务器 CPU」这件事，先解析再限等于白防。
     *
     * ★ 丢弃是**静默**的（不回 Rejected）：给每条超速消息回一条拒绝，
     *   等于把 1000 条/s 的入站放大成 1000 条/s 的出站 —— 回复比丢弃贵。
     *   「拒绝不等于掉线」那条纪律管的是**内容**非法（单条畸形包）；
     *   量的滥用没有那条豁免：持续灌注直接断开，日志留证。
     * ★ 人机会话（BotSocket）跳过：它们是服务器自己造的流量，节奏由
     *   BotDriver 决定（≈25 条/s，贴着回填速率），限它只会引入抖动。
     */
    if (this.rate && this.socket.isBot !== true) {
      const now = Date.now();
      this.tokens = Math.min(
        this.rate.capacity,
        this.tokens + ((now - this.lastRefillMs) / 1000) * this.rate.refillPerSec,
      );
      this.lastRefillMs = now;
      if (this.tokens < 1) {
        this.droppedByRate++;
        if (this.droppedByRate === 1) {
          log('warn', 'rate_limited', { playerId: this.playerId, roomId: this.roomId });
        }
        // ★ 恰好到阈值那一条才断开+记日志：terminate 之后在途消息仍会
        //   到达几条，用 >= 会把同一件事记几十遍
        if (this.droppedByRate === this.rate.disconnectAfterDropped) {
          log('warn', 'rate_flood_disconnect', {
            playerId: this.playerId, roomId: this.roomId, dropped: this.droppedByRate,
          });
          (this.socket.terminate ?? this.socket.close)();
        }
        return;
      }
      this.tokens -= 1;
    }

    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      this.reject('parse', parsed.reason);
      return;
    }
    const msg = parsed.msg;

    if (!this.isAllowedInPhase(msg.t)) {
      // ★ 只说「现在不能发这个」，不说服务器内部状态（codec.ts 的 reason 约束）
      this.reject(msg.t, `当前阶段（${this.phase}）不接受这条消息`);
      return;
    }

    // 移动输入不进分发，直接排队 —— 它由 tick 消费，不是「事件」
    if (msg.t === 'Input') {
      this.inputQueue.push(msg);
      return;
    }

    this.onMessage(this, msg);
  }

  private isAllowedInPhase(kind: ClientMessage['t']): boolean {
    if (ROOM_ONLY.has(kind)) return this.phase === SessionPhase.Room;
    if (MATCH_ONLY.has(kind)) return this.phase === SessionPhase.Match;
    // JoinRoom / Reconnect / LeaveMatch 任何阶段都可以发
    return true;
  }

  /**
   * 取走本 tick 要消费的输入。
   *
   * ★ 上限与「丢最旧的」策略都在 `takeInputsForTick()` 里 ——
   *   那是协议层的规则（防「攒一堆输入一次性发」），不是传输层的，
   *   所以不在这里重写一遍。
   */
  takeInputs(): InputMessage[] {
    const taken = takeInputsForTick(this.inputQueue);
    for (const i of taken) {
      if (i.seq > this.ackSeq) this.ackSeq = i.seq;
    }
    return taken;
  }

  /** 断线时清空未消费的输入 —— 重连后不该把 90 秒前的意图补上 */
  clearInputs(): void {
    this.inputQueue = [];
  }
}
