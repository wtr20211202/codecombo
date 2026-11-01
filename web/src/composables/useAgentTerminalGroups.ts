import { computed, h, onBeforeUnmount, onMounted, ref, watch, type Ref, type VNodeChild } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from './useI18n'
import { useMessage } from 'naive-ui'
import { usePanelLayout } from './usePanelLayout'
import { confirmDialog, promptDialog } from './useDialog'
import { useUIStateStore } from '../stores/uiState'
import { useTerminalSessionsStore } from '../stores/terminal-sessions'
import { useApprovalsStore } from '../stores/approvals'
import { useProjectStore } from '../stores/project'
import { useTerminalStore } from '../stores/terminal'
import { OPS_AGENT_GROUPS_CHANGED } from '../utils/opsEvents'
import type { AgentTermSession } from './useAgentTerminal'

/** 结束会话确认正文（P-20261003-275）：会话有等待裁决的审批时正文下方附警示行
 *  ——关闭即裁决永不到来（agent 白等至 TTL 兜底）。shell 会话内手跑 agent CLI
 *  同样可能挂审批（审批 sessionId 由 agent 令牌自由填写），按 sessionId 判定
 *  不预设会话形态，hasPendingApproval 由调用方自查 approvals.pendingSessionIds
 *  传入。渲染函数形态走 confirmDialog 富内容口（useHomeProjects 锁定影响面
 *  清单同款）；无 pending 时维持纯字符串原样。模块级纯函数：右键「结束会话」
 *  与管理页 tab × 两确认面同源复用防漂移 */
export function buildDestroyConfirmContent(
  t: (key: string, params?: Record<string, unknown>) => string,
  hasPendingApproval: boolean,
  name: string,
): string | (() => VNodeChild) {
  if (!hasPendingApproval) {
    return t('agentTerminal.destroyConfirm', { name })
  }
  return () => h('div', { style: 'display:flex;flex-direction:column;gap:6px;' }, [
    h('div', null, t('agentTerminal.destroyConfirm', { name })),
    h('div', { style: 'color:var(--accent-orange);font-weight:600;' }, t('terminal.closeConfirmPendingApproval')),
  ])
}

/**
 * 智能体终端侧栏数据模型（P-20261001-20 从 AgentTerminalView 拆出）：
 * 自定义分组 / 项目分组（自动归组）/ 排序与折叠持久化 / 会话与分组的全部
 * 变更动作 / 项目跳转与项目会话创建。分组仅是展示层组织，会话本体在服务端
 * 终端管理器；组序 / 组内序 / 折叠集合经 uiState 持久化。
 */
