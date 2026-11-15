import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

// 笔记活动篇持久化（P-20261112-6-S2 写作现场）：loadList 保底选篇两段式
// （持久化 notesView.activeId 仍在清单 → 选中它；否则回落 updatedAt 首篇，
// 旧存档无键 = '' 天然落第二段零迁移）+ select()/createNote() 成功即写
// （占位篇 DEFAULT_NOTE_ID 不记）+ 读回按实例 memo + 等待窗口竞态守卫
// （人的输入优先）。引擎行为面在 useNotesMulti.test.ts 既有覆盖，本文件
// 只钉 S2 持久化键族（需要 uiStateApi 桩——写端断言与读回数据源）。

vi.mock('naive-ui', async (importOriginal) =>
  (await import('@/__tests__/mocks/naiveRuntime')).mockNaiveUi(await importOriginal()),
)
vi.mock('vue-i18n', async (importOriginal) =>
  (await import('@/__tests__/mocks/naiveRuntime')).mockVueI18n(await importOriginal()),
)

const { listMock, getMock, createMock, saveMock, removeMock, restoreMock, purgeMock, uiStateGet, uiStatePatch, originState } = vi.hoisted(() => ({
  listMock: vi.fn<(trash?: boolean) => Promise<{ data?: Array<{ id: string; title: string; updatedAt: string; size: number }> }>>(),
  getMock: vi.fn<(noteId: string) => Promise<{ data: { id: string; title: string; content: string; createdAt: string; updatedAt: string } }>>(),
  createMock: vi.fn<(body: { title?: string; content?: string }) => Promise<{ data: { id: string; title: string; content: string; createdAt: string; updatedAt: string } }>>(),
  saveMock: vi.fn<(noteId: string, body: { content: string; title?: string; baseUpdatedAt?: string }) => Promise<{ data: { id: string; title: string; content: string; updatedAt: string; size: number } }>>(),
  removeMock: vi.fn<(noteId: string) => Promise<{ message: string }>>(),
  restoreMock: vi.fn<(noteId: string) => Promise<{ message: string }>>(),
  purgeMock: vi.fn<(noteId: string) => Promise<{ message: string }>>(),
  uiStateGet: vi.fn<() => Promise<{ data: Record<string, Record<string, unknown>> }>>(),
  uiStatePatch: vi.fn<(body: Record<string, unknown>) => Promise<unknown>>(),
  originState: { nonce: 'win-a' },
}))

vi.mock('@/api/client', () => ({
  DEFAULT_NOTE_ID: 'default',
  GLOBAL_NOTES_SCOPE: '_global',
  notesGlobalApi: {
    list: listMock,
    get: getMock,
    create: createMock,
    save: saveMock,
    remove: removeMock,
    restore: restoreMock,
    purge: purgeMock,
  },
  notesSaveUrl: (noteId: string) => `/api/notes/${noteId}`,
  notesOriginNonce: () => originState.nonce,
  resetNotesOriginNonceForTest: () => { originState.nonce = 'win-a' },
  uiStateApi: { get: uiStateGet, update: vi.fn(), patch: uiStatePatch },
  setInstanceContext: vi.fn(),
}))

import { useNotesMulti, resetNotesEngines } from '@/composables/useNotesMulti'
import { useInstanceStore } from '@/stores/instance'
import { resetNaiveRuntimeMocks } from '@/__tests__/mocks/naiveRuntime'

const NOW = '2026-11-07T10:00:00.000Z'

function meta(id: string, title: string, updatedAt = NOW) {
  return { id, title, updatedAt, size: 10 }
}

function full(id: string, title: string, content: string, updatedAt = NOW) {
  return { id, title, content, createdAt: NOW, updatedAt }
}

/** 服务端清单序 = updatedAt 降序（store repo List 排序）：n2 新、n1 旧——
 *  无持久化时回落 n2（首篇），持久化 n1 命中则选 n1（两段式可判别） */
function seedTwoNotes(): void {
  listMock.mockResolvedValue({ data: [meta('n2', 'B', '2026-11-07T10:00:00Z'), meta('n1', 'A', '2026-11-07T09:00:00Z')] })
  getMock.mockImplementation((noteId: string) =>
    Promise.resolve({ data: full(noteId, noteId === 'n1' ? 'A' : 'B', `content of ${noteId}`) }))
}

function uiStatePatchBodies(): Array<Record<string, Record<string, unknown>>> {
  return uiStatePatch.mock.calls.map(([body]) => body as Record<string, Record<string, unknown>>)
}

function activeIdPatches(): Array<Record<string, unknown> | undefined> {
  return uiStatePatchBodies()
    .map((body) => (body['local'] as Record<string, unknown> | undefined)?.['notesView'])
    .filter((ns): ns is Record<string, unknown> => !!ns && 'activeId' in ns)
}

async function setup(): Promise<ReturnType<typeof useNotesMulti>> {
  const notes = useNotesMulti()
  await notes.loadList()
  return notes
}

beforeEach(() => {
  resetNaiveRuntimeMocks()
  resetNotesEngines() // 单例引擎隔离：每用例全新状态机（恢复 memo 随引擎重建）
  vi.clearAllMocks()
  setActivePinia(createPinia())
  originState.nonce = 'win-a'
  uiStateGet.mockResolvedValue({ data: {} }) // 缺省：旧存档无键 = ''
  uiStatePatch.mockResolvedValue({})
  removeMock.mockResolvedValue({ message: 'ok' })
  restoreMock.mockResolvedValue({ message: 'ok' })
  purgeMock.mockResolvedValue({ message: 'ok' })
  createMock.mockResolvedValue({ data: full('n-new', '', '') })
  saveMock.mockImplementation((noteId: string, body: { content: string }) =>
    Promise.resolve({ data: { id: noteId, title: '', content: body.content, updatedAt: '2026-11-07T11:00:00Z', size: body.content.length } }))
  seedTwoNotes()
})

