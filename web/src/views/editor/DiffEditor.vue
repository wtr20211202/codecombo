<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import * as monaco from 'monaco-editor'
import { NIcon } from 'naive-ui'
import { CreateOutline, SparklesOutline } from '@vicons/ionicons5'
import { useFontStore, composeMonoFontFamily } from '../../stores/font'
import { useThemeStore } from '../../stores/theme'
import { useProjectStore } from '../../stores/project'
import { useI18n } from '../../composables/useI18n'
import { applyMonacoTheme } from '../../utils/monaco-theme'
import { getLanguageByPath } from '../../utils/git'
import { parseDiffKey, diffWorkspaceTarget } from '../../utils/diffTabKey'
import { buildDiffHunkSummary, type DiffSide } from '../../utils/diffHunkSummary'
import { useEditorAskAgent } from '../../composables/useEditorAskAgent'
import { useDiffComments } from '../../composables/useDiffComments'
import { useDiffCommentAgentFix } from '../../composables/useDiffCommentAgentFix'
import { promptDialog } from '../../composables/useDialog'
import { DIFF_COMMENT_MAX_TEXT, type DiffComment } from '../../utils/diffComments'
import { OPS_OPEN_FILE_AT, type OpenFileAtDetail } from '../../utils/opsEvents'
import {
  acquireDiffModel, releaseDiffModel, diffSideModelUriKey,
  saveDiffEditorViewState, peekDiffEditorViewState, diffViewStateKey,
} from './monacoDiffModelPool'
import '../../utils/monaco-env'

const props = defineProps<{
  oldContent: string
  newContent: string
  language?: string
  path?: string
  oldLabel?: string
  newLabel?: string
  /** 编辑器组号（分屏双组 0/1）：diff 视图状态按组分桶，同键双组打开互不串位
   *  （MonacoEditor groupIndex 同约定） */
  groupIndex?: number
  /** 首次 diff 算完自动滚到第一处变更（P-20261005-210 会话输出对比专用）：
   *  会话滚回头部常是大段空白（shell 启动横幅/ConPTY 初始化），默认顶部打开
   *  等于让用户滚过全部噪声；文件 diff 标签不传此 prop，保持顶部打开惯例 */
  autoRevealFirstChange?: boolean
}>()

const emit = defineEmits<{
  (e: 'navigate-next'): void
  (e: 'navigate-prev'): void
  /** diff 行数统计（P-20261005-210 会话输出对比摘要条）：每次 Monaco diff 重算
   *  完成后上抛 {added, removed}（getLineChanges 视图真值，与高亮一致——自算
   *  LCS 会与 Monaco 对齐策略漂移）。无监听方时上抛为空操作零开销 */
  (e: 'diff-stats', stats: { added: number; removed: number }): void
}>()

const editorContainer = ref<HTMLDivElement>()
let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null
let currentOriginal: monaco.editor.ITextModel | null = null
let currentModified: monaco.editor.ITextModel | null = null
const fontStore = useFontStore()
const themeStore = useThemeStore()
const projectStore = useProjectStore()
const { t } = useI18n()

// 「在编辑器打开」（P-20261003-57）：diff 是审阅终点，一键把右侧版本对应的
// 真实文件开进编辑器补「审阅→修改」动线。走 OPS_OPEN_FILE_AT 既有窗口事件桥
// （useLayoutViews 消费：切回编辑器主区 + openFileByPath 预览位打开，同终端
// 文件链接/审批卡 target 口径），本组件是编辑器叶视图不持有 useOpenFiles 实例。
// 形态守卫：仅「右侧=工作区版本」的 diff 键可用（工作区对比/剪贴板对比/两文件
// 互比）；历史对比（HEAD/commit sha 伪 ref）右侧非磁盘现状，按钮置灰静禁用；
// 非 diff 键（本地历史弹窗直传真实路径）整个不渲染。props.path 即当前 diff 标签
// 伪键（EditorGroupPane 透传 currentFile.path）
const diffKey = computed(() => parseDiffKey(props.path || ''))
const openTarget = computed(() => diffWorkspaceTarget(props.path || ''))
const canOpenInEditor = computed(() => !!projectStore.currentProjectId && !!openTarget.value)

