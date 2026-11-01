<script setup lang="ts">
// 系统监控面板（决策门 M5.2 观测侧的用户入口）：
// 展示服务进程运行时指标（内存/GC/运行时长等），指标列表可扩展——
// 新增监控项 = metrics 数组加一个采集/渲染项，无需改结构。
// 数据源：GET /api/health（silent），挂载即拉 + 定时刷新，卸载停止。
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { NButton } from 'naive-ui'
import { RefreshOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'

interface HealthMemory {
  heapAllocMB: number
  sysMB: number
  numGC: number
}
// 磁盘水位单卷（P-20261002-12）：服务端已按数据盘/系统盘去重并判好档位
//（level 单一出处：>80 warn / >90 crit），前端只渲染不再自带阈值
interface HealthDiskVolume {
  role: 'data' | 'sys'
  path: string
  usedMB: number
  totalMB: number
  usedPercent: number
  level: 'ok' | 'warn' | 'crit'
}
interface HealthPayload {
  status?: string
  memory?: HealthMemory
  process?: { goroutines?: number; uptimeSeconds?: number }
  checks?: Record<string, string>
  disk?: { volumes?: HealthDiskVolume[] }
}

const { t } = useI18n()

const health = ref<HealthPayload | null>(null)
const unreachable = ref(false)
const refreshing = ref(false)
let timer: ReturnType<typeof setInterval> | null = null

const REFRESH_MS = 10_000

// 内存水位采样：每 10s 一点，滚动保留近 90 点（约 15 分钟）——
// autoRefreshHint 承诺的「内存水位趋势」由下方折线卡兑现（仅内存态，不落盘）
interface MemorySample { heap: number; sys: number }
const samples = ref<MemorySample[]>([])
const MAX_SAMPLES = 90
const TREND_W = 600
const TREND_H = 80

async function refresh() {
  refreshing.value = true
  try {
    const res = await fetch('/api/health').then(r => r.json())
    health.value = res
    unreachable.value = false
    const m = res?.memory
    if (m) {
      samples.value = [...samples.value, { heap: m.heapAllocMB, sys: m.sysMB }].slice(-MAX_SAMPLES)
    }
  } catch {
    unreachable.value = true
  } finally {
    refreshing.value = false
  }
}

// 折线几何：自动量程，量程为 0（样本全等）时画中线
function trendPoints(key: 'heap' | 'sys'): string {
  const vals = samples.value.map(s => s[key])
  if (vals.length < 2) return ''
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const span = max - min
  return vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * TREND_W
    const y = span === 0 ? TREND_H / 2 : TREND_H - 6 - ((v - min) / span) * (TREND_H - 12)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
}
const hasTrend = computed(() => samples.value.length >= 2)
const heapPeak = computed(() =>
  samples.value.length ? humanMB(Math.max(...samples.value.map(s => s.heap))) : '—')

// 磁盘水位卷清单（同卷去重由服务端完成，通常仅数据盘一条）
const diskVolumes = computed(() => health.value?.disk?.volumes ?? [])

function diskRoleLabel(role: string): string {
  return role === 'sys' ? t('monitor.disk.sysDisk') : t('monitor.disk.dataDisk')
}

// 容量格式（1024 进制，与 humanMB 同基；水位条旁的 used/total 明细）
function humanSize(mb: number): string {
  if (mb >= 1024 * 1024) return (mb / (1024 * 1024)).toFixed(2) + ' TB'
  if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB'
  return mb + ' MB'
}

onMounted(() => {
  void refresh()
  timer = setInterval(() => void refresh(), REFRESH_MS)
})
onBeforeUnmount(() => { if (timer) clearInterval(timer) })

function humanMB(mb: number): string {
  return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb + ' MB'
}

function humanUptime(sec?: number): string {
  if (!sec || sec < 0) return '—'
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

// 指标渲染清单（新增监控项在此加一行即可）
const metrics = computed(() => {
  const m = health.value?.memory
  const p = health.value?.process
  return [
    { key: 'heap', label: t('monitor.heapAlloc'), value: m ? humanMB(m.heapAllocMB) : '—', hint: t('monitor.heapAllocHint') },
    { key: 'sys', label: t('monitor.sysMem'), value: m ? humanMB(m.sysMB) : '—', hint: t('monitor.sysMemHint') },
    { key: 'gc', label: t('monitor.gcCount'), value: m ? String(m.numGC) : '—', hint: '' },
    { key: 'goroutines', label: t('monitor.goroutines'), value: p?.goroutines !== undefined ? String(p.goroutines) : '—', hint: '' },
    { key: 'uptime', label: t('monitor.uptime'), value: humanUptime(p?.uptimeSeconds), hint: '' },
  ]
})
</script>

<template>
  <div class="sysmon">
    <div class="sysmon-toolbar">
      <span
        class="sysmon-status"
        :class="{ bad: unreachable }"
      >
        {{ unreachable ? t('monitor.unreachable') : health?.status === 'ok' ? t('monitor.healthy') : '…' }}
      </span>
      <n-button
        size="tiny"
        quaternary
        :loading="refreshing"
        @click="refresh"
      >
        <template #icon>
          <RefreshOutline />
        </template>
        {{ t('monitor.refresh') }}
      </n-button>
    </div>

    <div class="sysmon-grid">
      <div
        v-for="m in metrics"
        :key="m.key"
        class="sysmon-item"
        :title="m.hint"
      >
        <div class="sysmon-value">
          {{ m.value }}
        </div>
        <div class="sysmon-label">
          {{ m.label }}
        </div>
      </div>
    </div>

    <div
      v-if="diskVolumes.length"
      class="sysmon-disk"
    >
      <div class="sysmon-disk-head">
        <span class="sysmon-disk-title">{{ t('monitor.disk.title') }}</span>
        <span
          class="sysmon-disk-hint"
          :title="t('monitor.disk.hint')"
        >{{ t('monitor.disk.hint') }}</span>
      </div>
      <div
        v-for="v in diskVolumes"
        :key="v.role"
        class="sysmon-disk-row"
        :data-level="v.level"
      >
        <div class="sysmon-disk-meta">
          <span class="sysmon-disk-label">{{ diskRoleLabel(v.role) }}</span>
          <span
            class="sysmon-disk-path"
            :title="v.path"
          >{{ v.path }}</span>
          <span class="sysmon-disk-size">{{ humanSize(v.usedMB) }} / {{ humanSize(v.totalMB) }}</span>
        </div>
        <div class="sysmon-disk-barline">
          <div
            class="sysmon-disk-bar"
            role="meter"
            :aria-valuemin="0"
            :aria-valuemax="100"
            :aria-valuenow="Math.round(v.usedPercent)"
          >
            <div
              class="sysmon-disk-fill"
              :style="{ width: Math.min(100, Math.max(0, v.usedPercent)) + '%' }"
            />
          </div>
          <span class="sysmon-disk-pct">{{ v.usedPercent.toFixed(1) }}%</span>
        </div>
      </div>
    </div>

    <div class="sysmon-trend">
      <div class="sysmon-trend-head">
        <span class="sysmon-trend-title">{{ t('monitor.trendTitle') }}</span>
        <span class="sysmon-trend-legend">
          <span class="trend-dot trend-dot-heap" />
          <span class="trend-legend-label">{{ t('monitor.trendHeap') }}</span>
          <span class="trend-dot trend-dot-sys" />
          <span class="trend-legend-label">{{ t('monitor.trendSys') }}</span>
          <span
            v-if="hasTrend"
            class="sysmon-trend-peak"
          >{{ t('monitor.trendPeak', { v: heapPeak }) }}</span>
        </span>
      </div>
      <svg
        v-if="hasTrend"
        class="sysmon-trend-svg"
        :viewBox="`0 0 ${TREND_W} ${TREND_H}`"
        preserveAspectRatio="none"
        role="img"
      >
        <polyline
          class="trend-line trend-line-sys"
          :points="trendPoints('sys')"
        />
        <polyline
          class="trend-line trend-line-heap"
          :points="trendPoints('heap')"
        />
      </svg>
      <div
        v-else
        class="sysmon-trend-empty"
      >
        {{ t('monitor.trendEmpty') }}
      </div>
    </div>

    <div class="sysmon-footnote">
      {{ t('monitor.autoRefreshHint', { sec: 10 }) }}
    </div>
  </div>
</template>

<style scoped>
.sysmon { display: flex; flex-direction: column; gap: var(--space-3); }
.sysmon-toolbar { display: flex; align-items: center; justify-content: space-between; }
.sysmon-status { font-size: 12px; color: var(--accent-green); }
.sysmon-status.bad { color: var(--accent-red-bright, #f85149); }
.sysmon-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 10px;
}
.sysmon-item {
  background: var(--bg-primary); border: 1px solid var(--border-default);
  border-radius: var(--radius-lg); padding: 10px var(--space-3);
}
.sysmon-value { font-size: 18px; font-weight: var(--fw-semibold); color: var(--text-primary); font-family: var(--font-mono, monospace); }
.sysmon-label { margin-top: 2px; font-size: var(--fs-meta-min, 11.5px); color: var(--text-dim); }
.sysmon-footnote { font-size: var(--fs-meta-min, 11.5px); color: var(--text-dim); }

/* 磁盘水位卡（P-20261002-12）：档位色带水位条，与指标卡同一卡片语言 */
.sysmon-disk {
  background: var(--bg-primary); border: 1px solid var(--border-default);
  border-radius: var(--radius-lg); padding: 10px var(--space-3);
  display: flex; flex-direction: column; gap: var(--space-2);
}
.sysmon-disk-head { display: flex; align-items: baseline; gap: var(--space-2); }
.sysmon-disk-title { font-size: 12px; font-weight: var(--fw-semibold); color: var(--text-secondary); }
.sysmon-disk-hint {
  font-size: var(--fs-meta-min, 11.5px); color: var(--text-dim);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.sysmon-disk-row { display: flex; flex-direction: column; gap: var(--space-1); }
.sysmon-disk-meta { display: flex; align-items: baseline; gap: var(--space-2); min-width: 0; }
.sysmon-disk-label { font-size: 12px; color: var(--text-primary); flex-shrink: 0; }
.sysmon-disk-path {
  font-size: var(--fs-meta-min, 11.5px); color: var(--text-dim); font-family: var(--font-mono, monospace);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.sysmon-disk-size {
  margin-left: auto; flex-shrink: 0;
  font-size: var(--fs-meta-min, 11.5px); color: var(--text-secondary); font-family: var(--font-mono, monospace);
}
.sysmon-disk-barline { display: flex; align-items: center; gap: var(--space-2); }
.sysmon-disk-bar {
  flex: 1; height: 6px; border-radius: var(--radius-sm);
  background: var(--bg-canvas);
  border: 1px solid var(--border-default);
  overflow: hidden;
}
.sysmon-disk-fill { height: 100%; border-radius: var(--radius-sm); background: var(--accent-green); transition: width .3s ease; }
.sysmon-disk-row[data-level='warn'] .sysmon-disk-fill { background: var(--accent-yellow-warm); }
.sysmon-disk-row[data-level='crit'] .sysmon-disk-fill { background: var(--accent-red-bright, #f85149); }
.sysmon-disk-pct {
  flex-shrink: 0; width: 48px; text-align: right;
  font-size: var(--fs-meta-min, 11.5px); color: var(--text-secondary); font-family: var(--font-mono, monospace);
}
.sysmon-disk-row[data-level='warn'] .sysmon-disk-pct { color: var(--accent-yellow-warm); }
.sysmon-disk-row[data-level='crit'] .sysmon-disk-pct { color: var(--accent-red-bright, #f85149); }

/* 内存水位趋势卡 */
.sysmon-trend {
  background: var(--bg-primary); border: 1px solid var(--border-default);
  border-radius: var(--radius-lg); padding: 10px var(--space-3) var(--space-2);
}
.sysmon-trend-head { display: flex; align-items: center; gap: var(--space-2); margin-bottom: 6px; }
.sysmon-trend-title { font-size: 12px; font-weight: var(--fw-semibold); color: var(--text-secondary); }
.sysmon-trend-legend { display: inline-flex; align-items: center; gap: 5px; margin-left: auto; font-size: var(--fs-meta-min, 11.5px); color: var(--text-dim); }
.trend-dot { width: 8px; height: 2px; border-radius: 1px; }
.trend-dot-heap { background: var(--accent-blue); }
.trend-dot-sys { background: var(--accent-green); }
.trend-legend-label { margin-right: var(--space-1); }
.sysmon-trend-peak { margin-left: var(--space-2); font-family: var(--font-mono, monospace); color: var(--text-secondary); }
.sysmon-trend-svg { display: block; width: 100%; height: 80px; }
.trend-line { fill: none; stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.trend-line-heap { stroke: var(--accent-blue); }
.trend-line-sys { stroke: var(--accent-green); }
.sysmon-trend-empty { height: 80px; display: flex; align-items: center; justify-content: center; font-size: var(--fs-meta-min, 11.5px); color: var(--text-dim); }
</style>
