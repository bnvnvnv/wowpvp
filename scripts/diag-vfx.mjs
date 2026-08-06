/**
 * 表现层人工诊断工具（不属于验收，不计入任何里程碑判据）：用真浏览器验表现层
 *   1. 朝向：镜头在背后应看到背影
 *   2. 弹体：自己放技能、假人法师打你，都要有东西飞
 *   3. 化形术：目标变青蛙 + 奥术到位爆发
 *   4. 断法：也要有弹体（此前它是 91 技能里唯一零表现的）
 *   5. 近战：物理命中的刀光 + 挥砍动作
 *   6. 地面区域：边界环 + 上升粒子
 *
 * 用法：pnpm dev:client 起着，然后 node scripts/diag-vfx.mjs
 * 产物：scripts/.diag/*.png
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO, 'scripts/.diag');
mkdirSync(OUT, { recursive: true });
const BASE = process.env.VERIFY_URL ?? 'http://localhost:5173/';

/** 优先捆绑 chromium；没装好就退回系统 Edge / Chrome（诊断脚本不挑环境） */
const launchAny = async () => {
  try {
    return await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  } catch {
    for (const channel of ['msedge', 'chrome']) {
      try {
        return await chromium.launch({ channel });
      } catch { /* 试下一个 */ }
    }
    throw new Error('没有可用浏览器');
  }
};
const browser = await launchAny();
const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`${BASE}?testbed`, { waitUntil: 'domcontentloaded' }); // P6：试验场迁到 ?testbed
console.log('等待美术加载…');
await page.waitForTimeout(16000);

const shot = async (name) => {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`  📷 ${name}.png`);
};
const vfx = () => page.evaluate(() => globalThis.__scene?.artStatus?.vfx);

/** 高频轮询 vfx 计数器，条件满足即截图；返回峰值 */
const pollUntil = async (name, pred, ms = 4000) => {
  const peak = { bolts: 0, bursts: 0, rings: 0, flashes: 0 };
  const t0 = Date.now();
  let hit = false;
  while (Date.now() - t0 < ms) {
    const v = await vfx();
    if (v) {
      peak.bolts = Math.max(peak.bolts, v.visualBolts);
      peak.bursts = Math.max(peak.bursts, v.activeBursts);
      peak.rings = Math.max(peak.rings, v.groundRings ?? 0);
      peak.flashes = Math.max(peak.flashes, v.activeFlashes ?? 0);
      if (!hit && pred(v)) {
        hit = true;
        await shot(name);
      }
    }
    await page.waitForTimeout(45);
  }
  return { hit, peak };
};
const report = (label, r) => console.log(`${label}${r.hit ? '✓' : '✗'} 峰值=${JSON.stringify(r.peak)}`);

console.log('artStatus:', JSON.stringify(await page.evaluate(() => {
  const s = globalThis.__scene?.artStatus;
  return s && { art: s.art, models: `${s.charactersWithModel}/${s.charactersTotal}`, vfx: s.vfx };
})));

// ── 1. 朝向 ──
await shot('1-facing-behind');

// ── 2. 弹体与命中（从出生点打正前方战士，别先跑开）──
await page.mouse.move(512, 320);
await page.keyboard.press('Tab');
await page.waitForTimeout(400);
await shot('2-target-ring');

await page.keyboard.press('Digit2'); // 火焰冲击（瞬发）
report('火焰冲击：命中爆发', await pollUntil('3-fireblast', (v) => v.activeBursts > 0, 1500));

await page.keyboard.press('Digit1'); // 霜矢（1.4s 读条）
await page.waitForTimeout(700);
await shot('4-frostbolt-windup');
report('霜矢：弹体/爆发', await pollUntil('5-frostbolt-impact', (v) => v.visualBolts > 0 || v.activeBursts > 0, 2500));

// ── 3. 化形术：战士假人应变成青蛙 ──
await page.waitForTimeout(1200); // 等 GCD
await page.keyboard.press('Digit4'); // 化形术（1.5s 读条）
await page.waitForTimeout(2100); // 读条 + 弹体 + 光环到位
const morphed = await page.evaluate(() =>
  [...globalThis.__scene.dummyViews.values()].some((v) => v.morphed));
await shot('6-polymorph-frog');
console.log(`化形术：目标变形=${morphed ? '✓ 青蛙' : '✗ 没变'}`);

// ── 4. 断法：此前零表现，现在要有弹体 ──
await page.waitForTimeout(1200);
await page.keyboard.press('Digit3'); // 断法（瞬发，落空也要有表现）
report('断法：弹体/爆发', await pollUntil('7-counterspell', (v) => v.visualBolts > 0 || v.activeBursts > 0, 1500));

// ── 5. 近战：刀光（合成物理命中直探表现层，不动规则）+ 挥砍 ──
await page.evaluate(() => {
  const s = globalThis.__scene;
  const warrior = s.combat.visibleUnits().find((e) => e.name.includes('战士'));
  s.combat.onCombatEvent?.({
    t: 'damage', sourceId: s.combat.player.id, targetId: warrior.id,
    amount: 220, school: 'physical', absorbed: 0, overkill: 0, immune: false,
  });
});
report('物理命中：刀光', await pollUntil('8-melee-slash', (v) => (v.activeFlashes ?? 0) > 0, 1500));

await page.evaluate(() => {
  for (const v of globalThis.__scene.dummyViews.values()) v.playMeleeSwing();
});
await page.waitForTimeout(200);
await shot('9-melee-swing');

// 免疫白闪
await page.evaluate(() => {
  const s = globalThis.__scene;
  s.combat.onCombatEvent?.({
    t: 'damage', sourceId: s.combat.player.id, targetId: s.combat.player.id,
    amount: 0, school: 'physical', absorbed: 0, overkill: 0, immune: true,
  });
});
report('免疫：白闪', await pollUntil('10-immune-flash', (v) => (v.activeFlashes ?? 0) > 0, 1500));

// ── 6. 地面区域：先后退出拳击范围再读条（否则被战士打断 —— 那是 7.5 在工作）──
await page.keyboard.down('KeyS');
await page.waitForTimeout(1600);
await page.keyboard.up('KeyS');
await page.waitForTimeout(300);
await page.keyboard.press('Digit6'); // 冰霜风暴（0.8s 读条 + 落点）
await page.waitForTimeout(250);
await page.mouse.move(512, 250);
await page.waitForTimeout(250);
await page.mouse.click(512, 250);
await page.waitForTimeout(1100);
report('冰霜风暴：边界环', await pollUntil('11-blizzard-ground', (v) => v.groundRings > 0, 4000));

console.log('运行时错误:', errors.length ? errors.slice(0, 5) : '无');
await browser.close();