function openInEditor() {
  const path = openTarget.value
  const projectId = projectStore.currentProjectId
  if (!path || !projectId) return
  const detail: OpenFileAtDetail = { path, projectId }
  window.dispatchEvent(new CustomEvent(OPS_OPEN_FILE_AT, { detail }))
}

// ── diff 行级追问「追问此改动」（P-20261003-208）──
// P-122 选区询问的 diff 域移植：addAction 挂两侧子编辑器右键菜单（9_scask 组
// 同 P-122），行级定位与 hunk 摘要取自 diffEditor 客户端状态（getLineChanges
// + 双 model 真实行文本，utils/diffHunkSummary 纯函数）。菜单可用性 = 右侧是
// 工作区版本（openTarget 即 P-57 diffWorkspaceTarget 同源守卫）：历史对比右侧
// 非磁盘现状，追问无工作区语义 → 自建上下文键 scDiffAskable 承载 precondition
// （Monaco 把它编为菜单项 when，不可追问形态隐藏菜单项，P-122 无选区隐藏同款）
const { askAgentAboutDiffChange } = useEditorAskAgent()
let askableKeys: monaco.editor.IContextKey<boolean>[] = []
const canAskChange = computed(() => !!projectStore.currentProjectId && !!openTarget.value)

watch(canAskChange, (v) => {
  for (const k of askableKeys) k.set(v)
})

function sideEditor(side: DiffSide): monaco.editor.IStandaloneCodeEditor | null {
  if (!diffEditor) return null
  return side === 'modified' ? diffEditor.getModifiedEditor() : diffEditor.getOriginalEditor()
}

// ── diff 审阅留言（P-20261003-279）：产出 diff 的行级「这里要改」沉淀 ──
// 状态与持久化在 useDiffComments（模块单例，uiState diffComments 命名空间，
// 重开还在）；本组件只承担「状态 ↔ 装饰/菜单」的桥。锚点 = 右侧（工作区版本）
// 行号 + 留言时行内容快照，所以形态守卫与追问/在编辑器打开同口径（openTarget，
// 右侧非工作区版本的历史对比不可留言）；留言菜单只挂 modified 侧编辑器
//（右侧才是「产出的改动」），解除（已处理勾选）/编辑/删除走光标行定位
const diffComments = useDiffComments()
let commentDecorations: monaco.editor.IEditorDecorationsCollection | null = null
let commentableKey: monaco.editor.IContextKey<boolean> | null = null
let commentedKey: monaco.editor.IContextKey<boolean> | null = null
let commentResolvedKey: monaco.editor.IContextKey<boolean> | null = null

function commentTarget(): { pid: string; path: string } | null {
  const pid = projectStore.currentProjectId || ''
  const path = openTarget.value
  return pid && path ? { pid, path } : null
}

function commentAtCursor(): DiffComment | undefined {
  const target = commentTarget()
  if (!target) return undefined
  const line = sideEditor('modified')?.getPosition()?.lineNumber || 0
  if (line < 1) return undefined
  return diffComments.commentAt(target.pid, target.path, line)
}

/** 光标行 → 菜单可用性上下文键（已有留言行才显示 编辑/勾选/删除，且按已解
 *  否态二选一显示；Monaco 把 precondition 编为菜单项 when） */
function updateCommentKeys() {
  const c = commentAtCursor()
  commentedKey?.set(!!c)
  commentResolvedKey?.set(!!c?.resolved)
}

/** 留言输入弹窗（新增与编辑共用；取消返回 null，空文/超长 validate 拦截） */
function promptCommentText(existing?: DiffComment): Promise<string | null> {
  const target = commentTarget()
  return promptDialog({
    title: t('diff.comment.title'),
    label: t('diff.comment.anchor', { path: target?.path || '', line: sideEditor('modified')?.getPosition()?.lineNumber || 0 }),
    placeholder: t('diff.comment.placeholder'),
    defaultValue: existing?.text || '',
    validate: (v) => {
      const s = v.trim()
      if (!s) return t('diff.comment.empty')
      return s.length > DIFF_COMMENT_MAX_TEXT ? t('diff.comment.tooLong', { max: DIFF_COMMENT_MAX_TEXT }) : null
    },
  })
}

