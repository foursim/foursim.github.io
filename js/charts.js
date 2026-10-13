/**
 * 小图表（无依赖：就是 canvas 2d）。
 *
 * 只做两件事：**时序曲线**（选中地块的进度/病害/水肥）与**面积条形**（作物结构）。
 * 不引第三方图表库的理由与地图一致：运行时零外部请求、体积可控。
 */

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

/** 水平色带图例（用与地图同一份标度：CSS 渐变由 geo.js 生成） */
export function colorbar(el, gradient, lo, hi) {
  el.innerHTML = gradient
    ? `<div class="cbar" style="background:${gradient}"></div>
       <div class="cbar-lab"><span>${lo}</span><span>${hi}</span></div>`
    : '';
}
