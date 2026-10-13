#!/usr/bin/env node
/**
 * 地块分层：P2 经营单元 + P4 统计网格（离线预计算）
 *
 * ## 为什么要分层（参照的口径）
 * 欧盟 LPIS 把"**参考地块**（稳定识别单元）"与"**农业地块**（单一作物+单一农户，逐年申报）"分开；
 * 美国用 CLU（Common Land Unit）做稳定单元、作物层每年叠加。共同点是一条铁律：
 * **身份要稳定，作物/轮作/产量是每年挂上去的属性，不要混进 ID。**
 * 所以本文件产出两层稳定的空间单元，作物永远只作为属性出现在事实表里：
 *
 * - **P4 统计网格**（250 m 规则网格）：用于汇总上报。网格编码可复现（按经纬度取整），
 *   与 OGC API – DGGS 的思路一致（网格是"离散全球网格"，换个地区同样算法）。
 * - **P2 经营单元**：把"相邻 + 同作物 + 同一季"的田块聚成一个可管理单元（轮作计划、作业编组）。
 *   本区 501 块 → 几十个单元。
 *
 * - **P1 自然田块**就是 `data/parcels.geojson`（OSM 真实边界），本文件不重复产出，只挂关系。
 *
 * 用法：node tools/build-units.mjs [--out data] [--grid-m 250] [--max-unit-ha 30]
 */
import fs from 'node:fs';
import path from 'node:path';
import { simulate } from '../js/agro.js';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const OUT = path.resolve(opt('out', 'data'));
const GRID_M = Number(opt('grid-m', 250));
const MAX_UNIT_HA = Number(opt('max-unit-ha', 30));
const NEIGHBOR_M = Number(opt('neighbor-m', 30)); // 两块地边界间距 ≤ 30 m 视为相邻（可跨田间道/沟渠）
/**
 * ⚠️ 默认**不要求同作物**。这一点是拿数据打回来的：
 * 本区地块确实是连片马赛克（456/501 的最近邻 ≤5 m、中位 0 m），但**同作物相邻极少** ——
 * 因为作物是逐地块抽的，任意一对相邻地块同作物的概率只有 ~1/7。
 * 如果把它当约束，501 块只能合出 351 个单元（等于没聚合）。
 * 语义上也该如此：**经营单元是"连片的作业片区"（谁的地、能一起安排作业），作物是每年挂上去的属性**
 * —— 这正是 LPIS 把"参考地块（稳定身份）"与"农业地块（逐年申报的作物）"分开的那条铁律。
 * 需要"同作物同季"的同质单元时，用 `--same-crop 1`。
 */
const SAME_CROP = opt('same-crop', '0') === '1';

const R = 6371008.8;
const hav = (a, b) => {
  const p = Math.PI / 180;
  const dLa = (b[1] - a[1]) * p;
  const dLo = (b[0] - a[0]) * p;
  const x = Math.sin(dLa / 2) ** 2 + Math.cos(a[1] * p) * Math.cos(b[1] * p) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
};

// ---------- 读数据 ----------
const parcelsFC = JSON.parse(fs.readFileSync(path.join(OUT, 'parcels.geojson'), 'utf8'));
const parcels = parcelsFC.features;
const weatherFile = JSON.parse(fs.readFileSync(path.join(OUT, 'weather_daily.json'), 'utf8'));
// 作物的归属由模型给出（与界面同源，避免"工具算的作物"和"界面显示的作物"不一致）
const model = simulate({
  seed: 20261013,
  siteName: 'Hallertau · Wolnzach（德国 巴伐利亚）',
  parcels,
  weather: { days: weatherFile.days, vars: weatherFile.vars, source: 'nasa-power' },
  lat: weatherFile.metadata.lat,
  elevation: weatherFile.metadata.elevation_m,
});
const rows = model.parcels; // 与 parcels 顺序一一对应

const centroid = (f) => {
  const r = f.geometry.coordinates[0];
  let x = 0;
  let y = 0;
  const k = r.length - 1 || 1;
  for (let i = 0; i < k; i++) { x += r[i][0]; y += r[i][1]; }
  return [x / k, y / k];
};
const cts = parcels.map(centroid);
const bbox = parcels.map((f) => {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of f.geometry.coordinates[0]) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
});