function addCommentAtCursor() {
  const target = commentTarget()
  const ed = sideEditor('modified')
  const model = ed?.getModel()
  const line = ed?.getPosition()?.lineNumber || 0
  if (!target || !model || line < 1) return
  void promptCommentText().then((text) => {
    // 弹窗期间内容可能已刷新（model 换代）——行内容快照取弹窗关闭时刻的现状，
    // 行号沿用发起时刻（快照语义：留言锚的是「当时看到的这一行」）
    const snap = diffEditor?.getModifiedEditor().getModel() || model
    if (text !== null) diffComments.addComment(target.pid, target.path, line, text, snap.getLineContent(Math.min(line, snap.getLineCount())))
  })
}

function editCommentAtCursor() {
  const target = commentTarget()
  const c = commentAtCursor()
  if (!target || !c) return
  void promptCommentText(c).then((text) => {
    if (text !== null) diffComments.editComment(target.pid, target.path, c.id, text)
  })
}

function resolveCommentAtCursor(resolved: boolean) {
  const target = commentTarget()
  const c = commentAtCursor()
  if (target && c) diffComments.setCommentResolved(target.pid, target.path, c.id, resolved)
}

function removeCommentAtCursor() {
  const target = commentTarget()
  const c = commentAtCursor()
  if (target && c) diffComments.removeComment(target.pid, target.path, c.id)
}

// ── 审阅留言批量交给智能体（P-20261006-55）：「交给智能体」动作族第五数据源 ──
// 入口①（本 diff 工具条）：当前文件有未解决留言时出钮，N=未解决条数；清单 =
// 未解决留言逐条 {文件路径, 行号, 正文}，装箱与发起链在 useDiffCommentAgentFix
//（P-159 同族范式）。留言状态零触碰——resolved 只由人的复核勾选翻转（安全
// 边界），修完的人审动线：重开本 diff 逐条勾选解除
const { handCommentsToAgent, launching: commentAgentLaunching } = useDiffCommentAgentFix()
const pendingComments = computed<DiffComment[]>(() => {
  const target = commentTarget()
  if (!target) return []
  return diffComments.commentsFor(target.pid, target.path).filter((c) => !c.resolved)
})

function handPendingComments() {
  const path = openTarget.value
  if (!path || pendingComments.value.length === 0) return
  void handCommentsToAgent(pendingComments.value.map((c) => ({ path, comment: c })))
}

/** 悬浮详情（Monaco hover markdown）：正文 + 时间/状态 + 漂移注记——锚行内容
 *  与快照失配（和解没找回）时明说「可能已漂移」，不静默假装还在原位 */
function commentHoverText(c: DiffComment, model: monaco.editor.ITextModel | null): string {
  const drifted = !model
    || c.line > model.getLineCount()
    || model.getLineContent(c.line).trim() !== c.lineText
  const meta = [`${new Date(c.createdAt).toLocaleString()} · ${c.resolved ? t('diff.comment.stateResolved') : t('diff.comment.statePending')}`]
  if (drifted) meta.push(t('diff.comment.drifted'))
  return `**${t('diff.comment.hoverTitle')}**\n\n${c.text}\n\n${meta.join('  \n')}`
}

/** 状态 → 装饰：行侧标记（linesDecorations 车道，已解除绿弱化）+ 悬浮详情，
 *  行号越界项收敛到有效区间（和解后不该出现，防 model 换代竞态） */
function applyCommentDecorations() {
  if (!diffEditor) return
  const ed = diffEditor.getModifiedEditor()
  if (!commentDecorations) commentDecorations = ed.createDecorationsCollection()
  const model = ed.getModel()
  const target = commentTarget()
  const list = target && model ? diffComments.commentsFor(target.pid, target.path) : []
  const lineCount = model?.getLineCount() || 0
  commentDecorations.set(list.map((c) => {
    const line = Math.min(Math.max(c.line, 1), Math.max(lineCount, 1))
    return {
      range: new monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: true,
        linesDecorationsClassName: c.resolved ? 'sc-diff-comment-mark is-resolved' : 'sc-diff-comment-mark',
        showIfCollapsed: true,
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        hoverMessage: { value: commentHoverText(c, model) },
      },
    }
  }))
}

/** 留言层总刷新：漂移和解（内容锚找回，见 utils/diffComments）→ 重放装饰 →
 *  菜单键。diff 重开/内容刷新/tab 切换/留言变更四路共用 */
