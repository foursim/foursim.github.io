"""临时补丁：把剩余事实表纳入交叉验证（4 个汇总查询 + 4 条 SQL 对比）（用完即删）"""
import io

# ==================== ① query.mjs：4 个汇总查询（q8~q11） ====================
P = 'tools/query.mjs'
s = io.open(P, encoding='utf-8').read()
old = """// ===================== 输出 ====================="""
assert s.count(old) == 1
new = """  /*
   * 下面四条是**汇总型查询**：把剩下的事实表（区域逐日 / 农事事件 / 地块季 / 单元旬）各自压一层，
   * 目的有两个 —— 交付侧能直接看，以及**给 DuckDB 侧留出可逐行逐列对比的靶子**
   * （原来只对 5 张做了交叉验证，剩下 4 张事实表没有任何独立实现核过）。
   * 数值一律 round(…, 6)：只为可读性收窄，不给交叉验证制造容差借口。
   */
  {
    id: 'q8',
    title: '区域逐日 → 按年月汇总',
    question: '每个月的水热与进度（降水合计 / 湿度均值 / 进度均值 / 病级峰值）',
    build: (T) => {
      const rows = T.get('fact_region_daily').rows;
      const agg = new Map();
      for (const r of rows) {
        const k = String(r.date_key).slice(0, 6);
        if (!agg.has(k)) agg.set(k, { ym: k, n: 0, prec: 0, hum: 0, prog: 0, dis: 0 });
        const a = agg.get(k);
        a.n += 1;
        a.prec += Number(r.precip_mm) || 0;
        a.hum += Number(r.humidity_pct) || 0;
        a.prog += Number(r.crop_progress) || 0;
        a.dis = Math.max(a.dis, Number(r.disease_level_max) || 0);
      }
      const out = [...agg.values()].sort((x, y) => x.ym.localeCompare(y.ym)).map((a) => ({
        year_month: a.ym, n_days: a.n, precip_sum_mm: round(a.prec, 6), humidity_mean_pct: round(a.hum / a.n, 6),
        progress_mean: round(a.prog / a.n, 6), disease_max: a.dis,
      }));
      return {
        kind: 'list', rows: out, unit: 'mm / % / 0~1 / 级',
        note: `fact_region_daily（区域 × 日）按年月汇总：${out.length} 个月 / ${rows.length} 天`,
        listCols: ['year_month', 'n_days', 'precip_sum_mm', 'humidity_mean_pct', 'progress_mean', 'disease_max'],
      };
    },
  },
  {
    id: 'q9',
    title: '农事事件 → 按年 × 类型计数',
    question: '每年播种/施肥/收获各多少次（农事流水的事实表）',
    build: (T) => {
      const rows = T.get('fact_parcel_event').rows;
      const agg = new Map();
      for (const r of rows) {
        const k = String(r.event_day).slice(0, 4);
        if (!agg.has(k)) agg.set(k, { year: k, sow: 0, fertilize: 0, harvest: 0, total: 0 });
        const a = agg.get(k);
        if (r.event_type === 'sow') a.sow += 1;
        else if (r.event_type === 'fertilize') a.fertilize += 1;
        else if (r.event_type === 'harvest') a.harvest += 1;
        a.total += 1;
      }
      const out = [...agg.values()].sort((x, y) => x.year.localeCompare(y.year));
      return {
        kind: 'list', rows: out, unit: '次',
        note: `fact_parcel_event（农事流水）按年汇总：${rows.length} 条事件`,
        listCols: ['year', 'sow', 'fertilize', 'harvest', 'total'],
      };
    },
  },
  {
    id: 'q10',
    title: '地块季 → 按作物汇总',
    question: '每类作物有多少季、总产多少、平均单产多少、最高病级（注意口径在 q1 里单独列）',
    build: (T) => {
      const rows = T.get('fact_parcel_season').rows;
      const agg = new Map();
      for (const r of rows) {
        const k = String(r.crop_code);
        if (!agg.has(k)) agg.set(k, { crop_code: k, n: 0, yt: 0, yha: 0, dis: 0, ha: 0 });
        const a = agg.get(k);
        a.n += 1;
        a.yt += Number(r.yield_t) || 0;
        a.yha += Number(r.yield_t_ha) || 0;
        a.dis = Math.max(a.dis, Number(r.disease_level_max) || 0);
      }
      const out = [...agg.values()].sort((x, y) => x.crop_code.localeCompare(y.crop_code)).map((a) => ({
        crop_code: a.crop_code, n_seasons: a.n, yield_t_total: round(a.yt, 6),
        yield_t_ha_avg: round(a.yha / a.n, 6), disease_max: a.dis,
      }));
      return {
        kind: 'list', rows: out, unit: 't / t/ha / 级',
        note: `fact_parcel_season（地块 × 季）按作物汇总：${rows.length} 季`,
        listCols: ['crop_code', 'n_seasons', 'yield_t_total', 'yield_t_ha_avg', 'disease_max'],
      };
    },
  },
  {
    id: 'q11',
    title: '单元 × 旬 → 按旬汇总',
    question: '每旬有多少单元在作业、收获/播种面积合计、进度均值与病级峰值（作业调度看着用）',
    build: (T) => {
      const rows = T.get('fact_unit_decade').rows;
      const agg = new Map();
      for (const r of rows) {
        const k = String(r.decade_key);
        if (!agg.has(k)) agg.set(k, { decade_key: k, units: new Set(), harv: 0, sown: 0, prog: 0, n: 0, dis: 0 });
        const a = agg.get(k);
        a.units.add(String(r.unit_id));
        a.harv += Number(r.harvested_ha) || 0;
        a.sown += Number(r.sown_ha) || 0;
        a.prog += Number(r.progress_mean) || 0;
        a.n += 1;
        a.dis = Math.max(a.dis, Number(r.disease_level_max) || 0);
      }
      const out = [...agg.values()].sort((x, y) => x.decade_key.localeCompare(y.decade_key)).map((a) => ({
        decade_key: a.decade_key, n_units: a.units.size, harvested_ha: round(a.harv, 6),
        sown_ha: round(a.sown, 6), progress_mean: round(a.prog / a.n, 6), disease_max: a.dis,
      }));
      return {
        kind: 'list', rows: out, unit: 'ha / 0~1 / 级',
        note: `fact_unit_decade（单元 × 旬）按旬汇总：${out.length} 旬 × ${rows.length} 行`,
        listCols: ['decade_key', 'n_units', 'harvested_ha', 'sown_ha', 'progress_mean', 'disease_max'],
      };
    },
  },
];

// ===================== 输出 ====================="""
# 注意：上面这段要插在 PRESETS 数组结束之前 ⇒ 把结尾的 "];" 一起替换掉
old2 = """  {
    id: 'q7',"""
