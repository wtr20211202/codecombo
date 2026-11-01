<script setup lang="ts">
import { ref, computed } from 'vue'
import { NButton, NIcon, NInput, NCheckbox, NSwitch, NSelect, useMessage } from 'naive-ui'
import { PlayOutline, StopOutline, TimeOutline, TrashOutline, GitNetworkOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import type { Runbook, RunbookOnFailure, FleetRunTargetCell } from '../../api/client'
import type { RunbookRunRequest, RunbookRunState } from '../../composables/useRunbookRunner'
import { useRunbookFleet } from '../../composables/useRunbookFleet'
import type { TermTab } from '../../composables/useTerminalTabs'
import { terminalApi } from '../../api/domains/terminal'
import { extractTemplateParams, interpolateTemplate } from '../../utils/textTemplate'
import {
  loadRunbookParamHistory,
  saveRunbookParamHistory,
  recordRunbookParamValues,
  filterRunbookParamValues,
  clearRunbookParamValues,
  type RunbookParamHistory,
} from '../../utils/runbookParamHistory'

/**
 * 运行书打开书区（自 RunbookPanel 按面板区拆分，纯搬运零逻辑改动）：
 * 步骤逐步发送（插入不执行）+ 完成勾选 + 序贯运行（P-20261004-13 onFailure
 * 语义）。执行器在宿主（TerminalView）持有，本区只发请求与呈现。
 * 步骤展开/填值态（expandedStep/paramValues/全书去重参数表单）是书内
 * transient——父面板按 :key=book.id 重挂本组件即等价原 openBook/backToList
 * 的显式重置；步骤勾选跨开关存续（doneSteps 记录归父面板，本区只读 + 上抛
 * 翻转，防跨组件直改 props 持有方状态）。
 */
const props = defineProps<{
  book: Runbook
  runState?: RunbookRunState | null
  /** 当前书的已完成步骤序号集合（父面板 doneSteps[book.id] 投影，只读） */
  done: number[]
  /** 舰队目标候选：底部面板 tab 列表（P-20261005-147，宿主 TerminalView 透传） */
  tabs?: TermTab[]
}>()

const emit = defineEmits<{
  (e: 'insert', command: string): void
  (e: 'run', payload: RunbookRunRequest): void
  (e: 'runStop'): void
  (e: 'toggleDone', index: number): void
  (e: 'resetDone'): void
  (e: 'updateOnfailure', v: boolean): void
}>()

const { t } = useI18n()
const message = useMessage()

// 带参步骤的内联参数输入（一次展开一步）；全书执行的去重参数表单
// （P-20261004-17）：值并入 paramValues 共享——同名参数在逐步内联展开处
// 同样预填（同名同值语义）
const expandedStep = ref<number | null>(null)
const paramValues = ref<Record<string, string>>({})
const runParamsExpanded = ref(false)
const runParamValues = ref<Record<string, string>>({})

// ── 参数历史值建议（P-20261004-112）：提交记环形史 + 参数框聚焦弹历史下拉 ──
// 与片段 snippetParamHistory 的同能力对称（运行书此前缺位）；下拉交互语沿
// useSearchHistory（ProjectSearch 查询历史下拉同款）：聚焦弹出、输入前缀过滤
// 补全、Esc/点选后本轮聚焦内收起（点击输入框可重新唤出）、尾部「清空」兜底
// （历史值可能含敏感串，只落本机 safeStorage）。历史环形随本区挂载读取一次
// （:key 重挂即重读，落盘值即时可见）
const paramHistory = ref<RunbookParamHistory>(loadRunbookParamHistory())

/** 当前打开书的某参数历史环形（新→旧） */
function paramRing(param: string): string[] {
  return paramHistory.value[props.book.id]?.[param] || []
}

// 下拉按「上下文:参数名」寻址（run: 全书表单 / step:i: 逐步内联），单开；
// 聚焦态与收起态分离（blur 收起，Esc/点选后本轮聚焦内不再自动弹出）
const focusedParamKey = ref<string | null>(null)
const dismissedParamKeys = ref<Record<string, boolean>>({})

function resetParamHistoryUi() {
  focusedParamKey.value = null
  dismissedParamKeys.value = {}
}

function paramHistoryVisible(key: string, param: string): boolean {
  return focusedParamKey.value === key &&
    !dismissedParamKeys.value[key] &&
    paramRing(param).length > 0
}

function paramHistoryItems(param: string, current: string): string[] {
  return filterRunbookParamValues(paramRing(param), current)
}

/** 输入前缀把历史全滤掉时保留下拉给空态提示（「无匹配」也是反馈，静默消失像坏了） */
function paramHistoryAllFilteredOut(key: string, param: string, current: string): boolean {
  return paramHistoryVisible(key, param) && current.trim() !== '' &&
    paramHistoryItems(param, current).length === 0
}

function onFocusParam(key: string) {
  focusedParamKey.value = key
  delete dismissedParamKeys.value[key]
}

function onBlurParam(key: string) {
  if (focusedParamKey.value === key) focusedParamKey.value = null
}

function closeParamHistory(key: string) {
  dismissedParamKeys.value[key] = true
}

function onParamInput(key: string) {
  // 手动编辑 → 补全重新可用（Esc 收起后一输入即恢复，浏览器地址栏同惯例；
  // 历史点选回填是父侧赋值，NInput 不 emit update:value，不误触这里）
  if (dismissedParamKeys.value[key]) delete dismissedParamKeys.value[key]
}

function onParamKeydown(key: string, param: string, e: KeyboardEvent) {
  // 分层关闭：下拉开着时 Esc 先收下拉并拦住面板级 Esc（同一次按键不做两件事）
  if (e.key === 'Escape' && paramHistoryVisible(key, param)) {
    e.preventDefault()
    e.stopPropagation()
    closeParamHistory(key)
  }
}

/** 点选回填：只填值不自动发车（运行书「插入不执行」的安全默认，提交仍是显式动作） */
function applyParamHistory(target: Record<string, string>, param: string, key: string, value: string) {
  target[param] = value
  closeParamHistory(key)
}

/** 清空一书一参的环形史（下拉尾部入口）：持久层 + 内存态同清 */
function onClearParamHistory(key: string, param: string) {
  paramHistory.value = clearRunbookParamValues(paramHistory.value, props.book.id, param)
  saveRunbookParamHistory(paramHistory.value)
  closeParamHistory(key)
}

/** 提交记史：per-book per-param 环形 ≤5（非空白值入史、去重置顶；书数 LRU
 *  封顶在 util 内收敛），下次参数框聚焦弹历史下拉点选回填 */
function rememberParams(values: Record<string, string>) {
  paramHistory.value = recordRunbookParamValues(paramHistory.value, props.book.id, values)
  saveRunbookParamHistory(paramHistory.value)
}

const expandedParams = computed(() =>
  expandedStep.value !== null
    ? extractTemplateParams(props.book.steps[expandedStep.value]?.command || '')
    : [],
)

function isDone(index: number): boolean {
  return props.done.includes(index)
}

/** 发送步骤：无占位符直接插值发送；有占位符先展开填值区（同名参数预填已填值）。
 *  插入永远交给宿主 writeInput（不执行），发送完成自动勾选 */
function sendStep(index: number) {
  const step = props.book.steps[index]
  if (!step) return
  const params = extractTemplateParams(step.command)
  if (params.length > 0 && expandedStep.value !== index) {
    expandedStep.value = index
    const pre: Record<string, string> = {}
    for (const p of params) {
      if (paramValues.value[p]) pre[p] = paramValues.value[p]
    }
    paramValues.value = pre
    return
  }
  if (params.length > 0) rememberParams(paramValues.value)
  emit('insert', interpolateTemplate(step.command, paramValues.value))
  if (!isDone(index)) emit('toggleDone', index)
  expandedStep.value = null
  paramValues.value = {}
  resetParamHistoryUi()
}

// ── 序贯运行（P-20261004-13 onFailure 语义）──
// 执行器在宿主（TerminalView）：本区发 run 请求（插值后的命令 + 起始位 +
// onFailure）与停止请求，执行态经 props.runState 呈现（面板关闭运行不中断）

const runForBook = computed(() =>
  props.runState && props.runState.bookId === props.book.id ? props.runState : null,
)
const runActive = computed(
  () => !!runForBook.value && (runForBook.value.phase === 'running' || runForBook.value.phase === 'awaitingExit'),
)

// 主按钮文案：无运行=运行 / 停在失败项=从失败项继续 / 用户停止=继续运行 / 跑完=重新运行
const runButtonLabel = computed(() => {
  const r = runForBook.value
  if (!r || r.phase === 'running' || r.phase === 'awaitingExit') return t('runbook.run')
  if (r.phase === 'failed') return t('runbook.resumeFailed')
  if (r.phase === 'stopped') return t('runbook.continueRun')
  return t('runbook.rerun')
})

const runFromIndex = computed(() => {
  const r = runForBook.value
  if (!r) return 0
  if (r.phase === 'failed') return r.failedIndex
  if (r.phase === 'stopped') return r.cursor
  return 0
})

const runStatusText = computed(() => {
  const r = runForBook.value
  if (!r) return ''
  if (r.phase === 'failed') return t('runbook.runFailedAt', { n: r.failedIndex + 1 })
  if (r.phase === 'stopped') return t('runbook.runStopped')
  if (r.phase === 'finished') return t('runbook.runDone')
  const settled = r.states.filter((s) => s === 'done' || s === 'failed').length
  return t('runbook.runProgress', { done: settled, n: r.commands.length })
})

function stepRunState(i: number): RunbookRunState['states'][number] | null {
  return runForBook.value?.states[i] ?? null
}

/** 待执行步骤（fromIndex 起）的占位符并集去重：多步共享同名参数只收一个 */
const pendingRunParams = computed(() => {
  const names: string[] = []
  for (let i = runFromIndex.value; i < props.book.steps.length; i++) {
    for (const p of extractTemplateParams(props.book.steps[i]?.command || '')) {
      if (!names.includes(p)) names.push(p)
    }
  }
  return names
})

/** 运行入口：有待填占位符先展开全书去重参数表单，无参直接发车 */
function startRun() {
  if (runActive.value) return
  if (pendingRunParams.value.length > 0) {
    const pre: Record<string, string> = {}
    for (const p of pendingRunParams.value) {
      if (paramValues.value[p]) pre[p] = paramValues.value[p]
    }
    runParamValues.value = pre
    runParamsExpanded.value = true
    return
  }
  emitRun()
}

/** 表单确认：值并入共享 paramValues（逐步内联展开同享），统一插值后发车 */
/** 表单确认：值并入共享 paramValues（逐步内联展开同享），统一插值后发车。
 *  舰队链路（P-20261005-147）同一份去重表单：按 fleetPendingLaunch 分流发车 */
function confirmRunParams() {
  rememberParams(runParamValues.value)
  paramValues.value = { ...paramValues.value, ...runParamValues.value }
  runParamsExpanded.value = false
  runParamValues.value = {}
  resetParamHistoryUi()
  if (fleetPendingLaunch.value) {
    launchFleet()
    return
  }
  emitRun()
}

function cancelRunParams() {
  runParamsExpanded.value = false
  runParamValues.value = {}
  resetParamHistoryUi()
  fleetPendingLaunch.value = false
}

function emitRun() {
  if (runActive.value) return
  emit('run', {
    bookId: props.book.id,
    commands: props.book.steps.map((s) => interpolateTemplate(s.command, paramValues.value)),
    onFailure: (props.book.onFailure || 'continue') as RunbookOnFailure,
    fromIndex: runFromIndex.value,
  })
}

/** 失败即停开关：运行态守卫在发件侧判定（开关禁用态的兜底），乐观改书 +
 *  API 更新 + 失败回滚在父面板（books 数组持有方，子组件不改 props 持有对象） */
function updateOnFailure(v: boolean) {
  if (!props.book || runActive.value) return
  emit('updateOnfailure', v)
}

// ── 舰队运行（P-20261005-147）：目标多选 + 服务端编排 + 步骤×目标矩阵 ──
// 逻辑层在 useRunbookFleet（候选/选择/发车/中止/重试/task.progress 合并），
// 本视图只组装候选与呈现。参数沿用全书去重表单（P-17 同一份 pendingRunParams/
// runParamValues，confirmRunParams 按 fleetPending 分流发车目标）。切换书=
// 壳层 :key=book.id 重挂本组件，舰队瞬态（展开/点格输出）随之清账
const fleetExpanded = ref(false)
const fleetPendingLaunch = ref(false)
const fleetTimeoutMs = ref(120_000)

const fleetTabsRef = computed<TermTab[]>(() => props.tabs ?? [])
const fleet = useRunbookFleet({ tabs: fleetTabsRef })

const fleetRunning = computed(() => fleet.run.value?.status === 'running')
const fleetRunForBook = computed(() =>
  fleet.run.value && fleet.run.value.bookId === props.book.id ? fleet.run.value : null,
)

function toggleFleet() {
  fleetExpanded.value = !fleetExpanded.value
  if (fleetExpanded.value) void fleet.refreshCandidates()
}

/** 舰队发车入口：参数校验/去重表单与单会话运行同链，确认后按 fleet 分流 */
function startFleetRun() {
  const b = props.book
  if (!b || fleetRunning.value) return
  if (fleet.selectedIds.value.size === 0) {
    message.warning(t('runbook.fleet.needTargets'))
    return
  }
  if (pendingRunParams.value.length > 0) {
    const pre: Record<string, string> = {}
    for (const p of pendingRunParams.value) {
      if (paramValues.value[p]) pre[p] = paramValues.value[p]
    }
    runParamValues.value = pre
    runParamsExpanded.value = true
    fleetPendingLaunch.value = true
    return
  }
  void launchFleet()
}

function launchFleet() {
  const b = props.book
  if (!b) return
  void fleet.launch({
    bookId: b.id,
    title: b.title,
    targetIds: [...fleet.selectedIds.value],
    params: { ...runParamValues.value },
    onFailure: (b.onFailure || 'continue') as RunbookOnFailure,
    stepTimeoutMs: fleetTimeoutMs.value,
  })
  fleetPendingLaunch.value = false
}

/** 矩阵格状态类（CSS 色彩语义与运行态指示同族） */
function fleetCellClass(c: FleetRunTargetCell | undefined): string {
  if (!c) return 'is-pending'
  return `is-${c.status}`
}

/** 矩阵格摘要（title 悬停全量：状态 + 退出码/标注） */
function fleetCellText(c: FleetRunTargetCell | undefined): string {
  if (!c) return '·'
  if (c.status === 'skipped') return '–'
  if (c.status === 'aborted') return '■'
  if (c.noSignal) return '◌'
  if (c.timedOut) return '⏱'
  if (c.exitCode !== undefined) return c.exitCode === 0 ? '✓' : String(c.exitCode)
  return '·'
}

function fleetCellTitle(c: FleetRunTargetCell | undefined): string {
  if (!c) return t('runbook.fleet.pending')
  if (c.status === 'skipped') return t('runbook.fleet.skipped')
  if (c.status === 'aborted') return t('runbook.fleet.abortedCell')
  if (c.noSignal) return t('runbook.fleet.noSignal')
  if (c.timedOut) return t('runbook.fleet.timedOut')
  if (c.status === 'failed') return t('runbook.fleet.failedWithCode', { n: c.exitCode ?? '?' })
  return t('runbook.fleet.doneWithCode', { n: c.exitCode ?? 0 })
}

/** 点格看输出：该会话 scrollback 尾部（P-20261005-12 聚合视图的单步化——
 *  端点对远程代理同构，混合目标同链；ANSI 剥离同款正则） */
const fleetOutputKey = ref('') // `${stepIndex}:${targetId}`
const fleetOutputText = ref('')
const fleetOutputLoading = ref(false)
const fleetOutputError = ref(false)
let fleetOutputGen = 0

// eslint-disable-next-line no-control-regex
const FLEET_ANSI_RE = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g

async function toggleFleetOutput(stepIndex: number, targetId: string) {
  const key = `${stepIndex}:${targetId}`
  if (fleetOutputKey.value === key) {
    fleetOutputKey.value = ''
    fleetOutputText.value = ''
    return
  }
  fleetOutputKey.value = key
  const gen = ++fleetOutputGen
  fleetOutputLoading.value = true
  fleetOutputError.value = false
  try {
    // silent：拉取失败在详情区就地呈现（会话刚消失的 404 是预期形态）
    const buf = (await terminalApi.scrollback(targetId, { silent: true })) as unknown as ArrayBuffer
    if (gen !== fleetOutputGen) return
    const text = new TextDecoder('utf-8', { fatal: false }).decode(buf).replace(FLEET_ANSI_RE, '')
    const lines = text.replace(/\n+$/, '').split('\n')
    fleetOutputText.value = lines.slice(-30).join('\n')
  } catch {
    if (gen !== fleetOutputGen) return
    fleetOutputError.value = true
  } finally {
    if (gen === fleetOutputGen) fleetOutputLoading.value = false
  }
}

/** 重试单格：失败/中止格的小按钮，走 fleet.retryCell（响应即重算全矩阵） */
async function retryFleetCell(stepIndex: number, targetId: string) {
  const b = props.book
  const r = fleet.run.value
  if (!b || !r || !r.runId || r.status === 'running') return
  await fleet.retryCell(b.id, stepIndex, targetId)
}

/** 可重试格 = failed | aborted（服务端同判；done 防双跑，skipped 是未发送） */
function canRetryCell(c: FleetRunTargetCell | undefined): boolean {
  return !!c && (c.status === 'failed' || c.status === 'aborted')
}

/** 舰队终态徽标文案 */
const fleetStatusLabel = computed(() => {
  const r = fleetRunForBook.value
  if (!r) return ''
  if (r.status === 'running') return t('runbook.fleet.statusRunning')
  if (r.status === 'completed') return t('runbook.fleet.statusCompleted')
  if (r.status === 'failed') return t('runbook.fleet.statusFailed')
  return t('runbook.fleet.statusAborted')
})
</script>

<template>
  <div class="runbook-steps-actions">
    <div
      class="runbook-onfailure-toggle"
      :title="t('runbook.onFailureHint')"
    >
      <n-switch
        size="small"
        :value="book.onFailure === 'stop'"
        :disabled="runActive"
        @update:value="updateOnFailure"
      />
      <span class="runbook-onfailure-label">{{ t('runbook.onFailure') }}</span>
    </div>
    <div class="runbook-steps-actions-right">
      <n-button
        size="tiny"
        quaternary
        @click="emit('resetDone')"
      >
        {{ t('runbook.resetCheck') }}
      </n-button>
      <n-button
        v-if="runActive"
        size="tiny"
        type="error"
        secondary
        @click="emit('runStop')"
      >
        <template #icon>
          <n-icon size="13">
            <StopOutline />
          </n-icon>
        </template>
        {{ t('runbook.stopRun') }}
      </n-button>
      <n-button
        v-else
        size="tiny"
        type="primary"
        secondary
        :title="t('runbook.runHint')"
        @click="startRun"
      >
        <template #icon>
          <n-icon size="13">
            <PlayOutline />
          </n-icon>
        </template>
        {{ runButtonLabel }}
      </n-button>
    </div>
  </div>

  <!-- 运行态指示：进度 / 停止位 / 完成（执行器在宿主，面板关闭不中断） -->
  <div
    v-if="runForBook"
    class="runbook-run-status"
    :class="`is-${runForBook.phase}`"
  >
    <span class="runbook-run-dot" />
    <span>{{ runStatusText }}</span>
  </div>
  <div
    v-if="runForBook?.degraded"
    class="runbook-run-degraded"
  >
    {{ t('runbook.degradedNotice') }}
  </div>

  <!-- 全书去重参数表单（P-20261004-17）：执行前一次填完，多步同名参数只问一次 -->
  <div
    v-if="runParamsExpanded && pendingRunParams.length > 0"
    class="runbook-runparams"
    @click.stop
  >
    <div class="runbook-runparams-head">
      <span class="runbook-runparams-title">{{ t('runbook.runParamsTitle') }}</span>
      <span class="runbook-runparams-hint">{{ t('runbook.runParamsHint') }}</span>
    </div>
    <div
      v-for="p in pendingRunParams"
      :key="p"
      class="runbook-param-row"
    >
      <label class="runbook-param-label">{{ p }}</label>
      <div class="runbook-param-field">
        <n-input
          v-model:value="runParamValues[p]"
          size="small"
          :placeholder="p"
          :data-testid="`rb-param-input-run-${p}`"
          @focus="onFocusParam(`run:${p}`)"
          @click="onFocusParam(`run:${p}`)"
          @blur="onBlurParam(`run:${p}`)"
          @update:value="onParamInput(`run:${p}`)"
          @keydown="onParamKeydown(`run:${p}`, p, $event)"
        />
        <!-- 参数历史下拉（P-20261004-112）：mousedown.prevent 保输入框焦点
             （点击不先触发 blur）；点选只回填，发车仍走显式确认钮 -->
        <div
          v-if="paramHistoryVisible(`run:${p}`, p)"
          class="runbook-history"
          data-testid="rb-history"
          @mousedown.prevent
        >
          <div
            v-if="paramHistoryAllFilteredOut(`run:${p}`, p, runParamValues[p] || '')"
            class="runbook-history-empty"
            data-testid="rb-history-empty"
          >
            {{ t('runbook.paramHistoryEmpty') }}
          </div>
          <div
            v-else
            class="runbook-history-list"
          >
            <button
              v-for="(h, hi) in paramHistoryItems(p, runParamValues[p] || '')"
              :key="h"
              class="runbook-history-item"
              :data-testid="`rb-history-item-${hi}`"
              :title="h"
              @click="applyParamHistory(runParamValues, p, `run:${p}`, h)"
            >
              <n-icon
                size="12"
                class="runbook-history-item-icon"
              >
                <TimeOutline />
              </n-icon>
              <span class="runbook-history-item-text">{{ h }}</span>
            </button>
          </div>
          <button
            class="runbook-history-clear"
            data-testid="rb-history-clear"
            @click="onClearParamHistory(`run:${p}`, p)"
          >
            <n-icon size="12">
              <TrashOutline />
            </n-icon>
            <span>{{ t('runbook.paramHistoryClear') }}</span>
          </button>
        </div>
      </div>
    </div>
    <div class="runbook-runparams-actions">
      <n-button
        size="tiny"
        @click="cancelRunParams"
      >
        {{ t('common.cancel') }}
      </n-button>
      <n-button
        size="tiny"
        type="primary"
        @click="confirmRunParams"
      >
        {{ t('runbook.runParamsConfirm') }}
      </n-button>
    </div>
  </div>

      <!-- 舰队运行（P-20261005-147）：目标多选 + 服务端编排 + 步骤×目标矩阵。
           服务端执行面板不依赖宿主终端——矩阵是 task.progress 事件驱动合并态 -->
      <div class="runbook-fleet">
        <div class="runbook-fleet-head">
          <button
            class="runbook-fleet-toggle"
            :class="{ 'is-open': fleetExpanded }"
            data-testid="rb-fleet-toggle"
            :title="t('runbook.fleet.hint')"
            @click="toggleFleet"
          >
            <n-icon size="12">
              <GitNetworkOutline />
            </n-icon>
            <span>{{ t('runbook.fleet.title') }}</span>
          </button>
          <span
            v-if="fleetRunForBook"
            class="runbook-fleet-status"
            :class="`is-${fleetRunForBook.status}`"
            data-testid="rb-fleet-status"
          >{{ fleetStatusLabel }}</span>
        </div>

        <div
          v-if="fleetExpanded"
          class="runbook-fleet-body"
          @click.stop
        >
          <!-- 发车前：目标选择（三组候选全显式勾选）+ 超时档位 -->
          <template v-if="!fleetRunForBook">
            <div class="runbook-fleet-hint">
              {{ t('runbook.fleet.hint') }}
            </div>
            <div
              v-if="fleetTabsRef.length > 0"
              class="runbook-fleet-group"
            >
              <div class="runbook-fleet-group-title">
                {{ t('runbook.fleet.groupLocal') }}
              </div>
              <div
                v-for="tb in fleetTabsRef"
                :key="tb.id"
                class="runbook-fleet-target"
              >
                <n-checkbox
                  size="small"
                  :checked="fleet.selectedIds.value.has(tb.id)"
                  @update:checked="fleet.toggleTarget(tb.id)"
                />
                <span
                  class="runbook-fleet-target-name"
                  :title="tb.name"
                >{{ tb.name }}</span>
              </div>
            </div>
            <div
              v-if="fleet.agentCandidates.value.length > 0"
              class="runbook-fleet-group"
            >
              <div class="runbook-fleet-group-title">
                {{ t('runbook.fleet.groupAgent') }}
              </div>
              <div
                v-for="s in fleet.agentCandidates.value"
                :key="s.id"
                class="runbook-fleet-target"
              >
                <n-checkbox
                  size="small"
                  :checked="fleet.selectedIds.value.has(s.id)"
                  @update:checked="fleet.toggleTarget(s.id)"
                />
                <span
                  class="runbook-fleet-target-name"
                  :title="s.name"
                >{{ s.name }}</span>
              </div>
            </div>
            <div
              v-if="fleet.remoteCandidates.value.length > 0"
              class="runbook-fleet-group"
            >
              <div class="runbook-fleet-group-title">
                {{ t('runbook.fleet.groupRemote') }}
              </div>
              <div
                v-for="r in fleet.remoteCandidates.value"
                :key="r.id"
                class="runbook-fleet-target"
              >
                <n-checkbox
                  size="small"
                  :checked="fleet.selectedIds.value.has(r.id)"
                  @update:checked="fleet.toggleTarget(r.id)"
                />
                <span
                  class="runbook-fleet-target-name"
                  :title="r.host"
                >{{ r.host }}</span>
              </div>
            </div>
            <div class="runbook-fleet-actions">
              <n-select
                v-model:value="fleetTimeoutMs"
                size="tiny"
                class="runbook-fleet-timeout"
                :options="fleet.timeoutOptions.map(o => ({ label: t('runbook.fleet.timeout', { v: o.label }), value: o.value }))"
                :consistent-menu-width="false"
              />
              <n-button
                size="tiny"
                type="primary"
                secondary
                data-testid="rb-fleet-launch"
                :loading="fleet.launching.value"
                @click="startFleetRun"
              >
                {{ t('runbook.fleet.launch') }}
              </n-button>
            </div>
          </template>

          <!-- 发车后：矩阵（行=步骤，列=目标）+ 中止/单格重试 -->
          <template v-else>
            <div class="runbook-fleet-runbar">
              <span
                v-if="fleetRunning"
                class="runbook-fleet-step"
              >{{ fleet.stepText.value || t('runbook.fleet.statusRunning') }}</span>
              <n-button
                v-if="fleetRunning && fleetRunForBook.runId"
                size="tiny"
                type="error"
                secondary
                data-testid="rb-fleet-abort"
                :loading="fleet.aborting.value"
                @click="fleet.abort()"
              >
                {{ t('runbook.fleet.abort') }}
              </n-button>
            </div>
            <div
              v-if="fleet.connectionLost.value"
              class="runbook-fleet-notice"
            >
              {{ t('runbook.fleet.connectionLost') }}
            </div>
            <div
              class="runbook-fleet-matrix"
              data-testid="rb-fleet-matrix"
            >
              <table>
                <thead>
                  <tr>
                    <th class="runbook-fleet-step-col" />
                    <th
                      v-for="tid in fleetRunForBook.targetIds"
                      :key="tid"
                      class="runbook-fleet-target-col"
                      :title="fleet.targetName(tid)"
                    >
                      {{ fleet.targetName(tid) }}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="(name, si) in fleetRunForBook.stepNames"
                    :key="si"
                  >
                    <td
                      class="runbook-fleet-step-col"
                      :title="name"
                    >
                      {{ si + 1 }}. {{ name }}
                    </td>
                    <td
                      v-for="tid in fleetRunForBook.targetIds"
                      :key="tid"
                      class="runbook-fleet-cell"
                      :class="fleetCellClass(fleetRunForBook.cells[si]?.[tid])"
                      :title="fleetCellTitle(fleetRunForBook.cells[si]?.[tid])"
                      @click="toggleFleetOutput(si, tid)"
                    >
                      <span class="runbook-fleet-cell-mark">{{ fleetCellText(fleetRunForBook.cells[si]?.[tid]) }}</span>
                      <button
                        v-if="canRetryCell(fleetRunForBook.cells[si]?.[tid])"
                        class="runbook-fleet-retry"
                        :data-testid="`rb-fleet-retry-${si}-${tid}`"
                        :title="t('runbook.fleet.retry')"
                        @click.stop="retryFleetCell(si, tid)"
                      >
                        ↻
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <!-- 点格回看：该会话 scrollback 尾部（P-20261005-12 聚合视图单步化） -->
            <div
              v-if="fleetOutputKey"
              class="runbook-fleet-output"
              data-testid="rb-fleet-output"
            >
              <div
                v-if="fleetOutputLoading"
                class="runbook-fleet-output-loading"
              >
                {{ t('runbook.fleet.outputLoading') }}
              </div>
              <div
                v-else-if="fleetOutputError"
                class="runbook-fleet-output-error"
              >
                {{ t('runbook.fleet.outputFailed') }}
              </div>
              <pre
                v-else
                class="runbook-fleet-output-pre"
              >{{ fleetOutputText || t('runbook.fleet.outputEmpty') }}</pre>
            </div>
          </template>
        </div>
      </div>
  <div class="runbook-list">
    <div
      v-for="(s, i) in book.steps"
      :key="i"
      class="runbook-step"
      :class="{
        'is-done': isDone(i),
        'is-run-active': stepRunState(i) === 'running',
        'is-run-done': stepRunState(i) === 'done',
        'is-run-failed': stepRunState(i) === 'failed',
      }"
    >
      <div class="runbook-step-row">
        <n-checkbox
          size="small"
          class="runbook-step-check"
          :checked="isDone(i)"
          :title="t('runbook.done')"
          @update:checked="emit('toggleDone', i)"
        />
        <span class="runbook-step-no">{{ i + 1 }}</span>
        <div class="runbook-step-body">
          <div
            class="runbook-step-cmd"
            :title="s.command"
          >{{ s.command }}</div>
          <div
            v-if="s.description"
            class="runbook-step-desc"
            :title="s.description"
          >{{ s.description }}</div>
        </div>
        <n-button
          size="tiny"
          type="primary"
          secondary
          @click="sendStep(i)"
        >
          {{ expandedStep === i ? t('runbook.sendWithParams') : t('runbook.send') }}
        </n-button>
      </div>
      <!-- 带参步骤的内联填值区（不弹新窗） -->
      <div
        v-if="expandedStep === i"
        class="runbook-params"
        @click.stop
      >
        <div
          v-for="p in expandedParams"
          :key="p"
          class="runbook-param-row"
        >
          <label class="runbook-param-label">{{ p }}</label>
          <div class="runbook-param-field">
            <n-input
              v-model:value="paramValues[p]"
              size="small"
              :placeholder="p"
              :data-testid="`rb-param-input-step-${i}-${p}`"
              @focus="onFocusParam(`step:${i}:${p}`)"
              @click="onFocusParam(`step:${i}:${p}`)"
              @blur="onBlurParam(`step:${i}:${p}`)"
              @update:value="onParamInput(`step:${i}:${p}`)"
              @keydown="onParamKeydown(`step:${i}:${p}`, p, $event)"
            />
            <!-- 参数历史下拉（P-20261004-112）：与全书表单同款交互 -->
            <div
              v-if="paramHistoryVisible(`step:${i}:${p}`, p)"
              class="runbook-history"
              data-testid="rb-history"
              @mousedown.prevent
            >
              <div
                v-if="paramHistoryAllFilteredOut(`step:${i}:${p}`, p, paramValues[p] || '')"
                class="runbook-history-empty"
                data-testid="rb-history-empty"
              >
                {{ t('runbook.paramHistoryEmpty') }}
              </div>
              <div
                v-else
                class="runbook-history-list"
              >
                <button
                  v-for="(h, hi) in paramHistoryItems(p, paramValues[p] || '')"
                  :key="h"
                  class="runbook-history-item"
                  :data-testid="`rb-history-item-${hi}`"
                  :title="h"
                  @click="applyParamHistory(paramValues, p, `step:${i}:${p}`, h)"
                >
                  <n-icon
                    size="12"
                    class="runbook-history-item-icon"
                  >
                    <TimeOutline />
                  </n-icon>
                  <span class="runbook-history-item-text">{{ h }}</span>
                </button>
              </div>
              <button
                class="runbook-history-clear"
                data-testid="rb-history-clear"
                @click="onClearParamHistory(`step:${i}:${p}`, p)"
              >
                <n-icon size="12">
                  <TrashOutline />
                </n-icon>
                <span>{{ t('runbook.paramHistoryClear') }}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.runbook-steps-actions {
  display: flex; align-items: center; justify-content: space-between; gap: 6px;
  padding: 4px 10px; border-bottom: 1px solid var(--border-subtle); flex-shrink: 0;
}
.runbook-steps-actions-right { display: flex; align-items: center; gap: 4px; }
.runbook-onfailure-toggle { display: flex; align-items: center; gap: 6px; min-width: 0; }
/* .runbook-onfailure-label 与新建表单区（RunbookCreateForm）共用同款——
   scoped 边界各自带一份同值规则，改动需两边同步 */
