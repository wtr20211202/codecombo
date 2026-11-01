import { ref, reactive, computed, watch, type Ref } from 'vue'
import * as monaco from 'monaco-editor'
import type { MessageApi } from 'naive-ui'
import { diffApi } from '../api/client'
import { claudeApi, type ClaudeSessionInfo, type ClaudeSessionsAt } from '../api/domains/claude'
import { useProjectStore } from '../stores/project'
import { useCommitLocate } from './useCommitLocate'
import { useEditorAskAgent } from './useEditorAskAgent'
import type { useI18n } from './useI18n'

/**
 * Monaco blame 内联注释族（P-20261003-301 自 MonacoEditor.vue 原样搬运）：
 * 开关 + 拉取（含 P-20261002-65 上一版导航）+ 作者配色装饰 + 注入文本左右键
 * 分流（左键定位提交 / 右键项目内菜单）+ 悬停提交摘要卡（P-20261003-318，
 * 卡片展示面在 EditorBlameTools，含 P-20261007-11 溯源区）+ 溯源点击的回放
 * 直达状态（弹层实例在宿主挂）。装饰走 after 注入文本车道，与书签的
 * glyphMargin、gutter 变更条的 linesDecorations 互不冲突。纯搬运不改逻辑；
 * editor 实例经 getEditor 迟后取用（onMounted 创建后才非空），路径/项目经
 * getter 读取实时值。
 *
 * 右键菜单「询问智能体此行来历」（P-20261004-40）：菜单第三项把右键行的注解
 * 条目+行内容上交 useEditorAskAgent.askAgentAboutBlameLine 拼装发起（同
 * useEditorSnippets → useEditorAskAgent 的组合式间复用先例），本模块只供数据。
 */

/** Git Blame 内联显示 */
export interface BlameEntry {
  hash: string
  author: string
  date: string
  /** 原始 ISO 时间：悬停摘要卡完整时间戳用（date 为注入文本的本地 YYYY-MM-DD 形态） */
  rawDate: string
  summary?: string
  line: number
}

/** 悬停卡溯源区（P-20261007-11）单 hash 查询态：payload=null = 查询中/失败未回填 */
export interface BlameTraceState {
  loading: boolean
  failed: boolean
  payload: ClaudeSessionsAt | null
}

export interface EditorBlameDeps {
  getEditor: () => monaco.editor.IStandaloneCodeEditor | null
  getPath: () => string
  projectStore: ReturnType<typeof useProjectStore>
  t: ReturnType<typeof useI18n>['t']
  message: MessageApi
  /** 悬停卡 DOM 元素迟后取用器（卡片在 EditorBlameTools 内，tele 到 body）：
   *  editor mouseleave 落点守卫（P-20261007-11）判 relatedTarget 是否在卡内 */
  getPopEl: () => HTMLElement | null
}

