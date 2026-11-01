import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import zhCN from '../locales/zh-CN'

// ── mock 边界（useCommitAgentMsg.test 同款）：① agent 终端链路（create/open/
// busy）② naive-ui 离散 message ③ 确认弹窗（敏感场景）④ vue-i18n（真模板：t
// 直接查 zh-CN 语言包插值，locale 改动即测出）⑤ 任务文件写盘与 numstat/log
// 取数（P-20261006-44 降级链 + P-219 同源端点）──
const { createMock, openMock, messageMock, busyRef, confirmMock, writeFileMock, numstatMock, logMock } = vi.hoisted(() => ({
  // 签名对齐 useAgentTerminal.create(name?, opts?)：mock.calls 取参有类型可依
  createMock: vi.fn<(name?: string, opts?: { dir?: string; name?: string; launchArgs?: string }) =>
    Promise<{ id: string; launched: boolean } | null>>(),
  openMock: vi.fn<(target?: string) => Promise<void>>(),
  messageMock: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() },
  busyRef: { value: false },
  confirmMock: vi.fn<(opts?: Record<string, unknown>) => Promise<boolean>>(),
  writeFileMock: vi.fn<(id: string, path: string, content: string, config?: unknown) => Promise<unknown>>(),
  numstatMock: vi.fn<(pid: string, config?: unknown) => Promise<{ data?: unknown }>>(),
  logMock: vi.fn<(pid: string, params?: Record<string, unknown>) => Promise<{ data?: { hash?: string; message?: string }[] }>>(),
}))

vi.mock('./useAgentTerminal', () => ({
  useAgentTerminal: () => ({ busy: busyRef, create: createMock, open: openMock }),
}))

vi.mock('./useDialog', () => ({
  confirmDialog: confirmMock,
}))

vi.mock('../api/client', () => ({
  projectApi: { writeFile: (id: string, path: string, content: string, config?: unknown) => writeFileMock(id, path, content, config) },
  diffApi: { getNumstat: (pid: string, config?: unknown) => numstatMock(pid, config) },
  logApi: { getLog: (pid: string, params?: Record<string, unknown>) => logMock(pid, params) },
}))

vi.mock('naive-ui', async (importOriginal) => {
  // 部分 mock：主题包（themes/dark.ts）从 naive-ui 取 darkTheme 等真值，
  // 仅替换本组合式用到的 createDiscreteApi
  const actual = await importOriginal<typeof import('naive-ui')>()
  return { ...actual, createDiscreteApi: () => ({ message: messageMock }) }
})

vi.mock('vue-i18n', async () => {
  const zh = (await import('../locales/zh-CN')).default
  return {
    useI18n: () => ({
      t: (key: string, params?: Record<string, unknown>) => tplOf(zh, key, params),
    }),
  }
})

import { buildChangesetReviewPrompt, buildChangesetReviewPromptFull, REVIEW_LIST_MAX_FILES, shapeReviewList, useChangesetReview } from './useChangesetReview'
import type { ReviewFileEntry, ReviewPromptInput } from './useChangesetReview'
import { useProjectStore } from '../stores/project'
import { useChangesStore } from '../stores/changes'
import { byteLength, TASK_FILE_LAUNCH_ARGS, TASK_FILE_NAME } from '../utils/promptFit'

const BYTE500 = 500 // 服务端 launchArgs 上限（terminal.go 按字节计）

/** 极小翻译面（真模板插值，同组合式内 t 的使用形态） */
function tplOf(zh: Record<string, unknown>, key: string, params?: Record<string, unknown>): string {
  const get = (o: Record<string, unknown>, k: string): unknown =>
    k.split('.').reduce<unknown>((a, c) => (a as Record<string, unknown> | undefined)?.[c], o)
  let s = get(zh, key) as string
  for (const [k, v] of Object.entries(params ?? {})) s = s.replaceAll(`{${k}}`, String(v))
  return s
}
function tpl(key: string, params?: Record<string, unknown>): string {
  return tplOf(zhCN as unknown as Record<string, unknown>, key, params)
}

function entry(path: string, status = 'Modified', staged = false): ReviewFileEntry {
  return { path, status, staged }
}

