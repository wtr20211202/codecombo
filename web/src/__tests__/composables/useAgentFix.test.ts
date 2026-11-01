import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import {
  FIX_SUMMARY_MAX_CHARS,
  tailSummary,
  containsSensitiveValue,
  buildFixPrompt,
  deployToolsSummary,
} from '@/composables/useAgentFix'

// 「交给智能体修复」（P-20261002-109）纯函数：尾部摘要 / 敏感值启发式 /
// prompt 组装（launchArgs 字节适配已收敛至 utils/promptFit，见彼处单测）。
// 部署失败上下文（P-20261003-289）同文件扩展：工具序列去重 + prompt 组装行 +
// 降级形态空行跳过。
// 组合式流程（handToAgent 发起链：store 接线 / 敏感确认 / discrete message
// 提示面 / 部署补拉降级）由 P-20261007-5 一站式工厂解锁——本文件后半段直测。

// ── naive-ui / vue-i18n：一站式工厂（message 记录器承接 createDiscreteApi
// 离散面，t=key 直通）──
vi.mock('naive-ui', async (importOriginal) =>
  (await import('@/__tests__/mocks/naiveRuntime')).mockNaiveUi(await importOriginal()),
)
vi.mock('vue-i18n', async (importOriginal) =>
  (await import('@/__tests__/mocks/naiveRuntime')).mockVueI18n(await importOriginal()),
)

const { createMock, openMock, busyRef, confirmMock, deployGetMock, hostListMock, writeFileMock, scrollbackMock } = vi.hoisted(() => ({
  // 签名对齐 useAgentTerminal.create(name?, opts?)：mock.calls 取参有类型可依
  createMock: vi.fn<(name?: string, opts?: { dir?: string; launchArgs?: string }) =>
    Promise<{ id: string; launched: boolean } | null>>(),
  openMock: vi.fn<(target?: string) => Promise<void>>(),
  busyRef: { value: false },
  confirmMock: vi.fn<(options: Record<string, unknown>) => Promise<boolean>>(),
  deployGetMock: vi.fn<(id: string, config?: unknown) =>
    Promise<{ data?: { hostId?: string; host?: string; error?: string; instances?: Array<{ deployerId: string; params: Record<string, unknown> }> } }>>(),
  hostListMock: vi.fn<(config?: unknown) =>
    Promise<{ data?: Array<{ id: string; name: string; host: string; port: number }> }>>(),
  writeFileMock: vi.fn<(id: string, path: string, content: string, config?: unknown) => Promise<unknown>>(),
  // 签名对齐 terminalApi.scrollback(id, config)：responseType arraybuffer 直出 body
  scrollbackMock: vi.fn<(id: string, config?: unknown) => Promise<ArrayBuffer | string>>(),
}))

vi.mock('@/composables/useAgentTerminal', () => ({
  useAgentTerminal: () => ({ busy: busyRef, create: createMock, open: openMock }),
}))
vi.mock('@/composables/useDialog', () => ({
  confirmDialog: (options: Record<string, unknown>) => confirmMock(options),
}))
vi.mock('@/api/domains/deploy', () => ({
  deployApi: { get: deployGetMock },
}))
vi.mock('@/api/domains/remote', () => ({
  remoteHostApi: { list: hostListMock },
}))
// 哨兵会话输出补拉（P-20261005-150 第二动作）
vi.mock('@/api/domains/terminal', () => ({
  terminalApi: { scrollback: scrollbackMock },
}))
// 任务文件写盘（P-20261006-44 超限降级链）
vi.mock('@/api/client', () => ({
  projectApi: { writeFile: (id: string, path: string, content: string, config?: unknown) => writeFileMock(id, path, content, config) },
}))

import { useAgentFix, buildFixPromptFull } from '@/composables/useAgentFix'
import { useProjectStore } from '@/stores/project'
import { messageMock, resetNaiveRuntimeMocks } from '@/__tests__/mocks/naiveRuntime'
import { TASK_FILE_LAUNCH_ARGS, TASK_FILE_NAME } from '@/utils/promptFit'

const t = (key: string): string => key

function seedProject(): void {
  const store = useProjectStore()
  store.projects = [{ id: 'p1', name: 'demo', path: 'D:/repo/demo', currentBranch: 'main', remoteURL: '', valid: true }]
  store.currentProjectId = 'p1'
}

