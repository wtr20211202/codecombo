<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { NModal, NSelect, NSpin, NEmpty, NInput, NButton, NSwitch } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { useProjectStore } from '../../stores/project'
import { projectApi, branchDiffApi, logApi } from '../../api/client'
import DiffViewer from '../../views/changes/DiffViewer.vue'

/**
 * 文件与参照对比弹窗：选定 分支/Tag（下拉）或 提交 hash（输入）后展示
 * 「该参照 → 当前 HEAD」的本文件 diff。编辑器 Git 快捷操作与 Monaco 右键
 * 菜单共用；打开时才拉取分支/Tag 列表（缓存复用）。
 * 方向标注（P-20261003-222）：bar 末端明示「当前分支 ← 参照」的合入方向，
 * 与分支右键「合并到当前分支」确认弹层的方向文案同向，防误方向合并
 * 提交区间（P-20261003-233）：工具条下「仅独有提交」toggle——开 = base..ref
 * 单向（待合入内容审阅聚焦），关 = base...ref 对称差双向全量；基线缺失服务端
 * 降级返回参照全量历史 + noBase 注记
 */
const props = defineProps<{
  show: boolean
  projectId: string
  file: string
}>()

const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
}>()

const { t } = useI18n()
const projectStore = useProjectStore()

// 合入目标（base）：服务端刷新的当前分支名；拿不到（未加载/detached）退回 HEAD
const baseLabel = computed(() => projectStore.currentProject?.currentBranch?.trim() || 'HEAD')

const refOptions = ref<{ label: string; value: string }[]>([])
const selectedRef = ref<string | null>(null)
const commitHashInput = ref('')
const refsLoading = ref(false)
const refsLoaded = ref(false)
const diffContent = ref('')
const diffLoading = ref(false)
const diffError = ref('')

// 跨项目实例存活时（防御性）：refs 缓存按项目失效
watch(() => props.projectId, () => { refsLoaded.value = false })

watch(() => props.show, (v) => {
  if (v) {
    diffContent.value = ''
    diffError.value = ''
    selectedRef.value = null
    commitHashInput.value = ''
    // 提交区间态随打开复位（过滤 toggle 不跨打开粘滞，PushDialog 高级区同口径）
    uniqueOnly.value = false
    resetCommitsState()
    void loadRefs()
  }
})

async function loadRefs() {
  if (refsLoaded.value) return
  refsLoading.value = true
  try {
    const [branches, tags] = await Promise.all([
      projectApi.branches(props.projectId) as unknown as { data?: { name: string }[] },
      projectApi.tags(props.projectId).catch(() => ({ data: [] })) as unknown as { data?: { name: string }[] },
    ])
    const opts: { label: string; value: string }[] = []
    for (const b of branches.data || []) opts.push({ label: `${b.name}`, value: b.name })
    for (const g of tags.data || []) opts.push({ label: `tag: ${g.name}`, value: g.name })
    refOptions.value = opts
    refsLoaded.value = true
  } catch { /* 静默：下拉为空时用户看到空列表 */ } finally {
    refsLoading.value = false
  }
}

// 提交 hash 输入优先：显式指向任意提交；下拉选择则指向分支/Tag
const effectiveRef = computed(() => {
  const h = commitHashInput.value.trim()
  if (h) return h
  return selectedRef.value || ''
})
const canCompare = computed(() => !!(props.projectId && props.file && effectiveRef.value))

// ============== 提交区间（P-20261003-233） ==============
// base ← ref 的提交清单辅助面：「仅独有提交」开 = base..ref 单向（待合入内容
// 审阅聚焦），关 = base...ref 对称差双向全量；基线缺失服务端降级参照全量 +
// noBase 注记。默认不过滤（过滤 toggle 常规语义），随对比动作与开关切换取数
const COMPARE_COMMITS_LIMIT = 100
const uniqueOnly = ref(false)
const rangeCommits = ref<{ hash: string; shortHash: string; subject: string }[]>([])
const commitsLoading = ref(false)
const commitsError = ref('')
const noBase = ref(false)
// 区间面可见性 = 当前参照就是「取数中的那份参照」：hash 输入逐字符改
// effectiveRef，按「取过数」布尔位会在 select 事件的 v-model 写入 → watcher
// pre-flush 晚于同步事件链时把刚置的位清掉（实测竞态）；改为记录取数参照、
// 派生可见性——参照一变清单即刻隐藏，旧清单永不冒充新参照
const commitsForRef = ref('')
const commitsVisible = computed(() =>
  !!effectiveRef.value && commitsForRef.value === effectiveRef.value)
// 请求序号守卫：开关连点/换参照的并发慢响应晚到会把旧结果覆盖回新列表
//（CommitsPanel fetchLogSeq 同款，丢掉序号不符的响应）
let commitsSeq = 0

// 区间标注随开关显式给出 git revset 语义（.. 单向 / ... 对称差），与方向标注同面
const commitsRangeLabel = computed(() =>
  `${baseLabel.value} ${uniqueOnly.value ? '..' : '...'} ${effectiveRef.value}`)
