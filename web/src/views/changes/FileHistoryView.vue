<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { NSpin, NEmpty, NSelect, NButton, NIcon, useMessage } from 'naive-ui'
import { GitCommitOutline, SaveOutline } from '@vicons/ionicons5'
import { logApi, diffApi, fileHistoryApi, projectApi, commitApi } from '../../api/client'
import DiffViewer from './DiffViewer.vue'
// 本地保存条目的右侧对比沿 LocalHistoryModal 同款双栏 DiffEditor（历史版 ↔ 当前
// 盘上内容）。懒加载守门（EditorGroupPane/FileTreeView 同款范式，monaco-nls.ts
// 头注释的时序契约）：本视图经 FileHistoryModal ← CommitDiffFiles ← CommitsPanel ←
// GitPanel ← BottomPanel ← Layout 静态链在进项目页即求值，静态引入会把 monaco
// 主模块求值提到语言包（ensureMonacoNls）之前——MenuRegistry 就地捕获英文字符串，
// 原生右键菜单永久英文化（run20 同款事故形态），必须 safeAsync 惰性引入
import { ensureMonacoNls } from '@/utils/monaco-nls'
import { safeAsync } from '@/utils/async-component'
import { useI18n } from '../../composables/useI18n'
import { confirmDialog } from '../../composables/useDialog'
import { useChangesStore } from '../../stores/changes'
import { buildTimeline, type TimelineEntry, type RawGitCommit, type RawLocalVersion } from './fileHistoryTimeline'
const DiffEditor = safeAsync(() => ensureMonacoNls().then(() => import('../editor/DiffEditor.vue').then(m => m.default)))

/**
 * 单文件聚合时间线（P-20261008-11）：git 提交与本地保存版本（P-20261002-130）
 * 合一呈现，每条带来源徽标（图标 + tooltip），按时间降序穿插；来源过滤
 * （全部 / 只看 Git / 只看本地，默认全部）。恢复动作按来源分派：
 * - 本地保存 → fileHistory 既有恢复链（恢复前服务端自动快照当前内容，可再撤销）；
 * - Git 提交 → 右侧 diff 即预览，确认后 checkout 该提交的文件版本进工作区
 *   （rollback 端点可选 ref 增量扩展，与整文件回滚同语义的改写工作区高危写）。
 * 合流窗口口径见 fileHistoryTimeline.ts 头注释；无本地历史的文件视图行为不变。
 */
const { t } = useI18n()
const message = useMessage()
const changesStore = useChangesStore()

interface Commit {
  hash: string
  shortHash: string
  message: string
  author: string
  email: string
  date: string
}

const props = defineProps<{
  projectId: string
  file: string
}>()

const commits = ref<Commit[]>([])
const versions = ref<RawLocalVersion[]>([])
const loading = ref(false)
const selected = ref<TimelineEntry | null>(null)
const diffContent = ref('')
const diffLoading = ref(false)
// 本地条目右侧取数（版本内容 ↔ 当前盘上内容）
const versionContent = ref('')
const currentContent = ref('')
const currentMissing = ref(false)
const restoring = ref(false)

type SourceFilter = 'all' | 'git' | 'local'
const sourceFilter = ref<SourceFilter>('all')
const filterOptions = computed(() => [
  { label: t('fileHistory.sourceAll'), value: 'all' },
  { label: t('fileHistory.sourceGit'), value: 'git' },
  { label: t('fileHistory.sourceLocal'), value: 'local' },
])

const displayed = computed(() => {
  if (sourceFilter.value === 'git') return { entries: buildTimeline(commits.value, []).entries, older: 0 }
  if (sourceFilter.value === 'local') return { entries: buildTimeline([], versions.value).entries, older: 0 }
  const built = buildTimeline(commits.value, versions.value)
  return { entries: built.entries, older: built.olderCommits }
})

