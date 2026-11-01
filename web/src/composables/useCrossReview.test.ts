import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// ── mock 边界：本组合式的外部依赖只有 ① agent 终端链路（create/open/busy）
// ② naive-ui 离散 message ③ 确认弹窗（敏感场景）④ 产出 activity API ⑤
// vue-i18n（真模板：t 直接查 zh-CN 语言包插值，不复制期望文案，locale 改动即测出） ──
const { createMock, openMock, messageMock, busyRef, confirmMock, activityMock } = vi.hoisted(() => ({
  // 签名对齐 useAgentTerminal.create(runtime?, opts?)：mock.calls 取参有类型可依
  createMock: vi.fn<(runtime?: string, opts?: { dir?: string; launchArgs?: string }) =>
    Promise<{ id: string; launched: boolean } | null>>(),
  openMock: vi.fn<(target?: string) => Promise<void>>(),
  messageMock: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
  busyRef: { value: false },
  confirmMock: vi.fn<(opts?: Record<string, unknown>) => Promise<boolean>>(),
  activityMock: vi.fn<(id: string, config?: Record<string, unknown>) => Promise<unknown>>(),
}))

vi.mock('./useAgentTerminal', () => ({
  useAgentTerminal: () => ({ busy: busyRef, create: createMock, open: openMock }),
}))

vi.mock('./useDialog', () => ({
  confirmDialog: confirmMock,
}))

