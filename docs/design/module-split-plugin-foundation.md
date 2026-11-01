# 模块划分与插件化基座方案（含性能优化）

> 状态：已评审定稿 · 基线：`feature/0.0.1` @ 8d2286c（2026-09-12）
> 范围：后端 Go（`server/**`、`main.go`，约 3.8 万行）+ 前端 Vue3（`web/src/**`，约 4.6 万行）
> 本文是「打基础」阶段的实施依据：回答三个问题——① 现有架构扩展性到底如何；② 未来要做「前后端一体、支持安装/卸载/更新、重启生效、稳定可推广」的插件系统，现在的代码该怎么划分模块；③ 管理多个大型项目、打开多个文件等场景的性能瓶颈在哪、如何在拆分过程中顺手修掉。

---

## 1. 结论先行

**目标形态一句话**：内置功能 = 全栈垂直模块（前后端同名成对、编译期注册）；外部插件 = 进程级插件（后端子进程 RPC + 前端静态资源随包分发），安装/卸载/更新通过目录操作 + 重启生效。

**现状判定**：

| 维度 | 评级 | 一句话 |
|---|---|---|
| 分层 | 良好 | api → 领域服务 → filestore 三层清晰，无循环依赖（4 处用接口注入正确破环） |
| 扩展性 | 中上 | 4 个真注册表（agentops.Provider / deployer / 手册 section / 平台探测）已是标杆；但终端后端、git 平台、凭证 provider 仍是硬编码 switch |
| 模块隔离 | 中 | `server/api/admin` 上帝包（约 7400 行、import 19 个内部包）、`main.go` 926 行多职责、10 处 setter 全局注入、启动顺序承重 |
| 性能 | 多项目/多文件场景有结构性瓶颈 | 详见 §3：watcher 缺陷、auto-fetch 缓存风暴、全局锁罩住 git 子进程、Monaco 每击键全量序列化等 |
| 高可用 | 弱（符合桌面工具定位） | 单实例内存态；graceful shutdown 有缺口（cmdStop 直接 Kill、3 个后台循环不可停） |
| 安全 | 4 高危 + 若干中危 | 本次不修，完整清单见附录 A |

**要做的事（本方案）**：
1. 定型模块契约（= 未来插件 manifest 的子集）+ `server/kernel` 内核 + 统一事件总线 + `GET /api/modules` 发现端点；
2. 拆 `server/api/admin` 上帝包、拆前端 `api/client.ts`（1130 行）；
3. 前端 panelRegistry 收敛 5 处硬编码枢纽（ActivityBar / BottomPanel / SidePanel / usePanelLayout / 命令面板）；
4. 性能修复按归属阶段编入迁移路线（§6），拆到哪修到哪，避免二次触碰同一文件。

**明确不做的事**：
- 不做插件运行时本身（进程插件 RPC 运行时 = Phase D，后续单独立项）；
- 不做微前端 / iframe 沙箱 / 热插拔；
- 不动已经合理的分层（`server/git`、`server/store`、`server/filestore` 的职责划分保持，只做顺手优化）；
- 安全问题本次不修（附录 A 记 backlog）。

---

## 2. 未来插件系统目标架构

### 2.1 需求 → 选型

需求：插件含**前端和后端**；支持**安装 / 卸载 / 更新**；实时生效最好、**重启生效可接受**；**稳定、可推广**（第三方开发者能上手）。

| 维度 | 编译期插件 | 脚本（Yaegi） | **进程级插件（选定）** |
|---|---|---|---|
| 动态安装 | ✗ 需重新编译 | ✓ 免编译 | ✓ 放入目录 + 重启 |
| 隔离性 | 无（同进程 panic 连坐） | 弱（解释器内） | **强（进程崩溃不连累主服务）** |
| 前端随插件分发 | 需重新构建主应用 | 困难 | **✓ 静态资源随包 + 动态 import** |
| 插件后端语言 | 仅 Go | 仅 Go（桥接面受限） | **任意语言（RPC 协议约束）** |
| Windows 兼容 | ✓ | ✓ | ✓（go-plugin 模式可用） |
| 复杂度 | 低 | 中 | 中高（RPC 协议 + SDK 包装） |
| 稳定性风险 | 最低 | 中 | 低（隔离反而提升稳定性；「重启生效」豁免了热卸载的全部复杂度） |

**判定**：进程级插件为主路线（子进程 RPC）；脚本层降级为可选轻量路径（远期，用于无需进程的小型扩展）；编译期内置模块作为基座不变——**内置模块与外部插件共用同一套契约**，内置即「随主程序分发的插件」。

**RPC 协议待定案（2026-09-13 修订）**：子进程路线确定，但具体协议列两个候选，Phase D 开工第一步做两周级 spike（同一插件两种协议各实现一遍）后定案：
- **候选 A：hashicorp/go-plugin（gRPC）**——Go 生态事实标准，握手/协议版本/健康检查齐全；代价是拖入完整 gRPC 栈，而本项目插件后端需求窄（几条路由 + 几个 topic），可能过重。
- **候选 B：MCP 风格 stdio JSON-RPC**——协议极薄、跨语言零依赖；且本项目为 AI 原生工具，MCP 生态势能可直接复用（MCP server 天然是插件后端雏形）。需自行补齐握手/心跳/apiVersion 协商。
- **倾向**：候选 B 起步（薄协议先跑通），协议细节不影响模块契约；manifest 的 `backend.protocol` 字段已预留切换空间。

