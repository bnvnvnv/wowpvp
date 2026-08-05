/**
 * 公网硬化压测判据（技术债总账 S1–S6，docs/16 批次三 3.6 的出口判据）。
 *
 * 核心判据一句话：**单客户端灌 1000 条/秒，不影响他房 tick 节奏。**
 *   这是「连上来的不再假设是自己人」的可执行证明 —— 一个改过的客户端
 *   把消息灌满，别人的比赛该 20Hz 还是 20Hz。
 *
 * 做法（真服务器、真 ws、同进程 —— 同进程恰恰是最坏情况：所有连接抢
 * 同一个事件循环，「一个人的流量饿死别人」在这里最容易发生）：
 *   1. 房间 A 起一局真比赛（两个真客户端准备 → MatchLoop 在跑）
 *   2. 量 A 的**基线** tick 速率（loop.tick 在窗口内涨了多少）
 *   3. 开若干 flooder，持续灌注（被断开就重连接着灌）
 *   4. 量 A 在**受压期**的 tick 速率
 *   5. 判据：A 的 tick 速率几乎不变；flooder 被限流并断开（日志可见）
 *
 * ★ 不依赖浏览器 —— 纯 Node + ws，可进 CI 的非浏览器验收组。
 *
 * 用法：pnpm verify:hardening
 */

import { WebSocket } from 'ws';
import { startServer } from '../packages/server/src/index.ts';
import { encodeClientMessage, asClassId, type ClientMessage } from '../packages/shared/src/index.ts';
import { onLog } from '../packages/server/src/log.ts';

const results: { id: string; name: string; pass: boolean }[] = [];
const check = (id: string, name: string, pass: boolean, detail: string): void => {
  results.push({ id, name, pass });
  console.log(`  ${pass ? '✓' : '✗'} ${id} ${name}\n      ${detail}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const send = (s: WebSocket, m: ClientMessage) => s.send(encodeClientMessage(m));

// ── 日志证据收集：限流事件计数 ────────────────────────────────────
const logCounts = new Map<string, number>();
onLog((_level, event) => logCounts.set(event, (logCounts.get(event) ?? 0) + 1));

const server = await startServer(0, { heartbeatIntervalMs: 0 });
console.log(`\n服务器已启动（本进程，端口 ${server.port}）`);

/** 连一个真 socket，等 open */
const connect = (): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${server.port}`);
    s.once('open', () => resolve(s));
    s.once('error', reject);
  });

/** 走完「加入 → 选边 → 选职业 → 准备」*/
const readyUp = (s: WebSocket, roomId: string, name: string, team: 'red' | 'blue', cls: string): void => {
  send(s, { t: 'JoinRoom', roomId, name });
  send(s, { t: 'SelectTeam', team });
  send(s, { t: 'SelectClass', classId: asClassId(cls) });
  send(s, { t: 'SetReady', ready: true });
};

/** 量房间 A 在 windowMs 内推进了多少 tick，换算成每秒 */
const measureTickRate = async (roomId: string, windowMs: number): Promise<number> => {
  const loop = server.rooms.loopOf(roomId);
  if (!loop) throw new Error(`房间 ${roomId} 没有在跑的比赛`);
  const t0 = loop.tick;
  await sleep(windowMs);
  const t1 = loop.tick;
  return (t1 - t0) / (windowMs / 1000);
};

