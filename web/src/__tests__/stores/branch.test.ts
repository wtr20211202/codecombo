import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useBranchStore } from '@/stores/branch'
import { branchApi } from '@/api/client'

vi.mock('@/api/client', () => ({
  branchApi: {
    list: vi.fn(),
    create: vi.fn(),
    checkout: vi.fn(),
    delete: vi.fn(),
    merge: vi.fn(),
  },
}))

describe('branchStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('初始状态为空分支列表', () => {
    const store = useBranchStore()
    expect(store.branches).toEqual([])
    expect(store.loading).toBe(false)
  })

  it('fetchBranches 成功后更新', async () => {
    const mockBranches = [
      { name: 'main', isCurrent: true, isRemote: false, isMerged: false, upstream: '', ahead: 0, behind: 0 },
      { name: 'feature', isCurrent: false, isRemote: false, isMerged: false, upstream: '', ahead: 3, behind: 0 },
    ]
    // axios 拦截器已解包 response.data，store 内读取 res.data
    vi.mocked(branchApi.list).mockResolvedValue({ data: mockBranches })
    const store = useBranchStore()
    await store.fetchBranches('p1')
    expect(store.branches).toEqual(mockBranches)
    expect(store.loading).toBe(false)
  })

  it('fetchBranches 失败时保持旧数据', async () => {
    vi.mocked(branchApi.list).mockRejectedValue(new Error('fail'))
    const store = useBranchStore()
    store.branches = [{ name: 'main', isCurrent: true, isRemote: false, isMerged: false, upstream: '', ahead: 0, behind: 0 }]
    // store 使用 try/finally（无 catch），错误会继续传播
    await expect(store.fetchBranches('p1')).rejects.toThrow('fail')
    expect(store.branches.length).toBe(1)
  })

  it('createBranch 调用 create API 并刷新列表', async () => {
    vi.mocked(branchApi.create).mockResolvedValue({})
    vi.mocked(branchApi.list).mockResolvedValue({ data: [] })
    const store = useBranchStore()
    await store.createBranch('p1', 'feature-x', true)
    expect(branchApi.create).toHaveBeenCalledWith('p1', 'feature-x', true)
    expect(branchApi.list).toHaveBeenCalledWith('p1')
  })

  it('checkoutBranch 调用 checkout API 并刷新列表', async () => {
    vi.mocked(branchApi.checkout).mockResolvedValue({})
    vi.mocked(branchApi.list).mockResolvedValue({ data: [] })
    const store = useBranchStore()
    await store.checkoutBranch('p1', 'dev')
    expect(branchApi.checkout).toHaveBeenCalledWith('p1', 'dev')
    expect(branchApi.list).toHaveBeenCalledWith('p1')
  })

  it('localBranches computed 过滤本地分支', () => {
    const store = useBranchStore()
    store.branches = [
      { name: 'main', isCurrent: true, isRemote: false, isMerged: false, upstream: '', ahead: 0, behind: 0 },
      { name: 'origin/main', isCurrent: false, isRemote: true, isMerged: false, upstream: '', ahead: 0, behind: 0 },
    ]
    expect(store.localBranches.length).toBe(1)
    expect(store.localBranches[0].name).toBe('main')
  })

  it('remoteBranches computed 过滤远程分支', () => {
    const store = useBranchStore()
    store.branches = [
      { name: 'main', isCurrent: true, isRemote: false, isMerged: false, upstream: '', ahead: 0, behind: 0 },
      { name: 'origin/main', isCurrent: false, isRemote: true, isMerged: false, upstream: '', ahead: 0, behind: 0 },
    ]
    expect(store.remoteBranches.length).toBe(1)
    expect(store.remoteBranches[0].name).toBe('origin/main')
  })
})
