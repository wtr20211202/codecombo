import { describe, expect, it } from 'vitest'
import {
  BOOKMARK_ANCHOR_MAX_LEN,
  BOOKMARK_RELOCATE_WINDOW,
  normalizeBookmarkAnchor,
  normalizeBookmarkRecords,
  relocateBookmarkRecords,
  type BookmarkRecord,
} from './bookmarkAnchor'

describe('normalizeBookmarkAnchor 行内容锚规范化（P-20261004-105）', () => {
  it('压缩连续空白 + 去首尾空白 + 截断 80 字符；空串返回空', () => {
    expect(normalizeBookmarkAnchor('  foo\t\tbar   baz ')).toBe('foo bar baz')
    expect(normalizeBookmarkAnchor('a'.repeat(200))).toBe('a'.repeat(BOOKMARK_ANCHOR_MAX_LEN))
    expect(normalizeBookmarkAnchor('   \t  ')).toBe('')
    expect(normalizeBookmarkAnchor('')).toBe('')
  })
})

describe('normalizeBookmarkRecords 旧/新双形态收编', () => {
  it('旧纯行号 number[] 与新记录混排：行号取正整数、去重升序、锚归一', () => {
    expect(normalizeBookmarkRecords([20, 3, 3, 0, -1, { line: 10, anchor: '  a\t b ' }, { line: 2 }]))
      .toEqual([{ line: 2 }, { line: 3 }, { line: 10, anchor: 'a b' }, { line: 20 }])
  })

  it('锚空串/非字符串不产锚（降级记录）；同行多记录合一', () => {
    expect(normalizeBookmarkRecords([{ line: 5, anchor: '  ' }, { line: 6, anchor: 42 as unknown as string }, { line: 7 }, { line: 7, anchor: 'x' }]))
      .toEqual([{ line: 5 }, { line: 6 }, { line: 7 }])
  })
})

describe('relocateBookmarkRecords 重定位判定', () => {
  const LINES = (lines: string[]) => (line: number): string | null =>
    line >= 1 && line <= lines.length ? lines[line - 1]! : null

  it('原行内容仍匹配 → 保持（不重定位不计失效）', () => {
    const lines = ['a', 'b', 'c']
    const res = relocateBookmarkRecords([{ line: 2, anchor: 'b' }], 3, LINES(lines))
    expect(res).toEqual({ records: [{ line: 2, anchor: 'b' }], missingAnchors: [], relocatedCount: 0 })
  })

  it('上方插入行致失配 → 窗口内唯一命中重定位', () => {
    const lines = ['x', 'y', 'z', 'a', 'b', 'c']
    const res = relocateBookmarkRecords([{ line: 2, anchor: 'b' }], 6, LINES(lines))
    expect(res).toEqual({ records: [{ line: 5, anchor: 'b' }], missingAnchors: [], relocatedCount: 1 })
  })

  it('窗口内无匹配 → 保持原行 + 记失效', () => {
    const lines = ['x', 'y', 'z']
    const res = relocateBookmarkRecords([{ line: 2, anchor: 'b' }], 3, LINES(lines))
    expect(res).toEqual({ records: [{ line: 2, anchor: 'b' }], missingAnchors: ['b'], relocatedCount: 0 })
  })

  it('窗口内多义（重复行）→ 保守保持原行 + 记失效（不瞎猜）', () => {
    const lines = ['x', 'dup', 'y', 'dup']
    const res = relocateBookmarkRecords([{ line: 1, anchor: 'dup' }], 4, LINES(lines))
    expect(res).toEqual({ records: [{ line: 1, anchor: 'dup' }], missingAnchors: ['dup'], relocatedCount: 0 })
  })

  it('窗口半径 ±20 生效：窗口边缘外唯一命中不迁移', () => {
    const lines = [...Array.from({ length: 30 }, (_, i) => `filler ${i + 1}`), 'anchor-here']
    // 原行 1，锚在 31 行（距离 30 > 20）→ 不迁移
    const far = relocateBookmarkRecords([{ line: 1, anchor: 'anchor-here' }], 31, LINES(lines))
    expect(far.relocatedCount).toBe(0)
    expect(far.missingAnchors).toEqual(['anchor-here'])
    // 锚在第 21 行（距离 20 = 窗口半径）→ 迁移
    const lines21 = ['filler', ...Array.from({ length: 19 }, (_, i) => `pad ${i}`), 'anchor-here']
    const near = relocateBookmarkRecords([{ line: 1, anchor: 'anchor-here' }], 21, LINES(lines21))
    expect(near.relocatedCount).toBe(1)
    expect(near.records[0]).toEqual({ line: 21, anchor: 'anchor-here' })
  })

  it('无锚记录（旧数据降级）原样保留不参与判定；行越界锚也可拉回', () => {
    const lines = ['a', 'b', 'c']
    const res = relocateBookmarkRecords([{ line: 9, anchor: 'c' }, { line: 2 }], 3, LINES(lines))
    expect(res.records).toEqual([{ line: 3, anchor: 'c' }, { line: 2 }])
    expect(res.relocatedCount).toBe(1)
    expect(res.missingAnchors).toEqual([])
  })

  it('窗口常量与锚长度上限为既定值（对外语义锁定）', () => {
    expect(BOOKMARK_RELOCATE_WINDOW).toBe(20)
    expect(BOOKMARK_ANCHOR_MAX_LEN).toBe(80)
  })

  it('多记录混合判定：各自独立、失效锚去重', () => {
    const lines = ['kept', 'moved-away', 'find-me']
    const records: BookmarkRecord[] = [
      { line: 1, anchor: 'kept' },        // 原行匹配 → 保持
      { line: 2, anchor: 'ghost' },       // 无匹配 → 失效
      { line: 2, anchor: 'find-me' },     // 重定位到 3
      { line: 5, anchor: 'ghost' },       // 同锚另一条也失效（去重）
    ]
    const res = relocateBookmarkRecords(records, 3, LINES(lines))
    expect(res.records).toEqual([
      { line: 1, anchor: 'kept' },
      { line: 2, anchor: 'ghost' },
      { line: 3, anchor: 'find-me' },
      { line: 5, anchor: 'ghost' },
    ])
    expect(res.missingAnchors).toEqual(['ghost'])
    expect(res.relocatedCount).toBe(1)
  })
})
