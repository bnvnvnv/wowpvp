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
  asWeaponId,
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

  /**
   * ── M13 赛后复位（docs/14 §M13）─────────────────────────────
   *
   * 「MatchEnd 后回到房间页可再开一局」的**服务器侧闭环**。
   * 在 resetAfterMatch 之前，房间打完一局就是死路：started 永不复位、
   * session 停在 Match 阶段，赛后的 SelectClass/SetReady 全被拒绝。
   *
   * ★ 结束一局用的是 verify:m10 的同一套白盒手法：advance() 快进过
   *   18 秒准备阶段，把败方打死，再 advance 过结算窗口 —— 布置是白盒的，
   *   断言全部落在客户端**真实收到的消息**上。
   */
  it('★★ M13：MatchEnd 后房间复位 → 换职业 → 全员再准备 → 第二局开起来', async () => {
    const red = await TestClient.connect(server.port);
    const blue = await TestClient.connect(server.port);
    await readyUp(red, 'rematch', '红方', 'red', 'mage');
    await readyUp(blue, 'rematch', '蓝方', 'blue', 'warrior');
    const start1 = await red.waitFor('MatchStart');
    const blueStart1 = await blue.waitFor('MatchStart');

    // 白盒收尾：快进过准备阶段 → 打死蓝方 → 快进过结算窗口
    const match = server.rooms.matchOf('rematch')!;
    const loop = server.rooms.loopOf('rematch')!;
    for (let i = 0; i < 400 && !match.arena?.outcome; i++) loop.advance();
    const loser = match.world.entities.get(blueStart1.you)!;
    loser.alive = false;
    loser.health = 0;
    for (let i = 0; i < 60 && !match.arena?.outcome; i++) loop.advance();
    await red.waitFor('MatchEnd');
    await blue.waitFor('MatchEnd');

    // ★ MatchEnd 之后必须跟一条「回到房间」的 RoomState：
    //   started=false、全员 ready 清空、阵营与职业保留
    const afterEnd = (c: TestClient) => {
      const idx = c.received.findIndex((m) => m.t === 'MatchEnd');
      return c.received.slice(idx + 1);
    };
    const deadline = Date.now() + 3000;
    let roomState: Extract<ServerMessage, { t: 'RoomState' }> | undefined;
    while (!roomState && Date.now() < deadline) {
      roomState = afterEnd(red).find(
        (m): m is Extract<ServerMessage, { t: 'RoomState' }> => m.t === 'RoomState',
      );
      if (!roomState) await new Promise((r) => setTimeout(r, 20));
    }
    expect(roomState, 'MatchEnd 后没有收到复位的 RoomState').toBeDefined();
    expect(roomState!.started).toBe(false);
    expect(roomState!.players.every((p) => !p.ready)).toBe(true);
    expect(roomState!.players.find((p) => p.name === '红方')?.classId).toBe('mage');

    // ★ 上一局的重连令牌此刻必须作废 —— 它指向的那局已经不存在
    const probe = await TestClient.connect(server.port);
    probe.send({ t: 'Reconnect', token: start1.reconnectToken });
    const tokenRejected = await probe.waitFor('Rejected');
    expect(tokenRejected.what).toBe('Reconnect');
    probe.close();

    // ★ 阶段已回 Room、职业锁已解：换职业不再被拒绝
    red.received.length = 0;
    red.send({ t: 'SelectClass', classId: asClassId('priest') });
    const echoed = await red.waitFor('RoomState');
    expect(
      red.received.filter((m) => m.t === 'Rejected'),
      '赛后换职业仍被拒绝 —— 阶段或职业锁没有复位',
    ).toEqual([]);
    expect(echoed.players.find((p) => p.name === '红方')?.classId).toBe('priest');

    // ★ 全员重新准备 → 第二局真的开起来（新 MatchStart + 新快照在流）
    red.received.length = 0;
    blue.received.length = 0;
    red.send({ t: 'SetReady', ready: true });
    blue.send({ t: 'SetReady', ready: true });
    const start2 = await red.waitFor('MatchStart');
    await blue.waitFor('MatchStart');
    await red.waitFor('Snapshot');
    // 新令牌属于新的一局，不该沿用上一局的
    expect(start2.reconnectToken).not.toBe(start1.reconnectToken);

    red.close();
    blue.close();
  });

  /**
   * ★ M13：败方**中途退出**的一局结束后，他不在复位名单里 ——
   *   留着等于一个永不准备的名额，房间从此再也开不了局。
   */
  it('★ M13：中途退出的人不进复位名单，且能重新按码加入', async () => {
    const red = await TestClient.connect(server.port);
    const blue = await TestClient.connect(server.port);
    await readyUp(red, 'quitroom', '红方', 'red', 'mage');
    await readyUp(blue, 'quitroom', '蓝方', 'blue', 'warrior');
    await red.waitFor('MatchStart');
    await blue.waitFor('MatchStart');

    // 蓝方中途退出 → 按淘汰处理（11.5）→ 只剩红方，回合结算 → MatchEnd
    blue.send({ t: 'LeaveMatch' });
    const match = server.rooms.matchOf('quitroom')!;
    const loop = server.rooms.loopOf('quitroom')!;
    for (let i = 0; i < 500 && !match.arena?.outcome; i++) loop.advance();
    await red.waitFor('MatchEnd');

    const idx = red.received.findIndex((m) => m.t === 'MatchEnd');
    const deadline = Date.now() + 3000;
    let rs: Extract<ServerMessage, { t: 'RoomState' }> | undefined;
    while (!rs && Date.now() < deadline) {
      rs = red.received.slice(idx + 1).find(
        (m): m is Extract<ServerMessage, { t: 'RoomState' }> => m.t === 'RoomState',
      );
      if (!rs) await new Promise((r) => setTimeout(r, 20));
    }
    expect(rs!.players.map((p) => p.name)).toEqual(['红方']);

    // ★ 退出者的 session 已被放干净：按码重新加入同一房间必须成功
    blue.received.length = 0;
    blue.send({ t: 'JoinRoom', roomId: 'quitroom', name: '蓝方回归' });
    const back = await blue.waitFor('RoomState');
    expect(back.players.map((p) => p.name).sort()).toEqual(['红方', '蓝方回归']);
    expect(blue.received.filter((m) => m.t === 'Rejected')).toEqual([]);

    red.close();
    blue.close();
  });

  /**
   * ★★ A1（技术债总账）：LeaveMatch 的淘汰必须走真实死亡漏斗。
   *
   *   此前 eliminate() 直改 `alive/health` —— 注释声称在执行 11.5
   *   「不能通过退出规避死亡统计」，实现却恰好绕开了它：deaths 不记、
   *   10.10 的临时装备不清、对手收不到 Death。三条断言各对着一个洞。
   *   ★ 变异测试：把 tick 第 0 步改回「只改字段、不发事件」，三条全红。
   */
  it('★★ A1：LeaveMatch 走死亡漏斗 —— 对手收到 Death（无凶手）、临时装备清空、deaths 记 1', async () => {
    const red = await TestClient.connect(server.port);
    const blue = await TestClient.connect(server.port);
    await readyUp(red, 'a1', '红方', 'red', 'mage');
    await readyUp(blue, 'a1', '蓝方', 'blue', 'warrior');
    await red.waitFor('MatchStart');
    const blueStart = await blue.waitFor('MatchStart');

    // 白盒布置：给蓝方塞一件临时武器 —— 10.10「死亡后临时装备失效」要验的对象
    const match = server.rooms.matchOf('a1')!;
    const loop = server.rooms.loopOf('a1')!;
    const blueEntity = match.world.entities.get(blueStart.you)!;
    const blueLoadout = match.loadouts.get(blueStart.you)!;
    blueLoadout.spareWeapons.push(asWeaponId('warrior.greatsword'));

    red.received.length = 0;
    blue.send({ t: 'LeaveMatch' });

    // 弃权在下一 tick 的死亡漏斗里结算，对手必须收到 Death
    const death = await red.waitFor('Death');
    expect(death.entityId).toBe(blueStart.you);
    // killerId 如实缺席：弃权没有凶手 —— 编一个会让击杀播报冤枉人（M16a 同则）
    expect(death.killerId).toBeUndefined();

    // 死亡漏斗的状态收尾真的发生了（settleDeaths 一条链）
    expect(blueEntity.alive).toBe(false);
    expect(blueLoadout.spareWeapons, '10.10：临时装备没有随死亡清空').toEqual([]);
    expect(blueEntity.weaponId).toBe(blueLoadout.defaultWeaponId);

    // 11.5：主动退出不能规避死亡统计 —— 结算面板里蓝方 deaths = 1
    for (let i = 0; i < 500 && !match.arena?.outcome; i++) loop.advance();
    const stats = await red.waitFor('MatchStats');
    const blueRow = stats.rows.find((r) => r.entityId === blueStart.you);
    expect(blueRow, '结算面板里没有退出者的行').toBeDefined();
    expect(blueRow!.deaths, '11.5：deaths 没有记上这次淘汰').toBe(1);

    red.close();
    blue.close();
  });

  /**
   * ★ M13：开局前离开房间后，session 要被放干净 —— 此前 `session.roomId`
   *   一直挂着，之后任何 JoinRoom 都被「已经在一个房间里了」拒绝。
   *   大厅有了「离开房间」按钮，这条路径第一次真的被走到。
   */
  it('★ M13：开局前离开房间 → 能加入另一个房间（session 被放干净）', async () => {
    const c = await TestClient.connect(server.port);
    await c.waitFor('Welcome');
    c.send({ t: 'JoinRoom', roomId: 'left-a', name: '游子' });
    await c.waitFor('RoomState');

    c.send({ t: 'LeaveMatch' });
    await new Promise((r) => setTimeout(r, 100));

    c.received.length = 0;
    c.send({ t: 'JoinRoom', roomId: 'left-b', name: '游子' });
    const rs = await c.waitFor('RoomState');
    expect(rs.players.map((p) => p.name)).toEqual(['游子']);
    expect(
      c.received.filter((m) => m.t === 'Rejected'),
      '离开旧房间后加入新房间仍被拒绝 —— session.roomId 没清',
    ).toEqual([]);
    c.close();
  });

  /**
   * ★★ A6（技术债总账）：已在房间里的连接不能兑换重连令牌。
   *
   *   此前 `onReconnect` 不查 `session.roomId` 直接覆写 —— 旧房间的
   *   sessions/名单里永远留着这条会话，`dropIfEmpty()` 恒 false，
   *   房间与名单**永久泄漏**。
   */
  it('★★ A6：已在房间的连接兑换别房令牌 → 被拒；离开房间后同一令牌可兑换（对照）', async () => {
    // 房 a6a：两人开局，蓝方拿到令牌后断线（令牌进入可兑换状态）
    const red = await TestClient.connect(server.port);
    const blue = await TestClient.connect(server.port);
    await readyUp(red, 'a6a', '红方', 'red', 'mage');
    await readyUp(blue, 'a6a', '蓝方', 'blue', 'warrior');
    await red.waitFor('MatchStart');
    const blueStart = await blue.waitFor('MatchStart');
    blue.socket.terminate();
    await red.waitFor('PeerDisconnected');

    // 另一条连接先加入房 a6b（session.roomId 挂上），再拿 a6a 的令牌重连
    const drifter = await TestClient.connect(server.port);
    drifter.send({ t: 'JoinRoom', roomId: 'a6b', name: '游子' });
    await drifter.waitFor('RoomState');

    drifter.received.length = 0;
    drifter.send({ t: 'Reconnect', token: blueStart.reconnectToken });
    const rejected = await drifter.waitFor('Rejected');
    expect(rejected.what).toBe('Reconnect');

    // ★ 阳性对照：离开房间（session 放干净）之后，同一令牌必须能兑换成功 ——
    //   否则上一条可能只是「Reconnect 全都拒绝」
    drifter.send({ t: 'LeaveMatch' });
    await new Promise((r) => setTimeout(r, 100));
    drifter.received.length = 0;
    drifter.send({ t: 'Reconnect', token: blueStart.reconnectToken });
    const rejoined = await drifter.waitFor('MatchStart');
    expect(rejoined.you).toBe(blueStart.you); // 接管的是同一具身体（令牌即身份）

    red.close();
    drifter.close();
  });

  /**
   * ★★ A3（技术债总账）：半开连接由心跳识别，走与正常断线**同一条**接管路径。
   *
   *   半开连接（断电/拔网线/NAT 超时）不触发 'close' —— 心跳落地之前，
   *   偏差 #14「断线瞬间接管」只对优雅关闭的连接成立，最常见的断线形态下
   *   那个角色是一具站着挨打的尸体，直到 TCP 自己超时（可能十几分钟）。
   *
   *   模拟手法：暂停客户端的底层 TCP 读取 —— pong 是 ws 库读到 ping 帧时
   *   自动回复的（RFC 6455），读不到 ping 自然不会回，对服务器与拔网线同观。
   *   ★ 变异测试：把心跳里的 terminate 拿掉，这条在 waitFor 超时上红。
   */
  it('★★ A3：半开连接触发心跳淘汰 → 对手收到 PeerDisconnected，角色由人机接管', async () => {
    const hb = await startServer(0, { heartbeatIntervalMs: 120, heartbeatMaxMisses: 2 });
    const red = await TestClient.connect(hb.port);
    const blue = await TestClient.connect(hb.port);
    try {
      await readyUp(red, 'a3', '红方', 'red', 'mage');
      await readyUp(blue, 'a3', '蓝方', 'blue', 'warrior');
      await red.waitFor('MatchStart');
      const blueStart = await blue.waitFor('MatchStart');

      // 半开开始：从此蓝方什么都收不到、也不再回 pong —— 但 TCP 没有断
      (blue.socket as unknown as { _socket: { pause(): void } })._socket.pause();

      const gone = await red.waitFor('PeerDisconnected', 5000);
      expect(gone.playerId.length).toBeGreaterThan(0);

      // 偏差 #14：接管的是**同一具身体** —— 角色仍在世界里且活着，不是消失/判死
      const match = hb.rooms.matchOf('a3')!;
      const blueEntity = match.world.entities.get(blueStart.you)!;
      expect(blueEntity.alive, '半开断线的角色应由人机接管，而不是消失或判死').toBe(true);
    } finally {
      blue.socket.terminate();
      red.socket.terminate();
      await hb.close();
    }
  });

  /**
   * ★ A8（技术债总账）：军械箱两条消息补进 MATCH_ONLY 白名单。
   *   此前靠下游 enqueue 的「比赛未进行」兜住 —— 断言必须钉住**阶段**这一层
   *   的拒绝理由，否则测的只是下游兜底、白名单摘掉也照样绿。
   */
  it('★ A8：房间阶段发 OpenArmory / ChooseArsenal → 被阶段鉴权拒绝', async () => {
    const c = await TestClient.connect(server.port);
    await c.waitFor('Welcome');
    c.send({ t: 'JoinRoom', roomId: 'a8', name: '性急' });
    await c.waitFor('RoomState');

    c.received.length = 0;
    c.send({ t: 'OpenArmory', armoryId: 1 });
    const r1 = await c.waitFor('Rejected');
    expect(r1.what).toBe('OpenArmory');
    expect(r1.reason, '拒绝理由应来自阶段鉴权，不是下游兜底').toContain('阶段');

    c.received.length = 0;
    c.send({ t: 'ChooseArsenal', armoryId: 1, choice: 'offense' as never });
    const r2 = await c.waitFor('Rejected');
    expect(r2.what).toBe('ChooseArsenal');
    expect(r2.reason).toContain('阶段');

    expect(c.open).toBe(true);
    c.close();
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
