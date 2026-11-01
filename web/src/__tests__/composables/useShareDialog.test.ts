import { describe, it, expect, vi, beforeEach } from 'vitest'

// 回放分享创建链（P-20261004-103 cast / P-20261003-77 session）：成功响应
// 即弹结果卡 + 拼访客短链。敏感警示确认流依赖 naive-ui 弹窗宿主，交互由
// e2e 覆盖；此处锁 API 调用契约与单例状态收尾

vi.mock('@/api/domains/share', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/domains/share')>()
  return {
    ...actual,
    shareApi: {
      ...actual.shareApi,
      create: vi.fn(),
      createCast: vi.fn(),
      createSession: vi.fn(),
      createBatch: vi.fn(),
      status: vi.fn(),
    },
  }
})

// 批量分享的体积预估走 files-archive probe（P-20261008-1）：单测只锁调用面，
// 不触真实 HTTP
vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>()
  return {
    ...actual,
    projectApi: { ...actual.projectApi, filesArchiveProbe: vi.fn() },
  }
})

import { projectApi } from '@/api/client'
vi.mock('@/api/domains/system', () => ({
  settingsApi: { get: vi.fn() },
  networkApi: { list: vi.fn().mockResolvedValue({ data: [] }) },
}))

import { shareApi, type ShareInfo } from '@/api/domains/share'
import { settingsApi } from '@/api/domains/system'
import { useShareDialog } from '@/composables/useShareDialog'
import { buildShareAddressPlan } from '@/utils/shareAddress'

const castShare: ShareInfo = {
  token: 'casttoken00000001',
  kind: 'cast',
  projectId: '',
  projectName: '',
  path: '',
  name: 'reset --hard',
  isDir: false,
  size: 2048,
  createdAt: '2026-10-18T00:00:00Z',
  expiresAt: '2026-10-18T01:00:00Z',
  recordingId: 'sc_rec_x',
  terminalId: 'sess-1',
}

const sessionShare: ShareInfo = {
  token: 'sessiontoken000001',
  kind: 'session',
  projectId: '',
  projectName: '',
  path: '',
  name: '排查心跳',
  isDir: false,
  size: 4096,
  createdAt: '2026-10-19T00:00:00Z',
  expiresAt: '2026-10-20T00:00:00Z',
  sessionId: 'sess-share-1',
}

const fileShare: ShareInfo = {
  token: 'filetoken00000001',
  kind: 'file',
  projectId: 'p1',
  projectName: 'proj',
  path: 'a.txt',
  name: 'a.txt',
  isDir: false,
  size: 10,
  createdAt: '2026-10-20T00:00:00Z',
  hasPassphrase: true,
}

const batchShare: ShareInfo = {
  token: 'batchtoken000001',
  kind: 'file',
  projectId: 'p1',
  projectName: 'demo',
  path: '',
  paths: ['docs/a.md', 'src/b.ts'],
  name: 'a.md +1',
  isDir: false,
  size: 42,
  createdAt: '2026-10-21T00:00:00Z',
  expiresAt: '2026-11-20T00:00:00Z',
  frozen: true,
}

beforeEach(() => {
  vi.mocked(shareApi.create).mockReset()
  vi.mocked(shareApi.createCast).mockReset()
  vi.mocked(shareApi.createSession).mockReset()
  vi.mocked(shareApi.createBatch).mockReset()
  vi.mocked(shareApi.status).mockReset()
  vi.mocked(projectApi.filesArchiveProbe).mockReset()
  vi.mocked(projectApi.filesArchiveProbe).mockResolvedValue({
    data: { entries: 2, bytes: 42, truncated: false },
  } as unknown as Awaited<ReturnType<typeof projectApi.filesArchiveProbe>>)
  vi.mocked(settingsApi.get).mockReset()
  vi.mocked(settingsApi.get).mockResolvedValue({
    data: { shareDefaultTTL: 'permanent' },
  } as unknown as Awaited<ReturnType<typeof settingsApi.get>>)
  vi.mocked(shareApi.status).mockResolvedValue({
    data: { running: true, port: 18080, scheme: 'http' },
  } as unknown as Awaited<ReturnType<typeof shareApi.status>>)
})

