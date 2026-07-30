/**
 * A3 的完成判据：**两个真 WebSocket 客户端**能加入同一房间、开局、收到快照。
 *
 * ★ 这里刻意用真 socket、真端口、真 `ws` 客户端，而不是直接 new RoomServer()
 *   再喂假 socket。理由是 A3 要证明的恰恰是「跨进程之后还对不对」的第一步：
 *   编解码、连接生命周期、断线回调这几处，只有真的连一次才会暴露。
 *
 * ⚠️ 与 A6 的 `verify:m10` 的分工：那一支验「作弊尝试被拒绝」的 12 条，
 *    是安全边界；这一支只验「正常路径能跑通」。两者都要有 ——
 *    只验正常路径会漏掉作弊，只验作弊会漏掉「其实根本连不上」。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import {
  asClassId,
  encodeClientMessage,
  decodeServerMessage,
  type ClientMessage,
  type ServerMessage,
} from '@wowpvp/shared';

import { startServer, type StartedServer } from '../index.js';

let server: StartedServer;

beforeEach(async () => {
  server = await startServer(0); // 0 = 随机空闲端口，测试之间不打架
});

afterEach(async () => {
  await server.close();
});

/** 一个真客户端：连上去，把收到的消息按类型攒起来 */
class TestClient {
  readonly received: ServerMessage[] = [];
  private constructor(readonly socket: WebSocket) {}

