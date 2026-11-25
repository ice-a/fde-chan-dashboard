# 缠论 × 动量 · 二维共振看板

从单文件 HTML 迁移而来的动态前端项目。Vue 3 + TypeScript + Vite + Pinia + ECharts，配同构行情服务，**自托管部署（Node 或 Docker Compose）**。原始 `../缠论动量二维共振看板_5分钟刷新.html` 保持不变。

## 功能

- 原 81 个港股、美股和 A 股标的，57 只个股 + 24 只 ETF。
- 按标的自动降级：东方财富 → 腾讯行情 → Nasdaq（仅美股）。
- 统一 OHLCV 校验、日期排序、去重、证券核对、130 根最低历史要求。
- 服务端缓存、过期回退、真实交易日、接收时间和逐源错误诊断。
- `legacy-v1` 保留原缠论与动量公式；纯函数截面百分位、四象限与稳定排名。
- 1 / 5 / 15 分钟刷新、暂停/恢复、手动刷新、隐藏页暂停、网络状态处理。
- 共振摘要、可点击散点图、筛选搜索与排序、数据来源面板和标的诊断抽屉。
- 无 JSONP、无 ECharts CDN、无前端行情密钥、无静态快照冒充实时行情。
- 结构研究图谱：原始K线、成交量、分型、已完成笔、笔中枢及与评分一致的合并K线MACD。
- 本机自选：固定配置池内收藏、自选筛选；默认仍按全池计算动量，不用子集重排。
- 导出：当前筛选排名 CSV、单标的完整研究 JSON、本机信号事件 CSV。
- 本机信号动态：象限、结构观察和超过5位的排名变化，最多240条，去重且忽略陈旧数据。
- 服务端定时流水线：Node 宿主内置 timer 每日自动同步目录 → 全市场扫描 → 评分封口，无需打开页面；页面"自动流水线"面板实时展示进度、速率与预计完成时间。
- 快照历史与趋势：保留最近 30 轮每日快照，自选标的跨快照排名曲线对比。
- 服务端信号：相邻快照自动 diff（象限跃迁、排名变动≥5位），跨设备保存；可选 Bark / ntfy / webhook 推送每日摘要。

## 数据源与口径

| 来源 | 角色 | 支持范围 | 日线口径 |
| --- | --- | --- | --- |
| 东方财富 | 主源 | 当前标的池 | 前复权 |
| 腾讯行情 | 第一备用源 | A 股、港股有效；美股历史不足时自动跳过 | 前复权 |
| Nasdaq | 第二备用源 | 美股个股与 ETF | 历史价格，标为“拆股调整” |

一次单标的响应只采用**一个来源的完整 K 线**，不会跨源拼接历史。不同来源的复权口径、成交量和公司行动处理可能不同，切换来源后分数不保证与另一来源完全一致。Nasdaq 复权说明应作为保守标注，严格回测请使用有明确复权文档和授权的供应商。

当前版本每 5 分钟刷新的是**历史日线**，不是 5 分钟 K 线，也不是逐笔/WebSocket 推送。当日盘中 K 线可能未收盘。跨市场交易时段不同，截面比较并非严格同步。

### 当前本机实测

- `HK:00700`：腾讯，300 根，最新交易日 `2026-11-18`。
- `CN:510300`：腾讯，300 根，最新交易日 `2026-11-18`。
- `US:AAPL`：东方财富在当前网络连接被关闭，腾讯仅返回 2 根；Nasdaq 成功返回 300 根，最新交易日 `2026-11-17`，标为拆股调整。
- `US:QQQ`：Nasdaq `assetclass=etf` 成功返回 300 根。
- 整页首轮：75 / 81 个标的产生有效评分；`HK:03456` 仅 101 根有效日线，按原最低 130 根规则排除。
- 东方财富曾通过 curl 成功取得真实 JSON；本机 Node 的网络连接在后续测试中被上游关闭，因此实际页面降级为备用源。并非所有网络环境都复现这一限制。

## 存储适配层

存储收敛在两个接口后：`ResearchStore`（目录+扫描）与 `MarketCache<T>`（行情缓存）。现有实现：

| 实现 | 后端 | 驱动 |
| --- | --- | --- |
| `D1ResearchStore` + `D1MarketCache` + `LibSqlDatabase` | Turso Cloud / sqld / `file:` 本地库 | `@libsql/client`（Node） |
| `MemoryResearchStore` + `MemoryCache` | 进程内存（未配置 `TURSO_DATABASE_URL` 时） | Node |

