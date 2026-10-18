#!/usr/bin/env node
/**
 * 交付包一键打包：按 `交付清单` 的分组把「页面 + 数据」拷成一个可直接双击打开的目录。
 *
 * 分组规则与 `deliver` **共用** `tools/lib/deliver-groups.mjs` —— 清单说必带、包里就必须有，
 * 不能两处各写一套（那正是"清单与交付物自相矛盾"的来源）。
 *
 * 用法：
 *   npm run pack                 # 必带 + 说明 + 页面；按需表（fact_parcel_daily）**不带**
 *   npm run pack -- --with-daily # 连按需长表一起带（对外交付"要全量"时用）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { classify } from './lib/deliver-groups.mjs';

const ROOT = process.cwd();
const TABLES = path.join(ROOT, 'tables');
const DEPS = path.join(TABLES, 'query', 'deps.json');
const withDaily = process.argv.includes('--with-daily');
const runSmoke = process.argv.includes('--smoke');
const wantZip = process.argv.includes('--zip');
const stamp = new Date().toISOString().slice(0, 10);
const OUT = path.join(ROOT, 'dist', `agri-deliver-${stamp}`);

let pass = 0;
let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  [OK]   ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`); }
};

/**
 * 读 zip 的**中央目录**（只读，不依赖任何外部工具）。
 * 结构：EOCD（`PK\x05\x06`，从尾部往前找）→ 目录条目数/偏移 → 逐条 `PK\x01\x02`。
 */
function listZip(file) {
  const b = fs.readFileSync(file);
  let eocd = -1;
  for (let i = b.length - 22; i >= 0 && i > b.length - 22 - 65535; i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('找不到 EOCD（不是 zip？）');
  const count = b.readUInt16LE(eocd + 10);
  let off = b.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    if (off + 46 > b.length || b.readUInt32LE(off) !== 0x02014b50) break;
    const nameLen = b.readUInt16LE(off + 28);
    const extraLen = b.readUInt16LE(off + 30);
    const commentLen = b.readUInt16LE(off + 32);
    names.push(b.toString('utf8', off + 46, off + 46 + nameLen));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

if (!fs.existsSync(DEPS)) {
  console.log('[依赖] deps.json 不存在 ⇒ 先跑一次 deliver');
  execFileSync(process.execPath, [path.join(ROOT, 'tools', 'deliver.mjs')], { cwd: ROOT, stdio: 'inherit' });
}
const deps = JSON.parse(fs.readFileSync(DEPS, 'utf8'));
const { must, optional, docs } = classify(deps);

/* ---------- ① 清空并重建目标目录 ---------- */
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'tables'), { recursive: true });

const copied = [];
const cp = (rel) => {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) return false;
  const dst = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
  copied.push(rel);
  return true;
};

/* ---------- ② 页面 ---------- */
['index.html', 'style.css', 'js', 'vendor'].forEach(cp);
// data：**排除** `_` 前缀（取数缓存，`.gitignore` 里也忽略了）
for (const f of fs.readdirSync(path.join(ROOT, 'data'))) {
  if (f.startsWith('_')) continue;
  cp(path.join('data', f));
}

/* ---------- ③ 表：必带 + 说明 + 两份 md（+ 按需） ---------- */
const tableFiles = [...must, ...docs];
if (withDaily) tableFiles.push(...optional);
for (const n of tableFiles) cp(path.join('tables', `${n}.csv`));
for (const md of ['交付清单.md', '数据字典.md']) cp(path.join('tables', md));
if (fs.existsSync(path.join(TABLES, '农业监测数据.xlsx'))) cp(path.join('tables', '农业监测数据.xlsx'));

