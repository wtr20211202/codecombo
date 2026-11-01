<script setup lang="ts">
// 安全事件审计日志（P-20261002-13）：SecuritySettings「审计日志」Tab 的表格体。
// 服务端时间倒序分页（GET /api/audit），只读——条目只含动作与元数据（时间/事件/
// 结果/IP/摘要），不含密码/令牌值/密钥材料。
// 工具条「导出 CSV」（P-20261003-66）：服务端当前保留窗口（可配，P-20261003-123）
// 全量转 CSV 附件下载。
// 行内过滤（P-20261003-131）：动作类型/结果两下拉（P-66 错误列表过滤同惯例族）
// ——无过滤走滚动加载；任一过滤生效改为一次拉取服务端单页上限
// （auditMaxLimit=500）窗口后纯前端过滤 + 客户端分页（此后改过滤零请求）。
// 过滤是查看面口径：主导出按钮保持服务端全窗口（留档默认全量，P-66 假设①）；
// 过滤生效时主按钮旁出现下拉副柄（P-20261007-2），菜单「导出当前过滤结果」
// 走参数化导出——服务端全窗口过滤，覆盖查看窗口之外的匹配行（500 窗口外
// 只有服务端过滤拿得到，副项即 P-131 窗口钳制的能力补全）
// 滚动加载（P-20261003-223）：无过滤视图近底续翻传键集游标（首页仍走旧
// offset=0 形态取回 nextCursor）——翻页间隙新增事件不重不漏；旧服务端无
// nextCursor 字段时视图静停在首页（回退兼容，不再深翻但功能不破）
import { computed, h, onMounted, ref, watch } from 'vue'
import { NAlert, NButton, NDataTable, NDropdown, NIcon, NPagination, NSelect, NSpin, NTag, NTooltip, useMessage } from 'naive-ui'
import type { DataTableColumns, SelectOption } from 'naive-ui'
import { ChevronDownOutline, DownloadOutline, RefreshOutline } from '@vicons/ionicons5'
import { auditApi, type AuditEvent } from '../../api/client'
import { useI18n } from '../../composables/useI18n'
import { formatDateTime } from '../../utils/git'

const { t, te } = useI18n()
const message = useMessage()

const PAGE_SIZE = 20
// 过滤窗口 = 服务端 List 单页钳制上限（server/api/system/audit.go auditMaxLimit），
// 两处须同值：超出窗口的更早条目服务端单次给不出，窗口注记据此如实声明覆盖面
const FILTER_WINDOW = 500

const loading = ref(false)
const events = ref<AuditEvent[]>([])
const total = ref(0)

// 键集游标续翻（P-20261003-223）：'' = 没有更多页（末页响应不带 nextCursor，
// 旧服务端响应同样不带——两种「到底」同口径收口在这一个空串哨兵上）
const nextCursor = ref('')
const loadingMore = ref(false)

// 审计写失败可见性（P-20261003-205）：响应顶面随列表同源返回——写失败是
// 尽力而为语义下的静默丢失（条目缺席不可见），计数让断链在此处显形；
// 每次拉取（续翻/过滤/刷新）顺带刷新，无需独立轮询
const writeFails = ref(0)
const lastWriteFail = ref('')

// 条数上限第二道闸（P-20261004-80）：服务端响应顶面透出的当前阈值——顶部
// 弱提示的同源数据面（不在前端硬编码，改阈值提示不漂移）；旧服务端无该
// 字段回落 0，弱提示不渲染（回退兼容惯例）
const maxEntries = ref(0)

// 过滤态：windowLoaded 标记 events 是否已持 500 窗口——过滤生效时若仍持
// 20 条小页先补拉一次窗口，之后改过滤条件/翻页零请求纯前端算
const filterAction = ref<string | null>(null)
const filterResult = ref<AuditEvent['result'] | null>(null)
const windowLoaded = ref(false)
const clientPage = ref(1) // 过滤态的客户端页（1 起页）

