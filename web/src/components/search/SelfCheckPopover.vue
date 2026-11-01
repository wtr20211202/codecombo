<script setup lang="ts">
// 本机环境体检浮层（P-20261003-317）：命令面板「环境体检」入口呼出。
// - 服务端 GET /api/selfcheck：聚合既有环境信号为只读体检单（git/lfs 工具链、
//   tmux 可用性、agent 运行时、已登记端口、应用版本、数据盘水位），条目
//   {item, status, detail, hint}——item 是稳定键（i18n 标题映射 + e2e 锚点）
// - 三态语义色：ok=绿 / warn=黄 / fail=红（主题变量，四主题同步）
// - 「复制为 Markdown」一键贴 issue：标题行 + 逐条目「状态 标题 — 明细 +
//   hint」，detail/hint 为服务端语言中立原文（Agent/维护者可读）
// - 诚实边界（注记行）：体检只读无副作用；登记面/探测面口径以服务端注记为准
// - 趋势条（P-20261005-169）：响应内联 hist（selfcheckhist 环形 20 条）——
//   头部「与上次」涨跌箭头 + 差值（远程诊断 compare 条同款形态，零新图表
//   组件），首次体检无历史时隐藏；每次体检/每日定时各落一条快照
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NIcon, NSpin, useMessage } from 'naive-ui'
import { CloseOutline, CheckmarkCircleOutline, AlertCircleOutline, RefreshOutline, CopyOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { hasBlockingOverlay } from '../../utils/overlayGuard'
import { copyText } from '../../utils/clipboard'
import { formatDeltaMB, formatDeltaCount, formatMB } from '../../utils/diagFormat'
import { selfCheckApi, type SelfCheckHist, type SelfCheckItem, type SelfCheckStatus } from '../../api/domains/system'

const props = defineProps<{
  show: boolean
}>()

const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
}>()

const { t } = useI18n()
const message = useMessage()

const items = ref<SelfCheckItem[]>([])
const loading = ref(false)
const loaded = ref(false)
const hist = ref<SelfCheckHist | undefined>()

/** 打开即体检一次；「重新体检」重跑（探测面有服务端缓存，代价有界） */
async function fetchReport() {
  loading.value = true
  try {
    const res = await selfCheckApi.get()
    items.value = res.data || []
    hist.value = res.hist
    loaded.value = true
  } catch { /* silent：已知错误由拦截器统一提示 */ }
  finally { loading.value = false }
}

watch(() => props.show, (show) => {
  if (!show) return
  void fetchReport()
})

function close() {
  emit('update:show', false)
}

// 三态汇总（头部一句话 + Markdown 标题行）；未加载完不出现在复制产物里
const counts = computed(() => {
  const c = { ok: 0, warn: 0, fail: 0 }
  for (const it of items.value) c[it.status] = (c[it.status] || 0) + 1
  return c
})

/** 条目本地化标题：未知 item 键原样展示不崩（新旧版本协商下的兜底） */
function itemTitle(item: string): string {
  const key = `selfcheck.items.${item}`
  const label = t(key)
  return label === key ? item : label
}

function statusText(status: SelfCheckStatus): string {
  return t(`selfcheck.status.${status}`)
}

// ============== 「与上次」趋势条（P-20261005-169） ==============

interface TrendChip {
  key: string
  label: string
  arrow: string
  cls: string
  deltaText: string
  title: string
}

/** goodWhenUp：该指标上涨是否为好事（磁盘可用↑=好；内存用量↑/会话/终端数↑=
 * 坏——增长即负载/占用抬头）。颜色语义按好坏而非方向，与诊断弹窗对比条同款 */
function buildTrendChip(key: string, label: string, delta: number, deltaText: string, prevText: string, goodWhenUp: boolean): TrendChip {
  const cls = delta === 0 ? 'is-flat' : ((delta > 0) === goodWhenUp ? 'is-good' : 'is-bad')
  const arrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '→'
  return { key, label, arrow, cls, deltaText, title: `${label}: ${prevText} → ${deltaText}` }
}

/** 趋势 chips：prev 未采集（零值哨兵）的指标隐藏（terminals 恒真实恒出），
 * 差值 0 显示持平；prev 缺省（首次体检无历史）整条隐藏 */
