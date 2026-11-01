import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// ── mock 边界（usePrDescription.test.ts 同款）：① agent 终端链路 ② naive-ui
// 离散 message ③ 确认弹窗（敏感场景）④ vue-i18n（真模板：t 直接查 zh-CN 语言
// 包插值，不复制期望文案，locale 改动即测出）。无 /log 依赖——本组合式数据面
// 仅 marks+diffstat（调用方注入），changes store 用真 pinia 实例承载 canSuggest ──
const { createMock, openMock, messageMock, busyRef, confirmMock } = vi.hoisted(() => ({
  // 签名对齐 useAgentTerminal.create(name?, opts?)：mock.calls 取参有类型可依
  createMock: vi.fn<(name?: string, opts?: { dir?: string; name?: string; launchArgs?: string }) =>
    Promise<{ id: string; launched: boolean } | null>>(),
  openMock: vi.fn<(target?: string) => Promise<void>>(),
  messageMock: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
  busyRef: { value: false },
  confirmMock: vi.fn<(opts?: Record<string, unknown>) => Promise<boolean>>(),
}))

vi.mock('./useAgentTerminal', () => ({
  useAgentTerminal: () => ({ busy: busyRef, create: createMock, open: openMock }),
}))

vi.mock('./useDialog', () => ({
  confirmDialog: confirmMock,
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

import { buildSuggestTestsPrompt, useSuggestTests } from './useSuggestTests'
import type { SuggestTestsInput } from './useSuggestTests'
import { useProjectStore } from '../stores/project'
import { useChangesStore } from '../stores/changes'
import zhMessages from '../locales/zh-CN'

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

function seedChanges(paths: string[]) {
  const store = useChangesStore()
  store.files = paths.map(p => ({ path: p, status: 'Modified', staged: false }))
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

describe('buildSuggestTestsPrompt 组装与装箱', () => {
  const base: SuggestTestsInput = {
    marks: marksOf({ 'src/app.ts': { sessions: 2, runtimes: ['claude'] }, 'README.md': { runtimes: [] } }),
    stat: { additions: 12, deletions: 3 },
  }

  it('全量装配：指令头 + marks 节 + diffstat 行（真 zh 模板）', () => {
    const out = buildSuggestTestsPrompt(base, T)
    expect(out).toBe([
      T('commit.suggestTests.promptHead'),
      T('commit.suggestTests.marksHead'),
      '- README.md (未知运行时)\n- src/app.ts (claude) ×2',
      T('commit.suggestTests.statLine', { a: 12, d: 3 }),
    ].join('\n'))
  })

  it('空节省略：marks 空不出清单节，diffstat 行恒在场', () => {
    const out = buildSuggestTestsPrompt({ marks: new Map(), stat: { additions: 0, deletions: 0 } }, T)
    expect(out).toBe([T('commit.suggestTests.promptHead'), T('commit.suggestTests.statLine', { a: 0, d: 0 })].join('\n'))
  })

  it('纯建议安全边界在指令头：不写测试文件 + 人工确认后另行发起 + 输出三要素', () => {
    const out = buildSuggestTestsPrompt(base, T)
    expect(out).toContain('勿编写或修改测试文件')
    expect(out).toContain('人工确认后另行发起')
    expect(out).toContain('文件 / 测试点 / 优先级')
  })

  it('marks 清单超限：交 fitListPrompt 按 P-138 惯例装箱（保头 + …），总长 ≤500 字节', () => {
    const marks = marksOf(Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`src/module-${i}/very-long-agent-output-file-name-${i}.ts`, {}]),
    ))
    const out = buildSuggestTestsPrompt({ marks, stat: base.stat }, T)
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(BYTE500)
    expect(out).toContain(T('commit.suggestTests.promptHead'))
    expect(out).toContain('src/module-0/') // 保头：首行保留
    expect(out).toContain('…')
    expect(out).toContain(T('commit.suggestTests.statLine', { a: 12, d: 3 })) // 固定短行恒在场
    expect(out).not.toContain('module-39') // 尾部整行丢弃
  })
})

describe('useSuggestTests 发起链路（usePrDescription 同范式：create → 提示 → open docked）', () => {
  it('成功：dir=项目根，launchArgs 含 marks 路径、diffstat 与模板结构，成功提示 + docked 打开', async () => {
    seedProject()
    seedChanges(['src/app.ts'])
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const state = useSuggestTests({
      marks: { value: marksOf({ 'src/app.ts': {} }) },
      stat: { value: { additions: 5, deletions: 1 } },
    })
    expect(state.canSuggest).toBe(true)

    await state.suggestMissingTests()

    expect(createMock).toHaveBeenCalledTimes(1)
    expect(createMock.mock.calls[0]![0]).toBeUndefined() // runtime 取设置默认
    const opts = createMock.mock.calls[0]![1]!
    expect(opts.dir).toBe('D:/repo/demo')
    // 模板结构三要素 + marks 清单 + diffstat 逐一在场
    expect(opts.launchArgs).toContain('文件 / 测试点 / 优先级')
    expect(opts.launchArgs).toContain('勿编写或修改测试文件')
    expect(opts.launchArgs).toContain('src/app.ts')
    expect(opts.launchArgs).toContain('+5 / -1')
    expect(new TextEncoder().encode(opts.launchArgs!).length).toBeLessThanOrEqual(BYTE500)
    expect(messageMock.success).toHaveBeenCalled()
    expect(openMock).toHaveBeenCalledWith('docked')
  })

  it('canSuggest 门控：无变更 / 无项目根 → 防御性不动作（不建会话）', async () => {
    // 有项目、无变更
    const projectStore = seedProject()
    seedChanges([])
    const empty = useSuggestTests({
      marks: { value: marksOf({ 'a.ts': {} }) },
      stat: { value: { additions: 1, deletions: 0 } },
    })
    expect(empty.canSuggest).toBe(false)
    await empty.suggestMissingTests()

    // 无项目、有变更（同一 pinia 实例内清当前项目，模拟切到无项目态）
    seedChanges(['a.ts'])
    projectStore.currentProjectId = ''
    const noProject = useSuggestTests({
      marks: { value: marksOf({ 'a.ts': {} }) },
      stat: { value: { additions: 1, deletions: 0 } },
    })
    expect(noProject.canSuggest).toBe(false)
    await noProject.suggestMissingTests()

    expect(createMock).not.toHaveBeenCalled()
    expect(openMock).not.toHaveBeenCalled()
  })

  it('busy 让位与降级/失败提示语义', async () => {
    seedProject()
    seedChanges(['a.ts'])
    const state = useSuggestTests({
      marks: { value: marksOf({ 'a.ts': {} }) },
      stat: { value: { additions: 1, deletions: 0 } },
    })

    // busy：直接让位，不建会话不打提示
    busyRef.value = true
    await state.suggestMissingTests()
    expect(createMock).not.toHaveBeenCalled()
    expect(messageMock.warning).not.toHaveBeenCalled()
    busyRef.value = false

    // 服务端降级纯 shell（launched=false）：warning 提示，仍打开 docked
    createMock.mockResolvedValue({ id: 'a3', launched: false })
    await state.suggestMissingTests()
    expect(messageMock.warning).toHaveBeenCalled()
    expect(openMock).toHaveBeenCalledWith('docked')

    // create 失败（返回 null）：error 提示（suggestTests 专属文案），不开 docked
    openMock.mockClear()
    createMock.mockResolvedValue(null)
    await state.suggestMissingTests()
    expect(messageMock.error).toHaveBeenCalled()
    expect(openMock).not.toHaveBeenCalled()
  })

  it('敏感场景确认（P-109 口径）：取消 = 不创建；确认 = 照常发起', async () => {
    seedProject()
    seedChanges(['creds/token.txt'])
    createMock.mockResolvedValue({ id: 'a1', launched: true })
    const state = useSuggestTests({
      // 路径内嵌 GitHub token 形态 → containsSensitiveValue 命中 → 先弹确认
      marks: { value: marksOf({ 'creds/ghp_abcdefghijklmnopq1234.txt': {} }) },
      stat: { value: { additions: 1, deletions: 0 } },
    })

    confirmMock.mockResolvedValue(false)
    await state.suggestMissingTests()
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(createMock).not.toHaveBeenCalled()

    confirmMock.mockResolvedValue(true)
    await state.suggestMissingTests()
    expect(createMock).toHaveBeenCalledTimes(1)
    expect(createMock.mock.calls[0]![1]!.launchArgs).toContain('ghp_abcdefghijklmnopq1234.txt')
  })
})
