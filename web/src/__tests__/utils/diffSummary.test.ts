import { describe, it, expect } from 'vitest'
import { diffSummaryHasChanges, summarizeUnifiedDiff } from '@/utils/diffSummary'

/** 审批卡 target 浮窗 diff 摘要（P-20261003-253）：unified diff 文本 → 增删
 *  计数 + 预览行的速读解析，纯函数不依赖 store/API */

describe('summarizeUnifiedDiff', () => {
  it('计数增删行并剥前缀，头行与 hunk 头不混入', () => {
    const diff = [
      'diff --git a/src/app.ts b/src/app.ts',
      'index 83db48f..f73545b 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,1 +1,2 @@',
      ' export const v = 1',
      '+export const w = 2',
    ].join('\n')
    const s = summarizeUnifiedDiff(diff)
    expect(s.additions).toBe(1)
    expect(s.deletions).toBe(0)
    expect(s.hunks).toBe(1)
    expect(s.preview).toEqual([{ kind: 'add', text: 'export const w = 2' }])
    expect(s.hidden).toBe(0)
    expect(diffSummaryHasChanges(s)).toBe(true)
  })

  it('多块多行：hunks 计数、预览按序取前 N 条、超出计 hidden', () => {
    const diff = [
      '@@ -1,3 +1,3 @@',
      '-old one',
      '+new one',
      ' context',
      '+new two',
      '@@ -10,2 +10,3 @@',
      '-old two',
      '+new three',
      '+new four',
    ].join('\n')
    const s = summarizeUnifiedDiff(diff, 3)
    expect(s.hunks).toBe(2)
    expect(s.additions).toBe(4)
    expect(s.deletions).toBe(2)
    expect(s.preview.map(l => l.kind)).toEqual(['del', 'add', 'add'])
    expect(s.hidden).toBe(3) // +new two、-old two、+new four 在截断线后
  })

  it('空 diff 产出全零摘要（判空走 diffSummaryHasChanges）', () => {
    const s = summarizeUnifiedDiff('')
    expect(s.additions).toBe(0)
    expect(s.deletions).toBe(0)
    expect(s.hunks).toBe(0)
    expect(s.preview).toEqual([])
    expect(diffSummaryHasChanges(s)).toBe(false)
  })

  it('二进制差异无增删行：Binary files 提示行透出为 meta 预览行', () => {
    const s = summarizeUnifiedDiff('diff --git a/logo.png b/logo.png\nindex aa..bb 100644\nBinary files a/logo.png and b/logo.png differ')
    expect(s.additions).toBe(0)
    expect(s.deletions).toBe(0)
    expect(s.preview).toEqual([{ kind: 'meta', text: 'Binary files a/logo.png and b/logo.png differ' }])
    expect(diffSummaryHasChanges(s)).toBe(true)
  })

  it('\\ No newline 尾注与内容行中的 +++ --- 前缀行不误计', () => {
    const diff = [
      '@@ -1,2 +1,2 @@',
      '---- a/README.md',
      '-+++ b/README.md',
      '\\ No newline at end of file',
    ].join('\n')
    const s = summarizeUnifiedDiff(diff)
    // 删除行内容以 ---/+++ 开头属文件内容本身（已剥 - 前缀后才是头行形态），
    // 前缀判定在剥前缀之前做，故正常计入删除
    expect(s.deletions).toBe(2)
    expect(s.additions).toBe(0)
    expect(s.preview.every(l => l.kind === 'del')).toBe(true)
  })
})
