import { ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAgentTerminalFloat } from './useAgentTerminalFloat'

// 悬浮窗几何持久化（P-20261003-245 迁 safeStorage 写入通道）：
// 拖拽/缩放松开发生在 window pointerup 事件链内，裸 localStorage 写在
// 配额满（~5MB）/隐私模式下抛错会炸同事件上的其余处理器——迁移后
// safeStorage 吞错降级，主流程（几何态收敛 + 监听摘除）不受影响。
// 用真实 safeStorage（jsdom localStorage 可用）走全真事件链，仅在
// 配额用例对 window.localStorage.setItem 注入 QuotaExceededError。
const FLOAT_POS_KEY = 'sc.agentTerminal.pos'
const FLOAT_SIZE_KEY = 'sc.agentTerminal.size'

/** jsdom 无 PointerEvent 构造器：pointer 事件链用 MouseEvent 等价驱动
 * （composable 只消费 button/clientX/clientY，事件类型名即路由依据） */
function pointer(type: string, x: number, y: number): PointerEvent {
  return new MouseEvent(type, { button: 0, clientX: x, clientY: y }) as unknown as PointerEvent
}

/** 拖一把：按住 (100,100) → 移动 Δ(50,40) → 松开（初始位 {0,0} → 终点位 {50,40}，
 *  均在 jsdom 视口钳制界内不触发 clamp） */
function drag(f: ReturnType<typeof useAgentTerminalFloat>): void {
  f.onHeaderPointerDown(pointer('pointerdown', 100, 100))
  window.dispatchEvent(pointer('pointermove', 150, 140))
  window.dispatchEvent(pointer('pointerup', 150, 140))
}

/** 缩放一次：se 手柄按住 (800,500) → 拉到 (840,540) → 松开（尺寸 720×480 → 760×520） */
function resize(f: ReturnType<typeof useAgentTerminalFloat>): void {
  f.onFloatResizeDown('se', pointer('pointerdown', 800, 500))
  window.dispatchEvent(pointer('pointermove', 840, 540))
  window.dispatchEvent(pointer('pointerup', 840, 540))
}

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('useAgentTerminalFloat 几何持久化（safeStorage 写入通道）', () => {
  it('拖拽松开持久化位置（真实 localStorage 写入读回）', () => {
    const f = useAgentTerminalFloat({ isFloat: ref(true) })
    drag(f)
    expect(f.floatPos.value).toEqual({ x: 50, y: 40 })
    expect(JSON.parse(localStorage.getItem(FLOAT_POS_KEY) || 'null')).toEqual({ x: 50, y: 40 })
  })

  it('缩放松开持久化尺寸', () => {
    const f = useAgentTerminalFloat({ isFloat: ref(true) })
    resize(f)
    expect(f.floatSize.value).toEqual({ w: 760, h: 520 })
    expect(JSON.parse(localStorage.getItem(FLOAT_SIZE_KEY) || 'null')).toEqual({ w: 760, h: 520 })
  })

  it('重挂载 loadFloatGeometry 恢复上次持久化几何（写入读回闭环）', () => {
    const f1 = useAgentTerminalFloat({ isFloat: ref(true) })
    drag(f1)
    const f2 = useAgentTerminalFloat({ isFloat: ref(true) })
    f2.loadFloatGeometry()
    expect(f2.floatPos.value).toEqual({ x: 50, y: 40 })
  })

  it('配额满（QuotaExceededError）拖拽链不抛异常：位置照常收敛、写入调用照常发出', () => {
    const spy = vi.spyOn(window.localStorage, 'setItem')
      .mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError') })
    const f = useAgentTerminalFloat({ isFloat: ref(true) })
    expect(() => drag(f)).not.toThrow()
    // 主流程继续：几何态照常收敛（持久化失败只是损失记忆，不炸 pointerup 事件链）
    expect(f.floatPos.value).toEqual({ x: 50, y: 40 })
    expect(spy).toHaveBeenCalledWith(FLOAT_POS_KEY, JSON.stringify({ x: 50, y: 40 }))
  })

  it('配额满时缩放链同样不抛异常、尺寸照常更新', () => {
    vi.spyOn(window.localStorage, 'setItem')
      .mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError') })
    const f = useAgentTerminalFloat({ isFloat: ref(true) })
    expect(() => resize(f)).not.toThrow()
    expect(f.floatSize.value).toEqual({ w: 760, h: 520 })
  })
})
