/*
 * `js/tables.js` 的**纯函数**判据（node 侧，毫秒级，不需要浏览器）。
 *
 * 为什么单独有这一份：`buildTable(key, ctx)` 是从 `ui.js` 抽出来的纯整形函数，
 * 但把它搬出去时我踩过两个错 —— `th` 按"函数"传（它其实是阈值**对象**）、`FRAME_ROWS` 常量没跟着搬。
 * 这两个错 `node --check` 看不见、冒烟（只验首屏）也看不见，只有切到那个页签才炸。
 * 这份判据**用最小 fixture 喂 ctx**，把这类"形状错/成员漏"在毫秒内抓住。
 *
 * 跑法：npm run test:tables（已接进 npm run ready）
 */
import { buildTable } from '../js/tables.js';

let pass = 0;
let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  [OK]   ${label}${detail ? ` — ${detail}` : ''}`); } else { fail++; console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`); }
};

/** 最小 fixture：只给 buildTable 真正读到的字段 */
const DAYS = 8;
const mkRegion = (v) => Array.from({ length: DAYS }, (_, i) => v);
const ctx = {
  day: 3,
  tables: {
    units: [
      { id: 'u1', code: '09186162-U-0001', crop: '冬小麦', area: 30.5, n: 12, progress: 0.42, disease: 4, water: 0.6, fert: 0.7, tMin: 6.1 },
      // progress=null：**不播种地块**聚合成"无数据"，不能渲染成 0.0%
      { id: 'u2', code: '09186162-U-0002', crop: null, area: 12.0, n: 5, progress: null, disease: 1, water: 0.8, fert: 0.5, tMin: 4.2 },
    ],
    grids: [{ id: 'g1', code: 'G250-3403-21501', crop: '牧草', area: 16.3, n: 8, progress: null, disease: 1, water: 0.5, fert: 0.5, tMin: 5.0 }],
    crops: [{ code: 'wheat', name: '冬小麦', area: 300, parcels: 100, share: 0.3 }],
    questions: [{ key: 'frost', title: '霜冻风险', hits: [1, 2], ha: 12.5, top: '最冷 -3.2℃', note: '气象阈值' }],
  },
  model: {
    days: Array.from({ length: DAYS }, (_, i) => `2024070${i + 1}`),
    region: {
      progress: mkRegion(0.3), disease: mkRegion(1), diseaseLevel: mkRegion(1), waterIdx: mkRegion(0.6), fertIdx: mkRegion(0.7),
      T2M: [5, 6, 7, 8, 9, 10, 11, 12], RH2M: [70, 72, 74, 76, 78, 80, 82, 84], PREC: [0, 1, 0, 2, 0, 0, 5, 0],
      GWETROOT: [0.4, 0.42, 0.44, 0.46, 0.48, 0.5, 0.52, 0.54],
    },
    meta: { siteName: '测试站点', seed: 42 },
  },
  scenario: { cand: { lon: 11.5, lat: 48.6 } },
  pivotData: { views: [{ id: 'q1', kind: 'pivot', rowLabel: '作物', colKeys: ['2024'], decimals: 2, agg: 'mean', value: 'yield_t_ha', unit: 't/ha', rowKeys: ['冬小麦'], matrix: [[6.4]], rowTotals: [6.4], colTotals: [6.4], grand: 6.4, n: 1, note: '测试口径' }] },
  pivotLoadFailed: false,
  pivotView: 0,
  // `th` 必须是**对象**（main 传进来的分位数阈值）；曾经按函数传过 ⇒ 指标表一渲染就抛错
  th: { tempLow: 2, tempHigh: 30, precipHigh: 20, waterLow: 0.3 },
  alarmsFor: () => Promise.resolve([{ level: 'warn', title: '霜冻', note: 'x', items: [] }]),
  actions: {
    onScenarioList: () => ({
      total: 3, inView: 2, viewOnly: false,
      list: [
        // lon/lat 必须有：行上的 data-cand 就是它（点击选点的入口），与 ctx.scenario.cand 对得上才带 ★
        { i: 0, c: { lon: 11.5, lat: 48.6, improved_ha: 100, avg_gain_min: 2.5, avg_min: 4, p50_min: 4, p90_min: 6, max_min: 9, blind_parcels: 10, blind_ha: 30 } },
        { i: 2, c: { lon: 11.52, lat: 48.61, improved_ha: 50, avg_gain_min: 1.5, avg_min: 5, p50_min: 5, p90_min: 7, max_min: 8, blind_parcels: 5, blind_ha: 12 } },
      ],
    }),
  },
};

