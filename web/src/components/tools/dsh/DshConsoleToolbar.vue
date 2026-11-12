<script setup lang="ts">
import { NButton, NIcon, NSelect, NSpin, NTag } from 'naive-ui'
import {
  ArrowRedoOutline, ContractOutline, ExpandOutline, OpenOutline, RefreshOutline, SettingsOutline,
} from '@vicons/ionicons5'
import BrandIcon from '../../common/BrandIcon.vue'
import { useI18n } from '../../../composables/useI18n'

/**
 * dsh 控制台顶部紧凑 chrome（P-20261001-20 从 DshConsoleView 拆出的渲染层）：
 * 品牌 + 状态点 + 标题 + 目标切换 + 版本标签 + 刷新/新标签/最大化/关闭。
 * 状态与动作全部来自宿主（props 入 / emits 出），本组件不持有逻辑。
 */
const { t } = useI18n()

defineProps<{
  /** 工具栏 tooltip 展示的上游地址（token 已掩去） */
  displayUrl: string
  activeTargetId: string
  targetOptions: { label: string; value: string }[]
  /** null = 探测中 */
  available: boolean | null
  latencyMs: number | null
  /** 升级徽标（空串 = 无新版本） */
  upgradeBadge: string
  headerVersionLabel: string
  /** 当前 dsh 版本命中已知缺陷登记（P-20261111-2-S2）：标签转警示态并提示——
   *  嵌入页可能因该缺陷打不开，工具栏标签是用户唯一可见的自救入口 */
  knownIssue?: boolean
  maximizable: boolean
  maximized: boolean
  processRestarting: boolean
}>()

const emit = defineEmits<{
  (e: 'switch-target', id: string): void
  (e: 'open-target-manager'): void
  (e: 'open-versions'): void
  (e: 'restart-process'): void
  (e: 'refresh'): void
  (e: 'open-new-tab'): void
  (e: 'toggle-maximized'): void
  (e: 'close'): void
}>()
</script>

<template>
  <!-- 上游地址不再常驻展示（回环地址用户无需关心），收进标题 tooltip -->
  <div
    class="dsh-toolbar"
    :title="displayUrl"
  >
    <BrandIcon
      name="dsh"
      :size="14"
    />

    <span class="dsh-title">{{ t('dshConsole.title') }}</span>
    <n-select
      size="tiny"
      :value="activeTargetId"
      :options="targetOptions"
      :placeholder="t('dshConsole.localTarget')"
      style="width: 130px"
      @update:value="emit('switch-target', $event)"
    />
    <n-button
      size="tiny"
      quaternary
      :title="t('dshConsole.manageTargets')"
      @click="emit('open-target-manager')"
    >
      <template #icon>
        <n-icon size="12">
          <SettingsOutline />
        </n-icon>
      </template>
    </n-button>
    <span
      class="dsh-status"
      :class="{ ok: available === true, off: available === false }"
      :title="available === true ? t('dshConsole.statusOk') : t('dshConsole.notRunning')"
    />
    <span
      v-if="latencyMs !== null && available"
      class="dsh-latency"
    >{{ latencyMs }}ms</span>
    <n-tag
      size="tiny"
      :type="knownIssue ? 'error' : upgradeBadge ? 'success' : 'default'"
      round
      class="dsh-upgrade-tag"
      :title="knownIssue
        ? t('dshConsole.knownDefectTitle')
        : upgradeBadge ? t('dshConsole.upgradableTitle') : t('dshConsole.versionsTitle')"
      @click="emit('open-versions')"
    >
      {{ headerVersionLabel }}
    </n-tag>
    <div class="dsh-actions">
      <n-button
        v-if="!activeTargetId"
        size="tiny"
        quaternary
        :disabled="processRestarting"
        :title="t('dshConsole.restartProcess')"
        @click="emit('restart-process')"
      >
        <template #icon>
          <n-icon size="12">
            <n-spin
              v-if="processRestarting"
              :size="10"
            />
            <ArrowRedoOutline v-else />
          </n-icon>
        </template>
      </n-button>
      <n-button
        size="tiny"
        quaternary
        :title="t('dshConsole.refresh')"
        @click="emit('refresh')"
      >
        <template #icon>
          <n-icon size="12">
            <RefreshOutline />
          </n-icon>
        </template>
      </n-button>
      <n-button
        size="tiny"
        quaternary
        :title="t('dshConsole.openNewTab')"
        @click="emit('open-new-tab')"
      >
        <template #icon>
          <n-icon size="12">
            <OpenOutline />
          </n-icon>
        </template>
      </n-button>
      <n-button
        v-if="maximizable"
        size="tiny"
        quaternary
        :title="maximized ? t('dshConsole.restore') : t('dshConsole.maximize')"
        @click="emit('toggle-maximized')"
      >
        <template #icon>
          <n-icon size="12">
            <component :is="maximized ? ContractOutline : ExpandOutline" />
          </n-icon>
        </template>
      </n-button>
      <n-button
        size="tiny"
        quaternary
        :title="t('dshConsole.closeEsc')"
        @click="emit('close')"
      >
        <template #icon>
          <n-icon size="12">
            ×
          </n-icon>
        </template>
      </n-button>
    </div>
  </div>
</template>

<style scoped>
.dsh-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 10px;
  border-bottom: 1px solid var(--border-default);
  background: var(--bg-panel);
  flex-shrink: 0;
  cursor: default;
}
.dsh-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-status {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--text-dim); flex-shrink: 0;
}
.dsh-status.ok { background: var(--accent-green); }
.dsh-status.off { background: var(--accent-red); }
.dsh-latency { font-size: 10px; color: var(--text-dim); flex-shrink: 0; }
.dsh-upgrade-tag { cursor: pointer; flex-shrink: 0; }
.dsh-actions { display: flex; gap: 2px; flex-shrink: 0; }
</style>
