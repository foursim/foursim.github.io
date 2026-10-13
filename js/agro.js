/**
 * 农业监测数据模型（**程序生成**，确定性、无 DOM、浏览器与 node 通用）
 *
 * ## 定位
 *
 * 监测页面里"实时"的那些量（气温/湿度/土壤水分/作物生长进度/病害扩散/水肥保持）
 * **全部由本模块在客户端算出来**，不依赖任何后端与外部接口：
 * - 地块几何是真实的（`data/parcels.geojson`，来自 OSM）；作物/农事/产量是模型生成的；
 * - 若给了真实气象（`data/weather_daily.json`，NASA POWER）→ **让它当驱动**（更真）；
 *   没给 → `genWeather()` 自己生成一套季节/日循环/天气过程都合理的序列。
 *
 * ## 三条口径（都来自"先取数、验证合理性"那一步的结论）
 *
 * 1. **积温按作物生育期窗口算**，不能拿全年 GDD 去比作物需求（第一版就是这么错的）；
 * 2. **粒用玉米在这个纬度/海拔不适宜**（实测 GDD10 986~1028 ℃·d < 需求 1350+）⇒ 作物结构里
 *    只放青贮玉米 —— 模型要能推出"这里该种什么"，而不是硬塞；
 * 3. **病害是时空过程**：先由温湿度算"促病指数"（连续适宜时数累加），再按风向在邻域传播。
 *
 * ## 确定性
 *
 * 所有随机都来自 `Rng(seed)`，且取用顺序固定 ⇒ 同种子逐位可复现（判据钉着）。
 */
import { Rng } from './rng.js';

// ===================== 作物表 =====================
/**
 * `base` 基温、`gddNeed` 生育期所需积温（℃·d）、`yieldRef` 参考单产。
 * 单产锚点取自公开统计（德国）：冬小麦 7.73 t/ha、玉米 9.51 t/ha（粒用）、冬油菜 ≈3.5 t/ha；
 * 青贮玉米按鲜重记（≈45 t/ha），啤酒花按干花（Hallertau ≈1.8 t/ha）。
 */
export const CROPS = [
  { key: 'WINTER_WHEAT', name: '冬小麦', base: 0, sow: ['10-01', '11-05'], harvestMD: '07-25', gddNeed: 2400, yieldRef: 7.7, yieldCv: 0.10, basis: '籽粒', disease: 'FHB' },
  { key: 'WINTER_BARLEY', name: '冬大麦', base: 0, sow: ['09-20', '10-20'], harvestMD: '07-05', gddNeed: 2000, yieldRef: 6.6, yieldCv: 0.10, basis: '籽粒', disease: 'FHB' },
  { key: 'WINTER_RAPESEED', name: '冬油菜', base: 5, sow: ['08-25', '09-20'], harvestMD: '07-15', gddNeed: 1700, yieldRef: 3.6, yieldCv: 0.12, basis: '籽粒', disease: 'SCLEROTINIA' },
  // 青贮玉米的需求定在 950：**这是被实测数据钉出来的** —— Hallertau(463m) 4/25→9/20 的
  // GDD10 只有 986 ℃·d，需求超过它就永远熟不了；而粒用玉米需要 1400+ ⇒ 该地区只能青贮。
  { key: 'SILAGE_MAIZE', name: '青贮玉米', base: 10, sow: ['04-25', '05-15'], harvestMD: '09-20', gddNeed: 950, yieldRef: 45.0, yieldCv: 0.12, basis: '鲜重', disease: 'LEAF_BLIGHT' },
  { key: 'HOPS', name: '啤酒花', base: 5, sow: ['04-01', '04-20'], harvestMD: '09-05', gddNeed: 1300, yieldRef: 1.8, yieldCv: 0.15, basis: '干花', disease: 'DOWNY_MILDEW' },
  // 多年生/草类：**不播种**（`sow: null`），只按农事日历收 —— 判据不要对它们要求 sow 事件
  { key: 'MEADOW', name: '牧草', base: 5, sow: null, harvestMD: '06-10', gddNeed: 0, yieldRef: 9.0, yieldCv: 0.15, basis: '干草', disease: null },
  { key: 'ORCHARD', name: '果园', base: 5, sow: null, harvestMD: '09-25', gddNeed: 0, yieldRef: 12.0, yieldCv: 0.20, basis: '鲜果', disease: 'SCAB' },
];
export const CROP_BY_KEY = Object.fromEntries(CROPS.map((c) => [c.key, c]));

