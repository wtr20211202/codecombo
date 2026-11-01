// 终端域 API
import type { AxiosRequestConfig } from 'axios'
import api from '../http'
import { getCurrentInstanceContext } from '../http'

// 终端
export const terminalApi = {
  // extra.dir = 会话工作目录（P-20261005-192 目录级终端直达）：项目根内子目录
  //（相对/绝对均可，缺省 = 项目根）。须已存在且在项目根内——越界/缺失服务端
  // 400 稳定原文（KNOWN_ERROR_I18N 既有映射），调用方无需自行校验
  create: (projectId: string, name?: string, config?: AxiosRequestConfig, extra?: { dir?: string }) =>
    api.post(`/terminals`, { projectId, name, ...(extra?.dir ? { dir: extra.dir } : {}) }, config),
  // 全局终端（kind=agent）：免项目绑定，后端注入回调环境变量并拉起底层运行时
  //（runtime 空 = 设置默认/自动按可用性；claude/codex/dsh）
  // extra.dir = 工作目录（Claude 会话恢复场景传会话 cwd）；
  // extra.launchArgs = 追加参数（如 --resume <sessionId>，上限 500 字符）；
  // extra.shell = 会话级 shell 覆盖（P-20261004-57，仅纯终端 runtime=shell 生效，
  // 空缺省 = 跟随设置 terminal.defaultShell / 平台缺省）
  createAgent: (name?: string, runtime?: string, config?: AxiosRequestConfig, extra?: { dir?: string; launchArgs?: string; shell?: string }) =>
    api.post(`/terminals`, { kind: 'agent', name, runtime, ...(extra ?? {}) }, config),
  // 运行时选项清单（会话创建对话框用）：注册顺序 {name, displayName, available, version, defaultCommand, customCommand}
  // displayName 为自定义智能体的展示名（内置运行时为空，展示回落 name）
  listAgentRuntimes: (config?: AxiosRequestConfig) => api.get('/agent-runtimes', config),
  // 平台 shell 候选探测（P-20261004-57）：设置页「默认 shell」下拉与会话创建
  // 对话框「高级 · shell」共用候选来源。platform=服务端 GOOS；settingShell=
  // 设置里保存的原文（空 = 跟随平台缺省）；defaultShell=当前实际生效值；
  // candidates=[{name,path,available}]（LookPath 探测，unavailable 项置灰展示）
  listShellCandidates: (config?: AxiosRequestConfig) => api.get('/terminals/shell-candidates', config),
  // 舰队批量发起（P-20261003-291）：逐项目创建 agent 会话（dir=项目根、同一
  // prompt——超 500 字节服务端保尾截断），单项目失败逐条回告 skipped 不中断编队
  bulkAgent: (projectIds: string[], prompt: string, runtime?: string, config?: AxiosRequestConfig) =>
    api.post('/terminals/bulk-agent', { projectIds, prompt, runtime }, config),
  // 会话产出（B3）：startHead..工作区 diff 摘要（纯 shell/非 git 目录 404）。
  // since = 审阅基线标记时间戳（P-20261003-217，RFC3339Nano 原文回传）——
  // diff 范围从 startHead 换到该标记（服务端按时间戳 rev-list 解析基点）
  activity: (id: string, config?: AxiosRequestConfig, since?: string) =>
    api.get(`/terminals/${id}/activity`, { params: since ? { since } : undefined, ...config }),
  // 标记审阅基线（P-20261003-217）：当前时点记为该会话的阶段审阅基线
  //（时间戳 + HEAD 参考快照落会话元数据），返回该会话全部标记
  markReviewBaseline: (id: string, config?: AxiosRequestConfig) =>
    api.post(`/terminals/${id}/review-mark`, null, config),
  // 敏感标记（P-20261003-155）：人工策展的安全标注落会话元数据，导出/分享
  // 出域命中时服务端回 warnings、前端确认后带 override 二次请求（幂等）
  setSensitive: (id: string, sensitive: boolean, config?: AxiosRequestConfig) =>
    api.post(`/terminals/${id}/sensitive`, { sensitive }, config),
  // 任务事件历史（B6）：task.progress / approval.* 落库流，最新在前
  listAgentTasks: (limit = 50, sessionId = '', config?: AxiosRequestConfig) =>
    api.get(`/agent-tasks`, {
      ...config,
      // axios 1.20 收紧 params 泛型推断：显式按 AxiosRequestConfig 断言
      params: { limit, sessionId },
    } as AxiosRequestConfig),
  // 会话清单（P-20261005-145）：fleet=<batchId> 可选按编队批过滤（服务端元数据
  // 精确匹配；非编队/未知批为空列表）——编程追踪编队的查询原语，值班聚合卡
  // 走全量快照自分组不经此参数
  list: (fleet?: string, config?: AxiosRequestConfig) =>
    api.get('/terminals', { params: fleet ? { fleet } : undefined, ...config }),
  // 外部 tmux 会话列举（P-20261005-189）：服务器上用户默认 socket 的既有会话
  //（SSH attach 的那种、nohup 挂着的任务）。available=false = tmux 不可用
  //（前端隐藏接管入口）；takenOver=true = 已被本系统接管（置灰防重复）
  listExternalSessions: (config?: AxiosRequestConfig) =>
    api.get<ExternalSessionsBody>('/terminals/external-sessions', config),
  // 接管外部 tmux 会话（创建变体 attach 模式）：attach 用户默认 socket 上的
  // 既有会话，产物 origin=external（close 语义分流：关闭=解除接管不杀会话）。
  // 响应 data.attached = 接管时刻的外部客户端数（≥1 多端同屏提示面）
  attachExternal: (tmuxName: string, name?: string, config?: AxiosRequestConfig) =>
    api.post('/terminals', { attachTmux: tmuxName, name }, config),
  // 多终端广播输入（P-20261003-288 舰队式批量输入）：同一段输入逐个写入多个
  // 会话。data 为原始 PTY 输入——执行命令须自带尾部换行（UI 广播条回车自动
  // 补 \r，API 直调方自行携带）；missing/failed 为跳过与失败的 id 回告
  broadcastWrite: (ids: string[], data: string, config?: AxiosRequestConfig) =>
    api.post<BroadcastWriteResult>('/terminals/broadcast-write', { ids, data }, config),
  // close: 外部接管会话（origin=external）缺省=解除接管（底层 tmux 会话存活）；
  // kill=true = 显式终结（kill-session，服务端不做二次确认——确认义务在 UI）
  close: (id: string, kill?: boolean) =>
    api.delete(`/terminals/${id}`, kill ? { params: { kill: 1 } } : undefined),
  // 服务端只读闸翻转（P-20261008-17）：接管会话（origin=external）默认只读的
  // 前端 pane 锁服务端镜像——前端解锁/上锁动作同步调用，服务端据此拦 WS 写链。
  // 仅对接管会话生效（自建会话 400）；响应 data.locked 为翻转后状态
  setInputLock: (id: string, locked: boolean, config?: AxiosRequestConfig) =>
    api.put(`/terminals/${id}/input-lock`, { locked }, config),
  rename: (id: string, name: string) =>
    api.put(`/terminals/${id}/rename`, { name }),
  resize: (id: string, rows: number, cols: number, config?: AxiosRequestConfig) =>
    api.put(`/terminals/${id}/resize`, { rows, cols }, config),
  // 强制重绘（tmux refresh-client，native 服务端 no-op）：pane 重新可见/尺寸
  // 稳定后调用，以 tmux 网格为事实源治愈显示失步（切换/最大化后错乱与滚轮失灵）
  redraw: (id: string) => api.put(`/terminals/${id}/redraw`),
  scrollback: (id: string, config?: AxiosRequestConfig) =>
    api.get(`/terminals/${id}/scrollback`, { responseType: 'arraybuffer', ...config }),
  // 会话输出整体留档导出（P-20261003-100）：服务端 scrollback 读取链剥 ANSI
  // 直出 txt 附件。blob 下载——响应拦截器不透 Content-Disposition，下载名由
  // 客户端按同约定合成（claude 导出同款），服务端同名头供直链/API 消费方；
  // 与既有客户端 exportAsText（xterm 缓冲直下）互补：本链路不依赖 pane 挂载。
  // 敏感出域闸门（P-20261003-155）：会话被标记敏感且未带 override=1 时响应
  // 是 JSON warnings（非附件），调用方按 blob.type 分流确认后带 override 重试
  exportOutput: (id: string, config?: AxiosRequestConfig) =>
    api.get(`/terminals/${id}/export`, { responseType: 'blob', timeout: 0, ...config }),
  // 失败会话复盘报告（P-20261004-60）：退出码/末命令/输出尾部/元数据聚合只读
  // 快照，销毁后补查同样可用（meta+history 兜底，尾部退化 claude transcript）。
  // 敏感出域闸门与导出同款：响应 {warnings} 时调用方确认后带 override 重试。
  // fmt='md' 走 Accept 协商取人读 Markdown（服务端同源渲染）
  postmortem: (id: string, opts?: { override?: boolean; fmt?: 'md' }, config?: AxiosRequestConfig) =>
    api.get(`/terminals/${id}/postmortem`, {
      params: opts?.override ? { override: 1 } : undefined,
      responseType: opts?.fmt === 'md' ? 'text' : undefined,
      headers: opts?.fmt === 'md' ? { Accept: 'text/markdown' } : undefined,
      ...config,
    }),
  tmuxInfo: (config?: AxiosRequestConfig) =>
    api.get<TmuxInfo>('/terminals/tmux-info', config),
  installTmux: () => api.post<TmuxInstallResult>('/terminals/tmux-install'),
  // 上传剪贴板截图，返回临时文件路径（paste 到终端让 claude code 等 CLI 读取）
  uploadPasteImage: (blob: Blob) => {
    const form = new FormData()
    form.append('image', blob)
    return api.post<{ data: { path: string; size: number } }>('/terminals/paste-image', form)
  },
  // 上传粘贴文件（P-20261024-2）：paste 事件捕获的 OS 复制文件（扩展名白名单/
  // 20MB 上限由服务端判定），与截图形态同端点、按 multipart 字段分派
  uploadPasteFile: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return api.post<{ data: { path: string; size: number } }>('/terminals/paste-image', form)
  },
  // 高危命令影响面预览（P-20261005-191）：命令串 + 可选 cwd（会话实时工作
  // 目录）→ 结构化判定（模式表命中 + rm glob 展开/git status 动态计数）。
  // 粘贴链/palette 直达插入链确认卡数据源 + agent 执行前自检原语（只读面）
  previewCommand: (command: string, cwd?: string, config?: AxiosRequestConfig) =>
    api.post<{ data: TerminalCommandPreviewResult }>(
      '/terminals/command-preview',
      { command, ...(cwd ? { cwd } : {}) },
      config,
    ),
  // 命令历史（OSC 133 E/D 事件链路）：记录为 fire-and-forget（失败静默），
  // 查询/清理供命令历史面板使用。terminalId 会话归属（P-20261004-35，与
  // CC_TERMINAL_ID 同源）可选上报；查询面 terminalId 非空时仅返回该会话条目
  recordHistory: (projectId: string, entry: TerminalHistoryRecord) =>
    api.post(`/projects/${projectId}/terminal-history`, entry),
  listHistory: (projectId: string, q?: string, failedOnly?: boolean, terminalId?: string, config?: AxiosRequestConfig) =>
    api.get(`/projects/${projectId}/terminal-history`, { params: { q, failedOnly, terminalId }, ...config }),
  // 跨项目聚合检索（P-20261004-2）：「那条命令上次在哪个项目跑的」全局原语。
  // q≥2 字符（服务端校验），返回全局时间倒序扁平列表（含失败 exitCode 可溯源）
  searchHistoryAll: (q: string, limit?: number, config?: AxiosRequestConfig) =>
    api.get(`/terminal-history/search`, { params: { q, limit }, ...config }),
  // 跨会话输出检索（P-20261003-290）：「那个报错/端口号是哪个会话打印的」。
  // q≥2 字符（服务端校验），扫每会话最近 2000 行，单会话≤10 条、总量≤50
  searchOutput: (q: string, limit?: number, config?: AxiosRequestConfig) =>
    api.get(`/terminals/search`, { params: { q, limit }, ...config }),
  // 端口注册表查询（P-20261003-293）：dev 端口探测/上报两路信号的「端口→会话」
  // 登记面。agent 选自由端口原语 + 「端口占用一览」浮层同源；登记面=探测/上报面
  listPorts: (config?: AxiosRequestConfig) => api.get<TerminalPortEntry[]>('/terminals/ports', config),
  // OSC 133 运行态计数（P-20261004-63）：服务端权威的「多少会话命令在跑」
  // 跨设备真值（浏览器 runningMap 只由持有连接的宿主写入，跨设备有盲区）。
  // kind 空 = 全体会话 / 'shell' / 'agent'；running 为点亮会话 id 清单
  //（agent 自查 CC_TERMINAL_ID 是否在内）。旧服务端无此端点 → 调用方降级
  runningCount: (kind?: string, config?: AxiosRequestConfig) =>
    api.get<RunningCountResult>('/terminals/running-count', { params: kind ? { kind } : undefined, ...config }),
  // 运行中会话的指令队列（P-20261003-248）：批量读（侧栏徽标+面板单一取数口，
  // 只回存有排队指令的在册会话）/ 排队入尾（服务端 busy 判定：idle 即发 /
  // running 等回执 / missing 降级只存，响应另携 sent 回告是否已即时发送）/
  // 整表替换（编辑/删除/重排单一写口，不触发发送）。
  // 响应体形（gin body）：queues → {data:{queues}}；入队 → {data:entry,sent}；
  // 替换 → {data:entry}——调用方按拦截器解包约定 cast（asks store 同款）
  listQueues: (config?: AxiosRequestConfig) => api.get('/terminals/queues', config),
  enqueueQueueItem: (id: string, text: string, config?: AxiosRequestConfig) =>
    api.post(`/terminals/${id}/queue`, { text }, config),
  replaceQueueItems: (id: string, items: string[], config?: AxiosRequestConfig) =>
    api.put(`/terminals/${id}/queue`, { items }, config),
  clearHistory: (projectId: string) => api.delete(`/projects/${projectId}/terminal-history`),
  // 单条删除（P-20261003-63）：按条目落盘时刻 at 身份删除——GET 快照与删除之间
  // 并发追加/过滤位移会让下标漂移错删相邻条目，时间戳身份不受影响；
  // 存量 :idx 下标形态保留给 API 直调方
  deleteHistoryEntryAt: (projectId: string, at: string, config?: AxiosRequestConfig) =>
    api.delete(`/projects/${projectId}/terminal-history/entry`, { params: { at }, ...config }),
  deleteHistoryEntry: (projectId: string, idx: number) =>
    api.delete(`/projects/${projectId}/terminal-history/${idx}`),
}

