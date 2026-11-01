import type { GlobalTheme, GlobalThemeOverrides } from 'naive-ui'
import { dark as darkTheme } from './dark'
import { light as lightTheme } from './light'
import { oneDark as oneDarkTheme } from './one-dark'
import { dracula as draculaTheme } from './dracula'
import { dshLight as dshLightTheme } from './dsh-light'
import { dshDark as dshDarkTheme } from './dsh-dark'

/** 主题选择器预览卡的三段色条（由 registry 驱动渲染，不再逐主题硬编码 CSS） */
export interface ThemePreview {
  canvas: string
  surface: string
  accentFrom: string
  accentTo: string
}

export interface ThemeDefinition {
  name: string
  label: string
  colors: Record<string, string>
  isDark: boolean
  preview: ThemePreview
  naiveTheme: GlobalTheme | null
  naiveOverrides: GlobalThemeOverrides
  monacoBase: 'vs' | 'vs-dark' | 'hc-black'
  monacoColors: Record<string, string>
  monacoRules: Array<{ token: string; foreground?: string; fontStyle?: string }>
}

export const themeRegistry = {
  'dark': darkTheme,
  'light': lightTheme,
  'one-dark': oneDarkTheme,
  'dracula': draculaTheme,
  'dsh-light': dshLightTheme,
  'dsh-dark': dshDarkTheme,
} as const satisfies Record<string, ThemeDefinition>

export type ThemeKey = keyof typeof themeRegistry

/**
 * 无用户存储时的默认主题：跟随 OS 深浅色偏好（对标 VS Code/JetBrains 默认行为）。
 * one-dark/dracula 等个性主题属用户主动选择项，不参与默认映射。
 */
export function systemDefaultThemeKey(prefersLight: boolean): ThemeKey {
  return prefersLight ? 'light' : 'dark'
}

/**
 * 解析初始主题（三段式）：
 * ① 有合法存储 → 用户已手动选择，永远尊重；
 * ② 无存储/存储值已失效 → 按 OS prefers-color-scheme 映射 light/dark。
 * early-init.ts（Vue mount 前防闪）与 stores/theme.ts 共用，保证双源一致。
 */
export function resolveInitialThemeKey(saved: string | null, prefersLight: boolean): ThemeKey {
  if (saved && saved in themeRegistry) return saved as ThemeKey
  return systemDefaultThemeKey(prefersLight)
}

/**
 * 读取 OS 是否偏好浅色。matchMedia 不可用的环境（jsdom 单测等）按 dark 处理，
 * 与历史默认行为一致。
 */
export function prefersColorSchemeLight(): boolean {
  return typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: light)').matches
}
