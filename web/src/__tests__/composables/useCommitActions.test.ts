import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import type { Ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

// ── mock 边界：①naive-ui/vue-i18n 走一站式工厂（P-20261007-5）——message/dialog
// 记录器 + t=key 直通，断言按 key（键名即行为契约）②api 面只留本组合式与 changes
// store 触达的 logApi/commitApi ③四个子组合式（生成消息/拆分建议/推送流/agent
// 修复发起）整模块桩掉——它们的内部链路各自有单测，本文件只断言装配与连线；
// 门禁弹层同面桩掉（confirmCommitGateFix 三出口可编程，弹层 DOM 链路归 e2e）──
vi.mock('naive-ui', async (importOriginal) =>
  (await import('@/__tests__/mocks/naiveRuntime')).mockNaiveUi(await importOriginal()),
)
vi.mock('vue-i18n', async (importOriginal) =>
  (await import('@/__tests__/mocks/naiveRuntime')).mockVueI18n(await importOriginal()),
)

const { recentMock, getLogMock, templateMock, commitApiMock, stageMock, statusMock, generateMock, splitMock, precheckMock, pushMock, fixMock, gateMock } =
  vi.hoisted(() => ({
    recentMock: vi.fn<(id: string) => Promise<{ data?: string[] }>>(),
    getLogMock: vi.fn<(id: string, params?: { limit?: number }) => Promise<{ data?: Array<{ body?: string }> }>>(),
    templateMock: vi.fn<(id: string) => Promise<{ data?: { template?: string } }>>(),
    commitApiMock: vi.fn<(id: string, message: string, files?: string[], amend?: boolean) => Promise<unknown>>(),
    // changes store 暂存链（handleStageAll 去重闸用例 P-20261005-211 需可控在飞）
    stageMock: vi.fn<(id: string, files: string[]) => Promise<unknown>>(),
    // changes store 提交/暂存后随手的 fetchStatus（projectApi.status）——给空清单
    // 即可，别让真链在 mock 图里断掉
    statusMock: vi.fn<(id: string) => Promise<{ data?: unknown[] }>>(),
    generateMock: vi.fn<(files: Array<{ path: string }>) => Promise<void>>(),
    splitMock: vi.fn<(files: Array<{ path: string }>) => Promise<void>>(),
    precheckMock: vi.fn<() => Promise<'pull-first' | 'dismissed' | 'continue'>>(),
    pushMock: vi.fn<() => Promise<{ action: 'pushed' } | { action: 'failed'; reason: string }>>(),
    // agent 修复发起（P-20261003-273 门禁「交给智能体修」链）
    fixMock: vi.fn<(ctx: { kind: string; message: string; reasons: string[] }) => Promise<void>>(),
    gateMock: vi.fn<(options: { title: string; reasons: string[]; hint: string; agentText: string; anywayText: string }) => Promise<'agent' | 'anyway' | 'cancel'>>(),
  }))

vi.mock('@/api/client', () => ({
  logApi: { getRecentMessages: recentMock, getLog: getLogMock },
  commitApi: { getTemplate: templateMock, commit: commitApiMock, stage: stageMock, unstage: vi.fn(), rollback: vi.fn() },
  projectApi: { status: statusMock },
  diffApi: {},
  snapshotApi: {},
  // usePushPrToast（连招成功回执，P-20261005-215）触达面；本文件不点按钮，桩到模块可装配即可
  prApi: { create: vi.fn(async () => ({ data: null })) },
}))

vi.mock('@/composables/useCommitAgentMsg', () => ({
  useCommitAgentMsg: () => ({ generateCommitMsg: generateMock, launching: { value: false } }),
}))
vi.mock('@/composables/useCommitSplitSuggest', () => ({
  useCommitSplitSuggest: () => ({ suggestCommitSplit: splitMock, launching: { value: false } }),
}))
vi.mock('@/composables/usePushFlow', () => ({
  usePushFlow: () => ({ confirmPushBehind: vi.fn(), precheckBehind: precheckMock, pushCurrentBranch: pushMock }),
}))
vi.mock('@/composables/useAgentFix', () => ({
  useAgentFix: () => ({ handToAgent: fixMock, handDeployFailureToAgent: vi.fn() }),
}))
vi.mock('@/composables/useDialog', () => ({
  confirmCommitGateFix: gateMock,
  confirmDialog: vi.fn(async () => true),
  promptDialog: vi.fn(async () => null),
  confirmUploadSameName: vi.fn(async () => 'cancel' as const),
}))

import { useCommitActions } from '@/composables/useCommitActions'
import { useProjectStore } from '@/stores/project'
import { useChangesStore, type FileStatus } from '@/stores/changes'
import { messageMock, resetNaiveRuntimeMocks } from '@/__tests__/mocks/naiveRuntime'
import { withSetup } from '@/__tests__/mocks/withSetup'
import type { CommitActionsState } from '@/composables/useCommitActions'

const file = (path: string, staged: boolean): FileStatus => ({ path, status: 'Modified', staged })

/** 挂载组合式（真组件 setup 上下文——inject 共享 aheadBehind/pull 流才能进连招链；
 *  pushNotification 给缺省桩，非连招用例不关心它，压掉 Vue injection not found 警告） */
function mountActions(options?: {
  files?: FileStatus[]
  selected?: string[]
  provide?: Record<PropertyKey, unknown>
}): { state: CommitActionsState; selected: Ref<Set<string>> } {
  const selectedForCommit = ref(new Set<string>(options?.selected ?? []))
  const allFiles = ref<FileStatus[]>(options?.files ?? [])
  const { result } = withSetup(() => useCommitActions({ selectedForCommit, allFiles }), {
    pushNotification: vi.fn(),
    ...options?.provide,
  })
  return { state: result, selected: selectedForCommit }
}

function seedProject(): ReturnType<typeof useProjectStore> {
  const store = useProjectStore()
  store.projects = [{ id: 'p1', name: 'demo', path: 'D:/repo/demo', currentBranch: 'main', remoteURL: '', valid: true }]
  store.currentProjectId = 'p1'
  return store
}

beforeEach(() => {
  setActivePinia(createPinia())
  resetNaiveRuntimeMocks()
  // mockReset 清调用历史（跨用例串味防线），随后重接成功缺省
  recentMock.mockReset().mockResolvedValue({ data: [] })
  getLogMock.mockReset().mockResolvedValue({ data: [] })
  templateMock.mockReset().mockResolvedValue({ data: { template: '' } })
  commitApiMock.mockReset().mockResolvedValue({})
  stageMock.mockReset().mockResolvedValue({})
  statusMock.mockReset().mockResolvedValue({ data: [] })
  generateMock.mockReset().mockResolvedValue(undefined)
  splitMock.mockReset().mockResolvedValue(undefined)
  precheckMock.mockReset().mockResolvedValue('continue')
  // 缺省按非首推回执（裸文案契约）；首推形态由连招组内专例覆盖
  pushMock.mockReset().mockResolvedValue({ action: 'pushed', newBranch: false })
  // 门禁弹层缺省走「仍要提交」旁路：既有用例的 'msg' 类消息不感知门禁存在，
  // 门禁自身行为由下方专组用例编程三出口覆盖
  fixMock.mockReset().mockResolvedValue(undefined)
  gateMock.mockReset().mockResolvedValue('anyway')
})

describe('performCommit 提交校验与落库', () => {
  it('空消息：warning 拒绝不落库（handleCommit 吞掉 performCommit 布尔，断言走效果面）', async () => {
    seedProject()
    const { state } = mountActions({ files: [file('a.ts', true)] })
    await state.handleCommit()
    expect(messageMock.warning).toHaveBeenCalledWith('commitPanel.commitMsgRequired')
    expect(commitApiMock).not.toHaveBeenCalled()
  })

  it('无暂存文件：warning 拒绝不落库', async () => {
    seedProject()
    const { state } = mountActions({ files: [file('a.ts', false)] })
    state.commitMessage = 'msg'
    await state.handleCommit()
    expect(messageMock.warning).toHaveBeenCalledWith('commitPanel.noStagedFiles')
    expect(commitApiMock).not.toHaveBeenCalled()
  })

  it('成功：勾选子集作 filesParam，成功提示 + 草稿清空 + 勾选清空 + amend 落闸', async () => {
    seedProject()
    const { state, selected } = mountActions({ files: [file('a.ts', true), file('b.ts', false), file('c.ts', true)], selected: ['a.ts'] })
    state.commitMessage = 'feat: x'
    state.amendLastCommit = true
    await state.handleCommit()
    // store.commit 透传 signoff/author/config（断言前 4 参即可，尾参非本链语义）
    expect(commitApiMock.mock.calls[0]?.slice(0, 4)).toEqual(['p1', 'feat: x', ['a.ts'], true])
    expect(messageMock.success).toHaveBeenCalledWith('commitPanel.commitSuccess')
    expect(state.commitMessage).toBe('')
    expect(selected.value.size).toBe(0)
    expect(state.amendLastCommit).toBe(false)
  })

  it('无勾选：退化为全部暂存（undefined filesParam 交服务端默认口径）', async () => {
    seedProject()
    const { state } = mountActions({ files: [file('a.ts', true)] })
    state.commitMessage = 'msg'
    await state.handleCommit()
    expect(commitApiMock.mock.calls[0]?.slice(0, 4)).toEqual(['p1', 'msg', undefined, false])
  })

  it('落库失败：静默吃掉（拦截器提示），草稿保留', async () => {
    seedProject()
    commitApiMock.mockRejectedValueOnce(new Error('boom'))
    const { state } = mountActions({ files: [file('a.ts', true)] })
    state.commitMessage = 'msg'
    await state.handleCommit()
    expect(messageMock.success).not.toHaveBeenCalled()
    expect(state.commitMessage).toBe('msg')
  })
})

describe('提交/暂存在飞去重闸（P-20261005-211）', () => {
  it('commit 在飞再触发：busy 提示 + 不叠加落库请求（Ctrl+Enter/连点拦截面）', async () => {
    seedProject()
    let release!: () => void
    commitApiMock.mockImplementationOnce(() => new Promise<void>((r) => { release = r }))
    const { state } = mountActions({ files: [file('a.ts', true)] })
    state.commitMessage = 'feat: slow commit'
    const first = state.handleCommit()
    const second = state.handleCommit() // 第一笔仍在飞（含门禁等待段）再触发
    await flushPromises() // 排干门禁微任务链，第一笔 commitApi 已挂起（deferred 未放行）
    expect(commitApiMock).toHaveBeenCalledTimes(1)
    release()
    await Promise.all([first, second])
    expect(commitApiMock).toHaveBeenCalledTimes(1)
    expect(messageMock.warning).toHaveBeenCalledWith('git.opsBusyToast')
  })

  it('commitBusy 面板暴露：在飞即落闸 commitActionDisabled，结束复位', async () => {
    seedProject()
    let release!: () => void
    commitApiMock.mockImplementationOnce(() => new Promise<void>((r) => { release = r }))
    const { state } = mountActions({ files: [file('a.ts', true)] })
    state.commitMessage = 'feat: slow commit'
    const running = state.handleCommit()
    await Promise.resolve() // 放行首个微任务，让 tryBegin 记账落地
    expect(state.commitBusy).toBe(true)
    expect(state.commitActionDisabled).toBe(true)
    release()
    await running
    expect(state.commitBusy).toBe(false) // finally 语义复位；disabled 回升是草稿清空所致，非 busy
  })

  it('stageAll 在飞再触发：busy 提示 + 不叠加暂存请求', async () => {
    seedProject()
    let releaseStage!: () => void
    stageMock.mockImplementationOnce(() => new Promise<void>((r) => { releaseStage = r }))
    const { state } = mountActions({ files: [file('a.ts', false)] })
    const first = state.handleStageAll()
    const second = state.handleStageAll()
    releaseStage()
    await Promise.all([first, second])
    expect(stageMock).toHaveBeenCalledTimes(1)
    expect(messageMock.warning).toHaveBeenCalledWith('git.opsBusyToast')
  })
})

describe('提交信息门禁（P-20261003-273）', () => {
  it('违规消息弹门禁层：原因行按 key 直通断言，缺省旁路（anyway）照常落库', async () => {
    seedProject()
    const { state } = mountActions({ files: [file('a.ts', true)] })
    state.commitMessage = 'combo: 直推成功提交'
    await state.handleCommit()
    expect(gateMock).toHaveBeenCalledTimes(1)
    const opts = gateMock.mock.calls[0]![0]
    expect(opts.title).toBe('commit.gateFix.title')
    expect(opts.reasons).toEqual(['commit.gateFix.ruleType:{"type":"combo"}'])
    expect(opts.agentText).toBe('commit.gateFix.agentAction')
    expect(commitApiMock).toHaveBeenCalled()
  })

  it('门禁层选交给智能体修：handToAgent 带原信息与原因行，本轮不落库、草稿保留', async () => {
    seedProject()
    gateMock.mockResolvedValue('agent')
    const { state } = mountActions({ files: [file('a.ts', true)] })
    state.commitMessage = 'combo: 直推成功提交'
    await state.handleCommit()
    expect(fixMock).toHaveBeenCalledWith({
      kind: 'commitMsg',
      message: 'combo: 直推成功提交',
      reasons: ['commit.gateFix.ruleType:{"type":"combo"}'],
    })
    expect(commitApiMock).not.toHaveBeenCalled()
    expect(state.commitMessage).toBe('combo: 直推成功提交')
  })

  it('门禁层取消（误关弹层）：不落库不发起——cancel 不得等于放行提交', async () => {
    seedProject()
    gateMock.mockResolvedValue('cancel')
    const { state } = mountActions({ files: [file('a.ts', true)] })
    state.commitMessage = 'msg'
    await state.handleCommit()
    expect(fixMock).not.toHaveBeenCalled()
    expect(commitApiMock).not.toHaveBeenCalled()
  })

  it('合规信息不弹层直过（门禁零介入）', async () => {
    seedProject()
    const { state } = mountActions({ files: [file('a.ts', true)] })
    state.commitMessage = 'feat: 合规消息'
    await state.handleCommit()
    expect(gateMock).not.toHaveBeenCalled()
    expect(commitApiMock).toHaveBeenCalled()
  })
})

describe('onAmendToggle 修补上次提交', () => {
  it('勾选回填 HEAD 完整消息并备份草稿，取消勾选还原', async () => {
    seedProject()
    getLogMock.mockResolvedValue({ data: [{ body: 'HEAD BODY\n\ndetail' }] })
    const { state } = mountActions()
    state.commitMessage = 'DRAFT'
    // n-switch v-model 先翻转 ref 再回调（模板形态），测试同序
    state.amendLastCommit = true
    await state.onAmendToggle(true)
    expect(getLogMock).toHaveBeenCalledWith('p1', { limit: 1 })
    expect(state.commitMessage).toBe('HEAD BODY\n\ndetail')
    expect(state.amendLastCommit).toBe(true)
    // 取消勾选：n-switch v-model 先翻转 ref（组合式不管开关态），回调只还原草稿
    state.amendLastCommit = false
    await state.onAmendToggle(false)
    expect(state.commitMessage).toBe('DRAFT')
    expect(state.amendLastCommit).toBe(false)
  })

  it('无 HEAD 可修补（空仓库）：回弹勾选并本地化警告', async () => {
    seedProject()
    getLogMock.mockResolvedValue({ data: [] })
    const { state } = mountActions()
    state.amendLastCommit = true
    await state.onAmendToggle(true)
    expect(state.amendLastCommit).toBe(false)
    expect(state.commitMessage).toBe('')
    expect(messageMock.warning).toHaveBeenCalledWith('commitPanel.amendNoHead')
  })

  it('切项目落闸：amend 自动回填随切换还原勾选前草稿', async () => {
    const projectStore = seedProject()
    getLogMock.mockResolvedValue({ data: [{ body: 'A-PROJECT-HEAD' }] })
    const { state } = mountActions()
    state.commitMessage = 'DRAFT'
    state.amendLastCommit = true
    await state.onAmendToggle(true)
    expect(state.commitMessage).toBe('A-PROJECT-HEAD')
    projectStore.currentProjectId = 'p2'
    await nextTick()
    expect(state.amendLastCommit).toBe(false)
    expect(state.commitMessage).toBe('DRAFT')
  })
})

describe('Conventional Commit 字段与消息联动', () => {
  it('applyCcType 加前缀、重复切换取消', async () => {
    const { state } = mountActions()
    state.commitMessage = 'add thing'
    state.applyCcType('feat')
    expect(state.selectedCcType).toBe('feat')
    expect(state.commitMessage).toBe('feat: add thing')
    state.applyCcType('feat')
    expect(state.selectedCcType).toBe('')
    expect(state.commitMessage).toBe('add thing')
  })

  it('scope 与 breaking 组合前缀 fix(api)!:', async () => {
    const { state } = mountActions()
    state.commitMessage = 'boom'
    state.ccScope = 'api'
    state.includeBreaking = true
    state.applyCcType('fix')
    expect(state.commitMessage).toBe('fix(api)!: boom')
  })

  it('粘贴 CC 消息自动回填字段（无 type 时）', async () => {
    const { state } = mountActions()
    state.commitMessage = 'fix(core)!: align'
    await nextTick()
    expect(state.selectedCcType).toBe('fix')
    expect(state.ccScope).toBe('core')
    expect(state.includeBreaking).toBe(true)
  })

  it('appendFooter 追加并去重', async () => {
    const { state } = mountActions()
    state.commitMessage = 'feat: x'
    state.ccFooter = 'Refs #1'
    state.appendFooter()
    expect(state.commitMessage).toBe('feat: x\n\nRefs #1')
    expect(state.ccFooter).toBe('')
    state.ccFooter = 'Refs #1'
    state.appendFooter()
    expect(state.commitMessage).toBe('feat: x\n\nRefs #1')
  })
})

describe('全选与计数', () => {
  it('toggleSelectAll 只圈暂存集，再点清空', () => {
    const { state, selected } = mountActions({ files: [file('a.ts', true), file('b.ts', false), file('c.ts', true)] })
    expect(state.stagedCount).toBe(2)
    expect(state.unstagedCount).toBe(1)
    state.toggleSelectAll()
    expect([...selected.value]).toEqual(['a.ts', 'c.ts'])
    expect(state.allSelected).toBe(true)
    state.toggleSelectAll()
    expect(selected.value.size).toBe(0)
    expect(state.allSelected).toBe(false)
  })
})

describe('「提交并推送」连招', () => {
  function mountCombo(behind: number) {
    const handlePull = vi.fn()
    const fetchAll = vi.fn()
    const pushNotify = vi.fn()
    seedProject()
    const mounted = mountActions({
      files: [file('a.ts', true)],
      provide: {
        sharedAheadBehindMap: ref({ p1: { ahead: 0, behind } }),
        sharedHandlePull: handlePull,
        sharedFetchAllAheadBehind: fetchAll,
        pushNotification: pushNotify,
      },
    })
    return { ...mounted, handlePull, fetchAll, pushNotify }
  }

  it('behind=0 预检放行：提交成功直推，成功提示 + 通知 + 徽标刷新', async () => {
    const { state, pushNotify, fetchAll } = mountCombo(0)
    state.commitMessage = 'msg'
    state.handleCommitExtra('commit-push')
    await flushPromises()
    expect(commitApiMock).toHaveBeenCalled()
    expect(pushMock).toHaveBeenCalledWith('silent')
    // 非首推（newBranch=false）→ 裸成功文案，与既有行为逐字节一致
    expect(messageMock.success).toHaveBeenCalledWith('layout.pushSuccess')
    expect(pushNotify).toHaveBeenCalledWith({ type: 'success', title: 'notification.pushDone', body: 'main' })
    expect(fetchAll).toHaveBeenCalled()
  })

  it('首推新分支（newBranch=true）：成功 toast 附「创建 PR」按钮（P-20261005-215）', async () => {
    pushMock.mockReset().mockResolvedValue({ action: 'pushed', newBranch: true })
    const { state, pushNotify } = mountCombo(0)
    state.commitMessage = 'msg'
    state.handleCommitExtra('commit-push')
    await flushPromises()
    // 回执面委托 usePushPrToast（其按钮形态/点击链有专测）：这里断言接线到位——
    // push 段的 message.success（第 2 次调用，第 1 次是提交落库提示）收到渲染函数
    //（带按钮的调用形态）而非裸字符串
    const pushToastCall = vi.mocked(messageMock.success).mock.calls.find(([c]) => typeof c === 'function')
    expect(pushToastCall).toBeDefined()
    const vnode = (pushToastCall![0] as () => { children: Array<{ props?: Record<string, unknown> }> })()
    expect(vnode.children.some(c => c.props?.['data-testid'] === 'push-pr-link')).toBe(true)
    expect(pushNotify).toHaveBeenCalledWith({ type: 'success', title: 'notification.pushDone', body: 'main' })
  })

  it('behind>0 预检 pull-first：接共享拉取流 + 刷徽标，不推送', async () => {
    const { state, handlePull, fetchAll } = mountCombo(2)
    precheckMock.mockResolvedValue('pull-first')
    state.commitMessage = 'msg'
    state.handleCommitExtra('commit-push')
    await flushPromises()
    expect(commitApiMock).toHaveBeenCalled()
    expect(handlePull).toHaveBeenCalled()
    expect(fetchAll).toHaveBeenCalled()
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('预检 dismissed：提交已落库，不推不拉', async () => {
    const { state, handlePull, fetchAll } = mountCombo(2)
    precheckMock.mockResolvedValue('dismissed')
    state.commitMessage = 'msg'
    state.handleCommitExtra('commit-push')
    await flushPromises()
    expect(commitApiMock).toHaveBeenCalled()
    expect(handlePull).not.toHaveBeenCalled()
    expect(fetchAll).not.toHaveBeenCalled()
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('推送失败：部分成功文案（原因带插值）+ 通知中心 error 留痕（panel:git 直达）', async () => {
    const { state, pushNotify, fetchAll } = mountCombo(0)
    pushMock.mockResolvedValue({ action: 'failed', reason: 'rejected non-FF' })
    state.commitMessage = 'msg'
    state.handleCommitExtra('commit-push')
    await flushPromises()
    expect(messageMock.warning).toHaveBeenCalledWith(
      'git.commitPush.partialFail:{"reason":"rejected non-FF"}',
      { duration: 6000 },
    )
    // P-20261004-142：失败事实持久留痕，点击直达 git 面板（重推入口所在）
    expect(pushNotify).toHaveBeenCalledWith({
      type: 'error',
      category: 'git',
      title: 'notification.pushPartialFail',
      body: 'rejected non-FF',
      action: 'panel',
      actionPayload: 'git',
    })
    expect(fetchAll).not.toHaveBeenCalled()
  })
})

describe('commit.template 模板预填与最近消息', () => {
  it('挂载即拉模板，仅空态写入', async () => {
    seedProject()
    templateMock.mockResolvedValue({ data: { template: 'TEMPLATE LINE' } })
    const { state } = mountActions()
    await flushPromises()
    expect(templateMock).toHaveBeenCalledWith('p1')
    expect(state.commitMessage).toBe('TEMPLATE LINE')
    // 非空草稿不被覆盖
    templateMock.mockResolvedValue({ data: { template: 'OTHER' } })
    state.commitMessage = 'my draft'
    await flushPromises()
    expect(state.commitMessage).toBe('my draft')
  })

  it('loadRecentMessages 填下拉（超 60 字符截断），applyRecentMessage 回填', async () => {
    seedProject()
    const long = 'l'.repeat(61)
    recentMock.mockResolvedValue({ data: [long, 'short one'] })
    const { state } = mountActions()
    await state.loadRecentMessages()
    expect(state.recentMsgOptions).toEqual([
      { label: 'l'.repeat(60) + '…', key: '0' },
      { label: 'short one', key: '1' },
    ])
    state.applyRecentMessage('1')
    expect(state.commitMessage).toBe('short one')
  })
})

describe('生成提交信息 / 拆分建议装配', () => {
  it('两个 agent 发起面按「勾选子集优先、未勾选=全部暂存」的同一清单发起', async () => {
    seedProject()
    const { state } = mountActions({ files: [file('a.ts', true), file('b.ts', false), file('c.ts', true)], selected: ['c.ts'] })
    await state.handleGenerateCommitMsg()
    expect(generateMock).toHaveBeenCalledTimes(1)
    expect(generateMock.mock.calls[0]?.[0]).toEqual([{ path: 'c.ts', status: 'Modified' }])
    await state.handleSuggestCommitSplit()
    expect(splitMock).toHaveBeenCalledTimes(1)
    expect(splitMock.mock.calls[0]?.[0]).toEqual(generateMock.mock.calls[0]?.[0])
  })
})