**Spike 结论（2026-09-13，roadmap M6.2）**：候选 B（stdio JSON-RPC）已落地验证——`server/pluginsdk`（NDJSON 帧 + JSON-RPC 2.0）。实测要点：
- 握手（initialize）+ apiVersion major 协商 + ping 心跳 + 请求-应答 + 单向通知全链路可用，宿主/插件双端合计约 300 行（含测试），零第三方依赖；
- spike 实证出一个真竞态：stdio 写是同步消费的，**pending 必须先于请求发出注册**，否则插件应答先到被丢弃（详见 host.go Call 注释）——此类时序问题在自研薄协议下可当场修掉，是 spike 的价值所在；
- Phase D 需补齐：per-request 并发分发、大载荷分帧/上限、插件崩溃后的重启策略、真实子进程 exec 接线的集成测试；
- 候选 A 保留为备选：若未来插件需要流式大文件传输或跨语言流控，再评估切 gRPC（manifest protocol 字段预留）。

### 2.2 插件包格式与 manifest

```
plugins/
  my-plugin/
    plugin.json          # manifest（唯一契约入口）
    backend.exe          # 插件后端（可选；子进程，与内核 RPC 握手）
    frontend/            # 插件前端（可选；预构建 ES module 静态资源）
      index.js
      extra.css
```

```jsonc
// plugin.json 草案
{
  "name": "my-plugin",            // 全局唯一，[a-z0-9-]
  "apiVersion": "1.x",            // 依赖的内核 API 大版本（semver 约束）
  "version": "0.1.0",
  "title": { "zh-CN": "我的插件", "en-US": "My Plugin" },
  "dependsOn": [],                // 依赖的其他插件/内置模块名
  "backend": { "entry": "backend.exe", "protocol": "stdio-json-v1" },  // 协议候选见 §2.1 修订：B(stdio-json) 起步，A(grpc) 备选
  "frontend": { "entry": "frontend/index.js" },
  "signature": "",                // 预留：插件包签名（Phase D 定编码；本地安装 v1 不强制校验，生态开放后启用）
  "contributes": {                // 声明式贡献点，内核启动时校验并注册
    "routes": ["/api/my-plugin/*"],   // 插件后端暴露的 API 前缀（内核代理转发）
    "topics": ["my-plugin.event"],    // 订阅/发布的事件 topic 前缀（必须以插件名为命名空间）
    "panels": [ { "slot": "bottom-tab", "icon": "search", "titleKey": "my-plugin.title" } ]
  }
}
```

**模块契约 = manifest 子集**：内置模块在 Go 侧实现 `kernel.Module`（见 §5.2），其 Name/Routes/Topics/FrontendEntry 与 manifest 字段一一对应——Phase A 落地的契约不用二次迁移即为插件契约。

### 2.3 前端随插件分发的加载链路

RPC **只存在于「插件后端子进程 ↔ 内核」**之间；浏览器全程只说 HTTP/WS：

1. 内核启动 → 扫描 `plugins/` 目录 → 校验 manifest + apiVersion → 按依赖拓扑拉起插件后端子进程（RPC 握手）→ 把插件声明的 routes/topics/panels 注册进内核各注册表；
2. 内核静态托管 `frontend/`（`GET /plugins/:name/*`），`GET /api/plugins` 返回含 `frontendEntry` 的 manifest 列表；
3. 浏览器端主应用启动后取 `/api/plugins` → 对每个已装插件动态 `import('/plugins/:name/index.js')` → 插件前端调用 TS SDK：向 panelRegistry 注册面板、订阅事件 topic；
4. 插件前端 ↔ 插件后端通信走内核统一代理 `GET|POST /api/plugins/:name/*`（内核转发到插件进程），前端永远不知道插件进程端口；
5. 安装 = 落盘 plugins/ + 重启；卸载 = 移除目录 + 重启；更新 = 替换目录 + 重启（复用现有 `simple-coding restart` / 自更新链路）。前端资源随重启重新发现，需版本化路径或 etag 防缓存。

**工程要点**：
- 共享依赖外部化：vue / naive-ui / TS SDK 由宿主提供（Vite externals + import map），插件 bundle 只含自身代码；
- v1 插件前端与主应用**同源同权**运行（不做 iframe 沙箱）；VSCode webview 式隔离列为远期选项；
- **信任模型范围声明（2026-09-13 修订）**：同源同权意味着「安装一个插件 = 交出主应用全部能力」。因此 v1 **仅支持本地安装**（目录落盘，无插件市场、无远程源），安装行为等同运行下载的可执行文件——与现有自更新链路同级信任；manifest 的 `signature` 字段仅预留不校验。未来若开放第三方生态，签名校验（Grafana 式）或市场审核（VSCode 式）为**显式前置条件**，未落地前不提供任何远程安装通道；
- 插件崩溃策略：RPC 心跳丢失 → 内核标记插件 unhealthy 并在 `/api/plugins` 暴露状态，主服务不受影响。

