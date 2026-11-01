import { computed, getCurrentInstance, onMounted } from 'vue'
import { useProjectStore } from '../stores/project'
import { sessionWorkingDir, useTerminalSessionsStore } from '../stores/terminal-sessions'
import { toProjectRelative } from './useTerminalFileLinks'
import { useI18n } from './useI18n'

/**
 * 文件树目录会话驻留徽标（P-20261004-41）：dir-agent（P-55）的反向可见性——
 * 「agent 都在哪些目录工作」常驻地图。按会话实时 cwd（P-20261004-59 OSC 7
 * 追踪 currentDir，无帧回落创建 dir——sessionWorkingDir 统一收口）把驻留的
 * 智能体会话归属到项目相对目录，FileTreeView 目录行据此渲染徽标/tooltip。
 *
 * 归属口径：
 * - 仅 kind=agent 会话（worktree 驻留徽标 GitWorktreesSection 同口径）——项目
 *   shell 会话归属项目整体，不进目录分布面
 * - 精确等于该目录（非前缀）——文件树每个目录都是独立节点，前缀语义会让根
 *   目录常亮且与子目录徽标信息重复；「agent 在哪个目录」要的就是精确落点
 * - 会话 cwd 在项目外 / 项目根（rel=''，文件树无根节点行可挂）不产出条目
 *
 * 实时性：computed 依赖 store sessions/runningMap/currentDir——创建/关闭经
 * terminals.changed 快照广播对账，cd 迁移经 reportCurrentDir 毫秒级跟随，
 * 本模块零轮询零订阅。
 */
export interface DirSessionEntry {
  id: string
  name: string
  /** OSC 133 运行态（未连接的会话不谎报——runningMap 缺 key = 空闲/未知） */
  running: boolean
}

export function useDirSessionBadges() {
  const projectStore = useProjectStore()
  const sessionsStore = useTerminalSessionsStore()
  const { t } = useI18n()

  /** 项目相对目录 → 驻留其下的智能体会话条目 */
  const dirSessions = computed<Map<string, DirSessionEntry[]>>(() => {
    const root = projectStore.currentProject?.path || ''
    if (!root || projectStore.currentProject?.valid === false) return new Map()
    const map = new Map<string, DirSessionEntry[]>()
    for (const s of sessionsStore.systemSessions) {
      const rel = toProjectRelative(sessionWorkingDir(s), root)
      if (!rel) continue // 项目外（null）/ 项目根本身（''）
      const entry: DirSessionEntry = {
        id: s.id,
        name: s.name,
        running: sessionsStore.runningMap[s.id] === true,
      }
      const list = map.get(rel)
      if (list) list.push(entry)
      else map.set(rel, [entry])
    }
    return map
  })

  // 快照未拉取时自愈拉取一次（useTerminalTreeLocate 同款兜底）：store 无应用
  // 启动级填充，刷新后直接进文件树徽标会落空；loaded 翻转后 computed 自然重算。
  // getCurrentInstance 守卫：本 composable 允许在单测中脱离组件实例调用
  if (getCurrentInstance()) {
    onMounted(() => {
      if (!sessionsStore.loaded) void sessionsStore.refresh()
    })
  }

  /** 目录驻留会话条目（无驻留返回空数组） */
  function sessionsAt(dirPath: string): DirSessionEntry[] {
    return dirSessions.value.get(dirPath) ?? []
  }

  function statusLine(e: DirSessionEntry): string {
    return t('fileTree.dirSessions.entry', {
      name: e.name,
      status: t(e.running ? 'fileTree.dirSessions.running' : 'fileTree.dirSessions.idle'),
    })
  }

  /** 徽标 tooltip（native title，行式清单）：每会话一行「名称 · 状态」，运行中
   *  加 ● 前缀点亮（原生 title 无样式面，符号前缀是能落地的最弱「点亮」） */
  function tipFor(dirPath: string): string {
    const list = sessionsAt(dirPath)
    if (list.length === 0) return ''
    return list.map(e => (e.running ? '● ' : '') + statusLine(e)).join('\n')
  }

  return { dirSessions, sessionsAt, statusLine, tipFor }
}
