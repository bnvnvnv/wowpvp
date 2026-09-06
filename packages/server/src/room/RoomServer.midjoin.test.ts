/**
 * W24 的**接线**验收：运行中的房间可以观战，也可以中途加入。
 * 用户拍板 2026-08-10：「运行中房间可以观战，也可以中途加入（根据房间当前
 * 队伍情况，比如红队满了，那就只能加入蓝队，可以自己选择职业）」。
 *
 * ★ 与 `RoomServer.test.ts` 同一套真端口 / 真 `ws` 客户端的手法 ——
 *   本批要证的恰恰是「从协议到世界这条链通不通」，而本仓库最常见的失败
 *   模式是「规则写对了、没有人调用它」。规则本身（可见集口径、名单变更、
 *   装配）分别由 `net/visibility.test.ts`、`sim/match/room.test.ts`、
 *   `sim/match/joinInProgress.test.ts` 钉。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import {
  applyAura,
  asClassId,
  asWeaponId,
  decodeServerMessage,
  DispelType,
  encodeClientMessage,
  listEntities,
  type ClientMessage,
  type ServerMessage,
} from '@wowpvp/shared';

import { startServer, type StartedServer } from '../index.js';

let server: StartedServer;

beforeEach(async () => {
  server = await startServer(0);
});

afterEach(async () => {
  await server.close();
});

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

  all<K extends ServerMessage['t']>(kind: K): Extract<ServerMessage, { t: K }>[] {
    return this.received.filter((m) => m.t === kind) as Extract<ServerMessage, { t: K }>[];
  }

  /** 等到第 n 条（1 起）某类消息 —— 中途加入会收到**第二条** MatchStart */
  async waitForNth<K extends ServerMessage['t']>(
    kind: K,
    n = 1,
    timeoutMs = 4000,
  ): Promise<Extract<ServerMessage, { t: K }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hits = this.all(kind);
      if (hits.length >= n) return hits[n - 1]!;
      if (Date.now() > deadline) {
        throw new Error(
          `等第 ${n} 条 ${kind} 超时；已收到：${this.received.map((m) => m.t).join(', ')}`,
        );
      }
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  /**
   * 等到某一份 `RoomState` **满足内容判据**为止。
   *
   * ★★ 与 `waitForNth('RoomState', n+1)` 的差别是一条真 flake（W24 收口在
   *   满负载全量跑里抓到的）：房间广播是**扇出**的，一条与本次操作无关的
   *   RoomState（例如他自己入场观战那一条）可能正好在计数之后落地，
   *   于是「多等一条」等到的是陈旧的那一份。名单类断言一律用这个。
   */
  async waitForRoomState(
    pred: (s: Extract<ServerMessage, { t: 'RoomState' }>) => boolean,
    timeoutMs = 4000,
  ): Promise<Extract<ServerMessage, { t: 'RoomState' }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      // ★ 从后往前找（lib 目标没有 findLast）—— 要的是**最新**那一份
      const states = this.all('RoomState');
      for (let i = states.length - 1; i >= 0; i--) {
        if (pred(states[i]!)) return states[i]!;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `等一份满足判据的 RoomState 超时；最后一份：${JSON.stringify(this.all('RoomState').at(-1))}`,
        );
      }
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  /** 等一份**此刻之后**新到的快照（白盒改完状态再断言用） */
  async nextSnapshot(timeoutMs = 4000): Promise<Extract<ServerMessage, { t: 'Snapshot' }>> {
    const seen = this.all('Snapshot').length;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hits = this.all('Snapshot');
      if (hits.length > seen) return hits[hits.length - 1]!;
      if (Date.now() > deadline) throw new Error('等新快照超时');
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  close(): void { this.socket.close(); }
}

/**
 * 开一局「一个真人 + 人机补位」的房间，返回房主客户端。
 * ★ 人机补位是中途加入的**前提场景**：队伍被补满了，能坐的只有人机席位。
 */
const startFilledRoom = async (
  roomId: string,
  mode?: string,
): Promise<TestClient> => {
  const host = await TestClient.connect(server.port);
  await host.waitForNth('Welcome');
  host.send({ t: 'JoinRoom', roomId, name: '房主' });
  await host.waitForNth('RoomState');
  if (mode) host.send({ t: 'SetRoomMode', mode: mode as never });
  host.send({ t: 'SetFillWithBots', enabled: true });
  host.send({ t: 'SelectTeam', team: 'red' });
  host.send({ t: 'SelectClass', classId: asClassId('warrior') });
  host.send({ t: 'SetReady', ready: true });
  await host.waitForNth('MatchStart');
  return host;
};

// ════════════════════════════════════════════════════════════════
//  观战
// ════════════════════════════════════════════════════════════════