const filterActive = computed(() => filterAction.value !== null || filterResult.value !== null)

const filteredEvents = computed<AuditEvent[]>(() => {
  if (!filterActive.value) return events.value
  return events.value.filter((e) =>
    (filterAction.value === null || e.action === filterAction.value) &&
    (filterResult.value === null || e.result === filterResult.value),
  )
})

// 表格数据：滚动加载态 = 全部已加载条目；过滤态 = 匹配集的客户端页切片
const pagedEvents = computed<AuditEvent[]>(() => {
  if (!filterActive.value) return events.value
  const start = (clientPage.value - 1) * PAGE_SIZE
  return filteredEvents.value.slice(start, start + PAGE_SIZE)
})

// 拉取响应的共有顶面收口：列表页/计数/写失败/条数上限四面同源刷新
function applyResponse(res: Awaited<ReturnType<typeof auditApi.list>> | undefined, append: boolean) {
  const page = res?.data || []
  events.value = append ? [...events.value, ...page] : page
  total.value = res?.total || 0
  writeFails.value = res?.auditWriteFails || 0
  lastWriteFail.value = res?.auditLastWriteFail || ''
  maxEntries.value = res?.maxEntries || 0
}

// 首屏/刷新：首页沿用旧 offset=0 形态——非空满页响应即附 nextCursor
//（P-223 契约），一次请求同时拿到首屏与续翻锚点，旧服务端（无该字段）也同形
async function fetchFirst() {
  loading.value = true
  try {
    const res = await auditApi.list({ limit: PAGE_SIZE, offset: 0 })
    applyResponse(res, false)
    windowLoaded.value = false
    nextCursor.value = res?.nextCursor || ''
  } catch { /* 拦截器处理 */ } finally {
    loading.value = false
  }
}

// 滚动近底续翻：键集游标锚在上一页尾条目，头部新增事件不移动窗口（不重不漏）
async function fetchMore() {
  if (filterActive.value || loadingMore.value || !nextCursor.value) return
  loadingMore.value = true
  try {
    const res = await auditApi.list({ limit: PAGE_SIZE, cursor: nextCursor.value })
    applyResponse(res, true)
    nextCursor.value = res?.nextCursor || ''
  } catch { /* 拦截器处理 */ } finally {
    loadingMore.value = false
  }
}

function fetchWindow() {
  loading.value = true
  return auditApi.list({ limit: FILTER_WINDOW, offset: 0 })
    .then((res) => {
      applyResponse(res, false)
      windowLoaded.value = true
      nextCursor.value = ''
    })
    .catch(() => { /* 拦截器处理 */ })
    .finally(() => { loading.value = false })
}

// 过滤条件变化（含逐项清除）：一律回到首页；生效且未持窗口先补拉窗口，
// 全清则恢复滚动加载视图（重拉首页，此前表格持的是窗口数据）
watch([filterAction, filterResult], () => {
  clientPage.value = 1
  if (filterActive.value) {
    if (!windowLoaded.value) void fetchWindow()
  } else {
    void fetchFirst()
  }
})

function clearFilters() {
  filterAction.value = null
  filterResult.value = null
}

const exporting = ref(false)
const exportingFiltered = ref(false)

// blob 下载收口：客户端合成下载名（拦截器不透 Content-Disposition，claude
// 会话导出同款双保险）；数据面在服务端组装，前端不经手
function downloadCsv(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  message.success(t('audit.exportDone'))
}

// 主按钮：全窗口口径导出（P-66 设计不变——留档默认全量），过滤不收窄此路径
async function exportCsv() {
  if (exporting.value) return
  exporting.value = true
  try {
    const blob = await auditApi.exportCsv()
    downloadCsv(blob, `codecombo-audit-${new Date().toISOString().slice(0, 10)}.csv`)
  } catch { /* 拦截器处理 */ } finally {
    exporting.value = false
  }
}

