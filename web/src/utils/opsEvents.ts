// 智能操作通道派发的 window 事件名（useOpsChannel → 各视图订阅）
export const OPS_PROJECTS_CHANGED = 'sc-ops:projects-changed'
export const OPS_SETTINGS_CHANGED = 'sc-ops:settings-changed'
export const OPS_NAVIGATE = 'sc-ops:navigate'

/**
 * OPS_NAVIGATE 事件 detail（ops-notify navigate 载荷，P-20261005-223 四目标形态）：
 * agent 完成工作后的「注意力引导」——按字段首命中分发（path 向后兼容保留）：
 * - {path}：路由跳转（既有形态，须以 / 开头）
 * - {file, line?, project?}：文件直达（落成文件深链 query，复用「切项目+打开+行定位」既有链）
 * - {view:'diff', file, project?}：该文件 vs HEAD 工作区 diff 直达（diff=1 深链变体；
 *   与纯 {file} 形态同携 file 字段，首命中按 view 判别——diff 分支先于 file 分支）
 * - {view:'changes'}：变更面板聚焦（ensure-open 语义，与 panel 事件的 toggle 区分）
 * - {terminalId}：会话聚焦（审批卡「查看发起会话」同一跳转链）
 * 未知形态宽容忽略（开放词表同哲学）+ debug 留痕
 *
 * 原子能力注册表（P-20261022-3，server/agentops/capabilities.go）把上述五形态
 * 收编为 navigate.path/file/diff/changes/terminal 五原子——本接口字段与注册表
 * 快照的对账见 __tests__/utils/presentAtoms.test.ts（字段增删不同步即红）
 */
export interface NavigateDetail {
  /** 路由深链（向后兼容首形态） */
  path?: string
  /** 项目相对路径（正斜杠）——文件/diff 直达形态的定位目标 */
  file?: string
  /** 行号（≥1 整数；仅 file 打开形态消费，diff 形态无行定位语义忽略） */
  line?: number
  /** 项目 id（file/diff 形态可选；缺省 = 当前项目，携带且不同 = 先切项目——
   * 深链 ?project= 既有切项目链承接） */
  project?: string
  /** 视图直达目标：'changes' = 变更面板；'diff' = file 字段所指文件的工作区 diff */
  view?: 'changes' | 'diff'
  /** 终端会话 id——会话聚焦（含会话已结束 toast 降级与切项目时序） */
  terminalId?: string
}
export const OPS_NOTIFY = 'sc-ops:notify'
// AI 助手任务进度（底层智能体经 /api/ops-notify 上报，悬浮窗实时渲染）
export const OPS_TASK_PROGRESS = 'sc-ops:task.progress'
// 打开指定面板 {"name":"files|changes|git|terminal"}（智能体驱动界面布局）
export const OPS_PANEL = 'sc-ops:panel'
// 智能体操作审批（B4 约定式）：后端经 /api/ops-confirm 广播 approval.*，
// useOpsChannel 对未列举 type 直通分发为 sc-ops:<type>
export const OPS_APPROVAL_PENDING = 'sc-ops:approval.pending'
export const OPS_APPROVAL_RESOLVED = 'sc-ops:approval.resolved'
// 智能体结构化提问（P-20261001-27）：agent 经 POST /api/ops-ask 提问广播
// input.request（载荷为完整记录）；作答后广播 input.resolved 多标签页一致清账。
// 直通分发语义同上（sc-ops:input.request / sc-ops:input.resolved）
export const OPS_INPUT_REQUEST = 'sc-ops:input.request'
export const OPS_INPUT_RESOLVED = 'sc-ops:input.resolved'
// 预览端口直达（P-20261002-70）：agent 把 dev server 跑起来后经
// POST /api/ops-notify 上报 preview.port（载荷 {port, label?}，服务端已校验
// 1024~65535），前端桥接为「通知中心带动作条目 + 悬浮球快捷按钮」一键打开
// 底部预览面板。直通分发语义同 approval.*（sc-ops:preview.port）
export const OPS_PREVIEW_PORT = 'sc-ops:preview.port'

