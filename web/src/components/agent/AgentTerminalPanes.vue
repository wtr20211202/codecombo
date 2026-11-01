<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import { NButton, NIcon, useMessage } from 'naive-ui'
import { TerminalOutline } from '@vicons/ionicons5'
import TerminalPane from '../terminal/TerminalPane.vue'
import TerminalPaneContextMenu from '../terminal/TerminalPaneContextMenu.vue'
import AgentActivityPanel from './AgentActivityPanel.vue'
import { useI18n } from '../../composables/useI18n'
import { useTerminalContextMenu } from '../../composables/useTerminalContextMenu'
import { useSnippetShare } from '../../composables/useSnippetShare'
import { useClipRelay } from '../../composables/useClipRelay'
import { termInstances, getSelectionLength } from '../../composables/useTerminalInstances'
import { useTerminalSettings } from '../../composables/useTerminalSettings'
import { useTerminalThemeStore } from '../../stores/terminal-theme'
import { useTerminalSessionsStore } from '../../stores/terminal-sessions'
import { getTerminalWsUrl, terminalApi } from '../../api/domains/terminal'
import type { OscEvent } from '../../composables/useTerminalSession'
import type { AgentTermSession } from '../../composables/useAgentTerminal'
import type { TerminalSessionInfo } from '../../stores/terminal-sessions'

/**
 * 智能体终端右侧终端区（P-20261001-20 从 AgentTerminalView 拆出）：
 * 会话产出面板 + 被接管项目会话/系统会话的多 pane keep-alive 渲染 +
 * 空态引导 + 终端右键菜单（与项目终端同层能力）。
 * pane 引用与右键菜单在本组件内闭环；宿主经 fit* 暴露方法驱动 refit
 * （会话切换/悬浮窗展开/侧栏拖宽后的 xterm 滚动区同步自愈）。
 */
const props = defineProps<{
  /** 系统会话（useAgentTerminal 的 sessions，导出文件名查找用） */
  sessions: AgentTermSession[]
  activeId: string
  /** 右侧渲染中的会话 id（agent 或被接管的项目会话） */
  selectedId: string
  /** 当前选中且已接管的项目会话（接管中才在本页渲染——独占挂接） */
  selectedProjectSession: TerminalSessionInfo | null
  /** 全部被接管的项目会话（keep-alive 渲染，v-show 切换选中） */
  attachedProjectSessions: TerminalSessionInfo[]
  /** 惰性挂载集合 ∩ 全量系统会话（保持 store 排序） */
  mountedAgentSessions: AgentTermSession[]
  showActivity: boolean
  activitySessionId: string
  /** 侧栏列表页签（空态提示文案随页签变化） */
  managerListTab: 'terminals' | 'claude'
}>()

const emit = defineEmits<{
  /** 系统会话底层 shell 退出 */
  (e: 'exit', sessionId: string): void
  /** 项目会话底层 shell 退出 */
  (e: 'project-exit', sessionId: string): void
  (e: 'activity-close'): void
  (e: 'new'): void
}>()

const { t } = useI18n()
const terminalThemeStore = useTerminalThemeStore()
const sessionsStore = useTerminalSessionsStore()

// 系统会话 pane 引用表（惰性挂载：只渲染被选中过的系统会话 pane）
const paneRefs = new Map<string, InstanceType<typeof TerminalPane>>()
function setPaneRef(id: string) {
  return (el: unknown) => {
    if (el) paneRefs.set(id, el as InstanceType<typeof TerminalPane>)
    else paneRefs.delete(id)
  }
}

// 项目接管 pane 引用表（keep-alive：多个被接管的项目会话并存，v-show 切换——
// 单 pane 不带 :key 复用时改 sessionId prop 不会重连，表现为点击会话无法切换）
const projectPaneRefs = new Map<string, InstanceType<typeof TerminalPane>>()
function setProjectPaneRef(id: string) {
  return (el: unknown) => {
    if (el) projectPaneRefs.set(id, el as InstanceType<typeof TerminalPane>)
    else projectPaneRefs.delete(id)
  }
}

// 菜单动作的 pane 寻址：项目接管 pane（projectPaneRefs）或系统 pane
function paneFor(id: string): InstanceType<typeof TerminalPane> | null | undefined {
  return projectPaneRefs.get(id) || paneRefs.get(id)
}

/** 选区拖拽落点（P-20261003-162）：把上下文追加到指定会话输入行（不发 Enter）。
 *  pane 未挂载（未选中过/连接未就绪）返回 null，宿主侧轮询重试。 */
function insertTextFor(id: string, text: string): 'multi' | 'single' | null {
  return paneFor(id)?.insertText(text) ?? null
}

