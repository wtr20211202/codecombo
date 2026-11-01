/**
 * 会话导出下载名合成（P-20261003-44）：`claude-<标题摘要>-<yyyymmdd>.<ext>`。
 *
 * 标题是用户内容（可含引号/CRLF/非 ASCII/路径分隔符）：控制字符与跨平台
 * 不安全字符折叠为 '-'（空格合法保留）、rune 截断、首尾 '-./ ' 修整——
 * 与服务端 ExportDownloadName 同约定。axios 响应拦截器只回 data 不透
 * Content-Disposition，浏览器侧自行合成下载名（patch 下载同款双保险），
 * 服务端同名头供直链/API 消费方。
 *
 * ext 参数（P-20261003-60）：md / jsonl 双格式共用同一套净化与摘要规则，
 * 只换扩展名（'md' 缺省 = 既有调用零变化）。
 *
 * prefix 参数（P-20261003-100）：终端输出留档导出传 'terminal'——同一套
 * 净化/摘要/回退规则，与服务端 terminal.ExportDownloadName 的
 * `terminal-<会话名>-<yyyymmdd>.txt` 命名约定对齐。
 *
 * 'zip'（P-20261003-165）：会话批量导出传 title='sessions'——
 * `claude-sessions-<yyyymmdd>.zip`，与服务端归档名
 * `claude-sessions-<yyyymmdd>-<hhmm>.zip` 同族（前端无时钟对齐诉求，
 * 日期段一致即可辨识）。
 *
 * 'json'（P-20261004-83）：客户端合成的 JSON 配置导出（自定义智能体配置
 * 搬运，prefix='codecombo(-agent)'）——同一套净化/摘要/回退规则。
 *
 * 'csv'（P-20261003-272）：搜索结果 CSV 导出传 title=查询词、prefix='search'——
 * `search-<查询词摘要>-<yyyymmdd>.csv`（留档文件名自标识搜索了什么，
 * terminal 导出的 domain-first 命名同族）；查询词净化规则天然适配
 * （控制字符/路径分隔符折叠 '-'）。
 *
 * suffix 参数（P-20261004-132）：会话导出「仅问答」档传 '-qa'——档位尾缀插在
 * 日期段与扩展名之间（`claude-<标题>-<yyyymmdd>-qa.md`），与服务端
 * ExportQADownloadName 同约定；同日同题双档下载不互相覆盖。
 */
const UNSAFE_CHARS = '\\/:*?"<>|'

export function exportFileName(
  title: string,
  now = new Date(),
  ext: 'md' | 'jsonl' | 'txt' | 'zip' | 'json' | 'csv' = 'md',
  prefix = 'claude',
  suffix = '',
): string {
  let slug = ''
  for (const ch of title) {
    const code = ch.codePointAt(0) ?? 0
    slug += code >= 0x20 && code !== 0x7f && !UNSAFE_CHARS.includes(ch) ? ch : '-'
  }
  // 连续折叠符并缩 + 首尾修整（Windows 段规则：尾 '.'/' ' 非法）
  slug = slug.replace(/-{2,}/g, '-').replace(/^[-. ]+|[-. ]+$/g, '')
  // Array.from 保 rune 边界：直接 slice 会切断代理对（emoji/CJK 扩展区）
  const clipped = Array.from(slug).slice(0, 40).join('').replace(/[-. ]+$/g, '')
  const day = now.toISOString().slice(0, 10).replace(/-/g, '')
  return `${prefix}-${clipped || 'session'}-${day}${suffix}.${ext}`
}
