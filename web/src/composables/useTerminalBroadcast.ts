import { computed, ref, watch, type Ref } from 'vue'
import { terminalApi } from '../api/domains/terminal'
import { remoteHostApi, type RemoteTerminalSessionRef } from '../api/domains/remote'
import type { TermTab } from './useTerminalTabs'
import { useTerminalSessionsStore } from '../stores/terminal-sessions'

/**
 * 终端广播（P-20261003-288 舰队式批量输入）：tab 栏多选模式的纯逻辑层。
 *
 * - 广播开关进入多选态：tab 点击语义由宿主切换为「选中/取消」（本 composable
 *   只持有选中集与发送链），选中 ≥2 才可发送（宿主据 targetIds 渲染广播条）
 * - 默认目标 = tab 栏点选的 shell 会话；agent 会话（宿主在 agent 管理页，
 *   不在项目 tab 栏）需在广播条内显式勾选——防向运行中的 agent 插话
 * - 远程主机终端（P-20261005-11）：候选经 GET /remotehosts/terminals 聚合
 *   拉取（进广播模式时一次），与本地 shell/agent 并列的第三组显式勾选目标——
 *   远程输入通道是服务端中继，广播与单会话输入同一条 SSH stdin 通道
 * - 发送 = POST /terminals/broadcast-write 一次打全部目标（本地/远程混合 id），
 *   尾部换行自动补（\r = PTY Enter，与 agent launch 注入 / 运行书执行同一惯例）
 * - 发送 = POST /terminals/broadcast-write 一次打全部目标，尾部换行自动补
 *   （\r = PTY Enter，与 agent launch 注入 / 运行书执行同一惯例）
 * - 发送成功回告落 lastResult（P-20261005-12 聚合视图）：resultTargets 把
 *   回告 id 翻译成「名称 + 失败态」目标视图，showResultPanel 驱动瞬态结果
 *   面板（TerminalBroadcastResultPanel）自动展开一次可关
 * - 输入历史（P-20261005-13）：发送成功入史（去重置顶 + 环形封顶），↑/↓
 *   回填与聚焦下拉在宿主组件（TerminalBroadcastBar）；与 Ctrl+Alt+V 剪贴板
 *   历史正交（那走 stores/clipboardHistory 全局弹层，语义互不掺和）
 * - 不持有 i18n/message（jsdom 不可测依赖），文案与提示交宿主组装
 */

/** 输入历史环形上限（P-20261005-13）：巡检命令组单日量级，20 条足量且内存有界 */
export const BROADCAST_INPUT_HISTORY_MAX = 20
export interface BroadcastSendOutcome {
  written: number
  /** 不存在的会话 id 数（服务端跳过回告） */
  missing: number
  /** 存在但写入失败的 id 数（已关闭/未附着/远程断连） */
  failed: number
  /** failed 中远程目标的主机别名（P-20261005-11，「哪台失败一目了然」） */
  failedHostNames: string[]
}

/** 聚合面板的单目标视图：state 来自发送回告（written/missing/failed 透传） */
export interface BroadcastResultTarget {
  id: string
  /** 会话名（tabs/store 双源解析；已消失的会话回退裸 id 前缀，不虚构名字） */
  name: string
  /** ok=已写入（拉尾输出）；missing=已不存在 / failed=写入失败（灰态不拉取） */
  state: 'ok' | 'missing' | 'failed'
}

/** 最近一次广播的完整回告（P-20261005-12 聚合面板数据源）——瞬态内存态，
 *  不持久化：结果面板是「每次广播的瞬态结果」，跨刷新无意义 */
export interface BroadcastLastResult {
  targetIds: string[]
  written: number
  missing: string[]
  failed: string[]
}

export interface UseTerminalBroadcastParams {
  /** 底部面板 tab（当前项目 shell 会话）——选中集存活对账的数据源之一 */
  tabs: Ref<TermTab[]>
}

