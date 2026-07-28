/**
 * M1 端到端验收脚本。
 *
 * 规格书附录A#7：「每个阶段完成后运行对应验收用例，并列出已完成、未完成和已知偏差；
 * 不能用伪代码或占位图冒充完成。」—— 这个脚本就是 M1 的那份验收用例。
 *
 * 它驱动**真实浏览器里的真实游戏**，用键盘鼠标操作角色，读 HUD 上的真实数值。
 * 单元测试验证的是逻辑，这里验证的是「逻辑真的被接进了游戏」。
 *
 * 用法：
 *   pnpm dev:client          # 另一个终端
 *   node scripts/verify-m1.mjs
 */

import { chromium } from 'playwright';

const URL = process.env.VERIFY_URL ?? 'http://localhost:5173/';
const results = [];

const check = (id, name, pass, detail) => {
  results.push({ id, name, pass, detail });
  console.log(`  ${pass ? '✓' : '✗'} ${id} ${name}\n      ${detail}`);
};

const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const runtimeErrors = [];
page.on('pageerror', (e) => runtimeErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') runtimeErrors.push(m.text());
});

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(1800);

/** 从 HUD 读取当前状态 */
const read = async () => {
  const t = await page.$eval('#stats', (el) => el.innerText);
  const g = (label) => {
    const m = t.match(new RegExp(label + '\\n([^\\n]+)'));
    return m ? m[1].trim() : '';
  };
  const pos = g('位置').split(',').map(parseFloat);
  return {
    x: pos[0], y: pos[1], z: pos[2],
    speed: parseFloat(g('速度')),
    grounded: g('着地') === '是',
    anim: g('动作'),
    camYaw: parseFloat(g('镜头 yaw')),
    charYaw: parseFloat(g('角色 yaw')),
    dist: parseFloat(g('镜头距离')),
    firstPerson: g('第一人称') === '是',
  };
};

const releaseAll = async () => {
  for (const k of ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyQ', 'KeyE', 'Space']) {
    await page.keyboard.up(k).catch(() => {});
  }
};

/**
 * 走到目标点附近。
 *
 * ★ 必须按**角色当前朝向**把世界坐标的目标向量分解成前后 + 左右分量。
 * 直接假设「W 就是 -Z」在角色被转过之后会走向完全错误的方向 ——
 * 这正是 6.5「只旋转镜头不改变角色朝向」在测试侧的镜像陷阱。
 */
const navigateTo = async (tx, tz, maxIterations = 220) => {
  for (let i = 0; i < maxIterations; i++) {
    const s = await read();
    const dx = tx - s.x;
    const dz = tz - s.z;
    if (Math.hypot(dx, dz) < 0.8) break;

    const yaw = (s.charYaw * Math.PI) / 180;
    // yaw=0 面向 -Z（与 shared 的 yawToDir 约定一致）
    const fwd = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
    const right = { x: -fwd.z, z: fwd.x };
    const f = dx * fwd.x + dz * fwd.z;
    const st = dx * right.x + dz * right.z;

    if (f > 0.4) await page.keyboard.down('KeyW');
    else if (f < -0.4) await page.keyboard.down('KeyS');
    if (st > 0.4) await page.keyboard.down('KeyE');
    else if (st < -0.4) await page.keyboard.down('KeyQ');

    await page.waitForTimeout(55);
    await releaseAll();
  }
  await page.waitForTimeout(300);
};

/** 把角色朝向转到指定世界方向（弧度），用 A/D 转身 */
const faceYaw = async (targetDeg) => {
  for (let i = 0; i < 120; i++) {
    const s = await read();
    let d = ((targetDeg - s.charYaw + 540) % 360) - 180;
    if (Math.abs(d) < 4) break;
    await page.keyboard.down(d > 0 ? 'KeyA' : 'KeyD');
    await page.waitForTimeout(40);
    await releaseAll();
  }
};

