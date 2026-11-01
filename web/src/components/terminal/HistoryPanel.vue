<script setup lang="ts">
import { computed, ref, watch, onMounted } from 'vue'
import { NButton, NIcon, NInput, NCheckbox, NEmpty, NSpin, NTooltip, NTabs, NTab, NSelect, useMessage } from 'naive-ui'
import {
  CloseOutline, CopyOutline, PlayOutline, TrashOutline,
  CheckmarkCircleOutline, CloseCircleOutline, TimeOutline, SaveOutline,
} from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { copyText } from '../../utils/clipboard'
import { terminalApi } from '../../api/client'
import { useTerminalSessionsStore } from '../../stores/terminal-sessions'
import { useRemoteHostStore } from '../../stores/remoteHost'
import {
  aggregateRepeatedCommands,
  REPEAT_COMMAND_MIN_COUNT, REPEAT_COMMAND_WINDOW_DAYS, REPEAT_COMMAND_TOP_N,
} from '../../utils/repeatCommands'
import SaveCodeSnippetModal from '../editor/SaveCodeSnippetModal.vue'

/**
 * 命令历史面板（C1）：侧板形式挂在终端区内。
 * - 搜索（包含匹配）+「只看失败」+「按会话过滤」下拉（P-20261004-35：多会话
 *   并行历史混流的解法，归属来自上报的 terminalId / CC_TERMINAL_ID 同源）
 * - 列表：命令 / 退出码徽章 / 时长 / 时间 → 点击插入终端（不执行，安全默认）；
 *   ▶ 副按钮插入并执行（P-20261003-61，重复命令一键重跑，与手敲回车同路径）
 * - 条目操作：复制 / 单条删除（免确认——低风险且可再输回；按 at 身份删
 *   防快照位移错删，P-20261003-63）
 * - 「重复命令」视图（P-20261003-199）：历史数据前端频次聚合（≥3 次/近 7 天/
 *   top 20，utils/repeatCommands 常量定档），展示次数 ×N 与最近使用时间，
 *   悬停「存为片段」复用片段创建链（SaveCodeSnippetModal kind=command）引导沉淀
 * - 远程条目（P-20261005-188）：source=input 输入域条目带主机徽标，退出码/
 *   时长显示「—」（输入域无此数据）；插入按当前会话形态分流——本面板宿主是
 *   项目终端（本地会话），远程条目只给复制不给直插（远程命令本地重跑必挂的
 *   误导防线；远程会话激活时可直插的分支归远程控制台域，今日无该宿主）
 * - 数据来自 OSC 133 E/D 事件链路（shellint 上报，敏感命令整条跳过）
 */
export interface HistoryEntry {
  command: string
  exitCode: number
  durationMs: number
  at: string
  /** 会话归属（P-20261004-35）：旧条目 / 未上报会话的条目缺省（未归属组） */
  terminalId?: string
  /** 条目来源（P-20261005-188）：'input'=输入域「提交的输入行」；缺省=osc 精确域 */
  source?: string
  /** 远程主机键（remote 条目附主机 id）：缺省=本地 */
  host?: string
}

const props = defineProps<{
  projectId: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'insert', command: string): void
  // ▶ 副按钮（P-20261003-61）：只上报命令原文，宿主负责追加 \r 执行——
  // 与运行书执行器同分工（面板给命令、宿主写入终端）
  (e: 'insertRun', command: string): void
}>()

const { t } = useI18n()
const message = useMessage()
// 会话名解读（下拉 label）：store 是本机会话唯一事实源，已关闭会话回落显示 id
const sessionsStore = useTerminalSessionsStore()
// 远程主机名解读（P-20261005-188 主机徽标）：store 缺数据时惰性拉一次，
// 失败静默——徽标回落显示主机 id（可辨识，不阻塞面板）
const hostStore = useRemoteHostStore()
onMounted(() => {
  if (hostStore.hosts.length === 0) void hostStore.fetch().catch(() => {})
})

/** 输入域条目（P-20261005-188）：source=input 的「提交的输入行」（远程采集） */
function isInputEntry(e: HistoryEntry): boolean {
  return e.source === 'input'
}

