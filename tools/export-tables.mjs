#!/usr/bin/env node
/**
 * 把这片区域的数据整理成**表格**（维度表 + 事实表 + 元数据表）
 *
 * ## 字段口径照谁（这三条是"权威"而不是我自己拍的）
 * 1. **NY/T 4061-2021《农业大数据核心元数据》**：元数据三组 ——
 *    标识信息（中英文名称、版本、摘要，**必选**）/ 数据特征（数据量、采集方式、更新频率）/ 时空范围（行政区划、时间范围）；
 *    扩展原则：不改原元素、值域可细化不可缩减 ⇒ 所以本文件**只增列、不改名**，并把"模拟/真实"作为扩展元素。
 * 2. **GB/T 19710（地理信息 元数据）**（NY/T 4061 引用它）：CRS、空间分辨率、空间范围。
 * 3. **OGC SensorThings API**（Thing → Location + Datastream → Sensor → **Observation**）：
 *    时序观测统一落成**长表** `fact_observation`（`thing_id / observed_property / phenomenon_time / result_value / result_uom`），
 *    变量可扩展、单位随行携带 —— 这比宽表更经得起加变量。
 *
 * 另外留了国内土壤普查的属性位（质地/pH/有机质…）与作物**层级字典**位（`dim_crop`，参照 EuroCrops 的作物码归一思路）。
 *
 * 用法：node tools/export-tables.mjs [--out tables] [--data data]
 */
import fs from 'node:fs';
import path from 'node:path';
import { simulate, CROPS } from '../js/agro.js';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const DATA = path.resolve(opt('data', 'data'));
const OUT = path.resolve(opt('out', 'tables'));
const SITE = { name: 'Hallertau · Wolnzach（德国 巴伐利亚）', seed: 20261013 };

const readJson = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const parcelsFC = readJson('parcels.geojson');
const weatherFile = readJson('weather_daily.json');
const access = readJson('access.json');
const units = readJson('units.json');
const zones = readJson('zones.json');
const isochrones = readJson('isochrones.geojson');

const model = simulate({
  seed: SITE.seed,
  siteName: SITE.name,
  parcels: parcelsFC.features,
  weather: { days: weatherFile.days, vars: weatherFile.vars, source: 'nasa-power' },
  lat: weatherFile.metadata.lat,
  elevation: weatherFile.metadata.elevation_m,
});
const rows = model.parcels;
const unitOf = new Map(units.parcel.map((p) => [p.parcel_id, p]));
const zoneOf = new Map(zones.parcels.map((z) => [z.parcel_id, z]));

// ---------- CSV 写出（RFC4180：逗号/引号/换行都要处理，否则字段里带逗号的作物名会错列） ----------
fs.mkdirSync(OUT, { recursive: true });
const esc = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function writeCsv(name, columns, rows2) {
  const lines = [columns.join(',')];
  for (const r of rows2) lines.push(columns.map((c) => esc(typeof c === 'function' ? c(r) : r[c])).join(','));
  fs.writeFileSync(path.join(OUT, `${name}.csv`), `${lines.join('\n')}\n`, 'utf8');
  return rows2.length;
}
const round = (v, n = 2) => (v === null || v === undefined || Number.isNaN(v) ? '' : Math.round(v * 10 ** n) / 10 ** n);
const centroid = (f) => {
  const r = f.geometry.coordinates[0];
  let x = 0;
  let y = 0;
  const k = r.length - 1 || 1;
  for (let i = 0; i < k; i++) { x += r[i][0]; y += r[i][1]; }
  return [x / k, y / k];
};

const counts = {};

// ---------- dim_date（时间维） ----------
const dates = model.days.map((d, i) => ({
  date_key: d,
  year: Number(d.slice(0, 4)),
  month: Number(d.slice(4, 6)),
  day: Number(d.slice(6, 8)),
  doy: i % 365 + 1,
  is_growing_season: Number(d.slice(4, 6)) >= 4 && Number(d.slice(4, 6)) <= 10 ? 1 : 0,
}));
counts.dim_date = writeCsv('dim_date',
  ['date_key', 'year', 'month', 'day', 'doy', 'is_growing_season'], dates);