libSQL 适配器复用同一套 SQL 与 schema（`server/storage/schema.sql`），Node 自托管（Docker 或裸 Node）共用同一套存储代码。

- **远程 Turso**：`TURSO_DATABASE_URL=libsql://…` + `TURSO_AUTH_TOKEN`（Turso Cloud 免费档：5 亿行读/月 + 1000 万行写/月，SQLite 方言）。
- **本地文件**：`TURSO_DATABASE_URL=file:./chan.db`，零依赖自托管，无需 token。
- 未配置时使用进程内存（重启即失），仅适合试用。

## 全市场目录与扫描（2026-11 新增）

固定 81 只只是测试样例。项目现支持 **A股沪深（主板/创业板/科创板）、港交所主板普通股、美股主要交易所普通股与 ETF** 的全市场目录与后台扫描，速度可以慢，但目标是"目录完整、每只有终态、失败可重试、缺失可审计"。

### 目录来源（均经实测）

| 市场 | 来源 | 实测数量 | 状态 |
| --- | --- | ---: | --- |
| A股 | 上交所 getStockListData2（主板 + 科创板） | 1,604 + 405 | 完整分页验证 |
| A股 | 深交所 ShowReport（A股 + ETF） | 2,905 + 772（ETF 含 LOF 过滤） | 完整分页验证；当前网络偶发 fetch failed，失败轮会如实标注 |
| 港股 | 港交所 ListOfSecurities.xlsx（主板普通股） | 完整工作簿应为数千行 | 本机实测只拿到 8 行**样本文件**（仅前 5 只，换浏览器 UA / 带 Cookie 结果字节完全相同），截断护栏如实判失败；需能从港交所取得完整文件的网络或客户端 |
| 美股 | Nasdaq screener `download=true` 全量单次（浏览器解析） | 7,291（纳入约 5,805，排除权证/优先股等约 1,486）+ 5,519 | 完整验证；分页端点每次请求顺序非确定（offset 开窗会重复且遗漏），已弃用分页改为全量下载 |
| 北交所 | bse.cn 有反爬拦截 | 未同步 | 明确列为缺口，不伪造数据 |

目录同步要求逐页取完、数量与声明一致、跨来源无重复 ID；任何一页失败则该来源标记 failed，**未封口目录不会冒充全市场**。来源报告在页面"全市场目录与扫描"面板逐项展示。

### 扫描与快照（libSQL 持久化 + 分片流水线）

- **目录同步两种驱动**：
  - `server` 驱动（Node）：`POST /api/catalog/sync` 一次完成四来源同步，每来源最多重试 2 次。
  - `client` 驱动（浏览器推进）：逐页 `POST /api/catalog/sync/page`；港交所 XLSX 与 Nasdaq 全量 JSON 由**浏览器解析**（`/api/catalog/hkex-workbook`、`/api/catalog/nasdaq-screener` 仅透传字节）后 `POST /api/catalog/stage` 暂存，最后 `POST /api/catalog/commit` 提交。提交校验要求 7 个预期来源全部在场且完成，否则 `complete:false`（未封口），不冒充全市场。任一分页失败会**落账为 failed 并继续其余来源**（逐来源重试 2 次），不会一源失败中断全局。
- **扫描两种驱动**：
  - Node：`POST /api/scans` 后服务端后台分片推进（每批 8 只），完成后自动评分并封口。
  - 浏览器：前端循环 `POST /api/scans/:id/step` 推进 → `GET /raws` 拉取评分输入 → **浏览器计算全局排名**（`rankRawEntries`，与服务端同一纯函数）→ `POST /scores` 分块回写 → `POST /finalize` 封口校验。进度持久化在 libSQL，刷新页面可断点续跑。
- `GET /api/scans/:id`：实时进度（成功 / 历史不足 / 失败 / 待处理）。
- `POST /api/scans/:id/retry`：重试终态失败项。
- 排名快照存 `score` 表，`/api/snapshots/current/rankings` 按 SQL 分页（≤200 条/页），不加载整库。
- 快照轮转保留最近 30 轮（`GET /api/snapshots/list`），跨快照排名曲线走 `GET /api/snapshots/trends?ids=...`，页面"快照趋势"面板展示自选标的的曲线对比。

### 服务端定时流水线（Node 内置 timer）

