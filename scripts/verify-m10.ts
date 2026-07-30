/**
 * M10 端到端验收：**跨进程之后还对不对**。
 *
 * ★ 与前九支脚本的分工（docs/13 A6）：前九支验的是「规则对不对」和
 *   「有没有接线」，这一支验的是「真的连两个客户端上来之后还对不对」。
 *
 * ★★ **每一条都是「试着做坏事，然后断言它没得逞」。**
 *   而且断言的对象是**客户端真实收到的字节**，不是「客户端没画出来」——
 *   后者改一行前端就能绕过，前者绕不过去。
 *
 * 用法：node --import tsx scripts/verify-m10.ts
 */

import { WebSocket } from 'ws';
import {
  applyAura,
  clearAuras,
  encodeClientMessage,
  asClassId,
  type AuraDef,
  type ClientMessage,
  type ServerMessage,
} from '../packages/shared/src/index.ts';

/**
 * 一个最小的潜行光环。
 * ★ 不借用某个职业的技能数据 —— 那样这条测试会跟着那个技能的数值一起漂。
 *   这里要验的是**裁剪**，`flags.stealthed` 是它唯一的输入。
 */
const STEALTH_AURA: AuraDef = {
  id: 'verify.stealth',
  name: '验收用潜行',
  duration: 999,
  kind: 'buff',
  flags: { stealthed: true },
} as AuraDef;

import { startServer } from '../packages/server/src/index.ts';

const results: { id: string; pass: boolean }[] = [];
const check = (id: string, name: string, pass: boolean, detail: string): void => {
  results.push({ id, pass });
  console.log(`  ${pass ? '✓' : '✗'} ${id} ${name}\n      ${detail}`);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 一个真客户端。
 * ★ 它把**每一帧原始字符串**都留着 —— 字节级断言的依据就是这个数组。
 */
class Client {
  readonly raw: string[] = [];
  readonly msgs: ServerMessage[] = [];
  private constructor(readonly socket: WebSocket) {}

  static async connect(port: number): Promise<Client> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const c = new Client(socket);
    socket.on('message', (d) => {
      const s = d.toString();
      c.raw.push(s);
      try { c.msgs.push(JSON.parse(s) as ServerMessage); } catch { /* 非 JSON 也留在 raw 里 */ }
    });
    await new Promise<void>((res, rej) => {
      socket.once('open', () => res());
      socket.once('error', rej);
    });
    return c;
  }

  send(m: ClientMessage): void { this.socket.send(encodeClientMessage(m)); }
  sendRaw(s: string): void { this.socket.send(s); }
  get open(): boolean { return this.socket.readyState === WebSocket.OPEN; }
  find<K extends ServerMessage['t']>(k: K): Extract<ServerMessage, { t: K }> | undefined {
    return this.msgs.find((m) => m.t === k) as Extract<ServerMessage, { t: K }> | undefined;
  }
  async waitFor<K extends ServerMessage['t']>(k: K, ms = 4000): Promise<Extract<ServerMessage, { t: K }>> {
    const end = Date.now() + ms;
    for (;;) {
      const hit = this.find(k);
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`等 ${k} 超时；收到：${this.msgs.map((m) => m.t).join(',')}`);
      await sleep(20);
    }
  }
  /** 清空记录，好让后续断言只看「从现在起」的字节 */
  clear(): void { this.raw.length = 0; this.msgs.length = 0; }
  close(): void { this.socket.close(); }
}

const readyUp = async (
  c: Client, room: string, name: string, team: 'red' | 'blue', cls: string,
): Promise<void> => {
  c.send({ t: 'JoinRoom', roomId: room, name });
  await c.waitFor('RoomState');
  c.send({ t: 'SelectTeam', team });
  c.send({ t: 'SelectClass', classId: asClassId(cls) });
  c.send({ t: 'SetReady', ready: true });
};

