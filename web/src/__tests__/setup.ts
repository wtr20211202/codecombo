import { beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import zhCN from '../locales/zh-CN'
import enUS from '../locales/en-US'

// Mock axios
vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => ({
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      interceptors: {
        request: { use: vi.fn() },
        response: { use: vi.fn() },
      },
    })),
  },
}))

// Mock vue-i18n：jsdom 中无法访问 Vue app 实例，用真实 locale 文案做「键 → 文案」
// 直译（含 {n} 插值），与生产行为对齐；文案正确性由 locale 键位对齐校验 + E2E 兜底
function flattenMessages(obj: Record<string, unknown>, prefix = '', out: Record<string, string> = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object') flattenMessages(v as Record<string, unknown>, key, out)
    else out[key] = String(v)
  }
  return out
}
const zhMessages = flattenMessages(zhCN as Record<string, unknown>)
const enMessages = flattenMessages(enUS as Record<string, unknown>)
const mockT = (key: string, params?: Record<string, unknown>) => {
  const msg = zhMessages[key] ?? enMessages[key] ?? key
  if (params) {
    return msg.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? ''))
  }
  return msg
}

vi.mock('@/i18n', () => ({
  default: {
    global: {
      t: mockT,
      locale: { value: 'zh-CN' },
    },
  },
  // locale store 切换语言时调用：单测里视作「目标语言包已就绪」即时成功
  ensureLocaleLoaded: vi.fn(async () => true),
}))

// Mock vue-i18n 的 useI18n() composable（在 jsdom 中无法访问 Vue app 实例）
vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: mockT,
    locale: { value: 'zh-CN' },
  }),
  createI18n: () => ({}),
}))

// Mock vue-router
vi.mock('vue-router', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
  })),
  createRouter: vi.fn(),
  createWebHistory: vi.fn(),
}))

// Mock naive-ui createDiscreteApi（jsdom 中无法创建真实 DOM 组件）
vi.mock('naive-ui', async () => {
  const actual = await vi.importActual('naive-ui')
  return {
    ...(actual as object),
    createDiscreteApi: vi.fn(() => ({
      message: {
        success: vi.fn(),
        error: vi.fn(),
        warning: vi.fn(),
        info: vi.fn(),
      },
      dialog: {
        create: vi.fn(),
      },
      notification: {
        create: vi.fn(),
      },
    })),
  }
})

// Mock localStorage（jsdom 环境中 localStorage 可能不完整）
const storageMap = new Map<string, string>()
const mockStorage: Storage = {
  length: 0,
  clear() { storageMap.clear() },
  getItem(key: string) { return storageMap.get(key) ?? null },
  setItem(key: string, value: string) { storageMap.set(key, value) },
  removeItem(key: string) { storageMap.delete(key) },
  key(index: number) { return Array.from(storageMap.keys())[index] ?? null },
}
Object.defineProperty(globalThis, 'localStorage', { value: mockStorage, writable: true })

beforeEach(() => {
  storageMap.clear()
  setActivePinia(createPinia())
})
