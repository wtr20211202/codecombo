import { maskSensitive } from './sensitiveMask'
import { validateAgentTaskTemplate, type AgentTaskTemplate } from './agentTaskTemplate'

/**
 * 智能体任务模板的导出/导入传输层（P-20261005-209）：
 * 纯数据组装与校验，无 IO——文件下载/选择由调用方（设置页管理区块）承担，
 * 便于单测直接覆盖载荷形状、容错与冲突规划语义。
 *
 * 注：本文件源码曾因编排器仲裁合并时漏收未跟踪文件而丢失，后由合并产物
 * bundle 反编译语义逐函数重建（行为以 agentTaskTemplateTransfer.test.ts
 * 断言与组件调用面为契约）。
 */

/** 载荷家族标记/版本（家族字段与 version 同值，双写便于消费方任选其一判别） */
export const SC_AGENT_TEMPLATES_VERSION = 1

/** 导出条目：字段白名单只带 name/prompt——id 等本地字段不外带 */
export interface TemplateExportItem {
  name: string
  prompt: string
}

export interface TemplateExportPayload {
  scAgentTaskTemplates: number
  version: number
  exportedAt: string
  templates: TemplateExportItem[]
}

export interface TemplateImportResult {
  templates: TemplateExportItem[]
  /** 逐条校验不过（空名/超长/空正文/超 500 字节/非对象/文件内同名重复）的计数——不阻塞其余条目 */
  invalid: number
}

export interface TemplateImportEntry {
  item: TemplateExportItem
  /** 与本地模板同名（存储以 id 为主键，重名是既有合法形态；本地重名取首个为覆盖目标） */
  conflict: boolean
  existing?: AgentTaskTemplate
}

export interface TemplateImportPlan {
  creates: TemplateExportItem[]
  updates: { targetId: string; item: TemplateExportItem }[]
  skipped: TemplateExportItem[]
}

/** 组装导出载荷：空列表出空 templates（空态提示由调用方负责） */
export function buildTemplateExportPayload(templates: AgentTaskTemplate[]): TemplateExportPayload {
  return {
    scAgentTaskTemplates: SC_AGENT_TEMPLATES_VERSION,
    version: SC_AGENT_TEMPLATES_VERSION,
    exportedAt: new Date().toISOString(),
    templates: templates.map(t => ({ name: t.name, prompt: t.prompt })),
  }
}

/** 单条规范化：非对象/字段非字符串按缺省处理，过保存预检同口径校验，不过返回 null */
function normalizeImportItem(raw: unknown): TemplateExportItem | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const name = typeof r.name === 'string' ? r.name.trim() : ''
  const prompt = typeof r.prompt === 'string' ? r.prompt.trim() : ''
  return validateAgentTaskTemplate(name, prompt) ? null : { name, prompt }
}

/**
 * 解析导入输入：标记包裹格式（scAgentTaskTemplates 键判别）或裸数组
 * （手写/他工具导出容错）；整体形状不符返回 null（损坏文件由调用方明确报错）。
 * 未知字段剥除、文件内同名重复保留首个（后续计 invalid）。
 */
export function parseTemplateImport(input: unknown): TemplateImportResult | null {
  let list: unknown
  if (Array.isArray(input)) {
    list = input
  } else if (input && typeof input === 'object' && (input as Record<string, unknown>).scAgentTaskTemplates) {
    list = (input as Record<string, unknown>).templates
  } else {
    return null
  }
  if (!Array.isArray(list)) return null
  const seen = new Set<string>()
  const templates: TemplateExportItem[] = []
  let invalid = 0
  for (const raw of list) {
    const item = normalizeImportItem(raw)
    if (!item || seen.has(item.name)) {
      invalid++
      continue
    }
    seen.add(item.name)
    templates.push(item)
  }
  return { templates, invalid }
}

/** 规划导入：与本地同名标 conflict 并挂首个同名本地项（覆盖目标） */
export function planTemplateImport(
  items: TemplateExportItem[],
  local: AgentTaskTemplate[],
): TemplateImportEntry[] {
  const byName = new Map<string, AgentTaskTemplate>()
  for (const t of local) {
    if (!byName.has(t.name)) byName.set(t.name, t)
  }
  return items.map(item => {
    const existing = byName.get(item.name)
    return existing ? { item, conflict: true, existing } : { item, conflict: false }
  })
}

/** 展开执行：非冲突入 creates；冲突按勾选（模板名集合）分流覆盖/跳过（默认不勾） */
export function applyTemplateImport(
  entries: TemplateImportEntry[],
  selected: ReadonlySet<string>,
): TemplateImportPlan {
  const plan: TemplateImportPlan = { creates: [], updates: [], skipped: [] }
  for (const entry of entries) {
    if (!entry.conflict) {
      plan.creates.push(entry.item)
    } else if (selected.has(entry.item.name) && entry.existing) {
      plan.updates.push({ targetId: entry.existing.id, item: entry.item })
    } else {
      plan.skipped.push(entry.item)
    }
  }
  return plan
}

/** 导出前凭据警示：maskSensitive 差分判定（遮蔽后≠原文即含敏感串），返回命中模板名 */
export function sensitiveTemplateNames(templates: AgentTaskTemplate[]): string[] {
  return templates.filter(t => maskSensitive(t.prompt) !== t.prompt).map(t => t.name)
}