// ---------- dim_crop（作物字典：含层级位与单位，参照 EuroCrops 的作物码归一思路） ----------
counts.dim_crop = writeCsv('dim_crop',
  ['crop_code', 'crop_name_zh', 'crop_name_en', 'hierarchy_l1', 'base_temp_c', 'gdd_need_cd',
    'yield_ref', 'yield_uom', 'yield_basis', 'sow_window', 'harvest_md', 'disease_code'],
  [...CROPS.map((c) => ({
    crop_code: c.key,
    crop_name_zh: c.name,
    crop_name_en: c.key,
    hierarchy_l1: c.key.includes('SILAGE') ? 'fodder' : (c.key === 'HOPS' ? 'industrial' : (c.key === 'MEADOW' ? 'grassland' : 'cereal')),
    base_temp_c: c.base,
    gdd_need_cd: c.gddNeed,
    yield_ref: c.yieldRef,
    yield_uom: 't/ha',
    yield_basis: c.basis,
    sow_window: c.sow ? c.sow.join('~') : '',
    harvest_md: c.harvestMD,
    disease_code: c.disease ?? '',
  })), { crop_code: 'FALLOW', crop_name_zh: '休耕', crop_name_en: 'fallow', hierarchy_l1: 'fallow',
    base_temp_c: '', gdd_need_cd: '', yield_ref: 0, yield_uom: 't/ha', yield_basis: '', sow_window: '', harvest_md: '', disease_code: '' },
  { crop_code: 'ORCHARD', crop_name_zh: '果园', crop_name_en: 'orchard', hierarchy_l1: 'permanent',
    base_temp_c: 5, gdd_need_cd: 0, yield_ref: 12, yield_uom: 't/ha', yield_basis: '鲜果', sow_window: '', harvest_md: '09-25', disease_code: 'SCAB' }]);

// ---------- dim_source（数据源与许可：**每一行数据都必须能追到来源**） ----------
counts.dim_source = writeCsv('dim_source',
  ['source_id', 'name', 'url', 'license', 'synthetic', 'usage'],
  [
    { source_id: 'osm', name: 'OpenStreetMap (via Overpass API)', url: 'https://www.openstreetmap.org', license: 'ODbL-1.0', synthetic: 0, usage: '地块几何 / 路网 / 农业设施点' },
    { source_id: 'nasa-power', name: 'NASA POWER (MERRA-2), community=AG', url: 'https://power.larc.nasa.gov', license: 'NASA open data', synthetic: 0, usage: '气象锚点（校准与验收用）' },
    { source_id: 'model', name: `本项目模型 seed=${SITE.seed}`, url: '', license: '本仓库', synthetic: 1, usage: '作物 / 农事 / 产量 / 病害 / 水肥 / 气象生成' },
    { source_id: 'derived', name: '派生（路网 Dijkstra / 空间聚类）', url: '', license: 'ODbL-1.0（依 OSM）', synthetic: 0, usage: '可达性时间 / 经营单元 / 统计网格 / 管理分区样点' },
  ]);

// ---------- dim_grid（P4 统计网格） ----------
const gridCount = new Map();
for (const p of units.parcel) gridCount.set(p.grid_id, (gridCount.get(p.grid_id) ?? 0) + 1);
counts.dim_grid = writeCsv('dim_grid',
  ['grid_id', 'grid_m', 'n_parcels', 'crs', 'source_id'],
  [...gridCount.entries()].map(([grid_id, n]) => ({ grid_id, grid_m: units.metadata.grid_m, n_parcels: n, crs: 'EPSG:4326', source_id: 'derived' })));

