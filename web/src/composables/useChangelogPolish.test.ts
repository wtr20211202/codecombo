import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { PromptSection } from '../utils/promptBuilder'

// ── mock 边界（usePrDescription.test.ts 同款）：① ask 链入口 launchAskSession
// （真实实现内部再走 useAgentTerminal/离散 message，本组合式只声明任务段落——
// 捕获入参并驱动 buildSections 即覆盖本方全部行为面）② 敏感判定 ③ 确认弹窗
// ④ vue-i18n（真模板：t 直接查 zh-CN 语言包插值，不复制期望文案，locale 改动
// 即测出）──
const { launchMock, sensitiveMock, confirmMock } = vi.hoisted(() => ({
  // 签名对齐 launchAskSession(root, buildSections, rel?, successMsg?)：mock.calls 取参有类型可依
  launchMock: vi.fn<(root: string, buildSections: () => PromptSection[] | Promise<PromptSection[]>, rel?: string, successMsg?: string) => Promise<void>>(),
  sensitiveMock: vi.fn<(s: string) => boolean>(),
  confirmMock: vi.fn<(opts?: Record<string, unknown>) => Promise<boolean>>(),
}))

vi.mock('./useEditorAskAgent', () => ({
  useEditorAskAgent: () => ({ launchAskSession: launchMock }),
}))

vi.mock('./useAgentFix', () => ({
  containsSensitiveValue: sensitiveMock,
}))

