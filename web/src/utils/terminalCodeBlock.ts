/**
 * 终端「复制为代码块」正文组装（P-20261003-270，纯函数）。
 *
 * 选区包进 ```bash 围栏，有最近一条命令文本时加 `$ <command>` 命令行头——
 * 贴 issue/文档时自证输出来源（错误输出脱离上下文的可读性诉求）。
 *
 * 围栏长度随正文自增：正文含 ``` 时用更长的反引号串，防 markdown 提前闭合
 * （`cat README.md` 这类「输出本身含围栏」是真实场景）。选区文本原样保留
 * （不 trim——尾随空格可能是输出对齐的一部分），只保证闭合围栏独占一行：
 * 正文已以换行收尾不再补，否则补一个。无命令文本（无 shell 集成 / 命令仍在
 * 运行尚无 E 帧）时省略头行，不编造命令。
 */
export function buildTerminalCodeBlock(selection: string, command?: string): string {
  const body = selection.replace(/\r\n/g, '\n')
  let fence = '```'
  while (body.includes(fence)) fence += '`'
  const header = command && command.trim() ? `$ ${command.trim()}\n` : ''
  const content = body.endsWith('\n') ? body : `${body}\n`
  return `${fence}bash\n${header}${content}${fence}`
}
