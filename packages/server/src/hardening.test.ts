/**
 * S2/S3/S5/S6 公网硬化的集成测试 —— **真端口、真 `ws` 客户端**。
 *
 * ★ 与 Session.rate.test.ts 的分工：那支用假 socket 验令牌桶的纯逻辑，
 *   这支验「传输层与握手层」的防线 —— 它们只有真连一次才暴露
 *   （maxPayload 的 1009、origin 的握手拒绝、连接数上限、/healthz）。
 *   与 RoomServer.test.ts 同一套 TestClient 手法。
 *
 * ⚠️ 每个 case 起一个**独立服务器**（自己的阈值），随机端口，用完关掉 ——
 *   硬化参数是 per-server 的，共享一个实例会互相干扰。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { request } from 'node:http';

import { encodeClientMessage, type ClientMessage } from '@wowpvp/shared';
import { startServer, backpressureStrike, type StartedServer } from './index.js';
import { onLog } from './log.js';

let servers: StartedServer[] = [];
const spawn = async (opts: Parameters<typeof startServer>[1] = {}): Promise<StartedServer> => {
  // 心跳关掉 —— 这些测试不验半开连接，开着只会给慢 case 引入 terminate 噪音
  const s = await startServer(0, { heartbeatIntervalMs: 0, ...opts });
  servers.push(s);
  return s;
};

afterEach(async () => {
  for (const s of servers) await s.close();
  servers = [];
  onLog(undefined);
});

/** 连一个真 socket，可带 headers（origin 测试用） */
const connect = (port: number, headers?: Record<string, string>): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, headers ? { headers } : {});
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });

/** GET /healthz，返回解析后的 JSON */
const getHealthz = (port: number): Promise<{ status: number; body: Record<string, unknown> }> =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/healthz' }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end();
  });

const waitClose = (socket: WebSocket): Promise<number> =>
  new Promise((resolve) => socket.once('close', (code) => resolve(code)));

describe('S2 单条消息上限（maxPayload）', () => {
  it('★★ 超过 maxPayload 的消息触发关闭，连接不再可用', async () => {
    const s = await spawn({ maxPayloadBytes: 1024 });
    const socket = await connect(s.port);
    const closed = waitClose(socket);
    // 发一条 2KB 的消息（超 1KB 上限）——ws 以 1009（消息过大）关闭
    socket.send('x'.repeat(2048));
    const code = await closed;
    expect(code).toBe(1009);
  });

  it('★ 上限内的消息正常处理（不误伤合法流量）', async () => {
    const s = await spawn({ maxPayloadBytes: 1024 });
    const socket = await connect(s.port);
    // ★ 等 RoomState 而不是 Welcome：Welcome 在 connect 那一刻就发了，可能
    //   赶在监听器挂上之前到达；RoomState 是 JoinRoom 的应答，必在监听器之后
    let gotRoomState = false;
    socket.on('message', (raw) => {
      if (String(raw).includes('RoomState')) gotRoomState = true;
    });
    socket.send(encodeClientMessage({ t: 'JoinRoom', roomId: 'r1', name: '甲' } as ClientMessage));
    await new Promise((r) => setTimeout(r, 300));
    expect(gotRoomState).toBe(true);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });
});

describe('S3 Origin 白名单', () => {
  it('★★ 不在白名单的 Origin 被握手拒绝（跨站页面拿访问者浏览器连你）', async () => {
    const s = await spawn({ allowedOrigins: ['https://play.example.com'] });
    await expect(connect(s.port, { origin: 'https://evil.example' })).rejects.toBeDefined();
  });

  it('★ 白名单内的 Origin 放行', async () => {
    const s = await spawn({ allowedOrigins: ['https://play.example.com'] });
    const socket = await connect(s.port, { origin: 'https://play.example.com' });
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });

  it('★ 无 Origin 头（非浏览器客户端）放行 —— 防它们靠限流不靠这里', async () => {
    const s = await spawn({ allowedOrigins: ['https://play.example.com'] });
    const socket = await connect(s.port); // ws 客户端默认不带 origin
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });
});

describe('S3 连接数上限', () => {
  it('★★ 超过 maxConnections 的连接进入排队（P12：不再 1013 一关了之）', async () => {
    const s = await spawn({ maxConnections: 2 });
    const a = await connect(s.port);
    const b = await connect(s.port);
    // 第三条：握手成功，连接保持、收到排队位置 —— 1013 只留给排队队列也满的情况
    const c = await connect(s.port);
    const queued = await new Promise<string>((res, rej) => {
      const timer = setTimeout(() => rej(new Error('没等到 QueueStatus')), 3000);
      c.on('message', (raw) => {
        const t = String(raw);
        if (t.includes('"QueueStatus"')) { clearTimeout(timer); res(t); }
      });
    });
    expect(JSON.parse(queued)).toEqual({ t: 'QueueStatus', ahead: 0 });
    expect(c.readyState).toBe(WebSocket.OPEN);
    // 前两条不受影响
    expect(a.readyState).toBe(WebSocket.OPEN);
    expect(b.readyState).toBe(WebSocket.OPEN);
    a.close(); b.close(); c.close();
  });
});

