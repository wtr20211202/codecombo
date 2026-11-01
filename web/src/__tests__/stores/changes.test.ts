import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useChangesStore } from '@/stores/changes'
import { projectApi, commitApi, diffApi } from '@/api/client'

vi.mock('@/api/client', () => ({
  projectApi: { status: vi.fn() },
  commitApi: { stage: vi.fn(), unstage: vi.fn(), commit: vi.fn(), rollback: vi.fn() },
  diffApi: { getDiff: vi.fn(), getFileDiff: vi.fn() },
  snapshotApi: { showFile: vi.fn() },
}))

describe('changesStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('初始状态', () => {
    const store = useChangesStore()
    expect(store.files).toEqual([])
    expect(store.loading).toBe(false)
    expect(store.selectedFile).toBe('')
    expect(store.diffContent).toBe('')
    expect(store.diffLoading).toBe(false)
    expect(store.threeWayEnabled).toBe(false)
  })

  it('fetchStatus 成功后更新文件列表', async () => {
    const mockFiles = [{ path: 'a.txt', status: 'Modified', staged: false }]
    // axios 拦截器已解包 response.data，store 内读取 res.data
    vi.mocked(projectApi.status).mockResolvedValue({ data: mockFiles })
    const store = useChangesStore()
    await store.fetchStatus('p1')
    expect(store.files).toEqual(mockFiles)
  })

  it('fetchStatus 失败后 loading 重置', async () => {
    vi.mocked(projectApi.status).mockRejectedValue(new Error('fail'))
    const store = useChangesStore()
    store.loading = true
    // store 使用 try/finally（无 catch），错误会继续传播
    await expect(store.fetchStatus('p1')).rejects.toThrow('fail')
    expect(store.loading).toBe(false)
  })

  it('selectedFile 可通过 fetchFileDiff 自动设置', async () => {
    vi.mocked(diffApi.getFileDiff).mockResolvedValue({ data: '' })
    const store = useChangesStore()
    await store.fetchFileDiff('p1', 'readme.md')
    expect(store.selectedFile).toBe('readme.md')
  })

  it('stageFiles 调用 stage API 并刷新状态', async () => {
    vi.mocked(commitApi.stage).mockResolvedValue({})
    vi.mocked(projectApi.status).mockResolvedValue({ data: [] })
    const store = useChangesStore()
    await store.stageFiles('p1', ['a.txt'])
    expect(commitApi.stage).toHaveBeenCalledWith('p1', ['a.txt'])
    expect(projectApi.status).toHaveBeenCalledWith('p1')
  })

  it('unstageFiles 调用 unstage API 并刷新状态', async () => {
    vi.mocked(commitApi.unstage).mockResolvedValue({})
    vi.mocked(projectApi.status).mockResolvedValue({ data: [] })
    const store = useChangesStore()
    await store.unstageFiles('p1', ['a.txt'])
    expect(commitApi.unstage).toHaveBeenCalledWith('p1', ['a.txt'])
    expect(projectApi.status).toHaveBeenCalledWith('p1')
  })

  it('commit 调用 commit API 并刷新状态', async () => {
    vi.mocked(commitApi.commit).mockResolvedValue({})
    vi.mocked(projectApi.status).mockResolvedValue({ data: [] })
    const store = useChangesStore()
    await store.commit('p1', 'test commit')
    expect(commitApi.commit).toHaveBeenCalledWith('p1', 'test commit', undefined, undefined, undefined, undefined, undefined)
    expect(projectApi.status).toHaveBeenCalledWith('p1')
  })

  it('fetchFileDiff 成功后更新 diffContent', async () => {
    vi.mocked(diffApi.getFileDiff).mockResolvedValue({ data: '--- a.txt\n+++ a.txt\n@@ -1 +1 @@\n-old\n+new' })
    const store = useChangesStore()
    await store.fetchFileDiff('p1', 'a.txt')
    expect(store.diffContent).toContain('--- a.txt')
    expect(store.diffLoading).toBe(false)
    expect(store.selectedFile).toBe('a.txt')
  })

  it('fetchFileDiff 失败时 diffLoading 重置', async () => {
    vi.mocked(diffApi.getFileDiff).mockRejectedValue(new Error('fail'))
    const store = useChangesStore()
    store.diffLoading = true
    // store 使用 try/finally（无 catch），错误会继续传播
    await expect(store.fetchFileDiff('p1', 'a.txt')).rejects.toThrow('fail')
    expect(store.diffLoading).toBe(false)
  })
})
