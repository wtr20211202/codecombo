import { ref } from 'vue'
import type { Ref } from 'vue'
import { RUNTIME_FALLBACK_KEY } from '../utils/sessionRuntimeGroups'
import { parsePinnedIds } from '../utils/terminalTabPins'
import { safeStorage } from '../utils/storage'
import type { SessionGroupMode, SessionSortMode, TerminalSessionInfo } from './terminal-sessions-model'

/**
 * 终端会话的显示偏好域（自 terminal-sessions store 拆出，纯搬运零逻辑改动），
 * 四个 localStorage 持久化的纯前端显示偏好：
 *   - 排序方式（管理页侧栏与悬浮列表共用）
 *   - 会话中心分组视图（P-20261003-238，flat/runtime，纯展示层 toggle）
 *   - 会话 tab 置顶（P-20261004-53，底部终端面板，集合持久化 + 消亡剪枝）
 *   - runtime 筛选选中集（P-20261004-84，侧栏筛选芯片，多选 OR + 绝迹剪枝）
 * 由 store setup 调用一次，返回的 refs 并入 store state（Pinia setup store 惯例）。
 */
export function useTerminalSessionPrefs(sessions: Ref<TerminalSessionInfo[]>) {
  /** 会话排序方式（管理页/悬浮列表共用；localStorage 持久化） */
  const SORT_KEY = 'sc.terminalSessions.sortMode'
  function loadSortMode(): SessionSortMode {
    try {
      const raw = localStorage.getItem(SORT_KEY)
      if (raw === 'name' || raw === 'activity') return raw
    } catch { /* 环境无 localStorage 时走默认 */ }
    return 'default'
  }
  const sortMode = ref<SessionSortMode>(loadSortMode())
  function setSortMode(mode: SessionSortMode) {
    sortMode.value = mode
    safeStorage.setItem(SORT_KEY, mode)
  }

  // ============== 会话中心分组视图（P-20261003-238，管理页侧栏终端页签） ==============
  // flat=既有呈现（项目树+未分组+自定义分组）/ runtime=按运行时分组（组头
  // 标签+计数）。纯展示层 toggle：不碰分组持久化数据（uiState 的自定义分组
  // 结构原样保留，切回 flat 全量还原）；与排序/名称筛选/时间 chips 正交。
  // safeStorage（健壮性红线）：隐私模式/屏蔽 Cookie 下裸 localStorage 抛错
  const GROUP_MODE_KEY = 'sc.terminalSessions.groupMode'
  function loadGroupMode(): SessionGroupMode {
    return safeStorage.getItem(GROUP_MODE_KEY) === 'runtime' ? 'runtime' : 'flat'
  }
  const groupMode = ref<SessionGroupMode>(loadGroupMode())
  function setGroupMode(mode: SessionGroupMode) {
    groupMode.value = mode
    safeStorage.setItem(GROUP_MODE_KEY, mode)
  }

  // ============== 会话 tab 置顶（P-20261004-53，底部终端面板） ==============
  // 纯前端显示偏好（编辑器 pinned tab 向会话侧的对称补位）：置顶 = 会话 id
  // 集合，safeStorage 持久化跨重启。置顶分组是消费方的显示序投影（utils/
  // terminalTabPins.pinnedFirstOrder，不动物理会话序）；会话消亡即摘除防集
  // 合无界（服务端会话是唯一事实源，他端关闭的置顶会话随快照对账同汰）。
  // 整集替换写（Set 换新引用驱动响应式，同 managerAttached 惯例）
  const PINNED_KEY = 'sc.terminalSessions.pinnedIds'
  const pinnedIds = ref(new Set(parsePinnedIds(safeStorage.getItem(PINNED_KEY))))
  function isPinned(id: string): boolean {
    return pinnedIds.value.has(id)
  }
  function persistPinnedIds(): void {
    safeStorage.setItem(PINNED_KEY, JSON.stringify([...pinnedIds.value]))
  }
  function togglePin(id: string): void {
    if (!id) return
    const next = new Set(pinnedIds.value)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    pinnedIds.value = next
    persistPinnedIds()
  }
  /** 剪枝：存活集之外的置顶 id 摘除（含持久化同步；无变化零写盘） */
  function prunePinnedIds(alive: Set<string>): void {
    if (pinnedIds.value.size === 0) return
    const next = [...pinnedIds.value].filter(id => alive.has(id))
    if (next.length === pinnedIds.value.size) return
    pinnedIds.value = new Set(next)
    persistPinnedIds()
  }

  // ============== runtime 筛选选中集（P-20261004-84，侧栏筛选芯片） ==============
  // 纯前端显示偏好：选中的 runtime 键集合，多选 OR 语义（命中任一），空集 =
  // 不过滤。safeStorage 持久化（沿 SORT_KEY 惯例跨重启记忆）。判定与芯片候选
  // 走 utils/sessionRuntimeGroups 纯函数（与分组投影同键空间防漂移）。
  // 剪枝同 pinnedIds 纪律：runtime 键在存活会话中绝迹即摘除——否则芯片随
  // 「无该 runtime 会话不显示」消失后，选中态残留会把列表清空且无处退出
  //（死胡同）。命中键空间有界（注册运行时数 + shell），无无界增长之虞
  const RUNTIME_FILTER_KEY = 'sc.terminalSessions.runtimeFilter'
  function loadRuntimeFilter(): Set<string> {
    try {
      const raw = safeStorage.getItem(RUNTIME_FILTER_KEY)
      const arr: unknown = raw ? JSON.parse(raw) : null
      if (!Array.isArray(arr)) return new Set()
      return new Set(arr.filter((x): x is string => typeof x === 'string'))
    } catch { /* 脏数据/无 storage 走默认不过滤 */ }
    return new Set()
  }
  const runtimeFilter = ref(loadRuntimeFilter())
  function persistRuntimeFilter(): void {
    safeStorage.setItem(RUNTIME_FILTER_KEY, JSON.stringify([...runtimeFilter.value]))
  }
  function toggleRuntimeFilter(key: string): void {
    if (!key) return
    const next = new Set(runtimeFilter.value)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    runtimeFilter.value = next
    persistRuntimeFilter()
  }
  /** 清空（「全部」芯片恢复档；已是空集零写盘） */
  function clearRuntimeFilter(): void {
    if (runtimeFilter.value.size === 0) return
    runtimeFilter.value = new Set()
    persistRuntimeFilter()
  }
  /** 剪枝：存活会话 runtime 键集之外的选中键摘除（removeLocal/applySnapshot
   *  两路对账同汰；无变化零写盘） */
  function pruneRuntimeFilter(aliveKeys: Set<string>): void {
    if (runtimeFilter.value.size === 0) return
    const next = [...runtimeFilter.value].filter(key => aliveKeys.has(key))
    if (next.length === runtimeFilter.value.size) return
    runtimeFilter.value = new Set(next)
    persistRuntimeFilter()
  }
  /** 当前存活会话的 runtime 键集（芯片候选/剪枝共用；空值归 shell 同纯函数口径） */
  function aliveRuntimeKeys(): Set<string> {
    const out = new Set<string>()
    for (const s of sessions.value) out.add(s.runtime || RUNTIME_FALLBACK_KEY)
    return out
  }

  /** 仅供测试使用：复位全部偏好内存态（不写 localStorage，保证用例隔离） */
  function resetPrefsForTest(): void {
    sortMode.value = 'default'
    groupMode.value = 'flat'
    pinnedIds.value = new Set()
    runtimeFilter.value = new Set()
  }

  return {
    sortMode,
    setSortMode,
    groupMode,
    setGroupMode,
    pinnedIds,
    isPinned,
    togglePin,
    prunePinnedIds,
    runtimeFilter,
    toggleRuntimeFilter,
    clearRuntimeFilter,
    pruneRuntimeFilter,
    aliveRuntimeKeys,
    resetPrefsForTest,
  }
}
