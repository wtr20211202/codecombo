import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── mock 边界：本组合式的外部依赖只有 ① instanceFetch（跨实例只读通道）
// ② agent 会话创建链（terminal-sessions store createAgent）③ naive-ui 离散
// message ④ vue-i18n（真模板：t 直接查 zh-CN 语言包插值，不复制期望文案）。
// 摘要提取/遮蔽/装箱/装配全部走真 utils（P-114 链复用面不 mock） ──
const { instanceFetchMock, createAgentMock, messageMock } = vi.hoisted(() => ({
  // 签名对齐 instanceFetch<T>(instanceId, method, path, body?)
  instanceFetchMock: vi.fn<(instanceId: string, method: string, path: string, body?: unknown) => Promise<unknown>>(),
  // 签名对齐 store.createAgent(name?, runtime?, config?, extra?)
  createAgentMock: vi.fn<(name?: string, runtime?: string, config?: unknown, extra?: { dir?: string; launchArgs?: string }) =>
    Promise<{ id: string; name: string; launched?: boolean } | null>>(),
  messageMock: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}))

vi.mock('../api/instanceFetch', () => ({ instanceFetch: instanceFetchMock }))

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

import { useInstanceRelay } from './useInstanceRelay'
import type { ClaudeSessionInfo, ClaudeTimelineEntry } from '../api/domains/claude'

const BYTE500 = 500 // 服务端 launchArgs 上限（terminal.go 按字节计）

/** 时间线条目工厂（只给测试关心的字段） */
function e(kind: ClaudeTimelineEntry['kind'], text = ''): ClaudeTimelineEntry {
  return { kind, at: '', text }
}

/** 夹具远端会话元数据（非活跃，标题/cwd 模拟远端机器上的路径形态） */
function fixtureSession(over: Partial<ClaudeSessionInfo> = {}): ClaudeSessionInfo {
  return {
    id: 'remote-sess-1', title: '前端构建链收敛', cwd: '/home/dev/fleet-a/web', messageCount: 3,
    firstAt: '', lastAt: '', sizeBytes: 0, active: false, ...over,
  }
}

