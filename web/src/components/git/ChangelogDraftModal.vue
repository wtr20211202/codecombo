<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NIcon, NInputNumber, NModal, NSelect, NSpin, useMessage } from 'naive-ui'
import { CopyOutline, SparklesOutline } from '@vicons/ionicons5'
import { logApi, tagApi } from '../../api/client'
import { useChangelogPolish } from '../../composables/useChangelogPolish'
import { useI18n } from '../../composables/useI18n'
import { useProjectStore } from '../../stores/project'
import { copyText } from '../../utils/clipboard'
import { buildChangelogDraft, type ChangelogCommit, type ChangelogDraft } from '../../utils/changelog'

/**
 * 变更日志草稿生成弹层（P-20261003-27）：git 面板工具条「生成变更日志」入口。
 * 选基线（最近 tag 的 `tags/<name>..HEAD` 区间 / 最近 N 天 --since）→ 复用既有
 * /log 端点拉区间提交（纯前端零 Go 改动）→ 按 conventional 前缀分组聚合
 * （utils/changelog.ts 纯函数）→ markdown 草稿预览 + 一键复制。
 * 区间上限 500 条由前端钳制（请求 MAX+1 精确判截断）并标注；
 * 「交给智能体润色」（P-20261004-73，二阶段占位的兑现）：把草稿经
 * useChangelogPolish 既有 ask 链一键发起润色会话（launchArgs 预填，草稿超
 * 500 字节保头截断注入，链路内部提示/打开 docked 管理页）。
 * 注意：应用未全局注册 naive-ui，组件必须显式 import（历史回归教训）。
 */
const props = defineProps<{
  show: boolean
}>()

const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
}>()

const message = useMessage()
const { t } = useI18n()
const projectStore = useProjectStore()
// 草稿润色发起链（P-20261004-73）：launchAskSession 家族复用，loading 态防重复
const { polishChangelog, polishing } = useChangelogPolish()

// 区间上限：请求 MAX+1 条，返回超出即截断到 MAX（精确判定，而非「恰满 500」误标）
const MAX_COMMITS = 500

// ============== 基线选择 ==============
interface TagOpt { name: string; ts: number }
const tags = ref<TagOpt[]>([])
const loadingTags = ref(false)
// 'days' 哨兵 = 按 N 天；tag 基线带 `tag:` 前缀（防 tag 名恰为 "days" 撞哨兵）
const baseline = ref('days')
const days = ref<number | null>(30)

const baselineOptions = computed(() => [
  ...tags.value.map(tg => ({ label: `🏷 ${tg.name}`, value: `tag:${tg.name}` })),
  { label: t('git.changelog.baselineDays'), value: 'days' },
])
const isDaysBaseline = computed(() => baseline.value === 'days')

async function loadTags(): Promise<boolean> {
  const pid = projectStore.currentProjectId
  if (!pid) { tags.value = []; return false }
  loadingTags.value = true
  try {
    const res: any = await tagApi.list(pid)
    const rows: any[] = res.data || []
    // 按打 tag 时间降序：「最近 tag」即首项（git tag -l 为字母序，需重排）
    tags.value = rows
      .map(r => ({ name: String(r.name || ''), ts: new Date(r.date).getTime() || 0 }))
      .filter(r => r.name)
      .sort((a, b) => b.ts - a.ts)
    return tags.value.length > 0
  } catch {
    tags.value = []
    return false
  } finally { loadingTags.value = false }
}

// ============== 区间拉取 + 聚合 ==============
const generating = ref(false)
const draft = ref<ChangelogDraft | null>(null)

function daysSinceIso(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)
}

async function generate() {
  const pid = projectStore.currentProjectId
  if (!pid || generating.value) return
  generating.value = true
  try {
    const params: { limit: number; branch?: string; since?: string } = { limit: MAX_COMMITS + 1 }
    let rangeLabel: string
    if (isDaysBaseline.value) {
      const n = Math.min(3650, Math.max(1, Number(days.value) || 30))
      days.value = n
      params.since = daysSinceIso(n)
      rangeLabel = t('git.changelog.rangeDays', { n })
    } else {
      const tag = baseline.value.slice(4)
      params.branch = `tags/${tag}..HEAD`
      rangeLabel = `${tag}..HEAD`
    }
    const res: any = await logApi.getLog(pid, params)
    const rows: any[] = res.data || []
    const truncated = rows.length > MAX_COMMITS
    const commits: ChangelogCommit[] = rows.slice(0, MAX_COMMITS)
      .map(c => ({ hash: String(c.hash || ''), subject: String(c.message || '').split('\n')[0] || '' }))
      .filter(c => c.subject.trim())
    draft.value = buildChangelogDraft({
      rangeLabel,
      commits,
      truncatedNote: truncated ? t('git.changelog.truncated', { n: MAX_COMMITS }) : '',
    })
  } catch {
    // 拦截器已弹后端原文；草稿区退化空态，不让弹层挂在旧草稿上
    draft.value = { markdown: '', empty: true, truncated: false }
  } finally { generating.value = false }
}

