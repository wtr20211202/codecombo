import { computed } from 'vue'
import { createDiscreteApi } from 'naive-ui'
import { useThemeStore } from '../stores/theme'
import { useProjectStore } from '../stores/project'
import { useAgentTerminal } from './useAgentTerminal'
import { useI18n } from './useI18n'
import { confirmDialog } from './useDialog'
import { resolveTaskLaunchArgs } from './useTaskFileLaunch'
import { fitByBytes } from '../utils/promptFit'
import { deployApi, type DeployerInstance } from '../api/domains/deploy'
import { remoteHostApi } from '../api/domains/remote'
import { terminalApi } from '../api/domains/terminal'
import { stripAnsiText } from './useCommitSplitExecute'

/**
 * 「交给智能体修复」（P-20261002-109）：把失败上下文（失败任务 = 命令行 +
 * 尾部输出摘要；请求错误 = 标题 + 详情摘要）拼成 prompt 经 launchArgs 预填，
 * 一键新建 agent 修复会话并打开 docked 管理页激活。复用 createAgentTerminal
 * 既有链路（同 useEditorAskAgent 范式）：runtime 取设置默认，dir 优先取失败
 * 命令的 workDir（缺失回落项目根）。
 *
 * - 输出摘要取尾部 ≤400 字符（报错信息多在尾部，P-56 复制上一条命令输出的
 *   同款尾部提取思路）；总 prompt 再按服务端 launchArgs 500 字节上限适配
 *   （超限从变量内容头部裁剪、保尾部并 … 标注，走 utils/promptFit fitByBytes
 *   单一事实源——P-20261004-6 把发起族同款算法三拷贝归一）
 * - 全文超 500 字节走任务文件降级（P-20261006-44）：完整输出（不做 400 字符
 *   摘要）落项目根 .sc-task.md，launchArgs 换短引用指令；写失败/无项目退回
 *   装箱截断（deploy 免项目链无文件面，行为与降级前一致）
 * - 上下文疑似含敏感值（凭据/令牌）时先弹确认（P-108 遮蔽模式未合入前的
 *   简单提示口径）：正则启发式命中即 confirmDialog，取消则不创建会话
 * - 部署失败通知（P-20261003-289）：kind 'deploy' 上下文 = 主机 + 工具序列 +
 *   错误尾部 + 任务 id（提示 agent 可经 GET /api/deploy/<id> 自取完整参数）。
 *   与本地项目无涉：项目未打开也照常发起（免项目 agent 会话）
 * - 已知限制同 useEditorAskAgent：设置默认运行时为纯终端（shell）时 prompt
 *   会作为初始命令注入 shell；环境探测不到任何智能体运行时时服务端降级纯
 *   shell 会话（launched=false）——以提示告知
 */

/** 输出/详情摘要的尾部截断上限（提案口径 ≤400 字符） */
export const FIX_SUMMARY_MAX_CHARS = 400

/** 哨兵命中 agent-fix 动作的 payload 前缀（P-20261005-150）：与 Go 侧
 *  SecondActionPayload 落档形态互为镜像（server/api/terminal OnSentinelHit），
 *  handNotificationAgentFix 据此前缀分流部署/哨兵两源 */
export const SENTINEL_FIX_PAYLOAD_PREFIX = 'sentinel:'

/** 失败任务上下文：完整命令行 + 失败输出（error 与 output 已由调用方合并） */
export interface AgentFixTaskContext {
  kind: 'task'
  command: string
  output: string
  /** 失败命令的工作目录（会话 cwd 用；空 = 项目根） */
  cwd?: string
}

/** 请求错误上下文：标题（请求行 + 友好文案）+ 详情摘要（原始错误） */
export interface AgentFixErrorContext {
  kind: 'error'
  title: string
  detail: string
}

/** 部署失败上下文（P-20261003-289）：主机展示串 + 工具序列 + 错误尾部 +
 *  任务 id。host/tools 为空 = 补拉失效的降级形态（detail 承载通知标题+摘要
 *  原文，prompt 跳过空行不渲染占位） */
