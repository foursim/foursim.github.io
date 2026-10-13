/**
 * 界面层（面板 / 时间轴 / 告警 / 地块详情）。
 *
 * ## 接线纪律（都是从"点了没反应"里换来的，别回退）
 * 1. **事件委托**：列表每帧都可能重建（告警按日变化），监听器只绑在**常驻容器**上；
 * 2. **只写变化**：`setHtml` 记住上次写进去的字符串，没变就不碰 DOM（少重建 = 少打断操作）；
 * 3. **底部留白按 CSS 上限**（`--logbar-max` 那套思路）——面板的 max-height 不依赖 JS 实测，
 *    避免"测量滞后期间面板被底部条压住、按钮点不到"。
 */
import { VARIABLES, legendItems, gradientCss, fmtDay, colorOf } from './geo.js';
import { THEME } from './theme.js';
import { sparkline, bars, colorbar } from './charts.js';

const LAYERS = [
  ['fill', '地块着色'],
  ['parcels', '地块边界'],
  ['roads', '路网'],
  ['poi', '农业设施'],
  ['temp', '区域气温'],
  ['iso', '等时圈（到收储点）'],
  ['units', 'P2 经营单元'],
  ['grids', 'P4 统计网格'],
  ['zones', 'P3 管理分区样点'],
  ['admin', '行政边界（乡/县）'],
  ['villages', '居民点（真实地名）'],
];

/** 地图下方表格区的页签（key / 标题） */
const TABLE_TABS = [
  ['frame', '当前帧指标'],
  ['units', '经营单元'],
  ['crops', '作物与收成'],
  ['alarms', '告警明细'],
];

/**
 * 「当前帧指标」表的行定义：`标签 / 单位 / 取值 / 小数位 / 阈值判定 / 依据`。
 *
 * 阈值判定**复用 main 里的分位数阈值**（`this.th`）—— 表里写的和告警里判的必须是同一套，
 * 否则会出现"表说正常、告警说超标"这种最伤信任的错。
 */
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

export class UI {
  constructor({ model, rows, get, thresholds, actions }) {
    this.model = model;
    this.rows = rows;
    this.get = get;
    this.th = thresholds;
    // 可达性统计（离线算好的分析量，逐日不变）
    {
      const t2 = rows.map((r) => r.t_min).filter((v) => v != null).sort((a, b) => a - b);
      const a2 = rows.map((r) => r.access_m).filter((v) => v != null).sort((x, y) => x - y);
      this.accStat = {
        p50: t2[Math.floor(t2.length / 2)] ?? 0,
        max: t2[t2.length - 1] ?? 0,
        accessP90: a2[Math.floor(a2.length * 0.9)] ?? 0,
      };
    }
    this.actions = actions;
    this.day = 0;
    this.variable = 'progress';
    this.selected = null;
    /** 表格区：数据由 main 算好传进来（同一个来源，避免"表里一套、屏上另一套"） */
    this.tables = {};
    this.activeTable = 'frame';
    this.lastTablesSig = '';
    this.refs = {};
    this.lastHtml = {};
    this.cacheDom();
    this.buildStatic();
    this.bind();
    this.renderStats();
    this.renderAlarms();
    this.renderDetail();
  }

  cacheDom() {
    const ids = ['app', 'topbar', 'site-name', 'day-slider', 'day-label', 'btn-play', 'speed-group',
      'btn-help', 'layer-list', 'var-group', 'legend', 'legend-title', 'stats', 'alarm-count',
      'alarms', 'detail', 'cropbars', 'bottombar', 'toast', 'modal', 'modal-body', 'modal-close',
      'tb-tabs', 'tb-body', 'tb-note', 'btn-export-csv', 'btn-export-png'];
    for (const id of ids) this.refs[id] = document.getElementById(id);
  }

  setHtml(id, html) {
    if (this.lastHtml[id] === html) return false;
    this.lastHtml[id] = html;
    this.refs[id].innerHTML = html;
    return true;
  }