/** 主机键 → 展示名：store 有名用名，无名回落主机 id */
function hostLabel(e: HistoryEntry): string {
  if (!e.host) return ''
  return hostStore.hosts.find(h => h.id === e.host)?.name || e.host
}

// 视图页签：all=原始流水；repeat=频次聚合。两视图共用同一份未过滤全量
const view = ref<'all' | 'repeat'>('all')
const entries = ref<HistoryEntry[]>([])
const query = ref('')
const failedOnly = ref(false)
const loading = ref(false)

// 「未归属」下拉哨兵值：会话 id 为服务端生成（sc-*/term-* 形态），双下划线
// 包裹串不会与其撞车；空串留给「全部」
const UNATTRIBUTED = '__unattributed__'
const sessionFilter = ref('')

async function fetchHistory() {
  if (!props.projectId) return
  loading.value = true
  try {
    // 单次拉未过滤全量（≤500 条 LRU 有界，几十 KB），过滤全部前端算：
    // ①会话下拉需要全量才能枚举出历史中出现过的会话（含已关闭的）；
    // ②重复命令聚合同样要全量；③搜索/失败/会话过滤切换零请求即时响应。
    // 服务端 q/failedOnly/terminalId 参数保留给 API 直调方
    const res = await terminalApi.listHistory(props.projectId) as unknown as { data?: HistoryEntry[] }
    entries.value = res.data || []
  } catch { /* silent：保留上次结果 */ } finally {
    loading.value = false
  }
}

// 会话下拉选项：按 entries（服务端倒序）首次出现顺序 = 最近使用在前；
// 已关闭会话查不到名字回落显示 id；存在未归属条目才出「未归属」项
const sessionOptions = computed(() => {
  const ids: string[] = []
  let hasUnattributed = false
  for (const e of entries.value) {
    if (!e.terminalId) { hasUnattributed = true; continue }
    if (!ids.includes(e.terminalId)) ids.push(e.terminalId)
  }
  const opts = ids.map(id => ({
    label: sessionsStore.sessions.find(s => s.id === id)?.name || id,
    value: id,
  }))
  if (hasUnattributed) opts.push({ label: t('terminal.history.sessionUnattributed'), value: UNATTRIBUTED })
  return [{ label: t('terminal.history.sessionAll'), value: '' }, ...opts]
})

// 所选会话被 LRU 逐出/清空后下拉项消失：回落「全部」，不留死选项
watch(sessionOptions, (opts) => {
  if (sessionFilter.value && !opts.some(o => o.value === sessionFilter.value)) {
    sessionFilter.value = ''
  }
})

// all 视图展示集：q 包含匹配（大小写不敏感）+ 只看失败 + 会话归属过滤。
// O(≤500) 纯内存计算，随任一过滤条件即时重算（原服务端过滤的等价搬迁）
const filteredEntries = computed(() => {
  const q = query.value.trim().toLowerCase()
  return entries.value.filter((e) => {
    if (failedOnly.value && e.exitCode === 0) return false
    if (sessionFilter.value === UNATTRIBUTED && e.terminalId) return false
    if (sessionFilter.value && sessionFilter.value !== UNATTRIBUTED && e.terminalId !== sessionFilter.value) return false
    if (q && !e.command.toLowerCase().includes(q)) return false
    return true
  })
})

// 重复命令聚合：仅随 entries 重算（拉取/删除时），不做渲染期反复全量算
const repeatStats = computed(() => aggregateRepeatedCommands(entries.value))

async function clearAll() {
  try {
    await terminalApi.clearHistory(props.projectId)
    entries.value = []
    message.success(t('terminal.history.cleared'))
  } catch { /* 拦截器提示 */ }
}

function copyCommand(cmd: string) {
  void copyText(cmd)
    .then(ok => ok ? message.success(t('terminal.history.copied')) : message.error(t('terminal.history.copyFailed')))
}

// 插入分流（P-20261005-188）：远程输入域条目在本面板宿主（项目终端=本地会话）
// 只给复制不给直插——远程命令落进本地输入行等着被回车，正是「远程命令本地
// 重跑必挂」的误导源；复制后由用户自行贴回远程会话。（远程会话激活时可直插
// 的分支归远程控制台域宿主，今日无该宿主形态，规则先行注释在案）
async function insertEntry(e: HistoryEntry) {
  if (!isInputEntry(e)) {
    emit('insert', e.command)
    return
  }
  const ok = await copyText(e.command)
  if (ok) message.info(t('terminal.history.remoteCopyOnly'))
  else message.error(t('terminal.history.copyFailed'))
}

