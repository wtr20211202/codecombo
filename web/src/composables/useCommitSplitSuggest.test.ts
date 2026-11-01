import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// ── mock 边界（useCommitAgentMsg.test.ts 同款）：① agent 终端链路 ② naive-ui
// 离散 message ③ 确认弹窗（敏感场景）④ vue-i18n（真模板：t 直接查 zh-CN 语言包
// 插值，locale 改动即测出）⑤ 任务文件写盘（P-20261006-44 超限降级链） ──
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
        // 字面花括号转义还原（{'{'} / {'}'}）：模拟 vue-i18n 消息编译的字面量段
        //（promptFormat 的 JSON 示例 P-20261003-278 起带转义花括号）
        s = s.replaceAll("{'{'}", '{').replaceAll("{'}'}", '}')
        for (const [k, v] of Object.entries(params ?? {})) s = s.replaceAll(`{${k}}`, String(v))
        return s
      },
    }),
  }
})

import { buildSplitSuggestPrompt, buildSplitSuggestPromptFull, useCommitSplitSuggest } from './useCommitSplitSuggest'
import type { CommitMsgFileEntry } from './useCommitAgentMsg'
import zhCN from '../locales/zh-CN'
import { useProjectStore } from '../stores/project'
import { TASK_FILE_LAUNCH_ARGS, TASK_FILE_NAME } from '../utils/promptFit'

/** 真语言包 t（类型收窄到 string 叶子）：与顶部 vue-i18n mock 同一数据源 */
function realT(k: string): string {
  let s = k.split('.').reduce<unknown>((a, c) => (a as Record<string, unknown> | undefined)?.[c], zhCN as unknown as Record<string, unknown>) as string
  // 字面花括号转义还原（同顶部 mock 的编译模拟）：promptFormat 的 JSON 示例
  s = s.replaceAll("{'{'}", '{').replaceAll("{'}'}", '}')
  return s
}

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
  busyRef.value = false
})

describe('buildSplitSuggestPrompt 组装（真 zh 模板）', () => {
  const files: CommitMsgFileEntry[] = [
    { path: 'web/src/app.ts', status: 'Modified' },
    { path: 'web/src/new.ts', status: 'Added' },
  ]

  it('固定头（指令 + 结构化输出格式 + 清单标题）+ 逐行清单', () => {
    // promptFormat 行（P-20261003-278 结构化输出约定）取真语言包原文
    const formatLine = realT('commit.splitSuggest.promptFormat')
    const out = buildSplitSuggestPrompt(files, (k) => {
      const zh = {
        'commit.splitSuggest.promptHead': '把以下暂存变更按主题拆成多次提交：先自行 git diff 查看全量再分组；每组给出组名、文件清单、commit 主题。仅输出建议，勿执行 git add/commit 等写操作。',
        'commit.splitSuggest.promptFormat': formatLine,
        'commit.splitSuggest.promptListHead': '暂存变更清单（短状态字母 + 路径，可能截断）：',
      }
      return zh[k as keyof typeof zh] ?? k
    })
    expect(out).toBe(
      '把以下暂存变更按主题拆成多次提交：先自行 git diff 查看全量再分组；每组给出组名、文件清单、commit 主题。仅输出建议，勿执行 git add/commit 等写操作。\n'
      + formatLine + '\n'
      + '暂存变更清单（短状态字母 + 路径，可能截断）：\n'
      + 'M web/src/app.ts\nA web/src/new.ts',
    )
  })

  it('安全边界注记恒在场：仅建议 + 勿执行 git add/commit（清单截断也不丢固定头）', () => {
    // 真语言包模板
    const full = buildSplitSuggestPrompt(files, realT)
    expect(full).toContain('仅输出建议')
    expect(full).toContain('勿执行 git add/commit')
    expect(full).toContain('组名')
    expect(full).toContain('commit 主题')

    // 超大清单触发截断：固定头（含安全注记与结构化输出格式行）依然完整保留
    const many = Array.from({ length: 40 }, (_, i) => ({ path: `src/module-${i}/very-long-file-name-${i}.ts`, status: 'Modified' }))
    const truncated = buildSplitSuggestPrompt(many, (k) => {
      const zh = {
        'commit.splitSuggest.promptHead': '把以下暂存变更按主题拆成多次提交：先自行 git diff 查看全量再分组；每组给出组名、文件清单、commit 主题。仅输出建议，勿执行 git add/commit 等写操作。',
        'commit.splitSuggest.promptFormat': realT('commit.splitSuggest.promptFormat'),
        'commit.splitSuggest.promptListHead': '暂存变更清单（短状态字母 + 路径，可能截断）：',
      }
      return zh[k as keyof typeof zh] ?? k
    })
    expect(new TextEncoder().encode(truncated).length).toBeLessThanOrEqual(BYTE500)
    expect(truncated).toContain('勿执行 git add/commit')
    expect(truncated).toContain('"groups"')
    expect(truncated).toContain('…')
    expect(truncated).not.toContain(many[many.length - 1]!.path)
  })
})

