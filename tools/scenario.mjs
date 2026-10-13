/**
 * 情景推演：**新建一个收储点**能把可达性改到什么程度。
 *
 * ## 为什么离线算、浏览器只查表
 * 这是一个"假设 → 重算全网最短路"的问题：单个候选点做一次单源 Dijkstra 是毫秒级，
 * 但要在浏览器里做，就得把 1500+ 条路、几千个节点搬进页面再实现一遍 Dijkstra ——
 * 与"页面要轻、首屏要快"直接冲突。所以**把重的活留在离线**（这个脚本），
 * 把结果压成一张小表（每个候选点一行统计 + 受影响地块列表），运行时只做**最近候选点的查表**。
 *
 * ## 口径与 `build-access.mjs` 完全一致（否则前后对比就不成立）
 * 地块到点的时间 = `min over 可达路网节点 ( dist[节点] + 接驳时间(质心 → 节点) )`，
 * 接驳按 10 km/h 机耕速度。脚本里会**用同一套代码复算一遍现状**并与 `access.json` 对照，
 * 差得多就报出来（这条自检是"对比可信"的前提：两边算法一旦不同，前后差值就是假的）。
 *
 * ## 盲区阈值
 * 用本地的 **p90**（现状到最近收储点时间的 90 分位）当"盲区"门槛 ——
 * 与等时圈层级的取法一致（本地分位数），而不是拍一个绝对值。
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const OUT = path.resolve(opt('out', 'data'));
const STEP_M = Number(opt('step-m', 350));
const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
const hav = (a, b) => {
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
};

/*
 * 通行参数**import 共享模块**，不再手抄 —— 第一版手抄时把 motorway 写成 100（实际 80），
 * 复算现状与 access.json 差了 2.33 分钟，差点拿一个"假的改善量"去汇报。
 */
import { SPEED, OFFROAD, SOURCE_KINDS, SNAP_M, CELL } from './road-speeds.mjs';

const roads = JSON.parse(fs.readFileSync(path.join(OUT, 'roads.geojson'), 'utf8')).features;
const parcels = JSON.parse(fs.readFileSync(path.join(OUT, 'parcels.geojson'), 'utf8')).features;
const poi = JSON.parse(fs.readFileSync(path.join(OUT, 'poi.geojson'), 'utf8')).features;
const access = JSON.parse(fs.readFileSync(path.join(OUT, 'access.json'), 'utf8'));

