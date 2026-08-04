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
  botSeatsNeeded,
  selectClass,
  selectSlot,
  setFillWithBots,
  setPreset,
  setReady,
  startMatch,
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
import {
  createReconnectRegistry,
  graceRemaining,
  leaveImmediately,
  redeemReconnect,
  registerDisconnect,
  type ReconnectRegistry,
} from './reconnect.js';
import { Session, SessionPhase, type SessionSocket } from './Session.js';

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

  // ── 连接 ──────────────────────────────────────────────────────

  /** 接入一条新连接。返回的 Session 由传输层喂原始数据 */
  connect(socket: SessionSocket): Session {
    const playerId = `p${nextPlayerSeq++}`;
    const session = new Session(socket, playerId, (s, msg) => this.handle(s, msg));
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
      const entry = registerDisconnect(sr.reconnects, session.playerId, now, {
        graceSeconds: TAKEOVER_GRACE_SECONDS,
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
    } else {
      leaveMatch(sr.room, session.playerId);
      if (!this.dropIfEmpty(sr)) this.broadcastRoomState(sr);
    }
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
      case 'Reconnect': return this.onReconnect(session, msg.token);
      case 'SelectTeam': return this.onRoomMutation(
        session, (sr) => selectSlot(sr.room, session.playerId, msg.team as Slot), 'SelectTeam');
      case 'SelectClass': return this.onRoomMutation(
        session, (sr) => selectClass(sr.room, session.playerId, msg.classId), 'SelectClass');
      case 'SetReady': return this.onSetReady(session, msg.ready);
      // ★ 房主校验在 sim 的 `setPreset()` 里，不在这里 —— 与其他房间变更同源
      case 'SetRoomPreset': return this.onRoomMutation(
        session, (sr) => setPreset(sr.room, session.playerId, msg.preset), 'SetRoomPreset');
      case 'SetFillWithBots': return this.onRoomMutation(
        session, (sr) => setFillWithBots(sr.room, session.playerId, msg.enabled), 'SetFillWithBots');
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
      case 'SpectateFollow': return this.onSpectateFollow(session, msg.entityId);

      case 'UseTrinket':
        /**
         * ★ 诚实地拒绝。`useTrinket()` 规则在 `effects/combat.ts` 里写好了，
         *   但它需要一个 `EffectContext` —— 也就是说它是**效果结算**，
         *   而效果结算只有 `tickWorld` 一个出口（A2 的教训）。
         *   要接它得先在 tick 里加一步，那是一次显眼的改动，不在这里偷做。
         *   ⚠️ 顺带一提：这个函数至今**只有测试调用过**，客户端也没接。
         */
        return session.reject('UseTrinket', '解控饰品尚未接入 tick（需要新增一个结算步骤）');

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
    const sr = this.rooms.get(roomId) ?? this.createRoomFor(roomId, session.playerId);
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
      onEliminate: (playerId, reason) => this.eliminate(sr, playerId, reason),
      onEnd: (winner) => this.endMatch(sr, winner),
      onPreTick: () => sr.bots?.tick(),
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
    sr.bots.add({ playerId, reason });
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
    const sr = [...this.rooms.values()].find((r) => r.tokens.has(token));
    if (!sr || !sr.match) { session.reject('Reconnect', '令牌无效'); return; }

    const now = sr.match.world.time;
    const r = redeemReconnect(sr.reconnects, token, now);
    if (!r.ok) { session.reject('Reconnect', r.reason); return; }

    // ★ 换回原来的玩家 id —— 角色是按玩家 id 找的
    session.playerId = r.playerId;
    session.roomId = sr.room.id;
    session.phase = SessionPhase.Match;
    sr.sessions.add(session);
    this.all.add(session);
    markReconnected(sr.room, r.playerId);
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
    for (const s of sr.sessions) s.send(msg);
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
    });
  }

  /** 测试与优雅退出用 */
  stopAll(): void {
    for (const sr of this.rooms.values()) sr.loop?.stop();
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
}
