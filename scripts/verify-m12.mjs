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
  let trackedLocal = '';
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
console.log('\n── §2 技能图标：91 个技能全覆盖，无断链 ──');
{
  const mapSrc = readFileSync(join(REPO, 'packages/client/src/hud/skillIconMap.ts'), 'utf8');
  const pairs = [...mapSrc.matchAll(/'([a-z]+\.[a-z_0-9]+)':\s*'([^']+)'/g)];
  const broken = pairs.filter(
    ([, , file]) => !existsSync(join(ASSETS, 'art/ui/skills', `${file}.webp`)),
  );
  check('#12a', '★ 映射表里每个技能的图标文件都存在（无断链）',
    pairs.length === 91 && broken.length === 0,
    `映射 ${pairs.length} 条（应为 91），断链 ${broken.length} 条` +
      (broken.length ? `：${broken.slice(0, 3).map((b) => b[1]).join(', ')}` : ''));
}

// ═══ 浏览器部分 ═══════════════════════════════════════════════
const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});

/** 开一页并等到场景装配完成（美术是异步加载的，要给它时间） */
const open = async (url, settleMs = 14000) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(settleMs);
  return { page, errors };
};

const artStatus = (page) => page.evaluate(() => globalThis.__scene?.artStatus);

// ═══ §3 验收 #10 重验：模型大小不改变碰撞体 ═══════════════════
console.log('\n── §3 验收 #10 重验：真实模型不改变碰撞体（docs/13 点名）──');
const { page, errors } = await open(BASE);
{
  const st = await artStatus(page);

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

  // 真实图标确实被浏览器解码了（不是 404 后的裂图）
  const icons = await page.$$eval('#skill-bar .sk-img',
    (els) => ({ total: els.length, loaded: els.filter((e) => e.naturalWidth > 0).length }));
  check('#12c', '技能栏用的是真实图标且全部解码成功',
    icons.total === 8 && icons.loaded === 8,
    `技能栏 8 格中 ${icons.total} 格为真实图标，其中 ${icons.loaded} 格解码成功`);

  check('#12d', '开启美术后无运行时错误', errors.length === 0,
    errors.length === 0 ? '无' : errors.slice(0, 3).join(' | '));
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
}
await page.close();

// ═══ §5 回落路径：?art=off 精确回到 M11 ═══════════════════════
console.log('\n── §5 回落路径：素材可选，游戏照常可玩 ──');
{
  const { page: p2, errors: e2 } = await open(`${BASE}?art=off`, 6000);
  const st = await artStatus(p2);
  check('#12e', '★ ?art=off 完全不加载外部素材，角色回落程序化胶囊体',
    st?.art === false && st.charactersWithModel === 0 && st.envLoaded === false,
    `art=${st?.art}，挂载模型 ${st?.charactersWithModel} 个，环境贴图=${st?.envLoaded}`);

  const svgIcons = await p2.$$eval('#skill-bar .sk-icon',
    (els) => els.filter((e) => e.tagName.toLowerCase() === 'svg').length);
  check('#12f', '★ 关闭美术后技能图标回落程序化 SVG（信息不减一分）',
    svgIcons === 8, `技能栏 8 格中 ${svgIcons} 格为程序化 SVG`);

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
