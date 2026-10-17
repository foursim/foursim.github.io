/*
 * 一页可打印报告（**纯函数**：给数据与两张图的 data URL，产出自包含 HTML）。
 *
 * 为什么单独成模块：
 * - 它是 `ui.js` 里最独立的一块（只读传入的参数，不碰 DOM、不碰 this），搬出来之后
 *   体积与职责都更清楚，也更容易被单独验证；
 * - `ui.js` 剩下的部分都是"持有 refs / 事件 / 渲染"的方法，它们与 DOM 绑得太紧，
 *   硬拆只会变成"把 this 传来传去"，所以**有意不拆**（见 README 的"有意不做"）。
 *
 * 自包含的硬要求：图片全部是 `data:` URL，**不引任何外链**（与本项目"纯静态、无外部请求"一致）。
 */

const esc = (x) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');

/**
 * @param {object} p
 * @param {object} p.meta         `model.meta`（站点名、种子）
 * @param {string} p.day          观测日（已格式化）
 * @param {number} p.dayNo        第几天（1 起）
 * @param {number} p.days         窗口总天数
 * @param {string} p.variableLabel 当前着色的指标名
 * @param {string[]} p.overview   关键数（已格式化的几行文字）
 * @param {string[]} p.aggLines   口径说明（逐条，来自 AGG_RULE 的声明）
 * @param {string} p.chartUrl     四张图的拼图（data URL）
 * @param {string} [p.mapUrl]     当前帧地图（data URL；没有就不出这一节）
 */
export function buildReportHtml({
  meta = {}, day = '', dayNo = 1, days = 1, variableLabel = '',
  overview = [], aggLines = [], chartUrl = '', mapUrl = '',
}) {
  const sections = ['一、当前帧关键数'];
  const mapSection = mapUrl
    ? `<h2>二、地图（当前帧）</h2>
<img alt="当前帧地图（含标题与图例）" src="${mapUrl}">
<div class="sub">着色：${esc(variableLabel)}（与屏幕上同一帧、同一套聚合口径）；标题条与图例已画在图内。</div>`
    : '';
  if (mapUrl) sections.push('二、地图（当前帧）');
  const chartNo = mapUrl ? '三' : '二';
  const aggNo = mapUrl ? '四' : '三';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${esc(meta.siteName)} · 农业监测报告（${esc(day)}）</title>
<style>
  @page { size: A4; margin: 14mm; }
  body { font: 13px/1.6 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; color: #12263f; margin: 0; padding: 18px; background: #fff; }
  h1 { font-size: 19px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 18px 0 6px; padding-bottom: 3px; border-bottom: 1px solid #d8e0ea; }
  .sub { color: #5b6b7f; font-size: 12px; }
  ul { margin: 4px 0 8px; padding-left: 20px; }
  img { width: 100%; max-width: 100%; border: 1px solid #e3e9f0; border-radius: 4px; }
  footer { margin-top: 16px; padding-top: 8px; border-top: 1px solid #d8e0ea; color: #5b6b7f; font-size: 11px; }
  @media print { body { padding: 0; } .noprint { display: none; } }
</style></head><body>
<h1>${esc(meta.siteName)} · 农业监测报告</h1>
<div class="sub">观测日 ${esc(day)}（第 ${dayNo} / ${days} 天）· 种子 ${esc(meta.seed)} · 由本项目页面直接生成（离线数据，无外部请求）</div>

<h2>一、当前帧关键数</h2>
<ul>${overview.length ? overview.map((t) => `<li>${t}</li>`).join('') : '<li>（当前页签没有关键问题数据）</li>'}</ul>

${mapSection}

<h2>${chartNo}、四张常用图</h2>
${chartUrl ? `<img alt="四张常用图（折线 / 饼 / 柱 / 雷达）" src="${chartUrl}">` : '<p class="sub">图表尚未绘制</p>'}
<div class="sub">折线看时序 · 饼看构成 · 柱看排行 · 雷达看画像；同一指标在页面、表格、报告里用的是同一份数据（页面不做聚合）。</div>

<h2>${aggNo}、口径（这些数怎么算的）</h2>
<ul>${aggLines.map((t) => `<li>${t}</li>`).join('')}</ul>
<div class="sub">聚合规则只在代码里写一处（geo.js 的 AGG_RULE），表格、地图、判据三方共用同一份声明。</div>

<footer>地块几何 © OpenStreetMap 贡献者（ODbL）· 气象锚点 NASA POWER（MERRA-2）· 监测数据由本项目模型生成（种子 ${esc(meta.seed)}）。<br>
本报告为自包含 HTML：所有图片内嵌为 data URL，不引用任何外部资源。</footer>
</body></html>`;
}