// 单条删除（免确认——低风险且可再输回）：按条目 at 身份删（服务端精确命中，
// 不受过滤/并发追加的下标位移影响）；失败时重拉对账（条目可能已被 LRU 逐出）
async function deleteEntry(i: number) {
  const target = filteredEntries.value[i]
  if (!target) return
  try {
    await terminalApi.deleteHistoryEntryAt(props.projectId, target.at)
    // 以身份过滤而非下标 splice：await 期间防抖搜索可能已整体重拉
    entries.value = entries.value.filter(e => e !== target)
    message.success(t('terminal.history.deleted'))
  } catch {
    /* 拦截器提示；重拉对账防陈旧快照 */
    void fetchHistory()
  }
}

// ── 存为片段（P-20261003-199）：SaveCodeSnippetModal kind=command 同一创建链 ──
const saveSnippetShow = ref(false)
const saveSnippetCmd = ref('')

function openSaveSnippet(cmd: string) {
  saveSnippetCmd.value = cmd
  saveSnippetShow.value = true
}

// 预填标题 = 命令首行按 rune 截 80（服务端 title 上限 120 留余量；Array.from
// 防增补平面字符被 UTF-16 code unit 切半）
function snippetTitlePrefill(cmd: string): string {
  const firstLine = cmd.split('\n')[0]!.trim()
  return Array.from(firstLine).slice(0, 80).join('')
}

