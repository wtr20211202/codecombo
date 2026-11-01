import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// ── mock 边界：本组合式的外部依赖只有 ① agent 终端链路（create/open/busy）
// ② naive-ui 离散 message ③ 确认弹窗（敏感场景）④ vue-i18n（真模板：t 直接查
// zh-CN 语言包插值，不复制期望文案，locale 改动即测出）⑤ 任务文件写盘
// （P-20261006-44 超限降级链）──
const { createMock, openMock, messageMock, busyRef, confirmMock, writeFileMock } = vi.hoisted(() => ({
  // 签名对齐 useAgentTerminal.create(name?, opts?)：mock.calls 取参有类型可依
  createMock: vi.fn<(name?: string, opts?: { dir?: string; name?: string; launchArgs?: string }) =>
    Promise<{ id: string; launched: boolean } | null>>(),
  openMock: vi.fn<(target?: string) => Promise<void>>(),
  messageMock: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() },
  busyRef: { value: false },
  confirmMock: vi.fn<(opts?: Record<string, unknown>) => Promise<boolean>>(),
  writeFileMock: vi.fn<(id: string, path: string, content: string, config?: unknown) => Promise<unknown>>(),
}))

vi.mock('./useAgentTerminal', () => ({
  useAgentTerminal: () => ({ busy: busyRef, create: createMock, open: openMock }),
}))

vi.mock('./useDialog', () => ({
  confirmDialog: confirmMock,
}))

