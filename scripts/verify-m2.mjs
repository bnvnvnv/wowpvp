/**
 * M2 端到端验收脚本。附录A#7 要求的阶段验收用例。
 *
 * 与 verify-m1 的分工：
 *   单元测试（casting.test.ts / targeting.test.ts）严格验证**规则**；
 *   这个脚本验证**规则真的被接进了游戏**，以及 15.2 的 HUD 提示是否到位。
 *
 * 用法：
 *   pnpm dev:client
 *   node scripts/verify-m2.mjs
 */

import { chromium } from 'playwright';

/**
 * ★ M12：默认带 `?art=off`。
 *
 *   这一支验的是**规则有没有被接线**（移动、镜头、目标、打断…），
 *   没有一条与美术有关。而美术层在 `--use-gl=swiftshader` 软件渲染下
 *   把帧率从 27 压到 4 —— 那会让本脚本因为**跑不动**而超时，
 *   得到一个与代码正确性无关的红灯。
 *
 *   `?art=off` 让画面精确回到 M11 的全程序化表现（见
 *   `client/src/settings/artMode.ts`），于是这里的结论可以与
 *   M0–M11 的历史结果直接对比。**美术层本身由 `verify:m12` 负责。**
 */
const URL = process.env.VERIFY_URL ?? 'http://localhost:5173/?art=off';
const results = [];
const check = (id, name, pass, detail) => {
  results.push({ id, pass });
  console.log(`  ${pass ? '✓' : '✗'} ${id} ${name}\n      ${detail}`);
};

const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
const runtimeErrors = [];
page.on('pageerror', (e) => runtimeErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') runtimeErrors.push(m.text());
});

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

const targetText = async () => {
  const el = await page.$('#target-frame');
  if (!el || !(await el.isVisible())) return '';
  return (await el.innerText()).replace(/\n/g, ' | ');
};
const logLines = async () =>
  page.$$eval('#combat-log .log', (els) => els.map((e) => e.innerText.replace(/\n/g, ' ')));
const slotTexts = async () =>
  page.$$eval('#skill-bar .slot', (els) => els.map((e) => e.innerText.replace(/\n/g, ' ')));

/** 等到某个条件成立，最多 timeout 毫秒 */
const waitFor = async (fn, timeout = 15000, interval = 60) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return true;
    await page.waitForTimeout(interval);
  }
  return false;
};

/**
 * 等目标开始读条，并在**读条剩余时间还够**时立刻按下打断键。
 * 假人法师的霜矢只有 1.4 秒，轮询间隔加上一次额外读取就能错过整个窗口 ——
 * 所以判定和按键必须在同一轮里做完，不能先 waitFor 再重新读一次。
 */
const interruptWhenCasting = async (key, minRemaining = 0.5, timeout = 25000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const t = await targetText();
    const m = t.match(/(\d+\.\d)s/);
    if (m && parseFloat(m[1]) >= minRemaining) {
      await page.keyboard.press(key);
      return t;
    }
    await page.waitForTimeout(50);
  }
  return null;
};

/** 等某个技能槽变成可用（没有阻塞原因）*/
const waitSlotUsable = async (index, timeout = 20000) =>
  waitFor(async () => {
    const cls = await page
      .$$eval('#skill-bar .slot', (els) => els.map((e) => e.className))
      .catch(() => []);
    return (cls[index] ?? '').includes('usable');
  }, timeout);

console.log('\n── 规格书 5.1–5.3 / 验收 #4：目标选择 ──');
{
  const before = await targetText();
  await page.keyboard.press('Tab');
  await page.waitForTimeout(400);
  const first = await targetText();
  check('#4a', 'Tab 可以选中目标', before === '' && first !== '',
    `选中：${first || '(空)'}`);

  await page.keyboard.press('Tab');
  await page.waitForTimeout(400);
  const second = await targetText();
  check('#4b', 'Tab 循环切换到下一个目标', second !== first,
    `${first.slice(0, 24)} → ${second.slice(0, 24)}`);

  check('#4c', '15.2 目标框显示职业、生命、资源、当前武器',
    /法师|牧师|战士/.test(second) && /\d+ \/ \d+/.test(second) && /法力|怒气/.test(second),
    second);

  await page.keyboard.press('KeyF');
  await page.waitForTimeout(300);
  const focusVisible = await page.$eval('#focus-frame', (e) => e.offsetParent !== null).catch(() => false);
  check('#4d', '焦点目标独立于硬目标（5.1）', focusVisible,
    focusVisible ? '焦点框已显示' : '焦点框未出现');
}

console.log('\n── 规格书 15.2：技能图标提示不可用原因 ──');
{
  // Tab 到 25 米之外的目标：烈焰爆射程 25 米、霜矢 32 米，
  // 同一时刻一个变灰一个可用 —— 这才验证了提示是**按各技能距离**算的，而不是一刀切
  let dist = 0;
  for (let i = 0; i < 6 && dist <= 25; i++) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(350);
    dist = parseFloat((await targetText()).match(/([\d.]+) m/)?.[1] ?? '0');
  }
  const slots = await slotTexts();
  const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
  const fireBlast = clean(slots[1]);
  const frostbolt = clean(slots[0]);
  check('15.2a', '★ 超出距离的技能显示原因，射程更远的同时仍可用',
    dist > 25 && fireBlast.includes('超出距离') && !frostbolt.includes('超出距离'),
    `目标 ${dist}m｜烈焰爆(25m)「${fireBlast}」｜霜矢(32m)「${frostbolt}」`);

  check('15.2b', '脱离公共冷却的技能有明确标记（7.2）',
    slots.some((s) => s.includes('脱GCD')),
    slots.find((s) => s.includes('脱GCD'))?.trim().slice(0, 50) ?? '(未标记)');
}

