<script lang="ts">
// 窗口档位会话态（P-20261004-106）：模块级 ref = SPA 会话内记忆（路由切走
// 再回大屏不重置），刷新页面即回默认——刻意不落 uiState：天粒度视图偏好无
// 持久化价值，且默认 13 周须保持 P-37 上线观感。普通 <script> 块承载模块
// 作用域（setup 每次挂载重建，组件级 ref 撑不起「本会话」语义）；两块合成
// 同一模块，ref/computed 等导入只需 setup 块一份
/** 视图窗口档位（周）：默认 13 保持历史观感；52 周 = 364 天 ≤ 服务端 365 天保留窗口 */
export const WINDOW_WEEK_LEVELS = [13, 26, 52] as const

const windowWeeks = ref<number>(13)
</script>

<script setup lang="ts">
// 实例活动热力图卡（P-20261003-37）：值班大屏消费 GET /api/reports/activity
// 实例级每日事实序列，GitHub contribution graph 式 CSS grid 色阶（无图表库
// 依赖）。活跃度 = 提交×2 + 会话×3 + 命令×1 加权和按窗口峰值归一到 0~4 级；
// 色阶全部由主题变量 color-mix 派生（--accent-green 系），不引入新语义色——
// 对比度由主题治理脚本域把关。defineExpose refresh() 供大屏 refreshAll
// （R 键/刷新按钮）同步刷新。拉取失败静默降级（打点置红，不弹 toast）：
// 常开大屏上瞬时 423/断网不打扰值守，下轮刷新自动恢复。
// 挂载即拉 + 无轮询：序列是天粒度数据，手动刷新/重进页面即最新（与 30s 轮询
// 的健康卡不同，无需常驻定时器）。
// 窗口档位（P-20261004-106）：卡头 13/26/52 周三档切换（默认 13 季度视图），
// 格子渲染窗口参数化消费既有 days 口（服务端钳制 ≤365 已备，52 周 = 364 天
// 无需后端改动）；切换即按新窗口重取序列段，档位本会话记忆（模块级 ref）。
// 格子点击下钻（P-20261004-96）：热力图答「何时」、日报答「什么」——有活动
// 行的格子开日报历史面板聚焦该日（reportArchive store 跨树共达，面板挂通知
// 中心组件根），无活动行格（服务未发报日）弱提示不开面板。
// 样式自包含镜像 mon-card 卡片语言——scoped 样式只有子组件根节点会拿到父
// 作用域，内部件不吃父样式（同 InstanceHealthCard 文件头注释）。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { createDiscreteApi } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { reportApi, type ActivityDayEntry } from '../../api/domains/report'
import { useThemeStore } from '../../stores/theme'
import { useReportArchiveStore } from '../../stores/reportArchive'
// 活跃度权重/分档收口 utils/activityScore 单源（P-20261004-98 起联邦活动卡
// 同用一份权重，禁两处漂移）
import { activityLevel, activityScore, activityTotals } from '../../utils/activityScore'

// 当前窗口天数：周档 ×7（与后端 days 口径一致，13 档 = 91 天即历史窗口）
const windowDays = computed(() => windowWeeks.value * 7)

const { t } = useI18n()
const stale = ref(false)
const series = ref<ActivityDayEntry[]>([])
const themeStore = useThemeStore()
const archiveStore = useReportArchiveStore()

// 下钻弱提示离散 message（DailyReportHistory 同范式）：点击是用户主动诉求，
// 无日报也要有反馈——与拉取失败的静默降级（打点置红不弹 toast）刻意不同。
// 卸载即回收离散 app：通知中心/DailyReportHistory 是 App 层常驻不涉及，本卡
// 所在 MonitorView 随路由/实例切换反复挂载，不回收会逐次累积游离容器
const { message, unmount: unmountMessageApi } = createDiscreteApi(['message'], {
  configProviderProps: computed(() => ({
    theme: themeStore.naiveTheme,
    themeOverrides: themeStore.naiveOverrides,
  })),
})
onBeforeUnmount(unmountMessageApi)

