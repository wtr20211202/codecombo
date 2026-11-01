import { describe, it, expect, beforeEach } from 'vitest'
import { safeStorage } from './storage'
import {
  loadCmdUsage, saveCmdUsage, recordCmdUsage, topFrequentCmdIds,
  compareCmdFrecency, recencyTier,
  loadFileUsage, recordFileUsage, removeFileUsage, fileUsageKeyOf,
  CMD_USAGE_STORAGE_KEY, LEGACY_RECENT_STORAGE_KEY, CMD_USAGE_MAX_KEYS,
  FILE_USAGE_STORAGE_KEY, FILE_USAGE_MAX_KEYS,
  FRECENCY_HOT_MS, FRECENCY_WARM_MS, CMD_USAGE_TTL_MS,
} from './paletteUsage'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

beforeEach(() => {
  safeStorage.removeItem(CMD_USAGE_STORAGE_KEY)
  safeStorage.removeItem(LEGACY_RECENT_STORAGE_KEY)
  safeStorage.removeItem(FILE_USAGE_STORAGE_KEY)
})

describe('recordCmdUsage', () => {
  it('新键计 count=1，已存在键 count 累加并刷新 lastAt', () => {
    let m = recordCmdUsage({}, 'a', 1000)
    expect(m).toEqual({ a: { count: 1, lastAt: 1000 } })
    m = recordCmdUsage(m, 'a', 2000)
    m = recordCmdUsage(m, 'b', 3000)
    expect(m).toEqual({
      a: { count: 2, lastAt: 2000 },
      b: { count: 1, lastAt: 3000 },
    })
  })

  it('纯函数：不改入参', () => {
    const src = { a: { count: 1, lastAt: 1 } }
    recordCmdUsage(src, 'a', 2)
    expect(src).toEqual({ a: { count: 1, lastAt: 1 } })
  })

  it('超上限按 LRU 淘汰最久未用键；刚用过的键不被淘汰', () => {
    let m: Record<string, { count: number; lastAt: number }> = {}
    for (let i = 0; i < CMD_USAGE_MAX_KEYS; i++) m = recordCmdUsage(m, `cmd-${i}`, i + 1)
    expect(Object.keys(m)).toHaveLength(CMD_USAGE_MAX_KEYS)
    // 刷新 cmd-0（最旧 → 变新），再插入新键应淘汰此时的最旧 cmd-1
    m = recordCmdUsage(m, 'cmd-0', CMD_USAGE_MAX_KEYS + 1)
    m = recordCmdUsage(m, 'cmd-new', CMD_USAGE_MAX_KEYS + 2)
    expect(m['cmd-1']).toBeUndefined()
    expect(m['cmd-0']).toEqual({ count: 2, lastAt: CMD_USAGE_MAX_KEYS + 1 })
    expect(m['cmd-new']).toEqual({ count: 1, lastAt: CMD_USAGE_MAX_KEYS + 2 })
  })
})

describe('recencyTier（P-20261005-200 最近窗口档）', () => {
  it('24h 内=热(2)，7 天内=温(1)，更久=冷(0)，边界值取高档', () => {
    const now = 1_000_000_000
    expect(recencyTier(now - FRECENCY_HOT_MS, now)).toBe(2)
    expect(recencyTier(now - FRECENCY_HOT_MS - 1, now)).toBe(1)
    expect(recencyTier(now - FRECENCY_WARM_MS, now)).toBe(1)
    expect(recencyTier(now - FRECENCY_WARM_MS - 1, now)).toBe(0)
    // 未来时间戳（时钟回拨）按热档处理，不参与降档
    expect(recencyTier(now + DAY, now)).toBe(2)
  })
})

describe('compareCmdFrecency（最近窗口档 → 次数 → lastAt）', () => {
  const now = 10 * DAY
  it('最近窗口档优先：热档 count=1 压过温档 count=5', () => {
    const hot = { count: 1, lastAt: now - HOUR }
    const warm = { count: 5, lastAt: now - 3 * DAY }
    expect(compareCmdFrecency(hot, warm, now)).toBeLessThan(0)
    expect(compareCmdFrecency(warm, hot, now)).toBeGreaterThan(0)
  })

  it('同档内 count 权重生效；同 count 按 lastAt 降序', () => {
    const a = { count: 3, lastAt: now - HOUR }
    const b = { count: 5, lastAt: now - 2 * HOUR }
    const c = { count: 5, lastAt: now - HOUR }
    expect(compareCmdFrecency(a, b, now)).toBeGreaterThan(0)
    expect(compareCmdFrecency(b, c, now)).toBeGreaterThan(0)
  })

  it('无记录条目按零使用参与：用过的不论档位都排前，双无记录持平', () => {
    const cold = { count: 1, lastAt: now - 20 * DAY }
    expect(compareCmdFrecency(undefined, cold, now)).toBeGreaterThan(0)
    expect(compareCmdFrecency(cold, undefined, now)).toBeLessThan(0)
    expect(compareCmdFrecency(undefined, undefined, now)).toBe(0)
  })
})

