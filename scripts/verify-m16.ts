/**
 * M16d/16c 端到端验收：**临时武装在真实对局里终于可达**。
 *
 * ★★ 这支脚本存在的理由，是本仓库第六次撞上同一个家族：
 *   M6 把军械箱、职业归属、三选一、0.8 秒拾取、先到者得全写对了，
 *   单测也全绿 —— 但服务器**从不调用** `setupArmories()`，快照里**没有**
 *   掉落物字段，客户端**从不发送** `InteractStart`。
 *   于是整整一个里程碑的规则在联网对局里等于不存在，
 *   而 1064 条单测与十支验收脚本没有一条能发现它：
 *   **它们验的是「规则对不对」，不是「有没有人调用它」。**
 *
 * ★ 与 verify:m10 同一套手法：起真服务器 + 真 ws 客户端，
 *   断言的对象是**客户端真实收到的字节**。
 *
 * 用法：node --import tsx scripts/verify-m16.ts
 */

import { WebSocket } from 'ws';
import {
  ArenaPreset,
  ArsenalChoice,
  EQUIP,
  asClassId,
  encodeClientMessage,
  type ClientMessage,
  type ServerMessage,
} from '../packages/shared/src/index.ts';
import { startServer } from '../packages/server/src/index.ts';

const results: { id: string; pass: boolean }[] = [];
const check = (id: string, name: string, pass: boolean, detail: string): void => {
  results.push({ id, pass });
  console.log(`  ${pass ? '✓' : '✗'} ${id} ${name}\n      ${detail}`);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
      try { c.msgs.push(JSON.parse(s) as ServerMessage); } catch { /* 留在 raw 里 */ }
    });
    await new Promise<void>((res, rej) => {
      socket.once('open', () => res());
      socket.once('error', rej);
    });
    return c;
  }

  send(m: ClientMessage): void { this.socket.send(encodeClientMessage(m)); }
  find<K extends ServerMessage['t']>(k: K): Extract<ServerMessage, { t: K }> | undefined {
    return this.msgs.find((m) => m.t === k) as Extract<ServerMessage, { t: K }> | undefined;
  }
  last<K extends ServerMessage['t']>(k: K): Extract<ServerMessage, { t: K }> | undefined {
    const hits = this.msgs.filter((m) => m.t === k);
    return hits[hits.length - 1] as Extract<ServerMessage, { t: K }> | undefined;
  }
  all<K extends ServerMessage['t']>(k: K): Extract<ServerMessage, { t: K }>[] {
    return this.msgs.filter((m) => m.t === k) as Extract<ServerMessage, { t: K }>[];
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
  clear(): void { this.raw.length = 0; this.msgs.length = 0; }
  close(): void { this.socket.close(); }
}

/** 开一局两人对战。`preset` 决定刷不刷临时武装（10.1）*/
const startMatch = async (port: number, room: string, preset: ArenaPreset) => {
  const red = await Client.connect(port);
  const blue = await Client.connect(port);

  red.send({ t: 'JoinRoom', roomId: room, name: '红方' });
  await red.waitFor('RoomState');
  // ★ 先手加入者是房主 —— 规则预设只有他改得动
  red.send({ t: 'SetRoomPreset', preset });

  blue.send({ t: 'JoinRoom', roomId: room, name: '蓝方' });
  await blue.waitFor('RoomState');

  red.send({ t: 'SelectTeam', team: 'red' });
  red.send({ t: 'SelectClass', classId: asClassId('warrior') });
  blue.send({ t: 'SelectTeam', team: 'blue' });
  blue.send({ t: 'SelectClass', classId: asClassId('mage') });
  red.send({ t: 'SetReady', ready: true });
  blue.send({ t: 'SetReady', ready: true });

  const r = await red.waitFor('MatchStart');
  const b = await blue.waitFor('MatchStart');
  await red.waitFor('Snapshot');
  // ★ 令牌是开局时发的（见 ServerRoom.tokens 的注释）—— 从消息里取，
  //   而不是去翻服务器内部状态：重连用的就是客户端手上的这一份
  return { red, blue, redId: r.you, blueId: b.you, redToken: r.reconnectToken };
};

