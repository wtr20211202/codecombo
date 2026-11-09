<script setup lang="ts">
// Layout 主装配视图（roadmap M3.1）：script 的全部装配胶水已收敛到
// useLayoutShell（store 实例化 / 面板宿主 / 键盘监听 / 引导恢复 / 生命周期），
// 本文件只保留模板编排——新增行为请进对应 composable，不要回填此处。
import StatusBar from '../components/layout/StatusBar.vue'
import CloneModal from '../components/layout/CloneModal.vue'
import AddProjectModal from '../components/home/AddProjectDialog.vue'
import PushDialog from '../components/layout/PushDialog.vue'
import RemoveConfirmModal from '../components/layout/RemoveConfirmModal.vue'
import RemoteConsoleView from './remote/RemoteConsoleView.vue'
import ShareManagerView from './share/ShareManagerView.vue'
import DashboardView from './dashboard/DashboardView.vue'
import NotesView from './notes/NotesView.vue'
import DshConsoleView from '../components/tools/DshConsoleView.vue'
import CompareExperimentPanel from '../components/agent/CompareExperimentPanel.vue'
import AgentChainPanel from '../components/agent/AgentChainPanel.vue'
import AgentTerminal from '../components/agent/AgentTerminal.vue'
import ActivityBar from '../components/layout/ActivityBar.vue'
import TopBar from '../components/layout/TopBar.vue'
import HttpWarningBar from '../components/layout/HttpWarningBar.vue'
import GlobalOverlays from '../components/layout/GlobalOverlays.vue'
import InstanceSessionOverview from '../components/instance/InstanceSessionOverview.vue'
import InstanceFleetOverview from '../components/instance/InstanceFleetOverview.vue'
import InstanceNotifyOverview from '../components/instance/InstanceNotifyOverview.vue'
import FleetBulkAgentDialog from '../components/agent/FleetBulkAgentDialog.vue'
import ExportCenterModal from '../components/export/ExportCenterModal.vue'
import QrRelayModal from '../components/layout/QrRelayModal.vue'
import SessionReplayDeepLinkHost from '../components/claude/SessionReplayDeepLinkHost.vue'
import WorkspaceSnapshotModal from '../components/layout/WorkspaceSnapshotModal.vue'
import ShortcutsHelp from '../components/common/ShortcutsHelp.vue'
import HelpCenter from '../components/help/HelpCenter.vue'
import EditorArea from '../components/layout/EditorArea.vue'
import BottomPanel from '../components/layout/BottomPanel.vue'
import SidePanel from '../components/layout/SidePanel.vue'
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from '../composables/useI18n'
import { useLayoutShell } from '../composables/useLayoutShell'
import { useNarrowLayout } from '../composables/useNarrowLayout'
import { usePanelLayout } from '../composables/usePanelLayout'
import { useAgentTerminal } from '../composables/useAgentTerminal'
import { useInstanceStore } from '../stores/instance'
import { useTerminalStore } from '../stores/terminal'

const router = useRouter()
const { t } = useI18n()
const { narrow } = useNarrowLayout()

