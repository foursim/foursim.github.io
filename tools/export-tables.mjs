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
import { simulate, CROPS, levelOf } from '../js/agro.js';

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
  // ⚠️ 导出用逐日（stepDays:1）、页面用 7 天抽样：粒度是**故意不同**的 ——
  // 页面要"首屏小、播放顺"，导出要"能按旬/按季精确聚合"。所以旬表是真日均，不是抽样插值。
  stepDays: 1,
});
/**
 * 把模型输出的抽样序列**归一成数组**（与 `js/main.js` 里那份视图一致）。
 * ⚠️ 模型给的是"样本对象数组"（`{d, prog, water, fert, dis, lv}`），不是按变量分列的数组；
 * 不归一去按天取数就会拿到 undefined（旬表第一版就是这么崩的）。
 */
const rows = model.parcels.map((p, i) => ({
  ...p,
  i,
  series: {
    progress: p.series.map((x) => x.prog),
    disease: p.series.map((x) => x.dis),
    water: p.series.map((x) => x.water),
    fert: p.series.map((x) => x.fert),
  },
}));
const unitOf = new Map(units.parcel.map((p) => [p.parcel_id, p]));
const zoneOf = new Map(zones.parcels.map((z) => [z.parcel_id, z]));

// ---------- CSV 写出（RFC4180：逗号/引号/换行都要处理，否则字段里带逗号的作物名会错列） ----------
fs.mkdirSync(OUT, { recursive: true });
const esc = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/**
 * 写一张表：**同时**产出 CSV、登记进 registry（供数据元字典与 Excel 用）。
 *
 * 为什么要有 registry：数据元字典、Excel 工作簿、导出判据都必须由**同一份表定义**派生，
 * 各写一遍必然漂（表加了一列而字典没跟上，是最典型的文档腐烂）。
 */
