import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useThemeStore } from '@/stores/theme'

// matchMedia mock：jsdom 未实现 matchMedia，theme store 的 OS 偏好检测与
// 运行期跟随监听都依赖它。stubGlobal 会同步落到 window（jsdom 中两者同一对象）
let schemeListeners: Set<(e: MediaQueryListEvent) => void>
let mqlMatches: boolean

function mockMatchMedia(initialMatches: boolean) {
  mqlMatches = initialMatches
  schemeListeners = new Set()
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
    matches: mqlMatches,
    media: query,
    addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => { schemeListeners.add(cb) },
    removeEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => { schemeListeners.delete(cb) },
    addListener: vi.fn(),
    removeListener: vi.fn(),
  })))
}

/** 模拟 OS 深浅色偏好变化（prefers-color-scheme change 事件） */
function emitSchemeChange(matches: boolean) {
  mqlMatches = matches
  schemeListeners.forEach(cb => cb({ matches } as MediaQueryListEvent))
}

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('themeStore', () => {
  it('默认主题为 dark（环境无 matchMedia → 按 dark 处理）', () => {
    const store = useThemeStore()
    expect(store.currentTheme).toBe('dark')
  })

  it('无存储 + OS 偏好浅色 → 首跑 light', () => {
    mockMatchMedia(true)
    const store = useThemeStore()
    expect(store.currentTheme).toBe('light')
    expect(store.isDark).toBe(false)
  })

  it('无存储 + OS 偏好深色 → 首跑 dark', () => {
    mockMatchMedia(false)
    const store = useThemeStore()
    expect(store.currentTheme).toBe('dark')
  })

  it('有存储 → 存储值优先（用户已手动选择，永远尊重）', () => {
    mockMatchMedia(false) // OS 深，存储浅
    localStorage.setItem('theme-settings', 'light')
    const store = useThemeStore()
    expect(store.currentTheme).toBe('light')
  })

  it('存储值已失效（注册表无此 key）→ 回退 OS 偏好', () => {
    mockMatchMedia(true)
    localStorage.setItem('theme-settings', 'bogus-theme')
    const store = useThemeStore()
    expect(store.currentTheme).toBe('light')
  })

  it('setTheme 切换主题并落盘', () => {
    const store = useThemeStore()
    store.setTheme('light')
    expect(store.currentTheme).toBe('light')
    expect(localStorage.getItem('theme-settings')).toBe('light')
  })

  it('setTheme 忽略无效主题 key 且不落盘', () => {
    const store = useThemeStore()
    store.setTheme('invalid' as never)
    expect(store.currentTheme).toBe('dark')
    expect(localStorage.getItem('theme-settings')).toBeNull()
  })

  it('未手动选择时 OS 偏好变化 → 实时跟随且不落盘（跟随不冒充用户选择）', () => {
    mockMatchMedia(true)
    const store = useThemeStore()
    expect(store.currentTheme).toBe('light')
    emitSchemeChange(false)
    expect(store.currentTheme).toBe('dark')
    expect(localStorage.getItem('theme-settings')).toBeNull()
  })

  it('手动选择后 OS 偏好变化 → 不再跟随', () => {
    mockMatchMedia(true)
    const store = useThemeStore()
    store.setTheme('one-dark')
    emitSchemeChange(false)
    expect(store.currentTheme).toBe('one-dark')
    expect(localStorage.getItem('theme-settings')).toBe('one-dark')
  })

  it('themeDef computed 返回正确的主题定义', () => {
    const store = useThemeStore()
    expect(store.themeDef).toBeDefined()
    expect(store.themeDef.isDark).toBe(true)
  })

  it('naiveTheme 和 naiveOverrides computed 正常', () => {
    const store = useThemeStore()
    expect(store.naiveTheme).toBeDefined()
    expect(store.naiveOverrides).toBeDefined()
  })

  it('isDark computed 随主题变化', () => {
    const store = useThemeStore()
    expect(store.isDark).toBe(true)
    store.setTheme('light')
    expect(store.isDark).toBe(false)
  })
})
