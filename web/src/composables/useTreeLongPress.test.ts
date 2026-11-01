import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useTreeLongPress, LONG_PRESS_MS, LONG_PRESS_CANCEL_PX } from './useTreeLongPress'

// jsdom 无 PointerEvent 构造器（实现只读 pointerType/clientX/clientY 三个面），
// 用 Event 基底补齐字段按 PointerEvent 断言——构造差异不属于被测契约
function pointerEvt(type: string, opts: { pointerType?: string; x?: number; y?: number } = {}): PointerEvent {
  const e = new Event(type, { bubbles: true, cancelable: true })
  return Object.assign(e, { pointerType: opts.pointerType ?? 'touch', clientX: opts.x ?? 0, clientY: opts.y ?? 0 }) as PointerEvent
}

describe('useTreeLongPress', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('touch 指针按住满时长触发回调（事件与行载荷原样回传）与震动反馈', () => {
    const vibrate = vi.fn()
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true })
    const onLongPress = vi.fn()
    const { onPointerDown } = useTreeLongPress<string>(onLongPress)

    onPointerDown(pointerEvt('pointerdown', { x: 40, y: 60 }), 'docs/notes.md')
    vi.advanceTimersByTime(LONG_PRESS_MS - 1)
    expect(onLongPress).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onLongPress).toHaveBeenCalledTimes(1)
    expect(onLongPress).toHaveBeenCalledWith(expect.objectContaining({ clientX: 40, clientY: 60 }), 'docs/notes.md')
    expect(vibrate).toHaveBeenCalledWith(15)
  })

  it('无 vibrate 能力（iOS Safari 等）静默降级不抛错', () => {
    Object.defineProperty(navigator, 'vibrate', { value: undefined, configurable: true })
    const onLongPress = vi.fn()
    const { onPointerDown } = useTreeLongPress<string>(onLongPress)
    expect(() => {
      onPointerDown(pointerEvt('pointerdown'), '')
      vi.advanceTimersByTime(LONG_PRESS_MS)
    }).not.toThrow()
    expect(onLongPress).toHaveBeenCalledTimes(1)
  })

  it('非 touch 指针（鼠标）不参与长按', () => {
    const onLongPress = vi.fn()
    const { onPointerDown } = useTreeLongPress<string>(onLongPress)
    onPointerDown(pointerEvt('pointerdown', { pointerType: 'mouse' }), '')
    vi.advanceTimersByTime(LONG_PRESS_MS * 3)
    expect(onLongPress).not.toHaveBeenCalled()
  })

  it('移动超阈值取消（滚动/拖拽不误触发），小幅抖动不取消', () => {
    const onLongPress = vi.fn()
    const { onPointerDown } = useTreeLongPress<string>(onLongPress)
    // window 收听：派发冒泡到 window 的 move
    const move = (x: number, y: number) => window.dispatchEvent(pointerEvt('pointermove', { x, y }))

    onPointerDown(pointerEvt('pointerdown', { x: 100, y: 100 }), '')
    move(100 + LONG_PRESS_CANCEL_PX - 1, 100)
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(onLongPress).toHaveBeenCalledTimes(1)

    onLongPress.mockClear()
    onPointerDown(pointerEvt('pointerdown', { x: 100, y: 100 }), '')
    move(100 + LONG_PRESS_CANCEL_PX + 1, 100)
    vi.advanceTimersByTime(LONG_PRESS_MS * 2)
    expect(onLongPress).not.toHaveBeenCalled()
  })

  it('提前抬手（pointerup）与滚动接管（pointercancel）取消', () => {
    const onLongPress = vi.fn()
    const { onPointerDown } = useTreeLongPress<string>(onLongPress)

    onPointerDown(pointerEvt('pointerdown'), '')
    window.dispatchEvent(pointerEvt('pointerup'))
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(onLongPress).not.toHaveBeenCalled()

    onPointerDown(pointerEvt('pointerdown'), '')
    window.dispatchEvent(pointerEvt('pointercancel'))
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(onLongPress).not.toHaveBeenCalled()
  })

  it('补发 click 吞咽：触发后消费一次，新手势开始即作废遗留义务', () => {
    const onLongPress = vi.fn()
    const { onPointerDown, consumeClickIfFromLongPress } = useTreeLongPress<string>(onLongPress)

    expect(consumeClickIfFromLongPress()).toBe(false)
    onPointerDown(pointerEvt('pointerdown'), '')
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(consumeClickIfFromLongPress()).toBe(true)
    expect(consumeClickIfFromLongPress()).toBe(false) // 只吞一次

    // 长按后抬手未产生 click 的场景（pointercancel）：遗留吞咽义务在新手势
    // pointerdown 时作废，不误吞下一次正常点按
    onPointerDown(pointerEvt('pointerdown'), '')
    window.dispatchEvent(pointerEvt('pointercancel'))
    expect(consumeClickIfFromLongPress()).toBe(false)
  })
})
