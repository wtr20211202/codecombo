import { describe, expect, it } from 'vitest'
import { buildPostmortemAskPrompt, buildPostmortemGist } from './postmortemPrompt'
import { byteLength, LAUNCH_ARGS_MAX_BYTES } from './promptFit'
import type { PostmortemReport } from '../api/domains/terminal'

/**
 * 复盘问询 prompt 组装（P-20261004-60）：gist 事实行齐备 / 500 字节保尾截断
 * （退出码在模板头部截断不丢——转存问询闭环的关键事实约束）
 */

const t = (key: string, params?: Record<string, unknown>) => {
  const table: Record<string, string> = {
    'terminal.postmortem.exitedAt': '退出时刻',
    'terminal.postmortem.askHead': `上一个会话「${params?.name}」异常退出（exit ${params?.code}）。请先分析现场。`,
  }
  let out = table[key] ?? key
  for (const [k, v] of Object.entries(params ?? {})) out = out.replaceAll(`{${k}}`, String(v))
  return out
}

const base: PostmortemReport = {
  sessionId: 'agent-1',
  name: '崩了',
  runtime: 'claude',
  dir: 'D:/proj',
  alive: false,
  exitCode: 1,
  exitedAt: '2026-10-09T05:00:00Z',
  lastCommands: [{ command: 'npm run build\n--verbose', exitCode: 1, durationMs: 100, at: '2026-10-09T04:59:00Z' }],
  outputTail: 'Error: boom',
}

describe('buildPostmortemGist', () => {
  it('事实行齐备：exit/runtime/dir、退出时刻、末命令（压平换行）与尾部现场', () => {
    const gist = buildPostmortemGist(base, t)
    expect(gist).toContain('exit=1 runtime=claude dir=D:/proj')
    expect(gist).toContain('退出时刻: 2026-10-09T05:00:00Z')
    expect(gist).toContain('last: npm run build --verbose (exit 1)')
    expect(gist).toContain('--- tail ---\nError: boom')
  })

  it('字段缺失诚实缺省：无退出记录/末命令/尾部不虚构', () => {
    const gist = buildPostmortemGist({ sessionId: 'a', alive: true }, t)
    expect(gist).toContain('exit=? runtime=? dir=?')
    expect(gist).not.toContain('last:')
    expect(gist).not.toContain('--- tail ---')
  })
})

describe('buildPostmortemAskPrompt', () => {
  it('头部指令携会话名与退出码，gist 原文跟随', () => {
    const prompt = buildPostmortemAskPrompt(base, t)
    expect(prompt).toContain('上一个会话「崩了」异常退出（exit 1）')
    expect(prompt).toContain('Error: boom')
    expect(byteLength(prompt)).toBeLessThanOrEqual(LAUNCH_ARGS_MAX_BYTES)
  })

  it('超限时保尾截断：头部指令完整、尾部现场保留、总量仍在 500 字节内', () => {
    const huge: PostmortemReport = {
      ...base,
      outputTail: Array.from({ length: 60 }, (_, i) => `line-${i}-${'x'.repeat(40)}`).join('\n'),
    }
    const prompt = buildPostmortemAskPrompt(huge, t)
    expect(byteLength(prompt)).toBeLessThanOrEqual(LAUNCH_ARGS_MAX_BYTES)
    expect(prompt.startsWith('上一个会话「崩了」异常退出（exit 1）')).toBe(true)
    // 保尾：最靠后的行必须存活（报错现场在尾部）
    expect(prompt).toContain('line-59-')
    // 截断发生时有省略号标注
    expect(prompt).toContain('…')
  })
})
