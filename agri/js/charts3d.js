/**
 * 3D 图表（无依赖：canvas 2d + 自算等轴投影）。
 *
 * ## 为什么不引 three.js / echarts-gl
 * 本项目的硬线是**运行时零外部请求 + 体积可控**（`vendor/` 里连 Leaflet 都是本地内置的）。
 * 而 3D 图表真正需要的只有两件事：
 *   1. **一个投影**：把深度 z 折到屏幕的斜上方；
 *   2. **三面明暗**：正面用原色、侧面压暗、顶面提亮 —— 人眼靠这三块面积判"立体"。
 * 两百行就够，多引一个渲染引擎反而是负担（还要处理 WebGL 上下文丢失、DPR、导出 PNG）。
 *
 * ## 投影口径（四个图共用，只写这一处）
 * ```
 * 屏幕 x = 平面 x + z * AX
 * 屏幕 y = 平面 y - z * AY
 * ```
 * 镜头在**左前上方**：z 越大越靠后，屏幕上越偏右上。
 * 绘制顺序统一按 z **从大到小**（画家算法）—— 后画的盖住先画的，正好对应"近的挡远的"。
 * ⚠️ 这是本项目 3D 化的**唯一**约定：每个函数内部的遮挡关系都靠它，改 AX/AY 只影响观感，不影响正确性。
 *
 * ## 与 2D 的关系
 * 3D 只换**画法**，不换**口径**：取值范围、0 基线、占比合计、单位、空数据提示全部沿用 2D 版本的规则
 * （柱状图仍然 0 起，饼图仍然只画 >0 的项，雷达仍按 0~1 归一化）。
 * 换句话说：**3D 是视图，不是另一套数据** —— 切换开关不该让任何数字变。
 */

import { cssVar } from './theme.js';
import { prepare, drawHint } from './charts.js';

/** 深度方向每一单位在屏幕上的位移（左前上方视角） */
const AX = 0.46;
const AY = 0.30;

/** 平面 (x,y) + 深度 z → 屏幕坐标 */
const proj = (x, y, z = 0) => ({ x: x + z * AX, y: y - z * AY });

/** 颜色解析：#rgb / #rrggbb / rgb() / rgba() → [r,g,b]；认不出就返回 null（原样使用） */
function parseRgb(color) {
  const s = String(color ?? '').trim();
  if (s.startsWith('#')) {
    const h = s.slice(1);
    const to = (a) => parseInt(a, 16);
    if (h.length === 3) return [to(h[0] + h[0]), to(h[1] + h[1]), to(h[2] + h[2])];
    if (h.length === 6) return [to(h.slice(0, 2)), to(h.slice(2, 4)), to(h.slice(4, 6))];
    return null;
  }
  const m = s.match(/rgba?\(([^)]+)\)/i);
  if (!m) return null;
  const p = m[1].split(',').map((v) => parseFloat(v));
  return p.length >= 3 && p.every((v) => Number.isFinite(v)) ? p.slice(0, 3) : null;
}

/**
 * 明暗调整：`k < 1` 压暗（侧面），`k > 1` 提亮（顶面）。
 * 提亮走"朝白色插值"而不是乘系数 —— 深蓝乘 1.2 会溢出成纯蓝，色相跑掉。
 */
function shade(color, k) {
  const rgb = parseRgb(color);
  if (!rgb) return color;
  const f = (v) => {
    const out = k >= 1 ? v + (255 - v) * (k - 1) : v * k;
    return Math.max(0, Math.min(255, Math.round(out)));
  };
  return `rgb(${f(rgb[0])},${f(rgb[1])},${f(rgb[2])})`;
}

/** 一块四边形（4 个屏幕点）→ 填充 + 可选描边。3D 图的每个面都走这里，明暗规则只有一处。 */
function face(ctx, pts, fill, stroke = null) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

const fmtVal = (v) => (Math.abs(v) >= 100 ? String(Math.round(v)) : v.toFixed(1));

/**
 * **3D 柱状图**：长方柱（正面 / 侧面 / 顶面三块），适合看"各项谁高谁低"。
 *
 * 口径与 `columnChart` 完全一致：**默认 0 起**（不截轴），差异靠柱顶数值标注表达。
 * 3D 并没有把长度换成别的东西，所以"截轴骗人"这条规矩原样适用。
 */
