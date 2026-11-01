import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useProjectStore, registerBeforeProjectSwitchHook } from '@/stores/project'
import { projectApi } from '@/api/client'

vi.mock('@/api/client', () => ({
  projectApi: {
    list: vi.fn(),
    add: vi.fn(),
    remove: vi.fn(),
    setLocked: vi.fn(),
  },
}))

describe('projectStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('初始状态为空', () => {
    const store = useProjectStore()
    expect(store.projects).toEqual([])
    expect(store.currentProjectId).toBe('')
    expect(store.loading).toBe(false)
  })

  it('fetchProjects 成功时更新列表并选中第一个项目', async () => {
    const mockProjects = [{ id: '1', name: 'test', path: '/tmp/test', currentBranch: 'main', remoteURL: '', valid: true }]
    vi.mocked(projectApi.list).mockResolvedValue({ data: mockProjects })
    const store = useProjectStore()
    await store.fetchProjects()
    expect(store.projects).toEqual(mockProjects)
    expect(store.currentProjectId).toBe('1')
    expect(store.loading).toBe(false)
  })

  it('fetchProjects 失败时保持空列表', async () => {
    vi.mocked(projectApi.list).mockRejectedValue(new Error('fail'))
    const store = useProjectStore()
    await expect(store.fetchProjects()).rejects.toThrow('fail')
    expect(store.projects).toEqual([])
    expect(store.loading).toBe(false)
  })

  it('addProject 成功后追加项目并选中', async () => {
    const newProject = { id: '2', name: 'new', path: '/tmp/new', currentBranch: 'main', remoteURL: '', valid: true }
    vi.mocked(projectApi.add).mockResolvedValue({ data: newProject })
    const store = useProjectStore()
    await store.addProject('new', '/tmp/new')
    expect(store.projects).toContainEqual(newProject)
    expect(store.currentProjectId).toBe('2')
  })

  it('removeProject 成功后移除项目', async () => {
    const store = useProjectStore()
    store.projects = [{ id: '1', name: 'test', path: '/tmp/test', currentBranch: 'main', remoteURL: '', valid: true }]
    store.currentProjectId = '1'
    await store.removeProject('1')
    expect(store.projects).toEqual([])
    expect(store.currentProjectId).toBe('')
  })

  it('removeProject 删除非当前项目不改变 currentProjectId', async () => {
    const store = useProjectStore()
    store.projects = [
      { id: '1', name: 'a', path: '/a', currentBranch: 'main', remoteURL: '', valid: true },
      { id: '2', name: 'b', path: '/b', currentBranch: 'main', remoteURL: '', valid: true },
    ]
    store.currentProjectId = '1'
    await store.removeProject('2')
    expect(store.currentProjectId).toBe('1')
  })

  it('selectProject 切换选中', () => {
    const store = useProjectStore()
    store.selectProject('3')
    expect(store.currentProjectId).toBe('3')
  })

  it('显式选择打标：消费一次即清（Layout 恢复流程据此跳过 uiState 覆盖）', () => {
    const store = useProjectStore()
    store.selectProjectExplicit('a')
    expect(store.currentProjectId).toBe('a')
    expect(store.consumeExplicitSelectId()).toBe('a')
    // 消费后清空：不残留到下一次挂载
    expect(store.consumeExplicitSelectId()).toBe('')
    // 普通 selectProject 不打标
    store.selectProject('b')
    expect(store.consumeExplicitSelectId()).toBe('')
  })

  it('currentProject 计算属性返回当前项目', () => {
    const store = useProjectStore()
    store.projects = [
      { id: '1', name: 'a', path: '/a', currentBranch: 'main', remoteURL: '', valid: true },
      { id: '2', name: 'b', path: '/b', currentBranch: 'main', remoteURL: '', valid: true },
    ]
    store.currentProjectId = '2'
    expect(store.currentProject?.name).toBe('b')
  })

  // ── 项目切换守卫（P-20261003-105）──
  describe('项目切换守卫', () => {
    afterEach(() => {
      // 还原为同步放行守卫：与无守卫对同步调用方语义完全一致（同步 true →
      // 同步赋值），不污染本文件其余用例
      registerBeforeProjectSwitchHook(() => true)
    })

    it('同步 false 取消切换；同步 true 放行且保持同步赋值', () => {
      const store = useProjectStore()
      registerBeforeProjectSwitchHook(() => false)
      expect(store.selectProject('3')).toBe(false)
      expect(store.currentProjectId).toBe('')
      registerBeforeProjectSwitchHook(() => true)
      expect(store.selectProject('3')).toBe(true)
      expect(store.currentProjectId).toBe('3')
    })

    it('异步裁决：确认后落定，取消维持原项目且不污染显式打标', async () => {
      const store = useProjectStore()
      registerBeforeProjectSwitchHook(async () => true)
      await expect(store.selectProjectExplicit('a')).resolves.toBe(true)
      expect(store.currentProjectId).toBe('a')
      expect(store.consumeExplicitSelectId()).toBe('a')
      registerBeforeProjectSwitchHook(async () => false)
      await expect(store.selectProjectExplicit('b')).resolves.toBe(false)
      expect(store.currentProjectId).toBe('a')
      // 取消的切换不得打标（打标语义 = 用户已进入该项目，供 Layout 恢复跳过
      // 覆盖）：首次消费已清空，此处若被取消切换误写会是 'b'
      expect(store.consumeExplicitSelectId()).toBe('')
    })

    it('同项目重入不经守卫（watch 同键短路，无清场面可拦）', () => {
      const store = useProjectStore()
      store.currentProjectId = 'same'
      const guard = vi.fn(() => false)
      registerBeforeProjectSwitchHook(guard)
      store.selectProjectExplicit('same')
      expect(store.currentProjectId).toBe('same')
      expect(store.consumeExplicitSelectId()).toBe('same')
      expect(guard).not.toHaveBeenCalled()
    })

    it('注销函数自校验身份：先注册的守卫注销不得误摘后注册者', () => {
      const store = useProjectStore()
      const disposeFirst = registerBeforeProjectSwitchHook(() => false)
      registerBeforeProjectSwitchHook(() => true)
      disposeFirst()
      expect(store.selectProject('x')).toBe(true)
      expect(store.currentProjectId).toBe('x')
    })
  })

  it('setProjectLocked 就地替换为服务端回传的最新态（P-20261004-3）', async () => {
    const store = useProjectStore()
    store.projects = [{ id: '1', name: 'a', path: '/a', currentBranch: 'main', remoteURL: '', valid: true }]
    vi.mocked(projectApi.setLocked).mockResolvedValue({ data: { id: '1', locked: true } })
    await store.setProjectLocked('1', true)
    expect(projectApi.setLocked).toHaveBeenCalledWith('1', true)
    expect(store.projects[0]).toMatchObject({ id: '1', locked: true, name: 'a' })
    // 解锁恢复
    vi.mocked(projectApi.setLocked).mockResolvedValue({ data: { id: '1', locked: false } })
    await store.setProjectLocked('1', false)
    expect(store.projects[0]).toMatchObject({ id: '1', locked: false })
  })
})
