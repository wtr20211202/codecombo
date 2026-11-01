import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useRemoteHostStore, runPool } from './remoteHost'
import { remoteHostApi, type RemoteHost, type TestConnectionResult } from '@/api/client'

// 远程主机 store 单测：testAll 批量重测编排（P-20261006-3）——逐台复用既有单台
// 测试链、并发钳 4、失败隔离逐台计败；runPool 钳形用手动 deferred 确定性验证

vi.mock('@/api/client', () => ({
  remoteHostApi: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    test: vi.fn(),
    duplicate: vi.fn(),
  },
}))

function host(id: string, name: string): RemoteHost {
  // RemoteHost 含 createdAt/updatedAt 等审计字段，testAll 只消费 id/name——桩最小面即可
  return { id, name, host: '127.0.0.1', port: 22, user: 'e2e', authType: 'password', protocol: 'ssh' } as unknown as RemoteHost
}

function result(ok: boolean, error?: string): TestConnectionResult {
  return ok ? { ok: true, whoami: 'e2e', os: 'linux', arch: 'amd64' } : { ok: false, error }
}

/** 手控 deferred：resolve 前作业挂在 in-flight，可确定性观察池的并发钳形 */
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

describe('runPool', () => {
  it('并发钳形：同时进行中的作业数不超过并发上限，结果按原序返回', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const gates = [deferred(), deferred(), deferred(), deferred(), deferred()]
    const p = runPool([0, 1, 2, 3, 4], 3, async (i) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await gates[i]!.promise
      inFlight--
      return `w${i}`
    })
    // 微任务排空后恰有 3 个作业进入面（池位钳制），第 4/5 个仍未放行
    await Promise.resolve()
    await Promise.resolve()
    expect(maxInFlight).toBe(3)
    for (const g of gates) g.resolve()
    expect(await p).toEqual(['w0', 'w1', 'w2', 'w3', 'w4'])
    expect(maxInFlight).toBe(3)
  })

  it('并发钳下限收敛：concurrency<1 按 1 车道执行，空表零车道', async () => {
    expect(await runPool([1, 2], 0, async n => n * 10)).toEqual([10, 20])
    expect(await runPool([], 4, async () => 'x')).toEqual([])
  })
})

describe('remoteHost store · testAll', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(remoteHostApi.test).mockReset()
  })

  it('混合结果汇总：ok/failed 计数与失败主机名直列，批后 testing 态归位', async () => {
    // 拦截器已展平 AxiosResponse：store.test 实际拿到 body 本身（TestConnectionResult）
    vi.mocked(remoteHostApi.test).mockImplementation(async (id: string) =>
      (id === 'h2' ? result(false, 'auth rejected') : result(true)) as unknown as Awaited<ReturnType<typeof remoteHostApi.test>>)
    const store = useRemoteHostStore()
    store.hosts = [host('h1', 'alpha'), host('h2', 'beta'), host('h3', 'gamma')]
    const summary = await store.testAll()
    expect(summary).toEqual({ total: 3, ok: 2, failed: 1, failedNames: ['beta'] })
    expect(vi.mocked(remoteHostApi.test)).toHaveBeenCalledTimes(3)
    // 批后逐台 testing 全部落位 false（进行中徽章不残留；键保留是既有 test() 行为）
    expect(store.testing).toEqual({ h1: false, h2: false, h3: false })
  })

  it('失败隔离：HTTP 层抛错计败不中断整批，其余主机照常汇总', async () => {
    vi.mocked(remoteHostApi.test).mockImplementation(async (id: string) => {
      if (id === 'h1') throw new Error('network dead')
      return result(true) as unknown as Awaited<ReturnType<typeof remoteHostApi.test>>
    })
    const store = useRemoteHostStore()
    store.hosts = [host('h1', 'gone'), host('h2', 'alive')]
    const summary = await store.testAll()
    expect(summary).toEqual({ total: 2, ok: 1, failed: 1, failedNames: ['gone'] })
  })

  it('空主机表：零调用零汇总量', async () => {
    const store = useRemoteHostStore()
    const summary = await store.testAll()
    expect(summary).toEqual({ total: 0, ok: 0, failed: 0, failedNames: [] })
    expect(vi.mocked(remoteHostApi.test)).not.toHaveBeenCalled()
  })
})