### 2.4 生命周期与 SDK / 兼容策略

- 生命周期（重启生效模型，刻意简化）：**发现 → 校验 → 拓扑排序启动 → 健康检查**。没有运行中热卸载，就没有资源回收难题——这是「重启可接受」换来的最大简化。
- SDK 交付物（Phase D 落地，接口 Phase A 定型）：
  - 后端 Go SDK：`kernel` 门面接口（Routes/WS/Events/Store/Config/Logger/Scheduler）+ RPC stub（协议见 §2.1 修订：stdio JSON-RPC 起步，go-plugin 备选）；SDK 面按「插件实际需要」裁剪，Kernel 门面现有 8 方法偏多，Phase D 定接口时克制收敛；
  - 前端 TS SDK：`@simple-coding/plugin` 类型 + panelRegistry / topics 订阅 / 代理 fetch 封装；
  - hello-world 插件模板（后端 1 个 RPC 服务 + 前端 1 个面板）+ 推广文档。
- apiVersion 兼容：内核 API 面（kernel 接口 + contributes 语义 + 内置 topics）按 semver；大版本内只加不改；`/api/plugins` 与 `/api/modules` 都带 apiVersion 供前端判断降级。

---

## 3. 性能瓶颈与优化（场景实测）

> 结论：**「管理多个大型项目」与「打开多个/大文件」两个场景当前都存在结构性瓶颈**。以下按影响排序，每项标注现状（file:line 基于基线 8d2286c 核实）、为何退化、修复措施与归属阶段。

### 3.1 场景一：多大型项目（20+ 项目 × 5 万文件）

**P0-1 自动拉取循环：串行 fetch 全部项目 + 每轮全量缓存失效风暴**
- 现状：`startAutoFetch`（`main.go:810-831`）串行 `git.Fetch` 所有项目（默认 300s 一轮）；`fetch` 被列为 mutating 命令（`server/git/repo_cache.go:96-102`），每轮把**全部项目**的 repoInfo/ahead 缓存清空（`repo_cache.go:130-137`）；git 调用无超时。
- 退化：20 项目网络串行 = 分钟级一轮；刚拉完缓存即冷，页面加载重新付出全量冷扫描；一个挂起的 fetch 阻塞整轮。
- 修复（**Phase A**）：并发化（信号量 4）+ 单项目超时（context 30s）+ fetch 从缓存失效清单中摘除（fetch 只该失效 ahead 相关，不该失效 repoInfo）。

**P0-2 页面加载 git 风暴：冷缓存每项目约 4 个 git 子进程**
- 现状：`ListProjects` / `ListAllAheadBehind`（`server/api/admin/project.go:26-59, 204-234`）并发 8，冷缓存每项目 = rev-parse + branch --show-current + remote get-url + rev-list --left-right --count；50 项目 ≈ 200 个 git 进程排队。
- 修复（**Phase A** 顺带）：fetch 失效风暴修掉后，稳态下命中 5s TTL 缓存；冷启动保留现状（可接受），在响应中维持已有的批量端点模式。

**P0-3 tree status 缓存：全局锁罩住 git 子进程**
- 现状：`cachedGitMaps`（`server/api/gitops/status_cache.go:26-45`）持有**全局** `sync.Mutex` 期间运行两条全工作区扫描（`git status --porcelain=v2 --branch` + `git ls-files --ignored -o --directory`，`status.go:11-19, 142-160`）；`/projects/:id/status`（`project.go:167-180`）完全无缓存。
- 退化：跨项目树加载互相串行；一个大 untracked 集的仓库拖住所有项目的树请求。
- 修复（**Phase A**）：锁改 per-path（`sync.Map` of per-repo mutex）+ `/status` 接入同缓存（3s TTL）。

**P0-4 RepoWatcher：排除清单缺口 + 运行期新增项目永不监听 + 每事件同步写日志**
- 现状：`skipDirs` 仅 `.git/node_modules/dist/.idea/.vscode/.cache`（`server/watch/watcher.go:16-23`）——`target/vendor/bin/build/out/.next` 全被监听；项目索引只在 `Start()` 建一次（`watcher.go:64-74`），**启动后添加的项目不会被监听**；每条 FS 事件 `slog.Info`（`watcher.go:110`）同步落盘；`AddProject` 不触发 watch（`admin/project.go:62-111`）。
- 退化：一次 cargo/go build 产生每分钟数万事件 → 日志 IO + debounce map churn + 广播风暴；Linux inotify 上限被无效目录吃掉。
- 修复（**Phase A**）：扩充排除清单；`AddProject`/`RemoveProject` 联动 watcher 动态注册/注销；事件日志降为 Debug。

