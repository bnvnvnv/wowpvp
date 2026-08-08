/**
 * 房间集合：加入 / 选阵营 / 选职业 / 准备 / 开局，以及开局后的消息路由。
 *
 * ★★ **房间的「规则」不在这里 —— 在 `shared/sim/match/room.ts`。**
 *
 *   本文件只做**传输**：把一条消息翻译成一次 `selectClass()` / `setReady()`,
 *   再把结果广播出去。3.2 那条否定式规则（「不限制同职业数量」「不强制
 *   治疗坦克比例」「不得阻止准备」）**一行都不在这里**，因为它一旦在这里
 *   出现第二份实现，就会有人在这一份上「顺手加个阵容限制」，
 *   而 room.ts 的测试拦不到服务器里的私货。
 *
 *   ⚠️ 所以这里**不允许**出现任何 `if (队伍里治疗太少) return reject(...)`。
 *      要加限制，去改 `canStart()`，那里有测试盯着。
 */

import {
  GameMode,
  ArenaPreset,
  MAP_BY_ID,
  asMapId,
  SwapKind,
  canStart,
  createMatch,
  encodeServerMessage,
  entityOfPlayer,
  isVisibleTo,
  joinRoom,
  spectatableFor,
  createRoom,
  leaveMatch,
  markDisconnected,
  markReconnected,
  resetForRematch,
  ALL_CLASSES,
  FFA,
  botSeatsNeeded,
  selectClass,
  selectSlot,
  setBossEnabled,
  setBotDifficulty,
  setFillWithBots,
  setMode,
  setPreset,
  setReady,
  startMatch,
  teamSizeOf,
  SIM,
  Slot,
  type ClientMessage,
  type Room,
  type RoomPlayerView,
  type EntityId,
  type Match,
  type ServerMessage,
  type TeamId,
} from '@wowpvp/shared';

import { randomUUID } from 'node:crypto';

import { MatchLoop, type MatchCommand } from '../MatchLoop.js';
import { BotDriver, BotSocket, type BotSeat } from '../BotDriver.js';
import { LIMITS } from '../limits.js';
import { log } from '../log.js';
import {
  createReconnectRegistry,
  leaveImmediately,
  redeemReconnect,
  registerDisconnect,
  type ReconnectRegistry,
} from './reconnect.js';
import { Session, SessionPhase, type RateLimitConfig, type SessionSocket } from './Session.js';

/**
 * S1/S3 的资源上限（全部有 LIMITS 默认值；测试压小走同一条路径）。
 * ★ 这些是**服务器资源**边界，不是游戏规则 —— 游戏规则（队伍容量、
 *   观战席不设限）仍在 sim 的 room.ts，这里不复述也不覆盖。
 */
export interface RoomServerOptions {
  maxRooms?: number;
  maxRoomMembers?: number;
  rate?: RateLimitConfig;
  /**
   * P6：全员真人掉线后，等这么久没人回来才回收对局（毫秒）。
   * ★ 不是立刻回收 —— 共享 wifi 抖动会让一队人同一瞬间集体掉线（verify:m13
   *   §4b 正是这个：severConnections 一次掐断双方再各自重连）。给一个宽限窗口，
   *   谁在窗口内重连就取消回收；窗口过完仍零人才拆。默认 30s：远长于一次
   *   网络闪断的重连（客户端首次退避 250ms），又远短于「空房跑满半小时」。
   */
  abandonGraceMs?: number;
}

/** 默认房间配置。★ 快速比赛单回合制（2.1） */
const DEFAULT_CONFIG = {
  mode: GameMode.Arena3v3,
  // ⚠️ 地图 id 是 `arena_3v3`（带下划线），不是模式名 `arena3v3`。
  //    写错的后果曾经是「房间永远开不了局，只回一条『地图不存在』」——
  //    所以下面 beginMatch 里先查地图**再**开局，查不到就不动房间状态。
  mapId: asMapId('arena_3v3'),
  preset: ArenaPreset.Classic,
  roundsToWin: 1,
  allowUnbalanced: false,
  // ★ 默认关 —— 打开会改变开局时世界里有几个实体，见 RoomConfig.fillWithBots 的注释
  fillWithBots: false,
};

interface ServerRoom {
  room: Room;
  sessions: Set<Session>;
  reconnects: ReconnectRegistry;
  match?: Match;
  loop?: MatchLoop;
  /**
   * 开局时就发出去的重连令牌。token → playerId。
   *
   * ★★ **令牌必须在开局时发，不能等断线时再发** —— 断线时连接已经没了，
   *   那条消息送不到任何人。所以 `reconnect.ts` 的登记（`registerDisconnect`）
   *   发生在**真的断线时**，但它用的令牌是这里预先发出去的那一个
   *   （靠 `tokenFactory` 注入），两边因此是同一个字符串。
   */
  tokens: Map<string, string>;
  tokenByPlayer: Map<string, string>;
  /**
   * 人机驱动（docs/14 §16b）。开局时建，随房间生命周期走。
   * ★ 它只在**战斗阶段**有事做 —— 房间阶段没有实体可驱动。
   */
  bots?: BotDriver;
  /** 被人机接管的席位对应的（假）会话，按 playerId 索引 */
  botSessions: Map<string, Session>;
  /** P6：全员真人掉线后待回收的计时器；有人重连即清除（见 scheduleAbandon）*/
  abandonTimer?: ReturnType<typeof setTimeout>;
}

/**
 * 掉线后令牌的有效期，秒。已知偏差 #14：「整局内一直有效」。
 *
 * ★ 取 24 小时而不是 `Infinity`（JSON 过不去）也不是 90 秒（那是被推翻的
 *   旧语义）。判据只有一条：**长于任何一局可能的时长** —— 一局竞技场
 *   常规 6 分钟、夺旗封顶也在半小时量级。
 */
const TAKEOVER_GRACE_SECONDS = 24 * 60 * 60;

let nextPlayerSeq = 1;

export class RoomServer {
  private readonly rooms = new Map<string, ServerRoom>();
  /** 所有活着的连接，含还没进房间的 */
  private readonly all = new Set<Session>();
  private readonly maxRooms: number;
  private readonly maxRoomMembers: number;
  private readonly rate: RateLimitConfig;

