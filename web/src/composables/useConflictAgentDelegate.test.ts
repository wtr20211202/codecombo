import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// ── mock 边界：纯函数（extractConflictBlock/fitHeadKeep/buildConflictBody/
// fitSingleConflictPrompt/fitBatchConflictPrompt）直测零 mock；组合式级
// delegateConflicts 只 mock ① P-28 发起链（launchAskSession，断言参数转交）
// ② vue-i18n（真模板：t 直接查 zh-CN 语言包插值，不复制期望文案）──
const { launchMock } = vi.hoisted(() => ({
  launchMock: vi.fn<(
    root: string,
    buildSections: () => unknown,
    rel?: string,
    successMsg?: string,
  ) => Promise<void>>(),
}))

vi.mock('./useEditorAskAgent', () => ({
  useEditorAskAgent: () => ({ launchAskSession: launchMock }),
}))

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
  buildConflictBody,
  conflictOpLabel,
  extractConflictBlock,
  fitBatchConflictPrompt,
  fitHeadKeep,
  fitSingleConflictPrompt,
  useConflictAgentDelegate,
  type ConflictDelegateFile,
  type ConflictTranslator,
} from './useConflictAgentDelegate'
import { useProjectStore } from '../stores/project'
import { byteLength } from '../utils/promptFit'
import zh from '../locales/zh-CN'

const BYTE500 = 500 // 服务端 launchArgs 上限（terminal.go 按字节计）

// 真 zh 语言包翻译面（与组合式内传 t 同构）
const t: ConflictTranslator = (key, params) => {
  let s = key.split('.').reduce<unknown>((a, c) => (a as Record<string, unknown> | undefined)?.[c], zh as unknown as Record<string, unknown>) as string
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

const FILE: ConflictDelegateFile = {
  path: 'src/a.ts',
  raw: 'const x = 1\n<<<<<<< HEAD\nline2: main changed this\n=======\nline2: feature changed this\n>>>>>>> feature\nconst y = 2\n',
  ours: 'line2: main changed this',
  theirs: 'line2: feature changed this',
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.resetAllMocks()
})

describe('extractConflictBlock 首个冲突块提取', () => {
  it('提取 <<<<<<< 起至配对 >>>>>>> 止（含两端标记行），CRLF 归一', () => {
    const block = extractConflictBlock(FILE.raw)
    expect(block).toBe('<<<<<<< HEAD\nline2: main changed this\n=======\nline2: feature changed this\n>>>>>>> feature')
    expect(extractConflictBlock(FILE.raw.replace(/\n/g, '\r\n'))).toBe(block)
  })

  it('无起始标记 / 未闭合 / 块内嵌套再遇 <<<<<<< 一律 null（复杂形态不猜）', () => {
    expect(extractConflictBlock('no markers here')).toBeNull()
    expect(extractConflictBlock('<<<<<<< HEAD\nonly ours')).toBeNull()
    expect(extractConflictBlock('<<<<<<< A\n<<<<<<< B\nx\n=======\ny\n>>>>>>> B')).toBeNull()
    expect(extractConflictBlock('')).toBeNull()
  })
})

describe('fitHeadKeep 保头截断', () => {
  it('放得下原样（尾随空白剥除）；超限 … 尾缀且 ≤ 预算', () => {
    expect(fitHeadKeep('hello\n', 100)).toBe('hello')
    const out = fitHeadKeep('a'.repeat(50), 20)
    expect(byteLength(out)).toBeLessThanOrEqual(20)
    expect(out.startsWith('aaaa')).toBe(true)
    expect(out.endsWith('…')).toBe(true)
  })

  it('空文本 / 零预算 / 预算放不下一个字符 → 空串', () => {
    expect(fitHeadKeep('', 100)).toBe('')
    expect(fitHeadKeep('hello', 0)).toBe('')
    expect(fitHeadKeep('hello', 1)).toBe('')
  })
})

