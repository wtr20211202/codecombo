import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { recordWsLifecycle } from './wsLifecycle'
import {
  DIAG_PAYLOAD_BYTE_LIMIT,
  DIAG_SERVER_ENTRY_LIMIT,
  buildBrowserDiagnosticsPayload,
  buildServerClientReport,
  clearBrowserDiagnostics,
  clearDiagSnapshot,
  diagEntryCount,
  downloadBrowserDiagnostics,
  installBrowserDiagnostics,
  projectErrorLogEntry,
  recordDiagEntry,
  recordResourceFailure,
  type DiagEntry,
} from './browserDiagnostics'

const SNAPSHOT_KEY = 'sc.diag.snapshot'

function requestEntry(overrides: Partial<DiagEntry> = {}): DiagEntry {
  return {
    kind: 'request',
    source: 'xhr',
    ts: new Date().toISOString(),
    errorClass: 'network',
    method: 'GET',
    path: '/api/projects/:id/status',
    status: 0,
    message: '',
    ...overrides,
  }
}

/** 断言载荷 JSON 只有白名单顶层/条目字段（负向哨兵由此统一守） */
function payloadJson(): string {
  return JSON.stringify(buildBrowserDiagnosticsPayload())
}

describe('browserDiagnostics 浏览器诊断环（P-20261124-2）', () => {
  beforeAll(() => {
    installBrowserDiagnostics()
  })

  beforeEach(() => {
    clearBrowserDiagnostics()
    vi.useRealTimers()
  })
  afterEach(() => vi.useRealTimers())

  it('快照恢复语义（独立模块实例）：50 条上限 + 字段重脱敏 + 篡改字段丢弃', async () => {
    vi.resetModules()
    const entries = Array.from({ length: 60 }, (_, i) => ({
      kind: 'script',
      source: 'window',
      ts: '2026-11-25T00:00:00.000Z',
      errorClass: 'unknown',
      path: `/home/alice/secret-${i}.js`,
      message: `boom ${i}`,
      injectedSecret: 'SNAPSHOT_LEAK',
    }))
    sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ schemaVersion: 1, entries }))
    const mod = await import('./browserDiagnostics')
    mod.installBrowserDiagnostics()
    const payload = mod.buildBrowserDiagnosticsPayload()
    expect(payload.entries).toHaveLength(50)
    expect(JSON.stringify(payload)).not.toContain('alice')
    expect(JSON.stringify(payload)).not.toContain('SNAPSHOT_LEAK')
    mod.clearBrowserDiagnostics()
    sessionStorage.removeItem(SNAPSHOT_KEY)
  })

  it('window.onerror：同源脚本错误记 path/行列，跨域只留 Script error.+crossOrigin', () => {
    window.dispatchEvent(new ErrorEvent('error', {
      message: 'boom-onerror',
      filename: `${location.origin}/assets/app.js`,
      lineno: 12,
      colno: 34,
    }))
    window.dispatchEvent(new ErrorEvent('error', { message: 'Script error.' }))
    const entries = buildBrowserDiagnosticsPayload().entries
    const cross = entries[0]!
    const same = entries[1]!
    expect(same.kind).toBe('script')
    expect(same.source).toBe('window')
    expect(same.message).toBe('boom-onerror')
    expect(same.path).toBe('/assets/app.js')
    expect(same.line).toBe(12)
    expect(same.crossOrigin).toBeUndefined()
    expect(cross.message).toBe('Script error.')
    expect(cross.crossOrigin).toBe(true)
    expect(cross.path).toBeUndefined()
  })

  it('unhandledrejection：记 promise 条目（错误消息脱敏）', () => {
    const ev = new Event('unhandledrejection') as Event & { reason?: unknown }
    Object.defineProperty(ev, 'reason', { value: new Error('promise boom at /home/alice/x') })
    window.dispatchEvent(ev)
    const entry = buildBrowserDiagnosticsPayload().entries[0]!
    expect(entry.kind).toBe('promise')
    expect(entry.source).toBe('promise')
    expect(entry.message).toContain('promise boom')
    expect(entry.message).not.toContain('alice')
  })

  it('资源加载失败：同源记 path，跨域只记 crossOrigin', () => {
    const same = document.createElement('img')
    same.src = `${location.origin}/assets/missing.png`
    document.body.appendChild(same)
    same.dispatchEvent(new Event('error'))
    const cross = document.createElement('img')
    cross.src = 'https://cdn.example.com/x.png'
    document.body.appendChild(cross)
    cross.dispatchEvent(new Event('error'))
    const payload = buildBrowserDiagnosticsPayload()
    expect(payload.resource).toHaveLength(2)
    const [crossRes, sameRes] = [payload.resource[0]!, payload.resource[1]!]
    expect(sameRes.tag).toBe('img')
    expect(sameRes.path).toBe('/assets/missing.png')
    expect(sameRes.crossOrigin).toBe(false)
    expect(crossRes.crossOrigin).toBe(true)
    expect(crossRes.path).toBe('')
    same.remove()
    cross.remove()
  })

  it('脚本体错误同文案 1 分钟内去重（repeats 累计，不刷环）', () => {
    const dispatch = () => window.dispatchEvent(new ErrorEvent('error', { message: 'dedupe-me' }))
    dispatch()
    dispatch()
    dispatch()
    const entries = buildBrowserDiagnosticsPayload().entries
    expect(entries).toHaveLength(1)
    expect(entries[0]!.repeats).toBe(3)
  })

  it('环形淘汰：200 条上限，最旧先丢且 truncated=true', () => {
    for (let i = 0; i < 205; i++) {
      recordDiagEntry(requestEntry({ path: `/api/x/${i}`, ts: new Date(Date.now() + i).toISOString() }))
    }
    expect(diagEntryCount()).toBe(200)
    const payload = buildBrowserDiagnosticsPayload()
    expect(payload.entries).toHaveLength(200)
    expect(payload.entries[0]!.path).toBe('/api/x/204')
    expect(payload.truncated).toBe(true)
  })

  it('silent 过滤：默认丢 silent 4xx 探测，只留 silent 超时/5xx/离线，并给 silentCount', () => {
    recordDiagEntry(requestEntry({ path: '/api/a', errorClass: 'http4xx', status: 404, silent: true }))
    recordDiagEntry(requestEntry({ path: '/api/b', errorClass: 'timeout', timedOut: true, silent: true }))
    recordDiagEntry(requestEntry({ path: '/api/c', errorClass: 'http5xx', status: 500, silent: true }))
    recordDiagEntry(requestEntry({ path: '/api/d', errorClass: 'offline', silent: true }))
    recordDiagEntry(requestEntry({ path: '/api/e', errorClass: 'network' }))
    const payload = buildBrowserDiagnosticsPayload()
    expect(payload.entries.map((e) => e.path)).toEqual(['/api/e', '/api/d', '/api/c', '/api/b'])
    expect(payload.silentCount).toBe(4)
  })

  it('canceled（AbortError）默认过滤', () => {
    recordDiagEntry(requestEntry({ path: '/api/canceled', canceled: true }))
    recordDiagEntry(requestEntry({ path: '/api/kept' }))
    const payload = buildBrowserDiagnosticsPayload()
    expect(payload.entries.map((e) => e.path)).toEqual(['/api/kept'])
  })

  it('错误中心投影：只取白名单（rawMessage/retry/body/header 不出现），URL 模板化', () => {
    const diag = projectErrorLogEntry({
      timestamp: new Date().toISOString(),
      category: 'network',
      method: 'GET',
      url: '/api/share/SENTINEL_SHARE_TOKEN/messages?path=/home/alice/secret',
      status: 0,
      userMessage: '网络连接异常，请检查服务是否启动',
      rawMessage: 'RAW_SENTINEL /home/alice/secret',
      requestId: 'sc-rid-1',
      errorClass: 'timeout',
      silent: true,
      clientTimeoutMs: 0,
      timedOut: false,
    } as unknown as Parameters<typeof projectErrorLogEntry>[0])
    const extra = { ...diag, body: 'BODY_SENTINEL', headers: { Authorization: 'HEADER_SENTINEL' } } as unknown as DiagEntry
    recordDiagEntry(extra)
    const json = payloadJson()
    expect(json).not.toContain('SENTINEL_SHARE_TOKEN')
    expect(json).not.toContain('RAW_SENTINEL')
    expect(json).not.toContain('BODY_SENTINEL')
    expect(json).not.toContain('HEADER_SENTINEL')
    expect(json).not.toContain('alice')
    const entry = buildBrowserDiagnosticsPayload().entries[0]!
    expect(entry.path).toBe('/api/share/:token/messages')
    expect((entry as unknown as Record<string, unknown>).userMessage).toBeUndefined()
    expect(entry.clientTimeoutMs).toBe(0)
    expect(entry.silent).toBe(true)
  })

  it('Vue errorHandler 投影为 script/vue（不重复记脚本错误）', () => {
    const diag = projectErrorLogEntry({
      timestamp: new Date().toISOString(),
      category: 'client',
      method: 'VUE',
      url: 'vue:render function',
      status: 0,
      userMessage: '界面渲染出错',
    }, 'vue')
    recordDiagEntry(diag)
    const entry = buildBrowserDiagnosticsPayload().entries[0]!
    expect(entry.kind).toBe('script')
    expect(entry.source).toBe('vue')
    expect(entry.message).toBe('界面渲染出错')
  })

  it('下载体量上限 200KB：超限从最旧丢并标 truncated', () => {
    const longMessage = 'm'.repeat(500)
    const longPath = '/api/' + 'p'.repeat(700)
    for (let i = 0; i < 200; i++) {
      recordDiagEntry(requestEntry({ path: longPath, message: longMessage }))
    }
    // WS 环也入包：50 条 × 200 字符 reason 把总量推过 200KB 上限
    for (let i = 0; i < 50; i++) {
      recordWsLifecycle('ws://h/ws/terminal/t', 1006, 'r'.repeat(200), false, 0, 1, false)
    }
    const payload = buildBrowserDiagnosticsPayload()
    expect(payload.truncated).toBe(true)
    expect(JSON.stringify(payload).length).toBeLessThanOrEqual(DIAG_PAYLOAD_BYTE_LIMIT + 2048)
    expect(payload.entries.length).toBeLessThan(200)
  })

  it('page schema：只含白名单字段（protocol/timezone/tzOffset/visibility/userAgent 截断 256）', () => {
    const { page } = buildBrowserDiagnosticsPayload()
    expect(page.protocol).toBe(location.protocol)
    expect(typeof page.tzOffsetMinutes).toBe('number')
    expect(page.userAgent.length).toBeLessThanOrEqual(256)
    expect(Object.keys(page).sort()).toEqual(['protocol', 'timezone', 'tzOffsetMinutes', 'userAgent', 'visibility'])
  })

  it('快照：节流 1s 写 sessionStorage；清空即清键；配额满只标 snapshotWriteFailed', () => {
    vi.useFakeTimers()
    recordDiagEntry(requestEntry({ message: 'snap' }))
    expect(sessionStorage.getItem(SNAPSHOT_KEY)).toBeNull()
    vi.advanceTimersByTime(1100)
    expect(sessionStorage.getItem(SNAPSHOT_KEY)).toContain('"schemaVersion":1')

    clearBrowserDiagnostics()
    expect(sessionStorage.getItem(SNAPSHOT_KEY)).toBeNull()

    // 配额满：setItem 抛错且值不落盘（jsdom 的 Storage 方法不可 spy，直接换
    // 掉 window.sessionStorage 实现——safeStorage 每次调用都重新取属性）
    const descriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage')!
    const fakeStorage = {
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceededError') },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    }
    Object.defineProperty(window, 'sessionStorage', { configurable: true, value: fakeStorage })
    recordDiagEntry(requestEntry({ message: 'quota' }))
    vi.advanceTimersByTime(1100)
    const payload = buildBrowserDiagnosticsPayload()
    expect(payload.snapshotWriteFailed).toBe(true)
    expect(payload.entries).toHaveLength(1)
    Object.defineProperty(window, 'sessionStorage', descriptor)
  })

  it('sessionStorage 被禁用（属性访问即抛）：标 snapshotWriteFailed，内存环仍可导出', () => {
    vi.useFakeTimers()
    const descriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage')!
    // 隐私模式/屏蔽 Cookie：sessionStorage 属性访问即抛 SecurityError——
    // safeStorage 落 sessionMemory（会话内生效），但快照不跨刷新，须如实标记
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() { throw new Error('SecurityError') },
    })
    try {
      recordDiagEntry(requestEntry({ message: 'storage-disabled' }))
      vi.advanceTimersByTime(1100)
      const payload = buildBrowserDiagnosticsPayload()
      expect(payload.snapshotWriteFailed).toBe(true)
      expect(payload.entries).toHaveLength(1)
    } finally {
      Object.defineProperty(window, 'sessionStorage', descriptor)
    }
  })

  it('clearDiagSnapshot 只清快照（锁定边界），内存环保留', () => {
    vi.useFakeTimers()
    recordDiagEntry(requestEntry({ message: 'locked' }))
    vi.advanceTimersByTime(1100)
    expect(sessionStorage.getItem(SNAPSHOT_KEY)).not.toBeNull()
    clearDiagSnapshot()
    expect(sessionStorage.getItem(SNAPSHOT_KEY)).toBeNull()
    expect(buildBrowserDiagnosticsPayload().entries).toHaveLength(1)
  })

  it('本地下载：文件名/条目数/字节数返回，Blob 不经服务器', () => {
    const createObjectURL = vi.fn(() => 'blob:mock')
    const revokeObjectURL = vi.fn()
    const originalCreate = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL
    URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const result = downloadBrowserDiagnostics()
    expect(result.fileName).toMatch(/^browser-diagnostics-.*\.json$/)
    expect(result.fileName).not.toContain(':')
    expect(result.bytes).toBeGreaterThan(0)
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(clickSpy).toHaveBeenCalledTimes(1)
    clickSpy.mockRestore()
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
  })

  it('资源环上限 50（最旧淘汰）', () => {
    for (let i = 0; i < 55; i++) recordResourceFailure('img', `/assets/${i}.png`, false)
    expect(buildBrowserDiagnosticsPayload().resource).toHaveLength(50)
  })

  // ── 健壮性分支（损坏快照、非法条目、无 target 的资源事件、pending 定时器）──
  it('快照损坏（非法 JSON / 版本不符）：清键且环保持空态', async () => {
    vi.resetModules()
    sessionStorage.setItem(SNAPSHOT_KEY, '{not-json')
    const mod = await import('./browserDiagnostics')
    mod.installBrowserDiagnostics()
    expect(sessionStorage.getItem(SNAPSHOT_KEY)).toBeNull()
    expect(mod.buildBrowserDiagnosticsPayload().entries).toHaveLength(0)
    mod.clearBrowserDiagnostics()

    vi.resetModules()
    sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ schemaVersion: 999, entries: [{ message: 'x', ts: 'now' }] }))
    const mod2 = await import('./browserDiagnostics')
    mod2.installBrowserDiagnostics()
    expect(sessionStorage.getItem(SNAPSHOT_KEY)).toBeNull()
    expect(mod2.buildBrowserDiagnosticsPayload().entries).toHaveLength(0)
    mod2.clearBrowserDiagnostics()
  })

  it('快照恢复：非法条目丢弃、未知枚举回落默认、可选字段往返', async () => {
    vi.resetModules()
    sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify({
      schemaVersion: 1,
      entries: [
        null,
        42,
        { ts: '2026-11-25T00:00:00.000Z' },
        { message: 'ok', ts: '2026-11-25T00:00:00.000Z', kind: 'bogus', source: 'nope', errorClass: 'weird' },
        {
          message: 'full', ts: '2026-11-25T00:00:00.000Z', kind: 'request', source: 'fetch',
          method: 'POST', path: '/api/x', status: 500, requestId: 'rid', timedOut: true,
          clientTimeoutMs: 30000, silent: true, route: '/project', repeats: 2, crossOrigin: true,
          canceled: true, durationKind: 'ttfb', slow: true, line: 1, col: 2,
          durationMs: 12, startedAt: '2026-11-25T00:00:00.000Z',
        },
      ],
    }))
    const mod = await import('./browserDiagnostics')
    mod.installBrowserDiagnostics()
    const restored = mod.buildBrowserDiagnosticsPayload().entries
    // 非法条目（null/数字/缺 message）丢弃，未知枚举回落默认
    expect(restored.some((e) => e.message === 'ok' && e.kind === 'request' && e.source === 'xhr' && e.errorClass === 'unknown')).toBe(true)
    // canceled 条目仍在内存环（导出默认过滤）——用环条目数验证可选字段已恢复
    expect(mod.diagEntryCount()).toBe(2)
    const kept = restored.find((e) => e.message === 'ok')
    expect(kept!.requestId).toBeUndefined()
    mod.clearBrowserDiagnostics()
  })

  it('非法条目入口（缺 message/ts）不进环', () => {
    recordDiagEntry(null as unknown as DiagEntry)
    recordDiagEntry({ kind: 'request' } as unknown as DiagEntry)
    recordDiagEntry({ kind: 'script', message: 'boom' } as unknown as DiagEntry)
    expect(diagEntryCount()).toBe(0)
  })

  it('资源事件无 target / unhandledrejection 非 Error reason：不抛且如实记录', () => {
    // 捕获相普通 Event 但 target 无 src/href（非资源元素）：空 URL 按跨域保守处理
    window.dispatchEvent(new Event('error'))
    expect(buildBrowserDiagnosticsPayload().resource[0]).toMatchObject({ tag: 'unknown', path: '', crossOrigin: true })

    const ev = new Event('unhandledrejection') as Event & { reason?: unknown }
    Object.defineProperty(ev, 'reason', { value: 'plain-reason' })
    window.dispatchEvent(ev)
    expect(buildBrowserDiagnosticsPayload().entries[0]!.message).toBe('plain-reason')
  })

  it('clearDiagSnapshot 取消在途节流写（清后不再落盘）', () => {
    vi.useFakeTimers()
    recordDiagEntry(requestEntry({ message: 'pending' }))
    clearDiagSnapshot()
    vi.advanceTimersByTime(2000)
    expect(sessionStorage.getItem(SNAPSHOT_KEY)).toBeNull()
    // 内存环仍在（clearDiagSnapshot 只清快照）
    expect(buildBrowserDiagnosticsPayload().entries).toHaveLength(1)
  })
})

