<script setup lang="ts">
import { onMounted, ref, watch, nextTick, onBeforeUnmount, computed } from 'vue'
import { useMessage } from 'naive-ui'
import HistoryPanel from '../../components/terminal/HistoryPanel.vue'
import ClaudeSessionPicker from '../../components/claude/ClaudeSessionPicker.vue'
import SnippetPicker from '../../components/terminal/SnippetPicker.vue'
import RunbookPanel from '../../components/terminal/RunbookPanel.vue'
import { useProjectStore } from '../../stores/project'
import { useInstanceStore } from '../../stores/instance'
import { useChangesStore } from '../../stores/changes'
import { useFontStore } from '../../stores/font'
import { useKeymapStore, comboVariants, matchLayoutCombo, type KeymapAction } from '../../stores/keymap'
import { useTerminalStore } from '../../stores/terminal'
import { useLockStore } from '../../stores/lock'
import { useNotificationStore } from '../../stores/notification'
import { useI18n } from '../../composables/useI18n'
import { usePanelLayout } from '../../composables/usePanelLayout'
import { useTerminalInstances } from '../../composables/useTerminalInstances'
import { useTerminalContextMenu } from '../../composables/useTerminalContextMenu'
import { useSnippetShare } from '../../composables/useSnippetShare'
import { useEditorAskAgent } from '../../composables/useEditorAskAgent'
import { useClipRelay } from '../../composables/useClipRelay'
import { useTerminalTabs, type TermTab } from '../../composables/useTerminalTabs'
import { useTerminalSplit } from '../../composables/useTerminalSplit'
import { useTerminalTabMenu } from '../../composables/useTerminalTabMenu'
import { useTerminalFloat } from '../../composables/useTerminalFloat'
import { useTerminalBroadcast } from '../../composables/useTerminalBroadcast'
import { useSessionOverviewState } from '../../composables/useSessionOverviewState'
import { useTerminalReconnect } from '../../composables/useTerminalReconnect'
import { useTerminalTabSync } from '../../composables/useTerminalTabSync'
import { useTerminalSessionsStore } from '../../stores/terminal-sessions'
import { useApprovalsStore } from '../../stores/approvals'
import { useRunbookDraftStore } from '../../stores/runbookDraft'
import { OPS_ACTIVATE_TERMINAL } from '../../utils/opsEvents'
import { useTerminalSettings } from '../../composables/useTerminalSettings'
import { useShareDialog } from '../../composables/useShareDialog'
import { fetchWithEgressGate } from '../../composables/useEgressGate'
import { useTerminalLiveShares } from '../../composables/useTerminalLiveShares'
import { useSensitiveMarkHint } from '../../composables/useSensitiveMarkHint'
import { useTerminalToolbarActions } from '../../composables/useTerminalToolbarActions'
import { useTerminalTreeLocate } from '../../composables/useTerminalTreeLocate'
import { useTerminalOscBridge } from '../../composables/useTerminalOscBridge'
import { useRunbookRunner, type RunbookRunRequest } from '../../composables/useRunbookRunner'
import type { OscEvent } from '../../composables/useTerminalSession'
import { gateTerminalInput } from '../../composables/useTerminalDangerGate'
import { getFailedCommandRecord, extractFailedCommandOutput } from '../../composables/terminalCommandMarks'
import {
  isLineBookmarked,
  toggleBookmarkAtLine,
} from '../../composables/terminalBookmarks'
import { terminalApi, getTerminalWsUrl } from '../../api/client'
import { shareApi } from '../../api/domains/share'
import { recordingApi } from '../../api/domains/recording'
import { matchShortcut } from '../../utils/shortcut'
import { copyText } from '../../utils/clipboard'
import { exportFileName } from '../../utils/exportFileName'
import { useTerminalThemeStore } from '../../stores/terminal-theme'
import { rememberActiveTab, recallActiveTab } from '../../utils/terminalActiveTab'
import { safeStorage } from '../../utils/storage'
import TerminalPane from '../../components/terminal/TerminalPane.vue'
import TerminalTabbar from '../../components/terminal/TerminalTabbar.vue'
import TerminalEmptyState from '../../components/terminal/TerminalEmptyState.vue'
import TerminalPanesArea from '../../components/terminal/TerminalPanesArea.vue'
import TerminalBroadcastBar from '../../components/terminal/TerminalBroadcastBar.vue'
import TerminalBroadcastResultPanel from '../../components/terminal/TerminalBroadcastResultPanel.vue'
import TerminalCloseConfirm from '../../components/terminal/TerminalCloseConfirm.vue'
import TerminalPaneCloseConfirm from '../../components/terminal/TerminalPaneCloseConfirm.vue'
import TerminalTabContextMenu from '../../components/terminal/TerminalTabContextMenu.vue'
import TerminalWrapUpCard from '../../components/terminal/TerminalWrapUpCard.vue'
import TerminalPaneContextMenu from '../../components/terminal/TerminalPaneContextMenu.vue'
import TerminalBookmarkPanel from '../../components/terminal/TerminalBookmarkPanel.vue'
import TerminalCompareOutputModal from '../../components/terminal/TerminalCompareOutputModal.vue'

const projectStore = useProjectStore()
const instanceStore = useInstanceStore()
const changesStore = useChangesStore()
const fontStore = useFontStore()
// 终端域键位生效表（P-20261003-111）：doc 级动作（历史/片段/字号）按键现场读取，
// 设置改绑即时生效；terminalDocActive 向布局链声明本监听在场（让位判定用）
const keymap = useKeymapStore()
const terminalStore = useTerminalStore()
const lockStore = useLockStore()
const notificationStore = useNotificationStore()
const terminalThemeStore = useTerminalThemeStore()
// 关闭确认的 pending 审批警示源（P-20261003-275）：pendingSessionIds 与终端
// 会话 id 同域（P-198 静默标同款归属判定）
const approvalsStore = useApprovalsStore()
// 终端主题 → document 副作用已上移 App.vue 全局应用（原此处 useTerminalTheme()）
const { t } = useI18n()
// 底部面板编辑器区域最大化（与 BottomPanel 共享状态）：
// 终端在底部面板内，编辑器区域最大化由 BottomPanel 统一控制
const {
  maximizeBottomPanelEditor, bottomPanelEditorMaximized, maximizeTerminal, terminalMaximized,
  // pane 临时最大化（P-20261004-64）：状态在 usePanelLayout（Esc 退栈链同源），
  // 本视图只做校验转发与陈旧态清理
  terminalPaneMaximized, toggleTerminalPaneMaximized,
} = usePanelLayout()

// 终端自身最大化：共享 terminalMaximized（Layout ESC 可统一还原）
const maximized = terminalMaximized

// ============== 共享 state（被多个 composable 引用）==============
const tabs = ref<TermTab[]>([])
const activeTabId = ref('')
const getActiveTabId = () => activeTabId.value

// ============== Settings 相关配置（onMounted 时经 useTerminalSettings 拉取）==============
// 生效字号（持久 sizes × 演示模式缩放，P-20261002-45）：投屏放大不落盘，
// 工具栏字号指示随演示态如实显示当前值
const fontSize = computed(() => fontStore.terminalFontSize)
// 字号变化时给 .term-font-value 加一次性滚动动画 class
const fontRolling = ref(false)
let fontRollTimer: ReturnType<typeof setTimeout> | null = null
watch(fontSize, () => {
  fontRolling.value = true
  if (fontRollTimer) clearTimeout(fontRollTimer)
  fontRollTimer = setTimeout(() => { fontRolling.value = false }, 200)
})
const { currentScrollbackLines, historyEnabled, effectiveBackend, fetchSettings } = useTerminalSettings({
  hydrate: (data) => terminalThemeStore.hydrate(data),
})

// ============== Composable 装配 ==============
// 1. 实例层（模块级 Map + 字体/主题 watch）——TerminalPane 创建的实例登记进同一份 Map，
//    selectTab / fitAllPanes / toggleMaximize 等按 id 查找的逻辑保持零改动
const instancesApi = useTerminalInstances()

// 各 pane 组件引用（按 paneId 索引）：右键菜单 / 工具栏 / AI 插入等宿主动作经此下发
type TerminalPaneInstance = InstanceType<typeof TerminalPane>
const paneRefs = new Map<string, TerminalPaneInstance>()
function setPaneRef(paneId: string, el: unknown): void {
  if (el) {
    paneRefs.set(paneId, el as TerminalPaneInstance)
  } else {
    paneRefs.delete(paneId)
  }
}

// secondary pane 的 :ref 构造器：必须在渲染期就把 paneId 捕获进闭包。
// split 收起时 tab.panes 先被清空、v-if 再卸载副 pane，ref(null) 回调若在调用时
// 才求值 tab.panes![1] 会读到 undefined[1] 直接抛 TypeError（旧代码同款晚绑定缺陷）
function secondaryPaneRefFn(tab: TermTab): (el: unknown) => void {
  const pid = tab.panes?.[1]
  return (el) => {
    if (pid) setPaneRef(pid, el)
  }
}

