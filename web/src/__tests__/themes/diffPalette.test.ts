import { describe, expect, it } from 'vitest'
import { resolveDiffPair, colorblindMonacoOverrides } from '../../themes/diffPalette'

// diff 色板解析（P-20261006-5）：CSS 变量对与 Monaco 覆盖的取值源单测——
// 档位选键、缺键防御、alpha 派生梯度三面。键集合完备性由 parity.test.ts 守。

const COLORS = {
  'diff-added': '#3fb950',
  'diff-removed': '#f85149',
  'diff-added-cb': '#58a6ff',
  'diff-removed-cb': '#f0883e',
}

describe('resolveDiffPair', () => {
  it('标准档取 diff-added/diff-removed 原键', () => {
    expect(resolveDiffPair(COLORS, 'standard')).toEqual({ added: '#3fb950', removed: '#f85149' })
  })

  it('色弱档取 *-cb 键（蓝/橙）', () => {
    expect(resolveDiffPair(COLORS, 'colorblind')).toEqual({ added: '#58a6ff', removed: '#f0883e' })
  })

  it('缺键回空串（防御非注册表形态，不抛错）', () => {
    expect(resolveDiffPair({}, 'colorblind')).toEqual({ added: '', removed: '' })
  })
})

describe('colorblindMonacoOverrides', () => {
  it('背景四键沿标准档 alpha 梯度（词条 40/整行 30）+ 边框 66', () => {
    expect(colorblindMonacoOverrides({ added: '#58a6ff', removed: '#f0883e' })).toEqual({
      'diffEditor.insertedTextBackground': '#58a6ff40',
      'diffEditor.removedTextBackground': '#f0883e40',
      'diffEditor.insertedLineBackground': '#58a6ff30',
      'diffEditor.removedLineBackground': '#f0883e30',
      'diffEditor.insertedTextBorder': '#58a6ff66',
      'diffEditor.removedTextBorder': '#f0883e66',
    })
  })
})