describe('S3 房间与成员上限', () => {
  const recv = (socket: WebSocket): ServerMessages => {
    const msgs: Record<string, unknown>[] = [];
    socket.on('message', (raw) => msgs.push(JSON.parse(String(raw))));
    return {
      waitFor: async (t: string, ms = 2000) => {
        const deadline = Date.now() + ms;
        for (;;) {
          const hit = msgs.find((m) => m['t'] === t);
          if (hit) return hit;
          if (Date.now() > deadline) throw new Error(`等 ${t} 超时：${msgs.map((m) => m['t']).join(',')}`);
          await new Promise((r) => setTimeout(r, 20));
        }
      },
      all: msgs,
    };
  };
  interface ServerMessages {
    waitFor: (t: string, ms?: number) => Promise<Record<string, unknown>>;
    all: Record<string, unknown>[];
  }

  it('★★ 房间数满 → 拒绝新建（既有房间加入不受影响）', async () => {
    const s = await spawn({ maxRooms: 1 });
    const a = await connect(s.port);
    const ra = recv(a);
    a.send(encodeClientMessage({ t: 'JoinRoom', roomId: 'first', name: '甲' } as ClientMessage));
    await ra.waitFor('RoomState'); // 第一个房间建成

    const b = await connect(s.port);
    const rb = recv(b);
    b.send(encodeClientMessage({ t: 'JoinRoom', roomId: 'second', name: '乙' } as ClientMessage));
    const rej = await rb.waitFor('Rejected');
    expect(rej['what']).toBe('JoinRoom');
    expect(String(rej['reason'])).toContain('房间数');
    a.close(); b.close();
  });

  it('★★ 单房间成员满 → 拒绝加入', async () => {
    const s = await spawn({ maxRoomMembers: 2 });
    const a = await connect(s.port); const ra = recv(a);
    const b = await connect(s.port); const rb = recv(b);
    a.send(encodeClientMessage({ t: 'JoinRoom', roomId: 'r', name: '甲' } as ClientMessage));
    await ra.waitFor('RoomState');
    b.send(encodeClientMessage({ t: 'JoinRoom', roomId: 'r', name: '乙' } as ClientMessage));
    await rb.waitFor('RoomState');

    // 第三个人进同一房间 → 满
    const c = await connect(s.port); const rc = recv(c);
    c.send(encodeClientMessage({ t: 'JoinRoom', roomId: 'r', name: '丙' } as ClientMessage));
    const rej = await rc.waitFor('Rejected');
    expect(String(rej['reason'])).toContain('人数已达上限');
    a.close(); b.close(); c.close();
  });
});

describe('S2 背压判定（持续超阈值才断，瞬时冲高不误杀）', () => {
  const MAX = 2;
  it('★ 低于阈值：strike 清零、不断开', () => {
    expect(backpressureStrike(500, 1000, 1, MAX)).toEqual({ strikes: 0, terminate: false });
  });
  it('★ 超阈值一次：记一 strike，还不断（可能只是瞬时冲高）', () => {
    expect(backpressureStrike(2000, 1000, 0, MAX)).toEqual({ strikes: 1, terminate: false });
  });
  it('★★ 连续两个巡检都超阈值：断开（真慢读者）', () => {
    expect(backpressureStrike(2000, 1000, 1, MAX)).toEqual({ strikes: 2, terminate: true });
  });
  it('★★ 冲高一次后排空：strike 归零，不会累积成误杀', () => {
    const a = backpressureStrike(2000, 1000, 0, MAX); // 冲高
    expect(a.terminate).toBe(false);
    const b = backpressureStrike(300, 1000, a.strikes, MAX); // 下个巡检已排空
    expect(b).toEqual({ strikes: 0, terminate: false });
  });
});

describe('S6 /healthz', () => {
  it('★ 空服务器返回 ok + 零计数', async () => {
    const s = await spawn();
    const { status, body } = await getHealthz(s.port);
    expect(status).toBe(200);
    expect(body['ok']).toBe(true);
    expect(body['connections']).toBe(0);
    expect(body['rooms']).toBe(0);
    // ★ 不泄露房间码：健康端点是公开的
    expect(JSON.stringify(body)).not.toContain('roomId');
  });

  it('★ 有连接时如实计数', async () => {
    const s = await spawn();
    const a = await connect(s.port);
    await new Promise((r) => setTimeout(r, 100));
    const { body } = await getHealthz(s.port);
    expect(body['connections']).toBe(1);
    a.close();
  });
});