/** OPS_PREVIEW_PORT 事件 payload（服务端已校验；前端消费口仍防呆复验） */
export interface PreviewPortDetail {
  /** 回环端口（1024~65535）。hostId 缺省 = 本机实例端口；携带 hostId 时为
   * 远端主机回环端口（前端据此开 SSH 隧道拿本机映射口再进预览面板） */
  port?: number
  /** 服务简称（如 "vite dev server"），通知文案原样展示 */
  label?: string
  /** 来源标注（P-20261002-83）："detected" = 终端输出被动探测命中（弱化展示）；
   * 缺省 = agent 经 ops-notify 主动上报。该字段由服务端就地标注，
   * ops-notify 发布口对载荷强类型规整，外部 agent 无法伪造 */
  source?: string
  /** 远程主机 ID（P-20261004-5）：服务跑在远程主机终端时携带——port 走
   * SSH 隧道映射（remote:N → local:M 徽标），缺省 = 本机实例端口直达 */
  hostId?: string
}
// 终端会话列表变更快照（后端 create/close/rename 后广播；payload.sessions 全量快照，
// 终端会话管理页与底部终端 tab 据此实时对账）
// 注：useOpsChannel 对未列举 type 走 sc-ops:<type> 直通分发，故常量即 'sc-ops:terminals.changed'
export const OPS_TERMINALS_CHANGED = 'sc-ops:terminals.changed'
// 排队指令队列已变（P-20261003-248）：回执引擎自动发送（弹队首）后广播，
// detail = { sessionId, remaining }。弹出先于广播——消费方收到即拉全量，
// 天然读到发送后队列态（与 task.progress 前端自行刷新赛跑会读到旧值，实测
// 踩过的坑）。直通分发语义同 terminals.changed（sc-ops:queue.changed）
export const OPS_QUEUE_CHANGED = 'sc-ops:queue.changed'
// 会话接续链触发（P-20261004-38）：链源会话终态命中链定义并成功拉起下一棒后
// 服务端广播，detail = { chainId, sourceTerminalId, status, sessionId, runtime }。
// 链列表面板（AgentChainPanel）打开期间据此外部触发重读列表；agent 自动化
// 脚本亦可在 ops-channel 上监听同一事件感知接力进度。
// 直通分发语义同 terminals.changed（sc-ops:chain.triggered）
export const OPS_CHAIN_TRIGGERED = 'sc-ops:chain.triggered'
// 会话间定向消息到达（P-20261004-68）：某会话向目标会话投递留言成功后服务端
// 广播，detail = { from, to, summary, at }。summary 是正文首行速览（≤80 rune），
// 全文只在收件箱 GET 面（消息正文敏感面与 ask/notify 同级，不上广播）。
// 消费 = 接收会话的 tab 未读徽标（terminal-sessions store markUnread，可见
// 会话内部跳过）。直通分发语义同 terminals.changed（sc-ops:terminal.message）
export const OPS_TERMINAL_MESSAGE = 'sc-ops:terminal.message'
// 收件箱已读（P-20261004-68）：目标会话 GET /api/ops-message 拉取到新留言
// （拉取即读）后服务端广播，detail = { sessionId, count }——未读徽标清除的
// 唯一感知通道（拉取是 agent 侧动作，前端不轮询收件箱面防互抢）。
// 直通分发语义同上（sc-ops:terminal.message.read）
export const OPS_TERMINAL_MESSAGE_READ = 'sc-ops:terminal.message.read'

/** OPS_TERMINAL_MESSAGE 事件 detail（服务端广播载荷，仅元数据与首行摘要） */
export interface TerminalMessageDetail {
  /** 发送方会话 id（X-Session-ID 头，CC_TERMINAL_ID 同一命名空间） */
  from?: string
  /** 目标会话 id（徽标挂靠锚点） */
  to?: string
  /** 正文首行速览（≤80 rune） */
  summary?: string
  /** 投递时刻（epoch ms） */
  at?: number
}

/** OPS_TERMINAL_MESSAGE_READ 事件 detail（服务端广播载荷） */
export interface TerminalMessageReadDetail {
  /** 拉取方会话 id（徽标清除锚点） */
  sessionId?: string
  /** 本次拉取到的留言条数 */
  count?: number
}
// 对比实验状态迁移（P-20261004-33）：完成链回执落位（任一侧 Result 变化，
// 双侧齐备即翻 ready）后服务端广播，detail = { id, status, resultA, resultB }。
// 实验面板打开期间据此即时重拉对账（5s 轮询降级保留，兜断线窗口）；agent
// 自动化脚本可在 ops-channel 上监听同一事件感知竞写进度。
// 直通分发语义同 terminals.changed（sc-ops:experiment.changed）
export const OPS_EXPERIMENT_CHANGED = 'sc-ops:experiment.changed'

