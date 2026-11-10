// 系统域 API：设置、UI 状态、实例、Token、更新、片段库、通知
import type { AxiosRequestConfig } from 'axios'
import api, { getCurrentInstanceContext } from '../http'
import type { ActivityDayEntry } from './report'

// 命令片段库（C2）。响应拦截器已解包：调用方拿到的 res 即 { data: ... } 形态的响应体
// 片段种类（P-20261002-44）：command=终端命令片段 / code=编辑器代码片段；
// 旧数据无 kind 字段（缺省 command，服务端读取时归一），内容统一存 command 字段
export type SnippetKind = 'command' | 'code'

export interface Snippet {
  id: string
  title: string
  command: string
  description?: string
  tags?: string[]
  scope: 'global' | 'host'
  scopeId?: string
  kind?: SnippetKind
  /** code 片段语言（monaco language id，如 typescript；空 = 任意语言可用） */
  language?: string
  isSystem?: boolean
  createdAt: string
  updatedAt: string
}

/** 是否代码片段（kind 缺省的旧数据一律视为命令片段） */
export const isCodeSnippet = (s: Snippet): boolean => s.kind === 'code'

export const snippetApi = {
  list: (config?: AxiosRequestConfig) =>
    api.get<{ data: Snippet[] }>('/snippets', config) as unknown as Promise<{ data?: Snippet[] }>,
  // create/update/remove：拦截器已弹 toast，调用方（SnippetManager）catch 内
  // 本地再弹会双提示，故固定 silent
  create: (data: { title: string; command: string; description?: string; tags?: string[]; scope?: string; kind?: SnippetKind; language?: string }, config?: AxiosRequestConfig) =>
    api.post<{ data: Snippet }>('/snippets', data, { silent: true, ...config }) as unknown as Promise<{ data?: Snippet }>,
  update: (id: string, data: Partial<{ title: string; command: string; description: string; tags: string[]; scope: string; kind: SnippetKind; language: string }>, config?: AxiosRequestConfig) =>
    api.put<{ data: Snippet }>(`/snippets/${id}`, data, { silent: true, ...config }) as unknown as Promise<{ data?: Snippet }>,
  remove: (id: string) => api.delete(`/snippets/${id}`, { silent: true }),
}

// 运行书（P-20261003-24）：多步运维序列有序步骤列表，逐条「发送到终端」
// 插入不执行（回车由人按）。存储与片段同族（docstore 单文档全量数组）；
// 步骤命令支持 P-20261002-123 占位符模板（{参数}），插值在前端发送时做。
// onFailure 失败语义（P-20261004-13）：缺省/'continue' = 连续发送（现状）；
// 'stop' = 序贯执行遇非 0 退出码即停（前端运行器经 OSC 133 帧逐条判定）
export type RunbookOnFailure = 'continue' | 'stop'

export interface RunbookStep {
  command: string
  description?: string
}

export interface Runbook {
  id: string
  title: string
  description?: string
  onFailure?: RunbookOnFailure
  steps: RunbookStep[]
  createdAt: string
  updatedAt: string
}

export const runbookApi = {
  list: (config?: AxiosRequestConfig) =>
    api.get<{ data: Runbook[] }>('/runbooks', config) as unknown as Promise<{ data?: Runbook[] }>,
  // create/update/remove：拦截器已弹 toast，调用方（RunbookPanel）catch 内
  // 本地再弹会双提示，故固定 silent（与 snippetApi 同款约定）
  create: (data: { title: string; description?: string; onFailure?: RunbookOnFailure; steps: RunbookStep[] }, config?: AxiosRequestConfig) =>
    api.post<{ data: Runbook }>('/runbooks', data, { silent: true, ...config }) as unknown as Promise<{ data?: Runbook }>,
  update: (id: string, data: Partial<{ title: string; description: string; onFailure: RunbookOnFailure; steps: RunbookStep[] }>, config?: AxiosRequestConfig) =>
    api.put<{ data: Runbook }>(`/runbooks/${id}`, data, { silent: true, ...config }) as unknown as Promise<{ data?: Runbook }>,
  remove: (id: string) => api.delete(`/runbooks/${id}`, { silent: true }),
  // 舰队运行书（P-20261005-147）：按序对 N 台会话执行同一本书——每步广播写
  // 全目标 + 并发等各目标 OSC 133 终态聚合（逐步逐目标矩阵）。fleet-run 与
  // 单会话 run 同走「返回即终态、60s 响应墙」语义：长运行响应可能断连，
  // 面板以 task.progress（payload.fleet 扩展）事件驱动合并，不依赖响应必达
  fleetRun: (id: string, data: { targetIds: string[]; params?: Record<string, string>; onFailure?: RunbookOnFailure; stepTimeoutMs?: number }, config?: AxiosRequestConfig) =>
    api.post<{ data: FleetRunResult }>(`/runbooks/${id}/fleet-run`, data, { silent: true, ...config }) as unknown as Promise<{ data?: FleetRunResult }>,
  fleetAbort: (id: string, runId: string, config?: AxiosRequestConfig) =>
    api.post<{ data: FleetRunResult }>(`/runbooks/${id}/fleet-abort`, { runId }, { silent: true, ...config }) as unknown as Promise<{ data?: FleetRunResult }>,
  fleetRetry: (id: string, runId: string, stepIndex: number, targetId: string, config?: AxiosRequestConfig) =>
    api.post<{ data: FleetRunResult }>(`/runbooks/${id}/fleet-retry`, { runId, stepIndex, targetId }, { silent: true, ...config }) as unknown as Promise<{ data?: FleetRunResult }>,
}

// ── 舰队运行书类型（与 server/api/system/runbookfleet.go 响应契约同形）──

/** 矩阵单格：某步在某目标的执行结果 */
export interface FleetRunTargetCell {
  id: string
  /** done | failed | skipped | aborted */
  status: string
  /** 无判据（noSignal/timedOut/skipped/aborted）时缺省 */
  exitCode?: number
  /** 有信号但等待超时（按 CMD_TIMEOUT 惯例视为完成） */
  timedOut?: boolean
  /** 无 OSC133 确认信号（裸 sh / 远程终端）——诚实降级标注 */
  noSignal?: boolean
  /** 写入失败短语 */
  error?: string
}

/** 单步 × 全目标 */
export interface FleetRunStepResult {
  index: number
  command: string
  description?: string
  /** done | failed | skipped | aborted */
  status: string
  targets: FleetRunTargetCell[]
}

/** 舰队执行结果（响应 data；同步执行，返回即终态） */
export interface FleetRunResult {
  runId: string
  bookId: string
  title: string
  targetIds: string[]
  onFailure: RunbookOnFailure
  /** completed | failed | aborted */
  status: string
  steps: FleetRunStepResult[]
}

// 设置
export type TerminalBackend = 'auto' | 'tmux' | 'native'

// 终端字体类型直接复用 terminal-themes/types，避免字面量在多处定义
import type { TerminalFontFamily } from '../../terminal-themes/types'
export type TerminalFont = TerminalFontFamily

// 自定义智能体运行时（任意 CLI 智能体工具自取注册名接入，与内置运行时同体验）
export interface CustomAgent {
  name: string        // 注册名（slug，唯一标识，会话 meta 与 agentLaunchCommands 的 key）
  displayName?: string // 界面展示名（空 = 用 name）
  command: string     // 交互模式启动命令（经 PTY 注入 shell 执行，可带参数）
}

// 审批分类规则（P-20261003-35 per-op 自动裁决）：与服务端 config.AgentApprovalRule
// 同形。opPattern 为 op 前缀（大小写不敏感），effect 命中后生效；
// 有序列表取首个命中，无命中回落全局审批模式（默认 ask）。
// pathPattern 可选路径条件（P-20261004-67）：项目相对路径 glob（`**` 跨目录
// 段），与 op 前缀 AND 组合——两者都命中规则才生效；缺省 = 不限路径（存量
// 规则行为零变化）。命令型/URL 型 target 不参与路径判定（诚实边界）。
// tempUntil 临时启用至（P-20261003-243，RFC3339）：缺省 = 永久规则；到点规则
// 动作自动回 ask（判定即时生效，物化写回 + 通知由服务端巡检/创建点兜底）
export interface AgentApprovalRule {
  opPattern: string
  pathPattern?: string
  /** 'allow' | 'deny' | 'ask' */
  effect: string
  tempUntil?: string
}

