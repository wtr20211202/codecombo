<script setup lang="ts">
/**
 * 替换历史面板（P-20261004-66，设置·安全新 tab）：批量替换历史闭环的产品内
 * 承载——每次替换自动留档（时间/pattern→replacement/文件数/处数/内嵌补丁），
 * 一键还原把改写过的文件回滚到替换前现场。数据自包含加载（show=true 拉取，
 * 与 SshKeysSettings 等子组件同惯例）；项目选择器默认跟随当前项目。
 * 展示规模有界：服务端每项目留档 ≤20 条（30 天 TTL），每条 changed 明细
 * 最多展示 8 个路径（超出折叠为计数），面板 DOM 规模有界。
 */
import { ref, watch, computed } from 'vue'
import { NButton, NSelect, NEmpty, NSpin, NTag, useMessage } from 'naive-ui'
import { RefreshOutline } from '@vicons/ionicons5'
import { NIcon } from 'naive-ui'
import { replaceApi, type ReplaceHistEntry } from '../../api/client'
import { useProjectStore } from '../../stores/project'
import { useI18n } from '../../composables/useI18n'
import { confirmDialog } from '../../composables/useDialog'

const props = defineProps<{ show: boolean }>()

const { t } = useI18n()
const message = useMessage()
const projectStore = useProjectStore()

const loading = ref(false)
const restoringId = ref('')
const projectId = ref('')
const entries = ref<ReplaceHistEntry[]>([])

const projectOptions = computed(() =>
  projectStore.projects
    .filter(p => p.valid !== false)
    .map(p => ({ label: p.name, value: p.id })),
)

// 每条目最多展开展示的改动路径数（超出折叠为「等 N 个文件」计数——
// 500 路径的替换不把面板打成千行 DOM）
const SHOWN_PATHS = 8

function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

async function load() {
  if (!projectId.value) {
    entries.value = []
    return
  }
  loading.value = true
  try {
    const res: any = await replaceApi.history(projectId.value)
    entries.value = Array.isArray(res?.data) ? res.data : []
  } catch { /* 拦截器已提示 */ entries.value = [] }
  finally { loading.value = false }
}

function onSelectProject(id: string) {
  projectId.value = id
  void load()
}

async function onRestore(entry: ReplaceHistEntry) {
  if (restoringId.value) return
  const ok = await confirmDialog({
    title: t('settings.security.replaceHistory.restoreConfirmTitle'),
    type: 'warning',
    content: entry.backupEmpty
      ? t('settings.security.replaceHistory.restoreEmptyBackupConfirm')
      : t('settings.security.replaceHistory.restoreConfirm'),
  })
  if (!ok || !projectId.value) return
  restoringId.value = entry.id
  try {
    const res: any = await replaceApi.restore(projectId.value, entry.id)
    const restored = res?.data?.restored?.length ?? 0
    const untracked = res?.data?.untracked ?? 0
    message.success(t('settings.security.replaceHistory.restored', { n: restored }))
    if (untracked > 0) {
      message.warning(t('settings.security.replaceHistory.untrackedNote', { n: untracked }))
    }
    await load()
  } catch (e: any) {
    message.error(e?.userMessage || e?.message || t('settings.security.replaceHistory.restoreFailed'))
  } finally {
    restoringId.value = ''
  }
}

// 打开面板时初始化项目选择（跟随当前项目，无则取首个），随后拉取历史
watch(() => props.show, (val) => {
  if (!val) return
  if (!projectId.value || !projectOptions.value.some(o => o.value === projectId.value)) {
    projectId.value = projectStore.currentProjectId
      && projectOptions.value.some(o => o.value === projectStore.currentProjectId)
      ? projectStore.currentProjectId
      : (projectOptions.value[0]?.value ?? '')
  }
  void load()
}, { immediate: true })
</script>