// ---------- dim_unit（P2 经营单元） ----------
const unitFeat = new Map(JSON.parse(fs.readFileSync(path.join(DATA, 'units.geojson'), 'utf8')).features.map((f) => [f.properties.unit_id, f.properties]));
counts.dim_unit = writeCsv('dim_unit',
  ['unit_id', 'grid_id', 'n_parcels', 'area_ha', 'dominant_crop', 'crop_mix', 'fallow_ha', 'source_id'],
  [...unitFeat.values()].map((u) => ({
    unit_id: u.unit_id, grid_id: u.grid_id, n_parcels: u.n_parcels, area_ha: u.area_ha,
    dominant_crop: u.dominant_crop, crop_mix: u.crop_mix, fallow_ha: u.fallow_ha, source_id: 'derived',
  })));

// ---------- dim_parcel（地块维：几何属性 + 可达性 + 土壤位留空） ----------
counts.dim_parcel = writeCsv('dim_parcel',
  ['parcel_id', 'unit_id', 'grid_id', 'area_ha', 'centroid_lon', 'centroid_lat', 'landuse',
    'crop_code', 'crop_name_zh', 'fallow', 'sow_day', 'harvest_day', 'season_count', 'gdd_need_cd',
    'yield_t_ha_avg', 'yield_t_total', 'disease_level_max', 'treated', 't_min_to_store', 'access_m',
    'soil_quality_sim', 'soil_texture', 'soil_ph', 'soil_organic_matter', 'n_zones',
    'source_id', 'synthetic', 'crs'],
  parcelsFC.features.map((f, i) => {
    const r = rows[i];
    const u = unitOf.get(r.id) ?? {};
    const z = zoneOf.get(r.id);
    const [lon, lat] = centroid(f);
    return {
      parcel_id: r.id, unit_id: u.unit_id ?? '', grid_id: u.grid_id ?? '',
      area_ha: r.area_ha, centroid_lon: round(lon, 6), centroid_lat: round(lat, 6), landuse: r.landuse,
      crop_code: r.fallow ? 'FALLOW' : (r.crop ?? ''), crop_name_zh: r.cropName, fallow: r.fallow ? 1 : 0,
      sow_day: r.sowDay ?? '', harvest_day: r.harvestDay ?? '', season_count: (r.seasons ?? []).length,
      gdd_need_cd: r.gddNeed, yield_t_ha_avg: round(r.yield_t_ha), yield_t_total: round(r.yield_t),
      disease_level_max: r.diseaseLevelMax, treated: r.treated ? 1 : 0,
      t_min_to_store: access.t_min[i] ?? '', access_m: access.access_m[i] ?? '',
      soil_quality_sim: round(model.plan[i].soilQuality, 3),
      // 国内土壤普查的属性位：**现在没有真数据，留空**（不编造）
      soil_texture: '', soil_ph: '', soil_organic_matter: '',
      n_zones: z ? z.n_zones : '',
      source_id: 'osm', synthetic: 1, crs: 'EPSG:4326',
    };
  }));

// ---------- fact_parcel_season（地块 × 季） ----------
const seasonRows = [];
rows.forEach((r) => {
  (r.seasons ?? []).forEach((s, si) => {
    seasonRows.push({
      parcel_id: r.id, season_seq: si + 1, season_year: s.year, crop_code: r.fallow ? 'FALLOW' : (r.crop ?? ''),
      crop_name_zh: r.cropName, sow_day: s.sow, harvest_deadline: s.deadline,
      harvest_day: r.harvestDays?.[si] ?? '', gdd_need_cd: r.gddNeed,
      yield_t_ha: r.yields?.[si] ?? '', yield_t: r.yields?.[si] ? round(r.yields[si] * r.area_ha, 1) : '',
      disease_level_max: r.diseaseLevelMax, treated: r.treated ? 1 : 0,
      source_id: 'model', synthetic: 1,
    });
  });
});
counts.fact_parcel_season = writeCsv('fact_parcel_season',
  ['parcel_id', 'season_seq', 'season_year', 'crop_code', 'crop_name_zh', 'sow_day', 'harvest_deadline',
    'harvest_day', 'gdd_need_cd', 'yield_t_ha', 'yield_t', 'disease_level_max', 'treated', 'source_id', 'synthetic'],
  seasonRows);