describe('W24 观战：运行中的房间进得去', () => {
  it('★★ 对局中 JoinRoom 一个 started 房间 → 立即以观战席入场（不再是「比赛已开始」）', async () => {
    const host = await startFilledRoom('w1');
    const watcher = await TestClient.connect(server.port);
    await watcher.waitForNth('Welcome');

    watcher.send({ t: 'JoinRoom', roomId: 'w1', name: '观众' });
    const start = await watcher.waitForNth('MatchStart');

    expect(start.spectating).toBe(true);
    // ★ you 是「在看谁」——默认跟随场上第一个可跟的对象，不是 0
    expect(start.you as number).toBeGreaterThan(0);
    expect(watcher.all('Rejected')).toHaveLength(0);

    // 观战席收得到快照，且**没有 self 段**（冷却是 §4.3 不发给非队友的东西）
    const snap = await watcher.nextSnapshot();
    expect(snap.entities.length).toBeGreaterThan(0);
    expect(snap.self).toBeUndefined();

    host.close(); watcher.close();
  });

  it('★★ 房间阶段选了观战席的人，开局随队收到 MatchStart（M13 的边界就此关闭）', async () => {
    const host = await TestClient.connect(server.port);
    const watcher = await TestClient.connect(server.port);
    await host.waitForNth('Welcome');
    await watcher.waitForNth('Welcome');

    host.send({ t: 'JoinRoom', roomId: 'w2', name: '房主' });
    await host.waitForNth('RoomState');
    host.send({ t: 'SetFillWithBots', enabled: true });
    watcher.send({ t: 'JoinRoom', roomId: 'w2', name: '观众' });
    await watcher.waitForNth('RoomState');
    // ★ 观战席不选职业、不准备（room.ts：观战席不需要准备）
    host.send({ t: 'SelectTeam', team: 'red' });
    host.send({ t: 'SelectClass', classId: asClassId('warrior') });
    host.send({ t: 'SetReady', ready: true });

    const start = await watcher.waitForNth('MatchStart');
    expect(start.spectating).toBe(true);
    await watcher.nextSnapshot();

    host.close(); watcher.close();
  });

  /**
   * ★★ **观战段 = 两队可见集的交集**（W24 的设计裁决，理由见
   *   `isVisibleToSpectator`）：两队都没发现的潜行者对观战者不存在。
   *   字面的「并集」会让观战席给全场潜行者点名 —— 那是换了个入口的透视。
   */
  it('★★ 未被发现的潜行者不进观战者的快照；被发现之后才进', async () => {
    const host = await startFilledRoom('w3');
    const hostStart = host.all('MatchStart')[0]!;
    const watcher = await TestClient.connect(server.port);
    await watcher.waitForNth('Welcome');
    watcher.send({ t: 'JoinRoom', roomId: 'w3', name: '观众' });
    await watcher.waitForNth('MatchStart');

    const match = server.rooms.matchOf('w3')!;
    /**
     * ★ 手动驱动这局（`loop.stop()` + `advance()`）：人机会互相靠近，
     *   3 米内的接近侦测会把潜行者揭出来 —— 那是另一条规则，会让这条
     *   测试变成抛硬币。停掉自动 tick，只推我们要的那几拍。
     */
    const loop = server.rooms.loopOf('w3')!;
    loop.stop();

    /**
     * ⚠️ **不能直接写 `flags.stealthed = true`** —— `tickWorld` 每 tick 用
     *   `deriveStatusFlags()` 从光环重算整个 flags，手写那一下活不过一个 tick
     *   （verify-m10 的注释里记着这一课）。真的施一个潜行光环才作数。
     */
    const target = match.world.entities.get(hostStart.you)!;
    applyAura(match.auras, target, {
      id: 'test.stealth', name: '测试潜行', kind: 'buff', duration: 999,
      dispelType: DispelType.None, flags: { stealthed: true },
      description: '测试用：进入潜行',
    }, target.id, match.world.time);

    loop.advance(); loop.advance();
    const hidden = await watcher.nextSnapshot();
    expect(hidden.entities.map((e) => e.id)).not.toContain(target.id);

    target.flags.stealthRevealed = true;
    loop.advance(); loop.advance();
    const shown = await watcher.nextSnapshot();
    expect(shown.entities.map((e) => e.id)).toContain(target.id);

    host.close(); watcher.close();
  });

  /**
   * ★★ 观战席没有身体 —— 需要身体的消息一条都不许发（Session 的阶段白名单）。
   *   `SetTarget` 尤其：它是验收 #5 的探测通道，放行等于白送一个不需要
   *   身体就能用的可见性探针。
   */
  it('★★ 观战席发不出战斗消息（SetTarget / CastRequest / Input 全被阶段拒绝）', async () => {
    const host = await startFilledRoom('w4');
    const watcher = await TestClient.connect(server.port);
    await watcher.waitForNth('Welcome');
    watcher.send({ t: 'JoinRoom', roomId: 'w4', name: '观众' });
    await watcher.waitForNth('MatchStart');

    watcher.send({ t: 'SetTarget', slot: 'hard', entityId: 1 as never });
    watcher.send({ t: 'CastRequest', skillId: 'warrior.charge' as never });
    const rejected = await watcher.waitForNth('Rejected', 2);
    expect(rejected.reason).toContain('当前阶段');
    expect(watcher.all('Rejected').map((r) => r.what).sort())
      .toEqual(['CastRequest', 'SetTarget']);

    host.close(); watcher.close();
  });

  it('★ RoomList 把「已开局但坐得下几个」画出来（joinableSeats）', async () => {
    const host = await startFilledRoom('w5');
    host.send({ t: 'ListRooms' });
    const list = await host.waitForNth('RoomList');
    const row = list.rooms.find((r) => r.roomId === 'w5')!;
    expect(row.started).toBe(true);
    // 3v3 补位：房主占一个，另外 5 个都是可顶替的人机席位
    expect(row.joinableSeats).toBe(5);
    host.close();
  });
});

