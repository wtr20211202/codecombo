<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, computed, nextTick } from 'vue'
import { NEmpty, NSpin, NInput, NDropdown, NIcon, useMessage } from 'naive-ui'
import {
  EyeOutline, EyeOffOutline, ChevronUpOutline, RefreshOutline,
  SearchOutline, FunnelOutline,
  FolderOutline, FolderOpenOutline,
  PinOutline, CloseOutline, TrashBinOutline, CopyOutline,
} from '@vicons/ionicons5'
import { useVirtualList } from '@vueuse/core'
import { useProjectStore } from '../../stores/project'
import { useUIStateStore } from '../../stores/uiState'
import { useUiDensityStore } from '../../stores/ui-density'
import { useAgentMarks } from '../../composables/useAgentMarks'
import { projectApi } from '../../api/client'
import { useI18n } from '../../composables/useI18n'
import { usePanelLayout } from '../../composables/usePanelLayout'
import { OPS_COLLAPSE_TREE, OPS_LOCATE_IN_TREE, type CollapseTreeDetail, type LocateInTreeDetail } from '../../utils/opsEvents'
import { getStatusColor, getStatusLabel } from '../../utils/git'
import { copyText } from '../../utils/clipboard'
import { buildAgentMarksMarkdown } from '../../utils/agentMarksList'
import { getFileIconColor } from '../../utils/fileIcon'
import { buildRemoteViewUrl } from '../../utils/remoteViewUrl'
import { upsertPin, removePin, prunePins, pinAlias } from '../../utils/fileTreePins'
import { safeStorage } from '../../utils/storage'
import { useFileTreeContext, type FileEntry } from '../../composables/useFileTreeContext'
import { useTreeLongPress } from '../../composables/useTreeLongPress'
import { useEditorAskAgent } from '../../composables/useEditorAskAgent'
import { useFileTreeDragDrop } from '../../composables/useFileTreeDragDrop'
import { useFileTreePaste } from '../../composables/useFileTreePaste'
import { useFileTreeInternalClipboard } from '../../composables/useFileTreeClipboard'
import { useShareDialog } from '../../composables/useShareDialog'
import { useDirSessionBadges } from '../../composables/useDirSessionBadges'
import { useApprovalActions } from '../../composables/useApprovalActions'
import { useFileNestingStore } from '../../stores/file-nesting'
import { buildNestGroups, applyNestGroups } from '../../utils/fileNesting'
// 本地文件历史弹窗（P-20261002-130）懒加载：内含 DiffEditor（Monaco chunk
// 3.6MB+），与 EditorGroupPane 的 MonacoEditor/DiffEditor 同一 ensureMonacoNls
// 懒加载范式——不开历史弹窗的用户不付这笔下载+解析成本
import { ensureMonacoNls } from '@/utils/monaco-nls'
import { safeAsync } from '@/utils/async-component'
const LocalHistoryModal = safeAsync(() => ensureMonacoNls().then(() => import('@/components/files/LocalHistoryModal.vue').then(m => m.default)))
// 回收站浮层（P-20261003-304）：无 Monaco 依赖（列表+两动作，体量小），
// 直接静态导入——懒加载收益不抵拆 chunk 成本
import TrashModal from '@/components/files/TrashModal.vue'
// 文件改动来源归因弹窗（P-20261005-170）：无 Monaco 依赖（只读账面列表），
// 同域静态导入（回收站同款取舍）
import FileAttributionModal from '@/components/files/FileAttributionModal.vue'
// 批量移动「移动到…」目录选择弹层（P-20261003-160）：同域静态导入（纯选择器，
// 复用 Quick Open 清单原语，体量小）
import MoveToDialog from '@/components/files/MoveToDialog.vue'
// 批量重命名弹层（P-20261003-283）：同域静态导入（纯选择器，预览纯函数在
// utils/batchRename，体量小）
import BatchRenameDialog from '@/components/files/BatchRenameDialog.vue'
import { useBatchRename, type BatchRenamePair } from '@/composables/useBatchRename'
// 重命名后引用更新（P-20261005-157）：toast 动作 → 全局搜旧路径 → 既有替换
// 预览弹层（search 域组件复用，勾选/执行链全在组合式内收口）
import ReplacePreviewModal from '@/components/search/ReplacePreviewModal.vue'
import { useRenameRefUpdate } from '@/composables/useRenameRefUpdate'

const emit = defineEmits<{
  (e: 'file-click', file: FileEntry): void
  (e: 'open-in-terminal', path: string): void
  (e: 'compare-baseline', file: { path: string; name: string }): void
  (e: 'search-in-dir', relDir: string): void
  /** 树右键「在分屏打开」（P-20261003-321）：上抛宿主走 openInSplitByPath 既有链路
   *  （载荷与 tab 右键同形：路径字符串） */
  (e: 'open-in-split', path: string): void
}>()

const message = useMessage()
const projectStore = useProjectStore()
const uiStateStore = useUIStateStore()
// Agent 改动标记（B3 辅形态）：驻留项目根的智能体会话的产出文件打点
const { marks: agentMarks } = useAgentMarks(() => projectStore.currentProject?.path || '')
const { t } = useI18n()

// 一键复制改动清单（P-20261003-52）：marks 聚合 → markdown 行式清单（构建器
// 抽 utils/agentMarksList，×N/排序/降级有单测），贴 prompt / PR 描述 / 交接班
// 摘要引用免逐个抄。清单口径 = marks 当前聚合（归属边界沿用：仅 cwd=项目根
// 会话，useAgentMarks 内收口，tooltip 同款注记）
const hasAgentMarks = computed(() => agentMarks.value.size > 0)

async function copyAgentMarksList() {
  if (!hasAgentMarks.value) return
  const ok = await copyText(buildAgentMarksMarkdown(agentMarks.value, t('changes.agentMarks.unknownRuntime')))
  if (ok) message.success(t('fileTree.marksCopied'))
  else message.error(t('common.copyFailed'))
}

const files = ref<FileEntry[]>([])
const loading = ref(false)
const expandedDirs = ref<Set<string>>(new Set())

// ============== 常用目录钉选（P-20261002-97） ==============
// 深层目录的高频跳转免逐层点开：树顶部「已钉选」区直达。持久化在 uiState
// fileTree.pinnedDirs（projectId -> 列表映射，项目级、跨重启）；列表新→旧序、
// 上限 8 个 FIFO 淘汰（upsertPin）。已删/改名目录的钉选置灰降级（validatePins
// 按磁盘核实），可一键清理
const pinnedDirs = ref<string[]>([])
const invalidPins = ref<Set<string>>(new Set())
const hasInvalidPins = computed(() => pinnedDirs.value.some(p => invalidPins.value.has(p)))
// 点击钉选项后的短暂高亮（定位目标行闪示后回归）
const flashPath = ref('')
let flashTimer: ReturnType<typeof setTimeout> | null = null

/** 读当前项目的钉选表（uiState）并按磁盘核实有效性。
 *  代际守卫：项目快速连切时在途的旧响应回来不覆盖（否则旧项目钉选表会
 *  套到新项目上，用户继续钉选还会把错表写进新项目的键） */
let pinsLoadGen = 0
async function loadPins() {
  const gen = ++pinsLoadGen
  const pid = projectStore.currentProjectId
  if (!pid) {
    pinnedDirs.value = []
    invalidPins.value = new Set()
    return
  }
  const all = await uiStateStore.getFileTreePinnedDirs()
  if (gen !== pinsLoadGen) return
  pinnedDirs.value = [...(all[pid] || [])]
  await validatePins()
}

/** 钉选表落盘：拼整张项目映射交专用写端（低频用户动作即时写） */
async function persistPins() {
  const pid = projectStore.currentProjectId
  if (!pid) return
  const all = await uiStateStore.getFileTreePinnedDirs()
  if (pinnedDirs.value.length) all[pid] = [...pinnedDirs.value]
  else delete all[pid]
  await uiStateStore.saveFileTreePinnedDirs(all)
}

/** 有效性核实：逐钉列其父目录（fetchFiles 自带 10s 缓存，父目录共享时合并
 *  请求），父列表含同名目录才算有效——file-policy 端点对目录回 400、缺失回
 *  404，无法区分「目录在」与「目录没了」，故走 file-tree */
async function validatePins() {
  if (!pinnedDirs.value.length) {
    invalidPins.value = new Set()
    return
  }
  const results = await Promise.all(pinnedDirs.value.map(async (p) => {
    const parent = p.split('/').slice(0, -1).join('/')
    const siblings = await fetchFiles(parent)
    return siblings.some(f => f.path === p && f.isDir)
  }))
  invalidPins.value = new Set(pinnedDirs.value.filter((_, i) => !results[i]))
}

