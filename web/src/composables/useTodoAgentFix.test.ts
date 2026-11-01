import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// ── mock 边界：本组合式的外部依赖只有 ① agent 终端链路（create/open/busy）
// ② naive-ui 离散 message ③ vue-i18n（真模板：t 直接查 zh-CN 语言包插值，
// 不复制期望文案，locale 改动即测出）④ readFile 上下文提取 ⑤ 敏感确认
// ⑥ 任务文件写盘（P-20261006-44 超限降级链）──
const { createMock, openMock, messageMock, busyRef, readFileMock, writeFileMock, confirmMock } = vi.hoisted(() => ({
  // 签名对齐 useAgentTerminal.create(name?, opts?)：mock.calls 取参有类型可依
  createMock: vi.fn<(name?: string, opts?: { dir?: string; name?: string; launchArgs?: string }) =>
    Promise<{ id: string; launched: boolean } | null>>(),
  openMock: vi.fn<(target?: string) => Promise<void>>(),
  messageMock: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() },
  busyRef: { value: false },
  readFileMock: vi.fn<(id: string, path: string, config?: unknown) => Promise<{ data?: string }>>(),
  writeFileMock: vi.fn<(id: string, path: string, content: string, config?: unknown) => Promise<unknown>>(),
  confirmMock: vi.fn<(options: Record<string, unknown>) => Promise<boolean>>(),
}))