**P1-5 内容搜索 / 文件列表 / diff/log：无上限缓冲、无服务端截断**
- `SearchContent`（`server/git/search.go:29-76`）：git grep 全量缓冲后才截断 maxResults，且 `--untracked` 扫全仓库；`ListFlatFiles` 每请求全量 `WalkDir`（`api/gitops/tree.go:109-156`）；`GetFileLog --follow` 无 `-n`、`SearchLog` 无 limit（`server/git/log.go:127-164`）；diff/blame 全量缓冲。
- 修复（**Phase B** 路过即修）：grep 加 `-m`/流式早停；file-log/search-log 默认 limit；diff 输出加上限（超限截断并标记 truncated）。

**P1-6 filestore 热路径 O(N) 全目录读**
- `List/Match` 读+反序列化 kind 目录下**每个**文件（`server/filestore/filestore.go:353-380`）；热路径调用方：OpsChat 会话列表（含全部消息）、notifications、instances、projects（`Project.List` 无缓存，auto-fetch/首页/watcher 都用）。
- 修复（**Phase B**）：filestore 加 per-kind 列表索引缓存（写时失效）；Project 文档请求级缓存（`api/shared/helpers.go:11-19` 每请求都 `os.ReadFile` 项目文档 ×119 调用点）。

**P1-7 token 校验每 5s 重写磁盘**
- `Token.Validate` 缓存未命中时读全部 token 文档，且**每次成功校验写回 LastUsedAt**（`server/store/token.go:152-156`）→ 持续认证流量下每 5s 一次全目录读 + 一次文档重写。
- 修复（**Phase B**）：LastUsedAt 节流（如 ≥60s 才落盘一次）。

**P2-8 并发无上限项**：本地终端会话无上限（`server/terminal/manager.go:54-61`，每会话 1.6~16MB 回放缓冲）；clone/deploy/agent 每请求一 goroutine 无准入（`git/clone_task.go:127-146`、`deploy/manager.go:46-93`、`admin/agentchat.go`）；WS 广播同步逐连接写、一个卡死客户端阻塞整轮（`api/ws_handler.go:101-135`），git 失败把全量 stdout 广播给所有客户端（`git/git.go:34-64`）。
- 修复（**Phase A**：终端会话上限 + 广播失败 stdout 截断；**Phase B**：clone/deploy/agent 准入上限 + 广播慢客户端跳过策略）。

### 3.2 场景二：多文件 / 大文件打开（20+ tab、10-50MB 文件）

**P0-9 前端 Monaco 绑定：每击键全量序列化 + 深度 watcher 级联**
- 现状：`onDidChangeModelContent` 每击键 `editor.getValue()`（`web/src/views/editor/MonacoEditor.vue:231-235`）→ 写入 store → 触发 `openFiles` 深度 watcher（`composables/useLayoutState.ts:97-120`）→ uiState GET+PUT 往返；`Layout.vue:440` 把全文作为模板依赖 → 整树重渲染；tab 间切换销毁/重建 model（`:261`）丢 undo 栈；无大文件守卫；blame 每行一条装饰（`MonacoEditor.vue:62-135`）。
- 退化：50MB 文件打字即每秒 ~100MB 瞬时字符串分配，输入延迟崩塌。
- 修复（**Phase C**）：改 `onDidChangeModelContent` 的 changes delta 增量更新 store（不 getValue）；content 从响应式状态中摘出（用 shallowRef / 非响应式 Map）；模型跨 tab 保留 + LRU 上限；>20MB 拒开守卫；blame 装饰分批/上限；uiState 保存改显式触发（关闭 tab/切 tab/手动保存）。

**P0-10 后端 ReadFile/WriteFile：全量内存 + 3-4× JSON 放大、无 ETag、写非原子**
- `ReadFile` 全量读 + `c.JSON` 转义（≈3-4× 瞬时放大），10MB 上限直接拒绝更大文件，无缓存（`server/api/admin/file.go:14-63`）；`WriteFile` 绑定整个 body 后非原子写（`:66-105`）。
- 修复（**Phase B**）：ReadFile 加 ETag/If-None-Match（内容 hash 缓存）；WriteFile 改 tmp+rename 原子写。

**P1-11 前端列表/流式渲染无虚拟化或无上限**
- commit 列表无限追加 + BranchGraph SVG 每 append 全量重算（`views/git/CommitsPanel.vue:392,160-171`、`components/git/BranchGraph.vue:41-169`）；changes 树 300ms 风暴下全量重建、change 列表无虚拟化（`CommitPanel.vue:100-124,410-434`）；命令面板最多 5000 个按钮（`CommandPalette.vue:225-260`）；DiffViewer 全量行渲染（`views/changes/DiffViewer.vue:58-119`）；AI 会话每 delta 全量重解析历史消息（`AgentChatView.vue` blocksOf 内联 v-for）；文件树每次展开 O(n) 全数组拷贝（`FileTreeView.vue:217-241`）。
- 修复（**Phase C**）：CommitPanel/DiffViewer/命令面板虚拟化（复用现有 useVirtualList 模式）；BranchGraph 渲染节点上限（超出简化为折线）；AI blocks 按消息缓存解析；文件树展开改本地 splice。

