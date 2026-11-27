import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFetchDiagnostics, shouldRecordFetch } from './fetchDiagnostics'
import { buildBrowserDiagnosticsPayload, clearBrowserDiagnostics } from './browserDiagnostics'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const fetchMock = vi.fn()

function okResponse(status = 200): Response {
  return { status, ok: status < 400 } as Response
}

function entries() {
  return buildBrowserDiagnosticsPayload().entries
}

describe('fetch 透明诊断包装（P-20261124-2 S1b a）', () => {
  const originalFetch = window.fetch

  beforeAll(() => {
    window.fetch = fetchMock as unknown as typeof window.fetch
    installFetchDiagnostics()
  })

  beforeEach(() => {
    fetchMock.mockReset()
    clearBrowserDiagnostics()
    vi.useRealTimers()
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
  })

  afterAll(() => {
    window.fetch = originalFetch
  })

  it('零语义：原响应对象/原 init/this 原样透传（不 clone、不读 body）', async () => {
    const response = okResponse(200)
    fetchMock.mockResolvedValueOnce(response)
    const init = { method: 'POST', signal: new AbortController().signal }
    const got = await window.fetch('/api/projects', init)
    expect(got).toBe(response)
    expect(fetchMock).toHaveBeenCalledWith('/api/projects', init)
    expect(init.signal).toBeInstanceOf(AbortSignal)
    // 成功且不慢：无诊断条目
    expect(entries()).toHaveLength(0)
  })

  it('零语义：异常对象原样透传（同一引用，不包装成新错误）', async () => {
    const boom = new TypeError('Failed to fetch')
    fetchMock.mockRejectedValueOnce(boom)
    await expect(window.fetch('/api/projects')).rejects.toBe(boom)
    expect(entries()).toHaveLength(1)
    expect(entries()[0]!.errorClass).toBe('network')
    expect(entries()[0]!.message).toBe('Failed to fetch')
  })

  it('5xx 入环（http5xx，记 method/status/path/rid）', async () => {
    fetchMock.mockResolvedValueOnce(okResponse(503))
    await window.fetch('/api/projects/p1/file?path=/home/alice/x', { method: 'get' })
    const e = entries()[0]!
    expect(e.errorClass).toBe('http5xx')
    expect(e.method).toBe('GET')
    expect(e.status).toBe(503)
    expect(e.path).toBe('/api/projects/p1/file')
    expect(e.durationKind).toBe('ttfb')
    expect(e.requestId).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(JSON.stringify(e)).not.toContain('alice')
  })

  it('慢成功（TTFB>=5s）也入环，标 slow 且 status 保留', async () => {
    fetchMock.mockResolvedValueOnce(okResponse(200))
    const nowSpy = vi.spyOn(performance, 'now')
    nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(6000)
    await window.fetch('/api/slow')
    const e = entries()[0]!
    expect(e.slow).toBe(true)
    expect(e.status).toBe(200)
    expect(e.durationMs).toBe(6000)
    nowSpy.mockRestore()
  })

  it('AbortError 标 canceled（导出默认过滤）', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError')
    fetchMock.mockRejectedValueOnce(abort)
    await expect(window.fetch('/api/abort')).rejects.toBe(abort)
    // 环内存在（记录时保留 canceled 标记），但载荷默认过滤
    expect(entries()).toHaveLength(0)
  })

  it('离线时网络失败归 offline（不是笼统 network）', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(window.fetch('/api/offline')).rejects.toBeInstanceOf(TypeError)
    expect(entries()[0]!.errorClass).toBe('offline')
  })

  it('只记同源 /api 与 /proxy：预览/静态/跨域/blob:/data:/诊断端点跳过', async () => {
    fetchMock.mockResolvedValue(okResponse(500))
    await window.fetch('/preview/index.html')
    await window.fetch('/assets/app.js')
    await window.fetch('https://example.com/api/x')
    await window.fetch('blob:http://localhost/abc')
    await window.fetch('data:text/plain,hi')
    await window.fetch('/api/system/diagnostics/export?probe=1')
    await window.fetch('/api/preview/session')
    expect(entries()).toHaveLength(0)

    await window.fetch('/proxy/inst-1/api/projects')
    expect(entries()).toHaveLength(1)
    expect(entries()[0]!.path).toBe('/proxy/:instanceId/api/projects')
  })

  it('静态断言：包装实现不 clone/不读 body/不 await（零语义红线）', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(join(here, 'fetchDiagnostics.ts'), 'utf-8')
    expect(src).not.toMatch(/\.clone\(/)
    expect(src).not.toMatch(/\.json\(\)/)
    expect(src).not.toMatch(/\.text\(\)/)
    expect(src).not.toMatch(/arrayBuffer/)
    expect(src).not.toMatch(/await\s+result/)
  })

  // ── 分支覆盖：入环判定 / 请求形态 / 非 Error 异常 / 幂等安装 ──
  it('shouldRecordFetch：同源 /api、/proxy 才记录；跨域/非 http/非法 URL 一律不记', () => {
    expect(shouldRecordFetch('/api/projects')).toBe(true)
    expect(shouldRecordFetch('/proxy/inst/api/x')).toBe(true)
    expect(shouldRecordFetch('https://example.com/api/x')).toBe(false)
    expect(shouldRecordFetch('ftp://example.com/api/x')).toBe(false)
    expect(shouldRecordFetch('/assets/app.js')).toBe(false)
    expect(shouldRecordFetch('/api/preview/x')).toBe(false)
    expect(shouldRecordFetch('/api/system/diagnostics/export')).toBe(false)
    // 非法 URL 形态：解析抛错 → 保守不记录（绝不外发原文）
    expect(shouldRecordFetch('http://[invalid')).toBe(false)
  })

  it('URL 对象输入与 Request 对象输入：path 模板化、method 从 Request 读取', async () => {
    fetchMock.mockResolvedValueOnce(okResponse(500))
    await window.fetch(new URL(`${location.origin}/api/url-obj?x=1`))
    expect(entries()[0]!.path).toBe('/api/url-obj')
    if (typeof Request !== 'undefined') {
      fetchMock.mockResolvedValueOnce(okResponse(502))
      await window.fetch(new Request(new URL(`${location.origin}/api/req-obj`).href, { method: 'POST' }))
      expect(entries()[0]!.method).toBe('POST')
      expect(entries()[0]!.path).toBe('/api/req-obj')
    }
  })

  it('非 Error 异常（字符串/undefined）：原样透传 + message 安全转换', async () => {
    fetchMock.mockRejectedValueOnce('plain-boom')
    await expect(window.fetch('/api/str-err')).rejects.toBe('plain-boom')
    expect(entries()[0]!.message).toBe('plain-boom')

    fetchMock.mockRejectedValueOnce(undefined)
    await expect(window.fetch('/api/null-err')).rejects.toBeUndefined()
    expect(entries()[0]!.message).toBe('')
    expect(entries()[0]!.errorClass).toBe('network')
  })

  it('安装幂等：二次安装不重复包装（每次请求只记一条）', async () => {
    installFetchDiagnostics()
    fetchMock.mockResolvedValueOnce(okResponse(500))
    await window.fetch('/api/idempotent')
    expect(entries()).toHaveLength(1)
  })
})
