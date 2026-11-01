<script setup lang="ts">
import { NModal } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import FileHistoryView from '../../views/changes/FileHistoryView.vue'

/**
 * 文件历史弹窗（复用 Git 面板的 FileHistoryView）：编辑器 Git 快捷操作、
 * 提交变更文件右键菜单等宿主共用一个封装，弹窗尺寸/文案在此收敛
 */
const props = defineProps<{
  show: boolean
  projectId: string
  file: string
}>()

const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
}>()

const { t } = useI18n()
</script>

<template>
  <n-modal
    :show="props.show"
    preset="card"
    :title="t('editor.fileHistoryTitle', { file })"
    :style="{ width: 'var(--modal-w-xl)', maxWidth: '94vw' }"
    :bordered="false"
    @update:show="emit('update:show', $event)"
  >
    <div class="fhm-body">
      <FileHistoryView
        v-if="projectId && file"
        :project-id="projectId"
        :file="file"
      />
    </div>
  </n-modal>
</template>

<style scoped>
.fhm-body { height: 68vh; display: flex; flex-direction: column; overflow: hidden; }
.fhm-body > :deep(*) { flex: 1; min-height: 0; }
</style>
