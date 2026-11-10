import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useProjectActions } from '@/composables/useProjectActions'
import { useProjectStore } from '@/stores/project'
import { createPinia, setActivePinia } from 'pinia'

describe('useProjectActions', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  describe('parsePathSegments', () => {
    it('解析路径为 parent 和 prefix', () => {
      const { parsePathSegments } = useProjectActions(() => [])
      const result = parsePathSegments('/home/user/project')
      expect(result).toEqual({ parent: '/home/user', prefix: 'project' })
    })

    it('处理 Windows 反斜杠路径', () => {
      const { parsePathSegments } = useProjectActions(() => [])
      const result = parsePathSegments('C:\\Users\\test')
      expect(result).toEqual({ parent: 'C:/Users', prefix: 'test' })
    })

    it('空字符串或极短输入返回 null', () => {
      const { parsePathSegments } = useProjectActions(() => [])
      expect(parsePathSegments('')).toBeNull()
      expect(parsePathSegments('a')).toBeNull()
    })

    it('无分隔符的路径返回 null', () => {
      const { parsePathSegments } = useProjectActions(() => [])
      expect(parsePathSegments('home')).toBeNull()
    })
  })

  describe('handleAddProject', () => {
    it('空路径返回 false 并显示警告', async () => {
      const { handleAddProject } = useProjectActions(() => [])
      const result = await handleAddProject()
      expect(result).toBe(false)
    })

    it('无项目名时从路径推断', async () => {
      const projectStore = useProjectStore()
      const addSpy = vi.spyOn(projectStore, 'addProject').mockResolvedValue()

      const { handleAddProject, newProjectPath } = useProjectActions(() => [])
      newProjectPath.value = '/home/user/my-project'

      const result = await handleAddProject()
      expect(result).toBe(true)
      expect(addSpy).toHaveBeenCalledWith('my-project', '/home/user/my-project')
    })

    it('addProject 失败时返回 false', async () => {
      const projectStore = useProjectStore()
      vi.spyOn(projectStore, 'addProject').mockRejectedValue(new Error('fail'))

      const { handleAddProject, newProjectPath, newProjectName } = useProjectActions(() => [])
      newProjectPath.value = '/test'
      newProjectName.value = 'test'

      const result = await handleAddProject()
      expect(result).toBe(false)
    })
  })

  describe('openFilesRef 可选', () => {
    it('不传 openFilesRef 时正常构造', () => {
      const actions = useProjectActions()
      expect(actions.showAddModal).toBeDefined()
      expect(actions.showSettingsModal).toBeDefined()
      expect(actions.aheadBehindMap).toBeDefined()
    })
  })

  // 注：formatBytes 用例随 P-20261109-2 死代码清除移除——更新检查/UI 已收敛在
  // VersionPanel.vue，composable 侧不再导出 formatBytes
})
