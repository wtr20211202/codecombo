<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useMessage } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { friendlyRemoteError } from '../../utils/remoteErrors'
import { hasBlockingOverlay } from '../../utils/overlayGuard'
import { useLockStore } from '../../stores/lock'
import { useRemoteHostStore } from '../../stores/remoteHost'
import { useRemoteOpsStore } from '../../stores/remoteOps'
import { useUIStateStore } from '../../stores/uiState'
import { usePanelLayout } from '../../composables/usePanelLayout'
import { useTerminalContextMenu } from '../../composables/useTerminalContextMenu'
import { useSnippetShare } from '../../composables/useSnippetShare'
import { useClipRelay } from '../../composables/useClipRelay'
import { termInstances, getSelectionLength } from '../../composables/useTerminalInstances'
import { remoteHostApi, type RemoteHost } from '../../api/client'
import { confirmDialog } from '../../composables/useDialog'
import {
  useRemoteConsoleTabs, type ConsoleTab, type RemotePaneApi,
} from '../../composables/useRemoteConsoleTabs'
import { useRemoteHostTransfer } from '../../composables/useRemoteHostTransfer'
import RemoteConsoleHeader from '../../components/remote/RemoteConsoleHeader.vue'
import RemoteConsoleSessions from '../../components/remote/RemoteConsoleSessions.vue'
import TerminalPaneContextMenu from '../../components/terminal/TerminalPaneContextMenu.vue'
import RemoteHostList, { type RemoteGroup } from '../../components/remote/RemoteHostList.vue'
import RemoteHostFormModal from '../../components/remote/RemoteHostFormModal.vue'
import RemoteFileManager from '../../components/remote/RemoteFileManager.vue'
import SnippetPicker from '../../components/terminal/SnippetPicker.vue'

/**
 * 远程控制台（B1）：项目页内嵌主区视图（ActivityBar/TopBar/首页/设置多入口进入，
 * 左侧工具栏保留，可随时切回 IDE 主视图；本组件保活，切走不断 WS 会话）。
 * 容器职责：状态持有与编排——
 * - 左侧主机列表（RemoteHostList）+ 主区（RemoteConsoleSessions：空态/tab 栏/pane 区）
 *   + 头部工具条（RemoteConsoleHeader）；tab 生命周期在 useRemoteConsoleTabs，
 *   主机导入导出在 useRemoteHostTransfer（均自本组件按区块拆出，P-20261002-27）
 * - tab 列表与目录分组持久化（uiState.remoteConsole），刷新恢复：WS 重连 + scrollback
 *   回放；服务端已 GC（重连预算耗尽 exit）→「会话已结束」终态可重开；主机已删静默移除
 * - 常用命令（片段）点击直接发送到当前激活终端执行（XShell 发送语义）
 * - 主机增删改/测试连接在本页内完成（RemoteHostFormModal），不跳设置页
 */

const props = defineProps<{
  /** 入口携参（?host=<id>）：自动为该主机开终端，消费后通知宿主清参 */
  autoOpenHostId?: string
  /** 独立模式（首页全屏 overlay 等）：头部显示关闭按钮，由宿主控制显隐 */
  standalone?: boolean
}>()

const emit = defineEmits<{
  (e: 'consume-auto-host'): void
  (e: 'close'): void
}>()

const { t } = useI18n()
const message = useMessage()

const remoteHostStore = useRemoteHostStore()
const remoteOps = useRemoteOpsStore()
const uiStateStore = useUIStateStore()
const lockStore = useLockStore()
// 视图可见性由面板布局状态持有（ActivityBar/TopBar/首页/设置多入口共享）
const { showRemoteConsole } = usePanelLayout()
// 终端主题 document 副作用已上移 App.vue 全局应用（原此处 useTerminalTheme()）

const tabs = ref<ConsoleTab[]>([])
const groups = ref<RemoteGroup[]>([])
const activeTabId = ref('')
const booting = ref(true)
const showSnippetPanel = ref(false)
// 主机侧栏折叠（终端全宽模式），持久化到 uiState.remoteConsole
const sidebarCollapsed = ref(false)