const commitsTruncated = computed(() => rangeCommits.value.length >= COMPARE_COMMITS_LIMIT)

function resetCommitsState() {
  commitsForRef.value = ''
  rangeCommits.value = []
  commitsError.value = ''
  noBase.value = false
}

async function loadCommits() {
  const refValue = effectiveRef.value
  if (!props.projectId || !refValue) {
    resetCommitsState()
    return
  }
  commitsForRef.value = refValue
  const seq = ++commitsSeq
  commitsLoading.value = true
  commitsError.value = ''
  try {
    // 响应体已被 http 拦截器解包：{ data: 提交数组, noBase?: true }——
    // 消费形态同 PushDialog 的 noUpstream 先例（as unknown as 直读兄弟标志）
    const res = await logApi.getCompare(props.projectId, baseLabel.value, refValue, uniqueOnly.value, COMPARE_COMMITS_LIMIT) as unknown as {
      data?: { hash?: string; shortHash?: string; message?: string }[]
      noBase?: boolean
    }
    if (seq !== commitsSeq) return
    rangeCommits.value = (res.data || [])
      .map(c => ({
        hash: String(c.hash || ''),
        shortHash: String(c.shortHash || c.hash || '').slice(0, 8),
        subject: String(c.message || '').split('\n')[0] || '',
      }))
      .filter(c => c.hash && c.subject)
    noBase.value = res.noBase === true
  } catch (err: unknown) {
    // silent 请求：拦截器不弹全局 toast，弹层内就地降级提示
    //（userMessage：拦截器产出的友好文案，同 diffError 取法）
    if (seq !== commitsSeq) return
    rangeCommits.value = []
    noBase.value = false
    commitsError.value = (err as { userMessage?: string })?.userMessage || t('errors.unknown')
  } finally {
    if (seq === commitsSeq) commitsLoading.value = false
  }
}

async function runCompare() {
  if (!canCompare.value) return
  void loadCommits()
  diffLoading.value = true
  diffError.value = ''
  diffContent.value = ''
  try {
    const res: any = await branchDiffApi.getFileDiff(props.projectId, effectiveRef.value, 'HEAD', props.file)
    diffContent.value = res.data || ''
    if (!diffContent.value) diffError.value = t('editor.compareNoDiff')
  } catch (e: any) {
    // userMessage：拦截器产出的友好文案；原文保留在 Console，不直出面板
    diffError.value = e?.userMessage || t('errors.unknown')
  } finally {
    diffLoading.value = false
  }
}
</script>

<template>
  <n-modal
    :show="props.show"
    preset="card"
    :title="t('editor.compareTitle', { file })"
    :style="{ width: 'var(--modal-w-xl)', maxWidth: '94vw' }"
    :bordered="false"
    @update:show="emit('update:show', $event)"
  >
    <div class="crm-bar">
      <span class="crm-label">{{ t('editor.compareRefLabel') }}</span>
      <n-select
        v-model:value="selectedRef"
        :options="refOptions"
        :loading="refsLoading"
        filterable
        clearable
        size="small"
        class="crm-select"
        :placeholder="t('editor.compareRefPlaceholder')"
        :disabled="!!commitHashInput.trim()"
        @update:value="runCompare"
      />
      <n-input
        v-model:value="commitHashInput"
        size="small"
        class="crm-hash"
        :placeholder="t('editor.compareHashPlaceholder')"
        @keyup.enter="runCompare"
        @update:value="selectedRef = null"
      />
      <n-button
        size="small"
        type="primary"
        :disabled="!canCompare || diffLoading"
        :loading="diffLoading"
        @click="runCompare"
      >
        {{ t('editor.compareRun') }}
      </n-button>
      <!-- 方向标注（P-20261003-222）：base ← source 明示合入方向，tooltip 重申
           「将 source 合入 base」与分支右键合并确认同向；未选参照时占位防误读 -->
      <span
        class="crm-direction"
        :title="t('editor.compareDirectionTip', { base: baseLabel, source: effectiveRef || t('editor.compareDirectionNone') })"
      >
        <span class="crm-dir-label">{{ t('editor.compareDirection') }}</span>
        <span class="crm-dir-base">{{ baseLabel }}</span>
        <span class="crm-dir-arrow">←</span>
        <span
          class="crm-dir-source"
          :class="{ 'crm-dir-empty': !effectiveRef }"
        >{{ effectiveRef || t('editor.compareDirectionNone') }}</span>
      </span>
    </div>
    <!-- 提交区间（P-20261003-233）：base ← ref 的提交清单，仅当当前参照就是
         取数中的参照时显示（commitsVisible——hash 输入逐字符改参照不渲染，
         旧参照清单不冒充新参照）。「仅独有提交」开 = base..ref 单向（审阅待
         合入内容聚焦），关 = base...ref 对称差双向全量；区间标注显式给出
         revset 语义，基线缺失服务端降级全量并注记（noBase） -->
    <div
      v-if="commitsVisible"
      class="crm-commits"
      data-test="compare-commits"
    >
      <div class="crm-commits-bar">
        <n-switch
          v-model:value="uniqueOnly"
          size="small"
          data-test="compare-unique-toggle"
          :title="t('editor.compareUniqueTip')"
          @update:value="loadCommits"
        />
        <span class="crm-commits-label">{{ t('editor.compareUniqueOnly') }}</span>
        <span class="crm-commits-range">{{ commitsRangeLabel }}</span>
        <span
          v-if="noBase"
          class="crm-commits-note"
        >{{ t('editor.compareNoBase') }}</span>
        <span
          v-if="commitsTruncated"
          class="crm-commits-note"
        >{{ t('editor.compareCommitsTruncated', { n: COMPARE_COMMITS_LIMIT }) }}</span>
      </div>
      <div
        v-if="commitsLoading"
        class="crm-commits-body"
      >
        <n-spin size="small" />
      </div>
      <div
        v-else-if="commitsError"
        class="crm-commits-body crm-commits-fallback"
      >
        {{ commitsError }}
      </div>
      <div
        v-else-if="rangeCommits.length === 0"
        class="crm-commits-body crm-commits-fallback"
      >
        {{ t('editor.compareCommitsNone') }}
      </div>
      <ul
        v-else
        class="crm-commits-list"
        data-test="compare-commit-list"
      >
        <li
          v-for="c in rangeCommits"
          :key="c.hash"
          class="crm-commit-row"
          :class="{ 'crm-commit-unique': uniqueOnly }"
        >
          <span class="crm-commit-hash">{{ c.shortHash }}</span>
          <span class="crm-commit-subject">{{ c.subject }}</span>
        </li>
      </ul>
    </div>
    <div
      class="crm-body"
      :class="{ 'crm-body-compact': commitsVisible }"
    >
      <div
        v-if="diffLoading"
        class="crm-center"
      >
        <n-spin size="small" />
      </div>
      <div
        v-else-if="diffError"
        class="crm-center"
      >
        <n-empty :description="diffError" />
      </div>
      <div
        v-else-if="diffContent"
        class="crm-diff"
      >
        <DiffViewer :content="diffContent" />
      </div>
      <div
        v-else
        class="crm-center"
      >
        <n-empty :description="t('editor.comparePickRef')" />
      </div>
    </div>
  </n-modal>
