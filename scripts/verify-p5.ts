/**
 * P5 端到端验收：八职业入口 + 人机对局打通 + 难度分档（P1c 判据落地）。
 *
 * 验的是**接线**，不是规则（规则各有单测）：
 *   1. 试验场 `?class=warrior` —— 玩家真的是战士（名字/职业/技能栏）
 *   2. 大厅人机开关与难度按钮 —— 点击 → 服务器 → RoomState 回显（高亮）
 *   3. 单人 + 人机补位 → 真的开局（canStart 的 P5 修复），3v3 补满 6 实体
 *   4. 房间难度「easy」真的流进每个补位席位（白盒 botSeatsOf —— 这条接线
 *      只有黑盒外白盒验；「easy 席位不打断」由 botController 单测钉死）
 *
 * 用法：pnpm dev:client 起着，然后 `pnpm verify:p5`（服务器在本进程起）。
 */

import { chromium, type Browser, type Page } from 'playwright';
import { startServer } from '../packages/server/src/index.ts';

const BASE = process.env.VERIFY_URL?.replace(/\/\?.*$/, '') ?? 'http://localhost:5173';

const results: { id: string; name: string; pass: boolean }[] = [];
const check = (id: string, name: string, pass: boolean, detail: string): void => {
  results.push({ id, name, pass });
  console.log(`  ${pass ? '✓' : '✗'} ${id} ${name}\n      ${detail}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 轮询浏览器里的 __lobby.status 直到条件成立（与 verify-m13 同一套）*/
const waitStatus = async (
  page: Page, what: string, cond: string, timeoutMs = 8000,
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

const server = await startServer(0);
console.log(`\n服务器已启动（本进程，端口 ${server.port}）`);

const browser: Browser = await (async () => {
  try {
    return await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  } catch {
    for (const channel of ['msedge', 'chrome']) {
      try { return await chromium.launch({ channel }); } catch { /* 试下一个 */ }
    }
    throw new Error('没有可用浏览器');
  }
})();

const LOBBY_URL = `${BASE}/?lobby&art=off&server=${encodeURIComponent(`ws://127.0.0.1:${server.port}`)}`;

try {
  // ── §1 试验场 `?class=warrior`（A 部分）────────────────────────
  console.log('\n── §1 试验场 ?class=warrior ──');
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(`${BASE}/?testbed&art=off&class=warrior`);
    await page.waitForFunction(() => !!(globalThis as never as { __scene?: { combat?: unknown } }).__scene?.combat, null, { timeout: 30000 });
    const st = (await page.evaluate(() => {
      const s = (globalThis as never as {
        __scene: { combat: { player: { name: string; classId: string }; skills: { id: string }[] } };
      }).__scene;
      return {
        name: s.combat.player.name,
        classId: s.combat.player.classId,
        firstSkills: s.combat.skills.slice(0, 3).map((k) => k.id as string),
        bar: s.combat.skills.length,
      };
    })) as { name: string; classId: string; firstSkills: string[]; bar: number };
    check('1a', '★ ?class=warrior：玩家职业/名字是战士', st.classId === 'warrior' && st.name.includes('战士'),
      `name=${st.name} classId=${st.classId}`);
    check('1b', '★ 技能栏是战士前 9（数字键能按到战士技能）',
      st.bar === 9 && st.firstSkills.every((id) => id.startsWith('warrior.')),
      `前三格：${st.firstSkills.join(', ')}（共 ${st.bar} 格）`);
    await page.close();
  }

  // ── §2 大厅：人机开关 + 难度 + 单人开局（B 部分）───────────────
  console.log('\n── §2 大厅人机对局 ──');
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.log(`  [页面错误] ${e.message}`));
  await page.goto(LOBBY_URL);

  await page.fill('#lb-name', '独行侠');
  await page.click('[data-action="create"]');
  const room = await waitStatus(page, '进入房间页', `st.page === 'room' && st.roomCode.length > 0`);
  const code = room.roomCode as string;

  // 开人机 + 设难度 easy —— 断言按钮高亮（RoomState 回显闭环）
  await page.click('#lb-fill-on');
  await page.waitForSelector('#lb-fill-on.lb-armed', { timeout: 5000 });
  await page.click('[data-action="bot-diff"][data-diff="easy"]');
  await page.waitForSelector('[data-diff="easy"].lb-armed', { timeout: 5000 });
  check('2a', '★ 人机开关与难度按钮：点击 → 服务器 → RoomState 回显高亮', true,
    `房间 ${code}：补位=开，难度=easy（此前大厅连开关都没有 —— SetFillWithBots 写了没人调）`);

  // 单人：红方 + 战士 + 准备 → 应当直接开局（canStart 的 P5 修复）
  await page.click('[data-team="red"]');
  await page.click('[data-action="open-class"]');
  await page.click('.lb-card[data-class="warrior"]');
  await waitStatus(page, '职业=战士', `st.players.some(p => p.classId === 'warrior')`);
  await page.click('[data-action="ready"]');
  await waitStatus(page, '单人开局', `st.page === 'match'`, 15000);
  check('2b', '★★ 单人 + 人机补位 → 真的开局（此前被人数规则拦死，补位形同虚设）', true,
    '准备即开局，无需第二个真人');

  // 白盒：3v3 满编 6 实体；每个补位席位的难度都是 easy
  await sleep(600); // 留一拍让接管完成
  const m = server.rooms.matchOf(code)!;
  const entities = [...m.world.entities.values()];
  check('2c', '★ 3v3 补满：世界里恰好 6 个实体（1 真人 + 5 人机）',
    entities.length === 6,
    `实体：${entities.map((e) => e.name).join('、')}`);

  const seats = server.rooms.botSeatsOf(code);
  check('2d', '★★ 房间难度「easy」流进了**每个**补位席位（P1c 判据的接线段）',
    seats.length === 5 && seats.every((s) => s.difficulty === 'easy'),
    `席位：${seats.map((s) => `${s.playerId}=${s.difficulty}`).join('、')}`
      + '（「easy 不打断/不用技巧」由 botController 单测钉死）');

  // 对局真的在跑（快照流动）
  const net0 = (await page.evaluate(() => (globalThis as never as { __lobby: { status: { net?: { snapshots?: number } } } }).__lobby.status.net?.snapshots ?? 0)) as number;
  await sleep(1200);
  const net1 = (await page.evaluate(() => (globalThis as never as { __lobby: { status: { net?: { snapshots?: number } } } }).__lobby.status.net?.snapshots ?? 0)) as number;
  check('2e', '★ 人机对局持续出快照（对局活着）', net1 > net0, `快照 ${net0} → ${net1}`);

  await page.close();
} finally {
  await browser.close();
  await server.close();
}

// ── 汇总 ─────────────────────────────────────────────────────────
console.log('\n────────────────────────────────────────────────────────────');
const passed = results.filter((r) => r.pass).length;
console.log(`P5 验收：${passed}/${results.length} 通过`);
if (passed < results.length) {
  console.log(`失败项：${results.filter((r) => !r.pass).map((r) => `#${r.id}`).join(', ')}`);
  process.exit(1);
}