describe('buildConflictBody 冲突体节选', () => {
  it('小冲突：原文冲突块 + 两侧全量，无省略注记', () => {
    const body = buildConflictBody(FILE, 400, t)
    expect(body).toContain('<<<<<<< HEAD')
    expect(body).toContain('我方（ours）侧：line2: main changed this')
    expect(body).toContain('他方（theirs）侧：line2: feature changed this')
    expect(body).not.toContain('截断')
    expect(byteLength(body)).toBeLessThanOrEqual(400)
  })

  it('超长两侧：各截 + 中部省略标记夹在两段之间，整体 ≤ 预算', () => {
    const big: ConflictDelegateFile = {
      ...FILE,
      ours: `main ${'x'.repeat(600)}`,
      theirs: `feature ${'y'.repeat(600)}`,
      raw: `<<<<<<< HEAD\nmain ${'x'.repeat(600)}\n=======\nfeature ${'y'.repeat(600)}\n>>>>>>> f\n`,
    }
    const body = buildConflictBody(big, 300, t)
    expect(byteLength(body)).toBeLessThanOrEqual(300)
    expect(body).toContain(t('conflict.agent.promptOmitted'))
    const noteIdx = body.indexOf(t('conflict.agent.promptOmitted'))
    const oursIdx = body.indexOf('我方')
    const theirsIdx = body.indexOf('他方')
    expect(oursIdx).toBeGreaterThan(-1)
    expect(theirsIdx).toBeGreaterThan(noteIdx)
    expect(noteIdx).toBeGreaterThan(oursIdx)
  })

  it('预算为零 → 空串（固定行优先保住的契约）', () => {
    expect(buildConflictBody(FILE, 0, t)).toBe('')
  })
})

describe('fitSingleConflictPrompt 单文件委派 prompt', () => {
  it('模板 + 文件 + 场景 + 冲突体齐全，≤500 字节', () => {
    const prompt = fitSingleConflictPrompt(t('conflict.agent.defaultTemplate'), FILE, '场景：merge 冲突处理中', t, BYTE500)
    expect(prompt).toContain('解决冲突并说明两侧取舍理由')
    expect(prompt).toContain('文件：src/a.ts')
    expect(prompt).toContain('场景：merge 冲突处理中')
    expect(prompt).toContain('<<<<<<< HEAD')
    expect(prompt).toContain('line2: main changed this')
    expect(prompt).toContain('line2: feature changed this')
    expect(byteLength(prompt)).toBeLessThanOrEqual(BYTE500)
  })

  it('反斜杠路径归一正斜杠；空模板无空行伪影', () => {
    const prompt = fitSingleConflictPrompt('', { ...FILE, path: 'src\\win.ts' }, '场景：x', t, BYTE500)
    expect(prompt).toContain('文件：src/win.ts')
    expect(prompt).not.toContain('\n\n')
    expect(prompt.startsWith('文件：')).toBe(true)
  })

  it('极端小预算：仍保住文件行（定位信息永不丢），总额 ≤ 预算', () => {
    const prompt = fitSingleConflictPrompt(t('conflict.agent.defaultTemplate'), FILE, '场景：x', t, 60)
    expect(byteLength(prompt)).toBeLessThanOrEqual(60)
    expect(prompt).toContain('src/a.ts')
  })
})

describe('fitBatchConflictPrompt 批量清单装箱', () => {
  const render = {
    head: (n: number) => t('conflict.agent.promptListHead', { n }),
    omitted: (n: number) => t('conflict.agent.promptOmittedFiles', { n }),
  }

  it('小冲突集全量列入，无注记', () => {
    const r = fitBatchConflictPrompt('解决冲突', '场景：rebase 冲突处理中', ['a.ts', 'b.ts', 'c/d.ts'], render, BYTE500)
    expect(r.included).toBe(3)
    expect(r.omitted).toBe(0)
    expect(r.prompt).toContain('- a.ts')
    expect(r.prompt).toContain('- c/d.ts')
    expect(r.prompt).toContain('共 3 个冲突文件：')
    expect(byteLength(r.prompt)).toBeLessThanOrEqual(BYTE500)
  })

  it('超长清单：装箱截断 + 「另有 M 个未列入」注记，总额 ≤500', () => {
    const paths = Array.from({ length: 60 }, (_, i) => `very/long/path/segment/file-number-${i}.tsx`)
    const r = fitBatchConflictPrompt(t('conflict.agent.defaultTemplate'), '场景：rebase 冲突处理中', paths, render, BYTE500)
    expect(r.included).toBeLessThan(60)
    expect(r.omitted).toBe(60 - r.included)
    expect(r.prompt).toContain(render.omitted(r.omitted))
    expect(byteLength(r.prompt)).toBeLessThanOrEqual(BYTE500)
    expect(r.prompt).toContain('- very/long/path/segment/file-number-0.tsx')
  })

  it('注记放不下时回吐条目腾位（宁少装一条不超限）', () => {
    // 条目恰好压线：注记加入即超限 → 必须回吐一条
    const paths = Array.from({ length: 40 }, (_, i) => `f${i}.ts`)
    const r = fitBatchConflictPrompt('', '', paths, render, 160)
    expect(byteLength(r.prompt)).toBeLessThanOrEqual(160)
    if (r.omitted > 0) expect(r.prompt).toContain(render.omitted(r.omitted))
  })
})

