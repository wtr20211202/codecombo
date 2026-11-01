import { computed, ref } from 'vue'
import { isUntitledPath } from './useOpenFiles'

/**
 * 编辑器导航历史（P-20261002-51；P-20261002-148 增量：栈点带列号，后退/前进
 * 恢复精确到离开列）：跳转链（Quick Open 换文件 / 搜索结果跳行 /
 * 深链进入 / 同文件内远距离跳转）之后 Ctrl+Alt+←/→ 后退/前进，对标 VS Code
 * workbench.action.navigateBack/Forward（裸 Alt+←/→ 是浏览器历史导航保留键，
 * 退避多修饰组合，同 Alt+Shift+T 先例；P-148 提案描述的 Alt+→/← 键位不采纳，
 * 冲突理由同上）。
 *
 * 为什么模块级单例（useCompareBaseline / useRecentFiles 同范式）：消费方横跨
 * 多个互不隶属的层——MonacoEditor（深层组件，光标上报）、useLayoutViews
 * （恢复链 + 命令面板入口）、useLayoutKeyboard（快捷键）——共享同一份栈；
 * useOpenFiles 是 shell 实例级组合式，深层组件拿不到实例。
 *
 * 栈模型（三段式）：[...back] current [...forward]
 * - current：当前锚点 {path, line, column?}，随光标移动 / 活跃 tab 切换实时轻更新
 *   （纯赋值，不产生栈操作）；恢复链 reveal 落位引发的同点上报道控幂等
 * - 仅「锚点跳转」把旧 current 压入 back 并丢弃 forward（新方向导航作废
 *   前进历史，VS Code 同惯例）：换文件、或同文件行距 ≥ 阈值且当前锚点已
 *   停留够久（路过的中间位不留锚点——预览连翻 / 恢复落位过程的默认 1:1
 *   起点都是路过，不进历史）
 * - 后退/前进在 back/forward 间搬运 current，恢复动作经回调上抛宿主
 *   （useLayoutViews 复用 handleSearchOpenFile 的开文件 + 行定位轮询链）
 *
 * 项目隔离：路径相对项目根，跨项目同路径指向不同文件——项目切换整体作废
 * （beginSession，useLayoutViews 的 projectId watcher 驱动，语义对齐
 * useOpenFiles 切项目清空打开文件）
 */

/** 导航历史单点位置：line 为 1-based 行号；column 为可选 1-based 列号（P-20261002-148
 *  增量，随光标事件上报）——tab 切换的占位锚点拿不到光标列可缺省，恢复时落列 1 */
export interface NavLocation {
  path: string
  line: number
  column?: number
}

/** 同文件光标行距 ≥ 此值视为一次位置跳转（Goto 行 / 搜索跳转 / 定义跳转量级） */
const LINE_JUMP_MIN = 30
/** 锚点最短停留：停留不足即发生新跳转 = 路过，不留锚点（也吸收活跃 tab 切换
 *  与 viewState 恢复光标事件的到达次序差——恢复跳变落在此窗口内不产生噪声锚点） */
const DWELL_MS = 400
/** 后退/前进栈上限：足够覆盖一次深跳转链回溯，防长会话无限增长 */
const NAV_MAX = 50

const backStack = ref<NavLocation[]>([])
const forwardStack = ref<NavLocation[]>([])
const canNavigateBack = computed(() => backStack.value.length > 0)
const canNavigateForward = computed(() => forwardStack.value.length > 0)

/** 当前锚点（since = 锚定时刻，停留时长判定用）；无打开文件时为 null */
let current: (NavLocation & { since: number }) | null = null
let projectId = ''

/** 当前激活文件信标（P-20261002-16）：reportLocation/notifyActiveFile 的旁路
 *  只读镜像（响应式 ref 而非上面的非响应式 current），供拿不到 shell 实例的
 *  深层组件读「当前激活文件」（新建会话对话框 {file} 占位符消费）。项目切换
 *  （beginSession）即清空——路径是项目相对形态，跨项目无意义 */
const activeFilePath = ref('')

/** 活跃文件位置信标（P-20261004-52）：activeFilePath 的位置扩展镜像（随
 *  reportLocation 轻更新，纯赋值不产生栈操作），供 ui.snapshot 现场上报等
 *  消费方读「当前激活文件+行+列」。项目切换（beginSession）即清空，口径与
 *  activeFilePath 一致；diff 伪键/未命名草稿不镜像（isNavTrackable 同滤） */
const activeLocation = ref<NavLocation | null>(null)

/** 当前编辑器选区信标（P-20261005-149）：activeFilePath 同款旁路只读镜像，
 *  供拿不到编辑器实例的深层组件读「最近上报的选区文本」（新建会话对话框
 *  {selection} 占位符消费）。消费方按「打开时刻快照」语义取值（快照在消费
 *  侧——对话框打开后的选区变化不回灌已取的值），本信标只保最新值。项目切换
 *  （beginSession）即清空，与 activeFilePath 口径一致 */
const activeSelection = ref('')

/** 选区信标归属路径（内部记账）：编辑器实例卸载只清自己上报的值，防分屏
 *  另一组仍在场的选区被误清（同路径双组极端态由下一次选区上报自愈） */
