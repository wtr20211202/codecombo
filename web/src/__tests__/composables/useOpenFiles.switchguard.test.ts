import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { useOpenFiles } from '@/composables/useOpenFiles'
import { useThemeStore } from '@/stores/theme'
import { useProjectStore, registerBeforeProjectSwitchHook } from '@/stores/project'

// 网络层 mock：与 useOpenFiles.draft.test.ts 同形（readFile 固定内容让 tab 装载；
// remoteHostApi 不 mock——远程打开在 jsdom 走离线降级分支，恰好构造「远程脏 tab」）
vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client')
  return {
    ...actual,
    projectApi: {
      ...actual.projectApi,
      filePolicy: vi.fn().mockRejectedValue(new Error('policy skip')),
      readFile: vi.fn().mockResolvedValue({ data: 'file content', hash: 'hash-A' }),
      writeFile: vi.fn().mockResolvedValue({ data: 'ok', hash: 'hash-B' }),
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
  listFileDrafts: vi.fn().mockResolvedValue([]),
  removeDrafts: vi.fn().mockResolvedValue(undefined),
  DRAFT_MAX_CHARS: 2 * 1024 * 1024,
}))

// 切换确认弹窗 mock：默认用户确认切换
vi.mock('@/composables/useDialog', () => ({
  confirmDialog: vi.fn().mockResolvedValue(true),
}))

import { confirmDialog } from '@/composables/useDialog'

describe('useOpenFiles 项目切换守卫（P-20261003-105）', () => {
  let openFiles: ReturnType<typeof useOpenFiles>

  beforeEach(async () => {
    const theme = useThemeStore()
    if (!theme.naiveTheme) {
      // @ts-expect-error: force default
      theme.$state = { currentTheme: 'dark', naiveTheme: undefined, naiveOverrides: undefined }
    }
    const projectStore = useProjectStore()
    projectStore.currentProjectId = 'proj-1'
    // useOpenFiles 装配即注册守卫（openfiles/core）；每例新建实例覆盖注册
    openFiles = useOpenFiles()
    await openFiles.openFile({ path: '/proj/a.ts', name: 'a.ts' })
  })

  afterEach(() => {
    // 还原为同步放行守卫：与无守卫对同步调用方语义一致（同步 true → 同步赋值）
    registerBeforeProjectSwitchHook(() => true)
    vi.clearAllMocks()
  })

  it('干净打开集：同步放行，不弹确认，赋值保持同步', () => {
    const store = useProjectStore()
    const verdict = store.selectProject('proj-2')
    // 同步布尔（非 thenable）：无草稿时深链「切完即开」时序零变化
    expect(verdict).toBe(true)
    expect(store.currentProjectId).toBe('proj-2')
    expect(confirmDialog).not.toHaveBeenCalled()
  })

  it('有脏 tab：弹确认（含 untitled 草稿），确认后切换且清场 watch 生效', async () => {
    const store = useProjectStore()
    openFiles.updateContent('/proj/a.ts', 'edited')
    openFiles.openUntitled()
    openFiles.updateContent('untitled://1', 'scratch')
    await nextTick()

    const verdict = store.selectProject('proj-2')
    // 脏态走异步裁决（确认弹窗）
    expect(confirmDialog).toHaveBeenCalledTimes(1)
    expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }))
    await expect(verdict).resolves.toBe(true)
    expect(store.currentProjectId).toBe('proj-2')
    // 清场 watch 照常：两组打开集清空（远程签保留语义不经此例）
    await nextTick()
    expect(openFiles.openFiles.value).toHaveLength(0)
  })

  it('取消：留在原项目，脏 tab 与内容原样保留', async () => {
    const store = useProjectStore()
    openFiles.updateContent('/proj/a.ts', 'precious edit')
    vi.mocked(confirmDialog).mockResolvedValue(false)

    await expect(store.selectProject('proj-2')).resolves.toBe(false)
    expect(store.currentProjectId).toBe('proj-1')
    expect(openFiles.openFiles.value).toHaveLength(1)
    expect(openFiles.currentFile.value?.content).toBe('precious edit')
  })

  it('远程脏 tab 不计入（跨项目保留）：仅远程脏时同步放行', async () => {
    const store = useProjectStore()
    await openFiles.openFile({ path: 'remote:h1:/x.txt', name: 'x.txt' })
    openFiles.updateContent('remote:h1:/x.txt', 'remote edit')
    expect(openFiles.currentFile.value?.content).toBe('remote edit')

    const verdict = store.selectProject('proj-2')
    expect(confirmDialog).not.toHaveBeenCalled()
    expect(verdict).toBe(true)
    expect(store.currentProjectId).toBe('proj-2')
  })
})