export interface AgentFixDeployContext {
  kind: 'deploy'
  /** 主机展示串（「名称（地址）」或裸地址；空 = 无主机行） */
  host: string
  /** 工具序列去重串（init_ssh_key+simple_coding 形态；空 = 无工具行） */
  tools: string
  /** 错误尾部（降级时 = 通知标题+摘要原文） */
  detail: string
  /** 部署任务 id：提示 agent 可经 GET /api/deploy/<id> 自取完整配置（含各
   *  工具参数——500 字节 prompt 装不下全部参数，给自取锚点比硬塞更可达） */
  taskId?: string
}

/** 提交信息规范检查失败上下文（P-20261003-273）：原信息 + 结构化失败原因行
 *  （已由调用方经 i18n 渲染的成本地化文案行）。变更面板门禁弹层「交给智能体修」
 *  入口——改写合规信息在会话中产出，人工审阅后回填提交框重试 */
export interface AgentFixCommitMsgContext {
  kind: 'commitMsg'
  /** 未通过检查的完整提交信息草稿 */
  message: string
  /** 失败原因行（每条一行） */
  reasons: string[]
}

/** 哨兵命中上下文（P-20261005-150）：哨兵规则名 + 命中行摘录 + 触发会话名 +
 *  触发会话输出尾部。output 由调用方经 scrollback 补拉（剥 ANSI 后的纯文本），
 *  会话已关闭/清理时降级为仅命中行（output=matched） */
export interface AgentFixSentinelContext {
  kind: 'sentinel'
  /** 哨兵规则名（通知标题主体） */
  name: string
  /** 命中行摘录（服务端 ≤200 字符，剥 ANSI） */
  matched: string
  /** 触发会话名（空 = 反查失效的降级形态） */
  session: string
  /** 触发会话输出尾部（scrollback 全文，经 tailSummary 收 400 字符） */
  output: string
}

/** 服务日志上下文（P-20261008-15）：本机服务运行日志尾部（服务端已遮蔽敏感值）
 *  贴给 agent 会话诊断服务自身问题。诊断对象是服务进程而非某个项目——免项目
 *  发起（deploy 同款：无项目上下文也创建会话，dir 省略），有项目时 dir=项目根 */
export interface AgentFixServerLogContext {
  kind: 'serverLog'
  /** 日志日期（YYYY-MM-DD，上下文对账锚） */
  date: string
  /** 日志尾部窗口（masked 响应原文） */
  detail: string
}

export type AgentFixContext = AgentFixTaskContext | AgentFixErrorContext | AgentFixDeployContext | AgentFixCommitMsgContext | AgentFixSentinelContext | AgentFixServerLogContext

/** prompt 组装所需的极小翻译面（纯函数可测；组合式内传 useI18n 的 t） */
export type FixTranslator = (key: string, params?: Record<string, unknown>) => string

/** 尾部摘要：去首尾空白后取尾部 ≤FIX_SUMMARY_MAX_CHARS 字符，截断时 … 前缀标注 */
export function tailSummary(s: string, max = FIX_SUMMARY_MAX_CHARS): string {
  const t = (s || '').trim()
  if (t.length <= max) return t
  return '…' + t.slice(-max)
}

/** 疑似敏感值启发式（简单提示口径）：URL 内嵌凭据 / 常见令牌前缀 / 赋值形态
 *  的口令字段 / 私钥块 / Bearer 令牌。宁可误报弹确认，不可漏报静默外发 */
const SENSITIVE_PATTERNS: RegExp[] = [
  /:\/\/[^\s/:@]+:[^\s/@]+@/, // URL 内嵌 user:pass
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/, // GitHub token
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bsk-[A-Za-z0-9_-]{16,}/, // OpenAI 风格 key
  /\b(?:password|passwd|pwd|token|secret|api[_-]?key)\s*[=:]\s*\S+/i, // 赋值形态
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // 私钥块
  /\bBearer\s+[A-Za-z0-9._~-]{16,}/i, // Bearer 令牌
]

