// 自定义智能体配置传播件纯函数族（P-20261004-83）：导出载荷构造 + 导入清洗 +
// 冲突计划。配置是纯 JSON（launch 命令可引用环境变量名，不含凭据值），导出/
// 导入是零敏感传播件——多实例/团队场景把调好的 runtime 从逐台手配变一键搬运。
// schema 版本号沿 WORKSPACE_SNAPSHOT_VERSION 惯例（stores/uiState.ts）：导入端
// 只按已知字段防御式应用，未知字段忽略不崩；版本号只写入不做硬门禁（更高的
// 版本可能携带未知字段，剥除后仍可安全取已知三字段）。

import type { CustomAgent } from '../api/domains/system'

/** 导出文件 schema 版本：字段集变化时递增（当前仅 name/displayName/command 三字段） */
export const SC_CUSTOM_AGENTS_VERSION = 1

/** 导出文件包裹格式：scCustomAgents 标记与 scUiState 同款家族（导入端凭标记识别） */
export interface CustomAgentExportPayload {
  scCustomAgents: number
  version: number
  exportedAt: string
  agents: CustomAgent[]
}

/** 构造导出载荷：字段白名单深拷贝（来源对象上的未知/私有字段不外带） */
export function buildAgentExportPayload(agents: CustomAgent[]): CustomAgentExportPayload {
  return {
    scCustomAgents: SC_CUSTOM_AGENTS_VERSION,
    version: SC_CUSTOM_AGENTS_VERSION,
    exportedAt: new Date().toISOString(),
    agents: agents.map(a => ({
      name: a.name,
      displayName: a.displayName,
      command: a.command,
    })),
  }
}

/** 与后端 customAgentNameRe 同口径的前端预检（服务端仍是事实源） */
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export interface SanitizeAgentImportResult {
  /** 清洗后的合法条目（同名重复保留首个，后续计为非法丢弃） */
  agents: CustomAgent[]
  /** 被丢弃的非法/重复条目数（空 name、坏命令等） */
  invalid: number
}

/**
 * 导入文件清洗：只认 scCustomAgents 标记包裹格式或裸数组两种来源（手写/他工具
 * 导出的容错）；整体形状不符返回 null（调用方给「格式无效」提示）。
 * 逐条防御式校验（与服务端 validateCustomAgent 同口径）：name 形态、command
 * 非空 ≤200、displayName ≤60；未知字段剥除，不阻塞其余条目
 */
export function sanitizeAgentImport(raw: unknown): SanitizeAgentImportResult | null {
  let list: unknown
  if (Array.isArray(raw)) {
    list = raw
  } else if (raw && typeof raw === 'object' && (raw as { scCustomAgents?: unknown }).scCustomAgents) {
    list = (raw as { agents?: unknown }).agents
  } else {
    return null
  }
  if (!Array.isArray(list)) return null

  const seen = new Set<string>()
  const agents: CustomAgent[] = []
  let invalid = 0
  for (const item of list) {
    const agent = sanitizeOne(item)
    if (!agent || seen.has(agent.name)) {
      invalid++
      continue
    }
    seen.add(agent.name)
    agents.push(agent)
  }
  return { agents, invalid }
}

/** 单条清洗：合法返回三字段条目，非法返回 null */
function sanitizeOne(item: unknown): CustomAgent | null {
  if (!item || typeof item !== 'object') return null
  const o = item as Record<string, unknown>
  const name = typeof o.name === 'string' ? o.name.trim() : ''
  const command = typeof o.command === 'string' ? o.command.trim() : ''
  const displayName = typeof o.displayName === 'string' ? o.displayName.trim() : ''
  if (!NAME_RE.test(name)) return null
  if (!command || command.length > 200) return null
  if (displayName.length > 60) return null
  // displayName 空串归一为缺省（空 = 展示层回落 name，与服务端落库口径一致）
  return { name, displayName: displayName || undefined, command }
}

/** 同名合并策略：skip = 已存在项跳过（保守默认）；overwrite = 整条覆盖 */
export type AgentImportStrategy = 'skip' | 'overwrite'

/** 导入预览条目：conflict = 与本地已注册自定义运行时同名（策略作用对象） */
export interface AgentImportEntry {
  agent: CustomAgent
  conflict: boolean
  /** 冲突时的本地现值（预览对照展示；非冲突为 undefined） */
  existing?: CustomAgent
}

/** 冲突计划：逐条标注与本地集的同名冲突（O(n) Map，导入清单量级为个位数） */
export function planAgentImport(incoming: CustomAgent[], existing: CustomAgent[]): AgentImportEntry[] {
  const local = new Map(existing.map(a => [a.name, a]))
  return incoming.map(agent => {
    const hit = local.get(agent.name)
    return hit ? { agent, conflict: true, existing: hit } : { agent, conflict: false }
  })
}

/** 计划执行展开：按策略把条目分流为 create/update/skip 三桶（逐条走既有
 *  CRUD API，改名条目不存在——name 即主键，冲突条目原地覆盖） */
export interface AgentImportPlan {
  creates: CustomAgent[]
  /** 覆盖目标：name 为 PUT 路径参数（= agent.name，同键整条替换） */
  updates: CustomAgent[]
  /** 策略跳过的同名条目 */
  skipped: CustomAgent[]
}

export function applyAgentImportPlan(entries: AgentImportEntry[], strategy: AgentImportStrategy): AgentImportPlan {
  const plan: AgentImportPlan = { creates: [], updates: [], skipped: [] }
  for (const e of entries) {
    if (e.conflict) {
      if (strategy === 'skip') plan.skipped.push(e.agent)
      else plan.updates.push(e.agent)
    } else {
      plan.creates.push(e.agent)
    }
  }
  return plan
}
