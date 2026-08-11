/**
 * P4 CPU 剖析台：给 `?stress`（24 实体同屏）采一份 V8 CPU profile，按 self time
 * 聚合出热点排行。
 *
 * ★★ **它不是性能判据，是「钱花在哪」的指南针。**
 *
 *   X10 的真机数据给出的结论是「低画质砍掉 60% 绘制调用，帧率反而更差」——
 *   也就是瓶颈偏**每实体的 CPU 开销**而不是 GPU 提交量。但「CPU 开销」这四个字
 *   落不到代码行上，改哪儿全靠猜。这个脚本负责把它落到函数名上。
 *
 * ⚠️★★ **swiftshader 环境的绝对值没有意义，只有相对降幅有意义。**
 *
 *   软件渲染把 GPU 的活儿全搬进 CPU：`WebGLRenderer` 内部与一堆没有 url 的
 *   原生栈会占掉大头，那是这台机器的特产，真机上不长这样。所以输出**分三个桶**：
 *     · **我们的 JS** —— `packages/{client,shared,server}` 下的代码。**结论只对这一桶下。**
 *     · **库（three.js 等）** —— 再按函数名分「渲染管线 / 动画蒙皮 / 其他」，
 *       因为 `AnimationMixer` 的开销名义上在 three 里，实际是我们**每帧调多少次
 *       `mixer.update`** 决定的 —— 那笔账要算在我们头上（见「归因视图」）。
 *     · **引擎/原生** —— GC、`(program)`、swiftshader 光栅化。看看就好。
 *
 *   ★ 主判据是 **`我们的 JS + 归因` 的每帧毫秒数**，不是占比：占比会被
 *     swiftshader 的噪声整体抬降，每帧毫秒数不会（帧数由 rAF 计数器精确给出）。
 *
 * ⚠️★★ **默认画布是 640×360，这是刻意的，不是省事。**
 *
 *   1280×720 下 swiftshader 只跑得动 1.6 fps，而 `GameLoop` 一帧最多补 5 个
 *   固定步 —— 于是「每帧」里塞着 5 个 sim tick、HUD 的 20Hz 节流也退化成每帧都刷。
 *   量出来的「每帧成本」跟 60fps 真机上的每帧根本不是同一件事。
 *   把画布缩到 640×360（同 16:9，投影后的实体一个不少、骨骼/姓名板/粒子全在）
 *   只砍光栅化 —— 而光栅化正是 X10 已经排除掉的那一半。帧率因此回到十几帧，
 *   每帧一个 sim 步，比例关系才对得上真机。
 *   `--viewport 1280x720` 可以切回去看「全负载」长什么样。
 *
 * ★ 「归因视图」是本脚本最有用的一张表：把每个采样的 self time 记在**栈上最近的
 *   一个我们自己的函数**头上。于是 `CharacterView.update` 那一行会连同它调用的
 *   `mixer.update` → `PropertyMixer.apply` 一起计入 —— 这才是「砍掉一次骨骼更新
 *   能省多少」的答案。
 *
 * 用法（★ 别抢 5173，自起端口）：
 *   pnpm --filter @wowpvp/client dev -- --port 5199
 *   node scripts/profile-stress.mjs --out scripts/_profile-p4-before.json
 *   （改完之后）
 *   node scripts/profile-stress.mjs --baseline scripts/_profile-p4-before.json
 *
 * 参数：
 *   --url <base>       默认 $VERIFY_URL 或 http://localhost:5173
 *   --path <query>     默认 `/?stress`（24 实体 + 美术素材；`&art=off` 会关掉
 *                      模型与骨骼动画，那正是本批要量的东西，别顺手加）
 *   --seconds <n>      采样秒数，默认 20
 *   --warmup <n>       采样前的预热秒数，默认 8（模型是异步加载的，不等它
 *                      profile 里会全是 GLTF 解析）
 *   --viewport <WxH>   画布尺寸，默认 640x360（见上面的 ⚠️★★）
 *   --top <n>          每张表列几行，默认 20
 *   --interval <µs>    采样间隔，默认 200
 *   --out <file>       把聚合结果写成 JSON（供下次 --baseline 对比）
 *   --baseline <file>  与上一轮对比，逐行打印增减
 */