const {
  projectStore, fontStore, showInstanceDetail, wsDisconnectBarVisible,
  showAddModal, openSettings,
  sidePanelRef, sideView, showSidePanel, sidePanelWidth, commitLocation,
  openFileFromPanel, openInTerminal, searchInDir, openDiffFromPanel, openCompareWithBaseline,
  topBarRef, openCommandPalette, paletteInitialMode, showPushModal, showCloneModal, showTaskRunner, showRemoveProjectConfirm,
  editorAreaRef, groups, activeGroup, splitOpen, splitDirection, allOpenFiles,
  closeFileInGroup, switchFileInGroup, togglePinTabInGroup, updateContent, saveCurrentFile,
  saveCloseFileInGroup,
  revertFileInGroup,
  reloadFileWithEncoding, saveFileWithEncoding,
  openFileByPath, revealCurrentFileInTree, closeOtherTabsInGroup, closeAllTabsInGroup, closeTabsToRightInGroup,
  closeSavedTabsInGroup, showSettingsModal,
  canReopenClosed, reopenClosedFile,
  openInSplitByPath, closeSplit, reorderGroupTabs, moveTabToGroup,
  draftOffer, applyDraftRestore, discardDraftRestore, previewDraftRestore,
  retryRemoteFile,
  remoteEverOpened, showRemoteConsole, remoteAutoHost,
  shareEverOpened, showShareManager,
  bottomPanelRef, bottomTab, showBottomPanel, bottomPanelHeight, bottomPanelMaximized,
  bottomPanelEditorMaximized, currentAheadBehind, startBottomResize,
  remoteLoading, buildInfo, onSync, copyRemoteUrl,
  showCommandPalette, showQuickOpen, showProjectSearch, projectSearchSeed, projectSearchGlobSeed, showOutline,
  showBookmarkList, showTerminalHistorySearch, showTerminalOutputSearch, showTerminalPorts, showSelfCheck,
  paletteFiles, paletteFilesLoading, paletteFilesTruncated, paletteRemoteFiles, paletteCommands, outlineContent, currentFile,
  showInstanceSessions, showInstanceFleet, showFleetNotify, showFleetBulkAgent, showShortcutsHelp, showHelpCenter, showQrRelay,
  showExportCenter, handleExportCenterNavigate,
  showClipboardHistory, pasteClipboardHistory,
  insertTerminalHistoryCommand,
  jumpToTerminalSession,
  handlePaletteCommand, handlePaletteOpenFile, handlePaletteOpenFileSplit, handlePaletteFallbackSearch, handleSearchOpenFile, fetchAllAheadBehind,
  showSnapshotManager, snapshotList, snapshotListLoading, restoreSnapshot, deleteSnapshot, renameSnapshot,
  startNewFileFromEditor, openClipboardDiff,
} = useLayoutShell()

// 窄屏（P-20261019-7）：从文件树抽屉选中文件后收起抽屉，把主区让给编辑器——
// 手机上一屏只有一栏，选中即看文件是抽屉式文件树的自然闭环
function onFileClickFromPanel(file: { path: string; name: string }): void {
  openFileFromPanel(file)
  if (narrow.value) showSidePanel.value = false
}

// 智能体 docked 管理页与编辑器/远程控制台/笔记等主区视图互斥（主区同一位置）
const { visible: agentVisible, mode: agentMode } = useAgentTerminal()
const agentDockedVisible = computed(() => agentVisible.value && agentMode.value === 'docked')
// dsh 控制台视图（P6）：懒挂载保活，与编辑器/远程/分享/agent 管理页互斥
// immediate（P-20261106-4）：showDshConsole 是 usePanelLayout 模块级状态，首页往返
// 重挂后已为 true——无「变化」可触发 watch，主区空壳而活动栏图标照常选中
const layoutForDsh = usePanelLayout()
const dshEverOpened = ref(false)
watch(() => layoutForDsh.showDshConsole.value, (v) => { if (v) dshEverOpened.value = true }, { immediate: true })

// 项目仪表盘视图（P-20261005-224）：懒挂载保活，与编辑器/远程/分享/dsh 互斥——
// 首开才挂载（挂载即取数），之后 v-show 切换；visible 直通仪表盘控制取数节奏
const dashboardEverOpened = ref(false)
watch(() => layoutForDsh.showDashboard.value, (v) => { if (v) dashboardEverOpened.value = true }, { immediate: true })

