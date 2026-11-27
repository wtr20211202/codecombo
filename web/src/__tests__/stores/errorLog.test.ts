import { describe, expect, it, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useErrorLogStore } from '@/stores/errorLog'
import { buildBrowserDiagnosticsPayload, clearBrowserDiagnostics } from '@/utils/browserDiagnostics'

describe('errorLog store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    clearBrowserDiagnostics()
  })

  it('starts empty', () => {
    const s = useErrorLogStore()
    expect(s.logs).toHaveLength(0)
    expect(s.unreadCount).toBe(0)
  })

  it('add() prepends entry with id/timestamp', () => {
    const s = useErrorLogStore()
    const e = s.add({
      category: 'auth', method: 'POST', url: '/login',
      status: 401, rawMessage: 'x', userMessage: 'y',
    })
    expect(e.id).toBeTruthy()
    expect(e.timestamp).toBeTruthy()
    expect(s.logs).toHaveLength(1)
    expect(s.logs[0].id).toBe(e.id)
  })

  it('add() increments unreadCount', () => {
    const s = useErrorLogStore()
    s.add({ category: 'auth', method: 'POST', url: '/a', status: 401, rawMessage: '', userMessage: '' })
    s.add({ category: 'auth', method: 'POST', url: '/b', status: 401, rawMessage: '', userMessage: '' })
    expect(s.unreadCount).toBe(2)
  })

  it('markAllRead() resets unreadCount only', () => {
    const s = useErrorLogStore()
    s.add({ category: 'auth', method: 'POST', url: '/a', status: 401, rawMessage: '', userMessage: '' })
    s.markAllRead()
    expect(s.unreadCount).toBe(0)
    expect(s.logs).toHaveLength(1)
  })

  // 原地重试成功标记（P-20261003-179）：就地补 recoveredAt，不动顺序/未读数
  it('markRecovered() stamps the target entry in place', () => {
    const s = useErrorLogStore()
    const first = s.add({ category: 'network', method: 'GET', url: '/a', status: 0, rawMessage: '', userMessage: '' })
    const second = s.add({ category: 'server', method: 'GET', url: '/b', status: 500, rawMessage: '', userMessage: '' })
    const unreadBefore = s.unreadCount

    s.markRecovered(first.id)

    expect(first.recoveredAt).toBeTruthy()
    expect(second.recoveredAt).toBeUndefined()
    expect(s.logs[1].id).toBe(first.id) // 顺序不动：重试的是先入账的条目
    expect(s.unreadCount).toBe(unreadBefore)
  })

  it('markRecovered() ignores unknown ids', () => {
    const s = useErrorLogStore()
    const e = s.add({ category: 'network', method: 'GET', url: '/a', status: 0, rawMessage: '', userMessage: '' })
    s.markRecovered('no-such-id')
    expect(e.recoveredAt).toBeUndefined()
  })

  it('clear() empties both', () => {
    const s = useErrorLogStore()
    s.add({ category: 'auth', method: 'POST', url: '/a', status: 401, rawMessage: '', userMessage: '' })
    s.clear()
    expect(s.logs).toHaveLength(0)
    expect(s.unreadCount).toBe(0)
  })

  it('MAX_ENTRIES=200 with FIFO eviction', () => {
    const s = useErrorLogStore()
    for (let i = 0; i < 205; i++) {
      s.add({ category: 'auth', method: 'POST', url: `/x${i}`, status: 401, rawMessage: '', userMessage: '' })
    }
    expect(s.logs).toHaveLength(200)
    expect(s.logs[0].url).toBe('/x204')
    expect(s.logs[199].url).toBe('/x5')
  })

  // 浏览器诊断投影（P-20261124-2 S1a②）：错误中心条目同步进诊断环，字段白名单
  // + URL 模板化；rawMessage/query 参数不出现
  it('add() 投影进浏览器诊断环（白名单/模板化；clear 同步清环）', () => {
    const s = useErrorLogStore()
    s.add({
      category: 'network',
      method: 'GET',
      url: '/api/share/SENTINEL_TOKEN_1/messages?path=/home/alice/secret',
      status: 0,
      rawMessage: 'RAW_SENTINEL /home/alice/secret',
      userMessage: '网络连接异常，请检查服务是否启动',
      requestId: 'sc-rid-x',
      errorClass: 'timeout',
      durationMs: 1234,
      silent: true,
      timedOut: false,
      clientTimeoutMs: 0,
    })
    const [entry] = buildBrowserDiagnosticsPayload().entries
    expect(entry.kind).toBe('request')
    expect(entry.path).toBe('/api/share/:token/messages')
    expect(entry.message).toBe('网络连接异常，请检查服务是否启动')
    expect(entry.requestId).toBe('sc-rid-x')
    expect(entry.durationMs).toBe(1234)
    expect(entry.clientTimeoutMs).toBe(0)
    expect(entry.silent).toBe(true)
    const json = JSON.stringify(entry)
    expect(json).not.toContain('SENTINEL_TOKEN_1')
    expect(json).not.toContain('RAW_SENTINEL')
    expect(json).not.toContain('alice')

    s.clear()
    expect(buildBrowserDiagnosticsPayload().entries).toHaveLength(0)
  })
})