// 过期代守卫：档位连点时在途响应按代丢弃（52 周的慢响应落在 13 档会把
// totals/峰值归一污染成跨窗口口径——摘要行「近 91 天」配 364 天合计即错账）
let fetchGen = 0

async function refresh(): Promise<void> {
  const gen = ++fetchGen
  try {
    const res = await reportApi.listActivity(windowDays.value, { silent: true })
    if (gen !== fetchGen) return
    series.value = res?.data ?? []
    stale.value = false
  } catch {
    if (gen !== fetchGen) return
    stale.value = true
  }
}

/** 切档：同档幂等跳过；窗口变了重取对应天数段（days 参数化，≤365 已备） */
function setWindow(weeks: number): void {
  if (windowWeeks.value === weeks) return
  windowWeeks.value = weeks
  void refresh()
}

onMounted(() => void refresh())
defineExpose({ refresh })

/** YYYY-MM-DD（服务器与浏览器同机部署，本地时区口径与服务端存档键一致） */
function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

interface HeatCell {
  date: string
  /** 色阶 0~4：0 = 无数据/零活动（缺行即空档），1~4 = 活跃度递增 */
  level: number
  /** today 方位锚（P-20261004-118）：描边 class + 悬停「今天」前缀共用 */
  isToday: boolean
  entry: ActivityDayEntry | null
}

// 色阶格子：窗口自起点对齐到周日（grid-auto-flow: column 每列一周，GitHub
// 版式），series 按日期建索引 O(1) 命中——逐格扫序列是 O(91×365) 反模式，
// 索引化后 O(91+365)。computed 只随 series/档位变化重算（天粒度数据非热路径；
// 52 周档上限 ~370 次步进，量级不变）
const cells = computed<HeatCell[]>(() => {
  const byDate = new Map(series.value.map(e => [e.date, e]))
  const end = new Date()
  const start = new Date(end)
  start.setDate(start.getDate() - (windowDays.value - 1))
  start.setDate(start.getDate() - start.getDay()) // 回退到周日

  let max = 0
  for (const e of series.value) {
    const s = activityScore(e)
    if (s > max) max = s
  }

  const out: HeatCell[] = []
  // today 按日期键标记而非「最后一格」位置判断：窗口档位切换（P-106）重算
  // 窗口起止后依旧成立，与 GitHub contribution graph 的 today 描边惯例同源
  const todayKey = dateKey(new Date())
  const cursor = new Date(start)
  while (cursor <= end) {
    const key = dateKey(cursor)
    const entry = byDate.get(key) ?? null
    // 归一：峰值等分 4 档；ceil 保证非零活动至少 1 级（零分/缺行 = 0 级）
    const level = activityLevel(activityScore(entry), max)
    out.push({ date: key, level, isToday: key === todayKey, entry })
    cursor.setDate(cursor.getDate() + 1)
  }
  return out
})

/** 窗口内三项合计（摘要行；缺行计零） */
const totals = computed(() => activityTotals(series.value))

/** 悬停明细：当日三项数值（无数据日显 0——空档与零活动同一口径）；today
 *  格前缀「今天」（P-20261004-118）与描边同码双通道——视觉环之外再给文字确认。
 *  可下钻格（有活动行）补点击提示后缀：cursor 之外的入口可发现性文字通道 */
function cellTitle(c: HeatCell): string {
  const params = {
    date: c.date,
    commits: c.entry?.commits ?? 0,
    sessions: c.entry?.sessions ?? 0,
    commands: c.entry?.commands ?? 0,
  }
  const base = c.isToday ? t('monitor.activity.tipToday', params) : t('monitor.activity.tip', params)
  return c.entry ? `${base} · ${t('monitor.activity.drillHint')}` : base
}

