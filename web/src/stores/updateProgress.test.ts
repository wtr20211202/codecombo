import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { reactive, nextTick } from 'vue'

// 自更新进度中心（P-20261109-10）store 测试：受理即跟踪、阶段推进与百分比、
// 换包重启窗推断态、终局收口、受理结论未知/409 探测接管、收尾放弃判定、
// 锁定期不打请求、启动探测接管、上次失败回显与确认已读、实例切换重探。

const api = vi.hoisted(() => ({
  apply: vi.fn(),
  status: vi.fn(),
  clearStatus: vi.fn(),
}))
vi.mock('../api/client', () => ({ updateApi: api }))

const lockState = vi.hoisted(() => ({ value: null as null | { isLocked: boolean } }))
vi.mock('./lock', () => ({ useLockStore: () => lockState.value }))

const openVersionPanel = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('../utils/openSettings', () => ({ openVersionPanel }))

import {
  useUpdateProgressStore, phaseLabelKey, POLL_INTERVAL_MS, RESTART_GIVE_UP_MS,
} from './updateProgress'
import zhCN from '../locales/zh-CN'
import enUS from '../locales/en-US'

function status(s: Partial<{ status: string; progress: number; total: number; version: string; error: string; result: string; resultError: string; resultAt: string; resumedBytes: number }>) {
  return { data: { status: 'idle', progress: 0, total: 0, version: '', ...s } }
}

const networkError = Object.assign(new Error('Network Error'), { category: 'network', status: 0 })

async function poll() {
  await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
}