beforeEach(() => {
  resetNaiveRuntimeMocks()
  busyRef.value = false
  createMock.mockReset()
  openMock.mockReset()
  confirmMock.mockReset()
  deployGetMock.mockReset()
  hostListMock.mockReset()
  writeFileMock.mockReset()
  scrollbackMock.mockReset()
  createMock.mockResolvedValue({ id: 't1', launched: true })
  writeFileMock.mockResolvedValue(undefined)
})

describe('tailSummary 尾部摘要', () => {
  it('短文本原样（去首尾空白）', () => {
    expect(tailSummary('  hello\n')).toBe('hello')
  })

  it('超长取尾部并以 … 前缀标注', () => {
    const s = 'a'.repeat(FIX_SUMMARY_MAX_CHARS + 100)
    const out = tailSummary(s)
    expect(out.length).toBe(FIX_SUMMARY_MAX_CHARS + 1)
    expect(out.startsWith('…')).toBe(true)
    expect(out.endsWith('a')).toBe(true)
  })
})

describe('containsSensitiveValue 敏感值启发式', () => {
  it('命中：URL 内嵌凭据 / GitHub token / 赋值形态口令 / 私钥块 / Bearer', () => {
    expect(containsSensitiveValue('https://user:pa55w0rd@example.com/repo')).toBe(true)
    expect(containsSensitiveValue('remote: https://ghp_abcdefghijklmnopq1234@github.com/x/y')).toBe(true)
    expect(containsSensitiveValue("password='s3cret'")).toBe(true)
    expect(containsSensitiveValue('TOKEN: abc')).toBe(true)
    expect(containsSensitiveValue('-----BEGIN RSA PRIVATE KEY-----')).toBe(true)
    expect(containsSensitiveValue('Authorization: Bearer abcdef1234567890abcdef')).toBe(true)
  })

  it('不误报：普通错误输出 / 标记串', () => {
    expect(containsSensitiveValue('SCSEED-SRV-ZX91 fatal: something broke')).toBe(false)
    expect(containsSensitiveValue('GET /api/ahead-behind → 500：服务器异常')).toBe(false)
  })
})

describe('buildFixPrompt 组装', () => {
  it('任务上下文：命令行 + 失败输出尾部', () => {
    const out = buildFixPrompt({ kind: 'task', command: 'git pull', output: 'fatal: boom' }, t)
    expect(out).toBe(['agent.fix.taskHead', '$ git pull', 'agent.fix.taskOutputTail', 'fatal: boom'].join('\n'))
  })

  it('错误上下文：标题 + 详情尾部', () => {
    const out = buildFixPrompt(
      { kind: 'error', title: 'GET /api/x → 500：服务器异常', detail: 'SCSEED-SRV-ZX91' },
      t,
    )
    expect(out).toBe(
      ['agent.fix.errorHead', 'GET /api/x → 500：服务器异常', 'agent.fix.errorDetail', 'SCSEED-SRV-ZX91'].join('\n'),
    )
  })

  it('超长详情经尾部摘要收进 500 字节且保留报错尾部', () => {
    const detail = 'e'.repeat(2000) + 'REAL-ROOT-CAUSE'
    const out = buildFixPrompt({ kind: 'error', title: 't', detail }, t)
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(500)
    expect(out).toContain('REAL-ROOT-CAUSE')
  })

  it('提交信息上下文（P-20261003-273）：改写指令 + 原因行 + 原信息', () => {
    const out = buildFixPrompt(
      { kind: 'commitMsg', message: 'combo: 直推成功提交', reasons: ['类型「combo」不在白名单'] },
      t,
    )
    expect(out).toBe([
      'agent.fix.commitMsgHead',
      'agent.fix.commitMsgReasons',
      '类型「combo」不在白名单',
      'agent.fix.commitMsgBody',
      'combo: 直推成功提交',
    ].join('\n'))
  })
})

describe('buildFixPromptFull 全文面（P-20261006-44 任务文件降级）', () => {
  it('输出取 trim 全文，不做 400 字符摘要（文件面无配额）；同模板单源', () => {
    const output = `${'x'.repeat(2000)}\nTAIL-MARKER\n  `
    const out = buildFixPromptFull({ kind: 'task', command: 'make test', output }, t)
    expect(out).toBe(['agent.fix.taskHead', '$ make test', 'agent.fix.taskOutputTail', `${'x'.repeat(2000)}\nTAIL-MARKER`].join('\n'))
    expect(new TextEncoder().encode(out).length).toBeGreaterThan(500)
  })

  it('deploy 全文：主机/工具/任务锚点行 + 详情全文（不做尾部摘要）', () => {
    const out = buildFixPromptFull({ kind: 'deploy', host: 'h', tools: 't', detail: `${'d'.repeat(800)}END`, taskId: 'sc_dt_1' }, t)
    expect(out).toContain('agent.fix.deployTaskRef')
    expect(out.endsWith(`${'d'.repeat(800)}END`)).toBe(true)
  })
})

