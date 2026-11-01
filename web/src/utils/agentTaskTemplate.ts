// 智能体任务模板域纯函数（P-20261002-16）：占位符替换与保存校验。
// 模板 prompt 是纯文本（选中后经 launchArgs 注入运行时，无服务端执行语义），
// 占位符语法与运行书 P-123 同源——解析/插值直接复用 utils/textTemplate，
// 本文件只做任务模板域的语义包装（上下文占位符集合 / 未解析提示 / 校验码），
// 不另起解析实现，语义不会与片段/运行书漂移。

import { extractTemplateParams, interpolateTemplate } from './textTemplate'
import { byteLength, LAUNCH_ARGS_MAX_BYTES } from './promptFit'

/** 任务模板（P-20261002-16）：名称 + prompt 正文，存储与物化语义见
 *  composables/useAgentTaskTemplates（uiState 命名空间 + 出厂预置虚置） */
export interface AgentTaskTemplate {
  id: string
  name: string
  prompt: string
}

/** 任务模板支持的上下文占位符：{file}=当前激活文件（项目相对路径）、
 *  {branch}=当前分支、{dir}=会话工作目录（目录字段留空 = 项目根）、
 *  {selection}=编辑器选中代码（P-20261005-149，对话框打开时刻快照，截断见
 *  truncateSelectionForTemplate）。插值走 textTemplate：上下文缺失的占位符
 *  原样保留（不静默清空） */
export const AGENT_TASK_PLACEHOLDERS = ['file', 'branch', 'dir', 'selection'] as const

export interface AgentTaskTemplateContext {
  file?: string
  branch?: string
  dir?: string
  /** 编辑器选中文本快照（无选区 = 空串 → 占位符走「未解析原样保留+提示」） */
  selection?: string
}

export interface ResolvedAgentTaskTemplate {
  /** 插值后的 prompt（即提交给 launchArgs 的文本） */
  text: string
  /** 上下文缺失导致原样保留的已知占位符名（如 ['file']）；用于 UI 提示 */
  unresolved: string[]
}

/** 占位符替换：已解析的替换进文本；上下文缺失（空/空白）的已知占位符原样保留并
 *  进 unresolved（提案语义「未定义时原样保留并提示」）。模板里的未知占位符名
 *  （如运行书式 {src}）不是任务模板契约——原样保留但不告警（用户可能就是要这
 *  段字面文本） */
export function resolveAgentTaskTemplate(prompt: string, ctx: AgentTaskTemplateContext): ResolvedAgentTaskTemplate {
  const text = interpolateTemplate(prompt, {
    file: ctx.file || '',
    branch: ctx.branch || '',
    dir: ctx.dir || '',
    selection: ctx.selection || '',
  })
  const unresolved = extractTemplateParams(text).filter(n =>
    (AGENT_TASK_PLACEHOLDERS as readonly string[]).includes(n))
  return { text, unresolved }
}

// ============== {selection} 选区截断（P-20261005-149） ==============

/** {selection} 选区截断上限（rune=Unicode 码点）：500 字节指令预算下选区只占
 *  一份——ASCII 选区 200 rune 恒在预算内；CJK 选区最坏 600 字节超限时由既有
 *  字节计数器/超限警示兜底（不静默截用户可见文本的既有纪律不动，注记如实
 *  表明「这是截断产物」） */
export const AGENT_TASK_SELECTION_MAX_RUNES = 200

/** 选区截断：超限保头 200 rune + 截断注记尾缀，未超限原样返回不加注记。
 *  按码点计数（增补平面字符/emoji 不劈半）；note 由调用方传 i18n 文案，
 *  本函数保持纯函数无 i18n 依赖 */
export function truncateSelectionForTemplate(text: string, truncatedNote: string): string {
  if (!text) return ''
  let runes = 0
  for (let i = 0; i < text.length; i++) {
    if (text.codePointAt(i)! > 0xffff) i++ // 代理对：低半区一并消费
    if (++runes === AGENT_TASK_SELECTION_MAX_RUNES) {
      return i + 1 >= text.length ? text : text.slice(0, i + 1) + truncatedNote
    }
  }
  return text
}

// ============== 模板命令搜索关键词（P-20261005-10 命令面板直达组） ==============

/** 模板命令的 keywords（正文可搜）：取模板正文前若干词——空白分词（英文按
 *  词、中文长段无词界由字符窗口兜底），词数与累计字符双上限。为什么封顶：
 *  keywords 进命令面板模糊打分（fuzzy 子序列），无界长正文会稀释权重且易
 *  误命中，取头部窗口即可满足「输模板内容片段能搜到」的意图 */
export function templatePromptKeywords(prompt: string, maxWords = 8, maxChars = 48): string {
  const words: string[] = []
  let chars = 0
  for (const w of prompt.trim().split(/\s+/)) {
    if (!w) continue
    if (words.length >= maxWords || chars >= maxChars) break
    words.push(w)
    chars += w.length
  }
  return words.join(' ')
}

// ============== 保存校验（与 AgentCronSettings/customAgents 同口径的前端预检） ==============

/** 名称上限（字符）：与 customAgents displayName 同量级 */
export const AGENT_TASK_NAME_MAX = 60
/** prompt 字节上限：launchArgs 通道同口径（服务端 terminal.go 500 字节 400 兜底；
 *  占位符替换后会变长，保存时校验的是模板原文，替换超限由使用面计数提示） */
export const AGENT_TASK_PROMPT_MAX_BYTES = LAUNCH_ARGS_MAX_BYTES

/** 校验码 → 使用面映射 i18n；空串 = 通过 */
export function validateAgentTaskTemplate(name: string, prompt: string): string {
  if (!name.trim()) return 'nameRequired'
  if (name.trim().length > AGENT_TASK_NAME_MAX) return 'nameTooLong'
  if (!prompt.trim()) return 'promptRequired'
  if (byteLength(prompt.trim()) > AGENT_TASK_PROMPT_MAX_BYTES) return 'promptTooLong'
  return ''
}

/** 出厂预置模板 id（虚置预置的稳定标识；用户改动任一处即整体物化落盘，
 *  见 composables/useAgentTaskTemplates） */
export const FACTORY_TEMPLATE_IDS = ['tpl-review', 'tpl-tests', 'tpl-commit-msg', 'tpl-explain'] as const
