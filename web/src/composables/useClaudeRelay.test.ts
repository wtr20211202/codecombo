import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── mock 边界：本组合式的外部依赖只有 ① claude timeline API ② agent 会话
// 创建链（terminal-sessions store createAgent）③ naive-ui 离散 message
// ④ vue-i18n（真模板：t 直接查 zh-CN 语言包插值，不复制期望文案，locale
// 改动即测出）。装箱走真 utils/promptFit（字节语义不 mock） ──
const { timelineMock, createAgentMock, messageMock } = vi.hoisted(() => ({
  // 签名对齐 claudeApi.timeline(id, { limit, offset })
  timelineMock: vi.fn<(id: string, params: { limit?: number; offset?: number }) => Promise<unknown>>(),
  // 签名对齐 store.createAgent(name?, runtime?, config?, extra?)
  createAgentMock: vi.fn<(name?: string, runtime?: string, config?: unknown, extra?: { dir?: string; launchArgs?: string }) =>
    Promise<{ id: string; name: string; launched?: boolean } | null>>(),
  messageMock: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}))

vi.mock('../api/domains/claude', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/domains/claude')>()
  return { ...actual, claudeApi: { ...actual.claudeApi, timeline: timelineMock } }
})

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

import { useClaudeRelay } from './useClaudeRelay'
import type { ClaudeTimelineEntry } from '../api/domains/claude'

const BYTE500 = 500 // 服务端 launchArgs 上限（terminal.go 按字节计）

/** 时间线条目工厂（只给测试关心的字段） */
function e(kind: ClaudeTimelineEntry['kind'], text = ''): ClaudeTimelineEntry {
  return { kind, at: '', text }
}

/** 夹具会话元数据（非活跃，标题/cwd 对齐 picker 行真实形态） */
function fixtureSession(over: Partial<Parameters<ReturnType<typeof useClaudeRelay>['relay']>[0]> = {}) {
  return {
    id: 'sess-1', title: '收敛构建链', cwd: 'D:/repo/demo', messageCount: 3,
    firstAt: '', lastAt: '', sizeBytes: 0, active: false, ...over,
  }
}