describe('conflictOpLabel 场景文案映射', () => {
  it('merge/rebase/cherry-pick 各归其位；未知/空弱表述不虚构', () => {
    expect(conflictOpLabel('merge', t)).toBe('merge 冲突处理中')
    expect(conflictOpLabel('rebase', t)).toBe('rebase 冲突处理中')
    expect(conflictOpLabel('cherry-pick', t)).toBe('cherry-pick 冲突处理中')
    expect(conflictOpLabel('', t)).toBe('冲突处理中')
    expect(conflictOpLabel('bogus', t)).toBe('冲突处理中')
  })
})

describe('useConflictAgentDelegate 委派发起（P-20261005-190）', () => {
  it('单文件：rel=路径（成功提示带路径）、任务段 fit 产出结构化 prompt', async () => {
    seedProject()
    launchMock.mockResolvedValue()
    const { delegateConflicts } = useConflictAgentDelegate()

    const ok = await delegateConflicts({
      paths: ['src/a.ts'],
      single: FILE,
      op: 'merge',
      template: t('conflict.agent.defaultTemplate'),
    })

    expect(ok).toBe(true)
    expect(launchMock).toHaveBeenCalledTimes(1)
    const [root, buildSections, rel, successMsg] = launchMock.mock.calls[0]!
    expect(root).toBe('D:/repo/demo')
    expect(rel).toBe('src/a.ts')
    expect(successMsg).toBeUndefined()
    const sections = (buildSections as () => { id: string; kind: string; fit: (b: number) => string }[])()
    expect(sections).toHaveLength(1)
    const prompt = sections[0]!.fit(BYTE500)
    expect(prompt).toContain('解决冲突并说明两侧取舍理由')
    expect(prompt).toContain('文件：src/a.ts')
    expect(prompt).toContain('场景：merge 冲突处理中')
  })

  it('批量：rel 缺省、成功提示带数量、fit 产出清单头', async () => {
    seedProject()
    launchMock.mockResolvedValue()
    const { delegateConflicts } = useConflictAgentDelegate()

    const ok = await delegateConflicts({
      paths: ['a.ts', 'b.ts'],
      op: 'rebase',
      template: '解决冲突',
    })

    expect(ok).toBe(true)
    const [root, buildSections, rel, successMsg] = launchMock.mock.calls[0]!
    expect(root).toBe('D:/repo/demo')
    expect(rel).toBeUndefined()
    expect(successMsg).toBe(t('conflict.agent.successBatch', { n: 2 }))
    const sections = (buildSections as () => { fit: (b: number) => string }[])()
    const prompt = sections[0]!.fit(BYTE500)
    expect(prompt).toContain('场景：rebase 冲突处理中')
    expect(prompt).toContain('- a.ts')
    expect(prompt).toContain('- b.ts')
  })

  it('单文件载荷 paths>1 时 single 不生效（走批量清单语义）；无项目返回 false 不发起', async () => {
    seedProject()
    launchMock.mockResolvedValue()
    const { delegateConflicts } = useConflictAgentDelegate()

    await delegateConflicts({ paths: ['a.ts', 'b.ts'], single: FILE, op: '', template: 'x' })
    const [, buildSections, rel] = launchMock.mock.calls[0]!
    expect(rel).toBeUndefined()
    const prompt = (buildSections as () => { fit: (b: number) => string }[])()[0]!.fit(BYTE500)
    // 批量语义 = 清单注入（「- a.ts」行），无单文件的「文件：<路径>」定位行
    // （注意「共 N 个冲突文件：」清单头含「文件：」子串，断言须锚整行）
    expect(prompt).toContain('- a.ts')
    expect(prompt).not.toContain('文件：a.ts')

    launchMock.mockClear()
    const store = useProjectStore()
    store.currentProjectId = ''
    const ok = await delegateConflicts({ paths: ['a.ts'], single: FILE, op: '', template: 'x' })
    expect(ok).toBe(false)
    expect(launchMock).not.toHaveBeenCalled()
  })
})