</template>

<style scoped>
.crm-bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: 10px;
}
.crm-label { font-size: 12px; color: var(--text-secondary); flex-shrink: 0; }
.crm-select { width: 220px; }
.crm-hash { width: 260px; }
/* 方向标注：base ← source；base 用当前分支名高亮，来源未选时置灰占位 */
.crm-direction {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  flex-shrink: 0;
  margin-left: auto;
  font-size: 12px;
  font-family: var(--font-mono);
  cursor: help;
}
.crm-dir-label { color: var(--text-dim); font-family: var(--font-ui); }
.crm-dir-base { color: var(--accent-green); font-weight: var(--fw-semibold); }
.crm-dir-arrow { color: var(--text-secondary); font-weight: var(--fw-semibold); }
.crm-dir-source { color: var(--brand-accent); }
.crm-dir-empty { color: var(--text-dim); font-weight: var(--fw-regular); }
/* 提交区间（P-233）：工具条下、diff 上的辅助清单面；开关切 revset 语义 */
.crm-commits { margin-bottom: 10px; }
.crm-commits-bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: 6px;
  flex-wrap: wrap;
}
.crm-commits-label { font-size: 12px; color: var(--text-secondary); }
.crm-commits-range { font-size: 12px; font-family: var(--font-mono); color: var(--text-dim); }
.crm-commits-note { font-size: 12px; color: var(--accent-yellow); }
.crm-commits-body {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 36px;
  font-size: 12px;
  color: var(--text-secondary);
}
.crm-commits-fallback { justify-content: flex-start; }
.crm-commits-list {
  max-height: 132px;
  overflow-y: auto;
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
}
.crm-commit-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 3px var(--space-2);
  font-size: 12px;
  line-height: 1.7;
}
.crm-commit-row + .crm-commit-row { border-top: 1px solid var(--border-subtle); }
.crm-commit-hash { font-family: var(--font-mono); color: var(--text-secondary); flex-shrink: 0; }
/* 仅独有档：hash 点 accent 色标识当前视图是「待合入侧」，开关切换有可见反馈 */
.crm-commit-unique .crm-commit-hash { color: var(--accent-green); }
.crm-commit-subject {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}
.crm-body { height: 68vh; display: flex; flex-direction: column; overflow: hidden; }
/* 提交区间显示时压缩 diff 区高度，弹层总高不失控（小屏不冒出页级滚动条） */
.crm-body.crm-body-compact { height: 46vh; }
.crm-center { flex: 1; display: flex; align-items: center; justify-content: center; }
.crm-diff { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
.crm-diff > :deep(*) { flex: 1; min-height: 0; }
</style>