/** 钉选/取消钉选（右键菜单 toggle 语义；重复钉选 = 移到最前） */
function togglePin(dirPath: string) {
  if (pinnedDirs.value.includes(dirPath)) {
    pinnedDirs.value = removePin(pinnedDirs.value, dirPath)
  } else {
    pinnedDirs.value = upsertPin(pinnedDirs.value, dirPath)
  }
  // 树上右键可见的目录必然在磁盘（来源即树），新钉默认有效
  invalidPins.value.delete(dirPath)
  void persistPins()
}

/** 一键清理失效钉选（已删/改名目录） */
function clearInvalidPins() {
  pinnedDirs.value = prunePins(pinnedDirs.value, p => !invalidPins.value.has(p))
  void persistPins()
}

/** 点击钉选项：展开定位到该目录（复用终端定位同款 revealFile 逐层展开 +
 *  滚动）+ 目标行短暂高亮；失效钉选点按无操作（等待清理） */
async function revealPinned(dirPath: string) {
  if (invalidPins.value.has(dirPath)) return
  // 搜索过滤会让目标行从 filteredFiles 消失（revealFile 落空）：定位前清掉
  if (searchActive.value) {
    searchActive.value = false
    searchQuery.value = ''
  }
  await nextTick()
  // 树尚未就绪（项目刚切入）：等列表就位再定位（上限 2s 兜底，同 onLocateInTree）
  for (let i = 0; i < 20 && (loading.value || files.value.length === 0); i++) {
    await new Promise(r => setTimeout(r, 100))
  }
  await revealFile(dirPath)
  flashPath.value = dirPath
  if (flashTimer) clearTimeout(flashTimer)
  flashTimer = setTimeout(() => { flashPath.value = '' }, 1600)
}

// 多选状态（P-20261002-20）：存路径而非索引——虚拟列表刷新/重排后选择不漂移；
// 变更面板 selectedForCommit 同款 Set 先例。Shift+Click 范围以 selectionAnchor 为界
const selectedPaths = ref<Set<string>>(new Set())
const selectionAnchor = ref(-1)
// 两个过滤开关均持久化（sc.fileTree.*），跨会话记忆用户选择：
// - showHidden 点文件（.env/.git 等）
// - hideIgnored gitignore 命中的文件/目录（isIgnored 由服务端 check-ignore
//   标记）：默认隐藏——构建产物（*.exe/dist/node_modules）常把列表淹没，
//   业界主流（VS Code 资源管理器）默认隐藏、开关一键找回
const showHidden = ref(readFilterPref('showHidden', false))
const hideIgnored = ref(readFilterPref('hideIgnored', true))

function readFilterPref(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(`sc.fileTree.${key}`)
    return v === null ? fallback : v === '1'
  } catch { return fallback }
}

function saveFilterPref(key: string, value: boolean): void {
  safeStorage.setItem(`sc.fileTree.${key}`, value ? '1' : '0')
}

// 搜索状态
const searchActive = ref(false)
const searchQuery = ref('')
// `/` 直达搜索（P-20261003-2）：开栏后程序化聚焦用（同 inlineInputRef 的 NInput ref 惯例）
const searchInputRef = ref<InstanceType<typeof NInput> | null>(null)

// 键盘导航
const focusedIndex = ref(-1)
// 树列表容器（.tree-list，tabindex=0）：OPS_LOCATE_IN_TREE detail.focus 时
// 落点后把键盘焦点交给树（分享管理器「新建分享」CTA 等入口用，P-20261020-8）
const treeListRef = ref<HTMLElement | null>(null)

// API 缓存
const fileTreeCache = new Map<string, { data: FileEntry[]; timestamp: number }>()
const CACHE_TTL = 10_000

// 右键菜单 + 内联输入抽至 useFileTreeContext
const shareDialog = useShareDialog()

// ============== 本地文件历史弹窗（P-20261002-130） ==============
// 树内自装配（弹窗自含列表/diff/恢复，无需走 Layout 事件链）；恢复成功后
// 刷新目标父目录（git 徽标随磁盘内容变化保持诚实）
const localHistoryPath = ref('')
const showLocalHistory = ref(false)
// safeAsync 组件手动重试：递增后作为 :key 触发重新挂载（同 EditorGroupPane 范式）
const localHistoryRetryTick = ref(0)

function openLocalHistory(path: string) {
  localHistoryPath.value = path
  showLocalHistory.value = true
}

// ============== 文件改动来源归因弹窗（P-20261005-170） ==============
// 树内自装配（弹窗自含查询，只读账面），与本地历史弹窗同形态
const fsAttributionPath = ref('')
const showFsAttribution = ref(false)

function openFsAttribution(path: string) {
  fsAttributionPath.value = path
  showFsAttribution.value = true
}

// ============== 回收站浮层（P-20261003-304） ==============
// 树头部「回收站」按钮直达（根区常驻入口，不占右键菜单）；恢复成功后整树
// 刷新（落点可能是任意目录，保留展开态的 refreshRoot 语义最合适）
const showTrash = ref(false)

function onTrashRestored() {
  void refreshRoot()
}

// 生成分享短链：先弹创建弹层选模式（live/frozen，P-20261003-320），完整
// 创建流程（含敏感文件警示确认）在 useShareDialog；结果卡展示可复制链接，
// 服务未就绪时结果卡给出可行动提示。展示名取路径末段，项目根回落项目名；
// isDir 随菜单带出——单文件 HTML 在创建弹层提示外部资源不随文件生效
//（P-20261020-4）
function createShare(path: string, isDir: boolean) {
  const name = path
    ? path.split('/').pop() || path
    : projectStore.currentProject?.name || ''
  shareDialog.createShare(projectStore.currentProjectId || '', path, name, isDir)
}

// 批量分享选中（P-20261008-1）：多选集合 → 一条冻结快照单链（跨目录评审包）。
// 展示名/体积预估/创建链路在 useShareDialog（createShareBatch），此处只转发
function createShareBatch(paths: string[]) {
  shareDialog.createShareBatch(projectStore.currentProjectId || '', paths)
}

// 在此目录新建 agent 会话（P-20261003-55）：树右键目录/文件经菜单转发到这里，
// 发起链路（cwd=目标目录 + prompt 预填 + docked 打开）全在 useEditorAskAgent
const { askAgentInDirectory } = useEditorAskAgent()

// ============== 重命名后引用更新（P-20261005-157） ==============
// 代码类文件 rename 成功 → toast 动作「更新引用？」→ 全局搜旧路径（无扩展形态
// 一发覆盖带/不带扩展名两类引用）→ search-replace 既有预览弹层（同目录 './简式'
// 命中列低置信区默认不勾）；零命中静默。执行链（敏感闸/备份档/替换历史）全在
// useRenameRefUpdate 内复用 replace 侧既有记账
const {
  renamedFeedback: refUpdateFeedback,
  showPreview: refUpdateShow,
  previewFiles: refUpdateFiles,
  lowConfidencePaths: refUpdateLowConf,
  selectedPaths: refUpdateSelected,
  executing: refUpdateExecuting,
  toggleFileSelection: refUpdateToggleFile,
  toggleSelectAll: refUpdateToggleAll,
  confirmExec: refUpdateConfirm,
} = useRenameRefUpdate({
  projectId: () => projectStore.currentProjectId || '',
})