const snapsOf = (c: Client) =>
  c.raw.map((f) => { try { return JSON.parse(f) as ServerMessage; } catch { return null; } })
    .filter((m): m is Extract<ServerMessage, { t: 'Snapshot' }> => m?.t === 'Snapshot');

// ════════════════════════════════════════════════════════════════

const server = await startServer(0);
const PORT = server.port;
console.log(`\n服务器已启动（端口 ${PORT}）`);

// ── 1：验收 #28 —— 经典竞技场一件临时武装都没有 ────────────────
console.log('\n── 验收 #28：经典竞技场不生成任何临时武装 ──');
{
  const { red } = await startMatch(PORT, 'classic', ArenaPreset.Classic);
  await sleep(300);
  const snaps = snapsOf(red);
  const anyArsenal = snaps.some((s) => s.armories.length > 0 || s.drops.length > 0);
  check('1', '★ 经典竞技场的快照里军械点与掉落物恒空（#28）',
    snaps.length > 0 && !anyArsenal,
    `${snaps.length} 份快照，含军械数据的有 ${snaps.filter((s) => s.armories.length || s.drops.length).length} 份`);
  red.close();
}

// ── 2–12：武装竞技场的完整链路 ─────────────────────────────────
console.log('\n── 10.1–10.7：武装竞技场（此前整条链路在联网局里不存在）──');
{
  const { red, blue, redId } = await startMatch(PORT, 'armed', ArenaPreset.Armed);
  const match = server.rooms.matchOf('armed')!;

  check('2', '★★ 武装竞技场真的布置了军械点（setupArmories 此前零调用方）',
    match.arsenal.armories.length > 0,
    `军械点 ${match.arsenal.armories.length} 个`);

  await sleep(250);
  check('3', '★ 军械点进了快照（客户端此前完全看不到箱子）',
    snapsOf(red).some((s) => s.armories.length === match.arsenal.armories.length),
    `快照里的军械点数 = ${snapsOf(red).at(-1)?.armories.length}`);

  check('3b', '★★ 快照**不含** openedBy —— 军械箱不带任何实体引用',
    !red.raw.some((f) => f.includes('openedBy')),
    `扫了 ${red.raw.length} 帧原始字节`);

  /**
   * ★ 把倒计时拨到现在。
   *
   *   军械点默认 20 秒后首刷（10.4「固定、可预测的倒计时」），
   *   而这里要验的是**刷出来之后的那条链路**，不是计时器本身
   *   —— 计时与「一轮只刷一次」由 `loadout.test.ts` 的单测钉着。
   *   ★ 只改**时刻**，不伪造掉落物：货仍然由服务器的 `tickArsenal()` 刷，
   *     刷不出来这条就该红。
   */
  const armory = match.arsenal.armories[0]!;
  armory.availableAt = match.world.time;
  await sleep(250);

  check('4', '★★ 到点后服务器真的刷出了实体掉落（spawnDropsFromRoster 此前零调用方）',
    match.arsenal.drops.length > 0,
    `地上 ${match.arsenal.drops.length} 件：${match.arsenal.drops.map((d) => d.kind).join(',')}`);

  red.clear(); blue.clear();
  await sleep(250);
  const redSnap = snapsOf(red).at(-1)!;
  const blueSnap = snapsOf(blue).at(-1)!;
  check('5', '★ 掉落物进了快照，双方都看得到（10.2「看得到掉落物和所属职业」）',
    redSnap.drops.length > 0 && blueSnap.drops.length === redSnap.drops.length,
    `红方看到 ${redSnap.drops.length} 件，蓝方看到 ${blueSnap.drops.length} 件`);

  /**
   * 10.2 的核心：**同一件东西，两个人看到的 `pickable` 不同**。
   * 红方是战士、蓝方是法师，地上有双方职业各一件武器。
   */
  /**
   * ★ P11 波3 重定向：`pickable` 从共享的 drops 段搬去了每人的
   *   `self.pickableDropIds`（共享段只带物品事实）—— 断言跟着搬，
   *   判据实现（sim 的 checkPickup）不动。
   */
  const warriorDrop = redSnap.drops.find((d) => d.ownerClassName === '战士');
  const redCanPick = warriorDrop !== undefined
    && (redSnap.self?.pickableDropIds ?? []).includes(warriorDrop.id);
  const blueCanPick = warriorDrop !== undefined
    && (blueSnap.self?.pickableDropIds ?? []).includes(warriorDrop.id);
  check('6', '★★ pickable 按接收者算：战士的武器只有战士拿得走（10.2 / #29）',
    warriorDrop !== undefined && redCanPick && !blueCanPick,
    `战士武器「${warriorDrop?.itemName}」：红方可拾=${redCanPick}、蓝方可拾=${blueCanPick}`);

  // ── 10.4 开箱与三选一 ────────────────────────────────────────
  // 把红方挪到箱子边上（服务器仍会自己校验 2.2 米，这里只是走过去）
  const redEntity = match.world.entities.get(redId)!;
  redEntity.position = { ...armory.position };
  match.movement.get(redId)!.position = { ...armory.position };

  red.clear(); blue.clear();
  red.send({ t: 'OpenArmory', armoryId: armory.id });
  const offer = await red.waitFor('ArsenalOffer');
  check('7', '★★ 开箱拿到三个横向选择（armoryOptionsFor 此前零调用方）',
    offer.options.length === 3,
    `选项：${offer.options.map((o) => `${o.choice}(${o.advantage})`).join(' / ')}`);

  await sleep(200);
  check('7b', '★★ 三选一是**私信** —— 对手收不到（10.4「只向打开者显示」）',
    blue.all('ArsenalOffer').length === 0 && !blue.raw.some((f) => f.includes('ArsenalOffer')),
    `蓝方收到 ArsenalOffer ${blue.all('ArsenalOffer').length} 条`);

  /**
   * ★ P11 波3 重定向：装备住在 `EntityMeta` 通道（指纹变了才发）。
   *   before 从服务器白盒读（领取前客户端收不到新 meta —— 没变化就不发，
   *   这正是通道的语义）；after 必须来自**客户端真实收到的字节**：
   *   领取改变指纹 → 服务器必然推一条新的 EntityMeta，客户端看得见新装备。
   */
  const { availableWeapons, availableArmors } = await import('../packages/shared/src/index.ts');
  const redLoadout = match.loadouts.get(redId)!;
  const beforeCount = availableWeapons(redLoadout).length + availableArmors(redLoadout).length;

  red.clear();
  red.send({ t: 'ChooseArsenal', armoryId: armory.id, choice: ArsenalChoice.Offense });
  await sleep(250);
  const metaEquip = red.all('EntityMeta')
    .flatMap((m) => m.items.filter((it) => it.entityId === redId && it.equipment !== undefined))
    .map((it) => it.equipment!)
    .at(-1);
  const afterCount = metaEquip && 'allWeaponIds' in metaEquip
    ? metaEquip.allWeaponIds.length + metaEquip.allArmorIds.length : -1;
  check('8', '★★ 领取后装备栏真的多了一件（EntityMeta 推送里看得见）',
    afterCount > beforeCount,
    `装备件数 ${beforeCount} → ${afterCount}`);

  red.clear();
  red.send({ t: 'ChooseArsenal', armoryId: armory.id, choice: ArsenalChoice.Defense });
  await sleep(250);
  check('9', '★ 同一轮领不了第二次（三选一不能变成三选三）',
    red.all('Rejected').some((m) => m.what === 'ChooseArsenal'),
    `拒绝理由：${red.all('Rejected').map((m) => m.reason).join('；') || '（没有被拒绝）'}`);

  blue.clear();
  blue.send({ t: 'ChooseArsenal', armoryId: armory.id, choice: ArsenalChoice.Offense });
  await sleep(250);
  check('10', '★★ 别人打开的箱子领不走（先到者独占这一轮）',
    blue.all('Rejected').some((m) => m.what === 'ChooseArsenal'),
    `拒绝理由：${blue.all('Rejected').map((m) => m.reason).join('；') || '（没有被拒绝）'}`);

  // ── 10.5 拾取 ────────────────────────────────────────────────
  const mineDrop = match.arsenal.drops.find((d) => d.kind === 'consumable')!;
  redEntity.position = { ...mineDrop.position };
  match.movement.get(redId)!.position = { ...mineDrop.position };
  await sleep(120);

  red.clear();
  red.send({ t: 'InteractStart', target: { kind: 'drop', dropId: mineDrop.id } });
  await sleep(EQUIP.PICKUP_SECONDS * 1000 + 400);
  const pickup = red.all('PickupResult');
  check('11', '★★ 拾取 0.8 秒后完成，并收到明确结果（onPickup 此前无人消费）',
    pickup.some((p) => p.ok && p.dropId === mineDrop.id),
    `PickupResult：${pickup.map((p) => `${p.dropId}:${p.ok ? 'ok' : p.reason}`).join('，') || '（一条都没收到）'}`);

  // ★ P11 波3：装备住在 EntityMeta 通道 —— 拾取改变指纹，客户端必收到新视图
  const latestRedEquip = () => red.all('EntityMeta')
    .flatMap((m) => m.items.filter((it) => it.entityId === redId && it.equipment !== undefined))
    .map((it) => it.equipment!)
    .at(-1);
  check('11b', '★ 拿到的东西进了道具栏（10.6 战场道具栏，EntityMeta 推送）',
    (() => {
      const eq = latestRedEquip();
      return !!eq && 'consumableIds' in eq && eq.consumableIds.length > 0;
    })(),
    `道具栏：${(() => {
      const eq = latestRedEquip();
      return eq && 'consumableIds' in eq ? eq.consumableIds.join(',') : '（读不到）';
    })()}`);

  /**
   * 验收 #29：职业不匹配时**提示，但物品不会消失**。
   * ★ 后半句才是这条验收的重点 —— 前半句错了玩家会困惑，
   *   后半句错了对手可以用「乱按交互」清空场上的装备。
   */
  const warriorItem = match.arsenal.drops.find((d) => d.classId !== undefined && (d.classId as string) === 'warrior');
  if (warriorItem) {
    const blueEntity = match.world.entities.get(snapsOf(blue).at(-1)!.you)!;
    blueEntity.position = { ...warriorItem.position };
    match.movement.get(blueEntity.id)!.position = { ...warriorItem.position };
    await sleep(120);
    blue.clear();
    blue.send({ t: 'InteractStart', target: { kind: 'drop', dropId: warriorItem.id } });
    await sleep(300);
    const failed = blue.all('PickupResult').some((p) => !p.ok && p.dropId === warriorItem.id);
    const stillThere = match.arsenal.drops.some((d) => d.id === warriorItem.id);
    check('12', '★★ 验收 #29：职业不匹配有明确提示，且**物品仍然在地上**',
      failed && stillThere,
      `收到失败反馈=${failed}（${blue.all('PickupResult').map((p) => p.reason).join('')}）、物品仍在=${stillThere}`);
  } else {
    check('12', '★★ 验收 #29：职业不匹配有明确提示，且物品仍然在地上',
      false, '场上没有战士归属的掉落物 —— 这条没验成');
  }

  // ── 10.1 消耗品：从捡到用的完整路径 ──────────────────────────
  red.clear();
  red.send({ t: 'UseConsumable', slot: 0 });
  await sleep(300);
  const gotAura = red.all('AuraApplied').some((a) => a.auraId.startsWith('consumable.'));
  check('13', '★★ 消耗品能用出来（16.2「增益期间击杀」的前提，已知偏差 #2）',
    gotAura,
    `收到的光环：${red.all('AuraApplied').map((a) => a.auraId).join(',') || '（没有）'}`);

  red.close(); blue.close();
}

