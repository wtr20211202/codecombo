import { describe, it, expect } from 'vitest'
import {
  MAX_HANDLED_PER_PROJECT,
  MAX_HANDLED_PROJECTS,
  handledKeyOf,
  markHandled,
  unmarkHandled,
  parseHandledRecord,
  serializeHandledRecord,
} from './todoHandled'

describe('handledKeyOf', () => {
  it('path:line 键（不带 column——漂移容忍粒度）', () => {
    expect(handledKeyOf('src/a.ts', 12)).toBe('src/a.ts:12')
  })
})

describe('markHandled / unmarkHandled', () => {
  it('新键置尾，去重不重复', () => {
    expect(markHandled(['a:1', 'b:2'], 'c:3')).toEqual(['a:1', 'b:2', 'c:3'])
    expect(markHandled(['a:1', 'b:2'], 'a:1')).toEqual(['b:2', 'a:1'])
  })

  it(`超过上限 ${MAX_HANDLED_PER_PROJECT} FIFO 淘汰最旧（头部）`, () => {
    const full = Array.from({ length: MAX_HANDLED_PER_PROJECT }, (_, i) => `f${i}:1`)
    const next = markHandled(full, 'new:1')
    expect(next).toHaveLength(MAX_HANDLED_PER_PROJECT)
    expect(next[next.length - 1]).toBe('new:1')
    expect(next).not.toContain('f0:1') // 头部最旧被淘汰
    expect(next).toContain('f1:1')
  })

  it('unmarkHandled 只删目标', () => {
    expect(unmarkHandled(['a:1', 'b:2'], 'a:1')).toEqual(['b:2'])
    expect(unmarkHandled(['a:1'], 'x:9')).toEqual(['a:1'])
  })
})

describe('parseHandledRecord / serializeHandledRecord', () => {
  it('null/坏 JSON/非对象 → 默认记录', () => {
    for (const raw of [null, '', 'not-json', '["array"]', '42']) {
      const rec = parseHandledRecord(raw)
      expect(rec.showHandled).toBe(false)
      expect(rec.byProject).toEqual({})
    }
  })

  it('roundtrip：开关与项目映射保真', () => {
    const rec = { showHandled: true, byProject: { p1: ['a.ts:3', 'b.go:9'] } }
    expect(parseHandledRecord(serializeHandledRecord(rec))).toEqual(rec)
  })

  it('防御：非数组列表/非字符串键/空串键丢弃，空列表项目剔除', () => {
    const raw = JSON.stringify({
      showHandled: 'yes',
      byProject: {
        p1: ['a.ts:1', 42, null, '', 'a.ts:1'], // 非字符串与空串丢弃，重复去重
        p2: 'nope', // 非数组整体丢弃
        p3: [], // 空列表剔除
      },
    })
    const rec = parseHandledRecord(raw)
    expect(rec.showHandled).toBe(false) // 非 true 一律按关
    expect(rec.byProject).toEqual({ p1: ['a.ts:1'] })
  })

  it('单项目列表截到上限（保最新）', () => {
    const keys = Array.from({ length: MAX_HANDLED_PER_PROJECT + 10 }, (_, i) => `f${i}:1`)
    const rec = parseHandledRecord(JSON.stringify({ byProject: { p1: keys } }))
    expect(rec.byProject.p1).toHaveLength(MAX_HANDLED_PER_PROJECT)
    expect(rec.byProject.p1![0]).toBe('f10:1') // 头部最旧被截
  })

  it(`项目映射数封顶 ${MAX_HANDLED_PROJECTS}`, () => {
    const byProject: Record<string, string[]> = {}
    for (let i = 0; i < MAX_HANDLED_PROJECTS + 5; i++) byProject[`p${i}`] = ['a.ts:1']
    const rec = parseHandledRecord(JSON.stringify({ byProject }))
    expect(Object.keys(rec.byProject)).toHaveLength(MAX_HANDLED_PROJECTS)
  })
})
