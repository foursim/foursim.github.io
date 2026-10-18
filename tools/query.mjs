#!/usr/bin/env node
/**
 * 透视与联合查询（`npm run query`）—— **纯 node、零依赖**。
 *
 * ## 为什么必须有这一层
 *
 * 星型模型的代价：事实表里**只有键**（`parcel_id` / `unit_id` / `crop_code`…），
 * 想读一眼就得先把维度表连上；而"各单元逐旬进度""各网格各作物面积"这类问题，
 * 本质是**透视**（行维 × 列维 × 度量 × 聚合）。这两件事以前只能靠人拿 Excel 手点，
 * 于是"数字怎么来的"就说不清了 —— 这个工具把它们变成**可复现、可判据**的固定动作。
 *
 * ## 三个原语
 *
 * | 原语 | 作用 | 在这份数据上的例子 |
 * |---|---|---|
 * | `joinStar` | 事实表 ⟕ 维度表（**展开**外键，行数不变） | `fact_parcel_season` ⟕ `dim_crop` ⇒ 拿到 `yield_basis`（单产口径） |
 * | `pivot` | 行维 × 列维 × 度量 × 聚合（sum/mean/count/min/max） | 单元 × 旬 ⇒ `progress_mean` 进度矩阵 |
 * | `WHERE` | 跨字段多条件（**联合查询**的筛选形态） | 到收储点 > 12 分 且 有机碳 < 25 且 病级 ≥ 3 |
 *
 * ## 几条"不许糊过去"的规矩
 *
 * 1. **连接不许膨胀行数**：维度键在其表里必须唯一（判据查这个），否则一次 join 就把事实放大成多倍，
 *    而外面看不出来 —— 这是数据分析里最经典的静默错误；
 * 2. **外键不许有孤儿**：事实表里出现维度表里没有的键，说明导出两侧口径已经漂了（判据查这个）；
 * 3. **单产不许跨口径平均**：`dim_crop.yield_basis` 分籽粒/鲜重/干花/干草/鲜果，把它们平均出来
 *    是个没有意义的数 ⇒ 一个格子里混了口径就**标 `*` 并列出**，绝不静默出数（判据查这个）；
 * 4. **透视要守恒**：`sum` 聚合的合计必须等于原列合计（判据查这个）。
 *
 * 用法：
 *   npm run query                    # 跑全部预置查询，写 tables/query/ 并跑判据
 *   npm run query -- --list          # 列出预置查询
 *   npm run query -- --q q2          # 只跑一条（打印 + 写文件）
 *   npm run query -- --join fact_unit_decade   # 看某个事实表连上维度后的列与样例
 *   npm run query -- --check         # 只跑判据（供全量重跑用）
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > -1 ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes(`--${k}`);
const TABLES = arg('tables', 'tables');
const DATA = arg('data', 'data');   // q15 要读离线情景推演结果（data/scenario.json）
const OUT = arg('out', path.join(TABLES, 'query'));

let pass = 0;
let fail = 0;
function check(label, ok, detail = '') {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? '  [OK]  ' : '  [FAIL]'} ${label}${detail ? ` — ${detail}` : ''}`);
}
const round = (v, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : v);

// ===================== CSV 读取 =====================

/**
 * 规范 CSV 解析（引号、转义双引号、字段内逗号与换行）。
 *
 * ⚠️ 不能用 `split(',')`：本项目的字段里真的含逗号（`dim_admin.scheme`、`crop_mix` 这类说明文本），
 * 一 split 就整体错位，而且错位之后**行列数还对得上**（只是全挪了一位），最容易被忽略。
 */
function parseCsv(text) {
  const rows = [];
  let cur = [];
  let val = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { val += '"'; i++; } else q = false;
      } else val += c;
    } else if (c === '"') q = true;
    else if (c === ',') { cur.push(val); val = ''; }
    else if (c === '\n') { cur.push(val); rows.push(cur); cur = []; val = ''; }
    else if (c !== '\r') val += c;
  }
  if (val !== '' || cur.length) { cur.push(val); rows.push(cur); }
  return rows.filter((r) => r.length > 1 || (r[0] ?? '') !== '');
}

/** 数据元字典：列 → { 类型/单位/中文名 }。数据元字典的第二次发挥：**查询结果也按它的口径解释** */
function loadElementIndex() {
  const idx = new Map();
  const f = path.join(TABLES, 'dim_data_element.csv');
  if (!fs.existsSync(f)) return idx;
  const [h, ...rows] = parseCsv(fs.readFileSync(f, 'utf8'));
  const c = (n) => h.indexOf(n);
  for (const r of rows) idx.set(`${r[c('table_name')]}.${r[c('column_name')]}`, {
    type: r[c('data_type')], uom: r[c('uom')], zh: r[c('name_zh')], note: r[c('note')],
  });
  return idx;
}

const ELEMENTS = loadElementIndex();

/**
 * 读全部表。数值列按数据元字典的 `data_type` 转数 ——
 * ⚠️ 编码/标识列必须留文本：`09186` 转成数字会**吃掉前导零**（这个坑在导出侧踩过一次）。
 */
/** 解析单张表（列级决策**只算一次**，见下面的注释） */
function parseTableFile(file, name) {
  const [head, ...rows] = parseCsv(fs.readFileSync(file, 'utf8'));
  /*
   * **列级决策一次算好**：`meta` 查表与 `_code/_id` 的判定只取决于**列名**，
   * 原来放在单元格循环里 ⇒ 275k 行 × 20 列 = 550 万次 Map.get + 正则（加载 4.9s 的主因）。
   * 另外把"没有数据元字典的列"用**抽样**判一次是否数值（原实现每格都跑一次数值正则）；
   * 抽样只判"这一列看起来是不是数"，具体值仍然逐格 `Number()`，语义不变。
   */
  const plan = head.map((h) => {
    const meta = ELEMENTS.get(`${name}.${h}`);
    if (meta) return { h, kind: meta.type === 'number' ? 'num' : 'txt' };
    if (/(_code|_id)$/.test(h)) return { h, kind: 'txt' };
    const probe = rows.slice(0, 64).filter((r) => (r[head.indexOf(h)] ?? '') !== '');
    const looksNum = probe.length > 0 && probe.every((r) => /^-?\d+(\.\d+)?$/.test(r[head.indexOf(h)] ?? ''));
    return { h, kind: looksNum ? 'num' : 'txt' };
  });
  const recs = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const o = {};
    for (let c = 0; c < plan.length; c++) {
      const { h, kind } = plan[c];
      const raw = r[c] ?? '';
      o[h] = raw === '' ? '' : (kind === 'num' ? Number(raw) : raw);
    }
    recs[i] = o;
  }
  return { columns: head, rows: recs, rawRows: rows };
}

/**
 * 表注册表：**懒解析**（第一次 `get` 才读盘解析）。
 * `--only q14` 这类单表场景不必为 16 MB 付全额代价；`values/entries` 会强制全量（少数全表校验用）。
 */
class TableStore {
  constructor(dir, files) {
    this.dir = dir;
    this.files = files;
    this.cache = new Map();
    this.tracing = null;              // 当前正在构建的查询 id（由主循环设置）
    this.reads = new Map();           // 查询 id → 读到的表名集合
    this.sampleTrace = false;         // `--deps` 时打开：给前几行套 Proxy 记录**列级**依赖
    this.cols = new Map();            // 查询 id → (表名 → 读到的列集合)
  }
  get(name) {
    // **依赖追踪**：记下"当前正在构建的查询读了哪张表"（`--deps` 打印，判据也用它）
    if (this.tracing) {
      if (!this.reads.has(this.tracing)) this.reads.set(this.tracing, new Set());
      this.reads.get(this.tracing).add(name);
    }
    if (this.cache.has(name)) return this.cache.get(name);
    const f = path.join(this.dir, `${name}.csv`);
    if (!fs.existsSync(f)) return undefined;
    const t = parseTableFile(f, name);
    /*
     * **列级追踪**（只在 `--deps` 审计模式下开）：给前 3 行套 Proxy，记录"谁读了哪一列"。
     *
     * 为什么用 Proxy 而不是静态扫描：静态扫描分不清"注释里提到"和"真的读了" ——
     * 上一版就因此把 206 列全算成"有引用"（等于没查）。Proxy 记录的是**真实属性访问**。
     * 为什么只包前 3 行：查询对同一张表的每一行读的列是一样的（按列名读或整体遍历），
     * 采样 3 行足够，且不影响性能。**只在审计模式开**：正常跑不套代理，零风险零开销。
     */
    if (this.sampleTrace) {
      for (let i = 0; i < Math.min(3, t.rows.length); i++) {
        const raw = t.rows[i];
        t.rows[i] = new Proxy(raw, {
          get: (o, k) => {
            if (this.tracing && typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k)) {
              if (!this.cols.has(this.tracing)) this.cols.set(this.tracing, new Map());
              const perTable = this.cols.get(this.tracing);
              if (!perTable.has(name)) perTable.set(name, new Set());
              perTable.get(name).add(k);
            }
            return o[k];
          },
        });
      }
    }
    this.cache.set(name, t);
    return t;
  }
  has(name) { return fs.existsSync(path.join(this.dir, `${name}.csv`)); }
  get size() { return this.files.length; }
  get loaded() { return this.cache.size; }
  names() { return this.files.map((f) => path.basename(f, '.csv')); }
  *keys() { yield* this.names(); }
  *values() { for (const k of this.names()) yield this.get(k); }
  *entries() { for (const k of this.names()) yield [k, this.get(k)]; }
}

function loadTables(dir) {
  return new TableStore(dir, fs.readdirSync(dir).filter((x) => x.endsWith('.csv')).map((f) => path.join(dir, f)));
}

// ===================== 原语：星型连接 =====================

const ALIAS = { dim_parcel: 'p', dim_unit: 'u', dim_grid: 'g', dim_crop: 'c', dim_admin: 'a' };

/**
 * 事实表 ⟕ 维度表：按 `on` 把维度列**展开**进事实表（外键 → 可读列）。
 *
 * - 行数**必须不变**（维度键在其表里唯一；重复键会被本函数直接抛错，而不是静默放大）；
 * - 重名列加别名前缀（`dim_parcel.area_ha` → `p_area_ha`），并把改名的事实**写进返回的 renamed**，
 *   免得"列名怎么变了"变成口头传说。
 */
function joinStar(T, baseName, specs) {
  const base = T.get(baseName);
  if (!base) throw new Error(`没有这张表：${baseName}`);
  const dims = specs.map((s) => {
    const d = T.get(s.table);
    if (!d) throw new Error(`连接目标不存在：${s.table}`);
    const keys = d.rows.map((r) => r[s.on]);
    if (new Set(keys).size !== keys.length) throw new Error(`${s.table}.${s.on} 有重复键 ⇒ 连接会放大行数，拒绝执行`);
    return { ...s, alias: ALIAS[s.table] ?? s.table.replace(/^dim_/, '').charAt(0), map: new Map(d.rows.map((r) => [r[s.on], r])) };
  });
  const existing = new Set(base.columns);
  const renamed = [];
  const pickCols = [];
  for (const d of dims) {
    for (const col of d.pick) {
      const name = existing.has(col) ? `${d.alias}_${col}` : col;
      if (name !== col) renamed.push(`${col}→${name}`);
      existing.add(name);
      pickCols.push({ name, from: col, d });
    }
  }
  const columns = [...base.columns, ...pickCols.map((p) => p.name)];
  const missing = new Map(); // 外键在维度表里找不到的（孤儿）
  const rows = base.rows.map((r) => {
    const o = { ...r };
    for (const p of pickCols) {
      const hit = p.d.map.get(r[p.d.on]);
      if (!hit) {
        missing.set(p.d.table, (missing.get(p.d.table) ?? 0) + 1);
        o[p.name] = '';
      } else o[p.name] = hit[p.from];
    }
    return o;
  });
  return { name: baseName, columns, rows, renamed, missing, specs };
}

