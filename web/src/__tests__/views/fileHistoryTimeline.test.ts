import { describe, it, expect } from 'vitest'
import { buildTimeline, type RawGitCommit, type RawLocalVersion } from '../../views/changes/fileHistoryTimeline'

// 单文件聚合时间线（P-20261008-11）合流逻辑：git 提交 × 本地保存快照按时间
// 降序穿插；时间窗对齐（提交只取 ≥ 最旧快照时刻的窗口，窗口外只回告条数）；
// 无快照 = 窗口不存在 → 提交全量照列（既有纯 git 视图零行为变化）。

const commit = (hash: string, iso: string, message = `msg-${hash}`): RawGitCommit => ({
  hash,
  shortHash: hash.slice(0, 7),
  message,
  author: 'e2e',
  date: iso,
})

const version = (id: string, ts: number, size = 100): RawLocalVersion => ({ id, ts, size })

describe('buildTimeline', () => {
  it('git 与本地条目按时间降序穿插', () => {
    // 3 提交 + 2 快照：快照夹在提交之间 → 合流后 5 条交错（全部落在窗口内）
    const built = buildTimeline(
      [
        commit('c3', '2026-10-24T10:05:00Z'),
        commit('c2', '2026-10-24T09:00:00Z'),
        commit('c1', '2026-10-24T08:00:00Z'),
      ],
      [version('v2', Date.parse('2026-10-24T09:30:00Z')), version('v1', Date.parse('2026-10-24T07:30:00Z'))],
    )
    expect(built.olderCommits).toBe(0)
    expect(built.entries.map(e => `${e.kind}:${e.kind === 'git' ? e.hash : e.id}`)).toEqual([
      'git:c3',
      'local:v2',
      'git:c2',
      'git:c1',
      'local:v1',
    ])
  })

  it('同时刻（同秒提交+保存）git 提交在前', () => {
    const ts = Date.parse('2026-10-24T10:05:00Z')
    const built = buildTimeline([commit('c3', '2026-10-24T10:05:00Z')], [version('v1', ts)])
    expect(built.entries.map(e => e.kind)).toEqual(['git', 'local'])
  })

  it('时间窗对齐：窗口（最旧快照）之前的提交不混列，olderCommits 如实回告', () => {
    const built = buildTimeline(
      [
        commit('c4', '2026-10-24T12:00:00Z'),
        commit('c3', '2026-10-24T10:00:00Z'),
        commit('c2', '2026-10-24T09:00:00Z'),
        commit('c1', '2026-10-24T08:00:00Z'),
      ],
      [version('v1', Date.parse('2026-10-24T09:30:00Z'))],
    )
    // 窗口起点 = 09:30：c3(10:00)/c4(12:00) 在窗内，c1/c2 更早 → 注记条数 2
    expect(built.olderCommits).toBe(2)
    expect(built.entries.map(e => `${e.kind}:${e.kind === 'git' ? e.hash : e.id}`)).toEqual([
      'git:c4',
      'git:c3',
      'local:v1',
    ])
  })

  it('无快照 = 无窗口：提交全量照列（既有纯 git 视图零行为变化）', () => {
    const built = buildTimeline(
      [commit('c2', '2026-10-24T10:00:00Z'), commit('c1', '2026-10-24T08:00:00Z')],
      [],
    )
    expect(built.olderCommits).toBe(0)
    expect(built.entries.map(e => e.kind === 'git' ? e.hash : '')).toEqual(['c2', 'c1'])
  })

  it('date 缺失/非法的提交在无窗时沉底仍可见，在有窗时计入 olderCommits', () => {
    const noDate: RawGitCommit[] = [{ hash: 'cx', shortHash: 'cx', message: 'm', author: 'a', date: null }]
    expect(buildTimeline(noDate, []).entries[0]).toMatchObject({ kind: 'git', ts: 0 })
    expect(buildTimeline(noDate, [version('v1', 1000)]).olderCommits).toBe(1)
    expect(buildTimeline([commit('cx', 'not-a-date')], [version('v1', 1000)]).olderCommits).toBe(1)
  })

  it('空双源 → 空列表零注记（空态文案由调用方渲染）', () => {
    const built = buildTimeline([], [])
    expect(built.entries).toEqual([])
    expect(built.olderCommits).toBe(0)
  })
})
