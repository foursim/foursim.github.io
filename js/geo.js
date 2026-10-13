/**
 * 颜色标度与格式化（GIS 图层的"读图口径"都在这里）。
 *
 * 为什么单独一个文件：图例、地块填充、统计卡、时序曲线**必须用同一份标度** ——
 * 三处各写一遍必然会漂（同一块地在地图上是黄、在图例上是绿），而读图的人第一眼就会看出不对。
 */

/** 顺序色带（低→高），每项 `[值, 颜色]`，之间线性插值 */
const ramp = (stops) => (v) => {
  if (v <= stops[0][0]) return stops[0][1];
  const last = stops[stops.length - 1];
  if (v >= last[0]) return last[1];
  for (let i = 1; i < stops.length; i++) {
    const [v0, c0] = stops[i - 1];
    const [v1, c1] = stops[i];
    if (v >= v0 && v <= v1) return mix(c0, c1, (v - v0) / (v1 - v0));
  }
  return last[1];
};
const hex2rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const rgb2hex = (r) => `#${r.map((x) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, '0')).join('')}`;
function mix(a, b, t) {
  const A = hex2rgb(a);
  const B = hex2rgb(b);
  return rgb2hex([0, 1, 2].map((i) => A[i] + (B[i] - A[i]) * t));
}

/**
 * 变量定义。`spatial: false` 表示"**区域量**，不做地块级着色"——
 * 气温就属于这一类：OSM 不给我们每个地块的高程，硬编一个地块级温度场就是造假。
 * 所以气温渲染成区域圆 + 指标卡，地块级空间差异只留给真能算出来的量（进度/病害/水肥/作物）。
 */
export const VARIABLES = {
  /* P2 经营单元 / P4 统计网格：颜色只用来**区分单元**（不是数值），所以是哈希色相 */
  unit: {
    label: '经营单元', spatial: true, type: 'categorical', unit: '',
    note: 'P2：空间连片的作业片区（作物是属性，不是约束）；颜色仅用于区分',
  },
  grid: {
    label: '统计网格', spatial: true, type: 'categorical', unit: '',
    note: 'P4：250 m 规则网格（按经纬度取整编码，可复现）',
  },
  crop: {
    label: '作物', spatial: true, type: 'class', unit: '',
    classes: [
      ['WINTER_WHEAT', '冬小麦', '#c8a24a'], ['WINTER_BARLEY', '冬大麦', '#b7c46a'],
      ['WINTER_RAPESEED', '冬油菜', '#e0d050'], ['SILAGE_MAIZE', '青贮玉米', '#5fa83c'],
      ['HOPS', '啤酒花', '#8e6bbf'], ['MEADOW', '牧草', '#7fc08a'],
      ['ORCHARD', '果园', '#d98ba0'], ['FALLOW', '休耕', '#6b6f6b'], [null, '未分类', '#555a55'],
    ],
  },
  progress: {
    label: '生长进度', spatial: true, type: 'seq', unit: '%',
    stops: [[0, '#2c3e50'], [0.3, '#3f7f5f'], [0.6, '#8fbf4a'], [0.85, '#e0c050'], [1, '#f0f4e8']],
    fmt: (v) => `${Math.round(v * 100)}%`,
  },
  disease: {
    label: '病害等级', spatial: true, type: 'class', unit: '级',
    classes: [
      [1, '1 无风险', '#3a7d44'], [2, '2 偏轻', '#9aa83a'], [3, '3 中等', '#e0c050'],
      [4, '4 偏重', '#dd8436'], [5, '5 大流行', '#c0392b'],
    ],
  },
  water: {
    label: '水分保持', spatial: true, type: 'seq', unit: '%',
    stops: [[0, '#8a5a2a'], [0.35, '#c9a23a'], [0.6, '#5fa8c8'], [1, '#2b6f9e']],
    fmt: (v) => `${Math.round(v * 100)}%`,
  },
  fert: {
    label: '养分保持', spatial: true, type: 'seq', unit: '',
    stops: [[0, '#6b4a2a'], [0.4, '#a98a3a'], [0.7, '#6fae4a'], [1, '#2f7d3a']],
    fmt: (v) => `${Math.round(v * 100)}%`,
  },
  tillage: {
    label: '耕作状态', spatial: true, type: 'class', unit: '',
    classes: [
      ['fallow', '休耕', '#6b6f6b'], ['unsown', '未播种', '#4a4f4a'], ['sown', '已播/苗期', '#b08a3a'],
      ['growing', '生长中', '#5fa83c'], ['mature', '近成熟', '#e0c050'], ['harvested', '已收获', '#8a5f2a'],
    ],
  },
  /**
   * 到最近收储点的行驶时间（分钟）——**这是分析量，不是模型生成量**：
   * 由真实路网 + 多源 Dijkstra 离线算出（`tools/build-access.mjs`）。
   * 色带反着来：越近越好（绿），越远越是问题（红）。
   */
  access: {
    label: '到收储点', spatial: true, type: 'seq', unit: '分钟',
    stops: [[1, '#2f7d3a'], [3, '#5fa83c'], [6, '#c8b93a'], [9, '#dd8436'], [13, '#c0392b']],
    fmt: (v) => `${v.toFixed(1)} 分`,
  },
  /**
   * **地块级气温**：区域日气温 + 直减率 ×（地块高程 − 气象站高程）。
   *
   * 这是本轮"数据向真实靠近"最实质的一步：之前只有"区域一个圆 + 一个数"，
   * 理由是"OSM 不给高程，硬编地块级温度场就是造假"。现在高程是**真实 DEM**
   * （Copernicus GLO-90，`tools/fetch-data.mjs elevation`）⇒ 地块间的差异是**推导**出来的，不是编的。
   */
  tempParcel: {
    label: '地块气温', spatial: true, type: 'seq', unit: '℃',
    stops: [[4, '#2c3e90'], [12, '#4a7ec0'], [18, '#5fb37a'], [24, '#e0c050'], [30, '#d4544a']],
    fmt: (v) => `${v.toFixed(1)} ℃`,
  },
  /** 土壤质地（USDA 口径，来自 ISRIC SoilGrids v2.0）；颜色只**区分质地**，不表示优劣 */
  texture: {
    label: '土壤质地', spatial: true, type: 'class', unit: '',
    classes: [
      ['loam', '壤土 loam', '#8a6f3a'], ['clay loam', '黏壤土 clay loam', '#7a5230'],
      ['sandy loam', '砂壤土 sandy loam', '#c8a24a'], ['silt loam', '粉壤土 silt loam', '#a98a5a'],
      ['clay', '黏土 clay', '#5f3f22'], ['sandy clay loam', '砂黏壤土 sandy clay loam', '#b0824a'],
      ['silty clay loam', '粉黏壤土 silty clay loam', '#96683f'], ['sandy clay', '砂黏土 sandy clay', '#8f5a2a'],
      ['silty clay', '粉黏土 silty clay', '#6b4a2a'], ['silt', '粉土 silt', '#d0b98a'],
      ['sand', '砂土 sand', '#e0cfa0'], ['loamy sand', '壤砂土 loamy sand', '#d6bd86'],
    ],
  },
  yield: {
    label: '单产', spatial: true, type: 'seq', unit: 't/ha',
    stops: [[0, '#3a3f3a'], [5, '#5f8f3f'], [15, '#c8b93a'], [30, '#d97a36'], [50, '#e8e8d8']],
    fmt: (v) => (v > 0 ? v.toFixed(1) : '—'),
  },
};

