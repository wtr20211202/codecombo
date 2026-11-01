<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { NIcon, NButton } from 'naive-ui'
import { ExpandOutline, ContractOutline, CloseOutline, NavigateOutline, RefreshOutline } from '@vicons/ionicons5'
import TerminalView from '@/views/terminal/TerminalView.vue'
import GitPanel from '@/views/git/GitPanel.vue'
import ConsoleView from '@/views/console/ConsoleView.vue'
import PreviewPanel from '@/views/preview/PreviewPanel.vue'
import ProblemsPanel from '@/views/problems/ProblemsPanel.vue'
import { useErrorLogStore } from '@/stores/errorLog'
import { useI18n } from '@/composables/useI18n'
import { useNarrowLayout } from '@/composables/useNarrowLayout'
import { panelList } from '@/panels/registry'
import type { BottomTab } from '@/composables/usePanelLayout'

const errorStore = useErrorLogStore()
const { t } = useI18n()
// 窄屏（P-20261019-7）：底栏不再是编辑器下方的窄条，而是覆盖主区的全高
// 抽屉（终端/编辑器二选一）——终端保留输入，是移动端与 agent 交互的主路径
const { narrow } = useNarrowLayout()

const props = defineProps<{
  bottomTab: BottomTab
  showBottomPanel: boolean
  bottomPanelHeight: number
  bottomPanelMaximized: boolean
  bottomPanelEditorMaximized: boolean
  ahead?: number
  behind?: number
}>()

const emit = defineEmits<{
  'update:bottomTab': [v: BottomTab]
  'update:showBottomPanel': [v: boolean]
  'update:bottomPanelMaximized': [v: boolean]
  'update:bottomPanelEditorMaximized': [v: boolean]
  startResize: [e: MouseEvent]
  openDiff: [file: { path: string; name: string; oldRef: string; newRef?: string }]
}>()

// 底部 Tab 来自面板注册表（web/src/panels/registry.ts）
const tabs = computed(() =>
  panelList('bottom-tab').map(p => ({
    key: p.id as BottomTab,
    label: p.labelRaw ?? (p.labelKey ? t(p.labelKey) : p.id),
    badge: p.badge?.() ?? 0,
  })),
)

// 暴露子组件 ref 给父组件（用于 UI 状态收集与恢复）
const terminalRef = ref<InstanceType<typeof TerminalView> | null>(null)
const gitPanelRef = ref<InstanceType<typeof GitPanel> | null>(null)

defineExpose({
  terminalRef,
  gitPanelRef,
})

// 切换到 console tab 时清零未读错误计数
watch(() => props.bottomTab, (v) => {
  if (v === 'console') errorStore.markAllRead()
})

// 终端重绘（头部刷新按钮，仅终端 tab 显示）：按当前窗口尺寸 fit 全部项目 pane
// + xterm 滚动区 refresh + tmux 权威重绘——滚轮上翻失灵/显示错乱的一键自愈
function redrawTerminal() {
  terminalRef.value?.redrawAllPanes()
}
</script>