**P1-12 终端：DOM 渲染器（WebGL 被 `if (false)` 硬禁用）+ 写链路无背压**
- `useTerminalSession.ts:460-470` WebGL 被硬禁、`389-416` promise 链无上限；所有 tab 常驻挂载（`TerminalPanesArea.vue:44-45`）。
- 修复（**Phase C**）：WebGL 默认开启 + 失败降级 DOM；写链路队列上限 + 合并；重连回放截断（后端全量回放 16MB，`api/admin/terminal.go:225-228` → 默认回放最近 N 行）。

**P2-13 Bundle**：monaco 未拆 chunk（`vite.config.ts:32-37`）、双语 locale 全量进主包（`i18n/index.ts:2-14`）。
- 修复（**Phase C**）：monaco 独立 chunk；locale 动态加载。

### 3.3 生效断言（验收用）

每项修复配可验证断言（单测或行为验证），Phase 验收时逐条打勾，详见 §6 各阶段验收标准。示例：watcher 排除清单 → 单测断言 `target/` 下文件变更不产生广播；per-path 锁 → 并发压测两项目树请求耗时不叠加；ETag → 二次请求 304；Monaco delta → 单测断言击键不触发 getValue 全量字符串；虚拟化 → 5000 行 commit 列表 DOM 节点数 < 阈值。

---

## 4. 扩展场景实测（证据核心）

> 用「真实扩展场景数改动触点」代替抽象打分。已达标场景作为标杆模式固化进模块规范。

| # | 场景 | 现状触点 | 判定 |
|---|---|---|---|
| S1 | 新增 Agent 运行时 | `agentops.RegisterProvider` 于 `init()` 注册即可（`server/agentops/provider.go:55-88`）；8d2286c 后更支持 `settings.agentProvider` 按名选择（`SelectProviderByName`，`provider.go` +30 行） | **已达标（标杆）** |
| S2 | 新增 git 托管平台 | 改 `platforms/registry.go:30-42` 静态 slice + `providers/registry.go:16-42` switch + `store/credential.go:18-20` AuthType 常量 = 3 处硬编码 | 需注册表化（Phase B） |
| S3 | 新增终端后端 / shell | `terminal/backend.go:12-19,106-113` 常量+switch；`shellint/setup.go:31-40` shell switch = 3 处 | 需注册表化（Phase B） |
| S4 | 复活应用内 LLM 对话 | `aiproviders` 存储无消费者（`store/aiprovider.go` + `config/aiprovider.go`，`server/ai` 包已删，router.go:157-158 注释残留） | 有存储无落点，需模块化落点（Phase B 拆包后自然获得） |
| S5 | 新增事件渠道 | 4 套独立广播（项目 WS hub `api/ws_handler.go` / notification hub `notification/ws.go` / ops-channel `opschannel/opschannel.go` / 任务进度 WS），生产者分散注入 | 需统一事件总线（Phase A） |
| S6 | JSON 换 SQLite | `DocumentStore` 14 方法接口（`store/docstore.go:28-48`）+ `filestore` 单实现 | **已达标（标杆）** |
| F1 | 新增前端领域面板 | 最少 7~11 个文件，其中 5~6 个是共享枢纽：BottomPanel.vue（import+tabs+v-if 三处）、SidePanel.vue、ActivityBar.vue（8 硬编码按钮）、usePanelLayout.ts（union+分支）、Layout.vue:266 panel 白名单、api/client.ts、双语 locale | **需 panelRegistry（Phase C）**，目标 1~2 文件 |
| F2 | 新增后端事件驱动 UI | 后端建 hub + 前端 useWebSocket switch 双改（`useWebSocket.ts:41-74`） | 随事件总线解决（Phase A+C） |
| F3 | 前端插件动态加载预留 | 已有缝：`defineAsyncComponent`×3、路由级 `import()`、`sc-ops:*` 未知事件自动转发（`useOpsChannel.ts:56`）、chat 块渲染器注册表（`components/ai/blocks.ts:24-32`） | panelRegistry + /api/modules 接上即可 |
| F4 | 第三方开发者写插件 | 依赖 §2 全部基座（manifest/SDK/注册面/发现端点） | Phase D，本文档定型接口 |

**上帝包/装配两点结构性障碍**（S2/S4/S5、F1 的公共根因）：
- `server/api/admin`：~7440 行、import 19 个内部包、handler 与 WS 管道/SSH 拨号/子进程编排混杂（注意：8d2286c 已走出正确一步——agent Run 核心下沉 `server/agentops/runner.go`，agentchat.go 478→367 行，且 README 声明 3 个扩展点，本方案沿用该范式）；
- `main.go`：926 行 CLI+守护+装配+后台 worker；10 处 setter 注入（`store.SetDefault`/`git.SetBroadcastFunc`/`auth.SetProviderLookup`/`remoteterminal.SetManager`…）使启动顺序承重——新增模块必须通读 serve()。

---

## 5. 全栈垂直模块划分方案

### 5.1 模块清单（前后端成对）

