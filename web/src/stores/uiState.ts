import { defineStore } from 'pinia'
import { ref } from 'vue'
import { uiStateApi, type TaskItem } from '../api/client'
import { useInstanceStore } from './instance'
import type { AgentTaskTemplate } from '../utils/agentTaskTemplate'
import type { DiffComment } from '../utils/diffComments'
import { normalizeDiffComments } from '../utils/diffComments'
import type { BookmarkRecord } from '../utils/bookmarkAnchor'
import { normalizeBookmarkRecords } from '../utils/bookmarkAnchor'

/** 任务运行器运行历史条目（P-20261002-120）：一次运行 = 一条。
 *  task 存触发时刻的任务定义快照（原任务定义），重跑按快照重触发 */
export interface TaskRunEntry {
  task: TaskItem
  /** 触发时间戳（ms）——区分同任务的多次运行 */
  at: number
}

/** Markdown 编辑器三态显示模式（P-20261003-18）：source 源码 / preview 预览 / split 分屏 */
export type EditorMdMode = 'source' | 'preview' | 'split'

/** UI 状态持久化数据面（/api/ui-state 实例记录）。
 *  纪律（P-20261006-24）：新增「固定形状嵌套命名空间」顶层键必须同步登记
 *  NESTED_UISTATE_SUBFIELDS 注册表（键级补丁协议是命名空间级浅合并，不登记
 *  则「携带父键缺子键」的补丁会把基底子键剥掉——钉选丢失根因模式）；整表
 *  Record 命名空间须记入注册表范围类型的排除清单（缺子键 = 有意删除）。
 *  漏登由注册表 satisfies 对账断言编译期兜底 */
export interface UIStateData {
  instanceId?: string
  projectId?: string
  editor?: {
    openFiles: string[]
    activeIndex: number
    scrollPositions: Record<string, number>
    /** 分屏开合（P-13）；分屏组文件清单/活跃位见下两字段（P-20261002-94 起一并记忆） */
    splitOpen?: boolean
    /** 分屏组（组 1）路径清单（P-20261002-94）：与主组 openFiles 同为项目相对
     *  路径，恢复时已删文件降级跳过；采集端剔除 untitled/diff/预览签并截到
     *  上限（SPLIT_FILES_MAX，useLayoutState 收口） */
    splitFiles?: string[]
    /** 分屏组活跃路径（P-20261002-94）：'' = 无活跃或活跃签不可恢复（被剔除/
     *  截掉） */
    splitActiveFile?: string
    /** 分屏方向（P-20261005-230 正交拆分）：horizontal=左右（缺省）/ vertical=上下。
     *  可选字段向后兼容——旧记录无此键（=横向行为完全不变，幂等读取），脏值读取端
     *  回落横向 */
    splitDirection?: 'horizontal' | 'vertical'
  }
  fileTree?: {
    expandedDirs: string[]
    selectedFile: string
    /** 常用目录钉选（P-20261002-97）：projectId -> 有序路径表（新→旧，上限 8）。
     *  做成映射而非平铺数组：实例内切换项目时 fileTree 命名空间会被新项目快照
     *  整体覆盖（agentTerminal.projectSessionOrder 同款项目级键控先例），平铺
     *  列表只留得住「保存时刻的当前项目」达不成项目级持久 */
    pinnedDirs?: Record<string, string[]>
  }
  layout?: {
    sidePanelWidth: number
    bottomPanelHeight: number
    showSidePanel: boolean
    showBottomPanel: boolean
    sideView: string
    bottomTab: string
    commitLocation?: 'sidebar' | 'bottom'
    bottomPanelMaximized?: boolean
    bottomPanelEditorMaximized?: boolean
  }
  terminal?: {
    activeTabId: string
  }
  gitPanel?: {
    collapsedSections: string[]
    selectedBranch: string
  }
  // 远程控制台（项目页内嵌视图）——tab 列表 + 主机目录分组 + 视图可见性，
  // 低频写入即时保存，刷新后按此恢复（含自动回到远程视图）
  remoteConsole?: {
    tabs: { hostId: string; sessionId: string; title: string; tmuxName?: string }[]
    groups?: { id: string; name: string; hostIds: string[] }[]
    open?: boolean
    sidebarCollapsed?: boolean
  }
  // 智能体（系统级多会话终端）——会话分组 + 侧栏折叠 + 项目分组折叠/排序
  agentTerminal?: {
    groups?: { id: string; name: string; sessionIds: string[] }[]
    sidebarCollapsed?: boolean
    /** 项目分组折叠集合（projectId 列表） */
    collapsedProjects?: string[]
    /** 项目分组展示序（projectId 有序表，未收录的项目按自然序排在尾部） */
    projectOrder?: string[]
    /** 项目内会话手动序（projectId -> sessionIds 有序表；default 排序模式生效） */
    projectSessionOrder?: Record<string, string[]>
    /** 最后查看的会话 id（boot 恢复选中用；跨刷新延续查看上下文） */
    lastViewedSessionId?: string
  }
  // dsh 控制台主区视图/首页浮层可见性——刷新后原样恢复（项目页主区与首页
  // 浮层共用同一全局开关，宿主各自响应）
  dshConsole?: {
    open?: boolean
  }
  // 项目仪表盘（P-20261005-224）：landing = 进入项目时的默认落点偏好（开 =
  // 从首页等显式入口进项目先落仪表盘视图）；视图本身的显隐不落盘（纯查看面，
  // 刷新回上次工作形态）。独立命名空间同 layoutLock 理由——collect 不认识本键
  // 会被浅合并抹掉；layout 重置不波及
  dashboard?: {
    landing?: boolean
  }
  // 任务面板运行历史（P-20261002-120）：按次记录的运行条目（新→旧，至多
  // 5 条）——每次运行（含重跑）产生新条目，不复用旧记录、at 时间戳区分同
  // 任务多次运行；task 为触发时的任务定义快照，重跑以快照重触发，不依赖
  // 清单仍含该任务（旧版 recent 为 `source::cwd::name` 键、无法还原命令，
  // 读取时静默丢弃，由后续运行自然重建）
  taskRunner?: {
    recent?: TaskRunEntry[]
  }
  // 工作现场存档点（P-20261002-84）：projectId → 命名快照列表（新→旧）。
  // 快照是 uiState 的项目级副本（主组标签清单/活跃文件/面板开合与宽度/树展开/
  // 分支名），collectCurrentUIState 不认识本命名空间——auto-save 浅合并天然保留
  snapshots?: Record<string, WorkspaceSnapshot[]>
  // 编辑器书签锚（P-20261002-131）：projectId → 文件相对路径 → 书签记录表（行升序；
  // 记录 = 行号 + 行内容锚，P-20261004-105 扩展——旧纯行号数组 number[] 读取端
  // 原样收编为无锚记录降级，向后兼容不要求清数据）。
  // 项目维度持久化（跨刷新/跨文件往返一键跳回），条目上限在写入方
  // useEditorBookmarks 内收口（每项目 ≤ 100 行，防 uiState 膨胀）；
  // collectCurrentUIState 不认识本命名空间——auto-save 浅合并天然保留（同 snapshots）
  bookmarks?: Record<string, Record<string, BookmarkRecord[]>>
  // diff 审阅留言（P-20261003-279）：projectId → 文件相对路径 → 行级留言列表。
  // 产出 diff 审阅的「这里要改」沉淀（多轮审阅记录，重开 diff 还在），锚点 =
  // 右侧工作区版本行号 + 留言时行内容快照（漂移容忍在写入方 useDiffComments
  // 收口：每项目 ≤ 100 条、读取端形状防御）；collect 不认识本键——auto-save
  // 浅合并天然保留（同 bookmarks）
  diffComments?: Record<string, Record<string, DiffComment[]>>
  // Markdown 模式偏好（P-20261003-18）：上次使用的 md 三态（EditorMdMode）。
  // 打开 .md 恢复；独立命名空间而非塞进 editor——collectCurrentUIState 每次自动
  // 保存整体重建 editor 键（浅合并按命名空间替换），未知字段会被静默抹掉
  //（fileTree.pinnedDirs 同款教训）；collect 不认识本键——auto-save 浅合并天然保留
  editorPrefs?: {
    mdMode?: string
  }
  // 智能体任务模板（P-20261002-16）：用户定制后的有序模板表。items 缺省 =
  // 未定制（消费端展示 i18n 实时派生的出厂预置，见 useAgentTaskTemplates）；
  // collect 不认识本键——auto-save 浅合并天然保留（同 snapshots/bookmarks）
  agentTaskTemplates?: {
    items?: AgentTaskTemplate[]
  }
  // 布局锁定（P-20261003-180）：防误拖 toggle 状态。独立命名空间而非塞进
  // layout——collectCurrentUIState 整体重建 layout 键（浅合并按命名空间替换），
  // 未收录字段会被静默抹掉（editorPrefs.mdMode 同款教训）；layout 重置
  // （resetLayoutState 只动 layout/fileTree）亦不波及本开关
  layoutLock?: {
    locked?: boolean
  }
  // 活动栏面板手动序（P-20261003-252）：rail-top 面板 id 有序表（拖拽重排产物，
  // 消费端 panels/registry.ts 的 panelList）。独立命名空间而非塞进 layout——
  // collect 不认识本键会被浅合并抹掉（layoutLock 同款教训）；顺序是用户策展的
  // 个性化偏好（同 agentTerminal.projectOrder / fileTree.pinnedDirs 哲学），
  // layout 重置不波及。恢复走 bootstrap 已拉取快照（restoreRailTopOrder），
  // 无独立读取器
  railOrder?: {
    railTop?: string[]
  }
  // 值班大屏卡片类目布局（P-20261004-18）：活动卡类目顺序 + 隐藏集。独立命名
  // 空间同 railOrder 理由——collect 不认识本键（monitor 页也无 collect 写端，
  // 编辑动作走 saveMonitorBoardLayout 即时键级补丁），浅合并天然保留；类目
  // 顺序/显隐是用户策展的值守偏好而非布局几何，layout 重置不波及。形状防御
  // 分两层：本读取器只做数组/字符串清洗，已知类目 id 收敛在
  // utils/monitorBoardLayout（面板注册表 restoreRailTopOrder 同款分工）
  monitorBoard?: {
    cardOrder?: string[]
    hiddenCards?: string[]
  }
  // 通知中心未读分界线（P-20261003-259）：lastSeenAt = 上次查看时点（面板关闭
  // 时刻 ms）。通知列表按条目 time 与之比较渲染「上次查看后 N 条新增」分界线；
  // 面板关闭即写、打开读（跨刷新/跨标签延续）。独立命名空间同 layoutLock 理由
  // ——collectCurrentUIState 不认识本键，键级补丁浅合并天然保留
  notificationCenter?: {
    lastSeenAt?: number
  }
  // 同步中心配置记忆（P-20261023-1 方案③「配置记忆 + 重跑上次」）：上次手动
  // 同步的方向/对端集/项目集/上下文集。执行成功即写、面板打开读（首屏一键
  // 重跑）。独立命名空间同 layoutLock 理由——collect 不认识本键，键级补丁
  // 浅合并天然保留
  sync?: {
    direction?: 'pull' | 'push'
    peers?: string[]
    projects?: string[]
    contexts?: string[]
  }
  // 冲突 agent 派单模板记忆（P-20261008-10）：template = 用户上次发起委派时的
  // 偏离默认措辞（trim 后）。独立命名空间同 layoutLock 理由——collect 不认识
  // 本键，键级补丁浅合并天然保留；全局口径（偏好措辞与项目弱相关）。'' 缺省
  // = 无记忆（弹层回 i18n 实时派生默认，防默认文案播种凝固，useAgentTaskTemplates
  // 同哲学）；读取端形状防御在 getConflictAgentTemplate
  conflictAgent?: {
    template?: string
  }
}