/** OPS_EXPERIMENT_CHANGED 事件 detail（服务端广播载荷，result 为 done/failed/error:<msg>） */
export interface ExperimentChangedDetail {
  /** 实验 id（cmp-<unixnano>，对账锚点） */
  id?: string
  /** 实验整体状态：running（单侧回执落位）/ ready（双侧齐备） */
  status?: string
  /** A 侧终结回执（迁移后） */
  resultA?: string
  /** B 侧终结回执（迁移后） */
  resultB?: string
}

// 远程接入（SSH 反向隧道，P-20261019-11）：状态机每次迁移广播一次（服务端
// remoteaccess 模块）。设置·远程接入分区据此即时刷新；agent 监听同一事件
// 感知公网入口存活/重连，免轮询 GET /api/remoteaccess/tunnel。
// 直通分发语义同 terminals.changed（sc-ops:remoteaccess.status）
export const OPS_REMOTE_ACCESS_STATUS = 'sc-ops:remoteaccess.status'

/** OPS_REMOTE_ACCESS_STATUS 事件 detail（服务端广播载荷，无凭据字段） */
export interface RemoteAccessStatusDetail {
  /** 迁移事件名：started / stopped / failed / reconnecting / reconnected / reconnect_failed */
  event?: string
  /** 状态机：stopped / connecting / online / reconnecting / failed */
  state?: string
  profileId?: string
  remoteBindHost?: string
  remotePort?: number
  publicUrl?: string
  startedAt?: string
  onlineSince?: string
  lastError?: string
  lastErrorAt?: string
  reconnectAttempts?: number
  activeConnections?: number
  totalConnections?: number
  droppedConnections?: number
  /** 广播时刻（epoch ms） */
  at?: number
}

/** OPS_CHAIN_TRIGGERED 事件 detail（服务端 trigger.go 广播载荷） */
export interface ChainTriggeredDetail {
  chainId: string
  sourceTerminalId: string
  /** 链源终态：done / failed（后者仅 onFailure=true 链） */
  status: string
  /** 拉起的下一棒会话 ID */
  sessionId: string
  runtime?: string
}
// 激活指定终端会话（任务运行器创建任务终端后广播）：detail = { id, locateQuery? }。
// 接收方（TerminalView）以待激活队列应用——广播对账追加 tab 的时序可能
// 晚于本事件，命中前先挂起
export const OPS_ACTIVATE_TERMINAL = 'sc-ops:activate-terminal'

/** OPS_ACTIVATE_TERMINAL 事件 detail（id 寻址必填；其余可选扩展向前兼容） */
export interface ActivateTerminalDetail {
  /** 目标终端会话 id */
  id?: string
  /** 跨会话输出检索点选携带（P-20261005-9）：落会话后按查询词做会话内定位
   * （scrollToLine + 选区高亮，terminalOutputLocate 轮询消费）。缺省 = 既有
   * 纯激活语义，审批卡/通知等既有派发方零改动 */
  locateQuery?: string
}
// 文件被外部改写（全工程替换等）：detail = { paths: string[] }。
// useOpenFiles 对其中已打开且无未保存修改的文件从磁盘重读，避免陈旧
// 内存内容在下次保存时覆盖外部修改
export const OPS_FILES_EXTERNAL_CHANGE = 'sc-ops:files-external-change'
// 多实例同步进度（P-20261023-1）：服务端经通知 WS 广播 sync.progress 消息
//（500ms 节流），notification store 按类型分发为本窗口事件——同步中心面板
// 监听渲染总进度/单元状态机（手动/定时/多标签页共享同一进度事实）
export const OPS_SYNC_PROGRESS = 'sc-ops:sync-progress'
// 文件保存成功落盘（编辑器保存链 writeOpenFile/草稿转正）：detail = { paths: string[] }。
// 与 OPS_FILES_EXTERNAL_CHANGE 对偶——同族「磁盘状态已变」广播，编辑器
// gutter 变更条（P-20261003-14）等磁盘状态消费方据此刷新标记
export const OPS_FILES_SAVED = 'sc-ops:files-saved'
// 终端文件链接激活（xterm 自定义链接层点击 → Layout 打开编辑器标签，纯前端内部事件）。
// P-20261003-287 起同为 ops-notify 内置事件 open-file-at 的直通分发目标（agent 改完
// 文件引导用户注意力，服务端发布口已校验 path/projectId/line/col 形态）——
// useOpsChannel 对未列举 type 走 sc-ops:<type> 直通分发，常量名恰与事件 type 精确一致。
// detail.path 为项目相对路径（正斜杠）、projectId 为链接解析时会话归属的注册项目；
// 接收方（useLayoutViews）必要时先切项目再复用「打开文件 + 行定位」既有链路
export const OPS_OPEN_FILE_AT = 'sc-ops:open-file-at'
// 跨设备剪贴板中继（P-20261002-32）：另一设备 POST /api/clip 写入成功后服务端
// 广播（内容不上广播面——留在服务端内存单槽，接收方点击 toast 经 GET /api/clip
// 读取即焚落入本地剪贴板）。直通分发语义同 terminals.changed（sc-ops:clipboard.arrived）
export const OPS_CLIPBOARD_ARRIVED = 'sc-ops:clipboard.arrived'
// 直播邀请（P-20261005-165）：agent 开完终端直播（POST /api/share/terminal）后
// 经 ops-notify 上报 watch.invite——agent「请人来看」的 human-pull 原语。前端经
// watchInviteNotify 链桥接为通知中心带动作条目（action='url'，点击新窗打开
// 访客直播页）。直通分发语义同 terminals.changed（sc-ops:watch.invite）
export const OPS_WATCH_INVITE = 'sc-ops:watch.invite'

