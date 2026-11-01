/**
 * unified diff 文本摘要解析（P-20261003-253 审批卡 target 浮窗，纯函数供单测）：
 * `GET /file/diff` 数据面返回的是 unified diff 文本——浮窗只需要「改了多少 +
 * 前几行改了什么」的速读摘要，不值得为它引入完整 diff 解析器（DiffViewer 的
 * 行号解析是渲染需要，摘要场景只有增删计数与预览行）。解析规则与 DiffViewer
 * 同口径：`@@` 计改动块、`+`/`-` 计增删行（剥前缀取内容）、`--- `/`+++ `/
 * `diff `/`index ` 头与 `\ No newline` 尾注跳过、`Binary files` 提示行作为
 * meta 预览行透出（二进制差异无增删行，缺这行会被误判成「无改动」）。
 */

export interface DiffSummaryLine {
  /** add = 新增行 / del = 删除行 / meta = git 提示行（Binary files 等非内容行） */
  kind: 'add' | 'del' | 'meta'
  /** 行内容（add/del 已剥 `+`/`-` 前缀，meta 原样） */
  text: string
}

export interface DiffSummary {
  /** 新增 / 删除行数（同一段文件被「改后暂存、再改」时未暂存与已暂存 diff 会
   *  各计一次——摘要是示意口径，与 P-20261003-177 diffstat 同语义） */
  additions: number
  deletions: number
  /** 改动块（hunk）数 */
  hunks: number
  /** 预览行（变更行按序截前 maxPreviewLines 条，meta 行占位不计 hidden） */
  preview: DiffSummaryLine[]
  /** 预览截断后未展示的变更行数（0 = 全量呈现） */
  hidden: number
}

/** 摘要是否有可呈现的改动：增删计数或 meta 行任一非零（避免把二进制差异
 *  误报成「无改动」） */
export function diffSummaryHasChanges(s: DiffSummary): boolean {
  return s.additions > 0 || s.deletions > 0 || s.preview.length > 0
}

function pushPreview(out: DiffSummary, line: DiffSummaryLine, max: number): void {
  if (out.preview.length < max) {
    out.preview.push(line)
  } else if (line.kind !== 'meta') {
    out.hidden++
  }
}

/** 解析 unified diff 文本为速读摘要。非 diff 文本（空串/报错残留）产出全零
 *  摘要——调用方以 diffSummaryHasChanges 判空态 */
export function summarizeUnifiedDiff(diffText: string, maxPreviewLines = 6): DiffSummary {
  const out: DiffSummary = { additions: 0, deletions: 0, hunks: 0, preview: [], hidden: 0 }
  for (const raw of diffText.split('\n')) {
    if (raw.startsWith('@@')) {
      out.hunks++
      continue
    }
    if (raw.startsWith('diff ') || raw.startsWith('index ')
      || raw.startsWith('--- ') || raw.startsWith('+++ ')
      || raw.startsWith('\\')) continue
    if (raw.startsWith('+')) {
      out.additions++
      pushPreview(out, { kind: 'add', text: raw.slice(1) }, maxPreviewLines)
    } else if (raw.startsWith('-')) {
      out.deletions++
      pushPreview(out, { kind: 'del', text: raw.slice(1) }, maxPreviewLines)
    } else if (raw.startsWith('Binary files')) {
      pushPreview(out, { kind: 'meta', text: raw }, maxPreviewLines)
    }
  }
  return out
}
