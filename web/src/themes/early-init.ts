import { themeRegistry, resolveInitialThemeKey, prefersColorSchemeLight } from './index'
import { applyThemeColorMeta } from './themeColor'
import { resolveDiffPair } from './diffPalette'
import { FONT_SETTINGS_KEY, type DiffPalette } from '../stores/font'
import { safeStorage } from '../utils/storage'

// localStorage key 与 stores/theme.ts 保持一致
const THEME_STORAGE_KEY = 'theme-settings'

/**
 * 在 Vue mount 之前同步应用主题 CSS 变量
 *
 * 避免首屏渲染时 CSS 变量未注入 document root，
 * 导致 .app-boot-loading 的 var(--bg-primary) 解析失败、背景透明，
 * 进而透出下方的 LockScreenOverlay。
 *
 * 实现与 useThemeStore.apply() 保持一致：把 theme.colors 写入
 * document.documentElement.style，避免双源不一致。
 */
export function applyThemeEarly(): void {
  // 与 stores/theme.ts 三段式同源：有合法存储尊重用户，无存储跟随 OS 深浅色
  const saved = safeStorage.getItem(THEME_STORAGE_KEY)
  const key = resolveInitialThemeKey(saved, prefersColorSchemeLight())
  const theme = themeRegistry[key]
  if (!theme || !theme.colors) return

  const root = document.documentElement.style
  for (const [k, v] of Object.entries(theme.colors)) {
    root.setProperty(`--${k}`, v)
  }
  // diff 色板首帧同源（P-20261006-5）：档位持久化在 font-settings（Pinia 未起，
  // 直接读存储；值域外回标准档与 font store load 消毒同口径）——色弱档用户刷新
  // 首帧即蓝橙，不闪一帧标准红绿
  const diffPair = resolveDiffPair(theme.colors, readDiffPaletteEarly())
  root.setProperty('--diff-added', diffPair.added)
  root.setProperty('--diff-removed', diffPair.removed)
  // 与 useThemeStore.apply() 保持一致：首屏即声明 color-scheme，避免 autofill 白底闪现
  root.colorScheme = theme.isDark ? 'dark' : 'light'
  // theme-color 同步提前到 mount 前：安装态首帧状态栏即目标色，不闪默认深色
  applyThemeColorMeta(theme)
}

/** mount 前读色板档（font store 未起，直接解析 font-settings 存储；脏值/缺档回标准档） */
function readDiffPaletteEarly(): DiffPalette {
  try {
    const raw = safeStorage.getItem(FONT_SETTINGS_KEY)
    if (!raw) return 'standard'
    const parsed = JSON.parse(raw) as { diffPalette?: unknown }
    return parsed.diffPalette === 'colorblind' ? 'colorblind' : 'standard'
  } catch {
    return 'standard'
  }
}