// ── P-20261126-2 P-2b：server 作用域裁剪（P-20261127-1 后无前端窗口可测——
//    lastReportPostAt 机制退役，携带与否由导出点击自身的 POST 结果决定，集成
//    契约由 e2e server-logs.spec 守）────────────────────────────────────────

describe('browserDiagnostics server 作用域（P-20261126-2）', () => {
  beforeEach(() => {
    clearBrowserDiagnostics()
  })

  it('buildServerClientReport：entries/ws 截最新 50、resource/UA/protocol 不出浏览器、generatedAt 同源', () => {
    // 环里塞 60 条请求 + 资源失败 + WS 条目
    for (let i = 0; i < 60; i++) {
      recordDiagEntry(requestEntry({ message: `m-${i}` }))
    }
    recordResourceFailure('img', '/assets/missing.png', false)
    const payload = buildBrowserDiagnosticsPayload()
    payload.page.userAgent = 'Mozilla/5.0 UA-FINGERPRINT'
    payload.page.protocol = 'http:'

    const trimmed = buildServerClientReport(payload)
    expect(trimmed.schemaVersion).toBe(payload.schemaVersion)
    expect(trimmed.generatedAt).toBe(payload.generatedAt) // B1：单次构造同源快照
    expect(trimmed.entries).toHaveLength(DIAG_SERVER_ENTRY_LIMIT)
    // unshift 序=最新优先：数组头即最新条目（m-59 是最后记录的）
    expect(trimmed.entries[0]!.message).toBe('m-59')
    // 白名单负向（评审 A1 前端半场）：resource 环与 page.userAgent/protocol 整体不出
    expect(JSON.stringify(trimmed)).not.toContain('UA-FINGERPRINT')
    expect(JSON.stringify(trimmed)).not.toContain('missing.png')
    expect(trimmed).not.toHaveProperty('resource')
    expect(trimmed.page).not.toHaveProperty('userAgent')
    expect(trimmed.page).not.toHaveProperty('protocol')
    expect(trimmed.page).not.toHaveProperty('serverObservedHost') // 只由服务端回填
    // ws 原样带出（≤50 由 wsLifecycle 环上限天然保证）
    expect(trimmed.ws).toEqual(payload.ws)
  })

  it('downloadBrowserDiagnostics(payload)：传入载荷与下载文件同源（单次构造 B1）', () => {
    recordDiagEntry(requestEntry({ message: 'shared-snapshot' }))
    const payload = buildBrowserDiagnosticsPayload()
    // 下载后环再变：传入的载荷不应受影响
    recordDiagEntry(requestEntry({ message: 'later-entry' }))
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    try {
      const res = downloadBrowserDiagnostics(payload)
      expect(res.entries).toBe(payload.entries.length)
      expect(res.entries).toBe(1) // later-entry 不在传入载荷里
      expect(res.fileName).toMatch(/^browser-diagnostics-[0-9A-Za-z-]+\.json$/)
      expect(res.bytes).toBeGreaterThan(0)
    } finally {
      clickSpy.mockRestore()
    }
  })
})
