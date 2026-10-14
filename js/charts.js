/**
 * 小图表（无依赖：就是 canvas 2d）。
 *
 * 只做两件事：**时序曲线**（选中地块的进度/病害/水肥）与**面积条形**（作物结构）。
 * 不引第三方图表库的理由与地图一致：运行时零外部请求、体积可控。
 */

import { cssVar } from './theme.js';

const DPR = () => Math.min(2, (globalThis.devicePixelRatio || 1));

/** 把 canvas 按容器宽度和 DPR 准备好，返回 ctx 与逻辑尺寸 */
function prepare(canvas, height) {
  const w = canvas.clientWidth || canvas.parentElement?.clientWidth || 240;
  const h = height;
  canvas.width = Math.round(w * DPR());
  canvas.height = Math.round(h * DPR());
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(DPR(), 0, 0, DPR(), 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

/**
 * 多序列时序曲线。
 * @param series `[{ values:number[], color:string, label:string, max?:number }]`
 * @param opts.mark 当前播放到的下标（画一条竖线）
 */
export function sparkline(canvas, series, { mark = -1, height = 76, yMax = null } = {}) {
  const { ctx, w, h } = prepare(canvas, height);
  const pad = { l: 2, r: 2, t: 6, b: 10 };
  const n = Math.max(...series.map((s) => s.values.length), 1);
  const max = yMax ?? Math.max(1e-6, ...series.flatMap((s) => s.values));
  // 网格
  ctx.strokeStyle = 'rgba(140,160,145,0.18)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = pad.t + ((h - pad.t - pad.b) * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
  }
  const xOf = (i) => pad.l + ((w - pad.l - pad.r) * i) / Math.max(1, n - 1);
  const yOf = (v) => h - pad.b - ((h - pad.t - pad.b) * v) / max;
  for (const s of series) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    s.values.forEach((v, i) => (i ? ctx.lineTo(xOf(i), yOf(v)) : ctx.moveTo(xOf(i), yOf(v))));
    ctx.stroke();
  }
  if (mark >= 0 && mark < n) {
    ctx.strokeStyle = 'rgba(240,244,232,0.65)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(xOf(mark), pad.t - 3);
    ctx.lineTo(xOf(mark), h - pad.b + 2);
    ctx.stroke();
  }
  return { xOf, yOf, w, h };
}

/** 面积/数量条形（作物结构），返回点击命中的区间（用于 hover/点击联动） */
export function bars(canvas, items, { height = 64, showPct = true } = {}) {
  const { ctx, w, h } = prepare(canvas, height);
  const total = items.reduce((a, b) => a + b.value, 0) || 1;
  let x = 0;
  const hits = [];
  for (const it of items) {
    const bw = ((w - items.length * 2) * it.value) / total;
    ctx.fillStyle = it.color;
    ctx.fillRect(x, 2, Math.max(0, bw), h - 16);
    if (showPct && bw > 26) {
      ctx.fillStyle = 'rgba(10,12,10,0.75)';
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillText(`${Math.round((it.value / total) * 100)}%`, x + 4, 14);
    }
    hits.push({ from: x, to: x + bw, item: it });
    x += bw + 2;
  }
  return hits;
}

/**
 * **水平条形排行图**：每项一条（"谁高谁低"一眼看出）。
 *
 * 与 `bars()` 的分工：`bars` 是**一条**按比例分段的堆叠条（看构成，如作物构成）；
 * `hbars` 是**每项一条**的排行（看大小对比）——抽屉里"哪几块/哪个单元最要紧"要的是后者。
 */
export function hbars(canvas, items, { unit = '', rowH = 16, labelW = null } = {}) {
  const h = Math.max(rowH + 4, items.length * rowH + 4);
  const { ctx, w } = prepare(canvas, h);
  const fg = cssVar('--fg', '#12263f');
  const dimText = cssVar('--dim', '#5b6b7f');
  const lw = labelW ?? Math.min(160, Math.max(70, Math.round(w * 0.3)));
  const vw = 58;
  const barW = Math.max(8, w - lw - vw - 4);
  const vmax = Math.max(...items.map((i) => i.value), 1e-9);
  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  items.forEach((it, i) => {
    const y = i * rowH + rowH / 2 + 3;
    ctx.fillStyle = dimText;
    ctx.fillText(String(it.label).slice(0, 18), 0, y);
    const bw = (barW * it.value) / vmax;
    ctx.fillStyle = it.color || fg;
    ctx.fillRect(lw, y - 5, Math.max(1, bw), 10);
    ctx.fillStyle = fg;
    ctx.fillText(`${Math.round(it.value * 10) / 10}${unit ? '' : ''}`, lw + barW + 4, y);
  });
  return items;
}

/**
 * **竖直堆叠柱**：一列一组（如"月"），每段一类（如 播种/施肥/收获）。
 *
 * 与 `bars()`（一条按比例分段的横条）的分工：那个看**构成**，这个看**时间形态** ——
 * "农忙窗口"是后者（哪几个月柱子最高、里面是哪一类最多）。
 * 图例画在图内左上角：堆叠图没有图例就只能靠猜颜色。
 */
