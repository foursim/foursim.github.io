# 农业监测 · GIS 模拟数据平台

以真实地形上的行政区为底图，由确定性模型生成 **501 个地块 / 62 个经营单元 / 549 天**的农事与气象数据；
页面为纯静态实现（无后端、无 CDN、可离线交付），数据同时落成 CSV、Excel 与 GeoJSON。

**打开仓库首页（或 `index.html`）即为导览页**，点击「进入模拟地图」进入 `sim.html`。

> 上手：[`docs/五分钟上手.md`](docs/五分钟上手.md) ·
> 开发历程与踩坑：[`docs/开发历程.md`](docs/开发历程.md) ·
> 待办与口径取舍：[`docs/待办.md`](docs/待办.md) ·
> 交付物：`tables/交付清单.md`、`tables/数据字典.md`

---

## 页面

| 文件 | 说明 |
|---|---|
| `index.html` | **导览页（入口）**：数据说明、四张数据截图、基础操作、口径边界 |
| `sim.html` | **模拟主页面**：GIS 地图 + 时间轴（含季度刻度）+ 表格区 + 数据视图 + 情景推演 |
| `guide.css` | 导览页样式（复用 `style.css` 的配色令牌，类名互不重叠） |

两页共用 `style.css` 的**政企深蓝**配色令牌（`:root`），样式类名有判据守着不重名。

## 快速开始

```bash
npm run ready           # 改代码/页面后的第一条命令：模型冒烟 + 页面冒烟 + 查询 + 仓库卫生（本机实测 28 秒）
npm run serve           # 本地静态服务（模拟页必须走 http；file:// 会被 CORS 拦）
npm run test:browser    # 真浏览器判据（本机实测 145 秒，输出截图目录）
npm run query           # 15 个预置查询 + 判据，产物写入 tables/query/
npm run deliver         # 生成 tables/交付清单.md（必带 / 按需 / 说明三组）
npm run pack -- --zip   # 打交付包：dist/agri-deliver-<日期>/ 与 .zip
npm run data:all        # 全量重建（含取数，需要联网）
```

## 数据规模

| 项 | 数值 |
|---|---|
| 地块 / 经营单元 / 统计网格 | 501 / 62 / 217 |
| 时间跨度 | 549 天（2024-07-01 至 2025-12-31） |
| 数据表 | 16 张（`tables/*.csv`）+ Excel 合集 `tables/农业监测数据.xlsx`（16 个工作表） |
| 判据 | **403 条**（见下节） |

## 数据真实性

- **模拟**：产量、水分、养分、病害、生长进度、运距均由确定性模型生成（同参数同结果），表中 `synthetic=1` 的列为模拟值；
- **真实**：地形高程、行政边界、道路、水系等底图要素来自公开数据（OSM / NASA POWER / SoilGrids / Open-Meteo）；
- **留空不编造**：土壤质地、pH、有机质、耕地质量等级为空；
- **口径边界**：多年生作物（牧草、果园）不存在"播种—收获"季，不纳入收获排产。

## 判据（403 条）

| 分组 | 条数 | 运行命令 | 主要关注点 |
|---|---:|---|---|
| 模型冒烟 | 42 | `npm test` | 适种性、病害驱动、同种子可复现、生成气象与实测的相似性 |
| 表格整形 | 11 | `npm run test:tables` | 星型结构、编码规则、单位与字典（node 侧，毫秒级） |
| 页面冒烟 | 5 | `npm run smoke:browser` | 页面能起来、无页面异常、关键数据规模对得上 |
| 真浏览器 | 231 | `npm run test:browser` | 交互确实生效、布局不重叠、入口与导览页、回放与导出、图表 3D |
| 数据 | 25 | `npm run data:check` | 跨表一致、守恒、口径边界 |
| 导出 | 31 | `npm run export:tables` | 每表每列均有数据元、Excel 完整 |
| 查询 | 22 | `npm run query` | 透视与联合查询与直接复算一致 |
| 交叉验证 | 17 | `npm run query:sql` | DuckDB 结果与自研实现逐格对比 |
| 交付包 | 6 | `npm run pack` | 包内表数、字节数一致、按需表带没带、页面引用齐全、不夹带缓存 |
| 仓库卫生 | 13 | `npm run repo:check` | 临时脚本残留、站内死链、换行符、样式类名冲突、文档命令有效性 |

合计 403 = `npm run ready` 110（冒烟 42 + 表格 11 + 页面冒烟 5 + 查询 22 + 交叉验证 17 + 仓库卫生 13）
\+ `npm run test:browser` 231 + `npm run data:check` 25 + `npm run export:tables` 31 + `npm run pack` 6。

所有判据都是**能失败**的断言。它们实际抓到过的 bug、修复过程与反向验证记录见 [`docs/开发历程.md`](docs/开发历程.md)。

## 目录

```
index.html  sim.html  guide.css  style.css     两个页面与样式
js/          页面代码（原生 DOM + Canvas，无框架、无第三方库）
data/        页面数据（JSON + GeoJSON）
tables/      交付数据（CSV / Excel / 查询产物 / 交付清单 / 数据字典）
tools/       离线工具与判据（每支 *.mjs 对应一条 npm 命令）
docs/        上手文档与开发历程
img/         导览页使用的数据截图
vendor/      Leaflet（本地内置，运行时零外部请求）
```

主要工具与产物：`tools/query.mjs`（查询引擎）、`tools/query-sql.mjs` + `tools/duck-run.py`（DuckDB 交叉验证）、
`tools/repo-check.mjs`（仓库卫生）、`tables/query/透视与联合查询.md`、`tables/query/results-self.json`、`data/pivot.json`。

## 最近三轮更新

| 轮次 | 内容 |
|---|---|
| **1 · 导览页滚动** | 修复导览页无法滚动到底（`style.css` 的 `body{overflow:hidden}` 未被覆盖）；判据改为**断言根因**（计算后的 `overflow-y`），不再只看"能不能滚" |
| **2 · 文案与核对** | 导览页文案统一为书面语；修正三处事实错误：指标名（水分保持 / 养分保持 / 到收储点）、九个页签名称、"均为模拟"与底图口径矛盾 |
| **3 · 图表 3D** | 新增 `js/charts3d.js`（自算等轴投影 + 三面明暗，不引渲染库）：柱 / 饼 / 折线 / 雷达四种 3D 视图，图表面板加「3D 视图」开关（默认关、记忆到 localStorage）；6 条判据守「2D 与 3D 口径逐项相等」与「顶面亮/侧面暗」的像素证据 |

更早的更新记录已移至 [`docs/开发历程.md`](docs/开发历程.md)。

## 部署

纯静态、支持子路径部署（`user.github.io/<repo>/` 已作为判据覆盖）。
推送到仓库后，在 Settings → Pages 选择分支与根目录即可；线上访问 `/` 即导览页。

## 已知限制

1. 行政边界只到县级，村 / 村民小组层未接入；
2. 土壤属性、完整 DEM、历史产量与 NDVI 未接入（对应列留空）；
3. 地块 × 日长表（`fact_parcel_daily`，约 27.5 万行）按需导出（`npm run export:daily`），默认不入库。
