import { describe, it, expect } from 'vitest'
import { NESTED_UISTATE_SUBFIELDS, backfillNestedSubfields } from '@/stores/uiState'

// uiState 嵌套键子字段完备性守卫（P-20261006-24）：键级补丁协议是顶层命名空间
// 浅合并（服务端整键替换），「补丁携带父键缺子键」会剥掉基底子键——钉选重启
// 丢失 bug（e2e file-tree-pinned 实证）即该模式的 fileTree.pinnedDirs 单键案例，
// backfillNestedSubfields 把防线收口为全部注册键的通用机制。
//
// 对账分工：注册表以 satisfies 映射类型锚定 UIStateData（stores/uiState.ts 编译
// 期对账——新增嵌套键未入表 / 已知键新增子字段未补表 → npm run check 红）；
// 本文件运行时守卫机制本身，it.each 表驱动逐注册键出用例——新键入表即自动
// 获得同款模板。fileTree 全链路（store 级 auto-save/关页/重置）钉选语义见
// uiState-persistence.test.ts 的 fileTree.pinnedDirs 用例族（回归锚）。

const registryEntries: [string, Record<string, true>][] = Object.entries(NESTED_UISTATE_SUBFIELDS)

function subfieldsOf(ns: string): string[] {
  const entry = registryEntries.find(([k]) => k === ns)
  expect(entry, `注册表缺键 ${ns}`).toBeDefined()
  return Object.keys(entry![1])
}

describe('NESTED_UISTATE_SUBFIELDS 注册表健康（对账断言的运行时面）', () => {
  it('注册表非空，每条目子字段清单非空且无重复', () => {
    expect(registryEntries.length).toBeGreaterThan(0)
    for (const [ns, subfields] of registryEntries) {
      const names = Object.keys(subfields)
      expect(names.length, `${ns} 子字段清单为空`).toBeGreaterThan(0)
      expect(new Set(names).size, `${ns} 子字段重复`).toBe(names.length)
    }
  })
})

describe('backfillNestedSubfields 合并语义（每注册键一条，表驱动）', () => {
  it.each(registryEntries.map(([ns]) => ns))('%s：携带父键缺子键 → 基底子键回填；显式携带以补丁为准', (ns) => {
    const subfields = subfieldsOf(ns)
    const head = subfields[0]!
    // 基底：全部子字段在场（各不相同的哨兵值）
    const base = { [ns]: Object.fromEntries(subfields.map(sf => [sf, `base:${ns}.${sf}`])) }
    // 补丁：只携带第一个子字段且换成新值（其余子键全缺 = collect 面外形态）
    const rec = { [ns]: { [head]: `patch:${ns}.${head}` } }

    const out = backfillNestedSubfields(rec, base)
    // 缺席子键全部回填；显式携带的 head 以补丁新值为准不被基底覆盖
    expect(out[ns]).toEqual({ ...base[ns], [head]: `patch:${ns}.${head}` })
  })

  it.each(registryEntries.map(([ns]) => ns))('%s：基底缺子字段 → 不注水（undefined 不落盘）', (ns) => {
    const subfields = subfieldsOf(ns)
    const head = subfields[0]!
    const tail = subfields[subfields.length - 1]!
    // 基底只有尾部子字段，补丁只带头部子字段：中间子键两头都缺 → 不得注入
    const base = { [ns]: { [tail]: `base:${ns}.${tail}` } }
    const rec = { [ns]: { [head]: `patch:${ns}.${head}` } }

    const out = backfillNestedSubfields(rec, base)
    expect(out[ns]).toEqual({ ...base[ns], ...rec[ns] })
    expect(Object.keys(out[ns] as Record<string, unknown>).sort()).toEqual([...subfields.filter(sf => sf === head || sf === tail)].sort())
  })
})

describe('backfillNestedSubfields 边界口径（原 fileTree 单键特判语义保持）', () => {
  const base = { fileTree: { expandedDirs: ['src'], selectedFile: 'a.ts', pinnedDirs: { p1: ['docs'] } } }

  it('fileTree 全链路锚（原特判用例平移）：携带 fileTree 缺 pinnedDirs → 基底钉选回填', () => {
    const rec = { fileTree: { expandedDirs: ['src'], selectedFile: '' } }
    expect(backfillNestedSubfields(rec, base)).toEqual({
      fileTree: { expandedDirs: ['src'], selectedFile: '', pinnedDirs: { p1: ['docs'] } },
    })
  })

  it('显式携带子字段（含未注册新字段）原样保留不触碰', () => {
    const rec = { fileTree: { expandedDirs: [], selectedFile: '', futureField: 1 } }
    const out = backfillNestedSubfields(rec, base)
    expect(out).toEqual({ fileTree: { expandedDirs: [], selectedFile: '', futureField: 1, pinnedDirs: { p1: ['docs'] } } })
  })

  it('未注册命名空间（整表 Record）不回填：缺子键 = 有意删除，原样透传', () => {
    const rec = { snapshots: { p1: [] } }
    const out = backfillNestedSubfields(rec, { snapshots: { p1: [], p2: [{ id: 'keep' }] } })
    expect(out).toEqual(rec)
  })

  it('null 命名空间不回填（服务端 null 清键语义不被破坏）', () => {
    const rec = { fileTree: null }
    expect(backfillNestedSubfields(rec, base)).toEqual(rec)
  })

  it('数组/标量脏形状命名空间不回填', () => {
    expect(backfillNestedSubfields({ fileTree: ['x'] }, base)).toEqual({ fileTree: ['x'] })
    expect(backfillNestedSubfields({ fileTree: 'junk' }, base)).toEqual({ fileTree: 'junk' })
  })

  it('基底命名空间缺失/脏形状 → 无源可回，补丁原样透传', () => {
    const rec = { fileTree: { expandedDirs: [] } }
    expect(backfillNestedSubfields(rec, {})).toEqual(rec)
    expect(backfillNestedSubfields(rec, { fileTree: 'junk' })).toEqual(rec)
    expect(backfillNestedSubfields(rec, { fileTree: ['junk'] })).toEqual(rec)
  })

  it('无基底（boot GET 失败等）→ 补丁原样透传', () => {
    const rec = { fileTree: { expandedDirs: [] } }
    expect(backfillNestedSubfields(rec, undefined)).toEqual(rec)
  })

  it('多命名空间并存：只动携带的注册键，无回填时原引用透传（零拷贝路径）', () => {
    const rec = { layout: { sideView: 'files' }, agentTerminal: { groups: [] } }
    const fullBase = {
      ...base,
      layout: { sideView: 'git', sidePanelWidth: 280 },
      agentTerminal: { groups: [{ id: 'g1', name: 'n', sessionIds: [] }], sidebarCollapsed: true },
    }
    const out = backfillNestedSubfields(rec, fullBase)
    // layout 缺 sidePanelWidth → 回填；agentTerminal 的 groups 显式携带 → 不覆盖，
    // 缺席的 sidebarCollapsed → 基底回填（各子键独立判定）
    expect(out.layout).toEqual({ sideView: 'files', sidePanelWidth: 280 })
    expect(out.agentTerminal).toEqual({ groups: [], sidebarCollapsed: true })
  })
})
