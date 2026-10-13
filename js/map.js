/**
 * Leaflet 地图层（本地内置 `vendor/leaflet`，**不画底图**）。
 *
 * ## 为什么不画底图
 * 1. **合规最省事**：不渲染行政边界/国界就绕开了审图号那一套（标准地图才需要）；
 * 2. **体积与离线**：真实底图要么在线瓦片（运行时联网、且中国境内还得管许可），
 *    要么自备 PMTiles（几十 MB、GitHub Pages 的 Range 支持还得实测）；
 * 3. 这个页面真正要看的是**地块与监测值**，底图只会抢注意力。
 * 需要底图时再加一层 `L.tileLayer`/PMTiles 即可，图层结构已经预留。
 *
 * ## 性能
 * 501 个多边形 + 1576 条路：用 `preferCanvas: true` 走 canvas 渲染，
 * 播放时每帧只调 `setStyle`，**不重建几何**（重建才是卡顿与"点击丢失"的来源）。
 */
import { VARIABLES, colorOf } from './geo.js';
import { mapTokens } from './theme.js';

/**
 * 路网样式：**刻意压暗**（路是背景，要看的是地块上的监测值），且**等级越高越显眼**。
 *
 * ⚠️ 颜色不再写死：Leaflet 画在 canvas 上，**吃不到 CSS 变量**，所以由 `mapTokens()` 从 CSS 里读出来，
 * 切主题时 `setTheme()` 重刷一次 —— 这样"三套配色"只需要维护 CSS 一处。
 */
const roadTone = (t) => ({
  motorway: { color: t.roadMajor, weight: 2.2 },
  trunk: { color: t.roadMajor, weight: 2 },
  primary: { color: t.roadMid, weight: 1.8 },
  secondary: { color: t.roadMid, weight: 1.5 },
  tertiary: { color: t.roadMinor, weight: 1.2 },
  unclassified: { color: t.roadMinor, weight: 1 },
  residential: { color: t.roadTrack, weight: 0.9 },
  track: { color: t.roadTrack, weight: 0.8, dashArray: '3 3' }, // 田间道：农机进出靠它
});