function refreshCommentLayer() {
  commentableKey?.set(canAskChange.value)
  const target = commentTarget()
  const model = diffEditor?.getModifiedEditor().getModel()
  if (target && model) {
    diffComments.reconcileDrift(target.pid, target.path, model.getLineCount(), (n) => model.getLineContent(n))
  }
  applyCommentDecorations()
  updateCommentKeys()
}

/** 右键行 → ask-agent：行定位选区起点优先（选中若干行追问该选区），裸右键取
 *  光标行（Monaco 右键先把光标定位到点击处）；变更块含所属优先、上下文行取
 *  最近块（utils/diffHunkSummary），摘要空（两侧全同）退化为纯定位头 */
function askAboutChange(side: DiffSide) {
  const path = openTarget.value
  const ed = sideEditor(side)
  if (!path || !ed) return
  const sel = ed.getSelection()
  const line = sel && !sel.isEmpty() ? sel.startLineNumber : ed.getPosition()?.lineNumber || 0
  if (line <= 0) return
  const origModel = diffEditor?.getOriginalEditor().getModel() || null
  const modModel = diffEditor?.getModifiedEditor().getModel() || null
  const summary = buildDiffHunkSummary(diffEditor?.getLineChanges() || [], line, side, (m, n) =>
    (m === 'modified' ? modModel : origModel)?.getLineContent(n) || '',
  )
  void askAgentAboutDiffChange(path, line, summary)
}

function getLang() {
  return props.language || getLanguageByPath(props.path)
}

// diff 行数统计上抛（P-20261005-210 摘要条数据面）：getLineChanges 每变更块
// 两侧行数求和（Monaco 空侧约定 start = end + 1，max(0,…) 归零）。挂在
// onDidUpdateDiff（Monaco 每次 diff 重算完成必发，含空结果），换 model 重算亦然。
// autoRevealFirstChange（会话输出对比专用）：本 model 对首次 diff 算完即滚到
// 第一处变更——内容超视口时打开即见差异，不必人工翻找
let revealedFirstChange = false

function emitDiffStats() {
  if (!diffEditor) return
  const changes = diffEditor.getLineChanges() ?? []
  let added = 0
  let removed = 0
  for (const c of changes) {
    added += Math.max(0, c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1)
    removed += Math.max(0, c.originalEndLineNumber - c.originalStartLineNumber + 1)
  }
  emit('diff-stats', { added, removed })
  if (props.autoRevealFirstChange && !revealedFirstChange && changes.length) {
    revealedFirstChange = true
    // 原侧行号定位（双侧行 1 起计；空侧纯插入块 start 仍 ≥1），修改侧随同步滚动跟进
    diffEditor.getOriginalEditor().revealLineInCenter(Math.max(1, changes[0]!.originalStartLineNumber))
  }
}

// 当前挂载 model 对所属的 diff 伪键：视图状态快照的落键依据。不能读 props.path
// ——tab 切换时 props 先整体更新，内容 watch 触发本函数时 path 已是新键，而编辑器
// 上还挂着旧键的 model 对；换代要「旧对快照落旧键、新对恢复落新键」，须自记
let currentPairKey = ''

function updateModel() {
  if (!diffEditor) return
  const lang = getLang()
  const diffKey = props.path || ''
  const stateKey = diffViewStateKey(props.groupIndex ?? 0, projectStore.currentProjectId || '', diffKey)
  // 换代前快照旧键视图（滚动/双侧视口）：切回该 diff 时 restore 不跳顶。
  // 无挂载对（首挂）无可快照
  if (currentPairKey) {
    saveDiffEditorViewState(
      diffViewStateKey(props.groupIndex ?? 0, projectStore.currentProjectId || '', currentPairKey),
      diffEditor.saveViewState(),
    )
  }
  // model 对经池取用（命中复用免重新分词，内容对齐兜底同键换内容），替代
  // 每次 createModel 全新一对——P-20261004-100 热切的核心：切换只剩 setModel
  const original = acquireDiffModel(diffSideModelUriKey(diffKey, 'old'), lang, props.oldContent || '')
  const modified = acquireDiffModel(diffSideModelUriKey(diffKey, 'mod'), lang, props.newContent || '')
  diffEditor.setModel({ original, modified })
  // 必须先切换 model 再归还旧 model：反向顺序会让仍挂载在 DiffEditorWidget 上的
  // model 被释放，抛 "TextModel got disposed before DiffEditorWidget model got reset"，
  // 编辑器内部上下文服务被腐蚀（右键菜单等随后全部失效）。归还（引用-1）不销毁
  // ——model 留池供往返复用，淘汰由池 LRU 负责
  if (currentOriginal) releaseDiffModel(currentOriginal)
  if (currentModified) releaseDiffModel(currentModified)
  currentOriginal = original
  currentModified = modified
  currentPairKey = diffKey
  // 新 model 对重新获得「滚到第一处变更」资格（P-20261005-210，仅
  // autoRevealFirstChange 宿主消费；换代前快照/恢复语义不变）
  revealedFirstChange = false
  // 恢复新键上次视图（首次打开无记录 = Monaco 默认顶部）
  const saved = peekDiffEditorViewState(stateKey)
  if (saved) diffEditor.restoreViewState(saved)
  // model 换代（重开/内容刷新）：漂移和解 + 重放装饰（旧装饰随旧 model 消亡）
  refreshCommentLayer()
}

