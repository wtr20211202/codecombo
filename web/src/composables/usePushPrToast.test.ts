import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { VNode } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

// naive-ui / vue-i18n 走一站式 mock 工厂（P-20261007-5）：message 记录器 + t=key
// 直通（断言按 key），与 useBranchCheckout 三件同款样板
vi.mock('naive-ui', async (importOriginal) =>
  (await import('@/__tests__/mocks/naiveRuntime')).mockNaiveUi(await importOriginal()),
)
vi.mock('vue-i18n', async (importOriginal) =>
  (await import('@/__tests__/mocks/naiveRuntime')).mockVueI18n(await importOriginal()),
)

vi.mock('../api/client', () => ({
  prApi: {
    create: vi.fn().mockResolvedValue({
      data: { url: 'https://gitea.example/o/r/compare/main...feat', platform: 'gitea' },
    }),
  },
}))

import { usePushPrToast, pushToastOffersCreatePr } from './usePushPrToast'
import { prApi } from '../api/client'
import { useProjectStore } from '../stores/project'
import { messageMock, resetNaiveRuntimeMocks } from '@/__tests__/mocks/naiveRuntime'
import { withSetup } from '@/__tests__/mocks/withSetup'

/** 从 message.success 的渲染函数提取按钮 VNode（toastPushSuccess 附「创建 PR」
 *  按钮形态），无按钮（裸文案调用）返回 undefined */
function prButtonOf(successArg: unknown): (VNode & { props: Record<string, unknown> }) | undefined {
  if (typeof successArg !== 'function') return undefined
  const vnode = (successArg as () => VNode)()
  const children = vnode.children as VNode[]
  const btn = children.find(c => (c.props as Record<string, unknown> | undefined)?.['data-testid'] === 'push-pr-link')
  return btn as (VNode & { props: Record<string, unknown> }) | undefined
}

describe('pushToastOffersCreatePr（首推判定退化规则）', () => {
  it('newBranch=true（服务端判定首推）→ 展示', () => {
    expect(pushToastOffersCreatePr(true)).toBe(true)
  })

  it('newBranch=undefined（旧服务端缺字段）→ 恒展示（任务书退化规则）', () => {
    expect(pushToastOffersCreatePr(undefined)).toBe(true)
  })

  it('newBranch=false（非首推，PR 已建场景）→ 隐藏', () => {
    expect(pushToastOffersCreatePr(false)).toBe(false)
  })
})

describe('usePushPrToast', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetNaiveRuntimeMocks()
    vi.mocked(prApi.create).mockClear()
    window.open = vi.fn()
  })

  it('非首推：裸成功文案，时长缺省与既有行为逐字节一致', () => {
    const { result } = withSetup(() => usePushPrToast())
    result.toastPushSuccess(false)
    expect(messageMock.success).toHaveBeenCalledTimes(1)
    expect(messageMock.success).toHaveBeenCalledWith('layout.pushSuccess')
  })

  it('首推：toast 附「创建 PR」按钮（10s 行动化档），点击走 create-pr 新窗打开', async () => {
    const projectStore = useProjectStore()
    projectStore.currentProjectId = 'p1'
    const { result } = withSetup(() => usePushPrToast())
    result.toastPushSuccess(true)

    expect(messageMock.success).toHaveBeenCalledTimes(1)
    const [, options] = vi.mocked(messageMock.success).mock.calls[0]! as unknown as [{ duration?: number }, { duration?: number }]
    expect(options?.duration).toBe(10000)

    const btn = prButtonOf(vi.mocked(messageMock.success).mock.calls[0]![0])
    expect(btn).toBeDefined()
    expect((btn!.props.onClick as () => void)).toBeDefined()

    ;(btn!.props.onClick as () => Promise<void>)()
    await vi.waitFor(() => expect(prApi.create).toHaveBeenCalledWith('p1'))
    await vi.waitFor(() => expect(window.open).toHaveBeenCalledWith(
      'https://gitea.example/o/r/compare/main...feat', '_blank', 'noopener',
    ))
    // 打开后回执提示复用既有 prLinkGenerated 键（与项目菜单 handleCreatePr 同语义）
    await vi.waitFor(() => expect(messageMock.success).toHaveBeenCalledWith(
      expect.stringContaining('layout.prLinkGenerated'),
    ))
  })

  it('旧服务端缺字段：恒展示按钮（退化规则）', () => {
    useProjectStore().currentProjectId = 'p1'
    withSetup(() => usePushPrToast()).result.toastPushSuccess(undefined)
    expect(prButtonOf(vi.mocked(messageMock.success).mock.calls[0]![0])).toBeDefined()
  })

  it('title 覆盖：分支右键推送沿用明细文案，按钮标签不变', () => {
    const { result } = withSetup(() => usePushPrToast())
    result.toastPushSuccess(true, { title: 'git.pushRefSuccess:{"local":"feat"}' })
    const call = vi.mocked(messageMock.success).mock.calls[0]!
    const vnode = (call[0] as () => VNode)()
    const span = (vnode.children as VNode[]).find(c => (c.children as unknown) === 'git.pushRefSuccess:{"local":"feat"}')
    expect(span).toBeDefined()
  })

  it('无项目上下文（pid 空）：降级裸文案不带按钮', () => {
    const { result } = withSetup(() => usePushPrToast())
    result.toastPushSuccess(true)
    expect(prButtonOf(vi.mocked(messageMock.success).mock.calls[0]![0])).toBeUndefined()
  })
})