// ════════════════════════════════════════════════════════════════
//  中途加入
// ════════════════════════════════════════════════════════════════

describe('W24 中途加入：顶替人机席位（组队模式）', () => {
  const joinAsSpectator = async (roomId: string, name = '迟到的人'): Promise<TestClient> => {
    const c = await TestClient.connect(server.port);
    await c.waitForNth('Welcome');
    c.send({ t: 'JoinRoom', roomId, name });
    await c.waitForNth('MatchStart');
    return c;
  };

  it('★★ 顶替一个补位人机：拿到它的身体、它的 playerId 与一条新 Welcome', async () => {
    const host = await startFilledRoom('j1');
    const late = await joinAsSpectator('j1');

    /**
     * ⚠️ **不能只等 MatchStart 就去读名单。** `finishSeating` 里 MatchStart
     *   与 `broadcastRoomState` 是两条独立的 ws 帧，轮询有可能在 MatchStart
     *   落地、RoomState 还在路上时就往下走 —— 那时 `all('RoomState').at(-1)`
     *   拿到的是**入场观战时**那一份（席位当然还标着 bot），断言随机变红。
     * ⚠️⚠️ **「多等一条」也不够**（W24 收口时在满负载全量跑里抓到的真 flake）：
     *   他入场观战时那条 `broadcastRoomState` 可能**还在路上**，于是
     *   `条数+1` 等到的正是那一份陈旧的。判据必须是**内容**而不是条数 ——
     *   等到某一份 RoomState 里这个席位不再标 bot 为止。
     */
    late.send({ t: 'JoinOngoing', team: 'blue', classId: asClassId('priest') });
    const start = await late.waitForNth('MatchStart', 2);

    expect(start.spectating).toBeUndefined();       // 这次是参战
    expect(start.you as number).toBeGreaterThan(0);
    // ★ 身份换成了那个席位的 playerId —— 必须回一条 Welcome，否则大厅
    //   按 playerId 找「自己」找不到（W6 的老 bug）
    const welcomes = late.all('Welcome');
    expect(welcomes).toHaveLength(2);
    expect(welcomes[1]!.playerId).not.toBe(welcomes[0]!.playerId);

    const match = server.rooms.matchOf('j1')!;
    expect(match.entityOf.get(welcomes[1]!.playerId)).toBe(start.you);
    // 世界里那具身体改名了（姓名板/结算面板不该继续写「人机N」）
    expect(match.world.entities.get(start.you)!.name).toBe('迟到的人');
    // 席位不再由人机开 —— 名单上的 bot 标记消失
    const seatId = welcomes[1]!.playerId;
    const state = await late.waitForRoomState(
      (s) => s.players.find((p) => p.id === seatId)?.bot === undefined,
    );
    // 同一份名单里，那个席位现在写着他的名字、坐在蓝方
    const seat = state.players.find((p) => p.id === seatId)!;
    expect(seat.name).toBe('迟到的人');
    expect(seat.team).toBe('blue');

    host.close(); late.close();
  });

  /**
   * ★★ 用户原话：「红队满了，那就只能加入蓝队」。红队被真人占满、
   *   一个人机都没有时，必须**诚实拒绝并说清另一边还有位置** ——
   *   静默失败或者「顺手给他换到蓝队」都不行（后者的表现是
   *   「我明明点了红队，怎么在蓝队」）。
   */
  it('★★ 红方满员且无人机可顶 → 诚实拒绝，并点名蓝方还有几个', async () => {
    // arena1v1：红方只有一个位置，被房主本人占着
    const host = await startFilledRoom('j2', 'arena1v1');
    const late = await joinAsSpectator('j2');

    late.send({ t: 'JoinOngoing', team: 'red', classId: asClassId('priest') });
    const rejected = await late.waitForNth('Rejected');
    expect(rejected.what).toBe('JoinOngoing');
    expect(rejected.reason).toContain('红方没有可加入的席位');
    expect(rejected.reason).toContain('蓝方还有 1 个');

    // 换一边就成
    late.send({ t: 'JoinOngoing', team: 'blue', classId: asClassId('priest') });
    await late.waitForNth('MatchStart', 2);

    host.close(); late.close();
  });

  it('★★ 双方都满且没有人机（纯真人局）→ 拒绝，且话说得清楚', async () => {
    // 1v1 不开补位、两个真人各占一边
    const a = await TestClient.connect(server.port);
    const b = await TestClient.connect(server.port);
    await a.waitForNth('Welcome');
    await b.waitForNth('Welcome');
    a.send({ t: 'JoinRoom', roomId: 'j3', name: '甲' });
    await a.waitForNth('RoomState');
    a.send({ t: 'SetRoomMode', mode: 'arena1v1' as never });
    b.send({ t: 'JoinRoom', roomId: 'j3', name: '乙' });
    await b.waitForNth('RoomState');
    a.send({ t: 'SelectTeam', team: 'red' });
    a.send({ t: 'SelectClass', classId: asClassId('warrior') });
    b.send({ t: 'SelectTeam', team: 'blue' });
    b.send({ t: 'SelectClass', classId: asClassId('mage') });
    a.send({ t: 'SetReady', ready: true });
    b.send({ t: 'SetReady', ready: true });
    await a.waitForNth('MatchStart');

    const late = await joinAsSpectator('j3');
    late.send({ t: 'JoinOngoing', team: 'blue', classId: asClassId('priest') });
    const rejected = await late.waitForNth('Rejected');
    expect(rejected.reason).toContain('双方都满');
    // 被拒之后**仍然是观战席**（还能继续看）
    const snap = await late.nextSnapshot();
    expect(snap.self).toBeUndefined();

    a.close(); b.close(); late.close();
  });

  /**
   * ★★ **当场沿用被顶替人机的职业，下一次复活才换成自己选的。**
   *   当场换 = 满血 + 满资源 + 冷却清空 + 光环全清，而这条路径可以被
   *   反复触发（下一个观战者再顶一次）—— 那是个免费复活的经济漏洞。
   */
  it('★★ 顶替时职业不当场变；下一次复活波次才换成选的那个（夺旗）', async () => {
    const host = await startFilledRoom('j4', 'ctf6v6');
    const late = await joinAsSpectator('j4');

    const match = server.rooms.matchOf('j4')!;
    late.send({ t: 'JoinOngoing', team: 'blue', classId: asClassId('priest') });
    const start = await late.waitForNth('MatchStart', 2);

    const e = match.world.entities.get(start.you)!;
    const inherited = e.classId as string;
    expect(inherited).not.toBe('priest'); // 补位人机轮着选职业，不会正好是牧师
    expect(e.alive).toBe(true);

    /**
     * 白盒地布置、黑盒地断言：停掉自动 tick，把他打死推一拍（这一拍
     * 「见过他死」），再把下一波复活提前到眼前推第二拍。
     * ★ 分两拍不是凑测试：**活着不换职业**正是这条规则本身
     *   （当场换 = 免费满血），所以第一拍必须什么都不发生。
     */
    const loop = server.rooms.loopOf('j4')!;
    loop.stop();
    e.alive = false;
    e.health = 0;
    match.respawn!.pending.push({ entityId: e.id, diedAt: match.world.time });
    match.respawn!.nextWaveAt = match.world.time + 999;
    loop.advance();
    expect(e.classId as string, '人还躺着就把职业换了 —— 那是一次免费满血').toBe(inherited);

    match.respawn!.nextWaveAt = match.world.time;
    loop.advance();

    expect(e.alive).toBe(true);
    expect(e.classId as string, '复活了却还是被顶替者的职业').toBe('priest');
    expect(e.health).toBe(e.maxHealth);
    // 名单也跟着换了（大厅要显示他现在是牧师）
    const state = late.all('RoomState').at(-1)!;
    expect(state.players.some((p) => p.classId as string === 'priest')).toBe(true);

    host.close(); late.close();
  });
});

