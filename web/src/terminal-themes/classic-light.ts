import type { TerminalThemeDefinition } from './types'
import { NO_EFFECTS } from './types'

// 经典浅色终端主题——从 themes/light.ts terminalColors 抽离
export const classicLight: TerminalThemeDefinition = {
  name: 'classic-light',
  label: 'settings.terminalTheme.classicLight',
  isDark: false,
  colors: {
    background: '#f6f8fa',
    foreground: '#1f2328',
    cursor: '#0969da',
    selectionBackground: '#b6d4ff',
    selectionForeground: '#1f2328',
    black: '#24292f',
    red: '#cf222e',
    green: '#116329',
    yellow: '#4d2d00',
    blue: '#0550ae',
    magenta: '#8250df',
    cyan: '#0a3069',
    white: '#6e7781',
    brightBlack: '#57606a',
    brightRed: '#a40e26',
    brightGreen: '#1a7f37',
    brightYellow: '#633c01',
    brightBlue: '#0969da',
    brightMagenta: '#953800',
    brightCyan: '#0c4a6e',
    brightWhite: '#24292f',
  },
  cssVars: {
    '--bg-terminal': '#f6f8fa',
  },
  effects: NO_EFFECTS,
  defaultFont: 'jetbrains',
}
