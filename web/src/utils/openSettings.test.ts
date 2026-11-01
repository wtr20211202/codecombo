import { describe, expect, it, vi } from 'vitest'
import { OPEN_SETTINGS_EVENT, openSettingsTab } from './openSettings'

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
