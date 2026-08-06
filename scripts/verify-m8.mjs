/**
 * M8 端到端验收脚本。附录A#7 要求的阶段验收用例。
 *
 * 覆盖验收 #35（装备栏与换装反馈）、#48（低画质下关键信息仍可见）、
 * #49（第一人称不遮屏、最远镜头旗手清晰），以及 15.1 / 15.4 的 HUD 四区。
 *
 * ★ 为什么必须驱动浏览器：M8 的规则**全部是"看得见"这件事**。
 *   `quality.test.ts` 能证明「关键角色在三档下 isVisible() 都为 true」，
 *   但证明不了那个网格真的画在了屏幕上 ——
 *   M8 就漏过两次这种 bug：玩家的状态标记注册在错误的 id 下、
 *   带旗使用无敌技能没有先掉旗，两次都是单元测试全绿、截图/操作才暴露。
 *
 * 用法：
 *   pnpm dev:client
 *   node scripts/verify-m8.mjs
 */

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  results.push({ id, pass });
  console.log(`  ${pass ? '✓' : '✗'} ${id} ${name}\n      ${detail}`);
};

const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
const runtimeErrors = [];
page.on('pageerror', (e) => runtimeErrors.push(e.message));
const qualityLog = [];
page.on('console', (m) => {
  if (m.type() === 'error') runtimeErrors.push(m.text());
  if (m.text().startsWith('[画质]')) qualityLog.push(m.text().replace('[画质] ', ''));
});

const hold = async (key, ms) => {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
};
const text = async (sel) => page.$eval(sel, (e) => e.innerText).catch(() => '');
const exists = async (sel) => (await page.$(sel)) !== null;
/** 数一张截图里非背景色的像素比例，用来判断"画面上确实有东西" */
const fps = async () => {
  const t = await text('#stats');
  return Number(t.match(/FPS\s+(\d+)/)?.[1] ?? 0);
};

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);

/**
 * ★★ 把假人静音：本脚本有多处**按住方向键走固定时长**的走位（走到旗帜、
 *   走进交互半径），这类脚本隐含假设「玩家以基础速度移动」。
 *
 *   在「减速光环接进 tickWorld」之前，法师假人的霜矢挂的 30% 减速
 *   **对移动毫无影响**，所以那个假设一直成立。减速真正生效之后，
 *   同样的按键时长只能走到七成距离 —— #40a 于是报「距离太远」。
 *   这不是回归，是那条规则终于生效了。
 *
 * ★ 复用 M15 教学同款的 `pausedDummyClasses`，不新开后门。
 */
await page.evaluate(() => {
  const s = globalThis.__scene;
  for (const c of ['warrior', 'priest', 'mage']) s.combat.pausedDummyClasses.add(c);
  s.combat.clearPlayerAuras();
});
await page.waitForTimeout(400);

console.log('\n── 规格书 15.1：通用 HUD 四区 ──');
{
  const zones = {
    '左侧队友': '#party-frame',
    '右上小地图': '#minimap',
    '中央模式信息': '#mode-hud',
    '底部技能栏': '#skill-bar',
    '战场装备栏': '#loadout-panel',
  };
  const found = {};
  for (const [name, sel] of Object.entries(zones)) found[name] = await exists(sel);
  check('15.1', '★ HUD 四区 + 装备栏全部存在',
    Object.values(found).every(Boolean),
    Object.entries(found).map(([k, v]) => `${k}=${v ? '有' : '缺'}`).join('，'));

  const party = await text('#party-frame');
  check('15.1b', '队伍框显示姓名与职业（六项之二，其余为条形图/字形）',
    party.includes('法师'),
    `队伍框内容：${party.replace(/\n/g, ' / ').slice(0, 60)}`);
}

console.log('\n── 规格书 15.4：模式专属 HUD（夺旗）──');
{
  const mh = await text('#mode-hud');
  const hasScore = /\d+\s*\/\s*\d+/.test(mh.replace(/\n/g, ' '));
  check('15.4a', '★ 夺旗 HUD 显示比分、比赛时间与双方旗帜状态',
    hasScore && mh.includes('剩余') && mh.includes('红旗') && mh.includes('蓝旗'),
    mh.replace(/\n/g, ' | '));
}

console.log('\n── 验收 #35：战场装备栏与换装反馈（15.3）──');
{
  const before = await text('#loadout-panel');
  const hasAdv = before.includes('优势') && before.includes('代价');
  const hasCurrent = before.includes('当前');

  // B 切换备用武器 → 应出现换装进度条
  await page.keyboard.press('KeyB');
  await page.waitForTimeout(250);
  const during = await text('#loadout-panel');

  check('#35a', '★ 武器/护甲分区显示，当前装备高亮，备用装备显示优缺点（15.3 第一条）',
    hasAdv && hasCurrent && before.includes('武器') && before.includes('护甲'),
    `含"优势/代价"=${hasAdv}，含"当前"标记=${hasCurrent}`);

  check('#35b', '★ 换装时显示进度条（15.3 第二条）',
    during.includes('切换武器'),
    during.replace(/\n/g, ' | ').slice(-70));
}

