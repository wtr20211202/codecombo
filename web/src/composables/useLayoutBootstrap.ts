import { nextTick, watch } from 'vue'
import type { Ref } from 'vue'
import type { UIStateData } from '../stores/uiState'
import { useLayoutLockStore } from '../stores/layoutLock'
import { restoreRailTopOrder } from '../panels/registry'
import { OPS_FILES_EXTERNAL_CHANGE } from '../utils/opsEvents'
import { normalizeSideView, type BottomTab, type SideView } from './usePanelLayout'

/**
 * Layout 引导恢复（自 Layout.vue 抽出）：
 * - 挂载时恢复持久化 UI 状态（布局尺寸/实例选择/smart-stay/项目维度状态）
 * - 锁定 watch：锁定时关闭所有弹窗，解锁后重拉项目
 * - 通知中心 pendingAction watch：跨项目跳转 + 终端/面板/URL 触发
 */
interface BootstrapDeps {
  getInstanceState: () => Promise<UIStateData | null>
  showRemoteConsole: Ref<boolean>
  sidePanelWidth: Ref<number>
  bottomPanelHeight: Ref<number>
  showSidePanel: Ref<boolean>
  showBottomPanel: Ref<boolean>
  sideView: Ref<SideView>
  bottomTab: Ref<string>
  commitLocation: Ref<string>
  bottomPanelMaximized: Ref<boolean>
  bottomPanelEditorMaximized: Ref<boolean>
  /** 分屏开合恢复（uiState editor 命名空间） */
  splitOpen: Ref<boolean>
  /** 分屏方向恢复（P-20261005-230）：仅收合法枚举值；旧记录无此键/脏值不写
   *  （内存缺省横向 = 旧布局行为完全不变，幂等读取） */
  splitDirection: Ref<'horizontal' | 'vertical'>
  /** 分屏组清单恢复（P-20261002-94）：按持久化路径批量开进分屏组 + 已删降级
   *  汇总 toast（useOpenFiles.restoreSplitFromPaths 收口）。时序契约：调用方
   *  在主组 opens 全部落地后才调——串行约束防双组并发建 model 竞态 */
  restoreSplitFiles: (paths: string[], activeFile: string) => Promise<void>
  /** untitled 草稿启动恢复（P-20261003-97 草稿热退出）：读当前项目 IndexedDB
   *  untitled 命名空间记录重建草稿 tab + toast（useOpenFiles.restoreUntitledDrafts
   *  收口）。项目维度恢复落地后调用；无记录时零副作用 */
  restoreUntitledDrafts: () => Promise<void>
  /** 草稿库陈旧对账（P-20261003-152）：文件已删除的草稿清账 + 汇总提示
   *  （useOpenFiles.reconcileStaleDrafts 收口，项目不可达整段跳过防误清）。
   *  项目恢复落地后调用；后台对账不 await，不阻塞余下恢复步骤 */
  reconcileStaleDrafts: () => Promise<void>
  ensureInstancesFresh: () => Promise<unknown>
  selectInstance: (id: string) => Promise<unknown>
  /** 挂载期捕获的起始实例 id（在任何 await 之前捕获，避免竞态影响切换判定） */
  startInstanceId: () => string
  currentProjectId: () => string
  hasProject: (id: string) => boolean
  setCurrentProject: (id: string) => void
  consumePendingProjectId: () => string | null
  consumeExplicitSelectId: () => string | null
  /** 消费「进入项目时侧栏兜底开文件面板」标志（终端会话管理打开项目语义） */
  consumePendingSideFilesOpen?: () => boolean
  /** 消费「bottomTab 以跳转意图为准」标志（审批/提问卡查看发起会话跳转语义）：
   * 有值时本次布局恢复不覆盖 bottomTab 且强制打开底部面板 */
  consumePendingBottomTab?: () => BottomTab | null
  /** 消费侧栏视图跳转意图（P-20261005-223 navigate {view:'changes'}）：有值时
   * 本次布局恢复不覆盖 sideView/showSidePanel，按意图落位并保证侧栏可见 */
  consumePendingSideView?: () => SideView | null
  /** 项目仪表盘默认落点（P-20261005-224）：读取偏好 + 申请落位。落位闭包由宿主
   *  提供（需裁「其他主区视图在场/文件深链挂起」等让位条件，见 useLayoutShell） */
  getDashboardLanding?: () => Promise<boolean>
  openDashboardLanding?: () => void
  fetchProjects: () => Promise<unknown>
  fetchAllAheadBehind: () => Promise<void>
  fetchBuildInfo: () => void
  fetchStatus: (projectId: string) => void
  openFileByPath: (path: string) => Promise<void>
  openFilesCount: () => number
  setActiveFileIndex: (i: number) => void
  revealExpandedDirs: (dirs: string[]) => void
  restoreGitPanel: (collapsed: string[], branch: string) => void
  restoreTerminalTab: (tabId: string) => void
}

