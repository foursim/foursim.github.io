#!/usr/bin/env node
/**
 * 可达性分析（离线预计算，纯 node，无依赖）
 *
 * ## 为什么做这个
 * 路网已经取下来了（1576 条，含田间道），但之前只是**背景画线**。它真正的价值是回答
 * 农业物流里最实际的问题：**这块地到最近的收储点要走多久？谁的田头够不着？**
 * 这也是"GIS 分析"与"画个图"的分界线 —— 前者是算出来的，后者是摆上去的。
 *
 * ## 口径（都写清楚，可被数据打回）
 * - 图：OSM 路段的折点做节点，边长用 haversine，通行速度按 `highway` 等级给（见 SPEED）；
 * - 收储点：OSM 的 `silo / barn / agrarian / marketplace`，吸附到最近的路网节点；
 * - **多源 Dijkstra**：一次算出"到任意收储点"的最短时间（不是对每个点各跑一遍）；
 * - 田间接驳：地块质心 → 最近路网节点按 `OFFROAD` 速度补一段（真实田间道不会精确进到地块里）；
 * - 等时圈：在规则网格上取"到路网+接驳"的时间场，再用 marching squares 抽等值线。
 *
 * ⚠️ 局限（如实说明）：接驳段用直线而非田间实际路径；路网速度是等级经验值而非限速；
 * 因此**只适合看相对格局（谁远谁近），不要当成精确行程时间**。
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const OUT = path.resolve(opt('out', 'data'));
const R = 6371008.8;

// 通行参数来自共享模块（`scenario.mjs` 也用同一份，避免两套算法漂移）
import { SPEED, OFFROAD, SOURCE_KINDS, SNAP_M, CELL } from './road-speeds.mjs';
const LEVELS_ARG = opt('levels', null); // 不给就按数据分位数定（见 ④）

const hav = (a, b) => {
  const [lo1, la1] = a;
  const [lo2, la2] = b;
  const p = Math.PI / 180;
  const dLa = (la2 - la1) * p;
  const dLo = (lo2 - lo1) * p;
  const x = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * p) * Math.cos(la2 * p) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
};

// ---------- 读数据 ----------
const roads = JSON.parse(fs.readFileSync(path.join(OUT, 'roads.geojson'), 'utf8')).features;
const parcels = JSON.parse(fs.readFileSync(path.join(OUT, 'parcels.geojson'), 'utf8')).features;
const poi = JSON.parse(fs.readFileSync(path.join(OUT, 'poi.geojson'), 'utf8')).features;

// ---------- ① 建图 ----------
/**
 * 节点吸附（noding）：OSM 里两条路**几何相交并不等于共享节点** —— 直接按坐标字符串建图，
 * 路网会碎成很多互不连通的碎片（实测 5130 个节点里只有 3568 个能从收储点到达，
 * 120 块地因此被判成"不可达"）。所以要把 6 m 以内的节点合并成同一个节点。
 */
// SNAP_M / CELL 也来自共享模块（可用 --snap-m 覆盖，但默认值不再各写一份）
const SNAP = Number(opt('snap-m', String(SNAP_M)));
const buckets = new Map();
const nodes = [];
const nodeOf = (lon, lat) => {
  const ci = Math.floor(lon / CELL);
  const cj = Math.floor(lat / CELL);
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      const b = buckets.get(`${ci + di},${cj + dj}`);
      if (!b) continue;
      for (const k of b) {
        if (hav(nodes[k], [lon, lat]) <= SNAP) return k;
      }
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
  const sp = SPEED[f.properties.highway] ?? 20;
  const mps = (sp * 1000) / 3600;
  const cs = f.geometry.coordinates;
  for (let i = 1; i < cs.length; i++) {
    const a = nodeOf(cs[i - 1][0], cs[i - 1][1]);
    const b = nodeOf(cs[i][0], cs[i][1]);
    addEdge(a, b, hav(cs[i - 1], cs[i]) / mps);
  }
}
console.log(`[可达性] 路网图：${nodes.length} 节点 / ${adj.reduce((a, e) => a + (e ? e.length : 0), 0) / 2} 边（节点吸附容差 ${SNAP} m）`);
// 连通分量体检：碎片太多说明吸附不够或数据本身断链，必须报出来（否则"不可达"会被误读成真实盲区）
{
  const seen = new Uint8Array(nodes.length);
  let comps = 0;
  let largest = 0;
  for (let s = 0; s < nodes.length; s++) {
    if (seen[s] || !adj[s]) continue;
    comps++;
    let size = 0;
    const stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const v = stack.pop();
      size++;
      for (const [w] of adj[v] ?? []) if (!seen[w]) { seen[w] = 1; stack.push(w); }
    }
    if (size > largest) largest = size;
  }
  console.log(`[可达性] 连通性：${comps} 个连通分量，最大分量 ${largest} 节点（占 ${((largest / nodes.length) * 100).toFixed(1)}%）`);
}

