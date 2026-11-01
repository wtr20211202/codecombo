import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { useOpenFiles, type OpenFile } from '@/composables/useOpenFiles'
import { useThemeStore } from '@/stores/theme'
import { useProjectStore } from '@/stores/project'
// 全部保存格式化前置（P-20261004-139）：零依赖注册表直连（编辑器侧实现在
// MonacoEditor，单测里以桩实现代之）
import { registerEditorFormatter, unregisterEditorFormatter } from '@/views/editor/editorFormatters'

// 重开走 openFileByPath → filePolicy/readFile 真链路：mock 掉网络层，
// 策略查询按失败兜底（走旧读取路径），readFile 返回固定内容让 tab 真实加载
vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client')
  return {
    ...actual,
    projectApi: {
      ...actual.projectApi,
      filePolicy: vi.fn().mockRejectedValue(new Error('policy skip')),
      readFile: vi.fn().mockResolvedValue({ data: 'file content' }),
      writeFile: vi.fn().mockResolvedValue({ data: 'ok' }),
      // 保存成功收尾 fetchStatus（变更计数刷新）会触达：空清单即可
      status: vi.fn().mockResolvedValue({ data: [] }),
    },
    // diff 标签快照取数（openDiffView 左右两侧）：断言 index 伪 ref 的底层
    // stage-0 语法映射（P-20261004-42）
    snapshotApi: {
      ...actual.snapshotApi,
      showFile: vi.fn().mockResolvedValue({ data: 'snapshot content' }),
    },
  }
})