import { chromium } from 'playwright';
import { writeFileSync, readFileSync } from 'node:fs';

// ── 参数 ──────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const BASE = arg('url', process.env.VERIFY_URL ?? 'http://localhost:5173');
const PATH = arg('path', '/?stress');
const SECONDS = Number(arg('seconds', 20));
const WARMUP = Number(arg('warmup', 8));
const TOP = Number(arg('top', 20));
const [VW, VH] = arg('viewport', '640x360').split('x').map(Number);
const INTERVAL_US = Number(arg('interval', 200));
const OUT = arg('out', undefined);
const BASELINE = arg('baseline', undefined);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ms = (v) => `${v.toFixed(2)}ms`;

// ── 分桶 ──────────────────────────────────────────────────────────
/**
 * 一个调用帧属于哪个桶。★ 判据只看 url，不看函数名 —— 函数名会撞
 * （我们和 three 都有 `update`），而 url 是唯一的。
 */
const bucketOf = (frame) => {
  const url = frame.url ?? '';
  const fn = frame.functionName ?? '';
  if (fn === '(idle)') return 'idle';
  /**
   * ⚠️ 没有 url 的不止 swiftshader：`get clientWidth`、`set innerHTML` 这类
   *   **DOM 原生** 也落这里（它们是我们自己招来的开销）。所以「引擎/原生」这张表
   *   不下结论，DOM 那部分由归因视图算到调用它的那个函数头上。
   */
  if (!url) return 'engine'; // (program) / (garbage collector) / 原生栈
  /**
   * ★ vite dev 把 three 预打包成 `node_modules/.vite/deps/chunk-*.js` ——
   *   url 里根本没有 "three" 这个词，按包名认会一条都认不出来（首轮实测
   *   three 桶恒为 0）。判据改成「在 node_modules 里就是库」。
   */
  if (url.includes('node_modules')) return 'lib';
  // vite dev 把工作区包按真实路径喂出来（/@fs/…/packages/shared/…）
  if (/\/packages\/(client|shared|server)\//.test(url) || /\/src\//.test(url)) return 'ours';
  return 'other';
};

/**
 * ★★ 归因的**止损点**：three 的 `WebGLRenderer.render` 子树不算在调用方头上。
 *
 *   它是「把这一帧提交给 GL」的那一大坨，在 swiftshader 下会把 `draw()` 的归因
 *   撑到 15ms/帧，而那 15ms 里没有一毫秒是 P4 能改的东西 —— 留着它，前后对比
 *   的主判据就被一个我们不控制、且方差极大的量淹没。
 *   它单列成一行 `[three] 渲染提交`，看得见但不混进我们的账。
 */
const isRenderSink = (frame) =>
  (frame.url ?? '').includes('node_modules') &&
  /(^|\.)render$/.test(frame.functionName ?? '');

/**
 * 库桶里再分一层「这笔钱是谁点的菜」。
 * ★ 只是给人看的归类提示，不参与判据 —— 真正的归属由归因视图给。
 */
const threeKindOf = (fn) => {
  if (/Skinned|Skeleton|bone|Bone/.test(fn)) return '蒙皮';
  if (/Animation|PropertyMixer|PropertyBinding|Interpolant|KeyframeTrack|mixer/i.test(fn)) return '动画';
  if (/WebGL|render|Program|Shader|Uniform|Texture|Buffer|State/i.test(fn)) return '渲染';
  if (/Matrix|Vector|Quaternion|Euler|Object3D|updateMatrix|Frustum|Ray/i.test(fn)) return '数学/场景图';
  return '其他';
};

/** 函数的显示名：`文件:行 函数名`。文件名只留最后两段，够认人又不刷屏 */
const labelOf = (frame) => {
  const fn = frame.functionName || '(匿名)';
  const url = frame.url ?? '';
  if (!url) return fn;
  const clean = url.split('?')[0];
  const parts = clean.split('/').filter(Boolean);
  const file = parts.slice(-2).join('/');
  return `${fn} @ ${file}:${(frame.lineNumber ?? 0) + 1}`;
};

// ── 聚合 ──────────────────────────────────────────────────────────
/**
 * 把 CDP 的 profile 折成两张表：self time 排行 + 归因排行。
 *
 * ⚠️★★ **self 时间按「采样条数 × 名义间隔」算，刻意不用 `timeDeltas`。**
 *
 *   直觉上 `timeDeltas` 更准（它是真实间隔），首版就是那么写的 —— 结果一眼假：
 *   `generateTorso`（`CapsuleGeometry` 的构造，**只在 CharacterView 创建时跑一次**）
 *   在一个 25 秒的稳态窗口里报出 232ms。原因是 swiftshader 下主线程会整段
 *   卡在同步 GL 调用里（单帧 400ms+），那期间采样器**一条都采不到**，
 *   恢复后的第一条采样于是背上了整个空档的 delta —— 谁倒霉谁背锅，
 *   而背锅的函数看起来就是个热点。
 *   按条数算的话「没采到」就是没采到，不会凭空造出热点。代价是绝对毫秒数
 *   偏低（阻塞时间不计入任何人），而**我们本来就只看相对降幅**。
 */
const aggregate = (profile, frames, intervalUs) => {
  const byId = new Map();
  for (const n of profile.nodes) byId.set(n.id, n);

  const parent = new Map();
  for (const n of profile.nodes) {
    for (const c of n.children ?? []) parent.set(c, n.id);
  }

  /** 每个节点的 self 微秒数 = 落在它身上的采样条数 × 名义间隔（见函数头 ⚠️★★）*/
  const selfUs = new Map();
  const { samples = [] } = profile;
  for (const id of samples) selfUs.set(id, (selfUs.get(id) ?? 0) + intervalUs);

  /**
   * 节点 → 栈上最近的「我们的」节点（含自身）。
   * 返回 `RENDER_SINK` = 落在 `WebGLRenderer.render` 子树里；null = 不在我们的栈里。
   */
  const RENDER_SINK = '__render__';
  const nearestOursCache = new Map();
  const nearestOurs = (id) => {
    if (nearestOursCache.has(id)) return nearestOursCache.get(id);
    const node = byId.get(id);
    let result = null;
    if (node) {
      if (bucketOf(node.callFrame) === 'ours') result = id;
      else if (isRenderSink(node.callFrame)) result = RENDER_SINK;
      else {
        const p = parent.get(id);
        result = p !== undefined ? nearestOurs(p) : null;
      }
    }
    nearestOursCache.set(id, result);
    return result;
  };

  const buckets = { ours: 0, lib: 0, engine: 0, other: 0, idle: 0 };
  const selfByLabel = new Map();
  const attrByLabel = new Map();
  let attributedOutside = 0;

  for (const [id, us] of selfUs) {
    const node = byId.get(id);
    if (!node) continue;
    const b = bucketOf(node.callFrame);
    buckets[b] += us;
    if (b === 'idle') continue;

    const label = labelOf(node.callFrame);
    const key = `${b} ${label}`;
    const prev = selfByLabel.get(key);
    if (prev) prev.us += us;
    else {
      selfByLabel.set(key, {
        us, bucket: b, label,
        kind: b === 'lib' ? threeKindOf(node.callFrame.functionName ?? '') : '',
      });
    }

    const owner = nearestOurs(id);
    if (owner === null) { attributedOutside += us; continue; }
    const ownerLabel = owner === RENDER_SINK
      ? '[three] 渲染提交 WebGLRenderer.render'
      : labelOf(byId.get(owner).callFrame);
    const a = attrByLabel.get(ownerLabel);
    if (a) { a.us += us; if (owner === id) a.selfUs += us; }
    else {
      attrByLabel.set(ownerLabel, {
        us, selfUs: owner === id ? us : 0, label: ownerLabel, sink: owner === RENDER_SINK,
      });
    }
  }

  const totalUs = Object.values(buckets).reduce((s, v) => s + v, 0);
  const busyUs = totalUs - buckets.idle;
  const oursAttributedUs = [...attrByLabel.values()]
    .filter((v) => !v.sink).reduce((s, v) => s + v.us, 0);

  return {
    frames,
    samples: samples.length,
    wallMs: (profile.endTime - profile.startTime) / 1000,
    totalMs: totalUs / 1000,
    busyMs: busyUs / 1000,
    idleMs: buckets.idle / 1000,
    buckets: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v / 1000])),
    /** ★ 主判据：我们的 JS（含它调用的库）每帧多少毫秒 */
    oursSelfPerFrame: frames > 0 ? buckets.ours / 1000 / frames : 0,
    oursAttributedPerFrame: frames > 0 ? oursAttributedUs / 1000 / frames : 0,
    attributedOutsideMs: attributedOutside / 1000,
    self: [...selfByLabel.values()]
      .map((e) => ({ ...e, ms: e.us / 1000, perFrame: frames > 0 ? e.us / 1000 / frames : 0 }))
      .sort((a, b) => b.us - a.us),
    attributed: [...attrByLabel.values()]
      .map((e) => ({ ...e, ms: e.us / 1000, perFrame: frames > 0 ? e.us / 1000 / frames : 0 }))
      .sort((a, b) => b.us - a.us),
  };
};