const trendChips = computed<TrendChip[]>(() => {
  const h = hist.value
  if (!h?.prev || !h.delta) return []
  const out: TrendChip[] = []
  if ((h.prev.diskAvailMB || 0) > 0) {
    out.push(buildTrendChip('disk', t('selfcheck.trend.diskAvail'), h.delta.diskAvailMB,
      formatDeltaMB(h.delta.diskAvailMB), formatMB(h.prev.diskAvailMB || 0), true))
  }
  if ((h.prev.memUsedMB || 0) > 0) {
    out.push(buildTrendChip('mem', t('selfcheck.trend.memUsed'), h.delta.memUsedMB,
      formatDeltaMB(h.delta.memUsedMB), formatMB(h.prev.memUsedMB || 0), false))
  }
  if ((h.prev.activeSessions || 0) > 0) {
    out.push(buildTrendChip('sessions', t('selfcheck.trend.activeSessions'), h.delta.activeSessions,
      formatDeltaCount(h.delta.activeSessions), String(h.prev.activeSessions || 0), false))
  }
  out.push(buildTrendChip('terminals', t('selfcheck.trend.terminals'), h.delta.terminals,
    formatDeltaCount(h.delta.terminals), String(h.prev.terminals || 0), false))
  return out
})

const trendTime = computed(() => {
  const time = hist.value?.prev?.time
  return time ? new Date(time).toLocaleString() : ''
})

/** Markdown 产物：issue 直贴形态——标题 + 三态汇总 + 逐条目小节 */
function buildMarkdown(): string {
  const lines: string[] = []
  lines.push(`## ${t('selfcheck.title')}`)
  lines.push('')
  lines.push(t('selfcheck.summary', counts.value))
  lines.push('')
  for (const it of items.value) {
    lines.push(`- **${statusText(it.status)}** ${itemTitle(it.item)} — ${it.detail}`)
    if (it.hint) lines.push(`  - ${t('selfcheck.hintLabel')}: ${it.hint}`)
  }
  return lines.join('\n')
}

async function copyMarkdown() {
  const ok = await copyText(buildMarkdown())
  if (ok) message.success(t('selfcheck.copied'))
  else message.error(t('common.copyFailed'))
}

const statusIcon = (status: SelfCheckStatus) =>
  status === 'ok' ? CheckmarkCircleOutline : AlertCircleOutline

// Esc 关闭（TerminalPortsPopover 同惯例）：布局级已消费的 Esc（如退出最大化）
// 不重复处理
function onWindowKeydown(e: KeyboardEvent) {
  if (!props.show || e.key !== 'Escape') return
  if (e.defaultPrevented) return
  if (hasBlockingOverlay()) return
  e.preventDefault()
  close()
}
onMounted(() => window.addEventListener('keydown', onWindowKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onWindowKeydown))
</script>

