import type { TerminalThemeDefinition } from './types'

// Industrial Brutalist：琥珀单色 CRT，纯黑背景
// 特征：strong scanline + strong text glow + vignette + strong cursor glow
export const industrial: TerminalThemeDefinition = {
  name: 'industrial',
  label: 'settings.terminalTheme.industrial',
  description: 'settings.terminalTheme.description.industrial',
  isDark: true,
  colors: {
    background: '#000000',
    foreground: '#ffb000',
    cursor: '#ffd24d',
    cursorAccent: '#000000',
    selectionBackground: '#ffb00088',
    selectionForeground: '#ffffff',
    black: '#000000',
    red: '#ff3333',
    green: '#00ff66',
    yellow: '#ffb000',
    blue: '#4d9fff',
    magenta: '#ff66a3',
    cyan: '#66ffe0',
    white: '#ffd24d',
    brightBlack: '#6e4d00',
    brightRed: '#ff6666',
    brightGreen: '#66ffa6',
    brightYellow: '#ffd24d',
    brightBlue: '#80bfff',
    brightMagenta: '#ff99c2',
    brightCyan: '#99ffea',
    brightWhite: '#ffffff',
  },
  cssVars: {
    '--bg-terminal': '#000000',
    '--term-accent': '#ffb000',
    '--term-accent-secondary': '#ffb000',
  },
  effects: {
    scanline: 'strong',
    textGlow: 'strong',
    cursorGlow: 'strong',
    cornerBrackets: false,
    vignette: true,
    starfield: false,
    ambientGlow: 'rgba(255, 176, 0, 0.06)',
  },
  defaultFont: 'ibmplex',
}