// ── 打印 ──────────────────────────────────────────────────────────
const pct = (v, total) => (total > 0 ? `${((v / total) * 100).toFixed(1)}%` : '—');

const printTable = (title, rows, busyMs, note) => {
  console.log(`\n${title}`);
  if (note) console.log(`  ${note}`);
  if (rows.length === 0) { console.log('  （空）'); return; }
  const w = Math.max(...rows.map((r) => r.label.length), 10);
  for (const [i, r] of rows.entries()) {
    const tag = r.kind ? ` [${r.kind}]` : '';
    console.log(
      `  ${String(i + 1).padStart(2)}. ${r.label.padEnd(Math.min(w, 78))}` +
      `  ${ms(r.ms).padStart(10)}  ${pct(r.ms, busyMs).padStart(6)}` +
      `  ${r.perFrame.toFixed(3)}ms/帧${tag}`,
    );
  }
};

// ── 主流程 ────────────────────────────────────────────────────────
/**
 * ★ 除了 verify 脚本那两个 swiftshader 开关，这里再关掉垂直同步与帧率上限：
 *   软渲染下主线程一帧要卡在同步 GL 调用里几百毫秒，vsync 还要再叠一层等待 ——
 *   等待期间一条采样都出不来，窗口里的有效样本会少一大半。
 */