async function fetchFileLog() {
  if (!props.projectId || !props.file) return
  loading.value = true
  selected.value = null
  diffContent.value = ''
  try {
    // 本地历史尽力而为：取数失败降级纯 git 视图（silent 不叠全局错误 toast），
    // 不因快照面缺失挡住提交历史这条主数据面
    const [logRes, histRes] = await Promise.all([
      logApi.getFileLog(props.projectId, props.file) as Promise<{ data?: Commit[] }>,
      fileHistoryApi.list(props.projectId, props.file, { silent: true }) as Promise<{ data?: RawLocalVersion[] }>,
    ])
    commits.value = logRes.data || []
    versions.value = histRes.data || []
    const first = displayed.value.entries[0]
    if (first) void selectEntry(first)
  } finally {
    loading.value = false
  }
}

// 选中序号令牌：快速连点不同条目时慢响应的旧取数不得覆盖新选中条目的预览
// （恢复确认以右侧预览为准，串台预览会误导高危写）
let selectSeq = 0

async function selectEntry(entry: TimelineEntry) {
  const seq = ++selectSeq
  selected.value = entry
  if (entry.kind === 'git') {
    await selectCommit(entry.hash, seq)
  } else {
    await selectVersion(entry.id, seq)
  }
}

async function selectCommit(hash: string, seq: number) {
  currentMissing.value = false
  diffLoading.value = true
  try {
    const res: any = await diffApi.getCommitDiff(props.projectId, hash)
    if (seq !== selectSeq) return
    // 提取当前文件的 diff 部分
    const fullDiff: string = res.data || ''
    diffContent.value = extractFileDiff(fullDiff, props.file)
  } catch {
    if (seq !== selectSeq) return
    diffContent.value = ''
  } finally {
    diffLoading.value = false
  }
}

async function selectVersion(id: string, seq: number) {
  diffContent.value = ''
  diffLoading.value = true
  try {
    const [versionRes] = await Promise.all([
      fileHistoryApi.content(props.projectId, props.file, id, { silent: true }) as Promise<{ data?: string }>,
      fetchCurrent(),
    ])
    if (seq !== selectSeq) return
    versionContent.value = versionRes?.data ?? ''
  } catch {
    if (seq !== selectSeq) return
    versionContent.value = ''
    currentContent.value = ''
    message.error(t('files.history.loadFailed'))
  } finally {
    diffLoading.value = false
  }
}

async function fetchCurrent() {
  currentMissing.value = false
  try {
    const res = await projectApi.readFile(props.projectId, props.file, { silent: true }) as { data?: unknown }
    currentContent.value = typeof res?.data === 'string' ? res.data : ''
  } catch {
    // 文件已被删除：diff 右侧呈现为空（恢复即整段「新增回来」）
    currentContent.value = ''
    currentMissing.value = true
  }
}

/** 恢复动作按来源分派（提案 ③）：两条链都是改写工作区的高危写，确认前置 */
async function restoreSelected() {
  const entry = selected.value
  if (!entry || restoring.value) return
  if (entry.kind === 'local') {
    await restoreLocal(entry.id)
  } else {
    await restoreGit(entry.hash)
  }
}

async function restoreLocal(id: string) {
  if (!await confirmDialog({
    type: 'warning',
    title: t('files.history.restoreTitle'),
    content: t('files.history.restoreBody'),
  })) return
  restoring.value = true
  try {
    await fileHistoryApi.restore(props.projectId, props.file, id)
    message.success(t('files.history.restored'))
    // 列表随恢复联动（恢复前状态刚入档）并重选顶条；宿主盘面（git 状态）刷新
    await fetchFileLog()
    refreshWorktreeDerived()
  } catch { /* 拦截器处理 */ } finally {
    restoring.value = false
  }
}

async function restoreGit(hash: string) {
  if (!await confirmDialog({
    type: 'warning',
    title: t('fileHistory.gitRestoreTitle'),
    content: t('fileHistory.gitRestoreBody'),
  })) return
  restoring.value = true
  try {
    await commitApi.rollback(props.projectId, [props.file], hash)
    message.success(t('fileHistory.gitRestored'))
    refreshWorktreeDerived()
  } catch { /* 拦截器处理 */ } finally {
    restoring.value = false
  }
}

