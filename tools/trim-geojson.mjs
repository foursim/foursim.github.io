/*
 * Geojson 精简：**坐标精度**与**无用属性**。
 *
 * 起因（审核）：`data/roads.geojson` 459 KB，是启动清单里最大的一块。量了一下才发现
 * 不是"路太曲折"（1576 段一共才 6588 个点，平均 4.2 点/段），而是两件事：
 *   - 坐标是 `11.557973123456789` 这种满精度（≈0.1 nm 级，对一个 250 m 网格的看板毫无意义）；
 *   - 每段都带一份 `source`/`license`（1576 份重复的授权字符串）。
 *
 * 规则（宁可保守）：
 *   - 坐标只保留 **6 位小数**（≈0.11 m）—— 在 z16 上是亚像素，肉眼与后续计算都无感；
 *   - 只删**确认没人读**的属性（用 `properties.xxx` 全仓搜过；`highway`/`name` 有功能依赖，保留）；
 *     授权与来源**上移到顶层 `metadata`**（ODbL 要求署名，不能一删了之）。
 *
 * 跑法：npm run trim:geojson（已接进 data:all，紧跟 data:roads 之后）
 */
import fs from 'node:fs';
import path from 'node:path';

const DEC = 6; // 约 0.11 m

/** 每个文件的配置：删哪些属性（其余一律保留） */
const PLAN = {
  'data/roads.geojson': { drop: ['id', 'surface', 'source', 'license'], lift: ['source', 'license'] },
  /*
   * 地块只做**坐标精度**：`id/landuse/area_ha/seq/crop_source` 都被离线管线读（fetch-data / build-units），
   * 少一个就会让 `data:*` 那串命令悄悄算错 —— 精简属性要按"谁在读"决定，不能按"看起来没用"决定。
   */
  'data/parcels.geojson': { checkArea: true },
};

/*
 * 面积自检（**同一公式前后比**）：几何面积与 `properties.area_ha` 本来就差 0.5%（中位）/6.9%（最大），
 * 所以"拿几何面积去对 area_ha"是假判据。真正要保证的是：**精简让面积变了多少**。
 * 同一个近似公式作用在前后两份坐标上，近似误差自己抵消，剩下的就是舍入带来的真实变化。
 */
function ringArea(ring) {
  const lat0 = ring.reduce((a, p) => a + p[1], 0) / ring.length;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const pts = ring.map((p) => [p[0] * k, p[1]]);
  let sum = 0;
  for (let i = 0; i < pts.length - 1; i++) sum += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1];
  return Math.abs(sum) / 2;
}
function featArea(ft) {
  const g = ft.geometry;
  const rings = g.type === 'Polygon' ? g.coordinates : g.coordinates.flat();
  return rings.reduce((a, r) => a + ringArea(r), 0);
}

const round = (v, d) => Number(Number(v).toFixed(d));

function walkCoords(c, fn) {
  if (typeof c[0] === 'number') { fn(c); return; }
  for (const x of c) walkCoords(x, fn);
}

const files = Object.keys(PLAN);
let before = 0;
let after = 0;
for (const f of files) {
  if (!fs.existsSync(f)) { console.log(`跳过（不存在）：${f}`); continue; }
  const raw = fs.readFileSync(f, 'utf8');
  const g = JSON.parse(raw);
  before += Buffer.byteLength(raw);

  let nFeat = 0;
  let nPts = 0;
  let maxDArea = 0;
  for (const ft of g.features) {
    nFeat++;
    const a0 = PLAN[f].checkArea ? featArea(ft) : 0;
    // 坐标：只保留 DEC 位小数
    walkCoords(ft.geometry.coordinates, (pt) => {
      pt[0] = round(pt[0], DEC);
      pt[1] = round(pt[1], DEC);
      if (pt.length > 2) pt[2] = round(pt[2], DEC);
      nPts++;
    });
    if (PLAN[f].checkArea && a0 > 0) maxDArea = Math.max(maxDArea, Math.abs(featArea(ft) - a0) / a0);
    // 属性：删掉没人读的；被删的常量汇总到 metadata（署名不丢）
    for (const k of PLAN[f].drop ?? []) {
      if (!ft.properties || !(k in ft.properties)) continue;
      // 恒定署名（source/license）上移到 metadata：ODbL 要求署名，不能一删了之；
      // 逐要素变化的（id/surface）直接删 —— 抬上去会被误读成"文件的字段"
      if (PLAN[f].lift?.includes(k)) {
        g.metadata ??= {};
        g.metadata.attribution ??= {};
        g.metadata.attribution[k] ??= ft.properties[k];
      }
      delete ft.properties[k];
    }
  }
  const out = JSON.stringify(g);
  fs.writeFileSync(f, `${out}\n`);
  after += Buffer.byteLength(out);
  if (PLAN[f].checkArea) {
    // 舍入 6 位（≈0.11 m）对 2 ha 地块的面积影响远小于 0.02%；超了就是"精简把形状改了"
    const ok = maxDArea <= 2e-4;
    console.log(`  面积自检：最大变化 ${(maxDArea * 100).toFixed(4)}%（阈值 0.02%）${ok ? ' OK' : ' ✗ 超阈值'}`);
    if (!ok) process.exitCode = 1;
  }
  console.log(`${f}: ${nFeat} 个要素 / ${nPts} 个点 · ${(Buffer.byteLength(raw) / 1024).toFixed(1)} KB → ${(Buffer.byteLength(out) / 1024).toFixed(1)} KB`);
}
console.log(`合计：${(before / 1024).toFixed(1)} KB → ${(after / 1024).toFixed(1)} KB（省 ${(100 - (after / before) * 100).toFixed(1)}%）`);
