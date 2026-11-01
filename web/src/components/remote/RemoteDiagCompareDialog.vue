<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { NButton, NCheckbox, NCheckboxGroup, NIcon, NModal, NSpin, NTooltip, useMessage } from 'naive-ui'
import { StatsChartOutline, CopyOutline, GitCompareOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { useRemoteHostStore } from '../../stores/remoteHost'
import { diagnoseBatchApi, type DiagBatchResult } from '../../api/client'
import { copyText } from '../../utils/clipboard'
import {
  buildDiagCompareMarkdown, DIAG_METRICS, formatMetricValue, pickOutlierCells,
  sortDiagRows, type DiagCompareRow,
} from '../../utils/diagCompare'

/**
 * 多主机巡检对比（P-20261004-58）：勾选 N 台 SSH 主机一键批量诊断，
 * 横向对比表（每行一主机 × 指标列）一屏找离群值——谁的磁盘将满、哪台负载异常。
 * 数据面 = POST /remotehosts/diagnose-batch（服务端并行扇出 + 并发限流，
 * 逐台结构化降级）；离群高亮与报告 markdown 由 utils/diagCompare 纯函数产出。
 * 全局弹窗挂 App 层（remoteOps store 同族，DiagnoseDialog 同款挂法）。
 */
const props = defineProps<{
  show: boolean
}>()
const emit = defineEmits<{
  (e: 'update:show', val: boolean): void
}>()

const { t } = useI18n()
const message = useMessage()
const hostStore = useRemoteHostStore()

// axios interceptor 已展平 AxiosResponse，运行时返回 server body 本身（remoteHost store 同款）
type Resp<T> = { data?: T }

const running = ref(false)
const topError = ref('')
const results = ref<DiagBatchResult[] | null>(null)
const totalMs = ref(0)
const selectedIds = ref<string[]>([])

/** SSH 主机才可巡检（FTP 仅文件管理，服务端也会逐台拒绝） */
const sshHosts = computed(() => hostStore.hosts.filter(h => h.protocol !== 'ftp'))

/** 打开即刷新主机清单并全选（巡检是全机队动作，逐个反选比逐个勾选快） */
watch(() => props.show, async (v) => {
  if (!v) return
  results.value = null
  topError.value = ''
  try {
    if (hostStore.hosts.length === 0) await hostStore.fetch()
  } catch { /* 锁定态等：清单拉不到则列表空，解锁恢复后重开 */ }
  selectedIds.value = sshHosts.value.map(h => h.id)
  // 主机已就绪时自动跑一轮（打开即巡检，少一次点击；零主机则显空态引导）
  if (selectedIds.value.length > 0) void run()
})

async function run() {
  if (running.value || selectedIds.value.length === 0) return
  running.value = true
  topError.value = ''
  results.value = null
  try {
    const res = (await diagnoseBatchApi.run(selectedIds.value)) as unknown as Resp<{ results?: DiagBatchResult[]; durationMs?: number }>
    results.value = res.data?.results || []
    totalMs.value = res.data?.durationMs || 0
    const failed = results.value.filter(r => !r.ok).length
    if (failed > 0) message.warning(t('remoteOps.diagCompare.failedToast', { n: failed }))
  } catch (e: any) {
    // silent 调用：错误就地呈现（超限 400 引导减台数、锁定态引导解锁）
    topError.value = e?.userMessage || e?.message || t('remoteOps.diagCompare.failed')
  } finally {
    running.value = false
  }
}

// 行序：可对比主机在前按名称，失败主机沉底（离群扫描视线动线）
const rows = computed<DiagCompareRow[]>(() => sortDiagRows(results.value || []))

/** 离群位集合（"hostId:metricKey"）——高亮与报告标记共用同一判定 */
const outlierCells = computed(() => pickOutlierCells(rows.value))

function cellClass(r: DiagCompareRow, key: string) {
  return { 'is-outlier': outlierCells.value.has(`${r.hostId}:${key}`) }
}

function isOutlierCell(r: DiagCompareRow, key: string): boolean {
  return outlierCells.value.has(`${r.hostId}:${key}`)
}

// ============== 巡检报告一键复制（markdown） ==============

const reportMarkdown = computed(() => buildDiagCompareMarkdown(rows.value, {
  title: t('remoteOps.diagCompare.title'),
  host: t('remoteOps.diagCompare.colHost'),
  metrics: Object.fromEntries(DIAG_METRICS.map(d => [d.key, t(d.labelKey)])),
  failedSection: t('remoteOps.diagCompare.failedSection'),
}, new Date()))

async function copyReport() {
  // 剪贴板走 utils/clipboard 的 copyText（http 非安全上下文降级 execCommand），按返回值分支提示
  const ok = await copyText(reportMarkdown.value)
  if (ok) message.success(t('remoteOps.diagCompare.reportCopied'))
  else message.error(t('common.copyFailed'))
}
</script>

<template>
  <n-modal
    :show="props.show"
    :mask-closable="false"
    class="diagcmp-modal"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <div class="diagcmp-card">
      <div class="diagcmp-header">
        <div class="diagcmp-title">
          <n-icon size="16">
            <StatsChartOutline />
          </n-icon>
          <span>{{ t('remoteOps.diagCompare.title') }}</span>
        </div>
        <button
          class="diagcmp-close"
          @click="emit('update:show', false)"
        >
          &times;
        </button>
      </div>

      <div class="diagcmp-body">
        <!-- 主机选择行：全选 SSH 主机，FTP 不入选（服务端也会逐台拒绝） -->
        <div class="diagcmp-controls">
          <n-checkbox-group
            v-model:value="selectedIds"
            class="diagcmp-hosts"
            data-testid="diagcmp-hosts"
          >
            <n-checkbox
              v-for="h in sshHosts"
              :key="h.id"
              :value="h.id"
              :label="h.name"
              class="diagcmp-host"
            />
          </n-checkbox-group>
          <n-button
            size="small"
            type="primary"
            :loading="running"
            :disabled="selectedIds.length === 0"
            data-testid="diagcmp-run"
            @click="run"
          >
            {{ t('remoteOps.diagCompare.run') }}
          </n-button>
        </div>
        <div
          v-if="sshHosts.length === 0"
          class="diagcmp-empty"
          data-testid="diagcmp-nohosts"
        >
          {{ t('remoteOps.diagCompare.noHosts') }}
        </div>

        <div
          v-if="running"
          class="diagcmp-loading"
        >
          <n-spin size="medium" />
          <div class="diagcmp-loading-text">
            {{ t('remoteOps.diagCompare.running', { n: selectedIds.length }) }}
          </div>
        </div>

        <div
          v-else-if="topError"
          class="diagcmp-error"
          data-testid="diagcmp-error"
        >
          {{ topError }}
        </div>

        <template v-else-if="rows.length > 0">
          <!-- 横向对比表：每行一主机 × 指标列；橙色 = 离群（绝对阈值线或显著偏离全体中位数） -->
          <div class="diagcmp-table-wrap">
            <table
              class="diagcmp-table"
              data-testid="diagcmp-table"
            >
              <thead>
                <tr>
                  <th class="diagcmp-col-host">
                    {{ t('remoteOps.diagCompare.colHost') }}
                  </th>
                  <th
                    v-for="d in DIAG_METRICS"
                    :key="d.key"
                  >
                    {{ t(d.labelKey) }}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="r in rows"
                  :key="r.hostId"
                >
                  <td class="diagcmp-col-host">
                    <span :title="r.hostId">{{ r.name || r.hostId }}</span>
                  </td>
                  <template v-if="r.ok">
                    <td
                      v-for="d in DIAG_METRICS"
                      :key="d.key"
                      class="diagcmp-cell"
                      :class="cellClass(r, d.key)"
                      :data-outlier="isOutlierCell(r, d.key) ? '1' : undefined"
                      :title="isOutlierCell(r, d.key) ? t('remoteOps.diagCompare.outlierTip') : undefined"
                    >
                      {{ formatMetricValue(d, r.snapshot) }}
                    </td>
                  </template>
                  <td
                    v-else
                    class="diagcmp-cell-failed"
                    :colspan="DIAG_METRICS.length"
                  >
                    <n-tooltip
                      trigger="hover"
                      :disabled="!r.error"
                    >
                      <template #trigger>
                        <span class="diagcmp-failed-text">{{ t('remoteOps.diagCompare.failed') }}</span>
                      </template>
                      {{ r.error }}
                    </n-tooltip>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="diagcmp-legend">
            {{ t('remoteOps.diagCompare.legend') }}
          </div>

          <div class="diagcmp-meta">
            <span class="diagcmp-duration">{{ totalMs }}ms</span>
            <n-button
              size="tiny"
              data-testid="diagcmp-copy"
              @click="copyReport"
            >
              <template #icon>
                <n-icon><CopyOutline /></n-icon>
              </template>
              {{ t('remoteOps.diagCompare.copyReport') }}
            </n-button>
            <n-button
              size="tiny"
              @click="run"
            >
              <template #icon>
                <n-icon data-icon-action="git.compare"><GitCompareOutline /></n-icon>
              </template>
              {{ t('remoteOps.diagCompare.rerun') }}
            </n-button>
          </div>
        </template>

        <div
          v-else-if="sshHosts.length > 0"
          class="diagcmp-loading"
          style="padding: 24px"
        >
          <div class="diagcmp-loading-text">
            {{ t('remoteOps.diagCompare.idle') }}
          </div>
        </div>
      </div>
    </div>
  </n-modal>
</template>

<style scoped>
.diagcmp-card {
  width: 860px; max-width: 94vw; max-height: 84vh;
  background: var(--bg-panel); border: 1px solid var(--border-default);
  border-radius: 12px; box-shadow: var(--shadow-strong);
  display: flex; flex-direction: column; overflow: hidden;
}
.diagcmp-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 18px; border-bottom: 1px solid var(--border-default);
}
.diagcmp-title { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; color: var(--text-primary); }
.diagcmp-close {
  background: none; border: none; color: var(--text-muted);
  font-size: 22px; cursor: pointer; padding: 0 4px; line-height: 1; border-radius: 4px;
}
.diagcmp-close:hover { color: var(--text-primary); background: var(--bg-hover); }
.diagcmp-body { flex: 1; overflow-y: auto; padding: 14px 18px; }
.diagcmp-controls { display: flex; gap: 10px; align-items: flex-start; margin-bottom: 10px; }
.diagcmp-hosts {
  flex: 1; display: flex; flex-wrap: wrap; gap: 4px 12px;
  max-height: 96px; overflow-y: auto;
  padding: 6px 8px; border: 1px solid var(--border-subtle); border-radius: 6px;
  background: var(--bg-canvas);
}
.diagcmp-host { flex: 0 0 auto; }
.diagcmp-empty, .diagcmp-error {
  padding: 10px 12px; border-radius: 6px; margin-bottom: 10px;
  background: var(--bg-canvas); border: 1px solid var(--border-default);
  font-size: 13px; color: var(--text-secondary); word-break: break-all;
}
.diagcmp-error { color: var(--accent-red); }
.diagcmp-loading { padding: 40px; text-align: center; }
.diagcmp-loading-text { margin-top: 10px; font-size: 12px; color: var(--text-secondary); }
.diagcmp-table-wrap { overflow-x: auto; border: 1px solid var(--border-subtle); border-radius: 6px; }
.diagcmp-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.diagcmp-table th, .diagcmp-table td {
  padding: 6px 10px; text-align: left; white-space: nowrap;
  border-bottom: 1px solid var(--border-subtle);
}
.diagcmp-table th {
  font-weight: 500; color: var(--text-secondary); background: var(--bg-canvas);
}
.diagcmp-table tr:last-child td { border-bottom: none; }
.diagcmp-col-host { min-width: 120px; color: var(--text-primary); font-weight: 500; }
.diagcmp-cell { font-family: var(--font-mono); color: var(--text-primary); }
.diagcmp-cell.is-outlier {
  color: var(--accent-yellow-warm); font-weight: 700;
  background: color-mix(in srgb, var(--accent-yellow-warm) 12%, transparent);
}
.diagcmp-cell-failed { color: var(--accent-red); font-size: 12px; }
.diagcmp-failed-text { cursor: help; text-decoration: underline dotted; }
.diagcmp-legend { margin-top: 8px; font-size: 11px; color: var(--text-muted); }
.diagcmp-meta { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
.diagcmp-duration { font-size: 12px; color: var(--text-secondary); font-family: var(--font-mono); }
</style>
