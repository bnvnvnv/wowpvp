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
  type InputMessage,
  type ServerMessage,
} from '@wowpvp/shared';

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
]);

/** 只在**战斗阶段**合法的消息 */
const MATCH_ONLY: ReadonlySet<ClientMessage['t']> = new Set([
  'Input', 'SetTarget', 'TabTarget', 'CastRequest', 'CancelCast', 'UseTrinket',
  'InteractStart', 'InteractCancel', 'SwapWeapon', 'SwapArmor', 'UseConsumable',
  'SpectateFollow',
]);

/** 本层需要的 socket 能力。★ 只要这三样 —— 便于测试注入假 socket */
export interface SessionSocket {
  send: (data: string) => void;
  close: () => void;
  readonly closed: boolean;
}

export class Session {
  /** 玩家 id。连接建立时就分配，重连时会被换成原来那个 */
  playerId: string;
  phase: SessionPhase = SessionPhase.Lobby;
  /** 所在房间。未加入时为 undefined */
  roomId?: string;

  /**
   * 本 tick 还没消费的移动输入。
   *
   * ★ 用队列而不是「只留最新一条」，是为了**确认序号**：60fps 的客户端在一个
   *   20Hz 的 tick 里会发三条，`ackSeq` 必须推进到其中最大的那个，
   *   否则客户端会以为前两条丢了，反复重放已经被服务器采纳的输入。
   *   上限与「丢最旧的」策略由 `takeInputsForTick()` 管（见 codec.ts）。
   *
   * ⚠️ **但这一 tick 的移动只会用其中最新那条的方向。**
   *   `tickWorld` 每个实体每 tick 只积分**一次**（固定 `SIM.TICK_DT`），
   *   没有「一个 tick 内走三个子步」的入口。所以高帧率客户端预测出来的
   *   轨迹与服务器判定会有**亚 tick 级**的偏差 —— 这是 A5「预测与纠正」
   *   要正面处理的问题（docs/08 §5 第 6 步的重放用的正是各自的 dt），
   *   不是这里能糊过去的。**没有在这里假装它不存在。**
   */
  private inputQueue: InputMessage[] = [];

  /**
   * 已确认到第几号输入。快照里回给客户端做预测纠正（docs/08 §5 第 3 步）。
   * ★ 单调不减：乱序到达的旧包不该把它推回去。
   */
  ackSeq = 0;

  constructor(
    readonly socket: SessionSocket,
    playerId: string,
    /** 收到一条**已鉴权**的消息。协议分发由 RoomServer 负责，本层只管门禁 */
    private readonly onMessage: (session: Session, msg: ClientMessage) => void,
  ) {
    this.playerId = playerId;
  }

  send(msg: ServerMessage): void {
    if (this.socket.closed) return;
    this.socket.send(encodeServerMessage(msg));
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