  /** 静态控件只建一次（图层开关、指标按钮、速度档） */
  buildStatic() {
    this.refs['site-name'].textContent = this.model.meta.siteName;
    this.refs['var-group'].innerHTML = Object.entries(VARIABLES).map(([k, v]) => (
      `<button class="mini" data-var="${k}">${v.label}</button>`
    )).join('');
    this.refs['layer-list'].innerHTML = LAYERS.map(([k, label]) => (
      `<label class="lyr"><input type="checkbox" data-layer="${k}" checked> ${label}</label>`
    )).join('');
    this.refs['speed-group'].innerHTML = [[1, '1×'], [4, '4×'], [12, '12×']]
      .map(([d, l]) => `<button class="mini" data-days="${d}">${l}</button>`).join('');
    this.refs['day-slider'].max = String(this.model.days.length - 1);
    this.refs['tb-tabs'].innerHTML = TABLE_TABS
      .map(([k, label]) => `<button class="mini" data-tab="${k}">${label}</button>`).join('');
    this.refs.bottombar.innerHTML = this.footerText();
  }

  footerText() {
    const m = this.model.meta;
    return `地块几何 © OpenStreetMap 贡献者（ODbL）· 路网/设施同源 · 气象锚点 NASA POWER（MERRA-2）`
      + ` · 监测数据由本项目模型生成（种子 ${m.seed}）· 演示区 ${m.siteName}`
      + `<span class="dim"> · ${fmtDay(m.start)} ~ ${fmtDay(m.end)}，逐日 ${this.model.days.length} 天</span>`;
  }

