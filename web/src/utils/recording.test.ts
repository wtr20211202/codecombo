import { describe, expect, it } from 'vitest'
import { castChaptersToSteps, formatClock, formatBytes, maskSensitive, parseCast, type CastChapter } from './recording'

// 过程实况回放工具：cast 解析 / 兜底遮蔽（P-20261001-15）

describe('maskSensitive', () => {
  it('遮蔽 sca_ 令牌（回放渲染层兜底二次遮蔽）', () => {
    expect(maskSensitive('token=sca_abc123ABC next')).toBe('token=*** next')
  })
  it('普通文本不动', () => {
    expect(maskSensitive('scale_1 scx_; sc_ap-id')).toBe('scale_1 scx_; sc_ap-id')
  })
})

describe('parseCast', () => {
  const HEADER = JSON.stringify({ version: 2, width: 120, height: 40 })
  // 浏览器侧无 Node Buffer：TextEncoder + btoa 纯 Web API 编码
  const b64 = (s: string) => {
    const bytes = new TextEncoder().encode(s)
    let bin = ''
    bytes.forEach(b => { bin += String.fromCharCode(b) })
    return btoa(bin)
  }

  it('解析 header 与输出事件（事件文本过兜底遮蔽）', () => {
    const ev = JSON.stringify([1.5, 'o', 'token=sca_deadbeef00 done'])
    const cast = parseCast(`${HEADER}\n${ev}\n`)
    expect(cast.header).toEqual({ version: 2, width: 120, height: 40 })
    expect(cast.events).toHaveLength(1)
    expect(cast.events[0]!.t).toBe(1.5)
    expect(cast.events[0]!.text).toBe('token=*** done')
    expect(cast.chapters).toHaveLength(0)
  })

  it('OSC 133 E→C→D 链生成命令章节（含退出码）', () => {
    const lines = [
      HEADER,
      JSON.stringify([0.1, 'o', `\x1b]133;E;${b64('git push origin')}\x07`]),
      JSON.stringify([0.2, 'o', `\x1b]133;C\x07`]),
      JSON.stringify([1.0, 'o', `\x1b]133;D;0;800\x07`]),
    ]
    const cast = parseCast(lines.join('\n'))
    expect(cast.chapters).toEqual([{ t: 0.2, label: 'git push origin', exitCode: 0 }])
  })

  it('章节标签含令牌时被遮蔽', () => {
    const lines = [
      HEADER,
      JSON.stringify([0.1, 'o', `\x1b]133;E;${b64('deploy --token sca_beef4242')}\x07`]),
      JSON.stringify([0.2, 'o', `\x1b]133;C\x07`]),
    ]
    const cast = parseCast(lines.join('\n'))
    expect(cast.chapters[0]!.label).toBe('deploy --token ***')
  })

  it('非法行跳过不影响其余事件', () => {
    const ok = JSON.stringify([0.5, 'o', 'hello'])
    const cast = parseCast([HEADER, 'not-json', JSON.stringify(['x', 'o', 'bad']), ok].join('\n'))
    expect(cast.events).toHaveLength(1)
    expect(cast.events[0]!.text).toBe('hello')
  })
})

// 存为运行书（P-20261005-3）：录制章节 → 运行书草稿步骤的纯映射
describe('castChaptersToSteps', () => {
  const ch = (label: string, exitCode?: number): CastChapter => ({ t: 0, label, exitCode })

  it('章节 → 步骤：命令文本 + 退出码照录', () => {
    expect(castChaptersToSteps([ch('git status', 0), ch('git push origin main', 0)]))
      .toEqual([
        { command: 'git status', exitCode: 0 },
        { command: 'git push origin main', exitCode: 0 },
      ])
  })

  it('相邻重复命令折叠为单步（重试噪声不进书，退出码取末次尝试）', () => {
    const steps = castChaptersToSteps([
      ch('deploy --dry-run', 1), // 首次失败
      ch('deploy --dry-run', 0), // 现场重试成功 → 折叠，末次退出码 0（不标失败）
      ch('deploy --dry-run', 0), // 再次重复仍折叠
      ch('cleanup', 0),
    ])
    expect(steps).toEqual([
      { command: 'deploy --dry-run', exitCode: 0 },
      { command: 'cleanup', exitCode: 0 },
    ])
  })

  it('失败命令照录：末次尝试非 0 退出码保留（供描述标注失败）', () => {
    expect(castChaptersToSteps([ch('flaky check', 1), ch('flaky check', 2)]))
      .toEqual([{ command: 'flaky check', exitCode: 2 }])
  })

  it('占位符（E 帧缺失）与空白标签章节跳过', () => {
    expect(castChaptersToSteps([ch('…'), ch('   '), ch('real cmd', 0)]))
      .toEqual([{ command: 'real cmd', exitCode: 0 }])
  })
})

describe('formatting', () => {
  it('formatBytes / formatClock', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatClock(75)).toBe('1:15')
  })
})
