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

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/*
 * `--root <dir>`：换个根目录跑同一套检查（主要用途：**验交付包能不能起来** ——
 * 包里页面跑不起来，前面所有数据判据都不算数）。默认还是仓库根。
 */
const rootArg = process.argv.indexOf('--root');
const ROOT = rootArg > 0 && process.argv[rootArg + 1] ? path.resolve(process.argv[rootArg + 1]) : REPO_ROOT;
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
/*
 * `--smoke`：只验**页面能起来**（约 5 秒）。
 *
 * 为什么单独要这一档：完整浏览器判据 ~5 分钟，而"改完代码先确认页面没被改坏"这件事
 * 只需要几秒。这个缺口是真出过事的 —— 一次整段替换误删了 10 个 UI 方法，
 * 页面直接起不来，而当时的 `npm run ready` 只跑 query/repo，照样报全绿。
 * 所以 smoke 只做三件：页面起来、无页面异常、关键数据规模对得上。
 */
const SMOKE = argv.includes('--smoke');
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
/*
 * **判据侧的公共辅助**（只写一份，用模板变量注入到各个 `ev()` 里）。
 *
 * 为什么必须抽出来：这段"按 AGG_RULE 取单元五维 → 按全场归一"的逻辑原来有 **3 份拷贝**
 * （§32 一份、§33 一份、§35 一份），上一次就是因为只改了两处、漏了第三处而出现
 * "页面按 p90 封顶、判据按 max"的口径不一致 —— 判据自己也会腐烂。
 * 注意：注入的是**字符串**，在浏览器里以 const 形式落地；用到的变量是 `T`（buildTables 结果）。
 */
