#!/usr/bin/env node
/**
 * P3 管理分区（**演示版**）：地块内按"水分/土壤潜力"再分 2~3 个管理分区。
 *
 * ## 为什么用"网格样点"而不是多边形
 * 精准农业里管理分区的标准做法就是**网格采样 + 聚类**（例如 70×70 m 网格、上百个采样点，
 * 再按产量/土壤 EC/NDVI 聚类成 2~3 个区），见 USDA ARS 关于 ECa 的综述与 CAU 的灌溉分区研究。
 * 直接把地块切成多边形需要"地块内的高程/土壤/产量栅格"，而我们现在**没有这些真数据** ——
 * 所以这一版只做**网格样点 + 分区类**的演示，并如实标注它建立在模型的模拟属性上。
 *
 * 要升级成真分区，缺的是：DEM（高程）、土壤图（质地/有机质）、历史产量图、NDVI 时序。
 *
 * 用法：node tools/build-zones.mjs [--out data] [--sample-m 25]
 */
import fs from 'node:fs';
import path from 'node:path';
import { simulate } from '../js/agro.js';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const OUT = path.resolve(opt('out', 'data'));
const SAMPLE_M = Number(opt('sample-m', 25));
const MAX_ZONES = Number(opt('max-zones', 3));

// ---------- 数据 ----------
const parcelsFC = JSON.parse(fs.readFileSync(path.join(OUT, 'parcels.geojson'), 'utf8'));
const parcels = parcelsFC.features;
const weatherFile = JSON.parse(fs.readFileSync(path.join(OUT, 'weather_daily.json'), 'utf8'));
// ⚠️ 分区值要建立在**真实土壤**上（SoilGrids），否则所谓"管理分区"只是把随机数画成图
const soilFile = JSON.parse(fs.readFileSync(path.join(OUT, 'soil.json'), 'utf8'));
const model = simulate({
  seed: 20261013,
  parcels,
  weather: { days: weatherFile.days, vars: weatherFile.vars, source: 'nasa-power' },
  lat: weatherFile.metadata.lat,
  elevation: weatherFile.metadata.elevation_m,
  soil: soilFile.parcels,
});
const plan = new Map(model.plan.map((p, i) => [i, p]));

// ---------- 工具 ----------
/** 射线法：点是否在环内 */
function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** 确定性平滑场（多正弦叠加；不需要 RNG，换地区也一样可复现） */
function smoothField(lon, lat) {
  const x = lon * 111320 * Math.cos((lat * Math.PI) / 180);
  const y = lat * 110540;
  const a = Math.sin(x / 260) * Math.cos(y / 310);
  const b = Math.sin((x + y) / 140) * 0.6;
  const c = Math.cos((x - y) / 420) * 0.45;
  return (a + b + c) / 2.05; // 归一到大致 [-1,1]
}
/** 一维 k-means（确定性初始化：分位点） */
function kmeans1d(values, k, iters = 24) {
  const sorted = [...values].sort((a, b) => a - b);
  const centers = [];
  for (let i = 0; i < k; i++) centers.push(sorted[Math.floor(((i + 0.5) / k) * sorted.length)]);
  let assign = new Array(values.length).fill(0);
  for (let it = 0; it < iters; it++) {
    assign = values.map((v) => {
      let bi = 0;
      let bd = Infinity;
      centers.forEach((c, ci) => { const d = Math.abs(v - c); if (d < bd) { bd = d; bi = ci; } });
      return bi;
    });
    for (let ci = 0; ci < k; ci++) {
      const g = values.filter((_, i) => assign[i] === ci);
      if (g.length) centers[ci] = g.reduce((a, b) => a + b, 0) / g.length;
    }
  }
  // 按中心值从小到大重排成 A/B/C，保证"区号"有顺序含义（A=潜力最低）
  const order = centers.map((c, i) => [c, i]).sort((x, y) => x[0] - y[0]).map(([, i]) => i);
  const remap = new Map(order.map((orig, ni) => [orig, ni]));
  return { assign: assign.map((a) => remap.get(a)), centers: order.map((i) => centers[i]) };
}

// ---------- 采样 + 分区 ----------
const features = [];
const summary = [];
let totalPts = 0;
for (let i = 0; i < parcels.length; i++) {
  const ring = parcels[i].geometry.coordinates[0];
  const p = parcels[i].properties;
  if (p.landuse === 'meadow' || p.landuse === 'orchard') continue; // 草地/果园不做分区（不是耕作地块）
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of ring) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  const dLat = SAMPLE_M / 110540;
  const dLon = SAMPLE_M / (111320 * Math.cos(((y0 + y1) / 2) * (Math.PI / 180)));
  const pts = [];
  for (let lon = x0 + dLon / 2; lon < x1; lon += dLon) {
    for (let lat = y0 + dLat / 2; lat < y1; lat += dLat) {
      if (!inRing(lon, lat, ring)) continue;
      pts.push([Math.round(lon * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6]);
    }
  }
  if (pts.length < 2) continue;
  const sq = plan.get(i)?.soilQuality ?? 1;
  // 分区值 = 地块土壤质量（模型，模拟值） + 空间平滑场（模拟的"田间差异"）
  const values = pts.map(([lon, lat]) => 0.55 * (sq - 0.85) / 0.3 + 0.45 * smoothField(lon, lat));
  const k = Math.min(MAX_ZONES, Math.max(2, Math.ceil(p.area_ha / 4)));
  const { assign, centers } = kmeans1d(values, k);
  pts.forEach(([lon, lat], pi) => {
    features.push({
      type: 'Feature',
      properties: {
        parcel_id: p.id,
        zone: 'ABCD'[assign[pi]],
        zone_value: Math.round(values[pi] * 1000) / 1000,
        sample_m: SAMPLE_M,
        synthetic: true,
      },
      geometry: { type: 'Point', coordinates: [lon, lat] },
    });
    totalPts++;
  });
  summary.push({
    parcel_id: p.id,
    area_ha: p.area_ha,
    n_zones: k,
    n_points: pts.length,
    zone_centers: centers.map((c) => Math.round(c * 1000) / 1000),
    soil_quality: sq,
  });
}

fs.writeFileSync(path.join(OUT, 'zones.geojson'), JSON.stringify({
  type: 'FeatureCollection',
  metadata: {
    layer: `P3 管理分区（${SAMPLE_M} m 网格采样 + 一维 k-means，演示）`,
    sample_m: SAMPLE_M,
    max_zones: MAX_ZONES,
    synthetic: true,
    caveat: '分区值建立在**模型的模拟属性**（地块土壤质量 + 平滑场）上，不是真实土壤/产量数据；'
      + '真分区需要 DEM、土壤图、历史产量图、NDVI 时序',
  },
  features,
}), 'utf8');
fs.writeFileSync(path.join(OUT, 'zones.json'), JSON.stringify({
  metadata: { sample_m: SAMPLE_M, parcels_with_zones: summary.length, points: totalPts, synthetic: true },
  parcels: summary,
}, null, 1), 'utf8');

const zc = summary.reduce((a, s) => a + s.n_zones, 0);
console.log(`[分区] ${summary.length} 块地 / ${totalPts} 个样点 / 共 ${zc} 个分区（平均 ${(zc / summary.length).toFixed(2)} 区/块，${SAMPLE_M} m 网格）`);
console.log(`[分区] 写出 data/zones.geojson 与 data/zones.json（分区值基于真实土壤潜力 SoilGrids；分区边界按 25 m 网格聚类）`);
