import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { updateApi, type UpdateStatusPayload } from '../api/client'
import { openVersionPanel } from '../utils/openSettings'
import { useLockStore } from './lock'

/**
 * 自更新进度中心（P-20261109-10）：轮询自版本面板组件上移为全局 store——此前
 * 进度只在面板展开时可见，关面板/切路由/F5 即失明，且面板关闭后重开「立即更新」
 * 误可点（服务端 409 前端静默）。现由本 store 单一跟踪，VersionPanel 与 App 层
 * 全局徽标（UpdateProgressBadge）共同消费：
 *   - 启动探测（init，解锁后）+ 面板挂载同步（sync）：服务端在途即接管轮询——
 *     F5/关面板重开进度恢复，多标签/CLI 发起的更新同样可见；
 *   - 发起（start）：202 受理即跟踪；受理结论未知（超时/断网）或被拒（含跨标签
 *     竞态 409）先探一次实况，在途即接管，网络层失败保守接管，其余如实上抛；
 *   - 推断态：在途轮询失联（旧进程已退、新进程未起）或新进程已起但结果未落盘
 *     （健康检查窗）= reconnecting「安装并重启中」，恢复后回实况；收尾阶段
 *     （replacing/restarting/reconnecting）超 RESTART_GIVE_UP_MS 判结果未知；
 *   - 通知不在此入账：开始/失败/完成/回滚由服务端单一发射（server/update/
 *     notify.go）——前端多标签各跟踪各的，入账会重复。终局 toast 由全局徽标出。
 * 锁定期不打请求（423 只会反复切锁屏），收尾计时顺延（服务端此刻必在线）。
 */

/** 服务端在途四态（与 server/update Status.InFlight 同集合） */
export const IN_FLIGHT_STATUSES: readonly string[] = ['downloading', 'verifying', 'replacing', 'restarting']

export type UpdateOutcomePhase = 'success' | 'failed' | 'rolled_back' | 'unknown'
export type UpdatePhase = 'downloading' | 'verifying' | 'replacing' | 'restarting' | 'reconnecting' | UpdateOutcomePhase

/** 终局（本会话观察到，或服务端快照里的上次失败/回滚） */
export interface UpdateOutcome {
  phase: UpdateOutcomePhase
  version: string
  error: string
  /** 结果文件落盘时刻（RFC3339，服务端时钟）；内存态失败为空 */
  at: string
}

/** update.phase.* 已登记的全态（服务端 9 态 + 前端推断 reconnecting/unknown） */
const PHASE_KEYS = new Set([
  'idle', 'checking', 'downloading', 'verifying', 'replacing', 'restarting',
  'reconnecting', 'success', 'failed', 'rolled_back', 'unknown',
])

/** 状态 → 阶段文案键；未登记的未来状态值回落通用「更新中…」，不直出键名 */
export function phaseLabelKey(status: string | null | undefined): string {
  return status && PHASE_KEYS.has(status) ? `update.phase.${status}` : 'update.updating'
}

export function isInFlightStatus(status: string | undefined): boolean {
  return !!status && IN_FLIGHT_STATUSES.includes(status)
}

/** 轮询间隔：下载进度跟手（服务端 200ms 采样，1.5s 一拉足够平滑且量级可忽略） */
export const POLL_INTERVAL_MS = 1500
/** 收尾阶段放弃判定：换包子进程等旧进程退出 ≤30s + 健康检查 ≤15s + 回滚重拉，
 *  3 分钟仍无结局即判结果未知（下载阶段不设上限——慢链路合法，停滞由服务端
 *  60s 看门狗判失败） */
export const RESTART_GIVE_UP_MS = 3 * 60_000

const OUTCOME_PHASES = new Set<string>(['success', 'failed', 'rolled_back'])

function isLockedError(e: unknown): boolean {
  return (e as { response?: { status?: number } } | null)?.response?.status === 423
}

function isNoResponse(e: unknown): boolean {
  return (e as { category?: string } | null)?.category === 'network'
}