  static async connect(port: number): Promise<TestClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const client = new TestClient(socket);
    socket.on('message', (raw) => {
      const msg = decodeServerMessage(raw.toString());
      if (msg) client.received.push(msg);
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    return client;
  }

  send(msg: ClientMessage): void {
    this.socket.send(encodeClientMessage(msg));
  }

  /** 发一条**服务器不认识**的原始帧。作弊/畸形包测试用 */
  sendRaw(raw: string): void {
    this.socket.send(raw);
  }

  get open(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  /** 等到收到某类消息为止 */
  async waitFor<K extends ServerMessage['t']>(
    kind: K,
    timeoutMs = 3000,
  ): Promise<Extract<ServerMessage, { t: K }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.received.find((m) => m.t === kind);
      if (hit) return hit as Extract<ServerMessage, { t: K }>;
      if (Date.now() > deadline) {
        throw new Error(
          `等 ${kind} 超时；已收到：${this.received.map((m) => m.t).join(', ') || '(什么都没有)'}`,
        );
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  close(): void {
    this.socket.close();
  }
}

/** 一个走完「加入 → 选边 → 选职业 → 准备」的客户端 */
const readyUp = async (
  c: TestClient,
  roomId: string,
  name: string,
  team: 'red' | 'blue',
  classId: string,
): Promise<void> => {
  c.send({ t: 'JoinRoom', roomId, name });
  await c.waitFor('RoomState');
  c.send({ t: 'SelectTeam', team });
  c.send({ t: 'SelectClass', classId: asClassId(classId) });
  c.send({ t: 'SetReady', ready: true });
};

describe('A3：两个真客户端从房间跑到快照', () => {
  it('★ 连上就收到 Welcome（含 tick 频率与插值缓冲）', async () => {
    const c = await TestClient.connect(server.port);
    const welcome = await c.waitFor('Welcome');
    expect(welcome.tickRate).toBe(20);
    expect(welcome.interpDelay).toBeCloseTo(0.1, 6);
    c.close();
  });

  it('★★ 两个客户端加入同一房间、开局、各自收到 MatchStart 与 Snapshot', async () => {
    const red = await TestClient.connect(server.port);
    const blue = await TestClient.connect(server.port);
    await red.waitFor('Welcome');
    await blue.waitFor('Welcome');

    await readyUp(red, 'r1', '红方', 'red', 'mage');
    await readyUp(blue, 'r1', '蓝方', 'blue', 'warrior');

    // 两边都要收到开局，且 you 指向**各自不同**的实体
    const redStart = await red.waitFor('MatchStart');
    const blueStart = await blue.waitFor('MatchStart');
    expect(redStart.you).not.toBe(blueStart.you);
    // ★ 重连令牌必须在开局时就发到手 —— 断线之后就发不出去了
    expect(redStart.reconnectToken.length).toBeGreaterThan(0);
    expect(redStart.reconnectToken).not.toBe(blueStart.reconnectToken);

    const snap = await red.waitFor('Snapshot');
    expect(snap.you).toBe(redStart.you);
    // 3v3 地图上两个人 —— 谁都没潜行，所以彼此都在快照里
    expect(snap.entities.map((e) => e.id).sort()).toEqual(
      [redStart.you, blueStart.you].sort(),
    );

    red.close();
    blue.close();
  });

  it('★ 快照持续推进（20Hz 定步长真的在跑）', async () => {
    const red = await TestClient.connect(server.port);
    const blue = await TestClient.connect(server.port);
    await readyUp(red, 'r2', '红方', 'red', 'mage');
    await readyUp(blue, 'r2', '蓝方', 'blue', 'warrior');
    await red.waitFor('Snapshot');

    const first = red.received.filter((m) => m.t === 'Snapshot').length;
    await new Promise((r) => setTimeout(r, 300)); // 约 6 个 tick
    const later = red.received.filter((m) => m.t === 'Snapshot').length;

    expect(later, '快照没有继续到达 —— 循环可能没跑起来').toBeGreaterThan(first);
    // ★ 时间必须在走：只发同一份快照也能让计数上涨
    const snaps = red.received.filter((m) => m.t === 'Snapshot');
    const t0 = snaps[0]!.time;
    const tN = snaps[snaps.length - 1]!.time;
    expect(tN, '模拟时间没有推进').toBeGreaterThan(t0);

    red.close();
    blue.close();
  });

  /**
   * ★★ 畸形包不该拖垮房间（protocol.ts 的「拒绝不等于掉线」）。
   *   这条是 `verify:m10` 第 6 条的**单进程预演** —— 在 A6 之前就把它钉住，
   *   因为「一个坏包踢掉整个房间」这种 bug 改起来越晚越贵。
   */
  it('★★ 发一条协议里没有的消息 → 收到 Rejected，且连接仍然活着', async () => {
    const c = await TestClient.connect(server.port);
    await c.waitFor('Welcome');

    c.sendRaw(JSON.stringify({ t: 'GiveMeAllTheDamage', amount: 99999 }));
    const rejected = await c.waitFor('Rejected');
    expect(rejected.what).toBe('parse');

    expect(c.open, '一个坏包把连接搞掉线了').toBe(true);
    // 还能继续正常说话
    c.send({ t: 'JoinRoom', roomId: 'r3', name: '还活着' });
    await c.waitFor('RoomState');
    c.close();
  });

  /**
   * ★★ `verify:m10` 第 7 条的单进程预演：对**不在自己可见集合里**的目标
   *   发 `SetTarget` 必须被拒绝。
   *
   *   这不只是「参数校验」—— 改前端的人可以拿 `SetTarget` 当**探针**，
   *   一个个试 id 来确认场上有谁。所以拒绝理由必须是笼统的：
   *   说「实体 9999 不可见」就等于确认了 9999 存在。
   */
  it('★★ 对不可见/不存在的目标发 SetTarget → 被拒绝，且理由不泄露该 id', async () => {
    const red = await TestClient.connect(server.port);
    const blue = await TestClient.connect(server.port);
    await readyUp(red, 'r5', '红方', 'red', 'mage');
    await readyUp(blue, 'r5', '蓝方', 'blue', 'warrior');
    await red.waitFor('MatchStart');

    red.received.length = 0;
    red.send({ t: 'SetTarget', slot: 'hard', entityId: 9999 as never });
    const rejected = await red.waitFor('Rejected');

    expect(rejected.what).toBe('SetTarget');
    expect(rejected.reason, '拒绝理由泄露了被探测的实体 id').not.toContain('9999');
    expect(red.open, '被拒绝不该掉线').toBe(true);

    red.close();
    blue.close();
  });

  /** ★ 选中**看得见**的敌人是允许的 —— 否则上一条测试可能只是「全都拒绝」*/
  it('★ 选中可见的敌人不会被拒绝（证明上一条不是一刀切）', async () => {
    const red = await TestClient.connect(server.port);
    const blue = await TestClient.connect(server.port);
    await readyUp(red, 'r6', '红方', 'red', 'mage');
    await readyUp(blue, 'r6', '蓝方', 'blue', 'warrior');
    const blueStart = await blue.waitFor('MatchStart');
    await red.waitFor('Snapshot');

    red.received.length = 0;
    red.send({ t: 'SetTarget', slot: 'hard', entityId: blueStart.you });
    await new Promise((r) => setTimeout(r, 200));

    expect(
      red.received.filter((m) => m.t === 'Rejected'),
      '选中一个看得见的敌人被拒绝了',
    ).toEqual([]);

    red.close();
    blue.close();
  });

  /**
   * ★★ `verify:m10` 第 5 条的单进程预演：客户端伪造一个大 `dt` 不能瞬移。
   *
   *   这条能过**不是因为校验拦住了**，而是因为服务器的积分步长根本不来自
   *   客户端 —— `MatchLoop` 用的是 `SIM.TICK_DT`。所以这里发的 dt 再大也
   *   只是个被忽略的字段。测的是这个**结构性**事实：哪天有人「顺手」改成
   *   用 `latest.dt` 积分，这条会立刻红。
   */
  it('★★ 伪造大 dt 不能加速移动（服务器步长不来自客户端）', async () => {
    const red = await TestClient.connect(server.port);
    const blue = await TestClient.connect(server.port);
    await readyUp(red, 'r8', '红方', 'red', 'mage');
    await readyUp(blue, 'r8', '蓝方', 'blue', 'warrior');
    const start = await red.waitFor('MatchStart');
    await red.waitFor('Snapshot');

    // 一路狂发「全速前进」，且把 dt 顶到协议允许的上限（0.25）——
    // 若服务器拿它当步长，速度会是正常的 5 倍
    let seq = 1;
    const pump = setInterval(() => {
      red.send({
        t: 'Input', seq: seq++, dt: 0.24,
        forward: 1, strafe: 0, characterYaw: 0, jump: false,
      });
    }, 10);
    await new Promise((r) => setTimeout(r, 600));
    clearInterval(pump);
    await new Promise((r) => setTimeout(r, 100));

    const snaps = red.received.filter((m) => m.t === 'Snapshot');
    const posOf = (s: typeof snaps[number]) =>
      s.entities.find((e) => e.id === start.you)!.position;
    const first = snaps[0]!;
    const last = snaps[snaps.length - 1]!;
    const dx = posOf(last).x - posOf(first).x;
    const dz = posOf(last).z - posOf(first).z;
    const moved = Math.hypot(dx, dz);
    const simElapsed = last.time - first.time;

    // BASE_SPEED = 7 m/s。留 1.5 倍余量给加速度与可能的移速加成；
    // dt 若被采信，速度会是 0.24/0.05 ≈ 4.8 倍，远超这个上限
    const cap = 7 * simElapsed * 1.5;
    expect(simElapsed, '模拟时间没推进，这条测试就没意义').toBeGreaterThan(0.2);
    /**
     * ★ 先证明**他确实在动**。否则「位移没超上限」可以因为角色压根没动而
     *   平凡地成立 —— 那样这条测试永远不会红，比没有测试更糟。
     */
    expect(moved, '角色根本没动，上限断言是平凡成立的').toBeGreaterThan(0.5);
    expect(
      moved,
      `位移 ${moved.toFixed(2)}m 超过了 ${simElapsed.toFixed(2)}s 内的合理上限 ` +
      `${cap.toFixed(2)}m —— 服务器可能采信了客户端的 dt`,
    ).toBeLessThanOrEqual(cap);

    red.close();
    blue.close();
  });

  /**
   * ★ M11 把消耗品接上了（技术债 #6），所以 `UseConsumable` **不再被拒绝**。
   *   ⚠️ 这条测试原本断言「被拒绝」—— 接线之后它红了，而红得对：
   *      改的是产品行为，测试就该跟着改，不是把它删掉。
   */
  it('★ UseConsumable 已接线：不再被拒绝（技术债 #6）', async () => {
    const red = await TestClient.connect(server.port);
    const blue = await TestClient.connect(server.port);
    await readyUp(red, 'r7', '红方', 'red', 'mage');
    await readyUp(blue, 'r7', '蓝方', 'blue', 'warrior');
    await red.waitFor('MatchStart');

    red.received.length = 0;
    red.send({ t: 'UseConsumable', slot: 0 });   // 槽位是空的，但路径应当通
    await new Promise((r) => setTimeout(r, 250));

    expect(
      red.received.filter((m) => m.t === 'Rejected'),
      'UseConsumable 仍在被拒绝 —— 使用路径没接上',
    ).toEqual([]);
    expect(red.open).toBe(true);

    red.close();
    blue.close();
  });

  /**
   * ★★ 与上一条成对：**没有规则的东西仍然要诚实拒绝**，不静默丢弃。
   *   解控饰品的规则写在 `effects/combat.ts` 里，但它需要一个 EffectContext ——
   *   也就是说它是效果结算，而结算只有 tickWorld 一个出口。接它要先在 tick 里
   *   加一步，那是显眼的改动，不该在路由层偷做。
   */
  it('★★ UseTrinket 仍被诚实拒绝，且理由说明为什么', async () => {
    const red = await TestClient.connect(server.port);
    const blue = await TestClient.connect(server.port);
    await readyUp(red, 'r9', '红方', 'red', 'mage');
    await readyUp(blue, 'r9', '蓝方', 'blue', 'warrior');
    await red.waitFor('MatchStart');

    red.received.length = 0;
    red.send({ t: 'UseTrinket' });
    const rejected = await red.waitFor('Rejected');
    expect(rejected.what).toBe('UseTrinket');
    expect(rejected.reason.length, '拒绝要说明原因，不能是空话').toBeGreaterThan(0);
    expect(red.open).toBe(true);

    red.close();
    blue.close();
  });

  /** ★ 阶段鉴权：比赛开始后再发 SelectClass 是越权 */
  it('★ 战斗中发 SelectClass 被拒绝（阶段鉴权）', async () => {
    const red = await TestClient.connect(server.port);
    const blue = await TestClient.connect(server.port);
    await readyUp(red, 'r4', '红方', 'red', 'mage');
    await readyUp(blue, 'r4', '蓝方', 'blue', 'warrior');
    await red.waitFor('MatchStart');

    red.received.length = 0;
    red.send({ t: 'SelectClass', classId: asClassId('priest') });
    const rejected = await red.waitFor('Rejected');
    expect(rejected.what).toBe('SelectClass');
    expect(red.open).toBe(true);

    red.close();
    blue.close();
  });
});
