/**
 * P2 压测台的**自检**（不是性能判据）。
 *
 * ★★ 分工要说清楚：软件渲染（swiftshader，空闲就 4 FPS）**测不出性能** ——
 *   真机帧率必须人在真显卡上跑一轮，那是 X10/F6 的事，脚本代替不了。
 *   本脚本只回答一个问题：**这台压测台本身是好的吗** ——
 *   24 个实体真的生成了、面板真的在出读数、默认路径没被带坏。
 *   人拿到一台「已知可用」的台子，才谈得上信任他量出来的数。
 *
 * 用法：pnpm --filter @wowpvp/client dev（另一个终端）
 *       pnpm verify:stress
 */

import { chromium } from 'playwright';

const BASE = process.env.VERIFY_URL ?? 'http://localhost:5173';
const results = [];
const check = (id, name, pass, detail) => {
  results.push({ id, pass });
  console.log(`  ${pass ? '✓' : '✗'} ${id} ${name}\n      ${detail}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await (async () => {
  try {
    return await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  } catch {
    for (const channel of ['msedge', 'chrome']) {
      try { return await chromium.launch({ channel }); } catch { /* 试下一个 */ }
    }
    throw new Error('没有可用浏览器');
  }
})();

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // ── 1：压测台起得来，24 个实体同屏 ──────────────────────────
  await page.goto(`${BASE}/?stress&art=off`);
  await sleep(3500); // 软渲染下 4 FPS，多等几帧让面板攒够采样

  const stress = await page.evaluate(`(() => {
    const el = document.getElementById('stats');
    return { text: el ? el.textContent : '', has: !!globalThis.__scene };
  })()`);

  check('1', '★★ ?stress 起得来，面板报出实体数（默认 23 假人 + 玩家 = 24）',
    stress.has && stress.text.includes('24 实体同屏'),
    `面板文本片段「${stress.text.replace(/\s+/g, ' ').trim().slice(0, 60)}」`);

  check('2', '★★ 面板出的是**帧时间分布**（p95 才看得出卡顿，瞬时 FPS 看不出）',
    stress.text.includes('p95 帧时间') && stress.text.includes('最差帧')
      && stress.text.includes('绘制调用'),
    `含 p95=${stress.text.includes('p95 帧时间')} 最差帧=${stress.text.includes('最差帧')} ` +
    `绘制调用=${stress.text.includes('绘制调用')}`);

  // 读数必须是真的在动，不是写死的 0
  const metrics = await page.evaluate(`(() => {
    const t = document.getElementById('stats').textContent;
    const num = (label) => {
      const m = t.match(new RegExp(label + '\\\\s*([0-9.]+)'));
      return m ? Number(m[1]) : -1;
    };
    return { avg: num('平均帧时间'), calls: num('绘制调用') };
  })()`);
  check('3', '★ 读数是真的（帧时间 >0、绘制调用 >0），不是写死的占位',
    metrics.avg > 0 && metrics.calls > 0,
    `平均帧时间 ${metrics.avg}ms · 绘制调用 ${metrics.calls}`);

  // ── 2：人数可调（跑出瓶颈后二分定位用）────────────────────────
  await page.goto(`${BASE}/?stress=7&art=off`);
  await sleep(2500);
  const small = await page.evaluate(`document.getElementById('stats').textContent`);
  check('4', '★ ?stress=<n> 可调人数（二分定位「多少人开始掉帧」用）',
    small.includes('8 实体同屏'),
    `?stress=7 → ${small.replace(/\s+/g, ' ').trim().slice(0, 30)}`);

  // ── 3：红线 —— 验收载体路径一个字节没动 ─────────────────────
  // ★ P6 起无参默认页是主菜单（没有 #stats），141 项验收的载体搬到了
  //   `?testbed` 前缀（m1–m4 同轮已改）。本脚本写于 P2，这里是漏改的一处 ——
  //   X10 真机轮补上。检查的**意图**不变：压测台没把验收载体带坏。
  await page.goto(`${BASE}/?testbed&art=off`);
  await sleep(2500);
  const testbed = await page.evaluate(`(() => {
    const t = document.getElementById('stats').textContent;
    return {
      text: t,
      dummies: globalThis.__scene ? globalThis.__scene.debugEntityCount : undefined,
    };
  })()`);
  check('5', '★★ 默认路径不受影响：仍是老的调试面板（位置/速度/着地），不是压测面板',
    testbed.text.includes('着地') && !testbed.text.includes('p95 帧时间'),
    `含「着地」=${testbed.text.includes('着地')}，含 p95=${testbed.text.includes('p95 帧时间')}`);

  check('6', '★ 全程无运行时错误',
    errors.length === 0,
    errors.length === 0 ? '无' : errors.slice(0, 2).join(' | '));
} finally {
  await browser.close();
}

console.log(`\n${'─'.repeat(60)}`);
const failed = results.filter((r) => !r.pass);
console.log(`压测台自检：${results.length - failed.length}/${results.length} 通过`);
console.log('⚠️ 这是**台子的自检**，不是性能判据 —— 真机帧率见 docs/17 的 P2 说明');
if (failed.length) {
  console.log('失败项：' + failed.map((f) => f.id).join(', '));
  process.exit(1);
}
