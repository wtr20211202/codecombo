import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// ── mock 边界：本组合式的外部依赖只有 ① agent 终端链路（create/open/busy）
// ② naive-ui 离散 message ③ vue-i18n（真模板：t 直接查 zh-CN 语言包插值，
// 不复制期望文案，locale 改动即测出）④ git 状态摘要取数面（独立测，本文件
// 只按注入的摘要值断言装配与配额）──
const { createMock, openMock, messageMock, busyRef, summaryMock } = vi.hoisted(() => ({
  // 签名对齐 useAgentTerminal.create(name?, opts?)：mock.calls 取参有类型可依
  createMock: vi.fn<(name?: string, opts?: { dir?: string; name?: string; launchArgs?: string }) =>
    Promise<{ id: string; launched: boolean } | null>>(),
  openMock: vi.fn<(target?: string) => Promise<void>>(),
  messageMock: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
  busyRef: { value: false },
  // 签名对齐 useGitStatusSummary.buildCurrentSummary()：返回 '' = 无摘要注入
  summaryMock: vi.fn<() => Promise<string>>(),
}))

vi.mock('./useAgentTerminal', () => ({
  useAgentTerminal: () => ({ busy: busyRef, create: createMock, open: openMock }),
}))

vi.mock('./useGitStatusSummary', () => ({
  useGitStatusSummary: () => ({ buildCurrentSummary: summaryMock }),
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

import { useEditorAskAgent } from './useEditorAskAgent'
import { useProjectStore } from '../stores/project'

const BYTE500 = 500 // 服务端 launchArgs 上限（terminal.go 按字节计）

function seedProject(path = 'D:/repo/demo') {
  const store = useProjectStore()
  store.projects = [{
    id: 'p1', name: 'demo', path, currentBranch: 'main', remoteURL: '', valid: true,
  }]
  store.currentProjectId = 'p1'
  return store
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.resetAllMocks()
  // 默认无摘要（P-176 摘要不可用场景）：既有用例的精确 prompt 断言保持原语义
  summaryMock.mockResolvedValue('')
})

describe('useEditorAskAgent 就选中代码询问（P-20261002-122）', () => {
  it('多行选区：prompt = 行号头部 + 选区代码（尾随换行去除），dir=项目根，成功提示 + docked 打开', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { askAgentAboutSelection } = useEditorAskAgent()

    await askAgentAboutSelection('src\\app.ts', 'const a = 1\nconst b = 2\n', 3, 4)

    expect(createMock).toHaveBeenCalledTimes(1)
    const runtime = createMock.mock.calls[0]![0]
    const opts = createMock.mock.calls[0]![1]!
    expect(runtime).toBeUndefined() // runtime 取设置默认
    expect(opts.dir).toBe('D:/repo/demo')
    // 反斜杠路径归一为 /；行号区间用多行模板；代码尾部选区伪影（换行）裁掉
    expect(opts.launchArgs).toBe('请分析 src/app.ts 第 3-4 行选中的代码：\nconst a = 1\nconst b = 2')
    expect(messageMock.success).toHaveBeenCalled()
    expect(openMock).toHaveBeenCalledWith('docked')
  })

  it('单行选区：走 promptSelectionAtLine 模板（第 {line} 行）', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { askAgentAboutSelection } = useEditorAskAgent()

    await askAgentAboutSelection('app.ts', 'hello()', 7, 7)

    expect(createMock.mock.calls[0]![1]!.launchArgs).toBe('请分析 app.ts 第 7 行选中的代码：\nhello()')
  })

  it('超 500 字节：两段式裁剪——头部定位信息保留，代码从尾部裁剪并以 … 标注', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { askAgentAboutSelection } = useEditorAskAgent()

    // 2000 ASCII 字符选区：远超 500 字节上限
    const code = Array.from({ length: 40 }, (_, i) => `const v${i} = ${i} // some padding comment`).join('\n')
    await askAgentAboutSelection('src/very-long-directory-name/segment.ts', code, 1, 40)

    const prompt = createMock.mock.calls[0]![1]!.launchArgs as string
    expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(BYTE500)
    expect(prompt.startsWith('请分析 src/very-long-directory-name/segment.ts 第 1-40 行选中的代码：\n')).toBe(true)
    expect(prompt.endsWith('…')).toBe(true)
    // 保头部：选中起点内容保留在 prompt 内
    expect(prompt).toContain('const v0 = 0')
  })

  it('极端超长路径：代码一个字节都塞不下时退化为纯定位头部（整体仍 ≤500 字节）', async () => {
    // 600 字节路径 → fitPrompt 裁剪后 header 贴近 500 上限，'\n'+code+'…' 必超
    seedProject('D:/repo/' + '很长目录'.repeat(50))
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { askAgentAboutSelection } = useEditorAskAgent()

    const longPath = 'deep/nested/' + '很长目录'.repeat(50) + '/file.ts'
    await askAgentAboutSelection(longPath, 'code', 1, 2)

    const prompt = createMock.mock.calls[0]![1]!.launchArgs as string
    expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(BYTE500)
    // 退化为定位头部：不含代码本体，路径以 … 前缀标注省略
    expect(prompt).not.toContain('code')
    expect(prompt).toContain('…')
    expect(prompt.endsWith('：')).toBe(true)
  })

  it('空选区/无项目：防御性不动作（不建会话）', async () => {
    const { askAgentAboutSelection } = useEditorAskAgent()
    await askAgentAboutSelection('app.ts', '', 1, 1)
    expect(createMock).not.toHaveBeenCalled()

    seedProject()
    await askAgentAboutSelection('', 'code', 1, 1)
    expect(createMock).not.toHaveBeenCalled()
  })

  it('busy 让位与降级/失败提示语义与整文件询问一致（launchAskSession 共链）', async () => {
    seedProject()
    const { askAgentAboutSelection } = useEditorAskAgent()

    // busy：直接让位，不建会话不打提示
    busyRef.value = true
    await askAgentAboutSelection('app.ts', 'code', 1, 1)
    expect(createMock).not.toHaveBeenCalled()
    expect(messageMock.warning).not.toHaveBeenCalled()
    busyRef.value = false

    // 服务端降级纯 shell（launched=false）：warning 提示，仍打开 docked
    createMock.mockResolvedValue({ id: 'a2', launched: false })
    await askAgentAboutSelection('app.ts', 'code', 1, 1)
    expect(messageMock.warning).toHaveBeenCalled()
    expect(openMock).toHaveBeenCalledWith('docked')

    // create 失败（返回 null）：error 提示，不开 docked
    openMock.mockClear()
    createMock.mockResolvedValue(null)
    await askAgentAboutSelection('app.ts', 'code', 1, 1)
    expect(messageMock.error).toHaveBeenCalled()
    expect(openMock).not.toHaveBeenCalled()
  })
})