  private readonly abandonGraceMs: number;

  constructor(opts: RoomServerOptions = {}) {
    this.maxRooms = opts.maxRooms ?? LIMITS.MAX_ROOMS;
    this.maxRoomMembers = opts.maxRoomMembers ?? LIMITS.MAX_ROOM_MEMBERS;
    this.abandonGraceMs = opts.abandonGraceMs ?? 30_000;
    this.rate = opts.rate ?? {
      capacity: LIMITS.RATE_CAPACITY,
      refillPerSec: LIMITS.RATE_REFILL_PER_SEC,
      disconnectAfterDropped: LIMITS.RATE_DISCONNECT_AFTER_DROPPED,
    };
  }

  // ── 连接 ──────────────────────────────────────────────────────

  /** 接入一条新连接。返回的 Session 由传输层喂原始数据 */
  connect(socket: SessionSocket): Session {
    const playerId = `p${nextPlayerSeq++}`;
    // ★ S1 限流只挂真人连接 —— 人机会话（takeOverByBot）不传 rate
    const session = new Session(socket, playerId, (s, msg) => this.handle(s, msg), this.rate);
    this.all.add(session);
    session.send({
      t: 'Welcome',
      playerId,
      tickRate: SIM.TICK_RATE,
      interpDelay: SIM.INTERP_DELAY,
    });
    return session;
  }

  /**
   * 连接断开。
   *
   * ★ 战斗中断线**不移除实体** —— 角色留在原地继续参与模拟、可被攻击
   *   （11.5「不获得无敌」）。这里能做的只有：登记宽限、标记连接状态、
   *   告诉队友。**什么都不对实体做**，正是那条规则的实现方式。
   */
  disconnect(session: Session): void {
    this.all.delete(session);
    session.clearInputs();

    const sr = this.roomOf(session);
    if (!sr) return;
    sr.sessions.delete(session);

    if (sr.room.started) {
      const now = sr.match?.world.time ?? 0;
      // ★ 用开局时已经发给他的那个令牌登记，两边才是同一个字符串
      const token = sr.tokenByPlayer.get(session.playerId);
      /**
       * ★★ **已知偏差 #14：宽限期改成「整局有效」。**
       *
       *   拍板的语义是「断线瞬间人机接管、重连即交还、整局内令牌一直有效」，
       *   于是 11.5 的「超时按淘汰处理」不再发生 —— 而表达「不再超时」的
       *   最小改动就是把宽限期放到长于任何一局，让 `takeExpired()` 永远返回空。
       *
       *   ★ 刻意**不删** `settleExpiredReconnects()` 那条链路：它是 11.5
       *     「不能通过退出规避死亡统计」的执行点，主动退出（`LeaveMatch`）
       *     仍然要走它。删掉等于把两条不同的规则一起拿掉。
       *   ★ 也刻意不用 `Infinity`：它过不了 JSON（会变成 null），
       *     而 `PeerDisconnected.graceRemaining` 是要发出去的。
       */
      /**
       * P13：大乱斗的宽限是 90 秒不是整局（FFA.DISCONNECT_GRACE_SECONDS 的
       * ★★）—— 到期走既有的 takeExpired → eliminate 链：弃权判死（尸体可被
       * 收割）、不再复活（tick.ts 的 forfeited 守卫）、bot 下台、积分冻结。
       * 组队模式维持偏差 #14 的整局语义不动。
       */
      const graceSeconds = sr.room.config.mode === GameMode.Ffa
        ? FFA.DISCONNECT_GRACE_SECONDS
        : TAKEOVER_GRACE_SECONDS;
      const entry = registerDisconnect(sr.reconnects, session.playerId, now, {
        graceSeconds,
        ...(token ? { tokenFactory: () => token } : {}),
      });
      markDisconnected(sr.room, session.playerId);
      // ★ 已知偏差 #14：断线**瞬间**由人机接管（不是超时才接管）
      this.takeOverByBot(sr, session.playerId);
      this.broadcast(sr, {
        t: 'PeerDisconnected',
        playerId: session.playerId,
        graceRemaining: entry.expiresAt - now,
      });
      /**
       * ★★ P6（技术债总账）：**全员真人掉线 → 回收对局。**
       *
       *   此前无人房间照跑 20Hz 到终局（夺旗封顶半小时量级）：`started`
       *   分支不判空，而人机接管又往 `sessions` 里塞了假会话，`dropIfEmpty`
       *   的 `sessions.size` 判据恒为真 —— 一个 griefer 开一堆房再断线，
       *   就留下一堆只有人机在打的空房占着 CPU（可被外部触发的资源占用）。
       *
       *   判据是**零真人 session**（人机会话 `isBot` 不算人）。见 scheduleAbandon
       *   的宽限窗口 —— 不立刻拆，给集体闪断留一条重连的路。
       */
      if (this.humanSessionCount(sr) === 0) this.scheduleAbandon(sr);
    } else {
      leaveMatch(sr.room, session.playerId);
      if (!this.dropIfEmpty(sr)) this.broadcastRoomState(sr);
    }
  }

  /** 还连着的**真人**会话数 —— 人机（BotSocket）不算人（P6 判据） */
  private humanSessionCount(sr: ServerRoom): number {
    let n = 0;
    for (const s of sr.sessions) if (!s.isBot) n++;
    return n;
  }

  /**
   * P6：排一个宽限计时器，窗口过完仍零真人才回收。
   * ★ 幂等：已经排了就不重排（第二个人掉线时窗口不该被重置延长）。
   *   谁在窗口内重连由 `cancelAbandon`（onReconnect 调）取消。
   */
  private scheduleAbandon(sr: ServerRoom): void {
    if (sr.abandonTimer) return;
    log('info', 'match_abandon_scheduled', { roomId: sr.room.id, graceMs: this.abandonGraceMs });
    sr.abandonTimer = setTimeout(() => {
      sr.abandonTimer = undefined;
      // 窗口末尾复查 —— 万一有人重连了（cancelAbandon 没赶上清定时器的极端时序）
      if (this.humanSessionCount(sr) === 0) this.abandonMatch(sr);
    }, this.abandonGraceMs);
  }