assert s.count(old2) == 1
# 直接在 PRESETS 的收尾处插入：先定位 PRESETS 数组结尾（q7 之后紧跟的输出区段标题）
s = s.replace("""// ===================== 输出 =====================
""", "", 1)   # 先摘掉标题（稍后 new 里已包含）
old3 = """];

// ---------- 多 sheet Excel"""
assert s.count(old3) == 1
s = s.replace(old3, new + """
// ---------- 多 sheet Excel""", 1)
io.open(P, 'w', encoding='utf-8').write(s)
print('[ok] query.mjs q8~q11')

# ==================== ② query-sql.mjs：4 条 SQL + 逐行逐列对比 ====================
P = 'tools/query-sql.mjs'
s = io.open(P, encoding='utf-8').read()
old = """  // 顺带验一个"键列是文本"的事实（不是查询，是核对）"""
assert s.count(old) == 1
s = s.replace(old, """  // 剩下 4 张事实表也要有独立实现核过（原来只覆盖了 5 张）
  { id: 'q8', sql: `SELECT substr(date_key, 1, 6) AS ym, COUNT(*) AS n_days, SUM(${dbl('precip_mm')}) AS prec,
      AVG(${dbl('humidity_pct')}) AS hum, AVG(${dbl('crop_progress')}) AS prog, MAX(CAST(disease_level_max AS INTEGER)) AS dis
      FROM fact_region_daily GROUP BY 1 ORDER BY 1` },
  { id: 'q9', sql: `SELECT substr(event_day, 1, 4) AS y,
      SUM(CASE WHEN event_type = 'sow' THEN 1 ELSE 0 END) AS sow,
      SUM(CASE WHEN event_type = 'fertilize' THEN 1 ELSE 0 END) AS fert,
      SUM(CASE WHEN event_type = 'harvest' THEN 1 ELSE 0 END) AS harv, COUNT(*) AS total
      FROM fact_parcel_event GROUP BY 1 ORDER BY 1` },
  { id: 'q10', sql: `SELECT crop_code, COUNT(*) AS n, SUM(${dbl('yield_t')}) AS yt,
      AVG(${dbl('yield_t_ha')}) AS yha, MAX(CAST(disease_level_max AS INTEGER)) AS dis
      FROM fact_parcel_season GROUP BY 1 ORDER BY 1` },
  { id: 'q11', sql: `SELECT decade_key, COUNT(DISTINCT unit_id) AS units, SUM(${dbl('harvested_ha')}) AS harv,
      SUM(${dbl('sown_ha')}) AS sown, AVG(${dbl('progress_mean')}) AS prog, MAX(CAST(disease_level_max AS INTEGER)) AS dis
      FROM fact_unit_decade GROUP BY 1 ORDER BY 1` },
  // 顺带验一个"键列是文本"的事实（不是查询，是核对）""", 1)

old2 = """console.log(`\\n================ ${pass} 通过 / ${fail} 失败 ================`);"""
assert s.count(old2) == 1
s = s.replace(old2, """/**
 * 汇总型查询的对比：**逐行逐列**比（不是只比行数）。
 * 键列在自研侧是 `cols[0]`，其余列按 `listCols` 的顺序与 SQL 的 SELECT 顺序一一对应。
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
  check(`交叉验证 ${id}：**${label}** 逐行逐列一致`, bad === 0 && sql.length === mine.size,
    `${sql.length} 行 × ${q.cols.length - 1} 个度量 · 不一致 ${bad}${diffs.length ? `（${diffs.join('; ')}）` : ''}`);
}

compareAgg('q8', '区域逐日 → 年月（降水合计/湿度与进度均值/病级峰值）');
compareAgg('q9', '农事事件 → 年 × 类型计数');
compareAgg('q10', '地块季 → 作物（季数/总产/平均单产/病级峰值）');
compareAgg('q11', '单元 × 旬 → 旬（单元数/收获与播种面积/进度均值）');

console.log(`\\n================ ${pass} 通过 / ${fail} 失败 ================`);""", 1)
io.open(P, 'w', encoding='utf-8').write(s)
print('[ok] query-sql.mjs +4 条对比')
