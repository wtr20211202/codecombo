import { flushPromises, mount } from '@vue/test-utils'
import { h, type Component } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { safeAsync } from './async-component'

// 裸组件对象（不经 defineComponent——vue/one-component-per-file 会报多组件 warning）
function markerComp(): Component {
  return { name: 'MarkerComp', render: () => h('div', { class: 'marker-ok' }, 'loaded') }
}

// 异步组件根节点在加载/切换期不稳定（wrapper root 瞬时为 null），
// 统一挂进稳定父组件断言子树（父组件同为裸对象）
function mountWith(comp: Component) {
  return mount({ render: () => h(comp) })
}

describe('safeAsync', () => {
  it('加载成功：loader 恰好执行一次并渲染目标组件', async () => {
    const loader = vi.fn(async () => markerComp())
    const w = mountWith(safeAsync(loader))
    await flushPromises()
    expect(loader).toHaveBeenCalledTimes(1)
    expect(w.find('.marker-ok').exists()).toBe(true)
  })

  it('动态 chunk 拉取失败：自动重试 2 次吸收瞬断，仍失败渲染 AsyncLoadError 卡片', async () => {
    const loader = vi.fn(async () => { throw new TypeError('Failed to fetch dynamically imported module') })
    const w = mountWith(safeAsync(loader))
    // 重试经 onError 异步链推进，多轮 flush 让 1 初次 + 2 重试全部落定
    for (let i = 0; i < 6; i++) await flushPromises()
    expect(loader).toHaveBeenCalledTimes(3)
    expect(w.find('.async-load-error').exists()).toBe(true)
    expect(w.text()).toContain('组件资源加载失败')
  })

  it('前两次失败第三次成功：重试吸收后正常渲染（不进错误卡片）', async () => {
    const loader = vi.fn()
      .mockRejectedValueOnce(new TypeError('chunk boom'))
      .mockRejectedValueOnce(new TypeError('chunk boom'))
      .mockResolvedValue(markerComp())
    const w = mountWith(safeAsync(loader))
    for (let i = 0; i < 6; i++) await flushPromises()
    expect(loader).toHaveBeenCalledTimes(3)
    expect(w.find('.marker-ok').exists()).toBe(true)
    expect(w.find('.async-load-error').exists()).toBe(false)
  })
})
