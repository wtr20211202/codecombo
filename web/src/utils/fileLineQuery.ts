/**
 * 「文件名:行号」直达语法解析（P-20261003-302）：
 * Quick Open / 命令面板文件模式支持查询串尾 `:N`（及 `:N:C`）——终端报错栈迹里的
 * `file.ts:42` 粘进来即行级直达。解析剥离后缀只在此处做一次，纯函数便于单测。
 *
 * 边界约定：
 * - 首段用懒惰匹配（`(.+?)`）：贪心会把 `a:1:2` 拆成 line=2 丢 col——`file.ts:42:7`
 *   必须拆出 line=42、col=7
 * - 仅接受 ≥1 的整数行/列号：`:0`、`:abc`、`:1x` 一律不启用行语义（整串当文件名
 *   匹配，走既有的零命中降级搜索路径）；行号越界（大于文件行数）由消费端
 *   handleSearchOpenFile 既有的「轮询超时停在顶部」行为兜底
 * - Windows 盘符（`C:\…`）不出现在项目相对路径里，无需特判；含冒号文件名罕见，
 *   误剥离风险由调用方「剥离后仍有匹配才启用行语义」的双兜底吸收（CommandPalette）
 */
export interface FileLineQuery {
  /** 剥离行号后缀后的文件名查询串（已 trim，保留原始大小写——调用方自行折叠） */
  text: string
  /** 1-based 行号 */
  line: number
  /** 可选 1-based 列号（`:N:C` 形态） */
  col?: number
}

export function parseFileLineQuery(raw: string): FileLineQuery | null {
  const trimmed = raw.trim()
  const m = trimmed.match(/^(.+?):(\d+)(?::(\d+))?$/)
  if (!m) return null
  const line = Number(m[2])
  if (!Number.isInteger(line) || line < 1) return null
  const text = (m[1] ?? '').trim()
  if (!text) return null
  if (m[3] !== undefined) {
    const col = Number(m[3])
    if (!Number.isInteger(col) || col < 1) return null
    return { text, line, col }
  }
  return { text, line }
}
