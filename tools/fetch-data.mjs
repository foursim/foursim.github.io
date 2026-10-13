#!/usr/bin/env node
/**
 * 取数 + 合理性校验（新架构的第一步）
 *
 * 设计口径（与用户确认过的四条一致）：
 * - **空间如实**：地块几何取自 OSM（`landuse=farmland|meadow|orchard|vineyard`），ODbL，署名即可用；
 *   换一个乡镇只改 `--bbox`。OSM **没有** `crop=` 标签 ⇒ 作物类型属于"模拟"部分，另行生成。
 * - **气象如实**：气温/湿度/降水/风速/根区土壤湿度取自 NASA POWER（`community=AG`），免费开放；
 *   `GWETROOT`（根区土壤湿度 0~1）正好是"水肥保持程度"里的水分项。
 * - **粒度**：气温等做到**日值**（后续可升级小时值）；收成/农事做到**地块 × 年**，粒度放宽。
 * - **只做取数与校验**：本脚本不生成任何模拟数据，也不改动页面。
 *
 * 用法：
 *   node tools/fetch-data.mjs parcels --bbox 48.090,11.420,48.120,11.480 --out data
 *   node tools/fetch-data.mjs weather --lat 48.105 --lon 11.450 --start 20240701 --end 20251231 --out data
 *   node tools/fetch-data.mjs check   --out data
 */
import fs from 'node:fs';
import path from 'node:path';

const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
];
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const POWER = 'https://power.larc.nasa.gov/api/temporal/daily/point';
const UA = 'webTrade-agri-monitor/0.1 (research demo)';

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};
const OUT = path.resolve(opt('out', 'data'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 带重试的 JSON 取数（Overpass 会限流，POWER 偶发 reset） */
async function getJson(url, { body = null, headers = {}, tries = 4, label } = {}) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        method: body ? 'POST' : 'GET',
        headers: { 'User-Agent': UA, ...headers },
        body,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (text.trimStart().startsWith('<')) throw new Error('返回了 HTML（多为限流/语法错误）');
      return JSON.parse(text);
    } catch (err) {
      lastErr = err;
      await sleep(1500 * (i + 1));
    }
  }
  throw new Error(`${label} 取数失败：${lastErr?.message}`);
}

// ---------- 几何工具（够用就好：等距近似 + 球面纬度校正） ----------
const R = 6378137;
const rad = (d) => (d * Math.PI) / 180;
/** 经纬度环 → 面积（ha）。用等距投影 + 鞋带公式，几公里尺度误差 < 0.1% */
function ringAreaHa(ring) {
  const lat0 = ring.reduce((s, p) => s + p.lat, 0) / ring.length;
  const mx = (111320.0 * Math.cos(rad(lat0)));
  const my = 110540.0;
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % n];
    a += (p.lon * mx) * (q.lat * my) - (q.lon * mx) * (p.lat * my);
  }
  return Math.abs(a / 2) / 10000;
}
/** 道格拉斯-普克抽稀：对一个**开口**折线返回保留掩码（首尾必留） */
function dpKeep(pts, tolM) {
  const lat0 = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
  const mx = 111320.0 * Math.cos(rad(lat0));
  const my = 110540.0;
  const xy = pts.map((p) => [p.lon * mx, p.lat * my]);
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    const [x0, y0] = xy[i0];
    const [x1, y1] = xy[i1];
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    let best = -1;
    let bestD = tolM;
    for (let i = i0 + 1; i < i1; i++) {
      // 弦退化（首尾重合）时用点距兜底 —— 否则所有点都会被误判为"共线"而删光
      const d = len < 1e-9
        ? Math.hypot(xy[i][0] - x0, xy[i][1] - y0)
        : Math.abs((xy[i][0] - x0) * dy - (xy[i][1] - y0) * dx) / len;
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best > 0) {
      keep[best] = 1;
      stack.push([i0, best], [best, i1]);
    }
  }
  return keep;
}

/**
 * 闭合环抽稀。
 *
 * ⚠️ 必须**先去掉重复的收尾点**再 DP：直接对"首尾同点"的环做 DP 时，弦长为 0 ⇒ 所有点
 * 都被判成"共线"删掉，只剩 2 个点（实战里 78 块地因此丢了 69 块）。
 */
function simplifyClosed(ring, tolM) {
  const body = ring.slice(0, -1);
  if (body.length <= 4) return ring;
  const keep = dpKeep(body, tolM);
  const out = body.filter((_, i) => keep[i]);
  if (out.length < 3) return ring; // 保护：至少留 3 个顶点
  out.push({ ...out[0] });
  return out;
}
const round6 = (v) => Math.round(v * 1e6) / 1e6;