/** 恢复改写磁盘后刷新 worktree 态衍生物（变更树/git 徽标）：宿主面常在恢复成功
 *  前后仍开着，仅靠 WS git-activity 刷新有秒级窗口差。前置：本视图只被当前项目
 *  的文件宿主（编辑器 Git 快捷操作/提交变更文件右键）打开，projectId 即当前项目 */
function refreshWorktreeDerived() {
  void changesStore.fetchStatus(props.projectId).catch(() => { /* 状态刷新失败不打断 */ })
}

function extractFileDiff(fullDiff: string, filePath: string): string {
  const lines = fullDiff.split('\n')
  const result: string[] = []
  let inTarget = false
  let foundFirstHunk = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    // diff header: diff --git a/path b/path
    if (line.startsWith('diff --git')) {
      if (inTarget) break // 遇到下一个文件 diff，结束
      if (line.includes(filePath) || line.includes(filePath.replace(/\\/g, '/'))) {
        inTarget = true
        foundFirstHunk = false
      }
      continue
    }
    if (inTarget) {
      if (line.startsWith('---') || line.startsWith('+++')) {
        result.push(line)
        continue
      }
      if (line.startsWith('@@')) {
        foundFirstHunk = true
      }
      if (foundFirstHunk || line.startsWith('---') || line.startsWith('+++')) {
        result.push(line)
      }
    }
  }

  return result.length > 0 ? result.join('\n') : fullDiff
}

function entryKey(e: TimelineEntry): string {
  return e.kind === 'git' ? e.hash : e.id
}

function formatTs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  return new Date(ms).toLocaleString()
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

watch(() => [props.projectId, props.file], () => {
  fetchFileLog()
})
onMounted(() => fetchFileLog())
</script>