// ── 15–17：16a 战后统计真的送到了客户端 ────────────────────────
console.log('\n── 16.x / 16.4：战后统计与七项最佳玩家（此前算完就被丢掉）──');
{
  const { red, blue, redId, blueId } = await startMatch(PORT, 'stats', ArenaPreset.Classic);
  const match = server.rooms.matchOf('stats')!;

  /**
   * 造一个有内容的结局：红方打死蓝方。
   * ★ 直接改血量而不是打满一整局 —— 这里验的是「统计有没有出口」，
   *   统计口径本身由 `stats.test.ts` 的单测钉着。
   *   ⚠️ 但**伤害必须真的走一遍结算**，否则统计里就是一片 0，
   *   那样这条断言会因为「什么都没发生」而平凡通过。
   */
  const blueEntity = match.world.entities.get(blueId)!;
  blueEntity.health = 40;
  await sleep(120);

  const redEntity = match.world.entities.get(redId)!;
  redEntity.position = { ...blueEntity.position, x: blueEntity.position.x + 1 };
  match.movement.get(redId)!.position = { ...redEntity.position };

  /**
   * ★★ **手动单步推进，不等墙上时间** —— 与 verify-m10 #12 同一个手法。
   *
   *   `ARENA.PREP_SECONDS = 18`：准备阶段就有 18 秒，在那期间打死人
   *   **不会**结束对局。第一版靠真实时间打，于是蓝方死了却收不到
   *   `MatchEnd`/`MatchStats`，报出来像「统计没下发」——
   *   而真相是这局根本还没进战斗阶段。定步长循环让快进是安全的：
   *   每一步都和真实运行完全一样，只是不等时钟。
   */
  const loop = server.rooms.loopOf('stats')!;
  for (let i = 0; i < 400 && !match.arena?.outcome; i++) loop.advance();

  /**
   * ★ 伤害要**真的走一遍结算**，否则统计里是一片 0，
   *   而那会让下面几条因为「什么都没发生」而平凡通过。
   *   靠 7.6 普通攻击打：战士开局 0 怒气（怒气来源就是挥击本身），
   *   技能全被「资源不足」挡掉。选中敌方硬目标即开火（偏差 #9）。
   */
  red.send({ t: 'SetTarget', slot: 'hard', entityId: blueId });
  for (let i = 0; i < 4; i++) loop.advance();          // 让 SetTarget 落地
  match.world.entities.get(blueId)!.health = 40;
  for (let i = 0; i < 600 && match.world.entities.get(blueId)!.alive; i++) loop.advance();
  for (let i = 0; i < 60 && !match.arena?.outcome; i++) loop.advance(); // 过结算窗口

  /**
   * ★★ 前置条件的判据是**客户端收到的 `Death` 消息**，不是事后读 `entity.alive`。
   *
   *   死亡、回合结算、复活可以发生在**同一个 tick 里**（settleDeaths →
   *   回合判定 → 复活重置），于是从外面**永远观察不到** `alive === false`
   *   这个中间态 —— 前两版分别写成「循环后读 alive」和「循环中记一个标志」，
   *   都报「蓝方存活=true」，看起来像没打死，而统计里明明写着「击杀=1」。
   *   消息流是外部可观测的事实，中间态不是。
   */
  /**
   * ★ 用 `waitFor` 而不是 `sleep(200)`：上面同步跑了一千多个 tick，
   *   每个 tick 都往 socket 里塞了两份快照，于是 Damage/Death 排在
   *   一千多帧后面还没送到 —— 固定睡 200ms 会读到一个空的消息列表，
   *   报「收到 Death 消息 0 条」，看起来像服务器没发。**队列没冲完不等于没发生。**
   */
  await red.waitFor('Death', 8000).catch(() => undefined);
  check('15a', '★ 前置：蓝方真的被打死了（否则下面几条会因为「什么都没发生」而平凡通过）',
    red.all('Death').some((d) => d.entityId === blueId),
    `收到 Death 消息 ${red.all('Death').length} 条`);

  const stats = await red.waitFor('MatchStats', 5000).catch(() => undefined);
  check('15', '★★ 对局结束后真的下发了战后统计（此前 pickAwards 在网络层零调用方）',
    stats !== undefined && stats.rows.length === 2,
    stats ? `${stats.rows.length} 行、${stats.awards.length} 个奖项` : '（一条 MatchStats 都没收到）');

  if (stats) {
    const redRow = stats.rows.find((r) => r.entityId === redId);
    check('15b', '★ 统计里有真实数字，不是一张全 0 的表',
      (redRow?.damageDone ?? 0) > 0,
      `红方伤害=${redRow?.damageDone}、击杀=${redRow?.kills}、暴击=${redRow?.crits}`);

    check('16', '★ 16.4 的七项最佳玩家都在（含无人获奖的项）',
      stats.awards.length === 7,
      stats.awards.map((a) => `${a.name}:${a.winnerName ?? '—'}`).join('，'));

    const overall = stats.awards.find((a) => a.award === 'bestOverall');
    check('16b', '★★ 综合奖带着「由哪些维度构成」—— 16.4 第二条要看得见',
      overall !== undefined && (overall.winnerId === undefined || (overall.parts?.length ?? 0) > 0),
      `综合奖=${overall?.winnerName ?? '（无）'}、维度 ${overall?.parts?.length ?? 0} 项`);
  }

  check('17', '★ 双方都收到统计（不是只发给赢家）',
    blue.all('MatchStats').length > 0,
    `蓝方收到 ${blue.all('MatchStats').length} 条`);

  red.close(); blue.close();
}