vi.mock('./useAgentTerminal', () => ({
  useAgentTerminal: () => ({ busy: busyRef, create: createMock, open: openMock }),
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

vi.mock('./useDialog', () => ({
  confirmDialog: (options: Record<string, unknown>) => confirmMock(options),
}))

vi.mock('../api/client', () => ({
  projectApi: {
    readFile: (id: string, path: string, config?: unknown) => readFileMock(id, path, config),
    writeFile: (id: string, path: string, content: string, config?: unknown) => writeFileMock(id, path, content, config),
  },
}))

import {
  buildBatchTodoFixFullPrompt,
  buildBatchTodoFixPrompt,
  buildSingleTodoFixPrompt,
  extractTodoContext,
  TODO_CONTEXT_RADIUS,
  todoItemLine,
  useTodoAgentFix,
  type TodoFixItem,
  type TodoFixTranslator,
} from './useTodoAgentFix'
import { useProjectStore } from '../stores/project'
import { TASK_FILE_LAUNCH_ARGS, TASK_FILE_NAME } from '../utils/promptFit'

const BYTE500 = 500 // 服务端 launchArgs 上限（terminal.go 按字节计）
const t = (key: string, params?: Record<string, unknown>): string => {
  // 纯函数测试用键名直译（buildFixPrompt 同款口径）；模板段形状另在组合式
  // 流程测试里经真语言包断言
  void params
  return key
}

function item(path: string, line: number, content: string): TodoFixItem {
  return { path, line, content }
}

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
  busyRef.value = false
})

describe('todoItemLine 定位行', () => {
  it('反斜杠路径归一为 /，内容去首尾空白', () => {
    expect(todoItemLine(item('src\\app.ts', 12, '  // TODO: x  '))).toBe('src/app.ts:12 // TODO: x')
  })
})

describe('extractTodoContext 上下文提取', () => {
  const file = 'l1\nl2\nl3\nl4\nl5\nl6\nl7'

  it('中部标记行 ±2 行带行号，目标行 > 前缀', () => {
    expect(extractTodoContext(file, 4)).toBe(
      ['  2: l2', '  3: l3', '> 4: l4', '  5: l5', '  6: l6'].join('\n'),
    )
  })

  it('文件头部：起点钳到 1（不足半径不越界）', () => {
    expect(extractTodoContext(file, 1)).toBe(['> 1: l1', '  2: l2', '  3: l3'].join('\n'))
  })

  it('CRLF / 孤 CR 归一后再按行切', () => {
    expect(extractTodoContext('a\r\nb\rc', 2)).toBe(['  1: a', '> 2: b', '  3: c'].join('\n'))
  })

  it('空内容 / 行号越界 / 非法行号返回 undefined（降级纯定位行）', () => {
    expect(extractTodoContext('', 1)).toBeUndefined()
    expect(extractTodoContext(file, 99)).toBeUndefined()
    expect(extractTodoContext(file, 0)).toBeUndefined()
    expect(extractTodoContext(file, 1.5)).toBeUndefined()
  })

  it('默认半径常量为 2', () => {
    expect(TODO_CONTEXT_RADIUS).toBe(2)
  })
})

describe('buildSingleTodoFixPrompt 单条 prompt', () => {
  it('无上下文：头 + 定位行', () => {
    expect(buildSingleTodoFixPrompt(item('a.ts', 3, '// FIXME: x'), undefined, t))
      .toBe(['todo.fix.headSingle', 'a.ts:3 // FIXME: x'].join('\n'))
  })

  it('有上下文：头 + 定位行 + 上下文标签 + 上下文块', () => {
    expect(buildSingleTodoFixPrompt(item('a.ts', 3, '// TODO: x'), '  2: y', t))
      .toBe(['todo.fix.headSingle', 'a.ts:3 // TODO: x', 'todo.fix.contextLabel', '  2: y'].join('\n'))
  })

  it('上下文整块超 500 字节：降级为纯定位行（定位信息永不丢）', () => {
    const big = 'x'.repeat(600)
    const out = buildSingleTodoFixPrompt(item('a.ts', 3, '// TODO: x'), big, t)
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(BYTE500)
    expect(out).not.toContain(big)
    expect(out).toContain('a.ts:3 // TODO: x')
  })

  it('极端超长标记文本：保头裁剪以 … 尾缀标注（标记词在头部不丢）', () => {
    const out = buildSingleTodoFixPrompt(item('a.ts', 3, `// TODO: ${'y'.repeat(800)}`), undefined, t)
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(BYTE500)
    expect(out.startsWith('todo.fix.headSingle\na.ts:3 // TODO:')).toBe(true)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('buildBatchTodoFixPrompt 批量装箱', () => {
  it('全部装得下：头（n=条数）+ 逐条定位行，omitted=0', () => {
    const items = [item('a.ts', 1, '// TODO: a'), item('b.ts', 2, '// FIXME: b')]
    const r = buildBatchTodoFixPrompt(items, t)
    expect(r).toEqual({
      prompt: ['todo.fix.headBatch', 'a.ts:1 // TODO: a', 'b.ts:2 // FIXME: b'].join('\n'),
      included: 2,
      omitted: 0,
    })
  })

  it('超出 500 字节：贪心装到放不下为止，尾部附分批注记（超额如实告知）', () => {
    const items = Array.from({ length: 30 }, (_, i) =>
      item(`src/deep/dir/file${i}.ts`, i + 1, `// TODO: ${'z'.repeat(60)} ${i}`),
    )
    const r = buildBatchTodoFixPrompt(items, t)
    expect(r.included).toBeGreaterThan(0)
    expect(r.included).toBeLessThan(30)
    expect(r.omitted).toBe(30 - r.included)
    expect(new TextEncoder().encode(r.prompt).length).toBeLessThanOrEqual(BYTE500)
    // 注记是最后一个装配段（在定位行之后）
    expect(r.prompt).toContain('todo.fix.omitted')
    expect(r.prompt.endsWith('todo.fix.omitted')).toBe(true)
    // 保序：先勾选的先装入
    expect(r.prompt).toContain('file0.ts:1')
  })

  it('单条都装不下（超长路径+文本）：退化为第一条保头裁剪，其余计入 omitted', () => {
    const items = [
      item(`very-long/${'d'.repeat(200)}/f.ts`, 1, `// TODO: ${'z'.repeat(600)}`),
      item('b.ts', 2, '// FIXME: b'),
    ]
    const r = buildBatchTodoFixPrompt(items, t)
    expect(r.included).toBe(1)
    expect(r.omitted).toBe(1)
    expect(new TextEncoder().encode(r.prompt).length).toBeLessThanOrEqual(BYTE500)
    expect(r.prompt.startsWith('todo.fix.headSingle\n')).toBe(true)
  })

  it('空列表：prompt 为空、included=0（调用方防御不发起）', () => {
    const r = buildBatchTodoFixPrompt([], t)
    expect(r.included).toBe(0)
    expect(r.omitted).toBe(0)
  })
})

describe('buildBatchTodoFixFullPrompt 批量全文（未装箱）', () => {
  it('批量头（n=全部条数）+ 全部定位行，无分批注记（P-20261006-44 任务文件全文面）', () => {
    const items = [item('a.ts', 1, '// TODO: a'), item('b.ts', 2, '// FIXME: b')]
    expect(buildBatchTodoFixFullPrompt(items, t)).toBe(
      ['todo.fix.headBatch', 'a.ts:1 // TODO: a', 'b.ts:2 // FIXME: b'].join('\n'),
    )
  })
})

describe('useTodoAgentFix 发起链（P-109/P-28 同范式）', () => {
  it('单条 withContext：readFile 提取上下文进 prompt，dir=项目根，成功提示 + docked 打开', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    readFileMock.mockResolvedValue({ data: 'const x = 1\n// FIXME: check null\nconst y = 2' })
    const { handTodosToAgent } = useTodoAgentFix()

    await handTodosToAgent([item('todo.js', 2, '// FIXME: check null')], { withContext: true })

    expect(readFileMock).toHaveBeenCalledWith('p1', 'todo.js', { silent: true })
    const opts = createMock.mock.calls[0]![1]!
    expect(opts.dir).toBe('D:/repo/demo')
    expect(opts.launchArgs).toBe(
      ['请修复此技术债标记：', 'todo.js:2 // FIXME: check null', '上下文：', '  1: const x = 1', '> 2: // FIXME: check null', '  3: const y = 2'].join('\n'),
    )
    expect(messageMock.success).toHaveBeenCalledWith('智能体修复会话已创建（1 处标记）')
    expect(openMock).toHaveBeenCalledWith('docked')
  })

  it('readFile 失败：降级纯定位行仍发起', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    readFileMock.mockRejectedValue(new Error('413'))
    const { handTodosToAgent } = useTodoAgentFix()

    const ok = await handTodosToAgent([item('todo.js', 2, '// FIXME: x')], { withContext: true })

    expect(ok).toBe(true)
    expect(createMock.mock.calls[0]![1]!.launchArgs).toBe('请修复此技术债标记：\ntodo.js:2 // FIXME: x')
  })

  it('批量多条：一次装箱 prompt（不含上下文），成功后返回 true', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { handTodosToAgent } = useTodoAgentFix()

    const ok = await handTodosToAgent([item('a.ts', 1, '// TODO: a'), item('b.ts', 2, '// FIXME: b')])

    expect(ok).toBe(true)
    expect(readFileMock).not.toHaveBeenCalled() // 批量不拉上下文（500 字节装不下）
    const prompt = createMock.mock.calls[0]![1]!.launchArgs as string
    expect(prompt).toContain('a.ts:1 // TODO: a')
    expect(prompt).toContain('b.ts:2 // FIXME: b')
    expect(messageMock.success).toHaveBeenCalledWith('智能体修复会话已创建（2 处标记）')
  })

  it('批量全文超 500 字节：全文落项目根 .sc-task.md，launchArgs 换短引用指令，成功计数为全部条数（P-20261006-44）', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const items = Array.from({ length: 8 }, (_, i) =>
      item(`src/deep/dir/file${i}.ts`, i + 1, `// TODO: ${'z'.repeat(60)} ${i}`),
    )
    const { handTodosToAgent } = useTodoAgentFix()

    const ok = await handTodosToAgent(items)

    expect(ok).toBe(true)
    expect(writeFileMock).toHaveBeenCalledTimes(1)
    const [id, path, content] = writeFileMock.mock.calls[0]!
    expect(id).toBe('p1')
    expect(path).toBe(TASK_FILE_NAME)
    expect(content).toContain('一次性任务载体') // 自述头（可自删语义）
    expect(content).toContain('请修复以下 8 处技术债标记：') // 全量批量头
    expect(content).toContain('file7.ts:8') // 装箱会截掉的末条在场（全量清单）
    const launchArgs = createMock.mock.calls[0]![1]!.launchArgs as string
    expect(launchArgs).toBe(TASK_FILE_LAUNCH_ARGS)
    expect(new TextEncoder().encode(launchArgs).length).toBeLessThanOrEqual(BYTE500)
    expect(messageMock.info).toHaveBeenCalledWith('任务内容超出启动参数上限，已写入项目根 .sc-task.md，智能体将从该文件读取完整任务（任务完成后文件可删）')
    expect(messageMock.success).toHaveBeenCalledWith('智能体修复会话已创建（8 处标记）')
  })

  it('批量超限但任务文件写失败：退回装箱截断 prompt（另有 M 处注记回归）+ warning 提示', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    writeFileMock.mockRejectedValue(new Error('403 project.locked'))
    const items = Array.from({ length: 8 }, (_, i) =>
      item(`src/deep/dir/file${i}.ts`, i + 1, `// TODO: ${'z'.repeat(60)} ${i}`),
    )
    // 与组合式内同源的真语言包 t（顶部 vue-i18n mock 查 zh-CN 插值），装箱
    // 模板文案长度一致才能对出同一份 legacy prompt
    const zh = (await import('../locales/zh-CN')).default
    const get = (o: Record<string, unknown>, k: string): unknown =>
      k.split('.').reduce<unknown>((a, c) => (a as Record<string, unknown> | undefined)?.[c], o)
    const realT: TodoFixTranslator = (key, params) => {
      let s = get(zh as unknown as Record<string, unknown>, key) as string
      for (const [k, v] of Object.entries(params ?? {})) s = s.replaceAll(`{${k}}`, String(v))
      return s
    }
    const legacy = buildBatchTodoFixPrompt(items, realT)
    expect(legacy.omitted).toBeGreaterThan(0) // 前置：该规模装箱确实截断

    const { handTodosToAgent } = useTodoAgentFix()
    const ok = await handTodosToAgent(items)

    expect(ok).toBe(true)
    expect(writeFileMock).toHaveBeenCalledTimes(1)
    const launchArgs = createMock.mock.calls[0]![1]!.launchArgs as string
    expect(launchArgs).toBe(legacy.prompt)
    expect(launchArgs).toContain('另有')
    expect(messageMock.warning).toHaveBeenCalledWith('任务文件写入失败，已按启动参数上限截断发起（上下文可能不完整）')
  })

  it('疑似敏感值：先确认，取消则不建会话（勾选可保留重试）', async () => {
    seedProject()
    const { handTodosToAgent } = useTodoAgentFix()
    confirmMock.mockResolvedValue(false)

    const ok = await handTodosToAgent([item('a.ts', 1, "// TODO: remove password='s3cret'")])

    expect(ok).toBe(false)
    expect(confirmMock).toHaveBeenCalled()
    expect(createMock).not.toHaveBeenCalled()

    confirmMock.mockResolvedValue(true)
    createMock.mockResolvedValue({ id: 'a2', launched: true })
    await expect(handTodosToAgent([item('a.ts', 1, "// TODO: remove password='s3cret'")])).resolves.toBe(true)
    expect(createMock).toHaveBeenCalledTimes(1)
  })

  it('busy 让位 / 无项目 / 空列表：防御性不动作', async () => {
    const { handTodosToAgent } = useTodoAgentFix()

    // 无项目
    await expect(handTodosToAgent([item('a.ts', 1, 'x')])).resolves.toBe(false)
    expect(createMock).not.toHaveBeenCalled()

    // 空列表
    seedProject()
    await expect(handTodosToAgent([], { withContext: true })).resolves.toBe(false)
    expect(createMock).not.toHaveBeenCalled()

    // busy：让位不建会话不打提示
    busyRef.value = true
    await expect(handTodosToAgent([item('a.ts', 1, 'x')])).resolves.toBe(false)
    expect(createMock).not.toHaveBeenCalled()
    expect(messageMock.warning).not.toHaveBeenCalled()
    busyRef.value = false
  })

  it('降级/失败提示语义与 P-109 一致（复用 agent.fix 文案）', async () => {
    seedProject()
    const { handTodosToAgent } = useTodoAgentFix()

    // 服务端降级纯 shell：warning，仍打开 docked
    createMock.mockResolvedValue({ id: 'a2', launched: false })
    await handTodosToAgent([item('a.ts', 1, 'x')])
    expect(messageMock.warning).toHaveBeenCalledWith('未探测到智能体运行时，已创建纯终端会话（上下文未注入）')
    expect(openMock).toHaveBeenCalledWith('docked')

    // create 失败：error 提示，不开 docked，返回 false
    openMock.mockClear()
    createMock.mockResolvedValue(null)
    await expect(handTodosToAgent([item('a.ts', 1, 'x')])).resolves.toBe(false)
    expect(messageMock.error).toHaveBeenCalledWith('智能体会话创建失败')
    expect(openMock).not.toHaveBeenCalled()
  })
})
