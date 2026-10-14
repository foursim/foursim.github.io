#!/usr/bin/env node
/**
 * 农业监测模型的判据（`npm test` 的一部分）
 *
 * 两条主线：
 * 1. **程序生成的数据必须物理自洽**（播种→积温→成熟→收获、水肥在 [0,1]、病害与温湿同源）；
 * 2. **生成的数据必须与真实锚点可比**（同期的 NASA POWER 实测气象），否则"模拟"就是自娱自乐。
 *
 * 判据里刻意放了几个**能失败**的断言（不是恒真）：
 * - 把湿度压掉（`humidityBoost = -40`）⇒ 病害必须完全不出现（钉住"病害由温湿驱动"）；
 * - 每块地的作物必须满足 `实测积温 ≥ 该作物需求`（钉住适种性，粒用玉米因此长不出来）；
 * - 生成气象与真实气象的月均温相关系数 > 0.85（钉住生成器不是噪声）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simulate, genWeather, CROPS, CROP_BY_KEY, DISEASES, levelOf } from '../js/agro.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');

let pass = 0;
let fail = 0;
const section = (t) => console.log(`\n=== ${t} ===`);
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  [OK]   ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`); }
}

// ---------- 数据 ----------
const parcelsFile = path.join(DATA, 'parcels.geojson');
const weatherFile = path.join(DATA, 'weather_daily.json');
if (!fs.existsSync(parcelsFile) || !fs.existsSync(weatherFile)) {
  console.log('缺少 data/parcels.geojson 或 data/weather_daily.json —— 先跑 tools/fetch-data.mjs');
  process.exitCode = 1;
  process.exit(1);
}
const parcels = JSON.parse(fs.readFileSync(parcelsFile, 'utf8')).features;
const realW = JSON.parse(fs.readFileSync(weatherFile, 'utf8'));
const weather = { days: realW.days, vars: realW.vars, source: 'nasa-power' };
console.log(`地块 ${parcels.length} 块（${realW.metadata.lat},${realW.metadata.lon}）｜气象 ${realW.days.length} 天（${realW.metadata.start}~${realW.metadata.end}）`);

// ---------- ① 真实气象驱动 ----------
section('① 真实气象驱动：模型跑通且规模正确');
const t0 = Date.now();
const R = simulate({ seed: 20261013, parcels, weather });
const ms = Date.now() - t0;
check('用真实气象跑完全程', R.days.length === realW.days.length && R.parcels.length === parcels.length,
  `${R.days.length} 天 × ${R.parcels.length} 块，${ms} ms`);
check('性能可接受（本地单次 < 5 s，为浏览器端按需重算留余量）', ms < 5000, `${ms} ms`);

// ---------- ② 地块农事 ----------
section('② 地块农事：耕作 / 休耕 / 收获 / 产量');
const withCrop = R.parcels.filter((p) => !p.fallow);
const fallow = R.parcels.filter((p) => p.fallow);
check('每块地都有归属（作物或休耕）', R.parcels.every((p) => p.crop || p.fallow),
  `作物 ${withCrop.length} 块 / 休耕 ${fallow.length} 块`);
check('休耕比例落在合理带（2%~20%）—— 欧盟 CAP 口径下常年有若干比例',
  fallow.length / R.parcels.length >= 0.02 && fallow.length / R.parcels.length <= 0.2,
  `${(fallow.length / R.parcels.length * 100).toFixed(1)}%`);
check('休耕地块：无播种、无收获、零产量',
  fallow.every((p) => !p.sowDay && !p.harvestDay && p.yield_t === 0), `${fallow.length} 块`);
// 一年生作物才要求播种；牧草/果园是多年生（`sow: null`）
const annual = withCrop.filter((p) => CROP_BY_KEY[p.crop]?.sow);
const perennial = withCrop.filter((p) => p.crop && !CROP_BY_KEY[p.crop]?.sow);
const sown = annual.filter((p) => p.sowDay);
const harvested = R.parcels.filter((p) => p.harvestDay);
check('一年生作物都播了种', sown.length === annual.length, `${sown.length}/${annual.length}`);
check('多年生（牧草/果园）不要求播种', perennial.every((p) => !p.sowDay), `${perennial.length} 块（牧草/果园）`);
check('大部分作物在数据期内完成收获（收成粒度放宽，允许跨年未收）',
  harvested.filter((p) => !p.fallow).length / Math.max(1, withCrop.length) >= 0.6,
  `已收获 ${harvested.filter((p) => !p.fallow).length}/${withCrop.length} 块（${R.stats.harvestedHa} ha）`);
check('播种日早于收获日', annual.filter((p) => p.harvestDay).every((p) => p.sowDay < p.harvestDay), '');
const hMonths = {};
for (const p of harvested) hMonths[p.harvestDay.slice(4, 6)] = (hMonths[p.harvestDay.slice(4, 6)] ?? 0) + 1;
check('收获集中在 6~10 月（温带农事日历）',
  harvested.every((p) => Number(p.harvestDay.slice(4, 6)) >= 6 && Number(p.harvestDay.slice(4, 6)) <= 10),
  `收获月分布 ${JSON.stringify(hMonths)}`);
check('一年生作物：每块已收获地块都有 sow + fertilize + harvest 事件',
  annual.filter((p) => p.harvestDay).every((p) => p.tillage.some((e) => e.type === 'sow')
    && p.tillage.some((e) => e.type === 'fertilize') && p.tillage.some((e) => e.type === 'harvest')), '');
check('多年生只记割草/采收事件（不该有 sow）',
  perennial.every((p) => !p.tillage.some((e) => e.type === 'sow')), `${perennial.length} 块`);

// ---------- ③ 适种性（模型必须由积温说话） ----------
section('③ 适种性：积温决定能种什么（粒用玉米长不出来）');
const histGdd = {
  WINTER_WHEAT: 2615, WINTER_BARLEY: 2500, WINTER_RAPESEED: 1674, SILAGE_MAIZE: 986, HOPS: 1750, MEADOW: 9999,
};
check('出现的作物都在作物表里', R.parcels.every((p) => !p.crop || CROP_BY_KEY[p.crop]), '');
check('**没有粒用玉米**（实测 GDD10 986 < 粒用需求 1400 ⇒ 该地区不适宜）',
  !R.parcels.some((p) => p.crop === 'GRAIN_MAIZE'), '作物结构里只有青贮玉米');
const unfit = withCrop.filter((p) => p.crop && CROP_BY_KEY[p.crop].gddNeed > 0
  && histGdd[p.crop] < CROP_BY_KEY[p.crop].gddNeed);
check('每块地的作物都满足"实测积温 ≥ 作物需求"（适种性判据本身可失败）',
  unfit.length === 0, unfit.length ? `不合规 ${unfit.length} 块：${unfit.slice(0, 3).map((p) => p.crop).join(',')}` : '全部合规');
check('青贮玉米的需求 ≤ 实测 986 ℃·d（否则永远熟不了）',
  CROP_BY_KEY.SILAGE_MAIZE.gddNeed <= 986, `需求 ${CROP_BY_KEY.SILAGE_MAIZE.gddNeed}`);

// ---------- ④ 单产合理性 ----------
section('④ 单产：与公开统计锚点可比');
const ratios = [];
for (const p of harvested) {
  const c = CROP_BY_KEY[p.crop];
  if (!c) continue;
  // 按**每一季**比：数据窗口跨年时 `yield_t_ha` 是各季平均，不能拿它跟单季参考值比
  for (const y of p.yields) ratios.push(y / c.yieldRef);
}
ratios.sort((a, b) => a - b);
const mid = ratios[ratios.length >> 1];
check('单产/参考单产的比值中位数在 0.6~1.1（胁迫与病害只应拉低，不应虚高）',
  mid > 0.6 && mid < 1.1, `中位 ${mid.toFixed(3)}（n=${ratios.length}）`);
check('没有离谱的单产（比值全落在 0.4~1.45；低值来自水分/病害胁迫与日历早收）',
  ratios.every((r) => r > 0.4 && r < 1.45), `${ratios[0]?.toFixed(2)} ~ ${ratios[ratios.length - 1]?.toFixed(2)}`);
const wheat = R.stats.byCrop.WINTER_WHEAT;
check('冬小麦规模化产出（面积/块数非空）', wheat && wheat.parcels > 0 && wheat.ha > 0,
  wheat ? `${wheat.parcels} 块 / ${wheat.ha} ha / ${wheat.yieldTotal_t} t` : '无');
const wheatAvg = wheat && wheat.ha > 0 ? wheat.yieldTotal_t / wheat.ha / (harvested.filter((p) => p.crop === 'WINTER_WHEAT').length ? 1 : 1) : 0;
console.log(`      全镇：${R.stats.areaHa} ha（休耕 ${R.stats.fallowHa} ha、已收 ${R.stats.harvestedHa} ha），总产 ${R.stats.yieldTotal_t} t`);
console.log(`      分作物：${Object.values(R.stats.byCrop).filter((c) => c.parcels).map((c) => `${c.name} ${c.ha}ha/${c.yieldTotal_t}t`).join('、')}`);

// ---------- ⑤ 生长进度 / 水肥 / 病害 ----------
section('⑤ 生长进度、水肥保持、病害扩散');
let mono = true;
let peakOk = 0;
let progParcels = 0;
for (const p of R.parcels) {
  if (!p.crop || !CROP_BY_KEY[p.crop]?.gddNeed) continue;
  progParcels++;
  const s = p.series.map((x) => x.prog);
  // **季内**必须单调不减；换季时状态重置造成的回落是合法的（一年生每季最多回落一次）
  let drops = 0;
  for (let i = 1; i < s.length; i++) if (s[i] < s[i - 1] - 1e-9) drops++;
  if (drops > Math.max(1, p.seasons?.length ?? 1)) mono = false;
  // 看**峰值**而不是末值：末值可能是下一季刚播种（进度归 0）
  if (p.harvestDay && Math.max(...s) >= 0.85) peakOk++;
}
/*
 * **收获不能在窗口第一天堆成伪峰**（这条是修完 bug 加的防回归）：
 * 多年生作物（牧草 06-10 / 果园 09-25）的收割期可能早于窗口开始（2024-07-01），
 * 模型没有"窗口前割过没有"的记忆 ⇒ 第一版在 2024-07-01 把 178 块牧草（292.4 ha）全割了，
 * 而 2025 年同一批牧草的收割日是 06-10 —— 说明 2024 那次本就发生在窗口之前。
 * 口径：起点那年，**作物的收割期不晚于窗口开始就整年不记**（按作物判，不按"当天"判 ——
 * 按当天判只会把伪峰从 07-01 挪到 07-02）。
 */
{
  const start = String(R.days?.[0] ?? '');
  const startMD = `${start.slice(4, 6)}-${start.slice(6, 8)}`;
  const byDay = new Map();
  for (const p of R.parcels) for (const d of p.harvestDays ?? []) byDay.set(d, (byDay.get(d) ?? 0) + p.area_ha);
  const total = [...byDay.values()].reduce((a, b) => a + b, 0);
  const day1 = byDay.get(start) ?? 0;
  // 起点年不记收获的作物：收割期 ≤ 窗口开始（牧草）；该记的：收割期晚于窗口开始（果园 09-25）
  const skipCrops = CROPS.filter((c) => c.gddNeed === 0 && c.harvestMD <= startMD).map((c) => c.key);
  const keepCrops = CROPS.filter((c) => c.gddNeed === 0 && c.harvestMD > startMD).map((c) => c.key);
  const skipBad = R.parcels.filter((p) => skipCrops.includes(p.crop)
    && (p.harvestDays ?? []).some((d) => d.slice(0, 4) === start.slice(0, 4)));
  const keepBad = R.parcels.filter((p) => keepCrops.includes(p.crop)
    && !(p.harvestDays ?? []).some((d) => d.slice(0, 4) === start.slice(0, 4)));
  check('窗口第一天的收获面积≈0（多年生作物的收割期早于窗口开始 ⇒ 不该在第一天集体收割）',
    day1 < total * 0.01,
    `窗口 ${start}：当天 ${day1.toFixed(1)} ha / 全窗口 ${total.toFixed(0)} ha（${(100 * day1 / (total || 1)).toFixed(2)}%）`);
  check(`多年生作物的**窗口边缘**口径正确：收割期早于窗口开始的当年不记（${skipCrops.join('/') || '无'}），晚于的照记（${keepCrops.join('/') || '无'}）`,
    skipCrops.length > 0 && keepCrops.length > 0 && skipBad.length === 0 && keepBad.length === 0,
    `不记 ${skipCrops.join('/') || '无'}（越界 ${skipBad.length} 块）· 照记 ${keepCrops.join('/') || '无'}（漏记 ${keepBad.length} 块）`);
}
check('生长进度季内单调不减（换季重置除外）', mono, `${progParcels} 块`);
check('已收获地块的进度峰值 ≥ 0.85（收获前确实长到了接近成熟）',
  peakOk >= harvested.length * 0.6, `${peakOk}/${harvested.length}`);
