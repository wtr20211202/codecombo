<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NIcon, NSpin, NTab, NTabs, NTag } from 'naive-ui'
import { CheckmarkCircleOutline, TimeOutline, AlertCircleOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { compareExperimentApi } from '../../api/domains/compare'
import type { CompareExperimentDetail as Detail, CompareFileRow } from '../../api/domains/compare'
import DiffViewer from '../../views/changes/DiffViewer.vue'
import { formatTokens, sideState } from '../../composables/useCompareExperiment'

/**
 * 对比实验详情（P-20261003-46 ④⑤）：双侧卡（runtime/完成状态/token 用量/采用
 * 标注）+ 文件行三态标识 + 点击开「基线 vs 侧产出」diff（DiffViewer 既有渲染，
 * 双方文件带 A/B 视角切换）。服务端已按各侧 startHead 快照面做并集三分类，
 * 本组件零归属逻辑只做呈现与取数。
 * token 维度已合入：claude 侧捕获到底层会话 id 后按 claude/sessions 索引列表
 * 对账 totalTokens；其他 runtime 无用量事实源不展示（不谎报零消耗）。
 */
const props = defineProps<{
  detail: Detail
  /** token 用量对账表（agentSessionId → totalTokens；宿主拉取，非 claude 侧为空） */
  usage: Map<string, number>
}>()

const emit = defineEmits<{
  (e: 'adopt', side: 'a' | 'b' | ''): void
  (e: 'apply', side: 'a' | 'b'): void
}>()

const { t } = useI18n()

interface SideCtx {
  key: 'a' | 'b'
  runtime: string
  name: string
  state: ReturnType<typeof sideState>
  alive: boolean
  adopted: boolean
  tokens: string
}

const sides = computed<SideCtx[]>(() => {
  const exp = props.detail.experiment
  return (['a', 'b'] as const).map(key => {
    const side = key === 'a' ? exp.a : exp.b
    return {
      key,
      runtime: side.runtime || 'auto',
      name: side.name || side.sessionId,
      state: sideState(side.result),
      alive: key === 'a' ? !!props.detail.alive.a : !!props.detail.alive.b,
      adopted: exp.adopted === key,
      tokens: formatTokens(side.agentSessionId ? props.usage.get(side.agentSessionId) : undefined),
    }
  })
})

const stateIcon = (state: string) =>
  state === 'done' ? CheckmarkCircleOutline : state === 'waiting' ? TimeOutline : AlertCircleOutline

// ── 文件行选择与 diff 取数 ──
const selectedPath = ref('')
const diffSide = ref<'a' | 'b'>('a')
const diffContent = ref('')
const diffLoading = ref(false)
const diffError = ref(false)

const selectedRow = computed<CompareFileRow | undefined>(() =>
  props.detail.files.find(f => f.path === selectedPath.value),
)

/** 双方文件的视角可用侧（仅 A → 锁 a；仅 B → 锁 b；双方 → 用户切换） */
const diffSideOptions = computed(() => {
  const row = selectedRow.value
  if (!row) return [] as ('a' | 'b')[]
  const opts: ('a' | 'b')[] = []
  if (row.inA) opts.push('a')
  if (row.inB) opts.push('b')
  return opts
})

async function loadDiff(): Promise<void> {
  const exp = props.detail.experiment
  const row = selectedRow.value
  if (!exp || !row) return
  diffLoading.value = true
  diffError.value = false
  diffContent.value = ''
  try {
    const res = (await compareExperimentApi.fileDiff(
      exp.id, diffSide.value, row.path, diffSide.value === 'a' ? row.statusA : row.statusB,
    )) as unknown as { data?: string }
    diffContent.value = res?.data || ''
  } catch {
    diffError.value = true // 拦截器已 toast；本区给空态
  } finally {
    diffLoading.value = false
  }
}

watch(selectedPath, (p) => {
  if (!p) return
  const row = selectedRow.value
  // 默认视角：仅 A/仅 B 锁定归属侧，双方默认 A
  diffSide.value = row?.inA ? 'a' : 'b'
  void loadDiff()
})

// 视角切换重取（双方文件 A/B 各自基线独立）
watch(diffSide, () => { if (selectedPath.value) void loadDiff() })

// 详情整体刷新（轮询回执/采用标注）后 diff 跟随重取
watch(() => props.detail, () => { if (selectedPath.value) void loadDiff() })

const ready = computed(() => props.detail.experiment.status === 'ready')

// ── 采用落盘二阶段（P-20261004-72）：已标注侧的「落盘到工作区」入口。
// 服务端编排（保留/回滚/删除 + 强制备份 + 指纹对账），本组件只呈现入口与
// 禁用态原因（未标注不可落盘）——动作计数预告在确认弹窗（宿主组合式）
const adoptedSide = computed<'a' | 'b' | ''>(() => {
  const v = props.detail.experiment.adopted
  return v === 'a' || v === 'b' ? v : ''
})
</script>

<template>
  <div class="ced-root">
    <!-- 双侧卡：完成状态 + token 用量 + 采用动作 -->
    <div class="ced-sides">
      <div
        v-for="s in sides"
        :key="s.key"
        class="ced-side"
        :class="{ adopted: s.adopted }"
        :data-testid="`compare-side-${s.key}`"
      >
        <div class="ced-side-head">
          <span class="ced-runtime">{{ s.runtime }}</span>
          <span
            class="ced-state"
            :class="`is-${s.state}`"
            :title="t(`experiment.state.${s.state}`)"
          >
            <n-icon size="12"><component :is="stateIcon(s.state)" /></n-icon>
            {{ t(`experiment.state.${s.state}`) }}
          </span>
          <span
            v-if="s.adopted"
            class="ced-adopted-badge"
          >{{ t('experiment.adoptedBadge', { side: s.key.toUpperCase() }) }}</span>
        </div>
        <div
          class="ced-name"
          :title="s.name"
        >{{ s.name }}</div>
        <div class="ced-meta">
          <span
            v-if="s.tokens"
            class="ced-tokens"
            :title="t('experiment.tokensTip')"
          >{{ t('experiment.tokens', { tokens: s.tokens }) }}</span>
          <span
            v-else-if="s.state === 'waiting'"
            class="ced-alive"
          >{{ s.alive ? t('experiment.sessionRunning') : t('experiment.sessionGone') }}</span>
        </div>
        <n-button
          size="tiny"
          :type="s.adopted ? 'primary' : 'default'"
          :disabled="s.state === 'error'"
          data-testid="compare-adopt"
          @click="emit('adopt', s.adopted ? '' : s.key)"
        >
          {{ s.adopted ? t('experiment.adoptedClear') : t('experiment.adoptAction', { side: s.key.toUpperCase() }) }}
        </n-button>
      </div>
    </div>

    <div class="ced-adopt-hint">
      {{ t('experiment.adoptHint') }}
      <n-button
        v-if="adoptedSide"
        size="tiny"
        type="warning"
        quaternary
        data-testid="compare-apply"
        class="ced-apply-btn"
        @click="emit('apply', adoptedSide)"
      >
        {{ t('experiment.applyAction', { side: adoptedSide.toUpperCase() }) }}
      </n-button>
      <span
        v-if="!ready"
        class="ced-running-hint"
      >{{ t('experiment.notReadyHint') }}</span>
    </div>

    <!-- 文件行三态 + diff -->
    <div class="ced-body">
      <div class="ced-files">
        <div class="ced-files-head">
          {{ t('experiment.fileCount', { n: props.detail.files.length }) }}
        </div>
        <div
          v-if="props.detail.files.length === 0"
          class="ced-empty"
        >
          {{ t('experiment.noFiles') }}
        </div>
        <div
          v-for="f in props.detail.files"
          :key="f.path"
          class="ced-file"
          :class="{ active: f.path === selectedPath }"
          :data-testid="`compare-file-${f.path}`"
          :title="f.path"
          @click="selectedPath = f.path"
        >
          <span
            class="ced-flags"
            :title="t(f.inA && f.inB ? 'experiment.flagBoth' : f.inA ? 'experiment.flagOnlyA' : 'experiment.flagOnlyB')"
          >
            <span
              v-if="f.inA"
              class="ced-flag"
            >A</span>
            <span
              v-if="f.inB"
              class="ced-flag"
            >B</span>
          </span>
          <span class="ced-path">{{ f.path }}</span>
        </div>
      </div>
      <div class="ced-diff">
        <div
          v-if="!selectedRow"
          class="ced-empty"
        >
          {{ t('experiment.pickFile') }}
        </div>
        <template v-else>
          <div class="ced-diff-head">
            <span
              class="ced-diff-path"
              :title="selectedRow.path"
            >{{ selectedRow.path }}</span>
            <n-tabs
              v-if="diffSideOptions.length > 1"
              :value="diffSide"
              type="segment"
              size="small"
              class="ced-side-tabs"
              @update:value="(v: string) => diffSide = v as 'a' | 'b'"
            >
              <n-tab
                v-for="k in diffSideOptions"
                :key="k"
                :name="k"
              >
                {{ t('experiment.sideView', { side: k.toUpperCase() }) }}
              </n-tab>
            </n-tabs>
          </div>
          <div
            v-if="diffLoading"
            class="ced-empty"
          >
            <n-spin size="small" />
          </div>
          <div
            v-else-if="diffError"
            class="ced-empty"
          >
            {{ t('experiment.diffFailed') }}
          </div>
          <DiffViewer
            v-else
            :content="diffContent"
          />
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ced-root { display: flex; flex-direction: column; gap: 10px; min-height: 0; flex: 1; }
.ced-sides { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.ced-side {
  border: 1px solid var(--border-default); border-radius: 6px; padding: 8px 10px;
  display: flex; flex-direction: column; gap: 4px; min-width: 0;
}
.ced-side.adopted { border-color: var(--status-success); }
.ced-side-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.ced-runtime {
  font-size: 0.82em; font-weight: 600; color: var(--text-primary);
  padding: 0 6px; border-radius: 3px; flex-shrink: 0;
  background: color-mix(in srgb, var(--accent-purple) 14%, transparent);
}
.ced-state { display: inline-flex; align-items: center; gap: 3px; font-size: 0.78em; color: var(--text-muted); }
.ced-state.is-done { color: var(--status-success); }
.ced-state.is-failed, .ced-state.is-error { color: var(--status-failed); }
.ced-adopted-badge {
  margin-left: auto; font-size: 0.72em; padding: 0 5px; border-radius: 3px; flex-shrink: 0;
  background: color-mix(in srgb, var(--status-success) 18%, transparent); color: var(--status-success);
}
.ced-name { font-size: 0.85em; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ced-meta { display: flex; align-items: center; gap: 8px; min-height: 16px; font-size: 0.75em; color: var(--text-muted); }
.ced-tokens { color: var(--accent-yellow-warm); }
.ced-adopt-hint { font-size: 0.75em; color: var(--text-muted); line-height: 1.5; }
.ced-apply-btn { margin-left: 6px; font-size: 0.86em; }
.ced-running-hint { color: var(--status-running); margin-left: 8px; }
.ced-body { display: grid; grid-template-columns: minmax(200px, 34%) 1fr; gap: 10px; flex: 1; min-height: 240px; }
.ced-files {
  border: 1px solid var(--border-default); border-radius: 6px; overflow: auto;
  display: flex; flex-direction: column; min-height: 0;
}
.ced-files-head {
  padding: 6px 10px; font-size: 0.78em; color: var(--text-muted);
  border-bottom: 1px solid var(--border-default); position: sticky; top: 0; background: var(--bg-panel);
}
.ced-file {
  display: flex; align-items: center; gap: 6px; padding: 4px 10px;
  font-size: 0.8em; cursor: pointer; white-space: nowrap; overflow: hidden;
}
.ced-file:hover { background: var(--bg-hover); }
.ced-file.active { background: var(--bg-active, var(--bg-hover)); }
.ced-flags { display: inline-flex; gap: 2px; flex-shrink: 0; }
.ced-flag {
  font-size: 0.66em; font-weight: 700; padding: 0 3px; border-radius: 2px; line-height: 1.5;
  background: color-mix(in srgb, var(--accent-blue-light) 18%, transparent);
  color: var(--accent-blue-light);
}
.ced-path { overflow: hidden; text-overflow: ellipsis; direction: rtl; text-align: left; color: var(--text-primary); }
.ced-diff {
  border: 1px solid var(--border-default); border-radius: 6px; overflow: hidden;
  display: flex; flex-direction: column; min-height: 0;
}
.ced-diff-head {
  display: flex; align-items: center; gap: 10px; padding: 4px 10px;
  border-bottom: 1px solid var(--border-default); flex-shrink: 0;
}
.ced-diff-path { font-size: 0.78em; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.ced-side-tabs { width: 160px; flex-shrink: 0; }
.ced-diff :deep(> .diff-root), .ced-diff > div:last-child { flex: 1; min-height: 0; }
.ced-empty { padding: 18px; font-size: 0.82em; color: var(--text-muted); text-align: center; }
</style>