// 各 tab 终端实例（发送常用命令 + 右键菜单动作下发；能力与项目终端同层）
const paneRefs = new Map<string, RemotePaneApi>()
function setPaneRef(sessionId: string, el: unknown) {
  const pane = el as RemotePaneApi | null
  if (pane) paneRefs.set(sessionId, pane)
  else paneRefs.delete(sessionId)
}

// ============== tab 生命周期（开/关/重开/重命名/聚焦/计数，拆至 composable） ==============

const {
  creating, hostById, focusHost,
  openTerminal, reopenTab, closeTab, renameTab, onPaneExit,
} = useRemoteConsoleTabs({
  tabs,
  activeTabId,
  paneRefs,
  onOpenFileManager: (h) => {
    fileManagerHost.value = h
    showFileManager.value = true
  },
})

// ============== pane 右键菜单（与项目终端/Agent 终端同款组件与动作集） ==============
// 远程会话不清 shell 重启（重启需走「重开」流程），末项降级为纯「清屏」（restartable=false）
const shareSnippetApi = useSnippetShare()
const menuApi = useTerminalContextMenu({
  termInstances,
  getActiveTabId: () => activeTabId.value,
  copySelection: async (id) => { paneRefs.get(id)?.copySelection() },
  // 复制为代码块（P-20261003-270）：```bash 围栏 + 命令行头
  copyAsCodeBlock: (id) => { paneRefs.get(id)?.copyAsCodeBlock() },
  paste: async (id) => { paneRefs.get(id)?.pasteFromClipboard() },
  copyAll: async (id) => { paneRefs.get(id)?.copyAll() },
  // 复制上一条命令输出（OSC 133 C/D 行号记账区间提取）
  copyLastOutput: (id) => { paneRefs.get(id)?.copyLastOutput() },
  exportText: (id) => {
    const tab = tabs.value.find(tb => tb.sessionId === id)
    paneRefs.get(id)?.exportAsText(tab?.title || 'remote-terminal')
  },
  clearAndRestart: (id) => { paneRefs.get(id)?.clear() },
  // 右键菜单「刷新」：深度刷新（fit + 行数抖动强制滚动区重同步）——
  // light 链路的 refresh/scrollLines(0) 对 xterm v6 滚动区失步无效
  redraw: (id) => { paneRefs.get(id)?.fit(true) },
  // 分享选中文本为片段短链（P-20261002-71；无选区菜单项已禁用，此处静默兜底）
  shareSelection: (id) => {
    const sel = termInstances.get(id)?.term.getSelection()
    if (sel) shareSnippetApi.openShareSnippet(sel)
  },
  // 发送剪贴板到其他设备（P-20261008-3）：useClipRelay 现成发送链（读取/回退/
  // 32KB 前置拦截全复用，与命令面板 clip-send 同链）；与终端状态零耦合，
  // 不取选区不落 pane（同服务实例的远程会话同样可达，项不设宿主门控）
  sendClip: () => { void useClipRelay(message).sendLocalClipboard() },
})
const {
  showContextMenu, contextMenuX, contextMenuY, contextMenuTabId,
  openContextMenu, handleContextMenuAction, onGlobalClickCloseMenu,
} = menuApi

// 全局点击/右键/失焦时关闭右键菜单（capture phase，与项目终端同语义）
onMounted(() => {
  document.addEventListener('click', onGlobalClickCloseMenu, true)
  document.addEventListener('contextmenu', onGlobalClickCloseMenu, true)
  window.addEventListener('blur', menuApi.closeContextMenu)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onGlobalClickCloseMenu, true)
  document.removeEventListener('contextmenu', onGlobalClickCloseMenu, true)
  window.removeEventListener('blur', menuApi.closeContextMenu)
})

// ============== 持久化（uiState.remoteConsole：tabs + groups + 视图可见性） ==============

let restoreDone = false
function persistState() {
  if (!restoreDone) return
  void uiStateStore.saveRemoteConsoleState(
    tabs.value.map(tb => ({ hostId: tb.hostId, sessionId: tb.sessionId, title: tb.title, tmuxName: tb.tmuxName })),
    groups.value.map(g => ({ id: g.id, name: g.name, hostIds: [...g.hostIds] })),
    showRemoteConsole.value,
    sidebarCollapsed.value,
  )
}
watch(tabs, persistState, { deep: true })
watch(groups, persistState, { deep: true })
watch(showRemoteConsole, persistState)
watch(sidebarCollapsed, persistState)

