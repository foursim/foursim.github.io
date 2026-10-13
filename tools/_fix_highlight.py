"""临时补丁：修高亮的取消/切换（用完即删）"""
import io

def patch(path, pairs):
    s = io.open(path, encoding='utf-8').read()
    for old, new in pairs:
        assert s.count(old) >= 1, f'{path}: 找不到锚点 {old[:80]!r}'
        s = s.replace(old, new, 1)
    io.open(path, 'w', encoding='utf-8').write(s)
    print(f'[ok] {path}')

# ==================== map.js：高亮可取消、可切换，复原走自己的 styleFor ====================
patch('js/map.js', [
    ("""  highlight(indices, { fit = true, maxFit = 400 } = {}) {
    for (const l of this.highlighted) this.parcelLayer.resetStyle(l);
    this.highlighted = [];
    const layers = this.parcelLayer.getLayers();
    for (const i of indices ?? []) {
      const l = layers[i];
      if (!l) continue;
      l.setStyle({ weight: 2.6, color: this.token.parcelHover, opacity: 1, fillOpacity: 0.95 });
      l.bringToFront?.();
      this.highlighted.push(l);
    }
    this.highlightIdx = [...(indices ?? [])];
    if (fit && this.highlighted.length && this.highlighted.length <= maxFit) {
      const g = L.featureGroup(this.highlighted);
      this.map.fitBounds(g.getBounds(), { padding: [60, 60], maxZoom: 16 });
    }
    return this.highlighted.length;
  }""",
     """  /** 高亮样式（一处定义，`refresh()` 复用） */
  hlStyle() {
    return { weight: 2.6, color: this.token.parcelHover, opacity: 1, fillOpacity: 0.95 };
  }

  /**
   * **取消高亮**：把每块地按**当前变量/日期**重新算一遍样式。
   *
   * ⚠️ 为什么不能用 Leaflet 的 `resetStyle()`：本仓库打包的是 **Leaflet 1.1.1**，它的实现是
   * `layer.options = Util.extend({}, this.options.style)` —— 而我们的 `style` 是个**函数**，
   * 于是复原后的地块拿到的是**默认样式**（Leaflet 默认蓝 + 粗线），看起来就是"高亮永远取消不掉、
   * 而且越点越多一片蓝"。用自己的 `styleFor(feature)` 复原才是精确的（与 `refresh()` 同源）。
   */
  clearHighlight() {
    const n = this.highlighted.length;
    for (const { layer, feature } of this.highlighted) layer.setStyle(this.styleFor(feature));
    this.highlighted = [];
    this.highlightIdx = [];
    return n;
  }

  /**
   * 高亮一组地块（表格 → 图）。
   *
   * **每次调用先清上一次** —— 两次点击之间不能叠加：上一组的"高亮"必须真的消失，
   * 否则图上会同时挂着两组、看着像"高亮越点越多"。
   */
  highlight(indices, { fit = true, maxFit = 400 } = {}) {
    this.clearHighlight();
    const layers = this.parcelLayer.getLayers();
    for (const i of indices ?? []) {
      const l = layers[i];
      if (!l) continue;
      l.setStyle(this.hlStyle());
      l.bringToFront?.();
      this.highlighted.push({ layer: l, feature: l.feature });
    }
    this.highlightIdx = [...(indices ?? [])];
    if (fit && this.highlighted.length && this.highlighted.length <= maxFit) {
      const g = L.featureGroup(this.highlighted.map((h) => h.layer));
      this.map.fitBounds(g.getBounds(), { padding: [60, 60], maxZoom: 16 });
    }
    return this.highlighted.length;
  }"""),
    ("""  refresh() {
    this.parcelLayer.setStyle((f) => this.styleFor(f));
    this.drawTemp();
  }""",
     """  refresh() {
    this.parcelLayer.setStyle((f) => this.styleFor(f));
    // 高亮是"用户当前的查看选择"，不该被"换一天/换指标"的刷新抹掉：刷新后补回来
    for (const { layer } of this.highlighted) layer.setStyle(this.hlStyle());
    this.drawTemp();
  }"""),
])

# ==================== index.html：表格区加「取消高亮」与状态提示 ====================
patch('index.html', [
    ("""      <div class="tb-actions">
        <span id="tb-note" class="tb-note"></span>""",
     """      <div class="tb-actions">
        <span id="hl-note" class="tb-note"></span>
        <button id="btn-clear-hl" class="mini" title="取消地图上的高亮（也可以再点一次同一行）">取消高亮</button>
        <span id="tb-note" class="tb-note"></span>"""),
])

