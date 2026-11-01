import { describe, it, expect, vi, beforeEach } from 'vitest'

// useStashSection 的外部依赖全部注入（t/message/prompt），仅 stashApi 走模块导入
vi.mock('../../api/client', () => ({
  stashApi: {
    list: vi.fn(),
    create: vi.fn().mockResolvedValue({}),
    pop: vi.fn().mockResolvedValue({}),
    drop: vi.fn().mockResolvedValue({}),
    applyToBranch: vi.fn().mockResolvedValue({}),
  },
}))

import { useStashSection } from '../../composables/useStashSection'
import { stashApi } from '../../api/client'
import type { PromptRadioGroup } from '../../composables/useDialog'

function setup(opts?: { onChanged?: () => Promise<void> | void }) {
  const message = { success: vi.fn() }
  let pendingRadio: PromptRadioGroup | undefined
  let pendingPromptOptions: { validate?: (v: string) => string | null; hint?: string } | undefined
  let resolvePrompt: ((v: string | null) => void) = () => {}
  // deferred prompt：真实弹窗生命周期 = 发起（不 await）→ 弹窗期间操作（含选范围）
  // → 用户确认/取消 resolve——范围选择发生在 pending 窗口内，不是两次独立调用
  const prompt = vi.fn((o: { title: string; label: string; placeholder: string; hint?: string; radio?: PromptRadioGroup; validate?: (v: string) => string | null }) => {
    pendingRadio = o.radio
    pendingPromptOptions = o
    return new Promise<string | null>((resolve) => { resolvePrompt = resolve })
  })
  const section = useStashSection({
    currentProjectId: () => 'p1',
    onChanged: opts?.onChanged || vi.fn(),
    message,
    t: (k: string) => k,
    prompt,
  })
  return {
    section,
    message,
    prompt,
    radio: () => pendingRadio,
    promptOptions: () => pendingPromptOptions,
    settle: (v: string | null) => resolvePrompt(v),
  }
}

describe('useStashSection 创建范围三态（P-20261003-119）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(stashApi.create as ReturnType<typeof vi.fn>).mockResolvedValue({})
  })

  it('fetchStashes 解析列表并同步 stagedSupported 能力位', async () => {
    ;(stashApi.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [{ index: 0, message: 'On master: wip', hash: 'a'.repeat(40) }],
      stagedSupported: true,
    })
    const { section } = setup()
    await section.fetchStashes()
    expect(section.stashes.value).toEqual([{ index: 0, message: 'On master: wip', hash: 'a'.repeat(40) }])
    expect(section.stashStagedSupported.value).toBe(true)
  })

  it('旧服务端列表无 hash：条目照常展示，hash 留空供操作链回退 index', async () => {
    ;(stashApi.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [{ index: 0, message: 'On master: wip' }],
    })
    const { section } = setup()
    await section.fetchStashes()
    expect(section.stashes.value[0]?.index).toBe(0)
    expect(section.stashes.value[0]?.hash).toBeUndefined()
  })

  it('旧服务端/不支持 git（无字段或 false）：能力位严格降级为 false', async () => {
    const { section } = setup()
    ;(stashApi.list as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [] })
    await section.fetchStashes()
    expect(section.stashStagedSupported.value).toBe(false)

    ;(stashApi.list as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [], stagedSupported: false })
    await section.fetchStashes()
    expect(section.stashStagedSupported.value).toBe(false)
  })

  it('默认全量：radio 三态齐全且 staged 可用，all 不下发 scope 字段', async () => {
    ;(stashApi.list as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [], stagedSupported: true })
    const { section, radio, settle } = setup()
    await section.fetchStashes()
    const creating = section.handleStashCreate()
    const r = radio()!
    expect(r.options.map(o => o.value)).toEqual(['all', 'staged', 'unstaged'])
    expect(r.options.find(o => o.value === 'staged')?.disabled).toBe(false)
    expect(r.hint).toBeUndefined()
    settle('')
    await creating
    expect(stashApi.create).toHaveBeenCalledWith('p1', undefined, undefined, undefined)
  })

  it('能力位 false：staged 档禁用 + 注记，弹窗期间选 unstaged 时 scope 下发', async () => {
    ;(stashApi.list as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [], stagedSupported: false })
    const { section, radio, settle } = setup()
    await section.fetchStashes()
    const creating = section.handleStashCreate()

    const r = radio()!
    expect(r.options.find(o => o.value === 'staged')?.disabled).toBe(true)
    expect(r.hint).toBe('commitPanel.stashScopeStagedUnsupported')

    // 用户在弹窗里点选「仅未暂存」：radio 值写入自持 ref
    r.value.value = 'unstaged'
    settle('wip msg')
    await creating
    expect(stashApi.create).toHaveBeenCalledWith('p1', 'wip msg', undefined, 'unstaged')
  })

  it('弹窗取消（resolve null）不发起创建', async () => {
    const { section, settle } = setup()
    const creating = section.handleStashCreate()
    settle(null)
    await creating
    expect(stashApi.create).not.toHaveBeenCalled()
  })

  it('范围选择不跨次残留：上次选 unstaged，再次打开回 all', async () => {
    const { section, radio, settle } = setup()
    let creating = section.handleStashCreate()
    radio()!.value.value = 'unstaged'
    settle('m')
    await creating
    expect(stashApi.create).toHaveBeenLastCalledWith('p1', 'm', undefined, 'unstaged')

    creating = section.handleStashCreate()
    settle('m2')
    await creating
    expect(stashApi.create).toHaveBeenLastCalledWith('p1', 'm2', undefined, undefined)
  })
})

