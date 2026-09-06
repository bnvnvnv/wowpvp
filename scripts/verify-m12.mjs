/**
 * M12 端到端验收：美术与音效。
 *
 * 规格书附录A#5：「素材必须先完成许可清单；未明确授权的图标、模型、音效和字体
 * 不得进入正式包。」附录A#7：「不能用伪代码或占位图冒充完成。」
 *
 * ★★ **这一支与 `verify:m1`–`m10` 的分工是明确的：**
 *
 *   · m1–m10 用 `?art=off` 跑 —— 验的是**规则接线**，画面精确回到 M11，
 *     结论可以与历史直接对比（理由见 client/src/settings/artMode.ts）
 *   · **本脚本用 `?art=on`（默认）跑** —— 验的是美术层本身，以及
 *     docs/13 点名的两条「引入美术后会被挑战的既有保证」：
 *       验收 #10「模型大小不改变碰撞体」
 *       验收 #48「低画质不隐藏关键信息」
 *
 *   docs/13 原话：「这两条都要在 verify:m12 里**重验**，而不是假定
 *   M1/M8 的结论自动延续。」—— 下面 §3 / §4 就是那次重验。
 *
 * 用法：
 *   pnpm dev:client          # 另一个终端
 *   pnpm verify:m12
 */

import { chromium } from 'playwright';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(REPO, 'assets');
const BASE = process.env.VERIFY_URL ?? 'http://localhost:5173/';

const results = [];
const check = (id, name, pass, detail) => {
  results.push({ id, name, pass, detail });
  console.log(`  ${pass ? '✓' : '✗'} ${id} ${name}\n      ${detail}`);
};

// ═══ §1 素材登记（附录A#5 / 验收 #51）═══════════════════════════
console.log('\n── §1 素材许可与登记（附录A#5 / 验收 #51）──');
{
  const license = readFileSync(join(REPO, 'docs/09-asset-license.md'), 'utf8');

  // 1a：assets/ 下每个顶层包在 docs/09 §4 登记表里有行
  const topDirs = existsSync(ASSETS)
    ? readdirSync(ASSETS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    : [];
  const unregistered = topDirs.filter(
    (d) => d !== 'local' && !license.includes(`assets/${d}/**`),
  );
  check(
    '#51a', '★ assets/ 下每个顶层包都在 docs/09 §4 登记',
    topDirs.length > 0 && unregistered.length === 0,
    topDirs.length === 0
      ? 'assets/ 不存在或为空 —— 素材目录是可选的，但本脚本需要它'
      : `已登记 ${topDirs.filter((d) => d !== 'local').length} 个：${topDirs.join(', ')}` +
        (unregistered.length ? `；★未登记：${unregistered.join(', ')}` : ''),
  );

  // 1b：来源清单存在且指向真实上游
  const sourceMd = join(ASSETS, 'SOURCE.md');
  const hasSource = existsSync(sourceMd) && readFileSync(sourceMd, 'utf8').includes('github.com');
  check('#51b', '来源清单 assets/SOURCE.md 存在且记录了上游 URL', hasSource,
    hasSource ? 'SOURCE.md 含 GitHub 上游与下载日期' : '缺少 assets/SOURCE.md');

  // 1c：T1 硬边界 —— assets/local/ 不得入库（docs/09 §0.2）
  let trackedLocal;
  try {
    trackedLocal = execFileSync('git', ['ls-files', 'assets/local'], { cwd: REPO }).toString().trim();
  } catch { trackedLocal = ''; }
  check('#51c', '★ T1 边界：assets/local/ 没有被 git 跟踪', trackedLocal === '',
    trackedLocal === '' ? 'assets/local 无跟踪文件（符合 docs/09 §0.2）'
      : `★ 违规入库：${trackedLocal.split('\n').length} 个文件`);

  /**
   * 1d：不含暴雪资产（docs/09 §2 硬禁止）—— 按路径名启发式扫描。
   *
   * ⚠️ **`blizzard` 不能作为禁词。** 它同时是法师技能「暴风雪」的英文名，
   *   而 `ui/skills/mage/blizzard.webp` 是一张完全合规的原创图标。
   *   本脚本第一次跑就被它误报 —— 而一条会误报的红线比没有红线更糟：
   *   下一个人看到它变红，学到的是「这条可以忽略」。
   *   所以只留**指向暴雪产品本身**的词，宁可漏也不误报
   *   （真正的兜底是 docs/09 §4 的逐包登记与人工复核）。
   */
  const banned = /warcraft|world[-_]?of[-_]?warcraft|blizzard[-_]?(ent|entertainment)|wow[-_]?(client|mpq)|\.mpq$/i;
  const walk = (dir, out = []) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (banned.test(p)) out.push(p);
    }
    return out;
  };
  const hits = existsSync(ASSETS) ? walk(ASSETS) : [];
  check('#51d', '硬禁止项启发式扫描（暴雪资产）', hits.length === 0,
    hits.length === 0 ? '未发现可疑路径名' : `命中 ${hits.length} 条：${hits.slice(0, 3).join(', ')}`);
}

