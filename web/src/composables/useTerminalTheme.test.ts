import { describe, it, expect, beforeEach } from 'vitest'
import { applyThemeForTest } from './useTerminalTheme'
import { classicDark } from '../terminal-themes/classic-dark'

describe('applyThemeToDocument', () => {
  beforeEach(() => {
    document.body.removeAttribute('data-terminal-theme')
    document.documentElement.className = ''
    document.documentElement.style.cssText = ''
  })

  it('给 body 加 data-terminal-theme 属性', () => {
    applyThemeForTest(classicDark, 'jetbrains')
    expect(document.body.dataset.terminalTheme).toBe('classic-dark')
  })

  it('把 cssVars 写到 :root', () => {
    applyThemeForTest(classicDark, 'jetbrains')
    expect(document.documentElement.style.getPropertyValue('--bg-terminal')).toBe('#1e1e1e')
  })

  it('给 <html> 加 terminal-font-xxx class', () => {
    applyThemeForTest(classicDark, 'cascadia')
    expect(document.documentElement.classList.contains('terminal-font-cascadia')).toBe(true)
  })

  it('多次调用切换字体，class 不残留', () => {
    applyThemeForTest(classicDark, 'jetbrains')
    applyThemeForTest(classicDark, 'cascadia')
    applyThemeForTest(classicDark, 'ibmplex')
    expect(document.documentElement.classList.contains('terminal-font-jetbrains')).toBe(false)
    expect(document.documentElement.classList.contains('terminal-font-cascadia')).toBe(false)
    expect(document.documentElement.classList.contains('terminal-font-ibmplex')).toBe(true)
  })
})