export type ApprovalRuleEffect = 'allow' | 'deny' | 'ask'

// SettingsData 后端 GET /settings 返回的 data 字段结构
// 供调用方手动 cast（axios 拦截器 unwrap 与 TS 类型不感知，沿用项目原风格不泛型化）
export interface SettingsData {
  autoFetch: boolean
  fetchInterval: number
  terminalBackend: TerminalBackend
  terminalScrollbackLines: number
  terminalIdleTimeoutMin: number // 终端空闲超时自动分离分钟数（P-20261003-192；0=关闭默认，UI 呈现小时档位）
  terminalDefaultShell?: string  // 终端默认 shell（P-20261004-57；空/缺省 = 平台缺省序，仅新会话生效）
  terminalHistoryEnabled: boolean  // 终端命令历史记录开关（后端未配置时默认开）
  terminalPastePrecheckEnabled?: boolean // 高危命令粘贴预检开关（P-20261005-191；后端未配置时默认开）
  terminalRemoteTmux?: boolean     // 远程终端 tmux 持久化开关（后端未配置时默认关）
  terminalTmuxMouseEnabled?: boolean // tmux 鼠标接管开关（P-20261109-7，后端未配置时默认开）
  terminalTheme: string       // 终端主题名（手工选择基准；跟随应用明暗开启时被档位映射临时盖住，解绑后生效——开关是浏览器本地态不在此处）
  terminalFont: TerminalFont  // 终端字体
  uidensity?: string          // 界面密度档（P-20261003-322）：comfortable（默认）/ compact
  sessionContext?: string     // 会话启动上下文（P-20261006-47）：git/notes/todos/env 逗号多选或 none；未配置=git（P-176 默认行为零变化）
  agentNamingNoteEnabled?: boolean // 会话命名系统注记注入开关（P-20261023-3）：未配置=true（默认开）
  agentProvider: string       // AI 底层智能体选型：auto / claude / dsh / 自定义注册名
  agentProviders?: string[]   // 已注册 Provider 名单（后端派生只读字段，仅 GET 返回；新建会话下拉用）
  customAgents?: CustomAgent[] // 用户自定义智能体运行时列表（增删改走下方 customAgentApi）
  agentApprovalRules?: AgentApprovalRule[] // 审批分类规则（per-op 自动裁决，P-20261003-35）
  customSensitivePatterns?: string[] // 自定义敏感模式（P-20261006-11；服务端恒返数组，空 = 纯通用表现状）
  hookUrlAllowHosts?: string[] // 入站 Hook URL 动作允许域（P-20261003-164；服务端恒返数组，空 = url 动作整体关闭仅 panel:）
  auditRetentionDays: number  // 审计日志保留天数（P-20261003-123；服务端返回生效值，未配置=默认 30）
  logRetentionDays: number    // 运行日志保留天数（未配置=默认 15）
  uiSnapshotEnabled: boolean  // 用户 UI 现场上报开关（P-20261004-52；后端未配置时默认开）
  sensitiveExternalWatch: boolean // 敏感文件工作台外写入观测开关（P-20261005-15；后端未配置时默认开）
  previewCompatMode?: boolean // 预览面板同源兼容模式（P-20261019-1；后端未配置时 false = 沙箱隔离）
  userPrefs?: Record<string, unknown> | null // 用户偏好漫游单键（P-20261007-1）：稀疏偏差集（keymap/notify/terminal 习性），schema 前端自治；null = 服务端无漫游偏好（前端走本地镜像播种分支）
  dshWebBase: string          // dsh Web UI 上游地址（默认 http://127.0.0.1:3080）
  dshWebToken: string         // dsh 访问令牌（空 = 未配置；一键启动会自动捕获回填）
  dshLaunchCommand: string    // dsh 一键启动命令（空 = 默认 `dsh web --no-open`；Windows 本机无 dsh 而 WSL 有时，一键启动自动改用并落盘 `wsl.exe dsh web --no-open`）
  dshProxyPort: number        // 嵌入反代端口（缺省/0 = 默认 3081；后端无「关闭」取值，设置页仅可调端口）
  dshExposeAll: boolean       // dsh 控制台反代绑定所有网卡（默认 false = 仅 127.0.0.1，受系统锁保护）
  dshAllowStandalone: boolean // 允许独立标签页访问 dsh（默认 false：裸开反代地址返回引导页，仅 SC 内嵌可用）
  dshNpmCommand?: string      // npm 命令（默认 npm）
  dshRollbackVersion?: string // 最近一次升级前的 dsh 版本（空 = 无回退点）
  updateURL: string           // 更新分发源（本机作为中心时跨平台缓存的 Release 地址）
  /** 更新链出站代理（P-20261109-12）：http(s)/socks5 地址；空 = 走环境变量（HTTPS_PROXY） */
  updateProxy?: string
  externalAccessUrl?: string  // 外部访问地址（P-20261019-10）：Tailscale/反代接入时的手机可达 origin；空=未配置
  /** 多实例同步本端落位根（P-20261023-1）：空 = 默认（用户主目录下 codecombo-sync/） */
  syncDestRoot?: string
  /** 新建文件分享默认有效期（P-20261020-5）：permanent（缺省，存量行为零变化）/ 1d / 7d / 30d */
  shareDefaultTTL?: string
  sharePublicBaseUrl?: string // 分享外发基址（P-20261020-2）：分享 URL = 该 origin + /s/<token>；空=自动选址
  /** 可信反向代理清单（P-20261020-1）：空数组=不信任任何转发头；重启生效 */
  trustedProxies?: string[]
  tlsEnabled: boolean         // TLS（HTTPS/WSS）开关：启用需重启进程生效
  tlsCertConfigured: boolean  // 自定义证书是否已配置（false = 启用时自动生成自签）
  tmuxAvailable: boolean
  version: string
  commit: string
  buildTime: string
  goVersion: string
  platform: string
  /** 远程接入中继档案（P-20261019-11）：密码永不回参（hasPassword 布尔） */
  remoteAccess?: RemoteAccessSettingsView
}

// ── 远程接入（SSH 反向隧道，P-20261019-11） ──────────────────────────────
/** 中继档案（GET /settings 投影；password 不回传） */
export interface RemoteAccessProfileView {
  id: string
  name: string
  host: string
  port: number
  user: string
  authType: 'password' | 'sshkey'
  sshKeyId?: string
  /** 是否已有可用密码（编辑留空 = 保持原密码） */
  hasPassword?: boolean
  /** 远端绑定：0.0.0.0 公网直连 / 127.0.0.1 供 VPS 反代 */
  remoteBindHost: string
  remotePort: number
  domain?: string
  createdAt?: string
  updatedAt?: string
}

export interface RemoteAccessSettingsView {
  profiles: RemoteAccessProfileView[]
  activeId: string
  enabled: boolean
}

/** 提交形态（password 仅新建/改密时携带；留空 = 保持） */
export interface RemoteAccessProfileInput {
  id?: string
  name: string
  host: string
  port: number
  user: string
  authType: 'password' | 'sshkey'
  sshKeyId?: string
  password?: string
  remoteBindHost: string
  remotePort: number
  domain?: string
}