describe('useShareDialog 口令明文生命周期', () => {
  it('openResult 快照本次明文口令，closeResult 立即清空', () => {
    const api = useShareDialog()
    api.openResult(fileShare, buildShareAddressPlan(fileShare.token, {
      currentHref: 'http://host:18080',
      status: { running: true, port: 18080, scheme: 'http' },
      addresses: [],
    }), 'e2e-secret')
    expect(api.showResult.value).toBe(true)
    expect(api.resultPassphrase.value).toBe('e2e-secret')
    api.closeResult()
    expect(api.resultPassphrase.value).toBe('')
  })

  it('文件分享创建把本次口令带给结果卡（不写入 URL）', async () => {
    vi.mocked(shareApi.create).mockResolvedValue({
      data: fileShare,
    } as unknown as Awaited<ReturnType<typeof shareApi.create>>)
    const api = useShareDialog()
    api.closeResult()
    api.createShare('p1', 'a.txt', 'a.txt')
    api.createPassphrase.value = 'file-secret'
    await api.confirmCreate()

    expect(shareApi.create).toHaveBeenCalledWith('p1', 'a.txt', false, 'live', 'file-secret', true, false, undefined, undefined)
    expect(api.showResult.value).toBe(true)
    expect(api.resultPassphrase.value).toBe('file-secret')
    expect(api.resultUrl.value).not.toContain('file-secret')
    api.closeResult()
    expect(api.resultPassphrase.value).toBe('')
  })
})

describe('useShareDialog.createRecordingShare', () => {
  it('创建成功即弹结果卡并拼出访客短链', async () => {
    vi.mocked(shareApi.createCast).mockResolvedValue({
      data: castShare,
    } as unknown as Awaited<ReturnType<typeof shareApi.createCast>>)
    const api = useShareDialog()
    api.closeResult()

    await api.createRecordingShare('sc_rec_x')

    expect(shareApi.createCast).toHaveBeenCalledWith('sc_rec_x')
    expect(api.showResult.value).toBe(true)
    expect(api.resultShare.value?.kind).toBe('cast')
    expect(api.resultUrl.value).toContain('/s/casttoken00000001')
  })

  it('空 recordingId 不发请求', async () => {
    const api = useShareDialog()
    api.closeResult()
    await api.createRecordingShare('')
    expect(shareApi.createCast).not.toHaveBeenCalled()
    expect(api.showResult.value).toBe(false)
  })
})

describe('useShareDialog.createSessionShare', () => {
  it('创建成功即弹结果卡并拼出访客短链', async () => {
    vi.mocked(shareApi.createSession).mockResolvedValue({
      data: sessionShare,
    } as unknown as Awaited<ReturnType<typeof shareApi.createSession>>)
    const api = useShareDialog()
    api.closeResult()

    await api.createSessionShare('sess-share-1')

    expect(shareApi.createSession).toHaveBeenCalledWith('sess-share-1')
    expect(api.showResult.value).toBe(true)
    expect(api.resultShare.value?.kind).toBe('session')
    expect(api.resultShare.value?.sessionId).toBe('sess-share-1')
    expect(api.resultUrl.value).toContain('/s/sessiontoken000001')
  })

  it('空 sessionId 不发请求', async () => {
    const api = useShareDialog()
    api.closeResult()
    await api.createSessionShare('')
    expect(shareApi.createSession).not.toHaveBeenCalled()
    expect(api.showResult.value).toBe(false)
  })
})

