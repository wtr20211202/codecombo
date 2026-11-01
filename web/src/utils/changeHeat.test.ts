import { describe, expect, it } from 'vitest'
import { compareByVolumeDesc, heatLevel, nodeHeat } from './changeHeat'

// 改动量热力/排序纯函数（P-20261003-239）：档位口径与 P-37 活动热力图同式
//（峰值归一 ceil 分四档、零行不发光），断言盯分档边界与「宁缺毋谎」三形态
//（无数据/二进制/零行不渲染）

describe('heatLevel', () => {
  it('峰值归一 ceil 分四档（非零行至少 1 档）', () => {
    expect(heatLevel(200, 200)).toBe(4)
    expect(heatLevel(150, 200)).toBe(3)
    expect(heatLevel(80, 200)).toBe(2)
    expect(heatLevel(51, 200)).toBe(2)
    expect(heatLevel(1, 200)).toBe(1)
  })

  it('零行/零峰值/负数不发光；超峰值钳 4 档', () => {
    expect(heatLevel(0, 200)).toBe(0)
    expect(heatLevel(-1, 200)).toBe(0)
    expect(heatLevel(5, 0)).toBe(0)
    expect(heatLevel(500, 200)).toBe(4)
  })
})

describe('nodeHeat', () => {
  it('有行数量 → 带档位视图（原始增删保留供 tooltip）', () => {
    expect(nodeHeat({ additions: 3, deletions: 1 }, 4)).toEqual({ additions: 3, deletions: 1, level: 4 })
    expect(nodeHeat({ additions: 1, deletions: 0 }, 200)).toEqual({ additions: 1, deletions: 0, level: 1 })
  })

  it('numstat 未覆盖/二进制/零档 → undefined（不渲染，「宁缺毋谎」）', () => {
    expect(nodeHeat(undefined, 100)).toBeUndefined()
    expect(nodeHeat({ additions: 0, deletions: 0, binary: true }, 100)).toBeUndefined()
    expect(nodeHeat({ additions: 0, deletions: 0 }, 100)).toBeUndefined()
  })
})

describe('compareByVolumeDesc', () => {
  it('量降序在前，同量按名升序（确定性兜底）', () => {
    const n = (name: string, volume: number) => ({ name, isDir: false, volume })
    const arr = [n('b', 1), n('c', 5), n('a', 5), n('z', 9)]
    arr.sort(compareByVolumeDesc)
    expect(arr.map(x => x.name)).toEqual(['z', 'a', 'c', 'b'])
  })
})
