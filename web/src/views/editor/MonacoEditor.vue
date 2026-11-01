<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, inject } from 'vue'
import * as monaco from 'monaco-editor'
import { useFontStore } from '../../stores/font'
import { useThemeStore } from '../../stores/theme'
import { useProjectStore } from '../../stores/project'
import { useKeymapStore } from '../../stores/keymap'
import { useI18n } from '../../composables/useI18n'
import { useMessage } from 'naive-ui'
import { getLanguageByPath } from '../../utils/git'
import { applyMonacoTheme } from '../../utils/monaco-theme'
import EditorGitActions from '../../components/editor/EditorGitActions.vue'
import SaveCodeSnippetModal from '../../components/editor/SaveCodeSnippetModal.vue'
import EditorSnippetPicker from '../../components/editor/EditorSnippetPicker.vue'
// 本地文件历史弹窗（P-20261002-130）：右键「本地历史」入口的弹窗实例。
// monaco 已由本组件静态引入，静态挂载不再增加 chunk 体积
import LocalHistoryModal from '../../components/files/LocalHistoryModal.vue'
import FileAttributionModal from '../../components/files/FileAttributionModal.vue'
// 会话回放弹层（P-20261007-11 blame 溯源区点击直达）：ApprovalCards 同款静态
// 挂载实例（本组件已静态引入 monaco，不触碰懒加载约束）
import SessionReplayModal from '../../components/claude/SessionReplayModal.vue'
import { createMonacoEditorInstance } from './monacoEditorFactory'
import { attachEditorOptionSyncs, applyBracketColorization } from './useEditorOptionSyncs'
// 编辑器域键位注册表（P-20261008-14）：自定义动作键位按 keymap 生效值注册/重注册
import { attachEditorKeymapBindings, type EditorKeymapBindingSpec, type EditorKeymapBindingsHandle } from './editorKeymapBindings'
import { applyContentChanges, isSpliceUnsafeEvent } from './modelContentSplice'
import { getCachedMonacoModel, retainMonacoModel, disposeCachedMonacoModel } from './monacoModelCache'
import { saveEditorViewState, restoreEditorViewState, migrateEditorViewState, setViewStateCursorLineReader, peekViewStateCursorLine } from './monacoViewStateCache'
import { setMonacoViewStateMover } from './monacoViewStateMoves'
// 保存前格式化注册表（P-20261004-139 全部保存链）：把「格式化文档」实现按路径
// 反向注册给 useOpenFiles 保存链（monacoViewStateMoves 同款跨层模式）
import { registerEditorFormatter, unregisterEditorFormatter } from './editorFormatters'
// 面包屑符号段数据源桥（P-20261005-195）：按模型收集 DocumentSymbol 树 +
// 光标行归属祖先链，载荷上抛宿主渲染面包屑符号段
import { createSymbolCrumbBridge, type SymbolCrumbPayload } from './symbolCrumbBridge'
// 诊断聚合（P-20261003-297）/ 字符串内路径补全（P-20261003-107）/ 行内路径链接
// （P-20261005-214）/ TS 项目上下文按需注入（P-20261004-45）四接线：编辑器 chunk
// 加载期把 monaco 命名空间回传各单例（反向注册，未打开过文件不预载编辑器 chunk），
// 详见各模块头注
import { connectEditorProblems } from '../../composables/useEditorProblems'
import { connectEditorPathCompletion } from './pathCompletion'
import { connectEditorPathLinks } from './pathLinks'
import { connectEditorProjectContext, attachEditorProjectContext } from './monacoProjectContext'
import { useEditorNavHistory } from '../../composables/useEditorNavHistory'
import { useEditorAskAgent } from '../../composables/useEditorAskAgent'
import { useEditorCopyPath } from '../../composables/useEditorCopyPath'
import { isRemoteEditorPath } from '../../utils/remoteEditorPath'
import { isUntitledPath } from '../../composables/useOpenFiles'
import { useEditorSendToTerminal, type SendToTerminalOutcome } from '../../composables/useEditorSendToTerminal'
// 选区 Alt+拖拽到 agent 侧栏（P-20261003-162）：Monaco 自绘 pointer 流接管
// （altKey 下 Monaco 内部拖放不启动），落点/spring 协议见模块头注
import { attachEditorSelectionDrag } from './selectionDrag'
import type { EditorConfigEffective } from '../../utils/editorConfig'
// 右键菜单族与装饰桥（P-20261003-301 按域拆出，见各模块头注释）
import { registerEditorContextMenus } from './editorContextMenus'
// 诊断「问智能体：解释此错误」（P-20261006-2）：code action provider 注册
//（随编辑器实例生灭，见模块头注的 API 面核查结论）
import { registerDiagnosticAsk } from './diagnosticAsk'
import { useEditorBlame, attachBlameMouseHandlers } from '../../composables/useEditorBlame'
import { useEditorSnippets } from '../../composables/useEditorSnippets'
// 选区内联 AI 编辑入口（P-20261005-206）：浮条/浮层 content widget + 指令
// 直达活跃会话（发送链在组合式内收口，见其头注）
import { useEditorInlineEdit } from '../../composables/useEditorInlineEdit'
import { useEditorMdPreview } from '../../composables/useEditorMdPreview'
import { useNarrowLayout } from '../../composables/useNarrowLayout'
import { createBookmarkBridge, createGutterBridge } from './useEditorDecorations'
import EditorBlameTools from './EditorBlameTools.vue'
import MdModeBar from './MdModeBar.vue'
import EditorMdPreviewPane from './EditorMdPreviewPane.vue'
import '../../utils/monaco-env'

/**
 * Monaco 编辑器宿主（P-20261003-301 拆分 + 主线增量移植）：本文件保留编辑器实例
 * 生命周期（创建/模型切换/视图状态/内容上抛）与装配，行为面与拆分前逐一等价。
 * 子模块分工——useEditorBlame(blame 族+悬停卡) / useEditorSnippets(片段/分享/询问/
 * 剪贴板对比) / editorContextMenus(右键菜单) / useEditorMdPreview(md 模式/预览管线/
 * 链接导航) / useEditorDecorations(书签/gutter 桥) / useEditorOptionSyncs(选项 watches
 * +缩进约定) / monacoEditorFactory(实例构建) / EditorBlameTools+MdModeBar+
 * EditorMdPreviewPane(展示子组件)，见各模块头注。
 */