const LAUNCH_ARGS = [
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
  '--disable-gpu-vsync', '--disable-frame-rate-limit',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
];

const browser = await (async () => {
  try {
    return await chromium.launch({ args: LAUNCH_ARGS });
  } catch {
    for (const channel of ['msedge', 'chrome']) {
      try { return await chromium.launch({ channel }); } catch { /* 试下一个 */ }
    }
    throw new Error('没有可用浏览器');
  }
})();

let result;
try {
  const page = await browser.newPage({ viewport: { width: VW, height: VH } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  /**
   * 帧数计数器。★ 主判据是「每帧毫秒」，所以必须精确知道窗口里跑了几帧 ——
   * 面板上的 fps 是 3 秒滚动平均，用它换算会带上窗口边界误差。
   * 包一层 rAF 的开销是一次闭包调用，相对 swiftshader 的一帧 200ms 可以忽略。
   */
  await page.addInitScript(() => {
    globalThis.__rafFrames = 0;
    const orig = globalThis.requestAnimationFrame.bind(globalThis);
    globalThis.requestAnimationFrame = (cb) =>
      orig((t) => { globalThis.__rafFrames++; return cb(t); });
  });

  const url = `${BASE}${PATH}`;
  console.log(`剖析目标：${url}`);
  console.log(`预热 ${WARMUP}s → 采样 ${SECONDS}s（间隔 ${INTERVAL_US}µs）`);
  await page.goto(url);
  await sleep(WARMUP * 1000);

  /**
   * ★★ 预热之后必须确认**模型真的挂上了**。骨骼动画是本批要量的头号嫌疑人，
   *   而模型是异步加载的、加载失败会静默回落成胶囊体（`CharacterView` 的
   *   逐层兜底）—— 那种情况下 `mixer` 压根不存在，profile 里一根骨头都看不到，
   *   而报告会显得「骨骼动画不是热点」。那不是结论，那是没测到。
   */
  const info = await page.evaluate(`(() => {
    const el = document.getElementById('stats');
    const s = globalThis.__scene;
    const a = s && s.artStatus;
    return {
      panel: el ? el.textContent.replace(/\\s+/g, ' ').trim() : '',
      has: !!s,
      art: a ? a.art : undefined,
      withModel: a ? a.charactersWithModel : -1,
      total: a ? a.charactersTotal : -1,
      lod: a ? a.animLod : undefined,
    };
  })()`);
  if (!info.has) throw new Error(`场景没起来（面板：${info.panel || '空'}）—— dev server 跑在 ${BASE} 吗？`);
  console.log(`预热完成：${info.panel.slice(0, 72)}`);
  console.log(`美术：art=${info.art} · 已挂模型 ${info.withModel}/${info.total} 个角色`);
  if (info.withModel <= 0) {
    console.log('⚠️★★ 一个模型都没挂上 —— 这一轮**量不到骨骼动画**，别拿它下 LOD 的结论' +
      '（检查 assets/art/models/chars 与 --path 有没有误带 art=off，或把 --warmup 调大）');
  }
  /**
   * ★★ 骨骼分级的实况直方图。分级失效是零症状的（`strideFor` 恒返回 1 时
   *   画面一模一样、测试全绿、性能悄悄退回原样），这一行是它唯一的哨兵。
   */
  const lod = info.lod;
  if (lod) {
    const graded = lod.half + lod.third + lod.offscreen;
    console.log(`骨骼分级：每帧 ${lod.full} · 半频 ${lod.half} · 三分频 ${lod.third}` +
      ` · 视锥外 ${lod.offscreen}（降频 ${graded}/${lod.full + graded} 个实体）`);
    if (graded === 0) {
      console.log('⚠️★★ 一个实体都没被降频 —— 要么镜头贴脸（把镜头拉远再采），' +
        '要么 EntityLod 接线断了。这一轮量到的不是分级后的成本。');
    }
  }

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: INTERVAL_US });

  const framesBefore = await page.evaluate('globalThis.__rafFrames');
  await cdp.send('Profiler.start');
  await sleep(SECONDS * 1000);
  const { profile } = await cdp.send('Profiler.stop');
  const framesAfter = await page.evaluate('globalThis.__rafFrames');

  const panel = await page.evaluate(
    `document.getElementById('stats').textContent.replace(/\\s+/g, ' ').trim()`,
  );

  result = aggregate(profile, framesAfter - framesBefore, INTERVAL_US);
  result.meta = {
    url, seconds: SECONDS, intervalUs: INTERVAL_US,
    panel, errors: errors.slice(0, 3), at: new Date().toISOString(),
  };
} finally {
  await browser.close();
}