describe('W24 中途加入：新实体入场（大乱斗）', () => {
  it('★★ 大乱斗中途加入 = 世界里多一个人、独立阵营、职业当场生效', async () => {
    const a = await TestClient.connect(server.port);
    await a.waitForNth('Welcome');
    a.send({ t: 'JoinRoom', roomId: 'f1', name: '甲' });
    await a.waitForNth('RoomState');
    a.send({ t: 'SetRoomMode', mode: 'ffa' as never });
    a.send({ t: 'SelectTeam', team: 'red' });
    a.send({ t: 'SelectClass', classId: asClassId('warrior') });
    a.send({ t: 'SetReady', ready: true });
    // 大乱斗不开补位时至少要两个人 —— 第二个客户端在房间阶段就位
    const b = await TestClient.connect(server.port);
    await b.waitForNth('Welcome');
    b.send({ t: 'JoinRoom', roomId: 'f1', name: '乙' });
    await b.waitForNth('RoomState');
    b.send({ t: 'SelectTeam', team: 'red' });
    b.send({ t: 'SelectClass', classId: asClassId('mage') });
    b.send({ t: 'SetReady', ready: true });
    await a.waitForNth('MatchStart');

    const match = server.rooms.matchOf('f1')!;
    const before = listEntities(match.world).length;

    const late = await TestClient.connect(server.port);
    await late.waitForNth('Welcome');
    late.send({ t: 'JoinRoom', roomId: 'f1', name: '丙' });
    await late.waitForNth('MatchStart');
    late.send({ t: 'JoinOngoing', team: 'red', classId: asClassId('priest') });
    const start = await late.waitForNth('MatchStart', 2);

    expect(listEntities(match.world).length).toBe(before + 1);
    const e = match.world.entities.get(start.you)!;
    // ★ 新实体：职业当场生效（他不是顶替谁的身体，没有便宜可占）
    expect(e.classId as string).toBe('priest');
    expect(e.name).toBe('丙');
    // 独立阵营 —— 与场上任何人都不同队（P12 的「人人为敌」）
    const others = listEntities(match.world).filter((x) => x.id !== e.id && !x.isPet);
    expect(others.every((x) => x.team !== e.team)).toBe(true);
    // 他也拿到了自己的 self 段（有身体的人才有冷却）
    const snap = await late.nextSnapshot();
    expect(snap.self).toBeDefined();

    a.close(); b.close(); late.close();
  });
});

