<script setup lang="ts">
// 实例健康卡（P-20261003-28）：值班大屏消费 GET /api/system/health 自省
// 摘要（运行时长/存活堆/Goroutine/WS 连接 + P-20261004-125 起 git 子进程
// 并发面两格），自带 30s 轮询 + 挂载即拉；
// defineExpose refresh() 供大屏 refreshAll（R 键/刷新按钮）同步刷新。
// P-20261003-276 起同轮询联动 GET /api/system/scheduler 后台任务注册快照
//（默认折叠清单：任务名/间隔/上次运行，只读不提供启停）。
// 实例自身健康与机群活动是两回事：机群空闲空态时同样常显（MonitorView 在
// isEmpty 守卫之外渲染本卡）。样式自包含镜像 mon-card 卡片语言——scoped
// 样式只有子组件根节点会拿到父作用域，内部件不吃父样式，故不借 .mon-card 类名。
// 拉取失败静默降级（打点置红 + 注记，不弹 toast）：常开大屏上瞬时 423/断网
// 不该打扰值守，下一轮轮询自动恢复。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from '../../composables/useI18n'
import { systemHealthApi, systemSchedulerApi, type InstanceHealth, type SchedulerJob } from '../../api/domains/system'
import { formatDateTime } from '../../utils/git'

const REFRESH_MS = 30_000

const { t } = useI18n()
const health = ref<InstanceHealth | null>(null)
const stale = ref(false)
// 后台任务清单（P-20261003-276）：健康卡联动段——调度器注册快照，默认折叠
//（常开大屏墙格高度稳定，展开态不进 30s 重渲染热路径——列表本体静态快照）
const jobs = ref<SchedulerJob[]>([])
const schedOpen = ref(false)
let timer: ReturnType<typeof setInterval> | null = null

async function refresh(): Promise<void> {
  try {
    health.value = await systemHealthApi.get({ silent: true })
    stale.value = false
  } catch {
    stale.value = true
  }
  // 清单是尽力而为的旁路面：失败静默保旧，不打健康采样的失败红点
  //（两路独立——调度器清单失联不代表实例不健康，下一轮轮询自动恢复）
  try {
    jobs.value = (await systemSchedulerApi.get({ silent: true })).data ?? []
  } catch {
    /* 保旧 */
  }
}

