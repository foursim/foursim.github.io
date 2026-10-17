/*
 * 表格数据整形（**纯函数**：不碰 DOM、不读全局状态，全部从 `ctx` 来）。
 *
 * 从 `ui.js` 的 `buildTable()` 搬出来的：那 194 行里只有 10 个 `this` 成员、16 处引用，
 * 却和渲染/事件写在同一个类里 —— 拆出来之后它**不需要浏览器就能验**（喂 ctx、看返回的 cols/rows）。
 * `ui.js` 那边只留一个三行的适配器，负责把自身状态装进 ctx。
 *
 * ctx 需要：`tables / model / day / scenario / pivotData / pivotLoadFailed / pivotView / actions /
 * alarmsFor / th`（少一个就会在对应页签报错 —— 所以适配器是**显式列全**的，不用展开语法糊过去）。
 */

import { fmtDay, aggNote } from './geo.js';

const FRAME_ROWS = [
  ['平均气温', '℃', (R, d) => R.T2M[d], 1,
    (v, th) => (v <= th.tempLow ? ['bad', `≤ 本地 p2（${th.tempLow}℃）`] : (v >= th.tempHigh ? ['bad', `≥ 本地 p98（${th.tempHigh}℃）`] : ['ok', '在常年区间内'])),
    '区域日值（NASA POWER 校准）'],
  ['相对湿度', '%', (R, d) => R.RH2M[d], 0,
    (v) => (v > 85 ? ['warn', '> 85%，病害适宜'] : (v < 40 ? ['warn', '偏干'] : ['ok', '正常'])),
    '中国气象局 病害气象阈值'],
  ['降水', 'mm', (R, d) => R.PREC[d], 1,
    (v, th) => (v >= th.precipHigh ? ['warn', `≥ 本地 p97（${th.precipHigh} mm）`] : (v > 0 ? ['ok', '有降水'] : ['ok', '无降水'])),
    'p97 以上记强降水（淋失/渍涝）'],
  ['根区土壤湿度', '1', (R, d) => R.GWETROOT[d], 3,
    (v) => (v < 0.3 ? ['bad', '偏旱'] : (v > 0.9 ? ['warn', '偏湿'] : ['ok', '适宜'])),
    'NASA POWER GWETROOT 口径'],
  ['生长进度', '1', (R, d) => R.progress[d], 2,
    (v) => (v >= 0.999 ? ['ok', '已达收获进度'] : ['ok', '生长中']), '积温法 GDD（面积加权）'],
  ['病害气象等级', '级', (R, d) => R.diseaseLevel[d], 0,
    (v, th) => (v >= th.diseaseLevel ? ['bad', `${v} 级 ≥ 告警线 ${th.diseaseLevel}`] : ['ok', `${v} 级`]),
    'QX/T 促病指数分级'],
  ['水分保持', '1', (R, d) => R.waterIdx[d], 2,
    (v, th) => (v < th.waterLow ? ['bad', `< 本地 p15（${th.waterLow}）`] : (v > th.waterHigh ? ['warn', `> 本地 p85（${th.waterHigh}）`] : ['ok', '正常'])),
    'FAO-56 土壤水量平衡'],
  ['养分保持', '1', (R, d) => R.fertIdx[d], 2,
    (v) => (v < 0.35 ? ['warn', '偏低'] : ['ok', '正常']), '基肥 − 吸收 − 淋失'],
];

/** 数值格式化：null/NaN 一律 `—`（"无数据"与"0"不是一个意思） */
const nm = (v, d = 1) => (v === null || v === undefined || Number.isNaN(Number(v)) ? '—' : Number(v).toFixed(d));