const {
  contextX, contextY, showContext,
  inlineInput, inlineValue, inlineError, inlineCompatError,
  handleContextMenu, handleBackgroundContext, contextOptions,
  handleContextSelect, confirmInlineInput, cancelInlineInput,
  startInlineCreate, startRename, startDelete,
} = useFileTreeContext({
  projectId: () => projectStore.currentProjectId || '',
  expandedDirs,
  selectedPaths,
  refreshTargetPath: (p) => refreshTargetPath(p),
  refreshRoot: () => refreshRoot(),
  openInTerminal: (path) => emit('open-in-terminal', path),
  openInSplit: (path) => emit('open-in-split', path),
  share: (path, isDir) => void createShare(path, isDir),
  shareSelected: (paths) => createShareBatch(paths),
  upload: (dirPath) => openUploadPicker(dirPath),
  projectRoot: () => projectStore.currentProject?.path || '',
  remoteView: (filePath) => buildRemoteViewUrl({
    remoteUrl: projectStore.currentProject?.remoteURL,
    ref: projectStore.currentProject?.currentBranch,
    filePath,
  }),
  compareWith: (target) => emit('compare-baseline', target),
  localHistory: (target) => openLocalHistory(target.path),
  fsAttribution: (target) => openFsAttribution(target.path),
  askAgentInDir: (relDir) => void askAgentInDirectory(relDir),
  togglePin: (dirPath) => togglePin(dirPath),
  isPinned: (dirPath) => pinnedDirs.value.includes(dirPath),
  searchInDir: (relDir) => emit('search-in-dir', relDir),
  moveTo: (paths) => openMoveTo(paths),
  batchRename: (paths) => openBatchRename(paths),
  // 树内复制/剪切/粘贴（P-20261023-2③a）：内部剪贴板与 batch copy/move 执行链
  // 装配点在本宿主，此处按「菜单只转发」分工交出能力（canPaste 供粘贴项可用态）
  copyEntries: (paths) => copySelectionToClipboard('copy'),
  cutEntries: (paths) => copySelectionToClipboard('cut'),
  pasteInto: (dirPath) => pasteInternal(dirPath),
  canPaste: () => canPaste(projectStore.currentProjectId || ''),
  // 敏感删除 toast 动作直达回收站（P-20261005-163）：showTrash 在本宿主，
  // 经 options 转发给 useFileTreeContext 的删除反馈面（只转发分工惯例）
  openTrash: () => { showTrash.value = true },
  // rename 成功反馈改走引用更新组合式（P-20261005-157）：代码类文件带「更新
  // 引用？」动作 toast，其余扩展名组合式内部回落 plain toast（语义不变）
  renameFeedback: (oldPath, newPath) => refUpdateFeedback(oldPath, newPath),
  message,
  t,
})

// ============== 触屏长按入口（P-20261003-137） ==============
// 树行长按 500ms 复用既有右键菜单流（handleContextMenu：收缩多选 + 全量菜单）
// ——触屏无右键，移动形态的树操作入口保底；仅 touch 指针参与，鼠标右键与
// 点击行为零变化。长按抬手的补发 click 在 handleItemClick 首行吞咽
const { onPointerDown: onTreeItemPointerDown, consumeClickIfFromLongPress } = useTreeLongPress<FileEntry>(
  (e, entry) => handleContextMenu(e, entry),
)

// ============== 目录会话驻留徽标（P-20261004-41） ==============
// dir-agent（P-55）的反向可见性：目录行小徽标 = 驻留该目录的 agent 会话数
// （归属口径在 useDirSessionBadges——实时 cwd、精确等于、仅 agent 会话）。
// 点击跳会话复用 useApprovalActions.jumpToSession 统一链（agent 会话 → 广播
// OPS_ACTIVATE_TERMINAL 开管理页）；同目录多会话先弹 NDropdown 选择（右键
// 菜单同款手动定位宿主面），单会话直接跳
const { sessionsAt: dirSessionsAt, statusLine: dirSessionStatusLine, tipFor: dirSessionTip } = useDirSessionBadges()
const { jumpToSession } = useApprovalActions()

const sessionMenuShow = ref(false)
const sessionMenuX = ref(0)
const sessionMenuY = ref(0)
const sessionMenuDir = ref('')

const sessionMenuOptions = computed(() =>
  dirSessionsAt(sessionMenuDir.value).map(e => ({ label: dirSessionStatusLine(e), key: e.id })),
)

function onDirBadgeClick(e: MouseEvent, dirPath: string) {
  const list = dirSessionsAt(dirPath)
  if (list.length === 0) return
  if (list.length === 1) {
    void jumpToSession(list[0]!.id)
    return
  }
  sessionMenuDir.value = dirPath
  sessionMenuX.value = e.clientX
  sessionMenuY.value = e.clientY
  sessionMenuShow.value = true
}

function onSessionMenuSelect(id: string | number) {
  sessionMenuShow.value = false
  void jumpToSession(String(id))
}

// 内联输入:出现即聚焦并滚入可视区;Enter 确认走 IME 安全守卫
// （中文输入法组合期间的 Enter 只确认候选词,不触发新建）
const inlineInputRef = ref<InstanceType<typeof NInput> | null>(null)
const inlineRowRef = ref<HTMLElement | null>(null)
watch(inlineInput, async (v) => {
  if (!v) return
  // 编辑态与多选互斥：内联新建/重命名期间清空多选，避免批量语义悬在编辑流上
  if (selectedPaths.value.size) selectedPaths.value.clear()
  await nextTick()
  inlineRowRef.value?.scrollIntoView?.({ block: 'nearest' })
  inlineInputRef.value?.focus()
})
function onInlineEnter(e: KeyboardEvent) {
  if (e.isComposing || e.keyCode === 229) return
  confirmInlineInput()
}

// 拖拽（树内移动 + 外部文件上传 + 目录拖入）抽至 useFileTreeDragDrop
const {
  dropTarget, uploadHover, moving,
  hasExternalFiles, uploadExternalFiles, onDragStart, onDragOver, onDragLeave, onDrop, onRootDragOver, onRootDrop,
  moveEntries, copyEntries,
  uploading, uploadDone, uploadTotal, uploadCurrent, uploadFailed, uploadVisible,
  retryUploadOne, retryUploadAllFailed, dismissUploadPanel,
} = useFileTreeDragDrop({
  projectId: () => projectStore.currentProjectId || '',
  selectedPaths,
  refreshTargetPath: (p) => refreshTargetPath(p),
  refreshRoot: () => refreshRoot(),
  message,
  t,
})

// ============== 粘贴通道（P-20261023-2）：OS 文件 Ctrl+V / 树内复制粘贴 ==============
// 内部剪贴板（树内复制/剪切）模块级单例；blur 清板防跨应用陈旧板劫持 OS 粘贴
// （去资源管理器复制 = OS 剪贴板已换内容；应用内点选不触发 window blur 不误清）
const { setTreeClipboard, canPaste, cutPathsOf, clearTreeClipboard } = useFileTreeInternalClipboard()
const cutPaths = computed(() => cutPathsOf(projectStore.currentProjectId || ''))

/** 粘贴落位目录（与拖放落位同规则）：单选目录=自身、单选文件=父目录，其次
 *  焦点项同规则，无选中无焦点 = 项目根 */
function pasteDestDir(): string {
  const pick = (f?: FileEntry) => (!f ? '' : (f.isDir ? f.path : f.path.split('/').slice(0, -1).join('/')))
  if (selectedPaths.value.size === 1) {
    const p = [...selectedPaths.value][0]!
    return pick(displayFiles.value.find(f => f.path === p))
  }
  return pick(displayFiles.value[focusedIndex.value])
}

const { handlePasteEvent, pasteInternal } = useFileTreePaste({
  projectId: () => projectStore.currentProjectId || '',
  destDir: pasteDestDir,
  uploadFiles: (files, dir) => uploadExternalFiles(files, dir),
  pasteCopy: (paths, dir) => copyEntries(paths, dir),
  pasteCut: (paths, dir) => moveEntries(paths, dir),
  message,
  t,
})

/** 树内复制/剪切入板（Ctrl+C/X 与右键菜单共用）：多选集合优先，无选中回退
 *  焦点项；toast 告知可粘贴（能力可发现——菜单置灰项之外的第二入口线索） */
function copySelectionToClipboard(mode: 'copy' | 'cut') {
  const pid = projectStore.currentProjectId || ''
  if (!pid) return
  const paths = selectedPaths.value.size > 0
    ? [...selectedPaths.value]
    : (() => {
        const f = displayFiles.value[focusedIndex.value]
        return f ? [f.path] : []
      })()
  if (paths.length === 0) return
  setTreeClipboard(pid, paths, mode)
  message.info(mode === 'copy'
    ? t('fileTree.copiedToClipboard', { n: paths.length })
    : t('fileTree.cutToClipboard', { n: paths.length }))
}

// 上传进度条宽（P-20261003-117）：文件粒度 done/total；total=0（重置/撤下间隙）回落 0
const uploadBarPct = computed(() =>
  uploadTotal.value > 0 ? Math.min(100, Math.round((uploadDone.value / uploadTotal.value) * 100)) : 0,
)

// ============== 批量移动「移动到…」弹层（P-20261003-160） ==============
// 右键批量菜单与拖拽共用 moveEntries 执行链；弹层只做目标目录拾取。
// 确认后清多选（批量语义收尾，与 batch-delete 同款）再执行移动
const showMoveTo = ref(false)
const moveToPaths = ref<string[]>([])