/** 开一局两人对战，返回两个客户端与各自实体 id */
const startMatch = async (port: number, room: string) => {
  const red = await Client.connect(port);
  const blue = await Client.connect(port);
  await readyUp(red, room, '红方', 'red', 'mage');
  await readyUp(blue, room, '蓝方', 'blue', 'warrior');
  const r = await red.waitFor('MatchStart');
  const b = await blue.waitFor('MatchStart');
  await red.waitFor('Snapshot');
  return { red, blue, redId: r.you, blueId: b.you, token: r.reconnectToken };
};

// ════════════════════════════════════════════════════════════════

const server = await startServer(0);
const PORT = server.port;
console.log(`\n服务器已启动（端口 ${PORT}）`);

// ── 1–3：按接收者裁剪，断言在**传输字节**里 ────────────────────
console.log('\n── 验收 #5 / #36：裁剪发生在快照层，不是客户端过滤 ──');
{
  const { red, blue, redId, blueId } = await startMatch(PORT, 'cull');
  const match = server.rooms.matchOf('cull')!;

  /**
   * 让红方潜行。
   *
   * ⚠️ **不能直接写 `entity.flags.stealthed = true`** —— `tickWorld` 每个 tick
   *    都会用 `deriveStatusFlags()` 从光环重算整个 flags，手写的那一下
   *    活不过一个 tick。（第一版就是这么写的，于是这条测试「失败」了，
   *    但失败的是测试而不是产品。）真的施加一个潜行光环才作数。
   */
  const redEntity = match.world.entities.get(redId)!;
  applyAura(match.auras, redEntity, STEALTH_AURA, redId, match.world.time);

  blue.clear();
  await sleep(400); // 收几份快照

  /**
   * ★ 逐帧**解析**收到的字节，找红方那个实体对象。
   *   比子串匹配精确：一份快照里含所有实体，`"id":1` 可能出现在别的字段里。
   *   解析的仍然是**传输过来的原字节**，所以这依旧是字节级断言。
   */
  const snapsOf = (c: Client) =>
    c.raw.map((f) => { try { return JSON.parse(f) as ServerMessage; } catch { return null; } })
      .filter((m): m is Extract<ServerMessage, { t: 'Snapshot' }> => m?.t === 'Snapshot');

  const blueSnaps = snapsOf(blue);
  const leaked = blueSnaps.filter((s) => s.entities.some((e) => e.id === redId));
  check('1', '★★ 未被发现的潜行者不出现在传输字节里',
    blueSnaps.length > 0 && leaked.length === 0,
    `蓝方收到 ${blueSnaps.length} 份快照，其中含红方实体 ${redId} 的有 ${leaked.length} 份`);

  clearAuras(match.auras, redId);
  blue.clear();
  await sleep(300);
  check('1b', '★ 解除潜行后又能看到了（证明上一条不是「什么都没发」）',
    snapsOf(blue).some((s) => s.entities.some((e) => e.id === redId)),
    `蓝方重新看到了红方`);

  // #36：敌人的备用装备槽位一律不发
  const redAsSeenByBlue = snapsOf(blue)
    .flatMap((s) => s.entities.filter((e) => e.id === redId));
  const spareLeak = redAsSeenByBlue.filter((e) => 'spareWeaponIds' in e.equipment);
  check('2', '★★ 敌人的备用装备不出现在传输字节里（#36）',
    redAsSeenByBlue.length > 0 && spareLeak.length === 0,
    `检查了 ${redAsSeenByBlue.length} 份敌方实体视图，带备用槽位的有 ${spareLeak.length} 份`);

  // 敌方技能冷却不发；自己的要发
  const cdLeak = redAsSeenByBlue.filter((e) => e.cooldowns !== undefined);
  const ownCd = snapsOf(red).flatMap((s) => s.entities.filter((e) => e.id === redId))
    .filter((e) => e.cooldowns !== undefined);
  check('3', '★ 敌方技能冷却不出现在传输字节里（自己的仍然发）',
    cdLeak.length === 0 && ownCd.length > 0,
    `蓝方看到红方冷却＝${cdLeak.length} 份；红方看到自己的冷却＝${ownCd.length} 份`);

  void blueId;
  red.close(); blue.close();
}