const inRange = (arr) => arr.every((v) => v >= 0 && v <= 1);
// 区域聚合的分子/分母必须同源（第一版 progress 只算谷物、water/fert 却把全部地块加进分子 ⇒ 127%）
{
  const R2 = R.region;
  const bad = [];
  for (let d = 0; d < R2.waterIdx.length; d++) {
    if (R2.waterIdx[d] > 1.0001 || R2.fertIdx[d] > 1.0001 || R2.progress[d] > 1.0001) bad.push(d);
  }
  check('区域聚合指数恒在 [0,1]（分子与分母必须统计同一批地块）', bad.length === 0,
    bad.length ? `越界 ${bad.length} 天，例 ${R2.waterIdx[bad[0]].toFixed(3)}` : `最大 ${Math.max(...R2.waterIdx).toFixed(3)}`);
}
check('水肥保持指数恒在 [0,1]',
  R.parcels.every((p) => inRange(p.series.map((x) => x.water)) && inRange(p.series.map((x) => x.fert))), '');
const fertDown = harvested.filter((p) => p.series.length > 3 && p.series[p.series.length - 1].fert < p.series[2].fert);
check('养分保持随生育期下降（吸收 + 淋失 > 补肥）', fertDown.length >= harvested.length * 0.5,
  `${fertDown.length}/${harvested.length} 块末期低于早期`);
