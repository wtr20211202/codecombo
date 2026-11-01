import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { terminalApi } from '../api/domains/terminal'
import { useTerminalSessionsStore } from '../stores/terminal-sessions'
import { PROJECT_FILE_CHANGED } from './useWebSocket'

/**
 * 文件树的 Agent 改动标记（B3 辅形态）：聚合驻留在项目根目录的智能体
 * 会话的产出文件（startHead..工作区 diff + untracked），供文件树打点提示
 * 「哪些文件是 Agent 动的」。
 *
 * 归属边界（有意收紧）：仅匹配 cwd === 项目根的会话——worktree 会话的
 * diff 路径相对其自身仓库根，映射到主项目树是错误归属；worktree 场景
 * 由产出侧板（会话中心视图）覆盖。
 * 刷新时机：进入项目页 / 会话列表变化（防抖 3s）/ project WS 的
 * file.changed 广播（再叠 2.5s 尾沿节流）——Agent 写文件的当下实时跟上。
 */
export interface AgentMark {
  /** 改动该文件的会话数（多会话共目录时 >1） */
  sessions: number
  runtimes: string[]
}

/** 产出 diffstat 汇总（P-20261003-177）：匹配会话 activity 的增删行数合计，
 *  与 marks 同一次拉取内顺带聚合（零新增请求）。多会话共改同文件会重复计数，
 *  属「改动规模」示意口径而非精确 diffstat——消费方（PR 描述起草 prompt）
 *  只用作规模感知，不做行数承诺 */
export interface AgentMarksStat {
  additions: number
  deletions: number
}

export function useAgentMarks(projectRoot: () => string) {
  const sessionsStore = useTerminalSessionsStore()
  const marks = ref<Map<string, AgentMark>>(new Map())
  const stat = ref<AgentMarksStat>({ additions: 0, deletions: 0 })

  const matchingSessions = computed(() => {
    const root = (projectRoot() || '').replace(/\\/g, '/').replace(/\/+$/, '')
    if (!root) return []
    return sessionsStore.systemSessions.filter(s => (s.path || '').replace(/\\/g, '/').replace(/\/+$/, '') === root)
  })

  let fetchTimer: ReturnType<typeof setTimeout> | null = null
  let fetchSeq = 0

  async function refresh() {
    const list = matchingSessions.value
    if (list.length === 0) {
      marks.value = new Map()
      stat.value = { additions: 0, deletions: 0 }
      return
    }
    const seq = ++fetchSeq
    const results = await Promise.all(
      list.map(async s => {
        try {
          // silent：无元数据 404 是预期分支（catch 即「无产出」），后台轮询
          // 不得惊扰全局错误 toast
          const res: any = await terminalApi.activity(s.id, { silent: true })
          return {
            runtime: s.runtime || '',
            files: (res?.data?.files || []) as { path: string }[],
            additions: Number(res?.data?.additions) || 0,
            deletions: Number(res?.data?.deletions) || 0,
          }
        } catch {
          return { runtime: '', files: [] as { path: string }[], additions: 0, deletions: 0 } // 无产出/非 git 目录
        }
      }),
    )
    if (seq !== fetchSeq) return // 过期响应丢弃
    const next = new Map<string, AgentMark>()
    const statSum: AgentMarksStat = { additions: 0, deletions: 0 }
    for (const r of results) {
      for (const f of r.files) {
        const cur = next.get(f.path) || { sessions: 0, runtimes: [] }
        cur.sessions += 1
        if (r.runtime && !cur.runtimes.includes(r.runtime)) cur.runtimes.push(r.runtime)
        next.set(f.path, cur)
      }
      statSum.additions += r.additions
      statSum.deletions += r.deletions
    }
    marks.value = next
    stat.value = statSum
  }

  function scheduleRefresh() {
    if (fetchTimer) clearTimeout(fetchTimer)
    fetchTimer = setTimeout(() => void refresh(), 3000)
  }

  watch(matchingSessions, scheduleRefresh, { immediate: true, deep: false })
  // 项目根变化时立即重取（切项目场景）
  watch(projectRoot, () => { marks.value = new Map(); stat.value = { additions: 0, deletions: 0 }; scheduleRefresh() })
  // Agent 写文件的当下实时跟上：project WS file.changed（300ms 防抖）再叠
  // 2.5s 尾沿节流——Agent 高频写盘时活动端点不必每次都打
  let fileChangedDebounce: ReturnType<typeof setTimeout> | null = null
  function onProjectFileChanged() {
    if (fileChangedDebounce) clearTimeout(fileChangedDebounce)
    fileChangedDebounce = setTimeout(() => { fileChangedDebounce = null; void refresh() }, 2500)
  }
  window.addEventListener(PROJECT_FILE_CHANGED, onProjectFileChanged)
  onBeforeUnmount(() => {
    window.removeEventListener(PROJECT_FILE_CHANGED, onProjectFileChanged)
    if (fileChangedDebounce) clearTimeout(fileChangedDebounce)
  })

  return { marks, stat, refresh }
}