export function containsSensitiveValue(s: string): boolean {
  return SENSITIVE_PATTERNS.some((re) => re.test(s))
}

/** 工具序列去重拼接（对齐服务端 deployerSummary，server/deploy/manager.go）：
 *  空 id 跳过、allowMultiple 工具重复出现只记一次，'+' 连接 */
export function deployToolsSummary(instances: DeployerInstance[]): string {
  const seen = new Set<string>()
  const names: string[] = []
  for (const inst of instances || []) {
    if (!inst.deployerId || seen.has(inst.deployerId)) continue
    seen.add(inst.deployerId)
    names.push(inst.deployerId)
  }
  return names.join('+')
}

/** 组装修复 prompt（纯函数）：任务 = 命令行 + 失败输出尾部；错误 = 标题 + 详情尾部；
 *  部署 = 主机/工具/任务自取锚点行 + 错误尾部（host/tools 空的降级形态跳过
 *  空行，taskId 行提示 agent 自取完整配置）；哨兵 = 规则/会话/命中行 + 输出尾部。
 *  摘要先行 tailSummary(≤400 字符)，再经 fitByBytes（utils/promptFit）收进 500 字节上限 */
export function buildFixPrompt(ctx: AgentFixContext, t: FixTranslator): string {
  const tpl = fixTemplate(ctx, t)
  const raw = ctx.kind === 'task' ? ctx.output : ctx.kind === 'sentinel' ? ctx.output : ctx.kind === 'commitMsg' ? ctx.message : ctx.detail
  return fitByBytes(tpl, tailSummary(raw))
}

/** 组装完整修复 prompt（纯函数，未摘要未装箱）：超限降级时作为任务文件全文
 *  （P-20261006-44）——文件面无配额，tailSummary 的 400 字符摘要不适用，取
 *  trim 后全文；与 buildFixPrompt 同模板（fixTemplate 单源不漂移） */
export function buildFixPromptFull(ctx: AgentFixContext, t: FixTranslator): string {
  const tpl = fixTemplate(ctx, t)
  const raw = ctx.kind === 'task' ? ctx.output : ctx.kind === 'sentinel' ? ctx.output : ctx.kind === 'commitMsg' ? ctx.message : ctx.detail
  return tpl((raw || '').trim())
}

/** 修复 prompt 模板（各上下文形态共用）：content 占位 = 输出/详情/原信息段。
 *  装箱面（fitByBytes 尾部优先）与任务文件全文面同源，两侧不会漂移 */
function fixTemplate(ctx: AgentFixContext, t: FixTranslator): (content: string) => string {
  if (ctx.kind === 'task') {
    return (output) => [t('agent.fix.taskHead'), `$ ${ctx.command}`, t('agent.fix.taskOutputTail'), output].join('\n')
  }
  if (ctx.kind === 'commitMsg') {
    return (message) => [
      t('agent.fix.commitMsgHead'),
      t('agent.fix.commitMsgReasons'),
      ctx.reasons.join('\n'),
      t('agent.fix.commitMsgBody'),
      message,
    ].join('\n')
  }
  if (ctx.kind === 'deploy') {
    return (detail) => {
      const lines: string[] = [t('agent.fix.deployHead')]
      if (ctx.host) lines.push(t('agent.fix.deployHost', { host: ctx.host }))
      if (ctx.tools) lines.push(t('agent.fix.deployTools', { tools: ctx.tools }))
      if (ctx.taskId) lines.push(t('agent.fix.deployTaskRef', { taskId: ctx.taskId }))
      lines.push(t('agent.fix.deployErrorTail'), detail)
      return lines.join('\n')
    }
  }
  if (ctx.kind === 'sentinel') {
    return (output) => {
      const lines: string[] = [t('agent.fix.sentinelHead')]
      if (ctx.name) lines.push(t('agent.fix.sentinelRule', { name: ctx.name }))
      if (ctx.session) lines.push(t('agent.fix.sentinelSession', { session: ctx.session }))
      if (ctx.matched) lines.push(t('agent.fix.sentinelMatched', { matched: ctx.matched }))
      lines.push(t('agent.fix.sentinelOutputTail'), output)
      return lines.join('\n')
    }
  }
  if (ctx.kind === 'serverLog') {
    return (detail) => [
      t('agent.fix.serverLogHead'),
      t('agent.fix.serverLogDate', { date: ctx.date }),
      t('agent.fix.serverLogTail'),
      detail,
    ].join('\n')
  }
  return (detail) => [t('agent.fix.errorHead'), ctx.title, t('agent.fix.errorDetail'), detail].join('\n')
}