export class AgriMap {
  constructor({ el, parcels, roads, poi, isochrones, units, grids, zones, admin, villages, rows, get, region, onSelect }) {
    /** 主题色令牌（从 CSS 变量读；切主题时 `setTheme()` 重读） */
    this.token = mapTokens();
    this.rows = rows;
    this.get = get;
    this.region = region; // 区域序列的"当前值"容器（main 每天更新，供气温圈等区域量使用）
    this.onSelect = onSelect;
    this.variable = 'progress';
    this.day = 0;
    this.visible = { parcels: true, fill: true, roads: true, poi: true, temp: true, iso: true,
      units: true, grids: false, zones: false, admin: true, villages: true };
    /** 表格联动高亮：当前被高亮的地块 `{layer, feature}`（下次高亮前先复原） */
    this.highlighted = [];
    /** 当前高亮的地块下标（外部/判据读它） */
    this.highlightIdx = [];

    this.map = L.map(el, {
      zoomControl: true,
      attributionControl: false,
      preferCanvas: true,
      worldCopyJump: false,
    });
    // 无底图：直接把视野装到地块范围
    this.map.fitBounds(L.geoJSON(parcels).getBounds(), { padding: [24, 24] });

    // 地块：几何只加载一次，之后只改样式
    this.parcelLayer = L.geoJSON(parcels, {
      style: (f) => this.styleFor(f),
      onEachFeature: (f, layer) => {
        const row = this.rows[f.properties.i];
        layer.bindTooltip('', { sticky: true, className: 'tip' });
        layer.on('tooltipopen', () => layer.setTooltipContent(this.tipFor(row)));
        layer.on('click', () => this.onSelect?.(row));
        layer.on('mouseover', () => layer.setStyle({ weight: 1.6, color: this.token.parcelHover }));
        layer.on('mouseout', () => this.restoreStyle(layer));
      },
    }).addTo(this.map);

    this.roadLayer = L.geoJSON(roads, {
      style: (f) => {
        const s = roadTone(this.token)[f.properties.highway] ?? { color: this.token.roadMinor, weight: 1 };
        return { ...s, opacity: 0.85, lineCap: 'round' };
      },
      interactive: false,
    }).addTo(this.map);

    /** 农业设施点：**留下引用**，切主题时按 kind 重新上色 */
    const poiTone = (t, kind) => (kind === 'silo' ? t.poiSilo : (kind === 'agrarian' ? t.poiAgrarian : t.poiOther));
    this.poiList = [];
    this.poiLayer = L.layerGroup(
      (poi?.features ?? []).map((f) => {
        const kind = f.properties.kind;
        const layer = L.circleMarker(
          [f.geometry.coordinates[1], f.geometry.coordinates[0]],
          {
            radius: kind === 'silo' ? 5 : 3.5,
            color: this.token.parcelStroke,
            weight: 1,
            fillColor: poiTone(this.token, kind),
            fillOpacity: 0.95,
          },
        ).bindTooltip(`${f.properties.label}${f.properties.name ? ` · ${f.properties.name}` : ''}`, { direction: 'top' });
        this.poiList.push({ layer, kind });
        return layer;
      }),
    ).addTo(this.map);

    /**
     * 等时圈（`tools/build-access.mjs` 离线算出来的等值线）。
     * 层级**按本地区分位数**定（3/4.5/6/7.5 分钟），所以永远画得出东西 ——
     * 写死 15/20 分钟在"全程 ≤13 分钟"的乡镇上会是空图层。
     */
    const levels = isochrones?.metadata?.levels_min ?? [];
    const tone = (i) => ['#8fd39a', '#e0c050', '#dd8436', '#c0392b', '#8a2f26'][Math.min(i, 4)];
    this.isoLayer = L.geoJSON(isochrones, {
      style: (f) => ({ color: tone(Math.max(0, levels.indexOf(f.properties.level_min))), weight: 1.6, opacity: 0.85, dashArray: '6 5' }),
      onEachFeature: (f, layer) => layer.bindTooltip(`${f.properties.level_min} 分钟内可达`, { sticky: true }),
    }).addTo(this.map);

    /** P2 经营单元轮廓（单元几何 = 成员地块环的集合，相邻所以看起来连成一片） */
    this.unitLayer = L.geoJSON(units, {
      interactive: false,
      style: () => ({ color: this.token.unitLine, weight: 1.6, opacity: 0.55, fill: false, dashArray: '8 4' }),
    }).addTo(this.map);
    /** P4 统计网格线 */
    this.gridLayer = L.geoJSON(grids, {
      interactive: false,
      style: () => ({ color: this.token.gridLine, weight: 1, opacity: 0.5, fill: false, dashArray: '2 6' }),
    });

    /**
     * **行政边界**（真实数据：OSM `boundary=administrative`，见 `tools/fetch-data.mjs admin`）。
     *
     * 存的是**边界线**（外环 way 原样保留，不缝合多边形）—— 相邻 way 共享端点，画出来没有缝。
     * 乡级（Gemeinde）实线、县级（Kreis）虚线：一眼分得出"乡界"与"县界"。
     * 线不填色 ⇒ **不涉及审图号**那套（不渲染行政区域面）。
     */
    this.adminLayer = L.geoJSON(admin ?? { type: 'FeatureCollection', features: [] }, {
      style: (f) => this.adminStyle(f),
      onEachFeature: (f, layer) => layer.bindTooltip(
        `${f.properties.name}${f.properties.admin_code ? ` · ${f.properties.admin_code}` : ''}（${f.properties.level}）`,
        { sticky: true },
      ),
    }).addTo(this.map);
    // P3 管理分区样点：**按需加载**（12000+ 个点约 2.3 MB，首屏不该背这个包）
    this.zoneLayer = null;

    /**
     * **居民点**（真实地名：`place=village/hamlet/town`，见 `tools/fetch-data.mjs places`）。
     *
     * ⚠️ 这是**点位**不是村界：实测本镇在 OSM 里只有乡（8）与县（6）两级行政边界，
     * 没有村级 admin_level=9/10 关系 —— 拿不存在的东西硬画就是编。点位真实、够用（"这是哪个村"）。
     */
    this.villageLayer = L.layerGroup(
      (villages?.features ?? []).map((f) => {
        const [lon, lat] = f.geometry.coordinates;
        const big = f.properties.place === 'town' || f.properties.place === 'village';
        return L.circleMarker([lat, lon], {
          radius: big ? 4.5 : 3,
          color: '#ffffff',
          weight: 1.2,
          fillColor: this.token.village,
          fillOpacity: 0.9,
        }).bindTooltip(`${f.properties.name}${f.properties.population ? ` · 人口 ${f.properties.population}` : ''}`, { direction: 'top' });
      }),
    ).addTo(this.map);

    // 区域气温：**一个圆 + 数值**（地块级气温见 `tempParcel` 变量：由真实 DEM 推导）
    this.tempLayer = L.layerGroup().addTo(this.map);
    this.map.on('zoomend', () => this.drawTemp());
  }