describe('useEditorAskAgent 就此文件询问（P-28 回归：launchAskSession 抽取后语义不变）', () => {
  it('整文件 prompt 模板 + 光标行聚焦行为保持', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { askAgentAboutFile } = useEditorAskAgent()

    await askAgentAboutFile('src/app.ts', 12)
    expect(createMock.mock.calls[0]![1]!.launchArgs)
      .toBe('请分析 src/app.ts 当前内容，重点看第 12 行附近')

    await askAgentAboutFile('src/app.ts')
    expect(createMock.mock.calls[1]![1]!.launchArgs).toBe('请分析 src/app.ts 当前内容')
  })
})

describe('useEditorAskAgent 在此目录新建会话（P-20261003-55）', () => {
  it('目录会话：dir=项目根拼接目标目录（POSIX 根），prompt=目录模板+定位前言，成功提示带目录 + docked 打开', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { askAgentInDirectory } = useEditorAskAgent()

    await askAgentInDirectory('packages/app')

    expect(createMock).toHaveBeenCalledTimes(1)
    expect(createMock.mock.calls[0]![0]).toBeUndefined() // runtime 取设置默认
    const opts = createMock.mock.calls[0]![1]!
    expect(opts.dir).toBe('D:/repo/demo/packages/app')
    // 定位前言（P-20261003-102）在任务行之后（首行仍任务，会话名派生语义不变）
    expect(opts.launchArgs).toBe(
      '请先熟悉当前目录的代码结构，然后等待我的具体任务。'
      + '\n项目根：D:/repo/demo；当前工作目录：D:/repo/demo/packages/app（相对 packages/app）',
    )
    expect(messageMock.success).toHaveBeenCalledWith('智能体会话已创建（工作目录：packages/app）')
    expect(openMock).toHaveBeenCalledWith('docked')
  })

  it('Windows 反斜杠根：拼接跟随项目根原生分隔符，相对段 / 全量归一（前言同形态）', async () => {
    seedProject('D:\\repo\\demo')
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { askAgentInDirectory } = useEditorAskAgent()

    await askAgentInDirectory('src\\lib')

    expect(createMock.mock.calls[0]![1]!.dir).toBe('D:\\repo\\demo\\src\\lib')
    expect(createMock.mock.calls[0]![1]!.launchArgs).toContain(
      '当前工作目录：D:\\repo\\demo\\src\\lib（相对 src/lib）',
    )
  })

  it('文件在项目根（父目录空串）：dir=项目根，launchArgs 纯任务模板无前言（零变化），成功提示目录回落「项目根」', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { askAgentInDirectory } = useEditorAskAgent()

    await askAgentInDirectory('')

    expect(createMock.mock.calls[0]![1]!.dir).toBe('D:/repo/demo')
    expect(createMock.mock.calls[0]![1]!.launchArgs).toBe('请先熟悉当前目录的代码结构，然后等待我的具体任务。')
    expect(messageMock.success).toHaveBeenCalledWith('智能体会话已创建（工作目录：项目根）')
  })

  it('无项目：防御性不动作（不建会话）', async () => {
    const { askAgentInDirectory } = useEditorAskAgent()
    await askAgentInDirectory('src')
    expect(createMock).not.toHaveBeenCalled()
  })
})

