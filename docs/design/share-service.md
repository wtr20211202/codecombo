# 文件分享子服务（share）设计记录

> 2026-09 新增功能。目标：把项目内任意文件/目录变成可分享的短链，访客经
> 独立端口子服务在线预览（md/pdf/图片/文本/音视频）或下载，管理面可随时撤销。

## 1. 需求 → 机制映射

| 需求 | 机制 |
|---|---|
| 独立端口子服务 | kernel 模块 `share` 在 Start 拉起独立 `http.Server`（默认主端口+2，`sharePort` 可配），启动失败降级告警不阻断主服务 |
| md/pdf/doc/docx 等预览 + 可扩展 | `server/share/preview` 注册表：后缀 → Descriptor{Kind,MIME}；`Register()` 一行即扩展；未注册后缀回退信息卡。docx 直解（stdlib zip+xml 抽标题/列表/表格/粗斜体 → 净化 HTML，注入面为零）；doc 老格式 doc2txt best-effort（失败降级错误卡 + 下载）；html/htm sandbox iframe 呈现 raw（脚本被 iframe sandbox + CSP sandbox 双层拦死，相对资源不解析） |
| 任意格式/目录可分享 | 信息卡兜底（名称/大小/修改时间 + 下载）；目录分享递归浏览 + zip 打包下载 |
| 短链稳定（同目标恒同链） | token = HMAC-SHA256(masterKey, projectID\x00path) 截 base36 16 位，确定性派生 |
| 同名隔离 | projectID + 全路径入 HMAC；不同项目/层级同名文件 token 互异 |
| token 不可预测 | pepper 为部署级 master-key（`config.MasterKey()`，随 data 目录持久化，跨重启稳定） |
| 管理/撤销 | `/api/share`（List/Create/Delete/Status）；撤销即删记录，短链立即 404 |
| 不存在的短链友好提示 | 形态门禁 + 查库，未命中返回内嵌双语 404 页（非 JSON 堆栈） |
| 预览时下载 | 每页头部常驻下载按钮；文件=原名附件（ServeContent 支持 Range）；目录=流式 zip |
| 界面美观 | 分享页内嵌单文件 HTML（细顶栏 reader 形态、CSS 变量、prefers-color-scheme 自适应、双语 Accept-Language；单文件无卡片、目录全宽表格（固定列宽，行内动作窄屏可达），≤700px 动作收进「⋯」菜单）；管理视图 brand-gradient 横幅 + 数据表 |
| 链接发出去能打开（P-20261020-2） | 主应用同源代理 `/s/*` 与访客页三个 vendored 资产（`server/share/gateway.go`），分享 URL 统一为 `<base>/s/<token>`；可选 `sharePublicBaseUrl` 指定外发基址；前端地址计划（`web/src/utils/shareAddress.ts`）按「分享基址 > 外部访问地址 > 当前非回环地址 > 局域网候选 > 旧 host:sharePort」选址并给三色可达性徽标 |

## 2. 分层与扩展点

```
server/store/share.go        ShareStore（docstore 仓储，幂等 get-or-create）
server/share/preview/        预览能力注册表（唯一判定源，运行期可覆盖注册）
server/share/service.go      访客面：路由/路径安全/meta/list/render/raw/download
server/share/gateway.go      同源入口（P-20261020-2）：Handler 发布/收回 + 访客 IP 上下文注入
server/share/render.go       gomarkdown 渲染 + bluemonday 净化
server/share/page.go         内嵌分享页/404 页（零外部依赖）
server/share/zip.go          目录流式打包
server/api/share/            kernel Module（监听生命周期）+ gin 管理接口 + store 适配
server/api/router.go         /s/* 与三个 vendored 资产同源直通（锁/令牌中间件之前）
web/src/api/domains/share.ts 前端域 API + 统一地址计划取数（fetchShareAddressExtras/resolveShareAddressPlan）
web/src/utils/shareAddress.ts 分享地址计划纯函数（复用 networkAddress 的回环/私网判定与三态语义）
web/src/components/share/    分享结果卡 + ShareReachBadge（useShareDialog 单例状态）
web/src/views/share/         分享管理主区视图（usePanelLayout 第三主区视图）
```

- 扩展新预览类型：`preview.Register(ext, Descriptor)` + 分享页对应 Kind 渲染
  分支（页面分支集中且带默认兜底）；未来接 docx 转换器 = 覆盖注册 docx 即可。
- 子服务面向接口（ShareLookup/ProjectRoots），管理面经 store 适配注入——
  server/share 不反向依赖 api 层，模块装配走组合根 `runtimeInfo` 声明式注入
  TLS 结果（CLI 覆盖只存在于组合根）。
- 状态上报遵循 loopbackPort 同款 atomic 模式（`config.SetSharePort/RuntimeSharePort`）。

## 3. 安全设计

- **路径逃逸**：访客与管理路径统一 `NormalizeRelPath`（逐段栈式归一，越过
  分享根即拒绝、不钳制改写）；实际文件访问全部经 `os.Root` 作用域（兜底拒绝
  `..` 与逃逸符号链接）。分享基路径 = share.Path（能力边界），非项目根。
- **内容不可信**：raw/render 响应带 `Content-Security-Policy: sandbox` +
  `nosniff`；markdown 服务端渲染后过 bluemonday UGC 白名单（script/事件属性
  剥离，target 仅允许 `_blank`）；页面以 `sandbox` iframe 呈现 md/html 类内容；
  html/htm 经 iframe sandbox（无 allow-scripts）+ CSP sandbox 双层拦死脚本后
  以 raw 呈现（预览为文档本体，相对资源不解析，下载永远可用）；docx/doc 解析
  路径的 HTML 由解析器全量生成、文本逐一转义，注入面为零（zip 解压侧另有
  64MB 上限防炸弹）；页面自身字符串全部 textContent 注入，不拼 HTML。