export function useAgentFix() {
  const projectStore = useProjectStore()
  const themeStore = useThemeStore()
  const { t } = useI18n()
  // 离散 message（useEditorAskAgent 同范式）：本组合式在组件 setup 期调用一次，
  // 事件回调里发提示不依赖祖先 NMessageProvider
  const { message } = createDiscreteApi(['message'], {
    configProviderProps: computed(() => ({
      theme: themeStore.naiveTheme,
      themeOverrides: themeStore.naiveOverrides,
    })),
  })

  /** 交给智能体修复：新建 agent 会话（prompt 经 launchArgs 预填）并打开 docked
   *  管理页激活。上下文疑似含敏感值时先确认（取消 = 不创建）。
   *  dir 语义按上下文：task=失败命令 workDir（缺失回落项目根）、error=项目根、
   *  deploy/serverLog=项目根且允许为空——部署修复与服务日志诊断和本地项目无涉，
   *  项目未打开时发起免项目 agent 会话（通知中心/设置面是全局面，常在无项目
   *  上下文时点击）。
   *  上下文全文超 500 字节走任务文件降级（P-20261006-44）：完整输出落项目根
   *  .sc-task.md，launchArgs 换短引用指令；写失败/无项目（deploy/serverLog 免
   *  项目链）退回装箱截断 */
  async function handToAgent(ctx: AgentFixContext): Promise<void> {
    const tt = t as unknown as FixTranslator
    // 全文优先：敏感判定与超限降级都以未摘要全文为面（全文比装箱摘要更完整，
    // P-20261006-44 修正案）
    const full = buildFixPromptFull(ctx, tt)
    if (containsSensitiveValue(full)) {
      const ok = await confirmDialog({
        title: t('agent.fix.sensitiveTitle'),
        content: t('agent.fix.sensitiveBody'),
        type: 'warning',
      })
      if (!ok) return
    }
    const root = projectStore.currentProject?.path || ''
    const dir = ctx.kind === 'task' ? (ctx.cwd || root) : root
    if (!dir && ctx.kind !== 'deploy' && ctx.kind !== 'serverLog') return
    const agentTerminal = useAgentTerminal()
    if (agentTerminal.busy.value) return
    // 超限降级：全文写项目根 .sc-task.md + 短引用指令（写失败退回装箱截断）
    const plan = await resolveTaskLaunchArgs(projectStore.currentProjectId, full, buildFixPrompt(ctx, tt))
    const info = await agentTerminal.create(undefined, { dir: dir || undefined, launchArgs: plan.launchArgs })
    if (!info) {
      message.error(t('agent.fix.failed'))
      return
    }
    if (plan.taskFile) {
      message.info(t('agent.taskFile.fallbackNote'))
    } else if (plan.degraded) {
      message.warning(t('agent.taskFile.fallbackWriteFailed'))
    }
    if (!info.launched) {
      message.warning(t('agent.fix.degraded'))
    } else {
      message.success(t('agent.fix.success'))
    }
    await agentTerminal.open('docked')
  }

  /** 部署失败「交给智能体修复」（P-20261003-289）：通知中心 agent-fix 动作入口。
   *  payload = 部署任务 id：先补拉完整任务配置（GET /api/deploy/:taskId，
   *  silent——保留窗口外 404 是预期降级分支，不弹错误 toast）拿到主机地址/
   *  工具序列/错误尾部，并尽力按 hostId 解析主机名（GET /api/remotehosts，
   *  任务记录只存地址）；补拉/解析任一失败降级为仅通知标题+摘要。随后走
   *  handToAgent 同一发起链路（敏感确认 / 500 字节装箱 / 结果提示全复用） */
  async function handDeployFailureToAgent(n: { actionPayload?: unknown; title?: string; body?: string }): Promise<void> {
    const taskId = String(n.actionPayload ?? '')
    if (!taskId) return
    let host = ''
    let tools = ''
    let detail = [n.title, n.body].filter(Boolean).join('\n')
    try {
      const res = (await deployApi.get(taskId, { silent: true })) as unknown as { data?: { hostId?: string; host?: string; error?: string; instances?: DeployerInstance[] } }
      const task = res?.data
      if (task) {
        tools = deployToolsSummary(task.instances || [])
        if (task.error) detail = task.error
        try {
          // 主机名+地址:端口展示（任务记录只存地址不带端口，端口在 remotehosts
          // 记录上）；解析失败降级裸地址
          const hosts = (await remoteHostApi.list({ silent: true })) as unknown as { data?: Array<{ id: string; name: string; host: string; port: number }> }
          const hit = hosts?.data?.find(x => x.id === task.hostId)
          host = hit ? `${hit.name}（${hit.host}:${hit.port}）` : (task.host || '')
        } catch { host = task.host || '' }
      }
    } catch { /* 补拉失效：降级仅通知摘要 */ }
    await handToAgent({ kind: 'deploy', host, tools, detail, taskId })
  }

  /** 哨兵命中「交给智能体修复」第二动作（P-20261005-150）：payload 解出的
   *  触发会话 id——补拉该会话输出尾部（GET /api/terminals/:id/scrollback，
   *  silent——会话已关闭/清理的 404 是预期降级分支，不弹错误 toast）剥 ANSI 后
   *  作输出面；哨兵名/命中行/会话名取通知 MsgParams（服务端落档的语言中立
   *  明细）。会话 cwd 由 handToAgent 取归属项目根——pendingAction 分发链已按
   *  通知 projectId 先切项目。随后 handToAgent 同一发起链（敏感确认/装箱/降级
   *  /结果提示全复用） */
  async function handSentinelHitToAgent(sessionId: string, n: { msgParams?: Record<string, unknown> }): Promise<void> {
    const name = String(n.msgParams?.name ?? '')
    const matched = String(n.msgParams?.matched ?? '')
    const session = String(n.msgParams?.session ?? '')
    let output = matched
    try {
      const buf = await terminalApi.scrollback(sessionId, { silent: true }) as unknown as ArrayBuffer
      if (buf) output = stripAnsiText(buf)
    } catch { /* 会话已关闭/清理：降级仅命中行摘录 */ }
    await handToAgent({ kind: 'sentinel', name, matched, session, output })
  }

  /** 通知 agent-fix 动作统一分发（P-20261003-289 部署失败 + P-20261005-150
   *  哨兵命中）：payload 前缀分流——「sentinel:<会话 id>」走哨兵链（会话输出
   *  组装上下文），其余按部署任务 id 补拉任务配置。部署任务 id 恒 sc_dt_ 前缀
   *  （server/deploy/manager.go），与 sentinel: 前缀不相交 */
  async function handNotificationAgentFix(n: { actionPayload?: unknown; msgParams?: Record<string, unknown>; title?: string; body?: string }): Promise<void> {
    const payload = String(n.actionPayload ?? '')
    if (payload.startsWith(SENTINEL_FIX_PAYLOAD_PREFIX)) {
      await handSentinelHitToAgent(payload.slice(SENTINEL_FIX_PAYLOAD_PREFIX.length), n)
      return
    }
    await handDeployFailureToAgent(n)
  }

  return { handToAgent, handDeployFailureToAgent, handNotificationAgentFix }
}