/** OPS_WATCH_INVITE 事件 detail（服务端广播载荷，发布口已校验 url 形态） */
export interface WatchInviteDetail {
  /** 访客短链相对路径（/s/<token> 形态，服务端白名单校验；前端拼分享子服务
   * base 成绝对地址——分享短链住独立端口子服务，相对路径直接打开会落主服务 404） */
  url: string
  /** 邀请标题（可选；缺省走界面默认文案） */
  title?: string
  /** 一句话说明（可选） */
  body?: string
}

// 通知入账原语（P-20261007-10）：agent 经 ops-notify 上报 notify.persist——
// 服务端发布口校验后直调通知中心入账（历史留痕/跨设备/webhook 外发全链生效，
// 与系统通知同库同偏好过滤），本事件只承载实时弹面（toast）。直通分发语义同
// terminals.changed（sc-ops:notify.persist）
export const OPS_NOTIFY_PERSIST = 'sc-ops:notify.persist'

/** OPS_NOTIFY_PERSIST 事件 detail（服务端广播载荷，发布口已校验+遮蔽） */
export interface NotifyPersistDetail {
  /** 通知标题（必填 ≤200 rune，服务端已遮蔽） */
  title?: string
  /** 说明文本（可选；全文只在通知中心条目，弹面不携带） */
  body?: string
  /** 分级（缺省 info，与通知 type 同取值域；error/warning 的桌面提醒由
   * 通知中心既有 watch 承担，弹面不重复） */
  level?: 'info' | 'success' | 'warning' | 'error'
  /** 一键直达动作（白名单 terminal|panel|url|preview，服务端已校验形态） */
  action?: string
  /** 动作目标（terminal=会话 id / panel=面板名 / url=绝对外链 / preview=端口） */
  actionPayload?: string
}

// 协作素材到达（P-20261024-1）：访客经分享协作通道上传成功后服务端广播，
// detail 仅元数据（token/文件名/大小/昵称——内容不上广播面）。前端消费 =
// 「交给当前会话/新会话处理」动作链（useShareDrop，与通知中心行内动作双
// 出口同一链）；agent 监听同一事件自动感知协作素材到达。
// 直通分发语义同 terminals.changed（sc-ops:share.drop）
export const OPS_SHARE_DROP = 'sc-ops:share.drop'

/** OPS_SHARE_DROP 事件 detail（服务端 share.DropEvent 广播载荷，仅元数据） */
export interface ShareDropDetail {
  /** 分享短链标识（回查 GET /api/share/:token/drops 的寻址键） */
  token?: string
  /** 分享展示名（通知/面板展示） */
  shareName?: string
  /** 锚定终端会话 id（kind=terminal 分享携带） */
  terminalId?: string
  /** 素材收件 id */
  id?: string
  /** 净化后的展示名 */
  name?: string
  /** 素材字节数 */
  size?: number
  /** image | file */
  kind?: string
  /** 访客自报昵称（缺省 = 匿名） */
  nick?: string
}

