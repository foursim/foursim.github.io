#!/usr/bin/env node
/**
 * 仓库卫生判据（`npm run repo:check`）—— 管的是"我自己反复犯的错"，不是业务逻辑。
 *
 * 每一条都是踩过的：
 * - **临时补丁脚本误提交**（`tools/_*.py`）：已发生 3 次（"用完必删"写在记忆里也照犯），
 *   所以改成会失败的检查 —— 靠自觉没用，靠判据才有用；
 * - **`package.json` 被改成非法 JSON**：曾经手工改脚本时写坏过，`node` 直接起不来；
 * - **`scripts` 里引用的文件不存在**：文档/脚本与仓库实际对不上（曾凭空写过 `build-hist.mjs`）；
 * - **README 里提到的产物不存在**：交付物名写了却没生成，是最容易骗过自己的那种"完成"。
 *
 * 跑法：npm run repo:check（已接在 data:all 末尾）
 */
import fs from 'node:fs';
import path from 'node:path';

let pass = 0;
let fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? '  [OK]  ' : '  [FAIL]'} ${label}${detail ? ` — ${detail}` : ''}`);
};

// ---------- 1. 没有残留的临时补丁脚本 ----------
{
  const leftovers = fs.readdirSync('tools').filter((f) => /^_/.test(f));
  check('`tools/` 下没有残留的临时补丁脚本（`_*.py` / `_*.mjs` 用完即删 —— 已误提交 3 次）',
    leftovers.length === 0, leftovers.length ? `残留：${leftovers.join(',')}` : '干净');
}

// ---------- 2. package.json 合法，且 scripts 指向的文件真的存在 ----------
{
  let pkg = null;
  let err = '';
  try {
    pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  } catch (e) {
    err = String(e.message).slice(0, 80);
  }
  check('`package.json` 是**合法 JSON**（曾手工改坏过，`node` 直接起不来）', !!pkg, err || `${Object.keys(pkg.scripts).length} 个脚本`);
  if (pkg) {
    const refs = new Set();
    for (const cmd of Object.values(pkg.scripts)) {
      for (const m of String(cmd).matchAll(/node\s+([\w./-]+\.mjs)/g)) refs.add(m[1]);
    }
    const missing = [...refs].filter((f) => !fs.existsSync(f));
    check('`scripts` 里引用的每个脚本文件都存在（防止文档/脚本凭空引用不存在的文件）',
      missing.length === 0, missing.length ? `缺：${missing.join(',')}` : `${refs.size} 个被引用的脚本全部存在`);
  }
}

// ---------- 3. README 里点名的产物确实存在 ----------
{
  const README = fs.readFileSync('README.md', 'utf8');
  // 只查"交付物"这类文件名（README 里出现就应当真的存在）
  const wanted = [
    'tables/农业监测数据.xlsx', 'tables/query/透视与联合查询.xlsx', 'tables/query/透视与联合查询.md',
    'data/pivot.json', 'tables/query/results-self.json', 'tools/query.mjs', 'tools/query-sql.mjs',
    'tools/duck-run.py', 'tools/repo-check.mjs',
  ];
  // ⚠️ 只查"存在"会被同名**空文件**骗过（0 字节的 data/pivot.json 照样绿），所以连体积一起查
  const bad = wanted.filter((f) => README.includes(f) && (!fs.existsSync(f) || fs.statSync(f).size < 64));
  check('README 里点名的产物**真的存在且非空**（交付物名写了却没生成/生成了空壳，是最容易骗过自己的"完成"）',
    bad.length === 0, bad.length ? `README 提到但缺失或过小：${bad.join(',')}` : `${wanted.length} 项逐个核过（含体积）`);
}

// ---------- 4. 页面仍然零外部依赖（与浏览器侧第 21 节同源，这里做静态兜底） ----------
{
  const files = [...fs.readdirSync('js').filter((f) => f.endsWith('.js')).map((f) => `js/${f}`), 'index.html', 'style.css'];
  const src = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const ext = [...src.matchAll(/<(?:script|link)[^>]*?(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)/g)].map((m) => m[1]);
  check('页面源码里没有外部脚本/样式引用（纯静态硬线的静态兜底）',
    ext.length === 0, ext.length ? `外链：${ext.join(',')}` : `扫描 ${files.length} 个文件：只有本地引用`);
}

console.log(`\n================ ${pass} 通过 / ${fail} 失败 ================`);
process.exit(fail ? 1 : 0);