<template>
  <div
    class="tab-section"
    data-testid="replace-history-pane"
  >
    <p class="lock-now-desc">
      {{ t('settings.security.replaceHistory.desc') }}
    </p>
    <div class="rh-toolbar">
      <n-select
        :value="projectId"
        size="small"
        :options="projectOptions"
        :placeholder="t('settings.security.replaceHistory.projectPlaceholder')"
        style="width: 260px"
        data-testid="replace-history-project"
        @update:value="onSelectProject"
      />
      <n-button
        size="small"
        quaternary
        :title="t('common.refresh')"
        :aria-label="t('common.refresh')"
        :loading="loading"
        data-testid="replace-history-refresh"
        @click="load"
      >
        <n-icon><RefreshOutline /></n-icon>
      </n-button>
    </div>

    <n-spin
      :show="loading"
      size="small"
    >
      <n-empty
        v-if="!loading && entries.length === 0"
        :description="t('settings.security.replaceHistory.empty')"
        style="margin: 24px 0"
      />
      <div
        v-else
        class="rh-list"
        data-testid="replace-history-list"
      >
        <div
          v-for="e in entries"
          :key="e.id"
          class="rh-item"
          data-testid="replace-history-item"
        >
          <div class="rh-head">
            <span class="rh-time">{{ fmtTime(e.time) }}</span>
            <n-tag
              v-if="e.useRegex"
              size="tiny"
              :bordered="false"
            >{{ t('settings.security.replaceHistory.tagRegex') }}</n-tag>
            <n-tag
              v-if="e.caseSensitive"
              size="tiny"
              :bordered="false"
            >{{ t('settings.security.replaceHistory.tagCase') }}</n-tag>
            <n-tag
              v-if="e.wholeWord"
              size="tiny"
              :bordered="false"
            >{{ t('settings.security.replaceHistory.tagWord') }}</n-tag>
            <!-- 保留大小写（P-20261006-16）：选项快照随历史留档，徽标同族补齐 -->
            <n-tag
              v-if="e.preserveCase"
              size="tiny"
              :bordered="false"
            >{{ t('settings.security.replaceHistory.tagPreserve') }}</n-tag>
            <span style="flex: 1" />
            <n-button
              v-if="e.restorable"
              size="tiny"
              type="warning"
              :loading="restoringId === e.id"
              data-testid="replace-history-restore"
              @click="onRestore(e)"
            >
              {{ t('settings.security.replaceHistory.restore') }}
            </n-button>
            <n-tag
              v-else
              size="tiny"
              :bordered="false"
              type="default"
            >
              {{ t('settings.security.replaceHistory.notRestorable') }}
            </n-tag>
          </div>
          <div class="rh-pattern">
            <code class="rh-pattern-text">{{ e.pattern }}</code>
            <span class="rh-arrow">→</span>
            <code
              v-if="e.replacement"
              class="rh-pattern-text"
            >{{ e.replacement }}</code>
            <code
              v-else
              class="rh-pattern-text rh-deleted"
            >{{ t('settings.security.replaceHistory.deleted') }}</code>
          </div>
          <div class="rh-meta">
            {{ t('settings.security.replaceHistory.stats', { files: e.files, hits: e.hits }) }}
            <span
              v-if="e.skipped || e.conflicts"
              class="rh-meta-warn"
            > · {{ t('settings.security.replaceHistory.partial', { skipped: e.skipped ?? 0, conflicts: e.conflicts ?? 0 }) }}</span>
            <span
              v-if="e.patchTruncated"
              class="rh-meta-dim"
            > · {{ t('settings.security.replaceHistory.patchRefOnly') }}</span>
          </div>
          <div
            v-if="e.changed && e.changed.length > 0"
            class="rh-files"
          >
            <code
              v-for="f in e.changed.slice(0, SHOWN_PATHS)"
              :key="f.path"
              class="rh-file"
            >{{ f.path }}</code>
            <span
              v-if="e.changed.length > SHOWN_PATHS"
              class="rh-meta-dim"
            >{{ t('settings.security.replaceHistory.moreFiles', { n: e.changed.length - SHOWN_PATHS }) }}</span>
          </div>
        </div>
      </div>
    </n-spin>
  </div>
</template>

<style scoped src="./security-settings.css"></style>
<style scoped>
.rh-toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}
.rh-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  max-height: 480px;
  overflow-y: auto;
}
.rh-item {
  border: 1px solid var(--bg-border);
  border-radius: var(--radius-md);
  padding: var(--space-2) 10px;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.rh-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.rh-time {
  color: var(--text-secondary);
  font-size: 12px;
}
.rh-pattern {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.rh-pattern-text {
  background: var(--bg-hover);
  border-radius: var(--radius-sm);
  padding: 1px 6px;
  font-size: 12px;
  word-break: break-all;
}
.rh-arrow {
  color: var(--text-secondary);
}
.rh-deleted {
  text-decoration: line-through;
  opacity: 0.7;
}
.rh-meta {
  font-size: 12px;
  color: var(--text-secondary);
}
.rh-meta-warn {
  color: var(--accent-yellow);
}
.rh-meta-dim {
  color: var(--text-muted);
}
.rh-files {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}
.rh-file {
  font-size: var(--fs-meta-min, 11.5px);
  background: var(--bg-hover);
  border-radius: var(--radius-sm);
  padding: 0 5px;
  word-break: break-all;
}
</style>
