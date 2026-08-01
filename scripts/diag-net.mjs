/**
 * 联网表现层人工诊断工具（不属于验收）：起真服务器 + 两个真浏览器客户端，
 * 验证 14.2 特效在**联网对局**里两边都看得见：
 *   1. 法师读条霜矢 → 双方都看到弹体在飞、命中爆发
 *   2. 化形术 → 战士在两边的屏幕上都变成小鸡
 *   3. 战士近战 → 挥砍 + 刀光
 *
 * 前置：pnpm dev:client 起着（5173）。服务器由本脚本自己起（8080）。
 * 产物：scripts/.diag/net-*.png
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO, 'scripts/.diag');
mkdirSync(OUT, { recursive: true });
const BASE = process.env.VERIFY_URL ?? 'http://localhost:5173/';

// ── 起服务器（8080 已被占用就复用现成的）──
const portInUse = await new Promise((resolve) => {
  import('node:net').then(({ connect }) => {
    const sock = connect({ port: 8080, host: '127.0.0.1' }, () => { sock.end(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.setTimeout(1000, () => { sock.destroy(); resolve(false); });
  });
});
let server;
if (portInUse) {
  console.log('8080 已有服务器在听，复用它');
} else {
  console.log('起服务器…');
  server = spawn('pnpm', ['dev:server'], { cwd: REPO, shell: true, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 5000));
}
/**
 * ★ Windows 下 `child.kill()` 只杀 shell，不杀 pnpm→tsx→node 的整棵进程树 ——
 *   上一版就是这样把服务器留在 8080 上，第二次跑时进程越积越多直到被 OOM 杀。
 *   `taskkill /T` 按树杀。
 */
const stopServer = () => {
  if (!server) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(server.pid), '/T', '/F']);
    else server.kill();
  } catch { /* 已退出 */ }
};
process.on('exit', stopServer);

const launchAny = async () => {
  try {
    return await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  } catch {
    for (const channel of ['msedge', 'chrome']) {
      try { return await chromium.launch({ channel }); } catch { /* 下一个 */ }
    }
    throw new Error('没有可用浏览器');
  }
};
const browser = await launchAny();

