import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useOpenFiles } from '@/composables/useOpenFiles'
import { useThemeStore } from '@/stores/theme'
import { useProjectStore } from '@/stores/project'

// 网络层 mock：filePolicy/readFile 与既有用例同形；createFile 即另存为落盘端点
// （content 随建随写），status 供保存成功后的变更计数刷新
vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client')
  return {
    ...actual,
    projectApi: {
      ...actual.projectApi,
      filePolicy: vi.fn().mockRejectedValue(new Error('policy skip')),
      readFile: vi.fn().mockResolvedValue({ data: 'file content', hash: 'hash-A' }),
      writeFile: vi.fn().mockResolvedValue({ data: 'ok', hash: 'hash-B' }),
      createFile: vi.fn().mockResolvedValue({ data: 'file created' }),
      status: vi.fn().mockResolvedValue({ data: [] }),
    },
  }
})

// 草稿存储层 mock：untitled 脏内容走 saveUntitledDraft 独立命名空间（P-20261003-97
// 热退出持久），不触文件草稿键；真链路由 draftDb 单测与 e2e 覆盖
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

// 弹窗 mock：confirmDialog 默认确认；promptDialog 由各用例按场景给定返回值
vi.mock('@/composables/useDialog', () => ({
  confirmDialog: vi.fn().mockResolvedValue(true),
  promptDialog: vi.fn(),
}))

import { saveDraft, saveUntitledDraft, listUntitledDrafts, removeUntitledDraft } from '@/utils/draftDb'
import { confirmDialog, promptDialog } from '@/composables/useDialog'
import { projectApi } from '@/api/client'