console.log('\n── 验收 #40 / 12.3：带旗使用无敌技能先掉旗（M7 规则的客户端接线）──');
{
  /**
   * 侧移到蓝旗旁边（出生点右侧约 11 米）。
   *
   * ★★ **按位移判定，不按时长**。原本是 `hold('KeyE', 1600)` —— 1.6 秒 × 7 m/s
   *   恰好 11.2 米，把「玩家一定以基础速度移动」这个假设**烧进了一个魔法数字**。
   *   减速接进 tickWorld 之后，任何一层减速都会让它走不到，报出来是
   *   「距离太远」，看起来像拔旗坏了。
   *   现在按实际横向位移收尾：走到了就停，走不到就超时 —— 与移动速度无关。
   */
  /**
   * ★ 走位前**就地**再清一次减速并重新静音假人。
   *   脚本开头清过一次，但这中间隔着换装等好几节，法师假人的霜矢
   *   （30% 减速，3 秒）足以在这期间再挂上来 —— 减速接进 tickWorld 之后
   *   它是真的会让人走得慢的，而下面这段走位要靠位移收尾。
   */
  await page.evaluate(() => {
    const s = globalThis.__scene;
    for (const c of ['warrior', 'priest', 'mage']) s.combat.pausedDummyClasses.add(c);
    s.combat.clearPlayerAuras();
  });
  await page.waitForTimeout(200);

  /**
   * ★★ **小步走 + 每步试一次拔旗，成功即停。**
   *
   *   前两版都栽在「把距离或时长写死」上：
   *     · 原版 `hold('KeyE', 1600)` —— 1.6 秒 × 7 m/s 的假设。减速一生效就走不到
   *     · 我的第一版改成「走满 11 米」—— 反而**冲过头**：1600ms 带加速爬坡
   *       实际只走了九米多，旗其实比 11 米近，走满 11 米就超出了交互半径
   *       （实测停在 x=12.41，照样报「距离太远」）
   *
   *   现在不猜距离、也不猜速度：每步走一小段 → 停稳 → 按一次 G，
   *   拔到了就退出。被减速就多走几步而已。
   * ★ 每步之后要等滑行停下：12.1 的拔旗是 0.8 秒引导，**会被移动打断**。
   */
  let carried = '';
  for (let step = 0; step < 24; step++) {
    await hold('KeyE', 200);
    await page.waitForTimeout(260);
    await page.keyboard.press('KeyG');
    await page.waitForTimeout(950);
    carried = await text('#mode-hud');
    if (carried.includes('被携带')) break;
  }
  // ★ 失败时把「当时到底什么状态」一起打出来 —— 这条断言反复时好时坏，
  //   而 `距离太远` 只说明够不着，说不清是没走到、还是被减速、还是滑行中
  const diag = await page.evaluate(() => {
    const s = globalThis.__scene;
    return {
      x: +s.move.position.x.toFixed(2), z: +s.move.position.z.toFixed(2),
      v: +Math.hypot(s.move.velocity.x, s.move.velocity.z).toFixed(2),
      auras: [...s.combat.auras.values?.() ?? []].length,
      names: (s.combat.log ?? []).slice(0, 2).map((l) => l.text),
    };
  });

  check('#40a', '★ 真实按键能完成拔旗，HUD 显示旗手姓名',
    carried.includes('被携带') && carried.includes('旗手'),
    `${carried.replace(/\n/g, ' | ')}｜位置(${diag.x}, ${diag.z}) 速度${diag.v} 日志:${diag.names.join('/')}`);

  // 槽 8 = 冰封庇护（完全无敌，dropsFlagOnUse）
  await page.keyboard.press('Digit8');
  await page.waitForTimeout(900);
  const dropped = await text('#mode-hud');
  check('#40b', '★★ 带旗使用完全无敌 → 先掉旗（12.3 / 验收 #40）',
    dropped.includes('已掉落'),
    dropped.replace(/\n/g, ' | '));
}