const props = defineProps<{
  modelValue: string
  language?: string
  path?: string
  readOnly?: boolean
  /** 编辑器组号（分屏双组 0/1）：视图状态按组分桶，同文件双组打开互不串位 */
  groupIndex?: number
  /** .editorconfig 生效缩进约定（P-20261003-95）：约定 > 全局设置，落 model options */
  editorconfig?: EditorConfigEffective | null
  /** 当前文件是否可「放弃未保存修改」（P-20261005-156，宿主按
   *  content!==originalContent 计算，untitled/diff 已在宿主侧排除）：喂给
   *  scFileCanRevert 上下文键，右键菜单项只对脏文件可见（vs 内建
   *  editorHasSelection 同款 precondition 机制） */
  dirty?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'save'): void
  (e: 'reveal-in-tree'): void
  (e: 'compare-clipboard', payload: { path: string; text: string }): void
  /** 放弃未保存修改（P-20261005-156）：宿主转 useOpenFiles.revertFileInGroup
   *  （作用对象 = 本编辑器当前文件，409 冲突「加载磁盘版本」同链） */
  (e: 'revert-file'): void
  /** 光标状态上抛（P-20261004-141 Ln/Col 徽标）：path 随载荷自描述，
   *  宿主按 path 对位展示，防切签窗口期陈旧串显 */
  (e: 'cursor', payload: { path: string; line: number; column: number; selected: number }): void
  /** 面包屑符号段载荷上抛（P-20261005-195）：光标所在符号祖先链 + 尾段同层
   *  符号，path 自描述同 cursor 口径；chain 空 = 无符号 provider/光标在符号外 */
  (e: 'symbol-crumb', payload: SymbolCrumbPayload): void
}>()

const editorContainer = ref<HTMLDivElement>()
// 跨组拖签移动的视图快照迁移实现注册（P-20261003-38）：monaco.Uri 推导留在
// 编辑器 chunk（懒加载约束），组合式层经 monacoViewStateMoves 注册表调用。
// 幂等覆盖、无实例闭包，重挂重复注册无副作用
setMonacoViewStateMover((fromGi, toGi, path) =>
  migrateEditorViewState(fromGi, toGi, monaco.Uri.parse(`file:///${path}`).toString()))
// 「复制引用（路径:行）」（P-20261006-17）读数实现注册：tab 右键（主 chunk
// EditorGroupPane）经 viewStateCursorLineOf 读非活动 tab 的最后已知光标行，
// monaco.Uri 键推导留在编辑器 chunk（setMonacoViewStateMover 同款约束）
setViewStateCursorLineReader((gi, path) => peekViewStateCursorLine(gi, monaco.Uri.parse(`file:///${path}`).toString()))
// 编辑器 chunk 加载期反向注册四接线：诊断聚合（P-20261003-297）/ 字符串内路径
// 补全（P-20261003-107）/ 行内路径链接（P-20261005-214）/ TS 项目上下文按需
// 注入（P-20261004-45），详见各模块头注
connectEditorProblems(monaco)
connectEditorPathCompletion(monaco)
connectEditorPathLinks(monaco)
connectEditorProjectContext(monaco)
let editor: monaco.editor.IStandaloneCodeEditor | null = null
/** 选区 Alt+拖拽源句柄（P-20261003-162）：随编辑器实例生灭 */
let selectionDragHandle: { dispose: () => void } | null = null
let ignoreNextUpdate = false
// 外部内容同步（executeEdits）发起中的变更标记：消费于 onDidChangeModelContent
let suppressNextModelEvent = false
const fontStore = useFontStore()
const themeStore = useThemeStore()
const projectStore = useProjectStore()
const { t } = useI18n()
const message = useMessage()
// 远程伪路径（remote:<hostId>:<path>，P-20261003-15）：项目域 Git 亲和面
// （blame / Git 快捷操作 / 本地历史 / 右键 git 菜单组）对远端文件无意义，
// 统一按此标记摘除
const isRemotePath = computed(() => isRemoteEditorPath(props.path || ''))
// 未命名草稿（untitled://N，P-20261003-96）：纯内存 tab 无磁盘基线，blame/Git
// 快捷操作必 404——与远程伪路径同口径在按钮可见性守卫摘除；编辑器右键菜单的
// 项目域动作族（Git 组/定位树/本地历史/选区询问/复制引用）同口径双保险摘除见
// editorContextMenus.ts（P-20261005-180 兑现 P-96 自认「留待后续提案」的缺口）
const isUntitledDraft = computed(() => isUntitledPath(props.path || ''))
// Git 快捷操作 ref：Monaco 右键菜单经它复用同一组弹窗实例（不重复挂 NModal）
const egaRef = ref<InstanceType<typeof EditorGitActions> | null>(null)
// 本地文件历史弹窗（P-20261002-130）：右键「本地历史」开关（当前文件即弹窗对象）
const showLocalHistory = ref(false)
// 改动来源弹窗（P-20261005-170）：右键「改动来源」开关（当前文件即查询对象）
const showFsAttribution = ref(false)
// Blame 工具条 ref：宿主经它取悬停卡 DOM（tele 到 body），供 editor mouseleave
// 落点守卫判 relatedTarget（P-20261007-11）
const blameToolsRef = ref<InstanceType<typeof EditorBlameTools> | null>(null)
// 预览面板 ref：模式栏打印按钮经宿主转调其 printPreview（打印逻辑随面板组件，
// run15 落位修正）
const mdPreviewPaneRef = ref<InstanceType<typeof EditorMdPreviewPane> | null>(null)
// 编辑器导航历史（P-20261002-51）光标上报（锚点策略在栈模块内闭环）
const navHistory = useEditorNavHistory()

// editor 实例迟后取用器：子模块在 onMounted 前装配，创建完成后才解引用
const getEditor = () => editor

// ── 面包屑符号段桥（P-20261005-195）──────────────────────────
// 符号树收集/光标行归属见 symbolCrumbBridge.ts；时序钩子由本宿主驱动：
// 首挂与换签（path watcher）onModelSwitched、内容变更 onDidChangeModelContent
// 里 scheduleRefresh（桥内去抖）、光标移动 onDidChangeCursorPosition 里
// onCursorMoved（缓存树纯读重算，与 emitCursorState 同监听面零额外监听）
const symbolCrumb = createSymbolCrumbBridge({
  getEditor,
  getPath: () => props.path || '',
  emit: (payload) => emit('symbol-crumb', payload),
})

// ── blame 注释族（含 P-20261003-318 悬停摘要卡 + P-20261007-11 溯源区）──
const {
  showBlame, blameLoading, blameRef, toggleBlame,
  handleBlameClick, handleBlameContextMenu,
  blameMenuShow, blameMenuX, blameMenuY, blameMenuOptions, onBlameMenuSelect, backToCurrentBlame,
  blamePopShow, blamePopX, blamePopY, blamePopEntry, handleBlameHover, hideBlamePop,
  blameTraceState, blameTraceVisible, openTraceReplay,
  traceReplaySession, traceReplayFocusAt, handleEditorMouseLeave,
} = useEditorBlame({
  getEditor,
  getPath: () => props.path || '',
  projectStore,
  t,
  message,
  getPopEl: () => blameToolsRef.value?.popEl ?? null,
})

// ── 片段/分享/询问/剪贴板对比族 ──
const {
  snippetSaveShow, snippetSaveText, snippetSaveLanguage,
  snippetInsertShow, snippetInsertLanguage,
  openSaveSnippetModal, openSnippetInsertPicker, insertClipboardText,
  insertPickedSnippet, getSelectedText, shareSelectionSnippet, askSelectionAgent,
  compareWithClipboard, getCursorLine,
} = useEditorSnippets({
  getEditor,
  getPath: () => props.path || '',
  t,
  message,
  onCompareClipboard: (payload) => emit('compare-clipboard', payload),
})