// BroadcastWriteResult POST /terminals/broadcast-write 响应 data 段：
// written=成功写入数；missing=不存在的会话 id（跳过回告）；failed=存在但
// 写入失败的 id（已关闭/未附着）；failedHosts=failed 中远程目标的主机标注
//（P-20261005-11：id+hostId+别名，「哪台失败一目了然」；本地失败/旧服务端
// 缺省为空数组，可选消费零破坏）
export interface BroadcastFailedHost {
  id: string
  hostId: string
  host: string
}

export interface BroadcastWriteResult {
  written: number
  missing: string[]
  failed: string[]
  failedHosts?: BroadcastFailedHost[]
}

// TerminalHistoryRecord POST /projects/:id/terminal-history 请求体
export interface TerminalHistoryRecord {
  command: string
  exitCode: number
  durationMs: number
  /** 会话归属（P-20261004-35）：终端会话 id（CC_TERMINAL_ID 同源）；缺省落「未归属」组 */
  terminalId?: string
  /**
   * 条目来源（P-20261005-188）：'input' = 输入域「提交的输入行」（远程控制台
   * 采集，无 exitCode/时长数据）；缺省 = osc 精确域（shell integration）
   */
  source?: string
  /** 远程主机键（P-20261005-188，remote 条目附主机 id）：缺省 = 本地 */
  host?: string
}