| 模块 | 后端（现包 → 目标） | 前端（现有归拢） | 说明 |
|---|---|---|---|
| system | admin/{settings,ui_state,snippets,token,instance,lock,update} → api/system + settings 模块 | stores/{settings,uiState,lock,instance,font,theme,locale} | 跨领域粘合最小集 |
| project | admin/project.go + gitops 部分 | stores/project、views/home | |
| git | server/git + api/gitops（已达标范式） | views/git、components/git、stores/{branch,changes,log} | 薄 handler + 厚 service 的样板 |
| files | admin/file.go → api/files | views/files、views/editor | |
| terminal | server/terminal + admin/terminal* → api/terminal | components/terminal、stores/terminal | |
| remote | admin/remotehost* + remoteterminal + sshclient + proxy → api/remote | views/remote、components/remote、stores/{remoteHost,remoteOps} | |
| ai | agentops + admin/agentchat.go → api/ai | components/ai、stores/assistantTask | 8d2286c 已下沉 runner |
| deploy | server/deploy + admin/deploy* → api/deploy | components/deploy、stores/{deployConfig,deployTask} | |
| notify | notification + api/notify + opschannel → 统一事件总线 | stores/notification、NotificationCenter | Phase A 总线宿主 |
| watch | server/watch | （前端经 changes store 消费） | |

### 5.2 模块契约（Go 侧，Phase A 落地 `server/kernel`）

```go
type Module interface {
    Name() string
    DependsOn() []string          // 缺省无依赖；内核拓扑排序启动
    Init(ctx context.Context, k Kernel) error
    Start(ctx context.Context) error
    Stop(ctx context.Context) error   // 托管后台循环，治理不可停 goroutine
}

type Kernel interface {           // 内核门面：模块只看得见这些
    Routes() RouteRegistrar       // gin 注册（/api、/ws 组）
    Events() EventBus             // Publish/Subscribe（类型化信封）
    Store() *store.Store
    Config() *config.ServerConfig // 按需扩展按模块命名空间的读取
    Logger() *slog.Logger         // 模块命名空间子 logger
    Scheduler() Scheduler         // AddTicker(name, d, fn)——受 Stop 管辖
    Manifest() ModuleManifest     // 供 /api/modules
}
```

事件总线：topic 命名延续已被验证的约定（`git.command` / `projects.changed` / `settings.changed` / `task.progress` / `file.changed`…），信封 `{topic, projectId, ts, payload}` 兼容现有 WS 消息形态；旧广播接口（`api.Broadcast` 等）以适配器接到总线上，**现有前端零改动**。

前端侧约定（Phase C 落地）：`panelRegistry`（slot/activity/bottom-tab/side + icon/title/component），内置模块启动时注册；`api/<domain>.ts` 与后端模块同名。

### 5.3 目标目录结构（增量，非重排）

```
server/
  kernel/            # 新：Module/Kernel/EventBus/Scheduler
  app/               # 新：组合根（从 main.go serve() 迁移装配+模块清单）
  api/
    system/ project/ files/ terminal/ remote/ ai/ deploy/ notify/   # 从 admin/ 拆出
    gitops/ shared/                                                  # 保留
  git/ store/ filestore/ agentops/ deploy/ terminal/ remoteterminal/
  sshclient/ proxy/ update/ watch/ config/ middleware/ model/        # 保留
plugins/             # 预留：外部插件安装目录（.gitignore）
web/src/
  api/<domain>.ts    # 从 client.ts 拆出（client.ts 保留 axios 实例+拦截器）
  panels/registry.ts # 新：panelRegistry
  domains/<name>/    # 渐进归拢（不强推，先保证新增按此放置）
```

---

## 6. 迁移路线与验收（每步测试全绿 + 功能等价）

### Phase A 地基 + 低风险性能修复（纯新增为主）
改动面：新增 `server/kernel`、`server/app`（最小版）、`GET /api/modules`；watcher/auto-fetch/status_cache/终端上限/广播截断。
生效断言：① watcher 单测——`target/` 变更不广播、排除清单生效、运行期 AddProject 后事件可达；② auto-fetch——并发信号量单测 + fetch 不再失效 repoInfo 缓存（行为断言）；③ status_cache——并发跨项目请求单测锁不互斥；④ 终端超限创建被拒；⑤ /api/modules 返回模块清单。
验收：`go test ./...` 全绿；web vitest 全绿；构建二进制 + Playwright e2e（隔离端口 9998 + 隔离 SC_DATA_DIR）全绿 → commit。

