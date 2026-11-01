import { describe, it, expect } from 'vitest'
import { attachTerminalKeyHandlers, type TerminalKeyHandlers } from '@/composables/useTerminalKeys'
import type { Terminal } from '@xterm/xterm'

// 终端域 xterm 拦截链（P-20261003-111）：单组合键位经 comboOf 读 keymap 生效表
// ——改绑后新键生效、旧键失效；区间键（Ctrl+Shift+1-9）与 Ctrl+C 选区复制副键位
// 保持硬编码。本测试用最小 xterm 桩捕获 customKeyEventHandler，断言按键裁决。

function keyEvent(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    ctrlKey: false, shiftKey: false, altKey: false, metaKey: false,
    ...init,
  } as KeyboardEventInit)
}

interface Harness {
  handle: (e: KeyboardEvent) => boolean
}

function attach(overrides: Partial<TerminalKeyHandlers> = {}, hasSelection = true): Harness {
  let captured: ((e: KeyboardEvent) => boolean) | null = null
  const term = {
    hasSelection: () => hasSelection,
    attachCustomKeyEventHandler: (fn: (e: KeyboardEvent) => boolean) => { captured = fn },
  } as unknown as Terminal
  attachTerminalKeyHandlers(term, {
    sessionId: 's1',
    onSearchOpen: () => {},
    onCopySelection: () => {},
    onPaste: () => {},
    ...overrides,
  })
  return { handle: (e) => captured!(e) }
}

