import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../api/error-types'
import type { ShareInfo } from '../api/domains/share'
import { reshareConfig, shareCanReshare, useShareReshare } from './useShareReshare'

// 「重新分享」纯逻辑（P-20261020-10）：只对已过期/已消费且目标健康的 file
// 分享开放；重建沿用原 mode/水印/一次性，口令由用户重新输入。
// P-20261114-3-S1 补撤销→重建链路单测：批量行（Paths 非空）必须走 createBatch
// 传原 paths（走单路径 create 会静默重建为「项目根」单路径分享——评审修订点③
// 的静默事故），单路径按弹层提交的 mode/ttl 重建（模式可改不再锁死来源）。

const NOW = Date.parse('2026-10-10T00:00:00Z')
const IDS = new Set(['p1'])

const shareApiMock = vi.hoisted(() => ({
  remove: vi.fn(),
  create: vi.fn(),
  createBatch: vi.fn(),
}))
vi.mock('../api/domains/share', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/domains/share')>()
  return { ...actual, shareApi: shareApiMock }
})
vi.mock('./useShareDialog', () => ({
  confirmSensitiveFiles: vi.fn(async () => true),
}))
const messageMock = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('naive-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('naive-ui')>()
  return { ...actual, useMessage: () => messageMock }
})

function row(overrides: Partial<ShareInfo>): ShareInfo {
  return {
    token: 't1',
    kind: 'file',
    projectId: 'p1',
    projectName: 'demo',
    path: 'docs/a.md',
    name: 'a.md',
    isDir: false,
    size: 10,
    createdAt: '2026-10-01T00:00:00Z',
    ...overrides,
  }
}

const pastIso = () => new Date(NOW - 60_000).toISOString()

describe('shareCanReshare', () => {
  it('仅过期/已消费且目标健康的 file 分享可重建', () => {
    expect(shareCanReshare(row({ expiresAt: '2026-10-09T00:00:00Z' }), NOW, IDS)).toBe(true)
    expect(shareCanReshare(row({ consumed: true }), NOW, IDS)).toBe(true)
    // 活跃行：重复 create 是幂等 no-op，没有重建语义
    expect(shareCanReshare(row({}), NOW, IDS)).toBe(false)
    // 异常行：目标不存在，重建只会失败
    expect(shareCanReshare(row({ expiresAt: '2026-10-09T00:00:00Z', health: 'target_missing' }), NOW, IDS)).toBe(false)
    // 非 file 形态没有可复用的项目文件配置
    expect(shareCanReshare(row({ kind: 'snippet', expiresAt: '2026-10-09T00:00:00Z' }), NOW, IDS)).toBe(false)
    expect(shareCanReshare(row({ kind: 'terminal', expiresAt: '2026-10-09T00:00:00Z' }), NOW, IDS)).toBe(false)
    // 归属项目已删除：冻结链可能仍健康，但没有可重拷的源目标
    expect(shareCanReshare(row({ expiresAt: '2026-10-09T00:00:00Z' }), NOW, new Set())).toBe(false)
  })
})

describe('reshareConfig', () => {
  it('沿用 frozen/live、水印与一次性设置；口令取本次输入', () => {
    expect(reshareConfig(row({ frozen: true, watermark: false }), 'pw')).toEqual({
      projectId: 'p1',
      path: 'docs/a.md',
      mode: 'frozen',
      passphrase: 'pw',
      watermark: false,
      viewOnce: false,
    })
  })

  it('watermark 缺省按开、viewOnce 缺省按关；live 口令可留空', () => {
    expect(reshareConfig(row({ viewOnce: true }))).toEqual({
      projectId: 'p1',
      path: 'docs/a.md',
      mode: 'live',
      passphrase: '',
      watermark: true,
      viewOnce: true,
    })
  })
})

describe('撤销→重建链路（P-20261114-3-S1 弹层确认后）', () => {
  const refresh = vi.fn(async () => {})

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('批量记录重发走 createBatch 传原 paths，绝不静默退化为单路径重建', async () => {
    shareApiMock.remove.mockResolvedValue(undefined)
    shareApiMock.createBatch.mockResolvedValue({ data: row({ frozen: true, path: '', name: 'batch' }) })
    const { runBatchReshare } = useShareReshare(refresh)
    const s = row({ frozen: true, path: '', paths: ['docs/a.md', 'notes/b.md'], expiresAt: pastIso() })

    await runBatchReshare(s, 'pw', false, IDS)

    // 撤销旧死链 → createBatch（原选择集、原口令/水印语义）
    expect(shareApiMock.remove).toHaveBeenCalledWith('t1', { silent: true })
    expect(shareApiMock.createBatch).toHaveBeenCalledTimes(1)
    expect(shareApiMock.createBatch).toHaveBeenCalledWith('p1', ['docs/a.md', 'notes/b.md'], false, 'pw', false)
    // 关键反例锚：单路径 create 通道不得被批量行触碰
    expect(shareApiMock.create).not.toHaveBeenCalled()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(messageMock.success).toHaveBeenCalled()
  })

  it('单路径重建按弹层提交的 mode/ttl 走 create——模式可改（不再锁死来源模式）', async () => {
    shareApiMock.remove.mockResolvedValue(undefined)
    shareApiMock.create.mockResolvedValue({ data: row({ frozen: false }) })
    const { runReshare } = useShareReshare(refresh)
    const s = row({ frozen: true, expiresAt: pastIso() })

    // 来源 frozen、弹层切回 live + 用户改档 7d：载荷逐参透传
    await runReshare(s, { mode: 'live', passphrase: 'pw2', watermark: false, viewOnce: false, ttl: '7d' }, IDS)

    expect(shareApiMock.remove).toHaveBeenCalledWith('t1', { silent: true })
    expect(shareApiMock.create).toHaveBeenCalledTimes(1)
    expect(shareApiMock.create).toHaveBeenCalledWith(
      'p1', 'docs/a.md', false, 'live', 'pw2', false, false, '7d', undefined)
    expect(shareApiMock.createBatch).not.toHaveBeenCalled()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('撤销 404（清理 ticker 已收走）容忍并继续重建', async () => {
    shareApiMock.remove.mockRejectedValue(
      new AppError('notFound', 'share not found', 404, '/api/share/t1', 'DELETE'))
    shareApiMock.create.mockResolvedValue({ data: row({}) })
    const { runReshare } = useShareReshare(refresh)
    const s = row({ expiresAt: pastIso() })

    await runReshare(s, { mode: 'live', passphrase: '', watermark: true, viewOnce: false }, IDS)

    expect(shareApiMock.create).toHaveBeenCalledTimes(1)
    expect(messageMock.error).not.toHaveBeenCalled()
  })

  it('不可重发行兜底拦截（活跃行直调）：警告且不动旧记录', async () => {
    const { runReshare } = useShareReshare(refresh)
    const s = row({}) // 活跃行：无 expiresAt/消费，shareCanReshare=false

    await runReshare(s, { mode: 'live', passphrase: '', watermark: true, viewOnce: false }, IDS)

    expect(shareApiMock.remove).not.toHaveBeenCalled()
    expect(shareApiMock.create).not.toHaveBeenCalled()
    expect(messageMock.warning).toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  })
})