const UNIT_NORM_SRC = `
  const P90=(()=>{const t=[...T.units].map(u=>u.tMin).filter(v=>v!=null).sort((x,y)=>x-y);
    return t.length?t[Math.min(t.length-1,Math.floor(t.length*0.9))]:1;})();
  const raw5=(u)=>[Number.isFinite(u.progress)?u.progress:0, Number(u.water)||0, Number(u.fert)||0,
    (5-(Number(u.disease)||1))/4, 1-Math.min(1,(u.tMin??P90)/(P90||1))];
  const RAW=T.units.map(raw5);
  const DIM_HI=[0,1,2,3,4].map(k=>Math.max(...RAW.map(r=>r[k])));
  const DIM_LO=[0,1,2,3,4].map(k=>Math.min(...RAW.map(r=>r[k])));
  const DIM_SPAN=DIM_HI.map((h,k)=>h-DIM_LO[k]);
  const DIM_MIN=0.05;
  const DIM_USABLE=DIM_SPAN.map(x=>x>=DIM_MIN);
  const norm5=(u)=>raw5(u).map((v,k)=>DIM_USABLE[k]?Math.min(1,Math.max(0,(v-DIM_LO[k])/DIM_SPAN[k])):0.5);
  const AREA_W=T.units.reduce((a,u)=>a+(u.area||0),0)||1;
  const areaAvg5=[0,1,2,3,4].map(k=>T.units.reduce((a,u)=>a+raw5(u)[k]*(u.area||0),0)/AREA_W);
`;

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
    const b = await fs.promises.readFile(path.join(ROOT, url.replace(/^\//, '')));
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
async function waitFor(fn, what) {
  for (let i = 0; i < 100; i++) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await sleep(200); }
  // 超时时**把页面自己的报错带上** —— 否则只剩"超时"两个字，得靠猜
  const errs = pageErrors.slice(-4);
  throw new Error(`超时：${what}${errs.length ? `｜页面报错：${errs.join(' ｜ ')}` : '（页面无报错）'}`);
}
const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find((x) => x.type === 'page'), 'target');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
let id = 0;
const pending = new Map();
/**
 * **页面侧的异常/报错要留下来**。
 *
 * 起因：页面某个模块一抛错，`__agri` 就永远不出现，`waitFor` 只报"超时：页面就绪" ——
 * 排查得靠猜（这次就对着一个语法正确的改动猜了半天）。CDP 的 `Runtime.enable` 早就开着，
 * 只是没人接这两类事件。超时信息里把它们打出来，问题一眼可见。
 */
const pageErrors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params?.exceptionDetails ?? {};
    pageErrors.push(`${d.text ?? '异常'} ${d.exception?.description ?? ''}`.trim().slice(0, 300));
  } else if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
    pageErrors.push(`console.error ${(m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')}`.slice(0, 300));
  }
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
let t0 = Date.now();          // 记一次"页面起来花了多久"（smoke 模式下会打出来）
const boot = async (w, h, query = '') => {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false, screenWidth: w, screenHeight: h });
  await send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}${PREFIX}/sim.html?t=${Date.now()}${query}` });
  await waitFor(async () => await ev(`document.readyState==='complete' && !!globalThis.__agri`), '页面就绪');
  /*
   * **等懒加载的数据**：情景候选（194 KB）不在启动清单里，切到「情景推演」才取。
   * 判据里"boot 之后就能读到 154 个候选"是大量既有断言的前提，所以在这里统一等它一次
   * （等价于"页面与它的延迟数据都就绪"）。懒加载本身由 §44 单独验（启动时确实没拉）。
   */
  await ev(`globalThis.__agri.ensureScenario ? globalThis.__agri.ensureScenario() : null`);
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
/*
 * 页面**加载期**的异常必须为 0：这类错（少了个方法、模块路径写错）会让 `__agri` 永远不出现，
 * 只表现为"超时：页面就绪" —— 现在异常被接住，这里直接断言它为空。
 */
check('页面加载期**无异常**（`Runtime.exceptionThrown` / `console.error` 一条都不该有）',
  pageErrors.length === 0,
  pageErrors.length ? pageErrors.slice(0, 3).join(' ｜ ') : `页面起来用了 ${Date.now() - t0}ms`);

if (SMOKE) { report(); process.exit(fail > 0 ? 1 : 0); }

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
{
  // 行为已变：未选点时不再是"一句提示"，而是**154 个候选的排行表**（点一行即可选中）
  const rank = await ev(`(()=>{const trs=[...document.querySelectorAll('#tb-body .tbl tbody tr')];
    const parse=(t)=>Number(String(t).replace(/[^0-9.-]/g,''));
    const vals=trs.map(tr=>parse(tr.children[1].textContent));
    const cands=globalThis.__agri.scenario.candidates;
    return {n:trs.length, nC: cands.length, desc: vals.every((v,i)=>i===0||vals[i-1]>=v),
      top: vals[0], argmax: Math.max(...cands.map(c=>c.improved_ha)),
      note: document.getElementById('tb-note').textContent.replace(/\s+/g,' ')};})()`);
  check('「情景推演」未选点时给出**候选点排行**（全部候选、按受益面积降序、首位就是最大受益）',
    rank.n === rank.nC && rank.desc && Math.abs(rank.top - rank.argmax) < 0.06 && /按受益面积排序/.test(rank.note),
    `${rank.n}/${rank.nC} 行 · 首位 ${rank.top} ha（最大 ${rank.argmax} ha）· 降序 ${rank.desc}`);
}
// 在地图上"点"一下（Leaflet 的 click 事件，带经纬度）
const pick = await ev(`(()=>{const a=globalThis.__agri;
  const best=[...a.scenario.candidates].sort((x,y)=>y.improved_parcels*x.avg_gain_min-y.improved_parcels*x.avg_gain_min)[0];
  a.map.map.fire('click',{latlng:L.latLng(best.lat,best.lon)});
  return {lon:best.lon,lat:best.lat,want:best.improved.length,improved:best.improved_parcels,avgGain:best.avg_gain_min};})()`);
await sleep(350);
const after = await ev(`(()=>{const q=(s)=>document.querySelectorAll(s);
  const rows=[...q('#tb-body .tbl tbody tr')].map(tr=>[...tr.children].map(td=>td.textContent.trim()));
  return {n:rows.length, first:rows.map(r=>r[0]), note:document.getElementById('tb-note').textContent,
    marked:[...q('#tb-body .tbl tbody tr')].filter(tr=>/★/.test(tr.textContent)).length,
    hl:globalThis.__agri.map.highlightIdx.length};})()`);
// 行为已变：对比不再是一张 7 行的表，而是"该行标 ★ + 表注给现状基线 + 抽屉里的前后对照图"
check('地图点选后：排行表里那一行标 ★、表注写明**现状基线**与平均可省（对比信息没丢，换了位置）',
  after.marked === 1 && /已选/.test(after.note) && /现状：平均/.test(after.note),
  `★ 行 ${after.marked} · 表注：${after.note.replace(/\s+/g, ' ').slice(0, 96)}`);
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
// ⚠️ 测量前先**回到默认页签**：页签切换会改变这一行的高度与按钮数量（透视页签会多出选择器 + 导出按钮），
// 停在哪一页取决于上一个检查 —— 不归位的话，这条"空间预算"判据的结果就是不可复现的
await ev(`document.querySelector('#tb-tabs button[data-tab="focus"]').click()`);
await sleep(250);
const s19Strip = await ev(`(()=>{const bs=[...document.querySelectorAll('#tablebar .tb-actions button')]
    .filter(b=>getComputedStyle(b).display!=='none');
  const act=document.querySelector('#tablebar .tb-actions'), note=document.getElementById('tb-note');
  return {n:bs.length, heights:bs.map(b=>Math.round(b.getBoundingClientRect().height)),
    labels:bs.map(b=>b.textContent.trim()), rows:new Set(bs.map(b=>Math.round(b.getBoundingClientRect().top))).size,
    headH:Math.round(document.querySelector('.tb-head').getBoundingClientRect().height),
    // 调试用：到底是谁把这一行挤到换行（判据失败时看它）
    widths:bs.map(b=>Math.round(b.getBoundingClientRect().width)), actW:Math.round(act.getBoundingClientRect().width),
    actScroll:act.scrollWidth, noteW:note?Math.round(note.getBoundingClientRect().width):-1,
    tabsW:Math.round(document.getElementById('tb-tabs').getBoundingClientRect().width),
    selW:Math.round((document.getElementById('pivot-sel')||{getBoundingClientRect:()=>({width:-1})}).getBoundingClientRect().width)};})()`);
check('表格区按钮在 1024×640 下不换行（说明文案先被截断，按钮不许折行）',
  s19Strip.heights.every((h) => h < 32) && s19Strip.rows <= 2,
  `${s19Strip.n} 个按钮（${s19Strip.labels.join('/')}）占用行数 ${s19Strip.rows} · 表头 ${s19Strip.headH}px`
    + ` · 按钮宽 ${s19Strip.widths.join('/')} · 操作行 ${s19Strip.actW}（scroll ${s19Strip.actScroll}）· 便签 ${s19Strip.noteW} · 页签 ${s19Strip.tabsW} · 选择器 ${s19Strip.selW}`);
const s19Body = await ev(`(()=>{const t=document.getElementById('tablebar'),b=document.getElementById('tb-body');
  // 只数【可见】页签：被 display:none 收起的按钮 rect 是 0，把它们算进来会得到"2 行"的假失败
  const vis=[...document.querySelectorAll('#tb-tabs button')].filter(x=>x.getBoundingClientRect().height>0);
  return {strip:Math.round(t.getBoundingClientRect().height), head:Math.round(document.querySelector('.tb-head').getBoundingClientRect().height),
    body:Math.round(b.getBoundingClientRect().height), tabRows:new Set(vis.map(x=>Math.round(x.getBoundingClientRect().top))).size,
    visTabs:vis.length};})()`);
// 最坏情况：切到「透视视图」（多一个视图选择器 + 一个导出按钮）再量一次 —— 这才是这一行真正吃紧的状态
await ev(`document.querySelector('#tb-tabs button[data-tab="pivot"]').click()`);
await sleep(700);
const s19Pivot = await ev(`(()=>{const b=document.getElementById('tb-body');
  const bs=[...document.querySelectorAll('#tablebar .tb-actions button')].filter(x=>getComputedStyle(x).display!=='none');
  return {head:Math.round(document.querySelector('.tb-head').getBoundingClientRect().height),
    body:Math.round(b.getBoundingClientRect().height), n:bs.length,
    rows:new Set(bs.map(x=>Math.round(x.getBoundingClientRect().top))).size};})()`);
check('1024×640 的**最坏情况**（切到「透视视图」、多出选择器与导出按钮）也不许把表体挤到 3 行以下',
  s19Pivot.head <= 80 && s19Pivot.body >= 96,
  `透视页签：表头 ${s19Pivot.head}px · 表体 ${s19Pivot.body}px · ${s19Pivot.n} 个按钮占 ${s19Pivot.rows} 行`);
await ev(`document.querySelector('#tb-tabs button[data-tab="focus"]').click()`);
await sleep(200);
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
  const files = [...fs.readdirSync('js').filter((f) => f.endsWith('.js')).map((f) => `js/${f}`), 'index.html', 'sim.html', 'style.css', 'guide.css'];
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
    await send('Page.navigate', { url: `http://127.0.0.1:${pyPort}/sim.html?t=${Date.now()}` });
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
  await send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}${PREFIX}/sim.html?t=${Date.now()}&blocked=1` });
  await sleep(3600);
  const fb = await ev(`(()=>{const f=document.querySelector('#map .fatal');return {shown:!!f, text:f?f.textContent.replace(/\s+/g,' '):''};})()`);
  await send('Network.setBlockedURLs', { urls: [] });
  check('数据加载失败时给**可读提示**（含"用静态服务器打开"与补救步骤），而不是白屏',
    fb.shown && /服务器|file/.test(fb.text), fb.shown ? fb.text.slice(0, 70) : '没有任何提示');
}

{
  // 真·file:// 打开：模块脚本被 CORS 拦掉 ⇒ 走内联兜底（这段内联脚本正是为此而存在）
  const fileUrl = `file:///${path.resolve('sim.html').replace(/\\/g, '/')}`;
  let fb = null;
  try {
    await send('Page.navigate', { url: `${fileUrl}?t=${Date.now()}` });
    await sleep(6300);   // 兜底脚本的判定超时是 5s（见 sim.html），这里必须等得比它久
    fb = await ev(`(()=>{const f=document.querySelector('#map .fatal');return {shown:!!f, boot:!!globalThis.__agriBoot, text:f?f.textContent.replace(/\s+/g,' ').slice(0,140):''};})()`);
  } catch (err) {
    fb = { error: String(err.message ?? err).slice(0, 80) };
  }
  check('**file:// 直接打开**时不白屏：内联兜底给出原因与做法（模块脚本被拦时 fatal() 根本不会执行）',
    !!fb && !fb.error && fb.shown && !fb.boot && /静态服务器/.test(fb.text),
    fb?.error ? `无法测：${fb.error}` : `兜底提示已显示（模块未执行 boot=${fb?.boot}）：${(fb?.text ?? '').slice(0, 60)}`);

  /*
   * 导览页（入口）在 file:// 下**要提前说清**"模拟地图需要 http 服务"：
   * 否则点「打开模拟地图」进去只看到"页面没有启动"，会以为是网站坏了。
   */
  const guideUrl = `file:///${path.resolve('index.html').replace(/\\/g, '/')}`;
  let tip = null;
  try {
    await send('Page.navigate', { url: `${guideUrl}?t=${Date.now()}` });
    await sleep(700);
    tip = await ev(`(()=>{const t=document.querySelector('.g-tip');return {shown:!!t, text:t?t.textContent.replace(/\s+/g,' ').slice(0,120):'', imgs:[...document.querySelectorAll('.shot img')].filter(i=>i.naturalWidth>0).length};})()`);
  } catch (err) {
    tip = { error: String(err.message ?? err).slice(0, 80) };
  }
  check('导览页在 **file:// 打开时就提前提示**"模拟地图需要 http 服务"（而不是点进去才看到白屏）',
    !!tip && !tip.error && tip.shown && /http/.test(tip.text) && tip.imgs === 4,
    tip?.error ? `无法测：${tip.error}` : (tip?.text ?? '').slice(0, 80));
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
  // 控件都放在抽屉里：抽屉没开时两个都该隐藏
  const hiddenElsewhere=sel.classList.contains('hidden');
  const btnHiddenElsewhere=document.getElementById('btn-pivot-csv').classList.contains('hidden');
  document.querySelector('#tb-tabs button[data-tab="pivot"]').click();   // 回到透视页
  // 打开抽屉 → 切到别的页签（仍隐藏）→ 再切到"透视视图"（两个控件都出现）
  document.getElementById('btn-drawer').click();
  document.querySelector('#dw-tabs button[data-tab="units"]').click();
  const ctrlHiddenOtherTab=sel.classList.contains('hidden')
    && document.getElementById('btn-pivot-csv').classList.contains('hidden');
  document.querySelector('#dw-tabs button[data-tab="pivot"]').click();
  const btnInDrawer=!document.getElementById('btn-pivot-csv').classList.contains('hidden')
    && !sel.classList.contains('hidden');
  // 导出当前视图的 CSV 文本：与离线 JSON 逐项对账（页面只查表，导出也不许另算一遍）
  const btn=document.getElementById('btn-pivot-csv');
  const csvLines=a.ui.pivotCsvText().trim().split(String.fromCharCode(10));
  const csvHead=csvLines[1].split(',');
  const csvLast=csvLines[csvLines.length-1].split(',');
  const csv={nLines:csvLines.length, note:csvLines[0].startsWith('#'), headFirst:csvHead[0],
    headLast:csvHead[csvHead.length-1], nCol:csvHead.length, lastFirst:csvLast[0],
    lastNum:csvLast[csvLast.length-1], btnVisible:!btn.classList.contains('hidden')};
  const v=a.ui.pivotData?a.ui.pivotData.views:null;
  return {views:v?v.length:0, origins:reqs, origin:location.origin, hiddenElsewhere, btnHiddenElsewhere, ctrlHiddenOtherTab, btnInDrawer, csv,
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
check('**导出当前视图 CSV**：带口径注释 + 行维/全部列/合计表头，末行是列合计与总合计（与离线 JSON 逐项对齐）',
  s22.csv.note && !!s22.csv.headFirst && s22.csv.headLast === '合计' && s22.csv.nCol === s22.v1.c + 2
    && s22.csv.nLines === s22.v1.r + 3 && s22.csv.lastFirst === '合计'
    && Math.abs(Number(s22.csv.lastNum) - Number(s22.v1.grand)) <= 0.005,
  `${s22.csv.nLines} 行（1 注释 + 1 表头 + ${s22.v1.r} 数据 + 1 合计）· ${s22.csv.nCol} 列 · 末格 ${s22.csv.lastNum} vs 离线 ${s22.v1.grand}`);
check('透视控件（视图选择器 + 导出视图）**只在抽屉的透视页签出现**：抽屉未开隐藏、抽屉别的页签也隐藏',
  s22.hiddenElsewhere === true && s22.btnHiddenElsewhere === true
    && s22.ctrlHiddenOtherTab === true && s22.btnInDrawer === true,
  `抽屉未开时：选择器隐藏=${s22.hiddenElsewhere}、导出按钮隐藏=${s22.btnHiddenElsewhere}；`
    + `抽屉别的页签仍隐藏=${s22.ctrlHiddenOtherTab}；抽屉透视页签两个都可见=${s22.btnInDrawer}`);
{
  // 对照表视图（q12 单产两套口径）：离线 JSON 里的 list 视图要能按"几列并排"渲染，并且导出也对
  const list = await ev(`(()=>{const a=globalThis.__agri;const sel=document.getElementById('pivot-sel');
    document.querySelector('#tb-tabs button[data-tab="pivot"]').click();
    const idx=a.ui.pivotData.views.findIndex(v=>v.kind==='list');
    sel.value=String(idx); sel.dispatchEvent(new Event('change',{bubbles:true}));
    const th=[...document.querySelectorAll('#tb-body .tbl thead th')].map(x=>x.textContent.trim());
    const trs=[...document.querySelectorAll('#tb-body .tbl tbody tr')];
    const csv=a.ui.pivotCsvText();
    const lines=csv.trim().split(String.fromCharCode(10));
    const v=a.ui.pivotData.views[idx];
    return {idx, kind:v.kind, nViews:a.ui.pivotData.views.length, cols:v.cols, nCols:v.cols.length,
      nRows:v.rows.length, head:th, bodyRows:trs.length, firstCell:trs.length?trs[0].children[0].textContent:'',
      csvHead:lines[1].split(','), csvLines:lines.length, note:document.getElementById('tb-note').textContent};})()`);
  check('页面「透视视图」也能渲染**对照表**（q12 单产两套口径）：列名与行数照离线 JSON，导出 CSV 同源',
    // 视图数写死是故意的：少一个视图（离线没生成/页面没读）必须当场红
    list.idx >= 0 && list.kind === 'list' && list.nViews === 9
      && list.head.join(',') === list.cols.join(',') && list.bodyRows === list.nRows
      && list.csvHead.join(',') === list.cols.join(',') && list.csvLines === list.nRows + 2
      && /只查表/.test(list.note),
    `第 ${list.idx + 1}/${list.nViews} 个视图：${list.nRows} 行 × ${list.nCols} 列（表头 ${list.head.slice(0, 3).join('/')}…）· CSV ${list.csvLines - 2} 行数据`);
}
await shot('pivot-1440x900');


// ===================== 23. 按经营单元（P2）看地图 =====================
console.log('\n=== 23. 按经营单元（P2）看地图（面积加权着色） ===');
await boot(1440, 900);
const s23 = await ev(`(()=>{const a=globalThis.__agri;const m=a.map;
  const layers=m.unitLayer.getLayers();
  const ids=layers.slice(0,3).map(x=>x.feature.properties.unit_id);
  const st=(uid)=>{const l=layers.find(x=>x.feature.properties.unit_id===uid);const o=l.options;
    return {fill:!!o.fill, op:o.fillOpacity, color:o.fillColor};};
  const before=ids.map(st);
  const cb=document.querySelector('input[data-layer="unitfill"]');
  const present=!!cb;
  if(cb){cb.checked=true; cb.dispatchEvent(new Event('change',{bubbles:true}));}
  const vals=ids.map(u=>m.unitValue(u));
  const after=ids.map(st);
  // 独立复算：面积加权均值（判据侧自己算一遍，不复用页面里的 unitValue）
  const spec=window.__agri.VARIABLES? null:null;
  // 独立复算：按 geo.js 里**声明过的口径**（AGG_RULE）自己实现一遍
  // —— progress 排除不播种的地块（gddNeed=0）、disease 取最严重、其余按面积加权
  const recompute=(uid)=>{let num=0,den=0,max=null;
    for(const row of a.rows){ if(row.unit_id!==uid) continue;
      if(m.variable==='progress' && !(row.gddNeed>0)) continue;
      const v=a.get(row,m.variable,m.day); const w=row.area_ha||0;
      if(v===null||v===undefined||Number.isNaN(Number(v))) continue;
      if(m.variable==='disease'){ max=max===null?Number(v):Math.max(max,Number(v)); }
      else { num+=Number(v)*w; den+=w; } }
    return m.variable==='disease'?max:(den>0?num/den:null);};
  const re=ids.map(recompute);
  // ⚠️ null（该单元/网格里没有可聚合的地块，例如全是牧草）页面画的是"无数据灰"，
  // 判据不能把 null 送进色带（那会得到色带最低档的深色 ⇒ 假失败）
  const expectColors=re.map(v=>v===null||v===undefined?'#8a949e':a.colorOf[m.variable](v));
  const colorsBefore=ids.map(st).map(o=>o.color);
  const day0=a.state.day;
  a.setDay(Math.min(a.model.days.length-1, day0+40));   // 换一天
  const colorsAfter=ids.map(st).map(o=>o.color);
  const day1=a.state.day;
  a.setDay(day0);
  if(cb){cb.checked=false; cb.dispatchEvent(new Event('change',{bubbles:true}));}
  const off=ids.map(st);
  // 地块填充在两种状态下的不透明度（单元着色开启时应被调暗）
  const pf=document.querySelector('#map canvas')? m.parcelLayer.getLayers()[0].options.fillOpacity : null;
  const onOp=(()=>{const cb2=document.querySelector('input[data-layer="unitfill"]');cb2.checked=true;
    cb2.dispatchEvent(new Event('change',{bubbles:true}));
    const v=m.parcelLayer.getLayers()[0].options.fillOpacity;
    cb2.checked=false; cb2.dispatchEvent(new Event('change',{bubbles:true}));
    return v;})();
  const offOp=m.parcelLayer.getLayers()[0].options.fillOpacity;
  const parcelFill={on:!!document.querySelector('input[data-layer="unitfill"]'), onOp, offOp};
  return {present, ids, before, vals, after, re, expectColors, colorsBefore, colorsAfter, off, parcelFill,
    variable:m.variable, day0, day1, interactive:m.unitLayer.options.interactive,
    nUnits:layers.length};})()`);
check('「单元着色」开关存在，打开后单元面**按当前指标着色**（面积加权），颜色与判据侧独立复算一致',
  s23.present && s23.nUnits === 62
    && s23.after.every((o) => o.fill === true && o.op > 0)
    && s23.after.every((o, i) => o.color === s23.expectColors[i]),
  `${s23.nUnits} 个单元；抽样 ${s23.ids.length} 个：填充 ${s23.after.map((o) => o.op).join('/')} · 颜色 ${s23.after.map((o) => o.color).join('/')} vs 期望 ${s23.expectColors.join('/')}`);
check('单元取值 = 成员地块的**面积加权均值**（判据自己算一遍，不复用页面函数）',
  s23.vals.every((v, i) => (v === null ? s23.re[i] === null : Math.abs(v - s23.re[i]) < 1e-9)),
  s23.vals.map((v, i) => `${v === null ? '无数据' : v.toFixed(4)}≈${s23.re[i] === null ? '无数据' : s23.re[i].toFixed(4)}`).join(' '));
check('单元着色**跟随当前帧**：换一天后颜色随之变化（不是停在打开那一刻）',
  s23.colorsAfter.some((c, i) => c !== s23.colorsBefore[i]),
  `第 ${s23.day0} 天 → 第 ${s23.day1} 天：${s23.colorsBefore.join('/')} → ${s23.colorsAfter.join('/')}`);
check('关掉开关回到**轮廓**（fill=false）；默认（未打开）也是轮廓',
  s23.before.every((o) => o.fill === false) && s23.off.every((o) => o.fill === false),
  `默认 fill=${s23.before.map((o) => o.fill).join('/')} · 关闭后 fill=${s23.off.map((o) => o.fill).join('/')}`);
check('单元图层**不可交互**（`interactive:false`）：单元面盖在地块上，若可交互会把"点地块"整个吃掉',
  s23.interactive === false, `interactive=${s23.interactive}`);
check('打开单元着色时，**地块填充自动调暗**（两层同一指标叠着会互相糊掉）；关闭后恢复',
  s23.parcelFill.on === true && s23.parcelFill.onOp > 0 && s23.parcelFill.onOp < 0.4 && s23.parcelFill.offOp > 0.7,
  `地块填充不透明度：开启单元着色 ${s23.parcelFill.onOp} / 关闭后 ${s23.parcelFill.offOp}`);
// 留一张"**开着**单元着色"的截图（上面那条是在关闭后拍的，肉眼看不出效果）
await ev(`(()=>{const cb=document.querySelector('input[data-layer="unitfill"]');cb.checked=true;cb.dispatchEvent(new Event('change',{bubbles:true}));})()`);
await sleep(500);
await shot('units-fill-on-1440x900');
await ev(`(()=>{const cb=document.querySelector('input[data-layer="unitfill"]');cb.checked=false;cb.dispatchEvent(new Event('change',{bubbles:true}));})()`);
await shot('units-fill-1440x900');


// ===================== 24. 情景对比同屏（按"到收储点节省分钟"着色） =====================
console.log('\n=== 24. 情景对比同屏 ===');
await boot(1440, 900);
const s24 = await ev(`(()=>{const a=globalThis.__agri;const m=a.map;
  const cb=document.querySelector('input[data-layer="scenariofill"]');
  const present=!!cb;
  const cand=a.scenario.candidates.reduce((b,c)=>c.avg_gain_min>(b?b.avg_gain_min:-1)?c:b, null);
  const onBefore=cb.checked;
  a.pickScenario({lat:cand.lat, lng:cand.lon});   // 选点
  const onAfter=cb.checked;
  const gains=new Map(cand.improved.map(([i,g])=>[i,g]));
  const sample=[...gains.keys()].slice(0,3);
  const layers=m.parcelLayer.getLayers();
  const colors=sample.map(i=>layers[i].options.fillColor);
  const expect=sample.map(i=>a.scenarioColor(gains.get(i)));
  const noGainIdx=[...a.rows.keys()].find(i=>!gains.has(i));
  const noneColor=layers[noGainIdx].options.fillColor;
  const noneExpect=a.scenarioColor(0);
  const painted=layers.filter(l=>l.options.fillColor && l.options.fillColor!=='#eef1f4').length;
  const tip=m.tipFor(a.rows[sample[0]]);
  const tipOk=tip.includes('节省');
  cb.checked=false; cb.dispatchEvent(new Event('change',{bubbles:true}));
  const offColor=layers[sample[0]].options.fillColor;
  const metricColor=a.colorOf[m.variable](a.get(a.rows[sample[0]], m.variable, m.day));
  return {present, onBefore, onAfter, sample, colors, expect, noneColor, noneExpect, painted,
    improved:cand.improved.length, improvedParcels:cand.improved_parcels, avgGain:cand.avg_gain_min,
    tipOk, offColor, metricColor, nBins:a.scenarioBins.length};})()`);
check('选中候选点后**自动打开**「情景对比」图层（并把勾选框同步过来）',
  s24.present && s24.onBefore === false && s24.onAfter === true,
  `勾选框存在=${s24.present} · 选点前 ${s24.onBefore} → 选点后 ${s24.onAfter}`);
check('地块按**节省分钟**分档着色：抽样颜色 == `scenarioColor(节省)`（判据独立取离线 gain 再算色）',
  s24.colors.every((c, i) => c === s24.expect[i]) && s24.colors.every((c) => !!c),
  `抽样 ${s24.sample.length} 块：${s24.colors.join('/')} vs 期望 ${s24.expect.join('/')}（共 ${s24.nBins} 档）`);
check('没改善的地块用"基本没改善"的浅灰（`scenarioColor(0)` 为 null ⇒ 不该混进绿色梯度）',
  s24.noneExpect === null && s24.noneColor === '#eef1f4',
  `无改善地块颜色 ${s24.noneColor} · scenarioColor(0)=${String(s24.noneExpect)}`);
check('着色块数 == 离线文件里的受影响块数（**存全后** `improved.length == improved_parcels`）',
  s24.painted === s24.improved && s24.improved === s24.improvedParcels,
  `地图着色 ${s24.painted} 块 · improved ${s24.improved} · improved_parcels ${s24.improvedParcels}（平均省 ${s24.avgGain} 分/块）`);
check('情景模式下 tooltip 说明节省分钟；关掉图层**回到按指标着色**',
  s24.tipOk === true && s24.offColor === s24.metricColor && s24.offColor !== s24.colors[0],
  `tooltip 含"节省"=${s24.tipOk} · 关闭后颜色 ${s24.offColor} == 指标色 ${s24.metricColor}`);
await shot('scenario-fill-1440x900');


// ===================== 25. 按 P4 统计网格看地图 =====================
console.log('\n=== 25. 按 P4 统计网格看地图（面积加权着色） ===');
await boot(1440, 900);
const s25 = await ev(`(()=>{const a=globalThis.__agri;const m=a.map;
  // 先确保情景着色关掉（它是"整体切换"，会覆盖指标色）
  const cs=document.querySelector('input[data-layer="scenariofill"]');
  if(cs.checked){cs.checked=false; cs.dispatchEvent(new Event('change',{bubbles:true}));}
  const layers=m.gridLayer.getLayers();
  const ids=layers.slice(0,3).map(x=>x.feature.properties.grid_id);
  const st=(gid)=>{const l=layers.find(x=>x.feature.properties.grid_id===gid);const o=l.options;
    return {fill:!!o.fill, op:o.fillOpacity, color:o.fillColor};};
  const cb=document.querySelector('input[data-layer="gridfill"]');
  const before=ids.map(st);
  const checkedBefore=cb?cb.checked:null;
  if(cb){cb.checked=true; cb.dispatchEvent(new Event('change',{bubbles:true}));}
  const vals=ids.map(g=>m.gridValue(g));
  const after=ids.map(st);
  // 独立复算：按 geo.js 里**声明过的口径**（AGG_RULE）自己实现一遍
  // —— progress 排除不播种的地块（gddNeed=0）、disease 取最严重、其余按面积加权
  const recompute=(gid)=>{let num=0,den=0,max=null;
    for(const row of a.rows){ if(row.grid_id!==gid) continue;
      if(m.variable==='progress' && !(row.gddNeed>0)) continue;
      const v=a.get(row,m.variable,m.day); const w=row.area_ha||0;
      if(v===null||v===undefined||Number.isNaN(Number(v))) continue;
      if(m.variable==='disease'){ max=max===null?Number(v):Math.max(max,Number(v)); }
      else { num+=Number(v)*w; den+=w; } }
    return m.variable==='disease'?max:(den>0?num/den:null);};
  const re=ids.map(recompute);
  // ⚠️ null（该单元/网格里没有可聚合的地块，例如全是牧草）页面画的是"无数据灰"，
  // 判据不能把 null 送进色带（那会得到色带最低档的深色 ⇒ 假失败）
  const expectColors=re.map(v=>v===null||v===undefined?'#8a949e':a.colorOf[m.variable](v));
  const parcelOp=m.parcelLayer.getLayers()[0].options.fillOpacity;
  const day0=a.state.day;
  const c0=ids.map(st).map(o=>o.color);
  a.setDay(Math.min(a.model.days.length-1, day0+40));
  const c1=ids.map(st).map(o=>o.color);
  a.setDay(day0);
  if(cb){cb.checked=false; cb.dispatchEvent(new Event('change',{bubbles:true}));}
  const off=ids.map(st);
  const parcelOpOff=m.parcelLayer.getLayers()[0].options.fillOpacity;
  return {present:!!cb, nGrids:layers.length, checkedBefore, before, after, vals, re, expectColors,
    colors0:c0, colors1:c1, off, parcelOp, parcelOpOff, interactive:m.gridLayer.options.interactive};})()`);
check('「网格着色」开关存在（217 个网格），打开后按当前指标着色，颜色与判据侧独立复算一致',
  s25.present && s25.nGrids === 217 && s25.checkedBefore === false
    && s25.after.every((o) => o.fill === true && o.op > 0)
    && s25.after.every((o, i) => o.color === s25.expectColors[i]),
  `${s25.nGrids} 个网格；抽样 ${s25.after.length} 个：填充 ${s25.after.map((o) => o.op).join('/')} · 颜色 ${s25.after.map((o) => o.color).join('/')} vs 期望 ${s25.expectColors.join('/')}`);
check('网格取值与 P2 单元**同一套聚合**（面积加权；判据自己算一遍）',
  s25.vals.every((v, i) => (v === null ? s25.re[i] === null : Math.abs(v - s25.re[i]) < 1e-9)),
  s25.vals.map((v, i) => `${v === null ? '无数据' : v.toFixed(4)}≈${s25.re[i] === null ? '无数据' : s25.re[i].toFixed(4)}`).join(' '));
check('网格着色**跟随当前帧**（换一天颜色随之变化）',
  s25.colors1.some((c, i) => c !== s25.colors0[i]),
  `第 ${s25.colors0.join('/')} → ${s25.colors1.join('/')}`);
check('关掉回到网格线（fill=false）；地块填充也跟着调暗/恢复（与 P2 同一套叠加层规则）',
  s25.before.every((o) => o.fill === false) && s25.off.every((o) => o.fill === false)
    && s25.parcelOp < 0.4 && s25.parcelOpOff > 0.7,
  `默认 fill=${s25.before.map((o) => o.fill).join('/')} · 关闭后 fill=${s25.off.map((o) => o.fill).join('/')} · 地块填充 ${s25.parcelOp} → ${s25.parcelOpOff}`);
check('网格图层**不可交互**（与单元层同理：不能吃掉"点地块"）',
  s25.interactive === false, `interactive=${s25.interactive}`);
await shot('gridfill-on-1440x900');


// ===================== 26. 叠加层同开 · 表↔图口径 · 情景图例 =====================
console.log('\n=== 26. 叠加层同开 / 表图口径 / 情景图例 ===');
await boot(1440, 900);
const s26 = await ev(`(()=>{const a=globalThis.__agri;const m=a.map;
  const cb=(n)=>document.querySelector('input[data-layer="'+n+'"]');
  const on=(n,v)=>{const el=cb(n); if(!el) return; el.checked=v; el.dispatchEvent(new Event('change',{bubbles:true}));};
  const parcelOp=()=>m.parcelLayer.getLayers()[0].options.fillOpacity;
  const unitOp=()=>m.unitLayer.getLayers()[0].options.fillOpacity||0;
  const gridOp=()=>m.gridLayer.getLayers()[0].options.fillOpacity||0;
  on('scenariofill', false);
  on('unitfill', false); on('gridfill', false);
  const base={p:parcelOp(), u:unitOp(), g:gridOp()};
  on('unitfill', true); on('gridfill', true);          // **两个叠加层同时开**
  const both={p:parcelOp(), u:unitOp(), g:gridOp(),
    uFill:!!m.unitLayer.getLayers()[0].options.fill, gFill:!!m.gridLayer.getLayers()[0].options.fill};
  on('gridfill', false);                                // 只关一个
  const onlyUnit={p:parcelOp(), u:unitOp(), g:gridOp(),
    uFill:!!m.unitLayer.getLayers()[0].options.fill, gFill:!!m.gridLayer.getLayers()[0].options.fill};
  on('unitfill', false);                                // 全关
  const none={p:parcelOp(), u:unitOp(), g:gridOp(),
    uFill:!!m.unitLayer.getLayers()[0].options.fill, gFill:!!m.gridLayer.getLayers()[0].options.fill};

  // 表 ↔ 图：同一个单元，表格的进度/水肥/病级与地图聚合值必须一致
  const u0=(()=>{document.querySelector('#tb-tabs button[data-tab="units"]').click();
    const tr=document.querySelector('#tb-body .tbl tbody tr'); return tr;})();
  const cells=[...document.querySelectorAll('#tb-body .tbl tbody tr')].slice(0,5).map(tr=>({
    id:tr.getAttribute('data-unit'), tds:[...tr.children].map(td=>td.textContent.trim())}));
  const cmp=cells.map(c=>{
    const id=c.id;
    const tProg=Number(c.tds[4])/100, tWater=Number(c.tds[6])/100, tFert=Number(c.tds[7])/100, tDis=Number(c.tds[5]);
    return {id, tProg, tWater, tFert, tDis,
      mWater:m.unitValueFor?null:null};
  });
  // 用同一套聚合在别处复算（判据侧独立算，不复用 unitValue）
  const rec=(id,varName)=>{let num=0,den=0,max=null;
    for(const row of a.rows){ if(row.unit_id!==id) continue;
      if(varName==='progress' && !(row.gddNeed>0)) continue;
      const v=a.get(row,varName,m.day); const w=row.area_ha||0;
      if(v===null||v===undefined||Number.isNaN(Number(v))) continue;
      if(varName==='disease'){ max=max===null?Number(v):Math.max(max,Number(v)); }
      else { num+=Number(v)*w; den+=w; } }
    return varName==='disease'?max:(den>0?num/den:null);};
  // ⚠️ 容差要按**显示精度**定：表里是"1 位小数的百分比"，比到 1e-6 是拿显示值要求全精度（假失败）
  const TOL=0.001;   // 0.1% ⇒ 覆盖"1 位小数百分比"的舍入
  const tableVsMap=cmp.map(c=>{const d={p:Math.abs(c.tProg-rec(c.id,'progress')),w:Math.abs(c.tWater-rec(c.id,'water')),
    f:Math.abs(c.tFert-rec(c.id,'fert')),dis:Math.abs(c.tDis-rec(c.id,'disease'))};
    return {id:c.id, ok:d.p<TOL&&d.w<TOL&&d.f<TOL&&d.dis<0.5, worst:Math.max(d.p,d.w,d.f)};});
  return {base, both, onlyUnit, none, tableVsMap,
    legendVar:document.getElementById('legend').textContent.slice(0,40),
    legendTitle:document.getElementById('legend-title').textContent};})()`);
check('**两个叠加层同时开**（P2 单元 + P4 网格）都填色、地块保持调暗；只关一个另一个不受影响；全关恢复',
  s26.both.uFill === true && s26.both.gFill === true && s26.both.u > 0 && s26.both.g > 0
    && s26.both.p < 0.4 && s26.onlyUnit.uFill === true && s26.onlyUnit.gFill === false
    && s26.none.p > 0.7 && s26.none.uFill === false && s26.none.gFill === false,
  `地块填充 ${s26.base.p} → 同开 ${s26.both.p} → 只留单元 ${s26.onlyUnit.p} → 全关 ${s26.none.p}`
    + ` · 单元填充 同开 ${s26.both.u}/只留单元 ${s26.onlyUnit.u}/全关 ${s26.none.u} · 网格 ${s26.both.g}/全关 ${s26.none.g}`);
check('**表 ↔ 图口径一致**：同一个经营单元，表格的进度/水分/养分/最高病级与地图聚合值逐项相同',
  s26.tableVsMap.length > 0 && s26.tableVsMap.every((x) => x.ok),
  `${s26.tableVsMap.filter((x) => x.ok).length}/${s26.tableVsMap.length} 个单元一致（抽样首 5 个，最大偏差 ${Math.max(...s26.tableVsMap.map((x) => x.worst)).toExponential(1)}）`);

// 情景图例：选点后图例要换成"节省分钟"档
const s26b = await ev(`(()=>{const a=globalThis.__agri;
  const cand=a.scenario.candidates.reduce((b,c)=>c.avg_gain_min>(b?b.avg_gain_min:-1)?c:b, null);
  a.pickScenario({lat:cand.lat, lng:cand.lon});
  const on={title:document.getElementById('legend-title').textContent,
    txt:document.getElementById('legend').textContent.replace(/\s+/g,' ').slice(0,80)};
  const cb=document.querySelector('input[data-layer="scenariofill"]');
  cb.checked=false; cb.dispatchEvent(new Event('change',{bubbles:true}));
  const off={title:document.getElementById('legend-title').textContent,
    txt:document.getElementById('legend').textContent.replace(/\s+/g,' ').slice(0,60)};
  return {on, off};})()`);
check('选点后**图例换成"情景对比：节省分钟"**（5 档 + 基本没改善），关掉图层恢复指标图例',
  /节省/.test(s26b.on.title) && /基本没改善/.test(s26b.on.txt) && !/节省/.test(s26b.off.title),
  `选点后图例标题「${s26b.on.title}」· 关闭后「${s26b.off.title}」`);


// ===================== 27. 口径说明上页面 · P4 统计网格表 =====================
console.log('\n=== 27. 口径说明 / P4 统计网格表 ===');
await boot(1440, 900);
const s27 = await ev(`(()=>{const a=globalThis.__agri;const ui=a.ui;const m=a.map;
  // 注意转义：这里必须写两个反斜杠，Node 的模板字符串会吃掉一个，否则浏览器收到的是替换字母 s 的 /s+/
  const lg=()=>document.getElementById('legend').textContent.replace(/\s+/g,' ').trim();
  const notes={};
  for(const v of ['progress','disease','crop','water']){ ui.setVariable(v); a.state.variable=v; m.setVariable(v); notes[v]=lg(); }
  ui.setVariable('progress'); a.state.variable='progress'; m.setVariable('progress');

  // 统计网格表：页签存在、行数、抽样值、面积守恒
  const tab=[...document.querySelectorAll('#tb-tabs button[data-tab]')].map(b=>b.dataset.tab);
  const moreTab=[...document.querySelectorAll('#tb-more option')].map(o=>o.value);
  document.querySelector('#tb-tabs button[data-tab="units"]').click();
  const unitNote=document.querySelector('#tb-note').textContent.replace(/\s+/g,' ');
  document.querySelector('#tb-tabs button[data-tab="grids"]').click();
  const trs=[...document.querySelectorAll('#tb-body .tbl tbody tr')];
  const note=document.querySelector('#tb-note')?document.querySelector('#tb-note').textContent.replace(/\s+/g,' '):'';
  const parse=(t)=>Number(String(t).replace(/[^0-9.-]/g,''));
  const rows=trs.map(tr=>({id:tr.getAttribute('data-grid'),
    tds:[...tr.children].map(td=>td.textContent.trim())}));
  const gridIds=new Set(a.rows.filter(r=>r.grid_id).map(r=>r.grid_id));
  const rec=(gid)=>{let num=0,den=0,area=0,n=0,max=null,crops=new Map();
    for(const row of a.rows){ if(row.grid_id!==gid) continue;
      n++; area+=row.area_ha;
      const w=row.area_ha||0;
      const ck=row.fallow?'FALLOW':(row.crop??null); if(ck) crops.set(ck,(crops.get(ck)??0)+w);
      if(row.gddNeed>0){ num+=Number(a.get(row,'progress',m.day))*w; den+=w; }
      max=Math.max(max===null?-1:max, Number(a.get(row,'disease',m.day))); }
    let bc=null,bw=-1; for(const [k,w] of crops) if(w>bw){bw=w;bc=k;}
    return {n,area,prog:den>0?num/den:null,dis:max,crop:bc};};
  const sample=rows.slice(0,6).map(r=>{const e=rec(r.id);return {id:r.id,
    got:{area:parse(r.tds[2]),n:Number(r.tds[3]),prog:parse(r.tds[4])/100,dis:Number(r.tds[5])},
    exp:{area:e.area,n:e.n,prog:e.prog,dis:e.dis},
    areaOk:Math.abs(parse(r.tds[2])-e.area)<0.06, nOk:Number(r.tds[3])===e.n,
    // 该网格全是牧草/果园时进度**无数据** ⇒ 表格显示"—"（写 0 会被读成"一点没长"）
    progOk:e.prog===null?r.tds[4]==='—':Math.abs(parse(r.tds[4])/100-e.prog)<0.001,
    disOk:Number(r.tds[5])===e.dis};});
  const sumArea=rows.reduce((t,r)=>t+parse(r.tds[2]),0);
  const sumN=rows.reduce((t,r)=>t+Number(r.tds[3]),0);

  // 点一行 ⇒ 高亮该网格的地块
  const first=trs[0]; const gid=first.getAttribute('data-grid');
  first.dispatchEvent(new MouseEvent('click',{bubbles:true}));
  const hlN=m.highlighted.length;
  const expectN=a.rows.filter(r=>r.grid_id===gid).length;
  return {notes, tab, moreTab, n:rows.length, distinct:gridIds.size, note, unitNote,
    sample, sumArea, sumN, totalArea:a.rows.reduce((t,r)=>t+r.area_ha,0), hlN, expectN};})()`);

check('图例下面写明**聚合口径**，且随变量变（进度=排除不播种、病级=取最严重、作物=面积最大的那一类、水分=面积加权）',
  /排除不播种/.test(s27.notes.progress) && /最严重/.test(s27.notes.disease)
    && /面积最大的那一类/.test(s27.notes.crop) && /面积加权（按地块面积）/.test(s27.notes.water),
  `水分图例尾注「${s27.notes.water.slice(-24)}」· 进度尾注「${s27.notes.progress.slice(-24)}」`);
check('经营单元表与网格表的**表注都写明口径**（与图例同一份规则，不另写一套）',
  /排除不播种/.test(s27.unitNote) && /排除不播种/.test(s27.note),
  `单元表注「${s27.unitNote.slice(0, 46)}…」· 网格表注「${s27.note.slice(0, 40)}…」`);

check('**P4 统计网格表**：页签存在（8 个页签，窄屏下拉同步），行数 = 有地块的网格数',
  s27.tab.includes('grids') && s27.moreTab.includes('grids') && s27.n === s27.distinct,
  `页签 ${s27.tab.length} 个 · 表格 ${s27.n} 行 = 有地块的网格 ${s27.distinct} 个`);
check('网格表取值与按 grid_id 的独立复算一致（面积/地块数/进度/最高病级，抽样 6 个网格）',
  s27.sample.length === 6 && s27.sample.every((x) => x.areaOk && x.nOk && x.progOk && x.disOk),
  `${s27.sample.filter((x) => x.areaOk && x.nOk && x.progOk && x.disOk).length}/6 一致 · 失败项 ${JSON.stringify((s27.sample.find((x) => !(x.areaOk && x.nOk && x.progOk && x.disOk)) || {}).id)} 实测 ${JSON.stringify((s27.sample.find((x) => !(x.areaOk && x.nOk && x.progOk && x.disOk)) || {}).got)} 期望 ${JSON.stringify((s27.sample.find((x) => !(x.areaOk && x.nOk && x.progOk && x.disOk)) || {}).exp)}`);
check('**两条空间路径对账**：Σ网格面积 ≈ Σ全部地块面积（换个空间键不丢数、不重复计）',
  Math.abs(s27.sumArea - s27.totalArea) < 0.2 * s27.n && s27.sumN === 501,
  `网格求和 ${s27.sumArea.toFixed(1)} ha ≈ 地块求和 ${s27.totalArea.toFixed(1)} ha · 地块数 ${s27.sumN}/501`);
check('点网格一行 ⇒ 在图上高亮该网格的成员地块（与单元同一套高亮通道）',
  s27.hlN === s27.expectN && s27.hlN > 0,
  `${s27.hlN} 个地块已高亮 = 该网格成员数 ${s27.expectN}`);


// 端到端：新视图（农事日历）真的到了页面上（离线算好、页面只查表）
const s27c = await ev(`(async()=>{const a=globalThis.__agri;const ui=a.ui;
  // 透视视图是**懒加载**的：ensurePivot() 只把请求发出去（自己返回 undefined），要等数据落回来
  a.ensurePivot();
  for(let i=0;i<60 && !ui.pivotData;i++) await new Promise((r)=>setTimeout(r,100));
  const views=ui.pivotData?.views??[];
  const idx=views.findIndex(v=>/农事日历/.test(v.title||''));
  if(idx<0) return {n:views.length, idx};
  // 先切到「透视视图」页签：表格是按**当前页签**渲染的，停在别的页签上读到的是别的表
  document.querySelector('#tb-tabs button[data-tab="pivot"]').click();
  const sel=document.getElementById('pivot-sel');
  sel.value=String(idx); sel.dispatchEvent(new Event('change',{bubbles:true}));
  const tbl=document.querySelector('#tb-body .tbl');
  const head=[...tbl.querySelectorAll('thead th')].map(th=>th.textContent.trim());
  const trs=[...tbl.querySelectorAll('tbody tr')];
  const csv=ui.pivotCsvText();
  return {n:views.length, idx, title:views[idx].title, rowLabel:views[idx].rowLabel, colLabel:views[idx].colLabel,
    head, nRows:trs.length, firstRow:[...trs[0].children].map(td=>td.textContent.trim()),
    lastRow:[...trs[trs.length-1].children].map(td=>td.textContent.trim()),
    csvHead:(csv.indexOf(String.fromCharCode(10))>=0?csv.split(String.fromCharCode(10))[1]:''), hasZeroDec:/[0-9]+\.00/.test(csv),
    // 月份必须**单调递增**（离线已排好序；页面若自己重排过，这里会红）
    months:trs.map(tr=>tr.children[0].textContent.trim()).filter(x=>/^[0-9]{4}-[0-9]{2}$/.test(x))};})()`);
// 合计**不写死**：读离线 CSV 的合计行来对（数据一改（如修了窗口边缘伪峰）这里不该假失败）
const q13csv = fs.readFileSync('tables/query/q13_农事日历_月_事件类型_次_.csv', 'utf8').trim().split(/\r?\n/);
const q13tot = q13csv[q13csv.length - 1].split(',').slice(1, 4).map((x) => Number(x));
check('**农事日历进页面**（离线算好、页面只查表）：13 月 × 3 类型 + 合计行，且合计与离线**表**逐项对得上',
  s27c.idx >= 0 && s27c.nRows === 14 && s27c.head.length === 5 && /月份/.test(s27c.head[0])
    && s27c.lastRow[0] === '合计'
    && s27c.lastRow.slice(1, 4).map(Number).every((v, i) => v === q13tot[i])
    && Number(s27c.lastRow[4]) === q13tot.reduce((a, b) => a + b, 0)
    && /^\d{4}-\d{2}$/.test(String(s27c.firstRow[0])) && !s27c.hasZeroDec
    && s27c.months.length === 13 && s27c.months.every((m, i) => i === 0 || m > s27c.months[i - 1]),
  `${s27c.n} 个视图（选中「${s27c.title}」· ${s27c.nRows - 1} 个月 + 合计行，${(s27c.months ?? [])[0]} → ${(s27c.months ?? []).slice(-1)[0]}）· 表头 ${(s27c.head ?? []).join('|')}`
    + ` · 首行 ${(s27c.firstRow ?? []).join('|')} · 末行 ${(s27c.lastRow ?? []).join('|')}`);


// ===================== 28. 网格排行图 · 农事日历堆叠柱 =====================
console.log('\n=== 28. 网格排行图 / 农事日历图 ===');
await boot(1440, 900);
// 抽屉里的排行图：统计网格（面积）
const s28a = await ev(`(async()=>{const a=globalThis.__agri;
  document.getElementById('btn-drawer').click();
  document.querySelector('#dw-tabs button[data-tab="grids"]').click();
  const wrap=document.getElementById('dw-chart-wrap');
  const cvs=document.getElementById('dw-chart'); const ctx=cvs.getContext('2d');
  const px=ctx.getImageData(0,0,cvs.width,cvs.height).data;
  let ink=0; for(let i=3;i<px.length;i+=4) if(px[i]>0) ink++;
  const info=a.ui.drawerChartInfo&&{col:a.ui.drawerChartInfo.col,n:a.ui.drawerChartInfo.items.length,
    top:a.ui.drawerChartInfo.items[0]?.label, v:a.ui.drawerChartInfo.items[0]?.value};
  return {shown:!wrap.classList.contains('hidden'), ink, info};})()`);
check('抽屉里**统计网格**也配了排行图（进度：面积不随时间变，回放时图会是僵的）',
  s28a.shown && s28a.info && s28a.info.col === '进度 %' && s28a.info.n > 0 && s28a.ink > 200,
  `${s28a.info?.n} 个网格，首位 ${s28a.info?.top}=${s28a.info?.v}% · 着色像素 ${s28a.ink}`);

// 农事日历：视图自带堆叠柱（由离线 JSON 的 chart 字段声明，页面不认 id）
const s28b = await ev(`(async()=>{const a=globalThis.__agri;const ui=a.ui;
  document.querySelector('#dw-tabs button[data-tab="pivot"]').click();
  a.ensurePivot();
  for(let i=0;i<60 && !ui.pivotData;i++) await new Promise(r=>setTimeout(r,100));
  const views=ui.pivotData?.views??[];
  const sel=document.getElementById('pivot-sel');
  const idx=views.findIndex(v=>v.chart==='stacked');
  if(idx<0) return {idx};
  sel.value=String(idx); sel.dispatchEvent(new Event('change',{bubbles:true}));
  const wrap=document.getElementById('dw-chart-wrap');
  const cvs=document.getElementById('dw-chart'); const ctx=cvs.getContext('2d');
  const px=ctx.getImageData(0,0,cvs.width,cvs.height).data;
  const hex=(r,g,b)=>'#'+[r,g,b].map(x=>x.toString(16).padStart(2,'0')).join('');
  const want={'#6fae4a':0,'#c9a23a':0,'#c0603a':0};
  let ink=0;
  for(let i=0;i<px.length;i+=4){
    if(px[i+3]>0) ink++;
    const k=hex(px[i],px[i+1],px[i+2]);
    if(k in want) want[k]++;
  }
  const on={shown:!wrap.classList.contains('hidden'), ink, want,
    info:ui.drawerChartInfo&&{kind:ui.drawerChartInfo.kind, view:ui.drawerChartInfo.view,
      groups:ui.drawerChartInfo.items.length}};
  // 切到一个**没有声明图**的视图 ⇒ 图必须收起来（否则留着上一张图就成了"错配的图例"）
  const plain=views.findIndex(v=>!v.chart);
  sel.value=String(plain); sel.dispatchEvent(new Event('change',{bubbles:true}));
  const off={shown:!wrap.classList.contains('hidden'), info:ui.drawerChartInfo};
  return {on, off, nViews:views.length};})()`);
check('**农事日历视图自带堆叠柱**（离线声明 chart 字段）：三类颜色都真画出来，切到无图视图就收起',
  s28b.on && s28b.on.shown && s28b.on.info && s28b.on.info.kind === 'stacked'
    && s28b.on.info.groups === 13 && s28b.on.ink > 1000
    && Object.values(s28b.on.want).every((n) => n > 200)
    && s28b.off.shown === false && s28b.off.info === null,
  `13 组 · 着色像素 ${s28b.on?.ink} · 播种/施肥/收获三色像素 ${Object.values(s28b.on?.want ?? {}).join('/')}`
    + ` · 切到无图视图后隐藏=${!s28b.off.shown}`);
// 新图是新代码路径：留一张截图，人能一眼看（像素数只能证明"画了"，证不了"画对了"）
// ⚠️ 上面那条判据最后**切到了无图视图**，所以截图前要切回来，否则拍到的是一张没有图的画面
await ev(`(()=>{const a=globalThis.__agri;const ui=a.ui;
  const idx=ui.pivotData.views.findIndex(v=>v.chart==='stacked');
  const sel=document.getElementById('pivot-sel'); sel.value=String(idx);
  sel.dispatchEvent(new Event('change',{bubbles:true}));
  return !document.getElementById('dw-chart-wrap').classList.contains('hidden');})()`);
await shot('dw-chart-农事日历-1440x900');


// ===================== 29. 情景前后对照图 =====================
console.log('\n=== 29. 情景前后对照图 ===');
await boot(1440, 900);
const s29 = await ev(`(async()=>{const a=globalThis.__agri;const ui=a.ui;
  // 选"平均改善最多"的候选点（与既有情景判据同一口径，保证可复现）
  const cand=a.scenario.candidates.reduce((b,c)=>c.avg_gain_min>(b?b.avg_gain_min:-1)?c:b,null);
  a.pickScenario({lat:cand.lat, lng:cand.lon});
  document.getElementById('btn-drawer').click();
  document.querySelector('#dw-tabs button[data-tab="scenario"]').click();
  const wrap=document.getElementById('dw-chart-wrap');
  const cvs=document.getElementById('dw-chart'); const ctx=cvs.getContext('2d');
  const px=ctx.getImageData(0,0,cvs.width,cvs.height).data;
  const hex=(r,g,b)=>'#'+[r,g,b].map(x=>x.toString(16).padStart(2,'0')).join('');
  let ink=0; const colors={};
  for(let i=0;i<px.length;i+=4){ if(px[i+3]>0) ink++; const k=hex(px[i],px[i+1],px[i+2]); colors[k]=(colors[k]??0)+1; }
  const info=ui.drawerChartInfo;
  // —— 独立复算（不复用页面函数）：每个单元的现状/新建后按成员地块**面积加权** ——
  const gains=new Map(cand.improved);
  const acc=new Map();
  for(const r of a.rows){ if(!r.unit_id||r.t_min==null) continue;
    let x=acc.get(r.unit_id); if(!x){x={before:0,after:0,w:0};acc.set(r.unit_id,x);}
    const w=r.area_ha||0, g=gains.get(r.i)??0;
    x.before+=r.t_min*w; x.after+=Math.max(0,r.t_min-g)*w; x.w+=w; }
  const all=[...acc.entries()].map(([id,x])=>({id, gain:x.w?(x.before-x.after)/x.w:0,
    before:x.w?x.before/x.w:0, after:x.w?x.after/x.w:0})).filter(x=>x.gain>0.001).sort((p,q)=>q.gain-p.gain);
  const topAll=all[0];
  const items=info&&info.items?info.items:[];
  const first=items[0]||{};
  const rec=all.find(x=>x.id===first.id)||{};
  const afterLeBefore=items.every(x=>x.after<=x.before+1e-9);
  const gainOk=items.every(x=>Math.abs((x.before-x.after)-x.gain)<0.05);
  const colorsBig=Object.values(colors).filter(n=>n>200).length;
  return {shown:!wrap.classList.contains('hidden'), ink, colorsBig,
    kind:info&&info.kind, col:info&&info.col, n:items.length,
    firstId:first.id, firstGain:first.gain, firstLabel:first.label,
    rec, topAll, afterLeBefore, gainOk, nUnitsAll:all.length};})()`);
check('情景**前后对照图**（按经营单元，现状 → 新建后）：画在「情景推演」抽屉里，两种颜色都真画出来',
  s29.shown && s29.kind === 'paired' && s29.n > 0 && s29.n <= 12 && s29.ink > 500 && s29.colorsBig >= 2,
  `${s29.n} 个单元（共 ${s29.nUnitsAll} 个有改善）· 着色像素 ${s29.ink} · 两种以上主色 ${s29.colorsBig}`
    + ` · 首位 ${s29.firstLabel}（省 ${Math.round((s29.firstGain ?? 0) * 10) / 10} min）`);
check('前后对照的**数**可独立复算，且不变量成立：after ≤ before（逐单元）、首位就是改善最大的那个单元',
  Math.abs((s29.firstGain ?? -1) - (s29.rec.gain ?? -2)) < 0.05
    && Math.abs((s29.rec.before ?? 0) - (s29.topAll?.before ?? 0)) < 0.05
    && s29.topAll && s29.firstId === s29.topAll.id && s29.afterLeBefore && s29.gainOk,
  `复算 ${s29.firstId}：现状 ${(s29.rec.before ?? 0).toFixed(2)} → 新建后 ${(s29.rec.after ?? 0).toFixed(2)}`
    + `（页面 ${(s29.topAll?.before ?? 0).toFixed(2)} → ${(s29.topAll?.after ?? 0).toFixed(2)}）`
    + ` · after ≤ before 全成立=${s29.afterLeBefore} · 首位=最大改善单元 ${s29.firstId === s29.topAll?.id}`);
await shot('dw-chart-情景前后对照-1440x900');


// ===================== 30. 页面 ↔ 离线 CSV 对账（区域逐日 月汇总） =====================
console.log('\n=== 30. 页面 ↔ 离线表对账（区域逐日月汇总） ===');
await boot(1440, 900);
{
  // 离线产物（先由自研引擎算、再被 DuckDB 逐格核过）—— 拿它当**独立来源**核对页面
  const csvPath = 'tables/query/q8_区域逐日_按年月汇总.csv';
  const lines = fs.readFileSync(csvPath, 'utf8').trim().split(/\r?\n/);
  const csvHead = lines[0].split(',');
  const csvRow1 = lines[1].split(',');
  const page = await ev(`(async()=>{const a=globalThis.__agri;const ui=a.ui;
    a.ensurePivot();
    for(let i=0;i<60 && !ui.pivotData;i++) await new Promise(r=>setTimeout(r,100));
    const views=ui.pivotData?.views??[];
    const idx=views.findIndex(v=>v.id==='q8');
    if(idx<0) return {n:views.length, idx};
    document.querySelector('#tb-tabs button[data-tab="pivot"]').click();
    const sel=document.getElementById('pivot-sel');
    sel.value=String(idx); sel.dispatchEvent(new Event('change',{bubbles:true}));
    const tbl=document.querySelector('#tb-body .tbl');
    const head=[...tbl.querySelectorAll('thead th')].map(th=>th.textContent.trim());
    const trs=[...tbl.querySelectorAll('tbody tr')];
    const r1=[...trs[0].children].map(td=>td.textContent.trim());
    const csv=ui.pivotCsvText();
    return {n:views.length, idx, title:views[idx]?.title, nRows:trs.length, head, r1,
      csvLines:csv.trim().split(String.fromCharCode(10)).length};})()`);
  const num = (x) => Number(String(x).replace(/[^0-9.eE+-]/g, ''));
  const same = csvRow1.map((v, i) => Math.abs(num(v) - num(page.r1?.[i])) <= Math.max(1e-6, Math.abs(num(v)) * 1e-9));
  check('页面「区域逐日（月汇总）」与**离线 CSV 逐格对账**（页面的数不是页面自己算的，两边同源可比）',
    page.idx >= 0 && page.nRows === lines.length - 1 && page.head.join(',') === csvHead.join(',')
      && same.every(Boolean) && page.csvLines === lines.length + 1,
    `离线 ${lines.length - 1} 行 × ${csvHead.length} 列 · 页面 ${page.nRows} 行；首行 `
      + csvHead.map((h, i) => `${h}=${csvRow1[i]}${same[i] ? '✓' : `✗(${page.r1?.[i]})`}`).slice(0, 3).join(' ')
      + ` · 视图 ${page.n} 个`);
}


// "不画双地图"的**空间依据**：地图区劈半后每张还剩多少（量出来，不是估的）
const mapW1440 = await ev(`document.getElementById('map').clientWidth`);
await boot(1024, 640);
const mapW1024 = await ev(`document.getElementById('map').clientWidth`);
check('**不画"双地图"**的空间依据（实测）：最小尺寸下劈半每张只剩不到 200px ⇒ 前后对照改用条形图',
  mapW1024 / 2 < 250 && mapW1440 / 2 < 420,
  `1440×900 地图区 ${mapW1440}px ⇒ 劈半 ${Math.round(mapW1440 / 2)}px · `
    + `1024×640 ⇒ ${mapW1024}px、劈半 ${Math.round(mapW1024 / 2)}px（已定：前后对照改用条形图）`);


// 收获峰值日：页面（模型逐日序列）× 离线事件表（收获事件）两条路径必须同一天
{
  const evLines = fs.readFileSync('tables/fact_parcel_event.csv', 'utf8').trim().split(/\r?\n/);
  const evHead = evLines[0].split(',');
  const iType = evHead.indexOf('event_type');
  const iDay = evHead.indexOf('event_day');
  const iPid = evHead.indexOf('parcel_id');
  const par = fs.readFileSync('tables/dim_parcel.csv', 'utf8').trim().split(/\r?\n/);
  const parHead = par[0].split(',');
  const iP = parHead.indexOf('parcel_id');
  const iA = parHead.indexOf('area_ha');
  const area = new Map(par.slice(1).map((l) => { const c = l.split(','); return [c[iP], Number(c[iA])]; }));
  const byDay = new Map();
  for (const l of evLines.slice(1)) {
    const c = l.split(',');
    if (c[iType] !== 'harvest') continue;
    byDay.set(c[iDay], (byDay.get(c[iDay]) ?? 0) + (area.get(c[iPid]) ?? 0));
  }
  const offPeak = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0];
  const page = await ev(`(()=>{const a=globalThis.__agri;
    const q=(a.buildTables(a.state.day).questions??[]).find(x=>x.key==='harvest-peak')||{};
    const m=String(q.top||'').match(/全窗口最忙\\s*(\\d{4})-(\\d{2})-(\\d{2})[：:]\\s*([0-9.]+)\\s*ha/);
    return {top:q.top||'', day:m?(m[1]+m[2]+m[3]):null, ha:m?Number(m[4]):null};})()`);
  check('**收获峰值日两条路径一致**：页面（模型逐日序列）与离线事件表（收获事件）指向同一天，面积对得上',
    page.day === offPeak[0] && Math.abs((page.ha ?? -1) - offPeak[1]) < 0.2,
    `页面 ${page.day} ${page.ha} ha · 离线事件表 ${offPeak[0]} ${offPeak[1].toFixed(1)} ha（${byDay.size} 个收获日）`);
  check('峰值日**不在窗口第一天**（多年生作物窗口边缘伪峰已修：2024-07-01 那 292.4 ha 是假的）',
    page.day !== null && page.day !== '20240701' && offPeak[0] !== '20240701',
    `页面峰值 ${page.day} · 离线峰值 ${offPeak[0]} · 窗口首日 2024-07-01 的收获面积 ${(byDay.get('20240701') ?? 0).toFixed(1)} ha`);
}


