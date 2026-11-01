<script setup lang="ts">
// 编辑器组面板（分屏 MVP）：单个编辑器组的标签行 + 面包屑 + 内容区。
// 从 EditorArea 抽出——EditorArea 负责双组布局/分隔条/活跃组切换，本组件
// 只渲染一组，组间状态互不感知；「点任意区域激活本组」由根节点 mousedown 上抛
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount, shallowRef } from 'vue'
import { NIcon, NDropdown } from 'naive-ui'
import {
  PinOutline, ChevronDownOutline,
  ListOutline, DocumentTextOutline,
  LockClosedOutline, CreateOutline,
} from '@vicons/ionicons5'
// Monaco 懒加载（与 DiffEditor/CommitPanel 同范式）：编辑器 chunk 3.6MB+
// 不再绑死项目页首屏（只开终端/远程控制台的用户不付这笔下载+解析成本）。
// nls 语言包经 ensureMonacoNls() 先于 monaco 求值（原 main.ts 顶层 await
// 已迁入本懒加载链，首屏不再被语言包阻塞）
import { ensureMonacoNls } from '@/utils/monaco-nls'
import { safeAsync } from '@/utils/async-component'
import { getFileIconColor } from '@/utils/fileIcon'
const MonacoEditor = safeAsync(() => ensureMonacoNls().then(() => import('@/views/editor/MonacoEditor.vue').then(m => m.default)))
const DiffEditor = safeAsync(() => ensureMonacoNls().then(() => import('@/views/editor/DiffEditor.vue').then(m => m.default)))
import WelcomePanel from '@/components/editor/WelcomePanel.vue'
import Breadcrumb from '@/components/common/Breadcrumb.vue'
import EncodingBadge from '@/components/editor/EncodingBadge.vue'
import EolBadge from '@/components/editor/EolBadge.vue'
import CursorPositionBadge from '@/components/editor/CursorPositionBadge.vue'
const CommitPanel = safeAsync(() => import('@/views/git/CommitPanel.vue'))
import { useI18n } from '@/composables/useI18n'
import { useNarrowLayout } from '@/composables/useNarrowLayout'
import { useEditorAskAgent } from '@/composables/useEditorAskAgent'
import { useFileDeepLink } from '@/composables/useFileDeepLink'
import { useEditorCopyPath } from '@/composables/useEditorCopyPath'
import { useEditorTreeLocate } from '@/composables/useEditorTreeLocate'
import { useEditorReveal } from '@/composables/useEditorReveal'
import { useShareDialog } from '@/composables/useShareDialog'
import { draggingTabGroupId } from '@/composables/editorTabDragSession'
import { useLayoutLockStore } from '@/stores/layoutLock'
import { useFontStore } from '@/stores/font'
import { useChangesStore } from '@/stores/changes'
import { useProjectStore } from '@/stores/project'
import { isRemoteEditorPath, parseRemoteEditorPath, remoteHostDisplayName } from '@/utils/remoteEditorPath'
import { isUntitledPath, type OpenFile } from '@/composables/useOpenFiles'
import { buildGitTabStatusMap, type GitTabKind } from '@/utils/git'
// 仅类型引入（编译期擦除，不把 monaco 桥拽进首屏 chunk——symbolCrumbBridge
// 随编辑器 chunk 加载）
import type { SymbolCrumbPayload } from '@/views/editor/symbolCrumbBridge'
// tab 右键「复制引用」读 viewState 最后已知光标行（P-20261006-17）：本模块对
// monaco 仅类型依赖（import type），主 chunk 导入不进编辑器 chunk；monaco.Uri
// 键推导的实现由 MonacoEditor 挂载期经注册表注入（monacoViewStateMoves 同款）
import { viewStateCursorLineOf } from '@/views/editor/monacoViewStateCache'

const { t } = useI18n()
// 「就此文件询问智能体」（P-20261001-28）：非编辑器状态修改的全局动作，
// 不走 emit 链（同 EditorGitActions 直调组合式的口径）
const { askAgentAboutFile } = useEditorAskAgent()
// 「复制文件链接」（P-20261002-49）：拼深链 URL 入剪贴板，同上直调组合式
const { copyFileLink } = useFileDeepLink()
// 「复制路径/文件名/绝对路径」（P-20261002-88）：路径贴给 agent/外部工具免手拼，
// 同上直调组合式
const { copyFilePath, copyFileName, copyAbsoluteFilePath, copyFileReference } = useEditorCopyPath()
// 「在文件树中定位」（P-20261003-294）：tab 项目相对路径派发 OPS_LOCATE_IN_TREE，
// 同上直调组合式（侧栏可见性/展开/滚动由接收方 FileTreeView 负责）
const { locateInTree } = useEditorTreeLocate()
// 「在系统中显示」（P-20261003-323）：调服务端在宿主文件管理器定位目标文件，
// 同上直调组合式
const { revealInSystem } = useEditorReveal()
// 「分享」（P-20261020-8）：项目内已保存文件复用 useShareDialog.createShare
// （创建弹层/敏感扫描/结果卡全链在模块级单例内，与文件树右键同一入口）
const shareDialog = useShareDialog()
const projectStore = useProjectStore()

// safeAsync 组件手动重试：递增后作为 :key 触发重新挂载（重新执行 loader）
const asyncRetryTick = ref(0)

const props = defineProps<{
  /** 编辑器组号（0 主组 / 1 分屏组）：透传 MonacoEditor，视图状态按组分桶 */
  groupIndex: number
  files: OpenFile[]
  activeIndex: number
  /** 「重新打开已关闭的标签」菜单项可用态（关闭栈为全组共享） */
  canReopenClosed: boolean
  /** 侧栏模式提交面板随本组渲染（仅主组传入） */
  showCommitPanel?: boolean
  /** 本组 tab 右键菜单提供「在右侧分屏打开」（仅主组；分屏组提供「关闭分屏」） */
  allowSplitOpen?: boolean
}>()

// ── 所有状态修改通过 emit 通知父组件 ──────────────────────────
const emit = defineEmits<{
  /** 点击本组任意区域：激活组（活跃组高亮/快捷键/保存跟随） */
  activate: []
  switchFile: [index: number]
  closeFile: [index: number]
  /** 脏点点击「保存并关闭」（P-20261003-138）：转调 useOpenFiles.saveCloseFileInGroup */
  saveCloseFile: [index: number]
  /** tab/编辑器右键「放弃未保存修改」（P-20261005-156）：转调
   *  useOpenFiles.revertFileInGroup（作用对象 = 本组该下标文件） */
  revertFile: [index: number]
  updateContent: [path: string, content: string]
  togglePin: [index: number]
  saveCurrentFile: []
  /** 编码徽标菜单（P-20261002-146）：以指定编码重载 / 转为指定编码保存
   *  （动作作用于本组当前文件；转调 useOpenFiles 同名动作） */
  reloadWithEncoding: [encoding: string]
  saveWithEncoding: [encoding: string]
  openFile: [path: string]
  /** 树拖文件到 tab 条按落点插入打开（P-20261004-74）：path=树载荷路径，
   *  index=dragover 期算得的插入下标（宿主转 openFileByPath opts.insertAt） */
  openFileAt: [path: string, index: number]
  newFile: []
  openCommandPalette: []
  openProject: []
  openSettings: []
  revealInFileTree: []
  compareClipboard: [payload: { path: string; text: string }]
  openOutline: []
  closeOtherTabs: [index: number]
  closeAllTabs: []
  closeTabsToRight: [index: number]
  closeSavedTabs: []
  reopenClosedTab: []
  dragReorder: [from: number, to: number]
  /** 对侧组 tab 拖入落本组（移动语义，P-20261003-38）：fromGi=源组号，path=签路径 */
  tabMoveIn: [fromGi: number, path: string]
  /** 主组 tab 右键 → 在右侧/下方分屏打开（P-20261005-230 增方向：缺省横向） */
  openInSplit: [path: string, direction?: 'horizontal' | 'vertical']
  /** 分屏组菜单/空态 → 关闭分屏（文件并回主组尾部） */
  closeSplit: []
  /** 组 tab 条空白区双击 → 组临时最大化 toggle（P-20261004-64，VS Code
   *  「Maximize Editor Group」同位交互；作用于本组，宿主 EditorArea 直调
   *  usePanelLayout 布局态） */
  toggleMaximize: []
  /** 远程文件离线横幅「重试」（P-20261003-15）：重拉远端内容 */
  remoteRetry: [path: string]
}>()

const currentFile = computed(() => props.files[props.activeIndex] ?? null)

// ── diff 伪 tab 切文件的实例热切（P-20261004-100）────────────────
// 审阅 agent 批量改动 = 逐文件开新 diff tab，而每个新 tab 打开链先落 loading
// 占位——若把编辑器区翻成 loading 文案，DiffEditor 整个卸载、内容就位后重挂
// 全新实例（P-40 实测：会话级开关 aria-pressed 回 false、滚动位/装饰全失）。
// loading 窗口内改呈「上一个就绪 diff」的内容（同一 :key，实例与开关态自然
// 延续），目标内容到位后 props 驱动 DiffEditor 走 setModel 热切（model 对经
// monacoDiffModelPool 复用）。诚实边界：diff↔普通文件切换是形态变化仍重挂，
// loading 分支保留给该场景与无前置 diff 的首开。
const lastReadyDiff = shallowRef<OpenFile | null>(null)

