import { describe, it, expect } from 'vitest'
import { groupSessionsByRuntime, runtimeFilterOptions, sessionMatchesRuntimeFilter, RUNTIME_FALLBACK_KEY } from './sessionRuntimeGroups'

// 会话中心按 runtime 分组投影（P-20261003-238）+ runtime 筛选芯片（P-20261004-84）
// 单测：归组键空值归 shell、内置智能体运行时固定组序在前 + shell 殿后、自定义
// 运行时按首现、组内保序；芯片候选 = 全量集合去重（组序同源）、命中判定空集
// 恒真 + 多选 OR + 空值归一。

const s = (id: string, runtime?: string) => ({ id, name: id, runtime })

describe('groupSessionsByRuntime', () => {
  it('空 runtime 归 shell 组（旧会话/项目会话形态）', () => {
    const groups = groupSessionsByRuntime([s('a'), s('b', 'shell'), s('c', '')])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.key).toBe('shell')
    expect(groups[0]!.sessions.map(x => x.id)).toEqual(['a', 'b', 'c'])
  })

  it('内置运行时固定组序在前、shell 殿后、自定义按首现居中', () => {
    const groups = groupSessionsByRuntime([
      s('a', 'dsh'),
      s('b', 'my-agent'),
      s('c', 'shell'),
      s('d', 'claude'),
      s('e', 'codex'),
      s('f', 'my-agent'),
    ])
    expect(groups.map(g => g.key)).toEqual(['claude', 'codex', 'dsh', 'my-agent', 'shell'])
    expect(groups.find(g => g.key === 'my-agent')!.sessions.map(x => x.id)).toEqual(['b', 'f'])
  })

  it('组内保持传入顺序（排序语义归宿主 sortMode，不二次排序）', () => {
    const groups = groupSessionsByRuntime([s('z', 'claude'), s('a', 'claude'), s('m', 'claude')])
    expect(groups[0]!.sessions.map(x => x.id)).toEqual(['z', 'a', 'm'])
  })

  it('无已知运行时时全部按首现归组、兜底键常量语义稳定', () => {
    const groups = groupSessionsByRuntime([s('a', 'custom-x')])
    expect(groups.map(g => g.key)).toEqual(['custom-x'])
    expect(RUNTIME_FALLBACK_KEY).toBe('shell')
    expect(groupSessionsByRuntime([])).toEqual([])
  })
})

// ============== runtime 筛选芯片（P-20261004-84） ==============
describe('runtimeFilterOptions / sessionMatchesRuntimeFilter', () => {
  it('候选 = 当前会话集合去重，序沿分组投影（内置在前/shell 殿后）', () => {
    expect(runtimeFilterOptions([
      s('a', 'shell'),
      s('b', 'codex'),
      s('c', 'claude'),
      s('d'), // 空 runtime 归 shell，不重复产芯片
      s('e', 'my-agent'),
    ])).toEqual(['claude', 'codex', 'my-agent', 'shell'])
    // 空集合无芯片（动态清单）
    expect(runtimeFilterOptions([])).toEqual([])
  })

  it('空选中集 = 不过滤恒真（含 undefined runtime 形态）', () => {
    const none = new Set<string>()
    expect(sessionMatchesRuntimeFilter('claude', none)).toBe(true)
    expect(sessionMatchesRuntimeFilter(undefined, none)).toBe(true)
  })

  it('多选 OR：命中任一选中 runtime 即真', () => {
    const sel = new Set(['claude', 'shell'])
    expect(sessionMatchesRuntimeFilter('claude', sel)).toBe(true)
    expect(sessionMatchesRuntimeFilter('shell', sel)).toBe(true)
    expect(sessionMatchesRuntimeFilter('codex', sel)).toBe(false)
  })

  it('空 runtime 归一 shell 参与命中（项目会话/旧会话不因缺字段被清出）', () => {
    const sel = new Set(['shell'])
    expect(sessionMatchesRuntimeFilter(undefined, sel)).toBe(true)
    expect(sessionMatchesRuntimeFilter('', sel)).toBe(true)
    expect(sessionMatchesRuntimeFilter('claude', sel)).toBe(false)
  })
})