  /** 行政边界线的样式：乡级实线、县级虚线（线宽/虚线按层级分，颜色走主题令牌） */
  adminStyle(f) {
    const lvl = String(f.properties.admin_level ?? '');
    const isTown = lvl === '8';
    return {
      color: this.token.adminLine,
      weight: isTown ? 2.2 : 1.4,
      opacity: isTown ? 0.9 : 0.55,
      dashArray: isTown ? null : '9 6',
      fill: false,
      interactive: true,
    };
  }

  /**
   * **切主题**：重读令牌 → 把吃不到 CSS 变量的图层（canvas 上的那些）刷一遍。
   * 只改样式、不重建几何 —— 重建几何正是播放卡顿与点击丢失的来源。
   */
  setTheme() {
    this.token = mapTokens();
    const t = this.token;
    const tone = roadTone(t);
    this.roadLayer.setStyle((f) => ({ ...(tone[f.properties.highway] ?? { color: t.roadMinor, weight: 1 }), opacity: 0.85, lineCap: 'round' }));
    this.adminLayer.setStyle((f) => this.adminStyle(f));
    this.unitLayer.setStyle(() => ({ color: t.unitLine, weight: 1.6, opacity: 0.55, fill: false, dashArray: '8 4' }));
    this.gridLayer.setStyle(() => ({ color: t.gridLine, weight: 1, opacity: 0.5, fill: false, dashArray: '2 6' }));
    for (const { layer, kind } of this.poiList) {
      layer.setStyle({
        color: t.parcelStroke,
        fillColor: kind === 'silo' ? t.poiSilo : (kind === 'agrarian' ? t.poiAgrarian : t.poiOther),
      });
    }
    this.refresh(); // 地块填充/描边也跟着换
  }

  /** 当前变量 + 当前日期下，一个地块该是什么颜色 */
  styleFor(feature) {
    const row = this.rows[feature.properties.i];
    const v = this.get(row, this.variable, this.day);
    const spec = VARIABLES[this.variable];
    const fill = this.variable === 'yield' && !(v > 0)
      ? '#3a3f3a'
      : (spec.type === 'class' ? (colorOf[this.variable](v) ?? '#555a55') : colorOf[this.variable](v));
    return {
      color: this.token.parcelStroke,
      weight: 0.5,
      opacity: this.visible.parcels ? 0.7 : 0,
      fillColor: fill,
      fillOpacity: this.visible.fill ? 0.82 : 0,
      // 休耕/未播种用虚线边区分开
      dashArray: row.fallow ? '2 2' : null,
    };
  }

  tipFor(row) {
    const v = this.get(row, this.variable, this.day);
    const spec = VARIABLES[this.variable];
    const shown = spec.type === 'class'
      ? (spec.classes.find(([k]) => k === v)?.[1] ?? '—')
      : (spec.type === 'categorical' ? (v ?? '—') : (spec.fmt ? spec.fmt(v) : v));
    const acc = row.t_min != null ? `到收储点 <b>${row.t_min.toFixed(1)} 分</b>（下道 ${row.access_m} m）<br>` : '';
    return `<b>${row.cropName ?? '未分类'}</b> ${row.area_ha.toFixed(2)} ha<br>`
      + `${spec.label}：<b>${shown}</b><br>`
      + acc
      + `<span class="dim">播种 ${row.sowDay ? `${row.sowDay.slice(4, 6)}/${row.sowDay.slice(6, 8)}` : '—'}`
      + ` · 收获 ${row.harvestDay ? `${row.harvestDay.slice(4, 6)}/${row.harvestDay.slice(6, 8)}` : '—'}</span>`;
  }

  /** 切换指标：只改样式，不重建图层 */
  setVariable(key) {
    this.variable = key;
    this.refresh();
  }

  /** 时间轴推进：只改样式（播放时每秒可调多次，不能重建几何） */
  setDay(day) {
    this.day = day;
    this.refresh();
  }

