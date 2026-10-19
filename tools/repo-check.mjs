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
import { execSync } from 'node:child_process';
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
    'tools/duck-run.py', 'tools/repo-check.mjs', 'docs/五分钟上手.md', 'sim.html', 'guide.css', 'img/cropsPic.png',
  ];
  // ⚠️ 只查"存在"会被同名**空文件**骗过（0 字节的 data/pivot.json 照样绿），所以连体积一起查
  const bad = wanted.filter((f) => README.includes(f) && (!fs.existsSync(f) || fs.statSync(f).size < 64));
  check('README 里点名的产物**真的存在且非空**（交付物名写了却没生成/生成了空壳，是最容易骗过自己的"完成"）',
    bad.length === 0, bad.length ? `README 提到但缺失或过小：${bad.join(',')}` : `${wanted.length} 项逐个核过（含体积）`);
}

// ---------- 4. 页面仍然零外部依赖（与浏览器侧第 21 节同源，这里做静态兜底） ----------
{
  const files = [...fs.readdirSync('js').filter((f) => f.endsWith('.js')).map((f) => `js/${f}`), 'index.html', 'sim.html', 'style.css', 'guide.css'];
  const src = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const ext = [...src.matchAll(/<(?:script|link)[^>]*?(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)/g)].map((m) => m[1]);
  /*
   * `ready` 是"只改了代码/页面时的第一条命令"，它**必须能发现"页面根本起不来"**。
   * 依据：一次整段替换误删了 10 个 UI 方法，页面直接报 `UI.loadColHidden is not a function`，
   * 而当时的 ready 只跑 query/repo，照样一片绿。这条判据钉住它：谁把 smoke 拿掉，这里就红。
   */
  const ready = (JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts ?? {}).ready ?? '';
  /*
   * `ready` 现在是个 runner（`node tools/ready.mjs`），步骤写在它自己的 STEPS 表里。
   * 所以不能在 package.json 的字符串里找 `smoke:browser`（找到的是"没有"）——
   * 要看**runner 实际会跑什么**。这一步判据当场抓住过我改 runner 时把冒烟漏掉。
   */
  const runnerFile = /node (tools\/[\w.-]+\.mjs)/.exec(ready)?.[1];
  const runnerText = runnerFile && fs.existsSync(runnerFile) ? fs.readFileSync(runnerFile, 'utf8') : '';
  check('`ready` 里含**页面冒烟**（`smoke:browser`）—— 否则"改坏了页面"这件事在 ready 里看不出来',
    /smoke:browser/.test(ready) || /smoke:browser/.test(runnerText),
    runnerFile ? `via ${runnerFile}` : ready);

  /*
   * 路网是启动清单里最大的一块（曾 459 KB）。精简后必须同时满足：
   * 体积达标 + 坐标不超过 6 位小数 + **功能属性 highway 一个都不能少**（样式与离线可达性都靠它）
   * + 署名上移到 metadata（ODbL 要求署名，精简不能连署名一起删）。
   * 这条判据也是"重跑 data:roads 后忘了 trim"的报警器。
   */
  {
    const raw = fs.readFileSync('data/roads.geojson', 'utf8');
    const g = JSON.parse(raw);
    const kb = Buffer.byteLength(raw) / 1024;
    const decOk = raw.match(/\d+\.\d{7,}/g) === null;
    const hwOk = g.features.length > 1000 && g.features.every((f) => f.properties && f.properties.highway);
    const attrOk = !!(g.metadata && g.metadata.attribution && g.metadata.attribution.license);
    check('路网已精简且功能属性齐全（≤ 340 KB · 坐标 ≤ 6 位小数 · highway 全覆盖 · 署名在 metadata）',
      kb <= 340 && decOk && hwOk && attrOk,
      `${kb.toFixed(0)} KB（459 KB 原版）· 坐标精度达标=${decOk} · ${g.features.length} 段 highway 全覆盖=${hwOk}`
        + ` · 署名=${g.metadata?.attribution?.license ?? '缺'}`);
  }

  /*
   * **离线产物体积预算**（实测基线 16.5 MB，其中 `fact_parcel_daily.csv` 13.7 MB = 501 块 × 549 天，
   * 是模型输出的固有规模）。这里不设"墙钟耗时"阈值 —— 那随机器变，会变成假失败；
   * 但体积是确定的：**悄悄翻倍**（重复导出、多了份全量副本、格式没压缩）一定要当场发现。
   */
  {
    const dirSize = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => {
      const p = path.join(dir, e.name);
      return n + (e.isDirectory() ? dirSize(p) : fs.statSync(p).size);
    }, 0);
    const mb = dirSize('tables') / 1024 / 1024;
    check('离线产物体积在预算内（tables/ ≤ 20 MB；实测基线 16.5 MB，大头是 fact_parcel_daily 13.7 MB）',
      mb <= 20, `${mb.toFixed(1)} MB / 预算 20 MB`);
  }

  /*
   * **HTML 里的站内链接/图片必须真的存在**。
   * 依据：本轮把入口从 `guide.html` 换成 `index.html`（模拟页挪到 `sim.html`），改名时最容易漏改引用，
   * 而静态站点上的死链**不会报错**，只会点了没反应或 404。
   */
  {
    const pages = ['index.html', 'sim.html'].filter((f) => fs.existsSync(f));
    const broken = [];
    for (const f of pages) {
      const html = fs.readFileSync(f, 'utf8');
      for (const m of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
        const target = m[1];
        if (/^(https?:|data:|mailto:|javascript:)/.test(target) || target.startsWith('#')) continue;
        if (!fs.existsSync(target.replace(/^\//, ''))) broken.push(`${f} → ${target}`);
      }
    }
    check('HTML 里的**站内链接与图片都真的存在**（改名后漏改引用 = 死链，静态站点不会报错）',
      broken.length === 0, broken.length ? broken.slice(0, 4).join(' · ') : `${pages.join(' + ')} 逐个核过`);
  }

  /*
   * **导览页的类名不许与主页面重名**。
   * 依据：本轮 `guide.css` 里写了 `.stat { ... }`，而 `style.css` 已有 `.stat`（区域概览用，`display:flex`）——
   * 结果导览页的数字卡片被排成一行（"501 地块（990.17 ha）"挤在一起）。样式冲突不会报错，只会"看着别扭"。
   */
  {
    const classesOf = (f) => new Set([...fs.readFileSync(f, 'utf8').matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]));
    const clash = fs.existsSync('guide.css')
      ? [...classesOf('guide.css')].filter((c) => classesOf('style.css').has(c))
      : [];
    check('导览页样式（`guide.css`）的类名**不与主页面（`style.css`）重名**',
      clash.length === 0, clash.length ? `重名：${clash.join(', ')}` : '两文件类名互不重叠');
  }

  /*
   * **文档里的命令必须真的存在**：`docs/*.md` 里写的 `npm run xxx` 若在 `package.json` 里找不到，
   * 说明文档已经腐烂（改名/删脚本时最容易漏改文档）。这条判据把"文档"变成可验证的。
   */
  {
    const docsDir = path.join(process.cwd(), 'docs');
    const docs = fs.existsSync(docsDir) ? fs.readdirSync(docsDir).filter((f) => f.endsWith('.md')) : [];
    const scripts = Object.keys(JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts ?? {});
    const used = new Set();
    for (const f of docs) {
      const text = fs.readFileSync(path.join(docsDir, f), 'utf8');
      for (const m of text.matchAll(/npm run ([\w:-]+)/g)) used.add(m[1]);
    }
    const bad = [...used].filter((n) => !scripts.includes(n));
    /*
   * **产物换行必须是 LF**：`csv.writer` 默认行尾是 `\r\n`，而 git 索引里是 LF ⇒
   * 每次重跑都在提交里塞进"整文件改动"（纯换行差异，把真改动淹掉）。这条判据钉住它。
   * 只读前 64 KB：行尾差异在任意一行的末尾都能看出来，不必读整个 14 MB 的文件。
   */
  {
    const dirs = ['tables', 'tables/query', 'tables/query/sql'];
    const bad = [];
    for (const d of dirs) {
      if (!fs.existsSync(d)) continue;
      for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.csv'))) {
        const p = path.join(d, f);
        const buf = fs.readFileSync(p).subarray(0, 64 * 1024);
        if (buf.includes(0x0d)) bad.push(p);
      }
    }
    check('产物 CSV **只用 LF 换行**（CRLF 会让每次重跑都产生"整文件 diff"，把真改动淹掉）',
      bad.length === 0, bad.length ? `CRLF：${bad.slice(0, 3).join(', ')}` : '已扫 3 个目录的 CSV 前 64 KB');
  }

  check('`docs/` 里提到的每个 `npm run xxx` 都真的存在于 `package.json` scripts（防文档腐烂）',
      bad.length === 0, bad.length ? `文档里不存在：${bad.join(', ')}` : `${docs.length} 篇 · ${used.size} 个命令逐个核过`);
  }

  check('页面源码里没有外部脚本/样式引用（纯静态硬线的静态兜底）',
    ext.length === 0, ext.length ? `外链：${ext.join(',')}` : `扫描 ${files.length} 个文件：只有本地引用`);
}