// ═══ §2 技能图标映射（15.2 / 17.2）════════════════════════════
/**
 * ★ 期望条数**从职业数据里数出来**，不再写死。
 *
 *   这个魔数过期过两次：M14 删掉猎人「自动射击」按钮技能（91→90）时漏改，
 *   M15 回归才补上；P3b 给八职业补了 22 个技能，它又红了一次 —— 而两次
 *   红灯都与「图标有没有断链」无关，纯粹是常量没跟上。写死的期望值在一个
 *   还在加技能的仓库里，只会周期性地制造假红灯。
 *
 * ⚠️ 分工：「每个技能都有图标行」「同职业不重图标」由
 *   `skillIconMap.test.ts` 用**真 import** 严格覆盖（那里才拿得到 SkillId
 *   类型）。本脚本独有的价值是**图标文件在不在磁盘上** —— 单测碰不到
 *   文件系统，断链只有这里能发现。
 */
console.log('\n── §2 技能图标：全职业技能全覆盖，无断链 ──');
{
  /**
   * ★ 期望口径 = **装备得上技能栏**的技能（skillIconMap.test.ts 的
   *   EQUIPPABLE_SKILLS 镜像）：八个可选职业 + 派对武装授予技（party.ts）。
   *   boss.ts 刻意排除 —— BOSS 是 AI 专用职业，技能永远不进玩家技能栏，
   *   不给图标是 data/index.ts 注释里写明的边界，不是漏配。
   *   （2026-08-10 修正：旧口径把 boss 数进去、把派对漏掉，124 vs 122 的红
   *   曾被误判成模型加载时序偶发 —— 验收红的第一嫌疑人永远是验收自己。）
   */
  const CLASS_DIR = join(REPO, 'packages/shared/src/data/classes');
  const countIds = (path) => [...readFileSync(path, 'utf8')
    .matchAll(/id:\s*asSkillId\('[a-z]+\.[a-z_0-9]+'\)/g)].length;
  const expected = readdirSync(CLASS_DIR)
    .filter((f) => f.endsWith('.ts') && !f.includes('.test.') && f !== 'boss.ts')
    .reduce((n, f) => n + countIds(join(CLASS_DIR, f)), 0)
    + countIds(join(REPO, 'packages/shared/src/data/party.ts'));

  const mapSrc = readFileSync(join(REPO, 'packages/client/src/hud/skillIconMap.ts'), 'utf8');
  const pairs = [...mapSrc.matchAll(/'([a-z]+\.[a-z_0-9]+)':\s*'([^']+)'/g)];
  const broken = pairs.filter(
    ([, , file]) => !existsSync(join(ASSETS, 'art/ui/skills', `${file}.webp`)),
  );
  check('#12a', '★ 映射表里每个技能的图标文件都存在（无断链）',
    pairs.length === expected && broken.length === 0,
    `映射 ${pairs.length} 条（职业数据里共 ${expected} 个技能），断链 ${broken.length} 条` +
      (broken.length ? `：${broken.slice(0, 3).map((b) => b[1]).join(', ')}` : ''));
}

