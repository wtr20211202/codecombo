import { describe, expect, it, vi, beforeEach } from 'vitest'

// ── mock 边界：外部依赖只有 ① envProfileApi ② 项目 store（useChangeStream.test
// 同款边界——composable 内部逻辑不 mock）。覆盖：取数落地/令牌防过期响应/源级
// 降级标记/无项目短路/失败态 ──
const { getMock } = vi.hoisted(() => ({
  getMock: vi.fn<(projectId: string) => Promise<unknown>>(),
}))
vi.mock('../api/domains/envprofile', () => ({
  envProfileApi: { get: (projectId: string) => getMock(projectId) },
}))

import { setActivePinia, createPinia } from 'pinia'
import { useEnvProfile } from './useEnvProfile'
import { useProjectStore } from '../stores/project'

function seedProject(id: string): void {
  const store = useProjectStore()
  store.projects = [{ id, name: id, path: '/ws/x', currentBranch: '', remoteURL: '', valid: true }] as never
  store.currentProjectId = id
}

beforeEach(() => {
  getMock.mockReset()
  setActivePinia(createPinia())
})

describe('useEnvProfile', () => {
  it('refresh 落地画像：devPorts 恒在场，两源键在场时降级标记为 false', async () => {
    seedProject('p1')
    getMock.mockResolvedValue({
      data: {
        projectId: 'p1',
        devPorts: [{ port: 5173, label: 'vite', source: 'detected', firstSeen: '2026-10-18T00:00:00Z', lastSeen: '2026-10-18T00:00:00Z' }],
        sentinels: [{ id: 'sc_sn_1', name: '盯 OOM', level: 'error', scope: 'global' }],
        deployTargets: [{ id: 'rh1', name: 'build', protocol: 'sftp', authType: 'password' }],
      },
    })
    const { profile, loading, loadFailed, degraded, refresh } = useEnvProfile()
    await refresh()
    expect(getMock).toHaveBeenCalledWith('p1')
    expect(profile.value?.devPorts).toHaveLength(1)
    expect(profile.value?.sentinels).toHaveLength(1)
    expect(profile.value?.deployTargets).toHaveLength(1)
    expect(degraded.value).toEqual({ sentinels: false, deployTargets: false })
    expect(loadFailed.value).toBe(false)
    expect(loading.value).toBe(false)
  })

  it('源级降级：sentinels/deployTargets 键缺席 = undefined 区分于空数组，标记为 true', async () => {
    seedProject('p1')
    getMock.mockResolvedValue({ data: { projectId: 'p1', devPorts: [] } })
    const { profile, degraded, refresh } = useEnvProfile()
    await refresh()
    expect(profile.value?.devPorts).toEqual([])
    expect(profile.value?.sentinels).toBeUndefined()
    expect(profile.value?.deployTargets).toBeUndefined()
    expect(degraded.value).toEqual({ sentinels: true, deployTargets: true })
  })

  it('过期响应不落地（令牌防串：慢响应的旧项目数据不覆盖新项目画像）', async () => {
    seedProject('p1')
    let releaseA!: (v: unknown) => void
    getMock.mockImplementationOnce(() => new Promise((resolve) => { releaseA = resolve }))
    const { profile, refresh } = useEnvProfile()
    const first = refresh()
    // 项目切到 p2 且其响应先回
    seedProject('p2')
    getMock.mockResolvedValueOnce({ data: { projectId: 'p2', devPorts: [] } })
    await refresh()
    releaseA({ data: { projectId: 'p1', devPorts: [{ port: 1, label: 'stale', source: 'detected', firstSeen: '', lastSeen: '' }] } })
    await first
    expect(profile.value?.projectId).toBe('p2')
  })

  it('无当前项目短路不发请求', async () => {
    useProjectStore().currentProjectId = ''
    const { refresh } = useEnvProfile()
    await refresh()
    expect(getMock).not.toHaveBeenCalled()
  })

  it('请求失败置 loadFailed 且不复原旧画像（保留上次数据供降级展示）', async () => {
    seedProject('p1')
    getMock.mockResolvedValueOnce({ data: { projectId: 'p1', devPorts: [] } })
    const { profile, loadFailed, refresh } = useEnvProfile()
    await refresh()
    expect(loadFailed.value).toBe(false)
    getMock.mockRejectedValueOnce(new Error('network'))
    await refresh()
    expect(loadFailed.value).toBe(true)
    expect(profile.value?.projectId).toBe('p1')
  })
})
