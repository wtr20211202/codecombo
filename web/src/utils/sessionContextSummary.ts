/**
 * 会话启动上下文摘要（P-20261006-47）：设置键 sessionContext 的解析/序列化与
 * 「项目笔记首段 / TODO 概要 / 环境画像」上下文行的纯拼装——P-176 的 git 摘要
 * 组装器扩为上下文装配面的纯函数半边（取数在 composables/useSessionContextSummary，
 * 装箱语义沿 utils/gitStatusSummary 既有定案：本文件只做拼装与字节护栏）。
 *
 * 值语法（与 Go 侧 config.NormalizeSessionContext 同一份契约，两处同步改）：
 * - ''            → ['git']（未配置回落 git = P-176 既有默认行为零变化）
 * - 'none'        → []（显式全关）
 * - 'git,notes'   → 合法 token 子集（规范序去重）；手改脏值取「可读懂的子集」
 *   （'git,wiki' → ['git']），整体读不懂 → []——宁可少注入也不塞未要求的上下文
 * 合法 token：git / notes / todos / env（env = 项目环境画像，P-20261007-14）。
 */

import { byteLength } from './promptFit'

export type SessionContextOption = 'git' | 'notes' | 'todos' | 'env'

/** 合法多选全集（settings UI 勾选项与序列化规范序的唯一事实源）。
 * env = 项目环境画像（P-20261007-14 接入 P-20261006-47 注入面）。追加在尾部：
 * 存量设置串（git/todos 等）的规范序不变，升级零迁移 */
export const SESSION_CONTEXT_ALL: SessionContextOption[] = ['git', 'notes', 'todos', 'env']

/**
 * launchArgs 段落声明序（弃段阶梯 = 逐项降级序）：promptBuilder 按声明顺序弃
 * 前言段——git 殿后 = 最后弃（提案「超限逐项降级保 git」定案），notes 先于
 * todos 让位（提案枚举序 git > 笔记 > TODO 的保留优先级）。展示序同此。
 * env（环境画像）最先弃：它是「起服务前的环境概览」而非任务上下文，明细始终
 * 可 GET env-profile 现查，字节紧张时让位给 git/笔记/TODO。
 */
export const SESSION_CONTEXT_ASSEMBLY_ORDER: SessionContextOption[] = ['env', 'notes', 'todos', 'git']

/** 笔记首段注入自身字节上限：为任务正文保底留出 ≥300 字节（500 - 本上限 -
 *  git 摘要 200 - 换行），与 GIT_SUMMARY_MAX_BYTES 的保底算术同式 */
export const NOTES_SUMMARY_MAX_BYTES = 180

/** TODO 概要注入自身字节上限（git 摘要同款 200 档） */
export const TODO_SUMMARY_MAX_BYTES = 200

/** 环境画像注入行自身字节上限（与 git 摘要同档：端口/哨兵/部署目标三段概要） */
export const ENV_SUMMARY_MAX_BYTES = 220

/** 注入行的端口/部署目标展示上限（明细在 GET env-profile，注入面只取概览） */
export const ENV_SUMMARY_MAX_PORTS = 4
export const ENV_SUMMARY_MAX_TARGETS = 3

/** 单个 label/目标名的展示字符上限：上报 label 服务端允许 4KB，注入面必须截断 */
const ENV_CLIP_CHARS = 24

/** TODO 概要展示的顶层条目数（path:line 引用，超出的由计数行表达） */
export const TODO_SUMMARY_MAX_ENTRIES = 3

/**
 * 解析设置值为多选集合：未配置回落 ['git']；'none' → []；手改脏值取可读懂的
 * token 子集（整体读不懂 → []）；合法 token 按规范序去重（写侧已白名单，
 * 此处兜手改配置文件的脏值）。
 */
export function parseSessionContext(raw: string | undefined | null): SessionContextOption[] {
  const value = (raw ?? '').trim()
  if (value === '') return ['git']
  if (value === 'none') return []
  const want = new Set(value.split(',').map(t => t.trim()))
  return SESSION_CONTEXT_ALL.filter(t => want.has(t))
}