// currentFile 是就绪 diff 时记为呈现候选；切到非 diff（含项目切换清场/关闭）
// 即清——loading 占位只在「前面确实站着一个本组 diff」时才被它顶住
watch(
  () => {
    const f = currentFile.value
    if (!f?.isDiff) return null
    // undefined 哨兵 = 装载中不改变记忆（与 null「清」区分）
    return f.loading ? undefined : f
  },
  (v) => { if (v !== undefined) lastReadyDiff.value = v },
)

/** 编辑器内容区实际呈现的文件：装载中的 diff tab 若有就绪前置 diff 则沿用
 *  之（热切窗口），其余形态与 currentFile 一致 */
const displayFile = computed<OpenFile | null>(() => {
  const cur = currentFile.value
  if (cur?.isDiff && cur.loading && lastReadyDiff.value) return lastReadyDiff.value
  return cur
})

// ── 窄屏只读默认（P-20261019-7）────────────────────────────────
// 手机/平板（≤700px）软键盘与手势误触风险高：编辑器默认只读，顶部一条
// 轻量模式条提供「开始编辑」切换；只读态与远程离线只读正交（任一为真即
// 只读），离线横幅优先于本条的编辑切换（远端不可写时切编辑无意义）。
const {
  narrow,
  narrowEditorEditing,
  toggleNarrowEditorEditing,
} = useNarrowLayout()

const narrowEditorModeAvailable = computed(() => {
  const f = currentFile.value
  if (!narrow.value || !f) return false
  return !f.isDiff && !f.meta && !f.loading && !f.remoteOffline
})

const narrowEditorReadOnly = computed(() => narrow.value && !narrowEditorEditing.value)

/** Monaco 只读合并：远程离线降级只读 ∪ 窄屏默认只读 */
const editorReadOnly = computed(() => !!displayFile.value?.remoteOffline || narrowEditorReadOnly.value)

// ── tab git 状态着色（P-20261003-242）────────────────────────
// 开关默认关（视觉克制，font store editor 段，与 stickyScroll/formatOnSave
// 同一承载与生效模式）。数据面 = changes store 缓存（boot/切项目/WS
// file.changed/保存后四路刷新），查表零新增请求；Map 重建只在 fetchStatus
// 落定后发生，量级 = 未提交变更文件数（通常几十内），无热路径成本
const fontStore = useFontStore()
const changesStore = useChangesStore()
const gitTabStatusMap = computed(() => buildGitTabStatusMap(changesStore.files))

/** tab 的 git 状态档：开关关 / diff 伪路径 / 远程伪路径 / 未命名草稿 /
 *  不在变更集内 → null（不着色）。真实项目磁盘文件才参与（后三者对本地
 *  git 仓库无意义，同 canAskContextTab 守卫口径） */
function gitTabKindOf(file: OpenFile): GitTabKind | null {
  if (!fontStore.editor.gitStatusTabs) return null
  if (file.isDiff || isRemoteEditorPath(file.path) || isUntitledPath(file.path)) return null
  return gitTabStatusMap.value.get(file.path) ?? null
}

// ── 远程 tab 主机徽标与悬停路径（P-20261004-138）────────────────
// 本地/远程同名文件两个 tab 同名同类型色点同位置，tab 栏扫读分不清，保存
// （Ctrl+S）改错目标即直达 SFTP 回写远端。远程签三面识别（本地 tab 零改动）：
// ① 名前主机别名首字符色片（形状/尺寸与类型色点 8px 圆、脏点 6px 圆、diff
//    6px 方点双错位防视觉冲突）；② title 悬停 =「别名:远端绝对路径」（本地
//    tab 保持现状仅预览位提示；远程签兼处预览位时远程身份优先——误写远端是
//    安全关键信息，预览位已有斜体语义）；③ aria-label 携别名（读屏扫读可辨）。
// hostId→别名复用 remoteEditorPath.remoteHostDisplayName（与 Breadcrumb 同源
// 模块级缓存：未命中静默拉一次列表，失败回退裸 hostId——展示层降级不影响
// 保存寻址）；diff 伪路径可内嵌 remote: 段但那是 diff 视图非远程签，不显示
// 徽标（同类型色点「diff 不显示」惯例）
interface RemoteTabMeta { alias: string; rpath: string; badge: string }

const remoteTabMetas = computed<(RemoteTabMeta | null)[]>(() =>
  props.files.map((f) => {
    if (f.isDiff) return null
    const parts = parseRemoteEditorPath(f.path)
    if (!parts) return null
    const alias = remoteHostDisplayName(parts.hostId)
    return { alias, rpath: parts.rpath, badge: Array.from(alias)[0] || '' }
  }),
)

/** tab 悬停 title：远程 =「别名:远端绝对路径」，其余维持现状（预览位提示） */
function tabTitleOf(file: OpenFile, idx: number): string | undefined {
  const meta = remoteTabMetas.value[idx]
  if (meta) return `${meta.alias}:${meta.rpath}`
  return file.isPreview ? t('editor.previewTab.title') : undefined
}

/** tab aria-label：远程携主机别名（「文件名 (别名)」），其余维持现状 = 文件名 */
function tabAriaLabelOf(file: OpenFile, idx: number): string {
  const meta = remoteTabMetas.value[idx]
  if (!meta) return file.name
  return `${file.name} (${meta.alias})`
}

// ── 标签页右键菜单 ─────────────────────────────────────────
const tabContextMenuIndex = ref(-1)
const tabContextMenuX = ref(0)
const tabContextMenuY = ref(0)
const showTabContextMenu = ref(false)

function handleTabContextMenu(e: MouseEvent, idx: number) {
  e.preventDefault()
  tabContextMenuIndex.value = idx
  tabContextMenuX.value = e.clientX
  tabContextMenuY.value = e.clientY
  showTabContextMenu.value = true
}

function closeTabContextMenu() {
  showTabContextMenu.value = false
}

// ── 组 tab 条空白区双击 → 组临时最大化（P-20261004-64）──────────
// 对标 VS Code 双击组 tab 条最大化该组。双击落在 tab 本身时是「固定标签」
// 既有语义（.editor-tab 的 dblclick 已 .stop 不会冒泡到这里），防御性再判
// 一次 closest 兜底（事件合成/测试直派不经冒泡链的场景）
function onTabsRowDblclick(e: MouseEvent) {
  if ((e.target as HTMLElement | null)?.closest('.editor-tab')) return
  emit('toggleMaximize')
}

/** 右键菜单目标 tab 是否可分屏（主组专属入口；diff 伪路径无法按路径重开不提供） */
const canSplitContextTab = computed(() =>
  !!props.allowSplitOpen && !props.files[tabContextMenuIndex.value]?.isDiff,
)

/** 右键菜单目标 tab 是否可询问智能体：diff/远程伪路径/未命名草稿不对应项目内
 *  真实文件不提供（agent 上下文按项目路径寻址，remote: 伪路径与 untitled://N
 *  内部键对 agent 均无意义——草稿误点会让 agent 拿内部键找文件 404，P-20261003-96） */
const canAskContextTab = computed(() => {
  const f = props.files[tabContextMenuIndex.value]
  return !f?.isDiff && !isRemoteEditorPath(f?.path || '') && !isUntitledPath(f?.path || '')
})

/** 右键菜单目标 tab 是否为真实磁盘文件（复制深链/路径/文件名/绝对路径共用）：
 * diff/远程伪路径非项目磁盘文件不提供（同 canAskContextTab） */
const canCopyFileContextTab = computed(() => {
  const f = props.files[tabContextMenuIndex.value]
  return !f?.isDiff && !isRemoteEditorPath(f?.path || '')
})

/** 右键菜单目标 tab 是否可复制引用（P-20261006-17）：untitled 草稿的内部键
 *  （untitled://N）无项目相对路径语义，拼行号无意义不提供（diff/远程已被
 *  canCopyFileContextTab 守卫，编辑器右键侧同口径） */
const canCopyReferenceContextTab = computed(() => {
  const f = props.files[tabContextMenuIndex.value]
  return canCopyFileContextTab.value && !!f && !isUntitledPath(f.path)
})

/** 右键菜单目标 tab 是否可在文件树中定位（P-20261003-294）：定位目标是项目
 *  文件树，diff/远程伪路径不对应项目内真实文件不提供（同 canAskContextTab） */
const canLocateContextTab = computed(() => {
  const f = props.files[tabContextMenuIndex.value]
  return !f?.isDiff && !isRemoteEditorPath(f?.path || '')
})

/** 右键菜单目标 tab 是否可分享（P-20261020-8）：仅项目内已保存文件——
 *  diff/远程伪路径/未命名草稿不提供（同 canCopyFileContextTab 族），另排除
 *  加载中与未保存修改：服务端分享取磁盘版本，脏缓冲分享会让访客看到与屏幕
 *  不一致的旧内容（提案「只对项目内已保存文件开放」） */
