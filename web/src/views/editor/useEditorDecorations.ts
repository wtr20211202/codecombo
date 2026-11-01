import { watch } from 'vue'
import * as monaco from 'monaco-editor'
import { useDebounceFn } from '@vueuse/core'
import { useProjectStore } from '../../stores/project'
import { useEditorBookmarks, isBookmarkablePath } from '../../composables/useEditorBookmarks'
import { useEditorGutterChanges } from '../../composables/useEditorGutterChanges'
import { normalizeBookmarkAnchor, relocateBookmarkRecords, type BookmarkRecord } from '../../utils/bookmarkAnchor'
import type { useI18n } from '../../composables/useI18n'
import './monacoDecorations.css'

/**
 * Monaco 编辑器装饰桥族（P-20261003-301 自 MonacoEditor.vue 原样搬运；
 * P-20261004-105 书签桥扩行内容锚自愈）：数据/状态域在既有 composable
 * （useEditorBookmarks 模块单例 / useEditorGutterChanges 实例私有），本模块只
 * 承担「状态 ↔ 装饰」的双向桥。三车道互不冲突：书签 glyph 车道
 * （glyphMarginClassName）/ gutter 变更条车道（linesDecorationsClassName）/
 * blame 的 after 注入文本（见 useEditorBlame）。装饰 DOM 类走
 * monacoDecorations.css 全局块（Monaco 动态创建的 DOM 挂不上 scoped data-v）。
 * editor 实例经 getEditor 迟后取用（onMounted 创建后才非空——勿落 setup 顶层
 * 可空作用域，addAction 同款教训）。
 */

export interface BookmarkBridgeDeps {
  getEditor: () => monaco.editor.IStandaloneCodeEditor | null
  /** 当前文件路径（props.path 实时读取） */
  getPath: () => string
  projectStore: ReturnType<typeof useProjectStore>
  t: ReturnType<typeof useI18n>['t']
  /** 弱提示通道（重锚自愈的「已自动重锚」提示；naive-ui message 收口在宿主） */
  notify: (msg: string) => void
}