<template>
  <transition name="sck-fade">
    <div
      v-if="props.show"
      class="sck-mask"
      @click.self="close"
    >
      <div
        class="sck-card glass-panel"
        data-testid="self-check"
      >
        <div class="sck-header">
          <n-icon
            size="13"
            class="sck-icon"
          >
            <CheckmarkCircleOutline />
          </n-icon>
          <span class="sck-title">{{ t('selfcheck.title') }}</span>
          <span
            v-if="loaded"
            class="sck-summary"
            data-testid="self-check-summary"
          >{{ t('selfcheck.summary', counts) }}</span>
          <button
            class="sck-btn"
            :title="t('selfcheck.refresh')"
            data-testid="self-check-refresh"
            @click="fetchReport"
          >
            <n-icon size="12">
              <RefreshOutline />
            </n-icon>
          </button>
          <button
            class="sck-btn"
            :title="t('selfcheck.copyMarkdown')"
            data-testid="self-check-copy"
            :disabled="!loaded"
            @click="copyMarkdown"
          >
            <n-icon size="12">
              <CopyOutline />
            </n-icon>
          </button>
          <button
            class="sck-btn"
            :title="t('commandPalette.close')"
            @click="close"
          >
            <n-icon size="12">
              <CloseOutline />
            </n-icon>
          </button>
        </div>
        <div
          v-if="trendChips.length"
          class="sck-trend"
          data-testid="self-check-trend"
        >
          <span class="sck-trend-label">{{ t('selfcheck.trend.compareWith', { time: trendTime }) }}</span>
          <span
            v-for="chip in trendChips"
            :key="chip.key"
            class="sck-trend-chip"
            :data-testid="`self-check-trend-${chip.key}`"
            :title="chip.title"
          >
            <span class="sck-trend-metric">{{ chip.label }}</span>
            <span
              class="sck-trend-arrow"
              :class="chip.cls"
            >{{ chip.arrow }}</span>
            <span class="sck-trend-delta">{{ chip.deltaText }}</span>
          </span>
          <span class="sck-trend-runs">{{ t('selfcheck.trend.runs', { n: hist?.runs ?? 0 }) }}</span>
        </div>
        <n-spin
          :show="loading"
          size="small"
          class="spin-fill"
        >
          <div class="sck-list">
            <div
              v-for="it in items"
              :key="it.item"
              class="sck-item"
              :class="`is-${it.status}`"
              :data-testid="`self-check-row-${it.item}`"
            >
              <div class="sck-item-head">
                <n-icon
                  size="12"
                  class="sck-status-icon"
                >
                  <component :is="statusIcon(it.status)" />
                </n-icon>
                <span class="sck-item-title">{{ itemTitle(it.item) }}</span>
                <span
                  class="sck-status"
                  :class="`is-${it.status}`"
                >{{ statusText(it.status) }}</span>
              </div>
              <div class="sck-detail">
                {{ it.detail }}
              </div>
              <div
                v-if="it.hint"
                class="sck-hint"
              >
                <span class="sck-hint-label">{{ t('selfcheck.hintLabel') }}</span>{{ it.hint }}
              </div>
            </div>
          </div>
        </n-spin>
        <div class="sck-footnote">
          {{ t('selfcheck.footnote') }}
        </div>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.sck-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
}
.sck-card {
  position: absolute;
  top: 80px;
  right: 16px;
  width: 520px;
  max-height: 70vh;
  background: var(--bg-surface);
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  box-shadow: var(--shadow-strong);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.sck-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-default);
  background: linear-gradient(to bottom, var(--bg-elevated), var(--bg-surface));
}
.sck-icon { color: var(--accent-green); }
.sck-title { font-size: 12px; font-weight: 600; color: var(--text-primary); }
/* 右推锚点随加载态切换：汇总行未出（体检中）由首个按钮推右，出后由汇总行推右 */
.sck-summary { font-size: 10px; color: var(--text-muted); margin-left: auto; }
.sck-title + .sck-btn { margin-left: auto; }
.sck-btn {
  margin-left: 4px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.sck-btn:hover { color: var(--text-primary); background: var(--bg-hover); }
.sck-btn:disabled { opacity: 0.4; cursor: default; }
/* 「与上次」趋势条（诊断弹窗 diag-compare 同款形态）：涨跌箭头按好坏着色 */
.sck-trend {
  display: flex; align-items: center; flex-wrap: wrap; gap: 4px 14px;
  padding: 6px 12px; border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-canvas);
  font-size: 11px; flex-shrink: 0;
}
.sck-trend-label { color: var(--text-secondary); }
.sck-trend-chip { display: inline-flex; align-items: center; gap: 4px; }
.sck-trend-metric { color: var(--text-secondary); }
.sck-trend-arrow.is-good { color: var(--accent-green); font-weight: 600; }
.sck-trend-arrow.is-bad { color: var(--accent-yellow-warm); font-weight: 600; }
.sck-trend-arrow.is-flat { color: var(--text-muted); }
.sck-trend-delta { color: var(--text-primary); font-family: var(--font-mono); }
.sck-trend-runs { margin-left: auto; color: var(--text-dim); font-size: 10px; white-space: nowrap; }
.sck-list { flex: 1; overflow-y: auto; padding: 4px 0; }
.sck-item {
  padding: 7px 12px;
  border-left: 2px solid transparent;
}
.sck-item.is-ok { border-left-color: var(--accent-green); }
.sck-item.is-warn { border-left-color: var(--accent-yellow-warm); }
.sck-item.is-fail { border-left-color: var(--accent-red); }
.sck-item:hover { background: var(--bg-hover); }
.sck-item-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.sck-status-icon.is-ok { color: var(--accent-green); }
.sck-status-icon.is-warn { color: var(--accent-yellow-warm); }
.sck-status-icon.is-fail { color: var(--accent-red); }
.sck-item-title { font-size: 12px; font-weight: 600; color: var(--text-primary); }
.sck-status {
  margin-left: auto;
  font-size: 10px;
  border-radius: 6px;
  padding: 0 6px;
  border: 1px solid var(--border-subtle);
  white-space: nowrap;
}
.sck-status.is-ok { color: var(--accent-green); }
.sck-status.is-warn { color: var(--accent-yellow-warm); }
.sck-status.is-fail { color: var(--accent-red); }
.sck-detail {
  margin: 3px 0 0 18px;
  font-size: 11px;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  word-break: break-all;
  white-space: pre-wrap;
}
.sck-hint {
  margin: 3px 0 0 18px;
  font-size: 11px;
  color: var(--text-dim);
  word-break: break-all;
}
.sck-hint-label {
  color: var(--accent-yellow-warm);
  margin-right: 4px;
}
.sck-footnote {
  padding: 5px 10px;
  font-size: 10px;
  color: var(--text-dim);
  border-top: 1px solid var(--border-subtle);
  flex-shrink: 0;
}
.sck-fade-enter-active,
.sck-fade-leave-active { transition: opacity var(--motion-base); }
.sck-fade-enter-active .sck-card,
.sck-fade-leave-active .sck-card { transition: transform var(--motion-base), opacity var(--motion-base); }
.sck-fade-enter-from,
.sck-fade-leave-to { opacity: 0; }
.sck-fade-enter-from .sck-card,
.sck-fade-leave-to .sck-card { transform: translateY(-8px) scale(0.98); opacity: 0; }
</style>
