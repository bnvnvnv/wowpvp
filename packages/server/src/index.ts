/**
 * 权威服务器入口。docs/08。
 *
 * ★ 本文件只做**传输与装配**：起 HTTP/WS、把每条连接交给 `RoomServer`、
 *   把原始帧喂给 `Session`。协议分发在 Session，房间规则在 shared/sim/match/room.ts，
 *   模拟顺序在 shared/sim/tick.ts —— 这里一条游戏规则都没有。
 *
 * ⚠️ 从 M0 的连通性桩改过来时**去掉了 `Roster` 消息**：它不在 `ServerMessage`
 *    联合里，而 `protocol.ts` 是协议的唯一定义。职业数据由客户端从
 *    `@wowpvp/shared` 直接 import（同一份代码两端都能跑，这正是 M0 要证明的事），
 *    不需要走网络。
 */

import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

import { ALL_CLASSES, SIM, validateData } from '@wowpvp/shared';

import { RoomServer } from './room/RoomServer.js';
import type { RateLimitConfig, SessionSocket } from './room/Session.js';
import { LIMITS } from './limits.js';
import { log } from './log.js';

/** 把 `ws` 的 WebSocket 适配成 Session 需要的能力 */
const adapt = (socket: WebSocket): SessionSocket => ({
  send: (data) => { if (socket.readyState === socket.OPEN) socket.send(data); },
  close: () => socket.close(),
  terminate: () => socket.terminate(),
  get closed() { return socket.readyState !== socket.OPEN; },
});

/**
 * S2 背压判定（纯函数，可单测）。
 *
 * ★★ **判据是「持续」而不是「瞬时」。** 出站缓冲超阈值的那一瞬间不代表
 *   对端死了 —— 服务器自己一次广播风暴、客户端一次 GC 停顿、验收脚本
 *   同步快进上千个 tick（事件循环被占满，OS 来不及 flush socket）都会让
 *   `bufferedAmount` 短暂冲高，随后毫秒级排空。真正的慢读者/黑洞连接则会
 *   **连续多个巡检间隔**都压在阈值之上。所以按巡检累计 strike，达到上限才断。
 *
 * @returns 新的 strike 数与是否应当断开。低于阈值即清零（排空了就不是慢读者）。
 */
export const backpressureStrike = (
  bufferedAmount: number,
  threshold: number,
  priorStrikes: number,
  maxStrikes: number,
): { strikes: number; terminate: boolean } => {
  if (bufferedAmount <= threshold) return { strikes: 0, terminate: false };
  const strikes = priorStrikes + 1;
  return { strikes, terminate: strikes >= maxStrikes };
};

/** 连续几个巡检间隔都超阈值就断开。2 = 至少一整个巡检周期持续背压 */
const BACKPRESSURE_MAX_STRIKES = 2;

export interface StartedServer {
  port: number;
  rooms: RoomServer;
  close: () => Promise<void>;
  /**
   * 测试用：掐断全部**现有**连接但不停服务 —— 模拟网络闪断。
   * ★ Playwright 的 `setOffline` 不会终止已建立的 WebSocket（只拦新请求），
   *   断线横幅/重连闭环的端到端验收（verify:m13 §4b）只能从服务器侧掐。
   *   与 `rooms.matchOf/loopOf` 同属白盒出口，生产路径零调用。
   */
  severConnections: () => void;
}

export interface ServerOptions {
  /** 心跳 ping 间隔（毫秒）。0 = 关闭心跳（需要绝对安静线路的测试用） */
  heartbeatIntervalMs?: number;
  /** 连续几次 ping 没等到 pong 就按半开连接 terminate */
  heartbeatMaxMisses?: number;

