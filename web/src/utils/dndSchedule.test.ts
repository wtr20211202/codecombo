import { describe, expect, it } from 'vitest'
import {
  isWithinDnd,
  isExcepted,
  lastEndedDndWindow,
  parseHm,
  DND_EXCEPTION_CATEGORIES,
  DND_EXCEPTION_DEFAULTS,
  type DndWindow,
} from './dndSchedule'

// 判定只看本地时分，日期分量任取（本地构造，无时区漂移）
const at = (h: number, m: number) => new Date(2026, 9, 3, h, m)

const win = (enabled: boolean, start: string, end: string): DndWindow => ({ enabled, start, end })

describe('parseHm', () => {
  it('HH:mm → 当日分钟数；非法输入返回 null', () => {
    expect(parseHm('00:00')).toBe(0)
    expect(parseHm('23:59')).toBe(23 * 60 + 59)
    expect(parseHm('9:30')).toBe(9 * 60 + 30) // 单数位小时容忍
    expect(parseHm('24:00')).toBeNull()
    expect(parseHm('12:60')).toBeNull()
    expect(parseHm('')).toBeNull()
    expect(parseHm('abc')).toBeNull()
    expect(parseHm('12:3')).toBeNull()
  })
})

describe('isWithinDnd 未启用/非法兜底', () => {
  it('未启用 → 任何时刻都不静默（即使落在窗口内）', () => {
    expect(isWithinDnd(win(false, '22:00', '08:00'), at(23, 0))).toBe(false)
    expect(isWithinDnd(win(false, '12:00', '13:00'), at(12, 30))).toBe(false)
  })

  it('起止非法 / start === end（零长窗口）→ 不静默（fail-open）', () => {
    expect(isWithinDnd(win(true, '', '08:00'), at(3, 0))).toBe(false)
    expect(isWithinDnd(win(true, '22:00', 'abc'), at(23, 0))).toBe(false)
    expect(isWithinDnd(win(true, '22:00', '22:00'), at(22, 0))).toBe(false)
  })
})

describe('isWithinDnd 同日窗口（[start, end) 半开）', () => {
  const w = win(true, '12:00', '13:00')
  it('边界与内部', () => {
    expect(isWithinDnd(w, at(11, 59))).toBe(false)
    expect(isWithinDnd(w, at(12, 0))).toBe(true)
    expect(isWithinDnd(w, at(12, 30))).toBe(true)
    expect(isWithinDnd(w, at(12, 59))).toBe(true)
    expect(isWithinDnd(w, at(13, 0))).toBe(false)
  })
})

describe('isWithinDnd 跨午夜窗口', () => {
  // 22:00 → 次日 08:00：22:00~23:59 与 00:00~07:59 静默，08:00 起放行
  const w = win(true, '22:00', '08:00')
  it('午夜前段', () => {
    expect(isWithinDnd(w, at(21, 59))).toBe(false)
    expect(isWithinDnd(w, at(22, 0))).toBe(true)
    expect(isWithinDnd(w, at(23, 30))).toBe(true)
    expect(isWithinDnd(w, at(23, 59))).toBe(true)
  })
  it('午夜后段', () => {
    expect(isWithinDnd(w, at(0, 0))).toBe(true)
    expect(isWithinDnd(w, at(3, 0))).toBe(true)
    expect(isWithinDnd(w, at(7, 59))).toBe(true)
    expect(isWithinDnd(w, at(8, 0))).toBe(false)
    expect(isWithinDnd(w, at(12, 0))).toBe(false)
  })
  it('结束在开始之前但同日可解释的窗口（如 08:00 → 06:00）同样跨午夜', () => {
    const odd = win(true, '08:00', '06:00')
    expect(isWithinDnd(odd, at(9, 0))).toBe(true)
    expect(isWithinDnd(odd, at(5, 59))).toBe(true)
    expect(isWithinDnd(odd, at(6, 0))).toBe(false)
    expect(isWithinDnd(odd, at(7, 59))).toBe(false)
  })
})