beforeEach(() => {
  vi.useFakeTimers()
  setActivePinia(createPinia())
  lockState.value = reactive({ isLocked: false })
  api.apply.mockReset()
  api.status.mockReset()
  api.clearStatus.mockReset()
  openVersionPanel.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('phaseLabelKey', () => {
  it('已登记全态走 update.phase.*，未知/空回落通用文案不直出键名', () => {
    for (const s of ['idle', 'checking', 'downloading', 'verifying', 'replacing', 'restarting', 'reconnecting', 'success', 'failed', 'rolled_back', 'unknown']) {
      expect(phaseLabelKey(s)).toBe(`update.phase.${s}`)
    }
    expect(phaseLabelKey('future_state')).toBe('update.updating')
    expect(phaseLabelKey(null)).toBe('update.updating')
  })

  it('状态机全态文案 zh/en 双语齐（此前 downloading/verifying 等态直出键名原文）', () => {
    const phases = ['idle', 'checking', 'downloading', 'verifying', 'replacing', 'restarting', 'reconnecting', 'success', 'failed', 'rolled_back', 'unknown']
    for (const locale of [zhCN, enUS] as unknown[]) {
      const table = (locale as { update?: { phase?: Record<string, unknown> } }).update?.phase ?? {}
      for (const s of phases) {
        const v = table[s]
        expect(typeof v === 'string' && v.length > 0, `update.phase.${s}`).toBe(true)
      }
    }
  })
})

describe('updateProgress store', () => {
  it('受理即跟踪：下载百分比 → 校验 → 失联推断 → 结果未落盘推断 → 成功收口', async () => {
    api.apply.mockResolvedValue({ message: 'update started', version: '9.9.9' })
    const store = useUpdateProgressStore()
    expect(await store.start('9.9.9')).toBe('started')
    expect(store.tracking).toBe(true)
    expect(store.phase).toBe('downloading')
    expect(store.badgeVisible).toBe(true)

    api.status.mockResolvedValueOnce(status({ status: 'downloading', progress: 50, total: 200, version: '9.9.9' }))
    await poll()
    expect(store.phase).toBe('downloading')
    expect(store.percent).toBe(25)

    api.status.mockResolvedValueOnce(status({ status: 'verifying', progress: 200, total: 200, version: '9.9.9' }))
    await poll()
    expect(store.phase).toBe('verifying')
    expect(store.percent).toBe(100)

    // 旧进程退出：轮询失联 → 推断「安装并重启中」
    api.status.mockRejectedValueOnce(networkError)
    await poll()
    expect(store.phase).toBe('reconnecting')
    expect(store.inFlight).toBe(true)

    // 新进程已起、结果文件未落盘（健康检查窗）：仍推断态
    api.status.mockResolvedValueOnce(status({ status: 'idle' }))
    await poll()
    expect(store.phase).toBe('reconnecting')

    api.status.mockResolvedValueOnce(status({ status: 'idle', result: 'success', version: '9.9.9', resultAt: '2026-11-09T00:00:00Z' }))
    await poll()
    expect(store.tracking).toBe(false)
    expect(store.outcome).toEqual({ phase: 'success', version: '9.9.9', error: '', at: '2026-11-09T00:00:00Z' })
    expect(store.phase).toBe('success')
    expect(store.badgeVisible).toBe(true)

    // 收口后不再轮询
    const calls = api.status.mock.calls.length
    await poll()
    expect(api.status.mock.calls.length).toBe(calls)

    store.dismiss()
    expect(store.badgeVisible).toBe(false)
  })

  it('本进程内失败（下载/校验）：内存态 failed + 原因收口，面板结局回显', async () => {
    api.apply.mockResolvedValue({ version: '9.9.9' })
    const store = useUpdateProgressStore()
    await store.start()
    api.status.mockResolvedValueOnce(status({ status: 'failed', version: '9.9.9', error: 'download failed: stalled' }))
    await poll()
    expect(store.outcome).toMatchObject({ phase: 'failed', version: '9.9.9', error: 'download failed: stalled' })
    expect(store.lastOutcome).toEqual(store.outcome)
  })

  it('受理被拒但服务端在途（跨标签竞态 409）：探测后接管跟踪', async () => {
    api.apply.mockRejectedValue(Object.assign(new Error('update already in progress: downloading'), { status: 409, category: 'conflict' }))
    api.status.mockResolvedValueOnce(status({ status: 'downloading', progress: 10, total: 100, version: '9.9.9' }))
    const store = useUpdateProgressStore()
    expect(await store.start()).toBe('tracking')
    expect(store.tracking).toBe(true)
    expect(store.targetVersion).toBe('9.9.9')
    expect(store.percent).toBe(10)
  })

  it('明确拒绝（已是最新 400）且服务端空闲：如实上抛，不跟踪', async () => {
    const err = Object.assign(new Error('already up to date'), { status: 400, category: 'validation' })
    api.apply.mockRejectedValue(err)
    api.status.mockResolvedValueOnce(status({ status: 'idle' }))
    const store = useUpdateProgressStore()
    await expect(store.start()).rejects.toBe(err)
    expect(store.tracking).toBe(false)
  })

  it('opts.silent 透传 apply（发起方自出拒绝反馈，P-20261109-9）；缺省不带 config', async () => {
    api.apply.mockResolvedValue({ version: '9.9.9' })
    const store = useUpdateProgressStore()
    await store.start('9.9.9', { silent: true })
    expect(api.apply).toHaveBeenLastCalledWith({ silent: true })
    await store.start('9.9.9')
    expect(api.apply).toHaveBeenLastCalledWith(undefined)
  })

  it('受理前伴随预检拒绝（P-20261109-9）：如实上抛不跟踪，服务端失败态入快照供面板「上次更新」回显原因', async () => {
    const reason = 'update verification failed: companion asset fetch failed: checksum: status 503 (after 3 attempts); retry or set CC_UPDATE_ALLOW_UNVERIFIED=1 to override'
    const err = Object.assign(new Error(reason), { status: 500, category: 'server', userMessage: '更新已拒绝' })
    api.apply.mockRejectedValue(err)
    api.status.mockResolvedValueOnce(status({ status: 'failed', version: '9.9.9', error: reason }))
    const store = useUpdateProgressStore()
    await expect(store.start('9.9.9', { silent: true })).rejects.toBe(err)
    expect(store.tracking).toBe(false)
    expect(store.badgeVisible).toBe(false)
    expect(store.lastOutcome).toMatchObject({ phase: 'failed', version: '9.9.9', error: reason })
  })

  it('请求超时期间受理后已失败：不跟踪但快照入账，面板结局回显原因', async () => {
    api.apply.mockRejectedValue(Object.assign(new Error('timeout of 30000ms exceeded'), { category: 'network', status: 0 }))
    api.status.mockResolvedValueOnce(status({ status: 'failed', version: '9.9.9', error: 'download failed: stalled' }))
    const store = useUpdateProgressStore()
    await expect(store.start()).rejects.toBeTruthy()
    expect(store.tracking).toBe(false)
    expect(store.lastOutcome).toMatchObject({ phase: 'failed', error: 'download failed: stalled' })
  })

  it('受理结论未知（超时/断网）且探测也失败：保守接管，失联即推断态', async () => {
    api.apply.mockRejectedValue(networkError)
    api.status.mockRejectedValue(networkError)
    const store = useUpdateProgressStore()
    expect(await store.start('9.9.9')).toBe('tracking')
    await poll()
    expect(store.phase).toBe('reconnecting')
    expect(store.targetVersion).toBe('9.9.9')
  })

  it('收尾阶段超时无结局：判结果未知并收工（下载阶段不设上限）', async () => {
    api.apply.mockResolvedValue({ version: '9.9.9' })
    api.status.mockResolvedValue(status({ status: 'restarting', version: '9.9.9' }))
    const store = useUpdateProgressStore()
    await store.start()
    await poll()
    expect(store.phase).toBe('restarting')
    await vi.advanceTimersByTimeAsync(RESTART_GIVE_UP_MS + 2 * POLL_INTERVAL_MS)
    expect(store.outcome?.phase).toBe('unknown')
    expect(store.tracking).toBe(false)
  })

  it('下载阶段长时间进行不触发放弃判定', async () => {
    api.apply.mockResolvedValue({ version: '9.9.9' })
    api.status.mockResolvedValue(status({ status: 'downloading', progress: 1, total: 100, version: '9.9.9' }))
    const store = useUpdateProgressStore()
    await store.start()
    await vi.advanceTimersByTimeAsync(RESTART_GIVE_UP_MS * 2)
    expect(store.outcome).toBeNull()
    expect(store.phase).toBe('downloading')
  })

  it('锁定期不打状态请求（423 只会反复切锁屏），解锁后继续', async () => {
    api.apply.mockResolvedValue({ version: '9.9.9' })
    api.status.mockResolvedValue(status({ status: 'downloading', progress: 5, total: 10, version: '9.9.9' }))
    const store = useUpdateProgressStore()
    await store.start()
    lockState.value!.isLocked = true
    await poll()
    await poll()
    expect(api.status).not.toHaveBeenCalled()
    lockState.value!.isLocked = false
    await poll()
    expect(api.status).toHaveBeenCalledTimes(1)
    expect(store.percent).toBe(50)
  })

  it('resumedBytes 纯透传（P-20261110-1-S4）：快照带值即透出，服务端省略（全量回退）回落 0', async () => {
    api.apply.mockResolvedValue({ version: '9.9.9' })
    const store = useUpdateProgressStore()
    await store.start()
    // 续传会话：服务端 downloadResumable 的实际续传偏移原样透出，百分比不随之失真
    api.status.mockResolvedValueOnce(status({ status: 'downloading', progress: 80, total: 100, version: '9.9.9', resumedBytes: 40 * 1024 * 1024 }))
    await poll()
    expect(store.resumedBytes).toBe(40 * 1024 * 1024)
    expect(store.percent).toBe(80)
    // 全量回退（omitempty 省略字段）：0 =「已续传」标记不显
    api.status.mockResolvedValueOnce(status({ status: 'downloading', progress: 10, total: 100 }))
    await poll()
    expect(store.resumedBytes).toBe(0)
  })

  it('init：解锁后探测一次，服务端在途即接管（F5/他页/CLI 发起）；幂等', async () => {
    lockState.value!.isLocked = true
    api.status.mockResolvedValue(status({ status: 'downloading', progress: 30, total: 100, version: '9.9.9' }))
    const store = useUpdateProgressStore()
    store.init()
    store.init()
    await vi.advanceTimersByTimeAsync(0)
    expect(api.status).not.toHaveBeenCalled()
    lockState.value!.isLocked = false
    await nextTick()
    await vi.advanceTimersByTimeAsync(0)
    expect(api.status).toHaveBeenCalledTimes(1)
    expect(store.tracking).toBe(true)
    expect(store.percent).toBe(30)
  })

  it('同步到上次回滚（结果文件）：面板结局回显，确认已读清结果并重拉', async () => {
    api.status.mockResolvedValueOnce(status({ status: 'idle', result: 'rolled_back', resultError: 'health check failed', version: '9.9.9', resultAt: '2026-11-09T01:02:03Z' }))
    const store = useUpdateProgressStore()
    await store.sync()
    expect(store.tracking).toBe(false)
    expect(store.lastOutcome).toEqual({ phase: 'rolled_back', version: '9.9.9', error: 'health check failed', at: '2026-11-09T01:02:03Z' })
    // 非本会话终局：徽标不出（结局由服务端通知送达）
    expect(store.badgeVisible).toBe(false)

    api.clearStatus.mockResolvedValue({})
    api.status.mockResolvedValueOnce(status({ status: 'idle' }))
    await store.acknowledge()
    expect(api.clearStatus).toHaveBeenCalledWith({ silent: true })
    expect(store.lastOutcome).toBeNull()
  })

  it('实例切换：作废跟踪并按新实例实况重探', async () => {
    api.apply.mockResolvedValue({ version: '9.9.9' })
    const store = useUpdateProgressStore()
    await store.start()
    api.status.mockResolvedValueOnce(status({ status: 'idle' }))
    store.resetForInstance()
    expect(store.tracking).toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(api.status).toHaveBeenCalledTimes(1)
    // 旧跟踪的轮询定时器已作废：不再有请求
    await poll()
    expect(api.status).toHaveBeenCalledTimes(1)
    expect(store.tracking).toBe(false)
  })

  // 失败态一键重试（P-20261110-1-S2）：复用 apply 受理端点——受理成功即接棒
  // 跟踪；被拒（npm 形态 409 等状态机不承载失败的拒绝）拒因兜底终局不丢反馈
  it('retry：失败终局清位后走同一 apply 受理链，成功即接棒跟踪', async () => {
    api.apply.mockResolvedValue({ version: '9.9.9' })
    const store = useUpdateProgressStore()
    await store.start()
    api.status.mockResolvedValueOnce(status({ status: 'failed', version: '9.9.9', error: 'download failed: download returned 503 (after 3 attempts)' }))
    await poll()
    expect(store.outcome).toMatchObject({ phase: 'failed' })

    api.apply.mockResolvedValueOnce({ message: 'update started', version: '9.9.9' })
    api.status.mockResolvedValue(status({ status: 'downloading', progress: 1, total: 100, version: '9.9.9' }))
    expect(await store.retry({ silent: true })).toBe('started')
    expect(api.apply).toHaveBeenLastCalledWith({ silent: true })
    expect(store.outcome).toBeNull()
    expect(store.tracking).toBe(true)
    expect(store.phase).toBe('downloading')
  })

  it('retry 被拒（状态机仍空闲）：拒因兜底终局，旧因不挡道；错误如实上抛', async () => {
    api.status.mockResolvedValueOnce(status({ status: 'failed', version: '9.9.9', error: 'old reason' }))
    const store = useUpdateProgressStore()
    await store.sync()
    expect(store.lastOutcome).toMatchObject({ phase: 'failed', error: 'old reason' })

    const refusal = Object.assign(new Error('npm managed'), { status: 409, userMessage: 'npm 形态请用 npm 更新' })
    api.apply.mockRejectedValueOnce(refusal)
    api.status.mockResolvedValueOnce(status({ status: 'idle' }))
    await expect(store.retry({ silent: true })).rejects.toBe(refusal)
    expect(store.tracking).toBe(false)
    expect(store.outcome).toMatchObject({ phase: 'failed', version: '9.9.9', error: 'npm 形态请用 npm 更新' })
  })

  it('retry 被拒且无本地化文案：错误 message 兜底拒因', async () => {
    api.status.mockResolvedValueOnce(status({ status: 'failed', version: '9.9.9', error: 'old' }))
    const store = useUpdateProgressStore()
    await store.sync()

    api.apply.mockRejectedValueOnce(new Error('raw refusal'))
    api.status.mockResolvedValueOnce(status({ status: 'idle' }))
    await expect(store.retry()).rejects.toBeTruthy()
    expect(store.outcome).toMatchObject({ phase: 'failed', error: 'raw refusal' })
    // 缺省不带 config（silent 透传契约与 start 一致）
    expect(api.apply).toHaveBeenLastCalledWith(undefined)
  })

  it('openPanel 经 openVersionPanel 回版本面板', async () => {
    const store = useUpdateProgressStore()
    await store.openPanel()
    expect(openVersionPanel).toHaveBeenCalledTimes(1)
  })
})
