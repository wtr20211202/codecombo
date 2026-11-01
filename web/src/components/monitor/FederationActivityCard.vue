<script setup lang="ts">
// 联邦活动热力卡（P-20261004-98）：值班大屏消费 GET /api/instances/activity-matrix
// 多实例负载对比矩阵——P-37 单实例热力卡（ActivityHeatmapCard）的联邦面：每行
// 一个注册实例的近 14 天迷你热力 + 活跃度汇总值，回答「哪台机器最近闲着/哪台
// 过载」而无需逐台开各自的大屏。要点：
//   - 色阶跨行同尺（全行全局峰值归一）：单实例卡按本窗口峰值归一是「自己和自己
//     比」，联邦对比必须同一把尺——闲机器的淡与忙机器的深直接可比，这正是本卡
//     的存在理由；列按日期对齐（固定 14 格窗口收尾于今天，缺行 = 0 档）
//   - 行态：ok 正常渲染 / unreachable（网络层失败或对端异常）/ unsupported
//     （旧对端无 activity 端点）显标签不打断整卡；失败隔离在服务端完成
//   - 点击行沿既有实例切换链（InstanceSessionOverview.switchTo 同链路——
//     store.selectInstance 自带重入守卫）跳到该实例看详情；不可达行点了也
//     切不过去（探活/加载必失败），不出手型
//   - 挂载即拉 + 无轮询：天粒度数据（同 ActivityHeatmapCard 惯例），服务端
//     另有 5 分钟聚合缓存，refreshAll（R 键/刷新按钮）同步刷新；拉取失败
//     静默降级（打点置红，不弹 toast）——常开大屏不打扰值守
// 样式自包含镜像 mon-card 卡片语言——scoped 样式只有子组件根节点会拿到父
// 作用域（同 InstanceHealthCard/ActivityHeatmapCard 文件头注释）。
import { computed, onMounted, ref } from 'vue'
import { useI18n } from '../../composables/useI18n'
import { instanceApi, type ActivityMatrixRow } from '../../api/domains/system'
import { useInstanceStore } from '../../stores/instance'
// 权重/分档与单实例卡同源收口（utils/activityScore 单一事实源）
import { activityLevel, activityScore } from '../../utils/activityScore'

// 对比窗口：14 天（提案口径——负载对比看两周足够，服务端 days 钳制 ≤365 已备）
const MATRIX_DAYS = 14

const { t } = useI18n()
const instanceStore = useInstanceStore()
const stale = ref(false)
const rows = ref<ActivityMatrixRow[]>([])

async function refresh(): Promise<void> {
  try {
    const res = await instanceApi.activityMatrix(MATRIX_DAYS, { silent: true })
    rows.value = res?.data?.rows ?? []
    stale.value = false
  } catch {
    stale.value = true
  }
}
onMounted(() => void refresh())
defineExpose({ refresh })

/** YYYY-MM-DD（与浏览器本地日界一致；服务器同机部署时即序列键口径） */
function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

interface FederationCell {
  date: string
  level: number
}

/** 单行 14 格：固定窗口（今天收尾）+ 按行序列建索引，缺行 = 0 档——列对齐
 *  后跨行同列即同一天，对比才成立。行数量 = 行数 × 14 步进，computed 只随
 *  rows 变化重算（天粒度数据非热路径，量级可忽略） */
const rowCells = computed<Map<string, FederationCell[]>>(() => {
  // 全局峰值：跨行同尺的归一锚（全空窗口 = 0，格子恒 0 档）
  let peak = 0
  const byRow = new Map<string, Map<string, number>>()
  for (const row of rows.value) {
    const byDate = new Map<string, number>()
    let max = 0
    for (const e of row.series ?? []) {
      const s = activityScore(e)
      byDate.set(e.date, s)
      if (s > max) max = s
    }
    byRow.set(row.instanceId, byDate)
    if (max > peak) peak = max
  }

  const end = new Date()
  const dates: string[] = []
  const cursor = new Date(end)
  for (let i = 0; i < MATRIX_DAYS; i++) {
    dates.unshift(dateKey(cursor))
    cursor.setDate(cursor.getDate() - 1)
  }

  const out = new Map<string, FederationCell[]>()
  for (const [id, byDate] of byRow) {
    out.set(id, dates.map(date => ({ date, level: activityLevel(byDate.get(date) ?? 0, peak) })))
  }
  return out
})

function cellsOf(row: ActivityMatrixRow): FederationCell[] {
  return rowCells.value.get(row.instanceId) ?? []
}

/** 行汇总值：窗口活跃度加权和（对日分行求和线性等价于对合计求分）；
 *  悬停给三项原始数值——agent 派单决策与人读共用一卡 */
function rowSummaryTip(row: ActivityMatrixRow): string {
  return t('monitor.federation.summaryTip', { days: MATRIX_DAYS, ...row.totals })
}

function cellTip(cell: FederationCell, row: ActivityMatrixRow): string {
  const entry = (row.series ?? []).find(e => e.date === cell.date)
  return t('monitor.activity.tip', {
    date: cell.date,
    commits: entry?.commits ?? 0,
    sessions: entry?.sessions ?? 0,
    commands: entry?.commands ?? 0,
  })
}

/** 行点击 = 切到该实例（本机行已在此处；不可达/不支持行切换必失败不出手型） */
function rowClickable(row: ActivityMatrixRow): boolean {
  return !row.self && row.status === 'ok'
}