// 粘贴上传：截图/文件存服务端临时目录，路径文本贴入终端（claude code 等 CLI 读取）。
// kind=image 截图压缩链 / kind=file 白名单文件链（P-20261024-2）——同端点按字段分派
async function uploadPaste(file: File, kind: 'image' | 'file'): Promise<string | null> {
  const res = kind === 'image'
    ? await terminalApi.uploadPasteImage(file)
    : await terminalApi.uploadPasteFile(file)
  return (res as { data?: { path?: string } } | null)?.data?.path ?? null
}

// 显示失步权威重绘：tmux 后端 refresh-client 重发整屏，native 后端服务端
// no-op。pane 重新可见/宿主 fit 后由 TerminalPane 回调
function redrawTerminal(id: string): void {
  terminalApi.redraw(id).catch(() => {})
}

const shareSnippetApi = useSnippetShare()
const message = useMessage()
const menuApi = useTerminalContextMenu({
  termInstances,
  getActiveTabId: () => props.activeId,
  copySelection: async (id) => { paneFor(id)?.copySelection() },
  // 复制为代码块（P-20261003-270）：```bash 围栏 + 命令行头
  copyAsCodeBlock: (id) => { paneFor(id)?.copyAsCodeBlock() },
  paste: async (id) => { paneFor(id)?.pasteFromClipboard() },
  copyAll: async (id) => { paneFor(id)?.copyAll() },
  // 复制上一条命令输出（OSC 133 C/D 行号记账区间提取）
  copyLastOutput: (id) => { paneFor(id)?.copyLastOutput() },
  exportText: (id) => {
    const s = sessionsStore.projectSessions.find(ss => ss.id === id)
      || props.sessions.find(ss => ss.id === id)
    paneFor(id)?.exportAsText(s?.name || 'terminal')
  },
  // 全局终端语义：仅清屏显示，不重启 shell——重启会终止会话内运行中的任务
  clearAndRestart: (id) => { paneFor(id)?.clear() },
  // 右键菜单「刷新」：深度刷新（fit + 行数抖动强制滚动区重同步）
  redraw: (id) => { paneFor(id)?.fit(true) },
  // 分享选中文本为片段短链（P-20261002-71；无选区菜单项已禁用，此处静默兜底）
  shareSelection: (id) => {
    const sel = termInstances.get(id)?.term.getSelection()
    if (sel) shareSnippetApi.openShareSnippet(sel)
  },
  // 发送剪贴板到其他设备（P-20261008-3）：useClipRelay 现成发送链（读取/回退/
  // 32KB 前置拦截全复用，与命令面板 clip-send 同链）；与终端状态零耦合，
  // 不取选区不落 pane
  sendClip: () => { void useClipRelay(message).sendLocalClipboard() },
})
const {
  showContextMenu, contextMenuX, contextMenuY, contextMenuTabId,
  openContextMenu, handleContextMenuAction, onGlobalClickCloseMenu,
} = menuApi

// 菜单「复制」可用性：读共享实例的当前选区长度
function selectionLengthOf(id: string): number {
  return getSelectionLength(termInstances, id)
}

// 全局点击/右键/失焦时关闭右键菜单（capture phase，先于终端自身右键逻辑）
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

// scrollback 行数（设置 API）：项目接管 pane 与系统 pane 同源
const { currentScrollbackLines } = useTerminalSettings({
  hydrate: (data) => terminalThemeStore.hydrate(data),
})

/** 运行点/活动时间戳：OSC 133 事件写回统一 store（本页承载系统会话 + 被接管的项目会话） */
function onPaneOsc(ev: OscEvent, sessionId: string) {
  // R（附着重放边界）/A（prompt 开始）/G（P-20261005-233 断档元信息）只服务
  // 历史记账门控、提示符代记账与缺口标记判定，无运行点语义
  if (ev.type === 'R' || ev.type === 'A' || ev.type === 'G') return
  // D 携命令文本+退出码、E 携命令文本（P-20261004-37 停滞分诊的最近命令数据面）
  sessionsStore.reportOsc(sessionId, ev.type, { command: ev.command, exitCode: ev.exitCode })
}

// —— 宿主驱动的 refit 入口（xterm v6 滚动区同步自愈） ——
/** 系统会话 pane 深度 refit（会话切换后调用；fit(true) 内含 refresh + 行数抖动
 *  强制滚动区重同步——keep-alive pane 隐藏期写入的重放只有真实 resize 能重算） */
