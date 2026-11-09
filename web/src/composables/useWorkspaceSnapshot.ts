import { ref, watch } from 'vue'
import { useMessage } from 'naive-ui'
import { useProjectStore } from '../stores/project'
import {
  useUIStateStore,
  sanitizeSnapshotGroups,
  WORKSPACE_SNAPSHOT_VERSION,
  type WorkspaceSnapshot,
  type SnapshotAgentGroup,
} from '../stores/uiState'
import { usePanelLayout, type SideView, type BottomTab } from './usePanelLayout'
import { confirmDialog, promptDialog } from './useDialog'
import { useI18n } from './useI18n'
import { OPS_AGENT_GROUPS_CHANGED } from '../utils/opsEvents'

/**
 * 工作现场存档点（P-20261002-84）：「大改前存个档」——把当前现场（主组标签
 * 清单/活跃文件/面板开合与宽度/树展开/分支名）存成命名快照，改坏或切走后
 * 一键恢复。命令面板「保存当前现场」「恢复现场」两个入口共用本组合式。
 *
 * - 存档 = uiState 的项目级快照副本（snapshots 命名空间，projectId 键控，
 *   pinnedDirs 同款项目级映射先例）；同名覆盖（存档点是「槽位」心智），
 *   每项目上限 SNAPSHOTS_MAX 条 FIFO。
 * - 恢复 = 应用快照：面板态就地应用（P-74 重置同款 usePanelLayout 单例直写），
 *   文件重开走 openFileByPath 既有已删降级，分支不同仅提示不强切。
 * - 分屏组文件列表不存不放——快照是策展预设位，与 uiState 自动持久化的分屏组
 *   清单（P-20261002-94 editor.splitFiles）语义分工，快照只含主组清单；
 *   P-20261003-68 起补记分屏「开合」——与 uiState.editor.splitOpen 同维度。
 *
 * 工作区预设扩展（P-20261003-68）：在存档点机制上补齐预设语义的净增量——
 * ① 快照带 schema 版本号（WORKSPACE_SNAPSHOT_VERSION，未知字段忽略不崩）；
 * ② 采集/恢复分屏开合；③ 采集/恢复 agent 会话组「结构」（仅结构不拉起会话，
 *   生命周期另管；P-20261004-79 起落盘成功即广播，live 挂载中的管理页即时
 *   重应用）；④ 恢复前当前现场自动存「恢复前」档（同名覆盖
 *   单滚动槽位，防丢兜底）；⑤ 列表行内改名（可删改的「改」）。
 *
 * 编辑器/文件树的应用器是 useLayoutShell 作用域状态（useOpenFiles 非单例、
 * 侧栏树 ref 在宿主），以 deps 闭包注入——与 useLayoutViews 的装配注入同范式；
 * 本组合式由 shell 实例化一次，恢复列表弹层（WorkspaceSnapshotModal）为纯
 * 展示组件，经 Layout 宿主消费 shell 返回的状态与方法。
 */

/** shell 作用域依赖（useLayoutShell 装配时注入） */
export interface WorkspaceSnapshotDeps {
  /** 主组标签路径清单（采集源；diff 伪键/未命名草稿由采集端排除） */
  openFilePaths: () => string[]
  /** 主组活跃标签路径（无活跃/活跃为 diff·草稿 = ''） */
  activeFilePath: () => string
  /** 分屏开合（P-20261003-68 采集源，useOpenFiles 双组模型） */
  splitOpen: () => boolean
  /** 全组（含分屏）未保存标签数（恢复前一次性确认用） */
  unsavedCount: () => number
  /** 编辑器现场应用：主组整表换签 + 活跃落位（文件重开走 openFileByPath 已删降级） */
  applyEditor: (openFiles: string[], activeFile: string) => Promise<void>
  /** 文件树展开应用：写持久化键 + 挂载中树就地重放 */
  applyTreeExpansion: (dirs: string[]) => Promise<void>
  /** 分屏开合应用（P-20261003-68）：开/关两链由宿主合成（开=直写 ref 空组渲染，
   *  关=closeSplit 既有并回链路） */
  applySplitOpen: (open: boolean) => void
}

/** 每项目存档上限（新→旧 FIFO 淘汰）：存档表随 uiState 全量落盘，无上限会
 *  无限膨胀（关闭栈 10 条/命令面板 usage 50 键 LRU 同款封顶先例） */
const SNAPSHOTS_MAX = 10

/** 恢复应用的合法枚举（与 bootstrap 恢复的白名单归一口径一致）。'notes' 随
 *  P-20261108-2 退役（笔记迁出侧栏成独立视图）：旧快照残值按枚举外脏值跳过 */
