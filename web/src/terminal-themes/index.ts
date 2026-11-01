import { classicDark } from './classic-dark'
import { classicLight } from './classic-light'
import { oneDark } from './one-dark'
import { dracula } from './dracula'
import { cyberHud } from './cyber-hud'
import { industrial } from './industrial'
import { deepSpace } from './deep-space'
import type { TerminalFontFamily, TerminalThemeDefinition } from './types'

// 主题注册表：新增主题只需在此注册
export const terminalThemeRegistry = {
  'classic-dark': classicDark,
  'classic-light': classicLight,
  'one-dark': oneDark,
  'dracula': dracula,
  'cyber-hud': cyberHud,
  'industrial': industrial,
  'deep-space': deepSpace,
} as const satisfies Record<string, TerminalThemeDefinition>

export type TerminalThemeName = keyof typeof terminalThemeRegistry

// fallback 主题名（无法识别 / 未设置时使用）
export const FALLBACK_TERMINAL_THEME = 'classic-dark'

// 应用明暗档位（应用主题 isDark 归一后的两档）
export type AppThemeGear = 'dark' | 'light'

// 应用明暗档位 → 终端主题映射（P-20261002-144 跟随应用明暗的档位表）。
// 键为应用主题 isDark 归一后的两档，不按具体应用主题名映射——one-dark 等
// 个性应用主题同样归入明暗档位，跟随语义保持「应用深则终端深」。
// 新增档位 = 扩表 + appThemeGear 取档适配（消费方只经档位取值）。
export const APP_GEAR_TERMINAL_THEMES = {
  dark: 'classic-dark',
  light: 'classic-light',
} as const satisfies Record<AppThemeGear, TerminalThemeName>

// 应用主题 isDark → 明暗档位（映射表取档的唯一入口，档位词汇集中在此）
export function appThemeGear(isDark: boolean): AppThemeGear {
  return isDark ? 'dark' : 'light'
}

// 字体标识 → xterm fontFamily 栈。设置页选的字体此前只落了 CSS class、
// 从未接进 xterm（内联样式优先级更高，class 被压住），这里作为唯一接线源：
// 首选字体打头，后跟通用回退栈；与 terminal-effects.css 的 @font-face 三套声明对应。
// 新增字体 = types.ts 加标识 + 此处登记 + terminal-effects.css 加 @font-face/class
export const XTERM_FONT_STACKS: Record<TerminalFontFamily, string> = {
  jetbrains: "'JetBrains Mono', 'Cascadia Code', Consolas, 'Courier New', monospace",
  cascadia: "'Cascadia Code', 'Fira Code', Consolas, 'Courier New', monospace",
  ibmplex: "'IBM Plex Mono', 'Cascadia Code', Consolas, 'Courier New', monospace",
  fira: "'Fira Code', 'JetBrains Mono', Consolas, 'Courier New', monospace",
}

// 按名查找主题，找不到返回 null（让调用方决定 fallback 策略）
export function getTerminalThemeByName(name: string): TerminalThemeDefinition | null {
  return (terminalThemeRegistry as Record<string, TerminalThemeDefinition>)[name] ?? null
}

// 解析最终生效的终端主题：用户已选 + 有效 → 用；否则 → FALLBACK
export function resolveTerminalTheme(saved: string): TerminalThemeDefinition {
  return getTerminalThemeByName(saved)
    ?? getTerminalThemeByName(FALLBACK_TERMINAL_THEME)
    ?? (() => { throw new Error(`terminal theme registry empty: cannot find fallback "${FALLBACK_TERMINAL_THEME}"`) })()
}