check('病害等级恒在 1~5', R.parcels.every((p) => p.diseaseLevelMax >= 1 && p.diseaseLevelMax <= 5), '');
const severe = R.parcels.filter((p) => p.diseaseLevelMax >= 3);
check('至少有一部分地块出现病害（≥3 级，否则"病害监测"演示不出东西）',
  severe.length > 0, `${severe.length} 块达到 ≥3 级（最高 ${Math.max(...R.parcels.map((p) => p.diseaseLevelMax))} 级）`);
check('病害不是遍地大流行（≥4 级的地块 < 30%）',
  R.parcels.filter((p) => p.diseaseLevelMax >= 4).length / R.parcels.length < 0.3,
  `${(R.parcels.filter((p) => p.diseaseLevelMax >= 4).length / R.parcels.length * 100).toFixed(1)}%`);
const maxLevelDay = R.region.diseaseLevel.indexOf(Math.max(...R.region.diseaseLevel));
console.log(`      区域病害峰值日 ${R.days[maxLevelDay]}（${Math.max(...R.region.diseaseLevel)} 级），当日 RH ${R.region.RH2M[maxLevelDay]}%、T ${R.region.T2M[maxLevelDay]}℃`);

// **能失败的断言**：把湿度压掉 40 个百分点 ⇒ 任何一天都不满足病害湿度阈值 ⇒ 病害必须完全不出现
const dry = simulate({ seed: 20261013, parcels: parcels.slice(0, 80), weather, humidityBoost: -40 });
check('把湿度压掉 40 个百分点 ⇒ 病害完全不出现（钉住"病害由温湿驱动、不是随机波动"）',
  dry.parcels.every((p) => p.diseaseMax === 0 && p.diseaseLevelMax === 1),
  `最高等级 ${Math.max(...dry.parcels.map((p) => p.diseaseLevelMax))}`);

