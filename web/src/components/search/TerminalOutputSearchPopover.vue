<script setup lang="ts">
// 跨会话终端输出检索浮层（P-20261003-290）：命令面板「搜索终端输出」入口呼出。
// - 服务端 GET /api/terminals/search：遍历活会话扫最近输出（每会话 2000 行窗口，
//   单会话≤10 条、总量≤50），行文本已剥 ANSI、超长截窗——重活在服务端
// - 列表：会话名徽标 + 命中行 + 命中时间锚 → 点击 emit('jump')，宿主走
//   useApprovalActions jumpToSession 既有 activate-terminal 链路（切项目/开终端
//   面板/激活 tab；agent 会话归智能体面板）并携带命中查询词做会话内定位
//   （P-20261005-9：scrollToLine + 选区高亮，滚出缓冲降级提示）
// - 命中时间锚与时间档过滤（P-20261005-202）：每条命中标注所属命令的记账时刻
//   （terminalCommandTimes 的区间账：命中行文本锚反查到某条命令的输出行区间内
//   即取其 D 时刻；区间外/无账本如实显示「—」）；搜索框下时间档（全部/最近 1h/
//   今天/自定义起止）按该时刻缩范围——超档命中不消失而折叠计数（保底不误导
//   「搜不到」，点折叠行即回「全部」）
// - 与跨项目命令历史检索（TerminalHistorySearchPopover）不同域：那边查的是
//   OSC 133 落盘的命令文本，这边查的是会话 scrollback 原始输出
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NIcon, NInput, NEmpty, NSpin } from 'naive-ui'
import { SearchOutline, CloseOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { hasBlockingOverlay } from '../../utils/overlayGuard'
import { terminalApi, type TerminalOutputSearchHit } from '../../api/domains/terminal'
import {
  resolveHitCommandAt,
  outputTimeRange,
  inOutputTimeRange,
  type OutputTimeFilter,
  type OutputTimeCustom,
} from '../../composables/terminalCommandTimes'

const props = defineProps<{
  show: boolean
}>()

const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
  /** 点选命中项：宿主经 jumpToSession 既有链路激活该会话；query = 产出本批
   *  命中的查询词（P-20261005-9），落会话后据此做会话内定位 */
  (e: 'jump', sessionId: string, query: string): void
}>()

const { t } = useI18n()

// 查询词下限与后端 terminalOutputSearchMinRunes 对齐（客户端先挡，省一次 400）
const MIN_CHARS = 2

// 时间档清单（渲染序 = 档位序；标签走 i18n 键表）
const TIME_FILTERS: OutputTimeFilter[] = ['all', '1h', 'today', 'custom']
const TIME_FILTER_I18N: Record<OutputTimeFilter, string> = {
  all: 'terminal.history.outputTimeAll',
  '1h': 'terminal.history.outputTimeHour',
  today: 'terminal.history.outputTimeToday',
  custom: 'terminal.history.outputTimeCustom',
}

const query = ref('')
const hits = ref<TerminalOutputSearchHit[]>([])
// 产出当前 hits 的查询词快照：竞态守卫只采纳 query 匹配时的响应，但用户可能在
// 响应落地后继续改词（旧列表仍显示）——点选必须带「产出这批命中的词」而不是
// 输入框现值，否则定位词与命中行错位
const hitQuery = ref('')
const loading = ref(false)
const searched = ref(false)
const inputRef = ref<InstanceType<typeof NInput> | null>(null)

// ── 时间档过滤状态（P-20261005-202）：打开浮层即归「全部」（全新检索意图的
// 一部分——上轮的缩范围不该静默带进新一轮），自定义起止为 datetime-local 原文，
// 空串 = 该侧开放 ──
const timeFilter = ref<OutputTimeFilter>('all')
const customRange = ref<OutputTimeCustom>({ start: '', end: '' })

function setTimeFilter(f: OutputTimeFilter) {
  timeFilter.value = f
}

function resetTimeFilter() {
  timeFilter.value = 'all'
  customRange.value = { start: '', end: '' }
}