/** 隧道状态快照（GET /api/remoteaccess/tunnel） */
export interface RemoteAccessStatus {
  state: 'stopped' | 'connecting' | 'online' | 'reconnecting' | 'failed'
  profileId?: string
  remoteBindHost?: string
  remotePort?: number
  publicUrl?: string
  startedAt?: string
  onlineSince?: string
  lastError?: string
  lastErrorAt?: string
  reconnectAttempts: number
  activeConnections: number
  totalConnections: number
  droppedConnections: number
  enabled: boolean
  activeId: string
  lockReady: boolean
  lockReason?: string
  lockDefaultPassword: boolean
  tlsEnabled: boolean
  hostKey?: { pinned: boolean; fingerprint?: string; algo?: string }
  /** P-20261019-10 未落地时恒空：前端只显示复制/二维码，不做自动写入 */
  externalAccessUrl?: string
}

export interface RemoteAccessProbeStep {
  step: string
  ok: boolean
  message?: string
  hint?: string
}

export interface RemoteAccessProbeResult {
  ok: boolean
  steps: RemoteAccessProbeStep[]
  hostKeyFingerprint?: string
}

export const settingsApi = {
  get: (config?: AxiosRequestConfig) => api.get('/settings', config),
  // dsh 工具集成信息（P6）：反代 iframe/新标签地址 + 上游探活结果
  dshToolInfo: (params?: { target?: string }) => api.get('/tools/dsh/url', { params }),
  dshStatus: () => api.get('/tools/dsh/status'),
  // 一键拉起 dsh（上游未运行时）：自动捕获 launch token 写回设置
  dshLaunch: () => api.post('/tools/dsh/launch'),
  // 外部 dsh 目标管理（多目标 cookie 路由）：列表/新增/改/删
  dshTargetsList: () => api.get('/tools/dsh/targets'),
  dshTargetCreate: (data: { name: string; base: string; token?: string }) => api.post('/tools/dsh/targets', data),
  dshTargetUpdate: (id: string, data: { name: string; base: string; token?: string }) => api.put(`/tools/dsh/targets/${id}`, data),
  dshTargetDelete: (id: string) => api.delete(`/tools/dsh/targets/${id}`),
  // dsh 升级链路：版本列表 / 记录回退点 / npm 安装（长请求）/ 重启加载新版 / 回退
  dshVersions: () => api.get('/tools/dsh/versions'),
  dshUpgradePrepare: (version: string) => api.post('/tools/dsh/upgrade/prepare', { version }, { timeout: 60000 }),
  dshUpgradeInstall: (version: string) => api.post('/tools/dsh/upgrade/install', { version }, { timeout: 600000 }),
  dshUpgradeRestart: () => api.post('/tools/dsh/upgrade/restart', {}, { timeout: 180000 }),
  dshRestart: () => api.post('/tools/dsh/restart', {}, { timeout: 180000 }),
  dshChangelog: () => api.get('/tools/dsh/changelog'),
  dshRollback: () => api.post('/tools/dsh/rollback', {}, { timeout: 600000 }),
  update: (data: {
    autoFetch?: boolean
    fetchInterval?: number
    terminalBackend?: TerminalBackend
    terminalScrollbackLines?: number
    terminalIdleTimeoutMin?: number // 终端空闲超时自动分离分钟数（0=关闭默认；1~43200 有效）
    terminalDefaultShell?: string // 终端默认 shell（P-20261004-57；空串=清除回落平台缺省；服务端 LookPath 校验，不存在 400）
    terminalHistoryEnabled?: boolean
    terminalPastePrecheckEnabled?: boolean // 高危命令粘贴预检开关（默认开；关=粘贴/直达插入不再写入前预检）
    terminalRemoteTmux?: boolean
    terminalTmuxMouseEnabled?: boolean // tmux 鼠标接管开关（P-20261109-7，默认开；false=复制优先模式，热切换即时生效）
    terminalTheme?: string
    terminalFont?: TerminalFont
    uidensity?: string // 界面密度档（P-20261003-322）：comfortable（默认）/ compact，settings.changed 广播多端跟随
    sessionContext?: string // 会话启动上下文（P-20261006-47）：git/notes/todos/env 逗号多选或 none；空串回落 git 默认，服务端白名单校验
    agentNamingNoteEnabled?: boolean // 会话命名系统注记注入开关（P-20261023-3）：省略=不动，未配置默认开
    agentProvider?: string
    agentLaunchCommands?: Record<string, string> // 每运行时启动命令覆盖（整体替换语义）
    agentGuard?: boolean // 智能体令牌高危操作服务端强制审批开关（默认开）
    agentApprovalMode?: string // 高危操作审批档位（P-20261003-316 四档：ask=每次询问默认；allow-session=会话级；allow-24h=24 小时；allow=永久不再询问）
    agentApprovalExpiresAt?: string // allow-24h 到期时刻（RFC3339；保存 allow-24h 时可注入——测试时间旅行/运维调整剩余时限）
    agentApprovalRules?: AgentApprovalRule[] // 审批分类规则（有序整体替换语义，省略 = 不动）
    customSensitivePatterns?: string[] // 自定义敏感模式（P-20261006-11；整体替换语义，省略 = 不动；RE2/JS 公共子集正则，服务端编译校验 400）
    hookUrlAllowHosts?: string[] // 入站 Hook URL 动作允许域（P-20261003-164；整体替换语义，空数组 = url 动作整体关闭；保存即时生效）
    approvalRecording?: boolean // 审批窗口过程实况录制开关（默认关——隐私边界）
    agentApprovalTimeoutMin?: number // pending 审批等待超时自动拒绝分钟数（0=不限，默认）
    gitNetworkTimeoutSec?: number // git 网络/重操作类兜底超时秒数（0=默认 900）
    auditRetentionDays?: number // 审计日志保留天数（0=回落默认 30；1~3650 有效）
    logRetentionDays?: number   // 运行日志保留天数（0=回落默认 15；1~3650 有效）
    uiSnapshotEnabled?: boolean // 用户 UI 现场上报开关（默认开；关=停止上报+读取查无）
    sensitiveExternalWatch?: boolean // 敏感文件工作台外写入观测开关（P-20261005-15，默认开；关=观测静默即时生效）
    previewCompatMode?: boolean // 预览面板同源兼容模式（P-20261019-1，默认关=沙箱隔离；开=同源直挂，设置页红色警示确认）
    userPrefs?: Record<string, unknown> | null // 用户偏好漫游单键（P-20261007-1）：省略=不动、null=清空回「未配置」（agent/e2e 复位）、对象=整体替换；服务端仅校验合法 JSON+≤64KB
    dshWebBase?: string
    dshWebToken?: string
    dshLaunchCommand?: string
    dshProxyPort?: number
    dshExposeAll?: boolean  // 开放所有 IP 访问 dsh 控制台（切换即时重绑定监听）
    dshAllowStandalone?: boolean // 允许独立标签页访问 dsh（关闭后裸开返回引导页）
    dshNpmCommand?: string  // npm 命令（默认 npm；dsh 在 WSL 时可配 wsl.exe npm）
    updateURL?: string
    updateChecks?: boolean // 自动检查更新开关（P-20261103-1）：省略=不动
    updateChannel?: string // 更新通道（P-20261103-3）：stable/prerelease，省略=不动
    /** 更新链出站代理（P-20261109-12）：省略=不动；空串=清除回环境变量感知 */
    updateProxy?: string
    externalAccessUrl?: string // 外部访问地址（仅 http/https origin，服务端校验+尾斜杠归一；空串=清除）
    syncDestRoot?: string // 多实例同步本端落位根（P-20261023-1）：绝对目录路径；空串=恢复默认
    shareDefaultTTL?: string // 新建文件分享默认有效期（P-20261020-5）：permanent/1d/7d/30d；省略=不动
    sharePublicBaseUrl?: string // 分享外发基址（P-20261020-2，同 origin 规则；空串=清除回落自动选址）
    /** 可信反向代理清单（P-20261020-1）：数组全量替换，空数组=不信任；重启生效 */
    trustedProxies?: string[]
    tlsEnabled?: boolean
    tlsVerifyPeer?: boolean  // 实例间 TLS 强校验开关（默认 false = TOFU 指纹校验，即时生效）
    tlsCertFile?: string  // 证书路径（留空不传 = 保持原值；与 tlsKeyFile 成对配置，双空则自动生成自签）
    tlsKeyFile?: string
    // 远程接入中继档案（P-20261019-11）：省略=不动；对象=档案列表全量替换。
    // 运行态 enabled/activeId 由 remoteAccessApi.control 维护，服务端保存时
    // 保留现值（设置页编辑档案不会停掉/切换运行中的隧道）
    remoteAccess?: { profiles: RemoteAccessProfileInput[]; activeId?: string; enabled?: boolean }
  // config 可选：后台同步（userPrefs 漫游上云）以 silent: true 调用，失败不弹
  // 错误 toast（离线常态噪音）；设置页用户主动保存不传，维持既有失败提示
  }, config?: AxiosRequestConfig) => api.put('/settings', data, config),
}

