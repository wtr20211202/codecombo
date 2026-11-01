import { computed, h, ref, watch } from 'vue'
import { useMessage } from 'naive-ui'
import { useProjectStore } from '../stores/project'
import { useI18n } from '../composables/useI18n'
import { confirmDialog } from '../composables/useDialog'
import { notifyProjectRemoved } from '../composables/useRemoveProjectUndo'
import { useProjectSessionImpact } from '../composables/useProjectSessionImpact'
import { safeStorage } from '../utils/storage'

/**
 * 首页项目清单状态：搜索过滤 / 排序 / 最近打开（localStorage 持久化）/ 分组 /
 * 删除确认流。分组/排序的展示标签由视图层经 i18n 填充。从 HomeView.vue 抽出（债项拆分）。
 */
export function useHomeProjects() {
  const projectStore = useProjectStore()
  const { t } = useI18n()
  const message = useMessage()

  // 搜索 & 排序（排序模式 localStorage 持久化：用户选择的视图偏好跨会话保持）
  const searchQuery = ref('')
  type SortMode = 'recent' | 'name' | 'branch'
  const SORT_KEY = 'home-sort-mode'
  const SORT_VALUES: SortMode[] = ['recent', 'name', 'branch']
  function loadSortMode(): SortMode {
    try {
      const raw = safeStorage.getItem(SORT_KEY)
      return (SORT_VALUES as string[]).includes(raw || '') ? (raw as SortMode) : 'recent'
    } catch { return 'recent' }
  }
  const sortMode = ref<SortMode>(loadSortMode())
  watch(sortMode, (v) => {
    try { safeStorage.setItem(SORT_KEY, v) } catch { /* 隐私模式等场景静默 */ }
  })

  // 最近打开记录（localStorage 持久化）
  const recentProjectIds = ref<string[]>(loadRecent())

  function loadRecent(): string[] {
    try {
      const raw = safeStorage.getItem('home-recent-projects')
      return raw ? JSON.parse(raw) as string[] : []
    } catch { return [] }
  }
  function saveRecent() {
    safeStorage.setItem('home-recent-projects', JSON.stringify(recentProjectIds.value))
  }

  // 排序 & 过滤后的项目
  const filteredProjects = computed(() => {
    const q = searchQuery.value.trim().toLowerCase()
    let list = projectStore.projects.slice()
    if (q) {
      list = list.filter(p =>
        p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q) ||
        (p.currentBranch || '').toLowerCase().includes(q),
      )
    }
    if (sortMode.value === 'name') {
      list.sort((a, b) => a.name.localeCompare(b.name))
    } else if (sortMode.value === 'branch') {
      list.sort((a, b) => (a.currentBranch || '').localeCompare(b.currentBranch || ''))
    } else {
      list.sort((a, b) => {
        const ai = recentProjectIds.value.indexOf(a.id)
        const bi = recentProjectIds.value.indexOf(b.id)
        if (ai === -1 && bi === -1) return a.name.localeCompare(b.name)
        if (ai === -1) return 1
        if (bi === -1) return -1
        return ai - bi
      })
    }
    return list
  })

  // 分组：最近打开 vs 其他 vs 已冻结（标签由视图经 i18n 填充）。
  // 已冻结组恒为尾部分区（P-20261003-9）：任何排序模式下都沉底，弱化呈现；
  // 搜索穿透冻结区——命中项留在冻结组内照常显示（视图在搜索时自动展开）
  interface ProjectGroup { label: string; items: typeof projectStore.projects }
  const groupedProjects = computed<{
    hasRecent: boolean
    recent: ProjectGroup
    others: ProjectGroup
    frozen: ProjectGroup
  }>(() => {
    const list = filteredProjects.value
    const frozenItems = list.filter(p => p.frozen === true)
    const active = list.filter(p => p.frozen !== true)
    const empty: ProjectGroup = { label: '', items: [] }
    if (sortMode.value !== 'recent') {
      return {
        hasRecent: false,
        recent: empty,
        others: { label: '', items: active },
        frozen: { label: '', items: frozenItems },
      }
    }
    const recentSet = new Set(recentProjectIds.value)
    const recentItems = active.filter(p => recentSet.has(p.id))
    const otherItems = active.filter(p => !recentSet.has(p.id))
    return {
      hasRecent: recentItems.length > 0,
      recent: { label: '', items: recentItems },
      others: { label: '', items: otherItems },
      frozen: { label: '', items: frozenItems },
    }
  })

  /** 记录最近打开（进入项目时调用，保留 8 条） */
  function rememberOpened(projectId: string): void {
    const idx = recentProjectIds.value.indexOf(projectId)
    if (idx !== -1) recentProjectIds.value.splice(idx, 1)
    recentProjectIds.value.unshift(projectId)
    if (recentProjectIds.value.length > 8) recentProjectIds.value.length = 8
    saveRecent()
  }

  // ============== 删除项目确认流 ==============
  const showRemoveConfirm = ref(false)
  const removeProjectId = ref('')
  const removeProjectName = ref('')
  const removeProjectPath = ref('')

  // 级联会话知会（P-20261003-145）：确认框追加「将终止 N 个会话（M 个运行中）」
  const { total: removeSessionTotal, running: removeSessionRunning, residentTotal: removeResidentAgents, refreshSnapshot } =
    useProjectSessionImpact(computed(() => showRemoveConfirm.value ? removeProjectId.value : undefined))

  // 驻留智能体会话级联处置选项（P-20261006-36）：默认不勾——保守保留（agent
  // 可能正写盘别处/长任务收尾），用户显式勾选才随删除一并关闭
  const closeResidentAgents = ref(false)

  function openRemoveConfirm(id: string, name: string, path: string, event?: Event): void {
    event?.stopPropagation()
    removeProjectId.value = id
    removeProjectName.value = name
    removeProjectPath.value = path
    closeResidentAgents.value = false // 每次打开复位默认档（保留）
    // 打开瞬间拉一次服务端会话快照（首页宿主可能从未挂终端面，store 或为空）
    refreshSnapshot()
    showRemoveConfirm.value = true
  }

  /** 确认删除（onRemoved：删除后宿主联动刷新，如 ahead/behind）。
   * 成功 toast 升级为撤销通知（P-20261002-47）：原 success + removeNote 双弹
   * 合并为一条「已移除 {name}」+ [撤销]（目录未删的说明已并入撤销文案） */
  async function confirmRemoveProject(onRemoved?: () => void): Promise<void> {
    if (!removeProjectId.value) return
    const closeAgents = closeResidentAgents.value
    try {
      await projectStore.removeProject(removeProjectId.value, closeAgents)
      notifyProjectRemoved(message, { name: removeProjectName.value, path: removeProjectPath.value })
      showRemoveConfirm.value = false
      removeProjectId.value = ''
      removeProjectName.value = ''
      removeProjectPath.value = ''
      closeResidentAgents.value = false
      onRemoved?.()
    } catch { /* 拦截器处理 */ }
  }

  // ============== 重新定位项目（路径失效恢复，保 ID 连续） ==============
  const showRelocateModal = ref(false)
  const relocateProjectId = ref('')
  const relocateProjectName = ref('')
  const relocateNewPath = ref('')
  const relocating = ref(false)

  /** 打开重定位弹窗（入口：失效卡按钮 / 卡片右键菜单；预填当前路径便于改写） */
  function openRelocateModal(id: string, name: string, currentPath: string, event?: Event): void {
    event?.stopPropagation()
    relocateProjectId.value = id
    relocateProjectName.value = name
    relocateNewPath.value = currentPath
    showRelocateModal.value = true
  }

  /** 确认重定位（onRelocated：成功后宿主联动刷新，如 ahead/behind）。
   * 返回值对接 n-modal dialog 的 onPositiveClick 契约：false = 保持弹窗开启可改 */
  async function confirmRelocateProject(onRelocated?: () => void): Promise<boolean> {
    if (!relocateProjectId.value || relocating.value) return false
    const target = relocateNewPath.value.trim()
    if (!target) {
      message.warning(t('home.warningPath'))
      return false
    }
    relocating.value = true
    try {
      await projectStore.relocateProject(relocateProjectId.value, target)
      message.success(t('home.successRelocate'))
      relocateProjectId.value = ''
      relocateProjectName.value = ''
      onRelocated?.()
      return true
    } catch {
      // 拦截器已提示（路径不存在 400 / 重复登记 409）——保持弹窗开启供修改
      return false
    } finally {
      relocating.value = false
    }
  }

  // ============== 冻结/解冻（P-20261003-9） ==============
  // 折入尾部分区/恢复原分组：布尔开关立即生效（可逆，无需确认弹窗）。
  // onChanged：宿主联动刷新（冻结状态影响 ahead/behind 批量探测范围）
  async function setProjectFrozen(id: string, name: string, frozen: boolean, onChanged?: () => void): Promise<void> {
    try {
      await projectStore.setProjectFrozen(id, frozen)
      message.success(t(frozen ? 'project.frozen.successFrozen' : 'project.frozen.successUnfrozen', { name }))
      onChanged?.()
    } catch {
      // 拦截器已提示（404/网络等）——本地列表不动
    }
  }

  // ============== 硬锁锁定/解锁（P-20261004-3） ==============
  // locked = 归档不可变档：锁定前 confirm 影响面清单（写族/终端全 403）；
  // 解锁做二次确认（重新打开写面是安全敏感动作，防误触）。onChanged 同冻结
  async function setProjectLocked(id: string, name: string, locked: boolean, onChanged?: () => void): Promise<void> {
    if (locked) {
      const ok = await confirmDialog({
        type: 'warning',
        title: t('project.locked.confirmTitle'),
        content: () =>
          h('div', { style: 'display:flex;flex-direction:column;gap:6px;' }, [
            h('span', { style: 'color:var(--text-secondary);' }, t('project.locked.confirmLead', { name })),
            ...(['files', 'git', 'terminal', 'reads'] as const).map(k =>
              h('div', { style: 'display:flex;gap:6px;align-items:baseline;' }, [
                h('span', { style: 'color:var(--accent-orange);flex-shrink:0;' }, '•'),
                h('span', null, t(`project.locked.impact.${k}`)),
              ]),
            ),
          ]),
        confirmText: t('project.locked.confirmLockBtn'),
      })
      if (!ok) return
    } else {
      // 解锁二次确认：第一道说明后果，第二道最终确认
      const first = await confirmDialog({
        type: 'warning',
        title: t('project.locked.unlockTitle1'),
        content: t('project.locked.unlockConfirm1', { name }),
      })
      if (!first) return
      const second = await confirmDialog({
        type: 'warning',
        title: t('project.locked.unlockTitle2'),
        content: t('project.locked.unlockConfirm2'),
        confirmText: t('project.locked.unlockBtn'),
      })
      if (!second) return
    }
    try {
      await projectStore.setProjectLocked(id, locked)
      message.success(t(locked ? 'project.locked.successLocked' : 'project.locked.successUnlocked', { name }))
      onChanged?.()
    } catch {
      // 拦截器已提示（404/网络等）——本地列表不动
    }
  }

  return {
    searchQuery,
    sortMode,
    filteredProjects,
    groupedProjects,
    rememberOpened,
    showRemoveConfirm,
    removeProjectId,
    removeProjectName,
    removeProjectPath,
    removeSessionTotal,
    removeSessionRunning,
    removeResidentAgents,
    closeResidentAgents,
    openRemoveConfirm,
    confirmRemoveProject,
    showRelocateModal,
    relocateProjectId,
    relocateProjectName,
    relocateNewPath,
    relocating,
    openRelocateModal,
    confirmRelocateProject,
    setProjectFrozen,
    setProjectLocked,
  }
}
