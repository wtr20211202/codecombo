import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useOpenFiles } from '@/composables/useOpenFiles'
import { useThemeStore } from '@/stores/theme'
import { useProjectStore } from '@/stores/project'

// 网络层 mock：readFile 带回磁盘内容 + hash（保存冲突检测基线），
// writeFile 回写新 hash——与后端 ReadFile/WriteFile 真实响应同形。
// remoteHostApi.files 覆盖远程伪路径链（P-20261004-116）：content = 远端全文 +
// hash（与 content 端点真实响应同形），writeContent = PUT 回写新 hash
vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client')
  return {
    ...actual,
    projectApi: {
      ...actual.projectApi,
      filePolicy: vi.fn().mockRejectedValue(new Error('policy skip')),
      readFile: vi.fn().mockResolvedValue({ data: 'file content', hash: 'hash-A' }),
      writeFile: vi.fn().mockResolvedValue({ data: 'ok', hash: 'hash-B' }),
      // 保存成功后 useOpenFiles 会 void fetchStatus 刷新变更计数
      status: vi.fn().mockResolvedValue({ data: [] }),
    },
    remoteHostApi: {
      ...actual.remoteHostApi,
      files: {
        ...actual.remoteHostApi.files,
        content: vi.fn().mockResolvedValue({ data: 'remote content', hash: 'rhash-A' }),
        writeContent: vi.fn().mockResolvedValue({ message: 'ok', hash: 'rhash-B' }),
      },
    },
  }
})

// 草稿存储层 mock：单测聚焦防抖/比较/清理的编排逻辑，IndexedDB 真链路由
// draftDb 单测（防御降级）与 e2e（真实读写）覆盖
vi.mock('@/utils/draftDb', () => ({
  saveDraft: vi.fn().mockResolvedValue(true),
  readDraft: vi.fn().mockResolvedValue(null),
  removeDraft: vi.fn().mockResolvedValue(undefined),
  removeProjectDrafts: vi.fn().mockResolvedValue(undefined),
  saveUntitledDraft: vi.fn().mockResolvedValue(true),
  listUntitledDrafts: vi.fn().mockResolvedValue([]),
  removeUntitledDraft: vi.fn().mockResolvedValue(undefined),
  listFileDrafts: vi.fn().mockResolvedValue([]),
  removeDrafts: vi.fn().mockResolvedValue(undefined),
  DRAFT_MAX_CHARS: 2 * 1024 * 1024,
}))

// 关闭确认弹窗 mock：默认用户确认关闭（放弃未保存内容）
vi.mock('@/composables/useDialog', () => ({
  confirmDialog: vi.fn().mockResolvedValue(true),
}))

import { saveDraft, readDraft, removeDraft, listFileDrafts, removeDrafts } from '@/utils/draftDb'
import { projectApi, remoteHostApi } from '@/api/client'
import { AppError } from '@/api/error-types'
import { confirmDialog } from '@/composables/useDialog'
import { REMOTE_DRAFT_PROJECT } from '@/composables/openfiles/persist'

const PATH = '/proj/a.ts'

async function openTargetFile(openFiles: ReturnType<typeof useOpenFiles>) {
  await openFiles.openFile({ path: PATH, name: 'a.ts' })
  // filePolicy 拒绝 + readFile 就绪的微任务链冲刷
  await vi.advanceTimersByTimeAsync(0)
}

