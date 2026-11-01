import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, beforeEach } from 'vitest'
import { useThemeFont } from '@/composables/useThemeFont'
import { useThemeStore } from '@/stores/theme'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('useThemeFont', () => {
  it('cycleTheme 循环切换主题', () => {
    const { cycleTheme } = useThemeFont()
    const themeStore = useThemeStore()
    const original = themeStore.currentTheme
    cycleTheme()
    expect(themeStore.currentTheme).not.toBe(original)
  })

  it('increaseFont 增大基础字体', () => {
    const { increaseFont } = useThemeFont()
    const old = useThemeFont().fontStore.sizes.base
    increaseFont()
    expect(useThemeFont().fontStore.sizes.base).toBe(old + 1)
  })

  it('decreaseFont 减小基础字体（不低于8）', () => {
    const { decreaseFont } = useThemeFont()
    const old = useThemeFont().fontStore.sizes.base
    decreaseFont()
    expect(useThemeFont().fontStore.sizes.base).toBe(Math.max(8, old - 1))
  })

  it('resetFont 恢复默认字体', () => {
    const { increaseFont, resetFont } = useThemeFont()
    increaseFont()
    increaseFont()
    resetFont()
    expect(useThemeFont().fontStore.sizes.base).toBe(13)
  })

  it('toggleLocale 切换语言', async () => {
    const { toggleLocale } = useThemeFont()
    const original = useThemeFont().localeStore.currentLocale
    toggleLocale()
    // setLocale 目标包就绪后异步生效（懒加载语义），轮到宏任务时必已落定
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(useThemeFont().localeStore.currentLocale).not.toBe(original)
  })
})