export function createBookmarkBridge(deps: BookmarkBridgeDeps) {
  const { getEditor, getPath, projectStore, t, notify } = deps
  // 编辑器书签锚（P-20261002-131；P-20261004-105 锚自愈）：gutter 图标 +
  // Ctrl+Alt+B 当前行 toggle ── 状态与持久化在 useEditorBookmarks（模块单例，
  // 分屏双组共享）；本桥承担「状态 ↔ 装饰」双向桥 + 跨会话漂移重定位：
  // 状态变化重放装饰（失效书签弱标样式），装饰范围随编辑漂移后回读同步
  const bookmarks = useEditorBookmarks()
  let bookmarkDecorations: monaco.editor.IEditorDecorationsCollection | null = null
  /** 当前装饰归属的项目（applyBookmarkDecorations 落装饰时刻的 projectId）：
   *  项目切换的卸载时序里 currentProjectId 已切到新项目，行漂移回写若读实时
   *  值会把旧项目文件的行号写进新项目键下——以归属快照为准，不匹配即跳过 */
  let bookmarkPid = ''
  /** 漂移回读一次性压制（外部整文重读场景）：外部内容经整文 executeEdits 落进
   *  model，Monaco 对整文替换把装饰范围按比例重映射到错位行（实测 0.55：原
   *  50/100 行 → 17/34）——此刻回读到的范围不再有「跟随真实行号」语义，照常
   *  回写会把书签写坏。压制一次回读，行号修复交给 relocateForCurrentFile 按
   *  状态 + 锚判定（比装饰范围更权威）；后续用户编辑的回读不受影响 */
  let suppressDriftSyncOnce = false

  /** 书签可落点的当前文件路径（diff 标签走 DiffEditor 不会挂到本组件；
   *  未命名草稿非真实路径不落书签） */
  function bookmarkablePath(): string {
    const path = getPath()
    return isBookmarkablePath(path) ? path : ''
  }

  /** 装饰集合创建（宿主 onMounted 编辑器就绪后调用；原内联赋值 + onDidChange
   *  订阅两行原样搬入——装饰范围随编辑漂移（collection.onDidChange 只因编辑
   *  触发，set/clear 不算）→ 防抖回读真实行号，目标路径事件时读取） */
  function initCollection() {
    const editor = getEditor()
    if (!editor) return
    bookmarkDecorations = editor.createDecorationsCollection()
    bookmarkDecorations.onDidChange(() => syncBookmarkDriftDebounced(getPath()))
  }

  /** 状态 → 装饰：为当前文件重放 gutter 图标 + 整行弱高亮（行越界项按当前
   *  行数裁剪——重定位会把越界书签拉回锚匹配行，此处仅兜未加载锚的降级记录）。
   *  失效书签（锚在窗口内未找回）走弱标形态：glyph 去饱和降透明、去整行高亮
   *  （视觉严格弱于有效书签——诚实降级不瞎猜，悬停说明） */
  function applyBookmarkDecorations() {
    const editor = getEditor()
    if (!editor || !bookmarkDecorations) return
    const path = bookmarkablePath()
    const pid = projectStore.currentProjectId || ''
    const model = editor.getModel()
    // model 与 path 不匹配（切文件竞态）时不落装饰，防串文件
    if (!path || !pid || !model) return
    if (model.uri.toString() !== monaco.Uri.parse(`file:///${path}`).toString()) return
    bookmarkPid = pid
    const lineCount = model.getLineCount()
    const staleSet = bookmarks.staleAnchorSet(pid, path)
    const records = bookmarks.bookmarksFor(pid, path).filter(r => r.line <= lineCount)
    bookmarkDecorations.set(records.map(rec => {
      const stale = !!rec.anchor && staleSet.has(rec.anchor)
      return {
        range: new monaco.Range(rec.line, 1, rec.line, 1),
        options: {
          isWholeLine: true,
          className: stale ? undefined : 'sc-bookmark-line',
          glyphMarginClassName: stale ? 'sc-bookmark-glyph is-stale' : 'sc-bookmark-glyph',
          glyphMarginHoverMessage: { value: stale ? t('editor.bookmark.staleGlyphTip') : t('editor.bookmark.glyphTip') },
          // 零长度区间默认被折叠丢弃（blame 装饰同款结论）
          showIfCollapsed: true,
          // 书签锚定「行」而非文本区间：行首/行尾打字不扩张
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        } satisfies monaco.editor.IModelDeltaDecoration['options'],
      }
    }))
  }

  /** 装饰 → 状态（行漂移回写）：Monaco model 装饰范围随编辑自动跟随（上方
   *  插入/删除行整体平移），从范围回读真实行号同步回书签状态。model 与目标
   *  路径不匹配（切文件竞态）时不回写，防串文件 */
  function syncBookmarkDriftFor(path: string | undefined) {
    if (suppressDriftSyncOnce) {
      // 消费外部整文重读的压制（见字段注）：本次回读范围不可信，跳过
      suppressDriftSyncOnce = false
      return
    }
    const editor = getEditor()
    if (!editor || !bookmarkDecorations || !path) return
    if (!isBookmarkablePath(path)) return
    const model = editor.getModel()
    if (!bookmarkPid || !model) return
    // 实时项目与装饰归属不一致（项目切换的卸载时序）：旧文件行号不属于新项目，
    // 回写即串项目——跳过（本次会话的漂移不落盘，安全性优先）
    if (projectStore.currentProjectId !== bookmarkPid) return
    if (model.uri.toString() !== monaco.Uri.parse(`file:///${path}`).toString()) return
    const lineCount = model.getLineCount()
    const ranges = bookmarkDecorations.getRanges()
    const prev = bookmarks.bookmarksFor(bookmarkPid, path)
    const staleSet = bookmarks.staleAnchorSet(bookmarkPid, path)
    // 范围 ↔ 记录按下标配对：装饰按记录序创建、集合保插入序（编辑只平移范围
    // 不改序），下标即同一书签的身份对应。长度失配（同行合并等罕见形）退化为
    // 「锚 = 当前行内容」整表重建——失效书签的原锚是「原内容找不回」的唯一
    // 溯源痕迹，重建形态保不住，可接受（下次重定位重新判定）
    const records: BookmarkRecord[] = ranges.map((range, i) => {
      const line = range.startLineNumber
      const old = prev[i]
      if (old?.anchor && staleSet.has(old.anchor)) return { line, anchor: old.anchor }
      const text = line >= 1 && line <= lineCount ? model.getLineContent(line) : null
      const anchor = text !== null ? normalizeBookmarkAnchor(text) : ''
      // 空行/越界不产新锚但保旧锚（用户清空书签行内容 ≠ 换了书签目标）
      return anchor ? { line, anchor } : old?.anchor ? { line, anchor: old.anchor } : { line }
    })
    bookmarks.replaceRecords(bookmarkPid, path, records)
  }

  /** 打字期间的漂移回写防抖（collection.onDidChange 每次编辑都触发，直接
   *  回写会高频撞持久化链；0.6s 停顿窗口内的连续编辑合并为一次）。目标路径在
   *  调度时捕获——延迟窗口内切文件后迟到触发不回写到新文件 */
  const syncBookmarkDriftDebounced = useDebounceFn((path: string | undefined) => syncBookmarkDriftFor(path), 600)

  /** 压制下一次漂移回读（外部整文重读前由宿主调用，语义见 suppressDriftSyncOnce） */
  function suppressDriftReadbackOnce() {
    suppressDriftSyncOnce = true
  }

  /**
   * 跨会话/外部改写漂移重定位（P-20261004-105；打开文件与外部重读后由宿主
   * 调用）：按「行号 + 行内容锚」判定——原行仍匹配保持；失配 ±20 行滑窗唯一
   * 命中重定位 + 弱提示；无匹配/多义保持原行 + 失效弱标。判定在
   * utils/bookmarkAnchor.relocateBookmarkRecords（纯函数），本桥供 model 内容
   * 并落状态；重锚结果随 replaceRecords 防抖写回（打开/重读本身低频，合并成
   * 单次 PUT，不高频写 uiState）。ensureLoaded 就绪后判定（首开竞态下装饰先
   * 按旧行号重放，判定完成经 version watch 重放收敛）
   */
  async function relocateForCurrentFile(): Promise<void> {
    await bookmarks.ensureLoaded()
    const editor = getEditor()
    const path = bookmarkablePath()
    const pid = projectStore.currentProjectId || ''
    const model = editor?.getModel()
    if (!editor || !path || !pid || !model) return
    if (model.uri.toString() !== monaco.Uri.parse(`file:///${path}`).toString()) return
    const records = bookmarks.bookmarksFor(pid, path)
    if (records.length === 0) {
      bookmarks.setStaleAnchors(pid, path, [])
      return
    }
    const lineCount = model.getLineCount()
    const lineTextAt = (line: number): string | null =>
      line >= 1 && line <= lineCount ? model.getLineContent(line) : null
    const result = relocateBookmarkRecords(records, lineCount, lineTextAt)
    bookmarks.replaceRecords(pid, path, result.records)
    bookmarks.setStaleAnchors(pid, path, result.missingAnchors)
    if (result.relocatedCount > 0) {
      notify(t('editor.bookmark.reanchoredToast', { n: result.relocatedCount }))
    }
  }

  /** 当前行加/删书签（Ctrl+Alt+B / 右键菜单；光标不在编辑器内则不动作）。
   *  加书签捕获当前行内容做锚（跨会话重定位的判据） */
  function toggleBookmarkAtCursor() {
    const path = bookmarkablePath()
    const pid = projectStore.currentProjectId || ''
    const editor = getEditor()
    if (!path || !pid || !editor) return
    const line = editor.getPosition()?.lineNumber ?? 0
    if (line >= 1) bookmarks.toggleBookmark(pid, path, line, editor.getModel()?.getLineContent(line))
  }

  /** gutter 书签图标车道点击 → 对应行 toggle（断点交互同款；仅左键） */
  function handleBookmarkGlyphClick(e: monaco.editor.IEditorMouseEvent) {
    if (!e.event.leftButton) return
    if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return
    const path = bookmarkablePath()
    const pid = projectStore.currentProjectId || ''
    const line = e.target.position?.lineNumber ?? 0
    if (!path || !pid || line < 1) return
    bookmarks.toggleBookmark(pid, path, line, getEditor()?.getModel()?.getLineContent(line))
  }

  // 状态版本 → 装饰重放（toggle 可能来自另一分屏组/加载完成，双组编辑器统一由此跟随）
  watch(bookmarks.version, () => {
    applyBookmarkDecorations()
  })

  /** 持久化状态就位后首发装饰（懒加载异步；version watch 承接后续变更）：
   *  先按锚重定位（跨会话漂移自愈）再落装饰 */
  function ensureLoadedThenApply() {
    void relocateForCurrentFile().then(() => applyBookmarkDecorations())
  }

  /** 换文件/卸载时的装饰退场（原两行调用序原样收口：同步先于 clear——
   *  clear 后范围不可读） */
  function syncDriftAndClear(path: string | undefined) {
    syncBookmarkDriftFor(path)
    bookmarkDecorations?.clear()
  }

  return {
    initCollection,
    applyBookmarkDecorations,
    syncBookmarkDriftFor,
    syncBookmarkDriftDebounced,
    suppressDriftReadbackOnce,
    relocateForCurrentFile,
    toggleBookmarkAtCursor,
    handleBookmarkGlyphClick,
    ensureLoadedThenApply,
    syncDriftAndClear,
  }
}