// 导航到下一个/上一个变更
function goToNextChange() {
  if (!diffEditor) return
  diffEditor.goToDiff('next')
}

function goToPrevChange() {
  if (!diffEditor) return
  diffEditor.goToDiff('previous')
}

// 「忽略空白」：会话级开关（视图级状态，对标 JetBrains，不持久化）。
// updateOptions 即时触发 Monaco 重算 diff（computeDiff 响应式读取该选项）
const ignoreWhitespace = ref(false)

function toggleIgnoreWhitespace() {
  ignoreWhitespace.value = !ignoreWhitespace.value
  diffEditor?.updateOptions({ ignoreTrimWhitespace: ignoreWhitespace.value })
}

// 「折叠未变区域」：会话级开关（挨「忽略空白」同款模式：ref + updateOptions
// 即时生效，不持久化）。大 diff（agent 批量改动散布千行文件）下收起未变区，
// 与 goToNext/PrevChange 导航天然联动——变更行永不落入折叠区，跳转直达；
// 传局部对象即可：Monaco 校验时其余子项（contextLineCount 等）回落当前值
// （diffEditorOptions.js validateDiffEditorOptions 以现有 options 为 defaults）
const collapseUnchanged = ref(false)

function toggleCollapseUnchanged() {
  collapseUnchanged.value = !collapseUnchanged.value
  diffEditor?.updateOptions({ hideUnchangedRegions: { enabled: collapseUnchanged.value } })
}

// 「并排/行内」视图切换：同为会话级视图开关（不持久化）。窄屏（<900px）默认行内——
// 并排双列在窄视口被挤成不可读窄条；切换即时生效（Monaco 根节点 side-by-side
// 类随 renderSideBySide 联动），行内模式下删除/新增仍走 line-delete/line-insert
// 语义色带渲染
const NARROW_INLINE_BREAKPOINT = 900
const sideBySide = ref(window.innerWidth >= NARROW_INLINE_BREAKPOINT)

function toggleSideBySide() {
  sideBySide.value = !sideBySide.value
  diffEditor?.updateOptions({ renderSideBySide: sideBySide.value })
}

defineExpose({ goToNextChange, goToPrevChange })