describe('useEditorAskAgent 子目录会话定位前言（P-20261003-102）', () => {
  const PROMPT = '请先熟悉当前目录的代码结构，然后等待我的具体任务。'
  const PREFACE = '项目根：D:/repo/demo；当前工作目录：D:/repo/demo/packages/app（相对 packages/app）'

  it('装配顺序 = 任务行 → 定位前言 → git 摘要（首行仍任务；摘要仍尾部）', async () => {
    seedProject()
    const summary = 'git 状态（demo）：分支 main，2 处未提交变更，最近提交：c1: add app'
    summaryMock.mockResolvedValue(summary)
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { askAgentInDirectory } = useEditorAskAgent()

    await askAgentInDirectory('packages/app')

    const args = createMock.mock.calls[0]![1]!.launchArgs as string
    expect(args).toBe(`${PROMPT}\n${PREFACE}\n${summary}`)
    expect(args.split('\n')[0]).toBe(PROMPT)
  })

  it('极端深路径：前言挤爆配额时整段放弃保任务原文（总额 ≤500，git 摘要同尽力而为语义）', async () => {
    // 根路径 ~1200 字节：前言必含 root+dir 两份绝对路径，必超剩余配额
    seedProject('D:/repo/' + '很长目录'.repeat(80))
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { askAgentInDirectory } = useEditorAskAgent()

    await askAgentInDirectory('packages/app')

    const args = createMock.mock.calls[0]![1]!.launchArgs as string
    expect(args).toBe(PROMPT)
    expect(new TextEncoder().encode(args).length).toBeLessThanOrEqual(500)
  })
})

