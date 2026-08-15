#!/usr/bin/env node
/**
 * 发布包组装：把运行时素材拷进 client 的 `dist/`，让它可以单独部署。
 * （docs/09-asset-license.md §7.2 发布前清单的落地一步；外部审计批 2026-08-15）
 *
 * ★ 为什么不是 vite 的 `publicDir`：那会让**每一次** `vite build` 都整包
 *   复制 ~420MB 素材（vite.config.ts 文件头记着这条取舍）。素材是运行时按
 *   绝对 URL 取的（`/art/**`、`/music/**`），不参与打包 —— 只有真要发布时
 *   才需要 dist 自包含，所以做成显式一步，而不是每次构建都付的税。
 *
 * ★ 拷什么、不拷什么（§7.2 清单逐条对应）：
 *   · `assets/art` → `dist/art`、`assets/music` → `dist/music` ——
 *     与 dev 中间件的 URL 形状逐字相同，客户端零改动
 *   · 来源与致谢（SOURCE.md / CREDITS / THIRD_PARTY_NOTICES）一并入包 ——
 *     §7.2「发布说明可链到来源清单」
 *   · **绝不碰 `assets/local/`**（T1 素材不入发布包的红线）——
 *     这里按白名单只拷 art/music，结构上就到不了它
 *   · 素材缺失不是错误：无 `assets/` 时照样出包（运行时回落程序化，§5.1）
 *
 * 用法：pnpm build && pnpm package:client
 */

import { cpSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(new URL(import.meta.url))), '..');
const dist = resolve(root, 'packages/client/dist');

if (!existsSync(dist)) {
  console.error(`未找到 ${dist} —— 先跑 pnpm build 再组装发布包`);
  process.exit(1);
}

for (const dir of ['art', 'music']) {
  const from = resolve(root, 'assets', dir);
  if (!existsSync(from)) {
    console.warn(`⚠ assets/${dir} 不存在，跳过（素材缺失可运行：客户端回落程序化）`);
    continue;
  }
  cpSync(from, resolve(dist, dir), { recursive: true });
  console.log(`✓ assets/${dir} → dist/${dir}`);
}

for (const f of [
  'SOURCE.md',
  'CREDITS-world-of-claudecraft.md',
  'THIRD_PARTY_NOTICES-world-of-claudecraft.md',
]) {
  const from = resolve(root, 'assets', f);
  if (existsSync(from)) {
    copyFileSync(from, resolve(dist, f));
    console.log(`✓ assets/${f} → dist/${f}`);
  }
}

console.log('发布包就绪：dist 自包含（/art、/music 与 dev 服务器同形），可直接静态部署。');