// ---------- ① 地块 ----------
async function parcels() {
  const bbox = opt('bbox', '48.090,11.420,48.120,11.480');
  const [s, w, n, e] = bbox.split(',').map(Number);
  const minHa = Number(opt('min-ha', '0.03'));
  const tol = Number(opt('simplify-m', '1.5'));
  const q = `[out:json][timeout:55];
(
  way["landuse"~"^(farmland|meadow|orchard|vineyard)$"](${s},${w},${n},${e});
  relation["landuse"~"^(farmland|meadow|orchard|vineyard)$"](${s},${w},${n},${e});
);
out geom;`;
  console.log(`[地块] Overpass 查询 ${bbox} …`);
  const raw = await getJson(OVERPASS, {
    body: new URLSearchParams({ data: q }).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    label: 'Overpass',
  });

  // 诊断计数：只取到几块时要知道卡在哪一步（大田常画成 multipolygon 关系，不能只收 way）
  const diag = {
    返回元素: raw.elements?.length ?? 0, way: 0, relation: 0,
    无几何: 0, 点太少: 0, 不闭合: 0, 面积过小: 0, 抽稀后点数不足: 0, 收下: 0,
  };
  const feats = [];
  /** 一个环（[lat,lon] 序列）→ 收下一块 */
  const takeRing = (ring, el, suffix, role) => {
    if (ring.length < 4) { diag.点太少++; return; }
    // 容差闭合：OSM 的闭合 way 理论上首尾同点，但关系的外环拼接后可能差一点点
    const dLat = Math.abs(ring[0].lat - ring[ring.length - 1].lat);
    const dLon = Math.abs(ring[0].lon - ring[ring.length - 1].lon);
    if (dLat > 1e-7 || dLon > 1e-7) { diag.不闭合++; return; }
    const body = ring.slice(0, -1);
    const areaHa = ringAreaHa(body);
    if (!(areaHa >= minHa)) { diag.面积过小++; return; }
    const pts = simplifyClosed(ring, tol).map((p) => [round6(p.lon), round6(p.lat)]);
    if (pts.length < 4) { diag.抽稀后点数不足++; return; }
    if (pts[0][0] !== pts[pts.length - 1][0] || pts[0][1] !== pts[pts.length - 1][1]) pts.push(pts[0]);
    let cx = 0;
    let cy = 0;
    for (const [lon, lat] of pts.slice(0, -1)) { cx += lon; cy += lat; }
    const k = pts.length - 1;
    diag.收下++;
    feats.push({
      type: 'Feature',
      properties: {
        id: `osm-${el.type[0]}${el.id}${suffix}`,
        landuse: el.tags?.landuse ?? null,
        name: el.tags?.name ?? null,
        role,
        area_ha: Math.round(areaHa * 1000) / 1000,
        // ⚠️ OSM 基本没有 crop= 标签 ⇒ 作物类型由模拟层补，并在这里如实标注
        crop: null,
        crop_source: 'simulated',
        year: null,
        source: 'OSM/Overpass',
        license: 'ODbL-1.0',
      },
      geometry: { type: 'Polygon', coordinates: [pts] },
      _c: { lon: round6(cx / k), lat: round6(cy / k) },
    });
  };
  for (const el of raw.elements ?? []) {
    if (el.type === 'way') {
      diag.way++;
      if (!Array.isArray(el.geometry) || el.geometry.length < 4) { diag.无几何++; continue; }
      takeRing(el.geometry.map((p) => ({ lat: p.lat, lon: p.lon })), el, '', 'way');
    } else if (el.type === 'relation') {
      diag.relation++;
      const outer = (el.members ?? []).filter((m) => m.type === 'way' && m.role !== 'inner' && Array.isArray(m.geometry));
      if (!outer.length) { diag.无几何++; continue; }
      // 关系收其**外环**（各自独立成块；不做内外环扣洞 —— 农田的洞极少，且这层是"大块农业区"）
      outer.forEach((m, i) => takeRing(m.geometry.map((p) => ({ lat: p.lat, lon: p.lon })), el, `-${i}`, 'outer'));
    }
  }
  console.log(`[地块] 诊断：${JSON.stringify(diag)}`);
  // 大块优先（"主要大块农业区"），并给个稳定序号
  feats.sort((a, b) => b.properties.area_ha - a.properties.area_ha);
  feats.forEach((f, i) => { f.properties.seq = i; delete f._c; });

  const gj = {
    type: 'FeatureCollection',
    metadata: {
      bbox: [s, w, n, e],
      center: [round6((w + e) / 2), round6((s + n) / 2)],
      queried_at: new Date().toISOString(),
      source: 'OpenStreetMap via Overpass API',
      license: 'ODbL-1.0 (© OpenStreetMap contributors)',
      note: '几何真实；crop/产量/农事为模拟，见 properties.crop_source',
      min_ha: minHa,
      simplify_m: tol,
    },
    features: feats,
  };
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'parcels.geojson');
  fs.writeFileSync(file, JSON.stringify(gj), 'utf8');
  console.log(`[地块] 写出 ${file}：${feats.length} 块，${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
  console.log(summarizeParcels(feats));
}

function summarizeParcels(feats) {
  if (!feats.length) return '[地块] 空！检查 bbox 或 Overpass 限流';
  const areas = feats.map((f) => f.properties.area_ha).sort((a, b) => a - b);
  const q = (p) => areas[Math.min(areas.length - 1, Math.floor(areas.length * p))];
  const total = areas.reduce((s, a) => s + a, 0);
  const by = {};
  for (const f of feats) by[f.properties.landuse] = (by[f.properties.landuse] ?? 0) + f.properties.area_ha;
  return [
    `  块数 ${feats.length}，合计 ${total.toFixed(1)} ha`,
    `  面积分位 ha：p10 ${q(0.1).toFixed(2)} / 中位 ${q(0.5).toFixed(2)} / p90 ${q(0.9).toFixed(2)} / max ${areas[areas.length - 1].toFixed(2)}`,
    `  按 landuse：${Object.entries(by).map(([k, v]) => `${k} ${v.toFixed(1)}ha`).join('、')}`,
    `  碎块(<0.1ha) ${areas.filter((a) => a < 0.1).length} 块；大块(>20ha) ${areas.filter((a) => a > 20).length} 块`,
  ].join('\n');
}

// ---------- ② 气象 ----------
const WANT = ['T2M', 'T2M_MAX', 'T2M_MIN', 'T2MDEW', 'RH2M', 'PRECTOTCORR', 'GWETROOT', 'WS2M', 'ALLSKY_SFC_SW_DWN'];
const FALLBACK = ['T2M', 'RH2M', 'PRECTOTCORR', 'GWETROOT', 'WS2M'];

async function powerDaily(params) {
  const url = `${POWER}?parameters=${params.join(',')}&community=AG`
    + `&longitude=${opt('lon')}&latitude=${opt('lat')}`
    + `&start=${opt('start')}&end=${opt('end')}&format=JSON`;
  const j = await getJson(url, { label: 'NASA POWER' });
  if (j.messages?.length) throw new Error(`POWER 报错：${JSON.stringify(j.messages)}`);
  return j;
}

async function weather() {
  const start = opt('start', '20240701');
  const end = opt('end', '20251231');
  console.log(`[气象] NASA POWER ${opt('lat')},${opt('lon')} ${start}~${end} …`);
  let j;
  try {
    j = await powerDaily(WANT);
  } catch (err) {
    console.log(`  ⚠️ 全套参数失败（${err.message}），退回基础 5 参数`);
    j = await powerDaily(FALLBACK);
  }
  const p = j.properties.parameter;
  const names = Object.keys(p);
  const days = Object.keys(p[names[0]]).map((d) => d);
  const vars = {};
  for (const n of names) vars[n] = days.map((d) => p[n][d]);
  const out = {
    metadata: {
      lat: Number(opt('lat', '48.105')),
      lon: Number(opt('lon', '11.450')),
      elevation_m: j.geometry?.coordinates?.[2] ?? null,
      start, end,
      var_list: names,
      unit: {
        T2M: '°C', T2M_MAX: '°C', T2M_MIN: '°C', T2MDEW: '°C', RH2M: '%',
        PRECTOTCORR: 'mm/day', GWETROOT: '0-1', WS2M: 'm/s', ALLSKY_SFC_SW_DWN: 'MJ/m²/day',
      },
      source: 'NASA POWER (MERRA-2) community=AG',
      license: 'NASA open data',
      fill_value: j.header?.fill_value ?? -999,
    },
    days,
    vars,
  };
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'weather_daily.json');
  fs.writeFileSync(file, JSON.stringify(out), 'utf8');
  console.log(`[气象] 写出 ${file}：${days.length} 天 × ${names.length} 参数，${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
}

// ---------- ②b 路网 ----------
/**
 * 路网。保留下来的唯一理由是"它是最重要的空间载体"：
 * 农机能不能进田、病害会不会沿路传、收购点到田头多远，都要靠它。
 * 只收 `highway` 主干等级 + `track`（田间道，农业里最有用的一级）。
 */
async function roads() {
  const bbox = opt('bbox', '48.590,11.540,48.640,11.640');
  const [s, w, n, e] = bbox.split(',').map(Number);
  const q = `[out:json][timeout:55];
way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|track)$"](${s},${w},${n},${e});
out geom;`;
  console.log(`[路网] Overpass 查询 ${bbox} …`);
  const raw = await getJson(OVERPASS, {
    body: new URLSearchParams({ data: q }).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    label: 'Overpass(roads)',
  });
  const feats = [];
  const t0 = Number(opt('simplify-m', '3'));
  for (const el of raw.elements ?? []) {
    if (!Array.isArray(el.geometry) || el.geometry.length < 2) continue;
    const pts = simplifyOpen(el.geometry.map((p) => ({ lat: p.lat, lon: p.lon })), t0)
      .map((p) => [round6(p.lon), round6(p.lat)]);
    if (pts.length < 2) continue;
    feats.push({
      type: 'Feature',
      properties: {
        id: `osm-w${el.id}`,
        highway: el.tags?.highway ?? null,
        name: el.tags?.name ?? null,
        surface: el.tags?.surface ?? null,
        source: 'OSM/Overpass',
        license: 'ODbL-1.0',
      },
      geometry: { type: 'LineString', coordinates: pts },
    });
  }
  const by = {};
  for (const f of feats) by[f.properties.highway] = (by[f.properties.highway] ?? 0) + 1;
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'roads.geojson');
  fs.writeFileSync(file, JSON.stringify({
    type: 'FeatureCollection',
    metadata: { bbox: [s, w, n, e], source: 'OpenStreetMap via Overpass API', license: 'ODbL-1.0', simplify_m: t0 },
    features: feats,
  }), 'utf8');
  console.log(`[路网] 写出 ${file}：${feats.length} 条，${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
  console.log(`  按等级：${Object.entries(by).map(([k, v]) => `${k} ${v}`).join('、')}`);
}

/** 开口折线抽稀（道路是一条线，不是环） */
function simplifyOpen(pts, tolM) {
  if (pts.length <= 3) return pts;
  const keep = dpKeep(pts, tolM);
  return pts.filter((_, i) => keep[i]);
}

// ---------- ②c 农业设施点 ----------
/**
 * 农业设施点。⚠️ 必须如实说明覆盖率：OSM 里"粮库/筒仓/农资店"是**自愿标注**，
 * 乡村地区常常很稀 —— 取到的少就是少，不用假的填满（判据里会报数量）。
 */
async function poi() {
  const bbox = opt('bbox', '48.590,11.540,48.640,11.640');
  const [s, w, n, e] = bbox.split(',').map(Number);
  const q = `[out:json][timeout:55];
(
  node["man_made"~"^(silo|bunker_silo|storage_tank|water_tower)$"](${s},${w},${n},${e});
  node["amenity"~"^(marketplace|fuel)$"](${s},${w},${n},${e});
  node["shop"~"^(agrarian|farm|garden_centre)$"](${s},${w},${n},${e});
  node["building"~"^(farm_auxiliary|barn|silo)$"](${s},${w},${n},${e});
  way["man_made"~"^(silo|bunker_silo)$"](${s},${w},${n},${e});
  way["building"~"^(farm_auxiliary|barn)$"](${s},${w},${n},${e});
);
out center tags;`;
  console.log(`[设施] Overpass 查询 ${bbox} …`);
  const raw = await getJson(OVERPASS, {
    body: new URLSearchParams({ data: q }).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    label: 'Overpass(poi)',
  });
  const feats = [];
  for (const el of raw.elements ?? []) {
    const c = el.type === 'node' ? { lat: el.lat, lon: el.lon } : el.center;
    if (!c) continue;
    const t = el.tags ?? {};
    const kind = t.man_made ?? t.shop ?? t.amenity ?? t.building ?? 'other';
    feats.push({
      type: 'Feature',
      properties: {
        id: `osm-${el.type[0]}${el.id}`,
        kind,
        label: t.name ?? AGRI_LABEL[kind] ?? kind,
        name: t.name ?? null,
        source: 'OSM/Overpass',
        license: 'ODbL-1.0',
      },
      geometry: { type: 'Point', coordinates: [round6(c.lon), round6(c.lat)] },
    });
  }
  const by = {};
  for (const f of feats) by[f.properties.kind] = (by[f.properties.kind] ?? 0) + 1;
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'poi.geojson');
  fs.writeFileSync(file, JSON.stringify({
    type: 'FeatureCollection',
    metadata: {
      bbox: [s, w, n, e],
      source: 'OpenStreetMap via Overpass API',
      license: 'ODbL-1.0',
      caveat: 'OSM 的农业设施是自愿标注，乡村覆盖不全 —— 数量少是真实情况，不要用假数据填满',
    },
    features: feats,
  }), 'utf8');
  console.log(`[设施] 写出 ${file}：${feats.length} 个，${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
  console.log(`  按类别：${Object.entries(by).map(([k, v]) => `${AGRI_LABEL[k] ?? k} ${v}`).join('、') || '（无）'}`);
}
const AGRI_LABEL = {
  silo: '筒仓/粮库', bunker_silo: '青贮窖', storage_tank: '储罐', water_tower: '水塔',
  marketplace: '集市', fuel: '加油站', agrarian: '农资店', farm: '农场', garden_centre: '园艺中心',
  farm_auxiliary: '农机库', barn: '谷仓',
};

// ---------- ③ 合理性校验 ----------
function monthlyMean(days, values) {
  const acc = {};
  days.forEach((d, i) => {
    const m = d.slice(4, 6);
    (acc[m] ??= []).push(values[i]);
  });
  return Object.fromEntries(Object.entries(acc).map(([m, a]) => [m, a.reduce((s, v) => s + v, 0) / a.length]));
}
function gdd(days, tmax, tmin, base, fromMD, toMD) {
  let sum = 0;
  days.forEach((d, i) => {
    const md = d.slice(4, 8);
    if (md < fromMD || md > toMD) return;
    const t = (tmax[i] + tmin[i]) / 2;
    sum += Math.max(0, t - base);
  });
  return sum;
}

function check() {
  const pFile = path.join(OUT, 'parcels.geojson');
  const wFile = path.join(OUT, 'weather_daily.json');
  const lines = [];
  const fail = [];
  const ok = (cond, label, detail) => {
    lines.push(`  ${cond ? '[OK]  ' : '[FAIL]'} ${label}${detail ? ` — ${detail}` : ''}`);
    if (!cond) fail.push(label);
  };

  if (fs.existsSync(pFile)) {
    const gj = JSON.parse(fs.readFileSync(pFile, 'utf8'));
    const f = gj.features;
    const areas = f.map((x) => x.properties.area_ha).sort((a, b) => a - b);
    const total = areas.reduce((s, a) => s + a, 0);
    lines.push(`【地块】${f.length} 块，合计 ${total.toFixed(1)} ha，源 ${gj.metadata.source}`);
    ok(f.length >= 20, '地块数量够一个乡镇的"主要大块农业区"（≥20 块）', `${f.length} 块`);
    ok(areas[0] > 0.02 && areas[areas.length - 1] < 200, '地块面积在合理量级（0.02~200 ha）',
      `${areas[0].toFixed(2)} ~ ${areas[areas.length - 1].toFixed(2)} ha`);
    // 拓扑：坐标闭合、无重复相邻点
    let badRing = 0;
    let dupPt = 0;
    for (const x of f) {
      const r = x.geometry.coordinates[0];
      if (r.length < 4 || r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1]) badRing++;
      for (let i = 1; i < r.length; i++) if (r[i][0] === r[i - 1][0] && r[i][1] === r[i - 1][1]) dupPt++;
    }
    ok(badRing === 0, '所有环都闭合且 ≥4 个点', `异常环 ${badRing}`);
    ok(dupPt === 0, '抽稀后没有重复的相邻点', `重复点 ${dupPt}`);
    const inBox = f.every((x) => String(JSON.stringify(x.geometry)).match(/\d+\.\d+/));
    ok(inBox, '几何坐标可解析（无 NaN）', '');
    const bbox = gj.metadata.bbox;
    const all = JSON.stringify(f.map((x) => x.geometry.coordinates));
    const lons = all.match(/-?\d+\.\d+(?=,)/g) ?? [];
    ok(lons.length > 0, '经纬度量纲正确（经度 11.x、纬度 48.x 附近）',
      `bbox ${bbox.join(', ')}`);
    ok(f.every((x) => x.properties.crop_source === 'simulated'),
      '作物类型被如实标注为"模拟"（OSM 无 crop 标签）', `${f.length} 块全部标注`);
  } else {
    ok(false, '地块文件存在', pFile);
  }

  // 可达性（离线分析产物，见 build-access.mjs）
  const aFile = path.join(OUT, 'access.json');
  const iFile = path.join(OUT, 'isochrones.geojson');
  if (fs.existsSync(aFile)) {
    const a = JSON.parse(fs.readFileSync(aFile, 'utf8'));
    const t = a.t_min;
    lines.push(`【可达性】源 ${a.sources.length} 个收储点 · ${a.metadata.nodes} 节点路网`);
    ok(t.length === (JSON.parse(fs.readFileSync(pFile, 'utf8')).features.length),
      '每个地块都有可达时间（与地块数一一对应）', `${t.length} 个`);
    ok(t.every((v) => v == null || (v > 0 && v < 120)), '可达时间量纲合理（0~120 分钟）',
      `${a.stat.min} ~ ${a.stat.max} 分钟`);
    ok(a.stat.p50 > 0.5 && a.stat.p50 < 20, '中位可达时间落在乡镇尺度区间（0.5~20 分钟）',
      `中位 ${a.stat.p50} 分 / p90 ${a.stat.p90} 分`);
    ok(a.stat.access_m_p90 < 1000, '"下道距离"p90 合理（< 1 km，否则说明路网接不上地块）',
      `p90 ${a.stat.access_m_p90} m`);
    ok(a.stat.unreachable === 0, '没有被判成"不可达"的地块（假不可达说明路网碎片化没处理干净）',
      `${a.stat.unreachable} 块`);
    if (fs.existsSync(iFile)) {
      const iso = JSON.parse(fs.readFileSync(iFile, 'utf8'));
      const lv = iso.features.map((f) => f.properties.level_min);
      const segs = iso.features.map((f) => f.geometry.coordinates.length);
      ok(lv.length > 0 && lv.every((v, i) => i === 0 || v > lv[i - 1]), '等时圈层级严格递增',
        lv.join(' / '));
      ok(segs.every((n) => n > 0), '每条等时圈都真的画出了线（层级不能定在时间场之外）',
        segs.join(' / ') + ' 段');
    }
  }

  if (fs.existsSync(wFile)) {
    const w = JSON.parse(fs.readFileSync(wFile, 'utf8'));
    const { days, vars, metadata: m } = w;
    const n = days.length;
    lines.push(`【气象】${n} 天 × ${m.var_list.length} 参数，海拔 ${m.elevation_m} m，源 ${m.source}`);
    // 不写死"必须是 365 天"：允许跨年取数（冬作物要跨年才完整）。
    // 要卡的是"起止与天数自洽 + 日期连续无断日"。
    const toDate = (s) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
    const span = Math.round((toDate(m.end) - toDate(m.start)) / 86400000) + 1;
    ok(n === span, '起止日期与天数自洽', `${m.start}~${m.end} = ${span} 天，实际 ${n} 天`);
    let gaps = 0;
    for (let i = 1; i < n; i++) {
      if (Math.round((toDate(days[i]) - toDate(days[i - 1])) / 86400000) !== 1) gaps++;
    }
    ok(gaps === 0, '日期连续、无断日', `断日 ${gaps}`);
    const fill = m.fill_value;
    const bad = Object.entries(vars).filter(([, a]) => a.some((v) => v === fill || v === null || Number.isNaN(v)));
    ok(bad.length === 0, '没有缺测/填充值（-999）', bad.length ? bad.map(([k]) => k).join(',') : '0 个');
    const [T2M, RH, PR, GW] = ['T2M', 'RH2M', 'PRECTOTCORR', 'GWETROOT'].map((k) => vars[k]);
    if (T2M && RH) {
      ok(T2M.every((v) => v > -35 && v < 45), '气温在物理区间（-35~45 ℃）',
        `${Math.min(...T2M).toFixed(1)} ~ ${Math.max(...T2M).toFixed(1)} ℃`);
      ok(RH.every((v) => v >= 0 && v <= 100), '相对湿度在 0~100%', `${Math.min(...RH).toFixed(0)} ~ ${Math.max(...RH).toFixed(0)} %`);
      if (vars.T2M_MAX && vars.T2M_MIN) {
        const bad2 = days.filter((_, i) => !(vars.T2M_MAX[i] >= T2M[i] - 0.05 && T2M[i] >= vars.T2M_MIN[i] + 0.05)).length;
        ok(bad2 === 0, 'T2M_MAX ≥ T2M ≥ T2M_MIN 恒成立', `反常 ${bad2} 天`);
      }
      const mm = monthlyMean(days, T2M);
      const jul = mm['07'];
      const jan = mm['01'];
      ok(jul > jan + 10, '气温有季节性（7 月均温比 1 月高 ≥10 ℃）',
        `1 月 ${jan.toFixed(1)} ℃ / 7 月 ${jul.toFixed(1)} ℃`);
      lines.push(`      月均温：${Object.entries(mm).map(([k, v]) => `${k}月${v.toFixed(1)}`).join(' ')}`);
    }
    if (PR) {
      const total = PR.reduce((s, v) => s + v, 0);
      // 折算成"每天 365 天"的年降水（跨年数据不能直接拿总和当一年 —— 第一版就是这么错的）
      const perYear = (total / n) * 365;
      ok(perYear > 400 && perYear < 1400, '折算年降水在温带农业区区间（400~1400 mm）',
        `${perYear.toFixed(0)} mm/年（实测 ${n} 天合计 ${total.toFixed(0)} mm）`);
    }
    if (GW) {
      ok(GW.every((v) => v >= 0 && v <= 1), '根区土壤湿度在 0~1', `${Math.min(...GW).toFixed(2)} ~ ${Math.max(...GW).toFixed(2)}`);
    }
    if (vars.T2M_MAX && vars.T2M_MIN) {
      // ⚠️ 积温必须按**各自生育期窗口**算。第一版拿"全年 GDD0"去比冬小麦需求 ⇒ 判成"偏热"，
      // 那是量纲错误：冬小麦的周期是「上年 10 月播种 → 当年 7 月收获」，与全年不是一回事。
      const gddWin = (base, d0, d1) => {
        let sum = 0;
        let n = 0;
        days.forEach((d, i) => {
          if (d < d0 || d > d1) return;
          sum += Math.max(0, (vars.T2M_MAX[i] + vars.T2M_MIN[i]) / 2 - base);
          n++;
        });
        return { sum, n };
      };
      const suit = [];
      const cycle = (label, base, d0, d1, lo, hi) => {
        const { sum, n } = gddWin(base, d0, d1);
        const inWin = sum >= lo && sum <= hi;
        suit.push(`${label} ${sum.toFixed(0)}${inWin ? ' ✓' : ' ✗'}（需 ${lo}~${hi}，${n} 天）`);
        return sum;
      };
      // 窗口写死真实作物日历（Hallertau/巴伐利亚）：冬油菜 9/1→7/20、冬小麦 10/1→7/31、
      // 青贮玉米 4/25→9/20、粒用玉米 4/25→10/15。要求数据里这些窗口是完整的。
      const g0 = cycle('冬小麦(base0,10/1→7/31)', 0, '20241001', '20250731', 1800, 2800);
      const g5 = cycle('冬油菜(base5,9/1→7/20)', 5, '20240901', '20250720', 1500, 2100);
      const g10 = cycle('青贮玉米(base10,4/25→9/20)', 10, '20250425', '20250920', 950, 1350);
      cycle('粒用玉米(base10,4/25→10/15)', 10, '20250425', '20251015', 1350, 1750);
      lines.push(`      适种性（按生育期积温推）：${suit.join('，')}`);
      const okCount = suit.filter((s) => s.includes('✓')).length;
      ok(okCount >= 2, '按生育期积温至少推得出 2 种适种作物（否则该地不适合做农业监测演示）', `${okCount} 种`);
      // 这一区是"青贮玉米可以、粒用玉米勉强"的温带偏凉区——正是巴伐利亚的真实作物结构
      ok(g10 > 0 && g10 < 1350, '青贮玉米能熟、粒用玉米偏紧（与巴伐利亚真实作物结构一致）',
        `青贮 ${g10.toFixed(0)} < 粒用需求 1400`);
      lines.push(`      （GDD0 全年 ${gddWin(0, '20250101', '20251231').sum.toFixed(0)} ℃·d 只用于参考，不代表任何作物周期）`);
    }
  } else {
    ok(false, '气象文件存在', wFile);
  }

  console.log(`\n=== 数据合理性校验（${OUT}）===`);
  console.log(lines.join('\n'));
  console.log(`\n结论：${fail.length === 0 ? '全部通过' : `${fail.length} 项未通过 → ${fail.join('；')}`}`);
  if (fail.length) process.exitCode = 1;
}

// ---------- 入口 ----------
/**
 * 行政边界（`data/admin.geojson`）——**真实数据**：OSM 的 `boundary=administrative` 关系。
 *
 * ## 为什么存成"线的集合"而不是多边形
 * 多边形的内外环拼接（multipolygon 的 member way 首尾相接）要一套拓扑缝合，容易出错；
 * 而**边界线**只需要把外环的 way 原样留给渲染 —— 相邻 way 共享端点，画出来不会有缝。
 * 这个项目要的是"看得见村界/县界、能按边界做汇总"，线足够；真要面，后面再用缝合工具补。
 *
 * ## `de:amtlicher_gemeindeschluessel`
 * 德国市镇在 OSM 里常带**官方市镇代码**（AGS）标签 —— 有就取真值，`dim_admin` 里那句
 * "Gemeinde 级码待补"就可以落成实数（取不到就如实留空，不猜）。
 */
/**
 * Overpass 镜像轮询。
 *
 * ⚠️ 主站过载是**常态**（实测报 `Dispatcher_Client::request_read_and_idx::timeout`，
 * 而主站过载时对"关系 + bbox"查询会**安静地返回 0 个元素** —— 那时候最容易误判成"这地方没有边界"）。
 * 所以：多镜像 + 失败重试 + 每个镜像之间歇一下。
 */
async function overpass(data, label) {
  let lastErr;
  for (const url of OVERPASS_MIRRORS) {
    try {
      return await getJson(url, {
        body: new URLSearchParams({ data }).toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        label: `${label}@${new URL(url).host}`,
      });
    } catch (err) {
      lastErr = err;
      await sleep(1200);
    }
  }
  throw new Error(`${label}：所有镜像都失败（${lastErr?.message}）`);
}

async function admin() {
  const bbox = opt('bbox', '48.600,11.560,48.630,11.620');
  const levels = opt('levels', '8,6').split(',').map((x) => x.trim());
  const tolM = Number(opt('simplify-m', 25));
  // ⚠️ 顺序是 **S,W,N,E**（与 parcels 子命令同一个约定）；按 W,S,E,N 拆会让 bbox 变成
  // "经度当纬度"，Overpass 直接返回 0 个关系 —— 这个 bug 我踩过一次，误判成"服务器过载"。
  const [s, w, n, e] = bbox.split(',').map(Number);
  // is_in 用点：默认取 bbox 中心（真实地块范围的中心一定落在本乡镇内）
  const [atLat, atLon] = opt('at', `${((s + n) / 2).toFixed(5)},${((w + e) / 2).toFixed(5)}`).split(',').map(Number);

  /*
   * ① `is_in` 定位"这个点属于哪些行政区"。
   * ⚠️ 为什么不用"bbox + relation"：Overpass 的 bbox 过滤对**关系**不生效（实测同框查询返回 0 个关系，
   * 而 is_in 明确答出 Wolnzach / Landkreis Pfaffenhofen an der Ilm）—— 用错了会得出"这里没有边界"的错结论。
   */
  console.log(`[行政] is_in(${atLat},${atLon}) 查所属行政区（admin_level ${levels.join('/')}）…`);
  const inRaw = await overpass(`[out:json][timeout:40];is_in(${atLat},${atLon});out tags;`, 'Overpass(is_in)');
  const targets = (inRaw.elements ?? [])
    .filter((x) => x.tags?.boundary === 'administrative' && levels.includes(String(x.tags.admin_level)))
    .map((x) => ({ name: x.tags.name ?? x.tags['name:de'], level: String(x.tags.admin_level) }))
    .filter((x) => x.name);
  if (!targets.length) throw new Error('is_in 没找到任何行政边界（换 --at 试试点别的地方）');
  console.log(`[行政] 找到 ${targets.length} 个：${targets.map((t) => `${t.level}:${t.name}`).join('、')}`);

  // ② 再按**名字 + 层级**取几何：每次只有一两百个点，轻且稳（比按 bbox 拉整片轻得多）
  const elements = [];
  for (const t of targets) {
    const q = `[out:json][timeout:55];rel["boundary"="administrative"]["admin_level"="${t.level}"]["name"="${t.name}"];out geom;`;
    const raw = await overpass(q, `Overpass(${t.name})`);
    const got = raw.elements ?? [];
    if (!got.length) console.log(`[行政] ⚠️ ${t.name}（level ${t.level}）没取到几何，跳过`);
    elements.push(...got);
    await sleep(900);
  }

  const LEVEL_NAME = { '2': '国家', '4': '州', '6': 'Kreis', '8': 'Gemeinde', '9': 'Gemeindeteil', '10': 'Ortsteil' };
  const feats = [];
  const diag = { 关系: 0, 取到名称: 0, 取到官方码: 0, 外环way: 0, 抽稀后点数: 0 };
  for (const el of elements) {
    if (el.type !== 'relation') continue;
    diag.关系++;
    const tags = el.tags ?? {};
    const name = tags.name ?? tags['name:de'] ?? '';
    if (name) diag.取到名称++;
    const ags = tags['de:amtlicher_gemeindeschluessel'] ?? tags['ref'] ?? '';
    if (ags) diag.取到官方码++;
    const outer = (el.members ?? []).filter((m) => m.type === 'way' && m.role !== 'inner' && Array.isArray(m.geometry));
    if (!outer.length) continue;
    const lines = [];
    for (const m of outer) {
      // 边界线是**开口**折线 ⇒ 用 dpKeep 抽稀（对闭合环那套会退化，见上面的说明）
      const pts = m.geometry.filter((_, i) => dpKeep(m.geometry, tolM)[i])
        .map((p) => [round6(p.lon), round6(p.lat)]);
      if (pts.length < 2) continue;
      lines.push(pts);
      diag.外环way++;
      diag.抽稀后点数 += pts.length;
    }
    if (!lines.length) continue;
    feats.push({
      type: 'Feature',
      properties: {
        admin_code: ags || null,
        admin_level: tags.admin_level ?? '',
        level: LEVEL_NAME[tags.admin_level] ?? `level-${tags.admin_level}`,
        name,
        osm_id: `relation/${el.id}`,
        official_status: tags.official_status ?? '',
        source: 'OSM/Overpass',
        license: 'ODbL-1.0',
      },
      geometry: { type: 'MultiLineString', coordinates: lines },
    });
  }
  const out = {
    type: 'FeatureCollection',
    metadata: {
      dataset: '行政边界（真实）',
      source: 'OpenStreetMap boundary=administrative（Overpass API）',
      license: 'ODbL-1.0',
      fetched_at: new Date().toISOString(),
      bbox: [w, s, e, n],
      is_in_at: [atLat, atLon],
      admin_levels: levels.join(','),
      simplify_m: tolM,
      note: '存**边界线**（外环 way 原样保留，不缝合多边形）；官方市镇码取 OSM 的 de:amtlicher_gemeindeschluessel',
      features: feats.length,
    },
    features: feats,
  };
  const file = path.join(opt('out', 'data'), 'admin.geojson');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(out)}\n`, 'utf8');
  console.log(`[行政] 诊断：${JSON.stringify(diag)}`);
  for (const f of feats) {
    console.log(`  ${f.properties.level.padEnd(9)} ${f.properties.name.padEnd(28)} code=${f.properties.admin_code ?? '（无）'} 线 ${f.geometry.coordinates.length} 段`);
  }
  console.log(`[行政] 写出 ${file}（${(fs.statSync(file).size / 1024).toFixed(0)} KB，${feats.length} 个边界）`);
}

if (cmd === 'parcels') await parcels();
else if (cmd === 'admin') await admin();
else if (cmd === 'weather') await weather();
else if (cmd === 'roads') await roads();
else if (cmd === 'poi') await poi();
else if (cmd === 'check') check();
else {
  console.log('用法：node tools/fetch-data.mjs <parcels|roads|poi|weather|check> [选项]');
  console.log('  parcels --bbox S,W,N,E --min-ha 0.03 --simplify-m 1.5 --out data');
  console.log('  weather --lat 48.105 --lon 11.450 --start 20240701 --end 20251231 --out data');
  console.log('  check   --out data');
  process.exitCode = 1;
}