describe('useEditorAskAgent 失败命令交给 agent 修（P-20261003-150）', () => {
  it('prompt = 失败询问头（命令+退出码）+ 输出尾部，dir=项目根，专用成功提示 + docked 打开', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { askAgentToFixFailedCommand } = useEditorAskAgent()

    await askAgentToFixFailedCommand('go test ./...', 'FAIL pkg/a\nexit status 1', 1)

    expect(createMock).toHaveBeenCalledTimes(1)
    expect(createMock.mock.calls[0]![0]).toBeUndefined() // runtime 取设置默认
    const opts = createMock.mock.calls[0]![1]!
    expect(opts.dir).toBe('D:/repo/demo')
    expect(opts.launchArgs).toBe(
      '终端里这条命令执行失败（exit 1），请定位原因并修复：\n命令：go test ./...\nFAIL pkg/a\nexit status 1',
    )
    expect(messageMock.success).toHaveBeenCalledWith('智能体会话已创建（已携带失败命令与输出）')
    expect(openMock).toHaveBeenCalledWith('docked')
  })

  it('输出超 500 字节：头部保位，输出保尾装箱（报错汇总在尾部）', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { askAgentToFixFailedCommand } = useEditorAskAgent()

    const output = Array.from({ length: 60 }, (_, i) => `line-${i} padding padding padding`).join('\n')
    await askAgentToFixFailedCommand('npm run build', output, 2)

    const prompt = createMock.mock.calls[0]![1]!.launchArgs as string
    expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(BYTE500)
    expect(prompt.startsWith('终端里这条命令执行失败（exit 2），请定位原因并修复：\n命令：npm run build\n')).toBe(true)
    expect(prompt, '尾部错误汇总保留').toContain('line-59')
    expect(prompt, '头部裁剪以 … 标注').toContain('…')
  })

  it('命令本身超长：头部经 fitByBytes 必 ≤500（输出塞不下退化纯头部）', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { askAgentToFixFailedCommand } = useEditorAskAgent()

    const longCmd = `cmd ${'x'.repeat(600)}`
    await askAgentToFixFailedCommand(longCmd, 'some output', 127)

    const prompt = createMock.mock.calls[0]![1]!.launchArgs as string
    expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(BYTE500)
    expect(prompt).toContain('exit 127')
  })

  it('空输出：prompt = 纯头部；空命令：防御性不动作（不建会话）', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { askAgentToFixFailedCommand } = useEditorAskAgent()

    await askAgentToFixFailedCommand('cmd /c exit 42', '', 42)
    expect(createMock.mock.calls[0]![1]!.launchArgs).toBe('终端里这条命令执行失败（exit 42），请定位原因并修复：\n命令：cmd /c exit 42')

    await askAgentToFixFailedCommand('', 'output', 1)
    expect(createMock).toHaveBeenCalledTimes(1)
  })
})

describe('useEditorAskAgent diff 行级追问（P-20261003-208）', () => {
  it('prompt = 文件+行号定位头 + hunk 摘要（头 + \n + 摘要），dir=项目根，docked 打开', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { askAgentAboutDiffChange } = useEditorAskAgent()

    const hunk = '@@ -2,1 +2,1 @@\n- second line\n+ second line EDITED'
    await askAgentAboutDiffChange('review.txt', 2, hunk)

    expect(createMock).toHaveBeenCalledTimes(1)
    expect(createMock.mock.calls[0]![0]).toBeUndefined() // runtime 取设置默认
    const opts = createMock.mock.calls[0]![1]!
    expect(opts.dir).toBe('D:/repo/demo')
    expect(opts.launchArgs).toBe(`请解释 review.txt 第 2 行的这个改动为什么这样修改：\n${hunk}`)
    expect(openMock).toHaveBeenCalledWith('docked')
  })

  it('反斜杠路径归一为 /（diff 伪键解析产物的跨平台兜底）', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { askAgentAboutDiffChange } = useEditorAskAgent()

    await askAgentAboutDiffChange('src\\app.ts', 1, '@@ -1,1 +1,1 @@\n- a\n+ b')
    expect(createMock.mock.calls[0]![1]!.launchArgs).toContain('src/app.ts 第 1 行')
  })

  it('超 500 字节 hunk 摘要：头保位、摘要保头裁尾（点击行邻近变更行在头部）', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { askAgentAboutDiffChange } = useEditorAskAgent()

    const hunk = Array.from({ length: 40 }, (_, i) => `+ changed line ${i} padding padding padding`).join('\n')
    await askAgentAboutDiffChange('src/very-long-directory-name/segment.ts', 5, hunk)

    const prompt = createMock.mock.calls[0]![1]!.launchArgs as string
    expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(BYTE500)
    expect(prompt.startsWith('请解释 src/very-long-directory-name/segment.ts 第 5 行的这个改动为什么这样修改：\n')).toBe(true)
    expect(prompt.endsWith('…')).toBe(true)
    expect(prompt, '摘要头部（首行变更行）保留').toContain('changed line 0')
  })

  it('hunk 摘要空串：退化纯定位头（整体仍 ≤500）；line=0 防御性不动作', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { askAgentAboutDiffChange } = useEditorAskAgent()

    await askAgentAboutDiffChange('app.ts', 3, '')
    expect(createMock.mock.calls[0]![1]!.launchArgs).toBe('请解释 app.ts 第 3 行的这个改动为什么这样修改：')

    await askAgentAboutDiffChange('app.ts', 0, '@@ -1,1 +1,1 @@')
    expect(createMock).toHaveBeenCalledTimes(1)
  })
})