// 本机网络地址（P-20261019-10）：二维码接力在回环入口下自动改用局域网候选。
// 形状与 utils/networkAddress 的选址纯函数同源（type-only 复用，避免字段漂移）
export type NetworkAddressEntry = import('../../utils/networkAddress').NetworkAddress

export const networkApi = {
  list: (config?: AxiosRequestConfig) =>
    api.get<{ data: NetworkAddressEntry[] }>('/system/network', config) as unknown as Promise<{ data?: NetworkAddressEntry[] }>,
}
/**
 * 远程接入（SSH 反向隧道，P-20261019-11）：实例主动连用户自带 VPS 中继，
 * 把主服务呈现在任意手机网络。档案 CRUD 走 settingsApi（remoteAccess 字段），
 * 本族只做运行期状态/启停/预检/主机指纹重置。
 */
export const remoteAccessApi = {
  status: (config?: AxiosRequestConfig) =>
    api.get<{ data: RemoteAccessStatus }>('/remoteaccess/tunnel', config),
  control: (data: { action: 'start' | 'stop'; profileId?: string; confirmInsecureTls?: boolean }) =>
    api.post<{ data: RemoteAccessStatus; publicUrl?: string }>('/remoteaccess/tunnel', data),
  test: (data: { profileId?: string; profile?: RemoteAccessProfileInput }) =>
    api.post<{ data: RemoteAccessProbeResult; publicUrl?: string }>('/remoteaccess/tunnel/test', data, { timeout: 60000 }),
  resetHostKey: (profileId: string) =>
    api.post<{ data: { pinned: boolean; resetAt?: string } }>('/remoteaccess/tunnel/hostkey/reset', { profileId }),
}

// 自定义智能体运行时 CRUD：增删改即时持久化并同步进后端 Provider 注册表
//（无需重启，新建会话下拉即刻出现/消失），响应 data.customAgents 为全量列表
export const customAgentApi = {
  // silent：拦截器已弹 toast，调用方（CustomAgentsManager）本地再弹会双提示
  create: (data: CustomAgent) => api.post('/settings/custom-agents', data, { silent: true }),
  update: (name: string, data: Partial<CustomAgent>) =>
    api.put(`/settings/custom-agents/${encodeURIComponent(name)}`, data, { silent: true }),
  remove: (name: string) =>
    api.delete(`/settings/custom-agents/${encodeURIComponent(name)}`, { silent: true }),
}

// 审批分类规则命中测试（P-20261003-35）：输入 op 样例（+ 可选路径样例，
// P-20261004-67 路径条件判定）按当前已保存规则裁决（含全局 allow 短路语义），
// 返回 effect 与命中规则——保存前验证规则行为
export const approvalRuleApi = {
  test: (op: string, target = '', config?: AxiosRequestConfig) =>
    api.post<{ data: { effect: ApprovalRuleEffect; ruleHit: string } }>(
      '/settings/approval-rules/test', { op, target }, { silent: true, ...config },
    ),
}

// UI 状态持久化
export const uiStateApi = {
  get: (config?: AxiosRequestConfig) => api.get('/ui-state', config),
  // 工作区状态备份导出：走独立端点（载荷同 /ui-state），服务端为显式导出入审计账
  exportBackup: (config?: AxiosRequestConfig) => api.get('/ui-state/export', config),
  update: (data: Record<string, unknown>, config?: AxiosRequestConfig) => api.put('/ui-state', data, config),
  // 键级补丁（P-20261002-8）：载荷按实例 ID 只携带变更键，服务端读-合并-写
  // 原子合并——多标签页同开一项目各改各的键互不回滚；ui-state 在
  // LOCAL_PREFIXES 内恒发本机后端，前后端同二进制分发无版本偏移
  patch: (data: Record<string, unknown>, config?: AxiosRequestConfig) => api.patch('/ui-state', data, config),
}

// 用户 UI 现场（P-20261004-52）：前端聚合上报「用户此刻在看什么」
//（显著变化去抖 2s + 60s 心跳，多标签页最后写入优先），agent 经 GET 读取
// 「看着问」。仅位置不内容——隐私边界与使用约定见 ops 手册「用户现场」节；
// 上报/读取调度在 composables/useUiSnapshotReporter，聚合纯函数在
// utils/uiSnapshot。开关 = settings.uiSnapshotEnabled（默认开）
export interface UiActiveFile {
  path: string
  /** 1-based 行号（0/省略 = 无行级定位，如欢迎页/预览签） */
  line: number
  column?: number
}

export interface UiVisiblePanels {
  /** 侧栏当前视图标识（files/changes/todos/notes/stream…） */
  side: string
  sideOpen: boolean
  /** 底栏当前 tab 标识（git/terminal/preview/problems…） */
  bottom: string
  bottomOpen: boolean
}

/** GET /api/ui/snapshot 的 data 载荷（服务端 store.UISnapshot 读取视图 + 年龄） */
export interface UiSnapshotView {
  activeProjectId?: string
  activeFile?: UiActiveFile | null
  visiblePanels: UiVisiblePanels
  activeTerminalSessionId?: string
  updatedAt: string
  /** 现场年龄秒数（0~600）：消费方按陈旧度措辞 */
  ageSeconds: number
}

/** POST 上报载荷（activeFile/空 id 省略语义见 utils/uiSnapshot.buildUiSnapshot） */
export interface UiSnapshotPayload {
  activeProjectId?: string
  activeFile?: UiActiveFile
  visiblePanels: UiVisiblePanels
  activeTerminalSessionId?: string
}

/** 聚合数据源（useUiSnapshotReporter 从各 store/composable 现读） */
export interface UiSnapshotSource {
  activeProjectId: string
  activeFilePath: string
  activeFileLine: number
  activeFileColumn?: number
  side: string
  sideOpen: boolean
  bottom: string
  bottomOpen: boolean
  activeTerminalSessionId: string
}

export const uiSnapshotApi = {
  /** 上报/读取都固定 silent：现场是尽力而为的旁路面，失败静默保旧
   *  （404=无在报现场、停报都是预期分支，不走全局错误 toast） */
  put: (data: UiSnapshotPayload) => api.post('/ui/snapshot', data, { silent: true }),
  get: (config?: AxiosRequestConfig) =>
    api.get<UiSnapshotView>('/ui/snapshot', { silent: true, ...config }) as unknown as Promise<UiSnapshotView>,
}

