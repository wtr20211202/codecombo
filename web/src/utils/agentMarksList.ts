// agent 改动清单 markdown 构建（P-20261003-52）：把文件树 agent marks 聚合
// 转述为行式清单（`- path (runtime)`），供贴给下一个 agent 的 prompt / PR 描述 /
// 交接班摘要引用。排序 = 全路径字典序（marks 键为项目相对正斜杠路径，即目录
// 分组序）；多会话共改标注 ×N；runtime 列表 `/` 连接，空列表降级为调用方注入
// 的「未知运行时」文案（纯函数不碰 i18n，可独立单测）
import type { AgentMark } from '../composables/useAgentMarks'

export function buildAgentMarksMarkdown(marks: Map<string, AgentMark>, unknownRuntimeLabel: string): string {
  const lines: string[] = []
  for (const path of [...marks.keys()].sort()) {
    const mark = marks.get(path)!
    const runtime = mark.runtimes.length > 0 ? mark.runtimes.join('/') : unknownRuntimeLabel
    const multi = mark.sessions > 1 ? ` ×${mark.sessions}` : ''
    lines.push(`- ${path} (${runtime})${multi}`)
  }
  return lines.join('\n')
}

/** 归属摘要（P-20261005-172）：给定清单中命中 agent marks 的文件数 + 涉及的
 *  runtime 并集（marks 记录序，join 由调用方按模板插值）。ask 链上下文组装
 *  （生成提交信息 P-138 / 审查变更集 P-20261005-2）的归属行数据面——只出一行
 *  计数摘要不逐文件展开（500 字节预算内一行足，逐文件清单已有 marks 清单形态
 *  buildAgentMarksMarkdown 供以 marks 为体的消费方）。无命中返回 null——调用方
 *  整行省略，不给 agent 空归属噪音 */
export function summarizeAgentMarks(files: { path: string }[], marks: Map<string, AgentMark>): { count: number; runtimes: string[] } | null {
  let count = 0
  const runtimes: string[] = []
  for (const f of files) {
    const mark = marks.get(f.path)
    if (!mark) continue
    count++
    for (const r of mark.runtimes) {
      if (!runtimes.includes(r)) runtimes.push(r)
    }
  }
  return count > 0 ? { count, runtimes } : null
}