// ---------- 边距（bbox 近似，用于快速筛掉远距离对） ----------
const gapM = (i, j) => {
  const [ax0, ay0, ax1, ay1] = bbox[i];
  const [bx0, by0, bx1, by1] = bbox[j];
  const dx = Math.max(0, Math.max(bx0 - ax1, ax0 - bx1));
  const dy = Math.max(0, Math.max(by0 - ay1, ay0 - by1));
  if (dx === 0 && dy === 0) return 0; // 包围盒相交
  const lat = (ay0 + ay1) / 2;
  return Math.hypot(dx * 111320 * Math.cos((lat * Math.PI) / 180), dy * 110540);
};

/**
 * 两个多边形之间的最近距离（米）。**必须按"点到线段"算，不能按"顶点到顶点"算**。
 *
 * 第一版用的是顶点间最近距离，结果把真实相邻的地块判成几十米远：两块地共享边界时，
 * 顶点是**错开**的（T 型接头，何况我们还抽稀过），所以"顶点距离" ≠ "多边形距离"。
 * 实测这一处错误让"相邻候选对"从应有的上千对掉到 199 对，聚合几乎失效。
 */
const segDistM = (p, a, b) => {
  const lat = ((a[1] + b[1]) / 2) * Math.PI / 180;
  const mx = 111320 * Math.cos(lat);
  const my = 110540;
  const ax = a[0] * mx;
  const ay = a[1] * my;
  const bx = b[0] * mx;
  const by = b[1] * my;
  const px = p[0] * mx;
  const py = p[1] * my;
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};
const ringGapM = (i, j) => {
  const a = parcels[i].geometry.coordinates[0];
  const b = parcels[j].geometry.coordinates[0];
  let best = Infinity;
  for (let k = 0; k < a.length - 1; k++) {
    for (let l = 0; l < b.length - 1; l++) {
      const d = segDistM(a[k], b[l], b[l + 1]);
      if (d < best) best = d;
      if (best < 0.3) return best;
    }
  }
  for (let k = 0; k < b.length - 1; k++) {
    for (let l = 0; l < a.length - 1; l++) {
      const d = segDistM(b[k], a[l], a[l + 1]);
      if (d < best) best = d;
      if (best < 0.3) return best;
    }
  }
  return best;
};

// ---------- P4：250 m 统计网格（编码可复现） ----------
const lat0 = (bbox[0][1] + bbox[0][3]) / 2;
const dLat = GRID_M / 110540;
const dLon = GRID_M / (111320 * Math.cos((lat0 * Math.PI) / 180));
const gridIdOf = (lon, lat) => `G${GRID_M}-${Math.floor(lon / dLon)}-${Math.floor(lat / dLat)}`;
const gridOf = cts.map(([lon, lat]) => gridIdOf(lon, lat));

/** 网格单元多边形（只输出含地块的网格） */
const gridCells = new Map();
for (let i = 0; i < parcels.length; i++) {
  const gid = gridOf[i];
  if (!gridCells.has(gid)) {
    const [lon, lat] = cts[i];
    const i0 = Math.floor(lon / dLon);
    const j0 = Math.floor(lat / dLat);
    const x0 = i0 * dLon;
    const y0 = j0 * dLat;
    gridCells.set(gid, {
      grid_id: gid,
      bbox: [x0, y0, x0 + dLon, y0 + dLat],
      ring: [[x0, y0], [x0 + dLon, y0], [x0 + dLon, y0 + dLat], [x0, y0 + dLat], [x0, y0]],
    });
  }
}

// ---------- P2：经营单元（相邻 + 同作物 + 同季，面积上限内贪心合并） ----------
/**
 * "同一季"的口径：**同作物 + 同播种年 + 同一旬**，不是"同一天"。
 * 第一版要求播种日完全相同 ⇒ 播种日是逐地块在窗口内抽出来的，几乎不可能相同，
 * 结果 501 块只合并出 396 个单元（等于没聚合）。管理单元的语义是"同一轮作季、可一起安排作业"，
 * 差几天是正常的。
 */
