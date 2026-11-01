import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import {
  getTerminalThemeByName,
  resolveTerminalTheme,
  FALLBACK_TERMINAL_THEME,
  XTERM_FONT_STACKS,
  APP_GEAR_TERMINAL_THEMES,
  appThemeGear,
} from '../terminal-themes'
import type { TerminalThemeDefinition, TerminalFontFamily } from '../terminal-themes/types'
import { settingsApi } from '../api/client'
import { useThemeStore } from './theme'
import { useFontStore } from './font'
import { safeStorage } from '../utils/storage'
import { notifyUserPrefsDirty } from './userPrefsLink'

// localStorage key：终端主题跟随应用明暗开关（写入侧 setFollowAppTheme；跨标签分发见 utils/settingsSync）
export const TERMINAL_THEME_FOLLOW_KEY = 'terminal-theme-follow'

// 跟随应用明暗出厂默认开（下方 ref 初始化与设置页行级「已修改」标记共用基准，P-20261003-171）
export const TERMINAL_THEME_FOLLOW_DEFAULT = true
// 终端字体出厂默认（与后端 GET /settings 空值回落 jetbrains 一致），单一定义防漂移
export const TERMINAL_FONT_DEFAULT: TerminalFontFamily = 'jetbrains'

export const useTerminalThemeStore = defineStore('terminal-theme', () => {
  // 跟随应用明暗（P-20261002-144）：默认开。两层跟随语义区分——应用主题跟随 OS
  // 是上级（P-1，theme store），终端主题跟随应用主题是本次级；开关持久化在浏览器
  // 本地（与跟随源 theme-settings 同域而非服务端 settings）：应用主题本就是每
  // 浏览器各自解析的，落到服务端会让一处解绑改变所有浏览器的跟随语义
  //（存储语义：缺档/任意非 'off' 值 = 默认开 TERMINAL_THEME_FOLLOW_DEFAULT，仅 'off' 关）
  const followAppTheme = ref(safeStorage.getItem(TERMINAL_THEME_FOLLOW_KEY) !== 'off')

  // 默认 classic-dark（后端 settings 默认也是 classic-dark）
  const savedThemeName = ref<string>(FALLBACK_TERMINAL_THEME)
  const savedFont = ref<TerminalFontFamily>(TERMINAL_FONT_DEFAULT)

  // 跟随源：应用主题明暗档位（theme store 的 isDark 是响应式依赖，
  // 档位翻转时本 computed 与所有 watch currentThemeName 的消费方自动随动）
  const themeStore = useThemeStore()
  // 自定义等宽字体名跟随源（P-20261005-227，currentFontStack 前插段）
  const fontStore = useFontStore()

  const currentThemeDef = computed<TerminalThemeDefinition>(() => {
    // 跟随开：按应用明暗档位取映射（savedThemeName 挂起不生效）；
    // 跟随关：锁手工选择 savedThemeName，应用主题怎么切都不跟
    return followAppTheme.value
      ? resolveTerminalTheme(APP_GEAR_TERMINAL_THEMES[appThemeGear(themeStore.isDark)])
      : resolveTerminalTheme(savedThemeName.value)
  })
  const currentThemeName = computed(() => currentThemeDef.value.name)
  const currentFont = computed<TerminalFontFamily>(() => savedFont.value)

  async function load() {
    try {
      const res = (await settingsApi.get()) as unknown as {
        data?: { terminalTheme?: string; terminalFont?: string }
      }
      hydrate(res.data ?? {})
    } catch {
      // silent: 用默认值
    }
  }

  // 从已 fetch 的 settings data 同步状态（避免调用方重复请求 /settings）
  function hydrate(data: { terminalTheme?: string; terminalFont?: string }) {
    const t = data.terminalTheme
    if (t && getTerminalThemeByName(t)) {
      savedThemeName.value = t
    } else {
      savedThemeName.value = FALLBACK_TERMINAL_THEME
    }
    const font = data.terminalFont as TerminalFontFamily | undefined
    if (font === 'jetbrains' || font === 'cascadia' || font === 'ibmplex' || font === 'fira') {
      savedFont.value = font
    }
  }

  // 乐观更新 + 失败回滚的统一 helper（消除 setTheme/setFont 重复 try/catch）
  async function persistField<T>(
    target: { value: T },
    newValue: T,
    patch: Record<string, unknown>,
  ): Promise<boolean> {
    const old = target.value
    target.value = newValue
    try {
      await settingsApi.update(patch as Parameters<typeof settingsApi.update>[0])
      return true
    } catch (e) {
      console.error('[terminal-theme] persist failed, rollback', e)
      target.value = old
      return false
    }
  }

  async function setTheme(name: string): Promise<boolean> {
    if (!getTerminalThemeByName(name)) {
      console.warn(`[terminal-theme] unknown theme: ${name}, fallback to ${FALLBACK_TERMINAL_THEME}`)
      return false
    }
    return persistField(savedThemeName, name, { terminalTheme: name })
  }

  async function setFont(font: TerminalFontFamily): Promise<boolean> {
    return persistField(savedFont, font, { terminalFont: font })
  }

  // 跟随开关（设置页终端主题分区）：开 = 档位映射生效；关 = 锁 savedThemeName。
  // 同值重复写无副作用（ref 赋值同值不触发 watch）。
  // 服务端漫游双写（P-20261007-1）：「跟随应用主题」是用户习性开关——服务端
  // 白名单已漫游 terminalTheme 本体而开关留本地曾是半吊子缝（B 机主题同步了、
  // 跟随开关没同步），随 userPrefs 收编闭合；localStorage 镜像照旧（跨标签
  // settingsSync 读回链与离线兜底依赖它）
  function setFollowAppTheme(v: boolean) {
    followAppTheme.value = v
    safeStorage.setItem(TERMINAL_THEME_FOLLOW_KEY, v ? 'on' : 'off')
    notifyUserPrefsDirty()
  }

  // 跨标签同步的静默重读（P-20261002-36，utils/settingsSync 按 key 分发到此）：
  // 另一标签写 terminal-theme-follow 后本标签不经刷新跟随（生效主题是 computed，
  // 开关翻转即全链随动）；存储缺失按默认跟随处理（与他页清除开关恢复默认同口径）
  function syncFollowFromStorage() {
    followAppTheme.value = safeStorage.getItem(TERMINAL_THEME_FOLLOW_KEY) !== 'off'
  }

  // xterm 实例用的 fontFamily 栈：设置页字体选择的唯一 xterm 接线源
  // （CSS class 路径对 xterm 无效——内联样式优先级更高）。
  // 自定义等宽字体名（P-20261005-227）在此前插：xterm 是内联 fontFamily、不走
  // CSS var，--font-mono-lead 覆写管不到它——终端侧与全局 CSS var 覆写同源
  // （同读 fontStore.monoFontName），'自定义名', 预设栈 回退链与 CSS 侧同构
  const currentFontStack = computed(() => {
    const base = XTERM_FONT_STACKS[savedFont.value] ?? XTERM_FONT_STACKS.jetbrains
    const custom = fontStore.monoFontName
    return custom ? `'${custom}', ${base}` : base
  })

  return {
    followAppTheme,
    savedThemeName,
    savedFont,
    currentThemeDef,
    currentThemeName,
    currentFont,
    currentFontStack,
    load,
    hydrate,
    setTheme,
    setFont,
    setFollowAppTheme,
    syncFollowFromStorage,
  }
})