// ============== tab 拖拽重排序 ==============
// 拖拽机械（dragstart/drop/拖拽索引）在 RemoteConsoleSessions 内，这里做数据重排
function onTabReorder(from: number, to: number) {
  const [moved] = tabs.value.splice(from, 1)
  if (!moved) return
  tabs.value.splice(to, 0, moved)
}

// ============== 常用命令直接发送（XShell 发送语义） ==============

function sendSnippet(command: string) {
  const pane = paneRefs.get(activeTabId.value)
  if (!pane || !pane.writeInput(command + '\r')) {
    message.warning(t('remoteConsole.sendNoTerminal'))
    return
  }
  showSnippetPanel.value = false
}

// ============== 页内主机管理（添加/编辑/删除/测试，XShell 会话管理器语义） ==============

const showHostForm = ref(false)
const editingHost = ref<RemoteHost | null>(null)

// 文件管理器（SFTP 浏览/上传下载/跨主机互传）
const showFileManager = ref(false)
const fileManagerHost = ref<RemoteHost | null>(null)

// ============== 主机导入 / 导出（换机迁移与备份；导出文件为口令加密信封） ==============

const { importing, exportHosts, onImportFile } = useRemoteHostTransfer()

function openCreateHost() {
  editingHost.value = null
  showHostForm.value = true
}

function onManageHost(payload: { hostId: string; key: 'edit' | 'test' | 'delete' | 'files' }) {
  const h = hostById(payload.hostId)
  if (!h) return
  if (payload.key === 'edit') {
    editingHost.value = h
    showHostForm.value = true
  } else if (payload.key === 'test') {
    void testHostConnection(h)
  } else if (payload.key === 'files') {
    fileManagerHost.value = h
    showFileManager.value = true
  } else {
    void removeHost(h)
  }
}

/**
 * 右键「测试连接」结果可视化：真实 SSH 拨号 + whoami（区别于绿色徽章的 TCP 端口探测），
 * 成功/失败都给 toast；认证/凭据解密失败时追加可行动提示
 */
async function testHostConnection(h: RemoteHost) {
  message.info(t('remoteConsole.testRunning'))
  const res = await remoteHostStore.test(h.id).catch((e: any) => {
    message.error(t('remoteConsole.testFailed', { msg: e?.userMessage || e?.message || '?' }))
    return null
  })
  if (!res) return
  if (res.ok) {
    message.success(t('remoteConsole.testOk', { whoami: res.whoami || '?', os: res.os || '?', arch: res.arch || '?' }))
    return
  }
  const msg = friendlyRemoteError(res.error || '', t)
  const hint = msg.includes('credential decrypt failed')
    ? ` ${t('remoteConsole.decryptFailHint')}`
    : msg.includes('auth rejected') || msg.includes('unable to authenticate')
      ? ` ${t('remoteConsole.authFailHint')}`
      : ''
  message.error(t('remoteConsole.testFailed', { msg }) + hint)
}

async function removeHost(h: RemoteHost) {
  const ok = await confirmDialog({
    title: t('deploy.host.deleteTitle'),
    content: t('deploy.host.deleteConfirm', { name: h.name }),
    type: 'warning',
  })
  if (!ok) return
  try {
    await remoteHostStore.remove(h.id)
    // 分组与打开中的 tab 同步清理：目录里不留幽灵 id，死会话不留终态 tab
    if (groups.value.some(g => g.hostIds.includes(h.id))) {
      groups.value = groups.value.map(g => ({ ...g, hostIds: g.hostIds.filter(id => id !== h.id) }))
    }
    for (const tb of tabs.value.filter(tb => tb.hostId === h.id)) closeTab(tb, { skipConfirm: true })
    message.success(t('deploy.host.deleted'))
  } catch (e: any) {
    message.error(e?.userMessage || e?.message || t('remoteConsole.deleteHostFailed'))
  }
}

// ============== 恢复流程 ==============

