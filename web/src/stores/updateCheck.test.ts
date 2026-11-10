import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { reactive, nextTick } from 'vue'

// 前端自动检查电路开关门控（P-20261109-6）store 测试：开关关 = 停表零自动检查请求、
// 开 = 冷启动节律起表；热切换（本页保存同帧 / 广播重读）即时生效；每跳实读兜住
// 漏收广播；旧读数不覆盖新写入；锁定期不起表不打请求、解锁补起；读失败未知不发检查。

const api = vi.hoisted(() => ({
  check: vi.fn(),
  settingsGet: vi.fn(),
}))
vi.mock('../api/client', () => ({
  updateApi: { check: api.check },
  settingsApi: { get: api.settingsGet },
}))

const lockState = vi.hoisted(() => ({ value: null as null | { isLocked: boolean } }))
vi.mock('./lock', () => ({ useLockStore: () => lockState.value }))

// 中心检查分支桩成「未声明上级」：checkAll 的 center 半边静默收口，不干扰计数
vi.mock('./instance', () => ({
  useInstanceStore: () => ({ ensureInstancesFresh: vi.fn(async () => undefined), instances: [] }),
}))

const notificationAdd = vi.hoisted(() => vi.fn())
vi.mock('./notification', () => ({ useNotificationStore: () => ({ add: notificationAdd }) }))

vi.mock('../i18n', () => ({ default: { global: { t: (k: string) => k } } }))

import {
  useUpdateCheckStore, isAutoCheckOn, AUTO_CHECK_FIRST_DELAY_MS, AUTO_CHECK_INTERVAL_MS,
} from './updateCheck'

/** 服务端 settings 开关当前值（settingsGet 每次读都取此值，模拟他端改动即改它） */
let serverSwitch: boolean | undefined = true

function settingsResponse() {
  return { data: { updateChecks: serverSwitch, version: '0.0.1' } }
}

/** 只数开关实读（带 skipInflightDedupe 的那条）——checkCenter 的 settings 读不计 */
function switchReads(): number {
  return api.settingsGet.mock.calls.filter(([cfg]) => (cfg as { skipInflightDedupe?: boolean } | undefined)?.skipInflightDedupe).length
}

async function flush() {
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  setActivePinia(createPinia())
  lockState.value = reactive({ isLocked: false })
  serverSwitch = true
  api.check.mockReset()
  api.check.mockResolvedValue({ data: { currentVersion: '0.0.1', latestVersion: '0.0.1', hasUpdate: false } })
  api.settingsGet.mockReset()
  api.settingsGet.mockImplementation(async () => settingsResponse())
  notificationAdd.mockClear()
})

afterEach(() => {
  useUpdateCheckStore().stopAutoCheck()
  vi.useRealTimers()
})

describe('isAutoCheckOn', () => {
  it('仅显式 false 为关：缺字段（旧服务端/出厂默认）与 true 皆开', () => {
    expect(isAutoCheckOn({ updateChecks: false })).toBe(false)
    expect(isAutoCheckOn({ updateChecks: true })).toBe(true)
    expect(isAutoCheckOn({})).toBe(true)
    expect(isAutoCheckOn(undefined)).toBe(true)
    expect(isAutoCheckOn(null)).toBe(true)
  })
})