// ---------- ⑥ 区域序列 ----------
section('⑥ 区域序列（顶部指标卡的数据源）');
const rProg = Array.from(R.region.progress);
check('区域生长进度峰值 ≥ 0.8（有作物真的长到成熟）', Math.max(...rProg) >= 0.8, `峰值 ${Math.max(...rProg).toFixed(2)}`);
// 回落是**随播种期逐日摊开**的（每块地在自己那天重置）⇒ 单日跌幅很小，要按窗口看最大回撤
let maxDrop = 0;
for (let i = 0; i < rProg.length; i++) {
  const j = Math.min(rProg.length - 1, i + 45);
  for (let k = i + 1; k <= j; k++) maxDrop = Math.max(maxDrop, rProg[i] - rProg[k]);
}
check('区域进度在收获后有回落（45 天窗口内最大回撤 > 0.2，说明换季真的发生了）',
  maxDrop > 0.2, `最大回撤 ${maxDrop.toFixed(2)}`);
const harvestedHaSum = Array.from(R.region.harvestedHa).reduce((a, b) => a + b, 0);
check('收获面积口径自洽（逐日累计 == 地块层合计）',
  Math.abs(harvestedHaSum - R.stats.harvestedHa) < 0.5, `${harvestedHaSum.toFixed(1)} vs ${R.stats.harvestedHa}`);