// ═══ §2.5 八属性粒子贴图（14.2）════════════════════════════════
console.log('\n── §2.5 14.2 八属性粒子特效：登记的贴图全部在库且被引用 ──');
{
  const src = readFileSync(join(REPO, 'packages/client/src/vfx/particleTextures.ts'), 'utf8');
  // 从 VFX_TEXTURE_FILES 数组里抽出登记的文件名
  const arr = src.match(/VFX_TEXTURE_FILES\s*=\s*\[([\s\S]*?)\]/);
  const registered = arr ? [...arr[1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]) : [];

  // 磁盘上 assets/art/vfx/ 的实际 png
  const vfxDir = join(ASSETS, 'art/vfx');
  const onDisk = existsSync(vfxDir)
    ? readdirSync(vfxDir).filter((f) => f.endsWith('.png')).map((f) => f.replace(/\.png$/, ''))
    : [];

  // ★ 不写死张数：三期从 16 扩到 22，钉「登记 ↔ 磁盘一一对应」才是不变量
  const missing = registered.filter((n) => !onDisk.includes(n));
  check('#14a', '★ 登记的每张 vfx 贴图都在 assets/art/vfx/ 里（无断链）',
    registered.length > 0 && missing.length === 0,
    `登记 ${registered.length} 张，断链 ${missing.length}`
      + (missing.length ? `：${missing.join(', ')}` : ''));

  // 磁盘上没有一张是「在库却没登记 → 素材在手却没用」
  const orphan = onDisk.filter((n) => !registered.includes(n));
  check('#14b', '★ 素材在手都用上了：assets/art/vfx/ 没有未被引用的孤儿贴图',
    orphan.length === 0,
    orphan.length === 0 ? `${onDisk.length} 张全部被 particleTextures.ts 引用`
      : `★ 未引用：${orphan.join(', ')}`);

  // 八属性各有一张主粒子（PARTICLE_TEXTURE 恰好 8 项）
  const pt = src.match(/PARTICLE_TEXTURE[\s\S]*?=\s*\{([\s\S]*?)\}/);
  const particleEntries = pt ? [...pt[1].matchAll(/(\w+):\s*'([a-z0-9_]+)'/g)] : [];
  check('#14c', '八属性各有一张主粒子贴图（PARTICLE_TEXTURE 8 项）',
    particleEntries.length === 8,
    `PARTICLE_TEXTURE 映射 ${particleEntries.length} 项（应为 8）`);
}

// ═══ 浏览器部分 ═══════════════════════════════════════════════
/**
 * 捆绑 chromium 优先；装不上时退回系统 Edge / Chrome。
 * ★ 回落只换浏览器**载体**，下面每一条断言原样不动 —— 本机网络拉不动
 *   Playwright CDN 时，「跑不起来的验收」等于没有验收。
 *   （swiftshader 参数只给捆绑 chromium：系统浏览器带真 GPU，不需要也不认它）
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

/** 开一页并等到场景装配完成（美术是异步加载的，要给它时间） */
const open = async (url, settleMs = 14000) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  // This suite compares high with low; the player-facing default is independently configurable.
  await page.addInitScript(() => {
    localStorage.setItem('wowpvp.graphics.v1', JSON.stringify({
      quality: 'high', frameRate: 60, adaptiveResolution: false,
    }));
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(settleMs);
  return { page, errors };
};

const artStatus = (page) => page.evaluate(() => globalThis.__scene?.artStatus);

/**
 * 按**技能 id** 找到技能栏下标再按数字键。
 * ★ 不写死槽位：`PLAYER_SKILL_IDS` 调过一次顺序，写死下标会静默地验错技能。
 */
const pressSkill = async (page, skillId) => {
  const slot = await page.evaluate(
    (id) => globalThis.__scene?.combat?.skills?.findIndex((s) => s.id === id) ?? -1,
    skillId,
  );
  if (slot < 0) return false;
  await page.keyboard.press(`Digit${slot + 1}`);
  return true;
};

/**
 * 反复按 Tab 直到硬目标是指定的假人。
 * ★ Tab 是**循环**选择不是「选中它」—— 多按一次就换人了。
 *   （这条注释是拿一次假失败换来的：验护盾承伤时多按了一个 Tab，
 *   火焰冲击打到了没有盾的牧师身上。）
 */
const tabUntil = async (page, namePart, tries = 6) => {
  for (let i = 0; i < tries; i++) {
    const ok = await page.evaluate((n) => {
      const s = globalThis.__scene;
      const t = s.combat.player.targets?.hard;
      const u = s.combat.visibleUnits().find((e) => e.id === t);
      return !!u && u.name.includes(n);
    }, namePart);
    if (ok) return true;
    await page.keyboard.press('Tab');
    await page.waitForTimeout(250);
  }
  return false;
};

/**
 * 等某个技能转好冷却再按。
 * ★ 霜爆新星 18 秒冷却，而本脚本要按它两次（高画质一次、低画质一次）——
 *   不等就会静默地验到一次「没放出来」，而失败原因看起来像是特效没画。
 *   宁可脚本慢十几秒，也不要一条会骗人的断言。
 */
const waitSkillReady = async (page, skillId, timeoutMs = 22000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await page.evaluate((id) => {
      const s = globalThis.__scene;
      return (s.combat.player.cooldowns.get(id) ?? 0) <= s.combat.world.time;
    }, skillId);
    if (ready) return true;
    await page.waitForTimeout(500);
  }
  return false;
};

