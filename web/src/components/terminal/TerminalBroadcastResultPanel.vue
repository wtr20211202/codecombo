<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { NButton, NIcon, NModal } from 'naive-ui'
import { RefreshOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { terminalApi } from '../../api/domains/terminal'
import type { BroadcastResultTarget } from '../../composables/useTerminalBroadcast'

/**
 * 广播结果聚合面板（P-20261005-12）：发 N 台看 N 台——一次广播的瞬态结果
 * 视图，按目标网格并排展示各自尾部输出，舰队巡检「一次下发→一屏对比」。
 *
 * - 数据源 = useTerminalBroadcast 的 resultTargets（发送回告透传失败态）；
 *   本组件只负责尾输出拉取与呈现，纯 UI 聚合层
 * - 拉取 = GET /terminals/:id/scrollback 既有端点（octet-stream 原始 PTY
 *   字节流），前端剥 ANSI + 取尾 TAIL_LINES 行（行数护栏：8 台 ×50 行远在
 *   渲染量级内；服务端返回全量缓冲，切尾在本组件做，不给端点加参数面）
 * - 失败/missing 目标灰态标注（回告信息透传），不发起拉取
 * - 「全部刷新」重拉（长命令二次回看）；面板重开同样重拉
 * - 弹层尺寸自适：auto-fill 网格 + 弹层体 max-height 滚动——目标数护栏
 *   （>12 目标）走滚动不分页（广播上限 = 单进程会话上限 50，网格滚动足够）
 * - 与 P-20261005-11（远程广播，在队）的衔接：本面板按会话 id 寻址，
 *   scrollback 端点对远程代理同构（remotehost_terminal.go 同路径），远程
 *   目标落地后 resultTargets 增加远程成员即可直接适用，组件零改动
 */
const props = defineProps<{
  show: boolean
  /** 目标视图（含 missing/failed 灰态；ok 项才拉尾输出） */
  targets: BroadcastResultTarget[]
}>()

const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
}>()

const { t } = useI18n()

/** 尾输出行数护栏（提案④）：每目标只留尾 50 行，一屏对比而非全量回放 */
const TAIL_LINES = 50
/** 广播后延时拉取：给命令留执行时间（提案①：1~2s 取中） */
const FETCH_DELAY_MS = 1500

/** ANSI 剥离：scrollback 是原始 PTY 字节流，颜色/光标控制码在纯文本 pre
 *  里是乱码方块。标准 ansi-regex 模式（InstanceSessionOutput 同款惯例） */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g

type CellState = 'idle' | 'loading' | 'ready' | 'error'
/** 每目标单元格状态：missing/failed 不入表（模板直接灰态渲染） */
const cells = ref(new Map<string, { state: CellState; text: string }>())

const okTargets = computed(() => props.targets.filter(x => x.state === 'ok'))
/** 有内容可看才算「可刷新」（全 missing/failed 时刷新无意义） */
const hasFetchable = computed(() => okTargets.value.length > 0)
const anyLoading = computed(() => {
  for (const c of cells.value.values()) if (c.state === 'loading') return true
  return false
})

/** 代际守卫：关面板/重开/切目标集后，旧一轮在途拉取的结果全部丢弃 */
let fetchGen = 0
let delayTimer: ReturnType<typeof setTimeout> | null = null

function cellOf(id: string): { state: CellState; text: string } {
  let c = cells.value.get(id)
  if (!c) {
    c = { state: 'idle', text: '' }
    cells.value.set(id, c)
  }
  return c
}

/** 尾 N 行切片：按 \n 分行取尾（终端行序即输出时序；尾部空行折叠为一条） */
function tailLines(text: string): string {
  const lines = text.replace(/\n+$/, '').split('\n')
  return lines.slice(-TAIL_LINES).join('\n')
}

async function fetchTarget(id: string, gen: number): Promise<void> {
  cellOf(id).state = 'loading'
  try {
    // silent：拉取失败在单元格灰态就地呈现（会话刚消失的 404 是预期形态），
    // 不叠全局 toast——N 台并拉时失败 toast 会成串
    const buf = (await terminalApi.scrollback(id, { silent: true })) as unknown as ArrayBuffer
    if (gen !== fetchGen) return // 代际过期：丢弃（面板已关/新一轮已启动）
    const text = tailLines(new TextDecoder('utf-8', { fatal: false }).decode(buf).replace(ANSI_RE, ''))
    const c = cellOf(id)
    c.state = 'ready'
    c.text = text
  } catch {
    if (gen !== fetchGen) return
    cellOf(id).state = 'error'
  }
}

/** 立即全量重拉（「全部刷新」钮 / 面板延时到期后的首轮） */
function refreshAll(): void {
  if (!hasFetchable.value) return
  fetchGen += 1
  const gen = fetchGen
  for (const x of okTargets.value) void fetchTarget(x.id, gen)
}

/** 面板打开：先延时再拉（给广播命令留执行时间）；关闭即取消挂起轮次 */
function scheduleOnOpen(): void {
  cancelPending()
  cells.value = new Map()
  if (!hasFetchable.value) return
  delayTimer = setTimeout(refreshAll, FETCH_DELAY_MS)
}

function cancelPending(): void {
  fetchGen += 1 // 在途响应全体过期
  if (delayTimer) {
    clearTimeout(delayTimer)
    delayTimer = null
  }
}