console.log('\n=== tables.js 纯函数判据（node，无浏览器） ===');

// ---- units：列数 + "无数据"渲染 + 点击属性 ----
{
  const r = buildTable('units', ctx);
  const noData = r.rows[1].cells[4].text;
  check('经营单元表：9 列，`progress=null` 渲染成 `—`（**不是** 0.0%）',
    r.cols.length === 9 && noData === '—',
    `列 ${r.cols.length} 个 · 无数据单元第 5 列 = ${noData}`);
  check('经营单元表：行带 `data-unit`（点击高亮的入口）、病级高的带 `high` 类',
    /data-unit="u1"/.test(r.rows[0].attrs) && r.rows[0].cls === 'high',
    `attrs=${r.rows[0].attrs.slice(0, 28)}… cls=${r.rows[0].cls}`);
}

// ---- frame：阈值对象 + 7 日差分（这一条正是"th 传错形状"的回归守卫）----
{
  const r = buildTable('frame', ctx);
  /*
   * ⚠️ 这里只验**`th` 真的被读进判定**：把 `tempLow` 调到 100（必然越界），首行判定必须跟着变。
   * 说明一件容易误会的事：上一轮那个"`th` 被按函数传"的 bug 出在 **ui.js 的适配器**里，
   * node 侧测 `tables.js` **抓不到**它（那要靠浏览器判据）。这条判据守的是"阈值对象没被忽略"。
   */
  const bumped = buildTable('frame', { ...ctx, th: { ...ctx.th, tempLow: 100 } });
  check('当前帧指标表：`th` 阈值**真的参与判定**（把 tempLow 调到 100，首行判定必须从"正常"变成"越界"）',
    r.rows.length >= 6 && r.rows[0].cells[3].text !== bumped.rows[0].cells[3].text
      && /p2/.test(bumped.rows[0].cells[3].text),
    `正常「${r.rows[0].cells[3].text}」→ tempLow=100 时「${bumped.rows[0].cells[3].text}」`);
  check('当前帧指标表：第 5 列是"近 7 日"差分（带 +/− 号）',
    /^[+-]/.test(r.rows[0].cells[4].text), `近 7 日 = ${r.rows[0].cells[4].text}`);
}

// ---- scenario：B 编号用**原始下标**、★ 标在当前选中的点上 ----
{
  const r = buildTable('scenario', ctx);
  const labels = r.rows.map((row) => row.cells[0].text);
  check('情景表：行编号用**原始下标**（`B-001`/`B-003`，筛过也不重排）',
    labels.includes('B-001') || labels.includes('★ B-001'),
    labels.join(' / '));
  check('情景表：当前选中的候选带 ★（与 `ctx.scenario.cand` 对得上）',
    labels.some((x) => x.startsWith('★')), labels.join(' / '));
}

// ---- pivot：无数据时给提示而不是抛错；有数据时末行是"合计" ----
{
  const empty = buildTable('pivot', { ...ctx, pivotData: null });
  const ok = buildTable('pivot', ctx);
  check('透视表：`pivotData` 为空时给一行提示（不抛错）；有数据时**末行是合计**',
    empty.rows.length === 1 && ok.rows[ok.rows.length - 1].cells[0].text === '合计',
    `空态 ${empty.rows.length} 行 · 有数据 ${ok.rows.length} 行（末行「${ok.rows[ok.rows.length - 1].cells[0].text}」）`);
}

// ---- grids：与 units 同一套"无数据 → —"规则 ----
{
  const r = buildTable('grids', ctx);
  check('统计网格表：9 列，且 `progress=null` 同样渲染成 `—`（两个空间键同一套规则）',
    r.cols.length === 9 && r.rows[0].cells[4].text === '—',
    `列 ${r.cols.length} 个 · 第 5 列 = ${r.rows[0].cells[4].text}`);
}

console.log(`\n================ ${pass} 通过 / ${fail} 失败 ================`);
if (fail > 0) process.exitCode = 1;