export function useAgentTerminalGroups(deps: {
  /** 系统会话（useAgentTerminal 的 sessions） */
  sessions: Ref<AgentTermSession[]>
  /** 右侧渲染中的会话 id（agent 或被接管的项目会话） */
  selectedId: Ref<string>
  /** 最后查看的会话 id（跨折叠持久化，宿主选中模型持有） */
  lastViewedSessionId: Ref<string>
  sessionsStore: ReturnType<typeof useTerminalSessionsStore>
  projectStore: ReturnType<typeof useProjectStore>
  rename: (id: string, name: string) => Promise<unknown>
  destroy: (id: string) => Promise<unknown>
  /** 显式终结外部接管会话（P-20261005-189 kill 分支，二次确认由本模块弹） */
  kill: (id: string) => Promise<unknown>
  /** 接管项目会话到本页渲染（新建项目会话后调用，宿主选中模型动作） */
  attachProject: (id: string) => void
  /** 当前选中且已接管的项目会话（openProject 归属判断用） */
  getSelectedProjectSession: () => { projectId: string } | null | undefined
  /** 收起本页（跳转项目视图后调用，useAgentTerminal 的 hide） */
  hide: () => void
  /** uiState 恢复完成后由宿主接力：await refresh() + ensureDockedSelection() */
  afterRestore: () => Promise<void> | void
}) {
  const { t } = useI18n()
  const message = useMessage()
  const router = useRouter()
  const terminalStore = useTerminalStore()
  const uiStateStore = useUIStateStore()
  // 结束会话确认的 pending 审批警示源（P-20261003-275）：pendingSessionIds
  // 与终端会话 id 同域（P-198 静默标同款归属判定）
  const approvalsStore = useApprovalsStore()
  const { sessionsStore, projectStore, sessions, selectedId } = deps

  // ============== 项目分组（自动按 projectId 归组，项目名由项目表映射） ==============
  // 组序 / 组内会话序 / 折叠集合均持久化在 uiState（projectGroups 消费端渲染序）。
  // 组内会话手动序仅 default 排序模式生效——name/activity 是显式排序意图，优先
  const collapsedProjects = ref(new Set<string>())
  const projectOrder = ref<string[]>([])
  const projectSessionOrder = ref<Record<string, string[]>>({})

  const projectGroups = computed(() => {
    const entries = [...sessionsStore.sessionsByProject.entries()]
    const order = projectOrder.value
    if (order.length > 0) {
      entries.sort((a, b) => {
        const ia = order.indexOf(a[0])
        const ib = order.indexOf(b[0])
        return (ia < 0 ? Number.MAX_SAFE_INTEGER : ia) - (ib < 0 ? Number.MAX_SAFE_INTEGER : ib)
      })
    }
    return entries.map(([projectId, list]) => {
      const manual = projectSessionOrder.value[projectId]
      let ordered = list
      if (manual && manual.length > 0 && sessionsStore.sortMode === 'default') {
        const byId = new Map(list.map(s => [s.id, s] as const))
        ordered = manual.map(id => byId.get(id)).filter((s): s is NonNullable<typeof s> => !!s)
          .concat(list.filter(s => !manual.includes(s.id)))
      }
      return {
        projectId,
        name: projectStore.projects.find(p => p.id === projectId)?.name
          || list[0]?.path
          || projectId,
        sessions: ordered.map(s => ({
          id: s.id,
          name: s.name,
          running: sessionsStore.runningMap[s.id] === true,
          attached: sessionsStore.managerAttached.has(s.id),
        })),
      }
    })
  })

  function onToggleProject(projectId: string) {
    const next = new Set(collapsedProjects.value)
    if (next.has(projectId)) next.delete(projectId)
    else next.add(projectId)
    collapsedProjects.value = next
    persistUi()
  }
  function onReorderProjectGroups(orderedIds: string[]) {
    const known = new Set(sessionsStore.sessionsByProject.keys())
    const kept = projectOrder.value.filter(id => !orderedIds.includes(id) && known.has(id))
    projectOrder.value = [...orderedIds.filter(id => known.has(id)), ...kept]
    persistUi()
  }
  function onReorderProjectSessions(payload: { projectId: string; orderedIds: string[] }) {
    projectSessionOrder.value = { ...projectSessionOrder.value, [payload.projectId]: payload.orderedIds }
    persistUi()
  }

  /** 跳转项目视图：归还该项目被接管会话 → 切项目 → 恢复上次布局（侧栏未开则
   *  兜底打开文件面板，由 Layout bootstrap 在布局恢复后消费标志）。
   *  带 sessionId 时改为激活该项目底部终端（会话跳转语义） */
  async function openProject(projectId: string, sessionId?: string) {
    for (const s of sessionsStore.projectSessions) {
      if (s.projectId === projectId && sessionsStore.managerAttached.has(s.id)) {
        sessionsStore.returnToPanel(s.id)
      }
    }
    // 选中项归属判断需要 selectedProjectSession——宿主经 getSelectedProjectSession
    // 注入，避免本 composable 与选中模型互相依赖
    if (deps.getSelectedProjectSession()?.projectId === projectId) selectedId.value = ''
    // 切换守卫取消（未保存草稿确认选「取消」，P-20261003-105）→ 放弃跳转
    if ((await projectStore.selectProjectExplicit(projectId)) === false) return
    const layout = usePanelLayout()
    if (sessionId) {
      terminalStore.requestSwitch(sessionId)
      layout.showBottomPanel.value = true
      layout.bottomTab.value = 'terminal'
    } else if (router.currentRoute.value.name === 'project') {
      // 项目页内打开项目：布局即当前状态，仅兜底「侧栏没开」→ 打开文件面板
      if (!layout.showSidePanel.value) {
        layout.showSidePanel.value = true
        layout.sideView.value = 'files'
      }
    } else {
      // 跨页跳转：布局恢复由项目 Layout bootstrap 完成，本标志在其后兜底消费
      layout.pendingSideFilesOpen.value = true
    }
    if (router.currentRoute.value.name !== 'project') await router.push({ name: 'project' })
    deps.hide()
  }

  // ============== 会话分组（持久化 uiState） ==============
  const groups = ref<{ id: string; name: string; sessionIds: string[] }[]>([])
  const booting = ref(true)
  const sidebarCollapsed = ref(false)

  // uiState 持久化串行化：deep watch 在连续变更（如连续拖拽）下会产生并发 PUT，
  // 网络乱序会让旧快照覆盖新快照（拖拽排序偶发丢失的根因）。链式串行保证
  // 到达顺序 == 发起顺序，且每次执行都重读最新值实现「最新态覆盖」
  let persistChain: Promise<void> = Promise.resolve()
  async function persistUi() {
    const snapshot = {
      groups: groups.value.map(g => ({ ...g, sessionIds: [...g.sessionIds] })),
      sidebarCollapsed: sidebarCollapsed.value,
      collapsedProjects: [...collapsedProjects.value],
      projectOrder: [...projectOrder.value],
      projectSessionOrder: { ...projectSessionOrder.value },
      lastViewedSessionId: deps.lastViewedSessionId.value,
    }
    persistChain = persistChain
      .then(() => uiStateStore.saveAgentTerminalState(snapshot))
      .catch(() => { /* 静默：保存失败由下次变更重试 */ })
    await persistChain
  }
  watch(groups, persistUi, { deep: true })
  watch(sidebarCollapsed, persistUi)
  // 最后查看的会话变化即持久化（切换/接管都会更新），否则快照里的 id 是旧值
  watch(deps.lastViewedSessionId, persistUi)

  async function boot() {
    booting.value = true
    try {
      const ui = await uiStateStore.getAgentTerminalState()
      groups.value = ui.groups
      sidebarCollapsed.value = ui.sidebarCollapsed
      collapsedProjects.value = new Set(ui.collapsedProjects)
      projectOrder.value = ui.projectOrder
      projectSessionOrder.value = ui.projectSessionOrder
      // 恢复最后查看的会话（跨刷新延续查看上下文；须在 ensureDockedSelection 之前）
      deps.lastViewedSessionId.value = ui.lastViewedSessionId
      await deps.afterRestore()
    } catch { /* silent：锁定态由解锁 watch 重跑 */ } finally {
      booting.value = false
    }
  }

  // 会话组结构外部写回即时生效（P-20261004-79）：工作区预设恢复链在 groups 落盘
  // 成功后派发 OPS_AGENT_GROUPS_CHANGED，live 挂载中的本页收到的即重读 uiState
  // 会话组段就地重应用——把「组结构恢复只在下次挂载 boot 生效」的 MVP 边界升级
  // 为即时生效。home overlay 与 project 内嵌双实例可并存（AgentTerminal 全局唯一
  // 挂载点是「每路由一份」），各自监听互不干扰。收到即拉全量不信任事件载荷
  // （与 OPS_QUEUE_CHANGED 消费同纪律，读到的是落盘后真值）；boot 进行中让位
  // （boot 自身读的就是落盘后状态）；读失败静默（同 boot 容错口径）。groups 赋值
  // 触发 persistUi 回写同内容，与 boot 首次赋值同款既有语义，幂等无害。
  // 恢复是低频用户动作，每次至多「实例数 × 1 条小 GET」，无热路径顾虑。
  // 残余竞态窗口：本读若并入写前在途的同键 GET（P-246 合并 + r7 读后写重取
  // 坑同形）会拿到旧组——窗口毫秒级且实测未复现，读旧也只是退回「下次 boot
  // 生效」旧边界，不自愈面有限，不为它豁免 ui-state 全局合并
  async function onExternalGroupsChanged(): Promise<void> {
    if (booting.value) return
    try {
      const ui = await uiStateStore.getAgentTerminalState()
      groups.value = ui.groups
    } catch { /* silent：外部写回对账失败由下次 boot/恢复再对齐 */ }
  }
  onMounted(() => window.addEventListener(OPS_AGENT_GROUPS_CHANGED, onExternalGroupsChanged))
  onBeforeUnmount(() => window.removeEventListener(OPS_AGENT_GROUPS_CHANGED, onExternalGroupsChanged))

  // ============== 新建项目会话（新建即接管到本页渲染） ==============
  const projectCreateOptions = computed(() => [
    { label: t('agentTerminal.newProjectSession'), key: '__head__', disabled: true },
    ...projectStore.projects.map(p => ({ label: p.name, key: `proj:${p.id}` })),
  ])
  async function onCreateProjectSelect(key: string) {
    if (!key.startsWith('proj:')) return
    await createProjectSession(key.slice(5))
  }

  /** 新建指定项目的项目会话并接管到本页（头部下拉 / 项目分组右键共用）。
   *  不传名 = 服务端命名（槽位继承用户最近的命名 / 双语序号名），native 重启后
   *  重建的会话才能经继承还原改名 */
  async function createProjectSession(pid: string) {
    const info = await sessionsStore.createProject(pid)
    if (!info) {
      message.error(t('agentTerminal.error'))
      return
    }
    deps.attachProject(info.id)
  }

  /** 项目分组右键菜单：新建项目会话 / 打开项目 */
  function onProjectAction(payload: { projectId: string; key: 'create-session' | 'open' }) {
    if (payload.key === 'create-session') void createProjectSession(payload.projectId)
    else void openProject(payload.projectId)
  }

  /** 结束会话确认正文：pending 判定收口本组 approvals store 镜像，正文构造
   *  走模块级 buildDestroyConfirmContent（与 AgentTerminalView tab × 同源） */
  function destroyConfirmContent(name: string, sessionId: string): string | (() => VNodeChild) {
    return buildDestroyConfirmContent(t, approvalsStore.pendingSessionIds.has(sessionId), name)
  }

  /** 项目会话右键菜单：结束会话（确认后走统一 destroy 管线） */
  async function onProjectSessionDestroy(payload: { sessionId: string; key: 'destroy' }) {
    const s = sessionsStore.projectSessions.find(ss => ss.id === payload.sessionId)
    if (!s) return
    const ok = await confirmDialog({
      title: t('agentTerminal.destroy'),
      content: destroyConfirmContent(s.name, s.id),
      type: 'warning',
    })
    if (!ok) return
    await sessionsStore.destroy(payload.sessionId)
    if (selectedId.value === payload.sessionId) selectedId.value = ''
  }

  async function onSessionAction(payload: { sessionId: string; key: 'rename' | 'destroy' | 'kill' | `move:${string}` | 'move:__root__'; name?: string }) {
    const s = sessions.value.find(ss => ss.id === payload.sessionId)
    if (!s) return
    if (payload.key === 'rename') {
      // 双击内联重命名直传 name，跳过输入对话框
      const name = payload.name || await promptDialog({ title: t('agentTerminal.renameTitle'), label: t('agentTerminal.renameLabel'), defaultValue: s.name })
      if (name && name.trim() && name.trim() !== s.name) {
        await deps.rename(s.id, name.trim())
      }
      return
    }
    if (payload.key === 'destroy') {
      // close 语义分流（P-20261005-189）：外部接管会话「结束」=解除接管——
      // 本系统放手，tmux 会话与其中进程原样存活；文案随之区分诚实告知。
      // 解除接管后会话与 agent 原样存活、裁决仍可送达，不附 pending 警示；
      // 真实 destroy 才附（P-20261003-275）
      const external = s.origin === 'external'
      const ok = await confirmDialog({
        title: external ? t('agentTerminal.external.releaseTitle') : t('agentTerminal.destroy'),
        content: external
          ? t('agentTerminal.external.releaseConfirm', { name: s.name })
          : destroyConfirmContent(s.name, s.id),
        type: 'warning',
      })
      if (!ok) return
      await deps.destroy(s.id)
      return
    }
    if (payload.key === 'kill') {
      // 显式终结外部 tmux 会话：kill-session 不可逆（error 级弹窗点名后果）
      const ok = await confirmDialog({
        title: t('agentTerminal.external.killTitle'),
        content: t('agentTerminal.external.killConfirm', { name: s.name }),
        type: 'error',
      })
      if (!ok) return
      await deps.kill(s.id)
      return
    }
    // move:<groupId> | move:__root__
    const groupId = payload.key.slice(5)
    for (const g of groups.value) g.sessionIds = g.sessionIds.filter(id => id !== s.id)
    if (groupId !== '__root__') {
      groups.value.find(g => g.id === groupId)?.sessionIds.push(s.id)
    }
    persistUi()
  }

  async function onGroupAction(payload: { key: 'create' | `rename:${string}` | `delete:${string}`; name?: string }) {
    if (payload.key === 'create' && payload.name) {
      groups.value.push({ id: `at_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, name: payload.name, sessionIds: [] })
      return
    }
    if (payload.key.startsWith('rename:') && payload.name) {
      const gid = payload.key.slice(7)
      const g = groups.value.find(gg => gg.id === gid)
      if (g) g.name = payload.name
      return
    }
    if (payload.key.startsWith('delete:')) {
      const gid = payload.key.slice(7)
      groups.value = groups.value.filter(gg => gg.id !== gid) // 组内会话回到未分组
      persistUi()
    }
  }

  // ============== 侧栏拖拽：分组排序 / 组内会话排序 / 跨组移动（groups 即持久化模型） ==============
  function onReorderGroups(orderedIds: string[]) {
    const byId = new Map(groups.value.map(g => [g.id, g]))
    const next = orderedIds.map(id => byId.get(id)).filter((g): g is NonNullable<typeof g> => !!g)
    // 未在 payload 里的组（防御性）保留在尾部
    groups.value = [...next, ...groups.value.filter(g => !orderedIds.includes(g.id))]
    persistUi()
  }
  function onReorderGroupSessions(payload: { groupId: string; orderedIds: string[] }) {
    const g = groups.value.find(gg => gg.id === payload.groupId)
    if (!g) return
    const rest = g.sessionIds.filter(id => !payload.orderedIds.includes(id))
    g.sessionIds = [...payload.orderedIds, ...rest]
    persistUi()
  }
  function onMoveSessionByDrag(payload: { sessionId: string; toGroupId: string | '__root__' }) {
    for (const g of groups.value) g.sessionIds = g.sessionIds.filter(id => id !== payload.sessionId)
    if (payload.toGroupId !== '__root__') groups.value.find(g => g.id === payload.toGroupId)?.sessionIds.push(payload.sessionId)
    persistUi()
  }

  /** 批量移动到分组/未分组（多选批操作） */
  function onBatchMove(payload: { sessionIds: string[]; toGroupId: string | '__root__' }) {
    const ids = new Set(payload.sessionIds)
    for (const g of groups.value) g.sessionIds = g.sessionIds.filter(id => !ids.has(id))
    if (payload.toGroupId !== '__root__') groups.value.find(g => g.id === payload.toGroupId)?.sessionIds.push(...payload.sessionIds)
    persistUi()
  }

  /** 批量结束会话（确认一次，逐个走既有 destroy 管线）。混有外部接管会话时
   *  附注如实告知：其「结束」=解除接管不杀 tmux 会话（P-20261005-189 分流） */
  async function onBatchDestroy(sessionIds: string[]) {
    if (!sessionIds.length) return
    const hasExternal = sessionIds.some(id =>
      sessions.value.find(ss => ss.id === id)?.origin === 'external')
    const ok = await confirmDialog({
      title: t('agentTerminal.destroy'),
      content: hasExternal
        ? t('agentTerminal.batchDestroyConfirmMixed', { n: sessionIds.length })
        : t('agentTerminal.batchDestroyConfirm', { n: sessionIds.length }),
      type: 'warning',
    })
    if (!ok) return
    for (const id of sessionIds) await deps.destroy(id)
  }

  return {
    groups, booting, sidebarCollapsed,
    collapsedProjects, projectOrder, projectSessionOrder, projectGroups,
    boot, persistUi,
    onToggleProject, onReorderProjectGroups, onReorderProjectSessions,
    openProject, projectCreateOptions, onCreateProjectSelect, createProjectSession,
    onProjectAction, onProjectSessionDestroy,
    onSessionAction, onGroupAction,
    onReorderGroups, onReorderGroupSessions, onMoveSessionByDrag, onBatchMove, onBatchDestroy,
  }
}
