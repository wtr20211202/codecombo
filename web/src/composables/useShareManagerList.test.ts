import { describe, expect, it } from 'vitest'
import { nextTick, ref } from 'vue'
import type { ShareInfo } from '../api/domains/share'
import {
  compareShareRows, shareAbnormal, shareConsumed, shareExpired, shareHealth,
  shareMatchesStatus, shareSortValue, sortShareRows, useShareManagerList,
} from './useShareManagerList'

// 分享管理列表筛选/状态/排序（P-20261020-10）单测：纯函数矩阵 + 组合式
// 分页/计数/回第 1 页。

const BASE: ShareInfo = {
  token: 't0',
  kind: 'file',
  projectId: 'p1',
  projectName: 'demo',
  path: 'a.txt',
  name: 'a.txt',
  isDir: false,
  size: 1,
  createdAt: '2026-10-01T00:00:00Z',
}

function row(overrides: Partial<ShareInfo>): ShareInfo {
  return { ...BASE, ...overrides }
}

describe('shareHealth / status predicates', () => {
  it('旧服务端缺 health 按 ok 回落；异常判定只认非 ok', () => {
    expect(shareHealth(row({}))).toBe('ok')
    expect(shareAbnormal(row({}))).toBe(false)
    expect(shareHealth(row({ health: 'target_missing' }))).toBe('target_missing')
    expect(shareAbnormal(row({ health: 'snapshot_missing' }))).toBe(true)
  })

  it('过期/消费/异常可重叠；active 仅三者皆否', () => {
    const now = Date.parse('2026-10-10T00:00:00Z')
    const expiredBroken = row({
      expiresAt: '2026-10-09T00:00:00Z',
      consumed: true,
      health: 'target_missing',
    })
    expect(shareExpired(expiredBroken, now)).toBe(true)
    expect(shareConsumed(expiredBroken)).toBe(true)
    expect(shareMatchesStatus(expiredBroken, 'expired', now)).toBe(true)
    expect(shareMatchesStatus(expiredBroken, 'consumed', now)).toBe(true)
    expect(shareMatchesStatus(expiredBroken, 'abnormal', now)).toBe(true)
    expect(shareMatchesStatus(expiredBroken, 'active', now)).toBe(false)
    expect(shareMatchesStatus(row({}), 'active', now)).toBe(true)
    // 无 expiresAt = 永久，不算过期
    expect(shareExpired(row({}), now)).toBe(false)
    // 无效日期不误判为过期
    expect(shareExpired(row({ expiresAt: 'not-a-date' }), now)).toBe(false)
  })
})

describe('sortShareRows', () => {
  it('创建/访问/快照体积数值排序；缺省值升降序都排最后', () => {
    const old = row({ token: 'old', createdAt: '2026-10-01T00:00:00Z', hits: 0, lastAccessAt: undefined, frozenBytes: undefined })
    const mid = row({ token: 'mid', createdAt: '2026-10-02T00:00:00Z', hits: 5, lastAccessAt: '2026-10-05T00:00:00Z', frozenBytes: 10 })
    const newOne = row({ token: 'new', createdAt: '2026-10-03T00:00:00Z', hits: 2, lastAccessAt: '2026-10-04T00:00:00Z', frozenBytes: 99 })

    expect(sortShareRows([old, mid, newOne], 'createdAt', 'ascend').map((s) => s.token)).toEqual(['old', 'mid', 'new'])
    expect(sortShareRows([old, mid, newOne], 'createdAt', 'descend').map((s) => s.token)).toEqual(['new', 'mid', 'old'])
    expect(sortShareRows([mid, old, newOne], 'hits', 'ascend').map((s) => s.token)).toEqual(['old', 'new', 'mid'])
    expect(sortShareRows([mid, old, newOne], 'lastAccessAt', 'descend').map((s) => s.token)).toEqual(['mid', 'new', 'old'])
    // frozenBytes: old 缺省恒最后（descend 也不翻到榜首）
    expect(sortShareRows([old, mid, newOne], 'frozenBytes', 'descend').map((s) => s.token)).toEqual(['new', 'mid', 'old'])
    // 无排序时原样返回（同一引用，避免无谓拷贝）
    const input = [old, mid]
    expect(sortShareRows(input, '', false)).toBe(input)
  })

  it('有效期排序把无有效期行排最后', () => {
    const noExpiry = row({ token: 'none' })
    const early = row({ token: 'early', expiresAt: '2026-10-05T00:00:00Z' })
    const late = row({ token: 'late', expiresAt: '2026-10-09T00:00:00Z' })
    expect(sortShareRows([noExpiry, late, early], 'expiresAt', 'ascend').map((s) => s.token))
      .toEqual(['early', 'late', 'none'])
    expect(compareShareRows(noExpiry, early, 'expiresAt')).toBeGreaterThan(0)
    expect(shareSortValue(noExpiry, 'expiresAt')).toBeNull()
  })
})