const registry = [];
function writeCsv(name, columns, rows2) {
  const resolved = rows2.map((r) => columns.map((c) => (typeof c === 'function' ? c(r) : r[c])));
  const lines = [columns.join(',')];
  for (const row of resolved) lines.push(row.map(esc).join(','));
  fs.writeFileSync(path.join(OUT, `${name}.csv`), `${lines.join('\n')}\n`, 'utf8');
  registry.push({ name, columns, rows: resolved });
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

/**
 * **编码规则**：照国内口径「行政区划码 + 图层码 + 顺序号」。
 *
 * 国内依据是《农村土地承包经营权要素编码规则》（农业农村部）——承包地块编码以**行政区划代码**
 * （GB/T 2260 六位县级码）开头。本演示区在德国，所以前缀用**德国 AGS 县级码** `09186`
 * （Landkreis Pfaffenhofen a.d.Ilm；Wolnzach 属该县已核实，邮编 85283），**Gemeinde 级码不猜**，
 * 在 `dim_admin` 里如实标注待补。结构一致 ⇒ 换到中国演示区只换前缀，表结构一行都不用改。
 */
/**
 * **行政区划码用真实值**：读 `data/admin.geojson`（OSM `boundary=administrative` +
 * `de:amtlicher_gemeindeschluessel`），而不是手写一个。
 *
 * 编码规则照国内口径「行政区划码 + 图层码 + 顺序号」（《农村土地承包经营权要素编码规则》）：
 * 中国演示区把前缀换成 GB/T 2260 六位县级码即可，表结构一行都不用改。
 * 实测取到：Gemeinde `09186162`（Wolnzach）、Kreis `09186`（Landkreis Pfaffenhofen a.d.Ilm）。
 */
const adminFC = JSON.parse(fs.readFileSync(path.join(DATA, 'admin.geojson'), 'utf8'));
const townAdmin = adminFC.features.find((f) => String(f.properties.admin_level) === '8') ?? adminFC.features[0];
const districtAdmin = adminFC.features.find((f) => String(f.properties.admin_level) === '6');
const ADMIN = {
  admin_code: townAdmin?.properties.admin_code ?? '00000000',
  level: townAdmin?.properties.level ?? 'Gemeinde',
  name: townAdmin?.properties.name ?? '（未知）',
  parent_code: districtAdmin?.properties.admin_code ?? '',
  country: 'DE',
  state: 'Bayern',
  postal_code: '85283',
  scheme: '国内口径：行政区划码 + 图层码 + 顺序号（《农村土地承包经营权要素编码规则》）；'
    + '本演示区在德国 ⇒ 用 OSM 的官方市镇码 AGS（县级 09186 / 乡级 09186162，均为实数）',
};
/** 两级行政区划各一行（乡 + 县），父码指上去 */
const ADMIN_ROWS = [
  { ...ADMIN, source_id: 'osm', license: 'ODbL-1.0' },
  {
    admin_code: districtAdmin?.properties.admin_code ?? '',
    parent_code: '',
    level: districtAdmin?.properties.level ?? 'Kreis',
    name: districtAdmin?.properties.name ?? '',
    country: 'DE',
    state: 'Bayern',
    postal_code: '',
    scheme: 'AGS 县级码（OSM de:amtlicher_gemeindeschluessel）',
    source_id: 'osm',
    license: 'ODbL-1.0',
  },
];
const pad = (n, w) => String(n).padStart(w, '0');
const adminOf = (v) => `${ADMIN.admin_code}-${v}`;

/**
 * 变量字典（每行一个"可观测变量"）——多维度模型的关键：
 * 有了它，长表事实表只需要 `variable_code` 一列，**加变量不用改表结构**。
 * 属性按 NY/T 4997-2025《农业资源数据元》组织（中文名/英文名/定义/数据类型/值域/计量单位/来源）。
 */
const VARIABLES = [
  ['T2M', '平均气温', 'mean air temperature', '日平均气温', 'number', '-40~45', '℃', 'region', '1天', 'model', 1, '< 2 低温冷害 / > p98 异常高温', 'NASA POWER T2M 校准'],
  ['RH2M', '相对湿度', 'relative humidity', '日均相对湿度', 'number', '0~100', '%', 'region', '1天', 'model', 1, '> 85% 且连续 3 天 ⇒ 病害适宜', '中国气象局 病害气象阈值'],
  ['PREC', '降水量', 'precipitation', '日降水量', 'number', '0~120', 'mm', 'region', '1天', 'model', 1, '> p97 强降水（养分淋失/渍涝）', ''],
  ['GWETROOT', '根区土壤湿度', 'root-zone soil wetness', '根区土壤湿度指数', 'number', '0~1', '1', 'region', '1天', 'model', 1, '', 'NASA POWER GWETROOT 校准'],
  ['PROGRESS', '作物生长进度', 'crop growth progress', '按积温累积的生育进度', 'number', '0~1', '1', 'parcel/unit', '1天', 'model', 1, '迟于常年 ≥7 天', '积温法 GDD / BBCH 物候'],
  ['DISEASE_LV', '病害气象等级', 'disease meteorological level', '促病指数分级（1~5 级）', 'number', '1~5', '级', 'parcel/unit', '1天', 'model', 1, '≥3 级告警', 'QX/T 作物病害气象等级预报'],
  ['WATER_IDX', '水分保持指数', 'soil water retention index', '根区有效含水占比（田持口径）', 'number', '0~1', '1', 'parcel/unit', '1天', 'model', 1, '< p15 干旱 / > p85 渍涝', 'FAO-56 土壤水量平衡'],
  ['FERT_IDX', '养分保持指数', 'nutrient retention index', '基肥 − 吸收 − 淋失后的相对养分水平', 'number', '0~1', '1', 'parcel/unit', '1天', 'model', 1, '', ''],
  ['YIELD_HA', '单产', 'yield per hectare', '当季单位面积产量', 'number', '0~60', 't/ha', 'parcel', '1季', 'model', 1, '低于作物参考值 40%', '德国公开统计（籽粒/鲜重/干花口径分列）'],
  ['YIELD_T', '总产', 'total yield', '当季地块总产量', 'number', '0~500', 't', 'parcel', '1季', 'model', 1, '', ''],
  ['GDD_NEED', '生育期积温需求', 'growing degree days requirement', '该作物完成生育期所需积温', 'number', '0~3000', '℃·d', 'parcel', '1季', 'model', 0, '', '作物参数表'],
  ['HARVESTED_HA', '收获面积', 'harvested area', '当日收获面积', 'number', '0~1000', 'ha', 'region', '1天', 'model', 1, '', ''],
  ['T_MIN_STORE', '到收储点时间', 'travel time to collection point', '地块到最近收储点的行驶时间', 'number', '0~60', 'min', 'parcel', '静态', 'derived', 0, '> 12 min', 'OSM 路网 + 多源 Dijkstra'],
  ['ACCESS_M', '下道距离', 'off-road access distance', '地块质心到最优接入路网节点的距离', 'number', '0~2000', 'm', 'parcel', '静态', 'derived', 0, '> 300 m', ''],
  ['AREA_HA', '面积', 'area', '地块/单元面积', 'number', '0~1000', 'ha', 'parcel/unit', '静态', 'osm', 0, '', 'OSM 几何量算'],
  ['SOIL_QUALITY', '土壤质量指数', 'soil quality index', '地块土壤质地/管理的相对潜力（模拟）', 'number', '0.5~1.5', '1', 'parcel', '静态', 'model', 1, '', ''],
];
const VAR_COLS = ['variable_code', 'name_zh', 'name_en', 'definition', 'data_type', 'value_range', 'uom',
  'spatial_level', 'temporal_grain', 'source_id', 'synthetic', 'alarm_rule', 'standard_ref'];
const varRows = VARIABLES.map((v) => Object.fromEntries(VAR_COLS.map((c, i) => [c, v[i]])));

/**
 * **列字典（数据元）**：每张表每一列的中文名/英文名/单位/值域/必填。
 *
 * 为什么值得写这么多：它是"表能被人读懂"的唯一保障，而且能支撑一条**能失败的判据** ——
 * 任何表新增了列却没在这里登记，导出判据立刻报错（否则文档必然慢慢烂掉）。
 * 属性口径照 NY/T 4997-2025《农业资源数据元》（框架结构/表示/描述/细目）。
 */
const D = (zh, en, uom = '', range = '', obligation = 'M', note = '') => ({ zh, en, uom, range, obligation, note });
const COLDEF = {
  date_key: D('日期', 'date key', '', 'YYYYMMDD', 'M', '时间维主键'),
  date_start: D('旬起始日', 'decade start date', '', 'YYYYMMDD', 'M'),
  date_end: D('旬结束日', 'decade end date', '', 'YYYYMMDD', 'M'),
  decade_key: D('旬标识', 'decade key', '', 'YYYY-MM-D(旬序 1~3)', 'M', '国内农业气象旬报口径：上旬/中旬/下旬'),
  decade_seq: D('旬序号', 'decade sequence', '1', '1~99', 'M', '窗口内的旬序号'),
  days: D('旬内天数', 'days in decade', '1', '1~11', 'M', '上旬/中旬 10 天，下旬 8~11 天'),
  year: D('年', 'year', '', 'YYYY', 'M'), month: D('月', 'month', '1', '1~12', 'M'),
  day: D('日', 'day', '1', '1~31', 'M'), doy: D('年内日序', 'day of year', '1', '1~366', 'M'),
  is_growing_season: D('是否生长季', 'in growing season', '1', '0/1', 'M', '4~10 月'),
  parcel_id: D('地块标识', 'parcel identifier', '', '', 'M', 'P1 自然田块主键（OSM way/relation 派生）'),
  parcel_code: D('地块编码', 'parcel code', '', '行政区划码-图层码-顺序号', 'M', '国内口径编码'),
  season_count: D('季数', 'number of seasons', '1', '0~10', 'M', '该地块在数据窗口内的作物季数（多年生为 0）'),
  unit_id: D('经营单元标识', 'management unit identifier', '', '', 'M', 'P2 连片作业片区'),
  unit_code: D('经营单元编码', 'management unit code', '', '', 'M'),
  grid_id: D('统计网格标识', 'statistical grid identifier', '', '', 'M', 'P4 250 m 规则网格'),
  grid_code: D('统计网格编码', 'statistical grid code', '', '', 'M'),
  grid_m: D('网格边长', 'grid size', 'm', '>0', 'M'),
  admin_code: D('行政区划码', 'administrative code', '', '', 'M', '中国用 GB/T 2260 六位县级码；本演示区用 OSM 的官方市镇码 AGS'),
  parent_code: D('上级行政区划码', 'parent administrative code', '', '', 'O', '乡指县；县为空'),
  landuse: D('土地利用类型', 'land use type', '', 'farmland/meadow/orchard/vineyard', 'M', 'OSM landuse'),
  crop_code: D('作物代码', 'crop code', '', '见 dim_crop', 'M'),
  crop_name_zh: D('作物中文名', 'crop name (zh)', '', '', 'M'),
  crop_name_en: D('作物英文名', 'crop name (en)', '', '', 'O'),
  dominant_crop: D('主导作物', 'dominant crop', '', '', 'O', '单元内面积最大的作物'),
  crop_mix: D('作物构成', 'crop composition', '', '', 'O'),
  season_seq: D('季序号', 'season sequence', '1', '1~10', 'M'),
  season_year: D('作物年度', 'crop year', '', 'YYYY', 'M', '收获所在年'),
  sow_day: D('播种日', 'sowing date', '', 'YYYYMMDD', 'C'),
  harvest_day: D('收获日', 'harvest date', '', 'YYYYMMDD', 'C'),
  harvest_deadline: D('收获截止日', 'harvest deadline', '', 'YYYYMMDD', 'M', '农事日历硬约束'),
  event_day: D('事件日期', 'event date', '', 'YYYYMMDD', 'M'),
  event_type: D('农事事件类型', 'farm operation type', '', 'sow/fertilize/harvest', 'M'),
  sown_ha_today: D('当日播种面积', 'sown area today', 'ha', '0~1000', 'O'),
  harvested_ha_today: D('当日收获面积', 'harvested area today', 'ha', '0~1000', 'O'),
  harvested_ha: D('收获面积', 'harvested area', 'ha', '0~1000', 'O'),
  sown_ha: D('播种面积', 'sown area', 'ha', '0~1000', 'O'),
  fallow: D('是否休耕', 'fallow flag', '1', '0/1', 'M'),
  fallow_ha: D('休耕面积', 'fallow area', 'ha', '0~1000', 'O'),
  treated: D('是否药剂防治', 'fungicide treated', '1', '0/1', 'M'),
  n_parcels: D('地块数', 'number of parcels', '1', '>0', 'M'),
  n_zones: D('管理分区数', 'number of management zones', '1', '0~5', 'O'),
  n_points_est: D('样点数(估)', 'estimated sample count', '1', '≥0', 'O'),
  area_ha: D('面积', 'area', 'ha', '>0', 'M', 'OSM 几何量算'),
  area_ha_est: D('面积(估)', 'estimated area', 'ha', '≥0', 'O'),
  centroid_lon: D('质心经度', 'centroid longitude', '°', '-180~180', 'M', 'WGS84'),
  centroid_lat: D('质心纬度', 'centroid latitude', '°', '-90~90', 'M', 'WGS84'),
  crs: D('坐标参考系', 'coordinate reference system', '', 'EPSG:4326', 'M'),
  source_id: D('数据源标识', 'source identifier', '', '见 dim_source', 'M', '外键'),
  synthetic: D('是否模拟', 'synthetic flag', '1', '0/1', 'M', '1=程序生成，0=实测或派生自实测'),
  quality_flag: D('质量标记', 'quality flag', '', '', 'O', '空=未发现异常'),
  variable_code: D('变量代码', 'variable code', '', '见 dim_variable', 'M'),
  observed_property: D('观测属性', 'observed property', '', '见 dim_variable', 'M'),
  result_value: D('观测值', 'result value', '见 result_uom', '见 dim_variable', 'M', '单位随行携带，见同行 result_uom'),
  result_uom: D('观测值单位', 'unit of measure', '', '', 'M', '单位随行携带（长表的关键）'),
  phenomenon_time: D('观测时刻/日期', 'phenomenon time', '', 'YYYYMMDD', 'M'),
  thing_id: D('观测对象标识', 'thing identifier', '', '', 'M', 'OGC SensorThings：观测对象'),
  spatial_level: D('空间层级', 'spatial level', '', 'region/unit/parcel', 'M'),
  spatial_id: D('空间单元标识', 'spatial unit identifier', '', '', 'M'),
  temp_mean_c: D('平均气温', 'mean air temperature', '℃', '-40~45', 'M'),
  humidity_pct: D('相对湿度', 'relative humidity', '%', '0~100', 'M'),
  precip_mm: D('降水量', 'precipitation', 'mm', '0~120', 'M'),
  precip_sum_mm: D('旬降水量', 'decade precipitation sum', 'mm', '0~600', 'M'),
  soil_wetness_root: D('根区土壤湿度', 'root-zone soil wetness', '1', '0~1', 'M'),
  soil_wetness_mean: D('旬均根区土壤湿度', 'mean root-zone soil wetness', '1', '0~1', 'M'),
  crop_progress: D('作物生长进度', 'crop growth progress', '1', '0~1', 'M'),
  progress_mean: D('旬均生长进度', 'mean crop progress', '1', '0~1', 'M'),
  progress_p10: D('生长进度 p10', 'crop progress 10th percentile', '1', '0~1', 'O', '看单元内进度离散'),
  progress_p90: D('生长进度 p90', 'crop progress 90th percentile', '1', '0~1', 'O'),
  disease_level_max: D('病害气象等级(最高)', 'max disease level', '级', '1~5', 'M'),
  disease_parcels_ge3: D('病害≥3级地块数', 'parcels with disease level ≥3', '1', '0~1000', 'M'),
  water_index: D('水分保持指数', 'water retention index', '1', '0~1', 'M'),
  water_index_mean: D('旬均水分保持指数', 'mean water retention index', '1', '0~1', 'M'),
  fertility_index: D('养分保持指数', 'nutrient retention index', '1', '0~1', 'M'),
  fertility_index_mean: D('旬均养分保持指数', 'mean nutrient retention index', '1', '0~1', 'M'),
  yield_t_ha: D('单产', 'yield per hectare', 't/ha', '0~60', 'C'),
  yield_t_ha_avg: D('平均单产', 'mean yield per hectare', 't/ha', '0~60', 'O', '跨季取平均'),
  yield_t: D('总产', 'total yield', 't', '0~500', 'C'),
  yield_t_total: D('总产(合计)', 'total yield (sum)', 't', '0~5000', 'O'),
  yield_ref: D('参考单产', 'reference yield', 't/ha', '0~60', 'M', '公开统计锚点'),
  yield_uom: D('单产单位', 'yield unit', '', 't/ha', 'M'),
  yield_basis: D('单产口径', 'yield basis', '', '籽粒/鲜重/干花/干草/鲜果', 'M', '不同作物不能直接比大小'),
  gdd_need_cd: D('生育期积温需求', 'GDD requirement', '℃·d', '0~3000', 'M'),
  base_temp_c: D('基温', 'base temperature', '℃', '0~15', 'M'),
  disease_code: D('病害代码', 'disease code', '', '', 'O'),
  hierarchy_l1: D('作物大类', 'crop hierarchy level 1', '', 'cereal/fodder/industrial/grassland/permanent/fallow', 'M'),
  sow_window: D('播种窗口', 'sowing window', '', 'MM-DD~MM-DD', 'O'),
  harvest_md: D('收获月日', 'harvest month-day', '', 'MM-DD', 'O'),
  t_min_to_store: D('到收储点时间', 'travel time to collection point', 'min', '0~60', 'M', '真实路网 + Dijkstra'),
  access_m: D('下道距离', 'off-road access distance', 'm', '0~2000', 'M', '盲区信号'),
  soil_quality_sim: D('土壤质量指数', 'soil quality index (simulated)', '1', '0.5~1.5', 'M', '模拟值'),
  soil_texture: D('土壤质地', 'soil texture', '', '按土壤普查口径', 'O', '留空：待接土壤普查/土壤图'),
  soil_ph: D('土壤 pH', 'soil pH', 'pH', '3~10', 'O', '留空：待接土壤普查/土壤图'),
  soil_organic_matter: D('有机质含量', 'soil organic matter', 'g/kg', '0~100', 'O', '留空：待接土壤普查/土壤图'),
  land_quality_grade: D('耕地质量等级', 'cultivated land quality grade', '等', '1~10 等', 'O', '留空：待接 GB/T 33469 耕地质量等级'),
  zone_code: D('管理分区代码', 'management zone code', '', 'A~D', 'M', 'A=潜力最低'),
  zone_center_value: D('分区中心值', 'zone center value', '1', '', 'M'),
  sample_m: D('采样网格边长', 'sampling grid size', 'm', '>0', 'M'),
  metadata_group: D('元数据组', 'metadata group', '', '标识信息/数据特征/时空范围/扩展元素', 'M', 'NY/T 4061 三组'),
  element_name: D('元素名称', 'element name', '', '', 'M'),
  element_value: D('元素值', 'element value', '', '', 'M'),
  obligation: D('约束条件', 'obligation', '', 'M/O/C', 'M', 'M=必选 O=可选 C=条件必选'),
  data_type: D('数据类型', 'data type', '', '文本/数值/日期/布尔', 'M'),
  table_name: D('表名', 'table name', '', '', 'M'),
  column_name: D('列名', 'column name', '', '', 'M'),
  name_zh: D('中文名称', 'name in Chinese', '', '', 'M'),
  name_en: D('英文名称', 'name in English', '', '', 'M'),
  definition: D('定义', 'definition', '', '', 'M'),
  data_format: D('数据格式', 'data format', '', '', 'O'),
  value_range: D('值域', 'value range', '', '', 'O'),
  uom: D('计量单位', 'unit of measure', '', '', 'O'),
  note: D('备注', 'remark', '', '', 'O'),
  usage: D('用途', 'usage', '', '', 'O'),
  url: D('来源地址', 'source URL', '', '', 'O'),
  license: D('许可', 'license', '', '', 'M'),
  name: D('名称', 'name', '', '', 'M'),
  level: D('层级', 'level', '', 'Kreis/Gemeinde/县/乡/村', 'M'),
  country: D('国家', 'country', '', 'ISO 3166-1', 'M'),
  state: D('州/省', 'state', '', '', 'O'),
  postal_code: D('邮政编码', 'postal code', '', '', 'O'),
  scheme: D('编码口径', 'coding scheme', '', '', 'M'),
  spatial_extent: D('空间范围', 'spatial extent', '', 'WGS84 bbox', 'O'),
  temporal_grain: D('时间粒度', 'temporal grain', '', '1天/1季/静态', 'M'),
  alarm_rule: D('告警规则', 'alarm rule', '', '', 'O'),
  standard_ref: D('依据', 'standard reference', '', '', 'O'),
};

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
    { source_id: 'osm', name: 'OpenStreetMap (via Overpass API)', url: 'https://www.openstreetmap.org', license: 'ODbL-1.0', synthetic: 0, usage: '地块几何 / 路网 / 农业设施点 / **行政边界**' },
    { source_id: 'nasa-power', name: 'NASA POWER (MERRA-2), community=AG', url: 'https://power.larc.nasa.gov', license: 'NASA open data', synthetic: 0, usage: '气象锚点（校准与验收用）' },
    { source_id: 'model', name: `本项目模型 seed=${SITE.seed}`, url: '', license: '本仓库', synthetic: 1, usage: '作物 / 农事 / 产量 / 病害 / 水肥 / 气象生成' },
    { source_id: 'derived', name: '派生（路网 Dijkstra / 空间聚类）', url: '', license: 'ODbL-1.0（依 OSM）', synthetic: 0, usage: '可达性时间 / 经营单元 / 统计网格 / 管理分区样点' },
    { source_id: 'statistics', name: '公开农业统计（作物日历与参考单产）', url: 'https://www.destatis.de', license: '公开统计口径', synthetic: 0, usage: '作物基温/生育期积温/参考单产（验收锚点）' },
    { source_id: 'soil-survey', name: '土壤普查/土壤图（**尚未接入**）', url: '', license: '待定', synthetic: 0, usage: '土壤质地/pH/有机质/耕地质量等级 —— 现留空' },
  ]);

