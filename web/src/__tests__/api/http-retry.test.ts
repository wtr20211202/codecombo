import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// 本文件局部覆盖 setup.ts 的全局 axios mock：错误中心重试（P-20261003-179）需要
// 真实捕获 http.ts 注册的拦截器 handlers，才能离线驱动「错误入账 → 重试配置挂载 →
// 原地重放」整链（不发真网络请求，也不起 axios 真实例）。
const h = vi.hoisted(() => {
  const captured = {
    requestHandlers: [] as Array<(config: Record<string, unknown>) => Record<string, unknown>>,
    responseErrorHandlers: [] as Array<(error: unknown) => Promise<unknown>>,
  }
  const apiInstance = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    interceptors: {
      request: {
        use: (fn: (config: Record<string, unknown>) => Record<string, unknown>) => {
          captured.requestHandlers.push(fn)
        },
      },
      response: {
        use: (_onOk: unknown, onError: (error: unknown) => Promise<unknown>) => {
          captured.responseErrorHandlers.push(onError)
        },
      },
    },
  }
  return { captured, apiInstance }
})

vi.mock('axios', () => ({ default: { create: vi.fn(() => h.apiInstance) } }))

import api, { retryErrorEntry, setInstanceContext } from '@/api/http'
import { useErrorLogStore } from '@/stores/errorLog'
import type { ErrorLogEntry } from '@/api/error-types'

// http.ts 依次注册 3 个请求拦截器（中止信号 / 远程代理改写 / 解锁头），
// 重试快照逻辑在第二个；响应拦截器只有 1 个（错误分类入账）
const rewrite = h.captured.requestHandlers[1]
const onResponseError = h.captured.responseErrorHandlers[0]

// 网络层失败的 axios error 形态（无 response；config 携 method/url/params）
function makeErr(method: string, url: string, params?: Record<string, unknown>) {
  return { message: 'Network Error', config: { method, url, params }, response: undefined }
}

// 驱动响应拦截器错误分支（入账一条错误）；拦截器契约是 reject(AppError)，就地吞掉
async function recordError(method: string, url: string, params?: Record<string, unknown>): Promise<void> {
  await onResponseError(makeErr(method, url, params)).catch(() => { /* 预期拒绝 */ })
}

describe('错误中心原地重试（P-20261003-179）', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.apiInstance.get.mockReset()
    setInstanceContext(null, false)
  })
  afterEach(() => consoleSpy.mockRestore())

  it('GET 失败入账附带重试配置（原始路径 + params + 实例上下文快照）', async () => {
    setInstanceContext('inst-A', true)
    await recordError('get', '/projects/p1/file', { path: '/a.md' })

    const entry = useErrorLogStore().logs[0]
    expect(entry.method).toBe('GET')
    expect(entry.retry).toEqual({
      url: '/projects/p1/file',
      params: { path: '/a.md' },
      instanceId: 'inst-A',
      isRemote: true,
    })
  })

  it('非幂等方法（POST/PUT/DELETE）不附重试配置（安全边界）', async () => {
    await recordError('post', '/projects/p1/stage')
    await recordError('put', '/settings')
    await recordError('delete', '/projects/p1/x')

    const logs = useErrorLogStore().logs
    expect(logs).toHaveLength(3)
    expect(logs[0].method).toBe('DELETE')
    expect(logs[1].method).toBe('PUT')
    expect(logs[2].method).toBe('POST')
    expect(logs[0].retry).toBeUndefined()
    expect(logs[1].retry).toBeUndefined()
    expect(logs[2].retry).toBeUndefined()
  })

  it('远程代理改写快照原始路径：重试配置不叠加 /proxy 前缀', async () => {
    setInstanceContext('inst-R', true)
    // 生产流程中请求拦截器改写与错误捕获是同一 merged config 对象——这里用同一
    // cfg 走改写 → 失败，origUrl 快照才会像线上一样出现在 error.config 上
    const cfg: Record<string, unknown> = { method: 'get', url: '/projects/p1/status', baseURL: '/api', headers: {} }

    rewrite(cfg)
    expect(cfg.url).toBe('/proxy/inst-R/api/projects/p1/status')

    await onResponseError({ message: 'Network Error', config: cfg, response: undefined }).catch(() => { /* 预期拒绝 */ })
    const entry = useErrorLogStore().logs[0]
    expect(entry.url).toBe('/proxy/inst-R/api/projects/p1/status') // 展示面沿用改写后路径
    expect(entry.retry?.url).toBe('/projects/p1/status') // 重放面用改写前快照
    expect(entry.retry?.instanceId).toBe('inst-R')
    expect(entry.retry?.isRemote).toBe(true)
  })

  it('retryErrorEntry 成功：重放原路径，原条目标记已恢复', async () => {
    setInstanceContext('inst-A', false)
    await recordError('get', '/projects/p1/status', undefined)
    const entry = useErrorLogStore().logs[0]

    h.apiInstance.get.mockResolvedValueOnce({})
    await expect(retryErrorEntry(entry)).resolves.toBe(true)

    expect(entry.recoveredAt).toBeTruthy()
    expect(h.apiInstance.get).toHaveBeenCalledWith('/projects/p1/status', { params: undefined })
  })

  it('retryErrorEntry 失败：重放走既有拦截器入新账，原条目保持未恢复', async () => {
    await recordError('get', '/projects/p1/status', undefined)
    const original = useErrorLogStore().logs[0]

    // 重放失败经真实响应拦截器（生产 axios 对 reject 的处置同形）→ 新错误入账
    h.apiInstance.get.mockImplementationOnce(() => onResponseError(makeErr('get', '/projects/p1/status')))
    await expect(retryErrorEntry(original)).resolves.toBe(false)

    const logs = useErrorLogStore().logs
    expect(original.recoveredAt).toBeUndefined()
    expect(logs).toHaveLength(2)
    expect(logs[0].id).not.toBe(original.id)
    expect(logs[0].retry).toBeDefined() // 新条目同样可重试
  })

  it('实例已切换：拒绝原地重试且不发请求', async () => {
    setInstanceContext('inst-A', false)
    await recordError('get', '/a', undefined)
    const entry = useErrorLogStore().logs[0]

    setInstanceContext('inst-B', false)
    await expect(retryErrorEntry(entry)).resolves.toBe(false)

    expect(h.apiInstance.get).not.toHaveBeenCalled()
    expect(entry.recoveredAt).toBeUndefined()
  })

  it('无重试配置的条目直接返回 false', async () => {
    await expect(retryErrorEntry({ id: 'x' } as ErrorLogEntry)).resolves.toBe(false)
    expect(api.get).not.toHaveBeenCalled()
  })
})