const canShareContextTab = computed(() => {
  const f = props.files[tabContextMenuIndex.value]
  return !!f && !f.isDiff && !isRemoteEditorPath(f.path) && !isUntitledPath(f.path)
    && !f.loading && f.content === f.originalContent
})

/** 右键菜单目标 tab 是否可「放弃未保存修改」（P-20261005-156，VS Code Revert
 *  File 对位）：仅脏 tab 提供（content!==originalContent 判定现成）；diff 伪键
 *  与 untitled 草稿无磁盘/远端基线不提供。远程伪路径不排除——执行域按路径
 *  分流（本地 loadDiskVersion / 远程 loadRemoteVersion），放弃语义两侧一致 */
const canRevertContextTab = computed(() => {
  const f = props.files[tabContextMenuIndex.value]
  return !!f && !f.isDiff && !isUntitledPath(f.path) && f.content !== f.originalContent
})

/** 本组当前显示文件是否可「放弃未保存修改」（P-20261005-156）：Monaco 仅为本
 *  文件挂载，编辑器右键菜单项经 dirty prop（→ Monaco 上下文键）只对脏文件可见，
 *  点击转组级 revertFile（作用对象即 activeIndex 位） */
const currentFileRevertable = computed(() => {
  const f = displayFile.value
  return !!f && !f.isDiff && !isUntitledPath(f.path) && f.content !== f.originalContent
})

function onContextRevertFile() {
  emit('revertFile', tabContextMenuIndex.value)
  closeTabContextMenu()
}

function onContextReopenClosed() {
  if (!props.canReopenClosed) return
  emit('reopenClosedTab')
  closeTabContextMenu()
}

function onContextOpenInSplit(direction: 'horizontal' | 'vertical' = 'horizontal') {
  const f = props.files[tabContextMenuIndex.value]
  if (!f || f.isDiff) return
  emit('openInSplit', f.path, direction)
  closeTabContextMenu()
}

/** 就此文件询问智能体：仅目标 tab 正是本组活动 tab 时带光标行号（Monaco
 *  只挂载当前显示文件，其余 tab 的光标位置无从谈起，整文件询问） */
function onContextAskAgent() {
  const f = props.files[tabContextMenuIndex.value]
  if (!f || f.isDiff) return
  const line = tabContextMenuIndex.value === props.activeIndex
    ? (monacoEditorRef.value?.getEditor()?.getPosition()?.lineNumber ?? undefined)
    : undefined
  void askAgentAboutFile(f.path, line)
  closeTabContextMenu()
}

/** 在文件树中定位（P-20261003-294）：目标 tab（不限活动 tab）的项目相对路径
 *  派发 OPS_LOCATE_IN_TREE（终端侧 useTerminalTreeLocate 同款事件契约），
 *  接收方保证侧栏可见 + 逐层展开 + 滚动定位 */
function onContextLocateInTree() {
  const f = props.files[tabContextMenuIndex.value]
  if (!f || f.isDiff) return
  void locateInTree(f.path)
  closeTabContextMenu()
}

/** 分享：目标 tab 的项目内已保存文件 → 模块级创建弹层（文件树右键同链）；
 *  projectId 空守卫在 createShare 内（不弹不报错），tab 只存在于项目上下文 */
function onContextShare() {
  const f = props.files[tabContextMenuIndex.value]
  if (!f || f.isDiff) return
  shareDialog.createShare(projectStore.currentProjectId || '', f.path, f.name)
  closeTabContextMenu()
}

function onContextTogglePin() {
  emit('togglePin', tabContextMenuIndex.value)
  closeTabContextMenu()
}

/** 复制文件深链（?project=&file=）：打开链接即直达编辑器激活本 tab 的文件 */
function onContextCopyLink() {
  const f = props.files[tabContextMenuIndex.value]
  if (!f || f.isDiff) return
  void copyFileLink(f.path)
  closeTabContextMenu()
}

/** 复制项目相对路径（正斜杠归一，贴给 agent/外部工具免手拼） */
function onContextCopyPath() {
  const f = props.files[tabContextMenuIndex.value]
  if (!f || f.isDiff) return
  void copyFilePath(f.path)
  closeTabContextMenu()
}

/** 复制引用（路径:行，P-20261006-17）：格式与 Quick Open 行号直达语法严格一致
 *  （复制→粘贴→直达闭环）。行号来源——活动 tab 用编辑器实时光标行（询问智能体
 *  onContextAskAgent 同口径），非活动 tab 用 viewState 快照的最后已知光标行
 *  （切 tab 恢复数据同源）；两处皆无（未打开过内容，如刷新后未激活的恢复签）
 *  降级纯路径（缺行号仍是 palette 合法输入） */
function onContextCopyReference() {
  const f = props.files[tabContextMenuIndex.value]
  if (!f || f.isDiff) return
  const line = tabContextMenuIndex.value === props.activeIndex
    ? (monacoEditorRef.value?.getEditor()?.getPosition()?.lineNumber
        ?? viewStateCursorLineOf(props.groupIndex, f.path))
    : viewStateCursorLineOf(props.groupIndex, f.path)
  void copyFileReference(f.path, line)
  closeTabContextMenu()
}

/** 复制文件名（路径末段） */
function onContextCopyFileName() {
  const f = props.files[tabContextMenuIndex.value]
  if (!f || f.isDiff) return
  void copyFileName(f.path)
  closeTabContextMenu()
}

/** 复制绝对路径（项目根拼接） */
function onContextCopyAbsPath() {
  const f = props.files[tabContextMenuIndex.value]
  if (!f || f.isDiff) return
  void copyAbsoluteFilePath(f.path)
  closeTabContextMenu()
}

/** 在系统中显示（P-20261003-323）：服务端按平台 exec 宿主文件管理器定位该文件
 *  （远程实例形态下打开的是实例宿主侧窗口，headless 501 明确报错） */
function onContextRevealInSystem() {
  const f = props.files[tabContextMenuIndex.value]
  if (!f || f.isDiff) return
  void revealInSystem(f.path)
  closeTabContextMenu()
}

function onContextClose() {
  emit('closeFile', tabContextMenuIndex.value)
  closeTabContextMenu()
}

function onContextCloseOthers() {
  emit('closeOtherTabs', tabContextMenuIndex.value)
  closeTabContextMenu()
}

function onContextCloseRight() {
  emit('closeTabsToRight', tabContextMenuIndex.value)
  closeTabContextMenu()
}

function onContextCloseSaved() {
  emit('closeSavedTabs')
  closeTabContextMenu()
}

function onContextCloseAll() {
  emit('closeAllTabs')
  closeTabContextMenu()
}

// ── 标签拖拽排序 ──────────────────────────────────────────
const draggedTabIndex = ref<number | null>(null)

/** 中键关闭标签（VS Code/浏览器惯例）：pinned 标签不受中键影响 */
function onTabAuxClick(e: MouseEvent, idx: number) {
  if (e.button !== 1) return
  e.preventDefault()
  if (props.files[idx]?.pinned) return
  emit('closeFile', idx)
}

function onTabDragStart(idx: number, e: DragEvent) {
  // 布局锁定（P-20261003-180）：tab 重排/跨组拖拽统一短路（preventDefault
  // 即拖拽不启动），点击/键盘切签不受影响
  if (useLayoutLockStore().interceptDrag(e)) return
  draggedTabIndex.value = idx
  // 跨组移动载荷（P-20261003-38）：x-sc-editor-tab + text/plain 双 payload
  // （树拖放 x-sc-file-path 同款惯例，text/plain 兜底 Firefox 不进拖拽态）。
  // dragover 保护模式读不到数据，源组号另经 draggingTabGroupId 登记供高亮
  // 门控；payload 供 drop 定案（含 path——组内重排会移动下标，路径才稳定）
  draggingTabGroupId.value = props.groupIndex
  const f = props.files[idx]
  if (!f || !e.dataTransfer) return
  e.dataTransfer.setData(SC_TAB_TYPE, JSON.stringify({ groupId: props.groupIndex, path: f.path }))
  e.dataTransfer.setData('text/plain', f.name)
  // Alt=复制 / 默认移动两态都要可用（树拖放 onDragStart 同款）
  e.dataTransfer.effectAllowed = 'copyMove'
}
function onTabDragOver(e: DragEvent, idx: number) {
  if (draggedTabIndex.value === null || draggedTabIndex.value === idx) return
  e.preventDefault()
  emit('dragReorder', draggedTabIndex.value, idx)
  draggedTabIndex.value = idx
}
function onTabDragEnd() {
  draggedTabIndex.value = null
  draggingTabGroupId.value = null
}