// ---------- dim_grid（P4 统计网格） ----------
const gridCount = new Map();
for (const p of units.parcel) gridCount.set(p.grid_id, (gridCount.get(p.grid_id) ?? 0) + 1);
counts.dim_grid = writeCsv('dim_grid',
  ['grid_id', 'grid_code', 'grid_m', 'n_parcels', 'crs', 'source_id'],
  [...gridCount.entries()].map(([grid_id, n]) => ({
    grid_id,
    grid_code: adminOf(`G-${grid_id.replace(/^G\d+-/, '')}`),
    grid_m: units.metadata.grid_m,
    n_parcels: n,
    crs: 'EPSG:4326',
    source_id: 'derived',
  })));

// ---------- dim_unit（P2 经营单元） ----------
const unitFeat = new Map(JSON.parse(fs.readFileSync(path.join(DATA, 'units.geojson'), 'utf8')).features.map((f) => [f.properties.unit_id, f.properties]));
counts.dim_unit = writeCsv('dim_unit',
  ['unit_id', 'unit_code', 'grid_id', 'n_parcels', 'area_ha', 'dominant_crop', 'crop_mix', 'fallow_ha', 'source_id'],
  [...unitFeat.values()].map((u) => ({
    unit_id: u.unit_id, unit_code: adminOf(`U-${u.unit_id.replace(/^U/, '')}`),
    grid_id: u.grid_id, n_parcels: u.n_parcels, area_ha: u.area_ha,
    dominant_crop: u.dominant_crop, crop_mix: u.crop_mix, fallow_ha: u.fallow_ha, source_id: 'derived',
  })));