describe('useStashSection pop/drop 冒烟', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('pop/drop 按列表项稳定引用下发：有 hash 带 hash，无 hash 回退 index', async () => {
    const onChanged = vi.fn()
    const { section, message } = setup({ onChanged })
    // P-20261003-264：hash 优先（服务端解析为当前栈位），index 仅回退
    await section.handleStashPop({ index: 1, message: 'm', hash: 'b'.repeat(40) })
    expect(stashApi.pop).toHaveBeenCalledWith('p1', { index: 1, hash: 'b'.repeat(40) })
    // 旧服务端无 hash：请求体只有 index（与改造前形态一致）
    await section.handleStashDrop({ index: 0, message: 'm' })
    expect(stashApi.drop).toHaveBeenCalledWith('p1', { index: 0, hash: undefined })
    expect(onChanged).toHaveBeenCalled()
    expect(message.success).toHaveBeenCalledTimes(2)
  })
})

describe('useStashSection 应用到新分支（P-20261003-263）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(stashApi.applyToBranch as ReturnType<typeof vi.fn>).mockResolvedValue({})
  })

  it('确认后按（projectId, 列表项稳定引用, trim 后分支名）下发，成功刷新变更+列表并广播外部变更', async () => {
    const onChanged = vi.fn()
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
    const { section, message, settle } = setup({ onChanged })
    const applying = section.handleStashApplyToBranch({ index: 2, message: 'm', hash: 'c'.repeat(40) })
    settle('  stash-trial  ')
    await applying
    expect(stashApi.applyToBranch).toHaveBeenCalledWith('p1', { index: 2, hash: 'c'.repeat(40) }, 'stash-trial')
    expect(onChanged).toHaveBeenCalled()
    expect(section.stashLoading.value).toBe(false) // fetchStashes 收尾
    expect(message.success).toHaveBeenCalledTimes(1)
    // 分支已切换：文件树/编辑器随检出重读（useBranchCheckout 同款广播）
    expect(dispatchSpy.mock.calls.some(c => (c[0] as CustomEvent).type === 'sc-ops:files-external-change')).toBe(true)
    dispatchSpy.mockRestore()
  })

  it('弹窗带分支名校验与后果 hint（确认前交代「检出+条目移除」）', async () => {
    const { section, promptOptions, settle } = setup()
    const applying = section.handleStashApplyToBranch({ index: 0, message: 'm' })
    const o = promptOptions()!
    expect(typeof o.validate).toBe('function')
    // validate 是 validateBranchName 本体：空名/非法名返回错误文案（i18n 键）
    expect(o.validate!('')).not.toBeNull()
    expect(o.validate!('bad name!')).not.toBeNull()
    expect(o.validate!('ok-name')).toBeNull()
    expect(o.hint).toBeTruthy()
    settle('stash-trial')
    await applying
  })

  it('弹窗取消（resolve null）不发起应用', async () => {
    const { section, settle } = setup()
    const applying = section.handleStashApplyToBranch({ index: 0, message: 'm' })
    settle(null)
    await applying
    expect(stashApi.applyToBranch).not.toHaveBeenCalled()
  })
})
