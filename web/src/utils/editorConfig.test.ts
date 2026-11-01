import { describe, expect, it } from 'vitest'
import { resolveIndentOptions } from './editorConfig'

// editorconfig > 全局设置 优先级合成（P-20261003-95）：纯函数矩阵直测

const GLOBAL = { tabSize: 4, insertSpaces: true }

describe('resolveIndentOptions', () => {
  it('无 editorconfig / 空对象 → 原样回落全局设置', () => {
    expect(resolveIndentOptions(GLOBAL, undefined)).toEqual(GLOBAL)
    expect(resolveIndentOptions(GLOBAL, null)).toEqual(GLOBAL)
    expect(resolveIndentOptions(GLOBAL, {})).toEqual(GLOBAL)
  })

  it('indent_style=tab → insertSpaces=false，宽度仍走全局', () => {
    expect(resolveIndentOptions(GLOBAL, { indentStyle: 'tab' })).toEqual({ tabSize: 4, insertSpaces: false })
  })

  it('indent_style=space → insertSpaces=true', () => {
    expect(resolveIndentOptions({ tabSize: 4, insertSpaces: false }, { indentStyle: 'space' }))
      .toEqual({ tabSize: 4, insertSpaces: true })
  })

  it('缩进宽度 indent_size 优先于 tab_width（规范优先级）', () => {
    expect(resolveIndentOptions(GLOBAL, { indentSize: 2, tabWidth: 8 }).tabSize).toBe(2)
    expect(resolveIndentOptions(GLOBAL, { tabWidth: 8 }).tabSize).toBe(8)
  })

  it('逐键独立：只有宽度时 style 走全局，只有 style 时宽度走全局', () => {
    expect(resolveIndentOptions(GLOBAL, { indentSize: 3 })).toEqual({ tabSize: 3, insertSpaces: true })
    expect(resolveIndentOptions(GLOBAL, { indentStyle: 'tab' })).toEqual({ tabSize: 4, insertSpaces: false })
  })

  it('style+宽度齐约定 → 双覆盖（Go tab 仓形态）', () => {
    expect(resolveIndentOptions(GLOBAL, { indentStyle: 'tab', tabWidth: 8 }))
      .toEqual({ tabSize: 8, insertSpaces: false })
  })

  it('越界/非法宽度按未约定处理回落全局（防御旧对端/坏值）', () => {
    expect(resolveIndentOptions(GLOBAL, { indentSize: 0 }).tabSize).toBe(4)
    expect(resolveIndentOptions(GLOBAL, { indentSize: -2 }).tabSize).toBe(4)
    expect(resolveIndentOptions(GLOBAL, { indentSize: 101 }).tabSize).toBe(4)
    expect(resolveIndentOptions(GLOBAL, { tabWidth: 1e9 }).tabSize).toBe(4)
    // 边界值 1 与 100 合法
    expect(resolveIndentOptions(GLOBAL, { indentSize: 1 }).tabSize).toBe(1)
    expect(resolveIndentOptions(GLOBAL, { indentSize: 100 }).tabSize).toBe(100)
  })
})
