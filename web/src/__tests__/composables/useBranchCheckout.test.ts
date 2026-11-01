import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { VNode } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

// naive-ui / vue-i18n 走一站式 mock 工厂（P-20261007-5）：message/dialog 记录器
// + t=key 直通（断言按 key），原手抄 vi.mock 桩已收编
vi.mock('naive-ui', async (importOriginal) =>
  (await import('@/__tests__/mocks/naiveRuntime')).mockNaiveUi(await importOriginal()),
)
vi.mock('vue-i18n', async (importOriginal) =>
  (await import('@/__tests__/mocks/naiveRuntime')).mockVueI18n(await importOriginal()),
)

vi.mock('@/api/client', () => ({
  branchApi: { checkout: vi.fn().mockResolvedValue({ data: null }) },
}))

// 通知中心 store 桩（P-20261006-48 恢复提示落档面）：只观察 add 载荷
const notificationAdd = vi.fn().mockResolvedValue(undefined)
vi.mock('@/stores/notification', () => ({
  useNotificationStore: () => ({ add: notificationAdd }),
}))

import { useBranchCheckout } from '@/composables/useBranchCheckout'
import { useChangesStore } from '@/stores/changes'
import { branchApi } from '@/api/client'
import { OPS_FILES_EXTERNAL_CHANGE } from '@/utils/opsEvents'
import { messageMock, dialogMock, resetNaiveRuntimeMocks } from '@/__tests__/mocks/naiveRuntime'

const messageSuccess = messageMock.success
const messageWarning = messageMock.warning
const messageInfo = messageMock.info
const dialogWarning = dialogMock.warning

function watchOpsEvent(): string[] {
  const seen: string[] = []
  window.addEventListener(OPS_FILES_EXTERNAL_CHANGE, (e) => { seen.push(e.type) })
  return seen
}

/** 从 action 自渲染按钮区提取 [标签, onClick]（confirmDirtyCheckout 三选按钮，
 *  naive-ui 无中键，走 save.ts 冲突三选同款 action 渲染先例）。按钮标签是
 *  slot 子代（函数或 { default: fn } 两种形态都归一处理） */
function dialogButtons(cfg: { action?: () => VNode }): Array<{ label: string; onClick?: () => void }> {
  const vnode = cfg.action!()
  return ((vnode.children as VNode[]) || []).map(b => {
    const c = b.children as unknown
    const slot = typeof c === 'function' ? (c as () => string)
      : (typeof c === 'object' && c !== null) ? (c as { default?: () => string }).default
      : undefined
    return {
      label: slot ? slot() : '',
      onClick: b.props?.onClick as (() => void) | undefined,
    }
  })
}