// ════════════════════════════════════════════════════════════════
//  客户端半边依赖的那几条协议事实
// ════════════════════════════════════════════════════════════════

/**
 * ★★ 这一组的存在理由与上面几组不同：它钉的不是服务器的规则，而是
 *   **客户端据以画界面的那几条事实**。客户端本身跑在浏览器里（本仓库
 *   没有 jsdom），它的三条兜底 —— `self === undefined`、`you === 0`、
 *   「身份可能变」—— 都只有在这里才写得出非浏览器断言。
 */
describe('W24 客户端契约：观战/中途加入依赖的协议事实', () => {
  it('★★ 观战席的快照没有 self 段，且 `you` 一定指向快照里的某个活人（或 0）', async () => {
    const host = await startFilledRoom('c1');
    const watcher = await TestClient.connect(server.port);
    await watcher.waitForNth('Welcome');
    watcher.send({ t: 'JoinRoom', roomId: 'c1', name: '观众' });
    await watcher.waitForNth('MatchStart');

    // 连着看几份：`you` 每 tick 都可能换人（被跟随者死了/遁形了）
    for (let i = 0; i < 3; i++) {
      const snap = await watcher.nextSnapshot();
      /**
       * ★ `self` 段里是冷却/GCD/焦点/可拾取列表 —— 客户端的
       *   `SnapshotHydrator` 全部按可选合并，缺席就是「没有冷却条、
       *   没有 GCD、drops 一律不可拾取」。这条断言就是那个兜底的依据。
       */
      expect(snap.self).toBeUndefined();
      // ★ 0 是 `NO_ENTITY` 哨兵（实体 id 从 1 起）；非 0 时必须在实体段里找得到
      if ((snap.you as number) !== 0) {
        const followed = snap.entities.find((e) => e.id === snap.you);
        expect(followed, `you=${snap.you as number} 不在观战段里，客户端的镜头会挂空`)
          .toBeDefined();
      }
      // ackSeq 对没有身体的人恒为 0（他一条 Input 都发不出去）
      expect(snap.ackSeq).toBe(0);
    }

    host.close(); watcher.close();
  });

  /**
   * ★★ 席位面板画「哪些席位能顶替」全靠这个字段。判据在服务器侧是
   *   「这个 playerId 有没有一条人机会话」—— 客户端**不许**按名字前缀
   *   自己猜（名字是玩家可控的字符串）。
   */
  it('★★ RoomState 把补位人机的席位标成 bot；真人席位不带这个字段', async () => {
    const host = await startFilledRoom('c2');
    const watcher = await TestClient.connect(server.port);
    await watcher.waitForNth('Welcome');
    watcher.send({ t: 'JoinRoom', roomId: 'c2', name: '观众' });
    const state = await watcher.waitForNth('RoomState');

    const bots = state.players.filter((p) => p.bot === true);
    expect(bots.length).toBeGreaterThan(0);
    // 房主是真人 —— 省略 = 真人（不是 false）
    const human = state.players.find((p) => p.name === '房主')!;
    expect(human.bot).toBeUndefined();
    // 观战者自己也不是人机，而且他坐的是观战席（席位面板据此知道「我还没上场」）
    const me = state.players.find((p) => p.name === '观众')!;
    expect(me.bot).toBeUndefined();
    expect(me.team).toBe('spectator');

    host.close(); watcher.close();
  });

  /**
   * ★★ **顺序**是客户端的硬依赖：大厅按 `playerId` 找「自己」，而中途加入
   *   顶替人机时身份会换成那个席位的 id。`Welcome` 必须先于 `MatchStart`
   *   到达 —— 反过来的话，大厅会拿**旧**身份去名单里找自己，找不到，
   *   于是建场景时读不到队伍与职业（自己的角色模型当场挂错 —— W24 收口后
   *   下一帧会按快照的 `classId` 纠正回来，但玩家看得见挂错的那一下）。
   */
  it('★★ 顶替成功时 Welcome 先于第二条 MatchStart 到达（大厅据它换身份）', async () => {
    const host = await startFilledRoom('c3');
    const late = await TestClient.connect(server.port);
    await late.waitForNth('Welcome');
    late.send({ t: 'JoinRoom', roomId: 'c3', name: '迟到的人' });
    await late.waitForNth('MatchStart');

    late.send({ t: 'JoinOngoing', team: 'blue', classId: asClassId('priest') });
    await late.waitForNth('MatchStart', 2);

    const order = late.received.map((m) => m.t);
    const secondStart = order.indexOf('MatchStart', order.indexOf('MatchStart') + 1);
    const secondWelcome = order.indexOf('Welcome', order.indexOf('Welcome') + 1);
    expect(secondWelcome).toBeGreaterThanOrEqual(0);
    expect(secondWelcome).toBeLessThan(secondStart);
    // ★ 这一条不带 spectating —— 客户端凭它把观战场景整个换成参战场景
    expect(late.all('MatchStart')[1]!.spectating).toBeUndefined();

    host.close(); late.close();
  });

  /**
   * ★★ 顶替人机之后**当场沿用它的职业** —— 客户端的「本局沿用【战士】」
   *   那句话就是从这个差里算出来的（请求的 classId ≠ 实体的 classId）。
   *   这条断言同时钉住 docs/15 W24 记的那笔账：竞技场单回合制下，
   *   那个「下一次复活」在本局不会到来。
   */
  it('★★ 竞技场顶替人机：实体职业仍是被顶替者的，选的那个整局不生效', async () => {
    const host = await startFilledRoom('c4', 'arena3v3');
    const late = await TestClient.connect(server.port);
    await late.waitForNth('Welcome');
    late.send({ t: 'JoinRoom', roomId: 'c4', name: '迟到的人' });
    await late.waitForNth('MatchStart');

    late.send({ t: 'JoinOngoing', team: 'blue', classId: asClassId('priest') });
    const start = await late.waitForNth('MatchStart', 2);

    const match = server.rooms.matchOf('c4')!;
    const e = match.world.entities.get(start.you)!;
    // ★ 顶替 = 接过那具身体，职业不当场换（当场换 = 一次免费的满血+清冷却）
    expect(e.classId as string).not.toBe('priest');
    /**
     * ★ 竞技场默认**单回合制** —— `roundsToWin: 1`，服务器从不调 `resetRound`。
     *   于是「下一次复活/回合重置」这个兑现点在本局不会到来，客户端的文案
     *   必须写成「本局沿用」而不是「下回合起换成你选的」（docs/15 W24）。
     */
    expect(match.arena?.config.roundsToWin).toBe(1);

    host.close(); late.close();
  });
});

