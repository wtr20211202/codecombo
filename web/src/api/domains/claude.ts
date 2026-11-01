// Claude 会话域 API：只读扫描 ~/.claude/projects 的本地会话列表
import api from '../http'
import type { AxiosRequestConfig } from 'axios'

/** 上下文压力估算（server/claudesessions.Pressure）：尾部 usage 近似，非精确账目 */
export interface ClaudeSessionPressure {
  estimatedTokens: number
  windowTokens: number
  percent: number
  /** 所用 assistant 条目的 timestamp（RFC3339，该行缺失时为空） */
  sampledAt?: string
  /** 恒 true：显式标注估算语义 */
  estimated: boolean
}

/** 会话累计 token 用量（server/claudesessions.Usage，P-20261002-139）：
 * assistant 消息 usage 全文逐条聚合（input+output+cache_read），精确账目
 * （区别于 pressure 的 ≈ 尾部近似） */
export interface ClaudeSessionUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  /** 总量（= input+output+cache_read），会话列表展示值 */
  totalTokens: number
}

/** 会话结构化台账（server/claudesessions.Ledger，P-20261005-208）：
 * timeline tool_use 事件的会话级聚合——写类工具触达的去重文件数、shell 命令
 * 次数、首尾工具活动跨时。三段可独立为零，消费方按段零值隐藏 */
export interface ClaudeSessionLedger {
  filesWritten: number
  commandsRun: number
  durationMs: number
}

/** 单个 Claude 会话元数据（server/claudesessions.Session） */
export interface ClaudeSessionInfo {
  id: string
  title: string
  cwd: string
  messageCount: number
  firstAt: string
  lastAt: string
  sizeBytes: number
  /** 正被活终端写入 = 进行中：恢复入口隐藏（防双进程写同一对话）。mtime 启发式
   * 为基线，服务端按终端注册表三档精确化（P-20261031-1）：Codecombo 拉起的会话
   * 活终端挂载=恒活跃、关联终端已关=立即失活、原生会话收敛 90s 窄档 */
  active: boolean
  /** 上下文压力估算（P-20261002-58）：仅活跃会话且端点 withPressure=true 时返回 */
  pressure?: ClaudeSessionPressure
  /** 累计 token 用量（P-20261002-139）：缺省 = 无 usage 数据（≠ 零消耗） */
  usage?: ClaudeSessionUsage
  /** 结构化台账（P-20261005-208）：缺省 = 无工具动作数据（纯聊天/纯只读工具
   * 会话不上账），智能体会话考古可编程筛「改文件最多 / 跑命令异常多」的会话 */
  ledger?: ClaudeSessionLedger
  /** 星标（P-20261003-67 策展层）：置顶显示（服务端分页前重排 + 前端置顶分组） */
  starred?: boolean
  /** 人话备注（P-20261003-67）：≤200 rune（服务端钳制），全文搜索的额外命中源 */
  note?: string
  /** 策展隐藏（P-20261003-112）：仅「显示已隐藏」管理视图行恒带 true——默认
   * 视图不含隐藏会话（服务端已剔除），transcript 文件零触碰可恢复 */
  hidden?: boolean
  /** transcript 文件在本机的绝对路径（P-20261003-215，服务端数据面同源派生）：
   * 回放页「AI 总结」经 ask-agent prompt 让 agent 自读全量。前端不自拼该路径
   * （目录编码是 claude 内部实现且根目录受 CC_CLAUDE_DIR 覆盖）；旧版本对端
   * （远程实例代理到旧服务）缺省 → 摘要入口禁用降级 */
  transcriptPath?: string
}

export interface ClaudeSessionList {
  sessions: ClaudeSessionInfo[]
  total: number
}

/** 会话时间窗溯源结果（server/claudesessions.SessionsAtResult，P-20261007-11）：
 * 时间窗命中（截断前）总数 + 接近度升序页；Truncated = 超上限只返回了前段 */
export interface ClaudeSessionsAt {
  sessions: ClaudeSessionInfo[]
  total: number
  truncated: boolean
}

/** 时间线单步（server/claudesessions.TimelineEntry）：kind = user/assistant/tool/result */
export interface ClaudeTimelineEntry {
  kind: 'user' | 'assistant' | 'tool' | 'result'
  /** 原始 RFC3339 串；个别行无时间戳为空 */
  at: string
  /** 文本摘要 */
  text: string
  /** 工具名（kind=tool） */
  tool?: string
  /** 工具关键输入摘要（kind=tool） */
  input?: string
  /** 结果状态（kind=result）：ok / error */
  status?: 'ok' | 'error'
}

