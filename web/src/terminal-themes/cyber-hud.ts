import type { TerminalThemeDefinition } from './types'

// Cyber HUD 主题：青色霓虹 + 品红辅助，深蓝黑背景
// 特征：subtle scanline + corner brackets + cursor glow + ambient glow
export const cyberHud: TerminalThemeDefinition = {
  name: 'cyber-hud',
  label: 'settings.terminalTheme.cyberHud',
  description: 'settings.terminalTheme.description.cyberHud',
  isDark: true,
  colors: {
    background: '#0a0e1a',
    foreground: '#c8d3e6',
    cursor: '#00f0ff',
    cursorAccent: '#0a0e1a',
    selectionBackground: '#00f0ff88',
    selectionForeground: '#ffffff',
    black: '#0a0e1a',
    red: '#ff4d6d',
    green: '#5cff5c',
    yellow: '#ffb84d',
    blue: '#00f0ff',
    magenta: '#ff2d95',
    cyan: '#00f0ff',
    white: '#c8d3e6',
    brightBlack: '#5a6a85',
    brightRed: '#ff8095',
    brightGreen: '#a0ffa0',
    brightYellow: '#ffd24d',
    brightBlue: '#66f5ff',
    brightMagenta: '#ff66b0',
    brightCyan: '#66f5ff',
    brightWhite: '#ffffff',
  },
  cssVars: {
    '--bg-terminal': '#0a0e1a',
    '--term-accent': '#00f0ff',
    '--term-accent-secondary': '#ff2d95',
  },
  effects: {
    scanline: 'subtle',
    textGlow: 'subtle',
    cursorGlow: 'strong',
    cornerBrackets: true,
    vignette: false,
    starfield: false,
    ambientGlow: 'rgba(0, 240, 255, 0.05)',
  },
  defaultFont: 'jetbrains',
}
