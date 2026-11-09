import { reactive, ref } from 'vue'
import type { Component } from 'vue'
import {
  FolderOutline, CheckmarkOutline, GitBranchOutline, TerminalOutline,
  AlbumsOutline, ChatbubblesOutline, GlobeOutline, LinkOutline,
  EyeOutline, ClipboardOutline, DocumentTextOutline, AlertCircleOutline,
  PulseOutline, SpeedometerOutline, ServerOutline, CloudCircleOutline,
} from '@vicons/ionicons5'
import DshIcon from '@/components/common/DshIcon.vue'
import { usePanelLayout } from '@/composables/usePanelLayout'
import { useAgentTerminal } from '@/composables/useAgentTerminal'
import { useErrorLogStore } from '@/stores/errorLog'
import { useUIStateStore } from '@/stores/uiState'

// ── 面板注册表 ──
// 活动栏按钮 / 底部 Tab / 智能操作通道 panel 白名单的唯一数据源。
// 新增一个面板 = 这里一次 registerPanel（或模块侧自行注册），
// 不再需要在 ActivityBar/BottomPanel/Layout 白名单/命令面板等 5+ 处各改一遍。
//
// 设计约束：DOM 类名与 title 语义与历史硬编码版完全一致（e2e 依赖
// .rail-btn[title=…] / .bottom-tabs 按钮 / panel 事件白名单行为）。

export type PanelGroup = 'rail-top' | 'bottom-tab'

export interface PanelDef {
  /** 面板唯一 id：side 用 files/changes；bottom 用 git/terminal/commit/console */
  id: string
  group: PanelGroup
  /** 排序（组内升序），内置面板占用 10 的倍数，插件/新面板可插在中间 */
  order: number
  /** 活动栏按钮 title/aria（i18n key）；bottom tab 无需 */
  titleKey?: string
  /** 底部 tab 文案（i18n key） */
  labelKey?: string
  /** 底部 tab 文案（字面量，优先于 labelKey；如 'Git' 这类无需翻译的名字） */
  labelRaw?: string
  icon: Component
  /** aria-controls（活动栏按钮关联的面板容器 id） */
  controls?: 'side-panel' | 'bottom-panel'
  /** 是否处于激活态（活动栏高亮） */
  active?: () => boolean
  /** 点击行为（缺省：底部 tab 切 bottomTab；侧栏 id 交 togglePanel） */
  onClick?: () => void
  /** 底部 tab 徽标（如 console 未读错误数） */
  badge?: () => number
  /** 编辑器选区 Alt+拖拽悬停 spring-open（P-20261003-162）：拖拽中指针悬停
   *  对应 rail 按钮 400ms → ActivityBar 调本回调展开该主区视图。编辑器与
   *  agent docked 管理页互斥，这是把选区拖到侧栏会话的唯一可达路径 */
  onSelectionDragSpring?: () => void
}

// ── 面板布局状态（模块级单例，与 usePanelLayout 同一套响应式状态） ──
const layout = usePanelLayout()

const panels = reactive(new Map<string, PanelDef>())

// 内部键：组 + id 同名可共存（如 git 同时是活动栏按钮与底部 tab）
function panelKey(id: string, group: PanelGroup): string {
  return `${group}\u0000${id}`
}

export function registerPanel(def: PanelDef): void {
  panels.set(panelKey(def.id, def.group), def)
}

export function unregisterPanel(id: string, group: PanelGroup = 'rail-top'): void {
  panels.delete(panelKey(id, group))
}

export function getPanel(id: string): PanelDef | undefined {
  for (const p of panels.values()) {
    if (p.id === id) return p
  }
  return undefined
}

// ── 活动栏手动序（P-20261003-252）──
// 拖拽重排的用户自定义 rail-top 顺序；null = 未定制（按内置 order）。
// panelList 是顺序的唯一出口：活动栏渲染与 Ctrl+1-9 数字直达
// （activateRailPanel / railPanelCount）都经它取表——「数字 = 位置」语义随
// 新序自动一致，重排后无需第二处映射同步
const railTopManualOrder = ref<string[] | null>(null)

