/**
 * 界面层（面板 / 时间轴 / 告警 / 地块详情）。
 *
 * ## 接线纪律（都是从"点了没反应"里换来的，别回退）
 * 1. **事件委托**：列表每帧都可能重建（告警按日变化），监听器只绑在**常驻容器**上；
 * 2. **只写变化**：`setHtml` 记住上次写进去的字符串，没变就不碰 DOM（少重建 = 少打断操作）；
 * 3. **底部留白按 CSS 上限**（`--logbar-max` 那套思路）——面板的 max-height 不依赖 JS 实测，
 *    避免"测量滞后期间面板被底部条压住、按钮点不到"。
 */
import { VARIABLES, legendItems, gradientCss, fmtDay, colorOf, aggNote, EVENT_STYLE } from './geo.js';
import { THEME, cssVar, PALETTE } from './theme.js';
import { buildReportHtml } from './report.js';
import { sparkline, bars, colorbar, hbars, stackedBars, pairedBars, lineChart, columnChart, pieChart, radarChart, dataRange, scatter } from './charts.js';

const LAYERS = [
  ['fill', '地块着色'],
  ['parcels', '地块边界'],
  ['roads', '路网'],
  ['poi', '农业设施'],
  ['temp', '区域气温'],
  ['iso', '等时圈（到收储点）'],
  ['units', 'P2 经营单元'],
  ['unitfill', '单元着色（面积加权，跟当前指标）'],
  ['scenariofill', '情景对比：到收储点节省（选中候选点后）'],
  ['gridfill', '网格着色（面积加权，跟当前指标）'],
  ['grids', 'P4 统计网格'],
  ['zones', 'P3 管理分区样点'],
  ['admin', '行政边界（乡/县）'],
  ['villages', '居民点（真实地名）'],
];

/**
 * 抽屉里给哪些表配**排行图**、画哪一列。
 *
 * 只给"排行有意义"的表配：作物看面积谁大、问题看命中谁多、单元看谁离收储点最远。
 * 指标表（8 行阈值判定）与告警表本身已是结论，再画图是噪音 —— 不配。
 */
const CHART_SPEC = {
  crops: { col: '面积 ha', top: 10 },
  // 网格排行图用**进度**而不是面积：面积不随时间变 ⇒ 回放时图是僵的（进度会动，播放才看得出东西在变）
  grids: { col: '进度 %', top: 12 },
  // 情景推演：**没选点**时按"受益面积"排行（选了点则被前后对照图接管，见 renderDrawerChart）
  scenario: { col: '受益面积 ha', top: 12 },
  focus: { col: '命中', top: 6 },
  units: { col: '到收储点 min', top: 12 },
};

/** 地图下方表格区的页签（key / 标题） */
/**
 * 表格页签。**简洁版**：不分组、不做查询构造器 ——
 * 五张表覆盖"结论/空间/趋势/异常"，外加一张「重点」放**带名字的业务问题**（联合查询的落地形态）。
 */
/** 抽屉里三类上下文图的中文名（导出文件名与标题条都用它 —— 只有一处定义） */
const DRAWER_CHART_NAME = { rank: '排行图', paired: '情景前后对照', stacked: '农事日历', scatter: '情景候选散点图' };