async function restoreTabs() {
  const saved = await uiStateStore.getRemoteConsoleState()
  const removedHost = saved.tabs.some(sb => !hostById(sb.hostId))
  tabs.value = saved.tabs
    .filter(sb => hostById(sb.hostId)) // 主机已删：静默移除
    .map(sb => ({ hostId: sb.hostId, sessionId: sb.sessionId, title: sb.title, tmuxName: sb.tmuxName, state: 'open' as const }))
  groups.value = saved.groups
  sidebarCollapsed.value = saved.sidebarCollapsed
  activeTabId.value = tabs.value[tabs.value.length - 1]?.sessionId || ''
  restoreDone = true
  // 刷新后自动回到远程视图：仅当确有可恢复的终端（open 标记 + 非空 tabs），
  // 避免纯视图标记把后续进入带进远程视图
  if (saved.open && saved.tabs.length > 0) showRemoteConsole.value = true
  if (removedHost) message.info(t('remoteConsole.removedHostToast'))
  void auditStaleSessions()
}

/** 恢复会话存活对账：服务端重启/会话过期后，持久化的 tab 指向的会话已不存在——
 *  直接挂 WS 只会经历 404 重试风暴，最后停在一个「重试」永不可能成功的假连接态。
 *  按 host 对账 listTerminals（对账失败视为存活，保守不动作），缺席会话直接标
 *  ended：保留 tab 位与「重开」入口（重开 = 新建会话，才有恢复可能） */
async function auditStaleSessions() {
  const byHost = new Map<string, string[]>()
  for (const tb of tabs.value) {
    const list = byHost.get(tb.hostId) || []
    list.push(tb.sessionId)
    byHost.set(tb.hostId, list)
  }
  const aliveByHost = new Map<string, Set<string>>()
  await Promise.allSettled([...byHost.keys()].map(async (hostId) => {
    try {
      const res = await remoteHostApi.listTerminals(hostId, { silent: true }) as unknown as { data?: { id: string }[] }
      aliveByHost.set(hostId, new Set((res.data || []).map(st => st.id)))
    } catch { /* 主机不可达等：对账失败，该 host 全部视为存活 */ }
  }))
  let stale = 0
  for (const tb of tabs.value) {
    const alive = aliveByHost.get(tb.hostId)
    if (alive && !alive.has(tb.sessionId)) {
      tb.state = 'ended'
      stale++
      // pane 可能已在恢复渲染时挂载并发起连接：终止其无效的重连尝试
      paneRefs.get(tb.sessionId)?.disconnect()
    }
  }
  if (stale > 0) message.info(t('remoteConsole.staleSessionsToast', { n: stale }), { duration: 6000 })
}

async function boot() {
  booting.value = true
  try {
    // 挂载时可能仍处锁定态（fetch 423 抛错）：boot 吞错，解锁 watch 会重跑
    await remoteHostStore.fetch()
    await restoreTabs()
  } catch { /* silent */ } finally {
    booting.value = false
  }
}

// 预选主机（设置卡片「终端」按钮 / palette「连接主机」命令等入口）：复用主机
// 卡片点击语义（P-20261005-218）——已有终端聚焦最近一条防重复开会话，无则新开。
// prop 可能在挂载前就已传入（路由携参 → Layout 挂载 → 视图挂载），所以除了
// watch 变化，boot 完成后还要补试一次；hostById 未命中（列表未就绪）时不消费，
// 等 boot 完成重试
function tryAutoOpen() {
  const hostId = props.autoOpenHostId
  if (!hostId || booting.value) return
  if (hostById(hostId)) {
    focusHost(hostId)
    emit('consume-auto-host')
  }
}
watch(() => props.autoOpenHostId, () => tryAutoOpen())
watch(booting, (v) => { if (!v) tryAutoOpen() })

onMounted(boot)

// 锁定态挂载时 fetch 423 失败：解锁后重拉（与 Layout 解锁 watch 同语义）
watch(() => lockStore.isLocked, (newVal, oldVal) => {
  if (oldVal && !newVal) void boot()
})

/** 空态快捷操作目标：第一台主机 */
const firstHost = computed<RemoteHost | null>(() => remoteHostStore.hosts[0] ?? null)
/** 主区空态文案：区分「还没有主机」与「有主机无终端」两种引导 */
const mainEmptyText = computed(() =>
  remoteHostStore.hosts.length === 0 ? t('remoteConsole.noHostsMain') : t('remoteConsole.noTabs'))

