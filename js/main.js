/**
 * 装配与播放循环。
 *
 * 这一层只做三件事：**取数据 → 跑模型 → 把"当前日"同步给地图与面板**。
 * 「当前日」是整个界面的唯一时间源（地图着色、指标卡、告警、选中地块曲线都读它），
 * 所以时间轴一处推进，所有视图一起动 —— 这是这类监测界面最容易做错的地方
 * （各视图各存一份状态，播着播着就对不上了）。
 */
import { simulate, levelOf, CROPS } from './agro.js';
import { dataRange } from './charts.js';   // 显示范围怎么算只写一处（charts.js）
import { PALETTE } from './theme.js';
import { AgriMap } from './map.js';
import { UI } from './ui.js';
import { cssVar, THEME } from './theme.js';
import { VARIABLES, legendItems, fmtDay, colorOf, scenarioColor, SCENARIO_BINS, aggSkip, aggClassMode } from './geo.js';

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

// 兜底提示的判据：模块真的执行了才有它（file:// 下模块会被拦，于是没有它 ⇒ 提示"请用静态服务器打开"）
globalThis.__agriBoot = true;

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
  /**
   * **联合查询的落地形态：带名字的业务问题**（简洁版）。
   *
   * 为什么不给"查询构造器"：政企看板的使用者要的是**答案**不是**分析台**；
   * 自由拖拽"行/列/值"对业务人员是门槛，还要占掉宝贵的竖向空间（见 README 的空间预算实测）。
   * 所以每个问题 = 一句可核对的口径 + 命中数/面积 + 最严重的几块，**点一行就在图上高亮**。
   * 这些问题真正"联"了多张表：地块（P1）× 可达性（路网 Dijkstra）× 土壤（SoilGrids）× 居民点（OSM）。
   */
  const CROP_NAME = (key) => (CROPS.find((c) => c.key === key)?.name ?? key);
  /** 收获峰值日只算一次并缓存（27.5 万次循环不该每帧跑） */
  let harvestPeak = null;

  function buildQuestions(day) {
    const pct = (arr, q) => {
      const a = arr.filter((v) => v != null).sort((x, y) => x - y);
      return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * q))] : 0;
    };
    const accP90 = pct(rows.map((r) => r.t_min), 0.9);
    const socP25 = pct(rows.map((r) => r.soil?.soc_g_kg), 0.25);
    const ha = (list) => list.reduce((a, r) => a + r.area_ha, 0);
    const out = [];

    // ① 运输盲区 ∩ 土壤贫瘠（可达性 × 土壤）—— 最典型的"两张外部数据集联起来才有意义"的问题
    {
      const hit = rows.filter((r) => r.t_min != null && r.t_min > accP90 && (r.soil?.soc_g_kg ?? 1e9) < socP25);
      const worst = [...hit].sort((a, b) => (b.t_min ?? 0) - (a.t_min ?? 0)).slice(0, 2);
      out.push({
        key: 'blind-poor', title: '运输盲区 ∩ 土壤贫瘠', level: 'mid',
        hits: hit.map((r) => r.i), ha: ha(hit),
        top: worst.length ? worst.map((r) => `${parcelCode(r.i)}（${r.t_min.toFixed(1)} 分 · 有机碳 ${r.soil.soc_g_kg.toFixed(1)}）`).join('、') : '没有同时满足的地块',
        desc: `到收储点 > ${accP90.toFixed(1)} 分（p90）且 有机碳 < ${socP25.toFixed(1)} g/kg（p25）`,
      });
    }
    // ② 进度落后 ∩ 病害风险（同单元内比较，避免"跨单元比进度"这种没意义的比较）
    {
      const byUnit = new Map();
      for (const r of rows) {
        if (!r.unit_id || !(r.gddNeed > 0)) continue;
        if (!byUnit.has(r.unit_id)) byUnit.set(r.unit_id, []);
        byUnit.get(r.unit_id).push(r);
      }
      const hit = [];
      for (const list of byUnit.values()) {
        const sorted = list.map((r) => get(r, 'progress', day)).sort((a, b) => a - b);
        const p25 = sorted[Math.floor(sorted.length * 0.25)] ?? 0;
        for (const r of list) if (get(r, 'progress', day) < p25 && get(r, 'disease', day) >= 3) hit.push(r);
      }
      out.push({
        key: 'lag-disease', title: '进度落后 ∩ 病害风险',
        hits: hit.map((r) => r.i), ha: ha(hit),
        top: hit.length ? hit.slice(0, 2).map((r) => `${parcelCode(r.i)}（${r.cropName} ${Math.round(get(r, 'progress', day) * 100)}% · ${get(r, 'disease', day)} 级）`).join('、') : '当日没有',
        desc: '进度 < 本经营单元 p25 且 病害气象等级 ≥ 3',
      });
    }
    // ③ 盲区最重的"村"（就近归属到真实居民点 —— 点位真实，不是村界）
    {
      const blind = rows.filter((r) => r.t_min != null && r.t_min > accP90);
      const byV = new Map();
      for (const r of blind) {
        const v = nearestVillage(r.i);
        if (v) byV.set(v, (byV.get(v) ?? 0) + r.area_ha);
      }
      const sorted = [...byV.entries()].sort((a, b) => b[1] - a[1]);
      const top = sorted[0]?.[0] ?? null;
      out.push({
        key: 'village-blind', title: '盲区最重的村（就近归属）',
        hits: top ? blind.filter((r) => nearestVillage(r.i) === top).map((r) => r.i) : [],
        ha: sorted[0]?.[1] ?? 0,
        top: sorted.length ? `${top}：${sorted[0][1].toFixed(1)} ha`
          + (sorted[1] ? `（第 2 名 ${sorted[1][0]} ${sorted[1][1].toFixed(1)} ha）` : '') : '没有盲区',
        desc: `到收储点 > ${accP90.toFixed(1)} 分的地块，按最近居民点归堆`,
      });
    }
    // ⑤ 同作物跨单元的进度离散（讲"该不该统一调度"：同一个作物，不同地块差出几十个百分点）
    {
      const byCrop = new Map();
      for (const r of rows) {
        if (!(r.gddNeed > 0) || !r.crop) continue;
        if (!byCrop.has(r.crop)) byCrop.set(r.crop, []);
        byCrop.get(r.crop).push(get(r, 'progress', day));
      }
      let worst = null;
      for (const [crop, arr] of byCrop) {
        if (arr.length < 20) continue; // 样本太少的作物不参与（不然一个 3 块地的小作物就会"夺冠"）
        const a = [...arr].sort((x, y) => x - y);
        const p10 = a[Math.floor(a.length * 0.1)];
        const p90 = a[Math.floor(a.length * 0.9)];
        if (!worst || p90 - p10 > worst.span) worst = { crop, span: p90 - p10, p10, p90, n: arr.length };
      }
      const hit = worst ? rows.filter((r) => r.crop === worst.crop && get(r, 'progress', day) <= worst.p10) : [];
      out.push({
        key: 'crop-spread', title: '同作物跨单元进度离散',
        hits: hit.map((r) => r.i), ha: ha(hit),
        top: worst ? `${CROP_NAME(worst.crop)}：p10~p90 差 ${Math.round(worst.span * 100)} 个百分点（${worst.n} 块）` : '—',
        desc: '取同一作物在各地块间 p90−p10 最大者；命中 = 该作物进度 ≤ p10 的地块',
      });
    }
    // ⑥ 收获峰值日（农机压力）：命中=**当前日期**要收获的地块；摘要给全窗口最忙的一天
    {
      const ymd = ymdAt(day);
      const today = rows.filter((r) => (r.harvestDays ?? []).includes(ymd));
      if (!harvestPeak) {
        // 全窗口逐日统计收获面积（549 × 501 ≈ 27.5 万次，算一次后缓存）
        const byDay = new Map();
        for (const r of rows) for (const d of r.harvestDays ?? []) byDay.set(d, (byDay.get(d) ?? 0) + r.area_ha);
        const best = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0];
        harvestPeak = best ? { day: best[0], ha: best[1] } : null;
      }
      out.push({
        key: 'harvest-peak', title: '收获峰值（农机压力）',
        hits: today.map((r) => r.i), ha: ha(today),
        // 命中数为 0 时把"最忙的一天"写进摘要 —— 否则一行 0 命中看着像功能坏了
        top: today.length
          ? (harvestPeak ? `当日 ${fmtDay(ymd)} 要收 ${today.length} 块；全窗口最忙 ${fmtDay(harvestPeak.day)}：${harvestPeak.ha.toFixed(1)} ha` : '—')
          : (harvestPeak ? `当日（${fmtDay(ymd)}）无收获；全窗口最忙 ${fmtDay(harvestPeak.day)}：${harvestPeak.ha.toFixed(1)} ha` : '—'),
        desc: `命中 = 当前日期（${fmtDay(ymd)}）需要收获的地块；摘要给全窗口最忙的一天`,
      });
    }
    // ④ 最远的 10 块地（基线对照：不做归属，直接看最不利的）
    {
      const far = rows.filter((r) => r.t_min != null).sort((a, b) => b.t_min - a.t_min).slice(0, 10);
      out.push({
        key: 'far-10', title: '到收储点最远的 10 块地', hits: far.map((r) => r.i), ha: ha(far),
        top: far.length ? `${parcelCode(far[0].i)}：${far[0].t_min.toFixed(1)} 分` : '—',
        desc: '按到最近收储点的行驶时间降序取前 10',
      });
    }
    return out;
  }

  /** 地块 → 最近的居民点名字（501 × 55 次距离计算；只算一次并缓存） */
  let villageAssign = null;
  function nearestVillage(i) {
    if (i == null || !villagesFC?.features?.length) return null;
    if (!villageAssign) {
      villageAssign = rows.map((r) => {
        const [lon, lat] = centroids[r.i];
        let best = null;
        let bd = Infinity;
        for (const f of villagesFC.features) {
          const [vlon, vlat] = f.geometry.coordinates;
          const d = (vlat - lat) ** 2 + ((vlon - lon) * Math.cos((lat * Math.PI) / 180)) ** 2;
          if (d < bd) { bd = d; best = f.properties.name; }
        }
        return best;
      });
    }
    return villageAssign[i];
  }

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
      // 进度只对**播种作物**有意义（牧草/果园 gddNeed=0 不参与）—— 口径与地图共用 AGG_RULE
      if (!aggSkip('progress', r)) { a.p += get(r, 'progress', day) * r.area_ha; a.pw += r.area_ha; }
      // 病害同样按 AGG_RULE：`max` = 取最严重（与"最高病级"列、告警口径一致）
      if (aggClassMode('disease') === 'max') a.disease = Math.max(a.disease, get(r, 'disease', day));
      if (r.t_min != null) a.tMin = a.tMin == null ? r.t_min : Math.max(a.tMin, r.t_min);
    }
    const unitProps = new Map(unitsFC.features.map((f) => [f.properties.unit_id, f.properties]));
    const unitRows = [...acc.entries()].map(([id, a]) => ({
      id,
      code: unitCode(id),
      crop: unitProps.get(id)?.dominant_crop ?? '',
      area: a.area,
      n: a.n,
      // 全是牧草/果园（pw=0）⇒ 进度**无数据**（null ⇒ 表格显示"—"，地图画"无数据灰"）
      // 写 0 会被读成"一点没长"，那是另一个意思
      progress: a.pw ? a.p / a.pw : null,
      disease: a.disease,
      water: a.area ? a.w / a.area : 0,
      fert: a.area ? a.f / a.area : 0,
      tMin: a.tMin,
    })).sort((x, y) => (y.disease - x.disease) || ((x.progress ?? 1) - (y.progress ?? 1)));

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

    // —— P4 统计网格：**换空间键、不换口径**（同一个 AGG_RULE，只是按 grid_id 分组）——
    const gAcc = new Map();
    for (const r of rows) {
      if (!r.grid_id) continue;
      let a = gAcc.get(r.grid_id);
      if (!a) {
        a = { n: 0, area: 0, w: 0, f: 0, p: 0, pw: 0, disease: 1, tMin: null, crops: new Map() };
        gAcc.set(r.grid_id, a);
      }
      a.n++;
      a.area += r.area_ha;
      a.w += get(r, 'water', day) * r.area_ha;
      a.f += get(r, 'fert', day) * r.area_ha;
      if (!aggSkip('progress', r)) { a.p += get(r, 'progress', day) * r.area_ha; a.pw += r.area_ha; }
      if (aggClassMode('disease') === 'max') a.disease = Math.max(a.disease, get(r, 'disease', day));
      if (r.t_min != null) a.tMin = a.tMin == null ? r.t_min : Math.max(a.tMin, r.t_min);
      const ck = r.fallow ? 'FALLOW' : (r.crop ?? null);
      if (ck) a.crops.set(ck, (a.crops.get(ck) ?? 0) + r.area_ha);
    }
    const gridRows = [...gAcc.entries()].map(([id, a]) => {
      let bc = null;
      let bw = -1;
      for (const [k, w] of a.crops) if (w > bw) { bw = w; bc = k; }
      return {
        id, code: id, crop: bc ? CROP_NAME(bc) : '', n: a.n, area: a.area,
        progress: a.pw ? a.p / a.pw : null, disease: a.disease,
        water: a.area ? a.w / a.area : 0, fert: a.area ? a.f / a.area : 0, tMin: a.tMin,
      };
    }).sort((x, y) => (y.area - x.area) || (x.code < y.code ? -1 : 1));

    return {
      sig: `${day}|${unitRows.length}|${gridRows.length}|${cropRows.length}`,
      units: unitRows, grids: gridRows, crops: cropRows,
      questions: buildQuestions(day),
    };
  }

  const state = { day: 0, variable: 'progress', playing: false, daysPerSec: 4, scenarioViewOnly: false };
  /*
   * 情景候选数据（194 KB）**懒加载**：它只在「情景推演」页签用得到，却原来在启动清单里，
   * 占启动请求量的 13%。这里用**可变更的对象**接住（加载后原地填），
   * 这样页面各处、以及调试用的 `__agri.scenario.candidates` 仍然照常可用，加载前是空数组。
   */
  const scenarioFile = { metadata: {}, candidates: [] };
  let scenarioPromise = null;
  const ensureScenario = () => (scenarioPromise ??= loadJson('data/scenario.json').then((d) => {
    scenarioFile.metadata = d.metadata ?? {};
    scenarioFile.candidates = d.candidates ?? [];
    return scenarioFile;
  }));

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

  // 地图点选：只在「情景推演」页签激活时接管点击（否则点地块应该是"选中地块"）
  /*
   * 地图平移/缩放后：按钮上的"视野内 N 个"要跟着更新；开着筛选时表也要跟着视野走。
   * 加 250ms 防抖 —— 拖地图会连续触发 moveend，每帧重排 154 行表会卡。
   */
  let moveTimer = 0;
  map.map.on('moveend zoomend', () => {
    // 按钮数量 + 抽屉里散点图的"视野外画淡"都要跟上（只更新按钮会留下旧视野的图）
    ui.onScenarioViewportChanged();
    if (!state.scenarioViewOnly) return;
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => { ui.renderTables(); ui.onScenarioViewportChanged(); }, 250);
  });
  map.map.on('click', (e) => {
    if (ui.activeTable === 'scenario') pickScenario(e.latlng);
  });

  /**
   * **情景推演**：在地图上点一下 ⇒ 取最近的候选点 ⇒ 给出"新建前/后"的可达性对比。
   *
   * 重活（每个候选点一次单源 Dijkstra）已经在 `tools/scenario.mjs` 离线算完，
   * 这里只是**查表 + 高亮受影响地块** —— 所以点下去是瞬时的，页面也不背 Dijkstra 的实现。
   */
  /**
   * 表格 → 图 的高亮入口（**切换式**）：
   * - 点同一组第二次 ⇒ **取消高亮**（"无法取消"这件事不能存在）；
   * - 点另一组 ⇒ 先取消上一组（`map.highlight` 内部已先 clear），只保留新的一组；
   * - 状态写在表格右上角（`ui.setHighlightInfo`），并有「取消高亮」按钮兜底。
   */
  let hlKey = null;
  function highlightGroup(key, indices, label) {
    if (hlKey === key) {
      map.clearHighlight();
      hlKey = null;
      ui.setHighlightInfo(null);
      ui.toast('已取消高亮');
      return 0;
    }
    const n = map.highlight(indices);
    hlKey = n ? key : null;
    ui.setHighlightInfo(n ? `${label}（${n} 块）` : null);
    if (!n) ui.toast('这一组没有地块可高亮', 'warn');
    return n;
  }

  /**
   * **前后对照**（按经营单元，面积加权）：现状 vs 新建后。
   *
   * 数据全部来自本页已有的 `rows` 与候选点的 `improved`（地块索引 → 省多少分钟），不再取别的文件。
   * 只留"确实有改善"且改善最多的前 12 个单元：全画 62 个单元没人看得完，
   * 而这张图要回答的是"**省在哪里**" —— 没改善的单元画出来只是噪音。
   */
  function buildScenarioCompare(cand) {
    const gains = new Map(cand.improved ?? []);
    const acc = new Map();
    for (const r of rows) {
      if (!r.unit_id || r.t_min == null) continue;
      let a = acc.get(r.unit_id);
      if (!a) { a = { before: 0, after: 0, w: 0, n: 0 }; acc.set(r.unit_id, a); }
      const w = r.area_ha || 0;
      const g = gains.get(r.i) ?? 0;
      a.before += r.t_min * w;
      // 新建后 = min(现状, 到新点)，所以 after 只会更小 —— 这条不等式是**逐块**成立的
      a.after += Math.max(0, r.t_min - g) * w;
      a.w += w;
      a.n++;
    }
    return [...acc.entries()].map(([id, a]) => ({
      id, label: unitCode(id), n: a.n,
      before: a.w ? a.before / a.w : 0, after: a.w ? a.after / a.w : 0,
      gain: a.w ? (a.before - a.after) / a.w : 0,
    })).filter((x) => x.gain > 0.001).sort((x, y) => y.gain - x.gain).slice(0, 12);
  }

  async function pickScenario(latlng) {
    if (!scenarioFile.candidates.length) await ensureScenario().catch(() => {});
    let best = null;
    let bd = Infinity;
    for (const c of scenarioFile.candidates) {
      const d = (c.lat - latlng.lat) ** 2 + (c.lon - latlng.lng) ** 2;
      if (d < bd) { bd = d; best = c; }
    }
    if (!best) return;
    state.scenarioPick = best;                       // 也留在数据侧：散点图要用它标"当前选的是谁"
    ui.setScenario({ base: scenarioFile.metadata.baseline, cand: best, meta: scenarioFile.metadata });
    // **同屏对比**：把"每个地块省多少分钟"接到地图上，并自动打开情景着图层
    // （原来只有右侧表格的聚合对比，看不出"省在哪里"）
    map.setScenarioGains(best);
    // 图例也要跟着换：否则用户看到一图绿色块，图例却还是"生长进度 %"，等于没法读图
    ui.setScenarioLegend(SCENARIO_BINS);
    // 前后对照（按单元）：图在「情景推演」抽屉里，跟着选中的点变
    ui.setScenarioCompare(buildScenarioCompare(best));
    if (!map.visible.scenariofill) {
      map.setLayerVisible('scenariofill', true);
      ui.syncLayer('scenariofill', true);
    }
    const n = map.highlight(best.improved.map(([i]) => i));
    hlKey = n ? `scenario:${best.lon},${best.lat}` : null;
    ui.setHighlightInfo(n ? `拟建点受影响地块（${n} 块）` : null);
    ui.toast(`拟建点：平均可省 ${best.avg_gain_min} 分钟/块，高亮 ${n} 个受影响地块`, 'ok');
  }

  /** 最近一次算出的表数据（问题高亮要从里面取命中列表） */
  let lastTables = null;

  /**
   * **「图表」页签的四组数据**（折线 / 饼 / 柱 / 雷达）。
   *
   * 与表格同一条纪律：**聚合在 main.js 做，UI 只负责画**。
   * 两边各算一遍是这类界面最常见的对不上账（表里一个数、图里另一个数）。
   *
   * 雷达图特别注意：五个维度的量纲不同（进度/水分/养分是 0~1，病级是 1~5 级，可达性是分钟），
   * 所以**统一归一化到"越大越好"的 0~1**，病级与可达性做了反向（标签带 ↓）。
   */
  function buildChartData() {
    const reg = model.region;
    const T = lastTables ?? {};
    /*
     * ① 折线：区域逐日太长（549 天），抽成 ~80 点再画。
     * ⚠️ 步长必须与**地块抽样序列**一致（`meta.stepDays`，默认 7 天），
     * 否则"区域曲线"和"单元曲线"两条线的 x 格点对不上，摆在一起就是错位的。
     */
    const step = model.meta.stepDays || Math.max(1, Math.round(model.days.length / 110));
    const sample = (arr) => { const out = []; for (let i = 0; i < arr.length; i += step) out.push(Number(arr[i]) || 0); return out; };
    const xLabels = [];
    for (let i = 0; i < reg.progress.length; i += step) xLabels.push(fmtDay(model.days[i]));
    const mark = Math.min(xLabels.length - 1, Math.round(state.day / step));
    const METRICS = [
      { key: 'progress', label: '生长进度', color: PALETTE.orange, region: sample(reg.progress) },
      { key: 'disease', label: '促病指数', color: PALETTE.vermillion, region: sample(reg.disease) },
      { key: 'water', label: '水分保持', color: PALETTE.blue, region: sample(reg.waterIdx) },
      { key: 'fert', label: '养分保持', color: PALETTE.green, region: sample(reg.fertIdx) },
    ];
    /**
     * 某个经营单元的抽样曲线 = 成员地块的**面积加权**均值（同一采样格点）。
     * 与表格/地图同一条聚合口径（`AGG_RULE` 不适用：抽样序列本身就是逐地块比值）。
     */
    const unitSeries = (unitId) => {
      const mem = rows.filter((r) => r.unit_id === unitId);
      if (!mem.length) return null;
      const n = Math.min(...mem.map((r) => r.series.progress.length));
      const wsum = mem.reduce((a, r) => a + (r.area_ha || 0), 0) || 1;
      const avg = (key) => {
        const out = [];
        for (let i = 0; i < n; i++) {
          let s = 0;
          let w = 0;
          for (const r of mem) {
            const v = r.series[key][i];
            if (v == null || Number.isNaN(Number(v))) continue;
            s += Number(v) * (r.area_ha || 0);
            w += r.area_ha || 0;
          }
          out.push(w ? s / w : 0);
        }
        return out;
      };
      return { n, progress: avg('progress'), disease: avg('disease'), water: avg('water'), fert: avg('fert') };
    };
    const unitsForPick = T.units ?? [];
    const selUnit = ui.selected?.unit_id ? unitsForPick.find((u) => u.id === ui.selected.unit_id) : null;
    const focusUnit = selUnit ?? [...unitsForPick].sort((a, b) => (b.disease ?? 0) - (a.disease ?? 0))[0] ?? null;
    const uSeries = focusUnit ? unitSeries(focusUnit.id) : null;
    const lineObjects = [
      { key: 'region', label: '区域均值', series: METRICS.map((m) => ({ label: m.label, color: m.color, values: m.region })) },
    ];
    if (focusUnit && uSeries) {
      lineObjects.push({
        key: 'unit',
        id: focusUnit.id,
        label: `${focusUnit.code.split('-').slice(1).join('') || focusUnit.code}${selUnit ? '（当前选中）' : '（病级最高）'}`,
        series: METRICS.map((m) => ({ label: m.label, color: m.color, values: uSeries[m.key] })),
      });
    }
    const lineSeries = lineObjects[0].series;
    // 纵轴**按数据范围铺满**：4 条曲线都在 0.2~1.0 之间，0 起时它们会被压成四条平线
    const lineRange = dataRange(lineSeries.flatMap((s) => s.values));
    // ⚠️ 图注与事实必须一致：`lo` 真的 > 0 才叫"非零基"。
    // 四条序列一起看时（促病指数跨 0~1）范围本来就收到 0，硬写"非零基"就是撒谎 —— 踩过。
    const lineZeroBase = lineRange.lo <= 0;
    // ② 饼：作物面积构成（颜色用与地图同一份作物色，避免"图上绿、图里蓝"）
    const CROP_COLOR = Object.fromEntries((VARIABLES.crop.classes ?? []).map(([k, , c]) => [k, c]));
    /*
     * 饼图：**按成熟做法把"小项"合并成「其他」**（ClicData/Chartio 的默认行为）。
     * 依据：块数一多，小扇形就细到看不见，还互相挤 —— 与其画 7 块看不清，不如"前 5 块 + 其他"。
     * ⚠️ 合并只改**显示分组**，不改数值：图注里给出"其他"的百分比，且分组后合计必须等于原来的合计（有判据）。
     */
    const pieRaw = (T.crops ?? []).map((c) => ({ label: c.name, value: c.area, color: CROP_COLOR[c.code] ?? '#8a94a0' }))
      .sort((x, y) => y.value - x.value);
    const PIE_MAX = 6;
    const pie = pieRaw.length > PIE_MAX
      ? [...pieRaw.slice(0, PIE_MAX - 1), {
        label: `其他（${pieRaw.length - PIE_MAX + 1} 类）`,
        value: pieRaw.slice(PIE_MAX - 1).reduce((a, x) => a + x.value, 0),
        color: PALETTE.grey,
      }]
      : pieRaw;
    const pieSum = pie.reduce((a, x) => a + x.value, 0);
    const pieRest = pieRaw.slice(PIE_MAX - 1).reduce((a, x) => a + x.value, 0);
    // ③ 柱：经营单元按面积前 12
    /*
     * 标签用**短码**：完整码是 `09186162-U-0001`，画到 x 轴上会被截成 `09186162-U`
     * ⇒ 12 根柱子的标签长得一模一样（这一版真踩过）。
     *
     * ⚠️ 指标要选"**真有差距**"的那个：上一版画的是**面积**，而面积前 12 名的单元是 29.5~30.6 ha
     * ——柱子一样高，图等于白画（"0 基不截轴"保证了诚实，但诚实不等于有用）。
     * 改画**到收储点最远的 12 个单元**（5~12 分钟，差距肉眼可见，而且它本身就是"该管的单元"）。
     */
    const column = [...(T.units ?? [])].filter((u) => u.tMin != null)
      .sort((a, b) => b.tMin - a.tMin).slice(0, 12)
      .map((u) => ({ label: u.code.split('-').slice(1).join('') || u.code, value: u.tMin }));
    // ④ 雷达：**当前选中的地块所属单元**（没有选中就取病级最高的单元）vs 全场均值
    const ts = (T.units ?? []).map((u) => u.tMin).filter((v) => v != null).sort((a, b) => a - b);
    const p90 = ts.length ? ts[Math.min(ts.length - 1, Math.floor(ts.length * 0.9))] : 1;
    const dims = [{ label: '进度' }, { label: '水分' }, { label: '养分' }, { label: '病级', invert: true }, { label: '可达性', invert: true }];
    const good = (u) => [
      Number.isFinite(u.progress) ? u.progress : 0,
      Number(u.water) || 0,
      Number(u.fert) || 0,
      (5 - (Number(u.disease) || 1)) / 4,
      1 - Math.min(1, (u.tMin ?? p90) / (p90 || 1)),
    ];
    const units = T.units ?? [];
    const sel = ui.selected?.unit_id ? units.find((u) => u.id === ui.selected.unit_id) : null;
    const pick = sel ?? [...units].sort((a, b) => (b.disease ?? 0) - (a.disease ?? 0))[0] ?? null;
    const wsum = units.reduce((a, u) => a + (u.area || 0), 0) || 1;
    const allVec = dims.map((_, k) => units.reduce((a, u) => a + good(u)[k] * (u.area || 0), 0) / wsum);
    /*
     * **每一维按全场的 min~max 归一**：0 = 全场最差、1 = 全场最好。
     * 原来各维都按 0~1 归一，62 个单元画出来都是"中间一团"（差异全被量纲摊平了）；
     * 换成"在场内位置"之后，画像的形状才真的在描述这个单元。
     */
    const raw = units.map(good);
    const dimLo = dims.map((_, k) => Math.min(...raw.map((r) => r[k])));
    const dimHi = dims.map((_, k) => Math.max(...raw.map((r) => r[k])));
    /*
     * ⚠️ **全场差距太小的维度不许归一**：本数据里"养分保持"全场只差 0.04，
     * 按 min~max 归一等于把这 0.04 放大成整个轴 —— 图上会画出一个"巨大差异"，而它其实是噪声。
     * 阈值 `DIM_MIN` 与图注里"几维无区分度"的统计**共用同一个数**（两处各写一个必然对不上）。
     */
    const DIM_MIN = 0.05;
    const dimSpan = dims.map((_, k) => dimHi[k] - dimLo[k]);
    const dimUsable = dimSpan.map((x) => x >= DIM_MIN);
    const norm = (r) => r.map((v, k) => (dimUsable[k]
      ? Math.min(1, Math.max(0, (v - dimLo[k]) / dimSpan[k]))
      : 0.5));
    return {
      line: { unit: '', series: lineSeries, objects: lineObjects, xLabels, mark, yMin: lineRange.lo, yMax: lineRange.hi },
      pie: { unit: 'ha', items: pie },
      column: { unit: 'ha', items: column },
      radar: {
        dims,
        /* 对比对象可选：全场均值 / 病级最高 / 病级最低 / 面积最大（都按同一套归一，才可比） */
        compare: [
          { key: 'avg', label: '全场均值（面积加权）', values: norm(allVec) },
          ...[['worst', '病级最高', (a, b) => (b.disease ?? 0) - (a.disease ?? 0)],
            ['best', '病级最低', (a, b) => (a.disease ?? 0) - (b.disease ?? 0)],
            ['biggest', '面积最大', (a, b) => (b.area ?? 0) - (a.area ?? 0)]]
            .map(([key, label, cmp]) => {
              const u = [...units].sort(cmp)[0];
              return u ? { key, label: `${label} ${u.code.split('-').slice(1).join('') || u.code}`, values: norm(good(u)) } : null;
            }).filter(Boolean),
        ],
        series: pick ? [
          { label: `${pick.code}${sel ? '（当前选中）' : '（病级最高）'}`, color: PALETTE.blue, fill: 'rgba(0,114,178,0.20)', values: norm(good(pick)) },
          { label: '全场均值（面积加权）', color: PALETTE.orange, fill: 'rgba(230,159,0,0.16)', values: norm(allVec) },
        ] : [],
      },
      /*
       * **标题与数据在同一个地方声明**。
       *
       * 起因：标题原来写在 `ui.js` 的卡片模板里，与这边"画的是什么"是两份文本 ⇒ 我改 ③ 时
       * 把标题写成「经营单元**面积**偏高的 12 个」，而它画的其实是**到收储点最远**的 12 个
       * —— 卡片自己跟自己打架（下面的注释还写着"面积前 12 名都一样高，图等于白画"）。
       * 现在标题就在数据旁边：换了指标，标题就在同一段代码里，想漏改都难。
       */
      titles: {
        line: '① 时序（折线图）',
        pie: '② 作物面积构成（饼图）',
        col: '③ 到收储点最远的 12 个单元（柱状图）',
        radar: '④ 单元画像 vs 对比对象（雷达图）',
      },
      notes: {
        line: `逐日曲线（每 ${step} 天取一点，共 ${xLabels.length} 点）· 竖线 = 当前日期 ${fmtDay(ymdAt(state.day))}`
          + ` · 左上「对象」可切到${lineObjects[1] ? ` **${lineObjects[1].label}**（成员地块面积加权）` : '经营单元（先在图上点一块地）'}`
          + ` · 纵轴 ${lineRange.lo.toFixed(2)}~${lineRange.hi.toFixed(2)}`
          + (lineZeroBase
            ? '（0 基：四条序列合看时的实际范围）· **点上面的序列名可以只留一条**，纵轴会自动收到它的范围，差异更清楚'
              + ' · 配色用 Okabe-Ito（色盲安全）'
            : '（**非零基**：为了看清差异；图角也标了）'),
        pie: `地块面积按作物构成，从大到小排（休耕单列 —— 不单列就与总面积对不上账）`
          + ` · 前 ${PIE_MAX - 1} 类单列，其余合并为「其他」（占 ${((pieRest / (pieSum || 1)) * 100).toFixed(1)}%）`
          + ` · 合计 ${pieSum.toFixed(1)} ha（合并只改显示分组，不改数值）`
          + ' · 颜色与地图同一份作物色（**别只靠颜色读**，标签与百分比才是主读法）',
        column: '到收储点最远的 12 个经营单元（分钟）· 选它是因为**真的有差距**'
          + '（面积前 12 名都在 29.5~30.6 ha，柱状图看不出东西）· **柱从 0 起（不截轴）**，'
          + '差异靠柱顶数值看清 · x 轴用短码 U0001（完整码是「行政区划码-U-序号」）',
        radar: `左边是单元画像，右边下拉可换**对比对象**（全场均值 / 病级最高·最低 / 面积最大，都在同一套归一里）；`
          + `5 维（维度再多就该换图）；有区分度的维度按**全场 min~max 归一**（0 = 全场最差，1 = 全场最好）`
          + `⇒ 形状即"在场内位置"（可达性那一维按全场 **p90 封顶**，免得一个极端地块把其他单元都压在底部）；`
          + `**只看形状与各维位置，不要拿多边形面积当综合得分**（轴顺序一变面积就变，这类"面积打分"被专门质疑过）；`
          + '病级与可达性已反向（标签带 ↓）；'
          + `（${dimUsable.filter(Boolean).length} 维有区分度；另 ${dimUsable.filter((x) => !x).length} 维全场差距 < ${DIM_MIN}，**按无区分度处理**，
          + '归一后一律画在中间 —— 不把噪声放大成"差异"）`,
      },
    };
  }

  function setDay(day) {
    state.day = Math.min(model.days.length - 1, Math.max(0, Math.round(day)));
    region.temp = model.region.T2M[state.day];
    map.setDay(state.day);
    ui.setDay(state.day);
    lastTables = buildTables(state.day);
    ui.setTables(lastTables);
  }

  /*
   * 透视视图（静态）：第一次切到「透视视图」页签时才取 `data/pivot.json`。
   * 矩阵是**离线**由 `npm run query --web` 算好的，页面只画表 —— 这样页面保持纯静态、首屏也不多背一份 JSON。
   */
  let pivotData = null;
  let pivotLoading = false;
  const ensurePivot = () => {
    if (pivotData || pivotLoading) return;
    pivotLoading = true;
    loadJson('data/pivot.json')
      .then((d) => { pivotData = d; ui.setPivot(d); })
      .catch((err) => {
        ui.pivotLoadFailed = true;
        ui.toast(`透视数据加载失败：${err.message}（先跑 npm run query）`, 'warn');
        ui.setPivot(null);
      })
      .finally(() => { pivotLoading = false; });
  };

  const ui = new UI({
    model, rows, get, thresholds,
    actions: {
      onVariable: (key) => { state.variable = key; map.setVariable(key); ui.setVariable(key); },
      onDay: (d) => { state.playing = false; ui.setPlaying(false); setDay(d); },
      onTogglePlay: () => { state.playing = !state.playing; ui.setPlaying(state.playing); },
      /** 暂停（打开数据视图时调用：数字自己在跳的表格没法读） */
      onPause: () => { state.playing = false; ui.setPlaying(false); },
      onSpeed: (d) => { state.daysPerSec = d; ui.setSpeed(d); },
      onLayer: async (name, on) => {
        if (name === 'scenariofill') ui.setScenarioLegend(on ? SCENARIO_BINS : null);
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
      onNeedPivot: () => ensurePivot(),
      // 图层勾选框的初始状态要跟地图一致（maps 的默认值不全是开）
      onLayerState: (name) => !!map.visible[name],
      // 关掉情景着色 ⇒ 图例回到当前指标的图例
      onScenarioLegend: (on) => ui.setScenarioLegend(on ? SCENARIO_BINS : null),
      // 页面里所有导出的下载都走这一处（透视视图导出复用同一套：纯前端 Blob，无后端）
      onDownload: (text, name, mime = 'text/csv;charset=utf-8') => download(new Blob([text], { type: mime }), name),
      /** 图表面板导出 PNG（ui 侧把四张 canvas 拼成一张图，这里只负责落盘） */
      onDownloadPng: async (dataUrl, name) => {
        const blob = await (await fetch(dataUrl)).blob();
        download(blob, name);
      },
      onExportCsv: () => exportCsv(),
      /**
       * 导出**数据视图当前看到的表**（筛选 + 排序后的行）。
       * 口径写进文件名与提示里：截图/文件离开了页面之后，**"这是哪一天的、筛了什么"必须还在**，
       * 否则发出去的 CSV 过两天就没人说得清是什么口径了。
       */
      onExportView: (r) => {
        const cellText = (c) => {
          const o = typeof c === 'object' && c !== null ? c : { text: c };
          return String(o.text ?? '').replace(/<[^>]*>/g, '');
        };
        const head = r.cols.map((c) => c.label);
        const lines = [head.join(',')]
          .concat(r.rows.map((row) => row.cells.map(cellText).map(csvCell).join(',')));
        const stamp = `${r.day}${r.filter ? `_筛${r.filter.replace(/[^\w一-龥-]/g, '')}` : ''}`;
        download(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' }),
          `农业监测_${r.label}_${stamp}.csv`);
        ui.toast(`已导出「${r.label}」${r.rows.length} 行`
          + (r.filter ? `（筛选「${r.filter}」）` : '')
          + (r.sort ? `（按${r.sort.label}${r.sort.dir > 0 ? '升序' : '降序'}）` : ''), 'ok');
      },
      onExportPng: () => exportPng(),
      /**
       * **表格 → 地图**：点"经营单元"一行 ⇒ 把该单元的成员地块全高亮并框进视野。
       * 方向反过来（地图 → 表格）由选中地块驱动面板详情，两者共用同一份 `rows`，不会对不上号。
       */
      onHighlightUnit: (unitId) => {
        const idx = rows.filter((r) => r.unit_id === unitId).map((r) => r.i);
        const n = highlightGroup(`unit:${unitId}`, idx, `经营单元 ${unitId}`);
        if (hlKey) ui.toast(`${unitId}：${n} 个地块已高亮（再点一次这一行可取消）`, 'ok');
      },
      /** 点"统计网格"一行 ⇒ 与单元同一套高亮（只换空间键为 grid_id） */
      // 情景推演：候选点排行表要"整份离线数据"，页面只映射不改算
      onChartData: () => buildChartData(),
      onNeedScenario: () => {
        if (scenarioFile.candidates.length) return;
        ensureScenario().then(() => { ui.renderTables(); ui.renderDrawer(); }).catch(() => ui.toast('情景数据加载失败', 'warn'));
      },
      onScenarioCandidates: () => scenarioFile.candidates,
      /*
       * 候选点表：**按当前视野筛**（"该建在哪"通常先看一片区域，154 个候选逐一看太慢）。
       *
       * 筛选在数据侧做（UI 不筛、只渲染）。**指标（受益面积/平均节省/盲区…）是离线按全网重算的** ——
       * 视野只决定"先看哪几个候选"，被筛掉的行不是被删掉的数据。所以表注里必须写明这一点，
       * 否则读的人会以为"平均节省"也是视野内重算的。
       *
       * 返回的条目带**原始下标** `i`：行标签 `B-007` 必须永远对应同一个候选点，
       * 筛选后重排下标会让编号跟着漂（这是"筛完行号变了"的经典坑）。
       */
      onScenarioList: () => {
        const b = map.map.getBounds();
        const inView = (c) => c.lat <= b.getNorth() && c.lat >= b.getSouth()
          && c.lon <= b.getEast() && c.lon >= b.getWest();
        const all = scenarioFile.candidates.map((c, i) => ({ i, c }));
        const inside = all.filter((e) => inView(e.c));
        return {
          total: all.length, inView: inside.length, viewOnly: !!state.scenarioViewOnly,
          list: state.scenarioViewOnly ? inside : all,
          bounds: [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map((v) => Number(v.toFixed(4))),
        };
      },
      /*
       * 散点图的**点数据**（x = 受益面积 ha、y = 平均节省 min/块）。
       *
       * - `dim`：视图外筛选开着时，**视野外**的候选画淡（图与筛选联动，但分布形状不变）；
       * - `picked`：当前选中的候选（点图点选后要看得见选的是谁）；
       * - 点的身份只用**下标**（数组顺序 == `scenario.json` 的候选顺序 == 行编号 `B-xxx` 的来源）：
       *   页面上点中某个点时按这个下标回调选点，不必把坐标也传一份（同一件事写两份迟早对不上）。
       */
      onPickCandidateByIndex: (i) => {
        const c = scenarioFile.candidates[i];
        if (c) pickScenario({ lat: c.lat, lng: c.lon });
      },
      onScenarioScatter: () => {
        const b = map.map.getBounds();
        const inView = (c) => c.lat <= b.getNorth() && c.lat >= b.getSouth()
          && c.lon <= b.getEast() && c.lon >= b.getWest();
        const all = scenarioFile.candidates;
        const pick = state.scenarioPick;
        return {
          points: all.map((c) => ({
            x: c.improved_ha, y: c.avg_gain_min,
            dim: state.scenarioViewOnly ? !inView(c) : false,
          })),
          picked: pick ? all.findIndex((c) => c === pick) : -1,
        };
      },
      onToggleScenarioView: () => {
        state.scenarioViewOnly = !state.scenarioViewOnly;
        ui.renderTables();
        ui.toast(state.scenarioViewOnly ? '候选点表已按当前视野筛选' : '候选点表已恢复全部', 'ok');
      },
      onScenarioMeta: () => scenarioFile.metadata,
      onPickCandidate: (latlng) => pickScenario(latlng),
      onHighlightGrid: (gridId) => {
        const idx = rows.filter((r) => r.grid_id === gridId).map((r) => r.i);
        const n = highlightGroup(`grid:${gridId}`, idx, `统计网格 ${gridId}`);
        if (hlKey) ui.toast(`${gridId}：${n} 个地块已高亮（再点一次这一行可取消）`, 'ok');
      },
      onHighlightCrop: (cropCode) => {
        const idx = rows.filter((r) => (r.fallow ? 'FALLOW' : (r.crop ?? 'UNKNOWN')) === cropCode).map((r) => r.i);
        const n = highlightGroup(`crop:${cropCode}`, idx, `作物 ${cropCode}`);
        if (hlKey) ui.toast(`${cropCode}：${n} 个地块已高亮（再点一次这一行可取消）`, 'ok');
      },
      /** 取消高亮（表格右上角按钮 / 切页签时静默调用） */
      /** 「重点问题」点一行 ⇒ 高亮该问题的命中地块（与单元/作物走同一条高亮通道） */
      onQuestion: (key) => {
        const q = (lastTables?.questions ?? []).find((x) => x.key === key);
        if (!q) return;
        const n = highlightGroup(`q:${key}`, q.hits, q.title);
        if (hlKey) ui.toast(`${q.title}：命中 ${n} 块（${q.ha.toFixed(1)} ha）已在图上高亮`, 'ok');
      },
      onClearHighlight: ({ silent = false } = {}) => {
        const n = map.clearHighlight();
        hlKey = null;
        ui.setHighlightInfo(null);
        if (!silent) ui.toast(n ? `已取消 ${n} 块的高亮` : '当前没有高亮');
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
  globalThis.__agri = { model, rows, get, map, ui, state, setDay, access, units: unitsJson, ensurePivot, colorOf,
    scenarioColor, scenarioBins: SCENARIO_BINS,
    admin: adminFC, buildTables, exportCsv, exportPng, ADMIN_CODE, theme: THEME.key,
    scenario: scenarioFile, pickScenario, ensureScenario };
} catch (err) {
  fatal(err);
}