  /** P6：有真人回来了，取消待回收 */
  private cancelAbandon(sr: ServerRoom): void {
    if (!sr.abandonTimer) return;
    clearTimeout(sr.abandonTimer);
    sr.abandonTimer = undefined;
    log('info', 'match_abandon_cancelled', { roomId: sr.room.id });
  }

  /**
   * P6：无人对局的收尾。停循环、遣散人机、回收房间 —— 房间码可复用。
   * ★ 与 `endMatch` 的区别：那条有胜负、要广播 MatchEnd 给还在的人；
   *   这条没有观众，广播给谁都没有，所以直接拆。
   */
  private abandonMatch(sr: ServerRoom): void {
    log('info', 'match_abandoned', { roomId: sr.room.id });
    if (sr.abandonTimer) { clearTimeout(sr.abandonTimer); sr.abandonTimer = undefined; }
    sr.loop?.stop();
    for (const s of sr.botSessions.values()) sr.sessions.delete(s);
    sr.botSessions.clear();
    sr.bots = undefined;
    sr.loop = undefined;
    sr.match = undefined;
    sr.tokens.clear();
    sr.tokenByPlayer.clear();
    this.rooms.delete(sr.room.id);
  }

  /** 没人（名单空且无连接）的房间从注册表回收，房间码可复用 */
  private dropIfEmpty(sr: ServerRoom): boolean {
    if (sr.room.players.length > 0 || sr.sessions.size > 0) return false;
    this.rooms.delete(sr.room.id);
    return true;
  }

  // ── 消息路由 ──────────────────────────────────────────────────

  private handle(session: Session, msg: ClientMessage): void {
    switch (msg.t) {
      case 'JoinRoom': return this.onJoin(session, msg.roomId, msg.name);
      case 'ListRooms': return this.onListRooms(session);
      case 'Reconnect': return this.onReconnect(session, msg.token);
      case 'SelectTeam': return this.onRoomMutation(
        session, (sr) => selectSlot(sr.room, session.playerId, msg.team as Slot), 'SelectTeam');
      case 'SelectClass': return this.onRoomMutation(
        session, (sr) => selectClass(sr.room, session.playerId, msg.classId), 'SelectClass');
      case 'SetReady': return this.onSetReady(session, msg.ready);
      // ★ 房主校验在 sim 的 `setPreset()` 里，不在这里 —— 与其他房间变更同源
      case 'SetRoomPreset': return this.onRoomMutation(
        session, (sr) => setPreset(sr.room, session.playerId, msg.preset), 'SetRoomPreset');
      // ★ W12：换模式连带换地图与人数档，规则全在 sim 的 `setMode()`
      case 'SetRoomMode': return this.onRoomMutation(
        session, (sr) => setMode(sr.room, session.playerId, msg.mode), 'SetRoomMode');
      case 'SetFillWithBots': return this.onRoomMutation(
        session, (sr) => setFillWithBots(sr.room, session.playerId, msg.enabled), 'SetFillWithBots');
      case 'SetRoomBotDifficulty': return this.onRoomMutation(
        session, (sr) => setBotDifficulty(sr.room, session.playerId, msg.difficulty), 'SetRoomBotDifficulty');
      // ★ 随机大 BOSS。房主校验同样在 sim 的 `setBossEnabled()` 里
      case 'SetRoomBoss': return this.onRoomMutation(
        session, (sr) => setBossEnabled(sr.room, session.playerId, msg.enabled), 'SetRoomBoss');
      case 'LeaveMatch': return this.onLeave(session);
      case 'CastRequest': return this.onCastRequest(session, msg);
      case 'CancelCast': return this.enqueue(session, { t: 'CancelCast' });
      case 'SetTarget': return this.onSetTarget(session, msg.slot, msg.entityId);
      case 'TabTarget': return this.enqueue(session, { t: 'TabTarget', reverse: msg.reverse });
      case 'SwapWeapon':
        return this.enqueue(session, { t: 'Swap', kind: SwapKind.Weapon, slot: msg.slot });
      case 'SwapArmor':
        return this.enqueue(session, { t: 'Swap', kind: SwapKind.Armor, slot: msg.slot });
      // ★ 协议现在自带可辨识联合，服务器不用再猜玩家想拔旗还是捡东西
      case 'InteractStart': return this.enqueue(session, { t: 'InteractStart', target: msg.target });
      case 'InteractCancel': return this.enqueue(session, { t: 'InteractCancel' });
      case 'OpenArmory':
        return this.enqueue(session, { t: 'OpenArmory', armoryId: msg.armoryId });
      case 'ChooseArsenal':
        return this.enqueue(session, {
          t: 'ChooseArsenal', armoryId: msg.armoryId, choice: msg.choice,
        });
      /**
       * P13 大乱斗积分商店。★ 这里只做路由 —— 「有没有这件商品」「买不买得起」
       *   「买了用不上」全在 sim 的 `buyFfaOffer()`，与本文件头「规则不在这里」同则。
       */
      case 'FfaBuy':
        return this.enqueue(session, { t: 'FfaBuy', offerId: msg.offerId });
      case 'SpectateFollow': return this.onSpectateFollow(session, msg.entityId);

      case 'UseTrinket': {
        /**
         * ★ W8：tick 第 1c 步已经存在，这里终于可以只做路由。
         *   此前是诚实拒绝（「要接它得先在 tick 里加一步」）—— 那一步加了，
         *   `useTrinket()` 从 M9 零调用到现在有了真实调用链。
         *   冷却与「昏迷中可用」都在 tick 里结算，这里不做第二套判定。
         */
        const sr = this.roomOf(session);
        if (!sr?.loop) { session.reject('UseTrinket', '比赛未进行'); return; }
        sr.loop.requestTrinket(session.playerId);
        return;
      }

      case 'UseConsumable': {
        // ★ M11：消耗品使用路径已接上（技术债 #6）
        const sr = this.roomOf(session);
        if (!sr?.loop) { session.reject('UseConsumable', '比赛未进行'); return; }
        sr.loop.requestConsumable(session.playerId, msg.slot);
        return;
      }

      default:
        session.reject((msg as ClientMessage).t, '未知消息');
    }
  }