export function useEditorBlame(deps: EditorBlameDeps) {
  const { getEditor, getPath, projectStore, t, message, getPopEl } = deps
  const { requestCommitLocate } = useCommitLocate()
  // 行来历询问发起链（P-20261004-40）：setup 期解析一次（内部 useI18n 依赖
  // 组件实例，事件回调期再取会直接抛错）
  const { askAgentAboutBlameLine } = useEditorAskAgent()

  const showBlame = ref(false)
  const blameLoading = ref(false)
  const blameData = ref<BlameEntry[]>([])
  const blameDecorations = ref<string[]>([])
  // 当前 blame 视图的引用（P-20261002-65 上一版导航）：'' = 工作树当前态，
  // 非空（形如 "8位短hash^"）= 历史视图，注解区以面包屑标记可退回
  const blameRef = ref('')

  async function toggleBlame() {
    showBlame.value = !showBlame.value
    if (showBlame.value) {
      await loadBlame()
    } else {
      hideBlamePop()
      blameDecorations.value = getEditor()?.deltaDecorations(blameDecorations.value, []) || []
      blameData.value = []
      blameRef.value = ''
    }
  }

  async function loadBlame(ref = '') {
    if (!projectStore.currentProjectId || !getPath()) return
    blameLoading.value = true
    try {
      const res: any = await diffApi.blame(projectStore.currentProjectId, getPath(), ref || undefined)
      const lines: any[] = res.data || []
      blameData.value = lines.map((l: any) => ({
        hash: (l.hash || l.sha || '').substring(0, 8),
        author: l.author || '',
        // 后端字段为 lineNo（兼容旧 line）；行号为 0 会让 decoration Range 非法被静默吞掉
        line: l.lineNo ?? l.line ?? 0,
        date: formatBlameDate(l.date),
        rawDate: typeof l.date === 'string' ? l.date : '',
        summary: l.summary || '',
      }))
      blameRef.value = ref
      // 数据换视图（开关重开/上一版导航重拉）即收旧卡——条目引用已失效；
      // 溯源缓存随视图数据同清（同 hash 在不同视图的悬停语义不变，但缓存跟随
      // 一次 blame 生命周期最简，不设独立上限）
      hideBlamePop()
      blameTraceStates.clear()
      applyBlameDecorations()
    } catch (e) {
      // 不再完全静默： blame 失败曾因静默吞错无从排查，Console 留痕不打扰用户
      console.error('blame load failed', e)
      // 上一版视图拉取失败（根提交无父提交、ref 失效等）就地提示；当前态失败
      // 保持既有静默口径。失败不写 blameRef——面包屑与数据停留在原视图
      if (ref) message.warning(t('blame.prev.failed'))
    } finally {
      blameLoading.value = false
    }
  }

  // ISO 时间 → YYYY-MM-DD；零值/无效返回空串
  function formatBlameDate(v: unknown): string {
    const s = typeof v === 'string' ? v : ''
    if (!s || s.startsWith('0001-01-01')) return ''
    const d = new Date(s)
    if (isNaN(d.getTime())) return ''
    // 本地时区字段拼接（toISOString 取 UTC 日期，UTC+N 凌晨的提交会偏移一天）
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }

  function applyBlameDecorations() {
    const editor = getEditor()
    if (!editor || !showBlame.value || blameData.value.length === 0) return
    // 按作者分组的颜色调色板（基于 brand 色系）
    const authorColors = [
      'var(--accent-blue)',
      'var(--accent-green)',
      'var(--accent-orange)',
      'var(--accent-purple)',
      'var(--accent-red)',
      'var(--accent-yellow-warm)',
    ]
    // 动态注入 CSS 规则：每个作者一个 inline class
    ensureBlameStyles(authorColors)
    const authorMap = new Map<string, string>()
    let colorIdx = 0
    const decorations: monaco.editor.IModelDeltaDecoration[] = []
    let prevHash = ''
    for (const b of blameData.value) {
      if (!authorMap.has(b.author)) {
        const idx = colorIdx % authorColors.length
        authorMap.set(b.author, `blame-author-${idx}`)
        colorIdx++
      }
      const className = authorMap.get(b.author)!
      // 仅在每段提交首行显示完整信息
      const isHead = b.hash !== prevHash
      prevHash = b.hash
      decorations.push({
        range: new monaco.Range(b.line, 1, b.line, 1),
        options: {
          // 零长度区间默认被折叠丢弃；showIfCollapsed 保证注入文本渲染。
          // 注意：不可加 isWholeLine——整行装饰会吞掉 after 注入文本的行内渲染
          showIfCollapsed: true,
          after: {
            content: isHead ? `  ${b.hash} ${b.author} ${b.date}` : `  ${b.hash}`,
            // sc-blame-ref 供点击检测识别（作者色 class 随作者数动态变化）；
            // inlineClassName 在本版本为单字符串，多类以空格拼接
            inlineClassName: `sc-blame-ref ${className}`,
            cursorStops: monaco.editor.InjectedTextCursorStops.None,
          },
        },
      })
    }
    blameDecorations.value = editor.deltaDecorations(blameDecorations.value, decorations)
  }

  // 注入 blame 颜色样式（仅注入一次）
  let blameStylesInjected = false
  function ensureBlameStyles(colors: string[]) {
    if (blameStylesInjected) return
    const style = document.createElement('style')
    style.id = 'blame-author-styles'
    let css = ''
    colors.forEach((c, i) => {
      css += `.blame-author-${i} { color: ${c}; font-style: italic; opacity: 0.7; margin-left: 24px; }\n`
    })
    css += '.sc-blame-ref { cursor: pointer; }\n'
    style.textContent = css
    document.head.appendChild(style)
    blameStylesInjected = true
  }

  /** 从 mouse target 提取 blame 注入文本携带的 8 位短 hash（左键定位/右键菜单共用）。
   *  Monaco 公开 d.ts 未标注 detail.injectedText，但运行时 mouseTarget 对
   *  CONTENT_TEXT 恒填充该字段（含 options.content/inlineClassName）——按
   *  sc-blame-ref 类识别 blame 注入，内容首 token 即 8 位短 hash */
  function blameHashFromTarget(target: monaco.editor.IMouseTarget): string {
    if (target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT) return ''
    const detail = target.detail as {
      injectedText?: { options?: { content?: string; inlineClassName?: string } }
    } | undefined
    const injected = detail?.injectedText
    if (!injected) return ''
    const cls = injected.options?.inlineClassName || ''
    if (!cls.split(/\s+/).includes('sc-blame-ref')) return ''
    return (injected.options?.content || '').trim().split(/\s+/)[0] || ''
  }

  /** blame 注入文本左键点击 → 底部 Git 面板定位对应提交（F3）。
   *  仅左键触发；右键由 handleBlameContextMenu 接管为项目内菜单 */
  function handleBlameClick(e: monaco.editor.IEditorMouseEvent) {
    if (!showBlame.value || !e.event.leftButton) return
    const hash = blameHashFromTarget(e.target)
    if (!/^[0-9a-f]{7,40}$/i.test(hash)) return
    requestCommitLocate(hash)
  }

  // ── blame 悬停提交摘要卡（P-20261003-318）──
  // 复用 sc-blame-ref mouse target 识别（与左键定位/右键菜单同款路径），300ms
  // 悬停延迟后以 NPopover 手动定位显示提交摘要卡（Summary + 完整时间戳 + 作者）。
  // 纯只读展示：不拦截点击/右键（移出即隐，按下也隐）；触摸设备无持续 hover
  // 语义不启用——tap 合成的单次 mousemove 只会短暂排队，随下一次按下/移动即隐
  const BLAME_POP_SHOW_DELAY = 300
  const blamePopShow = ref(false)
  const blamePopX = ref(0)
  const blamePopY = ref(0)
  const blamePopEntry = ref<BlameEntry | null>(null)
  let blamePopTimer: ReturnType<typeof setTimeout> | null = null
  let blamePopPending: { entry: BlameEntry; x: number; y: number } | null = null

  /** blame 注入文本 mousemove → 延迟弹提交摘要卡。热路径：非 blame 目标在
   *  blameHashFromTarget 内 O(1) 短路，命中段才做一次 blameData 线性查 */
  function handleBlameHover(e: monaco.editor.IEditorMouseEvent) {
    // 触摸不启用：pointerType 可判时直接短路；拖拽/按压中选择中不弹卡
    const pointerType = (e.event.browserEvent as PointerEvent | undefined)?.pointerType
    if (pointerType === 'touch' || e.event.buttons !== 0) {
      hideBlamePop()
      return
    }
    if (!showBlame.value) {
      hideBlamePop()
      return
    }
    const hash = blameHashFromTarget(e.target)
    if (!/^[0-9a-f]{7,40}$/i.test(hash)) {
      hideBlamePop()
      return
    }
    // hash 定位所属段数据：段内各行服务端富化同 hash/作者/摘要——段首徽标与
    // 连续行裸 hash 悬停同卡
    const entry = blameData.value.find(b => b.hash === hash)
    if (!entry) {
      hideBlamePop()
      return
    }
    if (blamePopShow.value && blamePopEntry.value?.hash === entry.hash) {
      return // 已展示同段卡：段内移动不重置（不闪卡）
    }
    const x = e.event.browserEvent.clientX
    const y = e.event.browserEvent.clientY
    if (blamePopTimer) clearTimeout(blamePopTimer)
    blamePopPending = { entry, x, y }
    blamePopTimer = setTimeout(() => {
      if (!blamePopPending) return
      const shown = blamePopPending.entry
      blamePopEntry.value = shown
      blamePopX.value = blamePopPending.x
      blamePopY.value = blamePopPending.y
      blamePopPending = null
      blamePopTimer = null
      blamePopShow.value = true
      // 溯源区数据随卡弹出拉取（每 hash 缓存一次，见 loadBlameTrace）
      void loadBlameTrace(shown)
    }, BLAME_POP_SHOW_DELAY)
  }

  /** 移出 blame 注入文本/按下/离开编辑器立即隐藏——悬停即读、移出即隐 */
  function hideBlamePop() {
    if (blamePopTimer) {
      clearTimeout(blamePopTimer)
      blamePopTimer = null
    }
    blamePopPending = null
    blamePopShow.value = false
  }

  // ── blame 悬停溯源区（P-20261007-11）：blame 行提交时刻 × Claude 会话时间窗 ──
  // 卡内「该时段活跃会话」区：卡弹出即以行提交时刻查 sessions-at（项目级
  // transcript 时间窗匹配，服务端接近度排序），命中列出候选会话，点击直达回放
  // 弹层并定位到提交时刻（SessionReplayModal focusAt 既有链）。诚实边界：时段
  // 关联非因果确证——同窗并行会话全部列出由人判断，零命中显式空态不猜。
  // 展示面在 EditorBlameTools（traceState/traceVisible props + trace-replay 上抛）
  const blameTraceStates = reactive(new Map<string, BlameTraceState>())
  const traceReplaySession = ref<ClaudeSessionInfo | null>(null)
  const traceReplayFocusAt = ref('')

  /** 当前卡对应提交的溯源态（卡切换即随 hash 切换，互不串数据） */
  const blameTraceState = computed(() =>
    blamePopEntry.value ? blameTraceStates.get(blamePopEntry.value.hash) : undefined,
  )

  /** 溯源区可见性：行有有效提交时间才显示（零值时间戳=git 元数据缺失，不猜） */
  const blameTraceVisible = computed(() => {
    const d = blamePopEntry.value?.rawDate || ''
    return !!d && !d.startsWith('0001-01-01')
  })

  /** 卡弹出后按提交时刻查溯源（每 hash 一次缓存：段内同提交多行悬停零重查；
   *  blame 视图重拉时随 blameData 清空）。失败也缓存——悬停路径重查风暴比
   *  「切 blame 开关重试」更扰人 */
  async function loadBlameTrace(entry: BlameEntry) {
    const ts = entry.rawDate
    if (!ts || ts.startsWith('0001-01-01')) return
    if (!projectStore.currentProjectId || blameTraceStates.has(entry.hash)) return
    blameTraceStates.set(entry.hash, { loading: true, failed: false, payload: null })
    try {
      const res: any = await claudeApi.sessionsAt(projectStore.currentProjectId, ts)
      blameTraceStates.set(entry.hash, {
        loading: false,
        failed: false,
        payload: res?.data ?? { sessions: [], total: 0, truncated: false },
      })
    } catch {
      blameTraceStates.set(entry.hash, { loading: false, failed: true, payload: null })
    }
  }

  /** 溯源条目点击 → 回放弹层直达并按提交时刻定位（focusAt=最近早于该时刻的
   *  条目呼吸高亮，审批卡「查看回放」同链）。弹层实例由宿主（MonacoEditor）挂 */
  function openTraceReplay(s: ClaudeSessionInfo) {
    traceReplayFocusAt.value = blamePopEntry.value?.rawDate || ''
    hideBlamePop()
    traceReplaySession.value = s
  }

  /** 指针从编辑器移出时：落点在悬停卡内则不收卡——溯源条目要可点击（卡 tele
   *  到 body，editor mouseleave 的 relatedTarget 即卡内元素；移出卡由卡自身
   *  mouseleave 收口，EditorBlameTools 上抛 pop-hide）。onMouseLeave 的形参是
   *  IPartialEditorMouseEvent（target 可空），比 IEditorMouseEvent 弱一档，
   *  不能复用其签名 */
  function handleEditorMouseLeave(e: monaco.editor.IPartialEditorMouseEvent) {
    const related = (e.event.browserEvent as MouseEvent | undefined)?.relatedTarget
    if (related instanceof Node && getPopEl()?.contains(related)) return
    hideBlamePop()
  }

  // ── blame 上一版导航（P-20261002-65）：徽标右键 → 看上一版 ──
  const blameMenuShow = ref(false)
  const blameMenuX = ref(0)
  const blameMenuY = ref(0)
  const blameMenuHash = ref('')
  // 右键行号（P-20261004-40）：段内多行共用同 hash，「询问此行来历」要定位
  // 右键那一行而非段首
  const blameMenuLine = ref(0)

  const blameMenuOptions = computed(() => [
    { key: 'prev', label: t('blame.prev.action') },
    { key: 'locate', label: t('blame.prev.locate') },
    { key: 'ask', label: t('blame.ask.action') },
  ])

  /** blame 注入文本右键 → 项目内菜单（看上一版/定位提交/询问此行来历）。
   *  Monaco 对注入文本本就放行浏览器原生菜单（ContextMenuController 对
   *  CONTENT_TEXT + injectedText 直接 return），在此 preventDefault 拦截接管 */
  function handleBlameContextMenu(e: monaco.editor.IEditorMouseEvent) {
    if (!showBlame.value) return
    const hash = blameHashFromTarget(e.target)
    if (!/^[0-9a-f]{7,40}$/i.test(hash)) return
    e.event.preventDefault()
    e.event.stopPropagation()
    blameMenuHash.value = hash
    // 注入文本挂在行尾，target.position 即右键所在行（异常缺失回落 0，
    // select 期精确行匹配失败再回落段首条目）
    blameMenuLine.value = e.target.position?.lineNumber ?? 0
    blameMenuX.value = e.event.browserEvent.clientX
    blameMenuY.value = e.event.browserEvent.clientY
    blameMenuShow.value = true
  }

  function onBlameMenuSelect(key: string) {
    blameMenuShow.value = false
    if (!/^[0-9a-f]{7,40}$/i.test(blameMenuHash.value)) return
    if (key === 'locate') {
      requestCommitLocate(blameMenuHash.value)
      return
    }
    if (key === 'prev') void loadBlame(`${blameMenuHash.value}^`)
    if (key === 'ask') {
      // 右键行精确匹配优先（同段各行 author/date 相同，行内容取本行才对位）；
      // 行号缺失/数据已重拉漂移时回落段首条目（悬停卡同款段级口径）
      const line = blameMenuLine.value
      const entry = blameData.value.find(b => b.hash === blameMenuHash.value && b.line === line)
        ?? blameData.value.find(b => b.hash === blameMenuHash.value)
      if (!entry) return
      // 行内容取编辑器当前模型（行内容与所见一致即所问）；注解拉取后文件又被
      // 改短时行号可能越界（Monaco 对非法行号抛错），越界按空行处理不阻断发起
      const model = getEditor()?.getModel()
      const content = model && entry.line >= 1 && entry.line <= model.getLineCount()
        ? model.getLineContent(entry.line)
        : ''
      void askAgentAboutBlameLine({
        path: getPath(),
        line: entry.line,
        content,
        hash: entry.hash,
        author: entry.author,
        date: entry.date,
        summary: entry.summary || '',
      })
    }
  }

  /** 面包屑退回当前态：清 ref 重拉工作树 blame */
  function backToCurrentBlame() {
    void loadBlame('')
  }

  // 开关关闭时摘装饰（原组件内 watch 原样搬入）
  watch(showBlame, (val) => {
    if (val && blameData.value.length > 0) {
      applyBlameDecorations()
    } else if (!val) {
      blameDecorations.value = getEditor()?.deltaDecorations(blameDecorations.value, []) || []
    }
  })

  return {
    showBlame,
    blameLoading,
    /** 当前视图 ref（'' = 工作树当前态）：path 切换时宿主置空回当前态 */
    blameRef: blameRef as Ref<string>,
    toggleBlame,
    applyBlameDecorations,
    handleBlameClick,
    handleBlameContextMenu,
    blameMenuShow,
    blameMenuX,
    blameMenuY,
    blameMenuOptions,
    onBlameMenuSelect,
    backToCurrentBlame,
    // 悬停摘要卡（P-20261003-318）：状态供 EditorBlameTools 展示，处理器由
    // attachBlameMouseHandlers 在编辑器就绪后统一挂接
    blamePopShow,
    blamePopX,
    blamePopY,
    blamePopEntry: blamePopEntry as Ref<BlameEntry | null>,
    handleBlameHover,
    hideBlamePop,
    // 溯源区（P-20261007-11）：状态供 EditorBlameTools 展示，点击直达状态由
    // 宿主消费（SessionReplayModal 挂宿主侧）
    blameTraceState,
    blameTraceVisible,
    openTraceReplay,
    traceReplaySession: traceReplaySession as Ref<ClaudeSessionInfo | null>,
    traceReplayFocusAt: traceReplayFocusAt as Ref<string>,
    handleEditorMouseLeave,
  }
}