function formatTime(at: string): string {
  try {
    return new Date(at).toLocaleTimeString()
  } catch { return at }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

onMounted(fetchHistory)
defineExpose({ refresh: fetchHistory })
</script>

<template>
  <aside class="history-panel">
    <div class="history-header">
      <span class="history-title">{{ t('terminal.history.title') }}</span>
      <div class="history-header-actions">
        <n-button
          size="tiny"
          quaternary
          :title="t('terminal.history.clear')"
          @click="clearAll"
        >
          <template #icon>
            <n-icon size="13">
              <TrashOutline />
            </n-icon>
          </template>
        </n-button>
        <n-button
          size="tiny"
          quaternary
          :title="t('common.close')"
          @click="emit('close')"
        >
          <template #icon>
            <n-icon size="13">
              <CloseOutline />
            </n-icon>
          </template>
        </n-button>
      </div>
    </div>

    <!-- 视图页签（P-20261003-199）：全部=原始流水 / 重复命令=频次聚合引导片段化 -->
    <n-tabs
      v-model:value="view"
      type="segment"
      size="small"
      class="history-view-tabs"
      data-testid="history-view-tabs"
    >
      <n-tab name="all">
        {{ t('terminal.history.viewAll') }}
      </n-tab>
      <n-tab name="repeat">
        {{ t('terminal.history.viewRepeat') }}
      </n-tab>
    </n-tabs>

    <div
      v-if="view === 'all'"
      class="history-filters"
    >
      <!-- 会话过滤（P-20261004-35）：多会话并行历史的归属隔离入口 -->
      <n-select
        v-model:value="sessionFilter"
        size="small"
        class="history-session-filter"
        :options="sessionOptions"
        :placeholder="t('terminal.history.sessionAll')"
        data-testid="history-session-filter"
      />
      <n-input
        v-model:value="query"
        size="small"
        :placeholder="t('terminal.history.searchPlaceholder')"
        clearable
      />
      <n-checkbox
        v-model:checked="failedOnly"
        size="small"
      >
        {{ t('terminal.history.failedOnly') }}
      </n-checkbox>
    </div>

    <n-spin
      :show="loading"
      size="small"
      class="spin-fill"
    >
      <div
        v-if="view === 'all'"
        class="history-list"
      >
        <n-empty
          v-if="filteredEntries.length === 0"
          :description="t('terminal.history.empty')"
          size="small"
          class="history-empty"
        />
        <div
          v-for="(e, i) in filteredEntries"
          :key="e.at"
          class="history-item"
          :class="{ 'is-failed': e.exitCode !== 0 }"
          data-testid="history-item"
          @click="insertEntry(e)"
        >
          <div
            class="history-item-cmd"
            :title="e.command"
          >
            {{ e.command }}
          </div>
          <div class="history-item-meta">
            <!-- 远程输入域条目（P-20261005-188）：主机徽标 + 退出码/时长位显示「—」
                 （输入域无此数据），来源语义悬停自明 -->
            <template v-if="isInputEntry(e)">
              <n-tooltip trigger="hover">
                <template #trigger>
                  <span
                    class="history-host"
                    data-testid="history-host-badge"
                  >{{ hostLabel(e) }}</span>
                </template>
                {{ t('terminal.history.inputDomainTip', { host: hostLabel(e) }) }}
              </n-tooltip>
              <span
                class="history-na"
                :title="t('terminal.history.inputDomainTip', { host: hostLabel(e) })"
              >—</span>
            </template>
            <template v-else>
              <n-tooltip
                trigger="hover"
                :disabled="e.exitCode === 0"
              >
                <template #trigger>
                  <span
                    class="history-exit"
                    :class="e.exitCode === 0 ? 'is-ok' : 'is-fail'"
                  >
                    <n-icon size="10">
                      <CheckmarkCircleOutline v-if="e.exitCode === 0" />
                      <CloseCircleOutline v-else />
                    </n-icon>
                    <!-- 成功只留 ✓（"0" 是噪音）；失败显示具体退出码 -->
                    <template v-if="e.exitCode !== 0">{{ e.exitCode }}</template>
                  </span>
                </template>
                {{ t('terminal.history.exitCode') }}: {{ e.exitCode }}
              </n-tooltip>
              <span class="history-dur"><n-icon size="10"><TimeOutline /></n-icon>{{ formatDuration(e.durationMs) }}</span>
            </template>
            <span class="history-time">{{ formatTime(e.at) }}</span>
            <span class="history-item-actions">
              <!-- ▶ 插入并执行（P-20261003-61）：显式副操作即执行（无危险命令特判，
                   与终端同责）；@click.stop 与主点击的纯插入事件隔离。远程输入域
                   条目不提供（本地会话分流：只复制不直插，P-20261005-188） -->
              <button
                v-if="!isInputEntry(e)"
                class="history-mini-btn is-run"
                :title="t('terminal.history.run')"
                @click.stop="emit('insertRun', e.command)"
              >
                <n-icon size="12"><PlayOutline /></n-icon>
              </button>
              <button
                class="history-mini-btn"
                :title="t('terminal.history.copy')"
                @click.stop="copyCommand(e.command)"
              >
                <n-icon size="12"><CopyOutline /></n-icon>
              </button>
              <button
                class="history-mini-btn is-danger"
                :title="t('terminal.history.delete')"
                @click.stop="deleteEntry(i)"
              >
                <n-icon size="12"><TrashOutline /></n-icon>
              </button>
            </span>
          </div>
        </div>
      </div>

      <!-- 重复命令视图（P-20261003-199）：频次 top N + 最近使用时间 + 存为片段引导 -->
      <div
        v-else
        class="history-list"
      >
        <n-empty
          v-if="repeatStats.length === 0"
          :description="t('terminal.history.repeatEmpty', { days: REPEAT_COMMAND_WINDOW_DAYS, min: REPEAT_COMMAND_MIN_COUNT })"
          size="small"
          class="history-empty"
        />
        <div
          v-for="s in repeatStats"
          :key="s.command"
          class="history-item"
          :title="s.command"
          @click="emit('insert', s.command)"
        >
          <div class="history-item-cmd">
            {{ s.command }}
          </div>
          <div class="history-item-meta">
            <span
              class="history-count"
              data-testid="history-repeat-count"
              :title="t('terminal.history.runCount', { n: s.count })"
            >×{{ s.count }}</span>
            <span class="history-time">{{ t('terminal.history.lastUsed') }} {{ formatTime(s.lastUsedAt) }}</span>
            <span class="history-item-actions">
              <!-- 存为片段（创建链复用）：主点击仍是插入的安全默认，存片段是显式副操作 -->
              <button
                class="history-mini-btn is-snippet"
                :title="t('terminal.history.saveSnippet')"
                data-testid="history-save-snippet"
                @click.stop="openSaveSnippet(s.command)"
              >
                <n-icon size="12"><SaveOutline /></n-icon>
              </button>
              <button
                class="history-mini-btn"
                :title="t('terminal.history.copy')"
                @click.stop="copyCommand(s.command)"
              >
                <n-icon size="12"><CopyOutline /></n-icon>
              </button>
            </span>
          </div>
        </div>
      </div>
    </n-spin>

    <div class="history-footnote">
      {{ view === 'repeat'
        ? t('terminal.history.repeatFootnote', { days: REPEAT_COMMAND_WINDOW_DAYS, min: REPEAT_COMMAND_MIN_COUNT, n: REPEAT_COMMAND_TOP_N })
        : t('terminal.history.footnote') }}
    </div>

    <!-- 存为片段弹窗：与编辑器同一创建链（kind=command，标题预填命令首行） -->
    <SaveCodeSnippetModal
      v-model:show="saveSnippetShow"
      kind="command"
      :content="saveSnippetCmd"
      :initial-title="snippetTitlePrefill(saveSnippetCmd)"
    />
  </aside>
</template>

<style scoped>
.history-panel {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 360px;
  max-width: 60%;
  z-index: 25;
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
  border-left: 1px solid var(--border-default);
  box-shadow: var(--shadow-pop-drawer);
}
.history-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
}
.history-title { font-size: 13px; font-weight: 600; color: var(--text-primary); }
.history-header-actions { display: flex; gap: 2px; }
/* 视图页签（全部/重复命令）：SnippetManager kind 页签同款 segment 形态 */
.history-view-tabs { padding: 6px 10px 0; flex-shrink: 0; }
.history-filters {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
}
.history-filters .n-input { flex: 1; }
/* 会话过滤下拉：固定窄宽给搜索框让位；label 过长由 n-select 自身省略号兜底 */
.history-session-filter { width: 104px; flex-shrink: 0; }
.history-list { flex: 1; overflow-y: auto; padding: 4px 0; }
.history-empty { margin-top: 40px; }
.history-item {
  padding: 6px 10px;
  cursor: pointer;
  border-left: 2px solid transparent;
}
.history-item:hover { background: var(--bg-hover); }
.history-item.is-failed { border-left-color: var(--accent-red); }
.history-item-cmd {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  color: var(--text-body);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.history-item-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
  font-size: 10px;
  color: var(--text-muted);
  font-family: var(--font-mono, monospace);
}
.history-exit { display: inline-flex; align-items: center; gap: 2px; font-weight: 600; }
.history-exit.is-ok { color: var(--accent-green); }
.history-exit.is-fail { color: var(--accent-red); }
/* 远程输入域条目（P-20261005-188）：主机徽标沿 thsearch-item-proj 同款胶囊形态，
   「—」占位弱灰（无数据不可样式化为成功/失败） */
