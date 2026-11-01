import { describe, expect, it } from 'vitest'
import {
  SC_AGENT_TEMPLATES_VERSION,
  buildTemplateExportPayload, parseTemplateImport, planTemplateImport,
  applyTemplateImport, sensitiveTemplateNames,
} from './agentTaskTemplateTransfer'
import type { AgentTaskTemplate } from './agentTaskTemplate'

const tpl = (id: string, name: string, prompt: string): AgentTaskTemplate => ({ id, name, prompt })

describe('buildTemplateExportPayload', () => {
  it('字段白名单：只带 name/prompt，id 等本地字段不外带；家族标记与版本齐全', () => {
    const payload = buildTemplateExportPayload([tpl('tpl-review', '审查', '请审查 {file}'), tpl('x-1', '我的', '跑测试')])
    expect(payload.scAgentTaskTemplates).toBe(SC_AGENT_TEMPLATES_VERSION)
    expect(payload.version).toBe(SC_AGENT_TEMPLATES_VERSION)
    expect(typeof payload.exportedAt).toBe('string')
    expect(payload.templates).toEqual([
      { name: '审查', prompt: '请审查 {file}' },
      { name: '我的', prompt: '跑测试' },
    ])
  })

  it('空列表出空 templates 载荷（空态由调用方提示）', () => {
    expect(buildTemplateExportPayload([]).templates).toEqual([])
  })
})

describe('parseTemplateImport', () => {
  it('标记包裹格式：合法条目收 name/prompt，未知字段剥除', () => {
    const r = parseTemplateImport({
      scAgentTaskTemplates: 1,
      version: 1,
      exportedAt: '2026-10-15T00:00:00Z',
      templates: [{ name: ' 甲 ', prompt: ' 审查 {branch} ', extra: 'x' }],
    })
    expect(r).toEqual({ templates: [{ name: '甲', prompt: '审查 {branch}' }], invalid: 0 })
  })

  it('裸数组容错（手写/他工具导出）', () => {
    const r = parseTemplateImport([{ name: 'a', prompt: 'p' }])
    expect(r?.templates).toEqual([{ name: 'a', prompt: 'p' }])
  })

  it('整体形状不符返回 null：非对象/缺标记/模板非数组', () => {
    expect(parseTemplateImport(null)).toBeNull()
    expect(parseTemplateImport('x')).toBeNull()
    expect(parseTemplateImport({ version: 1 })).toBeNull()
    expect(parseTemplateImport({ scAgentTaskTemplates: 1, templates: 'nope' })).toBeNull()
  })

  it('逐条校验同保存预检口径：空名/超长名/空正文/超 500 字节正文计 invalid 不阻塞其余', () => {
    const r = parseTemplateImport([
      { name: '', prompt: 'p' },
      { name: 'x'.repeat(61), prompt: 'p' },
      { name: 'ok', prompt: '' },
      { name: 'big', prompt: 'y'.repeat(501) },
      { name: 'good', prompt: 'p' },
      'garbage',
    ])
    expect(r?.templates).toEqual([{ name: 'good', prompt: 'p' }])
    expect(r?.invalid).toBe(5)
  })

  it('文件内同名重复保留首个，后续计 invalid', () => {
    const r = parseTemplateImport([{ name: 'a', prompt: 'p1' }, { name: 'a', prompt: 'p2' }])
    expect(r?.templates).toEqual([{ name: 'a', prompt: 'p1' }])
    expect(r?.invalid).toBe(1)
  })
})

describe('planTemplateImport / applyTemplateImport', () => {
  const local = [tpl('id-a', '甲', '本地甲'), tpl('id-b', '乙', '本地乙')]

  it('同名标 conflict 并挂首个同名本地项；非冲突无 existing', () => {
    const entries = planTemplateImport([{ name: '甲', prompt: '新甲' }, { name: '丙', prompt: '新丙' }], local)
    expect(entries[0]).toEqual({ item: { name: '甲', prompt: '新甲' }, conflict: true, existing: local[0] })
    expect(entries[1]).toEqual({ item: { name: '丙', prompt: '新丙' }, conflict: false })
  })

  it('本地重名取首个为覆盖目标（存储以 id 为主键，重名是既有合法形态）', () => {
    const entries = planTemplateImport([{ name: '甲', prompt: '新' }], [tpl('first', '甲', '一'), tpl('second', '甲', '二')])
    expect(entries[0]?.existing?.id).toBe('first')
  })

  it('展开：非冲突入 creates；冲突按勾选分流覆盖（带目标 id）/跳过（默认不勾）', () => {
    const entries = planTemplateImport(
      [{ name: '甲', prompt: '新甲' }, { name: '乙', prompt: '新乙' }, { name: '丙', prompt: '新丙' }],
      local,
    )
    const plan = applyTemplateImport(entries, new Set(['乙']))
    expect(plan.creates).toEqual([{ name: '丙', prompt: '新丙' }])
    expect(plan.updates).toEqual([{ targetId: 'id-b', item: { name: '乙', prompt: '新乙' } }])
    expect(plan.skipped).toEqual([{ name: '甲', prompt: '新甲' }])
  })
})

describe('sensitiveTemplateNames', () => {
  it('maskSensitive 差分判定：password 赋值/sc 令牌/AWS 密钥命中，普通正文不误报', () => {
    const hits = sensitiveTemplateNames([
      tpl('a', '部署', "curl -H 'Authorization: Bearer x' && password=hunter2 方式部署"),
      tpl('b', '令牌', '用 sca_abc123 调用 API'),
      tpl('c', '密钥', 'AKIAIOSFODNN7EXAMPLE'),
      tpl('d', '干净', '请审查当前工作区的未提交改动 {file}'),
    ])
    expect(hits).toEqual(['部署', '令牌', '密钥'])
  })
})