/** 轮级语义标签对（server/store.ClaudeTurnTag，P-20261003-256）：书签=位置、
 * 标签=语义的互补面。at = timeline 条目 at 原串（RFC3339，书签同款逻辑键）；
 * tag = 服务端已消毒的标签名（trim+剥前导 #，≤32 rune） */
export interface ClaudeTurnTag {
  at: string
  tag: string
}

export interface ClaudeTimeline {
  entries: ClaudeTimelineEntry[]
  /** 尾部窗口内总条数（供「加载更多」判断） */
  total: number
  /** 会话超出尾部窗口、更早内容不可达 */
  truncated: boolean
  /** 轮级书签（P-20261003-122，claudecur 策展域）：star 过的 assistant 轮时刻
   * （RFC3339 升序去重）。旧版本对端缺省 → 无书签（空态降级） */
  bookmarks?: string[]
  /** 轮级语义标签（P-20261003-256，同域）：(轮时刻, 标签名) 对集合。旧版本
   * 对端缺省 → 无标签（空态降级） */
  tags?: ClaudeTurnTag[]
}

/** 全文搜索单条命中上下文（server/claudesessions.SearchHitLine）：消息文本
 * 片段（服务端已做敏感遮蔽）+ 消息时刻（回放弹层 focusAt 定位依赖） */
export interface ClaudeSessionSearchLine {
  at?: string
  text: string
}

/** 全文搜索单会话命中条目（server/claudesessions.SearchHit）：会话 id 供
 * 回放直达（P-96 模式），title = 首条有效用户消息摘要 */
export interface ClaudeSessionSearchHit {
  sessionId: string
  title: string
  cwd?: string
  lastAt: string
  active: boolean
  lines: ClaudeSessionSearchLine[]
  /** 命中的备注原文（P-20261003-67，服务端已敏感遮蔽）：非空 = 备注也命中
   *（或 note-only 命中——lines 空），行上带「备注」来源标识 */
  note?: string
}

export interface ClaudeSessionSearchResult {
  hits: ClaudeSessionSearchHit[]
  /** 护栏触发（单文件 5MB 跳过/会话上限 200/总时限 5s/条数截断）：结果可能不全 */
  truncated: boolean
}

