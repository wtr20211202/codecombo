import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { AxiosAdapter } from 'axios'

// 局部覆盖 setup.ts 的全局 axios mock：GET in-flight 去重（P-20261003-246）要驱动
// 「真实 axios 分发链 + http.ts 注册的去重 adapter」整链，故以 importActual 取真实
// axios、create 时预注入计数 adapter 作网络层——http.ts 模块加载经 axios.getAdapter
// 把计数 adapter 收编为去重包装的底层，「并发 N 同 URL → 网络层 1 次」直接读计数，
// 不发真网络请求。计数 adapter 固定加 10ms 在途延迟，保证并发真正重叠。
const h = vi.hoisted(() => ({
  networkCalls: [] as Array<{ method?: string; url?: string; params: unknown }>,
  failNext: false,
}))

vi.mock('axios', async (importOriginal) => {
  const real = await importOriginal<typeof import('axios')>()
  const counting: AxiosAdapter = async (config) => {
    h.networkCalls.push({ method: config.method, url: config.url, params: config.params ?? null })
    await new Promise(resolve => setTimeout(resolve, 10))
    if (h.failNext) {
      throw Object.assign(new Error('boom'), {
        config,
        response: { status: 500, data: { error: 'boom' }, headers: {} },
      })
    }
    return {
      // 真实 XHR 交付的 data 是原始字符串（responseText），transformResponse 逐
      // 消费者各自 JSON.parse——计数 adapter 须同形给字符串，才能验证「共享但
      // 对象隔离」语义（直接给对象会让三消费者共享同一引用，测不出拷贝设计）
      data: JSON.stringify({ url: config.url, params: config.params ?? null }),
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    }
  }
  return {
    default: {
      ...real.default,
      create: (cfg?: Record<string, unknown>) => real.default.create({ ...cfg, adapter: counting }),
    },
  }
})

import api, { cancelAllRequests, setInstanceContext } from '@/api/http'
import { AppError } from '@/api/error-types'

describe('GET in-flight 去重（P-20261003-246）', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.networkCalls.length = 0
    h.failNext = false
    setInstanceContext(null, false)
  })

  it('并发 3 同 URL GET：网络层 1 次，三消费者同值且对象各自独立', async () => {
    const results = await Promise.all([
      api.get('/settings'),
      api.get('/settings'),
      api.get('/settings'),
    ])
    expect(h.networkCalls).toHaveLength(1)
    expect(h.networkCalls[0]).toMatchObject({ method: 'get', url: '/settings' })
    expect(results[0]).toEqual(results[1])
    expect(results[1]).toEqual(results[2])
    // 逐消费者独立反序列化（响应浅拷贝 + 各自 transformResponse），未退化成同一引用
    expect(results[0]).not.toBe(results[1])
    expect(results[1]).not.toBe(results[2])
  })

  it('skipInflightDedupe 豁免合并：同键在途请求存在时直发新请求（读后写重取语义）', async () => {
    // 第一个请求先发起（在途 10ms 窗口内），紧跟一个带豁免标记的同键 GET：
    // 合并语义下它本该共享首个在途请求，豁免后必须直发——网络层 2 次
    const first = api.get('/claude/sessions', { params: { q: 'x' } })
    const fresh = api.get('/claude/sessions', { params: { q: 'x' }, skipInflightDedupe: true })
    const [r1, r2] = await Promise.all([first, fresh])
    const sessionCalls = h.networkCalls.filter(c => c.url === '/claude/sessions')
    expect(sessionCalls).toHaveLength(2)
    // 两者各自拿到独立响应（豁免请求不共享写前发起的共享结果）
    expect(r1).not.toBe(r2)
    // 对照：不带豁免的第三发仍并入首个在途——但首个已完成出表，故重新发出
    // （此处只验证豁免本身改变了合并行为，不重复既有合并用例）
  })

  it('params 不同不合并：同 URL 不同载荷各发各的，同载荷仍合并', async () => {
    await Promise.all([
      api.get('/projects/p1/file', { params: { path: '/a.md' } }),
      api.get('/projects/p1/file', { params: { path: '/b.md' } }),
      api.get('/projects/p1/file', { params: { path: '/a.md' } }),
    ])
    expect(h.networkCalls).toHaveLength(2)
    // 键序不影响命中：同语义载荷（键声明顺序相反）合并
    h.networkCalls.length = 0
    await Promise.all([
      api.get('/x', { params: { a: 1, b: 2 } }),
      api.get('/x', { params: { b: 2, a: 1 } }),
    ])
    expect(h.networkCalls).toHaveLength(1)
  })

  it('写类方法不去重：并发 3 POST 网络层 3 次（副作用安全边界）', async () => {
    await Promise.all([api.post('/stage'), api.post('/stage'), api.post('/stage')])
    expect(h.networkCalls).toHaveLength(3)
  })

  it('完成即出表：首个请求落地后的新请求重新发出（in-flight 合并不是缓存）', async () => {
    await api.get('/settings')
    await api.get('/settings')
    expect(h.networkCalls).toHaveLength(2)
  })

  it('失败也出表：并发消费者共享拒绝（各自入账），后续请求照常重发', async () => {
    h.failNext = true
    const first = api.get('/settings').catch((e: unknown) => e)
    const second = api.get('/settings').catch((e: unknown) => e)
    const [e1, e2] = await Promise.all([first, second])

    expect(h.networkCalls).toHaveLength(1)
    expect(e1).toBeInstanceOf(AppError)
    expect(e2).toBeInstanceOf(AppError)

    // 完成即出表（失败也是完成）：重试走新请求
    h.failNext = false
    await expect(api.get('/settings')).resolves.toBeTruthy()
    expect(h.networkCalls).toHaveLength(2)
  })

  it('共享拒绝按等待者各自的 config 处置：errorLabel 不被首个发起者串位', async () => {
    h.failNext = true
    const [e1, e2] = await Promise.all([
      api.get('/settings', { errorLabel: 'label.first' }).catch((e: AppError) => e),
      api.get('/settings', { errorLabel: 'label.joiner' }).catch((e: AppError) => e),
    ])
    // 先到的消费者挂 label.first，后并入的挂 label.joiner——per-caller 语义不串
    expect((e1 as AppError).sourceLabel).toBe('label.first')
    expect((e2 as AppError).sourceLabel).toBe('label.joiner')
  })

  it('远程代理改写后的完整 URL 进键：不同实例同名路径不合并', async () => {
    setInstanceContext('inst-A', true)
    const a = api.get('/projects/p1/status')
    // 等首个请求经请求拦截器完成改写（快照 inst-A 上下文）后再切实例
    await new Promise(resolve => setTimeout(resolve, 0))
    setInstanceContext('inst-B', true)
    await api.get('/projects/p1/status')

    expect(h.networkCalls).toHaveLength(2)
    expect(h.networkCalls[0].url).toBe('/proxy/inst-A/api/projects/p1/status')
    expect(h.networkCalls[1].url).toBe('/proxy/inst-B/api/projects/p1/status')
    await a // 防悬挂拒绝
  })

  it('实例切换全局中止照常取消在途请求，取消后新请求重新发出', async () => {
    const first = api.get('/settings').catch((e: unknown) => e)
    await new Promise(resolve => setTimeout(resolve, 0)) // 让请求真正进入在途
    cancelAllRequests()

    const err = await first
    expect(err).toBeInstanceOf(AppError)

    await api.get('/settings')
    expect(h.networkCalls).toHaveLength(2)
  })
})