// 过滤联动副项（P-20261007-2）：参数化导出 = 服务端全窗口过滤切片——唯一能
// 拿到前端 500 条查看窗口之外匹配行的路径（副项即 P-131 窗口钳制的能力补全）。
// 参数与行内过滤下拉同构传原值：未设维度不传键 = 服务端不过滤该维度
async function exportFiltered() {
  if (exportingFiltered.value) return
  exportingFiltered.value = true
  try {
    const params: { action?: string; result?: string } = {}
    if (filterAction.value) params.action = filterAction.value
    if (filterResult.value) params.result = filterResult.value
    const blob = await auditApi.exportCsv(Object.keys(params).length ? params : undefined)
    downloadCsv(blob, `codecombo-audit-${new Date().toISOString().slice(0, 10)}-filtered.csv`)
  } catch { /* 拦截器处理 */ } finally {
    exportingFiltered.value = false
  }
}

// 下拉副项菜单：单条 =「导出当前过滤结果」。文案带 {n}=查看窗口宽度，明示
// 「含窗口之外」防误读为「只导出表格里这 500 条中的匹配」
const exportFilterOptions = computed(() => [
  { label: t('audit.exportFilteredOption', { n: FILTER_WINDOW }), key: 'filtered' },
])

function refresh() {
  // 刷新回到头部：审计是倒序时间线，最新事件永远在头部（过滤态重拉 500 窗口）
  clientPage.value = 1
  if (filterActive.value) void fetchWindow()
  else void fetchFirst()
}

// 滚动容器近底检测：阈值留出余量，避免精准停在底边时漏触发下一页
function onScroll(e: Event) {
  const el = e.target as HTMLElement
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 24) void fetchMore()
}

function onPageChange(p: number) {
  // 过滤态分页是纯客户端切片，不发生请求
  clientPage.value = p
}

// 事件类型 i18n：action「点分式」（lock.unlock）与 audit.action.<嵌套键> 同构；
// 未知动作（未来服务端新增）回退原文，表格不出现空洞
function actionLabel(action: string): string {
  const key = `audit.action.${action}`
  return te(key) ? t(key) : action
}

// 动作类型下拉选项：从已加载列表里实际出现过的动作去重派生——不手工维护
// 动作注册表（服务端新增动作零漂移自动出现，缺键由 actionLabel 回退原文）；
// 窗口内没出现过的动作无过滤意义（选了必是空结果）。按 action 串排序保证序稳定
const actionOptions = computed<SelectOption[]>(() => {
  const seen = new Set<string>()
  for (const e of events.value) seen.add(e.action)
  return Array.from(seen).sort().map(a => ({ label: actionLabel(a), value: a }))
})

// 结果三值与后端 store.AuditResult* 常量同构，标签复用结果列 i18n
const RESULT_VALUES = ['success', 'failure', 'denied'] as const
const resultOptions = computed<SelectOption[]>(() =>
  RESULT_VALUES.map(r => ({ label: t(`audit.result.${r}`), value: r })),
)

// 警示条内的最近失败时刻：RFC3339 → 本地时区文本（formatDateTime 空串回退
// 空文本——计数与时刻同口记账，writeFails>0 时时刻理论上非空，此处仅兜底）
const lastFailText = computed(() => formatDateTime(lastWriteFail.value))

// 过滤态的客户端页数（滚动加载态无分页条——到底即止）
const pageCount = computed(() =>
  Math.max(1, Math.ceil(filteredEvents.value.length / PAGE_SIZE)),
)

function resultTagType(result: AuditEvent['result']): 'success' | 'error' | 'warning' {
  switch (result) {
    case 'success': return 'success'
    case 'failure': return 'error'
    default: return 'warning' // denied
  }
}