describe('useShareDialog.createShareBatch', () => {
  it('集合排序进弹层 → 强制 frozen 走 createBatch → 结果卡 + 体积预估', async () => {
    vi.mocked(shareApi.createBatch).mockResolvedValue({
      data: batchShare,
    } as unknown as Awaited<ReturnType<typeof shareApi.createBatch>>)
    const api = useShareDialog()
    api.closeResult()

    // 乱序选择集：弹层按排序后的形态持有（与服务端幂等键同口径）
    api.createShareBatch('p1', ['src/b.ts', 'docs/a.md'])
    expect(api.showCreate.value).toBe(true)
    expect(api.createTarget.value?.paths).toEqual(['docs/a.md', 'src/b.ts'])
    expect(api.createTarget.value?.path).toBe('')
    expect(api.createMode.value).toBe('frozen')
    expect(api.createEstimate.value).toBeNull()

    await api.confirmCreate()

    // 批量固定 frozen、path 载荷为空、口令/水印按弹层值；预估回填
    expect(shareApi.createBatch).toHaveBeenCalledWith('p1', ['docs/a.md', 'src/b.ts'], false, '', true)
    expect(api.showResult.value).toBe(true)
    expect(api.resultShare.value?.paths).toEqual(['docs/a.md', 'src/b.ts'])
    expect(api.resultUrl.value).toContain('/s/batchtoken000001')
    await vi.waitFor(() => expect(api.createEstimate.value).toEqual({ entries: 2, bytes: 42, truncated: false }))
  })

  it('空集合/空项目不发请求也不开弹层', () => {
    const api = useShareDialog()
    api.cancelCreate()
    api.createShareBatch('', ['docs/a.md'])
    expect(api.showCreate.value).toBe(false)
    api.createShareBatch('p1', [])
    expect(api.showCreate.value).toBe(false)
  })
})

describe('useShareDialog 创建有效期（P-20261020-5）', () => {
  it('弹层预选服务端默认档；未改动时不显式携带 ttl（服务端兜底）', async () => {
    vi.mocked(settingsApi.get).mockResolvedValue({
      data: { shareDefaultTTL: '7d' },
    } as unknown as Awaited<ReturnType<typeof settingsApi.get>>)
    vi.mocked(shareApi.create).mockResolvedValue({
      data: fileShare,
    } as unknown as Awaited<ReturnType<typeof shareApi.create>>)
    const api = useShareDialog()
    api.closeResult()
    api.createShare('p1', 'note.txt', 'note.txt')

    await vi.waitFor(() => expect(api.createTtlChoice.value).toBe('7d'))
    expect(api.createTtlTouched.value).toBe(false)

    await api.confirmCreate()

    // 位置参数尾部 ttl/expiresAt 均为 undefined：未显式选择
    expect(shareApi.create).toHaveBeenCalledWith('p1', 'note.txt', false, 'live', '', true, false, undefined, undefined)
    expect(api.showResult.value).toBe(true)
  })

  it('主动选择档位后显式携带 ttl', async () => {
    vi.mocked(shareApi.create).mockResolvedValue({
      data: fileShare,
    } as unknown as Awaited<ReturnType<typeof shareApi.create>>)
    const api = useShareDialog()
    api.closeResult()
    api.createShare('p1', 'note.txt', 'note.txt')
    api.createTtlChoice.value = '1h'
    api.createTtlTouched.value = true

    await api.confirmCreate()

    expect(shareApi.create.mock.calls[0]?.slice(3)).toEqual(['live', '', true, false, '1h', undefined])
  })

  it('自定义日期转 RFC3339 到期时点（当日 23:59:59 本地时区）', async () => {
    vi.mocked(shareApi.create).mockResolvedValue({
      data: fileShare,
    } as unknown as Awaited<ReturnType<typeof shareApi.create>>)
    const api = useShareDialog()
    api.closeResult()
    api.createShare('p1', 'note.txt', 'note.txt')
    api.createTtlChoice.value = 'custom'
    api.createTtlDate.value = new Date(2026, 10, 5, 10, 0, 0).getTime()
    api.createTtlTouched.value = true

    await api.confirmCreate()

    const call = shareApi.create.mock.calls[0]!
    const expiresAt = call[8] as string
    const d = new Date(expiresAt)
    expect(d.getDate()).toBe(5)
    expect(d.getHours()).toBe(23)
    expect(d.getMinutes()).toBe(59)
  })
})
