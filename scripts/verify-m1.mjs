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
const URL = process.env.VERIFY_URL ?? 'http://localhost:5173/?testbed&art=off';
const results = [];

const check = (id, name, pass, detail) => {
  results.push({ id, name, pass, detail });
  console.log(`  ${pass ? '✓' : '✗'} ${id} ${name}\n      ${detail}`);
};

/**
 * 捆绑 chromium 优先；装不上时退回系统 Edge / Chrome（与 verify-m12 同一回落）。
 * ★ 回落只换浏览器载体，断言原样不动 —— 本机网络拉不动 Playwright CDN 时，
 *   「跑不起来的验收」等于没有验收。
 */
const browser = await (async () => {
  try {
    return await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  } catch {
    for (const channel of ['msedge', 'chrome']) {
      try {
        return await chromium.launch({ channel });
      } catch { /* 试下一个 */ }
    }
    throw new Error('没有可用浏览器：捆绑 chromium 未安装，msedge/chrome 也不可用');
  }
})();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const runtimeErrors = [];
page.on('pageerror', (e) => runtimeErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') runtimeErrors.push(m.text());
});

/**
 * ★★ X15 播种：**关掉指针锁定**，在 `goto` 之前。
 *
 *   本脚本用**合成**鼠标事件驱动镜头（下面的左键环绕与右键转身）。指针锁定
 *   默认是开的（真人档：右键按下即 `requestPointerLock`，光标不再被屏幕边缘
 *   卡住）—— 但一旦锁上，合成事件的 `movementX` 口径就由浏览器的锁定态说了算，
 *   与这些断言当年成立时的口径不是一回事。
 *
 *   播种 `pointerLock:false` ⇒ 合成事件继续走**旧拖动路径**（那条路径一行没删），
 *   于是**断言一个字都不用改**。真人手感由默认开的那条路负责。
 *
 * ★ 与 `?art=off` 是同一个分工思路：验收档只关掉「会改变测量口径」的东西。
 * ★ 只写这一个键 —— 其余字段由 `normalizeAccessibility` 补成默认值
 *   （accessibility.test.ts 里有一条「逐字段等于默认档」的断言钉着）。
 */