// 诊断域询问（P-20261006-2）：ask 链家族的诊断入口，code action 与问题面板
// 条目按钮共用同一发起函数（载荷结构化组装在本组合式内收口）
const { askAgentAboutDiagnostic } = useEditorAskAgent()
// 复制引用（P-20261006-17）：剪贴板/提示链与 tab 右键复制路径族同一组合式
const { copyFileReference } = useEditorCopyPath()
// provider 可注销句：编辑器卸载时随命令一起摘除（见 diagnosticAsk.ts 头注）
let disposeDiagnosticAsk: monaco.IDisposable | null = null

// ── 发送选中到终端（P-20261004-21）──写入链注入自 Layout（provide
// 'sendToTerminal'：开底部终端面板 → TerminalView.sendText → 高危命令闸门 →
// pane.writeInput；无活跃终端 createIfMissing 先开项目默认终端）。链缺席
// （本组件理论上只挂 Layout 树内）降级 no-terminal 走既有无终端提示
type SendToTerminalFn = (text: string, opts?: { createIfMissing?: boolean }) => Promise<SendToTerminalOutcome>
const sendToTerminalFn = inject<SendToTerminalFn | null>('sendToTerminal', null)
const { sendSelectionToTerminal } = useEditorSendToTerminal({
  getSelection: () => getSelectedText(),
  send: (text, opts) => (sendToTerminalFn ? sendToTerminalFn(text, opts) : Promise.resolve('no-terminal')),
  t,
  message,
})

// ── 选区内联 AI 编辑（P-20261005-206）：选区浮条 + 就地指令浮层，结构化
// 指令直达活跃 agent 会话。远程伪路径/未命名草稿不提供（agent 会话 cwd 是
// 本地项目，无本地文件可指；blame/Git 快捷操作可见性同口径）
const inlineEdit = useEditorInlineEdit({
  getEditor,
  getPath: () => props.path || '',
  canEditWithAgent: () => !!projectStore.currentProjectId && !!props.path && !isRemotePath.value && !isUntitledDraft.value,
  t,
  message,
})

// 窄屏（P-20261019-7）：markdown split 的左右 50% 在 390px 下各剩 ~190px，
// 正文逐字竖排不可读——窄屏改为上下等分堆叠（同一 mdMode，仅呈现轴翻转）
const { narrow } = useNarrowLayout()

// ── Markdown 模式与预览管线（含 P-20261003-108 链接导航分流）──
const {
  mdMode, isMarkdown, renderedHtml, changeMdMode, applyMdPreference, cycleMdMode,
  handlePreviewClick, ensureLoadedThenApply: mdEnsureLoaded,
} = useEditorMdPreview({
  getPath: () => props.path || '',
  getModelValue: () => props.modelValue,
  // 远程伪路径/未命名草稿无项目根可折叠，链接保持死链不导航（P-20261003-108 守卫）
  canNavigate: () => !!props.path && !isRemotePath.value && !isUntitledDraft.value,
  getProjectId: () => projectStore.currentProjectId,
  t,
})

/** 窄屏 markdown split：呈现轴由左右改上下（源码/预览各占一半高度） */
const narrowMdSplit = computed(() => narrow.value && isMarkdown.value && mdMode.value === 'split')

// ── 书签/gutter 装饰桥 ──
const {
  initCollection: initBookmarkCollection,
  applyBookmarkDecorations,
  toggleBookmarkAtCursor,
  handleBookmarkGlyphClick,
  ensureLoadedThenApply: bookmarksEnsureLoaded,
  syncDriftAndClear,
  suppressDriftReadbackOnce,
  relocateForCurrentFile: relocateBookmarksForCurrentFile,
} = createBookmarkBridge({
  getEditor,
  getPath: () => props.path || '',
  projectStore,
  t,
  // 重锚自愈的「已自动重锚」弱提示（naive-ui message 由宿主收口）
  notify: (msg) => { message.info(msg) },
})
const { clearGutterDecorations, refresh: refreshGutterChanges } = createGutterBridge({
  getEditor,
  getPath: () => props.path || '',
})

// ── 编辑器域键位注册表（P-20261008-14，改绑体系三域收口）──
// 自定义动作键位接入 keymap 注册表：挂载按生效值 addAction、改键后 dispose→
// 重注册（Monaco standalone 无运行时改绑 API，addAction 返回的 Disposable 是
// 官方摘除面——键绑定/命令/右键菜单项整体回滚，机制见 editorKeymapBindings.ts）。
// 边界：Monaco 内建键（Ctrl+F/H/D 查找替换）与 F12/Shift+F12 转定义接管
//（monacoProjectContext，键位改写内建而非新增动作）不入注册表——防破坏标准编辑
// 体验。label 取值 = 本组件 setup 一次（拆分前 onMounted 取值同口径，语言切换
// 不刷新 label 属既有行为）；重注册复用同一描述符对象
const keymap = useKeymapStore()
const editorKeymapSpecs: EditorKeymapBindingSpec[] = [
  // 单文件保存（默认 Ctrl+S）：Monaco 聚焦域，与全局 saveAll（Ctrl+Alt+S 串联
  // 双组全部脏文件）分工见 keymap.ts 注记
  { id: 'save-file', action: 'editorSave', descriptor: { label: t('editor.saveFile'), run: () => { void formatThenSave() } } },
  // 光标处切换书签（默认 Ctrl+Alt+B）：gutter 点击/右键菜单 9_scbookmark 组同链
  { id: 'sc-bookmark.toggle', action: 'editorBookmarkToggle', descriptor: { label: t('editor.bookmark.toggleAction'), contextMenuGroupId: '9_scbookmark', contextMenuOrder: 1, run: () => toggleBookmarkAtCursor() } },
  // 选区内联 AI 编辑（默认 Ctrl+K，precondition editorHasSelection——无选区
  // 放行内建 chord 前缀）：描述符与浮条/浮层交互同源 useEditorInlineEdit
  { id: 'sc-ask.inline-edit', action: 'editorInlineEdit', descriptor: inlineEdit.actionDescriptor() },
]
let editorKeymapHandle: EditorKeymapBindingsHandle | null = null
// 改键 → 重注册：生效值串作 watch 源（任一编辑器域动作改绑即触发）。重注册 =
// 三条 addAction 重建（attach 时保存的 Disposable 整体摘旧），改键是低频设置
// 操作非热路径；换签/model 切换不触发（键绑定注册面在编辑器实例非 model）
watch(
  () => editorKeymapSpecs.map(s => keymap.combos[s.action]).join('\u0000'),
  () => editorKeymapHandle?.refresh(),
)

// 选项 watches（字号/只读/编辑行为/主题/语言/缩进约定）；applyIndentOptions 供创建后与 path watcher 重钉
const { applyIndentOptions } = attachEditorOptionSyncs({
  getEditor,
  fontStore,
  themeStore,
  getLanguage: () => props.language,
  getPath: () => props.path,
  getReadOnly: () => props.readOnly,
  getEditorconfig: () => props.editorconfig,
})