describe('buildFixPrompt serverLog 上下文（P-20261008-15）', () => {
  it('完整形态：头行 + 日期对账锚 + 日志尾部', () => {
    const out = buildFixPrompt(
      { kind: 'serverLog', date: '2026-10-24', detail: 'SVCLOG-MARK update failed' },
      t,
    )
    expect(out).toBe([
      'agent.fix.serverLogHead',
      'agent.fix.serverLogDate',
      'agent.fix.serverLogTail',
      'SVCLOG-MARK update failed',
    ].join('\n'))
  })

  it('超长日志尾部保尾收进 500 字节（装箱面与既有上下文同语义）', () => {
    const out = buildFixPrompt(
      { kind: 'serverLog', date: '2026-10-24', detail: `${'x'.repeat(3000)}REAL-CAUSE-TAIL` },
      t,
    )
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(500)
    expect(out).toContain('REAL-CAUSE-TAIL')
  })
})

describe('deployToolsSummary 工具序列去重', () => {
  it('去重 + 跳过空 id，"+" 连接（对齐服务端 deployerSummary 口径）', () => {
    expect(deployToolsSummary([
      { deployerId: 'init_ssh_key', params: {} },
      { deployerId: 'simple_coding', params: {} },
      { deployerId: 'simple_coding', params: {} },
      { deployerId: '', params: {} },
    ])).toBe('init_ssh_key+simple_coding')
  })

  it('空清单返回空串（prompt 侧跳过工具行）', () => {
    expect(deployToolsSummary([])).toBe('')
  })
})

describe('buildFixPrompt deploy 上下文（P-20261003-289）', () => {
  it('完整形态：头行 + 主机/工具/任务自取锚点行 + 错误尾部', () => {
    const out = buildFixPrompt(
      { kind: 'deploy', host: 'e2e-host（127.0.0.1:1）', tools: 'simple_coding', detail: 'ssh dial: refused', taskId: 'sc_dt_1' },
      t,
    )
    expect(out).toBe([
      'agent.fix.deployHead',
      'agent.fix.deployHost',
      'agent.fix.deployTools',
      'agent.fix.deployTaskRef',
      'agent.fix.deployErrorTail',
      'ssh dial: refused',
    ].join('\n'))
  })

  it('降级形态：host/tools/taskId 空则跳过对应行，不渲染空占位', () => {
    const out = buildFixPrompt(
      { kind: 'deploy', host: '', tools: '', detail: '部署失败：e2e-host\nssh dial: refused' },
      t,
    )
    expect(out).toBe(['agent.fix.deployHead', 'agent.fix.deployErrorTail', '部署失败：e2e-host\nssh dial: refused'].join('\n'))
    expect(out).not.toContain('agent.fix.deployHost')
    expect(out).not.toContain('agent.fix.deployTaskRef')
  })

  it('超长错误尾部仍保尾收进 500 字节', () => {
    const detail = 'x'.repeat(3000) + 'CONNECTION-REFUSED-TAIL'
    const out = buildFixPrompt({ kind: 'deploy', host: 'h', tools: 't', detail, taskId: 'sc_dt_1' }, t)
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(500)
    expect(out).toContain('CONNECTION-REFUSED-TAIL')
  })
})

// ════════ 组合式流程（handToAgent 发起链，P-20261007-5 工厂解锁） ════════