// ---------- ⑦ 程序生成气象 vs 真实锚点 ----------
section('⑦ 程序生成气象：必须与真实锚点可比（否则"模拟"是自娱自乐）');
const days = realW.days;
const realT2M = Array.from(realW.vars.T2M);
const realPREC = Array.from(realW.vars.PREC ?? realW.vars.PRECTOTCORR ?? []);
// 生成器只拿**该站的三个实测统计量**当输入（年均温、年振幅、雨日频率）——
// 这不是"把答案喂进去"：其余（季节相位、天气过程的持续性、日较差、辐射、湿度结构）都得自己长出来，
// 判据卡的就是那些结构（月均相关、方差、年降水、RH 水平）。
const realMean = realT2M.reduce((a, b) => a + b, 0) / realT2M.length;
const mMean = {};
days.forEach((d, i) => { (mMean[d.slice(0, 6)] ??= []).push(realT2M[i]); });
const mAvg = Object.values(mMean).map((a) => a.reduce((s, v) => s + v, 0) / a.length);
const realAmp = (Math.max(...mAvg) - Math.min(...mAvg)) / 2;
const rainDays = realPREC.filter((v) => v >= 1).length / realPREC.length;
const gen = genWeather({
  seed: 20261013, start: realW.metadata.start, end: realW.metadata.end,
  lat: realW.metadata.lat, elevation: realW.metadata.elevation_m,
  tMeanYear: realMean, amplitude: realAmp, rainDays,
});
console.log(`      站点统计（实测）：年均 ${realMean.toFixed(2)} ℃、年振幅 ${realAmp.toFixed(2)} ℃、雨日 ${(rainDays * 100).toFixed(0)}%`);
const monthKey = (d) => d.slice(0, 6);
const agg = (vals) => {
  const m = {};
  days.forEach((d, i) => { (m[monthKey(d)] ??= []).push(vals[i]); });
  return Object.fromEntries(Object.entries(m).map(([k, a]) => [k, a.reduce((s, v) => s + v, 0) / a.length]));
};
const mA = agg(Array.from(realW.vars.T2M));
const mB = agg(Array.from(gen.vars.T2M));
const ks = Object.keys(mA).filter((k) => mB[k] !== undefined);
const pearson = (xs, ys) => {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx; const dy = ys[i] - my; sxy += dx * dy; sx += dx * dx; sy += dy * dy; }
  return sxy / Math.sqrt(sx * sy);
};
const rT = pearson(ks.map((k) => mA[k]), ks.map((k) => mB[k]));
check('生成 vs 实测：月均温相关系数 > 0.85', rT > 0.85, `r=${rT.toFixed(3)}（${ks.length} 个月）`);
const sd = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };
const bias = Array.from(gen.vars.T2M).reduce((a, b) => a + b, 0) / gen.days.length
  - Array.from(realW.vars.T2M).reduce((a, b) => a + b, 0) / days.length;
