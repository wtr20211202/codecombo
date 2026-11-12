import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

// naive-ui / vue-i18n 走一站式 mock 工厂（P-20261007-5）：message 记录器 +
// t=key 直通（断言按 key），原手抄 vi.mock 桩已收编
vi.mock('naive-ui', async (importOriginal) =>
  (await import('@/__tests__/mocks/naiveRuntime')).mockNaiveUi(await importOriginal()),
)
vi.mock('vue-i18n', async (importOriginal) =>
  (await import('@/__tests__/mocks/naiveRuntime')).mockVueI18n(await importOriginal()),
)

// 笔记库 API（P-20261108-3 单库化：唯一 /api/notes 族——项目族 notesMultiApi 已退役）
const { listMock, getMock, createMock, saveMock, removeMock, restoreMock, purgeMock, originState } = vi.hoisted(() => ({
  listMock: vi.fn<(trash?: boolean) => Promise<{ data?: Array<{ id: string; title: string; updatedAt: string; size: number; deletedAt?: string; deletedBy?: string }> }>>(),
  getMock: vi.fn<(noteId: string) => Promise<{ data: { id: string; title: string; content: string; createdAt: string; updatedAt: string } }>>(),
  createMock: vi.fn<(body: { title?: string; content?: string }) => Promise<{ data: { id: string; title: string; content: string; createdAt: string; updatedAt: string } }>>(),
  saveMock: vi.fn<(noteId: string, body: { content: string; title?: string; baseUpdatedAt?: string }) => Promise<{ data: { id: string; title: string; content: string; updatedAt: string; size: number } }>>(),
  removeMock: vi.fn<(noteId: string) => Promise<{ message: string }>>(),
  restoreMock: vi.fn<(noteId: string) => Promise<{ message: string }>>(),
  purgeMock: vi.fn<(noteId: string) => Promise<{ message: string }>>(),
  // 本窗 nonce 可控桩（回声抑制用例按 originState.nonce 对位）
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
}))

import {
  useNotesMulti, resetNotesEngines, NOTES_SAVE_DEBOUNCE_MS, notesSaveUrl,
} from '@/composables/useNotesMulti'
import { messageMock, resetNaiveRuntimeMocks } from '@/__tests__/mocks/naiveRuntime'

const messageError = messageMock.error

const NOW = '2026-11-07T10:00:00.000Z'

function meta(id: string, title: string, updatedAt = NOW) {
  return { id, title, updatedAt, size: 10 }
}

function full(id: string, title: string, content: string, updatedAt = NOW) {
  return { id, title, content, createdAt: NOW, updatedAt }
}

/** 单库引擎（P-20261108-3：无作用域参数） */
async function setup(): Promise<ReturnType<typeof useNotesMulti>> {
  const notes = useNotesMulti()
  await notes.loadList()
  return notes
}

beforeEach(() => {
  resetNaiveRuntimeMocks()
  resetNotesEngines() // 单例引擎隔离：每用例全新状态机
  vi.clearAllMocks()
  vi.useFakeTimers()
  setActivePinia(createPinia())
  originState.nonce = 'win-a' // 回声抑制对位锚：每用例重置本窗 nonce
  // 服务端清单序 = updatedAt 降序（store repo List 排序），mock 按服务端契约给序
  listMock.mockResolvedValue({ data: [meta('n2', 'B', '2026-11-07T10:00:00Z'), meta('n1', 'A', '2026-11-07T09:00:00Z')] })
  getMock.mockImplementation((noteId: string) =>
    Promise.resolve({ data: full(noteId, noteId === 'n1' ? 'A' : 'B', `content of ${noteId}`) }))
  saveMock.mockImplementation((noteId: string, body: { content: string }) =>
    Promise.resolve({ data: { id: noteId, title: '', content: body.content, updatedAt: '2026-11-07T11:00:00Z', size: body.content.length } }))
  createMock.mockResolvedValue({ data: full('n-new', '', '') })
  removeMock.mockResolvedValue({ message: 'ok' })
  restoreMock.mockResolvedValue({ message: 'ok' })
  purgeMock.mockResolvedValue({ message: 'ok' })
})

