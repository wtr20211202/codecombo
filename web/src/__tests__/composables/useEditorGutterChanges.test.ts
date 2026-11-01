import { describe, it, expect } from 'vitest'
import { expandHunksToChangedLines, GUTTER_CHANGES_MAX_LINES, type DiffHunkLike } from '@/composables/useEditorGutterChanges'

/**
 * gutter 变更条（P-20261003-14）hunk 展开纯函数单测：
 * e2e 触达不了 5000 行护栏与配对分类的边界组合，落单测。
 * content 形状对齐服务端 parseHunks（含 @@ 头行，git unified diff 原文）。
 */

function hunk(partial: Partial<DiffHunkLike> & { content: string }): DiffHunkLike {
  return { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, ...partial }
}

describe('expandHunksToChangedLines', () => {
  it('空 hunk 列表返回空标记', () => {
    expect(expandHunksToChangedLines([])).toEqual([])
  })

  it('纯新增段分类为 added，行号按新侧推进', () => {
    const marks = expandHunksToChangedLines([
      hunk({ newStart: 3, content: '@@ -1,3 +3,2 @@\n line2\n+line3-added\n+line4-added' }),
    ])
    expect(marks).toEqual([
      { line: 4, kind: 'added' },
      { line: 5, kind: 'added' },
    ])
  })

  it('删除配对的新行分类为 modified（改行），多余新增仍为 added', () => {
    const marks = expandHunksToChangedLines([
      hunk({ newStart: 1, content: '@@ -1,3 +1,4 @@\n-line1\n+line1-mod\n+line1b-insert\n line2' }),
    ])
    expect(marks).toEqual([
      { line: 1, kind: 'modified' },
      { line: 2, kind: 'added' },
    ])
  })

  it('纯删除不产生标记（新侧无行可落）', () => {
    const marks = expandHunksToChangedLines([
      hunk({ newStart: 1, content: '@@ -1,3 +1,2 @@\n-dead1\n-dead2\n line3' }),
    ])
    expect(marks).toEqual([])
  })

  it('上下文行收口配对：隔上下文的增删不跨块配对', () => {
    const marks = expandHunksToChangedLines([
      hunk({ newStart: 1, content: '@@ -1,5 +1,5 @@\n-old-a\n+new-a\n ctx\n-old-b\n+new-b' }),
    ])
    expect(marks).toEqual([
      { line: 1, kind: 'modified' },
      { line: 3, kind: 'modified' },
    ])
  })

  it('跳过 @@ 头行与 No newline 标记，不吞行号', () => {
    const marks = expandHunksToChangedLines([
      hunk({ newStart: 2, content: '@@ -1,2 +2,2 @@\n-tail\n+tail-mod\n\\ No newline at end of file' }),
    ])
    expect(marks).toEqual([{ line: 2, kind: 'modified' }])
  })

  it('多 hunk 行号各自从 newStart 起算', () => {
    const marks = expandHunksToChangedLines([
      hunk({ newStart: 1, content: '@@ -1,2 +1,2 @@\n-a\n+b' }),
      hunk({ newStart: 10, content: '@@ -9,2 +10,2 @@\n-x\n+y' }),
    ])
    expect(marks).toEqual([
      { line: 1, kind: 'modified' },
      { line: 10, kind: 'modified' },
    ])
  })

  it('变更行超护栏整单跳过返回空', () => {
    const adds = Array.from({ length: GUTTER_CHANGES_MAX_LINES + 1 }, (_, i) => `+gen${i}`)
    const marks = expandHunksToChangedLines([
      hunk({ newStart: 1, content: `@@ -1,1 +1,${adds.length} @@\n${adds.join('\n')}` }),
    ])
    expect(marks).toEqual([])
  })

  it('护栏内的上限行数正常返回', () => {
    const adds = Array.from({ length: GUTTER_CHANGES_MAX_LINES }, (_, i) => `+gen${i}`)
    const marks = expandHunksToChangedLines([
      hunk({ newStart: 1, content: `@@ -1,1 +1,${adds.length} @@\n${adds.join('\n')}` }),
    ])
    expect(marks).toHaveLength(GUTTER_CHANGES_MAX_LINES)
  })
})
