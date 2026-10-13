/**
 * 装配与播放循环。
 *
 * 这一层只做三件事：**取数据 → 跑模型 → 把"当前日"同步给地图与面板**。
 * 「当前日」是整个界面的唯一时间源（地图着色、指标卡、告警、选中地块曲线都读它），
 * 所以时间轴一处推进，所有视图一起动 —— 这是这类监测界面最容易做错的地方
 * （各视图各存一份状态，播着播着就对不上了）。
 */
import { simulate, levelOf } from './agro.js';
import { AgriMap } from './map.js';
import { UI } from './ui.js';

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
  const [parcelsFC, roadsFC, poiFC, weatherFile, access, isochrones, unitsJson, unitsFC, gridsFC, zonesFC] = await Promise.all([
    loadJson('data/parcels.geojson'),
    loadJson('data/roads.geojson'),
    loadJson('data/poi.geojson'),
    loadJson('data/weather_daily.json'),
    loadJson('data/access.json'),
    loadJson('data/isochrones.geojson'),
    loadJson('data/units.json'),
    loadJson('data/units.geojson'),
    loadJson('data/grids.geojson'),
    loadJson('data/zones.geojson'),
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

  const state = { day: 0, variable: 'progress', playing: false, daysPerSec: 4 };

  const map = new AgriMap({
    el: $('map'),
    parcels: parcelsFC,
    roads: roadsFC,
    poi: poiFC,
    isochrones,
    units: unitsFC,
    grids: gridsFC,
    zones: zonesFC,
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
  }

  const ui = new UI({
    model, rows, get, thresholds,
    actions: {
      onVariable: (key) => { state.variable = key; map.setVariable(key); ui.setVariable(key); },
      onDay: (d) => { state.playing = false; ui.setPlaying(false); setDay(d); },
      onTogglePlay: () => { state.playing = !state.playing; ui.setPlaying(state.playing); },
      onSpeed: (d) => { state.daysPerSec = d; ui.setSpeed(d); },
      onLayer: (name, on) => map.setLayerVisible(name, on),
      onFocusParcel: (i) => {
        const row = rows[i];
        if (!row) return;
        map.focusParcel(row);
        ui.select(row);
      },
    },
  });

  ui.setVariable(state.variable);
  ui.setSpeed(state.daysPerSec);
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
  globalThis.__agri = { model, rows, get, map, ui, state, setDay, access, units: unitsJson, tables: null };
} catch (err) {
  fatal(err);
}