// ── 编辑器区接收树内拖放打开（P-20261003-13）+ 跨组拖签移动（P-20261003-38）──
// 树行 dragstart 已带 application/x-sc-file-path + text/plain 双 payload
// （useFileTreeDragDrop），本组成为落点：拖到哪组开哪组。tab dragstart 同款
// 携 application/x-sc-editor-tab + text/plain（本组 tab 发出），对侧组成为
// 移动落点：整组高亮，松手即移动（Alt=复制）。dragover 阶段 dataTransfer
// 数据不可读，仅 types 可判（useTerminalDnd 同款判别），跨组判定辅以
// draggingTabGroupId 会话态；外部文件（types 含 Files）/同组标签重排/
// Monaco 选区拖拽一律放行（上传语义仍只属树/根，hasExternalFiles 先例）
const SC_PATH_TYPE = 'application/x-sc-file-path'
const SC_TAB_TYPE = 'application/x-sc-editor-tab'
const paneDropHover = ref(false)

function hasInternalFilePath(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types || []).includes(SC_PATH_TYPE)
}

function hasEditorTabPayload(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types || []).includes(SC_TAB_TYPE)
}

/** drop 阶段解析 tab 载荷；非本组发出的拖拽（同组=组内重排语义）返回 null。
 *  dragover 阶段保护模式读不到数据，不可用本函数判定，走 draggingTabGroupId */
function readForeignTabPayload(e: DragEvent): { fromGi: number; path: string } | null {
  if (!hasEditorTabPayload(e)) return null
  try {
    const raw = JSON.parse(e.dataTransfer?.getData(SC_TAB_TYPE) || '') as { groupId?: unknown; path?: unknown }
    if (typeof raw?.groupId !== 'number' || typeof raw?.path !== 'string' || !raw.path) return null
    if (raw.groupId === props.groupIndex) return null
    return { fromGi: raw.groupId, path: raw.path }
  } catch {
    return null // 非本系统载荷（伪造/残缺）：静默忽略不落任何操作
  }
}

function onPaneDragOver(e: DragEvent) {
  if (hasInternalFilePath(e)) {
    e.preventDefault()
    e.dataTransfer!.dropEffect = 'copy'
    paneDropHover.value = true
    return
  }
  // 对侧组拖签悬停：本组成为移动/复制落点（同组拖签=重排，不高亮不拦默认，
  // 组内重排语义由 tab 条 onTabDragOver 既有链承载）
  if (hasEditorTabPayload(e) && draggingTabGroupId.value !== null && draggingTabGroupId.value !== props.groupIndex) {
    e.preventDefault()
    e.dataTransfer!.dropEffect = e.altKey ? 'copy' : 'move'
    paneDropHover.value = true
  }
}

function onPaneDragLeave(e: DragEvent) {
  // dragleave 在子元素之间频繁触发，仅离开整组才熄灭高亮（useTerminalDnd 同款兜底）
  const related = e.relatedTarget as Node | null
  if (related && (e.currentTarget as HTMLElement).contains(related)) return
  paneDropHover.value = false
  treeDropLineIdx.value = null // 插入线（P-20261004-74）随整组离开一并熄灭
}

function onPaneDrop(e: DragEvent) {
  paneDropHover.value = false
  // 树内路径拖放：开进本组（copy 语义）
  if (hasInternalFilePath(e)) {
    e.preventDefault()
    const path = e.dataTransfer?.getData(SC_PATH_TYPE) || ''
    if (!path) return
    // 先激活本组再打开：emit 链同步写回 useOpenFiles.activeGroup（Layout
    // activate-group 直赋值），openFile 按活跃组落文件——落谁激活谁，文件即落
    // 本组（主组无分屏时等价 openFile；分屏组落点不另走 openInSplit——该 emit
    // 仅主组在 EditorArea 有转发绑定）。落点在 tab 条上的按位插入走
    // onTabsBarDrop → openFileAt（P-20261004-74），此处仍是内容区/组尾语义
    emit('activate')
    emit('openFile', path)
    return
  }
  // 对侧组拖签：Alt=复制（同树拖放开进本组，源组保留），默认=移动（目标组
  // 成签 + 源组摘签，moveTabToGroup 落位后自置活跃组）
  const tab = readForeignTabPayload(e)
  if (!tab) return
  e.preventDefault()
  draggingTabGroupId.value = null // 会话已定案即清（dragend 兜底再清一次，幂等）
  if (e.altKey) {
    emit('activate')
    emit('openFile', tab.path)
    return
  }
  emit('tabMoveIn', tab.fromGi, tab.path)
}

// ── 树拖文件到 tab 条按落点插入（P-20261004-74，二阶段兑现）────────
// tab 条成为落点时 dragover 期按指针 x 对各 tab 几何中点求插入位（首个中点在
// 指针右侧的 tab = 插其前；全过 = 组尾），边界画 2px 插入线。命中判定收敛在
// tab 条容器一处而非逐 tab 再注册一遍：tab 重排 dragover（onTabDragOver）是
// 逐 tab 既有链，两条判定以 draggedTabIndex（重排中）/hasInternalFilePath
// （树拖中）互斥门控，同元素双注册互不触发；跨组拖签载荷（x-sc-editor-tab）
// 不含 SC_PATH_TYPE 天然不进本链，树拖/签拖载荷区分（双载荷惯例）保持
const treeDropLineIdx = ref<number | null>(null)

/** 指示线渲染位：插入下标 < 组长 → 该 tab 左缘（drop-line-before）；= 组尾
 *  → 末签右缘（drop-line-after）。-1 = 无线（模板类绑定哨兵） */
const dropLineBeforeIdx = computed(() =>
  treeDropLineIdx.value !== null && treeDropLineIdx.value < props.files.length ? treeDropLineIdx.value : -1)
const dropLineAfterIdx = computed(() =>
  treeDropLineIdx.value === props.files.length ? props.files.length - 1 : -1)

/** 指针 x → 插入下标：中点命中判定（ActivityBar 重排 insert-before 同语义）。
 *  量级考量：dragover 高频触发，但 tab 数即打开签数（通常两位数内），
 *  逐签一次 getBoundingClientRect 可忽略；结果不变不写 ref 防无谓重渲染 */
function hitTestInsertIndex(x: number): number {
  const tabs = editorTabsRef.value?.querySelectorAll<HTMLElement>('.editor-tab')
  if (!tabs) return props.files.length
  for (let i = 0; i < tabs.length; i++) {
    const r = tabs[i]!.getBoundingClientRect()
    if (x < r.left + r.width / 2) return i
  }
  return props.files.length
}

function onTabsBarDragOver(e: DragEvent) {
  // 树拖路径载荷才接管；tab 重排中（draggedTabIndex 非空）让位既有链
  if (draggedTabIndex.value !== null || !hasInternalFilePath(e)) return
  e.preventDefault()
  e.dataTransfer!.dropEffect = 'copy'
  const idx = hitTestInsertIndex(e.clientX)
  if (treeDropLineIdx.value !== idx) treeDropLineIdx.value = idx
}

function onTabsBarDragLeave(e: DragEvent) {
  // dragleave 在子元素之间频繁触发，仅离开 tab 条才熄灭（onPaneDragLeave 同款兜底）
  const related = e.relatedTarget as Node | null
  if (related && (e.currentTarget as HTMLElement).contains(related)) return
  treeDropLineIdx.value = null
}

function onTabsBarDrop(e: DragEvent) {
  const at = treeDropLineIdx.value
  treeDropLineIdx.value = null
  // 无 dragover 命中（直接落/重排拖拽/外部文件）不拦：放行冒泡到组根 onPaneDrop
  // 既有语义（组尾打开/上传面）
  if (at === null || !hasInternalFilePath(e)) return
  e.preventDefault()
  e.stopPropagation() // 本层已按落点定案，不再冒泡到组根按组尾打开
  const path = e.dataTransfer?.getData(SC_PATH_TYPE) || ''
  if (!path) return
  // 先激活本组再打开（onPaneDrop 同序：emit 链同步写回 useOpenFiles.activeGroup），
  // 插入位经 openFileAt → openFileByPath opts.insertAt 落位
  emit('activate')
  emit('openFileAt', path, at)
}

// ── 标签溢出检测 ──────────────────────────────────────────
const editorTabsRef = ref<HTMLElement | null>(null)
const isTabOverflow = ref(false)

function checkTabOverflow() {
  const el = editorTabsRef.value
  if (!el) return
  isTabOverflow.value = el.scrollWidth - el.clientWidth > 4
}

// ── 标签栏滚轮横向滚动（P-20261002-99）────────────────────────
// 溢出容器的体验补齐：纵向滚轮（deltaY）悬停本标签栏时转 scrollLeft
// 步进（自然方向映射：下滚=右移）；Shift+wheel / 触控板横向产生的
// deltaX 走浏览器原生横向滚动，不拦截。preventDefault 只在「悬停本
// 标签栏且该方向仍有可滚余地」时生效——未溢出/已滚到边放行给页面，
// 避免滚动陷阱（元素级 wheel 监听非 passive，preventDefault 有效）
function onTabsWheel(e: WheelEvent) {
  if (e.deltaX !== 0) return
  const el = editorTabsRef.value
  if (!el) return
  const maxLeft = el.scrollWidth - el.clientWidth
  if (maxLeft <= 0) return
  if ((e.deltaY < 0 && el.scrollLeft <= 0) || (e.deltaY > 0 && el.scrollLeft >= maxLeft)) return
  e.preventDefault()
  // deltaMode 归一为像素（Firefox 行模式 ~20px/行、页模式按整宽），否则步进过碎
  const px = e.deltaMode === 1 ? e.deltaY * 20 : e.deltaMode === 2 ? e.deltaY * el.clientWidth : e.deltaY
  el.scrollLeft += px
}