/** 编队批元数据（P-20261005-145，与服务端 store.FleetBatch 同形）：
 * batchId 批身份 + 发起时间 + 已创建成员会话 id 花名册（跳过项不入册） */
export interface FleetBatchInfo {
  batchId: string
  launchedAt: string
  members: string[]
}

/** POST /terminals/bulk-agent 响应明细（P-20261003-291） */
export interface FleetBulkAgentResult {
  /** 已创建：projectId → terminalId（name/path/runtime/launched 为该会话快照） */
  created: Array<{ projectId: string; terminalId: string; name: string; path: string; runtime: string; launched: boolean }>
  /** 跳过回告：reason 为服务端稳定标记原文（project not found / PrecheckError 等） */
  skipped: Array<{ projectId: string; reason: string }>
  /** 编队批元数据（P-20261005-145）：发起方即时可编程追踪（GET /terminals?fleet=
   *  <batchId>），会话快照各成员亦携带同值 fleetBatch。可选：旧服务端无此字段
   *  （升级窗口「新前端 + 旧后端」形态，消费方按缺省处理不虚构） */
  fleetBatch?: FleetBatchInfo
}

// TerminalHistoryEntry GET /projects/:id/terminal-history 返回的单条结构
export interface TerminalHistoryEntry extends TerminalHistoryRecord {
  at: string
}