// 可写分享「访客输入中」（P-20261106-8）：访客经可写分享的 WS 上行桥接入/
// 断开（或开关关闭清场）即服务端广播。前端消费 = 刷新「访客输入中」会话行
// 徽标（bumpDirectInputShares 即时对账，15s 轮询是断线兜底）。
// 直通分发语义同 share.drop（sc-ops:share.wtyping）
export const OPS_SHARE_WTYPING = 'sc-ops:share.wtyping'

/** OPS_SHARE_WTYPING 事件 detail（服务端 share.WritableTypingEvent 广播载荷） */
export interface ShareWritableTypingDetail {
  token?: string
  shareName?: string
  terminalId?: string
  /** true = 有访客上行在场；false = 清场（末条断开/开关关闭） */
  active?: boolean
  /** 在场上行连接数 */
  visitors?: number
  nick?: string
  visitorTail?: string
}

// 可写分享粘贴审批（P-20261106-8）：访客整块输入命中 commandrisk danger 档
// 即服务端广播（未批不注入 PTY，60s 不决自动拒绝）。前端消费 = 审批卡
//（批准/拒绝两动作，调 POST /api/share/:token/paste/:pid/decision）。
// 直通分发语义同 share.drop（sc-ops:share.paste-review）
export const OPS_SHARE_PASTE_REVIEW = 'sc-ops:share.paste-review'

/** OPS_SHARE_PASTE_REVIEW 事件 detail（服务端 share.PasteReviewEvent 广播载荷） */
export interface SharePasteReviewDetail {
  token?: string
  shareName?: string
  terminalId?: string
  /** 待批粘贴块 id（决策端点寻址键，crypto/rand 不可预测） */
  pasteId?: string
  /** commandrisk 命中摘要（RiskSummary 一行形态） */
  summary?: string
  /** 粘贴块头部预览（≤200 rune 原样——访客输入不脱敏，审批要看真实命令） */
  preview?: string
  /** 访客摘要（visitorId 前 8 位） */
  visitorTail?: string
  /** 时刻（epoch ms） */
  at?: number
}

// frontend 动词族三原子（P-20261023-4）：协议从「引导注意力」升维「替用户
// 执行浏览器动作」——下载框弹出 / 剪贴板直写 / 新标签开外链。三原子都是
// 用户设备上的即时效应，前端消费链（utils/frontendAtomActions）必带可见
// toast（无静默效应）+ 效应面限频 + 设置按原子开关（stores/opsAtomPrefs，
// 默认开）。直通分发语义同 terminals.changed（sc-ops:frontend.*）
export const OPS_FRONTEND_DOWNLOAD = 'sc-ops:frontend.download'
export const OPS_FRONTEND_CLIPBOARD = 'sc-ops:frontend.clipboard'
export const OPS_FRONTEND_OPEN = 'sc-ops:frontend.open'

/** OPS_FRONTEND_DOWNLOAD 事件 detail（发布口注册表已校验项目相对形态） */
export interface FrontendDownloadDetail {
  /** 项目相对路径（正斜杠，无 .. 段）——下载目标 */
  path: string
  /** 项目 id（下载端点寻址） */
  projectId: string
}

/** OPS_FRONTEND_CLIPBOARD 事件 detail（发布口已校验非空 ≤32KB；载荷逐字
 * 透传不 trim——写进剪贴板的字节须与 agent 意图一致） */
export interface FrontendClipboardDetail {
  /** 待写入文本（展示面才做遮蔽+截断，载荷本身不遮蔽） */
  text: string
}

/** OPS_FRONTEND_OPEN 事件 detail（发布口已校验 http(s) 绝对外链形态） */
export interface FrontendOpenDetail {
  /** 外链 URL（scheme 白名单 http/https，window.open noopener 直开） */
  url: string
}

/** OPS_CLIPBOARD_ARRIVED 事件 detail（服务端广播载荷，无内容字段） */
export interface ClipArrivedDetail {
  /** 发送方设备 id（前端生成；接收侧据此跳过发送方自身设备的 toast） */
  origin?: string
  /** 内容字节数（toast 提示与调用方感知用） */
  size?: number
  /** 写入时刻（epoch ms） */
  at?: number
}