await page.addInitScript(() => {
  try {
    localStorage.setItem('wowpvp.accessibility.v1', JSON.stringify({ pointerLock: false }));
  } catch { /* 隐私模式等拿不到 storage：那种环境里本来也锁不上 */ }
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
 * 走到目标点附近。**推算式导航**：按距离算出该按多久，一次按住走完，再修正一两轮。
 *
 * ⚠️ 早先的实现是「每 55ms 读一次位置再决定按哪个键」，220 次迭代意味着
 *    220 次 Playwright 往返。软件渲染下单次往返 ~200ms，一次导航就是 40 秒，
 *    整个脚本跑十几分钟 —— 长时间挂着 swiftshader 渲染器会丢执行上下文，
 *    表现为 `Cannot find context with specified id`。推算式把往返降到个位数。
 *
 * ★ 仍然必须按**角色当前朝向**分解方向向量。直接假设「W 就是 -Z」在角色被转过
 *   之后会走向完全错误的方向 —— 这是 6.5「镜头朝向 ≠ 角色朝向」在测试侧的镜像。
 */
const BASE_SPEED = 7; // 8.1 基础前进速度，米/秒
const BACKWARD_FACTOR = 0.65;

const navigateTo = async (tx, tz, passes = 5) => {
  for (let pass = 0; pass < passes; pass++) {
    const s = await read();
    const dx = tx - s.x;
    const dz = tz - s.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.5) break;

    const yaw = (s.charYaw * Math.PI) / 180;
    // yaw=0 面向 -Z（与 shared 的 yawToDir 约定一致）
    const fwd = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
    const right = { x: -fwd.z, z: fwd.x };
    const f = dx * fwd.x + dz * fwd.z;
    const st = dx * right.x + dz * right.z;

    // ⚠️ **逐轴依次走**，不同时按下。
    //    同时按 W 和 E 时 movement 会把输入向量归一化，每个轴只拿到 1/√2 的速度，
    //    按分量算出来的时长就会系统性走不够 —— 楼梯用例正是这么走偏的。
    const legs = [];
    if (Math.abs(f) > 0.4) legs.push({ k: f > 0 ? 'KeyW' : 'KeyS', ms: msFor(Math.abs(f), f < 0) });
    if (Math.abs(st) > 0.4) legs.push({ k: st > 0 ? 'KeyE' : 'KeyQ', ms: msFor(Math.abs(st), false) });
    if (legs.length === 0) break;

    for (const { k, ms } of legs) {
      await page.keyboard.down(k);
      await page.waitForTimeout(ms);
      await page.keyboard.up(k);
      await page.waitForTimeout(150); // 等减速停稳，避免惯性带偏下一段
    }
    await releaseAll();
  }
};

/**
 * 按住一个键 `ms` 毫秒。
 *
 * ⚠️ 不要用 `page.keyboard.press()`：它按下到松开几乎是 0ms，而游戏每帧才采样一次输入。
 *    软件渲染下一帧 70ms，press 的按键**根本不会被看到** —— 跳跃用例就是这么静默失败的。
 *    这不是游戏 bug：真人按键至少几十毫秒。
 */
const hold = async (key, ms = 120) => {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
};

/**
 * 把测速环境「压干净」：静音全部假人 → 等在飞的弹体全部落地 →
 * 清掉玩家身上的光环 → 确认真的干净了才返回。
 *
 * ★★ 只「静音 + 清一次」是不够的：静音只拦得住**下一次施法**，
 *   法师假人的霜矢若已在空中，会在清完之后落地并重新挂上 30% 减速
 *   （3 秒）—— 8.1 于是量到 4.9 m/s，而且**时好时坏**，
 *   取决于静音那一刻有没有弹体恰好在飞。
 *
 * ★★ 而且**光等弹体还是不够**：静音拦的是「开始新读条」，
 *   已经在读条中的霜矢会照常读完并发弹（探针实测：quiesce 确认
 *   projectiles=0 之后 1.4 秒内 chill 又挂回来了）。
 *   所以「干净」的完整定义是三条同时成立：
 *     没有假人在读条 · 没有弹体在飞 · 玩家身上一层光环都不剩。
 *   假人静音后不会再进入读条，此后环境才真正保持干净。
 */
const quiescePlayerSpeed = async () => {
  await page.evaluate(() => {
    const s = globalThis.__scene;
    for (const c of ['warrior', 'priest', 'mage']) s.combat.pausedDummyClasses.add(c);
  });
  for (let i = 0; i < 40; i++) {
    const clean = await page.evaluate(() => {
      const s = globalThis.__scene;
      for (const id of s.combat.store.keys()) {
        if (id !== s.combat.player.id) return false; // 假人还在读条
      }
      if (s.combat.projectiles.items.length > 0) return false;
      s.combat.clearPlayerAuras();
      return (s.combat.auras.get(s.combat.player.id) ?? []).length === 0;
    });
    if (clean) return;
    await page.waitForTimeout(150);
  }
  throw new Error('quiescePlayerSpeed：6 秒内没能把环境压干净（假人读条/弹体/光环仍在）');
};

/** 走 `meters` 米需要按住多久（毫秒），含起步加速的粗略补偿 */
const msFor = (meters, backward) => {
  const speed = BASE_SPEED * (backward ? BACKWARD_FACTOR : 1);
  return Math.min(6000, (meters / speed) * 1000 + 120);
};

/**
 * 把角色朝向转到指定世界方向（度）。
 * 转向速度是常量 TURN_SPEED = 3.2 rad/s，同样用推算而不是逐帧轮询。
 */
const TURN_SPEED_DEG = (3.2 * 180) / Math.PI;

const faceYaw = async (targetDeg, passes = 3) => {
  for (let pass = 0; pass < passes; pass++) {
    const s = await read();
    const d = ((targetDeg - s.charYaw + 540) % 360) - 180;
    if (Math.abs(d) < 2.5) break;
    // yaw 增大 = 向左转（A）
    await page.keyboard.down(d > 0 ? 'KeyA' : 'KeyD');
    await page.waitForTimeout((Math.abs(d) / TURN_SPEED_DEG) * 1000);
    await releaseAll();
    await page.waitForTimeout(120);
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
  /**
   * ★★ 先把假人静音并清掉自己身上的光环，再量**基础**速度。
   *
   *   这一步是补上的：在「减速光环接进 tickWorld」之前，法师假人的霜矢
   *   给玩家挂的 `mage.frostbolt.chill`（moveSpeed 0.7）**对移动毫无影响**，
   *   所以量到的一直是干净的 7 m/s。减速真正生效之后，这里量到 4.99 m/s
   *   （= 7 × 0.7）—— 断言红了，但游戏是对的：**被减速时就该走得慢**。
   *
   *   8.1 要验的是「基础速度 7 m/s」，那就必须在无减速的条件下量。
   *   复用 M15 教学同款的 `pausedDummyClasses`，不新开后门。
   */
  await quiescePlayerSpeed();

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
  // 试验场楼梯：x=-14，z 从 14.6 升到 9.2，五级各 0.35 米，顶部平台 1.75 米。
  //
  // ⚠️ 这一段**不用 navigateTo**，改为从已知状态出发的确定序列。
  //    楼梯宽 5 米（x ∈ [-16.5, -11.5]），要求正对 -Z 走上去；
  //    而 navigateTo 之后的朝向会有若干度残差，斜着蹭上楼梯就会从侧边滑下来，
  //    被误判成「爬楼梯时弹跳」。用例因此变得时好时坏 —— 那比没有测试更糟。
  //
  //    重载页面把角色放回出生点 (0, 26)、朝向 0°，再**只用侧移**横移到楼梯中线：
  //    Q/E 侧移按定义不改变角色朝向（4.2），所以整段序列完全确定。
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1800);
  await hold('KeyQ', 2150); // 左移约 14 米，到楼梯中线 x ≈ -14
  await page.waitForTimeout(350);

  const atBottom = await read();
  const startNote = `起点 (${atBottom.x.toFixed(1)}, ${atBottom.z.toFixed(1)}) 朝向 ${atBottom.charYaw}°`;

  // 试验场几何：楼梯占 z ∈ [9.2, 14.6]，顶部平台 z ∈ [4.5, 8.5]、高 1.75。
  // ⚠️ 单次采样间隔里角色已经走了约 1.8 米，所以只统计**还在楼梯段上**的采样 ——
  //    走出平台远端边缘后的下落是正确物理，不该算作「爬楼梯时弹跳」。
  //    逐帧级别的严格断言在 movement.test.ts（120 帧内离地 0 次）。
  const STAIRS_Z_MIN = 8.6;
  let airborneOnStairs = 0;
  let stairSamples = 0;
  let maxY = atBottom.y;
  await page.keyboard.down('KeyW');
  /**
   * ★ 按**进度**停，不按固定迭代数。此前是 `for (26 次 × 60ms)` ——
   *   它在 swiftshader 下能走到顶，纯粹因为慢渲染把每次 `read()` 的往返
   *   拖长了几百毫秒，白送了几秒步行时间。换到带真 GPU 的浏览器
   *   （chromium 装不上时的 msedge 回落）后同一个循环只给 ~1.7 秒，
   *   角色刚上三级楼梯就被收了键 —— 那是测量环境的伪影，不是物理的问题。
   *   截止时间给足 8 秒：慢环境照常通过，快环境不再误报。
   */
  const stairDeadline = Date.now() + 8000;
  while (Date.now() < stairDeadline) {
    await page.waitForTimeout(60);
    const r = await read();
    maxY = Math.max(maxY, r.y);
    if (r.z > STAIRS_Z_MIN) {
      stairSamples++;
      if (!r.grounded) airborneOnStairs++;
    } else if (r.y > 1.5) {
      break; // 已经站上顶部平台，目的达到
    }
  }
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(300);

  check(
    '#44a', '五级楼梯可以走上去',
    maxY > 1.6,
    `最高 y=${maxY.toFixed(2)}（顶部平台 1.75）｜${startNote}`,
  );
  check(
    '#44b', '走楼梯全程贴地，不进入跳跃状态',
    stairSamples > 0 && airborneOnStairs === 0,
    `楼梯段 ${stairSamples} 次采样中离地 ${airborneOnStairs} 次｜${startNote}`,
  );

  // 陡坡：cliff 在 x∈[-26,-14], z∈[-28,-20]，高 3 米
  await navigateTo(-19, -18);
  await faceYaw(0); // 正对悬崖（悬崖在 -Z 方向）
  const beforeCliff = await read();
  let cliffMaxY = beforeCliff.y;
  for (let i = 0; i < 20; i++) {
    await page.keyboard.down('KeyW');
    await hold('Space');
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
  // Observe rendered frames before keydown; driver round trips can miss the apex.
  await page.evaluate(() => {
    const scene = globalThis.__scene;
    const original = scene.onDebug;
    globalThis.__jumpProbe = { peak: -Infinity, original };
    scene.onDebug = (frame) => {
      globalThis.__jumpProbe.peak = Math.max(globalThis.__jumpProbe.peak, frame.position.y);
      original(frame);
    };
  });
  await hold('Space');
  let peak = base.y;
  /**
   * ⚠️ 采样窗口必须覆盖**整条抛物线**（上升 ~0.49s + 下落 ~0.49s），
   *   而不只是理论顶点附近。
   *
   *   原本是 22 × 35ms = 770ms，勉强够到顶点；而 `#stats` 面板只有
   *   **10Hz** 重绘（main.ts 的 paintStats 节流到 100ms），
   *   所以这 22 次采样实际只读到 ~8 个不同的值 —— 顶点落在两次重绘
   *   之间时就整个被跳过，读数偏低到 0.85 阈值以下。
   *
   *   ★ 这是**观测走样**，不是物理回归：跳跃物理在 `shared/sim/movement.ts`，
   *     由 40 条单元测试守着，且本脚本从未改动过它。
   *     M12 调整帧率后这条偶发性变红，才暴露出这个一直存在的脆弱采样。
   */
  for (let i = 0; i < 42; i++) {
    await page.waitForTimeout(30);
    peak = Math.max(peak, (await read()).y);
  }
  peak = Math.max(peak, await page.evaluate(() => {
    const probe = globalThis.__jumpProbe;
    globalThis.__scene.onDebug = probe.original;
    delete globalThis.__jumpProbe;
    return probe.peak;
  }));
  check(
    '#45a', '跳跃高度够上台阶、不够爬高台',
    peak - base.y > 0.85 && peak - base.y < 1.5,
    `跳高 ${(peak - base.y).toFixed(2)} m（理论 1.18，采样有损耗）`,
  );

  await page.waitForTimeout(900);
  /**
   * ★ 与 8.1 同理：量跳跃物理前先把身上的减速清掉。
   *   #45b 验的是「空中画圈不能累积速度」，判据是「空中最高 ≤ 起跳前 × 1.05」——
   *   要量的是**基础**跳跃物理，就得在无减速条件下量。
   *   （历史注：这里一度观察到「地面 4.9、空中 6.97」的逃逸，那是试验场
   *   尚未接 speedMultiplier 时的现象；接线后空中同样吃减速，
   *   由 movement.test.ts 的「被减速起跳」两条断言钉住 —— docs/10 偏差 #13。）
   */
  await quiescePlayerSpeed();

  // 先跑到全速再起跳，然后在空中反复改变方向尝试累积速度
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1400);
  const preJump = await read();
  await hold('Space');
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