// 内容增量上抛：由上次内容 + 本轮 changes 拼出新值，替代每击键全量序列化（打字卡顿主因）
let lastEmitted = props.modelValue

/** 格式化当前文档（保存链格式化前置的共用半段，单文件链与全部保存链同源，
 *  P-20261004-139）：开关开启且非只读且编辑器在场时执行内建「格式化文档」
 *  action。语言有无 formatter 由 Monaco provider 注册表决定（不硬编码语言
 *  清单；无 provider 静默跳过直接保存）。格式化失败降级直接保存只留 Console
 *  痕迹；只读态（远程离线降级）不格式化。定义在 setup 作用域（onMounted 外）：
 *  除单文件链外还作为注册表实现供 path watcher 迁移与卸载注销引用 */
async function formatDocumentNow() {
  if (fontStore.editor.formatOnSave && !props.readOnly && editor) {
    try {
      await editor.getAction('editor.action.formatDocument')?.run()
    } catch (e) {
      console.error('format on save failed', e)
    }
  }
}

/** 保存时格式化前置（P-20261003-83）：开关开启先执行内建「格式化文档」再上抛
 *  save——格式化编辑事务经 onDidChangeModelContent 同步落到 openFiles 对象，
 *  save 链读到的即格式化后内容 */
async function formatThenSave() {
  await formatDocumentNow()
  emit('save')
}

/** 光标状态读取上抛（P-20261004-141 Ln/Col 徽标）：位置 + 选区字符数一次取齐，
 *  纯文本插值开销极小，高频光标移动无需节流。首挂/换签各首发一次（setModel
 *  不保证触发光标事件），此后挂 onDidChangeCursorPosition/-Selection 持续上抛 */
function emitCursorState() {
  if (!editor) return
  const pos = editor.getPosition()
  if (!pos) return
  const sel = editor.getSelection()
  let selected = 0
  if (sel && !sel.isEmpty()) {
    selected = editor.getModel()?.getValueInRange(sel).length ?? 0
  }
  emit('cursor', { path: props.path || '', line: pos.lineNumber, column: pos.column, selected })
}

// ── 选区信标上报（P-20261005-149 {selection} 占位符的选区源）────────
// navHistory.activeSelection 模块级信标（{file} 的 activeFilePath 同款旁路
// 镜像——编辑器实例是深层组件，新建会话对话框拿不到）。**逐事件直报不节流**
// （修正案）：消费方按「打开时刻快照」语义在 show watch 读信标——快照落在
// 打开那一瞬，节流尾沿的滞后窗（哪怕 300ms）会快照到旧值（实测「Ctrl+A 全选
// → 秒开对话框」亚秒完成，纯尾沿恒丢选区）；成本与紧邻的 emitCursorState 同
// 口径——它本就在同一监听面逐事件 getValueInRange 提取选区文本（位置徽标的
// selected 计数），本上报多一次同区间读取非新增量级，拖选热路径无额外反模式
function reportSelectionNow() {
  if (!editor) return
  const sel = editor.getSelection()
  const text = sel && !sel.isEmpty() ? (editor.getModel()?.getValueInRange(sel) ?? '') : ''
  navHistory.reportSelection(props.path || '', text)
}

/** 复制引用（路径:行，P-20261006-17）：光标行拼项目相对路径，格式与 Quick
 *  Open 行号直达语法严格一致（复制→粘贴→直达闭环）。未命名草稿不动作——
 *  untitled://N 内部键无项目相对路径语义（tab 侧 canCopyReferenceContextTab
 *  同口径；远程伪路径守卫在 editorContextMenus 的 run 内，同 Git 组惯例） */
async function copyReference() {
  if (isUntitledDraft.value) return
  const line = editor?.getPosition()?.lineNumber
  await copyFileReference(props.path || '', line)
}

// ── 放弃未保存修改（P-20261005-156，VS Code Revert File 对位）────────
// 可放弃态 = 脏且非 untitled（dirty prop 由宿主按 content!==originalContent
// 计算并已排除 diff；远程伪路径可放弃——执行域分流 loadRemoteVersion，不在
// 此排除）。上下文键须等 editor 实例（onMounted 创建），这里 setup 级 watch
// 先行记账：创建时带当前值、变更经 ?. 透传，两侧无窗口期错位
const canRevertCurrent = computed(() => !!props.dirty && !isUntitledDraft.value)
let revertCtxKey: monaco.editor.IContextKey<boolean> | null = null
watch(canRevertCurrent, (v) => revertCtxKey?.set(v))

// 草稿可见性上下文键（P-20261005-180）：editorContextMenus 项目域动作的
// '!scFileIsDraft' precondition 消费——untitled 草稿无磁盘基线，整族死项
// 从菜单摘除（scFileCanRevert 同机制）。上下文键须等 editor 实例（onMounted
// 创建），setup 级 watch 先行记账同 revertCtxKey 先例：创建时带当前值、变更
// 经 ?. 透传，两侧无窗口期错位
let draftCtxKey: monaco.editor.IContextKey<boolean> | null = null
watch(isUntitledDraft, (v) => draftCtxKey?.set(v))

/** 右键「放弃未保存修改」：转调宿主 revertFileInGroup 链（确认弹窗/读盘回填/
 *  草稿作废全在 useOpenFiles 侧）。untitled 防御短路——precondition 已摘可见
 *  性，此处双保险（copyReference 同口径） */
function revertFile() {
  if (isUntitledDraft.value) return
  emit('revert-file')
}