/** 演示区（Hallertau/Wolnzach）的作物结构：按公开统计口径拟，青贮玉米为主、无粒用玉米 */
export const DEFAULT_MIX = [
  { key: 'WINTER_WHEAT', w: 28 },
  { key: 'WINTER_BARLEY', w: 14 },
  { key: 'WINTER_RAPESEED', w: 10 },
  { key: 'SILAGE_MAIZE', w: 24 },
  { key: 'HOPS', w: 8 },
  { key: 'FALLOW', w: 6 }, // 休耕/绿肥（欧盟 CAP 口径下常年有若干比例）
  { key: 'MEADOW', w: 10 },
];

/** 病害参数：`tOpt` 适宜温度区间、`rhMin` 起病湿度、`needHours` 成灾所需适宜小时数 */
export const DISEASES = {
  FHB: { name: '赤霉病', tMin: 12, tOpt: [24, 28], rhMin: 85, needHours: 240, windSpread: 0.25 },
  SCLEROTINIA: { name: '菌核病', tMin: 10, tOpt: [18, 24], rhMin: 80, needHours: 280, windSpread: 0.2 },
  LEAF_BLIGHT: { name: '叶斑病', tMin: 10, tOpt: [20, 26], rhMin: 80, needHours: 220, windSpread: 0.35 },
  DOWNY_MILDEW: { name: '霜霉病', tMin: 8, tOpt: [15, 22], rhMin: 85, needHours: 260, windSpread: 0.4 },
  SCAB: { name: '黑星病', tMin: 8, tOpt: [16, 22], rhMin: 88, needHours: 300, windSpread: 0.3 },
};

// ===================== 工具 =====================
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const DAY = 86400000;
const toDate = (s) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
const mdOf = (ymd) => `${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
function dateList(start, end) {
  const out = [];
  for (let t = toDate(start); t <= toDate(end); t += DAY) {
    const d = new Date(t);
    out.push(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`);
  }
  return out;
}
/** 序号（1-366） */
const doyOf = (ymd) => {
  const d = toDate(ymd);
  return Math.round((d - Date.UTC(Number(ymd.slice(0, 4)), 0, 1)) / DAY) + 1;
};
/** 标准正态（Box-Muller）—— 只用传入的 Rng，保证确定性 */
function gauss(rng) {
  let u = 0;
  while (u === 0) u = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng.next());
}

// ===================== ① 气象：程序生成 =====================
/**
 * 参数化日气象。**不是**随便造噪声，而是三个可验证的结构：
 * 季节正弦（年振幅由纬度/海拔定）+ AR(1) 天气距平 + 降水马尔可夫链，
 * 再由 Hargreaves 估 ET0、单层桶模型算根区土壤湿度。
 */
export function genWeather({ seed = 20261013, start = '20240701', end = '20251231', lat = 48.615, elevation = 463, tMeanYear = 9.6, amplitude = 9.7, rainDays = 0.34 } = {}) {
  const rng = new Rng(seed);
  const days = dateList(start, end);
  const n = days.length;
  const T2M = new Float32Array(n);
  const T2M_MAX = new Float32Array(n);
  const T2M_MIN = new Float32Array(n);
  const RH2M = new Float32Array(n);
  const PREC = new Float32Array(n);
  const WS2M = new Float32Array(n);
  const GWETROOT = new Float32Array(n);
  const ALLSKY = new Float32Array(n);

  /**
   * ⚠️ `tMeanYear` 就是**本地年均温**，这里**不再**另做海拔/纬度订正。
   * 第一版在这里又减了一次递减率（463 m ⇒ −0.98℃）与纬度订正（−0.43℃），结果生成序列
   * 比实测整体低 2.1℃ —— 校准进来的值被自己的"修正"打回去了。
   * 要按海拔推算年均温的调用方，自己把 `tMeanYear` 算好再传进来（`fetch-data.mjs` 的 check 会给出实测值）。
   */
  const tMean = tMeanYear;

  let anom = 0; // AR(1) 天气距平
  let wet = rng.next() < rainDays;
  let soil = 0.68; // 根区有效含水量占比（初值取实测中位 0.68）
  const TAW = 120; // mm 总有效水（壤土）
  for (let i = 0; i < n; i++) {
    const doy = doyOf(days[i]);
    const season = tMean + amplitude * Math.sin((2 * Math.PI * (doy - 111)) / 365);
    anom = 0.82 * anom + gauss(rng) * 2.1;
    const t0 = season + anom;
    // 日较差：晴冷夜大、雨天小
    const spread = wet ? 5.2 : 9.0;
    T2M[i] = t0;
    T2M_MAX[i] = t0 + spread * 0.55;
    T2M_MIN[i] = t0 - spread * 0.45;

    wet = wet ? rng.next() < 0.45 : rng.next() < rainDays;
    let p = 0;
    if (wet) {
      // 湿日降水量：指数分布截断到 0.2~35mm
      p = clamp(-Math.log(1 - rng.next() * 0.97) * 5.2, 0.2, 35);
    }
    PREC[i] = Math.round(p * 10) / 10;

    // 湿度：夜/晨高、雨天高、与温度距平负相关
    const rh = 74 + (wet ? 12 : 0) - (t0 - tMean) * 0.9 + gauss(rng) * 5;
    RH2M[i] = clamp(rh, 30, 100);
    WS2M[i] = clamp(2.1 + Math.abs(gauss(rng)) * 1.4, 0.3, 11);
    // 辐射：天文辐射 × 云量修正
    const latRad = (lat * Math.PI) / 180;
    const decl = 0.409 * Math.sin((2 * Math.PI * doy) / 365 - 1.39);
    const ws = Math.acos(clamp(-Math.tan(latRad) * Math.tan(decl), -1, 1));
    const Ra = ((24 * 60) / Math.PI) * 0.0820 * Math.sqrt(1 + 0.033 * Math.cos((2 * Math.PI * doy) / 365))
      * (ws * Math.sin(latRad) * Math.sin(decl) + Math.cos(latRad) * Math.cos(decl) * Math.sin(ws));
    ALLSKY[i] = Ra * (wet ? 0.32 : 0.62);

    // 单层桶：FAO-56 的简化（灌溉在作物模型里另加）
    const et0 = Math.max(0, 0.0023 * (t0 + 17.8) * Math.sqrt(Math.max(0.1, T2M_MAX[i] - T2M_MIN[i])) * Ra * 0.408);
    soil = soil * TAW + p - et0 * 0.9;
    soil = clamp(soil, 0, TAW);
    GWETROOT[i] = Math.round((soil / TAW) * 1000) / 1000;
  }
  return { days, source: 'generated', vars: { T2M, T2M_MAX, T2M_MIN, RH2M, PREC, WS2M, GWETROOT, ALLSKY_SFC_SW_DWN: ALLSKY } };
}