// ── 报告 ──────────────────────────────────────────────────────────
const b = result.buckets;
console.log(`\n${'─'.repeat(78)}`);
console.log(`采样窗口 ${result.wallMs.toFixed(0)}ms · ${result.frames} 帧` +
  `（${(result.frames / (result.wallMs / 1000)).toFixed(1)} fps）· ${result.samples} 条采样`);
console.log(`面板：${result.meta.panel.slice(0, 66)}`);
console.log(`采到的忙时 ${ms(result.busyMs)}（idle ${ms(result.idleMs)}）` +
  ` —— 只占窗口 ${pct(result.totalMs, result.wallMs)}，差额是主线程卡在同步 GL 里采不到样的时间`);
console.log('\n分桶（占忙时）：');
console.log(`  我们的 JS      ${ms(b.ours).padStart(10)}  ${pct(b.ours, result.busyMs).padStart(6)}` +
  `  ${result.oursSelfPerFrame.toFixed(3)}ms/帧   ← ★ 结论只对这一桶下`);
console.log(`  库（three 等） ${ms(b.lib).padStart(10)}  ${pct(b.lib, result.busyMs).padStart(6)}`);
console.log(`  引擎/原生      ${ms(b.engine).padStart(10)}  ${pct(b.engine, result.busyMs).padStart(6)}` +
  '   ← swiftshader + GC + DOM 原生混在一起，不下结论');
console.log(`  其他           ${ms(b.other).padStart(10)}  ${pct(b.other, result.busyMs).padStart(6)}`);
console.log(`\n★★ 主判据 —— 我们的每帧路径（含它调用的库与 DOM，剔除 three 渲染提交）：` +
  `${result.oursAttributedPerFrame.toFixed(3)}ms/帧`);