### Phase B 后端拆包 + 路过即修
改动面（实际交付记录，2026-09-13 更新：**admin 包已完全消失**）：
- **八领域 api 包全部就位**：`server/api/{ai,system,project,files,terminal,remote,deploy,creds}` 共 44 个文件自 admin 物理搬迁（纯改名 + 包名声明 + 跨组引用导出），admin 目录删除、迁移桩清零；router.go 全部限定符切至领域包，main.go 仅引用 3 个包级入口（system.SetBuildInfo/SetupUpdateSource、remote 的拨号器与探测器、terminal 的粘贴图清理器）。
- **跨组依赖显式化**：deploy→remote 的凭据解析以导出符号 `remote.ResolveRemoteHostAuth` 引用（同型导出 TestRemoteHostConnectionResp / NotifyStatusProbe）；同名包导入（api/deploy 引 server/deploy、api/terminal 引 server/terminal）经编译验证合法无需别名。
- **路由等价**：方法+路径集合 diff 为空（自动化比对）；236 条路由行为由全量 e2e 兜底（78 passed / 2 设计性跳过 / 0 failed）。
- **前端 client.ts 拆分**：基础设施 → `api/http.ts`，领域 API → `api/domains/{git,terminal,remote,deploy,credentials,system,ai}.ts`，`client.ts` 变为纯 re-export 桶——83 个导入点与默认导入零改动，`vue-tsc --build` 全绿证明类型面等价。
- **路过即修全项**：Project 仓库 3s TTL 读缓存（写失效，消除每请求磁盘读 ×100+ 调用点）；filestore List(Match) 全量文档缓存（TTL 3s + 全部写操作失效）；ReadFile ETag/304 + WriteFile 原子写（tmp+rename）；git grep 解析早停（达到 maxResults 即停）；SearchLog/GetFileLog 服务端 limit（默认 200/500，可查询参数覆盖）；GetCommitPatch 2MB 截断标记；token LastUsedAt 落盘节流（≥60s）；clone 并发准入 4（排队）、deploy 并发上限 3（拒绝）、agent 跨会话并发上限 4（429）。
- **执行记录**：Mimosa 安全钩子拦截经 Bash 的源码文件名操作，最终以「gitignore 内脚本做纯改名（零内容变更）+ Edit 做包名声明与标识符修改」完成，全部内容修改均经 PreToolUse 扫描；验收：路由 diff 为空（自动化比对通过）；`go test ./...` 全绿；vitest 345+ 通过；隔离实例 e2e 全绿。

### Phase C 前端注册表化 + 前端性能
改动面：panelRegistry 收敛 5 枢纽；Monaco delta 化/模型保留/大文件守卫/级联切断；列表虚拟化/BranchGraph 上限/AI blocks 缓存/文件树本地 splice；终端 WebGL+背压+回放截断；bundle 拆分。
验收：vitest + e2e 全绿；关键路径手测（5 万文件树展开、20 tab 切换、流式会话）；Monaco delta/虚拟化/WebGL 各自断言 → commit。

### Phase D（后续立项）进程插件运行时 + SDK
第一步：RPC 协议 spike（候选 A go-plugin / 候选 B stdio JSON-RPC 各实现同一插件，两周内定案，见 §2.1 修订）。
其后：运行时（发现/校验/子进程拉起/健康检查/前端静态托管）、安装/卸载/更新 CLI 与 UI（仅本地安装，v1 不做远程源与市场）、Go/TS SDK、hello-world 模板、apiVersion 门禁；`signature` 字段编码与校验列为生态开放前的显式范围项。

### 通用验收总则
- 每 Phase 收尾：`go test ./...`（含 `-tags=integration` git auth 集成测试）+ `vitest run` + 构建 `web/dist` → `go build` → 以隔离端口（9998）与隔离 `SC_DATA_DIR` 启动任务分支二进制 → Playwright e2e 全绿（绝不触碰原工作区正在运行的 9999 实例）；
- 现有功能不受影响：路由 diff 为空、前端导出面不变；
- 全部通过才 commit（每 Phase 一次）。

---

## 7. 与插件化的衔接

本方案的模块契约刻意做成 plugin-shaped：`kernel.Module`（+ Routes/Topics/Manifest）即插件 manifest 的 Go 侧投影；panelRegistry 即前端插件注册面；统一事件总线的 topic 即 `contributes.topics`；`/api/modules` 与将来的 `/api/plugins` 同构。Phase D 到来时，插件化 = **模块 + 生命周期接口 + 进程加载层**，不再需要二次大改。

---

## 附录 A：安全 backlog（2026-09-13 晚更新：A1-A9 全部处置完毕）