// TerminalHistorySearchHit GET /terminal-history/search 返回的单条结构：
// 项目归属 + 命令最小面（无 durationMs），ts 为命令结束时间
export interface TerminalHistorySearchHit {
  projectId: string
  projectName: string
  command: string
  exitCode: number
  ts: string
  /** 条目来源与远程主机键（P-20261005-188 透传）：缺省 = 本地 osc 条目 */
  source?: string
  host?: string
}

// TerminalOutputSearchHit GET /terminals/search 返回的单条结构（P-20261003-290）：
// 命中会话 + 命中行文本（服务端已剥 ANSI、超长截窗）；hitIndex 为命中行在
// 该会话扫描窗口内的 0 基行号（行序即输出时序）
export interface TerminalOutputSearchHit {
  sessionId: string
  sessionName: string
  projectId: string
  lineText: string
  hitIndex: number
}

// TerminalPortEntry GET /terminals/ports 返回的单条结构（P-20261003-293）：
// 端口注册表登记面。source: detected=终端输出探测 / reported=agent 上报；
// firstSeen 为首次登记时刻（同会话重复登记不刷新——「先占时点」语义）；
// lastSeen 为最近一次登记/刷新时刻（P-20261007-14 增量字段，观测时效标注用）
export interface TerminalPortEntry {
  port: number
  sessionId: string
  sessionName: string
  projectId: string
  label: string
  source: string
  firstSeen: string
  lastSeen: string
}

