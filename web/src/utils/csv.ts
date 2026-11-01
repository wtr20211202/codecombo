/**
 * 前端 CSV 导出构建（P-20261003-272）：搜索结果导出等纯前端生成下载共用，
 * 与服务端导出族（audit.go / opsconfirm_export.go → shared.SanitizeCSVCell）
 * 同模式——CSV 形状单一事实源在导出族惯例，前端不另起一套：
 *   - UTF-8 BOM：内容列常含非 ASCII（路径/中文行），Excel 无 BOM 按 ANSI 误读
 *   - RFC 4180 转义：含逗号/引号/换行的字段加引号，内部引号翻倍
 *   - 公式注入防护：= + - @ 及制表/回车开头的单元格前置单引号（OWASP CSV
 *     注入防护通行做法；导出列常含用户可控片段——搜索内容列即文件原文）
 * 行分隔取 LF：服务端 encoding/csv 默认即 LF，导出消费方是表格软件与脚本，
 * 三平台一致取 LF 是显式约定而非平台默认（与 P-149 复制路径同哲学）。
 */

/**
 * 单元格公式注入防护：与服务端 shared.SanitizeCSVCell（csvcell.go）同字符集
 * 同语义——两处清单须同步演进，改此处先对齐服务端。
 */
export function sanitizeCsvCell(s: string): string {
  if (s === '') return s
  switch (s[0]) {
    case '=': case '+': case '-': case '@': case '\t': case '\r':
      return `'${s}`
  }
  return s
}

/** 单行转 RFC 4180：防注入先于加引号（服务端 sanitize→csv.Writer 同序） */
function csvRow(cells: string[]): string {
  return cells
    .map((cell) => {
      const v = sanitizeCsvCell(cell)
      return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
    })
    .join(',')
}

/**
 * 构建完整 CSV 文本：UTF-8 BOM + 表头 + 数据行（LF 分隔，尾随换行收束），
 * 返回值直接可进 Blob。表头语言中立小写（机器可读口径，审计 CSV 同惯例）。
 */
export function buildCsv(header: string[], rows: string[][]): string {
  const lines = [csvRow(header), ...rows.map((cells) => csvRow(cells))]
  return `\uFEFF${lines.join('\n')}\n`
}
