import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// ── mock 边界：① vue-i18n（真 zh-CN 语言包插值，locale 改动即测出）
// ② uiStateApi（uiState 命名空间持久化通道；instance store 走真 pinia）──
const { uiGet, uiUpdate } = vi.hoisted(() => ({
  uiGet: vi.fn<() => Promise<{ data?: Record<string, unknown> }>>(),
  uiUpdate: vi.fn<(data: Record<string, unknown>) => Promise<unknown>>(),
}))

vi.mock('vue-i18n', async () => {
  const zh = (await import('../../locales/zh-CN')).default
  const get = (o: Record<string, unknown>, k: string): unknown =>
    k.split('.').reduce<unknown>((a, c) => (a as Record<string, unknown> | undefined)?.[c], o)
  return {
    useI18n: () => ({
      t: (key: string) => (get(zh, key) as string) ?? key,
    }),
  }
})

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>()
  return { ...actual, uiStateApi: { get: uiGet, update: uiUpdate } }
})

import { factoryTaskTemplates, useAgentTaskTemplates } from '../../composables/useAgentTaskTemplates'
import { FACTORY_TEMPLATE_IDS } from '../../utils/agentTaskTemplate'

describe('useAgentTaskTemplates', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    uiGet.mockReset()
    uiUpdate.mockReset()
    uiUpdate.mockResolvedValue(undefined)
    // 默认：uiState 无记录（未定制）
    uiGet.mockResolvedValue({ data: {} })
  })

  it('未定制时 load 出厂预置（4 条，id 稳定，不落盘）', async () => {
    const c = useAgentTaskTemplates()
    await c.load()
    expect(c.customized.value).toBe(false)
    expect(c.templates.value.map(x => x.id)).toEqual([...FACTORY_TEMPLATE_IDS])
    expect(c.templates.value.length).toBe(4)
    expect(c.templates.value[0]!.name.length).toBeGreaterThan(0)
    expect(c.templates.value[0]!.prompt.length).toBeGreaterThan(0)
    expect(uiUpdate).not.toHaveBeenCalled()
  })

  it('uiState 脏形状（非数组）按未定制处理回落预置', async () => {
    uiGet.mockResolvedValue({ data: { local: { agentTaskTemplates: { items: 'garbage' } } } })
    const c = useAgentTaskTemplates()
    await c.load()
    expect(c.customized.value).toBe(false)
    expect(c.templates.value.length).toBe(4)
  })

  it('改动未定制列表先物化（预置深拷贝落盘），新增追加尾部', async () => {
    const c = useAgentTaskTemplates()
    await c.load()
    await c.addTemplate('我的模板', '审查 {file}')
    expect(c.customized.value).toBe(true)
    expect(c.templates.value.length).toBe(5)
    expect(uiUpdate).toHaveBeenCalledTimes(1)
    const all = uiUpdate.mock.calls[0]![0] as Record<string, { agentTaskTemplates?: { items?: { name: string }[] } }>
    const items = all.local!.agentTaskTemplates!.items!
    // 物化 = 4 条预置 + 1 条新增，预置原文进入落盘数据
    expect(items.length).toBe(5)
    expect(items[4]!.name).toBe('我的模板')
    expect(items[4]!.prompt).toBe('审查 {file}')
  })

  it('已定制时 load 读回存储表（不再派生预置）；删光=空表定制不复活', async () => {
    uiGet.mockResolvedValue({ data: { local: { agentTaskTemplates: { items: [{ id: 'a', name: '甲', prompt: 'p1' }] } } } })
    const c = useAgentTaskTemplates()
    await c.load()
    expect(c.customized.value).toBe(true)
    expect(c.templates.value.map(x => x.id)).toEqual(['a'])
    await c.removeTemplate('a')
    expect(c.templates.value).toEqual([])
    const all = uiUpdate.mock.calls[0]![0] as Record<string, { agentTaskTemplates?: { items?: unknown[] } }>
    expect(all.local!.agentTaskTemplates!.items).toEqual([])
    // 重 load：存储为空数组（定制态）→ 空表而非预置复活
    const saved = { data: { local: { agentTaskTemplates: { items: [] } } } }
    uiGet.mockResolvedValue(saved)
    await c.load()
    expect(c.customized.value).toBe(true)
    expect(c.templates.value).toEqual([])
  })

  it('updateTemplate 原位更新；moveTemplate 相邻交换且越界 no-op', async () => {
    uiGet.mockResolvedValue({
      data: { local: { agentTaskTemplates: { items: [
        { id: 'a', name: '甲', prompt: 'p1' },
        { id: 'b', name: '乙', prompt: 'p2' },
      ] } } },
    })
    const c = useAgentTaskTemplates()
    await c.load()
    await c.updateTemplate('b', '乙二', 'p2v')
    expect(c.templates.value[1]).toEqual({ id: 'b', name: '乙二', prompt: 'p2v' })
    await c.moveTemplate('b', -1)
    expect(c.templates.value.map(x => x.id)).toEqual(['b', 'a'])
    await c.moveTemplate('b', -1) // 已在顶部，越界 no-op
    expect(c.templates.value.map(x => x.id)).toEqual(['b', 'a'])
  })

  it('乱序 load：慢响应不得覆盖新状态', async () => {
    let resolveSlow: (v: { data?: Record<string, unknown> }) => void = () => {}
    uiGet.mockImplementationOnce(() => new Promise(res => { resolveSlow = res }))
    const c = useAgentTaskTemplates()
    const p1 = c.load() // 慢（未决）
    await c.load() // 快（默认 mock：未定制 → 预置）
    resolveSlow({ data: { local: { agentTaskTemplates: { items: [{ id: 'x', name: '迟到的', prompt: '' }] } } } })
    await p1
    expect(c.customized.value).toBe(false)
    expect(c.templates.value.length).toBe(4)
  })

  it('validate 透传校验码', async () => {
    const c = useAgentTaskTemplates()
    await c.load()
    expect(c.validate('', 'x')).toBe('nameRequired')
    expect(c.validate('n', '审查 {file}')).toBe('')
  })

  it('importTemplates 整批一次落盘：creates 新铸 id 追加、updates 按 targetId 原位覆盖、目标消失跳过', async () => {
    uiGet.mockResolvedValue({
      data: { local: { agentTaskTemplates: { items: [
        { id: 'a', name: '甲', prompt: '旧甲' },
        { id: 'b', name: '乙', prompt: '旧乙' },
      ] } } },
    })
    const c = useAgentTaskTemplates()
    await c.load()
    await c.importTemplates(
      [{ name: '丙', prompt: '新丙' }],
      [
        { targetId: 'b', item: { name: '乙', prompt: '导入乙' } },
        { targetId: 'gone', item: { name: '幽灵', prompt: 'x' } }, // 预览后被删，静默跳过
      ],
    )
    // 整批只写一次 uiState（逐条 add/update 会 N 次全量写）
    expect(uiUpdate).toHaveBeenCalledTimes(1)
    expect(c.templates.value.map(x => x.name)).toEqual(['甲', '乙', '丙'])
    expect(c.templates.value[1]).toMatchObject({ id: 'b', name: '乙', prompt: '导入乙' })
    expect(c.templates.value[2]!.id).toMatch(/^tpl-/)
    const all = uiUpdate.mock.calls[0]![0] as Record<string, { agentTaskTemplates?: { items?: { name: string; prompt: string }[] } }>
    expect(all.local!.agentTaskTemplates!.items).toEqual([
      { id: 'a', name: '甲', prompt: '旧甲' },
      { id: 'b', name: '乙', prompt: '导入乙' },
      { id: c.templates.value[2]!.id, name: '丙', prompt: '新丙' },
    ])
  })

  it('importTemplates 空计划 no-op（不物化不落盘）', async () => {
    const c = useAgentTaskTemplates()
    await c.load()
    await c.importTemplates([], [])
    expect(uiUpdate).not.toHaveBeenCalled()
    expect(c.customized.value).toBe(false)
  })
})

describe('factoryTaskTemplates', () => {
  it('纯函数形态：t 注入即出 4 条预置（id 与常量表一致）', () => {
    const list = factoryTaskTemplates(k => k)
    expect(list.map(x => x.id)).toEqual([...FACTORY_TEMPLATE_IDS])
    expect(list[0]!.name).toBe('settings.agentTaskTemplates.factory.tpl-review.name')
  })
})