export function columnChart3d(canvas, items, {
  height = 180, unit = '', depth = 16, yMin = 0, yMax = null,
  rotateLabels = false, labelValues = false, color = null,
} = {}) {
  const { ctx, w, h } = prepare(canvas, height);
  const list = (items ?? []).filter((it) => it && Number.isFinite(Number(it.value)));
  if (!list.length) { drawHint(ctx, w, h, '没有可画的数据'); return null; }

  const dataMax = Math.max(1e-9, ...list.map((it) => Number(it.value)));
  const vmax = yMax ?? dataMax * (labelValues ? 1.12 : 1);
  // 深度会让图形往右上"长"出去，右边与上边必须留出 depth*AX / depth*AY
  const padL = 34;
  const padR = 10 + depth * AX;
  const padT = 10 + depth * AY;
  const padB = rotateLabels ? 30 : 22;
  const plot = {
    x: padL, y: padT,
    w: Math.max(10, w - padL - padR),
    h: Math.max(10, h - padT - padB),
  };
  const base = plot.y + plot.h;
  const span = (vmax - yMin) || 1;
  const hOf = (v) => Math.max(1, plot.h * Math.max(0, Math.min(1, (v - yMin) / span)));

  // ---- 地面网格（3D 的"底座"，同时给出读数的水平参考）----
  ctx.strokeStyle = 'rgba(120,135,150,0.30)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = Math.round(base - (plot.h * i) / 4) + 0.5;
    ctx.beginPath();
    // 每条网格线从"前面"画到"后面"：两端各按深度偏移一次，才有透视感
    ctx.moveTo(plot.x, y);
    ctx.lineTo(plot.x + plot.w, y);
    ctx.moveTo(plot.x + depth * AX, y - depth * AY);
    ctx.lineTo(plot.x + plot.w + depth * AX, y - depth * AY);
    ctx.stroke();
  }
  // 底面（把"地"和"墙"分开；不填色会和白色卡片背景糊在一起）
  face(ctx, [
    [plot.x, base], [plot.x + plot.w, base],
    [plot.x + plot.w + depth * AX, base - depth * AY], [plot.x + depth * AX, base - depth * AY],
  ], 'rgba(120,135,150,0.06)', 'rgba(120,135,150,0.22)');

  // y 轴刻度值
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillStyle = cssVar('--dim', '#5b6b7f');
  for (let i = 0; i <= 4; i++) {
    const v = yMin + (span * i) / 4;
    const y = base - (plot.h * i) / 4;
    ctx.textAlign = 'right';
    ctx.fillText(fmtVal(v), plot.x - 4, y + 3);
  }
  ctx.textAlign = 'left';

  // ---- 柱体 ----
  const slot = plot.w / list.length;
  const bw = Math.max(3, Math.min(28, slot - 8));
  const baseColor = color ?? cssVar('--brand', '#1a4f8a');
  const bars = [];
  list.forEach((it, i) => {
    const v = Number(it.value);
    const bh = hOf(v);
    const x0 = plot.x + i * slot + (slot - bw) / 2;
    const x1 = x0 + bw;
    const top = base - bh;
    const c = it.color ?? baseColor;
    // 深度位移：右移 depth*AX、上移 depth*AY（与 proj 同一口径，这里直接用标量避免符号绕晕）
    const dx = depth * AX;
    const dyy = depth * AY;

    // 侧面（右侧，被压暗）
    face(ctx, [[x1, base], [x1 + dx, base - dyy], [x1 + dx, top - dyy], [x1, top]], shade(c, 0.72));
    // 顶面（被提亮 —— "光从左上前方来"）
    face(ctx, [[x0, top], [x1, top], [x1 + dx, top - dyy], [x0 + dx, top - dyy]],
      shade(c, 1.18), 'rgba(255,255,255,0.45)');
    // 正面（原色，最后画 = 最近）
    face(ctx, [[x0, base], [x1, base], [x1, top], [x0, top]], c);

    if (labelValues) {
      ctx.fillStyle = cssVar('--fg', '#12263f');
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(fmtVal(v), x0 + bw / 2 + dx / 2, top - dyy - 3);
      ctx.textAlign = 'left';
    }
    /*
     * 把**每个柱的屏幕几何**一起返回：判据要独立取样"顶面 / 正面 / 侧面"的明暗，
     * 而这三块的位置只有这张图知道（布局、留白、深度位移都在这里算过）。
     * 让判据自己再推一遍布局 = 同一件事写两遍，迟早对不上（与散点图返回 `placed` 同一个理由）。
     */
    bars.push({ label: String(it.label ?? ''), value: v, x0, x1, top, base, bw, bh, dx, dyy, depth });
  });

  // ---- x 轴标签（压在柱底，和 2D 版同样的旋转策略）----
  ctx.fillStyle = cssVar('--dim', '#5b6b7f');
  ctx.font = '10px system-ui, sans-serif';
  list.forEach((it, i) => {
    const lab = String(it.label ?? '');
    const cx = plot.x + i * slot + slot / 2;
    if (rotateLabels) {
      ctx.save();
      ctx.translate(cx, base + 4);
      ctx.rotate(-Math.PI / 4);
      ctx.textAlign = 'right';
      ctx.fillText(lab.slice(0, 10), 0, 0);
      ctx.restore();
    } else {
      ctx.textAlign = 'center';
      ctx.fillText(lab.slice(0, 6), cx, h - 6);
      ctx.textAlign = 'left';
    }
  });

  return { mode: '3d', n: list.length, yMin, yMax: vmax, dataMax, zeroBase: yMin <= 0, labelValues, unit, bars, plot: { ...plot, base } };
}

