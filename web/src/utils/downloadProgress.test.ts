import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDownloadProgressTracker } from './downloadProgress'
import type { MessageApiInjection } from 'naive-ui/es/message/src/MessageProvider'

// naive MessageReactive 的最小面：content 可赋值 + destroy 可调
function stubMessage() {
  const state = { content: null as (() => unknown) | null, destroyed: 0 }
  const message = {
    loading: vi.fn((render: () => unknown) => {
      state.content = render
      return {
        set content(fn: () => unknown) { state.content = fn },
        destroy() { state.destroyed++ },
      }
    }),
  } as unknown as MessageApiInjection & { loading: ReturnType<typeof vi.fn> }
  return { message, state }
}

// 渲染产物是 h('span', …, text) 的 VNode，children 即正文文本
function bodyText(state: { content: (() => unknown) | null }): string {
  return String((state.content?.() as { children?: unknown })?.children ?? '')
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('createDownloadProgressTracker', () => {
  it('首帧起驻留 loading toast（duration 0）', () => {
    const { message, state } = stubMessage()
    const t = createDownloadProgressTracker(message, '导出中')
    expect(message.loading).toHaveBeenCalledTimes(1)
    expect(bodyText(state)).toContain('导出中')
    t.settle()
    expect(state.destroyed).toBe(1)
  })

  it('total 可知：显示百分比；150ms 节流内不重渲染', () => {
    vi.useFakeTimers()
    const { message, state } = stubMessage()
    const t = createDownloadProgressTracker(message, '导出中')
    const now = Date.now()
    vi.setSystemTime(now)
    t.onProgress({ loaded: 250_000_000, total: 1_000_000_000 } as never)
    expect(bodyText(state)).toContain('25%')

    // 节流窗内的后续事件不触发 content 更新
    const before = state.content
    vi.setSystemTime(now + 50)
    t.onProgress({ loaded: 500_000_000, total: 1_000_000_000 } as never)
    expect(state.content).toBe(before)

    // 出窗后按最新进度重渲染
    vi.setSystemTime(now + 200)
    t.onProgress({ loaded: 500_000_000, total: 1_000_000_000 } as never)
    expect(bodyText(state)).toContain('50%')
    t.settle()
  })

  it('chunked 无 total：降级为已接收量（formatBytes）+ 速率', () => {
    vi.useFakeTimers()
    const { message, state } = stubMessage()
    const t = createDownloadProgressTracker(message, '导出中')
    const now = Date.now()
    vi.setSystemTime(now)
    t.onProgress({ loaded: 0, total: 0 } as never)
    vi.setSystemTime(now + 1000)
    t.onProgress({ loaded: 2_097_152, total: 0 } as never)
    const body = bodyText(state)
    expect(body).toContain('2.0 MB')
    expect(body).toContain('2.0 MB/s')
    expect(body).not.toContain('%')
    t.settle()
  })

  it('settle 幂等：双路径收尾只销毁一次，销毁后 onProgress 不再赋 content', () => {
    const { message, state } = stubMessage()
    const t = createDownloadProgressTracker(message, 'x')
    t.settle()
    expect(() => t.settle()).not.toThrow()
    expect(state.destroyed).toBe(1)
    expect(message.loading).toHaveBeenCalledTimes(1)
    expect(() => t.onProgress({ loaded: 10, total: 100 } as never)).not.toThrow()
    expect(state.destroyed).toBe(1)
  })
})
