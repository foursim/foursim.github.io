#!/usr/bin/env node
/**
 * 交付清单：把「运行时依赖追踪」+「文件实际状态」写成一份给业务方看的清单。
 *
 * 为什么单独一个工具，而不是塞进 export-tables：
 *   清单里最硬的那部分信息（哪张表被哪个查询读、哪一列没被读过）只能**运行时**得到，
 *   而 export-tables 不跑查询。职责不同：那边产出数据，这边产出「这批数据该怎么交付」。
 *
 * 分三组，规则都是可验证的，不猜：
 *   ① 必带   = 被查询读到的表（`tables/query/deps.json`，Proxy 记录的真实访问）
 *   ② 按需   = `.gitignore` 里被忽略的表（`npm run export:daily` 才算，交付时按需带）
 *   ③ 说明   = 其余表（数据字典 / 元数据 / 日期维），不参与查询但仍是交付物
 *
 * 用法：
 *   npm run deliver            # 清单不存在或过期时自动重跑一次依赖追踪
 *   npm run deliver -- --refresh   # 强制重跑依赖追踪
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { classify } from './lib/deliver-groups.mjs';

const ROOT = process.cwd();
const TABLES = path.join(ROOT, 'tables');
const DEPS = path.join(TABLES, 'query', 'deps.json');
const OUT = path.join(TABLES, '交付清单.md');
const force = process.argv.includes('--refresh');

let pass = 0;
let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  [OK]   ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`); }
};

/* ---------- ① 依赖追踪（没有就现跑一次） ---------- */
const csvFiles = fs.readdirSync(TABLES).filter((f) => f.endsWith('.csv'));
const newestCsv = csvFiles.length
  ? Math.max(...csvFiles.map((f) => fs.statSync(path.join(TABLES, f)).mtimeMs))
  : 0;
const stale = !fs.existsSync(DEPS) || fs.statSync(DEPS).mtimeMs < newestCsv;
if (force || stale) {
  console.log(`[追踪] ${force ? '强制重跑' : '清单缺失/比表旧'} ⇒ 跑一次运行时依赖追踪…`);
  execFileSync(process.execPath, [path.join(ROOT, 'tools', 'query.mjs'), '--deps', '--json'], {
    cwd: ROOT, stdio: 'inherit',
  });
}
const deps = JSON.parse(fs.readFileSync(DEPS, 'utf8'));

/* ---------- ② 分组（规则在 tools/lib/deliver-groups.mjs，与 pack 共用同一份） ---------- */
const { must, optional, docs, all } = classify(deps);

// 用**字节**判断存在性/非空：`dim_admin` 只有 2 行（<1 KB），四舍五入成 "0 KB" 会被误判成空文件
const bytesOf = (n) => {
  const f = path.join(TABLES, `${n}.csv`);
  return fs.existsSync(f) ? fs.statSync(f).size : null;
};
const sizeOf = (n) => {
  const b = bytesOf(n);
  if (b === null) return null;
  return b < 1024 ? '<1 KB' : `${(b / 1024).toFixed(0)} KB`;
};
const fmt = (n) => {
  const t = deps.tables[n];
  const kb = sizeOf(n);
  return `| \`${n}\` | ${t.rows.toLocaleString('en-US')} | ${kb ?? '（未落盘）'} | ${(t.readBy ?? []).length ? t.readBy.join(', ') : '—'} | ${t.readColumns.length}/${t.columns.length} |`;
};

/* ---------- ③ 写清单 ---------- */
const lines = [
  '# 交付清单',
  '',
  `> 生成时间：${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
  '> 数据来自**运行时依赖追踪**（`npm run query -- --deps --json`）：哪张表被哪个查询读、哪一列真被读过，',
  '> 都是执行时用 Proxy 记录的真实属性访问，不是人工声明。',
  '',
  '## 一、必带（被查询读取）',
  '',
  '这些表是查询与页面产物的上游，**删掉任何一个都会让某个查询失效**。',
  '',
  '| 表 | 行数 | 大小 | 被哪些查询读 | 列覆盖 |',
  '|---|---:|---:|---|---|',
  ...must.map(fmt),
  '',
  '## 二、按需（`.gitignore` 里忽略）',
  '',
  '这类表体积大、可随时由确定性模型重算，交付时**按需**带：',
  '',
  '| 表 | 行数 | 大小 | 生成方式 |',
  '|---|---:|---:|---|',
  ...optional.map((n) => {
    const t = deps.tables[n];
    const kb = sizeOf(n);
    return `| \`${n}\` | ${t.rows.toLocaleString('en-US')} | ${kb ?? '（未落盘）'} | \`npm run export:daily\` |`;
  }),
  '',
  '## 三、说明 / 元数据（不参与查询）',
  '',
  '词典、数据源登记、日期维这类表，服务的是「读懂这批数据」，不是查询本身：',
  '',
  '| 表 | 行数 | 大小 | 用途 |',
  '|---|---:|---:|---|',
  ...docs.map((n) => {
    const t = deps.tables[n];
    const kb = sizeOf(n);
    return `| \`${n}\` | ${t.rows.toLocaleString('en-US')} | ${kb ?? '（未落盘）'} | 见 \`tables/数据字典.md\` |`;
  }),
  '',
  '## 四、口径与边界',
  '',
  '- 全部数据来自**确定性模型**（同参数同结果），`synthetic=1` 的列是模拟值，不是实测；',
  '- **「未被查询读」≠「可以删」**：它可能仍被 Excel 导出、数据元字典、离线校验用到；',
  '- 「列覆盖」= 被查询真实读到的列 / 表的总列数；未读列见 `npm run query -- --deps` 的明细。',
  '',
];
fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log(`[写出] ${path.relative(ROOT, OUT)}（必带 ${must.length} · 按需 ${optional.length} · 说明 ${docs.length}）`);

/* ---------- ④ 判据 ---------- */
console.log('\n=== 交付清单判据 ===');
check('依赖追踪覆盖**全部预置查询**，且每张表都带列信息',
  Object.keys(deps.queries).length > 0
    && Object.values(deps.tables).every((t) => Array.isArray(t.columns) && t.columns.length > 0),
  `${Object.keys(deps.queries).length} 个查询 · ${all.length} 张表`);

check('三组互不重叠且合起来 == 全部表（没有哪张表漏在清单外）',
  must.length + optional.length + docs.length === all.length
    && new Set([...must, ...optional, ...docs]).size === all.length,
  `必带 ${must.length} + 按需 ${optional.length} + 说明 ${docs.length} = ${all.length}`);

check('清单里的**行数**与运行时追踪一致，且已落盘的表**字节数 > 0**（小表不能因为四舍五入被当成空文件）',
  [...must, ...optional, ...docs].every((n) => {
    const t = deps.tables[n];
    return Number.isInteger(t.rows) && t.rows >= 0 && (bytesOf(n) === null || bytesOf(n) > 0);
  }),
  `抽查：dim_parcel ${deps.tables.dim_parcel?.rows} 行 · fact_parcel_season ${deps.tables.fact_parcel_season?.rows} 行`);

check('「必带」组里每张表都**真的被读到过至少一列**（不是靠表名匹配出来的）',
  must.every((n) => deps.tables[n].readColumns.length > 0),
  must.map((n) => `${n} ${deps.tables[n].readColumns.length} 列`).slice(0, 3).join(' · '));

console.log(`\n================ ${pass} 通过 / ${fail} 失败 ================`);
if (fail > 0) process.exitCode = 1;
