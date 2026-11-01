<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
  NEmpty, NSpin, NButton, NInput, useMessage,
} from 'naive-ui'
import { useProjectStore } from '../../stores/project'
import { conflictApi } from '../../api/client'
import { AppError } from '../../api/error-types'
import type { ConflictHunk } from '../../api/domains/git'
import { useI18n } from '../../composables/useI18n'
import { useConflictAgentDelegate, conflictOpLabel, type ConflictDelegateFile, type ConflictTranslator } from '../../composables/useConflictAgentDelegate'
import { OPS_FILES_EXTERNAL_CHANGE } from '../../utils/opsEvents'
import ConflictHunkList from './ConflictHunkList.vue'
import ConflictFileList from './ConflictFileList.vue'
import ConflictAgentDialog from './ConflictAgentDialog.vue'

const message = useMessage()
const { t } = useI18n()
const projectStore = useProjectStore()

// 全部冲突解决后通知父组件（GitPanel 据此收起冲突横幅并切回提交面板）
const emit = defineEmits<{
  (e: 'all-resolved'): void
}>()

const conflicts = ref<string[]>([])
const loading = ref(false)
const selectedFile = ref('')
const contentLoading = ref(false)
const mode = ref<'hunks' | '3way' | 'text'>('3way')
// 进行中的有序 git 操作（conflictApi.list 顺带返回，P-20261005-190 委派语境）：
// ''|merge|rebase|cherry-pick，旧服务端无字段 = 空
const inProgressOp = ref('')
// 委派弹层（P-20261005-190）：batch=false 单文件（当前选中）、true 整个冲突集
const agentDialogShow = ref(false)
const agentBatch = ref(false)

// 3-way 模式数据
const oursContent = ref('')
const theirsContent = ref('')
const resultContent = ref('')

// 逐块模式数据（P-20261003-59）：hunks 为服务端解析的块列表；rawContent 是
// 合成写回的底稿（含标记的工作区原文，行号与 hunks 对齐）
const hunks = ref<ConflictHunk[]>([])
const rawContent = ref('')
// 复杂形态（diff3/嵌套标记）：服务端拒绝分段，降级整文件模式并提示
const complexConflict = ref(false)

// 文本模式数据
const conflictContent = ref('')
// 服务端探测的冲突文件原编码：解决冲突写回时原样回传，按原编码落盘
const conflictEncoding = ref('')
// 内容归属标记：rawContent/ours/theirs 三元组属于哪个路径（loadContent 成功
// 赋值时打标）——切文件窗口期/加载失败时内容与选中文件可能错位，委派载荷
// 据此守住「内容只随其归属文件出门」（错侧注入会误导 agent）
const contentLoadedFor = ref('')
// 载入解析时的磁盘内容 hash（content/parsed 响应带回，P-20261004-27）：整文件
// 保存与逐块合成写回均随请求回传作 baseHash 乐观锁基线；旧服务端无字段 = 空
// 直写兼容。写回 409（解析窗口期文件被外部改动）时置 staleConflict 引导重解析
const conflictBaseHash = ref('')
const staleConflict = ref(false)

const resolving = ref(false)

async function fetchConflicts() {
  if (!projectStore.currentProjectId) return
  loading.value = true
  try {
    const res: any = await conflictApi.list(projectStore.currentProjectId)
    // 后端返回 [{path, status}]（旧版本可能是 string[]），统一转成路径数组
    conflicts.value = (res.data || []).map((f: any) => (typeof f === 'string' ? f : f?.path)).filter(Boolean)
    inProgressOp.value = typeof res.inProgress === 'string' ? res.inProgress : ''
    if (conflicts.value.length > 0 && !selectedFile.value) {
      selectedFile.value = conflicts.value[0]!
      await loadContent()
    }
  } catch { /* 拦截器处理 */ } finally {
    loading.value = false
  }
}

