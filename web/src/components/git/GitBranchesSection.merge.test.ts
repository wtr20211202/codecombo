import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { NDialogProvider, NMessageProvider } from 'naive-ui'

// 合并确认弹层的策略选择链（P-20261007-18 squash merge）：组件级验证
// 「策略单选切换 → 压平消息输入显隐 → merge 载荷契约」——弹层内容是渲染
// 函数读 ref，响应式重渲染是本链路的关键风险面（teleport 到 body，e2e
// 之外的回归保障）。

vi.mock('../../api/client', () => ({
  branchApi: {
    list: vi.fn().mockResolvedValue({
      data: [
        { name: 'master', isCurrent: true, isRemote: false },
        { name: 'feature', isCurrent: false, isRemote: false },
      ],
    }),
    merge: vi.fn().mockResolvedValue({ data: '' }),
  },
  projectApi: { tags: vi.fn().mockResolvedValue({ data: [] }) },
  remoteApi: {},
  tagApi: {},
}))
vi.mock('../../composables/useGitPanelAutoRefresh', () => ({
  useGitPanelAutoRefresh: vi.fn(),
}))
vi.mock('../../composables/useBranchCheckout', () => ({
  useBranchCheckout: () => ({ checkoutBranch: vi.fn() }),
}))

import GitBranchesSection from './GitBranchesSection.vue'
import { branchApi } from '../../api/client'
import { useProjectStore } from '../../stores/project'

const mounted: Array<{ unmount: () => void }> = []

// naive-ui 的 useDialog/useMessage 需要真实渲染在组件树里的 Provider 祖先——
// 用一层包装组件挂 Provider 再渲染被测组件
function mountSection() {
  const Host = defineComponent({
    render() {
      return h(NDialogProvider, () => h(NMessageProvider, () => h(GitBranchesSection, {
        selectedBranch: '',
        collapsedSections: new Set<string>(),
        remoteNames: [],
      })))
    },
  })
  const wrapper = mount(Host, {
    global: {
      stubs: {
        GitCreateBranchModal: true,
        GitUpstreamModal: true,
        GitPushRefModal: true,
        GitMergePreviewModal: true,
        BranchLogPopover: true,
        NDropdown: true,
      },
    },
    attachTo: document.body,
  })
  mounted.push(wrapper)
  return wrapper
}

beforeEach(async () => {
  setActivePinia(createPinia())
  document.body.innerHTML = ''
  vi.mocked(branchApi.merge).mockClear()
  const projectStore = useProjectStore()
  projectStore.currentProjectId = 'p1'
})

afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
  document.body.innerHTML = ''
})

async function openMergeDialog(wrapper: ReturnType<typeof mountSection>) {
  const section = wrapper.findComponent(GitBranchesSection)
  ;(section.vm as unknown as { confirmMergeToCurrent: (s: string) => void }).confirmMergeToCurrent('feature')
  await nextTick()
  const dlg = document.querySelector('[data-testid="merge-confirm-dialog"]')
  expect(dlg).toBeTruthy()
  return dlg as HTMLElement
}

describe('GitBranchesSection 合并确认弹层策略选择', () => {
  it('默认态渲染两策略单选与方向重申，压平消息输入不渲染', async () => {
    const wrapper = mountSection()
    await flushPromises()
    const dlg = await openMergeDialog(wrapper)

    expect(dlg.textContent).toContain('将 feature 合入 master')
    // 行内说明带 {source} 插值（回归防线：漏传插值参数会裸显 {source}）
    expect(dlg.textContent).toContain('保留 feature 的全部提交')
    expect(document.querySelector('[data-testid="merge-strategy-default"]')).toBeTruthy()
    expect(document.querySelector('[data-testid="merge-strategy-squash"]')).toBeTruthy()
    expect(document.querySelector('[data-testid="merge-squash-msg"]')).toBeNull()
  })

  it('选压平合并显示汇总消息输入；确认走 strategy=squash 载荷', async () => {
    const wrapper = mountSection()
    await flushPromises()
    const dlg = await openMergeDialog(wrapper)

    const squashRadio = document.querySelector('[data-testid="merge-strategy-squash"]') as HTMLInputElement
    squashRadio.click()
    await nextTick()

    // data-testid 落在 NInput 透传的根元素上，真实受控的是其内部 textarea
    const inputHost = document.querySelector('[data-testid="merge-squash-msg"]') as HTMLElement | null
    expect(inputHost).toBeTruthy()
    const msgInput = inputHost!.querySelector('textarea, input') as HTMLTextAreaElement
    msgInput.value = 'feat: 自定义汇总'
    msgInput.dispatchEvent(new Event('input'))
    await nextTick()

    ;(document.querySelector('[data-testid="merge-confirm"]') as HTMLButtonElement).click()
    await flushPromises()

    expect(branchApi.merge).toHaveBeenCalledWith('p1', 'feature', 'squash', 'feat: 自定义汇总', { errorLabel: 'branch.mergeFailed' })
    // 注：不在这里断言弹层移出 DOM——jsdom 不触发 transitionend，naive-ui 的
    // leave 过渡永不完成属测试环境伪象；关闭行为由 e2e 真浏览器覆盖
  })

  it('默认策略直接合入：strategy/message 不入载荷（向后兼容形态）', async () => {
    const wrapper = mountSection()
    await flushPromises()
    await openMergeDialog(wrapper)

    ;(document.querySelector('[data-testid="merge-cancel"]') as HTMLButtonElement).click()
    await nextTick()
    expect(branchApi.merge).not.toHaveBeenCalled()

    await openMergeDialog(wrapper)
    ;(document.querySelector('[data-testid="merge-confirm"]') as HTMLButtonElement).click()
    await flushPromises()

    expect(branchApi.merge).toHaveBeenCalledWith('p1', 'feature', undefined, undefined, { errorLabel: 'branch.mergeFailed' })
  })
})