/**
 * 把外部气象（NASA POWER 的键名是 `PRECTOTCORR`、`ALLSKY_SFC_SW_DWN` 等）归一到模型内部口径。
 *
 * 为什么要这一层：模型只认 `PREC`/`ALLSKY_SFC_SW_DWN` 这类短名，而数据文件用的是 POWER 原生键名；
 * 直接在调用处改名会让"换数据源"变成到处改字符串 —— 归一化只做一次。
 * 缺哪个参数就用保守默认值兜底（并保留 `source`，界面上要能如实显示"这份数据哪来的"）。
 */
export function normalizeWeather(W) {
  const v = W?.vars ?? {};
  const n = (W?.days ?? []).length;
  const flat = (x) => (x ? Array.from(x) : null);
  if (!v.T2M || !n) throw new Error('气象数据缺少 T2M 或 days，无法驱动模型');
  const fill = (val) => { const a = new Float32Array(n); a.fill(val); return a; };
  const arr = (x, dflt) => (x ? Float32Array.from(flat(x)) : fill(dflt));
  return {
    days: W.days,
    source: W.source ?? 'unknown',
    vars: {
      T2M: arr(v.T2M),
      T2M_MAX: arr(v.T2M_MAX ?? v.T2M),
      T2M_MIN: arr(v.T2M_MIN ?? v.T2M),
      RH2M: arr(v.RH2M, 70),
      PREC: arr(v.PREC ?? v.PRECTOTCORR, 0),
      GWETROOT: arr(v.GWETROOT, 0.6),
      WS2M: arr(v.WS2M, 2),
      ALLSKY_SFC_SW_DWN: arr(v.ALLSKY_SFC_SW_DWN, 15),
    },
  };
}

// ===================== ② 地块农事计划 =====================
/**
 * 给每块地定"这一年种什么、什么时候播"。
 *
 * 适种性由**积温**把关（见模块头第 2 条）：`histGdd` 是本地生育期积温，
 * 达不到 `gddNeed` 的作物不进入候选 —— 所以这个纬度/海拔上不会长出粒用玉米。
 */
