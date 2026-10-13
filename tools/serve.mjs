#!/usr/bin/env node
/**
 * 零依赖静态服务器（只用 node 内置模块）。
 *
 * ## 为什么不用 `python -m http.server` / `npx serve`
 * 1. 这个仓库的判据、取数、验收**全是 node**，启动也统一到 node，少一个运行时依赖；
 * 2. 需要 **`--prefix`**：GitHub Pages 项目站的真实形态是 `user.github.io/<repo>/`，
 *    本地必须在子路径下也跑得起来（相对路径写错只有这样才能发现）；
 * 3. 需要把 `.geojson` 也给对 MIME（`application/json`）—— 这是本项目的主要数据格式，
 *    而多数现成小服务器不认识它（浏览器拿不到 JSON 就会解析失败）。
 *
 * 用法：
 *   node tools/serve.mjs                    # 根路径，http://localhost:8080/
 *   node tools/serve.mjs --prefix /webtrade # 模拟 GitHub Pages 项目站
 *   node tools/serve.mjs --port 9000 --lan  # 换端口，并打印局域网地址（手机测试用）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const flag = (n) => argv.includes(`--${n}`);
const ROOT = path.resolve(opt('root', path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')));
const PORT = Number(opt('port', 8080));
const PREFIX = (() => {
  const p = opt('prefix', '');
  if (!p || p === '/') return '';
  return `/${p.replace(/^\/+|\/+$/g, '')}`;
})();

/** MIME：`.geojson` 必须给 application/json —— 这是本项目的主数据格式，别漏 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.pmtiles': 'application/octet-stream',
};

const server = http.createServer(async (req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  // 子路径模式：只在前缀下服务，别的路径一律 404（和 GitHub Pages 项目站的行为一致）
  if (PREFIX) {
    if (url !== PREFIX && !url.startsWith(`${PREFIX}/`)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`404 —— 本站只在 ${PREFIX}/ 下服务（模拟 GitHub Pages 项目站）\n请打开 http://localhost:${PORT}${PREFIX}/`);
      return;
    }
    url = url.slice(PREFIX.length);
  }
  if (url === '' || url === '/') url = '/index.html';

  // 目录穿越保护：解析后必须仍在 ROOT 之内
  const file = path.resolve(ROOT, `.${url}`);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('403');
    return;
  }
  try {
    const stat = await fs.promises.stat(file);
    if (stat.isDirectory()) throw new Error('dir');
    const body = await fs.promises.readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': body.length,
      // 开发期禁缓存：改了 js/css 刷新就生效（不必强刷）
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`404 ${url}\n（数据文件要先跑 npm run data:all 生成）`);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const base = `http://localhost:${PORT}${PREFIX}/`;
  console.log(`静态服务器已启动（根目录 ${ROOT}）`);
  console.log(`  本机打开： ${base}`);
  if (flag('lan')) {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const it of list ?? []) {
        if (it.family === 'IPv4' && !it.internal) console.log(`  手机/同局域网： http://${it.address}:${PORT}${PREFIX}/`);
      }
    }
  }
  console.log('  （Ctrl+C 停止；改数据后重新刷新即可，响应带 no-store）');
});
