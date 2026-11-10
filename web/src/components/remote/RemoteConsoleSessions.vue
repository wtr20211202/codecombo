<script setup lang="ts">
import { NButton, NIcon, NTooltip } from 'naive-ui'
import { TerminalOutline, CloseOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { useLayoutLockStore } from '../../stores/layoutLock'
import type { RemoteHost } from '../../api/client'
import type { ConsoleTab } from '../../composables/useRemoteConsoleTabs'
import RemoteTerminalPane from '../terminal/RemoteTerminalPane.vue'
import AppLogo from '../common/AppLogo.vue'

// 远程控制台主区（自 RemoteConsoleView 按区块拆出，P-20261002-27）：
// 双空态之二（有主机无终端）+ 跨主机统一 tab 栏（可拖拽重排序，拖拽机械在本组件内，
// 数据重排上抛 reorder 由宿主对 tabs 数组 splice）+ pane 区（v-show 保活，终态遮罩可重开）。
// pane 实例引用经 setPaneRef 函数 prop 直通宿主注册表（paneRefs 宿主持有）。
const props = defineProps<{
  tabs: ConsoleTab[]
  activeTabId: string
  /** 创建中标记（终态遮罩「重开」按钮 loading） */
  creating: Record<string, boolean>
  /** 主机数（空态快捷操作显隐） */
  hostsCount: number
  /** 主区空态文案：区分「还没有主机」与「有主机无终端」 */
  mainEmptyText: string
  /** 空态快捷操作目标：第一台主机 */
  firstHost: RemoteHost | null
  /** pane 实例注册回调（宿主 paneRefs Map 的写入通道） */
  setPaneRef: (sessionId: string, el: unknown) => void
}>()

const emit = defineEmits<{
  (e: 'open-terminal', hostId: string): void
  (e: 'diagnose-host', host: RemoteHost): void
  (e: 'activate', sessionId: string): void
  (e: 'rename', tab: ConsoleTab): void
  (e: 'reopen', tab: ConsoleTab): void
  (e: 'close', tab: ConsoleTab): void
  (e: 'exit', sessionId: string): void
  (e: 'context-menu', sessionId: string, ev: MouseEvent): void
  (e: 'reorder', from: number, to: number): void
}>()

const { t } = useI18n()

// 终端区全局抑制浏览器原生右键菜单：pane 内由 TerminalPane 打开自家菜单；
// pane 外的缝隙/终态遮罩（右键原生菜单漏出即「双菜单」观感来源之一）只吞菜单不动作
function suppressNativeMenu(e: Event): void {
  e.preventDefault()
}

// ============== tab 拖拽重排序（XShell 式整理会话顺序） ==============

let dragTabIndex = -1
function onTabDragStart(tab: ConsoleTab, e: DragEvent) {
  // 布局锁定（P-20261003-180）：tab 重排统一短路（拖拽不启动），点击切换不受影响
  if (useLayoutLockStore().interceptDrag(e)) return
  dragTabIndex = props.tabs.indexOf(tab)
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    // Firefox 需要 setData 才会启动拖拽
    e.dataTransfer.setData('text/plain', tab.sessionId)
  }
}
function onTabDrop(target: ConsoleTab) {
  if (dragTabIndex < 0) return
  const to = props.tabs.indexOf(target)
  emit('reorder', dragTabIndex, to)
  dragTabIndex = -1
}
</script>

<template>
  <main class="remote-main">
    <!-- 双空态之二：有主机无终端 -->
    <div
      v-if="tabs.length === 0"
      class="remote-main-empty"
    >
      <AppLogo
        :size="56"
        :animated="true"
      />
      <div class="remote-main-empty-text">
        {{ mainEmptyText }}
      </div>
      <div
        v-if="hostsCount > 0"
        class="remote-quick"
      >
        <n-button
          size="small"
          :disabled="!firstHost"
          @click="firstHost && $emit('open-terminal', firstHost.id)"
        >
          <template #icon>
            <n-icon><TerminalOutline /></n-icon>
          </template>
          {{ t('remoteConsole.openFirst') }}
        </n-button>
        <n-button
          size="small"
          quaternary
          :disabled="!firstHost"
          @click="firstHost && $emit('diagnose-host', firstHost)"
        >
          {{ t('remoteConsole.diagnoseHost') }}
        </n-button>
      </div>
    </div>

    <template v-else>
      <!-- 跨主机统一 tab 栏（可拖拽重排序） -->
      <div class="remote-tabs">
        <div
          v-for="tab in tabs"
          :key="tab.sessionId"
          class="remote-tab"
          :class="{ 'is-active': tab.sessionId === activeTabId, 'is-ended': tab.state === 'ended' }"
          draggable="true"
          @click="$emit('activate', tab.sessionId)"
          @dblclick="$emit('rename', tab)"
          @dragstart="onTabDragStart(tab, $event)"
          @dragover.prevent
          @drop.prevent="onTabDrop(tab)"
        >
          <span class="remote-tab-dot" />
          <span
            class="remote-tab-title"
            :title="tab.title"
          >{{ tab.title }}</span>
          <n-tooltip
            v-if="tab.state === 'ended'"
            trigger="hover"
          >
            <template #trigger>
              <n-button
                size="tiny"
                type="primary"
                ghost
                class="remote-tab-reopen"
                @click.stop="$emit('reopen', tab)"
              >
                {{ t('remoteConsole.reopen') }}
              </n-button>
            </template>
            {{ t('remoteConsole.endedTip') }}
          </n-tooltip>
          <button
            class="remote-tab-close"
            :title="t('remoteConsole.closeTitle')"
            :aria-label="t('remoteConsole.closeTitle')"
            @click.stop="$emit('close', tab)"
          >
            <n-icon size="12">
              <CloseOutline />
            </n-icon>
          </button>
        </div>
      </div>

      <!-- pane 区：v-show 保活（会话在服务端共享，切 tab 不断连）。
           容器级吞掉原生右键菜单（pane 内走自家菜单，遮罩/缝隙不再漏出系统菜单） -->
      <div
        class="remote-panes"
        @contextmenu="suppressNativeMenu"
      >
        <div
          v-for="tab in tabs"
          v-show="tab.sessionId === activeTabId"
          :key="tab.sessionId"
          class="remote-pane-wrap"
        >
          <RemoteTerminalPane
            :ref="(el) => setPaneRef(tab.sessionId, el)"
            :host-id="tab.hostId"
            :session-id="tab.sessionId"
            :tmux-version="tab.tmuxVersion"
            :tmux-floor="tab.tmuxClipboardFloor"
            :active="tab.sessionId === activeTabId"
            :ended="tab.state === 'ended'"
            @exit="$emit('exit', $event)"
            @contextmenu="(e: MouseEvent) => $emit('context-menu', tab.sessionId, e)"
          />
          <!-- 终态遮罩提示（pane 保留最后画面） -->
          <div
            v-if="tab.state === 'ended'"
            class="remote-pane-ended"
          >
            <span>{{ t('remoteConsole.ended') }}</span>
            <n-button
              size="small"
              type="primary"
              :loading="creating[tab.hostId]"
              @click="$emit('reopen', tab)"
            >
              {{ t('remoteConsole.reopen') }}
            </n-button>
          </div>
        </div>
      </div>
    </template>

    <!-- 常用命令面板等主区浮层由宿主经 slot 注入（定位在 main 容器内） -->
    <slot />
  </main>
</template>

<style scoped src="../../views/remote/remote-console-view.css"></style>