watch(() => props.show, (show) => {
  if (!show) return
  // 打开即全新检索意图：清空上轮查询与结果，焦点落搜索框
  query.value = ''
  hits.value = []
  hitQuery.value = ''
  searched.value = false
  resetTimeFilter()
  void nextTick(() => inputRef.value?.focus())
})

async function fetchHits() {
  const q = query.value.trim()
  if (q.length < MIN_CHARS) {
    hits.value = []
    searched.value = false
    return
  }
  loading.value = true
  try {
    const res = await terminalApi.searchOutput(q) as unknown as { data?: TerminalOutputSearchHit[] }
    // 竞态守卫：仅采纳最后一次查询的结果（快速连打时旧响应后到会覆盖新词）
    if (query.value.trim() === q) {
      hits.value = res.data || []
      hitQuery.value = q
      searched.value = true
    }
  } catch { /* silent：保留上次结果（已知错误由拦截器统一提示） */ }
  finally { loading.value = false }
}

// 搜索防抖 300ms（TerminalHistorySearchPopover 同参）
let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(query, () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(fetchHits, 300)
})

// ── 命中时间锚 + 档位过滤（量级：命中 ≤50 条/批，逐条文本锚定 = O(命中×缓冲拼扫)，
// 有账本的会话才真扫（无账本短路），computed 缓存到 hits/档位变化为止，非热路径）──
const anchoredHits = computed(() =>
  hits.value.map((hit) => ({ hit, at: resolveHitCommandAt(hit.sessionId, hit.lineText) })),
)
const activeRange = computed(() =>
  outputTimeRange(timeFilter.value, Date.now(), customRange.value),
)
// 「全部」恒显全量（无锚命中显示「—」是信息不是噪声）；缩档时无锚（at=null）
// 命中无法判档，随「档外」一并折叠（计数行如实回告，不悄悄消失）
const visibleHits = computed(() => {
  if (timeFilter.value === 'all') return anchoredHits.value
  return anchoredHits.value.filter((x) => x.at !== null && inOutputTimeRange(x.at, activeRange.value))
})
const collapsedCount = computed(() => {
  if (timeFilter.value === 'all') return 0
  return anchoredHits.value.length - visibleHits.value.length
})

/** 时间锚展示（本地钟）：当天 HH:mm、跨天补 MM-DD 前缀——手工 pad 不走
 *  toLocaleTimeString，断言与跨平台渲染形态稳定 */