// 粘贴上传策略：项目终端 paste-image 端点（供 TerminalPane 注入 useTerminalClipboard）。
// kind=image 截图压缩链 / kind=file 白名单文件链（P-20261024-2）——同端点按字段分派
async function uploadPaste(file: File, kind: 'image' | 'file'): Promise<string | null> {
  const res = kind === 'image'
    ? await terminalApi.uploadPasteImage(file)
    : await terminalApi.uploadPasteFile(file)
  return (res as { data?: { path?: string } } | null)?.data?.path ?? null
}

// PTY resize 上报：项目终端 resize 端点（供 TerminalPane 注入 useTerminalSession）
// silent 控制 Console 静默（onResize 抖动路径静默，onopen 初始 resize 正常记录）
function resizeTerminal(id: string, rows: number, cols: number, silent?: boolean): void {
  terminalApi.resize(id, rows, cols, silent ? { silent: true } : undefined).catch(() => {})
}

// 显示失步权威重绘：tmux 后端执行 refresh-client 以服务端网格重发整屏，
// native 后端服务端 no-op。pane 重新可见/宿主 fit 后由 TerminalPane 回调
function redrawTerminal(id: string): void {
  terminalApi.redraw(id).catch(() => {})
}

// refit 指定 pane（浮动窗几何变化 / 收回面板后由 PanesArea/宿主调用）。
// 深度刷新：收回面板正是隐藏期重放后的重新可见时刻，滚动区需强制重同步
// （浮动窗几何变化时行列实际会变，deep 多做的一次抖动终态不变，无害）
function fitPane(paneId: string): void {
  paneRefs.get(paneId)?.fit(true)
}

// 2. tabs（连接由 TerminalPane 挂载时自行发起，无需注入 connectTerminal）
const tabsApi = useTerminalTabs({
  tabs,
  activeTabId,
  termInstances: instancesApi.termInstances,
  disposeInstance: instancesApi.disposeInstance,
})

// 3. 工具栏动作（clearAndRestart 等 pane 动作在此装配，供右键菜单闭包调用）
const toolbarApi = useTerminalToolbarActions({
  tabs,
  activeTabId,
  paneRefs,
  termInstances: instancesApi.termInstances,
  restartTerminal: (tab: { id: string }) => tabsApi.restartTerminal(tab as TermTab),
  maximizeTerminal,
  maximizeBottomPanelEditor,
})
const { onMoreSelect } = toolbarApi

// 3.2 「在文件树中定位」（P-20261001-32）：会话 dir 解析 + 工具条按钮事件派发，
// tab tooltip / 按钮数据统一由 dirByTabId 提供（FileTreeView 侧监听落点）
const { dirByTabId, activeDir, locateActive } = useTerminalTreeLocate({ tabs, activeTabId })

// 3.5 会话快照对账（terminals.changed 广播）：终端会话管理页等他处的新建/关闭/重命名实时同步到本地 tab
useTerminalTabSync({ tabs, activeTabId })

// 3.6 激活指定终端（任务运行器创建任务终端后广播）：对账追加 tab 不设激活态，
// 若不补激活，任务会在永不可见的隐藏终端里执行。广播对账追加 tab 的时序可能
// 晚于本事件到达，故以待激活队列挂起，tab 出现后立即应用
const pendingActivateId = ref('')
function applyPendingActivate() {
  if (!pendingActivateId.value) return
  if (tabs.value.some(t => t.id === pendingActivateId.value)) {
    activeTabId.value = pendingActivateId.value
    pendingActivateId.value = ''
  }
}
function onOpsActivateTerminal(e: Event) {
  const id = (e as CustomEvent<{ id?: string }>).detail?.id
  if (!id) return
  pendingActivateId.value = id
  applyPendingActivate()
}
window.addEventListener(OPS_ACTIVATE_TERMINAL, onOpsActivateTerminal)
onBeforeUnmount(() => window.removeEventListener(OPS_ACTIVATE_TERMINAL, onOpsActivateTerminal))
// 待激活队列的 tab 就位兜底：事件先到、tab 后追加（reconnect 拉取/对账广播）
// 时队列挂起——签名 watch 在 tab 集合变化时重试应用（与上方 prune 同款非 deep 范式）
watch(() => tabs.value.map(t => `${t.id}|`).join(''), () => {
  applyPendingActivate()
})

// 4. 右键菜单（复制/粘贴/导出动作经 paneRef 下发到对应 pane 内的剪贴板管线）
const shareSnippet = useSnippetShare()
// 终端选中文本「询问智能体此输出」（P-20261003-7）：与编辑器 P-28/P-122 共用
// 发起链路（busy 让位/create/docked 激活/结果提示都在链内）；失败命令「交给
// agent 修」（P-20261003-150）走同一 launchAskSession 链
const { askAgentAboutTerminalOutput, askAgentToFixFailedCommand } = useEditorAskAgent()
const menuApi = useTerminalContextMenu({
  termInstances: instancesApi.termInstances,
  getActiveTabId,
  copySelection: async (tabId: string) => { paneRefs.get(tabId)?.copySelection() },
  // 复制为代码块（P-20261003-270）：```bash 围栏 + 命令行头
  copyAsCodeBlock: (tabId: string) => { paneRefs.get(tabId)?.copyAsCodeBlock() },
  paste: async (tabId: string) => { paneRefs.get(tabId)?.pasteFromClipboard() },
  copyAll: async (tabId: string) => { paneRefs.get(tabId)?.copyAll() },
  // 复制上一条命令输出（OSC 133 C/D 行号记账区间提取）
  copyLastOutput: (tabId: string) => { paneRefs.get(tabId)?.copyLastOutput() },
  exportText: (tabId: string) => {
    const tab = tabs.value.find((tb) => tb.id === tabId)
    paneRefs.get(tabId)?.exportAsText(tab?.name || 'terminal')
  },
  clearAndRestart: () => {
    toolbarApi.clearActiveTerminal()
    toolbarApi.restartActiveShell()
  },
  // 右键菜单「刷新」：深度刷新（fit + 行数抖动强制滚动区重同步）——
  // light 链路的 refresh/scrollLines(0) 对 xterm v6 滚动区失步无效
  redraw: (tabId: string) => { paneRefs.get(tabId)?.fit(true) },
  // 分享选中文本为片段短链（P-20261002-71；无选区菜单项已禁用，此处静默兜底）
  shareSelection: (tabId: string) => {
    const sel = instancesApi.termInstances.get(tabId)?.term.getSelection()
    if (sel) shareSnippet.openShareSnippet(sel)
  },
  // 发送剪贴板到其他设备（P-20261008-3）：useClipRelay 现成发送链（读取/回退/
  // 32KB 前置拦截全复用，与命令面板 clip-send 同链）；与终端状态零耦合，
  // 不取选区不落 pane（闭包引用下方 message，点击期才执行——同书签行 handler 先例）
  sendClip: () => { void useClipRelay(message).sendLocalClipboard() },
  // 询问智能体此输出（P-20261003-7）：选中文本组装 prompt 经 createAgentTerminal
  // 发起（P-122 同款链路；无选区菜单项已置灰，此处静默兜底）
  askAgent: (tabId: string) => {
    const sel = instancesApi.termInstances.get(tabId)?.term.getSelection()
    if (sel) void askAgentAboutTerminalOutput(sel)
  },
  // 失败命令「交给 agent 修」（P-20261003-150）：最近失败命令（OSC 133 D 帧记账）
  // + 输出尾部组装 prompt 经同一发起链路；无失败记录菜单项已置灰，此处静默兜底
  fixWithAgent: (tabId: string) => {
    const rec = getFailedCommandRecord(tabId)
    if (!rec) return
    void askAgentToFixFailedCommand(rec.command, extractFailedCommandOutput(tabId), rec.exitCode)
  },
  // 书签「标记/取消标记此行」（P-20261004-16）：右键时刻解析的缓冲行切换书签，
  // 方向分文案 toast 反馈——标记在屏上有 gutter 小旗即时可见，toast 是第二确认
  toggleBookmarkLine: (tabId: string, bufferLine: number) => {
    const added = toggleBookmarkAtLine(tabId, bufferLine)
    message.success(t(added ? 'terminal.bookmark.added' : 'terminal.bookmark.removed', { line: bufferLine + 1 }))
  },
})

// 模板里直接用到的解构
const {
  projectTabs, renamingTabId, renameValue,
  showCloseConfirm, closeNoPrompt, pendingCloseTabId,
  createTerminal, duplicateTerminal, selectTab, moveTabBefore, requestCloseTab, confirmCloseTab, cancelCloseTab,
  requestClosePane, showPaneCloseConfirm, pendingPaneClose, confirmPaneClose, keepPaneAsTab, cancelPaneClose,
  startRename, finishRename,
  splitTab, setActivePane,
  closeOtherTabs, closeRightTabs, closeAllTabs,
} = tabsApi