// ============== 多实例总览「去操作」意图消费（shell 会话） ==============
// instanceId 必检：意图设置时旧实例树仍挂载，只有与本实例匹配的意图才消费
// （跨实例切换时由新树 immediate watcher 消费）。requestSwitch 由 TerminalView
// 恢复流程重试选中（最多 3s），时序天然兜底
const instanceStore = useInstanceStore()
const terminalStore = useTerminalStore()
watch(() => instanceStore.pendingSessionJump, (j) => {
  if (!j || j.kind !== 'shell' || j.instanceId !== instanceStore.currentInstanceId) return
  instanceStore.consumeSessionJump()
  void (async () => {
    // 切换守卫取消（未保存草稿确认选「取消」，P-20261003-105）→ 跳转意图放弃：
    // 目标会话属另一项目，留在原项目时激活无落点
    if (j.projectId && (await projectStore.selectProjectExplicit(j.projectId)) === false) return
    terminalStore.requestSwitch(j.sessionId)
    layoutForDsh.showBottomPanel.value = true
    layoutForDsh.bottomTab.value = 'terminal'
    if (router.currentRoute.value.name !== 'project') void router.push({ name: 'project' })
  })()
}, { immediate: true })
</script>

<template>
  <div
    class="ide-root"
    :style="{ fontSize: fontStore.sizes.base + 'px' }"
  >
    <!-- 左侧工具栏 -->
    <ActivityBar
      :show-instance-detail="showInstanceDetail"
      @update:show-instance-detail="(v: boolean) => showInstanceDetail = v"
      @add-project="showAddModal = true"
      @open-settings="openSettings"
      @sessions="showInstanceSessions = true"
      @fleet="showInstanceFleet = true"
      @notify="showFleetNotify = true"
    />

    <!-- 左侧面板（项目文件/提交）：与主区视图解耦，远程控制台打开时保持可见 -->
    <SidePanel
      ref="sidePanelRef"
      :side-view="sideView"
      :show-side-panel="showSidePanel"
      :side-panel-width="sidePanelWidth"
      :commit-location="commitLocation"
      :font-size="fontStore.sizes.sidebar"
      @file-click="onFileClickFromPanel"
      @close="showSidePanel = false"
      @open-in-terminal="(p: string) => openInTerminal(p)"
      @open-diff="openDiffFromPanel"
      @compare-baseline="openCompareWithBaseline"
      @search-in-dir="(d: string) => searchInDir(d)"
      @open-in-split="openInSplitByPath"
      @update:side-panel-width="(w: number) => sidePanelWidth = w"
    />

    <!-- 主区域 -->
    <div class="ide-main">
      <!-- 顶部工具栏（常驻：主区在编辑器/远程控制台间切换时保持不变） -->
      <TopBar
        ref="topBarRef"
        @open-command-palette="openCommandPalette"
        @open-push-dialog="showPushModal = true"
        @show-clone-modal="showCloneModal = true"
        @show-task-runner="showTaskRunner = true"
        @show-remove-confirm="showRemoveProjectConfirm = true"
        @open-help="showHelpCenter = true"
        @open-qr-relay="showQrRelay = true"
      />

      <!-- HTTP 明文访问警示条（P-20261002-30）：非 loopback 主机名的 http 访问时提示
           启用 TLS（锁定态不显示——锁屏遮罩自带同款提示）；与下方断连指示条同为
           顶栏下细横条，按「安全警示 → 连接状态」顺序自然堆叠 -->
      <HttpWarningBar @open-help="showHelpCenter = true" />

      <!-- 全局断连指示条（P-20261002-5）：项目 WS 断开且已选项目时提示（锁定态不显示），
           恢复后立即消失；显隐节奏由 useWsDisconnectBar 管控（500ms 延迟显示防闪烁） -->
      <Transition name="ws-bar">
        <div
          v-if="wsDisconnectBarVisible"
          class="ws-disconnect-bar"
          data-testid="ws-disconnect-bar"
          role="status"
        >
          <span
            class="ws-disconnect-dot"
            aria-hidden="true"
          />
          <span>{{ t('conn.bar.disconnected') }}</span>
        </div>
      </Transition>

      <!-- 编辑器 ↔ 远程控制台/分享管理/dsh/仪表盘/笔记 ↔ 智能体管理页（互斥主区视图，
           v-show 保活：编辑器状态/WS 会话不丢）+ 底部面板（常驻：主区视图下底部面板仍可用） -->
      <div class="ide-body">
        <EditorArea
          v-show="!showRemoteConsole && !showShareManager && !agentDockedVisible && !layoutForDsh.showDshConsole.value && !layoutForDsh.showDashboard.value && !layoutForDsh.showNotesView.value"
          ref="editorAreaRef"
          :groups="groups"
          :active-group="activeGroup"
          :split-open="splitOpen"
          :split-direction="splitDirection"
          :show-commit-panel="commitLocation === 'sidebar' && showSidePanel && sideView === 'changes'"
          :can-reopen-closed="canReopenClosed"
          :draft-offer="draftOffer"
          @activate-group="(g) => activeGroup = g"
          @switch-file="switchFileInGroup"
          @close-file="closeFileInGroup"
          @save-close-file="saveCloseFileInGroup"
          @revert-file="revertFileInGroup"
          @update-content="updateContent"
          @toggle-pin="togglePinTabInGroup"
          @save-current-file="saveCurrentFile"
          @reload-with-encoding="reloadFileWithEncoding"
          @save-with-encoding="saveFileWithEncoding"
          @open-file="openFileByPath"
          @open-file-at="(p, i) => openFileByPath(p, { insertAt: i })"
          @new-file="startNewFileFromEditor"
          @open-command-palette="openCommandPalette"
          @open-project="showAddModal = true"
          @open-settings="showSettingsModal = true"
          @reveal-in-file-tree="revealCurrentFileInTree"
          @compare-clipboard="openClipboardDiff"
          @open-outline="showOutline = true"
          @close-other-tabs="closeOtherTabsInGroup"
          @close-all-tabs="closeAllTabsInGroup"
          @close-tabs-to-right="closeTabsToRightInGroup"
          @close-saved-tabs="closeSavedTabsInGroup"
          @reopen-closed-tab="reopenClosedFile"
          @drag-reorder="reorderGroupTabs"
          @tab-move="moveTabToGroup"
          @open-in-split="openInSplitByPath"
          @close-split="closeSplit"
          @draft-restore="applyDraftRestore"
          @draft-preview="previewDraftRestore"
          @draft-discard="discardDraftRestore"
          @remote-retry="retryRemoteFile"
        />
        <RemoteConsoleView
          v-if="remoteEverOpened"
          v-show="showRemoteConsole"
          class="remote-embedded"
          :auto-open-host-id="remoteAutoHost"
          @consume-auto-host="remoteAutoHost = ''"
        />
        <!-- 文件分享管理（主区视图，懒挂载保活） -->
        <ShareManagerView
          v-if="shareEverOpened"
          v-show="showShareManager"
          class="share-manager-embedded"
        />
        <!-- dsh 控制台（主区视图，懒挂载保活；iframe 经回环反代嵌入 dsh Web UI） -->
        <DshConsoleView
          v-if="dshEverOpened"
          v-show="layoutForDsh.showDshConsole.value"
          class="dsh-console-embedded"
        />
        <!-- 项目仪表盘（P-20261005-224，主区视图，懒挂载保活；visible 直通取数节奏） -->
        <DashboardView
          v-if="dashboardEverOpened"
          v-show="layoutForDsh.showDashboard.value"
          class="dashboard-embedded"
          :visible="layoutForDsh.showDashboard.value"
        />
        <!-- 笔记独立视图（P-20261108-2，主区第六占用者：占编辑器位，懒挂载保活；
             开态/互斥在 usePanelLayout，首页 overlay 形态由 HomeView 另挂一份） -->
        <NotesView />
        <!-- 分享族弹层四件（P-20261108-1）上提 App 层 ShareDialogsHost：
             首页/大屏等不经本 Layout 的入口同样弹得出（勿在此回挂——单例
             状态下双宿主 = 同屏两份弹层） -->
        <!-- 对比实验面板（P-20261003-46，命令面板/agent 管理页头部入口，全局单例状态） -->
        <CompareExperimentPanel />
        <!-- 会话接续链面板（P-20261004-38，agent 管理页头部入口，全局单例状态） -->
        <AgentChainPanel />
        <!-- 智能体（系统级多会话终端：docked 管理页内嵌主区 / 悬浮窗/悬浮条 Teleport；
             组件全局唯一，路由间互斥挂载） -->
        <AgentTerminal />
        <BottomPanel
          ref="bottomPanelRef"
          :bottom-tab="bottomTab"
          :show-bottom-panel="showBottomPanel"
          :bottom-panel-height="bottomPanelHeight"
          :bottom-panel-maximized="bottomPanelMaximized"
          :bottom-panel-editor-maximized="bottomPanelEditorMaximized"
          :ahead="currentAheadBehind.ahead"
          :behind="currentAheadBehind.behind"
          @update:bottom-tab="(v) => bottomTab = v"
          @update:show-bottom-panel="(v) => showBottomPanel = v"
          @update:bottom-panel-maximized="(v) => bottomPanelMaximized = v"
          @update:bottom-panel-editor-maximized="(v) => bottomPanelEditorMaximized = v"
          @start-resize="startBottomResize"
          @open-diff="openDiffFromPanel"
        />
      </div>

      <StatusBar
        v-if="projectStore.currentProject"
        :ahead="currentAheadBehind.ahead"
        :behind="currentAheadBehind.behind"
        :remote-loading="remoteLoading"
        :build-info="buildInfo"
        @sync="onSync"
        @copy-remote="copyRemoteUrl"
        @show-git="showBottomPanel = true; bottomTab = 'git'"
        @show-problems="showBottomPanel = true; bottomTab = 'problems'"
        @show-changes="sideView = 'changes'; showSidePanel = true"
      />
    </div>
  </div>

  <CloneModal
    v-model:show="showCloneModal"
    @cloned="projectStore.fetchProjects()"
  />

  <GlobalOverlays
    :palette-initial-mode="paletteInitialMode"
    :show-command-palette="showCommandPalette"
    :show-quick-open="showQuickOpen"
    :show-project-search="showProjectSearch"
    :project-search-seed="projectSearchSeed"
    :project-search-glob="projectSearchGlobSeed"
    :show-outline="showOutline"
    :show-task-runner="showTaskRunner"
    :show-bookmark-list="showBookmarkList"
    :show-clipboard-history="showClipboardHistory"
    :show-terminal-history-search="showTerminalHistorySearch"
    :show-terminal-output-search="showTerminalOutputSearch"
    :show-terminal-ports="showTerminalPorts"
    :show-self-check="showSelfCheck"
    :show-settings-modal="showSettingsModal"
    :palette-files="paletteFiles"
    :palette-remote-files="paletteRemoteFiles"
    :palette-files-loading="paletteFilesLoading"
    :palette-files-truncated="paletteFilesTruncated"
    :palette-project-id="projectStore.currentProjectId || ''"
    :palette-commands="paletteCommands"
    :recent-files="allOpenFiles.map(f => ({ name: f.name, path: f.path }))"
    :outline-content="outlineContent"
    :outline-path="currentFile?.path || ''"
    @update:show-command-palette="(v) => showCommandPalette = v"
    @update:show-quick-open="(v) => showQuickOpen = v"
    @update:show-project-search="(v) => showProjectSearch = v"
    @update:show-outline="(v) => showOutline = v"
    @update:show-task-runner="(v) => showTaskRunner = v"
    @update:show-bookmark-list="(v) => showBookmarkList = v"
    @update:show-clipboard-history="(v: boolean) => showClipboardHistory = v"
    @update:show-terminal-history-search="(v: boolean) => showTerminalHistorySearch = v"
    @update:show-terminal-output-search="(v: boolean) => showTerminalOutputSearch = v"
    @update:show-terminal-ports="(v: boolean) => showTerminalPorts = v"
    @update:show-self-check="(v: boolean) => showSelfCheck = v"
    @update:show-settings-modal="(v) => showSettingsModal = v"
    @palette-command="handlePaletteCommand"
    @palette-open-file="handlePaletteOpenFile"
    @palette-open-file-split="handlePaletteOpenFileSplit"
    @palette-fallback-search="handlePaletteFallbackSearch"
    @search-open-file="(path: string, line?: number) => handleSearchOpenFile(path, line)"
    @settings-saved="fetchAllAheadBehind"
    @outline-navigate="(line: number) => handleSearchOpenFile(currentFile?.path || '', line)"
    @bookmark-navigate="(path: string, line: number) => handleSearchOpenFile(path, line)"
    @clipboard-pick="pasteClipboardHistory"
    @terminal-history-insert="insertTerminalHistoryCommand"
    @terminal-output-jump="jumpToTerminalSession"
    @terminal-ports-jump="jumpToTerminalSession"
  />

  <!-- 多实例会话总览（命令面板「多实例会话总览」入口） -->
  <InstanceSessionOverview
    :show="showInstanceSessions"
    @update:show="(v: boolean) => showInstanceSessions = v"
    @manage="showInstanceSessions = false; showInstanceDetail = true"
  />

  <!-- 实例族总览（P-20261003-56：命令面板「实例族总览」+ 实例菜单入口，同宿主姊妹弹层） -->
  <InstanceFleetOverview
    :show="showInstanceFleet"
    @update:show="(v: boolean) => showInstanceFleet = v"
    @notify="showInstanceFleet = false; showFleetNotify = true"
  />

  <!-- 跨实例通知聚合（P-20261003-125：命令面板/实例菜单/族总览联动入口，同宿主姊妹弹层） -->
  <InstanceNotifyOverview
    :show="showFleetNotify"
    @update:show="(v: boolean) => showFleetNotify = v"
  />

  <!-- 舰队批量发起（P-20261003-291：命令面板「批量 agent 任务」入口，同宿主姊妹弹层） -->
  <FleetBulkAgentDialog
    :show="showFleetBulkAgent"
    @update:show="(v: boolean) => showFleetBulkAgent = v"
  />

  <!-- 导出中心（P-20261003-266：命令面板「导出中心」入口，同宿主姊妹弹层）：
       域「前往」经 handleExportCenterNavigate 跳对应域 -->
  <ExportCenterModal
    :show="showExportCenter"
    @update:show="(v: boolean) => showExportCenter = v"
    @navigate="handleExportCenterNavigate"
  />

  <!-- 二维码接力（命令面板/顶栏「在手机上打开」入口） -->
  <QrRelayModal
    :show="showQrRelay"
    @update:show="(v: boolean) => showQrRelay = v"
  />

  <!-- 回放深链消费宿主（P-20261003-154）：?session=&turn= 直达回放弹层，
       状态与消费时序在 useSessionReplayDeepLink（模块单例），无面板接线 -->
  <SessionReplayDeepLinkHost />

  <!-- 工作现场存档（命令面板「恢复现场」入口）：列表 + 行内恢复/改名/删除 -->
  <WorkspaceSnapshotModal
    :show="showSnapshotManager"
    :snapshots="snapshotList"
    :list-loading="snapshotListLoading"
    @update:show="(v: boolean) => showSnapshotManager = v"
    @restore="restoreSnapshot"
    @delete="deleteSnapshot"
    @rename="renameSnapshot"
  />

  <!-- 快捷键备忘单（? 键呼出） -->
  <ShortcutsHelp v-model:show="showShortcutsHelp" />

  <!-- 帮助中心（顶栏 ? / 命令面板入口；内容与智能体查询同源 GET /api/help） -->
  <HelpCenter v-model:show="showHelpCenter" />

  <AddProjectModal
    v-model:show="showAddModal"
    @added="fetchAllAheadBehind"
  />

  <PushDialog
    v-model:show="showPushModal"
    @pushed="fetchAllAheadBehind"
  />
  <RemoveConfirmModal
    v-model:show="showRemoveProjectConfirm"
    @removed="projectStore.fetchProjects()"
  />
</template>

<style scoped src="./layout.css"></style>