const tabOverflowOptions = computed(() =>
  props.files.map((f, idx) => ({
    label: f.name,
    key: String(idx),
    props: { style: f.pinned ? { fontWeight: 600 } : undefined },
  })),
)

function onTabOverflowSelect(key: string) {
  const idx = Number(key)
  if (Number.isNaN(idx)) return
  emit('switchFile', idx)
  nextTick(() => {
    const tab = editorTabsRef.value?.children[idx] as HTMLElement | undefined
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })
}

let tabResizeObserver: ResizeObserver | null = null

// ── 暴露子组件 ref 给父组件（EditorArea 按活跃组转发给宿主） ──
const monacoEditorRef = ref<InstanceType<typeof MonacoEditor> | null>(null)
const diffEditorRef = ref<InstanceType<typeof DiffEditor> | null>(null)

// ── EOL 徽标（P-20261004-140）：模型行尾读取与转换 ────────────
// Monaco 模型的 EOL 属性（getEOL）是行尾序列唯一权威（内容字符串对混合行尾
// 文件已被规范化，不能作判据）。模型在编辑器 chunk（懒加载约束，本组件不可
// import monaco），经本组挂载实例 defineExpose 的 getEol/convertEol 读写。
// 读取时机 = flush post watcher：切签换 model 的子组件 pre-watcher 已先跑完，
// 读到的必是当前文件模型；依赖 currentFile.path/content——EOL 转换与 undo 都
// 经 isEolChange 事件回写 f.content，徽标随之即时翻转。monacoEditorRef 入源：
// 首开文件时编辑器 chunk 异步解析后模板 ref 才落位，不追踪它徽标会停在 null。
// getEOL 是 O(1) 属性读取，键入期高频触发无渲染成本（值不变不 patch）
const eolState = ref<'LF' | 'CRLF' | null>(null)
watch(
  [
    () => currentFile.value?.path,
    () => currentFile.value?.content,
    monacoEditorRef,
  ],
  () => {
    eolState.value = monacoEditorRef.value?.getEol() ?? null
  },
  { flush: 'post' },
)

/** EOL 徽标可见性：模型有行尾信息（编辑器已挂载）才有得显示。形态排除沿
 *  EncodingBadge 惯例（diff 伪文件/元信息卡/载入中/未命名草稿不渲染），差异
 *  两处：远程伪路径同样适用（远端文件 EOL 语义一致，本组件不再按 remote 伪
 *  路径排除）；离线只读不提供——行尾转换完不成写回，只留徒劳脏态 */
const eolBadgeVisible = computed(() => {
  if (!eolState.value) return false
  const f = currentFile.value
  if (!f) return false
  if (f.isDiff || f.meta || f.loading || f.remoteOffline) return false
  if (isUntitledPath(f.path)) return false
  return true
})

/** EOL 转换：只改模型 EOL 属性（pushEOL 落撤销栈），变更经 isEolChange 事件
 *  链回写 f.content——脏态/草稿落库/undo 回退全走既有链，落盘是显式 Ctrl+S
 *  （远程签走保存链的敏感路径确认与 409 冲突检测，本函数零新增网络面） */
function onConvertEol(target: 'LF' | 'CRLF') {
  monacoEditorRef.value?.convertEol(target)
}

// ── Ln/Col 光标位置徽标（P-20261004-141）──────────────────────
// MonacoEditor 光标/选区事件旁路上抛（与导航历史同源监听面），载荷携 path
// 自描述。对位展示 = 载荷 path 必须等于当前 tab path 才渲染——切 diff/元信息
// 卡/载入中/换签等无编辑器事件窗口期，陈旧载荷因 path 不匹配自然隐藏，免去
// watcher 清态的次序依赖。可见性排除与 EncodingBadge 惯例同口径（diff 伪
// 文件/元信息卡/载入中）；untitled 草稿/远程伪路径/离线只读凡编辑器在场
// 即有光标，照常适用
const cursorState = ref<{ path: string; line: number; column: number; selected: number } | null>(null)
const cursorBadgeVisible = computed(() => {
  const s = cursorState.value
  const f = currentFile.value
  if (!s || !f) return false
  if (f.isDiff || f.meta || f.loading) return false
  return s.path === f.path
})

// ── 面包屑符号段（P-20261005-195）────────────────────────────
// MonacoEditor 符号桥载荷旁路上抛（与 @cursor 同管道形态），path 自描述对位
// 本组当前 tab——切 diff/换签窗口期陈旧载荷因 path 不匹配自然隐藏，免 watcher
// 清态次序依赖。可见性 = 链非空且形态就绪且 path 对位；链空 = 语言无符号
// provider（Go 等基础语言，面包屑止于文件层的硬约束）或光标在符号外
const symbolCrumbState = ref<SymbolCrumbPayload | null>(null)
const symbolCrumbVisible = computed(() => {
  const s = symbolCrumbState.value
  const f = currentFile.value
  if (!s || !f || s.chain.length === 0) return false
  if (f.isDiff || f.meta || f.loading) return false
  return s.path === f.path
})
const symbolChainProp = computed(() => (symbolCrumbVisible.value ? symbolCrumbState.value!.chain : []))
const symbolSiblingsProp = computed(() => (symbolCrumbVisible.value ? symbolCrumbState.value!.siblings : []))

/** 符号段同层跳转：目标符号起始行定点（revealLine 落位后光标事件自然回流
 *  符号段重算/位置徽标/导航历史）。编辑器未在场（形态窗口期）为 no-op */
function onSymbolNav(line: number) {
  monacoEditorRef.value?.revealLine(line)
}

defineExpose({
  monacoEditorRef,
  diffEditorRef,
})

// ── 生命周期 ──────────────────────────────────────────────
onMounted(() => {
  nextTick(() => {
    if (editorTabsRef.value) {
      tabResizeObserver = new ResizeObserver(() => checkTabOverflow())
      tabResizeObserver.observe(editorTabsRef.value)
      checkTabOverflow()
    }
  })
})

onBeforeUnmount(() => {
  tabResizeObserver?.disconnect()
  tabResizeObserver = null
})

watch(() => props.files.length, () => {
  nextTick(checkTabOverflow)
})
</script>

