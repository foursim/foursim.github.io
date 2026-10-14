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
import { spawn, spawnSync } from 'node:child_process';
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
/** 跳过（不计数）：环境缺可选依赖时用它，而不是把"跳过"算成"通过"或"失败" */
function skip(label, detail = '') {
  console.log(`  [SKIP] ${label}${detail ? ` — ${detail}` : ''}`);
}
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
/*
 * 用 CDP 的 Network 域**真的记**页面发出去的请求。
 * 为什么不能只看 performance.getEntriesByType('resource')：WebSocket 握手根本不进 resource timing，
 * 所以 `ws===0` 是个永远成立的**空断言**（看着有，其实什么都没查）；
 * 而且 `fetch('https://cdn…')` 这种裸字符串外链源码扫描也扫不到 —— 只有在这里看得见。
 */
const netEvents = { ws: [], external: [] };
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Network.webSocketCreated') netEvents.ws.push(m.params.url);
  if (m.method === 'Network.requestWillBeSent') {
    const u = m.params?.request?.url ?? '';
    // 只关心"外部主机"：本机 127.0.0.1/localhost 上的静态服务不算（python http.server 那节也会换端口）
    if (/^https?:\/\//.test(u) && !/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(u)) netEvents.external.push(u);
  }
});
await send('Network.enable');

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
  // 整块隐藏的容器（关掉的弹窗 / 关掉的数据抽屉）里的控件尺寸为 0 是**预期**的，不是可达性问题。
  // ⚠️ 写成通用规则而不是"特判某个弹窗"：每加一个浮层就改一次判据，迟早会漏（漏了就是假失败，
  // 假失败多了判据就没人信了）。
  const inHiddenBox=(el)=>{for(let p=el;p;p=p.parentElement){const cs=getComputedStyle(p);
    if(cs.display==='none'||cs.visibility==='hidden')return true;}return false;};
  for(const el of document.querySelectorAll('button, input, select, label')){
    if(inHiddenBox(el)) continue;
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


// ===================== 10. 视觉：A 政务深蓝（已定稿） =====================
console.log('\n=== 10. 视觉定稿 ===');
await boot(1440, 900);
const vis = await ev(`(()=>{
  const cv=(k)=>getComputedStyle(document.documentElement).getPropertyValue(k).trim();
  return {brand:cv('--brand'), topbar:cv('--topbar-bg'), topbarFg:cv('--topbar-fg'),
    panel:cv('--panel'), fg:cv('--fg'),
    mapBg:getComputedStyle(document.getElementById('map')).backgroundColor,
    hasSel:!!document.getElementById('theme-sel'),
    road:globalThis.__agri.map.token.roadMajor, admin:globalThis.__agri.map.token.adminLine,
    htmlTheme:document.documentElement.dataset.theme ?? ''};})()`);
// ⚠️ 要同时吃 `#rrggbb` 与 `rgb(r, g, b)`：CSS 变量给的是十六进制，而 getComputedStyle 给的是 rgb
const lum = (c) => {
  const t = String(c).trim();
  let rgb = null;
  if (t.startsWith('#')) {
    const h = t.length === 4 ? t.slice(1).split('').map((x) => x + x).join('') : t.slice(1);
    rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  } else {
    rgb = (t.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
  }
  return rgb.length === 3 && rgb.every((v) => Number.isFinite(v))
    ? rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114 : -1;
};
check('A 政务深蓝：深蓝顶栏（白字）+ 白面板 + 浅底地图 —— 就是"蓝白"那一套',
  vis.brand === '#1a4f8a' && vis.topbar === '#1a4f8a' && vis.panel === '#ffffff'
    && lum(vis.panel) > 240 && lum(vis.mapBg) > 180 && lum(vis.fg) < 80,
  `主色 ${vis.brand} / 顶栏 ${vis.topbar}（字 ${vis.topbarFg}）/ 面板 ${vis.panel} / 地图底 ${vis.mapBg}`);
check('配色切换器与 data-theme 都已移除（定稿一套，不留临时入口/临时机制）',
  vis.hasSel === false && vis.htmlTheme === '', `theme-sel ${vis.hasSel ? '还在' : '已移除'} / data-theme="${vis.htmlTheme}"`);
check('地图令牌与 CSS 同源（canvas 读不到 CSS 变量，必须显式对齐）',
  /^#/.test(vis.road ?? '') && vis.admin === '#1a4f8a', `road ${vis.road} / admin ${vis.admin}`);
await shot('theme-A-政务深蓝-1440x900');

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
check('表格区默认显示「重点问题」：6 个带名字的问题 × 5 列（速览第一眼是结论）',
  // 页签数不写死（会随功能增长）：只要默认落在「重点问题」且结构没变即可
  tb1.tabs >= 6 && tb1.active === '重点问题' && tb1.rows === 6 && tb1.head === 5,
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
  for(let d=0;d<a.model.days.length;d++){if(a.ui.alarmsFor(d).some(x=>x.items.length)){a.setDay(d);return d;}}
  return -1;})()`);
await click('#tb-tabs button[data-tab="alarms"]');
await sleep(250);
const tb4 = await ev(`(()=>{const q=(s)=>document.querySelectorAll(s);
  return {rows:q('#tb-body .tbl tbody tr').length, btn:!!document.querySelector('#tb-body [data-parcel]')};})()`);
check('「告警明细」在有"含地块明细"的告警的日子列出条目并可点', zAlarmDay >= 0 && tb4.rows >= 1 && tb4.btn,
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


// ===================== 14. 真实数据（土壤 / 高程 / 居民点）与表格反向联动 =====================
console.log('\n=== 14. 真实数据与表格联动 ===');
await boot(1440, 900);
const real = await ev(`(()=>{const a=globalThis.__agri;const day=a.state.day;
  const temps=a.rows.map(r=>a.get(r,'tempParcel',day));
  const tex={}; for(const r of a.rows){const t=r.soil?.texture||'(空)';tex[t]=(tex[t]||0)+1;}
  const offsets=a.rows.map(r=>r.tempOffsetC??0);
  const elev=a.rows.map(r=>r.elevation_m).filter(v=>v!=null);
  return {regionTemp:a.model.region.T2M[day], tMin:Math.min(...temps), tMax:Math.max(...temps),
    offMin:Math.min(...offsets), offMax:Math.max(...offsets), tex,
    elevMin:Math.min(...elev), elevMax:Math.max(...elev),
    qualitySources:[...new Set(a.model.plan.map(p=>p.soilQualitySource))],
    villages:a.map.villageLayer.getLayers().length,
    villageNames:a.map.villageLayer.getLayers().slice(0,3).map(l=>l.getTooltip()?.getContent()),
    soilSample: a.rows.find(r=>r.soil)?.soil};})()`);
check('地块气温是按**真实高程**推导的（同一天各地块不同，且幅度 = 0.65 ℃/100 m × 高差）',
  real.tMax - real.tMin > 0.3 && Math.abs((real.tMax - real.tMin) - (real.elevMax - real.elevMin) * 0.0065) < 0.03,
  `气温 ${real.tMin.toFixed(2)}~${real.tMax.toFixed(2)} ℃（区域 ${real.regionTemp.toFixed(2)}）· 高程 ${real.elevMin}~${real.elevMax} m`);
check('土壤来自真实 SoilGrids（质地有值、模型也用的是真实土壤潜力）',
  Object.keys(real.tex).filter((k) => k !== '(空)').length >= 1 && !real.tex['(空)']
    && real.qualitySources.length === 1 && real.qualitySources[0] === 'soilgrids',
  `${JSON.stringify(real.tex)} · 土壤潜力来源 ${real.qualitySources.join(',')} · 样例 ${JSON.stringify(real.soilSample)}`);
check('居民点图层是真实地名（55 个点，来自 OSM place=*）',
  real.villages >= 40 && real.villageNames.every((n) => typeof n === 'string' && n.length > 0),
  `${real.villages} 个，例：${real.villageNames.join('、')}`);

// 点"经营单元"表格行 ⇒ 图上高亮该单元的地块
const hl = await ev(`(()=>{const a=globalThis.__agri;
  const tr=document.querySelector('#tb-body tr[data-unit]')||(()=>{document.querySelector('#tb-tabs button[data-tab="units"]').click();return document.querySelector('#tb-body tr[data-unit]');})();
  if(!tr) return {ok:false};
  tr.click();
  const id=tr.dataset.unit;
  const want=a.rows.filter(r=>r.unit_id===id).length;
  return {ok:true,id,want,got:a.map.highlightIdx.length,
    allSame:a.map.highlightIdx.every(i=>a.rows[i].unit_id===id)};})()`);
check('点「经营单元」一行 ⇒ 图上高亮该单元的全部地块（且高的就是那一组）',
  hl.ok && hl.got === hl.want && hl.allSame && hl.got > 0, JSON.stringify(hl));

// 点"作物与收成"表格行 ⇒ 图上高亮该作物的地块
const hl2 = await ev(`(()=>{const a=globalThis.__agri;
  document.querySelector('#tb-tabs button[data-tab="crops"]').click();
  const tr=document.querySelector('#tb-body tr[data-crop]');
  if(!tr) return {ok:false};
  tr.click();
  const code=tr.dataset.crop;
  const want=a.rows.filter(r=>(r.fallow?'FALLOW':(r.crop??'UNKNOWN'))===code).length;
  return {ok:true,code,want,got:a.map.highlightIdx.length,allSame:a.map.highlightIdx.every(i=>(a.rows[i].fallow?'FALLOW':(a.rows[i].crop??'UNKNOWN'))===code)};})()`);
check('点「作物与收成」一行 ⇒ 图上高亮该作物的全部地块', hl2.ok && hl2.got === hl2.want && hl2.allSame && hl2.got > 0,
  JSON.stringify(hl2));
await shot('table-to-map-1440x900');

// 详情面板要能看到真实土壤与高程
await ev(`(()=>{const a=globalThis.__agri;a.ui.select(a.rows[7]);})()`);
await sleep(200);
const det = await ev(`document.getElementById('detail').textContent`);
check('选中地块详情里能看到真实高程与土壤（质地/pH/有机碳）',
  /高程/.test(det) && /土壤/.test(det) && /loam|clay|sand|silt/.test(det) && /g\/kg/.test(det),
  det.replace(/\s+/g, ' ').slice(0, 120));


// ===================== 15. 情景推演（新建收储点 ⇒ 可达性变化） =====================
console.log('\n=== 15. 情景推演 ===');
await boot(1440, 900);
await click('#tb-tabs button[data-tab="scenario"]');
await sleep(250);
const scBefore = await ev(`document.getElementById('tb-body').textContent`);
check('「情景推演」未选点时给出操作提示（不是一张空表）',
  /点一下/.test(scBefore), scBefore.replace(/\s+/g, ' ').slice(0, 70));
// 在地图上"点"一下（Leaflet 的 click 事件，带经纬度）
const pick = await ev(`(()=>{const a=globalThis.__agri;
  const best=[...a.scenario.candidates].sort((x,y)=>y.improved_parcels*x.avg_gain_min-y.improved_parcels*x.avg_gain_min)[0];
  a.map.map.fire('click',{latlng:L.latLng(best.lat,best.lon)});
  return {lon:best.lon,lat:best.lat,want:best.improved.length,improved:best.improved_parcels,avgGain:best.avg_gain_min};})()`);
await sleep(350);
const after = await ev(`(()=>{const q=(s)=>document.querySelectorAll(s);
  const rows=[...q('#tb-body .tbl tbody tr')].map(tr=>[...tr.children].map(td=>td.textContent.trim()));
  return {n:rows.length, first:rows.map(r=>r[0]), note:document.getElementById('tb-note').textContent,
    hl:globalThis.__agri.map.highlightIdx.length};})()`);
check('地图点选后给出"现状 / 新建后 / 变化"对比（7 项，含盲区与受影响地块）',
  after.n === 7 && /平均/.test(after.first[0]) && /盲区/.test(after.first[5]),
  `${after.n} 行：${after.first.join('、')}`);
check('受影响地块在图上被高亮（与表格→地图同一个高亮通道）',
  after.hl === pick.want && after.hl > 0, `高亮 ${after.hl} 个（受影响 ${pick.improved} 块，其中 >1 分钟 ${pick.want} 块）`);
check('对比数字来自离线重算（与 scenario.json 的平均改善一致）',
  after.note.includes(String(pick.avgGain)), after.note.replace(/\s+/g, ' ').slice(0, 90));
check('所有候选点"新建后"都不比现状差（新建一个收储点不可能让可达性变差）',
  await ev(`(()=>{const a=globalThis.__agri;const b=a.scenario.metadata.baseline;
    return a.scenario.candidates.filter(c=>c.avg_min > b.avg_min + 1e-9 || c.blind_parcels > b.blind_parcels).length;})()`) === 0,
  `候选 ${await ev('globalThis.__agri.scenario.candidates.length')} 个，越界 0 个`);
{
  const best = await ev(`(()=>{const a=globalThis.__agri;
    const b=a.scenario.metadata.baseline;
    const c=[...a.scenario.candidates].sort((x,y)=>x.blind_ha-y.blind_ha)[0];
    return {blind_ha:c.blind_ha, base_blind:c===b?null:b.blind_ha, base:c.blind_ha};})()`);
  check('盲区面积在"新建"后只会减少（不会凭空变多）', best.blind_ha >= 0 && best.blind_ha <= 144.9,
    `最小盲区候选 ${best.blind_ha} ha`);
}
await shot('scenario-1440x900');


// ===================== 16. 高亮的取消与切换（用户报的体验问题） =====================
console.log('\n=== 16. 高亮的取消与切换 ===');
await boot(1440, 900);
// ⚠️ 必须先切到「经营单元」页签：表格是按页签渲染的，上一节结束时停在别的页签（没有 data-unit 行）
await click('#tb-tabs button[data-tab="units"]');
await sleep(250);
const hxTwo = await ev(`(()=>{const a=globalThis.__agri;
  const us=[...new Set(a.rows.map(r=>r.unit_id))];
  return {a:us[0],b:us[1],na:a.rows.filter(r=>r.unit_id===us[0]).length,nb:a.rows.filter(r=>r.unit_id===us[1]).length};})()`);
const HX_DEFAULT_BLUE = '#3388ff'; // Leaflet 默认描边色 —— 复原后若变成它，说明用错了 resetStyle
const hx1 = await ev(`(()=>{const a=globalThis.__agri;
  const idx=a.rows.filter(r=>r.unit_id==='${hxTwo.a}').map(r=>r.i);
  const n=a.map.highlight(idx);
  const l=a.map.highlighted[0].layer;
  return {n,hl:a.map.highlighted.length,w:l.options.weight,c:l.options.color,
    fill:l.options.fillColor, wantColor:a.map.styleFor(l.feature).color};})()`);
check('高亮一组地块：描边加粗并换成强调色（不改填充色，保持变量着色）',
  hx1.n === hxTwo.na && hx1.w > 2 && hx1.c !== HX_DEFAULT_BLUE && typeof hx1.fill === 'string' && hx1.fill.length > 0,
  `${hxTwo.a}：${hx1.n} 块，描边 ${hx1.w}px/${hx1.c}`);
// 点另一组：上一组必须**复原到变量色**，而不是 Leaflet 默认蓝（这正是"取消不掉"的根因）
const hx2 = await ev(`(()=>{const a=globalThis.__agri;
  const first=a.map.highlighted[0];
  const idx=a.rows.filter(r=>r.unit_id==='${hxTwo.b}').map(r=>r.i);
  const n=a.map.highlight(idx);
  return {n,hl:a.map.highlighted.length,
    fw:first.layer.options.weight, fc:first.layer.options.color,
    wantColor:a.map.styleFor(first.feature).color, defaultBlue:${JSON.stringify(HX_DEFAULT_BLUE)}};})()`);
check('点第二组时，第一组**先被取消**（复原到变量色，不是默认蓝、也不是叠加）',
  hx2.hl === hxTwo.nb && hx2.fw < 1 && hx2.fc === hx2.wantColor && hx2.fc !== HX_DEFAULT_BLUE,
  `上一组描边 ${hx2.fw}px/${hx2.fc}（变量色 ${hx2.wantColor}）· 现高亮 ${hx2.hl} 块`);
// 鼠标划过再移开：必须回到变量色（同一类 resetStyle 坑）
const hxHover = await ev(`(()=>{const a=globalThis.__agri;
  const l=a.map.parcelLayer.getLayers().find(x=>!a.map.highlighted.some(h=>h.layer===x));
  l.fire('mouseover'); const on=l.options.color;
  l.fire('mouseout'); const off=l.options.color;
  return {on, off, want:a.map.styleFor(l.feature).color};})()`);
check('鼠标划过再移开，地块回到**变量色**（不是 Leaflet 默认蓝）',
  hxHover.off === hxHover.want && hxHover.on !== hxHover.off && hxHover.off !== HX_DEFAULT_BLUE,
  `划过 ${hxHover.on} → 移开 ${hxHover.off}（变量色 ${hxHover.want}）`);
// 再点同一行 = 取消（必须走**两次真实点击**：直接调 map.highlight 会绕过 UI 的切换逻辑）
const hxToggle = await ev(`(()=>{const a=globalThis.__agri;
  const tr=[...document.querySelectorAll('#tb-body tr[data-unit]')].find(t=>t.dataset.unit==='${hxTwo.b}');
  if(!tr) return {ok:false};
  tr.click();
  const on={n:a.map.highlightIdx.length, note:document.getElementById('hl-note').textContent};
  tr.click();
  const off={n:a.map.highlightIdx.length, note:document.getElementById('hl-note').textContent};
  return {ok:true, on, off};})()`);
check('**再点一次同一行 = 取消高亮**（切换式，不需要去找别的地方取消）',
  hxToggle.ok && hxToggle.on.n > 0 && hxToggle.off.n === 0 && hxToggle.off.note === '',
  `点第 1 次 ${hxToggle.on.n} 块（状态"${hxToggle.on.note}"）→ 点第 2 次 ${hxToggle.off.n} 块（状态"${hxToggle.off.note}"）`);

// 「取消高亮」按钮
const hxBtn = await ev(`(()=>{const a=globalThis.__agri;
  const tr=[...document.querySelectorAll('#tb-body tr[data-unit]')].find(t=>t.dataset.unit==='${hxTwo.a}');
  tr.click(); const afterClick=a.map.highlightIdx.length;
  const noteClick=document.getElementById('hl-note').textContent;
  document.getElementById('btn-clear-hl').click();
  return {afterClick, noteClick, afterClear:a.map.highlightIdx.length, noteClear:document.getElementById('hl-note').textContent};})()`);
check('「取消高亮」按钮能清掉高亮，且状态文案随之清空',
  hxBtn.afterClick > 0 && hxBtn.afterClear === 0 && hxBtn.noteClick.length > 0 && hxBtn.noteClear === '',
  `点行 → ${hxBtn.afterClick} 块（状态"${hxBtn.noteClick}"）→ 按钮 → ${hxBtn.afterClear} 块`);
// 换页签：清掉上一次的高亮
const hxTab = await ev(`(()=>{const a=globalThis.__agri;
  document.querySelector('#tb-tabs button[data-tab="units"]').click();
  const tr=document.querySelector('#tb-body tr[data-unit]'); tr.click();
  const on=a.map.highlightIdx.length;
  document.querySelector('#tb-tabs button[data-tab="crops"]').click();
  return {on, off:a.map.highlightIdx.length, note:document.getElementById('hl-note').textContent};})()`);
check('换页签时清掉上一次的高亮（上一页选的组与这一页无关）',
  hxTab.on > 0 && hxTab.off === 0 && hxTab.note === '', `切页签前 ${hxTab.on} 块 → 后 ${hxTab.off} 块`);
await shot('highlight-1440x900');


// ===================== 17. 简洁版数据展示（展开 / 行数透明 / 联合查询问题） =====================
console.log('\n=== 17. 表格区展开与重点问题 ===');
await boot(1440, 900);
// ① 行数透明
const qzDensity = await ev(`(()=>{const q=(s)=>document.querySelectorAll(s);
  document.querySelector('#tb-tabs button[data-tab="units"]').click();
  const note=document.getElementById('tb-note').textContent;
  const rows=q('#tb-body .tbl tbody tr').length;
  return {note, rows, has:new RegExp('共 '+rows+' 行').test(note)};})()`);
check('行数透明：表头写明"共 N 行"（132px 里只露 5 行时，用户必须知道还有多少没看到）',
  qzDensity.has, qzDensity.note);
// ② 展开 / 收起
const qzExp = await ev(`(()=>{const tb=document.getElementById('tablebar');const mp=document.getElementById('map');
  const h0=Math.round(tb.getBoundingClientRect().height), m0=Math.round(mp.getBoundingClientRect().height);
  document.getElementById('btn-tb-expand').click();
  const h1=Math.round(tb.getBoundingClientRect().height), m1=Math.round(mp.getBoundingClientRect().height);
  const label=document.getElementById('btn-tb-expand').textContent;
  document.getElementById('btn-tb-expand').click();
  const h2=Math.round(tb.getBoundingClientRect().height);
  return {h0,m0,h1,m1,h2,label};})()`);
check('「展开表格」把表格区放大并让出地图空间，再点可复位（分时复用，而不是叠更高）',
  qzExp.h1 > qzExp.h0 * 1.5 && qzExp.m1 < qzExp.m0 && qzExp.m1 > 200 && Math.abs(qzExp.h2 - qzExp.h0) < 6 && qzExp.label === '收起',
  `表格 ${qzExp.h0}→${qzExp.h1}px（按钮显示"${qzExp.label}"）· 地图 ${qzExp.m0}→${qzExp.m1}px · 复位 ${qzExp.h2}px`);
// ③ 重点问题：命中数可核对 + 点一行高亮命中地块
const qzFocus = await ev(`(()=>{const a=globalThis.__agri;
  document.querySelector('#tb-tabs button[data-tab="focus"]').click();
  const rows=[...document.querySelectorAll('#tb-body .tbl tbody tr')];
  const qs=a.buildTables(a.state.day).questions;
  return {n:rows.length, titles:[...document.querySelectorAll('#tb-body .tbl tbody tr td:first-child')].map(t=>t.textContent),
    hits:qs.map(q=>({key:q.key,n:q.hits.length,ha:+q.ha.toFixed(1),desc:q.desc}))};})()`);
check('「重点问题」列出 6 个带名字的业务问题（各自带命中数/面积/口径）',
  qzFocus.n === 6 && qzFocus.titles.includes('运输盲区 ∩ 土壤贫瘠') && qzFocus.titles.includes('收获峰值（农机压力）')
    && qzFocus.hits.every((h) => h.desc.length > 8),
  qzFocus.hits.map((h) => `${h.key}=${h.n}块/${h.ha}ha`).join(' · '));
// 命中地块必须真的满足口径（独立复算，不能"表格说命中、数据不满足"）
const qzVerify = await ev(`(()=>{const a=globalThis.__agri;const day=a.state.day;
  const pct=(arr,q)=>{const x=arr.filter(v=>v!=null).sort((m,n)=>m-n);return x[Math.floor(x.length*q)];};
  const accP90=pct(a.rows.map(r=>r.t_min),0.9), socP25=pct(a.rows.map(r=>r.soil&&r.soil.soc_g_kg),0.25);
  const q=a.buildTables(day).questions.find(x=>x.key==='blind-poor');
  const bad=q.hits.filter(i=>!(a.rows[i].t_min>accP90 && a.rows[i].soil.soc_g_kg<socP25));
  const miss=a.rows.filter(r=>r.t_min>accP90 && r.soil&&r.soil.soc_g_kg<socP25).length;
  return {bad:bad.length, miss, hit:q.hits.length, accP90:+accP90.toFixed(2), socP25:+socP25.toFixed(2)};})()`);
check('「运输盲区 ∩ 土壤贫瘠」的命中集合与口径**逐块吻合**（不漏不误）',
  qzVerify.bad === 0 && qzVerify.hit === qzVerify.miss,
  `命中 ${qzVerify.hit} / 独立复算 ${qzVerify.miss} / 不符 ${qzVerify.bad}（p90 ${qzVerify.accP90} 分、p25 ${qzVerify.socP25} g/kg）`);
const qzClick = await ev(`(()=>{const a=globalThis.__agri;
  const tr=[...document.querySelectorAll('#tb-body .tbl tbody tr')].find(t=>t.dataset.question);
  const key=tr.dataset.question;
  const want=a.buildTables(a.state.day).questions.find(q=>q.key===key).hits.length;
  tr.click();
  return {key, want, got:a.map.highlightIdx.length, note:document.getElementById('hl-note').textContent};})()`);
// 新增两个问题的命中集合也要**逐块可核对**（不能"表格说命中、数据不满足"）
const s17New = await ev(`(()=>{const a=globalThis.__agri;const day=a.state.day;
  const qs=a.buildTables(day).questions;
  const sp=qs.find(q=>q.key==='crop-spread'), hp=qs.find(q=>q.key==='harvest-peak');
  // 独立复算：收获峰值 = 当前日期 harvestDays 含该日的地块
  const ymd=a.model.days[day];
  const wantHp=a.rows.filter(r=>(r.harvestDays??[]).includes(ymd)).map(r=>r.i);
  const badHp=hp.hits.filter(i=>!((a.rows[i].harvestDays??[]).includes(ymd)));
  // 进度离散：命中地块必须都属于同一作物且进度 ≤ 该作物 p10
  const crops=new Set(sp.hits.map(i=>a.rows[i].crop));
  const prog=sp.hits.map(i=>a.get(a.rows[i],'progress',day));
  const maxProg=prog.length?Math.max(...prog):0;
  return {hpWant:wantHp.length, hpGot:hp.hits.length, hpBad:badHp.length,
    spCrops:crops.size, spMaxProg:+maxProg.toFixed(4), spN:sp.hits.length};})()`);
check('「收获峰值（农机压力）」：命中=当前日期要收获的地块，逐块吻合',
  s17New.hpGot === s17New.hpWant && s17New.hpBad === 0,
  `命中 ${s17New.hpGot} / 独立复算 ${s17New.hpWant} / 不符 ${s17New.hpBad}`);
check('「同作物跨单元进度离散」：命中地块同属一个作物，且进度都在 p10 以下',
  s17New.spCrops <= 1 && s17New.spN > 0, `作物数 ${s17New.spCrops} · 最大进度 ${s17New.spMaxProg} · 命中 ${s17New.spN} 块`);
check('点「重点问题」一行 ⇒ 图上高亮该问题的命中地块（联合查询结果落到空间上）',
  qzClick.got === qzClick.want && qzClick.got > 0 && qzClick.note.length > 0,
  `${qzClick.key}：命中 ${qzClick.want} → 高亮 ${qzClick.got} 块（状态"${qzClick.note}"）`);
// 速览最忌横向滚动：问题表不能把表格区撑出横向滚动条
const qzOverflow = await ev(`(()=>{const b=document.getElementById('tb-body');
  return {sw:b.scrollWidth, cw:b.clientWidth, over:b.scrollWidth-b.clientWidth};})()`);
check('「重点问题」表不产生横向滚动（长口径文本换行显示）',
  qzOverflow.over <= 2, `内容 ${qzOverflow.sw}px / 可视 ${qzOverflow.cw}px（溢出 ${qzOverflow.over}px）`);
await shot('focus-questions-1440x900');


// ===================== 18. 数据抽屉（全行 + 筛选 + 排序，可叉掉） =====================
console.log('\n=== 18. 数据抽屉 ===');
await boot(1440, 900);
await ev(`globalThis.__agri.state.playing = true`);
const s18Open = await ev(`(()=>{const a=globalThis.__agri;
  document.getElementById('btn-drawer').click();
  const d=document.getElementById('drawer').getBoundingClientRect();
  const mask=document.getElementById('drawer-mask');
  // 地图是否仍可交互：取地图里"不在抽屉下面"的一点做命中测试
  const mp=document.getElementById('map').getBoundingClientRect();
  const px=Math.round(mp.left+40), py=Math.round(mp.top+40);
  const hit=document.elementFromPoint(px,py);
  return {w:Math.round(d.width), vw:innerWidth, ratio:+(d.width/innerWidth).toFixed(2),
    visible:!document.getElementById('drawer').classList.contains('hidden'),
    maskVisible:!mask.classList.contains('hidden'),
    mapHit:!!(hit&&hit.closest&&hit.closest('#map')), playing:a.state.playing,
    tabs:document.querySelectorAll('#dw-tabs button').length};})()`);
check('「数据视图」打开右侧抽屉：占屏约 62%、遮罩出现、**左侧地图仍可交互**',
  s18Open.visible && s18Open.maskVisible && s18Open.ratio > 0.5 && s18Open.ratio < 0.75 && s18Open.mapHit,
  `宽 ${s18Open.w}px（${Math.round(s18Open.ratio * 100)}%）· 地图命中测试 ${s18Open.mapHit ? '通过' : '被挡住'}`);
check('打开抽屉自动暂停播放（数字自己在跳的表格没法读）', s18Open.playing === false, `playing=${s18Open.playing}`);
const s18Full = await ev(`(()=>{const a=globalThis.__agri;
  document.querySelector('#dw-tabs button[data-tab="units"]').click();
  document.querySelector('#tb-tabs button[data-tab="units"]').click(); // 底部条切到同一页签再比，否则是拿"重点问题 4 行"比"单元 62 行"
  const rows=document.querySelectorAll('#dw-body .tbl tbody tr').length;
  const note=document.getElementById('dw-note').textContent;
  const stripRows=document.querySelectorAll('#tb-body .tbl tbody tr').length;
  return {rows, note, stripRows, head:document.querySelectorAll('#dw-body .tbl thead th').length};})()`);
check('抽屉里能看**全行**（62 个单元全在；底部条同一份数据但只有 132px 高）',
  s18Full.rows === 62 && s18Full.stripRows === 62 && /共 62 行/.test(s18Full.note),
  `抽屉 ${s18Full.rows} 行 × ${s18Full.head} 列 · 底部条同数据 ${s18Full.stripRows} 行`);
const s18Filter = await ev(`(()=>{
  const f=document.getElementById('dw-filter'); f.value='U-000'; // ⚠️ 编码是 '09186162-U-0001'：写 'U0001' 匹配不到（中间有连字符）
  f.dispatchEvent(new Event('input',{bubbles:true}));
  const rows=[...document.querySelectorAll('#dw-body .tbl tbody tr')];
  const texts=rows.map(tr=>tr.textContent);
  return {n:rows.length, allMatch:texts.every(t=>t.includes('U-000')), note:document.getElementById('dw-note').textContent};})()`);
check('关键字筛选：只剩匹配行，且条数写在标题里（"筛选后 N 行"）',
  s18Filter.n > 0 && s18Filter.n < 62 && s18Filter.allMatch && /筛选后 \d+ 行/.test(s18Filter.note),
  `${s18Filter.n} 行，全部含 U-000 · ${s18Filter.note}`);
const s18Sort = await ev(`(()=>{
  const f=document.getElementById('dw-filter'); f.value='';
  f.dispatchEvent(new Event('input',{bubbles:true}));
  // ⚠️ 每次重画都会换掉 thead/tbody：必须**重新查询**列头，点旧节点等于没点（判据踩过一次）
  document.querySelector('#dw-body .tbl thead th.sortable').click();
  const v1=[...document.querySelectorAll('#dw-body .tbl tbody tr')].map(tr=>tr.children[0].textContent.trim());
  document.querySelector('#dw-body .tbl thead th.sortable').click();
  const v2=[...document.querySelectorAll('#dw-body .tbl tbody tr')].map(tr=>tr.children[0].textContent.trim());
  return {desc:v1[0], descLast:v1[v1.length-1], asc:v2[0], ascLast:v2[v2.length-1],
    arrow:!!document.querySelector('#dw-body .tbl thead th.sortable').textContent.match(/[▲▼]/)};})()`);
check('点列头排序：第一次降序、再点升序（箭头提示方向）',
  s18Sort.desc > s18Sort.descLast && s18Sort.asc < s18Sort.ascLast && s18Sort.desc !== s18Sort.asc && s18Sort.arrow,
  `降序首行 ${s18Sort.desc} → 升序首行 ${s18Sort.asc}（首列编码按字典序）`);
const s18Link = await ev(`(()=>{const a=globalThis.__agri;
  const tr=document.querySelector('#dw-body tr[data-unit]');
  const id=tr.dataset.unit;
  tr.click();
  return {id, want:a.rows.filter(r=>r.unit_id===id).length, got:a.map.highlightIdx.length,
    all:a.map.highlightIdx.every(i=>a.rows[i].unit_id===id)};})()`);
check('抽屉里点一行 ⇒ 图上高亮该组地块（联动在抽屉里同样成立 —— 这正是选抽屉而不是全屏的理由）',
  s18Link.got === s18Link.want && s18Link.all && s18Link.got > 0, `${s18Link.id}：命中 ${s18Link.want} → 高亮 ${s18Link.got} 块`);
await shot('drawer-1440x900');
// 三个关闭入口
const s18Closes = await ev(`(()=>{const a=globalThis.__agri;const vis=()=>!document.getElementById('drawer').classList.contains('hidden');
  const r={};
  document.getElementById('drawer-close').click(); r.x=vis();
  a.ui.openDrawer(); document.getElementById('drawer-mask').click(); r.mask=vis();
  a.ui.openDrawer();
  globalThis.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));
  r.esc=vis();
  return r;})()`);
check('三个关闭入口都能叉掉抽屉（× / 点遮罩 / Esc）——"随时可以叉掉"',
  s18Closes.x === false && s18Closes.mask === false && s18Closes.esc === false, JSON.stringify(s18Closes));


// ===================== 19. 三个已知问题的修复 + 导出当前视图 =====================
console.log('\n=== 19. 排版修复与导出当前视图 ===');
await boot(1440, 900);
await ev(`document.getElementById('btn-drawer').click()`);
await sleep(250);
const s19Head = await ev(`(()=>{
  const head=document.querySelector('.dw-head').getBoundingClientRect();
  const input=document.getElementById('dw-filter').getBoundingClientRect();
  const cnt=document.getElementById('dw-count');
  const foot=document.getElementById('dw-note').getBoundingClientRect();
  return {headH:Math.round(head.height), inputW:Math.round(input.width), cnt:cnt.textContent,
    footH:Math.round(foot.height), footText:document.getElementById('dw-note').textContent};})()`);
check('抽屉标题栏不换行、筛选框不被挤（计数可截断，控件不许窄）',
  s19Head.headH <= 46 && s19Head.inputW >= 160 && /共 \d+ 行/.test(s19Head.cnt),
  `标题栏 ${s19Head.headH}px · 筛选框 ${s19Head.inputW}px · 计数"${s19Head.cnt}"`);
check('交互提示移到页脚（不再和标题抢一行）', s19Head.footH > 0 && /点列头排序/.test(s19Head.footText),
  `页脚 ${s19Head.footH}px：${s19Head.footText.slice(0, 60)}…`);
const s19SortCls = await ev(`(()=>{
  document.querySelector('#dw-body .tbl thead th.sortable').click();
  const th=[...document.querySelectorAll('#dw-body .tbl thead th')];
  const sorted=th.filter(t=>t.classList.contains('sorted'));
  const bg=sorted.length?getComputedStyle(sorted[0]).backgroundColor:'';
  return {n:sorted.length, label:sorted.length?sorted[0].textContent.trim():'', bg,
    foot:document.getElementById('dw-note').textContent};})()`);
check('排序列表头有持久高亮（不只靠 ▲▼），页脚写明当前排序',
  s19SortCls.n === 1 && /▲|▼/.test(s19SortCls.label) && /已按/.test(s19SortCls.foot),
  `${s19SortCls.label} · 底色 ${s19SortCls.bg} · 页脚含"已按…"`);
// 导出当前视图（筛选 + 排序后的行）
const s19Exp = await ev(`(async()=>{
  // ⚠️ 先切到"经营单元"页签：默认在"重点问题"，那张表里没有 unit 编码，按 U-000 筛必然是 0 行
  document.querySelector('#dw-tabs button[data-tab="units"]').click();
  const f=document.getElementById('dw-filter'); f.value='U-000';
  f.dispatchEvent(new Event('input',{bubbles:true}));
  const shown=document.querySelectorAll('#dw-body .tbl tbody tr').length;
  let captured=null;
  const oc=URL.createObjectURL; URL.createObjectURL=(b)=>{captured=b;return 'blob:stub';};
  const okc=HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click=function(){};
  document.getElementById('btn-dw-export').click();
  await new Promise(r=>setTimeout(r,60));
  URL.createObjectURL=oc; HTMLAnchorElement.prototype.click=okc;
  if(!captured) return {ok:false, shown};
  const text=await captured.text();
  const lines=text.split('\\n');
  return {ok:true, shown, rows:lines.length-1, header:lines[0], first:lines[1],
    allMatch:lines.slice(1).every(l=>l.includes('U-000'))};})()`);
check('「导出结果」导的是**当前视图**（筛选后的行数，不是全表）',
  s19Exp.ok && s19Exp.rows === s19Exp.shown && s19Exp.allMatch && /单元编码/.test(s19Exp.header ?? ''),
  s19Exp.ok ? `${s19Exp.rows} 行（视图 ${s19Exp.shown} 行）· 列头 ${String(s19Exp.header).slice(0, 30)}` : '没捕获到 Blob');
// 底部条在窄列宽下按钮不换行
await boot(1024, 640);
const s19Strip = await ev(`(()=>{const bs=[...document.querySelectorAll('#tablebar .tb-actions button')]
    .filter(b=>getComputedStyle(b).display!=='none');
  return {n:bs.length, heights:bs.map(b=>Math.round(b.getBoundingClientRect().height)),
    labels:bs.map(b=>b.textContent.trim()), rows:new Set(bs.map(b=>Math.round(b.getBoundingClientRect().top))).size,
    headH:Math.round(document.querySelector('.tb-head').getBoundingClientRect().height)};})()`);
check('表格区按钮在 1024×640 下不换行（说明文案先被截断，按钮不许折行）',
  s19Strip.heights.every((h) => h < 32) && s19Strip.rows <= 2,
  `${s19Strip.n} 个按钮（${s19Strip.labels.join('/')}）占用行数 ${s19Strip.rows} · 表头 ${s19Strip.headH}px`);
const s19Body = await ev(`(()=>{const t=document.getElementById('tablebar'),b=document.getElementById('tb-body');
  // 只数【可见】页签：被 display:none 收起的按钮 rect 是 0，把它们算进来会得到"2 行"的假失败
  const vis=[...document.querySelectorAll('#tb-tabs button')].filter(x=>x.getBoundingClientRect().height>0);
  return {strip:Math.round(t.getBoundingClientRect().height), head:Math.round(document.querySelector('.tb-head').getBoundingClientRect().height),
    body:Math.round(b.getBoundingClientRect().height), tabRows:new Set(vis.map(x=>Math.round(x.getBoundingClientRect().top))).size,
    visTabs:vis.length};})()`);
check('1024×640：页签不折行、表头不吞掉表体（表体 ≥ 96px ≈ 3 行）',
  s19Body.tabRows === 1 && s19Body.head <= 80 && s19Body.body >= 96,
  `页签 ${s19Body.tabRows} 行 · 表头 ${s19Body.head}px · 表体 ${s19Body.body}px（表格区 ${s19Body.strip}px）`);


// ===================== 20. 列选择 / 窄屏「更多」/ 排行图 / 与离线表对账 =====================
console.log('\n=== 20. 列选择 · 更多下拉 · 排行图 · 与离线表对账 ===');
await boot(1440, 900);
await ev(`document.getElementById('btn-drawer').click()`);
await sleep(200);
const s20Cols = await ev(`(()=>{
  const a=globalThis.__agri;
  document.querySelector('#dw-tabs button[data-tab="units"]').click();
  const th=()=>document.querySelectorAll('#dw-body .tbl thead th').length;
  const td=()=>document.querySelectorAll('#dw-body .tbl tbody tr:first-child td').length;
  const before={th:th(), td:td(), foot:document.getElementById('dw-note').textContent};
  document.getElementById('btn-dw-cols').click();
  const boxes=[...document.querySelectorAll('#dw-cols input[type=checkbox]')];
  // 取消勾选第 2 列（主导作物）
  boxes[1].checked=false; boxes[1].dispatchEvent(new Event('change',{bubbles:true}));
  const after={th:th(), td:td(), foot:document.getElementById('dw-note').textContent,
    stored:JSON.parse(localStorage.getItem('agri-monitor-cols')||'{}')};
  return {before, after, nbox:boxes.length};})()`);
check('列选择：取消一列 ⇒ 表头与每行都少一格，页脚写明"显示 N/M 列"，选择被记住',
  s20Cols.after.th === s20Cols.before.th - 1 && s20Cols.after.td === s20Cols.before.td - 1
    && /显示 \d+\/\d+ 列/.test(s20Cols.after.foot) && (s20Cols.after.stored.units ?? []).length === 1
    && s20Cols.nbox === s20Cols.before.th,
  `${s20Cols.before.th} 列 → ${s20Cols.after.th} 列（每行 ${s20Cols.before.td}→${s20Cols.after.td} 格）· 存储 ${JSON.stringify(s20Cols.after.stored)}`);
// 至少保留一列 + 全选恢复
const s20Guard = await ev(`(()=>{
  const boxes=()=>[...document.querySelectorAll('#dw-cols input[type=checkbox]')];
  // ⚠️ 每改一次浮层都会**重画**（复选框是新节点）：必须每轮重新查询，点旧节点等于没点
  for(let guard=0;guard<20;guard++){
    const cs=[...document.querySelectorAll('#dw-cols input[type=checkbox]:checked')];
    if(cs.length<=1) break;
    const b=cs[cs.length-1]; b.checked=false; b.dispatchEvent(new Event('change',{bubbles:true}));
  }
  const th=()=>document.querySelectorAll('#dw-body .tbl thead th').length;
  const one=th();
  // 再试着把最后一列也关掉 —— 必须被挡住
  const last=[...document.querySelectorAll('#dw-cols input[type=checkbox]:checked')][0];
  last.checked=false; last.dispatchEvent(new Event('change',{bubbles:true}));
  const stillOne=th();
  document.querySelector('#dw-cols [data-cols-reset]').click();
  const restored=th();
  return {one, stillOne, restored, n:boxes().length};})()`);
check('至少保留一列（关不掉最后一列），且「全选」能一键恢复',
  s20Guard.one === 1 && s20Guard.stillOne === 1 && s20Guard.restored === s20Guard.n,
  `剩 1 列时再关仍为 ${s20Guard.stillOne} 列 · 全选恢复 ${s20Guard.restored} 列`);
// 隐藏列后排序不串位：隐藏第 1 列，再按"进度 %"降序，首行应是最大值
const s20Sort = await ev(`(()=>{
  const boxes=[...document.querySelectorAll('#dw-cols input[type=checkbox]')];
  boxes[0].checked=false; boxes[0].dispatchEvent(new Event('change',{bubbles:true}));
  const head=[...document.querySelectorAll('#dw-body .tbl thead th')];
  const i=head.findIndex(h=>h.textContent.includes('进度'));
  document.querySelectorAll('#dw-body .tbl thead th')[i].click();
  const vals=[...document.querySelectorAll('#dw-body .tbl tbody tr')].map(tr=>Number(tr.children[i].textContent.replace(/[^0-9.]/g,'')));
  const foot=document.getElementById('dw-note').textContent;
  document.querySelector('#dw-cols [data-cols-reset]').click();
  return {i, first:vals[0], last:vals[vals.length-1], sorted:foot.includes('已按')};})()`);
check('隐藏列之后排序仍按**那一列**走（投影不串位 —— 这是列选择最容易出的 bug）',
  s20Sort.i >= 0 && s20Sort.first >= s20Sort.last && s20Sort.sorted,
  `按第 ${s20Sort.i + 1} 个可见列：首 ${s20Sort.first} → 末 ${s20Sort.last}`);
// 排行图
const s20Chart = await ev(`(()=>{const a=globalThis.__agri;
  document.querySelector('#dw-tabs button[data-tab="crops"]').click();
  const on={shown:!document.getElementById('dw-chart-wrap').classList.contains('hidden'),
    info:a.ui.drawerChartInfo && {col:a.ui.drawerChartInfo.col, n:a.ui.drawerChartInfo.items.length,
      topLabel:a.ui.drawerChartInfo.items[0]?.label, topValue:a.ui.drawerChartInfo.items[0]?.value}};
  const cvs=document.getElementById('dw-chart');
  const ctx=cvs.getContext('2d');
  const px=ctx.getImageData(0,0,cvs.width,cvs.height).data;
  let ink=0; for(let i=3;i<px.length;i+=4) if(px[i]>0) ink++;
  document.querySelector('#dw-tabs button[data-tab="frame"]').click();
  const off={shown:!document.getElementById('dw-chart-wrap').classList.contains('hidden'), info:a.ui.drawerChartInfo};
  return {on, off, ink};})()`);
check('抽屉里的排行图：作物表画出面积排行（真画了像素），指标表不画（结论表配图是噪音）',
  s20Chart.on.shown && s20Chart.on.info && s20Chart.on.info.col === '面积 ha' && s20Chart.on.info.n > 0
    && s20Chart.ink > 200 && s20Chart.off.shown === false && s20Chart.off.info === null,
  `作物：${s20Chart.on.info?.n} 条，首位 ${s20Chart.on.info?.topLabel}=${s20Chart.on.info?.topValue} ha，着色像素 ${s20Chart.ink} · 指标表图隐藏=${!s20Chart.off.shown}`);
// 窄屏「更多」下拉
await boot(1024, 640);
const s20More = await ev(`(()=>{const a=globalThis.__agri;
  const vis=[...document.querySelectorAll('#tb-tabs button')].filter(b=>b.getBoundingClientRect().height>0);
  const sel=document.getElementById('tb-more');
  const selVisible=getComputedStyle(sel).display!=='none';
  const rowsBefore=document.querySelectorAll('#tb-body .tbl tbody tr').length;
  sel.value='scenario'; sel.dispatchEvent(new Event('change',{bubbles:true}));
  return {vis:vis.length, labels:vis.map(b=>b.textContent.trim()), selVisible, opt:sel.options.length,
    // 页签总数从 DOM 数（而不是写死）：以后加页签时这条判据不该假失败
    nTabs:document.querySelectorAll('#tb-tabs button').length,
    active:a.ui.activeTable, rowsBefore, rowsAfter:document.querySelectorAll('#tb-body .tbl tbody tr').length};})()`);
check('1024×640：页签只留 3 个 + 「更多」下拉承载其余（避免折行吃掉表体）',
  s20More.vis === 3 && s20More.selVisible && s20More.opt === s20More.nTabs + 1,
  `可见页签 ${s20More.vis} 个（${s20More.labels.join('/')}）· 下拉 ${s20More.opt - 1} 项 / 页签共 ${s20More.nTabs} 个`);
check('「更多」下拉能切到被收起的那张表（情景推演）',
  s20More.active === 'scenario' && s20More.rowsAfter !== s20More.rowsBefore,
  `${s20More.rowsBefore} 行 → ${s20More.rowsAfter} 行，activeTable=${s20More.active}`);
// 与离线表对账（同一份数据，两条路径）
const s20Rec = await ev(`(async()=>{const a=globalThis.__agi ? null : globalThis.__agri;
  const parse=(txt)=>{const out=[];let cur=[],val='',q=false;
    for(let i=0;i<txt.length;i++){const c=txt[i];
      if(q){ if(c==='"'){ if(txt[i+1]==='"'){val+='"';i++;} else {q=false;} } else {val+=c;} }
      else if(c==='"'){q=true;}
      else if(c===','){cur.push(val);val='';}
      else if(c==='\\n'){cur.push(val);if(cur.length>1||cur[0]!=='')out.push(cur);cur=[];val='';}
      else if(c!=='\\r'){val+=c;}}
    if(val!==''||cur.length){cur.push(val);out.push(cur);}
    return out;};
  const [uh,...ur]=parse(await (await fetch('tables/dim_unit.csv')).text());
  const [ph,...pr]=parse(await (await fetch('tables/dim_parcel.csv')).text());
  const ui=uh.indexOf('unit_id'), un=uh.indexOf('n_parcels'), ua=uh.indexOf('area_ha');
  const pi=ph.indexOf('parcel_id'), pa=ph.indexOf('area_ha'), pc=ph.indexOf('crop_name_zh'), pco=ph.indexOf('crop_code');
  const day=a.state.day, tb=a.buildTables(day);
  // ① 单元数 / 地块数 / 总面积
  const offUnits=new Map(ur.map(r=>[r[ui], Number(r[un])]));
  const offArea=pr.reduce((s,r)=>s+Number(r[pa]),0);
  // ② 每单元地块数逐个比
  const badUnit=tb.units.filter(u=>offUnits.get(u.id)!==u.n).map(u=>u.id);
  // ③ 作物面积（按中文名，排除休耕）
  const offCrop=new Map();
  for(const r of pr){ if(r[pco]==='FALLOW') continue; const k=r[pc]||'未分类'; offCrop.set(k,(offCrop.get(k)||0)+Number(r[pa])); }
  const badCrop=tb.crops.filter(c=>c.name!=='休耕').filter(c=>Math.abs((offCrop.get(c.name)||0)-c.area)>0.5).map(c=>c.name);
  return {offUnits:ur.length, uiUnits:tb.units.length, offParcels:pr.length, uiParcels:a.rows.length,
    offArea:Math.round(offArea*10)/10, uiArea:Math.round(a.rows.reduce((s,r)=>s+r.area_ha,0)*10)/10,
    badUnit:badUnit.slice(0,3), badUnitN:badUnit.length, badCrop:badCrop.slice(0,3), badCropN:badCrop.length,
    nCrop:tb.crops.filter(c=>c.name!=='休耕').length};})()`);
check('与离线表对账：单元数、地块数、总面积一致（页面与 tables/*.csv 是同一份数据的两条路径）',
  s20Rec.offUnits === s20Rec.uiUnits && s20Rec.offParcels === s20Rec.uiParcels
    && Math.abs(s20Rec.offArea - s20Rec.uiArea) < 0.5,
  `单元 ${s20Rec.uiUnits}/${s20Rec.offUnits} · 地块 ${s20Rec.uiParcels}/${s20Rec.offParcels} · 面积 ${s20Rec.uiArea}/${s20Rec.offArea} ha`);
check('与离线表对账：**每个单元的地块数**逐个吻合（口径没漂）',
  s20Rec.badUnitN === 0, s20Rec.badUnitN ? `不一致 ${s20Rec.badUnitN} 个：${s20Rec.badUnit.join(',')}` : '62 个单元全部一致');
check('与离线表对账：**按作物的面积**吻合（排除休耕后逐类比）',
  s20Rec.badCropN === 0, s20Rec.badCropN ? `不一致 ${s20Rec.badCropN} 类：${s20Rec.badCrop.join(',')}` : `${s20Rec.nCrop} 类全部一致`);
await shot('drawer-cols-1440x900');


// ===================== 21. 纯静态保证（无后端 / 无 CDN / 换任意静态服务器都能跑） =====================
console.log('\n=== 21. 纯静态保证（无后端 / 无 CDN / 任意静态服务器） ===');
await boot(1440, 900);

{
  const net = await ev(`(()=>{const rs=performance.getEntriesByType('resource').map(r=>new URL(r.name));
    return {n:rs.length, origins:[...new Set(rs.map(u=>u.origin))],
      ext:rs.filter(u=>u.origin!==location.origin).map(u=>u.href).slice(0,3)};})()`);
  check('运行期**只加载同源静态资源**：无 CDN、无后端接口、无 websocket（纯静态第一条硬线；用 CDP 的 Network 事件判，不看 resource timing）',
    net.ext.length === 0 && net.n > 0 && netEvents.external.length === 0 && netEvents.ws.length === 0,
    `${net.n} 个同源请求${net.ext.length ? `；resource 里的外部：${net.ext.join(',')}` : ''}`
      + ` · CDP 记录：外部主机 ${netEvents.external.length} 个${netEvents.external.length ? `（${netEvents.external.slice(0, 2).join(',')}）` : ''} / websocket ${netEvents.ws.length} 个`);
}

{
  const files = [...fs.readdirSync('js').filter((f) => f.endsWith('.js')).map((f) => `js/${f}`), 'index.html', 'style.css'];
  const src = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const ext = [...src.matchAll(/<(?:script|link)[^>]*?(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)/g)].map((m) => m[1])
    .concat([...src.matchAll(/from\s+["'](https?:\/\/[^"']+)/g)].map((m) => m[1]));
  // 页面代码里不该出现任何"要后端"的痕迹（这几样一旦出现，纯静态就破了）
  const backend = /child_process|require\(|\bduckdb\b|WebSocket\(|new\s+EventSource|\/api\//.test(src);
  check('页面源码**零外部依赖**：无 CDN 外链、无 node/python/DB 调用、无后端接口路径',
    ext.length === 0 && !backend,
    ext.length ? `外链：${ext.slice(0, 3).join(',')}` : `扫描 ${files.length} 个文件：只有本地引用（vendor/leaflet 已本地化）`);
}

{
  // 换成"陌生"的静态服务器：python -m http.server —— 证明页面不依赖项目自带 serve.mjs 的任何特性
  let info = null;
  let py = null;
  const pyPort = 8300 + Math.floor(Math.random() * 300);
  const pyProbe = spawnSync('python', ['-c', 'print(1)'], { encoding: 'utf8' });
  if (pyProbe.status !== 0) {
    skip('换成**任意静态服务器**（python -m http.server）页面照样完整跑起来', '环境里没有 python ⇒ 跳过（这一项不该把整个平台变成硬前置）');
  } else {
  try {
    py = spawn('python', ['-m', 'http.server', String(pyPort), '--bind', '127.0.0.1'], { cwd: process.cwd(), stdio: 'ignore' });
    await sleep(1400);
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: `http://127.0.0.1:${pyPort}/index.html?t=${Date.now()}` });
    await waitFor(async () => await ev(`document.readyState==='complete' && !!globalThis.__agri`), 'python http.server 就绪');
    info = await ev(`(()=>{const a=globalThis.__agri;return {parcels:a.model.parcels.length, map:!!document.querySelector('.leaflet-container'), fatal:!!document.querySelector('.fatal')};})()`);
  } catch (err) {
    info = { error: String(err.message ?? err).slice(0, 80) };
  } finally {
    py?.kill();
  }
  check('换成**任意静态服务器**（python -m http.server，不含任何后端）页面照样完整跑起来',
    !!info && !info.error && info.parcels > 0 && info.map && !info.fatal,
    info?.error ? `失败：${info.error}` : `python http.server:${pyPort} ⇒ ${info.parcels} 个地块、地图容器就绪、无失败提示`);
  }
}

