#!/usr/bin/env node
/**
 * 真浏览器验收（Chrome/Edge + CDP，**真实鼠标事件**）。
 *
 * 为什么需要它：这个页面是地图应用，`tools/agro-smoke.mjs` 只能验模型，
 * 验不了"图层有没有真的更新 / 时间轴拖动对不对 / 控件能不能点到"。
 * 而且历史上的两个顽疾（控件被遮住点不到、列表重建吞掉点击）**只有真浏览器能发现**。
 *
 * 部署口径也在这里复现：静态服务器挂在**子路径**下（等价于 `user.github.io/<repo>/`），
 * 这是 GitHub Pages 项目站的真实形态 —— 相对路径写错在这里就会露。
 *
 * 用法：node tools/browser-check.mjs [--out 目录] [--port 8123]
 * 找不到浏览器时**跳过**（不算失败），所以可以挂在 CI 里。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
// 端口一律**随机**：固定端口在 CI/本机重复跑时很容易撞上"端口被占用"而假失败
let HTTP_PORT = Number(opt('port', 0));
const CDP_PORT = Number(opt('cdp', 9300 + Math.floor(Math.random() * 400)));
const PREFIX = '/webtrade'; // 项目站的子路径
const OUT = path.resolve(opt('out', path.join(os.tmpdir(), 'agri-check')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.geojson': 'application/json; charset=utf-8' };

let pass = 0;
let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  [OK]   ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`); }
};

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => fs.existsSync(p));
if (!CHROME) {
  console.log('未找到 Chrome/Edge，跳过真浏览器验收（模型判据见 tools/agro-smoke.mjs）');
  process.exit(0);
}

// ---------- 静态服务器（子路径） ----------
const server = http.createServer(async (req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (!url.startsWith(PREFIX)) { res.writeHead(404); res.end('nope'); return; }
  url = url.slice(PREFIX.length);
  if (url === '' || url === '/') url = '/index.html';
  try {
    const b = await fs.promises.readFile(path.join(ROOT, url));
    res.writeHead(200, { 'content-type': MIME[path.extname(url)] || 'application/octet-stream' });
    res.end(b);
  } catch { res.writeHead(404); res.end('404'); }
});
await new Promise((r) => server.listen(HTTP_PORT, '127.0.0.1', r));
HTTP_PORT = server.address().port;

// ---------- 浏览器 + CDP ----------
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${path.join(os.tmpdir(), `agri-${Date.now()}`)}`, '--no-first-run',
  '--disable-gpu', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });
async function waitFor(fn, what) { for (let i = 0; i < 100; i++) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await sleep(200); } throw new Error(`超时：${what}`); }
const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find((x) => x.type === 'page'), 'target');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
});
const send = (m, p = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  return r.result.value;
};
const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, 'base64')); };
await send('Page.enable');
await send('Runtime.enable');

const center = (sel) => ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return null;
  const r=el.getBoundingClientRect();const cx=r.left+r.width/2,cy=r.top+r.height/2;const hit=document.elementFromPoint(cx,cy);
  return {x:cx,y:cy,w:Math.round(r.width),h:Math.round(r.height),hit:hit?hit.tagName.toLowerCase()+(hit.id?'#'+hit.id:''):null,self:hit===el||el.contains(hit)};})()`);
/** 真实点击：命中不上就 scrollIntoView 后重试（地图/滚动容器里必须这样） */
async function click(sel) {
  for (let i = 0; i < 3; i++) {
    const c = await center(sel);
    if (!c) return null;
    if (c.self || i === 2) {
      await mouse('mouseMoved', c.x, c.y); await mouse('mousePressed', c.x, c.y);
      await sleep(30); await mouse('mouseReleased', c.x, c.y); await sleep(220);
      return c;
    }
    await ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});el&&el.scrollIntoView({block:'center'});})()`);
    await sleep(250);
  }
  return null;
}
const boot = async (w, h, query = '') => {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false, screenWidth: w, screenHeight: h });
  await send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}${PREFIX}/index.html?t=${Date.now()}${query}` });
  await waitFor(async () => await ev(`document.readyState==='complete' && !!globalThis.__agri`), '页面就绪');
  await sleep(700);
};

// ===================== 1. 子路径启动与数据规模 =====================
console.log('\n=== 1. 子路径部署与数据规模 ===');
await boot(1440, 900);
const meta = await ev(`(()=>{const a=globalThis.__agri;return {parcels:a.model.parcels.length, days:a.model.days.length,
  rows:a.rows.length, layers:a.map.parcelLayer.getLayers().length, roads:a.map.roadLayer.getLayers().length,
  poi:a.map.poiLayer.getLayers().length, site:a.model.meta.siteName, start:a.model.days[0], end:a.model.days[a.model.days.length-1]};})()`);