function fitSystemPane(id: string) {
  paneRefs.get(id)?.fit(true)
}
/** 任意 pane 常规 refit（侧栏拖宽后列数补齐） */
function fitFor(id: string) {
  paneFor(id)?.fit()
}
/** 强制 refit 全部系统 pane（悬浮窗展开/切回 docked 后的自愈，与会话切换同款处理） */
function fitAllSystem() {
  for (const p of paneRefs.values()) p.fit(true)
}

defineExpose({ fitSystemPane, fitFor, fitAllSystem, insertTextFor })
</script>

<template>
  <main class="atv-main">
    <!-- 会话产出面板（B3）：startHead..工作区 diff 摘要 -->
    <AgentActivityPanel
      v-if="showActivity && activitySessionId"
      :session-id="activitySessionId"
      @close="emit('activity-close')"
    />
    <!-- 被接管的项目会话：keep-alive 多 pane（按会话 id 键控，v-show 切换选中；
         TerminalPane 挂载经服务端重放恢复现场） -->
    <div
      v-for="ps in attachedProjectSessions"
      v-show="ps.id === selectedId"
      :key="ps.id"
      class="atv-pane"
    >
      <TerminalPane
        :ref="setProjectPaneRef(ps.id)"
        :session-id="ps.id"
        :ws-url-factory="getTerminalWsUrl"
        :upload-paste="uploadPaste"
        :scrollback-lines="currentScrollbackLines"
        :osc-hook="onPaneOsc"
        :resize-call="(id: string, rows: number, cols: number) => terminalApi.resize(id, rows, cols)"
        :redraw-call="redrawTerminal"
        @exit="emit('project-exit', ps.id)"
        @contextmenu="(e: MouseEvent) => openContextMenu(ps.id, e)"
      />
    </div>
    <!-- 系统会话：keep-alive（v-show 切换，切走不卸载现场） -->
    <template v-if="mountedAgentSessions.length > 0">
      <div
        v-for="s in mountedAgentSessions"
        v-show="s.id === activeId && !selectedProjectSession"
        :key="s.id"
        class="atv-pane"
      >
        <TerminalPane
          :key="s.id"
          :ref="setPaneRef(s.id)"
          :session-id="s.id"
          :ws-url-factory="getTerminalWsUrl"
          :upload-paste="uploadPaste"
          :scrollback-lines="currentScrollbackLines"
          :osc-hook="onPaneOsc"
          :resize-call="(id: string, rows: number, cols: number) => terminalApi.resize(id, rows, cols)"
          :redraw-call="redrawTerminal"
          @exit="emit('exit', s.id)"
          @contextmenu="(e: MouseEvent) => openContextMenu(s.id, e)"
        />
      </div>
    </template>
    <div
      v-else-if="attachedProjectSessions.length === 0"
      class="atv-empty"
    >
      <n-icon
        size="64"
        class="atv-empty-icon"
      >
        <TerminalOutline />
      </n-icon>
      <div class="atv-empty-hint">
        {{ managerListTab === 'claude' ? t('agentTerminal.emptyHintClaude') : t('agentTerminal.emptyHint') }}
      </div>
      <div class="atv-empty-actions">
        <n-button
          size="small"
          type="primary"
          @click="emit('new')"
        >
          {{ t('agentTerminal.newSession') }}
        </n-button>
      </div>
    </div>

    <!-- 终端右键菜单（复制/粘贴/清屏/导出，与项目终端同款组件；fixed 覆盖层，
         DOM 位置不依赖宿主层级。无项目归属不展示「询问智能体此输出」） -->
    <TerminalPaneContextMenu
      v-if="showContextMenu"
      :x="contextMenuX"
      :y="contextMenuY"
      :selection-length="selectionLengthOf(contextMenuTabId)"
      :restartable="false"
      :askable="false"
      @action="(a: 'copy' | 'copyAsCodeBlock' | 'paste' | 'copyAll' | 'copyLastOutput' | 'shareSelection' | 'sendClip' | 'askAgent' | 'fixWithAgent' | 'bookmarkLine' | 'export' | 'clearAndRestart' | 'redraw') => handleContextMenuAction(a)"
      @close="menuApi.closeContextMenu"
    />
  </main>
</template>

<style scoped>
.atv-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.atv-pane { flex: 1; min-height: 0; display: flex; flex-direction: column; }
/* TerminalPane 根元素实际类名是 .term-container.term-pane（非 .terminal-pane），
   flex:1 让 xterm 容器撑满 pane：ResizeObserver 随之 fit 增行、PTY/tmux 同步放大，
   否则容器只有内容高度，底部留大片空白 */
.atv-pane :deep(.term-pane) { flex: 1; min-height: 0; }

.atv-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
}
.atv-empty-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}
.atv-empty-icon { color: var(--text-dim); }
.atv-empty-hint { font-size: 13px; color: var(--text-muted); }
</style>
