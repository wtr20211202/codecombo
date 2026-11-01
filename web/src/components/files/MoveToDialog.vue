<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { NModal, NSpin, NEmpty, NButton, NIcon, NInput } from 'naive-ui'
import { FolderOutline, SearchOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { collectProjectFileList } from '../../composables/projectFileList'

/**
 * 批量移动「移动到…」目录选择弹层（P-20261003-160）：多选右键入口的目标目录
 * 拾取面。目录清单复用 Quick Open 文件清单取数原语（collectProjectFileList，
 * 单请求快路径）派生全部父目录——空目录与依赖产物目录（node_modules 等
 * SKIP_DIRS）不在清单内，属可接受边界：移动目标通常是有文件的工作目录。
 * 纯选择器：确认后上抛 select(dirPath)，批量移动执行链在宿主（FileTreeView，
 * 与多选拖拽共用 moveEntries 的逐个 rename + 跳过报告语义）
 */
const props = defineProps<{
  show: boolean
  projectId: string
  /** 待移动条目路径（仅用于标题计数展示，执行链在宿主） */
  paths: string[]
}>()

const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
  (e: 'select', dirPath: string): void
}>()

const { t } = useI18n()

const loading = ref(false)
const dirs = ref<string[]>([])
const filter = ref('')
const selected = ref<string | null>(null)
// 无过滤词时展示上限：巨型仓库目录数可达千级，全量渲染徒增 DOM；
// 输入关键词即可收窄到全量结果
const RENDER_CAP = 300

const filtered = computed(() => {
  const q = filter.value.trim().toLowerCase()
  const hit = q ? dirs.value.filter(d => d.toLowerCase().includes(q)) : dirs.value
  return hit.slice(0, RENDER_CAP)
})
const truncated = computed(() => {
  const q = filter.value.trim().toLowerCase()
  const hit = q ? dirs.value.filter(d => d.toLowerCase().includes(q)) : dirs.value
  return hit.length > RENDER_CAP
})

function rowLabel(dir: string): string {
  return dir || t('fileTree.batchMove.root')
}

function choose(dir: string) {
  selected.value = dir
}

function confirm() {
  if (selected.value === null) return
  emit('select', selected.value)
}

async function loadDirs() {
  if (!props.projectId) return
  loading.value = true
  try {
    const { files } = await collectProjectFileList(props.projectId)
    // 文件路径逐级父目录去重即目录全集（含中间层）；根 '' 恒在首位
    const set = new Set<string>([''])
    for (const f of files) {
      const parts = f.path.split('/')
      for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join('/'))
    }
    dirs.value = [...set].sort((a, b) => {
      if (a === '') return -1
      if (b === '') return 1
      return a.localeCompare(b)
    })
  } catch { /* 清单失败退化为空列表 + 空态提示（弹层仍可关闭重试） */ } finally {
    loading.value = false
  }
}

watch(() => [props.show, props.projectId], ([show]) => {
  if (show) {
    filter.value = ''
    selected.value = null
    void loadDirs()
  }
})
</script>

<template>
  <n-modal
    :show="props.show"
    preset="card"
    :title="t('fileTree.batchMove.title', { n: props.paths.length })"
    :style="{ width: 'var(--modal-w-md)', maxWidth: '94vw' }"
    :bordered="false"
    class="move-to-modal"
    data-testid="move-to-modal"
    @update:show="emit('update:show', $event)"
  >
    <div class="move-to-body">
      <n-input
        v-model:value="filter"
        size="small"
        clearable
        :placeholder="t('fileTree.batchMove.searchPlaceholder')"
        data-testid="move-to-input"
      >
        <template #prefix>
          <n-icon size="14"><SearchOutline /></n-icon>
        </template>
      </n-input>
      <div class="move-to-list">
        <div
          v-if="loading"
          class="move-to-loading"
        >
          <n-spin size="small" />
        </div>
        <n-empty
          v-else-if="filtered.length === 0"
          :description="t('fileTree.batchMove.empty')"
          size="small"
          class="move-to-empty"
        />
        <template v-else>
          <div
            v-for="d in filtered"
            :key="d"
            class="move-to-dir"
            :class="{ selected: selected === d }"
            data-testid="move-to-dir"
            @click="choose(d)"
            @dblclick="choose(d); confirm()"
          >
            <n-icon
              size="14"
              color="var(--accent-blue-light)"
            >
              <FolderOutline />
            </n-icon>
            <span
              class="move-to-dir-path"
              :title="rowLabel(d)"
            >{{ rowLabel(d) }}</span>
          </div>
          <div
            v-if="truncated"
            class="move-to-truncated"
          >
            {{ t('fileTree.batchMove.truncated', { n: RENDER_CAP }) }}
          </div>
        </template>
      </div>
      <div class="move-to-footer">
        <n-button
          type="primary"
          size="small"
          :disabled="selected === null"
          data-testid="move-to-confirm"
          @click="confirm"
        >
          {{ t('fileTree.batchMove.confirm') }}
        </n-button>
      </div>
    </div>
  </n-modal>
</template>

<style scoped>
.move-to-body { display: flex; flex-direction: column; gap: 10px; }
.move-to-list {
  height: 320px; overflow-y: auto;
  border: 1px solid var(--border-default); border-radius: 4px;
}
.move-to-loading { display: flex; align-items: center; justify-content: center; height: 100%; }
.move-to-empty { display: flex; align-items: center; justify-content: center; height: 100%; }
.move-to-dir {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 10px; cursor: pointer; font-size: 13px;
  border-bottom: 1px solid var(--bg-panel);
}
.move-to-dir:hover { background: var(--bg-hover); }
.move-to-dir.selected { background: var(--bg-active, var(--bg-hover)); }
.move-to-dir-path {
  color: var(--text-body); min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.move-to-truncated {
  padding: 6px 10px; font-size: 11px; color: var(--text-dim);
}
.move-to-footer { display: flex; justify-content: flex-end; }
</style>