  bind() {
    const { refs, actions } = this;
    const pick = (ev, sel) => (ev.target?.closest ? ev.target.closest(sel) : null);

    refs['var-group'].addEventListener('click', (ev) => {
      const b = pick(ev, 'button[data-var]');
      if (b) actions.onVariable(b.dataset.var);
    });
    refs['speed-group'].addEventListener('click', (ev) => {
      const b = pick(ev, 'button[data-days]');
      if (b) actions.onSpeed(Number(b.dataset.days));
    });
    refs['btn-play'].addEventListener('click', () => actions.onTogglePlay());
    refs['tb-tabs'].addEventListener('click', (ev) => {
      const b = pick(ev, 'button[data-tab]');
      if (!b) return;
      this.activeTable = b.dataset.tab;
      this.renderTables();
    });
    /*
     * **表格 → 地图**（反向联动）：点表格行 ⇒ 地图上高亮相关地块。
     * - 告警明细：行内是具体地块按钮 ⇒ 定位到那一块；
     * - 经营单元：点一行 ⇒ 高亮该单元的全部地块（并框进视野）；
     * - 作物与收成：点一行 ⇒ 高亮该作物的全部地块。
     * 事件委托挂在**常驻容器**上（表格每帧重写，绑在行上必然失效）。
     */
    refs['tb-body'].addEventListener('click', (ev) => {
      const parcel = pick(ev, '[data-parcel]');
      if (parcel) { actions.onFocusParcel(Number(parcel.dataset.parcel)); return; }
      const unit = pick(ev, '[data-unit]');
      if (unit) { actions.onHighlightUnit?.(unit.dataset.unit); return; }
      const crop = pick(ev, '[data-crop]');
      if (crop) actions.onHighlightCrop?.(crop.dataset.crop);
    });
    refs['btn-export-csv'].addEventListener('click', () => actions.onExportCsv?.());
    refs['btn-export-png'].addEventListener('click', () => actions.onExportPng?.());
    refs['btn-help'].addEventListener('click', () => this.openHelp());
    refs['day-slider'].addEventListener('input', () => actions.onDay(Number(refs['day-slider'].value)));
    refs['layer-list'].addEventListener('change', (ev) => {
      const el = pick(ev, 'input[data-layer]');
      if (el) actions.onLayer(el.dataset.layer, el.checked);
    });
    // 告警条目：点击定位到那块地
    refs.alarms.addEventListener('click', (ev) => {
      const el = pick(ev, '[data-parcel]');
      if (el) actions.onFocusParcel(Number(el.dataset.parcel));
    });
    refs.detail.addEventListener('click', (ev) => {
      const el = pick(ev, '[data-focus]');
      if (el) actions.onFocusParcel(this.selected?.i ?? -1);
    });
    // 弹窗三个关闭入口（× / 知道了 / 点遮罩），都不依赖刚写进去的 HTML
    refs['modal-close'].addEventListener('click', () => this.closeHelp());
    refs.modal.addEventListener('click', (ev) => { if (ev.target === refs.modal) this.closeHelp(); });
    globalThis.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') this.closeHelp();
      else if (ev.key === ' ') { ev.preventDefault(); actions.onTogglePlay(); }
    });
  }

  // ==================== 每帧（改变日期时） ====================
  setDay(day) {
    this.day = day;
    this.refs['day-slider'].value = String(day);
    const ymd = this.model.days[day];
    this.refs['day-label'].textContent = fmtDay(ymd);
    this.renderStats();
    this.renderAlarms();
    this.renderDetail();
    this.renderTables();
  }

  setPlaying(on) {
    this.refs['btn-play'].textContent = on ? '⏸' : '▶';
    this.refs['btn-play'].classList.toggle('on', on);
  }

  setSpeed(days) {
    for (const b of this.refs['speed-group'].querySelectorAll('button')) {
      b.classList.toggle('on', Number(b.dataset.days) === days);
    }
  }

  setVariable(key) {
    this.variable = key;
    for (const b of this.refs['var-group'].querySelectorAll('button')) {
      b.classList.toggle('on', b.dataset.var === key);
    }
    this.renderLegend();
    this.renderDetail();
  }

  renderLegend() {
    const spec = VARIABLES[this.variable];
    this.refs['legend-title'].textContent = spec.unit ? `（${spec.unit}）` : '';
    const items = legendItems(this.variable);
    const grad = gradientCss(this.variable);
    const rows = items.map((it) => (
      `<div class="lg-row"><i style="background:${it.color}"></i><span>${it.label}</span></div>`
    )).join('');
    this.setHtml('legend', grad
      ? `${rows}<div id="legend-bar"></div>`
      : rows);
    if (grad) colorbar(document.getElementById('legend-bar'), grad, items[0].label, items[items.length - 1].label);
  }

  // ==================== 区域概览 ====================
  renderStats() {
    const R = this.model.region;
    const d = this.day;
    const temp = R.T2M[d];
    const disMax = R.diseaseLevel[d];
    const disCount = this.rows.filter((r) => this.get(r, 'disease', d) >= 3).length;
    const dry = this.rows.filter((r) => this.get(r, 'water', d) < this.th.waterLow && !r.fallow).length;
    const wet = this.rows.filter((r) => this.get(r, 'water', d) > this.th.waterHigh && !r.fallow).length;
    const harvestedHa = R.harvestedHa.slice(0, d + 1).reduce((a, b) => a + b, 0);
    const cards = [
      ['气温', `${temp.toFixed(1)} ℃`, temp > this.th.tempHigh ? 'bad' : (temp < this.th.tempLow ? 'warn' : '')],
      ['相对湿度', `${R.RH2M[d].toFixed(0)} %`, ''],
      ['当日降水', `${R.PREC[d].toFixed(1)} mm`, R.PREC[d] > this.th.precipHigh ? 'warn' : ''],
      ['区域生长进度', `${Math.round(R.progress[d] * 100)} %`, ''],
      ['水分保持', `${Math.round(R.waterIdx[d] * 100)} %`, dry > 0 ? 'warn' : ''],
      ['养分保持', `${Math.round(R.fertIdx[d] * 100)} %`, ''],
      ['病害最高等级', `${disMax} 级`, disMax >= 4 ? 'bad' : (disMax >= 3 ? 'warn' : 'ok')],
      ['病害地块(≥3级)', `${disCount} 块`, disCount > 60 ? 'bad' : (disCount > 0 ? 'warn' : 'ok')],
      ['累计收获', `${harvestedHa.toFixed(0)} ha`, ''],
      ['低于 p15 / 高于 p85', `${dry} 旱 / ${wet} 涝`, (dry > 40 || wet > 40) ? 'warn' : ''],
      ['到收储点(中位)', `${this.accStat.p50.toFixed(1)} 分`, ''],
      ['到收储点(最远)', `${this.accStat.max.toFixed(1)} 分`, this.accStat.max > 12 ? 'warn' : ''],
      ['下道距离 p90', `${this.accStat.accessP90} m`, this.accStat.accessP90 > 300 ? 'warn' : ''],
    ];
    this.setHtml('stats', cards.map(([k, v, cls]) => (
      `<div class="stat"><span class="dim">${k}</span><b class="${cls}">${v}</b></div>`
    )).join(''));

    // 作物结构（面积条形）。结构在整段时间里是常量 ⇒ 脏检查会让它只写一次，不打断播放。
    const byCrop = Object.entries(this.model.stats.byCrop)
      .filter(([, v]) => v.parcels > 0)
      .map(([k, v]) => ({ key: k, label: v.name, value: v.ha, color: colorOf.crop(k) }));
    // 汇总只列前 4 个作物：全列出来会占两三行，把概览节撑高（那正是"内容溢出到下一节"的诱因之一）
    const top = [...byCrop].sort((a, b) => b.value - a.value);
    const brief = top.slice(0, 4).map((c) => `${c.label} ${c.value.toFixed(0)}ha`).join(' · ')
      + (top.length > 4 ? ` · 另 ${top.length - 4} 种` : '');
    this.setHtml('cropbars', `<canvas id="crop-bars"></canvas><div class="dim small">${brief}</div>`);
    const cvs = document.getElementById('crop-bars');
    if (cvs) bars(cvs, byCrop, { height: 62 });
  }

  // ==================== 告警 ====================
  alarmsFor(day) {
    const out = [];
    const ymd = this.model.days[day];
    const month = Number(ymd.slice(4, 6));
    const growing = month >= 4 && month <= 10;
    const dis = this.rows.filter((r) => this.get(r, 'disease', day) >= this.th.diseaseLevel)
      .sort((a, b) => this.get(b, 'disease', day) - this.get(a, 'disease', day));
    if (dis.length) {
      out.push({
        level: dis.length > 60 ? 'high' : 'mid',
        title: `病害风险：${dis.length} 块地达到 3 级以上`,
        note: `最高 ${this.get(dis[0], 'disease', day)} 级 · ${dis.slice(0, 3).map((r) => r.cropName).join('/')}`,
        items: dis.slice(0, 6).map((r) => ({ i: r.i, text: `${r.cropName} ${r.id} · ${this.get(r, 'disease', day)} 级` })),
      });
    }
    const dry = this.rows.filter((r) => !r.fallow && this.get(r, 'water', day) < this.th.waterLow);
    if (dry.length) {
      out.push({
        level: dry.length > 80 ? 'high' : 'mid',
        title: `水分不足：${dry.length} 块地低于本地 p15`,
        note: `阈值 ${Math.round(this.th.waterLow * 100)}% · 最低 ${Math.round(Math.min(...dry.map((r) => this.get(r, 'water', day))) * 100)}%`,
        items: dry.slice(0, 5).map((r) => ({ i: r.i, text: `${r.cropName} ${Math.round(this.get(r, 'water', day) * 100)}%` })),
      });
    }
    const wet = this.rows.filter((r) => !r.fallow && this.get(r, 'water', day) > this.th.waterHigh);
    if (wet.length) {
      out.push({
        level: wet.length > 120 ? 'high' : 'mid',
        title: `渍涝风险：${wet.length} 块地高于本地 p85`,
        note: this.model.region.PREC[day] > 5 ? `当日降水 ${this.model.region.PREC[day].toFixed(1)} mm` : '',
        items: wet.slice(0, 5).map((r) => ({ i: r.i, text: `${r.cropName} ${Math.round(this.get(r, 'water', day) * 100)}%` })),
      });
    }
    const t = this.model.region.T2M[day];
    if (growing && t > this.th.tempHigh) out.push({ level: 'high', title: `异常高温：日均 ${t.toFixed(1)} ℃`, note: `高于本地生长期 p98（${this.th.tempHigh} ℃）`, items: [] });
    if (growing && t < this.th.tempLow) out.push({ level: 'mid', title: `低温冷害：日均 ${t.toFixed(1)} ℃`, note: `低于本地生长期 p02（${this.th.tempLow} ℃），积温累积会变慢`, items: [] });
    if (this.model.region.PREC[day] > this.th.precipHigh) {
      out.push({ level: 'mid', title: `强降水：${this.model.region.PREC[day].toFixed(1)} mm/日`, note: `高于本地 p97（${this.th.precipHigh} mm），注意养分淋失`, items: [] });
    }
    return out;
  }

  renderAlarms() {
    const list = this.alarmsFor(this.day);
    const sig = JSON.stringify(list.map((a) => [a.level, a.title]));
    this.refs['alarm-count'].textContent = list.length ? `${list.length} 条` : '无';
    if (this.lastHtml.alarms === sig) return;
    this.lastHtml.alarms = sig;
    this.refs.alarms.innerHTML = list.length ? list.map((a) => `
      <div class="alarm ${a.level}">
        <div class="alarm-head"><b>${a.title}</b>${a.note ? `<span class="dim">${a.note}</span>` : ''}</div>
        ${a.items.length ? `<div class="alarm-items">${a.items.map((it) => `<button class="mini" data-parcel="${it.i}">${it.text}</button>`).join('')}</div>` : ''}
      </div>`).join('') : '<p class="hint">当日没有触发阈值的告警。</p>';
  }

  // ==================== 选中地块 ====================
  select(row) {
    this.selected = row;
    this.renderDetail();
  }

  renderDetail() {
    const r = this.selected;
    if (!r) {
      this.setHtml('detail', '<p class="hint">点地图上的地块查看它这一季的农事、产量与监测曲线。</p>');
      return;
    }
    const d = this.day;
    const spec = VARIABLES[this.variable];
    const v = this.get(r, this.variable, d);
    // 积温必须按**当前日**算（`r.gdd` 是整段窗口结束时的值，可能与"当前日进度"对不上 —— 实测出现过
    // "进度 98% 但积温 313/2000"？那是窗口末端的重置值，不是当天的）
    const progNow = r.gddNeed > 0 ? Math.min(1, Math.max(0, this.get(r, 'progress', d))) : 0;
    const events = r.tillage.map((e) => {
      const label = e.type === 'sow' ? '播种' : (e.type === 'harvest' ? `收获${e.t_ha ? ` ${e.t_ha} t/ha` : ''}` : '施肥');
      return `<li><span class="dim">${fmtDay(e.day)}</span> ${label}${e.crop ? ` · ${e.crop}` : ''}</li>`;
    }).join('') || '<li class="dim">（这一季在数据窗口内没有农事事件）</li>';
    const html = `
      <div class="det-head">
        <b>${r.cropName}</b> <span class="dim">${r.id}</span>
        <button class="mini" data-focus="1">定位</button>
      </div>
      <div class="det-grid">
        <span class="dim">面积</span><b>${r.area_ha.toFixed(2)} ha</b>
        <span class="dim">${spec.label}</span><b>${spec.type === 'class' ? (spec.classes.find(([k]) => k === v)?.[1] ?? '—') : (spec.fmt ? spec.fmt(v) : v)}</b>
        <span class="dim">积温</span><b>${Math.round(progNow * r.gddNeed)} / ${r.gddNeed} ℃·d</b>
        <span class="dim">最高病级</span><b class="${r.diseaseLevelMax >= 4 ? 'bad' : (r.diseaseLevelMax >= 3 ? 'warn' : 'ok')}">${r.diseaseLevelMax} 级</b>
        <span class="dim">防治</span><b>${r.treated ? '已防治' : '未防治'}</b>
        <span class="dim">单产/总产</span><b>${r.yields.length ? `${r.yield_t_ha} t/ha · ${r.yield_t} t` : '—'}</b>
        <span class="dim">到收储点</span><b>${r.t_min != null ? `${r.t_min.toFixed(1)} 分` : '—'} <span class="dim">/ 下道 ${r.access_m ?? '—'} m</span></b>
        <span class="dim">归属</span><b>${r.unit_id ?? '—'} <span class="dim">/ ${r.grid_id ?? '—'}</span></b>
        <span class="dim">高程</span><b>${r.elevation_m != null ? `${r.elevation_m} m` : '—'}
          <span class="dim">（气温 ${(r.tempOffsetC ?? 0) >= 0 ? '+' : ''}${(r.tempOffsetC ?? 0).toFixed(2)} ℃）</span></b>
        <span class="dim">土壤</span><b>${r.soil?.texture ? `${r.soil.texture}` : '—'}
          <span class="dim">pH ${r.soil?.ph ?? '—'} · 有机碳 ${r.soil?.soc_g_kg ?? '—'} g/kg</span></b>
      </div>
      <canvas id="det-chart"></canvas>
      <ol class="det-events">${events}</ol>`;
    this.setHtml('detail', html);

    const cvs = document.getElementById('det-chart');
    if (cvs) {
      // `row.series` 是**抽样序列的数组**（main.js 归一过），不是模型原始的样本对象数组
      const step = this.model.meta.stepDays;
      sparkline(cvs, [
        { values: r.series.progress, color: '#c8b93a' },
        { values: r.series.disease, color: '#c0392b' },
        { values: r.series.water, color: '#5fa8c8' },
        { values: r.series.fert, color: '#6fae4a' },
      ], { mark: Math.round(d / step), height: 78, yMax: 1 });
    }
  }

  // ==================== 提示与帮助 ====================
  // ==================== 地图下方的表格区 ====================
  /**
   * 表格数据由 `main.js` 算好传进来 —— **UI 不做聚合**。
   * 这样"表里的数"和"屏上的数"必然同源；两边各算一遍是这类界面最常见的对不上账。
   */
  setTables(tables) {
    const sig = `${this.day}|${tables?.sig ?? ''}`;
    if (this.lastTablesSig === sig) return;
    this.lastTablesSig = sig;
    this.tables = tables ?? {};
    this.renderTables();
  }

  /** 一行单元格：`{text, num, mono, cls}` 或纯字符串 */
  static cellsHtml(cells) {
    return cells.map((c) => {
      const o = typeof c === 'object' && c !== null ? c : { text: c };
      const cls = [o.num ? 'num' : '', o.mono ? 'mono' : '', o.cls ?? ''].filter(Boolean).join(' ');
      return `<td${cls ? ` class="${cls}"` : ''}>${o.text ?? ''}</td>`;
    }).join('');
  }

  static tableHtml(cols, rows) {
    const head = cols.map((c) => {
      const cls = [c.num ? 'num' : '', c.mono ? 'mono' : ''].filter(Boolean).join(' ');
      return `<th${cls ? ` class="${cls}"` : ''}>${c.label}</th>`;
    }).join('');
    const body = rows.map((r) => `<tr${r.cls ? ` class="${r.cls}"` : ''}${r.attrs ?? ''}>${UI.cellsHtml(r.cells)}</tr>`).join('');
    return `<table class="tbl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }

  renderTables() {
    if (!this.refs['tb-body']) return;
    for (const b of this.refs['tb-tabs'].querySelectorAll('button')) {
      b.classList.toggle('on', b.dataset.tab === this.activeTable);
    }
    const t = this.tables ?? {};
    const d = this.day;
    const R = this.model.region;
    const nm = (v, n) => (v == null || Number.isNaN(v) ? '—' : Number(v).toFixed(n));
    let cols = [];
    let rows = [];
    let note = '';

    if (this.activeTable === 'frame') {
      cols = [{ label: '指标' }, { label: '当前值', num: true }, { label: '单位' },
        { label: '阈值判定' }, { label: '近 7 日', num: true }, { label: '依据 / 口径' }];
      rows = FRAME_ROWS.map(([label, unit, getV, dec, rule, ref]) => {
        const v = getV(R, d);
        const dv = v - getV(R, Math.max(0, d - 7));
        const [cls, txt] = rule(v, this.th);
        return {
          cells: [label, { text: nm(v, dec), num: true }, unit,
            { text: txt, cls: `tag ${cls}` },
            { text: `${dv >= 0 ? '+' : ''}${nm(dv, dec)}`, num: true, cls: 'dim' },
            { text: ref, cls: 'dim small' }],
        };
      });
      note = `区域日值 · ${fmtDay(this.model.days[d])} · 逐日`;
    } else if (this.activeTable === 'units') {
      const list = t.units ?? [];
      cols = [{ label: '单元编码', mono: true }, { label: '主导作物' }, { label: '面积 ha', num: true },
        { label: '地块', num: true }, { label: '进度 %', num: true }, { label: '最高病级', num: true },
        { label: '水分 %', num: true }, { label: '养分 %', num: true }, { label: '到收储点 min', num: true }];
      rows = list.map((u) => ({
        cls: u.disease >= 4 ? 'high' : (u.disease >= 3 ? 'mid' : ''),
        attrs: ` data-unit="${u.id}" title="点击：在图上高亮这个单元的地块"`,
        cells: [{ text: u.code, mono: true }, u.crop || '—',
          { text: nm(u.area, 1), num: true }, { text: u.n, num: true },
          { text: nm(u.progress * 100, 1), num: true },
          { text: u.disease, num: true, cls: u.disease >= 3 ? 'bad' : '' },
          { text: nm(u.water * 100, 1), num: true }, { text: nm(u.fert * 100, 1), num: true },
          { text: nm(u.tMin, 1), num: true }],
      }));
      note = `${list.length} 个经营单元（P2）· 面积加权 · 点一行可在图上高亮 · ${fmtDay(this.model.days[d])}`;
    } else if (this.activeTable === 'crops') {
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
    } else {
      const list = this.alarmsFor(d);
      cols = [{ label: '等级' }, { label: '事项' }, { label: '说明' }, { label: '涉及地块（点击定位）' }];
      rows = list.length ? list.map((a) => ({
        cls: a.level === 'high' ? 'high' : 'mid',
        cells: [{ text: a.level === 'high' ? '严重' : '关注', cls: `tag ${a.level === 'high' ? 'bad' : 'warn'}` },
          a.title, { text: a.note || '—', cls: 'dim' },
          { text: a.items.map((it) => `<button class="mini" data-parcel="${it.i}">${it.text}</button>`).join(' '), cls: 'small' }],
      })) : [{ cells: [{ text: '当日没有触发阈值的告警', cls: 'dim' }, '', '', ''] }];
      note = `${list.length} 条 · ${fmtDay(this.model.days[d])}`;
    }

    this.refs['tb-note'].textContent = note;
    this.setHtml('tb-body', UI.tableHtml(cols, rows));
  }

  toast(text, kind = 'info') {
    const el = this.refs.toast;
    el.textContent = text;
    el.className = `show ${kind}`;
    clearTimeout(this._toast);
    this._toast = setTimeout(() => { el.className = ''; }, 2400);
  }

  openHelp() {
    const m = this.model.meta;
    const s = this.model.stats;
    this.refs['modal-body'].innerHTML = `
      <h2>这是什么</h2>
      <p>一个**乡镇尺度**的农业监测 GIS 可视化：地块是真实的，监测值是模型算出来的。</p>
      <h2>数据从哪来（如实标注）</h2>
      <ul>
        <li><b>地块几何：真实</b> —— ${m.siteName} 的 ${s.parcels} 块地（${s.areaHa} ha）来自 OpenStreetMap（ODbL，署名即可用）；</li>
        <li><b>路网与设施：真实</b> —— 田间道/公路、筒仓/谷仓/农资店也来自 OSM（OSM 的农业设施是自愿标注，数量少是真实情况）；</li>
        <li><b>气象：程序生成，用实测校准</b> —— 生成器只用该站的三个实测统计量（年均温、年振幅、雨日频率），
          其余结构（季节相位、天气过程、日较差、辐射、湿度）自己长出来；同期 NASA POWER 实测作为验收锚点
          （月均温相关 r≈0.97、年均温偏差 <1.1℃、年降水 726 vs 866 mm）；</li>
        <li><b>作物/农事/产量/病害/水肥：模型生成</b> —— 不是真实观测，不要当农情依据。</li>
      </ul>
      <h2>模型口径（都能被数据打回）</h2>
      <ul>
        <li><b>适种性由积温决定</b>：本区玉米季 GDD10 = ${m.histGdd?.SILAGE_MAIZE ?? '—'} ℃·d ⇒ 只够<b>青贮玉米</b>，
          粒用玉米需要 1400+ ⇒ 作物结构里没有它；</li>
        <li><b>积温按生育期窗口算</b>（冬小麦 10 月播→次年 7 月收），不是全年；</li>
        <li><b>病害是时空过程</b>：先按温湿算促病指数（RH 低于阈值直接归零），再按风向在邻域传播；</li>
        <li><b>耕作/休耕/收获/产量</b>：按季推进，休耕地块没有播种与产量，收获受农事日历的硬约束；</li>
        <li><b>三层空间单元</b>（参照欧盟 LPIS 把"稳定身份"与"逐年属性"分开的做法）：
          <b>P1 自然田块</b>（${s.parcels} 块，OSM 真实边界）→ <b>P2 经营单元</b>（${s.units ?? 62} 个"连片作业片区"，
          地块几何不变、只挂归属；**作物是属性不是约束**：这片地上同作物相邻极少，用它当约束会聚合失效）→
          <b>P4 统计网格</b>（250 m 规则网格，编码可复现，用于汇总上报）。P3 管理分区是<b>演示</b>：
          25 m 网格采样 + 聚类，建立在模拟属性上，真分区需要 DEM/土壤图/历史产量。</li>
        <li><b>可达性是算出来的分析量</b>：真实路网建图（15 m 内节点合并）→ 从 15 个收储点做多源 Dijkstra，
          再按 10 km/h 补一段"下道"接驳；等时圈层级按本地区分位数定（${(this.model.meta.accessLevels ?? []).join(' / ')} 分钟）。
          局限：接驳是直线、速度是等级经验值 ⇒ <b>只看相对格局，不要当精确行程时间</b>。</li>
        <li><b>告警阈值按本地区分位数</b>（不是绝对量）：水分低于 p15（${Math.round(this.th.waterLow * 100)}%）/高于 p85（${Math.round(this.th.waterHigh * 100)}%）、
          生长期日均温高于 p98（${this.th.tempHigh} ℃）/低于 p02（${this.th.tempLow} ℃）、日降水高于 p97（${this.th.precipHigh} mm）、病害 ≥ ${this.th.diseaseLevel} 级。
          绝对阈值换个地区就失效（本区根区湿度只有 0.61~0.80），所以按分位数定，保证告警在该地区真的会出。</li>
      </ul>
      <h2>怎么用</h2>
      <ul>
        <li><b>视觉</b>：右上角「视觉」下拉在三套政企配色间切换（A 政务深蓝 / B 科技亮蓝 / C 指挥大屏），
          也可用 <code>?theme=tech</code> 直接指定；选择会被记住（URL 参数优先）；</li>
        <li><b>地图下方的表格</b>：当前帧指标 / 经营单元 / 作物与收成 / 告警明细 四个页签，
          右侧「导出 CSV / PNG」把当前这一帧导出（CSV 列名与离线表一致，PNG 自带标题与图例）；</li>
        <li>顶栏切指标、拖时间轴或按 ▶ 播放（空格也可）；</li>
        <li>左栏切图层与看色带图例；右栏是区域指标、当日告警（点条目可定位地块）与选中地块详情；</li>
        <li>点地块看它的农事与曲线：黄=生长进度、红=促病指数、蓝=水分、绿=养分。</li>
      </ul>
      <div class="btnrow"><button class="mini big" data-modal-close="1">知道了</button></div>`;
    this.refs.modal.classList.remove('hidden');
    this.refs['modal-close'].focus?.();
  }

  closeHelp() { this.refs.modal.classList.add('hidden'); }
}