// ============== 嵌套命名空间子字段注册表（P-20261006-24） ==============

/** 注册表范围类型：UIStateData 的「固定形状嵌套命名空间」顶层键。排除三类：
 *  instanceId/projectId 标量；snapshots/bookmarks/diffComments 整表 Record
 *  命名空间——写端恒发完整表，「缺子键 = 有意删除」是语义而非事故，回填反而
 *  复活已删条目。新增键若属整表类，加入本排除清单即是显式归类动作 */
type NestedNamespaceKey = Exclude<
  keyof UIStateData,
  'instanceId' | 'projectId' | 'snapshots' | 'bookmarks' | 'diffComments'
>
/** 子字段清单形态：键必须穷尽该命名空间类型的全部子字段（Record 全键必需）——
 *  已知键新增子字段未补表 → satisfies 编译红 */
type SubfieldTable<K extends NestedNamespaceKey> = Record<keyof NonNullable<UIStateData[K]> & string, true>

/** 嵌套子字段注册表（P-20261006-24）：键级补丁协议是顶层命名空间浅合并（服务端
 *  整键替换），补丁「携带父键缺子键」会把基底里的子键剥掉——钉选重启丢失 bug
 * （e2e file-tree-pinned 实证，756e3753 根修）即 fileTree.pinnedDirs 单键踩中
 *  此模式。凡此表内命名空间：发送前定稿（finalizeRecord）与内存基底推进
 * （mergeKnownAll / patchNamespaces）统一经 backfillNestedSubfields 从基底回填
 *  缺失子字段。纪律：UIStateData 新增嵌套键必须入表、已知键新增子字段必须补
 *  表——漏登由 satisfies 对账断言编译期兜底（npm run check 红），表驱动单测
 *  uiState-nested-keys.test.ts 随新键自动覆盖（守卫模板） */
