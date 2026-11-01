import { defineStore } from 'pinia'
import { ref } from 'vue'
import { remoteHostApi, type RemoteHost, type RemoteHostAuthType, type TestConnectionResult } from '../api/client'

// axios interceptor 已展平 AxiosResponse，运行时返回 server body 本身
type Resp<T> = { data?: T }

/** 有界并发池（与 fetch-all 服务端池同构的逐项入池形态）：按原序返回各 worker 结果。
 *  独立导出纯函数——单测可用手动控制的 deferred 确定性地验证并发钳形，不猜真实计时 */
export async function runPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const laneCount = Math.max(1, Math.min(concurrency, items.length))
  const lanes = Array.from({ length: laneCount }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await worker(items[i]!, i)
    }
  })
  await Promise.all(lanes)
  return out
}

/** 全部重测汇总（testAll 返回值）：failedNames 供完成 toast 直列失败主机 */
export interface TestAllSummary {
  total: number
  ok: number
  failed: number
  failedNames: string[]
}

/** 批量重测并发钳：单台测试 = 真实 SSH/FTP 拨号，与 fetch-all 并发池同档取 4
 *  （server/api/project/fetchall.go 惯例——批量提速且不放大出站连接风暴） */
const TEST_ALL_CONCURRENCY = 4

export const useRemoteHostStore = defineStore('remoteHost', () => {
  const hosts = ref<RemoteHost[]>([])
  const loading = ref(false)
  const testing = ref<Record<string, boolean>>({})
  const testResults = ref<Record<string, TestConnectionResult>>({})

  async function fetch() {
    loading.value = true
    try {
      const res = (await remoteHostApi.list()) as unknown as Resp<RemoteHost[]>
      hosts.value = res.data || []
    } finally {
      loading.value = false
    }
  }

  async function create(input: {
    name: string
    host: string
    port: number
    user: string
    authType: RemoteHostAuthType
    password?: string
    sshKeyId?: string
    pemContent?: string
    hostKeyVerifyDisabled?: boolean
  }) {
    const res = (await remoteHostApi.create(input)) as unknown as Resp<RemoteHost>
    await fetch()
    return res.data
  }

  async function update(id: string, input: Partial<{
    name: string
    host: string
    port: number
    user: string
    authType: RemoteHostAuthType
    password: string
    sshKeyId: string
    pemContent: string
    hostKeyVerifyDisabled?: boolean
  }>) {
    await remoteHostApi.update(id, input)
    await fetch()
  }

  async function remove(id: string) {
    await remoteHostApi.remove(id)
    await fetch()
  }

  async function test(id: string) {
    testing.value[id] = true
    delete testResults.value[id]
    try {
      const res = (await remoteHostApi.test(id)) as unknown as TestConnectionResult
      testResults.value[id] = res
      return res
    } finally {
      testing.value[id] = false
    }
  }

  function clearTestResult(id: string) {
    delete testResults.value[id]
  }

  /** 全部重测（P-20261006-3）：对全部主机逐台触发既有单台测试（拨号+whoami 同链，
   *  testing 逐台徽章自动亮起），并发钳 TEST_ALL_CONCURRENCY；逐台失败隔离不中断
   *  整批（HTTP 层失败与业务失败同样计败——探测循环不动，这只是周期外的手动全量触发）。
   *  重入去抖由调用方的按钮 loading 态负责（store 不持有进行中标志） */
  async function testAll(): Promise<TestAllSummary> {
    const targets = hosts.value.map(h => ({ id: h.id, name: h.name }))
    const failedNames = (await runPool(targets, TEST_ALL_CONCURRENCY, async (t) => {
      try {
        const r = await test(t.id)
        return r.ok ? null : t.name
      } catch {
        return t.name
      }
    })).filter((n): n is string => n !== null)
    return {
      total: targets.length,
      ok: targets.length - failedNames.length,
      failed: failedNames.length,
      failedNames,
    }
  }

  return {
    hosts,
    loading,
    testing,
    testResults,
    fetch,
    create,
    update,
    remove,
    test,
    testAll,
    clearTestResult,
  }
})