describe('useNotesMulti', () => {
  it('loadList 拉清单并保底选中最新一篇（updatedAt 降序服务端序）', async () => {
    const notes = await setup()
    expect(notes.notes.value.map(n => n.id)).toEqual(['n2', 'n1'])
    expect(notes.activeId.value).toBe('n2')
    expect(notes.activeContent.value).toBe('content of n2')
    expect(listMock).toHaveBeenCalledWith()
  })

  it('edit 走 800ms 防抖保存且恒带 baseUpdatedAt（覆盖保护三件套①）', async () => {
    const notes = await setup()
    notes.edit('n2', 'draft v2')
    expect(notes.saveStates['n2']).toBe('dirty')
    await vi.advanceTimersByTimeAsync(NOTES_SAVE_DEBOUNCE_MS - 1)
    expect(saveMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await flushPromises()
    expect(saveMock).toHaveBeenCalledWith('n2', {
      content: 'draft v2',
      baseUpdatedAt: NOW, // 载入时刻的服务端版本——409 防线
    })
    expect(notes.saveStates['n2']).toBe('idle')
  })

  it('blur/flushAll 立即落盘全部挂起篇（防抖窗诚实丢失上界的补偿路径）', async () => {
    const notes = await setup()
    notes.edit('n2', 'blur save')
    await notes.flushSave('n2')
    expect(saveMock).toHaveBeenCalledTimes(1)
    notes.edit('n1', 'a')
    notes.edit('n2', 'b')
    await notes.flushAll()
    await flushPromises()
    expect(saveMock).toHaveBeenCalledTimes(3)
  })

  it('409 notes.conflict 挂起冲突态，不静默覆盖；三动作各自裁决', async () => {
    const notes = await setup()
    notes.edit('n2', 'my local edit')
    saveMock.mockRejectedValueOnce({
      response: {
        status: 409,
        data: { code: 'notes.conflict', currentContent: 'server version', currentUpdatedAt: '2026-11-07T10:30:00Z' },
      },
    })
    await vi.advanceTimersByTimeAsync(NOTES_SAVE_DEBOUNCE_MS)
    await flushPromises()
    expect(notes.conflict.value).toEqual({
      noteId: 'n2',
      currentContent: 'server version',
      currentUpdatedAt: '2026-11-07T10:30:00Z',
    })
    expect(notes.activeContent.value).toBe('my local edit') // 本地编辑不被静默替换

    // ②载入服务端版本
    notes.resolveConflictLoadServer()
    expect(notes.activeContent.value).toBe('server version')
    expect(notes.conflict.value).toBeNull()
  })

  it('409 AppError 真实形态（api/http 拦截器重铸 status/data 平铺）同样挂起冲突态——e2e 揭出的既有缺陷回归锚', async () => {
    const notes = await setup()
    notes.edit('n2', 'my local edit')
    // 真实链路：拦截器 reject AppError（status 平铺、data=响应体载荷），非 axios 原形
    saveMock.mockRejectedValueOnce({
      status: 409,
      data: { code: 'notes.conflict', currentContent: 'server version', currentUpdatedAt: '2026-11-07T10:30:00Z' },
    })
    await vi.advanceTimersByTimeAsync(NOTES_SAVE_DEBOUNCE_MS)
    await flushPromises()
    expect(notes.conflict.value).toEqual({
      noteId: 'n2',
      currentContent: 'server version',
      currentUpdatedAt: '2026-11-07T10:30:00Z',
    })
    expect(notes.activeContent.value).toBe('my local edit')
    notes.resolveConflictLoadServer()
    expect(notes.activeContent.value).toBe('server version')
    expect(notes.conflict.value).toBeNull()
  })

  it('冲突动作①用我的覆盖：丢 baseUpdatedAt 直写（显式意图）', async () => {
    const notes = await setup()
    saveMock.mockRejectedValueOnce({
      response: { status: 409, data: { code: 'notes.conflict', currentContent: 'srv', currentUpdatedAt: NOW } },
    })
    notes.edit('n2', 'mine')
    await vi.advanceTimersByTimeAsync(NOTES_SAVE_DEBOUNCE_MS)
    await flushPromises()
    expect(notes.conflict.value).not.toBeNull()
    saveMock.mockResolvedValueOnce({ data: { id: 'n2', title: '', content: 'mine', updatedAt: '2026-11-07T12:00:00Z', size: 4 } })
    await notes.resolveConflictOverwrite()
    expect(saveMock).toHaveBeenLastCalledWith('n2', { content: 'mine' }) // 无 baseUpdatedAt
    expect(notes.conflict.value).toBeNull()
  })

  it('冲突动作③另存为新篇：本地内容落新篇、原篇回落服务端版本', async () => {
    const notes = await setup()
    saveMock.mockRejectedValueOnce({
      response: { status: 409, data: { code: 'notes.conflict', currentContent: 'srv', currentUpdatedAt: NOW } },
    })
    notes.edit('n2', 'mine')
    await vi.advanceTimersByTimeAsync(NOTES_SAVE_DEBOUNCE_MS)
    await flushPromises()
    await notes.resolveConflictSaveAsNew()
    await flushPromises()
    // 新篇（n-new）收到本地内容（防抖立即触发的保存）
    expect(saveMock).toHaveBeenCalledWith('n-new', expect.objectContaining({ content: 'mine' }))
    // 原篇回落服务端内容
    expect(notes.contents['n2']).toBe('srv')
    expect(notes.conflict.value).toBeNull()
  })

  it('createNote 新建即选中并进清单首位', async () => {
    const notes = await setup()
    const created = await notes.createNote('灵感')
    expect(created?.id).toBe('n-new')
    expect(createMock).toHaveBeenCalledWith({ title: '灵感' })
    expect(notes.activeId.value).toBe('n-new')
    expect(notes.notes.value[0]?.id).toBe('n-new')
  })

  it('空库占位默认篇：清单空时合成 default 占位（零 GET 副作用），首写经 default-upsert 落真身', async () => {
    listMock.mockResolvedValue({ data: [] })
    const getBefore = getMock.mock.calls.length
    const notes = await setup()
    // 占位合成：activeId=default、编辑面空内容（无单篇 GET——占位无服务端实体）
    expect(notes.notes.value.map(n => n.id)).toEqual(['default'])
    expect(notes.activeId.value).toBe('default')
    expect(notes.isPlaceholder('default')).toBe(true)
    expect(getMock.mock.calls.length).toBe(getBefore)
    expect(notes.activeContent.value).toBe('')

    // 首写：PUT /notes/default（无 baseUpdatedAt）→ 落真身并摘占位标记
    saveMock.mockResolvedValue({ data: { id: 'default', title: '', content: 'scratch', updatedAt: '2026-11-07T12:00:00Z', size: 7 } })
    notes.edit('default', 'scratch')
    await vi.advanceTimersByTimeAsync(NOTES_SAVE_DEBOUNCE_MS)
    await flushPromises()
    expect(saveMock).toHaveBeenCalledWith('default', { content: 'scratch', baseUpdatedAt: undefined })
    expect(notes.saveStates['default']).toBe('idle')
    expect(notes.isPlaceholder('default')).toBe(false)

    // 占位已落真身：trashNote 走服务端软删（不再走本地弃稿分支）
    await notes.trashNote('default')
    expect(removeMock).toHaveBeenCalledWith('default')
  })

  it('占位篇弃稿（未落盘 trash）：本地清稿并重合成新占位，零 API 调用', async () => {
    listMock.mockResolvedValue({ data: [] })
    const notes = await setup()
    notes.edit('default', 'draft')
    const removeBefore = removeMock.mock.calls.length
    await notes.trashNote('default')
    expect(removeMock.mock.calls.length).toBe(removeBefore) // 未落盘不调服务端
    expect(notes.notes.value.map(n => n.id)).toEqual(['default']) // 重合成
    expect(notes.contents['default']).toBe('') // 草稿已弃
  })

  it('trashNote 软删后清单移除、当前篇悬空时切到相邻篇；restore/purge 走各自端点', async () => {
    const notes = await setup()
    listMock.mockResolvedValue({ data: [] }) // 恢复后清单重拉走空态
    await notes.trashNote('n2')
    expect(removeMock).toHaveBeenCalledWith('n2')
    expect(notes.notes.value.map(n => n.id)).toEqual(['n1'])
    expect(notes.activeId.value).toBe('n1')

    await notes.restoreNote('n2')
    expect(restoreMock).toHaveBeenCalledWith('n2')

    await notes.purgeNote('n2')
    expect(purgeMock).toHaveBeenCalledWith('n2')
  })

  it('onExternalUpdate：无挂起编辑重读当前篇；有挂起编辑只刷清单不动内容', async () => {
    const notes = await setup()
    // 事件监听在面板层（onMounted 接线），composable 层直测入口函数
    const getBefore = getMock.mock.calls.length
    await notes.onExternalUpdate({ projectId: '_global', noteId: 'n2' })
    expect(getMock.mock.calls.length).toBeGreaterThan(getBefore)

    // 有挂起编辑：内容让位人的输入（宁欠勿覆盖，冲突由 baseUpdatedAt 兜底）
    notes.edit('n1', 'typing...')
    const getCalls = getMock.mock.calls.length
    await notes.onExternalUpdate({ projectId: '_global' })
    expect(getMock.mock.calls.length).toBe(getCalls) // 无单篇重读
    expect(notes.contents['n1']).toBe('typing...')
  })

  it('onExternalUpdate 只认笔记库作用域键：旧形态带项目 id 的事件忽略（单库化无项目库可对位）', async () => {
    const notes = await setup()
    const listCalls = listMock.mock.calls.length
    const getCalls = getMock.mock.calls.length
    await notes.onExternalUpdate({ projectId: 'p1' })
    await notes.onExternalUpdate(undefined)
    expect(listMock.mock.calls.length).toBe(listCalls)
    expect(getMock.mock.calls.length).toBe(getCalls)
  })

  it('回声抑制（P-20261111-4 S1）：origin=本窗 nonce 的服务端广播整体跳过——不重拉清单不重读（本窗自动保存回声零扰动）', async () => {
    const notes = await setup()
    const listCalls = listMock.mock.calls.length
    const getBefore = getMock.mock.calls.length
    await notes.onExternalUpdate({ projectId: '_global', noteId: 'n2', action: 'saved', origin: 'win-a' })
    expect(listMock.mock.calls.length).toBe(listCalls) // loadList 全量重拉不发生（侧栏不闪动）
    expect(getMock.mock.calls.length).toBe(getBefore) // 单篇重读不发生（textarea 换值=光标/undo 栈重置）
    expect(notes.activeContent.value).toBe('content of n2') // 编辑面原地不动
  })

  it('回声抑制只认本窗：异窗/缺 origin 照常处理（同源双开仍互见；旧服务端事件向后兼容）', async () => {
    const notes = await setup()
    const getBefore = getMock.mock.calls.length
    await notes.onExternalUpdate({ projectId: '_global', noteId: 'n2', action: 'saved', origin: 'other-window' })
    expect(getMock.mock.calls.length).toBeGreaterThan(getBefore) // 异窗 nonce = 真外部更新
    await notes.onExternalUpdate({ projectId: '_global', noteId: 'n2', action: 'saved' }) // 无 origin（旧服务端）
    expect(getMock.mock.calls.length).toBeGreaterThan(getBefore + 1)
  })

  it('无扰换装·同内容（P-20261111-4 S2）：外部写同值 → 不触碰 contents（返回无换装现场），bases 保鲜到新 updatedAt 防下轮保存误 409', async () => {
    const notes = await setup()
    const before = notes.activeContent.value
    getMock.mockImplementationOnce((noteId: string) =>
      Promise.resolve({ data: { ...full(noteId, 'B', before), updatedAt: '2026-11-07T12:00:00Z' } }))
    const swap = await notes.onExternalUpdate({ projectId: '_global', noteId: 'n2', action: 'saved' })
    expect(swap).toBeNull() // 无换装现场（呈现层零介入）
    expect(notes.activeContent.value).toBe(before) // 编辑面原地不动
    expect(notes.bases['n2']).toBe('2026-11-07T12:00:00Z') // 基准保鲜（外部写推进了服务端 updatedAt）
    expect(notes.saveStates['n2']).toBe('idle')
  })

  it('无扰换装·异内容（P-20261111-4 S2）：原子换值并返回换装现场（noteId/oldContent/newContent）', async () => {
    const notes = await setup()
    getMock.mockImplementationOnce((noteId: string) =>
      Promise.resolve({ data: full(noteId, 'B', 'content of n2 + 外部追加', '2026-11-07T12:00:00Z') }))
    const swap = await notes.onExternalUpdate({ projectId: '_global', noteId: 'n2', action: 'saved' })
    expect(swap).toEqual({ noteId: 'n2', oldContent: 'content of n2', newContent: 'content of n2 + 外部追加' })
    expect(notes.contents['n2']).toBe('content of n2 + 外部追加') // 已换装
    expect(notes.bases['n2']).toBe('2026-11-07T12:00:00Z')
    expect(notes.saveStates['n2']).toBe('idle') // 换装不置脏（无挂起编辑语义不变）
  })

  it('无扰换装守卫：取数期间用户输入 → 不换装（人的输入优先，草稿与 dirty 态保留）', async () => {
    const notes = await setup()
    const getBefore = getMock.mock.calls.length
    listMock.mockImplementationOnce(() =>
      new Promise(res => setTimeout(() => res({ data: [meta('n2', 'B', '2026-11-07T10:00:00Z'), meta('n1', 'A', '2026-11-07T09:00:00Z')] }), 500)))
    const pending = notes.onExternalUpdate({ projectId: '_global', noteId: 'n2' })
    notes.edit('n2', '取数期间的输入') // loadList 在途时用户开打
    await vi.advanceTimersByTimeAsync(500)
    const swap = await pending
    expect(swap).toBeNull()
    expect(getMock.mock.calls.length).toBe(getBefore) // 非 idle 守卫在 GET 前拦下（零读放大）
    expect(notes.contents['n2']).toBe('取数期间的输入')
    expect(notes.saveStates['n2']).toBe('dirty')
  })

  it('无扰换装守卫：saving 在途 → 不换装（保存响应与换装不打架，等收口后下一轮事件）', async () => {
    const notes = await setup()
    let releaseSave: (v: { data: { id: string; title: string; content: string; updatedAt: string; size: number } }) => void = () => {}
    saveMock.mockImplementationOnce(() =>
      new Promise(res => { releaseSave = res }))
    notes.edit('n2', 'saving 期间的稿')
    const saving = vi.advanceTimersByTimeAsync(NOTES_SAVE_DEBOUNCE_MS)
    await vi.advanceTimersByTimeAsync(1) // 防抖到期发出 PUT（在途）
    expect(notes.saveStates['n2']).toBe('saving')
    const swap = await notes.onExternalUpdate({ projectId: '_global', noteId: 'n2' })
    expect(swap).toBeNull() // 非 idle：不换装
    expect(notes.contents['n2']).toBe('saving 期间的稿')
    releaseSave({ data: { id: 'n2', title: '', content: 'saving 期间的稿', updatedAt: '2026-11-07T12:00:00Z', size: 9 } })
    await saving
    await flushPromises()
    expect(notes.saveStates['n2']).toBe('idle')
  })

  it('清单 diff 守卫（P-20261111-4 S2）：外部更新走 quiet 后台刷新——loading 不翻转（面板 body 不卸载）、未变更条目身份复用', async () => {
    const notes = await setup()
    const firstRow = notes.notes.value[0]
    // 清单在途期间 loading 恒 false（loading 态会把 body 换成 NSpin——编辑器/侧栏全量重挂）
    listMock.mockImplementationOnce(() =>
      new Promise(res => setTimeout(() => res({ data: [meta('n2', 'B', '2026-11-07T10:00:00Z'), meta('n1', 'A', '2026-11-07T09:00:00Z')] }), 500)))
    const pending = notes.onExternalUpdate({ projectId: '_global' })
    expect(notes.loading.value).toBe(false)
    await vi.advanceTimersByTimeAsync(500)
    await pending
    expect(notes.loading.value).toBe(false)
    expect(notes.notes.value[0]).toBe(firstRow) // 未变更条目对象身份复用（keyed 行零 DOM 写入）
  })

  it('清单 loud 刷新回归：显式 loadList 仍翻 loading（首开/迁移等可见动作语义不变）', async () => {
    const notes = await setup()
    listMock.mockImplementationOnce(() =>
      new Promise(res => setTimeout(() => res({ data: [meta('n2', 'B', '2026-11-07T10:00:00Z'), meta('n1', 'A', '2026-11-07T09:00:00Z')] }), 500)))
    const pending = notes.loadList()
    expect(notes.loading.value).toBe(true) // loud：spinner 生效（原语义）
    await vi.advanceTimersByTimeAsync(500)
    await pending
    expect(notes.loading.value).toBe(false)
  })

  it('无扰换装守卫：占位篇（未落盘草稿）无服务端实体 → 不换装零 GET', async () => {
    listMock.mockResolvedValue({ data: [] })
    const notes = await setup()
    expect(notes.isPlaceholder('default')).toBe(true)
    const getBefore = getMock.mock.calls.length
    const swap = await notes.onExternalUpdate({ projectId: '_global', noteId: 'default' })
    expect(swap).toBeNull()
    expect(getMock.mock.calls.length).toBe(getBefore)
    expect(notes.activeContent.value).toBe('')
  })

  it('无扰换装·focus 路径：聚焦已缓存篇且服务端已改 → 换装现场返回（沉淀追加节可见 + 可锚定）', async () => {
    const notes = await setup()
    await notes.select('n1') // 缓存旧内容
    await notes.select('n2')
    getMock.mockImplementation((noteId: string) =>
      Promise.resolve({ data: full(noteId, 'A', noteId === 'n1' ? 'old\n\n## 新沉淀节' : `content of ${noteId}`, '2026-11-07T12:00:00Z') }))
    const swap = await notes.onExternalUpdate({ projectId: '_global', noteId: 'n1', focus: true })
    expect(swap).toEqual({ noteId: 'n1', oldContent: 'content of n1', newContent: 'old\n\n## 新沉淀节' })
    expect(notes.activeId.value).toBe('n1')
    expect(notes.activeContent.value).toContain('新沉淀节')
  })

  it('createNote 成功就地摘除空库占位 tab（S1 回声抑制后占位收敛不再依赖 created 回声 loadList）', async () => {
    listMock.mockResolvedValue({ data: [] }) // 空库 → 合成 default 占位
    const notes = await setup()
    expect(notes.isPlaceholder('default')).toBe(true)
    await notes.createNote('新篇')
    expect(notes.notes.value.map(n => n.id)).toEqual(['n-new']) // 占位 tab 已摘除
    expect(notes.isPlaceholder('default')).toBe(false)
    expect(notes.activeId.value).toBe('n-new')
  })

  it('onExternalUpdate focus（沉淀写回）：重拉后聚焦该篇并丢缓存重读——刚追加的节可见', async () => {
    const notes = await setup()
    expect(notes.activeId.value).toBe('n2')
    await notes.select('n1') // n1 内容已缓存（旧版本）
    await notes.select('n2')
    getMock.mockImplementation((noteId: string) =>
      Promise.resolve({ data: full(noteId, 'A', noteId === 'n1' ? 'old\n\n## 2026-11-08 沉淀节' : `content of ${noteId}`) }))
    await notes.onExternalUpdate({ projectId: '_global', noteId: 'n1', action: 'deposit', focus: true })
    expect(notes.activeId.value).toBe('n1')
    expect(notes.activeContent.value).toContain('沉淀节')
  })

  it('focus 遇该篇有挂起编辑：只聚焦不覆盖（人的输入优先，保存时 409 兜底）', async () => {
    const notes = await setup()
    notes.edit('n1', 'my typing')
    await notes.onExternalUpdate({ projectId: '_global', noteId: 'n1', focus: true })
    expect(notes.activeId.value).toBe('n1')
    expect(notes.contents['n1']).toBe('my typing')
  })

  it('保存失败上 toast（按 key 断言）；409 之外的网络错误落 error 态', async () => {
    const notes = await setup()
    saveMock.mockRejectedValueOnce(new Error('boom'))
    notes.edit('n2', 'x')
    await vi.advanceTimersByTimeAsync(NOTES_SAVE_DEBOUNCE_MS)
    await flushPromises()
    expect(notes.saveStates['n2']).toBe('error')
    expect(messageError).toHaveBeenCalled()
  })

  it('notesSaveUrl 单库端点形态（beforeunload keepalive 直发）', () => {
    expect(notesSaveUrl('abc')).toBe('/api/notes/abc')
  })
})
