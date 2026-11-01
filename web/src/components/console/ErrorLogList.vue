<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NEmpty, NButton, NInput, NScrollbar, useMessage } from 'naive-ui'
import { useI18n } from '@/composables/useI18n'
import { useAgentFix } from '@/composables/useAgentFix'
import { copyText } from '@/utils/clipboard'
import { retryErrorEntry } from '@/api/http'
import type { ErrorLogEntry, ErrorCategory } from '@/api/error-types'

const props = defineProps<{ entries: ErrorLogEntry[] }>()

const { t } = useI18n()
const message = useMessage()
const { handToAgent } = useAgentFix()
const expandedIds = ref<Set<string>>(new Set())
const copiedId = ref<string | null>(null)

// ── 过滤（P-20261002-62）：搜索框（消息/类别子串）+ 类别徽标点选 ──
// 展开态（expandedIds）与过滤解耦：被过滤隐藏的条目清空过滤后仍保持展开
const filterText = ref('')
const activeCategory = ref<ErrorCategory | null>(null)

const filterActive = computed(() => filterText.value.trim() !== '' || activeCategory.value !== null)

const filteredEntries = computed<ErrorLogEntry[]>(() => {
  if (!filterActive.value) return props.entries
  const kw = filterText.value.trim().toLowerCase()
  return props.entries.filter((e) => {
    if (activeCategory.value && e.category !== activeCategory.value) return false
    if (!kw) return true
    return (
      e.userMessage.toLowerCase().includes(kw) ||
      e.rawMessage.toLowerCase().includes(kw) ||
      e.category.toLowerCase().includes(kw) ||
      t(`errors.category.${e.category}`).toLowerCase().includes(kw)
    )
  })
})

function toggleCategory(c: ErrorCategory): void {
  activeCategory.value = activeCategory.value === c ? null : c
}

// 清空所有错误后残留的过滤条件会让新进错误「隐身」——entries 清零时复位过滤态
watch(() => props.entries.length, (n, o) => {
  if (n === 0 && o > 0) {
    filterText.value = ''
    activeCategory.value = null
  }
})

function toggle(id: string): void {
  if (expandedIds.value.has(id)) expandedIds.value.delete(id)
  else expandedIds.value.add(id)
  // 触发响应式更新
  expandedIds.value = new Set(expandedIds.value)
}

// 原地重试（P-20261003-179）：进行中条目 id 集合——按钮转「重试中…」并禁用防
// 连点；成功由 retryErrorEntry 就地标记 recoveredAt（重试钮让位已恢复标记），
// 失败由拦截器入新账 + toast，本处不重复反馈
const retryingIds = ref<Set<string>>(new Set())

async function retry(entry: ErrorLogEntry): Promise<void> {
  if (retryingIds.value.has(entry.id)) return
  retryingIds.value.add(entry.id)
  // 触发响应式更新（与 expandedIds 同款）
  retryingIds.value = new Set(retryingIds.value)
  try {
    await retryErrorEntry(entry)
  } finally {
    retryingIds.value.delete(entry.id)
    retryingIds.value = new Set(retryingIds.value)
  }
}

function catColorVar(c: ErrorCategory, kind: 'fg' | 'bg'): string {
  return `var(--error-cat-${c}-${kind})`
}

async function copyRaw(entry: ErrorLogEntry, ev: Event): Promise<void> {
  ev.stopPropagation()
  const ok = await copyText(entry.rawMessage)
  if (ok) {
    copiedId.value = entry.id
    setTimeout(() => {
      if (copiedId.value === entry.id) copiedId.value = null
    }, 1500)
  } else {
    message.error(t('common.copyFailed'))
  }
}

// 错误码徽标（P-20261005-153）：展开态透出结构化 code（原文旁小徽标），点击
// 复制码值——报障时可直接引用（agent/后端按 code 精确定位，免贴整段原文）
const copiedCodeId = ref<string | null>(null)

async function copyCode(entry: ErrorLogEntry, ev: Event): Promise<void> {
  ev.stopPropagation()
  if (!entry.code) return
  const ok = await copyText(entry.code)
  if (ok) {
    copiedCodeId.value = entry.id
    setTimeout(() => {
      if (copiedCodeId.value === entry.id) copiedCodeId.value = null
    }, 1500)
  } else {
    message.error(t('common.copyFailed'))
  }
}

// 交给智能体修复（P-20261002-109）：标题 = 请求行（method url → status）+ 友好
// 文案，详情 = 原始错误（shared 动作内做尾部摘要/字节适配/敏感值确认）；
// 附带 request-id（P-20261003-216）——智能体可据此 rid= 检索后端日志对齐同请求
function fixWithAgent(entry: ErrorLogEntry): void {
  const title = t('agent.fix.errorTitle', {
    method: entry.method,
    url: entry.url,
    status: entry.status === 0 ? 'ERR' : String(entry.status),
    message: entry.userMessage,
  })
  const detail = entry.requestId
    ? `${entry.rawMessage}\nrequest-id: ${entry.requestId}`
    : entry.rawMessage
  void handToAgent({ kind: 'error', title, detail })
}