onMounted(() => {
  if (!editorContainer.value) return
  applyMonacoTheme(themeStore, fontStore.diffPalette)
  const themeName = `codecombo-${themeStore.currentTheme}`

  diffEditor = monaco.editor.createDiffEditor(editorContainer.value, {
    theme: themeName,
    automaticLayout: true,
    fontSize: fontStore.sizes.diff,
    lineHeight: 22,
    // CSS var 可用于 Monaco：fontFamily 经内联 style 落 DOM，var() 由文档级联解析（同 monacoEditorFactory）。
    // 经 composeMonoFontFamily 合成（P-20261005-227）——与下方运行期 watch 同源，
    // 自定义字体名改/清时 fontFamily 缓存键必变化触发重测宽
    fontFamily: composeMonoFontFamily(fontStore.monoFontName),
    readOnly: true,
    renderSideBySide: sideBySide.value,
    // 显式关：Monaco 0.55 默认在容器宽 ≤ 900px 时静默把 renderSideBySide 压回
    // inline（useInlineViewWhenSpaceIsLimited + renderSideBySideInlineBreakpoint），
    // 会吞掉用户显式的并排切换；窄屏默认行内由本组件的响应式初值统一管理，
    // 视图模式只认会话级开关这一个权威
    useInlineViewWhenSpaceIsLimited: false,
    scrollBeyondLastLine: false,
    padding: { top: 8 },
    minimap: { enabled: false },
    // 折行跟随编辑器设置（P-20261004-55）：读 fontStore.editor.wordWrap（设置页
    // 「自动换行」，MonacoEditor 初装/updateOptions 双路径同源），换行开着的用户
    // 审长行文件（打包产物/锁文件/生成代码）不再横向滚动——侧滚审 diff 视觉锚点
    // 被滚动打散最易漏改动。语义 = 跟随主编辑器设置而非独立项（VS Code 的
    // diffEditor.wordWrap 独立项留后续注记）；运行期变化由下方 watch 联动
    wordWrap: fontStore.editor.wordWrap,
    renderOverviewRuler: true,
    // 显式关：Monaco 内建默认 true（首尾空白差异被静默）会把 reformat/缩进
    // 变更藏成「无差异」；默认展示全部差异，由工具栏「忽略空白」开关接管
    // 该选项（会话级 ref，不持久化），与 DiffViewer 文本路径口径一致
    ignoreTrimWhitespace: false,
    // 与 MonacoEditor 同口径：中文全角标点（（）：
    // 等被判定为「歧义字符」画黄框，中文 md/文档全部误伤——关闭歧义高亮，
    // 仅保留不可见字符告警（防同形注入的安全价值保留）
    unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: true },
    // 显式关：Monaco 0.55.1 默认即 false（common/config/diffEditor.js
    // diffEditorDefaultOptions.hideUnchangedRegions.enabled，实现时已核），行为不变；
    // stickyScroll 曾遇上游默认值已开的先例，这里钉住默认，由工具栏「折叠未变区域」
    // 开关接管该选项（会话级 ref，不持久化）
    hideUnchangedRegions: { enabled: false },
  })
  updateModel()
  // 摘要条数据源（P-20261005-210）：diff 重算完成即上抛行数统计
  diffEditor.onDidUpdateDiff(emitDiffStats)

  // diff 行级追问菜单项（P-20261003-208）：两侧子编辑器各注册一份（侧别由
  // 闭包区分），同组 9_scask 紧邻 P-122 编辑器入口的语义位；上下文键随
  // canAskChange watch 联动（tab 伪键/项目切换在挂载后变化）
  for (const side of ['modified', 'original'] as const) {
    const ed = sideEditor(side)
    if (!ed) continue
    askableKeys.push(ed.createContextKey<boolean>('scDiffAskable', canAskChange.value))
    ed.addAction({
      id: `sc-ask.diff-change-${side}`,
      label: t('diff.ask.menu'),
      contextMenuGroupId: '9_scask',
      contextMenuOrder: side === 'modified' ? 1 : 2,
      precondition: 'scDiffAskable',
      run: () => askAboutChange(side),
    })
    // 审阅留言菜单（P-20261003-279）：仅 modified 侧（右侧=产出的改动，锚点
    // 语义所在），同组 9_scask 追问之后；availability 三键由光标/状态刷新
    if (side === 'modified') {
      commentableKey = ed.createContextKey<boolean>('scDiffCommentable', canAskChange.value)
      commentedKey = ed.createContextKey<boolean>('scDiffCommented', false)
      commentResolvedKey = ed.createContextKey<boolean>('scDiffCommentResolved', false)
      ed.addAction({
        id: 'sc-comment.add',
        label: t('diff.comment.add'),
        contextMenuGroupId: '9_scask',
        contextMenuOrder: 3,
        precondition: 'scDiffCommentable && !scDiffCommented',
        run: () => addCommentAtCursor(),
      })
      ed.addAction({
        id: 'sc-comment.edit',
        label: t('diff.comment.edit'),
        contextMenuGroupId: '9_scask',
        contextMenuOrder: 4,
        precondition: 'scDiffCommentable && scDiffCommented',
        run: () => editCommentAtCursor(),
      })
      ed.addAction({
        id: 'sc-comment.resolve',
        label: t('diff.comment.resolve'),
        contextMenuGroupId: '9_scask',
        contextMenuOrder: 5,
        precondition: 'scDiffCommentable && scDiffCommented && !scDiffCommentResolved',
        run: () => resolveCommentAtCursor(true),
      })
      ed.addAction({
        id: 'sc-comment.unresolve',
        label: t('diff.comment.unresolve'),
        contextMenuGroupId: '9_scask',
        contextMenuOrder: 6,
        precondition: 'scDiffCommentable && scDiffCommented && scDiffCommentResolved',
        run: () => resolveCommentAtCursor(false),
      })
      ed.addAction({
        id: 'sc-comment.remove',
        label: t('diff.comment.remove'),
        contextMenuGroupId: '9_scask',
        contextMenuOrder: 7,
        precondition: 'scDiffCommentable && scDiffCommented',
        run: () => removeCommentAtCursor(),
      })
      ed.onDidChangeCursorPosition(() => updateCommentKeys())
      // 右键直达时光标与菜单同帧：mouseDown 先刷一次键，防菜单按陈旧键渲染
      ed.onMouseDown(() => updateCommentKeys())
    }
  }

  // 持久化留言懒加载（装载完成 version++ → watch 重放装饰）；挂载即先按内存
  // 现状铺一层（多分屏实例/快速切换时内存权威已就绪）
  void diffComments.ensureLoaded()
  refreshCommentLayer()
})

