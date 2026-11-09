import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import SidebarResizer from './SidebarResizer.vue'

// 通用侧栏宽度把手（P-20261106-5）：v-model 桥接宿主宽度 + setup 期读盘同步 +
// ARIA slider 键盘语义 + 双击复位。jsdom 无 PointerEvent 构造器，拖拽链用
// MouseEvent 等价驱动（composable 只消费 button/clientX）。
const KEY = 'sc.test.sidebarWidth'

function pointer(type: string, x: number): Event {
  return new MouseEvent(type, { button: 0, clientX: x, bubbles: true })
}

/** 宿主：持 width ref 并经 v-model 绑到把手（与 RemoteConsoleView 同形） */
function mountHost(initial = 260) {
  const width = ref(initial)
  const resizeEnds = ref(0)
  const Host = defineComponent({
    setup() {
      return () => h(SidebarResizer, {
        modelValue: width.value,
        'onUpdate:modelValue': (v: number) => { width.value = v },
        onResizeEnd: () => { resizeEnds.value++ },
        storageKey: KEY,
        min: 200,
        max: 480,
        defaultWidth: 260,
        label: 'resize',
      })
    },
  })
  const wrapper = mount(Host)
  return { wrapper, width, resizeEnds, handle: wrapper.get('.sidebar-resizer') }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('SidebarResizer（v-model 桥接 + 键盘 + 双击复位）', () => {
  it('挂载即同步持久宽度到宿主 ref（setup 期读盘，无 Vue 告警），aria-value* 对齐', async () => {
    localStorage.setItem(KEY, '380')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { width, handle } = mountHost()
    await nextTick()
    expect(width.value).toBe(380)
    expect(handle.attributes('role')).toBe('slider')
    expect(handle.attributes('aria-valuemin')).toBe('200')
    expect(handle.attributes('aria-valuemax')).toBe('480')
    expect(handle.attributes('aria-valuenow')).toBe('380')
    expect(handle.attributes('tabindex')).toBe('0')
    expect(warn).not.toHaveBeenCalled()
  })

  it('无持久值时保持宿主默认宽（不覆盖）', async () => {
    const { width } = mountHost(260)
    await nextTick()
    expect(width.value).toBe(260)
  })

  it('键盘：→/↑ 加 step、←/↓ 减 step、Home/End 到边界，步进即落盘且 preventDefault', async () => {
    const { width, handle } = mountHost()
    await handle.trigger('keydown', { key: 'ArrowRight' })
    expect(width.value).toBe(276)
    expect(localStorage.getItem(KEY)).toBe('276')
    await handle.trigger('keydown', { key: 'ArrowUp' })
    expect(width.value).toBe(292)
    await handle.trigger('keydown', { key: 'ArrowLeft' })
    await handle.trigger('keydown', { key: 'ArrowDown' })
    expect(width.value).toBe(260)
    await handle.trigger('keydown', { key: 'Home' })
    expect(width.value).toBe(200)
    await handle.trigger('keydown', { key: 'End' })
    expect(width.value).toBe(480)
    expect(localStorage.getItem(KEY)).toBe('480')
    // 未处理键放行（不 preventDefault）：Tab 仍走焦点链
    const tab = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true })
    handle.element.dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(false)
    const arrow = new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true })
    handle.element.dispatchEvent(arrow)
    expect(arrow.defaultPrevented).toBe(true)
  })

  it('双击复位默认宽度并落盘', async () => {
    localStorage.setItem(KEY, '400')
    const { width, handle } = mountHost()
    await nextTick()
    expect(width.value).toBe(400)
    await handle.trigger('dblclick')
    expect(width.value).toBe(260)
    expect(localStorage.getItem(KEY)).toBe('260')
  })

  it('拖拽：pointerdown 后 window pointermove 实时改宽、pointerup 落盘并上抛 resize-end', async () => {
    const { width, handle, resizeEnds } = mountHost()
    handle.element.dispatchEvent(pointer('pointerdown', 500))
    await nextTick()
    expect(handle.classes()).toContain('is-resizing')
    window.dispatchEvent(pointer('pointermove', 620))
    expect(width.value).toBe(380)
    window.dispatchEvent(pointer('pointerup', 620))
    await nextTick()
    expect(handle.classes()).not.toContain('is-resizing')
    expect(localStorage.getItem(KEY)).toBe('380')
    expect(resizeEnds.value).toBe(1)
  })
})