/** 格子点击下钻（P-20261004-96）：活动行是发报链当日在跑的旁路投影——有行
 *  才可能有日报存档。预检详情口（单日只读、点击级频次非热路径）：空列表弱提
 *  示不开面板——存档 14 天滚动保留，老格子存档可能已清退，不开空面板误导；
 *  预检失败不断言「无日报」（可能只是瞬时网络问题），照常下钻让面板自身的
 *  加载失败反馈兜底。零活动缺行日整条发报链未跑、必无档——不发请求直接弱提示 */
async function openDayReport(c: HeatCell): Promise<void> {
  if (!c.entry) {
    message.info(t('monitor.activity.noReportDay'))
    return
  }
  try {
    const res = await reportApi.dailyDetail(c.date, { silent: true })
    if ((res.data?.length ?? 0) === 0) {
      message.info(t('monitor.activity.noReportDay'))
      return
    }
  } catch {
    // 预检失败不拦截下钻（见函数头注记）
  }
  archiveStore.openAt(c.date)
}
</script>

<template>
  <article
    class="ahc-card"
    data-testid="monitor-activity-card"
  >
    <div class="ahc-head">
      <span
        class="ahc-dot"
        :class="{ 'is-stale': stale }"
      />
      <span class="ahc-kind">{{ t('monitor.activity.title') }}</span>
      <span
        v-if="stale"
        class="ahc-stale"
      >{{ t('monitor.activity.stale') }}</span>
      <!-- 窗口档位（P-20261004-106）：卡头三档分段钮，active 高亮即档位反馈；
           aria-pressed 供读屏，会话内记忆不落盘 -->
      <div
        class="ahc-windows"
        role="group"
        :aria-label="t('monitor.activity.windowTitle')"
        :title="t('monitor.activity.windowTitle')"
      >
        <button
          v-for="w in WINDOW_WEEK_LEVELS"
          :key="w"
          type="button"
          class="ahc-win-btn"
          :class="{ 'is-active': windowWeeks === w }"
          :data-testid="`monitor-activity-window-${w}`"
          :aria-pressed="windowWeeks === w"
          @click="setWindow(w)"
        >{{ t('monitor.activity.windowWeeks', { n: w }) }}</button>
      </div>
    </div>
    <!-- 横向自适应双态（P-20261004-106）：大屏卡宽 ≥ 网格自然宽时一屏尽览无
         滚动条；窄屏（单列 340px 起步列宽 < 52 周约 725px 自然宽）卡内横向滚动
         兜底——格子尺寸恒定不压缩（保持逐格可读可悬停），min-width 形态由
         fit-content 网格天然给出，滚动容器 max-width 收在卡片内不撑破墙格 -->
    <div class="ahc-scroll">
      <div
        class="ahc-grid"
        data-testid="monitor-activity-grid"
      >
        <span
          v-for="c in cells"
          :key="c.date"
          class="ahc-cell"
          :class="[`is-l${c.level}`, { 'is-today': c.isToday, 'is-drillable': !!c.entry }]"
          :data-date="c.date"
          :data-level="c.level"
          :title="cellTitle(c)"
          @click="openDayReport(c)"
        />
      </div>
    </div>
    <div class="ahc-foot">
      <span class="ahc-summary">{{ t('monitor.activity.summary', { ...totals, days: windowDays }) }}</span>
      <span class="ahc-legend">
        {{ t('monitor.activity.legendLess') }}
        <span class="ahc-cell is-l0" />
        <span class="ahc-cell is-l1" />
        <span class="ahc-cell is-l2" />
        <span class="ahc-cell is-l3" />
        <span class="ahc-cell is-l4" />
        {{ t('monitor.activity.legendMore') }}
      </span>
    </div>
  </article>
</template>