// RunningCountResult GET /terminals/running-count 返回结构（P-20261004-63）：
// OSC 133 运行态服务端计数。count=运行点亮数；total=过滤后会话总数；
// running=点亮会话 id 清单（agent 自查「我的会话在跑吗」的比对面）。
// 诚实边界：shell 集成未注入 / 重启前已开始的命令不在计数（宁漏报不误报）
export interface RunningCountResult {
  kind: string
  count: number
  total: number
  running: string[]
}

// PostmortemReport GET /terminals/:id/postmortem 响应 data 段（P-20261004-60）：
// 复盘聚合报告。exitCode/exitedAt 仅异常退出落过记录才非空（正常退出/存活中
// /旧数据缺省，渲染「无异常退出记录」）；outputTail 已剥 ANSI + 服务端敏感
// 遮蔽，outputSource 标注来源（scrollback=在册实时缓冲 / transcript=claude
// 转写尾读 / 空=两路都不可得）；transcriptId 命中的 claude 会话 UUID（供回放深链）
export interface PostmortemReport {
  sessionId: string
  name?: string
  kind?: string
  runtime?: string
  dir?: string
  projectId?: string
  alive: boolean
  createdAt?: string
  exitCode?: number
  exitedAt?: string
  initialPrompt?: string
  lastCommands?: Array<{ command: string; exitCode: number; durationMs: number; at: string }>
  outputTail?: string
  outputSource?: string
  transcriptId?: string
}