// ============== 复制 ==============
async function handleCopy() {
  if (!draft.value || draft.value.empty) return
  const ok = await copyText(draft.value.markdown)
  if (ok) message.success(t('common.copied'))
  else message.error(t('common.copyFailed'))
}

// ============== 交给智能体润色（P-20261004-73） ==============
async function handlePolish() {
  if (!draft.value || draft.value.empty) return
  await polishChangelog(draft.value.markdown)
}

// 每次打开复位草稿并拉 tag：默认基线 = 最近 tag，无 tag 仓库 fallback 最近 N 天，
// 就绪后自动生成一版（用户换基线后点「生成草稿」重算）
watch(() => props.show, async (v) => {
  if (!v) return
  draft.value = null
  const hasTags = await loadTags()
  baseline.value = hasTags ? `tag:${tags.value[0]!.name}` : 'days'
  void generate()
})
</script>

<template>
  <n-modal
    :show="props.show"
    preset="card"
    :title="t('git.changelog.title')"
    :style="{ width: 'var(--modal-w-lg)', maxWidth: '94vw' }"
    :bordered="false"
    :mask-closable="!generating"
    data-testid="changelog-modal"
    @update:show="emit('update:show', $event)"
  >
    <div class="changelog-toolbar">
      <span class="cl-label">{{ t('git.changelog.baseline') }}</span>
      <n-select
        v-model:value="baseline"
        :options="baselineOptions"
        size="small"
        style="width: 230px"
        :loading="loadingTags"
        data-testid="changelog-baseline"
      />
      <n-input-number
        v-if="isDaysBaseline"
        v-model:value="days"
        size="small"
        :min="1"
        :max="3650"
        style="width: 110px"
        data-testid="changelog-days"
      />
      <n-button
        size="small"
        type="primary"
        :loading="generating"
        data-testid="changelog-generate"
        @click="generate"
      >
        {{ t('git.changelog.generate') }}
      </n-button>
    </div>
    <div
      v-if="!loadingTags && tags.length === 0"
      class="changelog-notag-hint"
    >
      {{ t('git.changelog.noTags') }}
    </div>
    <div class="changelog-preview-wrap">
      <n-spin
        v-if="generating"
        size="small"
        class="changelog-spin"
      />
      <template v-else-if="draft">
        <div
          v-if="draft.truncated"
          class="changelog-truncated"
        >
          {{ t('git.changelog.truncated', { n: MAX_COMMITS }) }}
        </div>
        <pre
          v-if="!draft.empty"
          data-testid="changelog-preview"
          class="changelog-preview"
        >{{ draft.markdown }}</pre>
        <div
          v-else
          data-testid="changelog-empty"
          class="changelog-empty"
        >
          {{ t('git.changelog.empty') }}
        </div>
      </template>
    </div>
    <div class="changelog-footer">
      <span
        class="changelog-agent-hint"
        data-testid="changelog-agent-hint"
      >{{ t('git.changelog.agentHint') }}</span>
      <n-button
        size="small"
        type="primary"
        secondary
        :disabled="!draft || draft.empty"
        :loading="polishing"
        :title="t('git.changelog.polishTitle')"
        data-testid="changelog-polish"
        @click="handlePolish"
      >
        <template #icon>
          <n-icon size="13">
            <SparklesOutline />
          </n-icon>
        </template>
        {{ t('git.changelog.polish') }}
      </n-button>
      <n-button
        size="small"
        :disabled="!draft || draft.empty"
        data-testid="changelog-copy"
        @click="handleCopy"
      >
        <template #icon>
          <n-icon size="13">
            <CopyOutline />
          </n-icon>
        </template>
        {{ t('git.changelog.copy') }}
      </n-button>
    </div>
  </n-modal>
</template>

<style scoped>
.changelog-toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}
.cl-label { font-size: 0.85em; color: var(--text-secondary); flex-shrink: 0; }
.changelog-notag-hint {
  font-size: 0.82em;
  color: var(--accent-blue);
  margin-bottom: 6px;
}
.changelog-preview-wrap {
  min-height: 120px;
  display: flex;
  flex-direction: column;
}
.changelog-spin { margin: auto; }
.changelog-truncated {
  font-size: 0.82em;
  color: var(--accent-yellow-warm);
  margin-bottom: 6px;
}
.changelog-preview {
  flex: 1;
  margin: 0;
  padding: 10px var(--space-3);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  color: var(--text-body);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 44vh;
  overflow-y: auto;
}
.changelog-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 120px;
  border: 1px dashed var(--border-default);
  border-radius: var(--radius-md);
  color: var(--text-dim);
  font-size: 0.88em;
}
.changelog-footer {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}
.changelog-agent-hint {
  flex: 1;
  min-width: 0;
  font-size: 0.8em;
  color: var(--text-dim);
  line-height: 1.4;
}
</style>
