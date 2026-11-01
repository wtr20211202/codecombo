# Ops 事件目录（OPS EVENTS）

> **`/ws/ops-channel` 事件族与 `sc-ops:*` 窗口事件族的单一事实源。**
> 事件是前后端契约面的一半（另一半 API 面见 ops 手册 `GET /ops-manual`）——
> 新增或变更任何事件，**同 PR 登记本目录**（约定见 CLAUDE.md「AI 原生架构」节），
> 前端/AI 会话的新消费方以本目录为第一入口，不再 grep 考古。
>
> 对账脚本：`node scripts/ops-events-catalog.cjs`（目录 vs 代码漂移报告），
> `--check` 退出码非零 = 有事件未登记或目录行已失效；`--draft` 产出新事件表格草稿
> （人工校注语义列后粘贴进本文件）。
>
> 现状基线：2026-10-05（P-20261003-75 首次登记）；2026-10-06 P-20261003-110
> 服务端 type 常量化（`server/api/opschannel/events.go`，字符串值不变零行为）；
> 2026-10-08 P-20261006-46 Go 侧对账快照第三层
> （`server/archguard/ops_events_test.go` + `testdata/ops-events.json`：
> 常量集增删 / 服务端广播点裸串 / 本文件 `###` 章节锚 / 命名规范 /
> 载荷契约键与 payload-fields 快照交叉核对，五面即红）；
> 2026-10-22 P-20261022-3 新增 `locate-in-tree`（present.tree，纯前端内部事件
> 升级 agent 可发形态）+ navigate 载荷键扩为五形态全集，呈现原语按
> 「动词.目标」原子注册表组织（`server/agentops/capabilities.go`，对账快照
> `testdata/present-atoms.json` 双侧镜像）。

---

## 目录