// ---------- fact_parcel_event（农事事件） ----------
const eventRows = [];
rows.forEach((r) => {
  (r.tillage ?? []).forEach((e) => {
    eventRows.push({
      parcel_id: r.id, event_day: e.day, event_type: e.type, crop_name_zh: e.crop ?? r.cropName,
      crop_code: r.fallow ? 'FALLOW' : (r.crop ?? ''), yield_t_ha: e.t_ha ?? '',
      source_id: 'model', synthetic: 1,
    });
  });
});
counts.fact_parcel_event = writeCsv('fact_parcel_event',
  ['parcel_id', 'event_day', 'event_type', 'crop_code', 'crop_name_zh', 'yield_t_ha', 'source_id', 'synthetic'],
  eventRows);

// ---------- fact_region_daily（区域 × 日，宽表：给人看/导 Excel） ----------
const R = model.region;
const regionRows = model.days.map((d, i) => ({
  date_key: d, temp_mean_c: R.T2M[i], humidity_pct: R.RH2M[i], precip_mm: R.PREC[i],
  soil_wetness_root: R.GWETROOT[i], crop_progress: R.progress[i], disease_level_max: R.diseaseLevel[i],
  water_index: R.waterIdx[i], fertility_index: R.fertIdx[i],
  harvested_ha_today: R.harvestedHa[i], sown_ha_today: R.sownHa[i],
  source_id: 'model', synthetic: 1,
}));
counts.fact_region_daily = writeCsv('fact_region_daily',
  ['date_key', 'temp_mean_c', 'humidity_pct', 'precip_mm', 'soil_wetness_root', 'crop_progress',
    'disease_level_max', 'water_index', 'fertility_index', 'harvested_ha_today', 'sown_ha_today', 'source_id', 'synthetic'],
  regionRows);

// ---------- fact_observation（长表，OGC SensorThings 的 Observation 口径） ----------
const OBS = [
  ['temp_mean', '气温', '℃', (i) => R.T2M[i]],
  ['humidity', '相对湿度', '%', (i) => R.RH2M[i]],
  ['precip', '降水', 'mm', (i) => R.PREC[i]],
  ['soil_wetness_root', '根区土壤湿度', '1', (i) => R.GWETROOT[i]],
  ['crop_progress', '作物生长进度', '1', (i) => R.progress[i]],
  ['disease_level', '病害等级', 'level', (i) => R.diseaseLevel[i]],
  ['water_index', '水分保持指数', '1', (i) => R.waterIdx[i]],
  ['fertility_index', '养分保持指数', '1', (i) => R.fertIdx[i]],
];
const obsRows = [];
model.days.forEach((d, i) => {
  for (const [code, , uom, get] of OBS) {
    obsRows.push({ thing_id: 'region:township', observed_property: code, phenomenon_time: d,
      result_value: get(i), result_uom: uom, source_id: 'model', synthetic: 1, quality_flag: '' });
  }
});
counts.fact_observation = writeCsv('fact_observation',
  ['thing_id', 'observed_property', 'phenomenon_time', 'result_value', 'result_uom', 'source_id', 'synthetic', 'quality_flag'],
  obsRows);

// ---------- fact_zone（地块 × 分区 汇总；样点明细见 data/zones.geojson） ----------
const zoneRows = [];
for (const z of zones.parcels) {
  const feat = zones; // 明细在 geojson，这里只做汇总
  const pts = (zoneRows.pts ??= null);
  z.zone_centers.forEach((c, ci) => {
    zoneRows.push({
      parcel_id: z.parcel_id, zone_code: 'ABCD'[ci], zone_center_value: c,
      n_points_est: Math.round(z.n_points / z.n_zones), area_ha_est: round(z.area_ha / z.n_zones),
      sample_m: zones.metadata.sample_m, source_id: 'derived', synthetic: 1,
    });
  });
  void feat; void pts;
}
counts.fact_zone = writeCsv('fact_zone',
  ['parcel_id', 'zone_code', 'zone_center_value', 'n_points_est', 'area_ha_est', 'sample_m', 'source_id', 'synthetic'],
  zoneRows);