// ── 18–21：16b 人机补位与掉线接管 ──────────────────────────────
console.log('\n── 16b / 偏差 #14：人机补位与掉线接管 ──');
{
  const { red, blue, redId, redToken } = await startMatch(PORT, 'bots', ArenaPreset.Classic);
  const match = server.rooms.matchOf('bots')!;
  const loop = server.rooms.loopOf('bots')!;

  for (let i = 0; i < 400 && !match.arena?.outcome; i++) loop.advance(); // 过 18 秒准备阶段

  const redEntity = match.world.entities.get(redId)!;
  const before = { ...redEntity.position };

  /**
   * ★★ 断线**瞬间**接管（偏差 #14），不是超时才接管。
   *   判据是「角色开始自己动」——而且动的方式必须是**经过完整协议栈**的：
   *   `BotDriver` 发的是真的 `Input` JSON，走 codec + 阶段鉴权 + 排队。
   */
  red.close();
  await sleep(300);
  for (let i = 0; i < 120; i++) loop.advance();   // 6 秒

  const moved = Math.hypot(
    redEntity.position.x - before.x, redEntity.position.z - before.z,
  );
  check('18', '★★ 断线瞬间由人机接管：角色真的自己动起来了',
    moved > 1,
    `断线后位移 ${moved.toFixed(2)} 米（此前的规则是「站在原地被打」）`);

  check('18b', '★ 人机走的是**真人那条输入通道**（假 socket + 真 Session + 真 codec）',
    match.world.entities.get(redId)!.alive,
    `实体仍在世界里、由 tickWorld 驱动 —— 没有任何一行直接改过 world`);

  /**
   * ★ 11.5 的「超时按淘汰处理」不再发生（偏差 #14）——
   *   宽限期已放到长于任何一局，`takeExpired()` 永远返回空。
   */
  for (let i = 0; i < 200; i++) loop.advance();
  check('19', '★★ 不再有「超时淘汰」——人可以整局内随时回来',
    !blue.all('PeerEliminated').some((m) => m.reason === 'timeout'),
    `收到的淘汰消息：${blue.all('PeerEliminated').map((m) => m.reason).join(',') || '（没有）'}`);

  // 重连交还
  const back = await Client.connect(PORT);
  back.send({ t: 'Reconnect', token: redToken });
  const restart = await back.waitFor('MatchStart', 4000).catch(() => undefined);
  check('20', '★★ 重连交还：人回来后拿回自己的角色',
    restart !== undefined && restart.you === redId,
    restart ? `重连后 you=${restart.you}（原实体 ${redId}）` : '（重连失败）');

  if (restart) {
    /**
     * ★ 交还之后人机必须**彻底下台**：两条会话同时为同一个实体投输入的话，
     *   `collectInputs()` 取「最后一条」，人的操作会被人机盖掉 ——
     *   而那种 bug 的表现是「我的角色偶尔不听使唤」，极难查。
     */
    const posBefore = { ...match.world.entities.get(redId)!.position };
    for (let i = 0; i < 100; i++) loop.advance();   // 5 秒，人不发任何输入
    const drift = Math.hypot(
      match.world.entities.get(redId)!.position.x - posBefore.x,
      match.world.entities.get(redId)!.position.z - posBefore.z,
    );
    check('20b', '★★ 交还后人机彻底下台 —— 玩家不发输入时角色就该站住',
      drift < 0.5,
      `人不发输入的 5 秒里位移 ${drift.toFixed(2)} 米`);
  }

  blue.close(); back.close();
}

