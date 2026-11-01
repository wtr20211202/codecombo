<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import { NModal, NSpin, NEmpty, NTag } from 'naive-ui'
import { fsAttributionApi, type FsAttributionEvent } from '../../api/domains/git'
import { useI18n } from '../../composables/useI18n'

/**
 * 文件改动来源归因弹窗（P-20261005-170）：该路径最近 N 条改动归因——时间、
 * 来源（命令窗/编辑器/未归因）、会话名与命令摘要、退出码、重叠歧义标注。
 * 数据是事件发生当时的服务端判定账面（fsattr 模块），只读不改任何状态。
 * 宿主：文件树右键（FileTreeView）与编辑器右键（MonacoEditor）
 */
const props = defineProps<{
  show: boolean
  projectId: string
  /** 项目相对路径（账面查询键） */
  file: string
}>()

const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
}>()

const { t } = useI18n()

const events = ref<FsAttributionEvent[]>([])
const loading = ref(false)
const loadFailed = ref(false)

function formatTs(iso: string): string {
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? iso : new Date(ms).toLocaleString()
}

function sourceLabel(source: string): string {
  if (source === 'command') return t('files.attribution.sourceCommand')
  if (source === 'editor') return t('files.attribution.sourceEditor')
  return t('files.attribution.sourceUnattributed')
}

function sourceType(source: string): 'success' | 'info' | 'default' {
  if (source === 'command') return 'success'
  if (source === 'editor') return 'info'
  return 'default'
}

async function fetchEvents() {
  if (!props.projectId || !props.file) return
  loading.value = true
  loadFailed.value = false
  try {
    const res = await fsAttributionApi.list(props.projectId, props.file, 50) as { data?: FsAttributionEvent[] }
    events.value = res.data || []
  } catch {
    // silent 拉取失败就地弱提示（账面只读，失败可重开重试，不打扰全局 toast）
    events.value = []
    loadFailed.value = true
  } finally {
    loading.value = false
  }
}

watch(() => [props.show, props.projectId, props.file], ([show]) => {
  if (show) void fetchEvents()
})
onMounted(() => {
  if (props.show) void fetchEvents()
})
</script>

<template>
  <n-modal
    :show="props.show"
    preset="card"
    :title="t('files.attribution.title', { file })"
    :style="{ width: 'var(--modal-w-lg)', maxWidth: '94vw' }"
    :bordered="false"
    class="fsattr-modal"
    data-testid="fs-attribution-modal"
    @update:show="emit('update:show', $event)"
  >
    <div class="fa-body">
      <div
        v-if="loading"
        class="fa-loading"
      >
        <n-spin size="small" />
      </div>
      <div
        v-else-if="loadFailed"
        class="fa-empty"
      >
        <n-empty :description="t('files.attribution.loadFailed')" />
      </div>
      <div
        v-else-if="events.length === 0"
        class="fa-empty"
      >
        <n-empty :description="t('files.attribution.empty')" />
      </div>
      <div
        v-else
        class="fa-list"
      >
        <div
          v-for="(ev, i) in events"
          :key="i"
          class="fa-item"
          :data-testid="'fsattr-item'"
        >
          <div class="fa-item-head">
            <span class="fa-ts">{{ formatTs(ev.at) }}</span>
            <n-tag
              size="tiny"
              :type="sourceType(ev.source)"
              :bordered="false"
            >
              {{ sourceLabel(ev.source) }}
            </n-tag>
            <span
              v-if="ev.op"
              class="fa-op"
            >{{ ev.op }}</span>
            <n-tag
              v-if="ev.overlap"
              size="tiny"
              type="warning"
              :bordered="false"
            >
              {{ t('files.attribution.overlap') }}
            </n-tag>
          </div>
          <div
            v-for="(attr, j) in ev.attributions || []"
            :key="j"
            class="fa-ref"
          >
            <span class="fa-session">{{ attr.sessionName || attr.terminalId }}</span>
            <span
              v-if="attr.running"
              class="fa-running"
            >{{ t('files.attribution.running') }}</span>
            <span
              v-else
              class="fa-exit"
              :class="{ failed: (attr.exitCode || 0) !== 0 }"
            >{{ t('files.attribution.exit', { code: attr.exitCode ?? 0 }) }}</span>
            <span
              v-if="attr.command"
              class="fa-cmd"
              :title="attr.command"
            >{{ attr.command }}</span>
          </div>
        </div>
      </div>
    </div>
  </n-modal>
</template>

<style scoped>
.fa-body { min-height: 200px; max-height: 60vh; display: flex; flex-direction: column; overflow: hidden; }
.fa-loading, .fa-empty { flex: 1; display: flex; align-items: center; justify-content: center; min-height: 200px; }
.fa-list { overflow-y: auto; }
.fa-item { padding: 8px 4px; border-bottom: 1px solid var(--border-default); }
.fa-item:last-child { border-bottom: none; }
.fa-item-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.fa-ts { font-size: 12px; color: var(--text-body); }
.fa-op { font-size: 11px; color: var(--text-dim); }
.fa-ref { display: flex; align-items: center; gap: 8px; margin-top: 4px; padding-left: 2px; flex-wrap: wrap; }
.fa-session { font-size: 12px; color: var(--text-secondary); }
.fa-cmd {
  font-size: 12px; color: var(--text-dim); font-family: var(--font-mono);
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.fa-running { font-size: 11px; color: var(--accent-blue); }
.fa-exit { font-size: 11px; color: var(--text-dim); }
.fa-exit.failed { color: var(--accent-orange); }
</style>