async function loadContent() {
  if (!projectStore.currentProjectId || !selectedFile.value) return
  // 陈旧响应守卫：发起时记下目标文件，响应归来时选中项已变则整体丢弃——
  // 两路并行请求慢响应晚归会覆盖新选中文件的内容态（hunks/raw/hash 与选中
  // 文件错位，逐块模式等于拿 A 的块写 B 的文件；baseHash 乐观锁能拦截成 409，
  // 但 UI 态在源头丢弃更诚实，竞态窗口不再可见）
  const file = selectedFile.value
  contentLoading.value = true
  staleConflict.value = false
  try {
    // 原文 + 解析两路并行：原文供文本模式/逐块合成底稿，解析供 3way 与逐块
    const [rawRes, parsedRes]: any[] = await Promise.all([
      conflictApi.getContent(projectStore.currentProjectId, selectedFile.value),
      conflictApi.getParsed(projectStore.currentProjectId, selectedFile.value),
    ])
    if (selectedFile.value !== file) return
    const raw = typeof rawRes?.data === 'string' ? rawRes.data : ''
    rawContent.value = raw
    conflictContent.value = raw
    resultContent.value = raw
    conflictEncoding.value = typeof rawRes?.encoding === 'string' ? rawRes.encoding : ''
    // 乐观锁基线取 getContent 侧（与合成底稿同源一次读）；旧服务端无 hash 字段回落空
    conflictBaseHash.value = typeof rawRes?.hash === 'string' ? rawRes.hash : ''
    oursContent.value = parsedRes?.data?.ours || ''
    theirsContent.value = parsedRes?.data?.theirs || ''
    applyParsedHunks(parsedRes)
    // 三元组赋值完成才打标（异常路径不打标，委派载荷自动降级为无内容体）
    contentLoadedFor.value = selectedFile.value
  } catch { /* 拦截器处理 */ } finally {
    // 被守卫丢弃的陈旧调用不碰 loading 态——归当前在飞的调用管
    if (selectedFile.value === file) contentLoading.value = false
  }
}

// 消费 getParsed 扩展响应的 hunks/complex：块元素做形状守卫（行号非法的分段
// 一旦参与范围替换会写坏文件，宁缺毋滥整体降级）；complex 时丢弃 hunks 走整文件
function applyParsedHunks(parsedRes: any) {
  const list: unknown[] = Array.isArray(parsedRes?.hunks) ? parsedRes.hunks : []
  const valid = list.filter((h): h is ConflictHunk =>
    !!h && typeof h === 'object'
    && typeof (h as ConflictHunk).ours === 'string'
    && typeof (h as ConflictHunk).theirs === 'string'
    && ((h as ConflictHunk).base === undefined || typeof (h as ConflictHunk).base === 'string')
    && Number.isInteger((h as ConflictHunk).startLine) && (h as ConflictHunk).startLine >= 1
    && Number.isInteger((h as ConflictHunk).endLine) && (h as ConflictHunk).endLine >= (h as ConflictHunk).startLine)
  hunks.value = parsedRes?.complex === true ? [] : valid
  complexConflict.value = parsedRes?.complex === true
  // 逐块模式不可用（复杂形态/无块）时从逐块回退三方；其余模式尊重用户当前选择
  if (mode.value === 'hunks' && hunks.value.length === 0) {
    mode.value = '3way'
  }
}

function handleModeChange(newMode: 'hunks' | '3way' | 'text') {
  // 三种模式共享同一次加载的原文/解析数据，切换无需重新拉取（刷新按钮显式重取）
  mode.value = newMode
}

async function resolveConflict(strategy: string) {
  if (!projectStore.currentProjectId || !selectedFile.value) return
  resolving.value = true
  try {
    await conflictApi.resolve(projectStore.currentProjectId, selectedFile.value, strategy)
    message.success(t('conflict.conflictResolvedWith', { strategy: strategy }))
    window.dispatchEvent(new CustomEvent(OPS_FILES_EXTERNAL_CHANGE, { detail: { paths: [selectedFile.value] } }))
    await afterResolve()
  } catch { /* 拦截器处理 */ } finally {
    resolving.value = false
  }
}

// resolve-content 写回共用的 409 收口：解析快照到写回之间文件被外部改动
//（乐观锁失配，写回未发生）→ 置 staleConflict 横幅引导「重新解析」重走快照；
// 通用错误提示由拦截器 KNOWN_ERROR_I18N 映射，不在此重复弹
function onResolveError(err: unknown) {
  if (err instanceof AppError && err.status === 409) staleConflict.value = true
}

