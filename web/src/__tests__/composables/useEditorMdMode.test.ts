import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { uiStateApi } from '@/api/client'

// Markdown 模式偏好单例（P-20261003-18）：偏好恢复 / 无记录回落 / 循环切换与
// 持久化闭环。useEditorMdMode 是模块级单例（preferredMode/loaded 跨调用存活）
// ——vi.resetModules + 动态 import 让每个用例拿到全新单例

vi.mock('@/api/client', () => ({
  uiStateApi: { get: vi.fn(), update: vi.fn(), patch: vi.fn() },
  setInstanceContext: vi.fn(),
}))

type AllState = Record<string, Record<string, unknown>>

/** 让服务端 GET 返回指定全量数据 */
function mockServerData(all: AllState) {
  vi.mocked(uiStateApi.get).mockResolvedValue({ data: all } as Awaited<ReturnType<typeof uiStateApi.get>>)
}

/** 全新单例：重置模块注册表 + 新 pinia（composable 内部 useUIStateStore 需要） */
async function freshPrefs() {
  vi.resetModules()
  setActivePinia(createPinia())
  const mod = await import('@/composables/useEditorMdMode')
  return mod.useEditorMdMode()
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(uiStateApi.update).mockResolvedValue({} as Awaited<ReturnType<typeof uiStateApi.update>>)
  vi.mocked(uiStateApi.patch).mockResolvedValue({} as Awaited<ReturnType<typeof uiStateApi.patch>>)
})

describe('useEditorMdMode（Markdown 模式偏好 P-20261003-18）', () => {
  it('ensureLoaded：恢复上次偏好；无记录保留 split 默认且不写记录', async () => {
    mockServerData({ local: { editorPrefs: { mdMode: 'preview' } } })
    let prefs = await freshPrefs()
    await prefs.ensureLoaded()
    expect(prefs.preferredMode.value).toBe('preview')

    // 无记录：split 初值即历史默认；只读不写（不把默认落成记录）
    mockServerData({})
    prefs = await freshPrefs()
    await prefs.ensureLoaded()
    expect(prefs.preferredMode.value).toBe('split')
    expect(uiStateApi.patch).not.toHaveBeenCalled()
    expect(uiStateApi.update).not.toHaveBeenCalled()
  })

  it('脏值防御：非法 mdMode 回落 split 默认', async () => {
    mockServerData({ local: { editorPrefs: { mdMode: 'corrupted' } } })
    const prefs = await freshPrefs()
    await prefs.ensureLoaded()
    expect(prefs.preferredMode.value).toBe('split')
  })

  it('cycleMdMode：source→preview→split→source 循环并即时持久化', async () => {
    mockServerData({})
    const prefs = await freshPrefs()
    await prefs.ensureLoaded()
    expect(prefs.cycleMdMode('source')).toBe('preview')
    expect(prefs.cycleMdMode('preview')).toBe('split')
    expect(prefs.cycleMdMode('split')).toBe('source')
    // 每次循环即时写（键级补丁 setter 语义，不等防抖——切换后立刻刷新可恢复）；
    // setMdMode 内部 void 异步链，断言前 waitFor 落盘完成
    await vi.waitFor(() => expect(uiStateApi.patch).toHaveBeenCalledTimes(3))
    const payload = vi.mocked(uiStateApi.patch).mock.calls[2]![0] as AllState
    expect(payload.local?.editorPrefs).toEqual({ mdMode: 'source' })
  })

  it('setMdMode：更新偏好并持久化（按钮直切路径）', async () => {
    mockServerData({})
    const prefs = await freshPrefs()
    await prefs.ensureLoaded()
    prefs.setMdMode('source')
    expect(prefs.preferredMode.value).toBe('source')
    await vi.waitFor(() => expect(uiStateApi.patch).toHaveBeenCalledTimes(1))
  })

  it('ensureLoaded 幂等：重复调用不重复拉取服务端', async () => {
    mockServerData({})
    const prefs = await freshPrefs()
    await prefs.ensureLoaded()
    await prefs.ensureLoaded()
    expect(uiStateApi.get).toHaveBeenCalledTimes(1)
  })
})