function openMoveTo(paths: string[]) {
  if (!paths.length) return
  moveToPaths.value = paths
  showMoveTo.value = true
}

function onMoveToSelect(dirPath: string) {
  showMoveTo.value = false
  const paths = [...moveToPaths.value]
  moveToPaths.value = []
  selectedPaths.value.clear()
  void moveEntries(paths, dirPath)
}

// ============== 批量重命名弹层（P-20261003-283） ==============
// 右键批量菜单入口 → 查找/替换 + 实时预览（非法红标 P-132 同源）；确认上抛
// 有效对照对走 useBatchRename 执行链（与批量移动 moveEntries 同款跳过报告）。
// 确认后清多选（批量语义收尾，与 batch-delete / onMoveToSelect 同款）
const showBatchRename = ref(false)
const batchRenamePaths = ref<string[]>([])

function openBatchRename(paths: string[]) {
  if (!paths.length) return
  batchRenamePaths.value = paths
  showBatchRename.value = true
}

function onBatchRenameApply(pairs: BatchRenamePair[]) {
  showBatchRename.value = false
  batchRenamePaths.value = []
  selectedPaths.value.clear()
  void applyBatchRenames(pairs)
}

const { renaming: batchRenaming, applyBatchRenames } = useBatchRename({
  projectId: () => projectStore.currentProjectId || '',
  refreshRoot: () => refreshRoot(),
  message,
  t,
})

// 右键「上传文件」：打开系统文件选择器（可多选），上传到目标目录。
// 上传通道与外部拖入共用 uploadExternalFiles（多文件/跳过报告/局部刷新）
const fileInput = ref<HTMLInputElement | null>(null)
const uploadDir = ref('')

function openUploadPicker(dirPath: string) {
  if (!projectStore.currentProjectId) return
  uploadDir.value = dirPath
  fileInput.value?.click()
}

async function onFilePicked(e: Event) {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files || [])
  input.value = ''
  if (files.length) await uploadExternalFiles(files, uploadDir.value)
}

function invalidateCache() {
  fileTreeCache.clear()
}

// ============== 目录展开状态持久化（按项目） ==============
// 刷新/重开面板后保留展开的目录；「全部收起」按钮随时可手动收起
const expandedKey = () => `sc.fileTree.expanded.${projectStore.currentProjectId}`

watch(expandedDirs, () => {
  safeStorage.setItem(expandedKey(), JSON.stringify([...expandedDirs.value]))
}, { deep: true })

function loadExpanded(): string[] {
  try {
    const pid = projectStore.currentProjectId
    if (!pid) return []
    const saved = JSON.parse(localStorage.getItem(`sc.fileTree.expanded.${pid}`) || '[]')
    return Array.isArray(saved) ? saved.filter((p: unknown) => typeof p === 'string') : []
  } catch { return [] }
}

/** 恢复展开：按路径深度逐级展开（父目录先展开才能取到子级） */
async function restoreExpanded() {
  const saved = loadExpanded().sort((a, b) => a.split('/').length - b.split('/').length)
  for (const dirPath of saved) {
    const idx = files.value.findIndex(f => f.path === dirPath && f.isDir)
    if (idx >= 0 && !expandedDirs.value.has(dirPath)) await toggleDir(files.value[idx]!)
  }
}

async function fetchFiles(subPath?: string) {
  if (!projectStore.currentProjectId) return []
  // 路径已失效的项目不发请求：必然 500 且触发通用错误 toast，语义上这是
  // 已知的无效状态（首页/侧栏均有「路径无效」标记），直接按空处理
  if (projectStore.currentProject?.valid === false) return []
  const cacheKey = `${projectStore.currentProjectId}:${subPath || ''}`
  const cached = fileTreeCache.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data
  }
  loading.value = true
  try {
    const res: any = await projectApi.fileTree(projectStore.currentProjectId!, subPath)
    const data = (res.data || []) as FileEntry[]
    fileTreeCache.set(cacheKey, { data, timestamp: Date.now() })
    return data
  } catch {
    return []
  } finally {
    loading.value = false
  }
}

async function loadRoot() {
  const data = await fetchFiles()
  if (data) files.value = filterHidden(data)
}

function filterHidden(entries: FileEntry[]): FileEntry[] {
  let out = entries
  if (!showHidden.value) out = out.filter(f => !f.name.startsWith('.'))
  if (hideIgnored.value) out = out.filter(f => !f.isIgnored)
  return out
}

// 搜索过滤
const filteredFiles = computed(() => {
  if (!searchQuery.value) return files.value
  const q = searchQuery.value.toLowerCase()
  return files.value.filter(f => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q))
})

// ============== 同名族嵌套显示（P-20261006-21） ==============
// VS Code explorer.fileNesting 惯例的树降噪：foo.vue + foo.test.ts + foo.css 折叠
// 进主文件行（+N 角标点击展开子行）。纯渲染组织层——files 结构面（目录展开/刷新/
// 文件清单 API）不动，agent 与搜索看到的仍是全量平铺。过滤态（搜索框）自动全展开：
// 过滤优先于折叠，否则命中的子文件「看不见」形同丢失。归组 O(n) 单趟分桶，仅在
// 清单/展开态/开关变化时重算（computed 缓存），虚拟列表切片渲染不感知
const fileNestingStore = useFileNestingStore()
// 嵌套族展开态（会话级视觉状态，不持久化——树形态默认保守，开族是显式手势）
const expandedNests = ref<Set<string>>(new Set())
const nestingGroups = computed(() => {
  if (!fileNestingStore.enabled || searchQuery.value) return null
  return buildNestGroups(filteredFiles.value)
})
// 虚拟列表与键盘导航/点击/定位统一消费展示行（嵌套开启时行数=目录行+展开族子行）
const displayFiles = computed(() => {
  const g = nestingGroups.value
  return g ? applyNestGroups(filteredFiles.value, g, expandedNests.value) : filteredFiles.value
})

function toggleNest(mainPath: string) {
  if (expandedNests.value.has(mainPath)) expandedNests.value.delete(mainPath)
  else expandedNests.value.add(mainPath)
}

/** 主文件行角标计数（嵌套关/过滤态恒 0 → 角标不渲染） */
function nestMainCount(path: string): number {
  return nestingGroups.value?.mainToChildren.get(path)?.length || 0
}

/** 子行判定（渲染面：缩进 +1 档、名字弱化） */
function isNestChild(path: string): boolean {
  return nestingGroups.value?.childToMain.has(path) || false
}

// 虚拟滚动
const densityStore = useUiDensityStore()
// 行高密度档（P-20261003-322）：@vueuse v14 的 itemHeight 仅接受
// number | (index)=>number（非响应式，切片重算只由 scroll/size/list 变化触发）。
// 函数形态让 totalSize/offset 计算期实时读密度 ref（wrapperProps computed 随动，
// CommandPalette 同款先例）；可见窗口切片的重算由下方 watch 调 containerProps.
// onScroll()（= 内部 calculateRange）补触发。舒适档 26 = 历史常量，零变化
const { list, containerProps, wrapperProps, scrollTo } = useVirtualList(displayFiles, {
  itemHeight: () => densityStore.rowHeightPx,
  overscan: 10,
})
// store 实例上 ref 已解包，watch 须走 getter 形态（直接传值 watch 不成立）
watch(() => densityStore.rowHeightPx, () => { containerProps.onScroll() })

// 目录级 git 状态聚合
const dirStatusMap = computed(() => {
  const map = new Map<string, string>()
  for (const f of files.value) {
    if (!f.status) continue
    const parts = f.path.split('/')
    for (let i = 1; i < parts.length; i++) {
      const dirPath = parts.slice(0, i).join('/')
      if (!map.has(dirPath)) map.set(dirPath, f.status)
    }
  }
  return map
})

// 文件类型图标：色表已抽至 utils/fileIcon（P-20261002-147，与编辑器 tab
// 色点共用同源，两面板类型识别一致）

async function refreshDir(dirPath: string) {
  expandedDirs.value.delete(dirPath)
  invalidateCache()
  const idx = files.value.findIndex(f => f.path === dirPath)
  if (idx >= 0) {
    const dirDepth = dirPath.split('/').length
    let endIdx = idx + 1
    while (endIdx < files.value.length && files.value[endIdx]!.path.split('/').length > dirDepth) {
      endIdx++
    }
    files.value = [...files.value.slice(0, idx + 1), ...files.value.slice(endIdx)]
    const entry = files.value[idx]!
    await toggleDir(entry)
  }
  // 局部刷新多由删/改名/新建触发（useFileTreeContext）：顺手核实钉选有效性，
  // 树内删除被钉目录后置灰降级即时生效（validatePins 自带缓存，开销可忽略）
  void validatePins()
}

