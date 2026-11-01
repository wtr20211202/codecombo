import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { runbookApi, type FleetRunResult, type FleetRunTargetCell, type RunbookOnFailure } from '../api/domains/system'
import { remoteHostApi, type RemoteTerminalSessionRef } from '../api/domains/remote'
import { useTerminalSessionsStore } from '../stores/terminal-sessions'
import { OPS_TASK_PROGRESS } from '../utils/opsEvents'
import type { TermTab } from './useTerminalTabs'

/**
 * 舰队运行书面板逻辑层（P-20261005-147）：按序对 N 台会话执行同一本运行书——
 * 广播（useTerminalBroadcast 同族的目标选择）× 运行书步骤 × 完成聚合（矩阵）。
 *
 * - 目标候选三组：本机项目 shell（宿主 tabs）/ 智能体会话 / 远程主机终端
 *   （进面板时聚合拉取一次，与广播条同源同语义）；全部显式勾选无默认，
 *   防向运行中的会话误发车
 * - 发车 = POST /runbooks/:id/fleet-run（同书互斥在服务端）；响应可能因 60s
 *   响应墙断连（长运行）——矩阵是事件驱动合并态：task.progress 批事件
 *   （payload.fleet 扩展：start 建骨架 / step 逐格增量 / final 终态）实时
 *   合并，不依赖响应必达。断连时置 connectionLost（进度仍实时更新，诚实提示）
 * - 中止 = fleet-abort（服务端向未完成目标广播 Ctrl+C，响应即终态矩阵）；
 *   单台重试 = fleet-retry（只重发该格，响应即重算后全矩阵）——两响应都
 *   整体替换矩阵（服务端快照是事实源）
 * - 不持有 i18n/message（jsdom 不可测依赖），文案与提示交宿主组装
 */

/** task.progress 载荷的 fleet 扩展（与 runbookfleet.go publishFleetProgress 同形） */
export interface FleetProgressPayload {
  runId?: string
  bookId?: string
  fleet?: {
    phase?: 'start' | 'step' | 'final'
    stepIndex?: number
    stepTotal?: number
    targetIds?: string[]
    stepNames?: string[]
    results?: FleetRunTargetCell[]
  }
  status?: string
  step?: string
}

/** 面板消费的运行视图：矩阵按 [stepIndex][targetId] 寻址 */
export interface FleetRunView {
  runId: string
  bookId: string
  title: string
  targetIds: string[]
  onFailure: RunbookOnFailure
  /** running | completed | failed | aborted */
  status: string
  stepNames: string[]
  cells: Array<Record<string, FleetRunTargetCell>>
}

export interface UseRunbookFleetParams {
  /** 底部面板 tab（当前项目 shell 会话）——本机组候选 */
  tabs: Ref<TermTab[]>
}

const MAX_STEP_TIMEOUT_MS = 600_000