// ---------- meta_dataset（NY/T 4061 的三组元数据 + GB/T 19710 的时空信息） ----------
const metaGroups = [
  ['标识信息', 'dataset_name_zh', 'Wolnzach 乡镇农业监测数据集', 'M', '文本'],
  ['标识信息', 'dataset_name_en', 'Wolnzach township agricultural monitoring dataset', 'M', '文本'],
  ['标识信息', 'dataset_version', '0.2.0', 'M', '文本'],
  ['标识信息', 'abstract', '以 OSM 真实地块/路网/设施为骨架、监测值由本项目确定性模型生成的乡镇尺度农业监测数据集；含 P1 自然田块 / P2 经营单元 / P4 统计网格三层空间单元', 'M', '文本'],
  ['数据特征', 'record_counts', Object.entries(counts).map(([k, v]) => `${k}:${v}`).join('; '), 'M', '文本'],
  ['数据特征', 'collection_method', 'OpenStreetMap Overpass API 取真实矢量；NASA POWER 取气象锚点；其余由模型计算（seed 固定 ⇒ 可复现）', 'M', '文本'],
  ['数据特征', 'update_frequency', '按需重算（模型确定性；取数脚本见 tools/）', 'M', '文本'],
  ['数据特征', 'synthetic_flag', '逐行 synthetic 列（1=模型生成，0=实测/派生自实测）', 'M', '布尔'],
  ['时空范围', 'spatial_extent', parcelsFC.metadata.bbox.join(','), 'C', '文本'],
  ['时空范围', 'temporal_extent', `${model.days[0]}~${model.days[model.days.length - 1]}`, 'C', '文本'],
  ['时空范围', 'admin_area', 'Wolnzach, Bayern, DE（演示区；未含行政边界图层）', 'C', '文本'],
  ['时空范围', 'crs', 'EPSG:4326', 'M', '文本'],
  ['时空范围', 'spatial_resolution', `地块级（中位 1.12 ha）+ 统计网格 ${units.metadata.grid_m} m + 分区样点 ${zones.metadata.sample_m} m`, 'M', '文本'],
  ['时空范围', 'temporal_resolution', '区域 1 天；地块 1 季（事件级到天）', 'M', '文本'],
  ['扩展元素', 'license', 'OSM=ODbL-1.0；NASA POWER=NASA open data；模型输出=本仓库', 'O', '文本'],
  ['扩展元素', 'provenance_chain', 'OSM/NASA → tools/fetch-data.mjs → data/*.geojson|json → tools/build-*.mjs → data/units|zones → tools/export-tables.mjs → tables/*.csv', 'O', '文本'],
  ['扩展元素', 'isochrone_levels_min', isochrones.metadata.levels_min.join('/'), 'O', '文本'],
  ['扩展元素', 'model_seed', String(SITE.seed), 'O', '整数'],
];
// ⚠️ metaGroups 是**数组的数组**，不能走 writeCsv（那个按对象/函数取值 ⇒ 会写出一张空表，
// 而且不报错）。第一版就是这么静默写空的，靠"值非空"判据才抓到。
{
  const head = ['metadata_group', 'element_name', 'element_value', 'obligation', 'data_type'];
  const body = [head.join(','), ...metaGroups.map((r) => r.map(esc).join(','))];
  fs.writeFileSync(path.join(OUT, 'meta_dataset.csv'), `${body.join('\n')}\n`, 'utf8');
  counts.meta_dataset = metaGroups.length;
}