describe('loadList 保底选篇两段式（P-20261112-6-S2）', () => {
  it('①持久化活动篇仍在清单 → 选中它（非 updatedAt 首篇——写作现场刷新后原篇落位）', async () => {
    uiStateGet.mockResolvedValue({ data: { local: { notesView: { activeId: 'n1' } } } })
    const notes = await setup()
    expect(notes.activeId.value).toBe('n1') // 旧篇 n1 命中恢复，不是首篇 n2
    expect(notes.activeContent.value).toBe('content of n1') // 恢复即加载内容（编辑面就绪）
  })

  it('②持久化 id 不在清单（篇已被删/异实例）→ 回落 updatedAt 首篇（原规则）', async () => {
    uiStateGet.mockResolvedValue({ data: { local: { notesView: { activeId: 'n-gone' } } } })
    const notes = await setup()
    expect(notes.activeId.value).toBe('n2')
    expect(notes.activeContent.value).toBe('content of n2')
  })

  it('旧存档无键 = \'\' → 回落 updatedAt 首篇（向后兼容零迁移，原行为不变）', async () => {
    const notes = await setup()
    expect(notes.activeId.value).toBe('n2')
  })

  it('读回按实例 memo：同实例分支再命中零重复请求；实例切换后重读防跨实例串选', async () => {
    uiStateGet.mockResolvedValue({ data: { local: { notesView: { activeId: 'n1' } } } })
    const notes = await setup()
    expect(notes.activeId.value).toBe('n1')
    const readsAfterBoot = uiStateGet.mock.calls.length

    // 同实例：当前篇被外部移除（分支再命中）→ memo 命中，ui-state 不再拉；
    // 恢复值 n1 不在新清单 → 落第二段首篇
    listMock.mockResolvedValue({ data: [meta('n3', 'C', '2026-11-07T09:30:00Z')] })
    getMock.mockImplementation((noteId: string) =>
      Promise.resolve({ data: full(noteId, 'C', `content of ${noteId}`) }))
    await notes.loadList()
    expect(uiStateGet.mock.calls.length).toBe(readsAfterBoot) // memo：零重复读
    expect(notes.activeId.value).toBe('n3')

    // 实例切换（uiState 按实例分存）→ 分支命中时重读：换清单让当前篇悬空
    //（activeId='n3' 不在新清单）触发分支，inst-b 存档无键 → 回落新清单首篇
    listMock.mockResolvedValue({ data: [meta('n4', 'D', '2026-11-07T09:15:00Z')] })
    getMock.mockImplementation((noteId: string) =>
      Promise.resolve({ data: full(noteId, 'D', `content of ${noteId}`) }))
    useInstanceStore().currentInstanceId = 'inst-b'
    await notes.loadList()
    expect(uiStateGet.mock.calls.length).toBe(readsAfterBoot + 1) // 换实例重读
    expect(notes.activeId.value).toBe('n4') // inst-b 存档无键 → 回落首篇
  })

  it('等待读回窗口内用户已点选在册篇：人的输入优先，恢复让位（本窗竞态守卫）', async () => {
    let resolveGet!: (v: { data: Record<string, Record<string, unknown>> }) => void
    uiStateGet.mockImplementation(
      () => new Promise((r) => { resolveGet = r }) as Awaited<ReturnType<typeof uiStateGet>>,
    )
    const notes = useNotesMulti()
    const pending = notes.loadList()
    await flushPromises() // 清单已到、恢复读回挂起（分支内 await 窗口）
    await notes.select('n1') // 窗口内用户点选（写端照发，恢复值陈旧）

    resolveGet({ data: { local: { notesView: { activeId: 'n2' } } } })
    await pending
    expect(notes.activeId.value).toBe('n1') // 用户选择胜出，不被恢复值回卷
  })
})

describe('select()/createNote() 成功即写（P-20261112-6-S2）', () => {
  it('select 选定即 PATCH notesView.activeId；基底 open 子键经注册表回填不丢', async () => {
    // 基底含 S1 开态：写端只带 activeId，backfillNestedSubfields 从基底回填
    // open——命名空间级浅合并（服务端整键替换）不丢开态
    uiStateGet.mockResolvedValue({ data: { local: { notesView: { open: true, activeId: 'n2' } } } })
    const notes = await setup()
    expect(notes.activeId.value).toBe('n2')
    await notes.select('n1')
    await flushPromises() // 写端 void 发射，flush 后断言
    expect(activeIdPatches()).toEqual([{ open: true, activeId: 'n1' }])
  })

  it('createNote 成功即 PATCH（真身有服务端实体）；占位篇合成零写、DEFAULT_NOTE_ID 不记', async () => {
    listMock.mockResolvedValue({ data: [] }) // 空库 → 合成 default 占位
    const notes = await setup()
    expect(notes.isPlaceholder('default')).toBe(true)
    expect(activeIdPatches()).toEqual([]) // 占位合成不落盘（无服务端实体）

    await notes.createNote('新篇')
    await flushPromises()
    // 真身 n-new 记活动篇；全窗零 'default' 出账（占位篇不记的钉）
    expect(activeIdPatches()).toEqual([{ activeId: 'n-new' }])
    expect(notes.activeId.value).toBe('n-new')
  })

  it('loadList 两段式选篇本身不写（恢复值已在存档，零回写噪声）', async () => {
    uiStateGet.mockResolvedValue({ data: { local: { notesView: { activeId: 'n1' } } } })
    await setup()
    expect(activeIdPatches()).toEqual([])
  })
})