/**
 * 在**页面内**用 rAF 连续采样一段时间，返回这段窗口里几个计数的峰值。
 *
 * ★★ 为什么不能从外面轮询（这条是拿一次假失败换来的）：地面波只活 0.35 秒，
 *   而每次 `page.evaluate` 往返约 250ms —— 外部轮询会随机漏掉整个波，
 *   报出来的现象是「groundWaves 一直是 0」，看起来像特效没画，
 *   实际上战斗日志里明明白白写着「霜爆新星 命中 1 个目标」。
 *   用法：**先挂监视器、再按键**，采样全程在页面内完成。
 */
const watchPeaks = (page, ms = 2500) =>
  page.evaluate(async (dur) => {
    const until = performance.now() + dur;
    const peak = { waves: 0, windups: 0, streams: 0 };
    while (performance.now() < until) {
      await new Promise((r) => requestAnimationFrame(r));
      const a = globalThis.__scene?.artStatus;
      peak.waves = Math.max(peak.waves, a?.vfx?.groundWaves ?? 0);
      peak.windups = Math.max(peak.windups, a?.vfx?.activeWindups ?? 0);
      peak.streams = Math.max(peak.streams, a?.vfx?.streamBursts ?? 0);
    }
    return peak;
  }, ms);

/** 在 timeoutMs 内轮询 artStatus，直到 pred 成立。返回命中与最后一次快照 */
const pollArt = async (page, pred, timeoutMs = 2500) => {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await artStatus(page);
    if (last && pred(last)) return { hit: true, st: last };
    await page.waitForTimeout(80);
  }
  return { hit: false, st: last };
};

