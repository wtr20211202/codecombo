/**
 * diff 行号 → hunk 上下文构造（P-20261003-208「追问此改动」）：diff 标签
 * （DiffEditor/Monaco diff）右键行定位所属变更块并产出 ask-agent prompt
 * 摘要。纯函数、零 Monaco 依赖（行内容经取行函数注入），单测免 Monaco 环境；
 * 不调服务端 GetFileHunks——diff 标签存在 HEAD/commit/互比多形态，行号语义
 * 以当前视图两侧 model 为准才与所见一致（消费方 DiffEditor.getLineChanges）。
 */

/** Monaco diff 变更块的最小形状（monaco.editor.ILineChange 的结构子集，
 *  避免本工具依赖 monaco-editor 类型入口——调用方直接传 getLineChanges()
 *  结果，结构化类型天然兼容） */
export interface DiffLineChange {
  originalStartLineNumber: number
  originalEndLineNumber: number
  modifiedStartLineNumber: number
  modifiedEndLineNumber: number
}

export type DiffSide = 'original' | 'modified'

/** 行 → 变更块：含所属优先，最近兜底（点击行落在块间上下文区时取最近块——
 *  追问周边行同样成立）。零行侧（纯增/纯删的另一端，end = start - 1）不参与
 *  距离计算。changes 空（两侧全同）返回 null */
export function findChangeAtLine(
  changes: DiffLineChange[],
  line: number,
  side: DiffSide,
): DiffLineChange | null {
  let best: DiffLineChange | null = null
  let bestDist = Number.POSITIVE_INFINITY
  for (const c of changes) {
    const start = side === 'modified' ? c.modifiedStartLineNumber : c.originalStartLineNumber
    const end = Math.max(side === 'modified' ? c.modifiedEndLineNumber : c.originalEndLineNumber, start - 1)
    const dist = line < start ? start - line : line > end ? line - end : 0
    if (dist < bestDist) {
      bestDist = dist
      best = c
    }
  }
  return best
}

/** 摘要每侧采样行数上限：hunk 摘要是 500 字节 launchArgs 装箱载荷的变量段，
 *  3 行/侧足以定位「改的是什么」，更长的块交 useEditorAskAgent 的字节裁剪
 *  （保头——点击行邻近的变更行在摘要头部） */
const SUMMARY_LINES_PER_SIDE = 3

/** 行 → hunk 摘要：diff hunk 头形态（@@ -o,count +m,count @@，零行侧计 0
 *  对齐 git 语义）+ 两侧变更行样本（前缀 -/+）。getLine 两侧取行函数
 *  （n 从 1 计）；无变更块或两侧都取不到行返回空串（调用方退化为纯文件+行号
 *  定位头） */
export function buildDiffHunkSummary(
  changes: DiffLineChange[],
  line: number,
  side: DiffSide,
  getLine: (m: DiffSide, n: number) => string,
): string {
  const c = findChangeAtLine(changes, line, side)
  if (!c) return ''
  const sample = (m: DiffSide, start: number, end: number, prefix: string): string[] => {
    const out: string[] = []
    const stop = Math.min(end, start + SUMMARY_LINES_PER_SIDE - 1)
    for (let n = Math.max(start, 1); n <= stop; n++) out.push(prefix + getLine(m, n))
    return out
  }
  const lines = [
    ...sample('original', c.originalStartLineNumber, c.originalEndLineNumber, '- '),
    ...sample('modified', c.modifiedStartLineNumber, c.modifiedEndLineNumber, '+ '),
  ]
  if (lines.length === 0) return ''
  const origCount = Math.max(c.originalEndLineNumber - c.originalStartLineNumber + 1, 0)
  const modCount = Math.max(c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1, 0)
  const head = `@@ -${c.originalStartLineNumber},${origCount} +${c.modifiedStartLineNumber},${modCount} @@`
  return head + '\n' + lines.join('\n')
}
