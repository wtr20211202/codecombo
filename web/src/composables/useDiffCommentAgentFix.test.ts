import { describe, expect, it } from 'vitest'
import {
  buildBatchCommentFixFullPrompt,
  buildBatchCommentFixPrompt,
  commentItemLine,
  type DiffCommentFixItem,
  type DiffCommentFixTranslator,
} from './useDiffCommentAgentFix'
import type { DiffComment } from '../utils/diffComments'

/**
 * diff 审阅留言「交给智能体修复」（P-20261006-55）纯函数单测：清单行拼装 /
 * 批量全文 / 500 字节贪心装箱（分批注记、单条超装保头裁剪、注记回吐腾位）。
 * 装箱语义为「交给智能体」族 P-159 直系先例（useTodoAgentFix 同构），方向与
 * 字节度量单一事实源见组合式头注。
 */

const t: DiffCommentFixTranslator = (key, params) => {
  const table: Record<string, string> = {
    'diff.comment.fix.headBatch': `请修复以下 ${params?.n} 处 diff 审阅留言（每条「文件:行 说明」）：`,
    'diff.comment.fix.headSingle': '请修复此 diff 审阅留言：',
    'diff.comment.fix.omitted': `（另有 ${params?.n} 条未列入本批，修完这批请再发起下一批）`,
  }
  return table[key] ?? key
}

function comment(line: number, text: string, id = `c${line}`): DiffComment {
  return { id, line, text, lineText: '', createdAt: 1, resolved: false }
}

function item(path: string, c: DiffComment): DiffCommentFixItem {
  return { path, comment: c }
}

describe('commentItemLine', () => {
  it('拼装 path:line 正文，反斜杠路径归一为 /，正文压单行', () => {
    expect(commentItemLine(item('src\\app\\main.ts', comment(12, '这里要改成 null 判断'))))
      .toBe('src/app/main.ts:12 这里要改成 null 判断')
    // 历史脏数据的换行/多空白折一空格（逐行 = 逐条的清单形态前提）
    expect(commentItemLine(item('a.ts', comment(1, '第一行\n第二行  说明'))))
      .toBe('a.ts:1 第一行 第二行 说明')
  })
})

describe('buildBatchCommentFixFullPrompt', () => {
  it('批量头 n=全部条数 + 全部清单行（未装箱）', () => {
    const full = buildBatchCommentFixFullPrompt(
      [item('a.ts', comment(3, 'fix this')), item('b.ts', comment(7, 'rename'))],
      t,
    )
    expect(full).toBe([
      '请修复以下 2 处 diff 审阅留言（每条「文件:行 说明」）：',
      'a.ts:3 fix this',
      'b.ts:7 rename',
    ].join('\n'))
  })
})

describe('buildBatchCommentFixPrompt', () => {
  it('全部装得下：无注记，included=全部', () => {
    const r = buildBatchCommentFixPrompt(
      [item('a.ts', comment(3, 'fix this')), item('b.ts', comment(7, 'rename'))],
      t,
    )
    expect(r.included).toBe(2)
    expect(r.omitted).toBe(0)
    expect(r.prompt).not.toContain('未列入本批')
  })

  it('超限截断：保头装箱 + 分批注记注记条数如实（included + omitted = 全部）', () => {
    // 每条 ~100 字节，20 条必超 500
    const items = Array.from({ length: 20 }, (_, i) =>
      item('long-path/very-long-directory-name/file.ts', comment(i + 1, `x${i}`.repeat(25))),
    )
    const r = buildBatchCommentFixPrompt(items, t)
    expect(r.included).toBeGreaterThan(0)
    expect(r.included).toBeLessThan(20)
    expect(r.included + r.omitted).toBe(20)
    expect(r.prompt).toContain(`另有 ${r.omitted} 条未列入本批`)
    // 头部计数 = 实际列入数（agent 不被失真计数误导）
    expect(r.prompt).toContain(`请修复以下 ${r.included} 处`)
    expect(new TextEncoder().encode(r.prompt).length).toBeLessThanOrEqual(500)
  })

  it('注记自身挤爆时回吐条目腾位，绝不超 500 字节', () => {
    // 装到接近 500 的条目集：注记加入即超限 → 弹出一条腾位
    const items = Array.from({ length: 8 }, (_, i) =>
      item('p/f.ts', comment(i + 1, `line-${i} ` + 'y'.repeat(60))),
    )
    const r = buildBatchCommentFixPrompt(items, t)
    expect(new TextEncoder().encode(r.prompt).length).toBeLessThanOrEqual(500)
    expect(r.included + r.omitted).toBe(8)
  })

  it('单条超装不下：第一条保头裁剪（定位头 path:line 保留）', () => {
    const r = buildBatchCommentFixPrompt(
      [item('a.ts', comment(9, '超'.repeat(400)))],
      t,
    )
    expect(r.included).toBe(1)
    expect(r.omitted).toBe(0)
    expect(new TextEncoder().encode(r.prompt).length).toBeLessThanOrEqual(500)
    expect(r.prompt.startsWith('请修复此 diff 审阅留言：\na.ts:9 ')).toBe(true)
    expect(r.prompt.endsWith('…')).toBe(true)
  })
})