describe('useOpenFiles', () => {
  let openFiles: ReturnType<typeof useOpenFiles>

  beforeEach(() => {
    const theme = useThemeStore()
    if (!theme.naiveTheme) {
      // @ts-expect-error: force default
      theme.$state = { currentTheme: 'dark', naiveTheme: undefined, naiveOverrides: undefined }
    }
    openFiles = useOpenFiles()
  })

  describe('openFile', () => {
    it('打开新文件并设为当前', () => {
      openFiles.openFile({ path: '/test/file.ts', name: 'file.ts' })

      expect(openFiles.openFiles.value).toHaveLength(1)
      expect(openFiles.currentFile.value?.path).toBe('/test/file.ts')
      expect(openFiles.activeFileIndex.value).toBe(0)
    })

    it('重复打开已有文件不创建新 tab，切换为当前', () => {
      openFiles.openFile({ path: '/a.ts', name: 'a.ts' })
      openFiles.openFile({ path: '/b.ts', name: 'b.ts' })
      openFiles.openFile({ path: '/a.ts', name: 'a.ts' }) // 重复打开 a

      expect(openFiles.openFiles.value).toHaveLength(2)
      expect(openFiles.currentFile.value?.path).toBe('/a.ts')
    })

    // P-20261004-74 树拖文件到 tab 条按落点插入：openFileInto 尊重 opts.insertAt
    it('insertAt 指定插入位：新签落该下标并激活（树拖按落点插入链）', () => {
      openFiles.openFile({ path: '/a.ts', name: 'a.ts' })
      openFiles.openFile({ path: '/b.ts', name: 'b.ts' })
      openFiles.openFile({ path: '/c.ts', name: 'c.ts' })

      openFiles.openFile({ path: '/d.ts', name: 'd.ts' }, { insertAt: 1 })

      expect(openFiles.openFiles.value.map(f => f.path)).toEqual(['/a.ts', '/d.ts', '/b.ts', '/c.ts'])
      expect(openFiles.currentFile.value?.path).toBe('/d.ts')
    })

    it('insertAt 越界钳到最近合法边界（超长=组尾、负值=队首）；缺省仍组尾', () => {
      openFiles.openFile({ path: '/a.ts', name: 'a.ts' })
      openFiles.openFile({ path: '/b.ts', name: 'b.ts' })

      openFiles.openFile({ path: '/c.ts', name: 'c.ts' }, { insertAt: 99 })
      expect(openFiles.openFiles.value.map(f => f.path)).toEqual(['/a.ts', '/b.ts', '/c.ts'])

      openFiles.openFile({ path: '/d.ts', name: 'd.ts' }, { insertAt: -5 })
      expect(openFiles.openFiles.value.map(f => f.path)).toEqual(['/d.ts', '/a.ts', '/b.ts', '/c.ts'])

      openFiles.openFile({ path: '/e.ts', name: 'e.ts' })
      expect(openFiles.openFiles.value.map(f => f.path)).toEqual(['/d.ts', '/a.ts', '/b.ts', '/c.ts', '/e.ts'])
    })

    it('insertAt 对目标组已开文件仅激活不移动', () => {
      openFiles.openFile({ path: '/a.ts', name: 'a.ts' })
      openFiles.openFile({ path: '/b.ts', name: 'b.ts' })

      openFiles.openFile({ path: '/a.ts', name: 'a.ts' }, { insertAt: 0 })

      expect(openFiles.openFiles.value.map(f => f.path)).toEqual(['/a.ts', '/b.ts'])
      expect(openFiles.currentFile.value?.path).toBe('/a.ts')
    })

    it('insertAt 他组已有文件：共享对象按指定位落组（跨组落点插入）', async () => {
      const projectStore = useProjectStore()
      projectStore.currentProjectId = 'p1'

      await openFiles.openFile({ path: '/a.ts', name: 'a.ts' })
      await openFiles.openFile({ path: '/b.ts', name: 'b.ts' })
      await openFiles.openInSplit({ path: '/c.ts', name: 'c.ts' })
      // b 已在组 0：openInSplit 共享同一对象 → 组 1 = [c, b]
      await openFiles.openInSplit({ path: '/b.ts', name: 'b.ts' })
      expect(openFiles.groups.value[1]!.files.map(f => f.path)).toEqual(['/c.ts', '/b.ts'])

      openFiles.activeGroup.value = 1
      // a 只在组 0（他组共享分支）：按落点插入组 1 下标 1（c 与 b 之间）
      await openFiles.openFile({ path: '/a.ts', name: 'a.ts' }, { insertAt: 1 })

      expect(openFiles.groups.value[1]!.files.map(f => f.path)).toEqual(['/c.ts', '/a.ts', '/b.ts'])
      expect(openFiles.groups.value[1]!.activeIndex).toBe(1)
      // 组 0 清单不动，且持有的仍是同一共享对象
      expect(openFiles.openFiles.value.map(f => f.path)).toEqual(['/a.ts', '/b.ts'])
    })
  })

  describe('closeFile', () => {
    it('关闭文件后相邻文件成为当前', () => {
      openFiles.openFile({ path: '/a.ts', name: 'a.ts' })
      openFiles.openFile({ path: '/b.ts', name: 'b.ts' })
      openFiles.openFile({ path: '/c.ts', name: 'c.ts' })

      openFiles.switchFile(1)
      openFiles.closeFile(1)

      expect(openFiles.openFiles.value).toHaveLength(2)
      expect(openFiles.currentFile.value?.path).toBe('/c.ts')
    })

    it('关闭最后一个文件后前一个成为当前', () => {
      openFiles.openFile({ path: '/a.ts', name: 'a.ts' })
      openFiles.openFile({ path: '/b.ts', name: 'b.ts' })
      openFiles.openFile({ path: '/c.ts', name: 'c.ts' })

      openFiles.closeFile(2)
      expect(openFiles.currentFile.value?.path).toBe('/b.ts')
    })
  })

  describe('dirty 状态', () => {
    it('修改内容后 hasUnsavedChanges 为 true', () => {
      openFiles.openFile({ path: '/a.ts', name: 'a.ts' })
      // updateContent takes path string, not index
      openFiles.updateContent('/a.ts', 'modified')

      expect(openFiles.hasUnsavedChanges.value).toBe(true)
    })

    it('getUnsavedFiles 返回未保存文件', () => {
      openFiles.openFile({ path: '/a.ts', name: 'a.ts' })
      openFiles.openFile({ path: '/b.ts', name: 'b.ts' })

      openFiles.updateContent('/a.ts', 'modified a')
      openFiles.updateContent('/b.ts', 'modified b')

      const unsaved = openFiles.getUnsavedFiles()
      expect(unsaved).toHaveLength(2)
    })
  })

  describe('pin 状态', () => {
    it('togglePinTab 切换固定状态', () => {
      openFiles.openFile({ path: '/a.ts', name: 'a.ts' })
      expect(openFiles.openFiles.value[0]!.pinned).toBeFalsy()

      openFiles.togglePinTab(0)
      expect(openFiles.openFiles.value[0]!.pinned).toBe(true)

      openFiles.togglePinTab(0)
      expect(openFiles.openFiles.value[0]!.pinned).toBe(false)
    })
  })

  describe('批量操作', () => {
    it('closeOtherTabs 保留当前标签', () => {
      openFiles.openFile({ path: '/a.ts', name: 'a.ts' })
      openFiles.openFile({ path: '/b.ts', name: 'b.ts' })
      openFiles.openFile({ path: '/c.ts', name: 'c.ts' })

      openFiles.switchFile(1)
      openFiles.closeOtherTabs(1)

      expect(openFiles.openFiles.value).toHaveLength(1)
      expect(openFiles.openFiles.value[0]!.path).toBe('/b.ts')
    })

    it('closeTabsToRight 关闭右侧标签', () => {
      openFiles.openFile({ path: '/a.ts', name: 'a.ts' })
      openFiles.openFile({ path: '/b.ts', name: 'b.ts' })
      openFiles.openFile({ path: '/c.ts', name: 'c.ts' })

      openFiles.switchFile(0)
      openFiles.closeTabsToRight(0)

      expect(openFiles.openFiles.value).toHaveLength(1)
      expect(openFiles.openFiles.value[0]!.path).toBe('/a.ts')
    })

    it('closeAllTabs 清空所有标签', () => {
      openFiles.openFile({ path: '/a.ts', name: 'a.ts' })
      openFiles.openFile({ path: '/b.ts', name: 'b.ts' })

      openFiles.closeAllTabs()

      expect(openFiles.openFiles.value).toHaveLength(0)
    })
  })

  describe('拖拽排序', () => {
    it('拖拽标签到新位置后顺序正确', () => {
      openFiles.openFile({ path: '/a.ts', name: 'a.ts' })
      openFiles.openFile({ path: '/b.ts', name: 'b.ts' })
      openFiles.openFile({ path: '/c.ts', name: 'c.ts' })

      // 将 a (索引 0) 拖到 c (索引 2) 后面
      openFiles.onTabDragStart(0)

      const mockEvent = { preventDefault: () => {} } as DragEvent
      openFiles.onTabDragOver(mockEvent, 2)
      openFiles.onTabDragEnd()

      expect(openFiles.openFiles.value.map(f => f.path)).toEqual([
        '/b.ts', '/c.ts', '/a.ts',
      ])
    })
  })

  describe('键盘移动活跃标签（P-20261005-201，Alt+Shift+←/→）', () => {
    it('组内 ±1 移动，被移动的活跃签保持激活', () => {
      openFiles.openFile({ path: '/a.ts', name: 'a.ts' })
      openFiles.openFile({ path: '/b.ts', name: 'b.ts' })
      openFiles.openFile({ path: '/c.ts', name: 'c.ts' })

      openFiles.switchFile(2) // 激活 c（组内尾位）
      openFiles.moveActiveTab(-1)
      expect(openFiles.openFiles.value.map(f => f.path)).toEqual(['/a.ts', '/c.ts', '/b.ts'])
      expect(openFiles.activeFileIndex.value).toBe(1) // c 保持激活

      openFiles.moveActiveTab(-1)
      expect(openFiles.openFiles.value.map(f => f.path)).toEqual(['/c.ts', '/a.ts', '/b.ts'])
      expect(openFiles.activeFileIndex.value).toBe(0)

      openFiles.moveActiveTab(1)
      expect(openFiles.openFiles.value.map(f => f.path)).toEqual(['/a.ts', '/c.ts', '/b.ts'])
      expect(openFiles.activeFileIndex.value).toBe(1)
    })

    it('到头静默停：首签再前移 / 尾签再后移均为 no-op（不环绕）', () => {
      openFiles.openFile({ path: '/a.ts', name: 'a.ts' })
      openFiles.openFile({ path: '/b.ts', name: 'b.ts' })

      openFiles.switchFile(0)
      openFiles.moveActiveTab(-1)
      expect(openFiles.openFiles.value.map(f => f.path)).toEqual(['/a.ts', '/b.ts'])

      openFiles.switchFile(1)
      openFiles.moveActiveTab(1)
      expect(openFiles.openFiles.value.map(f => f.path)).toEqual(['/a.ts', '/b.ts'])
    })

    it('作用于活跃组：分屏时另一组不动（跨组不越界）', async () => {
      const projectStore = useProjectStore()
      projectStore.currentProjectId = 'p1'
      await openFiles.openFile({ path: '/a.ts', name: 'a.ts' })
      await openFiles.openInSplit({ path: '/b.ts', name: 'b.ts' })
      await openFiles.openInSplit({ path: '/c.ts', name: 'c.ts' }) // 活跃组 1：[b, c]，当前 c

      openFiles.moveActiveTab(-1)
      expect(openFiles.groups.value[1]!.files.map(f => f.path)).toEqual(['/c.ts', '/b.ts'])
      expect(openFiles.groups.value[0]!.files.map(f => f.path)).toEqual(['/a.ts']) // 组 0 不动
    })
  })

  describe('重新打开已关闭的标签', () => {
    it('关 3 个 → 依序恢复（最近关闭先恢复）→ 栈空后菜单禁用', async () => {
      const projectStore = useProjectStore()
      projectStore.currentProjectId = 'p1'
      for (const p of ['a.ts', 'b.ts', 'c.ts']) {
        await openFiles.openFile({ path: p, name: p })
      }

      await openFiles.closeFile(2)
      await openFiles.closeFile(1)
      await openFiles.closeFile(0)
      expect(openFiles.openFiles.value).toHaveLength(0)
      expect(openFiles.canReopenClosed.value).toBe(true)

      await openFiles.reopenClosedFile() // a.ts 最后关闭，先恢复
      expect(openFiles.openFiles.value.map(f => f.path)).toEqual(['a.ts'])
      await openFiles.reopenClosedFile() // 其次 b.ts
      expect(openFiles.openFiles.value.map(f => f.path)).toEqual(['a.ts', 'b.ts'])
      expect(openFiles.canReopenClosed.value).toBe(true) // 还剩 c.ts

      await openFiles.reopenClosedFile()
      expect(openFiles.canReopenClosed.value).toBe(false) // 栈空 → 菜单项禁用
    })

    it('关闭栈上限 10：最早的记录被挤出', async () => {
      const projectStore = useProjectStore()
      projectStore.currentProjectId = 'p1'
      for (let i = 1; i <= 12; i++) {
        await openFiles.openFile({ path: `f${i}.ts`, name: `f${i}.ts` })
      }
      for (let i = openFiles.openFiles.value.length - 1; i >= 0; i--) {
        await openFiles.closeFile(i)
      }

      await openFiles.reopenClosedFile() // 从右往左关：f1 最后关闭，在栈顶
      expect(openFiles.openFiles.value.map(f => f.path)).toEqual(['f1.ts'])
      let restored = 1
      while (openFiles.canReopenClosed.value) {
        await openFiles.reopenClosedFile()
        restored++
      }
      expect(restored).toBe(10) // f11/f12 已超出上限被丢弃
    })

    it('批量关闭入栈：栈顶 = 最右侧被关标签', async () => {
      const projectStore = useProjectStore()
      projectStore.currentProjectId = 'p1'
      for (const p of ['a.ts', 'b.ts', 'c.ts']) {
        await openFiles.openFile({ path: p, name: p })
      }

      await openFiles.closeAllTabs()
      expect(openFiles.openFiles.value).toHaveLength(0)

      await openFiles.reopenClosedFile()
      expect(openFiles.openFiles.value.map(f => f.path)).toEqual(['c.ts'])
    })

    it('diff 视图不入栈（diff: 伪路径无法按路径重开）', async () => {
      const projectStore = useProjectStore()
      projectStore.currentProjectId = 'p1'
      await openFiles.openDiffView({ path: 'src/a.ts', name: 'a.ts', oldRef: 'clipboard', leftContent: 'x' })

      await openFiles.closeFile(0)
      expect(openFiles.openFiles.value).toHaveLength(0)
      expect(openFiles.canReopenClosed.value).toBe(false)
    })

    it('项目切换清空关闭栈（防跨项目恢复路径）', async () => {
      const projectStore = useProjectStore()
      projectStore.currentProjectId = 'p1'
      await openFiles.openFile({ path: 'a.ts', name: 'a.ts' })
      await openFiles.closeFile(0)
      expect(openFiles.canReopenClosed.value).toBe(true)

      projectStore.currentProjectId = 'p2'
      await nextTick() // 项目切换 watcher 为 flush:pre，等一个微任务再断言
      expect(openFiles.canReopenClosed.value).toBe(false)
    })
  })

  describe('openDiffView leftContent 直供', () => {
    it('内存内容作 diff 左侧：跳过快照取数、标签用 oldLabel', async () => {
      const projectStore = useProjectStore()
      projectStore.currentProjectId = 'p1'

      await openFiles.openDiffView({
        path: 'src/a.ts',
        name: 'a.ts',
        oldRef: 'clipboard',
        leftContent: 'left-text',
        oldLabel: '剪贴板',
      })

      const f = openFiles.currentFile.value
      expect(f?.isDiff).toBe(true)
      expect(f?.path).toBe('diff:clipboard:wt:src/a.ts')
      expect(f?.diffOldContent).toBe('left-text')
      expect(f?.diffOldLabel).toBe('剪贴板')
      expect(f?.loading).toBe(false)
    })

    it('同键去重：已开的剪贴板 diff 就地更新左侧内容而非重复建 tab', async () => {
      const projectStore = useProjectStore()
      projectStore.currentProjectId = 'p1'
      const params = { path: 'src/a.ts', name: 'a.ts', oldRef: 'clipboard', leftContent: 'x' }

      await openFiles.openDiffView(params)
      await openFiles.openDiffView({ ...params, leftContent: 'y' })

      expect(openFiles.openFiles.value).toHaveLength(1)
      expect(openFiles.currentFile.value?.diffOldContent).toBe('y')
    })

    it('index 伪 ref 快照取数映射为底层 stage-0 语法（P-20261004-42）', async () => {
      const projectStore = useProjectStore()
      projectStore.currentProjectId = 'p1'
      const { snapshotApi } = await import('@/api/client')

      // 已暂存行：左=HEAD、右=index（键 diff:HEAD:index:<path>）
      await openFiles.openDiffView({ path: 'src/a.ts', name: 'a.ts', oldRef: 'HEAD', newRef: 'index' })
      expect(openFiles.currentFile.value?.path).toBe('diff:HEAD:index:src/a.ts')
      expect(vi.mocked(snapshotApi.showFile).mock.calls[0]).toEqual(['p1', 'HEAD', 'src/a.ts', { silent: true }])
      expect(vi.mocked(snapshotApi.showFile).mock.calls[1]).toEqual(['p1', ':0', 'src/a.ts', { silent: true }])

      // 未暂存行：左=index、右=工作区 readFile（键 diff:index:wt:<path>）
      vi.mocked(snapshotApi.showFile).mockClear()
      await openFiles.openDiffView({ path: 'src/b.ts', name: 'b.ts', oldRef: 'index' })
      expect(openFiles.currentFile.value?.path).toBe('diff:index:wt:src/b.ts')
      expect(vi.mocked(snapshotApi.showFile).mock.calls[0]).toEqual(['p1', ':0', 'src/b.ts', { silent: true }])
    })
  })

  describe('分屏（双组）', () => {
    it('默认单组兼容：openFile 进组 0，splitOpen 关闭、activeGroup 为 0', async () => {
      const projectStore = useProjectStore()
      projectStore.currentProjectId = 'p1'

      await openFiles.openFile({ path: '/a.ts', name: 'a.ts' })

      expect(openFiles.splitOpen.value).toBe(false)
      expect(openFiles.activeGroup.value).toBe(0)
      expect(openFiles.openFiles.value.map(f => f.path)).toEqual(['/a.ts'])
      expect(openFiles.groups.value[1]!.files).toHaveLength(0)
    })

    it('openInSplit 新文件进组 1 并置 splitOpen/activeGroup', async () => {
      const projectStore = useProjectStore()
      projectStore.currentProjectId = 'p1'

      await openFiles.openFile({ path: '/a.ts', name: 'a.ts' })
      await openFiles.openInSplit({ path: '/b.ts', name: 'b.ts' })

      expect(openFiles.splitOpen.value).toBe(true)
      expect(openFiles.activeGroup.value).toBe(1)
      expect(openFiles.groups.value[1]!.files.map(f => f.path)).toEqual(['/b.ts'])
      expect(openFiles.groups.value[1]!.activeIndex).toBe(0)
      expect(openFiles.currentFile.value?.path).toBe('/b.ts') // currentFile 跟随活跃组
      // 组 0 不受影响
      expect(openFiles.openFiles.value.map(f => f.path)).toEqual(['/a.ts'])
    })

    it('openInSplit 组 0 已有同路径：共享同一对象（内容/脏态同步）', async () => {
      const projectStore = useProjectStore()
      projectStore.currentProjectId = 'p1'

      await openFiles.openFile({ path: '/a.ts', name: 'a.ts' })
      await openFiles.openInSplit({ path: '/a.ts', name: 'a.ts' })

      const g0File = openFiles.groups.value[0]!.files[0]
      const g1File = openFiles.groups.value[1]!.files[0]
      expect(g1File).toBe(g0File) // 同一对象引用
      openFiles.updateContent('/a.ts', 'edited')
      expect(g0File!.content).toBe('edited')
      expect(g1File!.content).toBe('edited')
    })

    it('openInSplit 已在组 1：激活不重复建签', async () => {
      const projectStore = useProjectStore()
      projectStore.currentProjectId = 'p1'

      await openFiles.openInSplit({ path: '/b.ts', name: 'b.ts' })
      await openFiles.openInSplit({ path: '/c.ts', name: 'c.ts' })
      await openFiles.openInSplit({ path: '/b.ts', name: 'b.ts' })

      expect(openFiles.groups.value[1]!.files.map(f => f.path)).toEqual(['/b.ts', '/c.ts'])
      expect(openFiles.groups.value[1]!.activeIndex).toBe(0)
    })

    it('closeSplit：组 1 独有文件并回组 0 尾部，共享对象不重复', async () => {
      const projectStore = useProjectStore()
      projectStore.currentProjectId = 'p1'

      await openFiles.openFile({ path: '/a.ts', name: 'a.ts' })
      await openFiles.openInSplit({ path: '/a.ts', name: 'a.ts' }) // 共享
      await openFiles.openInSplit({ path: '/b.ts', name: 'b.ts' }) // 组 1 独有

      openFiles.closeSplit()

      expect(openFiles.splitOpen.value).toBe(false)
      expect(openFiles.activeGroup.value).toBe(0)
      expect(openFiles.groups.value[1]!.files).toHaveLength(0)
      // a 是共享对象已在组 0：跳过；b 并回尾部
      expect(openFiles.openFiles.value.map(f => f.path)).toEqual(['/a.ts', '/b.ts'])
    })

    it('关闭组 1 最后一签自动收分屏（组空即收组）', async () => {
      const projectStore = useProjectStore()
      projectStore.currentProjectId = 'p1'

      await openFiles.openFile({ path: '/a.ts', name: 'a.ts' })
      await openFiles.openInSplit({ path: '/b.ts', name: 'b.ts' })

      await openFiles.closeFileInGroup(1, 0)

      expect(openFiles.splitOpen.value).toBe(false)
      expect(openFiles.activeGroup.value).toBe(0)
      expect(openFiles.groups.value[1]!.files).toHaveLength(0)
    })

    it('关闭他组共享的文件：另一组标签保留、不入关闭栈', async () => {
      const projectStore = useProjectStore()
      projectStore.currentProjectId = 'p1'

      await openFiles.openFile({ path: '/a.ts', name: 'a.ts' })
      await openFiles.openInSplit({ path: '/a.ts', name: 'a.ts' })

      await openFiles.closeFileInGroup(0, 0) // 关组 0 的 a（组 1 仍开着）

      expect(openFiles.groups.value[0]!.files).toHaveLength(0)
      expect(openFiles.groups.value[1]!.files.map(f => f.path)).toEqual(['/a.ts'])
      expect(openFiles.canReopenClosed.value).toBe(false) // 还开着，不算关闭
      openFiles.closeSplit() // 组 0 空：并回组 1 的 a，无丢失
      expect(openFiles.openFiles.value.map(f => f.path)).toEqual(['/a.ts'])
    })

    it('hasUnsavedChanges 覆盖组 1；getUnsavedFiles 去重共享对象', async () => {
      const projectStore = useProjectStore()
      projectStore.currentProjectId = 'p1'

      await openFiles.openFile({ path: '/a.ts', name: 'a.ts' })
      await openFiles.openInSplit({ path: '/b.ts', name: 'b.ts' })

      expect(openFiles.hasUnsavedChanges.value).toBe(false)
      openFiles.updateContent('/b.ts', 'dirty in split')
      expect(openFiles.hasUnsavedChanges.value).toBe(true)

      await openFiles.openInSplit({ path: '/a.ts', name: 'a.ts' }) // 共享对象
      openFiles.updateContent('/a.ts', 'dirty shared')
      const unsaved = openFiles.getUnsavedFiles()
      expect(unsaved.map(f => f.path).sort()).toEqual(['/a.ts', '/b.ts']) // 共享对象只计一次
    })

    it('项目切换清空两组并复位分屏', async () => {
      const projectStore = useProjectStore()
      projectStore.currentProjectId = 'p1'
      await openFiles.openFile({ path: '/a.ts', name: 'a.ts' })
      await openFiles.openInSplit({ path: '/b.ts', name: 'b.ts' })
      expect(openFiles.splitOpen.value).toBe(true)

      projectStore.currentProjectId = 'p2'
      await nextTick()

      expect(openFiles.openFiles.value).toHaveLength(0)
      expect(openFiles.groups.value[1]!.files).toHaveLength(0)
      expect(openFiles.splitOpen.value).toBe(false)
      expect(openFiles.activeGroup.value).toBe(0)
    })

    it('cycleActiveTab / closeActiveGroupTab 作用于活跃组', async () => {
      const projectStore = useProjectStore()
      projectStore.currentProjectId = 'p1'

      await openFiles.openFile({ path: '/a.ts', name: 'a.ts' })
      await openFiles.openInSplit({ path: '/b.ts', name: 'b.ts' })
      await openFiles.openInSplit({ path: '/c.ts', name: 'c.ts' }) // 活跃组 1：[b, c]，当前 c

      openFiles.cycleActiveTab(1)
      expect(openFiles.groups.value[1]!.activeIndex).toBe(0) // c → b
      expect(openFiles.groups.value[0]!.activeIndex).toBe(0) // 组 0 不动

      openFiles.closeActiveGroupTab() // 关活跃组（组 1）当前 b
      expect(openFiles.groups.value[1]!.files.map(f => f.path)).toEqual(['/c.ts'])
      expect(openFiles.openFiles.value.map(f => f.path)).toEqual(['/a.ts']) // 组 0 不动
    })

    it('toggleSplit（P-20261002-93）：无分屏以当前文件开右侧分屏，再按关闭并回组 0', async () => {
      const projectStore = useProjectStore()
      projectStore.currentProjectId = 'p1'

      await openFiles.openFile({ path: '/a.ts', name: 'a.ts' })
      expect(openFiles.splitOpen.value).toBe(false)

      await openFiles.toggleSplit() // Ctrl+\ 开：当前文件进组 1
      expect(openFiles.splitOpen.value).toBe(true)
      expect(openFiles.activeGroup.value).toBe(1)
      expect(openFiles.groups.value[1]!.files.map(f => f.path)).toEqual(['/a.ts']) // 共享对象
      expect(openFiles.openFiles.value.map(f => f.path)).toEqual(['/a.ts']) // 组 0 原样

      await openFiles.toggleSplit() // 再按关：并回组 0
      expect(openFiles.splitOpen.value).toBe(false)
      expect(openFiles.activeGroup.value).toBe(0)
      expect(openFiles.openFiles.value.map(f => f.path)).toEqual(['/a.ts']) // 不重复
    })

    it('toggleSplit 无活跃文件（欢迎页）时 no-op；focusOtherGroup 未分屏时 no-op', async () => {
      const projectStore = useProjectStore()
      projectStore.currentProjectId = 'p1'

      await openFiles.toggleSplit()
      expect(openFiles.splitOpen.value).toBe(false)

      openFiles.focusOtherGroup() // 未分屏：活跃组不指到不可见空组
      expect(openFiles.activeGroup.value).toBe(0)
    })

    it('focusOtherGroup 分屏时 0<->1 互切，组内激活态不受影响', async () => {
      const projectStore = useProjectStore()
      projectStore.currentProjectId = 'p1'

      await openFiles.openFile({ path: '/a.ts', name: 'a.ts' })
      await openFiles.toggleSplit()
      expect(openFiles.activeGroup.value).toBe(1)

      openFiles.focusOtherGroup() // Ctrl+Shift+\ → 组 0
      expect(openFiles.activeGroup.value).toBe(0)
      expect(openFiles.currentFile.value?.path).toBe('/a.ts')
      openFiles.focusOtherGroup() // → 组 1
      expect(openFiles.activeGroup.value).toBe(1)
      expect(openFiles.currentFile.value?.path).toBe('/a.ts')
      expect(openFiles.splitOpen.value).toBe(true) // 切组不动分屏开合
    })

    it('restoreSplitFromPaths（P-20261002-94）：按序批量开进组 1，活跃位按 activeFile 落，焦点不动', async () => {
      const projectStore = useProjectStore()
      projectStore.currentProjectId = 'p1'

      await openFiles.restoreSplitFromPaths(['/b.ts', '/c.ts'], '/c.ts')

      expect(openFiles.splitOpen.value).toBe(true)
      expect(openFiles.groups.value[1]!.files.map(f => f.path)).toEqual(['/b.ts', '/c.ts'])
      expect(openFiles.groups.value[1]!.activeIndex).toBe(1)
      expect(openFiles.activeGroup.value).toBe(0) // 现场还原不动焦点（与开合恢复语义一致）
      // 共享对象：主组已开的同路径文件开进分屏组不重复加载
      await openFiles.openFile({ path: '/a.ts', name: 'a.ts' })
      await openFiles.restoreSplitFromPaths(['/a.ts', '/b.ts'], '')
      expect(openFiles.groups.value[1]!.files.map(f => f.path)).toEqual(['/b.ts', '/c.ts', '/a.ts'])
    })

    it('restoreSplitFromPaths 空清单 no-op：不置 splitOpen', async () => {
      await openFiles.restoreSplitFromPaths([], '')
      expect(openFiles.splitOpen.value).toBe(false)
    })

    it('restoreSplitFromPaths 已删文件降级：静默跳过，活跃位指向不可恢复文件时保持最后打开位', async () => {
      const projectStore = useProjectStore()
      projectStore.currentProjectId = 'p1'
      const { projectApi } = await import('@/api/client')
      // /gone.ts 读取失败（已删）：占位摘除、不抛出给调用方（恢复链只计数）
      vi.mocked(projectApi.readFile).mockImplementation(async (_id: string, path: string) => {
        if (path === '/gone.ts') throw Object.assign(new Error('404'), { userMessage: 'x' })
        return { data: 'content' } as any
      })

      await openFiles.restoreSplitFromPaths(['/ok.ts', '/gone.ts'], '/gone.ts')

      expect(openFiles.groups.value[1]!.files.map(f => f.path)).toEqual(['/ok.ts'])
      expect(openFiles.groups.value[1]!.activeIndex).toBe(0)
      vi.mocked(projectApi.readFile).mockResolvedValue({ data: 'file content' } as any)
    })
  })

  describe('preview 标签（P-20261002-50）', () => {
    beforeEach(() => {
      useProjectStore().currentProjectId = 'p1'
    })

    it('预览类来源打开为预览 tab，再开另一文件复用同一预览位', async () => {
      await openFiles.openFile({ path: '/a.ts', name: 'a.ts' }, { preview: true })
      expect(openFiles.openFiles.value).toHaveLength(1)
      expect(openFiles.openFiles.value[0]!.isPreview).toBe(true)

      await openFiles.openFile({ path: '/b.ts', name: 'b.ts' }, { preview: true })
      // 单预览位被替换而非堆积
      expect(openFiles.openFiles.value).toHaveLength(1)
      expect(openFiles.openFiles.value[0]!.path).toBe('/b.ts')
      expect(openFiles.openFiles.value[0]!.isPreview).toBe(true)
      expect(openFiles.currentFile.value?.path).toBe('/b.ts')
    })

    it('编辑即转正：转正后不再被复用，新预览位另开', async () => {
      await openFiles.openFile({ path: '/a.ts', name: 'a.ts' }, { preview: true })
      openFiles.updateContent('/a.ts', 'dirty')
      expect(openFiles.openFiles.value[0]!.isPreview).toBe(false)

      await openFiles.openFile({ path: '/b.ts', name: 'b.ts' }, { preview: true })
      expect(openFiles.openFiles.value).toHaveLength(2)
      expect(openFiles.openFiles.value[0]!.path).toBe('/a.ts')
      expect(openFiles.openFiles.value[0]!.isPreview).toBe(false)
      expect(openFiles.openFiles.value[1]!.isPreview).toBe(true)
    })

    it('手动 pin 预览 tab 即转正（双击走同一 togglePin 链）', async () => {
      await openFiles.openFile({ path: '/a.ts', name: 'a.ts' }, { preview: true })
      openFiles.togglePinTab(0)
      expect(openFiles.openFiles.value[0]!.pinned).toBe(true)
      expect(openFiles.openFiles.value[0]!.isPreview).toBe(false)
    })

    it('普通来源（文件树等）不置预览位、也不复用既有预览位', async () => {
      await openFiles.openFile({ path: '/a.ts', name: 'a.ts' }, { preview: true })
      await openFiles.openFile({ path: '/b.ts', name: 'b.ts' })
      expect(openFiles.openFiles.value).toHaveLength(2)
      expect(openFiles.openFiles.value[1]!.isPreview).toBeFalsy()
      expect(openFiles.openFiles.value[0]!.isPreview).toBe(true)
    })

    it('loading 中的预览位可复用，迟到的读取响应按 path 守卫丢弃', async () => {
      const { projectApi } = await import('@/api/client')
      let resolveA!: (v: { data: string }) => void
      let resolveB!: (v: { data: string }) => void
      const pendingA = new Promise<{ data: string }>(r => { resolveA = r })
      const pendingB = new Promise<{ data: string }>(r => { resolveB = r })
      vi.mocked(projectApi.readFile).mockImplementation(((_pid: string, p: string) =>
        p === '/a.ts' ? pendingA : pendingB) as typeof projectApi.readFile)

      try {
        const pa = openFiles.openFile({ path: '/a.ts', name: 'a.ts' }, { preview: true })
        const pb = openFiles.openFile({ path: '/b.ts', name: 'b.ts' }, { preview: true })
        // B 换装 A 的 loading 占位；随后 B 先落地、A 迟到
        resolveB({ data: 'bbb' })
        resolveA({ data: 'aaa' })
        await Promise.all([pa, pb])
        await nextTick()

        expect(openFiles.openFiles.value).toHaveLength(1)
        expect(openFiles.openFiles.value[0]!.path).toBe('/b.ts')
        expect(openFiles.openFiles.value[0]!.content).toBe('bbb')
        expect(openFiles.openFiles.value[0]!.loading).toBe(false)
      } finally {
        vi.mocked(projectApi.readFile).mockReset()
        vi.mocked(projectApi.readFile).mockResolvedValue({ data: 'file content' })
      }
    })
  })

  describe('跨组移动/复制标签（P-20261003-38）', () => {
    beforeEach(() => {
      useProjectStore().currentProjectId = 'p1'
    })

    it('moveTabToGroup 组1→组0：同一对象迁组（脏态延续）、源组收组、不入关闭栈', async () => {
      await openFiles.openFile({ path: '/a.ts', name: 'a.ts' })
      await openFiles.openInSplit({ path: '/b.ts', name: 'b.ts' })
      const b = openFiles.groups.value[1]!.files[0]!
      b.content = 'dirty b' // 制造未保存脏态：移动不允许触发内容重载

      await openFiles.moveTabToGroup(1, '/b.ts', 0)

      expect(openFiles.groups.value[1]!.files).toHaveLength(0)
      expect(openFiles.splitOpen.value).toBe(false) // 组 1 搬空即收组（既有规则）
      expect(openFiles.groups.value[0]!.files.map(f => f.path)).toEqual(['/a.ts', '/b.ts'])
      const back = openFiles.groups.value[0]!.files[1]!
      expect(back).toBe(b) // 同一 OpenFile 对象（内容/undo 不经重载）
      expect(back.content).toBe('dirty b')
      expect(openFiles.activeGroup.value).toBe(0)
      expect(openFiles.canReopenClosed.value).toBe(false) // 移动不是关闭：不入栈
    })

    it('moveTabToGroup 组0→组1：源组摘签、目标组激活、activeGroup 跟随', async () => {
      await openFiles.openFile({ path: '/a.ts', name: 'a.ts' })
      await openFiles.openFile({ path: '/b.ts', name: 'b.ts' })
      await openFiles.openInSplit({ path: '/c.ts', name: 'c.ts' }) // 组 1 = [c]

      await openFiles.moveTabToGroup(0, '/a.ts', 1)

      expect(openFiles.groups.value[0]!.files.map(f => f.path)).toEqual(['/b.ts'])
      expect(openFiles.groups.value[1]!.files.map(f => f.path)).toEqual(['/c.ts', '/a.ts'])
      expect(openFiles.activeGroup.value).toBe(1)
      expect(openFiles.splitOpen.value).toBe(true) // 组 0 不空、分屏不动
    })

    it('moveTabToGroup copy=true：共享对象两组成签，源组保留', async () => {
      await openFiles.openFile({ path: '/a.ts', name: 'a.ts' })
      await openFiles.openFile({ path: '/b.ts', name: 'b.ts' })
      await openFiles.openInSplit({ path: '/b.ts', name: 'b.ts' }) // 组 1 = [b 共享]

      await openFiles.moveTabToGroup(0, '/a.ts', 1, true)

      expect(openFiles.groups.value[0]!.files.map(f => f.path)).toEqual(['/a.ts', '/b.ts']) // 原样
      expect(openFiles.groups.value[1]!.files.map(f => f.path)).toEqual(['/b.ts', '/a.ts'])
      expect(openFiles.groups.value[1]!.files[1]).toBe(openFiles.groups.value[0]!.files[0]) // 共享对象
      expect(openFiles.activeGroup.value).toBe(1)
    })

    it('moveTabToGroup 同组/未知路径 no-op', async () => {
      await openFiles.openFile({ path: '/a.ts', name: 'a.ts' })
      await openFiles.openInSplit({ path: '/b.ts', name: 'b.ts' })

      await openFiles.moveTabToGroup(0, '/a.ts', 0) // 同组：重排语义不归本函数
      await openFiles.moveTabToGroup(1, '/missing.ts', 0)

      expect(openFiles.groups.value[0]!.files.map(f => f.path)).toEqual(['/a.ts'])
      expect(openFiles.groups.value[1]!.files.map(f => f.path)).toEqual(['/b.ts'])
      expect(openFiles.splitOpen.value).toBe(true)
    })
  })

  describe('saveAllFiles（P-20261002-101 全部保存）', () => {
    /** 单测只重排 writeFile 行为，收尾统一还原模块级默认 mock（mockResolvedValue 'ok'） */
    async function stubWriteFile(impl: (pid: string, p: string) => Promise<unknown>) {
      const { projectApi } = await import('@/api/client')
      vi.mocked(projectApi.writeFile).mockImplementation(
        ((pid: string, p: string) => impl(pid, p)) as typeof projectApi.writeFile,
      )
      return projectApi
    }

    it('脏清单串行逐个保存：干净文件不进清单，保存后脏位清零', async () => {
      useProjectStore().currentProjectId = 'p1'
      await openFiles.openFile({ path: '/a.ts', name: 'a.ts' })
      await openFiles.openFile({ path: '/b.ts', name: 'b.ts' })
      await openFiles.openFile({ path: '/c.ts', name: 'c.ts' }) // 干净文件：不在未保存清单
      openFiles.updateContent('/a.ts', 'dirty a')
      openFiles.updateContent('/b.ts', 'dirty b')

      const written: string[] = []
      const projectApi = await stubWriteFile(async (_pid, p) => {
        written.push(p)
        return { data: 'ok' }
      })

      const r = await openFiles.saveAllFiles()
      expect(r).toEqual({ saved: 2, failed: 0 })
      expect(written).toEqual(['/a.ts', '/b.ts']) // 清单序即保存序，干净文件不写
      expect(openFiles.getUnsavedFiles()).toHaveLength(0)

      vi.mocked(projectApi.writeFile).mockReset()
      vi.mocked(projectApi.writeFile).mockResolvedValue({ data: 'ok' })
    })

    it('失败累积继续下一个：中间文件写失败保持脏位，其余照常落盘', async () => {
      useProjectStore().currentProjectId = 'p1'
      await openFiles.openFile({ path: '/a.ts', name: 'a.ts' })
      await openFiles.openFile({ path: '/b.ts', name: 'b.ts' })
      await openFiles.openFile({ path: '/c.ts', name: 'c.ts' })
      openFiles.updateContent('/a.ts', 'dirty a')
      openFiles.updateContent('/b.ts', 'dirty b')
      openFiles.updateContent('/c.ts', 'dirty c')

      const projectApi = await stubWriteFile(async (_pid, p) => {
        if (p === '/b.ts') throw new Error('disk full')
        return { data: 'ok' }
      })

      const r = await openFiles.saveAllFiles()
      expect(r).toEqual({ saved: 2, failed: 1 })
      // 失败不打断链条：三个脏文件都发起了写请求
      expect(projectApi.writeFile).toHaveBeenCalledTimes(3)
      // 失败的 b 保持脏位可再次触发补存；a/c 已对齐
      expect(openFiles.getUnsavedFiles().map(f => f.path)).toEqual(['/b.ts'])

      vi.mocked(projectApi.writeFile).mockReset()
      vi.mocked(projectApi.writeFile).mockResolvedValue({ data: 'ok' })
    })

    it('无脏文件时零写请求直接返回（不弹汇总 toast）', async () => {
      useProjectStore().currentProjectId = 'p1'
      await openFiles.openFile({ path: '/a.ts', name: 'a.ts' })
      const projectApi = await stubWriteFile(async () => ({ data: 'ok' }))

      const r = await openFiles.saveAllFiles()
      expect(r).toEqual({ saved: 0, failed: 0 })
      expect(projectApi.writeFile).not.toHaveBeenCalled()

      vi.mocked(projectApi.writeFile).mockReset()
      vi.mocked(projectApi.writeFile).mockResolvedValue({ data: 'ok' })
    })

    it('格式化前置（P-20261004-139）：在册路径保存前先查表格式化，未注册路径直接保存', async () => {
      useProjectStore().currentProjectId = 'p1'
      await openFiles.openFile({ path: '/fmt.json', name: 'fmt.json' })
      await openFiles.openFile({ path: '/plain.txt', name: 'plain.txt' })
      openFiles.updateContent('/fmt.json', 'dirty fmt')
      openFiles.updateContent('/plain.txt', 'dirty plain')

      const order: string[] = []
      const fmt = vi.fn(async () => { order.push('format:/fmt.json') })
      registerEditorFormatter('/fmt.json', fmt)
      const projectApi = await stubWriteFile(async (_pid, p) => {
        order.push(`write:${p}`)
        return { data: 'ok' }
      })

      try {
        const r = await openFiles.saveAllFiles()
        expect(r).toEqual({ saved: 2, failed: 0 })
        // 清单序串行：fmt 格式化 → fmt 落盘 → plain 无注册 no-op 直接落盘
        expect(order).toEqual(['format:/fmt.json', 'write:/fmt.json', 'write:/plain.txt'])
      } finally {
        unregisterEditorFormatter('/fmt.json', fmt)
        vi.mocked(projectApi.writeFile).mockReset()
        vi.mocked(projectApi.writeFile).mockResolvedValue({ data: 'ok' })
      }
    })
  })
})
