import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPinia, setActivePinia } from 'pinia'
import registryJson from '../../persistence/uiStateLanes.json'
import { useUIStateStore } from '../../stores/uiState'
import * as lanesLib from '../../../scripts/uistate-lanes-lib.mjs'

/**
 * UI 状态保持登记一致性单测（P-20261114-2-S2，doc-paths「文档=代码」同款思路）：
 * 矩阵文档（docs/PERSISTENCE_LANES.md「UI 状态保持矩阵」）与代码级注册表
 * （src/persistence/uiStateLanes.json）逐行逐格对账——不一致即红。与
 * check:uistate-lanes 门禁（生产面三提取 × 注册表）互补：门禁钉「代码事实源 ↔
 * 注册表」，本套件钉「注册表 ↔ 矩阵文档 / store 读写器族 / 豁免清单链接面」。
 *
 * 提取逻辑与门禁共用 scripts/uistate-lanes-lib.mjs（单一实现防漂移）。
 */

// web/src/__tests__/persistence/ → 仓库根（本套件读 docs/ 与 scripts/ 的跨树事实源）
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const MATRIX_DOC = path.join(REPO_ROOT, 'docs', 'PERSISTENCE_LANES.md')

const registry = registryJson as unknown as {
  rows: Array<Record<string, string | string[] | undefined>>
  legacyScKeys: Array<{ pattern: string; registryId: string; reason: string }>
  falseHits: Array<{ pattern: string; reason: string }>
}
const rows = registry.rows as Array<Record<string, any>>

const norm = (s: unknown) => String(s ?? '').trim()

/** 解析矩阵文档三张表的行：返回 id → 十格单元格（登记号/状态项/车道/刷新/路由往返/多标签/换浏览器/换机器/清除语义/备注）。
 *  只扫「UI 状态保持矩阵」节内（同文档其他表的 \`xxx\` 起手行不入面） */
