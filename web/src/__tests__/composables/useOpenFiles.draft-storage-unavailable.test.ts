import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useOpenFiles } from '@/composables/useOpenFiles'
import { useProjectStore } from '@/stores/project'

/**
 * 草稿库不可用的用户回告（P-20261122-13 三步法②：IndexedDB 面真静默收口）。
 * 环境不可用（隐私模式/配额重灾）时 draftDb 永久降级，写入恒 false——此前
 * persist 域 fire-and-forget 吞掉结果，用户以为有 hot-exit 兜底，关页即丢。
 * 契约：环境级失败一次性提示（每份 openFiles 实例一次），>2MB 超限与事务级
 * 瞬时失败不提示（前者既定语义、后者有旧草稿兜底）。
 */

const warningSpy = vi.fn()

vi.mock('naive-ui', async () => {
  const actual = await vi.importActual<typeof import('naive-ui')>('naive-ui')
  return {
    ...actual,
    createDiscreteApi: vi.fn(() => ({
      message: { success: vi.fn(), error: vi.fn(), warning: warningSpy, info: vi.fn() },
      dialog: { create: vi.fn() },
      notification: { create: vi.fn() },
    })),
  }
})

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client')
  return {
    ...actual,
    projectApi: {
      ...actual.projectApi,
      filePolicy: vi.fn().mockRejectedValue(new Error('policy skip')),
      readFile: vi.fn().mockResolvedValue({ data: 'file content', hash: 'hash-A' }),
      status: vi.fn().mockResolvedValue({ data: [] }),
    },
  }
})

// 环境级降级：isDraftDbDisabled()=true 且写入恒 false
vi.mock('@/utils/draftDb', () => ({
  saveDraft: vi.fn().mockResolvedValue(false),
  readDraft: vi.fn().mockResolvedValue(null),
  readUntitledDraft: vi.fn().mockResolvedValue(null),
  removeDraft: vi.fn().mockResolvedValue(undefined),
  removeProjectDrafts: vi.fn().mockResolvedValue(undefined),
  saveUntitledDraft: vi.fn().mockResolvedValue(false),
  listUntitledDrafts: vi.fn().mockResolvedValue([]),
  removeUntitledDraft: vi.fn().mockResolvedValue(undefined),
  listFileDrafts: vi.fn().mockResolvedValue([]),
  removeDrafts: vi.fn().mockResolvedValue(undefined),
  isDraftDbDisabled: vi.fn().mockReturnValue(true),
  DRAFT_MAX_CHARS: 2 * 1024 * 1024,
  DRAFT_SAVED_BEACON_KEY: 'sc.draft-saved',
}))

const PATH = '/proj/a.ts'

async function openTargetFile(openFiles: ReturnType<typeof useOpenFiles>) {
  await openFiles.openFile({ path: PATH, name: 'a.ts' })
  await vi.advanceTimersByTimeAsync(0)
}

describe('useOpenFiles 草稿库不可用提示（P-20261122-13）', () => {
  let openFiles: ReturnType<typeof useOpenFiles>

  beforeEach(() => {
    vi.useFakeTimers()
    const projectStore = useProjectStore()
    projectStore.currentProjectId = 'proj-1'
    openFiles = useOpenFiles()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('首次环境级落库失败提示一次，后续失败不刷屏', async () => {
    await openTargetFile(openFiles)

    openFiles.updateContent(PATH, 'dirty one')
    await vi.advanceTimersByTimeAsync(2000)
    expect(warningSpy).toHaveBeenCalledTimes(1)
    expect(String(warningSpy.mock.calls[0]![0])).toContain('草稿')

    openFiles.updateContent(PATH, 'dirty two')
    await vi.advanceTimersByTimeAsync(2000)
    expect(warningSpy).toHaveBeenCalledTimes(1)
  })
})
