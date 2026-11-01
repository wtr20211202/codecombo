import { describe, it, expect, vi, afterEach } from 'vitest'
import { defineComponent } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { useLayoutKeyboard } from '@/composables/useLayoutKeyboard'
import { useKeymapStore } from '@/stores/keymap'

// 数字捕获链单测（P-20261004-49）：Ctrl/Cmd+Alt+数字 恢复工作区预设的 Alt 修饰
// 分支契约——修饰判别 / 让位（锁定键、keymap 改绑占用）/ 门控（弹窗、锁屏）/
// 越界放行，以及面板数字直达（Ctrl+1-9）的零回归。事件走 document 真实派发
// （组合式自注册 capture 监听），消费与否以 defaultPrevented + 回调 spy 双证。

type KeyboardDeps = ReturnType<typeof useLayoutKeyboardDepsStub>

function useLayoutKeyboardDepsStub(): Parameters<typeof useLayoutKeyboard>[0] {
  return {
    isDialogOpen: () => false,
    lockShortcut: () => null,
    lock: () => {},
    exitPresentModeByEsc: () => false,
    exitMaximizedByEsc: () => false,
    dismissFloatByEsc: () => false,
    dismissBottomPanelByEsc: () => false,
    toggleSidePanel: () => {},
    toggleTerminalPanel: () => {},
    createNewTerminal: () => {},
    togglePreviewPanel: () => {},
    isRemoteOrChat: () => false,
    closeActiveTab: () => {},
    reopenClosedTab: () => {},
    navBack: () => {},
    navForward: () => {},
    newUntitledDraft: () => {},
    saveAll: () => {},
    openFilesCount: () => 0,
    cycleEditorTab: () => {},
    switchTab: () => {},
    toggleSplit: () => {},
    focusOtherGroup: () => {},
    openCommandPalette: () => {},
    openQuickOpen: () => {},
    openProjectSearch: () => {},
    openOutline: () => {},
    openClipboardHistory: () => {},
    isMdFileActive: () => false,
    cycleActiveMdMode: () => {},
    diffNav: () => {},
    openShortcutsHelp: () => {},
    railPanelCount: () => 3,
    switchRailPanel: vi.fn(),
    workspacePresetCount: () => 2,
    restoreWorkspacePreset: vi.fn(),
    openSettings: () => {},
    isLocked: () => false,
  }
}

// document 监听随组件卸载摘除（onBeforeUnmount）——jsdom document 跨用例共享，
// 不卸载会让前序用例的 deps 消费本用例的按键（跨用例监听泄漏）；同用例多次挂载
// 同理，全部登记统一摘除
const hosts: VueWrapper[] = []

function mountKeyboard(deps: KeyboardDeps = useLayoutKeyboardDepsStub()) {
  const Host = defineComponent({
    setup() {
      useLayoutKeyboard(deps)
      return () => null
    },
  })
  const w = mount(Host)
  hosts.push(w)
  return deps
}

afterEach(() => {
  for (const w of hosts.splice(0)) w.unmount()
})

function pressDigit(key: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', {
    key,
    ctrlKey: !!mods.ctrl,
    altKey: !!mods.alt,
    shiftKey: !!mods.shift,
    metaKey: !!mods.meta,
    bubbles: true,
    cancelable: true,
  })
  document.dispatchEvent(e)
  return e
}