onMounted(() => {
  if (!editorContainer.value) return

  applyMonacoTheme(themeStore, fontStore.diffPalette)
  const themeName = `codecombo-${themeStore.currentTheme}`

  editor = createMonacoEditorInstance(editorContainer.value, {
    path: props.path || 'untitled.txt',
    language: props.language,
    modelValue: props.modelValue,
    readOnly: props.readOnly,
  }, fontStore, themeName)

  // .editorconfig 按文件缩进约定（P-20261003-95）：创建后即按文件钉 model options
  //（模型可能来自 LRU 缓存，携带上次会话的 model options，重钉保证一致）
  applyIndentOptions()

  // 「放弃未保存修改」菜单可见性上下文键（P-20261005-156）：脏文件才出菜单项
  //（setup 级 watch 经 revertCtxKey 透传后续变化，此处带当前值创建）
  revertCtxKey = editor.createContextKey<boolean>('scFileCanRevert', canRevertCurrent.value)

  // 草稿可见性上下文键（P-20261005-180）：editorContextMenus 的 '!scFileIsDraft'
  // precondition 消费（setup 级 watch 经 draftCtxKey 透传换签变化，此处带当前值创建）
  draftCtxKey = editor.createContextKey<boolean>('scFileIsDraft', isUntitledDraft.value)

  // 重挂/重开场景恢复上次视图（卸载前 onBeforeUnmount 已快照进本组桶）
  restoreEditorViewState(props.groupIndex ?? 0, editor)
  // 恢复位首发位置徽标（重挂/切回场景徽标即正确，不等首次光标事件）
  emitCursorState()
  // 恢复位首发选区信标（P-20261005-149）：视图状态携带的选区恢复后信标即正确
  reportSelectionNow()
  // 首挂首发符号段收集（P-20261005-195：onModelSwitched 含空链清态上抛，
  // 旧载荷即时让位，异步收集完成后再上抛实链）
  symbolCrumb.onModelSwitched()

  // 光标位置上报（P-20261002-51 导航历史）：打字微动/跳转/切 tab 后的落位都
  // 经此流入 nav 栈；列号一并上报（P-20261002-148）——后退/前进恢复精确到离开列。
  // diff 伪键与未命名草稿不可按路径恢复，由 navHistory 内部过滤。
  // 旁路上抛位置徽标（P-20261004-141）：同一监听面双消费，不另起监听
  editor.onDidChangeCursorPosition((e) => {
    emitCursorState()
    symbolCrumb.onCursorMoved()
    if (!props.path) return
    const line = e.position?.lineNumber ?? 0
    if (line > 0) navHistory.reportLocation(props.path, line, e.position?.column)
  })
  // 选区独立监听：拖选/程序化 setSelection 可能只变选区不触发光标事件，
  // 「(N selected)」追加段以选区事件兜底；同一监听面双消费选区信标上报
  // （P-20261005-149，逐事件直报的成本口径见 reportSelectionNow 注记）
  editor.onDidChangeCursorSelection(() => {
    emitCursorState()
    reportSelectionNow()
  })
  // 选区浮条跟随（P-20261005-206）：同一选区事件流的第二消费者（浮层在场时
  // 处理器内部短路，选区归浮层快照所有）
  editor.onDidChangeCursorSelection(() => inlineEdit.handleSelectionChange())

  // 选区内联 AI 编辑接线（P-20261005-206）：浮条/浮层监听 + 点击外部收层
  //（Ctrl+K 键位注册随编辑器域注册表走下方 attachEditorKeymapBindings）
  inlineEdit.attach(editor)

  // 编辑器域键位注册（P-20261008-14）：save-file / sc-bookmark.toggle /
  // sc-ask.inline-edit 三动作按 keymap 注册表生效值注册（改键经上方 watch
  // 重注册；卸载经 onBeforeUnmount dispose 摘除）
  editorKeymapHandle = attachEditorKeymapBindings(editor, editorKeymapSpecs, a => keymap.combos[a])

  editor.onDidChangeModelContent((e) => {
    if (!editor) return
    // 符号树随内容漂移：去抖重收集（桥内 500ms，P-20261005-195）；放在分支
    // 返回之前——suppressNextModelEvent 的外部同步分支同样改变符号行号
    symbolCrumb.scheduleRefresh()
    // 外部内容同步（下方 modelValue watcher 的 executeEdits）发起的变更：父层
    // modelValue 已是新值，跳过拼接回抛——拼接基线（lastEmitted）在该分支已被
    // 预写为新值而非变更前内容，照常拼接会把新值尾部按旧长度差错位复制进
    // buffer（远程草稿恢复 SEED→MARKER 实测落成 'UNSAVEDED'：view/model 正确、
    // 保存写出的 f.content 尾部多出 2 字符）。lastEmitted 以 model 权威值对齐
    if (suppressNextModelEvent) {
      suppressNextModelEvent = false
      lastEmitted = editor.getModel()?.getValue() ?? lastEmitted
      return
    }
    // 增量拼接：按 rangeOffset 从后向前应用本轮变更（多光标多段变更一并处理），
    // 不再整文 getValue——大文件每击键的 O(n) 全量序列化是输入卡顿主因。
    // 不可拼接形态（EOL 原语变更 setEOL/pushEOL 及其 undo 的 isEolChange 事件、
    // 缺 range 字段/空数组——P-20261004-140）改采模型权威序列化值：行存储按
    // 模型 EOL 属性序列化，转换后 getValue 全文即新行尾（脏检测随之成立）；
    // 拼接基线与合成 change 的 rangeLength 不保证等长，强拼会差位复制静默损坏。
    // EOL 转换是一次性用户动作非热路径，O(n) 全文重取可接受
    if (isSpliceUnsafeEvent(e)) {
      lastEmitted = editor.getModel()?.getValue() ?? lastEmitted
    } else {
      lastEmitted = applyContentChanges(lastEmitted, e.changes)
    }
    ignoreNextUpdate = true
    emit('update:modelValue', lastEmitted)
  })

  // 全部保存链格式化注册（P-20261004-139）：把格式化实现按当前路径反注册给
  // useOpenFiles 保存链（换签随 path watcher 迁移、卸载注销，见下方两处）
  registerEditorFormatter(props.path || '', formatDocumentNow)

  // blame 注入文本鼠标族统一挂接（处理器内部自行短路，无需 blame 常开才注册；
  // mouseleave 带落点守卫——指针移入悬停卡不收卡，溯源条目可点击）
  attachBlameMouseHandlers(editor, {
    handleBlameClick, handleBlameContextMenu, handleBlameHover, hideBlamePop,
    handleEditorMouseLeave,
  })

  // 右键菜单族（Git/片段/分享/询问/本地历史）：分组编排见 editorContextMenus
  registerEditorContextMenus(editor, t, {
    isRemotePath: () => isRemotePath.value,
    isUntitledDraft: () => isUntitledDraft.value,
    openCompare: () => egaRef.value?.openCompare(),
    compareWithClipboard: () => void compareWithClipboard(),
    openFileHistory: () => egaRef.value?.openHistory(),
    revealInTree: () => emit('reveal-in-tree'),
    openSaveSnippetModal: () => openSaveSnippetModal(),
    openSnippetInsertPicker: () => openSnippetInsertPicker(),
    shareSelectionSnippet: () => shareSelectionSnippet(),
    askSelectionAgent: () => askSelectionAgent(),
    openLocalHistory: () => { showLocalHistory.value = true },
    copyReference: () => { void copyReference() },
    revertFile: () => { revertFile() },
    openFsAttribution: () => { showFsAttribution.value = true },
    sendSelectionToTerminal: () => { void sendSelectionToTerminal() },
  })

  // 诊断 code action「问智能体：解释此错误」（P-20261006-2）：marker hover
  // lightbulb 面与问题面板同源入口；命令经本实例 addCommand 落全局
  // CommandsRegistry，卸载时与 provider 一并摘除
  disposeDiagnosticAsk = registerDiagnosticAsk(editor, monaco, t, (payload) => {
    void askAgentAboutDiagnostic(payload)
  })

  // ── 编辑器书签锚（P-20261002-131）──装饰集合（含漂移回读订阅）+ gutter 点击
  // toggle（Ctrl+Alt+B 键位注册随编辑器域注册表走上方 attachEditorKeymapBindings）
  initBookmarkCollection()
  editor.onMouseDown(handleBookmarkGlyphClick)
  // 跨文件跳转键位接管（P-20261004-45）：F12 / Shift+F12 后注册覆盖内建（同键位
  // 后注册者胜）——真定义可解析时转交内建 action，零结果才走注入链
  attachEditorProjectContext(editor)
  // 持久化状态就位后首发装饰（懒加载异步；version watch 在桥内承接后续变更）
  bookmarksEnsureLoaded()

  // 选区 Alt+拖拽到 agent 侧栏（P-20261003-162）：仅本地项目文件可拖
  // （远程伪路径/未命名草稿/无项目无会话语境，与右键询问族可见性同口径）。
  // t 在此处已就绪；句柄随编辑器卸载释放
  selectionDragHandle = attachEditorSelectionDrag({
    container: editorContainer.value,
    getEditor,
    getPath: () => props.path || '',
    canDrag: () => !!props.path && !isRemotePath.value && !isUntitledDraft.value && !!projectStore.currentProjectId,
    t,
  })

  // md 模式偏好惰性加载完成后一致化（P-20261003-18，首挂即 md 文件的恢复入口）
  mdEnsureLoaded()

  // gutter 变更条首发拉取（打开文件即可见，无需等保存）
  refreshGutterChanges()
})