// ---------- schema.json（逐列的机器可读定义：类型/单位/来源/是否模拟/约束） ----------
const COLS = {
  dim_parcel: {
    parcel_id: { type: 'string', key: 'PK', source: 'osm' },
    unit_id: { type: 'string', key: 'FK→dim_unit', source: 'derived' },
    grid_id: { type: 'string', key: 'FK→dim_grid', source: 'derived' },
    area_ha: { type: 'number', unit: 'ha', min: 0.02, source: 'osm' },
    t_min_to_store: { type: 'number', unit: 'min', min: 0, source: 'derived' },
    access_m: { type: 'number', unit: 'm', min: 0, source: 'derived' },
    soil_quality_sim: { type: 'number', unit: '1', min: 0.5, max: 1.5, source: 'model', synthetic: 1 },
    soil_texture: { type: 'string', unit: '', source: 'soil-survey', note: '留空：待接土壤普查/土壤图' },
    soil_ph: { type: 'number', unit: 'pH', source: 'soil-survey', note: '留空：待接土壤普查/土壤图' },
    soil_organic_matter: { type: 'number', unit: 'g/kg', source: 'soil-survey', note: '留空：待接土壤普查/土壤图' },
  },
  fact_region_daily: {
    temp_mean_c: { type: 'number', unit: '℃', min: -35, max: 45, source: 'model' },
    humidity_pct: { type: 'number', unit: '%', min: 0, max: 100, source: 'model' },
    precip_mm: { type: 'number', unit: 'mm', min: 0, source: 'model' },
    soil_wetness_root: { type: 'number', unit: '1', min: 0, max: 1, source: 'model' },
    crop_progress: { type: 'number', unit: '1', min: 0, max: 1, source: 'model' },
    disease_level_max: { type: 'number', unit: 'level', min: 1, max: 5, source: 'model' },
    water_index: { type: 'number', unit: '1', min: 0, max: 1, source: 'model' },
    fertility_index: { type: 'number', unit: '1', min: 0, max: 1, source: 'model' },
  },
  fact_parcel_season: {
    yield_t_ha: { type: 'number', unit: 't/ha', min: 0, source: 'model', synthetic: 1 },
    yield_t: { type: 'number', unit: 't', min: 0, source: 'model', synthetic: 1 },
    gdd_need_cd: { type: 'number', unit: '℃·d', min: 0, source: 'model' },
  },
  fact_observation: {
    result_value: { type: 'number', unit: '见 result_uom', source: 'model' },
    phenomenon_time: { type: 'string', unit: '', format: 'YYYYMMDD', source: 'model' },
  },
};
fs.writeFileSync(path.join(OUT, 'schema.json'), JSON.stringify({
  dataset: 'Wolnzach 农业监测数据集',
  version: '0.2.0',
  crs: 'EPSG:4326',
  conventions: {
    metadata: 'NY/T 4061-2021《农业大数据核心元数据》：标识信息 / 数据特征 / 时空范围三组；扩展元素只增不改名',
    geospatial: 'GB/T 19710（地理信息 元数据）：CRS / 空间分辨率 / 空间范围',
    observation: 'OGC SensorThings API Observation 口径（thing_id / observed_property / phenomenon_time / result_value / result_uom）',
    crop_hierarchy: '作物字典含层级位（参照 EuroCrops 的作物码归一思路）',
    soil_fields: '土壤属性列位参照第三次全国土壤普查属性图规范；当前留空，待接真实土壤数据',
  },
  record_counts: counts,
  tables: Object.fromEntries(Object.entries(COLS).map(([t, c]) => [t, { columns: c }])),
}, null, 1), 'utf8');

