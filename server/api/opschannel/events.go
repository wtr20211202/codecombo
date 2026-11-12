package opschannel

// 事件 type 契约常量表（P-20261003-110）：ops-channel 事件名的三方契约代码级
// 同源——服务端广播点（BroadcastEvent 调用方）、/api/modules 模块发现面
// （server/app/modules.go 的 Topics）与前端契约面（web/src/utils/opsEvents.ts +
// docs/OPS_EVENTS.md 事件目录）统一引用本表。事件名拼错即静默失败（前端对未知
// type 走 sc-ops:<type> 直通分发、无校验，type 对不上只是没人听），常量化后
// 拼错 = 编译错误。字符串值即线上协议，**只增不改**（升级兼容纪律）。
//
// 命名约定：本表常量以 Event / System 前缀开头——对账脚本
// （scripts/ops-events-catalog.cjs）按该前缀从本包源码提取常量值与调用点对账。
//
// 新增事件：本表加常量 → 广播点/Topics/观察者过滤引用常量 → 同 PR 登记
// docs/OPS_EVENTS.md（scripts/ops-events-catalog.cjs --check 门禁对账，
// 常量调用点与裸串新调用点都扫）+ 同 PR 登记 Go 侧对账快照
// server/archguard/testdata/ops-events.json（P-20261006-46：常量集/服务端广播
// 调用点/手册章节锚/命名规范/载荷契约键五面即红，测试失败信息指引登记路径）。
//
// 命名规范：新增 type 一律 domain.action 点分小写连字符段（如 queue.changed /
// clipboard.arrived，多段 terminal.message.read 亦合规）。存量例外（archguard
// ops-events 快照 legacyEventNames 同源登记，缘由入彼处注释）：navigate /
// notify / panel 是 agent 面「动词」无域前缀、open-file-at 连字符早于规范、
// system:rate-limited 兼具保留前缀冒号、task.relaySkipped action 段 camelCase
// 早于命名门——存量不改零迁移（字符串值即线上协议，只增不改）。
//
// 开放词表语义保留：POST /api/ops-notify 外部 agent 自定义 type 不进本表、
// 不进对账快照（无契约承诺，前端直通分发无监听不受扰）；一旦出现第二个消费方
// 或服务端校验，即升级为正式事件加常量补登记。

// SystemEventPrefix 系统事件保留前缀：POST /api/ops-notify 发布口拒绝该前缀的
// type——系统回告事件仅服务端可发，agent 无法伪造。发布口前缀校验与
// EventRateLimited 构造引用同一常量，防两处人肉同步漂移
const SystemEventPrefix = "system:"