// ═══ §3 验收 #10 重验：模型大小不改变碰撞体 ═══════════════════
console.log('\n── §3 验收 #10 重验：真实模型不改变碰撞体（docs/13 点名）──');
// P6：试验场从默认路径迁到 ?testbed（主菜单占了默认位），测试内容零变化
const { page, errors } = await open(`${BASE}?testbed`);
{
  /**
   * ★★ **这里必须轮询，不能开页就采样一次。**
   *
   *   角色模型是异步加载的：`--use-gl=swiftshader` 软件渲染下实测要 ~17 秒
   *   才挂上第一个模型（8 个职业 GLB 各约 450KB，还要等 Vite 首次转译）。
   *   开页即采样等于在测「页面加载有多快」，而这条要测的是
   *   「**美术到底接没接进来**」—— 两回事。
   *
   *   代价是真实的：这条曾经在**干净的 HEAD 上三跑两红**，
   *   #12b/#10-m12/#15a 一起假红。一个会对着无辜代码亮红灯的验收脚本，
   *   下一次真回归来的时候没有人会信它。
   *   ★ 本文件早就有 `pollArt` 了（下面 #14b 等都在用），这条只是漏用。
   */
  const MODEL_LOAD_MS = 30000;
  const { st } = await pollArt(
    page, (s) => s.art === true && (s.charactersWithModel ?? 0) > 0, MODEL_LOAD_MS,
  );

  check('#12b', '美术已实际接入（不是占位图 —— 附录A#7）',
    st?.art === true && st.charactersWithModel > 0,
    st ? `${st.charactersWithModel}/${st.charactersTotal} 个角色挂上真实模型，`
       + `环境贴图=${st.envLoaded}，地面材质=${st.groundTextured}` : '读不到 __scene.artStatus');

  /**
   * ★★ 这是本脚本最重要的一条。
   *   八个职业的源模型建模比例各不相同（野蛮人比法师宽一圈）。
   *   13.2 / 验收 #10 要求「不能因模型胖瘦获得命中优势」——
   *   sim 侧由 `GEOMETRY` 常量结构性保证，**视觉侧**则要求
   *   每个模型都归一化到同一个身高，否则玩家看到的是大小不一的靶子。
   */
  const heights = st?.modelHeights ?? [];
  const target = st?.hitbox.height ?? 0;
  const maxDev = heights.length ? Math.max(...heights.map((h) => Math.abs(h - target))) : Infinity;
  check('#10-m12', '★★ 全部职业模型的视觉身高统一到 HITBOX_HEIGHT',
    heights.length > 0 && maxDev < 0.01,
    heights.length
      ? `碰撞体高 ${target} m；${heights.length} 个模型实测 `
        + `[${heights.map((h) => h.toFixed(3)).join(', ')}]，最大偏差 ${maxDev.toFixed(4)} m`
      : '没有已挂载的模型可测');

  /**
   * 真实图标确实被浏览器解码了（不是 404 后的裂图）。
   * ★ 不写死格数：技能栏从 8 格加到 9 格（补了「霜甲护盾」，见 PLAYER_SKILL_IDS）。
   *   真正的不变量是「**每一格**都是真实图标且都解码成功」，与格数无关。
   */
  const icons = await page.$$eval('#skill-bar .sk-img',
    (els) => ({ total: els.length, loaded: els.filter((e) => e.naturalWidth > 0).length }));
  check('#12c', '技能栏每一格都是真实图标且全部解码成功',
    icons.total > 0 && icons.loaded === icons.total,
    `技能栏 ${icons.total} 格为真实图标，其中 ${icons.loaded} 格解码成功`);

  check('#12d', '开启美术后无运行时错误', errors.length === 0,
    errors.length === 0 ? '无' : errors.slice(0, 3).join(' | '));

  /**
   * 14.2：八属性特效子系统在运行时真的把登记的贴图都解码了、八属性全覆盖。
   * ★ 这是「素材在手却没用」被真正补齐的运行时证据 —— 静态检查证明文件在库，
   *   这里证明它们被浏览器加载进了粒子系统。
   */
  check('#14d', '★★ 八属性粒子特效运行时把登记的贴图全部解码、覆盖 8 属性',
    st?.vfx?.texturesLoaded === st?.vfx?.texturesTotal
      && (st?.vfx?.texturesLoaded ?? 0) > 0 && st?.vfx?.attributesCovered === 8,
    st?.vfx
      ? `贴图 ${st.vfx.texturesLoaded}/${st.vfx.texturesTotal} 解码，覆盖 ${st.vfx.attributesCovered} 属性`
      : '读不到 __scene.artStatus.vfx');

  /**
   * ── 14.3 护盾四态 ────────────────────────────────────────────
   * ★★ 这两条盯的是本项目反复出现的那个家族：`flashAbsorb()` / `flashBroken()`
   *   自 M8 定义起**全仓库零调用点**，而试验场里根本没有任何实体能获得
   *   吸收光环 —— 四态一态都没画过，却没有任何断言发现得了。
   *   现在牧师假人每 12 秒给战士套一层盾（可达性），这里盯住
   *   「壳真的画出来了」与「承伤通道真的被调用了」。
   * ★ 顺序在暂停假人**之前** —— 盾是牧师放的，先把它停了就没盾可验。
   */
  /**
   * ★ 验的是**玩家自己的**护盾（第 9 格「霜甲护盾」）。
   *
   *   早先这两条验的是「牧师假人给战士套的盾」—— 那个假人行为已被删除，
   *   因为它让试验场最常用的打击目标永远带盾，打掉了 `verify:m4` 的 M4a。
   *   改成玩家自己的盾之后**更好**：玩家本来就该能看见自己的四态，
   *   而且不再依赖任何假人的定时行为，断言更稳。
   */
  await page.mouse.move(640, 360);
  await pressSkill(page, 'mage.ice_barrier');
  const shellUp = await pollArt(page, (s) => (s.shields?.visible ?? 0) >= 1, 4000);
  check('#14g', '★★ 玩家自己的护盾壳真的画出来了（14.3 四态之「激活」）',
    shellUp.hit && shellUp.st.shields.states.includes('active'),
    shellUp.hit ? `${shellUp.st.shields.visible} 个护盾壳在场，态=[${shellUp.st.shields.states.join(', ')}]`
      : '按下霜甲护盾后 4 秒内没有出现护盾壳');

  /**
   * 承伤闪光：站着让法师假人的霜矢打到自己身上（它每隔几秒就来一发）。
   * ★ 不需要自己出手 —— 吸收发生在**挨打**的一侧。
   */
  // ★ 窗口 9 秒：霜甲护盾本身只有 8 秒，等更久没有意义
  const absorbed = await pollArt(page, (s) => (s.feel?.shieldAbsorbs ?? 0) >= 1, 9000);
  check('#14h', '★★ 护盾「承伤」通道真的被调用（flashAbsorb 首次有断言盯着）',
    absorbed.hit,
    absorbed.hit ? `shieldAbsorbs=${absorbed.st.feel.shieldAbsorbs}`
      : `12 秒内 shieldAbsorbs 仍为 ${absorbed.st?.feel?.shieldAbsorbs}（法师假人应打到你）`);

  /**
   * ── 暂停三个假人，再验施法者与地面表现 ────────────────────────
   *
   * ★★ 为什么必须暂停（拿两条假失败换来的）：
   *   1. 战士假人会拳击打断玩家的霜矢，**并锁住寒冰学派 3 秒** ——
   *      于是紧接着的霜爆新星（冰系）报「无法释放：技能被封锁」。
   *      这不是 bug，正是 7.2 + 7.5 的反制链在按设计工作，
   *      是本脚本的操作序列在和试验场的演示脚本抢同一个玩家。
   *   2. `activeWindups` 是**全场**施法者的计数，牧师与法师假人一直在读条 ——
   *      不停掉它们，「读条期间有法阵」这条断言恒真，等于没验。
   *
   * `pausedDummyClasses` 是 M15 教学就在用的既有机制，不是为验收开的后门。
   */
  await page.evaluate(() => {
    const paused = globalThis.__scene.combat.pausedDummyClasses;
    for (const c of ['warrior', 'priest', 'mage']) paused.add(c);
  });
  /**
   * 等已经挂上的学派锁定自然过期。
   * ★ 5 秒不是保险起见：战士的拳击锁寒冰 3 秒，而上面验护盾承伤时**故意**
   *   站着挨了几发，很可能刚吃过一次打断。锁没过就按霜矢 → 施法直接失败、
   *   `activeWindups` 恒为 0，报出来像「蓄力法阵没画」，其实是压根没开始读条。
   */
  await page.waitForTimeout(5000);

  /**
   * 14.1「预备」：读条**期间全程**有蓄力表现，不是起手闪一下。
   * ★ 这条盯的是一个具体的历史缺陷：`onCast('started')` 只喷一次 6 粒粒子
   *   （活 0.5 秒），而霜矢读 1.4 秒 —— 后面近一秒施法者身上什么都没有。
   *   所以判据是**两次相隔 0.8 秒的采样都还在**，而不是「出现过」。
   */
  // ★ 霜矢是直接目标技能，必须先有硬目标 —— 否则只会记一条「需要目标」，
  //   而 activeWindups=0 看起来像「蓄力法阵没画」（这条就这么假失败过一次）
  await tabUntil(page, '战士');
  await pressSkill(page, 'mage.frostbolt');
  const windup = await pollArt(page, (s) => (s.vfx?.activeWindups ?? 0) >= 1, 1200);
  await page.waitForTimeout(800);
  const stillUp = await artStatus(page);
  // ★ 失败时带上战斗日志：`activeWindups=0` 的真实原因通常是「施法压根没开始」
  //   （学派锁定 / 缺蓝 / 死亡），而那只有日志里看得出来
  const windupLog = await page.evaluate(
    () => (globalThis.__scene?.combat?.log ?? []).slice(0, 3).map((l) => l.text));
  check('#14e', '★ 读条期间**全程**有蓄力法阵（14.1 预备，不是起手一帧）',
    windup.hit && (stillUp?.vfx?.activeWindups ?? 0) >= 1,
    windup.hit
      ? `起手 activeWindups=${windup.st.vfx.activeWindups}，`
        + `0.8 秒后仍为 ${stillUp?.vfx?.activeWindups}`
      : `1.2 秒内没轮询到蓄力法阵（activeWindups=${windup.st?.vfx?.activeWindups}）`
        + `｜日志：${windupLog.join(' / ')}`);
  await page.waitForTimeout(1800); // 等这一发读完，别和下一条抢 GCD

  /**
   * 14.3：瞬发范围技能要画出**真实判定半径**的地面波。
   * ★ 霜爆新星是纯定身技能（无伤害、无弹体），此前只有每目标 12 粒小爆，
   *   地上一点痕迹都没有 —— 用户实测原话「就闪了一下」。
   */
  await waitSkillReady(page, 'mage.frost_nova');
  const waveWatch = watchPeaks(page, 2500); // ★ 先挂监视器再按键，见 watchPeaks
  await pressSkill(page, 'mage.frost_nova');
  const wave = await waveWatch;
  // ★ 失败时把战斗日志一起打出来：这条断言失败过一次，而真正的原因
  //   （先是「无法释放：技能被封锁」，后是采样漏掉）光看计数都查不出来
  const tail = await page.evaluate(
    () => (globalThis.__scene?.combat?.log ?? []).slice(0, 4).map((l) => l.text));
  check('#14f', '★ 瞬发范围技能画出贴地扩张波（边界即判定半径，14.3）',
    wave.waves >= 1,
    wave.waves >= 1 ? `释放后 groundWaves 峰值 ${wave.waves}`
      : `2.5 秒窗口内 groundWaves 峰值仍为 0｜日志：${tail.join(' / ')}`);

  /**
   * 地图装饰摆设（MapDef.decor）真的摆上了 —— 不是登记了数据没人画（附录A#7）。
   *
   * ★ 用**新采样**而不是复用上面那个 `st`：那一份是「第一个角色模型挂上」
   *   那一刻的快照，装饰件比它晚load完（实测常停在 21/23）。复用旧快照
   *   等于拿早了 20 秒的读数去判断「装饰加载完没有」—— 同 #12b 的病根。
   */
  const decorDone = await pollArt(
    page, (s) => (s.decor?.placed ?? 0) > 0 && s.decor?.loaded === s.decor?.placed, 20000,
  );
  const dst = decorDone.st;
  check('#15a', '★ 地图装饰摆设已加载（sim 不读它，docs/06 §8.2 红线不变）',
    (dst?.decor?.placed ?? 0) > 0 && dst?.decor?.loaded === dst?.decor?.placed
      && dst?.decor?.visible === true,
    dst?.decor
      ? `登记 ${dst.decor.placed} 件，加载 ${dst.decor.loaded} 件，当前可见=${dst.decor.visible}`
      : '读不到 __scene.artStatus.decor');
}

