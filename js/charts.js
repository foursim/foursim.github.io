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
export function sparkline(canvas, series, { mark = -1, height = 76, yMax = null, yMin = 0, upto = -1 } = {}) {
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
  const span = (max - yMin) || 1;
  const yOf = (v) => h - pad.b - ((h - pad.t - pad.b) * Math.max(0, Math.min(1, ((Number(v) || 0) - yMin) / span)));
  /*
   * **回放时只把"已经发生"的部分画实**：`upto` = 当前帧下标，之后的部分画淡。
   * 画淡而不是不画：坐标轴与整段形状保持稳定（每帧只画前半段的话，图会看着"断开/闪"），
   * 但"已到 / 未到"一眼可分。纵轴范围仍按**全窗口**算，回放时不跳。
   * 实现就两步：先把整段画淡，再把已发生的一段画实 —— 不做裁剪，简单且无副作用。
   */
  const seg = (s, to, alpha) => {
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let k = 0; k <= to; k++) (k ? ctx.lineTo(xOf(k), yOf(s.values[k])) : ctx.moveTo(xOf(k), yOf(s.values[k])));
    ctx.stroke();
    ctx.globalAlpha = 1;
  };
  for (const s of series) {
    if (upto >= 0 && upto < s.values.length - 1) {
      seg(s, s.values.length - 1, 0.28);
      seg(s, upto, 1);
    } else {
      seg(s, s.values.length - 1, 1);
    }
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

/*
 * ==================== 常用数据图示（都是 canvas 自绘，零依赖） ====================
 *
 * 与上面几个的分工：`sparkline`/`bars`/`hbars` 是**嵌在别处的迷你图**（无轴、无刻度），
 * 这一段是**正经图表**：有坐标轴与刻度、有图例、能单独占一块地方看。
 * 仍然不引第三方库 —— 页面的硬线是运行时零外部请求（见 README「纯静态保证」）。
 *
 * 四个都遵守同一条纪律：**空数据不许画成一张白图**（画一句提示），
 * 否则用户分不清"没数据"和"图坏了"（这个坑在抽屉排行图上踩过一次）。
 */

/** 画一句居中的提示（空数据/不可用时的统一出口） */
function drawHint(ctx, w, h, text) {
  ctx.fillStyle = cssVar('--dim', '#5b6b7f');
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

/**
 * **显示范围**：把一组值收成 `{lo, hi}`，让画布铺满数据 —— 差异才看得见。
 *
 * 两条必须守住的纪律：
 * 1. **非零基要写明**：截轴是"放大差异"的常用手段，也是"用图骗人"的常用手段，
 *    区别只在于**有没有写出来** ⇒ 返回值里的 `lo` 会被画到图角（见 `axes` 的 rangeLabel）。
 * 2. **非负数不画负轴**：`lo` 在数据非负时夹到 0，否则 0 与最小值之间的空白会被读成负值。
 */
export function dataRange(values, { pad = 0.06, zeroBase = false } = {}) {
  const v = (values ?? []).map(Number).filter((x) => Number.isFinite(x));
  if (!v.length) return { lo: 0, hi: 1 };
  let lo = Math.min(...v);
  let hi = Math.max(...v);
  if (zeroBase) { lo = Math.min(0, lo); hi = Math.max(0, hi); }
  const span = hi - lo;
  if (span <= 0) return { lo, hi: lo + (lo === 0 ? 1 : Math.abs(lo) * 0.1) };
  const p = span * pad;
  let outLo = lo - p;
  const outHi = hi + p;
  if (lo >= 0) outLo = Math.max(0, outLo);
  return { lo: outLo, hi: outHi };
}

/** 通用坐标轴：左轴 + 底轴 + 水平网格 + y 刻度（支持非零基；返回绘图区） */
function axes(ctx, w, h, { yMin = 0, yMax, yTicks = 4, padL = 40, padR = 8, padT = 10, padB = 22, rangeLabel = null, fmt = (v) => String(Math.round(v * 100) / 100) }) {
  const plot = { x: padL, y: padT, w: Math.max(10, w - padL - padR), h: Math.max(10, h - padT - padB) };
  ctx.font = '10px system-ui, sans-serif';
  ctx.strokeStyle = 'rgba(120,135,150,0.35)';
  ctx.fillStyle = cssVar('--dim', '#5b6b7f');
  ctx.lineWidth = 1;
  const span = (yMax - yMin) || 1;
  for (let i = 0; i <= yTicks; i++) {
    const v = yMin + (span * i) / yTicks;
    const y = Math.round(plot.y + plot.h - (plot.h * i) / yTicks) + 0.5;
    ctx.beginPath();
    ctx.moveTo(plot.x, y);
    ctx.lineTo(plot.x + plot.w, y);
    ctx.stroke();
    ctx.textAlign = 'right';
    ctx.fillText(fmt(v), plot.x - 4, y + 3);
    ctx.textAlign = 'left';
  }
  ctx.strokeStyle = 'rgba(120,135,150,0.75)';
  ctx.beginPath();
  ctx.moveTo(plot.x + 0.5, plot.y);
  ctx.lineTo(plot.x + 0.5, plot.y + plot.h + 0.5);
  ctx.lineTo(plot.x + plot.w, plot.y + plot.h + 0.5);
  ctx.stroke();
  // **截轴必须在图上写明**（写在图角，不是只写进图注里）
  if (rangeLabel) {
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = cssVar('--dim', '#5b6b7f');
    ctx.textAlign = 'right';
    ctx.fillText(rangeLabel, plot.x + plot.w - 2, plot.y + 9);
    ctx.textAlign = 'left';
  }
  return plot;
}

/**
 * **多序列折线图**（带坐标轴）：适合看"随时间怎么变"。
 * @param series `[{ values:number[], color, label, width?, dash? }]`
 * @param opts.mark 当前帧下标（画一条竖线）
 */
export function lineChart(canvas, series, { height = 180, yMin = null, yMax = null, mark = -1, unit = '', xLabels = null, fit = true, upto = -1 } = {}) {
  const { ctx, w, h } = prepare(canvas, height);
  const list = (series ?? []).filter((s) => s && Array.isArray(s.values) && s.values.length > 1);
  if (!list.length) { drawHint(ctx, w, h, '没有可画的序列'); return null; }
  const all = list.flatMap((s) => s.values.map((v) => Number(v) || 0));
  // 默认**按数据范围铺满**：0 起时 0.3~1.0 的曲线会被压成一条平线，差异全看不见
  const auto = fit ? dataRange(all) : { lo: 0, hi: Math.max(1e-9, ...all) };
  const lo = yMin ?? auto.lo;
  const hi = yMax ?? (auto.hi > lo ? auto.hi : lo + 1e-9);
  const vmax = hi - lo;
  const zeroBase = lo <= 0;
  const plot = axes(ctx, w, h, {
    yMin: lo, yMax: hi,
    rangeLabel: zeroBase ? null : `轴 ${lo.toFixed(2)}~${hi.toFixed(2)}（非零基）`,
    fmt: (v) => (vmax < 1 ? v.toFixed(2) : String(Math.round(v * 10) / 10)),
  });
  const n = Math.max(...list.map((s) => s.values.length));
  const X = (i) => plot.x + (plot.w * i) / Math.max(1, n - 1);
  const Y = (v) => plot.y + plot.h - plot.h * Math.max(0, Math.min(1, ((Number(v) || 0) - lo) / vmax));
  /*
   * **回放**（`upto` = 当前帧下标）：已发生的一段画实、之后画淡。
   *
   * 为什么必须裁剪：不裁的话，回放到第 20 天时图上已经把整个窗口画完了
   * —— 地图停在某一天、图却把"未来"也摊开，两边说的是不同的事。
   * 为什么画淡而不是不画：整段形状与坐标轴保持稳定（每帧都重算会让纵轴跳动、图看着闪），
   * 且"已到 / 未到"一眼可分。纵轴范围始终按**全窗口**算。
   */
  const nAll = (s) => s.values.length - 1;
  for (const s of list) {
    ctx.lineWidth = s.width ?? 1.6;
    if (s.dash) ctx.setLineDash(s.dash);
    const seg = (to, alpha) => {
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = s.color;
      ctx.beginPath();
      for (let i = 0; i <= to; i++) { const x = X(i); const y = Y(s.values[i]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
      ctx.stroke();
      ctx.globalAlpha = 1;
    };
    if (upto >= 0 && upto < nAll(s)) { seg(upto, 1); seg(nAll(s), 0.28); } else { seg(nAll(s), 1); }
    ctx.setLineDash([]);
  }
  if (mark >= 0 && mark < n) {
    ctx.strokeStyle = cssVar('--fg', '#12263f');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(X(mark), plot.y);
    ctx.lineTo(X(mark), plot.y + plot.h);
    ctx.stroke();
  }
  // 图例（图内左上角）：折线图没有图例就只能靠猜颜色
  let lx = plot.x + 4;
  ctx.font = '10px system-ui, sans-serif';
  for (const s of list) {
    if (!s.label) continue;
    ctx.fillStyle = s.color;
    ctx.fillRect(lx, plot.y + 2, 9, 3);
    ctx.fillStyle = cssVar('--dim', '#5b6b7f');
    ctx.fillText(s.label, lx + 12, plot.y + 8);
    lx += 12 + ctx.measureText(s.label).width + 10;
  }
  // x 轴标签（首/中/尾三个，避免挤成一团）
  if (xLabels && xLabels.length) {
    ctx.fillStyle = cssVar('--dim', '#5b6b7f');
    const idx = [0, Math.floor((xLabels.length - 1) / 2), xLabels.length - 1];
    for (const i of idx) {
      if (xLabels[i] == null || i >= n) continue;
      ctx.textAlign = i === 0 ? 'left' : (i === xLabels.length - 1 ? 'right' : 'center');
      ctx.fillText(String(xLabels[i]), X(i), h - 6);
    }
    ctx.textAlign = 'left';
  }
  return { n, lo, hi, zeroBase, series: list.length, unit, upto };
}

/**
 * **散点图**（x、y 都是"越大越好"）：看**两个指标互相拉扯**的关系。
 *
 * 为什么需要它：候选点表只能按**一个**维度排序（按受益面积排完，就看不出"每块省多少"），
 * 柱状图也只有一维 —— "面积大"和"省得多"是不是同一批点，前四种图都答不了。
 * 这里再标出**帕累托前沿**（不被任何点同时超过的那些点）：它们在"这两个目标下没有更好的选择"，
 * 其余点则都能被某个前沿点同时超过（那才是"不选它"的硬理由）。
 *
 * 两个轴都是 0 基（这两组指标天然从 0 起）；若将来有非零基的场景，图角会照规范写明。
 */
export function scatter(canvas, points, {
  height = 200, xLabel = 'x', yLabel = 'y', xUnit = '', yUnit = '',
  xZero = true, yZero = true, showFront = true, dotColor = null, frontColor = null,
  picked = -1, pickedColor = null,
} = {}) {
  const { ctx, w, h } = prepare(canvas, height);
  const list = (points ?? []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  if (list.length < 3) { drawHint(ctx, w, h, '点太少（<3），画不出散布关系'); return null; }
  const xHi = Math.max(...list.map((p) => p.x));
  const yHi = Math.max(...list.map((p) => p.y));
  const xLo = xZero ? 0 : Math.min(...list.map((p) => p.x));
  const yLo = yZero ? 0 : Math.min(...list.map((p) => p.y));
  const xSpan = (xHi - xLo) || 1;
  const ySpan = (yHi - yLo) || 1;
  const fmt = (span, v) => (span < 2 ? v.toFixed(2) : String(Math.round(v * 10) / 10));
  const plot = axes(ctx, w, h, {
    yMin: yLo, yMax: yHi, padB: 30,
    rangeLabel: yZero ? null : `纵轴 ${yLo.toFixed(2)}~${yHi.toFixed(2)}（非零基）`,
    fmt: (v) => fmt(ySpan, v),
  });
  const X = (v) => plot.x + plot.w * Math.max(0, Math.min(1, (v - xLo) / xSpan));
  const Y = (v) => plot.y + plot.h - plot.h * Math.max(0, Math.min(1, (v - yLo) / ySpan));
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillStyle = cssVar('--dim', '#5b6b7f');
  for (let i = 0; i <= 4; i++) {
    const v = xLo + (xSpan * i) / 4;
    ctx.textAlign = i === 0 ? 'left' : (i === 4 ? 'right' : 'center');
    ctx.fillText(fmt(xSpan, v), X(v), h - 18);
  }
  ctx.textAlign = 'left';
  ctx.fillText(`${yLabel}${yUnit ? `（${yUnit}）` : ''} ↑`, plot.x + 4, plot.y + 9);
  ctx.textAlign = 'right';
  ctx.fillText(`${xLabel}${xUnit ? `（${xUnit}）` : ''} →`, plot.x + plot.w - 2, plot.y + plot.h - 5);
  ctx.textAlign = 'left';
  // 帕累托前沿：不存在另一个点"两个目标都不差、至少一个更好"
  const frontIdx = list.map((_, i) => i).filter((i) => !list.some((q, j) => j !== i
    && q.x >= list[i].x && q.y >= list[i].y && (q.x > list[i].x || q.y > list[i].y)));
  /*
   * 点云：`dim` 的点画淡（用来表示"被当前视野筛选排除在外"）。
   * 画淡而不是不画：整幅形状保持不变 —— 否则一缩小视野，图的分布就"变了"，读的人会以为数据变了。
   */
  const dot = dotColor ?? cssVar('--brand', '#1a4f8a');
  const dim = list.filter((p) => p.dim);
  const solid = list.filter((p) => !p.dim);
  ctx.fillStyle = dot;
  if (dim.length) {
    ctx.globalAlpha = 0.18;
    for (const p of dim) { ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), 2.2, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.globalAlpha = 0.5;
  for (const p of solid) { ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), 2.4, 0, Math.PI * 2); ctx.fill(); }
  ctx.globalAlpha = 1;
  if (showFront && frontIdx.length) {
    const fc = frontColor ?? cssVar('--warn', '#b3541e');
    const sorted = frontIdx.map((i) => list[i]).sort((a, b) => a.x - b.x);
    ctx.strokeStyle = fc;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    sorted.forEach((p, k) => (k ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y))));
    ctx.stroke();
    ctx.setLineDash([]);
    for (const p of sorted) {
      ctx.beginPath();
      ctx.arc(X(p.x), Y(p.y), 4.2, 0, Math.PI * 2);
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = fc;
      ctx.stroke();
    }
    ctx.fillStyle = fc;
    ctx.fillRect(plot.x + 4, plot.y + 15, 9, 3);
    ctx.fillStyle = cssVar('--dim', '#5b6b7f');
    ctx.fillText(`○ 帕累托前沿 ${frontIdx.length} 个（不被任何点同时超过）`, plot.x + 16, plot.y + 21);
  }
  /*
   * **选中的那一个**画大一点、加实心环：点图能选点，就得看得见"现在选的是谁"。
   * 选中点最后画（压在点云与前沿之上，不会被盖住）。
   */
  if (picked >= 0 && picked < list.length) {
    const p = list[picked];
    const pc = pickedColor ?? cssVar('--fg', '#12263f');
    ctx.beginPath();
    ctx.arc(X(p.x), Y(p.y), 5.6, 0, Math.PI * 2);
    ctx.fillStyle = pc;
    ctx.fill();
    // 白描边 + 外环：点云密时只靠颜色分不干净，加一圈"留白"最省事
    ctx.strokeStyle = cssVar('--panel', '#ffffff');
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(X(p.x), Y(p.y), 8.6, 0, Math.PI * 2);
    ctx.strokeStyle = pc;
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }
  /*
   * 坐标与命中测试一起返回：**像素位置只有这张图知道**（轴范围、内边距、DPR 都在这里算过）。
   * 让调用方自己再推一遍位置，就是"同一件事写两遍"—— 迟早对不上。
   * `px/py` 是 **CSS 像素**（与 `offsetX/offsetY` 同一空间），可直接用于点击判定。
   */
  const placed = list.map((p, i) => ({ i, px: X(p.x), py: Y(p.y), lat: p.lat, lng: p.lng }));
  const hit = (x, y, tol = 10) => {
    let best = -1;
    let bd = tol * tol;
    // 严格小于：**并列时先出现的赢**（点云里两个候选落在同一像素是常事，
    // 用 `<=` 会让"最后遍历到的那个"胜出 —— 结果随遍历顺序变，不可预期）
    for (const q of placed) {
      const d = (q.px - x) ** 2 + (q.py - y) ** 2;
      if (d < bd) { bd = d; best = q.i; }
    }
    return best;
  };
  return { n: list.length, frontIdx, xLo, xHi, yLo, yHi, zeroBase: xZero && yZero, placed, hit, dimmed: dim.length, picked: picked >= 0 ? picked : -1 };
}

/** **柱状图**（竖直，带坐标轴）：适合看"各项谁高谁低" */
export function columnChart(canvas, items, { height = 180, unit = '', color = null, rotateLabels = false, yMin = 0, yMax = null, labelValues = false } = {}) {
  const { ctx, w, h } = prepare(canvas, height);
  const list = (items ?? []).filter((it) => it && Number.isFinite(Number(it.value)));
  if (!list.length) { drawHint(ctx, w, h, '没有可画的数据'); return null; }
  /*
   * ⚠️ 柱状图**默认 0 起**，而且**不建议**截轴：柱子是"用长度表示量"，
   * 截掉基线会让 8 ha 与 30 ha 看起来差三倍（这正是最常见的"用图骗人"）。
   * 想让差异明显，正确做法是**把数值标在柱顶**（`labelValues`）—— 数字不会骗人。
   */
  const dataMax = Math.max(1e-9, ...list.map((it) => Number(it.value)));
  const vmax = yMax ?? dataMax * (labelValues ? 1.12 : 1);   // 给柱顶数值留一点空间
  const plot = axes(ctx, w, h, { yMin, yMax: vmax, padB: rotateLabels ? 30 : 22 });
  const slot = plot.w / list.length;
  const bw = Math.max(3, Math.min(34, slot - 6));
  const base = color ?? cssVar('--brand', '#1a4f8a');
  ctx.font = '10px system-ui, sans-serif';
  list.forEach((it, i) => {
    const v = Number(it.value);
    const bh = Math.max(1, plot.h * Math.max(0, Math.min(1, (v - yMin) / (vmax - yMin || 1))));
    const x = plot.x + i * slot + (slot - bw) / 2;
    ctx.fillStyle = it.color ?? base;
    ctx.fillRect(x, plot.y + plot.h - bh, bw, bh);
    // 柱顶标值：不截轴也能看清差异（数字比长度更精确）
    if (labelValues) {
      ctx.fillStyle = cssVar('--fg', '#12263f');
      ctx.textAlign = 'center';
      ctx.fillText(v >= 100 ? String(Math.round(v)) : v.toFixed(1), x + bw / 2, plot.y + plot.h - bh - 3);
      ctx.textAlign = 'left';
    }
    const lab = String(it.label ?? '');
    ctx.fillStyle = cssVar('--dim', '#5b6b7f');
    if (rotateLabels) {
      ctx.save();
      ctx.translate(x + bw / 2, plot.y + plot.h + 4);
      ctx.rotate(-Math.PI / 4);
      ctx.textAlign = 'right';
      ctx.fillText(lab.slice(0, 10), 0, 0);
      ctx.restore();
    } else {
      ctx.textAlign = 'center';
      ctx.fillText(lab.slice(0, 6), x + bw / 2, h - 6);
      ctx.textAlign = 'left';
    }
  });
  return { n: list.length, yMin, yMax: vmax, dataMax, zeroBase: yMin <= 0, labelValues, unit };
}

/**
 * **饼图**：适合看"构成占比"。
 * 只画一块也算合法（100%），但**占比为 0 的项不画**（画成一条线没有意义，还会让人以为有值）。
 */
export function pieChart(canvas, items, { height = 180, unit = '', donut = 0.55 } = {}) {
  const { ctx, w, h } = prepare(canvas, height);
  const list = (items ?? []).filter((it) => it && Number(it.value) > 0);
  const total = list.reduce((a, it) => a + Number(it.value), 0);
  if (!list.length || total <= 0) { drawHint(ctx, w, h, '没有可画的占比'); return null; }
  const R = Math.min(h / 2 - 12, w * 0.28);
  const cx = 8 + R + Math.max(0, (w * 0.42 - 2 * R) / 2);
  const cy = h / 2;
  let a0 = -Math.PI / 2;
  const parts = [];
  for (const it of list) {
    const frac = Number(it.value) / total;
    const a1 = a0 + frac * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, a0, a1);
    ctx.closePath();
    ctx.fillStyle = it.color;
    ctx.fill();
    parts.push({ label: it.label, value: Number(it.value), frac });
    a0 = a1;
  }
  if (donut > 0) {   // 环形：中间空出来写总量，图更"轻"
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.arc(cx, cy, R * donut, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.fillStyle = cssVar('--fg', '#12263f');
  ctx.font = 'bold 12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(String(Math.round(total * 10) / 10), cx, cy + 2);
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillStyle = cssVar('--dim', '#5b6b7f');
  ctx.fillText(unit || '合计', cx, cy + 14);
  ctx.textAlign = 'left';
  // 图例（右侧，带百分比）：占比不写出来等于让用户自己算
  const lx = cx + R + 12;
  let ly = Math.max(14, cy - (list.length * 13) / 2 + 4);
  ctx.font = '10px system-ui, sans-serif';
  for (const p of parts) {
    ctx.fillStyle = p.frac > 0.001 ? p.color : p.color;
    ctx.fillRect(lx, ly - 8, 9, 8);
    ctx.fillStyle = cssVar('--fg', '#12263f');
    ctx.fillText(`${String(p.label).slice(0, 8)} ${(p.frac * 100).toFixed(1)}%`, lx + 12, ly);
    ly += 13;
  }
  return { total, parts };
}

/**
 * **雷达图**：适合"一个对象在多个维度上的形状"（本项目的用法：某个经营单元 vs 全场均值）。
 *
 * ⚠️ 各维量纲不同 ⇒ **必须先归一化到 0~1**，而且"越大越好"与"越小越好"的维度要分别处理
 * （`axes` 里带 `invert` 的表示"越小越好"，例如到收储点时间）。
 */
export function radarChart(canvas, { axes: dims, series }, { height = 200, rings = 4 } = {}) {
  const { ctx, w, h } = prepare(canvas, height);
  const list = (series ?? []).filter((s) => s && Array.isArray(s.values));
  const dimList = (dims ?? []).filter((d) => d && d.label);
  if (list.length < 1 || dimList.length < 3) { drawHint(ctx, w, h, '维度不足（至少 3 维）'); return null; }
  // R 要给**底部图例**留位置（否则图例压到"可达性↓"这类轴标签上，这一版真踩过）
  const R = Math.min(h / 2 - 26, w * 0.3);
  const cx = w / 2;
  const cy = h / 2 - 4;
  const ang = (i) => -Math.PI / 2 + (i * Math.PI * 2) / dimList.length;
  const pos = (i, r) => [cx + Math.cos(ang(i)) * r, cy + Math.sin(ang(i)) * r];
  ctx.font = '10px system-ui, sans-serif';
  // 网格环 + 轴线
  ctx.strokeStyle = 'rgba(120,135,150,0.35)';
  ctx.lineWidth = 1;
  for (let k = 1; k <= rings; k++) {
    ctx.beginPath();
    dimList.forEach((_, i) => { const [x, y] = pos(i, (R * k) / rings); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    ctx.closePath();
    ctx.stroke();
  }
  dimList.forEach((_, i) => {
    const [x, y] = pos(i, R);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(x, y);
    ctx.stroke();
  });
  // 各维标签（带"越小越好"的标记）
  dimList.forEach((d, i) => {
    const [x, y] = pos(i, R + 11);
    ctx.fillStyle = cssVar('--dim', '#5b6b7f');
    ctx.textAlign = Math.abs(x - cx) < 6 ? 'center' : (x > cx ? 'left' : 'right');
    ctx.textBaseline = y > cy + 6 ? 'top' : (y < cy - 6 ? 'bottom' : 'middle');
    ctx.fillText(`${d.label}${d.invert ? '↓' : ''}`, x, y);
  });
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  // 多边形
  for (const s of list) {
    ctx.beginPath();
    s.values.forEach((v, i) => {
      const [x, y] = pos(i, R * Math.max(0, Math.min(1, Number(v) || 0)));
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = s.fill ?? 'rgba(26,79,138,0.18)';
    ctx.fill();
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }
  // 图例（底部居中）
  let lx = Math.max(6, cx - 60);
  ctx.font = '10px system-ui, sans-serif';
  for (const s of list) {
    ctx.fillStyle = s.color;
    ctx.fillRect(lx, h - 12, 9, 3);
    ctx.fillStyle = cssVar('--dim', '#5b6b7f');
    ctx.fillText(String(s.label ?? ''), lx + 12, h - 6);
    lx += 12 + ctx.measureText(String(s.label ?? '')).width + 12;
  }
  return { dims: dimList.length, series: list.length };
}
