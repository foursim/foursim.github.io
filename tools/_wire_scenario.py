"""临时补丁：情景推演接进页面（第 5 个表格页签 + 地图点选）（用完即删）"""
import io

def patch(path, pairs):
    s = io.open(path, encoding='utf-8').read()
    for old, new in pairs:
        assert s.count(old) >= 1, f'{path}: 找不到锚点 {old[:80]!r}'
        s = s.replace(old, new, 1)
    io.open(path, 'w', encoding='utf-8').write(s)
    print(f'[ok] {path}')

# ==================== ui.js：第 5 个页签 ====================
patch('js/ui.js', [
    ("""  ['alarms', '告警明细'],
];""",
     """  ['alarms', '告警明细'],
  ['scenario', '情景推演'],
];"""),
    ("""  /** 表格数据由 `main.js` 算好传进来 —— **UI 不做聚合**。""",
     """  /**
   * 情景推演结果（`main.js` 在地图上点选后传进来）。
   * 数据来自离线预计算的 `data/scenario.json`：每个候选点都已用**真实路网**重算过全网时间，
   * 浏览器只做"最近候选点的查表"，不在前端跑 Dijkstra（见 `tools/scenario.mjs` 的说明）。
   */
  setScenario(sc) {
    this.scenario = sc;
    this.lastTablesSig = ''; // 强制重画
    this.renderTables();
  }

  /** 表格数据由 `main.js` 算好传进来 —— **UI 不做聚合**。"""),
    ("""    } else {
      const list = this.alarmsFor(d);""",
     """    } else if (this.activeTable === 'scenario') {
      const sc = this.scenario;
      if (!sc) {
        cols = [{ label: '情景推演' }];
        rows = [{ cells: [{ text: '在地图上点一下，选一个拟建收储点的位置 → 这里给出"新建前后"的可达性对比（用真实路网重算）', cls: 'dim' }] }];
        note = '未选点';
      } else {
        const { base, cand, meta } = sc;
        const d2 = (a, b, digits = 2, lowerBetter = true) => {
          const v = b - a;
          if (Math.abs(v) < 1e-9) return `<span class="dim">持平</span>`;
          const good = lowerBetter ? v < 0 : v > 0;
          return `<span class="${good ? 'ok' : 'bad'}">${v > 0 ? '+' : ''}${v.toFixed(digits)}</span>`;
        };
        cols = [{ label: '指标' }, { label: '现状', num: true }, { label: '新建后', num: true }, { label: '变化', num: true }, { label: '说明' }];
        rows = [
          ['平均到收储点', `${base.avg_min}`, `${cand.avg_min}`, d2(base.avg_min, cand.avg_min), '分钟（全体地块平均）'],
          ['中位（p50）', `${base.p50_min}`, `${cand.p50_min}`, d2(base.p50_min, cand.p50_min), '分钟'],
          ['p90', `${base.p90_min}`, `${cand.p90_min}`, d2(base.p90_min, cand.p90_min), '分钟（尾部的典型水平）'],
          ['最远', `${base.max_min}`, `${cand.max_min}`, d2(base.max_min, cand.max_min), '分钟（最不利地块）'],
          ['盲区地块', `${base.blind_parcels}`, `${cand.blind_parcels}`, d2(base.blind_parcels, cand.blind_parcels, 0), `块（> ${meta.blind_threshold_min} 分钟）`],
          ['盲区面积', `${base.blind_ha}`, `${cand.blind_ha}`, d2(base.blind_ha, cand.blind_ha, 1), 'ha'],
          ['受影响地块', '—', `${cand.improved_parcels}`, '', `块 / ${cand.improved_ha} ha（节省 > 0.05 分钟）`],
        ].map((r) => ({ cells: [r[0], { text: r[1], num: true }, { text: r[2], num: true }, { text: r[3], num: true }, { text: r[4], cls: 'dim small' }] }));
        note = `候选点 ${sc.cand.lon.toFixed(5)}, ${sc.cand.lat.toFixed(5)} · 平均可省 ${sc.cand.avg_gain_min} 分钟/块 · 真实路网重算（离线预计算，${meta.step_m} m 网格）`;
      }
    } else {
      const list = this.alarmsFor(d);"""),
])

# ==================== main.js：读 scenario.json + 地图点选 ====================
patch('js/main.js', [
    ("""    loadJson('data/villages.geojson'),
  ]);""",
     """    loadJson('data/villages.geojson'),
    loadJson('data/scenario.json'),
  ]);"""),
    ("""    soilFile, elevFile, villagesFC] = await Promise.all([""",
     """    soilFile, elevFile, villagesFC, scenarioFile] = await Promise.all(["""),
    ("""  function setDay(day) {""",
     """  /**
   * **情景推演**：在地图上点一下 ⇒ 取最近的候选点 ⇒ 显示"新建前/后"的可达性对比。
   *
   * 重活（每个候选点一次单源 Dijkstra）已经在 `tools/scenario.mjs` 离线算完，
   * 这里只是查表 + 高亮受影响的地块 —— 所以点下去是**瞬时**的，页面也不背 Dijkstra 的实现。
   */
  function pickScenario(latlng) {
    let best = null;
    let bd = Infinity;
    for (const c of scenarioFile.candidates) {
      const d = (c.lat - latlng.lat) ** 2 + (c.lon - latlng.lng) ** 2;
      if (d < bd) { bd = d; best = c; }
    }
    if (!best) return;
    ui.setScenario({ base: scenarioFile.metadata.baseline, cand: best, meta: scenarioFile.metadata });
    const idx = best.improved.map(([i]) => i);
    const n = map.highlight(idx);
    ui.toast(`拟建点（${best.lon.toFixed(4)}, ${best.lat.toFixed(4)}）：平均可省 ${best.avg_gain_min} 分钟，`
      + `高亮 ${n} 个受影响地块`, 'ok');
  }

  function setDay(day) {"""),
    ("""    onSelect: (row) => ui.select(row),
  });""",
     """    onSelect: (row) => ui.select(row),
  });

  // 地图点选：只在「情景推演」页签激活时接管点击（否则点地块该是选中地块）
  map.map.on('click', (e) => {
    if (ui.activeTable === 'scenario') pickScenario(e.latlng);
  });"""),
    ("""    admin: adminFC, buildTables, exportCsv, exportPng, ADMIN_CODE, theme: THEME.key };""",
     """    admin: adminFC, buildTables, exportCsv, exportPng, ADMIN_CODE, theme: THEME.key,
    scenario: scenarioFile, pickScenario };"""),
])
print('情景推演接线完成')
