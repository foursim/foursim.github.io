/*
 * `npm run ready`：**改完代码/页面的一条命令**，跑完给一行汇总。
 *
 * 为什么要包一层：六个步骤各打一段输出，全绿也要翻六次屏才能确认（而且"哪一步红了"要往上找）。
 * 这里按顺序跑、抓每步的"通过/失败"行，最后打一张小表 + 一行结论；任何一步红了就**立刻停**
 * （后面的步骤在有红的情况下跑意义不大，还会把真正的错埋在噪音里）。
 *
 * 步骤顺序是刻意的：模型冒烟 → 表格整形判据 → 页面冒烟（能起来吗）→ 查询 → 交叉验证 → 仓库卫生。
 * 前面越便宜、越可能挂的越靠前（页面起不来时，后面的全都不用跑）。
 */
import { spawnSync } from 'node:child_process';

const STEPS = [
  ['npm test', '模型冒烟'],
  ['npm run test:tables', '表格整形（node，毫秒级）'],
  ['npm run smoke:browser', '页面冒烟（能起来吗）'],
  ['npm run query', '查询引擎'],
  ['npm run query:sql', 'DuckDB 交叉验证'],
  ['npm run repo:check', '仓库卫生'],
];

const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');
const rows = [];
let failed = null;
const t0 = Date.now();
for (const [cmd, label] of STEPS) {
  const t = Date.now();
  const r = spawnSync(cmd, { shell: true, encoding: 'utf8' });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const m = /(\d+) 通过 \/ (\d+) 失败/.exec(out);
  const pass = m ? Number(m[1]) : null;
  const fail = m ? Number(m[2]) : null;
  const ok = r.status === 0 && (fail === null || fail === 0);
  rows.push({ label, cmd, ok, pass, fail, ms: Date.now() - t });
  // `-v/--verbose`：每一步都打完整输出（红的时候默认只给最后 12 行，有时不够）
  if (VERBOSE) console.log(`\n--- ${label} (${cmd}) ---\n${out.trim()}`);
  if (!ok) {
    const tail = VERBOSE ? out.trim() : out.trim().split(/\r?\n/).slice(-12).join('\n');
    failed = { label, cmd, out: tail };
    break;
  }
}

const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));
console.log('\n==================== npm run ready ====================');
for (const r of rows) {
  console.log(`${r.ok ? '  [OK]  ' : '  [FAIL]'} ${pad(r.label, 26)} ${r.pass === null ? '' : `${r.pass} 条`}${' '.repeat(Math.max(0, 7 - String(r.pass ?? '').length))} ${String(r.ms).padStart(6)} ms`);
}
const total = rows.filter((r) => r.ok).reduce((n, r) => n + (r.pass ?? 0), 0);
console.log('------------------------------------------------------');
if (failed) {
  console.log(`✗ 在「${failed.label}」这一步失败（${failed.cmd}）—— 后面的步骤没有跑。最后 12 行输出：\n`);
  console.log(failed.out);
  process.exit(1);
}
console.log(`✓ 全绿：${total} 条判据 · ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
console.log('（要全量数据体检：npm run data:all；只改了一个查询：npm run query -- --only q14）');