// ════════════════════════════════════════════════════════════════
//  W24 收口（对抗校验回填）
// ════════════════════════════════════════════════════════════════

/**
 * ★★ 这一组每一条都对应一个**实测打穿过**的洞。共同点是：规则本身写对了、
 *   `visibility.test.ts` 的纯函数用例也是绿的，**服务器却没那样调**
 *   —— 正是本文件头写的那种失败模式。所以断言一律落在**真 ws 收到的字节**上，
 *   不落在纯函数的返回值上。
 */
describe('W24 收口：装备视图 / 记账 / 存活性 / 赛后', () => {
  const joinAsSpectator = async (roomId: string, name = '观众'): Promise<TestClient> => {
    const c = await TestClient.connect(server.port);
    await c.waitForNth('Welcome');
    c.send({ t: 'JoinRoom', roomId, name });
    await c.waitForNth('MatchStart');
    return c;
  };

  /**
   * 白盒把一局竞技场推到结束：快进过准备阶段 → 打死房主的对面 → 快进过结算窗口。
   * ★ 手法与 `RoomServer.test.ts` 的 M13 复赛用例逐字相同 —— 「打死了就该结束」
   *   要经过 `tickArena` 的回合状态机，直接改 `alive` 不会自己走到 MatchEnd。
   */
  const forceMatchEnd = (roomId: string, hostEntityId: number): void => {
    const match = server.rooms.matchOf(roomId)!;
    const loop = server.rooms.loopOf(roomId)!;
    loop.stop(); // 手动推，避免与自动 tick 抢
    for (let i = 0; i < 400 && !match.arena?.outcome; i++) loop.advance();
    const hostTeam = match.world.entities.get(hostEntityId as never)!.team;
    for (const e of listEntities(match.world)) {
      if (e.team !== hostTeam && !e.isPet) { e.alive = false; e.health = 0; }
    }
    for (let i = 0; i < 60 && !match.arena?.outcome; i++) loop.advance();
  };

  /** 这条会话收到的所有 EntityMeta 装备视图（按到达顺序摊平）*/
  const equipViews = (c: TestClient): Record<string, unknown>[] =>
    c.all('EntityMeta')
      .flatMap((m) => m.items)
      .map((i) => i.equipment)
      .filter((e) => e !== undefined) as unknown as Record<string, unknown>[];

  /**
   * ★★ 观战席的装备视图**一律敌人视图**（10.6 / 验收 #36 / `CULLING_RULES`
   *   的 4.4-spectator）。此前这里发的是 `equipmentViewFor(e, effectiveViewer…)`
   *   —— 而观战席的 `effectiveViewer` 是他**正在看的那个真人**，于是被跟随者
   *   全队都发 ally 视图（备用武器/护甲/消耗品/精确护甲 id）。按 V 换一遍
   *   视角就能把双方的备用装备栏收齐，正是「给敌队第二双眼睛」。
   */
  it('★★ 观战席收到的每一份 EntityMeta.equipment 都不含 spareWeaponIds（换边跟随也不含）', async () => {
    const host = await startFilledRoom('e1', 'arena3v3');
    const watcher = await joinAsSpectator('e1');
    await watcher.waitForNth('EntityMeta');
    await watcher.nextSnapshot();

    const first = equipViews(watcher);
    expect(first.length).toBeGreaterThan(0);
    for (const v of first) {
      expect(v['spareWeaponIds'], '观战席拿到了队友视图的备用武器栏').toBeUndefined();
      expect(v['spareArmorIds']).toBeUndefined();
      expect(v['consumableIds']).toBeUndefined();
      expect(v['currentArmorId'], '精确护甲 id 是队友视图独有的').toBeUndefined();
      // 敌人视图的形状：只有当前武器 + 护甲**类型** + 换装中与否（验收 #36）
      expect(v['armorArchetype']).toBeDefined();
    }

    /**
     * 换一边跟随，再把那一队某人的装备指纹改一次 —— 逼服务器**重发**
     * 一条 EntityMeta。修好之前，这一条重发出来的就是 ally 视图。
     */
    const match = server.rooms.matchOf('e1')!;
    const hostEntity = match.world.entities.get(host.all('MatchStart')[0]!.you)!;
    const other = listEntities(match.world).find((e) => e.team !== hostEntity.team && !e.isPet)!;
    watcher.send({ t: 'SpectateFollow', entityId: other.id });
    const before = watcher.all('EntityMeta').length;
    other.weaponId = asWeaponId('warrior.two_hander');
    await watcher.waitForNth('EntityMeta', before + 1);

    for (const v of equipViews(watcher)) {
      expect(v['spareWeaponIds'], '换边跟随后收到了队友视图').toBeUndefined();
    }

    host.close(); watcher.close();
  });

  /**
   * ★★ 席位变了 → P11 记账作废（`MatchLoop.resetSnapshotAccount`）。
   *   `snapAccounts` 以 **Session 对象**为键，而中途加入是同一个 Session
   *   从观战席坐到战斗席 —— 不清的话 `seen`/`equipFp` 原样命中，
   *   EntityMeta 一条都不重发：他的新队友整局停在**敌人视图**上
   *   （换装/消耗品面板整局是空的）。
   */
  it('★★ 顶替上场后 EntityMeta 全量重发：队友是 ally 视图、对手仍是敌人视图', async () => {
    const host = await startFilledRoom('e2', 'arena3v3');
    const late = await joinAsSpectator('e2', '迟到的人');
    await late.waitForNth('EntityMeta');

    const metasBefore = late.all('EntityMeta').length;
    late.send({ t: 'JoinOngoing', team: 'blue', classId: asClassId('priest') });
    const start = await late.waitForNth('MatchStart', 2);
    await late.waitForNth('EntityMeta', metasBefore + 1);

    const match = server.rooms.matchOf('e2')!;
    const me = match.world.entities.get(start.you)!;
    // 上场之后收到的那些 —— 记账被作废，所以这里是一份**全新的**首见
    const after = late.all('EntityMeta').slice(metasBefore).flatMap((m) => m.items);
    const byId = new Map(
      after.map((i) => [i.entityId as number, i.equipment as unknown as Record<string, unknown> | undefined]),
    );

    const mates = listEntities(match.world).filter((e) => e.team === me.team && !e.isPet);
    expect(mates.length).toBeGreaterThan(1);
    for (const mate of mates) {
      const v = byId.get(mate.id as number);
      expect(v, `队友 ${mate.id as number} 的 EntityMeta 一条都没重发`).toBeDefined();
      expect(v!['spareWeaponIds'], '新队友仍停在敌人视图上').toBeDefined();
    }
    for (const foe of listEntities(match.world).filter((e) => e.team !== me.team && !e.isPet)) {
      const v = byId.get(foe.id as number);
      if (v) expect(v['spareWeaponIds'], '上场后仍拿着观战期的对手 ally 视图').toBeUndefined();
    }

    host.close(); late.close();
  });

  /**
   * ★★ 顶替路此前**一条存活性判据都没有**：`admitToMatch` 那条路上的
   *   `teamWiped` 只挡「有空位」的情况，而「队伍被人机补满」恰恰走另一条。
   *   顶替一具尸体换来的是躺到比赛结束的角色 —— 竞技场单回合制下
   *   「死 → 活」的跳变本局不会到来，他既不复活也等不到自己选的职业。
   */
  it('★★ 队伍已全灭 → 顶替路也拒绝，且与 admitToMatch 同一句话', async () => {
    const host = await startFilledRoom('e3', 'arena3v3');
    const late = await joinAsSpectator('e3', '迟到的人');

    const match = server.rooms.matchOf('e3')!;
    // ★ 先停自动 tick 再动世界：否则这一拍就判负结算，测的就不是这条路了
    server.rooms.loopOf('e3')!.stop();
    const hostEntity = match.world.entities.get(host.all('MatchStart')[0]!.you)!;
    for (const e of listEntities(match.world)) {
      if (e.team !== hostEntity.team && !e.isPet) { e.alive = false; e.health = 0; }
    }

    late.send({ t: 'JoinOngoing', team: 'blue', classId: asClassId('priest') });
    const rejected = await late.waitForNth('Rejected');
    expect(rejected.what).toBe('JoinOngoing');
    expect(rejected.reason).toBe('该队本回合已全灭，不能中途加入');
    // 被拒之后仍然是观战席（没有半个状态：既没坐上去也没被踢出去）
    expect(late.all('MatchStart')).toHaveLength(1);

    host.close(); late.close();
  });

  it('★★ 只死了一部分 → 顶替到的一定是**活着**的那具身体', async () => {
    const host = await startFilledRoom('e4', 'arena3v3');
    const late = await joinAsSpectator('e4', '迟到的人');

    const match = server.rooms.matchOf('e4')!;
    server.rooms.loopOf('e4')!.stop();
    const hostEntity = match.world.entities.get(host.all('MatchStart')[0]!.you)!;
    const foes = listEntities(match.world).filter((e) => e.team !== hostEntity.team && !e.isPet);
    expect(foes.length).toBeGreaterThan(1);
    // 除最后一个之外全部打死 —— 尸体席位不该被算成「坐得下」
    for (const e of foes.slice(0, -1)) { e.alive = false; e.health = 0; }
    const survivor = foes.at(-1)!;

    late.send({ t: 'JoinOngoing', team: 'blue', classId: asClassId('priest') });
    const start = await late.waitForNth('MatchStart', 2);
    expect(start.you).toBe(survivor.id);
    expect(match.world.entities.get(start.you)!.alive).toBe(true);

    // ★ RoomList 的 joinableSeats 跟着变诚实：尸体席位不再计数
    host.send({ t: 'ListRooms' });
    const list = await host.waitForNth('RoomList');
    expect(list.rooms.find((r) => r.roomId === 'e4')!.joinableSeats).toBe(2); // 红方两个人机

    host.close(); late.close();
  });

  /**
   * ★★ 赛后人机**必须出名单**：它们的 `connected` 恒为真，`resetForRematch`
   *   的断线筛掉不了；被清成 `ready=false` 之后又没有任何人会替它们准备
   *   —— `canStart` 永远不满足、`fillBotSeats` 要等 `beginMatch` 才跑，
   *   于是一个开着补位的房间打完一局就再也开不出第二局（静默：房主按
   *   准备只回一条 RoomState）。api 清单 §9 承诺的「赛后可以打下一局」
   *   在此之前对**所有**补位房都不成立。
   */
  it('★★ 补位房打完一局：名单里没有人机，房主再准备一次真的开出第二局', async () => {
    const host = await startFilledRoom('e5', 'arena1v1');
    forceMatchEnd('e5', host.all('MatchStart')[0]!.you as number);
    await host.waitForNth('MatchEnd');

    const state = await host.waitForNth('RoomState', host.all('RoomState').length);
    expect(state.started).toBe(false);
    expect(state.players.filter((p) => p.bot === true), '人机赛后还赖在名单里').toHaveLength(0);
    expect(state.players).toHaveLength(1);

    host.send({ t: 'SetReady', ready: true });
    const second = await host.waitForNth('MatchStart', 2);
    expect(second.you as number).toBeGreaterThan(0);

    host.close();
  });

  it('★★ 观战者赛后选得到阵营（api §9 的原话：可以正常选阵营/准备打下一局）', async () => {
    const host = await startFilledRoom('e6', 'arena1v1');
    const watcher = await joinAsSpectator('e6');
    forceMatchEnd('e6', host.all('MatchStart')[0]!.you as number);
    await watcher.waitForNth('MatchEnd');

    watcher.send({ t: 'SelectTeam', team: 'blue' });
    const state = await watcher.waitForRoomState(s => !s.started && s.players.some(p => p.name === '观众' && p.team === 'blue'));
    expect(watcher.all('Rejected'), '两队都被人机占着 —— 观战者一个席位都选不到').toHaveLength(0);
    expect(state.players.find((p) => p.name === '观众')?.team).toBe('blue');

    host.close(); watcher.close();
  });
});