# ==================== ui.js：接线（按钮 / 切页签清空 / 状态文案） ====================
patch('js/ui.js', [
    ("      'tb-tabs', 'tb-body', 'tb-note', 'btn-export-csv', 'btn-export-png'];",
     "      'tb-tabs', 'tb-body', 'tb-note', 'hl-note', 'btn-clear-hl', 'btn-export-csv', 'btn-export-png'];"),
    ("""    refs['btn-export-csv'].addEventListener('click', () => actions.onExportCsv?.());""",
     """    // 高亮的状态与取消：状态写在按钮旁边（"图上这一片蓝框是什么"必须一眼能看出、且能一键清掉）
    refs['btn-clear-hl'].addEventListener('click', () => actions.onClearHighlight?.());
    refs['btn-export-csv'].addEventListener('click', () => actions.onExportCsv?.());"""),
    ("""      if (!b) return;
      this.activeTable = b.dataset.tab;
      this.renderTables();""",
     """      if (!b) return;
      // 换页签先清掉上一次的高亮：上一页选的组与这一页无关，留着就是"无关联的高亮"
      if (this.activeTable !== b.dataset.tab) actions.onClearHighlight?.({ silent: true });
      this.activeTable = b.dataset.tab;
      this.renderTables();"""),
    ("""  /** 情景推演结果（`main.js` 在地图上点选后传进来）。""",
     """  /** 高亮状态文案（`null` = 当前没有高亮） */
  setHighlightInfo(text) {
    if (this.refs['hl-note']) this.refs['hl-note'].textContent = text ?? '';
    if (this.refs['btn-clear-hl']) {
      const on = !!text;
      this.refs['btn-clear-hl'].classList.toggle('dim', !on);
      this.refs['btn-clear-hl'].title = on ? `取消高亮（当前：${text}）；也可以再点一次同一行`
        : '当前没有高亮';
    }
  }

  /** 情景推演结果（`main.js` 在地图上点选后传进来）。"""),
])

# ==================== main.js：切换式高亮 + 取消动作 ====================
patch('js/main.js', [
    ("""  function pickScenario(latlng) {""",
     """  /**
   * 表格 → 图 的高亮入口（**切换式**）：
   * - 点同一组第二次 ⇒ **取消高亮**（用户明确要求："无法取消"这件事不能存在）；
   * - 点另一组 ⇒ 先取消上一组（`map.highlight` 内部已先 clear），只保留新的一组；
   * - 状态写在表格右上角（`ui.setHighlightInfo`），并有「取消高亮」按钮兜底。
   */
  let hlKey = null;
  function highlightGroup(key, indices, label) {
    if (hlKey === key) {
      map.clearHighlight();
      hlKey = null;
      ui.setHighlightInfo(null);
      ui.toast('已取消高亮');
      return 0;
    }
    const n = map.highlight(indices);
    hlKey = n ? key : null;
    ui.setHighlightInfo(n ? `${label}（${n} 块）` : null);
    if (!n) ui.toast('这一组没有地块可高亮', 'warn');
    return n;
  }

  function pickScenario(latlng) {"""),
    ("""    ui.setScenario({ base: scenarioFile.metadata.baseline, cand: best, meta: scenarioFile.metadata });
    const n = map.highlight(best.improved.map(([i]) => i));
    ui.toast(`拟建点：平均可省 ${best.avg_gain_min} 分钟/块，高亮 ${n} 个受影响地块`, 'ok');""",
     """    ui.setScenario({ base: scenarioFile.metadata.baseline, cand: best, meta: scenarioFile.metadata });
    const n = map.highlight(best.improved.map(([i]) => i));
    hlKey = n ? `scenario:${best.lon},${best.lat}` : null;
    ui.setHighlightInfo(n ? `拟建点受影响地块（${n} 块）` : null);
    ui.toast(`拟建点：平均可省 ${best.avg_gain_min} 分钟/块，高亮 ${n} 个受影响地块`, 'ok');"""),
    ("""      onHighlightUnit: (unitId) => {
        const idx = rows.filter((r) => r.unit_id === unitId).map((r) => r.i);
        const n = map.highlight(idx);
        ui.toast(`${unitId}：${n} 个地块已高亮（图上蓝框）${n ? '' : ' —— 该单元没有地块？'}`, n ? 'ok' : 'warn');
      },
      onHighlightCrop: (cropCode) => {
        const idx = rows.filter((r) => (r.fallow ? 'FALLOW' : (r.crop ?? 'UNKNOWN')) === cropCode).map((r) => r.i);
        const n = map.highlight(idx);
        ui.toast(`${cropCode}：${n} 个地块已高亮`, n ? 'ok' : 'warn');
      },""",
     """      onHighlightUnit: (unitId) => {
        const idx = rows.filter((r) => r.unit_id === unitId).map((r) => r.i);
        const n = highlightGroup(`unit:${unitId}`, idx, `经营单元 ${unitId}`);
        if (hlKey) ui.toast(`${unitId}：${n} 个地块已高亮（再点一次这一行可取消）`, 'ok');
      },
      onHighlightCrop: (cropCode) => {
        const idx = rows.filter((r) => (r.fallow ? 'FALLOW' : (r.crop ?? 'UNKNOWN')) === cropCode).map((r) => r.i);
        const n = highlightGroup(`crop:${cropCode}`, idx, `作物 ${cropCode}`);
        if (hlKey) ui.toast(`${cropCode}：${n} 个地块已高亮（再点一次这一行可取消）`, 'ok');
      },
      /** 取消高亮（表格右上角按钮 / 切页签时静默调用） */
      onClearHighlight: ({ silent = false } = {}) => {
        const n = map.clearHighlight();
        hlKey = null;
        ui.setHighlightInfo(null);
        if (!silent) ui.toast(n ? `已取消 ${n} 块的高亮` : '当前没有高亮');
      },"""),
])
print('高亮修复完成')