配置 `TURSO_DATABASE_URL` 后，Node 宿主启动即挂载内置 timer（`CRON_TICK_SECONDS`，默认 60 秒），`server/core/cronRunner.ts` 每个 tick 做一小步并持久化进度（状态存 `app_state` 表），关掉浏览器也整夜推进：

1. **每日门控**：UTC `CRON_CYCLE_HOUR_UTC`（默认 16 = 北京 0 点）后启动当日周期（目录同步 → 提交 → 扫描 → 封口发布）。
2. **目录同步**：每 tick 推进最多 3 个来源；失败来源当日自动重试 2 次，仍失败如实落账。CN 来源被本机网络拦截时可配 `CRON_CN_SYNC_DEADLINE_HOURS`（默认 1）：提交前等待外部 CN 同步脚本（见下）把行暂存进来，超时则按"未封口"提交。
3. **扫描推进**：每 tick 最多 `CRON_SCAN_BATCH`（默认 8）只；崩溃/超时未回写的领取项下一 tick 自动回收重扫（防死锁）；全部终态后自动重试一轮失败项，再评分封口。
4. **信号与推送**：封口后与上一快照 diff（象限跃迁、排名变动 ≥5位）写入 `signal_events`（`GET /api/snapshots/signals`，页面"信号动态 → 服务端信号"跨设备展示），并可选推送摘要到 **Bark / ntfy / 通用 webhook**（`NOTIFY_BARK_URL` / `NOTIFY_NTFY_URL` / `NOTIFY_WEBHOOK_URL`，任一配置即生效）。测试：`POST /api/pipeline/test-notify`（需管理令牌）。
5. **状态可见**：`GET /api/pipeline/status` 返回周期门控、各来源进度与重试数、扫描速率与 ETA、最新快照；页面"自动流水线"面板每分钟刷新展示。

每个 tick 有界且可恢复：一批行情抓取（每只 1-9 秒上游 I/O）小批推进——批次 8 实测约 7-8 只/分钟稳定运行，11k 标的约 24 小时跑完。

**CN 目录外部同步**（补本机网络被 WAF 拦的上交所/深交所缺口）：在大陆网络可达的机器每日周期启动后运行

```bash
node --env-file=.env scripts/sync-cn-catalog.ts   # 需要 TURSO_DATABASE_URL / TURSO_AUTH_TOKEN
```

逐页把 CN 目录暂存进同一 libSQL 库；已完成来源自动跳过，单源失败落账不中断其余，中断后重跑可续传。定时流水线在等待窗口内看到行进来即照常提交。实测（2026-11-20，本机网络）：上交所主板 1,604 只 + 科创板 405 只共 22 页 6 秒入库；深交所对本机亦为 TLS 握手层掐断（连根域名都不通，IP/指纹级封锁），需换网络（如手机热点）重跑补齐。

数据源按市场能力路由（CN→东财→腾讯，US→Nasdaq），不对不支持的市场做无效探测。K 线详情**按需计算**（`/detail` 端点现场取数+计算，0.3ms/只），不持久化 13k 份 K 线。

### 本地运行扫描

```bash
node server/node/index.ts --research-token <你的本地管理令牌>
# 页面"全市场目录与扫描"→（localStorage 设置 chan-admin-token=<同一令牌>）→ 同步目录 → 启动扫描
```

当前验证：13,335 只标的目录同步约 13 秒；扫描实时进度正常推进（本机网络下 CN/HK 上游不可达会进入失败台账并可重试，美股正常成功）。

### 已知缺口（如实标注，不伪造）

- 港股 ETF 目录与北交所目录暂缺来源，页面会显示来源缺口而非假装完整。
- 港交所工作簿有下载截断护栏（主板普通股 <1000 条即判失败）；本机实测拿到的都是仅含前 5 只的样本文件（非传输截断：有效 XLSX、字节完全一致），需换能取得完整文件的网络/客户端。
- 部分网络出口访问上交所/深交所会被 WAF 403 拦截（Nasdaq、港交所可达），由定时流水线如实落账为 failed。本机大陆网络实测：上交所直连可用（`scripts/sync-cn-catalog.ts` 已验证入库 2,009 只），深交所对本机亦为 TLS 握手层掐断（Node/curl/PowerShell/代理均失败，IP/指纹级封锁），需换网络重跑补齐。`complete:false` 目录即"未封口"，扫描可继续但来源缺口可见。
- 扫描中的失败项可重试；流水线每轮封口前自动重试一次；封口校验在 `finalize` 与 `shared/integrity.ts`。