check('页面在**子路径**下正常启动（等价 GitHub Pages 项目站）', !!meta.site, meta.site);
check('地块图层要素数与模型一致（501 块）', meta.layers === meta.parcels && meta.parcels === 501, `${meta.layers}/${meta.parcels}`);
check('路网与设施图层也有内容', meta.roads > 1000 && meta.poi > 100, `路 ${meta.roads} 条 / 设施 ${meta.poi} 个`);
check('时间轴覆盖跨年窗口（含冬作物完整生育期）', meta.days === 549, `${meta.start}~${meta.end}，${meta.days} 天`);

// ===================== 2. 指标切换 =====================
console.log('\n=== 2. 指标切换真的改到地图 ===');
for (const [key, expect] of [['disease', '病害'], ['water', '水分'], ['crop', '作物'], ['tillage', '耕作'], ['yield', '单产'], ['access', '到收储点']]) {
  await click(`button[data-var="${key}"]`);
  const st = await ev(`(()=>{const a=globalThis.__agri;const l=a.map.parcelLayer.getLayers()[0];
    return {variable:a.state.variable, legend:document.getElementById('legend-title').textContent,
      color:l.options.fillColor, on:document.querySelector('button[data-var="${key}"]').classList.contains('on')};})()`);
  check(`切到「${expect}」：状态与图例同步、地块颜色被重算`, st.variable === key && st.on && !!st.color,
    `图例 ${st.legend || '（无单位）'}、填充 ${st.color}`);
}

// ===================== 2b. 可达性分析（离线算出来的分析量） =====================
console.log('\n=== 2b. 可达性：地块时间 + 等时圈 ===');
const acc = await ev(`(()=>{const a=globalThis.__agri;
  const t=a.rows.map(r=>r.t_min).filter(v=>v!=null);
  return {n:a.rows.length, have:t.length, min:Math.min(...t), max:Math.max(...t),
    isoLayers:a.map.isoLayer.getLayers().length, levels:a.access.levels_min,
    onMap:a.map.map.hasLayer(a.map.isoLayer)};})()`);
check('每个地块都有"到收储点"的时间（与地块数一一对应）', acc.have === acc.n && acc.n === 501, `${acc.have}/${acc.n}`);
check('时间量纲合理（0~60 分钟，而不是秒/毫秒）', acc.min > 0 && acc.max < 60, `${acc.min.toFixed(1)} ~ ${acc.max.toFixed(1)} 分钟`);
check('等时圈图层存在且在图上（层级按本地区分位数定）', acc.isoLayers === acc.levels.length && acc.onMap,
  `${acc.levels.join('/')} 分钟，${acc.isoLayers} 层`);
await ev(`(()=>{const cb=document.querySelector('input[data-layer="iso"]');cb.checked=false;cb.dispatchEvent(new Event('change',{bubbles:true}));})()`);
const isoOff = await ev(`globalThis.__agri.map.map.hasLayer(globalThis.__agri.map.isoLayer)`);
await ev(`(()=>{const cb=document.querySelector('input[data-layer="iso"]');cb.checked=true;cb.dispatchEvent(new Event('change',{bubbles:true}));})()`);
const isoOn = await ev(`globalThis.__agri.map.map.hasLayer(globalThis.__agri.map.isoLayer)`);
check('等时圈图层能开关（真的增删图层，不只是改透明度）', isoOff === false && isoOn === true, `${isoOff} → ${isoOn}`);
await shot('view-access-1440x900');

// ===================== 2c. 三层空间单元（P1/P2/P4）+ P3 分区样例层 =====================
console.log('\n=== 2c. 三层空间单元（P1 地块 / P2 经营单元 / P4 统计网格）===');
const lu = await ev(`(()=>{const a=globalThis.__agri;return {
  parcels:a.units.parcel.length, units:a.units.stats.units, grids:a.units.stats.grids,
  unitLayers:a.map.unitLayer.getLayers().length, gridLayers:a.map.gridLayer.getLayers().length,
  zoneLayers:a.map.zoneLayer ? a.map.zoneLayer.getLayers().length : 0,
  everyMapped:a.rows.every(r=>!!r.unit_id && !!r.grid_id),
  unitAreaP50:a.units.stats.unit_area_ha.p50, unitAreaMax:a.units.stats.unit_area_ha.max};})()`);