describe('useEditorAskAgent blame 行来历询问（P-20261004-40）', () => {
  const BLAME = {
    path: 'src/lib.ts',
    line: 4,
    content: 'export function sub(a: number, b: number): number {',
    hash: 'a1b2c3d4',
    author: 'e2e',
    date: '2026-10-09',
    summary: 'c2: add sub function',
  }

  it('基本形态：prompt = 定位问句头 + blame 信息行（hash/作者/日期/摘要）+ 行内容，dir=项目根，成功提示带路径 + docked 打开', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { askAgentAboutBlameLine } = useEditorAskAgent()

    await askAgentAboutBlameLine(BLAME)

    expect(createMock).toHaveBeenCalledTimes(1)
    expect(createMock.mock.calls[0]![0]).toBeUndefined() // runtime 取设置默认
    const opts = createMock.mock.calls[0]![1]!
    expect(opts.dir).toBe('D:/repo/demo')
    expect(opts.launchArgs).toBe(
      '请解释 src/lib.ts 第 4 行为什么这样写：\n'
      + '该行由提交 a1b2c3d4（e2e · 2026-10-09）引入：c2: add sub function\n'
      + 'export function sub(a: number, b: number): number {',
    )
    expect(messageMock.success).toHaveBeenCalledWith('智能体会话已创建：src/lib.ts')
    expect(openMock).toHaveBeenCalledWith('docked')
  })

  it('反斜杠路径归一为 /（blame 域 path 与编辑器 path 同源）', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { askAgentAboutBlameLine } = useEditorAskAgent()

    await askAgentAboutBlameLine({ ...BLAME, path: 'src\\lib.ts' })
    expect(createMock.mock.calls[0]![1]!.launchArgs).toContain('请解释 src/lib.ts 第 4 行')
  })

  it('空提交摘要：blame 行走无摘要模板（不产悬空冒号），行内容仍在', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { askAgentAboutBlameLine } = useEditorAskAgent()

    await askAgentAboutBlameLine({ ...BLAME, summary: '' })

    const prompt = createMock.mock.calls[0]![1]!.launchArgs as string
    expect(prompt).toBe(
      '请解释 src/lib.ts 第 4 行为什么这样写：\n'
      + '该行由提交 a1b2c3d4（e2e · 2026-10-09）引入\n'
      + BLAME.content,
    )
  })

  it('空行内容（空行注解）：prompt = 头 + blame 行两段，不产空行伪影', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { askAgentAboutBlameLine } = useEditorAskAgent()

    await askAgentAboutBlameLine({ ...BLAME, content: '' })

    const prompt = createMock.mock.calls[0]![1]!.launchArgs as string
    expect(prompt.split('\n')).toHaveLength(2)
    expect(prompt.endsWith('该行由提交 a1b2c3d4（e2e · 2026-10-09）引入：c2: add sub function')).toBe(true)
  })

  it('超 500 字节行内容：头+blame 行恒保位，行内容保头裁尾（… 标注），总额 ≤500', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { askAgentAboutBlameLine } = useEditorAskAgent()

    const longLine = `const data = [${Array.from({ length: 40 }, (_, i) => `{ id: ${i}, name: 'row-${i}' }`).join(', ')}]`
    await askAgentAboutBlameLine({ ...BLAME, content: longLine })

    const prompt = createMock.mock.calls[0]![1]!.launchArgs as string
    expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(BYTE500)
    expect(prompt.startsWith('请解释 src/lib.ts 第 4 行为什么这样写：\n')).toBe(true)
    expect(prompt, 'blame 元数据行保留').toContain('该行由提交 a1b2c3d4（e2e · 2026-10-09）引入：c2: add sub function')
    expect(prompt, '行内容保头').toContain('const data = [')
    expect(prompt.endsWith('…')).toBe(true)
  })

  it('超长提交摘要：blame 行在份额内收敛（摘要保头 … 标注），行内容仍保留', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { askAgentAboutBlameLine } = useEditorAskAgent()

    const longSummary = 'refactor: ' + '重构数据管道的装填环节'.repeat(30)
    await askAgentAboutBlameLine({ ...BLAME, summary: longSummary })

    const prompt = createMock.mock.calls[0]![1]!.launchArgs as string
    expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(BYTE500)
    expect(prompt, '定位头保留').toContain('请解释 src/lib.ts 第 4 行为什么这样写：')
    expect(prompt, 'hash/作者/日期恒定在场').toContain('该行由提交 a1b2c3d4（e2e · 2026-10-09）引入：refactor: 重构')
    expect(prompt, '行内容未被摘要挤掉').toContain(BLAME.content)
    expect(prompt).toContain('…')
  })

  it('极端超长路径：退化纯定位头（整体仍 ≤500，路径 … 前缀标注省略）', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { askAgentAboutBlameLine } = useEditorAskAgent()

    const longPath = 'deep/nested/' + '很长目录'.repeat(80) + '/lib.ts'
    await askAgentAboutBlameLine({ ...BLAME, path: longPath })

    const prompt = createMock.mock.calls[0]![1]!.launchArgs as string
    expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(BYTE500)
    expect(prompt.startsWith('请解释 …')).toBe(true)
    expect(prompt.endsWith('为什么这样写：')).toBe(true)
  })

  it('busy 让位与降级/失败提示语义与 ask 家族一致（launchAskSession 共链）', async () => {
    seedProject()
    const { askAgentAboutBlameLine } = useEditorAskAgent()

    busyRef.value = true
    await askAgentAboutBlameLine(BLAME)
    expect(createMock).not.toHaveBeenCalled()
    busyRef.value = false

    createMock.mockResolvedValue({ id: 'a2', launched: false })
    await askAgentAboutBlameLine(BLAME)
    expect(messageMock.warning).toHaveBeenCalled()
    expect(openMock).toHaveBeenCalledWith('docked')

    openMock.mockClear()
    createMock.mockResolvedValue(null)
    await askAgentAboutBlameLine(BLAME)
    expect(messageMock.error).toHaveBeenCalled()
    expect(openMock).not.toHaveBeenCalled()
  })

  it('防御：无项目/缺路径/缺行号/缺 hash 均不动作（不建会话）', async () => {
    const { askAgentAboutBlameLine } = useEditorAskAgent()
    await askAgentAboutBlameLine(BLAME)
    expect(createMock).not.toHaveBeenCalled()

    seedProject()
    await askAgentAboutBlameLine({ ...BLAME, path: '' })
    await askAgentAboutBlameLine({ ...BLAME, line: 0 })
    await askAgentAboutBlameLine({ ...BLAME, hash: '' })
    expect(createMock).not.toHaveBeenCalled()
  })
})

