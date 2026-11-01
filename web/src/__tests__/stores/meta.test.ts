import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

// 能力探测缓存（P-20261004-4）：ensureCaps 幂等/失败语义 + hasCap 实例维度分流。
// metaApi 与实例上下文均 mock（拦住真实 http.ts 重依赖链），上下文可变以便
// 验证「实例维度」缓存键隔离
const h = vi.hoisted(() => ({
  metaGet: vi.fn(),
  ctx: { instanceId: null as string | null, isRemote: false },
}))

vi.mock('@/api/domains/system', () => ({
  metaApi: { get: h.metaGet },
}))
vi.mock('@/api/client', () => ({
  getCurrentInstanceContext: () => h.ctx,
}))

import { useMetaStore, CAP_FLAT_FILE_LIST, CAP_AHEAD_BEHIND_ALL } from '@/stores/meta'

beforeEach(() => {
  setActivePinia(createPinia())
  h.ctx.instanceId = null
  h.ctx.isRemote = false
  h.metaGet.mockReset()
  h.metaGet.mockResolvedValue({
    version: { version: '1.0.0', commit: 'abc', buildTime: 'now', apiVersion: '1.0.0' },
    capabilities: [CAP_FLAT_FILE_LIST, CAP_AHEAD_BEHIND_ALL],
  })
})

describe('meta store', () => {
  it('未拉取时 hasCap false；ensureCaps 后按服务端声明放行', async () => {
    const s = useMetaStore()
    expect(s.hasCap(CAP_FLAT_FILE_LIST)).toBe(false)
    await s.ensureCaps()
    expect(s.hasCap(CAP_FLAT_FILE_LIST)).toBe(true)
    expect(s.hasCap(CAP_AHEAD_BEHIND_ALL)).toBe(true)
  })

  it('capability 未注册时 hasCap false（提案④：探测分流不误放行）', async () => {
    const s = useMetaStore()
    await s.ensureCaps()
    expect(s.hasCap('no-such-capability')).toBe(false)
  })

  it('探测失败（旧对端无 /meta）按无能力处理，且本页周期不重试', async () => {
    h.metaGet.mockRejectedValue(new Error('404'))
    const s = useMetaStore()
    await s.ensureCaps()
    expect(s.hasCap(CAP_FLAT_FILE_LIST)).toBe(false)
    await s.ensureCaps()
    expect(h.metaGet).toHaveBeenCalledTimes(1)
  })

  it('实例维度缓存：切实例未拉取 → false；分别拉取互不串扰、回切命中缓存', async () => {
    const s = useMetaStore()
    await s.ensureCaps() // 本机（key=local）
    h.ctx.instanceId = 'inst-2'
    expect(s.hasCap(CAP_FLAT_FILE_LIST)).toBe(false) // 新实例未拉取
    await s.ensureCaps()
    expect(s.hasCap(CAP_FLAT_FILE_LIST)).toBe(true)
    expect(h.metaGet).toHaveBeenCalledTimes(2)
    // 回切本机：缓存仍在，不重发
    h.ctx.instanceId = null
    await s.ensureCaps()
    expect(h.metaGet).toHaveBeenCalledTimes(2)
    expect(s.hasCap(CAP_FLAT_FILE_LIST)).toBe(true)
  })

  it('并发 ensureCaps 去重：同一实例只发一次探测', async () => {
    h.metaGet.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({
      version: { version: '1.0.0', commit: 'abc', buildTime: 'now', apiVersion: '1.0.0' },
      capabilities: [CAP_FLAT_FILE_LIST],
    }), 5)))
    const s = useMetaStore()
    await Promise.all([s.ensureCaps(), s.ensureCaps(), s.ensureCaps()])
    expect(h.metaGet).toHaveBeenCalledTimes(1)
    expect(s.hasCap(CAP_FLAT_FILE_LIST)).toBe(true)
  })

  it('meta 载荷缺 capabilities 字段（异形对端）按空清单处理，版本仍入缓存', async () => {
    h.metaGet.mockResolvedValue({ version: { version: '0.9.0', commit: 'x', buildTime: 'y', apiVersion: '1.0.0' } })
    const s = useMetaStore()
    await s.ensureCaps()
    expect(s.hasCap(CAP_FLAT_FILE_LIST)).toBe(false)
    expect(s.versionByInstance.local?.version).toBe('0.9.0')
  })
})