export const NESTED_UISTATE_SUBFIELDS = {
  editor: { openFiles: true, activeIndex: true, scrollPositions: true, splitOpen: true, splitFiles: true, splitActiveFile: true, splitDirection: true },
  fileTree: { expandedDirs: true, selectedFile: true, pinnedDirs: true },
  layout: { sidePanelWidth: true, bottomPanelHeight: true, showSidePanel: true, showBottomPanel: true, sideView: true, bottomTab: true, commitLocation: true, bottomPanelMaximized: true, bottomPanelEditorMaximized: true },
  terminal: { activeTabId: true },
  gitPanel: { collapsedSections: true, selectedBranch: true },
  remoteConsole: { tabs: true, groups: true, open: true, sidebarCollapsed: true },
  agentTerminal: { groups: true, sidebarCollapsed: true, collapsedProjects: true, projectOrder: true, projectSessionOrder: true, lastViewedSessionId: true },
  dshConsole: { open: true },
  dashboard: { landing: true },
  taskRunner: { recent: true },
  editorPrefs: { mdMode: true },
  agentTaskTemplates: { items: true },
  layoutLock: { locked: true },
  railOrder: { railTop: true },
  monitorBoard: { cardOrder: true, hiddenCards: true },
  notificationCenter: { lastSeenAt: true },
  sync: { direction: true, peers: true, projects: true, contexts: true },
  conflictAgent: { template: true },
} as const satisfies { [K in NestedNamespaceKey]: SubfieldTable<K> }

/** 快照 schema 版本（P-20261003-68）：快照字段面广、随 uiState 演进需可辨识——
 *  恢复端只按已知字段防御式应用（未知字段忽略不崩），缺 version 的条目视为
 *  P-20261002-84 legacy（已知字段照常应用），不做硬门槛 */
export const WORKSPACE_SNAPSHOT_VERSION = 1

/** agent 会话组结构描述（P-20261003-68）：仅展示层分组结构（id/名称/成员有序表），
 *  恢复只写 uiState.agentTerminal.groups，不自动拉起会话（生命周期另管） */
export interface SnapshotAgentGroup {
  id: string
  name: string
  sessionIds: string[]
}

/** 工作现场存档（P-20261002-84）：「大改前存个档」的命名快照。
 *  分屏组文件列表不存——快照是策展预设位（存档时刻的精选现场），与 uiState
 *  自动持久化的分屏组清单（P-20261002-94 editor.splitFiles）语义分工，本条只含主组清单 */
export interface WorkspaceSnapshot {
  id: string
  /** schema 版本（P-20261003-68 起写入；缺省 = legacy，按已知字段应用） */
  version?: number
  name: string
  savedAt: number
  /** 存档时刻的当前分支（恢复时不同仅提示不强切） */
  branch: string
  editor: {
    /** 主组标签路径清单（项目相对路径） */
    openFiles: string[]
    /** 活跃标签路径（无活跃/活跃为 diff·草稿 = ''） */
    activeFile: string
    /** 分屏开合（P-20261003-68）：与 uiState.editor.splitOpen 同维度，只记开合
     *  不记分屏组文件列表（清单归 uiState 自动持久化 P-20261002-94，快照保持
     *  策展预设边界）；缺省 = 该维度不参与恢复 */
    splitOpen?: boolean
  }
  layout: {
    sidePanelWidth: number
    bottomPanelHeight: number
    showSidePanel: boolean
    showBottomPanel: boolean
    sideView: string
    bottomTab: string
  }
  /** 文件树展开目录（来源 localStorage 展开键——uiState 的 fileTree.expandedDirs
   *  被 auto-save 恒写空表，不可采） */
  fileTree?: {
    expandedDirs: string[]
  }
  /** agent 会话组结构（P-20261003-68）；缺省 = 该维度不参与恢复 */
  agentGroups?: SnapshotAgentGroup[]
}

/** 会话组结构清洗（P-20261003-68）：快照来自落盘 JSON（手改/旧版本可能带脏形状），
 *  恢复/采集端逐条清洗——id/name 非非空串或 sessionIds 非数组的条目剔除，成员
 *  归一为串表。纯函数导出供恢复端与单测共用 */
export function sanitizeSnapshotGroups(raw: unknown): SnapshotAgentGroup[] {
  if (!Array.isArray(raw)) return []
  const out: SnapshotAgentGroup[] = []
  for (const g of raw) {
    if (!g || typeof g !== 'object') continue
    const { id, name, sessionIds } = g as Partial<SnapshotAgentGroup>
    if (typeof id !== 'string' || !id || typeof name !== 'string' || !Array.isArray(sessionIds)) continue
    out.push({ id, name, sessionIds: sessionIds.filter((s): s is string => typeof s === 'string') })
  }
  return out
}

/** 键级值比较（P-20261002-8 脏键 diff 用）：JSON 语义按值比较、键序无关。
 *  服务端合并后的记录键序与 collect 字面量序不同，stringify 比较会误报
 *  「已变化」打穿零写，故手写递归而非序列化比对。collect 产出与服务端
 *  返回均为纯 JSON 值（无 undefined 循环引用面），递归有界 */
export function uiJsonValueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== typeof b) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((x, i) => uiJsonValueEqual(x, b[i]))
  }
  if (typeof a === 'object') {
    const ao = a as Record<string, unknown>
    const bo = b as Record<string, unknown>
    const aKeys = Object.keys(ao)
    if (aKeys.length !== Object.keys(bo).length) return false
    return aKeys.every(k => k in bo && uiJsonValueEqual(ao[k], bo[k]))
  }
  return false
}

/** 脏键 diff（P-20261002-8）：state 相对 base 逐顶层键比较，返回实际变化的
 *  键集合（无变化返回 null——调用方零写）。只比较 state 自身的键：base 里
 *  collect 不到的命名空间（agentTerminal/remoteConsole…）不进补丁，天然保留 */
export function diffChangedKeys(
  state: Record<string, unknown>,
  base: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  const b = base || {}
  let out: Record<string, unknown> | null = null
  for (const k of Object.keys(state)) {
    if (!uiJsonValueEqual(state[k], b[k])) {
      if (!out) out = {}
      out[k] = state[k]
    }
  }
  return out
}

/** 嵌套子字段基底回填（P-20261006-24）：NESTED_UISTATE_SUBFIELDS 表驱动的
 *  通用守卫——补丁携带注册表内命名空间但缺某子字段、且基底有该子字段时回填，
 *  防「携带父键缺子键 → 服务端整键替换丢子键」（钉选丢失根因模式的通用防线）。
 *  口径与原 fileTree.pinnedDirs 单键特判（P-97）逐位一致：`in` 判定补丁是否
 *  显式携带（显式携带以补丁为准，含显式 undefined）、基底无该子字段不注水、
 *  命名空间脏形状（非对象/数组）与 null 清键（null = 服务端清命名空间语义）
 *  一概不回填。纯函数导出供发送定稿/基底推进两侧与单测共用 */
