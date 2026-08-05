/**
 * M13 端到端验收：**两个浏览器纯 UI 操作（零 URL 老参数）完成一场对局**。
 * docs/14 §M13 判据逐条落实：
 *
 *   1. 浏览器 A 纯点击：建房 → 选阵营 → 选职业 → 准备
 *   2. 浏览器 B 纯点击：**输入房间码**加房 → 另一阵营 → 职业 → 准备 → 双方进对局
 *   3. 对局里 A 打 B 一次，**双方都收到 Damage**（复用 m10 的判据思路：
 *      断言的是客户端真实收到的消息计数，不是画面）
 *   4. MatchEnd 后回到房间页，**再开一局成功**（第二个 MatchStart）
 *   5. 全程 `location.search` 里没有 `net=`（证明不是 URL 老路）
 *
 * ★ 服务器照 verify:m10 在**本进程**里起（随机端口），于是可以白盒布置
 *   战况（传送到贴脸、把血调低）—— 布置是白盒的，断言全部落在
 *   浏览器侧收到的消息与 UI 状态上。施法本身走真实键盘（Tab + Digit2）。
 *
 * 用法：pnpm --filter @wowpvp/client dev（另一个终端，端口 5173）
 *       pnpm verify:m13
 */

import { chromium, type Browser, type Page } from 'playwright';
import { startServer } from '../packages/server/src/index.ts';
import { asClassId, getClass, teleportTo } from '../packages/shared/src/index.ts';

const BASE = process.env.VERIFY_URL ?? 'http://localhost:5173';

