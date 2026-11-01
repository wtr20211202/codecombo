<script setup lang="ts">
// 日报历史回看面板（P-20261003-4）：14 天日报存档的两级视图——左列日期
// （列表口 reportApi.listDaily 归组），右列单日详情（详情口 reportApi.dailyDetail
// 点选即取，新补档案即点即现，渲染面在 DayDetailPane）。挂载于通知中心头部
// 入口（与通知中心同玻璃卡片形态）；聚合语义全在服务端。
// 周报草稿拼接（P-20261003-135）：日期行加多选勾选（Shift 点选成范围）→
// 底栏「拼接为周报草稿」→ 逐日详情口取数装配 WeeklyReportDay[] → 右区切换
// WeeklyDraftView 预览/复制/下载（合成纯函数 utils/weeklyReport）
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { NIcon, NEmpty, createDiscreteApi } from 'naive-ui'
import { CloseOutline, CalendarOutline } from '@vicons/ionicons5'
import { reportApi, type DailyReportEntry } from '../../api/domains/report'
import { useThemeStore } from '../../stores/theme'
import { useReportArchiveStore } from '../../stores/reportArchive'
import { useI18n } from '../../composables/useI18n'
import { hasBlockingOverlay } from '../../utils/overlayGuard'
import type { WeeklyReportDay } from '../../utils/weeklyReport'
import WeeklyDraftView from './WeeklyDraftView.vue'
import DayDetailPane from './DayDetailPane.vue'

const open = defineModel<boolean>('open', { default: false })
const themeStore = useThemeStore()
const archiveStore = useReportArchiveStore()
const { t } = useI18n()

// 离散 message（NotificationCenter 同范式）：加载失败的轻提示不依赖祖先
// NMessageProvider
const { message } = createDiscreteApi(['message'], {
  configProviderProps: computed(() => ({
    theme: themeStore.naiveTheme,
    themeOverrides: themeStore.naiveOverrides,
  })),
})

const loading = ref(false)
const dates = ref<string[]>([])
const selectedDate = ref('')
const detail = ref<DailyReportEntry[]>([])
const detailLoading = ref(false)

// 周报草稿多选（P-20261003-135）：勾选日期集合（保持面板窗口序）+ 草稿视图态
const selectedDates = ref<string[]>([])
const lastCheckIdx = ref(-1)
const draftMode = ref(false)
const draftDays = ref<WeeklyReportDay[]>([])
const draftLoading = ref(false)

// 列表口一次取满 14 天窗口（14 天 × 项目数 ≤ 服务端 200 钳制，单请求足用）；
// 按 date 归组倒序即左列（服务端已倒序，归组保持序）
async function loadDates(): Promise<void> {
  loading.value = true
  try {
    const res = await reportApi.listDaily(200)
    const seen = new Set<string>()
    const list: string[] = []
    for (const e of res.data || []) {
      if (!seen.has(e.date)) {
        seen.add(e.date)
        list.push(e.date)
      }
    }
    // 下钻聚焦（P-20261004-96）：格子点击带日期打开时选中该日而非最新日；
    // 上钻入口（预检详情口非空）已担保该日有档。有档也可能不在列表——200 行
    // 钳制下多项目窗口覆盖不足 14 天，此时并入列表保左列高亮可见（详情口按
    // 日期直取本就不依赖列表）
    const focus = archiveStore.focusDate
    if (focus && !list.includes(focus)) {
      list.push(focus)
      list.sort((a, b) => (a > b ? -1 : 1)) // YYYY-MM-DD 字典序 = 时间序，重排保持倒序
    }
    dates.value = list
    // 有聚焦优先选聚焦；否则默认选中最新日，上次选中日仍在窗口内则保持（重开不跳）
    const keep = selectedDate.value
    selectedDate.value = focus || (keep && list.includes(keep) ? keep : (list[0] ?? ''))
    // 周报勾选随窗口滚动修剪（滑出 14 天窗口的勾选失去数据面，不再保留）
    const alive = new Set(list)
    selectedDates.value = selectedDates.value.filter((d) => alive.has(d))
    if (selectedDate.value) void loadDetail(selectedDate.value)
    else detail.value = []
  } catch {
    message.error(t('report.archive.loadFailed'))
  } finally {
    loading.value = false
  }
}

// 详情口点选即取：空日返回空列表（服务端语义），按空态渲染
async function loadDetail(date: string): Promise<void> {
  detailLoading.value = true
  try {
    const res = await reportApi.dailyDetail(date)
    detail.value = res.data || []
  } catch {
    message.error(t('report.archive.loadFailed'))
    detail.value = []
  } finally {
    detailLoading.value = false
  }
}

function selectDate(date: string): void {
  if (date === selectedDate.value) return
  selectedDate.value = date
  void loadDetail(date)
}