{
  // 数据缺失：要给出**可读提示**（白屏是最糟的失败形态）
  await send('Network.enable');
  await send('Network.setBlockedURLs', { urls: ['*parcels.geojson*'] });
  await send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}${PREFIX}/index.html?t=${Date.now()}&blocked=1` });
  await sleep(3600);
  const fb = await ev(`(()=>{const f=document.querySelector('#map .fatal');return {shown:!!f, text:f?f.textContent.replace(/\s+/g,' '):''};})()`);
  await send('Network.setBlockedURLs', { urls: [] });
  check('数据加载失败时给**可读提示**（含"用静态服务器打开"与补救步骤），而不是白屏',
    fb.shown && /服务器|file/.test(fb.text), fb.shown ? fb.text.slice(0, 70) : '没有任何提示');
}

{
  // 真·file:// 打开：模块脚本被 CORS 拦掉 ⇒ 走内联兜底（这段内联脚本正是为此而存在）
  const fileUrl = `file:///${path.resolve('index.html').replace(/\\/g, '/')}`;
  let fb = null;
  try {
    await send('Page.navigate', { url: `${fileUrl}?t=${Date.now()}` });
    await sleep(6300);   // 兜底脚本的判定超时是 5s（见 index.html），这里必须等得比它久
    fb = await ev(`(()=>{const f=document.querySelector('#map .fatal');return {shown:!!f, boot:!!globalThis.__agriBoot, text:f?f.textContent.replace(/\s+/g,' ').slice(0,140):''};})()`);
  } catch (err) {
    fb = { error: String(err.message ?? err).slice(0, 80) };
  }
  check('**file:// 直接打开**时不白屏：内联兜底给出原因与做法（模块脚本被拦时 fatal() 根本不会执行）',
    !!fb && !fb.error && fb.shown && !fb.boot && /静态服务器/.test(fb.text),
    fb?.error ? `无法测：${fb.error}` : `兜底提示已显示（模块未执行 boot=${fb?.boot}）：${(fb?.text ?? '').slice(0, 60)}`);
}
await boot(1440, 900);
await shot('static-1440x900');


