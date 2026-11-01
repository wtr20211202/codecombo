<script setup lang="ts">
// 服务日志分区（P-20261008-15）：本机服务自身运行日志（DataDir/logs/ 按日滚动
// 文件）的应用内只读查看面——服务异常免登机 tail，手机/远程无 SSH 形态的排障
// 入口。日期下拉 + 尾部窗口 + 关键词过滤（服务端 q 过滤防前端拉全量）+ 刷新 +
// 复制/交给智能体（错误日志面板同族惯例：日志尾部贴给 agent 会话诊断服务问题，
// 装箱由 useAgentFix 的 fitByBytes/任务文件降级链既有承担）。
// 敏感面：服务端读侧默认遮蔽（token/口令赋值/云密钥→***，响应 masked 回显）；
// 过滤防抖 400ms——搜索框每键入一击触发一次窗口请求，防抖压成末值一发。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, NEmpty, NInput, NSelect, useMessage } from 'naive-ui'
import { CopyOutline, RefreshOutline, TerminalOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { useAgentFix } from '../../composables/useAgentFix'
import { copyText } from '../../utils/clipboard'
import { serverLogApi, type ServerLogTail } from '../../api/domains/system'

const { t } = useI18n()
const message = useMessage()
const { handToAgent } = useAgentFix()

// ── 状态 ──
const dates = ref<string[]>([])
const date = ref<string>('') // '' = 今日（服务端当日口径，与写侧滚动同域）
const query = ref('')
const tail = ref<ServerLogTail | null>(null)
const loading = ref(false)
const loadFailed = ref(false)

// 日期选项：顶部「今日」恒在（服务端缺省口径），其下为磁盘上的历史日期
const dateOptions = computed(() => [
  { label: t('monitor.serverLog.today'), value: '' },
  ...dates.value.map((d) => ({ label: d, value: d })),
])

const linesText = computed(() => (tail.value ? tail.value.lines.join('\n') : ''))
const hasContent = computed(() => !!tail.value && !tail.value.missing && tail.value.lines.length > 0)

// ── 拉取 ──
async function fetchTail(): Promise<void> {
  loading.value = true
  loadFailed.value = false
  try {
    const res = await serverLogApi.tail({ date: date.value || undefined, q: query.value.trim() || undefined })
    tail.value = res.data ?? null
  } catch {
    // 失败态就地呈现（axios 拦截器已弹全局 toast）；保旧数据避免闪空
    loadFailed.value = true
  } finally {
    loading.value = false
  }
}

async function fetchDates(): Promise<void> {
  try {
    const res = await serverLogApi.dates({ silent: true })
    dates.value = res.data ?? []
  } catch {
    // 清单失败降级为仅「今日」档（tail 仍可用）；不弹全局噪音
    dates.value = []
  }
}

function refresh(): void {
  void fetchTail()
  void fetchDates()
}

// 搜索防抖 400ms：每键入一击都会触发一次窗口请求（服务端过滤），防抖压成末值
let debounceTimer: ReturnType<typeof setTimeout> | null = null
watch(query, () => {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void fetchTail()
  }, 400)
})
watch(date, () => void fetchTail())

onMounted(() => {
  void fetchDates()
  void fetchTail()
})
onBeforeUnmount(() => {
  if (debounceTimer) clearTimeout(debounceTimer)
})

// ── 动作 ──
const copied = ref(false)
async function copyAll(): Promise<void> {
  const ok = await copyText(linesText.value)
  if (ok) {
    copied.value = true
    setTimeout(() => { copied.value = false }, 1500)
  } else {
    message.error(t('common.copyFailed'))
  }
}

// 交给智能体（错误日志面板 agent.fix 同族，专用 serverLog 上下文）：日志尾部
// 作为诊断详情发起修复会话——敏感值确认/装箱/任务文件降级/免项目发起全走
// handToAgent 既有链（诊断对象是服务进程，无项目上下文也可发起）
function fixWithAgent(): void {
  void handToAgent({
    kind: 'serverLog',
    date: tail.value?.date || date.value || '',
    detail: linesText.value,
  })
}
</script>