const results: { id: string; name: string; pass: boolean }[] = [];
const check = (id: string, name: string, pass: boolean, detail: string): void => {
  results.push({ id, name, pass });
  console.log(`  ${pass ? '✓' : '✗'} ${id} ${name}\n      ${detail}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 轮询浏览器里的 __lobby.status 直到条件成立 */
const waitStatus = async (
  page: Page,
  what: string,
  cond: string,
  timeoutMs = 8000,
): Promise<Record<string, unknown>> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = (await page.evaluate(
      `(() => { const l = globalThis.__lobby; if (!l) return null; const st = l.status; return { ok: !!(${cond}), st }; })()`,
    )) as { ok: boolean; st: Record<string, unknown> } | null;
    if (s?.ok) return s.st;
    if (Date.now() > deadline) {
      throw new Error(`等「${what}」超时；当前状态：${JSON.stringify(s?.st ?? null)}`);
    }
    await sleep(80);
  }
};

// ── 启动 ─────────────────────────────────────────────────────────

const server = await startServer(0);
console.log(`\n服务器已启动（本进程，端口 ${server.port}）`);

/** 与 verify-m1/m12 同一套浏览器回落 */
const browser: Browser = await (async () => {
  try {
    return await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  } catch {
    for (const channel of ['msedge', 'chrome']) {
      try { return await chromium.launch({ channel }); } catch { /* 试下一个 */ }
    }
    throw new Error('没有可用浏览器：捆绑 chromium 未安装，msedge/chrome 也不可用');
  }
})();

/**
 * 大厅入口 URL：`?lobby` + `art=off`（软件渲染跑得动，与 m1–m10 同一理由）
 * + `server=`（指到本进程的随机端口）。
 * ★ 三个都是**既有语义**的参数；判据第 5 条盯的是 `net=` 不出现。
 */
const LOBBY_URL = `${BASE}/?lobby&art=off&server=${encodeURIComponent(`ws://127.0.0.1:${server.port}`)}`;

const newPage = async (label: string): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.log(`  [${label}] 页面错误: ${e.message}`));
  await page.goto(LOBBY_URL);
  return page;
};

const pageA = await newPage('A');
const pageB = await newPage('B');

try {
  // ── 1：A 纯点击建房 ─────────────────────────────────────────
  await pageA.fill('#lb-name', '阿红');
  await pageA.click('[data-action="create"]');
  const aRoom = await waitStatus(pageA, 'A 进入房间页', `st.page === 'room' && st.roomCode.length > 0`);
  const code = aRoom.roomCode as string;
  const codeShown = (await pageA.textContent('#lb-room-code'))?.trim();
  check('1', '★ A 纯点击建房 → 房间页显示房间码', codeShown === code && code.length >= 4,
    `房间码「${code}」，页面显示「${codeShown}」`);

  await pageA.click('[data-team="red"]');
  await waitStatus(pageA, 'A 进入红方', `st.players.some(p => p.name === '阿红' && p.team === 'red')`);
  await pageA.click('[data-action="open-class"]');
  await pageA.click('.lb-card[data-class="mage"]');
  await waitStatus(pageA, 'A 职业=法师', `st.players.some(p => p.name === '阿红' && p.classId === 'mage')`);
  await pageA.click('[data-action="ready"]');
  const aReady = await waitStatus(pageA, 'A 已准备', `st.players.some(p => p.name === '阿红' && p.ready)`);
  check('2', '★ A 选阵营→选职业→准备（全程点击）',
    (aReady.players as { ready: boolean }[]).some((p) => p.ready),
    `名单：${JSON.stringify(aReady.players)}`);

  // ── 2：B 输入房间码加房 ─────────────────────────────────────
  await pageB.fill('#lb-name', '阿蓝');
  await pageB.fill('#lb-code', code);
  await pageB.click('[data-action="join"]');
  await waitStatus(pageB, 'B 进入房间页', `st.page === 'room' && st.roomCode === '${code}'`);
  await pageB.click('[data-team="blue"]');
  await pageB.click('[data-action="open-class"]');
  await pageB.click('.lb-card[data-class="warrior"]');
  await waitStatus(pageB, 'B 职业=战士', `st.players.some(p => p.name === '阿蓝' && p.classId === 'warrior')`);
  const bRoster = await waitStatus(pageB, 'B 看到两个人', `st.players.length === 2`);
  check('3', '★ B 按房间码加房，双方在同一份名单里',
    (bRoster.players as { name: string }[]).map((p) => p.name).sort().join(',') === '阿红,阿蓝',
    `B 的名单：${JSON.stringify((bRoster.players as { name: string }[]).map((p) => p.name))}`);

  // ── 3：B 准备 → 全员就绪自动开局，两边都进对局 ───────────────
  await pageB.click('[data-action="ready"]');
  // ★ entities 计的是**已渲染**的远端视图（插值缓冲 0.1s + 软件渲染的首帧
  //   都需要时间），所以放进轮询条件里等，而不是抢一个瞬时读数
  const inMatch = `st.page === 'match' && st.net && st.net.started && st.net.snapshots > 3 && st.net.entities === 2`;
  const aMatch = await waitStatus(pageA, 'A 进入对局且看到双方', inMatch, 15000);
  const bMatch = await waitStatus(pageB, 'B 进入对局且看到双方', inMatch, 15000);
  const aNet = aMatch.net as { entities: number; you: number };
  const bNet = bMatch.net as { entities: number; you: number };
  check('4', '★★ 全员准备即开局：双方进入对局并持续收到快照',
    aNet.entities === 2 && bNet.entities === 2 && aNet.you !== bNet.you,
    `A 看到实体 ${aNet.entities} 个（自己=${aNet.you}），B 看到 ${bNet.entities} 个（自己=${bNet.you}）`);

  // ── 4：A 打 B 一次，双方都收到 Damage ────────────────────────
  // 白盒布置（m10 的手法）：把 B 传送到 A 面前两米（A 朝向 -Z），资源满上。
  // 施法走真实 UI：Tab 选中 + 按 2（法师槽 2 = 火焰冲击，瞬发 25m）。
  {
    const match = server.rooms.matchOf(code)!;
    const redE = match.world.entities.get(aNet.you as never)!;
    /**
     * ⚠️ 传送必须写 `match.movement`（权威移动状态），不能只改 entity.position ——
     * B 的浏览器每 50ms 发一条 Input，移动系统按**自己的状态**积分，
     * 直接写实体坐标活不过一个 tick（首跑抓到：写完仍然相距 116 米）。
     * `teleportTo` 是 sim 自己的传送函数（冲锋/闪现同款），顺带置 teleported 标记。
     */
    const blueMove = match.movement.get(bNet.you as never)!;
    match.movement.set(
      bNet.you as never,
      teleportTo(blueMove, { x: redE.position.x, y: 0, z: redE.position.z - 2 }, match.map.geometry),
    );
    for (const [r, max] of redE.maxResources) redE.resources.set(r, max);

    const mage = getClass(asClassId('mage'))!;
    const slot = mage.skills.findIndex((s) => (s.id as string) === 'mage.fire_blast');
    if (slot < 0 || slot > 7) throw new Error('法师技能表里找不到 1–8 槽内的火焰冲击');

    await sleep(400); // 让传送随快照到达两端
    await pageA.keyboard.press('Tab');
    await sleep(150);
    await pageA.keyboard.press(`Digit${slot + 1}`);

    const aDmg = await waitStatus(pageA, 'A 收到 Damage', `st.damageSeen >= 1`, 6000);
    const bDmg = await waitStatus(pageB, 'B 收到 Damage', `st.damageSeen >= 1`, 6000);
    check('5', '★★ A 用键盘打 B 一次，双方客户端都收到 Damage 消息',
      (aDmg.damageSeen as number) >= 1 && (bDmg.damageSeen as number) >= 1,
      `A damageSeen=${aDmg.damageSeen}，B damageSeen=${bDmg.damageSeen}`);

    /**
     * ★★ 联网施法注册表的守卫。
     *
     * `SnapshotCombatView.playerCast` 自 M10 起就是个**声明了却没有人赋值**的
     * 死字段：自己的施法条、姓名板施法条、目标框施法条、施法姿态动画
     * 四条通道一起是死的，而 915 个单测与 14 项 m10 验收一条都没发现 ——
     * 它们验的是「快照解析对不对」，洞在「有没有人把事件写进去」。
     *
     * 修好之后必须留一条断言看着它，否则下次重构照样会悄悄死掉。
     * 这里按一个**读条**技能（霜矢 1.4 秒），瞬发技能不会进施法状态。
     */
    const castSlot = mage.skills.findIndex((s) => (s.id as string) === 'mage.frostbolt');
    if (castSlot < 0 || castSlot > 7) throw new Error('法师技能表里找不到 1–8 槽内的霜矢');
    await sleep(1700); // 等火焰冲击的 GCD 过去
    await pageA.keyboard.press(`Digit${castSlot + 1}`);
    const casting = await waitStatus(
      pageA, 'A 进入施法状态', 'st.net && st.net.casting.self === true', 4000,
    );
    const netCast = (casting.net as { casting?: { self: boolean; total: number } } | null)?.casting;
    check('10', '★★ 联网侧自己的施法状态真的被写进注册表（playerCast 不再是死字段）',
      netCast?.self === true, `casting=${JSON.stringify(netCast)}`);

    /**
     * ★ W1（技术债总账）：联网队伍框第一次被喂数据。
     *   `PartyFrame` 自 M8 就构造好、试验场在喂，联网侧此前零调用 ——
     *   治疗职业在联网局里看不到任何队友血量。1v1 里己方 = 自己一人，
     *   断言「有且恰好一行、名字是自己的」：行数为 0 = 没接线，
     *   行数为 2 = 把敌人也算成了队友（同样是错）。
     */
    const party = await pageA.evaluate(() => {
      const rows = [...document.querySelectorAll('#party-frame .pf-member')];
      return {
        count: rows.length,
        names: rows.map((r) => r.querySelector('.pf-name')?.textContent ?? ''),
        visible: (document.querySelector('#party-frame') as HTMLElement | null)?.style.display !== 'none',
      };
    });
    check('11', '★ 联网队伍框显示己方成员（W1 接线）',
      party.visible && party.count === 1 && party.names.includes('阿红'),
      `visible=${party.visible} rows=${party.count} names=${JSON.stringify(party.names)}`);

    /**
     * ★ W3/W4（技术债总账）：15.4 竞技场模式 HUD 第一次被喂。
     *   `renderArena()` 此前全仓库零调用 —— 战斗抑制与决胜阶段从未显示过。
     *   同时钉 15.4 的否定式：竞技场面板**不显示任何旗帜信息**
     *   （ArenaHudView 类型上没有旗帜字段，这里从渲染结果再验一遍）。
     */
    const modeHud = await pageA.evaluate(() => {
      const el = document.querySelector('#mode-hud') as HTMLElement | null;
      return {
        visible: el !== null && el.style.display !== 'none',
        mode: el?.dataset['mode'] ?? '',
        text: el?.textContent ?? '',
      };
    });
    check('12', '★ 联网竞技场模式 HUD：战斗抑制可见，且不含任何旗帜信息（W3/W4 + 15.4 否定式）',
      modeHud.visible && modeHud.mode === 'arena'
        && modeHud.text.includes('战斗抑制') && modeHud.text.includes('回合')
        && !modeHud.text.includes('旗'),
      `visible=${modeHud.visible} mode=${modeHud.mode} 含旗字=${modeHud.text.includes('旗')}`);

    /**
     * ★ W2（技术债总账）：联网小地图第一次被喂。canvas 无 DOM 可查，
     *   直接读中心像素。自己的 blip 恒在中心，但本局 B 就站在 A 面前 2 米
     *   （≈1.7px），敌方点会压在自己点上面 —— 所以判据是「中心有**某个**
     *   blip」：白（自己 #fff）或红（敌 #ff7a6f）都 r>200；没接线时 canvas
     *   全透明（a=0）、只有底盘时 r≈14，两种失败态都分得开。
     */
    const minimap = await pageA.evaluate(() => {
      const cv = document.querySelector('#minimap canvas') as HTMLCanvasElement | null;
      if (!cv) return { found: false, r: 0, g: 0, b: 0, a: 0 };
      const ctx = cv.getContext('2d')!;
      const px = ctx.getImageData(Math.floor(cv.width / 2), Math.floor(cv.height / 2), 1, 1).data;
      return { found: true, r: px[0]!, g: px[1]!, b: px[2]!, a: px[3]! };
    });
    check('13', '★ 联网小地图在画：中心是 blip 而非空白/底盘（W2 接线）',
      minimap.found && minimap.a > 200 && minimap.r > 200,
      `found=${minimap.found} rgba=(${minimap.r},${minimap.g},${minimap.b},${minimap.a})`);
  }

  // ── 5：收掉这局 → MatchEnd → 双方回房间 → 再开一局 ──────────
  {
    const match = server.rooms.matchOf(code)!;
    const loop = server.rooms.loopOf(code)!;
    // 快进过 18 秒准备阶段进入战斗阶段（回合结算只在战斗阶段判定）
    for (let i = 0; i < 420 && !match.arena?.outcome; i++) loop.advance();
    // 火焰冲击冷却也被上面的快进一并走完了；把败方血量压到 1，再来一发
    const blueE = match.world.entities.get(bNet.you as never)!;
    blueE.health = 1;
    const redE = match.world.entities.get(aNet.you as never)!;
    for (const [r, max] of redE.maxResources) redE.resources.set(r, max);

    /**
     * ★ W5（技术债总账）之一：11.4 反向 —— **活着**按 V 无效。
     *   活人跟随别人就是透视，客户端根本不发 SpectateFollow。
     */
    await pageA.keyboard.press('KeyV');
    await sleep(150);
    const aliveV = await waitStatus(pageA, 'A 活着按 V 后状态可读', 'st.net !== null', 2000);
    const aliveSpectating = (aliveV['net'] as { spectating?: number | null } | null)?.spectating;

    /**
     * ★ W5 之二：死亡遮罩。B 阵亡到 MatchEnd 之间只有 0.5 秒结算窗口
     *   （ARENA.DRAW_WINDOW），外部轮询每次往返 ~250ms 会随机漏掉整个窗口 ——
     *   特效二期 watchPeaks 的老坑，同款修法：**先挂 rAF 监视器再按键**，
     *   采样全程在页面内完成。
     */
    // ★ 字符串形式的 evaluate —— 函数形式会被 tsx/esbuild 注入 __name 助手，
    //   浏览器上下文里没有它（waitStatus 全程用字符串正是同一个原因）
    await pageB.evaluate(`(() => {
      globalThis.__deathSeen = false;
      const tick = () => {
        const st = globalThis.__lobby && globalThis.__lobby.status;
        if (st && st.net && st.net.deathOverlay) { globalThis.__deathSeen = true; return; }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })()`);

    await sleep(300);
    await pageA.keyboard.press('Tab');
    await sleep(120);
    const mage = getClass(asClassId('mage'))!;
    const slot = mage.skills.findIndex((s) => (s.id as string) === 'mage.fire_blast');
    await pageA.keyboard.press(`Digit${slot + 1}`);

    await waitStatus(pageA, 'A 收到 MatchEnd', `st.matchEnds >= 1 && st.page === 'end'`, 8000);
    await waitStatus(pageB, 'B 收到 MatchEnd', `st.matchEnds >= 1 && st.page === 'end'`, 8000);
    const banner = (await pageA.textContent('#lb-end-title'))?.trim() ?? '';
    check('6', '★★ 分出胜负：双方看到结算横幅', banner.includes('红方'),
      `A 的横幅：「${banner}」`);

    const deathSeen = (await pageB.evaluate('globalThis.__deathSeen === true')) === true;
    check('14', '★ 死亡遮罩在阵亡瞬间出现；活着按 V 不进观战（W5 接线 + 11.4 反向）',
      deathSeen && aliveSpectating === null,
      `B 遮罩抓到=${deathSeen}；A 活着按 V 后 spectating=${JSON.stringify(aliveSpectating)}`);

    // 回到房间：名单还在、全员未准备、职业保留
    await pageA.click('[data-action="rematch"]');
    await pageB.click('[data-action="rematch"]');
    const aBack = await waitStatus(pageA, 'A 回到房间页',
      `st.page === 'room' && st.roomStarted === false && st.players.length === 2 && st.players.every(p => !p.ready)`);
    check('7', '★★ MatchEnd 后回到房间页：名单保留、全员待重新准备',
      (aBack.players as { classId: string | null }[]).every((p) => p.classId !== null),
      `名单：${JSON.stringify(aBack.players)}`);

    // 再开一局
    await pageA.click('[data-action="ready"]');
    await pageB.click('[data-action="ready"]');
    const aSecond = await waitStatus(pageA, 'A 第二局开局',
      `st.matchStarts >= 2 && st.page === 'match' && st.net && st.net.started && st.net.snapshots > 3`, 12000);
    await waitStatus(pageB, 'B 第二局开局',
      `st.matchStarts >= 2 && st.page === 'match' && st.net && st.net.started`, 12000);
    check('8', '★★ 房间页里再开一局成功（第二个 MatchStart，快照在流）',
      (aSecond.matchStarts as number) >= 2,
      `A matchStarts=${aSecond.matchStarts}，第二局快照=${(aSecond.net as { snapshots: number }).snapshots}`);
  }

  // ── 6：全程不是 URL 老路 ─────────────────────────────────────
  {
    const aSearch = await pageA.evaluate('location.search');
    const bSearch = await pageB.evaluate('location.search');
    check('9', '★ 全程 location.search 无 net=（不是 URL 老路）',
      !String(aSearch).includes('net=') && !String(bSearch).includes('net='),
      `A: ${aSearch} · B: ${bSearch}`);
  }
} finally {
  await browser.close();
  await server.close();
}

console.log(`\n${'─'.repeat(60)}`);
const failed = results.filter((r) => !r.pass);
console.log(`M13 验收：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('失败项：' + failed.map((f) => f.id).join(', '));
  process.exit(1);
}
