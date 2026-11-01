import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useUiDensityStore, UI_DENSITY_ROW_H, UI_DENSITY_DEFAULT } from './ui-density'

// mock settingsApi
vi.mock('../api/client', () => ({
  settingsApi: {
    get: vi.fn().mockResolvedValue({ data: {} }),
    update: vi.fn().mockResolvedValue({}),
  },
}))

// jsdom 无真实 layout，apply 只验证 documentElement 内联变量的注入/移除语义
const inlineVars = () => ({
  rowH: document.documentElement.style.getPropertyValue('--row-h'),
  rowPadY: document.documentElement.style.getPropertyValue('--row-pad-y'),
  fsMetaMin: document.documentElement.style.getPropertyValue('--fs-meta-min'),
})

/** 三 token 全清：beforeEach/afterEach 与断言期望共用同一清单 */
function clearInlineVars() {
  for (const p of ['--row-h', '--row-pad-y', '--fs-meta-min']) {
    document.documentElement.style.removeProperty(p)
  }
}

describe('ui-density store', () => {
  beforeEach(() => {
    clearInlineVars()
    setActivePinia(createPinia())
  })
  afterEach(() => {
    vi.clearAllMocks()
    clearInlineVars()
  })

  it('初始默认 comfortable（= 历史现状零变化）且零注入', () => {
    const store = useUiDensityStore()
    expect(store.density).toBe(UI_DENSITY_DEFAULT)
    expect(store.rowHeightPx).toBe(UI_DENSITY_ROW_H.comfortable)
    expect(inlineVars()).toEqual({ rowH: '', rowPadY: '', fsMetaMin: '' })
  })

  it('hydrate compact：档位切换 + 三 token 注入（含可读性下限 10.5px）', () => {
    const store = useUiDensityStore()
    store.hydrate({ uidensity: 'compact' })
    expect(store.density).toBe('compact')
    expect(store.rowHeightPx).toBe(UI_DENSITY_ROW_H.compact)
    expect(inlineVars()).toEqual({ rowH: '22px', rowPadY: '3px', fsMetaMin: '10.5px' })
  })

  it('hydrate 脏值收敛默认 + 切回舒适档移除注入（不写 26px，防自然行高面漂移）', () => {
    const store = useUiDensityStore()
    store.hydrate({ uidensity: 'cozy' as string })
    expect(store.density).toBe('comfortable')
    store.hydrate({ uidensity: 'compact' })
    expect(inlineVars().rowH).toBe('22px')
    store.hydrate({ uidensity: 'comfortable' })
    expect(inlineVars()).toEqual({ rowH: '', rowPadY: '', fsMetaMin: '' })
  })

  it('load：从 settings GET 读档位', async () => {
    const { settingsApi } = await import('../api/client')
    // mock 类型沿 terminal-theme.test 同款脱敏（axios AxiosResponse 泛型失真）
    ;(settingsApi.get as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce({
      data: { uidensity: 'compact' },
    })
    const store = useUiDensityStore()
    await store.load()
    expect(store.density).toBe('compact')
  })

  it('load 失败静默保持默认', async () => {
    const { settingsApi } = await import('../api/client')
    vi.mocked(settingsApi.get).mockRejectedValueOnce(new Error('network'))
    const store = useUiDensityStore()
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.density).toBe('comfortable')
  })

  it('setDensity 乐观更新 + 落服务端 uidensity 键', async () => {
    const { settingsApi } = await import('../api/client')
    const store = useUiDensityStore()
    const ok = await store.setDensity('compact')
    expect(ok).toBe(true)
    expect(store.density).toBe('compact')
    expect(vi.mocked(settingsApi.update)).toHaveBeenCalledWith({ uidensity: 'compact' })
  })

  it('setDensity 失败回滚 + 注入同步回滚', async () => {
    const { settingsApi } = await import('../api/client')
    vi.mocked(settingsApi.update).mockRejectedValueOnce(new Error('500'))
    const store = useUiDensityStore()
    const ok = await store.setDensity('compact')
    expect(ok).toBe(false)
    expect(store.density).toBe('comfortable')
    expect(inlineVars()).toEqual({ rowH: '', rowPadY: '', fsMetaMin: '' })
  })
})