/** 类别色（按 ID 哈希取色相）：用于"看分区边界"，不表示任何数值大小 */
export function categoricalColor(id, l = 52, sat = 62) {
  let h = 0;
  const t = String(id);
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) % 360;
  return `hsl(${h} ${sat}% ${l}%)`;
}

export const colorOf = {
  crop: (v) => VARIABLES.crop.classes.find(([k]) => k === v)?.[2] ?? '#555a55',
  disease: (v) => VARIABLES.disease.classes[Math.min(4, Math.max(0, (v | 0) - 1))][2],
  tillage: (v) => VARIABLES.tillage.classes.find(([k]) => k === v)?.[2] ?? '#555a55',
};
colorOf.progress = ramp(VARIABLES.progress.stops);
colorOf.water = ramp(VARIABLES.water.stops);
colorOf.fert = ramp(VARIABLES.fert.stops);
colorOf.yield = ramp(VARIABLES.yield.stops);
colorOf.access = ramp(VARIABLES.access.stops);
colorOf.unit = (v) => categoricalColor(v ?? 'none');
colorOf.grid = (v) => categoricalColor(v ?? 'none', 46, 48);
colorOf.temp = ramp([[0, '#2c3e90'], [10, '#4a7ec0'], [16, '#5fb37a'], [22, '#e0c050'], [30, '#d4544a'], [38, '#7a1f1f']]);
colorOf.tempParcel = ramp(VARIABLES.tempParcel.stops);
colorOf.texture = (v) => VARIABLES.texture.classes.find(([k]) => k === v)?.[2] ?? '#8b8b8b';

/** 阶标（作物等级/病害等级）与类标的图例项 */
export function legendItems(varKey) {
  const spec = VARIABLES[varKey];
  if (spec.type === 'categorical') return [{ label: spec.note, color: 'transparent' }];
  if (spec.type === 'class') return spec.classes.map(([k, label, color]) => ({ label, color }));
  const stops = spec.stops;
  return stops.map(([v], i) => {
    const prev = i === 0 ? null : stops[i - 1][0];
    const label = prev === null ? `≤ ${spec.fmt ? spec.fmt(v) : v}` : `${spec.fmt ? spec.fmt(prev) : prev}~${spec.fmt ? spec.fmt(v) : v}`;
    return { label, color: colorOf[varKey](v) };
  });
}

/** CSS 渐变（图例条）：直接从同一份 stops 生成，保证与地图同源 */
export function gradientCss(varKey) {
  const spec = VARIABLES[varKey];
  if (spec.type === 'class' || spec.type === 'categorical') return null;
  const [lo] = spec.stops[0];
  const [hi] = spec.stops[spec.stops.length - 1];
  const span = hi - lo || 1;
  const stops = spec.stops.map(([v, c]) => `${c} ${(((v - lo) / span) * 100).toFixed(1)}%`).join(',');
  return `linear-gradient(90deg, ${stops})`;
}

/** 经纬度 bbox（西,南,东,北） */
export function bboxOf(features) {
  let x0 = 180;
  let y0 = 90;
  let x1 = -180;
  let y1 = -90;
  const walk = (c) => {
    if (typeof c[0] === 'number') {
      if (c[0] < x0) x0 = c[0];
      if (c[1] < y0) y0 = c[1];
      if (c[0] > x1) x1 = c[0];
      if (c[1] > y1) y1 = c[1];
    } else c.forEach(walk);
  };
  for (const f of features) walk(f.geometry.coordinates);
  return [[y0, x0], [y1, x1]];
}

export const fmtDay = (ymd) => (ymd ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` : '—');
export const fmtMonthDay = (ymd) => (ymd ? `${Number(ymd.slice(4, 6))}/${Number(ymd.slice(6, 8))}` : '—');
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