.runbook-onfailure-label { font-size: 11px; color: var(--text-secondary); white-space: nowrap; }

.runbook-run-status {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 10px; border-bottom: 1px solid var(--border-subtle); flex-shrink: 0;
  font-size: 11px; color: var(--text-secondary);
}
.runbook-run-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--status-running); flex-shrink: 0; }
.runbook-run-status.is-running .runbook-run-dot,
.runbook-run-status.is-awaitingExit .runbook-run-dot { animation: runbook-run-pulse 1.2s ease-in-out infinite; }
.runbook-run-status.is-failed { color: var(--status-failed); }
.runbook-run-status.is-failed .runbook-run-dot { background: var(--status-failed); }
.runbook-run-status.is-finished { color: var(--status-success); }
.runbook-run-status.is-finished .runbook-run-dot { background: var(--status-success); }
.runbook-run-status.is-stopped .runbook-run-dot { background: var(--text-dim); }
@keyframes runbook-run-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
.runbook-run-degraded {
  padding: 5px 10px; border-bottom: 1px solid var(--border-subtle); flex-shrink: 0;
  font-size: 10px; line-height: 1.5; color: var(--accent-yellow-warm);
}

/* 全书去重参数表单（P-20261004-17）：与逐步内联填值区（.runbook-params）同款盒式 */
.runbook-runparams {
  margin: 8px 10px 4px;
  padding: 8px;
  border: 1px solid var(--border-default);
  border-radius: 6px;
  background: var(--bg-elevated);
  flex-shrink: 0;
}
.runbook-runparams-head { display: flex; flex-direction: column; gap: 2px; margin-bottom: 6px; }
.runbook-runparams-title { font-size: 11px; font-weight: 600; color: var(--text-primary); }
.runbook-runparams-hint { font-size: 10px; color: var(--text-dim); line-height: 1.5; }
.runbook-runparams-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 6px; }

