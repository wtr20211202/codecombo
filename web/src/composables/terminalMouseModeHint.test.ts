import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import {
  attachMouseModeTracking,
  detachMouseModeTracking,
  isMouseModeHintDismissed,
  isMouseReporting,
  dismissMouseModeHintForever,
  resetMouseModeHintDismissed,
  resetMouseModeTracking,
  MOUSE_MODE_HINT_DISMISS_KEY,
} from './terminalMouseModeHint'

// CSI handler 旁观测试（P-20261106-6）：用桩 parser 捕获注册的 handler，
// 直接以参数序列调用验证记账与透传约定（xterm 约定 handler 返回 true 消费
// 序列 / false 交回默认链——本实现必须恒 false，协议语义不动）
type CsiCallback = (params: (number | number[])[]) => boolean | Promise<boolean>

function makeTermStub(): { term: Terminal; handlers: Map<string, CsiCallback> } {
  const handlers = new Map<string, CsiCallback>()
  const term = {
    parser: {
      registerCsiHandler: vi.fn((id: { prefix?: string; final: string }, cb: CsiCallback) => {
        handlers.set(`${id.prefix ?? ''}${id.final}`, cb)
        return { dispose: () => handlers.delete(`${id.prefix ?? ''}${id.final}`) }
      }),
    },
  } as unknown as Terminal
  return { term, handlers }
}

beforeEach(() => {
  window.localStorage.removeItem(MOUSE_MODE_HINT_DISMISS_KEY)
})

afterEach(() => {
  window.localStorage.removeItem(MOUSE_MODE_HINT_DISMISS_KEY)
})

describe('鼠标上报模式追踪', () => {
  it('DECSET 1000 开启 → isMouseReporting 为真，handler 返回 false 透传', () => {
    const { term, handlers } = makeTermStub()
    attachMouseModeTracking('s1', term)

    const decset = handlers.get('?h')!
    const result = decset([1000])
    expect(result).toBe(false) // 透传：不消费序列，xterm 默认处理照常
    expect(isMouseReporting('s1')).toBe(true)
  })

  it('1002/1003 同样触发；非鼠标模式（1004 焦点上报/1006 扩展坐标）不触发', () => {
    const { term, handlers } = makeTermStub()
    attachMouseModeTracking('s1', term)
    const decset = handlers.get('?h')!
    const decrst = handlers.get('?l')!

    decset([1002])
    expect(isMouseReporting('s1')).toBe(true)
    decrst([1002])
    expect(isMouseReporting('s1')).toBe(false)
    decset([1003])
    expect(isMouseReporting('s1')).toBe(true)
    decrst([1003])
    expect(isMouseReporting('s1')).toBe(false)

    decset([1004])
    decset([1006])
    expect(isMouseReporting('s1')).toBe(false)
  })

  it('多模式同发（?1000;1006h）逐个识别；DECRST 只摘命中的模式', () => {
    const { term, handlers } = makeTermStub()
    attachMouseModeTracking('s1', term)
    const decset = handlers.get('?h')!
    const decrst = handlers.get('?l')!

    decset([1000, 1006])
    expect(isMouseReporting('s1')).toBe(true)
    decrst([1000, 1006])
    expect(isMouseReporting('s1')).toBe(false)
  })

  it('term.reset 重连软清零后，重放流仍可经 handler 重新记账（条目不删）', () => {
    const { term, handlers } = makeTermStub()
    attachMouseModeTracking('s1', term)
    handlers.get('?h')!([1000])
    expect(isMouseReporting('s1')).toBe(true)

    resetMouseModeTracking('s1')
    expect(isMouseReporting('s1')).toBe(false)

    // 重放携带的 DECSET（条目仍在，handler 记账生效）
    handlers.get('?h')!([1002])
    expect(isMouseReporting('s1')).toBe(true)
  })

  it('detach 硬清理后 handler 记账失效（防跨重挂残留）', () => {
    const { term, handlers } = makeTermStub()
    attachMouseModeTracking('s1', term)
    handlers.get('?h')!([1000])
    expect(isMouseReporting('s1')).toBe(true)

    detachMouseModeTracking('s1')
    expect(isMouseReporting('s1')).toBe(false)
    handlers.get('?h')!([1000])
    expect(isMouseReporting('s1')).toBe(false)
  })
})

describe('「不再提示」持久化', () => {
  it('默认显示（键缺省）；写入后 dismissed 为真；重置恢复显示', () => {
    expect(isMouseModeHintDismissed()).toBe(false)
    dismissMouseModeHintForever()
    expect(window.localStorage.getItem(MOUSE_MODE_HINT_DISMISS_KEY)).toBe('1')
    expect(isMouseModeHintDismissed()).toBe(true)
    // 设置页重置入口：存储与反应式镜像同步复位（已挂载 pane 即时恢复显示）
    resetMouseModeHintDismissed()
    expect(window.localStorage.getItem(MOUSE_MODE_HINT_DISMISS_KEY)).toBeNull()
    expect(isMouseModeHintDismissed()).toBe(false)
  })
})
