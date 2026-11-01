/**
 * unified diff 文本解析（自 DiffViewer 拆出，纯搬运零逻辑改动）：
 * 把 `git diff` 文本流解析为 hunk 分组（HunkGroup）。文件头行（---/+++/diff/
 * index/Binary files）归入伪块 0（hunks[0]），真实 @@ 块从展示索引 1 起——
 * 服务端 hunkIndex 是 0 基且只数真实 @@ 块（server/git parseHunks 跳过文件头
 * 行），API 寻址需展示索引 -1 对位（DiffViewer.handleStageHunk 注记同源）。
 */
import type { HunkGroup } from './diffWhitespace'

export function parseUnifiedDiff(content: string): HunkGroup[] {
  const lines = content.split('\n')
  const hunks: HunkGroup[] = []
  let currentHunk: HunkGroup | null = null
  let oldLine = 0
  let newLine = 0

  for (const rawLine of lines) {
    // diff header行（--- a/file, +++ b/file 等）
    if (rawLine.startsWith('--- ') || rawLine.startsWith('+++ ') || rawLine.startsWith('diff ') || rawLine.startsWith('index ') || rawLine.startsWith('Binary files')) {
      if (!currentHunk) {
        // header行放在第一个hunk之前
        if (hunks.length === 0) {
          currentHunk = { oldStart: 0, oldCount: 0, newStart: 0, newCount: 0, lines: [] }
          hunks.push(currentHunk)
        }
        hunks[0]!.lines.push({ type: 'header', content: rawLine })
      } else {
        currentHunk!.lines.push({ type: 'header', content: rawLine })
      }
      continue
    }

    // hunk header: @@ -oldStart,oldCount +newStart,newCount @@
    const hunkMatch = rawLine.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (hunkMatch) {
      currentHunk = {
        oldStart: parseInt(hunkMatch[1]!),
        oldCount: parseInt(hunkMatch[2] || '1'),
        newStart: parseInt(hunkMatch[3]!),
        newCount: parseInt(hunkMatch[4] || '1'),
        lines: [{ type: 'hunk', content: rawLine }],
      }
      hunks.push(currentHunk)
      oldLine = currentHunk.oldStart
      newLine = currentHunk.newStart
      continue
    }

    if (!currentHunk) continue

    if (rawLine.startsWith('+')) {
      currentHunk.lines.push({ type: 'add', content: rawLine.slice(1), newLineNo: newLine })
      newLine++
    } else if (rawLine.startsWith('-')) {
      currentHunk.lines.push({ type: 'del', content: rawLine.slice(1), oldLineNo: oldLine })
      oldLine++
    } else if (rawLine.startsWith(' ')) {
      currentHunk.lines.push({ type: 'context', content: rawLine.slice(1), oldLineNo: oldLine, newLineNo: newLine })
      oldLine++
      newLine++
    } else if (rawLine === '') {
      // 空行可能是diff末尾的空行，忽略
    } else {
      currentHunk.lines.push({ type: 'context', content: rawLine, oldLineNo: oldLine, newLineNo: newLine })
      oldLine++
      newLine++
    }
  }

  return hunks
}