/* .runbook-list 在打开书步骤区与列表区（RunbookBookList）两处同名同款——
   scoped 边界各自带一份同值规则，改动需两边同步 */
.runbook-list { flex: 1; overflow-y: auto; padding: 4px 0; }
.runbook-step { padding: 6px 10px; }
.runbook-step:hover { background: var(--bg-hover); }
.runbook-step.is-done .runbook-step-cmd { color: var(--text-dim); text-decoration: line-through; }
/* 执行态（P-20261004-13）：与勾选态（is-done）相互独立——运行进度/失败停止位 */
.runbook-step.is-run-active { background: var(--bg-hover); }
.runbook-step.is-run-active .runbook-step-no { color: var(--status-running); }
.runbook-step.is-run-done .runbook-step-no { color: var(--status-success); }
.runbook-step.is-run-failed {
  background: color-mix(in srgb, var(--status-failed) 10%, transparent);
  border-left: 2px solid var(--status-failed);
  padding-left: 8px;
}
.runbook-step.is-run-failed .runbook-step-no,
.runbook-step.is-run-failed .runbook-step-cmd { color: var(--status-failed); }
.runbook-step-row { display: flex; align-items: flex-start; gap: 8px; }
.runbook-step-check { flex-shrink: 0; margin-top: 1px; }
.runbook-step-no {
  flex-shrink: 0; min-width: 16px; text-align: right;
  font-family: var(--font-mono, monospace);
  font-size: 11px; color: var(--text-dim); margin-top: 2px;
}
.runbook-step-body { flex: 1; min-width: 0; }
.runbook-step-cmd {
  font-family: var(--font-mono, monospace);
  font-size: 11px; color: var(--text-body);
  white-space: pre-wrap; word-break: break-all;
}
.runbook-step-desc {
  margin-top: 2px;
  font-size: 10px; color: var(--text-muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.runbook-params {
  margin: 6px 0 2px 40px;
  padding: 8px;
  border: 1px solid var(--border-default);
  border-radius: 6px;
  background: var(--bg-elevated);
}
.runbook-param-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.runbook-param-row:last-child { margin-bottom: 0; }
.runbook-param-label {
  width: 90px; flex-shrink: 0;
  font-family: var(--font-mono, monospace);
  font-size: 11px; color: var(--text-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  text-align: right;
}
.runbook-param-field { position: relative; flex: 1; min-width: 0; }

/* 参数历史下拉（P-20261004-112）：ProjectSearch 查询历史下拉（.ps-history）同族形态 */
.runbook-history {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 30;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  box-shadow: var(--shadow-strong);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.runbook-history-list { max-height: 160px; overflow-y: auto; }
.runbook-history-empty {
  padding: 12px 10px;
  text-align: center;
  font-size: 11px;
  color: var(--text-muted);
}
.runbook-history-item {
  display: flex; align-items: center; gap: 8px;
  width: 100%;
  padding: 5px 10px;
  border: none;
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background var(--motion-fast);
}
.runbook-history-item:hover { background: var(--bg-hover); }
.runbook-history-item-icon { color: var(--text-dim); flex-shrink: 0; }
.runbook-history-item-text {
  flex: 1; min-width: 0;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-body);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.runbook-history-clear {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 10px;
  border: none;
  border-top: 1px solid var(--border-subtle);
  background: transparent;
  font-size: 10px;
  color: var(--text-muted);
  cursor: pointer;
  transition: background var(--motion-fast), color var(--motion-fast);
}
.runbook-history-clear:hover { background: var(--bg-hover); color: var(--accent-red); }
/* ── 舰队运行（P-20261005-147）：目标多选 + 步骤×目标矩阵 ── */
.runbook-fleet { border-bottom: 1px solid var(--border-subtle); flex-shrink: 0; }
.runbook-fleet-head {
  display: flex; align-items: center; justify-content: space-between; gap: 6px;
  padding: 5px 10px;
}
.runbook-fleet-toggle {
  display: flex; align-items: center; gap: 5px;
  border: none; background: none; padding: 2px 4px; cursor: pointer;
  font-size: 11px; font-weight: 600; color: var(--text-secondary);
  border-radius: 4px;
}
.runbook-fleet-toggle:hover { background: var(--bg-hover); color: var(--text-primary); }
.runbook-fleet-toggle.is-open { color: var(--text-primary); }
.runbook-fleet-status {
  font-size: 10px; color: var(--text-dim);
  padding: 0 5px; border-radius: 4px; border: 1px solid var(--border-subtle);
}
.runbook-fleet-status.is-running { color: var(--status-running); border-color: var(--status-running); }
.runbook-fleet-status.is-completed { color: var(--status-success); border-color: var(--status-success); }
.runbook-fleet-status.is-failed { color: var(--status-failed); border-color: var(--status-failed); }
.runbook-fleet-status.is-aborted { color: var(--accent-yellow-warm); border-color: var(--accent-yellow-warm); }
.runbook-fleet-body { padding: 0 10px 8px; display: flex; flex-direction: column; gap: 6px; }
.runbook-fleet-hint { font-size: 10px; line-height: 1.5; color: var(--text-dim); }
.runbook-fleet-group { display: flex; flex-direction: column; gap: 2px; }
.runbook-fleet-group-title {
  font-size: 10px; color: var(--text-muted); margin-bottom: 2px;
}
.runbook-fleet-target {
  display: flex; align-items: center; gap: 6px; cursor: pointer; min-width: 0;
  padding: 1px 2px; border-radius: 4px;
}
.runbook-fleet-target:hover { background: var(--bg-hover); }
.runbook-fleet-target-name {
  flex: 1; min-width: 0;
  font-size: 11px; color: var(--text-body);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.runbook-fleet-actions { display: flex; align-items: center; justify-content: flex-end; gap: 6px; }
.runbook-fleet-timeout { width: 150px; flex-shrink: 0; }
.runbook-fleet-runbar {
  display: flex; align-items: center; justify-content: space-between; gap: 6px; min-height: 22px;
}
.runbook-fleet-step {
  flex: 1; min-width: 0;
  font-size: 10px; color: var(--text-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.runbook-fleet-notice {
  font-size: 10px; line-height: 1.5; color: var(--accent-yellow-warm);
  padding: 4px 6px; border: 1px solid var(--accent-yellow-warm); border-radius: 6px;
  background: color-mix(in srgb, var(--accent-yellow-warm) 8%, transparent);
}
.runbook-fleet-matrix { overflow-x: auto; }
.runbook-fleet-matrix table { border-collapse: collapse; width: 100%; }
.runbook-fleet-matrix th, .runbook-fleet-matrix td {
  border: 1px solid var(--border-subtle); padding: 2px 4px; font-size: 10px;
}
.runbook-fleet-step-col {
  max-width: 120px; min-width: 90px;
  text-align: left; color: var(--text-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.runbook-fleet-target-col {
  max-width: 76px; text-align: center; font-weight: 600; color: var(--text-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.runbook-fleet-cell {
  text-align: center; cursor: pointer; min-width: 30px; position: relative;
  color: var(--text-dim);
}
.runbook-fleet-cell:hover { background: var(--bg-hover); }
.runbook-fleet-cell.is-pending { color: var(--text-dim); }
.runbook-fleet-cell.is-done { color: var(--status-success); }
.runbook-fleet-cell.is-failed {
  color: var(--status-failed); font-weight: 700;
  background: color-mix(in srgb, var(--status-failed) 10%, transparent);
}
.runbook-fleet-cell.is-skipped { color: var(--text-dim); background: var(--bg-hover); }
.runbook-fleet-cell.is-aborted { color: var(--accent-yellow-warm); }
.runbook-fleet-cell-mark { pointer-events: none; }
.runbook-fleet-retry {
  position: absolute; top: 50%; right: 1px; transform: translateY(-50%);
  border: none; background: none; cursor: pointer; padding: 0 2px;
  font-size: 10px; color: var(--status-failed);
}
.runbook-fleet-retry:hover { color: var(--accent-red); }
.runbook-fleet-output { border: 1px solid var(--border-default); border-radius: 6px; background: var(--bg-elevated); }
.runbook-fleet-output-loading, .runbook-fleet-output-error {
  padding: 8px; font-size: 10px; color: var(--text-muted);
}
.runbook-fleet-output-error { color: var(--status-failed); }
.runbook-fleet-output-pre {
  margin: 0; padding: 6px 8px; max-height: 180px; overflow: auto;
  font-family: var(--font-mono, monospace); font-size: 10px; line-height: 1.5;
  color: var(--text-body); white-space: pre-wrap; word-break: break-all;
}
</style>
