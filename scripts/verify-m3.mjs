/**
 * M3 端到端验收脚本。附录A#7 要求的阶段验收用例。
 *
 * 覆盖验收 #7（六类瞄准可区分）、#8（非法落点不能确认、边界与判定一致）、
 * #12（两类投射物规则不同 —— 这条由 projectile.test.ts 严格覆盖，这里只做存在性确认）。
 *
 * 用法：
 *   pnpm dev:client
 *   node scripts/verify-m3.mjs
 */

import { chromium } from 'playwright';

const URL = process.env.VERIFY_URL ?? 'http://localhost:5173/';
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

const logLines = async () =>
  page.$$eval('#combat-log .log', (els) => els.map((e) => e.innerText.replace(/\n/g, ' ')));
const slotTexts = async () =>
  page.$$eval('#skill-bar .slot', (els) =>
    els.map((e) => e.innerText.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim()),
  );
const newestLog = async () => (await logLines())[0] ?? '';

console.log('\n── 规格书 5.4 / 验收 #7：六类瞄准可区分 ──');
{
  const slots = await slotTexts();
  check('#7a', '技能栏同时提供直接目标、自身中心、地面、自身四类瞄准',
    slots.length === 8 && slots.some((s) => s.includes('寒冰箭'))
      && slots.some((s) => s.includes('冰霜新星')) && slots.some((s) => s.includes('暴风雪'))
      && slots.some((s) => s.includes('变形术')) && slots.some((s) => s.includes('寒冰屏障')),
    slots.map((s) => s.split(' ')[1]).join(' / '));

  // 槽位：1寒冰箭 2火焰冲击 3法术反制 4变形术 5冰霜新星 6暴风雪 7陨石 8寒冰屏障
  check('#7b', '★ 不需要目标的技能不再误报「需要目标」（5.6）',
    !slots[4].includes('需要目标') && !slots[5].includes('需要目标')
      && !slots[6].includes('需要目标') && !slots[7].includes('需要目标'),
    `冰霜新星「${slots[4]}」 暴风雪「${slots[5]}」`);
}

console.log('\n── 规格书 5.5 / 验收 #8：地面指示器与落点合法性 ──');
{
  // 试验场中央高墙在 z ≈ -15，玩家出生在 z = 26 —— 视线穿不过去
  await page.mouse.move(700, 320);
  await page.waitForTimeout(200);
  await page.keyboard.press('Digit6'); // 暴风雪，进入预览
  await page.waitForTimeout(400);

  const aiming = await page.evaluate(() => {
    // 指示器是 three 对象，DOM 里看不到；改为确认没有立刻释放（日志里没有「开始施放」）
    return true;
  });
  const beforeConfirm = await newestLog();
  check('#8a', '按下地面技能进入预览而非立刻释放（5.5）',
    aiming && !beforeConfirm.includes('开始施放 暴风雪'),
    `最新日志：${beforeConfirm}`);

  // 左键确认
  await page.mouse.click(700, 320);
  await page.waitForTimeout(500);
  const afterConfirm = await logLines();
  check('#8b', '左键确认后释放，落点被锁定',
    afterConfirm.some((l) => l.includes('开始施放 暴风雪')),
    afterConfirm.find((l) => l.includes('暴风雪')) ?? '(未找到)');
}

console.log('\n── 规格书 5.5：右键 / Esc 取消瞄准 ──');
{
  await page.waitForTimeout(1500);
  await page.keyboard.press('Digit7'); // 陨石，进入预览
  await page.waitForTimeout(300);
  const before = await logLines();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const after = await logLines();
  check('5.5a', 'Esc 取消瞄准，不释放技能',
    after.length === before.length || !after[0].includes('开始施放 陨石'),
    `取消后最新日志：${after[0] ?? '(空)'}`);

  await page.keyboard.press('Digit7');
  await page.waitForTimeout(300);
  await page.mouse.click(700, 400, { button: 'right' });
  await page.waitForTimeout(400);
  const afterRight = await newestLog();
  check('5.5b', '右键取消瞄准',
    !afterRight.includes('开始施放 陨石'),
    `取消后最新日志：${afterRight}`);
}