async function resolveWithContent() {
  if (!projectStore.currentProjectId || !selectedFile.value) return
  resolving.value = true
  try {
    const content = mode.value === '3way' ? resultContent.value : conflictContent.value
    await conflictApi.resolveWithContent(projectStore.currentProjectId, selectedFile.value, content, conflictEncoding.value, conflictBaseHash.value)
    message.success(t('conflict.conflictResolved'))
    window.dispatchEvent(new CustomEvent(OPS_FILES_EXTERNAL_CHANGE, { detail: { paths: [selectedFile.value] } }))
    await afterResolve()
  } catch (err) {
    onResolveError(err)
  } finally {
    resolving.value = false
  }
}

// 逐块合成写回：content 由 ConflictHunkList 合成（底稿 rawContent 按块区间替换），
// 走既有 resolve-content 保存链（原子写 + git add 标记 resolved），携带同一
// 载入基线 hash
async function handleHunkApply(content: string) {
  if (!projectStore.currentProjectId || !selectedFile.value) return
  resolving.value = true
  try {
    await conflictApi.resolveWithContent(projectStore.currentProjectId, selectedFile.value, content, conflictEncoding.value, conflictBaseHash.value)
    message.success(t('git.conflict.hunk.applied'))
    window.dispatchEvent(new CustomEvent(OPS_FILES_EXTERNAL_CHANGE, { detail: { paths: [selectedFile.value] } }))
    await afterResolve()
  } catch (err) {
    onResolveError(err)
  } finally {
    resolving.value = false
  }
}

async function afterResolve() {
  await fetchConflicts()
  if (conflicts.value.length > 0) {
    selectedFile.value = conflicts.value[0]!
    await loadContent()
  } else {
    selectedFile.value = ''
    oursContent.value = ''
    theirsContent.value = ''
    resultContent.value = ''
    conflictContent.value = ''
    rawContent.value = ''
    hunks.value = []
    complexConflict.value = false
    conflictBaseHash.value = ''
    staleConflict.value = false
    emit('all-resolved')
  }
}

function handleFileClick(file: string) {
  selectedFile.value = file
  loadContent()
}

// 委派发起（P-20261005-190）：弹层确认后组装载荷交给 useConflictAgentDelegate。
// 单文件内容取 loadContent 既有 ref（快照语义：以载入解析那一刻为准，委派不
// 触发重取；内容未就绪时字段为空，组装器按无冲突体降级——路径/语境永远在）。
// 只创建会话零自动化：agent 改文件走既有保存链，不自动 stage，用户变更面板终审
const { delegateConflicts } = useConflictAgentDelegate()

// 弹层徽标文案与 prompt 场景行同源（conflictOpLabel 单一映射）
const opLabelText = computed(() => conflictOpLabel(inProgressOp.value, t as unknown as ConflictTranslator))

function openAgentDialog(batch: boolean) {
  agentBatch.value = batch
  agentDialogShow.value = true
}

async function launchAgentDelegation(template: string) {
  // 内容载荷只在「归属对齐」（loadedFor=选中文件且加载完毕）时携带——切文件
  // 窗口期/加载失败时降级纯定位（路径/语境永远在，错侧内容绝不注入）
  const contentAligned = !contentLoading.value && contentLoadedFor.value === selectedFile.value
  const single: ConflictDelegateFile | undefined = agentBatch.value
    ? undefined
    : {
        path: selectedFile.value,
        raw: contentAligned ? rawContent.value : '',
        ours: contentAligned ? oursContent.value : '',
        theirs: contentAligned ? theirsContent.value : '',
      }
  await delegateConflicts({
    paths: agentBatch.value ? [...conflicts.value] : [selectedFile.value],
    single,
    op: inProgressOp.value,
    template,
  })
}

watch(() => projectStore.currentProjectId, (id) => {
  if (id) fetchConflicts()
})

onMounted(() => {
  if (projectStore.currentProjectId) fetchConflicts()
})
</script>

