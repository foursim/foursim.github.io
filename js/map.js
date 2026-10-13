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

/**
 * 路网样式：**刻意压暗**。
 * 路是背景（要看的是地块上的监测值），第一版用了亮黄 + 粗线，结果整张图被路抢走了注意力。
 */
const ROAD_STYLE = {
  motorway: { color: '#8a7a52', weight: 2.2 },
  trunk: { color: '#847455', weight: 2 },
  primary: { color: '#7d6f50', weight: 1.8 },
  secondary: { color: '#75694c', weight: 1.5 },
  tertiary: { color: '#6d6248', weight: 1.2 },
  unclassified: { color: '#5f5741', weight: 1 },
  residential: { color: '#57503c', weight: 0.9 },
  track: { color: '#4f4a38', weight: 0.8, dashArray: '3 3' }, // 田间道：农机进出靠它
};

export class AgriMap {
  constructor({ el, parcels, roads, poi, isochrones, units, grids, zones, rows, get, region, onSelect }) {
    this.rows = rows;
    this.get = get;
    this.region = region; // 区域序列的"当前值"容器（main 每天更新，供气温圈等区域量使用）
    this.onSelect = onSelect;
    this.variable = 'progress';
    this.day = 0;
    this.visible = { parcels: true, fill: true, roads: true, poi: true, temp: true, iso: true, units: true, grids: false, zones: false };

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
        layer.on('mouseover', () => layer.setStyle({ weight: 1.6, color: '#f0f4e8' }));
        layer.on('mouseout', () => this.parcelLayer.resetStyle(layer));
      },
    }).addTo(this.map);

    this.roadLayer = L.geoJSON(roads, {
      style: (f) => {
        const s = ROAD_STYLE[f.properties.highway] ?? { color: '#7d7a63', weight: 1 };
        return { ...s, opacity: 0.85, lineCap: 'round' };
      },
      interactive: false,
    }).addTo(this.map);

    this.poiLayer = L.layerGroup(
      (poi?.features ?? []).map((f) => L.circleMarker(
        [f.geometry.coordinates[1], f.geometry.coordinates[0]],
        {
          radius: f.properties.kind === 'silo' ? 5 : 3.5,
          color: '#0b0e0c',
          weight: 1,
          fillColor: f.properties.kind === 'silo' ? '#e0c050' : (f.properties.kind === 'agrarian' ? '#78c8ff' : '#b0913f'),
          fillOpacity: 0.95,
        },
      ).bindTooltip(`${f.properties.label}${f.properties.name ? ` · ${f.properties.name}` : ''}`, { direction: 'top' })),
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
      style: () => ({ color: '#ffffff', weight: 1.6, opacity: 0.55, fill: false, dashArray: '8 4' }),
    }).addTo(this.map);
    /** P4 统计网格线 */
    this.gridLayer = L.geoJSON(grids, {
      interactive: false,
      style: () => ({ color: '#9fd0c8', weight: 1, opacity: 0.5, fill: false, dashArray: '2 6' }),
    });
    /** P3 管理分区样点（演示：25 m 网格采样 + 聚类，颜色 = 分区类 A/B/C/D） */
    const ZC = { A: '#2f7d3a', B: '#c8b93a', C: '#dd8436', D: '#c0392b' };
    this.zoneLayer = L.geoJSON(zones, {
      interactive: false,
      pointToLayer: (f, latlng) => L.circleMarker(latlng, {
        radius: 2.4, stroke: false, fillColor: ZC[f.properties.zone] ?? '#888', fillOpacity: 0.85,
      }),
    });

    // 区域气温：**一个圆 + 数值**，不给地块编造地块级温差（见 geo.js 的说明）
    this.tempLayer = L.layerGroup().addTo(this.map);
    this.map.on('zoomend', () => this.drawTemp());
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
      color: '#12160f',
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
    else if (name === 'zones') { if (on) this.zoneLayer.addTo(this.map); else this.map.removeLayer(this.zoneLayer); }
    else this.refresh();
    if (name === 'temp' && on) this.drawTemp();
  }

  refresh() {
    this.parcelLayer.setStyle((f) => this.styleFor(f));
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

  focusParcel(row) {
    const layer = this.parcelLayer.getLayers()[row.i];
    if (layer) this.map.fitBounds(layer.getBounds(), { padding: [80, 80], maxZoom: 17 });
  }
}