/** blame 注入文本的鼠标事件统一挂接（宿主 onMounted 编辑器创建后调用一次）：
 *  左键定位 / 右键项目内菜单 / 悬停摘要卡 + 移出与按下即隐。无需 blame 常开
 *  才注册——各处理器内部自行短路（P-20261003-318 悬停卡同批接线）；mouseleave
 *  带落点守卫（P-20261007-11）：指针移入悬停卡（溯源条目可点击）不收卡，其余
 *  落点照旧即隐 */
export function attachBlameMouseHandlers(editor: monaco.editor.IStandaloneCodeEditor, blame: {
  handleBlameClick: (e: monaco.editor.IEditorMouseEvent) => void
  handleBlameContextMenu: (e: monaco.editor.IEditorMouseEvent) => void
  handleBlameHover: (e: monaco.editor.IEditorMouseEvent) => void
  hideBlamePop: () => void
  handleEditorMouseLeave: (e: monaco.editor.IPartialEditorMouseEvent) => void
}): void {
  editor.onMouseDown(blame.handleBlameClick)
  editor.onContextMenu(blame.handleBlameContextMenu)
  editor.onMouseMove(blame.handleBlameHover)
  editor.onMouseLeave(blame.handleEditorMouseLeave)
  editor.onMouseDown(() => blame.hideBlamePop())
}