  /** 战斗指令排队。★ 统一走这里，省得每条都写一遍「比赛在不在」 */
  private enqueue(session: Session, cmd: MatchCommand): void {
    const sr = this.roomOf(session);
    if (!sr?.loop) { session.reject(cmd.t, '比赛未进行'); return; }
    sr.loop.enqueue(session.playerId, cmd);
  }

  /**
   * ★★ **选目标是一道安全边界，不是一次状态设置。**
   *
   *   验收 #5：未被发现的潜行目标不能被点击、Tab、姓名板或小地图选中。
   *   客户端的过滤挡不住改前端的人 —— 他可以直接发一条
   *   `SetTarget{entityId: 猜的}` 来**探测**某个 id 存不存在。
   *   所以服务器必须自己判一次可见性（`verify:m10` 第 7 条验的就是这个）。
   *
   * ★ 拒绝理由必须是**笼统的**：codec.ts 明说「不要在拒绝 SetTarget 时说
   *   『实体 7 不在你的可见集合里』，那等于确认了实体 7 存在」。
   *   所以不论「不存在」还是「看不见」，回的都是同一句「目标无效」。
   */
  private onSetTarget(
    session: Session,
    slot: 'hard' | 'focus',
    entityId: EntityId | null,
  ): void {
    const sr = this.roomOf(session);
    if (!sr?.loop || !sr.match) { session.reject('SetTarget', '比赛未进行'); return; }

    if (entityId !== null) {
      const viewer = entityOfPlayer(sr.match, session.playerId);
      const target = sr.match.world.entities.get(entityId);
      const visible = viewer && target && isVisibleTo(
        target, viewer, sr.match.ctf ? { ctf: sr.match.ctf.state } : undefined,
      );
      if (!visible) { session.reject('SetTarget', '目标无效'); return; }
    }
    sr.loop.enqueue(session.playerId, { t: 'SetTarget', slot, entityId });
  }

  /**
   * 11.4 死亡观战：只能跟随**己方存活玩家**。
   * ★ 用 `spectatableFor()` 判，而不是自己写一遍「同队且活着」——
   *   那条规则的另一半（不能自由镜头穿墙找潜行目标）就靠它。
   */
  private onSpectateFollow(session: Session, entityId: EntityId): void {
    const sr = this.roomOf(session);
    if (!sr?.match) { session.reject('SpectateFollow', '比赛未进行'); return; }
    const viewer = entityOfPlayer(sr.match, session.playerId);
    if (!viewer) { session.reject('SpectateFollow', '不在这局里'); return; }

    const allowed = spectatableFor(sr.match.world, viewer).some((e) => e.id === entityId);
    if (!allowed) { session.reject('SpectateFollow', '不能跟随该目标'); return; }
    session.following = entityId;
  }

  // ── 房间阶段 ──────────────────────────────────────────────────

  private onJoin(session: Session, roomId: string, name: string): void {
    if (session.roomId) {
      session.reject('JoinRoom', '已经在一个房间里了');
      return;
    }
    /**
     * S3 资源上限。两条都是**服务器容量**判定，不是游戏规则：
     *   · 房间数满 → 拒绝**新建**（加入既有房间不受影响）
     *   · 房间成员满（含观战席）→ 拒绝加入。3.2「观战席不设限」的规则
     *     语义在 sim 里原样不动 —— 但每个观战者每 tick 都要一份完整快照
     *     构建与序列化，无上限的观战席就是免费的放大器
     */
    const existing = this.rooms.get(roomId);
    if (!existing && this.rooms.size >= this.maxRooms) {
      log('warn', 'room_cap_reject', { playerId: session.playerId, rooms: this.rooms.size });
      session.reject('JoinRoom', '服务器房间数已满，稍后再试');
      return;
    }
    // P12 大乱斗房间放大到 100 参战 + 观战余量；其余模式按原上限
    const memberCap = existing?.room.config.mode === GameMode.Ffa
      ? LIMITS.MAX_FFA_ROOM_MEMBERS
      : this.maxRoomMembers;
    if (existing
      && existing.room.players.length >= memberCap
      && !existing.room.players.some((p) => p.id === session.playerId)) {
      log('warn', 'room_member_cap_reject', { playerId: session.playerId, roomId });
      session.reject('JoinRoom', `该房间人数已达上限（${memberCap}）`);
      return;
    }
    const sr = existing ?? this.createRoomFor(roomId, session.playerId);
    if (sr.room.started) {
      // ★ 开局后不能加入。想回来要用 Reconnect + 令牌
      session.reject('JoinRoom', '比赛已开始');
      return;
    }

    joinRoom(sr.room, session.playerId, name);
    sr.sessions.add(session);
    session.roomId = roomId;
    session.phase = SessionPhase.Room;
    this.broadcastRoomState(sr);
  }

  private createRoomFor(roomId: string, hostId: string): ServerRoom {
    const sr: ServerRoom = {
      room: createRoom(roomId, hostId, { ...DEFAULT_CONFIG }),
      sessions: new Set(),
      reconnects: createReconnectRegistry(),
      tokens: new Map(),
      tokenByPlayer: new Map(),
      botSessions: new Map(),
    };
    this.rooms.set(roomId, sr);
    return sr;
  }

  /** 选阵营 / 选职业：同一套「调 room.ts → 失败就 reject → 成功就广播」 */
  private onRoomMutation(
    session: Session,
    mutate: (sr: ServerRoom) => { ok: boolean; reason?: string },
    what: string,
  ): void {
    const sr = this.roomOf(session);
    if (!sr) { session.reject(what, '还没有加入房间'); return; }
    const r = mutate(sr);
    if (!r.ok) { session.reject(what, r.reason ?? '被拒绝'); return; }
    this.broadcastRoomState(sr);
  }

  /**
   * 准备。★ 全员准备就开局 —— 但**能不能开**由 `canStart()` 说了算，
   *   本文件不重复那套判据（见文件头）。
   */
  private onSetReady(session: Session, ready: boolean): void {
    const sr = this.roomOf(session);
    if (!sr) { session.reject('SetReady', '还没有加入房间'); return; }

    const r = setReady(sr.room, session.playerId, ready);
    if (!r.ok) { session.reject('SetReady', r.reason ?? '被拒绝'); return; }
    this.broadcastRoomState(sr);

    if (canStart(sr.room).ok) this.beginMatch(sr);
  }

