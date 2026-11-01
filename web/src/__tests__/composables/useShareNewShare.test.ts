import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { messageMock, resetNaiveRuntimeMocks } from '@/__tests__/mocks/naiveRuntime'

// 分享管理器「新建分享」CTA（P-20261020-8）：有项目 → 打开文件树回根并聚焦；
// 无项目 → 提示先开项目且不派发。naive-ui/vue-i18n 走公共 mock 工厂
// （P-20261007-5，断言按 key 不按文案）。
vi.mock('naive-ui', async (importOriginal) =>
  (await import('@/__tests__/mocks/naiveRuntime')).mockNaiveUi(await importOriginal()))
vi.mock('vue-i18n', async (importOriginal) =>
  (await import('@/__tests__/mocks/naiveRuntime')).mockVueI18n(await importOriginal()))

import { useShareNewShare } from '@/composables/useShareNewShare'
import { useProjectStore, type Project } from '@/stores/project'
import { usePanelLayout } from '@/composables/usePanelLayout'
import { OPS_LOCATE_IN_TREE, type LocateInTreeDetail } from '@/utils/opsEvents'
import { withSetup } from '@/__tests__/mocks/withSetup'

function seedProject(): void {
  const project = useProjectStore()
  project.projects = [{
    id: 'p1',
    name: 'P1',
    path: '/repo',
    currentBranch: '',
    remoteURL: '',
    valid: true,
  } satisfies Project]
  project.currentProjectId = 'p1'
}

beforeEach(() => {
  setActivePinia(createPinia())
  resetNaiveRuntimeMocks()
})

describe('useShareNewShare', () => {
  it('无当前项目：提示先打开项目，不派发树定位', async () => {
    const dispatch = vi.spyOn(window, 'dispatchEvent')
    const { result, app } = withSetup(() => useShareNewShare())
    const ok = await result.startNewShare()
    expect(ok).toBe(false)
    expect(messageMock.warning).toHaveBeenCalledWith('share.newShare.noProject')
    expect(dispatch).not.toHaveBeenCalled()
    app.unmount()
    dispatch.mockRestore()
  })

  it('有项目：切回 files 视图并派发项目根定位 + 聚焦', async () => {
    seedProject()
    const layout = usePanelLayout()
    layout.sideView.value = 'todos'
    const dispatch = vi.spyOn(window, 'dispatchEvent')
    const { result, app } = withSetup(() => useShareNewShare())
    const ok = await result.startNewShare()
    expect(ok).toBe(true)
    expect(messageMock.warning).not.toHaveBeenCalled()
    expect(layout.sideView.value).toBe('files')
    expect(dispatch).toHaveBeenCalledTimes(1)
    const ev = dispatch.mock.calls[0]![0] as CustomEvent<LocateInTreeDetail>
    expect(ev.type).toBe(OPS_LOCATE_IN_TREE)
    // 空路径 = 项目根；focus = 落点后把键盘焦点交给树
    expect(ev.detail).toEqual({ path: '', projectId: 'p1', focus: true })
    app.unmount()
    dispatch.mockRestore()
  })
})
