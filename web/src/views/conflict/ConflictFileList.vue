<script setup lang="ts">
import { NButton, NEmpty, NSpin } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'

/**
 * 冲突文件列表列（P-20261005-190 自 ConflictView 拆出，宿主守 500 行上限）：
 * 加载/空态/文件行 + 头部批量委派入口（整个冲突集打包单会话，rebase 长链
 * 主用；≥2 个文件才出——单文件场景与右侧工具条「交给智能体解决」等价）。
 * 纯展示：选中态经 props 注入，选择/委派事件回传宿主。
 */
defineProps<{
  files: string[]
  loading: boolean
  selected: string
}>()

const emit = defineEmits<{
  (e: 'select', file: string): void
  (e: 'delegate-batch'): void
}>()

const { t } = useI18n()
</script>

<template>
  <div style="width: 220px; border-right: 1px solid var(--border-default); overflow-y: auto">
    <!-- 批量委派入口（P-20261005-190） -->
    <div
      v-if="files.length > 1"
      style="padding: 6px 10px; border-bottom: 1px solid var(--border-default)"
    >
      <n-button
        size="tiny"
        type="warning"
        block
        data-test="conflict-agent-batch-btn"
        @click="emit('delegate-batch')"
      >
        {{ t('conflict.agent.delegateBatch') }}
      </n-button>
    </div>
    <div
      v-if="loading"
      style="padding: 20px; text-align: center"
    >
      <n-spin size="small" />
    </div>
    <div
      v-else-if="files.length === 0"
      style="padding: 20px; text-align: center"
    >
      <n-empty :description="t('conflict.noConflict')" />
    </div>
    <div
      v-for="file in files"
      :key="file"
      style="padding: 6px 12px; cursor: pointer; display: flex; align-items: center; gap: 8px; font-size: 13px; border-bottom: 1px solid var(--bg-panel)"
      :style="{ background: selected === file ? 'var(--bg-active)' : 'transparent' }"
      @click="emit('select', file)"
    >
      <span style="color: var(--accent-red); font-size: 11px; font-family: monospace">C</span>
      <span
        style="color: var(--text-body); overflow: hidden; text-overflow: ellipsis; white-space: nowrap"
        :title="file"
      >{{ file }}</span>
    </div>
  </div>
</template>
