import { describe, expect, it, vi } from 'vitest'
import { OPEN_SETTINGS_EVENT, openSettingsTab, openVersionPanel } from './openSettings'

// 默认路由加载器走惰性 import('../router')：桩成大屏路由，覆盖「默认加载器 + 回首页」链
const routerPush = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('../router', () => ({
  default: { currentRoute: { value: { name: 'monitor' } }, push: routerPush },
}))

describe('openSettingsTab', () => {
  it('派发 sc-open-settings CustomEvent 携目标 tab', () => {
    const spy = vi.fn()
    window.addEventListener(OPEN_SETTINGS_EVENT, spy)
    openSettingsTab('ai')
    window.removeEventListener(OPEN_SETTINGS_EVENT, spy)
    expect(spy).toHaveBeenCalledTimes(1)
    const ev = spy.mock.calls[0]![0] as CustomEvent
    expect(ev.type).toBe('sc-open-settings')
    expect(ev.detail).toBe('ai')
  })

  it('空 detail 原样透传（宿主层打开弹窗不切 tab）', () => {
    const spy = vi.fn()
    window.addEventListener(OPEN_SETTINGS_EVENT, spy)
    openSettingsTab('')
    window.removeEventListener(OPEN_SETTINGS_EVENT, spy)
    expect((spy.mock.calls[0]![0] as CustomEvent).detail).toBe('')
  })
})

// 更新进度回跳（P-20261109-10）：版本面板 = 设置「关于」分区
describe('openVersionPanel', () => {
  function fakeRouter(name: string) {
    return {
      currentRoute: { value: { name } },
      push: vi.fn(async () => undefined),
    }
  }

  it('首页/项目页：不跳路由，直接定位 about 分区', async () => {
    const spy = vi.fn()
    window.addEventListener(OPEN_SETTINGS_EVENT, spy)
    const router = fakeRouter('project')
    await openVersionPanel(async () => router)
    window.removeEventListener(OPEN_SETTINGS_EVENT, spy)
    expect(router.push).not.toHaveBeenCalled()
    expect(spy).toHaveBeenCalledTimes(1)
    expect((spy.mock.calls[0]![0] as CustomEvent).detail).toBe('about')
  })

  it('大屏路由：先回首页再定位（大屏无设置弹窗宿主）', async () => {
    const order: string[] = []
    const onOpen = () => order.push('open')
    window.addEventListener(OPEN_SETTINGS_EVENT, onOpen)
    const router = fakeRouter('monitor')
    router.push.mockImplementation(async () => { order.push('push') })
    await openVersionPanel(async () => router)
    window.removeEventListener(OPEN_SETTINGS_EVENT, onOpen)
    expect(router.push).toHaveBeenCalledWith({ name: 'home' })
    expect(order).toEqual(['push', 'open'])
  })

  it('默认加载器：惰性取主 router（桩为大屏路由 → 回首页后定位）', async () => {
    const spy = vi.fn()
    window.addEventListener(OPEN_SETTINGS_EVENT, spy)
    await openVersionPanel()
    window.removeEventListener(OPEN_SETTINGS_EVENT, spy)
    expect(routerPush).toHaveBeenCalledWith({ name: 'home' })
    expect((spy.mock.calls[0]![0] as CustomEvent).detail).toBe('about')
  })
})