function parseMatrixRows(doc: string): Map<string, string[]> {
  const start = doc.indexOf('## UI 状态保持矩阵（P-20261114-2-S2）')
  const end = doc.indexOf('\n## ', start + 10)
  const scope = start < 0 ? '' : doc.slice(start, end < 0 ? doc.length : end)
  const out = new Map<string, string[]>()
  for (const line of scope.split('\n')) {
    if (!/^\| `[^`]+` \|/.test(line)) continue
    const cells = line.split('|').slice(1, -1).map((c) => norm(c))
    const id = cells[0]?.replace(/^`|`$/g, '')
    if (id) out.set(id, cells)
  }
  return out
}

describe('uiStateLanes 注册表结构', () => {
  it('id 唯一且车道合法', () => {
    const ids = rows.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const r of rows) expect(lanesLib.LANES).toContain(r.lane)
  })

  it('矩阵列字段全部非空（refresh/routeTrip/multiTab/crossBrowser/crossMachine/clear）', () => {
    for (const r of rows) {
      for (const f of ['refresh', 'routeTrip', 'multiTab', 'crossBrowser', 'crossMachine', 'clear']) {
        expect(norm(r[f]), `${r.id}.${f}`).not.toBe('')
      }
    }
  })

  it('face 字段与车道耦合：collectNs 仅 collect；temporary/retired 不携带 face；keys 仅 localStorage', () => {
    for (const r of rows) {
      if (r.collectNs) expect(r.lane, r.id).toBe('collect')
      if (r.lane === 'temporary' || r.lane === 'retired') {
        expect(r.collectNs, r.id).toBeUndefined()
        expect(r.writerNs, r.id).toBeUndefined()
        expect(r.keys, r.id).toBeUndefined()
      }
      if (r.keys?.length) expect(r.lane, r.id).toBe('localStorage')
    }
  })

  it('数量下限（防注册表面残缺失明，MIN_GUARDS 同步门禁）', () => {
    expect(rows.length).toBeGreaterThanOrEqual(lanesLib.MIN_GUARDS.registryRows)
    expect(registry.legacyScKeys.length).toBeGreaterThanOrEqual(lanesLib.MIN_GUARDS.legacyKeys)
  })
})

describe('矩阵文档 ↔ 注册表（文档行=注册表行，doc-paths 同款思路）', () => {
  const doc = fs.readFileSync(MATRIX_DOC, 'utf8')
  const docRows = parseMatrixRows(doc)

  it('注册表每一行在矩阵文档中有对应行（id 集合对账）', () => {
    const missing = rows.filter((r) => !docRows.has(r.id)).map((r) => r.id)
    expect(missing, '注册表行缺失于矩阵文档').toEqual([])
  })

  it('矩阵文档每一行在注册表中有对应行（反向对账，防文档幽灵行）', () => {
    const regIds = new Set(rows.map((r) => r.id))
    const ghost = [...docRows.keys()].filter((id) => !regIds.has(id))
    expect(ghost, '矩阵文档幽灵行（注册表无此登记号）').toEqual([])
  })

  it('逐格一致：状态项/车道/刷新/路由往返/多标签/换浏览器/换机器/清除语义/备注', () => {
    // 单元格列序：0 登记号 | 1 状态项 | 2 车道 | 3 刷新 | 4 路由往返 | 5 多标签
    // | 6 换浏览器 | 7 换机器 | 8 清除语义 | 9 备注
    const fieldByCol = ['item', 'lane', 'refresh', 'routeTrip', 'multiTab', 'crossBrowser', 'crossMachine', 'clear']
    for (const r of rows) {
      const cells = docRows.get(r.id)!
      fieldByCol.forEach((field, idx) => {
        expect(norm(cells[idx + 1]), `${r.id}.${field}`).toBe(norm(r[field]))
      })
      const note = norm(r.note)
      expect(norm(cells[9]), `${r.id}.note`).toBe(note === '' ? '—' : note)
    }
  })

  it('矩阵节在文档目录中有锚点链接（TOC 同步）', () => {
    expect(doc).toContain('## UI 状态保持矩阵（P-20261114-2-S2）')
    expect(doc).toContain('[UI 状态保持矩阵（P-20261114-2-S2）](#ui-状态保持矩阵p-20261114-2-s2)')
  })
})

describe('store 专用读写器族 ↔ 注册表（writerFn/readerFn 双向集合对账）', () => {
  // collect 机制函数（非 per-namespace 专用读写器）：auto-save/beforeunload/基线对齐/
  // 通用读取器。resetLayoutState 不以 save/get 前缀暴露，由 layout 行 writerNs 门禁钉。
  const MACHINERY = new Set(['saveCurrentState', 'forceSaveCurrentState', 'alignBaseline', 'loadState', 'getInstanceState'])

  function storeFunctionNames(): string[] {
    setActivePinia(createPinia())
    const store = useUIStateStore()
    return Object.keys(store).filter((k) => /^save|^get/.test(k) && !MACHINERY.has(k))
  }

  it('注册表每个 writerFn/readerFn 都存在于 store 返回面', () => {
    const storeFns = new Set(storeFunctionNames())
    const listed = rows.flatMap((r) => [...(r.writerFn || []), ...(r.readerFn || [])])
    const missing = listed.filter((fn) => !storeFns.has(fn))
    expect(missing, '注册表列出的读写器在 store 缺席').toEqual([])
  })

  it('store 每个 saveXxx/getXxx 都被某登记行收编（防未登记读写器）', () => {
    const listed = new Set(rows.flatMap((r) => [...(r.writerFn || []), ...(r.readerFn || [])]))
    const unregistered = storeFunctionNames().filter((fn) => !listed.has(fn))
    expect(unregistered, 'store 读写器未被任何登记行收编').toEqual([])
  })
})

describe('存量豁免清单 ↔ 注册表（链接面 + 防悬空形态）', () => {
  it('每个 legacyScKeys 条目的 registryId 解析到登记行', () => {
    const ids = new Set(rows.map((r) => r.id))
    for (const e of registry.legacyScKeys) {
      expect(ids.has(e.registryId), `legacyScKeys ${e.pattern} → ${e.registryId}`).toBe(true)
      expect(e.reason.trim(), `legacyScKeys ${e.pattern} 缘由`).not.toBe('')
    }
  })

  it('每个 lane=localStorage 登记行都被豁免基线收编或自带 keys 登记键面', () => {
    const linked = new Set(registry.legacyScKeys.map((e) => e.registryId))
    for (const r of rows) {
      if (r.lane !== 'localStorage') continue
      expect(linked.has(r.id) || (r.keys?.length ?? 0) > 0, `localStorage 行 ${r.id} 既无豁免链接也无 keys 登记`).toBe(true)
    }
  })

  it('falseHits 条目缘由非空且 pattern 为 sc.* 形态', () => {
    for (const f of registry.falseHits) {
      expect(f.reason.trim()).not.toBe('')
      expect(f.pattern).toMatch(/^sc\./)
    }
  })
})

describe('门禁对账等价（生产面 live 复算，豁免防悬空在单测侧再守一道）', () => {
  it('reconcile 对真实 web/src 生产面零 ERROR（与 check:uistate-lanes 同逻辑）', () => {
    const srcRoot = path.join(REPO_ROOT, 'web', 'src')
    const files = (lanesLib.listSourceFiles as (root: string) => Array<{ name: string; abs: string }>)(srcRoot).map((f) => ({
      name: f.name,
      src: fs.readFileSync(f.abs, 'utf-8'),
    }))
    const literals = (lanesLib.scanScKeyLiterals as (files: Array<{ name: string; src: string }>) => Array<{ literal: string }>)(files)
    const writerFace = (lanesLib.extractPatchNamespacesNamespaces as (src: string) => string[])(fs.readFileSync(path.join(REPO_ROOT, 'web', 'src', 'stores', 'uiState.ts'), 'utf-8'))
    const collectFace = (lanesLib.extractCollectNamespaces as (src: string) => string[])(fs.readFileSync(path.join(REPO_ROOT, 'web', 'src', 'composables', 'useLayoutState.ts'), 'utf-8'))
    const { errors, stats } = (lanesLib.reconcile as (args: object) => { errors: string[]; stats: Record<string, number> })({
      literals,
      writerFace,
      collectFace,
      registry,
    })
    expect(errors, '门禁等价复算出现失配').toEqual([])
    expect(stats.uniqueLiterals).toBeGreaterThanOrEqual(lanesLib.MIN_GUARDS.uniqueLiterals)
    expect(stats.writerNamespaces).toBe(lanesLib.MIN_GUARDS.writerNamespaces)
    expect(stats.collectNamespaces).toBe(lanesLib.MIN_GUARDS.collectNamespaces)
  })
})