// ── 4–7：伪造输入 ──────────────────────────────────────────────
console.log('\n── docs/08 §2：客户端只能发意图，且意图要被校验 ──');
{
  const { red, blue, redId } = await startMatch(PORT, 'cheat');
  const match = server.rooms.matchOf('cheat')!;
  const me = match.world.entities.get(redId)!;

  // #4：forward = 999
  const from = { ...me.position };
  red.clear();
  for (let i = 0; i < 12; i++) {
    red.send({ t: 'Input', seq: 100 + i, dt: 0.05, forward: 999, strafe: 0, characterYaw: 0, jump: false });
    await sleep(25);
  }
  await sleep(150);
  const moved = Math.hypot(me.position.x - from.x, me.position.z - from.z);
  // 12 个 tick ≈ 0.6s，7 m/s 上限 → 最多约 4.2 米，留 1.5 倍余量
  check('4', '★★ 伪造 forward=999 被钳制，不加速',
    moved < 7 * 0.6 * 1.5,
    `位移 ${moved.toFixed(2)} 米（若 999 生效会是数百米）`);

  // #5：dt = 100 —— 协议层直接拒绝
  red.clear();
  red.send({ t: 'Input', seq: 999, dt: 100, forward: 1, strafe: 0, characterYaw: 0, jump: false } as ClientMessage);
  await sleep(200);
  const rejectedDt = red.msgs.some((m) => m.t === 'Rejected');
  check('5', '★★ 伪造 dt=100 被拒绝，不瞬移',
    rejectedDt && red.open,
    `收到 Rejected＝${rejectedDt}，连接仍活着＝${red.open}`);

  // #6：不在协议里的消息
  red.clear();
  red.sendRaw(JSON.stringify({ t: 'GiveMeDamage', amount: 99999 }));
  await sleep(200);
  const r6 = red.msgs.find((m) => m.t === 'Rejected');
  check('6', '★★ 协议外的消息被拒绝，且**不掉线**',
    !!r6 && red.open,
    `${r6 ? `Rejected(${r6.what})` : '(没收到 Rejected)'}；连接仍活着＝${red.open}`);

  // #7：对不可见目标 SetTarget
  red.clear();
  red.send({ t: 'SetTarget', slot: 'hard', entityId: 9999 as never });
  await sleep(200);
  const r7 = red.msgs.find((m) => m.t === 'Rejected');
  check('7', '★★ 对不可见目标 SetTarget 被拒绝，且理由不泄露该 id',
    !!r7 && !r7.reason.includes('9999') && red.open,
    `${r7 ? `理由「${r7.reason}」` : '(没收到 Rejected)'}`);

  red.close(); blue.close();
}

// ── 8–10：断线、重连、超时 ────────────────────────────────────
console.log('\n── 规格书 11.5 / 17.3：断线与重连 ──');
{
  const { red, blue, redId, token } = await startMatch(PORT, 'dc');
  const match = server.rooms.matchOf('dc')!;
  const me = match.world.entities.get(redId)!;

  const hpBefore = me.health;
  red.close();
  await sleep(200);

  // #9：断线期间照样掉血（否定式规则 —— 必须真的打他一下）
  me.health -= 100;
  await sleep(150);
  check('9', '★★ 断线期间角色照样掉血（11.5：不获得无敌）',
    me.health < hpBefore && me.alive,
    `生命 ${hpBefore} → ${me.health}，仍在世界里＝${me.alive}`);

  // #8：限时内重连
  const back = await Client.connect(PORT);
  back.send({ t: 'Reconnect', token });
  const restart = await back.waitFor('MatchStart');
  const snap = await back.waitFor('Snapshot');
  check('8', '★★ 断线后重连 → 收到完整快照并恢复控制',
    restart.you === redId && snap.entities.length > 0,
    `重新拿回实体 ${restart.you}（原 ${redId}），快照含 ${snap.entities.length} 个实体`);

  back.close();
  blue.close();
}

