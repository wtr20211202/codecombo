import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// ── mock 边界（useCommitAgentMsg.test.ts 同款 + api/client）：① agent 终端链路
// ② naive-ui 离散 message ③ 确认弹窗（敏感场景）④ vue-i18n（真模板：t 直接查
// zh-CN 语言包插值，不复制期望文案，locale 改动即测出）⑤ /log 近期提交
// ⑥ 任务文件写盘（P-20261006-44 超限降级链）──
const { createMock, openMock, messageMock, busyRef, confirmMock, getLogMock, writeFileMock } = vi.hoisted(() => ({
  // 签名对齐 useAgentTerminal.create(name?, opts?)：mock.calls 取参有类型可依
  createMock: vi.fn<(name?: string, opts?: { dir?: string; name?: string; launchArgs?: string }) =>
    Promise<{ id: string; launched: boolean } | null>>(),
  openMock: vi.fn<(target?: string) => Promise<void>>(),
  messageMock: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() },
  busyRef: { value: false },
  confirmMock: vi.fn<(opts?: Record<string, unknown>) => Promise<boolean>>(),
  getLogMock: vi.fn<(pid: string, params?: { limit?: number }) =>
    Promise<{ data?: { hash?: string; message?: string }[] }>>(),
  writeFileMock: vi.fn<(id: string, path: string, content: string, config?: unknown) => Promise<unknown>>(),
}))

vi.mock('./useAgentTerminal', () => ({
  useAgentTerminal: () => ({ busy: busyRef, create: createMock, open: openMock }),
}))

vi.mock('./useDialog', () => ({
  confirmDialog: confirmMock,
}))