function seedStores(files: ReviewFileEntry[] = []) {
  const projectStore = useProjectStore()
  projectStore.projects = [{
    id: 'p1', name: 'demo', path: 'D:/repo/demo', currentBranch: 'feat/review', remoteURL: '', valid: true,
  }]
  projectStore.currentProjectId = 'p1'
  const changesStore = useChangesStore()
  changesStore.files = files
  return { projectStore, changesStore }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.resetAllMocks()
  busyRef.value = false
  numstatMock.mockResolvedValue({ data: [] })
  logMock.mockResolvedValue({ data: [] })
})

describe('shapeReviewList 清单整形', () => {
  it('已暂存组在前、未暂存（含未跟踪）随其后；行 = 短状态字母 + 路径', () => {
    const r = shapeReviewList([
      entry('b.txt', 'Modified', false),
      entry('a.txt', 'Modified', true),
      entry('c.txt', 'Untracked', false),
    ])
    expect(r.staged).toEqual(['M a.txt'])
    expect(r.unstaged).toEqual(['M b.txt', '? c.txt'])
    expect(r.omitted).toBe(0)
  })

  it('重命名带旧路径（P-138 stagedFileLine 同款）', () => {
    const r = shapeReviewList([{ path: 'new.txt', status: 'Renamed', staged: true, oldPath: 'old.txt' }])
    expect(r.staged).toEqual(['R old.txt -> new.txt'])
  })

  it(`总量 ≤${REVIEW_LIST_MAX_FILES} 不截断`, () => {
    const files = Array.from({ length: REVIEW_LIST_MAX_FILES }, (_, i) => entry(`f${i}.txt`, 'Modified', i % 2 === 0))
    const r = shapeReviewList(files)
    expect(r.staged.length + r.unstaged.length).toBe(REVIEW_LIST_MAX_FILES)
    expect(r.omitted).toBe(0)
  })

  it('超限保头截断：staged 优先保留，omitted 计数如实', () => {
    const files = [
      ...Array.from({ length: 8 }, (_, i) => entry(`s${i}.txt`, 'Modified', true)),
      ...Array.from({ length: 7 }, (_, i) => entry(`u${i}.txt`, 'Modified', false)),
    ]
    const r = shapeReviewList(files)
    expect(r.staged).toHaveLength(8) // staged 全保（8 ≤ 12）
    expect(r.unstaged).toHaveLength(REVIEW_LIST_MAX_FILES - 8)
    expect(r.omitted).toBe(15 - REVIEW_LIST_MAX_FILES)
    expect(r.unstaged[0]).toBe('M u0.txt') // 保头
  })

  it('staged 自身超上限时 staged 截到上限、unstaged 全弃', () => {
    const files = [
      ...Array.from({ length: 15 }, (_, i) => entry(`s${i}.txt`, 'Modified', true)),
      entry('u0.txt', 'Modified', false),
    ]
    const r = shapeReviewList(files)
    expect(r.staged).toHaveLength(REVIEW_LIST_MAX_FILES)
    expect(r.staged[0]).toBe('M s0.txt') // 保头
    expect(r.unstaged).toHaveLength(0)
    expect(r.omitted).toBe(16 - REVIEW_LIST_MAX_FILES)
  })
})