// 4. 分屏交互（divider 拖拽/键盘/重置；开关分屏走 tabsApi）
const splitApi = useTerminalSplit({
  tabs,
  activeTabId,
  termInstances: instancesApi.termInstances,
  splitTab,
  // pane 关闭过条件保全入口（P-20261004-145）：running 的 secondary 弹两选
  // 弹层，与 × 按钮同判——键路径不再直连 closePane 各杀各的
  requestClosePane,
  setActivePane,
})
const {
  splitResizing, splitActiveTab, closeActivePane, handlePaneClick, focusOtherPane,
  startPaneResize, resetPaneSplit, onDividerKeydown,
} = splitApi

// 5. tab 右键菜单（重命名 / 关闭 / 批量关闭 / 拖出浮动窗）
const floatApi = useTerminalFloat({ tabs })
// 直播分享结果卡与文件/片段分享共用（useShareDialog 模块级单例，弹窗宿主
// 挂 Layout）；tab.id 即终端会话 ID，创建链在 useShareDialog.createTerminalLive
const shareDialog = useShareDialog()
// 终端会话统一 store（P1）：敏感标记行操作与角标读数同源（P-20261003-155）
const sessionsStore = useTerminalSessionsStore()
// 敏感内容自动检测建议（P-20261003-207）：导出落地后异步扫描，命中即建议标记
const { suggestSensitiveMarking } = useSensitiveMarkHint()

// ============== split 关闭保全弹层展示数据（P-20261004-145） ==============
// pane 名取服务端权威会话名（splitTab 创建时的「<主名>-split」）；命令文本取
// lastCmdMap 的「正在跑什么」（E 帧写入，刷新后缺帧回落占位不虚构）。展示截
// 断在数据源收口：按钮/正文同源同长，超长单行命令不撑爆弹层
const PANE_CLOSE_CMD_MAX = 48
const paneClosePaneName = computed(() => {
  const id = pendingPaneClose.value?.paneId
  return (id ? sessionsStore.sessions.find(s => s.id === id)?.name : '') || ''
})
const paneCloseCommand = computed(() => {
  const id = pendingPaneClose.value?.paneId
  const raw = (id ? sessionsStore.lastCmdMap[id]?.command : '') || ''
  const text = raw || t('terminal.paneCloseUnknownCmd')
  return text.length > PANE_CLOSE_CMD_MAX ? `${text.slice(0, PANE_CLOSE_CMD_MAX)}…` : text
})

// 关闭单会话确认的 pending 审批警示（P-20261003-275）：待关会话有等待裁决的
// 审批时确认文案附加警示——关闭即裁决永不到来（agent 白等至 TTL 兜底）。
// 弹窗打开期间裁决到达则实时翻 false，警示随 pending 清账消失
const closeConfirmPendingApproval = computed(() =>
  approvalsStore.pendingSessionIds.has(pendingCloseTabId.value),
)
/** 浮动窗收回面板：状态复位后等一帧 refit（docked 尺寸在下一帧才稳定） */
function onFloatDockBack(tabId: string): void {
  floatApi.dockBack(tabId)
  void nextTick(() => fitPane(tabId))
}
// 导出输出（P-20261003-100）：服务端 scrollback 链剥 ANSI 直出 txt 留档附件。
// blob 下载名客户端合成（响应拦截器不透 Content-Disposition，claude 导出同款）；
// 失败由 axios 拦截器统一 toast。与「更多」菜单的客户端导出文本（xterm 当前
// 缓冲直下）互补：本链路不依赖 pane 挂载，tmux 下 capture-pane 为权威缓冲。
// 出域闸（P-20261003-155 会话标记 + P-20261004-113 内容敏感）合并为同一警示
// 响应：统一经 fetchWithEgressGate 弹一次确认，确认后同时带 override=1&
// confirm=1 重取——JSON 永不落盘（半真文件比失败更糟）
async function exportOutputTabFile(tab: TermTab): Promise<void> {
  try {
    const blob = await fetchWithEgressGate(
      confirm => terminalApi.exportOutput(
        tab.id,
        confirm ? { params: { override: '1', confirm: '1' } } : undefined,
      ) as unknown as Promise<Blob>,
      tab.name,
    )
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = exportFileName(tab.name, new Date(), 'txt', 'terminal')
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    message.success(t('terminal.exportOutputDone'))
    // 敏感内容自动检测建议（P-20261003-207）：下载已落地才扫描，void 不 await
    //（blob 本身已在内存，读取整包文本只为取样——尾窗抽样有界在 util 内收口）
    void suggestSensitiveMarking(tab.id, tab.name, () => blob.text())
  } catch { /* 拦截器处理 */ }
}
// 敏感标记（P-20261003-155）：tab 右键行操作切换，成功反馈按方向分文案
async function toggleTabSensitive(tab: TermTab): Promise<void> {
  const next = !(sessionsStore.sessions.find(s => s.id === tab.id)?.sensitive === true)
  await sessionsStore.setSensitive(tab.id, next)
  message.success(t(next ? 'terminal.markSensitiveDone' : 'terminal.unmarkSensitiveDone'))
}
// 直播分享/结束直播（P-20261003-306 + P-20261005-161）：右键同位项按直播态
// 分流——无锚点走创建弹链；有锚点一键 DELETE 即时断流（撤销从分享管理器两跳
// 变一跳）。不弹确认：同链幂等（重建得回同一短链），误触代价对称可逆；失败
// toast 归拦截器，成功失败都对账（失败时摘除陈旧锚点同理）
async function toggleLiveShareTab(tab: TermTab): Promise<void> {
  const live = liveSharesApi.liveBySession.value[tab.id]
  if (!live) {
    void shareDialog.createTerminalLive(tab.id)
    return
  }
  try {
    await shareApi.remove(live.token)
    message.success(t('terminal.endLiveShareDone'))
  } catch { /* 拦截器已 toast；下面对账会摘掉已失效的锚点 */ } finally {
    liveSharesApi.bump()
  }
}
// 复制会话 ID（P-20261004-123）：tab.id 即终端会话 ID——协作协议的地址（agent
// 收件箱/接续链/ui.snapshot 归属/任务进度跳转全用它），一键入剪贴板免手工抓取。
// copyText 惯例（非 secure context 自动降级 execCommand），反馈按返回值分支 toast
async function copyTabSessionId(tab: TermTab): Promise<void> {
  const ok = await copyText(tab.id)
  if (ok) message.success(t('terminal.copySessionIdDone'))
  else message.error(t('terminal.copySessionIdFailed'))
}
// 分享回放（P-20261004-103）：tab 右键「分享回放」——取该会话最近一次过程
// 录制生成只读回放短链（异步 walkthrough，默认 1 小时）。录制由审批窗口自动
// 开启（设置默认关），无录制时给出可行动提示而非静默失败；结果卡由
// useShareDialog 单例弹出（服务端敏感模式扫描命中时走确认流）
async function shareReplayTab(tab: TermTab): Promise<void> {
  try {
    const res = (await recordingApi.list({ sessionId: tab.id, limit: 1 })) as unknown as {
      data?: { id?: string }[]
    }
    const latest = res?.data?.[0]
    if (!latest?.id) {
      message.warning(t('terminal.replayShareNone'))
      return
    }
    await shareDialog.createRecordingShare(latest.id)
  } catch { /* 拦截器处理 */ }
}
const tabMenuApi = useTerminalTabMenu({
  tabs,
  selectTab,
  startRename,
  requestCloseTab,
  closeOtherTabs,
  closeRightTabs,
  closeAllTabs,
  toggleFloatTab: (tab) => {
    if (floatApi.isFloating(tab.id)) onFloatDockBack(tab.id)
    else floatApi.floatTab(tab)
  },
  liveShareTab: (tab) => { void toggleLiveShareTab(tab) },
  frozenShareTab: (tab) => { void shareDialog.createTerminalFrozen(tab.id) },
  // 分享回放（P-20261004-103）：取该会话最近一次录制的 cast 生成只读回放链
  replayShareTab: (tab) => { void shareReplayTab(tab) },
  exportOutputTab: (tab) => { void exportOutputTabFile(tab) },
  // 对比输出（P-20261005-210）：tab.id 即终端会话 ID——diff 左侧固定为当前会话，
  // 右侧由弹层内的会话选择浮层决定（本地/agent/远程），双取数进快照 diff
  compareOutputTab: (tab) => {
    compareCurrent.value = { id: tab.id, name: tab.name }
    compareShow.value = true
  },
  toggleSensitiveTab: (tab) => { void toggleTabSensitive(tab) },
  isTabSensitive: (id) => sessionsStore.sessions.find(s => s.id === id)?.sensitive === true,
  wrapUpTab: (tab) => openWrapUpCard(tab),
  // 置顶切换（P-20261004-53）：纯前端显示偏好落 store（safeStorage 持久化），
  // 显示序投影与置顶视觉由 store.pinnedIds 单一事实源驱动
  togglePinTab: (tab) => sessionsStore.togglePin(tab.id),
  isTabPinned: (id) => sessionsStore.isPinned(id),
  // 复制会话（P-20261004-1）：取源会话创建配置建同配置新会话并激活
  duplicateTab: (tab) => { void duplicateTerminal(tab) },
  // 复制会话 ID（P-20261004-123）：tab.id 即终端会话 ID 一键入剪贴板
  copySessionIdTab: (tab) => { void copyTabSessionId(tab) },
  // 书签列表（P-20261004-16）：tab 右键入口——面板跟随目标 tab（激活前先 selectTab
  // 已在 showTabContextMenu 内完成），会话 id 取 tab 的活跃 pane（split 下随焦点 pane）
  openBookmarkListTab: (tab) => openBookmarkPanel(tab),
})