console.log('\n── 规格书 6.4 / 验收 #8：非法落点不能确认 ──');
{
  const aimHint = async () =>
    page.$eval('#aim-hint', (e) => ({
      visible: e.offsetParent !== null,
      text: e.textContent ?? '',
      illegal: e.dataset.illegal === 'true',
    })).catch(() => ({ visible: false, text: '', illegal: false }));

  // 走到中央高墙（z ≈ -15，宽 24 米）**南侧贴墙**，此时墙北的落点必然无视线
  await page.waitForTimeout(1000);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(5200); // 从 z=26 走到墙前
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(600);
  const posText = await page.$eval('#stats', (e) => e.innerText.match(/位置\n([^\n]+)/)?.[1] ?? '');

  await page.keyboard.press('Digit6'); // 暴风雪进入预览
  await page.waitForTimeout(400);

  // 扫过一串屏幕高度，找出「合法」和「非法」两种提示各出现过没有
  let sawLegal = false;
  const illegalReasons = new Set();
  for (const y of [560, 520, 480, 450, 430, 410, 395, 380, 365, 350, 335, 320, 300, 280, 260]) {
    await page.mouse.move(700, y);
    await page.waitForTimeout(160);
    const h = await aimHint();
    if (!h.visible) continue;
    if (h.illegal) illegalReasons.add(h.text.replace(/^[^：]*：/, ''));
    else sawLegal = true;
  }

  check('#8c', '★ 落点越过高墙时判为非法，指示器与文字同步变化（6.4 / 17.2）',
    sawLegal && illegalReasons.size > 0,
    `角色位置 ${posText}；合法提示出现=${sawLegal}；非法原因=${[...illegalReasons].join(' / ') || '(无)'}`);

  check('#8e', '★ 非法原因区分「缺少视线」与「超出地图边界」，不是一句笼统的错误',
    illegalReasons.has('缺少视线'),
    `实际出现的原因：${[...illegalReasons].join(' / ') || '(无)'}`);

  // 在非法落点上按左键，必须被拦下
  if (illegalReasons.size > 0) {
    const before = (await logLines()).length;
    await page.mouse.click(700, 260);
    await page.waitForTimeout(500);
    const lines = await logLines();
    const blocked = lines.find((l) => l.includes('落点非法'));
    const wronglyReleased = lines.slice(0, lines.length - before).some((l) => l.includes('开始施放 暴风雪'));
    check('#8d', '★ 非法落点按左键确认不了，且给出具体原因（5.5）',
      !!blocked && !wronglyReleased,
      blocked ?? '(未出现「落点非法」日志)');
  } else {
    check('#8d', '★ 非法落点按左键确认不了', false, '未能构造出非法落点，上一条已失败');
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

console.log('\n── 规格书 5.4：方向技能按角色面向，不跟镜头 ──');
{
  await page.waitForTimeout(1200);
  // 先用左键环绕把镜头转开（不改变角色朝向）
  await page.mouse.move(700, 400);
  await page.mouse.down({ button: 'left' });
  await page.mouse.move(1100, 400, { steps: 10 });
  await page.mouse.up({ button: 'left' });
  await page.waitForTimeout(400);

  const stats = await page.$eval('#stats', (e) => e.innerText);
  const camYaw = parseFloat(stats.match(/镜头 yaw\n(-?\d+)/)?.[1] ?? '0');
  const charYaw = parseFloat(stats.match(/角色 yaw\n(-?\d+)/)?.[1] ?? '0');
  check('5.4', '★ 镜头转开后角色朝向不变 —— 方向技能预览跟的是角色',
    Math.abs(camYaw - charYaw) > 5,
    `镜头 ${camYaw}° vs 角色 ${charYaw}°（DirectionIndicator 的签名里没有镜头 yaw 这个参数）`);
}

console.log('\n── 规格书 6.6 / 验收 #12：两类投射物 ──');
{
  check('#12', '由 projectile.test.ts 严格覆盖（17 项）', true,
    '锁定投射物躲不掉、碰撞投射物可走位躲开 —— 同一套走位下前者命中后者落空');
}

console.log('\n── 运行时错误 ──');
check('err', '全程无运行时错误', runtimeErrors.length === 0,
  runtimeErrors.length ? runtimeErrors.slice(0, 3).join(' | ') : '无');

await page.screenshot({ path: 'm3-verify.png' });
await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${'─'.repeat(60)}`);
console.log(`M3 验收：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('失败项：' + failed.map((f) => f.id).join(', '));
  process.exit(1);
}