describe('attachTerminalKeyHandlers 键位数据化（P-20261003-111）', () => {
  it('默认键位照常拦截：Ctrl+F 搜索 / Ctrl+Shift+V 粘贴 / Ctrl+Shift+C 有选区复制', () => {
    const calls: string[] = []
    const h = attach({
      onSearchOpen: () => calls.push('search'),
      onPaste: () => calls.push('paste'),
      onCopySelection: () => calls.push('copy'),
    })
    expect(h.handle(keyEvent({ key: 'f', ctrlKey: true }))).toBe(false)
    expect(h.handle(keyEvent({ key: 'v', ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(h.handle(keyEvent({ key: 'c', ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(calls).toEqual(['search', 'paste', 'copy'])
    // 无选区：Ctrl+Shift+C 放行（照旧转发 PTY）
    const h2 = attach({ onCopySelection: () => calls.push('copy2') }, false)
    expect(h2.handle(keyEvent({ key: 'c', ctrlKey: true, shiftKey: true }))).toBe(true)
  })

  it('改绑生效：搜索改绑 ctrl+k 后新键拦截、旧键放行（comboOf 现场读生效值）', () => {
    let combos: Record<string, string> = { terminalSearch: 'ctrl+k' }
    const calls: string[] = []
    const h = attach({
      onSearchOpen: () => calls.push('search'),
      comboOf: (action) => combos[action]!,
    })
    expect(h.handle(keyEvent({ key: 'k', ctrlKey: true }))).toBe(false)
    expect(calls).toEqual(['search'])
    // 旧键 ctrl+F 失效（放行给 PTY）
    expect(h.handle(keyEvent({ key: 'f', ctrlKey: true }))).toBe(true)
    // 改绑即时生效（无需重连）：现场再读
    combos = { terminalSearch: 'ctrl+alt+g' }
    expect(h.handle(keyEvent({ key: 'g', ctrlKey: true, altKey: true }))).toBe(false)
    expect(h.handle(keyEvent({ key: 'k', ctrlKey: true }))).toBe(true)
  })

  it('移位字符变体命中：ctrl+shift+\\ 分屏在 | 上报键命中；ctrl+= 字号族在 +/- 上报命中', () => {
    const calls: string[] = []
    const h = attach({
      onSplitHorizontal: () => calls.push('splitH'),
      onSplitVertical: () => calls.push('splitV'),
    })
    // Windows Chromium / Playwright 对 Shift+\ 上报 '|'
    expect(h.handle(keyEvent({ key: '|', ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(calls).toEqual(['splitH'])
    // 垂直分屏 '_' 为 - 的移位字符
    expect(h.handle(keyEvent({ key: '_', ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(calls).toEqual(['splitH', 'splitV'])
  })

  it('循环切 tab：Ctrl+PageUp/Down preventDefault + 方向回调；改绑后旧键放行', () => {
    const calls: number[] = []
    const h = attach({ onSwitchTab: (delta) => calls.push(delta) })
    expect(h.handle(keyEvent({ key: 'PageDown', ctrlKey: true }))).toBe(false)
    expect(h.handle(keyEvent({ key: 'PageUp', ctrlKey: true }))).toBe(false)
    expect(calls).toEqual([1, -1])
    const h2 = attach({
      onSwitchTab: (delta) => calls.push(delta),
      comboOf: action => (action === 'terminalCycleNext' ? 'ctrl+shift+arrowright' : 'ctrl+pageup'),
    })
    expect(h2.handle(keyEvent({ key: 'PageDown', ctrlKey: true }))).toBe(true)
    expect(h2.handle(keyEvent({ key: 'ArrowRight', ctrlKey: true, shiftKey: true }))).toBe(false)
  })

  it('区间键与副键位保持硬编码：Ctrl+Shift+2 切 tab、Ctrl+C 有选区复制不随主键位改绑失效', () => {
    const calls: (number | string)[] = []
    const h = attach({
      onSwitchToTab: (idx) => calls.push(idx),
      onCopySelection: () => calls.push('copy'),
      // 主键位（terminalCopy）改绑到无关键位——副键位 Ctrl+C 不受影响
      comboOf: () => 'ctrl+alt+x',
    })
    expect(h.handle(keyEvent({ key: '2', ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(h.handle(keyEvent({ key: 'c', ctrlKey: true }))).toBe(false)
    expect(calls).toEqual([1, 'copy'])
  })

  it('钩子未注册时按键放行：分屏/关 pane/切 tab 无回调不拦截', () => {
    const h = attach()
    expect(h.handle(keyEvent({ key: '|', ctrlKey: true, shiftKey: true }))).toBe(true)
    expect(h.handle(keyEvent({ key: 'w', ctrlKey: true, shiftKey: true }))).toBe(true)
    expect(h.handle(keyEvent({ key: 'PageDown', ctrlKey: true }))).toBe(true)
  })

  it('命令块跳过导航（P-20261003-269）：Ctrl+Shift+↑/↓ 拦截并按方向回调；未注册放行', () => {
    const calls: number[] = []
    const h = attach({
      onPrevCommandBlock: () => calls.push(-1),
      onNextCommandBlock: () => calls.push(1),
    })
    expect(h.handle(keyEvent({ key: 'ArrowUp', ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(h.handle(keyEvent({ key: 'ArrowDown', ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(calls).toEqual([-1, 1])
    // 回调未注册：键位放行照旧转发 PTY（部分程序以 Ctrl+Shift+↑/↓ 作选区/翻页）
    const h2 = attach()
    expect(h2.handle(keyEvent({ key: 'ArrowUp', ctrlKey: true, shiftKey: true }))).toBe(true)
    expect(h2.handle(keyEvent({ key: 'ArrowDown', ctrlKey: true, shiftKey: true }))).toBe(true)
  })

  it('pane 焦点切换（P-20261004-111）：宿主裁决放行——切换成功拦截、单 pane/未注册放行 PTY', () => {
    const ids: string[] = []
    // 双 pane：宿主完成切换（返回 true）→ 拦截
    const h = attach({ onFocusOtherPane: (id) => { ids.push(id); return true } })
    expect(h.handle(keyEvent({ key: '-', ctrlKey: true, altKey: true }))).toBe(false)
    expect(ids).toEqual(['s1'])
    // 单 pane：宿主返回 false → 放行（Ctrl+Alt+- 转发 PTY 保终端原语义）
    const h2 = attach({ onFocusOtherPane: () => false })
    expect(h2.handle(keyEvent({ key: '-', ctrlKey: true, altKey: true }))).toBe(true)
    // 未注册：放行（远程终端等无 split 宿主）
    const h3 = attach()
    expect(h3.handle(keyEvent({ key: '-', ctrlKey: true, altKey: true }))).toBe(true)
    // 移位字符变体命中：部分平台对 Ctrl+Alt+- 上报 '_'（- 的移位字符）
    expect(h.handle(keyEvent({ key: '_', ctrlKey: true, altKey: true }))).toBe(false)
    expect(ids).toEqual(['s1', 's1'])
  })
})
