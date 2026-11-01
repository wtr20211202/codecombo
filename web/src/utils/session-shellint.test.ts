import { describe, it, expect } from 'vitest'
import { sessionShellIntDetected } from './session-shellint'

// 会话 shell 集成检测判据（P-20261004-90）单测：键在即已检测（C/D/E 事件驱动
// 的 runningMap/activityMap 任一），双缺键=未检测；宿主未接数据面（maps 缺省）
// 恒未检测——与静默标「无记录不判」同口径。

describe('sessionShellIntDetected', () => {
  it('两 map 都缺键 = 未检测到（新会话/未附着/刷新后窗口期的诚实滞后语义）', () => {
    expect(sessionShellIntDetected({}, {}, 's1')).toBe(false)
    expect(sessionShellIntDetected(undefined, undefined, 's1')).toBe(false)
  })

  it('runningMap 有键（C 命令开始 / D 已回提示符）= 已检测', () => {
    expect(sessionShellIntDetected({ s1: true }, {}, 's1')).toBe(true)
    expect(sessionShellIntDetected({ s1: false }, {}, 's1')).toBe(true)
  })

  it('仅 activityMap 有键（E 帧路径：文本到达先于 C/D 落账）= 已检测', () => {
    expect(sessionShellIntDetected(undefined, { s1: Date.now() }, 's1')).toBe(true)
  })

  it('按会话隔离：他会的键不影响本会话判定', () => {
    expect(sessionShellIntDetected({ other: true }, { other: 1 }, 's1')).toBe(false)
  })

  it('value 为 false/0 也算已检测——键存在即证据（D 后 running=false 不回退）', () => {
    expect(sessionShellIntDetected({ s1: false }, { s1: 0 }, 's1')).toBe(true)
  })
})