describe('topFrequentCmdIds', () => {
  it('跨档：热档低频 > 温档高频 > 冷档更高频', () => {
    const now = 10 * DAY
    const m = {
      cold: { count: 9, lastAt: now - 20 * DAY },
      warm: { count: 5, lastAt: now - 3 * DAY },
      hot: { count: 1, lastAt: now - HOUR },
    }
    expect(topFrequentCmdIds(m, 3, now)).toEqual(['hot', 'warm', 'cold'])
    expect(topFrequentCmdIds(m, 2, now)).toEqual(['hot', 'warm'])
  })

  it('同档（同热）count 优先、lastAt 破平，截取前 N', () => {
    const now = 2000
    const m = {
      low: { count: 1, lastAt: 999 },
      mid: { count: 2, lastAt: 1 },
      top: { count: 3, lastAt: 1 },
      tieOld: { count: 2, lastAt: 1 },
    }
    // mid 与 tieOld 同 count 同 lastAt：Object 键序稳定排序不翻转
    expect(topFrequentCmdIds(m, 3, now)).toEqual(['top', 'mid', 'tieOld'])
    expect(topFrequentCmdIds(m, 2, now)).toEqual(['top', 'mid'])
  })

  it('空 map 返回空数组', () => {
    expect(topFrequentCmdIds({}, 5)).toEqual([])
  })
})

describe('loadCmdUsage / saveCmdUsage', () => {
  it('往返持久化', () => {
    // lastAt 相对 now=10 为新鲜条目（默认 now=Date.now() 会按过期窗丢弃 1970 值）
    saveCmdUsage({ a: { count: 2, lastAt: 5 } })
    expect(loadCmdUsage(10)).toEqual({ a: { count: 2, lastAt: 5 } })
  })

  it('损坏数据逐条丢弃（非对象整体/非法条目），合法条目保留', () => {
    safeStorage.setItem(CMD_USAGE_STORAGE_KEY, JSON.stringify({
      ok: { count: 1, lastAt: 1 },
      badCount: { count: 0, lastAt: 1 },
      badType: 'nope',
      badLast: { count: 1, lastAt: 'x' },
    }))
    expect(loadCmdUsage(2)).toEqual({ ok: { count: 1, lastAt: 1 } })
    safeStorage.setItem(CMD_USAGE_STORAGE_KEY, 'not-json{')
    expect(loadCmdUsage(2)).toEqual({})
  })

  it('超 TTL（30 天）的过期条目按失效偏好丢弃，新鲜条目保留（P-200 过期窗）', () => {
    const now = 100 * DAY
    saveCmdUsage({
      fresh: { count: 3, lastAt: now - DAY },
      stale: { count: 99, lastAt: now - CMD_USAGE_TTL_MS - 1 },
    })
    expect(loadCmdUsage(now)).toEqual({ fresh: { count: 3, lastAt: now - DAY } })
  })

  it('TTL 边界值（恰好 30 天）不过期', () => {
    const now = 100 * DAY
    saveCmdUsage({ edge: { count: 1, lastAt: now - CMD_USAGE_TTL_MS } })
    expect(loadCmdUsage(now)).toEqual({ edge: { count: 1, lastAt: now - CMD_USAGE_TTL_MS } })
  })

  it('旧「最近命令」数组一次性迁移：count=1、越靠前 lastAt 越新，旧键移除', () => {
    safeStorage.setItem(LEGACY_RECENT_STORAGE_KEY, JSON.stringify(['fresh', 'mid', 'old']))
    const now = 5 * DAY
    expect(loadCmdUsage(now)).toEqual({
      fresh: { count: 1, lastAt: now },
      mid: { count: 1, lastAt: now - 1 },
      old: { count: 1, lastAt: now - 2 },
    })
    const m = loadCmdUsage(now)
    expect(topFrequentCmdIds(m, 5, now)).toEqual(['fresh', 'mid', 'old'])
    expect(safeStorage.getItem(LEGACY_RECENT_STORAGE_KEY)).toBeNull()
  })

  it('已有新数据时不迁移（旧键仅清理），新数据原样保留', () => {
    saveCmdUsage({ a: { count: 7, lastAt: 3 } })
    safeStorage.setItem(LEGACY_RECENT_STORAGE_KEY, JSON.stringify(['legacy']))
    expect(loadCmdUsage(4)).toEqual({ a: { count: 7, lastAt: 3 } })
    expect(safeStorage.getItem(LEGACY_RECENT_STORAGE_KEY)).toBeNull()
  })
})

