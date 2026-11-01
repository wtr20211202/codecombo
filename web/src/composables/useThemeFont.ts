import { useThemeStore } from '@/stores/theme'
import { useFontStore } from '@/stores/font'
import { useLocaleStore } from '@/stores/locale'
import { themeRegistry } from '@/themes'

export function useThemeFont() {
  const themeStore = useThemeStore()
  const fontStore = useFontStore()
  const localeStore = useLocaleStore()

  function cycleTheme() {
    const keys = Object.keys(themeRegistry) as Array<keyof typeof themeRegistry>
    if (keys.length === 0) return
    const idx = keys.indexOf(themeStore.currentTheme)
    themeStore.setTheme(keys[(idx + 1) % keys.length]!)
  }

  function increaseFont() { fontStore.setSize('base', fontStore.sizes.base + 1) }
  function decreaseFont() { fontStore.setSize('base', fontStore.sizes.base - 1) }
  function resetFont() { fontStore.reset() }
  function toggleLocale() {
    localeStore.setLocale(localeStore.currentLocale === 'zh-CN' ? 'en-US' : 'zh-CN')
  }

  return { cycleTheme, increaseFont, decreaseFont, resetFont, toggleLocale,
           themeStore, fontStore, localeStore }
}