async function refreshRoot() {
  invalidateCache()
  // 刷新保留展开状态：先记录、清空重载后逐级恢复（此前直接清空，刷新即全收起）
  const saved = [...expandedDirs.value].sort((a, b) => a.split('/').length - b.split('/').length)
  expandedDirs.value.clear()
  files.value = []
  await loadRoot()
  for (const dirPath of saved) {
    const idx = files.value.findIndex(f => f.path === dirPath && f.isDir)
    if (idx >= 0) await toggleDir(files.value[idx]!)
  }
  void validatePins()
}

// 局部刷新：只刷新受影响的目录，保留展开状态
async function refreshTargetPath(targetPath: string) {
  invalidateCache()
  // 找到目标路径的最深已展开祖先
  const parts = targetPath.split('/')
  let refreshDirPath = ''
  for (let i = 1; i <= parts.length; i++) {
    const checkPath = parts.slice(0, i).join('/')
    if (expandedDirs.value.has(checkPath)) {
      refreshDirPath = checkPath
    }
  }
  if (refreshDirPath) {
    await refreshDir(refreshDirPath)
  } else {
    await refreshRoot()
  }
}

async function toggleDir(entry: FileEntry) {
  if (expandedDirs.value.has(entry.path)) {
    expandedDirs.value.delete(entry.path)
    const idx = files.value.findIndex(f => f.path === entry.path)
    if (idx >= 0) {
      const dirDepth = entry.path.split('/').length
      let endIdx = idx + 1
      while (endIdx < files.value.length && files.value[endIdx]!.path.split('/').length > dirDepth) {
        endIdx++
      }
      // 使用数组重新赋值替代 splice，确保 useVirtualList 能检测到变更
      files.value = [...files.value.slice(0, idx + 1), ...files.value.slice(endIdx)]
    }
  } else {
    expandedDirs.value.add(entry.path)
    const children = await fetchFiles(entry.path)
    if (children) {
      const idx = files.value.findIndex(f => f.path === entry.path)
      if (idx >= 0) {
        const childEntries = filterHidden(children.map(c => ({ ...c, path: c.path })))
        files.value = [...files.value.slice(0, idx + 1), ...childEntries, ...files.value.slice(idx + 1)]
      }
    }
  }
}

function collapseAll() {
  expandedDirs.value.clear()
  // 嵌套族展开态一并收起（「全部收起」= 树回到最简形态）
  expandedNests.value.clear()
  const rootItems = files.value.filter(f => !f.path.includes('/'))
  files.value = rootItems
}

// 逐级展开目录，定位到指定文件并滚动
async function revealFile(filePath: string) {
  const parts = filePath.split('/')
  // 逐级展开每个父目录
  for (let i = 1; i < parts.length; i++) {
    const dirPath = parts.slice(0, i).join('/')
    if (!expandedDirs.value.has(dirPath)) {
      const dirEntry = files.value.find(f => f.path === dirPath && f.isDir)
      if (dirEntry) await toggleDir(dirEntry)
    }
  }
  // 滚动到目标文件
  await nextTick()
  let idx = displayFiles.value.findIndex(f => f.path === filePath)
  // 嵌套族内的定位（P-20261006-21）：目标折叠在同名族里时先展开其主文件再滚
  // （钉选/终端定位的落点可能是族内子文件），展开后展示行重算再取索引
  if (idx < 0) {
    const main = nestingGroups.value?.childToMain.get(filePath)
    if (main !== undefined) {
      expandedNests.value.add(main)
      await nextTick()
      idx = displayFiles.value.findIndex(f => f.path === filePath)
    }
  }
  if (idx >= 0) {
    focusedIndex.value = idx
    scrollTo(idx)
  }
}

// 终端「在文件树中定位」（P-20261001-32）：终端工具条经 window 事件
// （OPS_LOCATE_IN_TREE，P-1 链接层 OPS_OPEN_FILE_AT 同款模式）携带会话 dir
// （项目相对路径），本树负责落点——先保证文件面板可见（侧栏整体隐藏或在
// changes 视图时先切回 files，被终端/底部全屏最大化覆盖时先还原），再复用
// revealFile 逐层展开 + 滚动高亮；dir 即项目根时无事可展，滚回顶部即可。
// 定位目标是会话当前 dir（P-20261004-59 OSC 7 实时追踪 currentDir，无帧回落创建 dir，与文件链接层同口径）
const layout = usePanelLayout()

// 面板可见性收拾 + revealFile 定位（终端 OPS_LOCATE_IN_TREE 与回收站冲突
// 「打开目标位置」（P-20261006-15）共用落点链：先保证文件面板可见，再逐层
// 展开 + 滚动高亮；path 为空 = 项目根，无事可展滚回顶部）
async function revealPathInTree(path: string) {
  if (layout.sideView.value !== 'files') layout.sideView.value = 'files'
  layout.showSidePanel.value = true
  if (layout.bottomPanelMaximized.value || layout.terminalMaximized.value) layout.restoreFromMaximized()
  // 搜索过滤会让目标行从 filteredFiles 消失（revealFile 落空）：定位前清掉
  if (searchActive.value) {
    searchActive.value = false
    searchQuery.value = ''
  }
  await nextTick()
  // 面板刚挂载（侧栏此前在 changes 视图，本组件 v-if 重挂）时根列表仍在
  // 首载：等列表就位再定位（上限 2s 兜底，空目录项目不悬挂）
  for (let i = 0; i < 20 && (loading.value || files.value.length === 0); i++) {
    await new Promise(r => setTimeout(r, 100))
  }
  if (path === '') {
    focusedIndex.value = -1
    scrollTo(0)
    return
  }
  await revealFile(path)
}

// 回收站冲突「打开目标位置」（P-20261006-15）：先关浮层（占位文件在树里，
// 不关会被浮层挡住落点），再走与终端定位同一条 reveal 链
function onTrashLocate(path: string) {
  showTrash.value = false
  void revealPathInTree(path)
}

async function onLocateInTree(e: Event) {
  const detail = (e as CustomEvent<LocateInTreeDetail>).detail
  if (!detail || detail.projectId !== projectStore.currentProjectId) return
  await revealPathInTree(detail.path)
  // focus 扩展（P-20261020-8）：入口（如分享管理器 CTA）要求落点后把键盘
  // 焦点交给树，用户接着用方向键/搜索选文件；既有定位调用方不带此字段，
  // 不改变「定位但不抢编辑器焦点」的既有行为
  if (detail.focus) treeListRef.value?.focus()
}

onMounted(() => window.addEventListener(OPS_LOCATE_IN_TREE, onLocateInTree))
onBeforeUnmount(() => window.removeEventListener(OPS_LOCATE_IN_TREE, onLocateInTree))

// 窗口失焦清空内部剪贴板（P-20261023-2③a）：去资源管理器/其他应用复制 = OS
// 剪贴板已换内容，滞留的内部板会在 Ctrl+V 时抢先于 OS 文件通道被消费；应用内
// 操作不触发 window blur（不误清树内复制→点终端→回来粘贴的动线）
function onWindowBlur() {
  clearTreeClipboard()
}
onMounted(() => window.addEventListener('blur', onWindowBlur))
onBeforeUnmount(() => window.removeEventListener('blur', onWindowBlur))

// 一键重置布局（P-20261002-74）：重置方清 localStorage 展开键后派发，本树挂载中
// 就地收起全部目录（collapseAll 的 expandedDirs deep watch 回写空表，与清键收敛）；
// 未挂载时无人监听，清键已覆盖——下次进入 loadExpanded 得空表
function onCollapseTree(e: Event) {
  const detail = (e as CustomEvent<CollapseTreeDetail>).detail
  if (!detail || detail.projectId !== projectStore.currentProjectId) return
  collapseAll()
}
onMounted(() => window.addEventListener(OPS_COLLAPSE_TREE, onCollapseTree))
onBeforeUnmount(() => window.removeEventListener(OPS_COLLAPSE_TREE, onCollapseTree))

function getIndentLevel(path: string): number {
  return path.split('/').length - 1
}

