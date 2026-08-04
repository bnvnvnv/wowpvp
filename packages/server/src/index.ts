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
import type { SessionSocket } from './room/Session.js';

/** 把 `ws` 的 WebSocket 适配成 Session 需要的三件事 */
const adapt = (socket: WebSocket): SessionSocket => ({
  send: (data) => { if (socket.readyState === socket.OPEN) socket.send(data); },
  close: () => socket.close(),
  get closed() { return socket.readyState !== socket.OPEN; },
});

export interface StartedServer {
  port: number;
  rooms: RoomServer;
  close: () => Promise<void>;
}

export interface ServerOptions {
  /** 心跳 ping 间隔（毫秒）。0 = 关闭心跳（需要绝对安静线路的测试用） */
  heartbeatIntervalMs?: number;
  /** 连续几次 ping 没等到 pong 就按半开连接 terminate */
  heartbeatMaxMisses?: number;
}

/**
 * 起一个服务器。
 *
 * ★ 抽成函数而不是写在模块顶层，是为了让集成测试能起**真的**服务器
 *   （随机端口、用完关掉）。A6 的 `verify:m10` 也走这个入口 ——
 *   测试跑的和线上跑的是同一段启动代码。
 */
export const startServer = async (port = 0, opts: ServerOptions = {}): Promise<StartedServer> => {
  const rooms = new RoomServer();

  const httpServer = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('wowpvp server —— WebSocket 在同端口。\n');
  });

  const wss = new WebSocketServer({ server: httpServer });

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
  const heartbeat = heartbeatMs > 0
    ? setInterval(() => {
        for (const socket of wss.clients) {
          if (socket.readyState !== socket.OPEN) continue;
          const misses = missesOf.get(socket) ?? 0;
          if (misses >= maxMisses) { socket.terminate(); continue; }
          missesOf.set(socket, misses + 1);
          socket.ping();
        }
      }, heartbeatMs)
    : undefined;

  wss.on('connection', (socket: WebSocket) => {
    missesOf.set(socket, 0);
    socket.on('pong', () => missesOf.set(socket, 0));
    const session = rooms.connect(adapt(socket));

    socket.on('message', (raw) => {
      /**
       * ★★ **这里必须 try/catch。**
       *   `Session.handleRaw` 自己不抛（畸形包走返回值），但 `ws` 的
       *   message 处理器一旦抛异常就是**未捕获异常**，会带走整个进程 ——
       *   而这个进程里跑着别人的比赛。一条坏包不该拖垮整个房间，
       *   更不该拖垮整台服务器。
       */
      try {
        session.handleRaw(raw.toString());
      } catch (err) {
        console.error('处理消息时异常（连接保持）：', err);
        session.reject('internal', '服务器处理该消息时出错');
      }
    });

    socket.on('close', () => rooms.disconnect(session));
    // ★ 传输层错误也当断线处理，否则连接半死不活地留在房间名单里
    socket.on('error', () => rooms.disconnect(session));
  });

  await new Promise<void>((resolve) => httpServer.listen(port, resolve));
  const addr = httpServer.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;

  return {
    port: actualPort,
    rooms,
    close: async () => {
      if (heartbeat) clearInterval(heartbeat);
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

  const port = Number(process.env.PORT ?? 8080);
  startServer(port).then((s) => {
    console.log('wowpvp server 已启动');
    console.log(`  HTTP      http://localhost:${s.port}`);
    console.log(`  WebSocket ws://localhost:${s.port}`);
    console.log(`  tick      ${SIM.TICK_RATE} Hz（定步长 ${SIM.TICK_DT.toFixed(3)}s）`);
    console.log(`  职业数据  ${ALL_CLASSES.length} 个职业，校验通过`);
  });
}