// ---------- 5. CSS 里引用的**本地文件**必须存在 ----------
{
  /*
   * 起因：vendored 的 `leaflet.css` 里有三处 `url(images/…)`，而仓库里没有那些图片 ——
   * 平时不触发（我们只用 circleMarker/divIcon），但属于"同源 404 隐患"。这条判据保证：
   * 任何人再往 CSS 里写一个指向缺失文件的 `url(...)`，构建/校验阶段就会红。
   * 跳过：`data:`（内联）、`#…`（SVG 片段引用，如老 IE 的 VML behavior）、`http(s):`（外部，另有纯静态判据管）。
   */
  const cssFiles = ['style.css', ...fs.readdirSync('vendor', { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => fs.readdirSync(path.join('vendor', d.name))
      .filter((f) => f.endsWith('.css'))
      .map((f) => path.join('vendor', d.name, f)))];
  const missing = [];
  for (const f of cssFiles) {
    const dir = path.dirname(f);
    // 先去掉 CSS 注释再扫：注释里写的示例（比如说明"这里原本引用 images/xxx"）不是活引用
    const css = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
      const u = m[1].trim();
      if (/^(data:|#|https?:|\/\/)/.test(u)) continue;
      const target = path.join(dir, u.split('?')[0]);
      if (!fs.existsSync(target)) missing.push(`${f} → ${u}`);
    }
  }
  check('CSS 里引用的**本地文件都存在**（同源 404 隐患：vendored leaflet 曾引用 3 张不存在的图）',
    missing.length === 0, missing.length ? missing.join('；') : `扫描 ${cssFiles.length} 个 CSS：全部可解析`);
}

/*
 * **待推送提醒**（只提醒、不算判据）：网络不稳时"本地提交了没推"很容易被忘掉。
 * 比的是本地 `origin/main` 引用 —— 不需要联网 ✔（没有 fetch 时它就是上次推送/拉取时的状态）。
 * 刻意**不做成 check**：CI 里 HEAD 本来就领先 origin/main，那会让流水线无故变红。
 */
try {
  const n = Number(execSync('git rev-list --count origin/main..HEAD', { cwd: process.cwd(), encoding: 'utf8' }).trim());
  if (n > 0) {
    const log = execSync('git log --oneline origin/main..HEAD', { cwd: process.cwd(), encoding: 'utf8' }).trim().split('\n');
    console.log(`\n⚠️  有 ${n} 笔提交**尚未推送**（网络恢复后记得 git push）：`);
    for (const l of log.slice(0, 5)) console.log(`   ${l}`);
  }
} catch (e) { /* 没有 origin 引用/不是 git 仓库：跳过 —— 但**别静默**（变量写错过一次，被空 catch 藏了） */ console.log(`  （待推送检查跳过：${String(e.message).slice(0, 60)}）`); }

console.log(`\n================ ${pass} 通过 / ${fail} 失败 ================`);
process.exit(fail ? 1 : 0);
