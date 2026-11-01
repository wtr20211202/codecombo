import { describe, expect, it } from 'vitest'
import { parsePinnedIds, pinnedFirstOrder } from './terminalTabPins'

// 终端会话 tab 置顶（P-20261004-53）纯函数：持久化形态防御 + 置顶分组显示序
describe('parsePinnedIds', () => {
  it('空入参/空串回落空集', () => {
    expect(parsePinnedIds(null).size).toBe(0)
    expect(parsePinnedIds(undefined).size).toBe(0)
    expect(parsePinnedIds('').size).toBe(0)
  })

  it('合法 JSON 字符串数组恢复为集合并去重', () => {
    expect(parsePinnedIds('["a","b","a"]')).toEqual(new Set(['a', 'b']))
  })

  it('非数组/非 JSON/含非字符串项整体丢弃（损坏回落空集不抛错）', () => {
    expect(parsePinnedIds('not-json').size).toBe(0)
    expect(parsePinnedIds('{"a":1}').size).toBe(0)
    const mixed = parsePinnedIds('[1,"a",true]')
    expect(mixed.size).toBe(1)
    expect(mixed.has('a')).toBe(true)
  })
})

describe('pinnedFirstOrder', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]

  it('空置顶集返回原序拷贝', () => {
    const out = pinnedFirstOrder(list, new Set())
    expect(out.map(t => t.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(out).not.toBe(list)
  })

  it('置顶稳定 partition 到队首：组内与组外各保持原相对序', () => {
    expect(pinnedFirstOrder(list, new Set(['c', 'a'])).map(t => t.id)).toEqual(['a', 'c', 'b', 'd'])
  })

  it('置顶 id 不在清单内时零影响', () => {
    expect(pinnedFirstOrder(list, new Set(['ghost'])).map(t => t.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('全部置顶 = 原序', () => {
    expect(pinnedFirstOrder(list, new Set(['a', 'b', 'c', 'd'])).map(t => t.id)).toEqual(['a', 'b', 'c', 'd'])
  })
})
