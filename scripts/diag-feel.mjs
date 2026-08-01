/**
 * 打击感人工诊断工具（不属于验收，不计入任何里程碑判据）：
 *   1. 连打 60 次直到看见暴击 —— critsSeen > 0（10% 几率，60 次漏掉的概率 ≈ 0.18%）
 *   2. 大额伤害合成事件 → traumaPeak > 0（震动被触发过）
 *   3. 暴击 + 重击 → hitStopFrozen 曾为 true（顿帧真的冻过）
 *   4. 贴墙打自己 → 逐帧断言镜头 z 不越过墙面（震动不穿墙的运行时抽查）
 *
 * 用法：pnpm dev:client 起着，然后 node scripts/diag-feel.mjs
 * 产物：scripts/.diag/feel-*.png
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO, 'scripts/.diag');
mkdirSync(OUT, { recursive: true });
const BASE = process.env.VERIFY_URL ?? 'http://localhost:5173/';

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

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
console.log('等待美术加载…');
await page.waitForTimeout(12000);

const shot = async (name) => {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`  📷 ${name}.png`);
};
const feel = () => page.evaluate(() => globalThis.__scene?.artStatus?.feel);

// ── 1. 真实暴击：锁定战士连打火焰冲击直到 critsSeen > 0 ──
await page.mouse.move(512, 320);
await page.keyboard.press('Tab');
await page.waitForTimeout(400);

let crits = 0;
for (let i = 0; i < 60 && crits === 0; i++) {
  await page.keyboard.press('Digit2'); // 火焰冲击（瞬发）
  await page.waitForTimeout(1600); // GCD + 冷却窗口
  crits = (await feel())?.critsSeen ?? 0;
  if (crits > 0) await shot('feel-1-crit-burst');
}
console.log(`暴击出现：${crits > 0 ? `✓（第 ${crits} 次）` : '✗ 60 发零暴击（p≈0.18%，先怀疑接线）'}`);

// ── 2. 重击（合成大额伤害直探表现层，与 diag-vfx 的近战同一手法）──
await page.evaluate(() => {
  const s = globalThis.__scene;
  const warrior = s.combat.visibleUnits().find((e) => e.name.includes('战士'));
  s.combat.onCombatEvent?.({
    t: 'damage', sourceId: warrior.id, targetId: s.combat.player.id,
    amount: 400, school: 'physical', absorbed: 0, overkill: 0, immune: false,
  });
});
await page.waitForTimeout(80);
const afterHeavy = await feel();
await shot('feel-2-heavy-hit');
console.log(`重击震动：traumaPeak=${afterHeavy?.traumaPeak.toFixed(2)} ${afterHeavy?.traumaPeak > 0 ? '✓' : '✗'}`);

// ── 3. 顿帧：自己挨暴击（合成 crit 事件），下一帧应处于冻结 ──
const frozeSeen = await page.evaluate(async () => {
  const s = globalThis.__scene;
  const warrior = s.combat.visibleUnits().find((e) => e.name.includes('战士'));
  s.combat.onCombatEvent?.({
    t: 'damage', sourceId: warrior.id, targetId: s.combat.player.id,
    amount: 300, school: 'physical', absorbed: 0, overkill: 0, immune: false, crit: true,
  });
  // 顿帧只有 90ms —— 在页面里高频采样，别指望 CDP 往返能抓到
  for (let i = 0; i < 40; i++) {
    if (s.artStatus.feel.hitStopFrozen) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
});
console.log(`顿帧冻结：${frozeSeen ? '✓' : '✗'}`);

// ── 4. 震动不穿墙：把镜头顶到东墙外侧要求的位置，满创伤连续采样 ──
const wallOk = await page.evaluate(async () => {
  const s = globalThis.__scene;
  // 试验场 GROUND_SIZE=70 → 东墙中心 x=35，内侧面 x=34.5（testbed.ts:37）。
  // 角色贴墙站（x=33），镜头朝西 → 机位伸向 +x，被墙拦下。
  s.move.position.x = 33;
  s.move.position.z = 0;
  s.cam.yaw = Math.PI / 2; // 镜头看向 -x，机位在 +x（墙那边）
  // 先让镜头碰撞收敛，再开始满创伤采样
  for (let i = 0; i < 60; i++) await new Promise((r) => requestAnimationFrame(r));
  let maxX = -Infinity;
  for (let i = 0; i < 90; i++) {
    s.cam.addTrauma(1);
    await new Promise((r) => requestAnimationFrame(r));
    maxX = Math.max(maxX, s.cam.camera.position.x);
  }
  // 墙内侧面在 34.5 —— 镜头任何一帧都不该越过它
  return { ok: maxX < 34.5, maxX };
});
await shot('feel-3-shake-vs-wall');
console.log(`震动不穿墙：maxX=${wallOk.maxX.toFixed(2)}（墙内侧 34.5）${wallOk.ok ? '✓' : '✗'}`);

console.log(errors.length ? `⚠️ 运行时错误 ${errors.length} 条：\n${errors.join('\n')}` : '运行时错误：无 ✓');
await browser.close();
process.exit(errors.length > 0 || !wallOk.ok ? 1 : 0);
