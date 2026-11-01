import * as monaco from 'monaco-editor'
import type { useThemeStore } from '../stores/theme'
import type { DiffPalette } from '../stores/font'
import { resolveDiffPair, colorblindMonacoOverrides } from '../themes/diffPalette'

/** Monaco 主题定义与切换。diffPalette（P-20261006-5）缺省 standard——标准档
 *  monacoColors 原值零触碰；色弱档仅覆盖 diff* 六键（背景四键按色弱对派生 +
 *  内联词条边框），编辑器其余颜色不受档位影响。调用方在主题或档位变更时重调
 *  （setTheme 对同名主题重广播，挂载中的编辑器即时换装） */
export function applyMonacoTheme(themeStore: ReturnType<typeof useThemeStore>, diffPalette: DiffPalette = 'standard') {
  const themeName = `codecombo-${themeStore.currentTheme}`
  const colors = { ...themeStore.themeDef.monacoColors }
  if (diffPalette === 'colorblind') {
    Object.assign(colors, colorblindMonacoOverrides(resolveDiffPair(themeStore.themeDef.colors, diffPalette)))
  }
  monaco.editor.defineTheme(themeName, {
    base: themeStore.themeDef.monacoBase,
    inherit: true,
    rules: themeStore.themeDef.monacoRules,
    colors,
  })
  monaco.editor.setTheme(themeName)
}