// 会话收工卡（P-20261004-35）：tab 右键「收工摘要」弹层。projectId 与历史上报
// 同口径解析（tab.projectId || 当前项目）——agent 会话的命令账落在发起上报时
// 的项目桶，摘要按同口径取数；两处皆空 = 无账可查（卡片内空态呈现）
const wrapUpShow = ref(false)
const wrapUpTab = ref<{ id: string; name: string } | null>(null)
const wrapUpProjectId = ref('')
// 会话输出对比弹层（P-20261005-210）：tab 右键「对比输出…」——current 即 diff
// 左侧（发起对比的会话），右侧在弹层选择浮层里挑（本地/agent/远程各形态）；
// 纯前端组装零新端点（双取数走既有 export / 远程 scrollback API）
const compareShow = ref(false)
const compareCurrent = ref<{ id: string; name: string } | null>(null)
function openWrapUpCard(tab: TermTab): void {
  wrapUpTab.value = { id: tab.id, name: tab.name }
  wrapUpProjectId.value = tab.projectId || projectStore.currentProjectId || ''
  wrapUpShow.value = true
}

// 书签列表浮层（P-20261004-16）：tab 右键 / Ctrl+Alt+K 两入口。面板展示目标
// tab 活跃 pane 的 scrollback 书签（会话内存态，split 双 pane 各自书签互不串——
// sessionId 键控）；会话 id 取 activePaneId（未 split 恒等于 tab.id）
const showBookmarkPanel = ref(false)
const bookmarkPanelSessionId = ref('')
function openBookmarkPanel(tab: TermTab): void {
  bookmarkPanelSessionId.value = tab.activePaneId || tab.id
  showBookmarkPanel.value = true
}
const {
  tabContextMenu, showTabContextMenu, closeTabContextMenu,
  closeTabContextMenuOnGlobal, handleTabContextAction, menuTabSensitive, menuTabPinned,
} = tabMenuApi
/** 右键菜单目标 tab 是否浮动（决定菜单文案「拖出为浮动窗 / 收回面板」） */
const tabMenuFloating = computed(() => {
  const id = tabContextMenu.value?.tabId
  return id ? floatApi.isFloating(id) : false
})
/** 右键菜单目标 tab 的敏感标记态（决定「标记敏感/取消敏感标记」文案方向） */
const tabMenuSensitive = computed(() => menuTabSensitive())
/** 右键菜单目标 tab 的置顶态（决定「置顶/取消置顶」文案方向，P-20261004-53） */
const tabMenuPinned = computed(() => menuTabPinned())
/** 右键菜单目标 tab 的直播态（P-20261005-161）：「直播分享/结束直播」文案翻转 */
const tabMenuLive = computed(() => {
  const id = tabContextMenu.value?.tabId
  return !!id && !!liveSharesApi.liveBySession.value[id]
})
const floatingTabIds = floatApi.floatingIds

// 5.5 广播模式（P-20261003-288 舰队式批量输入）：tab 栏多选 + 广播输入条。
// 点击语义切换在 onSelectTab（广播开 = 切选中态不激活），选中集存活对账与
// 发送链（尾部换行自动补）在 composable 内
const broadcastApi = useTerminalBroadcast({ tabs })
const {
  broadcastMode, selectedTabIds, selectedAgentIds, selectedRemoteIds,
  agentCandidates, remoteCandidates, targetIds,
  lastResult, showResultPanel, resultTargets, inputHistory,
  toggleTab, toggleAgent, toggleRemote, exitBroadcastMode, send: sendBroadcast,
} = broadcastApi

// 6. 会话总览（跨项目并行开发：进度一览 + 快捷切换）
const overviewApi = useSessionOverviewState({
  tabs,
  projects: computed(() => projectStore.projects),
  currentProjectId: computed(() => projectStore.currentProjectId),
  activeTabId,
  selectTab,
  selectProject: (id: string) => projectStore.selectProject(id),
})
const { showSessionOverview, recordLastCommand, sessionGroups, sessionSummary, jumpToSession, pruneLastCommands } = overviewApi

// 切 tab 辅助：按相对偏移 / 按索引（toolbar 与模板使用）
function switchTabBy(delta: number): void {
  const pt = projectTabs.value
  if (pt.length === 0) return
  const idx = pt.findIndex((t) => t.id === activeTabId.value)
  const newIdx = (idx + delta + pt.length) % pt.length
  selectTab(pt[newIdx]!.id)
}

function switchTabTo(index: number): void {
  const pt = projectTabs.value
  if (index < 0 || index >= pt.length) return
  selectTab(pt[index]!.id)
}

// ============== OSC 133（shell integration）事件桥 ==============
// C/D 事件维护 tab 状态点、长任务通知、命令历史上报（实现抽至 useTerminalOscBridge）
const oscBridge = useTerminalOscBridge({
  tabs,
  currentProjectId: () => projectStore.currentProjectId,
  projectName: () => projectStore.currentProject?.name,
  historyEnabled,
  longTaskThresholdMs: () => notificationStore.prefs.longTaskThresholdMs,
  recordLastCommand,
})
const onOscEvent = oscBridge.onOscEvent
// 运行书序贯执行器（P-20261004-13 onFailure 语义）：OSC 事件同源转发（stop 模式
// 经 D 帧逐条等退出码），写终端走 paneRefs.writeInput（命令 + \r 执行）
const runbookRunner = useRunbookRunner((sessionId, data) => paneRefs.get(sessionId)?.writeInput(data) ?? false)
// 会话粒度运行态写回统一 store（终端会话管理页/悬浮列表读同一份运行点）
function onOscEventSync(ev: OscEvent, sessionId: string) {
  onOscEvent(ev, sessionId)
  runbookRunner.onOscEvent(ev, sessionId)
  // R（附着重放边界）/A（prompt 开始）/G（P-20261005-233 断档元信息）只服务
  // 记账门控、提示符代记账与缺口标记判定，无运行点语义
  // D 携命令文本+退出码、E 携命令文本（P-20261004-37 停滞分诊的最近命令数据面）
  if (ev.type !== 'R' && ev.type !== 'A' && ev.type !== 'G') sessionsStore.reportOsc(sessionId, ev.type, { command: ev.command, exitCode: ev.exitCode })
  // 命令结束（非重放）后刷新变更计数：终端里的 CLI commit/切分支等 git 操作
  // 不产生工作区文件事件，fsnotify 通道感知不到，计数会滞留（去抖合并连续命令）
  if (ev.type === 'D' && !ev.replayed) scheduleChangesRefresh()
}

// 变更计数去抖刷新：2s 尾随，连续命令只打一次 /status
let changesRefreshTimer: ReturnType<typeof setTimeout> | null = null
function scheduleChangesRefresh(): void {
  const pid = projectStore.currentProjectId
  if (!pid) return
  if (changesRefreshTimer) clearTimeout(changesRefreshTimer)
  changesRefreshTimer = setTimeout(() => {
    changesRefreshTimer = null
    void changesStore.fetchStatus(pid)
  }, 2000)
}

// ============== 命令历史 / 片段（C1/C2）==============

const showHistoryPanel = ref(false)
// Claude 会话浮层（P5）：项目范围锁定，恢复 = 新开终端注入 claude --resume
const showClaudePanel = ref(false)
const showSnippetPanel = ref(false)
// 运行书面板（P-20261003-24）：多步序列逐步发送（插入不执行）
const showRunbookPanel = ref(false)

/** 关闭运行书之外的浮层面板（互斥开关统一出口） */
function closeOtherPanels(except: 'history' | 'claude' | 'snippet' | 'runbook' | 'bookmark') {
  if (except !== 'history') showHistoryPanel.value = false
  if (except !== 'claude') showClaudePanel.value = false
  if (except !== 'snippet') showSnippetPanel.value = false
  if (except !== 'runbook') showRunbookPanel.value = false
  if (except !== 'bookmark') showBookmarkPanel.value = false
}

// 录制一键转运行书（P-20261005-3）：回放器「存为运行书」经 runbookDraft store
// 直达交付草稿——本视图是面板开关的宿主（store 够不到 TerminalView 内部的
// showRunbookPanel），见草稿即在位即展开运行书面板；RunbookPanel 挂载/在场
// 即消费草稿预填新建表单。immediate 守住「TerminalView 随 bottomTab v-if 挂载
// 晚于草稿交付」的时序（跨路由直达必经此路径）
const runbookDraftStore = useRunbookDraftStore()
watch(() => runbookDraftStore.pending, (d) => {
  if (d) {
    showRunbookPanel.value = true
    closeOtherPanels('runbook')
  }
}, { immediate: true })

