import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 浏览器诊断元数据（P-20261124-2 S1a①③）：请求拦截器写开始时刻/客户端 rid/
// X-Request-Id，响应拦截器换算 durationMs/errorClass 并入错误中心（再由 store
// 投影进诊断环）。本文件沿用 http-retry.test.ts 的拦截器捕获模式，离线驱动。
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

import { setInstanceContext } from '@/api/http'
import { useErrorLogStore } from '@/stores/errorLog'
import { buildBrowserDiagnosticsPayload, clearBrowserDiagnostics } from '@/utils/browserDiagnostics'

// http.ts 请求拦截器注册序：0 全局中止信号 / 1 远程代理改写 / 2 解锁头 / 3 诊断元数据
const diagRequest = h.captured.requestHandlers[3]
const onResponseError = h.captured.responseErrorHandlers[0]

function recordError(error: Record<string, unknown>): Promise<void> {
  return onResponseError(error).then(() => undefined, () => undefined)
}

describe('HTTP 请求诊断元数据（P-20261124-2 S1a①）', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    setInstanceContext(null, false)
    useErrorLogStore().clear()
    clearBrowserDiagnostics()
  })
  afterEach(() => vi.restoreAllMocks())

  it('未显式设置时生成客户端 rid 并写 X-Request-Id 头 + 开始时刻', () => {
    const cfg: Record<string, unknown> = { headers: {} }
    diagRequest(cfg)
    expect(typeof cfg.requestId).toBe('string')
    expect(cfg.requestId as string).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect((cfg.headers as Record<string, unknown>)['X-Request-Id']).toBe(cfg.requestId)
    expect(typeof cfg.startedAtWall).toBe('number')
    expect(typeof cfg.startedAtMono).toBe('number')
  })

  it('调用方显式设置 X-Request-Id 时沿用（不覆盖）', () => {
    const cfg: Record<string, unknown> = { headers: { 'X-Request-Id': 'upstream_rid_01234567' } }
    diagRequest(cfg)
    expect(cfg.requestId).toBe('upstream_rid_01234567')
    expect((cfg.headers as Record<string, unknown>)['X-Request-Id']).toBe('upstream_rid_01234567')
  })
})

describe('HTTP 错误中心诊断投影字段（P-20261124-2 S1a③）', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    setInstanceContext(null, false)
    useErrorLogStore().clear()
    clearBrowserDiagnostics()
  })
  afterEach(() => vi.restoreAllMocks())

  it('超时：errorClass=timeout/timedOut=true/clientTimeoutMs=0 合法/rid 回落客户端值', async () => {
    const startedWall = Date.now() - 1500
    await recordError({
      message: 'timeout of 0ms exceeded',
      code: 'ECONNABORTED',
      config: {
        method: 'get',
        url: '/api/projects/p1/status',
        requestId: 'sc-client-rid-1',
        startedAtWall: startedWall,
        startedAtMono: (typeof performance !== 'undefined' ? performance.now() : startedWall) - 1500,
        silent: true,
        timeout: 0,
      },
      response: undefined,
    })
    const entry = useErrorLogStore().logs[0]
    expect(entry.errorClass).toBe('timeout')
    expect(entry.timedOut).toBe(true)
    expect(entry.clientTimeoutMs).toBe(0)
    expect(entry.silent).toBe(true)
    expect(entry.requestId).toBe('sc-client-rid-1')
    expect(entry.durationMs).toBeGreaterThanOrEqual(1400)
    expect(entry.startedAt).toMatch(/Z$/)

    // silent 超时保留在诊断导出中（silentCount 标注）
    const [diag] = buildBrowserDiagnosticsPayload().entries
    expect(diag.errorClass).toBe('timeout')
    expect(diag.silent).toBe(true)
  })

  it('响应头 rid 与服务端日志对齐；5xx 分类', async () => {
    await recordError({
      message: 'Request failed with status code 500',
      config: { method: 'post', url: '/api/deploy', requestId: 'sc-client-rid-2' },
      response: {
        status: 500,
        headers: { 'x-request-id': 'serverrid0123456789' },
        data: { error: 'boom' },
      },
    })
    const entry = useErrorLogStore().logs[0]
    expect(entry.requestId).toBe('serverrid0123456789')
    expect(entry.errorClass).toBe('http5xx')
  })

  it('离线优先归 offline；ERR_CANCELED 提前返回不进错误环/诊断环', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    await recordError({
      message: 'Network Error',
      config: { method: 'get', url: '/api/x' },
      response: undefined,
    })
    expect(useErrorLogStore().logs[0].errorClass).toBe('offline')
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })

    const before = useErrorLogStore().logs.length
    const diagBefore = buildBrowserDiagnosticsPayload().entries.length
    await recordError({
      message: 'canceled',
      code: 'ERR_CANCELED',
      config: { method: 'get', url: '/api/canceled' },
      response: undefined,
    }).catch(() => undefined)
    expect(useErrorLogStore().logs.length).toBe(before)
    // 取消请求没有入账，诊断投影也不新增（early return）
    expect(buildBrowserDiagnosticsPayload().entries.length).toBe(diagBefore)
  })
})
