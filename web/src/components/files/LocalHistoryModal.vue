<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import { NModal, NSpin, NEmpty, NButton, NIcon, useMessage } from 'naive-ui'
import { ArchiveOutline } from '@vicons/ionicons5'
import { fileHistoryApi, projectApi } from '../../api/client'
import DiffEditor from '../../views/editor/DiffEditor.vue'
import { useI18n } from '../../composables/useI18n'
import { confirmDialog } from '../../composables/useDialog'

/**
 * 本地文件历史弹窗（P-20261002-130，JetBrains Local History 式后悔药）：
 * 左列历史版本（新→旧），右面板 diff 对比（左 = 历史版，右 = 当前盘上内容），
 * 面板头部「恢复此版本」带确认——恢复前服务端自动对当前内容再做一次快照，
 * 回滚本身可再撤销。宿主：文件树右键（FileTreeView）与编辑器右键（MonacoEditor）
 */
const props = defineProps<{
  show: boolean
  projectId: string
  /** 项目相对路径（快照键） */
  file: string
}>()

const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
  /** 恢复成功（宿主可借此刷新树/git 徽标等磁盘态衍生物） */
  (e: 'restored'): void
}>()

const { t } = useI18n()
const message = useMessage()

interface Version {
  id: string
  ts: number
  size: number
}

const versions = ref<Version[]>([])
const loading = ref(false)
const selectedId = ref('')
const versionContent = ref('')
const versionLoading = ref(false)
const currentContent = ref('')
const currentMissing = ref(false)
const restoring = ref(false)