export function buildTable(key, ctx) {
    const t = ctx.tables ?? {};
    const d = ctx.day;
    const R = ctx.model.region;
    const nm = (v, n) => (v == null || Number.isNaN(v) ? '—' : Number(v).toFixed(n));
    let cols = [];
    let rows = [];
    let note = '';

    if (key === 'focus') {
      const list = t.questions ?? [];
      cols = [{ label: '问题' }, { label: '命中', num: true }, { label: '面积 ha', num: true },
        { label: '最严重 / 摘要' }, { label: '口径（可核对）' }];
      rows = list.map((q) => ({
        attrs: ` data-question="${q.key}" title="点击：在图上高亮这 ${q.hits.length} 块命中地块"`,
        cls: q.hits.length >= 5 ? (q.level ?? '') : '',
        cells: [q.title, { text: String(q.hits.length), num: true }, { text: nm(q.ha, 1), num: true },
          { text: q.top || '—', cls: 'small wrap' }, { text: q.desc, cls: 'dim small wrap' }],
      }));
      note = `${list.length} 个问题 · 点一行在图上高亮命中地块 · ${fmtDay(ctx.model.days[d])}`;
    } else if (key === 'frame') {
      cols = [{ label: '指标' }, { label: '当前值', num: true }, { label: '单位' },
        { label: '阈值判定' }, { label: '近 7 日', num: true }, { label: '依据 / 口径' }];
      rows = FRAME_ROWS.map(([label, unit, getV, dec, rule, ref]) => {
        const v = getV(R, d);
        const dv = v - getV(R, Math.max(0, d - 7));
        const [cls, txt] = rule(v, ctx.th);
        return {
          cells: [label, { text: nm(v, dec), num: true }, unit,
            { text: txt, cls: `tag ${cls}` },
            { text: `${dv >= 0 ? '+' : ''}${nm(dv, dec)}`, num: true, cls: 'dim' },
            { text: ref, cls: 'dim small' }],
        };
      });
      note = `区域日值 · ${fmtDay(ctx.model.days[d])} · 逐日`;
    } else if (key === 'grids') {
      const list = t.grids ?? [];
      cols = [{ label: '网格编码', mono: true }, { label: '主导作物' }, { label: '面积 ha', num: true },
        { label: '地块', num: true }, { label: '进度 %', num: true }, { label: '最高病级', num: true },
        { label: '水分 %', num: true }, { label: '养分 %', num: true }, { label: '到收储点 min', num: true }];
      rows = list.map((g) => ({
        cls: g.disease >= 4 ? 'high' : (g.disease >= 3 ? 'mid' : ''),
        attrs: ` data-grid="${g.id}" title="点击：在图上高亮这个网格的地块"`,
        cells: [{ text: g.code, mono: true }, g.crop || '—',
          { text: nm(g.area, 1), num: true }, { text: g.n, num: true },
          { text: g.progress == null ? '—' : nm(g.progress * 100, 1), num: true },
          { text: g.disease, num: true, cls: g.disease >= 3 ? 'bad' : '' },
          { text: nm(g.water * 100, 1), num: true }, { text: nm(g.fert * 100, 1), num: true },
          { text: nm(g.tMin, 1), num: true }],
      }));
      note = `${list.length} 个统计网格（P4，250 m 规则网格）· 与经营单元**同一套口径**（进度：${aggNote('progress')}；`
        + `病级：${aggNote('disease')}）· 点一行可在图上高亮 · ${fmtDay(ctx.model.days[d])}`;
    } else if (key === 'units') {
      const list = t.units ?? [];
      cols = [{ label: '单元编码', mono: true }, { label: '主导作物' }, { label: '面积 ha', num: true },
        { label: '地块', num: true }, { label: '进度 %', num: true }, { label: '最高病级', num: true },
        { label: '水分 %', num: true }, { label: '养分 %', num: true }, { label: '到收储点 min', num: true }];
      rows = list.map((u) => ({
        cls: u.disease >= 4 ? 'high' : (u.disease >= 3 ? 'mid' : ''),
        attrs: ` data-unit="${u.id}" title="点击：在图上高亮这个单元的地块"`,
        cells: [{ text: u.code, mono: true }, u.crop || '—',
          { text: nm(u.area, 1), num: true }, { text: u.n, num: true },
          // ⚠️ 不能先乘 100 再判空：`null * 100 === 0`，会把"无数据"渲染成"0.0%"（两个意思）
          { text: u.progress == null ? '—' : nm(u.progress * 100, 1), num: true },
          { text: u.disease, num: true, cls: u.disease >= 3 ? 'bad' : '' },
          { text: nm(u.water * 100, 1), num: true }, { text: nm(u.fert * 100, 1), num: true },
          { text: nm(u.tMin, 1), num: true }],
      }));
      note = `${list.length} 个经营单元（P2）· 进度：${aggNote('progress')} · 病级：${aggNote('disease')}`
        + ` · 点一行可在图上高亮 · ${fmtDay(ctx.model.days[d])}`;
    } else if (key === 'crops') {
      const list = t.crops ?? [];
      cols = [{ label: '作物' }, { label: '地块数', num: true }, { label: '面积 ha', num: true },
        { label: '平均单产 t/ha', num: true }, { label: '总产 t', num: true },
        { label: '单产口径' }, { label: '参考单产 t/ha', num: true }];
      rows = list.map((c) => ({
        attrs: ` data-crop="${c.code}" title="点击：在图上高亮这种作物的地块"`,
        cells: [c.name, { text: c.n, num: true }, { text: nm(c.area, 1), num: true },
          { text: c.yieldHa > 0 ? nm(c.yieldHa, 1) : '—', num: true },
          { text: c.yieldT > 0 ? nm(c.yieldT, 1) : '—', num: true },
          { text: c.basis || '—', cls: 'dim' },
          { text: c.ref ? nm(c.ref, 1) : '—', num: true, cls: 'dim' }],
      }));
      note = `按作物聚合（收成粒度到季）· 点一行可在图上高亮 · ${list.length} 类`;
    } else if (key === 'scenario') {
      /*
       * **候选点排行表**（154 个候选，全部来自离线 `data/scenario.json` —— 页面不做任何聚合）。
       *
       * 为什么从"只显示选中的那一个"改成"排行全表"：上一版只能"点哪看哪"，
       * 用户没法回答"到底该建在哪" —— 而这是情景推演唯一要回答的问题。
       * 现在：所有候选的指标都成了**列**（受益面积 / 平均节省 / 新建后的 平均·p50·p90·最远 / 盲区），
       * 点一行 = 在图上选中该候选点（地图高亮 + 前后对照图 + 图例一起切）；
       * 现状那一列对每个候选都一样，所以写进表注（不占一列）。
       */
      // 下标必须留着：编号 B-001 是**离线数据里的位置**，排序不该改变编号（否则编号随排序乱跳）
      // 列表由数据侧给（含"只看当前视野"的筛选结果）；条目带**原始下标**，行编号不会跟着漂
      const sv = ctx.actions?.onScenarioList?.() ?? { list: [], total: 0, inView: 0, viewOnly: false };
      const list = [...sv.list].sort((x, y) => (y.c.improved_ha || 0) - (x.c.improved_ha || 0));
      const meta = ctx.actions?.onScenarioMeta?.() ?? {};
      const sc = ctx.scenario;
      const picked = sc?.cand ?? null;
      const on = (c) => picked && Math.abs(picked.lon - c.lon) < 1e-9 && Math.abs(picked.lat - c.lat) < 1e-9;
      cols = [
        { label: '候选点', mono: true }, { label: '受益面积 ha', num: true }, { label: '平均节省 min', num: true },
        { label: '新建后 平均', num: true }, { label: 'p50', num: true }, { label: 'p90', num: true },
        { label: '最远', num: true }, { label: '盲区块', num: true }, { label: '盲区 ha', num: true },
      ];
      rows = list.map(({ c, i }) => ({
        cls: on(c) ? 'high' : '',
        attrs: ` data-cand="${c.lon.toFixed(5)}|${c.lat.toFixed(5)}" title="点击：在图上选中这个候选点"`,
        cells: [
          { text: `${on(c) ? '★ ' : ''}B-${String(i + 1).padStart(3, '0')}`, mono: true },
          { text: nm(c.improved_ha, 1), num: true },
          { text: nm(c.avg_gain_min, 2), num: true, cls: c.avg_gain_min >= 0.5 ? 'bad' : '' },
          { text: nm(c.avg_min, 2), num: true }, { text: nm(c.p50_min, 2), num: true },
          { text: nm(c.p90_min, 2), num: true }, { text: nm(c.max_min, 2), num: true },
          { text: String(c.blind_parcels), num: true }, { text: nm(c.blind_ha, 1), num: true },
        ],
      }));
      const base = sc?.base ?? meta.baseline ?? null;
      const best = list.length ? ` · 受益最大的候选：B-${String(list[0].i + 1).padStart(3, '0')}（${list[0].c.improved_ha} ha，表首行）` : '';
      note = (sv.viewOnly
        ? `${list.length} / ${sv.total} 个候选点 · **已按当前地图视野筛选**（筛选只动列表：指标是离线按**全网**重算的，不是视野内重算）`
        : `${list.length} 个候选点`) + `（离线真实路网重算，${meta.step_m ?? '?'} m 网格）· **按受益面积排序**`
        + (base ? ` · 现状：平均 ${base.avg_min} / p50 ${base.p50_min} / p90 ${base.p90_min} 分，盲区 ${base.blind_parcels} 块 / ${base.blind_ha} ha` : '')
        + (picked ? ` · 已选 ★（平均可省 ${picked.avg_gain_min} 分钟/块）` : best)
        + ' · 点一行可在图上选中该候选点';
    } else if (key === 'charts') {
      // 面板自己会画（见 renderChartPanel）；这里只是让"列选择/导出/筛选"这类表格逻辑有个合法的空数据
      cols = [{ label: '图表' }];
      rows = [];
      note = '图表页签（一屏四张图，见下方说明）';
    } else if (key === 'pivot') {
      /*
       * **静态透视视图**：矩阵、行列合计、总合计全部由离线工具算好（`npm run query --web data/pivot.json`），
       * 页面只把矩阵画成表 —— 不做任何聚合、不连任何服务。理由见 README「纯静态保证」：
       * 页面必须零依赖、首屏不卡，而透视是离线工具的事（62×54 这种规模也不该在浏览器里现算）。
       */
      const views = ctx.pivotData?.views ?? [];
      if (!views.length) {
        cols = [{ label: '状态' }];
        rows = [{
          cells: [{
            text: ctx.pivotLoadFailed
              ? '透视数据没取到：先跑 npm run query 生成 data/pivot.json，再用静态服务器打开本页'
              : '透视数据加载中…',
            cls: 'dim wrap',
          }],
        }];
        note = '静态透视视图 · 离线生成，页面只查表';
      } else {
        const v = views[Math.min(ctx.pivotView, views.length - 1)];
        if (v.kind === 'list') {
          // 对照表：离线算好的几列并排（没有行列合计的概念，直接照抄）
          cols = v.cols.map((c) => ({ label: c }));
          rows = v.rows.map((row) => ({ cells: row.map((x) => (typeof x === 'number' ? { text: String(x), num: true } : String(x))) }));
          // **离线写好的说明要上页面**：q14 的"最堵的一天"、q15 的"为什么错峰更管用"都在 `note` 里，
          // 原来页面只显示"离线生成，页面只查表" —— 结论明明算了、却没人看得到
          note = `${v.title} · ${v.rows.length} 行 × ${v.cols.length} 列 · 离线生成，页面只查表`
            + (v.note ? ` · ${v.note}` : '');
          return { cols, rows, note };
        }
        const f = (x) => (x === '' || x === null || x === undefined || Number.isNaN(Number(x)) ? '—' : Number(x).toFixed(v.decimals));
        cols = [{ label: v.rowLabel }, ...v.colKeys.map((ck) => ({ label: ck, num: true })), { label: '合计', num: true }];
        rows = v.rowKeys.map((rk, ri) => ({
          cells: [{ text: String(rk), cls: 'mono' }, ...v.matrix[ri].map((x) => ({ text: f(x), num: true })),
            { text: f(v.rowTotals[ri]), num: true, cls: 'dim' }],
        }));
        // 末行是"合计"：与右侧的列合计、右下角的总合计构成一次可核对的守恒（判据会逐格求和比对）
        rows.push({
          cells: [
            { text: '合计', cls: 'mono' },
            ...v.colTotals.map((x) => ({ text: f(x), num: true, cls: 'dim' })),
            { text: f(v.grand), num: true, cls: 'dim' },
          ],
        });
        note = `${v.title} · ${v.agg}(${v.value}) ${v.unit} · ${v.rowKeys.length} × ${v.colKeys.length}`
          + ` · 离线生成，页面只查表` + (v.note ? ` · ${v.note}` : '');
      }
    } else {
      const list = ctx.alarmsFor(d);
      cols = [{ label: '等级' }, { label: '事项' }, { label: '说明' }, { label: '涉及地块（点击定位）' }];
      rows = list.length ? list.map((a) => ({
        cls: a.level === 'high' ? 'high' : 'mid',
        cells: [{ text: a.level === 'high' ? '严重' : '关注', cls: `tag ${a.level === 'high' ? 'bad' : 'warn'}` },
          a.title, { text: a.note || '—', cls: 'dim' },
          { text: a.items.map((it) => `<button class="mini" data-parcel="${it.i}">${it.text}</button>`).join(' '), cls: 'small' }],
      })) : [{ cells: [{ text: '当日没有触发阈值的告警', cls: 'dim' }, '', '', ''] }];
      note = `${list.length} 条 · ${fmtDay(ctx.model.days[d])}`;
    }

    return { cols, rows, note };
  }