// 快捷键：Ctrl/Cmd+W 关当前 tab（与项目终端一致的直觉）；Esc 关片段面板
// （有弹窗时让位给弹窗自己的 Esc 处理）
function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape' && showSnippetPanel.value) {
    if (hasBlockingOverlay()) return
    showSnippetPanel.value = false
    e.preventDefault()
    return
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w' && !e.shiftKey) {
    const tab = tabs.value.find(tb => tb.sessionId === activeTabId.value)
    if (tab) {
      e.preventDefault()
      closeTab(tab)
    }
  }
}
onMounted(() => document.addEventListener('keydown', onKeyDown))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeyDown))
</script>

<template>
  <div class="remote-root">
    <RemoteConsoleHeader
      :sidebar-collapsed="sidebarCollapsed"
      :tabs-count="tabs.length"
      :hosts-count="remoteHostStore.hosts.length"
      :importing="importing"
      :snippet-active="showSnippetPanel"
      :standalone="props.standalone"
      @toggle-sidebar="sidebarCollapsed = !sidebarCollapsed"
      @toggle-snippet="showSnippetPanel = !showSnippetPanel"
      @diagnose-batch="remoteOps.openDiagCompare()"
      @export-hosts="exportHosts"
      @import-picked="onImportFile"
      @add-host="openCreateHost"
      @close="emit('close')"
    />

    <div class="remote-body">
      <!-- 左侧主机列表（目录分组 / 复制粘贴 / 拖拽移动 / 页内增删改；可折叠给终端全宽；
           P-20261030-3 卡片点击 = 编辑弹窗，开终端走卡片快捷钮/菜单 → open 事件） -->
      <RemoteHostList
        v-show="!sidebarCollapsed"
        v-model:groups="groups"
        :creating="creating"
        :booting="booting"
        @open="openTerminal"
        @add-host="openCreateHost"
        @manage-host="onManageHost"
      />

      <!-- 右侧主区（空态 / tab 栏 / pane 区；常用命令面板经 slot 注入 main 容器） -->
      <RemoteConsoleSessions
        :tabs="tabs"
        :active-tab-id="activeTabId"
        :creating="creating"
        :hosts-count="remoteHostStore.hosts.length"
        :main-empty-text="mainEmptyText"
        :first-host="firstHost"
        :set-pane-ref="setPaneRef"
        @open-terminal="openTerminal"
        @diagnose-host="(h: RemoteHost) => remoteOps.openDiagnose(h.id, h.name)"
        @activate="(id: string) => activeTabId = id"
        @rename="renameTab"
        @reopen="reopenTab"
        @close="closeTab"
        @exit="onPaneExit"
        @context-menu="(id: string, e: MouseEvent) => openContextMenu(id, e)"
        @reorder="onTabReorder"
      >
        <!-- 常用命令面板（sendMode：点击直接发送到当前激活终端执行） -->
        <SnippetPicker
          v-if="showSnippetPanel"
          :send-mode="true"
          class="remote-snippet-panel"
          @close="showSnippetPanel = false"
          @insert="sendSnippet"
        />
      </RemoteConsoleSessions>
    </div>

    <!-- 主机编辑弹窗（页内直接管理，与设置页共用） -->
    <RemoteHostFormModal
      v-model:show="showHostForm"
      :host="editingHost"
    />

    <!-- 远程文件管理器（SFTP：浏览/上传下载/删除重命名/跨主机互传） -->
    <RemoteFileManager
      v-model:show="showFileManager"
      :host="fileManagerHost"
    />

    <!-- pane 右键菜单：复制/粘贴/导出/清屏（与项目终端同款；远程会话不重启 shell，
         无项目归属不展示「询问智能体此输出」） -->
    <TerminalPaneContextMenu
      v-if="showContextMenu"
      :x="contextMenuX"
      :y="contextMenuY"
      :restartable="false"
      :askable="false"
      :selection-length="getSelectionLength(termInstances, contextMenuTabId)"
      @action="(a: 'copy' | 'copyAsCodeBlock' | 'paste' | 'copyAll' | 'copyLastOutput' | 'shareSelection' | 'sendClip' | 'askAgent' | 'fixWithAgent' | 'bookmarkLine' | 'export' | 'clearAndRestart' | 'redraw') => handleContextMenuAction(a)"
      @close="menuApi.closeContextMenu"
    />
  </div>
</template>

<style scoped src="./remote-console-view.css"></style>