export function stackedBars(canvas, groups, series, { height = 150, label = (s) => s } = {}) {
  const { ctx, w } = prepare(canvas, height);
  const fg = cssVar('--fg', '#12263f');
  const dimText = cssVar('--dim', '#5b6b7f');
  const padX = 6;
  const padTop = 18;
  const padBottom = 16;
  const plotH = Math.max(20, height - padTop - padBottom);
  const totals = groups.map((g) => series.reduce((t, s) => t + (Number(g.values[s.key]) || 0), 0));
  const vmax = Math.max(...totals, 1);
  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'alphabetic';
  // 图例（图内左上角，一行摆不下就换行）
  let lx = padX;
  let ly = 4;
  for (const s of series) {
    const t = String(s.label ?? s.key);
    const tw = ctx.measureText(t).width;
    if (lx + 12 + tw > w) { lx = padX; ly += 13; }
    ctx.fillStyle = s.color;
    ctx.fillRect(lx, ly, 9, 9);
    ctx.fillStyle = dimText;
    ctx.fillText(t, lx + 12, ly + 9);
    lx += 12 + tw + 12;
  }
  const slot = (w - padX * 2) / groups.length;
  const bw = Math.max(3, Math.min(26, slot - 4));
  groups.forEach((g, i) => {
    const x = padX + i * slot + (slot - bw) / 2;
    let y = padTop + plotH;
    for (const s of series) {
      const v = Number(g.values[s.key]) || 0;
      if (v <= 0) continue;
      const hh = Math.max(1, (plotH * v) / vmax);
      ctx.fillStyle = s.color;
      ctx.fillRect(x, y - hh, bw, hh);
      y -= hh;
    }
    // 柱子顶上的合计（只标最高的三根，否则 13 个数字糊成一片）
    ctx.fillStyle = dimText;
    ctx.textAlign = 'center';
    ctx.fillText(String(g.label), x + bw / 2, height - 4);
    ctx.textAlign = 'left';
  });
  return { vmax, totals };
}

/**
 * **前后成对条形**：每一项两根（现状 / 新建后），**共用同一标尺**。
 *
 * 为什么不画两张地图并排（实测，见判据"不画双地图的空间依据"）：地图区 1440×900 下 **794px**、
 * 1024×640 下 **378px**，一分为二后每张只剩 **397px / 189px** —— 最小尺寸下地块碎成米粒；
 * 而且两张图要同步视野、图例、高亮三套状态。这张图要回答的是"**省在哪里、省多少**"，条形图更直接。
 */
export function pairedBars(canvas, items, { unit = 'min', rowH = 19, labelW = null } = {}) {
  const h = Math.max(rowH + 4, items.length * rowH + 18);
  const { ctx, w } = prepare(canvas, h);
  const fg = cssVar('--fg', '#12263f');
  const dimText = cssVar('--dim', '#5b6b7f');
  const cBefore = cssVar('--dim', '#9aa7b4');
  const cAfter = cssVar('--brand', '#1a4f8a');
  const lw = labelW ?? Math.min(150, Math.max(64, Math.round(w * 0.24)));
  const vw = 78;
  const barW = Math.max(8, w - lw - vw - 4);
  const vmax = Math.max(...items.map((it) => it.before), 1e-9);
  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  // 图例：两根条的含义（不写就只能靠颜色猜）
  ctx.fillStyle = cBefore;
  ctx.fillRect(0, 4, 10, 8);
  ctx.fillStyle = dimText;
  ctx.fillText('现状', 14, 8);
  ctx.fillStyle = cAfter;
  ctx.fillRect(52, 4, 10, 8);
  ctx.fillStyle = dimText;
  ctx.fillText('新建后', 66, 8);
  items.forEach((it, i) => {
    const y = i * rowH + rowH / 2 + 12;
    ctx.fillStyle = dimText;
    ctx.fillText(String(it.label).slice(0, 16), 0, y);
    ctx.fillStyle = cBefore;
    ctx.fillRect(lw, y - 6, Math.max(1, (barW * it.before) / vmax), 4);
    ctx.fillStyle = cAfter;
    ctx.fillRect(lw, y + 1, Math.max(1, (barW * it.after) / vmax), 4);
    ctx.fillStyle = fg;
    ctx.fillText(`省 ${Math.round(it.gain * 10) / 10}`, lw + barW + 4, y);
  });
  return items;
}

/** 水平色带图例（用与地图同一份标度：CSS 渐变由 geo.js 生成） */
export function colorbar(el, gradient, lo, hi) {
  el.innerHTML = gradient
    ? `<div class="cbar" style="background:${gradient}"></div>
       <div class="cbar-lab"><span>${lo}</span><span>${hi}</span></div>`
    : '';
}