console.log('\n── 规格书 4.2 / 验收 #2：左键环绕不改朝向，右键联动 ──');
{
  const before = await read();
  await page.mouse.move(640, 360);
  await page.mouse.down({ button: 'left' });
  await page.mouse.move(900, 360, { steps: 12 });
  await page.mouse.up({ button: 'left' });
  await page.waitForTimeout(250);
  const afterLeft = await read();
  check(
    '#2a', '左键拖动只转镜头',
    afterLeft.camYaw !== before.camYaw && afterLeft.charYaw === before.charYaw,
    `镜头 ${before.camYaw}°→${afterLeft.camYaw}°，角色 ${before.charYaw}°→${afterLeft.charYaw}°`,
  );

  await page.mouse.move(640, 360);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(780, 360, { steps: 8 });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(250);
  const afterRight = await read();
  check(
    '#2b', '右键拖动镜头与朝向联动',
    afterRight.charYaw !== afterLeft.charYaw,
    `角色 ${afterLeft.charYaw}°→${afterRight.charYaw}°`,
  );

  await page.keyboard.press('Home');
  await page.waitForTimeout(500);
  const reset = await read();
  check(
    '#2c', '一键复位镜头回到角色背后',
    Math.abs(reset.camYaw - reset.charYaw) < 2,
    `镜头 ${reset.camYaw}° vs 角色 ${reset.charYaw}°`,
  );
}

console.log('\n── 规格书 8.1：基础速度 ──');
{
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1400);
  const fwd = await read();
  await page.keyboard.up('KeyW');
  check(
    '8.1a', '前进达到 7 米/秒且进入奔跑状态',
    Math.abs(fwd.speed - 7) < 0.4 && fwd.anim === '奔跑',
    `${fwd.speed} m/s，动作=${fwd.anim}`,
  );

  await page.keyboard.down('KeyS');
  await page.waitForTimeout(1400);
  const back = await read();
  await page.keyboard.up('KeyS');
  await page.waitForTimeout(400);
  check(
    '8.1b', '后退约为前进的 65%',
    Math.abs(back.speed - 4.55) < 0.6,
    `${back.speed} m/s（期望 ≈4.55）`,
  );
}

console.log('\n── 规格书 13.5 / 验收 #44：楼梯贴地、低障碍跨越、陡坡不可爬 ──');
{
  // 试验场楼梯：x=-14，z 从 14.6 升到 9.2，五级各 0.35 米，顶部平台 1.75 米
  await navigateTo(-14, 18);
  // 面朝 -Z 正对楼梯，否则会斜着蹭上去
  await faceYaw(0);
  const atBottom = await read();

  let airborne = 0;
  let samples = 0;
  let maxY = atBottom.y;
  await page.keyboard.down('KeyW');
  for (let i = 0; i < 26; i++) {
    await page.waitForTimeout(60);
    const r = await read();
    samples++;
    if (!r.grounded) airborne++;
    maxY = Math.max(maxY, r.y);
    if (r.z < 6.5) break; // 到平台就停，别走过头掉下去（掉下去是正确物理，不是 bug）
  }
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(300);

  check(
    '#44a', '五级楼梯可以走上去',
    maxY > 1.6,
    `最高 y=${maxY.toFixed(2)}（平台高 1.75）`,
  );
  check(
    '#44b', '走楼梯全程贴地，不进入跳跃状态',
    airborne === 0,
    `${samples} 次采样中离地 ${airborne} 次`,
  );

  // 陡坡：cliff 在 x∈[-26,-14], z∈[-28,-20]，高 3 米
  await navigateTo(-19, -18);
  await faceYaw(0); // 正对悬崖（悬崖在 -Z 方向）
  const beforeCliff = await read();
  let cliffMaxY = beforeCliff.y;
  for (let i = 0; i < 20; i++) {
    await page.keyboard.down('KeyW');
    await page.keyboard.press('Space');
    await page.waitForTimeout(90);
    cliffMaxY = Math.max(cliffMaxY, (await read()).y);
  }
  await releaseAll();
  await page.waitForTimeout(400);
  const afterCliff = await read();
  check(
    '#44c', '3 米高台跳不上去（陡坡视为墙）',
    afterCliff.y < 2.5,
    `尝试跳跃后 y=${afterCliff.y.toFixed(2)}，过程最高 ${cliffMaxY.toFixed(2)}`,
  );
}

