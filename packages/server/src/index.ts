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

/**
 * 起一个服务器。
 *
 * ★ 抽成函数而不是写在模块顶层，是为了让集成测试能起**真的**服务器
 *   （随机端口、用完关掉）。A6 的 `verify:m10` 也走这个入口 ——
 *   测试跑的和线上跑的是同一段启动代码。
 */
export const startServer = async (port = 0): Promise<StartedServer> => {
  const rooms = new RoomServer();

  const httpServer = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('wowpvp server —— WebSocket 在同端口。\n');
  });

  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (socket: WebSocket) => {
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