export function useTerminalBroadcast(params: UseTerminalBroadcastParams) {
  const sessionsStore = useTerminalSessionsStore()

  /** 广播选择模式：开 = tab 点击切选中语义 + 广播条出现 */
  const broadcastMode = ref(false)
  /** tab 栏点选的 shell 会话 id 集 */
  const selectedTabIds = ref(new Set<string>())
  /** 显式勾选的 agent 会话 id 集（默认不参与广播） */
  const selectedAgentIds = ref(new Set<string>())
  /** 显式勾选的远程主机终端 id 集（默认不参与——跨主机批量写同属高危写） */
  const selectedRemoteIds = ref(new Set<string>())

  /** agent 会话候选（终端会话统一 store 为事实源；terminals.changed 实时对账） */
  const agentCandidates = computed(() => sessionsStore.systemSessions)

  /** 最近一次广播的完整回告（null=本页尚未广播过）——聚合面板数据源 */
  const lastResult = ref<BroadcastLastResult | null>(null)
  /** 聚合结果面板显隐：发送成功自动展开一次，可关；「查看结果」入口重开 */
  const showResultPanel = ref(false)

  /**
   * 广播输入历史（P-20261005-13）：会话内内存态（随页面存活，不落
   * localStorage——巡检命令组是当日重复形态，跨天价值低），去重置顶 +
   * 环形封顶记账同 useCloneUrlHistory 惯例（差异 = 无持久层）
   */
  const inputHistory = ref<string[]>([])

  /** 发送成功入史：trim 空串跳过；已存在先摘除再置顶（去重置顶）；环形裁剪 */
  function recordInput(raw: string): void {
    const text = raw.trim()
    if (!text) return
    const idx = inputHistory.value.indexOf(text)
    if (idx !== -1) inputHistory.value.splice(idx, 1)
    inputHistory.value.unshift(text)
    if (inputHistory.value.length > BROADCAST_INPUT_HISTORY_MAX) {
      inputHistory.value.length = BROADCAST_INPUT_HISTORY_MAX
    }
  }

  /** 面板目标视图：回告 id 集合 → 名称解析 + 失败态标注。
   *  名称解析双源：项目 tab（shell）/ 统一 store（agent）；已消失会话
   *  （missing）两源都查不到，回退 id 前 8 位短标——不虚构会话名 */
  const resultTargets = computed<BroadcastResultTarget[]>(() => {
    const lr = lastResult.value
    if (!lr) return []
    const missing = new Set(lr.missing)
    const failed = new Set(lr.failed)
    const names = new Map<string, string>()
    for (const t of params.tabs.value) names.set(t.id, t.name)
    for (const s of sessionsStore.sessions) if (!names.has(s.id)) names.set(s.id, s.name)
    return lr.targetIds.map(id => ({
      id,
      name: names.get(id) ?? `#${id.slice(0, 8)}`,
      state: missing.has(id) ? 'missing' as const : failed.has(id) ? 'failed' as const : 'ok' as const,
    }))
  })

  // 进入广播模式时补拉一次会话列表：agent 候选来自服务端全量列表——底部
  // 终端页平时只消费项目 tab，store 可能尚未 loaded

  /** 远程终端会话候选（进广播模式时聚合拉取；服务端会话上限 20 量级） */
  const remoteCandidates = ref<RemoteTerminalSessionRef[]>([])

  // 进入广播模式时补拉一次候选：agent 候选来自服务端全量列表（终端会话 store
  // 平时只消费项目 tab 可能未 loaded）；远程候选无 ops 快照通道，同刻拉一次。
  // 两路独立拉取互不阻塞——远程列表失败降级为空候选（分组隐藏），不打断本地链
  watch(broadcastMode, (on) => {
    if (!on) return
    if (!sessionsStore.loaded) void sessionsStore.refresh()
    void remoteHostApi.listAllTerminals({ silent: true }).then((res) => {
      remoteCandidates.value = (res as unknown as { data?: RemoteTerminalSessionRef[] })?.data ?? []
      // 候选刷新即对账：已勾选但已消亡的远程会话出清（GC/断连回收）
      const alive = new Set(remoteCandidates.value.map(s => s.id))
      for (const id of selectedRemoteIds.value) {
        if (!alive.has(id)) selectedRemoteIds.value.delete(id)
      }
    }).catch(() => { remoteCandidates.value = [] })
  })

  // 存活对账：被关闭的会话即时出清选中集（tab 关闭 / terminals.changed 移除）。
  // 监听 id 签名而非 deep——只在会话集合真正变化时遍历（TerminalView 同范式）
  watch(
    () => [params.tabs.value.map(t => t.id).join(','), sessionsStore.sessions.map(s => s.id).join(',')],
    () => {
      const alive = new Set<string>(params.tabs.value.map(t => t.id))
      for (const s of sessionsStore.sessions) alive.add(s.id)
      pruneSet(selectedTabIds.value, alive)
      pruneSet(selectedAgentIds.value, alive)
    },
  )

  /** tab 点击（广播模式下）：切换选中态 */
  function toggleTab(id: string): void {
    toggleInSet(selectedTabIds.value, id)
  }

  /** agent 会话勾选（广播条内显式勾选，默认不参与） */
  function toggleAgent(id: string): void {
    toggleInSet(selectedAgentIds.value, id)
  }

  /** 远程主机终端勾选（广播条「远程主机」分组内显式勾选，默认不参与） */
  function toggleRemote(id: string): void {
    toggleInSet(selectedRemoteIds.value, id)
  }

  /** 广播目标全集（tab 点选 + 显式勾选的 agent 会话 + 远程主机终端） */
  const targetIds = computed(() => [...selectedTabIds.value, ...selectedAgentIds.value, ...selectedRemoteIds.value])

  /** 退出广播模式并清空选择（工具条开关与广播条关闭钮共用出口） */
  function exitBroadcastMode(): void {
    broadcastMode.value = false
    selectedTabIds.value = new Set()
    selectedAgentIds.value = new Set()
    selectedRemoteIds.value = new Set()
  }

  /**
   * 广播发送：尾部无换行自动补 \r（执行语义，提案注记「UI 回车自动补」）；
   * 网络/校验错误向上抛，交宿主按既有错误提示链呈现。
   * failedHosts 为服务端增量回告（P-20261005-11）：旧服务端缺字段降级空数组
   * （升级兼容——文案组装侧对空数组零变化）
   */
  async function send(text: string): Promise<BroadcastSendOutcome> {
    const body = text.length > 0 && !/[\r\n]$/.test(text) ? text + '\r' : text
    const ids = [...targetIds.value]
    const res = await terminalApi.broadcastWrite(ids, body)
    const d = res.data
    // 成功回告落聚合面板数据源并自动展开一次（P-20261005-12①）：面板自延时
    // 1.5s 再拉尾输出，给广播命令留执行时间；失败（网络/校验）不落面板——
    // 上抛交宿主既有错误提示链，无结果可看
    lastResult.value = { targetIds: ids, written: d.written, missing: [...d.missing], failed: [...d.failed] }
    showResultPanel.value = true
    // 入史（P-20261005-13）只挂在成功链：失败时输入框原文保留待重试，成功清空
    // （组件侧）与入史（本处）同门槛，两处状态不会错位
    recordInput(text)
    return {
      written: d.written,
      missing: d.missing.length,
      failed: d.failed.length,
      failedHostNames: (d.failedHosts ?? []).map(f => f.host),
    }
  }

  return {
    broadcastMode,
    selectedTabIds,
    selectedAgentIds,
    selectedRemoteIds,
    agentCandidates,
    remoteCandidates,
    targetIds,
    lastResult,
    showResultPanel,
    resultTargets,
    inputHistory,
    toggleTab,
    toggleAgent,
    toggleRemote,
    exitBroadcastMode,
    send,
  }
}

function toggleInSet(set: Set<string>, id: string): void {
  if (set.has(id)) set.delete(id)
  else set.add(id)
}

function pruneSet(set: Set<string>, alive: Set<string>): void {
  for (const id of set) {
    if (!alive.has(id)) set.delete(id)
  }
}