describe('updateCheck 自动检查电路门控（P-20261109-6）', () => {
  it('开关开：5s 首查 + 6h 周期复查，每跳先实读开关', async () => {
    const store = useUpdateCheckStore()
    store.startAutoCheck()
    await flush()
    expect(store.autoCheckEnabled).toBe(true)
    expect(api.check).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(AUTO_CHECK_FIRST_DELAY_MS)
    expect(api.check).toHaveBeenCalledTimes(1)
    // 解锁首读 + 首跳实读
    expect(switchReads()).toBe(2)

    await vi.advanceTimersByTimeAsync(AUTO_CHECK_INTERVAL_MS)
    expect(api.check).toHaveBeenCalledTimes(2)
    expect(switchReads()).toBe(3)
  })

  it('开关关：首读即停表——跨过首查与 6h 周期零检查请求、零后续实读', async () => {
    serverSwitch = false
    const store = useUpdateCheckStore()
    store.startAutoCheck()
    await flush()
    expect(store.autoCheckEnabled).toBe(false)

    await vi.advanceTimersByTimeAsync(AUTO_CHECK_FIRST_DELAY_MS + AUTO_CHECK_INTERVAL_MS * 2)
    expect(api.check).not.toHaveBeenCalled()
    // 停表后不再有跳：只剩启动那一次开关读
    expect(switchReads()).toBe(1)
  })

  it('本页保存热切换：关即停表，开即按冷启动节律重新起表（5s 首查）', async () => {
    const store = useUpdateCheckStore()
    store.startAutoCheck()
    await vi.advanceTimersByTimeAsync(AUTO_CHECK_FIRST_DELAY_MS)
    expect(api.check).toHaveBeenCalledTimes(1)

    serverSwitch = false
    store.applyAutoCheckSetting(false)
    expect(store.autoCheckEnabled).toBe(false)
    await vi.advanceTimersByTimeAsync(AUTO_CHECK_INTERVAL_MS * 2)
    expect(api.check).toHaveBeenCalledTimes(1)

    serverSwitch = true
    store.applyAutoCheckSetting(true)
    await vi.advanceTimersByTimeAsync(AUTO_CHECK_FIRST_DELAY_MS - 1)
    expect(api.check).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(api.check).toHaveBeenCalledTimes(2)
  })

  it('广播重读（他端/agent 改开关）：读到关即停表，读到开即恢复', async () => {
    const store = useUpdateCheckStore()
    store.startAutoCheck()
    await vi.advanceTimersByTimeAsync(AUTO_CHECK_FIRST_DELAY_MS)
    expect(api.check).toHaveBeenCalledTimes(1)

    serverSwitch = false
    await store.syncAutoCheckSetting()
    expect(store.autoCheckEnabled).toBe(false)
    await vi.advanceTimersByTimeAsync(AUTO_CHECK_INTERVAL_MS)
    expect(api.check).toHaveBeenCalledTimes(1)

    serverSwitch = true
    await store.syncAutoCheckSetting()
    expect(store.autoCheckEnabled).toBe(true)
    await vi.advanceTimersByTimeAsync(AUTO_CHECK_FIRST_DELAY_MS)
    expect(api.check).toHaveBeenCalledTimes(2)
  })

  it('每跳实读兜住漏收广播：镜像仍「开」但服务端已关 → 该跳不发检查请求并停表', async () => {
    const store = useUpdateCheckStore()
    store.startAutoCheck()
    await vi.advanceTimersByTimeAsync(AUTO_CHECK_FIRST_DELAY_MS)
    expect(api.check).toHaveBeenCalledTimes(1)

    // 他端关掉开关，本页 ops 通道断线漏收广播：镜像仍为开
    serverSwitch = false
    expect(store.autoCheckEnabled).toBe(true)
    await vi.advanceTimersByTimeAsync(AUTO_CHECK_INTERVAL_MS)
    expect(api.check).toHaveBeenCalledTimes(1)
    expect(store.autoCheckEnabled).toBe(false)
    const reads = switchReads()
    await vi.advanceTimersByTimeAsync(AUTO_CHECK_INTERVAL_MS)
    expect(switchReads()).toBe(reads)
  })

  it('旧读数不覆盖新写入：跳内实读在途时本页保存「关」，晚到的「开」读数作废且不发检查', async () => {
    const store = useUpdateCheckStore()
    store.startAutoCheck()
    await flush()
    expect(store.autoCheckEnabled).toBe(true)

    let release: (v: unknown) => void = () => {}
    api.settingsGet.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    await vi.advanceTimersByTimeAsync(AUTO_CHECK_FIRST_DELAY_MS)
    // 首跳的开关实读挂起中：本页保存关
    store.applyAutoCheckSetting(false)
    release({ data: { updateChecks: true } })
    await flush()

    expect(store.autoCheckEnabled).toBe(false)
    expect(api.check).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(AUTO_CHECK_INTERVAL_MS)
    expect(api.check).not.toHaveBeenCalled()
  })

  it('锁定期：不起表不打请求；解锁即读开关并按冷启动节律补起首查', async () => {
    lockState.value = reactive({ isLocked: true })
    const store = useUpdateCheckStore()
    store.startAutoCheck()
    await vi.advanceTimersByTimeAsync(AUTO_CHECK_FIRST_DELAY_MS + AUTO_CHECK_INTERVAL_MS)
    expect(api.settingsGet).not.toHaveBeenCalled()
    expect(api.check).not.toHaveBeenCalled()

    lockState.value!.isLocked = false
    await nextTick()
    await flush()
    expect(store.autoCheckEnabled).toBe(true)
    await vi.advanceTimersByTimeAsync(AUTO_CHECK_FIRST_DELAY_MS)
    expect(api.check).toHaveBeenCalledTimes(1)
  })

  it('已起表后回锁：锁定期各跳跳过不打请求，周期节律不重置；解锁重读开关', async () => {
    const store = useUpdateCheckStore()
    store.startAutoCheck()
    await vi.advanceTimersByTimeAsync(AUTO_CHECK_FIRST_DELAY_MS)
    expect(api.check).toHaveBeenCalledTimes(1)

    lockState.value!.isLocked = true
    await nextTick()
    const reads = api.settingsGet.mock.calls.length
    await vi.advanceTimersByTimeAsync(AUTO_CHECK_INTERVAL_MS)
    expect(api.settingsGet.mock.calls.length).toBe(reads)
    expect(api.check).toHaveBeenCalledTimes(1)

    // 锁定期间他端关了开关（广播随锁断开收不到）：解锁重读即停表
    serverSwitch = false
    lockState.value!.isLocked = false
    await nextTick()
    await flush()
    expect(store.autoCheckEnabled).toBe(false)
    await vi.advanceTimersByTimeAsync(AUTO_CHECK_INTERVAL_MS)
    expect(api.check).toHaveBeenCalledTimes(1)
  })

  it('开关读失败（未知）：起表但不发检查请求，读恢复后照常检查', async () => {
    api.settingsGet.mockRejectedValue(new Error('Network Error'))
    const store = useUpdateCheckStore()
    store.startAutoCheck()
    await vi.advanceTimersByTimeAsync(AUTO_CHECK_FIRST_DELAY_MS)
    expect(store.autoCheckEnabled).toBeNull()
    expect(api.check).not.toHaveBeenCalled()

    api.settingsGet.mockImplementation(async () => settingsResponse())
    await vi.advanceTimersByTimeAsync(AUTO_CHECK_INTERVAL_MS)
    expect(store.autoCheckEnabled).toBe(true)
    expect(api.check).toHaveBeenCalledTimes(1)
  })

  it('未调 startAutoCheck：保存/广播只更新镜像不起表（意图归 App 单例）', async () => {
    const store = useUpdateCheckStore()
    store.applyAutoCheckSetting(true)
    await store.syncAutoCheckSetting()
    await vi.advanceTimersByTimeAsync(AUTO_CHECK_FIRST_DELAY_MS + AUTO_CHECK_INTERVAL_MS)
    expect(store.autoCheckEnabled).toBe(true)
    expect(api.check).not.toHaveBeenCalled()
  })

  it('stopAutoCheck：首查定时器一并撤销（5s 内停表不再漏发首查）；startAutoCheck 幂等', async () => {
    const store = useUpdateCheckStore()
    store.startAutoCheck()
    store.startAutoCheck()
    await flush()
    store.stopAutoCheck()
    await vi.advanceTimersByTimeAsync(AUTO_CHECK_FIRST_DELAY_MS + AUTO_CHECK_INTERVAL_MS)
    expect(api.check).not.toHaveBeenCalled()
  })
})