  // ── S1–S3 硬化参数。默认值见 limits.ts；测试压小走同一条判定路径 ──
  /** 单条入站消息字节上限（超限由 ws 以 1009 关闭） */
  maxPayloadBytes?: number;
  /** 出站缓冲**持续**超过这个字节数就按慢读者 terminate（见 backpressureCheckMs） */
  backpressureBytes?: number;
  /**
   * 背压巡检间隔（毫秒）。0 = 关闭巡检。
   * ★ 背压**不在每次 send 时判**，而是按这个节奏巡检：一次 send 让缓冲短暂
   *   冲高不代表对端卡住（GC 停顿、突发事件、白盒验收脚本的同步快进都会），
   *   连续两个巡检间隔都高才是真卡住。见 `backpressureStrike`。
   */
  backpressureCheckMs?: number;
  /** 同时在线连接上限，超出的以 1013 关闭 */
  maxConnections?: number;
  /**
   * Origin 白名单（形如 `https://play.example.com`，不带路径与尾斜杠）。
   * 不设 = 不校验（本地开发/同机验收）。
   * ★ 只拦**带 Origin 头且不在名单里**的连接 —— 浏览器无法伪造 Origin，
   *   这道防线针对的是「别的网站的页面拿访问者的浏览器连你」；
   *   非浏览器客户端（压测脚本、bot 工具）本来就能伪造任意头，
   *   拦它们靠的是限流与上限，不是这里。
   */
  allowedOrigins?: readonly string[];
  /** 房间数 / 单房间成员数上限（转交 RoomServer） */
  maxRooms?: number;
  maxRoomMembers?: number;
  /** S1 入站限流参数（转交 Session） */
  rate?: RateLimitConfig;
  /** P6 全员掉线后的回收宽限（毫秒，转交 RoomServer） */
  abandonGraceMs?: number;
  /**
   * P11 波2：出站 permessage-deflate。默认**开**（参数见 wss 构造处的注释）；
   * `false` = 关（CPU 紧张的部署、或需要在线上字节里做明文断言的测试）。
   */
  perMessageDeflate?: boolean;
}

/**
 * 起一个服务器。
 *
 * ★ 抽成函数而不是写在模块顶层，是为了让集成测试能起**真的**服务器
 *   （随机端口、用完关掉）。A6 的 `verify:m10` 也走这个入口 ——
 *   测试跑的和线上跑的是同一段启动代码。
 */
