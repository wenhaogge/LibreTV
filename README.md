# LibreTV V2.0 · Cloudflare Workers 适配版

这是 [wenhaogge/LibreTV 的 V2.0 分支](https://github.com/wenhaogge/LibreTV/tree/V2.0)，基于 [LibreSpark/LibreTV](https://github.com/LibreSpark/LibreTV) 的 Next.js 版进行 Workers 适配。保留聚合搜索、点播、直播、节目单和 ArtPlayer + hls.js 播放器，并增加 vinext 构建及本地 workerd 验证流程。

**当前已完成 Workers 构建、本地回归和实际部署，但仍有明确的安全边界、资源限制与未验证功能。** 下文优先说明本分支为了运行在 Workers 上所做的调整和妥协；上游功能说明不等于本分支对所有设备、数据源和 Next.js API 的兼容承诺。

- **V1.0**：保留本 fork 原来的 `main`，与本次 Workers 适配分开维护。
- **V2.0**：从上游提交 [`a24ad336a3f7c8a16ca93d1f1198e08ac6b7e943`](https://github.com/LibreSpark/LibreTV/commit/a24ad336a3f7c8a16ca93d1f1198e08ac6b7e943) 开始适配，应用版本仍为 `2.16.12`。分支名不代表 `package.json` 的版本号。
- **运行方式**：原 Next.js/Node 路径与 vinext/Workers 路径并存；保留 `npm run dev`、`npm run build`、`npm start`。

> 上游项目与文档：[官网](https://libretv.is-an.org/) · [文档首页](https://libretv.is-an.org/wiki/) · [架构](https://libretv.is-an.org/wiki/Architecture.html) · [配置](https://libretv.is-an.org/wiki/Configuration.html) · [播放器](https://libretv.is-an.org/wiki/Player.html) · [FAQ](https://libretv.is-an.org/wiki/FAQ.html)。Workers 构建与部署请以本 README 和本分支配置为准。

## 为 Workers 做了哪些调整

| 范围 | 实际调整 | 代价与边界 |
| --- | --- | --- |
| 构建与运行时 | 增加 vinext + Vite + Cloudflare Vite 插件，用 workerd 运行服务端产物；原 Next.js 构建保留 | 需要维护两套构建回归；Workers 路径不运行 `next start`，也不代表完整 Node.js 环境 |
| Cloudflare 配置 | 使用 `cloudflare.config.ts` 和 `cf`，启用 `nodejs_compat`、`enable_request_signal` | 依赖指定兼容日期与锁定的适配器版本；没有混用 OpenNext、`.open-next` 或 Wrangler 配置 |
| DNS / SSRF | 移除 `dns.lookup()` 路径；Node 使用 `resolve4/resolve6`，Workers 使用固定解析器的 DNS-over-HTTPS 查询 A/AAAA | DNS 查询会增加延迟和子请求；解析器故障时，原本可以访问的数据源也可能被拒绝 |
| 登录限流 | 移除模块顶层清理定时器，改为请求到来时清理过期记录；最多保存 4096 个 IP 记录 | 保留每 IP 10 次 / 10 分钟规则，但只有当前实例内有效；容量满时拒绝新 IP 的登录尝试 |
| EPG 与缓存 | 缓存预算从 256 MiB 改为默认 8 MiB；读取、解压、解析结果和并发分别设限 | 大节目单会明确报错，高并发时可能返回繁忙；更小缓存意味着更多重新抓取 |
| 密码与默认源 | 从服务端运行时读取 `PASSWORD`、`PROXY_SECRET`、`DEFAULT_SOURCES` | 本地配置与线上配置独立；默认源会经 `/api/status` 下发给浏览器，不应在源地址中放私密凭据 |
| 状态存储 | 沿用实例内缓存、限流与浏览器 IndexedDB / CacheStorage，未引入 KV、Durable Objects 或数据库 | 缓存不跨实例共享、不持久；没有跨实例全局限流，也没有跨设备观看进度同步 |

搜索、播放器、直播和 HLS 广告过滤没有为了适配而删除。**不过，DNS 拒绝策略和 EPG 限额属于真实行为变化，也会影响共用这些模块的 Node 运行路径。** 保留原构建命令不等于所有行为与上游完全相同。

### DNS 安全行为的变化

原版在 DNS 查询异常时允许继续请求；本分支改为 **无法可靠验证就拒绝**。仅有 A、仅有 AAAA 或两者都有的域名均可接受，但必须至少得到一个有效公网地址，且不能混入私有或保留地址。

Workers 路径直接读取固定的 `https://cloudflare-dns.com/dns-query` 的查询状态，以区分“某类记录不存在”与查询失败。每类查询限时 3 秒、响应最多 64 KiB、最多 64 条 Answer；异常状态、截断响应、无法验证的地址或两类记录均为空都会被拒绝。重定向仍逐跳检查，没有用 `LIVE_ALLOW_PRIVATE=1` 绕过保护。

**仍存在 DNS 重绑定风险**：预检查得到的地址没有绑定到后续 `fetch` 的实际连接，不能宣称彻底消除了 SSRF。部分入口与安全跳转流程还会重复检查同一目标，增加 DNS 请求开销。实现见 [ssrf.ts](src/lib/ssrf.ts) 和 [fetch-utils.ts](src/lib/fetch-utils.ts)。

### EPG 默认上限与实际妥协

以下是每个实例的保守初始配置。环境变量接受正整数，超过代码硬上限时按硬上限截取；未设置或非法值使用默认值。MiB = 1024 × 1024 字节。

| 环境变量 | 默认值 | 代码硬上限 | 含义 |
| --- | --- | --- | --- |
| `EPG_MAX_INPUT_BYTES` | 1 MiB | 4 MiB | 从响应体读取到的输入字节数，读取途中超限即取消 |
| `EPG_MAX_OUTPUT_BYTES` | 4 MiB | 8 MiB | XML 文本 / gzip 解压输出，解压过程中限制输出 |
| `EPG_MAX_PARSED_BYTES` | 4 MiB | 8 MiB | 解析后节目对象的估算大小 |
| `EPG_MAX_PROGRAMMES` | 10000 | 20000 | 时间窗口内保留的节目数 |
| `EPG_MAX_SCANNED_PROGRAMMES` | 50000 | 100000 | 扫描的节目总数，包括窗口外节目 |
| `EPG_MAX_CHANNELS` | 1000 | 2000 | 解析结果中的频道数 |
| `EPG_MAX_FIELD_CHARS` | 16384 | 32768 | 单个频道 ID、标题或描述的字符串长度 |
| `EPG_MAX_CONCURRENCY` | 1 | 2 | 当前实例同时抓取、处理未命中缓存的 EPG 请求数 |
| `LIVE_CACHE_MAX_BYTES` | 8 MiB | 16 MiB | EPG 等直播大对象缓存的估算总预算 |
| `LIVE_CACHE_MAX_ENTRIES` | 10 | 50 | 直播大对象缓存条目数 |

输入、解压或解析超限返回 **413**，并发超限返回 **503**，上游或损坏的 gzip 等错误返回 **502**。不会为了绕过大小限制静默截断节目单；原有“当前到未来 24 小时”的节目筛选窗口继续保留，缓存 TTL 为 6 小时，但可能提前被逐出。

**这不是全流式 XML 解析器**：有界读取后仍会拼接输入、同步解压、生成字符串和节目对象。缓存预算也不是进程总内存预算；其他请求、框架和通用缓存仍会占用内存。尚未证明生产高并发下的整体内存安全，不能只调高这些数字就认为解决了大节目单问题。Cloudflare 的内存额度按实例计算，多个请求共享，参见[官方限制](https://developers.cloudflare.com/workers/platform/limits/#memory)。实现见 [epg-limits.ts](src/lib/epg-limits.ts)、[xmltv.ts](src/lib/xmltv.ts) 和 [live-cache.ts](src/lib/live-cache.ts)。

## 已验证范围与尚未解决的限制

以下记录对应 **2026-10-06 的适配与依赖修复验证**，不是每次打开 README 时重新运行的测试结果。

| 检查 | 已有结果 | 不能据此推断的内容 |
| --- | --- | --- |
| 单元测试 | 上游基线 26 个文件 / 311 个测试；适配后 31 个文件 / 371 个测试通过 | 测试通过不证明没有漏洞或所有输入都安全 |
| 类型与构建 | `typecheck`、原 Next.js build、vinext Workers 生产构建通过 | 构建通过不等于全部 Next.js API 在 Workers 上兼容 |
| 本地 Workers 集成 | workerd 加载生产产物，16 组验证通过 | 上游响应由可控测试服务提供，不代表真实媒体站点可用 |
| 浏览器短 HLS | 本地 workerd 下，`/api/proxy` 与 `/api/live/stream` 两条路径的测试片段均播放到结束；首页及播放器样式已检查 | 未覆盖所有编码、长视频、电视、iPad、真实 HTTP-FLV 播放 |
| 线上部署 | 已完成 Worker 实际部署与首页、登录、状态接口检查 | 未完成长期稳定性、容量或全数据源播放认证 |
| AirPlay / Google Cast / DLNA | AirPlay 有现成按钮，但未完成端到端适配；Google Cast、DLNA 未接入 | iPad 系统屏幕镜像可用，不等于网页 AirPlay 视频投送可用 |

16 组集成检查覆盖：首页和状态、未登录与错误密码、运行时密码与 Cookie 签名、JSON / NDJSON 搜索、详情和源订阅、HLS 相对地址及 key/map 重写、分片与 Range、私网及重定向拦截、A/AAAA 和 DNS 异常、XMLTV 明文与 gzip、输入/解压上限、并发恢复、直播持续传输与客户端断开取消、运行时更换密码及签名密钥。直播传输检查使用合成字节流，只证明传输与取消行为。

必须接受的当前限制：

- **真实源可用性不保证**：搜索、详情成功不代表播放地址有效。上游 404、反爬、地域/IP 限制、过期链接、CORS 和编码问题仍可能导致播放失败，切换代理无法修复所有上游问题。
- **HLS 重写覆盖有限**：目前重写普通 URI 行及 `EXT-X-KEY`、`EXT-X-MAP`；没有完整覆盖独立音轨、字幕、I-frame、低延迟 HLS 等 URI 标签。通用代理还可能把以 `.m3u8` 结尾的 HTML 错误响应按清单处理，播放器提示不够明确。这些是保留的限制，并非已完成修复。
- **直播保留，但没有长期播放承诺**：直播专用代理使用 15 秒响应头超时，正文持续转发并在客户端断开时取消；通用 `/api/proxy` 仍有默认 8 秒的请求超时，不能替代 HTTP-FLV 长连接代理。Cloudflare HTTP 流式响应可以持续，但平台运行时更新等情况仍可能中断连接，参见[官方时长说明](https://developers.cloudflare.com/workers/platform/limits/#duration)。
- **AirPlay 按钮不等于可用投屏**：当前 hls.js 播放路径没有专门的 AirPlay 备用播放地址，也没有为独立接收端增加鉴权方案；已有 iPad 点击不可用或无反应的反馈，具体设备原因尚未确认。后续需要实际设备验证，参见 [WebKit 的 MSE / AirPlay 说明](https://webkit.org/blog/15036/how-to-use-media-source-extensions-with-airplay/)。
- **内存状态不是全局能力**：实例回收会丢失缓存和登录尝试记录，不同实例之间不共享；容量满时的新 IP 拒绝策略也可能影响正常用户。没有新增持久存储来弥补这一点。
- **额度与安全仍需持续评估**：HLS 分片、代理及 DNS 查询会消耗请求、子请求和 CPU 等资源；现有 EPG 限额不覆盖全部业务内存。尚未完成生产负载测试，不能保证免费额度足够或无限并发。
- **依赖问题没有全部消除**：已用定向 overrides 修复 Next 依赖链中的 PostCSS `8.4.31 → 8.5.29`、Satori 依赖链中的 fflate `0.7.3 → 0.7.5`。同日修复后扫描仍报告 braces 与 postcss-selector-parser 相关公告；供应商预打包代码不会自动被 overrides 重写，仍需单独跟踪。不能把扫描计数下降或测试通过视为全量安全证明。

## Workers 工具链与配置

以下是本分支锁文件记录的版本，不表示必须始终跟进最新版：

| 组件 | 版本 |
| --- | --- |
| 本地验证 Node / npm | `24.19.0` / `11.17.0` |
| Next.js / React / React DOM | `15.5.27` / `19.3.0` / `19.3.0` |
| vinext / @vinext/cloudflare | `1.0.1` / `1.0.1` |
| Vite | `8.3.0` |
| @cloudflare/vite-plugin | `2.0.0-beta.sha-52b0dc0e9` |
| cf | `1.0.0-beta.12` |
| Miniflare | `5.20260930.0-alpha` |

构建链包含 beta / alpha 组件，升级后要重新验证两套构建和 Workers 行为。使用 `npm ci` 按锁文件安装，不需要再次执行 `vinext init`，也不要套用 OpenNext 的 `.open-next` 产物路径。

- [vite.config.ts](vite.config.ts)：vinext 与 Cloudflare 插件；本地关闭远程 bindings 和 tunnel。
- [cloudflare.config.ts](cloudflare.config.ts)：兼容日期 `2026-09-30`，入口 `vinext/server/fetch-handler`，静态资源绑定 `ASSETS`；没有配置 KV、R2、Durable Objects 或数据库。
- Workers 产物位于 `.cloudflare/output/v0/workers/default/`；构建产物、`.dev.vars`、`.dev.vars.*` 已被 Git 忽略。
- 仓库内配置包含本 fork 的 Account ID 和 Worker 名 `libretv-v2`。复制到其他账号前，先改成自己的目标并核对认证；`cf` 的认证不能假定自动继承 Wrangler profile。

### 本地 Workers 预览

先在项目根目录创建不入库的 `.dev.vars`，填写自己的本地测试值。以下只有占位符，不是线上凭据：

```dotenv
PASSWORD="replace-with-your-local-password"
PROXY_SECRET="replace-with-a-long-random-local-secret"
DEFAULT_SOURCES='[{"name":"示例源","url":"https://example.com/api.php/provide/vod","isAdult":false}]'
```

```bash
npm ci
npm run build:vinext
npm run preview:vinext
# http://127.0.0.1:4173
```

`preview:vinext` 使用本地 Workers/workerd 运行产物，正常访问真实上游；“本地”不代表出网请求被拦截。需要热更新时使用 `npm run dev:vinext`（端口 3001）。原来的 `npm run dev`（端口 8080）是 Next.js/Node 开发服务，不能代替 Workers 验证。

回归命令按顺序执行：

```bash
npm test
npm run typecheck
npm run build
npm run build:vinext
npm run test:workers
```

`test:workers` 会拦截上游并使用可控测试数据，不进行真实影视播放；`scripts/workers-integration.mjs --serve` 同样是测试服务，不能当作真实源预览。Windows 如使用独立 Node 工具链，可用该目录中的 `npm.cmd`；无需修改系统 PATH。

### Cloudflare 构建与自动更新

本 fork 已连接 Cloudflare Workers Builds，生产分支为 `V2.0`，预览分支构建关闭。该连接属于 Cloudflare 账号设置，fork 仓库不会自动获得它。对应配置为：

| 项目 | 值 |
| --- | --- |
| 仓库 / 分支 | `wenhaogge/LibreTV` / `V2.0` |
| 根目录 | `/` |
| 构建环境变量 | `NODE_VERSION=24.19.0` |
| 构建命令 | `npm run build:vinext` |
| 部署命令 | `npx --no-install cf deploy --prebuilt --mode production --worker libretv-v2` |

线上 `PASSWORD`、`PROXY_SECRET`、`DEFAULT_SOURCES` 使用 Worker 运行时 secret bindings；不要把它们放进前端变量、公开构建配置或 README。`.dev.vars` 只用于本地，不会自动同步线上。其他可选变量须按当前适配器的环境绑定方式配置。

后续推送到 `V2.0` 会由现有连接构建和更新 Worker，README 改动也可能触发；不需要更改默认分支或推送版本 tag。上面的命令会实际发布，只应在核对目标账号、Worker 和运行时配置后使用。

## 核心特性

以下功能沿用上游；Workers 下的验证范围与限制见前文。

- **聚合搜索**：多采集站服务端并行搜索
- **跨源同名聚合**：同名影片合并为一张卡片，展开即可比较和选择各来源
- **HLS 播放**：ArtPlayer + hls.js，广告分片过滤、自动连播、倍速、快捷键、移动端长按 3 倍速
- **直播 / IPTV**：M3U 订阅解析，`/live` 页面按分组浏览、搜索频道并站内播放（HLS + HTTP-FLV），支持 XMLTV 节目单（EPG）与频道收藏；直播流经专用长连接代理（`/api/live/stream`）转发
- **进度同步**：播放进度与观看历史存于本机 IndexedDB，精确到秒的续播
- **换源测速**：跨源搜索同名资源并测速排序，一键切换保留集数位置
- **源测试与订阅**：一键探活点播源与直播源（支持批量测活）；搜索时自动记录各源健康度，连续失败的源按阶梯时长自动停用（30 分钟 → 24 小时 → 长期），可一键恢复；订阅远程源列表（一份 LibreTV-SourceList JSON 可同时下发点播源与直播源，也可直接填 TVBOX 配置地址，自动导入其中可直接使用的接口），可导出分享
- **首页推荐**：豆瓣（电影/剧集分类浏览）、Bangumi 新番放送表或影视榜单（豆瓣周榜 + 百度热播，经 60s API），设置中切换；均服务端直连 + 缓存，Bangumi/榜单免 key 免配置（`60S_API_BASE` 可指向自部署 60s 实例）
- **PWA**：可安装到桌面 / 主屏幕，亮暗双主题无首屏闪烁

## 保留的 Node / Docker 运行方式

Workers 部署见前文。本节保留传统 Node / 容器路径，便于在需要常驻服务或更大资源预算时使用。

### Docker

> 下面的 `ghcr.io/librespark/libretv`、`docker.io/bestzwei/libretv` 是上游发布镜像，不能代表本 fork 的 Workers 改动。若要运行本分支的 Node 代码，应使用本分支源码构建。Docker 镜像构建与运行未包含在本次 Workers 实测范围内。

```bash
# 在 .env 中设置 PASSWORD
echo "PASSWORD=your-password" > .env

# 方式一：拉取发布镜像（零构建）
docker compose pull && docker compose up -d

# 方式二：源码构建
docker compose up -d --build
```

### Docker Compose

```yaml
services:
  libretv:
    image: ghcr.io/librespark/libretv:latest
    container_name: libretv
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      - PASSWORD=change-me   # 必填：访问密码，务必修改
      # - PROXY_SECRET=your-secret          # 会话/代理签名密钥，多实例部署建议设置
      # - DEFAULT_SOURCES=[{"name":"示例源","url":"https://example.com/api.php/provide/vod"}]
      # - DEFAULT_LIVE_SOURCES=[{"name":"示例直播源","url":"https://example.com/list.m3u"}]
      # - DEFAULT_SUBSCRIPTIONS=["https://example.com/sources.json"]  # 预置订阅，自动导入点播源+直播源
      # - DEFAULT_RECOMMEND_SOURCE=douban  # 首页推荐数据源默认值（douban/bangumi/hot-list），仅对未主动选择过的用户生效
      # - LIVE_ALLOW_PRIVATE=1              # 自建内网 IPTV 源时开启
```

> 其余可选变量见下方[环境变量](#环境变量)表；仓库内的 `docker-compose.yml` 含完整注释版本（含 `build: .` 源码构建分支）。

```bash
docker compose pull && docker compose up -d
```

> ⚠️ **生产部署必须通过 HTTPS 访问**（localhost 除外）：生产模式下会话 cookie 带 `Secure` 标记，浏览器只在 HTTPS（或 localhost）下保存它。因此用 `http://服务器IP:端口` 访问时，会出现"密码正确却无法登录"的现象——登录请求实际成功，但 cookie 被浏览器丢弃。请通过反向代理（Nginx / Caddy / Traefik）或 Cloudflare 等为站点套上 TLS 后再对外提供服务；本地开发用 `localhost` 不受影响。

上游镜像发布在 GHCR 与 Docker Hub：`ghcr.io/librespark/libretv` 与 `docker.io/bestzwei/libretv`
（`latest` / `主.次` / 完整版本号三个 tag，`linux/amd64` 与 `linux/arm64` 双架构，
两个 registry 的镜像 digest 一致）。需要固定版本时在 `.env` 中设置
`LIBRETV_IMAGE=ghcr.io/librespark/libretv:2.0.1`。

> 版本号以 `package.json` 为单一来源，部署后可用 `/api/status` 返回的 `version` 字段核对。详见[部署文档](https://libretv.is-an.org/wiki/Deployment.html)。

### 手动运行

```bash
npm ci
PASSWORD=your-password npm run build
PASSWORD=your-password npm start   # 监听 8080
```

上面的环境变量写法适用于 POSIX shell；PowerShell 使用 `$env:PASSWORD` 等进程环境变量。Next.js/Node 命令不会因创建了 Workers 的 `.dev.vars` 而自动取得其中的值。

### 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `PASSWORD` | 是 | 访问密码；未设置时站点会提示管理员配置 |
| `PROXY_SECRET` | 建议显式设置 | 会话签名密钥；代码保留从 PASSWORD 派生的回退方式。Workers 部署配置已声明此 secret，应设置独立的长随机值 |
| `DEFAULT_SOURCES` | 否 | 预置采集站（JSON 数组），用户端自动出现且默认勾选，详见[配置文档](https://libretv.is-an.org/wiki/Configuration.html) |
| `REQUEST_TIMEOUT` | 否 | 代理上游请求超时（毫秒），默认 8000 |
| `MAX_RETRIES` | 否 | 代理请求重试次数，默认 1 |
| `SEARCH_MAX_PAGES` | 否 | 每个搜索源最多抓取的页数（1-50，默认 5）。第一页会读取源站 `pagecount`，实际页数 = min(源站总页数，该值)；页间并行请求，单页失败只丢该页 |
| `SEARCH_SOURCE_TIMEOUT_MS` | 否 | 单个搜索源的总死线（毫秒，3s-60s，默认 10000）：该源所有分页请求须在时限内完成，到点中断并将其标记为「超时」；健康度自动停用也以此为超时判定依据 |
| `USER_AGENT` | 否 | 代理请求使用的 UA（豆瓣封面防盗链等场景），默认 Chrome UA |
| `FALLBACK_CORS_PROXY` | 否 | 豆瓣推荐数据直连被拒时降级使用的 CORS 代理地址 |
| `COOKIE_SECURE` | 否 | 显式覆盖会话 cookie 的 `Secure` 标记（`true` / `false`）；默认按请求协议自动推导。反向代理未正确传递 `x-forwarded-proto` 导致 HTTPS 下登录失效时，设为 `true` 可解 |
| `60S_API_BASE` | 否 | 影视榜单推荐源（60s API）实例地址，默认 `https://60s.crystelf.top`；有限流，高频使用可[自部署](https://github.com/vikiboss/60s) |
| `DEFAULT_LIVE_SOURCES` | 否 | 预置直播源（M3U 订阅），JSON 数组：`[{"name":"源名","url":"https://.../list.m3u","epg":"https://.../epg.xml.gz"}]`，`epg` 为可选的 XMLTV 节目单地址 |
| `DEFAULT_SUBSCRIPTIONS` | 否 | 预置数据源订阅（LibreTV-SourceList JSON 链接，也接受 TVBOX 配置地址），JSON 数组：`["https://.../sources.json", {"url":"https://.../list.json","name":"名称"}]`。首次访问自动导入点播源与直播源，之后每 24h 静默刷新；用户删除后不再自动加回 |
| `DEFAULT_RECOMMEND_SOURCE` | 否 | 首页推荐数据源的默认值（`douban` / `bangumi` / `hot-list`，出厂默认 `hot-list`）；仅对未在设置中主动选择过的用户生效，用户的选择始终优先 |
| `LIVE_ALLOW_PRIVATE` | 否 | 传统自建 Node 内网 IPTV 场景的显式放行开关，默认关闭。Workers 适配没有开启它，不应用它绕过公网安全检查；开启也不会让公网 Worker 自动接入家庭局域网 |

EPG 与直播缓存新增的 `EPG_MAX_*`、`LIVE_CACHE_MAX_*` 变量、默认值和硬上限见前文表格。

## 使用说明

1. **添加点播源**：设置 → 源管理 → 点播源 → 添加 API，填入 Apple CMS 采集站地址（如 `https://example.com/api.php/provide/vod`），可选填详情页地址（部分源需要爬详情页提取播放地址）。
2. **搜索**：勾选点播源后输入片名；搜索通过服务端聚合，个别源失败不影响整体结果。
3. **播放**：详情弹窗选择剧集进入 `/watch`；支持快捷键（空格/←→/↑↓/F/Alt+←→）、移动端长按 3 倍速、自动连播、换源测速。观看/暂停时后续分片自动缓存到本地（设置可关），播放页可「下载本集」（TS/MP4）离线观看。
4. **进度与历史**：自动保存在本设备 IndexedDB，仅定位信息入库，播放时自动同步最新剧集。
5. **配置迁移**：设置 → 数据 → 配置导入导出（兼容旧版 LibreTV-Settings JSON 的历史记录迁移）。

## 直播 / IPTV

1. **添加直播源**：设置 → 源管理 → 直播源 → 填入 M3U/M3U8 地址（可选填 XMLTV 节目单地址），添加后自动探活并显示频道数量；也可在「源管理 → 数据源订阅」中与点播源一起订阅导入；部署者还可用 `DEFAULT_LIVE_SOURCES` 环境变量预置。
2. **观看**：进入「直播」页，按分组标签筛选或搜索频道，点击即播；支持 HLS（m3u8）与 HTTP-FLV 两种直播流，直连失败自动走代理通道重试。
3. **节目单**：频道带 `tvg-id` 且订阅配置了 EPG 地址时，展示当前/接下来节目与播放进度。
4. **收藏与导出**：频道可收藏；订阅可一键导出为标准 M3U 文件，供 PotPlayer / VLC 等外部播放器使用。

完整说明见 [直播 / IPTV 文档](https://libretv.is-an.org/wiki/Live-IPTV.html)。

> ⚠️ 项目不内置任何频道源，也不存储、不制作任何直播内容，仅提供第三方公开播放列表的解析与播放能力，内容的合法性由对应数据源负责。内网自建源默认被 SSRF 防护拦截；`LIVE_ALLOW_PRIVATE=1` 仅供明确需要内网访问的受控自建环境使用，Workers 适配未开启它。

## 数据源订阅 / 分享

数据源（点播源 + 直播源）可以 **导出为一份 JSON → 托管到公开 URL → 他人在「设置 → 源管理 → 数据源订阅」里填入该 URL 订阅**。

托管地址没有特殊要求，可用 [npoint.io](https://www.npoint.io/) 免费托管 JSON（粘贴内容即可得到一个公开 URL），Gist、对象存储、任意静态托管同样可用。

### 订阅格式（LibreTV-SourceList JSON）

```json
{
  "name": "我的源列表",
  "version": 2,
  "sources": [
    {
      "name": "示例点播源",
      "url": "https://example.com/api.php/provide/vod",
      "detail": "https://example.com",
      "isAdult": false
    }
  ],
  "liveSources": [
    {
      "name": "示例直播源",
      "url": "https://example.com/list.m3u",
      "epg": "https://example.com/epg.xml.gz"
    }
  ]
}
```

**字段说明**：

| 字段 | 位置 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `name` | 顶层 | string | 否 | 列表名称，订阅后显示在订阅条目上；缺省时显示订阅地址主机名 |
| `version` | 顶层 | number | 否 | 格式版本，当前为 `2`（新增 `liveSources`）；导入端目前忽略该字段 |
| `sources` | 顶层 | array | 否 | **点播源**数组（Apple CMS 采集站），最多 100 个，超出部分截断 |
| `sources[].name` | 项 | string | 否 | 源显示名；缺省时使用 URL 主机名 |
| `sources[].url` | 项 | string | **是** | Apple CMS 采集接口地址（公网 http/https），结尾 `/` 自动去除 |
| `sources[].detail` | 项 | string | 否 | 详情页根地址，用于列表接口拿不到播放地址、需要爬详情页提取 m3u8 的源 |
| `sources[].isAdult` | 项 | boolean | 否 | 成人内容标记，默认 `false`。标记为 `true` 的源名称旁显示 **(18+)** 徽章；设置中的「成人内容过滤」开启（默认开启）时该源不可勾选、不参与搜索，需先关闭过滤才能启用 |
| `liveSources` | 顶层 | array | 否 | **直播源**数组（M3U 播放列表），最多 50 个，超出部分截断 |
| `liveSources[].name` | 项 | string | 否 | 源显示名；缺省时使用 URL 主机名 |
| `liveSources[].url` | 项 | string | **是** | M3U 播放列表地址（http/https） |
| `liveSources[].epg` | 项 | string | 否 | XMLTV 节目单地址（`xml` / `xml.gz`），用于 `/live` 页展示节目单；地址非法时只丢弃该字段、保留整条源 |

**兼容与限制**：

- 只写 `sources` 的老订阅照常可用（纯点播），只写 `liveSources` 则是纯直播订阅；两者都缺时提示「订阅内容格式不正确」；裸数组 `[{ "name": "...", "url": "..." }]` 视为点播源；
- 按 `url` 去重（先到先得）；非 http(s) 地址会被过滤；**点播源**另需为公网地址（内网/回环/保留地址会被静默过滤），**直播源**在部署者设置 `LIVE_ALLOW_PRIVATE=1` 时可使用内网自建源地址；
- 订阅由**服务端**拉取（拉取前经过 SSRF 校验），因此订阅地址**无需配置 CORS**，Gist、对象存储、任意静态托管均可。

### 兼容 TVBOX 配置

订阅地址也可以直接填 **TVBOX 配置**（形如 `{"sites": [...], "lives": [...], "parses": [...]}`）：服务端按内容结构自动识别格式，无需手动选择。

- **点播源**：导入 `sites` 中 `type: 1` 的 JSON 接口（即 Apple CMS 采集站）；部分共享配置省略 `type` 或写成 `0`，但地址命中 `api.php/provide/vod` 时同样导入；站点自身标记 `searchable: 0`（不可搜索）时跳过；
- **直播源**：导入 `lives` 中 `type: 0`（或省略）的 M3U 播放列表，`epg` 字段一并带上；txt 频道列表与单仓 JSON 不支持；
- **Spider 类站点会跳过**：`type: 3` 的 Spider（`csp_*` / `.jar` / `.js` / `.py`）需要 TVBOX 自身的 Spider 引擎才能运行，Node 侧无法执行；XML 接口、外链 JSON 同理。被跳过的条目不影响其余导入，导入结果会如实提示，如「已同步 8 个点播源、2 个直播源（TVBOX 配置）；跳过 96 个不可用条目（Spider 引擎 92、XML 接口 4）」；
- TVBOX 配置常含上百条站点且以 Spider 为主，**只导入个位数到十几个属正常现象**；
- **格式容错**：配置里的 `//` 注释、尾随逗号、字符串内未转义的换行会自动修正后再解析（共享配置中很常见，TVBOX 客户端用的 fastjson 同样容忍这些写法）；
- 其他限制：订阅地址需直接返回 JSON（Base64 / 压缩包装的分享链接不支持）；TVBOX「多仓」配置（顶层为 `urls` 数组）不支持，请填单仓配置；地址公网校验、去重与数量上限与上方格式完全一致。

### 订阅行为

- **订阅**：设置 → 源管理 → 数据源订阅 → 填入订阅地址 → 「订阅」，导入的点播源自动勾选、直播源自动启用，均带「订阅」标识，条目上显示「点播 N · 直播 M」；
- **同步**：订阅条目上的 **⟳** 手动强制同步，整体替换该订阅名下的点播源与直播源；
- **管理边界**：订阅源以远端列表为准，单独编辑会在下次同步时被覆盖，单独移除会在重新同步时恢复；如需调整请改远端列表，或直接删除整个订阅。删除订阅时点播源全部移除；直播源为**多归属共享**——同一 M3U 可被多个订阅引用（名称/EPG 以首次导入为准），删除订阅或远端列表中移除该源后再同步，都只摘除本订阅的引用，仅当不再被任何订阅引用时才移除该源，手动添加的源不受同步影响，**收藏的频道始终保留**；
- **导出分享**：设置 → 源管理 → 数据源订阅 → 「导出数据源」，把当前全部点播源与直播源（预置 + 手动 + 订阅，按 URL 去重）导出为上述 JSON；也可用「发布为链接」，把当前**已勾选启用**的源一键上传到公开粘贴板（paste.rs，失败自动降级 0x0.st），直接返回可填入订阅框的 URL，无需自备托管。注意：发布的内容**公开可读**，且每次发布生成新链接、不支持覆盖更新，需长期稳定请用导出 + 自行托管。

> 订阅由服务端拉取（经过 SSRF 校验），因此订阅地址无需配置 CORS。完整说明见 [数据源文档](https://libretv.is-an.org/wiki/Data-Sources.html)。

## 开发

```bash
npm ci
PASSWORD=dev-password npm run dev   # http://localhost:8080
npm test                            # 单元测试，包含 DNS / 鉴权 / EPG 边界
npm run typecheck
```

这是保留的 Next.js 开发路径。Workers 开发、生产产物预览和集成回归使用前文的 vinext 命令。上游开发约定见 [开发文档](https://libretv.is-an.org/wiki/Development.html)。

## 版本与发布边界

应用版本以 `package.json` 为单一来源，`/api/status` 返回相应的 `version`。当前 V2.0 适配仍使用应用版本 `2.16.12`，更新 README 或默认源不需要更改它。

本 fork 的 Workers 自动更新监听 `V2.0` 分支，由 Cloudflare Workers Builds 执行，与上游的容器发布流程分开。

仓库保留了上游 Docker Actions，其中发布任务可由 `v*` tag 或手动触发，且含上游 Docker Hub 目标。它们不是本分支已验证的 Workers 发布流程；不要为了更新 Worker 而运行 `npm version`、推送 tag 或触发镜像同步。

## 安全说明

- 服务端从运行时环境读取密码与签名密钥；登录成功后浏览器保存带 HMAC 签名的 HttpOnly Cookie。HttpOnly 限制页面脚本读取，不代表会话凭证泄漏后无法被重放。
- 登录接口保留每 IP 10 次 / 10 分钟限制，最多 4096 条记录；仅在当前实例内有效，不是跨实例全局防暴力破解方案。
- 默认代理安全检查仅放行公网 http(s)，拒绝私网、保留地址和无法验证的 DNS 结果，并逐跳检查重定向；DNS 预检查与实际连接之间仍有重绑定风险。
- 通用代理对指定的公开图片域名保留匿名访问例外，其他目标需要登录；不要把本服务视为可任意开放的公共代理。
- EPG 的输入、解压、解析、缓存和并发均有边界，但没有完成整个应用的生产容量认证。依赖公告和供应商预打包代码需要持续跟踪。

## 衍生作品

| 项目 | 说明 |
| --- | --- |
| [OrionTV](https://github.com/orion-lib/OrionTV) | Apple TV / Android TV 客户端（React Native TVOS + Expo），配合 MoonTV 使用 |
| [LunaTV](https://github.com/MoonTechLab/LunaTV) | 影视聚合站（Next.js），支持 Redis / Upstash 等多存储后端 |
| [Selene-TV](https://github.com/MoonTechLab/Selene-TV) | Android TV（Leanback）客户端，Kotlin + Compose，对接 MoonTV / Helios |
| [EchoTV](https://github.com/hoowhoami/EchoTV) | Flutter 全平台客户端（已归档） |
| [WarHutTV](https://github.com/OuOumm/WarHutTV) | Go + React 的自托管影视聚合站 |
| [DecoTV](https://github.com/Decohererk/DecoTV) | 聚合播放站（原 KatelyaTV） |
| [Joyflix](https://github.com/jeffernn/Joyflix-Mac-Objective-C) | macOS 原生影视聚合客户端（Objective-C） |
| [MoonCakeTV](https://github.com/MoonCakeTV/MoonCakeTV) | 影视聚合搜索站（Next.js），文件存储、一键脚本部署 |
| [OrangeTV](https://github.com/djteang/OrangeTV) | 跨平台影视聚合播放器（Next.js），Kvrocks/Redis/Upstash 多存储与多端同步 |

> 旧版 LibreTV（静态 HTML + Express）完整代码见 [backup-2025 分支](https://github.com/LibreSpark/LibreTV/tree/backup-2025)。

## 免责声明

本项目不存储、不制作任何视频内容，仅提供第三方公开接口的聚合与播放能力，内容的合法性由对应数据源负责。

本分支保留上游的 AGPL-3.0-or-later 许可证。感谢上游作者与贡献者；如需支持上游，可访问其 [AFDIAN 页面](https://afdian.com/a/veehub)。