describe('lastEndedDndWindow（P-20261003-64 解除摘要行）', () => {
  it('未启用 / 起止非法 / 零长窗口 → null', () => {
    expect(lastEndedDndWindow(win(false, '22:00', '08:00'), at(12, 0))).toBeNull()
    expect(lastEndedDndWindow(win(true, '', '08:00'), at(12, 0))).toBeNull()
    expect(lastEndedDndWindow(win(true, '22:00', 'abc'), at(12, 0))).toBeNull()
    expect(lastEndedDndWindow(win(true, '22:00', '22:00'), at(12, 0))).toBeNull()
  })

  it('仍在窗口内（同日与跨午夜两形态）→ null（尚未解除）', () => {
    expect(lastEndedDndWindow(win(true, '12:00', '13:00'), at(12, 30))).toBeNull()
    expect(lastEndedDndWindow(win(true, '22:00', '08:00'), at(23, 30))).toBeNull()
    expect(lastEndedDndWindow(win(true, '22:00', '08:00'), at(3, 0))).toBeNull()
  })

  it('同日窗口结束后 → 今天 [start, end)', () => {
    const iv = lastEndedDndWindow(win(true, '12:00', '13:00'), at(14, 30))
    expect(iv).not.toBeNull()
    expect(iv!.startMs).toBe(at(12, 0).getTime())
    expect(iv!.endMs).toBe(at(13, 0).getTime())
  })

  it('同日窗口开始前 → 昨天那扇 [start, end)', () => {
    const iv = lastEndedDndWindow(win(true, '12:00', '13:00'), at(9, 0))
    expect(iv).not.toBeNull()
    expect(iv!.startMs).toBe(new Date(2026, 9, 2, 12, 0).getTime())
    expect(iv!.endMs).toBe(new Date(2026, 9, 2, 13, 0).getTime())
  })

  it('跨午夜窗口解除后 → 昨天 start → 今天 end', () => {
    const iv = lastEndedDndWindow(win(true, '22:00', '08:00'), at(12, 0))
    expect(iv).not.toBeNull()
    expect(iv!.startMs).toBe(new Date(2026, 9, 2, 22, 0).getTime())
    expect(iv!.endMs).toBe(at(8, 0).getTime())
    // 解除后紧邻边界（09:00）与晚些（14:30）都指向同一扇窗
    const soon = lastEndedDndWindow(win(true, '22:00', '08:00'), at(9, 0))
    expect(soon!.endMs).toBe(at(8, 0).getTime())
  })
})

describe('isExcepted 例外类别（P-20261003-115）', () => {
  it('命中例外表 → 穿透（true）', () => {
    expect(isExcepted({ ...win(true, '22:00', '08:00'), except: ['approval'] }, 'approval')).toBe(true)
    expect(isExcepted({ ...win(true, '22:00', '08:00'), except: ['task', 'error'] }, 'task')).toBe(true)
  })

  it('未命中 → false（时段内照旧静默）', () => {
    expect(isExcepted({ ...win(true, '22:00', '08:00'), except: ['approval'] }, 'task')).toBe(false)
    expect(isExcepted({ ...win(true, '22:00', '08:00'), except: [] }, 'approval')).toBe(false)
  })

  it('except 缺失/非数组（旧落盘数据）→ 无例外', () => {
    expect(isExcepted(win(true, '22:00', '08:00'), 'approval')).toBe(false)
    expect(isExcepted({ ...win(true, '22:00', '08:00'), except: 'approval' as unknown as string[] }, 'approval')).toBe(false)
  })

  it('查询值不在类别全集 → 一律 false（ask 等未纳管类别不参与例外）', () => {
    expect(isExcepted({ ...win(true, '22:00', '08:00'), except: ['ask'] }, 'ask')).toBe(false)
  })

  it('全集含通知中心类别（含 drop）+ approval；默认表只含 approval', () => {
    // P-20261006-51 起全集纳入 drop：快投递是用户自己刚投出的内容，可选穿透
    expect([...DND_EXCEPTION_CATEGORIES].sort()).toEqual(['approval', 'clone', 'drop', 'error', 'git', 'system', 'task'])
    expect(DND_EXCEPTION_DEFAULTS).toEqual(['approval'])
  })
})
