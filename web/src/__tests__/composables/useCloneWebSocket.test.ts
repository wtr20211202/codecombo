import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import i18n from '@/i18n'
import { getUnlockToken, setUnlockToken } from '@/stores/lock'
import {
  parseCloneProgress,
  getCloneWSUrl,
  getCloneWSProtocols,
  connectCloneWS,
  waitForCloneDone,
  CLONE_WS_MAX_RETRIES,
  CLONE_WS_RETRY_DELAY,
} from '@/composables/useCloneWebSocket'

// Mock WebSocket：构造时记录 url/protocols，回调由测试代码触发
class MockWebSocket {
  static instances: MockWebSocket[] = []
  url: string
  protocols: string | string[] | undefined
  readyState = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  close = vi.fn(() => {
    this.readyState = 3
  })

  constructor(url: string, protocols?: string | string[]) {
    this.url = url
    this.protocols = protocols
    MockWebSocket.instances.push(this)
  }
}

describe('useCloneWebSocket', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    // @ts-expect-error: 替换全局 WebSocket 供测试
    globalThis.WebSocket = MockWebSocket
    localStorage.clear()
    // P-20261019-2 起令牌载体是内存态 + HttpOnly cookie：单测注入内存态
    setUnlockToken(null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('parseCloneProgress', () => {
    it('解析 "Receiving objects:  45%" 为 45', () => {
      expect(parseCloneProgress('Receiving objects:  45%')).toBe(45)
    })

    it('解析 "Compressing:  20%" 为 20', () => {
      expect(parseCloneProgress('Compressing:  20%')).toBe(20)
    })

    it('无百分比返回 null', () => {
      expect(parseCloneProgress('Counting objects')).toBeNull()
    })

    it('多个百分比只取第一个', () => {
      expect(parseCloneProgress('Progress: 30% / 100%')).toBe(30)
    })
  })

  describe('getCloneWSUrl', () => {
    it('jsdom 默认 http 协议拼 ws://（host 由 setup.ts 配置）', () => {
      // 只断言关键部分：协议 ws:// + 路径 /ws/clone/<id>，避免绑死 host
      const url = getCloneWSUrl('task-123')
      expect(url).toMatch(/^ws:\/\//)
      expect(url).toContain('/ws/clone/task-123')
    })
  })

  describe('getCloneWSProtocols', () => {
    it('内存态有 token 返回 [token]', () => {
      setUnlockToken('scl_test_token_abc')
      expect(getCloneWSProtocols()).toEqual(['scl_test_token_abc'])
    })

    it('内存态无 token 返回 undefined（握手靠 HttpOnly cookie 兜底）', () => {
      expect(getCloneWSProtocols()).toBeUndefined()
    })
  })

  describe('connectCloneWS', () => {
    it('构造 WebSocket 时携带 unlock token 子协议', () => {
      setUnlockToken('scl_xyz')
      connectCloneWS('task-1', {})
      const inst = MockWebSocket.instances[0]
      expect(inst.url).toContain('/ws/clone/task-1')
      expect(inst.protocols).toEqual(['scl_xyz'])
    })

    it('无 token 时不传 protocols（仍允许连接，由后端决定是否拒绝）', () => {
      connectCloneWS('task-2', {})
      const inst = MockWebSocket.instances[0]
      expect(inst.protocols).toBeUndefined()
    })

    it('收到 progress 消息时调用 onProgress（含解析后的百分比）', () => {
      const onProgress = vi.fn()
      connectCloneWS('task-3', { onProgress })
      const inst = MockWebSocket.instances[0]
      inst.onmessage!({ data: JSON.stringify({ type: 'progress', line: 'Receiving objects:  45%' }) } as MessageEvent)
      expect(onProgress).toHaveBeenCalledWith('Receiving objects:  45%', 45)
    })

    it('收到 progress 但无百分比时 percent=null', () => {
      const onProgress = vi.fn()
      connectCloneWS('task-4', { onProgress })
      const inst = MockWebSocket.instances[0]
      inst.onmessage!({ data: JSON.stringify({ type: 'progress', line: 'Counting objects' }) } as MessageEvent)
      expect(onProgress).toHaveBeenCalledWith('Counting objects', null)
    })

    it('收到 done 消息时调用 onDone 并传 status + result', () => {
      const onDone = vi.fn()
      connectCloneWS('task-5', { onDone })
      const inst = MockWebSocket.instances[0]
      const result = { projectId: 'p1', path: '/x' }
      inst.onmessage!({
        data: JSON.stringify({ type: 'done', status: 'success', result }),
      } as MessageEvent)
      expect(onDone).toHaveBeenCalledWith('success', result)
    })

    it('收到非法 JSON 不抛错（静默忽略）', () => {
      const onProgress = vi.fn()
      const onDone = vi.fn()
      connectCloneWS('task-6', { onProgress, onDone })
      const inst = MockWebSocket.instances[0]
      expect(() =>
        inst.onmessage!({ data: 'not-json' } as MessageEvent),
      ).not.toThrow()
      expect(onProgress).not.toHaveBeenCalled()
      expect(onDone).not.toHaveBeenCalled()
    })

    it('onerror 触发 onError 回调', () => {
      const onError = vi.fn()
      connectCloneWS('task-7', { onError })
      const inst = MockWebSocket.instances[0]
      inst.onerror!()
      expect(onError).toHaveBeenCalledTimes(1)
    })
  })

  describe('waitForCloneDone', () => {
    it('收到 success done 时 resolve', async () => {
      const p = waitForCloneDone('task-ok')
      const inst = MockWebSocket.instances[0]
      inst.onmessage!({
        data: JSON.stringify({ type: 'done', status: 'success', result: null }),
      } as MessageEvent)
      await expect(p).resolves.toBeUndefined()
      expect(inst.close).toHaveBeenCalled()
    })

    it('收到 failed done 时 reject 并带 result.error', async () => {
      const p = waitForCloneDone('task-fail')
      const inst = MockWebSocket.instances[0]
      inst.onmessage!({
        data: JSON.stringify({
          type: 'done',
          status: 'failed',
          result: { error: 'exit status 128' },
        }),
      } as MessageEvent)
      await expect(p).rejects.toThrow('exit status 128')
    })

    it('done 缺 error 时用 status reject', async () => {
      const p = waitForCloneDone('task-canceled')
      const inst = MockWebSocket.instances[0]
      inst.onmessage!({
        data: JSON.stringify({ type: 'done', status: 'canceled', result: null }),
      } as MessageEvent)
      await expect(p).rejects.toThrow('canceled')
    })

    it('onerror 不直接收尾：等待 onclose 统一处理（重试或报错）', async () => {
      vi.useFakeTimers()
      const p = waitForCloneDone('task-err')
      const inst = MockWebSocket.instances[0]
      inst.onerror!()
      // onerror 后 Promise 保持 pending，由 onclose 决定重试
      let settled = false
      p.catch(() => { settled = true })
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toBe(false)
      vi.useRealTimers()
    })

    it('WS 异常 close 后自动重连，重连成功收到 done 则 resolve', async () => {
      vi.useFakeTimers()
      const p = waitForCloneDone('task-retry')
      // 第一次连接异常断开
      MockWebSocket.instances[0].onclose!({ code: 1006 } as CloseEvent)
      await vi.advanceTimersByTimeAsync(CLONE_WS_RETRY_DELAY)
      // 重连产生第二个连接实例，服务端补发快照后送达 done
      expect(MockWebSocket.instances.length).toBe(2)
      MockWebSocket.instances[1].onmessage!({
        data: JSON.stringify({ type: 'done', status: 'success', result: null }),
      } as MessageEvent)
      await expect(p).resolves.toBeUndefined()
      vi.useRealTimers()
    })

    it('连续断线超过重试上限后 reject "websocket closed"', async () => {
      vi.useFakeTimers()
      const p = waitForCloneDone('task-dead')
      // reject 发生在循环内（重试耗尽时）：先挂兜底 handler，避免 await
      // 检查点把尚未断言的 rejection 判为 unhandled
      p.catch(() => {})
      for (let i = 0; i <= CLONE_WS_MAX_RETRIES; i++) {
        const inst = MockWebSocket.instances[i]
        inst.onclose!({ code: 1006 } as CloseEvent)
        await vi.advanceTimersByTimeAsync(CLONE_WS_RETRY_DELAY)
      }
      await expect(p).rejects.toThrow('websocket closed')
      vi.useRealTimers()
    })

    it('close 4001（锁定拒绝）时清 token 并 reject 锁定文案，不再重试', async () => {
      vi.useFakeTimers()
      setUnlockToken('scl_stale')
      const p = waitForCloneDone('task-locked')
      MockWebSocket.instances[0].onclose!({ code: 4001 } as CloseEvent)
      await expect(p).rejects.toThrow(i18n.global.t('errors.lockedWs'))
      // applyLockRejection 清掉了失效 token（供锁定屏接管）
      expect(getUnlockToken()).toBeNull()
      // 不产生第二个连接（重试被终止）
      expect(MockWebSocket.instances.length).toBe(1)
      vi.useRealTimers()
    })

    it('done 后 cleanup 把 onclose/onerror 置 null，避免回调泄漏', async () => {
      const p = waitForCloneDone('task-settled')
      const inst = MockWebSocket.instances[0]
      inst.onmessage!({
        data: JSON.stringify({ type: 'done', status: 'success', result: null }),
      } as MessageEvent)
      await expect(p).resolves.toBeUndefined()
      // cleanup 后回调应已解绑
      expect(inst.onclose).toBeNull()
      expect(inst.onerror).toBeNull()
      expect(inst.onmessage).toBeNull()
    })
  })
})
