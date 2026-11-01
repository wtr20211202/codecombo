import { ref, computed, nextTick, type Ref } from 'vue'
import { useMessage } from 'naive-ui'
import { useProjectStore } from '../stores/project'
import { useTerminalSessionsStore } from '../stores/terminal-sessions'
import { terminalApi } from '../api/client'
import { useI18n } from './useI18n'
import { OPS_ACTIVATE_TERMINAL } from '../utils/opsEvents'
import { safeStorage } from '../utils/storage'
import { forceTerminalScrollResync } from '../utils/terminalScrollResync'
import { pinnedFirstOrder } from '../utils/terminalTabPins'
import { safeFitInstance, type TermInstance } from './useTerminalInstances'

// 终端 tab 的最小契约（原 useTerminalWs 定义，连接生命周期抽取到 useTerminalSession 后移入此处）
export interface TermTabInfo {
  id: string
  name: string
  projectId: string
  // 命令状态指示（Phase B tab 状态点用）
  running?: boolean
  lastExitCode?: number
  // Split pane 支持（Phase D，仅 1 层嵌套）
  // panes = [primary, secondary]；undefined / [id] / length<=1 表示单 pane
  panes?: string[]
  paneDirection?: 'horizontal' | 'vertical'
  activePaneId?: string
}

// 终端标签（连接中状态由 TerminalPane 内部的 connecting 驱动，tab 上不再持有 loading 字段）
export type TermTab = TermTabInfo

export interface UseTerminalTabsParams {
  // 共享状态：tabs/activeTabId 由 TerminalView 持有，传 Ref 进来
  tabs: Ref<TermTab[]>
  activeTabId: Ref<string>
  // 来自 useTerminalInstances
  termInstances: Map<string, TermInstance>
  disposeInstance: (tabId: string) => void
  // 注：连接由 TerminalPane 挂载时自行发起（useTerminalSession.connect），
  // 不再需要宿主注入 connectTerminal
}

