/**
 * 权威服务器入口。
 *
 * ⚠️ 当前是 **M0 工程连通性验证**，不是游戏服务器。
 * 它只做一件事：接受 WebSocket 连接，把 shared 层的职业数据发给客户端 ——
 * 用来证明「同一份 shared 代码能同时跑在 Node 和浏览器里」这个架构前提成立。
 *
 * 真正的房间管理、20Hz 权威 tick 和状态广播是 M1–M5 的工作，
 * 见 docs/01-development-plan.md 与 docs/08-network-protocol.md。
 */

import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

import { ALL_CLASSES, SIM, validateData } from '@wowpvp/shared';

const PORT = Number(process.env.PORT ?? 8080);

/** 启动前先跑一遍数据体检 —— 数据坏了就不该启动 */
const issues = validateData();
if (issues.length > 0) {
  console.error('职业数据校验失败，服务器拒绝启动：');
  for (const i of issues) console.error(`  ${i.where}: ${i.problem}`);
  process.exit(1);
}

const httpServer = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('wowpvp server — M0 连通性验证。WebSocket 在同端口。\n');
});

const wss = new WebSocketServer({ server: httpServer });

/** M0 阶段的握手载荷：职业名录 + 模拟参数 */
const buildRoster = () => ({
  t: 'Roster' as const,
  tickRate: SIM.TICK_RATE,
  classes: ALL_CLASSES.map((c) => ({
    id: c.id,
    name: c.name,
    role: c.role,
    baseHealth: c.baseHealth,
    resources: c.resources.map((r) => r.resource),
    strengths: c.strengths,
    weaknesses: c.weaknesses,
    skillCount: c.skills.length,
    weapons: c.weapons.map((w) => ({
      id: w.id,
      name: w.name,
      isDefault: w.isDefault,
      swingInterval: w.swingInterval,
      swingPercent: w.swingPercent,
      reach: w.reach,
      advantage: w.advantage,
      cost: w.cost,
    })),
  })),
});

wss.on('connection', (socket: WebSocket) => {
  console.log(`客户端已连接（当前 ${wss.clients.size} 个）`);
  socket.send(JSON.stringify(buildRoster()));

  socket.on('message', (raw) => {
    // M0 阶段还没有协议处理，只回显以便确认双向通道可用
    console.log('收到消息：', raw.toString().slice(0, 200));
  });

  socket.on('close', () => {
    console.log(`客户端已断开（剩余 ${wss.clients.size} 个）`);
  });
});

httpServer.listen(PORT, () => {
  console.log(`wowpvp server 已启动`);
  console.log(`  HTTP      http://localhost:${PORT}`);
  console.log(`  WebSocket ws://localhost:${PORT}`);
  console.log(`  职业数据  ${ALL_CLASSES.length} 个职业，` +
    `${ALL_CLASSES.reduce((n, c) => n + c.skills.length, 0)} 个技能，校验通过`);
});