printTable(
  `【表一】我们的 JS —— self time top ${TOP}`,
  result.self.filter((r) => r.bucket === 'ours').slice(0, TOP),
  result.busyMs,
  '这是「我们自己的代码在算什么」。P4 的改动要能在这张表上看见。',
);
printTable(
  `【表二】库（three.js 等）—— self time top ${TOP}`,
  result.self.filter((r) => r.bucket === 'lib').slice(0, TOP),
  result.busyMs,
  '★ 它们的调用次数由我们决定（mixer.update / render）—— 该改的是调用方，不是库。',
);
printTable(
  `【表三】引擎/原生 —— self time top ${Math.min(TOP, 10)}`,
  result.self.filter((r) => r.bucket === 'engine' || r.bucket === 'other').slice(0, Math.min(TOP, 10)),
  result.busyMs,
  '⚠️ swiftshader 把 GPU 的活搬到了 CPU，这张表在真机上完全不同 —— 不下结论。',
);
printTable(
  `【表四】归因 top ${TOP}（我们的函数 ＋ 它调用的库）`,
  result.attributed.slice(0, TOP),
  result.busyMs,
  '★★ 前后对比看这张：它包含 mixer.update / DOM 写入这些「名义上在别人家」的开销。',
);

if (result.meta.errors.length) {
  console.log(`\n⚠️ 页面报错：${result.meta.errors.join(' | ')}`);
}

// ── 与基线对比 ────────────────────────────────────────────────────
if (BASELINE) {
  const old = JSON.parse(readFileSync(BASELINE, 'utf8'));
  const delta = (now, then) => {
    if (then === 0) return '  —';
    const d = ((now - then) / then) * 100;
    return `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`;
  };
  console.log(`\n${'─'.repeat(78)}`);
  console.log(`与基线对比（${BASELINE}，采于 ${old.meta?.at ?? '?'}）`);
  console.log(`  帧数            ${old.frames} → ${result.frames}`);
  console.log(`  我们的 JS/帧    ${old.oursSelfPerFrame.toFixed(3)} → ` +
    `${result.oursSelfPerFrame.toFixed(3)} ms   ${delta(result.oursSelfPerFrame, old.oursSelfPerFrame)}`);
  console.log(`  ★ 归因/帧      ${old.oursAttributedPerFrame.toFixed(3)} → ` +
    `${result.oursAttributedPerFrame.toFixed(3)} ms   ${delta(result.oursAttributedPerFrame, old.oursAttributedPerFrame)}`);

  /**
   * ★★ 配对的键**去掉行号**。
   *
   *   标签里带 `:行号` 的话，任何一次改动都会让被改文件的每一行在对比表里
   *   变成「旧的 -100% + 新的一行」—— 而那正是本脚本要用来量改动效果的表，
   *   一改就失灵等于没有。函数名 + 文件名足够定位，行号只是给人翻代码用的。
   */
  const keyOf = (label) => label.replace(/:\d+$/, '');
  const oldAttr = new Map(old.attributed.map((r) => [keyOf(r.label), r.perFrame]));
  const rows = result.attributed.slice(0, TOP).map((r) => ({
    label: keyOf(r.label), now: r.perFrame, then: oldAttr.get(keyOf(r.label)) ?? 0,
  }));
  // 基线里有、现在掉出榜的（= 被砍掉的那些）也要列出来，否则「省掉的」看不见
  for (const r of old.attributed.slice(0, TOP)) {
    if (!rows.some((x) => x.label === keyOf(r.label))) {
      const now = result.attributed.find((x) => keyOf(x.label) === keyOf(r.label));
      rows.push({ label: keyOf(r.label), now: now?.perFrame ?? 0, then: r.perFrame });
    }
  }
  console.log('\n归因逐行（ms/帧）：');
  const w = Math.max(...rows.map((r) => r.label.length), 10);
  for (const r of rows.sort((a, b) => (b.then - b.now) - (a.then - a.now))) {
    console.log(`  ${r.label.padEnd(Math.min(w, 78))}  ${r.then.toFixed(3)} → ${r.now.toFixed(3)}` +
      `   ${delta(r.now, r.then).padStart(8)}`);
  }
}

if (OUT) {
  writeFileSync(OUT, JSON.stringify(result, null, 1));
  console.log(`\n已写入 ${OUT}`);
}
