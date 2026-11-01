// 终端主题与字体的类型定义
// 与应用主题（web/src/themes/）解耦：终端主题专注 xterm 配色 + 终端区特效

/** 内嵌终端字体标识 */
export type TerminalFontFamily = 'jetbrains' | 'cascadia' | 'ibmplex' | 'fira'

/** 特效强度三档 */
export type EffectStrength = 'none' | 'subtle' | 'strong'

/** 终端主题定义接口 */
export interface TerminalThemeDefinition {
  /** 唯一标识，存到 settings.terminalTheme */
  name: string
  /** 设置页展示名（i18n key，如 'settings.terminalTheme.cyberHud'） */
  label: string
  /** 设置页展示描述（i18n key） */
  description?: string
  /** 是否深色（决定 scrollbar 主题等） */
  isDark: boolean

  /** xterm ITheme 颜色字段（ANSI 16 色 + 背景/前景/cursor/selection） */
  colors: {
    background: string
    foreground: string
    cursor: string
    cursorAccent?: string
    selectionBackground: string
    selectionForeground?: string
    black: string
    red: string
    green: string
    yellow: string
    blue: string
    magenta: string
    cyan: string
    white: string
    brightBlack: string
    brightRed: string
    brightGreen: string
    brightYellow: string
    brightBlue: string
    brightMagenta: string
    brightCyan: string
    brightWhite: string
  }

  /** 终端区 CSS 变量，必须包含 `--bg-terminal`（与 colors.background 一致或略浅） */
  cssVars: Record<string, string>

  /** 视觉效果开关（不同主题可启用不同特效） */
  effects?: {
    scanline?: EffectStrength
    textGlow?: EffectStrength
    cursorGlow?: EffectStrength
    cornerBrackets?: boolean
    vignette?: boolean
    starfield?: boolean
    ambientGlow?: string | false
  }

  /** 该主题推荐字体（用户可在设置中覆盖） */
  defaultFont?: TerminalFontFamily
}

/** 经典主题（无任何特效）共享的 effects 占位，避免在每个老主题文件里复制粘贴 7 行 false/none */
export const NO_EFFECTS: NonNullable<TerminalThemeDefinition['effects']> = {
  scanline: 'none',
  textGlow: 'none',
  cursorGlow: 'none',
  cornerBrackets: false,
  vignette: false,
  starfield: false,
  ambientGlow: false,
}
