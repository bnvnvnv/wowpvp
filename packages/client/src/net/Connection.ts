/**
 * 与服务器的 WebSocket 连接，以及断线重连。docs/08 §1 / §6。
 *
 * ★ 本文件只管**传输**：连上、收发、断了再连。它不认识任何游戏规则 ——
 *   消息含义由 `NetworkScene` 解释，协议形状由 `shared/net/protocol.ts` 定义。
 *
 * ★★ **重连令牌是在 `MatchStart` 里拿到的，不是断线时。**
 *   断线那一刻连接已经没了，服务器发不出任何东西。所以这里收到
 *   `MatchStart` 就把令牌存下来，重连时用它换回原来的角色
 *   （docs/08 §6：「下发完整快照，客户端丢弃所有本地状态」）。
 */

import {
  decodeServerMessage,
  encodeClientMessage,
  type ClientMessage,
  type ServerMessage,
} from '@wowpvp/shared';

/** 重连退避，毫秒。★ 不做无限快速重试 —— 那只会把刚恢复的服务器再打垮 */
const RECONNECT_BACKOFF_MS = [250, 500, 1000, 2000, 4000] as const;

export interface ConnectionHandlers {
  onMessage: (msg: ServerMessage) => void;
  /** 连接建立（含重连成功）。`resumed` 表示这次带着令牌回来的 */
  onOpen?: (resumed: boolean) => void;
  onClose?: (willRetry: boolean) => void;
  /** 收到了无法解码的帧。★ 不该发生，但发生了要能看见 */
  onDecodeError?: (raw: string) => void;
}

/**
 * M13：`NetworkScene` 需要的连接能力**子集**。
 *
 * 大厅流程里连接归 `LobbyShell` 所有（房间阶段与战斗阶段共用一条 ws），
 * 场景只借用它收发 —— 这个窄接口就是「借用」的边界：场景拿不到
 * `connect()` / `close()`，也就不可能替大厅决定连接的生死。
 * `Connection` 结构上自然满足它。
 */
export interface NetLink {
  send(msg: ClientMessage): void;
  readonly connected: boolean;
}

export class Connection {
  private socket?: WebSocket;
  private retries = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private closedByUs = false;
  /** 开局时服务器给的重连令牌 */
  private token?: string;

  constructor(
    private readonly url: string,
    private readonly handlers: ConnectionHandlers,
  ) {}

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    this.closedByUs = false;
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.onopen = () => {
      const resumed = this.token !== undefined;
      this.retries = 0;
      /**
       * ★ 带着令牌回来 → 先 `Reconnect`，服务器据此把这条连接认回原来的玩家。
       *   顺序很重要：必须在任何其他消息之前，否则那些消息会以「新玩家」
       *   的身份被处理。
       */
      if (this.token !== undefined) this.send({ t: 'Reconnect', token: this.token });
      this.handlers.onOpen?.(resumed);
    };

    socket.onmessage = (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : '';
      const msg = decodeServerMessage(raw);
      if (!msg) { this.handlers.onDecodeError?.(raw); return; }

      // ★ 令牌在这里被记住 —— 见文件头
      if (msg.t === 'MatchStart') this.token = msg.reconnectToken;
      this.handlers.onMessage(msg);
    };

    socket.onclose = () => {
      const willRetry = !this.closedByUs && this.retries < RECONNECT_BACKOFF_MS.length;
      this.handlers.onClose?.(willRetry);
      if (willRetry) this.scheduleRetry();
    };

    /**
     * ★ 不在 onerror 里重连 —— 浏览器在 error 之后**总会**再发一次 close，
     *   两处都重连会开出两条连接。让 close 做唯一的重连入口。
     */
    socket.onerror = () => { /* 交给 onclose */ };
  }

  private scheduleRetry(): void {
    const delay = RECONNECT_BACKOFF_MS[this.retries] ?? 4000;
    this.retries++;
    this.timer = setTimeout(() => this.connect(), delay);
  }

  send(msg: ClientMessage): void {
    if (!this.connected) return; // ★ 断线期间静默丢弃：服务器那边角色照样在被打（11.5）
    this.socket!.send(encodeClientMessage(msg));
  }

  /**
   * M13：作废重连令牌。一局结束回到房间页后由大厅调用 ——
   * 那一局已经不存在，令牌指向的实体也没了；留着的话，房间页里一次
   * 普通的网络闪断会让 onopen 先发 `Reconnect(旧令牌)`，被服务器
   * 「令牌无效」拒绝一次之后大厅才能重新 JoinRoom，白绕一圈。
   */
  clearToken(): void {
    this.token = undefined;
  }

  /** 主动关闭：不再重连 */
  close(): void {
    this.closedByUs = true;
    if (this.timer) clearTimeout(this.timer);
    this.socket?.close();
  }
}