describe('useOpenFiles 未命名草稿（P-20261002-24）', () => {
  let openFiles: ReturnType<typeof useOpenFiles>

  beforeEach(() => {
    vi.useFakeTimers()
    const theme = useThemeStore()
    if (!theme.naiveTheme) {
      // @ts-expect-error: force default
      theme.$state = { currentTheme: 'dark', naiveTheme: undefined, naiveOverrides: undefined }
    }
    useProjectStore().currentProjectId = 'proj-1'
    vi.mocked(listUntitledDrafts).mockResolvedValue([])
    openFiles = useOpenFiles()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  describe('新建草稿', () => {
    it('untitled://N 内部键 + 「草稿 N」名 + 空内容干净态，激活跟随', () => {
      openFiles.openUntitled()
      expect(openFiles.currentFile.value?.path).toBe('untitled://1')
      expect(openFiles.currentFile.value?.name).toBe('草稿 1')
      expect(openFiles.currentFile.value?.content).toBe('')
      expect(openFiles.currentFile.value?.originalContent).toBe('')
      expect(openFiles.hasUnsavedChanges.value).toBe(false)

      openFiles.openUntitled()
      expect(openFiles.currentFile.value?.path).toBe('untitled://2')
      expect(openFiles.currentFile.value?.name).toBe('草稿 2')
      expect(openFiles.activeFileIndex.value).toBe(1)
    })

    it('编号跨关闭单调递增（不复用，防 model URI 残留冲突）', async () => {
      openFiles.openUntitled()
      await openFiles.closeFile(0)
      openFiles.openUntitled()
      expect(openFiles.openFiles.value.map(f => f.path)).toEqual(['untitled://2'])
    })
  })

  describe('关闭', () => {
    it('关闭有内容草稿需确认；确认后丢弃、清 untitled 记录且不入关闭栈（不可按路径重开）', async () => {
      openFiles.openUntitled()
      openFiles.updateContent('untitled://1', 'scratch before deciding')
      await openFiles.closeFile(0)

      expect(confirmDialog).toHaveBeenCalled()
      expect(openFiles.openFiles.value).toHaveLength(0)
      // 确认丢弃 = 清 untitled 命名空间热退出记录（P-20261003-97）
      expect(removeUntitledDraft).toHaveBeenCalledWith('proj-1', 'untitled://1')
      expect(openFiles.canReopenClosed.value).toBe(false)
      await openFiles.reopenClosedFile()
      expect(openFiles.openFiles.value).toHaveLength(0) // untitled://1 不会被重开
    })
  })

  describe('另存为（Ctrl+S 拦截）', () => {
    it('saveCurrentFile 转另存为：CreateFile 落盘 + tab 原地转正', async () => {
      openFiles.openUntitled()
      openFiles.updateContent('untitled://1', 'draft body')
      vi.mocked(promptDialog).mockResolvedValue('notes/idea.ts')

      await openFiles.saveCurrentFile()

      expect(projectApi.createFile).toHaveBeenCalledWith('proj-1', 'notes/idea.ts', 'draft body')
      const f = openFiles.currentFile.value!
      expect(f.path).toBe('notes/idea.ts')
      expect(f.name).toBe('idea.ts')
      expect(f.content).toBe('draft body')
      expect(f.originalContent).toBe('draft body') // 转正即干净态
      expect(openFiles.hasUnsavedChanges.value).toBe(false)
    })

    it('取消/空路径：草稿保持原状，不落盘', async () => {
      openFiles.openUntitled()
      openFiles.updateContent('untitled://1', 'keep me')
      vi.mocked(promptDialog).mockResolvedValue(null)

      await openFiles.saveCurrentFile()

      expect(projectApi.createFile).not.toHaveBeenCalled()
      expect(openFiles.currentFile.value?.path).toBe('untitled://1')
      expect(openFiles.currentFile.value?.content).toBe('keep me')
    })

    it('目标路径已有打开标签：拒绝转正（防同路径双份内存内容），不落盘', async () => {
      await openFiles.openFile({ path: 'notes/idea.ts', name: 'idea.ts' })
      await vi.advanceTimersByTimeAsync(0)
      openFiles.openUntitled()
      openFiles.updateContent('untitled://1', 'dup target')
      vi.mocked(promptDialog).mockResolvedValue('notes/idea.ts')

      await openFiles.saveCurrentFile()

      expect(projectApi.createFile).not.toHaveBeenCalled()
      expect(openFiles.currentFile.value?.path).toBe('untitled://1')
    })

    it('转正后编辑走真实文件保存链（writeFile 而非再次 createFile）', async () => {
      openFiles.openUntitled()
      openFiles.updateContent('untitled://1', 'v1')
      vi.mocked(promptDialog).mockResolvedValue('idea.md')
      await openFiles.saveCurrentFile()
      vi.mocked(projectApi.createFile).mockClear()

      openFiles.updateContent('idea.md', 'v2')
      await openFiles.saveCurrentFile()

      expect(projectApi.createFile).not.toHaveBeenCalled()
      expect(projectApi.writeFile).toHaveBeenCalled()
    })

    it('转正成功清 untitled 热退出记录；取消另存则保留（P-20261003-97）', async () => {
      openFiles.openUntitled()
      openFiles.updateContent('untitled://1', 'about to promote')
      vi.mocked(promptDialog).mockResolvedValue(null)
      await openFiles.saveCurrentFile()
      expect(removeUntitledDraft).not.toHaveBeenCalled()

      vi.mocked(promptDialog).mockResolvedValue('final.md')
      await openFiles.saveCurrentFile()
      expect(removeUntitledDraft).toHaveBeenCalledWith('proj-1', 'untitled://1')
    })
  })

  describe('热退出持久（P-20261003-97）', () => {
    it('脏内容 2s 防抖落 untitled 命名空间（不写文件草稿键），回净态清记录', async () => {
      openFiles.openUntitled()
      openFiles.updateContent('untitled://1', 'crash-safe scratch')
      await vi.advanceTimersByTimeAsync(2500)
      expect(saveUntitledDraft).toHaveBeenCalledWith('proj-1', 'untitled://1', expect.objectContaining({
        content: 'crash-safe scratch',
      }))
      expect(saveDraft).not.toHaveBeenCalled() // 与文件草稿键隔离

      openFiles.updateContent('untitled://1', '') // 撤销回净态（untitled 净态 = 空）
      await vi.advanceTimersByTimeAsync(0)
      expect(removeUntitledDraft).toHaveBeenCalledWith('proj-1', 'untitled://1')
    })

    it('启动恢复：按编号升序重建草稿 tab（内容就位保持脏态）+ 记录迁移到新编号键', async () => {
      vi.mocked(listUntitledDrafts).mockResolvedValue([
        { key: 'untitled://10', record: { content: 'second draft', savedAt: 200 } },
        { key: 'untitled://2', record: { content: 'first draft', savedAt: 100 } },
      ])

      await openFiles.restoreUntitledDrafts()

      // 编号重新分配（会话内 untitledSeq 接续 1、2），列表顺序按编号升序
      expect(openFiles.openFiles.value.map(f => f.path)).toEqual(['untitled://1', 'untitled://2'])
      expect(openFiles.openFiles.value[0]).toMatchObject({ content: 'first draft', originalContent: '', loading: false })
      expect(openFiles.openFiles.value[1]!.content).toBe('second draft')
      expect(openFiles.hasUnsavedChanges.value).toBe(true) // 恢复即脏态，保存仍走另存为
      expect(openFiles.activeFileIndex.value).toBe(0) // 空组激活第一份
      // 记录迁移：旧键清除、新键立即写入（不经防抖，恢复后再崩仍可恢复）
      expect(removeUntitledDraft).toHaveBeenCalledWith('proj-1', 'untitled://10')
      expect(removeUntitledDraft).toHaveBeenCalledWith('proj-1', 'untitled://2')
      expect(saveUntitledDraft).toHaveBeenCalledWith('proj-1', 'untitled://1', expect.objectContaining({ content: 'first draft' }))
      expect(saveUntitledDraft).toHaveBeenCalledWith('proj-1', 'untitled://2', expect.objectContaining({ content: 'second draft' }))
    })

    it('无记录 / 空内容记录：零副作用不 toast', async () => {
      await openFiles.restoreUntitledDrafts()
      expect(openFiles.openFiles.value).toHaveLength(0)
      expect(saveUntitledDraft).not.toHaveBeenCalled()

      vi.mocked(listUntitledDrafts).mockResolvedValue([
        { key: 'untitled://1', record: { content: '', savedAt: 1 } },
      ])
      await openFiles.restoreUntitledDrafts()
      expect(openFiles.openFiles.value).toHaveLength(0)
      expect(removeUntitledDraft).not.toHaveBeenCalled()
    })

    it('恢复后新建草稿编号接续不复用（untitledSeq 单调递增纪律不变）', async () => {
      vi.mocked(listUntitledDrafts).mockResolvedValue([
        { key: 'untitled://7', record: { content: 'kept', savedAt: 1 } },
      ])
      await openFiles.restoreUntitledDrafts()
      openFiles.openUntitled()
      expect(openFiles.currentFile.value?.path).toBe('untitled://2')
    })
  })
})
