import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// ── mock 边界：唯一外部依赖是 logApi（最近提交主题 limit=1 现查）；i18n 用真
// zh 语言包插值（useEditorAskAgent.test.ts 同款口径），stores 用真 Pinia ──
const { getLogMock } = vi.hoisted(() => ({
  getLogMock: vi.fn<(projectId: string, params?: { limit?: number }) =>
    Promise<{ data?: Array<{ message?: string; body?: string }> }>>(),
}))

vi.mock('../api/client', async (importOriginal) => {
  // 部分 mock：项目/变更等 API 面保留原值（store 只在动作里调用），仅替换本
  // 组合式用到的 logApi.getLog
  const actual = await importOriginal<typeof import('../api/client')>()
  return { ...actual, logApi: { ...actual.logApi, getLog: getLogMock } }
})

vi.mock('vue-i18n', async () => {
  const zh = (await import('../locales/zh-CN')).default
  const get = (o: Record<string, unknown>, k: string): unknown =>
    k.split('.').reduce<unknown>((a, c) => (a as Record<string, unknown> | undefined)?.[c], o)
  return {
    useI18n: () => ({
      t: (key: string, params?: Record<string, unknown>) => {
        let s = get(zh, key) as string
        for (const [k, v] of Object.entries(params ?? {})) s = s.replaceAll(`{${k}}`, String(v))
        return s
      },
    }),
  }
})

import { useGitStatusSummary } from './useGitStatusSummary'
import { useProjectStore } from '../stores/project'
import { useChangesStore } from '../stores/changes'

function seedProject(opts?: { branch?: string; name?: string }) {
  const store = useProjectStore()
  store.projects = [{
    id: 'p1',
    name: opts?.name ?? 'demo',
    path: 'D:/repo/demo',
    currentBranch: opts?.branch ?? 'main',
    remoteURL: '',
    valid: true,
  }]
  store.currentProjectId = 'p1'
}

function seedChanges(count: number) {
  useChangesStore().files = Array.from({ length: count }, (_, i) => ({
    path: `f${i}.ts`,
    status: 'Modified',
    staged: false,
  }))
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.resetAllMocks()
})

describe('useGitStatusSummary 取数面（P-20261003-176）', () => {
  it('聚齐三事实：分支 + 变更数 + 最近提交主题（limit=1 现查）', async () => {
    seedProject()
    seedChanges(2)
    getLogMock.mockResolvedValue({ data: [{ message: 'c1: add app', body: 'c1: add app\n\nbody' }] })
    const { buildCurrentSummary } = useGitStatusSummary()

    const line = await buildCurrentSummary()

    expect(getLogMock).toHaveBeenCalledWith('p1', { limit: 1 })
    expect(line).toBe('git 状态（demo）：分支 main，2 处未提交变更，最近提交：c1: add app')
  })

  it('log 拉取失败：降级无提交段，不 reject 不阻塞发起', async () => {
    seedProject()
    seedChanges(1)
    getLogMock.mockRejectedValue(new Error('boom'))
    const { buildCurrentSummary } = useGitStatusSummary()

    const line = await buildCurrentSummary()

    expect(line).toBe('git 状态（demo）：分支 main，1 处未提交变更')
  })

  it('空仓库（log 空列表）：降级无提交段', async () => {
    seedProject()
    seedChanges(0)
    getLogMock.mockResolvedValue({ data: [] })
    const { buildCurrentSummary } = useGitStatusSummary()

    expect(await buildCurrentSummary()).toBe('git 状态（demo）：分支 main，工作区干净')
  })

  it('无当前项目：空串（上游不注入）', async () => {
    const { buildCurrentSummary } = useGitStatusSummary()
    expect(await buildCurrentSummary()).toBe('')
    expect(getLogMock).not.toHaveBeenCalled()
  })

  it('非 git 工作区（无分支名）：空串不注入', async () => {
    seedProject({ branch: '' })
    seedChanges(3)
    const { buildCurrentSummary } = useGitStatusSummary()
    expect(await buildCurrentSummary()).toBe('')
    expect(getLogMock).not.toHaveBeenCalled()
  })
})