// 勾选/取消一个日期；Shift+点击 = 自上次勾选位到本位的范围同设为本次态
// （「勾选日期范围」直接操作，14 格内逐格点选的替代）
function toggleDate(date: string, e: MouseEvent): void {
  const checked = (e.target as HTMLInputElement).checked
  const idx = dates.value.indexOf(date)
  const set = new Set(selectedDates.value)
  if (e.shiftKey && lastCheckIdx.value >= 0) {
    const lo = Math.min(lastCheckIdx.value, idx)
    const hi = Math.max(lastCheckIdx.value, idx)
    for (let i = lo; i <= hi; i++) {
      const d = dates.value[i]!
      if (checked) set.add(d)
      else set.delete(d)
    }
  } else if (checked) {
    set.add(date)
  } else {
    set.delete(date)
  }
  lastCheckIdx.value = idx
  selectedDates.value = dates.value.filter((d) => set.has(d))
}

// 拼接周报草稿：逐勾选日取详情口（升序 = YYYY-MM-DD 字典序，周报叙事惯例），
// 装配 WeeklyReportDay[]（实例级事实行取首条按 locale 拼好）。任一日取数失败
// 整体放弃回详情视图——宁可重试也不产出缺日的草稿（静默缺日比失败更误导）
async function buildWeekly(): Promise<void> {
  if (selectedDates.value.length === 0 || draftLoading.value) return
  draftMode.value = true
  draftLoading.value = true
  try {
    const datesAsc = [...selectedDates.value].sort()
    draftDays.value = await Promise.all(
      datesAsc.map(async (date) => {
        const res = await reportApi.dailyDetail(date)
        const entries = res.data || []
        const first = entries[0]
        return {
          date,
          projects: entries.map((e) => ({
            projectName: e.projectName,
            commits: e.commits,
            commitSubjects: e.commitSubjects,
            sessions: e.sessions,
            tokens: e.tokens,
            cmds: e.cmds,
          })),
          instanceLine: first
            ? `${t('report.archive.approvals')} ${t('report.archive.approvalsDetail', { done: first.approvalsDone, pending: first.approvalsPending })} · ${t('report.archive.deploys')} ${t('report.archive.deploysDetail', { ok: first.deploysOk, fail: first.deploysFail })}`
            : '',
        }
      }),
    )
  } catch {
    message.error(t('report.archive.loadFailed'))
    draftMode.value = false
  } finally {
    draftLoading.value = false
  }
}

watch(open, (v) => {
  if (v) {
    void loadDates()
    window.addEventListener('keydown', onWindowKeydown)
  } else {
    window.removeEventListener('keydown', onWindowKeydown)
  }
})

// 格子下钻再点（P-20261004-96）：面板已开时格子再点（换日即换详情、同日重选
// 即重取）由 seq 递增驱动在此重聚焦；关→开那次不在此消费——两 watcher 同批
// 触发时本 watcher 后注册后跑，彼时 loadDates 已置 loading，让位防详情重复
// 取数（开面板那次的聚焦由 loadDates 收口）。注册顺序须在 watch(open) 之后
watch(() => archiveStore.focusSeq, () => {
  if (!open.value || loading.value) return
  const d = archiveStore.focusDate
  if (!d) return
  if (!dates.value.includes(d)) {
    dates.value = [...dates.value, d].sort((a, b) => (a > b ? -1 : 1))
  }
  if (d !== selectedDate.value) selectDate(d)
})
onBeforeUnmount(() => window.removeEventListener('keydown', onWindowKeydown))

// Esc 关闭：与通知中心同惯例（面板此前只能点遮罩/×关闭）；有模态弹窗打开时让位。
// 草稿视图打开时 Esc 先退回详情视图（渐进收起），再按才关面板
function onWindowKeydown(e: KeyboardEvent) {
  if (!open.value || e.defaultPrevented || e.key !== 'Escape') return
  if (hasBlockingOverlay()) return
  e.preventDefault()
  if (draftMode.value) {
    draftMode.value = false
    return
  }
  open.value = false
}
</script>