watch([() => props.oldContent, () => props.newContent], () => {
  updateModel()
})

watch(() => fontStore.sizes.diff, (size) => {
  if (diffEditor) diffEditor.updateOptions({ fontSize: size })
})

// 折行跟随编辑器设置（P-20261004-55）：设置页「自动换行」变更即时生效，无需重开
// diff 标签——updateOptions 经 Monaco DiffEditorOptions.editorOptions 响应式下发
// 双侧子编辑器，与 ignoreWhitespace/sideBySide 开关同一生效通道
watch(() => fontStore.editor.wordWrap, (wrap) => {
  if (diffEditor) diffEditor.updateOptions({ wordWrap: wrap })
})

// 自定义等宽字体名（P-20261005-227）：--font-mono-lead 覆写后 DOM 级联即时换字形，
// Monaco 测宽缓存键是 fontFamily 值串本身——重设合成值（创建期同源 compose）
// 触发 font metrics 重测，与主编辑器 useEditorOptionSyncs 的同名 watch 同口径
watch(() => fontStore.monoFontName, () => {
  if (diffEditor) diffEditor.updateOptions({ fontFamily: fontStore.monoFontFamily })
})

// 主题或 diff 色板档（P-20261006-5）任一变更都重定义+重广播 Monaco 主题：
// 色弱档只覆盖 diff* 颜色键，挂载中的 diff 编辑器即时换装无需重开标签
watch([() => themeStore.currentTheme, () => fontStore.diffPalette], () => {
  applyMonacoTheme(themeStore, fontStore.diffPalette)
})

watch(() => [props.language, props.path], () => {
  if (!diffEditor) return
  const lang = getLang()
  const orig = diffEditor.getOriginalEditor().getModel()
  const mod = diffEditor.getModifiedEditor().getModel()
  if (orig) monaco.editor.setModelLanguage(orig, lang)
  if (mod) monaco.editor.setModelLanguage(mod, lang)
})

// 审阅留言四路刷新：model 换代（updateModel 内）/tab 伪键切换（守卫与锚点
// 随之）/留言任意变更（含另一分屏同模块实例的动作）/形态守卫翻转（项目切换）
watch([openTarget, diffComments.version, canAskChange], () => {
  refreshCommentLayer()
})

onBeforeUnmount(() => {
  // 卸载前快照当前视图（跨 remount 存活——diff↔普通文件切换重挂后恢复原位，
  // monacoViewStateCache 同款闭环）
  if (diffEditor && currentPairKey) {
    saveDiffEditorViewState(
      diffViewStateKey(props.groupIndex ?? 0, projectStore.currentProjectId || '', currentPairKey),
      diffEditor.saveViewState(),
    )
  }
  // 挂载对归还池（引用-1）而非销毁：重开同键 diff 免重新分词，淘汰由池 LRU 负责。
  // editor.dispose 只解绑不销毁挂载 model，与归还语义天然衔接
  if (currentOriginal) releaseDiffModel(currentOriginal)
  if (currentModified) releaseDiffModel(currentModified)
  diffEditor?.dispose()
  diffEditor = null
  currentOriginal = null
  currentModified = null
  currentPairKey = ''
})
</script>