/** 按组取面板（组内按 order 升序；rail-top 若有用户手动序，手动表内的面板按
 *  表序在前，未收录的面板（新注册插件等）按内置 order 续尾——定制不吞新面板） */
export function panelList(group: PanelGroup): PanelDef[] {
  const list = [...panels.values()].filter(p => p.group === group)
  const manual = group === 'rail-top' ? railTopManualOrder.value : null
  if (manual) {
    const pos = new Map(manual.map((id, i) => [id, i]))
    return list.sort((a, b) => {
      const ia = pos.get(a.id)
      const ib = pos.get(b.id)
      if (ia !== undefined && ib !== undefined) return ia - ib
      if (ia !== undefined) return -1
      if (ib !== undefined) return 1
      return a.order - b.order
    })
  }
  return list.sort((a, b) => a.order - b.order)
}

/** 活动栏 rail-top 当前视觉序（活动栏拖拽重排的编排基准） */
export function railTopIds(): string[] {
  return panelList('rail-top').map(p => p.id)
}

/** 持久化手动序（低频用户动作即时写；pinia 未激活等环境问题静默——会话内
 *  仍生效，下次重排重试，layoutLock.persist 同款容错） */
function persistRailOrder(): void {
  try {
    const order = railTopManualOrder.value
    if (order) void useUIStateStore().saveRailTopOrder(order)
  } catch { /* silent */ }
}

/** 拖拽重排：drag 面板移到 target 之前（VS Code 活动栏惯例）。同名（拖到自己
 *  身上）或任一 id 未注册 no-op；相邻后继拖拽结果与现状相同同样 no-op（免空写）。
 *  返回是否产生顺序变化 */
export function moveRailPanel(dragId: string, targetId: string): boolean {
  if (!dragId || dragId === targetId) return false
  const current = railTopIds()
  const from = current.indexOf(dragId)
  const to = current.indexOf(targetId)
  if (from < 0 || to < 0) return false
  const next = [...current]
  next.splice(from, 1)
  // 移除后 target 前移一位（仅当从后往前拖时）：insert-before 语义
  next.splice(to > from ? to - 1 : to, 0, dragId)
  if (next.every((id, i) => id === current[i])) return false
  railTopManualOrder.value = next
  persistRailOrder()
  return true
}

/** 从 bootstrap 已拉取的 uiState 快照恢复手动序（useLayoutBootstrap
 *  restoreLayoutOnly 与 layoutLock 同点调用；同一份快照零额外请求）。只改内存
 *  不回写——恢复出的初始值不是本页变更（layoutLock.restoreFromState 同语义）。
 *  形状防御：非字符串条目剔除、未注册 id 剔除（面板已下线/注册面随版本漂移）、
 *  重复去重；清洗后空表 = 未定制回落内置序 */
export function restoreRailTopOrder(state: { railOrder?: { railTop?: unknown } } | null | undefined): void {
  const raw = state?.railOrder?.railTop
  if (!Array.isArray(raw)) {
    railTopManualOrder.value = null
    return
  }
  const known = new Set([...panels.values()].filter(p => p.group === 'rail-top').map(p => p.id))
  const cleaned = [...new Set(raw.filter((x): x is string => typeof x === 'string' && known.has(x)))]
  railTopManualOrder.value = cleaned.length > 0 ? cleaned : null
}

/** Ctrl+1..9 数字键切面板：按活动栏视觉顺序激活第 index（0 基）个；
 * 越界返回 false（调用方据此不消费按键，如 Ctrl+9 超出面板数时放行浏览器）。
 * 视觉序含用户手动序（P-20261003-252 拖拽重排）——数字=位置语义随新序自动一致 */
export function activateRailPanel(index: number): boolean {
  const p = panelList('rail-top')[index]
  if (!p) return false
  p.onClick?.()
  return true
}

/** 活动栏面板总数（快捷键越界判断用） */
export function railPanelCount(): number {
  return panelList('rail-top').length
}

