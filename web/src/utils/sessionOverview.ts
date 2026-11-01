// sessionOverview —— 跨项目终端会话总览的纯逻辑：状态判定 + 按项目分组。
// 数据源全部来自 TerminalView 既有状态（tabs / activeTabId / onOscEvent 记录的最近命令），
// 不新增后端依赖；分组结果供 SessionOverview 浮层渲染，当前项目置顶。

export interface SessionTabInfo {
  id: string
  name: string
  projectId: string
  running?: boolean
  lastExitCode?: number
  panes?: string[]
}

export interface ProjectBrief {
  id: string
  name: string
}

export type SessionStatus = 'running' | 'failed' | 'ok' | 'new'

export interface SessionEntry {
  tabId: string
  name: string
  status: SessionStatus
  exitCode?: number
  lastCmd: string
  panes: number
  active: boolean
}

export interface SessionGroup {
  projectId: string
  projectName: string
  isCurrent: boolean
  sessions: SessionEntry[]
}

export interface SessionSummary {
  total: number
  running: number
  failed: number
}

/** 单个 tab 的会话状态：运行中 > 失败（非零退出）> 正常（零退出）> 从未执行过命令 */
export function sessionStatus(tab: Pick<SessionTabInfo, 'running' | 'lastExitCode'>): SessionStatus {
  if (tab.running) return 'running'
  if (tab.lastExitCode === undefined) return 'new'
  return tab.lastExitCode === 0 ? 'ok' : 'failed'
}

/** 全部 tab 按项目分组：当前项目置顶（排序稳定，组内保持 tab 顺序） */
export function buildSessionGroups(params: {
  tabs: SessionTabInfo[]
  projects: ProjectBrief[]
  currentProjectId: string
  activeTabId: string
  lastCommands: Record<string, string>
}): SessionGroup[] {
  const nameById = new Map(params.projects.map(p => [p.id, p.name]))
  const groups: SessionGroup[] = []
  const byProject = new Map<string, SessionGroup>()
  for (const tab of params.tabs) {
    let g = byProject.get(tab.projectId)
    if (!g) {
      g = {
        projectId: tab.projectId,
        projectName: nameById.get(tab.projectId) ?? tab.projectId,
        isCurrent: tab.projectId === params.currentProjectId,
        sessions: [],
      }
      byProject.set(tab.projectId, g)
      groups.push(g)
    }
    g.sessions.push({
      tabId: tab.id,
      name: tab.name,
      status: sessionStatus(tab),
      exitCode: tab.lastExitCode,
      lastCmd: (params.lastCommands[tab.id] ?? '').trim(),
      panes: tab.panes?.length ?? 1,
      active: tab.id === params.activeTabId,
    })
  }
  return groups.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent))
}

/** 工具栏徽标汇总：总会话数 + 运行中 / 失败计数 */
export function summarizeSessions(tabs: SessionTabInfo[]): SessionSummary {
  let running = 0
  let failed = 0
  for (const tab of tabs) {
    const st = sessionStatus(tab)
    if (st === 'running') running++
    if (st === 'failed') failed++
  }
  return { total: tabs.length, running, failed }
}