export function backfillNestedSubfields(
  rec: Record<string, unknown>,
  base: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!base) return rec
  let out: Record<string, unknown> | null = null
  for (const [key, subfields] of Object.entries(NESTED_UISTATE_SUBFIELDS)) {
    const patchNs = rec[key]
    if (!patchNs || typeof patchNs !== 'object' || Array.isArray(patchNs)) continue
    const baseNs = base[key]
    if (!baseNs || typeof baseNs !== 'object' || Array.isArray(baseNs)) continue
    const patch = patchNs as Record<string, unknown>
    const baseRec = baseNs as Record<string, unknown>
    let ns: Record<string, unknown> | null = null
    for (const sf of Object.keys(subfields)) {
      if (sf in patch) continue
      const v = baseRec[sf]
      if (v === undefined) continue
      if (!ns) ns = { ...patch }
      ns[sf] = v
    }
    if (ns) {
      if (!out) out = { ...rec }
      out[key] = ns
    }
  }
  return out || rec
}

export const useUIStateStore = defineStore('uiState', () => {
  const loading = ref(false)
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  // 防抖窗口内待发送的键级补丁：每次 saveCurrentState 以「相对当前基底的完备
  // 变更集」整体替换待发内容——用户改了又改回 = 变更集收缩为空，天然零写
  let pendingPatch: { id: string; rec: Record<string, unknown> } | null = null
  // 即时写（saveXxx 族）失败未达的键（按实例聚合）：服务端没收到不丢用户
  // 动作——后续防抖冲刷与关页 forceSave 把这些键的当前内存值并进补丁重试，
  // 送达后清账。收集键（editor/layout…）的失败由 diff 相对未推进的基底自然
  // 重发覆盖，此处只兜 collect 不到的命名空间（bookmarks/snapshots 等）
  const unsentKeys: Record<string, Set<string>> = {}

  // 最近一次已知的服务端全量状态（内存快照）：脏键 diff 基底。loadState
  //（boot 与各读取器）与每次成功写入（按已发送补丁推进）共同保鲜；即时写
  // 采用乐观推进——写失败留下 unsentKeys 由关页 forceSave 兜底重试
  let lastKnownAll: Record<string, UIStateData> | null = null

  // 加载全部 UI 状态
  async function loadState(): Promise<Record<string, UIStateData>> {
    loading.value = true
    try {
      // 后台恢复 UI 状态：失败仅写 Console，不打扰用户
      const res = await uiStateApi.get({ silent: true })
      const all = res.data || {}
      lastKnownAll = all
      return all
    } catch {
      return {}
    } finally {
      loading.value = false
    }
  }

  // 获取当前实例的 UI 状态
  async function getInstanceState(): Promise<UIStateData | null> {
    const instanceStore = useInstanceStore()
    const id = instanceStore.currentInstanceId
    const all = await loadState()
    return (all[id] as UIStateData) || null
  }

  /** 服务端合并的客户端镜像推进：补丁落定后按同样语义推进内存基底，后续
   *  diff 才能认定这些键「已同步」不再重发（零写的前提是基底保鲜）。推进前
   *  经 backfillNestedSubfields 表驱动回填（P-20261006-24，原 fileTree 单键
   *  特判 P-97 升维）：collect 面不含 fileTree.pinnedDirs，携带 fileTree 但
   *  不带钉选的推进（boot 对齐 alignBaseline / 防抖补丁回填）若照抄裸合并，
   *  会把基底里的钉选剥掉——后续携带 fileTree 的补丁经 finalize 从基底找不到
   *  钉选源即裸发，服务端整键替换丢钉选（e2e file-tree-pinned 重启持久用例
   *  实证：钉选落盘数秒后被下一页 boot 抹掉）。注册表内其他嵌套键同款保护 */
  function mergeKnownAll(id: string, rec: Record<string, unknown>) {
    if (!lastKnownAll) lastKnownAll = {}
    const cur = lastKnownAll[id] as Record<string, unknown> | undefined
    lastKnownAll[id] = { ...(cur || {}), ...backfillNestedSubfields(rec, cur) }
    const sent = unsentKeys[id]
    if (sent) {
      for (const k of Object.keys(rec)) sent.delete(k)
      if (sent.size === 0) delete unsentKeys[id]
    }
  }

  /** 发送前定稿：注册表内嵌套键（NESTED_UISTATE_SUBFIELDS）被携带但缺子字段
   *  时从基底补回——collect 只认得部分子字段（如 fileTree 的 expandedDirs/
   *  selectedFile），命名空间级替换会把专用写端维护的子键（fileTree.pinnedDirs
   *  钉选，P-97 语义）抹掉；写入方显式携带子字段时以它为准。
   *  P-20261006-24：原 fileTree 单键特判升维表驱动，现写端字段面下行为零变化 */
  function finalizeRecord(id: string, rec: Record<string, unknown>): Record<string, unknown> {
    return backfillNestedSubfields(rec, lastKnownAll?.[id] as Record<string, unknown> | undefined)
  }

  /** 补丁 + 兜底键并集组装：diff 变更集之外，把即时写失败未达的键的当前
   *  基底值一并带上（基底已乐观推进 = 最新 UI 真值），送达即清账 */
  function composeRecord(id: string, changed: Record<string, unknown>): Record<string, unknown> {
    const rec = finalizeRecord(id, changed)
    const sent = unsentKeys[id]
    if (!sent) return rec
    const base = (lastKnownAll?.[id] || {}) as Record<string, unknown>
    for (const k of sent) {
      if (!(k in rec) && k in base) rec[k] = base[k]
    }
    return rec
  }

  /** boot 基线对齐（P-20261002-8）：引导恢复落定后把内存基线推进到本页初始
   *  现实——恢复出的初始值不是本页的「变更」。服务端尚无记录时（全新实例/
   *  数据面清空）不对齐的后果：watcher 只盯变化、恢复无变化即无 auto-save，
   *  基线永远停在 boot 的空表，关页 diff 会把整套初始值当变更整包发出，
   *  回滚他页在本页存活期间的修改。只动内存不触发网络写；被对齐的键后续
   *  被真实修改时随补丁自然落库（按键自愈） */
  function alignBaseline(state: UIStateData) {
    const instanceStore = useInstanceStore()
    mergeKnownAll(instanceStore.currentInstanceId, state as Record<string, unknown>)
  }

  // 保存当前实例的状态（P-20261002-8 键级补丁）：相对最近已知服务端状态做
  // 脏键 diff，只发实际变更的顶层键——本页没动过的键绝不外发（多标签页下
  // A 页的 boot 旧值不再整包覆盖 B 页的新值），无变更零请求。
  // 必须键级补丁而非整记录替换：collectCurrentUIState 不含 remoteConsole /
  // agentTerminal 等其他命名空间，整记录替换会把它们静默抹掉（历史教训）
  function saveCurrentState(state: UIStateData) {
    const instanceStore = useInstanceStore()
    const id = instanceStore.currentInstanceId
    const changed = diffChangedKeys(state as Record<string, unknown>, lastKnownAll?.[id] as Record<string, unknown> | undefined)
    if (!changed) {
      // 改了又改回：待发集相对当前基底已不再是变更，作废（否则陈旧中间值
      // 会在防抖到期时照发）
      pendingPatch = null
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
      return
    }
    scheduleSave(id, changed)
  }

  // 防抖 500ms 冲刷键级补丁
  function scheduleSave(id: string, rec: Record<string, unknown>) {
    pendingPatch = { id, rec }
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(async () => {
      saveTimer = null
      const p = pendingPatch
      pendingPatch = null
      if (!p) return
      try {
        const rec = composeRecord(p.id, p.rec)
        await uiStateApi.patch({ [p.id]: rec }, { silent: true })
        mergeKnownAll(p.id, rec)
      } catch { /* silent */ }
    }, 500)
  }

  // beforeunload 时同步保存（键级补丁经 keepalive fetch——sendBeacon 只支持
  // POST，后端不再收 POST）
  function forceSaveCurrentState(state: UIStateData) {
    const instanceStore = useInstanceStore()
    const id = instanceStore.currentInstanceId
    try {
      const changed = diffChangedKeys(state as Record<string, unknown>, lastKnownAll?.[id] as Record<string, unknown> | undefined)
      // 本页零改动：什么都不发——boot 旧值不再整包覆盖，多标签下他页在本页
      // 存活期间的布局修改不被关页动作回滚（P-20261002-8 核心语义）。
      // 在途防抖补丁已被本次完备 diff 覆盖（同一基底），作废防半写
      if (!changed) {
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
        pendingPatch = null
        return
      }
      const rec = composeRecord(id, changed)
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
      pendingPatch = null
      // 卸载同步路径无法确认送达：不推进基底（unload 可能被未保存弹窗取消，
      // 误推进会让后续 diff 漏发）；失败键留在 unsentKeys 由存续会话兜底
      fetch('/api/ui-state', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [id]: rec }),
        keepalive: true,
      })
    } catch { /* silent */ }
  }

  /** 命名空间级即时补丁（saveXxx 低频写端共用）：只发携带的键，服务端浅合并
   *  保留其余命名空间；乐观推进内存基底（防 beforeunload 用陈旧基底把刚写的
   *  值抹回旧值），失败记入 unsentKeys 由关页 forceSave 兜底重试。
   *  发送面与 composeRecord 同口径定稿（P-20261006-24）：现 saveXxx 写端均发
   *  完备命名空间（定稿零变化），将来新写端漏子字段时由注册表兜底——须先
   *  定稿再推进基底，避免回填判定读到已推进的基底 */
  async function patchNamespaces(id: string, rec: Record<string, unknown>) {
    const finalized = finalizeRecord(id, rec)
    mergeKnownAll(id, finalized)
    try {
      await uiStateApi.patch({ [id]: finalized }, { silent: true })
    } catch {
      const sent = (unsentKeys[id] ||= new Set())
      for (const k of Object.keys(finalized)) sent.add(k)
    }
  }

  // ============== remoteConsole 命名空间（远程控制台视图专用） ==============

  /** 读取当前实例的远程控制台持久化状态（tabs + 分组 + 视图可见性 + 侧栏折叠） */
  async function getRemoteConsoleState(): Promise<{
    tabs: { hostId: string; sessionId: string; title: string; tmuxName?: string }[]
    groups: { id: string; name: string; hostIds: string[] }[]
    open: boolean
    sidebarCollapsed: boolean
  }> {
    const state = await getInstanceState()
    return {
      tabs: state?.remoteConsole?.tabs || [],
      groups: state?.remoteConsole?.groups || [],
      open: !!state?.remoteConsole?.open,
      sidebarCollapsed: !!state?.remoteConsole?.sidebarCollapsed,
    }
  }

  /** 保存远程控制台状态（低频操作即时写，键级补丁只动 remoteConsole 字段） */
  async function saveRemoteConsoleState(
    tabs: { hostId: string; sessionId: string; title: string; tmuxName?: string }[],
    groups: { id: string; name: string; hostIds: string[] }[],
    open: boolean,
    sidebarCollapsed: boolean,
  ) {
    const instanceStore = useInstanceStore()
    await patchNamespaces(instanceStore.currentInstanceId, {
      remoteConsole: { tabs, groups, open, sidebarCollapsed },
    })
  }

  // ============== agentTerminal 命名空间（智能体多会话终端：会话分组 + 侧栏折叠） ==============

  /** 读取当前实例的智能体持久化状态（groups 形状防御：脏数据/旧格式回落默认空表，
   *  非数组会让管理页 boot 阶段对 groups 的数组操作直接崩溃） */
  async function getAgentTerminalState(): Promise<{
    groups: { id: string; name: string; sessionIds: string[] }[]
    sidebarCollapsed: boolean
    collapsedProjects: string[]
    projectOrder: string[]
    projectSessionOrder: Record<string, string[]>
    lastViewedSessionId: string
  }> {
    const state = await getInstanceState()
    const groups = state?.agentTerminal?.groups
    const sessionOrder = state?.agentTerminal?.projectSessionOrder
    return {
      groups: Array.isArray(groups) ? groups : [],
      sidebarCollapsed: !!state?.agentTerminal?.sidebarCollapsed,
      collapsedProjects: Array.isArray(state?.agentTerminal?.collapsedProjects)
        ? state!.agentTerminal!.collapsedProjects! : [],
      projectOrder: Array.isArray(state?.agentTerminal?.projectOrder)
        ? state!.agentTerminal!.projectOrder! : [],
      projectSessionOrder: sessionOrder && typeof sessionOrder === 'object' && !Array.isArray(sessionOrder)
        ? sessionOrder : {},
      lastViewedSessionId: typeof state?.agentTerminal?.lastViewedSessionId === 'string'
        ? state!.agentTerminal!.lastViewedSessionId! : '',
    }
  }

  /** 保存智能体状态（低频操作即时写，键级补丁只动 agentTerminal 字段） */
  async function saveAgentTerminalState(state: {
    groups: { id: string; name: string; sessionIds: string[] }[]
    sidebarCollapsed: boolean
    collapsedProjects: string[]
    projectOrder: string[]
    projectSessionOrder: Record<string, string[]>
    lastViewedSessionId?: string
  }) {
    const instanceStore = useInstanceStore()
    // patchNamespaces 内乐观推进内存基底：防 beforeunload 用陈旧基底把刚写的
    // lastViewedSessionId 抹回旧值（原 saveAgentTerminalState 同款保证）
    await patchNamespaces(instanceStore.currentInstanceId, { agentTerminal: state })
  }

  // ============== dshConsole 命名空间（dsh 控制台视图可见性） ==============

  /** 读取当前实例的 dsh 控制台持久化开关 */
  async function getDshConsoleOpen(): Promise<boolean> {
    const state = await getInstanceState()
    return !!state?.dshConsole?.open
  }

  /** 保存 dsh 控制台开关（低频操作即时写；键级补丁只动 dshConsole 字段） */
  async function saveDshConsoleOpen(open: boolean) {
    const instanceStore = useInstanceStore()
    await patchNamespaces(instanceStore.currentInstanceId, { dshConsole: { open } })
  }

  // ============== dashboard 命名空间（项目仪表盘默认落点偏好 P-20261005-224） ==============

  /** 读取「进入项目默认落仪表盘」偏好（缺省 false = 历史行为，进项目落编辑器）。
   *  bootstrap 与设置分区共用同一读取口 */
  async function getDashboardLanding(): Promise<boolean> {
    const state = await getInstanceState()
    return !!state?.dashboard?.landing
  }

  /** 保存默认落点偏好（低频用户动作即时写；键级补丁只动 dashboard 字段） */
  async function saveDashboardLanding(landing: boolean) {
    const instanceStore = useInstanceStore()
    await patchNamespaces(instanceStore.currentInstanceId, { dashboard: { landing } })
  }

  // ============== layoutLock 命名空间（布局锁定 toggle P-20261003-180） ==============

  /** 保存布局锁定开关（低频用户动作即时写；键级补丁只动 layoutLock 字段；
   *  patchNamespaces 乐观推进基底——防 beforeunload 用陈旧基底把刚写的值抹回） */
  async function saveLayoutLocked(locked: boolean) {
    const instanceStore = useInstanceStore()
    await patchNamespaces(instanceStore.currentInstanceId, { layoutLock: { locked } })
  }

  // ============== railOrder 命名空间（活动栏面板手动序 P-20261003-252） ==============

  /** 保存活动栏 rail-top 手动序（拖拽重排低频即时写；键级补丁只动 railOrder
   *  字段；patchNamespaces 乐观推进基底——防 beforeunload 把刚写的序抹回） */
  async function saveRailTopOrder(railTop: string[]) {
    const instanceStore = useInstanceStore()
    await patchNamespaces(instanceStore.currentInstanceId, { railOrder: { railTop } })
  }

  // ============== monitorBoard 命名空间（值班大屏卡片类目布局 P-20261004-18） ==============

  /** 读取值班大屏卡片类目布局（顺序 + 隐藏集）；形状防御同其他命名空间读取
   *  器——非数组/脏条目整键回落空（= 未定制/全显示），已知 id 收敛在
   *  utils/monitorBoardLayout 的 normalize*（宿主恢复链再滤） */
  async function getMonitorBoardLayout(): Promise<{ cardOrder: string[]; hiddenCards: string[] }> {
    const state = await getInstanceState()
    const order = state?.monitorBoard?.cardOrder
    const hidden = state?.monitorBoard?.hiddenCards
    return {
      cardOrder: Array.isArray(order) ? order.filter((x): x is string => typeof x === 'string') : [],
      hiddenCards: Array.isArray(hidden) ? hidden.filter((x): x is string => typeof x === 'string') : [],
    }
  }

  /** 保存值班大屏卡片类目布局（拖拽重排/显隐切换低频即时写；键级补丁只动
   *  monitorBoard 字段；patchNamespaces 乐观推进基底——防 beforeunload 把刚
   *  写的布局抹回旧值）。cardOrder 空数组 = 未定制（读取端 normalize 回落 null） */
  async function saveMonitorBoardLayout(cardOrder: string[], hiddenCards: string[]) {
    const instanceStore = useInstanceStore()
    await patchNamespaces(instanceStore.currentInstanceId, { monitorBoard: { cardOrder, hiddenCards } })
  }

  // ============== notificationCenter 命名空间（未读分界线 P-20261003-259） ==============

  /** 读取上次查看通知中心时点（ms）；缺失/脏值回落 0 = 尚无基线（首次使用/
   *  旧数据面不显示分界线，关闭一次面板后自然生效） */
  async function getNotificationLastSeenAt(): Promise<number> {
    const state = await getInstanceState()
    const raw = state?.notificationCenter?.lastSeenAt
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0
  }

  /** 保存上次查看时点（面板关闭低频即时写；键级补丁只动 notificationCenter
   *  字段；patchNamespaces 乐观推进基底——防 beforeunload 用陈旧基底把刚写的
   *  时点抹回旧值） */
  async function saveNotificationLastSeenAt(lastSeenAt: number) {
    const instanceStore = useInstanceStore()
    await patchNamespaces(instanceStore.currentInstanceId, { notificationCenter: { lastSeenAt } })
  }

  // ============== sync 命名空间（同步中心配置记忆 P-20261023-1） ==============

  /** 读取上次手动同步的配置（方向/对端集/项目集/上下文集）；形状防御同其他
   *  命名空间读取器——脏字段剔除，全脏回落 null = 无「重跑上次」 */
  async function getSyncPrefs(): Promise<{
    direction?: 'pull' | 'push'
    peers?: string[]
    projects?: string[]
    contexts?: string[]
  } | null> {
    const state = await getInstanceState()
    const raw = state?.sync
    if (!raw || typeof raw !== 'object') return null
    const dir = raw.direction === 'pull' || raw.direction === 'push' ? raw.direction : undefined
    const strArr = (v: unknown): string[] | undefined =>
      Array.isArray(v) && v.every(x => typeof x === 'string') ? (v as string[]) : undefined
    const out = {
      direction: dir,
      peers: strArr(raw.peers),
      projects: strArr(raw.projects),
      contexts: strArr(raw.contexts),
    }
    if (!out.direction && !out.peers) return null
    return out
  }

  /** 保存同步配置记忆（手动同步发起时低频即时写；patchNamespaces 乐观推进
   *  基底，同 notificationCenter 纪律） */
  async function saveSyncPrefs(prefs: {
    direction: 'pull' | 'push'
    peers: string[]
    projects: string[]
    contexts: string[]
  }) {
    const instanceStore = useInstanceStore()
    await patchNamespaces(instanceStore.currentInstanceId, { sync: prefs })
  }

  // ============== conflictAgent 命名空间（冲突 agent 派单模板记忆 P-20261008-10） ==============

  /** 读取冲突委派模板记忆；缺省/脏值回落 '' = 无记忆（弹层回 i18n 实时派生
   *  默认模板，语言切换跟随 locale 无「播种语言凝固」，useAgentTaskTemplates
   *  同哲学）。'' 与「未存过」同形是刻意口径：空模板发起（placeholder 明示
   *  「留空 = 只携带路径与上下文」）是临时态而非偏好措辞，不记忆 */
  async function getConflictAgentTemplate(): Promise<string> {
    const state = await getInstanceState()
    const raw = state?.conflictAgent?.template
    return typeof raw === 'string' ? raw : ''
  }

  /** 保存冲突委派模板记忆（弹层发起/恢复默认时低频即时写；patchNamespaces
   *  乐观推进基底，同 notificationCenter 纪律）；'' = 清记忆（恢复默认链用） */
  async function saveConflictAgentTemplate(template: string) {
    const instanceStore = useInstanceStore()
    await patchNamespaces(instanceStore.currentInstanceId, { conflictAgent: { template } })
  }

  // ============== 布局重置（P-20261002-74：一键写回出厂默认） ==============

  /** 一键重置布局：当前实例记录的 layout/fileTree 键级补丁写回出厂默认并即时
   *  落盘（PATCH 键级补丁——编辑器标签/智能体会话等其他命名空间与其它实例
   *  由服务端合并原样保留）。立即写不等防抖——防重置后马上刷新时乱布局从
   *  服务端陈旧快照复活；基底钉选来自内存快照（loadState 与每次成功写保鲜）。
   *  fileTree.pinnedDirs 不随重置清除（P-20261002-97 对齐 P-74 语义）：重置的
   *  范围是「布局自救」（面板/宽高/树展开——展开态是会话性的，收起了随时可再
   *  点开），钉选是用户策展的收藏数据（内容非布局，同编辑器标签被 P-74 显式
   *  保留的边界哲学），误清等于替用户删收藏 */
  async function resetLayoutState(defaults: { layout: UIStateData['layout']; fileTree: UIStateData['fileTree'] }) {
    const instanceStore = useInstanceStore()
    const id = instanceStore.currentInstanceId
    const prevPins = (lastKnownAll?.[id] as UIStateData | undefined)?.fileTree?.pinnedDirs
    const fileTree: UIStateData['fileTree'] = {
      expandedDirs: defaults.fileTree?.expandedDirs || [],
      selectedFile: defaults.fileTree?.selectedFile || '',
      ...(prevPins ? { pinnedDirs: prevPins } : {}),
    }
    await patchNamespaces(id, { layout: defaults.layout, fileTree })
  }

  // ============== fileTree.pinnedDirs 命名空间字段（文件树常用目录钉选） ==============

  /** 读取文件树钉选（projectId -> 有序路径表）；形状防御同 agentTerminal：
   *  脏数据/旧格式回落空表，非数组值整键剔除（防宿主对列表的数组操作崩溃） */
  async function getFileTreePinnedDirs(): Promise<Record<string, string[]>> {
    const state = await getInstanceState()
    const raw = state?.fileTree?.pinnedDirs
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: Record<string, string[]> = {}
    for (const [pid, list] of Object.entries(raw)) {
      if (Array.isArray(list)) out[pid] = list.filter((x): x is string => typeof x === 'string')
    }
    return out
  }

  /** 保存文件树钉选（低频用户动作即时写，键级补丁只动 fileTree 字段）；
   *  expandedDirs/selectedFile 从内存基底补齐（同命名空间整键替换，不能只发
   *  pins）；patchNamespaces 乐观推进基底（防 beforeunload 用陈旧基底把刚写
   *  的钉选抹回旧值） */
  async function saveFileTreePinnedDirs(pinnedDirs: Record<string, string[]>) {
    const instanceStore = useInstanceStore()
    const id = instanceStore.currentInstanceId
    const prevFileTree = (lastKnownAll?.[id] as UIStateData | undefined)?.fileTree
    await patchNamespaces(id, {
      fileTree: {
        expandedDirs: prevFileTree?.expandedDirs || [],
        selectedFile: prevFileTree?.selectedFile || '',
        pinnedDirs,
      },
    })
  }

  // ============== taskRunner 命名空间（任务面板运行历史置顶 + 一键重跑） ==============

  /** 读取运行历史条目列表（新→旧）；形状防御同 agentTerminal——非条目形状
   *  （含旧版 `source::cwd::name` 字符串键）一律丢弃，由后续运行自然重建 */
  async function getTaskRunnerRecent(): Promise<TaskRunEntry[]> {
    const state = await getInstanceState()
    const recent = state?.taskRunner?.recent
    if (!Array.isArray(recent)) return []
    return recent.filter(
      (x): x is TaskRunEntry =>
        !!x &&
        typeof x === 'object' &&
        typeof x.at === 'number' &&
        !!x.task &&
        typeof x.task === 'object' &&
        typeof x.task.source === 'string' &&
        typeof x.task.name === 'string' &&
        typeof x.task.command === 'string' &&
        typeof x.task.cwd === 'string',
    )
  }

  /** 保存运行历史条目列表（低频即时写；键级补丁只动 taskRunner 字段） */
  async function saveTaskRunnerRecent(recent: TaskRunEntry[]) {
    const instanceStore = useInstanceStore()
    await patchNamespaces(instanceStore.currentInstanceId, { taskRunner: { recent } })
  }

  // ============== snapshots 命名空间（工作现场存档点 P-20261002-84） ==============

  /** 读取当前实例的工作现场存档表（projectId → 快照列表，新→旧）；形状防御
   *  同 getFileTreePinnedDirs：脏数据/旧格式整键/整条剔除（防宿主对列表的
   *  数组操作与渲染崩溃） */
  async function getWorkspaceSnapshots(): Promise<Record<string, WorkspaceSnapshot[]>> {
    const state = await getInstanceState()
    const raw = state?.snapshots
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: Record<string, WorkspaceSnapshot[]> = {}
    for (const [pid, list] of Object.entries(raw)) {
      if (!Array.isArray(list)) continue
      out[pid] = list.filter((s): s is WorkspaceSnapshot =>
        !!s && typeof s === 'object'
        && typeof (s as WorkspaceSnapshot).id === 'string'
        && typeof (s as WorkspaceSnapshot).name === 'string'
        && Array.isArray((s as WorkspaceSnapshot).editor?.openFiles))
    }
    return out
  }

  /** 保存工作现场存档表（低频用户动作即时写；键级补丁只动 snapshots 字段） */
  async function saveWorkspaceSnapshots(snapshots: Record<string, WorkspaceSnapshot[]>) {
    const instanceStore = useInstanceStore()
    await patchNamespaces(instanceStore.currentInstanceId, { snapshots })
  }

  // ============== bookmarks 命名空间（编辑器书签锚 P-20261002-131） ==============

  /** 读取当前实例的编辑器书签表（projectId → 文件路径 → 书签记录表）；形状防御同
   *  getWorkspaceSnapshots：脏数据/旧格式整键/整表剔除，条目收编交给
   *  utils/bookmarkAnchor.normalizeBookmarkRecords（旧纯行号 number[] 与新记录
   *  { line, anchor? } 双形态、正整数行号、去重升序、锚归一截断——写入方恒写
   *  合法形状，此处兜手改 JSON 的脏形状与旧格式数据面） */
  async function getEditorBookmarks(): Promise<Record<string, Record<string, BookmarkRecord[]>>> {
    const state = await getInstanceState()
    const raw = state?.bookmarks
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: Record<string, Record<string, BookmarkRecord[]>> = {}
    for (const [pid, files] of Object.entries(raw)) {
      if (!files || typeof files !== 'object' || Array.isArray(files)) continue
      const fileOut: Record<string, BookmarkRecord[]> = {}
      for (const [p, list] of Object.entries(files)) {
        if (!Array.isArray(list)) continue
        const recs = normalizeBookmarkRecords(list as Array<BookmarkRecord | number>)
        if (recs.length > 0) fileOut[p] = recs
      }
      out[pid] = fileOut
    }
    return out
  }

  /** 保存编辑器书签表（toggle 即时写 / 行漂移与重锚防抖写；键级补丁只动 bookmarks
   *  字段） */
  async function saveEditorBookmarks(bookmarks: Record<string, Record<string, BookmarkRecord[]>>) {
    const instanceStore = useInstanceStore()
    await patchNamespaces(instanceStore.currentInstanceId, { bookmarks })
  }

  // ============== diffComments 命名空间（diff 审阅留言 P-20261003-279） ==============

  /** 读取当前实例的 diff 审阅留言表（projectId → 文件路径 → 留言列表）；形状
   *  防御同 getEditorBookmarks：脏数据/旧格式整键/整表剔除，单文件条目级收紧
   *  在 utils/diffComments.normalizeDiffComments（写入方恒写合法形状，此处兜
   *  手改 JSON 的脏形状） */
  async function getDiffComments(): Promise<Record<string, Record<string, DiffComment[]>>> {
    const state = await getInstanceState()
    const raw = state?.diffComments
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: Record<string, Record<string, DiffComment[]>> = {}
    for (const [pid, files] of Object.entries(raw)) {
      if (!files || typeof files !== 'object' || Array.isArray(files)) continue
      const fileOut: Record<string, DiffComment[]> = {}
      for (const [p, list] of Object.entries(files)) {
        const norm = normalizeDiffComments(list)
        if (norm.length > 0) fileOut[p] = norm
      }
      if (Object.keys(fileOut).length > 0) out[pid] = fileOut
    }
    return out
  }

  /** 保存 diff 审阅留言表（增删改/勾选即时写、漂移和解防抖写；键级补丁只动
   *  diffComments 字段） */
  async function saveDiffComments(diffComments: Record<string, Record<string, DiffComment[]>>) {
    const instanceStore = useInstanceStore()
    await patchNamespaces(instanceStore.currentInstanceId, { diffComments })
  }

  // ============== editorPrefs 命名空间（Markdown 模式偏好 P-20261003-18） ==============

  /** 读取 Markdown 模式偏好；形状防御同其他命名空间读取器——非法值回落
   *  undefined（= 无记录，宿主保留 split 默认，不写记录） */
  async function getEditorMdModePreference(): Promise<EditorMdMode | undefined> {
    const state = await getInstanceState()
    const raw = state?.editorPrefs?.mdMode
    return raw === 'source' || raw === 'preview' || raw === 'split' ? raw : undefined
  }

  /** 保存 Markdown 模式偏好（模式切换即时写；键级补丁只动 editorPrefs 字段） */
  async function saveEditorMdModePreference(mdMode: EditorMdMode) {
    const instanceStore = useInstanceStore()
    await patchNamespaces(instanceStore.currentInstanceId, { editorPrefs: { mdMode } })
  }

  // ============== agentTaskTemplates 命名空间（智能体任务模板 P-20261002-16） ==============

  /** 读取用户定制的任务模板表；null = 未定制（消费端回落出厂预置，不落盘）。
   *  形状防御同其他命名空间读取器：脏数据/旧格式整键剔除（防宿主对列表的
   *  数组操作与渲染崩溃），条目字段逐个收字符串 */
  async function getAgentTaskTemplates(): Promise<AgentTaskTemplate[] | null> {
    const state = await getInstanceState()
    const raw = state?.agentTaskTemplates?.items
    if (raw === undefined || raw === null) return null
    if (!Array.isArray(raw)) return null
    const out: AgentTaskTemplate[] = []
    for (const t of raw) {
      if (!t || typeof t !== 'object') continue
      const { id, name, prompt } = t as Partial<AgentTaskTemplate>
      if (typeof id !== 'string' || !id || typeof name !== 'string' || typeof prompt !== 'string') continue
      out.push({ id, name, prompt })
    }
    return out
  }

  /** 保存任务模板表（管理面增删改/排序即时写，浅合并只动 agentTaskTemplates 字段）；
   *  同步内存合并基底（同 saveAgentTerminalState 注释：防 beforeunload 用陈旧
   *  基底把刚写的模板抹回旧值） */
  async function saveAgentTaskTemplates(items: AgentTaskTemplate[]) {
    const instanceStore = useInstanceStore()
    const id = instanceStore.currentInstanceId
    let all: Record<string, UIStateData>
    try {
      const res = await uiStateApi.get({ silent: true })
      all = res.data || {}
    } catch {
      all = {}
    }
    all[id] = { ...(all[id] || {}), agentTaskTemplates: { items } }
    if (lastKnownAll) {
      lastKnownAll[id] = { ...(lastKnownAll[id] || {}), agentTaskTemplates: { items } }
    }
    try {
      await uiStateApi.update(all, { silent: true })
    } catch { /* silent */ }
  }

  return {
    loading,
    loadState,
    getInstanceState,
    saveCurrentState,
    forceSaveCurrentState,
    alignBaseline,
    getRemoteConsoleState,
    saveRemoteConsoleState,
    getAgentTerminalState,
    saveAgentTerminalState,
    getDshConsoleOpen,
    getDashboardLanding,
    saveDashboardLanding,
    saveDshConsoleOpen,
    saveLayoutLocked,
    saveRailTopOrder,
    getMonitorBoardLayout,
    saveMonitorBoardLayout,
    getNotificationLastSeenAt,
    saveNotificationLastSeenAt,
    getSyncPrefs,
    saveSyncPrefs,
    getConflictAgentTemplate,
    saveConflictAgentTemplate,
    resetLayoutState,
    getTaskRunnerRecent,
    saveTaskRunnerRecent,
    getFileTreePinnedDirs,
    saveFileTreePinnedDirs,
    getWorkspaceSnapshots,
    saveWorkspaceSnapshots,
    getEditorBookmarks,
    saveEditorBookmarks,
    getDiffComments,
    saveDiffComments,
    getEditorMdModePreference,
    saveEditorMdModePreference,
    getAgentTaskTemplates,
    saveAgentTaskTemplates,
  }
})