<template>
  <div
    v-if="!projectStore.currentProjectId"
    style="display: flex; align-items: center; justify-content: center; height: 100%"
  >
    <n-empty :description="t('common.noProject')" />
  </div>

  <div
    v-else
    style="display: flex; flex-direction: column; height: 100%"
  >
    <!-- 工具栏 -->
    <div style="background: var(--bg-panel); padding: 8px 12px; border-bottom: 1px solid var(--border-default); display: flex; gap: 8px; align-items: center">
      <span style="font-size: 13px; color: var(--text-body)">{{ t('conflict.conflictFiles') }}</span>
      <span style="font-size: 13px; color: var(--accent-red)">{{ conflicts.length }}</span>
      <div style="flex: 1" />
      <n-button
        size="small"
        @click="fetchConflicts"
      >
        {{ t('common.refresh') }}
      </n-button>
    </div>

    <div style="flex: 1; display: flex; overflow: hidden">
      <!-- 左侧冲突文件列表（P-20261005-190 拆出子组件，含批量委派入口） -->
      <ConflictFileList
        :files="conflicts"
        :loading="loading"
        :selected="selectedFile"
        @select="handleFileClick"
        @delegate-batch="openAgentDialog(true)"
      />

      <!-- 右侧冲突内容 -->
      <div style="flex: 1; display: flex; flex-direction: column; overflow: hidden">
        <div
          v-if="!selectedFile"
          style="display: flex; align-items: center; justify-content: center; height: 100%"
        >
          <n-empty :description="t('conflict.selectConflictFile')" />
        </div>
        <template v-else>
          <!-- 操作按钮 -->
          <div style="background: var(--bg-panel); padding: 6px 12px; border-bottom: 1px solid var(--border-default); display: flex; gap: 8px; align-items: center">
            <span style="font-size: 12px; color: var(--text-dim)">{{ t('conflict.resolveMethod') }}</span>
            <n-button
              size="tiny"
              type="primary"
              :loading="resolving"
              @click="resolveConflict('ours')"
            >
              {{ t('conflict.useOurs') }}
            </n-button>
            <n-button
              size="tiny"
              type="primary"
              :loading="resolving"
              @click="resolveConflict('theirs')"
            >
              {{ t('conflict.useTheirs') }}
            </n-button>
            <!-- 保存整文件编辑稿仅对 3way/文本模式有意义：逐块模式的编辑稿在块内，
                 保存 stale 底稿会悄悄覆盖用户的逐块选择 -->
            <n-button
              v-if="mode !== 'hunks'"
              size="tiny"
              type="info"
              :loading="resolving"
              @click="resolveWithContent"
            >
              {{ t('conflict.saveResult') }}
            </n-button>
            <!-- 交给智能体解决（P-20261005-190）：单文件委派入口，弹层确认后
                 新建 agent 会话（载荷=模板+路径+语境+冲突体节选），零自动化 -->
            <n-button
              size="tiny"
              type="warning"
              data-test="conflict-agent-btn"
              @click="openAgentDialog(false)"
            >
              {{ t('conflict.agent.delegate') }}
            </n-button>
            <div style="flex: 1" />
            <button
              v-if="hunks.length > 0"
              style="background: none; border: 1px solid var(--border-subtle); color: var(--text-body); padding: 2px 8px; border-radius: 3px; font-size: 11px; cursor: pointer"
              :style="{ borderColor: mode === 'hunks' ? 'var(--accent-blue-light)' : 'var(--border-subtle)' }"
              data-test="conflict-mode-hunks"
              @click="handleModeChange('hunks')"
            >
              {{ t('git.conflict.hunk.mode') }}
            </button>
            <button
              style="background: none; border: 1px solid var(--border-subtle); color: var(--text-body); padding: 2px 8px; border-radius: 3px; font-size: 11px; cursor: pointer"
              :style="{ borderColor: mode === '3way' ? 'var(--accent-blue-light)' : 'var(--border-subtle)' }"
              @click="handleModeChange('3way')"
            >
              {{ t('conflict.mode3way') }}
            </button>
            <button
              style="background: none; border: 1px solid var(--border-subtle); color: var(--text-body); padding: 2px 8px; border-radius: 3px; font-size: 11px; cursor: pointer"
              :style="{ borderColor: mode === 'text' ? 'var(--accent-blue-light)' : 'var(--border-subtle)' }"
              @click="handleModeChange('text')"
            >
              {{ t('conflict.modeText') }}
            </button>
          </div>

          <!-- 复杂形态降级提示（diff3/嵌套标记）：整文件模式仍可正常解决 -->
          <div
            v-if="complexConflict && mode !== 'text'"
            data-test="conflict-complex-hint"
            style="padding: 4px 12px; font-size: 11px; color: var(--accent-yellow); background: var(--bg-panel); border-bottom: 1px solid var(--border-default)"
          >
            {{ t('git.conflict.hunk.complexFallback') }}
          </div>

          <!-- 解析窗口期被外部改动的引导横幅（P-20261004-27）：写回被 409 拒绝
               未落盘，当前稿基于旧快照；重解析重走快照（工作区改动不丢，只是
               本面板的解决稿重来） -->
          <div
            v-if="staleConflict"
            data-test="conflict-stale-hint"
            style="padding: 4px 12px; font-size: 11px; color: var(--accent-red); background: var(--bg-panel); border-bottom: 1px solid var(--border-default); display: flex; gap: 8px; align-items: center"
          >
            <span style="flex: 1">{{ t('conflict.staleHint') }}</span>
            <n-button
              size="tiny"
              type="warning"
              data-test="conflict-stale-reload"
              :loading="contentLoading"
              @click="loadContent"
            >
              {{ t('conflict.staleReload') }}
            </n-button>
          </div>

          <!-- 逐块解决列表（P-20261003-59） -->
          <template v-if="mode === 'hunks'">
            <div
              v-if="contentLoading"
              style="padding: 20px; text-align: center"
            >
              <n-spin size="small" />
            </div>
            <ConflictHunkList
              v-else
              :hunks="hunks"
              :raw-content="rawContent"
              :resolving="resolving"
              @apply="handleHunkApply"
            />
          </template>

          <!-- 3-Way 可视化 -->
          <template v-else-if="mode === '3way'">
            <div
              v-if="contentLoading"
              style="padding: 20px; text-align: center"
            >
              <n-spin size="small" />
            </div>
            <div
              v-else
              style="flex: 1; display: flex; overflow: hidden"
            >
              <!-- Yours -->
              <div style="flex: 1; display: flex; flex-direction: column; border-right: 1px solid var(--border-default)">
                <div style="background: var(--bg-panel); padding: 4px 10px; border-bottom: 1px solid var(--border-default); font-size: 12px; color: var(--accent-blue-light); font-weight: 500">
                  {{ t('conflict.ours') }}
                </div>
                <div style="flex: 1; overflow: auto; padding: 8px; font-family: var(--font-mono); font-size: 12px; white-space: pre; color: var(--text-body); background: var(--bg-primary)">
                  {{ oursContent }}
                </div>
              </div>
              <!-- Result -->
              <div style="flex: 1; display: flex; flex-direction: column; border-right: 1px solid var(--border-default)">
                <div style="background: var(--bg-panel); padding: 4px 10px; border-bottom: 1px solid var(--border-default); font-size: 12px; color: var(--accent-yellow); font-weight: 500">
                  {{ t('conflict.result') }}
                </div>
                <textarea
                  v-model="resultContent"
                  style="flex: 1; background: var(--bg-primary); color: var(--text-body); border: none; resize: none; padding: 8px; font-family: var(--font-mono); font-size: 12px; outline: none"
                />
              </div>
              <!-- Theirs -->
              <div style="flex: 1; display: flex; flex-direction: column">
                <div style="background: var(--bg-panel); padding: 4px 10px; border-bottom: 1px solid var(--border-default); font-size: 12px; color: var(--accent-purple); font-weight: 500">
                  {{ t('conflict.theirs') }}
                </div>
                <div style="flex: 1; overflow: auto; padding: 8px; font-family: var(--font-mono); font-size: 12px; white-space: pre; color: var(--text-body); background: var(--bg-primary)">
                  {{ theirsContent }}
                </div>
              </div>
            </div>
          </template>

          <!-- 文本模式 -->
          <template v-else>
            <div
              v-if="contentLoading"
              style="padding: 20px; text-align: center"
            >
              <n-spin size="small" />
            </div>
            <n-input
              v-else
              v-model:value="conflictContent"
              type="textarea"
              :autosize="false"
              style="flex: 1; font-family: var(--font-mono); font-size: 13px"
            />
          </template>
        </template>
      </div>
    </div>

    <!-- 委派确认弹层（P-20261005-190）：模板可编辑，确认后发起 -->
    <ConflictAgentDialog
      v-model:show="agentDialogShow"
      :batch="agentBatch"
      :file="selectedFile"
      :count="conflicts.length"
      :op-label="opLabelText"
      @confirm="launchAgentDelegation"
    />
  </div>
</template>