check('每个地块都挂到了 P2 单元与 P4 网格（外键完整）', lu.everyMapped && lu.parcels === 501,
  `${lu.parcels} 块 → ${lu.units} 单元 / ${lu.grids} 格`);
check('P2 单元数落在"可管理"量级（20~120），面积上限生效',
  lu.units >= 20 && lu.units <= 120 && lu.unitAreaMax <= 30.01,
  `${lu.units} 个，面积中位 ${lu.unitAreaP50} / 最大 ${lu.unitAreaMax} ha`);
check('P2/P4 图层的要素数与数据一致', lu.unitLayers === lu.units && lu.gridLayers === lu.grids,
  `单元 ${lu.unitLayers} / 网格 ${lu.gridLayers}`);
// 分区样点是**按需加载**的：打开图层后才去拉数据（首屏不背 2 MB）
{
  const before = await ev(`!!globalThis.__agri.map.zoneLayer`);
  await ev(`(()=>{const cb=document.querySelector('input[data-layer="zones"]');cb.checked=true;cb.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  let n = 0;
  for (let i = 0; i < 40; i++) {
    n = await ev(`globalThis.__agri.map.zoneLayer ? globalThis.__agri.map.zoneLayer.getLayers().length : 0`);
    if (n > 0) break;
    await sleep(150);
  }
  check('P3 分区样点按需加载：打开图层后才加载，且要素数正确（>10000）',
    before === false && n > 10000, `加载前 ${before}，加载后 ${n} 个样点`);
}
for (const [key, label] of [['unit', '经营单元'], ['grid', '统计网格']]) {
  await click(`button[data-var="${key}"]`);
  const st = await ev(`(()=>{const a=globalThis.__agri;const l=a.map.parcelLayer.getLayers()[0];
    return {v:a.state.variable, color:l.options.fillColor};})()`);
  check(`切到「${label}」：地块按单元归属着色`, st.v === key && /hsl\(/.test(String(st.color)), st.color);
}
for (const [layer, label] of [['grids', 'P4 统计网格'], ['zones', 'P3 管理分区样点']]) {
  await ev(`(()=>{const cb=document.querySelector('input[data-layer="${layer}"]');cb.checked=true;cb.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const on = await ev(`(()=>{const a=globalThis.__agri;return a.map.map.hasLayer(a.map.${layer === 'grids' ? 'gridLayer' : 'zoneLayer'});})()`);
  await ev(`(()=>{const cb=document.querySelector('input[data-layer="${layer}"]');cb.checked=false;cb.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const off = await ev(`(()=>{const a=globalThis.__agri;return a.map.map.hasLayer(a.map.${layer === 'grids' ? 'gridLayer' : 'zoneLayer'});})()`);
  check(`图层「${label}」能开关`, on === true && off === false, `${on} → ${off}`);
}
await ev(`(()=>{const cb=document.querySelector('input[data-layer="units"]');cb.checked=true;cb.dispatchEvent(new Event('change',{bubbles:true}));})()`);
await click('button[data-var="unit"]');
await shot('view-units-1440x900');

// ===================== 3. 时间轴 =====================
console.log('\n=== 3. 时间轴（滑块 / 播放） ===');
await ev(`(()=>{const s=document.getElementById('day-slider');s.value='300';s.dispatchEvent(new Event('input',{bubbles:true}));})()`);
await sleep(200);
const at300 = await ev(`(()=>{const a=globalThis.__agri;return {day:a.state.day, label:document.getElementById('day-label').textContent,
  progress:document.getElementById('stats').textContent.slice(0,40)};})()`);
check('拖时间轴 ⇒ 当前日、日期标签、指标卡一起变', at300.day === 300 && /\d{4}-\d\d-\d\d/.test(at300.label),
  `${at300.label}`);
await click('#btn-play');
const d0 = await ev(`globalThis.__agri.state.day`);
await sleep(1400);
const d1 = await ev(`globalThis.__agri.state.day`);
check('播放 ⇒ 日期自动推进', d1 !== d0, `${d0} → ${d1}`);
await click('#btn-play');
const d2 = await ev(`globalThis.__agri.state.day`);
await sleep(700);
const d3 = await ev(`globalThis.__agri.state.day`);
check('暂停 ⇒ 停止推进', d2 === d3, `${d2} → ${d3}`);

// ===================== 4. 图层开关 =====================
console.log('\n=== 4. 图层开关 ===');
await ev(`(()=>{const cb=document.querySelector('input[data-layer="roads"]');cb.checked=false;cb.dispatchEvent(new Event('change',{bubbles:true}));})()`);
const roadsOff = await ev(`globalThis.__agri.map.map.hasLayer(globalThis.__agri.map.roadLayer)`);
await ev(`(()=>{const cb=document.querySelector('input[data-layer="roads"]');cb.checked=true;cb.dispatchEvent(new Event('change',{bubbles:true}));})()`);
const roadsOn = await ev(`globalThis.__agri.map.map.hasLayer(globalThis.__agri.map.roadLayer)`);
check('取消/勾选「路网」⇒ 图层真的被移除/加回', roadsOff === false && roadsOn === true, `${roadsOff} → ${roadsOn}`);

// ===================== 5. 地块点选与详情曲线 =====================
console.log('\n=== 5. 点地块 → 详情与曲线 ===');
const clicked = await ev(`(()=>{const a=globalThis.__agri;const l=a.map.parcelLayer.getLayers()[5];
  const c=l.getBounds().getCenter();const p=a.map.map.latLngToContainerPoint(c);
  const r=document.getElementById('map').getBoundingClientRect();
  return {x:r.left+p.x, y:r.top+p.y};})()`);
await mouse('mouseMoved', clicked.x, clicked.y);
await mouse('mousePressed', clicked.x, clicked.y);
await sleep(30);
await mouse('mouseReleased', clicked.x, clicked.y);
await sleep(300);
// ⚠️ 只查"canvas 存在"会假通过：Leaflet 会吞掉事件处理器里的异常，
// 于是 HTML 已经写进去了、画曲线的代码却没跑（这正是第一版踩到的）。所以要查**真的画了**：
// `charts.js` 的 prepare() 会显式设置 canvas 的 style.height。
const detail = await ev(`(()=>{const d=document.getElementById('detail').textContent;
  const cv=document.getElementById('det-chart');return {len:d.length, hasCanvas:!!cv,
    drawn:!!cv && cv.style.height!=='', w:cv?cv.width:0, h:cv?cv.height:0, txt:d.slice(0,20).replace(/\\s+/g,' ')};})()`);
check('点地图地块 ⇒ 右侧出现该地块详情，且时序曲线真的画出来了',
  detail.hasCanvas && detail.drawn && detail.len > 40 && detail.w > 0 && detail.h > 0,
  `“${detail.txt}…” 曲线 ${detail.w}×${detail.h}px`);

// ===================== 6. 告警 =====================
console.log('\n=== 6. 告警（找一天有告警的） ===');
// 要找的是**地块级**告警（带 .alarm-items 的那种）——区域级告警（高温/强降水）没有条目
const alarmDay = await ev(`(()=>{const a=globalThis.__agri;
  for(let d=150;d<420;d+=3){a.setDay(d);
    const items=document.querySelectorAll('#alarms .alarm-items button').length;
    if(items>0)return {day:d,count:document.querySelectorAll('#alarms .alarm').length,items};}
  return {day:-1,count:0,items:0};})()`);
check('存在触发阈值的告警日，且地块级告警带可点击条目（否则"告警"模块是摆设）',
  alarmDay.count > 0 && alarmDay.items > 0, `第 ${alarmDay.day} 天有 ${alarmDay.count} 条告警 / ${alarmDay.items} 个地块条目`);
if (alarmDay.count > 0) {
  // 断言"选中 == 被点的那一条"（而不是"选中变了"：可能刚好就是当前选中的那块，那是假失败）
  const want = await ev(`(()=>{const b=document.querySelector('#alarms .alarm-items button');return b?Number(b.dataset.parcel):-1;})()`);
  const hit = await click('#alarms .alarm-items button');
  const got = await ev(`globalThis.__agri.ui.selected ? globalThis.__agri.ui.selected.i : -1`);
  check('点告警里的地块条目 ⇒ 选中并定位到该地块', !!hit && want >= 0 && got === want, `点第 ${want} 块 → 选中第 ${got} 块`);
}

// ===================== 7. 帮助弹窗 =====================
console.log('\n=== 7. 帮助弹窗 ===');
await click('#btn-help');
const open = await ev(`!document.getElementById('modal').classList.contains('hidden') && document.getElementById('modal-body').textContent.length>100`);
await click('#modal-close');
const closed = await ev(`document.getElementById('modal').classList.contains('hidden')`);
check('弹窗打开且内容完整 / × 能关掉', open && closed, `${open} → ${closed}`);

// ===================== 8. 可达性审计（桌面 + 手机） =====================
const AUDIT = `(()=>{
  const nm=(el,a='')=>{let s=el.tagName.toLowerCase();if(el.id)s+='#'+el.id;
    if(typeof el.className==='string'&&el.className.trim())s+='.'+el.className.trim().split(/\\s+/)[0];
    const t=(el.textContent||'').trim().slice(0,10);return s+a+(t?' "'+t+'"':'');};
  const vis=(el)=>{const b=el.getBoundingClientRect();let r={left:Math.max(0,b.left),top:Math.max(0,b.top),right:Math.min(innerWidth,b.right),bottom:Math.min(innerHeight,b.bottom)};
    for(let p=el.parentElement;p;p=p.parentElement){const cs=getComputedStyle(p);
      if(!/(hidden|auto|scroll)/.test(cs.overflowX)&&!/(hidden|auto|scroll)/.test(cs.overflowY))continue;
      const q=p.getBoundingClientRect();r.left=Math.max(r.left,q.left);r.top=Math.max(r.top,q.top);r.right=Math.min(r.right,q.right);r.bottom=Math.min(r.bottom,q.bottom);}
    return r;};
  const scrollable=(el)=>{for(let p=el.parentElement;p;p=p.parentElement){const cs=getComputedStyle(p);
    if(!/(auto|scroll)/.test(cs.overflowY)&&!/(auto|scroll)/.test(cs.overflowX))continue;
    if((/(auto|scroll)/.test(cs.overflowY)&&p.scrollHeight>p.clientHeight+1)||(/(auto|scroll)/.test(cs.overflowX)&&p.scrollWidth>p.clientWidth+1))return p.id||p.className||p.tagName;}return null;};
  const out={total:0,zero:[],covered:[],scrollOnly:[],unreachable:[]};
  const modal=document.getElementById('modal');
  const inClosedModal=(el)=>modal && modal.classList.contains('hidden') && modal.contains(el);
  for(const el of document.querySelectorAll('button, input, select, label')){
    // 关掉的弹窗里的控件尺寸为 0 是**预期**（不是可达性问题）——不参与审计
    if(inClosedModal(el)) continue;
    out.total++;
    const b=el.getBoundingClientRect();
    if(b.width<1||b.height<1){out.zero.push(nm(el));continue;}
    const v=vis(el);const sc=scrollable(el);
    if(v.right<=v.left||v.bottom<=v.top){ if(sc) out.scrollOnly.push(nm(el)); else out.unreachable.push(nm(el)); continue; }
    const px=Math.min(v.right-1,Math.max(v.left+1,b.left+b.width/2));
    const py=Math.min(v.bottom-1,Math.max(v.top+1,b.top+b.height/2));
    const hit=document.elementFromPoint(px,py);
    if(!(hit===el||el.contains(hit)||(hit&&hit.contains(el)))) out.covered.push(nm(el)+' ← '+nm(hit));
  }
  return out;})()`;

/**
 * 面板分区审计：**节与节之间不许重叠、节的内容不许画到节外**。
 *
 * 为什么值得单独一条：侧栏是"可被 flex 压缩的 section + 内部滚动"的结构，
 * 一旦某节的内容没有滚动容器，它就会画进下一节 —— 表现就是"文字叠在一起"
 * （实测 1280×720：区域概览被压到 270 px、内容要 348 px，作物条形钻进了告警区）。
 * 这种 bug 用"看截图"能发现、用"点了有反应吗"发现不了，所以必须量盒子。
 */
const OVERLAP = `(()=>{
  const nm=(el)=>el.tagName.toLowerCase()+(el.id?'#'+el.id:'.'+String(el.className).split(' ')[0]);
  const bad=[];
  // ⚠️ 必须**按面板分组**再比：左右两栏的 section 是并排的，混成一个序列会把"左栏最后一节 ↔ 右栏第一节"
  // 当成重叠（第一版就是这么假失败的）
  for(const panel of document.querySelectorAll('.panel')){
    const secs=[...panel.querySelectorAll(':scope > section')];
    for(const sec of secs){
      const r=sec.getBoundingClientRect();
      for(const ch of sec.children){
        const c=ch.getBoundingClientRect();
        if(c.height<1) continue;
        if(c.bottom>r.bottom+1||c.top<r.top-1) bad.push(nm(panel)+' › '+nm(sec.querySelector('h3')||sec)+' 的内容 '+nm(ch)+' 画到节外');
      }
    }
    for(let i=1;i<secs.length;i++){
      const a=secs[i-1].getBoundingClientRect(),b=secs[i].getBoundingClientRect();
      if(b.top<a.bottom-1) bad.push(nm(panel)+' 第'+i+'节与第'+(i+1)+'节重叠 '+Math.round(a.bottom-b.top)+'px');
    }
  }
  return bad;})()`;

for (const [w, h] of [[1440, 900], [1280, 720], [390, 844]]) {
  await boot(w, h);
  // 把"选中地块"撑满（它是最高的内容），这是布局的应力场景
  await ev(`(()=>{const a=globalThis.__agri;a.ui.select(a.rows[3]);a.setDay(390);})()`);
  await sleep(150);
  const layout = await ev(OVERLAP);
  check(`${w}×${h}：面板分节不重叠、内容不画出节外（含"选中地块"撑满时）`,
    layout.length === 0, layout.slice(0, 3).join(' | ') || '0 处');
  const a = await ev(AUDIT);
  check(`${w}×${h}：没有尺寸为 0 的控件（说明"面板被整体藏起来"这类问题不存在）`, a.zero.length === 0, a.zero.slice(0, 3).join(',') || '0 个');
  check(`${w}×${h}：没有被遮挡的控件`, a.covered.length === 0, a.covered.slice(0, 3).join(' | ') || '0 个');
  check(`${w}×${h}：没有"滚也滚不出来"的控件`, a.unreachable.length === 0,
    `共 ${a.total} 个控件；需滚动 ${a.scrollOnly.length} 个${a.unreachable.length ? ` | ${a.unreachable.slice(0, 3).join(',')}` : ''}`);
  await shot(`view-${w}x${h}`);
}

// ===================== 9. 窄屏也能操作时间轴 =====================
console.log('\n=== 9. 窄屏操作 ===');
await boot(390, 844);
await click('#btn-play');
await sleep(1200);
const mob = await ev(`({day:globalThis.__agri.state.day, play:globalThis.__agri.state.playing})`);
check('窄屏：播放按钮可点且真的在推进', mob.play === true, `到第 ${mob.day} 天`);


// ===================== 10. 三套政企配色（临时版本，供选型） =====================
console.log('\n=== 10. 三套配色 ===');
await boot(1440, 900);
const themes = await ev(`(()=>{
  const cv=(k)=>getComputedStyle(document.documentElement).getPropertyValue(k).trim();
  const mapBg=()=>getComputedStyle(document.getElementById('map')).backgroundColor;
  const out={};
  for(const key of ['gov','tech','dark']){
    document.documentElement.dataset.theme=key;
    out[key]={brand:cv('--brand'), panel:cv('--panel'), mapBg:mapBg(), topbar:getComputedStyle(document.getElementById('topbar')).backgroundColor};
  }
  document.documentElement.dataset.theme='gov';
  return out;})()`);
const distinct = new Set(Object.values(themes).map((t) => `${t.brand}|${t.panel}|${t.mapBg}`));
check('三套配色的主色/面板/地图底色互不相同（真的换了，不是只改个名字）', distinct.size === 3,
  Object.entries(themes).map(([k, v]) => `${k}:${v.brand}/${v.mapBg}`).join('  '));
const lum = (c) => { const m = (c.match(/[\d.]+/g) ?? []).map(Number); return m.length >= 3 ? m[0] * 0.299 + m[1] * 0.587 + m[2] * 0.114 : 0; };
check('A/B 两套确为"蓝白"（浅底，地图底色亮度 > 180）',
  lum(themes.gov.mapBg) > 180 && lum(themes.tech.mapBg) > 180,
  `gov ${Math.round(lum(themes.gov.mapBg))} / tech ${Math.round(lum(themes.tech.mapBg))} / dark ${Math.round(lum(themes.dark.mapBg))}`);

// 走真实交互切一次：下拉 change → actions.onTheme → applyTheme + map.setTheme
await ev(`(()=>{const s=document.getElementById('theme-sel');s.value='gov';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
await sleep(200);
const brandGov = await ev(`getComputedStyle(document.documentElement).getPropertyValue('--brand').trim()`);
await ev(`(()=>{const s=document.getElementById('theme-sel');s.value='tech';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
await sleep(300);
const switched = await ev(`({brand:getComputedStyle(document.documentElement).getPropertyValue('--brand').trim(),
  theme:document.documentElement.dataset.theme, saved:localStorage.getItem('agri-monitor-theme'),
  anchor:getComputedStyle(document.querySelector('#topbar button')).backgroundColor})`);
check('下拉切换真的生效（dataset.theme + CSS 变量 + 记住选择）',
  switched.theme === 'tech' && switched.brand !== brandGov && switched.saved === 'tech',
  `${brandGov} → ${switched.brand} / ${switched.theme} / 记忆 ${switched.saved}`);
const tokenChanged = await ev(`(()=>{const a=globalThis.__agri;a.map.setTheme();
  return {road:a.map.token.roadMajor, admin:a.map.token.adminLine};})()`);
check('地图令牌随主题刷新（canvas 图层吃不到 CSS 变量，必须显式重刷）',
  /^#|^rgb/.test(tokenChanged.road ?? '') && /^#|^rgb/.test(tokenChanged.admin ?? ''),
  `road ${tokenChanged.road} / admin ${tokenChanged.admin}`);

for (const [key, tag] of [['gov', 'A-政务深蓝'], ['tech', 'B-科技亮蓝'], ['dark', 'C-指挥大屏']]) {
  await ev(`(()=>{const s=document.getElementById('theme-sel');s.value='${key}';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await sleep(350);
  await shot(`theme-${tag}-1440x900`);
}
await boot(1440, 900, '&theme=tech');
check('URL 参数 ?theme= 优先于记忆（甩个链接就能指定方案）',
  await ev(`document.documentElement.dataset.theme`) === 'tech',
  await ev(`document.documentElement.dataset.theme`));

// ===================== 11. 行政边界（真实数据） =====================
console.log('\n=== 11. 行政边界 ===');
await boot(1440, 900);
const adm = await ev(`(()=>{const a=globalThis.__agri;const L=a.map.adminLayer.getLayers();
  return {n:L.length, names:a.admin.features.map(f=>f.properties.name),
    codes:a.admin.features.map(f=>f.properties.admin_code), levels:a.admin.features.map(f=>f.properties.level),
    visible:a.map.map.hasLayer(a.map.adminLayer), code:a.ADMIN_CODE,
    street:a.admin.features.find(f=>String(f.properties.admin_level)==='8')?.properties.osm_id};})()`);
check('行政边界来自真实数据：乡 + 县两级、都带官方行政区划码',
  adm.n >= 2 && adm.codes.every((c) => c) && adm.levels.includes('Gemeinde') && adm.levels.includes('Kreis'),
  adm.names.map((n, i) => `${n}(${adm.codes[i]})`).join(' / '));
check('地块编码前缀 = 真实的市镇（Gemeinde）行政区划码',
  adm.code === adm.codes[adm.levels.indexOf('Gemeinde')], `${adm.code} ← admin.geojson 的 ${adm.street ?? ''}`);
await ev(`(()=>{const cb=document.querySelector('input[data-layer="admin"]');cb.checked=false;
  cb.dispatchEvent(new Event('change',{bubbles:true}));})()`);
await sleep(200);
const admOff = await ev(`globalThis.__agri.map.map.hasLayer(globalThis.__agri.map.adminLayer)`);
await ev(`(()=>{const cb=document.querySelector('input[data-layer="admin"]');cb.checked=true;
  cb.dispatchEvent(new Event('change',{bubbles:true}));})()`);
await sleep(200);
const admOn = await ev(`globalThis.__agri.map.map.hasLayer(globalThis.__agri.map.adminLayer)`);
check('「行政边界（村/县）」开关真的能关掉/打开图层', admOff === false && admOn === true, `关 ${admOff} → 开 ${admOn}`);
await shot('admin-boundary-1440x900');

// ===================== 12. 地图下方的表格 =====================
console.log('\n=== 12. 表格区 ===');
const tb1 = await ev(`(()=>{const q=(s)=>document.querySelectorAll(s);
  return {tabs:q('#tb-tabs button').length, rows:q('#tb-body .tbl tbody tr').length,
    head:q('#tb-body .tbl thead th').length, note:document.getElementById('tb-note').textContent,
    active:document.querySelector('#tb-tabs button.on')?.textContent};})()`);
check('表格区默认显示「当前帧指标」：8 行 × 6 列（与模型变量一一对应）',
  tb1.tabs === 4 && tb1.active === '当前帧指标' && tb1.rows === 8 && tb1.head === 6,
  `${tb1.tabs} 个页签 / ${tb1.active} ${tb1.rows} 行 × ${tb1.head} 列 / ${tb1.note}`);
await click('#tb-tabs button[data-tab="units"]');
await sleep(250);
const tb2 = await ev(`(()=>{const q=(s)=>document.querySelectorAll(s);
  return {rows:q('#tb-body .tbl tbody tr').length, first:q('#tb-body .tbl tbody tr td')?.[0]?.textContent,
    note:document.getElementById('tb-note').textContent};})()`);
check('「经营单元」表列出全部 62 个 P2 单元，编码用真实行政码前缀',
  tb2.rows === 62 && /^09186162-U-\d{4}$/.test(tb2.first ?? ''), `${tb2.rows} 行，首行 ${tb2.first}（${tb2.note}）`);
await click('#tb-tabs button[data-tab="crops"]');
await sleep(250);
const tb3 = await ev(`(()=>{const q=(s)=>document.querySelectorAll(s);
  return {rows:q('#tb-body .tbl tbody tr').length, head:[...q('#tb-body .tbl thead th')].map(t=>t.textContent)};})()`);
check('「作物与收成」按作物聚合且带「单产口径」列（不同口径不能直接比大小）',
  tb3.rows >= 5 && tb3.head.includes('单产口径'), `${tb3.rows} 行 / ${tb3.head.join(' | ')}`);
// 先跳到有告警的那一天，再切到告警页签（否则表格里可能"当日无告警"，点不到地块）
const zAlarmDay = await ev(`(()=>{const a=globalThis.__agri;
  for(let d=0;d<a.model.days.length;d++){if(a.ui.alarmsFor(d).length){a.setDay(d);return d;}}
  return -1;})()`);
await click('#tb-tabs button[data-tab="alarms"]');
await sleep(250);
const tb4 = await ev(`(()=>{const q=(s)=>document.querySelectorAll(s);
  return {rows:q('#tb-body .tbl tbody tr').length, btn:!!document.querySelector('#tb-body [data-parcel]')};})()`);
check('「告警明细」在有告警的日子列出条目并给出可点地块', zAlarmDay >= 0 && tb4.rows >= 1 && tb4.btn,
  `第 ${zAlarmDay} 天 / ${tb4.rows} 行`);
const focus = await ev(`(()=>{const b=document.querySelector('#tb-body [data-parcel]');if(!b)return null;
  b.click();return {sel:globalThis.__agri.ui.selected?.i ?? null, want:Number(b.dataset.parcel)};})()`);
check('表格里点「涉及地块」能定位到那块地（与告警面板同一行为）',
  focus && focus.sel === focus.want, JSON.stringify(focus));
await shot('tables-1440x900');

// ===================== 13. 导出 CSV / PNG =====================
console.log('\n=== 13. 导出 ===');
const csv = await ev(`(async()=>{
  const a=globalThis.__agri;
  let captured=null;
  const oc=URL.createObjectURL; URL.createObjectURL=(b)=>{captured=b;return 'blob:stub';};
  const ok=HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click=function(){};
  a.exportCsv();
  await new Promise(r=>setTimeout(r,80));
  URL.createObjectURL=oc; HTMLAnchorElement.prototype.click=ok;
  if(!captured) return {ok:false};
  const text=await captured.text();
  const lines=text.split('\\n');
  return {ok:true, type:captured.type, kb:Math.round(captured.size/1024), header:lines[0], first:lines[1], rows:lines.length-1};})()`);
check('导出 CSV：行数 = 地块数、列名与离线表对齐、编码用真实行政码',
  csv.ok && csv.rows === 501 && /parcel_code/.test(csv.header ?? '') && /09186162-P-000001/.test(csv.first ?? ''),
  csv.ok ? `${csv.rows} 行 / ${csv.kb} KB` : '没捕获到 Blob');
const png = await ev(`(async()=>{
  let captured=null;
  const oc=URL.createObjectURL; URL.createObjectURL=(b)=>{captured=b;return 'blob:stub';};
  const ok=HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click=function(){};
  globalThis.__agri.exportPng();
  await new Promise(r=>setTimeout(r,800));
  URL.createObjectURL=oc; HTMLAnchorElement.prototype.click=ok;
  return captured ? {type:captured.type, kb:Math.round(captured.size/1024)} : null;})()`);
check('导出 PNG：拿到 image/png 且体积合理（说明真的画上了地图与图例）',
  png && png.type === 'image/png' && png.kb > 15, png ? `${png.kb} KB` : '没捕获到 Blob');

console.log(`\n================ ${pass} 通过 / ${fail} 失败 ================`);
console.log(`截图目录：${OUT}`);
ws.close();
chrome.kill();
server.close();
if (fail > 0) process.exitCode = 1;