vi.mock('../api/domains/terminal', () => ({
  terminalApi: { activity: activityMock },
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

import {
  buildCrossReviewPrompt,
  defaultCrossReviewTarget,
  isMainTreeSession,
  openCrossReview,
  useCrossReview,
} from './useCrossReview'
import type { CrossReviewSource } from './useCrossReview'
import { useProjectStore } from '../stores/project'
import zhLocale from '../locales/zh-CN'

const BYTE500 = 500 // 服务端 launchArgs 上限（terminal.go 按字节计）

/** 期望文案直接查 zh-CN 语言包插值（同 mock 的 t 实现）——断言不复制文案，
 *  locale 改动即测出；本文件源会话名等测试字面量用 ASCII，免编码链路 */
function zh(key: string, params?: Record<string, unknown>): string {
  const get = (o: Record<string, unknown>, k: string): unknown =>
    k.split('.').reduce<unknown>((a, c) => (a as Record<string, unknown> | undefined)?.[c], o)
  let s = get(zhLocale as unknown as Record<string, unknown>, key) as string
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

function seedSource(overrides: Partial<CrossReviewSource> = {}): CrossReviewSource {
  return { id: 's1', name: 'Session-One', runtime: 'claude', dir: 'D:/repo/demo', ...overrides }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.resetAllMocks()
  busyRef.value = false
  // 模块级单例状态复位（openCrossReview 直写 source/show，防跨用例串扰）
  openCrossReview({ id: '', name: '', runtime: '' })
  useCrossReview().close()
})

describe('isMainTreeSession 主树归属（useAgentMarks 既有边界同口径）', () => {
  it('cwd 归一化后等于项目根才算主树（反斜杠/尾斜杠不破判定）', () => {
    expect(isMainTreeSession('D:/repo/demo', 'D:/repo/demo')).toBe(true)
    expect(isMainTreeSession('D:\\repo\\demo\\', 'D:/repo/demo')).toBe(true)
    expect(isMainTreeSession('D:/repo/demo', 'D:/repo/demo/')).toBe(true)
  })

  it('worktree 会话/空目录/无当前项目不算主树', () => {
    expect(isMainTreeSession('D:/repo/demo-wt', 'D:/repo/demo')).toBe(false)
    expect(isMainTreeSession(undefined, 'D:/repo/demo')).toBe(false)
    expect(isMainTreeSession('', 'D:/repo/demo')).toBe(false)
    expect(isMainTreeSession('D:/repo/demo', '')).toBe(false)
  })
})

describe('defaultCrossReviewTarget 非源 runtime 默认值', () => {
  const opts = [
    { name: 'claude', available: true },
    { name: 'codex', available: false },
    { name: 'dsh', available: true },
  ]

  it('首个可用且 ≠ 源 runtime 的项；源不可用不误判排除', () => {
    expect(defaultCrossReviewTarget(opts, 'claude')).toBe('dsh')
    expect(defaultCrossReviewTarget(opts, 'codex')).toBe('claude')
    expect(defaultCrossReviewTarget(opts, 'dsh')).toBe('claude')
  })

  it('源未知（空/auto）不排除，无命中回落 auto', () => {
    expect(defaultCrossReviewTarget(opts, '')).toBe('claude')
    expect(defaultCrossReviewTarget(opts, 'auto')).toBe('claude')
    expect(defaultCrossReviewTarget([{ name: 'claude', available: false }], 'claude')).toBe('auto')
    expect(defaultCrossReviewTarget([], '')).toBe('auto')
  })
})

describe('buildCrossReviewPrompt 审查 prompt 组装', () => {
  // 纯函数只认翻译面：桩 t 用可识别的 ASCII 哨兵，断言清单头/引导语路由正确
  const t = ((key: string, params?: Record<string, unknown>) => {
    let s = key
    if (key === 'review.cross.promptHead') s = `HEAD<${String(params?.name)}>`
    if (key === 'review.cross.promptListHeadMain') s = 'LIST-MAIN'
    if (key === 'review.cross.promptListHeadDir') s = 'LIST-DIR'
    if (key === 'review.cross.promptNoOutput') s = 'NO-OUTPUT'
    return s
  }) as (key: string, params?: Record<string, unknown>) => string

  it('产出清单逐行「状态 + 路径」，主树口径走主树清单头', () => {
    const p = buildCrossReviewPrompt({
      name: 'Session-One',
      files: [{ status: 'M', path: 'src/a.ts' }, { status: '?', path: 'src/b.ts' }],
      inMainTree: true,
      t,
    })
    expect(p).toContain('HEAD<Session-One>')
    expect(p).toContain('LIST-MAIN')
    expect(p).not.toContain('LIST-DIR')
    expect(p).toContain('M src/a.ts')
    expect(p).toContain('? src/b.ts')
  })

  it('worktree 会话（inMainTree=false）按会话目录口径，不伪称主树', () => {
    const p = buildCrossReviewPrompt({ name: 'wt', files: [{ status: 'M', path: 'a.ts' }], inMainTree: false, t })
    expect(p).toContain('LIST-DIR')
    expect(p).not.toContain('LIST-MAIN')
    expect(p).toContain('M a.ts')
  })

  it('无产出给引导语（审查会话 cwd=源目录可自行核查工作区）', () => {
    const p = buildCrossReviewPrompt({ name: 'empty', files: [], inMainTree: true, t })
    expect(p).toContain('NO-OUTPUT')
    expect(p).not.toContain('LIST-MAIN')
    expect(p).not.toContain('LIST-DIR')
  })

  it('超长清单装进 500 字节上限（fitListPrompt 保头部行）', () => {
    const files = Array.from({ length: 40 }, (_, i) => ({ status: 'M', path: `src/deep/nested/dir/file-${i}.ts` }))
    const p = buildCrossReviewPrompt({ name: 'Session-One', files, inMainTree: true, t })
    expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(BYTE500)
    expect(p).toContain('M src/deep/nested/dir/file-0.ts') // 头部行优先保留
    expect(p).toContain('…') // 尾缀标注省略
    expect(p).not.toContain('file-39.ts') // 尾部整行丢弃
  })
})

describe('useCrossReview 发起链', () => {
  it('发起：cwd=源会话目录 + prompt 含产出文件 + auto 传空 runtime + 打开 docked', async () => {
    seedProject('D:/repo/demo')
    activityMock.mockResolvedValue({ data: { files: [{ status: 'M', path: 'src/a.ts' }] } })
    createMock.mockResolvedValue({ id: 'new1', launched: true })

    openCrossReview(seedSource())
    const { launch } = useCrossReview()
    await launch('auto')

    expect(activityMock).toHaveBeenCalledWith('s1', { silent: true })
    expect(createMock).toHaveBeenCalledTimes(1)
    const [runtime, opts] = createMock.mock.calls[0]!
    expect(runtime).toBeUndefined() // auto = 服务端按可用性选型
    expect(opts?.dir).toBe('D:/repo/demo') // ② 回流归属机制：cwd=源目录 → 主树 marks 收敛
    // prompt 头 = 真实 zh 语言包插值产物（含源会话名），清单含产出文件
    expect(opts?.launchArgs).toContain(zh('review.cross.promptHead', { name: 'Session-One' }))
    expect(opts?.launchArgs).toContain(zh('review.cross.promptListHeadMain'))
    expect(opts?.launchArgs).toContain('M src/a.ts')
    expect(new TextEncoder().encode(opts?.launchArgs || '').length).toBeLessThanOrEqual(BYTE500)
    expect(openMock).toHaveBeenCalledWith('docked')
    expect(messageMock.success).toHaveBeenCalled()
  })

  it('显式目标 runtime 原样下传；launched=false 提示降级', async () => {
    seedProject('D:/repo/demo')
    activityMock.mockResolvedValue({ data: { files: [] } })
    createMock.mockResolvedValue({ id: 'new2', launched: false })

    openCrossReview(seedSource())
    const { launch } = useCrossReview()
    await launch('codex')

    expect(createMock.mock.calls[0]![0]).toBe('codex')
    expect(messageMock.warning).toHaveBeenCalled()
    expect(openMock).toHaveBeenCalledWith('docked')
  })

  it('activity 404（silent）按无清单发起，不阻断', async () => {
    seedProject('D:/repo/demo')
    activityMock.mockRejectedValue(new Error('404'))
    createMock.mockResolvedValue({ id: 'new3', launched: true })

    openCrossReview(seedSource())
    const { launch } = useCrossReview()
    await launch('auto')

    expect(createMock).toHaveBeenCalledTimes(1)
    expect(createMock.mock.calls[0]![1]?.launchArgs).toContain(zh('review.cross.promptNoOutput'))
  })

  it('清单疑似含敏感值先确认，取消 = 不创建会话', async () => {
    seedProject('D:/repo/demo')
    // 路径带 token 赋值形态（P-109 启发式命中）
    activityMock.mockResolvedValue({ data: { files: [{ status: '?', path: 'logs/token=ghp_abcdefghijklmnop1234.txt' }] } })
    confirmMock.mockResolvedValue(false)

    openCrossReview(seedSource())
    const { launch } = useCrossReview()
    await launch('auto')

    expect(confirmMock).toHaveBeenCalled()
    expect(createMock).not.toHaveBeenCalled()
    expect(openMock).not.toHaveBeenCalled()
  })

  it('create 失败（null）报错误提示且不打开 docked', async () => {
    seedProject('D:/repo/demo')
    activityMock.mockResolvedValue({ data: { files: [] } })
    createMock.mockResolvedValue(null)

    openCrossReview(seedSource())
    const { launch } = useCrossReview()
    await launch('auto')

    expect(messageMock.error).toHaveBeenCalled()
    expect(openMock).not.toHaveBeenCalled()
  })

  it('源目录缺失且无当前项目：报错不发起', async () => {
    seedProject('') // 无当前项目（path 空）
    activityMock.mockResolvedValue({ data: { files: [] } })

    openCrossReview(seedSource({ dir: undefined }))
    const { launch } = useCrossReview()
    await launch('auto')

    expect(createMock).not.toHaveBeenCalled()
    expect(messageMock.error).toHaveBeenCalled()
  })
})
