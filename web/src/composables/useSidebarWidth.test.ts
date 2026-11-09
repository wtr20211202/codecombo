import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSidebarWidth } from './useSidebarWidth'

// 通用侧栏宽度 resizer（P-20261106-5 自 useAgentTerminalSidebarWidth 泛化）：
// 拖拽/键盘/复位的宽度记忆全走 safeStorage（真实 localStorage 读回闭环）。
// jsdom PointerEvent 缺失：pointer 事件链用 MouseEvent 等价驱动（composable
// 只消费 button/clientX，与 useAgentTerminalFloat.test.ts 同款手法）。
const KEY = 'sc.test.sidebarWidth'

function pointer(type: string, x: number): PointerEvent {
  return new MouseEvent(type, { button: 0, clientX: x }) as unknown as PointerEvent
}

function make() {
  return useSidebarWidth({ storageKey: KEY, min: 200, max: 480, defaultWidth: 260 })
}

/** 拖一把：按住 x=500 → 移到 x=640 → 松开（260 + 140 = 400） */
function drag(f: ReturnType<typeof make>): void {
  f.onResizeDown(pointer('pointerdown', 500))
  window.dispatchEvent(pointer('pointermove', 640))
  window.dispatchEvent(pointer('pointerup', 640))
}

// 拖拽入口经 layoutLock.interceptDrag（布局锁定短路），需激活 pinia
beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('useSidebarWidth（拖拽 + 宽度记忆 + 钳制 + 复位/微调）', () => {
  it('拖拽松开持久化宽度（真实 localStorage 写入读回）', () => {
    const f = make()
    drag(f)
    expect(f.width.value).toBe(400)
    expect(localStorage.getItem(KEY)).toBe('400')
  })

  it('拖拽超出钳制界收在 max（左拖收在 min）', () => {
    const f = make()
    f.onResizeDown(pointer('pointerdown', 500))
    window.dispatchEvent(pointer('pointermove', 900))
    window.dispatchEvent(pointer('pointerup', 900))
    expect(f.width.value).toBe(480)
    f.onResizeDown(pointer('pointerdown', 500))
    window.dispatchEvent(pointer('pointermove', 100))
    window.dispatchEvent(pointer('pointerup', 100))
    expect(f.width.value).toBe(200)
    expect(localStorage.getItem(KEY)).toBe('200')
  })

  it('load 恢复持久化宽度并对越界存量值钳制（旧数据面兼容）', () => {
    localStorage.setItem(KEY, '380')
    const f = make()
    f.load()
    expect(f.width.value).toBe(380)
    localStorage.setItem(KEY, '50')
    const g = make()
    g.load()
    expect(g.width.value).toBe(200)
  })

  it('nudge 步进即落盘；已达边界时静默不动不重复写', () => {
    const f = make()
    f.nudge(16)
    expect(f.width.value).toBe(276)
    expect(localStorage.getItem(KEY)).toBe('276')
    f.width.value = 480
    const spy = vi.spyOn(window.localStorage, 'setItem')
    f.nudge(16)
    expect(f.width.value).toBe(480)
    expect(spy).not.toHaveBeenCalled()
  })

  it('resetToDefault 恢复默认宽度并落盘', () => {
    const f = make()
    drag(f)
    expect(f.width.value).toBe(400)
    f.resetToDefault()
    expect(f.width.value).toBe(260)
    expect(localStorage.getItem(KEY)).toBe('260')
  })

  it('非左键 pointerdown 不启动拖拽', () => {
    const f = make()
    const right = new MouseEvent('pointerdown', { button: 2, clientX: 500 }) as unknown as PointerEvent
    f.onResizeDown(right)
    window.dispatchEvent(pointer('pointermove', 700))
    expect(f.width.value).toBe(260)
  })
})