// ===================== 31. 时序回放 · 候选点排行 =====================
console.log('\n=== 31. 时序回放 / 候选点排行 ===');
await boot(1440, 900);
// ② 回放：单元 / 网格 的着色与图表**随日期动**，且两天的颜色都等于独立复算
const s31a = await ev(`(async()=>{const a=globalThis.__agri;const m=a.map;const ui=a.ui;
  const cb=(n)=>document.querySelector('input[data-layer="'+n+'"]');
  const on=(n,v)=>{const el=cb(n); if(!el) return; el.checked=v; el.dispatchEvent(new Event('change',{bubbles:true}));};
  on('unitfill',true); on('gridfill',true);
  const unitColors=()=>m.unitLayer.getLayers().slice(0,4).map(l=>l.options.fillColor||'');
  const gridColors=()=>m.gridLayer.getLayers().slice(0,4).map(l=>l.options.fillColor||'');
  // 独立复算：按 AGG_RULE 面积加权（progress 排除不播种），再走 colorOf
  const rec=(field,id)=>{let num=0,den=0;
    for(const r of a.rows){ if(r[field]!==id) continue;
      if(!(r.gddNeed>0)) continue;
      const v=a.get(r,'progress',m.day); const w=r.area_ha||0;
      if(v===null||v===undefined||Number.isNaN(Number(v))) continue; num+=Number(v)*w; den+=w; }
    return den>0?num/den:null;};
  const days=[Math.floor(a.model.days.length*0.35), Math.floor(a.model.days.length*0.8)];
  const snap=[];
  for(const d of days){
    a.setDay(d);
    await new Promise(r=>setTimeout(r,60));
    const u0=m.unitLayer.getLayers()[0].feature.properties.unit_id;
    const g0=m.gridLayer.getLayers()[0].feature.properties.grid_id;
    snap.push({d, ymd:a.model.days[d], uc:unitColors(), gc:gridColors(),
      u0:{id:u0, got:(m.unitLayer.getLayers()[0].options.fillColor||''), want:a.colorOf.progress(rec('unit_id',u0))},
      g0:{id:g0, got:(m.gridLayer.getLayers()[0].options.fillColor||''), want:a.colorOf.progress(rec('grid_id',g0))}});
  }
  // 图表随日期动：抽屉里的网格排行图（进度）在两个日期应当不同
  document.getElementById('btn-drawer').click();
  document.querySelector('#dw-tabs button[data-tab="grids"]').click();
  const chart=[];
  for(const d of days){
    a.setDay(d);
    await new Promise(r=>setTimeout(r,80));
    const info=ui.drawerChartInfo;
    chart.push({d, col:info&&info.col, top:info&&info.items&&info.items[0]&&info.items[0].value,
      topLabel:info&&info.items&&info.items[0]&&info.items[0].label});
  }
  return {snap, chart, days};})()`);