export const startServer = async (port = 0, opts: ServerOptions = {}): Promise<StartedServer> => {
  const rooms = new RoomServer({
    ...(opts.maxRooms !== undefined ? { maxRooms: opts.maxRooms } : {}),
    ...(opts.maxRoomMembers !== undefined ? { maxRoomMembers: opts.maxRoomMembers } : {}),
    ...(opts.rate ? { rate: opts.rate } : {}),
    ...(opts.abandonGraceMs !== undefined ? { abandonGraceMs: opts.abandonGraceMs } : {}),
  });
  const backpressureBytes = opts.backpressureBytes ?? LIMITS.BACKPRESSURE_BYTES;
  const maxConnections = opts.maxConnections ?? LIMITS.MAX_CONNECTIONS;
  const allowedOrigins = opts.allowedOrigins;
  const startedAtMs = Date.now();

  const httpServer = createServer((req, res) => {
    /**
     * S6 健康检查。给负载均衡/监控探活用：200 + 聚合读数（连接数、
     * 房间数、慢 tick/丢帧计数）。★ 不带房间明细 —— 端点是公开的，
     * 列出房间码等于把可加入房间泄露给扫描器（healthSnapshot 的注释）。
     */
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        uptimeSec: Math.round((Date.now() - startedAtMs) / 1000),
        ...rooms.healthSnapshot(),
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('wowpvp server —— WebSocket 在同端口。\n');
  });

  // ★ S2：单条消息上限。ws 默认 100MiB —— 一条 50MB 的 JSON 在解析瞬间
  //   让内存翻倍。超限 ws 自动以 1009 关闭，走正常 close → 断线路径
  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: opts.maxPayloadBytes ?? LIMITS.MAX_PAYLOAD_BYTES,
    /**
     * ★ P11 波2：permessage-deflate。浏览器端自动协商解压，零客户端改动。
     *
     *   参数是**量过的**（scripts/.diag 定价，瘦身后的 12v12 快照 4KB）：
     *   · level 1 + 上下文接管 → 压缩比 3.79×（连续快照 ~80% 是重复结构，
     *     接管让上一份留在窗口里 —— 「穷人的 delta」）。level 6 只多 ~0.1×
     *     但 CPU 翻倍，不值
     *   · serverMaxWindowBits 13 (8KB 窗口，够罩住上一份快照) + memLevel 6
     *     → 每连接出站上下文 ~64KB。wb15 快 30% 但 256KB/连接 ——
     *     在 1G 内存的部署目标下 480 连接就是 123MB，不划算
     *   · threshold 1024：事件消息（Damage ~150B）不压 —— 单条收益抵不过
     *     每条的 zlib 调度；快照（>1KB）才压
     *   · 入站方向压不压由客户端定；`clientNoContextTakeover` 让服务器的
     *     inflate 上下文用完即弃（入站只有 ~150B 的 Input，不需要跨消息窗口）
     *
     *   代价如实记：每份快照 ~150µs 压缩 CPU（24 人房 10Hz ≈ 37 m-core/房）。
     *   换的是下行 3.79×。带宽是部署第一约束（P11），这笔交换是赚的；
     *   CPU 紧张的部署可用 `perMessageDeflate: false` 关掉。
     */
    perMessageDeflate: opts.perMessageDeflate === false ? false : {
      threshold: 1024,
      serverMaxWindowBits: 13,
      clientNoContextTakeover: true,
      zlibDeflateOptions: { level: 1, memLevel: 6 },
    },
    /**
     * ★ S3 Origin 白名单在**握手层**（verifyClient）拒绝，而不是握手后再关 ——
     *   区别是本质的：握手后再关，攻击页面仍拿到过一个 open 的 socket；
     *   在这里拒，浏览器的 WebSocket 直接 error，连接从未建立。
     *   Origin 头浏览器不可伪造，白名单挡的正是「别的网站的页面拿访问者的
     *   浏览器连你」；无 Origin 的非浏览器客户端放行（它们能伪造任意头，
     *   防它们靠限流与上限，不靠这里）。
     */
    verifyClient: allowedOrigins
      ? (info: { origin?: string }) => {
          const origin = info.origin;
          if (origin === undefined) return true; // 非浏览器客户端
          const ok = allowedOrigins.includes(origin);
          if (!ok) log('warn', 'conn_rejected_origin', { origin });
          return ok;
        }
      : undefined,
  });

  /**
   * ★ 心跳与半开连接检测（技术债总账 A3）。
   *
   *   半开连接（断电、拔网线、NAT 超时）**不触发 'close'** —— 没有心跳的话
   *   它永远不被识别为断线，人机接管（偏差 #14「断线瞬间接管」）对最常见的
   *   断线形态失效：那个角色就是一具站着挨打的尸体，直到 TCP 自己超时
   *   （可能十几分钟）。
   *
   *   pong 由对端 ws 实现按 RFC 6455 §5.5.3 自动回复，不需要客户端代码配合。
   *   连续 maxMisses 次 ping 落空 → `terminate()`，它触发的是与正常断线
   *   **同一个** 'close' → `rooms.disconnect()` → 接管路径 —— 不开第二条
   *   断线通道（与 BotSocket 不开第二条输入通道同一条纪律）。
   */
  const heartbeatMs = opts.heartbeatIntervalMs ?? 30_000;
  const maxMisses = opts.heartbeatMaxMisses ?? 2;
  const missesOf = new WeakMap<WebSocket, number>();
  const playerOf = new WeakMap<WebSocket, string>();
  const heartbeat = heartbeatMs > 0
    ? setInterval(() => {
        for (const socket of wss.clients) {
          if (socket.readyState !== socket.OPEN) continue;
          const misses = missesOf.get(socket) ?? 0;
          if (misses >= maxMisses) {
            // ★ S6：半开连接的收割不再静默 —— 判据「半开有日志可见」
            log('warn', 'conn_halfopen_terminated', { playerId: playerOf.get(socket) });
            socket.terminate();
            continue;
          }
          missesOf.set(socket, misses + 1);
          socket.ping();
        }
      }, heartbeatMs)
    : undefined;

  /**
   * ★ S2 背压巡检（见 `backpressureStrike` 与 ServerOptions.backpressureCheckMs）。
   *   与心跳分开一条更快的节奏：慢读者要在内存涨太多之前发现，
   *   但判定按「连续两个间隔都超阈值」——一次瞬时冲高（广播风暴/GC/白盒快进）
   *   会在间隔之间排空，strike 清零，不误杀。
   */
  const backpressureMs = opts.backpressureCheckMs ?? 1000;
  const strikesOf = new WeakMap<WebSocket, number>();
  const backpressure = backpressureMs > 0
    ? setInterval(() => {
        for (const socket of wss.clients) {
          if (socket.readyState !== socket.OPEN) continue;
          const r = backpressureStrike(
            socket.bufferedAmount, backpressureBytes,
            strikesOf.get(socket) ?? 0, BACKPRESSURE_MAX_STRIKES,
          );
          strikesOf.set(socket, r.strikes);
          if (r.terminate) {
            log('warn', 'backpressure_disconnect', {
              playerId: playerOf.get(socket), bufferedBytes: socket.bufferedAmount,
            });
            socket.terminate();
          }
        }
      }, backpressureMs)
    : undefined;

  /**
   * P12 连接排队（玩家需求：「服务器满了可以排队，告知前面还剩多少人」）。
   *
   * ★★ 满员不再 1013 一关了之 —— 连接留在等待队列里：
   *   · 入队即发 `QueueStatus{ahead}`，每次队伍变动全队重报（前面还有几人）
   *   · 排队期间收到的消息**缓存**（上限 QUEUE_BUFFER_MAX），接纳后按序
   *     重放进 Session —— 客户端在 ws open 时就发的 JoinRoom 不会丢，
   *     排队对客户端因此是透明的：等到 Welcome 就是轮到了
   *   · 有人下线（close 路径）即 drainQueue 按序接纳
   * ★ 容量判据从 `wss.clients.size` 换成 `admitted.size` —— 排队的连接
   *   也在 wss.clients 里，拿它当分母会让队伍自己把门堵死。
   * ★ 队列有自己的上限（防无限排队吃内存）：超出的仍按老规矩 1013。
   */
  const admitted = new Set<WebSocket>();
  const waiting: { socket: WebSocket; buffered: string[] }[] = [];
  const QUEUE_MAX = 200;
  const QUEUE_BUFFER_MAX = 64;

  const notifyQueue = (): void => {
    for (const [i, w] of waiting.entries()) {
      if (w.socket.readyState === w.socket.OPEN) {
        w.socket.send(JSON.stringify({ t: 'QueueStatus', ahead: i }));
      }
    }
  };

  const admit = (socket: WebSocket, replay: readonly string[] = []): void => {
    admitted.add(socket);
    missesOf.set(socket, 0);
    socket.on('pong', () => missesOf.set(socket, 0));
    const session = rooms.connect(adapt(socket));
    playerOf.set(socket, session.playerId);

    const feed = (raw: string): void => {
      /**
       * ★★ **这里必须 try/catch。**
       *   `Session.handleRaw` 自己不抛（畸形包走返回值），但 `ws` 的
       *   message 处理器一旦抛异常就是**未捕获异常**，会带走整个进程 ——
       *   而这个进程里跑着别人的比赛。一条坏包不该拖垮整个房间，
       *   更不该拖垮整台服务器。
       */
      try {
        session.handleRaw(raw);
      } catch (err) {
        log('error', 'message_handler_error', {
          playerId: session.playerId,
          error: err instanceof Error ? (err.stack ?? err.message) : String(err),
        });
        session.reject('internal', '服务器处理该消息时出错');
      }
    };

    socket.on('message', (raw) => feed(raw.toString()));
    // 排队期间攒下的消息按序重放 —— 在 Welcome 之后、任何新消息之前
    for (const raw of replay) feed(raw);

    socket.on('close', (code) => {
      // ★ S6：异常关闭码留痕（1009 超大包 / 1008 origin / 1013 满载）。
      //   正常离开（1000/1001/1005/1006）不记 —— 那是每天几百次的日常
      if (code === 1008 || code === 1009 || code === 1013) {
        log('warn', 'conn_closed_abnormal', { playerId: session.playerId, code });
      }
      admitted.delete(socket);
      rooms.disconnect(session);
      drainQueue();
    });
    // ★ 传输层错误也当断线处理，否则连接半死不活地留在房间名单里。
    //   超大包（S2 maxPayload）走的正是这条 error 路径 —— 日志在此留痕
    socket.on('error', (err) => {
      log('warn', 'conn_error', { playerId: session.playerId, error: String(err) });
      admitted.delete(socket);
      rooms.disconnect(session);
      drainQueue();
    });
  };

  const drainQueue = (): void => {
    let moved = false;
    while (admitted.size < maxConnections && waiting.length > 0) {
      const next = waiting.shift()!;
      next.socket.removeAllListeners('message');
      next.socket.removeAllListeners('close');
      if (next.socket.readyState !== next.socket.OPEN) continue; // 排着排着走了
      log('info', 'queue_admitted', { waited: waiting.length });
      admit(next.socket, next.buffered);
      moved = true;
    }
    if (moved) notifyQueue();
  };

  wss.on('connection', (socket: WebSocket) => {
    // Origin 已在 verifyClient（握手层）拦过，走到这里的都是允许的来源
    if (admitted.size >= maxConnections) {
      if (waiting.length >= QUEUE_MAX) {
        log('warn', 'conn_rejected_capacity', { queued: waiting.length });
        socket.close(1013, '服务器已满');
        return;
      }
      const entry = { socket, buffered: [] as string[] };
      waiting.push(entry);
      log('info', 'conn_queued', { position: waiting.length });
      socket.on('message', (raw) => {
        if (entry.buffered.length < QUEUE_BUFFER_MAX) entry.buffered.push(raw.toString());
      });
      socket.on('close', () => {
        const i = waiting.indexOf(entry);
        if (i >= 0) { waiting.splice(i, 1); notifyQueue(); }
      });
      socket.send(JSON.stringify({ t: 'QueueStatus', ahead: waiting.length - 1 }));
      return;
    }
    admit(socket);
  });

  await new Promise<void>((resolve) => httpServer.listen(port, resolve));
  const addr = httpServer.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;

  return {
    port: actualPort,
    rooms,
    severConnections: () => {
      for (const c of wss.clients) c.terminate();
    },
    close: async () => {
      if (heartbeat) clearInterval(heartbeat);
      if (backpressure) clearInterval(backpressure);
      rooms.stopAll();
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
};

// ── 直接运行时才真的起服务 ───────────────────────────────────────
// ★ 被测试 import 时不能顺手占用 8080

const isMain = process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js');

if (isMain) {
  /** 启动前先跑一遍数据体检 —— 数据坏了就不该启动 */
  const issues = validateData();
  if (issues.length > 0) {
    console.error('职业数据校验失败，服务器拒绝启动：');
    for (const i of issues) console.error(`  ${i.where}: ${i.problem}`);
    process.exit(1);
  }

  /**
   * ★★ S5 进程守护 —— **只在直接运行时安装**，被测试/验收脚本 import 时
   *   绝不装：uncaughtException 处理器是进程级的，装在 `startServer()` 里
   *   会把**测试自己的失败**也吞成一行日志，绿灯说谎。
   *
   * tick 层的 try/catch（MatchLoop.pump）已把最大的异常源收容到单房间；
   * 走到这里的是 ws 内部/定时器等真正的漏网之鱼 —— 记下来、继续跑：
   * 一个未知异常换全部房间陪葬，正是这一批要拆掉的单点。
   */
  process.on('uncaughtException', (err) => {
    log('error', 'uncaught_exception', { error: err.stack ?? err.message });
  });
  process.on('unhandledRejection', (reason) => {
    log('error', 'unhandled_rejection', { error: String(reason) });
  });

  const port = Number(process.env.PORT ?? 8080);
  /** S3：Origin 白名单从环境变量来，逗号分隔（`WOWPVP_ORIGINS=https://a.com,https://b.com`）*/
  const origins = (process.env.WOWPVP_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  startServer(port, origins.length > 0 ? { allowedOrigins: origins } : {}).then((s) => {
    // S5：优雅退出 —— 停循环、掐连接、关端口，然后才退进程
    process.on('SIGTERM', () => {
      log('info', 'sigterm', {});
      void s.close().then(() => process.exit(0));
    });
    process.on('SIGINT', () => {
      log('info', 'sigint', {});
      void s.close().then(() => process.exit(0));
    });

    log('info', 'server_started', {
      port: s.port,
      tickRate: SIM.TICK_RATE,
      classes: ALL_CLASSES.length,
      originWhitelist: origins.length > 0 ? origins : '未启用',
      maxPayloadBytes: LIMITS.MAX_PAYLOAD_BYTES,
      maxConnections: LIMITS.MAX_CONNECTIONS,
    });
    console.log(`wowpvp server 已启动 —— ws://localhost:${s.port} · 健康检查 /healthz`);
  });
}
