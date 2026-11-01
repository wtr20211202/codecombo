import { describe, it, expect } from 'vitest'
import { exportFileName } from './exportFileName'

// 固定日期锚（toISOString 走 UTC，与实现一致）
const day = new Date('2026-10-04T12:00:00Z')

describe('exportFileName — 会话导出下载名（P-20261003-44）', () => {
  it('普通中英文标题 + 日期', () => {
    expect(exportFileName('修复 WebSocket 重连 bug', day)).toBe('claude-修复 WebSocket 重连 bug-20261004.md')
  })

  it('跨平台不安全字符折叠为 -（空格保留）', () => {
    expect(exportFileName('a"b/c\\d:e*f?g<h>i|j', day)).toBe('claude-a-b-c-d-e-f-g-h-i-j-20261004.md')
  })

  it('控制字符（CRLF/制表）折叠，不残留', () => {
    const name = exportFileName('行一\r\n行二\t行三', day)
    expect(name).toBe('claude-行一-行二-行三-20261004.md')
    expect(name).not.toMatch(/[\r\n\t]/)
  })

  it('超长标题 rune 截断到 40（代理对不切断）', () => {
    const name = exportFileName('😀'.repeat(50), day)
    // 😀 是代理对（2 UTF-16 单元）：Array.from 按 rune 截，40 个 😀 完整保留
    expect(name).toBe(`claude-${'😀'.repeat(40)}-20261004.md`)
  })

  it('纯不安全字符标题回退 session 占位', () => {
    expect(exportFileName('???///***'.slice(0, 9), day)).toBe('claude-session-20261004.md')
    expect(exportFileName('   ', day)).toBe('claude-session-20261004.md')
  })

  it('首尾折叠符/点号修整（Windows 段规则）', () => {
    const name = exportFileName('..??标题??..', day)
    expect(name).toBe('claude-标题-20261004.md')
  })
})

describe('exportFileName — 原始 JSONL 双格式（P-20261003-60）', () => {
  it('jsonl 扩展名与 md 共用净化/摘要规则', () => {
    expect(exportFileName('修复 WebSocket 重连 bug', day, 'jsonl')).toBe('claude-修复 WebSocket 重连 bug-20261004.jsonl')
    // 净化规则不变：不安全字符折叠与首尾修整照常生效
    expect(exportFileName('..??标题??..', day, 'jsonl')).toBe('claude-标题-20261004.jsonl')
  })
})

describe('exportFileName — 终端输出留档导出（P-20261003-100）', () => {
  it('terminal 前缀 + txt 扩展名：与服务端 terminal.ExportDownloadName 命名约定对齐', () => {
    expect(exportFileName('部署输出', day, 'txt', 'terminal')).toBe('terminal-部署输出-20261004.txt')
  })

  it('净化规则与前缀无关：不安全字符折叠/占位回退照常生效', () => {
    expect(exportFileName('a/b:c', day, 'txt', 'terminal')).toBe('terminal-a-b-c-20261004.txt')
    expect(exportFileName('', day, 'txt', 'terminal')).toBe('terminal-session-20261004.txt')
  })

  it('缺省 prefix 仍为 claude（既有调用零变化）', () => {
    expect(exportFileName('标题', day, 'txt')).toBe('claude-标题-20261004.txt')
  })
})

describe('exportFileName — JSON 配置导出（P-20261004-83）', () => {
  it('codecombo 前缀全量导出 / codecombo-agent 前缀单条导出', () => {
    expect(exportFileName('custom-agents', day, 'json', 'codecombo')).toBe('codecombo-custom-agents-20261004.json')
    expect(exportFileName('gemini', day, 'json', 'codecombo-agent')).toBe('codecombo-agent-gemini-20261004.json')
  })
})

describe('exportFileName — 仅问答档尾缀（P-20261004-132）', () => {
  it('suffix 插在日期段与扩展名之间，与服务端 ExportQADownloadName 同约定', () => {
    expect(exportFileName('修复 WebSocket 重连 bug', day, 'md', 'claude', '-qa'))
      .toBe('claude-修复 WebSocket 重连 bug-20261004-qa.md')
  })

  it('缺省 suffix = 既有调用零变化', () => {
    expect(exportFileName('标题', day)).toBe('claude-标题-20261004.md')
  })
})