<template>
  <div
    class="editor-pane-inner"
    :class="{ 'pane-drop-target': paneDropHover }"
    @mousedown="emit('activate')"
    @dragover="onPaneDragOver"
    @dragleave="onPaneDragLeave"
    @drop="onPaneDrop"
  >
    <!-- 组空：主组回退欢迎页；分屏组由父组件给 #empty 收起态占位 -->
    <div
      v-if="files.length === 0"
      class="pane-empty-host"
    >
      <slot name="empty">
        <WelcomePanel
          @open-file="emit('openFile', $event)"
          @new-file="emit('newFile')"
          @open-command-palette="emit('openCommandPalette')"
          @open-project="emit('openProject')"
          @open-settings="emit('openSettings')"
        />
      </slot>
    </div>

    <!-- 编辑器标签页 + 内容 -->
    <template v-else>
      <div class="editor-tabs-row">
        <div
          ref="editorTabsRef"
          class="editor-tabs"
          role="tablist"
          :aria-label="t('layout.editorTabs')"
          @click="closeTabContextMenu"
          @wheel="onTabsWheel"
          @dblclick="onTabsRowDblclick"
          @dragover="onTabsBarDragOver"
          @dragleave="onTabsBarDragLeave"
          @drop="onTabsBarDrop"
        >
          <div
            v-for="(file, idx) in files"
            :key="file.path"
            class="editor-tab"
            role="tab"
            :aria-selected="idx === activeIndex"
            :aria-label="tabAriaLabelOf(file, idx)"
            :class="{ active: idx === activeIndex, pinned: file.pinned, preview: file.isPreview, dragging: draggedTabIndex === idx, 'git-modified': gitTabKindOf(file) === 'modified', 'git-untracked': gitTabKindOf(file) === 'untracked', 'drop-line-before': dropLineBeforeIdx === idx, 'drop-line-after': dropLineAfterIdx === idx }"
            :title="tabTitleOf(file, idx)"
            tabindex="0"
            draggable="true"
            @click="emit('switchFile', idx)"
            @auxclick="onTabAuxClick($event, idx)"
            @contextmenu="handleTabContextMenu($event, idx)"
            @keydown.enter="emit('switchFile', idx)"
            @dragstart="onTabDragStart(idx, $event)"
            @dragover="onTabDragOver($event, idx)"
            @dragend="onTabDragEnd"
            @dblclick.stop="emit('togglePin', idx)"
          >
            <!-- 远程主机徽标（P-20261004-138）：主机别名首字符色片，本地/远程
                 同名 tab 扫读可辨；与 diff 图标互斥（diff 伪路径不显示，同
                 类型色点惯例），位置在名前装饰簇首位 -->
            <span
              v-if="remoteTabMetas[idx]"
              class="tab-host-badge"
            >{{ remoteTabMetas[idx]!.badge }}</span>
            <span
              v-if="file.isDiff"
              class="tab-diff-icon"
            />
            <span
              v-if="file.pinned"
              class="tab-pin"
              :title="t('layout.unpinTab')"
            >
              <n-icon size="10"><PinOutline /></n-icon>
            </span>
            <!-- 类型色点（P-20261002-147）：与文件树 .file-icon-dot 同规格同色表
                 （utils/fileIcon），tab 扫读与树面板类型识别一致；diff 伪路径不
                 显示（已有 tab-diff-icon 占引导位） -->
            <span
              v-if="!file.isDiff"
              class="tab-type-dot"
              :style="{ background: getFileIconColor(file.name, false) }"
            />
            <span class="tab-name">{{ file.name }}</span>
            <!-- 脏点「保存并关闭」（P-20261003-138）：对标 VS Code 点脏点顺手保存——
                 点击触发保存并关闭链（useOpenFiles.saveCloseFileInGroup），不再是无
                 行为的纯指示；同 .tab-close 用 click.stop 防触发 tab 切换 -->
            <span
              v-if="!file.isDiff && file.content !== file.originalContent"
              class="tab-dot"
              :title="t('layout.saveCloseTab')"
              :aria-label="t('layout.saveCloseTab')"
              @click.stop="emit('saveCloseFile', idx)"
            />
            <span
              class="tab-close"
              @click.stop="emit('closeFile', idx)"
            >&times;</span>
          </div>
        </div>
        <n-dropdown
          v-if="isTabOverflow"
          trigger="click"
          :options="tabOverflowOptions"
          placement="bottom-end"
          @select="onTabOverflowSelect"
        >
          <button
            class="tabs-overflow-btn"
            :title="t('layout.showAllTabs')"
            :aria-label="t('layout.showAllTabs')"
          >
            <n-icon size="14">
              <ChevronDownOutline />
            </n-icon>
          </button>
        </n-dropdown>
      </div>

      <!-- 标签页右键菜单 -->
      <div
        v-if="showTabContextMenu"
        :style="{ position: 'fixed', left: tabContextMenuX + 'px', top: tabContextMenuY + 'px', zIndex: 99999 }"
        style="background: var(--bg-panel); border-radius: 6px; padding: 4px 0; min-width: 160px; box-shadow: var(--shadow-soft); border: 1px solid var(--border-subtle)"
        role="menu"
        @click="closeTabContextMenu"
      >
        <!-- 分屏组专属：关闭分屏（组 1 文件并回主组尾部） -->
        <div
          v-if="!allowSplitOpen"
          role="menuitem"
          style="padding: 6px 12px; cursor: pointer; font-size: 13px; color: var(--text-body)"
          class="ctx-hover-item"
          @click="emit('closeSplit')"
        >
          {{ t('layout.closeSplit') }}
        </div>
        <div
          v-if="!allowSplitOpen"
          style="border-top: 1px solid var(--border-default); margin: 2px 0"
        />
        <div
          role="menuitem"
          :aria-disabled="!canReopenClosed"
          style="padding: 6px 12px; cursor: pointer; font-size: 13px; color: var(--text-body)"
          class="ctx-hover-item"
          :class="{ 'ctx-item-disabled': !canReopenClosed }"
          @click="onContextReopenClosed"
        >
          {{ t('layout.reopenClosedTab') }}
        </div>
        <template v-if="canSplitContextTab">
          <div style="border-top: 1px solid var(--border-default); margin: 2px 0" />
          <div
            role="menuitem"
            style="padding: 6px 12px; cursor: pointer; font-size: 13px; color: var(--text-body)"
            class="ctx-hover-item"
            @click="onContextOpenInSplit('horizontal')"
          >
            {{ t('layout.splitRight') }}
          </div>
          <!-- 在下方分屏打开（P-20261005-230 正交拆分）：与右侧项并列（VS Code
               Split Down 同位），长文件上下对照/代码+输出场景的拆分方向补对称 -->
          <div
            role="menuitem"
            data-testid="tab-split-down"
            style="padding: 6px 12px; cursor: pointer; font-size: 13px; color: var(--text-body)"
            class="ctx-hover-item"
            @click="onContextOpenInSplit('vertical')"
          >
            {{ t('layout.splitDown') }}
          </div>
        </template>
        <!-- 就此文件询问智能体：新建 agent 会话带文件上下文（diff 伪路径不提供） -->
        <template v-if="canAskContextTab">
          <div style="border-top: 1px solid var(--border-default); margin: 2px 0" />
          <div
            role="menuitem"
            style="padding: 6px 12px; cursor: pointer; font-size: 13px; color: var(--text-body)"
            class="ctx-hover-item"
            @click="onContextAskAgent"
          >
            {{ t('editor.ask.menu') }}
          </div>
        </template>
        <!-- 分享（P-20261020-8）：项目内已保存文件 → 创建弹层（文件树右键同链）；
             diff/远程/草稿/脏缓冲不提供（分享取磁盘版本） -->
        <template v-if="canShareContextTab">
          <div style="border-top: 1px solid var(--border-default); margin: 2px 0" />
          <div
            role="menuitem"
            data-testid="tab-share"
            style="padding: 6px 12px; cursor: pointer; font-size: 13px; color: var(--text-body)"
            class="ctx-hover-item"
            @click="onContextShare"
          >
            {{ t('share.tabShare') }}
          </div>
        </template>
        <!-- 在文件树中定位（P-20261003-294）：侧栏文件树逐层展开并滚动到目标行
             （diff/远程伪路径不提供，同询问智能体守卫） -->
        <template v-if="canLocateContextTab">
          <div style="border-top: 1px solid var(--border-default); margin: 2px 0" />
          <div
            role="menuitem"
            style="padding: 6px 12px; cursor: pointer; font-size: 13px; color: var(--text-body)"
            class="ctx-hover-item"
            @click="onContextLocateInTree"
          >
            {{ t('changes.locateInTree') }}
          </div>
        </template>
        <!-- 复制文件深链（P-20261002-49）：粘贴到浏览器打开即直达编辑器（diff 伪路径不提供） -->
        <template v-if="canCopyFileContextTab">
          <div style="border-top: 1px solid var(--border-default); margin: 2px 0" />
          <div
            role="menuitem"
            style="padding: 6px 12px; cursor: pointer; font-size: 13px; color: var(--text-body)"
            class="ctx-hover-item"
            @click="onContextCopyLink"
          >
            {{ t('layout.copyFileLink') }}
          </div>
          <!-- 复制路径/文件名/绝对路径（P-20261002-88）：贴给 agent/外部工具免手拼（同块守卫） -->
          <div
            role="menuitem"
            style="padding: 6px 12px; cursor: pointer; font-size: 13px; color: var(--text-body)"
            class="ctx-hover-item"
            @click="onContextCopyPath"
          >
            {{ t('layout.copyPath') }}
          </div>
          <!-- 复制引用（P-20261006-17）：路径:行 精确定位形态，与 Quick Open
               行号直达同格式——粘贴即直达；与纯路径复制并存按需选（untitled
               草稿内部键不提供） -->
          <div
            v-if="canCopyReferenceContextTab"
            role="menuitem"
            data-testid="tab-copy-reference"
            style="padding: 6px 12px; cursor: pointer; font-size: 13px; color: var(--text-body)"
            class="ctx-hover-item"
            @click="onContextCopyReference"
          >
            {{ t('layout.copyReference') }}
          </div>
          <div
            role="menuitem"
            style="padding: 6px 12px; cursor: pointer; font-size: 13px; color: var(--text-body)"
            class="ctx-hover-item"
            @click="onContextCopyFileName"
          >
            {{ t('layout.copyFileName') }}
          </div>
          <div
            role="menuitem"
            style="padding: 6px 12px; cursor: pointer; font-size: 13px; color: var(--text-body)"
            class="ctx-hover-item"
            @click="onContextCopyAbsPath"
          >
            {{ t('layout.copyAbsPath') }}
          </div>
          <!-- 在系统中显示（P-20261003-323）：宿主文件管理器定位该文件，
               与复制绝对路径同守卫同位（拿路径/去宿主看语义相邻） -->
          <div
            role="menuitem"
            data-testid="tab-reveal-in-system"
            style="padding: 6px 12px; cursor: pointer; font-size: 13px; color: var(--text-body)"
            class="ctx-hover-item"
            @click="onContextRevealInSystem"
          >
            {{ t('files.revealInSystem') }}
          </div>
        </template>
        <!-- 放弃未保存修改（P-20261005-156，VS Code Revert File 对位）：脏 buffer
             一键回磁盘/远端当前内容（409 冲突对话框「加载磁盘/远端版本」的常态
             入口）；仅脏 tab 显示，untitled 草稿无基线不提供（canRevertContextTab） -->
        <template v-if="canRevertContextTab">
          <div style="border-top: 1px solid var(--border-default); margin: 2px 0" />
          <div
            role="menuitem"
            data-testid="tab-revert-file"
            style="padding: 6px 12px; cursor: pointer; font-size: 13px; color: var(--text-body)"
            class="ctx-hover-item"
            @click="onContextRevertFile"
          >
            {{ t('files.revert.menu') }}
          </div>
        </template>
        <div style="border-top: 1px solid var(--border-default); margin: 2px 0" />
        <div
          role="menuitem"
          style="padding: 6px 12px; cursor: pointer; font-size: 13px; color: var(--text-body)"
          class="ctx-hover-item"
          @click="onContextTogglePin"
        >
          {{ files[tabContextMenuIndex]?.pinned ? t('layout.unpinTab') : t('layout.pinTab') }}
        </div>
        <div style="border-top: 1px solid var(--border-default); margin: 2px 0" />
        <div
          role="menuitem"
          style="padding: 6px 12px; cursor: pointer; font-size: 13px; color: var(--text-body)"
          class="ctx-hover-item"
          @click="onContextClose"
        >
          {{ t('layout.close') }}
        </div>
        <div
          role="menuitem"
          style="padding: 6px 12px; cursor: pointer; font-size: 13px; color: var(--text-body)"
          class="ctx-hover-item"
          @click="onContextCloseOthers"
        >
          {{ t('layout.closeOthers') }}
        </div>
        <div
          role="menuitem"
          style="padding: 6px 12px; cursor: pointer; font-size: 13px; color: var(--text-body)"
          class="ctx-hover-item"
          @click="onContextCloseRight"
        >
          {{ t('layout.closeRight') }}
        </div>
        <div
          role="menuitem"
          style="padding: 6px 12px; cursor: pointer; font-size: 13px; color: var(--text-body)"
          class="ctx-hover-item"
          @click="onContextCloseSaved"
        >
          {{ t('layout.closeSaved') }}
        </div>
        <div style="border-top: 1px solid var(--border-default); margin: 2px 0" />
        <div
          role="menuitem"
          style="padding: 6px 12px; cursor: pointer; font-size: 13px; color: var(--text-body)"
          class="ctx-hover-item"
          @click="onContextCloseAll"
        >
          {{ t('layout.closeAll') }}
        </div>
      </div>

      <!-- 路径面包屑 -->
      <Breadcrumb
        v-if="currentFile"
        :path="currentFile.path"
        :is-diff="currentFile.isDiff"
        :symbol-chain="symbolChainProp"
        :symbol-siblings="symbolSiblingsProp"
        @reveal-in-tree="emit('revealInFileTree')"
        @symbol-nav="onSymbolNav"
      >
        <template #extra>
          <EncodingBadge
            v-if="!isRemoteEditorPath(currentFile.path)"
            :file="currentFile"
            @reload="emit('reloadWithEncoding', $event)"
            @save-as="emit('saveWithEncoding', $event)"
          />
          <EolBadge
            :eol="eolBadgeVisible ? eolState : null"
            @convert="onConvertEol"
          />
          <button
            v-if="currentFile && !currentFile.isDiff"
            class="breadcrumb-outline-btn"
            :title="t('outline.title') + ' (Ctrl+Shift+O)'"
            @click="emit('openOutline')"
          >
            <n-icon size="13">
              <ListOutline />
            </n-icon>
          </button>
          <CursorPositionBadge
            :pos="cursorBadgeVisible ? cursorState : null"
            @goto="monacoEditorRef?.gotoLine()"
          />
        </template>
      </Breadcrumb>

      <!-- 远程主机离线降级横幅（P-20261003-15）：主机不可达/已删时编辑器转
           只读，重试重拉远端内容（有未保存修改时由重试链确认放弃） -->
      <div
        v-if="currentFile?.remoteOffline"
        class="remote-offline-bar"
        data-testid="remote-offline-bar"
        role="status"
      >
        <span
          class="remote-offline-dot"
          aria-hidden="true"
        />
        <span class="remote-offline-text">{{ t('editor.remote.offlineBanner') }}</span>
        <button
          class="remote-offline-retry"
          data-testid="remote-offline-retry"
          @click.stop="emit('remoteRetry', currentFile.path)"
        >
          {{ t('editor.remote.retry') }}
        </button>
      </div>

      <!-- 窄屏编辑模式条（P-20261019-7）：默认只读的安全提示 + 一键切编辑。
           放在面包屑下方而非 breadcrumb-extra（该区域在 ≤700px 被隐藏），
           手机上文字标签比图标更可发现 -->
      <div
        v-if="narrowEditorModeAvailable"
        class="narrow-editor-bar"
        data-testid="narrow-editor-bar"
      >
        <span class="narrow-editor-bar-hint">
          {{ narrowEditorReadOnly ? t('layout.narrowEditorReadOnlyHint') : t('layout.narrowEditorEditingHint') }}
        </span>
        <button
          class="narrow-editor-mode-btn"
          data-testid="narrow-editor-mode-toggle"
          :title="narrowEditorReadOnly ? t('layout.narrowEditorStartEdit') : t('layout.narrowEditorStopEdit')"
          :aria-label="narrowEditorReadOnly ? t('layout.narrowEditorStartEdit') : t('layout.narrowEditorStopEdit')"
          @click.stop="toggleNarrowEditorEditing()"
        >
          <NIcon size="13">
            <LockClosedOutline v-if="narrowEditorReadOnly" />
            <CreateOutline v-else />
          </NIcon>
          <span>{{ narrowEditorReadOnly ? t('layout.narrowEditorStartEdit') : t('layout.narrowEditorStopEdit') }}</span>
        </button>
      </div>

      <div class="editor-content">
        <!-- 呈现面走 displayFile（P-20261004-100）：diff→diff 切换的 loading
             窗口沿用上一个就绪 diff（实例热切），面包屑/徽标仍在 currentFile
             （tab 身份即时跟随）；loading 分支只剩形态变化（普通文件装载/
             diff 首开无前置）会走到 -->
        <div
          v-if="displayFile?.loading"
          class="editor-loading"
        >
          {{ t('layout.loading') }}
        </div>
        <!-- 预览策略：超大/二进制文件不进编辑器，展示元信息卡（友好提示 + 不发内容） -->
        <div
          v-else-if="displayFile?.meta"
          class="file-meta-card"
        >
          <n-icon
            size="36"
            class="meta-icon"
          >
            <DocumentTextOutline />
          </n-icon>
          <div class="meta-title">
            {{ displayFile.meta.kind === 'binary' ? t('editor.metaBinaryTitle') : t('editor.metaTooLargeTitle') }}
          </div>
          <div class="meta-hint">
            {{ displayFile.meta.kind === 'binary'
              ? t('editor.metaBinaryHint')
              : t('editor.metaTooLargeHint', { size: displayFile.meta.sizeHuman }) }}
          </div>
          <div class="meta-path">
            {{ displayFile.path }} · {{ displayFile.meta.sizeHuman }}
          </div>
        </div>
        <DiffEditor
          v-else-if="displayFile?.isDiff"
          :key="'diff-' + asyncRetryTick"
          ref="diffEditorRef"
          :old-content="displayFile.diffOldContent || ''"
          :new-content="displayFile.content"
          :path="displayFile.path"
          :old-label="displayFile.diffOldLabel"
          :new-label="displayFile.diffNewLabel"
          :group-index="groupIndex"
          @retry="asyncRetryTick++"
        />
        <MonacoEditor
          v-else-if="displayFile"
          :key="'monaco-' + asyncRetryTick"
          ref="monacoEditorRef"
          :model-value="displayFile.content"
          :path="displayFile.path"
          :group-index="groupIndex"
          :read-only="editorReadOnly"
          :editorconfig="displayFile.editorconfig"
          :dirty="currentFileRevertable"
          @retry="asyncRetryTick++"
          @update:model-value="emit('updateContent', displayFile.path, $event)"
          @save="emit('saveCurrentFile')"
          @revert-file="emit('revertFile', props.activeIndex)"
          @reveal-in-tree="emit('revealInFileTree')"
          @compare-clipboard="emit('compareClipboard', $event)"
          @cursor="cursorState = $event"
          @symbol-crumb="symbolCrumbState = $event"
        />
        <!-- 侧边栏模式提交面板（仅主组渲染，分屏下不重复挂载） -->
        <CommitPanel
          v-if="showCommitPanel"
          :key="'commit-' + asyncRetryTick"
          :location="'sidebar'"
          @retry="asyncRetryTick++"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