export const useUpdateProgressStore = defineStore('updateProgress', () => {
  const snapshot = ref<UpdateStatusPayload | null>(null)
  /** 轮询环在跑：本页正在跟踪一次更新 */
  const tracking = ref(false)
  /** 推断态：在途轮询失联 / 新进程已起结果未落盘 */
  const reconnecting = ref(false)
  /** 本会话观察到的终局（徽标结局态 + 面板结局块；dismiss/acknowledge 清除） */
  const outcome = ref<UpdateOutcome | null>(null)
  const targetVersion = ref('')

  let timer: ReturnType<typeof setTimeout> | null = null
  // 跟踪代数：settle/reset/重新跟踪即作废在途轮询回调（晚到的响应不得改写新态）
  let generation = 0
  // 进入收尾阶段的时刻（0 = 未在收尾）
  let finishingSince = 0
  let initialized = false

  const inFlight = computed(() => tracking.value && !outcome.value)

  const phase = computed<UpdatePhase | null>(() => {
    if (outcome.value) return outcome.value.phase
    if (!tracking.value) return null
    if (reconnecting.value) return 'reconnecting'
    const s = snapshot.value?.status
    // 受理后首拉之前（快照仍是受理前的空闲态）：受理即进入下载
    return isInFlightStatus(s) ? s as UpdatePhase : 'downloading'
  })

  /** 下载百分比（字节 → %）；下载之后的阶段视为 100 */
  const percent = computed(() => {
    const ph = phase.value
    if (ph === 'downloading') {
      const p = snapshot.value?.progress ?? 0
      const total = snapshot.value?.total ?? 0
      if (p <= 0 || total <= 0) return 0
      return Math.min(100, Math.round((p / total) * 100))
    }
    return ph === 'verifying' || ph === 'replacing' || ph === 'restarting' || ph === 'reconnecting' || ph === 'success'
      ? 100
      : 0
  })

  /** 断点续传起点（P-20261110-1-S4）：本次下载尝试实际从 .part 续传的字节数，
   *  服务端 downloadResumable 单一来源（全量回退归 0、omitempty 省略）。纯透传
   *  不做门控——下载中态「已续传 xxMB」文案由消费方按 >0 自行显隐 */
  const resumedBytes = computed(() => snapshot.value?.resumedBytes ?? 0)

  /** 面板结局块：本会话终局优先；未在跟踪时回落服务端快照里的上次失败/回滚
   *  （内存态失败 = 本进程内下载/校验失败；结果文件失败/回滚 = 换包链结局） */
  const lastOutcome = computed<UpdateOutcome | null>(() => {
    if (outcome.value) return outcome.value
    const s = snapshot.value
    if (!s || tracking.value) return null
    if (s.status === 'failed') return { phase: 'failed', version: s.version, error: s.error || '', at: '' }
    if (s.result === 'failed' || s.result === 'rolled_back') {
      return { phase: s.result, version: s.version, error: s.resultError || '', at: s.resultAt || '' }
    }
    return null
  })

  /** 全局徽标在场：跟踪中或有未关闭的本会话终局 */
  const badgeVisible = computed(() => tracking.value || !!outcome.value)

  function stopTimer() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  function schedule(delay = POLL_INTERVAL_MS) {
    stopTimer()
    const gen = generation
    timer = setTimeout(() => { void tick(gen) }, delay)
  }

  async function fetchSnapshot(): Promise<UpdateStatusPayload | null> {
    const res = await updateApi.status({ silent: true })
    return res?.data ?? null
  }

  function begin(version: string) {
    generation++
    tracking.value = true
    reconnecting.value = false
    outcome.value = null
    finishingSince = 0
    if (version) targetVersion.value = version
    schedule()
  }

  function settle(phaseName: UpdateOutcomePhase, version: string, error: string, at: string) {
    generation++
    stopTimer()
    tracking.value = false
    reconnecting.value = false
    finishingSince = 0
    outcome.value = { phase: phaseName, version: version || targetVersion.value, error, at }
  }

  function markFinishing() {
    if (!finishingSince) finishingSince = Date.now()
  }

  /** 收尾超时即判结果未知并收工；否则排下一拉 */
  function continueFinishing() {
    if (finishingSince && Date.now() - finishingSince > RESTART_GIVE_UP_MS) {
      settle('unknown', targetVersion.value, '', '')
      return
    }
    schedule()
  }

  async function tick(gen: number) {
    timer = null
    if (gen !== generation || !tracking.value) return
    if (useLockStore().isLocked) {
      // 锁定期（含重启后令牌失效触发的回锁）：服务端在线，收尾计时顺延
      if (finishingSince) finishingSince = Date.now()
      schedule()
      return
    }
    let s: UpdateStatusPayload | null = null
    let locked = false
    try {
      s = await fetchSnapshot()
    } catch (e) {
      locked = isLockedError(e)
    }
    if (gen !== generation) return
    if (!s) {
      if (locked) {
        if (finishingSince) finishingSince = Date.now()
        schedule()
        return
      }
      // 失联：旧进程已退、新进程未起（换包重启窗）
      reconnecting.value = true
      markFinishing()
      continueFinishing()
      return
    }
    snapshot.value = s
    if (s.version) targetVersion.value = s.version
    const result = s.result || ''
    if (OUTCOME_PHASES.has(result)) {
      settle(result as UpdateOutcomePhase, s.version, s.resultError || '', s.resultAt || '')
      return
    }
    if (OUTCOME_PHASES.has(s.status)) {
      settle(s.status as UpdateOutcomePhase, s.version, s.error || '', '')
      return
    }
    if (isInFlightStatus(s.status)) {
      reconnecting.value = false
      if (s.status === 'downloading' || s.status === 'verifying') {
        finishingSince = 0
        schedule()
        return
      }
      markFinishing()
      continueFinishing()
      return
    }
    // 空闲且无结果：新进程已起、换包子进程尚未落盘结果（健康检查窗）
    reconnecting.value = true
    markFinishing()
    continueFinishing()
  }

  /** 单次同步：拉实况入快照，服务端在途即接管。启动/解锁/面板挂载/实例切换共用；
   *  跟踪中直接返回（轮询环在跑） */
  async function sync(): Promise<void> {
    if (tracking.value) return
    const gen = generation
    try {
      const s = await fetchSnapshot()
      if (!s || gen !== generation || tracking.value) return
      snapshot.value = s
      if (isInFlightStatus(s.status)) begin(s.version)
    } catch { /* 静默：锁定/离线时由下次同步补上 */ }
  }

  /** 应用启动调用一次（幂等）：解锁后探测一次（锁定期 423 只会切锁屏） */
  function init() {
    if (initialized) return
    initialized = true
    const lock = useLockStore()
    watch(() => lock.isLocked, (locked) => {
      if (!locked) void sync()
    }, { immediate: true })
  }

  /**
   * 发起更新（版本面板「立即更新」）。返回 'started' = 已受理跟踪中；'tracking' =
   * 受理结论未知或已有在途更新、已接管跟踪；抛错 = 服务端明确拒绝（错误对象带
   * 拦截器算好的本地化 userMessage）。opts.silent 透传给 apply 请求：发起方自出
   * 拒绝反馈时用（P-20261109-9 版本面板——拦截器错误 toast 只在项目页外壳注入
   * message API 后才有，首页/设置入口被拒原本零反馈；silent 同时防项目页双弹）
   */
  async function start(expectedVersion = '', opts?: { silent?: boolean }): Promise<'started' | 'tracking'> {
    try {
      const res = await updateApi.apply(opts?.silent ? { silent: true } : undefined)
      snapshot.value = null
      begin(res?.version || expectedVersion)
      return 'started'
    } catch (e) {
      let s: UpdateStatusPayload | null = null
      try { s = await fetchSnapshot() } catch { /* 探测也失败 */ }
      // 探到实况即入快照：受理后瞬间失败（如超时期间下载已失败）时面板结局块
      // 据快照回显原因，不只剩一条请求超时提示
      if (s && !tracking.value) snapshot.value = s
      if (s && isInFlightStatus(s.status)) {
        begin(s.version || expectedVersion)
        return 'tracking'
      }
      if (!s && isNoResponse(e)) {
        // 请求超时/断网且服务端不可探：受理与否未知，保守接管（失联即入推断态，
        // 收尾超时判结果未知）——宁可多看一眼，不留「服务端在换包、前端全盲」窗
        snapshot.value = null
        begin(expectedVersion)
        return 'tracking'
      }
      throw e
    }
  }

  /** 关闭本会话终局（徽标 ×） */
  function dismiss() {
    outcome.value = null
  }

  /**
   * 失败态一键重试（P-20261110-1-S2）：复用 apply 受理端点——与「立即更新」同
   * 一受理链（服务端对 failed 终态自 Reset 后重走受理，updateRetryable 既有语义），
   * 不预清结果文件（受理成功点服务端自清）。先清本会话终局再发起：受理成功即进
   * 跟踪（进度块接棒）；被拒（npm 形态 409 / 伴随预检仍失败 500 等）时终局回落为
   * 本次拒因——重试的反馈不落在旧因上。错误对象如实上抛，调用方可再出提示
   */
  async function retry(opts?: { silent?: boolean }): Promise<'started' | 'tracking'> {
    // 目标版本三取：本会话终局 > 跟踪遗留 > 服务端快照（sync 只入快照不设
    // targetVersion——上次失败经快照回显时快照里的版本号是唯一在场的）
    const version = outcome.value?.version || targetVersion.value || snapshot.value?.version || ''
    outcome.value = null
    try {
      return await start(version, opts)
    } catch (e) {
      // start 内部已探实况：服务端失败态（伴随预检拒绝等）经快照回显新原因；
      // 状态机不承载失败的拒绝（npm 409 等状态机仍空闲）快照回不了失败态，
      // 用拒因兜底终局，结局块就地可见——本组件消费方（结局块/徽标）无 message
      // 注入点，拒因不上墙就丢了
      const err = e as { userMessage?: string; message?: string } | null
      settle('failed', version, err?.userMessage || err?.message || '', '')
      throw e
    }
  }

  /** 面板「知道了」：关闭终局并确认已读（DELETE 清结果文件与失败态；在途 409 静默） */
  async function acknowledge(): Promise<void> {
    outcome.value = null
    try { await updateApi.clearStatus({ silent: true }) } catch { /* 在途/离线：静默 */ }
    try {
      const s = await fetchSnapshot()
      if (s && !tracking.value) snapshot.value = s
    } catch { /* 静默 */ }
  }

  /** 实例切换：作废跟踪与快照，按新实例实况重探（远程实例在途更新同样可见） */
  function resetForInstance() {
    generation++
    stopTimer()
    tracking.value = false
    reconnecting.value = false
    outcome.value = null
    snapshot.value = null
    targetVersion.value = ''
    finishingSince = 0
    void sync()
  }

  function openPanel(): Promise<void> {
    return openVersionPanel()
  }

  return {
    snapshot, tracking, reconnecting, outcome, targetVersion,
    inFlight, phase, percent, resumedBytes, lastOutcome, badgeVisible,
    init, sync, start, retry, dismiss, acknowledge, resetForInstance, openPanel,
  }
})