/** 插入文本到当前活动终端（历史/片段面板共用；插入不执行） */
function insertToActiveTerminal(text: string): void {
  const pane = paneRefs.get(activeTabId.value)
  const sent = pane?.writeInput(text) ?? false
  if (sent) pane?.focus()
  else message.warning(t('terminal.notConnected'))
}

/** 历史条目 ▶ 副按钮（P-20261003-61）：插入并执行——追加 \r 即手敲回车
 *  同路径（writeInput 直发 PTY，与运行书执行器 useRunbookRunner 的写法一致）；
 *  显式副操作即用户负责，不做危险命令特判 */
function insertAndRunToActiveTerminal(text: string): void {
  insertToActiveTerminal(text + '\r')
}

/** 运行书序贯执行（P-20261004-13）：绑定发起时的活动会话，中途切 tab 不改道 */
function onRunbookRun(req: RunbookRunRequest): void {
  const sessionId = activeTabId.value
  if (!paneRefs.get(sessionId)) {
    message.warning(t('terminal.notConnected'))
    return
  }
  runbookRunner.start(req, sessionId)
}

function onRunbookRunStop(): void {
  runbookRunner.stop()
}

const message = useMessage()

// 「更多」下拉（工具栏收敛：清屏/刷新/重启/复制/导出/最大化合并，目标 ≤8 按钮）
type MoreAction = 'clear' | 'refresh' | 'restart' | 'copyAll' | 'export' | 'maxEditor' | 'maxPanel'
const moreOptions = computed(() => [
  { label: t('terminal.clear'), key: 'clear' },
  { label: t('terminal.refresh'), key: 'refresh' },
  { label: t('terminal.restartShell'), key: 'restart' },
  { type: 'divider', key: 'd1' },
  { label: t('terminal.copyAll'), key: 'copyAll' },
  { label: t('terminal.exportText'), key: 'export' },
  { type: 'divider', key: 'd2' },
  { label: bottomPanelEditorMaximized.value ? t('layout.restoreEditor') : t('layout.maximizeEditor'), key: 'maxEditor' },
  { label: terminalMaximized.value ? t('terminal.restore') : t('terminal.maximize'), key: 'maxPanel' },
])
// 「更多」动作实现抽至 useTerminalToolbarActions（pane 动作经 paneRefs 下发）

// 字号/分屏下拉选项已移入 TerminalTabbar 组件（含「更多」菜单本体）

const {
  showContextMenu, contextMenuX, contextMenuY, contextMenuTabId, contextMenuLine,
  handleContextMenuAction,
} = menuApi

/** 右键行是否已带书签（「标记此行/取消标记」文案方向；行未解析成功时恒 false） */
const menuLineBookmarked = computed(() =>
  contextMenuLine.value !== null && isLineBookmarked(contextMenuTabId.value, contextMenuLine.value),
)

// 选区长度查询统一走 instancesApi（右键菜单「复制」按钮 enable/disable 依据）
const { getSelectionLength } = instancesApi

// 终端根区吞掉浏览器原生右键菜单：pane 内由 TerminalPaneContextMenu 打开自家菜单，
// tab 条/工具栏/缝隙处漏出系统菜单会造成「双菜单」观感（tab 自身菜单不受影响，
// 本函数只 preventDefault 不阻止其他 handler）
function suppressNativeMenu(e: Event): void {
  e.preventDefault()
}

/** 挂起 tab 点击语义 = 取回：归还渲染权后正常激活（pane 重挂 + 服务端重放） */
function onSelectTab(tabId: string) {
  // 广播模式（P-20261003-288）：点击 = 选中/取消选中（不激活、不取回接管，
  // 挂起会话也可作为广播目标），Esc/退出广播模式恢复正常激活语义
  if (broadcastMode.value) {
    toggleTab(tabId)
    return
  }
  if (sessionsStore.managerAttached.has(tabId)) sessionsStore.returnToPanel(tabId)
  // 浮动 tab 点击 = 聚焦浮动窗（带到前台；activeTabId 同步保证收回后落点正确）
  if (floatApi.isFloating(tabId)) floatApi.bringToFront(tabId)
  selectTab(tabId)
}

/** 文件树路径拖到 tab 头上 = 路由粘贴到该 tab 的终端并激活（分屏拖拽互传） */
function pastePathToTab(tabId: string, path: string): void {
  const pane = paneRefs.get(tabId)
  if (!pane) return
  pane.writeInput(path)
  onSelectTab(tabId)
  pane.focus()
}
function onResumePane(paneId: string) {
  sessionsStore.returnToPanel(paneId)
}

/** pane 临时最大化 toggle（P-20261004-64）：双 pane 校验后转发 usePanelLayout——
 *  单 pane（清单未含两个会话 id）最大化无意义，防御性短路 */
function onTogglePaneMaximize(tabId: string, paneId: string) {
  const tab = tabs.value.find((t) => t.id === tabId)
  if (!tab?.panes || tab.panes.length !== 2) return
  if (paneId !== tab.id && paneId !== tab.panes[1]) return
  toggleTerminalPaneMaximized(tabId, paneId)
}

// TerminalPanesArea 的交互 handlers（集中装配，模板零逻辑）
const paneHandlers = {
  getTerminalWsUrl,
  uploadPaste,
  onOscEvent: onOscEventSync,
  resizeTerminal,
  redrawTerminal,
  setPaneRef,
  secondaryPaneRefFn,
  handlePaneClick,
  focusOtherPane,
  openContextMenu: (tabId: string, e: MouseEvent, bufferLine?: number) => menuApi.openContextMenu(tabId, e, bufferLine),
  splitActiveTab,
  closeActivePane,
  switchTabBy,
  switchTabTo,
  startPaneResize,
  resetPaneSplit,
  onDividerKeydown,
  onResume: onResumePane,
  fitPane,
  onDockBack: onFloatDockBack,
  togglePaneMaximize: onTogglePaneMaximize,
}

// ============== 工具栏操作 ==============
function changeTerminalFontSize(delta: number) {
  // 经 store 步进漏斗：与 Ctrl+滚轮手势同享设置页滑条的上下限钳制
  fontStore.stepTerminalSize(delta)
}

// ============== watch ==============
// tab / pane 关闭时同步清理会话总览的最近命令记录（防跨会话残留）。
// 监听 id 签名而非 deep：deep 会在任意 tab 字段变更时全遍历，签名只在
// tab/pane 集合真正变化时触发（useLayoutState 同范式）
watch(() => tabs.value.map(t => `${t.id}:${(t.panes || []).join(',')}|`).join(''), () => {
  const alive = new Set<string>()
  tabs.value.forEach((tb) => {
    alive.add(tb.id)
    tb.panes?.forEach((pid) => alive.add(pid))
  })
  pruneLastCommands(alive)
  // pane 临时最大化陈旧态清理（P-20261004-64）：tab 关闭 / pane 关闭 / 取消
  // 拆分（panes 塌回单 pane）后最大化目标已不存在，残留会让下次开 split 意外
  // 单 pane 全幅。签名只在 tab/pane 集合真正变化时触发，toggle 本身不误触
  const m = terminalPaneMaximized.value
  if (m) {
    const tab = tabs.value.find((t) => t.id === m.tabId)
    const stillThere = !!tab?.panes && tab.panes.length === 2
      && (m.paneId === tab.id || m.paneId === tab.panes[1])
    if (!stillThere) terminalPaneMaximized.value = null
  }
})

watch(() => projectStore.currentProjectId, (newId) => {
  // 会话总览跨项目跳转（jumpToSession）先切项目再选中目标 tab，本 watch 触发
  // 时 activeTabId 已指向新项目的 tab——直接返回，不得用 localStorage 记忆
  // 覆盖跳转落点（覆盖后跳转目标 pane 仍隐藏，且会按隐藏态错误 fit/重绘）
  if (tabs.value.some((t) => t.id === activeTabId.value && t.projectId === newId)) return
  // 切换项目时仅切换活跃标签，不关闭终端。激活 tab 优先恢复该项目记忆的
  // 选择（而非永远最后一个）；记忆失效（tab 被关）回退最后一个
  const pt = tabs.value.filter((t) => t.projectId === newId)
  if (pt.length > 0) {
    const saved = recallActiveTab(newId)
    activeTabId.value = pt.some((t) => t.id === saved) ? saved : pt[pt.length - 1]!.id
  } else {
    activeTabId.value = ''
  }
})

// 记住每个项目的激活 tab：activeTabId 变化时按 tab 所属项目写入
// localStorage（刷新重连 / 实例切换 / 解锁 / 项目切换时恢复用）
watch(activeTabId, (id) => {
  // 用户最近激活会话信标（P-20261004-52）：ui.snapshot 现场上报消费——本
  // View 随底部 terminal 页签挂载（可见即挂载），激活位变化即用户在看该会话
  sessionsStore.setActiveSession(id)
  const tab = tabs.value.find((t) => t.id === id)
  if (tab) rememberActiveTab(tab.projectId, tab.id)
})