describe('useAgentFix handToAgent 发起链', () => {
  it('任务上下文：失败命令 workDir 作 dir，launchArgs 预填 prompt，成功提示 + docked 激活', async () => {
    seedProject()
    const { handToAgent } = useAgentFix()
    await handToAgent({ kind: 'task', command: 'git pull', output: 'fatal: boom', cwd: 'D:/repo/sub' })
    expect(createMock).toHaveBeenCalledWith(undefined, {
      dir: 'D:/repo/sub',
      launchArgs: expect.stringContaining(['agent.fix.taskHead', '$ git pull', 'agent.fix.taskOutputTail', 'fatal: boom'].join('\n')),
    })
    expect(messageMock.success).toHaveBeenCalledWith('agent.fix.success')
    expect(openMock).toHaveBeenCalledWith('docked')
  })

  it('敏感值先确认：取消不创建会话，确认照常发起', async () => {
    seedProject()
    confirmMock.mockResolvedValue(false)
    const { handToAgent } = useAgentFix()
    await handToAgent({ kind: 'error', title: 'GET /api/x', detail: "password='s3cret'" })
    expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'agent.fix.sensitiveTitle' }))
    expect(createMock).not.toHaveBeenCalled()

    confirmMock.mockResolvedValue(true)
    await handToAgent({ kind: 'error', title: 'GET /api/x', detail: "password='s3cret'" })
    expect(createMock).toHaveBeenCalled()
  })

  it('非敏感上下文不弹确认直接发起', async () => {
    seedProject()
    const { handToAgent } = useAgentFix()
    await handToAgent({ kind: 'error', title: 'GET /api/x', detail: 'SCSEED-SRV-ZX91' })
    expect(confirmMock).not.toHaveBeenCalled()
    expect(createMock).toHaveBeenCalled()
  })

  it('会话创建失败：error 提示且不激活 docked', async () => {
    seedProject()
    createMock.mockResolvedValue(null)
    const { handToAgent } = useAgentFix()
    await handToAgent({ kind: 'error', title: 'GET /api/x', detail: 'boom' })
    expect(messageMock.error).toHaveBeenCalledWith('agent.fix.failed')
    expect(openMock).not.toHaveBeenCalled()
  })

  it('运行时降级（launched=false）：warning 提示后照常打开 docked 管理页', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 't1', launched: false })
    const { handToAgent } = useAgentFix()
    await handToAgent({ kind: 'error', title: 'GET /api/x', detail: 'boom' })
    expect(messageMock.warning).toHaveBeenCalledWith('agent.fix.degraded')
    expect(messageMock.success).not.toHaveBeenCalled()
    expect(openMock).toHaveBeenCalledWith('docked')
  })

  it('agent 链路忙碌：不重复发起', async () => {
    seedProject()
    busyRef.value = true
    const { handToAgent } = useAgentFix()
    await handToAgent({ kind: 'error', title: 'GET /api/x', detail: 'boom' })
    expect(createMock).not.toHaveBeenCalled()
  })

  it('失败输出全文超 500 字节：全文落项目根 .sc-task.md，launchArgs 换短引用指令（P-20261006-44）', async () => {
    seedProject()
    const { handToAgent } = useAgentFix()
    await handToAgent({ kind: 'task', command: 'make test', output: `${'x'.repeat(2000)}TAIL-ROOT-CAUSE`, cwd: 'D:/repo/sub' })

    expect(writeFileMock).toHaveBeenCalledTimes(1)
    const [id, path, content] = writeFileMock.mock.calls[0]!
    expect(id).toBe('p1')
    expect(path).toBe(TASK_FILE_NAME)
    expect(content).toContain('一次性任务载体')
    expect(content).toContain('TAIL-ROOT-CAUSE') // 完整输出（非 400 字符尾部摘要）
    expect(content).toContain('$ make test')
    // 会话 dir 沿失败命令 workDir 既有语义，launchArgs 为短引用指令
    expect(createMock).toHaveBeenCalledWith(undefined, { dir: 'D:/repo/sub', launchArgs: TASK_FILE_LAUNCH_ARGS })
    expect(messageMock.info).toHaveBeenCalledWith('agent.taskFile.fallbackNote')
    expect(messageMock.success).toHaveBeenCalledWith('agent.fix.success')
  })

  it('超限且任务文件写失败：退回装箱截断（保尾 … 标注回归）+ warning 提示', async () => {
    seedProject()
    writeFileMock.mockRejectedValue(new Error('403'))
    const { handToAgent } = useAgentFix()
    await handToAgent({ kind: 'error', title: 'GET /api/x', detail: `${'e'.repeat(2000)}REAL-ROOT-CAUSE` })

    const launchArgs = createMock.mock.calls[0]![1]!.launchArgs as string
    expect(new TextEncoder().encode(launchArgs).length).toBeLessThanOrEqual(500)
    expect(launchArgs).toContain('REAL-ROOT-CAUSE') // 装箱面保尾语义原样回归
    expect(messageMock.warning).toHaveBeenCalledWith('agent.taskFile.fallbackWriteFailed')
  })

  it('无项目上下文的 deploy 链：超限也不走文件面，行为与降级前一致', async () => {
    // 不 seedProject（setup.ts beforeEach 已给全新空 pinia）：deploy 免项目发起，
    // projectId 为空 → 无文件面，退回装箱截断
    deployGetMock.mockResolvedValue({
      data: { hostId: 'h1', host: '203.0.113.9', error: `${'d'.repeat(2000)}DIAL-REFUSED`, instances: [] },
    })
    const { handDeployFailureToAgent } = useAgentFix()
    await handDeployFailureToAgent({ actionPayload: 'sc_dt_1', title: '部署失败', body: 'e2e-host' })

    expect(writeFileMock).not.toHaveBeenCalled()
    const launchArgs = createMock.mock.calls[0]![1]!.launchArgs as string
    expect(new TextEncoder().encode(launchArgs).length).toBeLessThanOrEqual(500)
    expect(launchArgs).toContain('DIAL-REFUSED')
  })

  it('无项目上下文的 serverLog 链（P-20261008-15）：免项目发起 dir 省略，超限退回装箱截断', async () => {
    // 不 seedProject：服务日志诊断与本地项目无涉（设置面全局面），免项目会话
    const { handToAgent } = useAgentFix()
    await handToAgent({ kind: 'serverLog', date: '2026-10-24', detail: `${'l'.repeat(2000)}SVCLOG-TAIL-MARK` })

    expect(writeFileMock).not.toHaveBeenCalled()
    const opts = createMock.mock.calls[0]![1]!
    expect(opts!.dir).toBeUndefined()
    const launchArgs = opts!.launchArgs as string
    expect(new TextEncoder().encode(launchArgs).length).toBeLessThanOrEqual(500)
    expect(launchArgs).toContain('SVCLOG-TAIL-MARK')
    expect(launchArgs).toContain('agent.fix.serverLogHead')
    expect(openMock).toHaveBeenCalledWith('docked')
  })

  it('有项目上下文的 serverLog 链：dir=项目根（会话 cwd 兜底），prompt 含日期锚', async () => {
    seedProject()
    const { handToAgent } = useAgentFix()
    await handToAgent({ kind: 'serverLog', date: '2026-10-24', detail: 'SVCLOG-LINE' })
    const opts = createMock.mock.calls[0]![1]!
    expect(opts!.dir).toBe('D:/repo/demo')
    expect(opts!.launchArgs).toContain('2026-10-24')
    expect(opts!.launchArgs).toContain('SVCLOG-LINE')
  })
})

