import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, beforeEach } from 'vitest'
import { isZhPrimaryLanguage, shouldSuggestLocale, useLocaleSuggest } from '@/composables/useLocaleSuggest'
import { useLocaleStore } from '@/stores/locale'

// 首跑浏览器语言建议（P-20261002-113）：判定纯函数真值表 + dismiss/accept 落盘
// 与切换链路。visible 组合读 navigator.language（jsdom 不可替换），组合行为
// 由 e2e locale-suggest.spec.ts 覆盖，此处不依赖环境默认值

describe('isZhPrimaryLanguage', () => {
  it('zh 主语言 → true（含地区子标签/大小写/无子标签）', () => {
    expect(isZhPrimaryLanguage('zh-CN')).toBe(true)
    expect(isZhPrimaryLanguage('zh-TW')).toBe(true)
    expect(isZhPrimaryLanguage('zh')).toBe(true)
    expect(isZhPrimaryLanguage('ZH-cn')).toBe(true)
  })

  it('非 zh 主语言 → false（zh 出现在次要子标签不算）', () => {
    expect(isZhPrimaryLanguage('en-US')).toBe(false)
    expect(isZhPrimaryLanguage('fr')).toBe(false)
    expect(isZhPrimaryLanguage('en-zh')).toBe(false)
    expect(isZhPrimaryLanguage('')).toBe(false)
  })
})

describe('shouldSuggestLocale', () => {
  const hit = {
    dismissed: false,
    storedLocale: null,
    currentLocale: 'zh-CN',
    browserLang: 'en-US',
  }

  it('首跑全条件命中 → 提示', () => {
    expect(shouldSuggestLocale(hit)).toBe(true)
  })

  it('dismiss 过 → 永不再提示', () => {
    expect(shouldSuggestLocale({ ...hit, dismissed: true })).toBe(false)
  })

  it('已有 locale 存储（含脏值）→ 用户已表达过选择，不打扰', () => {
    expect(shouldSuggestLocale({ ...hit, storedLocale: 'en-US' })).toBe(false)
    expect(shouldSuggestLocale({ ...hit, storedLocale: 'zh-CN' })).toBe(false)
    expect(shouldSuggestLocale({ ...hit, storedLocale: 'toString' })).toBe(false)
  })

  it('默认 zh 未生效中（已被切走）→ 不提示', () => {
    expect(shouldSuggestLocale({ ...hit, currentLocale: 'en-US' })).toBe(false)
  })

  it('浏览器主语言 zh（中文用户）→ 零打扰', () => {
    expect(shouldSuggestLocale({ ...hit, browserLang: 'zh-CN' })).toBe(false)
    expect(shouldSuggestLocale({ ...hit, browserLang: 'zh-TW' })).toBe(false)
  })
})

describe('useLocaleSuggest', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // localStorage 跨用例共享（同文件同 jsdom）：accept 会落 locale-settings，
    // 整表清理防串扰
    localStorage.clear()
  })

  it('dismiss() 把一次性记忆写入 localStorage（safeStorage 键）', () => {
    const { dismiss } = useLocaleSuggest()
    dismiss()
    expect(localStorage.getItem('sc.localeSuggestDismissed')).toBe('1')
  })

  it('accept() 经既有 setLocale 链路切到 en-US（目标包懒补载后生效）', async () => {
    const { accept } = useLocaleSuggest()
    accept()
    // setLocale 目标包就绪后异步生效（懒加载语义），轮到宏任务时必已落定
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(useLocaleStore().currentLocale).toBe('en-US')
  })
})