describe('useEditorAskAgent 诊断「问智能体：解释此错误」（P-20261006-2）', () => {
  const DIAG = {
    path: 'src/broken.ts',
    line: 1,
    col: 24,
    message: "Type 'string' is not assignable to type 'number'.",
    code: '2322',
    source: 'typescript',
  }

  it('基本形态：prompt = 定位问句头（含来源/错误码）+ 错误消息全文，dir=项目根，专用成功提示 + docked 打开', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { askAgentAboutDiagnostic } = useEditorAskAgent()

    await askAgentAboutDiagnostic(DIAG)

    expect(createMock).toHaveBeenCalledTimes(1)
    expect(createMock.mock.calls[0]![0]).toBeUndefined() // runtime 取设置默认
    const opts = createMock.mock.calls[0]![1]!
    expect(opts.dir).toBe('D:/repo/demo')
    expect(opts.launchArgs).toBe(
      '请解释 src/broken.ts 第 1 行第 24 列的诊断错误（typescript(2322)）并给出修复建议：\n'
      + "Type 'string' is not assignable to type 'number'.",
    )
    expect(messageMock.success).toHaveBeenCalledWith('智能体会话已创建（已携带诊断错误）')
    expect(openMock).toHaveBeenCalledWith('docked')
  })

  it('无来源/无错误码：走无来源模板不产悬空括号；来源回落面（owner 归一）由调用方完成', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { askAgentAboutDiagnostic } = useEditorAskAgent()

    await askAgentAboutDiagnostic({ ...DIAG, source: undefined, code: undefined })
    expect(createMock.mock.calls[0]![1]!.launchArgs).toContain('的诊断错误并给出修复建议：')
    expect(createMock.mock.calls[0]![1]!.launchArgs).not.toContain('（')

    await askAgentAboutDiagnostic({ ...DIAG, source: undefined })
    expect(createMock.mock.calls[1]![1]!.launchArgs).toContain('的诊断错误（(2322)）并给出修复建议：')
  })

  it('col 缺省（0/undefined）按第 1 列表述（ Monaco 列语义 1 基，防御 0 值）', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { askAgentAboutDiagnostic } = useEditorAskAgent()

    await askAgentAboutDiagnostic({ ...DIAG, col: 0 })
    expect(createMock.mock.calls[0]![1]!.launchArgs).toContain('第 1 行第 1 列')
  })

  it('超 500 字节错误消息：头保位、消息保头裁尾（… 标注），总额 ≤500', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { askAgentAboutDiagnostic } = useEditorAskAgent()

    const long = Array.from({ length: 40 }, (_, i) => `detail line ${i}: extra chain context padding`).join('\n')
    await askAgentAboutDiagnostic({ ...DIAG, message: long })

    const prompt = createMock.mock.calls[0]![1]!.launchArgs as string
    expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(BYTE500)
    expect(prompt.startsWith('请解释 src/broken.ts 第 1 行第 24 列的诊断错误（typescript(2322)）并给出修复建议：\n')).toBe(true)
    expect(prompt, '消息保头').toContain('detail line 0')
    expect(prompt.endsWith('…')).toBe(true)
  })

  it('极端超长路径：退化纯定位头部（整体仍 ≤500，路径 … 前缀标注省略）', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { askAgentAboutDiagnostic } = useEditorAskAgent()

    const longPath = 'deep/nested/' + '很长目录'.repeat(80) + '/broken.ts'
    await askAgentAboutDiagnostic({ ...DIAG, path: longPath })

    const prompt = createMock.mock.calls[0]![1]!.launchArgs as string
    expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(BYTE500)
    expect(prompt.startsWith('请解释 …')).toBe(true)
    expect(prompt.endsWith('：')).toBe(true)
  })

  it('防御：无项目/缺路径/缺行号/空消息均不动作（不建会话）', async () => {
    const { askAgentAboutDiagnostic } = useEditorAskAgent()
    await askAgentAboutDiagnostic(DIAG)
    expect(createMock).not.toHaveBeenCalled()

    seedProject()
    await askAgentAboutDiagnostic({ ...DIAG, path: '' })
    await askAgentAboutDiagnostic({ ...DIAG, line: 0 })
    await askAgentAboutDiagnostic({ ...DIAG, message: '' })
    expect(createMock).not.toHaveBeenCalled()
  })

  it('busy 让位与降级/失败提示语义与 ask 家族一致（launchAskSession 共链）', async () => {
    seedProject()
    const { askAgentAboutDiagnostic } = useEditorAskAgent()

    busyRef.value = true
    await askAgentAboutDiagnostic(DIAG)
    expect(createMock).not.toHaveBeenCalled()
    expect(messageMock.warning).not.toHaveBeenCalled()
    busyRef.value = false

    createMock.mockResolvedValue({ id: 'a2', launched: false })
    await askAgentAboutDiagnostic(DIAG)
    expect(messageMock.warning).toHaveBeenCalled()
    expect(openMock).toHaveBeenCalledWith('docked')

    openMock.mockClear()
    createMock.mockResolvedValue(null)
    await askAgentAboutDiagnostic(DIAG)
    expect(messageMock.error).toHaveBeenCalled()
    expect(openMock).not.toHaveBeenCalled()
  })
})

