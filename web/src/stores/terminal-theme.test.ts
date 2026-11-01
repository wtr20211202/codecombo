import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useTerminalThemeStore, TERMINAL_THEME_FOLLOW_KEY } from './terminal-theme'
import { useThemeStore } from './theme'
import { useFontStore } from './font'
import { XTERM_FONT_STACKS } from '../terminal-themes'

// mock settingsApi
vi.mock('../api/client', () => ({
  settingsApi: {
    get: vi.fn().mockResolvedValue({ data: {} }),
    update: vi.fn().mockResolvedValue({}),
  },
}))

describe('terminal-theme store', () => {
  beforeEach(() => {
    localStorage.removeItem(TERMINAL_THEME_FOLLOW_KEY)
    setActivePinia(createPinia())
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('初始 savedThemeName = classic-dark（FALLBACK）', () => {
    const store = useTerminalThemeStore()
    expect(store.savedThemeName).toBe('classic-dark')
  })

  it('初始 currentThemeName = classic-dark（jsdom 无 matchMedia → 应用默认 dark 档映射）', () => {
    const store = useTerminalThemeStore()
    expect(store.currentThemeName).toBe('classic-dark')
  })

  it('跟随默认开', () => {
    const store = useTerminalThemeStore()
    expect(store.followAppTheme).toBe(true)
  })

  it('跟随中应用主题切换 → 终端主题按明暗档位实时联动', () => {
    const theme = useThemeStore()
    const store = useTerminalThemeStore()
    expect(store.currentThemeName).toBe('classic-dark')
    theme.setTheme('light')
    expect(store.currentThemeName).toBe('classic-light')
    theme.setTheme('dark')
    expect(store.currentThemeName).toBe('classic-dark')
  })

  it('跟随中 setTheme：savedThemeName 记录手工选择但不生效（挂起）', async () => {
    const store = useTerminalThemeStore()
    const ok = await store.setTheme('dracula')
    expect(ok).toBe(true)
    expect(store.savedThemeName).toBe('dracula')
    expect(store.currentThemeName).toBe('classic-dark') // 跟随映射仍盖住
  })

  it('setFollowAppTheme(false) → 解绑，锁 savedThemeName 生效；应用主题再切不跟随', () => {
    const theme = useThemeStore()
    const store = useTerminalThemeStore()
    store.setTheme('dracula')
    store.setFollowAppTheme(false)
    expect(store.currentThemeName).toBe('dracula')
    theme.setTheme('light')
    expect(store.currentThemeName).toBe('dracula') // 不跟随
  })

  it('setFollowAppTheme 持久化 localStorage，新 store 实例读回', () => {
    let store = useTerminalThemeStore()
    store.setFollowAppTheme(false)
    expect(localStorage.getItem(TERMINAL_THEME_FOLLOW_KEY)).toBe('off')
    setActivePinia(createPinia())
    store = useTerminalThemeStore()
    expect(store.followAppTheme).toBe(false)
    expect(store.currentThemeName).toBe('classic-dark') // 解绑后 = savedThemeName（未手工选 = 默认）

    store.setFollowAppTheme(true)
    expect(localStorage.getItem(TERMINAL_THEME_FOLLOW_KEY)).toBe('on')
    setActivePinia(createPinia())
    expect(useTerminalThemeStore().followAppTheme).toBe(true)
  })

  it('syncFollowFromStorage：存储 off → 关；缺失 → 恢复默认跟随', () => {
    const store = useTerminalThemeStore()
    localStorage.setItem(TERMINAL_THEME_FOLLOW_KEY, 'off')
    store.syncFollowFromStorage()
    expect(store.followAppTheme).toBe(false)
    localStorage.removeItem(TERMINAL_THEME_FOLLOW_KEY)
    store.syncFollowFromStorage()
    expect(store.followAppTheme).toBe(true)
  })

  it('setTheme("unknown") → 返回 false，savedThemeName 不变', async () => {
    const store = useTerminalThemeStore()
    const old = store.savedThemeName
    const ok = await store.setTheme('unknown-theme')
    expect(ok).toBe(false)
    expect(store.savedThemeName).toBe(old)
  })

  it('setFont("cascadia") → 持久化', async () => {
    const store = useTerminalThemeStore()
    const ok = await store.setFont('cascadia')
    expect(ok).toBe(true)
    expect(store.currentFont).toBe('cascadia')
  })

  it('setFont 失败时回滚（update reject）', async () => {
    const { settingsApi } = await import('../api/client')
    ;(settingsApi.update as unknown as { mockRejectedValueOnce: (v: unknown) => void }).mockRejectedValueOnce(new Error('network'))
    const store = useTerminalThemeStore()
    const ok = await store.setFont('ibmplex')
    expect(ok).toBe(false)
    expect(store.currentFont).toBe('jetbrains') // 回滚到默认
  })

  it('hydrate 收到空 terminalTheme → fallback 到 classic-dark', () => {
    const store = useTerminalThemeStore()
    store.hydrate({ terminalTheme: '', terminalFont: 'cascadia' })
    expect(store.savedThemeName).toBe('classic-dark')
    expect(store.currentFont).toBe('cascadia')
  })

  it('hydrate 收到未知 terminalTheme → fallback 到 classic-dark', () => {
    const store = useTerminalThemeStore()
    store.hydrate({ terminalTheme: 'made-up' })
    expect(store.savedThemeName).toBe('classic-dark')
  })

  it('load 后 savedThemeName 从后端读取', async () => {
    const { settingsApi } = await import('../api/client')
    ;(settingsApi.get as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce({
      data: { terminalTheme: 'one-dark', terminalFont: 'ibmplex' },
    })
    const store = useTerminalThemeStore()
    await store.load()
    expect(store.savedThemeName).toBe('one-dark')
    expect(store.currentFont).toBe('ibmplex')
  })

  // 自定义等宽字体名（P-20261005-227）：xterm 不走 CSS var，currentFontStack
  // 前插段是终端侧唯一生效点
  it('未设自定义名 → currentFontStack 即预设栈原样', () => {
    const store = useTerminalThemeStore()
    expect(store.currentFontStack).toBe(XTERM_FONT_STACKS.jetbrains)
  })

  it('设置自定义名 → 前插 \'名\', 预设栈 回退链；清空回预设栈', () => {
    const font = useFontStore()
    const store = useTerminalThemeStore()
    const base = store.currentFontStack
    expect(base).toBe(XTERM_FONT_STACKS.jetbrains)

    font.setMonoFontName('Fira Code')
    expect(store.currentFontStack).toBe(`'Fira Code', ${XTERM_FONT_STACKS.jetbrains}`)

    font.setMonoFontName('')
    expect(store.currentFontStack).toBe(XTERM_FONT_STACKS.jetbrains)
  })
})