onMounted(() => {
  void refresh()
  timer = setInterval(() => void refresh(), REFRESH_MS)
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
defineExpose({ refresh })

// —— 数值格式化（1024 进制 + d/h/m/s 单位字母，与设置页系统监控同基）——
function humanBytes(bytes: number): string {
  const mb = bytes / 1024 / 1024
  if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB'
  if (mb >= 1) return mb.toFixed(1) + ' MB'
  return Math.max(1, Math.round(bytes / 1024)) + ' KB'
}
/** 运行时长恒含秒位：任意两次相隔 ≥1s 的采样文本必不同（值班场景「还在走」
 *  的一眼证据，也让刷新反馈可感知；小时以上自动带分钟秒） */
function humanUptime(sec: number): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  if (d > 0) return `${d}d ${String(h).padStart(2, '0')}h ${mm}m ${ss}s`
  if (h > 0) return `${h}h ${mm}m ${ss}s`
  return `${m}m ${ss}s`
}

// 六格恒渲染（未采样时 — 占位）：卡片高度稳定，加载/失败态不打断网格。
// git 进程/排队两格（P-20261004-125）：全局并发门水位——排队持续 >0 即槽位
// 被长操作占满的信号，tip 承载峰值（上限标定观测面）
const items = computed(() => [
  { key: 'uptime', label: t('monitor.health.uptimeLabel'), value: health.value ? humanUptime(health.value.uptime) : '—', tip: '' },
  { key: 'heap', label: t('monitor.health.heapLabel'), value: health.value ? humanBytes(health.value.heapAlloc) : '—', tip: '' },
  { key: 'goroutines', label: t('monitor.health.goroutinesLabel'), value: health.value ? String(health.value.goroutines) : '—', tip: '' },
  { key: 'ws', label: t('monitor.health.wsLabel'), value: health.value ? String(health.value.wsClients) : '—', tip: '' },
  {
    key: 'gitproc',
    label: t('monitor.health.gitProcLabel'),
    value: health.value ? String(health.value.gitRunning) : '—',
    tip: '',
  },
  {
    key: 'gitwait',
    label: t('monitor.health.gitWaitLabel'),
    value: health.value ? String(health.value.gitWaiting) : '—',
    tip: health.value ? t('monitor.health.gitWaitTip', { peak: health.value.gitWaitingPeak }) : '',
  },
])

// 审计写失败警示（P-20261003-205）：>0 才渲染——健康卡四格之外的条件行，
// 审计 Append 尽力而为语义下静默丢失的断链在此显形（30s 轮询自动跟随）
const auditFails = computed(() => health.value?.auditWriteFails ?? 0)
const auditLastFailText = computed(() => formatDateTime(health.value?.auditLastWriteFail || ''))

// 间隔人类可读（与 humanUptime 同字母单位风格，语言中立）：间隔是配置值
// 不是测量值，整数档位足矣（30s/10m/1h/24h→1d）
function humanInterval(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  const h = s / 3600
  if (h < 48) return `${Math.round(h)}h`
  return `${Math.round(h / 24)}d`
}
</script>

<template>
  <article
    class="mhc-card"
    data-testid="monitor-health-card"
  >
    <div class="mhc-head">
      <span
        class="mhc-dot"
        :class="{ 'is-stale': stale }"
      />
      <span class="mhc-kind">{{ t('monitor.health.title') }}</span>
      <span
        v-if="stale"
        class="mhc-stale"
      >{{ t('monitor.health.stale') }}</span>
    </div>
    <div class="mhc-grid">
      <div
        v-for="it in items"
        :key="it.key"
        class="mhc-item"
        :data-testid="`monitor-health-${it.key}`"
        :title="it.tip"
      >
        <span class="mhc-value">{{ it.value }}</span>
        <span class="mhc-label">{{ it.label }}</span>
      </div>
    </div>
    <!-- 审计写失败警示（P-20261003-205）：计数非零才出现，title 承载最近
         失败时刻与恢复指引（修复磁盘/数据目录后重启实例计数清零） -->
    <div
      v-if="auditFails > 0"
      class="mhc-audit-fails"
      data-testid="monitor-health-audit-fails"
      :title="t('monitor.health.auditFailsTip', { time: auditLastFailText })"
    >
      {{ t('monitor.health.auditFails', { n: auditFails }) }}
    </div>
    <!-- 后台任务清单（P-20261003-276）：默认折叠的联动段——「后台都在跑什么」
         运维可见面；展开后三列直出服务端快照（名称升序），行数多时列表内滚动
         封顶不撑破墙格；只读注记承载提案边界（刻意不提供启停） -->
    <button
      v-if="jobs.length > 0"
      type="button"
      class="mhc-sched-toggle"
      data-testid="monitor-health-scheduler-toggle"
      :aria-expanded="schedOpen"
      @click="schedOpen = !schedOpen"
    >
      <span>{{ t('monitor.health.schedulerJobs', { n: jobs.length }) }}</span>
      <span class="mhc-sched-chev">{{ schedOpen ? '▾' : '▸' }}</span>
    </button>
    <div
      v-if="schedOpen"
      class="mhc-sched"
      data-testid="monitor-health-scheduler"
    >
      <div class="mhc-sched-row mhc-sched-head">
        <span>{{ t('monitor.health.schedulerColName') }}</span>
        <span>{{ t('monitor.health.schedulerColInterval') }}</span>
        <span>{{ t('monitor.health.schedulerColLastRun') }}</span>
      </div>
      <div class="mhc-sched-list">
        <div
          v-for="j in jobs"
          :key="j.name"
          class="mhc-sched-row"
          data-testid="monitor-health-scheduler-item"
        >
          <span
            class="mhc-sched-name"
            :title="j.name"
          >{{ j.name }}</span>
          <span class="mhc-sched-mono">{{ humanInterval(j.intervalMs) }}</span>
          <span class="mhc-sched-mono">{{ j.lastRun ? formatDateTime(j.lastRun) : t('monitor.health.schedulerNever') }}</span>
        </div>
      </div>
      <div class="mhc-sched-note">
        {{ t('monitor.health.schedulerReadonly') }}
      </div>
    </div>
    <div class="mhc-foot">
      {{ t('monitor.health.pollHint', { sec: 30 }) }}
    </div>
  </article>
</template>

<style scoped>
/* 镜像 mon-card 卡片语言（值班大屏 .mon-wall 网格内消费），见文件头注释 */
.mhc-card {
  background: var(--bg-panel);
  border: 1px solid var(--border-default);
  border-radius: 10px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  box-shadow: var(--shadow-soft);
}
.mhc-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.mhc-kind { font-size: 11px; font-weight: 600; color: var(--text-muted); flex-shrink: 0; }
.mhc-dot {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
  background: var(--accent-green);
}
.mhc-dot.is-stale { background: var(--accent-red); }
.mhc-stale { margin-left: auto; font-size: 11px; color: var(--accent-red); }
.mhc-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 12px;
}
.mhc-item { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.mhc-value {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  font-family: var(--font-mono, monospace);
}
.mhc-label { font-size: 11px; color: var(--text-muted); }
/* 审计写失败警示行（P-20261003-205）：橙警示色与「采样失败」红点区分——
   这是可恢复的资源面问题而非采样失联 */
.mhc-audit-fails {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent-orange);
  padding: 4px 6px;
  border: 1px solid var(--accent-orange);
  border-radius: 6px;
  cursor: help;
}
/* 后台任务清单（P-20261003-276）：折叠钮与三列清单，沿用卡片 11px 语言；
   列表 max-height 内滚动——19+ 注册任务全展开会撑破墙格行高 */
.mhc-sched-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  background: transparent;
  border: 1px solid var(--border-default);
  border-radius: 6px;
  padding: 4px 8px;
  cursor: pointer;
}
.mhc-sched-toggle:hover { color: var(--text-primary); background: var(--bg-hover); }
.mhc-sched-chev { font-size: 10px; }
.mhc-sched { display: flex; flex-direction: column; gap: 2px; }
.mhc-sched-head {
  font-weight: 600;
  color: var(--text-muted);
  border-bottom: 1px solid var(--border-default);
  padding-bottom: 2px;
}
.mhc-sched-list {
  max-height: 180px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.mhc-sched-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 44px 110px;
  gap: 8px;
  font-size: 11px;
  color: var(--text-primary);
}
.mhc-sched-name {
  font-family: var(--font-mono, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mhc-sched-mono { font-family: var(--font-mono, monospace); white-space: nowrap; }
.mhc-sched-note { font-size: 11px; color: var(--text-muted); }
.mhc-foot { font-size: 11px; color: var(--text-muted); }
</style>
