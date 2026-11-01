<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NCheckbox, NIcon, NModal, createDiscreteApi } from 'naive-ui'
import { WarningOutline } from '@vicons/ionicons5'
import { useProjectStore } from '../../stores/project'
import { useThemeStore } from '../../stores/theme'
import { useI18n } from '../../composables/useI18n'
import { notifyProjectRemoved } from '../../composables/useRemoveProjectUndo'
import { useProjectSessionImpact } from '../../composables/useProjectSessionImpact'

const props = defineProps<{
  show: boolean
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  removed: []
}>()

const projectStore = useProjectStore()
const themeStore = useThemeStore()
const { t } = useI18n()

const { message } = createDiscreteApi(['message'], {
  configProviderProps: computed(() => ({
    theme: themeStore.naiveTheme,
    themeOverrides: themeStore.naiveOverrides,
  })),
})

const modelShow = computed({
  get: () => props.show,
  set: (v) => emit('update:show', v),
})

// 级联会话知会（P-20261003-145）：打开确认框瞬间拉一次会话快照再计数
const impactProjectId = computed(() => (props.show ? projectStore.currentProject?.id : undefined))
const { total: impactTotal, running: impactRunning, residentTotal: impactResidentAgents, refreshSnapshot } =
  useProjectSessionImpact(impactProjectId)

// 驻留智能体会话级联处置选项（P-20261006-36）：默认不勾（保守保留），每次
// 打开复位默认档
const closeResidentAgents = ref(false)
watch(() => props.show, (v) => {
  if (v) {
    closeResidentAgents.value = false
    refreshSnapshot()
  }
})

async function handleRemoveProject() {
  // 先取项目快照：removeProject 会把条目从列表滤掉并切走 currentProjectId
  const target = projectStore.currentProject
  if (!target) return
  try {
    await projectStore.removeProject(target.id, closeResidentAgents.value)
    // 成功 toast 升级为撤销通知（P-20261002-47）：闭包暂存 name/path 供原路恢复
    notifyProjectRemoved(message, { name: target.name, path: target.path })
    emit('update:show', false)
    emit('removed')
  } catch {
    // removeProject 走 store 无法传 silent；NModal 内用局部 message 兜底提示，确保用户可见
    message.error(t('layout.failRemove'))
  }
}
</script>

<template>
  <n-modal
    v-model:show="modelShow"
    preset="dialog"
    :title="t('layout.removeTitle')"
    type="warning"
    :mask-closable="false"
    :positive-text="t('layout.confirmRemove')"
    :negative-text="t('common.cancel')"
    @positive-click="handleRemoveProject"
  >
    <div style="color: var(--text-body); font-size: 13px">
      {{ t('layout.removeConfirmPrefix') }}
      <span style="color: var(--accent-red); font-weight: 500">{{ projectStore.currentProject?.name }}</span>
      {{ t('layout.removeConfirmSuffix') }}
    </div>
    <!-- 级联会话知会（P-20261003-145）：有会话才追加；有运行中的升级红色警示 -->
    <div
      v-if="impactTotal > 0"
      data-testid="remove-session-impact"
      class="session-impact"
      :class="{ 'session-impact-running': impactRunning > 0 }"
    >
      <NIcon
        v-if="impactRunning > 0"
        class="session-impact-icon"
        :size="14"
      >
        <WarningOutline />
      </NIcon>
      <span>{{ t('layout.removeSessionsTotal', { count: impactTotal }) }}</span>
      <span v-if="impactRunning > 0">{{ t('layout.removeSessionsRunning', { count: impactRunning }) }}</span>
    </div>
    <!-- 驻留智能体会话知会（P-20261006-36）：免项目绑定但工作目录在项目内的
         agent 会话；文案与终端会话区分、不带运行态（agent 会话几乎恒运行） -->
    <div
      v-if="impactResidentAgents > 0"
      data-testid="remove-resident-agents"
      class="session-impact"
    >
      <span>{{ t('layout.removeResidentAgents', { count: impactResidentAgents }) }}</span>
    </div>
    <!-- 级联处置选项（P-20261006-36）：默认不勾（保守保留，agent 可能正收尾） -->
    <n-checkbox
      v-if="impactResidentAgents > 0"
      v-model:checked="closeResidentAgents"
      data-testid="remove-close-resident-agents"
      class="close-resident"
    >
      {{ t('layout.removeCloseResidentAgents') }}
    </n-checkbox>
  </n-modal>
</template>

<style scoped>
.session-impact {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 8px;
  padding: 6px 10px;
  border-radius: 4px;
  background: var(--bg-panel);
  color: var(--text-secondary);
  font-size: 12px;
}

.session-impact-running {
  background: color-mix(in srgb, var(--accent-red) 12%, transparent);
  color: var(--accent-red);
  font-weight: 500;
}

.session-impact-icon {
  flex-shrink: 0;
}

/* 驻留智能体会话处置选项（P-20261006-36）：知会行下的独立勾选行 */
.close-resident {
  margin-top: 8px;
  font-size: 12px;
}
</style>
