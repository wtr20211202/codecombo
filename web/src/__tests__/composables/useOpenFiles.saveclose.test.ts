import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useOpenFiles } from '@/composables/useOpenFiles'
import { useThemeStore } from '@/stores/theme'
import { useProjectStore } from '@/stores/project'

// 网络层 mock：readFile 带回磁盘内容 + hash（冲突检测基线），writeFile 回写新
// hash——与后端 ReadFile/WriteFile 真实响应同形（沿 useOpenFiles.draft.test 同款）
vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client')
  return {
    ...actual,
    projectApi: {
      ...actual.projectApi,
      filePolicy: vi.fn().mockRejectedValue(new Error('policy skip')),
      readFile: vi.fn().mockResolvedValue({ data: 'file content', hash: 'hash-A' }),
      writeFile: vi.fn().mockResolvedValue({ data: 'ok', hash: 'hash-B' }),
      createFile: vi.fn().mockResolvedValue({ data: 'ok' }),
      // 保存成功收尾 fetchStatus（变更计数刷新）会触达：空清单即可
      status: vi.fn().mockResolvedValue({ data: [] }),
    },
  }
})

vi.mock('@/utils/draftDb', () => ({
  saveDraft: vi.fn().mockResolvedValue(true),
  readDraft: vi.fn().mockResolvedValue(null),
  removeDraft: vi.fn().mockResolvedValue(undefined),
  removeProjectDrafts: vi.fn().mockResolvedValue(undefined),
  saveUntitledDraft: vi.fn().mockResolvedValue(true),
  listUntitledDrafts: vi.fn().mockResolvedValue([]),
  removeUntitledDraft: vi.fn().mockResolvedValue(undefined),
  DRAFT_MAX_CHARS: 2 * 1024 * 1024,
}))

// 对话框 mock：确认弹窗默认确认；另存为路径输入默认 null（逐用例覆写）
vi.mock('@/composables/useDialog', () => ({
  confirmDialog: vi.fn().mockResolvedValue(true),
  promptDialog: vi.fn().mockResolvedValue(null),
}))

import { projectApi } from '@/api/client'
import { confirmDialog, promptDialog } from '@/composables/useDialog'

const PATH = '/proj/a.ts'

async function openTargetFile(openFiles: ReturnType<typeof useOpenFiles>) {
  await openFiles.openFile({ path: PATH, name: 'a.ts' })
  // filePolicy 拒绝 + readFile 就绪的微任务链冲刷
  await vi.advanceTimersByTimeAsync(0)
}

describe('useOpenFiles 脏点「保存并关闭」（P-20261003-138）', () => {
  let openFiles: ReturnType<typeof useOpenFiles>

  beforeEach(() => {
    vi.useFakeTimers()
    const theme = useThemeStore()
    if (!theme.naiveTheme) {
      // @ts-expect-error: force default
      theme.$state = { currentTheme: 'dark', naiveTheme: undefined, naiveOverrides: undefined }
    }
    const projectStore = useProjectStore()
    projectStore.currentProjectId = 'proj-1'
    openFiles = useOpenFiles()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('脏文件：确认后写入磁盘并关闭标签', async () => {
    await openTargetFile(openFiles)
    openFiles.updateContent(PATH, 'edited content')

    await openFiles.saveCloseFileInGroup(0, 0)

    expect(confirmDialog).toHaveBeenCalledTimes(1)
    expect(projectApi.writeFile).toHaveBeenCalledTimes(1)
    // 标签已关闭
    expect(openFiles.openFiles.value).toHaveLength(0)
  })

  it('脏文件：取消则不保存也不关闭', async () => {
    await openTargetFile(openFiles)
    openFiles.updateContent(PATH, 'edited content')
    vi.mocked(confirmDialog).mockResolvedValue(false)

    await openFiles.saveCloseFileInGroup(0, 0)

    expect(projectApi.writeFile).not.toHaveBeenCalled()
    expect(openFiles.openFiles.value).toHaveLength(1)
  })

  it('保存失败：标签保持打开（丢改动比再点一次代价高）', async () => {
    await openTargetFile(openFiles)
    openFiles.updateContent(PATH, 'edited content')
    vi.mocked(projectApi.writeFile).mockRejectedValue(new Error('disk full'))

    await openFiles.saveCloseFileInGroup(0, 0)

    expect(openFiles.openFiles.value).toHaveLength(1)
    expect(openFiles.openFiles.value[0]!.content).toBe('edited content')
  })

  it('净态文件：防御直返，不弹确认不写盘', async () => {
    await openTargetFile(openFiles)

    await openFiles.saveCloseFileInGroup(0, 0)

    expect(confirmDialog).not.toHaveBeenCalled()
    expect(projectApi.writeFile).not.toHaveBeenCalled()
    expect(openFiles.openFiles.value).toHaveLength(1)
  })

  it('untitled 草稿：另存为转正成功后关闭标签', async () => {
    openFiles.openUntitled()
    openFiles.updateContent('untitled://1', 'draft body')
    vi.mocked(promptDialog).mockResolvedValue('notes/new-file.txt')

    await openFiles.saveCloseFileInGroup(0, 0)

    expect(projectApi.createFile).toHaveBeenCalledWith('proj-1', 'notes/new-file.txt', 'draft body')
    // 转正即关闭：无残留 tab
    expect(openFiles.openFiles.value).toHaveLength(0)
  })

  it('untitled 草稿：另存为取消则保持草稿原状', async () => {
    openFiles.openUntitled()
    openFiles.updateContent('untitled://1', 'draft body')
    vi.mocked(promptDialog).mockResolvedValue(null)

    await openFiles.saveCloseFileInGroup(0, 0)

    expect(projectApi.createFile).not.toHaveBeenCalled()
    expect(openFiles.openFiles.value).toHaveLength(1)
    expect(openFiles.openFiles.value[0]!.path).toBe('untitled://1')
  })
})