describe('useLayoutKeyboard 数字捕获链——Ctrl/Cmd+Alt+数字 工作区预设直达（P-20261004-49）', () => {
  it('Ctrl/Cmd+Alt+数字 N 恢复第 N 个预设（0 基序号上抛），事件被消费', () => {
    const deps = mountKeyboard()
    const e1 = pressDigit('1', { ctrl: true, alt: true })
    expect(deps.restoreWorkspacePreset).toHaveBeenCalledWith(0)
    expect(e1.defaultPrevented).toBe(true)
    const deps2 = mountKeyboard()
    pressDigit('2', { alt: true, meta: true }) // mac Cmd+Alt+2 同链
    expect(deps2.restoreWorkspacePreset).toHaveBeenCalledWith(1)
  })

  it('越界放行：序号超出预设数不消费（放行浏览器标签页切换）', () => {
    // 单宿主 + 可变计数：门控计数是运行态（预热列表），越界面随数据走
    let count = 2
    const deps = mountKeyboard({ ...useLayoutKeyboardDepsStub(), workspacePresetCount: () => count })
    const e = pressDigit('3', { ctrl: true, alt: true }) // 预设 2 个，第 3 个越界
    expect(deps.restoreWorkspacePreset).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
    count = 0
    const e0 = pressDigit('1', { ctrl: true, alt: true })
    expect(deps.restoreWorkspacePreset).not.toHaveBeenCalled()
    expect(e0.defaultPrevented).toBe(false)
    // 计数回暖后同一键恢复生效（门控不粘滞）
    count = 2
    pressDigit('1', { ctrl: true, alt: true })
    expect(deps.restoreWorkspacePreset).toHaveBeenCalledWith(0)
  })

  it('让位锁定快捷键：锁定键与 Ctrl+Alt+数字 同键时放行气泡链，由锁定链消费', () => {
    const lock = vi.fn()
    const deps = mountKeyboard({ ...useLayoutKeyboardDepsStub(), lockShortcut: () => 'ctrl+alt+2', lock })
    pressDigit('2', { ctrl: true, alt: true })
    // 捕获链不恢复；放行的气泡链按锁定键优先级消费（handleKeyDown lock 分支）
    expect(deps.restoreWorkspacePreset).not.toHaveBeenCalled()
    expect(lock).toHaveBeenCalled()
  })

  it('让位 keymap 改绑：动作改绑到 Ctrl+Alt+数字 后捕获链放行，改绑动作消费', () => {
    const keymapStore = useKeymapStore()
    keymapStore.setBinding('saveAll', 'ctrl+alt+2')
    const saveAll = vi.fn()
    const deps = mountKeyboard({ ...useLayoutKeyboardDepsStub(), saveAll })
    pressDigit('2', { ctrl: true, alt: true })
    // 捕获链不恢复；放行的气泡链命中改绑后的 saveAll 动作（改绑优先于硬编码键）
    expect(deps.restoreWorkspacePreset).not.toHaveBeenCalled()
    expect(saveAll).toHaveBeenCalled()
  })

  it('锁定态门控：锁屏下预设直达不穿透（同面板直达口径）', () => {
    const deps = mountKeyboard({ ...useLayoutKeyboardDepsStub(), isLocked: () => true })
    const e = pressDigit('1', { ctrl: true, alt: true })
    expect(deps.restoreWorkspacePreset).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
  })

  it('弹窗门控：自管弹层打开时预设直达不触发', () => {
    const deps = mountKeyboard({ ...useLayoutKeyboardDepsStub(), isDialogOpen: () => true })
    const e = pressDigit('1', { ctrl: true, alt: true })
    expect(deps.restoreWorkspacePreset).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
  })

  it('Shift 变体不命中（Ctrl+Shift+数字留给终端 tab 切换域）', () => {
    const deps = mountKeyboard()
    const e = pressDigit('1', { ctrl: true, alt: true, shift: true })
    expect(deps.restoreWorkspacePreset).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
  })

  it('面板数字直达零回归：无 Alt 的 Ctrl+数字照旧切活动栏面板并消费', () => {
    const deps = mountKeyboard()
    const e = pressDigit('2', { ctrl: true })
    expect(deps.switchRailPanel).toHaveBeenCalledWith(1)
    expect(deps.restoreWorkspacePreset).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(true)
    // 面板越界同样放行（railPanelCount=3，Ctrl+5 越界）
    const e5 = pressDigit('5', { ctrl: true })
    expect(deps.switchRailPanel).toHaveBeenCalledTimes(1)
    expect(e5.defaultPrevented).toBe(false)
  })
})