/** 智能操作通道 panel 事件白名单：已注册且可被 togglePanel 驱动的面板 id */
export function toggleablePanelIds(): Set<string> {
  return new Set(
    [...panels.values()]
      .map(p => p.id)
      .filter(id => id === 'files' || id === 'changes' || id === 'git' || id === 'terminal'),
  )
}

// ── 内置面板注册 ──

// 活动栏：项目仪表盘（P-20261005-224，主区视图）：git/会话/问题/近期活动四卡
// 一屏 + 直达接线，进项目先看状态再动手的项目级常态首页。order 65 落在
// remote-console(60) 之后——活动栏位次即 Ctrl+N 数字直达（panelList 位置序），
// files..terminal 的既有数字键位受守护不挤占（notes/stream 注册注记同纪律）；
// 常用者可拖拽重排置顶（P-252 手动序持久化）。图标 Speedometer（仪表盘本义）：
// 与监控大屏同语（状态一览），与文件树/分支/气泡不撞形
registerPanel({
  id: 'dashboard',
  group: 'rail-top',
  order: 65,
  titleKey: 'dashboard.title',
  icon: SpeedometerOutline,
  active: () => layout.showDashboard.value,
  onClick: () => {
    agentTerminalApi().hideDocked()
    layout.toggleDashboard()
  },
})

// 活动栏：项目文件（侧栏）
registerPanel({
  id: 'files',
  group: 'rail-top',
  order: 10,
  titleKey: 'layout.projectFiles',
  icon: FolderOutline,
  controls: 'side-panel',
  active: () => layout.showSidePanel.value && layout.sideView.value === 'files',
  onClick: () => layout.togglePanel('files'),
})

// 活动栏：提交面板（侧栏专用入口，changes 按钮语义）
registerPanel({
  id: 'changes',
  group: 'rail-top',
  order: 20,
  titleKey: 'layout.commit',
  icon: CheckmarkOutline,
  controls: 'side-panel',
  active: () => layout.commitLocation.value === 'sidebar' && layout.showSidePanel.value && layout.sideView.value === 'changes',
  onClick: () => layout.showCommitInSidebar(),
})

// 活动栏：TODO 面板（侧栏，P-20261002-25）：代码注释 TODO/FIXME/XXX/HACK
// 聚合「赊账清单」——agent 协作场景里 TODO 常是人类留给下一轮的灯塔。
// 图标 Clipboard（检查清单）：清单隐喻与面板形态一一对应，与文件树文件夹/
// 提交对勾/终端方块均不撞形
registerPanel({
  id: 'todos',
  group: 'rail-top',
  order: 25,
  titleKey: 'todo.panel.title',
  icon: ClipboardOutline,
  controls: 'side-panel',
  active: () => layout.showSidePanel.value && layout.sideView.value === 'todos',
  onClick: () => layout.togglePanel('todos'),
})

// 活动栏：跨项目实时变更流面板（P-20261003-232）：file.changed 跨项目聚合
// 时间线（值班大屏卡之外的 IDE 内入口）。order 47 落在笔记(45)之后、会话
// 管理(50)之前：不挤占 files..notes 的既有数字键位与 agent-terminal 位。
// 图标 Pulse（脉冲波形 = 实时活动流）：与 todos 清单/笔记文档/终端方块不撞形
registerPanel({
  id: 'stream',
  group: 'rail-top',
  order: 47,
  titleKey: 'changeStream.panelTitle',
  icon: PulseOutline,
  controls: 'side-panel',
  active: () => layout.showSidePanel.value && layout.sideView.value === 'stream',
  onClick: () => layout.togglePanel('stream'),
})

// 活动栏：项目环境画像面板（P-20261007-14）：dev 端口观测 × 输出哨兵规则 ×
// 部署目标摘要的「项目环境简历」侧栏页。order 66 落在 dashboard(65) 之后——
// 尾部追加不动任何既有数字键位（panelList 位置序，registry.test.ts 同步）。
// 图标 ServerOutline（服务器 = 环境在跑什么）：远程控制台用 Globe、仪表盘用
// Speedometer，环境/服务语义与其不撞形
registerPanel({
  id: 'env',
  group: 'rail-top',
  order: 66,
  titleKey: 'envProfile.title',
  icon: ServerOutline,
  controls: 'side-panel',
  active: () => layout.showSidePanel.value && layout.sideView.value === 'env',
  onClick: () => layout.togglePanel('env'),
})