function formatTime(ts: string): string {
  return ts ? new Date(ts).toLocaleTimeString() : ''
}
</script>

<template>
  <div class="errorlog-wrap">
    <!-- 过滤栏：小号搜索框 + 过滤态 n/总数计数（无记录时不渲染，空态保持干净） -->
    <div
      v-if="props.entries.length > 0"
      class="errorlog-filter-bar"
    >
      <n-input
        v-model:value="filterText"
        size="tiny"
        clearable
        :placeholder="t('errorlog.filter.searchPlaceholder')"
        class="errorlog-filter-input"
      />
      <span
        v-if="filterActive"
        class="errorlog-filter-count"
      >{{ filteredEntries.length }} / {{ props.entries.length }}</span>
    </div>
    <n-scrollbar class="errorlog-scroll">
      <div
        v-if="props.entries.length === 0"
        class="empty"
      >
        <n-empty :description="t('console.errorEmpty')" />
      </div>
      <div
        v-else-if="filteredEntries.length === 0"
        class="empty"
      >
        <n-empty :description="t('errorlog.filter.noMatch')" />
      </div>
      <div
        v-else
        class="log-list"
      >
        <div
          v-for="entry in filteredEntries"
          :key="entry.id"
          class="log-row"
          role="button"
          tabindex="0"
          :aria-expanded="expandedIds.has(entry.id)"
          :aria-label="t('console.errorItemExpand')"
          @click="toggle(entry.id)"
          @keydown.enter.prevent="toggle(entry.id)"
          @keydown.space.prevent="toggle(entry.id)"
        >
          <!-- 折叠态头部 -->
          <div class="log-head">
            <span class="time">{{ formatTime(entry.timestamp) }}</span>
            <!-- 类别徽标即过滤器：点击仅看该类别，再点取消（阻断行展开的点击/键盘冒泡） -->
            <button
              type="button"
              class="cat-badge"
              :class="{ active: activeCategory === entry.category }"
              :style="{
                color: catColorVar(entry.category, 'fg'),
                background: catColorVar(entry.category, 'bg'),
              }"
              :aria-pressed="activeCategory === entry.category"
              :title="t('errorlog.filter.badgeTip')"
              @click.stop="toggleCategory(entry.category)"
              @keydown.stop
            >
              {{ t(`errors.category.${entry.category}`) }}
            </button>
            <span class="method">{{ entry.method }}</span>
            <span class="url">{{ entry.url }}</span>
            <span
              class="status"
              :class="{ zero: entry.status === 0 }"
            >
              {{ entry.status === 0 ? '—' : entry.status }}
            </span>
            <!-- 请求关联 ID（P-20261003-216）：与后端日志 rid= 对齐的短码 -->
            <span
              v-if="entry.requestId"
              class="rid"
              data-testid="errorlog-request-id"
              :title="t('errorlog.requestIdTip')"
            >{{ entry.requestId }}</span>
            <!-- 原地重试（P-20261003-179）：仅幂等 GET 失败附带（entry.retry 由拦截器
                 挂载），行头直达免展开；成功转「已恢复」标记，重放失败由拦截器入新账 -->
            <button
              v-if="entry.retry && !entry.recoveredAt"
              type="button"
              class="retry-btn"
              data-testid="errorlog-retry"
              :disabled="retryingIds.has(entry.id)"
              :title="t('errorlog.retry.actionTip')"
              @click.stop="retry(entry)"
              @keydown.stop
            >
              {{ retryingIds.has(entry.id) ? t('errorlog.retry.retrying') : t('errorlog.retry.action') }}
            </button>
            <span
              v-else-if="entry.recoveredAt"
              class="recovered-badge"
              data-testid="errorlog-recovered"
              :title="t('errorlog.retry.recoveredTip', { time: formatTime(entry.recoveredAt) })"
            >{{ t('errorlog.retry.recovered') }}</span>
          </div>

          <!-- 友好文案 -->
          <div class="user-msg">
            {{ entry.userMessage }}
          </div>

          <!-- 展开后：原始错误 + code 徽标 + 复制按钮 -->
          <div
            v-if="expandedIds.has(entry.id)"
            class="raw-wrap"
          >
            <!-- 结构化错误码（P-20261005-153）：英文原文旁小徽标，点击复制供报障引用；
                 无 code（未迁移端点/网络层失败）不渲染，可见性即区分 -->
            <div
              v-if="entry.code"
              class="raw-meta"
            >
              <button
                type="button"
                class="code-badge"
                data-testid="errorlog-code-badge"
                :title="copiedCodeId === entry.id ? t('console.errorCopied') : t('errorlog.codeBadgeTip')"
                @click.stop="copyCode(entry, $event)"
                @keydown.stop
              >
                {{ copiedCodeId === entry.id ? t('errorlog.codeCopied') : entry.code }}
              </button>
            </div>
            <pre class="raw">{{ entry.rawMessage }}</pre>
            <div class="raw-actions">
              <n-button
                size="tiny"
                quaternary
                data-testid="errorlog-fix-agent"
                :title="t('agent.fix.actionTitle')"
                @click.stop="fixWithAgent(entry)"
              >
                {{ t('agent.fix.action') }}
              </n-button>
              <n-button
                size="tiny"
                quaternary
                @click="copyRaw(entry, $event)"
              >
                {{ copiedId === entry.id ? t('console.errorCopied') : t('console.errorCopyRaw') }}
              </n-button>
            </div>
          </div>

          <!-- 折叠态提示 -->
          <div
            v-else
            class="expand-hint"
          >
            {{ t('console.errorItemExpand') }}
          </div>
        </div>
      </div>
    </n-scrollbar>
  </div>
