import { describe, it, expect } from 'vitest'
import { renderCurationMarkdown } from './claudeCurationExport'
import type { ClaudeTimelineEntry } from '../api/domains/claude'

// 策展导出渲染单测（P-20261003-144）：版式镜像服务端 renderExportMarkdown 的
// 单条口径（分节标题/工具摘要行/结果引用块），分节规则带「时刻变化也开新节」
// 的策展分叉（稀疏散点集的轮次时刻锚点保留）；口径注记随 scope/参数变化。
// 节头时刻是本地时区渲染——期望值经本地 Date 反推构造，不随跑机时区漂移

const NOW = new Date(2026, 9, 3, 14, 30, 5) // 本地时区构造：导出时间断言恒定

/** UTC 时刻串 → 该时刻在本地时区的「 · MM-DD HH:mm」期望后缀 */
function localSuffix(utc: string): string {
  const d = new Date(utc)
  const p = (n: number) => String(n).padStart(2, '0')
  return ` · ${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const T1 = '2026-10-03T06:00:00Z'
const T2 = '2026-10-03T06:01:00Z'
const T3 = '2026-10-03T06:05:00Z'

function e(partial: Partial<ClaudeTimelineEntry>): ClaudeTimelineEntry {
  return { kind: 'user', at: '', text: '', ...partial }
}

describe('renderCurationMarkdown', () => {
  it('头部：标题/会话 id/条目占比/导出时间 + 书签口径注记', () => {
    const doc = renderCurationMarkdown({
      title: '会话 A',
      sessionId: 'sess-1',
      now: NOW,
      entries: [e({ kind: 'assistant', at: T1, text: '结论' })],
      total: 40,
      scope: 'bookmarks',
    })
    expect(doc).toContain('# Claude 会话：会话 A（策展导出）')
    expect(doc).toContain('- 会话 ID：`sess-1`')
    expect(doc).toContain('- 导出条目：1（会话共 40 步）')
    expect(doc).toContain('- 导出时间：2026-10-03 14:30:05')
    expect(doc).toContain('> 注：本文档仅包含书签标记的轮次')
    expect(doc).toContain('全量内容请使用「导出 → Markdown」')
    // 无未加载书签：不出现缺失注记
    expect(doc).not.toContain('未包含。')
  })

  it('命中口径注记：引用查询词与匹配语义（字面/正则）', () => {
    const base = {
      title: 't', sessionId: 's', now: NOW, entries: [], total: 9, scope: 'hits' as const,
    }
    const literal = renderCurationMarkdown({ ...base, query: '心跳', regex: false })
    expect(literal).toContain('> 注：本文档仅包含回放搜索「心跳」的命中轮次（字面匹配）')
    const re = renderCurationMarkdown({ ...base, query: 'err.*\\d', regex: true })
    expect(re).toContain('「err.*\\d」的命中轮次（正则匹配）')
  })

  it('书签指向未加载段：缺失数如实注记', () => {
    const doc = renderCurationMarkdown({
      title: 't', sessionId: 's', now: NOW, entries: [], total: 30,
      scope: 'bookmarks', missingBookmarks: 2,
    })
    expect(doc).toContain('另有 2 个书签指向未加载的更早轮次，未包含。')
  })

  it('条目版式：分节标题带时刻、tool 摘要行、result 引用块（含失败前缀）', () => {
    const doc = renderCurationMarkdown({
      title: 't', sessionId: 's', now: NOW, total: 5, scope: 'hits', query: 'x',
      entries: [
        e({ kind: 'user', at: T1, text: '问题' }),
        e({ kind: 'assistant', at: T2, text: '答复一' }),
        e({ kind: 'tool', at: T2, text: '', tool: 'Bash', input: 'git status' }),
        e({ kind: 'assistant', at: T3, text: '答复二' }),
        e({ kind: 'result', at: T3, text: 'boom', status: 'error' }),
      ],
    })
    expect(doc).toContain(`## 👤 用户${localSuffix(T1)}`)
    expect(doc).toContain('问题\n\n')
    expect(doc).toContain(`## 🤖 助手${localSuffix(T2)}`)
    expect(doc).toContain('答复一\n\n')
    // 同刻 tool 摘要行；多行输入折叠为行内代码
    expect(doc).toContain('- 🔧 **Bash**：`git status`\n')
    // 时刻变化开新节（稀疏集的轮次时刻锚点保留）
    expect(doc).toContain(`## 🤖 助手${localSuffix(T3)}`)
    expect(doc).toContain('答复二\n\n')
    expect(doc).toContain('> ⚠️ 失败：boom\n')
    const errDoc = renderCurationMarkdown({
      title: 't', sessionId: 's', now: NOW, total: 1, scope: 'hits', query: 'x',
      entries: [e({ kind: 'result', at: '', text: 'multi\nline', status: 'error' })],
    })
    // 失败结果：⚠️ 前缀 + 多行逐行引用块
    expect(errDoc).toContain('> ⚠️ 失败：multi\n> line\n')
  })

  it('时刻相同的 tool_use+text 合同节；无时刻条目不开节不带后缀', () => {
    const doc = renderCurationMarkdown({
      title: 't', sessionId: 's', now: NOW, total: 2, scope: 'hits', query: 'x',
      entries: [
        e({ kind: 'tool', at: T1, text: '', tool: 'Read', input: 'a.ts' }),
        e({ kind: 'assistant', at: T1, text: '同刻答复' }),
        e({ kind: 'assistant', at: '', text: '无时刻续条' }),
      ],
    })
    // 同刻 assistant 只因 kind 变化开节一次；无时刻续条不开节也不带后缀
    expect(doc.split('## 🤖 助手').length - 1).toBe(1)
    expect(doc).toContain(`## 🤖 助手${localSuffix(T1)}`)
    expect(doc).toContain('同刻答复\n\n无时刻续条\n\n')
  })

  it('转义防御：工具名 * 折叠、输入含反引号加长围栏、多行输入折叠空格', () => {
    const doc = renderCurationMarkdown({
      title: 't', sessionId: 's', now: NOW, total: 1, scope: 'hits', query: 'x',
      entries: [e({ kind: 'tool', at: '', text: '', tool: 'We*ird tool', input: 'has `backtick` and\nnewline' })],
    })
    expect(doc).toContain('- 🔧 **We＊ird tool**：')
    expect(doc).toContain('``has `backtick` and newline``')
  })
})