// 安全事件审计日志（P-20261002-13）：时间倒序分页，只读
export interface AuditEvent {
  id: string
  time: string        // ISO 8601
  action: string      // 事件类型（如 lock.unlock / token.create，与后端常量一一对应）
  result: 'success' | 'failure' | 'denied'
  ip?: string
  rid?: string        // 请求关联短码（P-20261006-53）：与访问日志 rid= / 响应头 X-Request-Id 同值；后台/巡检条目无此字段
  detail?: string     // 语言中立摘要（名称/host/数量等，不含秘密值）
}
export const auditApi = {
  // 分页双模式（P-20261003-223）：offset 旧参数保留兼容；cursor（取自上一页
  // nextCursor）走键集续翻——翻页间隙新增事件不重不漏，深翻不随 offset 多扫。
  // 非空满页响应附 nextCursor，页未满即到底（无该键）
  list: (params?: { limit?: number; offset?: number; cursor?: string }, config?: AxiosRequestConfig) =>
    api.get<{ data: AuditEvent[]; total: number; nextCursor?: string; auditWriteFails?: number; auditLastWriteFail?: string; maxEntries?: number }>('/audit', { params, ...config }) as unknown as Promise<{ data?: AuditEvent[]; total?: number; nextCursor?: string; auditWriteFails?: number; auditLastWriteFail?: string; maxEntries?: number }>,
  /** 审计窗口 CSV 导出（P-20261003-66）：服务端分页循环拉全量转 CSV 附件。
   *  不传 days——服务端默认导出当前保留窗口全量（保留期可配 P-20261003-123，
   *  窗口随 settings.auditRetentionDays 收敛）；blob 接收——axios 拦截器自动带
   *  X-Lock-Token（直链点击不带解锁头会 423），拦截器只回 data 不透
   *  Content-Disposition，下载名客户端合成（claude 导出同款）；timeout 0：
   *  大窗口导出不设超时。
   *  过滤联动（P-20261007-2）：action/result 传当前过滤值（原值精确匹配，与
   *  行内过滤下拉同构）即服务端全窗口过滤导出——覆盖前端 500 条查看窗口之外
   *  的匹配行；不传或空串 = 该维度不过滤 = 全窗口口径（向后兼容） */
  exportCsv: (params?: { action?: string; result?: string }, config?: AxiosRequestConfig) =>
    api.get('/audit/export', { responseType: 'blob', timeout: 0, params, ...config }) as unknown as Promise<Blob>,
}

// 数据出域面总览（P-20261003-20）：webhook/分享/agent token/远程主机四处出域口
// 的只读聚合（+审计计数）。全部为脱敏展示态：webhook endpoint 是服务端 host+路径
// 形态（query/凭据形状路径段已剥除，原文绝不出域），分享不含 token，agent token
// 只有 Meta，远程主机只有数量
export interface EgressShareEntry {
  kind: string                  // file | snippet | terminal | terminal-frozen | cast | session
  name: string
  projectName: string
  path: string
  createdAt: string             // ISO 8601
  expiresAt?: string            // snippet 才有；零值不回传
}
export interface EgressOverview {
  webhook: { enabled: boolean; mode: string; scope: string; endpoint: string }
  shares: { count: number; items: EgressShareEntry[] }
  agentToken: AgentTokenMeta
  remoteHosts: { count: number }
  audit: { total: number }
}
export const egressApi = {
  overview: (config?: AxiosRequestConfig) =>
    api.get<EgressOverview>('/system/egress-overview', config) as unknown as Promise<EgressOverview>,
}

// 入口面总览（P-20261004-11）：锁定/agent token/TLS 与回环辅助口/活跃分享/
// 远程主机五处入口面的只读聚合。与 egress 同款脱敏展示态：无令牌明文、无 IP
// 明细、无分享 token；failures 为解锁限流器的进程内存态聚合计数（重启清零，
// 语义由卡片注记呈现）
export interface IngressOverview {
  lock: { enabled: boolean; needsSetup: boolean; failures: { ips: number; total: number; blocked: number } }
  agentToken: AgentTokenMeta
  tls: { enabled: boolean; loopbackPort: number }
  shares: { count: number }
  remoteHosts: { count: number }
}
export const ingressApi = {
  overview: (config?: AxiosRequestConfig) =>
    api.get<IngressOverview>('/system/ingress-overview', config) as unknown as Promise<IngressOverview>,
}

// 实例健康摘要（P-20261003-28）：metrics 自省四项 JSON 直取，值班大屏健康卡
// 30s 轮询消费；与 /api/metrics 同门控面（管理面鉴权由组中间件承担）
export interface InstanceHealth {
  /** 进程运行秒数（sc_process_uptime_seconds 同源） */
  uptime: number
  /** 存活堆字节数（sc_process_heap_alloc_bytes 同源，前端按 1024 进制格式化） */
  heapAlloc: number
  /** goroutine 数 */
  goroutines: number
  /** 各 WS 端点在线连接数之和（sc_ws_connections 跨端点聚合） */
  wsClients: number
  /** 审计写失败累计条数（P-20261003-205，进程生命周期内存计数，重启清零；0=无失败） */
  auditWriteFails: number
  /** 最近一次审计写失败时刻 RFC3339（空串=从未失败；与 AuditEvent.time 同序列化惯例） */
  auditLastWriteFail: string
  /** 当前占用全局并发门的 git 子进程数（P-20261004-125，sc_git_running 同源） */
  gitRunning: number
  /** 当前在全局并发门排队的调用数（sc_git_waiting 同源） */
  gitWaiting: number
  /** 本进程内排队峰值（sc_git_waiting_peak 同源，并发上限标定观测面） */
  gitWaitingPeak: number
}
export const systemHealthApi = {
  get: (config?: AxiosRequestConfig) =>
    api.get<InstanceHealth>('/system/health', config) as unknown as Promise<InstanceHealth>,
}

// Scheduler 后台任务清单（P-20261003-276）：GET /api/system/scheduler 只读
// 注册快照（内核调度器托管的后台任务），值班大屏健康卡折叠清单联动消费。
// 服务端刻意不提供启停（启停面大——漏关清理任务=数据无界增长，见提案注记）；
// lastRun 空串 = 注册后尚未到点（服务端零值哨兵，与 auditLastWriteFail 同惯例）
export interface SchedulerJob {
  /** 任务注册名（语言中立，如 disk-watch / agentcron-scheduler） */
  name: string
  /** 触发间隔毫秒 */
  intervalMs: number
  /** 最近触发时刻 RFC3339；空串 = 尚未到点 */
  lastRun: string
}
export const systemSchedulerApi = {
  get: (config?: AxiosRequestConfig) =>
    api.get<{ data: SchedulerJob[] }>('/system/scheduler', config) as unknown as Promise<{ data?: SchedulerJob[] }>,
}

// 服务自身运行日志（P-20261008-15）：DataDir/logs/ 按日滚动文件的只读尾部
// 窗口（服务端倒读，敏感值遮蔽默认开——Go 侧 server/api/system/servicelogs.go
// 同构）。lines 时间序旧→新；truncated=true = 窗口外还有更早日志；missing=true
// = 该日无日志文件（未运行/已过保留期），lines 恒空
export interface ServerLogTail {
  date: string
  lines: string[]
  truncated: boolean
  missing: boolean
  masked: boolean
}

export const serverLogApi = {
  /** 可用日期清单（降序新→旧） */
  dates: (config?: AxiosRequestConfig) =>
    api.get<{ data: string[] }>('/system/logs/dates', config) as unknown as Promise<{ data?: string[] }>,
  /** 尾部窗口：date 缺省=服务端当日；q 包含过滤；limit 缺省 200 封顶 1000；
   *  mask 缺省开，传 false 看原文（取证对账档） */
  tail: (params?: { date?: string; q?: string; limit?: number; mask?: boolean }, config?: AxiosRequestConfig) =>
    api.get<{ data: ServerLogTail }>('/system/logs', { params, ...config }) as unknown as Promise<{ data?: ServerLogTail }>,
}

// 本机环境体检（P-20261003-317）：GET /api/selfcheck 只读聚合既有环境信号
//（git/lfs/tmux/agent 运行时/端口注册表/buildInfo/数据盘水位/配置完整性
// P-20261006-10）。item 为稳定键（i18n 标题映射 selfcheck.items.*、agent
// 程序化分支），status 三态语义，detail/hint 为服务端语言中立原文（Markdown
// 直出贴 issue）
export type SelfCheckStatus = 'ok' | 'warn' | 'fail'

export interface SelfCheckItem {
  item: string
  status: SelfCheckStatus
  detail: string
  hint?: string
}

