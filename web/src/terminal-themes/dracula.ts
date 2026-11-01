import type { TerminalThemeDefinition } from './types'
import { NO_EFFECTS } from './types'

// Dracula 终端主题——从 themes/dracula.ts terminalColors 抽离
export const dracula: TerminalThemeDefinition = {
  name: 'dracula',
  label: 'settings.terminalTheme.dracula',
  isDark: true,
  colors: {
    background: '#282a36',
    foreground: '#f8f8f2',
    cursor: '#f8f8f2',
    selectionBackground: '#6272a4',
    selectionForeground: '#ffffff',
    black: '#21222c',
    red: '#ff5555',
    green: '#50fa7b',
    yellow: '#f1fa8c',
    blue: '#bd93f9',
    magenta: '#ff79c6',
    cyan: '#8be9fd',
    white: '#f8f8f2',
    brightBlack: '#6272a4',
    brightRed: '#ff6e6e',
    brightGreen: '#69ff94',
    brightYellow: '#ffffa5',
    brightBlue: '#d6acff',
    brightMagenta: '#ff92df',
    brightCyan: '#a4ffff',
    brightWhite: '#ffffff',
  },
  cssVars: {
    '--bg-terminal': '#282a36',
  },
  effects: {
    ...NO_EFFECTS,
    cursorGlow: 'subtle',
    ambientGlow: 'rgba(189, 147, 249, 0.04)',
  },
  defaultFont: 'jetbrains',
}
