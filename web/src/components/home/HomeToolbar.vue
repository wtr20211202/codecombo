<script setup lang="ts">
import { NButton, NIcon, NInput, NSelect } from 'naive-ui'
import { CloudDownloadOutline, SearchOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'

/**
 * 首页工具栏：搜索 + 排序 + 一键全部拉取 + 计数（自 HomeView 抽出的纯 UI）。
 */
const searchQuery = defineModel<string>('search', { required: true })
const sortMode = defineModel<string>('sort', { required: true })

defineProps<{
  shown: number
  total: number
  sortOptions: Array<{ label: string; value: string }>
  // fetchingAll 全部拉取进行态：按钮转圈防重入（整批在服务端并发执行）
  fetchingAll?: boolean
}>()

defineEmits<{ (e: 'fetchAll'): void }>()

const { t } = useI18n()
</script>

<template>
  <div class="home-toolbar">
    <div class="toolbar-search">
      <n-icon
        size="14"
        class="toolbar-search-icon"
      >
        <SearchOutline />
      </n-icon>
      <n-input
        v-model:value="searchQuery"
        :placeholder="t('home.searchPlaceholder')"
        size="small"
        :bordered="false"
        class="toolbar-search-input"
      />
    </div>
    <n-select
      v-model:value="sortMode"
      :options="sortOptions"
      size="small"
      class="toolbar-sort"
    />
    <n-button
      size="small"
      class="toolbar-fetch-all"
      :loading="fetchingAll"
      :title="t('git.fetchAll.hint')"
      @click="$emit('fetchAll')"
    >
      <template #icon>
        <n-icon><CloudDownloadOutline /></n-icon>
      </template>
      {{ t('git.fetchAll.button') }}
    </n-button>
    <div class="toolbar-count">
      {{ shown }} / {{ total }}
    </div>
  </div>
</template>

<style scoped>
.home-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 20px;
  padding: 10px 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: 10px;
}

.toolbar-search {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  max-width: 360px;
  background: var(--bg-surface);
  border-radius: 6px;
  padding: 0 10px;
}

.toolbar-search-icon {
  color: var(--text-muted);
  flex-shrink: 0;
}

.toolbar-search-input {
  flex: 1;
}

.toolbar-search-input :deep(.n-input__input-el) {
  font-size: 13px !important;
}

.toolbar-sort {
  width: 140px;
  flex-shrink: 0;
}

.toolbar-fetch-all {
  flex-shrink: 0;
}

.toolbar-count {
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  margin-left: auto;
  padding-right: 4px;
}
</style>