// path变化时切换 model（优先 LRU 缓存复用；旧模型入缓存而非销毁）
watch(() => props.path, (newPath, oldPath) => {
  if (!editor) return
  // 格式化注册随签迁移（P-20261004-139）：旧路径摘自己那份、新路径补注册——
  // 双组同路径时按实现身份摘除不误删他组的在册实现
  unregisterEditorFormatter(oldPath || '', formatDocumentNow)
  registerEditorFormatter(newPath || '', formatDocumentNow)
  // 切走前把旧文件的书签行漂移同步回状态并清掉装饰（setModel 后即不可达；
  // model 入 LRU 缓存复用，不清会重开叠双份图标），gutter 变更条同口径清掉
  syncDriftAndClear(oldPath)
  clearGutterDecorations()
  const path = newPath || 'untitled.txt'
  const lang = props.language || getLanguageByPath(path)
  const uri = monaco.Uri.parse(`file:///${path}`)
  const uriKey = uri.toString()

  let newModel = getCachedMonacoModel(uriKey)
  if (!newModel) newModel = monaco.editor.getModel(uri) ?? undefined
  if (!newModel) {
    newModel = monaco.editor.createModel(props.modelValue, lang, uri)
  } else if (newModel.getValue() !== props.modelValue) {
    newModel.setValue(props.modelValue)
  }
  retainMonacoModel(uriKey, newModel, newModel)

  const gi = props.groupIndex ?? 0
  const oldModel = editor.getModel()
  // 切走前快照旧文件视图状态（光标/选区/滚动）：undo 栈已由模型缓存保留，
  // 视图状态不再每次 setModel 丢弃——切回时还原原位
  if (oldModel && oldModel.uri.toString() !== uriKey) saveEditorViewState(gi, editor)
  editor.setModel(newModel)
  // 旧模型入 LRU 缓存（保留 undo 栈与分词结果），超限时由缓存淘汰销毁
  if (oldModel && oldModel.uri.toString() !== uriKey) retainMonacoModel(oldModel.uri.toString(), oldModel, newModel)
  // 恢复本组记录的新文件视图状态（首次打开无记录 = Monaco 默认 1:1 顶部）
  restoreEditorViewState(gi, editor)
  // 换签重取位置徽标（P-20261004-141）：恢复的视图状态即新落位，setModel 不保证
  // 触发光标事件，显式首发防徽标停留上一个文件的行列
  emitCursorState()
  // 换签重发选区信标（P-20261005-149）：恢复的视图状态若携带选区即随新路径
  // 上报，无选区上报空串清信标（新签不残留上一个文件的选区）
  reportSelectionNow()
  // 换签重收符号树（P-20261005-195）：先上抛空链清掉旧文件符号段再异步收集，
  // 防切签窗口期旧符号段挂在新路径下（seq 守卫兜底在途收集的乱序回抛）
  symbolCrumb.onModelSwitched()
  // 新文件首发书签装饰（按当前行数裁剪越界项）；跨会话/外部改写漂移按锚内容
  // 重定位自愈（P-20261004-105，LRU 复用 model 的 setValue 会销毁装饰——重定位
  // 变更经 version watch 重放，未变更由上面的首发装饰兜底）
  void relocateBookmarksForCurrentFile()
  applyBookmarkDecorations()
  // 新文件首发 gutter 变更条拉取（openFiles 内容就位后 path watcher 统一入口）
  refreshGutterChanges()

  // 增量拼接基线切换到新文件的当前内容
  lastEmitted = props.modelValue

  // 换签即按新文件钉缩进（.editorconfig 约定/全局设置，P-20261003-95）——LRU 复用的
  // model 会残留上次钉的 options，attach 后重钉本文件生效值
  applyIndentOptions()

  // 新文件回到当前态 blame 视图（装饰随 model 切换本就消失，面包屑同步退出）
  blameRef.value = ''

  // 选区浮条/浮层随文件域失效（P-20261005-206）：快照锚的是旧文件行号，
  // 浮条与浮层即收（重开重新取选区）
  inlineEdit.resetForPathChange()

  // 括号彩色化（P-20261006-9）：设置开关与 markdown 语言差异正交组合——切到 md
  // 文件全局关（散文括号着色是噪音），切回其余文件随设置复位；经双轨应用函数对
  // model 直写（换签复用的缓存 model 会残留上次钉的选项，与 applyIndentOptions 同款）
  applyBracketColorization(editor, fontStore.editor.bracketColor, lang)

  // 切到 md 文件恢复上次模式偏好（P-20261003-18）；无记录保留 split 默认
  applyMdPreference()
})

watch(() => props.modelValue, (newVal) => {
  if (ignoreNextUpdate) {
    ignoreNextUpdate = false
    return
  }
  if (!editor) return
  // 模型与 path 不匹配时跳过外部内容同步：tab 切换（path + modelValue 同时变化）
  // 时本 watcher 可能先于 path watcher 执行，此刻编辑器还挂着上一个文件的
  // model——executeEdits 会污染旧 model（分屏下旧 model 正被另一组显示，立即
  // 穿帮）。此期间对齐由 path watcher 的 setValue 差异兜底完成
  const model = editor.getModel()
  if (!model) return
  const expectedUri = monaco.Uri.parse(`file:///${props.path || 'untitled.txt'}`).toString()
  if (model.uri.toString() !== expectedUri) return
  if (model.getValue() !== newVal) {
    // 标记本轮变更由外部同步发起（变更事件同步触发，处理器内消费复位）：
    // lastEmitted 在事件里以 model 权威值对齐，此处不再预写——预写会把拼接
    // 基线从「变更前内容」换成「变更后内容」，等长不同内容的外部同步
    // （草稿恢复/冲突读盘/编码重载/外部重载）会把差位尾巴复制进 buffer
    suppressNextModelEvent = true
    // 整文替换会把装饰范围按比例重映射到错位行（书签漂移回读的前提失效），
    // 压制本次回读，行号修复交给下方按锚重定位（P-20261004-105）
    suppressDriftReadbackOnce()
    editor.pushUndoStop()
    editor.executeEdits('external', [{
      range: model.getFullModelRange(),
      text: newVal,
    }])
    editor.pushUndoStop()
    // 事件同步消费后理论已复位；未触发变更（理论不发生）时兜底复位防吞后续事件
    suppressNextModelEvent = false
    lastEmitted = newVal
    // 外部重读后按锚内容重定位书签（agent 改盘/git 还原后的自愈面；无锚旧数据
    // 降级保留原行号）
    void relocateBookmarksForCurrentFile()
  }
})