const errors = [];
const openClient = async (query) => {
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${BASE}?net=diag&${query}`, { waitUntil: 'domcontentloaded' });
  return page;
};

console.log('开两个客户端（法师红 / 战士蓝）…');
const mage = await openClient('name=法师红&team=red&class=mage');
const warrior = await openClient('name=战士蓝&team=blue&class=warrior');

// 等 MatchStart + 美术加载
const started = async (page) => page.evaluate(() => globalThis.__net?.status?.started === true);
for (let i = 0; i < 60; i++) {
  if ((await started(mage)) && (await started(warrior))) break;
  await mage.waitForTimeout(500);
}
if (!(await started(mage))) {
  console.error('✗ 比赛没有开始（服务器没起来或匹配流程变了）');
  stopServer();
  process.exit(1);
}
console.log('✓ 对局已开始，等模型/贴图加载…');
await mage.waitForTimeout(9000);

const vfxOf = (page) => page.evaluate(() => globalThis.__net?.status?.vfx);
const shot = async (page, name) => {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`  📷 ${name}.png`);
};

/** 同时轮询两个页面的 vfx 计数器 */
const pollBoth = async (name, pred, ms = 5000) => {
  const peak = { A: { bolts: 0, bursts: 0 }, B: { bolts: 0, bursts: 0 } };
  const t0 = Date.now();
  let hitA = false, hitB = false;
  while (Date.now() - t0 < ms) {
    const [a, b] = await Promise.all([vfxOf(mage), vfxOf(warrior)]);
    if (a) {
      peak.A.bolts = Math.max(peak.A.bolts, a.visualBolts);
      peak.A.bursts = Math.max(peak.A.bursts, a.activeBursts);
      if (!hitA && pred(a)) { hitA = true; await shot(mage, `${name}-A法师视角`); }
    }
    if (b) {
      peak.B.bolts = Math.max(peak.B.bolts, b.visualBolts);
      peak.B.bursts = Math.max(peak.B.bursts, b.activeBursts);
      if (!hitB && pred(b)) { hitB = true; await shot(warrior, `${name}-B战士视角`); }
    }
    await mage.waitForTimeout(50);
  }
  return { hitA, hitB, peak };
};

/** 两人之间的距离（从法师端读快照算）*/
const distance = () => mage.evaluate(() => {
  const net = globalThis.__net;
  const me = net.status.position;
  const other = net.lastEntities.find((e) => e.id !== net.status.you);
  return other ? Math.hypot(other.position.x - me.x, other.position.z - me.z) : Infinity;
});

/**
 * 把角色朝向转向对方（dirToYaw 同一约定：yaw = atan2(-dx, -dz)）。
 * ★ NetworkScene 的 characterYaw 初始恒为 0，与出生朝向无关 ——
 *   不转向的话两人都朝世界 -Z 走，可能背道而驰。
 */
const steerToward = (page) => page.evaluate(() => {
  const net = globalThis.__net;
  const me = net.status.position;
  const other = net.lastEntities.find((e) => e.id !== net.status.you);
  if (!other) return;
  const yaw = Math.atan2(-(other.position.x - me.x), -(other.position.z - me.z));
  net.characterYaw = yaw;
  // ★ 镜头也一起转：Tab 选目标用的是**镜头**前方 140°（5.3），
  //   脚本没有真实鼠标拖动，镜头 yaw 恒 0 会让背后的目标 Tab 不到
  net.cam.yaw = yaw;
});

/** 朝固定路点转向 */
const steerPoint = (page, x, z) => page.evaluate(([px, pz]) => {
  const net = globalThis.__net;
  const me = net.status.position;
  net.characterYaw = Math.atan2(-(px - me.x), -(pz - me.z));
}, [x, z]);
const distToPoint = (page, x, z) => page.evaluate(([px, pz]) => {
  const me = globalThis.__net.status.position;
  return Math.hypot(px - me.x, pz - me.z);
}, [x, z]);

/**
 * ── 0. 会师 ──
 * 竞技场出生点相距 ~116 米（3v3 图），中场有一堵 x∈[-14,14] 的矮墙（arena.ts）——
 * 直线互冲会停在墙两侧「缺少视线」。所以两段式：
 *   ① 各自走到墙东侧的汇合点 (20, 0)（绕开中场墙）
 *   ② 再互相走近到施法距离
 */
console.log(`出生距离 ${(await distance()).toFixed(0)} 米，绕中场墙会师…`);
await mage.keyboard.down('KeyW');
await warrior.keyboard.down('KeyW');
const arrived = { A: false, B: false };
for (let i = 0; i < 90 && !(arrived.A && arrived.B); i++) {
  if (!arrived.A) {
    await steerPoint(mage, 20, 0);
    if ((await distToPoint(mage, 20, 0)) < 5) { arrived.A = true; await mage.keyboard.up('KeyW'); }
  }
  if (!arrived.B) {
    await steerPoint(warrior, 20, 0);
    if ((await distToPoint(warrior, 20, 0)) < 5) { arrived.B = true; await warrior.keyboard.up('KeyW'); }
  }
  await mage.waitForTimeout(300);
}
if (!arrived.A) await mage.keyboard.up('KeyW');
if (!arrived.B) await warrior.keyboard.up('KeyW');
// ② 收尾：法师朝战士再蹭近一点，保证 <20 米
await mage.keyboard.down('KeyW');
for (let i = 0; i < 20; i++) {
  await steerToward(mage);
  await mage.waitForTimeout(250);
  if ((await distance()) < 15) break;
}
await mage.keyboard.up('KeyW');
console.log(`✓ 已接近到 ${(await distance()).toFixed(1)} 米`);
await mage.waitForTimeout(500);

// ── 1. 霜矢：双方都要看到弹体/爆发 ──
await mage.bringToFront();
await mage.keyboard.press('Tab');
await mage.waitForTimeout(400);
await mage.keyboard.press('Digit1'); // 霜矢 1.4s 读条
const r1 = await pollBoth('net-1-frostbolt', (v) => v.visualBolts > 0 || v.activeBursts > 2, 4500);
console.log(`霜矢：法师端${r1.hitA ? '✓' : '✗'} 战士端${r1.hitB ? '✓' : '✗'} 峰值=${JSON.stringify(r1.peak)}`);

// ── 2. 化形术：战士在两边都该变小鸡 ──
await mage.waitForTimeout(1600);
const morphSlot = await mage.evaluate(() => {
  const i = globalThis.__net.view.skills.findIndex((s) => s.id === 'mage.polymorph');
  return i >= 0 && i < 8 ? i : -1;
});
if (morphSlot >= 0) {
  await mage.keyboard.press(`Digit${morphSlot + 1}`);
  await mage.waitForTimeout(2300); // 读条 1.5s + 弹体 + 光环
  const chickenOnA = await mage.evaluate(() =>
    [...globalThis.__net.views.values()].some((v) => v.morphed));
  const chickenOnB = await warrior.evaluate(() => globalThis.__net.selfView.morphed);
  await shot(mage, 'net-2-chicken-A法师视角');
  await shot(warrior, 'net-2-chicken-B战士视角');
  console.log(`化形术：法师看到战士变形=${chickenOnA ? '✓' : '✗'} 战士看到自己变形=${chickenOnB ? '✓' : '✗'}`);
} else {
  console.log('化形术不在前 8 格，跳过（技能栏顺序变了）');
}

// ── 3. 战士近战：走到法师脸上打一下（挥砍 + 刀光）──
await warrior.bringToFront();
// ★ 等化形术的 4 秒「迷惑」结束 —— 被变形期间无法行动，出手会被服务器拒绝
await warrior.waitForTimeout(4500);
await warrior.keyboard.press('Tab');
await warrior.waitForTimeout(300);
// 贴脸：近战射程 3 米（每步都转向法师，防走偏）
await warrior.keyboard.down('KeyW');
for (let i = 0; i < 40; i++) {
  await steerToward(warrior);
  await warrior.waitForTimeout(250);
  if ((await distance()) < 2.6) break;
}
await warrior.keyboard.up('KeyW');
await warrior.waitForTimeout(400);
await steerToward(warrior);
await warrior.keyboard.press('Tab');
await warrior.waitForTimeout(300);
const meleeSlot = await warrior.evaluate(() => {
  const skills = globalThis.__net.view.skills;
  // ★ 优先零消耗的近战（拳击）：战士开局 0 怒气，斩杀类会「资源不足」
  const free = skills.findIndex(
    (s) => s.targeting === 'direct' && s.range.max < 8 && (!s.cost || s.cost.amount === 0));
  if (free >= 0 && free < 8) return free;
  const any = skills.findIndex((s) => s.targeting === 'direct' && s.range.max < 8);
  return any >= 0 && any < 8 ? any : -1;
});
if (meleeSlot >= 0) {
  const skillName = await warrior.evaluate((i) => globalThis.__net.view.skills[i]?.name, meleeSlot);
  console.log(`近战技能：槽 ${meleeSlot + 1}「${skillName}」，距离 ${(await distance()).toFixed(1)} 米`);
  await warrior.keyboard.press(`Digit${meleeSlot + 1}`);
  const r3 = await pollBoth('net-3-melee', (v) => (v.activeFlashes ?? 0) > 0 || v.activeBursts > 0, 3000);
  console.log(`近战：战士端${r3.hitB ? '✓' : '✗'} 法师端${r3.hitA ? '✓' : '✗'} 峰值=${JSON.stringify(r3.peak)}`);
  await shot(warrior, 'net-3-melee-B战士视角');
  // 真实失败原因在战斗日志里 —— 直接抓出来
  const log = await warrior.evaluate(
    () => document.querySelector('#combat-log')?.textContent?.slice(0, 300) ?? '(无日志)');
  console.log(`战士端日志：${log}`);
} else {
  console.log('前 8 格没有近战技能，跳过');
}

console.log('运行时错误:', errors.length ? [...new Set(errors)].slice(0, 5) : '无');
await browser.close();
stopServer();