// 底部面板重新可见 / 最大化切换 / 终端自身最大化 / pane 临时最大化（P-20261004-64）：
// 强制 refit 全部项目 pane。面板隐藏期间（v-show）连接的会话重放 scrollback 时
// xterm 滚动条尺寸不同步（重开后滚轮失灵、操作几次才自愈），visibility 变化时
// 深度刷新是可靠的自愈点（TerminalPane.fit(true) = refresh + 行数抖动强制滚动区
// 重同步 + 权威重绘；隐藏 pane 由零尺寸守卫天然跳过，轮到它可见时的同款 watch
// 再治）。pane 最大化/还原是 v-show 显隐 + flex basis 抬满，同属尺寸冻结场景：
// 隐藏侧零尺寸守卫跳过，还原后此 watch 重触发两侧 fit——任务书预判的「还原后
// ResizeObserver 重触发」即落在这一既有自愈链
const layoutState = usePanelLayout()
watch(
  () => [layoutState.showBottomPanel.value, layoutState.bottomPanelMaximized.value, layoutState.bottomPanelEditorMaximized.value, terminalMaximized.value, terminalPaneMaximized.value] as const,
  ([show], [prevShow]) => {
    if (!show && prevShow !== true) return
    void nextTick(() => {
      requestAnimationFrame(() => {
        for (const tb of tabs.value) {
          paneRefs.get(tb.id)?.fit(true)
          const second = tb.panes?.[1]
          if (second) paneRefs.get(second)?.fit(true)
        }
      })
    })
  },
)

// ============== 后台 tab 未读活动点：本面板可见会话登记（P-20261003-310） ==============
// 底部面板可见时，活跃 tab + 浮动窗 tab 算「可见」（输出不点亮未读）；面板收起
// 或激活 tab 被管理页接管（挂起占位不在本面板渲染）即视为后台。登记变化即清除
// 对应未读——激活路径（点击/快捷键/跳转/面板重现）的清除单一收口
watch(
  () => [layoutState.showBottomPanel.value, activeTabId.value, floatingTabIds.value] as const,
  ([show, active, floats]) => {
    const ids: string[] = []
    if (show) {
      if (active && !sessionsStore.managerAttached.has(active)) ids.push(active)
      for (const id of floats) {
        if (!sessionsStore.managerAttached.has(id)) ids.push(id)
      }
    }
    sessionsStore.setHostVisible('bottomTerminal', ids)
  },
  { immediate: true },
)
// 卸载即撤登记：本面板不再渲染任何会话（v-if 随底部页签切换卸载），全部视作后台
onBeforeUnmount(() => sessionsStore.setHostVisible('bottomTerminal', []))

/** tab 未读点数据源：unreadMap 限当前项目 tab 投影（TerminalTabbar 纯 UI 收 Set） */
const unreadTabIds = computed(() => {
  const m = sessionsStore.unreadMap
  const out = new Set<string>()
  for (const tb of projectTabs.value) {
    if (m[tb.id]) out.add(tb.id)
  }
  return out
})

/** tab 锁徽标数据源（P-20261004-143）：落锁项目的 tab 投影（TerminalTabbar 纯 UI
 *  收 Set，与 unreadIds 同构）。面板 tab 全部归属当前项目（projectTabs 过滤），
 *  项目落锁即全亮；锁态由 project store 的 projects.changed 订阅保鲜（广播路径
 *  锁定即现、解锁即摘），shell 归属按 projectId 直查、不涉 dir 判定 */
const lockedTabIds = computed(() => {
  const out = new Set<string>()
  if (projectStore.currentProject?.locked !== true) return out
  for (const tb of projectTabs.value) out.add(tb.id)
  return out
})

// ============== 直播中徽标（P-20261005-161 主播侧可见性） ==============
// 数据面在 useTerminalLiveShares（30s 惰性轮询 + 创建/撤销点即时 bump，详见
// 该模块头注）；这里只做投影：tab 名字前红点呼吸徽标（访客页「直播中」同视觉
// 语）+ title 携剩余时长/累计观看数——「忘了直播在跑」的隐私边界在 tab 常驻位
// 可见，撤销同位一键可达
const liveSharesApi = useTerminalLiveShares()
// 剩余时长倒计时基准：30s 粒度自 tick（分享管理页倒计时同款驱动，分钟级展示
// 不需要秒针精度），TTL 到界同链驱动徽标摘除（本地先于服务端 CleanupExpired）
const liveNow = ref(Date.now())
let liveNowTimer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  liveSharesApi.start()
  liveNowTimer = setInterval(() => { liveNow.value = Date.now() }, 30_000)
})
onBeforeUnmount(() => {
  liveSharesApi.stop()
  if (liveNowTimer) clearInterval(liveNowTimer)
})
/** tab 直播徽标投影：sessionId → 徽标 title（「直播中·剩 HH:MM·N 次观看」）。
 *  空记录的会话不进表 = 无徽标；观看数取分享记录 hits（累计打开，唯一前端
 *  可得口径——hub 实时订阅计数无 API 出口） */
const liveTabTitles = computed<Record<string, string>>(() => {
  const src = liveSharesApi.liveBySession.value
  if (!Object.keys(src).length) return {}
  const out: Record<string, string> = {}
  for (const sessionId of Object.keys(src)) {
    const remainMs = src[sessionId]!.expiresAt
      ? new Date(src[sessionId]!.expiresAt!).getTime() - liveNow.value
      : NaN
    // 到界（含轮询间隙内的过期）不产 title = 摘徽标；无 TTL 记录（理论不出现）
    // 以 --:-- 兜底不误导
    if (!Number.isNaN(remainMs) && remainMs <= 0) continue
    const totalMin = Number.isNaN(remainMs) ? 0 : Math.ceil(remainMs / 60_000)
    const time = `${String(Math.floor(totalMin / 60)).padStart(2, '0')}:${String(totalMin % 60).padStart(2, '0')}`
    out[sessionId] = Number.isNaN(remainMs)
      ? t('terminal.liveBadgeTitle', { time: '--:--', n: src[sessionId]!.hits ?? 0 })
      : t('terminal.liveBadgeTitle', { time, n: src[sessionId]!.hits ?? 0 })
  }
  return out
})

// ============== 会话恢复 / 联动 watch（reconnect + 跳转 + 实例/解锁）==============
const reconnectApi = useTerminalReconnect({
  tabs,
  activeTabId,
  paneRefs,
  currentProjectId: () => projectStore.currentProjectId,
  terminalApiList: async () => {
    const res: { data: Array<{ id: string; name?: string; projectId?: string; kind?: string; running?: boolean }> } = await terminalApi.list()
    // 只恢复项目会话：agent 会话的宿主是终端会话管理页（免项目绑定），
    // 登记为底部 tab 会产生幽灵隐藏 tab（干扰命名/计数/对账）
    return (res.data || []).filter((s) => s.kind !== 'agent' && !!s.projectId)
  },
  pendingSwitch: computed(() => terminalStore.pendingSwitch),
  consumePendingSwitch: () => terminalStore.consume(),
  instanceId: computed(() => instanceStore.currentInstanceId),
  isLocked: computed(() => lockStore.isLocked),
  selectTab,
})
const { reconnectSessions } = reconnectApi

// ============== 生命周期 ==============
onMounted(() => {
  void reconnectSessions()
  // 一次性拉 settings，结果分发给本地 ref + terminal-theme store.hydrate（避免重复请求 /settings）
  fetchSettings()

  // 全局点击关闭右键菜单（菜单自身点击用 @click.stop 阻止冒泡）
  document.addEventListener('click', menuApi.onGlobalClickCloseMenu, true)
  document.addEventListener('click', closeTabContextMenuOnGlobal, true)
  document.addEventListener('contextmenu', menuApi.onGlobalClickCloseMenu, true)
  window.addEventListener('blur', menuApi.closeContextMenu)

  // tmux 翻页提示（一次性）：tmux 后端下滚轮翻历史需先进翻页模式，很多用户
// 不知道这个约定——首次遇到 tmux 后端且有会话时 toast 提示一次（localStorage 记忆）
const TMUX_TIP_KEY = 'sc.tmuxScrollTipShown'
watch([effectiveBackend, () => projectTabs.value.length], ([backend, tabCount]) => {
  if (backend !== 'tmux' || tabCount === 0) return
  let shown = false
  try { shown = localStorage.getItem(TMUX_TIP_KEY) === '1' } catch { /* ignore */ }
  if (shown) return
  safeStorage.setItem(TMUX_TIP_KEY, '1')
  message.info(t('terminal.tmuxScrollTip'), { duration: 8000, closable: true })
})

// 字体大小快捷键：Ctrl/Cmd + = 增大 / - 减小 / 0 重置。input/textarea 聚焦时不拦截
  document.addEventListener('keydown', onFontShortcutKey)
  // doc 级终端动作监听在场声明（P-20261003-111）：useLayoutKeyboard 据此让位，
  // 面板切 git/console 等分区（v-if 卸载本组件）时复位、布局链照常接管
  keymap.terminalDocActive = true
  // 标记终端可见：body.has-terminal 限制 noise texture 只在终端页生效（避免影响项目树/编辑器滚动）
  document.body.classList.add('has-terminal')
})