  /**
   * P12 房间浏览（玩家反馈「游戏大厅很薄弱」—— 此前只能靠房间码口口相传）。
   *
   * ★ 与 `/healthz` 不列房间码的立场（healthSnapshot 的注释）不冲突：
   *   那是无鉴权 HTTP 端点、扫描器可批量抓；这条走 ws 会话，是大厅的
   *   产品功能 —— 房间在本产品里就是公开可加入的（JoinRoom 本无密码），
   *   浏览列表只是把「可加入」这个既有事实做成了可见。摘要不含玩家名单。
   * ★ 上限 50 条按人数降序 —— 列表是给人挑的，不是全量目录（S3 的
   *   MAX_ROOMS 才是资源上限）。
   */
  private onListRooms(session: Session): void {
    const rooms = [...this.rooms.values()]
      .map((sr) => ({
        roomId: sr.room.id,
        mode: sr.room.config.mode,
        players: sr.room.players.filter((p) => p.slot !== Slot.Spectator).length,
        // 大乱斗没有「两队」——容量就是参战槽位本身
        capacity: sr.room.config.mode === GameMode.Ffa
          ? teamSizeOf(sr.room.config.mode)
          : teamSizeOf(sr.room.config.mode) * 2,
        started: sr.room.started,
        fillWithBots: sr.room.config.fillWithBots === true,
      }))
      .sort((a, b) => b.players - a.players)
      .slice(0, 50);
    session.send({ t: 'RoomList', rooms });
  }

  // ── 开局 ──────────────────────────────────────────────────────

  private beginMatch(sr: ServerRoom): void {
    /**
     * ★★ **先查地图，再 `startMatch()`。**
     *   反过来写的后果是：地图 id 配错时 `room.started` 已经被置 true，
     *   而 `match` 是 undefined —— 房间从此卡死，既开不了局也进不来人
     *   （`onJoin` 会以「比赛已开始」拒绝所有人）。
     *   这不是假想：A3 的集成测试第一次跑就撞上了这个（默认 mapId 写成了
     *   模式名）。**先做可能失败的事，再改状态。**
     */
    const map = MAP_BY_ID.get(sr.room.config.mapId as string);
    if (!map) {
      for (const s of sr.sessions) {
        s.reject('start', `地图不存在：${sr.room.config.mapId}`);
      }
      return;
    }

    /**
     * docs/14 §16b 人机补位。**必须在 `startMatch()` 之前** ——
     * `createMatch()` 是照着 `room.players` 生实体的，之后再加就没有身体了。
     *
     * ★ 人机是**真正的房间成员**（走 `joinRoom` / `selectSlot` /
     *   `selectClass` / `setReady` 这四个真人也走的函数），不是一个旁挂的
     *   数组。于是阵营人数上限、职业合法性、`canStart()` 全部照常约束它们，
     *   而不需要在这些规则里各加一个「如果是人机则…」的分支。
     */
    const botIds = this.fillBotSeats(sr);

    const started = startMatch(sr.room);
    if (!started.ok) return; // canStart 刚说可以，这里再失败只可能是并发，忽略

    const match = createMatch(sr.room, map);
    sr.match = match;
    /**
     * 人机驱动。★ 投递走 `handleRaw()` —— 也就是**真人那条一模一样的入口**
     * （解析 + 范围校验 + 阶段鉴权 + 排队）。见 BotDriver 的文件头。
     */
    sr.bots = new BotDriver(
      () => sr.match,
      (playerId, raw) => sr.botSessions.get(playerId)?.handleRaw(raw),
    );
    sr.loop = new MatchLoop(match, {
      sessions: () => sr.sessions,
      reconnects: sr.reconnects,
      roomId: sr.room.id,
      onEliminate: (playerId, reason) => this.eliminate(sr, playerId, reason),
      onEnd: (winner) => this.endMatch(sr, winner),
      onPreTick: () => sr.bots?.tick(),
      onBossSpawned: (entityId) => this.attachBossSeat(sr, entityId),
      onBossDespawned: (entityId) => this.detachBossSeat(sr, entityId),
    });

    // 补位的人机现在有身体了，接管它们（与掉线接管走同一条路径）
    for (const playerId of botIds) this.takeOverByBot(sr, playerId, 'fill');

    for (const s of sr.sessions) {
      const entityId = match.entityOf.get(s.playerId);
      if (entityId === undefined) continue; // 观战者
      s.phase = SessionPhase.Match;

      // ★ 令牌现在就发（见 ServerRoom.tokens 的注释）。此刻**还没有**断线，
      //   所以不登记到 reconnects —— 登记是断线那一刻的事。
      const token = randomUUID();
      sr.tokens.set(token, s.playerId);
      sr.tokenByPlayer.set(s.playerId, token);

      s.send({
        t: 'MatchStart',
        mapId: map.id,
        you: entityId,
        startsAt: match.world.time,
        reconnectToken: token,
      });
    }

    sr.loop.start();
  }

  private endMatch(sr: ServerRoom, winner: TeamId | 'draw'): void {
    this.broadcast(sr, { t: 'MatchEnd', winner });
    sr.loop?.stop();
    this.resetAfterMatch(sr);
  }

