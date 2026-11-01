import { describe, expect, it } from 'vitest'
import type { ShareInfo } from '../api/domains/share'
import { shareCanLocate } from './useShareLocate'

// 「定位目标」可用性（P-20261020-10）：file 形态 + 项目仍存在 + 健康 ok。

const IDS = new Set(['p1'])

function row(overrides: Partial<ShareInfo>): ShareInfo {
  return {
    token: 't1',
    kind: 'file',
    projectId: 'p1',
    projectName: 'demo',
    path: 'docs/a.md',
    name: 'a.md',
    isDir: false,
    size: 10,
    createdAt: '2026-10-01T00:00:00Z',
    ...overrides,
  }
}

describe('shareCanLocate', () => {
  it('file + 项目在 + 健康 ok 才可定位', () => {
    expect(shareCanLocate(row({}), IDS)).toBe(true)
    expect(shareCanLocate(row({ health: 'ok' }), IDS)).toBe(true)
    expect(shareCanLocate(row({ health: 'target_missing' }), IDS)).toBe(false)
    expect(shareCanLocate(row({ health: 'snapshot_missing' }), IDS)).toBe(false)
    expect(shareCanLocate(row({ projectId: 'gone' }), IDS)).toBe(false)
  })

  it('非 file 形态没有项目内目标可定位', () => {
    expect(shareCanLocate(row({ kind: 'snippet' }), IDS)).toBe(false)
    expect(shareCanLocate(row({ kind: 'terminal' }), IDS)).toBe(false)
    expect(shareCanLocate(row({ kind: 'cast' }), IDS)).toBe(false)
  })
})