## 结构图谱、导出与本机历史

点击任意有效标的，打开宽幅研究抽屉。默认显示近100日原始K线与成交量，分型、已完成笔和笔中枢通过合并K线的原始起止索引回画，可切换全部结构和缩放。MACD沿用评分计算的合并收盘价，包含DIF、DEA和柱值；它不是原始日K MACD。图和分数使用同一次响应的K线，不在打开详情时重新取数。

排名工具栏支持“全部标的 / 我的自选”，星标及详情页均可收藏。收藏保存在 `localStorage` 的版本化ID列表中，损坏数据与未知代码会被忽略。自选只过滤显示，**不改变全池动量截面基准**。

- “导出当前 CSV”：只导出当前筛选结果，含UTF-8 BOM、评分、来源、行情时点、复权及算法口径。
- “导出研究 JSON”：包含该标的原始OHLCV、结构数组、MACD、指标与数据血缘，并说明坐标系。
- “本机信号动态 → 导出”：导出当前分类的信号事件CSV。

首次有效轮次只建立基线。后续只有象限变化、结构观察变化或排名变化至少5位才记录事件；相同状态不重复记录，stale结果不产生事件，盘中数据标为“盘中观察”。清空操作有二次确认，收藏不受影响。

本机收藏与历史使用当前浏览器、当前origin的 `localStorage`，不上传服务器，不是账号同步或完整行情历史；不同端口、不同域名之间不共享。历史最多240条，存储失败不影响行情刷新。自托管部署无需新增数据库。

## 本地开发

要求 Node.js **24+** 和 pnpm。当前使用 Node 26、pnpm 9 验证。

```bash
pnpm install
pnpm dev
```

打开 http://127.0.0.1:5173。Vite 将 `/api` 转发至 `127.0.0.1:8787`，两个进程会一起启动。

```bash
pnpm test        # Vitest 单元测试
pnpm typecheck   # 前端与服务端类型检查
pnpm build       # 类型检查 + dist 前端生产构建
pnpm start       # 生产模式：同一端口提供 dist 与 API
```

生产模式先执行 `pnpm build`，再运行 `pnpm start`，访问 http://127.0.0.1:8787。

`.env.example` 提供可配置项；本地 shell 中按需导出，Node 不依赖 dotenv：

| 变量 | 默认值 | 用途 |
| --- | ---: | --- |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | Node 监听地址 |
| `MARKET_CACHE_TTL_SECONDS` | `300` | 已收盘 K 线短期缓存；盘中最多 60 秒 |
| `MARKET_STALE_TTL_SECONDS` | `86400` | 全部来源失败时允许回退的最长时间 |
| `MARKET_REQUEST_TIMEOUT_MS` | `9000` | 单个上游请求超时 |
| `MARKET_PROVIDER_CONCURRENCY` | `4` | 每个供应商的服务端并发上限（1–8） |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | 空（内存） | libSQL 持久化：远程 `libsql://…` 或本地 `file:./chan.db` |
| `RESEARCH_ADMIN_TOKEN` | 空 | 目录同步 / 扫描等管理操作的令牌（也可用 `--research-token` 传入） |
| `CRON_TICK_SECONDS` | `60` | 定时流水线每 tick 间隔秒数（最小 60，配置 libSQL 后启用） |
| `CRON_SCAN_BATCH` | `8` | 定时扫描每 tick 推进的标的数 |
| `CRON_CYCLE_HOUR_UTC` | `16` | 每日周期启动的 UTC 小时（16 = 北京 0 点） |
| `CRON_CN_SYNC_DEADLINE_HOURS` | `0` | CN 源失败后等待外部 CN 同步提交窗口（小时，0=不等） |
| `NOTIFY_BARK_URL` / `NOTIFY_NTFY_URL` / `NOTIFY_WEBHOOK_URL` | 空（不推送） | 快照发布推送渠道，任一配置即生效 |

## Docker Compose

```bash
docker compose up --build
# http://localhost:8787
```

多阶段镜像使用 Node 24 Alpine，前端在构建阶段编译，生产阶段不需要安装运行时 npm 依赖。容器以非 root 用户运行，只读根文件系统、受限临时目录，含健康检查。Compose 默认映射 `8787:8787`，并把 libSQL、定时流水线与推送渠道的环境变量透传进容器（见 `compose.yaml`）；使用本地 `file:` 数据库时挂载 `./data` 卷。

```bash
docker compose down
```

## API