// ---------- ② 收储点：吸附到最近节点，做多源 Dijkstra ----------
const sources = poi.filter((f) => SOURCE_KINDS.has(f.properties.kind)).map((f) => ({
  kind: f.properties.kind,
  label: f.properties.label,
  name: f.properties.name,
  lon: f.geometry.coordinates[0],
  lat: f.geometry.coordinates[1],
}));
const nearestNode = (lon, lat) => {
  let best = -1;
  let bd = Infinity;
  for (let i = 0; i < nodes.length; i++) {
    const d = (nodes[i][0] - lon) ** 2 + (nodes[i][1] - lat) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
};
const srcNode = new Map();
for (const s of sources) srcNode.set(nearestNode(s.lon, s.lat), s);

// 二叉堆（多源 Dijkstra）
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
for (const [v] of srcNode) { dist[v] = 0; push(0, v); }
let visited = 0;
while (heap.length) {
  const [d, v] = pop();
  if (d > dist[v]) continue;
  visited++;
  for (const [w, sec] of adj[v] ?? []) {
    const nd = d + sec;
    if (nd < dist[w]) { dist[w] = nd; push(nd, w); }
  }
}
console.log(`[可达性] Dijkstra：可达节点 ${visited}/${nodes.length}，源 ${sources.length} 个`);

// ---------- ③ 每个地块到最近收储点的时间 ----------
const centroid = (f) => {
  const r = f.geometry.coordinates[0];
  let x = 0;
  let y = 0;
  const k = r.length - 1 || 1;
  for (let i = 0; i < k; i++) { x += r[i][0]; y += r[i][1]; }
  return [x / k, y / k];
};
/**
 * 地块 → 时间：与栅格**同一口径**（对**所有可达路网节点**取 `dist + 接驳` 的最小值）。
 *
 * 一开始用的是"吸附到最近节点、再看那个节点的时间"——那是"走到最近的路，然后开车"的模型，
 * 听起来更贴近农户行为，但路网里存在孤立碎片（OSM 的断链），于是会出现一堆**假"不可达"**
 * （实测 120 块）。改成全局取最小之后不再有假不可达，而且与等时圈栅格口径一致。
 * 代价是"接驳距离"这个信息被吃掉了 —— 所以单独把它记下来（`access_m`），它才是真正的盲区信号。
 */
const tMin = [];
const srcIndex = [];
const accessM = [];
for (const f of parcels) {
  const c = centroid(f);
  let best = Infinity;
  let bi = -1;
  for (let k = 0; k < nodes.length; k++) {
    if (dist[k] === Infinity) continue;
    const t = dist[k] + hav(c, nodes[k]) / ((OFFROAD * 1000) / 3600);
    if (t < best) { best = t; bi = k; }
  }
  tMin.push(Number.isFinite(best) ? Math.round((best / 60) * 100) / 100 : null); // 分钟
  accessM.push(bi >= 0 ? Math.round(hav(c, nodes[bi])) : null);
  srcIndex.push(-1);
}
const finite = tMin.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
const q = (p) => finite[Math.min(finite.length - 1, Math.floor(finite.length * p))];
const stat = {
  n: finite.length,
  unreachable: tMin.filter((v) => !Number.isFinite(v)).length,
  access_m_p50: (() => { const a = accessM.filter((v) => v !== null).sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; })(),
  access_m_p90: (() => { const a = accessM.filter((v) => v !== null).sort((x, y) => x - y); return a[Math.floor(a.length * 0.9)]; })(),
  min: finite[0],
  p50: q(0.5),
  p90: q(0.9),
  max: finite[finite.length - 1],
  avg: Math.round((finite.reduce((a, b) => a + b, 0) / finite.length) * 100) / 100,
};
console.log(`[可达性] 到最近收储点（分钟）：最短 ${stat.min} / 中位 ${stat.p50} / p90 ${stat.p90} / 最远 ${stat.max}（不可达 ${stat.unreachable} 块）`);

// ---------- ④ 等时圈：网格时间场 + marching squares ----------
let x0 = Infinity;
let y0 = Infinity;
let x1 = -Infinity;
let y1 = -Infinity;
for (const f of parcels) for (const [x, y] of f.geometry.coordinates[0]) {
  if (x < x0) x0 = x;
  if (y < y0) y0 = y;
  if (x > x1) x1 = x;
  if (y > y1) y1 = y;
}
const pad = 0.004;
x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
const N = 56;
const grid = [];
for (let j = 0; j <= N; j++) {
  const row = new Float64Array(N + 1);
  const lat = y0 + ((y1 - y0) * j) / N;
  for (let i = 0; i <= N; i++) {
    const lon = x0 + ((x1 - x0) * i) / N;
    // 到任意路网节点的最小时间（含接驳）—— 取全节点最小值，而不是"最近节点"，
    // 这样"离小路近但离大路远"的地方不会被高估
    let best = Infinity;
    for (let k = 0; k < nodes.length; k++) {
      const t = dist[k] + hav([lon, lat], nodes[k]) / ((OFFROAD * 1000) / 3600);
      if (t < best) best = t;
    }
    row[i] = best / 60;
  }
  grid.push(row);
}
/** marching squares：抽某一层的等值线（返回 [ [lon,lat], ... ] 的线段） */
function contour(level) {
  const segs = [];
  const at = (i, j) => grid[j][i];
  const X = (i) => x0 + ((x1 - x0) * i) / N;
  const Y = (j) => y0 + ((y1 - y0) * j) / N;
  const lerp = (a, b, va, vb) => a + ((b - a) * (level - va)) / (vb - va || 1e-9);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const v = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
      const cross = [];
      const edges = [
        [[X(i), Y(j)], [X(i + 1), Y(j)], v[0], v[1]],
        [[X(i + 1), Y(j)], [X(i + 1), Y(j + 1)], v[1], v[2]],
        [[X(i + 1), Y(j + 1)], [X(i), Y(j + 1)], v[2], v[3]],
        [[X(i), Y(j + 1)], [X(i), Y(j)], v[3], v[0]],
      ];
      for (const [p, q2, va, vb] of edges) {
        if ((va < level && vb >= level) || (vb < level && va >= level)) {
          cross.push([lerp(p[0], q2[0], va, vb), lerp(p[1], q2[1], va, vb)]);
        }
      }
      if (cross.length === 2) segs.push(cross);
      else if (cross.length === 4) { segs.push([cross[0], cross[1]], [cross[2], cross[3]]); }
    }
  }
  return segs;
}
{
  let gmin = Infinity;
  let gmax = -Infinity;
  for (const row of grid) for (const v of row) { if (v < gmin) gmin = v; if (v > gmax) gmax = v; }
  console.log(`[可达性] 时间场（分钟）：${gmin.toFixed(2)} ~ ${gmax.toFixed(2)}（网格 ${N + 1}×${N + 1}）`);
}
// 层级：给了就用给的；没给就按**本地区实际时间分布**取分位数 ——
// 写死 15/20 分钟在"全程 ≤13 分钟"的乡镇上永远是 0 段（第一版就是这样）
const LEVELS = LEVELS_ARG
  ? LEVELS_ARG.split(',').map(Number)
  : [0.25, 0.5, 0.75, 0.9].map((p) => Math.round(q(p) * 2) / 2);