describe('buildChangesetReviewPromptFull / buildChangesetReviewPrompt 组装', () => {
  const baseInput: ReviewPromptInput = {
    files: [entry('a.ts', 'Modified', true), entry('b.ts', 'Modified', false)],
    stat: { additions: 12, deletions: 3 },
    branch: 'feat/review',
    lastCommitSubject: 'feat(web): 上一条提交',
  }

  it('全文含三问指令头 / 分组清单 / 规模行 / 基线 / 深查指引', () => {
    const full = buildChangesetReviewPromptFull(baseInput, tpl)
    expect(full).toContain('① 风险点（逻辑')
    expect(full).toContain('② 缺失的测试')
    expect(full).toContain('③ 与仓库规范一致性')
    expect(full).toContain('已暂存：')
    expect(full).toContain('M a.ts')
    expect(full).toContain('未暂存/未跟踪：')
    expect(full).toContain('M b.ts')
    expect(full).toContain('+12 / -3')
    expect(full).toContain('基线：分支 feat/review · 最近提交：feat(web): 上一条提交')
    expect(full).toContain('git diff')
    // 首行 = 指令头（promptSessionName 会话名派生语义）
    expect(full.startsWith('请在提交前审查')).toBe(true)
    expect(full).not.toContain('（另有')
  })

  it('降级面缺省：stat=null 无规模行、subject 空基线只留分支、branch 空基线整节省略', () => {
    const noStat = buildChangesetReviewPromptFull({ ...baseInput, stat: null }, tpl)
    expect(noStat).not.toContain('规模：')
    const noSubject = buildChangesetReviewPromptFull({ ...baseInput, lastCommitSubject: '' }, tpl)
    expect(noSubject).toContain('基线：分支 feat/review')
    expect(noSubject).not.toContain('最近提交')
    const noBranch = buildChangesetReviewPromptFull({ ...baseInput, branch: '' }, tpl)
    expect(noBranch).not.toContain('基线')
  })

  it('小变更集两态逐字节相等（全文 ≤500 直发零装箱语义）', () => {
    const full = buildChangesetReviewPromptFull(baseInput, tpl)
    expect(byteLength(full)).toBeLessThanOrEqual(BYTE500)
    expect(buildChangesetReviewPrompt(baseInput, tpl)).toBe(full)
  })

  it('全文不 12 截断（任务文件面无配额压力，全量清单是卖点）', () => {
    const files = Array.from({ length: 20 }, (_, i) => entry(`f${i}.txt`))
    const full = buildChangesetReviewPromptFull({ ...baseInput, files }, tpl)
    for (let i = 0; i < 20; i++) expect(full).toContain(`f${i}.txt`)
  })

  it('装箱（默认预算=服务端上限）恒 ≤500 字节（长路径大清单扫描）', () => {
    for (const n of [0, 1, 5, 13, 30, 80]) {
      const files = Array.from({ length: n }, (_, i) => entry(`very-long-directory-segment-${i}/nested/deep/path/with-long-name-file-${i}.component.spec.ts`, 'Modified', i % 3 === 0))
      const boxed = buildChangesetReviewPrompt({ ...baseInput, files }, tpl)
      expect(byteLength(boxed), `n=${n}`).toBeLessThanOrEqual(BYTE500)
      expect(boxed.startsWith('请在提交前审查')).toBe(true) // 指令头恒首行
    }
  })

  it('装箱弃段次序固定节先行（指引→基线→规模），且各节存在性满足阶梯链', () => {
    const files = Array.from({ length: 20 }, (_, i) => entry(`component/very-long-name-dir-${i}/Change-${i}.vue`, 'Modified', i < 8))
    const input: ReviewPromptInput = { ...baseInput, files }
    let lastCount = Number.POSITIVE_INFINITY
    for (let b = BYTE500; b >= 300; b -= 10) {
      const text = buildChangesetReviewPrompt(input, tpl, b)
      const hasGuide = text.includes('git diff')
      const hasBaseline = text.includes('基线：分支')
      const hasStat = text.includes('规模：')
      // 阶梯链：基线在场 ⇒ 指引在场；规模在场 ⇒ 基线在场（弃段次序的等价表述）
      if (hasBaseline) expect(hasGuide, `b=${b}`).toBe(true)
      if (hasStat) expect(hasBaseline, `b=${b}`).toBe(true)
      // 清单行随预算收紧单调不增（保头丢尾）
      const count = (text.match(/Change-\d+\.vue/g) || []).length
      expect(count, `b=${b}`).toBeLessThanOrEqual(lastCount)
      lastCount = count
      // 计数注记恒在场（omitted=8>0）：诚实告知总量，任何预算档都不丢
      expect(text).toContain('（另有 8 个未列入）')
      expect(text).toContain('变更清单')
    }
    // 预算扫描终点前固定节确实开始退让（阶梯真被触发，不是全程装得下）
    expect(lastCount).toBeLessThan(12)
  })

  it('装箱丢尾次序：未暂存组先丢空（组头隐藏），已暂存组殿后', () => {
    const files = [
      ...Array.from({ length: 8 }, (_, i) => entry(`s${i}.txt`, 'Modified', true)),
      ...Array.from({ length: 12 }, (_, i) => entry(`u${i}.txt`, 'Modified', false)),
    ]
    const input: ReviewPromptInput = { ...baseInput, files, stat: null, lastCommitSubject: '' }
    let unstagedGone = false
    for (let b = BYTE500; b >= 280; b -= 5) {
      const text = buildChangesetReviewPrompt(input, tpl, b)
      const hasStagedHead = text.includes('已暂存：')
      const hasUnstagedHead = text.includes('未暂存/未跟踪：')
      // 不变式：未暂存组头在场 ⇒ 已暂存组头在场（显示序头侧恒保留）
      if (hasUnstagedHead) expect(hasStagedHead, `b=${b}`).toBe(true)
      if (!hasUnstagedHead) unstagedGone = true
      // 计数注记恒在场
      expect(text).toContain('（另有 8 个未列入）')
    }
    expect(unstagedGone).toBe(true) // 未暂存组确实被丢空过（组头随之隐藏）
  })
})

