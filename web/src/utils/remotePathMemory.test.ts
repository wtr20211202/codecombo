import { describe, it, expect } from 'vitest'
import {
  MAX_RECENT_PATHS, MAX_PINNED_PATHS,
  isRootPath, upsertRecentPath, pinFromHistory, unpinToHistory, pathAlias, parsePathMem,
} from './remotePathMemory'

describe('isRootPath', () => {
  it('POSIX 根与盘符根不入史', () => {
    expect(isRootPath('/')).toBe(true)
    expect(isRootPath('C:/')).toBe(true)
  })
  it('非根路径入史', () => {
    expect(isRootPath('/var/www')).toBe(false)
    expect(isRootPath('C:/Users/x')).toBe(false)
  })
})

describe('upsertRecentPath', () => {
  it('新路径置顶', () => {
    expect(upsertRecentPath(['/a', '/b'], '/c')).toEqual(['/c', '/a', '/b'])
  })
  it('重复访问移到最前且不重复（LRU）', () => {
    expect(upsertRecentPath(['/a', '/b', '/c'], '/b')).toEqual(['/b', '/a', '/c'])
  })
  it(`超过上限 ${MAX_RECENT_PATHS} FIFO 淘汰最旧`, () => {
    const full = Array.from({ length: MAX_RECENT_PATHS }, (_, i) => `/d${i}`) // 新→旧：d0 最新
    const next = upsertRecentPath(full, '/new')
    expect(next).toHaveLength(MAX_RECENT_PATHS)
    expect(next[0]).toBe('/new')
    expect(next).toContain('/d8') // 尾部最旧 /d9 被淘汰
    expect(next).not.toContain('/d9')
  })
})

describe('pinFromHistory / unpinToHistory', () => {
  it('pin 置顶且从最近表摘除（双区不重复）', () => {
    const m = pinFromHistory(['/p1'], ['/x', '/p2', '/y'], '/p2')
    expect(m.pins).toEqual(['/p2', '/p1'])
    expect(m.recent).toEqual(['/x', '/y'])
  })
  it(`pin 超上限 ${MAX_PINNED_PATHS} FIFO 淘汰最旧 pin`, () => {
    const pins = Array.from({ length: MAX_PINNED_PATHS }, (_, i) => `/pin${i}`)
    const m = pinFromHistory(pins, ['/z'], '/new')
    expect(m.pins).toHaveLength(MAX_PINNED_PATHS)
    expect(m.pins[0]).toBe('/new')
    expect(m.pins).not.toContain('/pin4')
  })
  it('unpin 回到最近区置顶（不丢路径）', () => {
    const m = unpinToHistory(['/p1', '/p2'], ['/x'], '/p1')
    expect(m.pins).toEqual(['/p2'])
    expect(m.recent).toEqual(['/p1', '/x'])
  })
})

describe('pathAlias', () => {
  it('深层目录取末两段', () => {
    expect(pathAlias('/var/www/app/logs')).toBe('app/logs')
  })
  it('两段目录原样', () => {
    expect(pathAlias('/var/www')).toBe('var/www')
  })
  it('单段目录就是自身；根原样', () => {
    expect(pathAlias('/docs')).toBe('docs')
    expect(pathAlias('/')).toBe('/')
  })
})

describe('parsePathMem', () => {
  it('null/空串 → 空历史', () => {
    expect(parsePathMem(null)).toEqual({ recent: [], pins: [] })
    expect(parsePathMem('')).toEqual({ recent: [], pins: [] })
  })
  it('合法 JSON 正常解析', () => {
    expect(parsePathMem('{"recent":["/a","/b"],"pins":["/p"]}'))
      .toEqual({ recent: ['/a', '/b'], pins: ['/p'] })
  })
  it('脏数据（非 JSON/非对象/非字符串项）逐条滤除不抛错', () => {
    expect(parsePathMem('not-json')).toEqual({ recent: [], pins: [] })
    expect(parsePathMem('["/a"]')).toEqual({ recent: [], pins: [] })
    expect(parsePathMem('{"recent":["/a", 3, null, " ", "/b"],"pins":"x"}'))
      .toEqual({ recent: ['/a', '/b'], pins: [] })
  })
})