// 本机体检趋势面（P-20261005-169）：GET /api/selfcheck 响应内联 hist——
// 每次体检与每日定时各落一条数值快照（selfcheckhist 环形 20 条），服务端
// 随响应下发本次快照 + 与上一次的对比（远程诊断 compare 内联同构，前端免
// 二次请求）。数值字段零值 = 未采集（消费方隐藏该指标；terminals 恒真实）
export interface SelfCheckSnapshot {
  time: string
  /** 数据盘可用/总量 MB（DataDir 所在卷，disk 条目同源） */
  diskAvailMB?: number
  diskTotalMB?: number
  /** 进程堆内存 MB（与 /api/system/health 同源；系统级内存无跨平台读取源） */
  memUsedMB?: number
  /** OSC 133 运行点亮的会话数（shell 集成缺失恒 0 = 未采集） */
  activeSessions?: number
  /** 打开的终端会话总数（恒真实，0 是真实值非哨兵） */
  terminals: number
  /** goroutine 数（进程负载代理指标） */
  goroutines?: number
}

export interface SelfCheckHistDelta {
  diskAvailMB: number
  memUsedMB: number
  activeSessions: number
  terminals: number
}

export interface SelfCheckHist {
  runs: number
  latest: SelfCheckSnapshot
  prev?: SelfCheckSnapshot
  delta?: SelfCheckHistDelta
}

export const selfCheckApi = {
  get: (config?: AxiosRequestConfig) =>
    api.get<{ data: SelfCheckItem[]; hist?: SelfCheckHist }>('/selfcheck', config) as unknown as Promise<{ data?: SelfCheckItem[]; hist?: SelfCheckHist }>,
}

// 开工检查单晨报（P-20261005-219）：GET /api/morning-brief 聚合跨天连续性信号
//（未推送提交/运行中 agent 会话/未读通知与待审批）。三源独立降级：源失败 =
// 该键整体缺席（Go 侧 server/api/system/morningbrief.go 同构），调用方按
// 「键存在且 count>0」提醒——缺席不猜测、全零零打扰。date 是服务端本地当日
// yyyy-MM-dd（人机对「今天」的同一锚）
export interface MorningUnpushedProject {
  id: string
  name: string
  ahead: number
}

export interface MorningBrief {
  date: string
  unpushed?: { count: number; projects: MorningUnpushedProject[] }
  runningAgents?: { count: number }
  unread?: { count: number; notifications: number; approvals: number }
}

export const morningBriefApi = {
  get: (config?: AxiosRequestConfig) =>
    api.get<{ data: MorningBrief }>('/morning-brief', { silent: true, ...config }) as unknown as Promise<{ data?: MorningBrief }>,
}

// 实例族总览（P-20261003-56）：同机多实例按 claim 聚合的族表行（Go 侧
// server/api/system/fleet.go 同构——claim 元数据 + 探活三态，不含他实例内容）
export interface FleetProjectRef {
  id: string
  name: string
}
export interface FleetInstanceRow {
  instanceId: string
  port: number
  self: boolean
  /** self=本实例恒活 / online=存活 / invalid=端口被他用（原实例已不在）/ offline=不可达 */
  status: 'self' | 'online' | 'invalid' | 'offline'
  version?: string
  projects: FleetProjectRef[]
  startedAt?: string
  updatedAt?: string
  /** 全部 claim 超时未续期 = 崩溃残留（清理按钮的判据之一） */
  stale: boolean
}

// 联邦会话派发（P-20261004-101）：中心在从实例上创建 agent 会话的结果
//（Go 侧 server/api/system/dispatch.go 同构；会话本体在对端，本端只持寻址信息）
export interface DispatchSessionResult {
  remoteSessionId: string
  remoteSessionName: string
  instanceId: string
  instanceUrl: string
  runtime: string
  launched: boolean
}

// 联邦派发记录（P-20261004-131）：成功派发的寻址账（Go 侧
// server/store/dispatchrecord.go DispatchRecord 同构）——中心进度回流轮询
//（useFleetTaskBackflow）据此寻址对端 GET /agent-tasks。TTL 7 天 + 环形 200
// 服务端收账； DELETE 为前端「不再跟踪」入口
export interface DispatchRecord {
  id: string
  instanceId: string
  instanceName?: string
  instanceUrl?: string
  remoteSessionId: string
  remoteSessionName?: string
  runtime?: string
  at: string
}

// 联邦活动热力（P-20261004-98）：中心并发拉取各注册实例 /reports/activity 的
// 对比矩阵行（Go 侧 server/api/system/activitymatrix.go 同构）。序列行形状与
// 单实例端点同源（report.ts ActivityDayEntry，type-only 跨域引用零运行时耦合）
export interface ActivityMatrixTotals {
  commits: number
  sessions: number
  commands: number
}
export interface ActivityMatrixRow {
  instanceId: string
  name: string
  self: boolean
  /** ok=序列在手 / unreachable=网络层失败或对端异常 / unsupported=旧对端无 activity 端点（404） */
  status: 'ok' | 'unreachable' | 'unsupported'
  /** date 升序（旧→新）；仅 ok 行携带（omitempty 下空序列可缺席） */
  series?: ActivityDayEntry[]
  totals: ActivityMatrixTotals
}

// 实例管理
export const instanceApi = {
  list: (config?: AxiosRequestConfig) => api.get('/instances', config),
  add: (data: { name: string; url: string; token?: string }) => api.post('/instances', data),
  remove: (id: string) => api.delete(`/instances/${id}`),
  update: (id: string, data: { name?: string; url?: string; token?: string }) => api.put(`/instances/${id}`, data),
  check: (id: string, config?: AxiosRequestConfig) => api.post(`/instances/${id}/check`, undefined, config),
  checkBatch: (config?: AxiosRequestConfig) => api.post('/instances/check-batch', undefined, config),
  // 联邦派发（P-20261004-101）：会话创建参数透传（kind 恒 agent，服务端定形）；
  // 对端 4xx 预检原文透传（KNOWN_ERROR_I18N 跨实例同文案），网络失败 502
  dispatch: (id: string, data: { name?: string; runtime?: string; dir?: string; launchArgs?: string }, config?: AxiosRequestConfig) =>
    api.post<{ data: DispatchSessionResult }>(`/instances/${id}/dispatch`, data, config) as unknown as Promise<{ data?: DispatchSessionResult }>,
  // 派发寻址账清单（P-20261004-131）：回流轮询的寻址依据
  dispatched: (config?: AxiosRequestConfig) =>
    api.get<{ data: DispatchRecord[] }>('/instances/dispatched', config) as unknown as Promise<{ data?: DispatchRecord[] }>,
  // 移除单条派发记录（「不再跟踪」；幂等，未知 id 同样 200）
  deleteDispatched: (recordId: string, config?: AxiosRequestConfig) =>
    api.delete(`/instances/dispatched/${recordId}`, config),
  // 表单内「测试连接」：服务端代为探测（浏览器直连跨源必撞 CORS 误判失败）
  probe: (data: { url: string; token?: string }, config?: AxiosRequestConfig) =>
    api.post<{ data: { status: string; version?: string; httpStatus?: number; suggestedUrl?: string; tlsHint?: boolean } }>('/instances/probe', data, config),
  // 实例族：聚合族表（探活在服务端做，死实例最坏 10s——调用方给足超时）；
  // as unknown 双断言同 systemHealthApi——拦截器已解包响应体，axios 泛型失真
  fleet: (config?: AxiosRequestConfig) =>
    api.get('/instances/fleet', config) as unknown as Promise<{ data: FleetInstanceRow[] }>,
  cleanResidual: (instanceId: string, config?: AxiosRequestConfig) =>
    api.delete(`/instances/fleet/${instanceId}`, config) as unknown as Promise<{ data: { removed: number } }>,
  // 联邦活动热力（P-20261004-98）：各注册实例最近 days 天活动序列对比矩阵；
  // 服务端 5 分钟缓存 + 跨实例扇出，调用方 silent 拉取（值班大屏失败静默降级）
  activityMatrix: (days?: number, config?: AxiosRequestConfig) =>
    api.get<{ data: { days: number; rows: ActivityMatrixRow[] } }>('/instances/activity-matrix', { params: days ? { days } : undefined, ...config }) as unknown as Promise<{ data?: { days: number; rows: ActivityMatrixRow[] } }>,
}