describe('useOpenFiles 草稿恢复编排（P-20261002-6）', () => {
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
    vi.mocked(readDraft).mockResolvedValue(null)
    openFiles = useOpenFiles()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  describe('防抖写入', () => {
    it('变脏后 2s 落库一次（带磁盘 hash 基线）', async () => {
      await openTargetFile(openFiles)
      openFiles.updateContent(PATH, 'edited content')
      expect(saveDraft).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(2000)
      expect(saveDraft).toHaveBeenCalledTimes(1)
      expect(saveDraft).toHaveBeenCalledWith('proj-1', PATH, expect.objectContaining({
        content: 'edited content',
        baseHash: 'hash-A',
      }))
    })

    it('2s 内连续击键去抖：只落最后一次内容', async () => {
      await openTargetFile(openFiles)
      openFiles.updateContent(PATH, 'first')
      await vi.advanceTimersByTimeAsync(1000)
      openFiles.updateContent(PATH, 'first-second')
      await vi.advanceTimersByTimeAsync(1500) // 距首次 2.5s，距末次仅 1.5s
      expect(saveDraft).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(600)
      expect(saveDraft).toHaveBeenCalledTimes(1)
      expect(saveDraft).toHaveBeenCalledWith('proj-1', PATH, expect.objectContaining({
        content: 'first-second',
      }))
    })

    it('pagehide 抢跑挂起写入：不等 2s 立即落库', async () => {
      await openTargetFile(openFiles)
      openFiles.updateContent(PATH, 'unsaved at unload')
      window.dispatchEvent(new Event('pagehide'))
      await vi.advanceTimersByTimeAsync(0)
      expect(saveDraft).toHaveBeenCalledWith('proj-1', PATH, expect.objectContaining({
        content: 'unsaved at unload',
      }))
    })
  })

  describe('清理三态', () => {
    it('保存成功清草稿', async () => {
      await openTargetFile(openFiles)
      openFiles.updateContent(PATH, 'to be saved')
      await vi.advanceTimersByTimeAsync(2000)
      expect(saveDraft).toHaveBeenCalledTimes(1)

      await openFiles.saveCurrentFile()
      expect(removeDraft).toHaveBeenCalledWith('proj-1', PATH)
    })

    it('关闭文件清草稿（用户已在未保存确认中放弃）', async () => {
      await openTargetFile(openFiles)
      openFiles.updateContent(PATH, 'to be dropped')
      openFiles.closeFile(0)
      await vi.advanceTimersByTimeAsync(0)
      expect(confirmDialog).toHaveBeenCalled()
      expect(removeDraft).toHaveBeenCalledWith('proj-1', PATH)

      // 已关闭不再落库（挂起防抖被一并取消）
      vi.mocked(saveDraft).mockClear()
      await vi.advanceTimersByTimeAsync(5000)
      expect(saveDraft).not.toHaveBeenCalled()
    })

    it('撤销回净态清草稿且不再落库', async () => {
      await openTargetFile(openFiles)
      openFiles.updateContent(PATH, 'dirty')
      openFiles.updateContent(PATH, 'file content') // 回到 originalContent
      await vi.advanceTimersByTimeAsync(5000)
      expect(removeDraft).toHaveBeenCalledWith('proj-1', PATH)
      expect(saveDraft).not.toHaveBeenCalled()
    })
  })

  describe('打开文件探测（磁盘 hash 比对取代提案的 mtime 比较）', () => {
    it('磁盘未变（hash 一致）→ 入队提示，恢复写回并置脏', async () => {
      vi.mocked(readDraft).mockResolvedValue({ content: 'draft content', savedAt: 1700000000000, baseHash: 'hash-A' })
      await openTargetFile(openFiles)

      expect(openFiles.draftOffer.value).toEqual(expect.objectContaining({
        projectId: 'proj-1', path: PATH, savedAt: 1700000000000,
      }))

      openFiles.applyDraftRestore('proj-1', PATH)
      const f = openFiles.openFiles.value[0]!
      expect(f.content).toBe('draft content')
      expect(f.originalContent).toBe('file content') // 恢复后保持脏态
      expect(openFiles.draftOffer.value).toBeNull()
      // DB 草稿保留：与恢复后内容一致，保存成功才清
      expect(removeDraft).not.toHaveBeenCalled()
    })

    it('磁盘已前行（草稿 hash 不一致）→ 陈旧草稿静默清除', async () => {
      vi.mocked(readDraft).mockResolvedValue({ content: 'stale draft', savedAt: 1, baseHash: 'hash-OLD' })
      await openTargetFile(openFiles)

      expect(openFiles.draftOffer.value).toBeNull()
      expect(removeDraft).toHaveBeenCalledWith('proj-1', PATH)
    })

    it('草稿与磁盘一致（无恢复价值）→ 静默清除', async () => {
      vi.mocked(readDraft).mockResolvedValue({ content: 'file content', savedAt: 1, baseHash: 'hash-A' })
      await openTargetFile(openFiles)

      expect(openFiles.draftOffer.value).toBeNull()
      expect(removeDraft).toHaveBeenCalledWith('proj-1', PATH)
    })

    it('写入时无 hash 基线（旧响应）→ 跳过比对仍提示', async () => {
      vi.mocked(readDraft).mockResolvedValue({ content: 'legacy draft', savedAt: 2 })
      await openTargetFile(openFiles)
      expect(openFiles.draftOffer.value).toEqual(expect.objectContaining({ path: PATH }))
    })

    it('丢弃动作：删 DB 草稿并摘除提示', async () => {
      vi.mocked(readDraft).mockResolvedValue({ content: 'draft content', savedAt: 3, baseHash: 'hash-A' })
      await openTargetFile(openFiles)

      openFiles.discardDraftRestore('proj-1', PATH)
      expect(removeDraft).toHaveBeenCalledWith('proj-1', PATH)
      expect(openFiles.draftOffer.value).toBeNull()
      expect(openFiles.openFiles.value[0]!.content).toBe('file content') // 内容不动
    })

    it('恢复悬挂期间文件又被编辑：拒绝覆盖，草稿作废', async () => {
      vi.mocked(readDraft).mockResolvedValue({ content: 'draft content', savedAt: 4, baseHash: 'hash-A' })
      await openTargetFile(openFiles)

      openFiles.updateContent(PATH, 'newer memory content')
      openFiles.applyDraftRestore('proj-1', PATH)
      expect(openFiles.openFiles.value[0]!.content).toBe('newer memory content')
      expect(removeDraft).toHaveBeenCalledWith('proj-1', PATH)
    })

  })

  describe('对比预览（P-20261004-71）', () => {
    /** 预览是两段异步（readDraft → openDiffView 内 readFile），两次冲刷确保右侧取数落地 */
    async function previewAndFlush() {
      await openFiles.previewDraftRestore('proj-1', PATH)
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)
    }

    it('预览：开 diff 标签，左=草稿内容、右=磁盘现内容，offer 保留可继续决策', async () => {
      vi.mocked(readDraft).mockResolvedValue({ content: 'draft content', savedAt: 6, baseHash: 'hash-A' })
      await openTargetFile(openFiles)

      await previewAndFlush()

      const f = openFiles.openFiles.value.find(x => x.isDiff)!
      expect(f).toBeTruthy()
      expect(f.path).toMatch(/^diff:draft-\d+:wt:\/proj\/a\.ts$/)
      expect(f.diffOldContent).toBe('draft content') // 左 = IndexedDB 草稿
      expect(f.content).toBe('file content') // 右 = readFile 现拉的磁盘内容
      expect(f.originalContent).toBe('file content')
      // 只读动作：不消费 offer、不动草稿，恢复/丢弃语义不变
      expect(openFiles.draftOffer.value).not.toBeNull()
      expect(removeDraft).not.toHaveBeenCalled()
    })

    it('IndexedDB 读失败：退回探测时快照仍可预览', async () => {
      vi.mocked(readDraft).mockResolvedValue({ content: 'snapshot draft', savedAt: 7, baseHash: 'hash-A' })
      await openTargetFile(openFiles)
      vi.mocked(readDraft).mockRejectedValue(new Error('idb gone'))

      await previewAndFlush()

      expect(openFiles.openFiles.value.find(x => x.isDiff)!.diffOldContent).toBe('snapshot draft')
    })

    it('无待决 offer（已处置/已切项目）：预览空操作不开标签', async () => {
      await openTargetFile(openFiles) // readDraft 默认 null，无 offer
      await previewAndFlush()

      expect(openFiles.openFiles.value).toHaveLength(1) // 只有目标文件签，无 diff 签
    })

    it('预览后仍可恢复：草稿照常写回', async () => {
      vi.mocked(readDraft).mockResolvedValue({ content: 'draft content', savedAt: 8, baseHash: 'hash-A' })
      await openTargetFile(openFiles)

      await previewAndFlush()
      openFiles.applyDraftRestore('proj-1', PATH)

      // 活跃签此时是 diff 标签，恢复按路径寻址仍命中原文件签
      expect(openFiles.openFiles.value.find(f => f.path === PATH)!.content).toBe('draft content')
      expect(openFiles.draftOffer.value).toBeNull()
    })
  })

  describe('项目维度', () => {
    it('项目切换清空待决提示（DB 草稿保留，切回重开再探）', async () => {
      vi.mocked(readDraft).mockResolvedValue({ content: 'draft content', savedAt: 5, baseHash: 'hash-A' })
      await openTargetFile(openFiles)
      expect(openFiles.draftOffer.value).not.toBeNull()

      useProjectStore().currentProjectId = 'proj-2'
      await vi.advanceTimersByTimeAsync(0)
      expect(openFiles.draftOffer.value).toBeNull()
    })

    it('项目删除清该项目全部草稿', async () => {
      const { removeProjectDrafts } = await import('@/utils/draftDb')
      const projectStore = useProjectStore()
      projectStore.projects.push({ id: 'proj-9', name: 'x', path: '/x', currentBranch: 'main', valid: true })
      await projectStore.removeProject('proj-9')
      expect(removeProjectDrafts).toHaveBeenCalledWith('proj-9')
    })
  })

  describe('启动陈旧对账（P-20261003-152）', () => {
    /** filePolicy 按路径分流：GONE_PATH 404（AppError，同拦截器抛出形态）、其余放行 */
    function mockExistence(gone: string) {
      vi.mocked(projectApi.filePolicy).mockImplementation(async (_id, path) => {
        if (path === gone) throw new AppError('notFound', 'not found', 404, '/file-policy', 'GET')
        return { data: { kind: 'text' } } as never
      })
    }

    it('文件已删除的草稿批量清账并提示，存活文件草稿保留', async () => {
      const projectStore = useProjectStore()
      projectStore.projects.push({ id: 'proj-1', name: 'x', path: '/x', currentBranch: 'main', valid: true })
      vi.mocked(listFileDrafts).mockResolvedValue([
        { path: '/gone.ts', record: { content: 'orphan', savedAt: 1, baseHash: 'h1' } },
        { path: '/alive.ts', record: { content: 'kept', savedAt: 2, baseHash: 'h2' } },
      ])
      mockExistence('/gone.ts')

      await openFiles.reconcileStaleDrafts()

      expect(removeDrafts).toHaveBeenCalledTimes(1)
      expect(removeDrafts).toHaveBeenCalledWith('proj-1', ['/gone.ts'])
      // 批量清账不走单条 removeDraft（两把钥匙各司其职）
      expect(removeDraft).not.toHaveBeenCalledWith('proj-1', '/gone.ts')
    })

    it('项目路径失效（valid=false）整段跳过：不可达 ≠ 文件被删，不误清任何草稿', async () => {
      const projectStore = useProjectStore()
      projectStore.projects.push({ id: 'proj-1', name: 'x', path: '/x', currentBranch: 'main', valid: false })
      vi.mocked(listFileDrafts).mockResolvedValue([
        { path: '/gone.ts', record: { content: 'orphan', savedAt: 1 } },
      ])

      await openFiles.reconcileStaleDrafts()

      expect(projectApi.filePolicy).not.toHaveBeenCalled()
      expect(removeDrafts).not.toHaveBeenCalled()
    })

    it('探测非 404 失败（网络/服务端异常）保守保留，不清不提示', async () => {
      const projectStore = useProjectStore()
      projectStore.projects.push({ id: 'proj-1', name: 'x', path: '/x', currentBranch: 'main', valid: true })
      vi.mocked(listFileDrafts).mockResolvedValue([
        { path: '/maybe.ts', record: { content: 'unsure', savedAt: 1 } },
      ])
      vi.mocked(projectApi.filePolicy).mockRejectedValue(new AppError('network', 'boom', 0, '/file-policy', 'GET'))

      await openFiles.reconcileStaleDrafts()

      expect(removeDrafts).not.toHaveBeenCalled()
    })

    it('无草稿时不发任何探测请求', async () => {
      const projectStore = useProjectStore()
      projectStore.projects.push({ id: 'proj-1', name: 'x', path: '/x', currentBranch: 'main', valid: true })
      vi.mocked(listFileDrafts).mockResolvedValue([])

      await openFiles.reconcileStaleDrafts()

      expect(projectApi.filePolicy).not.toHaveBeenCalled()
      expect(removeDrafts).not.toHaveBeenCalled()
    })
  })

  describe('远程伪路径草稿（P-20261004-116，P-15 自认边界兑现）', () => {
    const RPATH = 'remote:h1:/tmp/a.txt'

    /** 打开远程伪路径文件：content 端点装载 + 打开探测的微任务链冲刷 */
    async function openRemoteTarget() {
      await openFiles.openFile({ path: RPATH, name: 'a.txt' })
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)
    }

    it('变脏后 2s 落库：固定命名空间键 + baseHash=远端 hash', async () => {
      await openRemoteTarget()
      openFiles.updateContent(RPATH, 'remote edited')
      await vi.advanceTimersByTimeAsync(2000)
      expect(saveDraft).toHaveBeenCalledTimes(1)
      expect(saveDraft).toHaveBeenCalledWith(REMOTE_DRAFT_PROJECT, RPATH, expect.objectContaining({
        content: 'remote edited',
        baseHash: 'rhash-A',
      }))
    })

    it('无选中项目也落库（远程编辑与项目正交，P-15）', async () => {
      useProjectStore().currentProjectId = ''
      await openRemoteTarget()
      openFiles.updateContent(RPATH, 'no project edit')
      await vi.advanceTimersByTimeAsync(2000)
      expect(saveDraft).toHaveBeenCalledWith(REMOTE_DRAFT_PROJECT, RPATH, expect.objectContaining({
        content: 'no project edit',
      }))
    })

    it('打开探测：远端未变（hash 一致）→ 入队提示，offer 带固定命名空间', async () => {
      vi.mocked(readDraft).mockResolvedValue({ content: 'remote draft', savedAt: 1700000000000, baseHash: 'rhash-A' })
      await openRemoteTarget()
      expect(openFiles.draftOffer.value).toEqual(expect.objectContaining({
        projectId: REMOTE_DRAFT_PROJECT, path: RPATH, savedAt: 1700000000000,
      }))
    })

    it('打开探测：远端已前行（hash 不一致）→ 陈旧草稿静默清除', async () => {
      vi.mocked(readDraft).mockResolvedValue({ content: 'stale remote draft', savedAt: 1, baseHash: 'rhash-OLD' })
      await openRemoteTarget()
      expect(openFiles.draftOffer.value).toBeNull()
      expect(removeDraft).toHaveBeenCalledWith(REMOTE_DRAFT_PROJECT, RPATH)
    })

    it('恢复 → 内容回填保持脏态；Ctrl+S 保存回写成功清草稿（路由到同一命名空间）', async () => {
      vi.mocked(readDraft).mockResolvedValue({ content: 'remote draft', savedAt: 10, baseHash: 'rhash-A' })
      await openRemoteTarget()

      openFiles.applyDraftRestore(REMOTE_DRAFT_PROJECT, RPATH)
      const f = openFiles.openFiles.value.find(x => x.path === RPATH)!
      expect(f.content).toBe('remote draft')
      expect(f.originalContent).toBe('remote content') // 保持脏态，远端未动

      await openFiles.saveCurrentFile()
      expect(remoteHostApi.files.writeContent).toHaveBeenCalledTimes(1)
      expect(removeDraft).toHaveBeenCalledWith(REMOTE_DRAFT_PROJECT, RPATH)
    })

    it('项目切换：远程待决提示跨项目保留（与远程签同语义）', async () => {
      vi.mocked(readDraft).mockResolvedValue({ content: 'remote draft', savedAt: 11, baseHash: 'rhash-A' })
      await openRemoteTarget()
      expect(openFiles.draftOffer.value).not.toBeNull()

      useProjectStore().currentProjectId = 'proj-2'
      await vi.advanceTimersByTimeAsync(0)
      expect(openFiles.draftOffer.value).toEqual(expect.objectContaining({ path: RPATH }))
    })

    it('对比预览：右侧经 content 端点现拉远端，开 diff 标签、offer 保留', async () => {
      vi.mocked(readDraft).mockResolvedValue({ content: 'remote draft', savedAt: 12, baseHash: 'rhash-A' })
      await openRemoteTarget()

      await openFiles.previewDraftRestore(REMOTE_DRAFT_PROJECT, RPATH)
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)

      const diff = openFiles.openFiles.value.find(x => x.isDiff)!
      expect(diff).toBeTruthy()
      expect(diff.path).toMatch(/^diff:draft-\d+:wt:remote:h1:\/tmp\/a\.txt$/)
      expect(diff.diffOldContent).toBe('remote draft') // 左 = IndexedDB 草稿
      expect(diff.content).toBe('remote content') // 右 = content 端点现拉远端
      // 只读动作：不消费 offer
      expect(openFiles.draftOffer.value).not.toBeNull()
    })

    it('自动保存不参与（P-15 显式 Ctrl+S 语义保留）：停手到点不回写远端', async () => {
      const { useFontStore } = await import('@/stores/font')
      const fontStore = useFontStore()
      fontStore.editor.autoSave = 'afterDelay'
      fontStore.editor.autoSaveDelayMs = 500
      await openRemoteTarget()
      openFiles.updateContent(RPATH, 'never autosaved')
      await vi.advanceTimersByTimeAsync(5000)
      // 草稿照常落库（防丢底），保存链零触发
      expect(saveDraft).toHaveBeenCalledWith(REMOTE_DRAFT_PROJECT, RPATH, expect.objectContaining({
        content: 'never autosaved',
      }))
      expect(remoteHostApi.files.writeContent).not.toHaveBeenCalled()
    })
  })
})
