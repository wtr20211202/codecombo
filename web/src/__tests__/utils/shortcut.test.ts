import { describe, it, expect } from 'vitest'
import { parseShortcut, eventToShortcut, matchShortcut } from '@/utils/shortcut'

// 构造 KeyboardEvent 的辅助函数：jsdom 支持 KeyboardEvent 构造
function makeEvent(opts: {
  ctrlKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
  metaKey?: boolean
  key: string
  code?: string
}): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    ctrlKey: opts.ctrlKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    altKey: opts.altKey ?? false,
    metaKey: opts.metaKey ?? false,
    key: opts.key,
    code: opts.code ?? '',
  })
}

describe('parseShortcut', () => {
  it('解析 ctrl+shift+l 全修饰符', () => {
    const r = parseShortcut('ctrl+shift+l')
    expect(r).toEqual({ ctrl: true, shift: true, alt: false, meta: false, key: 'l' })
  })

  it('解析 cmd+alt+k（mac 习惯）', () => {
    const r = parseShortcut('cmd+alt+k')
    expect(r).toEqual({ ctrl: false, shift: false, alt: true, meta: true, key: 'k' })
  })

  it('解析 meta+shift+enter', () => {
    const r = parseShortcut('meta+shift+enter')
    expect(r).toEqual({ ctrl: false, shift: true, alt: false, meta: true, key: 'enter' })
  })

  it('解析单个字符（无修饰）', () => {
    const r = parseShortcut('f1')
    expect(r).toEqual({ ctrl: false, shift: false, alt: false, meta: false, key: 'f1' })
  })

  it('大小写不敏感，key 统一小写', () => {
    const r = parseShortcut('Ctrl+Shift+L')
    expect(r).toEqual({ ctrl: true, shift: true, alt: false, meta: false, key: 'l' })
  })

  it('空字符串返回全 false + key=""', () => {
    const r = parseShortcut('')
    expect(r).toEqual({ ctrl: false, shift: false, alt: false, meta: false, key: '' })
  })

  it('忽略多余空格', () => {
    const r = parseShortcut(' ctrl + shift + l ')
    expect(r).toEqual({ ctrl: true, shift: true, alt: false, meta: false, key: 'l' })
  })

  it('大小写混写 modifier 别名', () => {
    expect(parseShortcut('Ctrl+Shift+Alt+Meta+x')).toEqual({
      ctrl: true, shift: true, alt: true, meta: true, key: 'x',
    })
  })
})

describe('eventToShortcut', () => {
  it('Ctrl+Shift+L → ctrl+shift+l', () => {
    const e = makeEvent({ ctrlKey: true, shiftKey: true, key: 'L' })
    expect(eventToShortcut(e)).toBe('ctrl+shift+l')
  })

  it('Meta+K → meta+k', () => {
    const e = makeEvent({ metaKey: true, key: 'k' })
    expect(eventToShortcut(e)).toBe('meta+k')
  })

  it('Alt+Shift+F1 → alt+shift+f1', () => {
    const e = makeEvent({ altKey: true, shiftKey: true, key: 'F1' })
    expect(eventToShortcut(e)).toBe('alt+shift+f1')
  })

  it('单独 Ctrl 不返回（modifier only）', () => {
    const e = makeEvent({ ctrlKey: true, key: 'Control' })
    expect(eventToShortcut(e)).toBe('')
  })

  it('单独 Shift 不返回', () => {
    const e = makeEvent({ shiftKey: true, key: 'Shift' })
    expect(eventToShortcut(e)).toBe('')
  })

  it('单独 Alt 不返回', () => {
    const e = makeEvent({ altKey: true, key: 'Alt' })
    expect(eventToShortcut(e)).toBe('')
  })

  it('单独 Meta 不返回', () => {
    const e = makeEvent({ metaKey: true, key: 'Meta' })
    expect(eventToShortcut(e)).toBe('')
  })

  it('无修饰单字符不返回（避免误绑定）', () => {
    const e = makeEvent({ key: 'a' })
    expect(eventToShortcut(e)).toBe('')
  })

  it('Enter 键组合', () => {
    const e = makeEvent({ ctrlKey: true, key: 'Enter' })
    expect(eventToShortcut(e)).toBe('ctrl+enter')
  })

  it('Tab 键组合', () => {
    const e = makeEvent({ ctrlKey: true, shiftKey: true, key: 'Tab' })
    expect(eventToShortcut(e)).toBe('ctrl+shift+tab')
  })

  it('ArrowDown 键组合', () => {
    const e = makeEvent({ altKey: true, key: 'ArrowDown' })
    expect(eventToShortcut(e)).toBe('alt+arrowdown')
  })
})

describe('matchShortcut', () => {
  it('精确匹配 ctrl+shift+l', () => {
    const e = makeEvent({ ctrlKey: true, shiftKey: true, key: 'l' })
    expect(matchShortcut(e, 'ctrl+shift+l')).toBe(true)
  })

  it('大小写键名不敏感', () => {
    const e = makeEvent({ ctrlKey: true, shiftKey: true, key: 'L' })
    expect(matchShortcut(e, 'Ctrl+Shift+L')).toBe(true)
  })

  it('修饰符不匹配 → false', () => {
    const e = makeEvent({ ctrlKey: true, key: 'l' })  // 缺 shift
    expect(matchShortcut(e, 'ctrl+shift+l')).toBe(false)
  })

  it('主键不匹配 → false', () => {
    const e = makeEvent({ ctrlKey: true, shiftKey: true, key: 'k' })
    expect(matchShortcut(e, 'ctrl+shift+l')).toBe(false)
  })

  it('多出修饰符 → false', () => {
    const e = makeEvent({ ctrlKey: true, shiftKey: true, altKey: true, key: 'l' })
    expect(matchShortcut(e, 'ctrl+shift+l')).toBe(false)
  })

  it('空 combo → 永远不匹配', () => {
    const e = makeEvent({ ctrlKey: true, shiftKey: true, key: 'l' })
    expect(matchShortcut(e, '')).toBe(false)
  })

  it('Cmd+K 与 Ctrl+K 在 Mac 都应可识别（meta vs ctrl 分开）', () => {
    const eCtrl = makeEvent({ ctrlKey: true, key: 'k' })
    const eMeta = makeEvent({ metaKey: true, key: 'k' })
    expect(matchShortcut(eCtrl, 'ctrl+k')).toBe(true)
    expect(matchShortcut(eMeta, 'meta+k')).toBe(true)
    expect(matchShortcut(eCtrl, 'meta+k')).toBe(false)
    expect(matchShortcut(eMeta, 'ctrl+k')).toBe(false)
  })
})