vi.mock('../api/client', () => ({
  logApi: { getLog: getLogMock },
  projectApi: { writeFile: (id: string, path: string, content: string, config?: unknown) => writeFileMock(id, path, content, config) },
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

import { buildPrDescPrompt, buildPrDescPromptFull, prCommitLine, toPrDescCommits, usePrDescription } from './usePrDescription'
import type { PrDescCommit, PrDescInput } from './usePrDescription'
import { useProjectStore } from '../stores/project'
import zhMessages from '../locales/zh-CN'
import { TASK_FILE_LAUNCH_ARGS, TASK_FILE_NAME } from '../utils/promptFit'

const BYTE500 = 500 // 服务端 launchArgs 上限（terminal.go 按字节计）

// 与 vue-i18n mock 同款真模板面（查 zh-CN 语言包插值，不复制期望文案）
const T = (key: string, params?: Record<string, unknown>): string => {
  const get = (o: Record<string, unknown>, k: string): unknown =>
    k.split('.').reduce<unknown>((a, c) => (a as Record<string, unknown> | undefined)?.[c], o)
  let s = get(zhMessages as unknown as Record<string, unknown>, key) as string
  for (const [k, v] of Object.entries(params ?? {})) s = s.replaceAll(`{${k}}`, String(v))
  return s
}

function seedProject(path = 'D:/repo/demo') {
  const store = useProjectStore()
  store.projects = [{
    id: 'p1', name: 'demo', path, currentBranch: 'main', remoteURL: '', valid: true,
  }]
  store.currentProjectId = 'p1'
  return store
}

function marksOf(entries: Record<string, { sessions?: number; runtimes?: string[] }>) {
  const m = new Map<string, { sessions: number; runtimes: string[] }>()
  for (const [k, v] of Object.entries(entries)) m.set(k, { sessions: v.sessions ?? 1, runtimes: v.runtimes ?? ['claude'] })
  return m
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.resetAllMocks()
  busyRef.value = false
})

describe('prCommitLine 近期提交行', () => {
  it('短 hash（7 位）+ 主题，超长 hash 截短', () => {
    expect(prCommitLine({ hash: 'abc1234def5678', subject: 'feat: x' })).toBe('abc1234 feat: x')
    expect(prCommitLine({ hash: 'ab', subject: 's' })).toBe('ab s')
  })
})

describe('toPrDescCommits /log 行提取', () => {
  it('取首行主题，缺 hash/主题的脏行防御性丢弃', () => {
    expect(toPrDescCommits([
      { hash: 'h1', message: 'feat: a\n\nbody' },
      { hash: '', message: 'feat: b' },
      { hash: 'h3', message: '' },
      { hash: 'h4' },
    ])).toEqual([{ hash: 'h1', subject: 'feat: a' }])
    expect(toPrDescCommits(undefined)).toEqual([])
  })
})

describe('buildPrDescPrompt 组装与装箱', () => {
  const base: PrDescInput = {
    marks: marksOf({ 'src/app.ts': { sessions: 2, runtimes: ['claude'] }, 'README.md': { runtimes: [] } }),
    stat: { additions: 12, deletions: 3 },
    commits: [{ hash: 'abc1234def', subject: 'feat: one' }, { hash: '9999999aaa', subject: 'fix: two' }],
  }

  it('全量装配：指令头 + marks 节 + diffstat 行 + 近期提交节（真 zh 模板）', () => {
    const out = buildPrDescPrompt(base, T)
    expect(out).toBe([
      T('commit.prDesc.promptHead'),
      T('commit.prDesc.marksHead'),
      '- README.md (未知运行时)\n- src/app.ts (claude) ×2',
      T('commit.prDesc.statLine', { a: 12, d: 3 }),
      T('commit.prDesc.commitsHead'),
      'abc1234 feat: one\n9999999 fix: two',
    ].join('\n'))
  })

  it('空节省略：marks 空不出清单节，commits 空不出提交节', () => {
    const out = buildPrDescPrompt({ marks: new Map(), stat: { additions: 0, deletions: 0 }, commits: [] }, T)
    expect(out).toBe([T('commit.prDesc.promptHead'), T('commit.prDesc.statLine', { a: 0, d: 0 })].join('\n'))
  })

  it('近期提交超限：整行丢尾 + … 行计入预算，marks 清单完整保留且总长 ≤500 字节', () => {
    const commits: PrDescCommit[] = Array.from({ length: 30 }, (_, i) => ({
      hash: `h${String(i).padStart(6, '0')}ffff`,
      subject: `fix: padded subject item ${i}`,
    }))
    const out = buildPrDescPrompt({ ...base, commits }, T)
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(BYTE500)
    expect(out).toContain(T('commit.prDesc.marksHead'))
    expect(out).toContain('- src/app.ts (claude) ×2') // marks 全量在场
    expect(out).toContain(commits[0]!.hash.slice(0, 7)) // 首条提交保留（保头）
    expect(out.endsWith('…')).toBe(true) // 尾部整行丢弃以 … 行标注
    expect(out).not.toContain(commits[commits.length - 1]!.subject) // 末条不保留
  })

  it('近期提交一行都装不下：整段让位（空节省略，不出 … 伪影），marks 与模板完整', () => {
    const commits: PrDescCommit[] = Array.from({ length: 30 }, (_, i) => ({
      hash: `h${String(i).padStart(6, '0')}ffff`,
      subject: `chore: 第 ${i} 条相当长的提交主题行用来撑爆 500 字节配额 padding-${i}`,
    }))
    const out = buildPrDescPrompt({ ...base, commits }, T)
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(BYTE500)
    expect(out).toContain(T('commit.prDesc.marksHead'))
    expect(out).toContain('- src/app.ts (claude) ×2')
    expect(out).not.toContain(T('commit.prDesc.commitsHead')) // 提交节整段让位
    expect(out.endsWith('…')).toBe(false)
    expect(out).not.toContain(commits[0]!.hash.slice(0, 7))
  })

  it('marks 清单超限：交 fitListPrompt 按 P-138 惯例装箱（保头 + …），提交整段让位', () => {
    const marks = marksOf(Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`src/module-${i}/very-long-agent-output-file-name-${i}.ts`, {}]),
    ))
    const out = buildPrDescPrompt({ marks, stat: base.stat, commits: base.commits }, T)
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(BYTE500)
    expect(out).toContain(T('commit.prDesc.promptHead'))
    expect(out).toContain('src/module-0/') // 保头：首行保留
    expect(out).toContain('…')
    expect(out).not.toContain(T('commit.prDesc.commitsHead')) // 提交节整段让位
  })

  it('buildPrDescPromptFull 全量装配：整体装得下时与装箱版逐字节相等，超限时全量在场（P-20261006-44）', () => {
    const out = buildPrDescPromptFull(base, T)
    expect(out).toBe(buildPrDescPrompt(base, T))
    const bigCommits: PrDescCommit[] = Array.from({ length: 30 }, (_, i) => ({
      hash: `h${String(i).padStart(6, '0')}ffff`,
      subject: `chore: 第 ${i} 条相当长的提交主题行用来撑爆 500 字节配额 padding-${i}`,
    }))
    const full = buildPrDescPromptFull({ ...base, commits: bigCommits }, T)
    expect(new TextEncoder().encode(full).length).toBeGreaterThan(BYTE500) // 全文面无配额
    expect(full).toContain('padding-29') // 装箱必截的末条在场
    expect(buildPrDescPrompt({ ...base, commits: bigCommits }, T)).not.toContain('padding-29')
  })
})