.editor-pane-inner {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}

/* 树内拖放落点高亮（P-20261003-13）：复用活跃组高亮语（顶边品牌色内描边，
 * EditorArea .pane-active 同款），box-shadow 不挤占布局 */
.editor-pane-inner.pane-drop-target {
  box-shadow: inset 0 2px 0 var(--accent-blue);
}

.pane-empty-host {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* 编辑器标签页 */
.editor-tabs-row {
  display: flex;
  align-items: stretch;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
}

.editor-tabs {
  height: 36px;
  background: var(--bg-panel);
  display: flex;
  overflow-x: auto;
  flex: 1;
  min-width: 0;
  scrollbar-width: thin;
}

.tabs-overflow-btn {
  flex-shrink: 0;
  width: 28px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-panel);
  border: none;
  border-left: 1px solid var(--border-default);
  color: var(--text-secondary);
  cursor: pointer;
  transition: background var(--motion-fast), color var(--motion-fast);
}

.tabs-overflow-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.tabs-overflow-btn:focus-visible {
  outline: 2px solid var(--accent-blue);
  outline-offset: -2px;
}

.editor-tab {
  height: 36px;
  padding: 0 12px;
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font-size: 0.92em;
  color: var(--text-secondary);
  border-right: 1px solid var(--border-default);
  white-space: nowrap;
  transition: background var(--motion-fast);
  /* git 状态下划线（P-20261003-242）的定位锚：::after 免布局位移 */
  position: relative;
}