export function useRunbookFleet(params: UseRunbookFleetParams) {
  const sessionsStore = useTerminalSessionsStore()

  // ── 目标候选与选择（useTerminalBroadcast 同族：三组显式勾选）──
  const selectedIds = ref(new Set<string>())
  const remoteCandidates = ref<RemoteTerminalSessionRef[]>([])

  /** agent 会话候选（统一 store 为事实源；terminals.changed 实时对账） */
  const agentCandidates = computed(() => sessionsStore.systemSessions)

  /** 目标名解析：本地双源（tabs/store）→ 远程别名 → id 短标（不虚构） */
  const targetNames = computed(() => {
    const names = new Map<string, string>()
    for (const t of params.tabs.value) names.set(t.id, t.name)
    for (const s of sessionsStore.sessions) if (!names.has(s.id)) names.set(s.id, s.name)
    for (const r of remoteCandidates.value) if (!names.has(r.id)) names.set(r.id, r.host)
    return names
  })

  function targetName(id: string): string {
    return targetNames.value.get(id) ?? `#${id.slice(0, 8)}`
  }

  function toggleTarget(id: string): void {
    if (selectedIds.value.has(id)) selectedIds.value.delete(id)
    else selectedIds.value.add(id)
    // 触发响应式（Set 原位变异需换新集合，terminal-sessions 同款处理）
    selectedIds.value = new Set(selectedIds.value)
  }

  // 存活对账：被关闭/消失的会话即时出清选中集（tabs / 统一 store / 远程候选）
  watch(
    () => [
      params.tabs.value.map(t => t.id).join(','),
      sessionsStore.sessions.map(s => s.id).join(','),
      remoteCandidates.value.map(r => r.id).join(','),
    ].join('|'),
    () => {
      const alive = new Set<string>(params.tabs.value.map(t => t.id))
      for (const s of sessionsStore.sessions) alive.add(s.id)
      for (const r of remoteCandidates.value) alive.add(r.id)
      let changed = false
      for (const id of [...selectedIds.value]) {
        if (!alive.has(id)) {
          selectedIds.value.delete(id)
          changed = true
        }
      }
      if (changed) selectedIds.value = new Set(selectedIds.value)
    },
  )

  /** 进面板（首次发车前）补拉候选：agent 全量列表 + 远程聚合（广播同款） */
  async function refreshCandidates(): Promise<void> {
    if (!sessionsStore.loaded) void sessionsStore.refresh().catch(() => { /* 静默：保留既有候选 */ })
    try {
      const res = await remoteHostApi.listAllTerminals({ silent: true })
      remoteCandidates.value = (res as unknown as { data?: RemoteTerminalSessionRef[] })?.data ?? []
    } catch {
      remoteCandidates.value = [] // 远程失败降级空候选（组隐藏），不打断本地链
    }
  }

  // ── 运行态（矩阵 = 事件驱动合并态）──
  const run = ref<FleetRunView | null>(null)
  const launching = ref(false)
  const stepText = ref('')
  /** 发车/中止/重试请求网络级失败（无响应——60s 响应墙断连或服务不可达）：
   *  进度事件仍实时更新矩阵，UI 如实提示「连接断开」而非假装一切正常 */
  const connectionLost = ref(false)
  const aborting = ref(false)
  const retryingKey = ref('') // `${stepIndex}:${targetId}` 单格重试在途

  /** 把服务端快照整体落进运行视图（发车/中止/重试响应共用；快照是事实源）。
   *  stepNames 缺省从 steps 推导（说明优先，命令首行兜底——与面板列表一致） */
  function adoptSnapshot(d: FleetRunResult): void {
    run.value = {
      runId: d.runId,
      bookId: d.bookId,
      title: d.title,
      targetIds: [...d.targetIds],
      onFailure: d.onFailure,
      status: d.status,
      stepNames: d.steps.map(s => (s.description?.trim() || s.command.split('\n')[0] || '').slice(0, 80)),
      cells: d.steps.map(step => {
        const byId: Record<string, FleetRunTargetCell> = {}
        for (const c of step.targets) byId[c.id] = c
        return byId
      }),
    }
  }

  /** 发车：先建占位视图（事件先于响应到达时矩阵有落点），响应覆盖为快照 */
  async function launch(input: {
    bookId: string
    title: string
    targetIds: string[]
    params?: Record<string, string>
    onFailure: RunbookOnFailure
    stepTimeoutMs?: number
  }): Promise<boolean> {
    if (launching.value || run.value?.status === 'running') return false
    launching.value = true
    connectionLost.value = false
    run.value = {
      runId: '',
      bookId: input.bookId,
      title: input.title,
      targetIds: [...input.targetIds],
      onFailure: input.onFailure,
      status: 'running',
      stepNames: [],
      cells: [],
    }
    try {
      const res = await runbookApi.fleetRun(input.bookId, {
        targetIds: input.targetIds,
        params: input.params,
        onFailure: input.onFailure,
        stepTimeoutMs: input.stepTimeoutMs,
      })
      if (res.data) adoptSnapshot(res.data)
      return true
    } catch (err) {
      // 网络级失败（响应没回来——长运行断连/服务不可达）：保留占位矩阵，
      // 进度事件继续合并；有响应的 4xx（校验失败）交宿主既有错误链
      if (!isHttpError(err)) connectionLost.value = true
      else run.value = null
      return false
    } finally {
      launching.value = false
    }
  }

  /** 手动中止：服务端向未完成目标广播 Ctrl+C，响应即终态矩阵 */
  async function abort(): Promise<void> {
    const r = run.value
    if (!r || !r.runId || aborting.value) return
    aborting.value = true
    try {
      const res = await runbookApi.fleetAbort(r.bookId, r.runId, { silent: true })
      if (res.data) adoptSnapshot(res.data)
    } finally {
      aborting.value = false
    }
  }

  /** 失败步单台重试：响应即重算后全矩阵（服务端快照整体替换） */
  async function retryCell(bookId: string, stepIndex: number, targetId: string): Promise<void> {
    const r = run.value
    if (!r || !r.runId || r.status === 'running') return
    const key = `${stepIndex}:${targetId}`
    if (retryingKey.value) return
    retryingKey.value = key
    try {
      const res = await runbookApi.fleetRetry(r.bookId, r.runId, stepIndex, targetId, { silent: true })
      if (res.data) adoptSnapshot(res.data)
    } finally {
      retryingKey.value = ''
    }
  }

  function isHttpError(err: unknown): boolean {
    return !!err && typeof err === 'object' && 'response' in (err as Record<string, unknown>)
  }

  // ── task.progress 订阅（sc-ops:task.progress window 事件，useOpsChannel 分发）──

  function onTaskProgress(ev: Event): void {
    const payload = (ev as CustomEvent).detail as FleetProgressPayload
    if (!payload?.fleet || !run.value) return
    const r = run.value
    // 归属对账：响应已回（runId 在手）按 runId 匹配；占位期（响应未回/
    // 已断连）按 bookId 匹配——同书互斥保证同一时刻至多一个在途 run
    const mine = r.runId ? payload.runId === r.runId : payload.bookId === r.bookId
    if (!mine) return
    const f = payload.fleet
    if (f.phase === 'start') {
      if (r.stepNames.length === 0) {
        r.stepNames = [...(f.stepNames ?? [])]
        r.targetIds = [...(f.targetIds ?? r.targetIds)]
        r.cells = r.stepNames.map(() => ({}))
      }
      r.status = 'running'
      if (payload.runId && !r.runId) r.runId = payload.runId
    } else if (f.phase === 'step') {
      const si = f.stepIndex ?? -1
      if (si >= 0 && si < r.cells.length) {
        const row = { ...r.cells[si] }
        for (const c of f.results ?? []) row[c.id] = c
        r.cells[si] = row
      }
      if (payload.runId && !r.runId) r.runId = payload.runId
    } else if (f.phase === 'final') {
      if (payload.runId && !r.runId) r.runId = payload.runId
      r.status = payload.status === 'done' ? 'completed' : (payload.status ?? 'failed')
    }
    if (payload.step) stepText.value = payload.step
  }

  onMounted(() => { window.addEventListener(OPS_TASK_PROGRESS, onTaskProgress as EventListener) })
  onBeforeUnmount(() => { window.removeEventListener(OPS_TASK_PROGRESS, onTaskProgress as EventListener) })

  /** 单步超时档位（提案：缺省 120s 可调）——UI 选择集，上限与服务端钳制一致 */
  const timeoutOptions = [
    { label: '30s', value: 30_000 },
    { label: '60s', value: 60_000 },
    { label: '120s', value: 120_000 },
    { label: '300s', value: 300_000 },
    { label: '600s', value: MAX_STEP_TIMEOUT_MS },
  ]

  /** 清账（面板关书/列表回退时）：运行矩阵是瞬态视图，清掉不留僵尸 */
  function reset(): void {
    run.value = null
    stepText.value = ''
    connectionLost.value = false
  }

  return {
    // 候选与选择
    selectedIds,
    agentCandidates,
    remoteCandidates,
    targetName,
    toggleTarget,
    refreshCandidates,
    // 运行态
    run,
    launching,
    aborting,
    retryingKey,
    stepText,
    connectionLost,
    timeoutOptions,
    launch,
    abort,
    retryCell,
    reset,
  }
}
