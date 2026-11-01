import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// ── mock 边界：本组合式的外部依赖只有 ① projectApi 笔记/TODO 取数 ② settings
// 读取（store ensureLoaded）③ git 摘要取数面（独立测，本文件按注入值断言装配
// 与声明序）④ 环境画像端点（P-20261007-14 注入源）⑤ vue-i18n（真模板：t 直接
// 查 zh-CN 语言包插值）──
const { notesMock, todosMock, envProfileMock, settingsGetMock, gitSummaryMock } = vi.hoisted(() => ({
  notesMock: vi.fn<(id: string) => Promise<unknown>>(),
  todosMock: vi.fn<(id: string) => Promise<unknown>>(),
  envProfileMock: vi.fn<(id: string) => Promise<unknown>>(),
  settingsGetMock: vi.fn<() => Promise<unknown>>(),
  gitSummaryMock: vi.fn<() => Promise<string>>(),
}))

vi.mock('../api/client', () => ({
  projectApi: { projectNotes: notesMock, projectTodos: todosMock },
  settingsApi: { get: settingsGetMock },
}))

vi.mock('../api/domains/envprofile', () => ({
  envProfileApi: { get: envProfileMock },
}))

vi.mock('./useGitStatusSummary', () => ({
  useGitStatusSummary: () => ({ buildCurrentSummary: gitSummaryMock }),
}))

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

import { useSessionContextSummary } from './useSessionContextSummary'
import { useProjectStore } from '../stores/project'
import { useSessionContextStore } from '../stores/sessionContext'

function seedProject() {
  const store = useProjectStore()
  store.projects = [{
    id: 'p1', name: 'demo', path: 'D:/repo/demo', currentBranch: 'main', remoteURL: '', valid: true,
  }]
  store.currentProjectId = 'p1'
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.resetAllMocks()
  seedProject()
  // 默认无摘要/无笔记/无待办 + store 默认 git 档：既有语义（git-only 注入）
  gitSummaryMock.mockResolvedValue('')
  notesMock.mockResolvedValue({ data: { content: '' } })
  todosMock.mockResolvedValue({ data: [], total: 0, truncated: false })
  envProfileMock.mockResolvedValue({ data: { projectId: 'p1', devPorts: [] } })
  // ensureLoaded 首载默认（GET 空配置 = git 档）
  settingsGetMock.mockResolvedValue({ data: { sessionContext: 'git' } })
})

