import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'
import { describe, it, expect, beforeEach } from 'vitest'
import { usePresentMode, resetPresentMode } from '@/composables/usePresentMode'
import { usePanelLayout, resetPanelLayout } from '@/composables/usePanelLayout'
import { useFontStore } from '@/stores/font'

beforeEach(() => {
  setActivePinia(createPinia())
  resetPanelLayout()
  resetPresentMode()
  // 演示态纯内存不落盘：测试里直接断言 store 出口，localStorage 环境由 jsdom 提供
  localStorage.removeItem('font-settings')
})

describe('usePresentMode', () => {
  it('初始未激活', () => {
    expect(usePresentMode().active.value).toBe(false)
  })

  it('进入：字号临时 ×1.5（生效值变化、持久 sizes 不动）且侧栏底栏收起', () => {
    const font = useFontStore()
    font.setSize('editor', 14)
    font.setSize('terminal', 12)
    const savedBefore = localStorage.getItem('font-settings')
    const layout = usePanelLayout()
    layout.showSidePanel.value = true
    layout.showBottomPanel.value = true

    usePresentMode().enter()

    expect(usePresentMode().active.value).toBe(true)
    // 生效字号放大（14→21、12→18），持久设置原样（不写入 font-settings）
    expect(font.editorFontSize).toBe(21)
    expect(font.terminalFontSize).toBe(18)
    expect(font.sizes.editor).toBe(14)
    expect(font.sizes.terminal).toBe(12)
    expect(localStorage.getItem('font-settings')).toBe(savedBefore)
    // 面板收起
    expect(layout.showSidePanel.value).toBe(false)
    expect(layout.showBottomPanel.value).toBe(false)
  })

  it('退出：字号与面板开合还原为进入前状态', async () => {
    const font = useFontStore()
    font.setSize('editor', 16)
    const layout = usePanelLayout()
    // 进入前的非默认态：侧栏关、底栏开 + 终端最大化
    layout.showSidePanel.value = false
    layout.showBottomPanel.value = true
    layout.maximizeTerminal()
    // 先等一拍让面板态落定（pre-flush watcher 只认跨 tick 净变化，
    // 同 tick 内 true→false 会被去重成无变化），再进演示态
    await nextTick()

    const present = usePresentMode()
    present.enter()
    // 收底栏清最大化挂在 usePanelLayout 的 pre-flush watch 上，等一拍再断言
    await nextTick()
    expect(layout.showBottomPanel.value).toBe(false)
    expect(layout.terminalMaximized.value).toBe(false)
    present.exit()

    expect(present.active.value).toBe(false)
    expect(font.editorFontSize).toBe(16)
    expect(font.sizes.editor).toBe(16)
    expect(layout.showSidePanel.value).toBe(false)
    expect(layout.showBottomPanel.value).toBe(true)
    expect(layout.terminalMaximized.value).toBe(true)
  })

  it('toggle 语义：执行进入、再次执行退出', () => {
    const present = usePresentMode()
    present.toggle()
    expect(present.active.value).toBe(true)
    present.toggle()
    expect(present.active.value).toBe(false)
  })

  it('enter 幂等：演示态中重复进入不覆盖快照', () => {
    const layout = usePanelLayout()
    // 进入前的非默认态：侧栏关、底栏开
    layout.showSidePanel.value = false
    layout.showBottomPanel.value = true
    const present = usePresentMode()
    present.enter()
    // 演示态中手动改动面板（如 Ctrl+B 开侧栏），再执行 enter 不得把改动当快照
    layout.showSidePanel.value = true
    present.enter()
    present.exit()
    expect(layout.showSidePanel.value).toBe(false)
    expect(layout.showBottomPanel.value).toBe(true)
  })

  it('exitByEsc：未激活放行（false），激活时退出并消费（true）', () => {
    const present = usePresentMode()
    expect(present.exitByEsc()).toBe(false)
    expect(present.active.value).toBe(false)
    present.enter()
    expect(present.exitByEsc()).toBe(true)
    expect(present.active.value).toBe(false)
  })
})
