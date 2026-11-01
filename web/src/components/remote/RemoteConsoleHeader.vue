<script setup lang="ts">
import { ref } from 'vue'
import { NButton, NIcon, NTooltip } from 'naive-ui'
import {
  CloseOutline, AddOutline, BookmarkOutline,
  ChevronBackOutline, ChevronForwardOutline, StatsChartOutline,
} from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import AppLogo from '../common/AppLogo.vue'

// 远程控制台头部工具条（自 RemoteConsoleView 按区块拆出，P-20261002-27）：
// 标题 + 侧栏折叠 + 片段开关 + 批量巡检对比 + 主机导入/导出（含隐藏 file input）+
// 添加主机 + 独立模式关闭。纯展示 + 事件上抛：导入导出逻辑在 useRemoteHostTransfer（宿主接线）。
const props = defineProps<{
  /** 主机侧栏折叠态（仅控制图标方向与 tooltip 文案） */
  sidebarCollapsed: boolean
  /** 已开终端 tab 数（无 tab 时禁用片段开关） */
  tabsCount: number
  /** 主机数（无主机时禁用导出/巡检对比） */
  hostsCount: number
  /** 导入进行中（按钮 loading） */
  importing: boolean
  /** 片段面板开着（按钮高亮） */
  snippetActive: boolean
  /** 独立模式（首页全屏 overlay 等）：显示关闭按钮 */
  standalone?: boolean
}>()

const emit = defineEmits<{
  (e: 'toggle-sidebar'): void
  (e: 'toggle-snippet'): void
  (e: 'diagnose-batch'): void
  (e: 'export-hosts'): void
  (e: 'import-picked', file: File | null): void
  (e: 'add-host'): void
  (e: 'close'): void
}>()

const { t } = useI18n()

const importInput = ref<HTMLInputElement | null>(null)

function pickImport() {
  importInput.value?.click()
}

function onImportChange(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0] || null
  input.value = ''
  emit('import-picked', file)
}
</script>

<template>
  <!-- 轻量头：标题 + 管理主机入口（设置弹窗定位远程部署分区） -->
  <div class="remote-header">
    <div class="remote-header-left">
      <AppLogo :size="22" />
      <span class="remote-title">{{ t('remoteConsole.title') }}</span>
    </div>
    <div class="remote-header-actions">
      <n-tooltip trigger="hover">
        <template #trigger>
          <n-button
            size="small"
            quaternary
            :aria-label="props.sidebarCollapsed ? t('remoteConsole.expandSidebar') : t('remoteConsole.collapseSidebar')"
            @click="emit('toggle-sidebar')"
          >
            <template #icon>
              <n-icon><ChevronBackOutline v-if="!props.sidebarCollapsed" /><ChevronForwardOutline v-else /></n-icon>
            </template>
          </n-button>
        </template>
        {{ props.sidebarCollapsed ? t('remoteConsole.expandSidebar') : t('remoteConsole.collapseSidebar') }}
      </n-tooltip>
      <n-button
        size="small"
        quaternary
        :disabled="props.tabsCount === 0"
        :class="{ 'is-active': props.snippetActive }"
        @click="emit('toggle-snippet')"
      >
        <template #icon>
          <n-icon><BookmarkOutline /></n-icon>
        </template>
        {{ t('terminal.snippet.title') }}
      </n-button>
      <n-button
        size="small"
        quaternary
        :disabled="props.hostsCount === 0"
        data-testid="remote-diag-compare-btn"
        @click="emit('diagnose-batch')"
      >
        <template #icon>
          <n-icon><StatsChartOutline /></n-icon>
        </template>
        {{ t('remoteConsole.diagCompareBtn') }}
      </n-button>
      <n-button
        size="small"
        quaternary
        :disabled="props.hostsCount === 0"
        @click="emit('export-hosts')"
      >
        {{ t('remoteConsole.exportHosts') }}
      </n-button>
      <n-button
        size="small"
        quaternary
        :loading="props.importing"
        @click="pickImport"
      >
        {{ t('remoteConsole.importHosts') }}
      </n-button>
      <input
        ref="importInput"
        type="file"
        accept=".json,application/json"
        hidden
        @change="onImportChange"
      >
      <n-button
        size="small"
        quaternary
        @click="emit('add-host')"
      >
        <template #icon>
          <n-icon><AddOutline /></n-icon>
        </template>
        {{ t('remoteConsole.addHost') }}
      </n-button>
      <span
        v-if="props.standalone"
        class="remote-header-divider"
      />
      <n-button
        v-if="props.standalone"
        size="small"
        quaternary
        @click="emit('close')"
      >
        <template #icon>
          <n-icon><CloseOutline /></n-icon>
        </template>
        {{ t('common.close') }}
      </n-button>
    </div>
  </div>
</template>

<style scoped src="../../views/remote/remote-console-view.css"></style>
