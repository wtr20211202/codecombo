import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useLogStore } from '@/stores/log'
import { logApi, diffApi } from '@/api/client'

vi.mock('@/api/client', () => ({
  logApi: { getLog: vi.fn(), getFileLog: vi.fn(), getCommitFiles: vi.fn(), search: vi.fn(), getRecentMessages: vi.fn() },
  diffApi: { getDiff: vi.fn(), getFileDiff: vi.fn(), getCommitDiff: vi.fn() },
}))

describe('logStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('初始状态', () => {
    const store = useLogStore()
    expect(store.commits).toEqual([])
    expect(store.loading).toBe(false)
    expect(store.hasMore).toBe(true)
    expect(store.selectedCommit).toBe('')
  })

  it('fetchLog 成功后更新提交列表', async () => {
    const mockCommits = [
      { hash: 'abc123def456789012345678901234567890abcd', shortHash: 'abc123d', message: 'fix bug', author: 'dev', email: 'dev@t.com', date: '2026-01-01', parents: [], refs: [], gpgStatus: '' },
    ]
    // axios 拦截器已解包 response.data，logApi 返回已解包值
    vi.mocked(logApi.getLog).mockResolvedValue({ data: mockCommits })
    const store = useLogStore()
    await store.fetchLog('p1')
    expect(store.commits).toEqual(mockCommits)
    expect(store.loading).toBe(false)
  })

  it('fetchLog 失败时 loading 重置', async () => {
    vi.mocked(logApi.getLog).mockRejectedValue(new Error('fail'))
    const store = useLogStore()
    store.loading = true
    // store 使用 try/finally（无 catch），错误会继续传播
    await expect(store.fetchLog('p1')).rejects.toThrow('fail')
    expect(store.loading).toBe(false)
  })

  it('selectCommit 成功后加载提交文件列表', async () => {
    const mockFiles = [{ path: 'src/a.ts', oldPath: '', status: 'Modified' }]
    vi.mocked(logApi.getCommitFiles).mockResolvedValue({ data: mockFiles })
    const store = useLogStore()
    await store.selectCommit('p1', 'abc123')
    expect(store.selectedCommit).toBe('abc123')
    expect(store.commitFiles).toEqual(mockFiles)
    expect(store.detailLoading).toBe(false)
  })

  it('selectCommit 失败时 detailLoading 重置', async () => {
    vi.mocked(logApi.getCommitFiles).mockRejectedValue(new Error('fail'))
    const store = useLogStore()
    store.detailLoading = true
    // store 使用 try/finally（无 catch），错误会继续传播
    await expect(store.selectCommit('p1', 'abc123')).rejects.toThrow('fail')
    expect(store.selectedCommit).toBe('abc123')
    expect(store.detailLoading).toBe(false)
  })

  it('clearDetail 清空所有详情状态', () => {
    const store = useLogStore()
    store.selectedCommit = 'abc'
    store.commitFiles = [{ path: 'a.txt', oldPath: '', status: 'M' }]
    store.commitDiff = '--- diff'
    store.commitDiffFile = 'a.txt'
    store.clearDetail()
    expect(store.selectedCommit).toBe('')
    expect(store.commitFiles).toEqual([])
    expect(store.commitDiff).toBe('')
    expect(store.commitDiffFile).toBe('')
  })
})
