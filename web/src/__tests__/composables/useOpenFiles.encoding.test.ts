import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useOpenFiles } from '@/composables/useOpenFiles'
import { useThemeStore } from '@/stores/theme'
import { useProjectStore } from '@/stores/project'
import { AppError } from '@/api/error-types'
import { encodingLabel, encodingTestId, FILE_ENCODINGS } from '@/utils/fileEncoding'

// 网络层 mock：readFile 带回磁盘内容 + hash，writeFile 回写新 hash——与后端
// ReadFile/WriteFile 真实响应同形；探测编码经响应 encoding 字段透出（P-7 链路）
vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client')
  return {
    ...actual,
    projectApi: {
      ...actual.projectApi,
      filePolicy: vi.fn().mockRejectedValue(new Error('policy skip')),
      readFile: vi.fn().mockResolvedValue({ data: 'disk content', hash: 'hash-A', encoding: 'gbk' }),
      writeFile: vi.fn().mockResolvedValue({ data: 'ok', hash: 'hash-B' }),
      // 保存成功后 useOpenFiles 会 void fetchStatus 刷新变更计数
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

// 重载放弃未保存修改的确认弹窗：默认用户确认；用例内可改写
vi.mock('@/composables/useDialog', () => ({
  confirmDialog: vi.fn().mockResolvedValue(true),
  promptDialog: vi.fn(),
}))

// setup.ts 的全局 createDiscreteApi mock dialog 只有 create：本文件 409 用例
// 会走 showConflictDialog → dialog.warning，这里按文件覆盖补齐（jsdom 无真实弹窗）
vi.mock('naive-ui', async () => {
  const actual = await vi.importActual<typeof import('naive-ui')>('naive-ui')
  return {
    ...actual,
    createDiscreteApi: vi.fn(() => ({
      message: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
      dialog: { create: vi.fn(), warning: vi.fn(() => ({ destroy: vi.fn() })) },
      notification: { create: vi.fn() },
    })),
  }
})

import { projectApi } from '@/api/client'
import { confirmDialog } from '@/composables/useDialog'

const PATH = '/proj/legacy.txt'

async function openGbkFile(openFiles: ReturnType<typeof useOpenFiles>) {
  await openFiles.openFile({ path: PATH, name: 'legacy.txt' })
  // filePolicy 拒绝 + readFile 就绪的微任务链冲刷
  await vi.advanceTimersByTimeAsync(0)
}

describe('useOpenFiles 编码指示与转码（P-20261002-146）', () => {
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

  describe('reloadFileWithEncoding（重新以指定编码载入）', () => {
    it('干净文件：重读磁盘并以指定编码固化标签', async () => {
      await openGbkFile(openFiles)
      expect(openFiles.currentFile.value?.encoding).toBe('gbk')
      vi.mocked(projectApi.readFile).mockClear()

      await openFiles.reloadFileWithEncoding('utf16le')

      // 重读真实发生（silent 配置）且用户指定覆盖服务端探测
      expect(projectApi.readFile).toHaveBeenCalledWith('proj-1', PATH, { silent: true })
      expect(openFiles.currentFile.value?.content).toBe('disk content')
      expect(openFiles.currentFile.value?.encoding).toBe('utf16le')
      expect(openFiles.currentFile.value?.baseHash).toBe('hash-A')
    })

    it('脏文件 + 确认放弃：重载后回到净态（内存内容对齐磁盘）', async () => {
      await openGbkFile(openFiles)
      openFiles.updateContent(PATH, '本地未保存修改')
      expect(openFiles.hasUnsavedChanges.value).toBe(true)

      await openFiles.reloadFileWithEncoding('gbk')

      expect(confirmDialog).toHaveBeenCalled()
      expect(openFiles.currentFile.value?.content).toBe('disk content')
      expect(openFiles.currentFile.value?.originalContent).toBe('disk content')
      expect(openFiles.hasUnsavedChanges.value).toBe(false)
    })

    it('脏文件 + 取消确认：不动内存内容也不发请求', async () => {
      await openGbkFile(openFiles)
      openFiles.updateContent(PATH, '本地未保存修改')
      vi.mocked(confirmDialog).mockResolvedValueOnce(false)
      vi.mocked(projectApi.readFile).mockClear()

      await openFiles.reloadFileWithEncoding('utf8')

      expect(projectApi.readFile).not.toHaveBeenCalled()
      expect(openFiles.currentFile.value?.content).toBe('本地未保存修改')
      expect(openFiles.currentFile.value?.encoding).toBe('gbk')
    })

    it('diff 伪文件直接忽略（无磁盘对应物）', async () => {
      await openGbkFile(openFiles)
      // 守卫口径验证：isDiff 的 tab 不该触发任何磁盘读取
      const f = openFiles.currentFile.value!
      f.isDiff = true
      vi.mocked(projectApi.readFile).mockClear()

      await openFiles.reloadFileWithEncoding('gbk')

      expect(projectApi.readFile).not.toHaveBeenCalled()
      expect(f.content).toBe('disk content')
    })
  })

  describe('saveFileWithEncoding（转为指定编码保存）', () => {
    it('指定异于当前的编码：按指定编码回传落盘，成功后标签保持', async () => {
      await openGbkFile(openFiles)
      openFiles.updateContent(PATH, '转码后的新内容')

      await openFiles.saveFileWithEncoding('utf8')

      expect(projectApi.writeFile).toHaveBeenCalledWith(
        'proj-1', PATH, '转码后的新内容', { silent: true }, 'utf8', 'hash-A',
      )
      expect(openFiles.currentFile.value?.encoding).toBe('utf8')
      // 保存成功：脏基线对齐
      expect(openFiles.hasUnsavedChanges.value).toBe(false)
    })

    it('指定即当前编码 = 按原编码保存：走既有保存链不转码', async () => {
      await openGbkFile(openFiles)
      openFiles.updateContent(PATH, '原编码内容')

      await openFiles.saveFileWithEncoding('gbk')

      expect(projectApi.writeFile).toHaveBeenCalledWith(
        'proj-1', PATH, '原编码内容', { silent: true }, 'gbk', 'hash-A',
      )
      expect(openFiles.currentFile.value?.encoding).toBe('gbk')
    })

    it('写失败回滚编码标签：内存标签不与磁盘实际编码分叉', async () => {
      await openGbkFile(openFiles)
      vi.mocked(projectApi.writeFile).mockRejectedValueOnce(new Error('disk error'))

      await openFiles.saveFileWithEncoding('big5')

      expect(openFiles.currentFile.value?.encoding).toBe('gbk')
    })

    it('409 冲突回滚编码标签：冲突裁决后重试不误转码', async () => {
      await openGbkFile(openFiles)
      openFiles.updateContent(PATH, '编辑期间文件被外部改写')
      vi.mocked(projectApi.writeFile).mockRejectedValueOnce(
        new AppError('conflict', 'file was modified externally', 409, '/x', 'PUT'),
      )

      await openFiles.saveFileWithEncoding('utf8')

      expect(openFiles.currentFile.value?.encoding).toBe('gbk')
      // 内容保持未保存状态，等用户裁决
      expect(openFiles.hasUnsavedChanges.value).toBe(true)
    })

    it('未指定过编码的 UTF-8 文件转存 GBK：空标签按当前编码比较命中原编码保存', async () => {
      vi.mocked(projectApi.readFile).mockResolvedValue({ data: 'utf8 text', hash: 'hash-U', encoding: '' })
      await openGbkFile(openFiles)
      expect(openFiles.currentFile.value?.encoding).toBe('')

      await openFiles.saveFileWithEncoding('gbk')

      expect(projectApi.writeFile).toHaveBeenCalledWith(
        'proj-1', PATH, 'utf8 text', { silent: true }, 'gbk', 'hash-U',
      )
      expect(openFiles.currentFile.value?.encoding).toBe('gbk')
    })
  })

  describe('编码标签词汇（utils/fileEncoding）', () => {
    it('服务端标签 → 展示名一一对应，未知标签大写兜底', () => {
      expect(encodingLabel('')).toBe('UTF-8')
      expect(encodingLabel('gbk')).toBe('GBK')
      expect(encodingLabel('big5')).toBe('Big5')
      expect(encodingLabel('utf16le')).toBe('UTF-16 LE')
      expect(encodingLabel('utf16be')).toBe('UTF-16 BE')
      expect(encodingLabel(undefined)).toBe('UTF-8')
      expect(encodingLabel('future-enc')).toBe('FUTURE-ENC')
    })

    it('菜单选项与服务端 filepolicy 支持面一致，testid 无空段', () => {
      expect(FILE_ENCODINGS.map(o => o.value)).toEqual(['', 'gbk', 'big5', 'utf16le', 'utf16be'])
      expect(encodingTestId('')).toBe('utf8')
      expect(encodingTestId('gbk')).toBe('gbk')
    })
  })
})