<template>
  <div class="diff-editor-wrapper">
    <div class="diff-nav-bar">
      <button
        class="diff-nav-btn"
        :title="t('diff.prevChange')"
        @click="goToPrevChange"
      >
        ↑
      </button>
      <button
        class="diff-nav-btn"
        :title="t('diff.nextChange')"
        @click="goToNextChange"
      >
        ↓
      </button>
      <button
        class="diff-nav-btn"
        :title="sideBySide ? t('diff.view.sideBySide') : t('diff.view.inline')"
        :aria-pressed="sideBySide"
        @click="toggleSideBySide"
      >
        {{ sideBySide ? '▥' : '▤' }}
      </button>
      <button
        class="diff-nav-btn"
        :class="{ active: ignoreWhitespace }"
        :title="t('diff.ignoreWhitespace')"
        :aria-pressed="ignoreWhitespace"
        @click="toggleIgnoreWhitespace"
      >
        ␣
      </button>
      <button
        class="diff-nav-btn"
        :class="{ active: collapseUnchanged }"
        :title="t('diff.collapseUnchanged')"
        :aria-pressed="collapseUnchanged"
        @click="toggleCollapseUnchanged"
      >
        ⋯
      </button>
      <!-- 在编辑器打开（P-20261003-57）：仅 diff 键渲染；历史对比右侧非工作区
           版本置灰（形态守卫静禁用），工作区对比点击直开真实文件（预览位） -->
      <button
        v-if="diffKey"
        class="diff-nav-btn"
        data-testid="diff-open-in-editor"
        :title="t('diff.openInEditor')"
        :disabled="!canOpenInEditor"
        @click="openInEditor"
      >
        <n-icon size="14">
          <CreateOutline />
        </n-icon>
      </button>
      <!-- 审阅留言交给智能体（P-20261006-55）：本 diff 有未解决留言时出现
           （v-if——无待办留言不出空钮），N=未解决条数；发起中禁用防重复 -->
      <button
        v-if="pendingComments.length > 0"
        class="diff-nav-btn"
        data-testid="diff-comments-to-agent"
        :title="t('diff.comment.handActionTitle', { n: pendingComments.length })"
        :aria-label="t('diff.comment.handAction', { n: pendingComments.length })"
        :disabled="commentAgentLaunching"
        @click="handPendingComments"
      >
        <n-icon size="14">
          <SparklesOutline />
        </n-icon>
      </button>
    </div>
    <div
      ref="editorContainer"
      class="diff-editor-container"
    />
  </div>
</template>

<style scoped>
.diff-editor-wrapper { width: 100%; height: 100%; position: relative; }
.diff-editor-container { width: 100%; height: 100%; }
.diff-nav-bar {
  position: absolute;
  top: 8px;
  right: 12px;
  z-index: 10;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--bg-panel);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  padding: 2px;
}
.diff-nav-btn {
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  transition: all var(--motion-fast);
}
.diff-nav-btn:hover {
  background: var(--border-default);
  color: var(--text-primary);
}
.diff-nav-btn.active {
  color: var(--accent-blue-light);
}
/* 形态守卫置灰（历史对比伪 ref）：弱化为不可点的次级形态而非隐藏——
 * 入口恒在，禁用态即「此处不适用」的静默说明 */
.diff-nav-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>

<style>
/* diff 审阅留言行侧标记（P-20261003-279）：Monaco 动态创建的装饰 DOM 挂不上
 * scoped data-v 属性，走全局类（MonacoEditor 书签/gutter 同款结论）。画在
 * linesDecorations 车道——不用整行 className 是避免与 diff 变更行语义色带
 * 叠色；未解除=琥珀竖条（待处理醒目），已解除=绿弱化（审阅闭环但留痕） */
.sc-diff-comment-mark {
  width: 3px !important;
  margin-left: 6px;
  background: var(--accent-yellow);
  border-radius: 2px;
}
.sc-diff-comment-mark.is-resolved {
  background: color-mix(in srgb, var(--accent-green) 55%, transparent);
}
</style>