describe('useShareManagerList', () => {
  it('搜索/类别/状态叠加过滤，条件变化回第 1 页', async () => {
    const now = ref(Date.parse('2026-10-10T00:00:00Z'))
    const shares = ref<ShareInfo[]>([
      row({ token: 'a', name: 'alpha.txt', path: 'src/alpha.txt' }),
      row({ token: 'b', kind: 'snippet', name: 'beta snippet', path: '', health: 'target_missing' }),
      row({ token: 'c', name: 'gamma.txt', expiresAt: '2026-10-01T00:00:00Z' }),
    ])
    const list = useShareManagerList(shares, now, 2)
    expect(list.visibleShares.value).toHaveLength(3)
    expect(list.abnormalCount.value).toBe(1)

    list.page.value = 2
    list.statusFilter.value = 'abnormal'
    await nextTick()
    expect(list.page.value).toBe(1) // 筛选变化回第 1 页
    expect(list.visibleShares.value.map((s) => s.token)).toEqual(['b'])
    expect(list.pageCount.value).toBe(1)
    expect(list.isFiltering.value).toBe(true)

    list.statusFilter.value = ''
    list.kindFilter.value = 'file'
    expect(list.visibleShares.value.map((s) => s.token)).toEqual(['a', 'c'])
    list.search.value = 'gamma'
    expect(list.visibleShares.value.map((s) => s.token)).toEqual(['c'])
    // 类别与状态叠加：file + expired 命中 c
    list.search.value = ''
    list.statusFilter.value = 'expired'
    expect(list.visibleShares.value.map((s) => s.token)).toEqual(['c'])
    // 再点已选状态徽标 = 取消回全部
    list.onStatusChecked('expired', false)
    expect(list.statusFilter.value).toBe('')
  })

  it('onSorter 只接受可排序列，清除排序回到注册序', () => {
    const shares = ref<ShareInfo[]>([])
    const list = useShareManagerList(shares, ref(Date.now()))
    expect(list.sortOrderFor('createdAt')).toBe(false)
    list.onSorter({ columnKey: 'createdAt', order: 'descend' })
    expect(list.sortKey.value).toBe('createdAt')
    expect(list.sortOrderFor('createdAt')).toBe('descend')
    expect(list.sortOrderFor('hits')).toBe(false)
    list.onSorter({ columnKey: 'name', order: 'ascend' })
    expect(list.sortKey.value).toBe('createdAt') // 不可排序列忽略
    list.onSorter({ columnKey: 'createdAt', order: false })
    expect(list.sortKey.value).toBe('')
    expect(list.sortOrderFor('createdAt')).toBe(false)
  })

  it('分页按预排序全集切片；abnormalCount 不受筛选影响', () => {
    const shares = ref<ShareInfo[]>([
      row({ token: '1', createdAt: '2026-10-01T00:00:00Z' }),
      row({ token: '2', createdAt: '2026-10-02T00:00:00Z' }),
      row({ token: '3', createdAt: '2026-10-03T00:00:00Z', health: 'project_gone' }),
    ])
    const list = useShareManagerList(shares, ref(Date.now()), 2)
    list.onSorter({ columnKey: 'createdAt', order: 'descend' })
    expect(list.paged.value.map((s) => s.token)).toEqual(['3', '2'])
    list.page.value = 2
    expect(list.paged.value.map((s) => s.token)).toEqual(['1'])
    list.statusFilter.value = 'abnormal'
    expect(list.visibleShares.value.map((s) => s.token)).toEqual(['3'])
    expect(list.abnormalCount.value).toBe(1) // 筛选不改变全局异常计数
  })
})