/** 多选集合序列化为设置值：空集 = 'none'（显式全关），其余规范序逗号连接 */
export function serializeSessionContext(options: SessionContextOption[]): string {
  if (options.length === 0) return 'none'
  const want = new Set(options)
  return SESSION_CONTEXT_ALL.filter(t => want.has(t)).join(',')
}

/** 极小翻译面（纯函数可测；useGitStatusSummary 同款先例） */
export type SessionContextTranslator = (key: string, params?: Record<string, unknown>) => string

/** 笔记摘要组装所需事实（取数面见 composables/useSessionContextSummary） */
export interface NotesSummaryFacts {
  /** 项目名（摘要自带归属标注，git 摘要同款） */
  projectName: string
  /** 笔记全文（笔记库里该项目「[项目名]」前缀篇——面板与 agent 共享的同一份
   *  markdown，P-20261108-3 单库化后取最近更新那篇）；空 = 无笔记 */
  content: string
}

/** 首段提取：按空行分段（markdown 惯例）取首个非空段，段内换行折叠为空格
 *  ——摘要单行注入，多行原文压平（装配器段落以 \n 分段，段内换行会伪装成新段） */
export function firstNoteParagraph(content: string): string {
  const para = content
    .split(/\r?\n\s*\r?\n/)
    .map(s => s.trim())
    .find(s => s !== '')
  return (para ?? '').replace(/\s*\r?\n\s*/g, ' ').trim()
}

/**
 * 拼一行项目笔记摘要：笔记首段（项目前缀篇首段）截到 NOTES_SUMMARY_MAX_BYTES。
 * 首段价值密度在开头 → 保头截断（fitByBytes 保尾方向相反，… 尾缀标注）；
 * 无笔记 / 首段完全塞不下返回空串（上游按「无笔记」不注入，不产悬空标签）
 */
export function buildNotesSummaryLine(facts: NotesSummaryFacts, t: SessionContextTranslator): string {
  const project = facts.projectName.trim()
  const para = firstNoteParagraph(facts.content)
  if (!para) return ''
  const key = 'agentTerminal.sessionContext.notesLine'
  const line = t(key, { project, excerpt: para })
  if (byteLength(line) <= NOTES_SUMMARY_MAX_BYTES) return line
  // 批量估裁（UTF-8 每字符 ≤3 字节 BMP 口径，buildGitStatusSummary 同式）再逐字微调
  let excerpt = para.slice(0, Math.max(0, para.length - Math.ceil((byteLength(line) - NOTES_SUMMARY_MAX_BYTES) / 3)))
  while (excerpt.length > 0 && byteLength(t(key, { project, excerpt: `${excerpt}…` })) > NOTES_SUMMARY_MAX_BYTES) {
    excerpt = excerpt.slice(0, -1)
  }
  if (!excerpt) return ''
  return t(key, { project, excerpt: `${excerpt}…` })
}

/** TODO 概要组装所需事实（total/truncated 为 GET /todos 面板契约字段） */
export interface TodosSummaryFacts {
  projectName: string
  /** 命中行总数（服务端权威计数，truncated 时为上限值） */
  total: number
  /** 超 500 上限截断标记：计数以「N+」呈现（诚实注记不冒充全量） */
  truncated: boolean
  /** 顶层条目（文件组展平序的前几条即可，path + line） */
  entries: { path: string; line: number }[]
}

/**
 * 拼一行 TODO 概要：面板概要计数 + 前 TODO_SUMMARY_MAX_ENTRIES 条顶层条目
 * （path:line 引用，agent 可按图索骥）。超限时条目逐项让位（计数行是概要
 * 下限，最后放弃）；计数行自身都塞不下属理论边界，原样交装配层兜底
 */
export function buildTodosSummaryLine(facts: TodosSummaryFacts, t: SessionContextTranslator): string {
  const project = facts.projectName.trim()
  if (facts.total <= 0) return ''
  const count = `${facts.total}${facts.truncated ? '+' : ''}`
  const noEntriesKey = 'agentTerminal.sessionContext.todosLineNoEntries'
  const key = 'agentTerminal.sessionContext.todosLine'
  const entries = facts.entries
    .slice(0, TODO_SUMMARY_MAX_ENTRIES)
    .map(e => `${e.path}:${e.line}`)
  if (entries.length === 0) {
    return t(noEntriesKey, { project, count })
  }
  const joined = entries.join(', ')
  const line = t(key, { project, count, entries: joined })
  if (byteLength(line) <= TODO_SUMMARY_MAX_BYTES) return line
  // 条目逐项让位（保头——文件组展平序即面板所见序）
  for (let n = entries.length - 1; n >= 1; n--) {
    const shorter = t(key, { project, count, entries: entries.slice(0, n).join(', ') })
    if (byteLength(shorter) <= TODO_SUMMARY_MAX_BYTES) return shorter
  }
  return t(noEntriesKey, { project, count })
}

