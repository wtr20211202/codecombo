import { describe, it, expect } from 'vitest'
import { buildFoldSlots, computeFoldRegions, FOLD_MIN_REGION_LINES, type FoldFlatRow } from './diffFold'
import type { DiffLine, HunkGroup } from './diffWhitespace'

/**
 * diffFold 纯函数测试（P-20261004-99）：折叠区域判定（文件空间跨度 + 贴边外延）
 * 与槽位序列构建。flat 行直接手工构造（不经过 DiffViewer 解析器），行下标即
 * 未折叠扁平序列位置；hunks 对齐组件解析形态——下标 0 是文件头伪块（全 header
 * 行），真实 hunk 声明范围（oldStart/oldCount）仅供贴边外延取值。
 */

/** ctx 行（带旧侧绝对行号） */
function ctx(oldLineNo: number, hunkIndex = 1): FoldFlatRow {
  return { type: 'context', oldLineNo, hunkIndex }
}
function chg(type: 'add' | 'del', hunkIndex = 1): FoldFlatRow {
  return { type, hunkIndex }
}
function at(hunkIndex: number): FoldFlatRow {
  return { type: 'hunk', hunkIndex }
}
function header(): FoldFlatRow {
  return { type: 'header', hunkIndex: 0 }
}

/** 构造 hunk（oldStart 起占用 oldCount 行）；行类型序列按展示行给，供贴边判定 */
function hunk(oldStart: number, oldCount: number, lineTypes: DiffLine['type'][] = ['context']): HunkGroup {
  return {
    oldStart,
    oldCount,
    newStart: oldStart,
    newCount: oldCount,
    lines: lineTypes.map((type) => ({ type, content: '' })),
  }
}

/** 文件头伪块（解析器把 header 行归伪块 0——贴边判定依赖其末行是 header 而非变更） */
const PSEUDO = hunk(0, 0, ['header', 'header'])

describe('computeFoldRegions：文件空间未变区判定', () => {
  it('两处远隔变更：中间区域折叠，跨度含 hunk 间隙（绝对行号差），restoreCount 含被罩 @@', () => {
    // 200 行文件改第 20/60 行：ctx21..23 + @@h2 + ctx57..59 = 7 显示行，文件跨度 21..59 = 39
    const flat: FoldFlatRow[] = [
      header(), header(),
      at(1), ctx(17), ctx(18), ctx(19), chg('del'), chg('add'), ctx(21), ctx(22), ctx(23),
      at(2), ctx(57), ctx(58), ctx(59), chg('del'), chg('add'), ctx(61), ctx(62), ctx(63),
    ]
    const hunks = [PSEUDO, hunk(17, 7), hunk(57, 7)]
    const regions = computeFoldRegions(flat, hunks)
    expect(regions).toHaveLength(1)
    expect(regions[0]).toMatchObject({ start: 8, end: 14, restoreCount: 7, regionSize: 39 })
  })

  it('相邻 hunk 间隙小（跨度 ≤ 阈值）不折叠——邻近变更保留上下文', () => {
    // hunk1 17..23，hunk2 25..31：区域 21..27 = 7 行 ≤ 8
    const flat: FoldFlatRow[] = [
      at(1), ctx(17), ctx(18), ctx(19), chg('del'), chg('add'), ctx(21), ctx(22), ctx(23),
      at(2), ctx(25), ctx(26), ctx(27), chg('del'), chg('add'), ctx(29), ctx(30), ctx(31),
    ]
    const hunks = [PSEUDO, hunk(17, 7), hunk(25, 7)]
    expect(computeFoldRegions(flat, hunks)).toHaveLength(0)
  })

  it('阈值边界：跨度 9 折叠、8 不折叠（> 阈值语义）', () => {
    // 无间隙单 hunk 内双变更组：ctx 段 = 纯显示行（无 @@ 可罩、无贴边外延），跨度 = 行数
    const mk = (n: number): FoldFlatRow[] => [
      at(1), chg('del'), chg('add'),
      ...Array.from({ length: n }, (_, k) => ctx(10 + k)),
      chg('del'), chg('add'),
    ]
    const hunks = [hunk(1, 4 + FOLD_MIN_REGION_LINES + 1)]
    expect(computeFoldRegions(mk(FOLD_MIN_REGION_LINES), hunks)).toHaveLength(0) // 8 行不折叠
    expect(computeFoldRegions(mk(FOLD_MIN_REGION_LINES + 1), hunks)).toHaveLength(1) // 9 行折叠
  })

  it('首/末变更外侧边缘段不折叠（无「hunk 间」语义）', () => {
    // 单 hunk：leading ctx（上界 @@1，伪块非变更收尾）与 trailing ctx（下界文件尾）都不折叠
    const flat: FoldFlatRow[] = [
      header(), header(),
      at(1), ctx(1), ctx(2), ctx(3), chg('del'), chg('add'), ctx(5), ctx(6), ctx(7),
    ]
    const hunks = [PSEUDO, hunk(1, 7)]
    expect(computeFoldRegions(flat, hunks)).toHaveLength(0)
  })

  it('贴边外延（上侧）：上一 hunk 以变更行收尾时，其与区域间的 hunk 间隙并入跨度', () => {
    // hunk1 = [ctx17..19, del20, add20']（无尾部 ctx，声明范围 17..20），区域 = @@h2 后的
    // ctx57..59：显示跨度 3，外延 [21..56] = 36 → 39；@@h2 未被罩住（上方无 ctx）
    const flat: FoldFlatRow[] = [
      at(1), ctx(17), ctx(18), ctx(19), chg('del'), chg('add'),
      at(2), ctx(57), ctx(58), ctx(59), chg('del'), chg('add'), ctx(61), ctx(62), ctx(63),
    ]
    const hunks = [PSEUDO, hunk(17, 4, ['context', 'context', 'context', 'del', 'add']), hunk(57, 7)]
    const regions = computeFoldRegions(flat, hunks)
    expect(regions).toHaveLength(1)
    expect(regions[0]).toMatchObject({ start: 7, end: 9, restoreCount: 3, regionSize: 39 })
  })

  it('贴边外延（下侧）：下一 hunk 以变更行开场时，间隙对称并入', () => {
    // hunk2 = [del60, add60', ctx61..63]（无头部 ctx，声明范围 60..63），区域 = hunk1 尾部
    // ctx21..23：显示跨度 3，外延 [24..59] = 36 → 39
    const flat: FoldFlatRow[] = [
      at(1), ctx(17), ctx(18), ctx(19), chg('del'), chg('add'), ctx(21), ctx(22), ctx(23),
      at(2), chg('del'), chg('add'), ctx(61), ctx(62), ctx(63),
    ]
    const hunks = [PSEUDO, hunk(17, 7), hunk(60, 4, ['del', 'add', 'context', 'context', 'context'])]
    const regions = computeFoldRegions(flat, hunks)
    expect(regions).toHaveLength(1)
    expect(regions[0]).toMatchObject({ start: 6, end: 8, restoreCount: 3, regionSize: 39 })
  })

  it('ignoreWs 合并产生的全 context hunk 被区域整体罩住（@@ 计入 restoreCount，行号绝对差不受影响）', () => {
    // hunk2 行对全部合并为 context：区域跨 hunk1 尾 ctx → @@h2 → hunk2 全 ctx → @@h3 → hunk3 头 ctx
    const flat: FoldFlatRow[] = [
      at(1), chg('del'), chg('add'), ctx(21), ctx(22), ctx(23),
      at(2), ctx(40), ctx(41), ctx(42),
      at(3), ctx(60), ctx(61), ctx(62), chg('del'), chg('add'),
    ]
    const hunks = [PSEUDO, hunk(17, 7), hunk(40, 3), hunk(60, 5)]
    const regions = computeFoldRegions(flat, hunks)
    expect(regions).toHaveLength(1)
    // [ctx21..23, @@h2, ctx40..42, @@h3, ctx60..62]：11 显示行，文件跨度 21..62 = 42
    expect(regions[0]).toMatchObject({ start: 3, end: 13, restoreCount: 11, regionSize: 42 })
  })

  it('行号缺失（防御）与序列边界不产出区域', () => {
    expect(computeFoldRegions([{ type: 'context' }, chg('del'), { type: 'context' }, chg('add')], [hunk(1, 2)])).toHaveLength(0)
    expect(computeFoldRegions([ctx(1), ctx(2)], [hunk(1, 2)])).toHaveLength(0) // 文件首尾边缘
  })
})

