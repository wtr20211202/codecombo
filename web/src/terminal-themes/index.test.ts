import { describe, it, expect } from 'vitest'
import {
  terminalThemeRegistry,
  getTerminalThemeByName,
  resolveTerminalTheme,
  FALLBACK_TERMINAL_THEME,
  APP_GEAR_TERMINAL_THEMES,
  appThemeGear,
} from './index'

describe('terminal theme registry', () => {
  it('注册了 7 个主题', () => {
    expect(Object.keys(terminalThemeRegistry).length).toBe(7)
  })

  it('3 个新主题都至少声明了 scanline / cursorGlow / ambientGlow 之一', () => {
    const newThemes = ['cyber-hud', 'industrial', 'deep-space']
    for (const name of newThemes) {
      const def = terminalThemeRegistry[name as keyof typeof terminalThemeRegistry]
      const hasEffect = def.effects?.scanline || def.effects?.cursorGlow || def.effects?.ambientGlow
      expect(hasEffect, `${name} should have at least one effect`).toBeTruthy()
    }
  })

  it('每个主题的 colors 字段齐全（20 项必填）', () => {
    const required = [
      'background', 'foreground', 'cursor', 'selectionBackground',
      'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
      'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
      'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
    ]
    for (const [name, def] of Object.entries(terminalThemeRegistry)) {
      for (const key of required) {
        expect(def.colors[key as keyof typeof def.colors], `${name}.${key}`).toBeTruthy()
      }
    }
  })

  it('每个主题的 cssVars 必须含 --bg-terminal', () => {
    for (const [name, def] of Object.entries(terminalThemeRegistry)) {
      expect(def.cssVars['--bg-terminal'], `${name}.cssVars[--bg-terminal]`).toBeTruthy()
    }
  })

  it('getTerminalThemeByName 命中已注册', () => {
    expect(getTerminalThemeByName('classic-dark')?.name).toBe('classic-dark')
  })

  it('getTerminalThemeByName 未命中返回 null', () => {
    expect(getTerminalThemeByName('non-exist')).toBeNull()
  })

  it('resolveTerminalTheme 用户已选 + 有效 → 用用户的', () => {
    expect(resolveTerminalTheme('dracula').name).toBe('dracula')
  })

  it('resolveTerminalTheme 未知 / 空字符串 → 用 FALLBACK', () => {
    expect(resolveTerminalTheme('').name).toBe(FALLBACK_TERMINAL_THEME)
    expect(resolveTerminalTheme('unknown').name).toBe(FALLBACK_TERMINAL_THEME)
  })
})

describe('应用明暗档位映射（P-20261002-144 跟随模式）', () => {
  it('appThemeGear：isDark 布尔 → dark/light 档位', () => {
    expect(appThemeGear(true)).toBe('dark')
    expect(appThemeGear(false)).toBe('light')
  })

  it('映射表档位齐全且都指向已注册主题', () => {
    for (const gear of ['dark', 'light'] as const) {
      const name = APP_GEAR_TERMINAL_THEMES[gear]
      expect(getTerminalThemeByName(name), `${gear} → ${name} 应已注册`).not.toBeNull()
    }
  })

  it('映射语义：深档映射主题 isDark、浅档映射主题非 isDark（应用深则终端深）', () => {
    expect(terminalThemeRegistry[APP_GEAR_TERMINAL_THEMES.dark].isDark).toBe(true)
    expect(terminalThemeRegistry[APP_GEAR_TERMINAL_THEMES.light].isDark).toBe(false)
  })

  it('档位经 resolveTerminalTheme 可直接解析（store 取值路径畅通）', () => {
    expect(resolveTerminalTheme(APP_GEAR_TERMINAL_THEMES[appThemeGear(true)]).name).toBe('classic-dark')
    expect(resolveTerminalTheme(APP_GEAR_TERMINAL_THEMES[appThemeGear(false)]).name).toBe('classic-light')
  })
})
