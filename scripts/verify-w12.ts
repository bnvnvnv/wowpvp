/**
 * W12 端到端验收：**两个浏览器纯 UI 开一场夺旗打到得分**（docs/16 §3.5 判据）。
 *
 *   1. A 建房 → 点「夺旗 6v6」→ 房间元信息换成夺旗地图；B 加房只读模式按钮
 *   2. 双方准备 → 在 ctf_twin_bridges 开局，两边都看到两面 3D 旗与夺旗 HUD
 *   3. 夺旗死亡走 12.6 波次：死亡遮罩带「复活波次 Ns」、到点复活在墓地
 *      （不是死点 —— enqueue 与 movement 同步两条接线的 e2e）
 *   4. A 拔蓝旗（G，1.2s）→ 双方 HUD 同步看到「被携带 + 旗手名」（12.2）
 *   5. A 回己方旗房交旗（G，0.8s）→ 得分 → `ctfWinner` 判胜 → MatchEnd
 *   6. 结算面板出现夺旗/归还/截旗三列，A 的夺旗 = 1
 *   7. **全程** rAF 监视：对局期间任意一帧旗帜数据缺失/3D 旗少于两面都算违例
 *
 * ★ 与 verify-m13 同一套骨架：服务器在本进程（白盒布置传送与血量），
 *   断言全部落在浏览器收到的消息与 UI 状态上；交互走真实键盘（Tab/数字/G）。
 *
 * 用法：pnpm --filter @wowpvp/client dev（另一个终端，端口 5173）
 *       pnpm verify:w12
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

/** 轮询浏览器里的 __lobby.status 直到条件成立（与 m13 同一份工具）*/
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
  // ── 1：A 建房并把模式切成夺旗 6v6 ──────────────────────────────
  await pageA.fill('#lb-name', '阿红');
  await pageA.click('[data-action="create"]');
  const aRoom = await waitStatus(pageA, 'A 进入房间页', `st.page === 'room' && st.roomCode.length > 0`);
  const code = aRoom.roomCode as string;

  await pageA.click('[data-mode="ctf6v6"]');
  const aMode = await waitStatus(pageA, 'A 的房间切到夺旗',
    `st.mode === 'ctf6v6' && st.mapId === 'ctf_twin_bridges'`);
  const metaText = (await pageA.textContent('#lb-room-meta'))?.trim() ?? '';
  check('1', '★★ 房主点一下按钮把房间切成夺旗 6v6，地图随模式换（SetRoomMode 全链路）',
    aMode.mode === 'ctf6v6' && metaText.includes('6v6') && metaText.includes('夺旗'),
    `mode=${aMode.mode} mapId=${aMode.mapId} 元信息「${metaText}」`);

  await pageA.click('[data-team="red"]');
  await pageA.click('[data-action="open-class"]');
  await pageA.click('.lb-card[data-class="mage"]');
  await waitStatus(pageA, 'A 职业=法师', `st.players.some(p => p.name === '阿红' && p.classId === 'mage')`);
  await pageA.click('[data-action="ready"]');
  await waitStatus(pageA, 'A 已准备', `st.players.some(p => p.name === '阿红' && p.ready)`);

  // ── 2：B 加房 —— 模式对非房主只读 ──────────────────────────────
  await pageB.fill('#lb-name', '阿蓝');
  await pageB.fill('#lb-code', code);
  await pageB.click('[data-action="join"]');
  await waitStatus(pageB, 'B 看到夺旗房间', `st.page === 'room' && st.mode === 'ctf6v6'`);
  const bButtons = await pageB.evaluate(() => ({
    modeDisabled: (document.querySelector('[data-mode="ctf6v6"]') as HTMLButtonElement | null)?.disabled ?? false,
    presetDisabled: (document.querySelector('#lb-preset-armed') as HTMLButtonElement | null)?.disabled ?? false,
    presetWhy: document.querySelector('#lb-preset-why')?.textContent ?? '',
  }));
  check('2', '★ 非房主看得到夺旗模式但按钮只读；夺旗下规则预设禁用并说明原因',
    bButtons.modeDisabled && bButtons.presetDisabled && bButtons.presetWhy.includes('临时装备'),
    `mode 禁用=${bButtons.modeDisabled} preset 禁用=${bButtons.presetDisabled} 说明「${bButtons.presetWhy}」`);

  // ── 3：开局 —— 双方都拿到旗帜数据与 3D 旗 ──────────────────────
  await pageB.click('[data-team="blue"]');
  await pageB.click('[data-action="open-class"]');
  await pageB.click('.lb-card[data-class="warrior"]');
  await waitStatus(pageB, 'B 职业=战士', `st.players.some(p => p.name === '阿蓝' && p.classId === 'warrior')`);
  await pageB.click('[data-action="ready"]');

  const inCtf = `st.page === 'match' && st.net && st.net.started && st.net.snapshots > 3`
    + ` && st.net.ctf && st.net.ctf.flags.length === 2 && st.net.ctf.markers === 2`;
  const aMatch = await waitStatus(pageA, 'A 进入夺旗对局', inCtf, 15000);
  const bMatch = await waitStatus(pageB, 'B 进入夺旗对局', inCtf, 15000);
  const aNet = aMatch.net as { you: number; ctf: { scoreToWin: number; markers: number } };
  const bNet = bMatch.net as { you: number; ctf: { markers: number } };
  check('3', '★★ 纯 UI 开出一场夺旗：双方快照都带两面旗、两面 3D 旗都真的画了',
    aNet.ctf.markers === 2 && bNet.ctf.markers === 2 && aNet.ctf.scoreToWin === 1,
    `A markers=${aNet.ctf.markers} B markers=${bNet.ctf.markers} scoreToWin=${aNet.ctf.scoreToWin}`);

  // 15.4 右列 + 否定式：夺旗 HUD 显示旗帜与比分，不显示竞技场的战斗抑制
  const modeHud = await pageA.evaluate(() => {
    const el = document.querySelector('#mode-hud') as HTMLElement | null;
    return {
      visible: el !== null && el.style.display !== 'none',
      mode: el?.dataset['mode'] ?? '',
      text: el?.textContent ?? '',
    };
  });
  check('4', '★ 联网夺旗模式 HUD：旗帜状态可见，且不含竞技场字段（15.4 两列不相交）',
    modeHud.visible && modeHud.mode === 'ctf'
      && modeHud.text.includes('红旗') && modeHud.text.includes('蓝旗')
      && !modeHud.text.includes('战斗抑制'),
    `visible=${modeHud.visible} mode=${modeHud.mode}`);

  // ── 全程监视：对局期间任何一帧旗帜缺失都算违例（12.2 持续可见）──
  for (const page of [pageA, pageB]) {
    await page.evaluate(`(() => {
      globalThis.__flagWatch = { frames: 0, violations: 0 };
      const tick = () => {
        const st = globalThis.__lobby && globalThis.__lobby.status;
        if (st && st.page === 'match' && st.net && st.net.started) {
          globalThis.__flagWatch.frames++;
          const c = st.net.ctf;
          if (!c || c.flags.length < 2 || c.markers < 2) globalThis.__flagWatch.violations++;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })()`);
  }

  const match = server.rooms.matchOf(code)!;
  const redE = match.world.entities.get(aNet.you as never)!;
  const blueE = match.world.entities.get(bNet.you as never)!;

  /** 白盒传送：必须写 movement（权威移动状态），与 m13 同一条注意事项 */
  const teleport = (id: number, x: number, z: number): void => {
    const ms = match.movement.get(id as never)!;
    match.movement.set(id as never, teleportTo(ms, { x, y: 0, z }, match.map.geometry));
  };

  // ── 4：夺旗死亡 = 波次复活（死亡遮罩倒计时 + 复活在墓地不在死点）──
  {
    // 把两人摆到蓝旗房：B 在 A 正前方（A 面向 -Z），B 血压到 1
    teleport(aNet.you, 0, -123.9);
    teleport(bNet.you, 0, -127);
    blueE.health = 1;
    for (const [r, max] of redE.maxResources) redE.resources.set(r, max);

    const mage = getClass(asClassId('mage'))!;
    const slot = mage.skills.findIndex((s) => (s.id as string) === 'mage.fire_blast');
    if (slot < 0 || slot > 7) throw new Error('法师技能表里找不到 1–8 槽内的火焰冲击');

    await sleep(400); // 让传送随快照到达两端
    await pageA.keyboard.press('Tab');
    await sleep(150);
    await pageA.keyboard.press(`Digit${slot + 1}`);

    await waitStatus(pageB, 'B 阵亡出现死亡遮罩', 'st.net && st.net.deathOverlay === true', 6000);
    const overlayText = await pageB.evaluate(
      () => document.querySelector('#death-overlay')?.textContent ?? '',
    );
    check('5', '★ 夺旗死亡遮罩显示「复活波次 Ns」而不是竞技场的「本回合已淘汰」（W5 余账）',
      overlayText.includes('复活波次') && !overlayText.includes('本回合已淘汰'),
      `遮罩文案「${overlayText.trim().replace(/\s+/g, ' ')}」`);

    // 白盒把下一波拨近（不真等 12 秒）；复活点在蓝方墓地（z ≤ -148），
    // 而 B 死在 z=-127 —— 位置差就是「enqueue + movement 同步」两条接线的证词
    match.respawn!.nextWaveAt = match.world.time + 1;
    const revived = await waitStatus(
      pageB, 'B 波次复活', 'st.net && st.net.deathOverlay === false && st.net.position.z < -140', 8000,
    );
    const bPos = (revived.net as { position: { z: number } }).position;
    check('6', '★★ 波次复活闭环：死者自动入队、到点复活在墓地出口（不是被移动积分拽回死点）',
      bPos.z < -140,
      `复活后 B.z=${bPos.z.toFixed(1)}（死点 z=-127，蓝方墓地 z≤-148）`);
  }

  // ── 5：A 拔蓝旗 —— 双方同步看到「被携带 + 旗手名」（12.2）────────
  {
    await pageA.keyboard.press('KeyG');
    // 拔旗 1.2s；两边都要看到蓝旗（team=1）进入 carried
    const carriedCond = `st.net && st.net.ctf && st.net.ctf.flags.some(f => f.team === 1 && f.state === 'carried' && f.carried)`;
    await waitStatus(pageA, 'A 看到蓝旗被携带', carriedCond, 6000);
    await waitStatus(pageB, 'B 也看到蓝旗被携带', carriedCond, 6000);
    const hudText = await pageA.evaluate(
      () => document.querySelector('#mode-hud')?.textContent ?? '',
    );
    check('7', '★★ G 键拔旗走通：双方 HUD 同步显示旗手（12.2 旗帜信息对双方持续可见）',
      hudText.includes('旗手') && hudText.includes('阿红'),
      `A 的夺旗 HUD「${hudText.trim().replace(/\s+/g, ' ').slice(0, 80)}」`);
  }

  // ── 6：带旗回家交旗 → 得分 → ctfWinner 判胜 → MatchEnd ─────────
  {
    teleport(aNet.you, 0, 123.9); // 红旗房内、红旗 2.1 米处（capture zone）
    await sleep(400);
    await pageA.keyboard.press('KeyG');

    await waitStatus(pageA, 'A 收到 MatchEnd', `st.matchEnds >= 1 && st.page === 'end'`, 8000);
    await waitStatus(pageB, 'B 收到 MatchEnd', `st.matchEnds >= 1 && st.page === 'end'`, 8000);
    const banner = (await pageA.textContent('#lb-end-title'))?.trim() ?? '';
    check('8', '★★ 交旗得分即分出胜负（ctfWinner 第一次接进服务器 checkEnd）',
      banner.includes('红方'),
      `结算横幅「${banner}」`);
  }

  // ── 7：全程旗帜可见（12.2 的逐帧证词）──────────────────────────
  {
    const aWatch = (await pageA.evaluate('globalThis.__flagWatch')) as { frames: number; violations: number };
    const bWatch = (await pageB.evaluate('globalThis.__flagWatch')) as { frames: number; violations: number };
    // ★ 阈值 40：软件渲染下 rAF 约 5fps，一场 15–20 秒的局采 70+ 帧；
    //   40 保证「确实持续采样了整场」，又不对慢机器的帧率下赌注
    check('9', '★★ 对局全程每一帧都有两面旗（数据 + 3D mesh），无一帧缺席',
      aWatch.frames > 40 && aWatch.violations === 0 && bWatch.frames > 40 && bWatch.violations === 0,
      `A ${aWatch.frames} 帧 ${aWatch.violations} 违例 · B ${bWatch.frames} 帧 ${bWatch.violations} 违例`);
  }

  // ── 8：结算面板的夺旗列 ─────────────────────────────────────────
  {
    const summary = await pageA.evaluate(() => {
      const table = document.querySelector('#lb-summary .ms-table');
      const heads = [...(table?.querySelectorAll('th') ?? [])].map((h) => h.textContent ?? '');
      const rowA = [...(table?.querySelectorAll('tbody tr') ?? [])]
        .find((tr) => tr.querySelector('.ms-name')?.textContent === '阿红');
      const cells = [...(rowA?.querySelectorAll('td') ?? [])].map((c) => c.textContent ?? '');
      return { heads, lastThree: cells.slice(-3) };
    });
    check('10', '★ 结算面板出现夺旗/归还/截旗三列，A 的夺旗数=1（16.3 贡献首次到玩家眼前）',
      summary.heads.includes('夺旗') && summary.heads.includes('截旗')
        && summary.lastThree[0] === '1',
      `表头含夺旗列=${summary.heads.includes('夺旗')}，阿红行末三列=${JSON.stringify(summary.lastThree)}`);
  }

  // ── 9：全程不是 URL 老路 ────────────────────────────────────────
  {
    const aSearch = await pageA.evaluate('location.search');
    check('11', '★ 全程 location.search 无 net=（大厅纯 UI 路径）',
      !String(aSearch).includes('net='),
      `A: ${aSearch}`);
  }
} finally {
  await browser.close();
  await server.close();
}

console.log(`\n${'─'.repeat(60)}`);
const failed = results.filter((r) => !r.pass);
console.log(`W12 验收：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('失败项：' + failed.map((f) => f.id).join(', '));
  process.exit(1);
}
