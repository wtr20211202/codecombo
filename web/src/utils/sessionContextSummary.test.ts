import { describe, expect, it } from 'vitest'
import {
  buildEnvSummaryLine,
  buildNotesSummaryLine,
  buildTodosSummaryLine,
  firstNoteParagraph,
  parseSessionContext,
  serializeSessionContext,
  NOTES_SUMMARY_MAX_BYTES,
  TODO_SUMMARY_MAX_BYTES,
  ENV_SUMMARY_MAX_BYTES,
} from './sessionContextSummary'
import zh from '../locales/zh-CN'

// 真模板翻译面：t 直接查 zh-CN 语言包插值（useEditorAskAgent.test.ts 同式——
// 不复制期望文案，locale 改动即测出）
const t = (key: string, params?: Record<string, unknown>): string => {
  let s = key.split('.').reduce<unknown>((a, c) => (a as Record<string, unknown> | undefined)?.[c], zh) as string
  for (const [k, v] of Object.entries(params ?? {})) s = s.replaceAll(`{${k}}`, String(v))
  return s
}

const byteLen = (s: string) => new TextEncoder().encode(s).length

describe('parseSessionContext / serializeSessionContext（P-20261006-47 值语法）', () => {
  it('未配置（空/undefined）回落 git-only：P-176 既有默认行为零变化', () => {
    expect(parseSessionContext('')).toEqual(['git'])
    expect(parseSessionContext(undefined)).toEqual(['git'])
    expect(parseSessionContext(null)).toEqual(['git'])
    expect(parseSessionContext('  ')).toEqual(['git'])
  })

  it('none = 显式全关（空集）', () => {
    expect(parseSessionContext('none')).toEqual([])
  })

  it('多选解析规范序去重，手改脏值取可读懂子集（整体读不懂 = 空集）', () => {
    expect(parseSessionContext('git,notes')).toEqual(['git', 'notes'])
    expect(parseSessionContext('todos, git')).toEqual(['git', 'todos'])
    expect(parseSessionContext('notes,notes')).toEqual(['notes'])
    expect(parseSessionContext('env,git')).toEqual(['git', 'env'])
    expect(parseSessionContext('git,wiki')).toEqual(['git']) // 可读懂子集保留
    expect(parseSessionContext('wiki')).toEqual([]) // 整体读不懂宁可不注入
  })

  it('序列化规范序 + 空集 = none；parse∘serialize 幂等', () => {
    expect(serializeSessionContext([])).toBe('none')
    expect(serializeSessionContext(['todos', 'git'])).toBe('git,todos')
    expect(serializeSessionContext(['env', 'todos', 'git'])).toBe('git,todos,env')
    for (const raw of ['', 'none', 'git,notes', 'todos', 'git,todos,env']) {
      expect(serializeSessionContext(parseSessionContext(raw))).toBe(raw === '' ? 'git' : raw)
    }
  })
})

describe('firstNoteParagraph', () => {
  it('取首个非空段（markdown 空行分段），段内换行折叠为空格', () => {
    expect(firstNoteParagraph('\n\n首段第一行\n首段第二行\n\n次段\n')).toBe('首段第一行 首段第二行')
  })

  it('无内容返回空串；CRLF 分段同口径', () => {
    expect(firstNoteParagraph('   ')).toBe('')
    expect(firstNoteParagraph('甲段\r\n\r\n乙段')).toBe('甲段')
  })
})

describe('buildNotesSummaryLine（P-20261006-47 笔记首段注入行）', () => {
  it('无笔记/纯空白返回空串（不产悬空标签）', () => {
    expect(buildNotesSummaryLine({ projectName: 'demo', content: '' }, t)).toBe('')
    expect(buildNotesSummaryLine({ projectName: 'demo', content: '  \n\n ' }, t)).toBe('')
  })

  it('短首段整段注入，带项目归属标注', () => {
    const line = buildNotesSummaryLine({ projectName: 'demo', content: '团队规范：提交前跑 lint。\n\n其他' }, t)
    expect(line).toBe('项目笔记（demo）：团队规范：提交前跑 lint。')
  })

  it('超长首段保头截断 + … 尾缀，总长守 NOTES_SUMMARY_MAX_BYTES', () => {
    const long = '很长的笔记内容'.repeat(80) // 8 字 ×3 字节 ×80 = 1920 字节
    const line = buildNotesSummaryLine({ projectName: 'demo', content: long }, t)
    expect(byteLen(line)).toBeLessThanOrEqual(NOTES_SUMMARY_MAX_BYTES)
    expect(line.endsWith('…')).toBe(true)
    expect(line).toContain('项目笔记（demo）：')
  })
})