export function useLayoutBootstrap(deps: BootstrapDeps) {
  // 挂载时恢复持久化 UI 状态（布局/实例选择/项目维度）。
  // 返回 false = 实例切换 remount 提前结束（宿主应跳过后续初始化，如 fetchStatus）
  async function bootstrap(): Promise<boolean> {
    // 先取持久化 UI 状态：若记录的是远程实例，本机项目/ahead-behind/buildInfo
    // 全部白拉，所以实例恢复必须先于本机数据拉取
    let state: UIStateData | null = null
    try {
      state = await deps.getInstanceState()
    } catch { /* silent */ }

    // 恢复远程控制台视图可见性：上次会话开着远程视图且有可恢复的终端时，
    // 刷新后直接回到该视图（仅挂载期设置——视图组件是懒挂载的，自身无法完成自举）
    if (state?.remoteConsole?.open && (state.remoteConsole.tabs?.length || 0) > 0) {
      deps.showRemoteConsole.value = true
    }

    // 布局命名空间（面板开合/尺寸/tab）与项目、实例均无依赖，紧随状态获取
    // 立即恢复——若排在下方 fetchProjects/fetchAllAheadBehind 慢链之后，负载
    // 下恢复会晚到数秒，晚到的恢复会把用户/用例在此窗口内的面板交互原样
    // 覆盖（重开收掉的面板、把导入的新布局写回旧值），且经 auto-save 基线
    // diff 把内存旧值回写服务端。与上方 remoteConsole 恢复同款「仅挂载期
    // 设置」语义；实例切换 remount 场景下这次应用是瞬态（新 Layout 重新引导）
    try {
      restoreLayoutOnly(state)
    } catch { /* silent */ }

    // 恢复实例选择：真实切换成功（本组件即将 remount 销毁）才 return。
    // 注意不能用"currentInstanceId === state.instanceId"判断——remount 后的新 Layout
    // 挂载时实例 id 已是目标值，会误跳过全部初始化（smart-stay / 布局恢复 / ahead-behind 全失效）
    if (state?.instanceId && state.instanceId !== 'local') {
      // 实例列表可能尚未加载完成（App.vue 的初始 fetchInstances 是异步的），
      // 未加载时先拉取，否则 selectInstance 找不到实例会静默失败
      await deps.ensureInstancesFresh()
      await deps.selectInstance(state.instanceId)
      if (deps.startInstanceId() !== state.instanceId) return false
    }

    await deps.fetchProjects().then(() => deps.fetchAllAheadBehind()).catch(() => { /* 拦截器已提示 */ })
    deps.fetchBuildInfo()

    // smart-stay：实例切换时匹配到的等价项目（selectInstance 写入，读清原子化），
    // 优先于 uiState 恢复——等价项目与 uiState 记录的项目可能不同
    const pendingId = deps.consumePendingProjectId()
    let appliedPending = false
    if (pendingId && deps.hasProject(pendingId)) {
      deps.setCurrentProject(pendingId)
      appliedPending = true
    }

    // 用户显式选择优先于 uiState 恢复：从首页点击进入的项目（enterProject 打标）
    // 不被上次会话 auto-save 的历史 projectId 覆盖；标记无论是否生效都消费掉，
    // 防残留到下次挂载（如紧随的实例切换 remount）
    const explicitId = deps.consumeExplicitSelectId()
    if (!appliedPending && explicitId && deps.hasProject(explicitId)) {
      appliedPending = true
    }

    // 项目仪表盘默认落点（P-20261005-224）：偏好开启且本次是「显式进入项目」
    // （首页 enterProject / 实例切换 smart-stay）时主区先落仪表盘——「进项目先看
    // 状态再动手」。刷新恢复/页内链路进项目不带显式标记，维持上次工作形态；
    // 让位条件（其他主区视图恢复在场/文件深链挂起）在宿主闭包内裁决
    if (appliedPending && deps.getDashboardLanding && deps.openDashboardLanding) {
      try {
        if (await deps.getDashboardLanding()) deps.openDashboardLanding()
      } catch { /* silent：落点是增益不是关键路径 */ }
    }

    try {
      if (state) {
        await restoreLayoutState(state, appliedPending)
      }
    } catch { /* silent */ }

    // 侧栏兜底（终端会话管理「打开项目」语义）：布局恢复后若侧栏仍未打开
    // （上次什么都没开 / 从未进入过该项目），打开项目文件面板
    if (deps.consumePendingSideFilesOpen?.() && !deps.showSidePanel.value) {
      deps.showSidePanel.value = true
      deps.sideView.value = 'files'
    }

    // 刷新变更状态供状态栏使用
    const pid = deps.currentProjectId()
    if (pid) deps.fetchStatus(pid)
    return true
  }

  /** 布局命名空间恢复（面板开合/尺寸/tab/最大化）：无项目依赖，引导早期调用
   *  （见 bootstrap 内注记）。pendingBottomTab/pendingSideView 的消费也在此——
   *  跳转意图在挂载前打标，早期消费不改变其「本次恢复不覆盖对应面板态」语义 */
  function restoreLayoutOnly(state: UIStateData | null): void {
    // 布局锁定（P-20261003-180）：与布局几何同点恢复（同一份快照，零额外请求）。
    // 放在 layout 早退之前——全新实例可能无 layout 键但有 layoutLock
    useLayoutLockStore().restoreFromState(state)
    // 活动栏手动序（P-20261003-252）：同点同语义恢复（railOrder 独立命名空间，
    // 可存在于无 layout 键的记录上；形状防御与只改内存不回写都在实现内闭环）
    restoreRailTopOrder(state)
    // 侧栏视图跳转意图（P-20261005-223 navigate {view:'changes'}）：同样在 layout
    // 早退之前消费——无 layout 键的全新实例也要落跳转意图（与 layoutLock 同点理由）
    const pendingSide = deps.consumePendingSideView?.() ?? null
    if (pendingSide) {
      deps.sideView.value = pendingSide
      deps.showSidePanel.value = true
    }
    if (!state?.layout) return
    if (state.layout.sidePanelWidth) deps.sidePanelWidth.value = state.layout.sidePanelWidth
    if (state.layout.bottomPanelHeight) deps.bottomPanelHeight.value = state.layout.bottomPanelHeight
    if (!pendingSide && state.layout.showSidePanel !== undefined) deps.showSidePanel.value = state.layout.showSidePanel
    // 跳转意图优先（审批/提问卡「查看发起会话」）：pending 在设 bottomTab 之后、
    // 挂载期恢复落地之前打标，消费即本次恢复不覆盖 bottomTab 并保证面板可见——
    // 否则上次会话保存的 tab 把终端 tab 翻走，TerminalView 随 tab 卸载、
    // 待激活事件落空、跳转目标不渲染
    const pendingTab = deps.consumePendingBottomTab?.() ?? null
    if (pendingTab) deps.showBottomPanel.value = true
    if (state.layout.showBottomPanel !== undefined && !pendingTab) deps.showBottomPanel.value = state.layout.showBottomPanel
    // sideView 归一（P-20261108-2）：'notes' 随笔记迁出侧栏退役——旧存档残值/未知值
    // 回落 'files'（下方 bottomTab 'commit'→'git' 同款），防 SidePanel 分发链落末位
    // v-else 渲染提交面板（与活动栏高亮错位的死分支）
    if (!pendingSide && state.layout.sideView) deps.sideView.value = normalizeSideView(state.layout.sideView)
    // bottomTab='commit'（底部提交 tab 已移除，与左侧入口重复）：归一为 'git'
    const savedBottomTab = state.layout.bottomTab as string | undefined
    deps.bottomTab.value = pendingTab ??
      (savedBottomTab === 'git' || savedBottomTab === 'terminal' || savedBottomTab === 'console' || savedBottomTab === 'preview' || savedBottomTab === 'problems'
        ? savedBottomTab
        : 'git')
    // commitLocation='bottom' 形态随底部提交 tab 一并退役：恒归一侧栏
    if (state.layout.commitLocation) deps.commitLocation.value = 'sidebar'
    // 持久化最大化状态：刷新/重新进入项目时恢复
    if (state.layout.bottomPanelMaximized !== undefined) deps.bottomPanelMaximized.value = !!state.layout.bottomPanelMaximized
    if (state.layout.bottomPanelEditorMaximized !== undefined) deps.bottomPanelEditorMaximized.value = !!state.layout.bottomPanelEditorMaximized
  }

  async function restoreLayoutState(state: UIStateData, appliedPending: boolean): Promise<void> {
    // 布局命名空间已在引导早期由 restoreLayoutOnly 恢复（bootstrap 内首个 await
    // 之后立即应用，不再等实例/项目慢链）；此处只剩项目维度恢复
    // 项目维度恢复：smart-stay 生效时跳过整段（editor/fileTree/gitPanel/terminal
    // 属于 uiState 记录的上次项目，与等价项目不匹配，恢复会导致编辑器打开错误文件）
    if (appliedPending) return
    if (state.projectId && deps.hasProject(state.projectId)) {
      deps.setCurrentProject(state.projectId)
    }
    // 项目维度状态守卫：editor/fileTree/gitPanel/terminal 都属于 state.projectId
    // 那个项目的快照。项目未匹配恢复（id 不在当前实例列表，如实例切换后的
    // 串写残留）时套用会把旧项目的分支/文件套到当前项目上——典型症状是
    // 旧项目的 master 分支被带到无 master 的项目，git log 500 报"系统异常"
    const projectRestored = !!state.projectId && state.projectId === deps.currentProjectId()
    // 主组恢复：占位在 openFileInto 同步前缀入列（顺序即持久化序），内容异步
    // 装载——先记下全部 opens，分屏恢复等它们落地后再串行开（P-20261002-94
    // 串行约束：主组占位先行使共享对象复用生效，避免双组并发建 model 竞态）
    const mainOpens: Promise<void>[] = []
    if (projectRestored && state.editor?.openFiles?.length) {
      for (const path of state.editor.openFiles) {
        mainOpens.push(deps.openFileByPath(path))
      }
      if (state.editor.activeIndex >= 0 && state.editor.activeIndex < deps.openFilesCount()) {
        deps.setActiveFileIndex(state.editor.activeIndex)
      }
    }
    // 恢复分屏开合：上次分屏开着时刷新/重进恢复分屏布局（分屏组文件清单随后
    // 按 splitFiles 恢复——P-20261002-94；无清单时维持空态占位可一键关闭）
    if (projectRestored && state.editor?.splitOpen !== undefined) {
      deps.splitOpen.value = !!state.editor.splitOpen
    }
    // 恢复分屏方向（P-20261005-230）：只收枚举合法值，缺省/脏值不写（内存缺省
    // 横向——旧记录无 splitDirection 时恢复行为与历史完全一致）
    const savedDir = state.editor?.splitDirection
    if (projectRestored && (savedDir === 'horizontal' || savedDir === 'vertical')) {
      deps.splitDirection.value = savedDir
    }
    // 主组 opens 全部落地（占位同步已入列，此处等内容装载收敛）后才串行开分屏
    if (mainOpens.length > 0) await Promise.allSettled(mainOpens)
    // 恢复分屏组文件清单（P-20261002-94）：开合为开且清单非空才参与（清单形状
    // 防御在采集端；此处数组性兜底）；已删文件降级跳过 + 汇总 toast 在实现内闭环
    if (projectRestored && state.editor?.splitOpen && state.editor.splitFiles?.length) {
      await deps.restoreSplitFiles(state.editor.splitFiles, state.editor.splitActiveFile || '')
    }
    // 恢复 untitled 草稿（P-20261003-97 草稿热退出）：主组/分屏恢复落地后重建
    // 草稿 tab + toast。无记录时零副作用（IndexedDB 读空即返回）
    if (projectRestored) await deps.restoreUntitledDrafts()
    // 草稿库陈旧对账（P-20261003-152）：文件已删的草稿清账（后台对账，不阻塞
    // 余下恢复步骤——探测是数个 silent 请求，与文件树/git 面板恢复无先后依赖）
    if (projectRestored) void deps.reconcileStaleDrafts()
    // 恢复文件树展开目录
    if (projectRestored && state.fileTree?.expandedDirs?.length) {
      deps.revealExpandedDirs(state.fileTree.expandedDirs)
    }
    // 恢复 Git 面板状态
    if (projectRestored && state.gitPanel) {
      deps.restoreGitPanel(state.gitPanel.collapsedSections || [], state.gitPanel.selectedBranch || '')
    }
    // 恢复终端活跃 tab
    if (projectRestored && state.terminal?.activeTabId) {
      deps.restoreTerminalTab(state.terminal.activeTabId)
    }
  }

  // 锁定/解锁联动：锁定时关闭所有可能干扰 LockScreenOverlay 焦点的弹窗
  //（NModal 的 focus trap 会把键盘焦点困在 modal 内，导致密码框 focus 失效），
  // 解锁后重拉项目列表
  function bindLockWatch(
    isLocked: Ref<boolean>,
    closeAllDialogs: () => void,
    refetchProjects: () => void,
  ): void {
    watch(isLocked, (locked) => {
      if (locked) {
        closeAllDialogs()
      } else {
        refetchProjects()
      }
    })
  }

  // 通知中心 pendingAction 跳转：跨项目 + 终端/面板/URL/预览端口/监听降级/部署修复/实例切换/复盘报告触发
  // immediate 回放（P-20261007-15）：路由桥接链（通知 store handleClick 非 project
  // 路由先 push /project）落进项目页时 pendingAction 已是 store 存量，靠 immediate
  // 在绑定时刻即回放，动作不再丢失。存量 null 早退零副作用，页内路径行为不变。
  // 回放正确性的时序前提：绑定必须发生在 bootstrap 恢复完成之后（调用方
  // useLayoutShell 保证）——若在 setup 期挂 watch，回放动作会被随后的布局恢复
  // （restoreLayoutOnly 用持久化值覆盖 bottomTab/面板开合）翻回，动作等于没生效；
  // 恢复先落地、回放动作后到者胜，且 fetchProjects 已就位使跨项目 switchProject
  // 判定（hasProject）不落空
  function bindPendingActionWatch(
    pendingAction: Ref<{ projectId?: string; action?: string; actionPayload?: unknown; title?: string; body?: string } | null>,
    consumeAction: () => void,
    handlers: {
      switchProject: (id: string) => boolean | Promise<boolean>
      openTerminalTab: (sessionId: string) => void
      togglePanel: (panel: string) => void
      openUrl: (url: string) => void
      openPreviewPort: (port: number) => void
      watchFallbackToggle: () => void
      agentFix: (n: { actionPayload?: unknown; title?: string; body?: string }) => void
      switchInstance: (id: string) => void
      /** 失败会话「复盘报告」（P-20261004-60）：payload=会话 id，打开复盘弹层 */
      postmortem: (sessionId: string) => void
      monitorFleet: (batchId: string) => void
      /** 定时任务发起失败「一键重试」（P-20261006-14）：payload=JSON {cronId,slot}，
       *  调既有试跑端点重新发起（发起/反馈/面板刷新联动收口 useCronRetry） */
      cronRetry: (payload: string) => void
      /** 快投递「交给当前会话」（P-20261006-51）：payload=quickdrop:<id>，
       *  broadcast-write 写入最近激活会话（编排全在 useQuickdrop） */
      quickdropForward: (n: { actionPayload?: unknown }) => void
      /** 快投递「新会话处理」（P-20261006-51）：payload=quickdrop:<id>，
       *  createAgent 以投递内容为 launchArgs 种子（useQuickdrop 消费链） */
      quickdropNewSession: (n: { secondActionPayload?: unknown; actionPayload?: unknown }) => void
      /** 协作素材「交给当前会话」（P-20261024-1）：payload=shdrop:<token>:<id>，
       *  绝对路径贴进最近激活会话 + 标已消费（useShareDrop 消费链） */
      shdropForward: (n: { actionPayload?: unknown }) => void
      /** 协作素材「新会话处理」（P-20261024-1）：payload=shdrop:<token>:<id>，
       *  createAgent 以素材绝对路径为 launchArgs 种子（useShareDrop 消费链） */
      shdropNewSession: (n: { secondActionPayload?: unknown; actionPayload?: unknown }) => void
      /** 直通输入持权卡「收回」（P-20261024-1）：payload=token，一键收回访客
       *  输入权（幂等；会话只读闸同步解除） */
      shdirectRevoke: (n: { actionPayload?: unknown }) => void
      /** autoStash「恢复」（P-20261006-48）：payload=JSON {projectId,branch,message}，
       *  重定位条目后走既有 stash pop 链（收口 useStashRecover） */
      stashRecover: (payload: string) => void
      /** 敏感文件工作台外写入（P-20261005-15）：payload=项目相对路径，编辑器打开 */
      openFile: (path: string) => void

    },
  ): void {
    watch(pendingAction, async (n) => {
      if (!n) return
      try {
        // 1. 跨项目：先切到目标项目；切换守卫取消（未保存草稿确认选
        // 「取消」，P-20261003-105）→ 跳转意图放弃（finally 照常消费）
        if (n.projectId) {
          if ((await handlers.switchProject(n.projectId)) === false) return
        }
        // 2. 等 currentProjectId 生效
        await nextTick()
        // 3. 按 action 类型触发
        if (n.action === 'terminal' && n.actionPayload) {
          handlers.openTerminalTab(String(n.actionPayload))
        } else if (n.action === 'panel' && n.actionPayload) {
          handlers.togglePanel(String(n.actionPayload))
        } else if (n.action === 'url' && n.actionPayload) {
          handlers.openUrl(String(n.actionPayload))
        } else if (n.action === 'preview' && n.actionPayload) {
          // 预览端口直达（P-20261002-70）：payload 为端口号字符串
          const port = Number(n.actionPayload)
          if (Number.isInteger(port)) handlers.openPreviewPort(port)
        } else if (n.action === 'watch-fallback') {
          // 文件监听降级兜底手动开关（P-20261003-140）：payload 恒 toggle——
          // 翻转语义对陈旧历史通知也成立（开关后状态随响应，反馈在 handler toast）
          handlers.watchFallbackToggle()
        } else if (n.action === 'agent-fix') {
          // 部署失败「交给智能体修复」（P-20261003-289）：payload=部署任务 id，
          // title/body 一并携带供补拉失效时降级组 prompt
          handlers.agentFix(n)
        } else if (n.action === 'switch-instance' && n.actionPayload) {
          // 联邦派发通知跳该实例（P-20261004-101）：payload=注册实例 id，
          // 走实例切换链既有（selectInstance 幂等守卫对同 id/未知 id 无副作用）
          handlers.switchInstance(String(n.actionPayload))
        } else if (n.action === 'postmortem' && n.actionPayload) {
          // 失败会话「复盘报告」（P-20261004-60）：payload=会话 id，打开复盘
          // 弹层（报告+一键转存问询）；陈旧通知对已清理会话由弹层内 404
          // 失败态如实呈现
          handlers.postmortem(String(n.actionPayload))
        } else if (n.action === 'monitor-fleet' && n.actionPayload) {
          // 编队完成通知直达值班大屏聚合卡（P-20261005-145）：payload=编队
          // batchId，query 携带供大屏展开+高亮定位（MonitorView 消费端）
          handlers.monitorFleet(String(n.actionPayload))
        } else if (n.action === 'cron-retry' && n.actionPayload) {
          // 定时任务发起失败「一键重试」（P-20261006-14）：payload=JSON
          // {cronId,slot}——调既有试跑端点按当下重新发起（RunNow 语义，不回补
          // 历史槽点；陈旧通知对已删除任务由端点 404 在 handler 就地报错）。
          // 重试再失败经服务端再入账失败通知，人工再点不自动递归
          handlers.cronRetry(String(n.actionPayload))
        } else if (n.action === 'quickdrop-active') {
          // 快投递「交给当前会话」（P-20261006-51）：payload=quickdrop:<id>，
          // broadcast-write 写入最近激活会话（取数/回执在 useQuickdrop 收口）
          handlers.quickdropForward(n)
        } else if (n.action === 'quickdrop-new') {
          // 快投递「新会话处理」经主槽回放（handleSecondAction 换槽复用同链，
          // P-20261005-150 分工）：createAgent 以投递内容为 launchArgs 种子
          handlers.quickdropNewSession(n)
        } else if (n.action === 'shdrop-active') {
          // 协作素材「交给当前会话」（P-20261024-1）：payload=shdrop:<token>:<id>，
          // 绝对路径贴进最近激活会话（取数/回执在 useShareDrop 收口）
          handlers.shdropForward(n)
        } else if (n.action === 'shdrop-new') {
          // 协作素材「新会话处理」经主槽回放（handleSecondAction 换槽复用同链）：
          // createAgent 以素材绝对路径为 launchArgs 种子
          handlers.shdropNewSession(n)
        } else if (n.action === 'shdirect-revoke') {
          // 直通输入持权卡「收回」（P-20261024-1）：payload=token——回收在
          // useLayoutShell 收口（revokeDirect + 徽标对账）
          handlers.shdirectRevoke(n)
        } else if (n.action === 'stash-recover' && n.actionPayload) {
          // autoStash「恢复」（P-20261006-48）：payload=JSON {projectId,branch,
          // message}——按双键重定位条目后走既有 stash pop 链（收口 useStashRecover；
          // pop 冲突条目保留走 stashKept 同款 warning，处置出口在 stash 面板）
          handlers.stashRecover(String(n.actionPayload))
        } else if (n.action === 'file' && n.actionPayload) {
          // 敏感文件工作台外写入（P-20261005-15）：payload=项目相对路径，
          // 走搜索打开链在编辑器打开（缓冲已随 file.changed 自动重载）
          handlers.openFile(String(n.actionPayload))
        } else if (n.action === 'sync-landed') {
          // 多实例同步落位完成（P-20261023-1）：广播 OPS_FILES_EXTERNAL_CHANGE
          // 让已打开编辑器自动重读（detail.paths 空 = 全部干净打开文件重读——
          // 落位可影响任意项目，语义与「广播方不知道具体路径」一致）
          window.dispatchEvent(new CustomEvent(OPS_FILES_EXTERNAL_CHANGE))
        } else if (n.action === 'open-sync-center') {
          // 定时同步冲突/完成通知直达同步中心（P-20261023-1 方案⑤）
          handlers.togglePanel('sync')
        }
      } finally {
        consumeAction()
      }
    }, { immediate: true })
  }

  return { bootstrap, bindLockWatch, bindPendingActionWatch }
}
