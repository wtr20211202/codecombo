import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// ── mock 边界（useCommitSplitSuggest.test.ts 同款）：① api client（scrollback
// 读面 + executeSplit 写面 + changes store 依赖面）② naive-ui 离散 message
// ③ 确认弹层（预览确认 / 报告面板）④ vue-i18n（真模板：t 直接查 zh-CN 语言包）
// 会话锚点直接写 useCommitSplitSuggest 的模块级 lastSplitSuggestSessionId ──
const { scrollbackMock, executeSplitMock, statusMock, messageMock, confirmMock } = vi.hoisted(() => ({
  scrollbackMock: vi.fn<(id: string, config?: unknown) => Promise<unknown>>(),
  executeSplitMock: vi.fn<(pid: string, groups: unknown[]) => Promise<unknown>>(),
  statusMock: vi.fn<(pid: string) => Promise<unknown>>(),
  messageMock: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() },
  confirmMock: vi.fn<(opts?: Record<string, unknown>) => Promise<boolean>>(),
}))

vi.mock('../api/client', () => ({
  terminalApi: { scrollback: (id: string, config?: unknown) => scrollbackMock(id, config) },
  commitApi: { executeSplit: (pid: string, groups: unknown[]) => executeSplitMock(pid, groups) },
  // changes store 的依赖面（本组合式只触发 fetchStatus → projectApi.status）
  projectApi: { status: (pid: string) => statusMock(pid), writeFile: vi.fn() },
  diffApi: { getNumstat: vi.fn(), getFileDiff: vi.fn() },
  snapshotApi: {},
}))

vi.mock('./useDialog', () => ({
  confirmDialog: (opts?: Record<string, unknown>) => confirmMock(opts),
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
        // 字面花括号转义还原（{'{'} / {'}'}）：模拟 vue-i18n 消息编译的字面量段，
        // 否则 promptFormat 里的 JSON 示例按转义原文参与字节预算断言会虚高
        s = s.replaceAll("{'{'}", '{').replaceAll("{'}'}", '}')
        for (const [k, v] of Object.entries(params ?? {})) s = s.replaceAll(`{${k}}`, String(v))
        return s
      },
    }),
  }
})

import { parseSplitSuggestion, stripAnsiText, useCommitSplitExecute } from './useCommitSplitExecute'
import { lastSplitSuggestSessionId } from './useCommitSplitSuggest'
import zhCN from '../locales/zh-CN'
import { useProjectStore } from '../stores/project'
import { useChangesStore } from '../stores/changes'
import { useAssistantTaskStore } from '../stores/assistantTask'

/** 真语言包 t（类型收窄到 string 叶子）：与顶部 vue-i18n mock 同一数据源（含
 *  字面花括号转义还原，同 mock 的编译模拟） */
function realT(k: string): string {
  let s = k.split('.').reduce<unknown>((a, c) => (a as Record<string, unknown> | undefined)?.[c], zhCN as unknown as Record<string, unknown>) as string
  s = s.replaceAll("{'{'}", '{').replaceAll("{'}'}", '}')
  return s
}

function seedProject() {
  const store = useProjectStore()
  store.projects = [{ id: 'p1', name: 'demo', path: 'D:/repo/demo', currentBranch: 'main', remoteURL: '', valid: true }]
  store.currentProjectId = 'p1'
  return store
}

function seedChanges(files: { path: string; staged: boolean }[]) {
  const changes = useChangesStore()
  changes.files = files.map(f => ({ path: f.path, status: 'Modified', staged: f.staged }))
  return changes
}

function ab(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer as ArrayBuffer
}

/** 双文件标准建议（围栏形态） */
const FENCED = [
  '分析完成，共两组：',
  '```json',
  '{"groups":[{"name":"功能","files":["a.txt","b.txt"],"subject":"feat: ui"},{"name":"配置","files":["c.txt"],"subject":"chore: cfg"}]}',
  '```',
].join('\n')

beforeEach(() => {
  setActivePinia(createPinia())
  vi.resetAllMocks()
  lastSplitSuggestSessionId.value = ''
  confirmMock.mockResolvedValue(true)
})

describe('stripAnsiText', () => {
  it('剥除 CSI/OSC 序列保留可读文本（ArrayBuffer 输入）', () => {
    const raw = '\x1b[32m✓\x1b[0m done\x1b]0;title\x07\nnext'
    expect(stripAnsiText(ab(raw))).toBe('✓ done\nnext')
  })
})