// Token 管理
export const tokenApi = {
  list: () => api.get('/tokens'),
  create: (data: { name: string; expiresInDays: number }) => api.post('/tokens', data),
  delete: (id: string) => api.delete(`/tokens/${id}`),
}

// Agent Token 管理（sca_ 前缀，终端内智能体调用本系统 API 的长效令牌）
export interface AgentTokenMeta {
  exists: boolean
  prefix: string
  createdAt: string
  rotatedAt: string
}
export const agentTokenApi = {
  get: () => api.get('/agent-token'),
  reveal: () => api.post('/agent-token/reveal'),
  rotate: () => api.post('/agent-token/rotate'),
  revoke: () => api.delete('/agent-token'),
}

// 入站事件 Hook 凭据（sch_ 前缀，P-20261003-23）：外部事件 POST /api/hooks 的
// 函数级凭据。与 Agent Token 独立权限域——泄露只影响通知噪音。明文只在
// rotate 响应出现一次，服务端仅存哈希；无凭据时入站整体 401
export interface HookTokenMeta {
  exists: boolean
  prefix: string
  createdAt: string
  rotatedAt: string
}
export const hookTokenApi = {
  get: () => api.get('/hook-token'),
  // 签发/轮换同一入口：无凭据即签发，已有则旧值立即失效
  rotate: () => api.post('/hook-token/rotate'),
  revoke: () => api.delete('/hook-token'),
}

// 更新管理
// 更新状态快照（GET /updates/status，与 server/model UpdateStatusResponse 对齐）：
// status = 服务端状态机（idle/checking/downloading/verifying/replacing/restarting/
// success/failed/rolled_back）；result* = 换包子进程落盘的结果文件（空闲/终态时附带）
export interface UpdateStatusPayload {
  status: string
  progress: number
  total: number
  version: string
  error?: string
  result?: string
  resultError?: string
  resultAt?: string
}

export const updateApi = {
  check: (config?: AxiosRequestConfig) => api.get('/updates/check', config),
  // 异步受理（P-20261109-10）：202 = 已受理、后台下载/校验/换包，进度走 status
  // 轮询（stores/updateProgress）；受理前拒绝（在途 409 / npm 409 / 已是最新 400 /
  // 伴随校验资产重拉后仍未取到 500，P-20261109-9）同步返回。响应 { message, version }。
  // config 可选：版本面板以 silent 发起、被拒反馈由面板自出——拦截器错误 toast
  // 依赖项目页外壳注入的 message API，首页/设置入口拿不到
  apply: (config?: AxiosRequestConfig) =>
    api.post('/updates/apply', undefined, config) as unknown as Promise<{ message?: string; version?: string }>,
  status: (config?: AxiosRequestConfig) =>
    api.get<{ data: UpdateStatusPayload }>('/updates/status', config) as unknown as Promise<{ data?: UpdateStatusPayload }>,
  // 确认已读更新结果（清结果文件 + 状态机复位）；在途更新服务端 409 拒绝不清
  clearStatus: (config?: AxiosRequestConfig) => api.delete('/updates/status', config),
  // 本机优雅重启（P-20261106 页面重启链）：服务形态=SCM recovery 拉起，
  // systemd=systemctl restart，前台=原参数自 spawn。自定义头与 /api/shutdown
  // 同型 CSRF 防线（服务端校验存在性）
  restart: () => api.post('/restart', {}, { headers: { 'X-SC-Restart': '1' }, timeout: 10000 }),
  healthPing: (config?: { timeout?: number; silent?: boolean }) => api.get('/health', config),
  // 传上级实例 ID：中心地址与凭据由子实例后端从自身存储解析——
  // 实例列表接口不出 token，从浏览器读 token 永远是空（中心锁定时必 423）。
  // 后端在请求内同步下载完整二进制（服务端窗口 5 分钟），前端超时须对齐，
  // 否则慢链路上 axios 30s 先断、用户看到失败而服务端实际继续并最终换包
  applyFromCenter: (parentInstanceId: string) =>
    api.post('/updates/apply-from-center', { parentInstanceId }, { timeout: 5 * 60 * 1000 }),
}

// 通知项（全局，跨项目共享）
export interface NotificationItem {
  id: string
  type: 'success' | 'warning' | 'error' | 'info'
  category: string                       // git / task / clone / system / error
  title: string
  body?: string
  time: string                           // ISO 8601
  read: boolean
  projectId?: string
  projectName?: string
  action?: string                        // terminal / panel / url / preview（payload=端口号）/ watch-fallback / agent-fix（P-20261003-289，payload=部署任务 id）/ switch-instance（P-20261004-101，payload=实例 id）/ cron-retry（P-20261006-14，payload=JSON {cronId,slot}）/ stash-recover（P-20261006-48，前端落档，payload=JSON {projectId,branch,message}）/ file（P-20261005-15，payload=项目相对路径）/ update-panel（P-20261109-10，自更新通知回版本面板，无 payload）
  actionPayload?: string
  // 可选第二动作（P-20261005-150）：主动作旁的第二小钮。主动作单槽契约不回退
  //（部署失败 agent-fix / 哨兵命中 terminal 直达），第二入口走本槽——哨兵命中
  // secondAction='agent-fix'、payload='sentinel:<会话 id>'（前端按前缀分流组装
  // 修复上下文）。旧记录无字段不渲染副钮，天然向后兼容
  secondAction?: string
  secondActionPayload?: string
  // 通知关联的部署任务 id（P-20261003-142）：部署终态通知「下载日志」行内
  // 入口锚——action 是单槽主动作不回退，下载走本字段；旧记录无字段不渲染入口
  taskId?: string
  // 模板化文案（日报 P-20261001-30）：key 非空时优先按 key + msgParams 走
  // i18n 模板渲染，title/body 原文为回退；body 此时可承载语言中立明细
  //（如提交主题列表），渲染于翻译摘要行之后
  titleKey?: string
  bodyKey?: string
  msgParams?: Record<string, unknown>
  // 稍后提醒到期时刻（P-20261003-36，ISO 8601）：未到点 = 延后中，条目入
  // 「已延后」分组、不计未读徽标；到点由服务端巡检重挂（置顶+未读）
  snoozeUntil?: string
  // 产生通知的智能体运行时（P-20261003-187）：claude/codex/dsh/shell 等注册名。
  // 审批类通知由服务端透传发起方 agent；任务/克隆等无归属类别缺省（undefined）
  // = 不参与 runtime 过滤（选中任一 runtime chip 时不被过滤掉）
  runtime?: string
}

// 通知偏好——外发推送段（P-20261002-31，Bark/ntfy/自定义接收端）
export interface WebhookPrefs {
  enabled: boolean
  /** get = URL 模板插值（{title}/{body}）；post = POST JSON（Bark/ntfy 兼容） */
  mode: 'get' | 'post'
  /** GET 模式为支持 {title}/{body} 插值的模板；POST 模式为纯端点。服务端加密存储 */
  url: string
  /** important = 审批挂起 + 失败/异常类（默认）；all = 全部 */
  scope: 'important' | 'all'
}

// 项目×类别二维静音项（P-20261003-168）：命中组合的通知不入账（服务端 Add
// 判定点拦截，站内/WS/webhook 一并静默）
export interface ProjectMute {
  projectId: string
  category: string
}