/** OPS_OPEN_FILE_AT 事件 detail（直通分发形态即 ops-notify open-file-at 载荷） */
export interface OpenFileAtDetail {
  /** 项目相对路径（正斜杠；链接层产出已过存在性校验，ops-notify 链仅发布口
   * 形态校验——文件缺失时打开链落空静默） */
  path: string
  /** 会话归属的注册项目 id（链接层已在生成时归属校验过） */
  projectId: string
  /** `:LINE` 行号后缀（缺省 = 无行号，仅打开文件） */
  line?: number
  /** `:COL` 列号后缀 */
  col?: number
  /** 审批卡 target 预览（P-20261003-47）：true = 调用方已探测到该文件有未提交
   *  差异，直开 vs HEAD 差异视图而非文件本身；缺省 = 既有打开行为不变 */
  diffVsHead?: boolean
}
// 终端面板「在文件树中定位」（P-20261001-32）：终端工具条按钮派发，接收方
// （FileTreeView）保证文件侧栏可见后按路径逐层展开 + 滚动定位。
// 与文件链接层同口径：定位目标是会话当前 dir（P-20261004-59 OSC 7 实时
// 追踪 currentDir，无帧回落创建 dir）。
// P-20261022-3 起同为 ops-notify 内置事件 locate-in-tree 的直通分发目标
// （agent 上报「在树里定位」，服务端注册表校验 path/projectId/focus）——
// 常量名恰与事件 type 精确一致（open-file-at 同款双栖恒等）；侧栏不在 files
// 视图时由 useLayoutViews 兜底适配层先切视图再重派发。
// 原子注册表 id = present.tree（server/agentops/capabilities.go）
export const OPS_LOCATE_IN_TREE = 'sc-ops:locate-in-tree'

/** OPS_LOCATE_IN_TREE 事件 detail */
export interface LocateInTreeDetail {
  /** 项目相对路径（正斜杠；空串 = 项目根本身） */
  path: string
  /** 定位目标归属的项目 id（接收方与当前项目不符时忽略） */
  projectId: string
  /** 落点后把键盘焦点移到树列表（P-20261020-8）：分享管理器「新建分享」
   *  等「把人送到树里自己选」的入口用；缺省 false = 既有定位不抢焦点 */
  focus?: boolean
}
// 一键重置布局的树展开复位（P-20261002-74，纯前端内部事件）：重置方先清
// localStorage 展开键再派发，接收方（FileTreeView）挂载中就地处收起全部目录；
// 树未挂载（侧栏在 changes 视图等）时无人监听，清键已覆盖该形态
export const OPS_COLLAPSE_TREE = 'sc-ops:collapse-tree'
// 笔记已被外部写回（P-20261003-292「沉淀到笔记」等前端内部事件 + 服务端
// notes.updated 直通分发 sc-ops:notes.updated 的统一消费面——P-20261107-2 起
// 升 per-note 粒度）：detail = { projectId, noteId?, action?, focus? }。接收方
// （useNotesMulti）在无未保存编辑时从服务端重读清单与当前篇——面板若带着旧
// 内容继续编辑，防抖保存会整体覆盖外部写入（baseUpdatedAt 409 兜底 + 重读
// 双防线；有挂起编辑时只刷清单，内容让位人的输入）
export const NOTES_EXTERNAL_UPDATE = 'sc:notes-external-update'
// 服务端 notes.updated 直通分发（P-20261107-2）：笔记写路径（/api/notes 族 +
// P-20261108-3 单库化迁移有迁入时）广播 {projectId,noteId?,action}——面板与
// NOTES_EXTERNAL_UPDATE 合并消费（onExternalUpdate 统一入口）
export const OPS_NOTES_UPDATED = 'sc-ops:notes.updated'

/** NOTES_EXTERNAL_UPDATE 事件 detail（noteId 缺省 = 作用域级清单变更） */
export interface NotesExternalUpdateDetail {
  /** 作用域键：P-20261108-3 单库化后恒为笔记库哨兵 '_global'（字段名沿用
   *  多篇时代的项目维度命名——旧服务端/旧形态带项目 id 的事件接收方忽略） */
  projectId: string
  /** 变更篇 id（服务端 notes.updated 携带；前端内部事件可省 = 作用域级） */
  noteId?: string
  /** 变更动作（saved|created|renamed|trashed|restored|purged|migrated；仅观测面，不作为分支依据——消费方一律重拉真值） */
  action?: string
  /** 前端内部事件专用：重拉后聚焦 noteId 篇（沉淀写回「点啥显示啥」——刚追加
   *  的结论节在编辑面可见） */
  focus?: boolean
}