// ═══ §4 验收 #48 重验：最低画质仍不隐藏关键信息 ═══════════════
console.log('\n── §4 验收 #48 重验：最低画质下关键信息仍在（docs/13 点名）──');
{
  // F2 从 high 循环到 low
  await page.keyboard.press('F2');
  await page.waitForTimeout(600);
  await page.keyboard.press('F2');
  await page.waitForTimeout(2500);
  const low = await artStatus(page);

  check('#48a', '最低画质确实卸掉了「非关键光照」（14.4 允许减少的）',
    low?.quality === 'low' && low.envLoaded === false,
    `档位=${low?.quality}，环境贴图已卸载=${low?.envLoaded === false}`);

  // 装饰摆设按「环境叶片」档被裁掉（14.4 允许减少的另一项）
  check('#15b', '最低画质下装饰摆设整组隐藏（14.4「环境叶片」档）',
    low?.decor?.visible === false,
    `低画质下装饰可见=${low?.decor?.visible}（应为 false）`);

  /**
   * ★★ 14.4 第二条是否定式的：「**不能隐藏**角色、目标、旗手、
   *   投射物主体、地面真实边界、控制状态、完全免疫和复活保护。」
   *   这里验的是引入美术之后它**仍然**成立 —— 角色模型没有跟着
   *   环境贴图一起被关掉。
   */
  check('#48b', '★★ 最低画质下角色模型仍然全部在场（14.4 不得隐藏角色）',
    low?.charactersWithModel === low?.charactersTotal && (low?.charactersWithModel ?? 0) > 0,
    `${low?.charactersWithModel}/${low?.charactersTotal} 个角色仍挂着模型`);

  // 15.1 四区 + 装备栏在最低画质下一块都不能少
  const zones = ['#party-frame', '#minimap', '#mode-hud', '#skill-bar', '#loadout-panel'];
  const present = [];
  for (const z of zones) present.push([z, await page.$(z) !== null]);
  check('#48c', '最低画质下 HUD 四区 + 装备栏全部仍在',
    present.every(([, v]) => v),
    present.map(([z, v]) => `${z}${v ? '✓' : '✗'}`).join(' '));

  /**
   * ★★ 本轮新增元素有没有偷偷违反 14.4，在这里变成可执行断言。
   *
   * 14.4 允许减装饰、**不允许**减关键信息。本轮加的三样东西各有归属：
   *   · 蓄力法阵   = 关键（「这个人在施法」，7.5 的博弈线索）→ 任何画质都画
   *   · 地面波     = 关键（画的就是这次 AOE 的真实判定半径）  → 任何画质都画
   *   · 细流粒子   = 装饰（拖尾/地面填充/聚能）              → 最低画质应全空
   * 三条同时成立才算数：只验前两条会漏掉「装饰没被砍」，
   * 只验第三条会漏掉「把关键信息一起砍了」。
   */
  await page.mouse.move(640, 360);
  await page.keyboard.press('Tab');
  await page.waitForTimeout(300);
  const lowWindupWatch = watchPeaks(page, 2200);
  await pressSkill(page, 'mage.frostbolt');
  const lowWindup = await lowWindupWatch;
  await page.waitForTimeout(1500);
  await waitSkillReady(page, 'mage.frost_nova');
  const lowWaveWatch = watchPeaks(page, 2500);
  await pressSkill(page, 'mage.frost_nova');
  const lowWave = await lowWaveWatch;
  check('#48d', '★★ 最低画质：法阵与地面波仍在，被减掉的只有装饰细流',
    lowWindup.windups >= 1 && lowWave.waves >= 1
    && lowWindup.streams === 0 && lowWave.streams === 0,
    `法阵峰值 ${lowWindup.windups}（细流 ${lowWindup.streams}）`
    + ` · 地面波峰值 ${lowWave.waves}（细流 ${lowWave.streams}）`);
}
await page.close();