/** 接线 timeline 两跳 mock：total 探测 + 尾窗条目页 */
function seedTimeline(entries: ClaudeTimelineEntry[]) {
  timelineMock.mockImplementation((_id: string, params: { limit?: number; offset?: number }) => {
    if ((params.limit ?? 0) === 1) return Promise.resolve({ data: { total: entries.length, truncated: false } })
    return Promise.resolve({ data: { entries, total: entries.length, truncated: false } })
  })
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe('useClaudeRelay 会话接力（P-20261003-114）', () => {
  it('正常接力：尾部最后一条 assistant 结论注入前言，dir=会话 cwd，成功提示', async () => {
    seedTimeline([e('user', '修一下构建'), e('tool', 'D:/x/build.gradle'), e('assistant', '已修复，测试全绿，下一步发版')])
    createAgentMock.mockResolvedValue({ id: 'agent-1', name: 'relay', launched: true })
    const { relay } = useClaudeRelay()

    const id = await relay(fixtureSession())

    expect(id).toBe('agent-1')
    expect(timelineMock).toHaveBeenCalledWith('sess-1', { limit: 1 })
    expect(createAgentMock).toHaveBeenCalledTimes(1)
    const [name, runtime, config, extra] = createAgentMock.mock.calls[0]!
    expect(name).toBe('接力 · 收敛构建链')
    expect(runtime).toBe('claude')
    expect(config).toBeUndefined()
    expect(extra!.dir).toBe('D:/repo/demo')
    expect(extra!.launchArgs).toBe('此前会话结论：已修复，测试全绿，下一步发版，请继续')
    expect(messageMock.success).toHaveBeenCalled()
  })

  it('结论优先弃过程：末尾 user/tool/result 混排时回溯最近 assistant 文本', async () => {
    seedTimeline([
      e('assistant', '最终结论：切换到 vite 后构建时长减半'),
      e('user', '好的，明天继续'),
      e('tool', 'git status'),
      e('result', 'clean'),
    ])
    createAgentMock.mockResolvedValue({ id: 'agent-2', name: 'relay', launched: true })
    const { relay } = useClaudeRelay()

    await relay(fixtureSession())

    expect(createAgentMock.mock.calls[0]![3]!.launchArgs)
      .toBe('此前会话结论：最终结论：切换到 vite 后构建时长减半，请继续')
  })

  it('超 500 字节结论：保尾裁头（… 前缀标注，越近越相关），全串 ≤500 字节', async () => {
    // 400 CJK 字 ≈ 1200 字节：服务端 200 rune 窗外的极端形态（防御性覆盖前端装箱层）
    const long = '复盘结论：本次迁移完成度九成，剩余清单与风险已同步至任务清单。'.repeat(20)
    seedTimeline([e('assistant', long)])
    createAgentMock.mockResolvedValue({ id: 'agent-3', name: 'relay', launched: true })
    const { relay } = useClaudeRelay()

    await relay(fixtureSession())

    const prompt = createAgentMock.mock.calls[0]![3]!.launchArgs as string
    expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(BYTE500)
    expect(prompt.startsWith('此前会话结论：…')).toBe(true)
    expect(prompt.endsWith('，请继续')).toBe(true)
  })

  it('敏感兜底遮蔽：结论复述口令赋值注入前剥为 ***（P-108 模式集）', async () => {
    seedTimeline([e('assistant', '测试账号已配好，password=hunter42 可登录后台')])
    createAgentMock.mockResolvedValue({ id: 'agent-4', name: 'relay', launched: true })
    const { relay } = useClaudeRelay()

    await relay(fixtureSession())

    const prompt = createAgentMock.mock.calls[0]![3]!.launchArgs as string
    expect(prompt).toContain('password=***')
    expect(prompt).not.toContain('hunter42')
  })

  it('无 assistant 结论：如实提示放弃，不建会话不注空前言', async () => {
    seedTimeline([e('user', '跑构建'), e('tool', 'npm run build'), e('result', 'ok')])
    const { relay } = useClaudeRelay()

    const id = await relay(fixtureSession())

    expect(id).toBeNull()
    expect(createAgentMock).not.toHaveBeenCalled()
    expect(messageMock.error).toHaveBeenCalledWith('没有可接力的结论（会话时间线里没有 assistant 回复）')
  })

  it('时间线取数失败：同样走放弃路径（error 提示，不建会话）', async () => {
    timelineMock.mockRejectedValue(new Error('boom'))
    const { relay } = useClaudeRelay()

    const id = await relay(fixtureSession())

    expect(id).toBeNull()
    expect(createAgentMock).not.toHaveBeenCalled()
    expect(messageMock.error).toHaveBeenCalled()
  })

  it('活跃会话：接力入口拒绝（结论未定型），零 API 调用', async () => {
    const { relay } = useClaudeRelay()
    const id = await relay(fixtureSession({ active: true }))
    expect(id).toBeNull()
    expect(timelineMock).not.toHaveBeenCalled()
    expect(createAgentMock).not.toHaveBeenCalled()
  })

  it('活跃会话但上下文低余量：放开守卫可接力（P-20261003-141 主动换代）', async () => {
    seedTimeline([e('assistant', '低余量前最后结论：方案 A 已验证可行')])
    createAgentMock.mockResolvedValue({ id: 'agent-10', name: 'relay', launched: true })
    const { relay } = useClaudeRelay()

    const id = await relay(fixtureSession({
      active: true,
      pressure: { estimatedTokens: 195_000, windowTokens: 200_000, percent: 97.5, estimated: true },
    }))

    expect(id).toBe('agent-10')
    expect(timelineMock).toHaveBeenCalledWith('sess-1', { limit: 1 })
    expect(createAgentMock.mock.calls[0]![3]!.launchArgs)
      .toBe('此前会话结论：低余量前最后结论：方案 A 已验证可行，请继续')
  })

  it('活跃会话余量充足（无压力数据/占用低）：守卫仍然拦下', async () => {
    const { relay } = useClaudeRelay()
    // 无压力数据（非低余量）：拦
    expect(await relay(fixtureSession({ active: true, pressure: undefined }))).toBeNull()
    // 有压力数据但余量充足：同样拦
    expect(await relay(fixtureSession({
      active: true,
      pressure: { estimatedTokens: 170_000, windowTokens: 200_000, percent: 85, estimated: true },
    }))).toBeNull()
    expect(timelineMock).not.toHaveBeenCalled()
    expect(createAgentMock).not.toHaveBeenCalled()
  })

  it('单飞守卫：在途接力未落定时再次触发直接让位', async () => {
    let release!: (v: unknown) => void
    timelineMock.mockImplementation(() => new Promise(resolve => { release = resolve }))
    const { relay, relayingId } = useClaudeRelay()

    const first = relay(fixtureSession())
    const second = await relay(fixtureSession({ id: 'sess-2' }))
    expect(second).toBeNull()
    expect(relayingId.value).toBe('sess-1')
    release({ data: { total: 0 } })
    expect(await first).toBeNull() // total=0 → 无结论放弃
    expect(relayingId.value).toBe('')
  })

  it('服务端降级纯 shell（launched=false）：warning 提示，仍返回新会话 id', async () => {
    seedTimeline([e('assistant', '结论 A')])
    createAgentMock.mockResolvedValue({ id: 'agent-9', name: 'relay', launched: false })
    const { relay } = useClaudeRelay()

    const id = await relay(fixtureSession())

    expect(id).toBe('agent-9')
    expect(messageMock.warning).toHaveBeenCalledWith('未检测到 claude 运行时，已打开纯 shell 会话（结论保留在启动参数里，可手动启动 claude）')
  })

  it('创建失败（返回 null）：error 提示，返回 null', async () => {
    seedTimeline([e('assistant', '结论 A')])
    createAgentMock.mockResolvedValue(null)
    const { relay } = useClaudeRelay()

    const id = await relay(fixtureSession())

    expect(id).toBeNull()
    expect(messageMock.error).toHaveBeenCalledWith('接力失败，请重试')
  })
})