export const claudeApi = {
  /** 会话列表：projectId 非空 = 项目级；q = id/内容统一搜索；limit/offset 分页；
   * withPressure=true 时服务端为活跃会话按需估算上下文压力（尾部 usage 扫描）；
   * hidden=true = 管理视图（P-20261003-112）：只返回已隐藏会话（默认视图恒排除）。
   * config 透传 axios 配置（写后重取传 skipInflightDedupe 豁免在途合并，见 http.ts） */
  sessions: (
    params: { projectId?: string; q?: string; limit?: number; offset?: number; withPressure?: boolean; hidden?: boolean },
    config?: { skipInflightDedupe?: boolean },
  ) =>
    api.get('/claude/sessions', { params, ...config }),
  /** 会话历史全文搜索（P-20261003-19）：跨 transcripts 命中带 ≤2 条上下文，
   * 服务端护栏（单文件 5MB 跳过/会话上限 200/总时限 5s）超限 truncated 如实上报；
   * 命中上下文已做敏感遮蔽（P-108 模式集） */
  search: (params: { q: string; limit?: number; projectId?: string }) =>
    api.get('/claude/sessions/search', { params }),
  /** 会话时间窗溯源（P-20261007-11）：ts 时刻该项目内活跃的 Claude 会话
   *  （transcript 时间窗 [firstAt,lastAt] 覆盖 ts），按时间接近度升序上限 10。
   *  消费方=blame 悬停溯源区（ts=行提交时刻）——时段关联非因果确证，
   *  并行会话全部列出，因果判断由人做（UI 注记同款口径） */
  sessionsAt: (projectId: string, ts: string) =>
    api.get(`/projects/${projectId}/sessions-at`, { params: { ts } }),
  /** 会话回放时间线（P-20261001-3）：transcript 直读解析，时间正序分页 */
  timeline: (id: string, params: { limit?: number; offset?: number }) =>
    api.get(`/claude/sessions/${encodeURIComponent(id)}/timeline`, { params }),
  /** 会话回放导出 Markdown（P-20261003-44）：知识出站（user/assistant 分节 +
   * 工具摘要行 + 思考引用块，服务端渲染全文）。blob 下载——axios 响应拦截器只
   * 回 data 不透头，下载名由客户端按同约定合成（patch 下载同款），服务端
   * Content-Disposition 供直链/API 消费方。内容敏感闸（P-20261004-113）：
   * 命中且未确认时响应是 JSON warnings（blob.type 分流），confirm=true 二段
   * 确认（服务端 confirm=1）后真出附件——调用方经 useEgressGate 统一处理。
   * mode='qa'（P-20261004-132）：仅问答档——服务端渲染层过滤只留 user/assistant
   * 正文（跳过工具/结果/思考过程噪声，贴文档/发读者形态），下载名 -qa 尾缀；
   * 缺省 = 完整档零变化 */
  exportMd: (id: string, confirm = false, mode?: 'qa') =>
    api.get(`/claude/sessions/${encodeURIComponent(id)}/export`, {
      responseType: 'blob',
      timeout: 0,
      params: { ...(mode ? { mode } : {}), ...(confirm ? { confirm: 1 } : {}) },
    }),
  /** 会话回放导出原始 JSONL（P-20261003-60）：transcript 原文件无损直传
   *（application/x-ndjson，零渲染——机读存档/再分析/迁移的原文件本体）。
   * blob 下载约定同 exportMd（下载名客户端合成）；敏感闸二段确认同 exportMd
   *（扫描挂点在相对化改写链下游，服务端见 exportSessionJSONL） */
  exportJsonl: (id: string, confirm = false) =>
    api.get(`/claude/sessions/${encodeURIComponent(id)}/export`, {
      responseType: 'blob',
      timeout: 0,
      params: { format: 'jsonl', ...(confirm ? { confirm: 1 } : {}) },
    }),
  /** 会话批量导出 zip（P-20261003-165）：多选会话逐个走单导同一渲染/流式链
   * 打包（每会话一 md/jsonl 条目 + MANIFEST.txt 清单，≤50/批服务端 400 拒绝；
   * 全部 id 落空 404）。blob 下载约定同 exportMd（下载名客户端合成
   * claude-sessions-<日期>.zip）；POST 承载 ids（50 UUID 查询串贴近 URL 上限）。
   * passphrase（P-20261003-166）：可选口令信封档——携非空口令改出加密信封 JSON
   *（P-29 EncryptWithPassphrase，*.zip.enc.json 附件），缺省明文 zip 零变化。
   * 内容敏感闸（P-20261003-225）：全批预扫命中且未确认时响应是 JSON warnings
   * （blob.type 分流），confirm=true 二段确认（服务端 confirm=1 查询串，与
   * 单会话导出同参数位）后真出附件——调用方经 useEgressGate 统一处理。
   * config 透传（P-20261030-2）：blob 不可直链（POST + 信封前置），下载
   * 进度经 onDownloadProgress 挂 utils/downloadProgress 的驻留 toast */
  exportArchive: (payload: { ids: string[]; format?: 'md' | 'jsonl'; passphrase?: string }, confirm = false, config?: AxiosRequestConfig) =>
    api.post('/claude/sessions/export-archive', payload, {
      responseType: 'blob',
      timeout: 0,
      ...(confirm ? { params: { confirm: 1 } } : {}),
      ...config,
    }),
  /** 会话策展 upsert（P-20261003-67 + P-20261003-112）：部分更新语义——
   * starred/note/hidden 均可选，只传其一不动其余（切星标不抹备注/隐藏态）；
   * 全部清空服务端删条目。隐藏/恢复走 hidden 布尔（transcript 文件零触碰）。
   * bookmarkAdd/bookmarkRemove（P-20261003-122）：轮级书签集合增量——值为
   * timeline 条目 at 原串，服务端验形 + 去重排序钳制，响应回传权威书签集。
   * tagAdd/tagRemove（P-20261003-256）：轮级语义标签集合增量——(at,tag) 对，
   * 服务端同款验形/消毒/钳制，响应回传权威标签集 */
  setCuration: (payload: {
    sessionId: string
    starred?: boolean
    note?: string
    hidden?: boolean
    bookmarkAdd?: string
    bookmarkRemove?: string
    tagAdd?: ClaudeTurnTag
    tagRemove?: ClaudeTurnTag
  }) => api.post('/claude/sessions/curation', payload),
}
