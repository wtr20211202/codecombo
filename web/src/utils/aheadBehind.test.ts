import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchAheadBehindMap } from './aheadBehind'
import { projectApi } from '../api/client'

// meta store 与 axios client 均替身化：纯函数级的分流逻辑测试，不拉真请求
const metaMock = vi.hoisted(() => ({
  ensureCaps: vi.fn(async () => {}),
  hasCap: vi.fn(() => true),
}))
vi.mock('@/stores/meta', () => ({
  CAP_AHEAD_BEHIND_ALL: 'ahead-behind-all',
  useMetaStore: () => metaMock,
}))
vi.mock('../api/client', () => ({
  projectApi: {
    aheadBehindAll: vi.fn(),
    aheadBehind: vi.fn(),
  },
}))

function fail(status: number) {
  return { response: { status } }
}

describe('fetchAheadBehindMap', () => {
  beforeEach(() => {
    vi.mocked(projectApi.aheadBehindAll).mockReset()
    vi.mocked(projectApi.aheadBehind).mockReset()
    metaMock.hasCap.mockReturnValue(true)
  })

  it('能力在位走批量端点：缺项补 0/0，frozen 项目不参与', async () => {
    vi.mocked(projectApi.aheadBehindAll).mockResolvedValue({
      data: { p1: { ahead: 1, behind: 2 } },
    } as never)
    const map = await fetchAheadBehindMap([
      { id: 'p1' }, { id: 'p2' }, { id: 'p3', frozen: true },
    ])
    expect(projectApi.aheadBehindAll).toHaveBeenCalledTimes(1)
    expect(projectApi.aheadBehind).not.toHaveBeenCalled()
    expect(map).toEqual({ p1: { ahead: 1, behind: 2 }, p2: { ahead: 0, behind: 0 } })
  })

  it('批量端点 404（清单与路由漂移兜底）回退逐项目扇出', async () => {
    vi.mocked(projectApi.aheadBehindAll).mockRejectedValue(fail(404))
    vi.mocked(projectApi.aheadBehind).mockImplementation(async (id: string) => {
      if (id === 'p1') return { data: { ahead: 3, behind: 0 } } as never
      throw fail(500)
    })
    const map = await fetchAheadBehindMap([{ id: 'p1' }, { id: 'p2' }])
    expect(projectApi.aheadBehind).toHaveBeenCalledTimes(2)
    expect(map).toEqual({ p1: { ahead: 3, behind: 0 }, p2: { ahead: 0, behind: 0 } })
  })

  it('能力未声明（旧对端）直接扇出，不发注定失败的批量请求', async () => {
    metaMock.hasCap.mockReturnValue(false)
    vi.mocked(projectApi.aheadBehind).mockResolvedValue({ data: { ahead: 0, behind: 5 } } as never)
    const map = await fetchAheadBehindMap([{ id: 'p1' }])
    expect(projectApi.aheadBehindAll).not.toHaveBeenCalled()
    expect(map).toEqual({ p1: { ahead: 0, behind: 5 } })
  })

  it('批量端点非 404 失败：整体返回空映射（首页徽章缺省，不打扰用户）', async () => {
    vi.mocked(projectApi.aheadBehindAll).mockRejectedValue(fail(500))
    const map = await fetchAheadBehindMap([{ id: 'p1' }])
    expect(map).toEqual({})
    expect(projectApi.aheadBehind).not.toHaveBeenCalled()
  })
})
