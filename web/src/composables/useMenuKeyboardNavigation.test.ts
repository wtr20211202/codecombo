import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import type { Ref } from 'vue'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { useMenuKeyboardNavigation } from './useMenuKeyboardNavigation'

// 跨用例挂载残留会污染 body 级断言（activeElement 兜底路径读 body textContent），
// afterEach 统一卸载
const mounted: VueWrapper[] = []
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount()
})

// ── 测试宿主：渲染 term-context 家族同构的菜单 DOM（.term-context-menu 根 +
// .term-context-item 按钮序列，可注入 disabled 位次），挂 composable 真身。
// focus/activeElement 在 jsdom 只对已连接文档的元素生效 → attachTo body ──
function mountMenu(disabledIdx: number[] = []) {
  const menuRef = ref<HTMLElement | null>(null)
  const close = vi.fn()
  const Host = defineComponent({
    setup() {
      const { onMenuKeydown } = useMenuKeyboardNavigation({ menuRef: menuRef as Ref<HTMLElement | null>, close })
      // 与两菜单组件模板同构：composable 只产 handler，绑定仍由视图层完成
      return () =>
        h(
          'div',
          { ref: menuRef, class: 'term-context-menu', onKeydown: onMenuKeydown },
          ['A', 'B', 'C', 'D'].map((label, i) =>
            h('button', { class: 'term-context-item', disabled: disabledIdx.includes(i) }, label),
          ),
        )
    },
  })
  const wrapper = mount(Host, { attachTo: document.body })
  mounted.push(wrapper)
  // afterEach 统一卸载保证同一时刻只有一份菜单在文档里，document 域查询即可
  // （wrapper.element 在该挂载形态下类型退化为 any，泛型调用直接过不了 vue-tsc）
  const items = Array.from(
    document.querySelectorAll<HTMLButtonElement>('.term-context-menu .term-context-item'),
  )
  return { wrapper, items, close }
}

function press(key: string, init: KeyboardEventInit = {}): void {
  document.activeElement?.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
  )
}

/** 焦点不在任何条目上的兜底路径用：把焦点挪出菜单 */
function blurToBody(): void {
  ;(document.activeElement as HTMLElement | null)?.blur()
}

describe('useMenuKeyboardNavigation 自绘右键菜单键盘导航（P-20261004-69）', () => {
  it('打开（挂载）即聚焦首个可用条目：菜单即入键盘语境', () => {
    mountMenu()
    expect(document.activeElement?.textContent).toBe('A')
  })

  it('首项禁用时首焦点跳到首个可用条目（禁用项不承接焦点）', () => {
    mountMenu([0])
    expect(document.activeElement?.textContent).toBe('B')
  })

  it('↑↓ 环绕移焦：越过首尾回绕', () => {
    const { wrapper } = mountMenu()
    expect(document.activeElement?.textContent).toBe('A')
    press('ArrowDown')
    expect(document.activeElement?.textContent).toBe('B')
    press('ArrowUp')
    expect(document.activeElement?.textContent).toBe('A')
    press('ArrowUp') // 首项再 ↑ → 回绕到尾项
    expect(document.activeElement?.textContent).toBe('D')
    press('ArrowDown') // 尾项再 ↓ → 回绕回首项
    expect(document.activeElement?.textContent).toBe('A')
    wrapper.unmount()
  })

  it('禁用项跳过导航：序列中不出现 disabled 条目', () => {
    mountMenu([1])
    press('ArrowDown') // A → C（跳过禁用的 B）
    expect(document.activeElement?.textContent).toBe('C')
    press('ArrowUp')
    expect(document.activeElement?.textContent).toBe('A')
  })

  it('Home/End 首尾直达（按可用序列，跳过禁用项）', () => {
    const { wrapper } = mountMenu([3])
    press('End')
    expect(document.activeElement?.textContent).toBe('C')
    press('Home')
    expect(document.activeElement?.textContent).toBe('A')
    wrapper.unmount()
  })

  it('Esc 关闭：触发宿主 close 回调', () => {
    const { wrapper, close } = mountMenu()
    press('Escape')
    expect(close).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('已处理键截断冒泡：不外泄给 document 级处理器（Esc 逐层退出链等）', () => {
    const { wrapper } = mountMenu()
    const leaked: string[] = []
    const onDocKeydown = (e: Event) => leaked.push((e as KeyboardEvent).key)
    document.addEventListener('keydown', onDocKeydown)
    try {
      press('ArrowDown')
      press('Escape')
      // Enter/Space 不在处理集：原生 button 激活语义照常冒泡（动作链不受拦截）
      press('Enter')
      expect(leaked).toEqual(['Enter'])
    } finally {
      document.removeEventListener('keydown', onDocKeydown)
    }
    wrapper.unmount()
  })

  it('带 ctrl/meta/alt 的组合键放行：不移焦也不截断（系统快捷键不劫持）', () => {
    const { wrapper } = mountMenu()
    press('ArrowDown', { ctrlKey: true })
    expect(document.activeElement?.textContent).toBe('A')
    wrapper.unmount()
  })

  it('焦点不在任何条目上时 ↑↓ 按方向落首/尾（防御式兜底）', () => {
    const { wrapper, items } = mountMenu()
    blurToBody()
    // 焦点在 body 时键盘事件从条目冒进（activeElement 已不在序列内）→ 按方向落首/尾
    items[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    expect(document.activeElement?.textContent).toBe('A')
    blurToBody()
    items[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
    expect(document.activeElement?.textContent).toBe('D')
    wrapper.unmount()
  })
})
