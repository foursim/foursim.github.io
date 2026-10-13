/**
 * 视觉令牌：把 **CSS 变量**读给"吃不到 CSS 的图层"用。
 *
 * ## 为什么还需要这个文件（明明已经定稿一套配色了）
 * Leaflet 把几何**画在 canvas 上**，而 canvas 上的颜色读不到 CSS 变量 —— 所以道路、地块描边、
 * 设施点、行政边界这些颜色必须在 JS 侧拿到。真值仍然是 CSS（`style.css` 的 `:root`），
 * 这里只做"读出来 + 给兜底值"，**颜色只有一处定义**，不会出现两套色号。
 *
 * ## 配色定稿
 * 三套备选（A 政务深蓝 / B 科技亮蓝 / C 指挥大屏）里用户选定了 **A 政务深蓝**：
 * 白底 + 深蓝顶栏与表头，偏"政务门户 / 监管平台"的观感。B/C 已删除（见 git 历史）。
 */

/** 当前采用的视觉方案（只此一套；留成常量是为了在帮助面板与文档里能引用名字） */
export const THEME = {
  key: 'gov',
  name: 'A 政务深蓝',
  desc: '白底 + 深蓝顶栏与表头，稳重、对比强 —— 贴近政务门户与监管平台',
};

/** 读一个 CSS 变量的**计算值**（读不到就给兜底，绝不抛） */
export function cssVar(name, fallback = '') {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v ?? '').trim() || fallback;
  } catch {
    return fallback;
  }
}

/** 地图图层要用的颜色令牌；兜底值就是 A 方案的取值（没有 CSS 环境时地图仍画得出） */
export function mapTokens() {
  return {
    bg: cssVar('--map-bg', '#f1f5fa'),
    parcelStroke: cssVar('--parcel-stroke', '#0f2c4d'),
    parcelHover: cssVar('--parcel-hover', '#1677ff'),
    roadMajor: cssVar('--road-major', '#94a3b5'),
    roadMid: cssVar('--road-mid', '#a6b1c0'),
    roadMinor: cssVar('--road-minor', '#b9c3cf'),
    roadTrack: cssVar('--road-track', '#cbd3dd'),
    poiSilo: cssVar('--poi-silo', '#e6a23c'),
    poiAgrarian: cssVar('--poi-agrarian', '#1668b8'),
    poiOther: cssVar('--poi-other', '#7c8b9c'),
    adminLine: cssVar('--admin-line', '#1a4f8a'),
    unitLine: cssVar('--unit-line', '#ffffff'),
    gridLine: cssVar('--grid-line', '#7fb2e5'),
    village: cssVar('--village', '#8a4b1f'),
  };
}