vi.mock('../api/client', () => ({
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

import { buildCommitMsgPrompt, buildCommitMsgPromptFull, fitListPrompt, stagedFileLine, statusLetter, useCommitAgentMsg } from './useCommitAgentMsg'
import type { CommitMsgFileEntry } from './useCommitAgentMsg'
import { useProjectStore } from '../stores/project'
import { byteLength, TASK_FILE_LAUNCH_ARGS, TASK_FILE_NAME } from '../utils/promptFit'
import zhCN from '../locales/zh-CN'

const BYTE500 = 500 // 服务端 launchArgs 上限（terminal.go 按字节计）

/** 真 zh-CN 语言包插值（vue-i18n mock 同源；组装器纯函数面的 t 形态） */
function tplKey(key: string, params?: Record<string, unknown>): string {
  const get = (o: Record<string, unknown>, k: string): unknown =>
    k.split('.').reduce<unknown>((a, c) => (a as Record<string, unknown> | undefined)?.[c], o)
  let s = get(zhCN as unknown as Record<string, unknown>, key) as string
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

beforeEach(() => {
  setActivePinia(createPinia())
  vi.resetAllMocks()
  busyRef.value = false
})

describe('statusLetter 短状态字母', () => {
  it('服务端 parseXY 状态词汇全对齐', () => {
    expect(statusLetter('Modified')).toBe('M')
    expect(statusLetter('Added')).toBe('A')
    expect(statusLetter('Deleted')).toBe('D')
    expect(statusLetter('Renamed')).toBe('R')
    expect(statusLetter('Copied')).toBe('C')
    expect(statusLetter('Unmerged')).toBe('U')
    expect(statusLetter('Untracked')).toBe('?')
  })

  it('未知状态回落首字母大写，空串不崩', () => {
    expect(statusLetter('TypeChange')).toBe('T')
    expect(statusLetter('')).toBe('?')
  })
})

describe('stagedFileLine 清单行', () => {
  it('普通条目 = 字母 + 路径；重命名带旧路径', () => {
    expect(stagedFileLine({ path: 'src/app.ts', status: 'Modified' })).toBe('M src/app.ts')
    expect(stagedFileLine({ path: 'src/new.ts', status: 'Renamed', oldPath: 'src/old.ts' }))
      .toBe('R src/old.ts -> src/new.ts')
  })
})

describe('fitListPrompt 清单装箱', () => {
  it('总长不超上限时原样返回', () => {
    const out = fitListPrompt(list => `清单:\n${list}`, ['a.ts', 'b.ts'])
    expect(out).toBe('清单:\na.ts\nb.ts')
  })

  it('超限时整行丢弃保头部、… 尾缀标注，总长收进 500 字节且首行保留末行不保留', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `src/module-${i}/very-long-file-name-${i}.ts`)
    const out = fitListPrompt(list => `固定头：\n${list}`, lines)
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(BYTE500)
    expect(out.startsWith('固定头：\n')).toBe(true)
    expect(out).toContain(lines[0]!)
    expect(out).toContain('…')
    expect(out).not.toContain(lines[lines.length - 1]!)
    // 保留行都是完整行（无截半行伪影）
    for (const line of out.split('\n').slice(1, -1)) {
      expect(lines).toContain(line)
    }
  })

  it('单行超限（极端超长路径）：首行按字符裁尾 + … 标注，仍收进 500 字节', () => {
    const giant = 'src/' + '很长目录'.repeat(200) + '/file.ts'
    const out = fitListPrompt(list => `固定头：\n${list}`, [giant])
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(BYTE500)
    expect(out.startsWith('固定头：\nsrc/')).toBe(true)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('buildCommitMsgPrompt 组装', () => {
  it('固定头（指令 + 清单标题）+ 逐行清单（真 zh 模板）', () => {
    const files: CommitMsgFileEntry[] = [
      { path: 'src/app.ts', status: 'Modified' },
      { path: 'src/new.ts', status: 'Added' },
    ]
    const out = buildCommitMsgPrompt(files, (k) => {
      const zh = {
        'commit.agentMsg.promptHead': '请根据以下暂存变更起草一条 git 提交信息（首行为主题行，简明扼要；只输出提交信息本身，不要额外解释）：',
        'commit.agentMsg.promptListHead': '暂存变更清单（短状态字母 + 路径）：',
      }
      return zh[k as keyof typeof zh] ?? k
    })
    expect(out).toBe(
      '请根据以下暂存变更起草一条 git 提交信息（首行为主题行，简明扼要；只输出提交信息本身，不要额外解释）：\n'
      + '暂存变更清单（短状态字母 + 路径）：\n'
      + 'M src/app.ts\nA src/new.ts',
    )
  })

  it('buildCommitMsgPromptFull 全量装配：清单整体装得下时与装箱版逐字节相等（P-20261006-44）', () => {
    const files: CommitMsgFileEntry[] = [
      { path: 'src/app.ts', status: 'Modified' },
      { path: 'src/old.ts', status: 'Renamed', oldPath: 'src/older.ts' },
    ]
    const zh: Record<string, string> = {
      'commit.agentMsg.promptHead': '头：',
      'commit.agentMsg.promptListHead': '清单：',
    }
    const tt = (k: string) => zh[k] ?? k
    expect(buildCommitMsgPromptFull(files, tt)).toBe(buildCommitMsgPrompt(files, tt))
    // 超限时不再相等：装箱版截断、全文版保留全部行
    const many = Array.from({ length: 40 }, (_, i) => ({ path: `src/module-${i}/very-long-file-name-${i}.ts`, status: 'Modified' }))
    expect(byteLength(buildCommitMsgPrompt(many, tt))).toBeLessThanOrEqual(500)
    expect(buildCommitMsgPromptFull(many, tt)).toContain('module-39')
  })
})

describe('buildCommitMsgPrompt marks 归属行（P-20261005-172）', () => {
  // 真 zh 模板（vue-i18n mock 同源语言包插值，locale 改动即测出）
  const zhT = (key: string, params?: Record<string, unknown>): string => tplKey(key, params)
  function marksLineOf(params: Record<string, unknown>): string {
    return tplKey('commit.agentMsg.marksNote', params)
  }

  it('清单后缀「其中 N 个文件来自 agent 会话改动」，N 只数命中、runtime 并集', () => {
    const files: CommitMsgFileEntry[] = [
      { path: 'src/app.ts', status: 'Modified' },
      { path: 'human.ts', status: 'Modified' },
    ]
    const marks = new Map([['src/app.ts', { sessions: 2, runtimes: ['claude', 'codex'] }]])
    const out = buildCommitMsgPrompt(files, zhT, marks)
    const line = marksLineOf({ n: 1, runtimes: 'claude/codex' })
    expect(out).toContain(line)
    expect(out.endsWith(line)).toBe(true) // 归属行紧贴清单之后
    // Full 与装箱版逐字节相等（清单整体装得下时，P-20261006-44 契约）
    expect(buildCommitMsgPromptFull(files, zhT, marks)).toBe(out)
  })

  it('纯人工改动（无 marks / 无命中）→ 无归属行，形态与既有两段式一致', () => {
    const files: CommitMsgFileEntry[] = [{ path: 'src/app.ts', status: 'Modified' }]
    const noMarks = buildCommitMsgPrompt(files, zhT)
    const otherOnly = new Map([['other.ts', { sessions: 1, runtimes: ['claude'] }]])
    expect(buildCommitMsgPrompt(files, zhT, otherOnly)).toBe(noMarks)
    expect(buildCommitMsgPrompt(files, zhT, new Map())).toBe(noMarks)
    expect(buildCommitMsgPromptFull(files, zhT, otherOnly)).toBe(buildCommitMsgPromptFull(files, zhT))
  })

  it('中间档：清单完整装得下但清单+归属超限 → 归属行整行弃、文件名不截断', () => {
    // 长路径把 bare 形态顶到贴上限（逐字节探测落点，locale 改文案不脆）：
    // bare ≤ 500 < bare + 归属行 的窗口必然存在（归属行 ~80B ≫ 1B 步进）
    const marks: Map<string, { sessions: number; runtimes: string[] }> = new Map()
    let files: CommitMsgFileEntry[] = []
    for (let pad = 100; pad < 500; pad++) {
      files = [{ path: `src/${'p'.repeat(pad)}.ts`, status: 'Modified' }]
      marks.set(files[0]!.path, { sessions: 1, runtimes: ['claude'] })
      const bare = buildCommitMsgPrompt(files, zhT)
      const full = buildCommitMsgPromptFull(files, zhT, marks)
      if (byteLength(bare) <= BYTE500 && byteLength(full) > BYTE500) break
    }
    expect(byteLength(buildCommitMsgPrompt(files, zhT))).toBeLessThanOrEqual(BYTE500)
    expect(byteLength(buildCommitMsgPromptFull(files, zhT, marks))).toBeGreaterThan(BYTE500)
    const out = buildCommitMsgPrompt(files, zhT, marks)
    expect(out).not.toContain(marksLineOf({ n: 1, runtimes: 'claude' })) // 归属行整行弃
    expect(out).toContain(files[0]!.path) // 文件名完整保留（未进入清单截断）
    expect(out).not.toContain('…')
  })

  it('装箱截断路径归属行恒缺席：截断保文件名（任务书②）', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ path: `src/module-${i}/very-long-file-name-${i}.ts`, status: 'Modified' }))
    const marksAll = new Map(many.map(f => [f.path, { sessions: 1, runtimes: ['claude'] }]))
    const out = buildCommitMsgPrompt(many, zhT, marksAll)
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(BYTE500)
    expect(out).not.toContain(marksLineOf({ n: 40, runtimes: 'claude' }))
    expect(out).toContain('module-0') // 保头
    expect(out).toContain('…') // 截断注记在场
    expect(out).not.toContain('module-39')
  })
})

describe('useCommitAgentMsg 发起链路（P-28 同款：create → 提示 → open docked）', () => {
  it('成功：dir=项目根，prompt 含暂存文件名，成功提示 + docked 打开', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { generateCommitMsg } = useCommitAgentMsg()

    await generateCommitMsg([{ path: 'src/app.ts', status: 'Modified' }, { path: 'added.ts', status: 'Added' }])

    expect(createMock).toHaveBeenCalledTimes(1)
    expect(createMock.mock.calls[0]![0]).toBeUndefined() // runtime 取设置默认
    const opts = createMock.mock.calls[0]![1]!
    expect(opts.dir).toBe('D:/repo/demo')
    expect(opts.launchArgs).toContain('src/app.ts')
    expect(opts.launchArgs).toContain('added.ts')
    expect(new TextEncoder().encode(opts.launchArgs!).length).toBeLessThanOrEqual(BYTE500)
    expect(messageMock.success).toHaveBeenCalled()
    expect(openMock).toHaveBeenCalledWith('docked')
  })

  it('marks 传入 → launchArgs 附归属行（P-20261005-172；纯人工清单无该行）', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { generateCommitMsg } = useCommitAgentMsg()
    const marks = new Map([
      ['src/app.ts', { sessions: 1, runtimes: ['shell'] }],
    ])

    await generateCommitMsg([{ path: 'src/app.ts', status: 'Modified' }, { path: 'human.ts', status: 'Modified' }], marks)

    const launchArgs = createMock.mock.calls[0]![1]!.launchArgs!
    expect(launchArgs).toContain('src/app.ts')
    expect(launchArgs).toContain('human.ts')
    expect(launchArgs).toContain(tplKey('commit.agentMsg.marksNote', { n: 1, runtimes: 'shell' }))
    expect(new TextEncoder().encode(launchArgs).length).toBeLessThanOrEqual(BYTE500)

    // 无命中（纯人工）：照常发起，无归属行
    createMock.mockClear()
    await generateCommitMsg([{ path: 'src/app.ts', status: 'Modified' }], new Map([['other.ts', { sessions: 1, runtimes: ['shell'] }]]))
    expect(createMock.mock.calls[0]![1]!.launchArgs).not.toContain(tplKey('commit.agentMsg.marksNote', { n: 1, runtimes: 'shell' }))
  })

  it('空清单/无项目：防御性不动作（不建会话）', async () => {
    const { generateCommitMsg } = useCommitAgentMsg()
    await generateCommitMsg([])
    expect(createMock).not.toHaveBeenCalled()

    // 无项目的干净 pinia（组合式在 setup 期捕获 store，须重新获取）
    setActivePinia(createPinia())
    const { generateCommitMsg: genNoProject } = useCommitAgentMsg()
    await genNoProject([{ path: 'a.ts', status: 'Modified' }])
    expect(createMock).not.toHaveBeenCalled()
  })

  it('busy 让位与降级/失败提示语义', async () => {
    seedProject()
    const { generateCommitMsg } = useCommitAgentMsg()

    // busy：直接让位，不建会话不打提示
    busyRef.value = true
    await generateCommitMsg([{ path: 'a.ts', status: 'Modified' }])
    expect(createMock).not.toHaveBeenCalled()
    expect(messageMock.warning).not.toHaveBeenCalled()
    busyRef.value = false

    // 服务端降级纯 shell（launched=false）：warning 提示，仍打开 docked
    createMock.mockResolvedValue({ id: 'a2', launched: false })
    await generateCommitMsg([{ path: 'a.ts', status: 'Modified' }])
    expect(messageMock.warning).toHaveBeenCalled()
    expect(openMock).toHaveBeenCalledWith('docked')

    // create 失败（返回 null）：error 提示，不开 docked
    openMock.mockClear()
    createMock.mockResolvedValue(null)
    await generateCommitMsg([{ path: 'a.ts', status: 'Modified' }])
    expect(messageMock.error).toHaveBeenCalled()
    expect(openMock).not.toHaveBeenCalled()
  })

  it('敏感场景确认（P-109 口径）：取消 = 不创建；确认 = 照常发起', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { generateCommitMsg } = useCommitAgentMsg()

    // 路径内嵌 GitHub token 形态 → containsSensitiveValue 命中 → 先弹确认
    const files = [{ path: 'creds/ghp_abcdefghijklmnopq1234.txt', status: 'Added' }]

    confirmMock.mockResolvedValue(false)
    await generateCommitMsg(files)
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(createMock).not.toHaveBeenCalled()

    confirmMock.mockResolvedValue(true)
    await generateCommitMsg(files)
    expect(createMock).toHaveBeenCalledTimes(1)
    expect(createMock.mock.calls[0]![1]!.launchArgs).toContain('ghp_abcdefghijklmnopq1234.txt')
  })

  it('无敏感值：不弹确认直接发起', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { generateCommitMsg } = useCommitAgentMsg()

    await generateCommitMsg([{ path: 'src/app.ts', status: 'Modified' }])
    expect(confirmMock).not.toHaveBeenCalled()
    expect(createMock).toHaveBeenCalledTimes(1)
  })

  it('清单超 500 字节：全量清单落项目根 .sc-task.md，launchArgs 换短引用指令（P-20261006-44）', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const files = Array.from({ length: 40 }, (_, i) => ({ path: `src/module-${i}/very-long-file-name-${i}.ts`, status: 'Modified' }))
    const { generateCommitMsg } = useCommitAgentMsg()

    await generateCommitMsg(files)

    expect(writeFileMock).toHaveBeenCalledTimes(1)
    const [id, path, content] = writeFileMock.mock.calls[0]!
    expect(id).toBe('p1')
    expect(path).toBe(TASK_FILE_NAME)
    expect(content).toContain('一次性任务载体')
    expect(content).toContain('M src/module-39/very-long-file-name-39.ts') // 装箱必截的末条在场
    const launchArgs = createMock.mock.calls[0]![1]!.launchArgs as string
    expect(launchArgs).toBe(TASK_FILE_LAUNCH_ARGS)
    expect(messageMock.info).toHaveBeenCalledWith('任务内容超出启动参数上限，已写入项目根 .sc-task.md，智能体将从该文件读取完整任务（任务完成后文件可删）')
    expect(messageMock.success).toHaveBeenCalled()
  })

  it('超限且任务文件写失败：退回装箱截断 prompt + warning 提示（发起不中断）', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    writeFileMock.mockRejectedValue(new Error('403'))
    const files = Array.from({ length: 40 }, (_, i) => ({ path: `src/module-${i}/very-long-file-name-${i}.ts`, status: 'Modified' }))
    const legacy = buildCommitMsgPrompt(files, (k) => {
      const zh: Record<string, string> = {
        'commit.agentMsg.promptHead': '请根据以下暂存变更起草一条 git 提交信息（首行为主题行，简明扼要；只输出提交信息本身，不要额外解释）：',
        'commit.agentMsg.promptListHead': '暂存变更清单（短状态字母 + 路径）：',
      }
      return zh[k] ?? k
    })
    const { generateCommitMsg } = useCommitAgentMsg()

    await generateCommitMsg(files)

    expect(createMock.mock.calls[0]![1]!.launchArgs).toBe(legacy)
    expect(createMock.mock.calls[0]![1]!.launchArgs).toContain('…')
    expect(messageMock.warning).toHaveBeenCalledWith('任务文件写入失败，已按启动参数上限截断发起（上下文可能不完整）')
  })
})