describe('marks 归属行（P-20261005-172）', () => {
  // 组装 describe 的 baseInput 为其局部量——本 describe 自备（同形状）
  const baseInput: ReviewPromptInput = {
    files: [entry('a.ts', 'Modified', true), entry('b.ts', 'Modified', false)],
    stat: { additions: 12, deletions: 3 },
    branch: 'feat/review',
    lastCommitSubject: 'feat(web): 上一条提交',
  }

  function marksOf(entries: [string, string[]][]): Map<string, { sessions: number; runtimes: string[] }> {
    return new Map(entries.map(([p, r]) => [p, { sessions: 1, runtimes: r }]))
  }
  function marksLine(n: number, runtimes: string): string {
    return tpl('commit.agentMsg.marksNote', { n, runtimes })
  }

  it('全文：清单后缀「其中 N 个」+ runtime 并集，落清单与基线节之间', () => {
    const input: ReviewPromptInput = {
      ...baseInput, stat: null, lastCommitSubject: '', // 轻固定节，装配字节远离上限
      marks: marksOf([['a.ts', ['claude']], ['b.ts', ['codex', 'claude']]]),
    }
    const full = buildChangesetReviewPromptFull(input, tpl)
    const line = marksLine(2, 'claude/codex')
    expect(full).toContain(line)
    expect(full.indexOf(line)).toBeGreaterThan(full.indexOf('M b.ts')) // 紧贴清单之后
    expect(full.indexOf(line)).toBeLessThan(full.indexOf('git diff')) // 深查指引节之前
    // 清单整体装得下时与装箱版逐字节相等（P-20261006-44 契约随归属行延续）
    expect(buildChangesetReviewPrompt(input, tpl)).toBe(full)
  })

  it('无命中/空 marks/缺省 → 整行缺席，与无 marks 形态逐字节一致', () => {
    const bare = buildChangesetReviewPromptFull(baseInput, tpl)
    expect(buildChangesetReviewPromptFull({ ...baseInput, marks: marksOf([['other.ts', ['claude']]]) }, tpl)).toBe(bare)
    expect(buildChangesetReviewPromptFull({ ...baseInput, marks: new Map() }, tpl)).toBe(bare)
    expect(buildChangesetReviewPromptFull(baseInput, tpl)).toBe(bare)
  })

  it('12 截断（omitted>0）：装箱面整行让位（「其中 N 个」对所见清单失真），全文面保留', () => {
    const files = Array.from({ length: 20 }, (_, i) => entry(`f${i}.txt`, 'Modified', i % 2 === 0))
    const input: ReviewPromptInput = { ...baseInput, files, marks: marksOf([['f0.txt', ['claude']]]) }
    // 全文（任务文件主路径）：全量清单在场，归属行按全集计数保留
    expect(buildChangesetReviewPromptFull(input, tpl)).toContain(marksLine(1, 'claude'))
    // 装箱（写失败兜底）：清单 12 截断，归属行整行让位
    const boxed = buildChangesetReviewPrompt(input, tpl)
    expect(boxed).toContain('（另有 8 个未列入）')
    expect(boxed).not.toContain(marksLine(1, 'claude'))
  })

  it('装箱阶梯：归属行殿后于固定节（规模行先弃），恒先于清单截断弃（优先级低于文件清单）', () => {
    // 短文件名让固定节成为字节压力主体（12 条长路径清单单独就超上限，
    // 「归属行殿后」的档位永远够不着——本用例把预算扫进取舍发生的区间）
    const files = Array.from({ length: 3 }, (_, i) => entry(`f${i}.txt`, 'Modified', true))
    const input: ReviewPromptInput = { ...baseInput, files, marks: marksOf(files.map(f => [f.path, ['claude']])) }
    let sawMarksWithoutStat = false
    let sawListTruncation = false
    for (let b = BYTE500; b >= 230; b -= 5) {
      const text = buildChangesetReviewPrompt(input, tpl, b)
      const hasMarks = text.includes(marksLine(3, 'claude'))
      const listCount = (text.match(/f\d\.txt/g) || []).length
      // 不变式：清单被截断 ⇔ 归属行缺席（归属行只在清单完整在场时出现）
      if (listCount < 3) {
        expect(hasMarks, `b=${b}`).toBe(false)
        sawListTruncation = true
      } else if (hasMarks && !text.includes('规模：')) {
        sawMarksWithoutStat = true
      }
    }
    expect(sawListTruncation).toBe(true) // 截断阶梯真被触发（断言不是全程空转）
    expect(sawMarksWithoutStat).toBe(true) // 归属行确实殿后于规模行（弃段次序）
  })

  it('发起链：marks 传入 → launchArgs 附归属行（真模板）', async () => {
    seedStores([entry('alpha.ts', 'Modified', true), entry('beta.ts', 'Modified', false)])
    numstatMock.mockResolvedValue({ data: [] })
    logMock.mockResolvedValue({ data: [] })
    createMock.mockResolvedValue({ id: 't1', launched: true })
    const { reviewChangeset } = useChangesetReview({ marks: { value: marksOf([['alpha.ts', ['shell']]]) } })

    await reviewChangeset()

    const opts = createMock.mock.calls[0]![1]!
    expect(opts.launchArgs).toContain('alpha.ts')
    expect(opts.launchArgs).toContain(marksLine(1, 'shell'))
  })
})