console.log('\n── 验收 #48：低画质下关键信息仍可见（14.4）──');
{
  // ★ 不拿"打中一个技能"当前提 —— 那样脚本会时好时坏（M1 踩过这个坑：
  //   技能可能在冷却、玩家可能正被控，脚本就白等）。
  //   战士假人会持续用猛击控住玩家，所以等**玩家自己**身上出现控制字形。
  //   这条路既可靠，又正好同时验证了队伍框的控制显示（15.1 左侧第四项）。
  /**
   * ★ 必须**精确**回到出生点：战士假人在正前方 2.6 米，猛击距离只有 3 米，
   *   多走 0.7 米就出圈，然后 25 秒都等不到一次控制。
   *
   * ★★ **按位置回，不按时长回。** 原本是 `hold('KeyQ', 1600)` —— 与上一段
   *   拔旗的 1600ms 镜像对称，两段都把「玩家以基础速度移动」烧进了魔法数字。
   *   减速接进 tickWorld 之后这个对称立刻塌掉：去程慢了走不到旗，
   *   回程慢了停在半路够不着战士，于是 #40 与 #48b 一起变成时好时坏。
   *   出生点 x=0，直接走到 x≈0 为止，与速度无关。
   */
  /**
   * ★ 停止条件是 `x < 0.6` 而不是 `|x| < 0.35`：全速 7 m/s 下一个 100ms
   *   轮询步就是 0.7 米，恰好能**跨过** ±0.35 的窗口 —— 错过一次就一路
   *   滑到西墙（实测停在 34 米外，第一发新星放空进 18s 冷却，#48b 全窗报
   *   「冷却中」）。从东侧回来，「降到 0.6 以下」怎么采样都不会错过；
   *   即使惯性再滑出半米，离战士也仍在霜爆新星 5 米半径内（它要的余量
   *   比当年猛击的 3 米宽裕得多）。轮询同时加密到 60ms。
   */
  await page.keyboard.down('KeyQ');
  {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(60);
      const x = await page.evaluate(() => globalThis.__scene.move.position.x);
      if (x < 0.6) break;
    }
  }
  await page.keyboard.up('KeyQ');
  await page.waitForTimeout(600);

  /**
   * 五种控制的字形。
   * ★ **从 `vfx/status.ts` 源码里读**，不写死字面量：定身的字形从 ⛓ 改成 ❄
   *   （配合冰刺形状）时，写死的列表会让这条断言假失败 ——
   *   报出来是「低画质下控制状态不可见」，而真相只是脚本不认识新字形。
   *   与 `verify-m12` 解析 `VFX_TEXTURE_FILES` 是同一手法。
   */
  const statusSrc = readFileSync(
    join(resolve(dirname(fileURLToPath(import.meta.url)), '..'),
      'packages/client/src/vfx/status.ts'), 'utf8');
  const CONTROL_GLYPHS = [...statusSrc.matchAll(/glyph:\s*'([^']+)'/g)].map((m) => m[1]);
  if (CONTROL_GLYPHS.length < 5) throw new Error('没能从 status.ts 解析出五种控制字形');
  const partyControlGlyphs = async () => {
    const t = await text('#party-frame');
    return CONTROL_GLYPHS.filter((g) => t.includes(g));
  };

  // 高画质下先记一张，作为人工比对材料
  const fpsHigh = await fps();
  const highGlyphs = await partyControlGlyphs();
  await page.screenshot({ path: 'scripts/_verify-m8-high.png' });

  // ★ **先切到最低档，再等控制出现** —— 顺序很重要。
  //   反过来做（先看到控制、再切档、再看还在不在）会把"控制到期"
  //   误判成"低画质隐藏了控制"：猛击的昏迷只有几秒，切档那 0.75 秒里就可能过期。
  //   现在断言的是它该有的形式：**在最低画质下**，控制状态可见。
  await page.keyboard.press('F2'); // high → medium
  await page.waitForTimeout(150);
  await page.keyboard.press('F2'); // medium → low
  await page.waitForTimeout(500);

  // ★ 用**目标框的控制标记**当探针，而不是等玩家自己被控：
  //   战士假人只在玩家读条时才猛击，而猛击是打断+学派锁定，**不产生昏迷**——
  //   所以"等玩家被控"这条路根本等不到（前面白试了三轮）。
  //   改成主动定身战士：Tab 选中它 → 霜爆新星（自身中心 5 米定身，瞬发无需目标）
  //   → 目标框上出现「⛓ 定身」。整个链条在**最低画质**下完成。
  await page.keyboard.press('Tab');
  await page.waitForTimeout(400);

  /**
   * ★ **循环重按**，不是按一次就干等：上一段 #40b 刚放过冰封庇护
   *   （4 秒 `stunned` 自锁），走回出生点的耗时又不再固定（按位置收尾）——
   *   自锁未结束时这一下新星**静默失败**，按一次的版本就白等 8 秒。
   *   与本段开头的注释同一件事：「技能可能在冷却、玩家可能正被控，脚本就白等」。
   *   失败的施法不消耗递减，所以重按不会把定身推进免疫窗口。
   */
  let lowGlyphs = [];
  {
    const deadline = Date.now() + 12000;
    let nextNova = 0;
    while (Date.now() < deadline) {
      if (Date.now() >= nextNova) {
        await page.keyboard.press('Digit5');
        nextNova = Date.now() + 2000;
      }
      const tf = await text('#target-frame');
      lowGlyphs = CONTROL_GLYPHS.filter((g) => tf.includes(g));
      if (lowGlyphs.length > 0) break;
      await page.waitForTimeout(200);
    }
  }
  // ★ 失败诊断：这条断言时好时坏过不止一次，「字形=[]」说不清是
  //   没选中战士、人不在新星半径内、技能在冷却，还是别的
  const novaDiag = await page.evaluate(() => {
    const s = globalThis.__scene;
    const p = s.combat.player;
    const target = s.combat.allEntities().find((e) => e.id === p.targets.hard);
    const warrior = s.combat.allEntities().find((e) => e.classId === 'warrior');
    const dist = (a, b) => Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z).toFixed(2);
    return {
      target: target?.name ?? '无',
      warriorDist: warrior ? dist(p, warrior) : '?',
      novaCd: (p.cooldowns.get('mage.frost_nova') ?? 0) - s.combat.now,
      log: (s.combat.log ?? []).slice(0, 3).map((l) => l.text),
    };
  });

  const fpsLow = await fps();
  await page.screenshot({ path: 'scripts/_verify-m8-low.png' });

  const modeLow = await text('#mode-hud');
  const minimapLow = await exists('#minimap');

  // ★ 直接验档位切换机制本身，不用帧率当代理指标 ——
  //   软件渲染下帧率受 CPU 影响大，25→25 说明不了任何事
  check('#48a', '★ F2 逐档下降 high → medium → low（验档位机制，不看帧率）',
    qualityLog.slice(-2).join(' → ') === 'medium → low',
    `档位序列 ${qualityLog.join(' → ') || '(无)'}；参考帧率 ${fpsHigh} → ${fpsLow} FPS`);

  check('#48b', '★★ **最低画质下**控制状态、旗帜信息、队伍框、小地图全部可见',
    lowGlyphs.length > 0 && modeLow.includes('旗') && minimapLow,
    `最低画质下目标框控制字形=[${lowGlyphs.join('')}]，队伍框高画质时=[${highGlyphs.join('')}]，` +
    `旗帜信息在=${modeLow.includes('旗')}，小地图在=${minimapLow}` +
    `｜目标=${novaDiag.target} 战士距离=${novaDiag.warriorDist} 新星冷却=${novaDiag.novaCd.toFixed(1)}s` +
    `｜日志:${novaDiag.log.join('/')}`);

  // 切回高画质
  await page.keyboard.press('F2');
  await page.waitForTimeout(300);
}