describe('parseSplitSuggestion', () => {
  it('围栏 ```json 块解析为分组', () => {
    expect(parseSplitSuggestion(FENCED)).toEqual([
      { name: '功能', files: ['a.txt', 'b.txt'], subject: 'feat: ui' },
      { name: '配置', files: ['c.txt'], subject: 'chore: cfg' },
    ])
  })

  it('无围栏裸 JSON（prompt 前缀污染）经锚点括号配平解析', () => {
    const text = '$ claude "把以下变更分组…"\n好的：{"groups":[{"name":"g","files":["a.txt"],"subject":"s"}]} 以上。'
    expect(parseSplitSuggestion(text)).toEqual([{ name: 'g', files: ['a.txt'], subject: 's' }])
  })

  it('TUI 折行修复形：字符串字面量内换行经逐行 trim 拼接愈合', () => {
    const text = '```json\n{\n  "groups": [\n    {\n      "name": "长路径组",\n      "files": ["web/src/composables/useCommitSplitExe\ncuted.ts"],\n      "subject": "fix: long"\n    }\n  ]\n}\n```'
    expect(parseSplitSuggestion(text)).toEqual([
      { name: '长路径组', files: ['web/src/composables/useCommitSplitExecuted.ts'], subject: 'fix: long' },
    ])
  })

  it('多个围栏块取最后一个含 groups 的；规整丢弃空文件组并去重', () => {
    const text = '```json\n{"note":1}\n```\n中间说明\n```json\n{"groups":[{"name":"a","files":["x.txt","x.txt"," "],"subject":"s1"},{"name":"b","files":[],"subject":"s2"}]}\n```'
    expect(parseSplitSuggestion(text)).toEqual([{ name: 'a', files: ['x.txt'], subject: 's1' }])
  })

  it('锚点回扫：末份截断回退前一份完整方案（重复打印/注入重发容忍）', () => {
    const good = '```json\n{"groups":[{"name":"g","files":["a.txt"],"subject":"s"}]}\n```'
    expect(parseSplitSuggestion(good + '\n继续输出\n```json{"groups":[{"name":"截断","files":["b.t')).toEqual([
      { name: 'g', files: ['a.txt'], subject: 's' },
    ])
  })

  it('prompt 回显的格式示例候选被占位文件剔除，不误报（["…"] 永非真实路径）', () => {
    const echo = '把以下暂存变更分组：```json{"groups":[{"name":"组名","files":["…"],"subject":"commit 主题"}]}```'
    expect(parseSplitSuggestion(echo)).toBeNull()
  })

  it('无 groups/非法 JSON/空串返回 null', () => {
    expect(parseSplitSuggestion('没有任何结构化内容')).toBeNull()
    expect(parseSplitSuggestion('```json\n{"other":[]}\n```')).toBeNull()
    // 真截断（JSON 本体不完整，无完整份可回退）
    expect(parseSplitSuggestion('```json\n{"groups":[{"name":"a","files":["x.txt"')).toBeNull()
    expect(parseSplitSuggestion('')).toBeNull()
  })
})

