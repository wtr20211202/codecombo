<script setup lang="ts">
import { ref, computed } from 'vue'
import { NButton, NIcon, NInput, NEmpty, NSpin, NPopconfirm } from 'naive-ui'
import { TrashOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import type { Runbook } from '../../api/client'

/**
 * 运行书列表区（自 RunbookPanel 按面板区拆分，纯搬运零逻辑改动）：
 * 搜索过滤 + 条目卡（标题/说明/失败即停徽标/步数 + popconfirm 删除）。
 * 打开与删除都上抛：openBook 切换显隐、deleteBook 需联动打开态清账
 * （doneSteps）与列表刷新，状态就近父面板持有。
 */
const props = defineProps<{ books: Runbook[]; loading: boolean }>()

const emit = defineEmits<{
  (e: 'open', book: Runbook): void
  (e: 'delete', book: Runbook): void
}>()

const { t } = useI18n()

const query = ref('')

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return props.books
  return props.books.filter(b =>
    b.title.toLowerCase().includes(q) ||
    (b.description || '').toLowerCase().includes(q),
  )
})
</script>

<template>
  <div class="runbook-filters">
    <n-input
      v-model:value="query"
      size="small"
      :placeholder="t('runbook.searchPlaceholder')"
      clearable
    />
  </div>
  <n-spin
    :show="loading"
    size="small"
    class="spin-fill"
  >
    <div class="runbook-list">
      <n-empty
        v-if="filtered.length === 0"
        :description="t('runbook.empty')"
        size="small"
        class="runbook-empty"
      />
      <div
        v-for="b in filtered"
        :key="b.id"
        class="runbook-item"
        @click="emit('open', b)"
      >
        <div class="runbook-item-top">
          <span
            class="runbook-item-title"
            :title="b.title"
          >{{ b.title }}</span>
          <n-popconfirm
            @positive-click="emit('delete', b)"
          >
            <template #trigger>
              <n-button
                size="tiny"
                quaternary
                type="error"
                class="runbook-item-del"
                :title="t('runbook.delete')"
                @click.stop
              >
                <template #icon>
                  <n-icon size="12">
                    <TrashOutline />
                  </n-icon>
                </template>
              </n-button>
            </template>
            {{ t('runbook.deleteConfirm', { title: b.title }) }}
          </n-popconfirm>
        </div>
        <div
          v-if="b.description"
          class="runbook-item-desc"
          :title="b.description"
        >
          {{ b.description }}
        </div>
        <div class="runbook-item-meta">
          <span
            v-if="b.onFailure === 'stop'"
            class="runbook-item-flag"
          >{{ t('runbook.onFailure') }}</span>
          <span>{{ t('runbook.stepsCount', { n: b.steps.length }) }}</span>
        </div>
      </div>
    </div>
  </n-spin>
</template>

<style scoped>
.runbook-filters { padding: 8px 10px; border-bottom: 1px solid var(--border-subtle); flex-shrink: 0; }
/* .runbook-list 在列表区与打开书步骤区（RunbookBookView）两处同名同款——
   scoped 边界各自带一份同值规则，改动需两边同步 */
.runbook-list { flex: 1; overflow-y: auto; padding: 4px 0; }
.runbook-empty { margin-top: 40px; }
.runbook-item { padding: 7px 10px; cursor: pointer; }
.runbook-item:hover { background: var(--bg-hover); }
.runbook-item-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
.runbook-item-title {
  flex: 1; min-width: 0;
  font-size: 12px; font-weight: 600; color: var(--text-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.runbook-item-del { flex-shrink: 0; }
.runbook-item-desc {
  margin-top: 2px;
  font-size: 10px; color: var(--text-muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.runbook-item-meta { margin-top: 2px; font-size: 10px; color: var(--text-dim); display: flex; align-items: center; gap: 6px; }
.runbook-item-flag {
  padding: 0 4px;
  border: 1px solid var(--accent-yellow-warm);
  border-radius: 4px;
  font-size: 9px;
  color: var(--accent-yellow-warm);
  flex-shrink: 0;
}
</style>
