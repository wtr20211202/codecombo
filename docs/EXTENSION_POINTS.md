# 扩展点索引（EXTENSION POINTS）

> 新接手者的入口：本文件列出系统全部扩展点——实现什么接口、在哪注册、
> 最小示例、测试要求。新功能优先落在既有扩展点上，而不是发明新的装配方式。
>
> 通用约定（详见 docs/design/module-split-plugin-foundation.md）：
> - 后端扩展点一律「实现接口 + init() 自注册」或「实现 kernel.Module 由组合根装配」；
> - 新代码禁止新增包级可变全局（见 M2.2）；行为注入走构造参数或模块 Init；
> - 每个扩展点必须有测试：接口实现至少一条单测走通主路径。

## 目录

- [kernel.Module（后端功能模块）](#kernelmodule-后端功能模块)
- [agentops.Provider（AI Agent 接入）](#agentopsproviderai-agent-接入)
- [deploy.Deployer（远程部署目标）](#deploydeployer远程部署目标)
- [platforms.RegisterPlatform（Git 托管平台适配）](#platformsregisterplatformgit-托管平台适配)
- [providers.RegisterProvider / ForPlatform（Git 凭据提供方）](#providersregisterprovider--forplatformgit-凭据提供方)
- [terminal.RegisterBackend（终端后端）](#terminalregisterbackend终端后端)
- [panelRegistry（前端面板注册表）](#panelregistry前端面板注册表)
- [reconnectRefetch（前端重连补拉注册表）](#reconnectrefetch前端重连补拉注册表)
- [前端领域目录（组件归置约定）](#前端领域目录组件归置约定)
- [事件总线 topics 清单](#事件总线-topics-清单)
- [filepolicy（文件打开策略）](#filepolicy文件打开策略)
- [metrics 指标出口（可观测性）](#metrics-指标出口可观测性)
- [持久化三车道（存储扩展点）](#持久化三车道存储扩展点)

---

## kernel.Module（后端功能模块）

系统的顶层扩展点：一个「全栈垂直模块」= 后端生命周期 + 事件 topics + 路由前缀
（未来加 FrontendEntry）。内核按 DependsOn 拓扑排序驱动 Init → Start → Stop。

- **实现**：`server/kernel/kernel.go` 的 `Module` 接口
  （`Name / DependsOn / Init(ctx, k) / Start(ctx, k) / Stop(ctx, k)`）。
- **注册**：组合根 `server/app/modules.go` 的 `builtinModules()` 列表中追加
  `registration{Module, Manifest}`；顺序无关，启动顺序由 DependsOn 表达。
- **清单**：注册后自动出现在 `GET /api/modules`——内核注册表是模块清单的
  **唯一来源**（静态声明清单已删除），manifest 的 Routes/Topics 即对外契约面。
  Manifest.Routes 自 P-20261003-153 起由组合根按真实路由表推导填充
  （路由能力族声明在注册面 `server/api/routefamily.go` 的 moduleRouteFamilies）：
  既有族内新增端点自动进发现面，全新族在声明表补一行；Topics/Capabilities
  语义宽仍由 manifest 手工声明；对账门禁见 server/app/discovery_conformance_test.go。
- **后台循环**：一律用 `k.Scheduler().AddTicker(name, interval, fn)`，禁止裸 `time.Ticker`
  goroutine（Stop 时内核统一取消并等待）。
- **事件**：跨模块广播用 `k.Events().Publish(kernel.Envelope{Topic, ProjectID, Payload})`；
  WS 兼容面由 `server/api/busbridge.go` 桥接。
- **最小示例**：`server/watch/module.go`（首个真实模块）与 `server/notification/module.go`。
- **测试要求**：模块包内 `module_test.go` 一行调用契约套件：
  `kerneltest.Conformance(t, func() kernel.Module { return NewModule(...) })`
  （Init/Start/Stop 时序、Stop 幂等无副作用、事件信封格式由套件统一校验，
  见 `server/kernel/kerneltest/conformance.go`）。

```go
// server/<domain>/module.go
type Module struct {
	k   kernel.Kernel
	// 模块私有状态……
}

func NewModule(...) *Module { return &Module{} }
func (m *Module) Name() string      { return "<domain>" }
func (m *Module) DependsOn() []string { return nil }

func (m *Module) Init(ctx context.Context, k kernel.Kernel) error {
	m.k = k
	return nil // 只做装配；耗时操作放 Start
}

func (m *Module) Start(ctx context.Context, k kernel.Kernel) error {
	k.Scheduler().AddTicker("<domain>-tick", time.Minute, m.tick)
	return nil
}

func (m *Module) Stop(ctx context.Context, k kernel.Kernel) error { return nil }
```

## agentops.Provider（AI Agent 运行时接入）

把外部 AI coding agent（CLI）以终端 TUI 形态接入智能体终端。

- **实现**：`server/agentops/provider.go` 的 `Provider` 接口：
  `Name / Available / InteractiveCommand`。`InteractiveCommand` 返回服务端
  常量启动命令（不含用户输入），由终端管理器经 PTY 注入 shell 执行；
  认证凭据由终端管理器统一注入环境变量（CC_BASE_URL / CC_LOCK_TOKEN）。
- **注册**：实现文件内 `func init() { agentops.RegisterProvider(xxxProvider{}) }`；
  注册顺序即选型优先级（同名后注册覆盖、保持位次）。
- **现有实现**：`server/agentops/providers_builtin.go` 的 `claude` / `dsh` / `codex`。
- **消费方**：`InteractiveLaunchCommand`（`server/api/terminal` createAgentTerminal）、
  `ProviderNames` / `IsRegisteredProvider`（设置白名单与选项清单）。
- **测试要求**：`SelectProviderByName` 回退语义与 `InteractiveLaunchCommand`
  选型单测（fake Provider，不真跑 CLI）。

> 注：headless 会话式运行核心（Run/BuildCommand/stream-json 解析）已随早期
> 会话式 AI 助手移除；如未来需要 headless 形态（定时任务/Webhook 触发），
> 按新需求重新设计接口而非复用历史实现。

## deploy.Deployer（远程部署目标）

远程主机一键部署动作（初始化/开发工具/自托管服务）。

- **实现**：`server/deploy/deployer.go` 的 `Deployer` 接口
  （`ID / Name / Category / Description / DependsOn / Steps / AllowMultiple /
  ParamsSchema / Deploy(ctx, DeployParams)`）。`DeployParams.Log` 边执行边写，
  进度经 Manager 任务流（`/ws/deploy/:taskId`）推给前端。
- **注册**：注册表 `server/deploy/registry.go` 目前**仅包内可见**（`Register` 为小写），
  新 Deployer 在 `server/deploy/` 包内新增文件并以 `init()` 注册
  （参考 `claude_code.go` / `init_ssh_key.go` / `init_user.go` / `codecombo.go`）。
  外部包注册需求出现时再导出（保持 API 面最小）。
- **测试要求**：`ParamsSchema` 与 `Deploy` 的参数解析单测（MustGetString 默认值/缺失报错）；
  注册表 `List()` 排序稳定性已有 `registry_test.go`。

## platforms.RegisterPlatform（Git 托管平台适配）

新 Git 托管平台的 host 识别与能力探测（OAuth / PR URL 等）。

- **实现**：`server/git/auth/platform.go` 的 `PlatformAdapter`
  （`ID / MatchHost`），按需附加能力接口 `OAuthCapable`、`PRURLBuilder`…；
  探测器实现 `PlatformProber`（`Probe(ctx, baseURL)`）。
- **注册**：`server/git/auth/platforms/registry.go` 的 `RegisterPlatform(adapter)` /
  `RegisterProbe(prober)`（实现文件 init() 调用；当前平台为静态表 +
  GenericAdapter 兜底，新平台走动态注册路径）。
- **测试要求**：`MatchHost` 正反例单测；有 Prober 的平台补一条 httptest 探测单测。

## providers.RegisterProvider / ForPlatform（Git 凭据提供方）

某鉴权类型（可按平台细分）的凭据解析实现。

- **实现**：`server/git/auth/provider.go` 的 `auth.CredentialProvider`
  （`Type / Resolve(ctx, *store.Credential) (*ResolvedCredential, error)`）。
- **注册**：`server/git/auth/providers/registry.go` 的
  `RegisterProvider(authType, p)` 或 `RegisterProviderForPlatform(authType, platform, p)`
  （平台专属覆盖平台无关注册）。现有：basic、oauth-device（GitHub 默认 / Gitea 覆盖）。
- **注意**：auth ↔ providers 的 import cycle 由 `providers` 包 init() 里的
  `auth.SetProviderLookup(FindByPlatform)` 桥接（credential-helper 子进程同样生效），
  新代码无需关心。
- **测试要求**：Resolve 成功/失败各一条；集成链路见
  `server/git/auth/integration/`（helper 协议全链）。

## terminal.RegisterBackend（终端后端）

新 PTY 后端（如 Windows ConPTY 变体、远程 PTY）。

- **实现**：`server/terminal/backend.go` 的 `PtyBackend` 接口
  （`Create / CaptureScrollback / Resize / Kill / Alive / IsPersistent / Reattach`）。
- **注册**：同文件 `RegisterBackend(kind BackendKind, factory func() PtyBackend)`，
  同名覆盖；`BackendAuto` 解析顺序见 `ResolveBackend`（tmux 可用优先持久化）。
- **现有实现**：native（`backend_native_unix/windows.go`）、tmux（`backend_tmux.go`）。
- **测试要求**：非 unix/无 tmux 环境可跳过的 build-tag 单测；
  `Alive/Kill` 幂等性必须有断言。

## panelRegistry（前端面板注册表）

前端侧栏/底部面板的唯一入口：新增面板只走注册表，禁止手写 v-if 装配。

- **实现**：`web/src/panels/registry.ts` 的 `PanelDef`
  （`id / group: 'rail-top' | 'bottom-tab' / order / titleKey / labelKey / icon /
  controls / active / onClick / badge?`）。
- **注册**：模块加载期在 `web/src/panels/registry.ts`（内建面板集中注册）或面板
  组件同目录顶层调用 `registerPanel({...})`；`toggleablePanelIds()` 白名单控制哪些面板可被隐藏。
- **守护**：e2e `web/e2e/specs/panel-registry.spec.ts` 断言注册表面板
  全部渲染（新增面板须同步更新该 spec 的期望清单）。
- **测试要求**：panelList 排序 / 复合键（group+id）不互相覆盖的单测
  （`web/src/__tests__/panels/registry.test.ts`）+ 上述 e2e。
- **rail-top 手动序**（P-20261003-252 活动栏拖拽重排）：`panelList('rail-top')`
  在用户手动序（uiState `railOrder.railTop`，ActivityBar 拖拽落点即时写、
  bootstrap `restoreRailTopOrder` 恢复）存在时表内按表序在前、未收录面板按
  内置 order 续尾——新面板一次注册即自动出现在定制序尾部，无需动持久化数据；
  Ctrl+1-9 数字直达同走 panelList，「数字 = 位置」随新序自动一致。

## reconnectRefetch（前端重连补拉注册表）

WS 断线重连后「补拉各域状态」的唯一入口：新增域的断线补拉只走注册表，
禁止在重连触发点手写补拉清单（P-20261003-236 集中化前的三处散点即前车之鉴）。

- **实现**：`web/src/composables/reconnectRefetch.ts` 的
  `registerReconnectRefetch(domain, fn)`（domain→fn，同域覆盖=装配幂等）与
  `runReconnectRefetches()`（统一遍历，fn 同步起跑、单域失败逐域 catch 不拖累其余）。
- **注册**：域主模块装配期一行（store 定义文件或 `useWebSocket.ts`），闭包内
  懒取 store；fn 必须幂等（任一通道重连都会全表执行——通道同生共死）。
- **触发点**（只此三处，新增通道重连也调 `runReconnectRefetches()`）：
  项目 WS `onOpen`（`useWebSocket.ts`，带 pid 切换判别）/
  OpsChannelBridge 的 opsConnected false→true watch / notification store `onOpen`。
- **内建域**：project / approvals / asks / notification / terminals
  （清单见注册表文件头注；grep `registerReconnectRefetch` 即全量）。
- **测试要求**：注册表语义单测 `reconnectRefetch.test.ts`；域 fn 行为归域主
  自身测试；e2e `ws-reconnect-refetch.spec`（项目域）+
  `ops-reconnect-refetch.spec`（ops 通道触发链，approvals 域）+
  `reconnect-refetch-coverage.spec`（asks/notification/terminals 三域断连→重连→恢复）。
  **覆盖面哨兵**（P-20261003-235）：`reconnectRefetch.coverage.test.ts` 把注册表
  键数/键集与文档清单锁成同一份事实——新增/删除补拉域该测试必红，更新义务
  三处同步（注册表头注清单、哨兵 `DOCUMENTED_DOMAINS`、e2e 恢复用例）。

## 前端领域目录（组件归置约定）

前端与后端模块领域对齐：新功能按 `src/domains/<domain>/{views,components,stores}`
组织，纯组件增量进 `src/components/<domain>/`。领域之间不横向 import 组件，
跨领域复用下沉 `components/common/`。完整目录规则与迁移进度见
[web/src/domains/README.md](../web/src/domains/README.md)。

- **测试要求**：领域组件改动跑 `vue-tsc --noEmit` + vitest；
  涉及面板装配的跑 `panel-registry` e2e 守护。

## 事件总线 topics 清单

进程内唯一发布面 `kernel.EventBus`（`server/kernel/events.go`），
`Envelope{Topic, ProjectID, TS, Payload}`，WS 桥接后 Type=Topic、Data=Payload，
与既有前端格式兼容。订阅支持尾随 `*` 前缀通配。

| Topic | 发布方 | 载荷 | 消费面 |
|---|---|---|---|
| `file.changed` | watch 模块 | `{paths, kind}` | 项目 WS（busbridge）→ 前端刷新；watchapi 活动快照（P-20261003-232，GET /api/watch/activity 只读环形缓冲，跨项目变更流轮询面） |
| `git.command` | git 模块 | `model.WSMessage` | 项目 WS（busbridge）→ 前端 git 面板 |
| `git.activity` | terminal 模块（readLoop 输出嗅探，P-20261004-81） | `terminal.GitActivityHit`：`{kind: commit\|push\|switch, ref?, sessionId, projectId, at}` | 项目 WS（busbridge）→ 前端 useWebSocket 并轨 `sc:git-panel-autorefresh` 刷新链（TUI 内部子进程 git 不发 OSC 133 的服务端感知）；agent 可携令牌订阅同通道感知「别的会话动了仓库」（ops 手册 git 节） |
| `projects.changed` | project API | 项目列表变更（前端刷新信号，走 ops-channel） | ops-channel / 前端 |
| `project.added` / `project.removed` | project 模块 | `{id, path}` | watch 模块（运行期监听自管接入） |
| `settings.changed` | system API | 设置键 | ops-channel / 前端 |
| `notification.new` | notification 模块 | `notification.Notification` | /ws/notifications hub（模块内订阅回桥） |
| `task.progress` | ai/ops 链路（agent 上报）；system 模块运行书服务端执行逐步发布（P-20261004-108，载荷携 runId/bookId 扩展字段） | 任务进度 | ops-channel / 前端 |
| `navigate` / `notify` / `panel` / `preview.port` / `open-file-at` | ops-channel | 前端指令（preview.port = 预览端口直达 `{port, label?}`；open-file-at = 编辑器打开目标文件 `{path, projectId, line?, col?}`） | 前端 |

新增 topic 约定：命名空间 = 模块名（`<module>.<event>`）；发布前确认
`server/api/busbridge.go` 是否需要补桥接；本表随 topic 同步更新。

## filepolicy（文件打开策略）

文件能否打开/预览的统一判定（服务端 413/415 分类 + 前端占位卡）。

- **实现**：纯函数包 `server/filepolicy`：
  `KindFor(ext, size, hasNUL)` 判定 text / too-large / binary；
  `IsBinaryExt / NeedsSniff / ExtOf / HumanBytes`；IO 辅助 `SniffHasNUL / ReadHead`。
- **扩展**：调整阈值常量或二进制扩展名表直接改包内常量（有单测锁定）；
  新的「打开方式」（如超大文件分段加载）实现为新的 Kind + files API 消费侧分支。
- **测试要求**：`KindFor` 边界（阈值±1、假二进制文本）单测；
  e2e 大文件占位卡场景（`meta-too-large` / `meta-binary`）。

## metrics 指标出口（可观测性）

Prometheus 文本格式的运行时指标面：`GET /api/metrics`（受全局锁保护）。

- **实现**：零依赖包 `server/metrics`（Counter 单调计数 / Gauge 瞬时值，
  低基数标签如 method/route/status/topic）；`Render()` 输出 text format，
  末尾附进程级 goroutine/heap/uptime。
- **既有指标**：HTTP 请求计数/时长累计/in-flight（`middleware.Metrics()` 全局中间件）、
  WS 连接数（notification/opschannel hub 注册与注销）、总线事件吞吐
  （runtime-ops 模块 wildcard 订阅）。
- **扩展**：新指标 = 在目标位置调 `metrics.IncCounter / SetGauge / AddGauge`
  并带语义化名称（`sc_<域>_<量>_<单位>`），无需改出口端点。
- **测试要求**：`server/metrics` 包内渲染/标签排序单测；
  `middleware/metrics_test.go` 锁定路由模式标签（防 :id 实例值撑爆基数）。

## 持久化三车道（存储扩展点）

新增落盘数据的唯一入口——**先声明车道，再写代码**。完整纪律、判定流程、
现状基线与 review 清单见 [PERSISTENCE_LANES.md](PERSISTENCE_LANES.md)。

- **车道 1 结构化状态**（应用拥有的可查询实体）：`DocumentStore` 新增 kind +
  `server/store/<domain>.go` repo 文件；一记录一文档；append 型必须带保留策略；
  禁止单文档存整个数组。
- **车道 2 流与大块数据**：`~/.codecombo/artifacts/<feature>/` + 轮转保留；
  可查询元数据/索引进车道 1。
- **车道 3 互操作**（用户工作区 / 外部工具数据）：对等读写，索引必须可重建。
- **特例**（密钥/证书/pid/日志等）直接文件 I/O，清单见纪律文档，新增须说明理由。
- **测试要求**：车道 1 新 repo 至少一条单测走通 CRUD 主路径；
  保留策略（上限/TTL）必须有到达边界的用例。