const columns = computed<DataTableColumns<AuditEvent>>(() => [
  {
    title: t('audit.colTime'), key: 'time', width: 150,
    render: r => h('span', { class: 'sc-audit-dim' }, formatDateTime(r.time)),
  },
  {
    title: t('audit.colAction'), key: 'action',
    render: r => h('div', { class: 'sc-audit-action' }, [
      h('span', null, actionLabel(r.action)),
      r.detail
        ? h('span', { class: 'sc-audit-detail', title: r.detail }, r.detail)
        : null,
    ]),
  },
  {
    title: t('audit.colResult'), key: 'result', width: 80,
    render: r => h(NTag, {
      size: 'small', bordered: false, type: resultTagType(r.result),
      'data-testid': 'audit-result',
    }, { default: () => t(`audit.result.${r.result}`) }),
  },
  {
    title: t('audit.colIp'), key: 'ip', width: 120,
    render: r => h('span', { class: 'sc-audit-dim' }, r.ip || '—'),
  },
  {
    // 请求关联短码（P-20261006-53）：与访问日志行尾 rid= / 响应头 X-Request-Id
    // 同值，跨面对齐「这条审计对应哪次请求」；后台/巡检条目无 rid 显占位符
    // （诚实空态，ip 列同惯例）。ErrorLogList 同款 data-testid 模式
    title: t('audit.colRid'), key: 'rid', width: 110,
    render: r => h('span', {
      class: 'sc-audit-dim',
      title: r.rid ? t('audit.ridTip') : undefined,
      'data-testid': 'audit-rid',
    }, r.rid || '—'),
  },
])

onMounted(fetchFirst)
</script>

