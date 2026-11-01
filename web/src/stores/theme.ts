import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import {
  themeRegistry,
  resolveInitialThemeKey,
  systemDefaultThemeKey,
  prefersColorSchemeLight,
  type ThemeKey,
  type ThemeDefinition,
} from '../themes'
import { applyThemeColorMeta } from '../themes/themeColor'
import { resolveDiffPair } from '../themes/diffPalette'
import { useFontStore } from './font'
import { safeStorage } from '../utils/storage'

/** localStorage key：用户选定主题（写入侧 setTheme；跨标签分发见 utils/settingsSync） */
export const THEME_SETTINGS_KEY = 'theme-settings'

export const useThemeStore = defineStore('theme', () => {
  // 三段式初始主题（跟随 OS 深浅色，对标 VS Code/JetBrains 默认行为）：
  // ① theme-settings 有合法存储 → 用户已手动选择，永远尊重；
  // ② 无存储/存储值已失效 → 按 prefers-color-scheme 映射 light/dark
  //    （one-dark/dracula 等个性主题属用户主动选择项，不参与默认映射）；
  // ③ 运行期 OS 偏好变化且用户从未手动选过 → 实时跟随（见下方 matchMedia 监听）。
  // 「从未手动选过」以存储缺失为准：OS 跟随产生的变更不落盘，清除存储即恢复跟随。
  const stored = safeStorage.getItem(THEME_SETTINGS_KEY)
  const userChosen = ref(!!stored && !!themeRegistry[stored as ThemeKey])
  const currentTheme = ref<ThemeKey>(resolveInitialThemeKey(stored, prefersColorSchemeLight()))

  const themeDef = computed<ThemeDefinition>(() => {
    return themeRegistry[currentTheme.value] ?? themeRegistry['dark']!
  })

  const naiveTheme = computed(() => themeDef.value.naiveTheme)
  const naiveOverrides = computed(() => themeDef.value.naiveOverrides)
  const isDark = computed(() => themeDef.value.isDark)

  function setTheme(key: ThemeKey) {
    if (themeRegistry[key]) {
      userChosen.value = true
      currentTheme.value = key
      // 持久化收敛在用户主动选择这一条路径：OS 跟随只改内存，写存储会冒充用户选择
      safeStorage.setItem(THEME_SETTINGS_KEY, key)
    }
  }

  /** 跨标签同步的静默重读（P-20261002-36，utils/settingsSync 按 key 分发到此）：
   *  另一标签写入 theme-settings 后不经刷新跟随。与首跑解析同口径
   *  （resolveInitialThemeKey 三段式）：合法存储值视为用户已手动选择（此后 OS
   *  偏好变化不再跟随——他页的显式选择与本页选择同等尊重）；存储空/脏值回退
   *  OS 映射。同值 no-op（watch 不触发、CSS 变量不重复应用）。 */
  function syncFromStorage() {
    const stored = safeStorage.getItem(THEME_SETTINGS_KEY)
    userChosen.value = !!stored && !!themeRegistry[stored as ThemeKey]
    const next = resolveInitialThemeKey(stored, prefersColorSchemeLight())
    if (next !== currentTheme.value) {
      currentTheme.value = next
    }
  }

  function apply() {
    const root = document.documentElement.style
    const colors = themeDef.value.colors
    for (const [key, value] of Object.entries(colors)) {
      root.setProperty(`--${key}`, value)
    }
    // diff 色板按档覆盖（P-20261006-5）：colors 表四键为两档原始值，这里按
    // 「当前主题 × font store 色板档」解析出生效对写入 --diff-added/--diff-removed
    // ——覆盖写两键（低频路径，主题切换/档位切换各一次）换取循环保持通用。
    // fontStore 在 setup 尾部初始化（apply 首调在其后，TDZ 无虞）
    const diffPair = resolveDiffPair(colors, fontStore.diffPalette)
    root.setProperty('--diff-added', diffPair.added)
    root.setProperty('--diff-removed', diffPair.removed)
    // 声明 color-scheme：浏览器原生 UI（autofill 底色、滚动条、表单控件）随主题适配，
    // 未声明时 Chrome 按默认 light 渲染——深色主题下 password 框被 autofill 填出白底
    root.colorScheme = themeDef.value.isDark ? 'dark' : 'light'
    // theme-color meta 随主题联动（P-20261004-134）：安装态状态栏/移动端地址栏色
    // 跟手切换。用户手切、OS 跟随、跨标签 syncFromStorage 均流经本 watch，单点覆盖
    applyThemeColorMeta(themeDef.value)
  }

  // 主题变更统一在此刷新 CSS 变量（用户选择与 OS 跟随变更同享；落盘已收敛至 setTheme）
  watch(currentTheme, () => {
    apply()
  })

  // diff 色板档变更（P-20261006-5）同样经 apply() 单点重写（档位持久化在 font
  // store，跨标签同步走 font-settings 读回链触发本 watch，与主题变更同享单点）
  const fontStore = useFontStore()
  watch(() => fontStore.diffPalette, () => {
    apply()
  })

  // ③ OS 偏好实时跟随：仅当用户从未手动选择过（matchMedia 不可用的环境静默跳过）
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    const mql = window.matchMedia('(prefers-color-scheme: light)')
    const onSchemeChange = (e: MediaQueryListEvent) => {
      if (userChosen.value) return
      const next = systemDefaultThemeKey(e.matches)
      if (next !== currentTheme.value) currentTheme.value = next
    }
    mql.addEventListener('change', onSchemeChange)
  }

  // 首次加载时应用
  apply()

  return { currentTheme, themeDef, naiveTheme, naiveOverrides, isDark, setTheme, syncFromStorage }
})