describe('文件层 frecency（P-20261005-222）', () => {
  it('recordFileUsage：打开即计数，同路径累加并刷新 lastAt', () => {
    recordFileUsage('p1', 'src/a.ts', 1000)
    recordFileUsage('p1', 'src/a.ts', 2000)
    expect(loadFileUsage('p1', 3000)).toEqual({ 'src/a.ts': { count: 2, lastAt: 2000 } })
  })

  it('按项目隔离：同相对路径跨项目不互染，读侧只出本项目条目', () => {
    recordFileUsage('p1', 'src/a.ts', 1000)
    recordFileUsage('p2', 'src/a.ts', 2000)
    expect(loadFileUsage('p1', 3000)).toEqual({ 'src/a.ts': { count: 1, lastAt: 1000 } })
    expect(loadFileUsage('p2', 3000)).toEqual({ 'src/a.ts': { count: 1, lastAt: 2000 } })
  })

  it('空 projectId 不读不记；路径含冒号不串项目档（前缀键含路径原样）', () => {
    recordFileUsage('', 'src/a.ts', 1000)
    expect(loadFileUsage('', 1000)).toEqual({})
    expect(safeStorage.getItem(FILE_USAGE_STORAGE_KEY)).toBeNull()
    recordFileUsage('p1', 'a:b.ts', 1000)
    expect(fileUsageKeyOf('p1', 'a:b.ts')).toBe('p1:a:b.ts')
    expect(loadFileUsage('p1', 2000)).toEqual({ 'a:b.ts': { count: 1, lastAt: 1000 } })
    expect(loadFileUsage('p2', 2000)).toEqual({})
  })

  it('removeFileUsage：精确清除该路径，他条目保留；不存在时幂等', () => {
    recordFileUsage('p1', 'src/a.ts', 1000)
    recordFileUsage('p1', 'src/b.ts', 1001)
    removeFileUsage('p1', 'src/a.ts')
    expect(loadFileUsage('p1', 2000)).toEqual({ 'src/b.ts': { count: 1, lastAt: 1001 } })
    removeFileUsage('p1', 'src/never-opened.ts')
    expect(loadFileUsage('p1', 2000)).toEqual({ 'src/b.ts': { count: 1, lastAt: 1001 } })
  })

  it('超 FILE_USAGE_MAX_KEYS 按 LRU 淘汰最久未用路径，刷新的键保留', () => {
    for (let i = 0; i < FILE_USAGE_MAX_KEYS; i++) recordFileUsage('p1', `f${i}.ts`, i + 1)
    // 刷新 f0（最旧 → 变新），再插入新键应淘汰此时的最旧 f1
    recordFileUsage('p1', 'f0.ts', FILE_USAGE_MAX_KEYS + 1)
    recordFileUsage('p1', 'new.ts', FILE_USAGE_MAX_KEYS + 2)
    const usage = loadFileUsage('p1', FILE_USAGE_MAX_KEYS + 2)
    expect(usage['f1.ts']).toBeUndefined()
    expect(usage['f0.ts']).toEqual({ count: 2, lastAt: FILE_USAGE_MAX_KEYS + 1 })
    expect(usage['new.ts']).toEqual({ count: 1, lastAt: FILE_USAGE_MAX_KEYS + 2 })
  })

  it('超 TTL（30 天）条目读侧丢弃，与命令层同过期窗；损坏数据逐条丢弃', () => {
    const now = 100 * DAY
    safeStorage.setItem(FILE_USAGE_STORAGE_KEY, JSON.stringify({
      [fileUsageKeyOf('p1', 'fresh.ts')]: { count: 1, lastAt: now - DAY },
      [fileUsageKeyOf('p1', 'stale.ts')]: { count: 9, lastAt: now - CMD_USAGE_TTL_MS - 1 },
      [fileUsageKeyOf('p2', 'other.ts')]: { count: 2, lastAt: now - DAY },
      bad: 'nope',
    }))
    expect(loadFileUsage('p1', now)).toEqual({ 'fresh.ts': { count: 1, lastAt: now - DAY } })
  })

  it('topFrequentCmdIds 同一比较器适用于文件路径键：热档新近优先', () => {
    const now = 10 * DAY
    recordFileUsage('p1', 'warm.ts', now - 3 * DAY)
    recordFileUsage('p1', 'hot.ts', now - HOUR)
    expect(topFrequentCmdIds(loadFileUsage('p1', now), 2, now)).toEqual(['hot.ts', 'warm.ts'])
  })
})