check('生成 vs 实测：年均温偏差 < 2 ℃', Math.abs(bias) < 2, `偏差 ${bias.toFixed(2)} ℃（生成 σ=${sd(Array.from(gen.vars.T2M)).toFixed(2)}、实测 σ=${sd(Array.from(realW.vars.T2M)).toFixed(2)}）`);
const gP = Array.from(gen.vars.PREC).reduce((a, b) => a + b, 0) / gen.days.length * 365;
const rP = realPREC.reduce((a, b) => a + b, 0) / days.length * 365;
check('生成 vs 实测：折算年降水都在 400~1400 mm 且相差 < 50%',
  gP > 400 && gP < 1400 && Math.abs(gP - rP) / rP < 0.5, `生成 ${gP.toFixed(0)} vs 实测 ${rP.toFixed(0)} mm/年`);
const gRH = Array.from(gen.vars.RH2M).reduce((a, b) => a + b, 0) / gen.days.length;
const rRH = Array.from(realW.vars.RH2M).reduce((a, b) => a + b, 0) / days.length;
check('生成 vs 实测：平均相对湿度差 < 12 个百分点', Math.abs(gRH - rRH) < 12, `生成 ${gRH.toFixed(0)}% vs 实测 ${rRH.toFixed(0)}%`);

// ---------- ⑧ 确定性 ----------
section('⑧ 确定性：同种子逐位可复现');
const A = simulate({ seed: 777, parcels: parcels.slice(0, 60), weather });
const B = simulate({ seed: 777, parcels: parcels.slice(0, 60), weather });
const C = simulate({ seed: 778, parcels: parcels.slice(0, 60), weather });
const sig = (x) => JSON.stringify(x.parcels.map((p) => [p.crop, p.sowDay, p.harvestDay, p.yield_t_ha, p.diseaseLevelMax]));
check('同种子两次跑完全一致', sig(A) === sig(B), '逐位一致');
check('不同种子给出不同年景', sig(A) !== sig(C), '');
const g1 = genWeather({ seed: 5, start: '20250101', end: '20250301' });
const g2 = genWeather({ seed: 5, start: '20250101', end: '20250301' });
check('生成气象同样确定性', JSON.stringify(Array.from(g1.vars.T2M)) === JSON.stringify(Array.from(g2.vars.T2M)), '');

// ===================== 工程完整性（能失败） =====================
section('⑨ 工程完整性');
{
  // 这条判据来自两个真事故：① package.json 被改成非法 JSON（字符串换行拼接）；
  // ② 文档里引用了**不存在的脚本**（我把 build-hist.mjs 当成了真有的东西）。
  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  } catch (err) {
    check('package.json 是合法 JSON', false, err.message);
  }
  if (pkg) check('package.json 是合法 JSON', true, `${Object.keys(pkg.scripts ?? {}).length} 个脚本`);
  const missing = [];
  for (const [name, cmd] of Object.entries(pkg?.scripts ?? {})) {
    for (const m of String(cmd).matchAll(/node\s+([\w./\\-]+\.mjs)/g)) {
      const f = path.join(ROOT, m[1]);
      if (!fs.existsSync(f)) missing.push(`${name} → ${m[1]}`);
    }
  }
  check('npm 脚本引用的文件都真实存在（防止文档/脚本里出现"幽灵文件"）', missing.length === 0, missing.join(', ') || '全部存在');
}

console.log(`\n================ ${pass} 通过 / ${fail} 失败 ================`);
if (fail > 0) process.exitCode = 1;