// ── 14：房间设置的权限 ─────────────────────────────────────────
console.log('\n── 3.1：规则预设只有房主改得动 ──');
{
  const red = await Client.connect(PORT);
  const blue = await Client.connect(PORT);
  red.send({ t: 'JoinRoom', roomId: 'host', name: '房主' });
  await red.waitFor('RoomState');
  blue.send({ t: 'JoinRoom', roomId: 'host', name: '客人' });
  await blue.waitFor('RoomState');

  blue.clear();
  blue.send({ t: 'SetRoomPreset', preset: ArenaPreset.Armed });
  await sleep(250);
  const rejected = blue.all('Rejected').some((m) => m.what === 'SetRoomPreset');
  /**
   * ★ 判据是「**没有**任何一份 RoomState 说预设变成了武装」，而不是
   *   「最后一份 RoomState 仍是经典」—— 被拒的变更根本不会触发广播，
   *   于是 `last('RoomState')` 是 undefined，那条写法会**假失败**。
   *   （第一版就是这么写的，报的是「预设仍为经典=false」，
   *   而真相是「一份 RoomState 都没来，因为服务器正确地拒绝了」。）
   */
  const leaked = blue.all('RoomState').some((s) => s.preset === ArenaPreset.Armed);
  check('14', '★ 非房主改不动规则预设',
    rejected && !leaked,
    `被拒=${rejected}、事后收到的 RoomState 共 ${blue.all('RoomState').length} 份，其中说是武装的 ${blue.all('RoomState').filter((s) => s.preset === ArenaPreset.Armed).length} 份`);

  red.clear();
  red.send({ t: 'SetRoomPreset', preset: ArenaPreset.Armed });
  await sleep(250);
  check('14b', '★ 房主改得动（证明上一条不是「谁都改不动」）',
    red.last('RoomState')?.preset === ArenaPreset.Armed,
    `当前预设=${red.last('RoomState')?.preset}`);

  red.close(); blue.close();
}

// ════════════════════════════════════════════════════════════════

await server.close();   // ★ 它内部会 stopAll()

const passed = results.filter((r) => r.pass).length;
console.log(`\nM16 验收：${passed}/${results.length} 通过\n`);
process.exit(passed === results.length ? 0 : 1);
