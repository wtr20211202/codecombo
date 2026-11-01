import type { TerminalThemeDefinition } from './types'

// Deep Space Console：深紫黑 + 青绿辉光
// 特征：starfield + cursor glow + ambient glow（紫色星点 + 青绿光晕）
export const deepSpace: TerminalThemeDefinition = {
  name: 'deep-space',
  label: 'settings.terminalTheme.deepSpace',
  description: 'settings.terminalTheme.description.deepSpace',
  isDark: true,
  colors: {
    background: '#0d0221',
    foreground: '#c8d8ff',
    cursor: '#00f5d4',
    cursorAccent: '#0d0221',
    selectionBackground: '#00f5d488',
    selectionForeground: '#ffffff',
    black: '#0d0221',
    red: '#ff5c8a',
    green: '#5cffba',
    yellow: '#ffd60a',
    blue: '#7c9eff',
    magenta: '#c77dff',
    cyan: '#00f5d4',
    white: '#c8d8ff',
    brightBlack: '#5a4a8a',
    brightRed: '#ff99b0',
    brightGreen: '#a0ffd4',
    brightYellow: '#ffe347',
    brightBlue: '#a5c2ff',
    brightMagenta: '#dca6ff',
    brightCyan: '#66ffe8',
    brightWhite: '#ffffff',
  },
  cssVars: {
    '--bg-terminal': '#0d0221',
    '--term-accent': '#00f5d4',
    '--term-accent-secondary': '#7c9eff',
  },
  effects: {
    scanline: 'none',
    textGlow: 'none',
    cursorGlow: 'strong',
    cornerBrackets: false,
    vignette: false,
    starfield: true,
    ambientGlow: 'rgba(0, 245, 212, 0.05)',
  },
  defaultFont: 'cascadia',
}