// SessionQueueEntry 会话排队指令视图（P-20261003-248）：items 队首在前；
// busy = 会话最近 task.progress 上报为 running；autoSend = 完成回执可自动
// 发送（false = 会话无进度上报数据，降级手动发送——UI 据此渲染注记）
export interface SessionQueueEntry {
  sessionId: string
  items: Array<{ text: string; queuedAt: string }>
  busy: boolean
  autoSend: boolean
}

// TmuxInfo 后端 GET /terminals/tmux-info 返回结构
export interface TmuxInfo {
  available: boolean
  version: string
  path: string
  required: string
  installable: boolean
  pkgManager: string
  installCommand: string
}

// ShellCandidate GET /terminals/shell-candidates 返回的单条候选（P-20261004-57）：
// name 为候选键（pwsh/powershell/cmd/bash/zsh/fish/$SHELL），path 为 LookPath
// 解析的完整路径（未检测到为空）；available=false 的候选可展示但不可选
export interface ShellCandidate {
  name: string
  path: string
  available: boolean
}

// ShellCandidatesData GET /terminals/shell-candidates 响应 data 段：
// defaultShell 为服务端当前实际生效的默认 shell（设置有效取设置，否则平台缺省）
export interface ShellCandidatesData {
  platform: string
  settingShell: string
  defaultShell: string
  candidates: ShellCandidate[]
}

// TmuxInstallResult POST /terminals/tmux-install 返回结构
export interface TmuxInstallResult {
  success: boolean
  command: string
  output: string
  needsSudo: boolean
}

// ExternalTmuxSession GET /terminals/external-sessions 返回的单条结构
//（P-20261005-189）：attached ≥1 时接管后多端同屏回显是 tmux 特性（UI 提示面）；
// takenOver=true = 已被本系统接管（置灰防重复 attach）
export interface ExternalTmuxSession {
  name: string
  attached: number
  createdAt: number
  windows: number
  activity: number
  takenOver: boolean
}

// ExternalSessionsBody GET /terminals/external-sessions 响应体（gin body）：
// available=false = 服务端 tmux 不可用（Windows 等），前端隐藏接管入口
export interface ExternalSessionsBody {
  data: ExternalTmuxSession[]
  available: boolean
}

// TerminalRiskDynamic POST /terminals/command-preview 单命中的动态影响面计数
//（P-20261005-191）。字段按计数族区分：路径族 files/bytes/paths/truncated；
// git 族 dirty（reset/checkout/restore 回滚面）或 untracked（clean 删除面）；
// 覆盖重定向族 exists。缺席 = 静态降级（无计数面）
export interface TerminalRiskDynamic {
  files?: number
  bytes?: number
  sizeHuman?: string
  truncated?: boolean
  paths?: string[]
  dirty?: number
  untracked?: number
  exists?: boolean
}

// TerminalRiskMatch 单条模式命中。id 为模式稳定键（i18n 文案键尾 + 会话白名单），
// segment 为命中命令片段，targets 为参与计数的目标参数
export interface TerminalRiskMatch {
  id: string
  level: 'danger' | 'warning'
  kind: string
  segment: string
  targets?: string[]
  dynamic?: TerminalRiskDynamic | null
}

// TerminalCommandPreviewResult 结构化判定：level 为全部命中最高档（'' = 未命中），
// kind/detail 取首个最高档命中（detail 为稳定英文短语，agent/日志消费）
export interface TerminalCommandPreviewResult {
  level: string
  kind: string
  detail: string
  matches: TerminalRiskMatch[]
}

export const getTerminalWsUrl = (id: string) => {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const { instanceId, isRemote } = getCurrentInstanceContext()
  if (isRemote && instanceId) {
    return `${proto}//${location.host}/ws/proxy/${instanceId}/terminal/${id}`
  }
  return `${proto}//${location.host}/ws/terminal/${id}`
}