// 通知偏好
export interface NotificationPrefs {
  enabled: Record<string, boolean>
  longTaskThresholdMs: number
  desktopNotify: boolean
  webhook: WebhookPrefs
  /** agent 长会话正常退出提醒阈值（秒，默认 300 = 5 分钟，P-20261002-140） */
  longSessionNotifySec: number
  /** Claude 会话花费阈值告警（tokens，0 = 关默认，P-20261003-157）；存量偏好可能缺该字段，读侧按 0 兜底 */
  claudeSpendAlertTokens: number
  /** 项目级静音清单（P-20261003-168）：存量偏好可能缺该字段，读侧按空数组兜底 */
  projectMutes?: ProjectMute[]
}

export const notificationApi = {
  list: (config?: AxiosRequestConfig) => api.get<{ data: NotificationItem[] }>('/notifications', config),
  add: (n: Omit<NotificationItem, 'id' | 'time' | 'read'>, config?: AxiosRequestConfig) => api.post('/notifications', n, config),
  readAll: (config?: AxiosRequestConfig) => api.post('/notifications/read-all', undefined, config),
  readOne: (id: string, config?: AxiosRequestConfig) => api.post(`/notifications/read/${id}`, undefined, config),
  dismiss: (id: string, config?: AxiosRequestConfig) => api.post(`/notifications/dismiss/${id}`, undefined, config),
  dismissMany: (ids: string[], config?: AxiosRequestConfig) => api.post('/notifications/dismiss-batch', { ids }, config),
  // 稍后提醒打标/取消（P-20261003-36）：snoozeUntil 为 RFC3339 绝对时刻（前端
  // 三档菜单算好传入），空串 = 取消延后；到点重挂由服务端巡检完成
  snooze: (id: string, snoozeUntil: string, config?: AxiosRequestConfig) =>
    api.post(`/notifications/snooze/${id}`, { snoozeUntil }, config),
  clear: (config?: AxiosRequestConfig) => api.post('/notifications/clear', undefined, config),
  getPrefs: (config?: AxiosRequestConfig) => api.get<NotificationPrefs>('/notifications/prefs', config),
  updatePrefs: (prefs: NotificationPrefs, config?: AxiosRequestConfig) => api.put<NotificationPrefs>('/notifications/prefs', prefs, config),
  // 发送测试推送：走已保存偏好同步外发，失败时后端返回 400 + 原因
  testWebhook: (config?: AxiosRequestConfig) => api.post<{ ok: boolean }>('/notifications/webhook-test', undefined, config),
}

// 全局通知 WebSocket URL（不绑定项目）
export const getNotificationWsUrl = () => {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const { instanceId, isRemote } = getCurrentInstanceContext()
  if (isRemote && instanceId) {
    return `${proto}//${location.host}/ws/proxy/${instanceId}/notifications`
  }
  return `${proto}//${location.host}/ws/notifications`
}

// ============== 帮助中心 ==============
// 与智能体共用同一数据源（GET /api/help 公开只读，经 agentops 手册对 AI 开放），
// 界面帮助中心展示的内容即智能体可查到的答案
export interface HelpCategory {
  id: string
  title: string
  titleEn?: string
}
export interface HelpEntry {
  id: string
  category: string
  q: string
  a: string
  qEn?: string
  aEn?: string
  tags?: string[]
}
export const helpApi = {
  get: () => api.get<{ data: { categories: HelpCategory[]; entries: HelpEntry[] } }>('/help'),
}

// ============== 版本更新内容（What's New，P-20261007-17） ==============
// GET /api/whats-new：嵌入文档全文 + buildVersion + 按版本切分段落（新版本在前）。
// 消费方：升级后首启 delta 弹层（useWhatsNew）+ 帮助中心「更新内容」节（后端
// help.Get 请求时并入，历史可回看）；与 metaApi 互补——meta 答「有没有/什么版本」，
// 本接口答「这版新加了什么」。token 门只读（远程管理场景 agent 同样可读）
export interface WhatsNewSection {
  /** 版本号（剥 v 前缀，如 "0.0.1"；文档标题非 semver 形态时为空串，delta 判定跳过） */
  version: string
  title: string
  /** 标题行以下的要点 markdown */
  body: string
}
export interface WhatsNewInfo {
  version: string
  content: string
  sections: WhatsNewSection[]
}
export const whatsNewApi = {
  get: (config?: AxiosRequestConfig) => api.get<{ data: WhatsNewInfo }>('/whats-new', config),
}

// ============== 能力探测（P-20261004-4） ==============
// GET /api/meta 公开只读（ops-manual 免 token 先例）：版本 + 能力清单。
// 多实例异版本部署下，前端对旧对端先探测（stores/meta hasCap）再降级——
// 替代每个新端点各写一套 404 回退；capabilities 由服务端各模块 manifest 声明
export interface MetaVersion {
  version: string
  commit: string
  buildTime: string
  apiVersion: string
}

export interface MetaInfo {
  version: MetaVersion
  capabilities: string[]
}

export const metaApi = {
  get: (config?: AxiosRequestConfig) =>
    api.get<MetaInfo>('/meta', config) as unknown as Promise<MetaInfo>,
}

// ============== 文件监听降级兜底（P-20261003-140） ==============
// inotify 配额耗尽的轮询扫描兜底状态与手动开关；能力项 watch-fallback
//（/api/meta 探测，多实例代理旧后端 404 降级）
export interface WatchFallbackStatus {
  enabled: boolean
  /** auto（配额耗尽自动启用）/ manual（用户手动开启）；未启用为空 */
  source?: 'auto' | 'manual' | ''
  /** RFC3339，本段降级开始时刻 */
  since?: string
}

export const watchFallbackApi = {
  get: (config?: AxiosRequestConfig) =>
    api.get<{ data: WatchFallbackStatus }>('/watch/fallback', config) as unknown as Promise<{ data: WatchFallbackStatus }>,
  /** enabled 缺省 = 翻转（通知动作路径）；响应 data 为开关后的状态 */
  set: (enabled?: boolean, config?: AxiosRequestConfig) =>
    api.post<{ data: WatchFallbackStatus }>('/watch/fallback', { enabled }, config) as unknown as Promise<{ data: WatchFallbackStatus }>,
}

// ============== 跨项目实时变更流（P-20261003-232） ==============
// 内核总线 file.changed 全局广播的只读内存快照（服务端环形缓冲，重启清空），
// 前端轮询聚合「跨项目最近变更」时间线（值班大屏卡 / 活动栏独立面板）
export interface ChangeStreamEvent {
  /** UnixMilli */
  ts: number
  projectId: string
  /** 变更文件绝对路径（服务端不折算项目相对形态，展示层归一） */
  path: string
}

export interface ChangeStreamSnapshot {
  events: ChangeStreamEvent[]
  /** 进程生命周期内被容量逐出的总数（>0 = 高频风暴期记录可能不完整） */
  dropped: number
}

export const watchActivityApi = {
  /** since=UnixMilli 只回该时刻之后（轮询增量）；limit 缺省 200 */
  get: (params?: { limit?: number; since?: number }, config?: AxiosRequestConfig) =>
    api.get<{ data: ChangeStreamSnapshot }>('/watch/activity', { ...config, params }) as unknown as Promise<{ data: ChangeStreamSnapshot }>,
}

// ============== 跨设备剪贴板中继（P-20261002-32） ==============
// 内存单槽瞬态通道（TTL 5 分钟 + 读取即焚，服务端 server/api/system/clip.go）：
// send 成功即 opschannel 广播 clipboard.arrived，其他设备 toast 点击后 take。
// 全部 silent：404=槽空/已被人先取走、413=超限都是调用方就地给专属文案的
// 预期分支，不走全局错误 toast
export interface ClipTakeResult {
  content: string
  /** 发送方设备 id（回显） */
  origin?: string
  size: number
  /** 写入时刻 UnixMilli */
  at?: number
}

export const clipApi = {
  send: (content: string, origin: string, config?: AxiosRequestConfig) =>
    api.post<{ ok: boolean; size: number }>('/clip', { content, origin }, { silent: true, ...config }),
  take: (config?: AxiosRequestConfig) =>
    api.get<ClipTakeResult>('/clip', { silent: true, ...config }) as unknown as Promise<ClipTakeResult>,
}
