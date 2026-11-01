import { describe, expect, it, vi } from 'vitest'
import { forceTerminalScrollResync } from './terminalScrollResync'

interface FakeTermOpts {
  clientWidth?: number
  clientHeight?: number
  rows?: number
  hasElement?: boolean
}

function fakeTerm(opts: FakeTermOpts = {}) {
  const { clientWidth = 800, clientHeight = 400, rows = 24, hasElement = true } = opts
  return {
    element: hasElement ? ({ clientWidth, clientHeight } as HTMLElement) : undefined,
    cols: 80,
    rows,
    resize: vi.fn(),
  }
}

describe('forceTerminalScrollResync', () => {
  it('有布局盒时行数抖动 resize（rows-1 → rows，终态尺寸不变）', () => {
    const term = fakeTerm()
    forceTerminalScrollResync(term)
    expect(term.resize).toHaveBeenCalledTimes(2)
    expect(term.resize).toHaveBeenNthCalledWith(1, 80, 23)
    expect(term.resize).toHaveBeenNthCalledWith(2, 80, 24)
  })

  it('容器无布局盒（隐藏期量测为 0）跳过——零尺寸重测只会写深坏态', () => {
    const zeroW = fakeTerm({ clientWidth: 0 })
    forceTerminalScrollResync(zeroW)
    expect(zeroW.resize).not.toHaveBeenCalled()
    const zeroH = fakeTerm({ clientHeight: 0 })
    forceTerminalScrollResync(zeroH)
    expect(zeroH.resize).not.toHaveBeenCalled()
  })

  it('element 缺失跳过', () => {
    const term = fakeTerm({ hasElement: false })
    forceTerminalScrollResync(term)
    expect(term.resize).not.toHaveBeenCalled()
  })

  it('极小 pane（rows < 4）跳过——抖不动，空转无意义', () => {
    const term = fakeTerm({ rows: 3 })
    forceTerminalScrollResync(term)
    expect(term.resize).not.toHaveBeenCalled()
  })

  it('resize 抛错静默吞掉（自愈手段不产生新错误面）', () => {
    const term = fakeTerm()
    term.resize.mockImplementation(() => { throw new Error('resize boom') })
    expect(() => forceTerminalScrollResync(term)).not.toThrow()
  })
})
