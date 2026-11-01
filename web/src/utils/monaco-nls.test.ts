import { describe, expect, it, vi } from 'vitest'
import { LOCALE_STORAGE_KEY } from '../stores/locale-constants'

// 动态导入目标逐用例经 vi.doMock 换角色（成功 / 失败），配合 resetModules
// 重置模块级 memo（pending），让每用例拿到全新 ensureMonacoNls
const ZH_CN_NLS = 'monaco-editor/esm/nls.messages.zh-cn.js'
const ZH_TW_NLS = 'monaco-editor/esm/nls.messages.zh-tw.js'

describe('ensureMonacoNls', () => {
  it('无映射 locale（en-US）不加载语言包直接就绪', async () => {
    vi.resetModules()
    vi.doUnmock(ZH_CN_NLS)
    localStorage.setItem(LOCALE_STORAGE_KEY, 'en-US')
    const mod = await import('./monaco-nls')
    await expect(mod.ensureMonacoNls()).resolves.toBeUndefined()
  })

  it('zh-CN 加载语言包后就绪；同实例幂等（memoized 同一 promise）', async () => {
    vi.resetModules()
    const nlsLoader = vi.fn(async () => ({}))
    vi.doMock(ZH_CN_NLS, () => ({ default: nlsLoader() }))
    localStorage.setItem(LOCALE_STORAGE_KEY, 'zh-CN')
    const mod = await import('./monaco-nls')
    const p = mod.ensureMonacoNls()
    await expect(p).resolves.toBeUndefined()
    expect(mod.ensureMonacoNls()).toBe(p)
  })

  it('zh-TW 映射在表：加载 zh-tw 语言包后就绪', async () => {
    vi.resetModules()
    vi.doMock(ZH_TW_NLS, () => ({ default: {} }))
    localStorage.setItem(LOCALE_STORAGE_KEY, 'zh-TW')
    const mod = await import('./monaco-nls')
    await expect(mod.ensureMonacoNls()).resolves.toBeUndefined()
  })

  it('语言包加载失败不阻断编辑器（静默吞掉，resolve）', async () => {
    vi.resetModules()
    vi.doMock(ZH_CN_NLS, () => { throw new Error('nls chunk fetch failed') })
    localStorage.setItem(LOCALE_STORAGE_KEY, 'zh-CN')
    const mod = await import('./monaco-nls')
    await expect(mod.ensureMonacoNls()).resolves.toBeUndefined()
  })
})