  /**
   * M13：赛后把房间放回「可再开一局」的状态（docs/14 §M13 —— 在此之前
   * `started` 永不复位，房间是一次性的：赛后 `SelectClass`/`SetReady` 全被
   * 「比赛已开始」拒绝，MatchEnd 就是死路）。
   *
   * 顺序上紧跟 MatchEnd 广播 —— 客户端先收到胜负、随后一条 `RoomState
   * (started=false)`，什么时候把画面从结算切回房间页由客户端自己决定。
   * ★ 不引入任何新消息类型（M13 红线）：复位对客户端就是一条普通 RoomState。
   *
   * 名单规则在 `resetForRematch()`（shared，有测试盯着），这里只做传输侧的
   * 对应清理：
   *   · match/loop 置空 —— `matchOf()` 不该再把上一局翻出来
   *   · 重连令牌与宽限登记清空 —— 上一局的令牌换不回任何东西（那局没了），
   *     留着反而能被 `onReconnect` 兑换进一个不存在的 match
   *   · 名单里还在的人回 Room 阶段（否则 ROOM_ONLY 消息全被阶段门禁拒掉）；
   *     被剔除的人（退出/超时淘汰）踢回 Lobby 并清 roomId —— 他们想回来
   *     走全新的 JoinRoom
   */
  private resetAfterMatch(sr: ServerRoom): void {
    resetForRematch(sr.room);
    sr.match = undefined;
    sr.loop = undefined;
    sr.tokens.clear();
    sr.tokenByPlayer.clear();
    sr.reconnects = createReconnectRegistry();

    for (const s of [...sr.sessions]) {
      s.clearInputs();
      s.following = undefined;
      if (sr.room.players.some((p) => p.id === s.playerId)) {
        s.phase = SessionPhase.Room;
      } else {
        sr.sessions.delete(s);
        s.roomId = undefined;
        s.phase = SessionPhase.Lobby;
        /**
         * ★ 假会话（BOSS 的席位）在这里彻底收掉 —— 它的 playerId 永远不在
         *   `room.players` 里，所以只会走到这个分支。不删的话 `botSessions`
         *   会每打一局多留一条指向上一局实体的死映射：不报错，只是慢慢变脏。
         */
        sr.botSessions.delete(s.playerId);
      }
    }

    // 全员断线的房间没有观众，直接回收 —— 房间码可复用，注册表不积尸体
    if (!this.dropIfEmpty(sr)) this.broadcastRoomState(sr);
  }

  private eliminate(sr: ServerRoom, playerId: string, reason: 'timeout' | 'left'): void {
    /**
     * ★ 淘汰 = 判定死亡。11.5：「主动退出立即按淘汰处理，**不能通过退出
     *   规避死亡统计**」—— 所以是把他打死，而不是把他从世界里删掉。
     *
     * ★★ 不在这里直改 `alive/health`。此前正是这么写的，而直改字段绕过了
     *   死亡漏斗：deaths 统计一直没记上（恰好违反本注释引用的 11.5）、
     *   settleDeaths 一直没清临时装备（10.10）、客户端一直收不到 Death ——
     *   注释与实现相反了很久（技术债总账 A1，2026-08-04 清偿）。
     *   现在排进下一 tick 的 forfeits，与真实死亡走同一条链。
     */
    sr.loop?.forfeit(playerId);
    markDisconnected(sr.room, playerId);
    // 淘汰之后人机也该下台 —— 让 AI 继续操作一具尸体没有意义
    this.handBackFromBot(sr, playerId);
    this.broadcast(sr, { t: 'PeerEliminated', playerId, reason });
  }

  /**
   * 按房间设置补上人机席位，返回它们的 playerId。
   *
   * ★ 职业**轮着选**而不是随机：确定性是这个仓库的底线之一
   *   （回放、`pnpm balance` 复现都依赖它）。随机选职业会让同一个房间
   *   两次开局打出不同的对局。
   */
  private fillBotSeats(sr: ServerRoom): string[] {
    const ids: string[] = [];
    let n = 0;
    for (const { slot, count } of botSeatsNeeded(sr.room)) {
      for (let i = 0; i < count; i++) {
        const playerId = `bot${nextPlayerSeq++}`;
        const cls = ALL_CLASSES[n % ALL_CLASSES.length]!;
        n++;
        joinRoom(sr.room, playerId, `人机${n}`);
        selectSlot(sr.room, playerId, slot);
        selectClass(sr.room, playerId, cls.id);
        setReady(sr.room, playerId, true);
        ids.push(playerId);
      }
    }
    return ids;
  }

  // ── 人机接管（docs/14 §16b，docs/10 已知偏差 #14）────────────────

  /**
   * 让人机接管一个席位。
   *
   * ★★ 接管的方式是**给这个 playerId 建一条（假）会话** —— 不是给 MatchLoop
   *   开一条旁路。于是它在 `collectInputs()` 眼里与真人**完全同构**：
   *   同一个 `entityOf.get(s.playerId)`、同一个输入队列、同一套 codec。
   *   「人机能做真人做不到的事」因此在结构上写不出来。
   *
   * ★ 幂等：同一个 playerId 重复接管只会有一条会话（掉线→重连→再掉线）。
   */
  private takeOverByBot(sr: ServerRoom, playerId: string, reason: BotSeat['reason'] = 'disconnect'): void {
    if (!sr.bots || sr.botSessions.has(playerId)) return;

    const session = new Session(new BotSocket(), playerId, (s, msg) => this.handle(s, msg));
    session.roomId = sr.room.id;
    session.phase = SessionPhase.Match;
    sr.sessions.add(session);
    sr.botSessions.set(playerId, session);
    /**
     * P5（P1c）：**补位**人机吃房间的难度设置；**掉线接管固定 normal** ——
     * 接管是替真人打，不该因为房主开了 easy 就替掉线的真人演一个木桩
     * （拍板过的语义，docs/17 P1c 判据原文「掉线接管固定 normal」）。
     */
    sr.bots.add({
      playerId, reason,
      ...(reason === 'fill'
        ? { difficulty: sr.room.config.botDifficulty ?? 'normal' } : {}),
    });
  }

  // ── 大 BOSS 的席位 ───────────────────────────────────────────────

