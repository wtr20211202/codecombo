import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { reactive, ref, nextTick } from 'vue'

// 全局更新进度徽标（P-20261109-10）组件测试：空闲不渲染；在途显阶段+百分比、
// 点击回版本面板；项目页清开活动栏/状态栏、底部面板打开时抬到面板上沿之上；
// 结局边沿 toast 一次、成功点击刷新提示/失败点击回面板、× 关闭。
// vue-i18n 用 setup.ts 全局 mock（zh 文案直译 + 命名插值），断言直对文案。

vi.mock('naive-ui', async (importOriginal) =>
  (await import('@/__tests__/mocks/naiveRuntime')).mockNaiveUi(await importOriginal()),
)

const routeState = vi.hoisted(() => ({ value: null as null | { path: string } }))
vi.mock('vue-router', () => ({ useRoute: () => routeState.value }))

const layout = vi.hoisted(() => ({ value: null as null | Record<string, { value: unknown }> }))
vi.mock('@/composables/usePanelLayout', () => ({ usePanelLayout: () => layout.value }))

vi.mock('@/api/client', () => ({
  updateApi: { apply: vi.fn(), status: vi.fn(), clearStatus: vi.fn() },
}))
vi.mock('@/stores/lock', () => ({ useLockStore: () => ({ isLocked: true }) }))

const openVersionPanel = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('@/utils/openSettings', () => ({ openVersionPanel }))

import UpdateProgressBadge from '../../components/home/UpdateProgressBadge.vue'
import { useUpdateProgressStore } from '../../stores/updateProgress'
import { messageMock, resetNaiveRuntimeMocks } from '@/__tests__/mocks/naiveRuntime'

function badgeText(wrapper: ReturnType<typeof mount>) {
  return wrapper.find('[data-testid="update-progress-badge-text"]').text()
}

describe('UpdateProgressBadge（P-20261109-10）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetNaiveRuntimeMocks()
    openVersionPanel.mockClear()
    routeState.value = reactive({ path: '/' })
    layout.value = {
      showBottomPanel: ref(false),
      bottomPanelHeight: ref(260),
      bottomPanelMaximized: ref(false),
      bottomPanelEditorMaximized: ref(false),
      terminalMaximized: ref(false),
    }
  })

  it('空闲不渲染', () => {
    const wrapper = mount(UpdateProgressBadge)
    expect(wrapper.find('[data-testid="update-progress-badge"]').exists()).toBe(false)
  })

  it('下载中：阶段 + 百分比，点击回版本面板；无关闭钮', async () => {
    const store = useUpdateProgressStore()
    store.tracking = true
    store.snapshot = { status: 'downloading', progress: 42, total: 100, version: '9.9.9' }
    const wrapper = mount(UpdateProgressBadge)
    await nextTick()
    expect(badgeText(wrapper)).toBe('更新中 · 下载中 42%')
    expect(wrapper.find('[data-testid="update-progress-badge-dismiss"]').exists()).toBe(false)
    await wrapper.find('[data-testid="update-progress-badge-main"]').trigger('click')
    await flushPromises()
    expect(openVersionPanel).toHaveBeenCalledTimes(1)
  })

  it('换包重启窗推断态：无百分比，显推断阶段文案', async () => {
    const store = useUpdateProgressStore()
    store.tracking = true
    store.reconnecting = true
    const wrapper = mount(UpdateProgressBadge)
    await nextTick()
    expect(badgeText(wrapper)).toBe('更新中 · 安装并重启中，等待新版本就绪…')
  })

  it('项目页：清开活动栏与状态栏；底部面板打开时抬到面板上沿之上', async () => {
    routeState.value!.path = '/project'
    const store = useUpdateProgressStore()
    store.tracking = true
    const wrapper = mount(UpdateProgressBadge)
    await nextTick()
    const el = () => wrapper.find('[data-testid="update-progress-badge"]').element as HTMLElement
    expect(el().style.left).toBe('56px')
    expect(el().style.bottom).toBe('32px')
    layout.value!.showBottomPanel!.value = true
    await nextTick()
    expect(el().style.bottom).toBe('292px')
    // 最大化态面板覆盖全屏：不抬升
    layout.value!.bottomPanelMaximized!.value = true
    await nextTick()
    expect(el().style.bottom).toBe('32px')
  })

  it('成功结局：边沿 toast 一次，文案带刷新引导，× 关闭后隐去', async () => {
    const store = useUpdateProgressStore()
    store.tracking = true
    const wrapper = mount(UpdateProgressBadge)
    await nextTick()
    store.tracking = false
    store.outcome = { phase: 'success', version: '9.9.9', error: '', at: '' }
    await nextTick()
    expect(messageMock.success).toHaveBeenCalledTimes(1)
    expect(messageMock.success).toHaveBeenCalledWith('已更新到 v9.9.9')
    expect(badgeText(wrapper)).toBe('已更新到 v9.9.9 · 点击刷新')

    const dismiss = wrapper.find('[data-testid="update-progress-badge-dismiss"]')
    expect(dismiss.attributes('aria-label')).toBe('关闭更新提示')
    await dismiss.trigger('click')
    expect(wrapper.find('[data-testid="update-progress-badge"]').exists()).toBe(false)
    expect(messageMock.success).toHaveBeenCalledTimes(1)
  })

  it('失败结局：error toast，点击回版本面板看原因', async () => {
    const store = useUpdateProgressStore()
    store.tracking = true
    const wrapper = mount(UpdateProgressBadge)
    await nextTick()
    store.tracking = false
    store.outcome = { phase: 'failed', version: '9.9.9', error: 'download failed', at: '' }
    await nextTick()
    expect(messageMock.error).toHaveBeenCalledWith('更新失败')
    expect(badgeText(wrapper)).toBe('更新失败 · 查看原因')
    await wrapper.find('[data-testid="update-progress-badge-main"]').trigger('click')
    await flushPromises()
    expect(openVersionPanel).toHaveBeenCalledTimes(1)
  })
})