<template>
  <div
    v-show="showBottomPanel"
    data-testid="bottom-panel"
    :class="['bottom-panel', {
      maximized: bottomPanelMaximized,
      'editor-maximized': bottomPanelEditorMaximized,
      'is-narrow': narrow,
    }]"
    :style="{ height: (narrow || bottomPanelMaximized || bottomPanelEditorMaximized) ? '100%' : bottomPanelHeight + 'px' }"
  >
    <!-- 拖拽调高仅桌面停靠形态有意义：窄屏是全高抽屉 -->
    <div
      v-if="!narrow"
      class="bottom-resize-handle"
      @mousedown="emit('startResize', $event)"
    />
    <div class="bottom-header">
      <div
        class="bottom-tabs"
        data-testid="bottom-tabs"
      >
        <NButton
          v-for="tab in tabs"
          :key="tab.key"
          size="tiny"
          quaternary
          :data-testid="'bottom-tab-' + tab.key"
          :type="bottomTab === tab.key ? 'primary' : 'default'"
          @click="emit('update:bottomTab', tab.key)"
        >
          {{ tab.label }}
          <span
            v-if="tab.key === 'console' && tab.badge > 0"
            class="console-unread-badge"
          >
            {{ tab.badge }}
          </span>
        </NButton>
      </div>
      <div class="bottom-actions">
        <!-- 终端重绘：仅终端 tab 显示（Git/控制台无此语义），置于最大化按钮左侧 -->
        <NButton
          v-if="bottomTab === 'terminal'"
          size="tiny"
          quaternary
          :title="t('terminal.redraw')"
          @click="redrawTerminal"
        >
          <template #icon>
            <NIcon><RefreshOutline /></NIcon>
          </template>
        </NButton>
        <!-- 两种最大化在窄屏已等价于覆盖主区（抽屉本身），只留关闭/重绘，
             避免同一形态两套按钮语义 -->
        <NButton
          v-if="!narrow"
          size="tiny"
          quaternary
          :title="bottomPanelEditorMaximized ? t('layout.restoreEditor') : t('layout.maximizeEditor')"
          :type="bottomPanelEditorMaximized ? 'primary' : 'default'"
          @click="emit('update:bottomPanelEditorMaximized', !bottomPanelEditorMaximized)"
        >
          <template #icon>
            <NIcon><ContractOutline v-if="bottomPanelEditorMaximized" /><NavigateOutline v-else /></NIcon>
          </template>
        </NButton>
        <NButton
          v-if="!narrow"
          size="tiny"
          quaternary
          :title="bottomPanelMaximized ? t('layout.restoreFullscreen') : t('layout.maximizeFullscreen')"
          @click="emit('update:bottomPanelMaximized', !bottomPanelMaximized)"
        >
          <template #icon>
            <NIcon><ExpandOutline v-if="!bottomPanelMaximized" /><ContractOutline v-else /></NIcon>
          </template>
        </NButton>
        <NButton
          size="tiny"
          quaternary
          data-testid="bottom-panel-close"
          :title="t('common.close')"
          @click="emit('update:showBottomPanel', false)"
        >
          <template #icon>
            <NIcon><CloseOutline /></NIcon>
          </template>
        </NButton>
      </div>
    </div>
    <div class="bottom-content">
      <TerminalView
        v-if="bottomTab === 'terminal'"
        ref="terminalRef"
      />
      <GitPanel
        v-else-if="bottomTab === 'git'"
        ref="gitPanelRef"
        :ahead="ahead ?? 0"
        :behind="behind ?? 0"
        @open-diff="(f: any) => emit('openDiff', f)"
      />
      <ConsoleView v-else-if="bottomTab === 'console'" />
      <PreviewPanel v-else-if="bottomTab === 'preview'" />
      <ProblemsPanel v-else-if="bottomTab === 'problems'" />
    </div>
  </div>
</template>

<style scoped>
.bottom-panel {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--bg-border);
  background: var(--bg-panel);
  min-height: 120px;
  max-height: 600px;
  position: relative;
}
.bottom-panel.maximized {
  max-height: none;
  position: fixed;
  inset: 0;
  z-index: 100;
}
/* 编辑器区域最大化：相对 .ide-body 定位（Layout.vue 中 .ide-body 有 position: relative），
   仅覆盖编辑器区域，保留左侧活动栏/顶部工具栏/底部状态栏可见可点 */
.bottom-panel.editor-maximized {
  max-height: none;
  position: absolute;
  inset: 0;
  z-index: 50;
}
/* 底部面板拖拽把手：命中区 8px + 常显横向握把纹（与侧栏把手同设计语言） */
.bottom-resize-handle {
  position: absolute;
  top: -4px;
  left: 0;
  right: 0;
  height: 8px;
  cursor: row-resize;
  z-index: 10;
}
.bottom-resize-handle::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 36px;
  height: 2px;
  border-radius: 1px;
  background: var(--border-default);
  opacity: 0.6;
  transition: background var(--motion-base), opacity var(--motion-base);
}
.bottom-resize-handle:hover::after {
  background: var(--accent-blue);
  opacity: 1;
}
.bottom-resize-handle:hover {
  background: color-mix(in srgb, var(--accent-blue) 14%, transparent);
}
.bottom-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 4px;
  border-bottom: 1px solid var(--bg-border);
}
.bottom-tabs { display: flex; gap: 2px; }
.bottom-actions { display: flex; gap: 2px; }
.bottom-content { flex: 1; overflow: hidden; }

/* 窄屏全高抽屉（P-20261019-7）：覆盖 .ide-body（Layout 中 position: relative），
   与编辑器二选一；终端保留完整输入区。maximized 在窄屏不再 fixed 到全视窗，
   否则会盖住底部切换器/顶栏——窄屏里「最大化」本就等价于抽屉形态 */
.bottom-panel.is-narrow {
  position: absolute;
  inset: 0;
  max-height: none;
  border-top: none;
  z-index: 40;
}
.bottom-panel.is-narrow.maximized,
.bottom-panel.is-narrow.editor-maximized {
  position: absolute;
  inset: 0;
}
.bottom-panel.is-narrow .bottom-header { padding: var(--space-1) var(--space-2); }
.bottom-panel.is-narrow .bottom-tabs {
  flex: 1 1 auto;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}
.bottom-panel.is-narrow .bottom-tabs::-webkit-scrollbar { display: none; }
.bottom-panel.is-narrow .bottom-actions { flex-shrink: 0; }

.console-unread-badge {
  display: inline-block;
  background: var(--console-badge-bg);
  color: var(--console-badge-fg);
  padding: 0 6px;
  border-radius: 8px;
  font-size: 10px;
  margin-left: 4px;
}
</style>