// ═══ §5 回落路径：?art=off 精确回到 M11 ═══════════════════════
console.log('\n── §5 回落路径：素材可选，游戏照常可玩 ──');
{
  const { page: p2, errors: e2 } = await open(`${BASE}?testbed&art=off`, 6000);
  const st = await artStatus(p2);
  check('#12e', '★ ?art=off 完全不加载外部素材，角色回落程序化胶囊体',
    st?.art === false && st.charactersWithModel === 0 && st.envLoaded === false,
    `art=${st?.art}，挂载模型 ${st?.charactersWithModel} 个，环境贴图=${st?.envLoaded}`);

  // ★ 同样不写死格数：验的是「每一格都回落成 SVG」，不是「恰好 8 格」
  const svg = await p2.$$eval('#skill-bar .sk-icon',
    (els) => ({ total: els.length, svg: els.filter((e) => e.tagName.toLowerCase() === 'svg').length }));
  check('#12f', '★ 关闭美术后技能图标每一格都回落程序化 SVG（信息不减一分）',
    svg.total > 0 && svg.svg === svg.total,
    `技能栏 ${svg.total} 格中 ${svg.svg} 格为程序化 SVG`);

  check('#12g', '关闭美术后无运行时错误', e2.length === 0,
    e2.length === 0 ? '无' : e2.slice(0, 3).join(' | '));
  await p2.close();
}

await browser.close();

// ═══ 汇总 ═════════════════════════════════════════════════════
const passed = results.filter((r) => r.pass).length;
console.log('\n' + '─'.repeat(60));
console.log(`M12 验收：${passed}/${results.length} 通过`);
if (passed !== results.length) {
  console.log('失败项：' + results.filter((r) => !r.pass).map((r) => r.id).join(', '));
  process.exitCode = 1;
}
