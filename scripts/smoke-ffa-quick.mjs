/**
 * 冒烟：大乱斗「快速开始」直通流程（X10 二轮）—— 点快速开始 → 应直达
 * 选职业页（跳过房间页）→ 点一张职业卡 → 应自动准备并立刻开局（MatchStart）。
 *
 * ⚠️ 与 verify:* 系不同，本脚本**不自建服务器**：要求 dev:server（8080）与
 *    dev:client（5173）已在跑 —— `pnpm smoke:ffa`。参数可传入其它入口 URL。
 */
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:5173/';
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

const status = () => page.evaluate(() => globalThis.__lobby?.status ?? null);

try {
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-action="create-ffa"]', { timeout: 10000 });

  await page.click('[data-action="create-ffa"]');
  // 断言 1：跳过房间页，直达选职业页
  await page.waitForFunction(
    () => globalThis.__lobby?.status.page === 'class', null, { timeout: 10000 },
  );
  const s1 = await status();
  if (s1.page !== 'class') throw new Error(`应直达选职业页，实际 page=${s1.page}`);
  console.log('✓ 快速开始直达选职业页（跳过房间页），mode =', s1.mode);

  // 断言 2：标题按直通口径换了文案
  const title = (await page.textContent('#lb-class-title'))?.trim();
  if (!title?.includes('大乱斗')) throw new Error(`选职业页标题未按直通口径显示：${title}`);
  console.log('✓ 选职业页标题：', title);

  // 断言 3：点一张职业卡 → 自动准备 → 服务器立刻开局
  await page.click('.lb-card[data-class="warrior"]');
  await page.waitForFunction(
    () => globalThis.__lobby?.status.page === 'match', null, { timeout: 15000 },
  );
  const s2 = await status();
  console.log('✓ 选完职业自动开局：page =', s2.page, '· mode =', s2.mode,
    '· matchStarts =', s2.matchStarts);
  if (s2.mode !== 'ffa') throw new Error(`开局模式应为 ffa，实际 ${s2.mode}`);

  if (errors.length > 0) throw new Error(`页面报错：\n${errors.join('\n')}`);
  console.log('SMOKE PASS');
} catch (e) {
  console.error('SMOKE FAIL:', e.message ?? e);
  process.exitCode = 1;
} finally {
  await browser.close();
}
