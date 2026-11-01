import type { TerminalThemeDefinition } from './types'
import { NO_EFFECTS } from './types'

// One Dark 终端主题——从 themes/one-dark.ts terminalColors 抽离
export const oneDark: TerminalThemeDefinition = {
  name: 'one-dark',
  label: 'settings.terminalTheme.oneDark',
  isDark: true,
  colors: {
    background: '#282c34',
    foreground: '#abb2bf',
    cursor: '#528bff',
    selectionBackground: '#3e4451',
    selectionForeground: '#ffffff',
    black: '#282c34',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#abb2bf',
    brightBlack: '#5c6370',
    brightRed: '#e06c75',
    brightGreen: '#98c379',
    brightYellow: '#e5c07b',
    brightBlue: '#61afef',
    brightMagenta: '#c678dd',
    brightCyan: '#56b6c2',
    brightWhite: '#ffffff',
  },
  cssVars: {
    '--bg-terminal': '#282c34',
  },
  effects: { ...NO_EFFECTS, cursorGlow: 'subtle' },
  defaultFont: 'jetbrains',
}