```text
GET /api/health
GET /api/market/providers
GET /api/market/bars?instrument=US:AAPL
GET /api/market/bars?instrument=HK:00700
GET /api/market/bars?instrument=CN:510300
GET /api/pipeline/status                      # 定时流水线状态（门控/来源/扫描速率与ETA/最新快照）
GET /api/snapshots/list                       # 已发布快照（最近30轮）
GET /api/snapshots/trends?ids=US:AAPL,CN:600519
GET /api/snapshots/signals?since=&limit=      # 服务端跨快照信号事件
POST /api/pipeline/test-notify                # 推送渠道自检（需 x-admin-token）
```

返回 `MarketResponse`：`MarketData` 包含实际 `provider`、`adjustment`、`sourceDate`、`receivedAt`、`cache`、`stale`、`isUnclosed`、`attempts` 和完整 `candles`。失败返回结构化错误及逐源原因，HTTP 502 不代表前端的整个页面失败。

仅允许请求配置池中的标的和固定上游主机，不是任意 URL 转发代理。响应禁缓存由应用层控制，真实缓存 TTL 与命中状态显式返回。

## 代码结构

```text
src/
  components/       Vue 看板、图表、表格、数据链路与诊断
  composables/      页面存活期间的自动刷新
  config/           81 个标的及供应商映射
  domain/           legacy-v1 缠论、MACD、动量与共振纯函数
  services/         浏览器同源行情 API、导出、存储与信号归并
  stores/           请求代次、结果、陈旧状态、收藏与本机历史
shared/             前后端共享行情与展示类型
server/core/        数据源、校验、路由、缓存、标准 HTTP 处理器、定时流水线
server/node/        Node 静态资源与 API 宿主（内置流水线 timer）
tests/              算法、校验、缓存与降级单元测试
```

## 算法边界与风险

`legacy-v1` 保留原包含、分型、笔、中枢与经验评分，不表示严格缠论买卖点已经完成独立校验。“中枢上方”只作为趋势观察，不直接等同于第三类买点。ATR 为近 14 个 TR 的算术平均，量能比为近 5 / 20 日平均成交量比。

失败标的不会静默从池中消失：有历史成功结果时保留并标 stale；无历史时进入诊断而不评分。动量分依赖本轮有效样本池，样本变化仍会影响相对排名，页面显示新鲜样本数和算法版本。

本项目仅供量化研究，不构成投资建议。公开网页接口可能改变、限流或受地区网络影响；商业或生产部署应使用获得授权、口径明确的数据服务。

## 验证状态

- Vitest：29 项单元测试通过（含结构映射、收藏、导出、信号历史与 libSQL 适配器）。
- TypeScript、Vite 生产构建：通过。ECharts 独立打包，首屏会加载图表模块；XLSX（港交所解析）按需分包。
- 存储：已从 D1/KV 整体迁移至 libSQL（Turso Cloud 免费档或本地 `file:`）。迁移前 D1 数据导出并落库对账通过（instrument 13,436、market_cache 64、catalog_meta 1、KV 残留缓存 107 键）。
- 配额：libSQL 免费档按月计（5 亿行读/月 + 1000 万行写/月），一轮全市场同步+扫描约 6-7 万行写，余量约 4-5 倍。
- 全市场目录实测：上交所 1,604+405、Nasdaq 股票 5,807 / ETF 5,519、港交所与深交所因本机网络失败被如实标注；同步约 13–60 秒（视网络）、失败来源自动重试 2 次。
- 全量扫描实测封口：13,335 只 31 分钟跑完（约 7 只/秒，本机网络限速），两轮终态分别为 10,411 + 2,924 与 8,393 + 4,942 成功/失败（本机网络随时间劣化，失败项可重试），评分与四象限（首轮 995 / 2,134 / 713 / 6,569）全部落表，封口校验通过并发布快照；进度实时可查、刷新页面可断点续显。
- 快照查询实测：`/api/snapshots/current/rankings` 分页返回真实排名与总数（`current` 别名解析为真实快照 ID）；40 只抽样扫描 5 秒封口，32 成功全部可查、8 失败进入诊断。排名并列按算法口径（共振分 → 动量分 → ID）对齐，# 列与显示顺序一致。
- 主题：浅色 / 深色 / 暖砂三套，图表随主题重绘；首屏数字（Hero、刷新分母、市场规模）全部改为动态取值。
- Docker：当前机器无 Docker 可执行文件，未实际构建容器。
