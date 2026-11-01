import { createI18n } from 'vue-i18n'
import { LOCALE_STORAGE_KEY } from '../stores/locale-constants'
import { safeStorage } from '../utils/storage'
import type { LocaleKey } from '../locales'

// locale 懒加载（chunk 分离）：boot 只动态导入激活语言（无存储默认 zh-CN）对应
// 的语言包注册进 messages，另一语言包不进主链——中文用户不再白下英文包，反之
// 亦然，boot 串行链也少一跳。切换语言 / fallback 回退时的补载见 ensureLocaleLoaded
// （切换首次多一跳，低频操作可接受）。「先建 i18n 再挂载应用」的既有语义不变：
// TLA 阻塞后续模块求值，与 monaco-nls 同一模式。
// 注意：勿将此处的动态导入改为手动分块——nls 的教训见 vite.config.ts 注释。
const loaders = {
  'zh-CN': () => import('../locales/zh-CN'),
  'en-US': () => import('../locales/en-US'),
}

const storedLocale = safeStorage.getItem(LOCALE_STORAGE_KEY)
// 仅认自有键：脏值若为 'toString' 之类原型链键名不得当 loader（hasOwn 语义）
const loaderLocales = new Set<string>(Object.keys(loaders))
const initialLocale: LocaleKey =
  storedLocale && loaderLocales.has(storedLocale) ? (storedLocale as LocaleKey) : 'zh-CN'

const initialMessages = (await loaders[initialLocale]()).default

const i18n = createI18n({
  legacy: false,
  locale: initialLocale,
  // 缺 key 回退 zh-CN；en-US 激活时 zh-CN 包默认不在场，见下方 missing 钩子
  fallbackLocale: 'zh-CN',
  messages: { [initialLocale]: initialMessages },
  // fallback 包懒加载（首次缺 key 时）：激活 en-US 且 key 在 en 缺失需要回退 zh
  // 时，若 zh-CN 包尚未注册则触发补载；setLocaleMessage 是响应式注册，已渲染的
  // 原始 key 会在包落地后自动补翻。返回 undefined 走默认解析（fallback → 警告）
  missing: () => {
    void ensureLocaleLoaded('zh-CN')
  },
})

// 已注册语言包登记：boot 只注册激活包，其余包经 ensureLocaleLoaded 首次使用时
// 补注册（幂等；inflight 去重并发调用，失败可重试）
const registered = new Set<LocaleKey>([initialLocale])
const inflight = new Map<LocaleKey, Promise<boolean>>()

export function ensureLocaleLoaded(locale: LocaleKey): Promise<boolean> {
  if (registered.has(locale)) return Promise.resolve(true)
  if (!loaderLocales.has(locale)) return Promise.resolve(false)
  const pending = inflight.get(locale)
  if (pending) return pending
  const task = loaders[locale]()
    .then((mod) => {
      i18n.global.setLocaleMessage(locale, mod.default)
      registered.add(locale)
      return true
    })
    .catch((err: unknown) => {
      console.error(`[i18n] 语言包 ${locale} 加载失败`, err)
      return false
    })
    .finally(() => {
      inflight.delete(locale)
    })
  inflight.set(locale, task)
  return task
}

export default i18n