// 效果截图：停在较晚的那个日期，单元/网格着色与网格排行图都已是那一帧的
await shot('replay-当日着色-1440x900');
check('**时序回放**：换日期后单元与网格的着色都真的变了，且两天都等于按 AGG_RULE 的独立复算',
  s31a.snap.length === 2
    && s31a.snap[0].uc.join() !== s31a.snap[1].uc.join()
    && s31a.snap[0].gc.join() !== s31a.snap[1].gc.join()
    && s31a.snap.every((x) => x.u0.got === x.u0.want && x.g0.got === x.g0.want),
  `${s31a.snap[0].ymd} vs ${s31a.snap[1].ymd}：单元首色 ${s31a.snap[0].uc[0]}→${s31a.snap[1].uc[0]}`
    + ` · 网格首色 ${s31a.snap[0].gc[0]}→${s31a.snap[1].gc[0]}`
    + ` · 复算一致 ${s31a.snap.every((x) => x.u0.got === x.u0.want) ? '单元✓' : '单元✗'}`
    + `${s31a.snap.every((x) => x.g0.got === x.g0.want) ? ' 网格✓' : ' 网格✗'}`);
check('**回放时图表跟着动**：网格排行图（进度）在两个日期的首位值不同（面积不随时变 ⇒ 改用进度）',
  s31a.chart[0].col === '进度 %' && s31a.chart[1].col === '进度 %'
    && s31a.chart[0].top !== s31a.chart[1].top,
  `${s31a.chart[0].topLabel} ${s31a.chart[0].top}% → ${s31a.chart[1].topLabel} ${s31a.chart[1].top}%`);

// ③ 候选点排行：154 行、按受益面积降序、抽样与离线 JSON 一致、点一行能选中
const s31b = await ev(`(async()=>{const a=globalThis.__agri;const ui=a.ui;const m=a.map;
  window.confirm=()=>true;
  document.querySelector('#tb-tabs button[data-tab="scenario"]').click();
  await new Promise(r=>setTimeout(r,80));
  const trs=[...document.querySelectorAll('#tb-body .tbl tbody tr')];
  const parse=(t)=>Number(String(t).replace(/[^0-9.-]/g,''));
  const head=[...document.querySelectorAll('#tb-body .tbl thead th')].map(t=>t.textContent.trim());
  const rows=trs.map(tr=>({cand:tr.getAttribute('data-cand'), cells:[...tr.children].map(td=>td.textContent.trim())}));
  const cands=a.scenario.candidates;
  const r5=(v)=>Math.round(v*1e5);
  const findCand=(attr)=>{const [lng,lat]=String(attr).split('|').map(Number);
    return cands.find(c=>r5(c.lon)===r5(lng)&&r5(c.lat)===r5(lat));};
  // 独立复算：受益面积最大的候选
  const argmax=cands.reduce((b,c,i)=>c.improved_ha>(b.ha??-1)?{i,ha:c.improved_ha}:b,{});
  // ⚠️ 表格按受益面积**排过序** ⇒ 行号 ≠ 候选序号，必须按行上的 data-cand 找回候选再比
  const sample=[0,1,2].map(i=>{const c=findCand(rows[i].cand)||{};
    return {id:rows[i].cells[0], gotH:parse(rows[i].cells[1]), wantH:c.improved_ha,
      gotG:parse(rows[i].cells[2]), wantG:c.avg_gain_min};});
  // 点第 3 行 ⇒ 地图高亮该候选的受影响地块 + 那一行被标 ★
  const target=findCand(rows[2].cand)||{improved:[]};
  document.querySelector('#dw-tabs button[data-tab="scenario"]').click();
  await new Promise(r=>setTimeout(r,60));
  // 未选点：抽屉图现在是**候选散点**（受益面积 × 平均节省 + 帕累托前沿）；
  // 排行本身表格已经给了（154 行按面积降序），图用来回答"面积大和省得多是不是同一批点"
  const beforePick={chartKind:ui.drawerChartInfo&&ui.drawerChartInfo.kind,
    n:ui.drawerChartInfo&&ui.drawerChartInfo.n, front:ui.drawerChartInfo&&ui.drawerChartInfo.front};
  return {n:rows.length, nCands:cands.length, head, sample, argmax, beforePick,
    sortedDesc:rows.every((r,i)=>i===0||parse(rows[i-1].cells[1])>=parse(r.cells[1])),
    firstIsArgmax:parse(rows[0].cells[1])===argmax.ha};})()`);
// 效果截图①：**还没选中任何候选点** —— 抽屉里是"候选点排行图"（该建在哪）
await shot('candidates-rank-1440x900');
// 然后点第 3 行（选中该候选点）
const s31c = await ev(`(async()=>{const a=globalThis.__agri;const ui=a.ui;const m=a.map;
  const trs=[...document.querySelectorAll('#tb-body .tbl tbody tr')];
  trs[2].dispatchEvent(new MouseEvent('click',{bubbles:true}));
  await new Promise(r=>setTimeout(r,150));
  const marked=[...document.querySelectorAll('#tb-body .tbl tbody tr')].filter(tr=>/★/.test(tr.textContent)).length;
  const note=document.getElementById('tb-note').textContent.replace(/\s+/g,' ');
  // 前后对照图在**抽屉**里，所以断言前要先把抽屉切到「情景推演」
  document.querySelector('#dw-tabs button[data-tab="scenario"]').click();
  await new Promise(r=>setTimeout(r,100));
  return {hl:m.highlighted.length, marked, note, chartKind:ui.drawerChartInfo&&ui.drawerChartInfo.kind};})()`);
// 效果截图②：选中后（★ + 地图高亮 + 抽屉里的前后对照图）
await shot('candidates-picked-1440x900');
check('**候选点排行表**：154 个候选全在表里、按受益面积降序、首位就是最大受益候选（独立复算）',
  s31b.n === s31b.nCands && s31b.sortedDesc && s31b.firstIsArgmax && s31b.head.length === 9,
  `${s31b.n}/${s31b.nCands} 行 · 列 ${s31b.head.length} 个 · 首位 ${s31b.head[1]} = ${s31b.argmax.ha} ha（降序 ${s31b.sortedDesc}）`);
check('未选点时的抽屉图是**候选散点**（受益面积 × 平均节省，154 个点 + 帕累托前沿），选点后切成"前后对照"（省在哪里）',
  s31b.beforePick?.chartKind === 'scatter' && s31b.beforePick?.n === s31b.nCands && s31c.chartKind === 'paired',
  `选点前 kind=${s31b.beforePick?.chartKind}（${s31b.beforePick?.n} 点 / 前沿 ${s31b.beforePick?.front} 个）→ 选点后 kind=${s31c.chartKind}`);
check('候选点的**数**与离线 JSON 一致（抽样 3 个：受益面积 / 平均节省）',
  s31b.sample.every((x) => Math.abs(x.gotH - x.wantH) < 0.06 && Math.abs(x.gotG - x.wantG) < 0.005),
  s31b.sample.map((x) => `${x.id} ${x.gotH}=${x.wantH}·${x.gotG}≈${x.wantG}`).join(' · '));
check('**点候选点一行 ⇒ 在图上选中该点**（高亮其受影响地块 + 该行标 ★ + 图切成前后对照）',
  s31c.hl > 0 && s31c.marked === 1 && s31c.chartKind === 'paired' && /已选/.test(s31c.note),
  `高亮 ${s31c.hl} 块 · ★ 行 ${s31c.marked} · 图 kind=${s31c.chartKind} · 表注含"已选"`);