describe('useAgentFix handDeployFailureToAgent 部署失败链（P-20261003-289）', () => {
  it('补拉任务 + 按 hostId 解析主机名：launchArgs 带主机/工具/自取锚点行，无项目也发起', async () => {
    deployGetMock.mockResolvedValue({
      data: { hostId: 'h1', host: '203.0.113.9', error: 'ssh dial: refused', instances: [{ deployerId: 'simple_coding', params: {} }] },
    })
    hostListMock.mockResolvedValue({ data: [{ id: 'h1', name: 'edge', host: '203.0.113.9', port: 22 }] })
    const { handDeployFailureToAgent } = useAgentFix()
    await handDeployFailureToAgent({ actionPayload: 'sc_dt_1', title: '部署失败', body: 'e2e-host' })
    expect(deployGetMock).toHaveBeenCalledWith('sc_dt_1', { silent: true })
    const launchArgs = createMock.mock.calls[0]?.[1]?.launchArgs ?? ''
    expect(launchArgs).toContain('edge（203.0.113.9:22）')
    expect(launchArgs).toContain('simple_coding')
    expect(launchArgs).toContain('sc_dt_1')
    expect(launchArgs).toContain('ssh dial: refused')
    expect(messageMock.success).toHaveBeenCalledWith('agent.fix.success')
  })

  it('补拉失效（404 降级）：仅通知标题+摘要进 prompt，无主机/工具行', async () => {
    deployGetMock.mockRejectedValue(new Error('gone'))
    const { handDeployFailureToAgent } = useAgentFix()
    await handDeployFailureToAgent({ actionPayload: 'sc_dt_1', title: '部署失败', body: 'e2e-host\nssh dial: refused' })
    const launchArgs = createMock.mock.calls[0]?.[1]?.launchArgs ?? ''
    expect(launchArgs).toContain('agent.fix.deployHead')
    expect(launchArgs).toContain('ssh dial: refused')
    expect(launchArgs).not.toContain('agent.fix.deployHost')
    expect(launchArgs).not.toContain('agent.fix.deployTools')
    expect(hostListMock).not.toHaveBeenCalled()
  })

  it('actionPayload 缺失：不入链', async () => {
    const { handDeployFailureToAgent } = useAgentFix()
    await handDeployFailureToAgent({})
    expect(deployGetMock).not.toHaveBeenCalled()
    expect(createMock).not.toHaveBeenCalled()
  })
})