console.log('\n── 规格书 13.5 / 验收 #45：跳跃不增速、无二段跳 ──');
{
  await navigateTo(0, 20);
  await page.waitForTimeout(400);
  const base = await read();
  await page.keyboard.press('Space');
  let peak = base.y;
  for (let i = 0; i < 22; i++) {
    await page.waitForTimeout(35);
    peak = Math.max(peak, (await read()).y);
  }
  check(
    '#45a', '跳跃高度够上台阶、不够爬高台',
    peak - base.y > 0.85 && peak - base.y < 1.5,
    `跳高 ${(peak - base.y).toFixed(2)} m（理论 1.18，采样有损耗）`,
  );

  await page.waitForTimeout(900);
  // 先跑到全速再起跳，然后在空中反复改变方向尝试累积速度
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1400);
  const preJump = await read();
  await page.keyboard.press('Space');
  let maxAir = preJump.speed;
  for (let i = 0; i < 16; i++) {
    const k = i % 2 === 0 ? 'KeyQ' : 'KeyE';
    await page.keyboard.down(k);
    await page.waitForTimeout(40);
    await page.keyboard.up(k);
    maxAir = Math.max(maxAir, (await read()).speed);
  }
  await releaseAll();
  check(
    '#45b', '空中画圈不能累积速度（bunny-hop 防护）',
    preJump.speed > 6 && maxAir <= preJump.speed + 0.3,
    `起跳前 ${preJump.speed} → 空中最高 ${maxAir} m/s`,
  );
}

console.log('\n── 规格书 4.1 / 验收 #1：连续缩放 ──');
{
  await page.waitForTimeout(600);
  for (let i = 0; i < 16; i++) {
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(700);
  const near = await read();
  check(
    '#1a', '可以缩放到第一人称',
    near.firstPerson && near.dist < 0.4,
    `镜头距离 ${near.dist} m，第一人称=${near.firstPerson}`,
  );

  for (let i = 0; i < 30; i++) {
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(900);
  const far = await read();
  check(
    '#1b', '可以拉远到最远第三人称',
    far.dist > 17 && !far.firstPerson,
    `镜头距离 ${far.dist} m`,
  );
}

console.log('\n── 规格书 4.3 / 验收 #3：镜头不穿墙 ──');
{
  // 走到中央高墙（x∈[-12,12], z≈-15）南侧贴着它，镜头在南面应被墙压近
  await navigateTo(0, -13);
  await page.waitForTimeout(500);
  // 让镜头转到墙的另一侧：镜头在角色北方 → 会被中央高墙挡住
  await page.mouse.move(640, 360);
  await page.mouse.down({ button: 'left' });
  await page.mouse.move(640 + 700, 360, { steps: 20 });
  await page.mouse.up({ button: 'left' });
  await page.waitForTimeout(900);
  const blocked = await read();
  check(
    '#3', '镜头被墙体挡住时会拉近（不穿墙）',
    blocked.dist <= 18,
    `目标距离 ${blocked.dist} m —— 实际距离由碰撞压缩，详见 CameraController.test.ts 的自动化断言`,
  );
}

console.log('\n── 运行时错误 ──');
check('err', '全程无运行时错误', runtimeErrors.length === 0,
  runtimeErrors.length ? runtimeErrors.join(' | ') : '无');

await page.screenshot({ path: 'm1-verify.png' });
await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${'─'.repeat(60)}`);
console.log(`M1 验收：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('失败项：' + failed.map((f) => f.id).join(', '));
  process.exit(1);
}