onBeforeUnmount(() => {
  // 编辑器域键位注册摘除（P-20261008-14）：先于 editor.dispose（addAction
  // Disposable 引用的内部注册表随实例销毁，但显式摘除防句柄复活）
  editorKeymapHandle?.dispose()
  editorKeymapHandle = null
  // 选区拖拽源先释放（在途拖拽清掉 ghost/全局监听，不把拖影带出卸载）
  selectionDragHandle?.dispose()
  selectionDragHandle = null
  // 诊断 code action 注册注销（P-20261006-2）：provider 与命令随编辑器同灭
  disposeDiagnosticAsk?.dispose()
  disposeDiagnosticAsk = null
  // 格式化注册注销（P-20261004-139）：卸载必注销防保存链查到死实现（所有权
  // 比对在注册表内，双宿主同路径只摘自己）
  unregisterEditorFormatter(props.path || '', formatDocumentNow)
  // 悬停摘要卡定时器随卸载清掉（挂起的 300ms 弹卡不落已卸载组件）
  hideBlamePop()
  // 选区信标释放归属（P-20261005-149）：选区后关编辑器再开对话框，不把已
  // 不存在的选区带进模板（信标只清归属本实例路径的值，分屏双组互不误清）
  navHistory.releaseSelection(props.path || '')
  // 卸载前把书签行漂移同步回状态并清掉装饰（model 入缓存复用，不清会重开叠双
  // 份图标；同步先于 clear——clear 后范围不可读），gutter 变更条同口径清掉
  syncDriftAndClear(props.path)
  clearGutterDecorations()
  // 选区浮条/浮层先收（P-20261005-206）：layoutContentWidget 调用在已 dispose
  // 的编辑器上不安全，须先于 editor.dispose()
  inlineEdit.resetForPathChange()
  // 卸载前快照当前视图（跨 remount 存活，重开/切回时由 onMounted / path watcher 恢复）
  if (editor) saveEditorViewState(props.groupIndex ?? 0, editor)
  // 符号段桥注销（P-20261005-195）：清挂起去抖与在途收集守卫
  symbolCrumb.dispose()
  // 当前模型入模块级 LRU 缓存而非销毁：下次打开同文件复用（免重新分词，
  // undo 栈保留）；缓存超限时由缓存淘汰真正 dispose（修复实例级缓存的泄漏）
  const model = editor?.getModel()
  if (model) retainMonacoModel(model.uri.toString(), model, model)
  editor?.dispose()
  editor = null
})

defineExpose({
  getEditor: () => editor,
  focus: () => editor?.focus(),
  /** 打开「转到行」quick access（P-20261004-141 位置徽标点击入口）：Monaco 内建
   *  editor.action.gotoLine（Ctrl+G 同入口，复用不重造）。先聚焦编辑器——standalone
   *  QuickInputService 依附「聚焦中的编辑器」（无聚焦编辑器时 activeService 直接
   *  throw），徽标点击后焦点在面包屑按钮上，不先聚焦则弹层静默失败；无编辑器 = no-op */
  gotoLine: () => {
    if (!editor) return
    editor.focus()
    void editor.getAction('editor.action.gotoLine')?.run()
  },
  /** 折叠族内建 action 直触（P-20261006-20 命令面板「全部折叠/全部展开/折叠至
   *  一级」入口）：editor.getAction 复用 Monaco 内建折叠命令（folding.js 注册的
   *  editor.foldAll/editor.unfoldAll/editor.foldLevel1），零新折叠逻辑纯暴露。
   *  run 后聚焦编辑器——面板关闭焦点尚无着落，折叠是阅读动作，键盘应续在
   *  文件上（VS Code 折叠命令焦点留在编辑器同款）；折叠不依赖焦点（与 gotoLine
   *  的 QuickInputService 前置聚焦不同），故聚焦放 run 之后。返回 false = 无
   *  编辑器实例（diff 标签/元信息卡/loading），调用方就地提示 */
  runFoldCommand: (actionId: string): boolean => {
    if (!editor) return false
    void editor.getAction(actionId)?.run()
    editor.focus()
    return true
  },
  /** 定点跳行（P-20261005-195 面包屑符号段同层跳转）：居中 reveal + 光标落行首
   *  + 聚焦。与 gotoLine quick access 的差异：已知目标行直达，无弹层。落位经
   *  onDidChangeCursorPosition 自然流入导航历史/位置徽标/符号段重算，零额外接线。
   *  无编辑器 = no-op（面包屑同 pane 必有编辑器在场，防御仅形态窗口期） */
  revealLine: (line: number) => {
    if (!editor) return
    editor.revealLineInCenter(line)
    editor.setPosition({ lineNumber: line, column: 1 })
    editor.focus()
  },
  /** 打开「插入片段」选择器（右键菜单与命令面板「插入片段」共用）。
   *  false = 无可用编辑器（未打开文件），调用方就地提示 */
  openSnippetInsertPicker: () => openSnippetInsertPicker(),
  /** 多剪贴板粘贴（P-20261002-149）：历史选中插入光标处。
   *  false = 无可用编辑器（欢迎页/diff 标签），调用方降级 */
  insertClipboardText: (text: string) => insertClipboardText(text),
  /** Markdown 模式循环（P-20261003-18，Ctrl+Shift+M 经布局键位链）：
   *  source→preview→split；false = 非 md 文件（布局链据此不消费按键） */
  cycleMdMode: () => cycleMdMode(),
  /** 当前选区文本（P-20261002-71 命令面板「分享文本片段」的预填来源；
   *  无选区/无编辑器返回空串——调用方以空内容开弹窗让用户粘贴） */
  getSelectedText: () => getSelectedText(),
  disposeModel: (path: string) => {
    const uri = monaco.Uri.parse(`file:///${path}`)
    if (disposeCachedMonacoModel(uri.toString())) return
    const model = monaco.editor.getModel(uri)
    model?.dispose()
  },
  /** 当前模型行尾序列读取（P-20261004-140 EOL 徽标）：'LF' | 'CRLF'，无编辑器
   *  /模型 = null。模型 EOL 属性是行尾序列唯一权威——内容字符串对混合行尾
   *  文件已被规范化，不能作判据 */
  getEol: (): 'LF' | 'CRLF' | null => {
    const eol = editor?.getModel()?.getEOL()
    if (eol === '\r\n') return 'CRLF'
    if (eol === '\n') return 'LF'
    return null
  },
  /** EOL 转换（P-20261004-140）：Monaco 内建 pushEOL 原语 = setEOL + 落撤销栈
   *  （行存储按模型 EOL 属性序列化，非全文档文本替换）；前后各一个 undo stop
   *  让转换独占撤销元素——一次 Ctrl+Z 精确回退，不与前后键入合并。变更经
   *  onDidChangeModelContent（isEolChange 事件）自然流回 openFiles 内容与脏
   *  检测，落盘走既有显式 Ctrl+S 保存链（远程签敏感路径确认继承）。
   *  返回 false = 无编辑器/模型或已是目标行尾（调用方无需反馈） */
  convertEol: (target: 'LF' | 'CRLF'): boolean => {
    if (!editor) return false
    const model = editor.getModel()
    if (!model) return false
    if (model.getEOL() === (target === 'CRLF' ? '\r\n' : '\n')) return false
    editor.pushUndoStop()
    // EndOfLineSequence 枚举只在 monaco 类型面（editor.api.d.ts），运行时
    // 命名空间未导出——按 API 契约取值 LF=0 / CRLF=1
    model.pushEOL(target === 'CRLF' ? (1 as monaco.editor.EndOfLineSequence) : (0 as monaco.editor.EndOfLineSequence))
    editor.pushUndoStop()
    return true
  },
})
</script>