<template>
  <div
    class="tab-section audit-pane"
    data-testid="audit-pane"
  >
    <p class="lock-now-desc">
      {{ t('audit.desc') }}
    </p>
    <!-- 条数上限弱提示（P-20261004-80）：保留语义 = 时间窗 AND 条数上限，
         诚实边界注记——超出上限时最早的条目先走；弱提示（次级灰字一行），
         非警示（容量闸是常态自保不是故障） -->
    <p
      v-if="maxEntries > 0"
      class="sc-audit-dim audit-cap-hint"
      data-testid="audit-cap-hint"
    >
      {{ t('audit.capacityHint', { n: maxEntries }) }}
    </p>
    <div class="audit-toolbar">
      <NTooltip>
        <template #trigger>
          <NButton
            size="tiny"
            quaternary
            :loading="loading"
            :aria-label="t('common.refresh')"
            data-testid="audit-refresh"
            @click="refresh"
          >
            <template #icon>
              <NIcon :component="RefreshOutline" />
            </template>
          </NButton>
        </template>
        {{ t('common.refresh') }}
      </NTooltip>
      <NTooltip>
        <template #trigger>
          <NButton
            size="tiny"
            quaternary
            :loading="exporting"
            :aria-label="t('audit.exportCsv')"
            data-testid="audit-export"
            @click="exportCsv"
          >
            <template #icon>
              <NIcon :component="DownloadOutline" />
            </template>
            {{ t('audit.exportCsv') }}
          </NButton>
        </template>
        {{ t('audit.exportCsvTip') }}
      </NTooltip>
      <!-- 过滤联动副项（P-20261007-2）：任一过滤生效时出现的下拉（主按钮旁
           的分体式副柄）——菜单单条「导出当前过滤结果」走参数化导出，服务端
           全窗口过滤覆盖查看窗口之外的匹配行；无过滤时不渲染（主按钮即唯一
           动作，零噪音）。native title 提示（不再套 NTooltip：NDropdown 与
           NTooltip 双 trigger 包装相互克隆事件易碎） -->
      <NDropdown
        v-if="filterActive"
        trigger="click"
        :options="exportFilterOptions"
        @select="exportFiltered"
      >
        <NButton
          size="tiny"
          quaternary
          :loading="exportingFiltered"
          :title="t('audit.exportFilteredTip')"
          :aria-label="t('audit.exportFilteredTip')"
          data-testid="audit-export-filtered"
        >
          <template #icon>
            <NIcon :component="ChevronDownOutline" />
          </template>
        </NButton>
      </NDropdown>
      <!-- 行内过滤（P-20261003-131）：动作类型/结果两下拉；placeholder 即语义
           （全部动作/全部结果），aria-label 补齐读屏语境 -->
      <NSelect
        v-model:value="filterAction"
        size="tiny"
        clearable
        :options="actionOptions"
        :placeholder="t('audit.filter.actionAll')"
        :aria-label="t('audit.filter.action')"
        class="audit-filter-select"
        data-testid="audit-filter-action"
      />
      <NSelect
        v-model:value="filterResult"
        size="tiny"
        clearable
        :options="resultOptions"
        :placeholder="t('audit.filter.resultAll')"
        :aria-label="t('audit.filter.result')"
        class="audit-filter-select"
        data-testid="audit-filter-result"
      />
      <NButton
        v-if="filterActive"
        size="tiny"
        quaternary
        :aria-label="t('audit.filter.clearTip')"
        data-testid="audit-filter-clear"
        @click="clearFilters"
      >
        {{ t('audit.filter.clear') }}
      </NButton>
      <span
        v-if="filterActive"
        class="sc-audit-dim audit-total"
        data-testid="audit-filter-count"
      >{{ t('audit.filter.filtered', { n: filteredEvents.length, total }) }}</span>
      <span
        v-else
        class="sc-audit-dim audit-total"
        data-testid="audit-total"
      >{{ t('audit.total', { n: total }) }}</span>
    </div>
    <!-- 窗口覆盖注记：总数超出 500 窗口时如实声明过滤只覆盖窗口内，
         防「匹配 0 条」被误读为「该类事件不存在」 -->
    <p
      v-if="filterActive && total > events.length"
      class="sc-audit-dim audit-window-note"
      data-testid="audit-filter-window"
    >
      {{ t('audit.filter.window', { n: events.length }) }}
    </p>
    <!-- 审计写失败警示（P-20261003-205）：Append 尽力而为语义下失败静默丢失
         （列表里缺席的条目不可见），计数让断链在此显形；title=条数+最近失败
         时刻，正文=恢复指引（检查磁盘/数据目录，修复后重启清零） -->
    <NAlert
      v-if="writeFails > 0"
      type="warning"
      :show-icon="true"
      class="audit-write-fails"
      data-testid="audit-write-fails"
      style="margin-bottom: 8px"
      :title="t('audit.writeFails', { n: writeFails, time: lastFailText })"
    >
      {{ t('audit.writeFailsTip') }}
    </NAlert>
    <!-- 滚动加载容器（P-20261003-223）：无过滤视图近底续翻传键集游标；过滤态
         容器仍在（客户端切片翻页同域滚动）但续翻守卫短路零请求 -->
    <div
      class="audit-scroll"
      data-testid="audit-scroll"
      @scroll.passive="onScroll"
    >
      <NDataTable
        size="small"
        :columns="columns"
        :data="pagedEvents"
        :loading="loading"
        :bordered="false"
        :row-key="(r: AuditEvent) => r.id"
      />
    </div>
    <div
      v-if="!loading && pagedEvents.length === 0"
      class="pane-empty"
    >
      {{ filterActive ? t('audit.filter.noMatch') : t('audit.empty') }}
    </div>
    <!-- 续翻中指示（无文案免 i18n；到底后 nextCursor 空串静停不再出现） -->
    <div
      v-if="loadingMore"
      class="audit-more-loading"
      data-testid="audit-more-loading"
    >
      <NSpin size="small" />
    </div>
    <div
      v-if="filterActive && pageCount > 1"
      class="audit-pagination"
    >
      <NPagination
        :page="clientPage"
        :page-count="pageCount"
        size="small"
        @update:page="onPageChange"
      />
    </div>
  </div>
</template>