const seasonKey = (r) => {
  const s = (r.seasons ?? [])[0];
  if (!s) return 'perennial';
  const y = s.sow.slice(0, 4);
  const decade = Math.floor(Number(s.sow.slice(6, 8)) / 10);
  return `${r.crop}|${y}|${decade}`;
};
if (opt('diag', '0') === '1') {
  // 诊断：同作物地块之间"边界最近距离"与"质心距离"的分布 —— 阈值该定多少要看数据，不是拍脑袋
  const bins = [5, 10, 20, 30, 60, 100, 200, 500];
  const hGap = new Array(bins.length + 1).fill(0);
  const hCen = new Array(bins.length + 1).fill(0);
  const put = (hist, v) => { for (let b = 0; b < bins.length; b++) if (v <= bins[b]) { hist[b]++; return; } hist[bins.length]++; };
  let sameCrop = 0;
  for (let i = 0; i < parcels.length; i++) {
    for (let j = i + 1; j < parcels.length; j++) {
      if (rows[i].crop !== rows[j].crop) continue;
      sameCrop++;
      put(hGap, ringGapM(i, j));
      put(hCen, hav(cts[i], cts[j]));
    }
  }
  console.log(`同作物地块对 ${sameCrop} 对`);
  const fmt = (h, name) => console.log(`${name}: ${h.map((n, b) => `${b < bins.length ? `≤${bins[b]}m` : `>${bins[bins.length - 1]}m`} ${(n / sameCrop * 100).toFixed(1)}%`).join('  ')}`);
  fmt(hGap, '边界最近距离');
  fmt(hCen, '质心距离    ');
  process.exit(0);
}

const pairs = [];
for (let i = 0; i < parcels.length; i++) {
  for (let j = i + 1; j < parcels.length; j++) {
    if (SAME_CROP && rows[i].crop !== rows[j].crop) continue;
    if (SAME_CROP && seasonKey(rows[i]) !== seasonKey(rows[j])) continue;
    if (gapM(i, j) > NEIGHBOR_M) continue;
    const d = ringGapM(i, j);
    if (d <= NEIGHBOR_M) pairs.push([d, i, j]);
  }
}
pairs.sort((a, b) => a[0] - b[0]);
console.log(`[分层] 相邻候选对 ${pairs.length} 对（间距 ≤ ${NEIGHBOR_M} m，同作物同季）`);

const parent = parcels.map((_, i) => i);
const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
const area = parcels.map((f) => f.properties.area_ha);
const clusterArea = new Map(parcels.map((_, i) => [i, area[i]]));
let merged = 0;
for (const [, i, j] of pairs) {
  const ri = find(i);
  const rj = find(j);
  if (ri === rj) continue;
  const sum = clusterArea.get(ri) + clusterArea.get(rj);
  if (sum > MAX_UNIT_HA) continue; // 面积上限：超了就保持为两个单元（便于管理，而不是越大越好）
  parent[rj] = ri;
  clusterArea.set(ri, sum);
  merged++;
}
const unitOfRoot = new Map();
let nextUnit = 1;
const unitOf = new Array(parcels.length).fill(null);
for (let i = 0; i < parcels.length; i++) {
  const r = find(i);
  if (!unitOfRoot.has(r)) unitOfRoot.set(r, `U${String(nextUnit++).padStart(4, '0')}`);
  unitOf[i] = unitOfRoot.get(r);
}
const unitCount = nextUnit - 1;
{
  const a = [...unitMembersArea()].sort((x, y) => x - y);
  console.log(`[分层] 经营单元 ${unitCount} 个（合并 ${merged} 次，面积上限 ${MAX_UNIT_HA} ha）`);
  console.log(`[分层] 单元面积 ha：p10 ${a[Math.floor(a.length * 0.1)].toFixed(2)} / 中位 ${a[Math.floor(a.length / 2)].toFixed(2)} / p90 ${a[Math.floor(a.length * 0.9)].toFixed(2)} / max ${a[a.length - 1].toFixed(2)}`);
}
function unitMembersArea() {
  const m = new Map();
  for (let i = 0; i < parcels.length; i++) {
    const uid = unitOf[i];
    m.set(uid, (m.get(uid) ?? 0) + area[i]);
  }
  return m.values();
}

