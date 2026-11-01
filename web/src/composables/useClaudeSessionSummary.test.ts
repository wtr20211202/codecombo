import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── mock 边界（useClaudeRelay.test.ts 同款）：本组合式的外部依赖只有
// ① agent 会话创建链（terminal-sessions store createAgent）② naive-ui 离散
// message ③ vue-i18n（真模板：t 直接查 zh-CN 语言包插值，不复制期望文案）。
// 装箱走真 utils/promptFit（字节语义不 mock） ──
const { createAgentMock, messageMock } = vi.hoisted(() => ({
  // 签名对齐 store.createAgent(name?, runtime?, config?, extra?)
  createAgentMock: vi.fn<(name?: string, runtime?: string, config?: unknown, extra?: { dir?: string; launchArgs?: string }) =>
    Promise<{ id: string; name: string; launched?: boolean } | null>>(),
  messageMock: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}))

vi.mock('../stores/terminal-sessions', () => ({
  useTerminalSessionsStore: () => ({ createAgent: createAgentMock }),
}))

vi.mock('naive-ui', async (importOriginal) => {
  // 部分 mock：主题包（themes/dark.ts）从 naive-ui 取 darkTheme 等真值，
  // 仅替换本组合式用到的 createDiscreteApi
  const actual = await importOriginal<typeof import('naive-ui')>()
  return { ...actual, createDiscreteApi: () => ({ message: messageMock }) }
})

vi.mock('vue-i18n', async () => {
  const zh = (await import('../locales/zh-CN')).default
  const get = (o: Record<string, unknown>, k: string): unknown =>
    k.split('.').reduce<unknown>((a, c) => (a as Record<string, unknown> | undefined)?.[c], o)
  return {
    useI18n: () => ({
      t: (key: string, params?: Record<string, unknown>) => {
        let s = get(zh, key) as string
        for (const [k, v] of Object.entries(params ?? {})) s = s.replaceAll(`{${k}}`, String(v))
        return s
      },
    }),
  }
})

import { useClaudeSessionSummary } from './useClaudeSessionSummary'

const BYTE500 = 500 // 服务端 launchArgs 上限（terminal.go 按字节计）

/** 夹具会话元数据（transcriptPath 形态对齐服务端 filepath.Join 产出） */
function fixtureSession(over: Partial<Parameters<ReturnType<typeof useClaudeSessionSummary>['summarize']>[0]> = {}) {
  return {
    id: 'sess-1',
    title: '收敛构建链',
    cwd: 'D:/repo/demo',
    messageCount: 3,
    firstAt: '',
    lastAt: '',
    sizeBytes: 0,
    active: false,
    transcriptPath: 'C:/Users/demo/.claude/projects/D--repo-demo/sess-1.jsonl',
    ...over,
  }
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe('useClaudeSessionSummary 回放页 AI 总结（P-20261003-215）', () => {
  it('正常发起：launchArgs 含 transcript 路径 + 四节摘要指令 + 遮蔽要求，dir=会话 cwd，成功提示', async () => {
    createAgentMock.mockResolvedValue({ id: 'agent-1', name: 'summary', launched: true })
    const { summarize } = useClaudeSessionSummary()

    const id = await summarize(fixtureSession())

    expect(id).toBe('agent-1')
    expect(createAgentMock).toHaveBeenCalledTimes(1)
    const [name, runtime, config, extra] = createAgentMock.mock.calls[0]!
    expect(name).toBe('AI 总结 · 收敛构建链')
    expect(runtime).toBe('claude')
    expect(config).toBeUndefined()
    expect(extra!.dir).toBe('D:/repo/demo')
    const prompt = extra!.launchArgs as string
    expect(prompt).toContain('C:/Users/demo/.claude/projects/D--repo-demo/sess-1.jsonl')
    // 四节结构化摘要指令（任务/关键改动/结论/遗留）逐词在场
    expect(prompt).toContain('任务')
    expect(prompt).toContain('关键改动')
    expect(prompt).toContain('结论')
    expect(prompt).toContain('遗留事项')
    // 遮蔽要求随指令走（P-207/P-108 同源语义的 prompt 侧落地）
    expect(prompt).toContain('***')
    expect(messageMock.success).toHaveBeenCalled()
  })

  it('launchArgs 恒 ≤500 字节：极端长路径被装箱裁剪也不越服务端上限', async () => {
    createAgentMock.mockResolvedValue({ id: 'agent-2', name: 'summary', launched: true })
    const { summarize } = useClaudeSessionSummary()
    const longPath = `C:/Users/some-very-long-username/.claude/projects/${'x'.repeat(320)}/${'a1b2c3d4-'.repeat(20)}.jsonl`

    await summarize(fixtureSession({ transcriptPath: longPath }))

    const prompt = createAgentMock.mock.calls[0]![3]!.launchArgs as string
    expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(BYTE500)
  })

  it('transcriptPath 缺失（旧版本对端）：如实提示放弃，不建会话', async () => {
    const { summarize } = useClaudeSessionSummary()

    const id = await summarize(fixtureSession({ transcriptPath: undefined }))

    expect(id).toBeNull()
    expect(createAgentMock).not.toHaveBeenCalled()
    expect(messageMock.error).toHaveBeenCalledWith('transcript 路径不可用（服务端版本较旧），无法发起 AI 总结')
  })

  it('单飞守卫：在途发起未落定时再次触发直接让位', async () => {
    let release!: (v: { id: string; name: string; launched?: boolean } | null) => void
    createAgentMock.mockImplementation(() => new Promise(resolve => { release = resolve }))
    const { summarize, summarizingId } = useClaudeSessionSummary()

    const first = summarize(fixtureSession())
    const second = await summarize(fixtureSession({ id: 'sess-2' }))
    expect(second).toBeNull()
    expect(summarizingId.value).toBe('sess-1')
    release({ id: 'agent-3', name: 'summary', launched: true })
    expect(await first).toBe('agent-3')
    expect(summarizingId.value).toBe('')
  })

  it('服务端降级纯 shell（launched=false）：warning 提示，仍返回新会话 id', async () => {
    createAgentMock.mockResolvedValue({ id: 'agent-9', name: 'summary', launched: false })
    const { summarize } = useClaudeSessionSummary()

    const id = await summarize(fixtureSession())

    expect(id).toBe('agent-9')
    expect(messageMock.warning).toHaveBeenCalledWith('未检测到 claude 运行时，已打开纯 shell 会话（总结指令保留在启动参数里，可手动启动 claude）')
  })

  it('创建失败（返回 null）：error 提示，返回 null', async () => {
    createAgentMock.mockResolvedValue(null)
    const { summarize } = useClaudeSessionSummary()

    const id = await summarize(fixtureSession())

    expect(id).toBeNull()
    expect(messageMock.error).toHaveBeenCalledWith('AI 总结发起失败，请重试')
  })
})