// ---------- dim_parcel（地块维：几何属性 + 可达性 + 土壤位留空） ----------
counts.dim_parcel = writeCsv('dim_parcel',
  ['parcel_id', 'parcel_code', 'unit_id', 'grid_id', 'area_ha', 'centroid_lon', 'centroid_lat', 'landuse',
    'crop_code', 'crop_name_zh', 'fallow', 'sow_day', 'harvest_day', 'season_count', 'gdd_need_cd',
    'yield_t_ha_avg', 'yield_t_total', 'disease_level_max', 'treated', 't_min_to_store', 'access_m',
    'soil_quality_sim', 'soil_texture', 'soil_ph', 'soil_organic_matter', 'land_quality_grade', 'n_zones',
    'source_id', 'synthetic', 'crs'],
  parcelsFC.features.map((f, i) => {
    const r = rows[i];
    const u = unitOf.get(r.id) ?? {};
    const z = zoneOf.get(r.id);
    const [lon, lat] = centroid(f);
    return {
      parcel_id: r.id, parcel_code: adminOf(`P-${pad(i + 1, 6)}`), unit_id: u.unit_id ?? '', grid_id: u.grid_id ?? '',
      area_ha: r.area_ha, centroid_lon: round(lon, 6), centroid_lat: round(lat, 6), landuse: r.landuse,
      crop_code: r.fallow ? 'FALLOW' : (r.crop ?? ''), crop_name_zh: r.cropName, fallow: r.fallow ? 1 : 0,
      sow_day: r.sowDay ?? '', harvest_day: r.harvestDay ?? '', season_count: (r.seasons ?? []).length,
      gdd_need_cd: r.gddNeed, yield_t_ha_avg: round(r.yield_t_ha), yield_t_total: round(r.yield_t),
      disease_level_max: r.diseaseLevelMax, treated: r.treated ? 1 : 0,
      t_min_to_store: access.t_min[i] ?? '', access_m: access.access_m[i] ?? '',
      soil_quality_sim: round(model.plan[i].soilQuality, 3),
      // 国内土壤普查的属性位：**现在没有真数据，留空**（不编造）
      soil_texture: '', soil_ph: '', soil_organic_matter: '',
      // GB/T 33469《耕地质量等级》的口径位：同样**留空不编造**
      land_quality_grade: '',
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
/**
 * 长表要**三维齐全**：观测对象 / 变量 / 时间。
 * `variable_code` 用 `dim_variable` 的代码（这样"加变量不用改表"才成立），
 * `spatial_level`+`spatial_id` 说明"这是哪个空间单元"，好和地块级/单元级观测合并到同一张表里。
 */
const OBS = [
  ['T2M', '平均气温', '℃', (i) => R.T2M[i]],
  ['RH2M', '相对湿度', '%', (i) => R.RH2M[i]],
  ['PREC', '降水', 'mm', (i) => R.PREC[i]],
  ['GWETROOT', '根区土壤湿度', '1', (i) => R.GWETROOT[i]],
  ['PROGRESS', '作物生长进度', '1', (i) => R.progress[i]],
  ['DISEASE_LV', '病害气象等级', '级', (i) => R.diseaseLevel[i]],
  ['WATER_IDX', '水分保持指数', '1', (i) => R.waterIdx[i]],
  ['FERT_IDX', '养分保持指数', '1', (i) => R.fertIdx[i]],
];
const obsRows = [];
model.days.forEach((d, i) => {
  for (const [code, , uom, getV] of OBS) {
    obsRows.push({
      thing_id: 'region:township', spatial_level: 'region', spatial_id: 'township',
      variable_code: code, observed_property: code,
      phenomenon_time: d, result_value: getV(i), result_uom: uom,
      source_id: 'model', synthetic: 1, quality_flag: '',
    });
  }
});
counts.fact_observation = writeCsv('fact_observation',
  ['thing_id', 'spatial_level', 'spatial_id', 'variable_code', 'observed_property', 'phenomenon_time',
    'result_value', 'result_uom', 'source_id', 'synthetic', 'quality_flag'],
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

// ---------- dim_admin（行政区划/统计区划：如实标注演示区在德国、村码待补） ----------
counts.dim_admin = writeCsv('dim_admin',
  ['admin_code', 'parent_code', 'level', 'name', 'country', 'state', 'postal_code', 'scheme', 'source_id', 'license'],
  ADMIN_ROWS);

// ---------- dim_variable（变量字典：长表只需 variable_code 一列） ----------
counts.dim_variable = writeCsv('dim_variable', VAR_COLS, varRows);

// ---------- fact_unit_decade（P2 单元 × 旬 × 多变量：国内农业气象旬报口径） ----------
{
  const unitMembers = new Map();
  rows.forEach((r, i) => {
    const u = unitOf.get(r.id)?.unit_id;
    if (!u) return;
    if (!unitMembers.has(u)) unitMembers.set(u, []);
    unitMembers.get(u).push(i);
  });
  const CROP_BY = Object.fromEntries(CROPS.map((c) => [c.key, c]));
  /** 旬：上旬 1–10、中旬 11–20、下旬 21–月末（国内农业气象旬报的划分） */
  const decades = [];
  model.days.forEach((d, i) => {
    const k = Number(d.slice(6, 8)) <= 10 ? 1 : (Number(d.slice(6, 8)) <= 20 ? 2 : 3);
    const key = `${d.slice(0, 4)}-${d.slice(4, 6)}-${k}`;
    let cur = decades[decades.length - 1];
    if (!cur || cur.decade_key !== key) {
      cur = { decade_key: key, year: Number(d.slice(0, 4)), month: Number(d.slice(4, 6)), k, start: d, end: d, idx: [] };
      decades.push(cur);
    }
    cur.end = d;
    cur.idx.push(i);
  });
  decades.forEach((dc, i) => { dc.decade_seq = i + 1; });

  const pctOf = (arr, q) => {
    if (!arr.length) return '';
    const a = [...arr].sort((x, y) => x - y);
    return Math.round(a[Math.min(a.length - 1, Math.floor(a.length * q))] * 1000) / 1000;
  };
  const unitDecade = [];
  for (const [uid, members] of unitMembers) {
    const uf = unitFeat.get(uid) ?? {};
    const arable = members.filter((i) => rows[i].crop && CROP_BY[rows[i].crop]?.gddNeed > 0);
    const areaAll = members.reduce((a, i) => a + rows[i].area_ha, 0) || 1;
    const areaAr = arable.reduce((a, i) => a + rows[i].area_ha, 0) || 1;
    for (const dc of decades) {
      const last = dc.idx[dc.idx.length - 1];
      const wSum = arable.reduce((a, i) => a + rows[i].series.water[last] * rows[i].area_ha, 0);
      const fSum = arable.reduce((a, i) => a + rows[i].series.fert[last] * rows[i].area_ha, 0);
      const prog = arable.map((i) => rows[i].series.progress[last]);
      let disMax = 1;
      let disGe3 = 0;
      for (const i of members) {
        let m = 0;
        for (const d of dc.idx) m = Math.max(m, levelOf(rows[i].series.disease[d]));
        disMax = Math.max(disMax, m);
        if (m >= 3) disGe3++;
      }
      const harvestedHa = members.reduce((a, i) => a + ((rows[i].harvestDays ?? []).some((x) => x >= dc.start && x <= dc.end) ? rows[i].area_ha : 0), 0);
      const sownHa = members.reduce((a, i) => a + ((rows[i].sowDays ?? []).some((x) => x >= dc.start && x <= dc.end) ? rows[i].area_ha : 0), 0);
      unitDecade.push({
        decade_key: dc.decade_key,
        decade_seq: dc.decade_seq,
        date_start: dc.start,
        date_end: dc.end,
        days: dc.idx.length,
        unit_id: uid,
        unit_code: adminOf(`U-${uid.replace(/^U/, '')}`),
        grid_id: uf.grid_id ?? '',
        dominant_crop: uf.dominant_crop ?? '',
        area_ha: round(areaAll, 2),
        n_parcels: members.length,
        temp_mean_c: round(dc.idx.reduce((a, d) => a + R.T2M[d], 0) / dc.idx.length, 2),
        precip_sum_mm: round(dc.idx.reduce((a, d) => a + R.PREC[d], 0), 1),
        soil_wetness_mean: round(dc.idx.reduce((a, d) => a + R.GWETROOT[d], 0) / dc.idx.length, 3),
        progress_mean: round(prog.reduce((a, v) => a + v, 0) / (prog.length || 1), 3),
        progress_p10: pctOf(prog, 0.1),
        progress_p90: pctOf(prog, 0.9),
        disease_level_max: disMax,
        disease_parcels_ge3: disGe3,
        water_index_mean: round(wSum / areaAr, 3),
        fertility_index_mean: round(fSum / areaAr, 3),
        harvested_ha: round(harvestedHa, 1),
        sown_ha: round(sownHa, 1),
        source_id: 'model',
        synthetic: 1,
      });
    }
  }
  counts.fact_unit_decade = writeCsv('fact_unit_decade',
    ['decade_key', 'decade_seq', 'date_start', 'date_end', 'days', 'unit_id', 'unit_code', 'grid_id',
      'dominant_crop', 'area_ha', 'n_parcels', 'temp_mean_c', 'precip_sum_mm', 'soil_wetness_mean',
      'progress_mean', 'progress_p10', 'progress_p90', 'disease_level_max', 'disease_parcels_ge3',
      'water_index_mean', 'fertility_index_mean', 'harvested_ha', 'sown_ha', 'source_id', 'synthetic'],
    unitDecade);
  console.log(`[旬表] ${decades.length} 旬 × ${unitMembers.size} 单元 = ${unitDecade.length} 行（国内农业气象旬报口径：上旬/中旬/下旬）`);
}

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

// ---------- dim_data_element（数据元字典：每张表每一列一条） + Excel 工作簿 ----------
/**
 * 数据元字典从 registry + COLDEF **自动派生**，所以不可能出现"表加了列、字典没跟上"。
 * 属性口径照 NY/T 4997-2025《农业资源数据元》：中文名称/英文名称/定义/数据类型/数据格式/值域/计量单位/来源。
 */
const COL_SOURCE = {
  parcel_id: 'osm', area_ha: 'osm', centroid_lon: 'osm', centroid_lat: 'osm', landuse: 'osm',
  parcel_code: 'derived', unit_id: 'derived', unit_code: 'derived', grid_id: 'derived', grid_code: 'derived',
  admin_code: 'derived', parent_code: 'derived', t_min_to_store: 'derived', access_m: 'derived',
  yield_ref: 'statistics', base_temp_c: 'statistics', gdd_need_cd: 'statistics',
  sow_window: 'statistics', harvest_md: 'statistics', yield_basis: 'statistics',
  soil_texture: 'soil-survey', soil_ph: 'soil-survey', soil_organic_matter: 'soil-survey', land_quality_grade: 'soil-survey',
};
const inferType = (rows2, ci, col = '') => {
  const vals = rows2.map((r) => r[ci]).filter((v) => v !== '' && v !== null && v !== undefined);
  if (!vals.length) return 'text';
  // 编码/标识一律当**文本**：'09186' 这种若按数字走，Excel 会把前导零吃掉（判据也据此抓过一次）
  if (/(_code|_id)$/.test(col)) return 'text';
  if (vals.every((v) => /^\d{8}$/.test(String(v)))) return 'date';
  if (vals.some((v) => /^0\d+$/.test(String(v)))) return 'text';
  if (vals.every((v) => typeof v === 'number' || /^-?\d+(\.\d+)?$/.test(String(v)))) return 'number';
  if (vals.every((v) => v === 0 || v === 1 || v === '0' || v === '1')) return 'boolean';
  return 'text';
};
/** 没有登记数据元的列（判据会用它报错，而不是静默漏过去） */
const UNKNOWN_ELEMENTS = [];
{
  const elRows = [];
  for (const t of registry) {
    t.columns.forEach((col, ci) => {
      const def = COLDEF[col];
      if (!def) { UNKNOWN_ELEMENTS.push(`${t.name}.${col}`); return; }
      const type = inferType(t.rows, ci, col);
      const src = COL_SOURCE[col] ?? (col.startsWith('soil_') || col === 'land_quality_grade' ? 'soil-survey' : 'model');
      elRows.push({
        table_name: t.name,
        column_name: col,
        name_zh: def.zh,
        name_en: def.en,
        definition: def.note || def.zh,
        data_type: type,
        data_format: type === 'date' ? 'YYYYMMDD' : '',
        value_range: def.range,
        uom: def.uom,
        obligation: def.obligation,
        source_id: src,
        synthetic: src === 'model' ? 1 : 0,
        note: def.note,
      });
    });
  }
  counts.dim_data_element = writeCsv('dim_data_element',
    ['table_name', 'column_name', 'name_zh', 'name_en', 'definition', 'data_type', 'data_format',
      'value_range', 'uom', 'obligation', 'source_id', 'synthetic', 'note'], elRows);
}

{
  const { writeXlsx } = await import('./xlsx.mjs');
  const overview = [
    ['数据集', 'Wolnzach 乡镇农业监测数据集（模拟）'],
    ['版本', '0.3.0'],
    ['生成时间', new Date().toISOString()],
    ['空间参考', 'EPSG:4326（WGS84）'],
    ['规范依据', 'NY/T 4061-2021 核心元数据 · NY/T 4997-2025 农业资源数据元 · GB/T 19710 地理信息元数据 · OGC SensorThings 观测口径 · 《农村土地承包经营权要素编码规则》'],
    ['编码规则', ADMIN.scheme],
    ['真实性', '地块/路网/设施来自 OSM（真实）；气象为程序生成（用 NASA POWER 实测校准）；作物/农事/产量/病害/水肥为模型生成（synthetic=1）'],
    ['留空说明', '土壤质地/pH/有机质/耕地质量等级 留空（待接土壤普查与 GB/T 33469）—— 不编造'],
    ['怎么看', '① 每张表已冻结首行并带筛选；② 透视表建议：fact_unit_decade 行放 decade_key、列放 unit_id、值放 progress_mean；③ 字段含义见 dim_data_element'],
    ['行数汇总', registry.map((t) => `${t.name}=${t.rows.length}`).join('; ')],
  ];
  const info = writeXlsx(path.join(OUT, '农业监测数据.xlsx'), [
    { name: '说明', columns: ['项', '内容'], rows: overview },
    ...registry.map((t) => ({ name: t.name, columns: t.columns, rows: t.rows })),
  ]);
  console.log(`[Excel] 写出 tables/农业监测数据.xlsx：${info.sheets} 个工作表、${(info.bytes / 1024 / 1024).toFixed(2)} MB`);
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

// ---------- 数据字典（人看的；**从表定义派生**，不再手写清单） ----------
/** 每张表的一句话说明（缺了会被判据抓出来） */
const TABLE_NOTE = {
  meta_dataset: '元数据（NY/T 4061 三组 + GB/T 19710 时空信息）',
  dim_admin: '行政区划/统计区划（如实标注演示区在德国、村码待补）',
  dim_date: '时间维（含生长季标记）',
  dim_crop: '作物字典（含层级与单产单位口径）',
  dim_variable: '变量字典（长表只需 variable_code 一列）',
  dim_source: '数据源与许可（每一行数据都能追到来源）',
  dim_grid: 'P4 统计网格 250 m（编码可复现）',
  dim_unit: 'P2 经营单元（连片作业片区）',
  dim_parcel: 'P1 自然田块（OSM 真实几何 + 可达性）',
  dim_data_element: '数据元字典（每张表每一列一条，字段口径照 NY/T 4997）',
  fact_parcel_season: '地块 × 季：作物/播种/收获/单产/病害峰值',
  fact_parcel_event: '农事事件流水（播种/施肥/收获）',
  fact_region_daily: '区域 × 日（宽表，便于 Excel 直接看）',
  fact_observation: '区域 × 日 × 变量（长表，OGC SensorThings 观测口径）',
  fact_unit_decade: '经营单元 × 旬 × 多变量（国内农业气象旬报口径）',
  fact_zone: '地块 × 管理分区（汇总；样点明细见 data/zones.geojson）',
};
const KEY_NOTE = {
  dim_date: 'date_key', dim_crop: 'crop_code', dim_source: 'source_id', dim_grid: 'grid_id',
  dim_unit: 'unit_id', dim_parcel: 'parcel_id', dim_admin: 'admin_code', dim_variable: 'variable_code',
  fact_region_daily: 'date_key', fact_observation: '(thing_id, variable_code, phenomenon_time)',
  fact_parcel_season: '(parcel_id, season_seq)', fact_unit_decade: '(unit_id, decade_key)',
  fact_parcel_event: '—', fact_zone: '(parcel_id, zone_code)', meta_dataset: '—', dim_data_element: '(table_name, column_name)',
};
const lines = [
  '# 数据字典', '',
  '数据集：Wolnzach 乡镇农业监测（版本 0.3.0，CRS EPSG:4326，演示区在德国巴伐利亚）', '',
  '规范依据：**NY/T 4061-2021《农业大数据核心元数据》**（元数据三组）· **NY/T 4997-2025《农业资源数据元》**'
    + '（数据元属性：名称/定义/数据类型/格式/值域/计量单位/来源）· **GB/T 19710 地理信息 元数据**（CRS/空间分辨率）·'
    + ' **OGC SensorThings API**（观测长表口径）· 《农村土地承包经营权要素编码规则》（编码结构）·'
    + ' 第三次全国土壤普查属性规范与 GB/T 33469（土壤/耕地质量列位，现留空）', '',
  '## 表清单（星型模型：dim_* 维度 · fact_* 事实 · meta_* 元数据）', '',
  '| 表 | 行数 | 键 | 说明 |', '|---|---:|---|---|',
  ...registry.map((t) => `| ${t.name} | ${t.rows.length} | ${KEY_NOTE[t.name] ?? '—'} | ${TABLE_NOTE[t.name] ?? '**（缺说明）**'} |`),
  '', '## 多维度怎么读（三条主线）', '',
  '- **空间**：`dim_admin` → `dim_grid`（P4 250 m）→ `dim_unit`（P2 经营单元）→ `dim_parcel`（P1 田块）—— 四层稳定的空间身份；'
    + '作物/产量是挂在上面的**事实**，不是身份（LPIS 口径）；',
  '- **时间**：`dim_date`（日）与**旬**（上旬/中旬/下旬，见 `fact_unit_decade.decade_key`）两个粒度 —— '
    + '气温/湿度/降水按**日**（精细化），收成/农事按**季**（放宽粒度）；',
  '- **变量**：`dim_variable` 定义所有可观测量（代码/单位/值域/告警规则/依据），所以长表事实表只需 `variable_code` 一列 ——'
    + '这是"加变量不用改表结构"的关键。', '',
  '## 关键口径', '',
  '- **每一行都能追到来源**：`source_id` 外键指向 `dim_source`，`synthetic=1` 表示模型生成；',
  '- **单位随行携带**：`fact_observation.result_uom`、`dim_crop.yield_uom`、`dim_variable.uom`；',
  '- **单产口径分列**：`dim_crop.yield_basis`（籽粒/鲜重/干花/干草/鲜果）—— 不同口径不能直接比大小；',
  '- **留空即"没有真数据"**：`soil_texture` / `soil_ph` / `soil_organic_matter` / `land_quality_grade` 全空，不编造；',
  '- **分区（`fact_zone`）建立在模拟属性上**（`synthetic=1`），真分区需 DEM/土壤图/历史产量图；',
  '- 导出用**逐日**序列（`stepDays=1`）、页面用 7 天抽样：旬表是真日均，不是抽样插值。', '',
  '## Excel', '',
  '`tables/农业监测数据.xlsx` 是同一批表的合集（一张表一个 sheet，冻结首行 + 自动筛选 + 列宽自适应），'
    + '业务方不用装任何工具就能读；透视表建议见工作簿里的「说明」sheet。', '',
  '## 已知缺口（下一步）', '',
  '1. 行政边界（村/村民小组）层未接：`dim_grid` 现在只有规则网格，`dim_admin` 只到县级；',
  '2. 土壤属性、DEM、历史产量、NDVI 未接（对应列已留空）；',
  '3. `fact_parcel_daily`（地块 × 日，约 27.5 万行）未落盘 —— 由确定性模型按需重算，需要时加导出开关。',
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

// ===================== 多维度模型与元数据的判据 =====================
console.log('\n=== 多维度模型 / 元数据判据 ===');

check('数据元字典覆盖**每一张表的每一列**（防止"表加了列、字典没跟上"）',
  UNKNOWN_ELEMENTS.length === 0, UNKNOWN_ELEMENTS.length ? `缺 ${UNKNOWN_ELEMENTS.length} 条：${UNKNOWN_ELEMENTS.slice(0, 3).join(',')}` : `${counts.dim_data_element} 条数据元`);

{
  const t = new Set(registry.map((x) => x.name));
  const missing = [...t].filter((x) => !TABLE_NOTE[x]);
  check('每张表都有中文说明（防止"有表无文档"）', missing.length === 0, missing.join(',') || `${t.size} 张表`);
}

{
  const el = table('dim_data_element');
  const srcs = new Set(table('dim_source').map((r) => r.source_id));
  const bad = el.filter((r) => !srcs.has(r.source_id));
  check('数据元的 source_id 都是合法数据源（外键）', bad.length === 0,
    bad.length ? `${bad.length} 条悬空：${[...new Set(bad.map((r) => r.source_id))].join(',')}` : `${srcs.size} 个来源`);
  // 字段单位与数据类型不能空着（数据元规范里这是必填项）
  // 序数/计数/年份这类"数值但不是量"的列不需要计量单位 —— 显式列白名单，而不是放宽整条判据
  const NO_UNIT_OK = new Set(['year', 'season_year', 'month', 'day', 'doy', 'decade_seq', 'season_seq',
    'n_parcels', 'n_zones', 'n_points_est', 'obligation']);
  const noUom = el.filter((r) => r.data_type === 'number' && !r.uom && !NO_UNIT_OK.has(r.column_name));
  const noName = el.filter((r) => !r.name_zh || !r.name_en);
  check('数值型数据元都带计量单位、且都有中英文名', noUom.length === 0 && noName.length === 0,
    `缺单位 ${noUom.length} / 缺名称 ${noName.length}`);
}

{
  // 编码：结构合规 + **前缀必须是 dim_admin 里真实存在的行政区划码**（比"数位数"强：能抓住写错的码）
  const re = /^([0-9]{5,8})-([PUG])-[0-9A-Za-z-]+$/;
  const admin = new Set(table('dim_admin').map((r) => r.admin_code).filter(Boolean));
  const p2 = table('dim_parcel');
  const u2 = table('dim_unit');
  const g2 = table('dim_grid');
  const all = [
    ...p2.map((r) => ['P', r.parcel_code]),
    ...u2.map((r) => ['U', r.unit_code]),
    ...g2.map((r) => ['G', r.grid_code]),
  ];
  const badShape = all.filter(([, c]) => !re.test(c));
  const badPrefix = all.filter(([, c]) => !admin.has(c.match(re)?.[1]));
  const badLayer = all.filter(([L, c]) => re.test(c) && c.match(re)[2] !== L);
  const codes = all.map(([, c]) => c);
  check('三层编码：结构合规 + 前缀是 dim_admin 里的合法行政区划码 + 图层码正确 + 全局唯一',
    badShape.length + badPrefix.length + badLayer.length === 0 && new Set(codes).size === codes.length,
    `唯一 ${new Set(codes).size}/${codes.length}，前缀 ${[...admin].join('/')}，例 ${p2[0].parcel_code}`);
}

{
  // 旬表：每单元 × 每旬 恰好一行；旬连续无缺口
  const rows2 = table('fact_unit_decade');
  const units = new Set(table('dim_unit').map((r) => r.unit_id));
  const decades = [...new Set(rows2.map((r) => r.decade_key))];
  const perUnit = new Map();
  for (const r of rows2) perUnit.set(r.unit_id, (perUnit.get(r.unit_id) ?? 0) + 1);
  const okGrid = [...units].every((u) => perUnit.get(u) === decades.length);
  const seq = [...new Set(rows2.map((r) => Number(r.decade_seq)))].sort((a, b) => a - b);
  const okSeq = seq.length === decades.length && seq[0] === 1 && seq[seq.length - 1] === seq.length;
  const okDays = rows2.every((r) => Number(r.days) >= 1 && Number(r.days) <= 11);
  check('旬表是完整的多维网格（每单元 × 每旬一行、旬序号连续、旬内天数 1~11）',
    okGrid && okSeq && okDays, `${units.size} 单元 × ${decades.length} 旬 = ${rows2.length} 行`);
}

{
  const vars = new Set(table('dim_variable').map((r) => r.variable_code));
  const used = new Set(table('fact_observation').map((r) => r.variable_code));
  const missing = [...used].filter((v) => !vars.has(v));
  check('长表里用到的变量都在变量字典里（否则"加变量不用改表"就断了）',
    missing.length === 0 && used.size >= 6, missing.join(',') || `${used.size} 个变量 / 字典 ${vars.size} 个`);
}

check('留空列没有被编造（含耕地质量等级）',
  table('dim_parcel').every((r) => r.soil_texture === '' && r.soil_ph === '' && r.soil_organic_matter === '' && r.land_quality_grade === ''), '');

{
  const x = path.join(OUT, '农业监测数据.xlsx');
  const okX = fs.existsSync(x) && fs.statSync(x).size > 100000;
  check('Excel 工作簿已写出且体积合理（>100 KB，说明真的装了表）', okX,
    okX ? `${(fs.statSync(x).size / 1024 / 1024).toFixed(2)} MB / ${registry.length + 1} 个工作表` : '缺失');
}

console.log(`\n导出到 ${OUT}：${Object.entries(counts).map(([k, v]) => `${k} ${v} 行`).join(' / ')}`);
console.log(`================ ${pass} 通过 / ${fail} 失败 ================`);
if (fail > 0) process.exitCode = 1;