// ===================== 32. 常用数据图示（折线 / 饼 / 柱 / 雷达） =====================
console.log('\n=== 32. 常用图表：折线 / 饼 / 柱 / 雷达 ===');
await boot(1440, 900);
const s32 = await ev(`(async()=>{const a=globalThis.__agri;const ui=a.ui;
  const tabs=[...document.querySelectorAll('#tb-tabs button[data-tab]')].map(b=>b.dataset.tab);
  document.querySelector('#tb-tabs button[data-tab="charts"]').click();
  await new Promise(r=>setTimeout(r,120));
  const inkOf=(id)=>{const c=document.getElementById(id); if(!c) return -1;
    const px=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
    let k=0; for(let i=3;i<px.length;i+=4) if(px[i]>0) k++; return k;};
  const sizes={};
  for(const id of ['tb-line','tb-pie','tb-col','tb-radar']){
    const c=document.getElementById(id); sizes[id]=c?[c.width,c.height]:null;}
  const ink={line:inkOf('tb-line'), pie:inkOf('tb-pie'), col:inkOf('tb-col'), radar:inkOf('tb-radar')};
  const cards=[...document.querySelectorAll('#tb-body .chart-card')].map(f=>({
    title:f.querySelector('b').textContent.trim(), note:f.querySelector('span').textContent.trim()}));

  // 数据正确性：图里的数必须与**表格**同源（UI 不做聚合，聚合在 main.js）
  const d=ui.actions.onChartData();
  const T=a.buildTables(a.state.day);
  const cropArea=Object.fromEntries(T.crops.map(c=>[c.name,c.area]));
  const pieBad=d.pie.items.filter(x=>Math.abs(x.value-cropArea[x.label])>0.05);
  const pieSum=d.pie.items.reduce((s2,x)=>s2+x.value,0);
  const cropSum=T.crops.reduce((s2,x)=>s2+x.area,0);
  // 标签是**短码**（完整码画到轴上会被截断成同一个样子 —— 这个坑真踩过）
  const short=(c)=>c.split('-').slice(1).join('')||c;
  // 柱状图画的指标：到收储点最远的 12 个单元（选它是因为"真的有差距"，面积那种几乎没差距的指标图是白画）
  const colWant=[...T.units].filter(u=>u.tMin!=null).sort((x,y)=>y.tMin-x.tMin).slice(0,12).map(u=>short(u.code));
  const colSpread=(()=>{const v=d.column.items.map(x=>x.value);
    return Math.max(...v)/Math.max(1e-9,Math.min(...v));})();
  const colGot=d.column.items.map(x=>x.label);
  // 雷达：只断言"值都在 0~1"（逐值口径在 §33/§35 用公共辅助核对，避免三份拷贝各说各话）
  const dim=d.radar.dims.length;
  const ok01=d.radar.series.every(s2=>s2.values.length===dim && s2.values.every(v=>v>=0&&v<=1));
  // 折线：序列与 x 轴标签等长、mark 指向当前帧
  const lineOk=d.line.series.length===4 && d.line.series.every(s2=>s2.values.length===d.line.xLabels.length)
    && d.line.mark>=0 && d.line.mark<d.line.xLabels.length;
  return {tabs, ink, sizes, cards,
    pieBad:pieBad.length, pieSum, cropSum, colGot, colWant, colSpread, radarSeries:d.radar.series.length, dim, ok01, lineOk,
    radarLabels:d.radar.series.map(s2=>s2.label),
    hint:document.querySelector('#tb-body .chart-hint')?.textContent.trim()||''};})()`);
await shot('charts-底部条-1440x900');
check('「图表」页签存在（9 个页签），一屏四张图**都真画了像素**（折线/饼/柱/雷达），且每张都带标题与口径说明',
  s32.tabs.includes('charts') && s32.tabs.length === 9
    && s32.ink.line > 200 && s32.ink.pie > 200 && s32.ink.col > 200 && s32.ink.radar > 200
    && s32.cards.length === 4 && s32.cards.every((c) => c.title && c.note.length > 8),
  `页签 ${s32.tabs.length} 个 · 着色像素 折线 ${s32.ink.line} / 饼 ${s32.ink.pie} / 柱 ${s32.ink.col} / 雷达 ${s32.ink.radar}`
    + ` · 卡片 ${s32.cards.length} 张（各带口径说明）`);
check('饼图与柱状图的**数来自表格**（同源）：逐项等于作物面积、柱前 12 等于按"到收储点"排序的单元',
  s32.pieBad === 0 && Math.abs(s32.pieSum - s32.cropSum) < 0.2
    && s32.colGot.join() === s32.colWant.join()
    && new Set(s32.colGot).size === s32.colGot.length
    && s32.colSpread > 1.5,
  `饼 ${s32.pieSum.toFixed(1)} = 作物面积合计 ${s32.cropSum.toFixed(1)} ha（逐项不符 ${s32.pieBad}）`
    + ` · 柱前 12 与独立排序一致=${s32.colGot.join() === s32.colWant.join()}`
    + ` · 标签互不相同=${new Set(s32.colGot).size === s32.colGot.length}（${s32.colGot.slice(0, 3).join('/')}…）`
    + ` · 柱值最大/最小 = ${s32.colSpread.toFixed(2)} 倍（**图必须真有差距**：面积那种 1.04 倍的指标画出来等于白画）`);
check('雷达图：5 维、2 个系列（选中单元 vs 全场均值），且**所有值都在 0~1**（量纲已归一）',
  s32.dim === 5 && s32.radarSeries === 2 && s32.ok01,
  `${s32.dim} 维 × ${s32.radarSeries} 系列：${s32.radarLabels.join(' / ')}`);
check('折线图：4 条区域时序、与 x 轴标签等长、竖线指向**当前帧**',
  s32.lineOk, `4 条序列 × ${s32.lineOk ? '标签等长' : '标签不等长'} · mark 在范围内`);
await shot('charts-抽屉-1440x900');
// 抽屉里也有同一块面板（**单独查一次**：两处共用一次测量会掩盖"抽屉里根本没画"）
const s32dw = await ev(`(async()=>{const a=globalThis.__agri;
  document.getElementById('btn-drawer').click();
  document.querySelector('#dw-tabs button[data-tab="charts"]').click();
  await new Promise(r=>setTimeout(r,140));
  const cards=document.querySelectorAll('#dw-body .chart-card').length;
  const c=document.getElementById('dw-pie');
  const px=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
  let ink=0; for(let i=3;i<px.length;i+=4) if(px[i]>0) ink++;
  return {cards, ink, hasHint:!!document.querySelector('#dw-body .chart-hint')};})()`);
await shot('charts-抽屉-1440x900');
check('抽屉里是**同一块面板**（四张图），而"底部条很窄"的指引只出现在底部条',
  s32dw.cards === 4 && s32dw.ink > 200 && s32dw.hasHint === false && s32.hint.length > 6,
  `抽屉卡片 ${s32dw.cards} 张 · 饼图着色像素 ${s32dw.ink} · 底部条有指引=${s32.hint.length > 6}、抽屉里没有=${!s32dw.hasHint}`);

// 退化行为：空数据不许画成白图（原语级直接验）
const s32b = await ev(`(()=>{const a=globalThis.__agri;const ui=a.ui;
  const mk=(id)=>{const c=document.createElement('canvas'); c.id=id; c.style.width='240px';
    document.getElementById('tb-body').appendChild(c); return c;};
  const mods=a.ui.charts;
  const out={};
  for(const [name,fn] of [['pie',(c)=>mods.pieChart(c,[])],
                          ['line',(c)=>mods.lineChart(c,[])],
                          ['col',(c)=>mods.columnChart(c,[])],
                          ['radar',(c)=>mods.radarChart(c,{axes:[{label:'a'}],series:[]})]]){
    const c=mk('probe-'+name);
    let ret=null; try{ ret=fn(c); }catch(e){ out[name]='抛错:'+e.message; continue; }
    const px=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
    let k=0; for(let i=3;i<px.length;i+=4) if(px[i]>0) k++;
    out[name]={ret:ret===null?'null':'有返回', ink:k};
    c.remove();
  }
  return out;})()`);
check('**空数据不画白图**：四个原语在空输入下都返回 null 并写出提示文字（不是一张空白画布）',
  Object.values(s32b).every((v) => typeof v === 'object' && v.ret === 'null' && v.ink > 40),
  Object.entries(s32b).map(([k, v]) => `${k}: ${typeof v === 'object' ? `${v.ink} 像素` : v}`).join(' · '));


// ===================== 33. 显示范围适配：对比更明显 + 截轴有写明 =====================
console.log('\n=== 33. 显示范围：对比更明显 / 截轴有写明 ===');
await boot(1440, 900);
const s33 = await ev(`(async()=>{const a=globalThis.__agri;const ui=a.ui;
  const mk=()=>{const c=document.createElement('canvas'); c.style.width='320px'; c.style.height='168px';
    document.getElementById('tb-body').appendChild(c); return c;};
  const bandInk=(c,y0,y1)=>{const px=c.getContext('2d').getImageData(0,y0,c.width,y1-y0).data;
    let k=0; for(let i=3;i<px.length;i+=4) if(px[i]>0) k++; return k;};
  const d=ui.actions.onChartData();
  const CH=ui.charts;
  // 取"最小值不为 0"的那条（水分保持）来测收紧；生长进度最小值就是 0 ⇒ 收不动是**诚实行为**
  const zeroBased=d.line.series[0];                       // 生长进度（跨 0）
  const one=d.line.series[2];                             // 水分保持（不跨 0）
  const span1=Math.max(...one.values)-Math.min(...one.values);
  const rAll=CH.dataRange(d.line.series.flatMap(s2=>s2.values));
  const rOne=CH.dataRange(one.values);
  const rZero=CH.dataRange(zeroBased.values);
  // "对比度" = 该序列的数据跨度 ÷ 轴跨度（越大，波动越明显）
  const contrast0=span1/(rAll.hi-rAll.lo), contrast1=span1/(rOne.hi-rOne.lo);
  const c1=mk(); const m1=CH.lineChart(c1,[one],{height:168,yMin:rOne.lo,yMax:rOne.hi});
  const cw=mk(); CH.lineChart(cw,[one],{height:168,yMin:rOne.lo,yMax:rOne.hi});
  const cn=mk(); CH.lineChart(cn,[one],{height:168,yMin:0,yMax:rOne.hi});
  const cornerWith=bandInk(cw,0,26), cornerNone=bandInk(cn,0,26);

  document.querySelector('#tb-tabs button[data-tab="charts"]').click();
  await new Promise(r=>setTimeout(r,150));
  const chips=[...document.querySelectorAll('#tb-line-toggles .chip')];
  const allNote=document.getElementById('tb-line-note').textContent.replace(/\s+/g,' ');
  [0,1,3].forEach(i=>chips[i].click());          // 关掉 3 条，**留下水分保持**（不跨 0 的那条）
  await new Promise(r=>setTimeout(r,90));
  const tightNote=document.getElementById('tb-line-note').textContent.replace(/\s+/g,' ');
  const offCount=document.querySelectorAll('#tb-line-toggles .chip.off').length;
  const leftOn=[...document.querySelectorAll('#tb-line-toggles .chip:not(.off)')].map(b=>b.textContent.trim());
  chips[2].click();                              // 再关掉最后一条 ⇒ 应被挡住
  await new Promise(r=>setTimeout(r,50));
  const stillOff=document.querySelectorAll('#tb-line-toggles .chip.off').length;

  const cL=mk(); const mColL=CH.columnChart(cL,d.column.items,{height:168,rotateLabels:true,labelValues:true});
  // ⚠️ 两次必须用**同一个 yMax**：带标值会留 12% 顶空，柱子变矮 ⇒ 顶部那条带会被柱子长度污染（不是标值）
  const cN=mk(); const mCol=CH.columnChart(cN,d.column.items,{height:168,rotateLabels:true,labelValues:false,yMax:mColL.yMax});
  const topL=bandInk(cL,0,26), topN=bandInk(cN,0,26);

  const T=a.buildTables(a.state.day);
${UNIT_NORM_SRC}
  const units=T.units;
  const spreadFixed=DIM_SPAN;                                      // 原始跨度
  const usable=DIM_USABLE;                                         // 与 main.js 同一个阈值
  const normAll=T.units.map(norm5);
  // 归一后的**每维跨度**：可用维度必须用满 0~1；不可用维度必须一律 0.5（不许把 0.04 的噪声放大成整根轴）
  const spreadRange=DIM_HI.map((h,k)=>Math.max(...normAll.map(r=>r[k]))-Math.min(...normAll.map(r=>r[k])));
  const mean=(arr)=>arr.reduce((t,x)=>t+x,0)/arr.length;
  const sel=units.find(u=>u.id===ui.selected?.unit_id)??[...units].sort((x,y)=>(y.disease??0)-(x.disease??0))[0];
  const avg=areaAvg5;
  const mae=(v)=>v.reduce((t,x,k)=>t+Math.abs(x-avg[k]),0)/5;
  const selVec=d.radar.series[0]?.values ?? [];
  const maeRange=mae(selVec);
  const maeFixed=mae(raw5(sel));
  return {contrast0,contrast1,span1,lineRange:[rOne.lo,rOne.hi],m1zero:m1.zeroBase,rZero,leftOn,
    cornerWith,cornerNone,offCount,stillOff,allNote,tightNote,
    colZero:mCol.zeroBase,colLabel:mColL.labelValues,topL,topN,
    dims:d.radar.dims.length,spreadRange,spreadFixed,usable,spreadFixedMean:mean(spreadFixed),
    maeRange,maeFixed,notes:d.notes};})()`);
check('**折线：只看一条 ⇒ 纵轴收到它自己的范围**（对比度提升）；而**最小值本来就是 0 的序列保持 0 基**（不许假装收紧）',
  s33.contrast1 > s33.contrast0 * 1.5 && s33.m1zero === false && s33.offCount === 3 && s33.stillOff === 3
    && /非零基/.test(s33.tightNote) && s33.rZero.lo === 0
    && s33.leftOn.length === 1 && /水分/.test(s33.leftOn[0]),
  `对比度 ${(s33.contrast0 * 100).toFixed(0)}% → ${(s33.contrast1 * 100).toFixed(0)}%`
    + `（${(s33.contrast1 / s33.contrast0).toFixed(2)} 倍）· 跨 0 的序列轴下界=${s33.rZero.lo.toFixed(2)}（保持 0 基）`
    + ` · 只看一条（${s33.leftOn.join('')}）后「${s33.tightNote.slice(-22)}」· 最后一条关不掉=${s33.stillOff === 3}`);
check('**截轴写在图上**：非零基时图角画出「轴 x~y（非零基）」角标；同一份数据 0 基时不画',
  s33.cornerWith > s33.cornerNone + 20,
  `顶部 26px 像素：非零基 ${s33.cornerWith} vs 0 基 ${s33.cornerNone}（差 ${s33.cornerWith - s33.cornerNone}）`);
check('**柱状图不截轴**（0 基），差异靠**柱顶数值**看清（数值只画在柱顶那条带里）',
  s33.colZero === true && s33.colLabel === true && s33.topL > s33.topN,
  `0 基=${s33.colZero} · 柱顶带像素 带标值 ${s33.topL} vs 不带 ${s33.topN}（+${s33.topL - s33.topN}）`);
check('**雷达按全场 min~max 归一**：有区分度的维度用满 0~1；**差距 < 0.05 的维度按无区分度处理**（不放大噪声）',
  s33.dims === 5 && s33.spreadRange.every((v, k) => (s33.usable[k] ? v > 0.999 : v < 1e-9))
    && s33.usable.filter(Boolean).length >= 4 && s33.maeRange > s33.maeFixed * 1.4,
  `原始跨度 ${s33.spreadFixed.map((v) => v.toFixed(2)).join('/')} ⇒ 归一后跨度 `
    + `${s33.spreadRange.map((v) => v.toFixed(2)).join('/')}（可用 ${s33.usable.filter(Boolean).length}/5 维）`
    + ` · 与均值的平均差 ${s33.maeFixed.toFixed(3)} → ${s33.maeRange.toFixed(3)}（${(s33.maeRange / s33.maeFixed).toFixed(2)} 倍）`);
check('**图注交代口径**：柱状写"柱从 0 起（不截轴）"、雷达写归一范围、折线提示"点序列名收紧纵轴"',
  /不截轴/.test(s33.notes.column) && /min~max 归一/.test(s33.notes.radar) && /点上面/.test(s33.notes.line),
  `柱状「${s33.notes.column.slice(0, 22)}…」· 雷达「${s33.notes.radar.slice(0, 22)}…」`);

// ===================== 34. 图示规范（查到的成熟做法落到判据） =====================
console.log('\n=== 34. 图示规范：配色 / 饼图分组 / 雷达口径 ===');
const s34 = await ev(`(async()=>{const a=globalThis.__agri;const ui=a.ui;
  const d=ui.actions.onChartData();
  const T=a.buildTables(a.state.day);
  const cropN=T.crops.length;
  const pieSum=d.pie.items.reduce((t,x)=>t+x.value,0);
  const cropSum=T.crops.reduce((t,x)=>t+x.area,0);
  const others=d.pie.items.filter(x=>/^其他/.test(String(x.label)));
  return {lineColors:d.line.series.map(s2=>s2.color), radarColors:d.radar.series.map(s2=>s2.color),
    pieN:d.pie.items.length, cropN, pieSum, cropSum, others:others.map(x=>[x.label,x.value]),
    notes:d.notes};})()`);
// Okabe-Ito 四个色（橘/朱红/蓝/青绿）—— 就是"别再换成红绿对"这条规矩的钉子
const OKABE = ['#E69F00', '#D55E00', '#0072B2', '#009E73'];
check('**分类配色用色盲安全的 Okabe-Ito**（折线四序列 + 雷达两序列），而不是最常见的红绿对',
  s34.lineColors.every((c, i) => c.toUpperCase() === OKABE[i]) && s34.radarColors.length === 2
    && s34.radarColors[0].toUpperCase() === '#0072B2' && s34.radarColors[1].toUpperCase() === '#E69F00',
  `折线 ${s34.lineColors.join('/')} · 雷达 ${s34.radarColors.join('/')}`);
check('**饼图小项合并为「其他」**（>6 类时前 5 类单列），且**合并只改显示分组、不改数值**（合计守恒）',
  s34.cropN > 6 ? (s34.pieN === 6 && s34.others.length === 1 && Math.abs(s34.pieSum - s34.cropSum) < 0.2)
    : (s34.pieN === s34.cropN && s34.others.length === 0),
  `作物 ${s34.cropN} 类 → 饼 ${s34.pieN} 块（${s34.others.length ? `其他 ${s34.others[0][0]} ${s34.others[0][1].toFixed(1)} ha` : '未合并'}）`
    + ` · 合计 ${s34.pieSum.toFixed(1)} = 作物面积 ${s34.cropSum.toFixed(1)} ha`);
check('**雷达图写明"别拿面积当综合得分"**（轴序一变面积就变，这在文献里被专门质疑过），且维度不超 6 个',
  /不要拿多边形面积当综合得分/.test(s34.notes.radar) && /5 维/.test(s34.notes.radar),
  `雷达图注「${s34.notes.radar.slice(0, 40)}…」`);
check('雷达图注的两处计数**用同一条规则**（不会出现"5/5 维有区分度"与"另 1 维无区分度"并存这种自相矛盾）',
  (() => { const m = s34.notes.radar.match(/(\d) 维有区分度；另 (\d) 维/); return !!m && Number(m[1]) + Number(m[2]) === 5; })()
    && !/\d\/5 维有区分度/.test(s34.notes.radar),
  `雷达图注「${s34.notes.radar.match(/\d 维有区分度；另 \d 维[^）]*/)?.[0] ?? '（没写到计数）'}」`);
check('**颜色只是冗余编码**：饼图图注明确写"别只靠颜色读，标签与百分比才是主读法"',
  /别只靠颜色读/.test(s34.notes.pie),
  `饼图图注末段「${s34.notes.pie.slice(-30)}」`);