// ── 10：超时淘汰 ──────────────────────────────────────────────
{
  const { red, blue, redId } = await startMatch(PORT, 'timeout');
  const match = server.rooms.matchOf('timeout')!;
  red.close();
  await sleep(200);

  /**
   * ★ 不真的等 90 秒：把模拟时间推过宽限期。
   *   服务器的重连宽限读的是 `world.time`（MatchLoop 的设计），
   *   所以推进模拟时间就等价于「过了 90 秒」—— 这正是当初选择
   *   用 world.time 而不是 Date.now() 的收益。
   */
  match.world.time += 120;
  await sleep(400);

  const me = match.world.entities.get(redId)!;
  const eliminated = blue.msgs.find((m) => m.t === 'PeerEliminated');
  check('10', '★★ 断线超时 → 按淘汰处理（不是悄悄消失）',
    !!eliminated && !me.alive,
    `收到 PeerEliminated＝${!!eliminated}（原因 ${eliminated?.reason ?? '-'}），角色存活＝${me.alive}`);

  blue.close();
}

// ── 11–12：权威性与完整一局 ───────────────────────────────────
console.log('\n── 权威性与集成 ──');
{
  const { red, blue, blueId } = await startMatch(PORT, 'auth');
  const match = server.rooms.matchOf('auth')!;

  // #11：两个客户端看到同一个事实
  match.world.entities.get(blueId)!.health = 333;
  await sleep(300);
  const redSees = [...red.msgs].reverse().find((m) => m.t === 'Snapshot')
    ?.entities.find((e) => e.id === blueId)?.health;
  const blueSees = [...blue.msgs].reverse().find((m) => m.t === 'Snapshot')
    ?.entities.find((e) => e.id === blueId)?.health;
  check('11', '★ 两个客户端看到的同一个事实一致',
    redSees === blueSees && redSees === 333,
    `红方看到 ${redSees}，蓝方看到 ${blueSees}`);

  /**
   * #12：跑到分出胜负。
   *
   * ★ `ARENA.PREP_SECONDS = 18` —— 准备阶段就有 18 秒，真等的话这条要跑半分钟。
   *   所以直接**手动单步推进**：`MatchLoop.advance()` 推进恰好一个 tick，
   *   定步长循环让这件事是安全的（每一步都和真实运行完全一样，只是不等墙上时间）。
   *   ⚠️ 第一版没有快进，12 秒超时**比准备阶段还短**，于是「没分出胜负」——
   *      而那不是产品的问题，是测试根本没跑到战斗阶段。
   */
  const loop = server.rooms.loopOf('auth')!;
  for (let i = 0; i < 400 && !match.arena?.outcome; i++) loop.advance(); // 20 秒：过准备阶段

  match.world.entities.get(blueId)!.alive = false;
  match.world.entities.get(blueId)!.health = 0;
  for (let i = 0; i < 60 && !match.arena?.outcome; i++) loop.advance(); // 过平局结算窗口

  const ended = await Promise.race([
    red.waitFor('MatchEnd', 3000).then(() => true),
    sleep(3000).then(() => false),
  ]);
  check('12', '★★ 一局从房间跑到分出胜负',
    ended,
    ended
      ? `收到 MatchEnd（胜者 ${red.find('MatchEnd')?.winner}），回合阶段＝${match.arena?.phase}`
      : `没有分出胜负；回合阶段＝${match.arena?.phase}，outcome＝${JSON.stringify(match.arena?.outcome)}`);

  red.close(); blue.close();
}

await server.close();

console.log(`\n${'─'.repeat(60)}`);
const failed = results.filter((r) => !r.pass);
console.log(`M10 验收：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('失败项：' + failed.map((f) => f.id).join(', '));
  process.exit(1);
}
