import { watch } from 'vue'
import { useTerminalThemeStore } from '../stores/terminal-theme'
import type { TerminalThemeDefinition, TerminalFontFamily } from '../terminal-themes/types'

// 字体 class 名与 html 元素 class 一一对应；移除时复用同一份列表避免硬编码散落
const FONT_CLASSES: Record<TerminalFontFamily, string> = {
  jetbrains: 'terminal-font-jetbrains',
  cascadia: 'terminal-font-cascadia',
  ibmplex: 'terminal-font-ibmplex',
  fira: 'terminal-font-fira',
}

// 跟踪上次写入的 cssVars key，切换主题时清理已不存在的变量，避免残留
let lastAppliedVarKeys = new Set<string>()

export function applyThemeToDocument(def: TerminalThemeDefinition, font: TerminalFontFamily): void {
  document.body.dataset.terminalTheme = def.name

  const root = document.documentElement.style
  const nextKeys = new Set(Object.keys(def.cssVars))
  // 写入新主题的所有变量
  for (const [key, value] of Object.entries(def.cssVars)) {
    root.setProperty(key, value)
  }
  // 清理上次写过、本次不再有的变量（防止 cyber-hud 的 --term-accent-secondary 残留到 classic）
  for (const oldKey of lastAppliedVarKeys) {
    if (!nextKeys.has(oldKey)) root.removeProperty(oldKey)
  }
  lastAppliedVarKeys = nextKeys

  // <html> 上的字体 class 唯一
  const html = document.documentElement
  for (const cls of Object.values(FONT_CLASSES)) html.classList.remove(cls)
  html.classList.add(FONT_CLASSES[font])

  // 仅深色主题叠 noise texture（浅色主题关闭避免影响可读性）
  document.body.classList.toggle('terminal-noise', def.isDark)
}

// 监听 terminal-theme store 的主题名 + 字体（两个 string，避免数组每次新引用触发无谓重渲染）
// 应用主题变化由 store 内部 resolveTerminalTheme 自动响应（直接读 themeStore.currentTheme），无需此处 watch
export function useTerminalTheme(): void {
  const store = useTerminalThemeStore()
  watch(
    () => [store.currentThemeName, store.currentFont] as const,
    ([, font]) => {
      try {
        applyThemeToDocument(store.currentThemeDef, font)
      } catch (e) {
        // DOM 异常时 store 已切到新值但渲染失败，至少留日志便于排查
        console.error('[terminal-theme] applyThemeToDocument failed', e)
      }
    },
    { immediate: true },
  )
}

// 测试用入口（绕过 store 直接应用，便于单测副作用）
export function applyThemeForTest(def: TerminalThemeDefinition, font: TerminalFontFamily): void {
  applyThemeToDocument(def, font)
}