describe('useCommitSplitSuggest 发起链路（P-138 同款：create → 提示 → open docked）', () => {
  it('成功：dir=项目根，prompt 含暂存文件名与分组指令，成功提示 + docked 打开', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { suggestCommitSplit } = useCommitSplitSuggest()

    await suggestCommitSplit([{ path: 'web/src/app.ts', status: 'Modified' }, { path: 'server/main.go', status: 'Added' }])

    expect(createMock).toHaveBeenCalledTimes(1)
    expect(createMock.mock.calls[0]![0]).toBeUndefined() // runtime 取设置默认
    const opts = createMock.mock.calls[0]![1]!
    expect(opts.dir).toBe('D:/repo/demo')
    expect(opts.launchArgs).toContain('web/src/app.ts')
    expect(opts.launchArgs).toContain('server/main.go')
    expect(opts.launchArgs).toContain('组名')
    expect(opts.launchArgs).toContain('commit 主题')
    expect(new TextEncoder().encode(opts.launchArgs!).length).toBeLessThanOrEqual(BYTE500)
    expect(messageMock.success).toHaveBeenCalled()
    expect(openMock).toHaveBeenCalledWith('docked')
  })

  it('空清单/无项目：防御性不动作（不建会话）', async () => {
    const { suggestCommitSplit } = useCommitSplitSuggest()
    await suggestCommitSplit([])
    expect(createMock).not.toHaveBeenCalled()

    // 无项目的干净 pinia（组合式在 setup 期捕获 store，须重新获取）
    setActivePinia(createPinia())
    const { suggestCommitSplit: genNoProject } = useCommitSplitSuggest()
    await genNoProject([{ path: 'a.ts', status: 'Modified' }])
    expect(createMock).not.toHaveBeenCalled()
  })

  it('busy 让位与降级/失败提示语义', async () => {
    seedProject()
    const { suggestCommitSplit } = useCommitSplitSuggest()

    // busy：直接让位，不建会话不打提示
    busyRef.value = true
    await suggestCommitSplit([{ path: 'a.ts', status: 'Modified' }])
    expect(createMock).not.toHaveBeenCalled()
    expect(messageMock.warning).not.toHaveBeenCalled()
    busyRef.value = false

    // 服务端降级纯 shell（launched=false）：warning 提示，仍打开 docked
    createMock.mockResolvedValue({ id: 'a2', launched: false })
    await suggestCommitSplit([{ path: 'a.ts', status: 'Modified' }])
    expect(messageMock.warning).toHaveBeenCalled()
    expect(openMock).toHaveBeenCalledWith('docked')

    // create 失败（返回 null）：error 提示，不开 docked
    openMock.mockClear()
    createMock.mockResolvedValue(null)
    await suggestCommitSplit([{ path: 'a.ts', status: 'Modified' }])
    expect(messageMock.error).toHaveBeenCalled()
    expect(openMock).not.toHaveBeenCalled()
  })

  it('敏感场景确认（P-109 口径）：取消 = 不创建；确认 = 照常发起', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { suggestCommitSplit } = useCommitSplitSuggest()

    // 路径内嵌 GitHub token 形态 → containsSensitiveValue 命中 → 先弹确认
    const files = [{ path: 'creds/ghp_abcdefghijklmnopq1234.txt', status: 'Added' }]

    confirmMock.mockResolvedValue(false)
    await suggestCommitSplit(files)
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(createMock).not.toHaveBeenCalled()

    confirmMock.mockResolvedValue(true)
    await suggestCommitSplit(files)
    expect(createMock).toHaveBeenCalledTimes(1)
    expect(createMock.mock.calls[0]![1]!.launchArgs).toContain('ghp_abcdefghijklmnopq1234.txt')
  })

  it('无敏感值：不弹确认直接发起', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const { suggestCommitSplit } = useCommitSplitSuggest()

    await suggestCommitSplit([{ path: 'src/app.ts', status: 'Modified' }])
    expect(confirmMock).not.toHaveBeenCalled()
    expect(createMock).toHaveBeenCalledTimes(1)
  })

  it('清单超 500 字节：全量清单落项目根 .sc-task.md，launchArgs 换短引用指令（P-20261006-44）', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const files = Array.from({ length: 40 }, (_, i) => ({ path: `src/module-${i}/very-long-file-name-${i}.ts`, status: 'Modified' }))
    const { suggestCommitSplit } = useCommitSplitSuggest()

    await suggestCommitSplit(files)

    expect(writeFileMock).toHaveBeenCalledTimes(1)
    const [id, path, content] = writeFileMock.mock.calls[0]!
    expect(id).toBe('p1')
    expect(path).toBe(TASK_FILE_NAME)
    expect(content).toContain('一次性任务载体')
    expect(content).toContain('M src/module-39/very-long-file-name-39.ts') // 全量清单（装箱必截的末条在场）
    const launchArgs = createMock.mock.calls[0]![1]!.launchArgs as string
    expect(launchArgs).toBe(TASK_FILE_LAUNCH_ARGS)
    expect(messageMock.info).toHaveBeenCalledWith('任务内容超出启动参数上限，已写入项目根 .sc-task.md，智能体将从该文件读取完整任务（任务完成后文件可删）')
    expect(openMock).toHaveBeenCalledWith('docked')
  })

  it('超限且任务文件写失败：退回装箱截断（… 注记回归）+ warning 提示', async () => {
    seedProject()
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    writeFileMock.mockRejectedValue(new Error('500'))
    const files = Array.from({ length: 40 }, (_, i) => ({ path: `src/module-${i}/very-long-file-name-${i}.ts`, status: 'Modified' }))
    const { suggestCommitSplit } = useCommitSplitSuggest()

    await suggestCommitSplit(files)

    const launchArgs = createMock.mock.calls[0]![1]!.launchArgs as string
    expect(new TextEncoder().encode(launchArgs).length).toBeLessThanOrEqual(BYTE500)
    expect(launchArgs).toContain('…')
    expect(messageMock.warning).toHaveBeenCalledWith('任务文件写入失败，已按启动参数上限截断发起（上下文可能不完整）')
  })
})
