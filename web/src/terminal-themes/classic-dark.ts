import type { TerminalThemeDefinition } from './types'
import { NO_EFFECTS } from './types'

// 经典深色终端主题——从 themes/dark.ts terminalColors 抽离
// 配色与原 dark 主题完全一致，确保老用户升级视觉零变化
export const classicDark: TerminalThemeDefinition = {
  name: 'classic-dark',
  label: 'settings.terminalTheme.classicDark',
  isDark: true,
  colors: {
    background: '#1e1e1e',
    foreground: '#d4d4d4',
    cursor: '#58a6ff',
    selectionBackground: '#264f78',
    selectionForeground: '#ffffff',
    black: '#000000',
    red: '#cd3131',
    green: '#0dbc79',
    yellow: '#e5e510',
    blue: '#2472c8',
    magenta: '#bc3fbc',
    cyan: '#11a8cd',
    white: '#e5e5e5',
    brightBlack: '#666666',
    brightRed: '#f14c4c',
    brightGreen: '#23d18b',
    brightYellow: '#f5f543',
    brightBlue: '#3b8eea',
    brightMagenta: '#d670d6',
    brightCyan: '#29d8f5',
    brightWhite: '#ffffff',
  },
  // --bg-terminal 与 colors.background 一致，避免主题切换瞬间露色
  cssVars: {
    '--bg-terminal': '#1e1e1e',
  },
  effects: NO_EFFECTS,
  defaultFont: 'jetbrains',
}