// ---------- ① 建图（与 build-access 同法：15 m 吸附 + 按道路等级速度） ----------
const buckets = new Map();
const nodes = [];
const nodeOf = (lon, lat) => {
  const ci = Math.floor(lon / CELL);
  const cj = Math.floor(lat / CELL);
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      const b = buckets.get(`${ci + di},${cj + dj}`);
      if (!b) continue;
      for (const k of b) if (hav(nodes[k], [lon, lat]) <= SNAP_M) return k;
    }
  }
  const i = nodes.length;
  nodes.push([lon, lat]);
  const k = `${ci},${cj}`;
  if (!buckets.has(k)) buckets.set(k, []);
  buckets.get(k).push(i);
  return i;
};
const adj = [];
const addEdge = (a, b, sec) => {
  if (a === b) return;
  (adj[a] ??= []).push([b, sec]);
  (adj[b] ??= []).push([a, sec]);
};
for (const f of roads) {
  const mps = (((SPEED[f.properties.highway] ?? 20) * 1000) / 3600);
  const cs = f.geometry.coordinates;
  for (let i = 1; i < cs.length; i++) {
    addEdge(nodeOf(cs[i - 1][0], cs[i - 1][1]), nodeOf(cs[i][0], cs[i][1]), hav(cs[i - 1], cs[i]) / mps);
  }
}
const nearestNode = (lon, lat) => {
  let best = -1;
  let bd = Infinity;
  for (let i = 0; i < nodes.length; i++) {
    const d = (nodes[i][0] - lon) ** 2 + (nodes[i][1] - lat) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
};
console.log(`[情景] 路网图 ${nodes.length} 节点 / ${adj.reduce((a, e) => a + (e ? e.length : 0), 0) / 2} 边`);

/** 单源/多源 Dijkstra → 每个节点的到达秒数 */
function dijkstra(sourceNodes) {
  const dist = new Float64Array(nodes.length).fill(Infinity);
  const heap = [];
  const push = (d, v) => {
    heap.push([d, v]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  for (const v of sourceNodes) { dist[v] = 0; push(0, v); }
  while (heap.length) {
    const [d, v] = pop();
    if (d > dist[v]) continue;
    for (const [w, sec] of adj[v] ?? []) {
      const nd = d + sec;
      if (nd < dist[w]) { dist[w] = nd; push(nd, w); }
    }
  }
  return dist;
}

const centroids = parcels.map((f) => {
  const r = f.geometry.coordinates[0];
  let x = 0;
  let y = 0;
  const k = r.length - 1 || 1;
  for (let i = 0; i < k; i++) { x += r[i][0]; y += r[i][1]; }
  return [x / k, y / k];
});
const areas = parcels.map((f) => f.properties.area_ha ?? 0);
const offroadMps = (OFFROAD * 1000) / 3600;
/** 地块 → 分钟：对**所有可达节点**取 min(dist + 接驳)（与 build-access 同口径） */
function parcelMinutes(dist) {
  return centroids.map((c) => {
    let best = Infinity;
    for (let k = 0; k < nodes.length; k++) {
      const d = dist[k];
      if (d === Infinity) continue;
      const t = d + hav(c, nodes[k]) / offroadMps;
      if (t < best) best = t;
    }
    return Number.isFinite(best) ? best / 60 : null;
  });
}

// ---------- ② 现状（复算并自检） ----------
const srcNodes = [];
for (const f of poi.filter((p) => SOURCE_KINDS.has(p.properties.kind))) {
  srcNodes.push(nearestNode(f.geometry.coordinates[0], f.geometry.coordinates[1]));
}
const baseMin = parcelMinutes(dijkstra([...new Set(srcNodes)]));
const ref = access.t_min;
let maxDiff = 0;
baseMin.forEach((v, i) => {
  if (v == null || ref[i] == null) return;
  maxDiff = Math.max(maxDiff, Math.abs(v - ref[i]));
});
console.log(`[情景] 现状复算与 access.json 的最大差：${maxDiff.toFixed(3)} 分钟`
  + `${maxDiff > 0.05 ? '  ⚠️ 两套算法口径不一致，前后对比不可信 —— 先对齐！' : '  ✓ 口径一致'}`);
{
  const okSources = poi.filter((p) => SOURCE_KINDS.has(p.properties.kind)).length;
  console.log(`[情景] 现状收储点 ${okSources} 个（${[...new Set(poi.filter((p) => SOURCE_KINDS.has(p.properties.kind)).map((p) => p.properties.label))].join('、')}）`);
}

const stat = (arr) => {
  const a = arr.filter((v) => v != null).sort((x, y) => x - y);
  const q = (p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
  return {
    n: a.length, avg: a.reduce((x, y) => x + y, 0) / (a.length || 1),
    p50: q(0.5), p90: q(0.9), max: a[a.length - 1], min: a[0],
  };
};
const baseStat = stat(baseMin);
const BLIND_MIN = Math.round(baseStat.p90 * 100) / 100; // 盲区阈值 = 现状 p90
// ⚠️ `baseMin` 里是**分钟值**不是下标：第一版直接拿它去 `areas[i]` 取面积 ⇒ 面积算出 NaN
const baseBlind = [];
baseMin.forEach((v, i) => { if (v != null && v > BLIND_MIN) baseBlind.push(i); });
console.log(`[情景] 现状：平均 ${baseStat.avg.toFixed(2)} / 中位 ${baseStat.p50.toFixed(2)} / p90 ${baseStat.p90.toFixed(2)} / 最远 ${baseStat.max.toFixed(2)} 分钟`);
console.log(`[情景] 盲区阈值（现状 p90）= ${BLIND_MIN} 分钟 ⇒ ${baseBlind.length} 块 / ${baseBlind.reduce((a, i) => a + areas[i], 0).toFixed(1)} ha`);

// ---------- ③ 候选点网格 + 逐点重算 ----------
let x0 = Infinity;
let y0 = Infinity;
let x1 = -Infinity;
let y1 = -Infinity;
for (const [x, y] of centroids) {
  if (x < x0) x0 = x;
  if (y < y0) y0 = y;
  if (x > x1) x1 = x;
  if (y > y1) y1 = y;
}
const dLat = STEP_M / 110540;
const dLon = STEP_M / (111320 * Math.cos(rad((y0 + y1) / 2)));
const candidates = [];
for (let lat = y0; lat <= y1 + 1e-9; lat += dLat) {
  for (let lon = x0; lon <= x1 + 1e-9; lon += dLon) candidates.push([lon, lat]);
}
console.log(`[情景] 候选点 ${candidates.length} 个（${STEP_M} m 网格）→ 逐点重算 …`);
const out = [];
for (const [lon, lat] of candidates) {
  const node = nearestNode(lon, lat);
  const d = dijkstra([node]);
  const tCand = parcelMinutes(d);
  /*
   * ⚠️ **新建一个收储点只会多一个选择，不可能让可达性变差** —— 所以新建后
   * 必须取 `min(现状, 到新点)`，而不是"到新点的时间"。
   * 第一版就是直接用了"到新点的时间"，于是远离候选点的地块全变成"恶化"，
   * 平均值从 4.6 分钟涨到 19 分钟（截图里一眼就看出荒谬）。多源最短路对**独立源**可加，
   * 所以逐地块取 min 与"把新点并进源集合再跑一次 Dijkstra"完全等价。
   */
  const t = tCand.map((v, i) => {
    const b = baseMin[i];
    if (v == null) return b;
    if (b == null) return v;
    return Math.min(b, v);
  });
  const s = stat(t);
  const blind = [];
  const improved = [];
  let gainSum = 0;
  let n = 0;
  t.forEach((v, i) => {
    if (v == null || baseMin[i] == null) return;
    if (v > BLIND_MIN) blind.push(i);
    const gain = baseMin[i] - v;
    if (gain > 0.05) { n++; gainSum += gain; }
    if (gain > 1) improved.push([i, Math.round(gain * 100) / 100]);
  });
  improved.sort((a, b) => b[1] - a[1]);
  out.push({
    lon: Math.round(lon * 1e6) / 1e6,
    lat: Math.round(lat * 1e6) / 1e6,
    node,
    avg_min: Math.round(s.avg * 100) / 100,
    p50_min: Math.round(s.p50 * 100) / 100,
    p90_min: Math.round(s.p90 * 100) / 100,
    max_min: Math.round(s.max * 100) / 100,
    blind_parcels: blind.length,
    blind_ha: Math.round(blind.reduce((a, i) => a + areas[i], 0) * 10) / 10,
    improved_parcels: n,
    improved_ha: Math.round(t.reduce((a, v, i) => a + (v != null && baseMin[i] != null && baseMin[i] - v > 0.05 ? areas[i] : 0), 0) * 10) / 10,
    avg_gain_min: n ? Math.round((gainSum / n) * 100) / 100 : 0,
    // 受影响最大的地块（浏览器里高亮用），最多留 200 个
    improved: improved.slice(0, 200),
  });
}

// ---------- ④ 自检：候选点压在现有收储点上时，改善应该≈0 ----------
{
  const srcLon = poi.filter((p) => SOURCE_KINDS.has(p.properties.kind)).map((p) => p.geometry.coordinates);
  let best = null;
  let bd = Infinity;
  for (const c of out) {
    for (const s of srcLon) {
      const d = hav([c.lon, c.lat], s);
      if (d < bd) { bd = d; best = c; }
    }
  }
  const same = best && bd < STEP_M;
  console.log(`[情景] 自检：距现有收储点最近的候选（${best ? best.lon.toFixed(5) : '—'},${best ? best.lat.toFixed(5) : '—'}，`
    + `${Math.round(bd)} m）平均改善 ${best ? best.avg_gain_min : '—'} 分钟`
    + `${same && best && best.avg_gain_min < 1 ? '  ✓（本来就够近，改善本来就应该很小）' : '  （该候选离现有收储点不近，改善不为 0 属正常）'}`);
}

const file = path.join(OUT, 'scenario.json');
fs.writeFileSync(file, `${JSON.stringify({
  metadata: {
    dataset: '情景推演：新建收储点对可达性的影响（真实路网重算）',
    source: `基于 data/roads.geojson（OSM，ODbL）+ 与 build-access.mjs 同一套口径重算`,
    method: '单源 Dijkstra（候选点吸附到最近路网节点）→ 地块时间 = min(dist + 接驳)，接驳 10 km/h',
    speed_kmh: SPEED,
    offroad_kmh: OFFROAD,
    step_m: STEP_M,
    n_candidates: out.length,
    blind_threshold_min: BLIND_MIN,
    blind_basis: '现状到最近收储点时间的 p90（本地分位数，与等时圈层级同一取法）',
    baseline: {
      n: baseStat.n,
      avg_min: Math.round(baseStat.avg * 100) / 100,
      p50_min: Math.round(baseStat.p50 * 100) / 100,
      p90_min: Math.round(baseStat.p90 * 100) / 100,
      max_min: Math.round(baseStat.max * 100) / 100,
      blind_parcels: baseBlind.length,
      blind_ha: Math.round(baseBlind.reduce((a, i) => a + areas[i], 0) * 10) / 10,
      max_diff_vs_access_json_min: Math.round(maxDiff * 1000) / 1000,
    },
    note: '改善量 = 现状时间 − 新建后时间；`improved` 是改善 > 1 分钟的地块（最多留 200 个，按改善降序）',
  },
  candidates: out,
})}\n`, 'utf8');
const best = [...out].sort((a, b) => b.avg_gain_min * b.improved_parcels - a.avg_gain_min * a.improved_parcels)[0];
console.log(`[情景] 写出 ${file}（${(fs.statSync(file).size / 1024).toFixed(0)} KB）`);
console.log(`[情景] 收益最大的候选（${best.lon},${best.lat}）：平均 ${best.avg_min} 分钟（改善 ${best.avg_gain_min}）、`
  + `盲区 ${best.blind_parcels} 块 / ${best.blind_ha} ha、受影响 ${best.improved_parcels} 块`);
