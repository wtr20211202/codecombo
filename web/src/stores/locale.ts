import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { locales, type LocaleKey } from '../locales'
import i18n, { ensureLocaleLoaded } from '../i18n'
import { LOCALE_STORAGE_KEY } from './locale-constants'
import { safeStorage } from '../utils/storage'

/** 出厂默认语言：ref 初始化回落与设置页行级「已修改」标记共用基准（P-20261003-171） */
export const LOCALE_DEFAULT: LocaleKey = 'zh-CN'

export const useLocaleStore = defineStore('locale', () => {
  const currentLocale = ref<LocaleKey>(
    (safeStorage.getItem(LOCALE_STORAGE_KEY) as LocaleKey) || LOCALE_DEFAULT
  )

  // 目标语言包未注册时首次切换才动态导入补载：加载期间保持原语言渲染，完成后再
  // 切（切换是低频操作，无需 loading 态）。连点多个语言以最后写入者胜——迟到的
  // 补载若已不是最新选择则丢弃切换，避免旧目标覆盖新选择
  let switchSeq = 0

  async function setLocale(key: LocaleKey) {
    if (!locales[key]) {
      return
    }
    const seq = ++switchSeq
    if (!(await ensureLocaleLoaded(key)) || seq !== switchSeq) {
      return
    }
    currentLocale.value = key
  }

  watch(currentLocale, (val) => {
    safeStorage.setItem(LOCALE_STORAGE_KEY, val)
    i18n.global.locale.value = val
  })

  /** 跨标签同步的静默重读（P-20261002-36，utils/settingsSync 按 key 分发到此）：
   *  另一标签写入 locale 后不经刷新跟随。复用 setLocale 全链路（目标包懒补载 +
   *  最后写入者胜竞态保护）；脏值（未注册语言）与同值 no-op。 */
  function syncFromStorage() {
    const stored = safeStorage.getItem(LOCALE_STORAGE_KEY) as LocaleKey | null
    if (stored && locales[stored] && stored !== currentLocale.value) {
      void setLocale(stored)
    }
  }

  return { currentLocale, setLocale, syncFromStorage }
})