try {
  // ── 1：房间 A 起一局真比赛 ─────────────────────────────────────
  const aRed = await connect();
  const aBlue = await connect();
  readyUp(aRed, 'A', '红甲', 'red', 'mage');
  readyUp(aBlue, 'A', '蓝乙', 'blue', 'warrior');

  // 等 MatchLoop 真的在跑
  for (let i = 0; i < 100 && !server.rooms.loopOf('A'); i++) await sleep(50);
  if (!server.rooms.loopOf('A')) throw new Error('房间 A 的比赛没能开起来');
  await sleep(500); // 让它稳定跑几十个 tick

  // ── 2：基线 tick 速率 ──────────────────────────────────────────
  const baseline = await measureTickRate('A', 2000);
  check('1', '★ 无干扰时房间 A 稳定在 ~20Hz',
    baseline >= 18 && baseline <= 22,
    `基线 ${baseline.toFixed(1)} tick/s（目标 20）`);

  // ── 3：开 flooder，持续灌注（被断开就重连接着灌）─────────────────
  const FLOODERS = 4;
  const PER_BATCH = 50;   // 每批 50 条
  const BATCH_MS = 50;    // 每 50ms 一批 → 每 flooder 1000 条/s，合计 4000/s
  let flooding = true;
  const floodInput = encodeClientMessage({
    t: 'Input', seq: 1, dt: 0.05, forward: 1, strafe: 0, characterYaw: 0, jump: false,
  } as ClientMessage);

  const startFlooder = async (n: number): Promise<void> => {
    while (flooding) {
      let s: WebSocket;
      try { s = await connect(); } catch { await sleep(50); continue; }
      // 进一个自己的房间（与 A 无关）——但灌注在任何阶段都成立
      send(s, { t: 'JoinRoom', roomId: `flood${n}`, name: `f${n}` });
      const timer = setInterval(() => {
        for (let i = 0; i < PER_BATCH; i++) {
          if (s.readyState === WebSocket.OPEN) s.send(floodInput);
        }
      }, BATCH_MS);
      // 等到这条被服务器断开（限流阈值）或洪水停止
      await new Promise<void>((resolve) => {
        s.once('close', () => resolve());
        const poll = setInterval(() => { if (!flooding) { clearInterval(poll); resolve(); } }, 100);
      });
      clearInterval(timer);
      if (s.readyState === WebSocket.OPEN) s.close();
    }
  };

  const floods = Array.from({ length: FLOODERS }, (_, i) => startFlooder(i));

  // ── 4：受压期 tick 速率 ────────────────────────────────────────
  await sleep(500); // 让洪水灌起来
  const underLoad = await measureTickRate('A', 2000);

  // ── 5：判据 ────────────────────────────────────────────────────
  const ratio = underLoad / baseline;
  check('2', '★★ 4000 条/秒灌注下，房间 A 的 tick 节奏几乎不变（≥ 基线 90%）',
    ratio >= 0.9,
    `受压 ${underLoad.toFixed(1)} tick/s（基线的 ${(ratio * 100).toFixed(0)}%）`);

  const aLoop = server.rooms.loopOf('A')!;
  check('3', '★ 房间 A 全程没有丢帧（droppedTicks 恒 0）',
    aLoop.stats.droppedTicks === 0,
    `A droppedTicks=${aLoop.stats.droppedTicks}, slowTicks=${aLoop.stats.slowTicks}, maxTickMs=${aLoop.stats.maxTickMs.toFixed(2)}`);

  flooding = false;
  await Promise.all(floods);

  check('4', '★★ flooder 被限流（rate_limited 日志）',
    (logCounts.get('rate_limited') ?? 0) > 0,
    `rate_limited 事件 ${logCounts.get('rate_limited') ?? 0} 次`);

  check('5', '★★ 持续滥用者被断开（rate_flood_disconnect 日志）',
    (logCounts.get('rate_flood_disconnect') ?? 0) > 0,
    `rate_flood_disconnect 事件 ${logCounts.get('rate_flood_disconnect') ?? 0} 次`);

  // ── 6：健康检查端点在压力后仍如实 ──────────────────────────────
  const health = server.rooms.healthSnapshot();
  check('6', '★ /healthz 聚合读数可用且不含房间码（公开端点不泄露可加入房间）',
    typeof health.connections === 'number' && typeof health.matches === 'number'
      && !JSON.stringify(health).includes('flood') && !JSON.stringify(health).includes('"A"'),
    `健康读数 ${JSON.stringify(health)}`);

  aRed.close();
  aBlue.close();
} finally {
  onLog(undefined);
  await server.close();
}

console.log(`\n${'─'.repeat(60)}`);
const failed = results.filter((r) => !r.pass);
console.log(`硬化压测：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('失败项：' + failed.map((f) => f.id).join(', '));
  process.exit(1);
}