// 键盘导航
function handleTreeKeydown(e: KeyboardEvent) {
  if (searchActive.value && searchQuery.value) return // 搜索模式不干扰
  // 内联输入（新建/重命名）里的按键不参与树导航，否则确认重命名的
  // Enter 会冒泡到树上把 focusedIndex 指向的目录 toggle/打开
  const target = e.target as HTMLElement | null
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.closest?.('.inline-input-row'))) return
  const totalItems = displayFiles.value.length

  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault()
      focusedIndex.value = Math.min(focusedIndex.value + 1, totalItems - 1)
      scrollTo(focusedIndex.value)
      break
    case 'ArrowUp':
      e.preventDefault()
      focusedIndex.value = Math.max(focusedIndex.value - 1, 0)
      scrollTo(focusedIndex.value)
      break
    case 'ArrowRight': {
      const f = displayFiles.value[focusedIndex.value]
      if (f?.isDir && !expandedDirs.value.has(f.path)) toggleDir(f)
      // 嵌套族主行（P-20261006-21）：右展与目录同款键盘语义
      else if (f && !f.isDir && nestMainCount(f.path) > 0 && !expandedNests.value.has(f.path)) toggleNest(f.path)
      break
    }
    case 'ArrowLeft': {
      const f = displayFiles.value[focusedIndex.value]
      if (f?.isDir && expandedDirs.value.has(f.path)) toggleDir(f)
      else if (f && !f.isDir && expandedNests.value.has(f.path)) toggleNest(f.path)
      break
    }
    case 'Enter': {
      const f = displayFiles.value[focusedIndex.value]
      if (f) {
        if (f.isDir) toggleDir(f)
        else emit('file-click', f)
      }
      break
    }
    case 'a': {
      // Ctrl/Cmd+A 全选当前可见层级（搜索过滤下即过滤结果集；嵌套下为展示行）
      if (!(e.ctrlKey || e.metaKey) || totalItems === 0) break
      e.preventDefault()
      for (const f of displayFiles.value) selectedPaths.value.add(f.path)
      break
    }
    case 'c':
    case 'C':
    case 'x':
    case 'X': {
      // 树内复制/剪切（P-20261023-2③a）：双修饰红线（ctrlKey||metaKey），入内部
      // 剪贴板（不写 OS 剪贴板）；范围限定同本 handler 既有约定（树聚焦才到达）
      if (!(e.ctrlKey || e.metaKey)) break
      e.preventDefault()
      copySelectionToClipboard(e.key.toLowerCase() === 'c' ? 'copy' : 'cut')
      break
    }
    case 'v':
    case 'V': {
      // 树内剪切/复制板的 Ctrl+V 粘贴（P-20261023-2③a）：内部板有内容才接管
      // （preventDefault 会吞掉原生 paste 事件）；板空时放行——原生 paste 事件
      // 走 OS 文件/截图通道（handlePasteEvent），两条通道以板的有无自然分流
      if (!(e.ctrlKey || e.metaKey)) break
      if (!canPaste(projectStore.currentProjectId || '')) break
      e.preventDefault()
      pasteInternal(pasteDestDir())
      break
    }
    case 'F2': {
      // 范围限定：本 handler 只挂在 .tree-list 上（焦点在树容器内才会到达），
      // 且须有选中节点——无选中时 focusedIndex 越界取到 undefined，自然无操作；
      // 行内编辑进行中（新建/重命名）不重复触发，避免顶掉正在进行的输入
      if (inlineInput.value) break
      e.preventDefault()
      const f = displayFiles.value[focusedIndex.value]
      if (f) startRename(f)
      break
    }
    case 'Delete': {
      // 与 F2 对称（P-20261002-134）：范围限定同款（须有焦点节点、行内编辑进行中
      // 不触发）；删除走右键菜单同链路（startDelete，含确认对话框），成功后焦点
      // 移至相邻项——见 deleteFocusedItem
      if (inlineInput.value) break
      e.preventDefault()
      void deleteFocusedItem()
      break
    }
    case '/': {
      // `/` 直达搜索框（P-20261003-2，树键盘流闭环，VS Code 资源管理器同款惯例）：
      // 仅搜索栏未开时接管——开栏并聚焦；已开则不抢（过滤流进行中，且输入框内的
      // `/` 是普通字符，上方 INPUT 守卫已放行保持默认）
      if (searchActive.value) break
      e.preventDefault()
      searchActive.value = true
      nextTick(() => searchInputRef.value?.focus())
      break
    }
  }
}

// Delete 键删除焦点项（P-20261002-134）：确认对话框在 startDelete（useFileTreeContext，
// 右键删除同链路）。成功后焦点移至相邻项：删除后原位置索引由后继项顶上（末项删除
// 则收敛到新末尾，列表删空回落无焦点），并保持滚动跟随
async function deleteFocusedItem() {
  const f = displayFiles.value[focusedIndex.value]
  if (!f) return
  const idx = focusedIndex.value
  if (!(await startDelete(f))) return
  focusedIndex.value = displayFiles.value.length
    ? Math.min(idx, displayFiles.value.length - 1)
    : -1
  if (focusedIndex.value >= 0) scrollTo(focusedIndex.value)
}

// ============== 多选（P-20261002-20）：VS Code 资源管理器同款交互 ==============
// Ctrl/Cmd+Click 增删、Shift+Click 以最近一次锚点为界取范围、普通点击清多选后
// 保持既有行为（目录 toggle / 文件打开）。多选 ≥2 时右键菜单切批量形态（见
// useFileTreeContext.contextOptions）
function handleItemClick(e: MouseEvent, file: FileEntry, index: number) {
  // 长按抬手的补发 click 吞咽（P-20261003-137）：菜单已随长按弹出，不吞则
  // 同一手势再触发目录 toggle/文件打开
  if (consumeClickIfFromLongPress()) return
  focusedIndex.value = index
  if (e.ctrlKey || e.metaKey) {
    if (selectedPaths.value.has(file.path)) selectedPaths.value.delete(file.path)
    else selectedPaths.value.add(file.path)
    selectionAnchor.value = index
    return
  }
  if (e.shiftKey) {
    const anchor = selectionAnchor.value < 0 ? index : selectionAnchor.value
    const start = Math.min(anchor, index)
    const end = Math.max(anchor, index)
    selectedPaths.value.clear()
    for (let i = start; i <= end; i++) {
      const f = displayFiles.value[i]
      if (f) selectedPaths.value.add(f.path)
    }
    return
  }
  if (selectedPaths.value.size) selectedPaths.value.clear()
  selectionAnchor.value = index
  if (file.isDir) toggleDir(file)
  else emit('file-click', file)
}

// 点空白（条目以外区域）清除多选；条目点击经 closest 过滤放行到 handleItemClick
function onTreeListClick(e: MouseEvent) {
  const el = e.target as HTMLElement | null
  if (el?.closest?.('.tree-item')) return
  if (selectedPaths.value.size) selectedPaths.value.clear()
}

// 切换隐藏文件/忽略文件显示时刷新
watch(showHidden, (v) => { saveFilterPref('showHidden', v); refreshRoot() })
watch(hideIgnored, (v) => { saveFilterPref('hideIgnored', v); refreshRoot() })

watch(() => projectStore.currentProjectId, async () => {
  files.value = []
  expandedDirs.value.clear()
  // 多选锚点随项目切换失效：路径集合按项目语义持有，跨项目残留会误伤批量操作
  selectedPaths.value.clear()
  selectionAnchor.value = -1
  // 嵌套族展开态同理按项目语义持有（路径集合，跨项目残留会错误展开新项目的同名族）
  expandedNests.value.clear()
  invalidateCache()
  await loadRoot()
  await restoreExpanded()
  await loadPins()
})

onMounted(async () => {
  if (projectStore.currentProjectId) {
    await loadRoot()
    await restoreExpanded()
    await loadPins()
  }
})

defineExpose({ refreshRoot, expandedDirs, revealFile, startCreateFile: () => startInlineCreate('file', '') })
</script>