/** 连接预设：每张事实表"读之前"该连哪些维度（星型模型的中心→辐条） */
const STAR = {
  fact_unit_decade: [
    { table: 'dim_unit', on: 'unit_id', pick: ['unit_code', 'grid_id', 'dominant_crop', 'fallow_ha'] },
    { table: 'dim_grid', on: 'grid_id', pick: ['grid_code', 'grid_m'] },
  ],
  fact_parcel_season: [
    { table: 'dim_parcel', on: 'parcel_id', pick: ['parcel_code', 'unit_id', 'grid_id', 'area_ha', 'landuse', 'soil_texture', 'soil_organic_matter', 't_min_to_store'] },
    { table: 'dim_crop', on: 'crop_code', pick: ['hierarchy_l1', 'yield_basis', 'yield_ref', 'base_temp_c'] },
  ],
  fact_zone: [
    { table: 'dim_parcel', on: 'parcel_id', pick: ['parcel_code', 'unit_id', 'grid_id', 'area_ha', 'crop_name_zh', 'disease_level_max', 't_min_to_store', 'soil_organic_matter'] },
  ],
  dim_parcel: [
    { table: 'dim_unit', on: 'unit_id', pick: ['unit_code', 'dominant_crop', 'n_parcels'] },
    { table: 'dim_grid', on: 'grid_id', pick: ['grid_code', 'grid_m'] },
    // 地块自带 admin_code（乡级）⇒ 一次连接把行政区划连上；再往上（县）走 dim_admin.parent_code，
    // 所以"地块 → 单元 → 网格 → 乡 → 县"是一条**真链**，不是拿编码前缀拼字符串
    { table: 'dim_admin', on: 'admin_code', pick: ['level', 'name', 'parent_code'] },
  ],
  fact_observation: [
    { table: 'dim_variable', on: 'variable_code', pick: ['name_zh', 'uom', 'temporal_grain'] },
  ],
};

/** 事实表 + 星型维度（`--join` 与预置查询都用它） */
function star(T, baseName) {
  const specs = STAR[baseName];
  return specs ? joinStar(T, baseName, specs) : { name: baseName, columns: T.get(baseName).columns, rows: T.get(baseName).rows, renamed: [], missing: new Map(), specs: [] };
}

// ===================== 原语：透视 =====================

const AGGS = {
  sum: (v) => v.reduce((a, b) => a + b, 0),
  mean: (v) => v.reduce((a, b) => a + b, 0) / v.length,
  count: (v) => v.length,
  min: (v) => Math.min(...v),
  max: (v) => Math.max(...v),
};

/**
 * 透视：行维 × 列维 × 度量 × 聚合 ⇒ 二维矩阵（含行/列合计）。
 *
 * 除矩阵外还返回：
 * - `n`：每个格子的**样本数**（`mean` 只看均值不看样本数，是很容易骗人的）；
 * - `flags`：格子上"口径混杂"之类的标记（见 `mixBy`），配 `notes` 说明；
 * - `preserve`：合计值（供判据做**守恒**校验）。
 */
function pivot(rows, { rowDims, colDim, value, agg = 'mean', mixBy = null, sortKeys = null, sortCols = null }) {
  const fn = AGGS[agg];
  if (!fn) throw new Error(`不支持的聚合：${agg}`);
  const rowKeys = [];
  const colKeys = [];
  const cell = new Map();   // `${rKey}\u0000${cKey}` → [值]
  const mix = new Map();    // 同上 → Set(mixBy 的取值)
  for (const r of rows) {
    const rk = rowDims.map((d) => String(r[d] ?? '')).join(' · ');
    const ck = String(r[colDim] ?? '');
    if (!rowKeys.includes(rk)) rowKeys.push(rk);
    if (!colKeys.includes(ck)) colKeys.push(ck);
    const k = `${rk}\u0000${ck}`;
    const v = r[value];
    if (v === '' || v === null || v === undefined || Number.isNaN(Number(v))) continue;
    if (!cell.has(k)) cell.set(k, []);
    cell.get(k).push(Number(v));
    if (mixBy) {
      if (!mix.has(k)) mix.set(k, new Set());
      mix.get(k).add(String(r[mixBy] ?? ''));
    }
  }
  // 角标：混了口径的格子不许静默出数
  const flags = new Map();
  const notes = [];
  if (mixBy) {
    for (const [k, set] of mix) {
      const vals = [...set].filter((x) => x !== '');
      if (vals.length > 1) {
        flags.set(k, '*');
        notes.push(`格子里混了口径（${mixBy}）：${vals.join(' / ')}`);
      }
    }
  }
  /*
   * **时间维必须按时间排**：`rowKeys/colKeys` 默认是"首次出现顺序"，对"月/年"这种维度就是乱的
   * —— 实测农事日历显示成 2024-10, 2025-07, 2025-10, 2024-07…（x 轴跳着走），q1 的年份列是 2025|2026|2024。
   * 零填充的编码（`2024-07` / `202410` / `2025`）按字典序排就等于按时间排，所以不必引日期库。
   * ⚠️ 排序必须放在**算 matrix / rowTotals / colTotals 之前**：那些都是按键的**下标**织起来的，
   * 排在后面就是"键换了位置、值没换"（判据当场报 2024-04 行合计 227 ≠ 57）。
   * 默认**不动**（网格/作物/分区这类无序维保持原样），要排的维度自己声明。
   */
  const asc = (a, b) => String(a).localeCompare(String(b));
  if (sortKeys === 'asc') rowKeys.sort(asc);
  if (sortCols === 'asc') colKeys.sort(asc);
  const matrix = rowKeys.map((rk) => colKeys.map((ck) => {
    const v = cell.get(`${rk}\u0000${ck}`);
    return v && v.length ? fn(v) : '';
  }));
  const rowTotals = rowKeys.map((rk) => {
    const all = colKeys.flatMap((ck) => cell.get(`${rk}\u0000${ck}`) ?? []);
    return all.length ? fn(all) : '';
  });
  const colTotals = colKeys.map((ck) => {
    const all = rowKeys.flatMap((rk) => cell.get(`${rk}\u0000${ck}`) ?? []);
    return all.length ? fn(all) : '';
  });
  const grandAll = [...cell.values()].flat();
  return {
    rowDims, colDim, value, agg, mixBy, sortKeys, sortCols,
    rowKeys, colKeys,
    cells: (rk, ck) => cell.get(`${rk}\u0000${ck}`) ?? [],
    matrix, rowTotals, colTotals,
    grand: grandAll.length ? fn(grandAll) : '',
    n: grandAll.length,
    flags: (rk, ck) => flags.get(`${rk}\u0000${ck}`) ?? '',
    notes: [...new Set(notes)],
  };
}

/** 跨字段多条件筛选（联合查询的 WHERE）：`[['t_min_to_store','>',12], ['crop_name_zh','in',['冬小麦']]]` */
function where(rows, conds) {
  return rows.filter((r) => conds.every(([col, op, val]) => {
    const x = r[col];
    const nx = Number(x);
    // ⚠️ 空值**不参与**数值比较：`Number('') === 0`，放着不管会把"没有这一列数据的行"算成命中
    // （SQL 侧 NULL 比较结果是未知 ⇒ 不命中；两边口径必须一致，这条是交叉验证抓出来的）
    if (x === '' || x === null || x === undefined || Number.isNaN(nx)) return false;
    if (op === '>') return nx > val;
    if (op === '>=') return nx >= val;
    if (op === '<') return nx < val;
    if (op === '<=') return nx <= val;
    if (op === '=') return String(x) === String(val);
    if (op === '!=') return String(x) !== String(val);
    if (op === 'in') return val.includes(String(x));
    if (op === 'notempty') return x !== '' && x !== null && x !== undefined;
    throw new Error(`不支持的比较符：${op}`);
  }));
}

// ===================== 预置查询（带名字的业务问题） =====================