<template>
  <div class="editor-wrapper">
    <!-- Markdown 模式切换栏（editor-body 之上；打印逻辑在预览面板组件，经
         print 事件转调）——预览面板落位在下方 editor-body 内（run15 修复：
         此前 fragment 同位导出把预览挤成 wrapper 列子项，height:100% 吃光
         列高压塌 split 态源码面，此处回归拆分前「预览在 editor-body 内右侧」） -->
    <MdModeBar
      :is-markdown="isMarkdown"
      :md-mode="mdMode"
      @change-mode="changeMdMode"
      @print="mdPreviewPaneRef?.printPreview()"
    />

    <div
      class="editor-body"
      :class="{ 'is-md-split-narrow': narrowMdSplit }"
    >
      <!-- 源码编辑器 -->
      <div
        v-show="!isMarkdown || mdMode === 'source' || mdMode === 'split'"
        class="editor-with-blame"
        :style="{ width: isMarkdown && mdMode === 'split' && !narrowMdSplit ? '50%' : '100%', position: 'relative' }"
      >
        <!-- Blame 工具条（按钮/面包屑/悬停卡/溯源区/右键菜单，状态在 useEditorBlame；
             远程伪路径/未命名草稿不提供） -->
        <EditorBlameTools
          ref="blameToolsRef"
          :visible="(!isMarkdown || mdMode !== 'preview') && !isRemotePath && !isUntitledDraft"
          :active="showBlame"
          :loading="blameLoading"
          :crumb-ref="blameRef"
          :pop-show="blamePopShow"
          :pop-x="blamePopX"
          :pop-y="blamePopY"
          :pop-entry="blamePopEntry"
          :trace-visible="blameTraceVisible"
          :trace-state="blameTraceState"
          :menu="{ show: blameMenuShow, x: blameMenuX, y: blameMenuY, options: blameMenuOptions }"
          @toggle="toggleBlame"
          @back="backToCurrentBlame"
          @menu-select="onBlameMenuSelect"
          @menu-close="blameMenuShow = false"
          @trace-replay="openTraceReplay"
          @pop-hide="hideBlamePop"
        />
        <!-- Git 快捷操作（历史/对比分支 Tag/询问智能体），与 Blame 同行（远程伪路径/未命名草稿不提供） -->
        <div
          v-if="(!isMarkdown || mdMode !== 'preview') && projectStore.currentProjectId && path && !isRemotePath && !isUntitledDraft"
          class="ega-anchor"
        >
          <EditorGitActions
            ref="egaRef"
            :project-id="projectStore.currentProjectId"
            :file="path"
            :get-cursor-line="getCursorLine"
          />
        </div>
        <div
          ref="editorContainer"
          class="monaco-container"
        />
      </div>

      <!-- 预览面板（editor-body 内右侧，与源码编辑器同行分列；打印标记类/点击
           上抛自包含在子组件） -->
      <EditorMdPreviewPane
        v-if="isMarkdown && (mdMode === 'preview' || mdMode === 'split')"
        ref="mdPreviewPaneRef"
        :md-mode="mdMode"
        :rendered-html="renderedHtml"
        @preview-click="handlePreviewClick"
      />
    </div>

    <!-- 代码片段弹窗（P-20261002-44）：右键「保存为片段 / 插入片段」 -->
    <SaveCodeSnippetModal
      v-model:show="snippetSaveShow"
      :content="snippetSaveText"
      :language="snippetSaveLanguage"
    />
    <EditorSnippetPicker
      v-model:show="snippetInsertShow"
      :language="snippetInsertLanguage"
      @pick="insertPickedSnippet"
    />

    <!-- 本地文件历史弹窗（P-20261002-130）：右键「本地历史」（当前文件）；恢复改写
         磁盘后缓冲不自动重载，后续保存走既有 409 冲突检测，无静默覆盖面 -->
    <LocalHistoryModal
      v-if="projectStore.currentProjectId && path && !isRemotePath"
      v-model:show="showLocalHistory"
      :project-id="projectStore.currentProjectId"
      :file="path"
    />

    <!-- 改动来源弹窗（P-20261005-170）：右键「改动来源」（当前文件，只读账面） -->
    <FileAttributionModal
      v-if="projectStore.currentProjectId && path && !isRemotePath"
      v-model:show="showFsAttribution"
      :project-id="projectStore.currentProjectId"
      :file="path"
    />

    <!-- blame 溯源条目的回放弹层（P-20261007-11）：focusAt=行提交时刻，打开即
         滚动定位到最近早于该时刻的条目并呼吸高亮（审批卡回放同链） -->
    <SessionReplayModal
      :show="!!traceReplaySession"
      :session="traceReplaySession"
      :focus-at="traceReplayFocusAt"
      @update:show="(v: boolean) => { if (!v) traceReplaySession = null }"
    />
  </div>
</template>

<style scoped>
.editor-wrapper { width: 100%; height: 100%; display: flex; flex-direction: column; }
.editor-body { flex: 1; display: flex; min-height: 0; }
.monaco-container { width: 100%; height: 100%; }

/* 窄屏 markdown split（P-20261019-7）：左右分栏改上下堆叠，源码/预览各半高；
 * 预览组件的 inline width 50% 由 !important 覆盖（呈现轴翻转，mdMode 不变） */
.editor-body.is-md-split-narrow { flex-direction: column; }
.editor-body.is-md-split-narrow > .editor-with-blame,
.editor-body.is-md-split-narrow > .md-preview {
  width: 100% !important;
  flex: 1 1 0;
  min-height: 0;
}
.editor-body.is-md-split-narrow > .md-preview {
  border-left: none;
  border-top: 1px solid var(--border-default);
}

/* Git 快捷操作（历史/对比）锚点：与 Blame 按钮同一行，位于其左侧 */
.editor-with-blame { position: relative; }
.ega-anchor { position: absolute; top: 6px; right: 74px; z-index: 10; }
</style>