// 活动栏：多实例同步中心（P-20261023-1）：项目+上下文跨实例拉取/推送/定时
// 同步一侧栏页。order 67 落在 env(66) 之后尾部追加，不动既有数字键位。
// 图标 CloudCircleOutline（云+环 = 实例对间搬运，NAV_ICONS['sync'] 同源）：
// 与文件分享的 Link、远程的 Globe、环境的 Server 均不撞形
registerPanel({
  id: 'sync',
  group: 'rail-top',
  order: 67,
  titleKey: 'sync.title',
  icon: CloudCircleOutline,
  controls: 'side-panel',
  active: () => layout.showSidePanel.value && layout.sideView.value === 'sync',
  onClick: () => layout.togglePanel('sync'),
})

// 活动栏 + 底部 tab：Git 面板
registerPanel({
  id: 'git',
  group: 'rail-top',
  order: 30,
  titleKey: 'layout.gitManage',
  icon: GitBranchOutline,
  controls: 'bottom-panel',
  active: () => layout.showBottomPanel.value && layout.bottomTab.value === 'git',
  onClick: () => layout.togglePanel('git'),
})
registerPanel({
  id: 'git',
  group: 'bottom-tab',
  order: 20,
  labelRaw: 'Git',
  icon: GitBranchOutline,
})

// 活动栏 + 底部 tab：终端
registerPanel({
  id: 'terminal',
  group: 'rail-top',
  order: 40,
  titleKey: 'layout.terminal',
  icon: TerminalOutline,
  controls: 'bottom-panel',
  active: () => layout.showBottomPanel.value && layout.bottomTab.value === 'terminal',
  onClick: () => layout.togglePanel('terminal'),
})
registerPanel({
  id: 'terminal',
  group: 'bottom-tab',
  order: 10,
  labelKey: 'bottomPanel.terminal',
  icon: TerminalOutline,
})

// 活动栏：笔记（P-20261002-110 人机共享便签层 → P-20261108-2 独立视图）：笔记
// 脱离侧栏窄条成 notepad 式主区视图（占编辑器位，与远程/分享/dsh/仪表盘/agent
// docked 互斥；首页另有工具条入口走 overlay 形态）——无 controls（主区视图形态，
// agent-terminal/dashboard 同款），先收 docked 再切（dashboard 同款前置）。
// order 45 落在终端(40)之后、会话管理(50)之前：不挤占 files..terminal 的既有
// Ctrl+1..5 数字键位（panel-registry 守护对键位的既有期望保持不变）。
// 图标 DocumentText（文档+文本行）：便签隐喻，与 todos 清单/文件树文件夹不撞形
registerPanel({
  id: 'notes',
  group: 'rail-top',
  order: 45,
  titleKey: 'notes.panel.title',
  icon: DocumentTextOutline,
  active: () => layout.showNotesView.value,
  onClick: () => {
    agentTerminalApi().hideDocked()
    layout.toggleNotesView()
  },
})

// 底部 tab：控制台（含未读徽标）
// （提交面板只保留活动栏左侧形态：底部"变更" tab 与左侧入口完全重复，已移除；
//   历史 uistate 里保存的 bottomTab='commit' 由 useLayoutBootstrap 归一为 'git'）

// 底部 tab：端口预览（dev server 等本机回环端口经 /preview/:port 反代在
// iframe 内查看——远程/平板形态下「终端里起了服务 → 面板里直接看」）
registerPanel({
  id: 'preview',
  group: 'bottom-tab',
  order: 30,
  labelKey: 'bottomPanel.preview',
  icon: EyeOutline,
})