- [分发规则（先读这节）](#分发规则先读这节)
- [A. 服务端广播事件（经 /ws/ops-channel）](#a-服务端广播事件经-wsops-channel)
- [B. 前端内部窗口事件（不发线上）](#b-前端内部窗口事件不发线上)
- [C. 服务端旁路观察者（同一广播流的非 WS 消费方）](#c-服务端旁路观察者同一广播流的非-ws-消费方)
- [D. 相邻事件面边界（不在本目录）](#d-相邻事件面边界不在本目录)
- [维护纪律](#维护纪律)

---

## 分发规则（先读这节）

**线上信封**：服务端统一经 `opschannel.BroadcastEvent(type, payload)`
（`server/api/opschannel/opschannel.go:160`）广播 `Event{type, payload, source, ts}`。
前端常驻订阅 `/ws/ops-channel`（`web/src/composables/useOpsChannel.ts`），
把每条消息**二次分发为 window CustomEvent**，各视图按需 `addEventListener`：

- **显式分发**：`useOpsChannel.ts` switch 列举 6 型（`projects.changed` /
  `settings.changed` / `navigate` / `notify` / `task.progress` / `panel`），
  分发为对应的 `sc-ops:*` 常量（注意：显式型的 window 事件名与 type **不同名**，
  如 `projects.changed` → `sc-ops:projects-changed` 连字符）。
- **直通分发**：未列举 type 一律 `sc-ops:<type>` 原样分发
  （`useOpsChannel.ts:78`）——`approval.*` / `input.*` / `preview.port` /
  `terminals.changed` / `open-file-at` / `system:rate-limited` 及 agent 自定义
  type 全走此路，**服务端新增 type 无需改前端分发层**，消费方直接监听
  `sc-ops:<type>` 即可。
- `hello` 握手帧不分发；`source` 字段现状恒为 `"system"`
  （`BroadcastEvent` 唯一构造点硬编码，agent 上报与内部广播线上不可凭此区分）。

**事件两大来源**：

1. **服务端内部广播**：handler / 组合根直调 `BroadcastEvent`（下表「广播点」列）。
2. **外部 agent 上报**：`POST /api/ops-notify`（`server/api/ai/opsentry.go:37`，
   agent 令牌鉴权）——type ≤64 字符、`system:` 前缀保留（发布口拒绝伪造，
   `opsentry.go:47`）；内置型 `preview.port` / `task.progress` / `open-file-at` /
   `watch.invite` / `notify.persist` / `locate-in-tree` /
   `frontend.download` / `frontend.clipboard` / `frontend.open`
   的载荷在发布口就地校验规整（open-file-at / watch.invite / notify.persist /
   locate-in-tree / frontend.* 走原子能力注册表 `agentops.AtomForEvent`，坏载荷
   400，不让畸形数据进广播流）；
   按会话维度限流 60 条/分钟，超限静默丢弃 + 每窗口至多一条
   `system:rate-limited` 回告（`opsentry.go:338`）。

**常量族**：window 事件名常量集中在 `web/src/utils/opsEvents.ts`（含 payload
TS 接口），新事件先在那里落常量再消费；服务端 type 常量在
`server/api/opschannel/events.go`（P-20261003-110，`Event*`/`System*` 前缀）——
广播点、`/api/modules` 模块 Topics 与观察者过滤一律引用常量（P-110 前为散点
裸串，拼错即静默失联），对账脚本解析常量值与裸串两种调用形态。

---

## A. 服务端广播事件（经 /ws/ops-channel）

速览（详细形状与广播点见各事件小节）：

| type | window 事件（常量） | 分发 | 来源 |
|---|---|---|---|
| `projects.changed` | `sc-ops:projects-changed`（`OPS_PROJECTS_CHANGED`） | 显式 | 服务端 |
| `settings.changed` | `sc-ops:settings-changed`（`OPS_SETTINGS_CHANGED`） | 显式 | 服务端 |
| `navigate` | `sc-ops:navigate`（`OPS_NAVIGATE`） | 显式 | agent |
| `notify` | `sc-ops:notify`（`OPS_NOTIFY`） | 显式 | agent |
| `task.progress` | `sc-ops:task.progress`（`OPS_TASK_PROGRESS`） | 显式 | agent + 服务端 |
| `panel` | `sc-ops:panel`（`OPS_PANEL`） | 显式 | agent |
| `approval.pending` | `sc-ops:approval.pending`（`OPS_APPROVAL_PENDING`） | 直通 | 服务端 |
| `approval.resolved` | `sc-ops:approval.resolved`（`OPS_APPROVAL_RESOLVED`） | 直通 | 服务端 |
| `input.request` | `sc-ops:input.request`（`OPS_INPUT_REQUEST`） | 直通 | 服务端 |
| `input.resolved` | `sc-ops:input.resolved`（`OPS_INPUT_RESOLVED`） | 直通 | 服务端 |
| `preview.port` | `sc-ops:preview.port`（`OPS_PREVIEW_PORT`） | 直通 | 服务端 + agent |
| `terminals.changed` | `sc-ops:terminals.changed`（`OPS_TERMINALS_CHANGED`） | 直通 | 服务端 |
| `queue.changed` | `sc-ops:queue.changed`（`OPS_QUEUE_CHANGED`） | 直通 | 服务端 |
| `clipboard.arrived` | `sc-ops:clipboard.arrived`（`OPS_CLIPBOARD_ARRIVED`） | 直通 | 服务端 |
| `chain.triggered` | `sc-ops:chain.triggered`（`OPS_CHAIN_TRIGGERED`） | 直通 | 服务端 |
| `terminal.message` | `sc-ops:terminal.message`（`OPS_TERMINAL_MESSAGE`） | 直通 | 服务端 |
| `terminal.message.read` | `sc-ops:terminal.message.read`（`OPS_TERMINAL_MESSAGE_READ`） | 直通 | 服务端 |
| `task.relaySkipped` | `sc-ops:task.relaySkipped`（无常量） | 直通 | 服务端 |
| `experiment.changed` | `sc-ops:experiment.changed`（`OPS_EXPERIMENT_CHANGED`） | 直通 | 服务端 |
| `remoteaccess.status` | `sc-ops:remoteaccess.status`（`OPS_REMOTE_ACCESS_STATUS`） | 直通 | 服务端 |
| `open-file-at` | `sc-ops:open-file-at`（`OPS_OPEN_FILE_AT`） | 直通 | agent |
| `watch.invite` | `sc-ops:watch.invite`（`OPS_WATCH_INVITE`） | 直通 | agent |
| `notify.persist` | `sc-ops:notify.persist`（`OPS_NOTIFY_PERSIST`） | 直通 | agent |
| `frontend.download` | `sc-ops:frontend.download`（`OPS_FRONTEND_DOWNLOAD`） | 直通 | agent |
| `frontend.clipboard` | `sc-ops:frontend.clipboard`（`OPS_FRONTEND_CLIPBOARD`） | 直通 | agent |
| `frontend.open` | `sc-ops:frontend.open`（`OPS_FRONTEND_OPEN`） | 直通 | agent |
| `share.drop` | `sc-ops:share.drop`（`OPS_SHARE_DROP`） | 直通 | 服务端 |
| `system:rate-limited` | （无常量）`sc-ops:system:rate-limited` | 直通 | 服务端 |
| `<自定义 type>` | `sc-ops:<type>` | 直通 | agent |

### projects.changed

- **window 事件**：`sc-ops:projects-changed`（`OPS_PROJECTS_CHANGED`，显式分发）
- **广播点**：`server/api/project/project.go:135`（added）/ `:176`（removed）/
  `:294`（relocated）；`server/api/project/freeze.go:44`（frozen）；
  `server/api/project/lock.go:57`（locked）
- **payload**：`{action: "added"|"removed"|"relocated"|"frozen"|"locked", id,
  name?, frozen?, locked?}`（frozen/locked 仅对应 action 携带布尔）
- **消费方**：`useHomeGlobalListeners.ts` → 首页项目列表自动刷新

### settings.changed

- **window 事件**：`sc-ops:settings-changed`（`OPS_SETTINGS_CHANGED`，显式分发）
- **广播点**：`server/api/system/settings.go:475`（设置保存）；
  `server/api/system/custom_agents.go:161`（自定义 agent 变更）；
  `server/api/ai/approvalmode.go:125`（放行档位变更 / 24h 到期惰性回 ask）
- **payload**：无（`nil`——消费方全量重拉各自关心的设置，不做增量）
- **消费方**：`OpsChannelBridge.vue` → 终端主题重载 + 界面密度重载 +
  审批模式徽标刷新（多标签页/多端跟随）

### navigate

- **window 事件**：`sc-ops:navigate`（`OPS_NAVIGATE`，显式分发）
- **广播点**：无服务端常量调用点——仅 agent 经 `POST /api/ops-notify` 上报
- **payload**：注意力引导目标形态（P-20261005-223），按字段**首命中分发**
  （`{view:'diff', file}` 与纯 `{file}` 同携 file 字段，diff 按 view 判别且先于
  file 分支；校验宽容，非法值落未知形态忽略不报错）：
  1. `{path: "/…"}`——路由跳转（向后兼容首形态，须以 `/` 开头）；
  2. `{file: "src/app.go", line?: 55, project?: "<项目id>"}`——文件直达：
     落成文件深链 `?file=&project=&line=` 既有链（必要时切项目 → 预览位打开 →
     行定位轮询；冷启动等 bootstrap 后消费、锁定挂起解锁接力）；
  3. `{view: "diff", file: "src/app.go", project?: "<项目id>"}`——该文件 vs HEAD
     工作区 diff 直达（`?file=&diff=1` 深链变体，审批卡 target 预览同参）；
  4. `{view: "changes"}`——变更面板聚焦（ensure-open：已可见保持打开，与
     `panel` 事件的 toggle 语义区分；他页/冷启动进入经 pendingSideView 打标，
     bootstrap 布局恢复时消费且不覆盖）；
  5. `{terminalId: "<会话id>"}`——会话聚焦（审批卡「查看发起会话」同一跳转链：
     会话对账 / 已结束 toast 降级 / 切项目 / 开底部终端面板 / 激活 tab）。

  未知形态宽容忽略 + console.debug 留痕（开放词表同哲学）。多端广播同跳语义与
  path 形态现状一致（各端各自落位，接受）。
- **消费方**：`OpsChannelBridge.vue` → 上述四直达（自 App.vue 迁入：`{terminalId}`
  的 jumpToSession 依赖 useMessage，须在 NMessageProvider 树内消费）
- **原子注册表**（P-20261022-3）：五形态收编为 `navigate.path/file/diff/changes/
  terminal` 五原子（`server/agentops/capabilities.go`，无服务端校验——宽容语义
  如上）；file/diff 形态等价人类深链 `/project?file=&project=&line=&diff=1`（手册
  深链表），编造形态 `/project/:id/files?path=` 经路由别名收口为正确深链

### notify

- **window 事件**：`sc-ops:notify`（`OPS_NOTIFY`，显式分发）
- **广播点**：仅 agent 经 ops-notify 上报
- **payload**：`{message: string, level?: "info"|"warning"|"error"|"success"}`
  （level 缺省 info；文案截 200 字符）
- **消费方**：`OpsChannelBridge.vue` → toast；免打扰时段静默
  （审批卡等裁决面走 `approval.pending` 独立分支，不在此静默范围）

### task.progress

- **window 事件**：`sc-ops:task.progress`（`OPS_TASK_PROGRESS`，显式分发）
- **广播点**：①agent 经 ops-notify 上报；发布口对 `steps` 字段规整
  （`server/api/ai/opsentry.go:69`——≤20 项 `{name, done}`，畸形 400；
  其余字段原样透传）；②服务端运行书执行（P-20261004-108，
  `server/api/system/runbookrun.go`）逐步发布——运行书执行即任务，
  `terminalId` 归属执行会话、载荷另携 `runId`/`bookId` 扩展字段
  （消费方不识别即忽略），`GET /api/agent-tasks?sessionId=` 可查历史流
- **payload**：`{task?, status?: "running"|"done"|"failed", step?,
  steps?: [{name, done}], terminalId?, sessionId?, summary?}`——`terminalId` 来自
  agent 环境注入 `CC_TERMINAL_ID`，是进度归属与悬浮球跳转锚点；
  `summary` 为终态顺带结论摘要（P-20261005-221）：发布口对 done/failed 尽力
  附加该会话 transcript 结论尾部（done=最后 assistant 文本 / failed=最后
  error 结果，压平单行 + P-108 遮蔽 + 200 rune 封顶；不可得即缺省不硬凑），
  前端终态通知 body 与 P-31 webhook 外发同源受益，agent 消费同一结论尾部可做
  后续自动化判定；载荷自带 `summary` 时以原样为准（agent 自报精准摘要的
  逃逸口）。注意：远程回流链（useFleetTaskBackflow 合成的 `remote:` 键载荷）
  桥接自对端任务记录、不含 `summary`，远程终态保持纯状态体
- **消费方**：`OpsChannelBridge.vue` → `assistantTask` store（悬浮球/迷你窗/
  值班大屏进度卡）+ done/failed 终态通知链（通知中心 + 桌面通知）+
  后台会话未读点；服务端观察者见 C 节（任务事件落库 / 对比实验推进）

### panel

- **window 事件**：`sc-ops:panel`（`OPS_PANEL`，显式分发）
- **广播点**：仅 agent 经 ops-notify 上报
- **payload**：`{name: string}`——白名单 = 前端面板注册表
  `toggleablePanelIds()`（`useLayoutShell.ts:557`），注册即可被 agent 驱动，
  当前 `files|changes|git|terminal`
- **消费方**：`useLayoutShell.ts` → 切换对应侧栏/底部面板

### approval.pending

- **window 事件**：`sc-ops:approval.pending`（`OPS_APPROVAL_PENDING`，直通分发）
- **广播点**：两条发起路径同汇一桥——AgentGuard 中间件拦截
  （`server/middleware/agentguard.go:143`）与 agent 主动申报 ask 走向
  （`server/api/ai/opsconfirm.go:170`）均调 `middleware.ApprovalNotifier`，
  组合根装配为广播（`server/app/app.go:235`）
- **payload**：完整 `store.AgentApproval` 记录
  （`server/store/agentapproval.go:28`）：`{id, sessionId?, agent?, op, target,
  detail?, impact?, status: "pending", reason?, createdAt, resolvedAt?, ruleHit?,
  mergedInto?, merged?}`（P-20261006-26 合并审批两字段：mergedInto 非空的挂起
  条目不广播不进列表，merged 为主卡挂起队列快照）
- **消费方**：`OpsChannelBridge.vue` → `approvals.upsert`（全局卡片堆 +
  值班大屏）+ 等待音效（仅新 id 响——合并审批入队会同 id 重播本事件更新
  主卡 "+N 同型待批" 徽标，重播不响）；录制观察者（C 节，开录）；断线/刷新靠
  `GET /api/ops-confirm` seedPending 补账（广播不可回放）

### approval.resolved

- **window 事件**：`sc-ops:approval.resolved`（`OPS_APPROVAL_RESOLVED`，直通分发）
- **广播点**：`server/api/ai/opsconfirm.go:209`（用户裁决；
  `BroadcastApprovalResolved` 同时作审批规则 deny 桥）；
  `server/api/ai/approvaltimeout.go:104`（审批超时自动 deny，无 ruleHit）
- **payload**：`{id, status: "allowed"|"denied", sessionId, reason?, ruleHit?}`
  （reason = 拒绝理由随事件回传，下游可选读取）
- **消费方**：`OpsChannelBridge.vue` → `approvals.markResolved`（卡片堆多标签页
  一致清账）；录制观察者（裁决 +10s 缓冲洗停）；任务事件落库（C 节）

### input.request

- **window 事件**：`sc-ops:input.request`（`OPS_INPUT_REQUEST`，直通分发）
- **广播点**：`server/api/ai/opsask.go:83`（agent 经 `POST /api/ops-ask` 提问）
- **payload**：完整 `store.AgentAsk` 记录（`server/store/agentask.go:18`）：
  `{id, terminalId?, agent?, question, options?, status: "pending", createdAt,
  answeredAt?, expiresAt}`（options 非空时前端以按钮作答）
- **消费方**：`OpsChannelBridge.vue` → `asks.upsert`（提问卡堆）+ 等待音效；
  断线/刷新靠 `GET /api/ops-ask` seedPending 补账

### input.resolved

- **window 事件**：`sc-ops:input.resolved`（`OPS_INPUT_RESOLVED`，直通分发）
- **广播点**：`server/api/ai/opsask.go:150`（用户作答回流）
- **payload**：`{id, status: "answered", terminalId}`
- **消费方**：`OpsChannelBridge.vue` → `asks.markResolved`（多标签页一致清账）

### preview.port

- **window 事件**：`sc-ops:preview.port`（`OPS_PREVIEW_PORT`，直通分发）
- **广播点**：`server/api/terminal/terminal.go:81`（终端输出被动探测 dev 端口，
  服务端就地标注 `source: "detected"`）；agent 经 ops-notify 主动上报
  （发布口强类型校验 `opsentry.go:117`——port 必须 1024~65535 整数，
  外部无法伪造 source 字段）
- **payload**：`{port: number, label?: string, source?: "detected",
  hostId?: string}`（hostId = 端口在远程主机回环，前端走 SSH 隧道映射）
- **消费方**：`OpsChannelBridge.vue` → `handlePreviewPortNotify`
  （通知中心带动作条目 + 悬浮球「预览 :N」快捷按钮 → 底部预览面板）；
  服务端同时登记端口注册表（探测/上报统一登记口）

### terminals.changed

- **window 事件**：`sc-ops:terminals.changed`（`OPS_TERMINALS_CHANGED`，直通分发）
- **广播点**：`server/api/terminal/terminal.go:63`（`broadcastTerminalsChanged`
  ——创建/关闭/重命名 + native shell 自行退出经 `SetOnChange` 回调，全端全量快照）
- **payload**：`{sessions: [{id, name, projectId, path, createdAt, kind,
  running?}]}`（全量快照对账，非增量；`running` 字段缺省 = 服务端无法判定）
- **消费方**：`useTerminalTabSync.ts`（底部终端 tab 新建即现/关闭即清/改名即跟）；
  `stores/terminal-sessions.ts` `applySnapshot`（会话管理页/值班大屏/悬浮窗，
  顺带驱动 `assistantTask.pruneClosedSessions` 死会话清账）

### queue.changed

- **window 事件**：`sc-ops:queue.changed`（`OPS_QUEUE_CHANGED`，直通分发）
- **广播点**：`server/api/terminal/queue.go`（`queueEngine.sendHead`——排队指令
  自动发送弹队首成功后；入队即时发送与回执驱动发送同点）
- **payload**：`{sessionId: string, remaining: number}`（发送后剩余排队条数）
- **消费方**：`OpsChannelBridge.vue` `onQueueChanged` → `stores/agentQueue.ts`
  `onQueueChanged`（加载过即拉 `GET /terminals/queues` 全量对账——侧栏徽标与
  行内面板的唯一实时感知通道；弹出先于广播，收到即刷必读到发送后队列态）

### chain.triggered

- **window 事件**：`sc-ops:chain.triggered`（`OPS_CHAIN_TRIGGERED`，直通分发）
- **广播点**：`server/api/agentchain/trigger.go`（`engine.fire`——会话接续链
  三道闸（源会话存活/同链冷却/深度上限）全过后成功拉起下一棒）
- **payload**：`{chainId: string, sourceTerminalId: string,
  status: "done"|"failed", sessionId: string(下一棒会话 id), runtime?: string}`
  （status 为链源终态；failed 仅 onFailure=true 链会出现）
- **消费方**：`AgentChainPanel.vue`（面板打开期间经直通分发窗口事件重读链列表，
  触发事实 lastTriggeredAt/深度演进免轮询可见）；agent 自动化脚本可在
  ops-channel 上监听同一事件感知接力进度（/ops-manual `agent-chain` 节）

### terminal.message

- **window 事件**：`sc-ops:terminal.message`（`OPS_TERMINAL_MESSAGE`，直通分发）
- **广播点**：`server/api/opsmessage/api.go`（`SendMessage`——POST
  /api/ops-message 投递成功后；载荷校验/目标会话在册 404/会话维度限流
  60 条每分钟，纪律与 ops-notify 同源）
- **payload**：`{from: string(发送方会话 id), to: string(目标会话 id),
  summary: string(正文首行速览 ≤80 rune), at: number(epoch ms)}`——**全文不上
  广播面**（消息正文与 ask/notify 同级敏感面，全文只在收件箱 GET 面）
- **消费方**：`OpsChannelBridge.vue` `onTerminalMessage` → terminal-sessions
  store `markUnread(to)`（接收会话 tab 未读徽标；可见会话内部跳过）；agent
  自动化脚本监听同一事件可免轮询感知留言到达（/ops-manual `agent-message` 节）

### terminal.message.read

- **window 事件**：`sc-ops:terminal.message.read`（`OPS_TERMINAL_MESSAGE_READ`，
  直通分发）
- **广播点**：`server/api/opsmessage/api.go`（`GetInbox`——GET /api/ops-message
  拉取到新留言即标记已读后广播；空拉取不广播）
- **payload**：`{sessionId: string(拉取方会话 id), count: number(本次拉取条数)}`
- **消费方**：`OpsChannelBridge.vue` `onTerminalMessageRead` → terminal-sessions
  store `clearUnread(sessionId)`（「读取后徽标消」的唯一感知通道——拉取是
  agent 侧动作，前端不轮询收件箱面，避免与 agent 的拉取互抢）

### task.relaySkipped

- **window 事件**：`sc-ops:task.relaySkipped`（直通分发；前端 `opsEvents.ts`
  暂无常量——前端暂无消费者，agent 监控面直用）
- **广播点**：`server/api/agentcron/relay.go`（`emitRelaySkipped`——定时任务
  配置了接力源 `relayFrom` 但触发时取不到结论：源会话不存在/无 assistant
  结论/latest 解析落空/launchArgs 配额不够；任务**照常无前言启动**，自动化
  容错优先不停摆，同一事实另落任务 `lastRelayNote = "skipped: <原因>"`）
- **payload**：`{cronId: string, name: string(任务名), reason: string(降级原因)}`
- **消费方**：agent 自动化脚本/运维监控在 ops-channel 上监听（感知「自动续命
  断链」及原因，如源会话被清理后改用 `latest` 形态自愈；/ops-manual
  `agent-cron` 节）

### experiment.changed

- **window 事件**：`sc-ops:experiment.changed`（`OPS_EXPERIMENT_CHANGED`，直通分发）
- **广播点**：`server/api/compareexp/watcher.go`（`applyTaskResult`——完成链
  回执落位使 running 实验任一侧 Result 变化后；**落库先于广播**，收到即拉的
  消费方必读到迁移后状态。重复回执/迟到 no-op 不广播，零事件噪声）
- **payload**：`{id: string(cmp-<unixnano>), status: "running"|"ready",
  resultA: string, resultB: string}`——status 是实验整体状态（双侧齐备翻
  ready），resultA/B 是该侧终结回执（done / failed / `error:<发起失败摘要>`；
  尚未落位的一侧为空串）。事件是通知非快照，权威状态以
  `GET /api/compare-experiments` 面为准
- **消费方**：`useCompareExperiment.ts`（实验面板打开期间事件 id 命中即重拉
  详情/列表——「实验完成」即时联动；5s 轮询降级保留兜 WS 断线窗口）；agent
  自动化脚本监听同一事件感知竞写进度（/ops-manual `compareexp` 节）

### remoteaccess.status

- **window 事件**：`sc-ops:remoteaccess.status`（`OPS_REMOTE_ACCESS_STATUS`，直通分发）
- **广播点**：`server/api/remoteaccess/tunnel.go` 的 `onManagerEvent`（启动/停止/
  首次失败/断线重连/重连成功/重连失败每次状态机迁移一次）
- **payload**：`{event, state, profileId, remoteBindHost, remotePort, publicUrl,
  startedAt, onlineSince, lastError, lastErrorAt, reconnectAttempts,
  activeConnections, totalConnections, droppedConnections, at}`
  （`state` = stopped / connecting / online / reconnecting / failed；`event` 是
  迁移事件名；凭据与密码永不上广播面）
- **消费方**：`RemoteAccessSettings.vue`（设置·远程接入分区即时刷新状态与最近
  错误）；agent 可监听同一事件感知公网入口存活/重连，免轮询 GET
  `/api/remoteaccess/tunnel`

### open-file-at

- **window 事件**：`sc-ops:open-file-at`（`OPS_OPEN_FILE_AT`，直通分发——
  常量值恰为 `sc-ops:<type>`，与前端内部派发共用同一常量，见 B 节）
- **广播点**：仅 agent 经 ops-notify 上报（发布口形态校验收编原子能力注册表
  `server/agentops/capabilities.go` ValidateOpenFileAtPath——path 项目相对
  正斜杠、无 `..` 段/盘符，projectId 必填，line/col 可选正整数）
- **payload**：`{path: string, projectId: string, line?: number, col?: number}`
  （前端内部派发形态另有可选 `diffVsHead?: boolean`，直开 vs HEAD 差异视图）
- **消费方**：`useLayoutViews.ts` → 必要时切项目 → 打开文件 → 行定位
  （文件缺失落空静默——发布口只做形态校验，存在性由消费链兜底）
- **原子注册表**：`present.file`（P-20261022-3）；等价人类深链
  `/project?file=&project=&line=`（手册深链表 file 形态）

### locate-in-tree

- **window 事件**：`sc-ops:locate-in-tree`（`OPS_LOCATE_IN_TREE`，直通分发——
  常量值恰为 `sc-ops:<type>`，与前端内部派发共用同一常量，见 B 节）
- **广播点**：仅 agent 经 ops-notify 上报（P-20261022-3 把纯前端内部事件升级为
  agent 可发形态；发布口形态校验收编原子能力注册表
  `server/agentops/capabilities.go` ValidateLocateInTree——path 可空
  （= 项目根）、非空须项目相对正斜杠无 `..` 段，projectId 必填，focus 可选
  布尔。存量例外命名登记见 archguard 快照 `legacyEventNames`：常量值恰等于
  前端窗口事件名，open-file-at 同款双栖恒等）
- **payload**：`{path: string, projectId: string, focus?: boolean}`——path
  为项目相对路径（正斜杠），空串 = 项目根本身（把人送到树里自己选）；
  focus = 落点后把键盘焦点交给树列表（缺省不抢编辑器焦点）
- **消费方**：`FileTreeView.vue` 既有 `onLocateInTree` 接收链（projectId 与
  当前项目不符时忽略；保证侧栏可见 + 退最大化 + 清树搜索 + 逐层展开 + 滚动
  高亮）；侧栏不在 files 视图（树未挂载无人监听）时由 `useLayoutViews.ts`
  兜底适配层先切回 files 视图再重派发同一契约事件（P-20261022-3）
- **原子注册表**：`present.tree`（P-20261022-3）——与 `present.file`
  （open-file-at）的分工：树定位给「文件在哪」的结构上下文，打开文件给
  「文件内容」

### watch.invite

- **window 事件**：`sc-ops:watch.invite`（`OPS_WATCH_INVITE`，直通分发）
- **广播点**：仅 agent 经 ops-notify 上报（发布口形态校验
  `server/api/ai/opsentry.go`——url 必填且限 `/s/<token>` 访客短链路径形态
  （前缀 + token 字符集白名单 `[0-9a-zA-Z]`，拒绝对 URL/协议相对外链/伪协议/
  子路径/query/fragment/编码字符——**反钓鱼边界**：该值是前端 `window.open`
  的直接消费值），title/body 可选展示文本各 ≤4096 字节）
- **payload**：`{url: string, title?: string, body?: string}`——url 是相对
  访客路径（agent 无需知道部署主机与分享子服务端口），前端经
  `GET /api/share/status` 拼回完整访客短链再入账动作
- **消费方**：`OpsChannelBridge.vue` → `utils/watchInviteNotify` 通知链
  （去重 → 拼访客短链 → 通知中心条目 `action='url'`，点击新窗打开访客直播页
  ——agent 开完终端直播（POST /api/share/terminal）后「请人来看」的
  human-pull 原语；同会话同 url 同文案去重整链跳过）

### notify.persist

- **window 事件**：`sc-ops:notify.persist`（`OPS_NOTIFY_PERSIST`，直通分发）
- **广播点**：仅 agent 经 ops-notify 上报（发布口校验规整
  `server/api/ai/opsentry.go`——title 必填 ≤200 rune、body 可选 ≤4096 字节、
  level 枚举 info|success|warning|error 缺省 info、action 白名单
  terminal|panel|url|preview 且 actionPayload 逐动作形态校验；title/body 入账
  即过敏感遮蔽）——与 `notify`（纯 toast 即逝）的分工在**留痕与动作**：
  服务端 handler 直调 `notification.Add` 入账（跨设备可见 + webhook 外发链
  自动携带 + 历史留痕，与系统通知同库同偏好过滤——分类静音/免打扰全生效；
  归类 task，任务子开关一并管辖），`preview.port`（P-20261002-70 前端入账
  特例）的通用化收编
- **payload**：`{title: string, body?: string, level?: "info"|"success"|
  "warning"|"error", action?: "terminal"|"panel"|"url"|"preview",
  actionPayload?: string}`——actionPayload 按动作：terminal=会话 id（「查看
  会话」直达终端 tab）/ panel=面板名（面板存在性由前端注册表兜底）/
  url=https(s) 绝对外链（scheme 白名单拒伪协议，window.open noopener 直开）/
  preview=端口号（直达预览面板）。agent-fix 等人裁决面动作不对 agent 开放；
  坏 action/载荷 400 退回；类别静音命中时服务端不入账也不广播本事件
- **消费方**：通知中心条目经 `/ws/notifications` 全端实时入账（actions 由
  pendingAction 链既有分发）；`OpsChannelBridge.vue` → 实时弹面 toast
  （免打扰时段静默；error/warning 的桌面提醒由通知中心既有 watch 承担）。
  限流沿 ops-notify 既有 60 条/分钟（入账与广播同预算，风暴打不穿通知中心）

### frontend.download

- **window 事件**：`sc-ops:frontend.download`（`OPS_FRONTEND_DOWNLOAD`，直通分发）
- **广播点**：仅 agent 经 ops-notify 上报（发布口注册表校验——path 必填项目
  相对正斜杠无 `..` 段、projectId 必填非空，同 `open-file-at` 口径，坏载荷
  400 退回）
- **payload**：`{path: string, projectId: string}`——下载走既有文件下载端点
  `GET /api/projects/:id/file/download`（路径防穿越 + Content-Disposition
  净化链既有），文件字节不经事件通道，事件只承载「触发」语义
- **消费方**：`OpsChannelBridge.vue` → `utils/frontendAtomActions`（隐藏
  `<a download>` 指向下载端点点击 → 浏览器下载框弹出；成功 toast 带「开始
  下载」反馈——**无静默效应**，效应面限频 10 次/分钟，超限可见 warning）。
  frontend 动词族（P-20261023-4）：协议从「引导注意力」升维「替用户执行
  浏览器动作」，设置·通用分区可按原子关闭（默认开）

### frontend.clipboard

- **window 事件**：`sc-ops:frontend.clipboard`（`OPS_FRONTEND_CLIPBOARD`，直通分发）
- **广播点**：仅 agent 经 ops-notify 上报（发布口注册表校验——text 必填非空
  ≤32KB，与跨设备中继槽 clipMaxBytes 同界：writeText 失败的回落链写该槽，
  回落链零二次拒绝；载荷原样透传不遮蔽不 trim——写进剪贴板的字节须与
  agent 意图逐字一致，遮蔽只作用于展示面）
- **payload**：`{text: string}`
- **消费方**：`OpsChannelBridge.vue` → `utils/frontendAtomActions`（copyText
  直写 + 成功 toast 带敏感值遮蔽+截断预览的预告——**无静默写入**，剪贴板
  投毒四层收口：可见预告 / 预览截断 / 设置开关 / 限频；writeText 失败〔焦点/
  权限/非安全上下文〕回落 `clipboard.arrived` 中继链：写服务端单槽 + 可点击
  toast 读取即焚落本地剪贴板，功能不缺失只是多一次点击）

### frontend.open

- **window 事件**：`sc-ops:frontend.open`（`OPS_FRONTEND_OPEN`，直通分发）
- **广播点**：仅 agent 经 ops-notify 上报（发布口注册表校验——url 必填
  http(s) 绝对外链，scheme 白名单拒伪协议 + 主机非空 + 禁空白控制符，与
  `notify.persist` action=url 同一防线 `isHTTPExternalURL`，坏载荷 400 退回）
- **payload**：`{url: string}`
- **消费方**：`OpsChannelBridge.vue` → `utils/frontendAtomActions`（
  `window.open(url, '_blank', 'noopener')` 新标签打开 + 成功 toast；popup
  blocker 是浏览器边界不硬求：被拦时回落通知中心 `action='url'` 条目——
  既有形态，用户点击开 + warning toast；效应面限频同上）

### share.drop

- **window 事件**：`sc-ops:share.drop`（`OPS_SHARE_DROP`，直通分发）
- **广播点**：`server/api/share/module.go`（Module.Start 装配
  `WithDropEvents` 回调——访客经分享协作通道上传素材成功后一次）
- **payload**：`{token, shareName, terminalId?, id, name, size, kind, nick?}`
  （仅元数据——素材内容不上广播面，terminal.message 同纪律；`token` 是
  分享短链标识，回查 GET /api/share/:token/drops 取含绝对路径的清单）
- **消费方**：owner 工作台「交给当前会话/新会话处理」动作链
  （`useShareDrop.ts`，与通知中心行内动作双出口同一链）；agent 监听同一
  事件自动感知协作素材到达（读清单 → 按主人确认读绝对路径分析）

### system:rate-limited

- **window 事件**：`sc-ops:system:rate-limited`（直通分发，无常量——前端无
  消费者不受扰）
- **广播点**：`server/api/ai/opsentry.go`（ops-notify 限流回告，每维度每窗口
  至多 1 条）；`server/api/opsmessage/api.go`（定向消息限流回告，同款闸门）；
  `server/api/gitops/search_ratelimit.go`（内容搜索限流回告 P-20261004-124 +
  终端输出检索限流回告 P-20261005-158 经同一 `gitops.SearchRateLimit` 单一
  实现，每 key 每窗口至多 1 条；dimension：gitops 裸键 "project"，终端检索键
  按前缀推导 session/token/ip）；`system:` 保留前缀仅服务端可发
  （载荷结构体 `opschannel.RateLimitedNotice` 唯一事实源）
- **payload**：`{dimension: "session"|"token"|"ip"|"project", key, dropped,
  limit, windowSec}`（limit 随域：ops-notify 60 / 定向消息 / 搜索 30）
- **消费方**：预期消费方是 **agent 侧自身**（感知限流自纠），非前端

### clipboard.arrived

- **window 事件**：`sc-ops:clipboard.arrived`（`OPS_CLIPBOARD_ARRIVED`，直通分发）
- **广播点**：`server/api/system/clip.go`（`PostClip`——跨设备剪贴板中继
  POST /api/clip 写入成功后；内存单槽 + TTL 5 分钟 + 读取即焚）
- **payload**：`{origin?: string, size: number, at: number}`——**内容绝不进
  广播面**（留在服务端单槽，接收方点击 toast 经 `GET /api/clip` 读取即焚）；
  origin 是发送方设备 id（前端 localStorage 随机标签），接收侧据此静默发送方
  自身设备的回声
- **消费方**：`OpsChannelBridge.vue` `onClipArrived` → 他机到达弹可点击 toast
  （点击 = `useClipRelay.takeArrived` 取走并 copyText 落本地剪贴板）；发送侧
  入口 = 命令面板 `clip-send`（终端右键入口缩范围未做，留后续提案）

### &lt;自定义 type&gt;（agent 扩展通道）

- **window 事件**：`sc-ops:<type>`（直通分发）
- **广播点**：agent 经 `POST /api/ops-notify` 上报任意 type（≤64 字符、非
  `system:` 前缀即可）
- **payload**：任意 JSON 对象（未登记 type 无形状承诺——**新事件一旦有第二个
  消费方就应升级为正式 type 并登记本目录**）
- **消费方**：按需 `addEventListener('sc-ops:<type>')`，无监听不受扰

---

## B. 前端内部窗口事件（不发线上）

同驻 `web/src/utils/opsEvents.ts` 常量族、同用 `sc-ops:*` 命名空间，但**派发与
消费都在前端进程内**（window CustomEvent），不经 /ws/ops-channel——列出以覆盖
完整契约面（前端开发者考古的同一痛点）。

| 常量 | window 事件名 | detail 形状 | 派发点 | 消费方 |
|---|---|---|---|---|
| `OPS_ACTIVATE_TERMINAL` | `sc-ops:activate-terminal` | `{id}` | TaskRunner.vue:115 / useApprovalActions.ts:131 / MonitorView.vue:265 | useAgentTerminal.ts、TerminalView.vue（待激活队列——广播对账追加 tab 可能晚于事件，命中前挂起） |
| `OPS_FILES_EXTERNAL_CHANGE` | `sc-ops:files-external-change` | `{paths?: string[]}`（缺省 = 全量失效） | ProjectSearch.vue:448（全工程替换）/ useBranchCheckout.ts:45 / ConflictView.vue:114,128,143 / CommitsPanel.vue:324,328,401,415 / GitPanel.vue:275 / RebaseEditorModal.vue:105 | useOpenFiles.ts（重读已打开且无未保存修改的文件）、useEditorGutterChanges.ts、useQuickNav.ts |
| `OPS_FILES_SAVED` | `sc-ops:files-saved` | `{paths: string[]}` | useOpenFiles.ts:1081,1142,1197（保存链） | useEditorGutterChanges.ts（gutter 变更条刷新） |
| `OPS_OPEN_FILE_AT` | `sc-ops:open-file-at` | `{path, projectId, line?, col?, diffVsHead?}` | DiffEditor.vue:56 / ProjectSearch.vue:492 / ApprovalCard.vue:135（target 点击预览） | useLayoutViews.ts；**双栖事件**——同为线上 `open-file-at` 的直通分发目标（见 A 节） |
| `OPS_LOCATE_IN_TREE` | `sc-ops:locate-in-tree` | `{path, projectId, focus?}` | useTerminalTreeLocate.ts / useEditorTreeLocate.ts（终端/编辑器「在文件树中定位」） | FileTreeView.vue（保证侧栏可见 + 逐层展开滚动定位）；**双栖事件**——同为线上 `locate-in-tree` 的直通分发目标（见 A 节，P-20261022-3），侧栏不在 files 视图由 useLayoutViews 兜底适配层先切视图再重派发 |
| `OPS_COLLAPSE_TREE` | `sc-ops:collapse-tree` | `{projectId}` | useLayoutReset.ts:53 / useLayoutShell.ts:213（一键重置布局） | FileTreeView.vue（收起全部目录；未挂载时清 localStorage 键已覆盖） |
| `OPS_REMOTE_OPEN_IN_EDITOR` | `sc-ops:remote-open-in-editor` | `{hostId, path}` | RemoteFilePane.vue:157（远程文件右键） | useLayoutShell.ts:565（切编辑器主区 + `remote:<hostId>:<path>` 伪路径开签）、RemoteFileManager.vue |
| `OPS_AGENT_GROUPS_CHANGED` | `sc-ops:agent-groups-changed` | 无（收到即拉全量） | useWorkspaceSnapshot.ts（工作区预设恢复链 applyAgentGroups 落盘成功后，P-20261004-79） | useAgentTerminalGroups.ts（live 挂载中的会话管理页重读 agentTerminal.groups 即时重应用；home overlay 与 project 内嵌双实例各自监听） |
| `OPS_WORKTREES_CHANGED` | `sc-ops:worktrees-changed` | 无（收到即拉全量） | CommitsPanel.vue:341 等跨组件创建/清理动作（历史检视 worktree 落档后，P-20261005-179） | GitWorktreesSection.vue（收到即重拉列表——面板自身只挂项目切换 watch，同项目异组件创建对其不可见） |
| `OPS_AGENT_CRONS_CHANGED` | `sc-ops:agent-crons-changed` | 无（收到即拉全量） | useCronRetry.ts:77（cron-retry 一键重试成功后，P-20261006-14） | AgentCronSettings.vue（设置·定时任务分区收到即重拉列表） |
| `NOTES_EXTERNAL_UPDATE` | `sc:notes-external-update`（**`sc:` 前缀历史命名**，非 `sc-ops:`） | `{projectId}` | useNotesDeposit.ts（任务终态「沉淀到笔记」写回后） | NotesPanel.vue（无未保存编辑时从服务端重读，防旧内容覆盖沉淀节） |

---

## C. 服务端旁路观察者（同一广播流的非 WS 消费方）

`opschannel.AddObserver`（`server/api/opschannel/opschannel.go:127`）让服务端
模块并行消费同一事件流——观察者故障互不传染、不影响 WS 广播主链路。新增
观察者在模块 `Init` 装配，不占用本目录事件定义，但**新增事件时检查是否需要
观察者语义**：

| 观察者 | 装配点 | 消费 type | 用途 |
|---|---|---|---|
| `TaskEventObserver` | `server/api/ai/module.go:49` | `task.progress` / `approval.pending` / `approval.resolved` | 任务事件落库（车道 1 agenttask，7 天保留） |
| 对比实验 observer | `server/api/compareexp/module.go:37` | `task.progress` | 双侧回执齐备 running → ready；落位即广播 `experiment.changed`（A 节） |
| 录制 observer | `server/recording/module.go:28` | `approval.*` | 审批过程录制开录/冲洗停 |

---

## D. 相邻事件面边界（不在本目录）

以下事件面与本目录事件**通道不同**，勿混用；改动时查对应文档：

- **`/ws/projects/:id` 项目通道**（per-project，`WSMessage{type, data}`）：
  `file.changed` / `git.command` / `git.activity` / `branch.changed` / `log.changed` 等——
  前端消费在 `useWebSocket.ts`（git 面板自动刷新另经 OSC 133 前端本地链，
  见 CLAUDE.md P-20261003-74；`git.activity` 为 P-20261004-81 服务端嗅探
  TUI git 写活动的定向广播，经同通道并轨刷新链）。发布面 = kernel 事件总线 +
  `server/api/busbridge.go` 桥接，**topics 清单与载荷见
  [EXTENSION_POINTS.md](EXTENSION_POINTS.md)「事件总线 topics 清单」**。
- **`/ws/notifications` 通知中心通道**：`notification.new` /
  `notification.snoozeDue` / `sync.progress`（P-20261023-1 多实例同步进度，
  500ms 节流自由载荷 `{type,data}`，前端 notification store 按类型分发为
  `sc-ops:sync-progress` 窗口事件——hub 在 `server/notification/ws.go`
  `BroadcastEvent`，清单见 CLAUDE.md WebSocket 节）。
- **`/ws/clone/:taskId`、`/ws/deploy/:taskId`**：任务私有进度/日志通道（快照
  补发 + 回放语义），见 CLAUDE.md WebSocket 节。

> 动机注记：提案 P-20261003-75 罗列的 `git.command` 实际住在项目通道
> （上方第一条），不在 ops-channel 契约面内——本目录因此以 sc-ops:* 为界，
> 项目通道事件以 EXTENSION_POINTS.md 表为准。

---

## 维护纪律

1. **新增/变更事件（type、payload 形状、广播点、消费方）必须同 PR 更新本目录**
   ——文档漂移视为交付不完整（CLAUDE.md「AI 原生架构」节同款约定）。
2. 落常量先行：window 事件名与 payload 接口进 `web/src/utils/opsEvents.ts`；
   服务端 type 进 `server/api/opschannel/events.go` 常量表，广播点与模块
   Topics 一律引用常量（新广播点禁止裸串——对账脚本两种形态都扫，裸串
   是兜底面不是豁免口；Go 侧 `archguard/ops_events_test.go` 把裸串当硬失败）。
3. 提交前跑 `node scripts/ops-events-catalog.cjs --check`：
   - 代码侧新常量 / 新 `BroadcastEvent` 调用（常量或裸串）未在目录出现 →
     非零退出（漏登记）；
   - 目录中的事件 id 在代码侧已消失 → 提示清理失效行（人工确认后删）。
4. **Go 侧对账快照同 PR 登记**（P-20261006-46）：新增/删除/改名事件常量须同步
   `server/archguard/testdata/ops-events.json`（source / payload 契约键 /
   anchor = 本文件 `###` 小节名），`go test ./server/archguard/` 增删即红；
   载荷为完整契约记录的事件填 `contractKey`（指入 payload-fields.json 键），
   契约结构体加减字段时两快照同一 PR 跟随。
5. **命名规范**：新增 type 一律 `domain.action` 点分小写连字符段
   （多段 `terminal.message.read` 亦合规）；存量例外（navigate / notify /
   panel 动词型、open-file-at 连字符、system:rate-limited 保留前缀冒号）已在
   快照 `legacyEventNames` 登记缘由，给新类型开例外必须同处登记。
6. agent 自定义 type 不要求登记（无契约承诺）；一旦出现第二个消费方或服务端
   校验，即升级为正式事件补登记。