<template>
  <div
    v-if="!projectStore.currentProjectId"
    style="display: flex; align-items: center; justify-content: center; height: 100%"
  >
    <n-empty :description="t('fileTree.noProject')" />
  </div>

  <div
    v-else-if="projectStore.currentProject?.valid === false"
    style="display: flex; align-items: center; justify-content: center; height: 100%"
  >
    <n-empty
      :description="t('fileTree.invalidProject')"
      style="padding: 0 24px"
    />
  </div>

  <div
    v-else
    class="file-tree"
  >
    <!-- 标题栏 -->
    <div class="tree-header">
      <span class="tree-title">{{ t('fileTree.title') }}</span>
      <span class="tree-project">{{ projectStore.currentProject?.name }}</span>
      <div class="tree-actions">
        <button
          class="tree-action-btn"
          :title="t('fileTree.refreshCollapse')"
          @click="refreshRoot"
        >
          <n-icon size="14" data-icon-action="common.refresh">
            <RefreshOutline />
          </n-icon>
        </button>
        <!-- 回收站（P-20261003-304）：删除的文件/目录 7 天内可恢复，根区常驻
             入口（右键面留白——P-115 目录 zip 在途同域，互不加项） -->
        <button
          class="tree-action-btn"
          :title="t('files.trash.title')"
          data-testid="trash-open"
          @click="showTrash = true"
        >
          <n-icon size="14" data-icon-action="common.recycleBin">
            <TrashBinOutline />
          </n-icon>
        </button>
        <!-- 复制改动清单（P-20261003-52）：agent 产出范围一键转述（markdown 行式
             清单），marks 非空才可用——无产出时禁用态而非隐藏，入口可发现 -->
        <button
          class="tree-action-btn"
          :title="t('fileTree.copyMarksTitle')"
          data-testid="ft-copy-marks"
          :disabled="!hasAgentMarks"
          @click="copyAgentMarksList"
        >
          <n-icon size="14" data-icon-action="common.copy">
            <CopyOutline />
          </n-icon>
        </button>
        <button
          class="tree-action-btn"
          :class="{ active: searchActive }"
          :title="t('fileTree.search')"
          @click="searchActive = !searchActive; searchQuery = ''"
        >
          <n-icon size="14" data-icon-action="common.search">
            <SearchOutline />
          </n-icon>
        </button>
        <button
          class="tree-action-btn"
          :title="showHidden ? t('fileTree.hideHidden') : t('fileTree.showHidden')"
          @click="showHidden = !showHidden"
        >
          <n-icon size="14">
            <component :is="showHidden ? EyeOutline : EyeOffOutline" />
          </n-icon>
        </button>
        <button
          class="tree-action-btn"
          :class="{ active: hideIgnored }"
          :title="hideIgnored ? t('fileTree.showIgnored') : t('fileTree.hideIgnored')"
          @click="hideIgnored = !hideIgnored"
        >
          <n-icon size="14">
            <FunnelOutline />
          </n-icon>
        </button>
        <button
          class="tree-action-btn"
          :title="t('fileTree.collapseAll')"
          @click="collapseAll"
        >
          <n-icon size="14">
            <ChevronUpOutline />
          </n-icon>
        </button>
      </div>
    </div>

    <!-- 搜索栏 -->
    <div
      v-if="searchActive"
      class="tree-search"
    >
      <n-input
        ref="searchInputRef"
        v-model:value="searchQuery"
        size="tiny"
        :placeholder="t('fileTree.searchPlaceholder')"
        clearable
        @keyup.escape="searchActive = false; searchQuery = ''"
      />
    </div>

    <!-- 已钉选目录（P-20261002-97）：常用深层目录直达位，点击定位展开+短暂高亮；
         失效（已删/改名）置灰降级可一键清理；hover 显取消钉选钮 -->
    <div
      v-if="pinnedDirs.length"
      class="pinned-dirs"
    >
      <div class="pinned-header">
        <n-icon size="11" data-icon-action="common.pin">
          <PinOutline />
        </n-icon>
        <span>{{ t('fileTree.pinned.section') }}</span>
        <button
          v-if="hasInvalidPins"
          class="pinned-clear"
          :title="t('fileTree.pinned.clearInvalid')"
          @click="clearInvalidPins"
        >
          {{ t('fileTree.pinned.clearInvalid') }}
        </button>
      </div>
      <div
        v-for="p in pinnedDirs"
        :key="p"
        class="pinned-item"
        :class="{ invalid: invalidPins.has(p) }"
        :title="invalidPins.has(p) ? `${p} · ${t('fileTree.pinned.invalid')}` : p"
        @click="revealPinned(p)"
      >
        <n-icon
          size="12"
          color="var(--accent-blue-light)"
        >
          <FolderOutline />
        </n-icon>
        <span class="pinned-name">{{ pinAlias(p) }}</span>
        <button
          class="pinned-unpin"
          :title="t('fileTree.pinned.unpin')"
          @click.stop="togglePin(p)"
        >
          <n-icon size="11">
            <CloseOutline />
          </n-icon>
        </button>
      </div>
    </div>

    <!-- 文件列表 -->
    <div
      ref="treeListRef"
      class="tree-list"
      :class="{ 'is-upload-hover': uploadHover, 'is-moving': moving || batchRenaming }"
      tabindex="0"
      :title="t('fileTree.f2RenameHint')"
      @contextmenu="handleBackgroundContext"
      @keydown="handleTreeKeydown"
      @paste="handlePasteEvent"
      @click="onTreeListClick"
      @dragover="onRootDragOver"
      @dragenter.self="uploadHover = hasExternalFiles($event); onRootDragOver($event)"
      @dragleave.self="uploadHover = false"
      @drop="onRootDrop"
    >
      <!-- 上传进度浮条（P-20261003-117）：拖入/右键上传共用，悬浮树列表顶部
           （树头下缘）不挤占树布局；逐文件串行上传，N/M 文件 + 当前文件名推进，
           全部成功自动撤下（成功 toast 沿用聚合文案），失败停留为可定点/全部
           重试的清单，也可手动关闭放弃 -->
      <div
        v-if="uploadVisible"
        class="upload-float"
        data-testid="upload-float"
      >
        <div class="upload-float-head">
          <span
            v-if="uploading"
            class="upload-float-text"
            data-testid="upload-progress-text"
          >{{ t('fileTree.uploadProgress', { done: uploadDone, total: uploadTotal, name: uploadCurrent }) }}</span>
          <span
            v-else
            class="upload-float-text is-failed"
            data-testid="upload-failed-title"
          >{{ t('fileTree.uploadFailedTitle', { n: uploadFailed.length }) }}</span>
          <button
            v-if="!uploading"
            class="upload-float-dismiss"
            :title="t('fileTree.uploadDismiss')"
            data-testid="upload-dismiss"
            @click="dismissUploadPanel"
          >
            <n-icon size="12">
              <CloseOutline />
            </n-icon>
          </button>
        </div>
        <div class="upload-float-bar">
          <div
            class="upload-float-fill"
            :style="{ width: uploadBarPct + '%' }"
          />
        </div>
        <div
          v-if="uploadFailed.length"
          class="upload-float-failed"
          data-testid="upload-failed-list"
        >
          <div
            v-for="(f, i) in uploadFailed"
            :key="i"
            class="upload-float-fitem"
          >
            <span
              class="upload-float-fname"
              :title="f.file.name"
            >{{ f.file.name }}</span>
            <button
              class="upload-float-retry"
              data-testid="upload-retry-one"
              @click="retryUploadOne(f)"
            >{{ t('fileTree.uploadRetry') }}</button>
          </div>
          <button
            v-if="uploadFailed.length > 1"
            class="upload-float-retry-all"
            data-testid="upload-retry-all"
            @click="retryUploadAllFailed"
          >{{ t('fileTree.uploadRetryAll') }}</button>
        </div>
      </div>

      <div
        v-if="loading && files.length === 0"
        class="tree-loading"
      >
        <n-spin size="small" />
      </div>

      <div
        v-else-if="files.length === 0"
        class="tree-empty"
      >
        <n-empty :description="t('fileTree.emptyDir')" />
      </div>

      <template v-else>
        <!-- 虚拟滚动容器 -->
        <div
          v-bind="containerProps"
          class="virtual-list-container"
        >
          <div v-bind="wrapperProps">
            <div
              v-for="{ data: file, index } in list"
              :key="file.path"
              class="tree-item"
              :class="{
                focused: index === focusedIndex,
                selected: selectedPaths.has(file.path),
                'drag-over': dropTarget === file.path && file.isDir,
                'pinned-flash': flashPath === file.path,
                'is-nest-child': isNestChild(file.path),
                'is-cut': cutPaths.has(file.path),
              }"
              :style="{ paddingLeft: (12 + (getIndentLevel(file.path) + (isNestChild(file.path) ? 1 : 0)) * 16) + 'px', '--indent': getIndentLevel(file.path) + (isNestChild(file.path) ? 1 : 0) }"
              draggable="true"
              @pointerdown="onTreeItemPointerDown($event, file)"
              @click="handleItemClick($event, file, index)"
              @contextmenu.stop="handleContextMenu($event, file)"
              @dragstart="onDragStart($event, file)"
              @dragover="onDragOver($event, file)"
              @dragleave="onDragLeave"
              @drop="onDrop($event, file)"
            >
              <span class="item-icon">
                <template v-if="file.isDir">
                  <span class="dir-arrow">{{ expandedDirs.has(file.path) ? '▼' : '▶' }}</span>
                  <n-icon
                    size="14"
                    :color="'var(--accent-blue-light)'"
                  >
                    <component :is="expandedDirs.has(file.path) ? FolderOpenOutline : FolderOutline" />
                  </n-icon>
                </template>
                <template v-else>
                  <span
                    class="file-icon-dot"
                    :style="{ background: getFileIconColor(file.name, false) }"
                  />
                </template>
              </span>
              <span :class="['item-name', file.isDir ? 'is-dir' : '', file.name.startsWith('.') ? 'is-hidden' : '', file.isIgnored ? 'is-ignored' : '']">{{ file.name }}</span>
              <!-- 同名族嵌套角标（P-20261006-21）：主文件行折叠 N 个同名子文件，
                   点击展开/收起（子行紧随其后插入）；click.stop 防触发行点击打开，
                   enter.stop 防冒泡树的 Enter=打开语义（目录驻留徽标同款纪律）。
                   嵌套关/搜索过滤态 nestMainCount 恒 0 → 角标不渲染 -->
              <button
                v-if="nestMainCount(file.path) > 0"
                class="nest-badge"
                :class="{ open: expandedNests.has(file.path) }"
                :title="expandedNests.has(file.path) ? t('fileTree.nestCollapse') : t('fileTree.nestExpand', { n: nestMainCount(file.path) })"
                data-testid="nest-badge"
                @click.stop="toggleNest(file.path)"
                @keydown.enter.stop
              >+{{ nestMainCount(file.path) }}</button>
              <!-- 目录会话驻留徽标（P-20261004-41）：驻留该目录的 agent 会话数
                   （弱样式），hover title 列会话名/状态（运行中 ● 点亮），点击
                   跳会话（多会话先弹选择菜单）；click.stop 防触发目录 toggle，
                   enter.stop 防 keydown 冒泡到树的 Enter=toggleDir 语义 -->
              <button
                v-if="file.isDir && dirSessionsAt(file.path).length > 0"
                class="dir-session-badge"
                :title="dirSessionTip(file.path)"
                data-testid="dir-session-badge"
                @click.stop="onDirBadgeClick($event, file.path)"
                @keydown.enter.stop
              >{{ dirSessionsAt(file.path).length }}</button>
              <span
                v-if="agentMarks.has(file.path) && !file.isDir"
                class="item-agent-dot"
                :title="t('fileTree.agentMarkTip', { runtime: agentMarks.get(file.path)?.runtimes.join('/') || '' })"
              />
              <span
                v-if="file.isIgnored"
                class="item-ignored-badge"
              >{{ t('fileTree.ignored') }}</span>
              <span
                v-if="file.status && !file.isDir"
                class="item-status"
                :style="{ color: getStatusColor(file.status) }"
              >{{ getStatusLabel(file.status) }}</span>
              <span
                v-else-if="file.isDir && dirStatusMap.get(file.path)"
                class="item-status"
                :style="{ color: getStatusColor(dirStatusMap.get(file.path)) }"
              >{{ getStatusLabel(dirStatusMap.get(file.path)) }}</span>
            </div>
          </div>
        </div>
      </template>

      <!-- 内联输入:悬浮底部条(始终可见),程序化聚焦;Enter 走 IME 安全确认;
           重命名目标已存在(P-117)或名称跨平台不兼容(P-132,输入期间即时命中)时
           输入框红态 + 下方红字提示（就地修正,输入行不关闭） -->
      <div
        v-if="inlineInput"
        ref="inlineRowRef"
        class="inline-input-row"
        :style="{ paddingLeft: inlineInput.parentPath ? (12 + (inlineInput.parentPath.split('/').length) * 16) + 'px' : '12px' }"
      >
        <n-input
          ref="inlineInputRef"
          v-model:value="inlineValue"
          size="tiny"
          :status="(inlineError || inlineCompatError) ? 'error' : undefined"
          :placeholder="inlineInput.type === 'dir' ? t('fileTree.dirPlaceholder') : inlineInput.type === 'rename' ? t('fileTree.newNamePlaceholder') : t('fileTree.fileNamePlaceholder')"
          @keydown.enter="onInlineEnter"
          @keyup.escape="cancelInlineInput"
          @blur="cancelInlineInput"
        />
        <div
          v-if="inlineError || inlineCompatError"
          class="inline-input-error"
          data-testid="inline-rename-error"
        >
          {{ inlineCompatError || inlineError }}
        </div>
      </div>

      <!-- 右键「上传文件」的系统选择器（隐藏，多选） -->
      <input
        ref="fileInput"
        type="file"
        multiple
        class="upload-input"
        @change="onFilePicked"
      >
    </div>
  </div>

  <!-- 右键菜单 -->
  <NDropdown
    placement="bottom-start"
    trigger="manual"
    :x="contextX"
    :y="contextY"
    :options="contextOptions"
    :show="showContext"
    @select="handleContextSelect"
    @clickoutside="showContext = false"
  />

  <!-- 目录驻留徽标的多会话选择菜单（P-20261004-41）：同目录多会话时点徽标先选
       再跳（行文案「名称 · 状态」，选择即 jumpToSession 统一链） -->
  <NDropdown
    placement="bottom-start"
    trigger="manual"
    :x="sessionMenuX"
    :y="sessionMenuY"
    :options="sessionMenuOptions"
    :show="sessionMenuShow"
    @select="onSessionMenuSelect"
    @clickoutside="sessionMenuShow = false"
  />

  <!-- 本地文件历史（P-20261002-130）：右键「本地历史」弹窗（懒挂载） -->
  <LocalHistoryModal
    v-if="localHistoryPath"
    :key="'lhm-' + localHistoryRetryTick"
    v-model:show="showLocalHistory"
    :project-id="projectStore.currentProjectId || ''"
    :file="localHistoryPath"
    @retry="localHistoryRetryTick++"
    @restored="refreshTargetPath(localHistoryPath.split('/').slice(0, -1).join('/'))"
  />

  <!-- 文件改动来源归因（P-20261005-170）：右键「改动来源」弹窗（懒挂载，只读账面） -->
  <FileAttributionModal
    v-if="fsAttributionPath"
    v-model:show="showFsAttribution"
    :project-id="projectStore.currentProjectId || ''"
    :file="fsAttributionPath"
  />

  <!-- 回收站（P-20261003-304）：树头部按钮直达，恢复成功整树刷新；
       冲突「打开目标位置」（P-20261006-15）关浮层 revealFile 定位占位文件 -->
  <TrashModal
    v-model:show="showTrash"
    :project-id="projectStore.currentProjectId || ''"
    @restored="onTrashRestored"
    @locate="onTrashLocate"
  />

  <!-- 批量移动「移动到…」（P-20261003-160）：右键批量菜单入口，选择后走
       moveEntries（与多选拖拽同链路，批量端点单请求收口 + 逐条跳过报告） -->
  <MoveToDialog
    v-model:show="showMoveTo"
    :project-id="projectStore.currentProjectId || ''"
    :paths="moveToPaths"
    @select="onMoveToSelect"
  />

  <!-- 批量重命名（P-20261003-283）：右键批量菜单入口，查找/替换 + 实时预览
       （非法红标），确认后走 useBatchRename 执行链（逐个 rename + 跳过报告） -->
  <BatchRenameDialog
    v-model:show="showBatchRename"
    :paths="batchRenamePaths"
    @apply="onBatchRenameApply"
  />

  <!-- 重命名后引用更新（P-20261005-157）：search-replace 既有预览弹层复用——
       勾选/排除/逐行对照与执行链同函数纪律全在组件与组合式内收口；低置信文件
       挂徽标且默认不勾，备份勾选隐藏（执行链已强制服务端留档，离手副本双份
       下载无益） -->
  <ReplacePreviewModal
    v-model:show="refUpdateShow"
    :files="refUpdateFiles"
    :selected-paths="refUpdateSelected"
    :low-confidence-paths="refUpdateLowConf"
    :executing="refUpdateExecuting"
    :show-backup="false"
    @toggle-file="refUpdateToggleFile"
    @toggle-all="refUpdateToggleAll"
    @confirm="refUpdateConfirm"
  />
</template>

<style scoped src="./file-tree-view.css">
.item-agent-dot {
  flex-shrink: 0; width: 6px; height: 6px; border-radius: 50%;
  background: var(--accent-purple); margin-left: auto; margin-right: 4px;
}
</style>