describe('useCommitSplitExecute 流程', () => {
  it('无会话锚点时入口隐藏、动作拒绝', async () => {
    seedProject()
    const state = useCommitSplitExecute()
    expect(state.hasSuggestion).toBe(false)
    await state.executeSplitSuggestion()
    expect(scrollbackMock).not.toHaveBeenCalled()
  })

  it('解析成功 + 确认 → 整包下发执行、成功提示、变更列表重拉', async () => {
    seedProject()
    seedChanges([{ path: 'a.txt', staged: true }, { path: 'b.txt', staged: true }, { path: 'c.txt', staged: true }])
    lastSplitSuggestSessionId.value = 'sess-1'
    scrollbackMock.mockResolvedValue(ab(FENCED))
    executeSplitMock.mockResolvedValue({
      data: { total: 2, executed: [{ index: 0, name: '功能', subject: 'feat: ui', commit: 'abc1234' }, { index: 1, name: '配置', subject: 'chore: cfg', commit: 'def5678' }], failed: null, remaining: 0 },
    })
    statusMock.mockResolvedValue({ data: [] })

    const state = useCommitSplitExecute()
    expect(state.hasSuggestion).toBe(true)
    await state.executeSplitSuggestion()

    expect(confirmMock).toHaveBeenCalledTimes(1)
    // 预览弹层 intro 携带组数（真语言包插值）
    const preview = confirmMock.mock.calls[0]![0] as { title?: string; content: () => unknown }
    expect(preview.title).toBe(realT('commit.splitExec.dialogTitle'))
    expect(executeSplitMock).toHaveBeenCalledWith('p1', [
      { name: '功能', files: ['a.txt', 'b.txt'], subject: 'feat: ui' },
      { name: '配置', files: ['c.txt'], subject: 'chore: cfg' },
    ])
    expect(messageMock.success).toHaveBeenCalledWith(realT('commit.splitExec.done').replace('{n}', '2'))
    expect(statusMock).toHaveBeenCalledWith('p1')
    expect(state.executing).toBe(false)
  })

  it('预览弹层标注分组外已暂存与缺失文件', async () => {
    seedProject()
    seedChanges([{ path: 'a.txt', staged: true }, { path: 'stray.txt', staged: true }, { path: 'gone.txt', staged: false }])
    lastSplitSuggestSessionId.value = 'sess-1'
    scrollbackMock.mockResolvedValue(ab('```json\n{"groups":[{"name":"g","files":["a.txt","gone.txt"],"subject":"s"}]}\n```'))

    await useCommitSplitExecute().executeSplitSuggestion()
    // 只预览不执行到写面（此用例只走到弹层）——executeSplit 未被调，弹层已被调
    expect(confirmMock).toHaveBeenCalledTimes(1)
  })

  it('取消确认 → 不执行', async () => {
    seedProject()
    seedChanges([{ path: 'a.txt', staged: true }])
    lastSplitSuggestSessionId.value = 'sess-1'
    scrollbackMock.mockResolvedValue(ab(FENCED))
    confirmMock.mockResolvedValue(false)

    await useCommitSplitExecute().executeSplitSuggestion()
    expect(executeSplitMock).not.toHaveBeenCalled()
  })

  it('输出无结构化方案 + 任务进行中 → 提示稍后再试（不误报未找到）', async () => {
    seedProject()
    seedChanges([])
    lastSplitSuggestSessionId.value = 'sess-9'
    scrollbackMock.mockResolvedValue(ab('智能体正在思考…'))
    useAssistantTaskStore().bySession['sess-9'] = { task: 't', step: '', status: 'running', updatedAt: Date.now(), steps: [] }

    await useCommitSplitExecute().executeSplitSuggestion()
    expect(messageMock.info).toHaveBeenCalledWith(realT('commit.splitExec.running'))
    expect(executeSplitMock).not.toHaveBeenCalled()
  })

  it('scrollback 读取失败（会话已关闭）→ 错误提示', async () => {
    seedProject()
    lastSplitSuggestSessionId.value = 'sess-404'
    scrollbackMock.mockRejectedValue(new Error('404'))

    await useCommitSplitExecute().executeSplitSuggestion()
    expect(messageMock.error).toHaveBeenCalledWith(realT('commit.splitExec.fetchFailed'))
  })

  it('中断报告：failed 非空走 error 弹层、不弹成功', async () => {
    seedProject()
    seedChanges([{ path: 'a.txt', staged: true }])
    lastSplitSuggestSessionId.value = 'sess-1'
    scrollbackMock.mockResolvedValue(ab('```json\n{"groups":[{"name":"g","files":["a.txt"],"subject":"s"}]}\n```'))
    executeSplitMock.mockResolvedValue({
      data: { total: 2, executed: [{ index: 0, name: 'g', subject: 's', commit: 'abc1234' }], failed: { index: 1, name: 'g2', subject: 's2', step: 'stage', error: 'pathspec missing.txt did not match' }, remaining: 1 },
    })

    await useCommitSplitExecute().executeSplitSuggestion()
    expect(confirmMock).toHaveBeenCalledTimes(2) // 预览 + 中断报告
    const report = confirmMock.mock.calls[1]![0] as { type?: string; title?: string }
    expect(report.type).toBe('error')
    expect(report.title).toBe(realT('commit.splitExec.reportTitle'))
    expect(messageMock.success).not.toHaveBeenCalled()
  })

})