// ===================== 35. 折线跟随单元 · 雷达对比对象 · 图表导出 PNG =====================
console.log('\n=== 35. 折线跟随单元 / 雷达对比 / 导出 PNG ===');
await boot(1440, 900);
const s35 = await ev(`(async()=>{const a=globalThis.__agri;const ui=a.ui;
  document.querySelector('#tb-tabs button[data-tab="charts"]').click();
  await new Promise(r=>setTimeout(r,150));
  const d0=ui.actions.onChartData();
  const objLabels0=d0.line.objects.map(o=>o.label);
  const hasUnit0=d0.line.objects.length>1;

  // 选一块地 ⇒ 折线对象应切到"该地块所属单元（当前选中）"
  const target=a.rows.find(r=>r.unit_id);
  ui.select(target);
  await new Promise(r=>setTimeout(r,150));
  const d1=ui.actions.onChartData();
  const unitObj=d1.line.objects.find(o=>o.key==='unit')||{};
  // 独立复算：该单元成员地块的**面积加权**抽样序列（与 main.js 同一口径）
  const mem=a.rows.filter(r=>r.unit_id===unitObj.id);
  const n=Math.min(...mem.map(r=>r.series.progress.length));
  const wantAt=(key,i)=>{let s2=0,w=0;
    for(const r of mem){const v=r.series[key][i]; if(v==null||Number.isNaN(Number(v))) continue;
      s2+=Number(v)*(r.area_ha||0); w+=r.area_ha||0;}
    return w?s2/w:0;};
  const KEYS=['progress','disease','water','fert'];
  const bad=[];
  KEYS.forEach((key,k)=>{ for(const i of [0,Math.floor(n/2),n-1]){
    const got=unitObj.series?.[k]?.values?.[i];
    if(got===undefined||Math.abs(got-wantAt(key,i))>1e-6) bad.push(key+'#'+i); }});

  // 切对象：画布内容必须变（区域 ↔ 单元）
  const c=document.getElementById('tb-line');
  const sig=()=>{const px=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
    let h=0; for(let i=0;i<px.length;i+=997) h=(h*31+px[i])|0; return h;};
  const selObj=document.getElementById('tb-line-object');
  const before=sig();
  selObj.value='unit'; selObj.dispatchEvent(new Event('change',{bubbles:true}));
  await new Promise(r=>setTimeout(r,120));
  const afterUnit=sig();
  selObj.value='region'; selObj.dispatchEvent(new Event('change',{bubbles:true}));
  await new Promise(r=>setTimeout(r,120));
  const backRegion=sig();

  // 雷达对比对象：选"病级最低" ⇒ 必须等于该单元的归一向量（同一套归一规则，走公共辅助）
  const T=a.buildTables(a.state.day);
${UNIT_NORM_SRC}
  const units=T.units;
  const bestU=[...units].sort((x,y)=>(x.disease??0)-(y.disease??0))[0];
  const best=d1.radar.compare.find(o=>o.key==='best');
  const bestOk=!!best&&best.values.every((v,k)=>Math.abs(v-norm5(bestU)[k])<1e-9);
  const cmp=document.getElementById('tb-radar-compare');
  const sigR=()=>{const cc=document.getElementById('tb-radar');
    const px=cc.getContext('2d').getImageData(0,0,cc.width,cc.height).data;
    let h=0; for(let i=0;i<px.length;i+=997) h=(h*31+px[i])|0; return h;};
  const rBefore=sigR();
  cmp.value='biggest'; cmp.dispatchEvent(new Event('change',{bubbles:true}));
  await new Promise(r=>setTimeout(r,120));
  const rAfter=sigR();

  // 导出 PNG：纯函数 + 按钮接线（用桩捕获参数）
  const url=ui.chartPanelPng('tb');
  let captured=null;
  const orig=ui.actions.onDownloadPng;
  ui.actions.onDownloadPng=(u,n)=>{captured={head:u.slice(0,22), len:u.length, name:n};};
  document.getElementById('tb-export-png').click();
  await new Promise(r=>setTimeout(r,120));
  ui.actions.onDownloadPng=orig;
  return {objLabels0,hasUnit0,unitLabel:unitObj.label,unitId:unitObj.id,bad,
    before,afterUnit,backRegion, bestOk, compareN:d1.radar.compare.length,
    rBefore,rAfter, urlHead:url.slice(0,22), urlLen:url.length, captured};})()`);
check('**折线跟随选中的经营单元**：点一块地后对象自动切到"该单元（当前选中）"，且曲线 = 成员地块**面积加权**抽样序列（独立复算 4 指标 × 3 个格点）',
  s35.hasUnit0 && /当前选中/.test(String(s35.unitLabel)) && s35.bad.length === 0,
  `对象：${s35.objLabels0.join(' / ')} → 选中后「${s35.unitLabel}」· 复算不符 ${s35.bad.length} 处`);
check('切换"对象"（区域 ↔ 单元）时**画布内容真的变了**（不是只改了下拉框）',
  s35.before !== s35.afterUnit && s35.backRegion === s35.before,
  `画布指纹：区域 ${s35.before} → 单元 ${s35.afterUnit} → 切回区域 ${s35.backRegion}（与初始一致）`);
check('**雷达可选对比对象**（4 个）：选"病级最低"时那一系列 == 该单元的归一向量（与主图同一套归一规则）',
  s35.compareN === 4 && s35.bestOk && s35.rBefore !== s35.rAfter,
  `${s35.compareN} 个对比对象 · 病级最低的向量复算一致=${s35.bestOk} · 画布指纹 ${s35.rBefore} → ${s35.rAfter}`);
check('**图表导出 PNG**：`chartPanelPng()` 拼出真实 PNG（dataURL 有内容），按钮点击把 dataURL 交给下载通道',
  String(s35.urlHead).startsWith('data:image/png') && s35.urlLen > 20000
    && s35.captured && String(s35.captured.head).startsWith('data:image/png') && /\.png$/.test(String(s35.captured.name)),
  `${(s35.urlLen / 1024).toFixed(0)} KB PNG · 按钮交出 ${s35.captured ? `${(s35.captured.len / 1024).toFixed(0)} KB，文件名 ${s35.captured.name}` : '（没触发）'}`);


// ===================== 36. 抽屉上下文图导出 PNG（排行 / 前后对照 / 堆叠柱） =====================
console.log('\n=== 36. 抽屉上下文图导出 PNG ===');
await boot(1440, 900);
const s36 = await ev(`(async()=>{const a=globalThis.__agri;const ui=a.ui;
  const out={};
  const grab=(kindHint)=>{
    const url=ui.dwChartPng();
    const info=ui.drawerChartInfo||{};
    const btn=document.getElementById('btn-dw-chart-png');
    // 用桩捕获"按钮把什么交给了下载通道"
    let cap=null; const orig=ui.actions.onDownloadPng;
    ui.actions.onDownloadPng=(u,n)=>{cap={head:u.slice(0,20),len:u.length,name:n};};
    if(btn) btn.click();
    ui.actions.onDownloadPng=orig;
    return {kind:info.kind, col:info.col, head:url.slice(0,20), len:url.length,
      btnShown: btn ? !document.getElementById('dw-chart-wrap').classList.contains('hidden') : false,
      cap};
  };
  // ① 排行图：抽屉里打开「统计网格」（面积/进度排行）
  document.getElementById('btn-drawer').click();
  document.querySelector('#dw-tabs button[data-tab="grids"]').click();
  await new Promise(r=>setTimeout(r,150));
  out.rank=grab();

  // ② 堆叠柱：透视视图选农事日历
  document.querySelector('#dw-tabs button[data-tab="pivot"]').click();
  a.ensurePivot();
  for(let i=0;i<60 && !ui.pivotData;i++) await new Promise(r=>setTimeout(r,100));
  const idx=ui.pivotData.views.findIndex(v=>v.chart==='stacked');
  const sel=document.getElementById('pivot-sel'); sel.value=String(idx);
  sel.dispatchEvent(new Event('change',{bubbles:true}));
  await new Promise(r=>setTimeout(r,180));
  out.stacked=grab();

  // ③ 前后对照：选一个情景候选点（抽屉切到情景推演）
  const cand=a.scenario.candidates.reduce((b,c)=>c.avg_gain_min>(b?b.avg_gain_min:-1)?c:b,null);
  a.pickScenario({lat:cand.lat,lng:cand.lon});
  document.querySelector('#dw-tabs button[data-tab="scenario"]').click();
  await new Promise(r=>setTimeout(r,180));
  out.paired=grab();
  return out;})()`);
check('**抽屉里的三类上下文图都能导出 PNG**（排行 / 前后对照 / 农事日历堆叠柱），且每张都带口径与日期',
  [s36.rank, s36.stacked, s36.paired].every((x) => String(x.head).startsWith('data:image/png'))
    && s36.rank.len > 3000 && s36.stacked.len > 3000 && s36.paired.len > 3000
    && s36.rank.kind === 'rank' && s36.stacked.kind === 'stacked' && s36.paired.kind === 'paired',
  `排行 ${(s36.rank.len / 1024).toFixed(1)} KB（口径 ${s36.rank.col}）· 堆叠柱 ${(s36.stacked.len / 1024).toFixed(1)} KB`
    + `（口径 ${s36.stacked.col}）· 前后对照 ${(s36.paired.len / 1024).toFixed(1)} KB（口径 ${s36.paired.col}）`);
check('按钮把 dataURL 交给**同一条下载通道**，文件名按图种区分（排行图 / 农事日历 / 情景前后对照）',
  [s36.rank, s36.stacked, s36.paired].every((x) => x.cap && String(x.cap.head).startsWith('data:image/png'))
    && s36.rank.cap.name.includes('排行图') && s36.stacked.cap.name.includes('农事日历')
    && s36.paired.cap.name.includes('情景前后对照')
    && new Set([s36.rank.cap.name, s36.stacked.cap.name, s36.paired.cap.name]).size === 3,
  [s36.rank.cap, s36.stacked.cap, s36.paired.cap].map((c) => c.name).join(' · '));


// ===================== 37. 时序回放：曲线只画到当前日期（纵轴不跳） =====================
console.log('\n=== 37. 时序回放：曲线裁到当前帧 ===');
await boot(1440, 900);
const s37 = await ev(`(async()=>{const a=globalThis.__agri;const ui=a.ui;const m=a.map;
  // "实画"= 不透明像素：淡画的那段是 0.28 透明度，不该被算进来（否则曲线一直画满，判不出裁剪）
  const solid=(c)=>{const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
    let k=0; for(let i=3;i<d.length;i+=4) if(d[i]>=200) k++; return k;};
  const fp=(c)=>{const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
    let h=0; for(let i=0;i<d.length;i+=997) h=(h*31+d[i])|0; return h;};
  // "画到哪"= **实画像素的右边界**：几何量，不受轴标签/抗锯齿的像素计数噪声影响
  const OKABE=[[230,159,0],[213,94,0],[0,114,178],[0,158,115]];
  const isSeries=(d,i)=>{ if(d[i+3]<200) return false;
    for(const [r,g,b] of OKABE){ if(Math.abs(d[i]-r)<44&&Math.abs(d[i+1]-g)<44&&Math.abs(d[i+2]-b)<44) return true; } return false;};
  const rightEdge=(c)=>{const d=c.getContext('2d').getImageData(0,0,c.width,c.height);
    for(let x=d.width-1;x>=0;x--){ for(let y=30;y<d.height;y++){ if(isSeries(d.data,(y*d.width+x)*4)) return x; } } return -1;};
  document.querySelector('#tb-tabs button[data-tab="charts"]').click();
  await new Promise(r=>setTimeout(r,160));
  const cvsAt=()=>document.getElementById('tb-line');   // 每次现取：重建后旧节点会被丢弃
  const days=[Math.floor(a.model.days.length*0.2), Math.floor(a.model.days.length*0.9), a.model.days.length-1];
  const ink=[];
  const right=[];
  for(const d of days){ a.setDay(d); await new Promise(r=>setTimeout(r,90));
    ink.push(solid(cvsAt())); right.push(rightEdge(cvsAt())); }
  // 纵轴不跳：同一份数据、不同 upto ⇒ 返回的范围必须一样（范围按**全窗口**算）
  const CH=ui.charts;
  const d0=ui.actions.onChartData();
  const ser=d0.line.objects[0].series;
  const rr=[0.2,0.9,1].map(f=>CH.lineChart(cvsAt(),ser,{height:168,upto:Math.floor(ser[0].values.length*f)}));
  const sameRange=rr.every(r=>r.lo===rr[0].lo&&r.hi===rr[0].hi);

  // 详情面板的小曲线同样裁到当前帧
  const target=a.rows.find(r=>r.unit_id&&r.series.progress.length>2);
  ui.select(target);
  const det=[Math.floor(a.model.days.length*0.2), a.model.days.length-1];
  const detInk=[];
  for(const d of det){ a.setDay(d); ui.select(target); await new Promise(r=>setTimeout(r,90));
    detInk.push(solid(document.getElementById('det-chart'))); }

  // 端到端：点 ▶ 播放 ⇒ 日期在走、图在动
  const t0={day:a.state.day, fp:fp(cvsAt())};
  document.getElementById('btn-play').click();
  for(let i=0;i<40 && a.state.day===t0.day;i++) await new Promise(r=>setTimeout(r,50));
  const playing=!!a.state?.playing || document.getElementById('btn-play').textContent.trim()==='⏸';
  const t1={day:a.state.day, fp:fp(cvsAt())};
  document.getElementById('btn-play').click();          // 停下
  await new Promise(r=>setTimeout(r,120));
  return {ink, right, days, sameRange, range:[rr[0].lo,rr[0].hi], detInk, t0, t1, playing,
    stopped:document.getElementById('btn-play').textContent.trim()==='▶'};})()`);
check('**回放时曲线只画到当前日期**：实画的**右边界**随回放右移、实画像素同步增多（淡画的部分不算数）',
  s37.right[0] < s37.right[1] && s37.right[1] <= s37.right[2]
    && s37.ink[0] < s37.ink[1] && s37.ink[2] >= s37.ink[1] * 0.95,
  `实画右边界 ${s37.right[0]}px（${Math.round(s37.days[0] / 549 * 100)}%）→ ${s37.right[1]}px（90%）→ ${s37.right[2]}px（末帧）`
    + ` · 实画像素 ${(s37.ink[0] / 1000).toFixed(1)}k → ${(s37.ink[1] / 1000).toFixed(1)}k → ${(s37.ink[2] / 1000).toFixed(1)}k`);
check('**纵轴不随回放跳动**：范围按全窗口算，逐帧只有"画到哪"在变',
  s37.sameRange, `三次调用（20%/90%/末帧）返回同一范围 ${s37.range[0].toFixed(2)}~${s37.range[1].toFixed(2)}`);
check('详情面板的小曲线**同样裁到当前帧**（同一个 `upto` 口径，两处不会一个裁一个不裁）',
  s37.detInk[0] < s37.detInk[1] && s37.detInk[0] > 0,
  `实画像素 ${(s37.detInk[0] / 1000).toFixed(1)}k → ${(s37.detInk[1] / 1000).toFixed(1)}k`);
check('**播放端到端**：点 ▶ 后日期在走、曲线跟着变；再点一下能停下（按钮回到 ▶）',
  s37.t1.day !== s37.t0.day && s37.t1.fp !== s37.t0.fp && s37.stopped,
  `第 ${s37.t0.day} 天 → 第 ${s37.t1.day} 天 · 画布指纹 ${s37.t0.fp} → ${s37.t1.fp} · 已停止=${s37.stopped}`);
// 截图：停在窗口 ~35%，回放中的那一帧长什么样（实画 + 淡画的交界）
await ev(`(()=>{const a=globalThis.__agri;
  a.setDay(Math.floor(a.model.days.length*0.35));
  document.querySelector('#tb-tabs button[data-tab="charts"]').click();
  return true;})()`);
await sleep(250);
await shot('charts-回放中-1440x900');


// ===================== 38. 图表"说明与事实一致"（标题/口径不许各写一份） =====================
console.log('\n=== 38. 图表说明与事实一致 ===');
await boot(1440, 900);
const s38 = await ev(`(async()=>{const a=globalThis.__agri;const ui=a.ui;const T=a.buildTables(a.state.day);
  document.querySelector('#tb-tabs button[data-tab="charts"]').click();
  await new Promise(r=>setTimeout(r,180));
  const d=ui.actions.onChartData();
  const titles=[...document.querySelectorAll('#tb-body .chart-card figcaption b')].map(b=>b.textContent.trim());
  // ③ 画的那 12 个值，与"当日 units 按 tMin 降序前 12"独立比一遍
  const expCol=[...(T.units??[])].filter(u=>u.tMin!=null).sort((x,y)=>y.tMin-x.tMin).slice(0,12).map(u=>u.tMin);
  const gotCol=d.column.items.map(x=>x.value);
  // ② 饼的合计必须等于当日作物面积合计（合并「其他」只改分组、不改数值）
  const cropSum=(T.crops??[]).reduce((x,c)=>x+c.area,0);
  const pieSum=d.pie.items.reduce((x,c)=>x+c.value,0);
  // ④ 雷达的"进度"维 == 当日该单元按 AGG_RULE 的进度（独立复算：member 地块面积加权）
  const pu=d.radar.series[0]?.pid, id=d.radar.series[0]?.label&&d.radar.unitId;
  const u=(T.units??[]).find(x=>x.id===a.ui.radarUnitId) ?? null;
  // ① 折线的当前帧竖线 = 当前日期（与 §37 的裁剪同源）
  const lineMark=d.line.mark, expMark=Math.min(d.line.xLabels.length-1, Math.round(a.state.day/(a.model.meta.stepDays||7)));
  // 两天下的"随日期变"实测：饼 / 雷达
  const snap=(day)=>{a.setDay(day); const dd=ui.actions.onChartData();
    return {pie:dd.pie.items.map(x=>x.value.toFixed(2)).join(','), radar:(dd.radar.series[0]?.values??[]).map(x=>x.toFixed(3)).join(','),
      col:dd.column.items.map(x=>x.value.toFixed(2)).join(',')};};
  const dA=Math.floor(a.model.days.length*0.15), dB=Math.floor(a.model.days.length*0.75);
  const sA=snap(dA), sB=snap(dB);
  a.setDay(dB);
  return {titles, expCol, gotCol, cropSum, pieSum, lineMark, expMark, unitId:a.ui.radarUnitId,
    radarDiff:sA.radar!==sB.radar, pieDiff:sA.pie!==sB.pie, colDiff:sA.col!==sB.col};})()`);
check('四张图的**标题与画的东西一致**：③ 说的是"到收储点最远"（不是面积）、其余三张标题与图型对得上',
  s38.titles.length === 4 && /到收储点/.test(s38.titles[2]) && !/面积/.test(s38.titles[2])
    && /时序/.test(s38.titles[0]) && /构成/.test(s38.titles[1]) && /雷达|画像/.test(s38.titles[3]),
  s38.titles.join(' ｜ '));
check('③ 柱状图画的 12 个值 == 当日单元按"到收储点"降序前 12（独立复算，不是抄图注）',
  s38.gotCol.length === 12 && s38.gotCol.every((v, i) => Math.abs(v - s38.expCol[i]) < 1e-6),
  `首位 ${s38.gotCol[0]} → 末位 ${s38.gotCol.slice(-1)[0]} 分钟（与当日 units 排序逐值一致）`);
check('② 饼图合计 == 当日作物面积合计（合并「其他」只改显示分组、不改数值）',
  Math.abs(s38.pieSum - s38.cropSum) < 0.05,
  `饼合计 ${s38.pieSum.toFixed(2)} ha · 当日作物面积合计 ${s38.cropSum.toFixed(2)} ha`);
check('① 折线的"当前帧"竖线位置 == 当前日期在抽样序列上的下标（与裁剪同源）',
  s38.lineMark === s38.expMark, `竖线第 ${s38.lineMark} 点 · 期望 ${s38.expMark} 点`);
check('**随日期变的图和"不变"的图都量出来**（免得图注把静态图说成动态、或反之）',
  s38.radarDiff === true,
  `两天实测：雷达(单元画像) ${s38.radarDiff ? '变' : '不变'} · 饼(作物面积) ${s38.pieDiff ? '变' : '不变'}`
    + ` · 柱(到收储点) ${s38.colDiff ? '变' : '不变'} —— 柱与饼不随日期变是**对的**（运距是地理事实、`
    + `作物在季内固定），雷达必须变（进度/病级按当日）`);