  /**
   * 让人机驱动一只刚出场的大 BOSS。
   *
   * ★★ **走的是与掉线接管一模一样的路**：一条 `BotSocket` 假会话 + 一个
   *   `BotDriver` 席位。于是 BOSS 的每一次移动与施法都是一条**经过 codec
   *   校验的协议消息**（`handleRaw` → parse → 阶段鉴权 → 排队 → tick），
   *   而不是服务器直接改 world。M16b 那条红线（人机不许开第二条输入通道）
   *   对 BOSS 同样成立，而且是同一份代码在保证。
   *
   * ★ 它需要 `entityOf` / `playerOf` 里有一条映射 —— `collectInputs()` 与
   *   `viewerOf()` 都按 playerId 找实体。BOSS 不在 `room.players` 里
   *   （名单、`canStart`、战后统计一概不认识它），只在这两张**对局内**的
   *   映射表里有名字。id 前缀 `boss#` 与真人 id 不可能撞（真人 id 是 UUID/
   *   `bot<序号>`），而且它从不进 `tokens`，所以没有任何令牌能兑换成它。
   *
   * ★ 难度固定 **hard**：需求要的是「很容易几下秒杀玩家」，而难度档影响的
   *   只有「会不会/多快反应」（见 `botController.ts` 的 BotDifficulty 注释）——
   *   easy 档的 BOSS 会呆站着挨打，那不是一只 BOSS。伤害数值一个字节都
   *   不受难度影响，它们全在 `data/classes/boss.ts`。
   */
  private attachBossSeat(sr: ServerRoom, entityId: EntityId): void {
    if (!sr.bots || !sr.match) return;
    const playerId = `boss#${entityId as number}`;
    if (sr.botSessions.has(playerId)) return;

    sr.match.entityOf.set(playerId, entityId);
    sr.match.playerOf.set(entityId, playerId);

    const session = new Session(new BotSocket(), playerId, (s, msg) => this.handle(s, msg));
    session.roomId = sr.room.id;
    session.phase = SessionPhase.Match;
    sr.sessions.add(session);
    sr.botSessions.set(playerId, session);
    sr.bots.add({ playerId, reason: 'fill', difficulty: 'hard' });
  }

  /**
   * BOSS 死了：席位与映射一起收掉。
   *
   * ⚠️ **必须清 `entityOf` / `playerOf`** —— 留着的话下一只 BOSS 会拿到新的
   *   实体 id 与新的 playerId，而上一条映射指向一个已经不存在的实体：
   *   `collectInputs` 每 tick 都会为它查一次空，`sessionOfEntity` 也会
   *   把消息投给一条早该消失的假会话。这类残留不会报错，只会慢慢变脏。
   */
  private detachBossSeat(sr: ServerRoom, entityId: EntityId): void {
    const playerId = sr.match?.playerOf.get(entityId);
    if (playerId === undefined) return;
    sr.match?.playerOf.delete(entityId);
    sr.match?.entityOf.delete(playerId);
    this.handBackFromBot(sr, playerId);
  }

  /**
   * 人回来了（或这个席位不再需要人机）：人机下台。
   *
   * ★ 顺序要紧：先从 `sessions` 里摘掉假会话，再登记给驱动 —— 反过来的话
   *   两条会话会在同一个 tick 里为**同一个实体**各投一份输入，
   *   而 `collectInputs()` 取的是「最后一条」，于是人的操作会被人机盖掉。
   */
  private handBackFromBot(sr: ServerRoom, playerId: string): void {
    const botSession = sr.botSessions.get(playerId);
    if (botSession) {
      sr.sessions.delete(botSession);
      sr.botSessions.delete(playerId);
      botSession.clearInputs();
    }
    sr.bots?.remove(playerId);
  }

  // ── 重连 ──────────────────────────────────────────────────────

  private onReconnect(session: Session, token: string): void {
    /**
     * ★ A6（技术债总账）：兑换令牌的前提是**这条连接不属于任何房间**。
     *
     *   此前不检查 —— 已在 A 房的会话拿 B 房令牌重连会把 `session.roomId`
     *   直接覆写，而 A 房的 `sessions` 与名单里还留着它：`dropIfEmpty()`
     *   永远数得到人，A 房与其名单**永久泄漏**。
     *
     *   重连本来就是给「断线后的新连接」用的（客户端 Connection 重连后
     *   第一条就发 Reconnect）；带着房间发它属于异常客户端，
     *   诚实拒绝 —— 与 JoinRoom 的「已经在一个房间里了」同规矩。
     */
    if (session.roomId !== undefined) {
      session.reject('Reconnect', '当前连接已在一个房间里');
      return;
    }
    const sr = [...this.rooms.values()].find((r) => r.tokens.has(token));
    if (!sr || !sr.match) { session.reject('Reconnect', '令牌无效'); return; }

    const now = sr.match.world.time;
    const r = redeemReconnect(sr.reconnects, token, now);
    if (!r.ok) { session.reject('Reconnect', r.reason); return; }

    // ★ 换回原来的玩家 id —— 角色是按玩家 id 找的
    session.playerId = r.playerId;
    /**
     * ★★ 身份换回来了必须**告诉客户端**（W6 的 E2E 抓到的真 bug）：
     *   重连的新连接刚收到过一条新 Welcome（新 playerId），服务器这里
     *   把会话换回原 id 之后客户端却还揣着新的 —— 对局里没事（场景认
     *   entityId），一回到房间页就露馅：大厅按 playerId 找「自己」找不到，
     *   准备按钮永远禁用，赛后重开一局对重连过的人**整个是坏的**。
     *   复用 Welcome 消息重发身份 —— 大厅对它的处理就是纯赋值，零新协议。
     */
    session.send({
      t: 'Welcome', playerId: r.playerId,
      tickRate: SIM.TICK_RATE, interpDelay: SIM.INTERP_DELAY,
    });
    session.roomId = sr.room.id;
    session.phase = SessionPhase.Match;
    sr.sessions.add(session);
    this.all.add(session);
    markReconnected(sr.room, r.playerId);
    // ★ P6：真人回来了 —— 撤销待回收（集体闪断后的重连正是这条路）
    this.cancelAbandon(sr);
    // ★ 已知偏差 #14 的后半句：**重连即交还**。人先回来，人机就下台
    this.handBackFromBot(sr, r.playerId);

    const entityId = sr.match.entityOf.get(r.playerId);
    if (entityId !== undefined) {
      session.send({
        t: 'MatchStart',
        mapId: sr.match.map.id,
        you: entityId,
        startsAt: now,
        reconnectToken: token,
      });
      /**
       * P13：大乱斗的商店面板要补一份。★ 与快照「不补发、下一 tick 自然会到」
       *   的做法分道扬镳是有理由的 —— `FfaShop` 只在余额变动时发，
       *   重连的人可能几分钟内等不到下一次变动（见 `sendShopTo` 的注释）。
       */
      sr.loop?.sendShopTo(r.playerId);
    }
    this.broadcast(sr, { t: 'PeerReconnected', playerId: r.playerId });
    /**
     * ★ `fullSnapshotRequired` 是写死的 `true`（reconnect.ts）——
     *   下一个 tick 的广播就会给他一份完整快照，客户端据此丢弃全部本地状态。
     *   这里不单独补发：补发等于多一条路径，而多出来的那条会漂移。
     */
  }

