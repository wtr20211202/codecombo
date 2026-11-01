import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import { useWebSocketBase, WS_LONG_BACKOFF_DELAY_MS } from '@/composables/useWebSocketBase'
import { getUnlockToken, setUnlockToken, LOCK_REJECTED_CLOSE_CODE } from '@/stores/lock'

// Mock WebSocket：构造时不抛错，记录 url/protocols，readyState 默认 0
class MockWebSocket {
  static instances: MockWebSocket[] = []
  url: string
  protocols: string | string[] | undefined
  readyState = 0 // CONNECTING
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  close = vi.fn(() => {
    this.readyState = 3 // CLOSED
  })

  constructor(url: string, protocols?: string | string[]) {
    this.url = url
    this.protocols = protocols
    MockWebSocket.instances.push(this)
  }
}

describe('useWebSocketBase', () => {
  let scope: ReturnType<typeof effectScope>

  beforeEach(() => {
    MockWebSocket.instances = []
    // @ts-expect-error: 替换全局 WebSocket 供测试
    globalThis.WebSocket = MockWebSocket
    scope = effectScope()
  })

  afterEach(() => {
    scope.stop()
  })

  it('shouldConnect=false 时 connect 不创建 WebSocket', () => {
    const base = scope.run(() =>
      useWebSocketBase({
        getUrl: () => 'ws://test/abc',
        onMessage: () => {},
        shouldConnect: () => false,
      }),
    )!
    base.connect()
    expect(MockWebSocket.instances).toHaveLength(0)
    expect(base.connected.value).toBe(false)
  })

  it('shouldConnect=true 时 connect 正常建立连接', () => {
    const base = scope.run(() =>
      useWebSocketBase({
        getUrl: () => 'ws://test/abc',
        onMessage: () => {},
        shouldConnect: () => true,
      }),
    )!
    base.connect()
    expect(MockWebSocket.instances).toHaveLength(1)
  })

  it('onclose 时若 shouldConnect=false 不调度重连（核心防死循环测试）', () => {
    // 用 fake timers 控制重连定时器
    vi.useFakeTimers()
    try {
      let gate = true
      const base = scope.run(() =>
        useWebSocketBase({
          getUrl: () => 'ws://test/abc',
          onMessage: () => {},
          reconnectDelay: 1000,
          shouldConnect: () => gate,
        }),
      )!

      base.connect()
      expect(MockWebSocket.instances).toHaveLength(1)

      // 模拟锁定：先翻转门控，再触发 onclose（握手被中间件拒绝场景）
      gate = false
      MockWebSocket.instances[0].onclose?.({ code: 1006 } as CloseEvent)

      // 推进重连定时器：不应触发新连接
      vi.advanceTimersByTime(2000)
      expect(MockWebSocket.instances).toHaveLength(1)

      // 解锁：手动 connect 才恢复（模拟 watch(isLocked) 联动）
      gate = true
      base.connect()
      expect(MockWebSocket.instances).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shouldConnect 未提供时默认放行（向后兼容）', () => {
    const base = scope.run(() =>
      useWebSocketBase({
        getUrl: () => 'ws://test/abc',
        onMessage: () => {},
        // 不提供 shouldConnect
      }),
    )!
    base.connect()
    expect(MockWebSocket.instances).toHaveLength(1)
  })

  it('close 4001（锁定拒绝）时清 token 切锁定屏，且不调度重连', () => {
    setActivePinia(createPinia())
    setUnlockToken('scl_stale')
    vi.useFakeTimers()
    try {
      const base = scope.run(() =>
        useWebSocketBase({
          getUrl: () => 'ws://test/abc',
          onMessage: () => {},
          reconnectDelay: 1000,
          shouldConnect: () => true,
        }),
      )!
      base.connect()
      MockWebSocket.instances[0].onclose?.({ code: LOCK_REJECTED_CLOSE_CODE } as CloseEvent)

      // 失效 token 已清理（锁定屏接管，解锁 watch 负责重连）
      expect(getUnlockToken()).toBeNull()
      // 推进重连定时器：不得用旧 token 重连
      vi.advanceTimersByTime(5000)
      expect(MockWebSocket.instances).toHaveLength(1)
    } finally {
      setUnlockToken(null)
      vi.useRealTimers()
    }
  })

  it('close 1006（网络故障）时正常调度重连（与 4001 区分）', () => {
    vi.useFakeTimers()
    try {
      const base = scope.run(() =>
        useWebSocketBase({
          getUrl: () => 'ws://test/abc',
          onMessage: () => {},
          reconnectDelay: 1000,
        }),
      )!
      base.connect()
      MockWebSocket.instances[0].onclose?.({ code: 1006 } as CloseEvent)
      vi.advanceTimersByTime(1500)
      expect(MockWebSocket.instances).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  // P-20261005-185 关闭码分支表：onclose 的四类处置一张表钉死——
  // 4001 锁定（切锁定屏、永不重连）/ 1009·1011 长退避（不进常规指数退避、
  // 通知中心显式 error 条目、不调 onClose）/ 其他（1006 为代表）常规指数退避。
  // 4001 与 1006 另有上方独立用例，此处并入表格作单一事实源
  it('close code 分支表：4001 锁定 / 1009·1011 长退避+通知 / 其他常规退避', async () => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
    try {
      const { useNotificationStore } = await import('@/stores/notification')
      const cases = [
        { code: LOCK_REJECTED_CLOSE_CODE, kind: 'lock' },
        { code: 1009, kind: 'long' },
        { code: 1011, kind: 'long' },
        { code: 1006, kind: 'regular' },
      ] as const

      for (const { code, kind } of cases) {
        MockWebSocket.instances = []
        setUnlockToken('scl_t')
        const onClose = vi.fn()
        const base = scope.run(() =>
          useWebSocketBase({
            getUrl: () => `ws://test/case-${code}`,
            onMessage: () => {},
            reconnectDelay: 1000,
            onClose,
          }),
        )!
        base.connect()
        const notifiedBefore = useNotificationStore().items.length
        MockWebSocket.instances[0].onclose?.({ code } as CloseEvent)

        if (kind === 'lock') {
          // 锁定拒绝：token 清理 + 推进到长退避之外也不得重连（解锁 watch 负责）
          expect(getUnlockToken()).toBeNull()
          await vi.advanceTimersByTimeAsync(WS_LONG_BACKOFF_DELAY_MS + 5000)
          expect(MockWebSocket.instances, `code ${code}: 不得重连`).toHaveLength(1)
          expect(useNotificationStore().items.length).toBe(notifiedBefore)
        } else if (kind === 'long') {
          // 长退避：不调 onClose（断线计数不增）、常规退避窗口内不重连、
          // 60s 到点重连、通知中心恰好新增一条 error 条目
          expect(onClose, `code ${code}: 不应调 onClose`).not.toHaveBeenCalled()
          await vi.advanceTimersByTimeAsync(5000)
          expect(MockWebSocket.instances, `code ${code}: 常规窗口内不应重连`).toHaveLength(1)
          await vi.advanceTimersByTimeAsync(WS_LONG_BACKOFF_DELAY_MS)
          expect(MockWebSocket.instances, `code ${code}: 长退避到点应重连`).toHaveLength(2)
          const newItems = useNotificationStore().items.slice(0, useNotificationStore().items.length - notifiedBefore)
          expect(newItems).toHaveLength(1)
          expect(newItems[0].type).toBe('error')
          expect(newItems[0].category).toBe('system')
          expect(newItems[0].title.length).toBeGreaterThan(0)
        } else {
          // 常规退避：onClose 计数 + 指数退避照旧，且不发通知条目
          await vi.advanceTimersByTimeAsync(1500)
          expect(MockWebSocket.instances, `code ${code}: 应按常规退避重连`).toHaveLength(2)
          expect(onClose, `code ${code}: 应调 onClose 计数`).toHaveBeenCalledTimes(1)
          expect(useNotificationStore().items.length).toBe(notifiedBefore)
        }
      }
    } finally {
      setUnlockToken(null)
      vi.useRealTimers()
    }
  })
})