export function useTerminalTabs(params: UseTerminalTabsParams) {
  const { tabs, activeTabId, termInstances, disposeInstance } = params
  const projectStore = useProjectStore()
  const sessionsStore = useTerminalSessionsStore()
  const message = useMessage()
  const { t } = useI18n()

  // 重命名状态
  const renamingTabId = ref('')
  const renameValue = ref('')

  // ============== 关闭二次确认 ==============
  // localStorage 持久化「不再提示」让用户可永久跳过
  const CLOSE_NO_PROMPT_KEY = 'sc.terminal.closeNoConfirm'
  const showCloseConfirm = ref(false)
  const pendingCloseTabId = ref('')
  const closeNoPrompt = ref(safeStorage.getItem(CLOSE_NO_PROMPT_KEY) === '1')

  // 当前项目下终端 tab（computed 给模板用）。显示序 = 置顶分组投影
  // （P-20261004-53）：置顶 tab 稳定 partition 到队首，物理 tabs 数组不动——
  // 数组被快照对账（追加/摘除）与拖拽重排持续写，投影互不干扰；副作用是
  // 拖拽无法把未置顶 tab 拖进置顶组（投影立即复位），取消置顶即回原相对位。
  // 消费面（badge 序号/closeRight/溢出下拉/Alt+1-9 切签）全部跟随此序，
  // 「关闭右侧」等按视觉位置的批量动作所见即所关
  const projectTabs = computed(() => {
    const list = tabs.value.filter((t) => t.projectId === projectStore.currentProjectId)
    return pinnedFirstOrder(list, sessionsStore.pinnedIds)
  })

  // dir（P-20261005-192 目录级终端直达）：会话工作目录的项目相对路径，空/缺省
  // = 项目根（既有行为）。服务端守卫存在性 + 项目根内（越界/缺失 400 稳定原文，
  // 拦截器按 KNOWN_ERROR_I18N 出专属文案）；shell 副本「与源天然同目录」不适用
  // 本参数——复制链不传 dir（源会话 cwd 见 duplicateTerminal 注释）
  async function createTerminal(dir?: string): Promise<void> {
    if (!projectStore.currentProjectId) {
      message.warning(t('terminal.selectProject'))
      return
    }

    try {
      // 默认名由服务端生成（槽位继承用户最近的命名 / 双语序号名）：前端不传名，
      // native 重启后重建的会话才能经服务端继承还原改名（改名已落库）
      const res: { data: { id: string; name?: string } } = await terminalApi.create(
        projectStore.currentProjectId,
        undefined,
        { errorLabel: 'terminal.createFailed' },
        { dir },
      )
      const data = res.data
      // 去重：新建会话的 terminals.changed 广播可能先于本函数的本地 push 到达
      // （useTerminalTabSync 已按快照加过同 id tab），无条件 push 会产生重复 tab；
      // 激活语义不受去重影响（新建即激活，两条路径殊途同归）
      if (!tabs.value.some(t => t.id === data.id)) {
        tabs.value.push({
          id: data.id,
          name: data.name || 'Terminal',
          projectId: projectStore.currentProjectId,
        })
      }
      activeTabId.value = data.id
      // TerminalPane 随 tabs 数组渲染挂载并自行发起连接，无需在此显式 connect
    } catch {
      // 拦截器已弹专属文案 + 写 Console
    }
  }

  // ============== 复制会话（P-20261004-1） ==============
  // tab 右键「复制会话」：取源会话创建配置（projectId/kind/dir/runtime）调既有
  // POST /terminals 建同配置新会话并激活——「原会话保持现场、新会话跑试验命令」
  // 的对照试验一步到位（原路径 = 记住配置手动新建）。语义边界：
  // - 复制的是「创建配置」而非运行现场：agent 副本 dir 取注册目录（服务端快照
  //   path，即创建 dir），不是 shell 内 cd 后的实时 cwd（currentDir）；shell 副本
  //   dir 由服务端按项目解析（创建请求无 dir 参数），与源天然同目录
  // - agent 副本不带 launchArgs：该字段承载 --resume 等启动参数，复制语义是
  //   干净起跑不是重放启动命令
  // - 名字加「副本」后缀（i18n 模板）防与源混淆，重复复制链式追加
  // - 浮窗态源 tab 的副本落常规 docked 位：浮动登记按 tabId 记账不随复制，
  //   新 tab 走创建即激活链（MVP 不做浮窗对浮窗镜像）
  async function duplicateTerminal(tab: TermTab): Promise<void> {
    const name = t('terminal.duplicateName', { name: tab.name })
    try {
      const src = sessionsStore.sessions.find(s => s.id === tab.id)
      if (src?.kind === 'agent') {
        // agent 副本：宿主是会话管理页（底部 tab 对账只收 shell，见
        // useTerminalTabSync），激活走既有 OPS_ACTIVATE_TERMINAL 广播
        const info = await sessionsStore.createAgent(
          name,
          src.runtime,
          undefined,
          src.path ? { dir: src.path } : {},
        )
        if (info) {
          window.dispatchEvent(new CustomEvent(OPS_ACTIVATE_TERMINAL, { detail: { id: info.id } }))
        }
        return
      }
      // shell 副本（底部面板 tab 的现实形态）：创建即激活；去重与 createTerminal
      // 同链——terminals.changed 广播可能先于本地 push 到达
      const res: { data: { id: string; name?: string } } = await terminalApi.create(
        tab.projectId,
        name,
        { errorLabel: 'terminal.createFailed' },
      )
      const data = res.data
      if (!tabs.value.some(t => t.id === data.id)) {
        tabs.value.push({ id: data.id, name: data.name || name, projectId: tab.projectId })
      }
      activeTabId.value = data.id
      // TerminalPane 随 tabs 数组渲染挂载并自行发起连接，无需在此显式 connect
    } catch {
      // 拦截器已弹专属文案 + 写 Console
    }
  }

  // 请求关闭终端：按 backend 模式 + 「不再提示」状态决定是否弹确认
  // 模板上的 × 按钮调用此入口（而非直接调 closeTerminal）
  async function requestCloseTab(tabId: string): Promise<void> {
    const tab = tabs.value.find(t => t.id === tabId)
    // split 模式：× 按钮语义 = "取消拆分"（关 secondary，保留 primary 回到单 pane）
    if (tab && tab.panes && tab.panes.length >= 2) {
      const secondaryId = tab.panes[1]
      if (secondaryId && secondaryId !== tab.id) {
        await requestClosePane(tab, secondaryId)
        return
      }
    }
    // 单 pane：走原确认流程
    if (closeNoPrompt.value) {
      await closeTerminal(tabId)
      return
    }
    pendingCloseTabId.value = tabId
    showCloseConfirm.value = true
  }

  // ============== split secondary 关闭的条件保全（P-20261004-145） ==============
  // 「取消拆分 / 关 pane」的单一判定入口：secondary 有命令在跑时不直接处决，
  // 弹两选弹层（终止 / 转为独立 tab 保留）——watch+act 双开的 watcher 被
  // 「收个屏」误拆即死（dev server 冷启动数十秒、滚回上下文不可复得）；
  // 闲 pane 维持布局撤销直拆语义不打扰。× 按钮（requestCloseTab）、
  // Ctrl+Shift+W（useTerminalSplit.closeActivePane）、split toggle（splitTab
  // 同向去拆）三路收口同判
  const showPaneCloseConfirm = ref(false)
  const pendingPaneClose = ref<{ tabId: string; paneId: string } | null>(null)

  async function requestClosePane(tab: TermTab, paneId: string): Promise<void> {
    // 仅 split 的 secondary 走条件保全：关 primary = 整 tab 处置（连带
    // secondary），单 pane = tab 关闭语义，都不在本弹层射程
    if (!tab.panes || tab.panes.length < 2 || paneId === tab.id) {
      await closePane(tab, paneId)
      return
    }
    // running 判定读 sessionsStore.runningMap（OSC 133 C/D 按会话 id 记账）：
    // secondary 是独立会话、无自己的 tab 条目（splitTab 建时已摘幽灵 tab），
    // tab.running 只记 primary——oscBridge 的 tabs.find(t => t.id === sessionId)
    // 够不到 panes[1]。缺 key（未连接 / 裸 shell 无集成）= 未知 → 视为空闲
    // 直拆，行为不劣化（提案声明的降级边界）
    if (sessionsStore.runningMap[paneId] === true) {
      pendingPaneClose.value = { tabId: tab.id, paneId }
      showPaneCloseConfirm.value = true
      return
    }
    await closePane(tab, paneId)
  }

  // 弹层「关闭」：按原语义处决 secondary（布局撤销，进程随 session 终结）
  async function confirmPaneClose(): Promise<void> {
    const pending = pendingPaneClose.value
    showPaneCloseConfirm.value = false
    pendingPaneClose.value = null
    if (!pending) return
    const tab = tabs.value.find(t => t.id === pending.tabId)
    if (!tab) return
    await closePane(tab, pending.paneId)
  }

  // 弹层「转为独立 tab」：拆分变并列——secondary 会话原地保留（不 close 不
  // 重建），从 panes 摘出成独立 tab 插到当前 tab 之后（最近邻）。进程与滚回
  // 缓冲随服务端会话原样带走（客户端只断 WS），重挂的 TerminalPane 经
  // scrollback 重放恢复现场——tab-first 形态下 watcher 的自然出口
  function keepPaneAsTab(): void {
    const pending = pendingPaneClose.value
    showPaneCloseConfirm.value = false
    pendingPaneClose.value = null
    if (!pending) return
    const tab = tabs.value.find(t => t.id === pending.tabId)
    if (!tab || !tab.panes || tab.panes.length < 2 || tab.panes[1] !== pending.paneId) return
    tab.panes = undefined
    tab.paneDirection = undefined
    tab.activePaneId = tab.id
    // 名字取服务端权威值（splitTab 创建时的「<主名>-split」），快照未达退主名
    const name = sessionsStore.sessions.find(s => s.id === pending.paneId)?.name || tab.name
    const idx = tabs.value.findIndex(t => t.id === pending.tabId)
    tabs.value.splice(idx + 1, 0, { id: pending.paneId, name, projectId: tab.projectId })
  }

  function cancelPaneClose(): void {
    showPaneCloseConfirm.value = false
    pendingPaneClose.value = null
  }

  // 用户点确认：可能写入「不再提示」，然后执行实际关闭
  async function confirmCloseTab(): Promise<void> {
    if (closeNoPrompt.value) {
      safeStorage.setItem(CLOSE_NO_PROMPT_KEY, '1')
    } else {
      // 用户在确认框中又取消了勾选，确保状态一致
      safeStorage.removeItem(CLOSE_NO_PROMPT_KEY)
    }
    const tabId = pendingCloseTabId.value
    showCloseConfirm.value = false
    pendingCloseTabId.value = ''
    await closeTerminal(tabId)
  }

  function cancelCloseTab(): void {
    showCloseConfirm.value = false
    pendingCloseTabId.value = ''
  }

  async function closeTerminal(tabId: string): Promise<void> {
    disposeInstance(tabId)

    try {
      await terminalApi.close(tabId)
    } catch {
      // ignore
    }

    const idx = tabs.value.findIndex((t) => t.id === tabId)
    // tab 可能已被 terminals.changed 对账先行移除（关闭广播先于本地 splice 到达）：
    // findIndex 为 -1 时 splice(-1,1) 会误删最后一个 tab，必须守卫直返
    if (idx < 0) return
    tabs.value.splice(idx, 1)

    if (activeTabId.value === tabId) {
      const pt = tabs.value.filter((t) => t.projectId === projectStore.currentProjectId)
      if (pt.length > 0) {
        activeTabId.value = pt[pt.length - 1]!.id
      } else {
        activeTabId.value = ''
      }
    }
  }

  function selectTab(tabId: string): void {
    activeTabId.value = tabId
    nextTick(() => {
      const inst = termInstances.get(tabId)
      if (inst) {
        // 安全 fit：跨项目跳转时本 tab 可能仍被项目切换 watcher 覆盖回隐藏，
        // 裸 fit 会按 display:none 的零尺寸算出极小列数再弹回，缓冲重排致乱屏
        safeFitInstance(inst)
        inst.term.focus()
      }
    })
  }

  // 拖拽重排序：把 dragId 的 tab 移到 targetId 之前（同条内位置交换；
  // panes 随 tab 对象整体移动，split tab 不可拆）
  function moveTabBefore(dragId: string, targetId: string): void {
    if (dragId === targetId) return
    const from = tabs.value.findIndex(t => t.id === dragId)
    if (from < 0) return
    const target = tabs.value.findIndex(t => t.id === targetId)
    if (target < 0) return
    const [moved] = tabs.value.splice(from, 1)
    const to = tabs.value.findIndex(t => t.id === targetId)
    tabs.value.splice(to, 0, moved!)
  }

  function startRename(tab: TermTab): void {
    renamingTabId.value = tab.id
    renameValue.value = tab.name
  }

  async function finishRename(tab: TermTab): Promise<void> {
    const trimmed = renameValue.value.trim()
    if (trimmed && trimmed !== tab.name) {
      try {
        await terminalApi.rename(tab.id, trimmed)
        tab.name = trimmed
      } catch {
        // 拦截器处理
      }
    }
    renamingTabId.value = ''
  }

  // ============== Phase D：split pane（仅 1 层嵌套）==============
  // 水平 / 垂直 split 当前 tab：创建新 session 加入 panes 数组
  async function splitTab(
    tab: TermTab,
    direction: 'horizontal' | 'vertical',
  ): Promise<void> {
    // toggle 语义：已 split + 同方向 → 取消拆分；已 split + 不同方向 → 忽略（仅支持 1 层）
    if (tab.panes && tab.panes.length >= 2) {
      if (tab.paneDirection === direction) {
        const secondaryId = tab.panes[1]
        if (secondaryId && secondaryId !== tab.id) {
          // 同为「取消拆分」，过 requestClosePane 条件保全（running 不直杀）
          await requestClosePane(tab, secondaryId)
        }
      }
      return
    }
    try {
      const res: { data: { id: string; name?: string } } = await terminalApi.create(
        tab.projectId,
        `${tab.name}-split`,
        { errorLabel: 'terminal.createFailed' },
      )
      const newPaneId = res.data.id
      tab.panes = [tab.id, newPaneId]
      tab.paneDirection = direction
      tab.activePaneId = newPaneId
      // 创建广播可能先于本赋值到达：对账已把 secondary 会话追加以幽灵 tab
      // （当时不知 panes 归属）。归属现已明确，移除幽灵 tab；
      // 其挂载的 TerminalPane 随 v-for 卸载并自清实例/WS，服务端会话保留
      const ghost = tabs.value.findIndex(t => t.id === newPaneId)
      if (ghost >= 0) tabs.value.splice(ghost, 1)
      // secondary TerminalPane 随 panes 渲染挂载并自行发起连接
    } catch {
      // 拦截器处理
    }
  }

  // 关闭 pane：
  // - 单 pane（无 split）：等同关闭整个 tab
  // - split 模式关 secondary：回到单 pane，primary 保留
  // - split 模式关 primary：把整个 tab（含 secondary）一起关掉，避免遗留孤儿实例 + tab.id 指向已关闭 session
  async function closePane(tab: TermTab, paneId: string): Promise<void> {
    if (!tab.panes || tab.panes.length < 2) {
      await closeTerminal(tab.id)
      return
    }
    // 关 primary 时连同 secondary 一起关，避免孤儿实例
    if (paneId === tab.id) {
      const secondaryId = tab.panes[1]
      if (secondaryId && secondaryId !== tab.id) {
        try {
          await terminalApi.close(secondaryId)
        } catch {
          // ignore
        }
        disposeInstance(secondaryId)
      }
      await closeTerminal(tab.id)
      return
    }
    // 关 secondary：清理实例 + 回到单 pane
    try {
      await terminalApi.close(paneId)
    } catch {
      // ignore
    }
    disposeInstance(paneId)
    tab.panes = undefined
    tab.paneDirection = undefined
    tab.activePaneId = tab.id
  }

  // 设置 tab 内的活动 pane（焦点切换）
  function setActivePane(tab: TermTab, paneId: string): void {
    tab.activePaneId = paneId
    nextTick(() => {
      const inst = termInstances.get(paneId)
      if (inst) {
        try {
          inst.fit.fit()
        } catch {
          // ignore
        }
        // 切换目标可能在 v-show 隐藏期间写过内容（滚动区尺寸陈旧，表现为
        // 上翻失灵）——show 时刻强制滚动区重同步，与会话切换自愈同源
        forceTerminalScrollResync(inst.term)
        inst.term.focus()
      }
    })
  }

  // 重启 shell：close 当前 session 后用同名新建一个，保留 tab 位置不变。
  // 用于 shell hang / 环境变量污染需要重置时——比「关闭 + 手动新建」少一步操作。
  // 后端无 restart 端点，前端组合 close + create 实现。
  async function restartTerminal(tab: TermTab): Promise<void> {
    const oldName = tab.name
    const projectId = tab.projectId
    // 1. 关闭旧 session（清理 ws + terminal 实例 + 后端 session）
    await closeTerminal(tab.id)
    // 2. 同名新建
    try {
      const res: { data: { id: string; name?: string } } = await terminalApi.create(
        projectId,
        oldName,
        { errorLabel: 'terminal.createFailed' },
      )
      const newTab: TermTab = {
        id: res.data.id,
        name: res.data.name || oldName,
        projectId,
      }
      tabs.value.push(newTab)
      activeTabId.value = newTab.id
      // 新 TerminalPane 随 tabs 数组渲染挂载并自行发起连接
    } catch {
      // 拦截器处理
    }
  }

  // 批量关闭：其他 / 右侧 / 全部（右键菜单用，fire-and-forget closeTerminal）
  async function closeOtherTabs(keepTabId: string): Promise<void> {
    const toClose = projectTabs.value.filter(t => t.id !== keepTabId).map(t => t.id)
    await Promise.all(toClose.map(id => closeTerminal(id)))
  }
  async function closeRightTabs(tabId: string): Promise<void> {
    const idx = projectTabs.value.findIndex(t => t.id === tabId)
    if (idx < 0) return
    const toClose = projectTabs.value.slice(idx + 1).map(t => t.id)
    await Promise.all(toClose.map(id => closeTerminal(id)))
  }
  async function closeAllTabs(): Promise<void> {
    const toClose = projectTabs.value.map(t => t.id)
    await Promise.all(toClose.map(id => closeTerminal(id)))
  }

  return {
    // 状态
    renamingTabId,
    renameValue,
    showCloseConfirm,
    pendingCloseTabId,
    closeNoPrompt,
    projectTabs,
    showPaneCloseConfirm,
    pendingPaneClose,
    // 操作
    createTerminal,
    duplicateTerminal,
    moveTabBefore,
    requestCloseTab,
    confirmCloseTab,
    cancelCloseTab,
    requestClosePane,
    confirmPaneClose,
    keepPaneAsTab,
    cancelPaneClose,
    closeTerminal,
    closeOtherTabs,
    closeRightTabs,
    closeAllTabs,
    restartTerminal,
    splitTab,
    closePane,
    setActivePane,
    selectTab,
    startRename,
    finishRename,
  }
}