console.log(`[可达性] 等时圈层级（分钟）：${LEVELS.join(' / ')}${LEVELS_ARG ? '（指定）' : '（按 p25/p50/p75/p90）'}`);
const isoFeatures = [];
for (const lv of LEVELS) {
  const segs = contour(lv);
  // 每个格子给两条点，合并成一条 MultiLineString（避免 3000 个 Feature 拖慢 Leaflet）
  isoFeatures.push({
    type: 'Feature',
    properties: { level_min: lv },
    geometry: { type: 'MultiLineString', coordinates: segs.map((s) => [[s[0][0], s[0][1]], [s[1][0], s[1][1]]]) },
  });
  console.log(`[可达性] 等时圈 ${lv} 分钟：${segs.length} 段`);
}

// ---------- ⑤ 写文件 ----------
fs.writeFileSync(path.join(OUT, 'access.json'), JSON.stringify({
  metadata: {
    generated_at: new Date().toISOString(),
    speeds_kmh: SPEED, offroad_kmh: OFFROAD,
    note: '接驳段为直线、速度为等级经验值 ⇒ 只看相对格局，不要当精确行程时间',
    source: 'OpenStreetMap via Overpass API',
    license: 'ODbL-1.0',
    nodes: nodes.length,
  },
  sources: sources.map((s, i) => ({ ...s, i })),
  stat,
  levels_min: LEVELS,
  t_min: tMin,      // 分钟，与 parcels.geojson 的 features 顺序一一对应
  access_m: accessM, // 地块质心到最优接入路网节点的直线距离（米）——真实的"下道距离"
  nearest_source: srcIndex,
}, null, 1), 'utf8');
fs.writeFileSync(path.join(OUT, 'isochrones.geojson'), JSON.stringify({
  type: 'FeatureCollection',
  metadata: { levels_min: LEVELS, source: 'OSM 路网 + 多源 Dijkstra（离线预计算）', license: 'ODbL-1.0' },
  features: isoFeatures,
}), 'utf8');
console.log(`[可达性] 写出 data/access.json 与 data/isochrones.geojson`);