  private onLeave(session: Session): void {
    const sr = this.roomOf(session);
    if (!sr) return;
    if (sr.room.started) {
      leaveImmediately(sr.reconnects, session.playerId);
      this.eliminate(sr, session.playerId, 'left');
    } else {
      /**
       * M13：离开的人要把 session 也放干净 —— 此前只改了房间名单，
       * `session.roomId` 还挂着，于是他之后的任何 `JoinRoom` 都被
       * 「已经在一个房间里了」拒绝。大厅有了「离开房间」按钮后
       * 这条路径第一次真的被走到。
       */
      leaveMatch(sr.room, session.playerId);
      sr.sessions.delete(session);
      session.roomId = undefined;
      session.phase = SessionPhase.Lobby;
      if (!this.dropIfEmpty(sr)) this.broadcastRoomState(sr);
    }
  }

  // ── 战斗阶段 ──────────────────────────────────────────────────

  private onCastRequest(
    session: Session,
    msg: Extract<ClientMessage, { t: 'CastRequest' }>,
  ): void {
    const sr = this.roomOf(session);
    if (!sr?.loop) { session.reject('CastRequest', '比赛未进行'); return; }
    sr.loop.requestCast(session.playerId, {
      skillId: msg.skillId,
      ...(msg.targetId !== undefined ? { targetId: msg.targetId } : {}),
      ...(msg.groundPoint ? { groundPoint: msg.groundPoint } : {}),
      ...(msg.facing !== undefined ? { facing: msg.facing } : {}),
    });
  }

  // ── 广播 ──────────────────────────────────────────────────────

  private roomOf(session: Session): ServerRoom | undefined {
    return session.roomId === undefined ? undefined : this.rooms.get(session.roomId);
  }

  private broadcast(sr: ServerRoom, msg: ServerMessage): void {
    /** ★ P5（技术债总账）：同一条消息对 N 个接收者只 stringify 一次 */
    const raw = encodeServerMessage(msg);
    for (const s of sr.sessions) s.sendRaw(raw);
  }

  private broadcastRoomState(sr: ServerRoom): void {
    const players: RoomPlayerView[] = sr.room.players.map((p) => ({
      id: p.id,
      name: p.name,
      team: p.slot,
      ...(p.classId !== undefined ? { classId: p.classId } : {}),
      ready: p.ready,
      connected: p.connected,
    }));
    this.broadcast(sr, {
      t: 'RoomState',
      players,
      mode: sr.room.config.mode,
      preset: sr.room.config.preset,
      mapId: sr.room.config.mapId,
      started: sr.room.started,
      hostId: sr.room.hostId,
      // P5：人机补位与难度 —— 大厅要画出当前状态
      fillWithBots: sr.room.config.fillWithBots,
      botDifficulty: sr.room.config.botDifficulty ?? 'normal',
      // 随机大 BOSS 开关。★ 缺省 false —— 与 RoomConfig 的默认值同一句话
      bossEnabled: sr.room.config.bossEnabled === true,
    });
  }

  /** 测试与优雅退出用 */
  stopAll(): void {
    for (const sr of this.rooms.values()) {
      sr.loop?.stop();
      // P6 计时器也要清 —— 否则 server.close() 后它还会 fire，测试里挂着不退
      if (sr.abandonTimer) { clearTimeout(sr.abandonTimer); sr.abandonTimer = undefined; }
    }
  }

  /**
   * 验收脚本用：拿到一局的模拟状态。
   *
   * ★ `verify:m10` 的作弊测试需要**制造**一个作弊场景（让某人潜行、
   *   让某人掉血），然后从**客户端收到的字节**里断言看不到 ——
   *   也就是「白盒地布置，黑盒地断言」。没有这个入口就只能靠技能去凑，
   *   而那样测的是技能而不是裁剪。
   */
  matchOf(roomId: string): Match | undefined {
    return this.rooms.get(roomId)?.match;
  }

  /** 验收脚本用：某个房间当前的循环（用于单步推进） */
  loopOf(roomId: string): MatchLoop | undefined {
    return this.rooms.get(roomId)?.loop;
  }

  /**
   * 验收脚本用（P5）：某房间人机席位的 `playerId → 难度` 快照。
   * ★ 与 matchOf 同属白盒出口，生产路径零调用 —— 「房间难度设置真的
   *   流进了每个补位席位」这条接线只有这里能黑盒外验证。
   */
  botSeatsOf(roomId: string): { playerId: string; difficulty: string }[] {
    const sr = this.rooms.get(roomId);
    if (!sr?.bots) return [];
    return [...sr.botSessions.keys()].map((playerId) => ({
      playerId,
      difficulty: sr.bots?.seatOf(playerId)?.difficulty ?? 'normal',
    }));
  }

  /**
   * S6：`/healthz` 的聚合读数。只读、O(房间数)，不碰任何比赛状态。
   * ★ 刻意不带房间 id 明细 —— 健康检查端点是公开的（负载均衡/监控要探），
   *   把房间码列出去等于把「可加入的房间」泄露给扫描器。
   */
  healthSnapshot(): {
    connections: number; rooms: number; matches: number;
    slowTicks: number; droppedTicks: number; droppedCommands: number;
  } {
    let matches = 0, slowTicks = 0, droppedTicks = 0, droppedCommands = 0;
    for (const sr of this.rooms.values()) {
      if (!sr.loop) continue;
      matches++;
      slowTicks += sr.loop.stats.slowTicks;
      droppedTicks += sr.loop.stats.droppedTicks;
      droppedCommands += sr.loop.stats.droppedCommands;
    }
    return {
      connections: this.all.size,
      rooms: this.rooms.size,
      matches, slowTicks, droppedTicks, droppedCommands,
    };
  }
}