<template>
  <transition name="rah-fade">
    <div
      v-if="open"
      class="rah-mask"
      @click.self="open = false"
    >
      <div
        class="rah-card glass-panel"
        data-testid="report-archive-panel"
        tabindex="0"
      >
        <!-- 头部 -->
        <div class="rah-header">
          <div class="rah-title">
            <n-icon
              size="14"
              class="rah-title-icon"
            >
              <CalendarOutline />
            </n-icon>
            <span>{{ t('report.archive.title') }}</span>
            <span class="rah-sub">{{ t('report.archive.subtitle') }}</span>
          </div>
          <button
            class="rah-close"
            :title="t('commandPalette.close')"
            @click="open = false"
          >
            <n-icon size="13">
              <CloseOutline />
            </n-icon>
          </button>
        </div>

        <!-- 左日期列（多选勾选供周报拼接）+ 右单日详情 / 周报草稿视图 -->
        <div class="rah-body">
          <div
            v-if="loading"
            class="rah-loading"
          >
            {{ t('report.archive.loading') }}
          </div>
          <template v-else-if="dates.length > 0">
            <div
              class="rah-dates"
              data-testid="report-archive-dates"
            >
              <div
                v-for="d in dates"
                :key="d"
                class="rah-date-row"
              >
                <input
                  type="checkbox"
                  class="rah-date-check"
                  :checked="selectedDates.includes(d)"
                  :data-testid="'report-archive-check-' + d"
                  :title="t('report.weekly.rangeHint')"
                  :aria-label="t('report.weekly.checkAria', { date: d })"
                  @click="toggleDate(d, $event)"
                >
                <button
                  class="rah-date"
                  :class="{ active: d === selectedDate }"
                  :data-testid="'report-archive-date-' + d"
                  @click="selectDate(d)"
                >
                  {{ d }}
                </button>
              </div>
            </div>
            <WeeklyDraftView
              v-if="draftMode"
              :days="draftDays"
              :loading="draftLoading"
              @back="draftMode = false"
            />
            <DayDetailPane
              v-else
              :detail="detail"
              :loading="detailLoading"
            />
          </template>
          <div
            v-else
            class="rah-empty"
            data-testid="report-archive-empty"
          >
            <n-empty
              size="small"
              :description="t('report.archive.empty')"
            />
          </div>
        </div>

        <!-- 底栏：周报拼接入口（P-20261003-135） -->
        <div
          v-if="dates.length > 0"
          class="rah-footer"
        >
          <span
            class="rah-count"
            data-testid="report-archive-selected-count"
          >
            {{ t('report.weekly.selected', { n: selectedDates.length }) }}
          </span>
          <button
            class="rah-build"
            data-testid="weekly-draft-build"
            :disabled="selectedDates.length === 0"
            @click="buildWeekly"
          >
            {{ t('report.weekly.action') }}
          </button>
        </div>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.rah-mask {
  position: fixed;
  inset: 0;
  z-index: 1100;
}

.rah-card {
  position: absolute;
  top: 48px;
  right: 12px;
  width: 640px;
  max-width: calc(100vw - 24px);
  max-height: 72vh;
  background: var(--bg-surface);
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  box-shadow: var(--shadow-strong);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.rah-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-default);
  background: linear-gradient(to bottom, var(--bg-elevated), var(--bg-surface));
  flex-shrink: 0;
}

.rah-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  min-width: 0;
}
.rah-title-icon { color: var(--brand-accent); }
.rah-sub {
  font-size: 10px;
  font-weight: 400;
  color: var(--text-muted);
}
.rah-close {
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
  color: var(--text-secondary);
  width: 24px;
  height: 24px;
  border-radius: 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all var(--motion-base);
}
.rah-close:hover {
  border-color: var(--brand-accent);
  color: var(--brand-accent);
  background: var(--brand-accent-soft);
}

.rah-body {
  flex: 1;
  display: flex;
  min-height: 0;
  overflow: hidden;
}

.rah-loading {
  padding: 24px 16px;
  text-align: center;
  color: var(--text-muted);
  font-size: 12px;
  width: 100%;
}

.rah-dates {
  width: 128px;
  flex-shrink: 0;
  border-right: 1px solid var(--border-default);
  overflow-y: auto;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
/* 日期行 = 周报勾选框（P-20261003-135）+ 单日详情按钮（原日期键） */
.rah-date-row {
  display: flex;
  align-items: center;
  gap: 2px;
}
.rah-date-check {
  flex-shrink: 0;
  width: 13px;
  height: 13px;
  margin: 0 0 0 4px;
  cursor: pointer;
  accent-color: var(--brand-accent);
}
.rah-date {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 11px;
  text-align: left;
  padding: 5px 6px;
  border-radius: 5px;
  cursor: pointer;
  transition: all var(--motion-fast);
}
.rah-date:hover { background: var(--bg-hover); color: var(--text-primary); }
.rah-date.active {
  background: var(--brand-accent-soft);
  color: var(--brand-accent);
  font-weight: 600;
}

.rah-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 30px 16px;
}

/* 底栏：周报拼接（P-20261003-135） */
.rah-footer {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid var(--border-default);
  background: linear-gradient(to bottom, var(--bg-surface), var(--bg-elevated));
}
.rah-count {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--text-muted);
}
.rah-build {
  border: 1px solid var(--brand-accent);
  background: var(--brand-accent-soft);
  color: var(--brand-accent);
  font-size: 11px;
  font-weight: 600;
  padding: 4px 12px;
  border-radius: 5px;
  cursor: pointer;
  transition: all var(--motion-base);
}
.rah-build:hover:not(:disabled) {
  filter: brightness(1.1);
}
.rah-build:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

/* 转场：通知中心同款 */
.rah-fade-enter-active,
.rah-fade-leave-active {
  transition: opacity var(--motion-base);
}
.rah-fade-enter-active .rah-card,
.rah-fade-leave-active .rah-card {
  transition: transform var(--motion-base), opacity var(--motion-base);
}
.rah-fade-enter-from,
.rah-fade-leave-to {
  opacity: 0;
}
.rah-fade-enter-from .rah-card,
.rah-fade-leave-to .rah-card {
  transform: translateY(-8px) scale(0.98);
  opacity: 0;
}
</style>