vi.mock('./useDialog', () => ({
  confirmDialog: confirmMock,
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

import { buildChangelogPolishPrompt, useChangelogPolish } from './useChangelogPolish'
import { useProjectStore } from '../stores/project'
import zhMessages from '../locales/zh-CN'

// 与 vue-i18n mock 同款真模板面（查 zh-CN 语言包插值，不复制期望文案）
const T = (key: string, params?: Record<string, unknown>): string => {
  const get = (o: Record<string, unknown>, k: string): unknown =>
    k.split('.').reduce<unknown>((a, c) => (a as Record<string, unknown> | undefined)?.[c], o)
  let s = get(zhMessages as unknown as Record<string, unknown>, key) as string
  for (const [k, v] of Object.entries(params ?? {})) s = s.replaceAll(`{${k}}`, String(v))
  return s
}

const HEAD = T('git.changelog.polishPromptHead')

function seedProject(path = 'D:/repo/demo') {
  const store = useProjectStore()
  store.projects = [{
    id: 'p1', name: 'demo', path, currentBranch: 'main', remoteURL: '', valid: true,
  }]
  store.currentProjectId = 'p1'
  return store
}

const DRAFT = [
  '# Changelog',
  '',
  '> tags/v1.0.0..HEAD · 3 commits',
  '',
  '## feat',
  '',
  '- abc12345 新增过滤',
  '## fix',
  '',
  '- def67890 修正计数',
].join('\n')

beforeEach(() => {
  setActivePinia(createPinia())
  vi.resetAllMocks()
  sensitiveMock.mockReturnValue(false)
  confirmMock.mockResolvedValue(true)
})

describe('buildChangelogPolishPrompt 组装与装箱', () => {
  it('预算充足：指令头 + 草稿全文（尾随空白剥除，无空尾行）', () => {
    const out = buildChangelogPolishPrompt(DRAFT + '\n', T, 4096)
    expect(out).toBe(HEAD + '\n' + DRAFT)
  })

  it('超预算：保头整行截断 + … 尾缀，总长收进份额且头部定位行不丢', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `- aaa${i} 提交主题第 ${i} 条，条目内容足够长以撑爆配额`)
    const draft = ['# Changelog', '', '> tags/v1.0.0..HEAD · 60 commits', '', ...lines].join('\n')
    const out = buildChangelogPolishPrompt(draft, T, 500)
    const bytes = new TextEncoder().encode(out).length
    expect(bytes).toBeLessThanOrEqual(500)
    expect(out.startsWith(HEAD + '\n# Changelog')).toBe(true)
    expect(out).toContain('> tags/v1.0.0..HEAD · 60 commits')
    expect(out).toContain('…')
    expect(out).not.toContain(lines[lines.length - 1]!)
    // 保留段都是完整行（无截半行伪影），… 尾缀独占一行
    const body = out.slice(HEAD.length + 1).split('\n')
    expect(body[body.length - 1]).toBe('…')
    for (const line of body.slice(0, -1)) expect(draft).toContain(line)
  })

  it('极端小预算（git 摘要吃掉大头）：首行按字符裁尾，仍收进份额', () => {
    // 预算以字节计（指令头大头是 CJK，字节数 ≠ 字符数），给到「头 + 8 字节」
    // ——连整行 `# Changelog` 都放不下，退化首行字符裁尾形态
    const headBytes = new TextEncoder().encode(HEAD).length
    const out = buildChangelogPolishPrompt('# Changelog\n', T, headBytes + 8)
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(headBytes + 8)
    expect(out.startsWith(HEAD + '\n')).toBe(true)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('useChangelogPolish 发起链', () => {
  it('空草稿防御性不动作', async () => {
    seedProject()
    const { polishChangelog } = useChangelogPolish()
    await polishChangelog('')
    expect(launchMock).not.toHaveBeenCalled()
  })

  it('正常发起：cwd=项目根、essential 任务段落装草稿、成功文案来自 changelog 域', async () => {
    seedProject('D:/repo/demo')
    const { polishChangelog, polishing } = useChangelogPolish()
    expect(polishing.value).toBe(false)
    let sections: PromptSection[] = []
    launchMock.mockImplementation(async (_root, buildSections) => {
      expect(polishing.value).toBe(true) // 发起中标志在链路期间亮起
      sections = await buildSections()
    })
    await polishChangelog(DRAFT)
    expect(sensitiveMock).toHaveBeenCalledWith(DRAFT)
    expect(launchMock).toHaveBeenCalledTimes(1)
    const [root, , rel, successMsg] = launchMock.mock.calls[0]!
    expect(root).toBe('D:/repo/demo')
    expect(rel).toBeUndefined()
    expect(successMsg).toBe(T('git.changelog.polishSuccess'))
    expect(sections).toHaveLength(1)
    expect(sections[0]!.id).toBe('task')
    expect(sections[0]!.kind).toBe('essential')
    expect(sections[0]!.fit!(500)).toContain('- abc12345 新增过滤')
    expect(polishing.value).toBe(false) // 结束后复位
  })

  it('链路抛错也复位 polishing（finally 兜底）', async () => {
    seedProject()
    const { polishChangelog, polishing } = useChangelogPolish()
    launchMock.mockRejectedValue(new Error('boom'))
    await expect(polishChangelog(DRAFT)).rejects.toThrow('boom')
    expect(polishing.value).toBe(false)
  })

  it('发起中重复点击不重复发起', async () => {
    seedProject()
    const { polishChangelog, polishing } = useChangelogPolish()
    let release!: () => void
    launchMock.mockImplementation(() => new Promise<void>((res) => { release = res }))
    const first = polishChangelog(DRAFT)
    await polishChangelog(DRAFT)
    release()
    await first
    expect(launchMock).toHaveBeenCalledTimes(1)
    expect(polishing.value).toBe(false)
  })

  it('草稿疑似含敏感值：确认弹窗，取消即不发起（P-109 口径同 P-138）', async () => {
    seedProject()
    sensitiveMock.mockReturnValue(true)
    confirmMock.mockResolvedValue(false)
    const { polishChangelog } = useChangelogPolish()
    await polishChangelog(DRAFT)
    expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({
      title: T('commit.agentMsg.sensitiveTitle'),
      content: T('commit.agentMsg.sensitiveBody'),
    }))
    expect(launchMock).not.toHaveBeenCalled()
  })

  it('草稿疑似含敏感值：确认后照常发起', async () => {
    seedProject()
    sensitiveMock.mockReturnValue(true)
    const { polishChangelog } = useChangelogPolish()
    await polishChangelog(DRAFT)
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(launchMock).toHaveBeenCalledTimes(1)
  })

  it('无项目根防御性不动作', async () => {
    const store = useProjectStore()
    store.projects = []
    const { polishChangelog } = useChangelogPolish()
    await polishChangelog(DRAFT)
    expect(launchMock).not.toHaveBeenCalled()
  })
})
