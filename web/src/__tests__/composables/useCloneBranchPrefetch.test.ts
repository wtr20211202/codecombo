import { describe, it, expect, vi, beforeEach } from 'vitest'

// 克隆前分支预取（P-20261003-93）：纯 ref 状态 + cloneApi 调用，jsdom 可测
vi.mock('@/api/client', () => ({
  cloneApi: { branches: vi.fn() },
}))

import { cloneApi } from '@/api/client'
import { useCloneBranchPrefetch, branchErrorI18nKey } from '@/composables/useCloneBranchPrefetch'

const mockedBranches = vi.mocked(cloneApi.branches)

describe('useCloneBranchPrefetch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('成功：填充分支列表并按其生成下拉 options，清除旧提示', async () => {
    mockedBranches.mockResolvedValue({ data: ['main', 'feat/x'] } as any)
    const pf = useCloneBranchPrefetch()
    await pf.fetchBranches(' https://github.com/u/r.git ')
    expect(mockedBranches).toHaveBeenCalledWith(
      { url: 'https://github.com/u/r.git', sshKeyId: undefined },
      { silent: true },
    )
    expect(pf.branches.value).toEqual(['main', 'feat/x'])
    expect(pf.branchOptions.value).toEqual([
      { label: 'main', value: 'main' },
      { label: 'feat/x', value: 'feat/x' },
    ])
    expect(pf.branchErrorKey.value).toBe('')
  })

  it('失败：清空列表并把 502 稳定标记映射为对应 i18n key（静默不阻断）', async () => {
    const { AppError } = await import('@/api/error-types')
    mockedBranches.mockRejectedValue(new AppError(
      'server',
      'remote branch prefetch failed: authentication failed: git ls-remote: fatal: Authentication failed',
      502, '/clone/branches', 'POST',
    ))
    const pf = useCloneBranchPrefetch()
    await pf.fetchBranches('https://github.com/u/r.git')
    expect(pf.branches.value).toEqual([])
    expect(pf.branchErrorKey.value).toBe('clone.branches.failedAuth')
  })

  it('未识别错误落兜底 key；空 URL 直接跳过不发请求', async () => {
    mockedBranches.mockRejectedValue(new Error('boom'))
    const pf = useCloneBranchPrefetch()
    await pf.fetchBranches('https://github.com/u/r.git')
    expect(pf.branchErrorKey.value).toBe('clone.branches.failedGeneric')

    mockedBranches.mockClear()
    await pf.fetchBranches('   ')
    expect(mockedBranches).not.toHaveBeenCalled()
  })

  it('进行中防重入：上一次未返回前再次触发不重复发请求', async () => {
    let resolve!: (v: unknown) => void
    mockedBranches.mockImplementation(() => new Promise(r => { resolve = r }))
    const pf = useCloneBranchPrefetch()
    const first = pf.fetchBranches('https://github.com/u/r.git')
    const second = pf.fetchBranches('https://github.com/u/r2.git')
    resolve({ data: ['main'] })
    await Promise.all([first, second])
    expect(mockedBranches).toHaveBeenCalledTimes(1)
  })

  it('resetBranches 清空列表/提示/加载态', async () => {
    mockedBranches.mockResolvedValue({ data: ['main'] } as any)
    const pf = useCloneBranchPrefetch()
    await pf.fetchBranches('https://github.com/u/r.git')
    pf.resetBranches()
    expect(pf.branches.value).toEqual([])
    expect(pf.branchOptions.value).toEqual([])
    expect(pf.branchErrorKey.value).toBe('')
    expect(pf.loadingBranches.value).toBe(false)
  })
})

describe('branchErrorI18nKey', () => {
  it('按服务端稳定标记分类（clone.go lsRemoteBranchesErrPrefix + 类别）', () => {
    expect(branchErrorI18nKey('remote branch prefetch failed: authentication failed: x'))
      .toBe('clone.branches.failedAuth')
    expect(branchErrorI18nKey('remote branch prefetch failed: remote unreachable: x'))
      .toBe('clone.branches.failedUnreachable')
    expect(branchErrorI18nKey('remote branch prefetch failed: repository not found: x'))
      .toBe('clone.branches.failedNotFound')
    expect(branchErrorI18nKey('remote branch prefetch failed: git ls-remote: unknown'))
      .toBe('clone.branches.failedGeneric')
    expect(branchErrorI18nKey('')).toBe('clone.branches.failedGeneric')
  })
})