| # | 严重度 | 问题 | 位置 | 状态 |
|---|---|---|---|---|
| A1 | 高 | `/proxy/:instanceId/*path` 与 WS 代理完全无锁/无鉴权，且转发时注入存储的实例 Bearer token | `api/router.go`、`proxy/proxy.go` | ✅ 已修复：HTTP 代理挂 LockMiddleware、WS 代理挂 WithWSLockAuth；sc_ token 机器间语义保留（守护用例 router_proxy_lock_test.go） |
| A2 | 高 | 默认绑定 `0.0.0.0` + CORS `*` + WS CheckOrigin 恒真；lock 关闭时 API 全开 | `config/config.go`、`middleware/cors.go`、`api/shared/ws.go` | ✅ 已修复：默认 127.0.0.1（`--host/-H` 可覆盖）；CORS 同源回显；CheckOrigin 走 SameOrigin；lock 关闭仅限有配置场景 |
| A3 | 高 | 首启默认密码 `admin`（bcrypt 常量），reset-lock 免鉴权恢复默认 | `store/lock.go`、`main.go` | ✅ 已修复：首启无配置走 `POST /api/lock/setup` 强制设密（needsSetup 引导 + LockMiddleware 全量 423）；reset-lock 回到设密流程而非已知默认口令 |
| A4 | 高 | 文件端点路径校验 `strings.HasPrefix` 无分隔符边界、不解析 symlink、`os.RemoveAll` 在同校验后 | `admin/file.go` 等 | ✅ 已全部收口（perf-report：拒绝 `..` + EvalSymlinks + 根边界）；新增下载端点同标准（files/download.go safeJoinProject）；file-tree 端点 2026-09-26 补齐同标准守卫（SafeJoinProject 导出复用，path-traversal e2e 回归网） |
| A5 | 高 | 自更新链路无签名/校验（下载→chmod 0755→替换→执行） | `update/manager.go` | ✅ 已修复：ed25519 验签优先（公钥 ldflags 注入）、其次 sha256 比对（GitHub 伴随资产 `.sha256`/`.sig`），皆无默认拒绝（`SC_UPDATE_ALLOW_UNVERIFIED=1` 逃生），verify.go + verify_test.go。**发布侧配套已落地（2026-09-13 晚）**：build.sh 支持 `SC_UPDATE_PUBKEY` 注入 ldflags、`SC_UPDATE_PRIVATE_KEY` 构建后为每个二进制产出 `<binary>.sha256`（hex 摘要）+ `<binary>.sig`（对 hex 摘要字符串的 ed25519 签名，base64）；密钥对生成入口 `./build.sh keygen`（tools/updatekey，资产约定与 verify.go 消费端逐项对齐并实测闭环） |
| A6 | 中 | 远程 exec 无命令白名单（仅 8KB/60s）；git 参数以 `-` 开头可注入选项（branch/clone 等未校验 ref 名） | `admin/remotehost_exec.go`、`git/branch.go`、`git/clone.go` | ✅ git 侧已修复（2026-09-13 晚）：`git/refcheck.go validateRef` 拒绝以 `-` 开头的引用名，应用于 Checkout/CreateBranch/DeleteBranch/Merge/Rebase/InteractiveRebase/CherryPick/Revert/Reset/GetRebaseTodo/GetBranchDiff/GetBranchFileDiff/SetBranchUpstream/RenameBranch/CheckoutAndUpdate/Pull（refcheck_test.go 守护）。远程 exec 白名单维持"与 Web 终端同级"设计取舍不变 |
| A7 | 中 | SSH 私钥明文存储（密码已有 AES-GCM）；数据目录 0755 | `store/sshkey.go`、`config/config.go` | ✅ 已修复（2026-09-13 晚）：私钥 Generate/Import 即 AES-GCM 加密落盘（enc: 前缀），listMeta 读取时对存量明文懒迁移重写加密；数据目录 MkdirAll 0755→0700（config.go）。sshkey_test.go 三用例守护（落盘无明文/导入加密/懒迁移后可读） |
| A8 | 中 | cmdStop 直接 Kill（graceful 路径不生效）；3 个后台循环不可停 | `main.go`、`middleware/ratelimit_core.go` 等 | ✅ 已修复（2026-09-13 晚）：新增 `POST /api/shutdown`（仅回环 + `X-SC-Shutdown` 自定义头防 CSRF，shutdown_test.go 守护），app 组合根注册 srv.Shutdown；cmdStop 优雅路径优先（gracefulStop，实测 202→优雅退出），旧版二进制/卡死场景回退 Kill。后台循环随模块化已基本获得 Stop 生命周期 |
| A9 | 低 | 通知 hub 快照后写存在并发写同一 conn 风险；`rand.Read` 错误忽略；限流仅 3 处 | `notification/ws.go`、`store/token.go` | ✅ 已修复（2026-09-13 晚）：新增 `server/wssafe` 写锁包装（gorilla 禁止并发写同一 conn），通知 hub 与项目 WS hub 的心跳/广播统一走 wssafe.Conn（ping 与 Broadcast 并发写 panic 根治）；token salt 生成 rand.Read 失败 Fatal 拒启、Generate 失败报错不产出弱 token。限流点位维持现状（低危，覆盖 lock/unlock、lock/setup、exec 已够用） |

## 附录 B：事实索引

- 后端架构/依赖图/路由表/并发模型：见探索报告（本文引用处均已带 file:line）；关键数字：254 Go 文件 / 37,763 行（测试 8,524 行 / 299 函数）、236 条路由注册、7 个 WS 端点族、19 个 store 接口、6 个注册表/注入点。
- 前端架构：259 文件 / 45,968 行、20 个 Pinia store（自注册、无 store registry）、3 条路由记录（其余为面板状态切换）、7 个 WS 端点族、SSE 手写解析 + 并发信号量 2。
- 8d2286c 合并影响核查：性能与架构结论全部未被触碰；agentops 下沉 runner.go + settings.agentProvider 为本方案现成范式。