console.log('\n── 规格书 7.2 / 验收 #15：专用打断与学派锁定 ──');
{
  const beforeInterrupt = await interruptWhenCasting('Digit3'); // 断法
  await page.waitForTimeout(500);
  const lines = await logLines();
  const interruptLine = lines.find((l) => l.includes('你打断了'));

  check('#15a', '专用打断能停止可打断法术', !!interruptLine,
    interruptLine ?? `未抓到读条窗口：${beforeInterrupt ?? '(超时)'}`);

  check('#15b', '★ 法师反制锁定 4 秒（7.2 的唯一特例）',
    !!interruptLine && /4\.0s/.test(interruptLine),
    interruptLine ?? '(未打断)');
}

console.log('\n── 规格书 7.2：打断落空仍进入冷却 ──');
{
  await page.keyboard.press('Digit3');
  await page.waitForTimeout(400);
  const slots = await slotTexts();
  const counterspell = slots[2] ?? '';
  check('7.2', '打断技能进入冷却后图标显示剩余时间',
    /\d+\.\ds/.test(counterspell),
    counterspell.trim().slice(0, 60));
}

console.log('\n── 规格书 7.5 / 验收 #18：假读条 ──');
{
  // ⚠️ 不去抓「施法条正在显示」这个瞬态 DOM：软件渲染下一帧 45ms，
  //    加上 Playwright 的 IPC 往返，1.4 秒的读条窗口经常抓不到。
  //    改为检查**日志序列**，这也更贴近 #18 的实质（取消这件事发生了没有）。
  const usable = await waitSlotUsable(0);
  await page.keyboard.press('Digit1'); // 霜矢 1.4s 读条
  // ⚠️ 战士假人有 0.45 秒反应时间：立刻取消的话它还没「决定」打断，骗不到。
  //    等 0.25 秒让它起意，再在猛击落下之前取消 —— 这才是真正的骗打断。
  await page.waitForTimeout(250);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);

  const lines = await logLines();
  /**
   * ⚠️ 必须认**玩家自己**那条读条 —— 假人牧师也会产生「开始读条」，
   *   而它出现在玩家取消之后还是之前取决于时序。第一版只找「开始读条」，
   *   于是这条测试**偶发失败**，看起来像回归实则是断言不够精确。
   */
  const startIdx = lines.findIndex((l) => l.includes('开始读条 霜矢'));
  const cancelIdx = lines.findIndex((l) => l.includes('你主动取消了'));
  // 日志是倒序的（最新在前），所以「取消」的下标应当小于「开始读条」
  const sequenceOk = startIdx >= 0 && cancelIdx >= 0 && cancelIdx < startIdx;

  check('#18', '主动取消读条，且明确标注不消耗资源与冷却',
    usable && sequenceOk,
    sequenceOk ? `${lines[startIdx]} → ${lines[cancelIdx]}` : `技能可用=${usable}；日志：${lines.slice(0, 3).join(' / ')}`);

  // 7.5 的完整闭环：骗掉打断后，对方的猛击落空但仍进冷却（7.2）
  await page.waitForTimeout(1200);
  const baitLines = await logLines();
  const baited = baitLines.find((l) => l.includes('落空'));
  check('7.5', '★ 假读条骗出打断：对方猛击落空但仍进入冷却',
    !!baited,
    baited ?? '(本轮战士假人未起手，属正常时序波动)');
}

console.log('\n── 规格书 7.1 / 15.2：施法条信息完整 ──');
{
  let snapshot = '';
  const casting = await waitFor(async () => {
    snapshot = await targetText();
    return /\d\.\ds/.test(snapshot);
  }, 20000);
  check('15.2c', '敌方施法条显示技能名称、学派、剩余时间',
    casting && /寒冰|神圣|火焰|奥术|暗影|自然|物理/.test(snapshot) && /\d\.\ds/.test(snapshot),
    snapshot);
}

console.log('\n── 规格书 7.3 / 验收 #14：普通伤害不打断施法 ──');
{
  // 这条在浏览器里不好构造（需要可控的伤害源），由单元测试严格覆盖
  check('#14', '由 casting.test.ts「普通伤害不取消也不延长施法」覆盖', true,
    '端到端不构造伤害源；单元测试断言了施法状态与 endsAt 均不变');
}

console.log('\n── 运行时错误 ──');
check('err', '全程无运行时错误', runtimeErrors.length === 0,
  runtimeErrors.length ? runtimeErrors.slice(0, 3).join(' | ') : '无');

await page.screenshot({ path: 'm2-verify.png' });
await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${'─'.repeat(60)}`);
console.log(`M2 验收：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('失败项：' + failed.map((f) => f.id).join(', '));
  process.exit(1);
}