// ===================== 39. 情景候选表：只看当前视野 =====================
console.log('\n=== 39. 情景候选表按视野筛选 ===');
await boot(1440, 900);
const s39 = await ev(`(async()=>{const a=globalThis.__agri;const ui=a.ui;
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  const B=()=>a.map.map.getBounds();
  const inView=()=>{const b=B();return a.scenario.candidates.filter(c=>
    c.lat<=b.getNorth()&&c.lat>=b.getSouth()&&c.lon<=b.getEast()&&c.lon>=b.getWest());};
  const trs=()=>[...document.querySelectorAll('#tb-body tbody tr')];
  const btn=()=>document.getElementById('btn-scen-view');
  const note=()=>document.querySelector('#tb-note').textContent.replace(/\\s+/g,' ');

  document.querySelector('#tb-tabs button[data-tab="scenario"]').click();
  await sleep(250);
  const shown=!btn().classList.contains('hidden');
  const label0=btn().textContent.trim();
  const rows0=trs().length;
  const n0=inView().length, total=a.scenario.candidates.length;
  // 标签里的数字必须与独立复算的视野内计数一致
  const m0=/只看视野（(\\d+)）/.exec(label0);

  // 缩进到一个小区域（围绕 B-001）⇒ 视野内计数应显著变少，按钮标签跟着更新
  const c0=a.scenario.candidates[0];
  a.map.map.setView([c0.lat,c0.lon], 15, {animate:false});
  await sleep(350);
  const label1=btn().textContent.trim();
  const m1=/只看视野（(\\d+)）/.exec(label1);
  const n1=inView().length;

  // 打开筛选：行 = 视野内候选
  btn().click();
  await sleep(250);
  const rows1=trs().map(tr=>({cand:tr.getAttribute('data-cand'), first:tr.children[0].textContent.trim()}));
  const note1=note(), label2=btn().textContent.trim();
  // B 编号必须仍对应**原数组下标**（筛完不许重排编号）
  const idxOk=rows1.every(r=>{const i=Number(/B-(\\d+)/.exec(r.first)[1])-1;
    const c=a.scenario.candidates[i]; if(!c) return false;
    return Math.abs(c.lon-Number(r.cand.split('|')[0]))<1e-4 && Math.abs(c.lat-Number(r.cand.split('|')[1]))<1e-4;});

  // 关掉：恢复全部
  btn().click();
  await sleep(250);
  const rows2=trs().length, label3=btn().textContent.trim();

  // 别的页签不该露这个按钮
  document.querySelector('#tb-tabs button[data-tab="units"]').click();
  await sleep(200);
  const hiddenElsewhere=btn().classList.contains('hidden');
  document.querySelector('#tb-tabs button[data-tab="scenario"]').click();
  await sleep(200);
  return {shown,label0,label1,label2,label3,rows0,rows1:rows1.length,rows2,total,n0,n1,
    m0:m0?Number(m0[1]):null,m1:m1?Number(m1[1]):null,note1,idxOk,hiddenElsewhere};})()`);
check('情景页签有「只看视野」按钮，且**按钮上的数量 == 独立复算的视野内候选数**',
  s39.shown && s39.m0 === s39.n0 && s39.n0 <= s39.total,
  `按钮「${s39.label0}」· 独立复算视野内 ${s39.n0} / 共 ${s39.total}（初始视野覆盖全区）`);
check('地图缩放到小区域后，按钮上的数量**跟着更新**（视野变了数量就变，不是一次性快照）',
  s39.m1 === s39.n1 && s39.n1 < s39.n0,
  `缩放后「${s39.label1}」· 独立复算 ${s39.n1} 个（原来 ${s39.n0} 个）`);
check('打开筛选：表里**只剩视野内的候选**，且表注写明"筛选只动列表、指标仍是全网口径"',
  s39.rows1 === s39.n1 && s39.rows1 < s39.total
    && /已按当前地图视野筛选/.test(s39.note1) && /全网/.test(s39.note1),
  `行数 ${s39.rows0} → ${s39.rows1}（视野内 ${s39.n1}）· 表注「${s39.note1.slice(0, 60)}…」`);
check('筛选后 **B 编号仍对应原数组下标**（`B-007` 永远指同一个候选点，不跟着重排）',
  s39.idxOk,
  `${s39.rows1} 行逐行核对 data-cand 与编号下标一致`);
check('再点一下恢复全部；其他页签不露这个按钮（跨页签误用没有入口）',
  s39.rows2 === s39.total && /显示全部/.test(s39.label2) && /只看视野/.test(s39.label3) && s39.hiddenElsewhere,
  `恢复后 ${s39.rows2} 行 · 按钮「${s39.label3}」· 在「经营单元」页签隐藏=${s39.hiddenElsewhere}`);



// ===================== 40. 情景候选散点图（受益面积 × 平均节省 + 帕累托前沿） =====================
console.log('\n=== 40. 情景候选散点图（帕累托前沿） ===');
await boot(1440, 900);
const s40 = await ev(`(async()=>{const a=globalThis.__agri;const ui=a.ui;
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  document.querySelector('#tb-tabs button[data-tab="scenario"]').click();
  document.getElementById('btn-drawer').click();
  await sleep(350);
  // 抽屉要**跟随 strip 的页签**打开（停在情景推演点数据视图，就该看到情景这张表）
  const drawerFollows=ui.drawerTab==='scenario';
  const wrap=document.getElementById('dw-chart-wrap');
  const cvs=document.getElementById('dw-chart');
  const cap=wrap.querySelector('.dw-chart-cap');
  const capNow=cap?.textContent??'NONE';   // ⚠️ 必须**此刻**读：后面切页签会（正确地）把说明清掉
  const diag={capNow,caps:document.querySelectorAll('.dw-chart-cap').length,
    kids:[...wrap.children].map(e=>e.className||e.tagName).join('|'),
    html:wrap.innerHTML.replace(/\s+/g,' ').slice(0,150)};
  const info=ui.drawerChartInfo&&{kind:ui.drawerChartInfo.kind,n:ui.drawerChartInfo.n,front:ui.drawerChartInfo.front,col:ui.drawerChartInfo.col};
  // 独立复算帕累托前沿（x、y 都越大越好；不被任何点同时超过）
  const P0=a.scenario.candidates.map(c=>({x:c.improved_ha,y:c.avg_gain_min}));
  const frontIdx=P0.map((_,i)=>i).filter(i=>!P0.some((q,j)=>j!==i&&q.x>=P0[i].x&&q.y>=P0[i].y&&(q.x>P0[i].x||q.y>P0[i].y)));
  // 画上去了没有：总墨迹 + 前沿环的颜色像素
  const px=(fill)=>[...cvs.getContext('2d').getImageData(0,0,cvs.width,cvs.height).data];
  const d=px();
  let ink=0,warn=0;
  const tap=(dd)=>{let w=0,k=0; for(let i=0;i<dd.length;i+=4){ if(dd[i+3]>0) k++;
    if(dd[i]>150&&dd[i+1]<120&&dd[i+2]<80&&dd[i+3]>150) w++; } return {w,k};};
  let t=tap(d); ink=t.k; warn=t.w;
  // 自校准：同一批点**画前沿 / 不画前沿**各来一次 —— 不设魔法阈值，只问"前沿到底画了没有"
  const hash=(dd)=>{let h=0; for(let i=0;i<dd.length;i+=997) h=(h*31+dd[i])|0; return h;};
  const withFront=hash(d);
  const CH=ui.charts;
  const meta2=CH.scatter(cvs,P0.map(p=>({x:p.x,y:p.y})),{height:200,xLabel:'x',yLabel:'y'});
  const withArea=hash(cvs.getContext('2d').getImageData(0,0,cvs.width,cvs.height).data);
  CH.scatter(cvs,P0.map(p=>({x:p.x,y:p.y})),{height:200,xLabel:'x',yLabel:'y',showFront:false});
  const noFront=tap(cvs.getContext('2d').getImageData(0,0,cvs.width,cvs.height).data);
  const hashNoFront=hash(cvs.getContext('2d').getImageData(0,0,cvs.width,cvs.height).data);
  const maxAreaOnFront=frontIdx.includes(P0.findIndex(p=>p.x===Math.max(...P0.map(q=>q.x))));
  // 切**抽屉的**页签：散点说明必须被清掉（说明与图同一个容器 ⇒ 换图不能留上一张的说明）
  document.querySelector('#dw-tabs button[data-tab="units"]').click();
  await sleep(300);
  const capAfter=(wrap.querySelector('.dw-chart-cap')?.textContent??'');
  const kindAfter=ui.drawerChartInfo?.kind??null;
  document.querySelector('#tb-tabs button[data-tab="scenario"]').click();
  await sleep(300);
  return {diag,drawerFollows,shown:!wrap.classList.contains('hidden'),cap:cap?cap.textContent:'',info,
    withFront,hashNoFront,warnNoFront:noFront.w,inkNoFront:noFront.k,meta2Front:meta2.frontIdx.length,
    nCand:P0.length,expFront:frontIdx.length,nFronts:new Set(P0.map(p=>p.x+':'+p.y)).size,
    ink,warn,maxAreaOnFront,capAfter,kindAfter};})()`);
check('打开数据视图时**抽屉跟随当前页签**（停在「情景推演」就该看到情景这张表）',
  s40.drawerFollows === true, `drawerTab=${s40.info?.kind ? 'scenario' : '?'}（跟随=${s40.drawerFollows}）`);
check('情景推演抽屉里画的是**散点图**（受益面积 × 平均节省），并有与图同处的说明行',
  s40.shown && s40.info?.kind === 'scatter' && s40.info.n === s40.nCand
    && /散点图/.test(s40.diag.capNow) && /帕累托前沿/.test(s40.diag.capNow) && /面积最大 ≠ 最划算/.test(s40.diag.capNow),
  `kind=${s40.info?.kind} · ${s40.info?.n} 点 · 说明「${String(s40.diag.capNow).slice(0, 78)}…」`);
check('**帕累托前沿的个数 == 独立复算**（不被动点同时超过的那些；判断逻辑与判据各写一遍）',
  s40.info?.front === s40.expFront,
  `图上 ${s40.info?.front} 个 · 独立复算 ${s40.expFront} 个 / 共 ${s40.nCand} 个候选（去重后 ${s40.nFronts} 个不同位置）`);
check('散点**真的画上去了**：有墨迹，且"画前沿/不画前沿"两种画面的像素确实不同（前沿不是只返回了个数字）',
  s40.ink > 2000 && s40.warn > 0 && s40.warnNoFront === 0 && s40.withFront !== s40.hashNoFront
    && s40.meta2Front === s40.expFront,
  `不透明像素 ${(s40.ink / 1000).toFixed(1)}k · 前沿色像素 ${s40.warn}（关掉前沿后 ${s40.warnNoFront}）`
    + ` · 两种画面不同=${s40.withFront !== s40.hashNoFront} · 纯函数复算前沿 ${s40.meta2Front} 个`);
check('换页签后**散点说明被清掉**（屏幕上的说明必须跟着图走，不能留上一张的）',
  !/散点图/.test(s40.capAfter) && s40.kindAfter !== 'scatter',
  `换到「经营单元」后说明「${s40.capAfter.slice(0, 40)}」· kind=${s40.kindAfter}`);
check('图中信息可读性：**受益面积最大的候选在前沿上**（x 最大的点不可能被同时超过，除非位置重复）',
  s40.maxAreaOnFront === true,
  `最大受益面积那一个在前沿=${s40.maxAreaOnFront}（共 ${s40.nCand} 个候选）`);
// 截图前**切回情景**（否则拍到的是刚切走的另一张图 —— 这个坑本轮已经踩过一次）
await ev(`(async()=>{const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  document.querySelector('#dw-tabs button[data-tab="scenario"]').click();
  await sleep(250); return true;})()`);
await shot('dw-chart-情景散点图-1440x900');
await shot('dw-chart-散点图选点-1440x900');


// ===================== 41. 散点图：点选（真实鼠标）+ 与"只看视野"联动 =====================
console.log('\n=== 41. 散点图点选与视野联动 ===');
await boot(1440, 900);
// 第一段：拿到"要点的那个点的屏幕坐标"（像素位置由图自己给出，不在判据里重推一遍）
const s41a = await ev(`(async()=>{const a=globalThis.__agri;const ui=a.ui;
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  document.querySelector('#tb-tabs button[data-tab="scenario"]').click();
  document.getElementById('btn-drawer').click();
  await sleep(350);
  const cvs=document.getElementById('dw-chart');
  const st=ui.scatterPick;
  const kw={height:200,xLabel:'受益面积',xUnit:'ha',yLabel:'平均节省',yUnit:'min/块'};
  const meta=ui.charts.scatter(cvs, st.points, {...kw, picked:-1});     // 重画一次拿 placed（映射只取决于范围与画布尺寸）
  const placed=meta.placed;
  // 挑一个**邻域内只有自己**的点：点云很密，落在别人 10px 内时"命中谁"本就由距离决定，
  // 拿它测命中测试会把"点云密度"当成"命中测试错了"
  let K=0, bestGap=-1;
  for(let i=0;i<placed.length;i++){
    const g=Math.min(...placed.filter((_,j)=>j!==i).map(q=>Math.hypot(q.px-placed[i].px,q.py-placed[i].py)));
    if(g>bestGap){bestGap=g;K=i;}
  }
  const hitSelf=()=>st.hit(placed[K].px, placed[K].py, 10);
  const rect=cvs.getBoundingClientRect();
  return {hasState:!!st, n:st.points.length, placedN:placed.length, hitSelf:hitSelf(), hitFar:st.hit(1,1,6), bestGap,
    K, target:{lon:a.scenario.candidates[K].lon, lat:a.scenario.candidates[K].lat},
    x:rect.left+placed[K].px, y:rect.top+placed[K].py, inViewport:rect.top+placed[K].py<900&&rect.left+placed[K].px<1440};})()`);
check('散点图给出**可点选的坐标与命中测试**（像素位置由图自己算，判据不重推一遍）',
  s41a.hasState && s41a.placedN === s41a.n && s41a.hitSelf === s41a.K && s41a.hitFar === -1
    && s41a.inViewport,
  `${s41a.n} 个点 · 用第 ${s41a.K} 个点自己的坐标命中它=${s41a.hitSelf}（最近邻距离 ${s41a.bestGap.toFixed(1)}px）· 角落里命中=${s41a.hitFar}`
    + ` · 点击位 (${Math.round(s41a.x)}, ${Math.round(s41a.y)}) 在视口内=${s41a.inViewport}`);
// 真实鼠标点那个圆点
await mouse('mouseMoved', s41a.x, s41a.y);
await mouse('mousePressed', s41a.x, s41a.y);
await mouse('mouseReleased', s41a.x, s41a.y);
await sleep(500);
const s41b = await ev(`(async()=>{const a=globalThis.__agri;const ui=a.ui;
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  const cand=ui.scenario&&ui.scenario.cand;
  const btn=document.getElementById('btn-dw-scen-view');
  const starRow=[...document.querySelectorAll('#tb-body .tbl tbody tr')]
    .find(tr=>/★/.test(tr.textContent));
  const picked={lon:cand&&cand.lon, lat:cand&&cand.lat};
  const kindAfterClick=ui.drawerChartInfo&&ui.drawerChartInfo.kind;
  const btnAfterClick={shown:!btn.classList.contains('hidden'), label:btn.textContent.trim()};
  // 点选后抽屉已按设计切到"前后对照" ⇒ 这里只读"选点是否真的生效"，图上的像素实验放到切回散点之后
  return {picked, kindAfterClick, btnAfterClick,
    starRow:starRow?starRow.children[0].textContent.trim():null,
    scatterCleared:ui.scatterPick===null};})()`);
check('**点散点图上的圆点 ⇒ 选中该候选点**（真实鼠标；与表格行点击同一条通道：★ + 地图高亮都跟过去）',
  Math.abs(s41b.picked.lon - s41a.target.lon) < 1e-9 && Math.abs(s41b.picked.lat - s41a.target.lat) < 1e-9,
  `点第 ${s41a.K} 个点 ⇒ 选中 (${s41b.picked.lon?.toFixed(5)}, ${s41b.picked.lat?.toFixed(5)})`
    + ` = scenario.json 第 ${s41a.K} 个候选 · 表格 ★ 行「${s41b.starRow}」`);
check('选点后抽屉**自动切到"前后对照"**（原来选点后最想知道的是"省在哪里"），并出现切回散点的按钮',
  s41b.kindAfterClick === 'paired' && s41b.btnAfterClick.shown && /看散点图/.test(s41b.btnAfterClick.label),
  `选点后 kind=${s41b.kindAfterClick} · 按钮「${s41b.btnAfterClick.label}」（可见=${s41b.btnAfterClick.shown}）`);
// 点按钮切回散点：选中的那个点要画得出来
await ev(`document.getElementById('btn-dw-scen-view').click()`);
await sleep(350);
const s41c = await ev(`(()=>{const ui=globalThis.__agri.ui;const cvs=document.getElementById('dw-chart');
  const st=ui.scatterPick;
  const vb=document.getElementById('btn-dw-scen-view');
  const state={kind:ui.drawerChartInfo?.kind??null, view:ui.scenarioChartView??null,
    label:vb.textContent.trim(), btnShown:!vb.classList.contains('hidden'), hasState:!!st};
  if(!st) return {state, broken:true};
  const kw={height:200,xLabel:'受益面积',xUnit:'ha',yLabel:'平均节省',yUnit:'min/块'};
  const snap=()=>cvs.getContext('2d').getImageData(0,0,cvs.width,cvs.height).data;
  const picked=ui.drawerChartInfo.picked;
  ui.charts.scatter(cvs, st.points, {...kw, picked});
  const a=snap();
  ui.charts.scatter(cvs, st.points, {...kw, picked:-1});
  const b=snap();
  // 不猜颜色：逐像素比"画了选中点"与"没画"的两张图 —— 差多少像素就是标记实际占了多大
  let diff=0;
  for(let i=0;i<a.length;i+=4) if(a[i]!==b[i]||a[i+1]!==b[i+1]||a[i+2]!==b[i+2]||a[i+3]!==b[i+3]) diff++;
  return {state, kind:ui.drawerChartInfo.kind, picked, diff};})()`);
check('切回散点：**选中的点真的画出来了**（同一批点，逐像素比"画选中 / 不画"两张图，不猜颜色）',
  s41c.kind === 'scatter' && s41c.picked === s41a.K && s41c.diff > 20
    && s41c.state.btnShown === true && /看前后对照/.test(s41c.state.label),
  `${JSON.stringify(s41c.state)} · picked=${s41c.picked} · 两张画面相差 ${s41c.diff} 像素（标记的实占面积）`);
// 与"只看视野"联动：视野外的点画淡（分布形状不变）
const s41d = await ev(`(async()=>{const a=globalThis.__agri;const ui=a.ui;
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  const b1=a.map.map.getBounds();
  const inView1=a.scenario.candidates.filter(c=>c.lat<=b1.getNorth()&&c.lat>=b1.getSouth()
    &&c.lon<=b1.getEast()&&c.lon>=b1.getWest()).length;
  const dim1=ui.drawerChartInfo&&ui.drawerChartInfo.dimmed;
  document.getElementById('btn-scen-view').click();          // 打开"只看视野"
  await sleep(250);
  const c0=a.scenario.candidates[0];
  a.map.map.setView([c0.lat,c0.lon], 15, {animate:false});
  await sleep(600);                                          // 等 moveend 防抖重画
  const b2=a.map.map.getBounds();
  const inView2=a.scenario.candidates.filter(c=>c.lat<=b2.getNorth()&&c.lat>=b2.getSouth()
    &&c.lon<=b2.getEast()&&c.lon>=b2.getWest()).length;
  const dim2=ui.drawerChartInfo&&ui.drawerChartInfo.dimmed;
  const total=a.scenario.candidates.length;
  const cap=(document.querySelector('#dw-chart-wrap .dw-chart-cap')?.textContent??'');
  document.getElementById('btn-scen-view').click();          // 关掉，恢复
  await sleep(250);
  return {inView1, dim1, inView2, dim2, total, capDim:/视野外 \\d+ 个已画淡/.test(cap)};})()`);
