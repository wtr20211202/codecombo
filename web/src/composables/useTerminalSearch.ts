import { ref, computed, nextTick, watch } from 'vue'
import { NInput } from 'naive-ui'
import type { TermInstance } from './useTerminalInstances'
import { useSearchHistory } from './useSearchHistory'

export interface UseTerminalSearchParams {
  termInstances: Map<string, TermInstance>
  getActiveTabId: () => string
}

// 终端搜索查询历史（P-20261004-109）：接 P-48 泛化后的域无关 useSearchHistory，
// 声明终端自己的通道与容量——独立键与项目搜索历史（15 条）互不串味；环形 5 条
// 是终端搜索框窄（180px）的量级考量，下拉过长反而拥挤
const TERMINAL_HISTORY_KEY = 'terminal-search-history'
const TERMINAL_HISTORY_MAX = 5

export function useTerminalSearch(params: UseTerminalSearchParams) {
  const { termInstances, getActiveTabId } = params

  // 终端搜索状态（Ctrl+F 触发，作用于当前活动终端）
  const showSearch = ref(false)
  const searchQuery = ref('')
  const searchCaseSensitive = ref(false)
  const searchRegex = ref(false)
  const searchInputRef = ref<InstanceType<typeof NInput> | null>(null)

  // 搜索结果计数（buffer 内匹配总数）。null 表示未搜索（query 为空），0 表示未找到
  const searchResultCount = ref<number | null>(null)

  // 计算属性：是否未找到（用于输入框红框 + 显示 not found 文案）
  const searchNoResult = computed(
    () => searchResultCount.value !== null && searchResultCount.value === 0,
  )

  // ── 查询历史（P-20261004-109）：聚焦出下拉/前缀过滤补全/回填即搜，P-48 同惯例 ──
  // 记录时机 = 显式承诺点（Enter/上下导航 commitSearch、关闭搜索条 closeSearch）；
  // 逐键的实时搜索不记录——否则一个词的逐个前缀会把 5 条环形刷满
  const { history: queryHistory, recordQuery, filterByPrefix, clearHistory } =
    useSearchHistory({ storageKey: TERMINAL_HISTORY_KEY, maxHistory: TERMINAL_HISTORY_MAX })

  // 聚焦态 + 收起态分离（P-48 同款）：Esc/点选后本轮聚焦内不再自动弹出；
  // 点击输入框可重新唤出（@click 同 handler——已聚焦时 focus 事件不再触发）
  const historyFocused = ref(false)
  const historyDismissed = ref(false)
  const historyVisible = computed(() =>
    historyFocused.value && !historyDismissed.value && queryHistory.value.length > 0,
  )
  const historyItems = computed(() => filterByPrefix(searchQuery.value))
  // 输入前缀过滤全空时保留下拉给空态提示（「无匹配」也是反馈，静默消失像坏了）
  const historyAllFilteredOut = computed(() =>
    historyVisible.value && searchQuery.value.trim() !== '' && historyItems.value.length === 0,
  )

  function onSearchInputFocus(): void {
    historyFocused.value = true
    historyDismissed.value = false
  }
  function onSearchInputBlur(): void {
    historyFocused.value = false
  }
  function closeHistoryDropdown(): void {
    historyDismissed.value = true
  }
  function onClearHistory(): void {
    clearHistory()
    closeHistoryDropdown()
  }

  // 回填即搜：点选是明确意图，直接 runSearch 跳首个命中（输入框 @update:value 只
  // 在用户输入时触发，程序赋值不会，须显式补一发）。suppress 掉 watch(searchQuery)
  // 的重开——结果高亮即是反馈，不弹补全盖屏（ProjectSearch 同款标志位；值未变时
  // watch 不触发，标志位不会悬空误吞后续输入）
  let suppressHistoryReopen = false
  function applyHistory(term: string): void {
    if (searchQuery.value !== term) {
      suppressHistoryReopen = true
      searchQuery.value = term
    }
    closeHistoryDropdown()
    runSearch('next')
    // 焦点收回输入框（地址栏同惯例：点选建议后光标留框内，可继续改词/Esc 关条）。
    // 下拉项经 mousedown.prevent 已保焦点，但实测点选后焦点仍可能漂落 body——
    // 终端搜索条的 Esc 分层对焦点敏感（body 态 Esc 会命中布局级退链把底部面板
    // 一起收掉），此处显式拉回保证 Esc 语义确定
    searchInputRef.value?.focus()
  }

  watch(searchQuery, () => {
    if (suppressHistoryReopen) {
      suppressHistoryReopen = false
      return
    }
    // 手动编辑 → 补全重新可用（Esc 收起后一输入即恢复，浏览器地址栏同惯例）
    historyDismissed.value = false
  })

  // Esc 分层（P-48 同惯例）：下拉开着先收下拉，再按才关搜索条。焦点在输入框时
  // 布局级 Esc 链本就让位（useLayoutKeyboard 对 INPUT target 早退），无跨层双触发
  function onSearchEscape(): void {
    if (historyVisible.value) {
      closeHistoryDropdown()
      return
    }
    closeSearch()
  }

  /** 显式承诺的一次搜索（Enter/上下导航）：框内词入历史（去重置顶）再跳转 */
  function commitSearch(direction: 'next' | 'previous'): void {
    recordQuery(searchQuery.value)
    runSearch(direction)
  }

  // 扫描 buffer 统计匹配数：作为 findNext/findPrevious 的同步反馈
  // xterm SearchAddon 不暴露 onResultChange 事件，手动扫一遍最可靠
  function countMatches(
    query: string,
    opts: { caseSensitive: boolean; regex: boolean },
  ): number {
    const inst = termInstances.get(getActiveTabId())
    if (!inst || !query) return 0
    const buf = inst.term.buffer.active
    const lines: string[] = []
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i)
      if (line) lines.push(line.translateToString(true))
    }
    const text = lines.join('\n')
    let pattern: RegExp
    if (opts.regex) {
      try {
        pattern = new RegExp(query, opts.caseSensitive ? 'g' : 'gi')
      } catch {
        return -1 // 非法 regex
      }
    } else {
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      pattern = new RegExp(escaped, opts.caseSensitive ? 'g' : 'gi')
    }
    const matches = text.match(pattern)
    return matches ? matches.length : 0
  }

  // 在指定 tabId 上执行搜索：direction=next/previous
  // 默认用 getActiveTabId()，调用方可显式传 tabId（如刚切换 active 时的瞬时场景）
  function runSearch(direction: 'next' | 'previous', tabId?: string): void {
    const id = tabId ?? getActiveTabId()
    const inst = termInstances.get(id)
    if (!inst) return
    const q = searchQuery.value
    if (!q) {
      searchResultCount.value = null
      return
    }
    const opts = {
      caseSensitive: searchCaseSensitive.value,
      regex: searchRegex.value,
    }
    if (direction === 'next') {
      inst.search.findNext(q, opts)
    } else {
      inst.search.findPrevious(q, opts)
    }
    // 同步刷新计数（不依赖 addon 事件）
    searchResultCount.value = countMatches(q, opts)
  }

  // 预填查询词长度上限：长选区（拖选整行/多行）不该整段进输入框——查询框只有
  // 180px 宽，超长词既不可读也让 findNext 高亮刷屏。截断只影响预填默认值，
  // 用户仍可手输任意长度查询（全选态下敲击即整体替换）
  const PREFILL_MAX_CHARS = 200

  // 打开搜索框：自动 focus 输入框；终端有选区时以选区为查询词预填并立即首搜
  // （P-20261004-87，浏览器/VS Code「有选区 Ctrl+F 即搜选区」同款惯例）。
  // 选区读取时机安全：Ctrl+F 在 xterm attachCustomKeyEventHandler 内被拦截
  // （useTerminalKeys 返回 false 不再交 xterm 处理），打开动作不清选区，此处
  // 读到的就是按键瞬间的选区
  function openSearch(): void {
    const inst = termInstances.get(getActiveTabId())
    // 多行选区取首行（行内搜索语义：多行文本跨行匹配超出本搜索框的定位用途）；
    // 剥首尾空白后为空（纯空白/换行选区）视为无选区，走既有「空框打开」
    let prefilled = ''
    if (inst) {
      const sel = inst.term.getSelection()
      if (sel) {
        const firstLine = (sel.split(/\r?\n/)[0] ?? '').trim()
        if (firstLine) prefilled = firstLine.slice(0, PREFILL_MAX_CHARS)
      }
    }
    if (prefilled) searchQuery.value = prefilled
    showSearch.value = true
    nextTick(() => {
      searchInputRef.value?.focus()
      // 预填后全选输入框内容：继续敲击即整体替换预填词（浏览器同款细节），
      // 而非把新字符追加在词尾
      if (prefilled) searchInputRef.value?.select()
      // 预填打开不弹历史下拉（P-20261004-87 × P-20261004-109 交接）：「搜这个词」
      // 是单一意图，弹补全只会盖结果高亮，无匹配时的空态提示更是纯噪声。
      // focus() 同步触发 @focus 的唤出，此处在其后压回；点击输入框仍可重新唤出
      if (prefilled) historyDismissed.value = true
    })
    // 预填即首搜：打开动作是一次性事件，不走输入防抖直达结果（计数徽标同步
    // 刷新，同 runSearch 的既有同步口径）；预填词不入历史——commit/close
    // 承诺点兜底记录，免选中串未经搜索意图即进环形
    if (prefilled) runSearch('next')
  }

  function closeSearch(): void {
    // 关闭即本轮搜索终结：框内词入历史（recordQuery 自滤空白，空查询零副作用）
    recordQuery(searchQuery.value)
    showSearch.value = false
    searchResultCount.value = null
    const inst = termInstances.get(getActiveTabId())
    inst?.search.clearActiveDecoration()
    // 下拉态随搜索条卸载复位（v-if 移除不触发 blur，须显式清——ProjectSearch 同款）
    historyFocused.value = false
    historyDismissed.value = false
    suppressHistoryReopen = false
  }

  // 切换搜索选项后自动重新搜索
  function toggleSearchOption(key: 'caseSensitive' | 'regex', value: boolean): void {
    if (key === 'caseSensitive') searchCaseSensitive.value = value
    if (key === 'regex') searchRegex.value = value
    if (searchQuery.value) runSearch('next')
  }

  // 输入框 query 变化时刷新计数。debounce 200ms 避免每次按键都全 buffer 扫描
  // （万行 scrollback + 中速输入会卡顿）
  let countDebounceTimer: ReturnType<typeof setTimeout> | null = null
  function onQueryInput(): void {
    if (countDebounceTimer) clearTimeout(countDebounceTimer)
    if (!searchQuery.value) {
      searchResultCount.value = null
      return
    }
    countDebounceTimer = setTimeout(() => {
      searchResultCount.value = countMatches(searchQuery.value, {
        caseSensitive: searchCaseSensitive.value,
        regex: searchRegex.value,
      })
    }, 200)
  }

  return {
    showSearch,
    searchQuery,
    searchCaseSensitive,
    searchRegex,
    searchInputRef,
    searchResultCount,
    searchNoResult,
    runSearch,
    openSearch,
    closeSearch,
    toggleSearchOption,
    onQueryInput,
    historyVisible,
    historyItems,
    historyAllFilteredOut,
    onSearchInputFocus,
    onSearchInputBlur,
    closeHistoryDropdown,
    onClearHistory,
    applyHistory,
    onSearchEscape,
    commitSearch,
  }
}