describe('useChangesetReview 发起链', () => {
  it('两文件变更集：create 携 dir=项目根 + launchArgs 含文件名与三问指令，docked 打开', async () => {
    seedStores([entry('alpha.ts', 'Modified', true), entry('beta.ts', 'Modified', false)])
    numstatMock.mockResolvedValue({ data: [{ path: 'alpha.ts', additions: 10, deletions: 2 }, { path: 'beta.ts', additions: 1, deletions: 0 }] })
    logMock.mockResolvedValue({ data: [{ hash: 'abc1234', message: 'chore: baseline\n\nbody' }] })
    createMock.mockResolvedValue({ id: 't1', launched: true })

    const { reviewChangeset } = useChangesetReview()
    await reviewChangeset()

    expect(createMock).toHaveBeenCalledTimes(1)
    const opts = createMock.mock.calls[0]![1]!
    expect(opts.dir).toBe('D:/repo/demo')
    expect(opts.launchArgs).toContain('alpha.ts')
    expect(opts.launchArgs).toContain('beta.ts')
    expect(opts.launchArgs).toContain('① 风险点（逻辑')
    expect(opts.launchArgs).toContain('基线：分支 feat/review · 最近提交：chore: baseline')
    expect(opts.launchArgs).toContain('+11 / -2')
    expect(openMock).toHaveBeenCalledWith('docked')
    expect(messageMock.success).toHaveBeenCalled()
    // 取数面：silent numstat（P-219 同源）+ limit=1 现查（P-176 先例）
    expect(numstatMock).toHaveBeenCalledWith('p1', { silent: true })
    expect(logMock).toHaveBeenCalledWith('p1', { limit: 1 })
  })

  it('超 500 字节走任务文件降级：全文落 .sc-task.md，launchArgs 换短引用指令', async () => {
    const long = 'x'.repeat(120)
    seedStores([entry(`${long}/a.ts`), entry(`${long}/b.ts`), entry(`${long}/c.ts`), entry(`${long}/d.ts`), entry(`${long}/e.ts`)])
    writeFileMock.mockResolvedValue(undefined)
    createMock.mockResolvedValue({ id: 't1', launched: true })

    const { reviewChangeset } = useChangesetReview()
    await reviewChangeset()

    expect(writeFileMock).toHaveBeenCalledTimes(1)
    const call = writeFileMock.mock.calls[0] as [string, string, string]
    expect(call[0]).toBe('p1')
    expect(call[1]).toBe(TASK_FILE_NAME)
    // 任务文件全文：不 12 截断的分组清单 + 全部固定节
    expect(call[2]).toContain('a.ts')
    expect(call[2]).toContain('e.ts')
    expect(call[2]).toContain('① 风险点（逻辑')
    expect(createMock.mock.calls[0]![1]!.launchArgs).toBe(TASK_FILE_LAUNCH_ARGS)
    expect(messageMock.info).toHaveBeenCalled()
  })

  it('任务文件写失败降级装箱：launchArgs 退回 ≤500 装箱结果', async () => {
    const long = 'y'.repeat(120)
    seedStores([entry(`${long}/a.ts`), entry(`${long}/b.ts`), entry(`${long}/c.ts`), entry(`${long}/d.ts`), entry(`${long}/e.ts`)])
    writeFileMock.mockRejectedValue(new Error('locked'))
    createMock.mockResolvedValue({ id: 't1', launched: true })

    const { reviewChangeset } = useChangesetReview()
    await reviewChangeset()

    const launchArgs = createMock.mock.calls[0]![1]!.launchArgs ?? ''
    expect(byteLength(launchArgs)).toBeLessThanOrEqual(BYTE500)
    expect(launchArgs).not.toBe(TASK_FILE_LAUNCH_ARGS)
    expect(messageMock.warning).toHaveBeenCalled() // 降级提示（fallbackWriteFailed）
    expect(messageMock.success).toHaveBeenCalled()
  })

  it('敏感路径先确认：取消 = 不创建会话', async () => {
    seedStores([entry('src/secret=leak.txt')])
    confirmMock.mockResolvedValue(false)

    const { reviewChangeset } = useChangesetReview()
    await reviewChangeset()

    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(createMock).not.toHaveBeenCalled()
  })

  it('空变更集防御性不动作（按钮禁用同口径的服务端兜底）', async () => {
    seedStores([])
    const { reviewChangeset, canReview } = useChangesetReview()
    expect(canReview).toBe(false) // reactive 返回面：computed 已解包为布尔
    await reviewChangeset()
    expect(createMock).not.toHaveBeenCalled()
    expect(numstatMock).not.toHaveBeenCalled()
  })

  it('busy 让位：已有发起在途时不创建（家族同款守卫）', async () => {
    seedStores([entry('a.ts')])
    busyRef.value = true
    const { reviewChangeset } = useChangesetReview()
    await reviewChangeset()
    expect(createMock).not.toHaveBeenCalled()
  })

  it('numstat/log 取数失败降级：无规模行，基线退分支段，仍照常发起', async () => {
    seedStores([entry('a.ts', 'Modified', true)])
    numstatMock.mockRejectedValue(new Error('boom'))
    logMock.mockRejectedValue(new Error('boom'))
    createMock.mockResolvedValue({ id: 't1', launched: true })

    const { reviewChangeset } = useChangesetReview()
    await reviewChangeset()

    const launchArgs = createMock.mock.calls[0]![1]!.launchArgs ?? ''
    expect(launchArgs).not.toContain('规模：')
    expect(launchArgs).not.toContain('最近提交') // log 现查失败 → 主题段降级
    expect(launchArgs).toContain('基线：分支 feat/review') // 分支来自 project store 随带，仍在
    expect(launchArgs).toContain('a.ts')
    expect(messageMock.success).toHaveBeenCalled()
  })
})