/** OPS_COLLAPSE_TREE 事件 detail */
export interface CollapseTreeDetail {
  /** 目标归属的项目 id（接收方与当前项目不符时忽略） */
  projectId: string
}
// 远程文件「在编辑器打开」（P-20261003-15）：远程文件面板右键动作派发，
// 接收方（useLayoutShell）切回编辑器主区并按 remote:<hostId>:<path> 伪路径
// 开签（视图层级隔着 RemoteConsoleView→RemoteFileManager→RemoteFilePane，
// 窗口事件与 OPS_OPEN_FILE_AT 同款解耦）
export const OPS_REMOTE_OPEN_IN_EDITOR = 'sc-ops:remote-open-in-editor'
// agent 会话组结构已被外部写回（P-20261004-79，纯前端内部事件）：工作区预设
// 恢复链 applyAgentGroups 落盘成功后派发，接收方（useAgentTerminalGroups——
// live 挂载中的会话管理页，home overlay 与 project 内嵌双实例可并存、各自监听）
// 收到即重读 uiState 的 agentTerminal.groups 就地重应用，把「组结构恢复只在
// 下次挂载 boot 生效」的 MVP 边界升级为即时生效。无载荷：消费方收到即拉全量
// （与 OPS_QUEUE_CHANGED 同纪律，读到的是落盘后真值，不信任事件载荷），
// 同 OPS_PROJECTS_CHANGED 的 Event 无 detail 形态
export const OPS_AGENT_GROUPS_CHANGED = 'sc-ops:agent-groups-changed'
// Worktree 列表已变（P-20261005-179，纯前端内部事件）：提交右键「历史检视
// worktree」等跨组件创建动作派发，接收方（GitWorktreesSection）收到即重拉
// 列表——面板自身只挂项目切换 watch，同项目内异组件的创建对其不可见。
// 无载荷：消费方收到即拉全量（OPS_AGENT_GROUPS_CHANGED 同纪律，读到的是
// git 注册表真值，不信任事件载荷）
export const OPS_WORKTREES_CHANGED = 'sc-ops:worktrees-changed'
// 定时任务清单已变（P-20261006-14，纯前端内部事件）：通知中心 cron-retry
// 一键重试成功后派发，接收方（AgentCronSettings——设置·定时任务分区）收到即
// 重拉列表（lastRunAt/lastResult 运行期事实刚被本次重试翻写，面板自身只挂
// 挂载期拉取）。无载荷：消费方收到即拉全量（OPS_WORKTREES_CHANGED 同纪律）；
// 分区未挂载时无人监听，下次打开 fetchCrons 自然读到新值
export const OPS_AGENT_CRONS_CHANGED = 'sc-ops:agent-crons-changed'

/** OPS_REMOTE_OPEN_IN_EDITOR 事件 detail */
export interface RemoteOpenInEditorDetail {
  /** 远程主机 ID（保存回写寻址键） */
  hostId: string
  /** 远端绝对路径（POSIX） */
  path: string
}

// 文件监听降级轮询兜底状态迁移（P-20261006-34）：服务端经通知 WS 广播
// watch.fallback 消息，notification store 按类型分发为本窗口事件——状态栏
// 「轮询降级中」微标据以显隐。降级是持续态，可见性不靠一次性通知记忆；
// 旧后端（无广播/无端点）由页面加载快照拉取兜底，不做高频轮询
export const OPS_WATCH_FALLBACK = 'sc-ops:watch-fallback'

/** OPS_WATCH_FALLBACK 事件 detail（GET /api/watch/fallback 响应体同形） */
export interface WatchFallbackDetail {
  /** true = 轮询兜底生效中 */
  enabled?: boolean
  /** auto（配额耗尽自动启用）/ manual（用户手动开启）；未启用为空 */
  source?: 'auto' | 'manual' | ''
  /** RFC3339，本段降级开始时刻 */
  since?: string
}