const TABLE_TABS = [
  ['focus', '重点问题'],
  ['frame', '当前帧指标'],
  ['units', '经营单元'],
  ['grids', '统计网格'],
  ['crops', '作物与收成'],
  ['alarms', '告警明细'],
  ['scenario', '情景推演'],
  // 透视视图：矩阵由 `npm run query --web data/pivot.json` 离线算好，页面**只查表**（纯静态硬线）
  ['pivot', '透视视图'],
  // 常用数据图示：折线看时序、饼看构成、柱看排行、雷达看画像（一屏四张，不引图表库）
  ['charts', '图表'],
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
    // 默认落在「重点问题」：速览的第一眼应该是**结论**，而不是一堆原始读数
    this.activeTable = 'focus';
    this.lastTablesSig = '';
    /** 数据抽屉的状态（打开 / 页签 / 筛选 / 排序） */
    this.drawerOpen = false;
    this.drawerTab = 'focus';
    this.drawerFilter = '';
    this.drawerSort = null;
    /** 列选择：{ 表名: [隐藏的列下标] }，存 localStorage ⇒ 刷新后仍在 */
    this.colHidden = UI.loadColHidden();
    /** 当前抽屉里的图（判据与导出要用它核对） */
    this.drawerChartInfo = null;
    // 情景抽屉这块画布承载两张图：默认先给散点（该建在哪），选点后自动切前后对照（省在哪里）
    this.scenarioChartView = 'scatter';
    /** 图表面板里用户的选择（换天重画时不该被重置） */
    this.chartPick = { lineIdx: 0, radarIdx: 0 };

    /** 离线透视视图（data/pivot.json）与当前选中的那个 */
    this.pivotData = null;
    this.pivotView = 0;
    this.pivotLoadFailed = false;
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
      'tb-tabs', 'tb-body', 'tb-note', 'hl-note', 'btn-clear-hl', 'btn-tb-expand',
      'tablebar', 'btn-export-csv', 'btn-export-png',
      'drawer', 'drawer-mask', 'drawer-close', 'dw-tabs', 'dw-body', 'dw-note', 'dw-count', 'dw-filter',
      'btn-drawer', 'btn-drawer-top', 'btn-dw-csv', 'btn-dw-export',
      'btn-dw-cols', 'dw-cols', 'dw-chart', 'dw-chart-wrap', 'tb-more', 'pivot-sel', 'btn-pivot-csv',
      'btn-scen-view',
      'btn-dw-chart-png', 'btn-dw-scen-view', 'btn-report',
      'tablebar'];
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
      // ⚠️ 勾选框状态要取自**地图的实际可见性**（maps 默认 grids/zones/unitfill/scenariofill 是关的）：
      // 一律渲染成 checked 会让 UI 与地图不一致（判据抓过一次：选点前"情景对比"就显示已勾选）
      `<label class="lyr"><input type="checkbox" data-layer="${k}"${this.layerOn(k) ? ' checked' : ''}> ${label}</label>`
    )).join('');
    this.refs['speed-group'].innerHTML = [[1, '1×'], [4, '4×'], [12, '12×']]
      .map(([d, l]) => `<button class="mini" data-days="${d}">${l}</button>`).join('');
    this.refs['day-slider'].max = String(this.model.days.length - 1);
    this.refs['tb-tabs'].innerHTML = TABLE_TABS
      .map(([k, label]) => `<button class="mini" data-tab="${k}">${label}</button>`).join('');
    this.refs['dw-tabs'].innerHTML = TABLE_TABS
      .map(([k, label]) => `<button class="mini" data-tab="${k}">${label}</button>`).join('');
    // 窄屏用下拉承载"排后面的表"：页签折行会吃掉表体（实测表头 154px vs 表体 39px）
    this.refs['tb-more'].innerHTML = '<option value="">更多…</option>'
      + TABLE_TABS.map(([k, label]) => `<option value="${k}">${label}</option>`).join('');
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
      if (b) this.setTable(b.dataset.tab);
    });
    refs['tb-more'].addEventListener('change', (ev) => {
      if (ev.target.value) this.setTable(ev.target.value);
    });
    // 抽屉里的"导出视图"：无论抽屉页签，按钮只在该页签出现（visible 由 renderPivotSel 控制）
    refs['btn-pivot-csv'].addEventListener('click', () => {
      const text = this.pivotCsvText();
      const v = this.pivotData?.views?.[this.pivotView] ?? {};
      if (text) this.actions?.onDownload?.(text, `透视视图_${v.id ?? 'view'}.csv`);
    });
    refs['btn-scen-view']?.addEventListener?.('click', () => this.actions?.onToggleScenarioView?.());
    // 报告：纯函数生成 HTML ⇒ 直接走同一条下载通道（判据验的是 HTML 本身，不是下载动作）
    refs['btn-report']?.addEventListener?.('click', () => {
      const html = this.reportHtml(this.actions?.onMapImage?.() ?? '');
      this.actions?.onDownload?.(html, `农业监测报告_${fmtDay(this.model.days[this.day] ?? '')}.html`, 'text/html');
    });
    /*
     * 散点图**点选**：点中的圆点 ⇒ 选中该候选点。
     * 用图上返回的 `hit()` 做命中测试（像素位置只有画图那一步知道，别在别处重推一遍）；
     * `tol = 10px`：点云密，太小的容差会"点不中"，太大又会"点一个中另一个"。
     */
    refs['btn-dw-scen-view']?.addEventListener?.('click', () => {
      this.scenarioChartView = this.scenarioChartView === 'scatter' ? 'paired' : 'scatter';
      this.renderDrawer();
    });
    refs['dw-chart']?.addEventListener?.('click', (ev) => {
      const st = this.scatterPick;
      if (!st) return;
      // 画布宽度与存坐标时不一致 ⇒ 坐标已失效：先重画一次（下一次点击就准了）
      if (st.w && Math.abs(ev.target.clientWidth - st.w) > 1) { this.renderDrawer(); return; }
      const i = st.hit(ev.offsetX, ev.offsetY, 10);
      if (i < 0) return;
      this.actions?.onPickCandidateByIndex?.(i);
    });
    refs['pivot-sel'].addEventListener('change', (ev) => {
      this.pivotView = Number(ev.target.value) || 0;
      this.renderTables();
      this.renderDrawer();
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
      const grid = pick(ev, '[data-grid]');
      if (grid) { actions.onHighlightGrid?.(grid.dataset.grid); return; }
      // 情景候选点：点一行 = 在图上选中该点（高亮受影响地块 + 前后对照图 + 图例一起切）
      const cand = pick(ev, '[data-cand]');
      if (cand) {
        const [lng, lat] = cand.dataset.cand.split('|').map(Number);
        actions.onPickCandidate?.({ lat, lng });
        return;
      }
      const crop = pick(ev, '[data-crop]');
      if (crop) { actions.onHighlightCrop?.(crop.dataset.crop); return; }
      // 「重点问题」：点一行 = 在图上高亮该问题的命中地块（联合查询的结果直接落到空间上）
      const q = pick(ev, '[data-question]');
      if (q) actions.onQuestion?.(q.dataset.question);
    });
    // 高亮的状态与取消：状态写在按钮旁边（"图上这一片蓝框是什么"必须一眼能看出、且能一键清掉）
    refs['btn-clear-hl'].addEventListener('click', () => actions.onClearHighlight?.());
    // 展开/收起表格区：小屏上"读数据"与"看地图"分时复用同一块屏幕（不是把表格叠得更高）
    refs['btn-tb-expand'].addEventListener('click', () => {
      const on = refs.tablebar.classList.toggle('expanded');
      refs['btn-tb-expand'].textContent = on ? '收起' : '展开';
      refs['btn-tb-expand'].classList.toggle('on', on);
    });
    // ---- 数据抽屉（全行 + 筛选 + 排序）----
    for (const id of ['btn-drawer', 'btn-drawer-top']) {
      refs[id].addEventListener('click', () => {
        // 打开时**暂停播放**：数字自己在跳的表格没法读（与"透视要冻结时点"同一个道理）
        actions.onPause?.();
        // 跟随 strip 的**当前页签**：抽屉是"当前这张表的全行视图"，打开在别的表上说不通
        //（曾如此：停在「情景推演」点数据视图，抽屉显示的是「经营单元」）
        this.openDrawer(this.activeTable);
      });
    }
    refs['drawer-close'].addEventListener('click', () => this.closeDrawer());
    refs['drawer-mask'].addEventListener('click', () => this.closeDrawer());
    // ---- 列选择（9 列的表在窄屏必须能"先挑列再看"）----
    refs['btn-dw-cols'].addEventListener('click', () => {
      const pop = refs['dw-cols'];
      const nowHidden = pop.classList.toggle('hidden');
      if (!nowHidden) this.renderColsPop();
    });
    refs['dw-cols'].addEventListener('change', (ev) => {
      const cb = pick(ev, 'input[type="checkbox"]');
      if (!cb) return;
      const { cols } = this.buildTable(this.drawerTab);
      const idx = Number(cb.dataset.col);
      const hidden = this.hiddenCols();
      if (cb.checked) hidden.delete(idx);
      else {
        // 至少留一列：全隐藏会让表格变成空壳，这属于"不能让用户进到的状态"，直接挡住
        if (hidden.size + 1 >= cols.length) {
          this.toast('至少保留一列', 'warn');
          cb.checked = true;
          return;
        }
        hidden.add(idx);
      }
      this.colHidden[this.drawerTab] = [...hidden];
      this.saveColHidden();
      this.renderColsPop();
      this.renderDrawer();
    });
    refs['dw-cols'].addEventListener('click', (ev) => {
      if (!pick(ev, '[data-cols-reset]')) return;
      delete this.colHidden[this.drawerTab];
      this.saveColHidden();
      this.renderColsPop();
      this.renderDrawer();
    });
    // 抽屉里的图（排行 / 前后对照 / 堆叠柱）也能导出：图上带着**口径与日期**，离开页面还说得清
    refs['btn-dw-chart-png'].addEventListener('click', () => {
      const url = this.dwChartPng();
      if (!url) { this.toast('这张图还没画好', 'warn'); return; }
      const info = this.drawerChartInfo ?? {};
      const day = fmtDay(this.model.days[this.day] ?? '');
      this.actions?.onDownloadPng?.(url, `图表_${DRAWER_CHART_NAME[info.kind] ?? 'chart'}_${day}.png`);
    });
    refs['btn-dw-csv'].addEventListener('click', () => actions.onExportCsv?.());
    // 导出**当前视图**（筛选 + 排序后的行）：看得懂之后能拿得走，闭环才成立
    refs['btn-dw-export'].addEventListener('click', () => actions.onExportView?.(this.drawerResult()));
    refs['dw-tabs'].addEventListener('click', (ev) => {
      const b = pick(ev, 'button[data-tab]');
      if (b) this.setTable(b.dataset.tab, { drawer: true });
    });
    refs['dw-filter'].addEventListener('input', () => {
      this.drawerFilter = refs['dw-filter'].value;
      this.renderDrawer();
    });
    refs['dw-body'].addEventListener('click', (ev) => {
      // 列头：切换排序（首次点击按降序 —— 这类表关心的是最严重的那几块）
      const th = pick(ev, 'th.sortable');
      if (th) {
        const col = Number(th.dataset.col);
        const st = this.drawerSort;
        this.drawerSort = { col, dir: st && st.col === col ? -st.dir : -1 };
        this.renderDrawer();
        return;
      }
      // 行内联动与底部条**同一套**：地块定位 / 单元·作物·问题高亮
      const parcel = pick(ev, '[data-parcel]');
      if (parcel) { actions.onFocusParcel(Number(parcel.dataset.parcel)); return; }
      const unit = pick(ev, '[data-unit]');
      if (unit) { actions.onHighlightUnit?.(unit.dataset.unit); return; }
      const grid = pick(ev, '[data-grid]');
      if (grid) { actions.onHighlightGrid?.(grid.dataset.grid); return; }
      const cand = pick(ev, '[data-cand]');
      if (cand) {
        const [lng, lat] = cand.dataset.cand.split('|').map(Number);
        actions.onPickCandidate?.({ lat, lng });
        return;
      }
      const crop = pick(ev, '[data-crop]');
      if (crop) { actions.onHighlightCrop?.(crop.dataset.crop); return; }
      const q = pick(ev, '[data-question]');
      if (q) actions.onQuestion?.(q.dataset.question);
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
      // Esc：先关最上层（抽屉盖在帮助之上），否则按了会觉得没反应
      if (ev.key === 'Escape') { if (this.drawerOpen) this.closeDrawer(); else this.closeHelp(); }
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
    this.renderDrawer();
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

  /**
   * 切换图例到"情景对比"档（选点后由 main.js 调用；传 null 恢复指标图例）。
   * 不做这件事的后果：地图上一片绿色块，图例却写着"生长进度 %"，读者没法把它读成"节省分钟"。
   */
  setScenarioLegend(bins) {
    this.scenarioLegend = bins && bins.length ? bins : null;
    this.renderLegend();
  }

  renderLegend() {
    if (this.scenarioLegend) {
      this.refs['legend-title'].textContent = '（情景对比：到收储点节省）';
      this.setHtml('legend', this.scenarioLegend.map((b) => (
        `<div class="lg-row"><i style="background:${b.color}"></i><span>${b.label}</span></div>`
      )).join('') + '<div class="lg-row"><i style="background:#eef1f4"></i><span>基本没改善（< 0.05 分）</span></div>');
      return;
    }
    const spec = VARIABLES[this.variable];
    this.refs['legend-title'].textContent = spec.unit ? `（${spec.unit}）` : '';
    const items = legendItems(this.variable);
    const grad = gradientCss(this.variable);
    const rows = items.map((it) => (
      `<div class="lg-row"><i style="background:${it.color}"></i><span>${it.label}</span></div>`
    )).join('');
    // 口径直接写在图例下面：地图是"面积加权、排除不播种"算出来的，读者得知道这件事
    this.setHtml('legend', (grad
      ? `${rows}<div id="legend-bar"></div>`
      : rows) + `<div class="lg-note">${aggNote(this.variable)}</div>`);
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
      // 配色与图表面板同一套（Okabe-Ito 色盲安全）—— 同一个指标在两处不该是两种颜色
      const mini = [
        { values: r.series.progress, color: PALETTE.orange },
        { values: r.series.disease, color: PALETTE.vermillion },
        { values: r.series.water, color: PALETTE.blue },
        { values: r.series.fert, color: PALETTE.green },
      ];
      // 迷你曲线也**按数据范围铺满**：固定 0~1 时四条线都挤在上半部，看不出差别
      const rr = dataRange(mini.flatMap((s) => s.values));
      // 详情曲线的当前帧：`d` 是模型日下标、`step` 是抽样步长，与 x 格点对齐
      const upto = Math.round(d / step);
      sparkline(cvs, mini, { mark: upto, upto, height: 78, yMin: rr.lo, yMax: rr.hi });
    }
  }

  // ==================== 提示与帮助 ====================
  // ==================== 地图下方的表格区 ====================
  /**
   * 表格数据由 `main.js` 算好传进来 —— **UI 不做聚合**。
   * 这样"表里的数"和"屏上的数"必然同源；两边各算一遍是这类界面最常见的对不上账。
   */
  /**
   * 情景推演结果（`main.js` 在地图上点选后传进来）。
   * 数据来自离线预计算的 `data/scenario.json`：每个候选点都已用**真实路网**重算过全网时间，
   * 浏览器只做"最近候选点的查表"，不在前端跑 Dijkstra（见 `tools/scenario.mjs` 的说明）。
   */
  /**
   * **「图表」面板**：一屏四张常用图（折线 / 饼 / 柱 / 雷达）。
   *
   * 每张图都带**标题 + 口径说明**：图只能表达"量"，口径（谁加权、谁反向、抽了多少点）
   * 必须写在图上，否则读者只能猜（这也是本项目反复踩的一条）。
   * 空数据时图表原语会画一句提示，不会留一张白图。
   */
  renderChartPanel(refName, prefix) {
    const el = this.refs[refName];
    if (!el) return;
    const d = this.actions?.onChartData?.() ?? null;
    if (!d) { el.innerHTML = '<p class="hint">图表数据未就绪</p>'; delete el.dataset.chartSig; return; }
    /*
     * **结构与逐帧分开**：面板结构（四张卡片、序列开关、两个下拉）只在"对象/对比对象变了"时重建，
     * 换天/回放时**只重画**。
     *
     * 起因是回放：原来每换一天就 `innerHTML` 重建一次 —— 一秒钟重建四次画布，
     * 而且判据抓到画布引用会失效（拿到的是刚被丢掉的那张）。数据放 `this._chartData`，
     * 画图闭包每次现取，DOM 就只需要建一次。
     */
    const sig = [refName,
      d.line.objects.map((o) => o.label).join('|'),
      d.radar.compare.map((o) => o.label).join('|')].join('#');
    this._chartData = d;
    if (el.dataset.chartSig !== sig) {
      el.dataset.chartSig = sig;
      // 可见序列集合挂在实例上（跨换天保留）；换对象时重置
      this.chartVisible = new Set((d.line.objects[this.chartPick.lineIdx ?? 0] ?? d.line.objects[0]).series.map((_, i) => i));
      const card = (title, note, id) => `<figure class="chart-card"><figcaption><b>${title}</b><span id="${prefix}-${id}-note">${note}</span></figcaption>`
        + `<canvas id="${prefix}-${id}"></canvas></figure>`;
      // 雷达卡片：**对比对象可选**（原来只能"vs 全场均值"，看不出两个单元的差别）
      // 标题一律读 `d.titles.*`（与数据同处声明）—— 卡片模板里不再写第二份标题
      const radarCard = `<figure class="chart-card"><figcaption><b>${d.titles.radar}</b>`
        + `<span id="${prefix}-radar-note">${d.notes.radar}</span></figcaption>`
        + `<div class="chart-ctl"><label>对比 `
        + `<select id="${prefix}-radar-compare">`
        + d.radar.compare.map((o, i) => `<option value="${o.key}"${i === (this.chartPick.radarIdx ?? 0) ? ' selected' : ''}>${o.label}</option>`).join('')
        + `</select></label>`
        + `<button type="button" class="mini" id="${prefix}-export-png" title="把这一屏四张图拼成一张 PNG 导出">导出图表</button>`
        + `</div><canvas id="${prefix}-radar"></canvas></figure>`;
      /*
       * 折线卡片额外带**序列开关**（点一下只看那一条）：四条序列量纲接近但水平不同，
       * 合看时纵轴只能收到"四者的公共范围"（≈0~1），彼此的高低差看不出来；
       * 只看一条时纵轴收到这一条自己的范围，形状与波动立刻清楚。
       */
      const lineCard = `<figure class="chart-card"><figcaption><b>${d.titles.line}</b>`
        + `<span id="${prefix}-line-note"></span></figcaption>`
        + `<div class="chart-ctl"><label>对象 `
        + `<select id="${prefix}-line-object">`
        + d.line.objects.map((o, i) => `<option value="${o.key}"${i === (this.chartPick.lineIdx ?? 0) ? ' selected' : ''}>${o.label}</option>`).join('')
        + `</select></label></div>`
        + `<div class="chart-toggles" id="${prefix}-line-toggles">`
        + d.line.series.map((s2, i) => `<button type="button" class="chip" data-series="${i}" style="--c:${s2.color}">${s2.label}</button>`).join('')
        + `</div><canvas id="${prefix}-line"></canvas></figure>`;
      // 指引必须放在**图的上方**：底部条只有 ~130px，放在下面用户要先滚动才能看到（等于没有）
      const hint = refName === 'tb-body'
        ? '<div class="chart-hint">底部条只有 ~130px 高：点右上「展开」放大，或打开右侧「数据视图」一次看全四张</div>'
        : '';
      el.innerHTML = hint + `<div class="chart-grid">`
        + lineCard
        + card(d.titles.pie, d.notes.pie, 'pie')
        + card(d.titles.col, d.notes.column, 'col')
        + radarCard
        + `</div>`;
      // 序列开关：至少留一条（全关掉会变成一张空图，属于"用户操作导致的不可能状态"，直接挡住）
      const box = document.getElementById(`${prefix}-line-toggles`);
      if (box) {
        box.addEventListener('click', (ev) => {
          const b = ev.target.closest('.chip');
          if (!b) return;
          const i = Number(b.dataset.series);
          if (this.chartVisible.has(i) && this.chartVisible.size === 1) { this.toast('至少留一条曲线', 'warn'); return; }
          if (this.chartVisible.has(i)) this.chartVisible.delete(i); else this.chartVisible.add(i);
          this.drawChartPanel(prefix);
        });
      }
      const objSel = document.getElementById(`${prefix}-line-object`);
      if (objSel) {
        objSel.addEventListener('change', () => {
          const idx = d.line.objects.findIndex((o) => o.key === objSel.value);
          this.chartPick.lineIdx = idx < 0 ? 0 : idx;
          // 换对象 ⇒ 重置序列开关（旧下标对新对象没有意义）
          this.chartVisible = new Set((d.line.objects[this.chartPick.lineIdx] ?? d.line.objects[0]).series.map((_, i) => i));
          this.drawChartPanel(prefix);
        });
      }
      const cmpSel = document.getElementById(`${prefix}-radar-compare`);
      if (cmpSel) {
        cmpSel.addEventListener('change', () => {
          const i = d.radar.compare.findIndex((o) => o.key === cmpSel.value);
          this.chartPick.radarIdx = i < 0 ? 0 : i;
          this.drawChartPanel(prefix);
        });
      }
      // 导出图表 PNG（四张 canvas 拼一张 + 标题条：离开页面后还说得清是什么口径）
      const btnPng = document.getElementById(`${prefix}-export-png`);
      if (btnPng) {
        btnPng.addEventListener('click', () => {
          const url = this.chartPanelPng(prefix);
          if (!url) { this.toast('图表还没画好', 'warn'); return; }
          this.actions?.onDownloadPng?.(url, `图表_${fmtDay(this.model.days[this.day] ?? '')}.png`);
        });
      }
    }
    this.drawChartPanel(prefix);
    const noteEl = refName === 'tb-body' ? this.refs['tb-note'] : this.refs['dw-note'];
    if (noteEl) noteEl.textContent = '四种常用图表：折线看时序 · 饼看构成 · 柱看排行 · 雷达看画像（数据由 main.js 算好，UI 不做聚合）';
  }

  /**
   * **只重画、不重建**（换天 / 回放时走这条路）。数据每次现从 `this._chartData` 取，
   * 所以 DOM 与事件绑定都只需要建一次。
   */
  drawChartPanel(prefix) {
    const d = this._chartData;
    if (!d) return;
    const vis0 = this.chartVisible ?? new Set();
    // 折线：**只对可见序列收范围**（一条时收到它自己的范围，差异最清楚）；对象可切（区域 / 选中单元）
    const curSeries = (d.line.objects[this.chartPick.lineIdx ?? 0] ?? d.line.objects[0]).series;
    const vis = curSeries.filter((_, i) => vis0.has(i));
    const lineNote = document.getElementById(`${prefix}-line-note`);
    if (vis.length) {
      const rr = dataRange(vis.flatMap((s2) => s2.values));
      // `upto` = 当前帧：回放时只画到那一天，之后的画淡（纵轴仍按全窗口算，不跳）
      const li = lineChart(document.getElementById(`${prefix}-line`), vis,
        { height: 168, xLabels: d.line.xLabels, mark: d.line.mark, upto: d.line.mark, yMin: rr.lo, yMax: rr.hi });
      if (lineNote) {
        lineNote.textContent = `${d.notes.line.split(' · 纵轴')[0]}`
          + (li && !li.zeroBase ? ` · 纵轴 ${rr.lo.toFixed(2)}~${rr.hi.toFixed(2)}（**非零基**：为看清差异）` : ' · 纵轴 0 起（可见序列的实际范围就是如此）');
      }
    } else if (lineNote) {
      lineNote.textContent = d.notes.line.split(' · 纵轴')[0];
    }
    const box = document.getElementById(`${prefix}-line-toggles`);
    if (box) for (const b of box.querySelectorAll('.chip')) b.classList.toggle('off', !vis0.has(Number(b.dataset.series)));
    pieChart(document.getElementById(`${prefix}-pie`), d.pie.items, { height: 168, unit: d.pie.unit });
    columnChart(document.getElementById(`${prefix}-col`), d.column.items,
      { height: 168, unit: d.column.unit, rotateLabels: true, labelValues: true });
    // 雷达：画「单元画像 vs 对比对象」（对比对象用下拉选，默认全场均值）
    const pick = d.radar.series[0];
    const other = d.radar.compare[this.chartPick.radarIdx ?? 0] ?? d.radar.compare[0];
    if (pick && other) {
      radarChart(document.getElementById(`${prefix}-radar`),
        { axes: d.radar.dims, series: [pick, { label: other.label, color: PALETTE.orange, fill: 'rgba(230,159,0,0.16)', values: other.values }] },
        { height: 188 });
    }
    // 图注：换天时日期/分维计数会变，逐帧刷新（结构不动）
    const setNote = (id, txt) => { const n = document.getElementById(`${prefix}-${id}-note`); if (n) n.textContent = txt; };
    setNote('pie', d.notes.pie);
    setNote('col', d.notes.column);
    setNote('radar', d.notes.radar);
  }


  /** 切换表格页签（底部条页签 / 窄屏「更多」下拉 / 抽屉页签都走它，避免三处逻辑各写一遍） */
  setTable(key, { drawer = false } = {}) {
    // 透视数据是**懒加载**的：第一次切到这个页签才取（首屏少一份 JSON），加载完成后再重画一次
    if (key === 'pivot') this.actions?.onNeedPivot?.();
    // 情景候选数据也是懒加载的：第一次切到这个页签才取（首屏少 194 KB）
    if (key === 'scenario') this.actions?.onNeedScenario?.();
    if (drawer) {
      if (this.drawerTab === key) return;
      this.actions?.onClearHighlight?.({ silent: true });
      this.drawerTab = key;
      this.drawerSort = null;   // 换了表，之前的排序列没有意义
      this.colsPopOpen = false;
      this.refs['dw-cols']?.classList?.add?.('hidden');
      this.renderDrawer();
      return;
    }
    if (this.activeTable === key) return;
    // 换页签先清掉上一次的高亮：上一页选的组与这一页无关，留着就是"无关联的高亮"
    this.actions?.onClearHighlight?.({ silent: true });
    this.activeTable = key;
    if (this.refs['tb-more']) this.refs['tb-more'].value = '';
    this.renderTables();
  }

  static loadColHidden() {
    try {
      const raw = globalThis.localStorage?.getItem('agri-monitor-cols');
      return raw ? (JSON.parse(raw) ?? {}) : {};
    } catch { return {}; }   // 隐私模式等读不到 localStorage：不记住即可，不影响功能
  }

  saveColHidden() {
    try {
      globalThis.localStorage?.setItem('agri-monitor-cols', JSON.stringify(this.colHidden ?? {}));
    } catch { /* 同上：记不住不算错 */ }
  }

  hiddenCols(key = this.drawerTab) {
    return new Set(this.colHidden?.[key] ?? []);
  }

  /** 列选择浮层：勾选要显示的列（「全选」= 清掉本表的隐藏设置） */
  renderColsPop() {
    const el = this.refs['dw-cols'];
    if (!el) return;
    const { cols } = this.buildTable(this.drawerTab);
    const hidden = this.hiddenCols();
    const label = (TABLE_TABS.find(([k]) => k === this.drawerTab) ?? [null, this.drawerTab])[1];
    el.innerHTML = `<div class="cols-title">显示哪些列（${label}）
      <button class="mini" data-cols-reset="1" title="恢复显示全部列">全选</button></div>`
      + cols.map((c, i) => `<label><input type="checkbox" data-col="${i}"${hidden.has(i) ? '' : ' checked'}> ${c.label}</label>`).join('');
  }

  /**
   * 抽屉里的排行图：**表看数值、图看谁高谁低**。
   * 只画当前视图的前 N 行（跟着筛选/排序走），所以"筛完再看图"才是有效的动作。
   */
  renderDrawerChart(cols, rows) {
    const wrap = this.refs['dw-chart-wrap'];
    const cvs = this.refs['dw-chart'];
    if (!wrap || !cvs) return;
    /*
     * 情景推演这一块画布上有**两张图**：候选散点（该建在哪）与前后对照（省在哪里）。
     * 默认随状态走 —— 没选点看散点、选了点看前后对照（选点后最想知道"省在哪"）；
     * 切换按钮可以把另一张调回来（否则选过点之后散点就永远看不到了）。
     */
    if (this.drawerTab === 'scenario') {
      const btn = this.refs['btn-dw-scen-view'];
      if (btn) {
        btn.classList.toggle('hidden', !this.scenarioCompare);
        btn.textContent = this.scenarioChartView === 'scatter' ? '看前后对照' : '看散点图';
      }
    }
    // 情景推演的**前后对照**：选过候选点才有，图跟着"当前选中的那个点"走
    if (this.drawerTab === 'scenario' && this.scenarioCompare && this.scenarioChartView !== 'scatter') {
      wrap.classList.remove('hidden');
      this.scatterPick = null;
      this.setChartCaption(cvs, '');
      pairedBars(cvs, this.scenarioCompare, { unit: 'min' });
      this.drawerChartInfo = { kind: 'paired', col: '到收储点 min（现状 → 新建后）', items: this.scenarioCompare };
      return;
    }
    /*
     * 情景推演（**没选点**时）：候选点散点图 —— "面积大"与"省得多"是不是同一批点。
     * 选了点则被上面的"前后对照"接管（那才是那一刻该看的图）。
     */
    if (this.drawerTab === 'scenario') {
      const sc = this.actions?.onScenarioScatter?.();
      if (sc && sc.points.length > 2) {
        /*
         * ⚠️ 两件都必须在**作图之前**做，它们都改变画布宽度，而命中坐标与画布宽度绑定：
         *  1) 先显示容器：`hidden` 时 `clientWidth === 0`，`prepare()` 会退回 240px 兜底宽度
         *     —— 那时算出的坐标属于"240px 的世界"，点选永远点不中（本轮真踩了）；
         *  2) 先建说明行：它占容器一行、也会改变宽度。
         * 先算后改，存的坐标就是旧宽度的。
         */
        wrap.classList.remove('hidden');
        this.setChartCaption(cvs, ' ');
        const meta = scatter(cvs, sc.points, {
          height: 200, xLabel: '受益面积', xUnit: 'ha', yLabel: '平均节省', yUnit: 'min/块',
          picked: sc.picked,
        });
        if (meta) {
          // 点选要看这份坐标（像素位置只有这张图知道），换图时必须清掉（否则点到的是上一张图的坐标）
          // 连画布宽度一起存：宽度变了就说明坐标失效，点选前自己复核（窗口缩放、换布局都会变）
          this.scatterPick = { hit: meta.hit, points: sc.points, w: cvs.clientWidth };
          wrap.classList.remove('hidden');
          this.setChartCaption(cvs, `散点图：${meta.n} 个候选点 · x = 受益面积（ha，越大受益地块越多）`
            + ` · y = 平均节省（min/块，越大越划算）`
            + ` · 虚线圆点是**帕累托前沿 ${meta.frontIdx.length} 个**（不被任何点同时超过 ⇒ 其余点都有"同时更差"的问题）`
            + (meta.dimmed ? ` · 视野外 ${meta.dimmed} 个已画淡（跟"只看视野"按钮联动，分布形状不变）` : '')
            + ` · 表格按面积排序只能看一维，这张图回答的是"**面积最大 ≠ 最划算**"`
            + ` · **点一下圆点可在图上选中该候选点**（选中的画大一点），表格与地图会一起跟过去`);
          this.drawerChartInfo = { kind: 'scatter', col: '受益面积 ha × 平均节省 min', n: meta.n,
            front: meta.frontIdx.length, picked: meta.picked, dimmed: meta.dimmed };
          return;
        }
      }
    }
    this.scatterPick = null;
    this.setChartCaption(cvs, '');
    const spec = CHART_SPEC[this.drawerTab];
    const ci = spec ? cols.findIndex((c) => c.label === spec.col) : -1;
    const text = (c) => String((typeof c === 'object' && c !== null ? c.text : c) ?? '').replace(/<[^>]*>/g, '');
    const items = (spec && ci >= 0 && rows.length)
      ? rows.slice(0, spec.top).map((r, k) => ({
        label: text(r.cells[0]),
        value: Number(text(r.cells[ci]).replace(/[^\d.-]/g, '')) || 0,
        color: k === 0 ? cssVar('--brand', '#1a4f8a') : cssVar('--brand-soft', '#cfe0f5'),
      })).filter((it) => it.value > 0)
      : [];
    if (!items.length) {
      wrap.classList.add('hidden');
      this.drawerChartInfo = null;
      return;
    }
    // 同①：必须在作图前显示（否则按 240px 兜底宽度画，导出/点选都会对不上）
    wrap.classList.remove('hidden');
    hbars(cvs, items, { unit: spec.col });
    // 带上 kind：'rank' = 排行图（'paired' = 前后对照、'stacked' = 堆叠柱），判据/人都能一眼分辨画的是哪种
    this.drawerChartInfo = { kind: 'rank', col: spec.col, items };
  }

  /**
   * 当前透视视图的 CSV 文本（行维 + 各列 + 合计；末行是列合计 + 总合计）。
   *
   * 抽成纯函数是为了**可判据**：判据直接拿它和离线 JSON 对账，而不必去接浏览器的下载流程。
   * 页面里不做任何聚合 —— 数字全部来自 `data/pivot.json`（离线工具算好的）。
   */
  pivotCsvText() {
    const views = this.pivotData?.views ?? [];
    if (!views.length) return '';
    const v = views[Math.min(this.pivotView, views.length - 1)];
    const esc = (x) => (String(x).includes(',') ? `"${String(x).replace(/"/g, '""')}"` : String(x));
    if (v.kind === 'list') {
      const lines2 = [v.cols.map(esc).join(',')];
      for (const row of v.rows) lines2.push(row.map((x) => esc(typeof x === 'number' ? String(x) : x)).join(','));
      return `# ${v.title} · ${v.note}\n${lines2.join('\n')}\n`;
    }
    const f = (x) => (x === '' || x === null || x === undefined || Number.isNaN(Number(x)) ? '' : Number(x).toFixed(v.decimals));
    const head = [v.rowLabel, ...v.colKeys, '合计'];
    const lines = [head.map(esc).join(',')];
    v.rowKeys.forEach((rk, i) => lines.push([rk, ...v.matrix[i].map(f), f(v.rowTotals[i])].map(esc).join(',')));
    lines.push(['合计', ...v.colTotals.map(f), f(v.grand)].map(esc).join(','));
    // 第一行注释性的口径说明：文件名之外，CSV 自己也带得上口径（离开页面还说得清）
    return `# ${v.title} · ${v.agg}(${v.value}) ${v.unit} · 离线生成自 tables/*.csv；口径见 tables/query/透视与联合查询.md\n`
      + `${lines.join('\n')}\n`;
  }

  /** 「导出结果」要导的东西（列 + 筛选排序后的行 + 表名） */
  drawerResult() {
    const label = (TABLE_TABS.find(([k]) => k === this.drawerTab) ?? [null, this.drawerTab])[1];
    return {
      label,
      cols: this.drawerCols ?? [],
      rows: this.drawerRows ?? [],
      filter: this.drawerFilter ?? '',
      sort: this.drawerSort
        ? { label: this.drawerCols?.[this.drawerSort.col]?.label ?? '', dir: this.drawerSort.dir }
        : null,
      day: this.model.days[this.day],
    };
  }

  /** 高亮状态文案（`null` = 当前没有高亮） */
  setHighlightInfo(text) {
    if (this.refs['hl-note']) this.refs['hl-note'].textContent = text ?? '';
    if (this.refs['btn-clear-hl']) {
      const on = !!text;
      this.refs['btn-clear-hl'].classList.toggle('dim', !on);
      this.refs['btn-clear-hl'].title = on
        ? `取消高亮（当前：${text}）；也可以再点一次同一行`
        : '当前没有高亮';
    }
  }

  /**
   * 图容器里的**说明行**（与图同一个容器 ⇒ 图注不会漂到别处去）。
   * 传空串就是清掉（换图时不清会让上一张图的说明留在屏幕上）。
   */
  setChartCaption(cvs, text) {
    if (!cvs?.parentElement) return;
    let cap = cvs.parentElement.querySelector('.dw-chart-cap');
    if (!text) { if (cap) cap.textContent = ''; return; }
    if (!cap) {
      cap = document.createElement('div');
      cap.className = 'dw-chart-cap tb-note';
      cvs.parentElement.appendChild(cap);
    }
    cap.textContent = text;
  }

  /** 情景"前后对照"（按经营单元；`main.js` 选点后算好传进来，本类不做聚合） */
  setScenarioCompare(rows) {
    this.scenarioCompare = rows && rows.length ? rows : null;
    this.renderDrawer();
  }

  setScenario(sc) {
    this.scenario = sc;
    // 选了点 ⇒ 默认给你看"省在哪里"（这是选点后最想知道的事）；想看散点用切换按钮
    this.scenarioChartView = 'paired';
    this.lastTablesSig = ''; // 强制重画（与表格数据的指纹无关）
    this.renderTables();
    // 抽屉开着且正在看情景推演 ⇒ 立刻换图（散点 ⇄ 前后对照），不必等切页签
    if (this.drawerOpen && this.drawerTab === 'scenario') this.renderDrawer();
  }

  /**
   * **一页可打印报告**（自包含 HTML 字符串，纯函数 ⇒ 判据可以直接验）。
   *
   * 为什么做成 HTML 而不是 PDF/Excel：
   * - 图片是 `data:` URL ⇒ 一个文件就能发出去，**不引任何外链**（与本项目"纯静态、无外链"的硬线一致）；
   * - 浏览器里双击就能看、Ctrl+P 就能打印，不依赖任何工具链；
   * - 关键数、图注、口径**都在同一页**：交付给不看代码的人时，他们要知道"这些数怎么算的"。
   *
   * 内容取舍：区域概览（当前帧的关键数）+ 四张图的拼图 + 每张图的一句话口径 + 口径规则原文 + 数据来源。
   * 不做"把 501 行地块全列出来" —— 那是 CSV/Excel 该干的事，报告是给人读的。
   */
  /**
   * 四张图的拼图（dataURL）。页面停在别的页签时，这四张画布**并不在 DOM 里**，
   * 直接拼会得到一张空图 —— 报告就成了"没有图的数据报告"。所以必要时**离屏临时画一份**再拼。
   */
  chartPanelImage() {
    /*
     * 缓存：连点两次「报告」不该重画四张图。
     * 键要含**所有影响画面的状态**（日期、选中地块、指标、折线的对象/可见序列、雷达的对比对象）——
     * 少写一项就会拿到上一帧的图，那是"报告与屏幕不一致"里最难看的一种。
     */
    const key = [this.day, this.selected?.i ?? '', this.variable,
      this.chartPick?.lineIdx ?? 0, this.chartPick?.radarIdx ?? 0,
      [...(this.chartVisible ?? [])].sort().join('')].join('|');
    if (this._chartImg?.key === key && this._chartImg.url) return this._chartImg.url;
    const keep = (url) => { if (url) this._chartImg = { key, url }; return url; };
    const direct = (() => { try { return this.chartPanelPng(); } catch { return ''; } })();
    if (direct) return keep(direct);
    const tmp = document.createElement('div');
    tmp.style.cssText = 'position:absolute;left:-9999px;top:0;width:640px;';
    document.body.appendChild(tmp);
    const keepRef = this.refs['report-tmp'];
    this.refs['report-tmp'] = tmp;
    let url = '';
    // 离屏容器必须有**真实宽度**（宽度为 0 时画布退回 240px 兜底 —— 与本轮点选踩的是同一个坑）
    try { this.renderChartPanel('report-tmp', 'rp'); url = this.chartPanelPng('rp'); } catch { url = ''; }
    if (keepRef === undefined) delete this.refs['report-tmp']; else this.refs['report-tmp'] = keepRef;
    tmp.remove();
    return keep(url);
  }

  /** 一页可打印报告：只负责**凑料**（数据与两张图），模板在 `report.js`（纯函数，可单独验） */
  reportHtml(mapUrl = '') {
    return buildReportHtml({
      meta: this.model.meta,
      day: fmtDay(this.model.days[this.day] ?? ''),
      dayNo: this.day + 1,
      days: this.model.days.length,
      variableLabel: VARIABLES[this.variable]?.label ?? this.variable,
      overview: (this.tables?.questions ?? []).slice(0, 4)
        .map((q) => `<b>${String(q.title ?? '').replace(/</g, '&lt;')}</b>：${String(q.top ?? '').replace(/</g, '&lt;')}`),
      aggLines: ['progress', 'disease', 'crop', 'water', 'fert']
        .map((v) => `<b>${VARIABLES[v]?.label ?? v}</b>：${aggNote(v)}`),
      chartUrl: this.chartPanelImage(),
      mapUrl,
    });
  }

  /**
   * 抽屉里**当前那张上下文图**导出成 PNG（dataURL）：排行 / 情景前后对照 / 农事日历堆叠柱。
   * 与 `chartPanelPng` 同一套做法（另起画布 + 标题条），同样抽成纯函数便于判据。
   */
  dwChartPng() {
    const cv = this.refs['dw-chart'];
    if (!cv || !cv.width || !cv.height) return '';
    const info = this.drawerChartInfo ?? {};
    const name = DRAWER_CHART_NAME[info.kind] ?? '图';
    const pad = 12;
    const head = 26;
    const c = document.createElement('canvas');
    c.width = cv.width + pad * 2;
    c.height = cv.height + head + pad;
    const ctx = c.getContext('2d');
    ctx.fillStyle = cssVar('--panel', '#ffffff');
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = cssVar('--fg', '#12263f');
    ctx.font = 'bold 13px system-ui, sans-serif';
    const day = fmtDay(this.model.days[this.day] ?? '');
    ctx.fillText(`${name}　${info.col ? `口径：${info.col}　` : ''}${day}`, pad, 17);
    ctx.drawImage(cv, pad, head, cv.width, cv.height);
    ctx.strokeStyle = cssVar('--line', '#d3e0ee');
    ctx.strokeRect(pad + 0.5, head + 0.5, cv.width - 1, cv.height - 1);
    return c.toDataURL('image/png');
  }

  /**
   * 把「图表」面板里的四张 canvas 拼成**一张 PNG**（dataURL）。
   *
   * 与「导出地图」同一套做法：另起一张画布把现有 canvas 画进去 + 加标题条。
   * 抽成纯函数是为了**可判据**（不必真去接浏览器的下载流程）。
   */
  chartPanelPng(prefix) {
    const ids = ['line', 'pie', 'col', 'radar'];
    const cs = ids.map((id) => document.getElementById(`${prefix}-${id}`)).filter(Boolean);
    if (!cs.length) return '';
    const w = Math.max(...cs.map((c) => c.width));
    const rowH = Math.max(...cs.map((c) => c.height));
    const rowsN = Math.ceil(cs.length / 2);
    const pad = 12;
    const head = 26;
    const c = document.createElement('canvas');
    c.width = w * 2 + pad * 3;
    c.height = head + rowH * rowsN + pad * (rowsN + 1);
    const ctx = c.getContext('2d');
    ctx.fillStyle = cssVar('--panel', '#ffffff');
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = cssVar('--fg', '#12263f');
    ctx.font = 'bold 13px system-ui, sans-serif';
    const day = fmtDay(this.model.days[this.day] ?? '');
    ctx.fillText(`农业监测 · 常用数据图示（折线/饼/柱/雷达）　${day}`, pad, 17);
    cs.forEach((cv, i) => {
      const x = pad + (i % 2) * (w + pad);
      const y = head + Math.floor(i / 2) * (rowH + pad);
      ctx.drawImage(cv, x, y, w, rowH);
      ctx.strokeStyle = cssVar('--line', '#d3e0ee');
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, rowH - 1);
    });
    return c.toDataURL('image/png');
  }

  /** 图表原语（挂在实例上：判据要能直接验空输入的行为，例如"空数据不画白图"） */
  get charts() {
    return { lineChart, columnChart, pieChart, radarChart, dataRange, scatter };
  }

  /** 某图层当前是否可见（由 main.js 接到地图的真实状态上；取不到就当作可见，保持旧行为） */
  layerOn(name) {
    return this.actions?.onLayerState ? !!this.actions.onLayerState(name) : true;
  }

  /** 同步某个图层勾选框的状态（脚本触发时用：例如选中候选点后自动打开"情景对比着色"） */
  syncLayer(name, on) {
    const el = document.querySelector(`input[data-layer="${name}"]`);
    if (el) el.checked = on;
  }

  /** 离线透视数据到达后调用（数据没到之前这个页签显示"加载中"） */
  setPivot(data) {
    this.pivotData = data ?? null;
    this.pivotLoadFailed = !data;
    this.renderPivotSel();
    this.renderScenarioViewBtn();
    this.renderTables();
    this.renderDrawer();
  }

  /** 透视视图选择器：只在「透视视图」页签（或该页签的抽屉）下出现 —— 别的页签跟它无关，占位就是噪音 */
  renderPivotSel() {
    const sel = this.refs['pivot-sel'];
    if (!sel) return;
    const views = this.pivotData?.views ?? [];
    const on = this.activeTable === 'pivot' || (this.drawerOpen && this.drawerTab === 'pivot');
    /*
     * 控件放哪儿：**都放抽屉**。strip 在 1024×640 下只有 ~370px 宽（左右面板各占一块），
     * 放选择器或导出按钮都会多占一行、把表体挤到 3 行以下（实测 95px < 96px）。
     * 分工：strip = 预览（表 + 口径说明）；抽屉 = 全行视图 + 控件。所以在抽屉的透视页签里才出现。
     */
    const show = on && views.length > 0;
    const inDrawer = show && this.drawerOpen && this.drawerTab === 'pivot';
    sel.classList.toggle('hidden', !inDrawer);
    this.refs['btn-pivot-csv']?.classList?.toggle?.('hidden', !inDrawer);
    // 窄屏进透视图时，"导出 CSV"（导地块）可以让位（strip 宽度吃紧）
    this.refs['tablebar']?.classList?.toggle?.('pivot-mode', show);
    if (views.length && sel.options.length !== views.length) {
      sel.innerHTML = views.map((v, i) => (v.kind === 'list'
        ? `<option value="${i}">${v.title.slice(0, 14)}（${v.rows.length} 行）</option>`
        : `<option value="${i}">${v.rowLabel} × ${v.colLabel}（${v.rowKeys.length}×${v.colKeys.length}）</option>`)).join('');
    }
    if (views.length) sel.value = String(Math.min(this.pivotView, views.length - 1));
  }

  /**
   * **地图视野变了**时该同步的东西：按钮上的候选数、以及抽屉里散点图的"视野外画淡"。
   * （只重画按钮是不够的 —— 图上的淡/实跟着视野走，不重画就还是旧视野的样子。）
   */
  onScenarioViewportChanged() {
    this.renderScenarioViewBtn();
    if (this.drawerOpen && this.drawerTab === 'scenario') this.renderDrawer();
  }

  /**
   * 情景页签的「只看视野」按钮：只在情景页签出现，并显示**当前视野内的候选数**。
   * 按钮文案直接给出数量（「只看视野（37）」）—— 点之前就知道能筛到几个。
   */
  renderScenarioViewBtn() {
    const btn = this.refs['btn-scen-view'];
    if (!btn) return;
    const on = this.activeTable === 'scenario' || (this.drawerOpen && this.drawerTab === 'scenario');
    btn.classList.toggle('hidden', !on);
    if (!on) return;
    const sv = this.actions?.onScenarioList?.();
    if (!sv) return;
    btn.textContent = sv.viewOnly ? `显示全部（${sv.total}）` : `只看视野（${sv.inView}）`;
    btn.classList.toggle('on', !!sv.viewOnly);
  }

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

  /**
   * **一份表格逻辑，两处渲染**：底部条（扫一眼）与数据抽屉（全行/筛选/排序）共用这个方法。
   *
   * 六张表的取数分支只写一遍 —— 否则"底部条说 33 块、抽屉说 38 块"这种账对不上迟早发生
   * （这个项目里已经用同样的理由统一过"阈值/编码/来源"）。
   */
  buildTable(key) {
    const t = this.tables ?? {};
    const d = this.day;
    const R = this.model.region;
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
      note = `${list.length} 个问题 · 点一行在图上高亮命中地块 · ${fmtDay(this.model.days[d])}`;
    } else if (key === 'frame') {
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
        + `病级：${aggNote('disease')}）· 点一行可在图上高亮 · ${fmtDay(this.model.days[d])}`;
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
        + ` · 点一行可在图上高亮 · ${fmtDay(this.model.days[d])}`;
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
      const sv = this.actions?.onScenarioList?.() ?? { list: [], total: 0, inView: 0, viewOnly: false };
      const list = [...sv.list].sort((x, y) => (y.c.improved_ha || 0) - (x.c.improved_ha || 0));
      const meta = this.actions?.onScenarioMeta?.() ?? {};
      const sc = this.scenario;
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
      const views = this.pivotData?.views ?? [];
      if (!views.length) {
        cols = [{ label: '状态' }];
        rows = [{
          cells: [{
            text: this.pivotLoadFailed
              ? '透视数据没取到：先跑 npm run query 生成 data/pivot.json，再用静态服务器打开本页'
              : '透视数据加载中…',
            cls: 'dim wrap',
          }],
        }];
        note = '静态透视视图 · 离线生成，页面只查表';
      } else {
        const v = views[Math.min(this.pivotView, views.length - 1)];
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

    return { cols, rows, note };
  }


  renderTables() {
    this.renderPivotSel();
    this.renderScenarioViewBtn();
    if (!this.refs['tb-body']) return;
    for (const b of this.refs['tb-tabs'].querySelectorAll('button')) {
      b.classList.toggle('on', b.dataset.tab === this.activeTable);
    }
    // 「图表」不是表格，而是一屏四张图：走自己的渲染路径（别硬塞进 cols/rows 那套）
    if (this.activeTable === 'charts') { this.renderChartPanel('tb-body', 'tb'); return; }
    const { cols, rows, note } = this.buildTable(this.activeTable);
    // **行数透明**：132px 里只露 5 行时，用户必须知道"还有多少没看到"（否则会以为看到的就是全部）
    this.refs['tb-note'].textContent = `${note}${note ? ' · ' : ''}共 ${rows.length} 行`;
    this.setHtml('tb-body', UI.tableHtml(cols, rows));
  }

  // ==================== 数据抽屉（全行 + 筛选 + 排序） ====================
  /** 单元格的"可比较值"（数字优先，其次字符串）——筛选与排序都用它 */
  static cellValue(c) {
    const o = typeof c === 'object' && c !== null ? c : { text: c };
    const t = String(o.text ?? '');
    const num = Number(t.replace(/[,%\s]/g, ''));
    return Number.isFinite(num) && t.trim() !== '' ? num : t;
  }

  /** 打开/关闭抽屉；`key` 指定页签 */
  openDrawer(key) {
    if (key) this.drawerTab = key;
    this.drawerOpen = true;
    for (const el of [this.refs.drawer, this.refs['drawer-mask']]) el?.classList?.remove?.('hidden');
    this.renderDrawer();
    // 焦点移到关闭按钮：Esc 与键盘可达（与帮助弹窗同一套习惯）
    try { this.refs['drawer-close']?.focus?.(); } catch { /* 桩环境无 focus */ }
  }

  closeDrawer() {
    this.drawerOpen = false;
    for (const el of [this.refs.drawer, this.refs['drawer-mask']]) el?.classList?.add?.('hidden');
  }

  /** 抽屉里的页签/筛选/排序状态变化后重画 */
  renderDrawer() {
    if (!this.drawerOpen || !this.refs['dw-body']) return;
    for (const b of this.refs['dw-tabs'].querySelectorAll('button')) {
      b.classList.toggle('on', b.dataset.tab === this.drawerTab);
    }
    // 透视控件跟的是"抽屉的页签"，所以每次重画抽屉都要重算一次显隐（漏了就会"切过去控件不出现"）
    this.renderPivotSel();
    this.renderScenarioViewBtn();
    // 抽屉里的「图表」同样走面板
    if (this.drawerTab === 'charts') { this.renderChartPanel('dw-body', 'dw'); return; }
    const { cols, rows, note } = this.buildTable(this.drawerTab);
    /*
     * **列选择**：先投影出"要显示的列"。
     * ⚠️ 投影时保留**原始下标**（`v.i`），否则筛/排/导三处都会跟着错位 ——
     * 而且排序用的是"可见列的下标"（`st.col` 指向 `outCols`），所以投影必须在筛选排序**之前**做完。
     */
    const hidden = this.hiddenCols();
    let vis = cols.map((c, i) => ({ c, i })).filter((v) => !hidden.has(v.i));
    if (!vis.length) vis = [{ c: cols[0], i: 0 }]; // UI 已挡住"全隐藏"，但代码不许假设它一定成功
    const outCols = vis.map((v) => v.c);
    const project = (r) => ({ ...r, cells: vis.map((v) => r.cells[v.i]) });
    // 筛选：任一**可见**列文本包含关键字（大小写不敏感）——筛的就是看得见的那些列
    const kw = String(this.drawerFilter ?? '').trim().toLowerCase();
    let out = rows.map(project);
    if (kw) {
      out = out.filter((r) => r.cells.some((c) => {
        const o = typeof c === 'object' && c !== null ? c : { text: c };
        return String(o.text ?? '').toLowerCase().includes(kw);
      }));
    }
    // 排序：点列头切换 升/降（数字按数值比，文本按字典序）
    const st = this.drawerSort;
    if (st) out = [...out].sort((a, b) => {
      const x = UI.cellValue(a.cells[st.col]);
      const y = UI.cellValue(b.cells[st.col]);
      const cmp = (typeof x === 'number' && typeof y === 'number') ? x - y : String(x).localeCompare(String(y));
      return st.dir * cmp;
    });
    const head = outCols.map((c, i) => {
      const sorted = st && st.col === i;
      const cls = [c.num ? 'num' : '', c.mono ? 'mono' : '', 'sortable', sorted ? 'sorted' : ''].filter(Boolean).join(' ');
      const arrow = sorted ? (st.dir > 0 ? ' ▲' : ' ▼') : '';
      return `<th class="${cls}" data-col="${i}" title="点击按此列排序">${c.label}${arrow}</th>`;
    }).join('');
    this.refs['dw-body'].innerHTML = `<table class="tbl"><thead><tr>${head}</tr></thead><tbody>`
      + out.map((r) => `<tr${r.cls ? ` class="${r.cls}"` : ''}${r.attrs ?? ''}>${UI.cellsHtml(r.cells)}</tr>`).join('')
      + `</tbody></table>${out.length ? '' : '<p class="hint" style="padding:8px 10px">没有匹配的行（试试清空关键字）</p>'}`;
    // 计数放标题栏（可截断、不挤控件）；交互提示放页脚（读起来像"状态栏"）
    const cnt = this.refs['dw-count'];
    if (cnt) cnt.textContent = kw || st ? `${out.length} / ${rows.length} 行` : `共 ${rows.length} 行`;
    const dw = this.refs['dw-note'];
    if (dw) {
      dw.textContent = `${note} · 共 ${rows.length} 行`
        + (out.length !== rows.length ? ` · 筛选后 ${out.length} 行` : '')
        + (st ? ` · 已按「${outCols[st.col]?.label ?? ''}」${st.dir > 0 ? '升序' : '降序'}` : '')
        + (outCols.length < cols.length ? ` · 显示 ${outCols.length}/${cols.length} 列` : '')
        + ' · 点列头排序 · 点行在图上高亮 · 「导出结果」导的就是这张表';
    }
    // 供「导出结果」用：**当前视图**的列 + 过滤排序后的行（导的就是"你现在看到的"）
    this.drawerCols = outCols;
    this.drawerRows = out;
    this.renderDrawerChart(outCols, out);
    // 透视视图自带的图（离线声明 chart 字段）—— 放在排行图**之后**：两边都用同一条画布，谁最后画谁上
    this.renderPivotChart();
  }

  /**
   * 透视视图自带的图（`data/pivot.json` 里 `chart: 'stacked'` 的那种）。
   *
   * **页面不认视图 id**（不写 `if (v.id === 'q13')`）：要不要画图、画成什么，由离线工具在 JSON 里声明。
   * 这样以后再加带图的视图，页面一行都不用改。
   */
  renderPivotChart() {
    const wrap = this.refs['dw-chart-wrap'];
    const cvs = this.refs['dw-chart'];
    if (!wrap || !cvs) return;
    if (this.drawerTab !== 'pivot') return false;
    const v = (this.pivotData?.views ?? [])[Math.min(this.pivotView, (this.pivotData?.views ?? []).length - 1)];
    if (!v || v.chart !== 'stacked' || !v.rowKeys?.length) return false;
    const groups = v.rowKeys.map((rk, i) => {
      const values = {};
      v.colKeys.forEach((ck, ci) => { values[ck] = Number(v.matrix[i][ci]) || 0; });
      // x 轴只留"年-月"的月月两位 + 换年时补上年份，否则 13 个 "2024-10" 会挤在一起
      const [yy, mm] = String(rk).split('-');
      const prev = i > 0 ? String(v.rowKeys[i - 1]).split('-')[0] : null;
      return { label: prev === yy ? mm : `${yy.slice(2)}-${mm}`, values };
    });
    const series = v.colKeys.map((ck) => ({
      key: ck, label: EVENT_STYLE[ck]?.label ?? ck, color: EVENT_STYLE[ck]?.color ?? cssVar('--brand', '#1a4f8a'),
    }));
    wrap.classList.remove('hidden');
    stackedBars(cvs, groups, series, { height: 150 });
    this.drawerChartInfo = { kind: 'stacked', view: v.id, col: series.map((s) => s.label).join('/'), items: groups };
    return true;
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
