/**
 * DiffViewer 折叠未变区域（P-20261004-99）：自绘 diff 与编辑器 DiffEditor
 * （Monaco hideUnchangedRegions，P-20261003-40）的折叠对称。
 *
 * 折叠单位 = 「两个变更行之间」的文件空间未变区域。为什么不按「显示行 context
 * 连续段 >8」判：服务端 diff 用默认 -U3 上下文（server/git/diff.go 裸 `git diff`
 * /`diff-tree -p`），hunk 内 context 至多 ±3 行、hunk 间隙的未变行根本不进 diff
 * 文本——按显示行数判永远不触发。改用 context 行的旧侧绝对行号差还原文件空间
 * 跨度（行号是绝对文件位置，hunk 间隙天然计入），与 Monaco 的
 * minimumLineCount 语义对齐：变更之间隔得远才折叠，相邻变更的少量 context 保留。
 *
 * 区域内可折叠的显示行 = 连续 context 行 + 被罩住的 @@ hunk 头行（变更行必然
 * 切断区域，故区域内不会有 add/del）；文件头伪块与首/末变更外侧的边缘段不折叠
 * ——前者没有「hunk 间」语义，后者只剩 ±3 行，折叠得不偿失。
 */

import type { HunkGroup } from './diffWhitespace'

/** 可折叠未变区域的最小文件空间行数：跨度 > 此值才折叠（任务书阈值） */
export const FOLD_MIN_REGION_LINES = 8

/** 折叠判定所需的扁平行切片（FlatUnifiedLine 的结构子集） */
export interface FoldFlatRow {
  type: string
  oldLineNo?: number
  hunkIndex?: number
}

export interface FoldRegion {
  /** 未折叠扁平序列的闭区间 [start, end]；同时作展开态集合的稳定键
   * （内容不变时其他区域展开/收起不改变本区间在未折叠序列里的位置） */
  start: number
  end: number
  /** 展开时恢复的显示行数（context 行 + 被罩住的 @@ 头行）——占位行「展开 N 行」的 N */
  restoreCount: number
  /** 文件空间区域跨度（旧侧绝对行号 + 贴边外延），> FOLD_MIN_REGION_LINES 才产出区域 */
  regionSize: number
}

export type FoldSlot =
  | { kind: 'row'; flat: number }
  | { kind: 'fold'; region: FoldRegion; expanded: boolean }

function isChangeType(t: string | undefined): boolean {
  return t === 'add' || t === 'del'
}

/**
 * 扫描扁平序列中的可折叠区域。区域 = 显示顺序上极大的连续 context 行段（允许
 * 跨越 @@ 头行——上一 hunk 尾部 context 与下一 hunk 头部 context 属同一文件空间
 * 未变区），上界为变更行或「上一 hunk 以变更行收尾」的贴边情形。
 */
export function computeFoldRegions(flat: FoldFlatRow[], hunks: HunkGroup[]): FoldRegion[] {
  const regions: FoldRegion[] = []
  let i = 0
  while (i < flat.length) {
    if (flat[i]!.type !== 'context') {
      i++
      continue
    }
    // 向下扩到极大 context 段：@@ 头行两侧都是 context 时视为被区域罩住
    let end = i
    while (end + 1 < flat.length) {
      const t = flat[end + 1]!.type
      if (t === 'context') {
        end++
      } else if (t === 'hunk' && end + 2 < flat.length && flat[end + 2]!.type === 'context') {
        end += 2
      } else {
        break
      }
    }
    const region = tryBuildRegion(flat, hunks, i, end)
    if (region) regions.push(region)
    i = end + 1
  }
  return regions
}

/** 区间 [start, end] 是否构成可折叠的内域；是则连文件空间跨度一起产出 */
function tryBuildRegion(
  flat: FoldFlatRow[],
  hunks: HunkGroup[],
  start: number,
  end: number,
): FoldRegion | null {
  // 区域首尾必为 context 行（变更行切断区域；@@ 只在两侧都有 context 时被罩住）
  const s = flat[start]!.oldLineNo
  const e = flat[end]!.oldLineNo
  if (s === undefined || e === undefined || e < s) return null
  // 旧侧绝对行号差 = 首末 context 行之间的全部文件行（含不进 diff 文本的 hunk 间隙）
  let size = e - s + 1

  // ── 上界：变更行才算内域。@@ 收尾（区域恰起于 hunk k 首行）说明上一 hunk 没有
  // 尾部 context，其声明范围末尾即最后变更——间隙并入本区；文件头/文件起始 = 边缘
  // 段，不折叠
  const prev = start > 0 ? flat[start - 1] : undefined
  if (!prev || prev.type === 'header') return null
  if (prev.type === 'hunk') {
    const prevHunk = hunks[(prev.hunkIndex ?? 0) - 1]
    const lastType = prevHunk?.lines[prevHunk.lines.length - 1]?.type
    if (!prevHunk || !isChangeType(lastType)) return null
    // hunk k−1 声明范围覆盖到 prevEnd（含其 context），[prevEnd+1, s−1] 并入区域
    const prevEnd = prevHunk.oldStart + prevHunk.oldCount
    if (s - prevEnd > 0) size += s - prevEnd
  } else if (!isChangeType(prev.type)) {
    return null
  }

  // ── 下界：对称。@@ 开头（区域恰止于 hunk j 末行、下一 hunk 以变更行开场）时
  // 间隙并入；文件末尾 = 边缘段，不折叠
  const next = end + 1 < flat.length ? flat[end + 1] : undefined
  if (!next) return null
  if (next.type === 'hunk') {
    const nextHunk = hunks[next.hunkIndex ?? 0]
    const firstType = nextHunk?.lines[0]?.type
    if (!nextHunk || !isChangeType(firstType)) return null
    // [e+1, nextHunk.oldStart−1] 并入区域
    if (nextHunk.oldStart - e - 1 > 0) size += nextHunk.oldStart - e - 1
  } else if (!isChangeType(next.type)) {
    return null
  }

  if (size <= FOLD_MIN_REGION_LINES) return null
  return { start, end, restoreCount: end - start + 1, regionSize: size }
}

/**
 * 按区域集合把未折叠序列折成槽位序列：折叠区收成 1 个 fold 槽（展开时其后补回
 * 区间行——占位行留在区域顶部作「收起」控件，单一点击目标）。unified/并排两模式
 * 消费同一份槽位，行序恒 1:1，导航下标两模式通用。
 */
export function buildFoldSlots(total: number, regions: FoldRegion[], expanded: ReadonlySet<number>): FoldSlot[] {
  const slots: FoldSlot[] = []
  let cursor = 0
  for (const region of regions) {
    while (cursor < region.start) slots.push({ kind: 'row', flat: cursor++ })
    const isOpen = expanded.has(region.start)
    slots.push({ kind: 'fold', region, expanded: isOpen })
    if (isOpen) {
      for (let f = region.start; f <= region.end; f++) slots.push({ kind: 'row', flat: f })
    }
    cursor = region.end + 1
  }
  while (cursor < total) slots.push({ kind: 'row', flat: cursor++ })
  return slots
}