describe('useEditorAskAgent 终端选中输出询问（P-20261003-7）', () => {
  it('prompt = 终端输出询问头 + 选区（尾随空白剥除），dir=项目根，成功提示无路径、docked 打开', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { askAgentAboutTerminalOutput } = useEditorAskAgent()

    // xterm 定宽行拖选常带尾随补位空白：组装端剥掉
    await askAgentAboutTerminalOutput('Error: cannot find module\n    at main.ts:1:1   ')

    expect(createMock).toHaveBeenCalledTimes(1)
    expect(createMock.mock.calls[0]![0]).toBeUndefined() // runtime 取设置默认
    const opts = createMock.mock.calls[0]![1]!
    expect(opts.dir).toBe('D:/repo/demo')
    expect(opts.launchArgs).toBe('请分析以下终端输出，定位问题并给出修复建议：\nError: cannot find module\n    at main.ts:1:1')
    // 终端入口成功文案无 {path} 插值（选区无文件定位语义）
    expect(messageMock.success).toHaveBeenCalledWith('智能体会话已创建（已携带选中输出）')
    expect(openMock).toHaveBeenCalledWith('docked')
  })

  it('超 500 字节选区：询问头保位，选区从尾部裁剪并以 … 标注', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { askAgentAboutTerminalOutput } = useEditorAskAgent()

    const output = Array.from({ length: 40 }, (_, i) => `at handler${i} (bundle.js:${i}:1)`).join('\n')
    await askAgentAboutTerminalOutput(output)

    const prompt = createMock.mock.calls[0]![1]!.launchArgs as string
    expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(BYTE500)
    expect(prompt.startsWith('请分析以下终端输出，定位问题并给出修复建议：\n')).toBe(true)
    expect(prompt.endsWith('…')).toBe(true)
    // 保头部：报错现场首行（堆栈头）保留
    expect(prompt).toContain('at handler0 (bundle.js:0:1)')
  })

  it('空选区/无项目：防御性不动作（不建会话）', async () => {
    const { askAgentAboutTerminalOutput } = useEditorAskAgent()
    await askAgentAboutTerminalOutput('')
    expect(createMock).not.toHaveBeenCalled()

    seedProject()
    await askAgentAboutTerminalOutput('')
    expect(createMock).not.toHaveBeenCalled()
  })
})

