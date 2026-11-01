/**
 * 「忽略空白」diff 后处理：把「仅首尾空白不同」的删/加行对降级为 context 行。
 *
 * getfileDiff 返回的是已算好的 unified diff 文本，前端改不了比较算法，只能在
 * 解析结果上后处理。为守住「错位比噪声更糟」的底线，配对规则取保守口径：
 *  - 只在相邻的连续 del 段与连续 add 段「等长」时逐对配对（等长才有对位意义）；
 *  - 段内逐对判断：trim 等价的行对合并为 context（展示新侧内容，行号两侧各留），
 *    trim 不等的行对原样保留；段长不等则整段原样保留。
 * 合并只发生在 hunk.lines 内部，hunk 数组一一映射 → hunkIndex 不变（hunk 级
 * 暂存按索引回传服务端，服务端仍按原始 diff 文本定位，不受显示层收缩影响）；
 * 行号两侧各自连续，虚拟列表行高固定，行数收缩安全。
 */

export interface DiffLine {
  type: 'hunk' | 'add' | 'del' | 'context' | 'header'
  content: string
  oldLineNo?: number
  newLineNo?: number
}

export interface HunkGroup {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: DiffLine[]
}

/** trim 等价：剥掉首尾空白（含 CRLF 归一差异残留的 \r）后相同，纯空白行与空行等价 */
function isTrimEqual(a: string, b: string): boolean {
  return a.trim() === b.trim()
}

/** 对单个 hunk 做空白-only 行对合并；hunk 头/header 行原样透传 */
export function coalesceWhitespaceOnly(hunk: HunkGroup): HunkGroup {
  const lines = hunk.lines
  const out: DiffLine[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line.type !== 'del') {
      out.push(line)
      i++
      continue
    }
    // 收集连续 del 段与紧随的连续 add 段
    let delEnd = i
    while (delEnd < lines.length && lines[delEnd]!.type === 'del') delEnd++
    let addEnd = delEnd
    while (addEnd < lines.length && lines[addEnd]!.type === 'add') addEnd++
    const dels = lines.slice(i, delEnd)
    const adds = lines.slice(delEnd, addEnd)
    if (dels.length === adds.length) {
      for (let p = 0; p < dels.length; p++) {
        const del = dels[p]!
        const add = adds[p]!
        if (isTrimEqual(del.content, add.content)) {
          out.push({ type: 'context', content: add.content, oldLineNo: del.oldLineNo, newLineNo: add.newLineNo })
        } else {
          out.push(del, add)
        }
      }
    } else {
      out.push(...dels, ...adds)
    }
    i = addEnd
  }
  return { ...hunk, lines: out }
}
