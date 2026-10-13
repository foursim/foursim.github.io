/**
 * 装配与播放循环。
 *
 * 这一层只做三件事：**取数据 → 跑模型 → 把"当前日"同步给地图与面板**。
 * 「当前日」是整个界面的唯一时间源（地图着色、指标卡、告警、选中地块曲线都读它），
 * 所以时间轴一处推进，所有视图一起动 —— 这是这类监测界面最容易做错的地方
 * （各视图各存一份状态，播着播着就对不上了）。
 */
import { simulate, levelOf, CROPS } from './agro.js';
import { AgriMap } from './map.js';
import { UI } from './ui.js';
import { cssVar, THEME } from './theme.js';
import { VARIABLES, legendItems, fmtDay } from './geo.js';

const SITE = { name: 'Hallertau · Wolnzach（德国 巴伐利亚）', seed: 20261013 };

const $ = (id) => document.getElementById(id);
async function loadJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

function fatal(err) {
  console.error(err);
  $('map').innerHTML = `<div class="fatal"><h2>页面初始化失败</h2>
    <p>${String(err.message ?? err)}</p>
    <p class="dim">先跑 <code>npm run data:parcels &amp;&amp; npm run data:roads &amp;&amp; npm run data:poi &amp;&amp; npm run data:weather</code>
    生成 <code>data/</code> 下的文件，再通过本地服务器打开（<code>npm run serve</code>）。<br>
    注意：<code>file://</code> 直接打开会被浏览器的模块/CORS 规则拦住，必须用 http 服务。</p></div>`;
}