describe('buildFixPrompt sentinel 上下文（P-20261005-150）', () => {
  it('完整形态：头行 + 规则/会话/命中行 + 输出尾部', () => {
    const out = buildFixPrompt(
      { kind: 'sentinel', name: 'OOM 盯标', matched: 'fatal: not enough memory', session: '终端 3', output: 'build log tail' },
      t,
    )
    expect(out).toBe([
      'agent.fix.sentinelHead',
      'agent.fix.sentinelRule',
      'agent.fix.sentinelSession',
      'agent.fix.sentinelMatched',
      'agent.fix.sentinelOutputTail',
      'build log tail',
    ].join('\n'))
  })

  it('降级形态：会话名反查失效（空串）跳过对应行，不渲染空占位', () => {
    const out = buildFixPrompt({ kind: 'sentinel', name: 'OOM', matched: 'hit-line', session: '', output: 'hit-line' }, t)
    expect(out).not.toContain('agent.fix.sentinelSession')
    expect(out).toContain('agent.fix.sentinelMatched')
  })

  it('超长输出保尾收进 500 字节', () => {
    const out = buildFixPrompt(
      { kind: 'sentinel', name: 'n', matched: 'm', session: 's', output: `${'x'.repeat(3000)}OOM-KILLER-TAIL` },
      t,
    )
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(500)
    expect(out).toContain('OOM-KILLER-TAIL')
  })
})

describe('useAgentFix handNotificationAgentFix 分发面（P-20261005-150）', () => {
  it('sentinel: 前缀走哨兵链：补拉会话输出剥 ANSI 后组装，dir=项目根', async () => {
    seedProject()
    scrollbackMock.mockResolvedValue('\x1b[31mexit status 2\x1b[0m OOM-TAIL-MARK')
    const { handNotificationAgentFix } = useAgentFix()
    await handNotificationAgentFix({
      actionPayload: 'sentinel:term-42',
      msgParams: { name: 'OOM 盯标', matched: 'fatal: OOM', session: '终端 3' },
    })
    expect(scrollbackMock).toHaveBeenCalledWith('term-42', { silent: true })
    expect(deployGetMock).not.toHaveBeenCalled()
    const opts = createMock.mock.calls[0]![1]!
    expect(opts!.dir).toBe('D:/repo/demo')
    expect(opts!.launchArgs).toContain('agent.fix.sentinelHead')
    expect(opts!.launchArgs).toContain('fatal: OOM')
    expect(opts!.launchArgs).toContain('OOM-TAIL-MARK')
    expect(opts!.launchArgs).not.toContain('\x1b[')
    expect(messageMock.success).toHaveBeenCalledWith('agent.fix.success')
  })

  it('会话已关闭（补拉 404）：降级仅命中行摘录，发起链不断', async () => {
    seedProject()
    scrollbackMock.mockRejectedValue(new Error('404'))
    const { handNotificationAgentFix } = useAgentFix()
    await handNotificationAgentFix({
      actionPayload: 'sentinel:term-gone',
      msgParams: { name: 'OOM', matched: 'hit-line-keep', session: '终端 3' },
    })
    const launchArgs = createMock.mock.calls[0]![1]!.launchArgs as string
    expect(launchArgs).toContain('hit-line-keep')
    expect(messageMock.success).toHaveBeenCalledWith('agent.fix.success')
  })

  it('无 sentinel: 前缀回落部署链（payload=任务 id 补拉），两源契约互不干扰', async () => {
    deployGetMock.mockResolvedValue({ data: { hostId: 'h1', host: '203.0.113.9', error: 'ssh dial: refused', instances: [] } })
    const { handNotificationAgentFix } = useAgentFix()
    await handNotificationAgentFix({ actionPayload: 'sc_dt_9', title: '部署失败', body: 'boom' })
    expect(scrollbackMock).not.toHaveBeenCalled()
    expect(deployGetMock).toHaveBeenCalledWith('sc_dt_9', { silent: true })
    expect(createMock).toHaveBeenCalled()
  })
})

