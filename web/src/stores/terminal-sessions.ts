import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { terminalApi } from '../api/domains/terminal'
import { OPS_TERMINALS_CHANGED } from '../utils/opsEvents'
import { clearFailedCommandRecord, pruneFailedCommandRecords } from '../composables/terminalCommandMarks'
import { registerReconnectRefetch } from '../composables/reconnectRefetch'
import { useAssistantTaskStore } from './assistantTask'
import type { AxiosRequestConfig } from 'axios'
import type { TerminalsChangedPayload, TerminalSessionInfo } from './terminal-sessions-model'
import { useTerminalSessionPrefs } from './terminal-sessions-prefs'
import { useTerminalUnread } from './terminal-sessions-unread'
import { useTerminalRuntimeState } from './terminal-sessions-osc'
import { useTerminalSessionsWarn, SESSIONS_WARN_THRESHOLD } from './terminal-sessions-warn'
import { mergeSnapshotList } from './terminal-sessions-snapshot'

/**
 * 终端会话统一数据源（P1）：本机所有终端会话（kind=shell 项目会话 +
 * kind=agent 系统会话）的单一事实源，终端会话管理页 / 底部终端面板 /
 * 悬浮窗三宿主共用，互不持有私有会话列表。
 *
 * - 列表来自 GET /terminals（服务端为唯一事实源）；新建/重命名/结束经本 store
 *   的 action 走 API 并同步本地，服务端变更经 ops 通道 `terminals.changed`
 *   快照广播实时对账（后端在 create/close/rename 后广播）
 * - managerAttached：项目会话被管理页接管的独占挂接表——会话同一时刻只在
 *   一个宿主渲染（底部面板 / 管理页二选一），∈ 集合 = 底部面板挂起占位
 * - runningMap：会话粒度运行状态（OSC 133 C/D 事件由持有连接的宿主写入；
 *   未连接的会话不谎报运行态）
 *
 * 域拆分（热点瘦身第三批，纯搬运零逻辑改动）：数据模型收口 terminal-sessions-
 * model，显示偏好/未读点/OSC 运行态/软阈值提示各为就近域工厂（*-prefs/-unread/
 * -osc/-warn），快照已知值合并收口 terminal-sessions-snapshot 纯函数——本文件
 * 持有会话列表、对账编排（applySnapshot/removeLocal）与数据流 actions，公共
 * 面（return 键）与既有消费方完全不变。
 */

export type {
  TerminalSessionInfo,
  TerminalsChangedPayload,
  SessionSortMode,
  SessionGroupMode,
} from './terminal-sessions-model'
export { sessionWorkingDir } from './terminal-sessions-model'
export { SESSIONS_WARN_THRESHOLD }

