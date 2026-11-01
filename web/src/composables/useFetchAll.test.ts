import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildFetchAllNotice, useFetchAll } from './useFetchAll'
import type { FetchAllItem } from '../api/domains/git'

// ── mock 边界：本组合式的外部依赖只有 ① naive-ui 注入 message ② i18n（真模板：
// t 直接查 zh-CN 语言包插值，不复制期望文案，locale 改动即测出）③ project/
// notification 两个 store（对象替身，隔离网络）④ fetch-all REST（打桩）──
const { fetchAllMock, fetchProjectsMock, addMock, messageMock, projectsRef } = vi.hoisted(() => ({
  fetchAllMock: vi.fn<() => Promise<unknown>>(),
  fetchProjectsMock: vi.fn<() => Promise<unknown>>(),
  addMock: vi.fn<(n: Record<string, unknown>) => unknown>(),
  messageMock: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
  // 对象替身持有可变项目清单（guard 用例运行中改写长度）
  projectsRef: { items: [{ id: 'p1', name: 'A' }] as unknown[] },
}))

vi.mock('naive-ui', async (importOriginal) => {
  // 部分 mock：其余 naive-ui 导出保持真值（模块图内他人可能引用）
  const actual = await importOriginal<typeof import('naive-ui')>()
  return { ...actual, useMessage: () => messageMock }
})

vi.mock('./useI18n', async () => {
  // 真语言包插值：期望文案不硬编码进测试，改文案即测出
  const zh = (await import('../locales/zh-CN')).default as Record<string, unknown>
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

vi.mock('../api/domains/git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/domains/git')>()
  return { ...actual, remoteApi: { ...actual.remoteApi, fetchAll: fetchAllMock } }
})

vi.mock('../stores/project', () => ({
  useProjectStore: () => ({
    get projects() { return projectsRef.items },
    fetchProjects: fetchProjectsMock,
  }),
}))

vi.mock('../stores/notification', () => ({
  useNotificationStore: () => ({ add: addMock }),
}))

/** 微任务排空：fetchAllProjects 返回后 fetchProjects().then(refresh) 链还要走几拍 */
const flushAsync = () => new Promise(r => setTimeout(r, 0))

beforeEach(() => {
  vi.clearAllMocks()
  projectsRef.items = [{ id: 'p1', name: 'A' }]
  fetchProjectsMock.mockResolvedValue(undefined)
  fetchAllMock.mockResolvedValue({ data: [] })
})

describe('buildFetchAllNotice', () => {
  it('全部成功：success + done 文案素材 + 明细全 ✓ 行', () => {
    const n = buildFetchAllNotice([
      { projectId: 'a', name: 'A', ok: true },
      { projectId: 'b', name: 'B', ok: true },
    ])
    expect(n.allOk).toBe(true)
    expect(n.noticeType).toBe('success')
    expect(n.titleKey).toBe('git.fetchAll.doneTitle')
    expect(n.titleParams).toEqual({ n: 2 })
    expect(n.toastKey).toBe('git.fetchAll.doneToast')
    expect(n.detail).toBe('✓ A\n✓ B')
  })

  it('部分失败：warning + partial 文案素材 + ✗ 行含原因（失败隔离不拖累 ✓ 行）', () => {
    const n = buildFetchAllNotice([
      { projectId: 'a', name: 'A', ok: true },
      { projectId: 'c', name: 'C', ok: false, error: 'could not read Username' },
    ])
    expect(n.allOk).toBe(false)
    expect(n.noticeType).toBe('warning')
    expect(n.titleKey).toBe('git.fetchAll.partialTitle')
    expect(n.titleParams).toEqual({ fail: 1 })
    expect(n.toastKey).toBe('git.fetchAll.partialToast')
    expect(n.toastParams).toEqual({ ok: 1, fail: 1 })
    expect(n.detail).toBe('✓ A\n✗ C：could not read Username')
  })

  it('空清单：视为全部成功（n=0、明细空串）', () => {
    const n = buildFetchAllNotice([])
    expect(n.allOk).toBe(true)
    expect(n.titleParams).toEqual({ n: 0 })
    expect(n.detail).toBe('')
  })
})

describe('useFetchAll', () => {
  it('成功链路：通知中心逐仓明细 + toast 摘要 + 完成后刷新清单与 ahead/behind', async () => {
    const refresh = vi.fn()
    fetchAllMock.mockResolvedValue({ data: [
      { projectId: 'a', name: 'A', ok: true },
      { projectId: 'b', name: 'B', ok: true },
    ] satisfies FetchAllItem[] })
    const { fetchAllProjects } = useFetchAll({ refreshAheadBehind: refresh })

    await fetchAllProjects()
    await flushAsync()

    expect(addMock).toHaveBeenCalledTimes(1)
    const notice = addMock.mock.calls[0]![0] as Record<string, unknown>
    expect(notice.type).toBe('success')
    expect(notice.category).toBe('git')
    expect(notice.title).toBe('全部拉取完成（2 个项目）')
    expect(notice.body).toBe('✓ A\n✓ B')
    expect(messageMock.success).toHaveBeenCalledWith('已全部拉取（2 个项目）')
    expect(fetchProjectsMock).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('部分失败链路：warning 通知（✗ 行含原因）+ 部分失败 toast', async () => {
    fetchAllMock.mockResolvedValue({ data: [
      { projectId: 'a', name: 'A', ok: true },
      { projectId: 'c', name: 'C', ok: false, error: 'Connection refused' },
    ] satisfies FetchAllItem[] })
    const { fetchAllProjects } = useFetchAll()

    await fetchAllProjects()
    await flushAsync()

    const notice = addMock.mock.calls[0]![0] as Record<string, unknown>
    expect(notice.type).toBe('warning')
    expect(notice.title).toBe('全部拉取：1 个项目失败')
    expect(notice.body).toContain('✗ C：Connection refused')
    expect(notice.body).toContain('✓ A')
    expect(messageMock.warning).toHaveBeenCalledWith('部分拉取失败：成功 1 · 失败 1')
    expect(messageMock.success).not.toHaveBeenCalled()
  })

  it('防重入：进行期间二次调用 no-op（批量端点只打一次）', async () => {
    let release!: () => void
    fetchAllMock.mockReturnValue(new Promise((resolve) => { release = () => resolve({ data: [] }) }))
    const { fetchAllProjects } = useFetchAll()

    const first = fetchAllProjects()
    await fetchAllProjects()
    release()
    await first

    expect(fetchAllMock).toHaveBeenCalledTimes(1)
  })

  it('项目清单为空：直接返回，不打批量端点', async () => {
    projectsRef.items = []
    const { fetchAllProjects } = useFetchAll()

    await fetchAllProjects()

    expect(fetchAllMock).not.toHaveBeenCalled()
    expect(addMock).not.toHaveBeenCalled()
  })

  it('整批 HTTP 失败：不冒泡、不发通知，fetchingAll 复位后可再次执行', async () => {
    fetchAllMock.mockRejectedValueOnce(new Error('network down'))
    const { fetchAllProjects } = useFetchAll()

    await expect(fetchAllProjects()).resolves.toBeUndefined()
    expect(addMock).not.toHaveBeenCalled()

    fetchAllMock.mockResolvedValue({ data: [{ projectId: 'a', name: 'A', ok: true }] })
    await fetchAllProjects()
    expect(addMock).toHaveBeenCalledTimes(1)
  })
})