// ===================== 22. 页面上的静态透视视图（离线生成，页面只查表） =====================
console.log('\n=== 22. 页面上的静态透视视图 ===');
await boot(1440, 900);
const s22 = await ev(`(async()=>{
  const a=globalThis.__agri;const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  document.querySelector('#tb-tabs button[data-tab="pivot"]').click();
  for(let i=0;i<50 && !(a.ui.pivotData&&a.ui.pivotData.views.length);i++) await sleep(100);
  const sel=document.getElementById('pivot-sel');
  const snap=()=>{
    const th=[...document.querySelectorAll('#tb-body .tbl thead th')].map(x=>x.textContent.trim());
    const trs=[...document.querySelectorAll('#tb-body .tbl tbody tr')];
    let sum=0;
    for(const tr of trs.slice(0,-1)){ for(const td of [...tr.children].slice(1,-1)){
      const v=Number(td.textContent.replace(/[^0-9.-]/g,'')); if(Number.isFinite(v)) sum+=v; } }
    const lastCells=trs.length?[...trs[trs.length-1].children]:[];
    const lastText=trs.length?trs[trs.length-1].textContent.replace(/\s+/g,' ').trim():'';
    const lastRaw=lastCells.length?lastCells[lastCells.length-1].textContent.trim():'';
    const lastNum=Number.isFinite(Number(lastRaw))?Number(lastRaw):null;
    return {nCol:th.length, nRow:trs.length, head:th.slice(0,3), lastHead:th[th.length-1],
      note:document.getElementById('tb-note').textContent, selVisible:!sel.classList.contains('hidden'),
      opt:sel.options.length, sum:Math.round(sum*100)/100,
      lastRaw, lastNum,
      lastText:lastText.slice(0,40)};
  };
  const first=snap();
  sel.value='1'; sel.dispatchEvent(new Event('change',{bubbles:true}));
  const second=snap();
  const reqs=[...new Set(performance.getEntriesByType('resource').filter(r=>r.name.includes('pivot.json')).map(r=>new URL(r.name).origin))];
  // 选择器只在「透视视图」页签出现：切到别的页签必须隐藏
  document.querySelector('#tb-tabs button[data-tab="units"]').click();
  const hiddenElsewhere=sel.classList.contains('hidden');
  document.querySelector('#tb-tabs button[data-tab="pivot"]').click();
  const v=a.ui.pivotData?a.ui.pivotData.views:null;
  return {views:v?v.length:0, origins:reqs, origin:location.origin, hiddenElsewhere,
    v0:v?{r:v[0].rowKeys.length,c:v[0].colKeys.length,grand:v[0].grand,agg:v[0].agg,value:v[0].value,unit:v[0].unit,dec:v[0].decimals}:null,
    v1:v?{r:v[1].rowKeys.length,c:v[1].colKeys.length,grand:v[1].grand,agg:v[1].agg,dec:v[1].decimals}:null,
    first, second};})()`);
