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
  admitToMatch,
  canStart,
  createMatch,
  encodeServerMessage,
  entityOfPlayer,
  freeSeatsOn,
  isLegalSpectateFollow,
  isVisibleTo,
  joinRoom,
  leaveSpectator,
  seatSpectator,
  unseatToSpectator,
  spectatableFor,
  spectatableForSpectator,
  takeOverSeat,
  createRoom,
  leaveMatch,
  markDisconnected,
  markReconnected,
  resetForRematch,
  ALL_CLASSES,
  FFA,
  NO_ENTITY,
  botSeatsNeeded,
  selectClass,
  selectSlot,
  setBossEnabled,
  setBotDifficulty,
  setFillWithBots,
  setMap,
  setMode,
  setPreset,
  setReady,
  startMatch,
  teamSizeOf,
  teamWiped,
  TEAM_BLUE,
  TEAM_RED,
  SIM,
  Slot,
  type ClassId,
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
    /**
     * ★ 幂等守卫：`ws` 的传输错误路径是 error → close **两次**走进这里
     *   （index.ts 对两个事件都挂了断线处理 —— error 不必然伴随 close，
     *   两边都挂是对的，代价是这里必须可重入）。
     *   `all` 的成员资格就是「这条会话还没断线过」的事实：删过一次即已处理；
     *   不守卫的话第二次会重复登记重连、二次广播 PeerDisconnected、再排一次接管。
     */
    if (!this.all.delete(session)) return;
    session.clearInputs();

    const sr = this.roomOf(session);
    if (!sr) return;
    sr.sessions.delete(session);

    /**
     * ★★ W24：**观战席掉线与选手掉线是两件事。**
     *
     *   观战者在世界里没有实体 —— 也就没有「角色留在原地可被攻击」（11.5）、
     *   没有死亡统计、没有可被人机接管的席位。照选手那条路走会连做三件
     *   错事：给一个没有身体的席位登记人机（BotDriver 每 tick 为它查一次空）、
     *   给全场广播一条「队友掉线中（还剩 42 秒）」（他不是任何人的队友）、
     *   把他留在名单里堵住 `resetForRematch`。
     *   所以观战席这条只做三件事：**登记宽限**（凭同一个令牌重连回来仍是
     *   观战席，见 `onReconnect`）、标记断线、把新名单广播出去。
     *   到期没回来由 `eliminate` 收尾 —— 那里对没有身体的人是「从名单里
     *   删掉」而不是「判死」（他没有可规避的死亡统计）。
     */
    if (sr.room.started && !sr.match?.entityOf.has(session.playerId)) {
      const now = sr.match?.world.time ?? 0;
      const token = sr.tokenByPlayer.get(session.playerId);
      registerDisconnect(sr.reconnects, session.playerId, now, {
        graceSeconds: sr.room.config.mode === GameMode.Ffa
          ? FFA.DISCONNECT_GRACE_SECONDS
          : TAKEOVER_GRACE_SECONDS,
        ...(token ? { tokenFactory: () => token } : {}),
      });
      markDisconnected(sr.room, session.playerId);
      if (!this.dropIfEmpty(sr)) this.broadcastRoomState(sr);
      if (this.humanSessionCount(sr) === 0) this.scheduleAbandon(sr);
      return;
    }

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
    sr.bots?.dispose();
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
    sr.bots?.dispose();
    this.rooms.delete(sr.room.id);
    return true;
  }

  // ── 消息路由 ──────────────────────────────────────────────────

  private handle(session: Session, msg: ClientMessage): void {
    switch (msg.t) {
      case 'JoinRoom': return this.onJoin(session, msg.roomId, msg.name);
      case 'ListRooms': return this.onListRooms(session);
      // W24 中途加入。★ 「只有观战席能发」由 Session 的阶段白名单挡在门外
      case 'JoinOngoing': return this.onJoinOngoing(session, msg.team, msg.classId);
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
      /**
       * ★ P5 选图。房主校验、地图存在性、「适不适配当前模式」全在 sim 的
       *   `setMap()` 里 —— 本文件头那条「规则不在这里」对它同样成立：
       *   要是在这儿再写一份「哪张图能用」，`mapsForMode` 就不再是唯一权威了。
       */
      case 'SetRoomMap': return this.onRoomMutation(
        session, (sr) => setMap(sr.room, session.playerId, msg.mapId), 'SetRoomMap');
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
      case 'BattleBuy':
        return this.enqueue(session, { t: 'BattleBuy', offerId: msg.offerId });
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

    /**
     * ★★ W24：**同一条消息，两条判据** —— 因为「谁能看谁」的理由不同：
     *   · 死亡观战（11.4）：跟随者是场上的一名选手，只能跟**己方存活**队友，
     *     否则等于给他一个能飞到敌方后排的镜头；
     *   · 观战席：没有「己方」可言，约束换成**观战段本身**
     *     （`isLegalSpectateFollow` —— 跟不到一个连观战段都进不去的人，
     *     所以未被发现的潜行者对观战者既看不见也跟不了）。
     * ★ 两条判据都住在 `net/visibility.ts`，服务器这里只做分派 ——
     *   在这儿手写「同队且活着」正是那两个函数的注释点名要防的。
     */
    if (session.isSpectator) {
      const target = sr.match.world.entities.get(entityId);
      const ctx = sr.match.ctf ? { ctf: sr.match.ctf.state } : undefined;
      if (!target || !isLegalSpectateFollow(target, ctx)) {
        session.reject('SpectateFollow', '不能跟随该目标');
        return;
      }
      session.following = entityId;
      return;
    }

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

    /**
     * ★★ W24（用户拍板 2026-08-10）：**对局中的房间可以进 —— 先坐观战席。**
     *
     *   在此之前这里是一句 `reject('比赛已开始')`，于是「单机房永远只有开局
     *   那批人」（W24 行的原话）：想看一眼进不去，想补位也进不去。
     *
     *   现在 `JoinRoom` 对 `started` 房间的语义是**入场观战**：名单上他就是
     *   一个观战席成员（`joinRoom` 的默认席位正是观战席），会话进
     *   `SessionPhase.Spectate`，下一份快照起收观战段。想上场再发一条
     *   `JoinOngoing` —— 两步而不是一步，是因为「哪一队还坐得下、有几个人机
     *   可以顶」要**先看见房间状态**才选得出来（RoomState 就是那份状态）。
     *
     * ⚠️ 想拿回**自己原来的角色**仍然只有 `Reconnect` + 令牌那一条路：
     *   从这里进来的人是一个全新的 playerId，拿不到任何既有实体。
     */
    if (sr.room.started) {
      if (!sr.match) {
        // 理论上不可达（started 与 match 同生同灭）；诚实拒绝比进一个空局好
        session.reject('JoinRoom', '这局比赛正在收尾，请稍后再试');
        return;
      }
      joinRoom(sr.room, session.playerId, name);
      sr.sessions.add(session);
      session.roomId = roomId;
      this.enterAsSpectator(sr, session);
      this.broadcastRoomState(sr);
      return;
    }

    joinRoom(sr.room, session.playerId, name);
    sr.sessions.add(session);
    session.roomId = roomId;
    session.phase = SessionPhase.Room;
    this.broadcastRoomState(sr);
  }

  /**
   * W24：让一条会话以**观战席**身份入场（两条入口共用）：
   *   a) 房间阶段就选了观战席的人 —— 开局时随队发（`beginMatch`）；
   *   b) 对局中从大厅加入 `started` 房间的人 —— 立即入场（`onJoin`）。
   *
   * ★ 观战席**照样发 `MatchStart`**：它是客户端「从大厅页切到 3D 场景」的
   *   唯一信号（M13 那条「观战席开局停在房间页」的边界就此关闭）。带
   *   `spectating: true`，客户端据此不预测、不发输入 —— `you` 是**看谁**，
   *   不是「我是谁」。
   * ★ 令牌照发：形状不随席位变形，重连回来仍是观战席（`onReconnect` 按
   *   「这个 playerId 在这局里有没有实体」决定给哪一种）。
   */
  private enterAsSpectator(sr: ServerRoom, session: Session): void {
    const match = sr.match;
    if (!match) return;
    session.phase = SessionPhase.Spectate;
    const token = this.issueToken(sr, session.playerId);
    const ctx = match.ctf ? { ctf: match.ctf.state } : undefined;
    session.send({
      t: 'MatchStart',
      mapId: match.map.id,
      // ★ 默认跟随取列表第一个（按 id 序，确定性）；一个可跟的都没有时是哨兵 0
      you: spectatableForSpectator(match.world, ctx)[0]?.id ?? NO_ENTITY,
      startsAt: match.world.time,
      reconnectToken: token,
      spectating: true,
    });
  }

  /**
   * 拿到（或现发）这个玩家在本局的重连令牌。
   * ★ 幂等：一个 playerId 在一局里只有一个令牌 —— 中途加入者顶替人机席位时
   *   直接沿用那个席位开局时发出去的那一个（它当时发给了一个 BotSocket，
   *   也就是发进了垃圾桶），不另发一个让 `tokens` 里出现两条指向同一个人的记录。
   */
  private issueToken(sr: ServerRoom, playerId: string): string {
    const existing = sr.tokenByPlayer.get(playerId);
    if (existing) return existing;
    const token = randomUUID();
    sr.tokens.set(token, playerId);
    sr.tokenByPlayer.set(playerId, token);
    return token;
  }

  /**
   * W24 中途加入：从观战席坐上一个战斗席。
   *
   * ★★ **两条路，顺序有语义**（拍板口径「根据房间当前队伍情况」）：
   *   1. 那一队**还坐得下** → 新建实体入场（`admitToMatch`）。选的职业
   *      **当场生效** —— 他是个全新的角色，没有任何可占的便宜。
   *      大乱斗永远走这条（P12：全员独立阵营，加人就是加实体）。
   *   2. 队伍满了、但席位上坐着**补位人机** → 顶替它（断线接管的反向操作）。
   *      当场**沿用被顶替人机的职业**，选的那个等下一次复活/回合重置
   *      （`MatchLoop.requestRespec`，理由见 docs/08 §8.7）。
   *   3. 两条都不成 → **诚实拒绝，并说清另一队还有没有位置**
   *      （「红队满了，那就只能加入蓝队」这句话得由服务器说得出来）。
   *
   * ⚠️ **只顶替 `fill` 人机，绝不顶替 `disconnect` 接管的席位** ——
   *   后者是某个真人的角色，他手里攥着重连令牌随时会回来。顶替它等于
   *   把别人的角色送给路人，而且是**无声**的（他重连时会发现自己没了）。
   *   判据读 `BotDriver` 的席位原因，不看名字（名字是玩家可控字符串）。
   */
  private onJoinOngoing(session: Session, team: 'red' | 'blue', classId: ClassId): void {
    const sr = this.roomOf(session);
    if (!sr?.match || !sr.loop || !sr.room.started) {
      session.reject('JoinOngoing', '比赛未进行');
      return;
    }
    // ★ 纵深：阶段白名单已经挡过一次（SPECTATE_ONLY），这里是第二道
    if (session.phase !== SessionPhase.Spectate) {
      session.reject('JoinOngoing', '你不在观战席上');
      return;
    }

    const slot = team === 'red' ? Slot.Red : Slot.Blue;
    /**
     * ★ 大乱斗把两个取值都读作「参战」（P12：没有两队，`freeSeatsOn` 的
     *   FFA 分支红蓝合并计数）—— 客户端发哪个都行，语义只有一个。
     */
    if (freeSeatsOn(sr.room, slot) > 0) {
      const r = seatSpectator(sr.room, session.playerId, slot, classId);
      if (!r.ok) { session.reject('JoinOngoing', r.reason ?? '被拒绝'); return; }
      const admitted = admitToMatch(sr.match, {
        playerId: session.playerId,
        name: sr.room.players.find((p) => p.id === session.playerId)?.name ?? '玩家',
        classId,
        slot,
      });
      if (!admitted.ok) {
        // ★ sim 拒了（已全灭/满员/职业非法）：把名单**改回观战席**，
        //   否则名单上多一个没有身体的「战斗席」——canStart 与结算面板都会被它绊倒
        unseatToSpectator(sr.room, session.playerId);
        session.reject('JoinOngoing', admitted.reason);
        this.broadcastRoomState(sr);
        return;
      }
      this.finishSeating(sr, session, session.playerId);
      return;
    }

    /**
     * ★★ W24 收口：**全灭守卫两条路都要有。** 上面那条（`admitToMatch`）
     *   自带 `teamWiped` 拒绝，顶替这条此前一条都没有 —— 而「队伍被人机补满」
     *   恰恰是这条 reason 最该出现的场景（有空位的队伍反而更少被清台）。
     *   两条路给**同一句话**，玩家看到的口径才一致。
     * ★ 大乱斗没有红蓝两队，`rosterCount(TEAM_RED) === 0` ⇒ `teamWiped` 恒假，
     *   这道判据对它自然空转（P12 全员独立阵营）。
     */
    const teamId = slot === Slot.Red ? TEAM_RED : TEAM_BLUE;
    if (teamWiped(sr.match.world, teamId)) {
      session.reject('JoinOngoing', '该队本回合已全灭，不能中途加入');
      return;
    }

    const seat = this.takeableBotSeat(sr, slot);
    if (!seat) {
      const other = slot === Slot.Red ? Slot.Blue : Slot.Red;
      const otherFree = freeSeatsOn(sr.room, other) + this.takeableBotSeats(sr, other).length;
      session.reject(
        'JoinOngoing',
        `${slot === Slot.Red ? '红方' : '蓝方'}没有可加入的席位` +
          (otherFree > 0
            ? `——${other === Slot.Red ? '红方' : '蓝方'}还有 ${otherFree} 个，换一边试试`
            : '（双方都满，且没有人机席位可顶替）'),
      );
      return;
    }

    /**
     * ★★ 顶替 = **接过那个席位的 playerId**（与 `onReconnect` 换回原 id
     *   逐字同构）。这样实体、统计行、令牌、房间名单条目**一个都不用搬** ——
     *   `entityOf` / `playerOf` / `stats` 全是按 playerId/实体 id 记的，
     *   而两者都没变。搬家式的实现（新建映射、迁统计）会有五张表要对齐，
     *   漏一张就是一个静默的半身不遂。
     */
    const takenName = sr.room.players.find((p) => p.id === session.playerId)?.name ?? '玩家';
    /**
     * ★ 顺序：**先做可能失败的那一步**（`takeOverSeat` 的三道守卫），
     *   通过了再动会话与人机 —— 反过来写的话，失败路径会留下一个
     *   「观战席已删、人机已下台、真人还没坐上」的空席位。
     *   与 `beginMatch` 的「先查地图再改状态」是同一条规矩。
     */
    const r = takeOverSeat(sr.room, seat, takenName);
    if (!r.ok) { session.reject('JoinOngoing', r.reason ?? '被拒绝'); return; }
    // 观战席那条名单记录删掉 —— 他从此**就是**那个席位
    leaveSpectator(sr.room, session.playerId);
    this.handBackFromBot(sr, seat);

    /**
     * ★ 观战期间发给他的那个令牌作废：换了身份之后它指向一个不再有会话的
     *   幽灵 playerId。留着不会出错（`redeemReconnect` 找不到登记会拒），
     *   但 `tokens` 会每来一个中途加入者就多一条死映射 —— 这类残留不报错，
     *   只会慢慢变脏（与 `detachBossSeat` 清映射同一条理由）。
     */
    const staleToken = sr.tokenByPlayer.get(session.playerId);
    if (staleToken !== undefined) {
      sr.tokens.delete(staleToken);
      sr.tokenByPlayer.delete(session.playerId);
    }

    session.playerId = seat;
    /**
     * ★ 身份换了必须**告诉客户端**（W6 那个真 bug 的同一课）：大厅按
     *   playerId 找「自己」，不改的话他回到房间页就点不动任何按钮。
     */
    session.send({
      t: 'Welcome', playerId: seat,
      tickRate: SIM.TICK_RATE, interpDelay: SIM.INTERP_DELAY,
    });
    // 世界里那具身体也换个名字 —— 姓名板/结算面板不该继续写「人机3」
    const e = entityOfPlayer(sr.match, seat);
    if (e) {
      e.name = takenName;
      const row = sr.match.stats.players.get(e.id);
      if (row) row.name = takenName;
    }
    /**
     * ★ 选的职业**不当场换**：当场换等于满血 + 满资源 + 冷却清空 + 光环全清，
     *   而这条路径是可以反复触发的（下一个观战者再顶一次）。登记，等他
     *   下一次复活/回合重置（`MatchLoop.applyPendingRespecs`）。
     * ⚠️ 竞技场默认单回合制 → 那一刻在本局**不会到来**，他整局用被顶替者的
     *   职业。文案要如实说（docs/15 W24 行）。
     */
    sr.loop.requestRespec(seat, classId);
    this.finishSeating(sr, session, seat);
  }

  /** 中途加入成功后的收尾：进战斗阶段、发 MatchStart、广播新名单 */
  private finishSeating(sr: ServerRoom, session: Session, playerId: string): void {
    const match = sr.match;
    if (!match) return;
    const entityId = match.entityOf.get(playerId);
    if (entityId === undefined) return;
    session.phase = SessionPhase.Match;
    session.following = undefined;
    /**
     * ★★ 席位变了 → 上一份 P11 记账整个作废（理由见 `MatchLoop.resetSnapshotAccount`）。
     *   同一个 Session 对象从观战席坐到战斗席，不清的话观战期定下的
     *   **敌人视图**会被冻结在客户端：新队友的备用武器/消耗品整局不下发。
     *   必须在 `MatchStart` **之前**：客户端在 MatchStart 分支清缓存，
     *   服务器这边也要从零重发，两边的「首见」才对得上。
     */
    sr.loop?.resetSnapshotAccount(session);
    session.send({
      t: 'MatchStart',
      mapId: match.map.id,
      you: entityId,
      startsAt: match.world.time,
      reconnectToken: this.issueToken(sr, playerId),
    });
    // P13：大乱斗中途加入的人也要一份货架（余额 0），理由见 sendShopTo
    sr.loop?.sendShopTo(playerId);
    this.broadcastRoomState(sr);
  }

  /**
   * 这一队当前**可被顶替**的人机席位（`playerId` 列表）。
   *
   * ★ 三道筛，每道都有理由：
   *   · 有一条人机会话 —— 席位现在真的由 AI 在开；
   *   · 席位原因是 `fill`（补位）—— `disconnect` 是别人的角色，见 `onJoinOngoing` 的 ⚠️；
   *   · 在 `room.players` 名单里且在这一队 —— 顺带把**大 BOSS** 筛掉
   *     （它有人机会话、原因也是 fill，但它从来不在房间名单里）。
   *     按 `boss#` 前缀筛是同样的效果、更差的判据：那是一个字符串约定。
   *   · **那具身体还活着**（W24 收口补的第四道）—— 顶替一具尸体换来的是
   *     一个躺到比赛结束的角色：竞技场默认单回合制（`roundsToWin: 1`，
   *     服务器不调 `resetRound`），「死 → 活」的跳变本局不会到来，所以他
   *     既不会复活、也永远等不到自己选的职业。`admitToMatch` 那条路上有
   *     `teamWiped` 挡着，顶替这条路此前**一条存活性判据都没有**。
   *     ★ 顺带让 `RoomList.joinableSeats` 变诚实：尸体席位不再被算成「坐得下」。
   */
  private takeableBotSeats(sr: ServerRoom, slot: Slot): string[] {
    const out: string[] = [];
    for (const playerId of sr.botSessions.keys()) {
      if (sr.bots?.seatOf(playerId)?.reason !== 'fill') continue;
      const p = sr.room.players.find((x) => x.id === playerId);
      if (!p || p.slot !== slot) continue;
      // 比赛还没开的房间没有身体可查 —— 那时席位当然可顶替（判据只对局中有意义）
      if (sr.match && entityOfPlayer(sr.match, playerId)?.alive !== true) continue;
      out.push(playerId);
    }
    return out;
  }

  private takeableBotSeat(sr: ServerRoom, slot: Slot): string | undefined {
    return this.takeableBotSeats(sr, slot)[0];
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
        /**
         * W24：**现在坐得下几个人**。空位（`freeSeatsOn`，规则在 sim）
         * 加上可顶替的人机席位（只有服务器知道谁是人机）。
         * ★ 未开局的房间自然只有前一项 —— 那时一个人机都还没建
         *   （补位发生在 `beginMatch`）。
         * ★ 大乱斗红蓝合并计数，所以只取一次 Red 就够（见 `freeSeatsOn`）。
         */
        joinableSeats: sr.room.config.mode === GameMode.Ffa
          ? freeSeatsOn(sr.room, Slot.Red)
          : ([Slot.Red, Slot.Blue] as const).reduce(
            (n, slot) => n + freeSeatsOn(sr.room, slot) + this.takeableBotSeats(sr, slot).length,
            0,
          ),
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
      // 仇恨表记账（X10 用户拍板）：本 tick 的事件流喂给人机驱动
      onPostTick: (events) => sr.bots?.observe(events),
      onBossSpawned: (entityId) => this.attachBossSeat(sr, entityId),
      onBossDespawned: (entityId) => this.detachBossSeat(sr, entityId),
      /**
       * W24：中途加入者选的职业**真的换过来了**（下一次复活/回合重置那一刻）。
       * 循环只报告事实 —— 改名单与广播是这里的活（它才持有 Room）。
       */
      onClassChanged: (playerId, classId) => {
        const p = sr.room.players.find((x) => x.id === playerId);
        if (!p) return;
        p.classId = classId;
        this.broadcastRoomState(sr);
      },
    });

    // 补位的人机现在有身体了，接管它们（与掉线接管走同一条路径）
    for (const playerId of botIds) this.takeOverByBot(sr, playerId, 'fill');

    for (const s of sr.sessions) {
      const entityId = match.entityOf.get(s.playerId);
      /**
       * ★★ W24：观战席**随队入场**，不再被 `continue` 掉。
       *   在此之前这一行是 `continue; // 观战者` —— 于是 3.1 的观战席
       *   在联网局里等于「按了准备也什么都不会发生」：选手切进 3D 场景，
       *   观战者留在房间页看着一个再也不会变的名单（M13 登记的那条边界）。
       *   现在他收到一份带 `spectating` 的 MatchStart，下一份快照起收观战段。
       */
      if (entityId === undefined) {
        this.enterAsSpectator(sr, s);
        continue;
      }
      s.phase = SessionPhase.Match;

      // ★ 令牌现在就发（见 ServerRoom.tokens 的注释）。此刻**还没有**断线，
      //   所以不登记到 reconnects —— 登记是断线那一刻的事。
      const token = this.issueToken(sr, s.playerId);

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
    /**
     * ★★ 人机**赛后一并遣散**（W24 收口）：名单里留着它们的话，一个开着
     *   补位的房间打完一局就再也开不出第二局（它们永远不会 ready），而
     *   观战者赛后想选阵营会发现两队都「已满」。判据用 `botSessions` 的键
     *   （服务器侧唯一权威，与 `RoomPlayerView.bot` 同源），不按名字前缀猜。
     * ★ 先算再 reset：`resetForRematch` 把它们从名单里剔掉之后，下面那个
     *   会话循环会把假会话一并从 `sessions` 里扫掉（走「不在名单里」那一支）；
     *   `sr.bots` 的席位登记在这里显式收掉，两张表不留残页。
     */
    const botIds = new Set(sr.botSessions.keys());
    resetForRematch(sr.room, botIds);
    for (const playerId of botIds) sr.bots?.remove(playerId);
    sr.bots?.dispose();
    sr.bots = undefined;
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
     * ★ W24：**没有身体的人没什么可淘汰的。** 观战席的宽限到期（或主动退出）
     *   就是「他不看了」—— 从名单里删掉即可。走下面那条会做三件没意义的事：
     *   给一个不存在的实体排弃权判死、把已经不在的人再标一次断线、
     *   给全场广播一条 `PeerEliminated`（HUD 会把它读成「有选手被淘汰了」）。
     */
    if (!sr.match?.entityOf.has(playerId)) {
      if (leaveSpectator(sr.room, playerId) && !this.dropIfEmpty(sr)) {
        this.broadcastRoomState(sr);
      }
      return;
    }
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
    /**
     * ★ W24：**没有实体 = 观战席回来了**（他的令牌是入场时发的，见
     *   `enterAsSpectator`）。给他一份带 `spectating` 的 MatchStart 并回到
     *   观战阶段 —— 上面那句无条件 `phase = Match` 对他是错的：
     *   Match 阶段会放行 `CastRequest` 这类需要身体的消息。
     */
    if (entityId === undefined) {
      this.enterAsSpectator(sr, session);
      this.broadcastRoomState(sr);
      return;
    }
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
    /**
     * ★ W24：观战席主动退出 —— 与掉线同一条路（见 `disconnect` 的 ★★）。
     *   11.5「主动退出立即按淘汰处理」管的是**有角色的人**：观战者没有角色，
     *   也就没有可规避的死亡统计。他回到大厅，会话回 Lobby 阶段。
     */
    if (sr.room.started && !sr.match?.entityOf.has(session.playerId)) {
      leaveSpectator(sr.room, session.playerId);
      sr.sessions.delete(session);
      session.roomId = undefined;
      session.phase = SessionPhase.Lobby;
      session.following = undefined;
      if (!this.dropIfEmpty(sr)) this.broadcastRoomState(sr);
      return;
    }
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
      /**
       * W24：这个席位现在由人机在开。★ 判据是**有没有一条人机会话**，
       *   不是名字前缀 —— 一个自称「人机7」的真人骗不过它。省略 = 真人
       *   （P11 的「可选即事实」同规矩，房间阶段的名单里通常一个都没有）。
       */
      ...(sr.botSessions.has(p.id) ? { bot: true } : {}),
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
      bossEnabled: sr.room.config.bossEnabled === true || sr.room.config.mode.startsWith('ctf') || sr.room.config.mode === GameMode.Ffa,
    });
  }

  /** 测试与优雅退出用 */
  stopAll(): void {
    for (const sr of this.rooms.values()) {
      sr.loop?.stop();
      sr.bots?.dispose();
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