describe('useBranchCheckout', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // 工厂记录器复位（dialog 桩自带 { destroy } 契约：三选按钮 onClick 内调 d.destroy()）
    resetNaiveRuntimeMocks()
    ;(branchApi.checkout as ReturnType<typeof vi.fn>).mockReset()
    ;(branchApi.checkout as ReturnType<typeof vi.fn>).mockResolvedValue({ data: null })
    notificationAdd.mockClear()
  })

  it('干净工作区：不弹确认直接检出，成功提示 + 回调 + 外部变更广播', async () => {
    const seen = watchOpsEvent()
    const onCheckedOut = vi.fn()
    const { checkoutBranch } = useBranchCheckout()
    checkoutBranch('p1', 'feature', onCheckedOut)
    await vi.waitFor(() => expect(branchApi.checkout).toHaveBeenCalledWith('p1', 'feature'))
    expect(dialogWarning).not.toHaveBeenCalled()
    expect(messageSuccess).toHaveBeenCalledWith('git.checkedOut:{"name":"feature"}')
    expect(onCheckedOut).toHaveBeenCalled()
    expect(seen).toEqual([OPS_FILES_EXTERNAL_CHANGE])
  })

  it('脏工作区：先弹三选确认（文案含数量与目标分支），「仍要切换」走原链路，取消不动', async () => {
    const changesStore = useChangesStore()
    changesStore.files = [{ path: 'a.ts' }, { path: 'b.ts' }] as never
    const seen = watchOpsEvent()
    const { checkoutBranch } = useBranchCheckout()
    checkoutBranch('p1', 'main')

    // 未确认前不检出
    expect(branchApi.checkout).not.toHaveBeenCalled()
    expect(dialogWarning).toHaveBeenCalledTimes(1)
    const cfg = dialogWarning.mock.calls[0]![0] as {
      title: string; content: string; action: () => VNode
    }
    expect(cfg.title).toBe('git.dirtyWarnTitle')
    expect(cfg.content).toContain('"count":2')
    expect(cfg.content).toContain('"branch":"main"')

    // 三选按钮区：自动暂存并恢复 / 仍要切换 / 取消
    const buttons = dialogButtons(cfg)
    expect(buttons.map(b => b.label)).toEqual(['git.dirtyWarnAutoStashBtn', 'git.dirtyWarnBtn', 'common.cancel'])

    // 「仍要切换」→ 走原 checkout 链路（成功提示 + 回调 + 广播）
    buttons[1]!.onClick!()
    await vi.waitFor(() => expect(branchApi.checkout).toHaveBeenCalledWith('p1', 'main'))
    expect(messageSuccess).toHaveBeenCalledTimes(1)
    expect(seen).toEqual([OPS_FILES_EXTERNAL_CHANGE])

    // 取消按钮只关弹窗（mock 下无副作用）：不触发任何 checkout——
    // 上面 toHaveBeenCalledWith('p1','main') 已含全部调用，取消无独立调用可断言
  })

  it('检出失败：拦截器语义下静默（无成功提示、无广播）', async () => {
    ;(branchApi.checkout as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('conflict'))
    const seen = watchOpsEvent()
    const onCheckedOut = vi.fn()
    const { checkoutBranch } = useBranchCheckout()
    checkoutBranch('p1', 'main', onCheckedOut)
    await vi.waitFor(() => expect(branchApi.checkout).toHaveBeenCalled())
    await Promise.resolve()
    expect(messageSuccess).not.toHaveBeenCalled()
    expect(onCheckedOut).not.toHaveBeenCalled()
    expect(seen).toEqual([])
  })

  it('脏工作区自动暂存档：「自动暂存并恢复」→ checkout(autoStash=true) 链 + 恢复成功提示（回调 + 广播照常）', async () => {
    const changesStore = useChangesStore()
    changesStore.files = [{ path: 'a.ts' }] as never
    ;(branchApi.checkout as ReturnType<typeof vi.fn>).mockResolvedValue({
      autoStash: { stashed: true, restored: true, stashKept: false },
    })
    const seen = watchOpsEvent()
    const onCheckedOut = vi.fn()
    const { checkoutBranch } = useBranchCheckout()
    checkoutBranch('p1', 'main', onCheckedOut)

    const buttons = dialogButtons(dialogWarning.mock.calls[0]![0] as { action: () => VNode })
    expect(buttons[0]!.label).toBe('git.dirtyWarnAutoStashBtn')

    buttons[0]!.onClick!()
    await vi.waitFor(() => expect(branchApi.checkout).toHaveBeenCalledWith('p1', 'main', true))
    expect(messageSuccess).toHaveBeenCalledWith('git.checkedOutAutoStash:{"name":"main"}')
    expect(messageWarning).not.toHaveBeenCalled()
    expect(onCheckedOut).toHaveBeenCalled()
    expect(seen).toEqual([OPS_FILES_EXTERNAL_CHANGE])
  })

  it('自动暂存档 pop 冲突：切换已成功但按 stashKept 走警告提示（变更未丢），回调与广播照常', async () => {
    const changesStore = useChangesStore()
    changesStore.files = [{ path: 'a.ts' }] as never
    ;(branchApi.checkout as ReturnType<typeof vi.fn>).mockResolvedValue({
      autoStash: { stashed: true, restored: false, stashKept: true },
    })
    const seen = watchOpsEvent()
    const onCheckedOut = vi.fn()
    const { checkoutBranch } = useBranchCheckout()
    checkoutBranch('p1', 'main', onCheckedOut)

    const buttons = dialogButtons(dialogWarning.mock.calls[0]![0] as { action: () => VNode })
    buttons[0]!.onClick!()
    await vi.waitFor(() => expect(branchApi.checkout).toHaveBeenCalledWith('p1', 'main', true))
    expect(messageWarning).toHaveBeenCalledWith('git.autoStashKept:{"name":"main"}')
    expect(messageSuccess).not.toHaveBeenCalled()
    expect(onCheckedOut).toHaveBeenCalled()
    expect(seen).toEqual([OPS_FILES_EXTERNAL_CHANGE])
  })

  it('恢复提示（P-20261006-48）：响应携带 recoverableStash 时就地点名 toast + 落通知中心条目（stash-recover 动作 + 重定位载荷）', async () => {
    ;(branchApi.checkout as ReturnType<typeof vi.fn>).mockResolvedValue({
      recoverableStash: { index: 0, branch: 'main', message: 'auto: checkout to feature', files: 3 },
    })
    const seen = watchOpsEvent()
    const { checkoutBranch } = useBranchCheckout()
    checkoutBranch('p1', 'main')

    await vi.waitFor(() => expect(branchApi.checkout).toHaveBeenCalledWith('p1', 'main'))
    // 恢复提示 toast（计数形态标题）与成功提示并存
    expect(messageSuccess).toHaveBeenCalledWith('git.checkedOut:{"name":"main"}')
    expect(messageInfo).toHaveBeenCalledWith('git.autoStashRecoverable:{"count":3}')
    // 通知中心条目：category git + stash-recover 动作，payload 携带重定位双键
    //（index 不进载荷——恢复链按 branch+message 落档后重定位，防栈位漂移误 pop）
    expect(notificationAdd).toHaveBeenCalledTimes(1)
    const n = notificationAdd.mock.calls[0]![0] as { type: string; category: string; title: string; body: string; projectId?: string; action?: string; actionPayload?: string }
    expect(n.type).toBe('info')
    expect(n.category).toBe('git')
    expect(n.projectId).toBe('p1')
    expect(n.action).toBe('stash-recover')
    expect(n.title).toBe('git.autoStashRecoverable:{"count":3}')
    expect(JSON.parse(n.actionPayload!)).toEqual({
      projectId: 'p1', branch: 'main', message: 'auto: checkout to feature',
    })
    expect(seen).toEqual([OPS_FILES_EXTERNAL_CHANGE])
  })

  it('恢复提示计数缺省（服务端探测降级 files=0）：落计数缺省文案，条目照常落档', async () => {
    ;(branchApi.checkout as ReturnType<typeof vi.fn>).mockResolvedValue({
      recoverableStash: { index: 0, branch: 'main', message: 'auto: checkout to feature', files: 0 },
    })
    const { checkoutBranch } = useBranchCheckout()
    checkoutBranch('p1', 'main')

    await vi.waitFor(() => expect(notificationAdd).toHaveBeenCalledTimes(1))
    expect(messageInfo).toHaveBeenCalledWith('git.autoStashRecoverablePlain')
    const n = notificationAdd.mock.calls[0]![0] as { title: string }
    expect(n.title).toBe('git.autoStashRecoverablePlain')
  })
})