export const useTerminalSessionsStore = defineStore('terminal-sessions', () => {
  const sessions = ref<TerminalSessionInfo[]>([])
  /** 是否完成过一次服务端列表拉取（空列表 ≠ 未加载） */
  const loaded = ref(false)
  /** 项目会话被管理页接管的会话 id 集合（独占挂接表） */
  const managerAttached = ref(new Set<string>())

  // ── 就近域工厂：显示偏好 / 未读点 / OSC 运行态 / 软阈值提示（状态并入本 store）──
  const prefs = useTerminalSessionPrefs(sessions)
  const unread = useTerminalUnread()
  const osc = useTerminalRuntimeState()
  const warn = useTerminalSessionsWarn()
  const { sortMode, groupMode, pinnedIds, runtimeFilter } = prefs
  const { visibleSlots, unreadMap } = unread
  const { runningMap, activityMap, lastCmdMap } = osc
  const { manyWarned } = warn

  // ============== 用户最近激活的终端会话信标（P-20261004-52） ==============
  // ui.snapshot 现场上报消费：「用户正看哪个终端会话」。底部项目终端
  // （TerminalView activeTabId）与 agent 管理页（AgentTerminalView selectedId）
  // 两宿主在活跃位变化时写入，最后激活者胜；多标签页竞争同 ui.snapshot 语义
  // （隐藏页不上报，可见页胜）。空 = 本标签页尚未激活过任何会话
  const activeId = ref('')
  function setActiveSession(id: string): void {
    if (id && id !== activeId.value) activeId.value = id
  }
  /** 会话消亡随单清空：指向已关闭会话的「现场」是陈旧值（removeLocal/
   *  applySnapshot 两条对账路径同调） */
  function pruneActiveSession(alive: Set<string>): void {
    if (activeId.value && !alive.has(activeId.value)) activeId.value = ''
  }

  // ============== getters ==============
  /** 系统会话（agent，免项目绑定） */
  const systemSessions = computed(() => sessions.value.filter(s => s.kind === 'agent'))
  /** 项目会话（shell 且绑定项目） */
  const projectSessions = computed(() => sessions.value.filter(s => s.kind === 'shell' && s.projectId))
  /** 按当前 sortMode 排序的全体会话（稳定性保证：无 key 时保持服务端返回序） */
  const sortedSessions = computed(() => {
    if (sortMode.value === 'default') return [...sessions.value]
    const sorted = [...sessions.value]
    if (sortMode.value === 'name') {
      sorted.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    } else {
      sorted.sort((a, b) => (activityMap.value[b.id] ?? 0) - (activityMap.value[a.id] ?? 0))
    }
    return sorted
  })
  /** 排序后的系统会话（管理页侧栏/悬浮列表消费） */
  const sortedSystemSessions = computed(() => sortedSessions.value.filter(s => s.kind === 'agent'))
  /** 按项目分组（组序与组内序跟随排序；default = 服务端返回顺序） */
  const sessionsByProject = computed(() => {
    const map = new Map<string, TerminalSessionInfo[]>()
    for (const s of sortedSessions.value) {
      if (s.kind !== 'shell' || !s.projectId) continue
      const list = map.get(s.projectId)
      if (list) list.push(s)
      else map.set(s.projectId, [s])
    }
    return map
  })

  // ============== 内部工具 ==============
  function upsertLocal(info: TerminalSessionInfo) {
    const idx = sessions.value.findIndex(s => s.id === info.id)
    if (idx >= 0) {
      // 保留快照没有的本地已知字段（runtime / runtimeVersion / currentDir）
      const known = sessions.value[idx]!
      sessions.value[idx] = {
        ...info,
        runtime: info.runtime ?? known.runtime,
        runtimeVersion: info.runtimeVersion ?? known.runtimeVersion,
        currentDir: info.currentDir ?? known.currentDir,
      }
    } else {
      sessions.value.push(info)
    }
  }

  function removeLocal(id: string) {
    sessions.value = sessions.value.filter(s => s.id !== id)
    if (managerAttached.value.has(id)) {
      managerAttached.value.delete(id)
      // 触发 Set 的响应式更新
      managerAttached.value = new Set(managerAttached.value)
    }
    unread.forgetSessionUnread(id)
    osc.clearSessionRuntimeState(id)
    const alive = new Set(sessions.value.map(s => s.id))
    pruneActiveSession(alive)
    prefs.prunePinnedIds(alive)
    prefs.pruneRuntimeFilter(prefs.aliveRuntimeKeys())
    // 失败命令记录清账（P-20261006-37）：记录与会话共存亡——「交给 agent 修」
    // 入口的清账点在会话真死（本函数=单会话移除收口，快照全量对账走
    // applySnapshot 的剪枝），pane 卸载不清（重挂恢复语义，
    // 见 terminalCommandMarks.resetCommandMarks 注）
    clearFailedCommandRecord(id)
  }

  /** terminals.changed 快照对账：全量替换（保留 runtime 已知值，合并见
   *  terminal-sessions-snapshot）；顺带清理挂接表与运行态中的孤儿 id（会话已
   *  不存在），并知会 assistantTask 关闭清账（P-20261003-303：会话是进度归属
   *  CC_TERMINAL_ID 的唯一合法来源，快照活着名单之外的 running 归属即死会话
   *  假阳性——广播与 refresh 轮询两路快照都在此收口，值班大屏进度卡随之
   *  消失/全局 running 收敛） */
  function applySnapshot(list: Partial<TerminalSessionInfo>[]) {
    // 越阈观察路径（P-20261003-183）：对账前记录已知会话集——替换后出现的新
    // id 即「有会话被创建」（绕过 store action 的创建路径——底部终端面板
    // useTerminalTabs/TaskRunner 直调 API——与多标签场景的唯一感知通道，服务端
    // 每次创建后都广播全量快照）。首次加载（loaded=false）不算创建：启动时
    // 面对既有的大量会话不提示，提示只跟创建动作走
    const prevIds = new Set(sessions.value.map(s => s.id))
    const wasLoaded = loaded.value
    sessions.value = mergeSnapshotList(list, sessions.value)
    const alive = new Set(sessions.value.map(s => s.id))
    const staleAttach = [...managerAttached.value].filter(id => !alive.has(id))
    if (staleAttach.length > 0) {
      for (const id of staleAttach) managerAttached.value.delete(id)
      managerAttached.value = new Set(managerAttached.value)
    }
    osc.pruneRuntimeState(alive)
    unread.pruneUnreadFor(alive)
    pruneActiveSession(alive)
    prefs.prunePinnedIds(alive)
    prefs.pruneRuntimeFilter(prefs.aliveRuntimeKeys())
    // 失败命令记录剪枝（P-20261006-37）：他端关闭/服务端重启等快照对账路径的
    // 会话真死同清（与 removeLocal 单会话移除同口径，注释见彼处）
    pruneFailedCommandRecords(alive)
    useAssistantTaskStore().pruneClosedSessions([...alive])
    // 越阈对账（P-20261003-183）：落回阈值以内即复位 episode（再次越过会重新
    // 提示）；已有清单基础上冒出新 id = 他方创建（本 tab 直调 API 的创建或别的
    // 标签页创建），超阈时同样轻提示一次——episode 门控保证与创建响应路径
    // （先行到达）不重复弹
    if (sessions.value.length <= SESSIONS_WARN_THRESHOLD) {
      manyWarned.value = false
    } else if (wasLoaded && sessions.value.some(s => !prevIds.has(s.id))) {
      warn.warnIfMany(sessions.value.length)
    }
  }

  // ============== 数据流 ==============
  // 响应解包约定：axios 拦截器已返回 gin body（response.data），业务负载在 res.data
  /** 拉取服务端会话列表（失败保留现状，返回是否成功） */
  async function refresh(): Promise<boolean> {
    try {
      const res = (await terminalApi.list()) as unknown as { data?: Partial<TerminalSessionInfo>[] }
      applySnapshot(res?.data ?? [])
      loaded.value = true
      return true
    } catch {
      return false
    }
  }

  /** 新建系统会话（kind=agent；runtime 空 = 按设置/可用性），失败返回 null。
   *  extra：dir（工作目录，恢复场景传会话 cwd）+ launchArgs（如 --resume <id>）+
   *  shell（会话级 shell 覆盖 P-20261004-57，仅纯终端 runtime=shell 生效，
   *  空缺省 = 跟随设置/平台缺省） */
  async function createAgent(
    name?: string,
    runtime?: string,
    config?: AxiosRequestConfig,
    extra?: { dir?: string; launchArgs?: string; shell?: string },
  ): Promise<TerminalSessionInfo | null> {
    const res = (await terminalApi.createAgent(name, runtime, config, extra)) as unknown as { data?: Record<string, unknown> }
    const data = res?.data
    if (!data?.id) return null
    const info: TerminalSessionInfo = {
      id: String(data.id),
      name: String(data.name || name || ''),
      kind: 'agent',
      projectId: '',
      path: String(data.path || ''),
      createdAt: String(data.createdAt || ''),
      runtime: data.runtime ? String(data.runtime) : undefined,
      runtimeVersion: data.runtimeVersion ? String(data.runtimeVersion) : undefined,
      // 初始指令（P-20261003-146）：创建响应同步携带（快照兜底持久面）——
      // 创建后立刻「重新发起」不吃异步 meta 落库的竞态窗口
      initialPrompt: data.initialPrompt ? String(data.initialPrompt) : undefined,
      // 身份标记（P-20261023-3）：创建响应同步携带（快照兜底持久面同上），
      // 「新/接续」徽标首屏即可判
      derived: data.derived === true,
      resumed: data.resumed === true,
      launched: typeof data.launched === 'boolean' ? data.launched : undefined,
    }
    upsertLocal(info)
    // 越阈轻提示（P-20261003-183）：响应携带的服务端权威总数优先（本地列表
    // 可能未加载/陈旧）；旧服务端无该字段回退本地对账后的列表长度（升级兼容：
    // 功能降级不失效）
    warn.warnIfMany(typeof data.totalSessions === 'number' ? data.totalSessions : sessions.value.length)
    return info
  }

  /** 新建项目会话（kind=shell），失败返回 null */
  async function createProject(projectId: string, name?: string, config?: AxiosRequestConfig): Promise<TerminalSessionInfo | null> {
    const res = (await terminalApi.create(projectId, name, config)) as unknown as { data?: Record<string, unknown> }
    const data = res?.data
    if (!data?.id) return null
    const info: TerminalSessionInfo = {
      id: String(data.id),
      name: String(data.name || name || ''),
      kind: 'shell',
      projectId,
      path: String(data.path || ''),
      createdAt: String(data.createdAt || ''),
    }
    upsertLocal(info)
    // 越阈轻提示（P-20261003-183）：同 createAgent（响应权威总数优先，旧服务端
    // 回退本地列表长度）
    warn.warnIfMany(typeof data.totalSessions === 'number' ? data.totalSessions : sessions.value.length)
    return info
  }

  /** 接管外部 tmux 会话（P-20261005-189）：POST /terminals {attachTmux}——
   *  attach 服务器上用户默认 socket 的既有会话，产物 origin=external。
   *  失败返回 null（拦截器已 toast 服务端原文，如「会话不存在/已被接管」） */
  async function attachExternal(tmuxName: string, name?: string): Promise<TerminalSessionInfo | null> {
    const res = (await terminalApi.attachExternal(tmuxName, name)) as unknown as { data?: Record<string, unknown> }
    const data = res?.data
    if (!data?.id) return null
    const info: TerminalSessionInfo = {
      id: String(data.id),
      name: String(data.name || name || tmuxName),
      kind: 'agent',
      projectId: '',
      path: String(data.path || ''),
      createdAt: String(data.createdAt || ''),
      origin: data.origin ? String(data.origin) : 'external',
    }
    upsertLocal(info)
    // 越阈轻提示（P-20261003-183 同款）：接管会话同样占服务端配额
    warn.warnIfMany(typeof data.totalSessions === 'number' ? data.totalSessions : sessions.value.length)
    return info
  }

  async function rename(id: string, name: string): Promise<void> {
    await terminalApi.rename(id, name)
    const s = sessions.value.find(ss => ss.id === id)
    if (s) s.name = name
  }

  /** 标记审阅基线（P-20261003-217）：当前时点记为该会话的阶段审阅基线，
   *  产出视图可切换 diff 范围到任一标记。失败上抛由调用方/拦截器提示 */
  async function markReviewBaseline(id: string): Promise<void> {
    await terminalApi.markReviewBaseline(id)
  }

  /** 敏感标记（P-20261003-155）：行操作切换落会话元数据（服务端广播快照对账
   *  多端角标）；本地先行回写让本端菜单文案即时翻转（与广播结果同值幂等） */
  async function setSensitive(id: string, sensitive: boolean): Promise<void> {
    await terminalApi.setSensitive(id, sensitive)
    const s = sessions.value.find(ss => ss.id === id)
    if (s) s.sensitive = sensitive
  }

  /** 结束会话（tmux kill / PTY 终止）并本地清理（挂接表/运行态随动） */
  async function destroy(id: string): Promise<void> {
    try { await terminalApi.close(id) } catch { /* 会话可能已不存在 */ }
    removeLocal(id)
  }

  /** 显式终结外部接管会话（P-20261005-189）：kill-session 落在用户默认 socket，
   *  会话内进程随之结束——调用方（UI）负责二次确认，本 action 只执行 */
  async function killExternal(id: string): Promise<void> {
    try { await terminalApi.close(id, true) } catch { /* 会话可能已不存在 */ }
    removeLocal(id)
  }

  /** 底层会话自行消亡（shell 退出）后的本地清理：服务端已不存在，无需调 API */
  function markExited(id: string) {
    removeLocal(id)
  }

  // ============== 独占挂接（项目会话：底部面板 ↔ 管理页） ==============
  /** 项目会话接管到管理页渲染（底部面板转挂起占位） */
  function attachToManager(id: string) {
    if (!managerAttached.value.has(id)) {
      managerAttached.value.add(id)
      managerAttached.value = new Set(managerAttached.value)
    }
  }

  /** 会话归还底部面板 */
  function returnToPanel(id: string) {
    if (managerAttached.value.has(id)) {
      managerAttached.value.delete(id)
      managerAttached.value = new Set(managerAttached.value)
    }
  }

  /** 管理页关闭时全量归还（自动归还语义） */
  function returnAllToPanel() {
    if (managerAttached.value.size > 0) managerAttached.value = new Set()
  }

  // ============== 会话 cwd 实时追踪（P-20261004-59，OSC 7 写路径上报） ==============
  /** OSC 7 帧上报（useTerminalSession 写入段循环调用）：cd 后的下一条 prompt
   *  即刷新。写入频率 = prompt 频率（人工/agent 操作节奏），逐次直写无节流
   *  必要；同值重写可接受（Pinia 同引用赋值不触发依赖更新——cd 未变时零抖动） */
  function reportCurrentDir(id: string, dir: string) {
    const s = sessions.value.find(ss => ss.id === id)
    if (s) s.currentDir = dir
  }

  // ops 通道实时对账（App 层 OpsChannelBridge 已建立常驻连接；
  // useOpsChannel 对未知 type 按 sc-ops:<type> 二次分发，此处直接订阅）
  if (typeof window !== 'undefined') {
    window.addEventListener(OPS_TERMINALS_CHANGED, (e) => {
      const payload = (e as CustomEvent<TerminalsChangedPayload>).detail
      if (payload?.sessions) applySnapshot(payload.sessions)
    })
  }

  /** 仅供测试使用：清空全部状态（含挂接表/运行态/活动时间戳/未读点/可见登记；
   *  排序方式/分组视图/置顶集一并复位保证用例隔离，不写 localStorage） */
  function resetForTest() {
    sessions.value = []
    loaded.value = false
    managerAttached.value = new Set()
    activeId.value = ''
    osc.resetRuntimeStateForTest()
    unread.resetUnreadForTest()
    prefs.resetPrefsForTest()
    warn.resetWarnForTest()
  }

  return {
    sessions,
    loaded,
    managerAttached,
    runningMap,
    activityMap,
    lastCmdMap,
    visibleSlots,
    unreadMap,
    activeId,
    setActiveSession,
    setHostVisible: unread.setHostVisible,
    markUnread: unread.markUnread,
    clearUnread: unread.clearUnread,
    sortMode,
    groupMode,
    pinnedIds,
    runtimeFilter,
    isPinned: prefs.isPinned,
    togglePin: prefs.togglePin,
    toggleRuntimeFilter: prefs.toggleRuntimeFilter,
    clearRuntimeFilter: prefs.clearRuntimeFilter,
    systemSessions,
    sortedSessions,
    sortedSystemSessions,
    sessionsByProject,
    projectSessions,
    refresh,
    createAgent,
    createProject,
    attachExternal,
    rename,
    markReviewBaseline,
    setSensitive,
    destroy,
    killExternal,
    markExited,
    applySnapshot,
    attachToManager,
    returnToPanel,
    returnAllToPanel,
    reportOsc: osc.reportOsc,
    reportCurrentDir,
    setSortMode: prefs.setSortMode,
    setGroupMode: prefs.setGroupMode,
    resetForTest,
  }
})

// 重连补拉注册（P-20261003-236）：断线窗口期的 terminals.changed 快照广播
// 不可回放，任一通道重连后经集中注册表重拉会话列表对账（tab/pane 的 socket
// 重连仍归 TerminalPane/useTerminalReconnect UI 链，不在本域）
registerReconnectRefetch('terminals', () => { void useTerminalSessionsStore().refresh() })
