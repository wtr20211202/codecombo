import { describe, expect, it } from 'vitest'
import { themeRegistry } from '../themes'
import {
  PAIR_SPECS,
  contrastRatio,
  evaluateTheme,
  parseColor,
  requiredContrast,
} from '../../scripts/theme-contrast-lib.mjs'

/**
 * 对比度门槛口径单测（P-20261019-4）：
 *   - 阈值必须由「实际渲染字号/字重/是否图形」决定，而不是语义角色；
 *   - 构造普通字号低对比 fixture 必须判红，同色对的大字号例外必须判绿；
 *   - 六主题现有令牌在空基线下全量通过（基线只剩合法项的机器化守卫）。
 * 被测核心在 scripts/theme-contrast-lib.mjs（CLI 只做读盘/基线/退出码）。
 */

const lowContrastColors = new Map([
  ['bg-primary', '#0d1117'],
  ['text-muted', '#6e7681'], // 旧值：4.12:1 —— 提案的审计实锚
])

function evaluateOne(usage: { kind: 'text'; sizePx: number; bold?: boolean } | { kind: 'graphic' }) {
  return evaluateTheme('fixture', lowContrastColors, [
    { fg: 'text-muted', bg: 'bg-primary', usage },
  ])[0]
}

describe('WCAG 门槛按实际字号绑定（不按语义角色）', () => {
  it('12px 常规文本 4.12:1 低于 4.5 → 必须红', () => {
    const row = evaluateOne({ kind: 'text', sizePx: 12 })
    expect(row.min).toBe(4.5)
    expect(row.level).toBe('fail')
    expect(row.ratio).toBeCloseTo(4.12, 2)
  })

  it('同一色对 24px 常规文本落入大字例外 → 必须绿', () => {
    const row = evaluateOne({ kind: 'text', sizePx: 24 })
    expect(row.min).toBe(3)
    expect(row.level).toBe('pass')
    expect(row.ratio).toBeCloseTo(4.12, 2)
  })

  it('18.66px 粗体起算大字；18.65px 粗体仍按 4.5', () => {
    expect(requiredContrast({ kind: 'text', sizePx: 18.66, bold: true })).toBe(3)
    expect(requiredContrast({ kind: 'text', sizePx: 18.65, bold: true })).toBe(4.5)
    expect(evaluateOne({ kind: 'text', sizePx: 18.66, bold: true }).level).toBe('pass')
    expect(evaluateOne({ kind: 'text', sizePx: 18.65, bold: true }).level).toBe('fail')
  })

  it('23.99px 常规文本未达 24px → 仍按 4.5 判红', () => {
    expect(requiredContrast({ kind: 'text', sizePx: 23.99 })).toBe(4.5)
    expect(evaluateOne({ kind: 'text', sizePx: 23.99 }).level).toBe('fail')
  })

  it('非文本图形（状态点/图标）固定 3:1 → 同色对判绿', () => {
    const row = evaluateOne({ kind: 'graphic' })
    expect(row.min).toBe(3)
    expect(row.level).toBe('pass')
  })

  it('var() 间接引用可穿透到色相锚点求值', () => {
    const colors = new Map([
      ['accent-blue', '#58a6ff'],
      ['status-running', 'var(--accent-blue)'],
    ])
    expect(parseColor('var(--status-running)', colors)).toEqual(parseColor('#58a6ff', colors))
  })
})

describe('六主题令牌守卫（空基线下全量通过 + 辅助档层级/占位符同源）', () => {
  it('PAIR_SPECS 全量通过（任何主题新增不达标即红）', () => {
    for (const [name, theme] of Object.entries(themeRegistry)) {
      const rows = evaluateTheme(name, new Map(Object.entries(theme.colors)), PAIR_SPECS)
      const fails = rows.filter((r) => r.level === 'fail')
      expect(
        fails,
        `${name} 不达标：${fails.map((f) => `${f.pair} ${f.detail}`).join('; ')}`,
      ).toHaveLength(0)
    }
  })

  it('text-muted 在 bg-primary / bg-panel 双底 ≥4.5，且弱于 text-secondary（层级不塌）', () => {
    for (const [name, theme] of Object.entries(themeRegistry)) {
      const colors = new Map(Object.entries(theme.colors))
      const muted = parseColor(colors.get('text-muted') ?? '', colors)
      const secondary = parseColor(colors.get('text-secondary') ?? '', colors)
      expect(muted, `${name} text-muted 缺失`).not.toBeNull()
      expect(secondary, `${name} text-secondary 缺失`).not.toBeNull()
      for (const bgKey of ['bg-primary', 'bg-panel']) {
        const bg = parseColor(colors.get(bgKey) ?? '', colors)
        expect(bg, `${name} ${bgKey} 缺失`).not.toBeNull()
        const ratio = contrastRatio(muted!, bg!)
        expect(ratio, `${name} text-muted/${bgKey} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5)
        expect(
          ratio,
          `${name} text-muted 不应比 text-secondary 更亮（层级差丢失）`,
        ).toBeLessThan(contrastRatio(secondary!, bg!))
      }
    }
  })

  it('Naive 占位符色与 text-muted 同源（防占位符回退到默认低对比档）', () => {
    for (const [name, theme] of Object.entries(themeRegistry)) {
      expect(
        theme.naiveOverrides.common?.placeholderColor,
        `${name} placeholderColor 未对齐 text-muted`,
      ).toBe(theme.colors['text-muted'])
    }
  })
})
