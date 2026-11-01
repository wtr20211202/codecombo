import { describe, expect, it, vi } from 'vitest'
import { OPEN_HELP_EVENT, openHelpEntry } from './openHelp'

describe('openHelpEntry', () => {
  it('派发 sc-open-help CustomEvent 携锚点条目 id', () => {
    const spy = vi.fn()
    window.addEventListener(OPEN_HELP_EVENT, spy)
    openHelpEntry('agent-runtime-install')
    window.removeEventListener(OPEN_HELP_EVENT, spy)
    expect(spy).toHaveBeenCalledTimes(1)
    const ev = spy.mock.calls[0]![0] as CustomEvent
    expect(ev.type).toBe('sc-open-help')
    expect(ev.detail).toBe('agent-runtime-install')
  })

  it('缺省锚点：仅打开不定位（jsdom 把 undefined detail 序列化为 null，浏览器为 undefined）', () => {
    const spy = vi.fn()
    window.addEventListener(OPEN_HELP_EVENT, spy)
    openHelpEntry()
    window.removeEventListener(OPEN_HELP_EVENT, spy)
    expect((spy.mock.calls[0]![0] as CustomEvent).detail ?? undefined).toBeUndefined()
  })
})