<template>
  <div style="height: 100%; display: flex">
    <!-- 左侧合流时间线列表 -->
    <div style="width: 300px; border-right: 1px solid var(--border-default); display: flex; flex-direction: column; overflow: hidden">
      <div
        style="background: var(--bg-panel); padding: 6px 10px; border-bottom: 1px solid var(--border-default); font-size: 12px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap"
        :title="file"
      >
        <!-- 弹窗标题已含「文件历史：{file}」，内层只留文件路径免重复 -->
        {{ file }}
      </div>
      <!-- 来源过滤（提案 ④）：全部 / 只看 Git / 只看本地，默认全部 -->
      <div style="padding: 6px 10px; border-bottom: 1px solid var(--border-default)">
        <n-select
          v-model:value="sourceFilter"
          size="tiny"
          :options="filterOptions"
          data-testid="fh-source-filter"
          :aria-label="t('fileHistory.sourceFilterLabel')"
        />
      </div>
      <div
        v-if="loading"
        style="padding: 20px; text-align: center"
      >
        <n-spin size="small" />
      </div>
      <div
        v-else
        style="flex: 1; overflow-y: auto"
      >
        <div
          v-for="(entry, idx) in displayed.entries"
          :key="entryKey(entry)"
          :data-testid="idx === 0 ? 'fh-entry-first' : 'fh-entry'"
          :data-kind="entry.kind"
          style="padding: 6px 10px; border-bottom: 1px solid var(--bg-panel); cursor: pointer; font-size: 12px"
          :style="{ background: selected && entryKey(selected) === entryKey(entry) ? 'var(--bg-active)' : 'transparent' }"
          @click="selectEntry(entry)"
        >
          <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 2px">
            <!-- 来源徽标：图标 + title/aria 提示（提案 ①） -->
            <span
              :title="entry.kind === 'git' ? t('fileHistory.badgeGit') : t('fileHistory.badgeLocal')"
              :aria-label="entry.kind === 'git' ? t('fileHistory.badgeGit') : t('fileHistory.badgeLocal')"
              style="display: inline-flex; align-items: center; color: var(--text-dim); flex-shrink: 0"
            >
              <n-icon size="12">
                <GitCommitOutline v-if="entry.kind === 'git'" />
                <SaveOutline v-else />
              </n-icon>
            </span>
            <template v-if="entry.kind === 'git'">
              <span style="color: var(--accent-blue-light); font-family: monospace; font-size: 11px">{{ entry.shortHash }}</span>
              <span style="color: var(--text-body); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1">{{ entry.message }}</span>
            </template>
            <template v-else>
              <span style="color: var(--text-body); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1">{{ t('fileHistory.badgeLocal') }}</span>
              <span style="color: var(--text-dim); font-size: 11px; flex-shrink: 0">{{ formatSize(entry.size) }}</span>
            </template>
          </div>
          <div style="display: flex; gap: 8px; color: var(--text-dim); font-size: 11px">
            <span v-if="entry.kind === 'git'">{{ entry.author }}</span>
            <span>{{ formatTs(entry.ts) }}</span>
          </div>
        </div>
        <!-- 时间窗注记（提案 ②）：窗口外更早提交不混列，点击切「只看 Git」看全量 -->
        <button
          v-if="displayed.older > 0"
          type="button"
          data-testid="fh-older-note"
          style="display: block; width: 100%; padding: 8px 10px; border: 0; background: transparent; color: var(--text-dim); font-size: 11px; text-align: left; cursor: pointer"
          :title="t('fileHistory.olderCommitsHint')"
          @click="sourceFilter = 'git'"
        >
          {{ t('fileHistory.olderCommits', { n: displayed.older }) }}
        </button>
        <div
          v-if="displayed.entries.length === 0"
          style="padding: 20px; text-align: center; color: var(--text-dim); font-size: 12px"
        >
          {{ t('fileHistory.noCommits') }}
        </div>
      </div>
    </div>

    <!-- 右侧：所选条目的预览 + 按来源分派的恢复动作 -->
    <div style="flex: 1; display: flex; flex-direction: column; overflow: hidden">
      <div
        v-if="selected"
        style="display: flex; justify-content: flex-end; align-items: center; gap: 8px; padding: 4px 8px; border-bottom: 1px solid var(--border-default); background: var(--bg-panel)"
      >
        <span
          v-if="selected.kind === 'local' && currentMissing"
          style="font-size: 11px; color: var(--text-dim); margin-right: auto"
        >{{ t('files.history.currentMissing') }}</span>
        <n-button
          size="tiny"
          type="warning"
          :loading="restoring"
          data-testid="fh-restore"
          @click="restoreSelected"
        >
          {{ selected.kind === 'git' ? t('fileHistory.restoreGit') : t('files.history.restore') }}
        </n-button>
      </div>
      <div
        v-if="diffLoading"
        style="padding: 20px; text-align: center; flex: 1"
      >
        <n-spin size="small" />
      </div>
      <template v-else>
        <!-- git 条目：该提交对本文件的 diff（即恢复前预览，提案 ③） -->
        <div
          v-if="selected?.kind === 'git' && diffContent"
          style="flex: 1; overflow: hidden"
        >
          <DiffViewer :content="diffContent" />
        </div>
        <!-- 本地条目：历史版 ↔ 当前盘上内容（LocalHistoryModal 同款双栏） -->
        <div
          v-else-if="selected?.kind === 'local'"
          style="flex: 1; min-height: 0"
        >
          <DiffEditor
            :old-content="versionContent"
            :new-content="currentContent"
            :path="file"
            :old-label="t('files.history.sideOld')"
            :new-label="t('files.history.sideCurrent')"
          />
        </div>
        <div
          v-else
          style="flex: 1; display: flex; align-items: center; justify-content: center"
        >
          <n-empty :description="t('fileHistory.selectCommit')" />
        </div>
      </template>
    </div>
  </div>
</template>
