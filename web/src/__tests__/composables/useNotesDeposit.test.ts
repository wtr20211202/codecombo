import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// 「沉淀到笔记」find-or-create 单篇（P-20261108-3 单库化改道）组合式直测：naive-ui /
// vue-i18n 走一站式 mock 工厂（t=key 直通，断言按 key），笔记库 API 与视图开关桩住
vi.mock('naive-ui', async (importOriginal) =>
  (await import('@/__tests__/mocks/naiveRuntime')).mockNaiveUi(await importOriginal()),
)
vi.mock('vue-i18n', async (importOriginal) =>
  (await import('@/__tests__/mocks/naiveRuntime')).mockVueI18n(await importOriginal()),
)

type Meta = { id: string; title: string; updatedAt: string; size: number }
type Full = { id: string; title: string; content: string; createdAt: string; updatedAt: string }

const { listMock, getMock, createMock, saveMock, openNotesViewMock, sessionsState } = vi.hoisted(() => ({
  listMock: vi.fn<() => Promise<{ data?: Meta[] }>>(),
  getMock: vi.fn<(id: string) => Promise<{ data: Full }>>(),
  createMock: vi.fn<(body: { title?: string; content?: string }) => Promise<{ data: Full }>>(),
  saveMock: vi.fn<(id: string, body: { content: string; baseUpdatedAt?: string }) => Promise<{ data: Full }>>(),
  openNotesViewMock: vi.fn(),
  sessionsState: { sessions: [] as { id: string; projectId?: string; path?: string }[] },
}))

vi.mock('@/api/client', () => ({
  GLOBAL_NOTES_SCOPE: '_global',
  notesGlobalApi: { list: listMock, get: getMock, create: createMock, save: saveMock },
}))
vi.mock('@/composables/usePanelLayout', () => ({
  usePanelLayout: () => ({ openNotesView: openNotesViewMock }),
}))
vi.mock('@/stores/terminal-sessions', () => ({
  useTerminalSessionsStore: () => sessionsState,
}))
vi.mock('@/stores/assistantTask', () => ({
  useAssistantTaskStore: () => ({ latestSessionId: '', bySession: {}, status: 'done', displayTask: '', task: '' }),
}))

import { useNotesDeposit } from '@/composables/useNotesDeposit'
import { useProjectStore } from '@/stores/project'
import { NOTES_EXTERNAL_UPDATE, type NotesExternalUpdateDetail } from '@/utils/opsEvents'
import { messageMock, resetNaiveRuntimeMocks } from '@/__tests__/mocks/naiveRuntime'

const HANDOVER = '[demo] notes.deposit.handoverTitle' // t 为 key 直通：交接词即键名
const NOW = '2026-11-08T10:00:00Z'

function full(id: string, title: string, content: string, updatedAt = NOW): Full {
  return { id, title, content, createdAt: NOW, updatedAt }
}

const events: NotesExternalUpdateDetail[] = []
function onEvent(e: Event) {
  events.push((e as CustomEvent<NotesExternalUpdateDetail>).detail)
}

beforeEach(() => {
  resetNaiveRuntimeMocks()
  vi.clearAllMocks()
  setActivePinia(createPinia())
  const store = useProjectStore()
  store.projects = [
    { id: 'p1', name: 'demo', path: 'D:/repo/demo', currentBranch: 'main', remoteURL: '', valid: true },
    { id: 'p2', name: 'other', path: 'D:/repo/other', currentBranch: 'main', remoteURL: '', valid: true },
  ]
  store.currentProjectId = 'p1'
  sessionsState.sessions = []
  listMock.mockResolvedValue({ data: [] })
  createMock.mockImplementation(async (body) => ({ data: full('new-id', body.title ?? '', body.content ?? '') }))
  saveMock.mockImplementation(async (id, body) => ({ data: full(id, HANDOVER, body.content, '2026-11-08T11:00:00Z') }))
  events.length = 0
  window.addEventListener(NOTES_EXTERNAL_UPDATE, onEvent)
})

afterEach(() => {
  window.removeEventListener(NOTES_EXTERNAL_UPDATE, onEvent)
})