// 触发面 = show 翻转 + 目标集换代（id×state 签名）：首开/重开重拉（重开 =
// 最新尾部输出）；同一面板开着时再次广播（lastResult 换代）也重拉——新目标
// 单元格不能停在无人拉取的「抓取中」。签名不含名称：开着期间的会话列表
// 对账只漂移名称解析，不打断查看（cells 不重置）
watch(
  () => [props.show, props.targets.map(x => `${x.state}:${x.id}`).join(',')] as const,
  ([show, sig], prev) => {
    const prevShow = prev?.[0] ?? false
    const prevSig = prev?.[1] ?? ''
    if (!show) {
      cancelPending()
      return
    }
    if (!prevShow || sig !== prevSig) scheduleOnOpen()
  },
)
onBeforeUnmount(cancelPending)

const cellStateLabel = (state: CellState): string =>
  state === 'error' ? t('terminal.broadcastResult.stateError')
  : state === 'ready' ? t('terminal.broadcastResult.stateOk')
  : t('terminal.broadcastResult.stateLoading')
</script>

<template>
  <!-- 宽度特例白名单（P-20261003-295）：广播结果多列汇总需 1180px 超宽，不并入 --modal-w-xl(960px) -->
  <n-modal
    :show="props.show"
    preset="card"
    style="width: min(1180px, 94vw)"
    :title="t('terminal.broadcastResult.title')"
    :bordered="false"
    data-testid="terminal-broadcast-result-panel"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <div class="tbr-toolbar">
      <span class="tbr-hint">{{ t('terminal.broadcastResult.hint', { count: props.targets.length, lines: TAIL_LINES }) }}</span>
      <n-button
        size="tiny"
        quaternary
        :disabled="!hasFetchable"
        :loading="anyLoading"
        data-testid="terminal-broadcast-result-refresh"
        @click="refreshAll"
      >
        <template #icon>
          <n-icon size="12">
            <RefreshOutline />
          </n-icon>
        </template>
        {{ t('terminal.broadcastResult.refresh') }}
      </n-button>
    </div>

    <!-- 目标网格：auto-fill 自适弹层宽度；>12 目标靠弹层体滚动（护栏见头注） -->
    <div
      class="tbr-grid"
      data-testid="terminal-broadcast-result-grid"
    >
      <div
        v-for="x in props.targets"
        :key="x.id"
        class="tbr-cell"
        :class="{ 'is-gray': x.state !== 'ok' }"
        data-testid="terminal-broadcast-result-cell"
      >
        <div class="tbr-cell-head">
          <span
            class="tbr-cell-name"
            :title="x.id"
          >{{ x.name }}</span>
          <span
            v-if="x.state === 'missing'"
            class="tbr-cell-state is-missing"
          >{{ t('terminal.broadcastResult.stateMissing') }}</span>
          <span
            v-else-if="x.state === 'failed'"
            class="tbr-cell-state is-failed"
          >{{ t('terminal.broadcastResult.stateFailed') }}</span>
          <span
            v-else
            class="tbr-cell-state"
            :class="{ 'is-loading': cellOf(x.id).state === 'loading', 'is-error': cellOf(x.id).state === 'error' }"
          >{{ cellStateLabel(cellOf(x.id).state) }}</span>
        </div>
        <pre
          v-if="x.state === 'ok' && cellOf(x.id).state === 'ready' && cellOf(x.id).text"
          class="tbr-cell-pre"
        >{{ cellOf(x.id).text }}</pre>
        <div
          v-else-if="x.state === 'ok' && cellOf(x.id).state === 'ready'"
          class="tbr-cell-empty"
        >
          {{ t('terminal.broadcastResult.emptyTail') }}
        </div>
        <div
          v-else-if="x.state === 'ok' && cellOf(x.id).state === 'error'"
          class="tbr-cell-empty"
        >
          {{ t('terminal.broadcastResult.stateError') }}
        </div>
        <div
          v-else-if="x.state === 'ok'"
          class="tbr-cell-empty"
        >
          {{ t('terminal.broadcastResult.stateLoading') }}
        </div>
        <div
          v-else
          class="tbr-cell-empty"
        >
          {{ x.state === 'missing' ? t('terminal.broadcastResult.missingTip') : t('terminal.broadcastResult.failedTip') }}
        </div>
      </div>
    </div>
  </n-modal>
</template>

<style scoped>
.tbr-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.tbr-hint {
  flex: 1;
  font-size: 12px;
  color: var(--text-tertiary);
}

.tbr-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(270px, 1fr));
  gap: 10px;
  max-height: 64vh;
  overflow-y: auto;
}

.tbr-cell {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border: 1px solid var(--border-default);
  border-radius: 6px;
  background: var(--bg-canvas);
  overflow: hidden;
}

.tbr-cell.is-gray {
  opacity: 0.55;
  background: transparent;
}

.tbr-cell-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-bottom: 1px solid var(--border-default);
  background: var(--bg-panel);
  min-width: 0;
}

.tbr-cell-name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tbr-cell-state {
  flex: none;
  font-size: 11px;
  color: var(--text-secondary);
}

.tbr-cell-state.is-loading {
  color: var(--accent-yellow);
}

.tbr-cell-state.is-error {
  color: var(--accent-red);
}

.tbr-cell-state.is-missing,
.tbr-cell-state.is-failed {
  color: var(--text-tertiary);
}

.tbr-cell-pre {
  margin: 0;
  padding: 8px 10px;
  height: 180px;
  overflow-y: auto;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-body);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.tbr-cell-empty {
  padding: 16px 10px;
  height: 180px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--text-tertiary);
  text-align: center;
}
</style>
