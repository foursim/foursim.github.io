/*
 * 列依赖扫描：**哪些表列在代码里一次都没被提到**（裁剪/精简时只作参考，不做自动改）。
 *
 * 为什么要单独有这个工具（而不是一行 grep）：
 * 上一次我用 shell 里的 grep 扫这件事，参数顺序与 `\b` 转义都出了问题 ⇒
 * 连 `parcel_id` 都报"没人引用"，差点据此去改 schema。**错的测量比没有测量更危险**，
 * 所以这里把扫描放进 node：读文件、按词边界匹配，不受 shell 影响。
 *
 * ⚠️ 结果只能当"**可疑清单**"，不能当判决：
 *   - 动态取值（`row[col]`、`Object.entries(...)` 这类）看不见；
 *   - 数据元字典（`dim_data_element.csv`）、README、Excel 导出都可能"用到但不在 JS 里出现"。
 * 真要删列，必须人工逐个确认，并且同步改数据元字典。
 *
 * 跑法：npm run cols
 */
import fs from 'node:fs';
import path from 'node:path';

const TABLES = 'tables';
const SRC_DIRS = ['js', 'tools'];
const EXTRA_FILES = ['index.html', 'README.md'];

/** 收集要扫的源码（排除 tables/ 自身与 node_modules） */
function collect() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(mjs|js|html)$/.test(e.name) && path.basename(dir) !== TABLES) out.push(p);
    }
  };
  for (const d of SRC_DIRS) if (fs.existsSync(d)) walk(d);
  for (const f of EXTRA_FILES) if (fs.existsSync(f)) out.push(f);
  return out;
}

const sources = collect().map((f) => ({ f, text: fs.readFileSync(f, 'utf8') }));
const files = fs.readdirSync(TABLES).filter((f) => f.endsWith('.csv'));

let totalCols = 0;
const suspects = [];
for (const f of files) {
  const head = fs.readFileSync(path.join(TABLES, f), 'utf8').split(/\r?\n/, 1)[0].split(',').map((x) => x.replace(/"/g, ''));
  totalCols += head.length;
  const miss = head.filter((c) => {
    if (!c) return false;
    // 词边界匹配（列名是标识符风格，\b 对下划线/数字也成立）
    const re = new RegExp(`(^|[^A-Za-z0-9_])${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`);
    return !sources.some((s) => re.test(s.text));
  });
  if (miss.length) suspects.push({ table: f.replace(/\.csv$/, ''), miss, n: head.length });
}

console.log(`\n扫描 ${files.length} 张表 / ${totalCols} 列，源码 ${sources.length} 个文件\n`);
if (!suspects.length) {
  console.log('[OK] 没有任何列是"代码里一次都没提到"的');
  console.log('（注意这个结论**偏宽松**：`name`/`level`/`crs` 这类通用列名会被无关代码撞上 ⇒ '
    + '"全都有引用"不等于"全都有用"，只能说"没有明显的孤立列"）');
} else {
  for (const s of suspects) console.log(`  ${s.table.padEnd(26)} ${s.n} 列 · 可疑 ${s.miss.length}：${s.miss.join(', ')}`);
  console.log('\n（这些只是**可疑**：动态取值、字典/README/Excel 里的用法本工具看不见 —— 删列前必须人工确认，并同步改数据元字典）');
}