// 底部 tab：问题面板（P-20261003-297，Monaco 诊断聚合）：打开文件的错误/
// 警告一屏总览，StatusBar 徽标（useEditorProblems 计数）与面板同源。
// order 35 落在预览(30)与控制台(40)之间；图标 AlertCircle（圆圈叹号=问题）
// 与终端方块/Git 分支/预览之眼不撞形
registerPanel({
  id: 'problems',
  group: 'bottom-tab',
  order: 35,
  labelKey: 'bottomPanel.problems',
  icon: AlertCircleOutline,
})

// 底部 tab：控制台（含未读徽标）
registerPanel({
  id: 'console',
  group: 'bottom-tab',
  order: 40,
  labelKey: 'bottomPanel.console',
  icon: AlbumsOutline,
  badge: () => useErrorLogStore().unreadCount,
})

// 活动栏：终端会话管理（系统级多会话：docked 管理页/悬浮窗/悬浮条——免项目绑定，
// 底层运行时 claude/codex/dsh 建会话时选择或按可用性自动选型）。
// 图标 ChatbubblesOutline（双对话气泡 = 与智能体的多路会话）：终端会话管理
// 是 AI 会话中枢，气泡在活动栏里独一无二，与 git 分支/终端方块均不撞形。
// useAgentTerminal 内部依赖 pinia store：本模块在 app 装配早期被 import，
// 必须惰性获取（首次 active/onClick 调用时 pinia 已就绪），不能在模块加载期实例化
let agentTerminal: ReturnType<typeof useAgentTerminal> | null = null
function agentTerminalApi(): ReturnType<typeof useAgentTerminal> {
  if (!agentTerminal) agentTerminal = useAgentTerminal()
  return agentTerminal
}
registerPanel({
  id: 'agent-terminal',
  group: 'rail-top',
  order: 50,
  titleKey: 'agentTerminal.title',
  // Grid（会话网格）：与"会话总览"同一隐喻；原 Layers 与远程控制台的 Server
  // 在活动栏里形似难辨
  icon: ChatbubblesOutline,
  active: () => agentTerminalApi().visible.value && agentTerminalApi().mode.value === 'docked',
  onClick: () => agentTerminalApi().toggleDocked(),
  // 选区拖拽悬停 spring-open：open('docked') 幂等（已开着不会 toggle 关掉）
  onSelectionDragSpring: () => { void agentTerminalApi().open('docked') },
})

// 活动栏：dsh 控制台（P6：iframe 嵌入本机 dsh Web UI，经回环反代通道；
// 品牌图标 = DeepSeek 官方标，一眼识别）
registerPanel({
  id: 'dsh-console',
  group: 'rail-top',
  order: 57,
  titleKey: 'dshConsole.title',
  icon: DshIcon,
  active: () => layout.showDshConsole.value,
  onClick: () => {
    agentTerminalApi().hideDocked()
    layout.toggleDshConsole()
  },
})

// 活动栏：文件分享管理（主区视图，短链管理）
// 图标 LinkOutline（链接 = 分享的核心交付物）：原 ShareSocialOutline 与 git 面板的
// GitBranchOutline 同属「圆点+连线」族，20px 深色 rail 同屏几乎不可辨（用户红框
// 实测，P-20261022-2 首批）；该对已入 actionIcons 的 FORBIDDEN_ICON_PAIRS 禁回潮。
// 目的地登记见 NAV_ICONS['share-manager']
registerPanel({
  id: 'share-manager',
  group: 'rail-top',
  order: 55,
  titleKey: 'share.managerTitle',
  icon: LinkOutline,
  active: () => layout.showShareManager.value,
  onClick: () => {
    agentTerminalApi().hideDocked()
    layout.toggleShareManager()
  },
})

// 活动栏：远程控制台（主区视图；与智能体 docked 管理页互斥）
registerPanel({
  id: 'remote-console',
  group: 'rail-top',
  order: 60,
  titleKey: 'remoteConsole.title',
  // Globe（远程=地球）：与终端会话管理的图标拉开辨识度
  icon: GlobeOutline,
  active: () => layout.showRemoteConsole.value,
  onClick: () => {
    agentTerminalApi().hideDocked()
    layout.toggleRemoteConsole()
  },
})