// 全局终端快捷键 handler（P-20261003-111 键位数据化）：Alt+1-9 切终端标签（区间键，
// 仍硬编码）；Ctrl+= / Ctrl+- / Ctrl+0 字号；Ctrl+Shift+H 开关命令历史面板；
// Ctrl+Shift+J 开关命令片段面板——后四组成 doc 级注册表动作（terminalHistory/
// terminalSnippet/terminalFontIn/Out/Reset），键位读 keymap 生效表，改绑即时生效
function onFontShortcutKey(e: KeyboardEvent) {
  // 锁定快捷键优先级最高（与布局链同约定）：本监听注册早于 useLayoutKeyboard
  // 的气泡链，命中锁定键时放行，由布局链收口锁屏
  const lockShortcut = lockStore.lockShortcut
  if (lockShortcut && matchShortcut(e, lockShortcut)) return
  // Alt+1-9：切到第 N 个终端标签（备忘单承诺；与终端是否聚焦无关）。
  // 必须在终端域动作匹配之前——Alt+数字是区间键硬编码，保留优先
  if (e.altKey && !e.ctrlKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
    const idx = parseInt(e.key, 10) - 1
    const t = projectTabs.value[idx]
    if (t) {
      e.preventDefault()
      selectTab(t.id)
    }
    return
  }
  // doc 级终端动作匹配（组合键精确 + 移位字符变体，同 comboVariants 容差）。
  // 面板键在 input 守卫之前（xterm 聚焦时 e.target 是 helper textarea，历史行为）；
  // 命中即 preventDefault——跨域撞键由 useLayoutKeyboard 的 docClaimsCombo 让位链
  // 消解（takeover 语义），无需 stopPropagation
  const hitDoc = (action: KeymapAction): boolean =>
    comboVariants(keymap.combos[action]).some(v => matchLayoutCombo(e, v))
  if (hitDoc('terminalHistory')) {
    e.preventDefault()
    showHistoryPanel.value = !showHistoryPanel.value
    return
  }
  // 片段面板快捷键（P-20261003-43）：与历史同域相邻键位（H→J）。
  // 开此关彼与工具条按钮同源（closeOtherPanels）——片段/历史是共用插入层的姊妹
  // 面板，键盘流开片段时历史让位，与按钮互斥展开语义一致
  if (hitDoc('terminalSnippet')) {
    e.preventDefault()
    showSnippetPanel.value = !showSnippetPanel.value
    closeOtherPanels('snippet')
    return
  }
  // 书签列表快捷键（P-20261004-16）：历史/片段同族面板键（doc 级）。无活动 tab
  // 时不做任何事（面板无目标会话可展示），也吞键防落到浏览器/布局链
  if (hitDoc('terminalBookmarkList')) {
    e.preventDefault()
    const tab = tabs.value.find((tb) => tb.id === activeTabId.value)
    if (tab) {
      openBookmarkPanel(tab)
      closeOtherPanels('bookmark')
    }
    return
  }
  const target = e.target as HTMLElement | null
  // xterm 的 helper textarea 不是真实文本输入（终端聚焦时它必然是 target，
  // 而字号快捷键正是在终端聚焦时使用），豁免守卫；真实 input/textarea 仍拦
  const isXtermHelper = !!(target as HTMLElement | null)?.classList?.contains('xterm-helper-textarea')
  if (target && !isXtermHelper && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
  if (hitDoc('terminalFontIn')) {
    e.preventDefault()
    changeTerminalFontSize(1)
  } else if (hitDoc('terminalFontOut')) {
    e.preventDefault()
    changeTerminalFontSize(-1)
  } else if (hitDoc('terminalFontReset')) {
    e.preventDefault()
    fontStore.setSize('terminal', 14)
  }
}

onBeforeUnmount(() => {
  document.removeEventListener('click', menuApi.onGlobalClickCloseMenu, true)
  document.removeEventListener('click', closeTabContextMenuOnGlobal, true)
  document.removeEventListener('contextmenu', menuApi.onGlobalClickCloseMenu, true)
  window.removeEventListener('blur', menuApi.closeContextMenu)
  document.removeEventListener('keydown', onFontShortcutKey)
  keymap.terminalDocActive = false
  document.body.classList.remove('has-terminal')
  // xterm 实例与 WS 由各 TerminalPane 卸载时自行释放（useTerminalSession.dispose）
})

defineExpose({
  activeTabId,
  // 命令面板「新建终端」等宿主级入口：创建并激活新 tab（无项目时内部 toast 提示）。
  // dir（P-20261005-192 目录级终端直达）：项目相对工作目录，空 = 项目根
  createTerminal: (dir?: string) => tabsApi.createTerminal(dir),
  // Esc 逐层收起（P-20261004-12）：收回 z 最高的浮动终端窗（一次一层）。浮动窗
  // z 基座 3000+（TerminalPanesArea.floatStyle），是布局浮出层的最上层，先于
  // 最大化/底栏被逐层收回；无浮动态返回 false 放行后续层
  dockTopFloatBack(): boolean {
    let topId = ''
    let topZ = -1
    for (const id of floatApi.floatMap.keys()) {
      const z = floatApi.zOf(id)
      if (z > topZ) {
        topZ = z
        topId = id
      }
    }
    if (!topId) return false
    onFloatDockBack(topId)
    return true
  },
  // 向当前活动终端发送一段文本（用于"在终端中打开"目录等场景）。
  // 高危命令同检（P-20261005-191）：本方法是 palette 命令直达插入链（命令历史
  // 检索命中项落位 / AI 助手「发送到终端」）的收口——命令串整体可知的干净输入，
  // 与粘贴链同过一道影响面确认卡（命中弹卡，确认才写入；取消返回 cancelled）
  async sendText(text: string): Promise<'sent' | 'cancelled' | 'no-pane'> {
    const pane = paneRefs.get(activeTabId.value)
    if (!pane) return 'no-pane'
    const ok = await gateTerminalInput(
      activeTabId.value,
      text,
      (raw) => { pane.writeInput(raw) },
    )
    return ok ? 'sent' : 'cancelled'
  },
  // 命令面板「运行书」入口（P-20261003-24）：打开运行书面板（互斥关其他浮层）；
  // TerminalView 随 bottomTab v-if 挂载，宿主侧有 ref 就绪重试
  openRunbookPanel() {
    showRunbookPanel.value = true
    closeOtherPanels('runbook')
  },
  // 按当前窗口尺寸重绘全部项目 pane（底部面板头部刷新按钮）：TerminalPane.fit(true)
  // 内含 safeFit（隐藏 pane 零尺寸守卫天然跳过）+ xterm 滚动区 refresh +
  // 行数抖动强制滚动区重同步 + 权威重绘
  redrawAllPanes() {
    for (const tb of tabs.value) {
      paneRefs.get(tb.id)?.fit(true)
    }
  },
})
</script>

<template>
  <!-- 最大化 z-index 与底部面板全屏同层（100）：高于业务内容、低于 naive 弹窗/
       通知/命令面板（2000+/1100/1000）——最大化后设置、通知等仍可浮层显示
       （原 99999 压过一切，点设置/通知都"没反应"）；右键菜单（100000）仍在其上 -->
  <div
    style="display: flex; flex-direction: column; height: 100%; position: relative; background: var(--bg-terminal)"
    :style="maximized ? {
      height: '100vh',
      position: 'fixed' as const,
      top: '0', left: '0', right: '0', bottom: '0',
      zIndex: 100,
    } : {}"
    @contextmenu="suppressNativeMenu"
  >
    <!-- 终端标签栏 + 工具栏（纯 UI 组件，业务动作上抛） -->
    <TerminalTabbar
      v-model:rename-value="renameValue"
      :tabs="projectTabs"
      :active-tab-id="activeTabId"
      :renaming-tab-id="renamingTabId"
      :font-size="fontSize"
      :font-rolling="fontRolling"
      :has-project="!!projectStore.currentProjectId"
      :show-history-panel="showHistoryPanel"
      :show-claude-panel="showClaudePanel"
      :show-snippet-panel="showSnippetPanel"
      :show-runbook-panel="showRunbookPanel"
      :show-session-overview="showSessionOverview"
      :session-groups="sessionGroups"
      :session-summary="sessionSummary"
      :effective-backend="effectiveBackend"
      :more-options="moreOptions"
      :suspended-ids="sessionsStore.managerAttached"
      :floating-ids="floatingTabIds"
      :dir-by-tab-id="dirByTabId"
      :active-dir="activeDir"
      :broadcast-mode="broadcastMode"
      :broadcast-selected-ids="selectedTabIds"
      :unread-ids="unreadTabIds"
      :pinned-ids="sessionsStore.pinnedIds"
      :locked-ids="lockedTabIds"
      :live-titles="liveTabTitles"
      @locate-in-tree="locateActive"
      @select-tab="onSelectTab"
      @request-close="(id: string) => requestCloseTab(id)"
      @start-rename="startRename"
      @finish-rename="finishRename"
      @clear-rename="renamingTabId = ''"
      @tab-context="(ev: MouseEvent, tab: TermTab) => showTabContextMenu(ev, tab)"
      @tab-drag-start="(tab: TermTab, ev: DragEvent) => floatApi.onTabDragStart(tab, ev)"
      @tab-drag-end="(tab: TermTab, ev: DragEvent, outside: boolean) => floatApi.onTabDragEnd(tab, ev, outside)"
      @tab-drop="(dragId: string, targetId: string) => moveTabBefore(dragId, targetId)"
      @tab-file-path-drop="pastePathToTab"
      @create="createTerminal"
      @change-font="changeTerminalFontSize"
      @split="(d: 'horizontal' | 'vertical') => splitActiveTab(d)"
      @toggle-history="showHistoryPanel = !showHistoryPanel; closeOtherPanels('history')"
      @toggle-claude="showClaudePanel = !showClaudePanel; closeOtherPanels('claude')"
      @toggle-snippet="showSnippetPanel = !showSnippetPanel; closeOtherPanels('snippet')"
      @toggle-runbook="showRunbookPanel = !showRunbookPanel; closeOtherPanels('runbook')"
      @toggle-overview="showSessionOverview = !showSessionOverview"
      @more="(v: string) => onMoreSelect(v as MoreAction)"
      @jump="jumpToSession"
      @close-overview="showSessionOverview = false"
      @toggle-broadcast="broadcastMode ? exitBroadcastMode() : broadcastMode = true"
    />

    <!-- 广播输入条（P-20261003-288）：广播模式下挂在 tab 栏下方，一次发全部选中会话 -->
    <TerminalBroadcastBar
      v-if="broadcastMode"
      :target-count="targetIds.length"
      :agent-candidates="agentCandidates"
      :selected-agent-ids="selectedAgentIds"
      :remote-candidates="remoteCandidates"
      :selected-remote-ids="selectedRemoteIds"
      :send="sendBroadcast"
      :has-result="!!lastResult"
      :input-history="inputHistory"
      @exit="exitBroadcastMode"
      @toggle-agent="toggleAgent"
      @toggle-remote="toggleRemote"
      @view-result="showResultPanel = true"
    />

    <!-- 广播结果聚合面板（P-20261005-12）：发送成功自动展开一次（composable
         置 showResultPanel），可关；「查看结果」钮重开重拉尾部输出 -->
    <TerminalBroadcastResultPanel
      v-model:show="showResultPanel"
      :targets="resultTargets"
    />

    <!-- 终端内容区：空态 + 各 tab pane 布局（交互经 handlers 上抛）+ 历史片段浮层 -->
    <div style="flex: 1; position: relative; overflow: hidden">
      <TerminalEmptyState
        v-if="projectTabs.length === 0"
        @create="createTerminal"
      />

      <TerminalPanesArea
        :tabs="tabs"
        :active-tab-id="activeTabId"
        :current-project-id="projectStore.currentProjectId"
        :split-resizing="splitResizing"
        :scrollback-lines="currentScrollbackLines"
        :suspended-ids="sessionsStore.managerAttached"
        :float="floatApi"
        :pane-maximized="terminalPaneMaximized"
        :handlers="paneHandlers"
      />

      <!-- 命令历史面板（C1）：搜索 + 只看失败 + 插入不执行（主点击）；
           ▶ 副按钮插入并执行（P-20261003-61） -->
      <HistoryPanel
        v-if="showHistoryPanel && projectStore.currentProjectId"
        :project-id="projectStore.currentProjectId"
        @close="showHistoryPanel = false"
        @insert="insertToActiveTerminal"
        @insert-run="insertAndRunToActiveTerminal"
      />

      <!-- Claude 会话浮层（P5）：项目范围锁定；恢复 = 新开终端注入 claude --resume -->
      <ClaudeSessionPicker
        v-if="showClaudePanel && projectStore.currentProjectId"
        scope="project"
        :project-id="projectStore.currentProjectId"
        closable
        class="term-claude-panel"
        @close="showClaudePanel = false"
      />

      <!-- 命令片段选择器（C2）：点击插入（带 {{参数}} 时内联展开填写） -->
      <SnippetPicker
        v-if="showSnippetPanel"
        @close="showSnippetPanel = false"
        @insert="insertToActiveTerminal"
      />

      <!-- 运行书面板（P-20261003-24）：逐步发送到当前终端（插入不执行）+ 完成勾选；
           P-20261004-13 序贯运行（onFailure 语义，run 态由宿主执行器持有） -->
      <RunbookPanel
        v-if="showRunbookPanel"
        :run-state="runbookRunner.run.value"
        :tabs="tabs"
        @close="showRunbookPanel = false"
        @insert="insertToActiveTerminal"
        @run="onRunbookRun"
        @run-stop="onRunbookRunStop"
      />

      <!-- 书签列表浮层（P-20261004-16）：活跃 pane 的 scrollback 书签（内存态），
           行号 + 行摘要，点击滚动定位 -->
      <TerminalBookmarkPanel
        v-if="showBookmarkPanel"
        :session-id="bookmarkPanelSessionId"
        @close="showBookmarkPanel = false"
      />
    </div>

    <!-- 关闭终端二次确认（tmux 模式强调释放底层 session）；pending 审批警示
         （P-20261003-275）：待关会话有等待裁决的审批时附加警示 -->
    <TerminalCloseConfirm
      v-model:close-no-prompt="closeNoPrompt"
      :show="showCloseConfirm"
      :effective-backend="effectiveBackend"
      :pending-approval="closeConfirmPendingApproval"
      @confirm="confirmCloseTab"
      @cancel="cancelCloseTab"
    />

    <!-- split 取消拆分的运行中进程保全（P-20261004-145）：secondary 有命令在跑
         时两选——终止（原取消拆分语义）/ 转为独立 tab 保留。无「不再提示」 -->
    <TerminalPaneCloseConfirm
      :show="showPaneCloseConfirm"
      :pane-name="paneClosePaneName"
      :command="paneCloseCommand"
      @kill="confirmPaneClose"
      @keep="keepPaneAsTab"
      @cancel="cancelPaneClose"
    />

    <!-- Tab 右键菜单：置顶 / 重命名 / 复制会话 / 复制会话 ID / 浮动窗 / 直播分享·结束直播 / 输出快照 / 回放分享 / 导出输出 / 对比输出 / 敏感标记 / 收工摘要 / 书签列表 / 批量关闭 -->
    <TerminalTabContextMenu
      v-if="tabContextMenu"
      :x="tabContextMenu.x"
      :y="tabContextMenu.y"
      :floating="tabMenuFloating"
      :sensitive="tabMenuSensitive"
      :pinned="tabMenuPinned"
      :live="tabMenuLive"
      @action="(a: 'pin' | 'rename' | 'duplicate' | 'copySessionId' | 'close' | 'closeOthers' | 'closeRight' | 'closeAll' | 'float' | 'liveShare' | 'frozenShare' | 'replayShare' | 'exportOutput' | 'compareOutput' | 'markSensitive' | 'wrapUp' | 'bookmarkList') => handleTabContextAction(a)"
      @close="closeTabContextMenu"
    />

    <!-- 会话收工卡（P-20261004-35）：tab 右键「收工摘要」——命令账本四读数 + 最近任务进度 -->
    <TerminalWrapUpCard
      v-model:show="wrapUpShow"
      :tab="wrapUpTab"
      :project-id="wrapUpProjectId"
    />

    <!-- 会话输出对比（P-20261005-210）：tab 右键「对比输出…」——当前会话 ↔ 所选
         会话滚回文本 DiffEditor 快照对比（时点定格 + 行数摘要条） -->
    <TerminalCompareOutputModal
      v-model:show="compareShow"
      :current="compareCurrent"
    />

    <!-- pane 右键菜单：复制/粘贴/标记此行/导出/清屏重启/询问智能体此输出/失败命令交给 agent 修 -->
    <TerminalPaneContextMenu
      v-if="showContextMenu"
      :x="contextMenuX"
      :y="contextMenuY"
      :selection-length="getSelectionLength(contextMenuTabId)"
      :has-failed-command="!!getFailedCommandRecord(contextMenuTabId)"
      :bookmarker="contextMenuLine !== null"
      :bookmarked="menuLineBookmarked"
      @action="(a: 'copy' | 'copyAsCodeBlock' | 'paste' | 'copyAll' | 'copyLastOutput' | 'shareSelection' | 'sendClip' | 'askAgent' | 'fixWithAgent' | 'bookmarkLine' | 'export' | 'clearAndRestart' | 'redraw') => handleContextMenuAction(a)"
      @close="menuApi.closeContextMenu"
    />
  </div>
</template>

<style scoped>
/* 通用按钮反馈 */
button:active {
  transform: scale(0.94);
  transition: transform var(--motion-fast);
}

</style>
<style scoped>
/* Claude 会话浮层（P5）：与命令历史面板同款右侧浮层定位 */
.term-claude-panel {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 360px;
  max-width: 60%;
  z-index: 25;
  border-left: 1px solid var(--border-default);
  box-shadow: var(--shadow-pop-drawer);
}
</style>