.editor-tab:hover {
  background: var(--bg-hover);
}

.editor-tab.active {
  background: var(--bg-primary);
  color: var(--text-primary);
  border-bottom: 2px solid var(--accent-blue);
}

/* git 状态下划线（P-20261003-242，开关默认关）：VS Code tab decorations 同形
 * ——修改蓝 / 未跟踪绿 2px 底部细条。::after 贴底覆盖不占布局（tab 高度/内容
 * 基线零变化）；颜色走主题语义变量（--accent-blue / --accent-green 六主题同步在册），
 * 零硬编码。活跃 tab 的 2px 底边框是既有活跃指示：git 色接管边框色（边框本身
 * 即下划线位），::after 退场防双条叠加 */
.editor-tab.git-modified::after,
.editor-tab.git-untracked::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  background: var(--accent-blue);
}

.editor-tab.git-untracked::after {
  background: var(--accent-green);
}

.editor-tab.active.git-untracked {
  border-bottom-color: var(--accent-green);
}

.editor-tab.active.git-modified::after,
.editor-tab.active.git-untracked::after {
  content: none;
}

.editor-tab.pinned {
  font-weight: 500;
}

/* 预览 tab（预览标签模式 P-20261002-50）：斜体标识（VS Code 惯例），
 * 编辑/双击固定/手动 pin 转正后自动摘除 */
.editor-tab.preview .tab-name {
  font-style: italic;
}

.editor-tab.pinned .tab-name {
  max-width: 140px;
}

.editor-tab.dragging {
  opacity: 0.5;
}

/* 树拖到 tab 条按落点插入（P-20261004-74）的落点反馈：插入边界 2px 竖线
 * （VS Code tab 条 drop 同形），颜色走主题变量零硬编码。::before 承载——
 * ::after 已被 git 状态下划线（P-20261003-242）占用；before/after 两态互斥
 * （before = 插中间界，after = 组尾界）共用一个伪元素不冲突 */
.editor-tab.drop-line-before::before,
.editor-tab.drop-line-after::before {
  content: '';
  position: absolute;
  top: 3px;
  bottom: 3px;
  width: 2px;
  background: var(--accent-blue);
  border-radius: 2px;
}

.editor-tab.drop-line-before::before {
  left: -1px;
}

.editor-tab.drop-line-after::before {
  right: -1px;
}

.editor-tab[draggable="true"]:hover {
  cursor: grab;
}

.editor-tab[draggable="true"]:active {
  cursor: grabbing;
}

.tab-pin {
  display: inline-flex;
  align-items: center;
  color: var(--accent-blue);
  flex-shrink: 0;
}

.editor-tab:focus-visible {
  outline: 2px solid var(--accent-blue);
  outline-offset: -2px;
}

.tab-name { overflow: hidden; text-overflow: ellipsis; max-width: 160px; }

.tab-diff-icon {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 2px;
  background: var(--accent-orange);
  flex-shrink: 0;
  margin-right: 2px;
}

/* 远程主机徽标（P-20261004-138）：12px 圆角方片 + 主机别名首字符——与类型色点
 * （8px 圆）/脏点（名后 6px 圆）/diff 图标（6px 方点，与徽标互斥不同现）形状
 * 尺寸双错位防视觉冲突。配色沿用仓内徽标惯例（AgentSidebarSessionTree 等）：
 * color-mix 16% 品牌紫淡底 + 主色文字，主题变量派生自适应六主题，零硬编码色值
 * （hardcoded-colors 门禁兜底）；uppercase 统一别名首字母观感 */
.tab-host-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 12px;
  height: 12px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--accent-purple) 16%, transparent);
  color: var(--accent-purple);
  font-size: 8px;
  font-weight: 600;
  line-height: 1;
  text-transform: uppercase;
  flex-shrink: 0;
  margin-right: 2px;
}

/* 脏点可点击（P-20261003-138）：点击=保存并关闭。视觉仍是 6px 指示点，
 * ::before 扩出 18px 命中热区（触屏可点，与 20px 的 .tab-close 同量级），
 * hover 放大给出「可点」反馈 */
.tab-dot {
  position: relative;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent-blue);
  flex-shrink: 0;
  cursor: pointer;
  transition: transform var(--motion-base);
}

.tab-dot::before {
  content: '';
  position: absolute;
  inset: -6px;
}

.tab-dot:hover {
  transform: scale(1.4);
}

/* 类型色点（P-20261002-147）：与文件树 .file-icon-dot 同规格（8px 圆点），
 * 颜色经内联 background 取共用色表 utils/fileIcon */
.tab-type-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.tab-close {
  font-size: 14px;
  line-height: 1;
  opacity: 0;
  transition: opacity var(--motion-base), background var(--motion-base);
  margin-left: 4px;
  border-radius: 4px;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.tab-close:active {
  background: var(--text-muted);
  transform: scale(0.9);
}

.editor-tab:hover .tab-close { opacity: 0.6; }
/* 白色叠加在浅色主题下几乎不可见——走主题变量 */
.tab-close:hover { opacity: 1 !important; background: var(--bg-hover); }

/* 编辑器内容 */
.editor-content {
  flex: 1;
  min-height: 0;
  position: relative;
}

/* 窄屏编辑模式条（P-20261019-7）：只读默认的安全提示 + 一键切编辑。
 * 只在 ≤700px 且普通文件就绪时渲染（diff/元信息/装载/远程离线的守卫在
 * script 的 narrowEditorModeAvailable） */
.narrow-editor-bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 3px var(--space-2);
  border-bottom: 1px solid var(--border-default);
  background: var(--bg-elevated);
  color: var(--text-secondary);
  font-size: var(--fs-tiny);
  flex-shrink: 0;
}
.narrow-editor-bar-hint {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.narrow-editor-mode-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-height: var(--hit-target-min, 28px);
  padding: 2px var(--space-2);
  border: 1px solid var(--brand-accent);
  border-radius: var(--radius-md);
  background: var(--brand-accent-soft);
  color: var(--brand-accent);
  font-family: var(--font-ui);
  font-size: var(--fs-tiny);
  white-space: nowrap;
  cursor: pointer;
  transition: background var(--motion-base), color var(--motion-base);
}
.narrow-editor-mode-btn:hover { background: var(--bg-hover); }
.narrow-editor-mode-btn:focus-visible { outline: 2px solid var(--accent-blue); outline-offset: 1px; }

/* 远程离线降级横幅（P-20261003-15）：与 Layout 断连指示条同语（橙点 + 警示
 * 底色 + 重试钮），占据面包屑与编辑器内容之间的细条，不遮内容 */
.remote-offline-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 12px;
  font-size: 0.85em;
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--accent-orange) 10%, var(--bg-panel));
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
}
.remote-offline-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent-orange);
  flex-shrink: 0;
}
.remote-offline-retry {
  margin-left: auto;
  border: 1px solid var(--border-default);
  background: var(--bg-panel);
  color: var(--text-body);
  font-size: 0.9em;
  padding: 1px 10px;
  border-radius: 4px;
  cursor: pointer;
  transition: all var(--motion-base);
}
.remote-offline-retry:hover {
  border-color: var(--accent-orange);
  color: var(--accent-orange);
}

.editor-loading {
  padding: 20px;
  color: var(--text-dim);
  font-size: 0.92em;
}

/* 预览策略元信息卡（超大/二进制文件占位） */
.file-meta-card {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-secondary);
  padding: 24px;
  text-align: center;
}
.file-meta-card .meta-icon { color: var(--text-dim); }
.file-meta-card .meta-title { font-size: 1.05em; color: var(--text-primary); }
.file-meta-card .meta-hint { font-size: 0.9em; max-width: 520px; line-height: 1.6; }
.file-meta-card .meta-path { font-size: 0.82em; color: var(--text-dim); word-break: break-all; }

.ctx-hover-item:hover {
  background: var(--bg-search);
}

/* 禁用菜单项（关闭栈为空时的「重新打开已关闭的标签」）：置灰且不可点 */
.ctx-item-disabled {
  opacity: 0.45;
  pointer-events: none;
}

.breadcrumb-outline-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--motion-base);
}

.breadcrumb-outline-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
</style>
