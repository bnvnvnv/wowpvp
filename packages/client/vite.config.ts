/**
 * M12：把仓库根的 `assets/` 挂到 dev server 的 `/art/**`、`/music/**`。
 *
 * ★ 不用 `publicDir` —— 它会在每次 `vite build` 时把 572MB 素材整包复制进
 *   `dist/`。素材是**运行时按 URL 取**的（图标 <img>、GLB fetch、音频 fetch），
 *   不参与打包，所以 dev/preview 用中间件直接从仓库根流式读出即可。
 *   正式发布包如何带素材是发布工程的事，见 docs/09-asset-license.md §7.2。
 *
 * ★ 素材缺失不是错误：所有消费方（图标/模型/音频/环境）都自带程序化兜底，
 *   没有 `assets/` 目录时游戏照常可玩 —— 这保持了 M1–M10 验收不依赖素材。
 */
import { defineConfig, type Plugin } from 'vite';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';

const ASSET_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../assets');

/** 只列实际用到的类型；未知扩展名回落 octet-stream，不猜 */
const MIME: Record<string, string> = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.glb': 'model/gltf-binary',
  '.hdr': 'application/octet-stream',
  '.ktx2': 'image/ktx2',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.js': 'text/javascript',
  '.json': 'application/json',
};

const handler = (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
  const url = (req.url ?? '').split('?')[0]!;
  if (!url.startsWith('/art/') && !url.startsWith('/music/')) return next();

  // 路径穿越防护：解析后必须仍在 ASSET_ROOT 里
  const file = resolve(ASSET_ROOT, decodeURIComponent(url.slice(1)));
  if (!file.startsWith(ASSET_ROOT + sep) || !existsSync(file) || !statSync(file).isFile()) {
    res.statusCode = 404;
    res.end('not found');
    return;
  }

  res.setHeader('Content-Type', MIME[extname(file).toLowerCase()] ?? 'application/octet-stream');
  // 素材按内容寻址的程度不高，但开发期缓存一小时足够消掉重复加载
  res.setHeader('Cache-Control', 'max-age=3600');
  res.setHeader('Content-Length', statSync(file).size);

  /**
   * ★ HEAD 只回响应头，**不能**把文件体也推出去。
   *   `skillIcon.probeIconAssets()` 用 HEAD 探测素材是否可用，
   *   而管道推送会让浏览器收到不该有的 body 后 abort 连接 ——
   *   实测控制台里就是一条 `net::ERR_ABORTED`：功能看似正常
   *   （探测确实成功了），代价是每次启动白传一个文件。
   */
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
};

const serveRepoAssets = (): Plugin => ({
  name: 'wowpvp:serve-repo-assets',
  configureServer(server) {
    server.middlewares.use(handler);
  },
  configurePreviewServer(server) {
    server.middlewares.use(handler);
  },
});

export default defineConfig({
  plugins: [serveRepoAssets()],
});