describe('useEditorAskAgent git 状态摘要注入（P-20261003-176）', () => {
  const SUMMARY = 'git 状态（demo）：分支 main，2 处未提交变更，最近提交：c1: add app'

  it('摘要追加在定位前言之后（prompt\\nsummary）——首行仍是任务，会话名派生语义不变', async () => {
    seedProject()
    summaryMock.mockResolvedValue(SUMMARY)
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { askAgentAboutFile } = useEditorAskAgent()

    await askAgentAboutFile('src/app.ts', 12)

    const args = createMock.mock.calls[0]![1]!.launchArgs as string
    expect(args).toBe(`请分析 src/app.ts 当前内容，重点看第 12 行附近\n${SUMMARY}`)
    expect(args.split('\n')[0]).toBe('请分析 src/app.ts 当前内容，重点看第 12 行附近')
  })

  it('摘要占用从 500 配额扣除：选区代码按剩余预算裁剪，总额 ≤500 且摘要完整保留在尾部', async () => {
    seedProject()
    // 摘要 ~120 字节 → 选区预算 500 - 120 - 1 = 379，塞 800 字节代码必裁
    const longSummary = 'git 状态（demo）：分支 main，2 处未提交变更，最近提交：' + 'x'.repeat(52)
    expect(new TextEncoder().encode(longSummary).length).toBeGreaterThan(100)
    summaryMock.mockResolvedValue(longSummary)
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { askAgentAboutSelection } = useEditorAskAgent()

    const code = Array.from({ length: 40 }, (_, i) => `const v${i} = ${i} // some padding comment`).join('\n')
    await askAgentAboutSelection('src/app.ts', code, 1, 40)

    const prompt = createMock.mock.calls[0]![1]!.launchArgs as string
    expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(BYTE500)
    // 摘要在尾部且完整（被裁的是选区代码，不是摘要）
    expect(prompt.endsWith(`\n${longSummary}`)).toBe(true)
    // 定位头部仍在首行
    expect(prompt.startsWith('请分析 src/app.ts 第 1-40 行选中的代码：\n')).toBe(true)
  })

  it('无摘要（空串）：prompt 原样不追加换行（既有语义回归；目录会话前言仍在）', async () => {
    seedProject()
    summaryMock.mockResolvedValue('')
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { askAgentInDirectory } = useEditorAskAgent()

    await askAgentInDirectory('packages/app')

    expect(createMock.mock.calls[0]![1]!.launchArgs).toBe(
      '请先熟悉当前目录的代码结构，然后等待我的具体任务。'
      + '\n项目根：D:/repo/demo；当前工作目录：D:/repo/demo/packages/app（相对 packages/app）',
    )
  })
})