/** 接线远端 timeline 两跳 mock：total 探测（limit=1）+ 尾窗条目页 */
function seedTimeline(entries: ClaudeTimelineEntry[]) {
  instanceFetchMock.mockImplementation((_iid: string, _m: string, p: string) => {
    if (p.endsWith('/timeline?limit=1')) return Promise.resolve({ data: { total: entries.length, truncated: false } })
    return Promise.resolve({ data: { entries, total: entries.length, truncated: false } })
  })
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe('useInstanceRelay 跨实例会话接力（P-20261003-218）', () => {
  it('正常接力：远端尾窗结论注入前言，createAgent 无 dir（远端路径不落本机），成功提示携实例名', async () => {
    seedTimeline([e('user', '修一下构建'), e('tool', 'npm run build'), e('assistant', '已修复，测试全绿，下一步发版')])
    createAgentMock.mockResolvedValue({ id: 'agent-1', name: 'relay', launched: true })
    const { relayFrom } = useInstanceRelay()

    const id = await relayFrom('inst-a', '实例A', fixtureSession())

    expect(id).toBe('agent-1')
    // 两跳都打来源实例、都是 GET（只读边界）
    expect(instanceFetchMock).toHaveBeenCalledTimes(2)
    expect(instanceFetchMock.mock.calls[0]![0]).toBe('inst-a')
    expect(instanceFetchMock.mock.calls[0]![1]).toBe('GET')
    expect(instanceFetchMock.mock.calls[0]![2]).toBe('/claude/sessions/remote-sess-1/timeline?limit=1')
    expect(instanceFetchMock.mock.calls[1]![1]).toBe('GET')
    expect(instanceFetchMock.mock.calls[1]![2]).toContain('/claude/sessions/remote-sess-1/timeline?limit=60&offset=')
    expect(createAgentMock).toHaveBeenCalledTimes(1)
    const [name, runtime, config, extra] = createAgentMock.mock.calls[0]!
    expect(name).toBe('实例接力 · 前端构建链收敛')
    expect(runtime).toBe('claude')
    expect(config).toBeUndefined()
    // 跨实例与本机接力的关键差异：不携带 dir（远端 cwd 是远端机器的路径）
    expect(extra!.dir).toBeUndefined()
    expect(extra!.launchArgs).toBe('此前会话结论：已修复，测试全绿，下一步发版，请继续')
    expect(messageMock.success).toHaveBeenCalledWith('已从「实例A」接力「前端构建链收敛」，结论已注入新会话任务前言')
  })

  it('结论优先弃过程：末尾 user/tool/result 混排时回溯最近 assistant 文本', async () => {
    seedTimeline([
      e('assistant', '最终结论：vite 迁移完成，冷启动 42s→3s'),
      e('user', '好的，明天继续'),
      e('tool', 'git status'),
      e('result', 'clean'),
    ])
    createAgentMock.mockResolvedValue({ id: 'agent-2', name: 'relay', launched: true })
    const { relayFrom } = useInstanceRelay()

    await relayFrom('inst-a', '实例A', fixtureSession())

    expect(createAgentMock.mock.calls[0]![3]!.launchArgs)
      .toBe('此前会话结论：最终结论：vite 迁移完成，冷启动 42s→3s，请继续')
  })

  it('超 500 字节结论：保尾裁头（… 前缀标注，越近越相关），全串 ≤500 字节', async () => {
    const long = '复盘结论：本次迁移完成度九成，剩余清单与风险已同步至任务清单。'.repeat(20)
    seedTimeline([e('assistant', long)])
    createAgentMock.mockResolvedValue({ id: 'agent-3', name: 'relay', launched: true })
    const { relayFrom } = useInstanceRelay()

    await relayFrom('inst-a', '实例A', fixtureSession())

    const prompt = createAgentMock.mock.calls[0]![3]!.launchArgs as string
    expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(BYTE500)
    expect(prompt.startsWith('此前会话结论：…')).toBe(true)
    expect(prompt.endsWith('，请继续')).toBe(true)
  })

  it('敏感兜底遮蔽：结论复述口令赋值注入前剥为 ***（P-108 模式集）', async () => {
    seedTimeline([e('assistant', '测试账号已配好，password=hunter42 可登录后台')])
    createAgentMock.mockResolvedValue({ id: 'agent-4', name: 'relay', launched: true })
    const { relayFrom } = useInstanceRelay()

    await relayFrom('inst-a', '实例A', fixtureSession())

    const prompt = createAgentMock.mock.calls[0]![3]!.launchArgs as string
    expect(prompt).toContain('password=***')
    expect(prompt).not.toContain('hunter42')
  })

  it('无 assistant 结论：如实提示放弃，不建会话不注空前言', async () => {
    seedTimeline([e('user', '跑构建'), e('tool', 'npm run build'), e('result', 'ok')])
    const { relayFrom } = useInstanceRelay()

    const id = await relayFrom('inst-a', '实例A', fixtureSession())

    expect(id).toBeNull()
    expect(createAgentMock).not.toHaveBeenCalled()
    expect(messageMock.error).toHaveBeenCalledWith('没有可接力的结论（会话时间线里没有 assistant 回复）')
  })

  it('远端时间线取数失败（不可达/502）：同样走放弃路径（error 提示，不建会话）', async () => {
    instanceFetchMock.mockRejectedValue(new Error('502'))
    const { relayFrom } = useInstanceRelay()

    const id = await relayFrom('inst-a', '实例A', fixtureSession())

    expect(id).toBeNull()
    expect(createAgentMock).not.toHaveBeenCalled()
    expect(messageMock.error).toHaveBeenCalled()
  })

  it('只读边界：全流程对远端只发 GET，零写请求（任务书②）', async () => {
    seedTimeline([e('assistant', '结论 A')])
    createAgentMock.mockResolvedValue({ id: 'agent-5', name: 'relay', launched: true })
    const { relayFrom } = useInstanceRelay()

    await relayFrom('inst-b', '实例B', fixtureSession({ id: 'remote-sess-9' }))

    expect(instanceFetchMock).toHaveBeenCalled()
    for (const call of instanceFetchMock.mock.calls) {
      expect(call[1], `对远端的方法必须是 GET，实际 ${call[1]} ${call[2]}`).toBe('GET')
      expect(call[2]).not.toContain('/proxy/') // instanceFetch 内部才拼代理前缀，调用方传 API 相对路径
      expect(call[3]).toBeUndefined() // GET 无请求体
    }
    // 对远端不发策展/终端等写端点
    expect(instanceFetchMock.mock.calls.every(c => (c[2] as string).includes('/claude/sessions/'))).toBe(true)
  })

  it('活跃会话：接力拒绝（结论未定型），零远端调用；活跃但上下文低余量放开（P-141 同口径）', async () => {
    const { relayFrom } = useInstanceRelay()
    // 无压力数据的活跃行：拦
    expect(await relayFrom('inst-a', '实例A', fixtureSession({ active: true }))).toBeNull()
    expect(instanceFetchMock).not.toHaveBeenCalled()
    expect(createAgentMock).not.toHaveBeenCalled()

    // 低余量活跃行：放开（换代入口）
    seedTimeline([e('assistant', '低余量前最后结论：方案 A 已验证可行')])
    createAgentMock.mockResolvedValue({ id: 'agent-10', name: 'relay', launched: true })
    const id = await relayFrom('inst-a', '实例A', fixtureSession({
      active: true,
      pressure: { estimatedTokens: 195_000, windowTokens: 200_000, percent: 97.5, estimated: true },
    }))
    expect(id).toBe('agent-10')
    expect(createAgentMock.mock.calls[0]![3]!.launchArgs)
      .toBe('此前会话结论：低余量前最后结论：方案 A 已验证可行，请继续')
  })

  it('单飞守卫：在途接力未落定时再次触发直接让位', async () => {
    let release!: (v: unknown) => void
    instanceFetchMock.mockImplementation(() => new Promise(resolve => { release = resolve }))
    const { relayFrom, relayingId } = useInstanceRelay()

    const first = relayFrom('inst-a', '实例A', fixtureSession())
    const second = await relayFrom('inst-a', '实例A', fixtureSession({ id: 'remote-sess-2' }))
    expect(second).toBeNull()
    expect(relayingId.value).toBe('remote-sess-1')
    release({ data: { total: 0 } })
    expect(await first).toBeNull() // total=0 → 无结论放弃
    expect(relayingId.value).toBe('')
  })

  it('服务端降级纯 shell（launched=false）：warning 提示，仍返回新会话 id；创建失败走 fail 提示', async () => {
    seedTimeline([e('assistant', '结论 A')])
    createAgentMock.mockResolvedValue({ id: 'agent-9', name: 'relay', launched: false })
    const { relayFrom } = useInstanceRelay()

    expect(await relayFrom('inst-a', '实例A', fixtureSession())).toBe('agent-9')
    expect(messageMock.warning).toHaveBeenCalledWith('未检测到 claude 运行时，已打开纯 shell 会话（结论保留在启动参数里，可手动启动 claude）')

    createAgentMock.mockResolvedValue(null)
    expect(await relayFrom('inst-a', '实例A', fixtureSession({ id: 'remote-sess-2' }))).toBeNull()
    expect(messageMock.error).toHaveBeenCalledWith('接力失败，请重试')
  })
})