  setLayerVisible(name, on) {
    this.visible[name] = on;
    if (name === 'roads') { if (on) this.roadLayer.addTo(this.map); else this.map.removeLayer(this.roadLayer); }
    else if (name === 'poi') { if (on) this.poiLayer.addTo(this.map); else this.map.removeLayer(this.poiLayer); }
    else if (name === 'temp') { if (on) this.tempLayer.addTo(this.map); else this.map.removeLayer(this.tempLayer); }
    else if (name === 'iso') { if (on) this.isoLayer.addTo(this.map); else this.map.removeLayer(this.isoLayer); }
    else if (name === 'units') { if (on) this.unitLayer.addTo(this.map); else this.map.removeLayer(this.unitLayer); }
    else if (name === 'grids') { if (on) this.gridLayer.addTo(this.map); else this.map.removeLayer(this.gridLayer); }
    else if (name === 'admin') { if (on) this.adminLayer.addTo(this.map); else this.map.removeLayer(this.adminLayer); }
    else if (name === 'villages') { if (on) this.villageLayer.addTo(this.map); else this.map.removeLayer(this.villageLayer); }
    else if (name === 'zones') {
      if (this.zoneLayer && on) this.zoneLayer.addTo(this.map);
      else if (this.zoneLayer && !on) this.map.removeLayer(this.zoneLayer);
    }
    else this.refresh();
    if (name === 'temp' && on) this.drawTemp();
  }

  refresh() {
    this.parcelLayer.setStyle((f) => this.styleFor(f));
    // 高亮是"用户当前的查看选择"，不该被"换一天/换指标"的刷新抹掉：刷新后补回来
    for (const { layer } of this.highlighted) layer.setStyle(this.hlStyle());
    this.drawTemp();
  }

  /** 区域气温圈 + 数值标签（值取自模型的区域序列） */
  drawTemp() {
    this.tempLayer.clearLayers();
    if (!this.visible.temp) return;
    const center = this.map.getCenter();
    // 半径取视野的 1/6 并封顶 1.2 km：第一版取 1/4 且不封顶，气温圈大到把整个乡镇盖住
    const span = this.map.getBounds().getNorthEast().distanceTo(this.map.getBounds().getSouthWest());
    const r = Math.max(300, Math.min(1200, Math.round(span / 6)));
    L.circle(center, {
      radius: r,
      stroke: false,
      fillColor: colorOf.temp(this.region.temp),
      fillOpacity: 0.14,
      interactive: false,
    }).addTo(this.tempLayer);
    L.marker(center, {
      interactive: false,
      icon: L.divIcon({ className: 'temp-tag', html: `${this.region.temp.toFixed(1)}℃`, iconSize: [64, 20] }),
    }).addTo(this.tempLayer);
  }

  /** 懒加载：分区样点图层拿到数据后再建（main 里在打开图层时调用） */
  setZones(fc) {
    const ZC = { A: '#2f7d3a', B: '#c8b93a', C: '#dd8436', D: '#c0392b' };
    this.zoneLayer = L.geoJSON(fc, {
      interactive: false,
      pointToLayer: (f, latlng) => L.circleMarker(latlng, {
        radius: 2.4, stroke: false, fillColor: ZC[f.properties.zone] ?? '#888', fillOpacity: 0.85,
      }),
    });
    if (this.visible.zones) this.zoneLayer.addTo(this.map);
  }

  /**
   * **高亮一组地块**（表格点击 → 图上显示）。
   *
   * 为什么要有这个方向：表格能按"单元/作物"聚合，而地图是按地块画的 —— 点一行表格如果图上没反应，
   * 看的人就得自己去猜"这个单元在地图哪儿"。这里把该组地块**加粗描边 + 换成强调色**并框到视野里。
   * 复原走我们自己的 `styleFor(feature)`（**不是** Leaflet 的 `resetStyle`，见 `restoreStyle` 的说明）。
   */
  /**
   * 把**一个**地块的样式按"当前状态"复原：高亮中的保持高亮，其余按当前变量/日期重算。
   *
   * ⚠️ 别用 `parcelLayer.resetStyle(layer)`（Leaflet 1.1.1 会把 `options.style` 这个**函数**
   * 拷进 `layer.options`，于是地块拿到默认样式 = 默认蓝 + 粗线，鼠标一划过就"回不去"了）。
   */
  restoreStyle(layer) {
    const isHl = this.highlighted.some((h) => h.layer === layer);
    layer.setStyle(isHl ? this.hlStyle() : this.styleFor(layer.feature));
  }

  /** 高亮样式（一处定义，`refresh()` 复用） */
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
  }

  focusParcel(row) {
    const layer = this.parcelLayer.getLayers()[row.i];
    if (layer) this.map.fitBounds(layer.getBounds(), { padding: [80, 80], maxZoom: 17 });
  }
}