- **token 能力语义**：16 位 base36 ≈ 80 bit 熵 + HMAC 派生，枚举不可行；
  撤销即失效。已知权衡：确定性派生意味着"撤销后再分享同一路径会恢复同一
  token"——这是"同目标短链恒定"需求的直接推论，若需"换链"可在派生入参加入
  世代号（记录于 store，当前未启用）。
- 无凭据字面量；子服务不发起任何出站请求（Mimosa SSRF 约束天然满足）。

## 3.1 分享链接地址与同源入口（P-20261020-2）

**问题**：改造前 `buildShareUrl` 只取 `window.location.hostname` + sharePort，
分享子服务又绑定 `server.host`（默认 127.0.0.1）。localhost 打开的链接发给同事
必死；反代/内置 SSH 隧道通常只转发主端口，sharePort 不可达；改 sharePort 还会
让所有已分发链接失效。

**同源入口（阶段 B）**：主引擎在 `api` 组（`LockMiddleware`/`TokenAuthMiddleware`）
之前注册 `GET/POST /s/*path` 与三个精确资产名 `/assets/{xterm.js,addon-fit.js,xterm.css}`
（`server/api/router.go` 的 `serveShareSameOrigin`），把请求进程内直通
`server/share` 包的 `Service.Handler()`：

- 匿名边界与独立端口子服务一致：分享 token（+ 可选口令门）是唯一门禁，
  锁定态不挡访客打开链接；`/api/share` 管理面仍在 api 组内，不新增 agent 权限面。
- 不整段代理 `/assets/*`（主应用 Vite 产物同住该前缀），资产名白名单单一事实源
  `share.AssetNames()`。
- 分享服务自身的口令门、CSP/no-store/X-Frame-Options、SSE 语义全部保留；
  主应用的 CSP Report-Only 观察头在同源入口剥除（访客页内联脚本会批量误报）。
- 分享服务未就绪时返回 503，不落 SPA index。
- 访客审计 IP 与口令门限流按主应用 `server.trustedProxies` 解析（P-20261020-1），
  经请求上下文注入 `server/share/clientIPOf`；独立端口直连形态仍只信 RemoteAddr。

**地址计划（阶段 A）**：`web/src/utils/shareAddress.ts` 是结果卡、分享管理器
复制/打开、行内二维码、直播邀请通知的唯一 URL 计算入口：

1. `settings.sharePublicBaseUrl`（新键，仅 http/https origin，空=不启用）；
2. `settings.externalAccessUrl`；
3. 当前页面非回环 origin（局域网/公网）；
4. 回环入口 → `/api/system/network` 局域网候选首项（仍标红：不能保证对端同网）；
5. 无可达基址 → 旧格式 `当前 host:sharePort`（标红「仅本机可达」）。

前四类拼 `<base>/s/<token>`，只有第 5 类依赖第二端口。徽标三色沿用二维码接力
语义（红=本机/不可达、黄=需同网络、绿=任意网络），文案按基址来源细分并给
处置指引。二维码与复制值逐字节同源（`ShareManagerView.urlOf`）。

**兼容性**：`sharePublicBaseUrl` 缺省空 = 存量行为零变化；旧格式 `host:sharePort`
短链继续可用（独立端口监听未移除），不迁移数据、不引入短链重定向。

## 4. 性能

- 文件内容实时读自项目目录（不复制不落库）；meta/list 每次 `os.OpenRoot` +
  一次 stat，开销为单目录打开量级。
- zip 打包流式写出（无临时盘），`WriteTimeout=0` 保证慢客户端大包不被截断；
  raw 走 ServeContent（Range/断点/视频拖动）。
- 前端入口全部懒挂载（ShareManagerView v-if 保活、结果卡单例），主 bundle
  增量仅为注册表一行 + 图标。

## 5. 测试与验证

- 后端：`server/store/share_test.go`（派生稳定性/同名隔离/幂等/撤销）、
  `server/share/preview/preview_test.go`（内置表/运行期扩展）、
  `server/share/service_test.go`（友好 404/meta/子目录列表/分享根越界拒绝/
  raw MIME/CSP/markdown 净化/单文件与目录 zip 下载/目标消失 404/项目消失 410）、
  `server/api/share/module_test.go`（监听起停/状态上报/端口回写/同源 Handler
  发布与收回）、`server/share/gateway_test.go`（Handler 发布/资产白名单/访客
  IP 注入优先于 RemoteAddr/口令门限流同口径/X-Frame-Options）、
  `server/api/router_share_gateway_test.go`（同源路由匿名可达、503、响应头、
  主应用 CSP 剥除、`/assets/*` 非白名单不吞、可信代理 XFF 注入）、
  `server/api/system/sharepublicbase_settings_test.go`（设置键校验/归一/清除/省略）。
- 前端单测：`web/src/utils/shareAddress.test.ts`（回环/局域网/外部/无候选/
  旧端口回退/服务未就绪 + 三色映射）。
- e2e：`web/e2e/specs/share.spec.ts`（管理 API 幂等/撤销 + 访客页/404 +
  UI 右键分享→结果卡→管理视图→撤销确认）、`share-reader-layout.spec.ts`
  （无卡片 reader/边到边 iframe/390·360·320 顶栏不溢出/菜单可达/导出图片）、
  `share-reach.spec.ts`（三色徽标、同源复制/二维码/打开一致、主 origin 下
  /s/ 与访客资产可达）。
- 既有失败说明：`regression-probe.spec.ts:303`（diff 面板 Monaco 右键菜单）
  在**不含本功能的基线构建上同样失败**（stash 验证），为环境性既有问题，
  与本功能无关。
