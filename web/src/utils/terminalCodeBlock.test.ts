import { describe, expect, it } from 'vitest'
import { buildTerminalCodeBlock } from './terminalCodeBlock'

describe('buildTerminalCodeBlock', () => {
  it('包 ```bash 围栏并加 `$ <command>` 命令行头', () => {
    expect(buildTerminalCodeBlock('error: boom', 'npm run build')).toBe(
      '```bash\n$ npm run build\nerror: boom\n```',
    )
  })

  it('无命令文本（无 shell 集成/命令运行中）省略头行，不编造命令', () => {
    expect(buildTerminalCodeBlock('plain output')).toBe('```bash\nplain output\n```')
    expect(buildTerminalCodeBlock('plain output', '   ')).toBe('```bash\nplain output\n```')
  })

  it('选区以换行收尾时不产生围栏前空行', () => {
    expect(buildTerminalCodeBlock('line1\nline2\n', 'ls')).toBe(
      '```bash\n$ ls\nline1\nline2\n```',
    )
  })

  it('正文含 ``` 时围栏自增，防 markdown 提前闭合', () => {
    expect(buildTerminalCodeBlock('```js\ncode\n```', 'cat README.md')).toBe(
      '````bash\n$ cat README.md\n```js\ncode\n```\n````',
    )
  })

  it('正文含更长的反引号串时继续自增', () => {
    const fenced = buildTerminalCodeBlock('````\nx\n````')
    expect(fenced.startsWith('`````bash\n')).toBe(true)
    expect(fenced.endsWith('\n`````')).toBe(true)
  })

  it('CRLF 归一为 LF（剪贴板文本行尾三平台一致）', () => {
    expect(buildTerminalCodeBlock('a\r\nb', 'run')).toBe('```bash\n$ run\na\nb\n```')
  })
})