/** 环境画像组装所需事实（取数面 = GET /projects/:id/env-profile，P-20261007-14） */
export interface EnvSummaryFacts {
  projectName: string
  /** dev 端口观测（登记面 = 探测/上报面；画像详情端点同源） */
  devPorts: { port: number; label: string }[]
  /** 可见哨兵规则数；undefined = 源降级不可知（不冒充 0 条） */
  sentinelCount?: number
  /** 部署目标名（地址/凭据不出服务端摘要）；undefined = 源降级不可知 */
  deployTargets?: string[]
}

/** 单段文本按字符截断（保头 + …；UTF-16 代理对不劈开） */
function clipChars(s: string, max: number): string {
  const chars = Array.from(s.trim())
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max).join('')}…`
}

/**
 * 拼一行项目环境画像摘要：dev 端口（端口 + label 前几项）、哨兵数、部署目标名
 * ——给新 agent 会话的「起服务前环境认知」；画像=历史观测聚合非实时拓扑的诚实
 * 边界随行标注。三段全无（该端点源全空）返回空串，不产悬空标签。
 *
 * 超限让位序：部署目标先让（明细可 GET），再弃哨兵计数，最后硬截断——端口
 * label 与目标名在进入拼装前已按字符截断，硬截断兜项目名等未受控输入的极端。
 */
export function buildEnvSummaryLine(facts: EnvSummaryFacts, t: SessionContextTranslator): string {
  const project = facts.projectName.trim()
  if (!project) return ''
  const sep = t('agentTerminal.sessionContext.envSeparator')
  type Part = { kind: 'ports' | 'sentinels' | 'targets'; text: string }
  const parts: Part[] = []

  if (facts.devPorts.length > 0) {
    const shown = facts.devPorts.slice(0, ENV_SUMMARY_MAX_PORTS).map((p) => {
      const label = clipChars(p.label ?? '', ENV_CLIP_CHARS)
      return label ? `${p.port} ${label}` : String(p.port)
    })
    if (facts.devPorts.length > shown.length) shown.push('…')
    parts.push({ kind: 'ports', text: t('agentTerminal.sessionContext.envPorts', { ports: shown.join(', ') }) })
  }
  if ((facts.sentinelCount ?? 0) > 0) {
    parts.push({ kind: 'sentinels', text: t('agentTerminal.sessionContext.envSentinels', { count: facts.sentinelCount }) })
  }
  const targets = (facts.deployTargets ?? []).map(n => n.trim()).filter(n => n !== '')
  if (targets.length > 0) {
    const shown = targets.slice(0, ENV_SUMMARY_MAX_TARGETS).map(n => clipChars(n, ENV_CLIP_CHARS))
    if (targets.length > shown.length) shown.push('…')
    parts.push({ kind: 'targets', text: t('agentTerminal.sessionContext.envTargets', { targets: shown.join(', ') }) })
  }
  if (parts.length === 0) return ''

  let active = parts
  const render = () => t('agentTerminal.sessionContext.envLine', {
    project,
    parts: active.map(p => p.text).join(sep),
  })
  let line = render()
  if (byteLength(line) > ENV_SUMMARY_MAX_BYTES) {
    active = active.filter(p => p.kind !== 'targets')
    line = render()
  }
  if (byteLength(line) > ENV_SUMMARY_MAX_BYTES) {
    active = active.filter(p => p.kind !== 'sentinels')
    line = render()
  }
  if (byteLength(line) > ENV_SUMMARY_MAX_BYTES) {
    const chars = Array.from(line)
    while (chars.length > 0 && byteLength(`${chars.join('')}…`) > ENV_SUMMARY_MAX_BYTES) chars.pop()
    line = `${chars.join('')}…`
  }
  return line
}
