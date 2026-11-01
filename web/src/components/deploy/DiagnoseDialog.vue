<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import {
  NButton, NIcon, NModal, NSpin, NTag, useMessage,
} from 'naive-ui'
import { PulseOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { useDiagHist } from '../../composables/useDiagHist'
import { diagnoseApi, type DiagnoseResult, type DiagCompare } from '../../api/client'
import { friendlyRemoteError } from '../../utils/remoteErrors'
import { formatMB, formatDeltaMB, formatDeltaLoad } from '../../utils/diagFormat'

/**
 * 远程主机一键诊断：SSH 跑一组只读命令聚合状态快照（纯运维能力）。
 * AI 解读已移除——用户可在终端用环境内的 claude/dsh 自行分析快照输出。
 * 报告头部内联「与上次对比」条（服务端随响应下发，P-20261002-18）：
 * 磁盘可用/内存用量/负载三指标涨跌箭头 + 差值，首次诊断（无历史）隐藏。
 */
const props = defineProps<{
  show: boolean
  hostId: string
  hostName: string
}>()
const emit = defineEmits<{
  (e: 'update:show', val: boolean): void
}>()

const { t } = useI18n()
const message = useMessage()
const { refresh: refreshDiagHist } = useDiagHist()

const running = ref(false)
const result = ref<DiagnoseResult | null>(null)

async function run() {
  if (!props.hostId) return
  running.value = true
  result.value = null
  try {
    const res: any = await diagnoseApi.run(props.hostId)
    result.value = res
    if (res?.error) {
      // 底层 SSH 报错映射为可行动提示，不直出英文原文
      message.error(`${t('remoteOps.diagnose.failed')}: ${friendlyRemoteError(res.error, t)}`)
    } else {
      // 本次快照已服务端落盘：刷新侧栏「最近诊断时间/趋势」
      void refreshDiagHist()
    }
  } catch { /* 拦截器处理 */ } finally {
    running.value = false
  }
}

// ============== 与上次对比条 ==============

interface CompareChip {
  key: string
  label: string
  arrow: string
  cls: string
  deltaText: string
  title: string
}

/** goodWhenUp：该指标上涨是否为好事（磁盘可用↑=好；内存用量↑/负载↑=坏）。
 * 颜色语义按好坏而非方向——同一箭头在不同指标上含义不同 */
function buildChip(key: string, label: string, delta: number, deltaText: string, prevText: string, goodWhenUp: boolean): CompareChip {
  const cls = delta === 0 ? 'is-flat' : ((delta > 0) === goodWhenUp ? 'is-good' : 'is-bad')
  const arrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '→'
  return { key, label, arrow, cls, deltaText, title: `${label}: ${prevText} → ${deltaText}` }
}

/** 三指标对比 chips：prev 未采集（零值哨兵）的指标隐藏，差值 0 显示持平 */
const compareChips = computed<CompareChip[]>(() => {
  const cmp: DiagCompare | undefined = result.value?.compare
  if (!cmp?.prev || !cmp.delta) return []
  const out: CompareChip[] = []
  if ((cmp.prev.diskAvailMB || 0) > 0) {
    out.push(buildChip('disk', t('diag.hist.diskAvail'), cmp.delta.diskAvailMB,
      formatDeltaMB(cmp.delta.diskAvailMB), formatMB(cmp.prev.diskAvailMB || 0), true))
  }
  if ((cmp.prev.memUsedMB || 0) > 0) {
    out.push(buildChip('mem', t('diag.hist.memUsed'), cmp.delta.memUsedMB,
      formatDeltaMB(cmp.delta.memUsedMB), formatMB(cmp.prev.memUsedMB || 0), false))
  }
  if ((cmp.prev.load1 || 0) > 0) {
    out.push(buildChip('load', t('diag.hist.load1'), cmp.delta.load1,
      formatDeltaLoad(cmp.delta.load1), (cmp.prev.load1 || 0).toFixed(2), false))
  }
  return out
})

const compareTime = computed(() => {
  const time = result.value?.compare?.prev?.time
  return time ? new Date(time).toLocaleString() : ''
})

watch(() => props.show, (v) => {
  if (v) {
    // 每次打开重新跑一次诊断，保证数据新鲜
    void run()
  }
})
</script>

<template>
  <n-modal
    :show="props.show"
    :mask-closable="false"
    class="diag-modal"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <div class="diag-card">
      <div class="diag-header">
        <div class="diag-title">
          <n-icon size="16">
            <PulseOutline />
          </n-icon>
          <span>{{ t('remoteOps.diagnose.title') }} — {{ props.hostName }}</span>
        </div>
        <button
          class="diag-close"
          @click="emit('update:show', false)"
        >
          &times;
        </button>
      </div>

      <div class="diag-body">
        <div
          v-if="running"
          class="diag-loading"
        >
          <n-spin size="medium" />
          <div class="diag-loading-text">
            {{ t('remoteOps.diagnose.running') }}
          </div>
        </div>

        <template v-else-if="result">
          <div
            v-if="result.error"
            class="diag-error"
          >
            {{ result.error }}
          </div>
          <template v-else>
            <div class="diag-meta">
              <n-tag
                size="small"
                :type="result.ok ? 'success' : 'warning'"
              >
                {{ result.ok ? t('remoteOps.diagnose.ok') : t('remoteOps.diagnose.partial') }}
              </n-tag>
              <span class="diag-duration">{{ result.durationMs }}ms</span>
              <n-button
                size="tiny"
                @click="run"
              >
                {{ t('remoteOps.diagnose.rerun') }}
              </n-button>
            </div>
            <div
              v-if="compareChips.length"
              class="diag-compare"
              data-testid="diag-compare"
            >
              <span class="diag-compare-label">{{ t('diag.hist.compareWith', { time: compareTime }) }}</span>
              <span
                v-for="chip in compareChips"
                :key="chip.key"
                class="diag-compare-chip"
                :title="chip.title"
              >
                <span class="diag-compare-metric">{{ chip.label }}</span>
                <span
                  class="diag-compare-arrow"
                  :class="chip.cls"
                >{{ chip.arrow }}</span>
                <span class="diag-compare-delta">{{ chip.deltaText }}</span>
              </span>
            </div>
            <div class="diag-items">
              <div
                v-for="item in result.items"
                :key="item.key"
                class="diag-item"
              >
                <div class="diag-item-label">
                  {{ item.label }}
                </div>
                <pre class="diag-item-output">{{ item.output || item.error || '—' }}</pre>
              </div>
            </div>
          </template>
        </template>

        <div
          v-else
          class="diag-loading"
          style="padding: 24px"
        >
          <div class="diag-loading-text">
            {{ t('remoteOps.diagnose.empty') }}
          </div>
        </div>
      </div>
    </div>
  </n-modal>
</template>

<style scoped>
.diag-card {
  width: 720px; max-width: 92vw; max-height: 84vh;
  background: var(--bg-panel); border: 1px solid var(--border-default);
  border-radius: 12px; box-shadow: var(--shadow-strong);
  display: flex; flex-direction: column; overflow: hidden;
}
.diag-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 18px; border-bottom: 1px solid var(--border-default);
}
.diag-title { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; color: var(--text-primary); }
.diag-close {
  background: none; border: none; color: var(--text-muted);
  font-size: 22px; cursor: pointer; padding: 0 4px; line-height: 1; border-radius: 4px;
}
.diag-close:hover { color: var(--text-primary); background: var(--bg-hover); }
.diag-body { flex: 1; overflow-y: auto; padding: 16px 18px; }
.diag-loading { padding: 48px; text-align: center; }
.diag-loading-text { margin-top: 10px; font-size: 12px; color: var(--text-secondary); }
.diag-error {
  padding: 10px 12px; border-radius: 6px;
  background: var(--bg-canvas); border: 1px solid var(--border-default);
  color: var(--accent-red, #f44747); font-size: 13px; word-break: break-all;
}
.diag-meta { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.diag-duration { font-size: 12px; color: var(--text-secondary); font-family: var(--font-mono); }
.diag-compare {
  display: flex; align-items: center; flex-wrap: wrap; gap: 6px 14px;
  padding: 7px 10px; margin-bottom: 12px;
  background: var(--bg-canvas); border: 1px solid var(--border-subtle); border-radius: 6px;
  font-size: 12px;
}
.diag-compare-label { color: var(--text-secondary); }
.diag-compare-chip { display: inline-flex; align-items: center; gap: 4px; }
.diag-compare-metric { color: var(--text-secondary); }
.diag-compare-arrow.is-good { color: var(--accent-green, #6ea76e); font-weight: 600; }
.diag-compare-arrow.is-bad { color: var(--accent-yellow, #d7a65f); font-weight: 600; }
.diag-compare-arrow.is-flat { color: var(--text-muted); }
.diag-compare-delta { color: var(--text-primary); font-family: var(--font-mono); }
.diag-items { display: flex; flex-direction: column; gap: 10px; }
.diag-item {
  border: 1px solid var(--border-subtle); border-radius: 6px; overflow: hidden;
}
.diag-item-label {
  padding: 5px 10px; font-size: 11px; font-weight: 500; color: var(--text-secondary);
  background: var(--bg-canvas); border-bottom: 1px solid var(--border-subtle);
}
.diag-item-output {
  margin: 0; padding: 8px 10px; font-family: var(--font-mono); font-size: 12px;
  color: var(--text-primary); white-space: pre-wrap; word-break: break-all;
  max-height: 220px; overflow-y: auto;
}
</style>