describe('buildFoldSlots：槽位序列构建', () => {
  const region = { start: 8, end: 14, restoreCount: 7, regionSize: 39 }

  it('折叠态：区间行收成单个 fold 槽，其余行序不变', () => {
    const slots = buildFoldSlots(20, [region], new Set())
    expect(slots).toHaveLength(20 - 7 + 1)
    expect(slots[8]).toMatchObject({ kind: 'fold', expanded: false })
    expect((slots[9] as { flat: number }).flat).toBe(15)
  })

  it('展开态：fold 槽后补回区间全部行（占位行留顶部作收起控件）', () => {
    const slots = buildFoldSlots(20, [region], new Set([8]))
    expect(slots).toHaveLength(21)
    expect(slots[8]).toMatchObject({ kind: 'fold', expanded: true })
    expect((slots[9] as { flat: number }).flat).toBe(8)
    expect((slots[15] as { flat: number }).flat).toBe(14)
    expect((slots[16] as { flat: number }).flat).toBe(15)
  })

  it('多区域独立展开互不影响', () => {
    const r1 = { start: 2, end: 4, restoreCount: 3, regionSize: 20 }
    const r2 = { start: 10, end: 12, restoreCount: 3, regionSize: 20 }
    const slots = buildFoldSlots(16, [r1, r2], new Set([10]))
    const folds = slots.filter((s) => s.kind === 'fold')
    expect(folds).toHaveLength(2)
    expect(folds[0]).toMatchObject({ kind: 'fold', expanded: false })
    expect(folds[1]).toMatchObject({ kind: 'fold', expanded: true })
    // r1 折叠（3 行收 1 槽）+ r2 展开（1 槽 + 3 行）：16 − 3 + 1 − 3 + 1 + 3 = 15
    expect(slots).toHaveLength(15)
    const fold1 = slots.findIndex((s) => s.kind === 'fold')
    expect(slots[fold1 + 1]).toMatchObject({ kind: 'row', flat: 5 })
  })
})
