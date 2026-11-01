import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { initSettingsSync } from '@/utils/settingsSync'
import { useThemeStore, THEME_SETTINGS_KEY } from '@/stores/theme'
import { useLocaleStore } from '@/stores/locale'
import { LOCALE_STORAGE_KEY } from '@/stores/locale-constants'
import { useFontStore, FONT_SETTINGS_KEY } from '@/stores/font'
import { useUiZoomStore, UI_ZOOM_STORAGE_KEY } from '@/stores/ui-zoom'
import { useTerminalThemeStore, TERMINAL_THEME_FOLLOW_KEY } from '@/stores/terminal-theme'

// 跨标签本地设置同步（P-20261002-36）单测：storage 事件在 jsdom 不自动派发，
// 手动 dispatchEvent 模拟「另一标签页写入」——浏览器语义下该事件只会因他页写入
// 触发，单测口径与真实语义一致。断言载体与生产链一致：store 静默重读后应用到
// documentElement 的内联 CSS 变量（theme/font/zoom）；locale 走真实 i18n 链。

/** 模拟另一标签页对 localStorage 的写入（先落盘再派发，与真实顺序一致） */
function emitStorage(key: string | null, newValue: string | null) {
  window.dispatchEvent(new StorageEvent('storage', { key, newValue }))
}

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('settingsSync（跨标签本地设置实时同步）', () => {
  it('theme-settings 他页写入 → theme store 静默重读并应用 CSS 变量', async () => {
    const store = useThemeStore()
    useFontStore(); useUiZoomStore(); useLocaleStore() // 分发表注册所需的全部 store
    expect(store.currentTheme).toBe('dark') // jsdom 无 matchMedia → 初始 dark
    const dispose = initSettingsSync()
    localStorage.setItem(THEME_SETTINGS_KEY, 'light')
    emitStorage(THEME_SETTINGS_KEY, 'light')
    expect(store.currentTheme).toBe('light')
    expect(store.isDark).toBe(false)
    await nextTick() // theme 的 CSS 变量应用走 watch（pre-flush 异步）
    expect(document.documentElement.style.getPropertyValue('--bg-primary')).toBe('#ffffff')
    dispose()
  })

  it('theme-settings 脏值 → 回退 OS 映射（无 matchMedia 环境 = dark）', () => {
    const store = useThemeStore()
    useFontStore(); useUiZoomStore(); useLocaleStore()
    store.setTheme('light')
    const dispose = initSettingsSync()
    localStorage.setItem(THEME_SETTINGS_KEY, 'bogus-theme')
    emitStorage(THEME_SETTINGS_KEY, 'bogus-theme')
    expect(store.currentTheme).toBe('dark')
    dispose()
  })

  it('他页显式选择后 OS 偏好变化不再跟随（跨标签选择同享用户已选语义）', () => {
    const schemeListeners = new Set<(e: MediaQueryListEvent) => void>()
    let mqlMatches = true
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      matches: mqlMatches,
      media: query,
      addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => { schemeListeners.add(cb) },
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })))
    const store = useThemeStore()
    useFontStore(); useUiZoomStore(); useLocaleStore()
    expect(store.currentTheme).toBe('light')
    const dispose = initSettingsSync()
    // 他页写入同一主题：合法存储 → userChosen=true（与首跑「有存储即尊重」同口径）
    localStorage.setItem(THEME_SETTINGS_KEY, 'light')
    emitStorage(THEME_SETTINGS_KEY, 'light')
    mqlMatches = false
    schemeListeners.forEach(cb => cb({ matches: false } as MediaQueryListEvent))
    expect(store.currentTheme).toBe('light')
    dispose()
  })

  it('locale-settings 他页写入 → locale store 静默跟随（复用 setLocale 全链路）', async () => {
    const store = useLocaleStore()
    useThemeStore(); useFontStore(); useUiZoomStore()
    const dispose = initSettingsSync()
    localStorage.setItem(LOCALE_STORAGE_KEY, 'en-US')
    emitStorage(LOCALE_STORAGE_KEY, 'en-US')
    await vi.waitFor(() => expect(store.currentLocale).toBe('en-US'))
    dispose()
  })

  it('locale-settings 脏值/同值 → no-op', async () => {
    const store = useLocaleStore()
    useThemeStore(); useFontStore(); useUiZoomStore()
    const dispose = initSettingsSync()
    localStorage.setItem(LOCALE_STORAGE_KEY, 'fr-FR')
    emitStorage(LOCALE_STORAGE_KEY, 'fr-FR')
    localStorage.setItem(LOCALE_STORAGE_KEY, 'zh-CN')
    emitStorage(LOCALE_STORAGE_KEY, 'zh-CN')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(store.currentLocale).toBe('zh-CN')
    dispose()
  })

  it('font-settings 他页写入 → font store 重读并应用字号变量', () => {
    const store = useFontStore()
    useThemeStore(); useUiZoomStore(); useLocaleStore()
    expect(store.sizes.base).toBe(13)
    const dispose = initSettingsSync()
    localStorage.setItem(FONT_SETTINGS_KEY, JSON.stringify({ sizes: { base: 16 } }))
    emitStorage(FONT_SETTINGS_KEY, JSON.stringify({ sizes: { base: 16 } }))
    expect(store.sizes.base).toBe(16)
    expect(document.documentElement.style.getPropertyValue('--fs-base')).toBe('16px')
    dispose()
  })

  it('ui-zoom-settings 他页写入 → zoom store 重读并应用缩放变量', () => {
    const store = useUiZoomStore()
    useThemeStore(); useFontStore(); useLocaleStore()
    expect(store.level).toBe(1)
    const dispose = initSettingsSync()
    localStorage.setItem(UI_ZOOM_STORAGE_KEY, JSON.stringify({ level: 1.25 }))
    emitStorage(UI_ZOOM_STORAGE_KEY, JSON.stringify({ level: 1.25 }))
    expect(store.level).toBe(1.25)
    expect(document.documentElement.style.getPropertyValue('--ui-zoom')).toBe('1.25')
    dispose()
  })

  it('terminal-theme-follow 他页写入 → 跟随开关静默重读（生效主题随之切换）', () => {
    const theme = useThemeStore()
    const terminal = useTerminalThemeStore()
    useFontStore(); useUiZoomStore(); useLocaleStore()
    expect(terminal.followAppTheme).toBe(true)
    const dispose = initSettingsSync()
    // 他页解绑 → 本页跟随关（生效主题从档位映射回到手工选择）
    localStorage.setItem(TERMINAL_THEME_FOLLOW_KEY, 'off')
    emitStorage(TERMINAL_THEME_FOLLOW_KEY, 'off')
    expect(terminal.followAppTheme).toBe(false)
    // 他页重新绑定 → 本页恢复跟随（jsdom 应用 dark 档 → classic-dark）
    localStorage.setItem(TERMINAL_THEME_FOLLOW_KEY, 'on')
    emitStorage(TERMINAL_THEME_FOLLOW_KEY, 'on')
    expect(terminal.followAppTheme).toBe(true)
    expect(terminal.currentThemeName).toBe('classic-dark')
    expect(theme.currentTheme).toBe('dark')
    dispose()
  })

  it('未登记的 key → 各 store 均不受影响', () => {
    const theme = useThemeStore()
    const locale = useLocaleStore()
    const font = useFontStore()
    const zoom = useUiZoomStore()
    const dispose = initSettingsSync()
    localStorage.setItem('some-other-key', 'x')
    emitStorage('some-other-key', 'x')
    expect(theme.currentTheme).toBe('dark')
    expect(locale.currentLocale).toBe('zh-CN')
    expect(font.sizes.base).toBe(13)
    expect(zoom.level).toBe(1)
    dispose()
  })

  it('e.key = null（localStorage.clear 事件）→ 忽略不误触发（只按具体 key 分发）', () => {
    const theme = useThemeStore()
    const zoom = useUiZoomStore()
    useLocaleStore(); useFontStore()
    const dispose = initSettingsSync()
    localStorage.setItem(THEME_SETTINGS_KEY, 'light')
    emitStorage(THEME_SETTINGS_KEY, 'light')
    localStorage.setItem(UI_ZOOM_STORAGE_KEY, JSON.stringify({ level: 1.25 }))
    emitStorage(UI_ZOOM_STORAGE_KEY, JSON.stringify({ level: 1.25 }))
    expect(theme.currentTheme).toBe('light')
    expect(zoom.level).toBe(1.25)
    // clear 事件（key=null）：项目零调用且 font/zoom 读回「有值才覆盖」口径下
    // 不做全量重读——忽略，各 store 保持当前值
    localStorage.clear()
    emitStorage(null, null)
    expect(theme.currentTheme).toBe('light')
    expect(zoom.level).toBe(1.25)
    dispose()
  })

  it('dispose 卸载监听后不再分发', () => {
    const theme = useThemeStore()
    useFontStore(); useUiZoomStore(); useLocaleStore()
    const dispose = initSettingsSync()
    dispose()
    localStorage.setItem(THEME_SETTINGS_KEY, 'light')
    emitStorage(THEME_SETTINGS_KEY, 'light')
    expect(theme.currentTheme).toBe('dark')
  })
})