<template>
  <div
    class="svclog"
    data-testid="svclog"
  >
    <!-- 工具行：日期档 + 关键词过滤 + 刷新 -->
    <div class="svclog-toolbar">
      <NSelect
        v-model:value="date"
        size="tiny"
        :options="dateOptions"
        class="svclog-date"
        :aria-label="t('monitor.serverLog.dateLabel')"
        data-testid="svclog-date"
      />
      <NInput
        v-model:value="query"
        size="tiny"
        clearable
        :placeholder="t('monitor.serverLog.searchPlaceholder')"
        :aria-label="t('monitor.serverLog.searchPlaceholder')"
        class="svclog-search"
        data-testid="svclog-search"
      />
      <NButton
        size="tiny"
        quaternary
        :loading="loading"
        :aria-label="t('monitor.refresh')"
        data-testid="svclog-refresh"
        @click="refresh"
      >
        <template #icon>
          <RefreshOutline />
        </template>
        {{ t('monitor.refresh') }}
      </NButton>
    </div>

    <!-- 窗口状态注记：截尾/遮蔽/缺失/失败，一眼读出窗口口径 -->
    <div
      v-if="tail && !loadFailed"
      class="svclog-meta"
      data-testid="svclog-meta"
    >
      <span
        v-if="tail.truncated"
        class="svclog-chip svclog-chip-warn"
        data-testid="svclog-truncated"
      >{{ t('monitor.serverLog.truncated') }}</span>
      <span
        v-if="tail.masked"
        class="svclog-chip"
        :title="t('monitor.serverLog.maskedTip')"
        data-testid="svclog-masked"
      >{{ t('monitor.serverLog.masked') }}</span>
      <span class="svclog-count">{{ t('monitor.serverLog.lineCount', { n: tail.missing ? 0 : tail.lines.length }) }}</span>
    </div>

    <!-- 日志体：等宽终端样式（错误日志面板 console 色同族），单 pre 承载
         （≤1000 行整段渲染，无逐行组件树） -->
    <div
      class="svclog-body"
      data-testid="svclog-body"
    >
      <div
        v-if="loadFailed"
        class="svclog-empty"
      >
        <NEmpty :description="t('monitor.serverLog.loadFailed')" />
      </div>
      <div
        v-else-if="!tail"
        class="svclog-empty"
      >
        <NEmpty :description="t('monitor.serverLog.loading')" />
      </div>
      <div
        v-else-if="tail.missing"
        class="svclog-empty"
        data-testid="svclog-missing"
      >
        <NEmpty :description="t('monitor.serverLog.missing')" />
      </div>
      <div
        v-else-if="!hasContent"
        class="svclog-empty"
        data-testid="svclog-nohit"
      >
        <NEmpty :description="query.trim() ? t('monitor.serverLog.noMatch') : t('monitor.serverLog.empty')" />
      </div>
      <pre
        v-else
        class="svclog-lines"
        data-testid="svclog-lines"
      >{{ linesText }}</pre>
    </div>

    <!-- 动作行：复制 / 交给智能体 -->
    <div class="svclog-actions">
      <NButton
        size="tiny"
        quaternary
        :disabled="!hasContent"
        data-testid="svclog-copy"
        @click="copyAll"
      >
        <template #icon>
          <CopyOutline />
        </template>
        {{ copied ? t('console.errorCopied') : t('console.errorCopyRaw') }}
      </NButton>
      <NButton
        size="tiny"
        quaternary
        :disabled="!hasContent"
        :title="t('agent.fix.actionTitle')"
        data-testid="svclog-agent"
        @click="fixWithAgent"
      >
        <template #icon>
          <TerminalOutline />
        </template>
        {{ t('agent.fix.action') }}
      </NButton>
    </div>

    <p class="svclog-footnote">
      {{ t('monitor.serverLog.footnote') }}
    </p>
  </div>
</template>

<style scoped>
.svclog { display: flex; flex-direction: column; gap: var(--space-2); }
.svclog-toolbar { display: flex; align-items: center; gap: var(--space-2); }
.svclog-date { width: 170px; flex-shrink: 0; }
.svclog-search { flex: 1; min-width: 0; }
.svclog-meta { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.svclog-chip {
  font-size: var(--fs-meta-min, 11.5px);
  padding: 1px 6px;
  border-radius: 2px;
  color: var(--accent-blue-light);
  background: color-mix(in srgb, var(--accent-blue-light) 10%, transparent);
}
.svclog-chip-warn { color: var(--accent-yellow-warm); background: color-mix(in srgb, var(--accent-yellow-warm) 12%, transparent); }
.svclog-count { font-size: var(--fs-meta-min, 11.5px); color: var(--text-dim); }
.svclog-body {
  background: var(--bg-primary);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  min-height: 180px;
  max-height: 420px;
  overflow: auto;
}
.svclog-empty { display: flex; align-items: center; justify-content: center; min-height: 180px; }
.svclog-lines {
  margin: 0;
  padding: 8px var(--space-3);
  font-family: var(--font-mono, monospace);
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--text-secondary);
  white-space: pre;
  word-break: normal;
  /* 长行（病态转储行被服务端截尾后仍可能很宽）横向滚动不撑破面板 */
  min-width: max-content;
}
.svclog-actions { display: flex; justify-content: flex-end; gap: var(--space-2); }
.svclog-footnote { margin: 0; font-size: var(--fs-meta-min, 11.5px); color: var(--text-dim); }
</style>