</template>

<style scoped>
.errorlog-wrap {
  display: flex;
  flex-direction: column;
  height: 100%;
}
/* 过滤栏：搜索框 + 过滤态计数 */
.errorlog-filter-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--console-row-divider);
}
.errorlog-filter-input {
  max-width: 240px;
}
.errorlog-filter-count {
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  white-space: nowrap;
}
.errorlog-scroll {
  flex: 1;
  min-height: 0;
}
.empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  min-height: 200px;
}
.log-list {
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
}
.log-row {
  padding: 8px 12px;
  border-bottom: 1px solid var(--console-row-divider);
  cursor: pointer;
}
.log-row:hover {
  background: var(--console-row-hover-bg);
}
.log-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.time { color: var(--text-muted); font-size: 11px; }
.cat-badge {
  padding: 1px 6px;
  font-size: 10px;
  border-radius: 2px;
  border: none;
  cursor: pointer;
  font-family: inherit;
  line-height: 1.6;
}
.cat-badge.active {
  outline: 1px solid currentColor;
}
.cat-badge:focus-visible {
  outline: 1px dashed currentColor;
}
.method { color: var(--accent-blue-light); }
.url { color: var(--text-body); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.status { color: var(--accent-red); }
.status.zero { color: var(--text-muted); }
.rid { color: var(--text-muted); font-size: 10px; }
/* 重试钮 / 已恢复标记：cat-badge 同族小尺寸，常态低调、hover 提亮 */
.retry-btn {
  padding: 1px 8px;
  font-size: 10px;
  border-radius: 2px;
  border: 1px solid var(--console-row-divider);
  background: transparent;
  color: var(--accent-blue-light);
  cursor: pointer;
  font-family: inherit;
  line-height: 1.6;
}
.retry-btn:hover:not(:disabled) {
  border-color: var(--accent-blue-light);
}
.retry-btn:disabled {
  color: var(--text-dim);
  cursor: default;
}
.retry-btn:focus-visible {
  outline: 1px dashed var(--accent-blue-light);
}
.recovered-badge {
  padding: 1px 6px;
  font-size: 10px;
  border-radius: 2px;
  color: var(--accent-green);
  background: color-mix(in srgb, var(--accent-green) 12%, transparent);
}
.user-msg {
  color: var(--text-secondary);
  font-size: 11px;
  margin-top: 4px;
  padding-left: 4px;
}
.expand-hint {
  color: var(--text-dim);
  font-size: 10px;
  margin-top: 4px;
  padding-left: 4px;
}
.raw-wrap {
  margin-top: 6px;
  background: var(--console-raw-bg);
  border-left: 2px solid var(--console-raw-border);
  padding: 6px 8px;
}
/* code 徽标行：原文上方独立一行，recovered-badge 同族小尺寸主题令牌配色 */
.raw-meta {
  margin-bottom: 4px;
}
.code-badge {
  padding: 1px 8px;
  font-size: 10px;
  border-radius: 2px;
  border: 1px solid var(--console-row-divider);
  background: color-mix(in srgb, var(--accent-blue-light) 10%, transparent);
  color: var(--accent-blue-light);
  cursor: pointer;
  font-family: inherit;
  line-height: 1.6;
}
.code-badge:hover {
  border-color: var(--accent-blue-light);
}
.code-badge:focus-visible {
  outline: 1px dashed var(--accent-blue-light);
}
.raw {
  color: var(--accent-red);
  font-family: inherit;
  font-size: 11px;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
}
.raw-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}
</style>