try {
  const [parcelsFC, roadsFC, poiFC, weatherFile, access, isochrones, unitsJson, unitsFC, gridsFC, adminFC,
    soilFile, elevFile, villagesFC] = await Promise.all([
    loadJson('data/parcels.geojson'),
    loadJson('data/roads.geojson'),
    loadJson('data/poi.geojson'),
    loadJson('data/weather_daily.json'),
    loadJson('data/access.json'),
    loadJson('data/isochrones.geojson'),
    loadJson('data/units.json'),
    loadJson('data/units.geojson'),
    loadJson('data/grids.geojson'),
    loadJson('data/admin.geojson'),
    loadJson('data/soil.json'),
    loadJson('data/elevation.json'),
    loadJson('data/villages.geojson'),
  ]);

  // 地图要素与模型输出按**下标对齐**（模型不关心几何，界面靠 i 索引二者）
  parcelsFC.features.forEach((f, i) => { f.properties.i = i; });

  const model = simulate({
    seed: SITE.seed,
    siteName: SITE.name,
    parcels: parcelsFC.features,
    weather: { days: weatherFile.days, vars: weatherFile.vars, source: 'nasa-power' },
    lat: weatherFile.metadata.lat,
    elevation: weatherFile.metadata.elevation_m,
    // 真实土壤（SoilGrids）→ 土壤生产潜力；真实高程（Copernicus GLO-90）→ 地块级气温
    soil: soilFile.parcels,
    elevationM: elevFile.elevation_m,
  });
  model.meta.accessLevels = access.levels_min;
  model.meta.units = unitsJson.stats.units;

  const step = model.meta.stepDays;
  const lerp = (arr, day) => {
    const x = day / step;
    const i0 = Math.min(arr.length - 1, Math.max(0, Math.floor(x)));
    const i1 = Math.min(arr.length - 1, i0 + 1);
    return arr[i0] + (arr[i1] - arr[i0]) * (x - i0);
  };

  /** 统一视图：每个地块一行，带抽样序列（地图与面板都读它） */
  const rows = model.parcels.map((p, i) => ({
    ...p,
    i,
    // 可达性：离线算好的"分析量"，按地块下标一一对应（与模型输出顺序一致）
    t_min: access.t_min[i],
    access_m: access.access_m[i],
    // 三层空间单元的归属（P1 地块 / P2 经营单元 / P4 统计网格）
    unit_id: unitsJson.parcel[i]?.unit_id ?? null,
    // 真实外部数据（都是开放数据，见 tables/dim_source）
    elevation_m: p.elevation_m,
    tempOffsetC: p.temp_offset_c,
    soil: soilFile.parcels[i] ?? null,
    grid_id: unitsJson.parcel[i]?.grid_id ?? null,
    series: {
      progress: p.series.map((s) => s.prog),
      disease: p.series.map((s) => s.dis),
      water: p.series.map((s) => s.water),
      fert: p.series.map((s) => s.fert),
    },
  }));

  const ymdAt = (day) => model.days[Math.min(model.days.length - 1, Math.max(0, day))];

  /** 耕作状态：由"当前处在哪一季 + 事件 + 进度"推出来 */
  function tillageOf(row, day) {
    const ymd = ymdAt(day);
    if (row.fallow) return 'fallow';
    const seasons = row.seasons ?? [];
    if (!seasons.length) {
      // 多年生（牧草/果园）：常年"在长"，割草后 30 天内算已收获
      const last = row.harvestDays?.[row.harvestDays.length - 1];
      if (last && ymd >= last && day - model.days.indexOf(last) < 30) return 'harvested';
      return 'growing';
    }
    let cur = null;
    for (const s of seasons) if (s.sow <= ymd) cur = s;
    if (!cur) return 'unsown';
    const harv = (row.harvestDays ?? []).find((d) => d >= cur.sow);
    if (harv && ymd >= harv) return 'harvested';
    const prog = lerp(row.series.progress, day);
    if (prog >= 0.9) return 'mature';
    if (prog > 0.05) return 'growing';
    return 'sown';
  }

  /** 访问器：`get(row, 变量, 日)` —— 地图着色、图例、面板、曲线全走它 */
  const get = (row, key, day) => {
    switch (key) {
      case 'crop': return row.crop;
      case 'tillage': return tillageOf(row, day);
      case 'yield': return row.harvestDay && ymdAt(day) >= row.harvestDay ? row.yield_t_ha : 0;
      // ⚠️ 病害的序列存的是**促病指数 0~1**（连续、适合画曲线），但界面按**等级 1~5**读
      //（图例/告警/详情都是"几级"）。第一版把指数直接当等级 ⇒ 地图永远显示 1 级绿、告警永不触发。
      case 'disease': return levelOf(lerp(row.series.disease, day));
      case 'access': return row.t_min ?? 0; // 离线常量，与日期无关
      // 地块级气温 = 区域日气温 + 真实高程差带来的偏移（直减率 -0.65 ℃/100 m）
      case 'tempParcel': return model.region.T2M[day] + (row.tempOffsetC ?? 0);
      case 'texture': return row.soil?.texture ?? null;
      case 'unit': return row.unit_id;
      case 'grid': return row.grid_id;
      case 'progress': case 'water': case 'fert':
        return lerp(row.series[key], day);
      default: return 0;
    }
  };

  /**
   * 告警阈值**按本地区分位数定**，不用绝对量。
   *
   * 为什么：绝对阈值换个地区立刻失效 —— 本区实测根区湿度只在 0.61~0.80、生长期日均温最高 25.7℃，
   * 于是"湿度<40% 算干旱""日均>32℃ 算热害"永远不触发，告警模块形同虚设（第一版正是如此）。
   * 分位数阈值保证"该地区真的会出告警"，而且语义清楚：低于本地 p15 / 高于 p98。
   */
  const pct = (arr, p) => {
    const a = [...arr].sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.max(0, Math.floor(a.length * p)))];
  };
  const grow = model.days.map((_, i) => i).filter((i) => {
    const m = Number(model.days[i].slice(4, 6));
    return m >= 4 && m <= 10;
  });
  const thresholds = {
    waterLow: Math.round(pct(rows.flatMap((r) => r.series.water), 0.15) * 100) / 100,
    waterHigh: Math.round(pct(rows.flatMap((r) => r.series.water), 0.85) * 100) / 100,
    tempHigh: Math.round(pct(grow.map((i) => model.region.T2M[i]), 0.98) * 10) / 10,
    tempLow: Math.round(pct(grow.map((i) => model.region.T2M[i]), 0.02) * 10) / 10,
    precipHigh: Math.round(pct(Array.from(model.region.PREC), 0.97) * 10) / 10,
    diseaseLevel: 3, // 这一条是**绝对**的：促病指数的分级本身就有农学含义（3 级=中等以上风险）
  };

  /** 区域量的"当前值"（气温圈要用） */
  const region = { temp: model.region.T2M[0] };

  /**
   * 行政区划码：**用真实的市镇码**（`data/admin.geojson` 里 OSM 的 `de:amtlicher_gemeindeschluessel`）。
   * 编码规则照国内口径「行政区划码 + 图层码 + 顺序号」，所以换到中国演示区只换前缀。
   */
  const townFeature = adminFC.features.find((f) => String(f.properties.admin_level) === '8') ?? adminFC.features[0];
  const ADMIN_CODE = townFeature?.properties.admin_code ?? '00000000';
  const codeOf = (layer, seq, width) => `${ADMIN_CODE}-${layer}-${String(seq).padStart(width, '0')}`;
  const parcelCode = (i) => codeOf('P', i + 1, 6);
  const unitCode = (unitId) => codeOf('U', String(unitId).replace(/\D/g, '') || '0', 4);

  // 地块质心（导出 CSV 要坐标；只算一次）
  const centroids = parcelsFC.features.map((f) => {
    const ring = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0];
    let x = 0;
    let y = 0;
    for (const [lon, lat] of ring) { x += lon; y += lat; }
    return [x / ring.length, y / ring.length];
  });
  const CROP_BY = Object.fromEntries(CROPS.map((c) => [c.key, c]));

  /**
   * 地图下方几张表的聚合。
   *
   * ⚠️ **与屏幕同源**：都读同一份 `rows` / `region` / `get`，UI 不再自己算一遍 ——
   * 两边各算一次是这类看板最常见也最伤信任的错（表说正常、告警说超标）。
   * 粒度按需求分：指标/单元到**日**，收成放宽到**季**。
   */
  function buildTables(day) {
    // —— P2 经营单元：面积加权均值 + 最严病级 + 最远可达时间（"最需要关注"的口径）——
    const acc = new Map();
    for (const r of rows) {
      if (!r.unit_id) continue;
      let a = acc.get(r.unit_id);
      if (!a) {
        a = { n: 0, area: 0, w: 0, f: 0, p: 0, pw: 0, disease: 1, tMin: null };
        acc.set(r.unit_id, a);
      }
      a.n++;
      a.area += r.area_ha;
      a.w += get(r, 'water', day) * r.area_ha;
      a.f += get(r, 'fert', day) * r.area_ha;
      if (r.gddNeed > 0) { a.p += get(r, 'progress', day) * r.area_ha; a.pw += r.area_ha; }
      a.disease = Math.max(a.disease, get(r, 'disease', day));
      if (r.t_min != null) a.tMin = a.tMin == null ? r.t_min : Math.max(a.tMin, r.t_min);
    }
    const unitProps = new Map(unitsFC.features.map((f) => [f.properties.unit_id, f.properties]));
    const unitRows = [...acc.entries()].map(([id, a]) => ({
      id,
      code: unitCode(id),
      crop: unitProps.get(id)?.dominant_crop ?? '',
      area: a.area,
      n: a.n,
      progress: a.pw ? a.p / a.pw : 0,
      disease: a.disease,
      water: a.area ? a.w / a.area : 0,
      fert: a.area ? a.f / a.area : 0,
      tMin: a.tMin,
    })).sort((x, y) => (y.disease - x.disease) || (x.progress - y.progress));

    // —— 作物与收成：按作物聚合（休耕单列，不然面积对不上账）——
    const cAcc = new Map();
    for (const r of rows) {
      const key = r.fallow ? 'FALLOW' : (r.crop ?? 'UNKNOWN');
      let c = cAcc.get(key);
      if (!c) {
        const cp = CROP_BY[r.crop];
        c = { name: r.fallow ? '休耕' : (r.cropName ?? '未分类'), n: 0, area: 0, yArea: 0, ySum: 0, t: 0,
          basis: cp?.basis ?? '', ref: cp?.yieldRef ?? 0 };
        cAcc.set(key, c);
      }
      c.n++;
      c.area += r.area_ha;
      const y = r.yield_t_ha ?? 0;
      if (y > 0 && !r.fallow) { c.ySum += y * r.area_ha; c.yArea += r.area_ha; c.t += r.yield_t ?? y * r.area_ha; }
    }
    const cropRows = [...cAcc.entries()].map(([code, c]) => ({
      code, name: c.name, n: c.n, area: c.area,
      yieldHa: c.yArea ? c.ySum / c.yArea : 0, yieldT: c.t, basis: c.basis, ref: c.ref,
    })).sort((x, y) => y.area - x.area);

    return { sig: `${day}|${unitRows.length}|${cropRows.length}`, units: unitRows, crops: cropRows };
  }

  const state = { day: 0, variable: 'progress', playing: false, daysPerSec: 4 };

  // ==================== 导出（CSV / PNG） ====================
  const csvCell = (v) => {
    const t = v == null ? '' : String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  /** 导出**当前帧**的地块表（编码与列名与 `tables/fact_parcel_*` 对齐，便于和离线表对账） */
  function exportCsv() {
    const day = state.day;
    const ymd = ymdAt(day);
    const head = ['date_key', 'parcel_id', 'parcel_code', 'unit_id', 'grid_id', 'crop_code', 'crop_name_zh',
      'area_ha', 'centroid_lon', 'centroid_lat', 'progress', 'disease_level', 'water_index', 'fertility_index',
      'tillage', 'sow_day', 'harvest_day', 'yield_t_ha', 't_min_to_store', 'access_m', 'synthetic'];
    const lines = [head.join(',')];
    rows.forEach((r, i) => {
      const [lon, lat] = centroids[i];
      lines.push([
        ymd, r.id, parcelCode(i), r.unit_id ?? '', r.grid_id ?? '', r.fallow ? 'FALLOW' : (r.crop ?? ''),
        r.cropName ?? '', r.area_ha.toFixed(3), lon.toFixed(6), lat.toFixed(6),
        get(r, 'progress', day).toFixed(4), get(r, 'disease', day), get(r, 'water', day).toFixed(4),
        get(r, 'fert', day).toFixed(4), tillageOf(r, day), r.sowDay ?? '', r.harvestDay ?? '',
        get(r, 'yield', day) ? get(r, 'yield', day).toFixed(2) : '', r.t_min?.toFixed(1) ?? '', r.access_m ?? '', 1,
      ].map(csvCell).join(','));
    });
    download(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' }), `农业监测_${ymd}.csv`);
    ui.toast(`已导出 ${rows.length} 个地块（${ymd}）`, 'ok');
  }

  /**
   * 导出地图 PNG：把 Leaflet 的 canvas 层逐个贴到一张新画布上，再画标题与图例。
   *
   * ⚠️ **不含 `divIcon` 标签**（气温数值那类 DOM 图标不在 canvas 里）—— 这是已知取舍：
   * 为了不引 `html2canvas`（会破坏"零依赖"），只做 canvas 合成；要连标签一起截，就得引依赖。
   * 换来的好处是导出的图自带标题/日期/图例，贴进汇报材料不用再解释。
   */
  function exportPng() {
    const el = $('map');
    const box = el.getBoundingClientRect();
    const c = document.createElement('canvas');
    c.width = Math.round(box.width);
    c.height = Math.round(box.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = cssVar('--map-bg', '#f1f5fa');
    ctx.fillRect(0, 0, c.width, c.height);
    let drawn = 0;
    for (const cv of el.querySelectorAll('canvas')) {
      const b = cv.getBoundingClientRect();
      if (!b.width || !b.height) continue;
      try {
        ctx.drawImage(cv, b.left - box.left, b.top - box.top, b.width, b.height);
        drawn++;
      } catch { /* 跨域画布之类：跳过，不让导出整个失败 */ }
    }
    const fg = cssVar('--fg', '#12263f');
    const panel = cssVar('--panel', '#ffffff');
    const line = cssVar('--line', '#d3e0ee');
    // 标题条
    ctx.fillStyle = panel;
    ctx.fillRect(0, 0, c.width, 26);
    ctx.strokeStyle = line;
    ctx.beginPath();
    ctx.moveTo(0, 26.5);
    ctx.lineTo(c.width, 26.5);
    ctx.stroke();
    ctx.fillStyle = fg;
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.fillText(`${SITE.name}`, 10, 18);
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(fmtDay(ymdAt(state.day)), c.width - 96, 18);
    // 图例框
    const items = legendItems(state.variable).slice(0, 6);
    const pad = 10;
    const lh = 16;
    const boxH = 30 + items.length * lh;
    const boxW = 196;
    const y0 = c.height - boxH - pad;
    ctx.fillStyle = panel;
    ctx.strokeStyle = line;
    ctx.beginPath();
    ctx.rect(pad, y0, boxW, boxH);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = fg;
    ctx.font = '600 12px system-ui, sans-serif';
    const spec = VARIABLES[state.variable];
    ctx.fillText(`${spec.label}${spec.unit ? `（${spec.unit}）` : ''}`, pad + 8, y0 + 18);
    items.forEach((it, i) => {
      const y = y0 + 32 + i * lh;
      ctx.fillStyle = it.color;
      ctx.fillRect(pad + 8, y, 14, 12);
      ctx.fillStyle = fg;
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText(String(it.label).slice(0, 16), pad + 28, y + 11);
    });
    c.toBlob((blob) => {
      if (blob) download(blob, `农业监测地图_${ymdAt(state.day)}_${state.variable}.png`);
    }, 'image/png');
    ui.toast(`已导出地图（${drawn} 个图层；不含 DOM 标签）`, 'ok');
  }

  const map = new AgriMap({
    el: $('map'),
    admin: adminFC,
    parcels: parcelsFC,
    roads: roadsFC,
    poi: poiFC,
    isochrones,
    units: unitsFC,
    grids: gridsFC,
    villages: villagesFC,
    zones: null, // 懒加载：见 onLayer('zones')

    rows,
    get,
    region,
    onSelect: (row) => ui.select(row),
  });

  function setDay(day) {
    state.day = Math.min(model.days.length - 1, Math.max(0, Math.round(day)));
    region.temp = model.region.T2M[state.day];
    map.setDay(state.day);
    ui.setDay(state.day);
    ui.setTables(buildTables(state.day));
  }

  const ui = new UI({
    model, rows, get, thresholds,
    actions: {
      onVariable: (key) => { state.variable = key; map.setVariable(key); ui.setVariable(key); },
      onDay: (d) => { state.playing = false; ui.setPlaying(false); setDay(d); },
      onTogglePlay: () => { state.playing = !state.playing; ui.setPlaying(state.playing); },
      onSpeed: (d) => { state.daysPerSec = d; ui.setSpeed(d); },
      onLayer: async (name, on) => {
        // 分区样点按需加载：12000+ 点约 2.3 MB，不该压在首屏
        if (name === 'zones' && on && !map.zoneLayer) {
          ui.toast('正在加载分区样点（约 2 MB）…');
          try {
            map.setZones(await loadJson('data/zones.geojson'));
          } catch (err) {
            ui.toast(`分区数据加载失败：${err.message}`, 'warn');
          }
        }
        map.setLayerVisible(name, on);
      },
      onFocusParcel: (i) => {
        const row = rows[i];
        if (!row) return;
        map.focusParcel(row);
        ui.select(row);
      },
      onExportCsv: () => exportCsv(),
      onExportPng: () => exportPng(),
      /**
       * **表格 → 地图**：点"经营单元"一行 ⇒ 把该单元的成员地块全高亮并框进视野。
       * 方向反过来（地图 → 表格）由选中地块驱动面板详情，两者共用同一份 `rows`，不会对不上号。
       */
      onHighlightUnit: (unitId) => {
        const idx = rows.filter((r) => r.unit_id === unitId).map((r) => r.i);
        const n = map.highlight(idx);
        ui.toast(`${unitId}：${n} 个地块已高亮（图上蓝框）${n ? '' : ' —— 该单元没有地块？'}`, n ? 'ok' : 'warn');
      },
      onHighlightCrop: (cropCode) => {
        const idx = rows.filter((r) => (r.fallow ? 'FALLOW' : (r.crop ?? 'UNKNOWN')) === cropCode).map((r) => r.i);
        const n = map.highlight(idx);
        ui.toast(`${cropCode}：${n} 个地块已高亮`, n ? 'ok' : 'warn');
      },
    },
  });

  ui.setVariable(state.variable);
  ui.setSpeed(state.daysPerSec);
  map.setTheme(); // 首屏把 canvas 图层的颜色与 CSS 变量对齐一次（canvas 读不到 CSS 变量）
  // 默认落在**生长季中**：第 0 天是 7 月 1 日，冬作物还没播、青贮玉米刚起步，
  // 整张图会是一片"进度 0"，第一眼看不出这是个监测看板。
  const firstDay = model.days.indexOf('20250615');
  setDay(firstDay >= 0 ? firstDay : Math.floor(model.days.length / 2));

  // 播放循环：只推进"当前日"，各视图自己从它派生
  let last = 0;
  function frame(ts) {
    if (state.playing && ts - last >= 1000 / state.daysPerSec) {
      last = ts;
      setDay(state.day >= model.days.length - 1 ? 0 : state.day + 1);
    } else if (!state.playing) {
      last = ts;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // 供工具脚本/调试使用（与旧版本的 __webTrade 同一定位）
  globalThis.__agri = { model, rows, get, map, ui, state, setDay, access, units: unitsJson,
    admin: adminFC, buildTables, exportCsv, exportPng, ADMIN_CODE, theme: THEME.key };
} catch (err) {
  fatal(err);
}
