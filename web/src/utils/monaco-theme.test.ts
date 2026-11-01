import { beforeEach, describe, expect, it, vi } from 'vitest'

// monaco-editor 主模块替身化：defineTheme/setTheme 是本函数唯一触点，
// 不为单测拉起整套 monaco（编辑器 chunk 懒加载约束同样适用于单测面）
vi.mock('monaco-editor', () => ({
  editor: {
    defineTheme: vi.fn(),
    setTheme: vi.fn(),
  },
}))
import * as monaco from 'monaco-editor'
import { applyMonacoTheme } from './monaco-theme'

// useThemeStore 返回值的最小结构面（colors 供 diff 色板档解析，P-20261006-5）
function themeStoreLike(currentTheme: string) {
  return {
    currentTheme,
    themeDef: {
      monacoBase: 'vs-dark',
      monacoRules: [{ token: 'comment', foreground: '888888' }],
      monacoColors: { 'editor.background': '#101010', 'diffEditor.insertedLineBackground': '#1e4a1e30' },
      colors: { 'diff-added': '#3fb950', 'diff-removed': '#f85149', 'diff-added-cb': '#58a6ff', 'diff-removed-cb': '#f0883e' },
    },
  }
}

describe('applyMonacoTheme', () => {
  beforeEach(() => {
    vi.mocked(monaco.editor.defineTheme).mockClear()
    vi.mocked(monaco.editor.setTheme).mockClear()
  })

  it('以 codecombo-<当前主题> 注册并切换（避免撞 monaco 内建主题名）', () => {
    applyMonacoTheme(themeStoreLike('one-dark') as never)
    expect(monaco.editor.defineTheme).toHaveBeenCalledWith('codecombo-one-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [{ token: 'comment', foreground: '888888' }],
      colors: { 'editor.background': '#101010', 'diffEditor.insertedLineBackground': '#1e4a1e30' },
    })
    expect(monaco.editor.setTheme).toHaveBeenCalledWith('codecombo-one-dark')
  })

  it('主题切换后主题名跟随（dark ↔ one-dark）', () => {
    applyMonacoTheme(themeStoreLike('light') as never)
    expect(monaco.editor.setTheme).toHaveBeenLastCalledWith('codecombo-light')
  })

  it('标准档（缺省）monacoColors 原样零触碰——存量 diff 外观逐像素不变', () => {
    applyMonacoTheme(themeStoreLike('dark') as never)
    const arg = vi.mocked(monaco.editor.defineTheme).mock.calls[0]![1] as { colors: Record<string, string> }
    expect(arg.colors['diffEditor.insertedLineBackground']).toBe('#1e4a1e30')
    expect(Object.keys(arg.colors)).not.toContain('diffEditor.insertedTextBorder')
  })

  it('色弱档只覆盖 diff* 键：背景按色弱对叠 alpha 派生，非 diff 键不动', () => {
    applyMonacoTheme(themeStoreLike('dark') as never, 'colorblind')
    const arg = vi.mocked(monaco.editor.defineTheme).mock.calls[0]![1] as { colors: Record<string, string> }
    expect(arg.colors['editor.background']).toBe('#101010')
    expect(arg.colors['diffEditor.insertedLineBackground']).toBe('#58a6ff30')
    expect(arg.colors['diffEditor.insertedTextBackground']).toBe('#58a6ff40')
    expect(arg.colors['diffEditor.removedLineBackground']).toBe('#f0883e30')
    expect(arg.colors['diffEditor.insertedTextBorder']).toBe('#58a6ff66')
  })
})