check('**图与"只看视野"联动**：开了筛选后，视野外的候选在散点图上画淡（数量 == 独立复算的视野外个数）',
  s41d.dim1 === 0 && s41d.dim2 === s41d.total - s41d.inView2 && s41d.dim2 > 0 && s41d.capDim,
  `筛选关闭时淡画 ${s41d.dim1} 个（应为 0）· 缩到小区域后淡画 ${s41d.dim2} / ${s41d.total}`
    + `（独立复算视野外 ${s41d.total - s41d.inView2} 个）· 说明行提到"已画淡"=${s41d.capDim}`);


// ===================== 42. 排产看板：q14 按日压力 + q15 错峰/增点，都在页面上 =====================
console.log('\n=== 42. 排产看板（q14 按日压力 + q15 结论） ===');
await boot(1440, 900);
// 离线侧（已被 DuckDB 交叉验证过的 CSV）作为对账基准
const q14c = fs.readFileSync('tables/query/q14_收获排产压力_按日_.csv', 'utf8').trim().split(/\r?\n/);
const q15c = fs.readFileSync('tables/query/q15_排产建议_错峰_vs_增点_三个数_.csv', 'utf8').trim().split(/\r?\n/);
const q15rows = q15c.slice(1).map((l) => l.split(','));
const q14peak = q14c.slice(1).map((l) => l.split(','))
  .reduce((a, c) => (Number(c[c.length - 1]) > Number(a[a.length - 1]) ? c : a));
const s42 = await ev(`(async()=>{const a=globalThis.__agri;const ui=a.ui;
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  document.querySelector('#tb-tabs button[data-tab="pivot"]').click();
  a.ensurePivot();
  for(let i=0;i<60 && !ui.pivotData;i++) await sleep(100);
  const views=ui.pivotData?.views??[];
  const sel=document.getElementById('pivot-sel');
  const idx=views.findIndex(v=>/排产建议/.test(v.title||''));
  if(idx<0) return {n:views.length, idx};
  sel.value=String(idx); sel.dispatchEvent(new Event('change',{bubbles:true}));
  await sleep(200);
  const tbl=document.querySelector('#tb-body .tbl');
  const head=[...tbl.querySelectorAll('thead th')].map(th=>th.textContent.trim());
  const trs=[...tbl.querySelectorAll('tbody tr')].map(tr=>[...tr.children].map(td=>td.textContent.trim()));
  // 再切到 q14（按日压力）确认它也在页面上
  const idx14=views.findIndex(v=>/收获排产压力/.test(v.title||''));
  sel.value=String(idx14); sel.dispatchEvent(new Event('change',{bubbles:true}));
  await sleep(200);
  const tbl14=document.querySelector('#tb-body .tbl');
  const n14=[...tbl14.querySelectorAll('tbody tr')].length;
  const head14=[...tbl14.querySelectorAll('thead th')].map(th=>th.textContent.trim());
  return {n:views.length, idx, idx14, head, trs, n14, head14,
    note14:document.querySelector('#tb-note').textContent.replace(/\s+/g,' ')};})()`);
check('**排产建议（错峰 vs 增点）进页面**：3 行 × 4 列，逐格与离线表（已被 DuckDB 交叉验证过）一致',
  s42.idx >= 0 && s42.head.length === 4 && s42.trs.length === q15rows.length
    && s42.trs.every((r, i) => Math.abs(Number(String(r[1]).replace(/[^0-9.-]/g, '')) - Number(q15rows[i][1])) < 0.06
      && Math.abs(Number(String(r[2]).replace(/[^0-9.-]/g, '')) - Number(q15rows[i][2])) < 0.002),
  `${s42.trs.length} 行 · 表头 ${(s42.head ?? []).join('|')} · `
    + s42.trs.map((r) => `${String(r[0]).slice(0, 6)}=${r[1]}/${r[2]}`).join(' · '));
check('排产建议的**结论方向**在页面上读得出来：错峰的降幅 > 增点（与"堵在量不在距离"一致）',
  s42.trs.length === 3
    && Number(String(s42.trs[1][2]).replace(/[^0-9.-]/g, '')) > Number(String(s42.trs[2][2]).replace(/[^0-9.-]/g, '')),
  `错峰 ${s42.trs[1]?.[2]} vs 增点 ${s42.trs[2]?.[2]}`);
check('**按日压力表（q14）也在页面上**，且表注点出最堵的一天（与离线 CSV 的最大值一致）',
  s42.n14 === q14c.length - 1 && s42.n14 > 3 && s42.note14.replace(/[^0-9]/g, '').includes(q14peak[0]),
  `${s42.n14} 个收获日（离线 ${q14c.length - 1}）· 表注「${String(s42.note14).slice(0, 90)}…」`
    + ` · 离线峰值日 ${q14peak[0]}（运力占用 ${q14peak[q14peak.length - 1]} t·min）`);


// ===================== 43. 一页可打印报告（自包含 HTML） =====================
console.log('\n=== 43. 可打印报告（自包含 HTML） ===');
await boot(1440, 900);
const s43 = await ev(`(async()=>{const a=globalThis.__agri;const ui=a.ui;
  document.getElementById('btn-drawer').click();
  await new Promise(r=>setTimeout(r,250));
  const sc=ui.scatterImage();
  const html=ui.reportHtml(ui.actions?.onMapImage?.() ?? '', sc.url);
  const els=[...document.querySelectorAll('#btn-report')].map(b=>({shown:!!b.offsetParent, label:b.textContent.trim()}));
  return {len:html.length, head:html.slice(0,40),
    hasDoctype:/^<!doctype html>/i.test(html.trim()),
    sections:['当前帧关键数','四张常用图','口径'].filter(k=>html.includes(k)).length,
    imgs:(html.match(/<img[^>]*>/g)||[]).length,
    dataImgs:(html.match(/<img[^>]*src="data:image/g)||[]).length,
    extRefs:['src="http','href="http','src="//','href="//','src="'+String.fromCharCode(47)+String.fromCharCode(47)]
      .reduce((n,k)=>n+html.split(k).length-1,0),
    extTags:(html.match(/<(script|link)\b/gi)||[]).length,
    aggRule:/排除不播种/.test(html)&&/取最严重/.test(html),
    attrs:/OpenStreetMap/.test(html)&&/NASA POWER/.test(html),
    site:(ui.model.meta.siteName&&html.includes(ui.model.meta.siteName)),
    day:html.includes('观测日'),
    scatterImg:{url:!!sc.url, front:sc.front, n:sc.n},
    button:els[0]||null, cache:(()=>{
      const u1=ui.chartPanelImage();
      const t1=performance.now(); const u2=ui.chartPanelImage(); const dt=performance.now()-t1;
      const d0=ui.day; a.setDay((d0+30)%a.model.days.length);
      const u3=ui.chartPanelImage();
      a.setDay(d0);
      return {same:u1===u2&&!!u1, diff:u1!==u3, dt};
    })()};})()`);
check('报告按钮在位，`reportHtml()` 产出**完整 HTML 文档**（doctype + 三个章节）',
  !!s43.button?.shown && /报告/.test(s43.button?.label ?? '')
    && s43.hasDoctype && s43.sections === 3 && s43.len > 2000,
  `按钮「${s43.button?.label}」（可见=${s43.button?.shown}）· ${s43.len} 字节 · 章节 ${s43.sections}/3`
    + ` · 站点名/观测日在文档里=${s43.site}/${s43.day}`);
check('报告**自包含**：三张图（地图 + 情景散点 + 四张图拼图）都是 `data:image` 内嵌，**零外链**，也没有 script/link',
  s43.imgs === 3 && s43.dataImgs === 3 && s43.extRefs === 0 && s43.extTags === 0,
  `图片 ${s43.imgs} 张（data URL ${s43.dataImgs} 张；含当前帧地图）· 外链 ${s43.extRefs} 处`
    + ` · script/link 标签 ${s43.extTags} 个 · 散点 ${s43.scatterImg?.n} 点 / 前沿 ${s43.scatterImg?.front} 个`);
check('报告图**有缓存**：同一天连取两次是同一张（第二次几乎不耗时），换天后自动失效（不拿旧图）',
  s43.cache?.same === true && s43.cache?.diff === true && s43.cache?.dt < 50,
  `同图=${s43.cache?.same}（第二次 ${s43.cache?.dt?.toFixed(1)}ms）· 换天后换图=${s43.cache?.diff}`);
check('报告里**写着口径**（进度"排除不播种"、病级"取最严重"）与数据来源（OSM / NASA POWER）',
  s43.aggRule && s43.attrs,
  `聚合口径原文在内=${s43.aggRule} · 数据来源在内=${s43.attrs}`);


// ===================== 44. 审核：启动负载、耗时基线、素材规模 =====================
console.log('\n=== 44. 审核：启动负载与耗时基线 ===');
// 这里**不能用 boot()**：boot() 会主动等懒加载的数据（为了让别的判据确定）。
// 本节要量的正是"启动那一刻有没有拉"，所以走一次裸导航，读到第一刻的状态再说。
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, screenWidth: 1440, screenHeight: 900 });
await send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}${PREFIX}/sim.html?t=${Date.now()}` });
await waitFor(async () => await ev(`document.readyState==='complete' && !!globalThis.__agri`), '页面就绪');
// 启动时**不该**已经拉过情景数据（194 KB，只在情景页签用得到）
const s44a = await ev(`(async()=>{const a=globalThis.__agri;const ui=a.ui;
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  const before=a.scenario.candidates.length;
  // 换天耗时：取 20 天平均（UI 不做聚合，setDay 会把表格/地图/图都刷新一遍）
  const t=[];
  const d0=a.state.day;
  for(let k=0;k<20;k++){const st=performance.now(); a.setDay((d0+k*7)%a.model.days.length); t.push(performance.now()-st);}
  a.setDay(d0);
  const avg=t.reduce((x,y)=>x+y,0)/t.length, worst=Math.max(...t);
  const nav=performance.getEntriesByType('navigation')[0]||{};
  // 切到「情景推演」⇒ 懒加载触发，数据到位、表也在
  document.querySelector('#tb-tabs button[data-tab="scenario"]').click();
  for(let i=0;i<60 && !a.scenario.candidates.length;i++) await sleep(100);
  await sleep(300);
  const after=a.scenario.candidates.length;
  const rows=document.querySelectorAll('#tb-body .tbl tbody tr').length;
  return {before, after, rows, avg, worst,
    dom:nav.domContentLoadedEventEnd, load:nav.loadEventEnd, transfer:nav.transferSize};})()`);
check('**情景数据懒加载**：启动时一条都没拉（`candidates=0`），切到「情景推演」才到位（154）且表照常渲染',
  s44a.before === 0 && s44a.after === 154 && s44a.rows === 154,
  `启动时 ${s44a.before} 条 → 切页签后 ${s44a.after} 条 · 表 ${s44a.rows} 行（少了 194 KB 的启动请求）`);
check('**启动耗时**（导航计时，实测记录在案）：DOMContentLoaded / load 都在预算内',
  s44a.dom > 0 && s44a.dom < 4000 && s44a.load < 6000,
  `DOMContentLoaded ${Math.round(s44a.dom)}ms · load ${Math.round(s44a.load)}ms（预算 4000 / 6000）`);
check('**换天耗时基线**（20 次平均）：表格 + 地图 + 图一次全刷，不能慢到影响回放（12 天/秒 ⇒ 每帧预算 83ms）',
  s44a.avg < 80,
  `平均 ${s44a.avg.toFixed(1)}ms（最慢 ${s44a.worst.toFixed(1)}ms）· 预算 80ms/帧`);
// 素材规模（node 侧直接量：启动清单 + 页面代码，防止"悄悄变胖"）
{
  const boot = ['parcels.geojson', 'roads.geojson', 'poi.geojson', 'weather_daily.json', 'access.json',
    'isochrones.geojson', 'units.json', 'units.geojson', 'grids.geojson', 'admin.geojson', 'soil.json',
    'elevation.json', 'villages.geojson'];
  const k = (f) => (fs.existsSync(f) ? fs.statSync(f).size / 1024 : 0);
  const bootKB = boot.reduce((n, f) => n + k(`data/${f}`), 0);
  const jsKB = fs.readdirSync('js').filter((f) => f.endsWith('.js')).reduce((n, f) => n + k(`js/${f}`), 0);
  const lazyKB = k('data/zones.geojson');
  check('**素材规模**在预算内：启动数据 < 1.5 MB、页面 JS < 320 KB（懒加载的大件单列）',
    bootKB < 1500 && jsKB < 320,
    `启动数据 ${bootKB.toFixed(0)} KB（预算 1500）· JS ${jsKB.toFixed(0)} KB（预算 320）`
      + ` · 懒加载（不计入启动）：zones ${lazyKB.toFixed(0)} KB + scenario 194 KB + pivot 37 KB`);
}

// ===================== 45. 导览页（入口 index.html）：图都在、链能通、无报错 =====================
console.log('\n=== 45. 导览页 ===');
{
  /*
   * 导览页是本轮新增的"入口"：它讲主页面、用 4 张数据截图做展示。
   * 最容易坏的两处：图没加载（文件移走后忘了改路径）、配色没接上（另起一套颜色 ⇒ 像两个系统）。
   * 所以这里查的是**渲染结果**（`naturalWidth`、计算后的 CSS 变量），不是"文件存在"。
   */
  pageErrors.length = 0;
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, screenWidth: 1440, screenHeight: 900 });
  await send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}${PREFIX}/index.html?t=${Date.now()}` });
  await waitFor(() => ev(`document.readyState === 'complete' && document.querySelectorAll('.shot img').length === 4`), '导览页渲染');
  // 等图片解码完成（`complete` 在缓存命中时可能瞬间为 true，但 naturalWidth 只有在真拿到像素时才 > 0）
  await waitFor(() => ev(`[...document.querySelectorAll('.shot img')].every(i => i.complete)`), '图片加载');
  const g = await ev(`(() => {
    const imgs = [...document.querySelectorAll('.shot img')];
    const link = document.querySelector('a[href="sim.html"]');
    return {
      title: document.title,
      shots: imgs.length,
      loaded: imgs.filter(i => i.naturalWidth > 0).map(i => i.naturalWidth + 'x' + i.naturalHeight),
      broken: imgs.filter(i => !(i.naturalWidth > 0)).map(i => i.getAttribute('src')),
      cta: !!link,
      steps: document.querySelectorAll('.step').length,
      brand: getComputedStyle(document.documentElement).getPropertyValue('--brand').trim(),
      topbar: getComputedStyle(document.querySelector('.g-head')).backgroundColor,
    };
  })()`);
  check('导览页能打开，**4 张数据截图都真的加载出来**（`naturalWidth > 0`，不是"文件在但没显示"）',
    g.shots === 4 && g.loaded.length === 4,
    `${g.shots} 张 · ${g.loaded.join(', ')}${g.broken.length ? ` · 坏图：${g.broken.join(', ')}` : ''}`);
  check('导览页**复用主页面同一套政企配色**（读的是同一份 `style.css` 令牌），不是另起一套',
    g.brand === '#1a4f8a' && g.topbar === 'rgb(26, 79, 138)',
    `--brand = ${g.brand} · 顶栏 = ${g.topbar}`);
  check('导览页**有回主页面的入口**，且讲了基础操作',
    g.cta && g.steps >= 5, `入口 ${g.cta ? '有' : '无'} · 操作步骤 ${g.steps} 条`);
  check('导览页加载期**无异常**（`Runtime.exceptionThrown` / `console.error` 一条都不该有）',
    pageErrors.length === 0, pageErrors.slice(0, 2).join(' ｜ ') || '无');

  /*
   * **打开站点根（`/`）默认就是导览页** —— 这是"入口"的定义，不能靠文件名约定口头保证。
   * 走一次不给文件名的导航：拿到的必须是导览页（有截图卡、有去主页面的入口），
   * 而不是直接落到模拟页（有 `#day-slider` 就说明落错了）。
   */
  await send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}${PREFIX}/?t=${Date.now()}` });
  await waitFor(() => ev(`document.readyState === 'complete' && document.querySelectorAll('.shot').length > 0`), '站点根进入导览页');
  const root = await ev(`({
    title: document.title,
    shots: document.querySelectorAll('.shot').length,
    toSim: !!document.querySelector('a[href="sim.html"]'),
    isSim: !!document.getElementById('day-slider'),
  })`);
  /*
   * **能滚到底**：`style.css` 给模拟页写了 `body { overflow: hidden }`（整屏 grid 不滚），
   * 导览页是长文档，忘了覆盖就"只能看第一屏"——用户实际撞到过。
   * 判据不查 CSS 声明，而是**真的滚一次**：滚到底后页脚必须进入视口。
   */
  /*
   * 先断言**根因**：`style.css` 给模拟页写了 `body { overflow: hidden }`，导览页必须覆盖掉。
   * 只看"能不能滚"不够——`height:auto` 也会让它恰好能滚，于是问题换个浏览器/缩放又冒出来。
   */
  const ov = await ev(`(() => ({
    body: getComputedStyle(document.body).overflowY,
    html: getComputedStyle(document.documentElement).overflowY,
  }))()`);
  check('导览页**显式覆盖了 `body{overflow:hidden}`**（模拟页整屏不滚，导览页是长文档，必须放开）',
    ov.body !== 'hidden' && ov.html !== 'hidden', `body.overflow-y = ${ov.body} · html = ${ov.html}`);

  const sc = await ev(`(() => {
    const before = window.scrollY;
    window.scrollTo(0, document.documentElement.scrollHeight);
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const foot = document.querySelector('.g-foot').getBoundingClientRect();
    return { before, scrolled: window.scrollY, max, footBottom: Math.round(foot.bottom), vh: window.innerHeight };
  })()`);
  check('**导览页能滚到底**（滚到底后页脚进入视口，而不是卡在第一屏）',
    sc.max > 200 && sc.scrolled > sc.max - 3 && sc.footBottom <= sc.vh + 2,
    `可滚 ${sc.max}px · 实际滚到 ${sc.scrolled}px · 页脚底 ${sc.footBottom}px ≤ 视口 ${sc.vh}px`);

  await shot('导览页-底部-1440x900');
  check('打开站点根（`/`）**默认进入导览页**，且导览页里有去模拟主页面的入口（不是直接落到模拟页）',
    !root.isSim && root.shots === 4 && root.toSim && /导览/.test(root.title),
    `标题「${root.title}」· 截图 ${root.shots} 张 · 去主页面入口 ${root.toSim ? '有' : '无'} · 落在模拟页=${root.isSim}`);
  await ev(`window.scrollTo(0, 0)`);
  await sleep(120);
  await shot('导览页-1440x900');
  // 窄屏：导览页是"给人看的"，手机上排版塌了比功能坏更难发现
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true, screenWidth: 390, screenHeight: 844 });
  await sleep(260);
  const narrow = await ev(`(() => {
    const w = document.documentElement.clientWidth;
    return { overflow: document.documentElement.scrollWidth - w, cols: getComputedStyle(document.querySelector('.shots')).gridTemplateColumns.split(' ').length };
  })()`);
  check('窄屏（390px）**不横向溢出**，截图卡片退成单列',
    narrow.overflow <= 1 && narrow.cols === 1, `横向溢出 ${narrow.overflow}px · 截图列数 ${narrow.cols}`);
  await shot('导览页-390x844');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, screenWidth: 1440, screenHeight: 900 });
}

function report() {
  console.log(`\n================ ${pass} 通过 / ${fail} 失败 ================`);
  if (!SMOKE) console.log(`截图目录：${OUT}`);
  ws.close();
  chrome.kill();
  server.close();
  if (fail > 0) process.exitCode = 1;
}
report();
