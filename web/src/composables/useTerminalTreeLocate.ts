import { computed, getCurrentInstance, onMounted, type Ref } from 'vue'
import { useProjectStore } from '../stores/project'
import { sessionWorkingDir, useTerminalSessionsStore } from '../stores/terminal-sessions'
import { toProjectRelative } from './useTerminalFileLinks'
import { OPS_LOCATE_IN_TREE, type LocateInTreeDetail } from '../utils/opsEvents'

/**
 * 终端面板「在文件树中定位」（P-20261001-32）：把终端 tab 解析为会话 dir 的
 * 项目相对路径，供 tab tooltip 展示与工具条「在文件树中定位」按钮使用。
 *
 * - 会话 dir = OSC 7 实时追踪的 currentDir（P-20261004-59；无帧回落创建 dir，
 *   sessionWorkingDir 统一收口——旧 shell 仍定位到创建目录，零回归），数据
 *   已在 GET /terminals 响应/写路径解析中，零新增 API
 * - dir 不在当前项目内（自定义 dir 的 agent 会话 / 跨项目目录）时无解析值——
 *   tooltip 不展示、按钮置灰并提示，不派发事件
 * - 点击只派发 window 事件 OPS_LOCATE_IN_TREE（P-1 链接层 OPS_OPEN_FILE_AT
 *   同款模式），由 FileTreeView 监听完成「开面板 + 逐层展开 + 滚动定位」；
 *   派发方不感知文件面板布局
 *
 * 会话管理页复用（P-20261002-125）：tabs 允许 projectId 为空串——免项目绑定的
 * agent 会话（管理页全量清单）不带项目归属，能否定位交 toProjectRelative 的
 * 目录容器检查把门；显式归属他项目的 tab（项目终端页跨项目 tab / 管理页里的
 * 他项目会话）仍排除。locateTab 供会话行逐行定位（不限活动 tab）
 */
export function useTerminalTreeLocate(options: {
  tabs: Ref<{ id: string; projectId: string }[]>
  activeTabId: Ref<string>
}) {
  const projectStore = useProjectStore()
  const sessionsStore = useTerminalSessionsStore()

  // 会话快照未拉取（页面刷新后首次进面板）时自愈拉取一次：store 无应用启动级
  // 填充，直接读会落空（文件链接层 hover 同款兜底）；loaded 翻转后 computed 自然重算。
  // getCurrentInstance 守卫：本 composable 允许在单测中脱离组件实例调用
  if (getCurrentInstance()) {
    onMounted(() => {
      if (!sessionsStore.loaded) void sessionsStore.refresh()
    })
  }

  /** 当前项目各 tab 的会话 dir（tabId → 项目相对路径，正斜杠；'' = 项目根本身）。
   *  会话未知（快照未及）或 dir 在当前项目外时无条目 */
  const dirByTabId = computed<Record<string, string>>(() => {
    const pid = projectStore.currentProjectId
    const root = projectStore.currentProject?.path
    if (!pid || !root || projectStore.currentProject?.valid === false) return {}
    const out: Record<string, string> = {}
    for (const tab of options.tabs.value) {
      // 空 projectId = 免项目绑定的 agent 会话（管理页清单）：容器检查把门；
      // 显式归属他项目的 tab 不落当前项目树
      if (tab.projectId && tab.projectId !== pid) continue
      const session = sessionsStore.sessions.find(s => s.id === tab.id)
      if (!session?.path) continue
      const rel = toProjectRelative(sessionWorkingDir(session), root)
      if (rel === null) continue // dir 在项目外：按钮置灰语义
      out[tab.id] = rel
    }
    return out
  })

  /** 活动 tab 的会话 dir（undefined = 未知/项目外：按钮置灰） */
  const activeDir = computed(() => dirByTabId.value[options.activeTabId.value])

  /** 派发「在文件树中定位」：携带指定会话 dir 的项目相对路径与项目 id；
   *  dir 未解析（会话未知/项目外/项目无效）时 no-op（管理页会话行逐行复用） */
  function locateTab(tabId: string): void {
    const dir = dirByTabId.value[tabId]
    const pid = projectStore.currentProjectId
    if (dir === undefined || !pid) return
    window.dispatchEvent(new CustomEvent<LocateInTreeDetail>(OPS_LOCATE_IN_TREE, {
      detail: { path: dir, projectId: pid },
    }))
  }

  /** 派发活动 tab 的「在文件树中定位」 */
  function locateActive(): void {
    locateTab(options.activeTabId.value)
  }

  return { dirByTabId, activeDir, locateActive, locateTab }
}