// ---------- 数据字典（人看的） ----------
const lines = [
  '# 数据字典', '',
  `数据集：Wolnzach 乡镇农业监测（版本 0.2.0，CRS EPSG:4326）`, '',
  '## 表清单', '',
  '| 表 | 行数 | 键 | 说明 |', '|---|---:|---|---|',
  `| meta_dataset | ${counts.meta_dataset} | — | 元数据（NY/T 4061 三组） |`,
  `| dim_date | ${counts.dim_date} | date_key | 时间维 |`,
  `| dim_crop | ${counts.dim_crop} | crop_code | 作物字典（含层级与单位） |`,
  `| dim_source | ${counts.dim_source} | source_id | 数据源与许可 |`,
  `| dim_grid | ${counts.dim_grid} | grid_id | P4 统计网格（${units.metadata.grid_m} m） |`,
  `| dim_unit | ${counts.dim_unit} | unit_id | P2 经营单元（连片作业片区） |`,
  `| dim_parcel | ${counts.dim_parcel} | parcel_id | P1 自然田块（OSM 真实几何） |`,
  `| fact_parcel_season | ${counts.fact_parcel_season} | parcel_id+season_seq | 地块 × 季（作物/播种/收获/单产） |`,
  `| fact_parcel_event | ${counts.fact_parcel_event} | — | 农事事件（播种/施肥/收获） |`,
  `| fact_region_daily | ${counts.fact_region_daily} | date_key | 区域 × 日（宽表，便于 Excel） |`,
  `| fact_observation | ${counts.fact_observation} | — | 区域 × 日 × 变量（长表，OGC 观测口径） |`,
  `| fact_zone | ${counts.fact_zone} | parcel_id+zone_code | 管理分区汇总（样点明细见 data/zones.geojson） |`,
  '', '## 关键口径', '',
  '- **每一行都能追到来源**：`source_id` 外键指向 `dim_source`，`synthetic=1` 表示模型生成；',
  '- **地块身份稳定**：`parcel_id`（P1）不随作物变；作物/轮作/产量都在事实表里（LPIS 口径）；',
  '- **单位随行携带**：长表 `fact_observation.result_uom`、字典 `dim_crop.yield_uom`；',
  '- **留空即"没有真数据"**：土壤质地/pH/有机质三列留空，不编造；',
  '- 分区（`fact_zone`）建立在**模拟属性**上（`synthetic=1`），真分区需 DEM/土壤图/产量图。',
  '', '## 已知缺口（下一步）', '',
  '1. 行政边界（村/村民小组）层未接：`dim_grid` 现在只有规则网格；',
  '2. 土壤属性、DEM、历史产量、NDVI 未接；',
  '3. `fact_parcel_daily`（地块 × 日，275k 行）未落盘 —— 由确定性模型按需重算，需要时再加导出开关。',
];
fs.writeFileSync(path.join(OUT, '数据字典.md'), lines.join('\n'), 'utf8');