let selectionOwnerPath = ''

/** 导航历史不可恢复的路径：diff 伪键（diff:...）无法按路径重开；未命名草稿
 *  （untitled://N）非真实磁盘路径——两态都只轻更新不进栈（同 closedFiles 口径） */
function isNavTrackable(path: string): boolean {
  return !!path && !path.startsWith('diff:') && !isUntitledPath(path)
}

/** 项目切换（shell 装配时首调）：projectId 变化即整体作废，同项目重入不清 */
function beginSession(pid: string): void {
  if (pid === projectId) return
  projectId = pid
  backStack.value = []
  forwardStack.value = []
  current = null
  activeFilePath.value = ''
  activeLocation.value = null
  activeSelection.value = ''
  selectionOwnerPath = ''
}

/** 把当前锚点压入后退栈并作废前进历史（锚点跳转的统一前奏）。
 *  相邻同点去重：重复激活/光标微动反复走到上报入口不堆栈——去重口径按
 *  path+line（行 = 锚点身份，列微动不破去重），命中时仅把栈顶列刷新为
 *  最新离开列（「回来又走」恢复目标跟着走） */
function anchorCurrent(): void {
  if (!current) return
  const top = backStack.value[backStack.value.length - 1]
  if (top && top.path === current.path && top.line === current.line) {
    if (current.column) top.column = current.column
    return
  }
  backStack.value.push({ path: current.path, line: current.line, column: current.column })
  if (backStack.value.length > NAV_MAX) backStack.value.shift()
  forwardStack.value = []
}

/**
 * 位置上报统一入口（MonacoEditor 光标事件 / 活跃 tab 变化双路上报，幂等）：
 * 换文件、或同文件行距跳变且当前锚点停留够久 → 锚点跳转；其余仅轻更新
 * 当前锚点（行号贴近实时，不产生栈操作）
 */
function reportLocation(path: string, line: number, column?: number): void {
  if (!isNavTrackable(path) || line < 1) return
  activeFilePath.value = path
  activeLocation.value = { path, line, column }
  const now = Date.now()
  if (!current || current.path !== path) {
    anchorCurrent()
    current = { path, line, column, since: now }
    return
  }
  if (Math.abs(line - current.line) >= LINE_JUMP_MIN && now - current.since >= DWELL_MS) {
    anchorCurrent()
    current = { path, line, column, since: now }
    return
  }
  current.line = line
  if (column) current.column = column
  current.since = now
}

/** 活跃 tab 变化上报（shell 层只有路径无行号）：同文件重入为幂等 no-op
 *  （行号由光标事件补充）；换文件锚定到占位行 1，光标事件随即轻更新修正 */
function notifyActiveFile(path: string): void {
  if (!isNavTrackable(path)) return
  if (current?.path === path) return
  reportLocation(path, 1)
}

/** 选区文本上报（P-20261005-149；MonacoEditor 选区事件时调用）：
 *  空选区上报空串即清信标（点击/光标移动不残留上一个文件的选区）。diff 伪键/
 *  未命名草稿的选区照收——选区是纯文本上下文，无「按路径重开」语义，不受
 *  isNavTrackable 过滤（与 activeFilePath 的过滤理由不同） */
function reportSelection(path: string, text: string): void {
  selectionOwnerPath = path
  activeSelection.value = text
}

/** 编辑器实例卸载：仅当信标归属本实例路径时清空（防「选区后关编辑器再开
 *  对话框」把已不存在的选区带进模板；分屏双组互不误清） */
function releaseSelection(path: string): void {
  if (selectionOwnerPath !== path) return
  selectionOwnerPath = ''
  activeSelection.value = ''
}

/**
 * 后退：目标弹栈、当前位置让位前进栈，恢复动作上抛宿主。无后退项为 no-op。
 * 恢复链 reveal 落位引发的后续上报与 target 同点，reportLocation 幂等不增锚
 */
function navigateBack(restore: (loc: NavLocation) => void): void {
  const target = backStack.value.pop()
  if (!target) return
  if (current) {
    forwardStack.value.push({ path: current.path, line: current.line, column: current.column })
    if (forwardStack.value.length > NAV_MAX) forwardStack.value.shift()
  }
  current = { path: target.path, line: target.line, column: target.column, since: Date.now() }
  restore(target)
}

/** 前进：后退的镜像（目标弹自前进栈，当前位置让位回后退栈） */
function navigateForward(restore: (loc: NavLocation) => void): void {
  const target = forwardStack.value.pop()
  if (!target) return
  if (current) {
    backStack.value.push({ path: current.path, line: current.line, column: current.column })
    if (backStack.value.length > NAV_MAX) backStack.value.shift()
  }
  current = { path: target.path, line: target.line, column: target.column, since: Date.now() }
  restore(target)
}

export function useEditorNavHistory() {
  return {
    canNavigateBack,
    canNavigateForward,
    activeFilePath,
    activeLocation,
    activeSelection,
    beginSession,
    reportLocation,
    notifyActiveFile,
    reportSelection,
    releaseSelection,
    navigateBack,
    navigateForward,
  }
}