function formatHitTime(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const now = new Date()
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate()
  return sameDay ? hm : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`
}

function close() {
  emit('update:show', false)
}

function jumpHit(hit: TerminalOutputSearchHit) {
  emit('jump', hit.sessionId, hitQuery.value)
  close()
}

// ── 键盘导航（BookmarkListPopover 同惯例）：↑↓ 环绕移动，Enter 跳转，Esc 关闭。
//  导航面 = 档内可见列表（折叠项不可达；点折叠行回「全部」恢复）──
const activeIdx = ref(-1)

watch([() => props.show, hits], ([show]) => {
  activeIdx.value = show && visibleHits.value.length > 0 ? 0 : -1
})

function moveActive(delta: number) {
  const n = visibleHits.value.length
  if (n === 0) return
  activeIdx.value = ((activeIdx.value + delta) % n + n) % n
  void nextTick(() => {
    document.querySelector('.tosearch-item.is-active')?.scrollIntoView({ block: 'nearest' })
  })
}

function onWindowKeydown(e: KeyboardEvent) {
  if (!props.show) return
  if (e.defaultPrevented) return // Layout 级已消费的 Esc（如退出最大化）不重复处理
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    moveActive(1)
    return
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    moveActive(-1)
    return
  }
  if (e.key === 'Enter' && activeIdx.value >= 0 && visibleHits.value[activeIdx.value]) {
    e.preventDefault()
    jumpHit(visibleHits.value[activeIdx.value]!.hit)
    return
  }
  if (e.key === 'Escape') {
    if (hasBlockingOverlay()) return
    e.preventDefault()
    close()
  }
}
onMounted(() => window.addEventListener('keydown', onWindowKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onWindowKeydown))
</script>

<template>
  <transition name="tosearch-fade">
    <div
      v-if="props.show"
      class="tosearch-mask"
      @click.self="close"
    >
      <div
        class="tosearch-card glass-panel"
        data-testid="terminal-output-search"
      >
        <div class="tosearch-header">
          <n-icon
            size="13"
            class="tosearch-icon"
          >
            <SearchOutline />
          </n-icon>
          <span class="tosearch-title">{{ t('terminal.history.outputTitle') }}</span>
          <button
            class="tosearch-close"
            :title="t('commandPalette.close')"
            @click="close"
          >
            <n-icon size="12">
              <CloseOutline />
            </n-icon>
          </button>
        </div>
        <div class="tosearch-input">
          <n-input
            ref="inputRef"
            v-model:value="query"
            size="small"
            clearable
            :placeholder="t('terminal.history.outputSearchPlaceholder')"
            :data-testid="'terminal-output-search-input'"
          />
        </div>
        <!-- 时间档过滤（P-20261005-202）：按命中所属命令的记账时刻缩范围；
             自定义档展开 datetime-local 起止（原生控件走平台本地时区语义，
             与「今天」档同一钟系） -->
        <div
          class="tosearch-timebar"
          data-testid="terminal-output-time-filter"
        >
          <button
            v-for="f in TIME_FILTERS"
            :key="f"
            class="tosearch-timechip"
            :class="{ 'is-active': timeFilter === f }"
            :data-testid="`terminal-output-time-${f}`"
            @click="setTimeFilter(f)"
          >
            {{ t(TIME_FILTER_I18N[f]) }}
          </button>
        </div>
        <div
          v-if="timeFilter === 'custom'"
          class="tosearch-timecustom"
        >
          <input
            v-model="customRange.start"
            type="datetime-local"
            class="tosearch-timeinput"
            :aria-label="t('terminal.history.outputTimeFromTitle')"
            :title="t('terminal.history.outputTimeFromTitle')"
            data-testid="terminal-output-time-start"
          >
          <span class="tosearch-timesep">–</span>
          <input
            v-model="customRange.end"
            type="datetime-local"
            class="tosearch-timeinput"
            :aria-label="t('terminal.history.outputTimeToTitle')"
            :title="t('terminal.history.outputTimeToTitle')"
            data-testid="terminal-output-time-end"
          >
        </div>
        <n-spin
          :show="loading"
          size="small"
          class="spin-fill"
        >
          <div class="tosearch-list">
            <div
              v-if="query.trim().length < MIN_CHARS"
              class="tosearch-hint"
            >
              {{ t('terminal.history.minCharsHint') }}
            </div>
            <n-empty
              v-else-if="searched && hits.length === 0"
              size="small"
              :description="t('terminal.history.empty')"
              class="tosearch-empty"
            />
            <template v-else>
              <button
                v-for="(item, idx) in visibleHits"
                :key="item.hit.sessionId + '-' + item.hit.hitIndex + '-' + idx"
                class="tosearch-item"
                :class="{ 'is-active': idx === activeIdx }"
                :data-testid="`terminal-output-hit-${idx}`"
                :title="item.hit.lineText"
                @click="jumpHit(item.hit)"
              >
                <div class="tosearch-item-main">
                  <div class="tosearch-item-line">
                    {{ item.hit.lineText }}
                  </div>
                  <div class="tosearch-item-meta">
                    <span class="tosearch-item-session">{{ item.hit.sessionName }}</span>
                    <span
                      class="tosearch-item-time"
                      :class="{ 'is-unknown': item.at === null }"
                      :title="t('terminal.history.outputTimeAnchorTip')"
                    >{{ item.at === null ? '—' : formatHitTime(item.at) }}</span>
                  </div>
                </div>
              </button>
              <!-- 档外折叠计数（P-20261005-202）：超档命中不消失——计数行如实回告
                   「不是搜不到是档外」，点击即回「全部」恢复全列表 -->
              <button
                v-if="collapsedCount > 0"
                class="tosearch-collapsed"
                :class="{ 'is-alone': visibleHits.length === 0 }"
                data-testid="terminal-output-search-collapsed"
                @click="resetTimeFilter"
              >
                {{ t('terminal.history.outputTimeOutside', { n: collapsedCount }) }}
              </button>
            </template>
          </div>
        </n-spin>
        <div class="tosearch-footnote">
          {{ t('terminal.history.outputFootnote') }}
        </div>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.tosearch-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
}
.tosearch-card {
  position: absolute;
  top: 80px;
  right: 16px;
  width: 480px;
  max-height: 70vh;
  background: var(--bg-surface);
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  box-shadow: var(--shadow-strong);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.tosearch-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-default);
  background: linear-gradient(to bottom, var(--bg-elevated), var(--bg-surface));
}
.tosearch-icon { color: var(--accent-orange); }
.tosearch-title { font-size: 12px; font-weight: 600; color: var(--text-primary); }
.tosearch-close {
  margin-left: auto;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.tosearch-close:hover { color: var(--text-primary); background: var(--bg-hover); }
.tosearch-input {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
}
.tosearch-timebar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
  flex-wrap: wrap;
}
.tosearch-timechip {
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-secondary);
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 999px;
  cursor: pointer;
  transition: background var(--motion-fast), color var(--motion-fast);
}
.tosearch-timechip:hover { background: var(--bg-hover); color: var(--text-primary); }
.tosearch-timechip.is-active {
  background: var(--bg-active);
  color: var(--text-primary);
  border-color: var(--border-default);
}
.tosearch-timecustom {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
}
.tosearch-timeinput {
  flex: 1;
  min-width: 0;
  background: var(--bg-panel);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  color: var(--text-body);
  font-size: 11px;
  font-family: var(--font-mono);
  padding: 3px 6px;
}
.tosearch-timeinput:focus {
  outline: none;
  border-color: var(--accent-orange);
}
.tosearch-timesep { color: var(--text-muted); font-size: 11px; }
.tosearch-list { flex: 1; overflow-y: auto; padding: 4px 0; }
.tosearch-hint, .tosearch-empty { padding: 24px 16px; text-align: center; font-size: 11px; color: var(--text-muted); }
.tosearch-item {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 5px 10px 5px 8px;
  border: none;
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background var(--motion-fast);
}
.tosearch-item:hover { background: var(--bg-hover); }
.tosearch-item.is-active,
.tosearch-item.is-active:hover { background: var(--bg-active); }
.tosearch-item-main { flex: 1; min-width: 0; }
.tosearch-item-line {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-body);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tosearch-item-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
  font-size: 10px;
  color: var(--text-muted);
  font-family: var(--font-mono);
}
.tosearch-item-session {
  color: var(--text-secondary);
  background: var(--bg-panel);
  border-radius: 6px;
  padding: 0 6px;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tosearch-item-time {
  color: var(--text-secondary);
  white-space: nowrap;
}
.tosearch-item-time.is-unknown { color: var(--text-dim); }
.tosearch-collapsed {
  display: block;
  width: calc(100% - 16px);
  margin: 2px 8px;
  padding: 6px 10px;
  border: 1px dashed var(--border-default);
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  font-size: 11px;
  text-align: center;
  cursor: pointer;
  transition: background var(--motion-fast), color var(--motion-fast);
}
.tosearch-collapsed.is-alone { margin-top: 24px; }
.tosearch-collapsed:hover { background: var(--bg-hover); color: var(--text-primary); }
.tosearch-footnote {
  padding: 5px 10px;
  font-size: 10px;
  color: var(--text-dim);
  border-top: 1px solid var(--border-subtle);
  flex-shrink: 0;
}
.tosearch-fade-enter-active,
.tosearch-fade-leave-active { transition: opacity var(--motion-base); }
.tosearch-fade-enter-active .tosearch-card,
.tosearch-fade-leave-active .tosearch-card { transition: transform var(--motion-base), opacity var(--motion-base); }
.tosearch-fade-enter-from,
.tosearch-fade-leave-to { opacity: 0; }
.tosearch-fade-enter-from .tosearch-card,
.tosearch-fade-leave-to .tosearch-card { transform: translateY(-8px) scale(0.98); opacity: 0; }
</style>
