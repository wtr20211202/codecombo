<script setup lang="ts">
// 笔记单库化续迁横幅（P-20261108-3）：旧项目笔记启动期并入全局库时若笔记库已满
// （100 篇含回收站）即中止——零丢弃，滞留篇原样保留。本横幅是「面板提示 + 手动
// 续迁」的用户知情面：挂载拉一次只读计数（GET /notes/migration，零写盘），有
// 滞留才出现；「继续迁移」= POST 续迁（与启动期同一实现，幂等），有迁入即抛
// migrated 让宿主重拉清单，仍满额则保留横幅并提示腾空间。通知中心的满额告警
// （动作 panel:notes）直达本视图即落在这里
import { onMounted, ref } from 'vue'
import { NButton, useMessage } from 'naive-ui'
import { notesGlobalApi } from '../../api/client'
import { useI18n } from '../../composables/useI18n'

const emit = defineEmits<{ (e: 'migrated'): void }>()

const { t } = useI18n()
const message = useMessage()

const pending = ref(0)
const full = ref(false)
const running = ref(false)

/** 只读计数（失败静默隐藏——横幅是提示面，取数失败不打扰编辑） */
async function refresh(): Promise<void> {
  try {
    const res = await notesGlobalApi.migrationStatus()
    pending.value = res.data?.pending ?? 0
    full.value = !!res.data?.full
  } catch {
    pending.value = 0
  }
}

async function resume(): Promise<void> {
  if (running.value) return
  running.value = true
  try {
    const res = await notesGlobalApi.migrate()
    const d = res.data
    pending.value = d?.pending ?? 0
    full.value = !!d?.full
    if (d && d.migrated > 0) {
      message.success(t('notes.migration.resumed', { n: d.migrated }))
      emit('migrated')
    }
    if (pending.value > 0) {
      message.warning(t('notes.migration.stillPending', { n: pending.value }))
    }
  } catch (e) {
    message.error((e as { userMessage?: string }).userMessage || t('notes.migration.failed'))
  } finally {
    running.value = false
  }
}

onMounted(() => { void refresh() })

defineExpose({ refresh })
</script>

<template>
  <div
    v-if="pending > 0"
    class="nmb-bar"
    role="status"
    data-testid="notes-migration-banner"
  >
    <span class="nmb-text">{{ full ? t('notes.migration.pendingFull', { n: pending }) : t('notes.migration.pending', { n: pending }) }}</span>
    <NButton
      size="tiny"
      type="warning"
      secondary
      :loading="running"
      data-testid="notes-migration-resume"
      @click="resume"
    >
      {{ t('notes.migration.resume') }}
    </NButton>
  </div>
</template>

<style scoped>
.nmb-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 6px 10px;
  background: var(--bg-warn, var(--bg-hover));
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
}
.nmb-text {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--text-primary);
}
</style>