describe('useSessionContextSummary 上下文装配（P-20261006-47）', () => {
  it('默认 git 档：只装配 git 段，笔记/TODO 零取数（未勾选不花请求）', async () => {
    gitSummaryMock.mockResolvedValue('git 状态（demo）：分支 main，工作区干净')
    const { buildContextSections } = useSessionContextSummary()

    const sections = await buildContextSections()

    expect(sections).toEqual([
      { id: 'git', kind: 'atomic', text: 'git 状态（demo）：分支 main，工作区干净' },
    ])
    expect(notesMock).not.toHaveBeenCalled()
    expect(todosMock).not.toHaveBeenCalled()
    expect(envProfileMock).not.toHaveBeenCalled()
  })

  it('设置勾全：装配序 notes→todos→git（声明序 = 弃段阶梯，git 殿后保 git）', async () => {
    useSessionContextStore().hydrate({ sessionContext: 'todos,git,notes' })
    gitSummaryMock.mockResolvedValue('GIT 行')
    notesMock.mockResolvedValue({ data: { content: '笔记首段' } })
    todosMock.mockResolvedValue({
      data: [{ path: 'src/a.ts', items: [{ path: 'src/a.ts', line: 12 }] }],
      total: 1,
      truncated: false,
    })
    const { buildContextSections } = useSessionContextSummary()

    const sections = await buildContextSections()

    expect(sections.map(s => s.id)).toEqual(['notes', 'todos', 'git'])
    expect(sections[0]).toEqual({ id: 'notes', kind: 'atomic', text: '项目笔记（demo）：笔记首段' })
    expect(sections[1]).toEqual({ id: 'todos', kind: 'atomic', text: 'TODO 概要（demo）：1 处待办，如 src/a.ts:12' })
    expect(sections[2]?.text).toBe('GIT 行')
  })

  it('override（对话框按次覆选）优先于设置：未勾选的 git 也不注入', async () => {
    notesMock.mockResolvedValue({ data: { content: '笔记首段' } })
    const { buildContextSections } = useSessionContextSummary()

    const sections = await buildContextSections(['notes'])

    expect(sections.map(s => s.id)).toEqual(['notes'])
    expect(gitSummaryMock).not.toHaveBeenCalled()
    expect(todosMock).not.toHaveBeenCalled()
  })

  it('设置勾 env：装配环境画像段（端口/哨兵/目标概要），未勾选源零取数', async () => {
    useSessionContextStore().hydrate({ sessionContext: 'env' })
    envProfileMock.mockResolvedValue({
      data: {
        projectId: 'p1',
        devPorts: [{ port: 5173, label: 'vite', source: 'reported', firstSeen: '', lastSeen: '' }],
        sentinels: [{ id: 'sn1', name: '盯 OOM', level: 'error', scope: 'global' }],
        deployTargets: [{ id: 'h1', name: 'build', protocol: 'sftp', authType: 'password' }],
      },
    })
    const { buildContextSections } = useSessionContextSummary()

    const sections = await buildContextSections()

    expect(sections.map(s => s.id)).toEqual(['env'])
    expect(sections[0]?.text).toContain('环境画像（demo）：端口 5173 vite；哨兵 1 条；部署目标 build')
    expect(gitSummaryMock).not.toHaveBeenCalled()
    expect(notesMock).not.toHaveBeenCalled()
    expect(todosMock).not.toHaveBeenCalled()
  })

  it('环境画像取数失败静默缺省（不阻塞发起，其余选项照常）', async () => {
    useSessionContextStore().hydrate({ sessionContext: 'git,env' })
    gitSummaryMock.mockResolvedValue('GIT 行')
    envProfileMock.mockRejectedValue(new Error('network down'))
    const { buildContextSections } = useSessionContextSummary()

    const sections = await buildContextSections()

    expect(sections.map(s => s.id)).toEqual(['git'])
  })

  it('取数失败该选项静默缺省（尽力而为绝不阻塞发起），其余选项照常', async () => {
    useSessionContextStore().hydrate({ sessionContext: 'git,notes,todos' })
    gitSummaryMock.mockResolvedValue('GIT 行')
    notesMock.mockRejectedValue(new Error('network down'))
    todosMock.mockResolvedValue({ data: [], total: 3, truncated: false })
    const { buildContextSections } = useSessionContextSummary()

    const sections = await buildContextSections()

    expect(sections.map(s => s.id)).toEqual(['todos', 'git'])
  })

  it('无当前项目：笔记/TODO 零请求，git 摘要取数面自行降级空串，装配结果为空数组', async () => {
    const store = useProjectStore()
    store.projects = []
    store.currentProjectId = ''
    useSessionContextStore().hydrate({ sessionContext: 'git,notes,todos' })
    gitSummaryMock.mockResolvedValue('') // 真实取数面对无项目返回 ''（此处 mock 同态）
    const { buildContextSections } = useSessionContextSummary()

    const sections = await buildContextSections()

    expect(sections).toEqual([])
    expect(notesMock).not.toHaveBeenCalled()
    expect(todosMock).not.toHaveBeenCalled()
    expect(envProfileMock).not.toHaveBeenCalled()
  })

  it('store ensureLoaded 首载：settings GET 的值决定默认档（agent 经 settings API 自调即生效）', async () => {
    settingsGetMock.mockResolvedValue({ data: { sessionContext: 'none' } })
    const { buildContextSections } = useSessionContextSummary()

    const sections = await buildContextSections()

    expect(settingsGetMock).toHaveBeenCalledTimes(1)
    expect(sections).toEqual([])
    // 二次调用不再重复拉 settings（首载去重，广播刷新走显式 load）
    await buildContextSections()
    expect(settingsGetMock).toHaveBeenCalledTimes(1)
  })
})