function formatTs(ms: number): string {
  return new Date(ms).toLocaleString()
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

async function fetchVersions() {
  if (!props.projectId || !props.file) return
  loading.value = true
  try {
    const res = await fileHistoryApi.list(props.projectId, props.file) as { data?: Version[] }
    versions.value = res.data || []
    // 默认选中最新一版，右侧 diff 即「上一版 ↔ 当前」
    selectedId.value = versions.value[0]?.id || ''
    if (selectedId.value) await selectVersion(selectedId.value)
    else {
      versionContent.value = ''
      await fetchCurrent()
    }
  } finally {
    loading.value = false
  }
}

async function fetchCurrent() {
  currentMissing.value = false
  try {
    const res = await projectApi.readFile(props.projectId, props.file, { silent: true }) as { data?: unknown }
    currentContent.value = typeof res?.data === 'string' ? res.data : ''
  } catch {
    // 文件已被删除：右侧呈现为空（diff 即整段「新增回来」）
    currentContent.value = ''
    currentMissing.value = true
  }
}

async function selectVersion(id: string) {
  selectedId.value = id
  versionLoading.value = true
  try {
    const [versionRes] = await Promise.all([
      fileHistoryApi.content(props.projectId, props.file, id, { silent: true }) as Promise<{ data?: string }>,
      fetchCurrent(),
    ])
    versionContent.value = versionRes?.data ?? ''
  } catch {
    versionContent.value = ''
    message.error(t('files.history.loadFailed'))
  } finally {
    versionLoading.value = false
  }
}

async function restoreSelected() {
  const v = versions.value.find(x => x.id === selectedId.value)
  if (!v || restoring.value) return
  if (!await confirmDialog({
    type: 'warning',
    title: t('files.history.restoreTitle'),
    content: t('files.history.restoreBody'),
  })) return
  restoring.value = true
  try {
    await fileHistoryApi.restore(props.projectId, props.file, v.id)
    message.success(t('files.history.restored'))
    emit('restored')
    // 列表随恢复联动（恢复前状态刚入档），并刷新右侧两侧取数
    await fetchVersions()
  } catch { /* 拦截器处理 */ } finally {
    restoring.value = false
  }
}

watch(() => [props.show, props.projectId, props.file], ([show]) => {
  if (show) void fetchVersions()
})
onMounted(() => {
  if (props.show) void fetchVersions()
})
</script>

<template>
  <n-modal
    :show="props.show"
    preset="card"
    :title="t('files.history.title', { file })"
    :style="{ width: 'var(--modal-w-xl)', maxWidth: '94vw' }"
    :bordered="false"
    class="local-history-modal"
    data-testid="local-history-modal"
    @update:show="emit('update:show', $event)"
  >
    <div class="lhm-body">
      <div
        v-if="loading"
        class="lhm-loading"
      >
        <n-spin size="small" />
      </div>
      <template v-else>
        <div
          v-if="versions.length === 0"
          class="lhm-empty"
        >
          <n-empty
            :description="t('files.history.empty')"
          >
            <template #icon>
              <n-icon><ArchiveOutline /></n-icon>
            </template>
          </n-empty>
        </div>
        <div
          v-else
          class="lhm-main"
        >
          <!-- 左列：版本列表（新→旧） -->
          <div class="lhm-versions">
            <div class="lhm-versions-head">
              {{ t('files.history.versions', { n: versions.length }) }}
            </div>
            <div class="lhm-version-list">
              <div
                v-for="v in versions"
                :key="v.id"
                class="lhm-version-item"
                :class="{ active: v.id === selectedId }"
                :data-testid="'lh-version-' + v.id"
                @click="selectVersion(v.id)"
              >
                <div class="lhm-version-ts">
                  {{ formatTs(v.ts) }}
                </div>
                <div class="lhm-version-size">
                  {{ formatSize(v.size) }}
                </div>
              </div>
            </div>
          </div>

          <!-- 右面板：头部「恢复此版本」+ diff（左 = 历史版，右 = 当前盘上内容） -->
          <div class="lhm-diff-pane">
            <div class="lhm-diff-head">
              <span
                v-if="currentMissing"
                class="lhm-current-missing"
              >{{ t('files.history.currentMissing') }}</span>
              <n-button
                size="tiny"
                type="warning"
                :loading="restoring"
                data-testid="lh-restore"
                @click="restoreSelected"
              >
                {{ t('files.history.restore') }}
              </n-button>
            </div>
            <div
              v-if="versionLoading"
              class="lhm-loading"
            >
              <n-spin size="small" />
            </div>
            <div
              v-else
              class="lhm-diff-host"
            >
              <DiffEditor
                :old-content="versionContent"
                :new-content="currentContent"
                :path="file"
                :old-label="t('files.history.sideOld')"
                :new-label="t('files.history.sideCurrent')"
              />
            </div>
          </div>
        </div>
      </template>
    </div>
  </n-modal>
</template>

<style scoped>
.lhm-body { height: 68vh; display: flex; flex-direction: column; overflow: hidden; }
.lhm-loading { flex: 1; display: flex; align-items: center; justify-content: center; }
.lhm-empty { flex: 1; display: flex; align-items: center; justify-content: center; }
.lhm-main { flex: 1; display: flex; min-height: 0; }
.lhm-versions {
  width: 280px; flex-shrink: 0; border-right: 1px solid var(--border-default);
  display: flex; flex-direction: column; overflow: hidden;
}
.lhm-versions-head {
  padding: 6px 10px; font-size: 12px; color: var(--text-dim);
  border-bottom: 1px solid var(--border-default); background: var(--bg-panel);
}
.lhm-version-list { flex: 1; overflow-y: auto; }
.lhm-version-item {
  padding: 6px 10px; cursor: pointer; border-bottom: 1px solid var(--bg-panel);
}
.lhm-version-item:hover { background: var(--bg-hover); }
.lhm-version-item.active { background: var(--bg-active); }
.lhm-version-ts { font-size: 12px; color: var(--text-body); }
.lhm-version-size { font-size: 11px; color: var(--text-dim); }
.lhm-diff-pane { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.lhm-diff-head {
  display: flex; justify-content: flex-end; align-items: center; gap: 8px;
  padding: 4px 8px; border-bottom: 1px solid var(--border-default);
  background: var(--bg-panel);
}
.lhm-current-missing { font-size: 11px; color: var(--text-dim); margin-right: auto; }
.lhm-diff-host { flex: 1; min-height: 0; }
</style>