describe('useNotesDeposit（单库 find-or-create 单篇）', () => {
  it('无交接篇：新建「[项目名] 交接」并以沉淀节为正文；开视图 + focus 事件聚焦该篇', async () => {
    const { depositToNotes } = useNotesDeposit()
    const ok = await depositToNotes({ task: '重构登录', status: 'done' })

    expect(ok).toBe(true)
    expect(createMock).toHaveBeenCalledTimes(1)
    const body = createMock.mock.calls[0]![0]
    expect(body.title).toBe(HANDOVER)
    expect(body.content).toMatch(/^## \d{4}-\d{2}-\d{2} 重构登录/)
    expect(saveMock).not.toHaveBeenCalled()
    expect(openNotesViewMock).toHaveBeenCalledTimes(1)
    expect(events).toEqual([{ projectId: '_global', noteId: 'new-id', action: 'deposit', focus: true }])
    expect(messageMock.success).toHaveBeenCalledWith(`notes.deposit.saved:${JSON.stringify({ title: HANDOVER })}`)
  })

  it('已有交接篇：读现文 → 末尾追加一节 → 携 baseUpdatedAt 写回（不新建第二篇）', async () => {
    listMock.mockResolvedValue({
      data: [
        { id: 'free', title: '随手记', updatedAt: NOW, size: 1 },
        { id: 'h1', title: HANDOVER, updatedAt: NOW, size: 10 },
      ],
    })
    getMock.mockResolvedValue({ data: full('h1', HANDOVER, '# 交接说明\n', '2026-11-08T09:00:00Z') })
    const { depositToNotes } = useNotesDeposit()

    expect(await depositToNotes({ task: '迁移错误码', status: 'failed' })).toBe(true)
    expect(createMock).not.toHaveBeenCalled()
    expect(getMock).toHaveBeenCalledWith('h1')
    const [id, body] = saveMock.mock.calls[0]!
    expect(id).toBe('h1')
    expect(body.baseUpdatedAt).toBe('2026-11-08T09:00:00Z')
    expect(body.content.startsWith('# 交接说明\n\n## ')).toBe(true)
    expect(body.content).toContain('迁移错误码')
    expect(events[0]).toMatchObject({ noteId: 'h1', focus: true })
  })

  it('写回 409（期间被人/agent 改过）：重读再追加一次；二次冲突上抛错误不盲目覆盖', async () => {
    listMock.mockResolvedValue({ data: [{ id: 'h1', title: HANDOVER, updatedAt: NOW, size: 10 }] })
    getMock
      .mockResolvedValueOnce({ data: full('h1', HANDOVER, 'v1', '2026-11-08T09:00:00Z') })
      .mockResolvedValueOnce({ data: full('h1', HANDOVER, 'v2 by agent', '2026-11-08T09:30:00Z') })
    const conflict = { response: { status: 409, data: { code: 'notes.conflict' } } }
    saveMock.mockRejectedValueOnce(conflict)
    const { depositToNotes } = useNotesDeposit()

    expect(await depositToNotes({ task: 't', status: 'done' })).toBe(true)
    expect(saveMock).toHaveBeenCalledTimes(2)
    const second = saveMock.mock.calls[1]![1]
    expect(second.baseUpdatedAt).toBe('2026-11-08T09:30:00Z')
    expect(second.content.startsWith('v2 by agent\n\n## ')).toBe(true)

    // 二次冲突：上抛 → 失败 toast，返回 false
    getMock.mockResolvedValue({ data: full('h1', HANDOVER, 'v3', NOW) })
    saveMock.mockReset()
    saveMock.mockRejectedValue(conflict)
    expect(await depositToNotes({ task: 't2', status: 'done' })).toBe(false)
    expect(saveMock).toHaveBeenCalledTimes(2)
    expect(messageMock.error).toHaveBeenCalled()
  })

  it('会话归属：项目会话取其 projectId 的项目名；cwd 匹配注册路径同样归属', async () => {
    sessionsState.sessions = [
      { id: 's1', projectId: 'p2' },
      { id: 's2', path: 'D:/repo/other' },
    ]
    const { depositToNotes } = useNotesDeposit()
    await depositToNotes({ sessionId: 's1', task: 'a', status: 'done' })
    await depositToNotes({ sessionId: 's2', task: 'b', status: 'done' })
    expect(createMock.mock.calls.map(c => c[0].title)).toEqual([
      '[other] notes.deposit.handoverTitle',
      '[other] notes.deposit.handoverTitle',
    ])
  })

  it('无可归属项目：warning 提示且零请求', async () => {
    useProjectStore().currentProjectId = ''
    const { depositToNotes } = useNotesDeposit()
    expect(await depositToNotes({ task: 't', status: 'done' })).toBe(false)
    expect(messageMock.warning).toHaveBeenCalledWith('notes.deposit.noProject')
    expect(listMock).not.toHaveBeenCalled()
    expect(openNotesViewMock).not.toHaveBeenCalled()
  })

  it('在途防重入：并发两次点击只落一节', async () => {
    const { depositToNotes } = useNotesDeposit()
    const [a, b] = await Promise.all([
      depositToNotes({ task: 't', status: 'done' }),
      depositToNotes({ task: 't', status: 'done' }),
    ])
    expect([a, b].filter(Boolean)).toHaveLength(1)
    expect(createMock).toHaveBeenCalledTimes(1)
  })
})