// ---------- 输出 ----------
const unitMembers = new Map();
for (let i = 0; i < parcels.length; i++) {
  const uid = unitOf[i];
  if (!unitMembers.has(uid)) unitMembers.set(uid, []);
  unitMembers.get(uid).push(i);
}
const unitFeatures = [];
for (const [uid, members] of unitMembers) {
  const base = rows[members[0]];
  unitFeatures.push({
    type: 'Feature',
    properties: {
      unit_id: uid,
      grid_id: gridOf[members[0]],
      // 单元是空间单元：作物只作为**属性**（主导作物 + 构成），不进身份
      dominant_crop: (() => {
        const by = new Map();
        for (const i of members) by.set(rows[i].crop, (by.get(rows[i].crop) ?? 0) + area[i]);
        return [...by.entries()].sort((a, b) => b[1] - a[1])[0][0];
      })(),
      crop_mix: (() => {
        const by = new Map();
        for (const i of members) by.set(rows[i].cropName, (by.get(rows[i].cropName) ?? 0) + area[i]);
        return [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
          .map(([n, a]) => `${n} ${a.toFixed(1)}ha`).join('、');
      })(),
      fallow_ha: Math.round(members.reduce((a, i) => a + (rows[i].fallow ? area[i] : 0), 0) * 100) / 100,
      n_parcels: members.length,
      area_ha: Math.round(members.reduce((a, i) => a + area[i], 0) * 100) / 100,
      sow_day: base.sowDay,
      // 单元几何 = 成员地块环的集合（相邻，所以看起来是连成一片的）
      member_ids: members.map((i) => parcels[i].properties.id),
    },
    geometry: {
      type: 'MultiPolygon',
      coordinates: members.map((i) => [parcels[i].geometry.coordinates[0]]),
    },
  });
}
unitFeatures.sort((a, b) => (a.properties.unit_id < b.properties.unit_id ? -1 : 1));

fs.writeFileSync(path.join(OUT, 'units.geojson'), JSON.stringify({
  type: 'FeatureCollection',
  metadata: {
    layer: 'P2 经营单元（空间连片的作业片区；作物是属性不是约束）',
    params: { neighbor_m: NEIGHBOR_M, max_unit_ha: MAX_UNIT_HA, same_crop: SAME_CROP },
    source: '派生自 OSM 地块（ODbL）+ 模型作物归属',
    license: 'ODbL-1.0',
    n_units: unitCount,
  },
  features: unitFeatures,
}), 'utf8');

fs.writeFileSync(path.join(OUT, 'grids.geojson'), JSON.stringify({
  type: 'FeatureCollection',
  metadata: {
    layer: `P4 统计网格（${GRID_M} m，按经纬度取整编码，可复现）`,
    grid_m: GRID_M,
    note: 'OGC API – DGGS 的思路：网格是离散全球网格，换地区同一套算法',
    n_cells: gridCells.size,
  },
  features: [...gridCells.values()].map((g) => ({
    type: 'Feature',
    properties: { grid_id: g.grid_id, grid_m: GRID_M },
    geometry: { type: 'Polygon', coordinates: [g.ring] },
  })),
}), 'utf8');

fs.writeFileSync(path.join(OUT, 'units.json'), JSON.stringify({
  metadata: {
    generated_at: new Date().toISOString(),
    grid_m: GRID_M,
    neighbor_m: NEIGHBOR_M,
    max_unit_ha: MAX_UNIT_HA,
    layers: { P1: 'parcels.geojson（自然田块，OSM 真实边界）', P2: 'units.geojson（经营单元）', P4: 'grids.geojson（统计网格）' },
  },
  parcel: parcels.map((f, i) => ({
    parcel_id: f.properties.id,
    unit_id: unitOf[i],
    grid_id: gridOf[i],
  })),
  stats: {
    parcels: parcels.length,
    units: unitCount,
    grids: gridCells.size,
    unit_area_ha: (() => {
      const a = unitFeatures.map((u) => u.properties.area_ha).sort((x, y) => x - y);
      return { p50: a[Math.floor(a.length / 2)], max: a[a.length - 1] };
    })(),
  },
}, null, 1), 'utf8');

console.log(`[分层] 写出 data/units.geojson（${unitFeatures.length} 单元）、data/grids.geojson（${gridCells.size} 格）、data/units.json`);
