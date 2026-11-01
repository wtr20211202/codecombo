import { describe, expect, it } from 'vitest'
import {
  collectFleetBatches,
  fleetMemberStatus,
  type FleetBatchMeta,
} from './fleetBatches'
import type { FleetBySessionEntry } from './fleetBatches'

// 编队批聚合纯函数（P-20261005-145）单测：终态解析口径（done/failed 真终态
// 之外一律 running）+ 批分组/计数/花名册展开/排序。值班聚合卡与批级完成通知
// 共用本函数，计数口径只有一份

function session(id: string, name: string, fb?: FleetBatchMeta) {
  return { id, name, projectId: id === 'm1' ? 'proj-1' : '', fleetBatch: fb }
}

function batch(over: Partial<FleetBatchMeta> = {}): FleetBatchMeta {
  return {
    batchId: 'fleet-1',
    launchedAt: '2026-10-09T10:00:00Z',
    members: ['m1', 'm2'],
    ...over,
  }
}

function entry(over: Partial<FleetBySessionEntry> = {}): FleetBySessionEntry {
  return { task: '', step: '', status: 'running', updatedAt: 1, steps: [], ...over }
}

describe('fleetMemberStatus 终态解析', () => {
  it('done/failed 真终态如实返回；running/未上报/未知值一律 running（不虚构完成）', () => {
    const by = {
      a: entry({ status: 'done' }),
      b: entry({ status: 'failed' }),
      c: entry({ status: 'running' }),
      d: entry({ status: '' }),
    }
    expect(fleetMemberStatus(by, 'a')).toBe('done')
    expect(fleetMemberStatus(by, 'b')).toBe('failed')
    expect(fleetMemberStatus(by, 'c')).toBe('running')
    expect(fleetMemberStatus(by, 'd')).toBe('running')
    expect(fleetMemberStatus(by, 'no-such')).toBe('running')
  })
})

describe('collectFleetBatches 批聚合', () => {
  it('按 batchId 分组计数（N done / M failed / K running），非编队会话不入册', () => {
    const sessions = [
      session('m1', 'fleet: 审计', batch()),
      session('m2', 'fleet: 审计', batch()),
      session('solo', '普通会话'),
    ]
    const by = {
      m1: entry({ status: 'done' }),
      m2: entry({ status: 'failed' }),
    }
    const out = collectFleetBatches(sessions, by)
    expect(out).toHaveLength(1)
    expect(out[0]!.batchId).toBe('fleet-1')
    expect(out[0]!.total).toBe(2)
    expect(out[0]!.done).toBe(1)
    expect(out[0]!.failed).toBe(1)
    expect(out[0]!.running).toBe(0)
  })

  it('花名册展开含已关闭成员（不在会话表的成员仍计数，行标 live=false 不可跳）', () => {
    // m2 已关闭：不在 sessions，但 bySession 保留其终态（pruneClosedSessions
    // 只清 running，done/failed 供回看——聚合卡计数不缩水）
    const sessions = [session('m1', 'fleet: 审计', batch())]
    const by = {
      m1: entry({ status: 'done' }),
      m2: entry({ status: 'done' }),
    }
    const out = collectFleetBatches(sessions, by)
    expect(out[0]!.total).toBe(2)
    expect(out[0]!.done).toBe(2)
    expect(out[0]!.members.map(m => m.live)).toEqual([true, false])
  })

  it('已关闭成员无终态上报 → running 计（诚实边界：无事实不收敛）', () => {
    const sessions = [session('m1', 'fleet: 审计', batch())]
    const by = { m1: entry({ status: 'done' }) }
    const out = collectFleetBatches(sessions, by)
    expect(out[0]!.running).toBe(1)
    expect(out[0]!.done).toBe(1)
  })

  it('编队名取首个存活成员名；成员名解析回落任务名', () => {
    const sessions = [session('m1', 'fleet: 依赖审计', batch())]
    const by = {
      m2: entry({ task: '重派前的任务名', status: 'running' }),
    }
    const out = collectFleetBatches(sessions, by)
    expect(out[0]!.name).toBe('fleet: 依赖审计')
    expect(out[0]!.members[1]!.name).toBe('重派前的任务名')
  })

  it('多批按发起时间倒序（最新在上）；members 缺省空数组不炸', () => {
    const newer = batch({ batchId: 'fleet-2', launchedAt: '2026-10-09T11:00:00Z', members: ['n1'] })
    const older = batch({ batchId: 'fleet-1', launchedAt: '2026-10-09T10:00:00Z', members: [] })
    const sessions = [
      session('n1', 'fleet: 新批', newer),
      session('o1', 'fleet: 旧批', older),
    ]
    const out = collectFleetBatches(sessions, {})
    expect(out.map(b => b.batchId)).toEqual(['fleet-2', 'fleet-1'])
    expect(out[1]!.total).toBe(0)
    expect(out[1]!.members).toEqual([])
  })
})