// ---------- 导出判据（能失败） ----------
let pass = 0;
let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  [OK]   ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`); }
};
// ⚠️ 必须把 \r 去掉：仓库若被检出成 CRLF（Windows 上的默认行为），
// 每行末尾会多一个 \r，最后一个字段会变成 "1\r"，`synthetic === '1'` 这类判据就会假失败。
const rd = (t) => fs.readFileSync(path.join(OUT, `${t}.csv`), 'utf8').replace(/\r\n/g, '\n').trim().split('\n');
const parseRow = (line) => {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
};
const table = (t) => {
  const lines2 = rd(t);
  const head = parseRow(lines2[0]);
  return lines2.slice(1).map((l) => Object.fromEntries(parseRow(l).map((v, i) => [head[i], v])));
};
console.log('\n=== 导出判据 ===');
const parcelIds = new Set(table('dim_parcel').map((r) => r.parcel_id));
check('dim_parcel 主键唯一', parcelIds.size === counts.dim_parcel, `${parcelIds.size}/${counts.dim_parcel}`);
for (const t of ['fact_parcel_season', 'fact_parcel_event', 'fact_zone']) {
  const rows2 = table(t);
  const bad = rows2.filter((r) => !parcelIds.has(r.parcel_id));
  check(`${t} 外键完整（parcel_id ∈ dim_parcel）`, bad.length === 0, bad.length ? `${bad.length} 行悬空` : `${rows2.length} 行`);
}
{
  const u = table('dim_unit');
  const g = new Set(table('dim_grid').map((r) => r.grid_id));
  check('dim_unit 的 grid_id 都在 dim_grid 中', u.every((r) => g.has(r.grid_id)), `${u.length} 个单元`);
  const ids = new Set(u.map((r) => r.unit_id));
  check('dim_unit 主键唯一', ids.size === u.length, `${ids.size}/${u.length}`);
}
{
  const rows2 = table('fact_region_daily');
  const badT = rows2.filter((r) => Number(r.humidity_pct) < 0 || Number(r.humidity_pct) > 100);
  const badP = rows2.filter((r) => Number(r.crop_progress) < 0 || Number(r.crop_progress) > 1);
  const badD = rows2.filter((r) => Number(r.disease_level_max) < 1 || Number(r.disease_level_max) > 5);
  check('值域：湿度 0~100 / 进度 0~1 / 病级 1~5', badT.length + badP.length + badD.length === 0,
    `越界 ${badT.length + badP.length + badD.length} 行`);
  let gaps = 0;
  const day = (s) => Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`);
  for (let i = 1; i < rows2.length; i++) if (Math.round((day(rows2[i].date_key) - day(rows2[i - 1].date_key)) / 86400000) !== 1) gaps++;
  check('fact_region_daily 日期连续无断日', gaps === 0, `断日 ${gaps}`);
}
{
  const rows2 = table('fact_parcel_season').filter((r) => r.yield_t_ha !== '');
  const crops = new Map(table('dim_crop').map((r) => [r.crop_code, Number(r.yield_ref)]));
  const bad = rows2.filter((r) => {
    const ref = crops.get(r.crop_code);
    return ref > 0 && (Number(r.yield_t_ha) / ref < 0.4 || Number(r.yield_t_ha) / ref > 1.45);
  });
  check('单产与作物参考值可比（比值 0.4~1.45）', bad.length === 0, bad.length ? `${bad.length} 行越界` : `${rows2.length} 行`);
}
{
  const rows2 = table('fact_observation');
  const props = new Set(rows2.map((r) => r.observed_property));
  check('长表观测：每个变量都带单位（result_uom 非空）', rows2.every((r) => r.result_uom !== ''),
    `${props.size} 个变量 / ${rows2.length} 行`);
  const nDates = new Set(rows2.map((r) => r.phenomenon_time)).size;
  check('长表观测：日期 × 变量 的笛卡尔积完整', rows2.length === nDates * props.size,
    `${nDates} 天 × ${props.size} 变量 = ${nDates * props.size}`);
}
check('所有派生/模型表的行都带 synthetic 标记', ['fact_parcel_season', 'fact_parcel_event', 'fact_region_daily', 'fact_observation', 'fact_zone']
  .every((t) => table(t).every((r) => r.synthetic === '0' || r.synthetic === '1')), '');
check('留空列没有被编造（土壤质地/pH/有机质 全空）',
  table('dim_parcel').every((r) => r.soil_texture === '' && r.soil_ph === '' && r.soil_organic_matter === ''), '');
{
  const meta = table('meta_dataset');
  check('meta_dataset 覆盖 NY/T 4061 的三组（标识信息/数据特征/时空范围）',
    ['标识信息', '数据特征', '时空范围'].every((g) => meta.some((r) => r.metadata_group === g)),
    [...new Set(meta.map((r) => r.metadata_group))].join('/'));
  // 空表最容易被忽略：元素名与取值都必须非空
  const empty = meta.filter((r) => !r.element_name || !r.element_value);
  check('meta_dataset 每个元素都有名有值（防止"静默写出空表"）', empty.length === 0 && meta.length > 10,
    `${meta.length} 个元素，空值 ${empty.length} 个`);
}

console.log(`\n导出到 ${OUT}：${Object.entries(counts).map(([k, v]) => `${k} ${v} 行`).join(' / ')}`);
console.log(`================ ${pass} 通过 / ${fail} 失败 ================`);
if (fail > 0) process.exitCode = 1;
