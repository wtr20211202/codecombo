import { computed, reactive, ref } from 'vue'
import type { Ref } from 'vue'
import { buildSessionGroups, summarizeSessions } from '../utils/sessionOverview'
import type { TermTab } from './useTerminalTabs'

/**
 * 会话总览（跨项目并行开发：进度一览 + 快捷切换）的状态与派生数据。
 * 数据全部来自既有状态：tabs（含全部项目的 tab）/ activeTabId / projects，
 * 最近命令在 D 事件时记录（recordLastCommand 供宿主 OSC 链路调用）。
 * 从 TerminalView.vue 抽出（债项拆分）。
 */
export function useSessionOverviewState(options: {
  tabs: Ref<TermTab[]>
  projects: Ref<{ id: string; name: string; [k: string]: unknown }[]>
  currentProjectId: Ref<string>
  activeTabId: Ref<string>
  selectTab: (id: string) => void
  selectProject: (id: string) => boolean | Promise<boolean>
}) {
  const { tabs, projects, currentProjectId, activeTabId, selectTab, selectProject } = options

  // sessionId -> 最近一次命令文本（E 事件解码，供总览条目展示进度上下文）
  const lastCmdBySession = reactive<Record<string, string>>({})
  const showSessionOverview = ref(false)

  function recordLastCommand(sessionId: string, command: string): void {
    lastCmdBySession[sessionId] = command
  }

  const sessionGroups = computed(() => buildSessionGroups({
    tabs: tabs.value,
    projects: projects.value,
    currentProjectId: currentProjectId.value,
    activeTabId: activeTabId.value,
    lastCommands: lastCmdBySession,
  }))
  const sessionSummary = computed(() => summarizeSessions(tabs.value))

  // 跨项目跳转：先切项目（tabs 可见性跟随 currentProjectId），再选中目标 tab；
  // 切换守卫取消（未保存草稿确认选「取消」，P-20261003-105）则放弃选中——
  // 目标 tab 属另一项目，留在原项目时不可见
  async function jumpToSession(tabId: string, projectId: string): Promise<void> {
    if (currentProjectId.value !== projectId && (await selectProject(projectId)) === false) return
    selectTab(tabId)
  }

  /** tab/pane 关闭时清理已消失会话的最近命令记录（防跨会话残留） */
  function pruneLastCommands(alive: Set<string>): void {
    for (const id of Object.keys(lastCmdBySession)) {
      if (!alive.has(id)) delete lastCmdBySession[id]
    }
  }

  return {
    lastCmdBySession,
    showSessionOverview,
    recordLastCommand,
    sessionGroups,
    sessionSummary,
    jumpToSession,
    pruneLastCommands,
  }
}