const SIDE_VIEWS: readonly string[] = ['files', 'changes', 'todos']
const BOTTOM_TABS: readonly string[] = ['git', 'terminal', 'console', 'preview']

export function useWorkspaceSnapshot(deps: WorkspaceSnapshotDeps) {
  const projectStore = useProjectStore()
  const uiStateStore = useUIStateStore()
  const layout = usePanelLayout()
  const { t } = useI18n()
  const message = useMessage()

  /** 恢复列表弹层显隐（Layout 宿主挂载 WorkspaceSnapshotModal） */
  const showManager = ref(false)
  /** 当前项目的存档列表（新→旧），弹层打开时刷新 */
  const snapshots = ref<WorkspaceSnapshot[]>([])
  const listLoading = ref(false)

  async function refreshList(): Promise<void> {
    const pid = projectStore.currentProjectId
    if (!pid) {
      snapshots.value = []
      return
    }
    listLoading.value = true
    try {
      const all = await uiStateStore.getWorkspaceSnapshots()
      snapshots.value = all[pid] || []
    } finally {
      listLoading.value = false
    }
  }

  // 键位直达（P-20261004-49）的门控计数需要较新鲜的列表：挂载即预热（immediate，
  // 进入工作区直接 Ctrl+Alt+1 的主路径不空转）+ 项目切换同拍重拉（预设按项目
  // 键控，切换后旧项目列表失真）。热路径注记：均为低频动作（Layout 挂载/切项目/
  // 保存落盘）各一次既有端点小 GET，键击本身零请求；弹层打开时 openManager 的
  // 刷新与之同源幂等
  watch(() => projectStore.currentProjectId, () => { void refreshList() }, { immediate: true })

  /** 命令面板「保存当前现场」：命名 → 捕获当前现场 → 落盘（同名覆盖） */
  async function saveSnapshotFlow(): Promise<void> {
    if (!projectStore.currentProjectId) {
      message.warning(t('snapshot.noProject'))
      return
    }
    const name = await promptDialog({
      title: t('snapshot.saveTitle'),
      label: t('snapshot.saveNameLabel'),
      placeholder: t('snapshot.saveNamePlaceholder'),
      validate: (v) => v.trim() ? null : t('snapshot.nameRequired'),
    })
    const trimmed = name?.trim()
    if (!trimmed) return
    const snap = await captureCurrent(trimmed)
    const all = await uiStateStore.getWorkspaceSnapshots()
    const pid = projectStore.currentProjectId!
    const prev = all[pid] || []
    all[pid] = [snap, ...prev.filter(s => s.name !== snap.name)].slice(0, SNAPSHOTS_MAX)
    await uiStateStore.saveWorkspaceSnapshots(all)
    // 键位直达门控计数保鲜（P-20261004-49）：新预设插队表头，位次即键号
    await refreshList()
    message.success(t('snapshot.saved', { name: trimmed }))
  }

  /** 捕获当前现场为快照（保存与恢复前自动档共用采集端）：主组标签清单/活跃位/
   *  面板六元/分屏开合/树展开/分支名 + agent 会话组结构 + schema 版本号 */
  async function captureCurrent(name: string): Promise<WorkspaceSnapshot> {
    // 会话组采集失败不阻断存档主链：该维度缺省不参与恢复（结构与布局解耦）
    let agentGroups: SnapshotAgentGroup[] = []
    try {
      agentGroups = sanitizeSnapshotGroups((await uiStateStore.getAgentTerminalState()).groups)
    } catch { /* silent */ }
    return {
      id: `wsnap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      version: WORKSPACE_SNAPSHOT_VERSION,
      name,
      savedAt: Date.now(),
      branch: projectStore.currentProject?.currentBranch || '',
      editor: {
        openFiles: deps.openFilePaths(),
        activeFile: deps.activeFilePath(),
        splitOpen: deps.splitOpen(),
      },
      layout: {
        sidePanelWidth: layout.sidePanelWidth.value,
        bottomPanelHeight: layout.bottomPanelHeight.value,
        showSidePanel: layout.showSidePanel.value,
        showBottomPanel: layout.showBottomPanel.value,
        sideView: layout.sideView.value,
        bottomTab: layout.bottomTab.value,
      },
      fileTree: { expandedDirs: treeExpandedDirs() },
      agentGroups,
    }
  }

  /** 恢复前自动档（P-20261003-68 防丢兜底）：确认流之外的第二道保险——把当前
   *  现场存「恢复前」档（同名覆盖的单滚动槽位，与用户命名预设同表可见），误
   *  恢复可从列表一键回退。无条件执行：恢复动作不可预览，任何现场都值得留档；
   *  写入失败不阻断恢复主链 */
  async function autoArchiveBeforeRestore(): Promise<void> {
    try {
      const pid = projectStore.currentProjectId
      if (!pid) return
      const before = await captureCurrent(t('presets.autoArchiveName'))
      const all = await uiStateStore.getWorkspaceSnapshots()
      all[pid] = [before, ...(all[pid] || []).filter(s => s.name !== before.name)].slice(0, SNAPSHOTS_MAX)
      await uiStateStore.saveWorkspaceSnapshots(all)
    } catch { /* silent：自动档失败不阻断恢复 */ }
  }

  /** 命令面板「恢复现场」：打开存档列表弹层（列表即恢复入口，行内恢复/删除） */
  async function openManager(): Promise<void> {
    showManager.value = true
    await refreshList()
  }

  /** Ctrl/Cmd+Alt+数字 N 直达恢复（P-20261004-49）：取弹层列表同序的第 N 个走
   *  restoreSnapshot 既有链（未保存确认/恢复前自动档/分支差异提示全同）。门控
   *  计数与取数同源预热列表（下方保鲜 watch）——捕获链越界放行判定与这里读同
   *  一份，不存在「门控过了取不到」的竞态；越界/无项目静默返回（键击不消费，
   *  放行浏览器）。恢复后重拉一次：恢复前自动档「恢复前」插队表头，位次随动，
   *  下一次键击的序号语义与弹层所见一致（热路径注记：键击低频，每次一条小 GET
   *  同 P-219「点击时一次 GET」口径，命令面板 usage 持久化同理不在热路径） */
  async function restoreSnapshotByIndex(index: number): Promise<void> {
    const snap = snapshots.value[index]
    if (!projectStore.currentProjectId || !snap) return
    await restoreSnapshot(snap)
    await refreshList()
  }

  /** 恢复 = 自动档当前现场 → 面板态/分屏就地应用 → 树展开重放 → 主组换签重开
   *  → 会话组结构写回 → 关弹层反馈。分支差异在应用完成后仅提示（切换分支影响
   *  工作区内容，超出「恢复现场」职责） */
  async function restoreSnapshot(snap: WorkspaceSnapshot): Promise<void> {
    if (!projectStore.currentProjectId) {
      message.warning(t('snapshot.noProject'))
      return
    }
    // 未保存修改一次性确认：主组整表换签会关闭未保存标签（分屏组随 closeSplit
    // 并回主组后同样被换签覆盖）
    const unsaved = deps.unsavedCount()
    if (unsaved > 0) {
      const ok = await confirmDialog({
        type: 'warning',
        title: t('snapshot.restoreConfirmTitle'),
        content: t('snapshot.unsavedConfirm', { n: String(unsaved) }),
      })
      if (!ok) return
    }
    // 0. 恢复前自动档（P-20261003-68）：当前现场存「恢复前」档，防误恢复丢现场
    await autoArchiveBeforeRestore()
    // 1. 面板态就地应用：面板布局是模块级单例，直写即对全 UI 生效（P-74 同机械）；
    //    最大化三态先还原（「点啥显示啥」通用前置），枚举外脏值跳过（不覆盖现状）
    layout.restoreFromMaximized()
    if (SIDE_VIEWS.includes(snap.layout.sideView)) layout.sideView.value = snap.layout.sideView as SideView
    layout.showSidePanel.value = !!snap.layout.showSidePanel
    layout.showBottomPanel.value = !!snap.layout.showBottomPanel
    if (BOTTOM_TABS.includes(snap.layout.bottomTab)) layout.bottomTab.value = snap.layout.bottomTab as BottomTab
    if (typeof snap.layout.sidePanelWidth === 'number' && snap.layout.sidePanelWidth > 0) layout.sidePanelWidth.value = snap.layout.sidePanelWidth
    if (typeof snap.layout.bottomPanelHeight === 'number' && snap.layout.bottomPanelHeight > 0) layout.bottomPanelHeight.value = snap.layout.bottomPanelHeight
    // 1.5 分屏开合（P-20261003-68）：开合布尔缺省（legacy 快照）不覆盖现状；
    //     开/关两链在宿主合成（开=直写空组渲染，关=closeSplit 并回链路）
    if (typeof snap.editor.splitOpen === 'boolean') deps.applySplitOpen(snap.editor.splitOpen)
    // 2. 树展开重放（写键 + 挂载中树逐目录展开）
    await deps.applyTreeExpansion(snap.fileTree?.expandedDirs || [])
    // 3. 编辑器现场：主组整表换签（已删文件走 openFileByPath 既有降级：占位摘除 + 提示）
    await deps.applyEditor(snap.editor.openFiles, snap.editor.activeFile)
    // 3.5 会话组结构恢复（P-20261003-68）：仅写结构不拉起会话（生命周期另管）；
    //     落盘成功后广播 OPS_AGENT_GROUPS_CHANGED（P-20261004-79）——live 挂载中
    //     的管理页监听即时重应用，不再等下次挂载 boot（原 MVP 边界已升级）；
    //     快照未带该维度（legacy/采集失败）则该维度不参与恢复
    const groups = sanitizeSnapshotGroups(snap.agentGroups)
    if (groups.length > 0) await applyAgentGroups(groups)
    showManager.value = false
    // 4. 分支不同仅提示不强切
    const currentBranch = projectStore.currentProject?.currentBranch || ''
    if (snap.branch && currentBranch && snap.branch !== currentBranch) {
      message.warning(t('snapshot.branchDiffers', { snapshot: snap.branch, current: currentBranch }))
      return
    }
    message.success(t('snapshot.restored', { name: snap.name }))
    // 5. 会话组结构已写回的显式反馈（MVP 边界告知：会话本体不自动拉起）
    if (groups.length > 0) {
      message.info(t('presets.groupsRestored', { n: String(groups.length) }))
    }
  }

  /** 会话组结构写回（仅结构）：读当前 agentTerminal 态只替换 groups，折叠/排序/
   *  lastViewed 等其余字段原样保留；落盘成功后广播 OPS_AGENT_GROUPS_CHANGED
   *  （P-20261004-79）让 live 挂载中的管理页即时重应用（无载荷，消费方收到即拉
   *  全量）；失败静默（结构恢复不阻断布局/打开集主链，广播自然也不发） */
  async function applyAgentGroups(groups: SnapshotAgentGroup[]): Promise<void> {
    try {
      const ui = await uiStateStore.getAgentTerminalState()
      await uiStateStore.saveAgentTerminalState({ ...ui, groups })
      window.dispatchEvent(new Event(OPS_AGENT_GROUPS_CHANGED))
    } catch { /* silent */ }
  }

  /** 行内改名（P-20261003-68 可删改的「改」）：prompt 预填旧名，与其他条目重名
   *  拒绝落盘（同名覆盖语义只属于保存/自动档的槽位心智，改名不得顶掉他档） */
  async function renameSnapshot(snap: WorkspaceSnapshot): Promise<void> {
    const pid = projectStore.currentProjectId
    if (!pid) return
    const name = await promptDialog({
      title: t('presets.renameTitle'),
      label: t('presets.renameLabel'),
      defaultValue: snap.name,
      validate: (v) => v.trim() ? null : t('snapshot.nameRequired'),
    })
    const trimmed = name?.trim()
    if (!trimmed || trimmed === snap.name) return
    const all = await uiStateStore.getWorkspaceSnapshots()
    const list = all[pid] || []
    if (list.some(s => s.id !== snap.id && s.name === trimmed)) {
      message.warning(t('presets.renameDuplicate', { name: trimmed }))
      return
    }
    all[pid] = list.map(s => (s.id === snap.id ? { ...s, name: trimmed } : s))
    await uiStateStore.saveWorkspaceSnapshots(all)
    await refreshList()
    message.success(t('presets.renamed', { name: trimmed }))
  }

  /** 删除存档（列表行内动作；confirm 后落盘并刷新列表） */
  async function deleteSnapshot(snap: WorkspaceSnapshot): Promise<void> {
    const pid = projectStore.currentProjectId
    if (!pid) return
    const ok = await confirmDialog({
      type: 'warning',
      title: t('snapshot.deleteTitle'),
      content: t('snapshot.deleteConfirm', { name: snap.name }),
    })
    if (!ok) return
    const all = await uiStateStore.getWorkspaceSnapshots()
    const next = (all[pid] || []).filter(s => s.id !== snap.id)
    if (next.length > 0) all[pid] = next
    else delete all[pid]
    await uiStateStore.saveWorkspaceSnapshots(all)
    await refreshList()
    message.success(t('snapshot.deleted', { name: snap.name }))
  }

  /** 采集文件树展开目录：真实数据源是 localStorage 展开键（FileTreeView watch
   *  回写），uiState 的 fileTree.expandedDirs 被 auto-save 恒写空表不可采 */
  function treeExpandedDirs(): string[] {
    const pid = projectStore.currentProjectId
    if (!pid) return []
    try {
      const saved = JSON.parse(localStorage.getItem(`sc.fileTree.expanded.${pid}`) || '[]')
      return Array.isArray(saved) ? saved.filter((x): x is string => typeof x === 'string') : []
    } catch { return [] }
  }

  return {
    showManager,
    snapshots,
    listLoading,
    saveSnapshotFlow,
    openManager,
    refreshList,
    restoreSnapshot,
    restoreSnapshotByIndex,
    deleteSnapshot,
    renameSnapshot,
  }
}