describe('usePrDescription 发起链路（useCommitAgentMsg 同范式：create → 提示 → open docked）', () => {
  it('成功：dir=项目根，prompt 含 marks 路径与 PR 模板结构，成功提示 + docked 打开', async () => {
    seedProject()
    getLogMock.mockResolvedValue({ data: [{ hash: 'abc1234def', message: 'feat: one\n\nbody' }] })
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { generatePrDesc } = usePrDescription({
      marks: { value: marksOf({ 'src/app.ts': {} }) },
      stat: { value: { additions: 5, deletions: 1 } },
    })

    await generatePrDesc()

    expect(getLogMock).toHaveBeenCalledWith('p1', { limit: 10 })
    expect(createMock).toHaveBeenCalledTimes(1)
    expect(createMock.mock.calls[0]![0]).toBeUndefined() // runtime 取设置默认
    const opts = createMock.mock.calls[0]![1]!
    expect(opts.dir).toBe('D:/repo/demo')
    // PR 模板结构四节指令 + marks 清单 + diffstat + 近期提交逐一在场
    expect(opts.launchArgs).toContain('PR 描述')
    expect(opts.launchArgs).toContain('## 改了什么')
    expect(opts.launchArgs).toContain('## 为什么')
    expect(opts.launchArgs).toContain('## 怎么测')
    expect(opts.launchArgs).toContain('## 风险')
    expect(opts.launchArgs).toContain('src/app.ts')
    expect(opts.launchArgs).toContain('+5 / -1')
    expect(opts.launchArgs).toContain('abc1234 feat: one')
    expect(new TextEncoder().encode(opts.launchArgs!).length).toBeLessThanOrEqual(BYTE500)
    expect(messageMock.success).toHaveBeenCalled()
    expect(openMock).toHaveBeenCalledWith('docked')
  })

  it('近期提交拉取失败：降级为无提交节照常发起（起草不因补充数据失败而中止）', async () => {
    seedProject()
    getLogMock.mockRejectedValue(new Error('boom'))
    createMock.mockResolvedValue({ id: 'a2', launched: true })
    const { generatePrDesc } = usePrDescription({
      marks: { value: marksOf({ 'a.ts': {} }) },
      stat: { value: { additions: 1, deletions: 0 } },
    })

    await generatePrDesc()

    expect(createMock).toHaveBeenCalledTimes(1)
    expect(createMock.mock.calls[0]![1]!.launchArgs).not.toContain(T('commit.prDesc.commitsHead'))
    expect(messageMock.success).toHaveBeenCalled()
  })

  it('无项目：防御性不动作（不拉提交不建会话）', async () => {
    const { generatePrDesc } = usePrDescription({
      marks: { value: marksOf({ 'a.ts': {} }) },
      stat: { value: { additions: 1, deletions: 0 } },
    })
    await generatePrDesc()
    expect(getLogMock).not.toHaveBeenCalled()
    expect(createMock).not.toHaveBeenCalled()
  })

  it('busy 让位与降级/失败提示语义', async () => {
    seedProject()
    getLogMock.mockResolvedValue({ data: [] })
    const { generatePrDesc } = usePrDescription({
      marks: { value: marksOf({ 'a.ts': {} }) },
      stat: { value: { additions: 1, deletions: 0 } },
    })

    // busy：直接让位，不建会话不打提示
    busyRef.value = true
    await generatePrDesc()
    expect(createMock).not.toHaveBeenCalled()
    expect(messageMock.warning).not.toHaveBeenCalled()
    busyRef.value = false

    // 服务端降级纯 shell（launched=false）：warning 提示（复用 agentMsg 文案），仍打开 docked
    createMock.mockResolvedValue({ id: 'a3', launched: false })
    await generatePrDesc()
    expect(messageMock.warning).toHaveBeenCalled()
    expect(openMock).toHaveBeenCalledWith('docked')

    // create 失败（返回 null）：error 提示（prDesc 专属文案），不开 docked
    openMock.mockClear()
    createMock.mockResolvedValue(null)
    await generatePrDesc()
    expect(messageMock.error).toHaveBeenCalled()
    expect(openMock).not.toHaveBeenCalled()
  })

  it('敏感场景确认（P-109 口径）：取消 = 不创建；确认 = 照常发起', async () => {
    seedProject()
    getLogMock.mockResolvedValue({ data: [] })
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { generatePrDesc } = usePrDescription({
      // 路径内嵌 GitHub token 形态 → containsSensitiveValue 命中 → 先弹确认
      marks: { value: marksOf({ 'creds/ghp_abcdefghijklmnopq1234.txt': {} }) },
      stat: { value: { additions: 1, deletions: 0 } },
    })

    confirmMock.mockResolvedValue(false)
    await generatePrDesc()
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(createMock).not.toHaveBeenCalled()

    confirmMock.mockResolvedValue(true)
    await generatePrDesc()
    expect(createMock).toHaveBeenCalledTimes(1)
    expect(createMock.mock.calls[0]![1]!.launchArgs).toContain('ghp_abcdefghijklmnopq1234.txt')
  })

  it('上下文超 500 字节：全文落项目根 .sc-task.md，launchArgs 换短引用指令（P-20261006-44）', async () => {
    seedProject()
    getLogMock.mockResolvedValue({
      data: Array.from({ length: 20 }, (_, i) => ({ hash: `h${String(i).padStart(6, '0')}ffff`, message: `chore: 第 ${i} 条相当长的提交主题行用来撑爆 500 字节配额 padding-${i}` })),
    })
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { generatePrDesc } = usePrDescription({
      marks: { value: marksOf({ 'src/app.ts': {} }) },
      stat: { value: { additions: 5, deletions: 1 } },
    })

    await generatePrDesc()

    expect(writeFileMock).toHaveBeenCalledTimes(1)
    const [id, path, content] = writeFileMock.mock.calls[0]!
    expect(id).toBe('p1')
    expect(path).toBe(TASK_FILE_NAME)
    expect(content).toContain('一次性任务载体')
    expect(content).toContain('padding-19') // 装箱必截的末条提交在场（全量上下文）
    expect(content).toContain('PR 描述')
    const launchArgs = createMock.mock.calls[0]![1]!.launchArgs as string
    expect(launchArgs).toBe(TASK_FILE_LAUNCH_ARGS)
    expect(messageMock.info).toHaveBeenCalledWith('任务内容超出启动参数上限，已写入项目根 .sc-task.md，智能体将从该文件读取完整任务（任务完成后文件可删）')
  })

  it('超限且任务文件写失败：退回装箱截断 prompt + warning 提示（发起不中断）', async () => {
    seedProject()
    getLogMock.mockResolvedValue({
      data: Array.from({ length: 20 }, (_, i) => ({ hash: `h${String(i).padStart(6, '0')}ffff`, message: `chore: 第 ${i} 条相当长的提交主题行用来撑爆 500 字节配额 padding-${i}` })),
    })
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    writeFileMock.mockRejectedValue(new Error('403'))
    const { generatePrDesc } = usePrDescription({
      marks: { value: marksOf({ 'src/app.ts': {} }) },
      stat: { value: { additions: 5, deletions: 1 } },
    })

    await generatePrDesc()

    const launchArgs = createMock.mock.calls[0]![1]!.launchArgs as string
    expect(new TextEncoder().encode(launchArgs).length).toBeLessThanOrEqual(BYTE500)
    expect(messageMock.warning).toHaveBeenCalledWith('任务文件写入失败，已按启动参数上限截断发起（上下文可能不完整）')
    expect(messageMock.success).toHaveBeenCalled()
  })
})