/* ---------- ④ 交付说明 ---------- */
const sizeOf = (rel) => {
  const p = path.join(OUT, rel);
  if (!fs.existsSync(p)) return 0;
  const st = fs.statSync(p);
  if (!st.isDirectory()) return st.size;
  return fs.readdirSync(p).reduce((a, f) => a + sizeOf(path.join(rel, f)), 0);
};
const totalMB = (fs.readdirSync(OUT).reduce((a, f) => a + sizeOf(f), 0) / 1024 / 1024).toFixed(1);
const lines2 = [
  `交付包 · 生成于 ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
  `总体积约 ${totalMB} MB`,
  '',
  '一、怎么打开',
  '  双击 index.html 即可（纯静态，无需服务端、无需联网）。',
  '  若浏览器限制本地 fetch，可在本目录跑：python -m http.server 8000，再访问 http://localhost:8000',
  '',
  '二、包里有什么',
  `  tables/*.csv  ${tableFiles.length} 张表（必带 ${must.length} + 说明 ${docs.length}${withDaily ? ` + 按需 ${optional.length}` : ''}）`,
  '  tables/农业监测数据.xlsx  同一批表的合集（业务方直接读）',
  '  tables/交付清单.md  哪张表被哪个查询读、哪一列没被读到',
  '  tables/数据字典.md  每个字段的含义、单位、口径',
  '  data/*  页面用的静态数据（JSON + GeoJSON）',
  '  js/ vendor/ style.css index.html  纯静态页面',
  '',
  '三、口径与边界（与清单一致）',
  '  · 全部数据来自确定性模型，synthetic=1 的列是模拟值；',
  '  · 「未被查询读」≠「可以删」——可能仍被 Excel 导出、数据元字典、离线校验用到；',
  withDaily
    ? '  · 本包**包含**按需长表 fact_parcel_daily（地块 × 日，约 14 MB），由 `npm run export:daily` 生成。'
    : '  · 本包**不含**按需长表 fact_parcel_daily（约 14 MB）——需要时跑 `npm run pack -- --with-daily`。',
  '',
  '四、数据来源',
  `  见 tables/交付清单.md 与 tables/数据字典.md（本文件由 npm run pack 自动生成）`,
  '',
].join('\n');
fs.writeFileSync(path.join(OUT, '交付说明.txt'), lines2, 'utf8');

console.log(`[打包] ${path.relative(ROOT, OUT)} · ${copied.length} 项 · ${totalMB} MB`);

/* ---------- ④' 压缩包（业务方拿走时更常见的形式） ---------- */
const zipPath = path.join(ROOT, 'dist', `agri-deliver-${stamp}.zip`);
let zipErr = '';
if (wantZip) {
  fs.rmSync(zipPath, { force: true });
  try {
    if (process.platform === 'win32') {
      // Windows 自带 PowerShell 的 Compress-Archive（免装第三方工具）
      execFileSync('powershell', ['-NoProfile', '-Command',
        `Compress-Archive -Path '${OUT}\\*' -DestinationPath '${zipPath}' -Force`], { stdio: 'ignore' });
    } else {
      execFileSync('zip', ['-qr', zipPath, '.'], { cwd: OUT, stdio: 'ignore' });
    }
    console.log(`[压缩] ${path.relative(ROOT, zipPath)} · ${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB`);
  } catch (e) {
    zipErr = e.message.split('\n')[0];
  }
}

/* ---------- ⑤ 判据 ---------- */
console.log('\n=== 交付包判据 ===');
const csvInPack = fs.readdirSync(path.join(OUT, 'tables')).filter((f) => f.endsWith('.csv')).map((f) => path.basename(f, '.csv'));

check('包内表数 == 必带 + 说明' + (withDaily ? ' + 按需' : ''),
  csvInPack.length === tableFiles.length && tableFiles.every((n) => csvInPack.includes(n)),
  `${csvInPack.length} 张：${csvInPack.slice(0, 4).join(', ')}…`);

check('**必带**的每张表都在包里，且与源文件**字节数一致**',
  must.every((n) => {
    const src = path.join(TABLES, `${n}.csv`);
    const dst = path.join(OUT, 'tables', `${n}.csv`);
    return fs.existsSync(dst) && fs.statSync(dst).size === fs.statSync(src).size;
  }),
  `${must.length} 张逐字节等长`);

check(withDaily
  ? '`--with-daily` 时按需长表**必须**在包里'
  : '默认**不带**按需长表（`--with-daily` 才带）',
  withDaily
    ? optional.every((n) => csvInPack.includes(n))
    : optional.every((n) => !csvInPack.includes(n)),
  `按需表：${optional.join(', ') || '无'}`);

{
  // 页面引用的本地文件必须都在包里（`data/xxx.geojson` 这类最容易漏）
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const refs = new Set();
  for (const m of html.matchAll(/(?:src|href)="([^"#?]+)"/g)) {
    const r = m[1];
    if (!/^(https?:|data:|mailto:)/.test(r)) refs.add(r.replace(/^\.\//, ''));
  }
  for (const f of fs.readdirSync(path.join(ROOT, 'js')).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
    for (const m of src.matchAll(/['"`](data\/[\w./-]+\.(?:json|geojson))['"`]/g)) refs.add(m[1]);
  }
  const missing = [...refs].filter((r) => !fs.existsSync(path.join(OUT, r)));
  check('**页面引用的本地文件**都在包里（`index.html` 的 src/href + `js/` 里的 data/*.json|geojson）',
    missing.length === 0, missing.length ? `缺：${missing.join(', ')}` : `${refs.size} 个引用逐个核过`);
}

check(withDaily
  ? '包里没有取数缓存（`data/_soil_samples.json` 是本地中间产物，任何模式都不该带）'
  : '包里没有 `.gitignore` 忽略的东西（取数缓存 / 按需长表）',
  !fs.existsSync(path.join(OUT, 'data', '_soil_samples.json'))
    && (withDaily || !fs.existsSync(path.join(OUT, 'tables', 'fact_parcel_daily.csv'))),
  `data/_soil_samples.json 未带 · fact_parcel_daily ${withDaily ? '已带' : '未带'}`);

if (wantZip) {
  /*
   * 压缩包要**真能读出来**：只判"文件存在且非空"会被"压了个空目录"骗过。
   * 不用外部工具（Git Bash 的 `tar` 是 GNU tar，不认 zip；`unzip` 又不保证有）——
   * 直接读 zip 的**中央目录**（EOCD + 每条目录记录），零依赖、跨平台。
   */
  let entries = [];
  if (!zipErr) {
    try {
      entries = listZip(zipPath);
    } catch (e) {
      zipErr = `读取压缩包失败：${e.message}`;
    }
  }
  const hasPrefix = (p) => entries.some((e) => e.replace(/\\/g, '/').startsWith(p));
  const hasName = (p) => entries.some((e) => e.replace(/\\/g, '/').endsWith(p));
  check('`--zip` 产出的压缩包**能被解析**，且结构完整（`index.html` + `tables/` 下的 CSV + `data/`）',
    !zipErr && entries.length > 0 && hasName('index.html') && hasPrefix('tables/')
      && entries.some((e) => e.endsWith('.csv')) && hasPrefix('data/'),
    zipErr || `${entries.length} 个条目 · ${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB`);
}

if (runSmoke) {
  /*
   * **包里的页面真能起来**：换个根目录跑同一个冒烟（`--root`）。
   * 前面 5 条都是静态核对；只有这一条能证明"这份交付物打开是好的"。
   */
  let ok = true;
  let out = '';
  try {
    out = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'browser-check.mjs'), '--smoke', '--root', OUT], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
    });
  } catch (e) {
    ok = false;
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  const summary = (out.match(/=+ \d+ 通过 \/ \d+ 失败 =+/) ?? [''])[0].trim();
  check('**包里的页面能起来**（对着交付包目录跑同一个冒烟：加载期无异常 + 关键规模对得上）',
    ok, summary || (ok ? '冒烟通过' : out.split('\n').slice(-3).join(' ')));
}

console.log(`\n================ ${pass} 通过 / ${fail} 失败 ================`);
if (fail > 0) process.exitCode = 1;
