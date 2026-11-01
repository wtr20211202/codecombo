import { describe, expect, it } from 'vitest'
import { buildUiSnapshot, uiSnapshotEquals } from './uiSnapshot'
import type { UiSnapshotPayload, UiSnapshotSource } from '../api/domains/system'

function src(over: Partial<UiSnapshotSource> = {}): UiSnapshotSource {
  return {
    activeProjectId: 'proj-1',
    activeFilePath: 'web/src/main.ts',
    activeFileLine: 200,
    activeFileColumn: 7,
    side: 'files',
    sideOpen: true,
    bottom: 'terminal',
    bottomOpen: false,
    activeTerminalSessionId: 'term-9',
    ...over,
  }
}

describe('buildUiSnapshot 聚合正确性', () => {
  it('齐全数据源 → 全字段载荷（含列号）', () => {
    expect(buildUiSnapshot(src())).toEqual({
      activeProjectId: 'proj-1',
      activeFile: { path: 'web/src/main.ts', line: 200, column: 7 },
      visiblePanels: { side: 'files', sideOpen: true, bottom: 'terminal', bottomOpen: false },
      activeTerminalSessionId: 'term-9',
    })
  })

  it('无激活文件（首页/欢迎页/diff 伪键）→ activeFile 省略不传 null', () => {
    const p = buildUiSnapshot(src({ activeFilePath: '', activeFileLine: 0 }))
    expect(p.activeFile).toBeUndefined()
    expect('activeFile' in p).toBe(false)
  })

  it('行号 0（无行级定位）不携带；列号 0/缺省不携带', () => {
    expect(buildUiSnapshot(src({ activeFileLine: 0 })).activeFile).toBeUndefined()
    const noCol = buildUiSnapshot(src({ activeFileColumn: 0 }))
    expect(noCol.activeFile).toEqual({ path: 'web/src/main.ts', line: 200 })
    expect('column' in noCol.activeFile!).toBe(false)
  })

  it('空 id 字段（项目/终端会话）归一省略', () => {
    const p = buildUiSnapshot(src({ activeProjectId: '', activeTerminalSessionId: '' }))
    expect(p.activeProjectId).toBeUndefined()
    expect(p.activeTerminalSessionId).toBeUndefined()
  })
})

describe('uiSnapshotEquals 深相等判定', () => {
  it('全等载荷 true（含面板布尔组合逐项比较）', () => {
    const a = buildUiSnapshot(src())
    const b = buildUiSnapshot(src())
    expect(uiSnapshotEquals(a, b)).toBe(true)
  })

  it('任一维度差异 false：文件/行/列号/面板开合/会话 id', () => {
    const base = buildUiSnapshot(src())
    expect(uiSnapshotEquals(base, buildUiSnapshot(src({ activeFileLine: 201 })))).toBe(false)
    expect(uiSnapshotEquals(base, buildUiSnapshot(src({ activeFileColumn: 8 })))).toBe(false)
    expect(uiSnapshotEquals(base, buildUiSnapshot(src({ sideOpen: false })))).toBe(false)
    expect(uiSnapshotEquals(base, buildUiSnapshot(src({ bottomOpen: true })))).toBe(false)
    expect(uiSnapshotEquals(base, buildUiSnapshot(src({ activeTerminalSessionId: 'term-2' })))).toBe(false)
    expect(uiSnapshotEquals(base, buildUiSnapshot(src({ activeProjectId: 'proj-2' })))).toBe(false)
    expect(uiSnapshotEquals(base, buildUiSnapshot(src({ activeFilePath: 'other.ts' })))).toBe(false)
  })

  it('file 有无差异与 null/空值边界', () => {
    const withFile = buildUiSnapshot(src())
    const withoutFile = buildUiSnapshot(src({ activeFilePath: '', activeFileLine: 0 }))
    expect(uiSnapshotEquals(withFile, withoutFile)).toBe(false)
    expect(uiSnapshotEquals(null, null)).toBe(true)
    expect(uiSnapshotEquals(null, withFile)).toBe(false)
    expect(uiSnapshotEquals(withFile, null)).toBe(false)
    const same = buildUiSnapshot(src())
    expect(uiSnapshotEquals(same, same)).toBe(true)
  })
})