/**
 * **3D 饼图**：椭圆顶面 + 前侧厚度（真正让饼"有厚度"的是前半个圆周的侧壁）。
 *
 * 三条沿用 2D 的规则：
 * 1. 占比为 0 的项**不画**（画成一条线没有意义，还会让人以为有值）；
 * 2. 图例带百分比（占比不写出来等于让用户自己算）；
 * 3. 中心写合计 + 单位。
 * 侧壁只画**朝前的那半个圆周**（`sin(mid) > 0`）—— 背面的侧壁被自身顶面挡住，画了也是白画，
 * 反而会在饼的上沿露出一条"假厚度"。
 */
export function pieChart3d(canvas, items, { height = 180, unit = '', squash = 0.62, thickness = 0.34 } = {}) {
  const { ctx, w, h } = prepare(canvas, height);
  const list = (items ?? []).filter((it) => it && Number(it.value) > 0);
  const total = list.reduce((a, it) => a + Number(it.value), 0);
  if (!list.length || total <= 0) { drawHint(ctx, w, h, '没有可画的占比'); return null; }

  // 半径先按"高度"定（饼要装下椭圆 + 厚度），再受宽度约束
  const R = Math.min((h - 18) / (2 * squash + 2 * thickness * squash + 0.2), w * 0.26);
  const t = R * thickness;
  const cx = 8 + R + Math.max(0, (w * 0.42 - 2 * R) / 2);
  const cy = (h - t) / 2 + 2;          // 让"椭圆 + 厚度"整体居中
  const ry = R * squash;

  // 落影：没有影子的 3D 饼像贴在纸上的贴纸
  ctx.save();
  ctx.globalAlpha = 0.10;
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.ellipse(cx, cy + t + 2, R * 1.02, ry * 1.02, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const parts = [];
  let a0 = -Math.PI / 2;
  for (const it of list) {
    const frac = Number(it.value) / total;
    const a1 = a0 + frac * Math.PI * 2;
    parts.push({ a0, a1, mid: (a0 + a1) / 2, frac, color: it.color, label: it.label, value: Number(it.value) });
    a0 = a1;
  }

  // ① 先画**朝前**的侧壁（顶面会盖住它们的内侧，所以必须先画）
  for (const p of parts) {
    if (Math.sin(p.mid) <= 0) continue;   // 背面的侧壁看不见
    ctx.beginPath();
    ctx.ellipse(cx, cy, R, ry, 0, p.a0, p.a1);
    ctx.lineTo(cx + Math.cos(p.a1) * R, cy + t + Math.sin(p.a1) * ry);
    ctx.ellipse(cx, cy + t, R, ry, 0, p.a1, p.a0, true);
    ctx.closePath();
    ctx.fillStyle = shade(p.color, 0.66);
    ctx.fill();
  }
  // ② 再画顶面扇形（每片一个"从上到下"的渐变，比纯色更像受光的圆盘）
  for (const p of parts) {
    const g = ctx.createLinearGradient(cx, cy - ry, cx, cy + ry);
    g.addColorStop(0, shade(p.color, 1.22));
    g.addColorStop(1, shade(p.color, 0.92));
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.ellipse(cx, cy, R, ry, 0, p.a0, p.a1);
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  // ③ 顶面外沿描一圈高光：把"圆盘边缘"从侧壁里分离出来
  ctx.beginPath();
  ctx.ellipse(cx, cy, R, ry, 0, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // ④ 中心合计（饼是实心的，字压在顶面中心；用深色保证在任何色块上都读得清）
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(10,16,24,0.82)';
  ctx.font = 'bold 12px system-ui, sans-serif';
  ctx.fillText(String(Math.round(total * 10) / 10), cx, cy + 3);
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(10,16,24,0.62)';
  ctx.fillText(unit || '合计', cx, cy + 15);
  ctx.textAlign = 'left';

  // ⑤ 图例（右侧，带百分比）
  const lx = cx + R + 12;
  let ly = Math.max(14, h / 2 - (parts.length * 13) / 2 + 4);
  ctx.font = '10px system-ui, sans-serif';
  for (const p of parts) {
    ctx.fillStyle = p.color;
    ctx.fillRect(lx, ly - 8, 9, 8);
    ctx.fillStyle = cssVar('--fg', '#12263f');
    ctx.fillText(`${String(p.label).slice(0, 8)} ${(p.frac * 100).toFixed(1)}%`, lx + 12, ly);
    ly += 13;
  }
  return { mode: '3d', total, parts };
}

/**
 * **3D 折线图**：多条序列沿深度方向分开（一条一层），每层带"地面投影"与半透明面积。
 *
 * 为什么这样分而不是把时间画成第三条轴：折线的 x 是**时间**、y 是**量纲**，
 * 把序列铺在 z 上，正好让"同一时刻不同对象"的高低差一眼可比，
 * 同时保留 2D 版的读法（纵轴范围、当前帧竖线、已发生/未发生的浓淡）。
 */
export function lineChart3d(canvas, series, {
  height = 180, yMin = 0, yMax = 1, xLabels = null, mark = -1, depth = 14, unit = '', upto = -1,
} = {}) {
  const { ctx, w, h } = prepare(canvas, height);
  const list = (series ?? []).filter((s) => s && Array.isArray(s.values) && s.values.length);
  if (!list.length) { drawHint(ctx, w, h, '没有可画的曲线'); return null; }

  const n = Math.max(...list.map((s) => s.values.length), 1);
  const padL = 34;
  const padR = 12 + (list.length - 1) * depth * AX;
  const padT = 8 + (list.length - 1) * depth * AY;
  const padB = 22 + (list.length - 1) * depth * AY;
  const plot = {
    x: padL, y: padT,
    w: Math.max(10, w - padL - padR),
    h: Math.max(10, h - padT - padB),
  };
  const base = plot.y + plot.h;
  const span = (yMax - yMin) || 1;
  const xOf = (i) => plot.x + (plot.w * i) / Math.max(1, n - 1);
  const yOf = (v) => base - plot.h * Math.max(0, Math.min(1, ((Number(v) || 0) - yMin) / span));

  // 底面 + 横向网格（每条网格同时画"前"与"后"两条边，给阅读一个空间锚点）
  const totalDepth = (list.length - 1) * depth;
  ctx.strokeStyle = 'rgba(120,135,150,0.30)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = Math.round(base - (plot.h * i) / 4) + 0.5;
    ctx.beginPath();
    ctx.moveTo(plot.x, y);
    ctx.lineTo(plot.x + plot.w, y);
    if (totalDepth) {
      ctx.moveTo(plot.x + totalDepth * AX, y - totalDepth * AY);
      ctx.lineTo(plot.x + plot.w + totalDepth * AX, y - totalDepth * AY);
    }
    ctx.stroke();
  }
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillStyle = cssVar('--dim', '#5b6b7f');
  for (let i = 0; i <= 4; i++) {
    const v = yMin + (span * i) / 4;
    ctx.textAlign = 'right';
    ctx.fillText(fmtVal(v), plot.x - 4, base - (plot.h * i) / 4 + 3);
  }
  ctx.textAlign = 'left';

  /** 第 k 层的深度（k=0 在最前面） */
  const zOf = (k) => k * depth;

  // 从最后一层往前画：远的先画，近的盖上去
  for (let k = list.length - 1; k >= 0; k--) {
    const s = list[k];
    const z = zOf(k);
    const ox = z * AX;
    const oy = -z * AY;

    // 地面投影：同一条线压在底线上的淡影（没有它，几层会"飘"在空中分不清先后）
    ctx.beginPath();
    s.values.forEach((_, i) => {
      const x = xOf(i) + ox;
      const y = base + oy;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = 'rgba(90,110,130,0.18)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // 面积：从曲线垂到该层自己的底线
    const to = upto >= 0 ? Math.min(upto, s.values.length - 1) : s.values.length - 1;
    if (to >= 1) {
      ctx.beginPath();
      ctx.moveTo(xOf(0) + ox, base + oy);
      for (let i = 0; i <= to; i++) ctx.lineTo(xOf(i) + ox, yOf(s.values[i]) + oy);
      ctx.lineTo(xOf(to) + ox, base + oy);
      ctx.closePath();
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = s.color;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // 整条线（淡）+ 已发生的一段（实）——与 2D 版 `upto` 的读法一致
    const stroke = (end, alpha, width) => {
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (let i = 0; i <= end; i++) {
        const x = xOf(i) + ox;
        const y = yOf(s.values[i]) + oy;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    };
    if (upto >= 0 && upto < s.values.length - 1) {
      stroke(s.values.length - 1, 0.26, 1.4);
      stroke(upto, 1, 1.8);
    } else {
      stroke(s.values.length - 1, 1, 1.8);
    }

    // 当前帧：在这一层上点一个实心点 + 一条垂到地面的细线（比 2D 的竖线更容易定位层）
    if (mark >= 0 && mark < s.values.length) {
      const mx = xOf(mark) + ox;
      const my = yOf(s.values[mark]) + oy;
      ctx.strokeStyle = 'rgba(120,135,150,0.45)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(mx, my);
      ctx.lineTo(mx, base + oy);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(mx, my, 2.4, 0, Math.PI * 2);
      ctx.fillStyle = s.color;
      ctx.fill();
    }
  }

  // x 轴标签（只画最前面那一层，避免几层标签叠字）
  if (xLabels?.length) {
    ctx.fillStyle = cssVar('--dim', '#5b6b7f');
    ctx.font = '10px system-ui, sans-serif';
    const step = Math.max(1, Math.ceil(xLabels.length / Math.max(3, Math.floor(plot.w / 52))));
    for (let i = 0; i < xLabels.length; i += step) {
      ctx.textAlign = i === 0 ? 'left' : (i >= xLabels.length - step ? 'right' : 'center');
      ctx.fillText(String(xLabels[i]).slice(0, 7), xOf(i), h - 6);
    }
    ctx.textAlign = 'left';
  }
  return { mode: '3d', series: list.length, n, yMin, yMax, unit };
}

/**
 * **3D 雷达图**：把每一维做成一根立在椭圆环上的方柱（高度 = 该维归一化值）。
 *
 * 为什么不用"3D 多边形面片"：雷达图的价值是**逐维对比**，而立体面片的透视会让朝向不同的边
 * 长度不可比（斜着的边在屏幕上更短）。改成"环上一圈方柱"后，柱高仍严格正比于取值，
 * 立体只负责区分两个对象（一个环靠前、一个环靠后），不为读数量服务。
 */
export function radarChart3d(canvas, { axes: dims, series }, { height = 200, rings = 4, squash = 0.5, depth = 9 } = {}) {
  const { ctx, w, h } = prepare(canvas, height);
  const list = (series ?? []).filter((s) => s && Array.isArray(s.values));
  const dimList = (dims ?? []).filter((d) => d && d.label);
  if (list.length < 1 || dimList.length < 3) { drawHint(ctx, w, h, '维度不足（至少 3 维）'); return null; }

  const R = Math.min(h / 2 - 34, w * 0.28);
  const cx = w / 2;
  const cy = h / 2 - 2;
  const maxBarH = Math.min(h * 0.34, R * 0.9);
  const ang = (i) => -Math.PI / 2 + (i * Math.PI * 2) / dimList.length;
  /** 环上第 i 个轴、半径系数 rr（1 = 外环）处的平面坐标 */
  const at = (i, rr = 1) => [cx + Math.cos(ang(i)) * R * rr, cy + Math.sin(ang(i)) * R * rr * squash];

  // 底盘：同心椭圆环（读数参考）
  ctx.strokeStyle = 'rgba(120,135,150,0.32)';
  ctx.lineWidth = 1;
  for (let k = 1; k <= rings; k++) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, (R * k) / rings, (R * squash * k) / rings, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  // 各轴在底盘上的投影线（告诉眼睛"这根柱子属于哪一维"）
  dimList.forEach((_, i) => {
    const [x, y] = at(i);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(x, y);
    ctx.strokeStyle = 'rgba(120,135,150,0.22)';
    ctx.stroke();
  });

  // 柱体：先把"每一维 × 每一序列"的柱子算出来，再按 z 从大到小画
  const towers = [];
  list.forEach((s, si) => {
    const z = si * depth;
    const rr = 1 - si * 0.06;         // 后一层稍微收一点，视觉上不重叠
    dimList.forEach((dd, i) => {
      const v = Math.max(0, Math.min(1, Number(s.values[i]) || 0));
      const [px, py] = at(i, rr);
      towers.push({ si, i, v, px, py, z, color: s.color, invert: !!dd.invert });
    });
  });
  // 后方（椭圆上半部分，sin<0）+ 深度大的先画
  towers.sort((a, b) => (Math.sin(ang(a.i)) - Math.sin(ang(b.i))) || (b.z - a.z));

  const bw = Math.max(5, Math.min(11, (R * Math.PI * 2) / dimList.length / 3.4));
  /** 每个序列各柱的顶点（用来画闭环脊线，见下） */
  const tops = list.map(() => []);
  for (const tw of towers) {
    const bh = Math.max(2, maxBarH * tw.v);
    const dx = tw.z * AX;
    const dy = tw.z * AY * 0.6;
    const x0 = tw.px - bw / 2;
    const x1 = tw.px + bw / 2;
    const baseY = tw.py - dy;
    const top = baseY - bh;
    // 侧面 / 顶面 / 正面（三块面积就是"立体"的全部信息）
    face(ctx, [
      [x1, baseY], [x1 + bw * 0.5, baseY - bw * 0.28],
      [x1 + bw * 0.5, top - bw * 0.28], [x1, top],
    ], shade(tw.color, 0.7));
    face(ctx, [
      [x0, top], [x1, top],
      [x1 + bw * 0.5, top - bw * 0.28], [x0 + bw * 0.5, top - bw * 0.28],
    ], shade(tw.color, 1.18), 'rgba(255,255,255,0.4)');
    face(ctx, [[x0, baseY], [x1, baseY], [x1, top], [x0, top]], tw.color);
    tops[tw.si].push({ i: tw.i, x: tw.px, y: top });
    // "越小越好"的维度打一个 ↓（与 2D 版同一条约定）
    if (tw.invert) {
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = '8px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('↓', tw.px + dx, top - 4);
      ctx.textAlign = 'left';
    }
  }

  /*
   * **闭环脊线**：把同一序列的各柱顶连成一个闭合多边形。
   * 只有"一圈柱子"时读者看不出这是雷达图（那是柱阵），连上脊线后
   * "哪个方向凸出去"立刻可读 —— 这也是 2D 雷达多边形在 3D 里的对应物。
   * 从后排序列往前画，保证前面的脊线压在后面的上面。
   */
  for (let si = list.length - 1; si >= 0; si--) {
    const pts = tops[si].slice().sort((a, b) => a.i - b.i);
    if (pts.length < 3) continue;
    ctx.beginPath();
    pts.forEach((p, k) => (k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.strokeStyle = list[si].color;
    ctx.lineWidth = 1.4;
    ctx.globalAlpha = 0.85;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // 维度标签（放在外环外侧，按象限对齐）
  ctx.font = '10px system-ui, sans-serif';
  dimList.forEach((dd, i) => {
    const [x, y] = at(i, 1.16);
    ctx.fillStyle = cssVar('--dim', '#5b6b7f');
    ctx.textAlign = Math.abs(x - cx) < 6 ? 'center' : (x > cx ? 'left' : 'right');
    ctx.textBaseline = y > cy + 6 ? 'top' : (y < cy - 6 ? 'bottom' : 'middle');
    ctx.fillText(`${dd.label}${dd.invert ? '↓' : ''}`, x, y);
  });
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // 图例（底部居中，与 2D 版一致）
  let lx = Math.max(6, cx - 60);
  for (const s of list) {
    ctx.fillStyle = s.color;
    ctx.fillRect(lx, h - 12, 9, 3);
    ctx.fillStyle = cssVar('--dim', '#5b6b7f');
    ctx.fillText(String(s.label ?? ''), lx + 12, h - 6);
    lx += 12 + ctx.measureText(String(s.label ?? '')).width + 12;
  }
  return { mode: '3d', dims: dimList.length, series: list.length, towers: towers.length };
}
