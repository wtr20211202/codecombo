import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useLocaleStore } from '@/stores/locale'
import { ensureLocaleLoaded } from '@/i18n'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('localeStore', () => {
  it('默认语言为 zh-CN', () => {
    const store = useLocaleStore()
    expect(store.currentLocale).toBe('zh-CN')
  })

  it('setLocale 切换语言（目标包就绪后生效）', async () => {
    const store = useLocaleStore()
    await store.setLocale('en-US')
    expect(store.currentLocale).toBe('en-US')
  })

  it('setLocale 忽略无效语言', () => {
    const store = useLocaleStore()
    store.setLocale('fr-FR' as never)
    expect(store.currentLocale).toBe('zh-CN')
  })

  it('目标语言包加载失败时不切换', async () => {
    const store = useLocaleStore()
    vi.mocked(ensureLocaleLoaded).mockResolvedValueOnce(false)
    await store.setLocale('en-US')
    expect(store.currentLocale).toBe('zh-CN')
    vi.mocked(ensureLocaleLoaded).mockImplementation(async () => true)
  })

  it('连点两个语言以最后写入者胜（迟到的补载不覆盖新选择）', async () => {
    const store = useLocaleStore()
    const pending: Array<(v: boolean) => void> = []
    vi.mocked(ensureLocaleLoaded).mockImplementation(
      () => new Promise<boolean>((resolve) => pending.push(resolve))
    )
    void store.setLocale('en-US')
    const second = store.setLocale('zh-CN')
    // 后发的 zh-CN 请求先完成（包本来就在场）
    pending[1]!(true)
    await second
    // 先发的 en-US 补载迟到落地，但已不是最新选择，不得改写 currentLocale
    pending[0]!(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.currentLocale).toBe('zh-CN')
    vi.mocked(ensureLocaleLoaded).mockImplementation(async () => true)
  })
})