const PRESETS = [
  {
    id: 'q1',
    title: '各作物 × 各年 的平均单产',
    question: '哪些作物哪一年的单产高？行标签自带单产口径（**籽粒/鲜重/干花/干草/鲜果之间不能比大小**）',
    build: (T) => {
      const s = star(T, 'fact_parcel_season');
      return {
        kind: 'pivot', rows: s.rows, note: `连接 ${s.name} ⟕ ${s.specs.map((x) => x.table).join(' ⟕ ')}`
          + '；口径：**每季等权**（不是面积加权 —— 要面积加权就用 q3/q10 的面积口径自己算 Σ产量/Σ面积）'
          + (s.renamed.length ? `（重名列加前缀：${s.renamed.join('、')}）` : ''),
        // 口径（yield_basis）**进行维**：一个格子只可能是同一种口径 ⇒ 结构上就杜绝了"跨口径平均"
        pivot: { rowDims: ['crop_name_zh', 'yield_basis'], colDim: 'season_year', value: 'yield_t_ha', agg: 'mean', mixBy: 'yield_basis', sortCols: 'asc' },
        unit: 't/ha',
      };
    },
  },
  {
    id: 'q2',
    title: '各经营单元 × 各旬 的平均生长进度',
    question: '哪个单元哪一旬落后？（62 单元 × 54 旬的进度矩阵）',
    build: (T) => {
      const s = star(T, 'fact_unit_decade');
      return {
        kind: 'pivot', rows: s.rows, unit: '0~1',
        note: `连接 ${s.name} ⟕ ${s.specs.map((x) => x.table).join(' ⟕ ')}`,
        pivot: { rowDims: ['unit_id'], colDim: 'decade_key', value: 'progress_mean', agg: 'mean', sortCols: 'asc' },
      };
    },
  },
  {
    id: 'q3',
    title: '各网格 × 各作物 的面积',
    question: '空间上各网格种了什么、各占多少（**长表转宽表**的典型）',
    build: (T) => {
      const s = star(T, 'dim_parcel');
      return {
        kind: 'pivot', rows: s.rows, unit: 'ha',
        note: `连接 ${s.name} ⟕ ${s.specs.map((x) => x.table).join(' ⟕ ')}`,
        pivot: { rowDims: ['grid_id'], colDim: 'crop_name_zh', value: 'area_ha', agg: 'sum' },
      };
    },
  },
  {
    id: 'q4',
    title: '观测长表 → 宽表（日期 × 变量）',
    question: '区域逐日的 8 个监测变量，一张宽表看全（原来在事实表里是长表）',
    build: (T) => {
      const s = star(T, 'fact_observation');
      return {
        kind: 'pivot', rows: s.rows, unit: '见变量单位',
        note: `连接 ${s.name} ⟕ ${s.specs.map((x) => x.table).join(' ⟕ ')}（变量单位随行携带，宽表混合单位，看数请对照 dim_variable）`,
        pivot: { rowDims: ['phenomenon_time'], colDim: 'variable_code', value: 'result_value', agg: 'mean', sortKeys: 'asc' },
      };
    },
  },
  {
    id: 'q5',
    title: '联合筛选：运距远 + 有机碳低 + 病级高的地块',
    question: '哪些地块同时"离收储点远、土壤有机碳低、病害重"？（阈值取实测分位数：运距 > 7 分≈p90、有机碳 < 21 g/kg≈p50、病级 ≥ 3）',
    build: (T) => {
      const s = star(T, 'dim_parcel');
      /*
       * 阈值为什么是 7 分 / 21 g/kg：**按实测分位数选**，不是拍脑袋。
       * 实测运距 p90 = 7.7 分、中位 4.4 分、**最大只有 11.8 分** —— dim_variable 里那条 "> 12 min"
       * 的治理告警在本演示区**永远不会触发**（阈值定在数据范围之外，这种"看着有、其实永不触发"的告警
       * 最容易被当成已有能力）。所以这里按分位数问一个**真能选出东西**的问题。
       */
      const hit = where(s.rows, [
        ['t_min_to_store', '>', 7],
        ['soil_organic_matter', '<', 21],
        ['disease_level_max', '>=', 3],
      ]);
      return {
        kind: 'list', rows: hit, unit: '—',
        note: `连接 ${s.name} ⟕ ${s.specs.map((x) => x.table).join(' ⟕ ')}；条件：到收储点 >7 分（≈p90；治理阈值 12 分在本区从未触发）∧ 有机碳 <21 g/kg（≈p50）∧ 病级 ≥3`,
        listCols: ['parcel_id', 'parcel_code', 'crop_name_zh', 'area_ha', 't_min_to_store', 'soil_organic_matter', 'disease_level_max', 'unit_code', 'grid_code'],
      };
    },
  },
  {
    id: 'q6',
    title: '四层空间钻取链（行政区划 → 网格 → 单元 → 地块）',
    question: '每个行政区划下有多少网格/单元/地块、多少面积（层级完整性一次看清）',
    build: (T) => {
      const s = star(T, 'dim_parcel');
      const agg = new Map();
      for (const r of s.rows) {
        const k = `${r.admin_code} · ${r.name ?? ''}`;
        if (!agg.has(k)) agg.set(k, { code: r.admin_code, name: r.name ?? '', parent: r.parent_code ?? '', grids: new Set(), units: new Set(), parcels: 0, area: 0 });
        const a = agg.get(k);
        a.grids.add(r.grid_id);
        a.units.add(r.unit_id);
        a.parcels += 1;
        a.area += Number(r.area_ha) || 0;
      }
      // 再上溯一级（Kreis）：链是"地块 → 单元 → 网格 → 乡 → 县"，两级都要看得见；
      // 县名从 dim_admin 按 parent_code 查（不猜、不拼字符串）
      const nameOf = new Map((T.get('dim_admin')?.rows ?? []).map((r) => [r.admin_code, r.name]));
      const up = new Map();
      for (const a of agg.values()) {
        const k = a.parent || '（无上级）';
        if (!up.has(k)) up.set(k, { grids: new Set(), units: new Set(), parcels: 0, area: 0 });
        const u = up.get(k);
        for (const g of a.grids) u.grids.add(g);
        for (const x of a.units) u.units.add(x);
        u.parcels += a.parcels;
        u.area += a.area;
      }
      const rows = [
        ...[...agg.values()].map((a) => ({
          level: 'Gemeinde', admin_code: a.code, admin_name: a.name, parent_code: a.parent,
          // 面积**不再四舍五入到 1 位**：那会让对比容差必须放宽到 ±0.05 ha（0.049 的系统偏差也能混过去）
          n_grids: a.grids.size, n_units: a.units.size, n_parcels: a.parcels, area_ha: round(a.area, 6),
        })),
        ...[...up.entries()].map(([code, u]) => ({
          level: 'Kreis', admin_code: code, admin_name: nameOf.get(code) ?? '', parent_code: '',
          n_grids: u.grids.size, n_units: u.units.size, n_parcels: u.parcels, area_ha: round(u.area, 6),
        })),
      ];
      return {
        kind: 'list', rows, unit: '—',
        note: `连接 ${s.name} ⟕ ${s.specs.map((x) => x.table).join(' ⟕ ')}（逐层去重计数）`,
        listCols: ['level', 'admin_code', 'admin_name', 'parent_code', 'n_grids', 'n_units', 'n_parcels', 'area_ha'],
      };
    },
  },
  {
    id: 'q7',
    title: '管理分区 × 作物 的地块数与面积',
    question: '分区分得对不对：同一作物在不同分区是否真有差异（分区建立在模拟属性上，见 dim_parcel）',
    build: (T) => {
      const z = T.get('fact_zone');
      const p = T.get('dim_parcel');
      const byId = new Map(p.rows.map((r) => [r.parcel_id, r]));
      const rows = z.rows.map((r) => ({ ...r, crop_name_zh: byId.get(r.parcel_id)?.crop_name_zh ?? '', unit_id: byId.get(r.parcel_id)?.unit_id ?? '' }));
      return {
        kind: 'pivot', rows, unit: 'ha',
        note: 'fact_zone ⟕ dim_parcel（取作物名，便于读分区结构）',
        pivot: { rowDims: ['zone_code'], colDim: 'crop_name_zh', value: 'area_ha_est', agg: 'sum' },
      };
    },
  },
  /*
   * 下面四条是**汇总型查询**：把剩下的事实表（区域逐日 / 农事事件 / 地块季 / 单元旬）各自压一层。
   * 目的有两个 —— 交付侧能直接看；以及**给另一套引擎留出可逐行逐列对比的靶子**。
   * 覆盖情况（`tables/` 下共 6 张 `fact_*`）：q1/q10 覆盖 fact_parcel_season、q2/q11 覆盖 fact_unit_decade、
   * q4 覆盖 fact_observation、q7 覆盖 fact_zone；本轮补上 fact_region_daily（q8）与 fact_parcel_event（q9），
   * 并对前两张的**汇总口径**（按年/按旬）也做了逐行逐列对比。
   * 数值一律 round(…, 6)：只是收窄可读性，不给交叉验证制造容差借口。
   * **求和与均值的空值语义不同**：求和把空值当 0（= SQL 的 SUM 忽略 NULL），均值**必须跳过空值**
   * （= SQL 的 AVG 忽略 NULL）。q10 曾因为把空值算进均值分母而差了整整 2 倍。
   */
  {
    id: 'q12',
    title: '单产两套口径对照（季等权 vs 面积加权）',
    question: '同一作物同一年，"每季一票"与"每公顷一票"的单产差多少？（面积加权 = Σ总产 ÷ Σ面积）',
    build: (T) => {
      const s = star(T, 'fact_parcel_season');   // 已连上 dim_parcel（面积）与 dim_crop（单产口径）
      const agg = new Map();
      for (const r of s.rows) {
        const k = `${r.crop_name_zh} · ${r.yield_basis} · ${r.season_year}`;
        if (!agg.has(k)) {
          agg.set(k, { k, n: 0, yt: 0, nyt: 0, ha: 0, yha: 0, nyha: 0 });
        }
        const a = agg.get(k);
        a.n += 1;
        const yt = r.yield_t;                    // 求和：空值当 0（= SQL 的 SUM 忽略 NULL）
        if (yt !== '' && yt !== null && yt !== undefined && !Number.isNaN(Number(yt))) { a.yt += Number(yt); a.nyt += 1; }
        a.ha += Number(r.area_ha) || 0;
        const v = r.yield_t_ha;                  // 均值：跳过空值（= SQL 的 AVG 忽略 NULL）
        if (v !== '' && v !== null && v !== undefined && !Number.isNaN(Number(v))) { a.yha += Number(v); a.nyha += 1; }
      }
      const out = [...agg.values()].sort((x, y) => x.k.localeCompare(y.k)).map((a) => ({
        key: a.k, n_seasons: a.n, area_ha: round(a.ha, 6),
        // ⚠️ 全是空值时保持"空"：0 与 NULL 语义不同（0 = 真·零收获，空 = 没有记录）
        yield_t_total: a.nyt ? round(a.yt, 6) : '',
        yield_t_ha_eq: a.nyha ? round(a.yha / a.nyha, 6) : '',
        yield_t_ha_area: a.nyt && a.ha ? round(a.yt / a.ha, 6) : '',
      }));
      return {
        kind: 'list', rows: out, unit: 't / ha / t·ha⁻¹',
        note: '口径对照：`yield_t_ha_eq` = 每季等权（q1 的场景平均就是它）；`yield_t_ha_area` = Σ总产 ÷ Σ面积（面积加权）',
        listCols: ['key', 'n_seasons', 'area_ha', 'yield_t_total', 'yield_t_ha_eq', 'yield_t_ha_area'],
      };
    },
  },
  {
    id: 'q8',
    title: '区域逐日 → 按年月汇总',
    question: '每个月的水热与进度（降水合计 / 湿度均值 / 进度均值 / 病级峰值）',
    build: (T) => {
      const rows = T.get('fact_region_daily').rows;
      const agg = new Map();
      for (const r of rows) {
        const k = String(r.date_key).slice(0, 6);
        if (!agg.has(k)) agg.set(k, { ym: k, n: 0, prec: 0, hum: 0, nh: 0, prog: 0, np: 0, dis: 0 });
        const a = agg.get(k);
        a.n += 1;
        a.prec += Number(r.precip_mm) || 0;   // 求和：空值当 0，与 SUM 语义一致
        /*
         * 均值一律**忽略空值**（把空值算进分母会把均值压下去 —— q10 就是这么差了 2 倍）。
         * 这一条不能只靠 DuckDB 交叉验证兜：交叉验证是可跳过项，没装 DuckDB 时偏差会静默发生。
         */
        const h = r.humidity_pct;
        if (h !== '' && h !== null && h !== undefined && !Number.isNaN(Number(h))) { a.hum += Number(h); a.nh += 1; }
        const pg = r.crop_progress;
        if (pg !== '' && pg !== null && pg !== undefined && !Number.isNaN(Number(pg))) { a.prog += Number(pg); a.np += 1; }
        a.dis = Math.max(a.dis, Number(r.disease_level_max) || 0);
      }
      const out = [...agg.values()].sort((x, y) => x.ym.localeCompare(y.ym)).map((a) => ({
        year_month: a.ym, n_days: a.n, precip_sum_mm: round(a.prec, 6),
        humidity_mean_pct: a.nh ? round(a.hum / a.nh, 6) : '', progress_mean: a.np ? round(a.prog / a.np, 6) : '',
        disease_max: a.dis,
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
    question: '每年播种 / 施肥 / 收获各多少次（农事流水事实表）',
    build: (T) => {
      const rows = T.get('fact_parcel_event').rows;
      const agg = new Map();
      for (const r of rows) {
        const k = String(r.event_day).slice(0, 4);
        if (!agg.has(k)) agg.set(k, { year: k, sow: 0, fertilize: 0, harvest: 0, total: 0, ysum: 0, ny: 0 });
        const a = agg.get(k);
        if (r.event_type === 'sow') a.sow += 1;
        else if (r.event_type === 'fertilize') a.fertilize += 1;
        else if (r.event_type === 'harvest') a.harvest += 1;
        a.total += 1;
        // 顺手把这张表里的**数值列**（收获事件的单产）也纳入对比：原来只比计数，数值列没人核过
        const v = r.yield_t_ha;
        if (v !== '' && v !== null && v !== undefined && !Number.isNaN(Number(v))) { a.ysum += Number(v); a.ny += 1; }
      }
      const out = [...agg.values()].sort((x, y) => x.year.localeCompare(y.year)).map((a) => ({
        year: a.year, sow: a.sow, fertilize: a.fertilize, harvest: a.harvest, total: a.total,
        yield_t_ha_sum: a.ny ? round(a.ysum, 6) : '', n_yield: a.ny,
      }));
      return {
        kind: 'list', rows: out, unit: '次 / t·ha⁻¹',
        note: `fact_parcel_event（农事流水）按年汇总：${rows.length} 条事件（含该表数值列 yield_t_ha 的合计与非空计数）`,
        listCols: ['year', 'sow', 'fertilize', 'harvest', 'total', 'yield_t_ha_sum', 'n_yield'],
      };
    },
  },
  {
    id: 'q10',
    title: '地块季 → 按作物汇总',
    question: '每类作物有多少季、总产与平均单产多少、最高病级（口径另见 q1）',
    build: (T) => {
      const rows = T.get('fact_parcel_season').rows;
      const agg = new Map();
      for (const r of rows) {
        const k = String(r.crop_code);
        if (!agg.has(k)) agg.set(k, { crop_code: k, n: 0, yt: 0, nyt: 0, yha: 0, nyha: 0, dis: 0 });
        const a = agg.get(k);
        a.n += 1;                                        // 季数 = 全部季（含没有单产记录的）
        const ytv = r.yield_t;                           // 合计：空值当 0 累加，与 SUM 语义一致
        if (ytv !== '' && ytv !== null && ytv !== undefined && !Number.isNaN(Number(ytv))) { a.yt += Number(ytv); a.nyt += 1; }
        /*
         * ⚠️ 均值必须**忽略空值**：把空值当 0 计进分母，均值会被整体压下去。
         * 这个错（正好差 2 倍）是交叉验证抓出来的 —— 自研侧 2.89 t/ha vs DuckDB 5.78 t/ha，
         * 因为一半的季没有单产记录。SQL 的 AVG 忽略 NULL，自研的 pivot() 也忽略空值，只有这里漏了。
         */
        const v = r.yield_t_ha;
        if (v !== '' && v !== null && v !== undefined && !Number.isNaN(Number(v))) { a.yha += Number(v); a.nyha += 1; }
        a.dis = Math.max(a.dis, Number(r.disease_level_max) || 0);
      }
      const out = [...agg.values()].sort((x, y) => x.crop_code.localeCompare(y.crop_code)).map((a) => ({
        crop_code: a.crop_code, n_seasons: a.n, yield_t_total: a.nyt ? round(a.yt, 6) : '',
        yield_t_ha_avg: a.nyha ? round(a.yha / a.nyha, 6) : '', disease_max: a.dis,
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
        if (!agg.has(k)) agg.set(k, { decade_key: k, units: new Set(), harv: 0, sown: 0, prog: 0, np: 0, progA: 0, npA: 0, dis: 0 });
        const a = agg.get(k);
        a.units.add(String(r.unit_id));
        a.harv += Number(r.harvested_ha) || 0;
        a.sown += Number(r.sown_ha) || 0;
        const pg = r.progress_mean;   // 均值跳过空值（同 q8/q10 的规则）
        if (pg !== '' && pg !== null && pg !== undefined && !Number.isNaN(Number(pg))) { a.prog += Number(pg); a.np += 1; }
        const pga = r.progress_area_mean;   // 面积加权口径一并汇总（两套口径都能被交叉验证核到）
        if (pga !== '' && pga !== null && pga !== undefined && !Number.isNaN(Number(pga))) { a.progA += Number(pga); a.npA += 1; }
        a.dis = Math.max(a.dis, Number(r.disease_level_max) || 0);
      }
      const out = [...agg.values()].sort((x, y) => x.decade_key.localeCompare(y.decade_key)).map((a) => ({
        decade_key: a.decade_key, n_units: a.units.size, harvested_ha: round(a.harv, 6),
        sown_ha: round(a.sown, 6), progress_mean: a.np ? round(a.prog / a.np, 6) : '',
        progress_area_mean: a.npA ? round(a.progA / a.npA, 6) : '', disease_max: a.dis,
      }));
      return {
        kind: 'list', rows: out, unit: 'ha / 0~1 / 级',
        note: `fact_unit_decade（单元 × 旬）按旬汇总：${out.length} 旬 × ${rows.length} 行`,
        listCols: ['decade_key', 'n_units', 'harvested_ha', 'sown_ha', 'progress_mean', 'progress_area_mean', 'disease_max'],
      };
    },
  },
  /*
   * **q14 收获排产压力（按日）**：回答"哪天会堵"。
   *
   * 口径（全部可追，没有拍脑袋的系数）：
   * - 当日待收量 `yield_t` 与面积来自季表 + 地块表；
   * - `t_min_w` = 当日待收量的**加权平均**到收储点时间（按吨加权，不是按块平均）；
   * - `haul_t_min` = Σ(吨 × 分钟) = 当日的"**运力占用**"（吨·分钟）—— 越大越堵。
   *   不引"车数/载重/趟数"这类项目里没有的参数：占用是**算出来的**，不是假设出来的。
   *
   * ⚠️ **口径边界（如实标注）**：多年生作物（牧草/果园）没有"播种→收获"的季，
   * 因此不在这张表里（它们的收获看事件表 q9/q13）。所以本表的最忙一天 = **一年生作物**的最忙一天，
   * 与页面重点问题（含多年生）的峰值日不是同一件事 —— 判据把这条边界也验了。
   */
  {
    id: 'q14',
    title: '收获排产压力（按日）',
    question: '哪几天最堵：当日待收吨数、加权平均运距、以及运力占用（吨·分钟）',
    build: (T) => {
      const st = star(T, 'fact_parcel_season');
      const agg = new Map();
      for (const r of st.rows) {
        if (!r.harvest_day) continue;
        const k = String(r.harvest_day);
        if (!agg.has(k)) agg.set(k, { day: k, n: 0, ha: 0, yt: 0, haul: 0, nyt: 0 });
        const a = agg.get(k);
        a.n += 1;
        a.ha += Number(r.area_ha) || 0;
        const y = Number(r.yield_t);
        const tm = Number(r.t_min_to_store);
        if (Number.isFinite(y) && y > 0 && Number.isFinite(tm)) { a.yt += y; a.haul += y * tm; a.nyt += 1; }
      }
      const out = [...agg.values()].sort((x, y) => x.day.localeCompare(y.day)).map((a) => ({
        day: a.day, n_parcels: a.n, area_ha: round(a.ha, 6),
        yield_t: round(a.yt, 6), t_min_w: a.yt > 0 ? round(a.haul / a.yt, 6) : '',
        haul_t_min: round(a.haul, 6),
      }));
      const busiest = [...out].sort((a, b) => b.haul_t_min - a.haul_t_min)[0];
      return {
        kind: 'list', rows: out, unit: '块 / ha / t / min / t·min',
        note: `fact_parcel_season ⟕ dim_parcel（要地块面积与到收储点时间）：${out.length} 个收获日`
          + `（**一年生作物口径**，多年生不在季表里）· 运力占用最高：${busiest ? `${busiest.day} ${busiest.haul_t_min} t·min` : '—'}`,
        listCols: ['day', 'n_parcels', 'area_ha', 'yield_t', 't_min_w', 'haul_t_min'],
      };
    },
  },
  /**
   * **q15 排产建议：错峰 vs 增点**
   *
   * 回答"最堵的一天到底该怎么办"。三个数都是**算出来的**，参数只有一个且明写（错峰窗口 ±K 天）：
   * - 现状：峰值日的运力占用（= q14 的最大值）；
   * - 错峰：把峰值日的占用摊到前后各 K 天（每天新增 = 峰值占用 ÷ (2K+1)）⇒ 取摊完后的新峰值；
   * - 增点：把**受益面积最大**的那个候选点应用到峰值日的待收地块上
   *   （`improved` 是 `[地块索引, 省多少分钟]`；索引与 `dim_parcel` 行序一致 —— 这一点有判据验）。
   *
   * ⚠️ 这是**估算**不是仿真：假设"量能摊开、路况不变、新点只影响当天待收地块"。
   * 页面/文档里不许把它说成"仿真结果"。
   */
  {
    id: 'q15',
    title: '排产建议：错峰 vs 增点（三个数）',
    question: '峰值日那么堵：把活摊开更管用，还是就近建点更管用？',
    build: (T) => {
      const st = star(T, 'fact_parcel_season');
      const scen = JSON.parse(fs.readFileSync(path.join(arg('data', 'data'), 'scenario.json'), 'utf8'));
      const byDay = new Map();
      for (const r of st.rows) {
        if (!r.harvest_day) continue;
        const y = Number(r.yield_t);
        const tm = Number(r.t_min_to_store);
        if (!(Number.isFinite(y) && y > 0 && Number.isFinite(tm))) continue;
        byDay.set(r.harvest_day, (byDay.get(r.harvest_day) ?? 0) + y * tm);
      }
      const peak = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0];
      const K = 3;                                   // 错峰窗口 ±3 天（明写；不是拟合出来的）
      const per = peak[1] / (2 * K + 1);
      const peakSpread = Math.max(...[...byDay.keys()].map((d) => (d === peak[0] ? byDay.get(d) - peak[1] + per : byDay.get(d) + per)));
      const best = scen.candidates.reduce((b, c) => (c.improved_ha > (b ? b.improved_ha : -1) ? c : b), null);
      const gain = new Map(best.improved);
      const idxOf = new Map(T.get('dim_parcel').rows.map((r, i) => [r.parcel_id, i]));
      let peakHaul = 0;
      let peakNew = 0;
      for (const r of st.rows) {
        if (r.harvest_day !== peak[0]) continue;
        const y = Number(r.yield_t);
        const tm = Number(r.t_min_to_store);
        if (!(Number.isFinite(y) && y > 0 && Number.isFinite(tm))) continue;
        peakHaul += y * tm;
        peakNew += y * Math.max(0, tm - (gain.get(idxOf.get(r.parcel_id)) ?? 0));
      }
      const dropSpread = 1 - peakSpread / peak[1];
      const dropPoint = (peakHaul - peakNew) / peak[1];
      const winner = dropSpread >= dropPoint ? '错峰' : '增点';
      const rows = [
        { 情景: '现状（峰值日）', 峰值占用: round(peak[1], 1), 降幅: 0, 说明: `${peak[0]}：${round(peakHaul, 1)} t·min（= q14 的最大值）` },
        { 情景: `错峰（摊到前后各 ${K} 天）`, 峰值占用: round(peakSpread, 1), 降幅: round(dropSpread, 4), 说明: `每天新增 = 峰值占用 ÷ ${2 * K + 1}；再取摊完后的新峰值（另 ${2 * K} 天本来就有收获）` },
        { 情景: '增点（建在受益最大处）', 峰值占用: round(peak[1] - peakHaul + peakNew, 1), 降幅: round(dropPoint, 4), 说明: `候选 ${(best.lon).toFixed(4)},${(best.lat).toFixed(4)}（${best.improved_ha} ha 受益）只作用在**峰值日**的待收地块上` },
      ];
      return {
        kind: 'list', rows, unit: 't·min / 比例',
        note: `**估算**（不是仿真）：参数只有错峰窗口 ±${K} 天 · 本数据下更管用的是 **${winner}**`
          + `（错峰降 ${(dropSpread * 100).toFixed(1)}% vs 增点降 ${(dropPoint * 100).toFixed(1)}%）`
          + ' · 假设：量能摊开、路况不变、新点只影响当天待收地块',
        listCols: ['情景', '峰值占用', '降幅', '说明'],
      };
    },
  },
  /*
   * q9 把事件表按**年**压了一层，这里按**月**再压一层：
   * 农忙窗口是以月为单位的（哪个月在播种、哪个月在收），按年看不出来。
   * `count` 聚合要一列数值，所以补一列常量 1 —— 引擎对空值/非数值一律跳过，不能拿月份的字符串去数。
   */
  {
    id: 'q13',
    title: '农事日历：月 × 事件类型（次）',
    question: '播种 / 施肥 / 收获在一年里各挤在哪几个月（农忙窗口；也是"到收储点忙不过来"的时间形态）',
    build: (T) => {
      const src = T.get('fact_parcel_event').rows;
      const rows = src.map((r) => ({
        ym: `${String(r.event_day).slice(0, 4)}-${String(r.event_day).slice(4, 6)}`,
        event_type: r.event_type,
        one: 1,
      }));
      return {
        kind: 'pivot', rows, unit: '次',
        note: `fact_parcel_event 按**月 × 类型**展开：${src.length} 条事件（q9 是同年按年汇总，这里看月内分布）`,
        pivot: { rowDims: ['ym'], colDim: 'event_type', value: 'one', agg: 'count', sortKeys: 'asc' },
      };
    },
  },
];

// ===================== 输出 =====================

const mdNum = (v) => (typeof v === 'number' ? String(round(v, 3)) : String(v ?? ''));

function writeWideCsv(name, res) {
  const cols = res.rowDims.map((d) => d);
  const lines = [[...cols, ...res.colKeys, '合计'].join(',')];
  res.rowKeys.forEach((rk, ri) => {
    const cells = res.matrix[ri].map((v, ci) => `${mdNum(v)}${res.flags(rk, res.colKeys[ci])}`);
    lines.push([rk, ...cells, mdNum(res.rowTotals[ri])].map((x) => (String(x).includes(',') ? `"${x}"` : x)).join(','));
  });
  lines.push(['合计', ...res.colTotals.map(mdNum), mdNum(res.grand)].map((x) => (String(x).includes(',') ? `"${x}"` : x)).join(','));
  const f = path.join(OUT, `${name}.csv`);
  fs.writeFileSync(f, `${lines.join('\n')}\n`, 'utf8');
  return { file: f, cols: res.colKeys.length, rows: res.rowKeys.length };
}

function writeListCsv(name, cols, rows) {
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map((c) => { const v = r[c] ?? ''; return String(v).includes(',') ? `"${v}"` : v; }).join(','));
  const f = path.join(OUT, `${name}.csv`);
  fs.writeFileSync(f, `${lines.join('\n')}\n`, 'utf8');
  return { file: f, rows: rows.length };
}

/** 预览用的 Markdown 片段（大矩阵只截前几行几列 + 说明"完整见 CSV"） */
function mdPreview(res, { maxRows = 8, maxCols = 6 } = {}) {
  const cols = res.colKeys.slice(0, maxCols);
  const head = `| ${res.rowDims.join(' · ')} | ${cols.join(' | ')} |${res.colKeys.length > maxCols ? ' … |' : ''} 合计 |`;
  const sep = `|${'---|'.repeat(cols.length + 2)}${res.colKeys.length > maxCols ? '---|' : ''}`;
  const body = res.rowKeys.slice(0, maxRows).map((rk, ri) => {
    const cells = cols.map((ck) => {
      const ci = res.colKeys.indexOf(ck);
      return `${mdNum(res.matrix[ri][ci])}${res.flags(rk, ck)}`;
    });
    return `| ${rk} | ${cells.join(' | ')} |${res.colKeys.length > maxCols ? ' … |' : ''} ${mdNum(res.rowTotals[ri])} |`;
  });
  const clipped = res.rowKeys.length > maxRows || res.colKeys.length > maxCols
    ? `\n\n> ${res.rowKeys.length} 行 × ${res.colKeys.length} 列，此处只截 ${Math.min(maxRows, res.rowKeys.length)} × ${Math.min(maxCols, res.colKeys.length)}；完整见 \`${res.csvFile}\`。`
    : '';
  return [head, sep, ...body].join('\n') + clipped;
}

// ===================== 主流程 =====================

const __t0 = Date.now();
const T = loadTables(TABLES);
/*
 * 横幅**不打印总行数**：那需要把每张表都解析一遍（等于把懒加载作废，而且每次运行都白付）。
 * 真正解析了多少张表，由末尾那行 `[耗时] … 解析 N/M 张表` 说明。
 */
console.log(`读取 ${TABLES}：${T.size} 张表（惰性解析：用到哪张解析哪张）`);

if (has('list')) {
  console.log('\n预置查询：');
  for (const p of PRESETS) console.log(`  ${p.id}  ${p.title}\n       ${p.question}`);
  process.exit(0);
}

if (arg('join')) {
  const base = arg('join');
  const s = star(T, base);
  console.log(`\n${base} ⟕ ${s.specs.map((x) => x.table).join(' ⟕ ') || '（无预设连接）'}`);
  console.log(`列（${s.columns.length}）：${s.columns.join(', ')}`);
  if (s.renamed.length) console.log(`重名列已加前缀：${s.renamed.join('、')}`);
  console.log(`样例：${JSON.stringify(s.rows[0]).slice(0, 400)}`);
  process.exit(0);
}

const only = arg('q') || arg('only');
// `--list`：只列可用的查询 id（配 --only 使用；不用跑一遍才知道 id 拼错没）
if (has('list')) {
  for (const p of PRESETS) console.log(`${p.id.padEnd(5)} ${p.title}`);
  process.exit(0);
}
const wantCheckOnly = has('check');
// `--deps`：**在构建之前**打开列级采样（Proxy 只在首次解析时套上去）
T.sampleTrace = has('deps');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
/**
 * 取某个查询的 spec：**直接复用主循环算好的结果**。
 * 判据区原来用 `PRESETS.find(...).build(T)` 又算了一遍（6 个查询白跑，q4 还要再扫 27 万行）。
 */
const specOf = (id) => results.find((r) => r.id === id)?.spec;
if (!wantCheckOnly || only) {
  for (const p of PRESETS) {
    if (only && p.id !== only) continue;
    T.tracing = p.id;
    const spec = p.build(T);
    T.tracing = null;
    let res;
    if (spec.kind === 'pivot') {
      const pv = pivot(spec.rows, spec.pivot);
      pv.csvFile = path.relative(process.cwd(), path.join(OUT, `${p.id}_${p.title.replace(/[^\w\u4e00-\u9fa5]+/g, '_')}.csv`));
      const info = writeWideCsv(`${p.id}_${p.title.replace(/[^\w\u4e00-\u9fa5]+/g, '_')}`, pv);
      res = { id: p.id, title: p.title, question: p.question, kind: 'pivot', pv, info, spec, unit: spec.unit };
      console.log(`\n[${p.id}] ${p.title}\n  ${spec.note}\n  ${pv.rowKeys.length} 行 × ${pv.colKeys.length} 列（${pv.agg} ${pv.value}，样本 ${pv.n}）`
        + (pv.notes.length ? `\n  ⚠️ ${pv.notes.slice(0, 2).join('；')}` : ''));
    } else {
      const info = writeListCsv(`${p.id}_${p.title.replace(/[^\w\u4e00-\u9fa5]+/g, '_')}`, spec.listCols, spec.rows);
      res = { id: p.id, title: p.title, question: p.question, kind: 'list', spec, info, unit: spec.unit };
      console.log(`\n[${p.id}] ${p.title}\n  ${spec.note}\n  命中 ${spec.rows.length} 行`);
    }
    results.push(res);
  }
}

// ===================== Markdown 汇总 =====================

if (results.length) {
  const md = [
    '# 透视与联合查询结果', '',
    `由 \`npm run query\` 生成（**纯 node、零依赖**）；数据源：\`${TABLES}/*.csv\`（与 Excel 工作簿同一批表）。`, '',
    '三个原语：**星型连接**（事实表 ⟕ 维度表，展开外键，行数不变）· **透视**（行维 × 列维 × 度量 × 聚合，含行/列合计）·',
    '**联合筛选**（跨字段多条件）。规矩：连接不许膨胀行数、外键不许有孤儿、**单产不许跨口径平均**（混口径的格子标 `*`）、透视要守恒。', '',
    '| 查询 | 类型 | 结果规模 | 说明 |', '|---|---|---|---|',
    ...results.map((r) => `| ${r.id} ${r.title} | ${r.kind === 'pivot' ? `透视（${r.pv.agg} ${r.pv.value}）` : '联合筛选/汇总'} | ${r.kind === 'pivot' ? `${r.pv.rowKeys.length} × ${r.pv.colKeys.length}` : `${r.spec.rows.length} 行`} | ${r.question} |`),
    '',
  ];
  for (const r of results) {
    md.push(`## ${r.id} ${r.title}`, '', `**业务问题**：${r.question}`, '', `**口径**：${r.spec.note}`, '');
    if (r.kind === 'pivot') {
      md.push(mdPreview({ ...r.pv, csvFile: r.info.file.replace(/\\/g, '/').replace(/^.*?tables\//, 'tables/') }), '');
      if (r.pv.notes.length) md.push(`> ⚠️ ${r.pv.notes.slice(0, 3).join('；')}${r.pv.notes.length > 3 ? `（共 ${r.pv.notes.length} 个格子）` : ''}`, '');
      md.push(`合计（${r.pv.agg}）：**${mdNum(r.pv.grand)}** ${r.unit ?? ''}`, '');
    } else {
      const cols = r.spec.listCols;
      md.push(`| ${cols.join(' | ')} |`, `|${'---|'.repeat(cols.length)}`);
      for (const row of r.spec.rows.slice(0, 10)) md.push(`| ${cols.map((c) => mdNum(row[c])).join(' | ')} |`);
      if (r.spec.rows.length > 10) md.push('', `> 共 ${r.spec.rows.length} 行，完整见 \`${r.info.file.replace(/\\/g, '/').replace(/^.*?tables\//, 'tables/')}\``);
      md.push('');
    }
  }
  const f = path.join(OUT, '透视与联合查询.md');
  fs.writeFileSync(f, `${md.join('\n')}\n`, 'utf8');
  console.log(`\n[写出] ${f}（${results.length} 个查询的汇总，可直接阅读）`);
}

// ---------- 机器可读结果（供**另一套引擎**交叉验证；也不必再解 CSV） ----------
const jsonOut = arg('json');
if (jsonOut && results.length) {
  const dump = {
    engine: 'self',
    generated_at: new Date().toISOString(),
    tables: [...T.keys()],
    queries: results.map((r) => (r.kind === 'pivot'
      ? {
        id: r.id, kind: 'pivot', rowDims: r.pv.rowDims, colDim: r.pv.colDim, value: r.pv.value, agg: r.pv.agg,
        rowKeys: r.pv.rowKeys, colKeys: r.pv.colKeys, matrix: r.pv.matrix,
        rowTotals: r.pv.rowTotals, colTotals: r.pv.colTotals, grand: r.pv.grand, n: r.pv.n,
      }
      : { id: r.id, kind: 'list', cols: r.spec.listCols, rows: r.spec.rows })),
  };
  fs.writeFileSync(path.resolve(jsonOut), JSON.stringify(dump), 'utf8');
  console.log(`[写出] ${jsonOut}（机器可读结果，供交叉验证）`);
}

// ---------- 多 sheet Excel（业务方不用装任何工具就能读；与 CSV 是同一批结果） ----------
const xlsxOut = arg('xlsx');
if (xlsxOut && results.length) {
  const { writeXlsx, colName } = await import('./xlsx.mjs');   // colName 用来算图表的数据引用
  /** Excel 的 sheet 名有硬限制：≤31 字符、不能含 []:*?/\\ ，且必须唯一 */
  const sheetName = (r) => {
    const t = `${r.id} ${r.title}`.replace(/[\[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim();
    return t.length > 31 ? `${r.id} ${t.slice(r.id.length + 1, 31 - r.id.length - 1)}` : t;
  };
  const sheets = [{
    name: '说明',
    columns: ['项', '内容'],
    rows: [
      ['数据集', 'Wolnzach 乡镇农业监测 · 透视与联合查询结果'],
      ['生成时间', new Date().toISOString()],
      ['数据源', 'tables/*.csv（与 农业监测数据.xlsx 同一批表）'],
      ['谁算的', 'npm run query（自研零依赖引擎）；另有 npm run query:sql 用 DuckDB 交叉验证'],
      ['怎么看', '一张查询一个 sheet：行维在左、列维在表头、右下角是总合计；单产行标签自带口径（不同口径不能比大小）'],
      ['注意', '单产按 yield_basis 分籽粒/鲜重/干花/干草/鲜果；混口径的格子会在 CSV 侧标 * 并在备注里列出'],
      ['查询清单', results.map((r) => `${r.id} ${r.title}`).join('; ')],
    ],
  }];
  for (const r of results) {
    if (r.kind === 'pivot') {
      const r3 = (v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v);
      const rows = r.pv.rowKeys.map((rk, i) => [rk, ...r.pv.matrix[i].map(r3), r3(r.pv.rowTotals[i])]);
      rows.push(['合计', ...r.pv.colTotals.map(r3), r3(r.pv.grand)]);
      const sh = { name: sheetName(r), columns: [r.pv.rowDims.join(' · '), ...r.pv.colKeys, '合计'], rows };
      // 透视表也能配图：表头是 [行维, ...colKeys, 合计]，所以列的字母要按 colKeys 的位置算
      if (r.id === 'q13') {
        const ci = r.pv.colKeys.indexOf('harvest');
        if (ci >= 0) {
          sh.chart = {
            title: '农事日历：各月收获次数', seriesName: '收获次数',
            catCol: colName(0), valCol: colName(ci + 1), from: 2, to: r.pv.rowKeys.length + 1,
            cats: r.pv.rowKeys.map(String),
            vals: r.pv.rowKeys.map((_, i) => Number(r.pv.matrix[i][ci]) || 0),
            widthPx: 660, heightPx: 330,
          };
        }
      }
      sheets.push(sh);
    } else {
      const sh = { name: sheetName(r), columns: r.spec.listCols, rows: r.spec.rows.map((row) => r.spec.listCols.map((c) => row[c])) };
      /*
       * **给"按时间看量"的表配原生柱状图**（不是图片）：导出的 Excel 不该只有干巴巴的数字。
       * 引用按**工作表里的真实列字母**算，避免"图和数不对应"这种最尴尬的错误。
       */
      const ci = (c) => r.spec.listCols.indexOf(c);
      const col = (c) => (ci(c) >= 0 ? colName(ci(c)) : null);
      const nums = (c) => r.spec.rows.map((x) => Number(x[c]) || 0);
      const strs = (c) => r.spec.rows.map((x) => String(x[c] ?? ''));
      if (r.id === 'q14') {
        sh.chart = {
          title: '收获排产压力：每日运力占用（吨·分钟）', seriesName: '吨·分钟',
          catCol: col('day'), valCol: col('haul_t_min'), from: 2, to: r.spec.rows.length + 1,
          cats: strs('day'), vals: nums('haul_t_min'), widthPx: 660, heightPx: 330,
        };
      }
      if (r.id === 'q13') {
        sh.chart = {
          title: '农事日历：各月收获次数', seriesName: '收获次数',
          catCol: col('月份'), valCol: col('harvest'), from: 2, to: r.spec.rows.length + 1,
          cats: strs('月份'), vals: nums('harvest'), widthPx: 660, heightPx: 330,
        };
      }
      sheets.push(sh);
    }
  }
  const info = writeXlsx(path.resolve(xlsxOut), sheets);
  console.log(`[写出] ${xlsxOut}（${info.sheets} 个工作表 / ${info.charts} 张原生图表，${(info.bytes / 1024).toFixed(0)} KB：一张查询一个 sheet + 说明）`);
  /*
   * **把图表读回来核对**（不是"人工核过可打开"这种口头保证）：
   * 用 openpyxl 打开产物，核对每个图表的类型、标题与**数据引用**是否与预期一致 ——
   * 图表 XML 拼错了 Excel 只会显示一个空框，不读回来等于没验。
   * python/openpyxl 缺失时**跳过**（可选加强项）；装了却读不出来 ⇒ 失败。
   */
  {
    const probe = path.join(path.dirname(path.resolve(xlsxOut)), '_xlsx_probe.json');
    const py = [
      'import json, openpyxl, sys',
      'wb = openpyxl.load_workbook(sys.argv[1])',
      'out = {"sheets": wb.sheetnames, "charts": []}',
      'for ws in wb.worksheets:',
      '    for ch in getattr(ws, "_charts", []):',
      '        title = None',
      '        try: title = ch.title.tx.rich.p[0].r[0].t',
      '        except Exception: title = None',
      '        out["charts"].append({"sheet": ws.title, "type": type(ch).__name__, "title": title,',
      '            "val": [ (s.val.numRef.f if (s.val and s.val.numRef) else None) for s in ch.series ],',
      '            "cat": [ (s.cat.strRef.f if (s.cat and getattr(s.cat, "strRef", None)) else None) for s in ch.series ],',
      '            "n": [ (len(s.val.numRef.numCache.pt) if (s.val and s.val.numRef and s.val.numRef.numCache) else 0) for s in ch.series ]})',
      'open(sys.argv[2], "w", encoding="utf-8").write(json.dumps(out, ensure_ascii=False))',
    ].join('\n');
    const r2 = spawnSync('python', ['-c', py, path.resolve(xlsxOut), probe],
      { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let got = null;
    try { got = JSON.parse(fs.readFileSync(probe, 'utf8')); } catch { got = null; }
    fs.rmSync(probe, { force: true });
    if (!got) {
      check('Excel 原生图表（openpyxl 读回核对）', true,
        `跳过：读不出产物（${String(r2.stderr ?? '').split('\n')[0].slice(0, 60) || '没有 python/openpyxl'}）`);
    } else {
      const wantTitles = sheets.filter((x) => x.chart).map((x) => x.chart.title);
      const byTitle = (t) => got.charts.find((c) => c.title === t);
      // 期望引用按**图表声明本身**算（透视表比列表多一行"合计"，用 rows.length+1 会算错）
      const wantRef = (title) => {
        const sh = sheets.find((x) => x.chart && x.chart.title === title);
        if (!sh) return null;
        const q = (n) => `'${n.replace(/'/g, "''")}'`;
        return `${q(sh.name)}!$${sh.chart.valCol}$${sh.chart.from}:$${sh.chart.valCol}$${sh.chart.to}`;
      };
      /*
       * 还要验"**图和数真的对应**"：引用范围必须正好覆盖数据行（从第 2 行到数据末行），
       * **不能把透视的"合计"行也圈进图里**（那样图上会多一根"总和"柱，一眼假）。
       */
      const DATA_ROWS = { q14: results.find((x) => x.id === 'q14')?.spec.rows.length, q13: results.find((x) => x.id === 'q13')?.pv.rowKeys.length };
      const rangeOk = sheets.filter((x) => x.chart).every((x) => {
        const id = Object.keys(DATA_ROWS).find((k) => sheetName(results.find((r) => r.id === k)) === x.name);
        return id ? x.chart.to === DATA_ROWS[id] + 1 && x.chart.from === 2 : false;
      });
      const c14 = byTitle('收获排产压力：每日运力占用（吨·分钟）');
      const c13 = byTitle('农事日历：各月收获次数');
      const rows14 = sheets.find((x) => x.chart && x.chart.title === '收获排产压力：每日运力占用（吨·分钟）')?.rows.length ?? -1;
      check('Excel **带原生图表**：openpyxl 读回的类型/标题/**数据引用**/缓存点数全对得上（不是"人工打开看过"）',
        got.charts.length === wantTitles.length && got.charts.length >= 2
          && !!c14 && c14.type === 'BarChart' && c14.val[0] === wantRef(c14.title)
          && c14.n[0] === (DATA_ROWS.q14 ?? -9) && c14.cat[0] === wantRef('收获排产压力：每日运力占用（吨·分钟）').replace(/\$F\$/g, '$A$')
          && !!c13 && c13.type === 'BarChart' && c13.val[0] === wantRef(c13.title)
          && c13.n[0] === (DATA_ROWS.q13 ?? -9) && rangeOk,
        `${got.sheets.length} 个工作表 / ${got.charts.length} 张图：`
          + got.charts.map((c) => `${c.title}（${c.type}，${c.val[0]}，缓存 ${c.n[0]} 点）`).join('；')
          + ` · 引用范围正好覆盖数据行=${rangeOk}`);
    }
  }
}

// ---------- 页面用的**静态透视视图**（页面只查表，一行计算都不做） ----------
const webOut = arg('web');
// `--deps` 是审计命令：不写网页产物（否则每次审计都在 data/pivot.json 留一个"只差时间戳"的脏文件）
if (webOut && results.length && !has('deps')) {
  /*
   * 为什么不在页面里现算透视：**页面要保持纯静态、零依赖、首屏不卡**（见 README「纯静态保证」）。
   * 透视是离线工具的事，页面只 fetch 这份 JSON 然后把矩阵画成表 —— 和 `data/scenario.json` 一个思路。
   * 这份 JSON 由 `npm run query` 从 `tables/*.csv` 生成，与 `tables/query/*.csv` 是同一批结果的两种形态。
   */
  const PICK = ['q1', 'q3', 'q2', 'q7', 'q13'];
  const LABEL = {
    q1: ['作物 · 口径', '年'], q3: ['统计网格', '作物'], q2: ['经营单元', '旬'], q7: ['管理分区', '作物'],
    q13: ['月份', '事件类型'],
  };
  /*
   * 除了透视矩阵，页面上还值得看**对照表**（不是矩阵，而是几列并排）：
   * 目前只放 q12「单产两套口径」—— 它回答的是"同一个数，等权与面积加权差多少"，
   * 放进页面比只在离线 CSV 里更容易被看见（口径问题最怕"没人看"）。
   */
  // 哪些视图自带图：农事日历是"时间形态"，表看数值、柱图看农忙窗口
  const CHART_VIEW = { q13: 'stacked' };
  // 对照表：q12（两套单产口径）+ q8（区域逐日的月汇总）——
  // 后者是**唯一还没进页面**的那张事实表的汇总（天气/进度/病害的月度背景），能看数据也能当判据靶子
  const LIST_PICK = ['q12', 'q8', 'q14', 'q15'];
  const listViews = LIST_PICK.map((id) => {
    const r = results.find((x) => x.id === id);
    if (!r || r.kind !== 'list') return null;
    return {
      id: r.id, title: r.title, question: r.question, note: r.spec.note, kind: 'list',
      unit: r.unit ?? '', cols: r.spec.listCols,
      rows: r.spec.rows.map((row) => r.spec.listCols.map((c) => row[c])),
      n: r.spec.rows.length,
    };
  }).filter(Boolean);
  const views = PICK.map((id) => {
    const r = results.find((x) => x.id === id);
    if (!r || r.kind !== 'pivot') return null;
    // 显示位数（页面用）与**存储精度**分开：存的与 CSV 一样是 3 位小数，免得三种形态互相对不上
    // 计数列不给小数：13.00 次读起来像"精确到 0.01 次"，整数就是整数
    const dec = r.pv.agg === 'count' ? 0 : (r.pv.value === 'progress_mean' ? 3 : 2);
    const rd = (v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v);
    return {
      id: r.id, title: r.title, question: r.question, note: r.spec.note,
      // 带图与否由**离线侧声明**：页面只认 `chart` 字段，不认 id（加视图不用改页面）
      chart: CHART_VIEW[id] ?? null,
      rowLabel: LABEL[id][0], colLabel: LABEL[id][1],
      unit: r.unit ?? '', agg: r.pv.agg, value: r.pv.value, decimals: dec,
      rowKeys: r.pv.rowKeys, colKeys: r.pv.colKeys,
      matrix: r.pv.matrix.map((row) => row.map(rd)),
      rowTotals: r.pv.rowTotals.map(rd), colTotals: r.pv.colTotals.map(rd), grand: rd(r.pv.grand),
      n: r.pv.n,
    };
  }).filter(Boolean).concat(listViews);
  const payload = {
    dataset: 'Wolnzach 乡镇农业监测（模拟）× 透视视图',
    generated_at: new Date().toISOString(),
    source: '由 npm run query 离线生成自 tables/*.csv；页面只查表（纯静态，无后端）',
    views,
  };
  const file = path.resolve(webOut);
  fs.writeFileSync(file, JSON.stringify(payload), 'utf8');
  // ⚠️ 视图有两种形态（矩阵 / 对照表）：打印时不能一律读 `rowKeys`（list 视图没有它，
  // 曾经在这里抛 TypeError —— 文件其实已写出，但**后面的判据全没跑**，是最阴的失败形态）
  const desc = (v) => (v.kind === 'list'
    ? `${v.id} ${v.rows.length}×${v.cols.length}`
    : `${v.id} ${v.rowKeys.length}×${v.colKeys.length}`);
  console.log(`[写出] ${webOut}（${views.length} 个静态视图：${views.map(desc).join(' / ')}，${(fs.statSync(file).size / 1024).toFixed(0)} KB）`);
}

/*
 * **`--only` 是调试循环**：只跑你要的那一个查询，跳过判据区（判据要看全量数据，
 * 是"全量体检"那件事的一部分）。导出（--web/--json/--xlsx）在判据之前，所以不受影响。
 */
if (only && !results.length) {
  console.error(`\n[only] 没有匹配的查询 id：${only}（可用：${PRESETS.map((p) => p.id).join(' ')}）`);
  process.exit(1);
}

if (only) {
  console.log(`\n[only] 只跑了 ${only} · 跳过判据区（要全量体检就跑 npm run query）`);
  console.log(`[耗时] ${Date.now() - __t0}ms · 解析 ${T.loaded}/${T.size} 张表`);
  process.exit(0);
}

/*
 * `--deps`：打印"每个查询读了哪几张表、哪几列"（交付裁剪与性能分析的起点）。
 * 列级依赖是**主循环构建时**记录的（`T.sampleTrace` 在构建前打开），这里只打印，不重跑查询。
 */
if (has('deps')) {
  /*
   * `--json`：把依赖写成**机器可读**的 `tables/query/deps.json`（供交付脚本 / CI 消费）。
   * 只写文件、跳过判据区：这条命令的产物是文件，不是屏幕上的字（人读的那份不带 `--json`）。
   */
  if (has('json')) {
    const tables = {};
    for (const name of T.names()) {
      const t = T.get(name);
      if (!t) continue;
      const read = new Set();
      const readBy = [];
      for (const p of PRESETS) {
        const cs = T.cols.get(p.id)?.get(name);
        if (cs?.size) { readBy.push(p.id); for (const c of cs) read.add(c); }
      }
      tables[name] = {
        columns: t.columns,
        readColumns: [...read].sort(),
        unreadColumns: t.columns.filter((c) => !read.has(c)),
        readBy,
        rows: t.rows.length,
      };
    }
    const queries = {};
    for (const p of PRESETS) {
      const perTable = T.cols.get(p.id) ?? new Map();
      const cols = {};
      for (const [tb, cs] of perTable) cols[tb] = [...cs].sort();
      queries[p.id] = { tables: [...(T.reads.get(p.id) ?? [])].sort(), columns: cols };
    }
    const out = path.join(TABLES, 'query', 'deps.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify({
      note: '运行时追踪：表 + 列（列级由前 3 行 Proxy 记录真实属性访问）',
      generatedAt: new Date().toISOString(),
      queries,
      tables,
    }, null, 2)}\n`, 'utf8');
    console.log(`[写出] ${path.relative(process.cwd(), out)}（${PRESETS.length} 个查询 · ${Object.keys(tables).length} 张表）`);
    process.exit(0);
  }
  console.log('\n=== 查询 → 依赖（运行时追踪：表 + 列）===');
  for (const p of PRESETS) {
    const set = T.reads.get(p.id);
    const perTable = T.cols.get(p.id) ?? new Map();
    console.log(`  ${p.id.padEnd(5)} ${set && set.size ? [...set].join(', ') : '（未读任何表）'}`);
    for (const [tb, cs] of perTable) console.log(`        ${tb}: ${[...cs].sort().join(', ')}`);
  }
  // 汇总：每张表"读到几列 / 共几列" + **一次都没被读到的列**（比静态扫描可信）
  console.log('\n=== 每张表的列使用情况（未读列 = 可信的可疑清单）===');
  for (const name of T.names()) {
    const t = T.get(name);
    if (!t) continue;
    const read = new Set();
    for (const perTable of T.cols.values()) {
      const cs = perTable.get(name);
      if (cs) for (const c of cs) read.add(c);
    }
    const unread = t.columns.filter((c) => !read.has(c));
    console.log(`  ${name.padEnd(26)} ${String(t.columns.length).padStart(3)} 列 · 读 ${String(read.size).padStart(3)} 列`
      + (unread.length ? ` · **未读**: ${unread.join(', ')}` : ' · 未读: 无'));
  }
  /*
   * **交付裁剪建议**：哪些表"一个查询都不读"。
   * ⚠️ 不等于是"可以删"：这些表可能仍被 Excel 导出、数据元字典、离线校验或页面 JSON 用到 ——
   * 只说明**查询这条链**不需要它。裁剪前必须确认其余消费方。
   */
  console.log('\n=== 交付裁剪参考：查询链完全不读的表 ===');
  const zero = T.names().filter((n) => {
    for (const perTable of T.cols.values()) if (perTable.get(n)?.size) return false;
    return T.get(n);
  });
  for (const n of zero) {
    const t = T.get(n);
    const kb = (fs.statSync(path.join(TABLES, `${n}.csv`)).size / 1024).toFixed(0);
    console.log(`  ${n.padEnd(26)} ${kb.padStart(6)} KB · ${t.columns.length} 列（**未被任何查询读取**）`);
  }
  console.log('（注意：仍可能被 Excel 导出 / 数据元字典 / 离线校验用到 —— 删前先确认其余消费方）');
}

{
  /*
   * **每个查询至少读到一张表**：表名写错（`T.get('fact_xxx')` 返回 undefined）或构建提前返回时，
   * 它会"0 依赖"却照样产出一张空表 —— 静默出错最难查。
   * 依赖用**运行时追踪**（不是人工声明：声明会漂，追踪不会）。
   */
  const empty = [...T.reads.entries()].filter(([, set]) => !set || set.size === 0).map(([id]) => id);
  const nReads = [...T.reads.values()].reduce((n, set) => n + set.size, 0);
  check('每个查询至少读到**一张表**（0 依赖 = 表名写错/提前返回 ⇒ 会静默产出空表）',
    T.reads.size > 0 && empty.length === 0,
    `${T.reads.size} 个查询 · 共 ${nReads} 次表读取` + (empty.length ? ` · 0 依赖：${empty.join('、')}` : ''));
}

// ===================== 判据 =====================

console.log('\n=== 透视与联合查询判据 ===');

check('CSV 解析**无错位**（每行列数与表头一致 —— 字段内含逗号是这里最容易出的错）',
  [...T.entries()].every(([, t]) => t.rawRows.every((r) => r.length === t.columns.length)),
  `${T.size} 张表`);

{
  const bad = [];
  for (const baseName of Object.keys(STAR)) {
    if (!T.has(baseName)) { bad.push(`${baseName} 不存在`); continue; }
    const before = T.get(baseName).rows.length;
    const s = star(T, baseName);
    if (s.rows.length !== before) bad.push(`${baseName}：${before} → ${s.rows.length} 行`);
    if (s.missing.size) bad.push(`${baseName}：孤儿外键 ${[...s.missing.entries()].map(([k, v]) => `${k}×${v}`).join(',')}`);
  }
  check('星型连接**不膨胀行数**、且外键**无孤儿**（维度键唯一 + 事实表键全命中）',
    bad.length === 0, bad.join('；') || `${Object.keys(STAR).length} 张事实/维度表逐条通过`);
}

{
  const s = star(T, 'dim_parcel');
  const n = s.rows.filter((r) => !r.unit_id || !r.grid_id || !r.admin_code || !r.name).length;
  check('四层空间钻取链完整（地块 → 经营单元 → 统计网格 → 行政区划，无断链）',
    n === 0, n ? `${n} 个地块断链` : `${s.rows.length} 个地块全部可逐层上溯`);
}

{
  const p3 = specOf('q3');
  const pv = pivot(p3.rows, p3.pivot);
  const sumCell = [...pv.matrix.flat()].reduce((a, b) => a + (Number(b) || 0), 0);
  const sumSrc = p3.rows.reduce((a, r) => a + (Number(r.area_ha) || 0), 0);
  check('透视**守恒**：单元格合计 == 原列合计（sum 聚合，不许有行掉在矩阵外）',
    Math.abs(sumCell - sumSrc) < 0.5, `矩阵 ${round(sumCell, 1)} ha vs 原表 ${round(sumSrc, 1)} ha`);
  check('透视的**行/列合计**与原表合计一致（两个方向都守恒）',
    Math.abs(Number(pv.grand) - sumSrc) < 0.5 && Math.abs(Number(pv.rowTotals.reduce((a, b) => a + (Number(b) || 0), 0)) - sumSrc) < 0.5,
    `总合计 ${round(Number(pv.grand), 1)} ha`);
}

{
  const p4 = specOf('q4');
  const pv = pivot(p4.rows, p4.pivot);
  const placed = pv.matrix.flat().filter((v) => v !== '').length;
  const expectCells = pv.rowKeys.length * pv.colKeys.length;
  check('长表 → 宽表：观测量守恒、矩阵完整（行维 × 列维 网格无缺格）',
    pv.n === p4.rows.length && expectCells === pv.rowKeys.length * pv.colKeys.length && pv.rowKeys.length === 549,
    `${p4.rows.length} 条观测 → ${pv.rowKeys.length} × ${pv.colKeys.length} 矩阵（非空格 ${placed}）`);
}

{
  const p1 = specOf('q1');
  const pv = pivot(p1.rows, p1.pivot);
  const bases = new Set(p1.rows.map((r) => r.yield_basis));
  // 反过来用**粗维度**（行=年、列=季序）：一个格子必然同时含籽粒/鲜重/干花 ⇒ 必须被标记出来。
  // 这样验的是"机制真的会拦"，而不是"刚好这份数据没混"（后者是撞运气，不算判据）。
  const coarse = pivot(p1.rows, { rowDims: ['season_year'], colDim: 'season_seq', value: 'yield_t_ha', agg: 'mean', mixBy: 'yield_basis' });
  check('**单产不许跨口径平均**：口径进行维就不混；用粗维度混了必须标记（而不是静默取平均）',
    bases.size > 1 && pv.notes.length === 0 && coarse.notes.length > 0,
    `${bases.size} 种口径（${[...bases].join('/')}）· q1（口径在行维）标记 ${pv.notes.length} 处 · 粗维度（年×季序）标记 ${coarse.notes.length} 处`);
}

{
  // 独立复算 q10 的平均单产（只取非空值），与查询结果比 —— 交叉验证能抓，但这条不依赖 DuckDB 在场
  const p10 = specOf('q10');
  const rows = T.get('fact_parcel_season').rows;
  const acc = new Map();
  for (const r of rows) {
    const k = String(r.crop_code);
    if (!acc.has(k)) acc.set(k, { n: 0, sum: 0 });
    const v = r.yield_t_ha;
    if (v !== '' && v !== null && v !== undefined && !Number.isNaN(Number(v))) {
      const a = acc.get(k); a.n += 1; a.sum += Number(v);
    }
  }
  const bad = p10.rows.filter((r) => {
    const a = acc.get(r.crop_code);
    if (!a || !a.n) return r.yield_t_ha_avg !== '';
    return Math.abs(Number(r.yield_t_ha_avg) - a.sum / a.n) > 1e-6;
  });
  check('均值型汇总**忽略空值**（空值算 0 会把均值压下去；这条独立复算，不依赖另一套引擎在场）',
    bad.length === 0 && p10.rows.length > 0,
    bad.length ? `${bad.length} 类不符：${bad.map((r) => r.crop_code).join(',')}` : `${p10.rows.length} 类作物的平均单产与"非空值均值"一致`);
}

{
  /*
   * 单产两套口径的判据：① 面积加权必须等于 Σ总产 ÷ Σ面积（独立复算，不依赖另一套引擎）；
   * ② 与"季等权"**确实不同**（若两者恒等，说明面积加权没生效 —— 不过是把等权换个名字）。
   */
  const p12 = specOf('q12');
  const need = p12.rows.filter((r) => r.yield_t_ha_eq !== '' && r.yield_t_ha_area !== '');
  const wrong = need.filter((r) => Math.abs(Number(r.yield_t_ha_area) - Number(r.yield_t_total) / Number(r.area_ha)) > 1e-6);
  const diff = need.filter((r) => Math.abs(Number(r.yield_t_ha_eq) - Number(r.yield_t_ha_area)) > 1e-9).length;
  check('单产两套口径：面积加权 == Σ总产 ÷ Σ面积（独立复算），且与季等权**确实不同**（防"换个名字"）',
    need.length > 0 && wrong.length === 0 && diff >= need.length * 0.5,
    `${need.length} 个"作物·口径·年"组合：两口径不同 ${diff} 个（${round((diff / Math.max(1, need.length)) * 100, 1)}%）· 复算不符 ${wrong.length}`);
}

{
  const p6 = specOf('q6');
  const g = p6.rows.filter((r) => r.level === 'Gemeinde');
  const up = p6.rows.filter((r) => r.level === 'Kreis');
  const sum = (arr, k) => arr.reduce((x, r) => x + r[k], 0);
  check('空间钻取链**上溯一级不丢数**（县域合计 == 乡域合计：地块数/单元数/面积三项）',
    up.length > 0 && sum(up, 'n_parcels') === sum(g, 'n_parcels') && sum(up, 'n_units') === sum(g, 'n_units')
      && Math.abs(sum(up, 'area_ha') - sum(g, 'area_ha')) < 0.5,
    `${g.length} 个乡 → ${up.length} 个县：地块 ${sum(up, 'n_parcels')}、单元 ${sum(up, 'n_units')}、面积 ${round(sum(up, 'area_ha'), 1)} ha`);
}

if (xlsxOut) {
  const f = path.resolve(xlsxOut);
  const okSize = fs.existsSync(f) && fs.statSync(f).size > 8000;
  // 结构自检：xlsx 是 ZIP，前两字节必须是 'PK'（写出器自己实现的 ZIP，先看这层最便宜的判据）
  const head = okSize ? fs.readFileSync(f).subarray(0, 2).toString('latin1') : '';
  check('查询结果已导成**多 sheet Excel**（一张查询一个 sheet + 说明；ZIP 头正确、体积合理）',
    okSize && head === 'PK',
    okSize ? `${(fs.statSync(f).size / 1024).toFixed(0)} KB / ${results.length + 1} 个工作表（图表另由 openpyxl 读回核对）` : '没写出');
}

if (webOut) {
  const payload = JSON.parse(fs.readFileSync(path.resolve(webOut), 'utf8'));
  // **逐格**比（原来只比行列数与总合计：格子的舍入偏差抓不到，等于没验精度同源）
  const bad = payload.views.filter((v) => {
    const src = results.find((x) => x.id === v.id);
    if (!src) return true;
    if (v.kind === 'list') {
      // 对照表：逐格比字符串（数字按 1e-6 相对容差）
      return v.rows.some((row, i) => row.some((x, j) => {
        const a2 = src.spec.rows[i]?.[src.spec.listCols[j]];
        if (a2 === '' || a2 === null || a2 === undefined) return !(x === '' || x === null);
        const na = Number(a2);
        const nx = Number(x);
        if (Number.isNaN(na) || Number.isNaN(nx)) return String(a2) !== String(x);
        return Math.abs(na - nx) > 0.0005;
      }));
    }
    if (!v.matrix.length) return true;
    if (src.pv.rowKeys.length !== v.rowKeys.length || src.pv.colKeys.length !== v.colKeys.length) return true;
    return v.matrix.some((row, i) => row.some((x, j) => {
      const a = src.pv.matrix[i]?.[j];
      if (a === '' || a === null || a === undefined) return !(x === '' || x === null);
      return Math.abs(Number(a) - Number(x)) > 0.0005;   // 3 位小数的舍入余量
    }));
  });
  const cellCount = (v) => (v.kind === 'list' ? v.rows.length * v.cols.length : v.matrix.length * v.colKeys.length);
  check('页面用的**静态视图**（矩阵 + 对照表）与自研结果**逐格同源**（页面只查表，绝不再算一遍）',
    payload.views.length >= 3 && bad.length === 0,
    `${payload.views.length} 个视图 · ${payload.views.reduce((a, v) => a + cellCount(v), 0)} 个格子`
      + `${bad.length ? `，不一致：${bad.map((v) => v.id).join(',')}` : '全部一致'}`);
}

{
  const files = fs.existsSync(OUT) ? fs.readdirSync(OUT) : [];
  const csv = files.filter((f) => f.endsWith('.csv')).length;
  check('查询产物已写出（每个预置查询一份 CSV + 一份可读 Markdown 汇总）',
    csv >= PRESETS.length && files.includes('透视与联合查询.md'), `${OUT}：${csv} 个 CSV + ${files.includes('透视与联合查询.md') ? 1 : 0} 个 md`);
}

{
  /*
   * **事件表 vs 季表的收获单产核对**：`fact_parcel_event` 的收获事件带 `yield_t_ha`，
   * `fact_parcel_season` 也带 —— 同一地块、同一收获日，两处必须一致（描述的是同一次收获）。
   * 这条以前没人核过：交叉验证对事件表只做了计数与合计，单产这一列从没跟季表对上过。
   */
  const events = T.get('fact_parcel_event').rows.filter((r) => r.event_type === 'harvest');
  const seasons = T.get('fact_parcel_season').rows;
  const byParcelDay = new Map(events.map((e) => [`${e.parcel_id}|${e.event_day}`, e]));
  const parcelsWithSeason = new Set(seasons.map((r) => r.parcel_id));
  const miss = [];
  const bad = [];
  for (const r of seasons) {
    if (!r.harvest_day) continue;                      // 有收获日的季才该有收获事件
    const e = byParcelDay.get(`${r.parcel_id}|${r.harvest_day}`);
    if (!e) { miss.push(`${r.parcel_id}@${r.harvest_day}`); continue; }
    const ea = e.yield_t_ha === '' || e.yield_t_ha === null || e.yield_t_ha === undefined;
    const eb = r.yield_t_ha === '' || r.yield_t_ha === null || r.yield_t_ha === undefined;
    if (ea || eb) { if (ea !== eb) bad.push(`${r.parcel_id}@${r.harvest_day}: 一处为空、一处有值`); continue; }
    if (Math.abs(Number(e.yield_t_ha) - Number(r.yield_t_ha)) > 1e-6 * Math.max(1, Math.abs(Number(r.yield_t_ha)))) {
      bad.push(`${r.parcel_id}@${r.harvest_day}: ${e.yield_t_ha} vs ${r.yield_t_ha}`);
    }
  }
  /*
   * 方向是**单向**的：有收获日的季 ⇒ 必须有对应收获事件（且单产一致）；
   * 反过来事件可以多于季 —— 实测多出来的 372 条**全部**是牧草这类"只收不种"的地块
   * （它们没有季表行，所以不是"漏了匹配"，而是口径差异）。下面把这条解释也**当成断言**验一遍，
   * 免得"解释"只是嘴上说说。
   */
  const unmatched = events.filter((e) => !seasons.some((r) => r.parcel_id === e.parcel_id && r.harvest_day === e.event_day));
  const unexplained = unmatched.filter((e) => parcelsWithSeason.has(e.parcel_id));
  check('事件表与季表的收获单产**单向必须全中**（有收获日的季 ⇒ 事件存在且单产一致），差额要能解释',
    seasons.some((r) => r.harvest_day) && miss.length + bad.length === 0 && unexplained.length === 0,
    `${seasons.filter((r) => r.harvest_day).length} 个有收获日的季：缺事件 ${miss.length} · 数值不符 ${bad.length}`
      + `；反向事件多出 ${unmatched.length} 条（全部属于"只收不种"的无季地块，另有 ${unexplained.length} 条无法解释）`
      + (bad.length ? `（例：${bad[0]}）` : ''));
}

{
  /*
   * **农事日历的判据**：总数、按月、三类型三个口径都要对得上，且月×类型矩阵逐格与"直接筛出来数一遍"一致。
   * 透视最容易出的错是"行合计与列的构成对不上"（少算了一类、或某个月被漏掉），所以两边都算。
   */
  const q = results.find((x) => x.id === 'q13');
  const ev = T.get('fact_parcel_event').rows;
  const mn = new Map();
  const ty = new Map();
  for (const r of ev) {
    const ym = `${String(r.event_day).slice(0, 4)}-${String(r.event_day).slice(4, 6)}`;
    mn.set(ym, (mn.get(ym) ?? 0) + 1);
    ty.set(r.event_type, (ty.get(r.event_type) ?? 0) + 1);
  }
  const cellBad = [];
  q.pv.rowKeys.forEach((rk, ri) => {
    let sum = 0;
    q.pv.colKeys.forEach((ck, ci) => {
      const v = q.pv.matrix[ri][ci];
      const n = Number(v === '' || v === null || v === undefined ? 0 : v);
      sum += n;
      if (n !== ev.filter((r) => `${String(r.event_day).slice(0, 4)}-${String(r.event_day).slice(4, 6)}` === rk && r.event_type === ck).length) {
        cellBad.push(`${rk}/${ck}`);
      }
    });
    if (sum !== (mn.get(rk) ?? 0)) cellBad.push(`${rk} 行合计 ${sum} ≠ ${mn.get(rk)}`);
  });
  check('农事日历：**月×类型逐格**与直接筛出来数一遍一致，且行合计 = 该月事件数、列合计 = 该类型事件数',
    q.pv.grand === ev.length && cellBad.length === 0
      && q.pv.colKeys.every((ck, ci) => Number(q.pv.colTotals[ci]) === (ty.get(ck) ?? 0)),
    `${q.pv.rowKeys.length} 个月 × ${q.pv.colKeys.length} 类 = ${q.pv.rowKeys.length * q.pv.colKeys.length} 格，总 ${q.pv.grand} 次`
      + `（事件表 ${ev.length} 行）· 列合计 ${q.pv.colKeys.map((ck, ci) => `${ck} ${q.pv.colTotals[ci]}`).join(' / ')}`
      + (cellBad.length ? ` · 不一致 ${cellBad.slice(0, 3).join('、')}` : ''));
}

{
  /*
   * **时间维必须单调**（防回归）：`rowKeys/colKeys` 默认是"首次出现顺序"，
   * 对时间维就是乱的（农事日历的月份会跳着走）。但又不能全局强排 —— 作物/网格这类无序维排了反而丢分组。
   * 所以逐视图验：凡是**整条键**都形如 年 / 年月 / 年月旬 的，必须严格递增。
   */
  const TIMEISH = /^[0-9]{4}(-[0-9]{1,2})*$/;
  const bad = [];
  let checked = [];
  for (const q of results) {
    if (q.kind !== 'pivot') continue;
    for (const [what, keys] of [['行', q.pv.rowKeys], ['列', q.pv.colKeys]]) {
      const all = keys.map(String);
      if (all.length < 2 || !all.every((k) => TIMEISH.test(k))) continue;
      const sorted = [...all].sort((a, b) => a.localeCompare(b));
      checked.push(`${q.id}${what}`);
      if (all.join('|') !== sorted.join('|')) bad.push(`${q.id}.${what}`);
    }
  }
  {
    /*
     * **q14 的三条判据**：守恒（当日的产量与面积加起来必须等于季表口径的总和）、
     * 逐日独立复算、以及**口径边界**（季表里没有多年生作物 —— 这条是"如实标注"而不是"忘了"）。
     */
    const q = results.find((x) => x.id === 'q14');
    const st = star(T, 'fact_parcel_season');
    const withDay = st.rows.filter((r) => r.harvest_day);
    const sum = (list, f) => list.reduce((a, r) => a + (Number(f(r)) || 0), 0);
    const totHa = sum(withDay, (r) => r.area_ha);
    const totYt = sum(withDay, (r) => r.yield_t);
    const bad = [];
    const rows14 = q.spec.rows;                        // 列表型结果的行在 spec.rows（透视才在 pv）
    for (const day of [rows14[0].day, rows14[rows14.length - 1].day]) {
      const g = withDay.filter((r) => String(r.harvest_day) === day);
      const mine = rows14.find((r) => r.day === day);
      const haul = sum(g, (r) => (Number(r.yield_t) || 0) * (Number(r.t_min_to_store) || 0));
      if (mine.n_parcels !== g.length || Math.abs(mine.area_ha - sum(g, (r) => r.area_ha)) > 1e-6
        || Math.abs(mine.yield_t - sum(g, (r) => r.yield_t)) > 1e-6
        || Math.abs(mine.haul_t_min - haul) > 1e-6) bad.push(day);
    }
    check('收获排产压力：**守恒**（逐日面积/产量加起来 = 季表口径总和）且抽样两天逐项独立复算一致',
      bad.length === 0
        && Math.abs(sum(rows14, (r) => r.area_ha) - totHa) < 0.05
        && Math.abs(sum(rows14, (r) => r.yield_t) - totYt) < 0.05,
      `${rows14.length} 个收获日 · 面积 ${round(sum(rows14, (r) => r.area_ha), 1)}/${round(totHa, 1)} ha`
        + ` · 产量 ${round(sum(rows14, (r) => r.yield_t), 0)}/${round(totYt, 0)} t`
        + (bad.length ? ` · 不一致 ${bad.join('、')}` : ''));
    const peren = withDay.filter((r) => Number(r.gdd_need_cd) === 0);
    check('排产压力的**口径边界**如实标注：多年生作物（牧草/果园）没有"播种→收获"季 ⇒ 不在本表里',
      peren.length === 0 && /多年生/.test(String(q.spec?.note ?? q.note ?? '')),
      `季表里 gdd_need_cd=0 的行 ${peren.length} 条（0 = 边界成立）· 说明里写明了`);
  }
  {
    /*
     * q15 的三条：① 与 q14 同口径（"现状"必须等于 q14 的最大值）；
     * ② **不变量**：两条建议都不许让峰值变差；③ 跨文件一致性：`scenario.json` 的地块索引
     * 与 `dim_parcel` 的行序必须一致（不一致的话"增点"就是算在别的地块上，还看不出来）。
     */
    const q15 = results.find((x) => x.id === 'q15');
    const q14 = results.find((x) => x.id === 'q14');
    const q14max = Math.max(...q14.spec.rows.map((r) => r.haul_t_min));
    const now = q15.spec.rows[0].峰值占用;
    const worse = q15.spec.rows.slice(1).filter((r) => r.峰值占用 > now + 0.5);
    const scen = JSON.parse(fs.readFileSync(path.join(DATA, 'scenario.json'), 'utf8'));
    const gj = JSON.parse(fs.readFileSync(path.join(DATA, 'parcels.geojson'), 'utf8'));
    const ids = gj.features.map((f) => f.properties?.id ?? f.properties?.parcel_id);
    const par = T.get('dim_parcel').rows.map((r) => r.parcel_id);
    check('排产建议：「现状」与 q14 同口径（= q14 的日峰值），且两条建议都**不会让峰值变差**',
      Math.abs(now - q14max) < 0.5 && worse.length === 0,
      `现状 ${round(now, 1)} = q14 峰值 ${round(q14max, 1)} t·min · 更差的建议 ${worse.length} 条`);
    check('排产建议的**跨文件一致性**：`scenario.json` 的地块索引与 `dim_parcel` 行序一致（否则"增点"算在别的地块上）',
      ids.length === par.length && ids.every((x, i) => x === par[i]),
      `${ids.length} 个地块逐个同序 · 错峰降 ${(q15.spec.rows[1].降幅 * 100).toFixed(1)}% vs 增点降 ${(q15.spec.rows[2].降幅 * 100).toFixed(1)}%`);
  }
  check('**时间维按时间排**（年 / 年月 / 年月旬 这类键必须单调递增）',
    bad.length === 0,
    bad.length ? `乱的：${bad.join('、')}` : `已验 ${checked.join('、')}（其余透视的行列键不是纯时间格式，这条判据覆盖不到）`);
}

// 一行耗时分布（不是阈值，是记录）：懒解析后"实际解析了几张表"比"总秒数"更能说明问题
console.log(`[耗时] ${Date.now() - __t0}ms · 解析 ${T.loaded}/${T.size} 张表（懒加载：只解析查询真正用到的）`);
console.log(`\n================ ${pass} 通过 / ${fail} 失败 ================`);
process.exit(fail ? 1 : 0);