console.log('\n── 验收 #49：第一人称不遮屏、最远镜头旗手清晰（14.3）──');
{
  await page.mouse.move(700, 400);
  // 滚轮推到第一人称
  for (let i = 0; i < 12; i += 1) {
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(400);
  const stats1 = await text('#stats');
  const firstPerson = /第一人称\s+是/.test(stats1);
  await page.screenshot({ path: 'scripts/_verify-m8-fp.png' });

  check('#49a', '★ 能进入第一人称（近身特效透明度上限由 closeUpOpacity 保证）',
    firstPerson,
    `第一人称=${firstPerson}；透明度规则由 vfx.test.ts 断言（≤0.25 且 >0）`);

  // 拉到最远
  for (let i = 0; i < 30; i += 1) {
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(500);
  const stats2 = await text('#stats');
  const dist = Number(stats2.match(/镜头距离\s+([\d.]+)/)?.[1] ?? 0);
  const modeFar = await text('#mode-hud');
  await page.screenshot({ path: 'scripts/_verify-m8-far.png' });

  check('#49b', '★ 最远镜头下旗帜信息仍在 HUD 上，关键标记按距离放大',
    dist >= 17 && modeFar.includes('旗'),
    `镜头距离 ${dist}m（上限 18m），旗帜信息仍显示=${modeFar.includes('旗')}`);
}

console.log('\n── 运行时健康 ──');
check('M8', '整个流程没有运行时错误',
  runtimeErrors.length === 0,
  runtimeErrors.length ? runtimeErrors.slice(0, 3).join(' / ') : '无');

const failed = results.filter((r) => !r.pass);
console.log(`\n${'─'.repeat(60)}`);
console.log(`M8 验收：${results.length - failed.length}/${results.length} 通过`);
console.log('截图：scripts/_verify-m8-{high,low,fp,far}.png（#48 / #49 的人工比对材料）');
if (failed.length) {
  console.log('失败项：' + failed.map((f) => f.id).join(', '));
  await browser.close();
  process.exit(1);
}
await browser.close();
