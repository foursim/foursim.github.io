#!/usr/bin/env node
/**
 * **成熟引擎侧 + 交叉验证**（`npm run query:sql`）。
 *
 * ## 这一层是干什么的
 *
 * `tools/query.mjs` 是本项目自研的连接/透视引擎（零依赖、可判据、随仓库走）。
 * 自研的东西最怕"自己验自己"：算法写错了，判据也可能跟着错。
 * 所以这里再上一套**完全独立的实现** —— DuckDB（嵌入式 OLAP，MIT，单文件，`PIVOT` 是它的原生语法），
 * 跑同一批 `tables/*.csv`、算同一批问题，然后**逐格对比**：
 *
 * - 一致 ⇒ 两套独立实现对"连接 / 透视 / 聚合 / 口径"的理解相同，结论可信；
 * - 不一致 ⇒ 不是"谁对谁错"，而是**说明有一侧的口径定义不清**，必须先查清楚再出数。
 *
 * ## 三条与 DuckDB 打交道的经验（都写进代码了）
 *
 * 1. **键列必须留文本**：`all_varchar=true` + 需要算数的地方显式 `CAST(... AS DOUBLE)`；
 *    否则 `09186162` 会被读成整数，`09186-P-000001` 会保持字符串，编码在两套引擎里形态不一致；
 * 2. **NULL 与空串的语义要对齐**：SQL 里 `CAST('' AS DOUBLE) < 21` 是 **NULL（不命中）**，
 *    自研引擎里如果按 `Number('') === 0` 处理就会把那行算成命中 —— 这个差异是交叉验证抓出来的；
 * 3. **`PIVOT ... ON ... USING ... GROUP BY ...`** 是 DuckDB 的原生透视语法，直接产出宽表，
 *    正好和自研引擎的宽表**逐格对齐**（这一条比对"长表聚合"更能暴露实现差异）。
 *
 * ## 没有 DuckDB 会怎样
 *
 * 打印安装提示并**跳过**（退出码 0）：交叉验证是"加强项"，不是交付的前置条件
 * （网页是纯静态的，交付物是 CSV/Excel/JSON，都不依赖 DuckDB）。
 *
 * 用法：
 *   npm run query:sql          # 跑 SQL + 与自研结果逐格对比
 *   npm run query:sql -- --keep   # 保留 SQL 侧产物（默认也保留，便于人工核对）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > -1 ? process.argv[i + 1] : d;
};
const TABLES = arg('tables', 'tables');
const OUT = arg('out', path.join(TABLES, 'query'));
const SELF_JSON = path.join(OUT, 'results-self.json');
const SQL_DIR = path.join(OUT, 'sql');

let pass = 0;
let fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? '  [OK]  ' : '  [FAIL]'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const round = (v, d = 3) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : v);
const isEmpty = (v) => v === '' || v === null || v === undefined;
/**
 * 浮点比较：两套引擎的求和顺序不同，末位必然有差（用相对容差，不用"四舍五入后相等"这种脆判法）。
 *
 * ⚠️ **空 ≠ 0**：`Number('')` 与 `Number(null)` 都是 0，若不先把空值挑出来，
 * "自研侧出 0、SQL 侧出 NULL"（或反过来）就会被判成相等 —— 那是**语义差异**，必须红。
 * 空值只和空值相等（例如某作物某年完全没有单产记录：两侧都空 ⇒ 判等是合理的）。
 */
