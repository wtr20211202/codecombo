import { computed, ref } from 'vue'
import { LOCALE_STORAGE_KEY } from '../stores/locale-constants'
import { useLocaleStore } from '../stores/locale'
import { safeStorage } from '../utils/storage'

// 首跑浏览器语言建议（P-20261002-113）：产品默认 zh-CN，但浏览器主语言非 zh
// 的用户第一屏满是中文。仅首跑（从未表达过语言选择）时在首页顶部提示一次
// 「切换到 English / 保持中文」——已选过语言（存储非空）与中文用户零打扰。

const DISMISS_KEY = 'sc.localeSuggestDismissed'

/** 主语言子标签是否 zh：navigator.language 取首个子标签比较（en-US → en 非 zh，
 *  zh-TW/zh 也是中文用户不打扰）。参数化便于单测直传（jsdom 不可替换 navigator） */
export function isZhPrimaryLanguage(browserLang: string): boolean {
  return browserLang.toLowerCase().startsWith('zh')
}

/** 首跑建议判定（纯函数，全条件真值表可单测）：dismiss 过 / 已有 locale 存储
 *  （脏值也算「已表达」）/ 默认 zh 未生效中，任一命中即不提示；浏览器主语言
 *  非 zh 才提示 */
export function shouldSuggestLocale(input: {
  dismissed: boolean
  storedLocale: string | null
  currentLocale: string
  browserLang: string
}): boolean {
  if (input.dismissed) return false
  if (input.storedLocale !== null) return false
  if (input.currentLocale !== 'zh-CN') return false
  return !isZhPrimaryLanguage(input.browserLang)
}

// 模块级共享「已保持中文」记忆（useHttpWarning 同款单例）：dismiss 写
// safeStorage（隐私模式落内存兜底会话内生效），刷新/重开不再出现
const dismissed = ref(safeStorage.getItem(DISMISS_KEY) === '1')

export function useLocaleSuggest() {
  const localeStore = useLocaleStore()

  // 存储读取非响应式，但任一状态变化都经 dismissed/currentLocale 触发重算：
  // 点「切换」→ currentLocale 离开 zh-CN → 消失；他标签改语言 → settingsSync
  // 同步 currentLocale → 重算
  const visible = computed(() => shouldSuggestLocale({
    dismissed: dismissed.value,
    storedLocale: safeStorage.getItem(LOCALE_STORAGE_KEY),
    currentLocale: localeStore.currentLocale,
    browserLang: navigator.language,
  }))

  /** 「保持中文」：写一次性记忆，此后不再提示 */
  function dismiss(): void {
    dismissed.value = true
    safeStorage.setItem(DISMISS_KEY, '1')
  }

  /** 「切换」：走既有 setLocale 链路（目标包懒补载 + storage 持久 + 跨标签
     同步）。切换成功后 currentLocale 离开 zh-CN，提示条自然消失且因存储落盘
     永不重现；补载失败则保持原状可重试，无副作用 */
  function accept(): void {
    void localeStore.setLocale('en-US')
  }

  return { visible, dismiss, accept }
}
