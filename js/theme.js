/**
 * 三套**政企蓝白**视觉方案（临时版本，供选型对比）。
 *
 * ## 为什么用 CSS 变量 + `data-theme`，而不是三份 CSS/三个页面
 * 三份样式必然漂（改了一处忘了另两处），而且组件结构其实完全相同 —— 差别只有颜色与少量阴影。
 * 所以：**结构一份，颜色三份**（`style.css` 里的 `[data-theme="..."]` 块），切换只改 `dataset.theme`。
 * 选型定下来之后，只要删掉不用的两块即可，不存在"回不去"的临时改动。
 *
 * ## 三套方案的口径（都往"政企蓝白"靠，但侧重不同）
 * - **A 政务深蓝**：白底 + 深蓝顶栏/表头，稳重、对比强，像政务门户与监管平台；
 * - **B 科技亮蓝**：浅灰蓝底 + 亮蓝点缀，卡片化、留白多，像政企 SaaS / 数据中台；
 * - **C 指挥大屏**：深蓝底 + 发光蓝，指挥中心大屏风（**不是蓝白**，放进来是给"大屏"这个选项做对照）。
 *
 * ## 地图为什么需要 `mapTokens()`
 * Leaflet 的颜色是**画在 canvas 上**的，吃不到 CSS 变量；所以得把主题色从 CSS 里读出来再传给图层。
 * 切换主题后由 `main.js` 调 `agriMap.setTheme()` 重刷一次图层
 * （只改样式不重建几何 —— 重建几何正是播放卡顿与点击丢失的来源）。
 */

export const THEMES = [
  {
    key: 'gov',
    name: 'A 政务深蓝',
    desc: '白底 + 深蓝顶栏与表头，稳重、对比强 —— 贴近政务门户与监管平台',
  },
  {
    key: 'tech',
    name: 'B 科技亮蓝',
    desc: '浅灰蓝底 + 亮蓝点缀，卡片化、留白多 —— 贴近政企 SaaS / 数据中台',
  },
  {
    key: 'dark',
    name: 'C 指挥大屏',
    desc: '深蓝底 + 发光蓝，指挥中心大屏风（非蓝白，作为对照项）',
  },
];

const LS_KEY = 'agri-monitor-theme';
const DEFAULT_THEME = 'gov';

/** 现在用的是哪套（读 `data-theme`，读不到就回默认） */
export function currentTheme() {
  try {
    const k = document?.documentElement?.dataset?.theme;
    return THEMES.some((t) => t.key === k) ? k : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** 切主题：改 `data-theme` + 记住选择（刷新后还在） */
export function applyTheme(key, { persist = true } = {}) {
  const k = THEMES.some((t) => t.key === key) ? key : DEFAULT_THEME;
  try {
    document.documentElement.dataset.theme = k;
    if (persist) localStorage?.setItem?.(LS_KEY, k);
  } catch { /* 无 DOM（判据里的桩）时静默：主题只是视觉 */ }
  return k;
}

/**
 * 初始化：**URL 参数优先于记忆**。
 *
 * 为什么这么定：给别人看方案时常常要直接甩一个链接（`?theme=tech`），
 * 如果被上次的记忆覆盖，链接就"打不开想要的那套"。
 */
export function initTheme() {
  let fromUrl = null;
  try {
    fromUrl = new URLSearchParams(location.search).get('theme');
  } catch { /* 没有 location（判据环境） */ }
  let remembered = null;
  try {
    remembered = localStorage?.getItem?.(LS_KEY);
  } catch { /* 隐私模式/无 storage */ }
  const key = THEMES.some((t) => t.key === fromUrl) ? fromUrl
    : (THEMES.some((t) => t.key === remembered) ? remembered : DEFAULT_THEME);
  applyTheme(key, { persist: false });
  return key;
}

/** 读一个 CSS 变量的**计算值**（读不到就给兜底，绝不抛） */
export function cssVar(name, fallback = '') {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v ?? '').trim() || fallback;
  } catch {
    return fallback;
  }
}

/**
 * 地图图层要用的颜色令牌。
 * 兜底值 = A 方案（政务深蓝）的取值，这样没有 CSS 环境时地图仍然画得出来。
 */
export function mapTokens() {
  return {
    bg: cssVar('--map-bg', '#f2f6fb'),
    parcelStroke: cssVar('--parcel-stroke', '#0f2c4d'),
    parcelHover: cssVar('--parcel-hover', '#1677ff'),
    roadMajor: cssVar('--road-major', '#9aa7b8'),
    roadMid: cssVar('--road-mid', '#a9b4c2'),
    roadMinor: cssVar('--road-minor', '#bcc5d1'),
    roadTrack: cssVar('--road-track', '#ccd4de'),
    poiSilo: cssVar('--poi-silo', '#e6a23c'),
    poiAgrarian: cssVar('--poi-agrarian', '#1677ff'),
    poiOther: cssVar('--poi-other', '#7c8b9c'),
    adminLine: cssVar('--admin-line', '#1a4f8a'),
    unitLine: cssVar('--unit-line', '#ffffff'),
    gridLine: cssVar('--grid-line', '#7fb2e5'),
    tempTag: cssVar('--temp-tag-bg', 'rgba(255,255,255,0.86)'),
  };
}