const close = (a, b) => {
  if (isEmpty(a) || isEmpty(b)) return isEmpty(a) && isEmpty(b);
  const x = Number(a);
  const y = Number(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return String(a) === String(b);
  return Math.abs(x - y) <= 1e-6 * Math.max(1, Math.abs(y));
};

// ---------- 0. 前置：自研侧结果必须在 ----------
if (!fs.existsSync(SELF_JSON)) {
  console.log('[准备] 自研侧结果不存在，先跑一次 `node tools/query.mjs --json …`');
  const r = spawnSync(process.execPath, ['tools/query.mjs', '--json', SELF_JSON], { stdio: 'ignore' });
  if (r.status !== 0) {
    // 自研引擎跑不通是**真问题**，必须红（原来这里 exit 0，等于把失败伪装成"跳过"）
    check('自研引擎能跑通（交叉验证的前置）', false, '`node tools/query.mjs` 退出码非 0，先修它');
    console.log(`\n================ ${pass} 通过 / ${fail} 失败 ================`);
    process.exit(1);
  }
}
const self = JSON.parse(fs.readFileSync(SELF_JSON, 'utf8'));

// ---------- 1. DuckDB 可用性 ----------
const probe = spawnSync('python', ['-c', 'import duckdb;print(duckdb.__version__)'], { encoding: 'utf8' });
const hasDuck = probe.status === 0;
if (!hasDuck) {
  console.log('\n=== DuckDB 交叉验证（跳过） ===');
  console.log('  环境里没有 DuckDB —— 这是**可选**的加强项，不影响任何交付物（网页纯静态、表已在 tables/）。');
  console.log('  想跑交叉验证：pip install duckdb   （或安装 duckdb CLI）');
  process.exit(0);
}
const duckVer = String(probe.stdout).trim();
console.log(`\n=== DuckDB 交叉验证（duckdb ${duckVer}） ===`);

// ---------- 2. 视图 + SQL 查询（与自研预置查询一一对应） ----------
const csvFiles = fs.readdirSync(TABLES).filter((f) => f.endsWith('.csv'));
const views = csvFiles.map((f) => ({
  name: f.replace(/\.csv$/, ''),
  file: path.join(TABLES, f).replace(/\\/g, '/'),   // SQL 字面量里用正斜杠，免得反斜杠被当转义
}));
const dbl = (c) => `CAST(${c} AS DOUBLE)`;
const queries = [
  // q1 的 `yield_basis` 在 dim_crop 里（事实表只存键）⇒ SQL 侧也要走一次星型连接，
  // 这正好把"事实表必须连维度才读得动"这件事在两套引擎里各做一遍
  { id: 'q1', sql: `SELECT s.crop_name_zh, c.yield_basis, CAST(s.season_year AS VARCHAR) AS ck, AVG(${dbl('s.yield_t_ha')}) AS val
      FROM fact_parcel_season s LEFT JOIN dim_crop c ON c.crop_code = s.crop_code
      WHERE s.yield_t_ha <> '' GROUP BY 1, 2, 3` },
  { id: 'q2', sql: `SELECT unit_id, decade_key, AVG(${dbl('progress_mean')}) AS val FROM fact_unit_decade GROUP BY 1, 2` },
  // 原生透视语法：直接出宽表，和自研的矩阵逐格比
  { id: 'q2pivot', sql: `PIVOT fact_unit_decade ON decade_key USING AVG(${dbl('progress_mean')}) GROUP BY unit_id` },
  { id: 'q3', sql: `SELECT grid_id, crop_name_zh, SUM(${dbl('area_ha')}) AS val FROM dim_parcel GROUP BY 1, 2` },
  { id: 'q4', sql: `SELECT phenomenon_time, variable_code, AVG(${dbl('result_value')}) AS val FROM fact_observation GROUP BY 1, 2` },
  { id: 'q5', sql: `SELECT parcel_id FROM dim_parcel WHERE ${dbl('t_min_to_store')} > 7
      AND ${dbl('soil_organic_matter')} < 21 AND CAST(disease_level_max AS INTEGER) >= 3 ORDER BY 1` },
  { id: 'q6', sql: `SELECT admin_code, COUNT(DISTINCT grid_id) AS n_grids, COUNT(DISTINCT unit_id) AS n_units,
      COUNT(*) AS n_parcels, SUM(${dbl('area_ha')}) AS area FROM dim_parcel GROUP BY 1 ORDER BY 1` },
  { id: 'q7', sql: `SELECT z.zone_code, p.crop_name_zh, SUM(${dbl('z.area_ha_est')}) AS val
      FROM fact_zone z LEFT JOIN dim_parcel p ON p.parcel_id = z.parcel_id GROUP BY 1, 2` },
  // 剩下 4 张事实表也要有独立实现核过（原来只覆盖了 5 张）
  { id: 'q8', sql: `SELECT substr(date_key, 1, 6) AS ym, COUNT(*) AS n_days, SUM(${dbl('precip_mm')}) AS prec,
      AVG(${dbl('humidity_pct')}) AS hum, AVG(${dbl('crop_progress')}) AS prog, MAX(CAST(disease_level_max AS INTEGER)) AS dis
      FROM fact_region_daily GROUP BY 1 ORDER BY 1` },
  { id: 'q9', sql: `SELECT substr(event_day, 1, 4) AS y,
      SUM(CASE WHEN event_type = 'sow' THEN 1 ELSE 0 END) AS sow,
      SUM(CASE WHEN event_type = 'fertilize' THEN 1 ELSE 0 END) AS fert,
      SUM(CASE WHEN event_type = 'harvest' THEN 1 ELSE 0 END) AS harv, COUNT(*) AS total,
      SUM(${dbl('yield_t_ha')}) AS ysum, COUNT(yield_t_ha) AS nyield
      FROM fact_parcel_event GROUP BY 1 ORDER BY 1` },
  { id: 'q10', sql: `SELECT crop_code, COUNT(*) AS n, SUM(${dbl('yield_t')}) AS yt,
      AVG(${dbl('yield_t_ha')}) AS yha, MAX(CAST(disease_level_max AS INTEGER)) AS dis
      FROM fact_parcel_season GROUP BY 1 ORDER BY 1` },
  { id: 'q11', sql: `SELECT decade_key, COUNT(DISTINCT unit_id) AS units, SUM(${dbl('harvested_ha')}) AS harv,
      SUM(${dbl('sown_ha')}) AS sown, AVG(${dbl('progress_mean')}) AS prog,
      AVG(${dbl('progress_area_mean')}) AS progA, MAX(CAST(disease_level_max AS INTEGER)) AS dis
      FROM fact_unit_decade GROUP BY 1 ORDER BY 1` },
  { id: 'q12', sql: `SELECT s.crop_name_zh || ' · ' || c.yield_basis || ' · ' || CAST(s.season_year AS VARCHAR) AS k,
      COUNT(*) AS n, SUM(${dbl('p.area_ha')}) AS ha, SUM(${dbl('s.yield_t')}) AS yt,
      AVG(${dbl('s.yield_t_ha')}) AS yeq,
      SUM(${dbl('s.yield_t')}) / NULLIF(SUM(${dbl('p.area_ha')}), 0) AS yarea
      FROM fact_parcel_season s LEFT JOIN dim_parcel p ON p.parcel_id = s.parcel_id
      LEFT JOIN dim_crop c ON c.crop_code = s.crop_code
      GROUP BY 1 ORDER BY 1` },
  // 收获排产压力：与自研 q14 逐行逐列比（吨·分钟 = 运力占用）
  { id: 'q14', sql: `SELECT s.harvest_day AS day, COUNT(*) AS n, SUM(${dbl('p.area_ha')}) AS ha,
      SUM(${dbl('s.yield_t')}) AS yt,
      SUM(${dbl('s.yield_t')} * ${dbl('p.t_min_to_store')}) / NULLIF(SUM(${dbl('s.yield_t')}), 0) AS tmin_w,
      SUM(${dbl('s.yield_t')} * ${dbl('p.t_min_to_store')}) AS haul
      FROM fact_parcel_season s LEFT JOIN dim_parcel p ON p.parcel_id = s.parcel_id
      WHERE s.harvest_day <> '' GROUP BY 1 ORDER BY 1` },
  // 农事日历：与自研 q13 逐格比（月 × 事件类型计数；月份键由 event_day 前 6 位拼出来）
  { id: 'q13', sql: `SELECT substr(event_day, 1, 4) || '-' || substr(event_day, 5, 2) AS ym, event_type, COUNT(*) AS val
      FROM fact_parcel_event GROUP BY 1, 2` },
  // 顺带验一个"键列是文本"的事实（不是查询，是核对）
  { id: 'keys', sql: `SELECT DISTINCT admin_code FROM dim_parcel` },
];
const jobFile = path.join(OUT, '_duck_job.json');
const duckFile = path.join(OUT, '_duck_result.json');
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(jobFile, JSON.stringify({
  views,
  queries: queries.map((q) => ({ id: q.id, sql: q.sql, out: path.join(SQL_DIR, `${q.id}.csv`).replace(/\\/g, '/') })),
}), 'utf8');

// ⚠️ 结果通过**文件**取回（显式 UTF-8）：Windows 上 python 的 stdout 是 cp936，
// 直接读 stdout 会把中文列名解成乱码 —— 表现为"含中文的对比全不匹配、纯 ASCII 的全通过"。
const run = spawnSync('python', ['tools/duck-run.py', jobFile, duckFile], {
  encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
});
if (run.status !== 0) {
  /*
   * ⚠️ 这里**必须红**。原来写的是"打印一行 warn 然后 exit 0"：只要某条 SQL 写错（列名改了、表删了），
   * 整包交叉验证就静默消失，而退出码仍是 0 —— 按退出码判断的脚本会得到"通过"。
   * 环境没有 DuckDB 是"跳过"（可选加强项），但**有 DuckDB 却跑挂了**是"失败"。
   */
  check(`DuckDB 侧执行 ${queries.length} 条 SQL`, false,
    `执行失败：${(run.stderr ?? '').split('\n').slice(-3).join(' ').slice(0, 200)}`);
  console.log(`\n================ ${pass} 通过 / ${fail} 失败 ================`);
  process.exit(1);
}
let duck;
try {
  duck = JSON.parse(fs.readFileSync(duckFile, 'utf8'));
} catch (err) {
  check('读回 DuckDB 结果（显式 UTF-8 文件）', false, String(err.message).slice(0, 140));
  console.log(`\n================ ${pass} 通过 / ${fail} 失败 ================`);
  process.exit(1);
}
const R = Object.fromEntries(duck.results.map((r) => [r.id, r]));
const selfQ = (id) => self.queries.find((q) => q.id === id);
console.log(`  视图 ${views.length} 张（all_varchar：键列留文本）· SQL 查询 ${queries.length} 条 · 产物 ${path.relative(process.cwd(), SQL_DIR)}/`);

// ---------- 3. 判据：逐格对比 ----------
// 3.1 读入无损 + 键列形态
{
  const t = R.keys.rows.map((r) => r[0]);
  check('DuckDB 读入 CSV：**键列保持文本**（`09186162` 的前导零没被吃掉）',
    t.length === 1 && t[0] === R.keys.rows[0][0] && String(t[0]).startsWith('0') && String(t[0]).length === 8,
    `admin_code = ${JSON.stringify(t[0])}（长度 ${String(t[0]).length}）`);
}
{
  const my = self.queries.find((q) => q.id === 'q2');
  const duckRows = R.q2.rows.length;
  check('同一批 CSV 在两套引擎里的**行数一致**（读入没有静默丢行/错位）',
    duckRows === my.n && duckRows === 3348, `DuckDB ${duckRows} 行 vs 自研 ${my.n} 条观测`);
}

/** 把自研的矩阵摊平成 Map（`row\u0000col` → 值），与 SQL 的长表结果逐格比 */
function comparePivot(id, selfQq, { colIdx = [0, 1], valIdx = 2, label = '' } = {}) {
  const sqlMap = new Map();
  for (const r of R[id].rows) sqlMap.set(`${r[colIdx[0]]}\u0000${r[colIdx[1]]}`, r[valIdx]);
  const myMap = new Map();
  selfQq.rowKeys.forEach((rk, ri) => selfQq.colKeys.forEach((ck, ci) => {
    const v = selfQq.matrix[ri][ci];
    if (v !== '' && v !== null && v !== undefined) myMap.set(`${rk}\u0000${ck}`, v);
  }));
  const onlyMine = [];
  let worst = 0;
  let bad = 0;
  for (const [k, v] of myMap) {
    if (!sqlMap.has(k)) { onlyMine.push(k); continue; }
    const d = Math.abs(Number(v) - Number(sqlMap.get(k)));
    worst = Math.max(worst, d / Math.max(1, Math.abs(Number(sqlMap.get(k)))));
    if (!close(v, sqlMap.get(k))) bad++;
  }
  const onlySql = [...sqlMap.keys()].filter((k) => !myMap.has(k));
  check(`交叉验证 ${id}${label ? `（${label}）` : ''}：**逐格一致**（${myMap.size} 格，含"哪些格子有值"也要一致）`,
    // ⚠️ 必须同时要求两侧**非空**：只判 bad===0 时，两侧都为空会让它"空过"
    myMap.size > 0 && sqlMap.size > 0 && myMap.size === sqlMap.size
      && bad === 0 && onlyMine.length === 0 && onlySql.length === 0,
    `不一致 ${bad} 格 · 只在自研侧 ${onlyMine.length} 格 · 只在 DuckDB 侧 ${onlySql.length} 格 · 最大相对差 ${worst.toExponential(1)}`);
  return { myMap, sqlMap };
}

{
  // q1 的行维是「作物 · 口径」两列 → 自研侧的 rowKey 是 `作物 · 口径`，SQL 侧要拼成同样的键
  const q = selfQ('q1');
  const sqlMap = new Map(R.q1.rows.map((r) => [`${r[0]} · ${r[1]}\u0000${r[2]}`, r[3]]));
  const myMap = new Map();
  q.rowKeys.forEach((rk, ri) => q.colKeys.forEach((ck, ci) => {
    if (q.matrix[ri][ci] !== '') myMap.set(`${rk}\u0000${ck}`, q.matrix[ri][ci]);
  }));
  let bad = 0;
  for (const [k, v] of myMap) if (!sqlMap.has(k) || !close(v, sqlMap.get(k))) bad++;
  check('交叉验证 q1：**单产（行=作物·口径 × 列=年）逐格一致**',
    myMap.size > 0 && bad === 0 && sqlMap.size === myMap.size,
    `${myMap.size} 格，不一致 ${bad}；口径在行维 ⇒ 格子内不会混口径`);
}
comparePivot('q2', selfQ('q2'), { label: '单元 × 旬 进度矩阵' });
comparePivot('q3', selfQ('q3'), { label: '网格 × 作物 面积' });
comparePivot('q4', selfQ('q4'), { label: '日期 × 变量 观测' });
comparePivot('q7', selfQ('q7'), { label: '分区 × 作物（走 SQL JOIN）' });
comparePivot('q13', selfQ('q13'), { label: '月 × 事件类型（农事日历）' });

{
  // DuckDB 原生 PIVOT 出来的宽表，和自研的矩阵比（比"长表聚合"更能暴露实现差异）
  const q = selfQ('q2');
  const rows = R.q2pivot.rows;
  const cols = R.q2pivot.cols;
  const byUnit = new Map(rows.map((r) => [r[0], r]));
  let bad = 0;
  let missing = 0;
  q.rowKeys.forEach((rk, ri) => {
    const row = byUnit.get(rk);
    if (!row) { missing++; return; }
    q.colKeys.forEach((ck, ci) => {
      const v = q.matrix[ri][ci];
      const dv = row[cols.indexOf(ck)];
      if (v === '') { if (dv !== null && dv !== undefined) bad++; return; }
      if (!close(v, dv)) bad++;
    });
  });
  check('交叉验证：DuckDB **原生 `PIVOT ... ON ... USING` 宽表** == 自研透视矩阵',
    // 同样要求非空：宽表列数必须 >1（除 unit_id 外至少有一旬）且行维非空
    q.rowKeys.length > 0 && cols.length > 1 && bad === 0 && missing === 0,
    `${q.rowKeys.length} 行 × ${q.colKeys.length} 列，不一致 ${bad}，缺行 ${missing}`);
}

{
  const q = selfQ('q5');
  const mine = q.rows.map((r) => r.parcel_id).sort();
  const sql = R.q5.rows.map((r) => r[0]).sort();
  const same = mine.length === sql.length && mine.every((x, i) => x === sql[i]);
  check('交叉验证 q5：**多条件联合筛选命中集合完全一致**（主键逐个对，不是只比个数）',
    mine.length > 0 && same, `自研 ${mine.length} 块 vs DuckDB ${sql.length} 块${same ? '（集合相同）' : `；首个差异 ${mine.find((x, i) => x !== sql[i]) ?? '（长度不同）'}`}`);
}

{
  const q = selfQ('q6');
  const mine = new Map(q.rows.filter((r) => r.level === 'Gemeinde').map((r) => [r.admin_code, r]));
  /*
   * 面积曾经用 ±0.05 ha 的绝对容差（因为自研侧为了可读性 round 到 1 位小数），
   * 那样"系统性偏 0.049 ha"也会判过 —— 现在自研侧按 6 位小数输出，容差回到通用相对容差（1e-6）。
   */
  const closeArea = (a, b) => close(a, b);
  let bad = 0;
  for (const r of R.q6.rows) {
    const m = mine.get(r[0]);
    if (!m || !close(m.n_grids, r[1]) || !close(m.n_units, r[2]) || !close(m.n_parcels, r[3]) || !closeArea(m.area_ha, r[4])) bad++;
  }
  check('交叉验证 q6：**四层钻取链的逐层去重计数一致**（网格/单元/地块/面积四项）',
    mine.size > 0 && bad === 0 && R.q6.rows.length === mine.size,
    `${R.q6.rows.length} 个行政区划，不一致 ${bad}`);
}

// 中间文件用完即删（SQL 侧 CSV 与自研 JSON 保留下来，便于人工核对）
for (const f of ['_duck_job.json', '_duck_result.json']) fs.rmSync(path.join(OUT, f), { force: true });

/**
 * 汇总型查询的对比：**逐行逐列**比（不是只比行数）。
 * 键列取自研侧的 `cols[0]`；其余列按 `listCols` 顺序与 SQL 的 SELECT 顺序一一对应。
 */
function compareAgg(id, label) {
  const q = selfQ(id);
  if (!q) return;
  const mine = new Map(q.rows.map((r) => [String(r[q.cols[0]]), r]));
  const sql = R[id].rows;
  let bad = 0;
  const diffs = [];
  for (const r of sql) {
    const m = mine.get(String(r[0]));
    if (!m) { bad++; if (diffs.length < 3) diffs.push(`${r[0]}:自研侧缺`); continue; }
    q.cols.slice(1).forEach((c, i) => {
      if (!close(m[c], r[i + 1])) {
        bad++;
        if (diffs.length < 3) diffs.push(`${r[0]}.${c}: ${m[c]} vs ${r[i + 1]}`);
      }
    });
  }
  check(`交叉验证 ${id}：**${label}** 逐行逐列一致`,
    mine.size > 0 && sql.length > 0 && bad === 0 && sql.length === mine.size,
    `${sql.length} 行 × ${q.cols.length - 1} 个度量 · 不一致 ${bad}${diffs.length ? `（${diffs.join('; ')}）` : ''}`);
}

compareAgg('q8', '区域逐日 → 年月（降水合计 / 湿度与进度均值 / 病级峰值）');
compareAgg('q9', '农事事件 → 年 × 类型计数');
compareAgg('q10', '地块季 → 作物（季数 / 总产 / 平均单产 / 病级峰值）');
compareAgg('q11', '单元 × 旬 → 旬（单元数 / 收获与播种面积 / 进度均值）');
compareAgg('q12', '单产两套口径（季等权 / Σ总产÷Σ面积）');
compareAgg('q14', '收获排产压力（按日：块数 / 面积 / 产量 / 加权运距 / 吨·分钟）');

console.log(`\n================ ${pass} 通过 / ${fail} 失败 ================`);
console.log(`SQL 侧产物：${path.relative(process.cwd(), SQL_DIR)}/（保留下来便于人工核对）`);
process.exit(fail ? 1 : 0);