describe('buildTodosSummaryLine（P-20261006-47 TODO 概要注入行）', () => {
  it('无待办返回空串', () => {
    expect(buildTodosSummaryLine({ projectName: 'demo', total: 0, truncated: false, entries: [] }, t)).toBe('')
  })

  it('计数 + 顶层条目（path:line），截断以 + 诚实标注', () => {
    const line = buildTodosSummaryLine(
      {
        projectName: 'demo',
        total: 12,
        truncated: false,
        entries: [{ path: 'src/a.ts', line: 12 }, { path: 'src/b.ts', line: 33 }],
      },
      t,
    )
    expect(line).toBe('TODO 概要（demo）：12 处待办，如 src/a.ts:12, src/b.ts:33')
    const truncatedLine = buildTodosSummaryLine(
      { projectName: 'demo', total: 500, truncated: true, entries: [{ path: 'a.ts', line: 1 }] },
      t,
    )
    expect(truncatedLine).toContain('500+ 处待办')
  })

  it('无条目（旧服务端缺 data）退化为纯计数行', () => {
    const line = buildTodosSummaryLine({ projectName: 'demo', total: 7, truncated: false, entries: [] }, t)
    expect(line).toBe('TODO 概要（demo）：7 处待办')
  })

  it('超限条目逐项让位，总长守 TODO_SUMMARY_MAX_BYTES', () => {
    const line = buildTodosSummaryLine(
      {
        projectName: '一个相当长的项目名称会挤占模板字节',
        total: 3,
        truncated: false,
        entries: [
          { path: 'very/long/directory/segment/nested/deep/path/module-a.ts', line: 112 },
          { path: 'very/long/directory/segment/nested/deep/path/module-b.ts', line: 233 },
          { path: 'very/long/directory/segment/nested/deep/path/module-c.ts', line: 354 },
        ],
      },
      t,
    )
    expect(byteLen(line)).toBeLessThanOrEqual(TODO_SUMMARY_MAX_BYTES)
    expect(line).toContain('3 处待办')
  })
})

describe('buildEnvSummaryLine（P-20261007-14 环境画像注入行）', () => {
  it('三源全无返回空串（不产悬空标签）', () => {
    expect(buildEnvSummaryLine({ projectName: 'demo', devPorts: [] }, t)).toBe('')
  })

  it('端口 + 哨兵数 + 部署目标名成行，边界注记随行', () => {
    const line = buildEnvSummaryLine(
      {
        projectName: 'demo',
        devPorts: [{ port: 5173, label: 'vite' }, { port: 3000, label: '' }],
        sentinelCount: 2,
        deployTargets: ['build', 'staging'],
      },
      t,
    )
    expect(line).toBe('环境画像（demo）：端口 5173 vite, 3000；哨兵 2 条；部署目标 build, staging（历史观测聚合，非实时拓扑）')
  })

  it('源级降级不可知（undefined）跳过该段，不冒充 0 条', () => {
    const line = buildEnvSummaryLine(
      { projectName: 'demo', devPorts: [{ port: 5173, label: 'vite' }], sentinelCount: undefined, deployTargets: undefined },
      t,
    )
    expect(line).toContain('端口 5173 vite')
    expect(line).not.toContain('哨兵')
    expect(line).not.toContain('部署目标')
  })

  it('端口/目标超展示上限标注省略，长 label 保头截断', () => {
    const line = buildEnvSummaryLine(
      {
        projectName: 'demo',
        devPorts: Array.from({ length: 6 }, (_, i) => ({ port: 5000 + i, label: 'x'.repeat(80) })),
        deployTargets: ['a', 'b', 'c', 'd'],
      },
      t,
    )
    expect(line).toContain('…')
    expect(byteLen(line)).toBeLessThanOrEqual(ENV_SUMMARY_MAX_BYTES)
  })

  it('超限让位序：部署目标先让、哨兵再让，总长守 ENV_SUMMARY_MAX_BYTES', () => {
    const line = buildEnvSummaryLine(
      {
        projectName: '一个相当长的项目名称会挤占模板字节'.repeat(4),
        devPorts: [{ port: 5173, label: 'vite dev server with a quite long label' }],
        sentinelCount: 2,
        deployTargets: ['build-host', 'staging-host'],
      },
      t,
    )
    expect(byteLen(line)).toBeLessThanOrEqual(ENV_SUMMARY_MAX_BYTES)
    expect(line).not.toContain('部署目标')
  })
})