const (
	// 显式分发型：useOpsChannel.ts switch 列举（window 事件名与 type 不同名，
	// 如 projects.changed → sc-ops:projects-changed 连字符，见事件目录分发规则）
	EventNavigate        = "navigate"
	EventNotify          = "notify"
	EventPanel           = "panel"
	EventTaskProgress    = "task.progress"
	EventSettingsChanged = "settings.changed"
	EventProjectsChanged = "projects.changed"

	// 直通分发型：前端对未列举 type 一律 sc-ops:<type> 原样二次分发，
	// 服务端新增无需改前端分发层
	EventApprovalPending  = "approval.pending"
	EventApprovalResolved = "approval.resolved"
	EventInputRequest     = "input.request"
	EventInputResolved    = "input.resolved"
	// EventTerminalsChanged 终端会话全量快照（创建/关闭/改名/自行退出），
	// 前端 tab 列表与会话管理页对账的唯一实时通道
	EventTerminalsChanged = "terminals.changed"
	// EventPreviewPort dev 端口探测/上报（服务端被动探测 source:detected +
	// agent ops-notify 主动上报双源，发布口强类型校验）
	EventPreviewPort = "preview.port"
	// EventQueueChanged 排队指令弹出（queueEngine.sendHead 弹队首成功后），
	// 载荷 {sessionId, remaining}——侧栏队列徽标与行内面板的唯一实时感知通道
	// （P-20261006-46 收编：此前是服务端最后一个裸串广播点）
	EventQueueChanged = "queue.changed"
	EventOpenFileAt   = "open-file-at"
	// EventClipboardArrived 跨设备剪贴板中继（P-20261002-32）：设备 POST /api/clip
	// 成功即广播，载荷 {origin,size,at}——内容不上广播面（留在服务端单槽，接收方
	// 经 GET /api/clip 读取即焚）；origin 是发送方设备 id，前端接收侧据此跳过
	// 发送方自身设备的 toast
	EventClipboardArrived = "clipboard.arrived"
	// EventChainTriggered 会话接续链触发（P-20261004-38）：链源会话终态命中
	// 链定义并成功拉起下一棒后广播——agent 感知自己被链拉起（自动化闭环），
	// 前端链列表管理面板据此外部触发刷新
	EventChainTriggered = "chain.triggered"
	// EventTerminalMessage 会话间定向消息到达（P-20261004-68）：POST
	// /api/ops-message 投递成功即广播，载荷 {from,to,summary,at}——summary 是
	// 正文首行速览（≤80 rune，全文只在收件箱 GET 面）。前端据此点亮目标会话
	// 的 tab 未读徽标；agent 脚本监听同一事件可免轮询感知留言到达
	EventTerminalMessage = "terminal.message"
	// EventTerminalMessageRead 收件箱已读（P-20261004-68）：GET /api/ops-message
	// 拉取到新留言后广播，载荷 {sessionId,count}——前端未读徽标清除的唯一感知
	// 通道（拉取是 agent 侧动作，前端不轮询收件箱面）
	EventTerminalMessageRead = "terminal.message.read"
	// EventTaskRelaySkipped 定时任务接力降级（P-20261005-207）：cron 到期触发
	// 配置了接力源（relayFrom）但取不到结论/源会话不存在/配额不够——任务如实
	// 无前言照常启动（自动化容错优先，不因接力失败停摆），事件携原因供监控
	// 感知「自动续命断链」。agent 监控脚本/运维面板消费，前端暂无消费者
	EventTaskRelaySkipped = "task.relaySkipped"
	// EventExperimentChanged 对比实验状态迁移（P-20261004-33）：完成链回执
	// 落位使 running 实验任一侧 Result 变化（双侧齐备即翻 ready）后广播，载荷
	// {id,status,resultA,resultB}——前端实验面板事件即时对账（轮询降级保留），
	// agent 自动化脚本可监听同一事件感知竞写进度（免 5s 轮询详情）
	EventExperimentChanged = "experiment.changed"
	// EventWatchInvite 直播邀请（P-20261005-165）：agent 开完终端直播（POST
	// /api/share/terminal）后经 ops-notify 上报，载荷 {title?,body?,url}——
	// url 必填且限 /s/<token> 访客短链路径形态（发布口白名单校验，反钓鱼
	// 边界）。前端桥接为通知中心带动作条目（action='url'，点击新窗打开访客
	// 直播页）——agent「请人来看」的 human-pull 原语
	EventWatchInvite = "watch.invite"
	// EventNotifyPersist 通知入账原语（P-20261007-10）：agent 经 ops-notify
	// 上报，服务端发布口校验后直调 notification.Add 入账（跨设备可见 + webhook
	// 外发 + 历史留痕，与系统通知同库同偏好过滤），并沿 ops-notify 既有出口
	// 广播本事件供前端 bridge 做实时弹面（toast）。载荷 {title, body?, level?,
	// action?, actionPayload?}——action 白名单收敛自通知 Action 既有枚举
	// （terminal/panel/url/preview，发布口逐动作校验 actionPayload 形态）；
	// agent-fix 等人裁决面动作不对 agent 开放。preview.port 特例（前端入账）
	// 的通用化收编：服务端入账才有多端/webhook 一致性
	EventNotifyPersist = "notify.persist"
	// EventNotesUpdated 笔记库已变（P-20261107-2 多篇笔记 → P-20261108-3 单库化）：
	// 服务端在笔记写路径（/api/notes 族 create/update/delete/restore/purge）与
	// 单库化迁移有迁入时（启动期/手动续迁/项目删除前）成功后广播，载荷
	// {projectId,noteId,action,origin?}——projectId 为作用域键（全局库恒为保留哨兵
	// "_global"，字段名沿用多篇时代的项目维度命名、形状不变）；action ∈ saved|
	// created|renamed|trashed|restored|purged|migrated；noteId 为空 = 作用域全部
	// 篇可能已变（迁移批量并入，消费方重拉清单）。origin（P-20261111-4 S1 回声
	// 抑制）= 写请求 X-Notes-Origin 头的客户端窗口 nonce 原样回带，前端收到同
	// nonce 即跳过（本窗自动保存的回声不触发整篇重读打断连续输入）；迁移广播与
	// 旧客户端请求无 origin，按外部更新处理向后兼容。仅元数据上广播面（标题/内容
	// 不上——terminal.message 同纪律）；消费方收到即拉取服务端真值，不信任载荷
	// 内容。前端直通分发 sc-ops:notes.updated，笔记面板合并到既有
	// sc:notes-external-update 内部事件消费（per-note 粒度）。sync 笔记单元落位
	// 广播点随单元退役（P-20261108-3）下线
	EventNotesUpdated = "notes.updated"
	// EventLocateInTree 文件树定位（P-20261022-3 新增 agent 可发形态）：agent 经
	// ops-notify 上报，载荷 {path?,projectId,focus?}（path 可空 = 项目根，非空须
	// 项目相对正斜杠无 .. 段；发布口注册表校验）——文件树逐层展开 + 滚动高亮，
	// 给「文件在哪」的结构上下文，与 open-file-at「文件内容」分工。前端直通分发
	// sc-ops:locate-in-tree 恰与既有前端内部窗口事件常量 OPS_LOCATE_IN_TREE
	// 精确一致（open-file-at 同款双栖恒等，存量例外登记见 archguard
	// ops-events 快照 legacyEventNames），FileTreeView 既有接收链消费，
	// 侧栏不在 files 视图由 useLayoutViews 兜底适配层先切视图再重派发
	EventLocateInTree = "locate-in-tree"
	// EventFrontendDownload 交付物下载原语（P-20261023-4）：agent 经 ops-notify
	// 上报，载荷 {path, projectId}（发布口注册表校验：path 必填项目相对正斜杠
	// 无 .. 段、projectId 必填，同 open-file-at 口径）——前端以隐藏 <a download>
	// 指向既有文件下载端点（GET /api/projects/:id/file/download，Content-Disposition
	// 净化链既有）直接弹出浏览器下载框。协议从「引导注意力」升维「执行浏览器
	// 动作」的首批原子之一；滥用对策=发布口既有 60 条/分钟限流 + 前端效应面
	// 独立预算 + 必带可见 toast（无静默效应），见 agentops 注册表手册文案
	EventFrontendDownload = "frontend.download"
	// EventFrontendClipboard 剪贴板直写原语（P-20261023-4）：agent 经 ops-notify
	// 上报，载荷 {text}（非空 ≤32KB——与跨设备中继槽 clipMaxBytes 同界，直写
	// 失败的回落链写该槽，校验上限对齐保证回落链零二次拒绝）——前端
	// copyText 直写用户剪贴板。**剪贴板投毒（诱导用户粘贴恶意命令）是本原子
	// 最大滥用面，四层收口**：写入前必带可见 toast 预告（敏感值遮蔽+截断预览，
	// 无静默写入）→ 预览截断 → 设置按原子开关（默认开）→ 限频；writeText
	// 失败（焦点/权限浏览器边界）回落 P-20261002-32 中继链（写服务端单槽 +
	// 点击读取即焚 toast）——功能不缺失只是多一次点击
	EventFrontendClipboard = "frontend.clipboard"
	// EventFrontendOpen 开标签原语（P-20261023-4）：agent 经 ops-notify 上报，
	// 载荷 {url}（发布口注册表校验：http(s) 绝对外链 scheme 白名单拒伪协议，
	// 同 notify.persist action=url 口径）——前端 window.open noopener 新标签
	// 打开。popup blocker 是浏览器边界不硬求：被拦时回落通知中心 action=url
	// 条目（既有形态），用户点击开——功能不缺失只是多一次点击
	EventFrontendOpen = "frontend.open"
	// EventFrontendReload 重载原语（P-20261111-3，frontend 动词族第四原子）：
	// agent 经 ops-notify 上报，载荷 {scope}（发布口注册表校验：page|view 可选
	// 枚举，缺省规整 page）——page=location.reload() 整页重载；view=当前路由
	// 整树 remount（前端 RouterView :key 翻转，路由/URL 零变化，与实例切换
	// 同机制）。动机：配置推送/批量写后「要求前端重取全量状态」此前只能两跳
	// navigate 绕行（跳走再跳回，带路由副作用），一跳直达。未保存编辑有
	// IndexedDB 草稿自动保存（2s 防抖）+ scope=page 时既有 beforeunload
	// 确认框兜底（用户可取消），滥用对策沿 frontend 动词族四层收口
	EventFrontendReload = "frontend.reload"
	// EventShareDrop 协作素材到达（P-20261024-1）：访客经分享协作通道上传
	// 素材成功后广播一次，载荷 {token,shareName,terminalId?,id,name,size,kind,
	// nick?}（仅元数据——内容不上广播面，terminal.message 同纪律）。前端
	// 直通分发 sc-ops:share.drop（通知中心另有带行内动作的入账条目，两路
	// 消费面独立）；agent 监听同一事件自动感知协作素材到达（读 drops 清单
	// → 按主人确认读路径分析）
	EventShareDrop = "share.drop"
	// EventShareWritableTyping 可写分享访客输入中（P-20261106-8）：访客经
	// 可写分享的 WS 上行桥接入/断开（或开关关闭清场）即广播，载荷 {token,
	// shareName,terminalId,active,visitors,nick?,visitorTail?}（仅元数据）。
	// 前端直通分发 sc-ops:share.wtyping → 刷新「访客输入中」会话行徽标
	// （useDirectInputShares bump 即时对账，15s 轮询是断线兜底）。与 terminal
	// 会话的 directInputHold 输入闸同源联动——徽标亮起即 owner 键盘已让位
	EventShareWritableTyping = "share.wtyping"
	// EventSharePasteReview 可写分享粘贴审批（P-20261106-8）：访客整块输入
	// 命中 commandrisk danger 档即广播（未批不注入 PTY），载荷 {token,
	// shareName,terminalId,pasteId,summary,preview,visitorTail,at}。preview
	// 是粘贴块头部预览（≤200 rune 原样——访客输入不做脱敏，owner 审批要
	// 看到真实命令才能裁决）。前端直通分发 sc-ops:share.paste-review →
	// 审批卡（批准/拒绝两动作，60s 不决自动拒绝）
	EventSharePasteReview = "share.paste-review"

	// EventRemoteAccessStatus 远程接入（SSH 反向隧道）状态迁移（P-20261019-11）：
	// 启动/停止/首次失败/断线重连/重连成功/重连失败每次迁移广播一次，载荷为
	// ReverseStatus 快照 + at——前端设置·远程接入分区即时刷新状态与最近错误，
	// agent 监听同一事件感知「公网入口还活着吗」（免轮询 GET /remoteaccess/tunnel）。
	// 直通分发语义（sc-ops:remoteaccess.status），source 恒为服务端
	EventRemoteAccessStatus = "remoteaccess.status"

	// EventAgentGroupsChanged 终端会话自定义分组结构变更（P-20261111-1-S3）：
	// agent 分组操作面（/api/terminals/session-groups 族建组/改名/删组/移入/
	// 移出）写 uiState 成功后广播，载荷恒空——消费方收到即拉全量（settings.changed
	// 同纪律，不信任载荷内容）。前端 useOpsChannel 显式 case 映射到既有窗口事件
	// OPS_AGENT_GROUPS_CHANGED（sc-ops:agent-groups-changed——窗口事件名早于本
	// 服务端事件存在：工作区预设恢复链 P-20261004-79 的前端内部事件升级为服务端
	// 可播，window 事件名保持连字符旧形态不走直通恒等），落到
	// useAgentTerminalGroups 既有外部变更重读链就地跟随；该窗口事件的原派发源
	// （前端预设恢复链）与本服务端广播并存互不排斥。source 恒为服务端
	EventAgentGroupsChanged = "agent.groups.changed"

	// EventRateLimited 限流回告：system: 保留前缀仅服务端可发（同上
	// SystemEventPrefix），前端无消费者不受扰
	EventRateLimited = SystemEventPrefix + "rate-limited"
)

// RateLimitedNotice system:rate-limited 回告事件载荷（唯一事实源）：告知触限方
// 限流参数与当前窗口已丢弃条数。此前 ops-notify（ai/opsentry.go）与定向消息
// （opsmessage/api.go）各自维护同形私有结构体，P-20261004-124 搜索限流成为第三
// 个广播点时收编至此——载荷 json 形状不变（线上协议只增不改），消费方一套解析
// 逻辑多点通用。type 走 system: 保留前缀（发布口拒绝 agent 伪造，仅服务端可发）；
// 前端未知类型按 sc-ops:<type> 直通分发，无消费者不受扰
type RateLimitedNotice struct {
	Dimension string `json:"dimension"` // 限流维度：session / token / ip / project
	Key       string `json:"key"`       // 维度取值（原始 sessionId / 令牌标识 / 项目 id 等）
	Dropped   int    `json:"dropped"`   // 当前窗口已丢弃（静默丢弃或 429 拒绝）条数
	Limit     int    `json:"limit"`     // 窗口内放行上限
	WindowSec int    `json:"windowSec"` // 窗口长度（秒）
}