async function openRow(row: ActivityMatrixRow): Promise<void> {
  if (!rowClickable(row)) return
  // 大屏是独立路由（不挂 Layout 引导链），实例清单不保证就绪——切换前确保
  // 在册（幂等；清单已在且探测 TTL 内时零额外请求，语义同 InstanceFleetOverview
  // 打开时的 ensureInstancesFresh）
  await instanceStore.ensureInstancesFresh()
  await instanceStore.selectInstance(row.instanceId)
}

function statusLabel(row: ActivityMatrixRow): string {
  if (row.status === 'unreachable') return t('monitor.federation.statusUnreachable')
  if (row.status === 'unsupported') return t('monitor.federation.statusUnsupported')
  return ''
}
</script>

<template>
  <article
    class="fac-card"
    data-testid="monitor-federation-card"
  >
    <div class="fac-head">
      <span
        class="fac-dot"
        :class="{ 'is-stale': stale }"
      />
      <span class="fac-kind">{{ t('monitor.federation.title') }}</span>
      <span
        v-if="stale"
        class="fac-stale"
      >{{ t('monitor.federation.stale') }}</span>
    </div>
    <div
      v-for="row in rows"
      :key="row.instanceId"
      class="fac-row"
      :class="{ self: row.self, clickable: rowClickable(row) }"
      data-testid="monitor-federation-row"
      :title="rowClickable(row) ? t('monitor.federation.switchHint') : undefined"
      @click="openRow(row)"
    >
      <span class="fac-name">
        <span
          class="fac-name-text"
          :title="row.instanceId"
        >{{ row.name }}</span>
        <span
          v-if="row.self"
          class="fac-tag self"
        >{{ t('monitor.federation.selfBadge') }}</span>
        <span
          v-if="row.status !== 'ok'"
          class="fac-tag"
          :class="row.status"
          data-testid="monitor-federation-status"
        >{{ statusLabel(row) }}</span>
      </span>
      <!-- 仅 ok 行渲染热力格与汇总值：失败行的全灰格会被误读为「零活动」，
           宁缺毋谎（标签承载失败语义） -->
      <span
        v-if="row.status === 'ok'"
        class="fac-cells"
        data-testid="monitor-federation-cells"
      >
        <span
          v-for="c in cellsOf(row)"
          :key="c.date"
          class="fac-cell"
          :class="`is-l${c.level}`"
          :data-date="c.date"
          :data-level="c.level"
          :title="cellTip(c, row)"
        />
      </span>
      <span
        v-if="row.status === 'ok'"
        class="fac-score"
        data-testid="monitor-federation-score"
        :title="rowSummaryTip(row)"
      >{{ activityScore(row.totals) }}</span>
      <span
        v-else
        class="fac-score is-dim"
      >—</span>
    </div>
    <div class="fac-foot">
      {{ t('monitor.federation.cacheHint', { days: MATRIX_DAYS }) }}
    </div>
  </article>
</template>

<style scoped>
/* 镜像 mon-card 卡片语言（值班大屏 .mon-wall 网格内消费），见文件头注释 */
.fac-card {
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
.fac-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.fac-kind { font-size: 11px; font-weight: 600; color: var(--text-muted); flex-shrink: 0; }
.fac-dot {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
  background: var(--accent-green);
}
.fac-dot.is-stale { background: var(--accent-red); }
.fac-stale { font-size: 11px; color: var(--accent-red); }

/* 行三段：名字/标签段定宽截断、格子段居中、汇总值右对齐——行数 = 注册实例
   数（个位量级），纵向堆叠无分页 */
.fac-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 2px;
  font-size: 12px;
}
.fac-row.clickable { cursor: pointer; }
.fac-row.clickable:hover { background: var(--bg-hover); border-radius: 6px; }
.fac-name {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  min-width: 0;
  color: var(--text-primary);
}
.fac-name-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fac-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--bg-hover);
  color: var(--text-tertiary);
  flex-shrink: 0;
}
.fac-tag.self { color: var(--accent-blue); }
.fac-tag.unreachable { color: var(--accent-red); }
.fac-tag.unsupported { color: var(--status-waiting); }
/* 迷你热力行：14 格定值尺寸（不压缩保持逐格可悬停），与单实例卡同款色阶
   派生（--accent-green color-mix，主题切换自适应，零硬编码色值） */
.fac-cells {
  display: flex;
  gap: 3px;
  flex-shrink: 0;
}
.fac-cell {
  display: inline-block;
  width: 9px;
  height: 11px;
  border-radius: 2px;
  background: var(--bg-hover);
}
.fac-cell.is-l1 { background: color-mix(in srgb, var(--accent-green) 25%, var(--bg-panel)); }
.fac-cell.is-l2 { background: color-mix(in srgb, var(--accent-green) 45%, var(--bg-panel)); }
.fac-cell.is-l3 { background: color-mix(in srgb, var(--accent-green) 70%, var(--bg-panel)); }
.fac-cell.is-l4 { background: var(--accent-green); }
.fac-score {
  font-family: var(--font-mono, monospace);
  color: var(--text-secondary);
  flex-shrink: 0;
  min-width: 32px;
  text-align: right;
}
.fac-score.is-dim { color: var(--text-tertiary); }
.fac-foot { font-size: 11px; color: var(--text-muted); }
</style>