export function planParcels({ seed = 20261013, parcels, mix = DEFAULT_MIX, histGdd = {
  // 这几个数是**实测锚点**（NASA POWER 2024-07~2025-12 按各自生育期窗口算出来的）：
  WINTER_WHEAT: 2615, WINTER_BARLEY: 2500, WINTER_RAPESEED: 1674, SILAGE_MAIZE: 986, HOPS: 1750, MEADOW: 9999,
}, yearFrom = 2023, yearTo = 2025, dataStart = '20240701', dataEnd = '20251231' } = {}) {
  // 只保留"收获截止日 >= 数据开始 + 30 天"的季（那一季才够看清楚生长过程）
  const minDeadline = (() => {
    const d = new Date(Date.UTC(Number(dataStart.slice(0, 4)), Number(dataStart.slice(4, 6)) - 1, Number(dataStart.slice(6, 8)) + 30));
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  })();
  const rng = new Rng(seed ^ 0x5bd1e995);
  const pool = [];
  for (const m of mix) for (let i = 0; i < m.w; i++) pool.push(m.key);
  const plan = [];
  for (const f of parcels) {
    const area = f.properties?.area_ha ?? 1;
    const lu = f.properties?.landuse;
    let key = null;
    if (lu === 'meadow') key = 'MEADOW';
    else if (lu === 'orchard') key = 'ORCHARD';
    else {
      // 抽一个适种（积温不足的作物直接跳过 —— 这一步就是"数据说话"）
      for (let tries = 0; tries < 12 && key === null; tries++) {
        const cand = pool[rng.nextInt(pool.length)];
        if (cand === 'FALLOW') { key = 'FALLOW'; break; }
        const c = CROP_BY_KEY[cand];
        if (c && histGdd[c.key] >= c.gddNeed) key = cand;
      }
      if (key === null) key = 'MEADOW';
    }
    const crop = CROP_BY_KEY[key] ?? null;
    /**
     * **每一季 = {播种日, 收获截止日}**（不是一个播种日）。
     *
     * 两个坑都在这里堵住：
     * 1. 数据窗口跨年（冬作物的生育期本来就跨年）⇒ 必须按年生成、收获后重置进入下一季；
     * 2. **收获的月日要按播种年归位**：冬小麦 10 月播、**次年** 7 月收。第一版直接比较
     *    `md >= '07-25'`，而 `'10-13' >= '07-25'` 成立 ⇒ **播种当天就被"收获"**，
     *    于是 479 块地全都长不到成熟（区域进度峰值只有 0.47）。
     *    规则：收获月日早于播种窗口起点 ⇒ 收获落在播种年 +1。
     *
     * 另外把"收获截止日落在数据开始前 30 天内"的季剔掉：那一季只露出个尾巴，
     * 留着只会制造"刚进数据就被收"的假象。
     */
    const seasons = [];
    if (crop?.sow) {
      const sowStartMD = crop.sow[0];
      const winter = crop.harvestMD < sowStartMD; // 秋播夏收
      for (let y = yearFrom; y <= yearTo; y++) {
        const a = `${y}-${sowStartMD}`;
        const b = `${y}-${crop.sow[1]}`;
        const t0 = Date.UTC(y, Number(a.slice(5, 7)) - 1, Number(a.slice(8, 10)));
        const t1 = Date.UTC(y, Number(b.slice(5, 7)) - 1, Number(b.slice(8, 10)));
        const t = t0 + Math.floor(rng.next() * ((t1 - t0) / DAY + 1)) * DAY;
        const d = new Date(t);
        const sow = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
        const hy = y + (winter ? 1 : 0);
        const deadline = `${hy}${crop.harvestMD.replace('-', '')}`;
        if (sow > dataEnd) continue;
        if (deadline < minDeadline) continue;
        seasons.push({
          sow,
          deadline,
          early: `${hy}${crop.harvestMD.slice(0, 2)}01`, // 成熟得早也不早于收获月的 1 号
          year: hy,
        });
      }
      seasons.sort((x, y2) => (x.sow < y2.sow ? -1 : 1));
    }
    const sowDays = seasons.map((s) => s.sow);
    plan.push({
      id: f.properties?.id ?? `p${plan.length}`,
      area_ha: area,
      landuse: lu,
      cropKey: key === 'FALLOW' ? null : key, // 休耕不是"作物"：别让它污染"作物表里的作物"这类判据
      cropName: key === 'FALLOW' ? '休耕' : (crop?.name ?? '未分类'),
      fallow: key === 'FALLOW',
      sowDay: sowDays[0] ?? null,
      sowDays,
      seasons, // [{sow, deadline}] 每季的播种日与收获截止日
      // 地块固有差异（土壤质地/管理）——小扰动，让地图不是一片同色
      soilQuality: Math.round(clamp(0.9 + rng.next() * 0.22, 0.8, 1.12) * 1000) / 1000,
      /**
       * 是否做了药剂防治（约 55% 的地块）——**不是装饰**：
       * 没有防治动作时，湿润气候 + 感病作物会让 60% 的地块同时进入 4~5 级，
       * 地图上一片红、既不像真实农情也没有信息量。防治把病害压在 3 级以下，
       * 于是"未防治的地块"才是风险热点（判据：≥4 级地块 < 30%）。
       */
      treated: rng.next() < 0.55,
    });
  }
  return plan;
}