<style scoped>
/* 镜像 mon-card 卡片语言（值班大屏 .mon-wall 网格内消费），见文件头注释 */
.ahc-card {
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
.ahc-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.ahc-kind { font-size: 11px; font-weight: 600; color: var(--text-muted); flex-shrink: 0; }
.ahc-dot {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
  background: var(--accent-green);
}
.ahc-dot.is-stale { background: var(--accent-red); }
.ahc-stale { font-size: 11px; color: var(--accent-red); }

/* 窗口档位分段钮（卡头右侧）：11px 字号同卡头文案语言，active 用 accent-green
   淡染（同格子色阶派生方式，主题切换自适应）——色值零硬编码 */
.ahc-windows {
  margin-left: auto;
  display: inline-flex;
  gap: 2px;
  flex-shrink: 0;
}
.ahc-win-btn {
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1;
  padding: 3px 5px;
  cursor: pointer;
}
.ahc-win-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.ahc-win-btn.is-active {
  background: color-mix(in srgb, var(--accent-green) 18%, var(--bg-panel));
  color: var(--text-primary);
  border-color: color-mix(in srgb, var(--accent-green) 40%, var(--border-default));
}
.ahc-win-btn:focus-visible { outline: 1px solid var(--accent-green); outline-offset: 1px; }

/* 横向滚动兜底（P-20261004-106）：max-width 收在卡片内（flex 列子项不被
   网格自然宽撑破墙格），网格宽于容器时出横向滚动条、窄于时无感知 */
.ahc-scroll { overflow-x: auto; max-width: 100%; }

/* contribution graph 版式：每列一周（行=周日~周六），列宽定值——卡片网格
   340px 起步列宽下 13 周 + 图例可完整容纳；52 周档自然宽约 725px，超出即走
   .ahc-scroll 滚动兜底（格子不压缩，见模板双态注记） */
.ahc-grid {
  display: grid;
  grid-template-rows: repeat(7, 11px);
  grid-auto-flow: column;
  grid-auto-columns: 11px;
  gap: 3px;
  width: fit-content;
}
.ahc-cell {
  display: inline-block;
  width: 11px;
  height: 11px;
  border-radius: 2px;
  background: var(--bg-hover);
  /* 不可下钻显式基线（P-20261004-96）：不用 UA 初始值 auto——default 与
     is-drillable 的 pointer 构成显式二值语义（spec 按计算值断言区分） */
  cursor: default;
}
/* 色阶五档：全部由主题变量 color-mix 派生（--accent-green 向面板底色过渡），
   零硬编码色值——主题切换自适应，对比度域归主题治理脚本把关 */
.ahc-cell.is-l1 { background: color-mix(in srgb, var(--accent-green) 25%, var(--bg-panel)); }
.ahc-cell.is-l2 { background: color-mix(in srgb, var(--accent-green) 45%, var(--bg-panel)); }
.ahc-cell.is-l3 { background: color-mix(in srgb, var(--accent-green) 70%, var(--bg-panel)); }
.ahc-cell.is-l4 { background: var(--accent-green); }
/* today 方位锚（P-20261004-118）：contribution graph 惯例——13 周格海先定位
   今天再向左回溯。环色取半透明 currentColor（继承主题文字色，深浅主题自动
   反色），与绿色阶正交构成色弱可辨的第二编码；outline 不占布局，offset 1px
   恰落在 3px 格间距内不压邻格 */
.ahc-cell.is-today {
  outline: 1px solid color-mix(in srgb, currentColor 55%, transparent);
  outline-offset: 1px;
}
/* 可下钻格（P-20261004-96）：有活动行 = 发报链当日在跑、可能有日报可看——
   pointer + 悬停描边示可点（描边同 today 格 currentColor 派生法）；无活动行
   格不加此 class，落基线 default（见 .ahc-cell 注记）即「不可下钻」语义
   （弱提示在点击反馈） */
.ahc-cell.is-drillable { cursor: pointer; }
.ahc-cell.is-drillable:hover {
  outline: 1px solid color-mix(in srgb, currentColor 40%, transparent);
  outline-offset: 1px;
}

.ahc-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.ahc-summary { font-size: 11px; color: var(--text-muted); }
.ahc-legend {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  color: var(--text-muted);
}
.ahc-legend .ahc-cell { width: 9px; height: 9px; }
</style>