export interface GutterBridgeDeps {
  getEditor: () => monaco.editor.IStandaloneCodeEditor | null
  getPath: () => string
}

export function createGutterBridge(deps: GutterBridgeDeps) {
  const { getEditor } = deps
  // gutter 变更条（P-20261003-14）：行相对上次提交的 added 绿条 / modified 蓝条 ──
  // 数据（hunks 拉取 + 失效链）在 useEditorGutterChanges（实例私有）；本桥只承担
  // 「标记 ↔ 装饰」桥：watch 标记重放 linesDecorations 车道（与 blame 的 after 注入、
  // 书签的 glyphMargin 互不同车道）。装饰随编辑漂移近似跟随，磁盘真值以保存/外部
  // 改写事件的刷新为准
  const gutterChanges = useEditorGutterChanges({ getPath: deps.getPath })
  let gutterDecorationIds: string[] = []

  /** 变更行标记 → 装饰：editor 非空收窄在函数体内（addAction 同款教训——
   *  勿落 setup 顶层可空作用域），model 缺防御同收 */
  function applyGutterDecorations() {
    const editor = getEditor()
    if (!editor) return
    const decorations: monaco.editor.IModelDeltaDecoration[] = gutterChanges.changedLines.value.map((m) => ({
      range: new monaco.Range(m.line, 1, m.line, 1),
      options: {
        linesDecorationsClassName: m.kind === 'added' ? 'sc-gutter-added' : 'sc-gutter-modified',
        // 零长度区间默认被折叠丢弃（blame/书签装饰同款结论）
        showIfCollapsed: true,
        // 锚定「行」而非文本区间：行首/行尾打字不扩张
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    }))
    gutterDecorationIds = editor.deltaDecorations(gutterDecorationIds, decorations)
  }

  watch(gutterChanges.changedLines, () => applyGutterDecorations())

  /** 清掉本实例的变更条装饰：换文件/卸载时调用——model 入 LRU 缓存复用，
   *  装饰不清会在重开时叠出双条（书签装饰同款结论） */
  function clearGutterDecorations() {
    const editor = getEditor()
    if (!editor) return
    gutterDecorationIds = editor.deltaDecorations(gutterDecorationIds, [])
  }

  /** 打开文件即可见，无需等保存（onMounted 与 path watcher 共用入口） */
  function refresh() {
    void gutterChanges.refresh()
  }

  return {
    applyGutterDecorations,
    clearGutterDecorations,
    refresh,
  }
}
