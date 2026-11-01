import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useMorningBrief } from './useMorningBrief'
import type { MorningBrief } from '../api/domains/system'

// ── mock 边界：① naive-ui 注入 message ② i18n（真 zh 语言包插值，断言按 key
// 不按文案——locale parity 测试守键值同构）③ morning-brief / push 两个 REST
// 打桩 ④ safeStorage 真通道跑在 jsdom localStorage 上（当日已阅读写全链真跑）──
const { briefGetMock, pushMock, messageMock } = vi.hoisted(() => ({
  briefGetMock: vi.fn<() => Promise<unknown>>(),
  pushMock: vi.fn<() => Promise<unknown>>(),
  messageMock: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}))

vi.mock('naive-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('naive-ui')>()
  return { ...actual, useMessage: () => messageMock }
})

vi.mock('./useI18n', async () => {
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

vi.mock('../api/domains/system', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/domains/system')>()
  return { ...actual, morningBriefApi: { ...actual.morningBriefApi, get: briefGetMock } }
})

vi.mock('../api/domains/git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/domains/git')>()
  return { ...actual, remoteApi: { ...actual.remoteApi, push: pushMock } }
})

const briefOf = (patch: Partial<MorningBrief> = {}): MorningBrief => ({
  date: '2026-10-15',
  unpushed: { count: 2, projects: [{ id: 'p1', name: 'A', ahead: 2 }] },
  runningAgents: { count: 1 },
  unread: { count: 3, notifications: 2, approvals: 1 },
  ...patch,
})

const flushAsync = () => new Promise(r => setTimeout(r, 0))

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  briefGetMock.mockResolvedValue({ data: briefOf() })
  pushMock.mockResolvedValue({ data: '' })
})

describe('useMorningBrief', () => {
  it('load：三源非零全显（showCard=true）；当日已阅清单一并读入', async () => {
    const b = useMorningBrief()
    await b.load()
    expect(b.brief.value?.date).toBe('2026-10-15')
    expect(b.showCard.value).toBe(true)
    expect(b.visibleItems.value).toEqual(['unpushed', 'runningAgents', 'unread'])
  })

  it('拉取失败（源降级）：brief 保持 null、showCard=false——检查单缺席零打扰', async () => {
    briefGetMock.mockRejectedValue(new Error('network'))
    const b = useMorningBrief()
    await b.load()
    expect(b.brief.value).toBeNull()
    expect(b.showCard.value).toBe(false)
  })

  it('全零：诚实值零打扰', async () => {
    briefGetMock.mockResolvedValue({
      data: briefOf({
        unpushed: { count: 0, projects: [] },
        runningAgents: { count: 0 },
        unread: { count: 0, notifications: 0, approvals: 0 },
      }),
    })
    const b = useMorningBrief()
    await b.load()
    expect(b.showCard.value).toBe(false)
  })

  it('dismissToday：整卡当日已阅落 localStorage，showCard 翻 false', async () => {
    const b = useMorningBrief()
    await b.load()
    b.dismissToday()
    expect(b.showCard.value).toBe(false)
    const today = new Date()
    const key = `sc.morningBrief.${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    expect(JSON.parse(localStorage.getItem(key) || '[]')).toEqual(['all'])
    // 重进（新实例重读存储）依旧不显示——当日已阅跨挂载生效
    const b2 = useMorningBrief()
    await b2.load()
    expect(b2.showCard.value).toBe(false)
  })

  it('dismissItemToday：只隐该项，其余照常提醒', async () => {
    const b = useMorningBrief()
    await b.load()
    b.dismissItemToday('unpushed')
    expect(b.visibleItems.value).toEqual(['runningAgents', 'unread'])
    expect(b.showCard.value).toBe(true)
  })

  it('pushProject 成功：toast + 重拉晨报（推送后该行 ahead 归零消失）', async () => {
    const b = useMorningBrief()
    await b.load()
    pushMock.mockImplementation(async () => {
      briefGetMock.mockResolvedValue({ data: briefOf({ unpushed: { count: 0, projects: [] } }) })
      return { data: '' }
    })
    await b.pushProject({ id: 'p1', name: 'A', ahead: 2 })
    expect(pushMock).toHaveBeenCalledWith('p1')
    expect(messageMock.success).toHaveBeenCalledTimes(1)
    expect(b.brief.value?.unpushed?.count).toBe(0)
    expect(b.visibleItems.value).toEqual(['runningAgents', 'unread'])
  })

  it('pushProject 失败：静默（拦截器已提示）、不弹成功、进行态复位', async () => {
    const b = useMorningBrief()
    await b.load()
    pushMock.mockRejectedValue(new Error('non-fast-forward'))
    await b.pushProject({ id: 'p1', name: 'A', ahead: 2 })
    expect(messageMock.success).not.toHaveBeenCalled()
    expect(b.pushing.value.p1).toBe(false)
    expect(b.brief.value?.unpushed?.count).toBe(2)
  })

  it('pushProject 防重入：进行中再点不重复发起', async () => {
    const b = useMorningBrief()
    await b.load()
    let release!: () => void
    pushMock.mockReturnValue(new Promise<void>(resolve => { release = resolve }))
    const first = b.pushProject({ id: 'p1', name: 'A', ahead: 2 })
    await flushAsync()
    expect(b.pushing.value.p1).toBe(true)
    await b.pushProject({ id: 'p1', name: 'A', ahead: 2 })
    expect(pushMock).toHaveBeenCalledTimes(1)
    release()
    await first
  })
})
