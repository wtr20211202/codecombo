import { describe, expect, it } from 'vitest'
import { themeRegistry } from '../../themes'

// 主题适配完备性守护：四套皮肤必须暴露同一集合的 CSS 变量 / Monaco 颜色，
// 缺键会让组件在某主题下落到 var() 默认值或透明，表现为「某主题下发白/发黑」

const keys = Object.keys(themeRegistry)

function varKeys(colors: Record<string, string>): string[] {
  return Object.keys(colors).sort()
}

describe('themeRegistry 皮肤适配完备性', () => {
  it('至少包含 dark / light / one-dark / dracula 四套主题', () => {
    expect(keys).toEqual(expect.arrayContaining(['dark', 'light', 'one-dark', 'dracula']))
  })

  it('所有主题 CSS 变量键集合一致（缺键=某主题下样式塌陷）', () => {
    const base = varKeys(themeRegistry.dark!.colors)
    expect(base.length).toBeGreaterThan(10)
    for (const k of keys) {
      expect(varKeys(themeRegistry[k]!.colors), `主题 ${k} 的 CSS 变量键集合与 dark 不一致`).toEqual(base)
    }
  })

  it('所有主题 CSS 变量值非空字符串', () => {
    for (const k of keys) {
      for (const [name, value] of Object.entries(themeRegistry[k]!.colors)) {
        expect(typeof value === 'string' && value.length > 0, `主题 ${k} 变量 --${name} 为空`).toBe(true)
      }
    }
  })

  it('所有主题 Monaco 颜色键集合一致（编辑器皮肤适配）', () => {
    const base = Object.keys(themeRegistry.dark!.monacoColors).sort()
    for (const k of keys) {
      expect(Object.keys(themeRegistry[k]!.monacoColors).sort(), `主题 ${k} 的 Monaco 颜色键集合与 dark 不一致`).toEqual(base)
    }
  })

  it('所有主题声明 label 与 isDark', () => {
    for (const k of keys) {
      const t = themeRegistry[k]!
      expect(typeof t.label === 'string' && t.label.length > 0, `主题 ${k} 缺 label`).toBe(true)
      expect(typeof t.isDark === 'boolean', `主题 ${k} 缺 isDark`).toBe(true)
    }
  })

  // 状态徽标语义色四档（P-20261003-285）：映射表契约——四档语义名在所有主题
  // 恒指向同一语义色相变量（值为 var() 间接引用，主题气质微调只改 themes/*.ts
  // 的指向）；组件面禁直引色相 accent 承载状态语义，破坏映射即在此翻红
  it('状态徽标语义色四档映射表全主题一致（进行中/成功/失败/等待）', () => {
    const mapping = {
      'status-running': 'var(--accent-blue)',
      'status-success': 'var(--accent-green)',
      'status-failed': 'var(--accent-red)',
      'status-waiting': 'var(--accent-yellow-warm)',
    }
    for (const k of keys) {
      expect(themeRegistry[k]!.colors, `主题 ${k} 的状态语义色映射漂移`).toMatchObject(mapping)
    }
  })
})
