import { describe, it, expect } from 'vitest'
import {
  buildAgentExportPayload, sanitizeAgentImport, planAgentImport, applyAgentImportPlan,
  SC_CUSTOM_AGENTS_VERSION,
} from './customAgentTransfer'
import type { CustomAgent } from '../api/domains/system'

// 导出/导入传播件纯函数族（P-20261004-83）：导出白名单、导入清洗防御、
// 冲突计划与策略分流——服务端 validateCustomAgent 是最终事实源，这里守
// 前端预检口径。

describe('buildAgentExportPayload — 导出载荷构造', () => {
  it('字段白名单深拷贝：未知/私有字段不外带', () => {
    const agents = [
      { name: 'gemini', displayName: 'Gemini CLI', command: 'gemini --yolo', sneaky: 'x' },
      { name: 'aider', command: 'aider' },
    ] as unknown as CustomAgent[]
    const payload = buildAgentExportPayload(agents)
    expect(payload.scCustomAgents).toBe(SC_CUSTOM_AGENTS_VERSION)
    expect(payload.version).toBe(SC_CUSTOM_AGENTS_VERSION)
    expect(payload.exportedAt).toBeTruthy()
    expect(payload.agents).toEqual([
      { name: 'gemini', displayName: 'Gemini CLI', command: 'gemini --yolo' },
      { name: 'aider', displayName: undefined, command: 'aider' },
    ])
    // 深拷贝：改导出不回写来源
    payload.agents[0]!.command = 'mutated'
    expect(agents[0]!.command).toBe('gemini --yolo')
  })
})

describe('sanitizeAgentImport — 导入清洗', () => {
  it('带 scCustomAgents 标记的包裹格式', () => {
    const r = sanitizeAgentImport({
      scCustomAgents: 1, version: 1, exportedAt: '2026-10-09T00:00:00Z',
      agents: [{ name: 'gemini', command: 'gemini --yolo' }],
    })
    expect(r).not.toBeNull()
    expect(r!.agents).toEqual([{ name: 'gemini', displayName: undefined, command: 'gemini --yolo' }])
    expect(r!.invalid).toBe(0)
  })

  it('裸数组容错（手写/他工具导出）', () => {
    const r = sanitizeAgentImport([{ name: 'aider', command: 'aider' }])
    expect(r!.agents).toHaveLength(1)
    expect(r!.invalid).toBe(0)
  })

  it('整体形状不符返回 null（供「格式无效」提示）', () => {
    expect(sanitizeAgentImport(null)).toBeNull()
    expect(sanitizeAgentImport('str')).toBeNull()
    expect(sanitizeAgentImport({ agents: [] })).toBeNull() // 无标记包裹
    expect(sanitizeAgentImport({ scCustomAgents: 1, agents: 'not-array' })).toBeNull()
  })

  it('非法条目逐条丢弃计数，不阻塞其余条目', () => {
    const r = sanitizeAgentImport([
      { name: 'ok-agent', command: 'ok' },
      { name: 'Bad Name', command: 'x' }, // name 形态不符
      { name: 'no-cmd', command: '' }, // 命令空
      { name: 'long-cmd', command: 'x'.repeat(201) }, // 命令超 200
      { name: 'long-dn', displayName: 'x'.repeat(61), command: 'x' }, // 显示名超 60
      'not-an-object',
      null,
    ])
    expect(r!.agents).toEqual([{ name: 'ok-agent', displayName: undefined, command: 'ok' }])
    expect(r!.invalid).toBe(6)
  })

  it('同名重复保留首个，后续计为非法', () => {
    const r = sanitizeAgentImport([
      { name: 'dup', command: 'first' },
      { name: 'dup', command: 'second' },
    ])
    expect(r!.agents).toEqual([{ name: 'dup', displayName: undefined, command: 'first' }])
    expect(r!.invalid).toBe(1)
  })

  it('防御式清洗：displayName 空白归一缺省、未知字段剥除、首尾空白裁剪', () => {
    const r = sanitizeAgentImport([{
      name: ' gemini ', displayName: '  ', command: ' gemini --yolo ', extra: true,
    }])
    expect(r!.agents).toEqual([{ name: 'gemini', displayName: undefined, command: 'gemini --yolo' }])
  })
})

describe('planAgentImport — 冲突计划', () => {
  const existing: CustomAgent[] = [{ name: 'gemini', displayName: 'Old', command: 'old-cmd' }]

  it('同名标注 conflict 并携本地现值，新条目不标注', () => {
    const entries = planAgentImport(
      [
        { name: 'gemini', command: 'new-cmd' },
        { name: 'fresh', command: 'f' },
      ],
      existing,
    )
    expect(entries).toHaveLength(2)
    expect(entries[0]).toEqual({
      agent: { name: 'gemini', displayName: undefined, command: 'new-cmd' },
      conflict: true,
      existing: { name: 'gemini', displayName: 'Old', command: 'old-cmd' },
    })
    expect(entries[1]).toEqual({ agent: { name: 'fresh', displayName: undefined, command: 'f' }, conflict: false })
  })
})

describe('applyAgentImportPlan — 策略分流', () => {
  const entries = planAgentImport(
    [
      { name: 'new-a', command: 'a' },
      { name: 'new-b', command: 'b' },
      { name: 'hit', command: 'h' },
    ],
    [{ name: 'hit', command: 'old' }],
  )

  it('skip 策略：冲突条目进 skipped，其余进 creates', () => {
    const p = applyAgentImportPlan(entries, 'skip')
    expect(p.creates.map(a => a.name)).toEqual(['new-a', 'new-b'])
    expect(p.updates).toEqual([])
    expect(p.skipped.map(a => a.name)).toEqual(['hit'])
  })

  it('overwrite 策略：冲突条目进 updates（PUT 同名整条覆盖），其余仍 creates', () => {
    const p = applyAgentImportPlan(entries, 'overwrite')
    expect(p.creates.map(a => a.name)).toEqual(['new-a', 'new-b'])
    expect(p.updates.map(a => a.name)).toEqual(['hit'])
    expect(p.skipped).toEqual([])
  })
})