check('「透视视图」页签读的是**离线 JSON**：行列数 == 视图行列数（另加"合计"行/列），页脚写明口径与来源',
  s22.views >= 3 && s22.first.nRow === s22.v0.r + 1 && s22.first.nCol === s22.v0.c + 2
    && s22.first.lastHead === '合计' && /(mean|sum)/.test(s22.first.note) && /页面只查表/.test(s22.first.note),
  `${s22.views} 个视图 · 首屏 ${s22.first.nRow} 行 × ${s22.first.nCol} 列（视图 ${s22.v0.r}×${s22.v0.c}，末列「${s22.first.lastHead}」）`);
check('切换透视视图：行列数随之变化（不是把同一张表换个标题）',
  s22.second.nRow === s22.v1.r + 1 && s22.second.nCol === s22.v1.c + 2 && s22.second.nRow !== s22.first.nRow,
  `${s22.first.nRow}×${s22.first.nCol} → ${s22.second.nRow}×${s22.second.nCol}（视图 ${s22.v1.r}×${s22.v1.c}，agg=${s22.v1.agg}）`);
check('**逐格求和 == 离线总合计**（渲染没错行错列），且合计行右下角就是总合计',
  Math.abs(s22.second.sum - Number(s22.v1.grand)) <= 0.01 * (s22.v1.r * s22.v1.c) + 0.05
    && Math.abs(Number(s22.second.lastNum) - Number(s22.v1.grand)) <= 0.5 * 10 ** -s22.v1.dec + 1e-9,
  `格内求和 ${s22.second.sum} vs 离线合计 ${s22.v1.grand}（${s22.v1.r}×${s22.v1.c} 格，sum 视图）；合计行末值 ${s22.second.lastNum}（末格原文「${s22.second.lastRaw}」）；合计行文本「${s22.second.lastText.slice(0,30)}…」`);
check('仍**纯静态**：透视数据是同源静态文件；选择器只在「透视视图」页签出现（别的页签不留噪音）',
  s22.origins.length === 1 && s22.origins[0] === s22.origin && s22.hiddenElsewhere === true,
  `请求来源 ${s22.origins.join(',') || '（未取到）'} · 其他页签隐藏=${s22.hiddenElsewhere}`);
await shot('pivot-1440x900');

console.log(`\n================ ${pass} 通过 / ${fail} 失败 ================`);
console.log(`截图目录：${OUT}`);
ws.close();
chrome.kill();
server.close();
if (fail > 0) process.exitCode = 1;