.history-host {
  display: inline-flex; align-items: center;
  color: var(--text-secondary);
  background: var(--bg-panel);
  border-radius: 6px; padding: 0 6px;
  max-width: 40%;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.history-na { color: var(--text-dim); }
/* 重复命令视图的频次徽章（×N）：数字即语义，色彩沿主题 accent */
.history-count {
  display: inline-flex; align-items: center;
  font-weight: 600; color: var(--accent-orange);
  background: var(--bg-panel); border-radius: 6px; padding: 0 6px;
}
.history-dur, .history-time { display: inline-flex; align-items: center; gap: 2px; }
.history-item-actions { margin-left: auto; display: inline-flex; gap: 4px; opacity: 0; transition: opacity var(--motion-base); }
.history-item:hover .history-item-actions { opacity: 1; }
.history-mini-btn {
  display: inline-flex; align-items: center;
  border: none; background: none; cursor: pointer;
  color: var(--text-dim); padding: 1px 3px; border-radius: 3px;
}
.history-mini-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.history-mini-btn.is-ai { color: var(--brand-accent); }
.history-mini-btn.is-danger:hover { color: var(--accent-red); }
.history-footnote {
  padding: 5px 10px;
  font-size: 10px;
  color: var(--text-dim);
  border-top: 1px solid var(--border-subtle);
  flex-shrink: 0;
}
</style>