// ===================== ③ 逐日推进 =====================
/**
 * 沿时间轴推进：气象 → 积温 → 生长进度 → 水分/养分保持 → 促病指数 → 风向传播 → 产量。
 *
 * 返回的 `parcels[]` 里每块地带**抽样序列**（默认 7 天一个采样点），供时间轴播放与图表使用；
 * `region` 是全镇逐日的聚合序列（不抽样，用于顶部指标卡与曲线）。
 */
export function simulate({ seed = 20261013, parcels, weather = null, mix = DEFAULT_MIX, start = '20240701', end = '20251231', lat = 48.615, elevation = 463, stepDays = 7, humidityBoost = 0, siteName = '未命名演示区', histGdd = {
  WINTER_WHEAT: 2615, WINTER_BARLEY: 2500, WINTER_RAPESEED: 1674, SILAGE_MAIZE: 986, HOPS: 1750, MEADOW: 9999,
} } = {}) {
  const rng = new Rng(seed);
  const W = normalizeWeather(weather ?? genWeather({ seed, start, end, lat, elevation }));
  const days = W.days;
  const n = days.length;
  const V = W.vars;
  // 播种年要**从数据的上一年**开始生成：秋播作物的播种日往往在数据开始之前（例如数据自 7 月起，
  // 冬小麦却是上一年 10 月播的），漏了它就会整季没有作物。
  const yearFrom = Number(days[0].slice(0, 4)) - 1;
  const yearTo = Number(days[n - 1].slice(0, 4));
  const plan = planParcels({ seed, parcels, mix, histGdd, yearFrom, yearTo, dataStart: days[0], dataEnd: days[n - 1] });

  // 每块地的状态（**按季推进**：到了下一个播种日就重置，进入下一季）
  const S = plan.map((p) => {
    const crop = CROP_BY_KEY[p.cropKey] ?? null;
    return {
      p,
      crop,
      cycle: 0,
      started: !crop?.sow, // 多年生（牧草/果园）从第一天就是"在长"
      gdd: 0,
      water: 0.68,
      fert: 0.75,
      disease: 0,
      diseaseMax: 0,
      harvested: false,
      harvestYear: null, // 多年生用"今年割过了吗"
      harvestDays: [],
      yieldSeasons: [], // 每一季的单产（t/ha）—— 数据窗口跨年时**不能把它们相加当"单产"**
      fertApplied: false,
      tillage: [], // 耕作/农事事件
      series: [], // 抽样序列
    };
  });

  // 病害传播用的粗网格（把乡镇切成 12×12 格，格内聚合、只在邻格传播）
  const gridN = 12;
  const grid = Array.from({ length: gridN * gridN }, () => []);
  const bbox = bounds(parcels);
  S.forEach((s, i) => {
    const f = parcels[i];
    const c = centroid(f);
    const gx = clamp(Math.floor(((c[0] - bbox[0]) / (bbox[2] - bbox[0])) * gridN), 0, gridN - 1);
    const gy = clamp(Math.floor(((c[1] - bbox[1]) / (bbox[3] - bbox[1])) * gridN), 0, gridN - 1);
    grid[gy * gridN + gx].push(i);
  });

  const region = {
    days,
    T2M: new Float32Array(n), RH2M: new Float32Array(n), PREC: new Float32Array(n),
    GWETROOT: new Float32Array(n), progress: new Float32Array(n), disease: new Float32Array(n),
    diseaseLevel: new Float32Array(n), waterIdx: new Float32Array(n), fertIdx: new Float32Array(n),
    harvestedHa: new Float32Array(n), sownHa: new Float32Array(n),
  };
  const sampleIdx = [];
  const snowed = new Set();

  for (let d = 0; d < n; d++) {
    const ymd = days[d];
    const t = V.T2M[d];
    const rh = V.RH2M[d];
    const prec = V.PREC[d];
    const gw = V.GWETROOT[d];
    // 当日风（决定病害往哪个方向扩散）：给一个温和的旋转风，避免"只往一个方向传"
    const windDir = (Math.sin(d / 21) * 0.6 + Math.sin(d / 5.5) * 0.4) * Math.PI;
    const windU = Math.cos(windDir); // 向东分量
    const windV = Math.sin(windDir); // 向北分量

    let progSum = 0;
    let progW = 0;
    let disMax = 0;
    let wSum = 0;
    let fSum = 0;
    let harvestedToday = 0;
    let sownToday = 0;

    /**
     * ① 病害的"跨格传播"：**必须用促病指数当源强，不能用等级**。
     * 等级的分档是 1~5 起步（健康地块也是 1 级）⇒ 拿等级当传染源会让"零病害的邻格"
     * 也天天往外传孢子，于是把湿度压掉也照样发病（那条专门用来证伪的判据就是这么暴露出来的）。
     */
    const gridDisease = grid.map((cell) => {
      let m = 0;
      for (const i of cell) if (S[i].disease > m) m = S[i].disease;
      return m;
    });
    const spreadIn = new Float32Array(S.length);
    for (let gy = 0; gy < gridN; gy++) {
      for (let gx = 0; gx < gridN; gx++) {
        const src = gridDisease[gy * gridN + gx];
        if (src <= 0.02) continue; // 健康格不传染（阈值挡住噪声）
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = gx + dx;
            const ny = gy + dy;
            if (nx < 0 || ny < 0 || nx >= gridN || ny >= gridN) continue;
            // 下风方向权重高（风把孢子带走），源强越大传得越多
            const dirW = 1 + 0.9 * (dx * windU + dy * windV);
            const w = src * 0.05 * Math.max(0.15, dirW);
            for (const i of grid[ny * gridN + nx]) spreadIn[i] = Math.max(spreadIn[i], w);
          }
        }
      }
    }

    for (let i = 0; i < S.length; i++) {
      const s = S[i];
      const c = s.crop;
      // ② 新一季：到了这一季的播种日 ⇒ **重置状态**（积温/病害/养分重来），记一条播种事件
      const season = s.p.seasons ? s.p.seasons[s.cycle] : null;
      if (season && ymd >= season.sow && !s.started) {
        s.started = true;
        s.gdd = 0;
        s.disease = 0;
        s.diseaseMax = 0;
        s.fert = 0.75;
        s.fertApplied = false;
        s.harvested = false;
        // 事件日期写**真实播种日**（可能是数据开始之前），别写成"今天"
        s.tillage.push({ day: season.sow, type: 'sow', crop: c?.name ?? '' });
        if (ymd === season.sow) sownToday += s.p.area_ha;
      }
      // ③ 积温（本季播下之后才开始积累）
      if (c && c.gddNeed > 0 && s.started && !s.harvested) {
        s.gdd += Math.max(0, t - c.base);
      }
      // ③ 生长进度
      const prog = c && c.gddNeed > 0 ? clamp(s.gdd / c.gddNeed, 0, 1) : (c ? 1 : 0);
      // ④ 水分保持（地块土壤质地差异 + 根区湿度）
      s.water = clamp(gw * s.p.soilQuality, 0, 1); // 土壤质地差异可以有，但指数本身不许越界
      // ⑤ 养分保持：基肥一次性投入（播种后），随后被作物吸收、被强降水淋失
      if (s.started && !s.fertApplied && prog > 0.02) {
        s.fert = clamp(s.fert + 0.18, 0.05, 1);
        s.fertApplied = true;
        s.tillage.push({ day: ymd, type: 'fertilize', crop: c?.name ?? '' });
      }
      const uptake = c && c.gddNeed > 0 ? prog * 0.011 : 0.003;
      const leach = prec > 12 ? (prec - 12) * 0.0022 : 0;
      s.fert = clamp(s.fert - uptake - leach, 0.05, 1);
      /**
       * ⑥ 促病指数：只有"温湿同时适宜"才累加。
       *
       * ⚠️ 湿度因子在阈值以下必须**归零**（不是留个小尾巴）：第一版用了 `clamp(..., 0.15, 1)`，
       * 于是"把湿度压掉 40 个百分点"时病害照样能涨起来 —— 那条专门用来证伪的判据就永远过不了。
       * 速率也重新标定过：`needHours` 是"适宜时数累积到多大算一次大流行"，第一版快了约 4 倍
       * （3 天就到 5 级，而赤霉病要连续适温高湿 1~2 周才成灾）。
       */
      if (c && DISEASES[c.disease] && s.started && !s.harvested) {
        const dis = DISEASES[c.disease];
        const rhEff = rh + humidityBoost;
        const tOk = t >= dis.tMin && t <= dis.tOpt[1] + 6;
        const rhFac = rhEff >= dis.rhMin ? clamp((rhEff - dis.rhMin) / 15, 0.15, 1) : 0;
        if (tOk && rhFac > 0) {
          const f = (t >= dis.tOpt[0] && t <= dis.tOpt[1]) ? 1 : 0.55;
          s.disease += (f * 24 * rhFac) / dis.needHours;
        } else {
          s.disease *= 0.985; // 条件不适宜时缓慢消退
        }
        s.disease += spreadIn[i] * (dis.windSpread ?? 0.25);
        // 防治过地块的天花板：药剂把病情压在 3 级（0.48）以下
        if (s.p.treated) s.disease = Math.min(s.disease, 0.34);
        s.disease = clamp(s.disease, 0, 1);
        s.diseaseMax = Math.max(s.diseaseMax, s.disease);
      }
      // ⑦ 收获：积温达标就收，或到了农事日历的硬日子也必须收（晚播青贮玉米不会等到霜前）。
      //    ⚠️ 硬日历必须**以"本季已播种"为前提** —— 第一版漏了这个前提，2024-07-25 那天把所有
      //    10 月才播的冬小麦全收了（收获发生在播种之前），连带 4 条判据失败。
      let harvestedNow = false;
      if (c && !s.p.fallow && s.started && !s.harvested) {
        const md = mdOf(ymd);
        const year = Number(ymd.slice(0, 4));
        const perYear = c.gddNeed === 0; // 多年生（牧草/果园）：到点割一次，不重置整季
        const gddDone = !perYear && prog >= 0.999;
        // 一年生：成熟就收（但不早于本季收获月的 1 号），或到了本季的**收获截止日**必须收。
        // 两个日期都来自 `season`（已按播种年归位），所以不会出现"播种当天就收"。
        const canHarvest = perYear
          ? (md >= c.harvestMD && s.harvestYear !== year)
          : ((gddDone && season && ymd >= season.early) || (season && ymd >= season.deadline));
        if (canHarvest) {
          s.harvestDays.push(ymd);
          s.harvestYear = year;
          /**
           * 产量 = 参考单产（**已是该地区常年平均**）× 土壤质量 × 成熟度 × 胁迫 × 病害损失 × 年景。
           *
           * ⚠️ 惩罚项必须"轻"：`yieldRef` 来自公开统计，本身已经含了常年水分/病害胁迫，
           * 再叠一层重罚会把中位单产压到参考值的 0.5 倍 —— 判据（中位比值应落在 0.6~1.1）直接抓出来。
           */
          const wStress = 0.88 + 0.12 * Math.min(1, s.water / 0.62);
          const fStress = 0.92 + 0.08 * s.fert;
          const dLoss = 1 - 0.25 * s.diseaseMax;
          const maturity = perYear ? 1 : 0.78 + 0.22 * prog;
          const yr = 1 + gauss(rng) * c.yieldCv * 0.6;
          const y = Math.max(0, c.yieldRef * s.p.soilQuality * maturity * wStress * fStress * dLoss * yr);
          s.yieldSeasons.push(Math.round(y * 100) / 100);
          harvestedNow = true;
          s.tillage.push({ day: ymd, type: 'harvest', crop: c.name, t_ha: Math.round(y * 100) / 100 });
          // 一年生：本季结束 ⇒ **必须把 `started` 放回 false**，否则下一个播种日永远触发不了重置
          //（② 的闸门是 `!s.started`），第二季就起不来。
          if (!perYear) { s.harvested = true; s.started = false; s.cycle++; }
        }
      }
      if (harvestedNow) harvestedToday += s.p.area_ha;

      // 区域聚合**只统计需要积温的作物**（牧草/果园常年"长成"，混进来会把季节曲线抹平）。
      // ⚠️ 分子与分母必须用**同一批地块**：第一版的 progress 只算谷物、而 water/fert 把全部地块
      // 都加进分子（990 ha 的分子 ÷ 663 ha 的分母）⇒ 面板上出现"水分保持 127%"这种读数。
      if (c && c.gddNeed > 0) {
        progSum += prog * s.p.area_ha;
        progW += s.p.area_ha;
        wSum += s.water * s.p.area_ha;
        fSum += s.fert * s.p.area_ha;
      }
      const lv = levelOf(s.disease);
      disMax = Math.max(disMax, lv);

      // 抽样序列（stepDays 天一个点，末点必收）
      if (d % stepDays === 0 || d === n - 1) {
        s.series.push({
          d,
          prog: Math.round(prog * 1000) / 1000,
          water: Math.round(s.water * 1000) / 1000,
          fert: Math.round(s.fert * 1000) / 1000,
          dis: Math.round(s.disease * 1000) / 1000,
          lv,
        });
      }
    }

    region.T2M[d] = Math.round(t * 100) / 100;
    region.RH2M[d] = Math.round(rh);
    region.PREC[d] = prec;
    region.GWETROOT[d] = gw;
    region.progress[d] = Math.round((progSum / (progW || 1)) * 1000) / 1000;
    region.disease[d] = Math.round((disMax / 5) * 1000) / 1000;
    region.diseaseLevel[d] = disMax;
    region.waterIdx[d] = Math.round((wSum / (progW || 1)) * 1000) / 1000;
    region.fertIdx[d] = Math.round((fSum / (progW || 1)) * 1000) / 1000;
    region.harvestedHa[d] = harvestedToday;
    region.sownHa[d] = sownToday;
  }

  const parcelsOut = S.map((s) => ({
    id: s.p.id,
    area_ha: s.p.area_ha,
    landuse: s.p.landuse,
    crop: s.p.cropKey,
    cropName: s.p.cropName,
    fallow: s.p.fallow,
    sowDay: s.p.sowDay,
    sowDays: s.p.sowDays,
    seasons: s.p.seasons ?? [],
    harvestDay: s.harvestDays[s.harvestDays.length - 1] ?? null,
    harvestDays: s.harvestDays,
    gdd: Math.round(s.gdd),
    gddNeed: s.crop?.gddNeed ?? 0,
    diseaseMax: Math.round(s.diseaseMax * 1000) / 1000,
    diseaseLevelMax: levelOf(s.diseaseMax),
    yields: s.yieldSeasons, // 每季单产（跨年时会有多季）
    // 单产 = 各季的**平均**（不是相加）；总产 = 各季合计 × 面积
    yield_t_ha: s.yieldSeasons.length
      ? Math.round((s.yieldSeasons.reduce((a, b) => a + b, 0) / s.yieldSeasons.length) * 100) / 100
      : 0,
    yield_t: Math.round(s.yieldSeasons.reduce((a, b) => a + b, 0) * s.p.area_ha * 10) / 10,
    tillage: s.tillage,
    series: s.series,
  }));

  const harvestedParser = parcelsOut.reduce((a, p) => a + p.yield_t, 0);
  const areaHa = parcelsOut.reduce((a, p) => a + p.area_ha, 0);
  return {
    meta: {
      seed, lat, elevation, siteName, histGdd, start: days[0], end: days[n - 1], stepDays,
      weatherSource: W.source,
      cropMix: mix,
      note: '地块几何真实（OSM/ODbL）；作物、农事、产量、病害、水肥为模型生成',
    },
    days,
    weather: { source: W.source, vars: V },
    plan: plan.map((p) => ({ id: p.id, crop: p.cropKey, sowDay: p.sowDay, fallow: p.fallow, soilQuality: p.soilQuality })),
    parcels: parcelsOut,
    region,
    stats: {
      parcels: parcelsOut.length,
      areaHa: Math.round(areaHa * 10) / 10,
      fallowHa: Math.round(parcelsOut.filter((p) => p.fallow).reduce((a, p) => a + p.area_ha, 0) * 10) / 10,
      // 累计收获面积（**按收获事件**计，含同地块的多季；与之配对的是逐日累加序列 `region.harvestedHa`）
      harvestedHa: Math.round(parcelsOut.reduce((a, p) => a + p.area_ha * p.yields.length, 0) * 10) / 10,
      harvestedParcels: parcelsOut.filter((p) => p.yields.length > 0).length,
      harvestEvents: parcelsOut.reduce((a, p) => a + p.yields.length, 0),
      yieldTotal_t: Math.round(harvestedParser * 10) / 10,
      byCrop: Object.fromEntries(CROPS.map((c) => {
        const list = parcelsOut.filter((p) => p.crop === c.key);
        return [c.key, {
          name: c.name,
          ha: Math.round(list.reduce((a, p) => a + p.area_ha, 0) * 10) / 10,
          parcels: list.length,
          yieldTotal_t: Math.round(list.reduce((a, p) => a + p.yield_t, 0) * 10) / 10,
        }];
      })),
    },
  };
}

/** 促病指数 → 气象等级 1~5（1 = 无风险、5 = 大流行） */
export function levelOf(idx) {
  if (!(idx > 0)) return 1;
  if (idx < 0.12) return 1;
  if (idx < 0.28) return 2;
  if (idx < 0.48) return 3;
  if (idx < 0.7) return 4;
  return 5;
}

// ---------- 几何小工具 ----------
function bounds(parcels) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const f of parcels) {
    for (const [x, y] of f.geometry.coordinates[0]) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  return [x0, y0, x1, y1];
}
function centroid(f) {
  const r = f.geometry.coordinates[0];
  let x = 0;
  let y = 0;
  const k = r.length - 1 || 1;
  for (let i = 0; i < k; i++) { x += r[i][0]; y += r[i][1]; }
  return [x / k, y / k];
}
export { bounds, centroid, dateList, doyOf };
