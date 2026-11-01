import { provide, nextTick } from 'vue'
import type { Ref } from 'vue'
import { useNotificationStore } from '../stores/notification'

/**
 * Layout 对子组件的 provide 装配（自 Layout.vue 抽出）：
 * pushNotification 兼容层 + TopBar 共享状态 + 文件树定位/打开文件。
 */
export function useLayoutBridge(options: {
  projectName: () => string | undefined
  projectId: () => string
  showBottomPanel: Ref<boolean>
  bottomTab: Ref<string>
  sideView: Ref<string>
  showSidePanel: Ref<boolean>
  aheadBehindMap: Ref<Record<string, { ahead: number; behind: number }>>
  remoteLoading: Ref<boolean>
  fetchAllAheadBehind: () => Promise<void>
  handleFetch: () => Promise<void>
  handlePull: () => Promise<void>
  handleCreatePr: () => Promise<void>
  /** 编辑器活跃 tab 路径（''=无活跃/欢迎页）：useOpenFiles 是 per-call 单例、
   *  生产实例只在 useLayoutShell，下游组件（GitPanel 挂载期外部变更感知
   *  P-20261004-39）订阅活跃 tab 变化只能经本桥共享同一响应式源 */
  activeEditorPath: Ref<string>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sidePanelRef: () => any
  openFile: (f: { path: string; name: string }) => void
  /** 目录级终端直达（P-20261005-192）：面包屑「在此目录打开终端」菜单项经桥
   *  上抛 useLayoutViews.openInTerminal（真实创建链，见彼处注记）。可选——
   *  单测/独立渲染 Breadcrumb 时注入缺省即降级隐藏该菜单项 */
  openTerminalInDir?: (relDir: string) => void
  /** 舰队发起直达（P-20261005-152）：agent 侧栏「舰队发起」钮经桥翻
   *  useLayoutViews.showFleetBulkAgent（弹层宿主在 Layout，palette 入口同一条）。
   *  可选——单测/独立渲染侧栏时注入缺省即降级隐藏该按钮（openTerminalInDir 同款） */
  openFleetBulkAgent?: () => void
}) {
  const { projectName, projectId, showBottomPanel, bottomTab, sideView, showSidePanel, sidePanelRef, openFile, openTerminalInDir, openFleetBulkAgent } = options
  const notificationStore = useNotificationStore()

  // 兼容 GitPanel 等老代码的 inject('pushNotification')
  // 新业务直接 useNotificationStore().add()，老调用透明走全局 store
  // action/actionPayload（P-20261003-202 pull 摘要通知跳变更面板起传入）：透传全局
  // store 走 pendingAction 跳转链，未传字段 undefined 序列化时丢弃不破坏旧调用
  provide('pushNotification', (n: { type: 'success' | 'warning' | 'error' | 'info'; title: string; body?: string; category?: string; action?: string; actionPayload?: string }) => {
    notificationStore.add({
      type: n.type,
      category: n.category || 'system',
      title: n.title,
      body: n.body,
      projectId: projectId() || undefined,
      projectName: projectName(),
      action: n.action,
      actionPayload: n.actionPayload,
    })
  })

  // 给 TopBar 注入共享状态
  provide('sharedAheadBehindMap', options.aheadBehindMap)
  provide('sharedRemoteLoading', options.remoteLoading)
  provide('sharedFetchAllAheadBehind', options.fetchAllAheadBehind)
  provide('sharedActiveEditorPath', options.activeEditorPath)
  provide('showGitPanel', () => {
    showBottomPanel.value = true
    bottomTab.value = 'git'
  })
  // TopBar 冲突解决：注入 composable 的远程操作函数，替代内联实现
  provide('sharedHandleFetch', options.handleFetch)
  provide('sharedHandlePull', options.handlePull)
  provide('sharedHandleCreatePr', options.handleCreatePr)

  // 提供文件树定位方法给子组件
  provide('revealInFileTree', (filePath: string) => {
    sideView.value = 'files'
    showSidePanel.value = true
    nextTick(() => sidePanelRef()?.fileTreeRef?.revealFile(filePath))
  })
  provide('openFileInEditor', (filePath: string) => {
    const name = filePath.split('/').pop() || filePath
    openFile({ path: filePath, name })
  })
  // 目录级终端直达（P-20261005-192）：面包屑右键菜单同项，动作链在宿主
  //（useLayoutViews.openInTerminal → TerminalView.createTerminal(dir)），
  // 未提供时面包屑侧自行隐藏菜单项（openTerminalInDir 注入缺省语义）
  if (openTerminalInDir) provide('openTerminalInDir', openTerminalInDir)
  // 舰队发起直达（P-20261005-152）：agent 侧栏「舰队发起」钮上抛翻弹层，
  // 未提供时侧栏自行隐藏按钮（注入缺省语义同 openTerminalInDir）
  if (openFleetBulkAgent) provide('openFleetBulkAgent', openFleetBulkAgent)
}
