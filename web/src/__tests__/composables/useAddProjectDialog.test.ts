import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

// Mock useMessage（jsdom 中无 NMessageProvider）
vi.mock('naive-ui', async () => {
  const actual = await vi.importActual('naive-ui')
  return {
    ...(actual as object),
    useMessage: () => ({
      success: vi.fn(),
      error: vi.fn(),
      warning: vi.fn(),
      info: vi.fn(),
    }),
  }
})

// browse/联想已下沉到 usePathBrowse（独立测试）；此处屏蔽真实请求
vi.mock('@/api/client', () => ({
  browseApi: { list: vi.fn().mockResolvedValue({ data: [] }) },
  credentialApi: { list: vi.fn().mockResolvedValue({ data: [] }) },
  sshKeyApi: { list: vi.fn().mockResolvedValue({ data: [] }) },
}))

import { useAddProjectDialog } from '@/composables/useAddProjectDialog'

describe('useAddProjectDialog', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  describe('名称推断', () => {
    it('未手动编辑名称时，按路径末段推断项目名', async () => {
      const dialog = useAddProjectDialog(() => {})
      dialog.nameManuallyEdited.value = false
      dialog.newProjectPath.value = '/home/user/myrepo'
      await nextTick()
      await nextTick()
      expect(dialog.newProjectName.value).toBe('myrepo')
    })

    it('手动编辑过名称后不再自动推断', async () => {
      const dialog = useAddProjectDialog(() => {})
      dialog.nameManuallyEdited.value = true
      dialog.newProjectName.value = 'custom'
      dialog.newProjectPath.value = '/home/user/other'
      await nextTick()
      await nextTick()
      expect(dialog.newProjectName.value).toBe('custom')
    })
  })

  describe('克隆目录 skip 行为', () => {
    it('markCloneDirSelect 标记后，cloneDir 变更不清 cloneDirAutoSet', async () => {
      const dialog = useAddProjectDialog(() => {})
      dialog.cloneDirAutoSet.value = true
      dialog.markCloneDirSelect()
      dialog.cloneDir.value = '/srv/app'
      await nextTick()
      await nextTick()
      expect(dialog.cloneDirAutoSet.value).toBe(true)
    })

    it('未标记时手敲 cloneDir 会清 cloneDirAutoSet', async () => {
      const dialog = useAddProjectDialog(() => {})
      dialog.cloneDirAutoSet.value = true
      dialog.cloneDir.value = '/srv/app'
      await nextTick()
      await nextTick()
      expect(dialog.cloneDirAutoSet.value).toBe(false)
    })
  })

  // 克隆建议（P-20261003-170）：本地 tab 粘贴 GIT_URL → 建议条 → 一键切换预填
  describe('克隆建议', () => {
    // jsdom 无 ClipboardEvent 构造器，Event 挂 clipboardData 假体
    // （onLocalPaste 按 'clipboardData' in e 读取，不依赖事件子类）
    function pasteEvt(text: string): Event {
      const ev = new Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(ev, 'clipboardData', { value: { getData: () => text } })
      return ev
    }

    const GIT_URL = 'https://github.com/user/repo.git'

    it('路径框粘贴 URL → 建议条出现；一键切换：进克隆 tab、预填 URL、推断名称', async () => {
      const dialog = useAddProjectDialog(() => {})
      expect(dialog.addMode.value).toBe('local')
      // 粘贴照常落入输入框（不 preventDefault）——镜像浏览器真实行为
      dialog.newProjectPath.value = GIT_URL
      dialog.onLocalPaste(pasteEvt(GIT_URL), 'path')
      expect(dialog.cloneSuggestVisible.value).toBe(true)

      dialog.acceptCloneSuggest()
      expect(dialog.addMode.value).toBe('clone')
      expect(dialog.cloneUrl.value).toBe(GIT_URL)
      expect(dialog.cloneSuggestVisible.value).toBe(false)
      await nextTick()
      // onCloneUrlBlur 同链路：剥 .git 推断克隆名称
      expect(dialog.cloneName.value).toBe('repo')
      // 来源路径框整格恰为粘贴内容 → 清掉；名称仅推断产物一并回收
      expect(dialog.newProjectPath.value).toBe('')
      expect(dialog.newProjectName.value).toBe('')
    })

    it('本地路径粘贴不触发建议（防误报）', () => {
      const dialog = useAddProjectDialog(() => {})
      dialog.newProjectPath.value = 'D:/workspace/go/my-project'
      dialog.onLocalPaste(pasteEvt('D:/workspace/go/my-project'), 'path')
      expect(dialog.cloneSuggestVisible.value).toBe(false)
      expect(dialog.addMode.value).toBe('local')
    })

    it('忽略后隐藏，再次粘贴重新提示（每次粘贴都是新信号）', () => {
      const dialog = useAddProjectDialog(() => {})
      dialog.onLocalPaste(pasteEvt(GIT_URL), 'path')
      expect(dialog.cloneSuggestVisible.value).toBe(true)
      dialog.dismissCloneSuggest()
      expect(dialog.cloneSuggestVisible.value).toBe(false)
      // 忽略不强制：粘贴内容仍在输入框，用户可继续本地流程
      dialog.onLocalPaste(pasteEvt('git@github.com:user/other.git'), 'path')
      expect(dialog.cloneSuggestVisible.value).toBe(true)
    })

    it('名称框粘贴 URL：切换后清名称并复位手动编辑标记；混排输入不清', () => {
      const dialog = useAddProjectDialog(() => {})
      // 名称框整格粘贴：@update:value 已把手动编辑标记置真（组件真实行为）
      dialog.newProjectName.value = GIT_URL
      dialog.nameManuallyEdited.value = true
      dialog.onLocalPaste(pasteEvt(GIT_URL), 'name')
      expect(dialog.cloneSuggestVisible.value).toBe(true)

      dialog.acceptCloneSuggest()
      expect(dialog.newProjectName.value).toBe('')
      expect(dialog.nameManuallyEdited.value).toBe(false)

      // 混排（用户原有输入 + 粘贴）：只提示，接受切换时不清防误删
      const dialog2 = useAddProjectDialog(() => {})
      dialog2.newProjectPath.value = `D:/old${GIT_URL}`
      dialog2.onLocalPaste(pasteEvt(GIT_URL), 'path')
      dialog2.acceptCloneSuggest()
      expect(dialog2.newProjectPath.value).toBe(`D:/old${GIT_URL}`)
    })
  })
})
